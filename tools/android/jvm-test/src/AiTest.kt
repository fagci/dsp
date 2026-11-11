package app.dsp.phone.aitest

import app.dsp.phone.AiArgs
import app.dsp.phone.AsrCore
import app.dsp.phone.AsrEngine
import app.dsp.phone.AsrOpts
import app.dsp.phone.AsrSeg
import app.dsp.phone.BridgeServer
import app.dsp.phone.ChatMsg
import app.dsp.phone.LlmArgs
import app.dsp.phone.LlmCore
import app.dsp.phone.LlmEngine
import app.dsp.phone.LlmOpts
import org.json.JSONArray
import app.dsp.phone.ModelStore
import app.dsp.phone.NnArgs
import app.dsp.phone.NnCore
import app.dsp.phone.NnEngine
import app.dsp.phone.NnInfo
import app.dsp.phone.NnTensor
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

/** Подставная языковая модель: «токены» — слова запроса, отвечает фиксированной фразой по кускам (в том числе режущим символ — это дело нативного слоя, здесь только проверка потока). */
class FakeLlm : LlmEngine {
    var path: String? = null; var gpuLayers = 99; var freed = 0; var gens = 0; var lastPrompt = ""; var lastOpts: LlmOpts? = null; var failLoad: String? = null
    var template: Boolean = true; var failGen: String? = null; @Volatile var stop = false; var slowMs = 0L; var ctxSeen = 0
    var threadsNow = 0; var resets = 0; var reused = 0; var flashSeen = 99
    override fun load(path: String, ctx: Int, gpuLayers: Int, threads: Int, flash: Int, mmap: Boolean): String? { if (failLoad != null) return failLoad; this.path = path; this.gpuLayers = gpuLayers; ctxSeen = ctx; threadsNow = threads; flashSeen = flash; return null }
    override fun setThreads(n: Int) { threadsNow = n }
    override fun reset() { resets++; reused = 0 }
    override fun info() = "fake 1B Q4_0|600000000|8192|$ctxSeen"
    override fun backends() = "CPU:CPU|cpu" + (if (gpuLayers != 0) ";GPU:OpenCL|Adreno" else "")
    override fun format(m: List<ChatMsg>): ByteArray? = if (template) m.joinToString("") { "[${it.role}]${it.content}\n" }.plus("[assistant]").toByteArray() else null
    override fun countTokens(prompt: ByteArray) = String(prompt).split(Regex("\\s+")).size
    override fun generate(prompt: ByteArray, o: LlmOpts, onToken: (String) -> Boolean): String? {
        gens++; lastPrompt = String(prompt); lastOpts = o; stop = false
        if (failGen != null) return failGen
        var waited = 0L
        for (piece in listOf("При", "вет", ", ", "мир", "!")) {
            while (waited < slowMs) { if (stop) return "stopped"; Thread.sleep(10); waited += 10 }
            if (stop) return "stopped"
            if (!onToken(piece)) break
        }
        return null
    }
    override fun perf() = doubleArrayOf(100.0, 20.0, if (threadsNow == 4) 500.0 else 1000.0, 5.0, reused.toDouble())
    override fun cancel() { stop = true }
    override fun free() { freed++; path = null }
}

/** Подставная нейросеть: один вход 4 значения, два выхода (сумма и вход, умноженный на 2). */
class FakeNn(val tag: String = "m") : NnEngine {
    var gpu = false; var freed = false; var runs = 0; var failRun: String? = null
    override fun load(path: String, gpu: Boolean, threads: Int): NnInfo {
        if (path.endsWith("bad.tflite")) throw IllegalArgumentException("input «x» is INT8 — only float32 models are supported")
        this.gpu = gpu
        return NnInfo(listOf(NnTensor("in", intArrayOf(1, 4, 1), "float32")), listOf(NnTensor("sum", intArrayOf(1), "float32"), NnTensor("dbl", intArrayOf(1, 4), "float32")), if (gpu) "gpu" else "cpu", if (gpu) "" else "cpu")
    }
    override fun run(inputs: List<FloatArray>): List<FloatArray> { runs++; failRun?.let { throw IllegalStateException(it) }; return listOf(floatArrayOf(inputs[0].sum()), FloatArray(4) { inputs[0][it] * 2 }) }
    override fun free() { freed = true }
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


    // --- языковые модели
    fun arr(vararg p: Pair<String, String>) = JSONArray(p.map { org.json.JSONObject().put("role", it.first).put("content", it.second) })
    ok("llm messages: ordinary chat", LlmArgs.messages(arr("system" to "be brief", "user" to "hi", "assistant" to "hello", "user" to "and?"))?.size == 4)
    ok("llm messages: unknown role, no user message, empty and null refused", LlmArgs.messages(arr("tool" to "x", "user" to "y")) == null && LlmArgs.messages(arr("system" to "only")) == null && LlmArgs.messages(JSONArray()) == null && LlmArgs.messages(null) == null)
    ok("llm messages: size limits", LlmArgs.messages(arr("user" to "x".repeat(LlmArgs.MAX_CHARS + 1))) == null && LlmArgs.messages(JSONArray((0..LlmArgs.MAX_MSGS).map { org.json.JSONObject().put("role", "user").put("content", "a") })) == null)
    ok("llm: ChatML when the model has no template", String(LlmArgs.chatMl(listOf(ChatMsg("system", "S"), ChatMsg("user", "Привет")))) == "<|im_start|>system\nS<|im_end|>\n<|im_start|>user\nПривет<|im_end|>\n<|im_start|>assistant\n")
    val hist = listOf(ChatMsg("system", "sys"), ChatMsg("user", "a a a a"), ChatMsg("assistant", "b b b b"), ChatMsg("user", "c c"))
    val count = { m: List<ChatMsg> -> m.sumOf { it.content.split(" ").size } }
    val (f1, d1) = LlmArgs.fit(hist, count, 100); ok("llm fit: everything fits — nothing dropped", f1.size == 4 && d1 == 0)
    val (f2, d2) = LlmArgs.fit(hist, count, 7); ok("llm fit: the oldest non-system messages go first, the system one stays", d2 == 1 && f2.map { it.role } == listOf("system", "assistant", "user") && count(f2) <= 7)
    val (f3, d3) = LlmArgs.fit(hist, count, 1); ok("llm fit: the last message is never dropped", f3.last().content == "c c" && f3.first().role == "system" && f3.size == 2 && d3 == 2)
    val oc = LlmArgs.opts(99999, 9.0, 999, 9.0, 9.0, 9.0, -5)
    ok("llm opts are clamped", oc.max == 8192 && oc.temp == 2f && oc.topK == 200 && oc.topP == 1f && oc.minP == 1f && oc.repeat == 2f && oc.seed == 0)

    File(dir, "m/q.gguf").writeBytes(ByteArray(1000)); File(dir, "m/w.bin").writeBytes(ByteArray(10))
    val fl = FakeLlm(); val lc = LlmCore(store) { fl }
    ok("llm: chat without a model → clear error", lc.chat(listOf(ChatMsg("user", "hi")), LlmOpts()) { true }.err?.contains("llm.load") == true)
    ok("llm: only .gguf files load, unknown names refused", !lc.load("w.bin", true, 4096, 4, -1, true).ok && !lc.load("nope.gguf", true, 4096, 4, -1, true).ok)
    val ll = lc.load("q.gguf", true, 4096, 4, -1, true)
    ok("llm load: GPU asks all layers, info and backends come from the engine", ll.ok && fl.gpuLayers == -1 && ll.info.startsWith("fake 1B") && ll.backends.contains("GPU:OpenCL") && lc.gpu && lc.ctx == 4096)
    ok("llm load: the same settings again are free", lc.load("q.gguf", true, 4096, 4, -1, true).ms == 0L && fl.freed == 0)
    val pieces = ArrayList<String>()
    val dn = lc.chat(listOf(ChatMsg("system", "S"), ChatMsg("user", "Привет")), LlmOpts(max = 64, temp = 0.3f)) { pieces.add(it); true }
    ok("llm chat: tokens stream one by one and add up to the answer", dn.err == null && pieces.size == 5 && dn.text == "Привет, мир!" && pieces.joinToString("") == dn.text)
    ok("llm chat: the model template is used, options reach the engine", fl.lastPrompt == "[system]S\n[user]Привет\n[assistant]" && fl.lastOpts!!.max == 64 && fl.lastOpts!!.temp == 0.3f)
    ok("llm chat: speeds from the engine timings", dn.tokens == 5 && dn.promptTokens == 20 && Math.abs(dn.tps - 10.0) < 1e-9 && Math.abs(dn.ptps - 200.0) < 1e-9 && dn.trimmed == 0)
    fl.template = false
    lc.chat(listOf(ChatMsg("user", "hi")), LlmOpts()) { true }
    ok("llm chat: no template in the model → ChatML", fl.lastPrompt.startsWith("<|im_start|>user\nhi<|im_end|>"))
    fl.template = true
    val long = (1..40).flatMap { listOf(ChatMsg("user", "word ".repeat(100)), ChatMsg("assistant", "answer ".repeat(100))) } + ChatMsg("user", "last question")
    val dt = lc.chat(long, LlmOpts(max = 256)) { true }
    ok("llm chat: a dialogue longer than the context loses its oldest messages, the last question stays", dt.trimmed > 0 && fl.lastPrompt.contains("last question") && fl.countTokens(fl.lastPrompt.toByteArray()) <= 4096)
    val st = ArrayList<String>(); var cnt = 0
    val ds = lc.chat(listOf(ChatMsg("user", "hi")), LlmOpts()) { st.add(it); cnt++; cnt < 2 }
    ok("llm chat: the callback can stop the answer", st.size == 2 && ds.text == "Привет")
    fl.slowMs = 5000
    var rr: LlmCore.Done? = null
    val th2 = Thread { rr = lc.chat(listOf(ChatMsg("user", "hi")), LlmOpts()) { true } }; th2.start(); Thread.sleep(150)
    val t1 = System.currentTimeMillis(); lc.cancel(); th2.join(3000)
    ok("llm cancel: a running answer stops quickly", rr?.err == "stopped" && System.currentTimeMillis() - t1 < 2000, rr?.err ?: "still running")
    fl.slowMs = 0; fl.failGen = "the request does not fit"
    ok("llm chat: an engine error is passed on", lc.chat(listOf(ChatMsg("user", "hi")), LlmOpts()) { true }.err == "the request does not fit")
    fl.failGen = null
    val lcpu = lc.load("q.gguf", false, 2048, 4, -1, true)
    ok("llm load: another backend or context reloads the model", lcpu.ok && fl.freed == 1 && fl.gpuLayers == 0 && !lcpu.backends.contains("GPU") && lc.ctx == 2048)
    fl.failLoad = "broken file"; fl.freed = 0
    val lb = lc.load("q.gguf", true, 4096, 4, -1, true)
    ok("llm load: an engine error is passed on and nothing stays loaded", !lb.ok && lb.err == "broken file" && !lc.loaded && lc.model == "")
    fl.failLoad = null; lc.load("q.gguf", true, 4096, 4, -1, true); lc.unload()
    ok("llm unload frees the model", !lc.loaded && lc.model == "")
    ok("llm commands need the app page", BridgeServer.powerCmd("llm.chat") && BridgeServer.powerCmd("llm.load"))

    // --- скорость LLM: быстрые ядра, потоки, бенчмарк, KV-кэш в статистике
    val k8 = listOf(2_265_600L, 2_265_600L, 2_265_600L, 2_265_600L, 2_803_200L, 2_803_200L, 2_803_200L, 3_302_400L)      // 4 малых + 3 больших + 1 «прайм»
    ok("big cores: little ones are left out (≥ 70 % of the top frequency)", AiArgs.bigCores(k8, 8) == 4)
    val k8b = listOf(1_800_000L, 1_800_000L, 1_800_000L, 1_800_000L, 2_900_000L, 2_900_000L, 2_900_000L, 3_300_000L)
    ok("big cores: 4 little cores at 55 % are not counted", AiArgs.bigCores(k8b, 8) == 4)
    ok("big cores: all equal → all, clamped to 8; unknown frequencies → half of the cores", AiArgs.bigCores(List(4) { 2_000_000L }, 4) == 4 && AiArgs.bigCores(List(12) { 2_000_000L }, 12) == 8 && AiArgs.bigCores(emptyList(), 8) == 4 && AiArgs.bigCores(listOf(0L, 0L), 6) == 3)
    ok("big cores: at least 2", AiArgs.bigCores(listOf(3_000_000L, 1_000_000L, 1_000_000L, 1_000_000L), 4) == 2)
    val fb = FakeLlm(); val bc = LlmCore(store) { fb }
    bc.load("q.gguf", true, 4096, 6, -1, true)
    ok("llm load: the flash setting «auto» (-1) reaches the engine, the threads too", fb.flashSeen == -1 && fb.threadsNow == 6)
    bc.chat(listOf(ChatMsg("user", "hi")), LlmOpts(), 3) { true }
    ok("llm chat: a different thread count is applied before the answer", fb.threadsNow == 3)
    fb.threadsNow = 99; bc.chat(listOf(ChatMsg("user", "hi")), LlmOpts(), 3) { true }
    ok("llm chat: the same count is not set again", fb.threadsNow == 99)
    fb.reused = 17
    ok("llm chat: tokens taken from the KV cache are reported", bc.chat(listOf(ChatMsg("user", "hi")), LlmOpts()) { true }.cached == 17)
    val bn = bc.bench(listOf(2, 4, 6, 4, 99, 0))
    ok("bench: every candidate once (duplicates and absurd values dropped), the cache is reset before each", bn.err == null && bn.rows.map { it.threads } == listOf(2, 4, 6) && fb.resets >= 3)
    ok("bench: the fastest by answer speed wins and stays set", bn.best == 4 && fb.threadsNow == 4 && bn.rows.first { it.threads == 4 }.tps == 10.0 && bn.rows.first { it.threads == 2 }.tps == 5.0)
    ok("bench: speeds come from the engine timings (tokens per second of the answer and of the request)", bn.rows[0].tps == 5.0 && Math.abs(bn.rows[0].ptps - 200.0) < 1e-9)
    ok("bench: no list → an error, no model → an error", bc.bench(listOf(0, 99)).err != null && LlmCore(store) { FakeLlm() }.bench(listOf(2)).err!!.contains("llm.load"))
    fb.failGen = "decode error"
    ok("bench: an engine error stops it and is passed on", bc.bench(listOf(2, 4)).err == "decode error")
    fb.failGen = null


    // --- нейросети TFLite
    val fv = floatArrayOf(0.5f, -1.25f, 3.0e8f, Float.MIN_VALUE)
    ok("nn tensors: float32 little-endian round trip", NnArgs.floats(NnArgs.b64(fv), 4)!!.contentEquals(fv))
    ok("nn tensors: a known byte pattern (1.0f = 00 00 80 3f)", NnArgs.b64(floatArrayOf(1f)) == Base64.getEncoder().encodeToString(byteArrayOf(0, 0, -128, 63)))
    ok("nn tensors: wrong size, junk, empty, absurd count refused", NnArgs.floats(NnArgs.b64(fv), 3) == null && NnArgs.floats("!!!", 4) == null && NnArgs.floats("", 4) == null && NnArgs.floats(null, 4) == null && NnArgs.floats(NnArgs.b64(fv), NnArgs.MAX_FLOATS + 1) == null && NnArgs.floats(NnArgs.b64(fv), 0) == null)
    ok("nn commands need the app page", BridgeServer.powerCmd("nn.load") && BridgeServer.powerCmd("nn.run") && BridgeServer.powerCmd("nn.unload"))
    ok("asset: only vendor/ paths without traversal", AiArgs.asset("vendor/basicpitch/nmp.tflite") == "vendor/basicpitch/nmp.tflite" && AiArgs.asset("../x") == null && AiArgs.asset("vendor/../x.tflite") == null && AiArgs.asset("data/x.tflite") == null && AiArgs.asset("vendor//x") == null && AiArgs.asset("vendor/a b") == null && AiArgs.asset(null) == null && AiArgs.asset("/etc/passwd") == null)
    val st2 = ModelStore(File(dir, "m2"))
    ok("store.put: a model from a stream (the app assets)", st2.put("nmp.tflite", java.io.ByteArrayInputStream(ByteArray(2000) { 7 })) == null && File(dir, "m2/nmp.tflite").length() == 2000L && !File(dir, "m2/nmp.tflite.part").exists())
    ok("store.put: a file already there is kept, bad name and size limit refused", st2.put("nmp.tflite", java.io.ByteArrayInputStream(ByteArray(5))) == null && File(dir, "m2/nmp.tflite").length() == 2000L && st2.put("../x.tflite", java.io.ByteArrayInputStream(ByteArray(5))) != null && st2.put("big.tflite", java.io.ByteArrayInputStream(ByteArray(3000)), 1000)?.contains("larger") == true && !File(dir, "m2/big.tflite").exists() && !File(dir, "m2/big.tflite.part").exists())
    File(dir, "m2/bad.tflite").writeBytes(ByteArray(10)); File(dir, "m2/b.tflite").writeBytes(ByteArray(10)); File(dir, "m2/c.tflite").writeBytes(ByteArray(10)); File(dir, "m2/d.tflite").writeBytes(ByteArray(10)); File(dir, "m2/e.tflite").writeBytes(ByteArray(10)); File(dir, "m2/x.gguf").writeBytes(ByteArray(10))
    val engines = ArrayList<FakeNn>(); val nc = NnCore(st2) { FakeNn().also { engines.add(it) } }
    ok("nn: unknown model and a non-tflite file refused", !nc.load("nope.tflite", true, 2).ok && !nc.load("x.gguf", true, 2).ok)
    val n1 = nc.load("nmp.tflite", true, 2)
    ok("nn load: tensor info and the delegate come from the engine", n1.ok && n1.info!!.delegate == "gpu" && n1.info!!.inputs[0].count == 4 && n1.info!!.outputs.size == 2 && nc.names() == listOf("nmp.tflite"))
    ok("nn load: the same settings again are free", nc.load("nmp.tflite", true, 2).ms == 0L && engines.size == 1)
    val rn = nc.run("nmp.tflite", listOf(floatArrayOf(1f, 2f, 3f, 4f)))
    ok("nn run: one array per output, in the model order", rn.err == null && rn.outputs.size == 2 && rn.outputs[0][0] == 10f && rn.outputs[1].contentEquals(floatArrayOf(2f, 4f, 6f, 8f)))
    ok("nn run: wrong count / wrong size / not loaded → clear errors", nc.run("nmp.tflite", emptyList()).err!!.contains("1 input") && nc.run("nmp.tflite", listOf(FloatArray(3))).err!!.contains("4 values") && nc.run("zzz.tflite", listOf(FloatArray(4))).err!!.contains("nn.load"))
    engines[0].failRun = "delegate crashed"
    ok("nn run: an engine error is passed on", nc.run("nmp.tflite", listOf(FloatArray(4))).err == "delegate crashed")
    engines[0].failRun = null
    val n2 = nc.load("nmp.tflite", false, 2)
    ok("nn load: another delegate request reloads the model", n2.ok && n2.info!!.delegate == "cpu" && engines.size == 2 && engines[0].freed)
    val n3 = nc.load("bad.tflite", true, 2)
    ok("nn load: an unsupported model — the engine's reason, nothing stays loaded", !n3.ok && n3.err!!.contains("float32") && !nc.names().contains("bad.tflite") && engines.last().freed)
    for (m in listOf("b.tflite", "c.tflite", "d.tflite", "e.tflite")) nc.load(m, true, 2)
    ok("nn: at most " + NnCore.MAX + " models, the oldest is unloaded", nc.names().size == NnCore.MAX && !nc.names().contains("nmp.tflite") && nc.names().contains("e.tflite"))
    nc.unload("e.tflite"); ok("nn unload", !nc.names().contains("e.tflite"))
    nc.unloadAll(); ok("nn unload all", nc.names().isEmpty())

    println(if (bad == 0) "all ok" else "$bad FAILED")
    dir.deleteRecursively()
    if (bad != 0) System.exit(1)
}
