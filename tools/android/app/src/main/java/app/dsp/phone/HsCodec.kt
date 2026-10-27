package app.dsp.phone

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.view.Surface

/**
 * Высокая скорость камеры. Сессия constrained high-speed принимает только поверхность предпросмотра или видеокодера (ImageReader она
 * отвергает: «Surface format(35) is not for preview or hardware video encoding»). Поэтому камера пишет в вход аппаратного кодера H.264,
 * а выход кодера сразу декодируется на поверхность приёмника кадров (ImageReader) — дальше кадры идут обычным путём в JPEG.
 * Каждый кадр ключевой: потеря одного (декодер не успел) не портит следующие.
 */
class HsCodec(private val w: Int, private val h: Int, private val fps: Int, private val out: Surface, private val onFail: (String) -> Unit) {
    private var enc: MediaCodec? = null
    @Volatile private var dec: MediaCodec? = null
    @Volatile private var run = false
    private var th: Thread? = null
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
        val e = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        try {
            e.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            input = e.createInputSurface()
            e.start()
        } catch (x: Exception) { try { e.release() } catch (y: Exception) {}; throw x }
        enc = e; run = true
        th = Thread({ loop(e) }, "dsp-hs-codec").also { it.isDaemon = true; it.start() }
    }

    private fun loop(e: MediaCodec) {
        val ei = MediaCodec.BufferInfo(); val di = MediaCodec.BufferInfo()
        try {
            while (run) {
                val i = e.dequeueOutputBuffer(ei, 5000)
                if (i == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED && dec == null) {
                    val d = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
                    d.configure(e.outputFormat, out, null, 0)
                    d.start(); dec = d
                } else if (i >= 0) {
                    val d = dec
                    if (d != null && ei.size > 0 && (ei.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                        val k = d.dequeueInputBuffer(5000)
                        val src = e.getOutputBuffer(i)
                        val dst = if (k >= 0) d.getInputBuffer(k) else null
                        if (src != null && dst != null) {
                            src.position(ei.offset); src.limit(ei.offset + ei.size)
                            dst.clear(); dst.put(src)
                            d.queueInputBuffer(k, 0, ei.size, ei.presentationTimeUs, ei.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME)
                        } else if (k >= 0) d.queueInputBuffer(k, 0, 0, 0, 0)
                    }
                    e.releaseOutputBuffer(i, false)
                }
                val d = dec
                if (d != null) {
                    var o = d.dequeueOutputBuffer(di, 0)
                    while (o >= 0) { d.releaseOutputBuffer(o, true); o = d.dequeueOutputBuffer(di, 0) }
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
