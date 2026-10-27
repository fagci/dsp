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
    private lateinit var ble: BleHub
    private lateinit var bt: BtHub
    private lateinit var gnss: GnssHub
    private lateinit var cell: CellHub
    private lateinit var mic: MicHub
    private lateinit var sniffer: SnifferHub
    private lateinit var usb: AndroidUsb
    private lateinit var actions: PhoneActions
    private val asked = HashSet<String>()      // разрешения, о которых уже спросили в этой жизни сервиса
    private var wake: PowerManager.WakeLock? = null
    private val main = Handler(Looper.getMainLooper())
    private val warned = HashSet<String>()
    private var shownText = ""
    @Volatile private var serverError: String? = null
    @Volatile private var destroyed = false      // после остановки хвосты (обрыв клиентов, колбэки камеры) не должны ничего включать и перепубликовать уведомление

    override fun onCreate() {
        super.onCreate()
        cfg = Config(this)
        camera = CameraHub(this) { main.post { refresh() } }
        server = BridgeServer(cfg, camera, ::helloJson, ::statusText) { refresh() }
        usb = AndroidUsb(this)
        server.usb = usb
        actions = PhoneActions(this, { s, j -> server.emit(s, j) }, { p -> main.post { requestPerms(p) } }, { camera.describe() }, cfg)
        server.onCommand = { c, j -> actions.exec(c, j) }
        sensors = SensorHub(this) { s, j -> server.emit(s, j) }
        gps = GpsHub(this) { s, j -> server.emit(s, j) }
        wifi = WifiHub(this, gps) { s, j -> server.emit(s, j) }
        battery = BatteryHub(this) { s, j -> server.emit(s, j) }
        ble = BleHub(this, gps) { s, j -> server.emit(s, j) }
        bt = BtHub(this, gps) { s, j -> server.emit(s, j) }
        gnss = GnssHub(this) { s, j -> server.emit(s, j) }
        cell = CellHub(this, gps) { s, j -> server.emit(s, j) }
        mic = MicHub(this) { s, j -> server.emit(s, j) }
        sniffer = SnifferHub(cfg, { s, j -> server.emit(s, j) }) { l, m -> server.note(l, m) }
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel(CH, "DSP bridge", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(CH_PERM, "Permissions", NotificationManager.IMPORTANCE_HIGH))
    }

    override fun onStartCommand(i: Intent?, flags: Int, id: Int): Int {
        if (i?.action == ACTION_STOP) { shutdown(); return START_NOT_STICKY }
        goForeground()
        if (i?.action == ACTION_RELOAD || !server.listening) serverError = server.start()
        refresh()
        return START_STICKY
    }

    override fun onBind(i: Intent?): IBinder? = null

    /** Остановка по кнопке: снять уведомление и остановить сервис. */
    private fun shutdown() {
        destroyed = true
        stopForeground(STOP_FOREGROUND_REMOVE)
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(ID)
        stopSelf()
    }

    override fun onDestroy() {
        destroyed = true
        server.stop(); camera.stop()
        sensors.close(); gps.close(); wifi.close(); battery.close(); ble.close(); bt.close(); gnss.close(); cell.close(); mic.close(); sniffer.close(); usb.close(); actions.close()
        wake?.takeIf { it.isHeld }?.release()
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(ID)
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
        if (Build.VERSION.SDK_INT >= 30 && granted(android.Manifest.permission.RECORD_AUDIO)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
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
        if (destroyed) return
        val w = server.wanted()
        val problems = HashSet<String>()
        for (k in sensors.update(w.subs.filter { it in SensorHub.ALL }.toSet(), w.hz)) problems.add("$k: no such sensor on this phone")
        val needGps = w.subs.any { it in POSITION }
        if (!gps.update(needGps)) problems.add("no position: allow Location for the DSP app and turn Location on")
        if (!wifi.update("wifi" in w.subs, w.wifiEvery)) problems.add("wifi: allow Location for the DSP app (Android hides the scan without it)")
        battery.update("battery" in w.subs)
        if (!gnss.update("gnss" in w.subs, "gnssraw" in w.subs, "nmea" in w.subs)) problems.add("gnss: allow Location for the DSP app")
        if (!ble.update("ble" in w.subs)) problems.add(ble.lastError)
        if (!bt.update("bt" in w.subs)) problems.add(bt.lastError)
        if (!cell.update("cell" in w.subs, w.cellEvery)) problems.add(cell.lastError)
        if (!mic.update("mic" in w.subs, w.micHz)) problems.add(mic.lastError)
        if (!sniffer.update("pkt" in w.subs, w.iface, w.filter, w.snap)) problems.add(sniffer.lastError)
        if (!actions.update("sms" in w.subs)) problems.add("sms: allow SMS for the DSP app")
        askPermissions(w.subs)
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

    /**
     * Спрашивает разрешения для выбранных на странице источников (один раз на разрешение за жизнь сервиса).
     * Окно открывается сразу, если приложение на экране, иначе — по нажатию на уведомление (из фона Android окно не откроет).
     */
    private fun askPermissions(subs: Set<String>) {
        val miss = Perms.forSubs(subs, Build.VERSION.SDK_INT, camera.viewers > 0).filter { !granted(it) && asked.add(it) }
        if (miss.isNotEmpty()) requestPerms(miss)
    }

    /** Окно запроса (если приложение на экране) и уведомление «Tap to allow». Команды страницы (SMS, контакты, уведомления) просят так же. */
    private fun requestPerms(miss: List<String>) {
        if (miss.isEmpty()) return
        val i = Intent(this, PermissionActivity::class.java).putExtra(PermissionActivity.EXTRA, miss.toTypedArray()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pi = PendingIntent.getActivity(this, 3, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val names = miss.map { it.substringAfterLast('.').lowercase().replace('_', ' ') }.joinToString(", ")
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(PERM_ID,
            Notification.Builder(this, CH_PERM).setSmallIcon(android.R.drawable.ic_menu_compass)
                .setContentTitle("DSP bridge needs permission").setContentText("Tap to allow: $names")
                .setContentIntent(pi).setAutoCancel(true).build())
        try { startActivity(i) } catch (e: Exception) { /* из фона нельзя — останется уведомление */ }
    }

    private fun arr(l: List<String>) = l.joinToString(",", "[", "]") { "\"$it\"" }

    private fun helloJson(): String {
        val sens = sensors.available()
        return Json.obj(
            "src" to "\"bridge\"", "level" to "\"hello\"", "ver" to "1", "app" to "\"dsp-android\"", "host" to Json.str(Build.MODEL),
            "sources" to arr(listOf("gps", "battery", "wifi", "gnss", "gnssraw", "nmea", "cell", "mic", "sms", "notify", "torch") + (if (cfg.sniffer) listOf("pkt") else emptyList()) + (if (hasBluetooth()) listOf("ble", "bt") else emptyList()) + sens), "sensors" to arr(sens), "sensorInfo" to sensors.info(), "cameras" to arr(camera.available()),
            "cameraInfo" to camera.describe(), "phone" to actions.info(),
        )
    }

    private fun statusText(): String =
        "DSP phone bridge\n" + summary() + "\ncamera: " + (camera.info.ifEmpty { "off" }) + (if (camera.error.isNotEmpty()) " (" + camera.error + ")" else "") +
            "\nsensors: " + sensors.available().joinToString(",") + "\n" + sensors.lines() + "addresses: " + lan().joinToString(", ") + "\n"

    companion object {
        const val ACTION_STOP = "app.dsp.phone.STOP"
        const val ACTION_RELOAD = "app.dsp.phone.RELOAD"
        private const val CH = "bridge"
        private const val CH_PERM = "perm"
        private const val ID = 1
        const val PERM_ID = 2
        // источники, которым нужно включённое определение положения (ГНСС) или последнее положение в записях
        private val POSITION = setOf("gps", "wifi", "ble", "bt", "gnss", "gnssraw", "nmea", "cell")

        /** Остановить мост (то же, что кнопка Stop в уведомлении). */
        fun stop(ctx: Context) {
            ctx.startService(Intent(ctx, BridgeService::class.java).setAction(ACTION_STOP))
        }

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
