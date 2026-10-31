package app.dsp.phone

import android.app.Activity
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.Typeface
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.time.ZoneId

/**
 * Будильник. Время ставит система (AlarmManager.setAlarmClock: срабатывает в Doze и без запущенного моста, значок будильника в строке
 * состояния), звук играет AlarmService (поток alarm): интернет-радио → если не загрузилось за loadSec секунд, оборвалось или нет сети —
 * образец (файл / content:// / адрес) → системный рингтон будильника → встроенные «бипы». Кнопки «отложить / выключить» — в уведомлении и
 * на экране блокировки (AlarmActivity). События уходят в источник sys (если мост запущен): alarm.fire / fallback / play / snooze / dismiss.
 * Команды страницы: alarm.set / remove / list / stop / snooze / test. Расчёт времени — AlarmCalc (проверяется на JVM).
 */
data class Alarm(
    val id: String, val hour: Int, val minute: Int, val days: Int, val label: String = "", val url: String = "", val sample: String = "default",
    val vol: Int = -1, val ramp: Int = 20, val loadSec: Int = 12, val snoozeMin: Int = 9, val maxMin: Int = 15, val enabled: Boolean = true, val at: Long = 0,
) {
    fun timeText() = "%02d:%02d".format(hour, minute)
    fun toJson() = JSONObject().put("id", id).put("h", hour).put("m", minute).put("days", days).put("label", label).put("url", url).put("sample", sample)
        .put("vol", vol).put("ramp", ramp).put("load", loadSec).put("snooze", snoozeMin).put("max", maxMin).put("on", enabled).put("at", at)
    companion object {
        fun from(j: JSONObject) = Alarm(j.getString("id"), j.getInt("h"), j.getInt("m"), j.optInt("days"), j.optString("label"), j.optString("url"), j.optString("sample", "default"),
            j.optInt("vol", -1), j.optInt("ramp", 20), j.optInt("load", 12), j.optInt("snooze", 9), j.optInt("max", 15), j.optBoolean("on", true), j.optLong("at"))
    }
}

object Alarms {
    const val ACT_FIRE = "app.dsp.phone.ALARM_FIRE"
    const val CH = "dsp_alarm"
    @Volatile var sink: Emit? = null

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("alarms", Context.MODE_PRIVATE)
    /** Список из хранилища; повреждённая запись пропускается, а не обнуляет весь список (иначе живые будильники «пропадали» бы из списка, оставаясь в системе). */
    fun all(ctx: Context): List<Alarm> = try {
        val a = JSONArray(prefs(ctx).getString("list", "[]"))
        (0 until a.length()).mapNotNull { try { Alarm.from(a.getJSONObject(it)) } catch (e: Exception) { null } }
    } catch (e: Exception) { emptyList() }
    fun get(ctx: Context, id: String) = all(ctx).firstOrNull { it.id == id }
    @Synchronized fun put(ctx: Context, a: Alarm) {
        val l = all(ctx).filter { it.id != a.id } + a
        prefs(ctx).edit().putString("list", JSONArray(l.map { it.toJson() }).toString()).apply()
    }
    @Synchronized fun drop(ctx: Context, id: String) {
        prefs(ctx).edit().putString("list", JSONArray(all(ctx).filter { it.id != id }.map { it.toJson() }).toString()).apply()
    }

    fun nextMs(a: Alarm, now: Long = System.currentTimeMillis()): Long =
        if (a.at > now) a.at else AlarmCalc.nextMs(now, ZoneId.systemDefault(), a.hour, a.minute, a.days)

    private fun firePi(ctx: Context, id: String): PendingIntent =
        PendingIntent.getBroadcast(ctx, id.hashCode(), Intent(ctx, AlarmReceiver::class.java).setAction(ACT_FIRE).putExtra("id", id), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    fun schedule(ctx: Context, a: Alarm) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        if (!a.enabled) { am.cancel(firePi(ctx, a.id)); return }
        val show = PendingIntent.getActivity(ctx, 1, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        am.setAlarmClock(AlarmManager.AlarmClockInfo(nextMs(a), show), firePi(ctx, a.id))
    }
    fun cancel(ctx: Context, id: String) { (ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(firePi(ctx, id)) }
    fun rescheduleAll(ctx: Context) { for (a in all(ctx)) try { schedule(ctx, a) } catch (e: Exception) { } }

    fun event(ev: String, a: Alarm?, vararg kv: Pair<String, String?>) {
        sink?.invoke("sys", Json.obj("src" to "\"sys\"", "ev" to Json.str("alarm.$ev"), "t" to System.currentTimeMillis().toString(),
            "id" to Json.str(a?.id ?: ""), "label" to Json.str(a?.label ?: ""), *kv))
    }

    fun ensureChannel(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CH) == null) nm.createNotificationChannel(NotificationChannel(CH, "Alarm", NotificationManager.IMPORTANCE_HIGH).apply { setSound(null, null); enableVibration(false) })
    }

    fun online(ctx: Context): Boolean {
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        val c = cm.getNetworkCapabilities(cm.activeNetwork ?: return false) ?: return false
        return c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    /** Запуск звука сейчас (кнопка «test» или сработавший будильник). */
    fun ring(ctx: Context, a: Alarm) {
        ctx.startForegroundService(Intent(ctx, AlarmService::class.java).setAction(ACT_FIRE).putExtra("alarm", a.toJson().toString()))
    }
    fun control(ctx: Context, what: String) { ctx.startService(Intent(ctx, AlarmService::class.java).setAction(what)) }
}

/** Срабатывание, перезагрузка, смена времени / пояса, обновление приложения. */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, i: Intent) {
        if (i.action != Alarms.ACT_FIRE) return
        val a = Alarms.get(ctx, i.getStringExtra("id") ?: return) ?: return
        // следующий запуск ставим сразу: если звук не стартует, повтор всё равно останется в расписании
        if (a.days != 0) { val n = a.copy(at = 0); Alarms.put(ctx, n); Alarms.schedule(ctx, n) }
        else Alarms.put(ctx, a.copy(at = 0, enabled = false))
        Alarms.ring(ctx, a)
    }
}

class AlarmService : Service() {
    private val h = Handler(Looper.getMainLooper())
    private var mp: MediaPlayer? = null
    private var alarm: Alarm? = null
    private var gen = 0
    private var queue = ArrayList<Pair<String, String>>()
    private var wake: PowerManager.WakeLock? = null
    private var focus: AudioFocusRequest? = null
    private var prevVol = -1
    private var ramp: Runnable? = null
    private var stuck: Runnable? = null
    private var stop: Runnable? = null

    override fun onBind(i: Intent?): IBinder? = null

    override fun onStartCommand(i: Intent?, flags: Int, startId: Int): Int {
        when (i?.action) {
            Alarms.ACT_FIRE -> fire(Alarm.from(JSONObject(i.getStringExtra("alarm") ?: return START_NOT_STICKY)))
            "snooze" -> finish("snooze")
            "dismiss" -> finish("dismiss")
        }
        return START_NOT_STICKY
    }

    private fun fire(a: Alarm) {
        finish(null)                                              // новый звонок вытесняет прежний
        alarm = a; current = this; info = a
        Alarms.ensureChannel(this)
        val open = PendingIntent.getActivity(this, 2, Intent(this, AlarmActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        fun act(w: String, label: String) = Notification.Action.Builder(null, label,
            PendingIntent.getService(this, w.hashCode(), Intent(this, AlarmService::class.java).setAction(w), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build()
        val n = Notification.Builder(this, Alarms.CH).setSmallIcon(android.R.drawable.ic_lock_idle_alarm).setContentTitle(a.label.ifEmpty { "Alarm" }).setContentText(a.timeText())
            .setCategory(Notification.CATEGORY_ALARM).setOngoing(true).setContentIntent(open).setFullScreenIntent(open, true)
            .addAction(act("snooze", "Snooze ${a.snoozeMin} min")).addAction(act("dismiss", "Dismiss")).build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(77, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK) else startForeground(77, n)
        wake = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dsp:alarm").apply { acquire(a.maxMin.coerceIn(1, 60) * 60_000L + 30_000) }
        val am = getSystemService(AudioManager::class.java)
        if (a.vol >= 0) { prevVol = am.getStreamVolume(AudioManager.STREAM_ALARM); am.setStreamVolume(AudioManager.STREAM_ALARM, Math.round(a.vol / 100f * am.getStreamMaxVolume(AudioManager.STREAM_ALARM)), 0) }
        focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE).setAudioAttributes(attrs(true)).build().also { am.requestAudioFocus(it) }
        queue.clear()
        if (a.url.isNotBlank() && Alarms.online(this)) queue.add("stream" to a.url.trim())
        else if (a.url.isNotBlank()) Alarms.event("fallback", a, "why" to Json.str("no network"))
        if (a.sample.isNotBlank() && a.sample != "default" && a.sample != "beep") queue.add("sample" to a.sample.trim())
        if (a.sample != "beep") queue.add("ringtone" to "")
        queue.add("beep" to "")
        Alarms.event("fire", a)
        stop = Runnable { finish("dismiss", "auto-stop") }; h.postDelayed(stop!!, a.maxMin.coerceIn(1, 60) * 60_000L)
        next(null)
    }

    private fun attrs(stream: Boolean) = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM)
        .setContentType(if (stream) AudioAttributes.CONTENT_TYPE_MUSIC else AudioAttributes.CONTENT_TYPE_SONIFICATION).build()

    /** Следующий источник из очереди; why — почему отказались от предыдущего. */
    private fun next(why: String?) {
        val a = alarm ?: return
        releasePlayer()
        val (kind, src) = queue.removeFirstOrNull() ?: run { Alarms.event("silent", a, "why" to Json.str(why ?: "no source")); return }
        if (why != null) Alarms.event("fallback", a, "why" to Json.str(why), "to" to Json.str(kind))
        val my = ++gen
        fun bad(w: String) { if (my == gen) h.post { if (my == gen) next(w) } }
        try {
            val m = MediaPlayer(); mp = m
            m.setAudioAttributes(attrs(kind == "stream")); m.setWakeMode(this, PowerManager.PARTIAL_WAKE_LOCK)
            m.setOnErrorListener { _, w, e -> bad("$kind error $w/$e"); true }
            m.setOnCompletionListener { if (kind == "stream") bad("stream ended") else try { m.start() } catch (e: Exception) { } }
            m.setOnInfoListener { _, what, _ ->
                if (kind == "stream" && what == MediaPlayer.MEDIA_INFO_BUFFERING_START) { stuck = Runnable { bad("stream stalled") }; h.postDelayed(stuck!!, 12_000) }
                else if (what == MediaPlayer.MEDIA_INFO_BUFFERING_END) { stuck?.let { h.removeCallbacks(it) }; stuck = null }
                false
            }
            m.setOnPreparedListener {
                if (my != gen) return@setOnPreparedListener
                h.removeCallbacksAndMessages(TOKEN)
                it.isLooping = kind != "stream"
                val rampMs = a.ramp.coerceIn(0, 300) * 1000L
                it.setVolume(if (rampMs > 0) 0f else 1f, if (rampMs > 0) 0f else 1f); it.start()
                if (rampMs > 0) { val t0 = System.currentTimeMillis(); ramp = object : Runnable { override fun run() {
                    val v = ((System.currentTimeMillis() - t0).toFloat() / rampMs).coerceIn(0f, 1f); try { mp?.setVolume(v, v) } catch (e: Exception) { }
                    if (v < 1f) h.postDelayed(this, 400) } }; h.post(ramp!!) }
                Alarms.event("play", a, "kind" to Json.str(kind), "src" to Json.str(src))
            }
            val limit = if (kind == "stream") a.loadSec.coerceIn(3, 60) * 1000L else 6000L
            h.postAtTime({ bad("$kind: not loaded in ${limit / 1000} s") }, TOKEN, android.os.SystemClock.uptimeMillis() + limit)
            when (kind) {
                "stream" -> Thread {
                    try {
                        val u = resolve(src)
                        h.post { if (my == gen) try { m.setDataSource(u); m.prepareAsync() } catch (e: Exception) { bad("stream: ${e.message}") } }
                    } catch (e: Exception) { bad("stream: ${e.message}") }
                }.start()
                "sample" -> { m.setDataSource(this, if (src.contains("://")) Uri.parse(src) else Uri.fromFile(File(src))); m.prepareAsync() }
                "ringtone" -> { m.setDataSource(this, RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_ALARM) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)); m.prepareAsync() }
                else -> { val f = File(cacheDir, "alarm-beep.wav"); if (!f.exists()) f.writeBytes(AlarmCalc.beepWav()); m.setDataSource(f.absolutePath); m.prepareAsync() }
            }
        } catch (e: Exception) { bad("$kind: ${e.message}") }
    }

    /** Адрес потока: .pls / .m3u (не HLS) раскрываются до первого http-адреса, остальное — как есть. */
    private fun resolve(url: String): String {
        val low = url.substringBefore('?').lowercase()
        if (!(low.endsWith(".pls") || low.endsWith(".m3u"))) return url
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 4000; c.readTimeout = 4000
        try { return AlarmCalc.streamFromPlaylist(url, c.inputStream.use { ins -> val buf = ByteArray(8192); var n = 0; while (n < buf.size) { val r = ins.read(buf, n, buf.size - n); if (r <= 0) break; n += r }; String(buf, 0, n) }) } finally { c.disconnect() }
    }

    private fun releasePlayer() {
        h.removeCallbacksAndMessages(TOKEN)
        ramp?.let { h.removeCallbacks(it) }; ramp = null; stuck?.let { h.removeCallbacks(it) }; stuck = null
        try { mp?.release() } catch (e: Exception) { }
        mp = null; gen++
    }

    /** ev: snooze / dismiss; null — тихая остановка перед новым звонком. */
    private fun finish(ev: String?, why: String? = null) {
        val a = alarm ?: run { if (ev != null) { current = null; stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }; return }   // звонка уже нет (повторное «выключить» / служба перезапущена) — не висеть вхолостую
        releasePlayer(); stop?.let { h.removeCallbacks(it) }; stop = null
        val am = getSystemService(AudioManager::class.java)
        focus?.let { am.abandonAudioFocusRequest(it) }; focus = null
        if (prevVol >= 0) { try { am.setStreamVolume(AudioManager.STREAM_ALARM, prevVol, 0) } catch (e: Exception) { }; prevVol = -1 }
        try { if (wake?.isHeld == true) wake?.release() } catch (e: Exception) { }
        alarm = null
        if (ev == null) return
        if (ev == "snooze") Alarms.get(this, a.id)?.let { val s = it.copy(at = System.currentTimeMillis() + a.snoozeMin.coerceIn(1, 120) * 60_000L, enabled = true); Alarms.put(this, s); Alarms.schedule(this, s) }
        Alarms.event(ev, a, *(if (why != null) arrayOf("why" to Json.str(why)) else emptyArray()))
        current = null; listener?.invoke()
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    }

    override fun onDestroy() { releasePlayer(); try { if (wake?.isHeld == true) wake?.release() } catch (e: Exception) { }; if (current === this) current = null; super.onDestroy() }

    companion object {
        private val TOKEN = Any()
        @Volatile var current: AlarmService? = null
        @Volatile var info: Alarm? = null
        @Volatile var listener: (() -> Unit)? = null
    }
}

/** Экран поверх блокировки: время, название, «отложить» и «выключить». */
class AlarmActivity : Activity() {
    override fun onCreate(b: android.os.Bundle?) {
        super.onCreate(b)
        @Suppress("DEPRECATION") window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD)
        val a = AlarmService.info
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setBackgroundColor(Color.BLACK); setPadding(48, 48, 48, 48) }
        fun tv(t: String, sp: Float, bold: Boolean = false) = TextView(this).apply { text = t; textSize = sp; setTextColor(Color.WHITE); gravity = Gravity.CENTER; if (bold) setTypeface(null, Typeface.BOLD) }
        val cur = AlarmService.current
        col.addView(tv(java.text.SimpleDateFormat("HH:mm").format(java.util.Date()), 72f, true))
        col.addView(tv(a?.label?.takeIf { it.isNotEmpty() } ?: "Alarm", 22f))
        fun btn(t: String, w: String) = Button(this).apply { text = t; textSize = 20f; setOnClickListener { Alarms.control(this@AlarmActivity, w); finish() } }
        col.addView(btn("Snooze", "snooze"), LinearLayout.LayoutParams(-1, 220).apply { topMargin = 96 })
        col.addView(btn("Dismiss", "dismiss"), LinearLayout.LayoutParams(-1, 220).apply { topMargin = 32 })
        setContentView(col)
        AlarmService.listener = { runOnUiThread { finish() } }
        if (cur == null) finish()
    }
    override fun onDestroy() { AlarmService.listener = null; super.onDestroy() }
}

/** Команды страницы: alarm.set / remove / list / stop / snooze / test. */
class AlarmCmds(private val ctx: Context) {
    private fun int(j: JSONObject, k: String, def: Int, lo: Int, hi: Int) = if (j.has(k)) j.optInt(k, def).coerceIn(lo, hi) else def

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        fun bad(m: String) = Reply.done(c, id, cmd, m, "args")
        when (cmd) {
            "alarm.set" -> {
                val old = j.optString("name").takeIf { it.isNotBlank() }?.let { Alarms.get(ctx, it) }
                if (old == null && !j.has("time") && j.optString("name").isNotBlank()) return bad("no such alarm: ${j.optString("name")} (refresh the list)")      // переключатель строки, которой в телефоне уже нет
                val (h, m) = AlarmCalc.time(j.optString("time", old?.timeText())) ?: return bad("time: HH:MM")
                val days = if (j.has("days")) AlarmCalc.days(j.optString("days")) ?: return bad("days: mon,tue… / weekdays / weekend / daily / empty (once)") else old?.days ?: 0
                val name = j.optString("name").trim().ifEmpty { "a%02d%02d".format(h, m) }.take(40)
                val url = j.optString("url", old?.url ?: "").trim()
                if (url.isNotEmpty() && !Regex("https?://.+", RegexOption.IGNORE_CASE).matches(url)) return bad("url: http(s):// address of the radio stream")
                val a = Alarm(name, h, m, days, j.optString("label", old?.label ?: "").take(80), url, j.optString("sample", old?.sample ?: "default").trim().ifEmpty { "default" },
                    int(j, "vol", old?.vol ?: -1, -1, 100), int(j, "ramp", old?.ramp ?: 20, 0, 300), int(j, "loadSec", old?.loadSec ?: 12, 3, 60),
                    int(j, "snoozeMin", old?.snoozeMin ?: 9, 1, 120), int(j, "maxMin", old?.maxMin ?: 15, 1, 60), j.optBoolean("enabled", true), 0)
                Alarms.put(ctx, a)
                try { Alarms.schedule(ctx, a) } catch (e: SecurityException) { return Reply.done(c, id, cmd, "the system refused to schedule: ${e.message}", "permission") }
                Alarms.event("set", a, "next" to Alarms.nextMs(a).toString())
                Reply.done(c, id, cmd, null, extra = arrayOf("name" to Json.str(a.id), "next" to Alarms.nextMs(a).toString()))
            }
            "alarm.remove" -> {
                val name = j.optString("name")
                if (name == "all" || name.isEmpty() && j.optBoolean("all")) { for (a in Alarms.all(ctx)) { Alarms.cancel(ctx, a.id); Alarms.drop(ctx, a.id) } }
                else {                                                      // удаление идемпотентно: нет такого — всё равно снять возможный остаток в системе
                    if (name.isBlank()) return bad("name: the alarm to remove (or all)")
                    val had = Alarms.get(ctx, name) != null
                    Alarms.cancel(ctx, name); Alarms.drop(ctx, name)
                    if (!had) return Reply.done(c, id, cmd, null, extra = arrayOf("existed" to "false"))
                }
                Reply.done(c, id, cmd, null)
            }
            "alarm.list" -> {
                val rows = Alarms.all(ctx).map { a -> Json.obj("src" to "\"alarm\"", "name" to Json.str(a.id), "time" to Json.str(a.timeText()), "days" to Json.str(AlarmCalc.daysText(a.days)), "label" to Json.str(a.label),
                    "url" to Json.str(a.url), "sample" to Json.str(a.sample), "enabled" to a.enabled.toString(), "next" to if (a.enabled) Alarms.nextMs(a).toString() else "0") }
                if (rows.isNotEmpty()) c.send(Json.rows(rows))
                Reply.done(c, id, cmd, null, extra = arrayOf("n" to rows.size.toString()))
            }
            "alarm.stop" -> { Alarms.control(ctx, "dismiss"); Reply.done(c, id, cmd, null) }
            "alarm.snooze" -> { Alarms.control(ctx, "snooze"); Reply.done(c, id, cmd, null) }
            "alarm.test" -> {
                val base = j.optString("name").takeIf { it.isNotBlank() }?.let { Alarms.get(ctx, it) }
                    ?: Alarm("test", 0, 0, 0, "Test", j.optString("url"), j.optString("sample", "default").ifEmpty { "default" }, int(j, "vol", -1, -1, 100), int(j, "ramp", 3, 0, 300), int(j, "loadSec", 12, 3, 60), 1, 2)
                Alarms.ring(ctx, base); Reply.done(c, id, cmd, null)
            }
            else -> bad("unknown alarm command")
        }
    }
}
