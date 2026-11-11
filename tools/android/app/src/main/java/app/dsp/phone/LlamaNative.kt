package app.dsp.phone

import java.io.File

/** JNI к llama.cpp (tools/android/native/llama/llama_jni.cpp). Библиотек две: CPU и CPU + OpenCL (GPU). */
object LlamaNative {
    interface Sink {
        fun token(text: ByteArray): Boolean           // вызывается из нативного кода; false — остановить
        fun cancelled(): Boolean
    }

    @Volatile var lib: String? = null; private set
    @Volatile var why = ""; private set

    /** null — загружена (или уже была подходящая), иначе причина. Грузится один раз за процесс: CPU → GPU без перезапуска приложения нельзя. */
    @Synchronized fun load(cpu: AiArgs.Cpu, arm64: Boolean, gpu: Boolean): String? {
        val openCl = AiArgs.OPENCL_PATHS.any { File(it).exists() }
        val want = AiArgs.lib(cpu, arm64, openCl, gpu, "dsp_llama") ?: return "this phone cannot run the native engine: arm64 with dotprod and fp16 needed"
        val have = lib
        if (have != null) return if (want.endsWith("_cl") && have != want) "GPU engine can be switched on only after the app restarts (the CPU one is already loaded)" else null
        return try { System.loadLibrary(want); lib = want; null }
        catch (e: UnsatisfiedLinkError) { why = e.message ?: "load failed"; "native library $want: $why" }
    }

    @JvmStatic external fun backends(): String
    @JvmStatic external fun systemInfo(): String
    @JvmStatic external fun init(path: String, nCtx: Int, gpuLayers: Int, threads: Int, flash: Boolean, mmap: Boolean): Long
    @JvmStatic external fun free(h: Long)
    @JvmStatic external fun describe(h: Long): String
    @JvmStatic external fun applyTemplate(h: Long, roles: Array<String>, contents: Array<String>, addAss: Boolean): ByteArray?
    @JvmStatic external fun countTokens(h: Long, text: ByteArray): Int
    @JvmStatic external fun generate(h: Long, prompt: ByteArray, maxTokens: Int, temp: Float, topK: Int, topP: Float, minP: Float, repeat: Float, seed: Int, sink: Sink): Int
    @JvmStatic external fun perf(h: Long): DoubleArray
}

/** Настоящий движок: llama.cpp в процессе приложения. */
class LlamaEngine : LlmEngine {
    private var h = 0L
    @Volatile private var stop = false

    override fun load(path: String, ctx: Int, gpuLayers: Int, threads: Int, flash: Boolean, mmap: Boolean): String? {
        val cores = Runtime.getRuntime().availableProcessors()
        val cpu = AiArgs.cpu(try { File("/proc/cpuinfo").readText() } catch (e: Exception) { "" }, cores)
        val arm64 = android.os.Build.SUPPORTED_64_BIT_ABIS.contains("arm64-v8a")
        LlamaNative.load(cpu, arm64, gpuLayers != 0)?.let { return it }
        h = LlamaNative.init(path, ctx, gpuLayers, threads, flash, mmap)
        return if (h == 0L) "the model cannot be loaded (broken file, unsupported architecture, or not enough memory)" else null
    }

    override fun info() = try { LlamaNative.describe(h) } catch (e: Throwable) { "" }
    override fun backends() = try { LlamaNative.backends() } catch (e: Throwable) { "" }

    override fun format(m: List<ChatMsg>): ByteArray? =
        LlamaNative.applyTemplate(h, m.map { it.role }.toTypedArray(), m.map { it.content }.toTypedArray(), true)

    override fun countTokens(prompt: ByteArray) = LlamaNative.countTokens(h, prompt)

    override fun generate(prompt: ByteArray, o: LlmOpts, onToken: (String) -> Boolean): String? {
        stop = false
        val rc = LlamaNative.generate(h, prompt, o.max, o.temp, o.topK, o.topP, o.minP, o.repeat, o.seed, object : LlamaNative.Sink {
            override fun token(text: ByteArray) = onToken(String(text, Charsets.UTF_8))
            override fun cancelled() = stop
        })
        return when {
            rc >= 0 -> if (stop) "stopped" else null
            rc == -2 -> "the request does not fit the context — raise «context» or shorten the dialogue"
            rc == -3 -> "generation failed (decode error)"
            rc == -5 -> "cannot tokenize the request"
            else -> "no model"
        }
    }

    override fun perf() = LlamaNative.perf(h)
    override fun cancel() { stop = true }
    override fun free() { if (h != 0L) LlamaNative.free(h); h = 0 }
}
