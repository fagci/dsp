package app.dsp.phone

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Модели на телефоне: whisper.cpp (речь → текст) с GPU через OpenCL там, где он есть, иначе CPU с dotprod.
 * Команды: ai.caps (что умеет телефон), model.list / model.get / model.cancel / model.delete (файлы моделей в каталоге приложения, докачка),
 * asr.load / asr.run / asr.stop / asr.unload. Записи {src:'ai', ev:'progress'|'seg', …} — подписка sub:['ai'].
 * Звук идёт в asr.run строкой base64: 16 кГц, 16 бит, little-endian (до 10 минут); сегменты текста приходят записями по мере готовности, итог — в ответе.
 */
class AiHub(private val ctx: Context, private val emit: Emit,
            private val store: ModelStore = ModelStore(File(ctx.filesDir, "models")),
            make: () -> AsrEngine = { WhisperEngine() }) {
    private val core = AsrCore(store, make)
    private val asr = Executors.newSingleThreadExecutor()
    private val dl = Executors.newFixedThreadPool(2)
    private val downloads = ConcurrentHashMap<String, AtomicBoolean>()
    private val cpu by lazy {
        AiArgs.cpu(try { File("/proc/cpuinfo").readText() } catch (e: Exception) { "" }, Runtime.getRuntime().availableProcessors())
    }
    private val arm64 get() = Build.SUPPORTED_64_BIT_ABIS.contains("arm64-v8a")
    private val openCl get() = AiArgs.OPENCL_PATHS.any { File(it).exists() }

    private fun mem(): ActivityManager.MemoryInfo = ActivityManager.MemoryInfo().also { (ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(it) }
    private fun b(v: Boolean) = if (v) "true" else "false"

    private fun rec(vararg kv: Pair<String, String?>) = emit("ai", Json.obj("src" to "\"ai\"", "t" to System.currentTimeMillis().toString(), *kv))

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        try {
            when (cmd) {
                "ai.caps" -> {
                    val m = mem()
                    val soc = if (Build.VERSION.SDK_INT >= 31) "${Build.SOC_MANUFACTURER} ${Build.SOC_MODEL}".trim() else Build.HARDWARE
                    Reply.done(c, id, cmd, null, "error",
                        "arm64" to b(arm64), "cores" to cpu.cores.toString(), "dotprod" to b(cpu.dotprod), "i8mm" to b(cpu.i8mm), "fp16" to b(cpu.fp16),
                        "ramMb" to (m.totalMem shr 20).toString(), "availMb" to (m.availMem shr 20).toString(), "opencl" to b(openCl), "soc" to Json.str(soc),
                        "cpuLib" to Json.str(AiArgs.lib(cpu, arm64, openCl, false) ?: ""), "gpuLib" to Json.str(AiArgs.lib(cpu, arm64, openCl, true) ?: ""),
                        "loadedLib" to Json.str(WhisperNative.lib ?: ""), "model" to Json.str(core.model), "gpu" to b(core.gpu),
                        "freeMb" to (store.dir.usableSpace shr 20).toString(), "dir" to Json.str(store.dir.absolutePath))
                }
                "model.list" -> Reply.done(c, id, cmd, null, "error",
                    "models" to Json.rows(store.list().map { Json.obj("name" to Json.str(it.name), "size" to it.size.toString(), "partial" to b(it.partial)) }),
                    "freeMb" to (store.dir.usableSpace shr 20).toString())
                "model.get" -> {
                    val name = AiArgs.modelName(j.optString("name")) ?: return Reply.done(c, id, cmd, "name: letters, digits and «._-», extension .bin / .gguf / .tflite / .onnx")
                    val url = AiArgs.url(j.optString("url")) ?: return Reply.done(c, id, cmd, "url: http:// or https:// address expected")
                    val flag = AtomicBoolean(false)
                    if (downloads.putIfAbsent(name, flag) != null) return Reply.done(c, id, cmd, "$name is already downloading")
                    dl.execute {
                        try {
                            val err = store.download(url, name, j.optString("sha256").ifEmpty { null }, flag) { d, t ->
                                rec("ev" to "\"progress\"", "name" to Json.str(name), "done" to d.toString(), "total" to t.toString())
                            }
                            Reply.done(c, id, cmd, err, if (err == "cancelled") "cancelled" else "error", "name" to Json.str(name), "size" to (store.file(name)?.length() ?: 0L).toString())
                        } finally { downloads.remove(name) }
                    }
                }
                "model.cancel" -> { downloads[AiArgs.modelName(j.optString("name")) ?: ""]?.set(true); Reply.done(c, id, cmd, null) }
                "model.delete" -> {
                    val name = AiArgs.modelName(j.optString("name")) ?: return Reply.done(c, id, cmd, "name")
                    if (core.model == name) core.unload()
                    Reply.done(c, id, cmd, if (store.delete(name)) null else "cannot delete $name")
                }
                "asr.load" -> asr.execute {
                    val name = j.optString("model"); val want = j.optBoolean("gpu", true)
                    val size = store.file(name)?.length() ?: 0L
                    val m = mem()
                    if (size > 0 && !core.loaded && m.availMem < size * 12 / 10) return@execute Reply.done(c, id, cmd, "not enough memory: the model needs about ${size * 12 / 10 shr 20} MB free, ${m.availMem shr 20} MB available — close other apps or take a smaller model")
                    val r = core.load(name, want, j.optBoolean("flash", false))
                    Reply.done(c, id, cmd, r.err, "error", "backends" to Json.str(r.backends), "ms" to r.ms.toString(), "model" to Json.str(core.model), "gpu" to b(core.gpu && r.backends.contains("GPU:")),
                        "system" to Json.str(if (r.ok) WhisperNative.lib ?: "" else ""))
                }
                "asr.run" -> {
                    val pcm = AiArgs.pcm(j.optString("pcm"), AiArgs.MAX_SAMPLES) ?: return Reply.done(c, id, cmd, "pcm: base64 of 16 kHz 16-bit mono little-endian, up to 10 minutes")
                    val o = AsrOpts(lang = AiArgs.lang(j.optString("lang")), translate = j.optBoolean("translate"), threads = j.optInt("threads", 0).takeIf { it > 0 } ?: (cpu.cores / 2).coerceIn(2, 6),
                        prompt = j.optString("prompt").take(400), beam = j.optInt("beam", 1).coerceIn(1, 8), temperature = j.optDouble("temperature", 0.0).toFloat().coerceIn(0f, 1f),
                        noContext = !j.optBoolean("context"), fast = j.optBoolean("fast"), suppressNst = j.optBoolean("suppressNst", true))
                    asr.execute {
                        val r = core.run(pcm, o) { s ->
                            rec("ev" to "\"seg\"", "rid" to (if (id is Number) id.toString() else Json.str(id?.toString())), "t0" to s.t0.toString(), "t1" to s.t1.toString(),
                                "text" to Json.str(s.text), "ns" to Json.num(s.noSpeech.toDouble(), 100.0))
                        }
                        Reply.done(c, id, cmd, r.err, "error", "text" to Json.str(r.text), "segs" to r.segs.toString(), "ms" to r.ms.toString(), "audioMs" to r.audioMs.toString())
                    }
                }
                "asr.stop" -> { core.abort(); Reply.done(c, id, cmd, null) }
                "asr.unload" -> asr.execute { core.unload(); Reply.done(c, id, cmd, null) }
                else -> Reply.done(c, id, cmd, "unknown command")
            }
        } catch (e: Throwable) {
            Reply.done(c, id, cmd, e.message ?: e.javaClass.simpleName)
        }
    }

    fun stop() { core.abort(); downloads.values.forEach { it.set(true) }; asr.shutdown(); dl.shutdown() }
}
