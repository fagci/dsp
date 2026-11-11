package app.dsp.phone

import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean

/** Разбор аргументов команд ai.* / model.* / asr.* (чистая логика — проверяется на JVM). */
object AiArgs {
    private val NAME = Regex("[A-Za-z0-9][A-Za-z0-9._\\-]{0,99}")
    private val EXT = setOf("bin", "gguf", "tflite", "onnx")

    /** Имя файла модели в каталоге приложения: без путей и «..», расширение из списка. */
    fun modelName(s: String?): String? = s?.trim()?.takeIf { NAME.matches(it) && !it.contains("..") && it.substringAfterLast('.', "").lowercase() in EXT }

    fun url(s: String?): String? = s?.trim()?.takeIf { Regex("https?://[^\\s/]+(/\\S*)?", RegexOption.IGNORE_CASE).matches(it) }

    fun lang(s: String?): String = s?.trim()?.lowercase()?.takeIf { it == "auto" || Regex("[a-z]{2,3}").matches(it) } ?: "auto"

    /** 16 кГц, 16 бит, little-endian, base64 → float [-1, 1]. null — не base64 или длиннее maxSamples. Короче 1,1 с дополняется тишиной (whisper.cpp не берёт меньше секунды). */
    fun pcm(b64: String?, maxSamples: Int): FloatArray? {
        if (b64.isNullOrEmpty()) return null
        val b = try { Base64.getDecoder().decode(b64) } catch (e: IllegalArgumentException) { return null }
        val n = b.size / 2
        if (n == 0 || n > maxSamples) return null
        val out = FloatArray(maxOf(n, MIN_SAMPLES))
        for (i in 0 until n) out[i] = ((b[2 * i].toInt() and 255) or (b[2 * i + 1].toInt() shl 8)).toShort() / 32768f
        return out
    }
    const val MIN_SAMPLES = 17_600
    const val MAX_SAMPLES = 16_000 * 600          // десять минут за один вызов

    /** Поле «Features» из /proc/cpuinfo → что умеет процессор. */
    class Cpu(val dotprod: Boolean, val i8mm: Boolean, val fp16: Boolean, val cores: Int)
    fun cpu(cpuinfo: String, cores: Int): Cpu {
        val f = cpuinfo.lineSequence().filter { it.startsWith("Features") }.flatMap { it.substringAfter(':').trim().split(Regex("\\s+")).asSequence() }.toSet()
        return Cpu("asimddp" in f, "i8mm" in f, "asimdhp" in f || "fphp" in f, cores)
    }

    /** Какую библиотеку грузить: null — арм64 без dotprod (или не ARM), нативный слой не включается. */
    fun lib(cpu: Cpu, arm64: Boolean, openclPresent: Boolean, gpu: Boolean): String? = when {
        !arm64 || !cpu.dotprod || !cpu.fp16 -> null
        gpu && openclPresent -> "dsp_whisper_cl"
        else -> "dsp_whisper"
    }

    val OPENCL_PATHS = listOf("/vendor/lib64/libOpenCL.so", "/system/vendor/lib64/libOpenCL.so", "/system/lib64/libOpenCL.so", "/vendor/lib64/egl/libOpenCL.so")
}

/** Каталог моделей приложения: список, удаление и докачиваемая загрузка (Range). */
class ModelStore(val dir: File) {
    class Item(val name: String, val size: Long, val partial: Boolean)

    init { dir.mkdirs() }

    fun list(): List<Item> = (dir.listFiles() ?: emptyArray()).filter { it.isFile }.mapNotNull {
        val partial = it.name.endsWith(".part")
        val nm = if (partial) it.name.removeSuffix(".part") else it.name
        if (AiArgs.modelName(nm) == null) null else Item(nm, it.length(), partial)
    }.sortedBy { it.name }

    fun file(name: String): File? = AiArgs.modelName(name)?.let { File(dir, it) }?.takeIf { it.isFile }

    fun delete(name: String): Boolean {
        val n = AiArgs.modelName(name) ?: return false
        val a = File(dir, n).let { !it.exists() || it.delete() }
        val b = File(dir, "$n.part").let { !it.exists() || it.delete() }
        return a && b
    }

    /** null — готово (файл лежит целиком), иначе текст ошибки. Прерванная загрузка продолжается с того же места. */
    fun download(url: String, name: String, sha256: String?, cancel: AtomicBoolean, progress: (done: Long, total: Long) -> Unit): String? {
        val n = AiArgs.modelName(name) ?: return "name: letters, digits and «._-», extension .bin / .gguf / .tflite / .onnx"
        val u = AiArgs.url(url) ?: return "url: http:// or https:// address expected"
        val dst = File(dir, n); val part = File(dir, "$n.part")
        if (dst.isFile) return null
        var have = if (part.isFile) part.length() else 0L
        var c: HttpURLConnection? = null
        try {
            c = URL(u).openConnection() as HttpURLConnection
            c.connectTimeout = 15_000; c.readTimeout = 30_000; c.instanceFollowRedirects = true
            c.setRequestProperty("User-Agent", "DSP-workbench")
            if (have > 0) c.setRequestProperty("Range", "bytes=$have-")
            val code = c.responseCode
            if (code == 416 && have > 0) { part.renameTo(dst); return null }            // докачивать нечего: файл уже целый
            if (code != 200 && code != 206) return "HTTP $code"
            val append = code == 206 && have > 0
            if (!append) have = 0
            val total = if (append) c.getHeaderField("Content-Range")?.substringAfter('/')?.toLongOrNull() ?: (have + c.contentLengthLong) else c.contentLengthLong
            if (total > 0 && dir.usableSpace < total - have + (50L shl 20)) return "not enough space: ${(total - have) shr 20} MB needed, ${dir.usableSpace shr 20} MB free"
            val md = sha256?.let { MessageDigest.getInstance("SHA-256") }
            if (md != null && append) part.inputStream().use { i -> val b = ByteArray(1 shl 16); while (true) { val r = i.read(b); if (r < 0) break; md.update(b, 0, r) } }
            var done = have; var last = 0L
            c.inputStream.use { inp -> FileOutputStream(part, append).use { out ->
                val b = ByteArray(1 shl 16)
                while (true) {
                    if (cancel.get()) return "cancelled"
                    val r = inp.read(b); if (r < 0) break
                    out.write(b, 0, r); md?.update(b, 0, r); done += r
                    val now = System.nanoTime(); if (now - last > 250_000_000L) { last = now; progress(done, total) }
                }
            } }
            progress(done, total)
            if (total > 0 && done != total) return "incomplete: $done of $total bytes (repeat — the download continues)"
            if (md != null) { val h = md.digest().joinToString("") { "%02x".format(it) }; if (!h.equals(sha256, true)) { part.delete(); return "checksum mismatch" } }
            if (!part.renameTo(dst)) return "cannot save the file"
            return null
        } catch (e: Exception) {
            return "${e.javaClass.simpleName}: ${e.message}"
        } finally { c?.disconnect() }
    }
}

/** Что нужно от движка распознавания; настоящий — WhisperEngine (whisper.cpp), на JVM — подставной. */
class AsrSeg(val t0: Long, val t1: Long, val text: String, val noSpeech: Float)
class AsrOpts(val lang: String = "auto", val translate: Boolean = false, val threads: Int = 4, val prompt: String = "", val beam: Int = 1,
              val temperature: Float = 0f, val noContext: Boolean = true, val fast: Boolean = false, val suppressNst: Boolean = true)
interface AsrEngine {
    fun load(path: String, gpu: Boolean, flash: Boolean): String?          // null — готово, иначе ошибка
    fun backends(): String                                                 // «CPU:CPU|…;GPU:OpenCL|…»
    fun system(): String
    fun run(pcm: FloatArray, o: AsrOpts, sink: (AsrSeg) -> Unit): String?  // null — готово, иначе ошибка
    fun abort()
    fun free()
}

/** Одна загруженная модель, распознавание по одному (whisper_full не потокобезопасен). Чистая обвязка — проверяется на JVM с подставным движком. */
class AsrCore(private val store: ModelStore, private val make: () -> AsrEngine) {
    private var eng: AsrEngine? = null
    var model = ""; private set
    var gpu = false; private set
    private val lock = Any()

    class Loaded(val ok: Boolean, val err: String?, val backends: String, val ms: Long)
    class Ran(val err: String?, val text: String, val segs: Int, val ms: Long, val audioMs: Long)

    fun load(name: String, wantGpu: Boolean, flash: Boolean): Loaded = synchronized(lock) {
        val f = store.file(name) ?: return Loaded(false, "no model «$name» — download it first (model.get)", "", 0)
        if (eng != null && model == name && gpu == wantGpu) return Loaded(true, null, eng!!.backends(), 0)
        eng?.free(); eng = null; model = ""
        val t = System.currentTimeMillis()
        val e = make()
        val err = e.load(f.absolutePath, wantGpu, flash)
        if (err != null) { e.free(); return Loaded(false, err, "", 0) }
        eng = e; model = name; gpu = wantGpu
        Loaded(true, null, e.backends(), System.currentTimeMillis() - t)
    }

    fun run(pcm: FloatArray, o: AsrOpts, sink: (AsrSeg) -> Unit): Ran {
        val e = synchronized(lock) { eng } ?: return Ran("no model loaded (asr.load)", "", 0, 0, 0)
        val t = System.currentTimeMillis(); val parts = ArrayList<String>()
        val err = synchronized(e) { e.run(pcm, o) { s -> if (s.text.isNotBlank()) parts.add(s.text.trim()); sink(s) } }
        return Ran(err, parts.joinToString(" "), parts.size, System.currentTimeMillis() - t, pcm.size * 1000L / 16000)
    }

    fun abort() { synchronized(lock) { eng }?.abort() }
    fun unload() { synchronized(lock) { eng?.free(); eng = null; model = "" } }
    val loaded get() = synchronized(lock) { eng != null }
}
