package app.dsp.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import java.net.NetworkInterface

/**
 * Foreground-сервис: держит процесс живым при погашенном экране и отдаёт датчики, GPS, Wi-Fi, батарею и камеру
 * локальным сервером (BridgeServer). Источники включаются только по подписке клиентов.
 */
class BridgeService : Service() {
    private lateinit var cfg: Config
    private lateinit var camera: CameraHub
    private lateinit var server: BridgeServer
    private lateinit var sensors: SensorHub
    private lateinit var gps: GpsHub
    private lateinit var wifi: WifiHub
    private lateinit var battery: BatteryHub
    private var wake: PowerManager.WakeLock? = null
    private val main = Handler(Looper.getMainLooper())
    private val warned = HashSet<String>()
    private var shownText = ""
    @Volatile private var serverError: String? = null

    override fun onCreate() {
        super.onCreate()
        cfg = Config(this)
        camera = CameraHub(this) { main.post { refresh() } }
        server = BridgeServer(cfg, camera, ::helloJson, ::statusText) { refresh() }
        sensors = SensorHub(this) { s, j -> server.emit(s, j) }
        gps = GpsHub(this) { s, j -> server.emit(s, j) }
        wifi = WifiHub(this, gps) { s, j -> server.emit(s, j) }
        battery = BatteryHub(this) { s, j -> server.emit(s, j) }
        val ch = NotificationChannel(CH, "DSP bridge", NotificationManager.IMPORTANCE_LOW)
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(ch)
    }

    override fun onStartCommand(i: Intent?, flags: Int, id: Int): Int {
        if (i?.action == ACTION_STOP) { stopSelf(); return START_NOT_STICKY }
        goForeground()
        if (i?.action == ACTION_RELOAD || !server.listening) serverError = server.start()
        refresh()
        return START_STICKY
    }

    override fun onBind(i: Intent?): IBinder? = null

    override fun onDestroy() {
        server.stop(); camera.stop()
        sensors.close(); gps.close(); wifi.close(); battery.close()
        wake?.takeIf { it.isHeld }?.release()
        super.onDestroy()
    }

    // ---------- foreground ----------

    private fun goForeground() {
        val n = notification()
        if (Build.VERSION.SDK_INT < 29) { startForeground(ID, n); return }
        // типы — только те, на которые есть разрешения, иначе startForeground бросит SecurityException
        var type = 0
        if (Build.VERSION.SDK_INT >= 30 && granted(android.Manifest.permission.CAMERA)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        if (hasLocation()) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        if (Build.VERSION.SDK_INT >= 34) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        try { startForeground(ID, n, type) }
        catch (e: Exception) {
            try { startForeground(ID, n, if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0) }
            catch (x: Exception) { stopSelf() }
        }
    }

    @Suppress("DEPRECATION")
    private fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val set = PendingIntent.getActivity(this, 1, Intent(this, SettingsActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 2, Intent(this, BridgeService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val text = serverError ?: summary()
        shownText = text
        return Notification.Builder(this, CH)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentTitle("DSP phone bridge")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_menu_preferences, "Settings", set)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stop)
            .build()
    }

    private fun summary(): String {
        val w = server.wanted()
        val parts = ArrayList<String>()
        parts.add((if (cfg.shareLan) "0.0.0.0" else "127.0.0.1") + ":" + cfg.port)
        parts.add("${server.clientCount} client(s)")
        if (w.subs.isNotEmpty()) parts.add(w.subs.joinToString(","))
        if (camera.viewers > 0) parts.add("camera ${camera.info}")
        return parts.joinToString(" · ")
    }

    // ---------- источники ----------

    /** Включает то, что просят клиенты, остальное гасит. Вызывается при каждой смене подписок. */
    @Synchronized
    private fun refresh() {
        val w = server.wanted()
        val problems = HashSet<String>()
        for (k in sensors.update(w.subs.filter { it in SensorHub.TYPES }.toSet(), w.hz)) problems.add("$k: no such sensor on this phone")
        val needGps = "gps" in w.subs || "wifi" in w.subs
        if (!gps.update(needGps)) problems.add("no position: allow Location for the DSP app and turn Location on")
        if (!wifi.update("wifi" in w.subs, w.wifiEvery)) problems.add("wifi: allow Location for the DSP app (Android hides the scan without it)")
        battery.update("battery" in w.subs)
        for (p in problems) if (warned.add(p)) server.note("error", p)
        warned.retainAll(problems)

        val active = w.subs.isNotEmpty() || camera.viewers > 0
        if (active && wake == null) {
            wake = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dsp:bridge")
        }
        wake?.let { if (active && !it.isHeld) it.acquire() else if (!active && it.isHeld) it.release() }

        val text = serverError ?: summary()
        if (text != shownText) (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(ID, notification())
    }

    private fun arr(l: List<String>) = l.joinToString(",", "[", "]") { "\"$it\"" }

    private fun helloJson(): String {
        val sens = sensors.available()
        return Json.obj(
            "src" to "\"bridge\"", "level" to "\"hello\"", "ver" to "1", "app" to "\"dsp-android\"", "host" to Json.str(Build.MODEL),
            "sources" to arr(listOf("gps", "battery", "wifi") + sens), "sensors" to arr(sens), "cameras" to arr(camera.available()),
        )
    }

    private fun statusText(): String =
        "DSP phone bridge\n" + summary() + "\ncamera: " + (camera.info.ifEmpty { "off" }) + (if (camera.error.isNotEmpty()) " (" + camera.error + ")" else "") +
            "\nsensors: " + sensors.available().joinToString(",") + "\naddresses: " + lan().joinToString(", ") + "\n"

    companion object {
        const val ACTION_STOP = "app.dsp.phone.STOP"
        const val ACTION_RELOAD = "app.dsp.phone.RELOAD"
        private const val CH = "bridge"
        private const val ID = 1

        fun start(ctx: Context, reload: Boolean = false) {
            val i = Intent(ctx, BridgeService::class.java)
            if (reload) i.action = ACTION_RELOAD
            ctx.startForegroundService(i)
        }

        fun lan(): List<String> = try {
            NetworkInterface.getNetworkInterfaces().toList().flatMap { it.inetAddresses.toList() }
                .filter { !it.isLoopbackAddress && it.address.size == 4 }.map { it.hostAddress ?: "" }
        } catch (e: Exception) { emptyList() }
    }
}
