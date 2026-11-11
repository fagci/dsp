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
    fun lib(cpu: Cpu, arm64: Boolean, openclPresent: Boolean, gpu: Boolean, base: String = "dsp_whisper"): String? = when {
        !arm64 || !cpu.dotprod || !cpu.fp16 -> null
        gpu && openclPresent -> base + "_cl"
        else -> base
    }

    /** Файл приложения для model.get {asset}: только из vendor/ (там лежат модели в репозитории), без «..» и странных символов. */
    fun asset(s: String?): String? = s?.trim()?.takeIf { Regex("vendor/[A-Za-z0-9._/\\-]{1,180}").matches(it) && !it.contains("..") && !it.contains("//") }

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

    /** Файл из потока (например из assets приложения): null — готово, иначе ошибка. Уже лежащий не трогается. */
    fun put(name: String, input: java.io.InputStream, maxBytes: Long = 64L shl 20): String? {
        val n = AiArgs.modelName(name) ?: return "name: letters, digits and «._-», extension .bin / .gguf / .tflite / .onnx"
        val dst = File(dir, n); if (dst.isFile) return null
        val tmp = File(dir, "$n.part")
        return try {
            var total = 0L
            input.use { i -> FileOutputStream(tmp).use { o -> val b = ByteArray(1 shl 16); while (true) { val r = i.read(b); if (r < 0) break; total += r; if (total > maxBytes) { tmp.delete(); return "file is larger than ${maxBytes shr 20} MB" }; o.write(b, 0, r) } } }
            if (tmp.renameTo(dst)) null else "cannot save the file"
        } catch (e: Exception) { tmp.delete(); "${e.javaClass.simpleName}: ${e.message}" }
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

/* ---------- языковые модели (llama.cpp) ---------- */

class ChatMsg(val role: String, val content: String)
class LlmOpts(val max: Int = 512, val temp: Float = 0.7f, val topK: Int = 40, val topP: Float = 0.95f, val minP: Float = 0.05f, val repeat: Float = 1.1f, val seed: Int = 0)

/** Разбор сообщений чата (чистая логика). */
object LlmArgs {
    private val ROLES = setOf("system", "user", "assistant")
    const val MAX_MSGS = 200
    const val MAX_CHARS = 400_000

    /** [{role, content}] → список; null — не тот формат, чужая роль, пусто, слишком много. */
    fun messages(a: org.json.JSONArray?): List<ChatMsg>? {
        if (a == null || a.length() == 0 || a.length() > MAX_MSGS) return null
        val out = ArrayList<ChatMsg>(); var chars = 0
        for (i in 0 until a.length()) {
            val o = a.optJSONObject(i) ?: return null
            val role = o.optString("role"); val c = o.optString("content")
            if (role !in ROLES) return null
            chars += c.length; if (chars > MAX_CHARS) return null
            out.add(ChatMsg(role, c))
        }
        if (out.none { it.role == "user" }) return null
        return out
    }

    /** Если у модели нет своего шаблона — ChatML (Qwen, многие дообученные модели его понимают). */
    fun chatMl(m: List<ChatMsg>): ByteArray {
        val sb = StringBuilder()
        for (x in m) sb.append("<|im_start|>").append(x.role).append('\n').append(x.content).append("<|im_end|>\n")
        sb.append("<|im_start|>assistant\n")
        return sb.toString().toByteArray(Charsets.UTF_8)
    }

    /** Лишнее из истории: пока запрос не влезает (tokens(запрос) > limit), выбрасываем самое старое не-системное сообщение; всегда остаётся последнее. Возвращает (сообщения, сколько выброшено). */
    fun fit(msgs: List<ChatMsg>, count: (List<ChatMsg>) -> Int, limit: Int): Pair<List<ChatMsg>, Int> {
        var cur = msgs; var dropped = 0
        while (count(cur) > limit) {
            val i = cur.indexOfFirst { it.role != "system" }
            if (i < 0 || i >= cur.size - 1) break                       // осталось одно сообщение — резать нечего
            cur = cur.filterIndexed { k, _ -> k != i }; dropped++
        }
        return cur to dropped
    }

    fun opts(max: Int, temp: Double, topK: Int, topP: Double, minP: Double, repeat: Double, seed: Int) =
        LlmOpts(max.coerceIn(1, 8192), temp.toFloat().coerceIn(0f, 2f), topK.coerceIn(0, 200), topP.toFloat().coerceIn(0.05f, 1f), minP.toFloat().coerceIn(0f, 1f), repeat.toFloat().coerceIn(1f, 2f), seed.coerceAtLeast(0))
}

interface LlmEngine {
    fun load(path: String, ctx: Int, gpuLayers: Int, threads: Int, flash: Boolean, mmap: Boolean): String?     // null — готово
    fun info(): String                                                  // «описание|байты|обучающий контекст|контекст»
    fun backends(): String
    fun format(m: List<ChatMsg>): ByteArray?                            // шаблон модели; null — у модели его нет
    fun countTokens(prompt: ByteArray): Int
    fun generate(prompt: ByteArray, o: LlmOpts, onToken: (String) -> Boolean): String?                         // null — готово, иначе ошибка
    fun perf(): DoubleArray                                             // {мс запроса, токенов запроса, мс генерации, токенов}
    fun cancel()
    fun free()
}

/** Одна загруженная языковая модель; запросы по одному. Чистая обвязка — проверяется на JVM с подставным движком. */
class LlmCore(private val store: ModelStore, private val make: () -> LlmEngine) {
    private var eng: LlmEngine? = null
    var model = ""; private set
    var gpu = false; private set
    var ctx = 0; private set
    private val lock = Any()

    class Loaded(val ok: Boolean, val err: String?, val info: String, val backends: String, val ms: Long)
    class Done(val err: String?, val text: String, val tokens: Int, val promptTokens: Int, val ms: Long, val tps: Double, val ptps: Double, val trimmed: Int)

    fun load(name: String, wantGpu: Boolean, nCtx: Int, threads: Int, flash: Boolean, mmap: Boolean): Loaded = synchronized(lock) {
        val f = store.file(name)?.takeIf { it.name.endsWith(".gguf", true) } ?: return Loaded(false, "no model «$name» (.gguf) — download it first (model.get)", "", "", 0)
        if (eng != null && model == name && gpu == wantGpu && ctx == nCtx) return Loaded(true, null, eng!!.info(), eng!!.backends(), 0)
        eng?.free(); eng = null; model = ""
        val t = System.currentTimeMillis()
        val e = make()
        val err = e.load(f.absolutePath, nCtx, if (wantGpu) -1 else 0, threads, flash, mmap)
        if (err != null) { e.free(); return Loaded(false, err, "", "", 0) }
        eng = e; model = name; gpu = wantGpu; ctx = nCtx
        Loaded(true, null, e.info(), e.backends(), System.currentTimeMillis() - t)
    }

    fun chat(msgs: List<ChatMsg>, o: LlmOpts, onToken: (String) -> Boolean): Done {
        val e = synchronized(lock) { eng } ?: return Done("no model loaded (llm.load)", "", 0, 0, 0, 0.0, 0.0, 0)
        return synchronized(e) {
            val t = System.currentTimeMillis()
            val fmt = { m: List<ChatMsg> -> e.format(m) ?: LlmArgs.chatMl(m) }
            val room = (ctx - o.max.coerceAtMost(ctx / 2) - 8).coerceAtLeast(64)
            val (fit, dropped) = LlmArgs.fit(msgs, { e.countTokens(fmt(it)) }, room)
            val prompt = fmt(fit)
            val sb = StringBuilder()
            val err = e.generate(prompt, o) { s -> sb.append(s); onToken(s) }
            val p = e.perf()
            val tps = if (p[2] > 0) p[3] * 1000.0 / p[2] else 0.0
            val ptps = if (p[0] > 0) p[1] * 1000.0 / p[0] else 0.0
            Done(err, sb.toString(), p[3].toInt(), p[1].toInt(), System.currentTimeMillis() - t, tps, ptps, dropped)
        }
    }

    fun cancel() { synchronized(lock) { eng }?.cancel() }
    fun unload() { synchronized(lock) { eng?.free(); eng = null; model = "" } }
    val loaded get() = synchronized(lock) { eng != null }
}

/* ---------- нейросети TFLite (GPU-делегат): Basic Pitch, YAMNet и другие модели float32 ---------- */

class NnTensor(val name: String, val shape: IntArray, val type: String) {
    val count: Int get() = shape.fold(1) { a, b -> a * b }
}
class NnInfo(val inputs: List<NnTensor>, val outputs: List<NnTensor>, val delegate: String, val note: String = "")

/** Разбор тензоров команд nn.* (чистая логика): float32, little-endian, base64. */
object NnArgs {
    const val MAX_FLOATS = 16_000_000                                   // 64 МБ на тензор

    /** null — не base64 или не ровно expect значений. */
    fun floats(b64: String?, expect: Int): FloatArray? {
        if (b64.isNullOrEmpty() || expect <= 0 || expect > MAX_FLOATS) return null
        val b = try { Base64.getDecoder().decode(b64) } catch (e: IllegalArgumentException) { return null }
        if (b.size != expect * 4) return null
        return FloatArray(expect) { java.lang.Float.intBitsToFloat((b[4 * it].toInt() and 255) or ((b[4 * it + 1].toInt() and 255) shl 8) or ((b[4 * it + 2].toInt() and 255) shl 16) or ((b[4 * it + 3].toInt() and 255) shl 24)) }
    }

    fun b64(a: FloatArray): String {
        val b = ByteArray(a.size * 4)
        for (i in a.indices) { val v = java.lang.Float.floatToRawIntBits(a[i]); b[4 * i] = v.toByte(); b[4 * i + 1] = (v shr 8).toByte(); b[4 * i + 2] = (v shr 16).toByte(); b[4 * i + 3] = (v shr 24).toByte() }
        return Base64.getEncoder().encodeToString(b)
    }
}

/** Движок одной модели. load бросает исключение с понятным текстом; run — по тензору на вход и на выход (float32). */
interface NnEngine {
    fun load(path: String, gpu: Boolean, threads: Int): NnInfo
    fun run(inputs: List<FloatArray>): List<FloatArray>
    fun free()
}

/** Несколько загруженных моделей (до MAX), запуск по имени. Чистая обвязка — проверяется на JVM с подставным движком. */
class NnCore(private val store: ModelStore, private val make: () -> NnEngine) {
    private class Model(val eng: NnEngine, val info: NnInfo, val gpu: Boolean)
    private val models = LinkedHashMap<String, Model>()
    private val lock = Any()

    class Loaded(val ok: Boolean, val err: String?, val info: NnInfo?, val ms: Long)
    class Ran(val err: String?, val outputs: List<FloatArray>, val info: NnInfo?, val ms: Long)

    fun load(name: String, gpu: Boolean, threads: Int): Loaded {
        synchronized(lock) {
            val f = store.file(name)?.takeIf { it.name.endsWith(".tflite", true) } ?: return Loaded(false, "no model «$name» (.tflite) — put it on the phone first (model.get)", null, 0)
            models[name]?.let { if (it.gpu == gpu) return Loaded(true, null, it.info, 0) else { it.eng.free(); models.remove(name) } }
            while (models.size >= MAX) { val k = models.keys.first(); models.remove(k)?.eng?.free() }          // самую давнюю выгружаем
            val t = System.currentTimeMillis()
            val e = make()
            return try {
                val info = e.load(f.absolutePath, gpu, threads)
                models[name] = Model(e, info, gpu)
                Loaded(true, null, info, System.currentTimeMillis() - t)
            } catch (x: Throwable) { try { e.free() } catch (y: Throwable) {}; Loaded(false, x.message ?: x.javaClass.simpleName, null, 0) }
        }
    }

    fun run(name: String, inputs: List<FloatArray>): Ran {
        val m = synchronized(lock) { models[name] } ?: return Ran("model «$name» is not loaded (nn.load)", emptyList(), null, 0)
        if (inputs.size != m.info.inputs.size) return Ran("the model takes ${m.info.inputs.size} input(s), ${inputs.size} given", emptyList(), m.info, 0)
        for ((i, t) in m.info.inputs.withIndex()) if (inputs[i].size != t.count) return Ran("input ${i + 1} (${t.name}) must have ${t.count} values (${t.shape.joinToString("×")}), ${inputs[i].size} given", emptyList(), m.info, 0)
        val t = System.currentTimeMillis()
        return try { Ran(null, m.eng.run(inputs), m.info, System.currentTimeMillis() - t) } catch (x: Throwable) { Ran(x.message ?: x.javaClass.simpleName, emptyList(), m.info, 0) }
    }

    fun info(name: String): NnInfo? = synchronized(lock) { models[name]?.info }
    fun names(): List<String> = synchronized(lock) { models.keys.toList() }
    fun unload(name: String) { synchronized(lock) { models.remove(name)?.eng?.free() } }
    fun unloadAll() { synchronized(lock) { models.values.forEach { it.eng.free() }; models.clear() } }

    companion object { const val MAX = 4 }
}
