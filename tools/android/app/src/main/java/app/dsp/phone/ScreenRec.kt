package app.dsp.phone

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.ConcurrentHashMap

/** Чистая логика записи экрана (без Android — проверяется на JVM). */
object ScreenArgs {
    /** Размер кадра: длинная сторона не больше maxSide (больше экрана не делаем), обе стороны чётные (требование кодека) и не меньше 2. */
    fun size(w: Int, h: Int, maxSide: Int): Pair<Int, Int> {
        val side = if (maxSide <= 0) 1280 else maxSide.coerceIn(320, 3840)
        val k = minOf(1.0, side.toDouble() / maxOf(w, h, 1))
        fun even(v: Double) = maxOf(2, (Math.round(v).toInt() / 2) * 2)          // round: 2400 · (1280/2400) в double бывает 1279,99…
        return even(w * k) to even(h * k)
    }

    fun fps(v: Int): Int = if (v <= 0) 30 else v.coerceIn(5, 60)

    /** Битрейт, бит/с: заданный в кбит/с (200 … 40000) или по размеру кадра и частоте (≈0,07 бит на пиксель). */
    fun bitrate(w: Int, h: Int, fps: Int, kbps: Int): Int =
        if (kbps > 0) kbps.coerceIn(200, 40_000) * 1000 else (w.toLong() * h * fps * 0.07).toInt().coerceIn(500_000, 20_000_000)

    fun fileName(ms: Long, zone: ZoneId): String = "screen-" + DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").format(Instant.ofEpochMilli(ms).atZone(zone)) + ".mp4"
}

/** События записи экрана в sys: screenrec.start / stop (file, why). */
object ScreenEvents {
    @Volatile var sink: Emit? = null
    fun note(ev: String, file: String, why: String? = null) {
        sink?.invoke("sys", Json.obj("src" to "\"sys\"", "ev" to Json.str("screenrec.$ev"), "t" to System.currentTimeMillis().toString(), "file" to Json.str(file), "why" to why?.let { Json.str(it) }))
    }
}

/** Ожидающие screenrec.start: id запроса → (клиент, id команды, параметры). Ответ — когда пользователь ответил на системный запрос. */
object ScreenPick {
    class P(val c: BridgeServer.Client, val id: Any?, val opts: JSONObject)
    private val pending = ConcurrentHashMap<Int, P>()
    private var seq = 0
    @Synchronized fun register(c: BridgeServer.Client, id: Any?, o: JSONObject): Int { val r = ++seq; pending[r] = P(c, id, o); return r }
    fun take(rid: Int): P? = pending.remove(rid)
}

/**
 * Запись экрана: screenrec.start {fps, maxSide, kbps, audio} → системное согласие (MediaProjection) → служба ScreenRecService пишет mp4 в папку записей
 * (рядом с rec.*: rec.list, rec.export, rec.delete). screenrec.stop / screenrec.status. Согласие нужно на каждую запись (с Android 14 — обязательно каждый раз).
 * Звук — только микрофон, если audio и разрешён; звук самих приложений (AudioPlaybackCapture) не пишется. Только страница приложения.
 */
class ScreenRecHub(private val ctx: Context, private val recDir: () -> File) {
    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        if (!c.trusted) return Reply.done(c, id, cmd, "only the page of the DSP app may use it", "forbidden")
        when (cmd) {
            "screenrec.start" -> {
                if (ScreenRecService.current != null) return Reply.done(c, id, cmd, "already recording — screenrec.stop first", "state")
                val rid = ScreenPick.register(c, id, j)
                val i = Intent(ctx, ScreenConsentActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(ScreenConsentActivity.EXTRA, rid)
                val pi = PendingIntent.getActivity(ctx, 6, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTE_ID,
                    Notification.Builder(ctx, BridgeService.CH_PERM).setSmallIcon(android.R.drawable.ic_menu_compass).setContentTitle("DSP: screen recording")
                        .setContentText("Tap to allow recording the screen").setContentIntent(pi).setAutoCancel(true).build())
                try { ctx.startActivity(i) } catch (e: Exception) { /* из фона нельзя — останется уведомление */ }
                // ответ придёт, когда согласие дано / отказано
            }
            "screenrec.stop" -> {
                val s = ScreenRecService.current ?: return Reply.done(c, id, cmd, "not recording", "state")
                val file = s.stopRec("stopped by the page")
                Reply.done(c, id, cmd, null, extra = arrayOf("file" to Json.str(file)))
            }
            "screenrec.status" -> {
                val s = ScreenRecService.current
                c.send(Json.rows(listOf(Json.obj("src" to "\"screenrec\"", "on" to (s != null).toString(), "file" to Json.str(s?.fileName ?: ""),
                    "sec" to (s?.seconds() ?: 0).toString(), "w" to (s?.w ?: 0).toString(), "h" to (s?.h ?: 0).toString(), "dir" to Json.str(recDir().absolutePath)))))
                Reply.done(c, id, cmd, null)
            }
            else -> Reply.done(c, id, cmd, "unknown screen recording command", "args")
        }
    }

    /** Согласие получено (ScreenConsentActivity): запустить службу записи и ответить на screenrec.start. */
    fun consented(rid: Int, resultCode: Int, data: Intent?) {
        val p = ScreenPick.take(rid) ?: return
        val cmd = "screenrec.start"
        if (resultCode != Activity.RESULT_OK || data == null) return Reply.done(p.c, p.id, cmd, "the screen recording was not allowed", "cancelled")
        val o = p.opts
        val i = Intent(ctx, ScreenRecService::class.java).putExtra("rc", resultCode).putExtra("data", data)
            .putExtra("fps", o.optInt("fps")).putExtra("maxSide", o.optInt("maxSide")).putExtra("kbps", o.optInt("kbps")).putExtra("audio", o.optBoolean("audio", false))
            .putExtra("dir", recDir().absolutePath)
        ScreenRecService.onStarted = { file, w, h, err ->
            if (err != null) Reply.done(p.c, p.id, cmd, err, "error") else Reply.done(p.c, p.id, cmd, null, extra = arrayOf("file" to Json.str(file), "w" to w.toString(), "h" to h.toString()))
        }
        try { ctx.startForegroundService(i) } catch (e: Exception) { Reply.done(p.c, p.id, cmd, e.message ?: "cannot start the recording service", "error") }
    }

    companion object { const val NOTE_ID = 7315 }
}

/** Прозрачное окно системного запроса MediaProjection. */
class ScreenConsentActivity : Activity() {
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(ScreenRecHub.NOTE_ID)
        try { startActivityForResult((getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager).createScreenCaptureIntent(), 1) }
        catch (e: Exception) { BridgeService.screenConsent(intent.getIntExtra(EXTRA, 0), RESULT_CANCELED, null); finish() }
    }

    override fun onActivityResult(code: Int, res: Int, data: Intent?) {
        BridgeService.screenConsent(intent.getIntExtra(EXTRA, 0), res, data)
        finish()
    }

    companion object { const val EXTRA = "rid" }
}

/** Служба записи: foreground типа mediaProjection → MediaProjection → VirtualDisplay → MediaRecorder (mp4, H.264, AAC с микрофона по желанию). */
class ScreenRecService : Service() {
    private val ui = Handler(Looper.getMainLooper())
    private var mp: MediaProjection? = null
    private var vd: VirtualDisplay? = null
    private var rec: MediaRecorder? = null
    private var file: File? = null
    private var t0 = 0L
    @Volatile var fileName = ""; @Volatile var w = 0; @Volatile var h = 0

    override fun onBind(i: Intent?): IBinder? = null

    fun seconds(): Long = if (t0 == 0L) 0 else (System.currentTimeMillis() - t0) / 1000

    override fun onStartCommand(i: Intent?, flags: Int, startId: Int): Int {
        if (i?.action == ACT_STOP) { stopRec("stopped from the notification"); return START_NOT_STICKY }
        if (i == null) { stopSelf(); return START_NOT_STICKY }
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH, "Screen recording", NotificationManager.IMPORTANCE_LOW))
        val stop = PendingIntent.getService(this, 8, Intent(this, ScreenRecService::class.java).setAction(ACT_STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = Notification.Builder(this, CH).setSmallIcon(android.R.drawable.ic_menu_camera).setContentTitle("DSP: recording the screen").setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build()).build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION) else startForeground(ID, n)
        current = this
        try { begin(i) } catch (e: Exception) {
            val msg = e.message ?: e.javaClass.simpleName
            cleanup(false); onStarted?.invoke("", 0, 0, "cannot record the screen: $msg"); onStarted = null
            current = null; stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
        }
        return START_NOT_STICKY
    }

    @Suppress("DEPRECATION")
    private fun begin(i: Intent) {
        val rc = i.getIntExtra("rc", 0); val data: Intent = (if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra("data", Intent::class.java) else i.getParcelableExtra<Intent>("data")) ?: throw IllegalStateException("no consent")
        val m = resources.displayMetrics
        val (sw, sh) = ScreenArgs.size(m.widthPixels, m.heightPixels, i.getIntExtra("maxSide", 0)); w = sw; h = sh
        val fps = ScreenArgs.fps(i.getIntExtra("fps", 0)); val bps = ScreenArgs.bitrate(sw, sh, fps, i.getIntExtra("kbps", 0))
        val dir = File(i.getStringExtra("dir") ?: filesDir.absolutePath).also { it.mkdirs() }
        val f = File(dir, ScreenArgs.fileName(System.currentTimeMillis(), ZoneId.systemDefault())); file = f; fileName = f.name
        val withAudio = i.getBooleanExtra("audio", false) && granted(android.Manifest.permission.RECORD_AUDIO)
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(this) else MediaRecorder()
        rec = r
        if (withAudio) r.setAudioSource(MediaRecorder.AudioSource.MIC)
        r.setVideoSource(MediaRecorder.VideoSource.SURFACE)
        r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4); r.setOutputFile(f.absolutePath)
        r.setVideoEncoder(MediaRecorder.VideoEncoder.H264); if (withAudio) r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        r.setVideoSize(sw, sh); r.setVideoFrameRate(fps); r.setVideoEncodingBitRate(bps)
        r.prepare()
        val proj = (getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager).getMediaProjection(rc, data); mp = proj
        proj.registerCallback(object : MediaProjection.Callback() { override fun onStop() { ui.post { stopRec("the system stopped the projection") } } }, ui)     // обязательно до createVirtualDisplay (Android 14)
        vd = proj.createVirtualDisplay("dsp-screen", sw, sh, m.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, null)
        r.start(); t0 = System.currentTimeMillis()
        ScreenEvents.note("start", fileName)
        onStarted?.invoke(fileName, sw, sh, null); onStarted = null
    }

    /** Остановить запись; возвращает имя файла (или пусто, если кадров не было и файл удалён). */
    @Synchronized
    fun stopRec(why: String): String {
        val name = fileName
        val ok = cleanup(true)
        ScreenEvents.note("stop", if (ok) name else "", why)
        current = null; t0 = 0
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
        return if (ok) name else ""
    }

    /** Закрыть рекордер, дисплей и проекцию. true — файл получился. */
    private fun cleanup(finalize: Boolean): Boolean {
        var ok = finalize && rec != null && t0 != 0L
        try { if (finalize && t0 != 0L) rec?.stop() } catch (e: RuntimeException) { ok = false }            // stop() бросает, если не было ни кадра
        try { rec?.release() } catch (e: Exception) { }; rec = null
        try { vd?.release() } catch (e: Exception) { }; vd = null
        try { mp?.stop() } catch (e: Exception) { }; mp = null
        if (!ok) try { file?.delete() } catch (e: Exception) { }
        return ok
    }

    override fun onDestroy() { if (current === this) { cleanup(true); current = null }; super.onDestroy() }

    companion object {
        private const val CH = "dsp_screen"
        private const val ID = 7316
        const val ACT_STOP = "app.dsp.phone.SCREEN_STOP"
        @Volatile var current: ScreenRecService? = null
        @Volatile var onStarted: ((String, Int, Int, String?) -> Unit)? = null
    }
}
