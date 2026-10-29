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
 * (из DNS / SNI / HTTP Host, без расшифровки — TLS-перехват с подменой сертификата не делается). Стек — VpnEngine.kt (без
 * android.*, проверен в tools/android/jvm-test против настоящего ядра Linux); здесь — только то, что требует Android:
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
            .setContentText("Watching which app talks to which address").setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stop).setOngoing(true).build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) else startForeground(ID, n)

        val b = Builder().setSession("DSP").addAddress(TUN_ADDR, 32).addRoute("0.0.0.0", 0).setMtu(MTU)
        try { b.addDisallowedApplication(packageName) } catch (e: Exception) { }
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

    private fun stop(reason: String?) {
        h.removeCallbacksAndMessages(null)
        val eng = engine; engine = null
        try { eng?.close() } catch (e: Exception) { }
        try { pfd?.close() } catch (e: Exception) { }; pfd = null
        if (eng != null) emit(Json.obj("src" to Json.str("vpn"), "ev" to Json.str("state"), "on" to "false", "msg" to reason?.let { Json.str(it) }, "t" to System.currentTimeMillis().toString()))
        stopForeground(STOP_FOREGROUND_REMOVE)
        if (inst === this) inst = null
        stopSelf()
        notifyWaiters(false, reason)
    }

    private fun emit(json: String) { BridgeService.inst?.vpnEmit(json) }

    companion object {
        const val CH = "dsp-vpn"; const val ID = 5102; const val ACTION_STOP = "app.dsp.phone.VPN_STOP"
        const val TUN_ADDR = "10.8.0.2"; const val MTU = 1500; const val SNAP_MS = 2000L; const val PKT_CAP = 1500
        private const val FIRST_APP_UID = 10000
        @Volatile var inst: DspVpnService? = null

        /** true — туннель установлен, запрос на запуск не нужен. */
        fun running() = inst != null

        /** Подписки на поток: on — записи с включением/выключением вкл; pkt — целиком каждый пакет (hex), тяжело. */
        fun setPackets(on: Boolean) { inst?.packets = on }

        /** Уже работает (например, запущен системой — Always-on VPN — ещё до того, как страница подписалась) — сразу
            подтвердить состояние новому клиенту, а не ждать: единственная запись «on:true» могла уйти в пустоту, пока
            никто не слушал (BridgeServer не шлёт эфир без подписчиков), а следующий «summary» придёт только через SNAP_MS. */
        fun announce() { inst?.let { it.emit(Json.obj("src" to Json.str("vpn"), "ev" to Json.str("state"), "on" to "true", "t" to System.currentTimeMillis().toString())) } }

        // «vpn.start» ждёт настоящий исход (установился ли туннель), а не отвечает «ok» заранее — тот же приём, что у tcp.connect:
        // ответ на саму команду идёт клиенту напрямую (не через подписку на vpn), так что причина отказа не потеряется, даже
        // если establish() упал раньше, чем страница успела подписаться на эфир.
        private val waiters = CopyOnWriteArrayList<(Boolean, String?) -> Unit>()
        fun awaitStart(timeoutMs: Long, cb: (ok: Boolean, reason: String?) -> Unit) {
            if (inst?.engine != null) { cb(true, null); return }
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
            "vpn.start" -> {
                DspVpnService.setPackets(j.optBoolean("packets", false))
                if (DspVpnService.running()) { DspVpnService.announce(); Reply.done(c, id, cmd, null); return }
                val prep = VpnService.prepare(ctx)
                if (prep == null) {
                    ctx.startForegroundService(Intent(ctx, DspVpnService::class.java))
                    DspVpnService.awaitStart(6000) { ok, reason -> if (ok) Reply.done(c, id, cmd, null) else Reply.done(c, id, cmd, reason ?: "could not start", "error") }
                } else { ctx.startActivity(Intent(ctx, VpnConsentActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); Reply.done(c, id, cmd, "allow the VPN connection in the system window and repeat", "permission") }
            }
            "vpn.stop" -> { ctx.startService(Intent(ctx, DspVpnService::class.java).setAction(DspVpnService.ACTION_STOP)); Reply.done(c, id, cmd, null) }
            "vpn.packets" -> { DspVpnService.setPackets(j.optBoolean("on", false)); Reply.done(c, id, cmd, null) }
            else -> Reply.done(c, id, cmd, "unknown command", "unknown")
        }
    }
}
