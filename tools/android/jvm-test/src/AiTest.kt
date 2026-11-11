package app.dsp.phone.aitest

import app.dsp.phone.AiArgs
import app.dsp.phone.AsrCore
import app.dsp.phone.AsrEngine
import app.dsp.phone.AsrOpts
import app.dsp.phone.AsrSeg
import app.dsp.phone.BridgeServer
import app.dsp.phone.ModelStore
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.nio.file.Files
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean

var bad = 0
fun ok(name: String, cond: Boolean, extra: String = "") { if (!cond) { bad++; println("FAIL $name $extra") } else println("ok   $name") }

/** Подставной движок: считает вызовы, отдаёт сегменты, умеет «долго думать» и ошибаться. */
class FakeEngine : AsrEngine {
    var loaded: String? = null; var gpuWanted = false; var freed = 0; var runs = 0; var lastPcm = 0; var lastOpts: AsrOpts? = null
    @Volatile var stop = false
    var failLoad: String? = null; var slowMs = 0L
    override fun load(path: String, gpu: Boolean, flash: Boolean): String? { if (failLoad != null) return failLoad; loaded = path; gpuWanted = gpu; return null }
    override fun backends() = "CPU:CPU|cpu" + (if (gpuWanted) ";GPU:OpenCL|Adreno" else "")
    override fun system() = "fake"
    override fun run(pcm: FloatArray, o: AsrOpts, sink: (AsrSeg) -> Unit): String? {
        runs++; lastPcm = pcm.size; lastOpts = o; stop = false
        var waited = 0L
        while (waited < slowMs) { if (stop) return "stopped"; Thread.sleep(10); waited += 10 }
        sink(AsrSeg(0, 150, " Привет, мир.", 0.01f)); sink(AsrSeg(150, 300, " Как дела?", 0.02f)); sink(AsrSeg(300, 320, "  ", 0.9f))
        return null
    }
    override fun abort() { stop = true }
    override fun free() { freed++; loaded = null }
}

fun pcmB64(samples: Int, f: (Int) -> Int = { 0 }): String {
    val b = ByteArray(samples * 2)
    for (i in 0 until samples) { val v = f(i); b[2 * i] = v.toByte(); b[2 * i + 1] = (v shr 8).toByte() }
    return Base64.getEncoder().encodeToString(b)
}

fun main() {
    // --- аргументы
    ok("model name: ordinary", AiArgs.modelName("ggml-large-v3-turbo-q5_0.bin") == "ggml-large-v3-turbo-q5_0.bin" && AiArgs.modelName("m.gguf") == "m.gguf" && AiArgs.modelName(" a.tflite ") == "a.tflite")
    ok("model name: paths, traversal and odd extensions refused", AiArgs.modelName("../x.bin") == null && AiArgs.modelName("a/b.bin") == null && AiArgs.modelName("a..b.bin") == null && AiArgs.modelName("x.sh") == null && AiArgs.modelName("x") == null && AiArgs.modelName("") == null && AiArgs.modelName(null) == null && AiArgs.modelName(".bin") == null && AiArgs.modelName("a b.bin") == null)
    ok("model name: length", AiArgs.modelName("a".repeat(100) + ".bin") == null && AiArgs.modelName("a".repeat(90) + ".bin") != null)
    ok("url: http and https only", AiArgs.url("https://huggingface.co/x/y.bin") != null && AiArgs.url("http://192.168.1.5:8080/m.bin") != null && AiArgs.url("file:///etc/passwd") == null && AiArgs.url("ftp://h/x") == null && AiArgs.url("https://a b") == null && AiArgs.url("") == null)
    ok("lang", AiArgs.lang("ru") == "ru" && AiArgs.lang(" RU ") == "ru" && AiArgs.lang("auto") == "auto" && AiArgs.lang("") == "auto" && AiArgs.lang("x;y") == "auto" && AiArgs.lang(null) == "auto" && AiArgs.lang("english") == "auto")
    val p = AiArgs.pcm(pcmB64(32000) { if (it == 1) 16384 else if (it == 2) -16384 else if (it == 3) 32767 else 0 }, AiArgs.MAX_SAMPLES)!!
    ok("pcm: s16le → float", p.size == 32000 && p[1] == 0.5f && p[2] == -0.5f && p[3] > 0.999f && p[0] == 0f)
    ok("pcm: short audio padded with silence to 1.1 s", AiArgs.pcm(pcmB64(1600), AiArgs.MAX_SAMPLES)!!.size == AiArgs.MIN_SAMPLES)
    ok("pcm: junk, empty, too long refused", AiArgs.pcm("!!!", 99999) == null && AiArgs.pcm("", 99999) == null && AiArgs.pcm(null, 99999) == null && AiArgs.pcm(pcmB64(100), 50) == null)
    val info = "Processor\t: AArch64\nprocessor\t: 0\nFeatures\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm lrcpc dcpop asimddp\nprocessor\t: 1\nFeatures\t: fp asimd fphp asimdhp asimddp i8mm\n"
    val cpu = AiArgs.cpu(info, 8)
    ok("cpu features from /proc/cpuinfo", cpu.dotprod && cpu.fp16 && cpu.i8mm && cpu.cores == 8)
    val old = AiArgs.cpu("Features\t: fp asimd evtstrm aes crc32\n", 4)
    ok("cpu: an old phone has no dotprod", !old.dotprod && !old.fp16 && !old.i8mm)
    ok("lib choice: GPU build only with OpenCL and when GPU is asked", AiArgs.lib(cpu, true, true, true) == "dsp_whisper_cl" && AiArgs.lib(cpu, true, false, true) == "dsp_whisper" && AiArgs.lib(cpu, true, true, false) == "dsp_whisper")
    ok("lib choice: no dotprod or not arm64 → no native engine", AiArgs.lib(old, true, true, true) == null && AiArgs.lib(cpu, false, true, true) == null)
    ok("commands need the app page", BridgeServer.powerCmd("ai.caps") && BridgeServer.powerCmd("model.get") && BridgeServer.powerCmd("asr.run") && BridgeServer.powerCmd("model.delete"))

    // --- каталог моделей и загрузка с докачкой
    val dir = Files.createTempDirectory("models").toFile()
    val store = ModelStore(File(dir, "m"))
    val body = ByteArray(300_000) { (it * 7 % 251).toByte() }
    val sha = MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it) }
    var hits = 0; val ranges = ArrayList<String?>(); var ignoreRange = false; var cut = -1
    val srv = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    srv.createContext("/m.bin") { x ->
        hits++; val r = x.requestHeaders.getFirst("Range"); ranges.add(r)
        if (r != null && !ignoreRange) {
            val from = r.removePrefix("bytes=").removeSuffix("-").toInt()
            if (from >= body.size) { x.sendResponseHeaders(416, -1); x.close(); return@createContext }
            x.responseHeaders.add("Content-Range", "bytes $from-${body.size - 1}/${body.size}")
            x.sendResponseHeaders(206, (body.size - from).toLong()); x.responseBody.write(body, from, body.size - from)
        } else if (cut > 0) {
            x.sendResponseHeaders(200, body.size.toLong()); x.responseBody.write(body, 0, cut)        // обрыв: заявлено больше, чем отдано
        } else { x.sendResponseHeaders(200, body.size.toLong()); x.responseBody.write(body) }
        x.close()
    }
    srv.createContext("/missing") { x -> x.sendResponseHeaders(404, -1); x.close() }
    srv.start()
    val base = "http://127.0.0.1:${srv.address.port}"
    val prog = ArrayList<Pair<Long, Long>>()
    ok("download: bad name / url refused before any request", store.download(base + "/m.bin", "../x.bin", null, AtomicBoolean(), { _, _ -> }) != null && store.download("file:///x", "a.bin", null, AtomicBoolean(), { _, _ -> }) != null && hits == 0)
    ok("download: 404 is reported", store.download(base + "/missing", "a.bin", null, AtomicBoolean(), { _, _ -> })?.contains("404") == true)
    cut = 120_000
    val e1 = store.download(base + "/m.bin", "m.bin", sha, AtomicBoolean(), { d, t -> prog.add(d to t) })
    ok("download: a cut connection leaves a .part and says so", e1 != null && File(dir, "m/m.bin.part").length() in 1..300_000 && !File(dir, "m/m.bin").exists(), e1 ?: "no error")
    cut = -1
    val e2 = store.download(base + "/m.bin", "m.bin", sha, AtomicBoolean(), { d, t -> prog.add(d to t) })
    ok("download: continues with Range from where it stopped and checks the hash", e2 == null && File(dir, "m/m.bin").length() == 300_000L && ranges.last()?.startsWith("bytes=") == true && !File(dir, "m/m.bin.part").exists(), e2 ?: "")
    ok("download: file content intact after the resume", File(dir, "m/m.bin").readBytes().contentEquals(body))
    ok("download: progress is reported, ends at the total", prog.isNotEmpty() && prog.last().first == 300_000L && prog.last().second == 300_000L)
    val n0 = hits
    ok("download: a file already there is not fetched again", store.download(base + "/m.bin", "m.bin", null, AtomicBoolean(), { _, _ -> }) == null && hits == n0)
    ok("list: the finished model", store.list().any { it.name == "m.bin" && it.size == 300_000L && !it.partial })
    ignoreRange = true; File(dir, "m/z.bin.part").writeBytes(ByteArray(1000))
    ok("download: a server that ignores Range → start over, not a corrupt file", store.download(base + "/m.bin", "z.bin", sha, AtomicBoolean(), { _, _ -> }) == null && File(dir, "m/z.bin").readBytes().contentEquals(body))
    ignoreRange = false
    ok("download: wrong hash is refused and the file is dropped", store.download(base + "/m.bin", "h.bin", "00".repeat(32), AtomicBoolean(), { _, _ -> }) == "checksum mismatch" && !File(dir, "m/h.bin").exists() && !File(dir, "m/h.bin.part").exists())
    val cancel = AtomicBoolean(true)
    ok("download: cancel stops it", store.download(base + "/m.bin", "c.bin", null, cancel, { _, _ -> }) == "cancelled" && !File(dir, "m/c.bin").exists())
    File(dir, "m/readme.txt").writeText("x")
    ok("list: foreign files are not models", store.list().none { it.name == "readme.txt" })
    ok("delete: the model and its .part", store.delete("z.bin") && !File(dir, "m/z.bin").exists() && !store.delete("../m.bin"))
    srv.stop(0)

    // --- распознавание
    val eng = FakeEngine(); val core = AsrCore(store) { eng }
    ok("run without a model → clear error", core.run(FloatArray(20000), AsrOpts()) { }.err?.contains("asr.load") == true)
    ok("load: unknown model", !core.load("nope.bin", true, false).ok)
    val l1 = core.load("m.bin", true, false)
    ok("load: ok, backends from the engine, model remembered", l1.ok && l1.backends.contains("GPU:OpenCL") && core.model == "m.bin" && core.gpu && eng.loaded!!.endsWith("m.bin"))
    ok("load: the same model again is free (no reload)", core.load("m.bin", true, false).ms == 0L && eng.freed == 0)
    val segs = ArrayList<AsrSeg>()
    val r = core.run(FloatArray(32000), AsrOpts(lang = "ru", beam = 5)) { segs.add(it) }
    ok("run: segments come one by one, empty ones do not make text", r.err == null && segs.size == 3 && r.text == "Привет, мир. Как дела?" && r.segs == 2 && r.audioMs == 2000L, r.text)
    ok("run: options reach the engine", eng.lastOpts!!.lang == "ru" && eng.lastOpts!!.beam == 5 && eng.lastPcm == 32000)
    val l2 = core.load("m.bin", false, false)
    ok("load: another backend request reloads the model", l2.ok && eng.freed == 1 && !core.gpu && !l2.backends.contains("GPU"))
    eng.slowMs = 5000
    var res: AsrCore.Ran? = null
    val th = Thread { res = core.run(FloatArray(32000), AsrOpts()) { } }; th.start(); Thread.sleep(150)
    val t0 = System.currentTimeMillis(); core.abort(); th.join(3000)
    ok("abort: a running recognition stops quickly", res?.err == "stopped" && System.currentTimeMillis() - t0 < 2000, res?.err ?: "still running")
    eng.slowMs = 0
    eng.failLoad = "broken file"
    val l3 = core.load("m.bin", true, false)
    ok("load: an engine error is passed on and nothing stays loaded", !l3.ok && l3.err == "broken file" && !core.loaded && core.model == "")
    eng.failLoad = null; core.load("m.bin", true, false); core.unload()
    ok("unload frees the model", !core.loaded && core.model == "")

    println(if (bad == 0) "all ok" else "$bad FAILED")
    dir.deleteRecursively()
    if (bad != 0) System.exit(1)
}
