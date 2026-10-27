package app.dsp.phone

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.view.Surface

/**
 * Высокая скорость камеры, полная частота. Сессия constrained high-speed отдаёт ВСЕ кадры (120 / 240 в секунду) только поверхности видеокодера;
 * поверхность предпросмотра (SurfaceTexture) получает их лишь ~30 в секунду — по этому и выходило 30–35 отсчётов яркости. Поэтому камера пишет
 * в вход аппаратного кодера H.264 (каждый кадр ключевой), а декодер сразу выводит кадры на поверхность видеокарты (HsGl) — яркость считается там.
 * Раньше декодер → ImageReader валил приложение нативно: метка hs-codec-try ставится перед пробой и снимается после 200 кадров; осталась —
 * CameraHub в следующий раз не берёт кодер (hs-codec-bad).
 */
class HsEnc(private val dir: java.io.File, private val w: Int, private val h: Int, private val fps: Int, private val out: Surface, private val onFail: (String) -> Unit) {
    private var enc: MediaCodec? = null
    @Volatile private var dec: MediaCodec? = null
    @Volatile private var run = false
    private var th: Thread? = null
    private var shown = 0
    lateinit var input: Surface
        private set

    fun start() {
        val f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h)
        f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
        f.setInteger(MediaFormat.KEY_BIT_RATE, (w * h * 12).coerceIn(8_000_000, 80_000_000))
        f.setInteger(MediaFormat.KEY_FRAME_RATE, fps)
        f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 0)
        f.setInteger(MediaFormat.KEY_OPERATING_RATE, fps)
        f.setInteger(MediaFormat.KEY_PRIORITY, 0)
        try { f.setInteger(MediaFormat.KEY_LATENCY, 1) } catch (x: Exception) {}
        val e = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        try {
            e.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            input = e.createInputSurface()
            e.start()
        } catch (x: Exception) { try { e.release() } catch (y: Exception) {}; throw x }
        enc = e; run = true
        try { java.io.File(dir, "hs-codec-try").writeText("1") } catch (x: Exception) {}
        th = Thread({ loop(e) }, "dsp-hs-enc").also { it.isDaemon = true; it.start() }
    }

    private class Out(val i: Int, val off: Int, val size: Int, val pts: Long, val flags: Int)

    private fun loop(e: MediaCodec) {
        val ei = MediaCodec.BufferInfo()
        try {
            while (run) {
                val i = e.dequeueOutputBuffer(ei, 5000)
                if (i == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED && dec == null) {
                    val d = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
                    val df = e.outputFormat
                    if (android.os.Build.VERSION.SDK_INT >= 30) df.setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
                    d.configure(df, out, null, 0)              // кадры — прямо на поверхность видеокарты
                    d.start(); dec = d
                } else if (i >= 0) {
                    val q = ArrayList<Out>()
                    q.add(Out(i, ei.offset, ei.size, ei.presentationTimeUs, ei.flags))
                    while (q.size < 256) {
                        val j = e.dequeueOutputBuffer(ei, 0)
                        if (j < 0) break
                        q.add(Out(j, ei.offset, ei.size, ei.presentationTimeUs, ei.flags))
                    }
                    // большое отставание (декодер не успевает): с последнего ключевого кадра; в норме декодируется всё — нужен каждый кадр
                    var from = 0
                    if (q.size > 24) { val k = q.indexOfLast { (it.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0 }; from = if (k >= 0) k else q.size - 1 }
                    val d = dec
                    for ((n, o) in q.withIndex()) {
                        if (d != null && n >= from && o.size > 0 && (o.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                            val k = d.dequeueInputBuffer(2000)
                            val src = e.getOutputBuffer(o.i)
                            val dst = if (k >= 0) d.getInputBuffer(k) else null
                            if (src != null && dst != null) {
                                src.position(o.off); src.limit(o.off + o.size)
                                dst.clear(); dst.put(src)
                                d.queueInputBuffer(k, 0, o.size, o.pts, o.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME)
                            } else if (k >= 0) d.queueInputBuffer(k, 0, 0, 0, 0)
                        }
                        e.releaseOutputBuffer(o.i, false)
                    }
                }
                val d = dec
                if (d != null) {
                    val di = MediaCodec.BufferInfo()
                    var o = d.dequeueOutputBuffer(di, 0)
                    while (o >= 0) {
                        d.releaseOutputBuffer(o, true)           // каждый кадр — на поверхность: на нём считается яркость
                        if (++shown == 200) try { java.io.File(dir, "hs-codec-try").delete() } catch (x: Exception) {}
                        o = d.dequeueOutputBuffer(di, 0)
                    }
                }
            }
        } catch (x: Exception) { if (run) onFail(x.message ?: x.javaClass.simpleName) }
    }

    fun stop() {
        run = false
        try { th?.join(500) } catch (x: Exception) {}
        th = null
        try { enc?.stop() } catch (x: Exception) {}
        try { enc?.release() } catch (x: Exception) {}
        try { dec?.stop() } catch (x: Exception) {}
        try { dec?.release() } catch (x: Exception) {}
        try { if (enc != null) input.release() } catch (x: Exception) {}
        enc = null; dec = null
    }
}
