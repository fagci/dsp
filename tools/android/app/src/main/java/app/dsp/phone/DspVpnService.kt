package app.dsp.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.VpnService
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelFileDescriptor
import android.system.OsConstants
import org.json.JSONObject
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Телефон как VPN-монитор своего собственного трафика: что куда ходит, каким приложением, на какой адрес и под каким именем
 * (из DNS / SNI / HTTP Host; расшифровка TLS — только для приложений из явного списка tlsApps, никогда по умолчанию и никогда
 * «всё подряд» — см. vpn.tls). Стек — VpnEngine.kt (без android.*, проверен в tools/android/jvm-test против настоящего ядра
 * Linux, включая полный круг расшифровки TlsMitmEngineTest); здесь — только то, что требует Android:
 * сам интерфейс (TUN), protect() настоящих сокетов (чтобы они не зациклились обратно в тот же туннель) и uid → приложение.
 * Только IPv4: добавлять IPv6 в маршруты туннеля, не умея его разобрать, значит просто рвать связь — он идёт в обход, как
 * без VPN. Разрешение на сам VPN спрашивает система (её диалог, не наш) — см. VpnConsentActivity.
 */
class DspVpnService : VpnService() {
    private var pfd: ParcelFileDescriptor? = null
    private var engine: VpnEngine? = null
    private var reader: Thread? = null
    private val writeLock = Any()
    private val owners = ConcurrentHashMap<Int, Owner>()
    private var packets = false                                  // поток полных пакетов (hex) — тяжело, по подписке
    private val thread = HandlerThread("dsp-vpn-snap").apply { start() }
    private val h = Handler(thread.looper)
    private var stats = Stats()
    private class Stats { var flows = 0; var open = 0; var bytesUp = 0L; var bytesDown = 0L }

    override fun onCreate() {
        super.onCreate()
        inst = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopSelf(); return START_NOT_STICKY }
        if (engine == null) start()
        return START_STICKY
    }

    override fun onRevoke() { stop("the system VPN was turned off (another VPN app, or Settings)") }   // пользователь отключил VPN в системных настройках
    override fun onDestroy() { stop(null); super.onDestroy() }

    @Suppress("DEPRECATION")
    private fun start() {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel(CH, "DSP VPN monitor", NotificationManager.IMPORTANCE_LOW))
        val stop = PendingIntent.getService(this, 0, Intent(this, DspVpnService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        // Action.Builder(Icon, …) требует не-null значок — с null кнопка в уведомлении просто не срабатывает (как у BridgeService.notification())
        val n = Notification.Builder(this, CH).setContentTitle("DSP: network monitor")
            .setContentText("Watching which app talks to which address").setSmallIcon(android.R.drawable.ic_menu_compass)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stop).setOngoing(true).build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) else startForeground(ID, n)

        val b = Builder().setSession("DSP").addAddress(TUN_ADDR, 32).addRoute("0.0.0.0", 0).setMtu(MTU)
        // Выбор приложений: «only» — в туннель идут только они (остальные мимо, не видны и не замедляются), «except» — все кроме них. Само приложение всегда мимо.
        val cur = sel; var added = 0; val missing = ArrayList<String>()
        for (p in cur.pkgs) {
            if (p == packageName) continue
            try { if (cur.mode == "only") b.addAllowedApplication(p) else b.addDisallowedApplication(p); added++ } catch (e: Exception) { missing.add(p) }
        }
        if (cur.mode == "only" && added == 0) { stop("none of the chosen apps is installed: ${cur.pkgs.take(5).joinToString()}"); return }
        if (cur.mode != "only") try { b.addDisallowedApplication(packageName) } catch (e: Exception) { }
        if (missing.isNotEmpty()) emit(Json.note("warn", "VPN: not installed, skipped — ${missing.take(8).joinToString()}"))
        try { // DNS серверов самой сети, если есть — для совместимости с приватным DNS (DoT) на части прошивок
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val lp = cm.activeNetwork?.let { cm.getLinkProperties(it) }
            for (d in lp?.dnsServers.orEmpty()) if (d.address?.size == 4) b.addDnsServer(d)
        } catch (e: Exception) { }
        val fd = try { b.establish() } catch (e: Exception) { stop("could not open the tunnel: ${e.message}"); return } ?: run { stop("the system refused the tunnel"); return }
        pfd = fd
        val sockets = object : VpnSockets {
            override fun tcp(dst: InetAddress, port: Int, timeoutMs: Int): Socket {
                val s = Socket(); protect(s); s.connect(InetSocketAddress(dst, port), timeoutMs); return s
            }
            override fun udp(): DatagramSocket { val s = DatagramSocket(); protect(s); return s }
        }
        val events = object : VpnEvents {
            override fun owner(proto: Int, src: InetSocketAddress, dst: InetSocketAddress): Owner? {
                if (Build.VERSION.SDK_INT < 29) return null
                val uid = try {
                    val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
                    cm.getConnectionOwnerUid(if (proto == 6) OsConstants.IPPROTO_TCP else OsConstants.IPPROTO_UDP, src, dst)
                } catch (e: Exception) { -1 }
                if (uid < 0) return null
                return owners.getOrPut(uid) { resolveOwner(uid) }
            }
            override fun flow(f: FlowInfo, kind: String) {
                if (kind == "open") { stats.flows++; stats.open++ } else if (kind == "close") { stats.open--; stats.bytesUp += f.up; stats.bytesDown += f.down }
                emit(Json.obj("src" to Json.str("vpn"), "ev" to Json.str(kind), "t" to System.currentTimeMillis().toString(), *flowFields(f)))
            }
            override fun packet(out: Boolean, p: ByteArray, len: Int, f: FlowInfo?) {
                if (!packets) return
                emit(Json.obj("src" to Json.str("vpn"), "ev" to Json.str("pkt"), "t" to System.currentTimeMillis().toString(),
                    "dir" to Json.str(if (out) "out" else "in"), "id" to f?.id?.toString(), "n" to len.toString(), "hex" to Json.str(Hex.of(p, 0, minOf(len, PKT_CAP)))))
            }
            override fun dns(f: FlowInfo?, q: DnsSniff.Msg, ms: Long) {
                emit(Json.obj("src" to Json.str("vpn"), "ev" to Json.str("dns"), "t" to System.currentTimeMillis().toString(),
                    "name" to Json.str(q.name), "ips" to Json.arr(q.ips), "ms" to Json.num(ms.toDouble(), 10.0)))
            }
            // Явный список (vpn.tls), только порт 443 — ни «всё», ни эвристика по содержимому; без списка decrypt() не вызывается вовсе.
            override fun decryptCandidate(f: FlowInfo): Boolean {
                if (f.dport != 443 || tlsApps.isEmpty()) return false
                val pkgs = f.owner?.pkgs ?: return false
                return pkgs.any { it in tlsApps }
            }
            override fun decrypt(f: FlowInfo, host: String): TlsMitm? {
                val dir = filesDir
                return object : TlsMitm {
                    override fun deviceSide() = MitmCa.serverEngine(dir, host)
                    override fun upstreamSide(): javax.net.ssl.SSLEngine {
                        // системное доверие, честная проверка имени — поддельный сертификат это не обходит, только нашу собственную сторону
                        val c = javax.net.ssl.SSLContext.getInstance("TLS"); c.init(null, null, null)
                        val e = c.createSSLEngine(host, f.dport); e.useClientMode = true
                        e.sslParameters = e.sslParameters.also { it.endpointIdentificationAlgorithm = "HTTPS" }
                        return e
                    }
                    override fun onPlain(up: Boolean, data: ByteArray) {
                        if (data.isEmpty()) return
                        val d = data.copyOf(minOf(data.size, PLAIN_CAP))
                        emit(Json.obj("src" to Json.str("vpn"), "ev" to Json.str("plain"), "t" to System.currentTimeMillis().toString(),
                            "id" to f.id.toString(), "dir" to Json.str(if (up) "up" else "down"), "n" to data.size.toString(),
                            "hex" to Json.str(Hex.of(d)), "text" to Json.str(String(d, Charsets.UTF_8))))
                    }
                    override fun onError(msg: String) {
                        emit(Json.obj("src" to Json.str("vpn"), "ev" to Json.str("tlserror"), "t" to System.currentTimeMillis().toString(),
                            "id" to f.id.toString(), "host" to Json.str(host), "msg" to Json.str(msg)))
                    }
                }
            }
        }
        val eng = VpnEngine({ p -> writePacket(p) }, sockets, events, MTU)
        engine = eng
        emit(Json.obj("src" to Json.str("vpn"), "ev" to Json.str("state"), "on" to "true", "t" to System.currentTimeMillis().toString()))
        reader = Thread({ readLoop(fd, eng) }, "dsp-vpn-read").apply { isDaemon = true; start() }
        h.postDelayed(snap, SNAP_MS)
        notifyWaiters(true, null)
    }

    private fun resolveOwner(uid: Int): Owner {
        if (uid == 0) return Owner(0, emptyList(), "root / kernel")
        if (uid < FIRST_APP_UID && uid != 1000) return Owner(uid, emptyList(), "system (uid $uid)")
        val pm = packageManager
        val pkgs = try { pm.getPackagesForUid(uid)?.toList() ?: emptyList() } catch (e: Exception) { emptyList() }
        val label = pkgs.firstOrNull()?.let { try { pm.getApplicationLabel(pm.getApplicationInfo(it, 0)).toString() } catch (e: Exception) { null } }
            ?: (if (uid == 1000) "Android system" else "uid $uid")
        return Owner(uid, pkgs, label)
    }

    // «src» уже занято меткой канала записи (src:'vpn') — свой адрес устройства внутри туннеля не несёт смысла (у всех один и тот же), не шлём
    private fun flowFields(f: FlowInfo): Array<Pair<String, String?>> = arrayOf(
        "id" to f.id.toString(), "proto" to Json.str(if (f.proto == 6) "tcp" else "udp"),
        "dst" to Json.str(f.dst), "dport" to f.dport.toString(),
        "host" to f.host?.let { Json.str(it) }, "l7" to f.l7?.let { Json.str(it) }, "state" to Json.str(f.state),
        "uid" to f.owner?.uid?.toString(), "pkgs" to f.owner?.pkgs?.let { Json.arr(it) }, "app" to f.owner?.label?.let { Json.str(it) },
        "up" to f.up.toString(), "down" to f.down.toString(), "dur" to ((System.currentTimeMillis() - f.started) / 1000.0).let { Json.num(it, 10.0) })

    /** Снимок открытых потоков — раз в SNAP_MS, вместо непрерывного эфира; закрытые уже прислали окончательные счётчики в «close». */
    private val snap = object : Runnable {
        override fun run() {
            val eng = engine
            if (eng != null) {
                val open = eng.snapshot()
                val now = System.currentTimeMillis()
                for (f in open) if (now - f.reported > 400) { f.reported = now; emit(Json.obj("src" to Json.str("vpn"), "ev" to Json.str("stat"), *flowFields(f))) }
                emit(Json.obj("src" to Json.str("vpn"), "ev" to Json.str("summary"), "t" to System.currentTimeMillis().toString(),
                    "flows" to stats.flows.toString(), "open" to open.size.toString(), "bytesUp" to stats.bytesUp.toString(), "bytesDown" to stats.bytesDown.toString()))
                h.postDelayed(this, SNAP_MS)
            }
        }
    }

    private fun readLoop(fd: ParcelFileDescriptor, eng: VpnEngine) {
        val inp = FileInputStream(fd.fileDescriptor); val buf = ByteArray(MTU + 64)
        var why: String? = null
        try {
            while (true) { val n = inp.read(buf); if (n < 0) { why = "the tunnel closed (another VPN app took over, or the system revoked it)"; break }; if (n > 0) eng.input(buf, n) }
        } catch (e: Exception) { why = "tunnel read error: ${e.javaClass.simpleName}: ${e.message}" }
        if (engine === eng) h.post { stop(why) }
    }

    private fun writePacket(p: ByteArray) {
        val fd = pfd ?: return
        synchronized(writeLock) { try { FileOutputStream(fd.fileDescriptor).write(p) } catch (e: Exception) { } }
    }

    /** Закрыть движок и туннель, сервис остаётся — для смены выбора приложений без нового запроса разрешения. */
    private fun teardown(reason: String?): Boolean {
        h.removeCallbacksAndMessages(null)
        val eng = engine; engine = null
        try { eng?.close() } catch (e: Exception) { }
        try { pfd?.close() } catch (e: Exception) { }; pfd = null
        if (eng != null) emit(Json.obj("src" to Json.str("vpn"), "ev" to Json.str("state"), "on" to "false", "msg" to reason?.let { Json.str(it) }, "t" to System.currentTimeMillis().toString()))
        return eng != null
    }

    /** Туннель заново с новым выбором (sel уже заменён); ответ vpn.start ждёт notifyWaiters из start(). */
    private fun reload() { h.post { teardown("the choice of apps changed"); start() } }

    private fun stop(reason: String?) {
        teardown(reason)
        stopForeground(STOP_FOREGROUND_REMOVE)
        if (inst === this) inst = null
        stopSelf()
        notifyWaiters(false, reason)
    }

    private fun emit(json: String) { BridgeService.inst?.vpnEmit(json) }

    companion object {
        const val CH = "dsp-vpn"; const val ID = 5102; const val ACTION_STOP = "app.dsp.phone.VPN_STOP"
        const val TUN_ADDR = "10.8.0.2"; const val MTU = 1500; const val SNAP_MS = 2000L; const val PKT_CAP = 1500; const val PLAIN_CAP = 8192
        private const val FIRST_APP_UID = 10000
        @Volatile var inst: DspVpnService? = null
        @Volatile var sel: AppSel = AppSel.ALL                    // какие приложения идут через туннель; применяется при установке туннеля
        @Volatile var tlsApps: Set<String> = emptySet()            // явный список пакетов для расшифровки TLS (vpn.tls) — никогда «все», даже случайно

        /** true — туннель установлен, запрос на запуск не нужен. */
        fun running() = inst != null

        /** Новый выбор приложений. Туннель уже работает и выбор другой — он пересоздаётся (true: надо ждать нового старта). */
        fun select(n: AppSel): Boolean {
            val changed = !sel.same(n); sel = n
            val i = inst ?: return false
            if (!changed) return false
            i.reload(); return true
        }

        /** Подписки на поток: on — записи с включением/выключением вкл; pkt — целиком каждый пакет (hex), тяжело. */
        fun setPackets(on: Boolean) { inst?.packets = on }

        /** Уже работает (например, запущен системой — Always-on VPN — ещё до того, как страница подписалась) — сразу
            подтвердить состояние новому клиенту, а не ждать: единственная запись «on:true» могла уйти в пустоту, пока
            никто не слушал (BridgeServer не шлёт эфир без подписчиков), а следующий «summary» придёт только через SNAP_MS. */
        fun announce() { inst?.let { it.emit(Json.obj("src" to Json.str("vpn"), "ev" to Json.str("state"), "on" to "true", "t" to System.currentTimeMillis().toString())) } }

        /** vpn.stop когда служба уже не работает (процесс был убит системой, VPN отключён из системных настроек, или это повторное
            «Стоп»): страница могла этого не узнать — ни один «state:false» не ушёл, пока никто не слушал. Шлём его прямо сейчас,
            без service-интента, который иначе создавал бы и сразу убивал пустой экземпляр службы (а эфира всё равно бы не было: eng==null). */
        fun announceOff() { BridgeService.inst?.vpnEmit(Json.obj("src" to Json.str("vpn"), "ev" to Json.str("state"), "on" to "false", "t" to System.currentTimeMillis().toString())) }

        // «vpn.start» ждёт настоящий исход (установился ли туннель), а не отвечает «ok» заранее — тот же приём, что у tcp.connect:
        // ответ на саму команду идёт клиенту напрямую (не через подписку на vpn), так что причина отказа не потеряется, даже
        // если establish() упал раньше, чем страница успела подписаться на эфир.
        private val waiters = CopyOnWriteArrayList<(Boolean, String?) -> Unit>()
        fun awaitStart(timeoutMs: Long, force: Boolean = false, cb: (ok: Boolean, reason: String?) -> Unit) {
            if (!force && inst?.engine != null) { cb(true, null); return }
            waiters.add(cb)
            Handler(android.os.Looper.getMainLooper()).postDelayed({ if (waiters.remove(cb)) cb(false, "no answer from the tunnel in ${timeoutMs / 1000} s") }, timeoutMs)
        }
        private fun notifyWaiters(ok: Boolean, reason: String?) { for (w in waiters.toList()) { waiters.remove(w); try { w(ok, reason) } catch (e: Exception) { } } }
    }
}

/** Команды страницы vpn.start / vpn.stop / vpn.packets. Разрешение на сам VPN — отдельный системный диалог (VpnConsentActivity). */
object VpnCmds {
    fun exec(ctx: Context, c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        when (cmd) {
            "vpn.apps" -> {
                // Таблица установленных приложений: по uid (общий uid — одна строка). Системные — по запросу {system:true}.
                val pm = ctx.packageManager
                val apps = pm.getInstalledApplications(0).map {
                    val sys = it.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM != 0 && it.flags and android.content.pm.ApplicationInfo.FLAG_UPDATED_SYSTEM_APP == 0
                    AppRows.App(it.uid, it.packageName, try { pm.getApplicationLabel(it).toString() } catch (e: Exception) { it.packageName }, sys)
                }
                Reply.done(c, id, cmd, null, extra = arrayOf("apps" to Json.rows(AppRows.group(apps, j.optBoolean("system", false)))))
            }
            "vpn.sel" -> Reply.done(c, id, cmd, null, extra = arrayOf("sel" to DspVpnService.sel.toJson(), "running" to DspVpnService.running().toString()))
            "vpn.start" -> {
                DspVpnService.setPackets(j.optBoolean("packets", false))
                // apps / uids / mode — какие приложения идут через туннель; без них прежний выбор остаётся (по умолчанию все)
                if (j.has("apps") || j.has("uids") || j.has("mode")) {
                    val pm = ctx.packageManager
                    val (n, err) = AppSel.parse(j) { uid -> try { pm.getPackagesForUid(uid)?.toList() ?: emptyList() } catch (e: Exception) { emptyList() } }
                    if (n == null) { Reply.done(c, id, cmd, err ?: "apps", "args"); return }
                    if (DspVpnService.running() && DspVpnService.select(n)) {
                        DspVpnService.awaitStart(6000, force = true) { ok, reason -> if (ok) Reply.done(c, id, cmd, null, extra = arrayOf("sel" to n.toJson())) else Reply.done(c, id, cmd, reason ?: "could not restart", "error") }
                        return
                    }
                    DspVpnService.select(n)
                }
                if (DspVpnService.running()) { DspVpnService.announce(); Reply.done(c, id, cmd, null); return }
                val prep = VpnService.prepare(ctx)
                if (prep == null) {
                    ctx.startForegroundService(Intent(ctx, DspVpnService::class.java))
                    DspVpnService.awaitStart(6000) { ok, reason -> if (ok) Reply.done(c, id, cmd, null) else Reply.done(c, id, cmd, reason ?: "could not start", "error") }
                } else { ctx.startActivity(Intent(ctx, VpnConsentActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); Reply.done(c, id, cmd, "allow the VPN connection in the system window and repeat", "permission") }
            }
            "vpn.stop" -> {
                // не запущена (убита системой, VPN выключен из системных настроек, или это повторный «Стоп») — нечего останавливать,
                // но страница должна узнать об этом (иначе статус «monitoring» зависает навсегда без способа его снять)
                if (DspVpnService.running()) ctx.startService(Intent(ctx, DspVpnService::class.java).setAction(DspVpnService.ACTION_STOP))
                else DspVpnService.announceOff()
                Reply.done(c, id, cmd, null)
            }
            "vpn.packets" -> { DspVpnService.setPackets(j.optBoolean("on", false)); Reply.done(c, id, cmd, null) }
            "vpn.tls" -> {
                // Явный список приложений для расшифровки TLS (на порту 443) — ни «все», ни по умолчанию: без apps/uids список пуст (выключено).
                val pm = ctx.packageManager
                val pkg = Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+")
                fun items(v: Any?): List<String> = when (v) {
                    null, JSONObject.NULL -> emptyList()
                    is org.json.JSONArray -> (0 until v.length()).map { v.opt(it).toString().trim() }.filter { it.isNotEmpty() }
                    else -> v.toString().split(Regex("[,;\\s]+")).map { it.trim() }.filter { it.isNotEmpty() }
                }
                val names = LinkedHashSet<String>()
                for (s in items(j.opt("apps"))) {
                    if (!pkg.matches(s)) { Reply.done(c, id, cmd, "apps: «$s» is not a package name (com.example.app)", "args"); return }
                    names.add(s)
                }
                for (s in items(j.opt("uids"))) {
                    val u = s.toIntOrNull()?.takeIf { it >= 0 } ?: run { Reply.done(c, id, cmd, "uids: «$s» is not a number", "args"); return }
                    names.addAll(try { pm.getPackagesForUid(u)?.toList() ?: emptyList() } catch (e: Exception) { emptyList() })
                }
                if (names.size > 100) { Reply.done(c, id, cmd, "at most 100 apps for TLS decryption", "args"); return }
                DspVpnService.tlsApps = names
                Reply.done(c, id, cmd, null, extra = arrayOf("apps" to Json.arr(names.toList())))
            }
            "vpn.tls.ca" -> {
                if (j.optBoolean("reset")) MitmCa.reset(ctx.filesDir)
                Reply.done(c, id, cmd, null, extra = arrayOf(
                    "pem" to Json.str(MitmCa.rootPem(ctx.filesDir)), "fingerprint" to Json.str(MitmCa.fingerprint(ctx.filesDir)),
                    "status" to MitmCa.status(ctx.filesDir).toString(), "apps" to Json.arr(DspVpnService.tlsApps.toList())))
            }
            else -> Reply.done(c, id, cmd, "unknown command", "unknown")
        }
    }
}
