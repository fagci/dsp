package app.dsp.phone

import java.io.File

/** JNI к whisper.cpp (tools/android/native/whisper_jni.cpp). Библиотек две: CPU и CPU + OpenCL (GPU); выбор — AiArgs.lib. */
object WhisperNative {
    interface Sink {
        fun segment(t0: Long, t1: Long, text: ByteArray, noSpeech: Float)       // вызывается из нативного кода, имя и сигнатура ждёт JNI
        fun aborted(): Boolean
    }

    @Volatile var lib: String? = null; private set
    @Volatile var why = ""; private set

    /** null — загружена (или уже была подходящая), иначе причина. Библиотека грузится один раз за процесс: CPU → GPU без перезапуска приложения нельзя. */
    @Synchronized fun load(cpu: AiArgs.Cpu, arm64: Boolean, gpu: Boolean): String? {
        val openCl = AiArgs.OPENCL_PATHS.any { File(it).exists() }
        val want = AiArgs.lib(cpu, arm64, openCl, gpu) ?: return "this phone cannot run the native engine: arm64 with dotprod and fp16 needed"
        val have = lib
        if (have != null) return if (want == "dsp_whisper_cl" && have != want) "GPU engine can be switched on only after the app restarts (the CPU one is already loaded)" else null
        return try { System.loadLibrary(want); lib = want; null }
        catch (e: UnsatisfiedLinkError) { why = e.message ?: "load failed"; "native library $want: $why" }
    }

    @JvmStatic external fun backends(): String
    @JvmStatic external fun systemInfo(): String
    @JvmStatic external fun init(path: String, gpu: Boolean, flash: Boolean): Long
    @JvmStatic external fun free(h: Long)
    @JvmStatic external fun isMultilingual(h: Long): Boolean
    @JvmStatic external fun transcribe(h: Long, pcm: FloatArray, lang: String, translate: Boolean, threads: Int, prompt: String, beam: Int, temperature: Float,
                                      noContext: Boolean, fast: Boolean, suppressNst: Boolean, sink: Sink): Int
}

/** Настоящий движок: whisper.cpp в процессе приложения. */
class WhisperEngine : AsrEngine {
    private var h = 0L
    @Volatile private var stop = false

    override fun load(path: String, gpu: Boolean, flash: Boolean): String? {
        val cores = Runtime.getRuntime().availableProcessors()
        val cpu = AiArgs.cpu(try { File("/proc/cpuinfo").readText() } catch (e: Exception) { "" }, cores)
        val arm64 = android.os.Build.SUPPORTED_64_BIT_ABIS.contains("arm64-v8a")
        WhisperNative.load(cpu, arm64, gpu)?.let { return it }
        h = WhisperNative.init(path, gpu, flash)
        return if (h == 0L) "the model cannot be loaded (broken file, or not enough memory)" else null
    }

    override fun backends() = try { WhisperNative.backends() } catch (e: Throwable) { "" }
    override fun system() = try { WhisperNative.systemInfo() } catch (e: Throwable) { "" }

    override fun run(pcm: FloatArray, o: AsrOpts, sink: (AsrSeg) -> Unit): String? {
        stop = false
        val rc = WhisperNative.transcribe(h, pcm, o.lang, o.translate, o.threads, o.prompt, o.beam, o.temperature, o.noContext, o.fast, o.suppressNst, object : WhisperNative.Sink {
            override fun segment(t0: Long, t1: Long, text: ByteArray, noSpeech: Float) = sink(AsrSeg(t0, t1, String(text, Charsets.UTF_8), noSpeech))
            override fun aborted() = stop
        })
        return when (rc) { -4 -> "stopped"; -3 -> "recognition failed"; -2 -> "empty audio"; -1 -> "no model"; else -> null }
    }

    override fun abort() { stop = true }
    override fun free() { if (h != 0L) WhisperNative.free(h); h = 0 }
}
