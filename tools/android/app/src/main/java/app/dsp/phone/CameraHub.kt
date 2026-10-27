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
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** Камера (Camera2) → кадры JPEG. Открыта, пока есть хотя бы один зритель; работает при погашенном экране (foreground-сервис). */
class CameraHub(private val ctx: Context, private val onUsers: () -> Unit) {
    /** id — своя камера по номеру (внешняя, тепловизор, ИК); pal — палитра 16-битных кадров (gray / iron). */
    data class Cfg(val facing: Int, val width: Int, val fps: Int, val quality: Int, val rot: Int, val id: String? = null, val pal: String = "gray")
    class Lease(val gen: Int)

    private val lock = Object()
    private val main by lazy { Handler(Looper.getMainLooper()) }
    private var cfg: Cfg? = null
    private var gen = 0
    private var users = 0
    private var seq = 0L
    private var jpeg: ByteArray? = null
    @Volatile var error = ""
    /** Сообщение странице (запись моста level=warn): страница показывает его в узле телефона. */
    @Volatile var onNote: ((String) -> Unit)? = null
    @Volatile var info = ""

    /** Зритель пришёл, а разрешения на камеру нет: сервис просит его окном или уведомлением (иначе поток вечно отвечал бы 503). */
    @Volatile var onNeedPermission: (() -> Unit)? = null

    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var reader: ImageReader? = null
    private var hs: HsGl? = null                              // режим высокой скорости: кадры камеры → видеокарта → яркость и картинка
    private var sensorRot = 0
    private var fmt = ImageFormat.YUV_420_888
    private var phys: String? = null
    private var hsRange: android.util.Range<Int>? = null       // режим высокой скорости (constrained high-speed): fps выше предела автоэкспозиции
    private var note = ""                                    // пометка к статусу камеры: чем закончился запрос высокой скорости
    private val noHs = HashMap<String, String>()                // камера → почему сессия высокой скорости не создалась
    private var lastEnc = 0L
    private var hsNoteT = 0L
    private var pool: ExecutorService? = null                 // кодирование кадров параллельно: один поток упирался в ~25 к/с (YUV → NV21 → поворот → JPEG)
    private val busy = AtomicInteger()
    private var frameNo = 0L
    private var shownNo = 0L
    private var lastPub = 0L
    private var emaMs = 0.0
    private var infoT = 0L
    private var infoBase = ""
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

    /** Все камеры: номер, сторона, вид (visible / ir / thermal / depth), форматы, наибольший размер. Тепловизоры и ИК — те, где вид не visible. */
    fun describe(): String = try {
        val m = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val listed = m.cameraIdList.toSet()
        val rows = ArrayList<String>()
        fun row(id: String, ch: CameraCharacteristics, logical: String?, hidden: Boolean = false) {
            val map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            val fm = map?.outputFormats?.toSet() ?: emptySet()
            val nir = ch.get(CameraCharacteristics.SENSOR_INFO_COLOR_FILTER_ARRANGEMENT) == 5      // COLOR_FILTER_ARRANGEMENT_NIR
            val pick = Cam.pick(fm)
            val big = pick?.let { f -> map?.getOutputSizes(f)?.maxByOrNull { it.width * it.height } }
            val fl = ch.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.firstOrNull()
            // предел частоты в обычном режиме (диапазоны автоэкспозиции) и в режиме высокой скорости (если камера его умеет)
            val fps = ch.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)?.maxOfOrNull { it.upper }
            val hs = try { map?.highSpeedVideoFpsRanges?.maxOfOrNull { it.upper } } catch (e: Exception) { null }
            rows.add(Json.obj("id" to Json.str(id), "facing" to Json.str(when (ch.get(CameraCharacteristics.LENS_FACING)) {
                CameraCharacteristics.LENS_FACING_BACK -> "back"; CameraCharacteristics.LENS_FACING_FRONT -> "front"; CameraCharacteristics.LENS_FACING_EXTERNAL -> "external"; else -> "unknown" }),
                "kind" to Json.str(Cam.kind(fm, nir)), "formats" to Json.arr(fm.sorted().map { "0x" + Integer.toHexString(it) }),
                "w" to big?.width?.toString(), "h" to big?.height?.toString(), "focal" to fl?.let { Json.num(it.toDouble(), 10.0) },
                "fps" to fps?.toString(), "hs" to hs?.toString(),
                "logical" to logical?.let { Json.str(it) }, "hidden" to if (hidden) "1" else null))
        }
        for (id in listed) {
            val ch = m.getCameraCharacteristics(id)
            row(id, ch, null)
            // физические камеры логической (ультраширик, телевик…): в списке камер их нет, но открыть их можно через логическую (Android 9+)
            if (Build.VERSION.SDK_INT >= 28) for (ph in ch.physicalCameraIds) if (ph !in listed) {
                try { row("$id/$ph", m.getCameraCharacteristics(ph), id) } catch (e: Exception) { rows.add(Json.obj("id" to Json.str("$id/$ph"), "facing" to Json.str("unknown"), "kind" to Json.str("other"), "logical" to Json.str(id))) }
            }
        }
        // камеры, которых нет в списке, но сервис отдаёт их характеристики (и часто открывает): вспомогательные, макро, глубина…
        for (n in 0..15) { val id = n.toString(); if (id in listed) continue
            try { row(id, m.getCameraCharacteristics(id), null, hidden = true) } catch (e: Exception) { /* такой камеры нет */ } }
        Json.rows(rows)
    } catch (e: Exception) { "[]" }

    /** Занимает камеру с настройками c; null — не получилось (причина в error). Другие настройки у нового зрителя перезапускают камеру. */
    fun acquire(c: Cfg): Lease? {
        if (!ctx.granted(android.Manifest.permission.CAMERA)) {
            error = "camera permission was asked on the phone — allow it and reload the picture"
            onNeedPermission?.invoke()
            return null
        }
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

    fun stop() { synchronized(lock) { main.removeCallbacks(idleStop); note = ""; stopLocked() } }

    private fun stopLocked() {
        cfg = null; info = ""
        try { session?.close() } catch (e: Exception) {}
        try { hs?.stop() } catch (e: Exception) {}
        hs = null
        try { device?.close() } catch (e: Exception) {}
        try { reader?.close() } catch (e: Exception) {}
        session = null; device = null; reader = null
        thread?.quitSafely(); thread = null; handler = null
        pool?.shutdownNow(); pool = null
        jpeg = null
        lock.notifyAll()
    }

    private fun startLocked(c: Cfg): Boolean {
        try {
            val mgr = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val want = c.id?.split("/", limit = 2)                    // «0/2»: логическая камера 0, физическая 2 (скрытая от списка камер)
            val id = (if (want != null) want[0].takeIf { it in mgr.cameraIdList || hasCharacteristics(mgr, it) }       // камера вне списка: открывается, если сервис отдаёт её характеристики
                else mgr.cameraIdList.firstOrNull { mgr.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == c.facing })
                ?: run { error = "no such camera"; return false }
            phys = want?.getOrNull(1)?.takeIf { Build.VERSION.SDK_INT >= 28 }
            val ch = phys?.let { try { mgr.getCameraCharacteristics(it) } catch (e: Exception) { null } } ?: mgr.getCameraCharacteristics(id)
            val map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            // YUV, а у тепловизоров и камер глубины — 16-битный кадр (Y16 / DEPTH16): он уходит в картинку с автоконтрастом
            fmt = Cam.pick(map?.outputFormats?.toSet() ?: emptySet()) ?: run { error = "camera has no YUV / Y16 / DEPTH16 output"; return false }
            // fps выше обычного предела: диапазон высокой скорости (фиксированный — первым), размеры берутся из него
            val normalMax = ch.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)?.maxOfOrNull { it.upper } ?: 30
            hsRange = null
            if (c.fps <= normalMax) note = ""
            var hsWhy = ""                                            // почему высокая скорость не включена, хотя fps выше обычного предела — в статус и на страницу
            if (c.fps > normalMax) {
                if (phys != null) hsWhy = "not for hidden physical cameras"
                else if ((c.id ?: "f${c.facing}") in noHs) hsWhy = "refused earlier: ${noHs[c.id ?: "f${c.facing}"]}"
                else try {
                    val rs = map?.highSpeedVideoFpsRanges ?: emptyArray()
                    hsRange = rs.filter { it.upper >= c.fps }.sortedWith(compareBy({ it.upper }, { if (it.lower == it.upper) 0 else 1 })).firstOrNull() ?: rs.maxByOrNull { it.upper }
                    if (hsRange == null) hsWhy = "this camera has no high-speed ranges (normal limit $normalMax)"
                    else if (ImageFormat.YUV_420_888 !in (map?.outputFormats ?: IntArray(0))) { hsRange = null; hsWhy = "no YUV output" }
                    else fmt = ImageFormat.YUV_420_888
                } catch (e: Exception) { hsRange = null; hsWhy = "query failed: ${e.message}" }
            }
            if (hsWhy.isNotEmpty()) { note = " · high-speed off: $hsWhy"; onNote?.invoke("camera: high-speed off: $hsWhy") }
            val sizes = hsRange?.let { map?.getHighSpeedVideoSizesFor(it) } ?: map?.getOutputSizes(fmt)
            if (sizes.isNullOrEmpty()) { error = "camera has no output sizes"; return false }
            // ближайшая по ширине к запрошенной (при равенстве — с меньшей площадью)
            val size = sizes.sortedWith(compareBy<android.util.Size>({ Math.abs(it.width - c.width) }, { it.width * it.height })).first()
            sensorRot = ch.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
            val th = HandlerThread("dsp-camera").also { it.start() }
            val h = Handler(th.looper)
            thread = th; handler = h; cfg = c; lastEnc = 0
            val workers = Runtime.getRuntime().availableProcessors().coerceIn(2, 4)
            pool = Executors.newFixedThreadPool(workers) { r -> Thread(r, "dsp-enc").also { it.isDaemon = true } }
            busy.set(0); frameNo = 0; shownNo = 0; lastPub = 0; emaMs = 0.0; infoT = 0
            val rd = ImageReader.newInstance(size.width, size.height, fmt, workers + 2)
            rd.setOnImageAvailableListener({ onImage(it, c) }, h)
            reader = rd
            infoBase = "${size.width}×${size.height}" + (hsRange?.let { " · high-speed ${it.upper}" } ?: "") + note; info = infoBase
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

    private fun hasCharacteristics(mgr: CameraManager, id: String) = try { mgr.getCameraCharacteristics(id); true } catch (e: Exception) { false }

    private fun fail(msg: String) { error = msg; synchronized(lock) { stopLocked() }; onUsers() }

    @Suppress("DEPRECATION")
    private fun openSession(d: CameraDevice, rd: ImageReader, ch: CameraCharacteristics, c: Cfg, h: Handler) {
        try {
            val cb = object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(s: CameraCaptureSession) {
                    session = s
                    try {
                        val hr = hsRange
                        if (hr != null) {
                            val hss = s as android.hardware.camera2.CameraConstrainedHighSpeedCaptureSession
                            val rq = d.createCaptureRequest(CameraDevice.TEMPLATE_RECORD)
                            rq.addTarget(hs!!.surface)
                            rq.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, hr)
                            // яркость кадров меряет мерцание: автофокус (мотор останавливает кадры) и подавление мерцания сети в экспозиции не нужны
                            rq.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_OFF)
                            rq.set(CaptureRequest.CONTROL_AE_ANTIBANDING_MODE, CaptureRequest.CONTROL_AE_ANTIBANDING_MODE_OFF)
                            hss.setRepeatingBurst(hss.createHighSpeedRequestList(rq.build()), null, h)
                            return
                        }
                        val rq = d.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW)
                        rq.addTarget(rd.surface)
                        manualRate(ch, rd, c, rq)
                        // диапазон кадров, ближайший сверху к нужному fps: меньше fps — меньше нагрев и батареи
                        val ranges = ch.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
                        ranges?.sortedWith(compareBy<android.util.Range<Int>>({ Math.abs(it.upper - c.fps) }, { -it.lower }))?.firstOrNull()
                            ?.let { rq.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, it) }
                        s.setRepeatingRequest(rq.build(), null, h)
                    } catch (e: Exception) { fail("camera: ${e.message}") }
                }
                override fun onConfigureFailed(s: CameraCaptureSession) {
                    if (hsRange == null) { fail("camera: could not configure"); return }
                    hsGiveUp(c, "camera refused the session (${rd.width}×${rd.height} YUV, range ${hsRange})")
                }
            }
            val hr = hsRange
            if (hr != null) {
                // поверхность сессии — SurfaceTexture видеокарты (HsGl); отказ приходит и исключением, и через onConfigureFailed
                try {
                    val rot = ((sensorRot + c.rot) % 360 + 360) % 360
                    val k = HsGl(rd.width, rd.height, rot, c.quality, hr.upper, { v, n, dt -> lumIn(v, n, dt) }, { jpg -> publish(jpg) }) { why -> hsGiveUp(c, "gl: $why") }
                    k.start(); hs = k
                    d.createConstrainedHighSpeedCaptureSession(listOf(k.surface), cb, h)
                } catch (e: Exception) { hsGiveUp(c, e.message ?: e.javaClass.simpleName) }
                return
            }
            val ph = phys
            if (ph != null && Build.VERSION.SDK_INT >= 28) {
                val oc = android.hardware.camera2.params.OutputConfiguration(rd.surface)
                oc.setPhysicalCameraId(ph)
                d.createCaptureSessionByOutputConfigurations(listOf(oc), cb, h)
            } else d.createCaptureSession(listOf(rd.surface), cb, h)
        } catch (e: Exception) { fail("camera: ${e.message}") }
    }

    /** Высокая скорость не принята: запоминаем камеру и открываем заново в обычном режиме (зритель ждёт тот же поток). */
    private fun hsGiveUp(c: Cfg, why: String) {
        if (why.contains("already closed")) return                // камеру закрыли своим же стопом: это не отказ высокой скорости
        main.post { synchronized(lock) { if (cfg == c) { noHs[c.id ?: "f${c.facing}"] = why.take(120); stopLocked(); error = ""; note = " · high-speed refused: ${why.take(90)}"; onNote?.invoke("camera: high-speed refused: $why"); startLocked(c) } } }
    }

    /** fps выше предела автоэкспозиции без сессии высокой скорости: выдержка и длительность кадра вручную (предел — минимальная длительность кадра для размера). */
    private fun manualRate(ch: CameraCharacteristics, rd: ImageReader, c: Cfg, rq: CaptureRequest.Builder) {
        val normalMax = ch.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)?.maxOfOrNull { it.upper } ?: 30
        if (hsRange != null || c.fps <= normalMax) return
        val caps = ch.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: IntArray(0)
        if (CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR !in caps) { infoBase += " · fps above $normalMax needs manual sensor control (not supported)"; info = infoBase; return }
        val map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        val minDur = map?.getOutputMinFrameDuration(rd.imageFormat, android.util.Size(rd.width, rd.height)) ?: 0L
        val fd = maxOf(1_000_000_000L / c.fps, minDur)
        val er = ch.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE)
        val iso = ch.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)
        val exp = (fd * 8 / 10).coerceIn(er?.lower ?: 1L, er?.upper ?: fd)
        rq.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_OFF)
        rq.set(CaptureRequest.SENSOR_FRAME_DURATION, fd)
        rq.set(CaptureRequest.SENSOR_EXPOSURE_TIME, exp)
        if (iso != null) rq.set(CaptureRequest.SENSOR_SENSITIVITY, minOf(iso.upper, 1600).coerceAtLeast(iso.lower))
        infoBase += " · manual ${"%.0f".format(1e9 / fd)} fps" + if (fd > 1_000_000_000L / c.fps + 1000) " (the limit of this size)" else ""
        info = infoBase
    }

    private fun onImage(r: ImageReader, c: Cfg) {
        val img = (try { r.acquireLatestImage() } catch (e: Exception) { null }) ?: return      // превышен maxImages: кадр пропускаем, а не роняем приложение
        val now = SystemClock.elapsedRealtime()
        val p = pool
        // нужный fps выдержан, все потоки заняты (камера быстрее кодирования) или остановка — кадр пропускаем
        if (p == null || now - lastEnc < 1000L / c.fps - 5 || busy.get() >= (Runtime.getRuntime().availableProcessors().coerceIn(2, 4))) { img.close(); return }
        lastEnc = now
        val no = ++frameNo
        busy.incrementAndGet()
        try { p.execute { encode(img, c, no) } } catch (e: Exception) { busy.decrementAndGet(); img.close() }
    }

    /** Кадр NV21 из программного декодера (режим высокой скорости): та же очередь кодирования в JPEG, что и у кадров камеры. */
    /** Яркости кадров высокой скорости → мост (источник lum). */
    @Volatile var onLum: ((FloatArray, Int, Double) -> Unit)? = null
    private var lumN = 0; private var lumT = 0L; private var lumHz = 0
    private fun lumIn(v: FloatArray, n: Int, dt: Double) {
        onLum?.invoke(v, n, dt)
        val t = SystemClock.elapsedRealtime()
        lumN += n
        if (lumT == 0L) lumT = t
        if (t - lumT >= 3000) { lumHz = (lumN * 1000L / (t - lumT)).toInt(); lumN = 0; lumT = t; onNote?.invoke("camera: high-speed ${infoBase} · brightness $lumHz samples/s") }
    }

    /** Готовая картинка (из видеокарты, раз в ~100 мс) — в поток MJPEG. */
    private fun publish(out: ByteArray) {
        synchronized(lock) {
            if (cfg == null) return
            jpeg = out; seq++
            info = infoBase + " · brightness $lumHz/s"
            lock.notifyAll()
        }
    }

    private fun encode(img: Image?, c: Cfg, no: Long, ready: ByteArray? = null, rw: Int = 0, rh: Int = 0) {
        try {
            val w = img?.width ?: rw; val h = img?.height ?: rh
            val rot = ((sensorRot + c.rot) % 360 + 360) % 360
            val nv = Yuv.rotate(ready ?: if (img!!.format == ImageFormat.YUV_420_888) Yuv.toNv21(img) else Yuv.fromGray16(img, c.pal), w, h, rot)
            val (nw, nh) = if (rot == 90 || rot == 270) h to w else w to h
            val bos = ByteArrayOutputStream(nw * nh / 6)
            YuvImage(nv, ImageFormat.NV21, nw, nh, null).compressToJpeg(Rect(0, 0, nw, nh), c.quality, bos)
            val out = bos.toByteArray()
            synchronized(lock) {
                if (no <= shownNo || cfg == null) return                       // кадр обогнал более поздний или камеру уже остановили
                shownNo = no; jpeg = out; seq++
                val t = SystemClock.elapsedRealtime()
                if (lastPub > 0) { val dt = (t - lastPub).toDouble(); emaMs = if (emaMs == 0.0) dt else emaMs * 0.9 + dt * 0.1 }
                lastPub = t
                if (t - infoT > 1000 && emaMs > 0) { infoT = t; info = infoBase + " · " + Math.round(1000 / emaMs) + " fps" }
                if (hsRange != null && t - hsNoteT > 3000 && emaMs > 0) { hsNoteT = t; onNote?.invoke("camera: $info") }          // режим высокой скорости: размер и реальная частота — в узел телефона   // реальная частота выданных кадров
                lock.notifyAll()
            }
        } catch (e: Exception) {
            error = "encode: ${e.message}"
        } finally {
            try { img?.close() } catch (e: Exception) {}
            busy.decrementAndGet()
        }
    }
}

/** YUV_420_888 → NV21 и поворот NV21 по часовой стрелке (чётные размеры). */
object Yuv {
    /** Y16 / DEPTH16: 16-битные отсчёты (little-endian) → NV21 по автоконтрасту; у DEPTH16 берутся 13 бит дальности, старшие 3 — достоверность. */
    fun fromGray16(img: Image, pal: String): ByteArray {
        val w = img.width; val h = img.height
        val p = img.planes[0]; val b = p.buffer
        val vals = IntArray(w * h)
        val depth = img.format == ImageFormat.DEPTH16
        for (y in 0 until h) for (x in 0 until w) {
            val o = y * p.rowStride + x * 2
            val v = (b.get(o).toInt() and 255) or ((b.get(o + 1).toInt() and 255) shl 8)
            vals[y * w + x] = if (depth) v and 0x1fff else v
        }
        return Gray16.toNv21(vals, w, h, pal)
    }

    fun toNv21(img: Image): ByteArray {
        val w = img.width; val h = img.height
        val out = ByteArray(w * h * 3 / 2)
        val y = img.planes[0]
        if (y.rowStride == w) { y.buffer.position(0); y.buffer.get(out, 0, w * h) }         // строки подряд — одним куском
        else for (row in 0 until h) {
            y.buffer.position(row * y.rowStride)
            y.buffer.get(out, row * w, w)
        }
        val u = img.planes[1]; val v = img.planes[2]
        var o = w * h
        if (v.pixelStride == 2 && u.pixelStride == 2 && v.rowStride == w && u.rowStride == w) {            // полуплоская раскладка (VUVU…): хрома — одним куском
            v.buffer.position(0); val n = minOf(v.buffer.remaining(), w * h / 2)
            v.buffer.get(out, o, n); return out
        }
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
