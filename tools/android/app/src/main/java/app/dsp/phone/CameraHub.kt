package app.dsp.phone

import android.content.Context
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.Image
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import java.io.ByteArrayOutputStream

/** Камера (Camera2) → кадры JPEG. Открыта, пока есть хотя бы один зритель; работает при погашенном экране (foreground-сервис). */
class CameraHub(private val ctx: Context, private val onUsers: () -> Unit) {
    data class Cfg(val facing: Int, val width: Int, val fps: Int, val quality: Int, val rot: Int)
    class Lease(val gen: Int)

    private val lock = Object()
    private val main by lazy { Handler(Looper.getMainLooper()) }
    private var cfg: Cfg? = null
    private var gen = 0
    private var users = 0
    private var seq = 0L
    private var jpeg: ByteArray? = null
    @Volatile var error = ""
    @Volatile var info = ""

    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var reader: ImageReader? = null
    private var sensorRot = 0
    private var lastEnc = 0L
    private val idleStop = Runnable { synchronized(lock) { if (users == 0) stopLocked() } }

    val viewers: Int get() = synchronized(lock) { users }

    fun available(): List<String> = try {
        val m = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        m.cameraIdList.mapNotNull {
            when (m.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING)) {
                CameraCharacteristics.LENS_FACING_BACK -> "back"
                CameraCharacteristics.LENS_FACING_FRONT -> "front"
                else -> null
            }
        }.distinct()
    } catch (e: Exception) { emptyList() }

    /** Занимает камеру с настройками c; null — не получилось (причина в error). Другие настройки у нового зрителя перезапускают камеру. */
    fun acquire(c: Cfg): Lease? {
        if (!ctx.granted(android.Manifest.permission.CAMERA)) { error = "no camera permission — open the DSP app and allow it"; return null }
        val lease: Lease
        synchronized(lock) {
            main.removeCallbacks(idleStop)
            if (cfg != c || device == null && thread == null) {
                if (cfg != null) stopLocked()
                error = ""
                if (!startLocked(c)) return null
                gen++
            }
            users++
            lease = Lease(gen)
        }
        onUsers()
        return lease
    }

    fun release() {
        synchronized(lock) {
            users = maxOf(0, users - 1)
            if (users == 0) main.postDelayed(idleStop, 3000)
        }
        onUsers()
    }

    /** Следующий кадр новее seq или null (таймаут, камеру переключили / остановили). Возвращает кадр и его номер. */
    fun next(l: Lease, last: Long, timeoutMs: Long): Pair<ByteArray, Long>? {
        val end = SystemClock.elapsedRealtime() + timeoutMs
        synchronized(lock) {
            while (true) {
                if (l.gen != gen || cfg == null) return null
                val j = jpeg
                if (j != null && seq > last) return j to seq
                val left = end - SystemClock.elapsedRealtime()
                if (left <= 0) return null
                lock.wait(left)
            }
        }
    }

    fun valid(l: Lease) = synchronized(lock) { l.gen == gen && cfg != null }

    fun stop() { synchronized(lock) { main.removeCallbacks(idleStop); stopLocked() } }

    private fun stopLocked() {
        cfg = null; info = ""
        try { session?.close() } catch (e: Exception) {}
        try { device?.close() } catch (e: Exception) {}
        try { reader?.close() } catch (e: Exception) {}
        session = null; device = null; reader = null
        thread?.quitSafely(); thread = null; handler = null
        jpeg = null
        lock.notifyAll()
    }

    private fun startLocked(c: Cfg): Boolean {
        try {
            val mgr = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val id = mgr.cameraIdList.firstOrNull { mgr.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == c.facing }
                ?: run { error = "no such camera"; return false }
            val ch = mgr.getCameraCharacteristics(id)
            val sizes = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)?.getOutputSizes(ImageFormat.YUV_420_888)
            if (sizes.isNullOrEmpty()) { error = "camera has no YUV output"; return false }
            // ближайшая по ширине к запрошенной (при равенстве — с меньшей площадью)
            val size = sizes.sortedWith(compareBy<android.util.Size>({ Math.abs(it.width - c.width) }, { it.width * it.height })).first()
            sensorRot = ch.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
            val th = HandlerThread("dsp-camera").also { it.start() }
            val h = Handler(th.looper)
            thread = th; handler = h; cfg = c; lastEnc = 0
            val rd = ImageReader.newInstance(size.width, size.height, ImageFormat.YUV_420_888, 2)
            rd.setOnImageAvailableListener({ onImage(it, c) }, h)
            reader = rd
            info = "${size.width}×${size.height}"
            mgr.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(d: CameraDevice) {
                    device = d
                    openSession(d, rd, ch, c, h)
                }
                override fun onDisconnected(d: CameraDevice) { d.close(); fail("camera disconnected (another app took it?)") }
                override fun onError(d: CameraDevice, code: Int) { d.close(); fail("camera error $code") }
            }, h)
            return true
        } catch (e: SecurityException) {
            error = "no camera permission"
        } catch (e: Exception) {
            error = "camera: ${e.message}"
        }
        stopLocked()
        return false
    }

    private fun fail(msg: String) { error = msg; synchronized(lock) { stopLocked() }; onUsers() }

    @Suppress("DEPRECATION")
    private fun openSession(d: CameraDevice, rd: ImageReader, ch: CameraCharacteristics, c: Cfg, h: Handler) {
        try {
            d.createCaptureSession(listOf(rd.surface), object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(s: CameraCaptureSession) {
                    session = s
                    try {
                        val rq = d.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW)
                        rq.addTarget(rd.surface)
                        // диапазон кадров, ближайший сверху к нужному fps: меньше fps — меньше нагрев и батареи
                        val ranges = ch.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
                        ranges?.sortedWith(compareBy<android.util.Range<Int>>({ Math.abs(it.upper - c.fps) }, { it.lower }))?.firstOrNull()
                            ?.let { rq.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, it) }
                        s.setRepeatingRequest(rq.build(), null, h)
                    } catch (e: Exception) { fail("camera: ${e.message}") }
                }
                override fun onConfigureFailed(s: CameraCaptureSession) { fail("camera: could not configure") }
            }, h)
        } catch (e: Exception) { fail("camera: ${e.message}") }
    }

    private fun onImage(r: ImageReader, c: Cfg) {
        val img = r.acquireLatestImage() ?: return
        try {
            val now = SystemClock.elapsedRealtime()
            if (now - lastEnc < 1000L / c.fps - 5) return
            lastEnc = now
            val w = img.width; val h = img.height
            val rot = ((sensorRot + c.rot) % 360 + 360) % 360
            val nv = Yuv.rotate(Yuv.toNv21(img), w, h, rot)
            val (nw, nh) = if (rot == 90 || rot == 270) h to w else w to h
            val bos = ByteArrayOutputStream(nw * nh / 6)
            YuvImage(nv, ImageFormat.NV21, nw, nh, null).compressToJpeg(Rect(0, 0, nw, nh), c.quality, bos)
            synchronized(lock) { jpeg = bos.toByteArray(); seq++; lock.notifyAll() }
        } catch (e: Exception) {
            error = "encode: ${e.message}"
        } finally {
            img.close()
        }
    }
}

/** YUV_420_888 → NV21 и поворот NV21 по часовой стрелке (чётные размеры). */
object Yuv {
    fun toNv21(img: Image): ByteArray {
        val w = img.width; val h = img.height
        val out = ByteArray(w * h * 3 / 2)
        val y = img.planes[0]
        for (row in 0 until h) {
            y.buffer.position(row * y.rowStride)
            y.buffer.get(out, row * w, w)
        }
        val u = img.planes[1]; val v = img.planes[2]
        var o = w * h
        for (row in 0 until h / 2) for (col in 0 until w / 2) {
            out[o++] = v.buffer.get(row * v.rowStride + col * v.pixelStride)
            out[o++] = u.buffer.get(row * u.rowStride + col * u.pixelStride)
        }
        return out
    }

    fun rotate(src: ByteArray, w: Int, h: Int, rot: Int): ByteArray {
        if (rot == 0) return src
        val dst = ByteArray(src.size)
        val fs = w * h
        val cw = w / 2; val ch = h / 2
        when (rot) {
            90 -> {
                for (y in 0 until h) for (x in 0 until w) dst[x * h + (h - 1 - y)] = src[y * w + x]
                for (y in 0 until ch) for (x in 0 until cw) {
                    val s = fs + (y * cw + x) * 2; val d = fs + (x * ch + (ch - 1 - y)) * 2
                    dst[d] = src[s]; dst[d + 1] = src[s + 1]
                }
            }
            180 -> {
                for (i in 0 until fs) dst[fs - 1 - i] = src[i]
                val n = cw * ch
                for (i in 0 until n) { val s = fs + i * 2; val d = fs + (n - 1 - i) * 2; dst[d] = src[s]; dst[d + 1] = src[s + 1] }
            }
            270 -> {
                for (y in 0 until h) for (x in 0 until w) dst[(w - 1 - x) * h + y] = src[y * w + x]
                for (y in 0 until ch) for (x in 0 until cw) {
                    val s = fs + (y * cw + x) * 2; val d = fs + ((cw - 1 - x) * ch + y) * 2
                    dst[d] = src[s]; dst[d + 1] = src[s + 1]
                }
            }
            else -> return src
        }
        return dst
    }
}
