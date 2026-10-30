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
    private lateinit var speech: SpeechHub
    private lateinit var gatt: GattHub
    private lateinit var btlink: BtLinkHub
    private lateinit var adv: AdvertiseHub
    private lateinit var gattsrv: GattServerHub
    private lateinit var l2cap: L2capHub
    private lateinit var wlink: WifiLinkHub
    private lateinit var monitor: MonitorHub
    private lateinit var wnet: WifiNetHub
    private lateinit var net: NetHub
    private lateinit var tlsCmds: TlsCmds
    private lateinit var sys: SysHub
    private lateinit var power: PowerHub
    private lateinit var activity: ActivityHub
    private val started = android.os.SystemClock.elapsedRealtime()
    private val asked = HashSet<String>()      // разрешения, о которых уже спросили в этой жизни сервиса
    private var wake: PowerManager.WakeLock? = null
    private val main = Handler(Looper.getMainLooper())
    private val warned = HashSet<String>()
    private var shownText = ""
    @Volatile private var serverError: String? = null
    @Volatile private var destroyed = false      // после остановки хвосты (обрыв клиентов, колбэки камеры) не должны ничего включать и перепубликовать уведомление

    override fun onCreate() {
        super.onCreate()
        inst = this; up = true
        UsbKey.init(this)
        cfg = Config(this)
        // падение приложения (не нативное): трассировка в файл, команда crash.last в Phone Actions её отдаёт
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            try { java.io.File(filesDir, CRASH_FILE).writeText("${java.util.Date()} thread ${t.name}\n" + android.util.Log.getStackTraceString(e).take(4000)) } catch (x: Exception) {}
            prev?.uncaughtException(t, e)
        }
        server = BridgeServer(cfg, ::helloJson, ::statusText) { refresh() }
        usb = AndroidUsb(this)
        server.usb = usb
        actions = PhoneActions(this, { s, j -> server.emit(s, j) }, { p -> main.post { requestPerms(p) } }, cfg)
        val needs = Needs(this) { p -> main.post { requestPerms(p) } }
        val emit: Emit = { s, j -> server.emit(s, j) }
        speech = SpeechHub(this, emit, needs); gatt = GattHub(this, emit, needs); btlink = BtLinkHub(this, emit, needs); adv = AdvertiseHub(this, needs); gattsrv = GattServerHub(this, emit, needs); l2cap = L2capHub(this, emit, needs); wlink = WifiLinkHub(this, emit, needs); monitor = MonitorHub(cfg); wnet = WifiNetHub(this, emit, needs)
        net = NetHub(this, cfg, emit); sys = SysHub(this, cfg, emit, needs); tlsCmds = TlsCmds(this, server)
        server.onCommand = { c, j -> route(c, j) }
        tlsCmds.start()                                          // сертификат уже стоит — TLS поднимется вместе с сервером
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
        power = PowerHub(this, cfg, emit, ::diagPairs) { main.post { refresh() } }
        activity = ActivityHub(this, cfg, emit)
        power.start()
        main.postDelayed(tick, TICK_MS)
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

    /** Раз в TICK_MS: поднимает сервер, если он упал (порт занят на старте, обрыв), и продлевает wake lock, пока есть подписчики. */
    private val tick = object : Runnable {
        override fun run() {
            if (destroyed) return
            if (!server.listening) { serverError = server.start(); refresh() } else renewWake()
            releaseIdle()
            activity.tick()
            if ("power" in server.wanted().subs) power.push()
            val t = serverError ?: summary()
            if (t != shownText) (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(ID, notification())
            main.postDelayed(this, TICK_MS)
        }
    }

    /** Блокировка с таймаутом: зависшая сессия не удержит процессор дольше WAKE_MS, живую продлевает tick. */
    @Synchronized
    private fun renewWake() {
        val active = server.clientCount > 0 && server.wanted().subs.isNotEmpty()
        if (active && wake == null) wake = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dsp:bridge").also { it.setReferenceCounted(false) }
        wake?.let { if (active) it.acquire(WAKE_MS) else if (it.isHeld) it.release() }
    }

    /** Что остаётся открытым независимо от подписок: соединения, слушатели, реклама — может тратить заряд при нуле клиентов. */
    private fun holds(): List<String> {
        val l = ArrayList<String>()
        fun add(name: String, n: Int) { if (n > 0) l.add(if (n > 1) "$name×$n" else name) }
        add("gatt", gatt.held()); add("rfcomm", btlink.held()); add("advertising", adv.held()); add("gatt server", gattsrv.held()); add("l2cap", l2cap.held()); add("nsd / aware", wlink.held()); add("wifi monitor mode", monitor.held()); add("wifi direct / hotspot / join", wnet.held()); add("sockets", net.held()); add("broadcast receiver", sys.held()); add("speech", speech.held())
        return l
    }

    private var idleSince = 0L

    /** Нет клиентов дольше idleMin — закрываем то, что они оставили открытым. */
    private fun releaseIdle() {
        if (server.clientCount > 0) { idleSince = 0; return }
        val now = android.os.SystemClock.elapsedRealtime()
        if (idleSince == 0L) { idleSince = now; return }
        val h = holds()
        if (cfg.idleMin <= 0 || h.isEmpty() || now - idleSince < cfg.idleMin * 60_000L) return
        gatt.release(); gattsrv.release(); l2cap.release(); wlink.release(); monitor.release(); wnet.release(); btlink.release(); adv.release(); net.release(); sys.release(); speech.release()
        idleSince = now
        server.note("info", "no clients for ${cfg.idleMin} min: released ${h.joinToString(", ")}")
    }

    /** Поля записи power: нагрузка самого моста. cpu — процессорное время процесса, мс (разница за интервал = нагрузка). */
    private fun diagPairs(): List<Pair<String, String?>> = listOf(
        "cpu" to android.os.Process.getElapsedCpuTime().toString(), "wake" to if (wake?.isHeld == true) "1" else "0",
        "clients" to server.clientCount.toString(), "clientList" to Json.str(server.clientLines().joinToString("; ")), "held" to Json.str(holds().joinToString(", ")))

    /** Запись VPN-монитора (DspVpnService — отдельный сервис, тот же процесс) → подписчикам vpn. */
    fun vpnEmit(json: String) { server.emit("vpn", json) }

    /** Событие от другого приложения (ExternalReceiver) → подписчикам ext. */
    fun emitExt(name: String, value: String?, text: String?) {
        val v = value?.toDoubleOrNull()?.takeIf { it.isFinite() }
        server.emit("ext", Json.obj("src" to "\"ext\"", "t" to System.currentTimeMillis().toString(), "name" to Json.str(name),
            "value" to (v?.let { Json.num(it) } ?: Json.str(value).takeIf { value != null }), "text" to text?.let { Json.str(it) }))
    }

    /** Команда страницы → тот, кто её исполняет. Действия (сеть, соединения, речь, управление телефоном) — только клиенту с правом power. */
    private fun route(c: BridgeServer.Client, j: org.json.JSONObject) {
        val n = j.optString("cmd")
        if (BridgeServer.powerCmd(n) && !c.power) return Reply.done(c, j.opt("id"), n, "not allowed for this page — only the page of the DSP app (or any page, if allowed in the app Settings) may use it", "forbidden")
        when {
            n == "activity.log" -> {
                val rows = activity.history(j.optLong("since", 0), j.optInt("limit", 500))
                if (rows.isNotEmpty()) c.send(rows.joinToString(",", "[", "]"))
                Reply.done(c, j.opt("id"), n, null, "error", "n" to rows.size.toString())
            }
            n.startsWith("gatt.") -> gatt.exec(c, j)
            n.startsWith("gattsrv.") -> gattsrv.exec(c, j)
            n.startsWith("l2cap.") -> l2cap.exec(c, j)
            n == "wifi.monitor" || n == "wifi.channel" -> monitor.exec(c, j)
            n.startsWith("p2p.") || n == "wifi.hotspot.start" || n == "wifi.hotspot.stop" || n.startsWith("wifi.suggest") || n == "wifi.connect" || n == "wifi.disconnect" -> wnet.exec(c, j)
            n.startsWith("nsd.") || n.startsWith("wifi.") || n.startsWith("aware.") -> wlink.exec(c, j)
            n.startsWith("bt.") -> btlink.exec(c, j)
            n.startsWith("ble.adv.") -> adv.exec(c, j)
            n.startsWith("speech.") -> speech.exec(c, j)
            n.startsWith("tcp.") || n.startsWith("udp.") || n.startsWith("net.") || n.startsWith("raw.") || n == "ping" -> net.exec(c, j)
            n.startsWith("vpn.") -> VpnCmds.exec(this, c, j)
            n.startsWith("tls.") -> tlsCmds.exec(c, j)
            n.startsWith("sys.") || n.startsWith("gps.mock") || n.startsWith("ui.") || n.startsWith("vol.") || n.startsWith("tts.") || n.startsWith("clip.") || n.startsWith("app.") ||
                n == "intent" || n == "media" || n == "toast" || n.startsWith("screen.") -> sys.exec(c, j)
            else -> actions.exec(c, j)
        }
    }

    /** Остановка по кнопке: снять уведомление и остановить сервис. */
    private fun shutdown() {
        destroyed = true
        main.removeCallbacks(tick)
        stopForeground(STOP_FOREGROUND_REMOVE)
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(ID)
        stopSelf()
    }

    override fun onDestroy() {
        destroyed = true
        main.removeCallbacks(tick)
        inst = null; up = false
        power.close(); activity.close(); try { sys.stopMock() } catch (e: Exception) { }; FloatWin.closeAll()
        server.stop()
        sensors.close(); gps.close(); wifi.close(); battery.close(); ble.close(); bt.close(); gnss.close(); cell.close(); mic.close(); sniffer.close(); usb.close(); actions.close(); speech.close(); gatt.close(); gattsrv.close(); l2cap.close(); wlink.close(); monitor.close(); wnet.close(); btlink.close(); adv.close(); net.close(); sys.close()
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
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_IMMUTABLE)
        val set = PendingIntent.getActivity(this, 1, Intent(this, SettingsActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 2, Intent(this, BridgeService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val text = serverError ?: summary()
        shownText = text
        val b = Notification.Builder(this, CH)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentTitle("DSP phone bridge")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_menu_preferences, "Settings", set)
        // напоминание висит, пока не исключили из оптимизации батареи — иначе прошивка рано или поздно замораживает процесс в фоне
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (!pm.isIgnoringBatteryOptimizations(packageName)) {
            val battery = PendingIntent.getActivity(this, 3,
                Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, android.net.Uri.parse("package:$packageName")), PendingIntent.FLAG_IMMUTABLE)
            b.addAction(android.R.drawable.ic_lock_idle_low_battery, "Fix battery optimization", battery)
        }
        return b.addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stop).build()
    }

    private fun summary(): String {
        val w = server.wanted()
        val parts = ArrayList<String>()
        parts.add((if (cfg.shareLan) "0.0.0.0" else "127.0.0.1") + ":" + cfg.port)
        parts.add("${server.clientCount} client(s)")
        server.clientLines().take(3).forEach { parts.add(it) }
        if (w.subs.isNotEmpty()) parts.add(w.subs.joinToString(","))
        else if (server.clientCount == 0) holds().takeIf { it.isNotEmpty() }?.let { parts.add("holding " + it.joinToString(", ")) }
        return parts.joinToString(" · ")
    }

    // ---------- источники ----------

    /** Включает то, что просят клиенты, остальное гасит. Вызывается при каждой смене подписок. */
    @Synchronized
    private fun refresh() {
        if (destroyed) return
        val w = server.wanted()
        val problems = HashSet<String>()
        val f = power.factor
        for (k in sensors.update(w.subs.filter { it in SensorHub.ALL }.toSet(), if (f > 1) maxOf(5, w.hz / f) else w.hz)) problems.add("$k: no such sensor on this phone")
        val needGps = w.subs.any { it in POSITION }
        if (!gps.update(needGps)) problems.add("no position: allow Location for the DSP app and turn Location on")
        if (!wifi.update("wifi" in w.subs, w.wifiEvery * f)) problems.add("wifi: allow Location for the DSP app (Android hides the scan without it)")
        battery.update("battery" in w.subs)
        if (!gnss.update("gnss" in w.subs, "gnssraw" in w.subs, "nmea" in w.subs)) problems.add("gnss: allow Location for the DSP app")
        if (!ble.update("ble" in w.subs, w.bleOpts)) problems.add(ble.lastError)
        sys.update("sys" in w.subs)
        if (!bt.update("bt" in w.subs)) problems.add(bt.lastError)
        if (!cell.update("cell" in w.subs, w.cellEvery * f)) problems.add(cell.lastError)
        if (!mic.update("mic" in w.subs, w.micHz)) problems.add(mic.lastError)
        if (!sniffer.update("pkt" in w.subs, w.iface, w.filter, w.snap)) problems.add(sniffer.lastError)
        if (!actions.update("sms" in w.subs)) problems.add("sms: allow SMS for the DSP app")
        askPermissions(if (cfg.activityLog) w.subs + "activity" else w.subs)
        for (p in problems) if (warned.add(p)) server.note("error", p)
        warned.retainAll(problems)

        if (!activity.update("activity" in w.subs || cfg.activityLog)) problems.add("activity: no stationary / motion / step sensors, or the step counter lacks the Physical activity permission")
        if ("activity" in w.subs) activity.push()
        if ("power" in w.subs) power.push()
        renewWake()

        val text = serverError ?: summary()
        if (text != shownText) (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(ID, notification())
    }

    /**
     * Спрашивает разрешения для выбранных на странице источников (один раз на разрешение за жизнь сервиса).
     * Окно открывается сразу, если приложение на экране, иначе — по нажатию на уведомление (из фона Android окно не откроет).
     */
    private fun askPermissions(subs: Set<String>) {
        val miss = Perms.forSubs(subs, Build.VERSION.SDK_INT).filter { !granted(it) && asked.add(it) }
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
            "sources" to arr(listOf("gps", "battery", "wifi", "gnss", "gnssraw", "nmea", "cell", "mic", "sms", "notify", "torch", "speech", "gatt", "gattsrv", "l2cap", "btlink", "net", "sys", "power", "ext", "activity", "vpn") + (if (cfg.sniffer) listOf("pkt") else emptyList()) + (if (hasBluetooth()) listOf("ble", "bt") else emptyList()) + sens), "sensors" to arr(sens), "sensorInfo" to sensors.info(),
            "phone" to actions.info(),
            "tls" to server.tlsPort.toString(),                     // порт wss:// / https:// (0 — сертификата нет)
        )
    }

    /** Что сейчас расходует заряд: подписки, wake lock, оставленные открытыми соединения, коэффициент замедления, CPU процесса. */
    private fun diag(): String {
        val w = server.wanted()
        val cpu = android.os.Process.getElapsedCpuTime() / 1000.0
        val up = (android.os.SystemClock.elapsedRealtime() - started) / 60000.0
        return "clients: ${server.clientCount}" + server.clientLines().joinToString("") { "\n  $it" } + "\nsources on: " + (w.subs.sorted().joinToString(",").ifEmpty { "none" }) + "\nwake lock: " + (if (wake?.isHeld == true) "held" else "free") +
            "\nheld open: " + (holds().joinToString(", ").ifEmpty { "none" }) + "\npolling slowed: ÷${power.factor}" +
            "\nprocess CPU: ${"%.1f".format(cpu)} s in ${"%.0f".format(up)} min of service life\n"
    }

    private fun statusText(): String =
        "DSP phone bridge\n" + summary() + "\nsensors: " + sensors.available().joinToString(",") + "\n" + sensors.lines() + "addresses: " + lan().joinToString(", ") + "\n" + diag()

    companion object {
        @Volatile var inst: BridgeService? = null
        /** Сервис создан и не остановлен (для плитки в шторке). */
        @Volatile var up = false
        private const val TICK_MS = 20_000L
        private const val WAKE_MS = 10 * 60_000L
        const val ACTION_STOP = "app.dsp.phone.STOP"
        const val ACTION_RELOAD = "app.dsp.phone.RELOAD"
        private const val CH = "bridge"
        const val CRASH_FILE = "last-crash.txt"
        private const val CH_PERM = "perm"
        private const val ID = 1
        const val PERM_ID = 2
        // источники, которым нужно включённое определение положения (ГНСС) или последнее положение в записях
        private val POSITION = setOf("gps", "wifi", "ble", "bt", "gnss", "gnssraw", "nmea", "cell")

        /** Остановить мост (то же, что кнопка Stop в уведомлении). */
        fun stop(ctx: Context) {
            userStopped = true
            ctx.startService(Intent(ctx, BridgeService::class.java).setAction(ACTION_STOP))
        }

        /** Остановлен кнопкой: возврат в окно (onRestart / onNewIntent) его не запускает; запуск приложения — да. */
        @Volatile var userStopped = false

        /** Окно вернулось на экран (singleTask: onCreate заново не зовётся). Сервис, которого система убила, поднимаем снова; запущенному это не мешает. */
        fun resume(ctx: Context) { if (!userStopped) try { ctx.startForegroundService(Intent(ctx, BridgeService::class.java)) } catch (e: Exception) {} }

        fun start(ctx: Context, reload: Boolean = false) {
            userStopped = false
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
