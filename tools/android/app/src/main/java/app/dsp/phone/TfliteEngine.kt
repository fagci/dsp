package app.dsp.phone

import org.tensorflow.lite.DataType
import org.tensorflow.lite.Interpreter
import org.tensorflow.lite.gpu.CompatibilityList
import org.tensorflow.lite.gpu.GpuDelegate
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors

/**
 * Модель TFLite (float32): GPU-делегат (OpenGL ES / OpenCL — на большинстве телефонов, не только Adreno), иначе CPU с XNNPACK (dotprod).
 * GPU-делегат привязан к потоку, где создан, поэтому у каждой модели свой поток: загрузка и все запуски идут на нём.
 */
class TfliteEngine : NnEngine {
    private val ex = Executors.newSingleThreadExecutor { Thread(it, "tflite") }
    private var interp: Interpreter? = null
    private var gpu: GpuDelegate? = null
    private var outCount = 0

    private fun <T> on(f: () -> T): T = try { ex.submit(Callable { f() }).get() } catch (e: ExecutionException) { throw (e.cause ?: e) }

    override fun load(path: String, gpu: Boolean, threads: Int): NnInfo = on {
        var delegate = "cpu"; var note = ""
        var it: Interpreter? = null
        if (gpu) {
            try {
                val cl = CompatibilityList()
                val ok = cl.isDelegateSupportedOnThisDevice
                if (!ok) { note = "the GPU delegate does not support this phone — CPU"; cl.close() }
                else {
                    val d = GpuDelegate(cl.bestOptionsForThisDevice); cl.close()
                    try { it = Interpreter(File(path), Interpreter.Options().setNumThreads(threads).addDelegate(d)); this.gpu = d; delegate = "gpu" }
                    catch (e: Throwable) { d.close(); note = "the GPU delegate refused the model (${e.message?.take(120)}) — CPU" }
                }
            } catch (e: Throwable) { note = "GPU delegate unavailable (${e.javaClass.simpleName}) — CPU" }
        }
        if (it == null) it = Interpreter(File(path), Interpreter.Options().setNumThreads(threads))
        interp = it
        val ins = (0 until it.inputTensorCount).map { i -> it.getInputTensor(i).let { t -> if (t.dataType() != DataType.FLOAT32) throw IllegalArgumentException("input «${t.name()}» is ${t.dataType()} — only float32 models are supported"); NnTensor(t.name(), t.shape(), "float32") } }
        val outs = (0 until it.outputTensorCount).map { i -> it.getOutputTensor(i).let { t -> if (t.dataType() != DataType.FLOAT32) throw IllegalArgumentException("output «${t.name()}» is ${t.dataType()} — only float32 models are supported"); NnTensor(t.name(), t.shape(), "float32") } }
        outCount = outs.size
        NnInfo(ins, outs, delegate, note)
    }

    override fun run(inputs: List<FloatArray>): List<FloatArray> = on {
        val it = interp ?: throw IllegalStateException("not loaded")
        val ins = Array<Any>(inputs.size) { i -> ByteBuffer.allocateDirect(inputs[i].size * 4).order(ByteOrder.nativeOrder()).also { b -> b.asFloatBuffer().put(inputs[i]) } }
        val outs = HashMap<Int, Any>()
        val bufs = (0 until outCount).map { i -> ByteBuffer.allocateDirect(it.getOutputTensor(i).numBytes()).order(ByteOrder.nativeOrder()).also { outs[i] = it } }
        it.runForMultipleInputsOutputs(ins, outs)
        bufs.map { b -> b.rewind(); FloatArray(b.capacity() / 4).also { a -> b.asFloatBuffer().get(a) } }
    }

    override fun free() { try { on { interp?.close(); gpu?.close(); interp = null; gpu = null } } catch (e: Throwable) {}; ex.shutdown() }
}
