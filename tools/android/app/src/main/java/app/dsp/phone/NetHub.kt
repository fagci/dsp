package app.dsp.phone

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * Сеть из графа: TCP-клиент и сервер, UDP, ping, разовый UDP-запрос (для DNS и прочих запрос-ответ протоколов), сведения о сети
 * и сырые IPv4-пакеты (root). Записи: {src:'net', ev:'open'|'accept'|'data'|'close'|'ping'|'error', conn, proto, peer, hex, text}.
 * Все команды — только доверенному клиенту (страница приложения или «любая страница» в Settings): через них телефон ходит по сети.
 */
class NetHub(private val ctx: Context, private val cfg: Config, private val emit: Emit) {
    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "dsp-net").also { it.isDaemon = true } }
    private val ids = AtomicInteger(0)

    // s меняется при STARTTLS: сокет подменяет поток чтения (readTcp) — только он, чтобы никто не прочитал байты рукопожатия
    private class TcpConn(@Volatile var s: Socket, val server: Int?) {
        @Volatile var upgradeTo: String? = null
        @Volatile var upReply: ((String?) -> Unit)? = null
        val tx = SerialTx()                                   // tcp.send этого соединения идут по порядку (страница шлёт несколько подряд)
        val pend = java.util.concurrent.atomic.AtomicInteger(0)   // байт, ждущих отправки двоичными кадрами
        @Volatile var bin: BridgeServer.Client? = null            // tcp.connect с binary:true — принятые байты уходят этому клиенту кадрами [2][conn u32 BE][данные], а не записями data
    }
    /** Что открыто сейчас, для net.sockets: вид, адрес, сеть привязки, счётчики байт. */
    private class Sock(val kind: String, val desc: String, val net: String, val server: Int?) {
        val t0 = System.currentTimeMillis(); val rx = AtomicLong(); val tx = AtomicLong()
    }
    private val info = ConcurrentHashMap<Int, Sock>()
    private val cm get() = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val sched = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "dsp-netwatch").also { it.isDaemon = true } }
    @Volatile private var watchCb: ConnectivityManager.NetworkCallback? = null
    @Volatile private var watchPend: java.util.concurrent.ScheduledFuture<*>? = null
    private val tcp = ConcurrentHashMap<Int, TcpConn>()
    private val servers = ConcurrentHashMap<Int, ServerSocket>()
    private val udp = ConcurrentHashMap<Int, DatagramSocket>()
    private val mcIds = ConcurrentHashMap.newKeySet<Int>()
    private var mcLock: android.net.wifi.WifiManager.MulticastLock? = null

    private fun mcAcquire() {
        try {
            if (mcLock == null) {
                val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as android.net.wifi.WifiManager
                mcLock = wm.createMulticastLock("dsp-net").also { it.setReferenceCounted(false) }
            }
            mcLock?.acquire()
        } catch (e: Exception) { /* без lock групповые пакеты на части телефонов не доходят — сокет всё равно откроется */ }
    }
    private fun mcRelease() { try { mcLock?.takeIf { it.isHeld }?.release() } catch (e: Exception) {} }
    private fun mcDrop(n: Int) { if (mcIds.remove(n) && mcIds.isEmpty()) mcRelease() }

    private fun rec(ev: String, vararg kv: Pair<String, String?>) =
        emit("net", Json.obj("src" to "\"net\"", "ev" to Json.str(ev), "t" to System.currentTimeMillis().toString(), *kv))

    private fun dataKv(b: ByteArray) = arrayOf<Pair<String, String?>>("hex" to Json.str(Hex.of(b)), "n" to b.size.toString(), "text" to Json.str(String(b, Charsets.UTF_8)))

    /** Двоичный кадр [1][conn u32 BE][данные]: байты в сокет по порядку, без hex и без ответа. Очередь ограничена — медленному клиенту блоки пропускаются. */
    fun sendBin(b: ByteArray) {
        if (b.size <= 5) return
        val n = ((b[1].toInt() and 255) shl 24) or ((b[2].toInt() and 255) shl 16) or ((b[3].toInt() and 255) shl 8) or (b[4].toInt() and 255)
        val t = tcp[n] ?: return
        val sz = b.size - 5
        if (t.pend.addAndGet(sz) > (4 shl 20)) { t.pend.addAndGet(-sz); return }
        t.tx.execute(Runnable {
            try { t.s.getOutputStream().apply { write(b, 5, sz); flush() }; info[n]?.tx?.addAndGet(sz.toLong()) } catch (e: Exception) { /* соединение закрыто */ }
            finally { t.pend.addAndGet(-sz) }
        })
    }

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        val task = Runnable {
            try { run(c, id, cmd, j) }
            catch (e: SecurityException) { Reply.done(c, id, cmd, "permission: ${e.message}", "permission") }
            catch (e: Exception) { Reply.done(c, id, cmd, e.message ?: e.javaClass.simpleName) }
        }
        // Пул не гарантирует порядок, а потоку байт он нужен: отправки в одно соединение — в его очередь, всё остальное — в общий пул
        val tx = if (cmd == "tcp.send") tcp[j.optInt("conn")]?.tx else null
        if (tx != null) tx.execute(task) else pool.execute(task)
    }

    private fun run(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        when (cmd) {
            "tcp.connect" -> {
                val host = Args.host(j.optString("host")) ?: return Reply.done(c, id, cmd, "host")
                val port = j.optInt("port"); if (!Args.port(port)) return Reply.done(c, id, cmd, "port: 1…65535")
                if (tcp.size >= 32) return Reply.done(c, id, cmd, "32 connections at most")
                val sel = NetSel.pick(cm, j.optString("net"))
                val raw = Socket()
                try {
                    sel?.first?.bindSocket(raw)                       // net: сокет идёт в выбранную сеть, имя разрешает её DNS
                    val addr = sel?.first?.getByName(host)?.let { InetSocketAddress(it, port) } ?: InetSocketAddress(host, port)
                    raw.connect(addr, j.optInt("timeout", 5000).coerceIn(200, 60_000))
                }
                catch (e: Exception) { raw.close(); return Reply.done(c, id, cmd, "${e.javaClass.simpleName}: ${e.message}") }
                // tls:true — сразу TLS (imaps, ircs, xmpps); starttls:true — обычный сокет, который потом можно поднять командой tcp.starttls
                val s: Socket = if (j.optBoolean("tls")) {
                    try { Tls.wrap(raw, host) } catch (e: Exception) { raw.close(); return Reply.done(c, id, cmd, "TLS: ${e.message ?: e.javaClass.simpleName}") }
                } else raw
                if (j.optBoolean("starttls") && s === raw) raw.soTimeout = 200          // читатель просыпается и смотрит, не просят ли TLS
                val n = ids.incrementAndGet(); val tc = TcpConn(s, null); if (j.optBoolean("binary")) tc.bin = c; tcp[n] = tc
                val nl = NetSel.label(sel?.second); info[n] = Sock("tcp", "$host:$port", nl, null)
                rec("open", "conn" to n.toString(), "proto" to "\"tcp\"", "peer" to Json.str("$host:$port"), "net" to Json.str(nl))
                Reply.done(c, id, cmd, null, extra = arrayOf("conn" to n.toString(), "net" to Json.str(nl), "binary" to (if (tc.bin != null) "true" else "false")))
                pool.execute { readTcp(n) }
            }
            "tcp.listen" -> {
                val port = j.optInt("port"); if (port !in 1024..65535) return Reply.done(c, id, cmd, "port: 1024…65535 (an app cannot take lower ones)")
                if (servers.size >= 16) return Reply.done(c, id, cmd, "16 servers at most")
                // net: сервер слушает адрес выбранной сети (достижим только оттуда), без net — все (lan) или только этот телефон
                val sel = NetSel.pick(cm, j.optString("net"))
                val bindIp = sel?.second?.let { NetSel.ip4(it) ?: return Reply.done(c, id, cmd, "the network ${NetSel.label(it)} has no IPv4 address") }
                val ss = ServerSocket(); ss.reuseAddress = true
                ss.bind(InetSocketAddress(InetAddress.getByName(bindIp ?: if (j.optBoolean("lan", true)) "0.0.0.0" else "127.0.0.1"), port))
                val sid = ids.incrementAndGet(); servers[sid] = ss
                val nl = NetSel.label(sel?.second); info[sid] = Sock("tcp-server", (bindIp ?: if (j.optBoolean("lan", true)) "0.0.0.0" else "127.0.0.1") + ":" + ss.localPort, nl, null)
                Reply.done(c, id, cmd, null, extra = arrayOf("server" to sid.toString(), "port" to ss.localPort.toString(), "net" to Json.str(nl), "addr" to Json.str(bindIp ?: ""), "ordered" to "true", "binary" to "true"))
                pool.execute {
                    try {
                        while (true) {
                            val s = ss.accept()
                            if (tcp.size >= 32) { s.close(); continue }
                            val n = ids.incrementAndGet(); tcp[n] = TcpConn(s, sid)
                            val peer = s.remoteSocketAddress.toString().trimStart('/'); info[n] = Sock("tcp", peer, nl, sid)
                            rec("accept", "conn" to n.toString(), "server" to sid.toString(), "proto" to "\"tcp\"", "peer" to Json.str(peer), "net" to Json.str(nl))
                            pool.execute { readTcp(n) }
                        }
                    } catch (e: Exception) { /* закрыт */ }
                    servers.remove(sid); info.remove(sid); rec("close", "server" to sid.toString(), "proto" to "\"tcp\"")
                }
            }
            "tcp.send" -> {
                val t = tcp[j.optInt("conn")] ?: return Reply.done(c, id, cmd, "no such connection")
                val d = Args.payload(j) ?: return Reply.done(c, id, cmd, "hex or text")
                t.s.getOutputStream().apply { write(d); flush() }
                info[j.optInt("conn")]?.tx?.addAndGet(d.size.toLong())
                Reply.done(c, id, cmd, null, extra = arrayOf("n" to d.size.toString()))
            }
            "tcp.starttls" -> {
                val t = tcp[j.optInt("conn")] ?: return Reply.done(c, id, cmd, "no such connection")
                if (t.s is javax.net.ssl.SSLSocket) return Reply.done(c, id, cmd, "already TLS")
                if (t.s.soTimeout == 0) return Reply.done(c, id, cmd, "open the connection with starttls:true")
                val sni = Args.host(j.optString("sni")) ?: return Reply.done(c, id, cmd, "sni: the server's host name")
                t.upReply = { err -> Reply.done(c, id, cmd, err) }
                t.upgradeTo = sni                                     // рукопожатие делает читатель — после отправки нашего ClientHello байты читает уже TLS
            }
            "tcp.close", "udp.close" -> {
                val n = if (j.has("server")) j.optInt("server") else j.optInt("conn")
                tcp.remove(n)?.s?.close(); servers.remove(n)?.close(); udp.remove(n)?.close(); mcDrop(n); info.remove(n)
                Reply.done(c, id, cmd, null)
            }
            "udp.open" -> {
                val port = j.optInt("port", 0); if (port != 0 && port !in 1024..65535) return Reply.done(c, id, cmd, "port: 0 (any) or 1024…65535")
                if (udp.size >= 16) return Reply.done(c, id, cmd, "16 sockets at most")
                // multicast — группа (SSDP: 239.255.255.250): сокет вступает в неё, Wi-Fi держит multicast lock, пока такие сокеты открыты
                val group = j.optString("multicast").trim()
                val grp: InetAddress? = if (group.isEmpty()) null
                    else Args.host(group)?.let { InetAddress.getByName(it) }?.takeIf { it.isMulticastAddress } ?: return Reply.done(c, id, cmd, "multicast: a group address, e.g. 239.255.255.250")
                val sel = NetSel.pick(cm, j.optString("net"))
                val s: DatagramSocket
                if (grp != null) {
                    val ms = MulticastSocket(null); ms.reuseAddress = true; sel?.first?.bindSocket(ms); ms.bind(InetSocketAddress(port))
                    mcAcquire()
                    try { @Suppress("DEPRECATION") ms.joinGroup(grp) } catch (e: Exception) { ms.close(); mcRelease(); return Reply.done(c, id, cmd, "multicast: ${e.message}") }
                    s = ms
                } else {
                    s = DatagramSocket(null); s.reuseAddress = true
                    sel?.first?.bindSocket(s)
                    s.bind(InetSocketAddress(port))
                }
                s.broadcast = j.optBoolean("broadcast", false)
                val n = ids.incrementAndGet(); udp[n] = s; if (grp != null) mcIds.add(n)
                val nl = NetSel.label(sel?.second); val sk = Sock("udp", (if (grp != null) grp.hostAddress + " " else "") + "*:" + s.localPort, nl, null); info[n] = sk
                Reply.done(c, id, cmd, null, extra = arrayOf("conn" to n.toString(), "port" to s.localPort.toString(), "net" to Json.str(nl)))
                pool.execute {
                    val buf = ByteArray(65535)
                    try {
                        while (true) {
                            val p = DatagramPacket(buf, buf.size); s.receive(p); sk.rx.addAndGet(p.length.toLong())
                            rec("data", "conn" to n.toString(), "proto" to "\"udp\"", "peer" to Json.str(p.address.hostAddress + ":" + p.port), *dataKv(buf.copyOf(p.length)))
                        }
                    } catch (e: Exception) { /* закрыт */ }
                    udp.remove(n); mcDrop(n); info.remove(n); rec("close", "conn" to n.toString(), "proto" to "\"udp\"")
                }
            }
            "udp.send" -> {
                val host = Args.host(j.optString("host")) ?: return Reply.done(c, id, cmd, "host")
                val port = j.optInt("port"); if (!Args.port(port)) return Reply.done(c, id, cmd, "port: 1…65535")
                val d = Args.payload(j, 65507) ?: return Reply.done(c, id, cmd, "hex or text: up to 65507 bytes")
                val own = udp[j.optInt("conn")]
                val sel = if (own == null) NetSel.pick(cm, j.optString("net")) else null
                val s = own ?: DatagramSocket(null).also { it.broadcast = j.optBoolean("broadcast", false); sel?.first?.bindSocket(it); it.bind(null) }
                try { s.send(DatagramPacket(d, d.size, sel?.first?.getByName(host) ?: InetAddress.getByName(host), port)); info[j.optInt("conn")]?.tx?.addAndGet(d.size.toLong()) } finally { if (own == null) s.close() }
                Reply.done(c, id, cmd, null, extra = arrayOf("n" to d.size.toString()))
            }
            "udp.request" -> {
                // host «@dns» — первый DNS-сервер сети телефона
                var host = j.optString("host")
                val sel = NetSel.pick(cm, j.optString("net"))
                if (host == "@dns") host = dnsServers(sel?.first).firstOrNull() ?: return Reply.done(c, id, cmd, "no DNS server in the network")
                host = Args.host(host) ?: return Reply.done(c, id, cmd, "host")
                val port = j.optInt("port", 53); if (!Args.port(port)) return Reply.done(c, id, cmd, "port: 1…65535")
                val d = Args.payload(j, 65507) ?: return Reply.done(c, id, cmd, "hex or text")
                DatagramSocket(null).use { s ->
                    sel?.first?.bindSocket(s); s.bind(null)
                    s.soTimeout = j.optInt("timeout", 3000).coerceIn(100, 30_000)
                    val t0 = System.nanoTime()
                    s.send(DatagramPacket(d, d.size, sel?.first?.getByName(host) ?: InetAddress.getByName(host), port))
                    val buf = ByteArray(65535); val p = DatagramPacket(buf, buf.size)
                    try { s.receive(p) } catch (e: SocketTimeoutException) { return Reply.done(c, id, cmd, "no answer from $host:$port in ${s.soTimeout} ms", "timeout") }
                    val ms = (System.nanoTime() - t0) / 1e6
                    Reply.done(c, id, cmd, null, extra = arrayOf("hex" to Json.str(Hex.of(buf, 0, p.length)), "n" to p.length.toString(), "ms" to Json.num(ms, 100.0), "server" to Json.str(host)))
                }
            }
            "ping" -> ping(c, id, cmd, j)
            "net.trace" -> trace(c, id, cmd, j)
            "net.list" -> Reply.done(c, id, cmd, null, extra = arrayOf("nets" to Json.rows(NetSel.query(cm).map { it.toJson() })))
            "net.sockets" -> Reply.done(c, id, cmd, null, extra = arrayOf("socks" to sockRows()))
            "net.watch" -> {
                if (j.optBoolean("on", true)) watchOn() else watchOff()
                Reply.done(c, id, cmd, null, extra = arrayOf("on" to (watchCb != null).toString(), "nets" to Json.rows(NetSel.query(cm).map { it.toJson() }), "socks" to sockRows()))
            }
            "net.info" -> {
                val sel = NetSel.pick(cm, j.optString("net"))
                val an = sel?.first ?: cm.activeNetwork
                val lp = an?.let { cm.getLinkProperties(it) }
                val caps = an?.let { cm.getNetworkCapabilities(it) }
                Reply.done(c, id, cmd, null, extra = arrayOf(
                    "dns" to Json.arr(dnsServers(sel?.first)), "ips" to Json.arr(if (sel != null) sel.second.ips else BridgeService.lan()), "net" to Json.str(NetSel.label(sel?.second)),
                    "iface" to Json.str(lp?.interfaceName ?: ""), "domain" to Json.str(lp?.domains ?: ""),
                    "gateway" to Json.str(lp?.routes?.firstOrNull { it.isDefaultRoute }?.gateway?.hostAddress ?: ""),
                    "wifi" to if (caps?.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) == true) "true" else "false",
                    "cell" to if (caps?.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR) == true) "true" else "false",
                    "root" to if (cfg.sniffer) "true" else "false"))
            }
            "raw.send" -> raw(c, id, cmd, j)
            else -> Reply.done(c, id, cmd, "unknown command", "unknown")
        }
    }

    private fun dnsServers(net: Network? = null): List<String> = try {
        (net ?: cm.activeNetwork)?.let { cm.getLinkProperties(it) }?.dnsServers?.mapNotNull { it.hostAddress } ?: emptyList()
    } catch (e: Exception) { emptyList() }

    /** Открытые сокеты и серверы с сетью привязки и байтами: страница рисует по ним схему «что сейчас активно». */
    private fun sockRows(): String {
        val now = System.currentTimeMillis()
        return Json.rows(info.entries.sortedBy { it.key }.map { (k, v) ->
            Json.obj("id" to k.toString(), "kind" to Json.str(v.kind), "addr" to Json.str(v.desc), "net" to Json.str(v.net),
                "server" to v.server?.toString(), "age" to (now - v.t0).toString(), "rx" to v.rx.get().toString(), "tx" to v.tx.get().toString())
        })
    }

    private fun snapshot(why: String) = emit("net", Json.obj("src" to "\"net\"", "ev" to Json.str("networks"), "t" to System.currentTimeMillis().toString(),
        "why" to Json.str(why), "nets" to Json.rows(NetSel.query(cm).map { it.toJson() }), "socks" to sockRows()))

    /** net.watch {on}: запись ev:'networks' при каждом изменении сетей (подключилась, пропала, сменила адреса / DNS / проверку) — не чаще раза в 150 мс. */
    private fun watchOn() {
        if (watchCb != null) return
        val cb = object : ConnectivityManager.NetworkCallback() {
            private fun kick(why: String) {
                watchPend?.cancel(false)
                watchPend = try { sched.schedule({ try { snapshot(why) } catch (e: Exception) {} }, 150, TimeUnit.MILLISECONDS) } catch (e: Exception) { null }
            }
            override fun onAvailable(network: Network) = kick("available")
            override fun onLost(network: Network) = kick("lost")
            override fun onCapabilitiesChanged(network: Network, caps: android.net.NetworkCapabilities) = kick("caps")
            override fun onLinkPropertiesChanged(network: Network, lp: android.net.LinkProperties) = kick("link")
        }
        val req = android.net.NetworkRequest.Builder().removeCapability(android.net.NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build()
        try { cm.registerNetworkCallback(req, cb); watchCb = cb } catch (e: Exception) { throw IllegalStateException("net.watch: ${e.message}") }
    }
    private fun watchOff() {
        val cb = watchCb ?: return; watchCb = null
        try { cm.unregisterNetworkCallback(cb) } catch (e: Exception) {}
    }

    private fun readTcp(n: Int) {
        val conn = tcp[n] ?: return
        val buf = ByteArray(if (conn.bin != null) 32768 else 8192)
        try {
            while (true) {
                val up = conn.upgradeTo
                if (up != null) {                                     // STARTTLS: сервер ответил «proceed», дальше только TLS
                    conn.upgradeTo = null
                    try { conn.s = Tls.wrap(conn.s, up) } catch (e: Exception) { conn.upReply?.invoke("TLS: ${e.message ?: e.javaClass.simpleName}"); break }
                    conn.upReply?.invoke(null)
                    continue
                }
                val k = try { conn.s.getInputStream().read(buf) } catch (e: SocketTimeoutException) { continue }
                if (k < 0) break
                info[n]?.rx?.addAndGet(k.toLong())
                val bc = conn.bin
                if (bc != null) {                                      // поток без JSON и hex: [2][conn u32 BE][данные]
                    if (bc.dead) break
                    val f = ByteArray(5 + k); f[0] = 2; f[1] = (n shr 24).toByte(); f[2] = (n shr 16).toByte(); f[3] = (n shr 8).toByte(); f[4] = n.toByte()
                    System.arraycopy(buf, 0, f, 5, k); bc.sendBytes(f)
                } else rec("data", "conn" to n.toString(), "proto" to "\"tcp\"", *dataKv(buf.copyOf(k)))
            }
        } catch (e: Exception) { /* обрыв */ }
        tcp.remove(n); info.remove(n); try { conn.s.close() } catch (e: Exception) {}
        rec("close", "conn" to n.toString(), "proto" to "\"tcp\"")
    }

    /** ping без root: системный /system/bin/ping (ICMP через ping-сокет); строки разбираются NetParse. */
    private fun ping(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        val host = Args.host(j.optString("host")) ?: return Reply.done(c, id, cmd, "host")
        val count = j.optInt("count", 4).coerceIn(1, 30); val wait = j.optInt("timeout", 2).coerceIn(1, 10)
        val size = j.optInt("size", 56).coerceIn(0, 1400); val ttl = j.optInt("ttl", 0).coerceIn(0, 255)
        val iface = NetSel.pick(cm, j.optString("net"))?.second?.iface?.takeIf { Regex("[A-Za-z0-9_.-]{1,15}").matches(it) }
        val args = ArrayList<String>().apply {
            add("/system/bin/ping"); if (iface != null) { add("-I"); add(iface) }; add("-c"); add(count.toString()); add("-W"); add(wait.toString()); add("-s"); add(size.toString())
            if (ttl > 0) { add("-t"); add(ttl.toString()) }
            add(host)
        }
        var sent = 0; var got = 0; var avg: Double? = null
        val p = try { ProcessBuilder(args).redirectErrorStream(true).start() } catch (e: Exception) { return Reply.done(c, id, cmd, "no ping on this phone: ${e.message}") }
        val rd = Thread { try { p.inputStream.bufferedReader().forEachLine { l ->
            NetParse.reply(l)?.let { r -> rec("ping", "host" to Json.str(host), "from" to Json.str(r.from), "seq" to r.seq.toString(), "ms" to Json.num(r.ms, 100.0), "ttl" to r.ttl?.toString(), "bytes" to r.bytes.toString(), "ok" to "1") }
            NetParse.summary(l)?.let { sent = it.first; got = it.second }
            NetParse.rtt(l)?.let { avg = it.second }
            if (l.contains("Time to live exceeded", true) || l.contains("TTL", true) && l.startsWith("From")) rec("ping", "host" to Json.str(host), "ok" to "0", "info" to Json.str(l.trim()))
        } } catch (e: Exception) {} }.also { it.isDaemon = true; it.start() }
        if (!p.waitFor((count * (wait + 1) + 5).toLong(), TimeUnit.SECONDS)) p.destroy()
        rd.join(1000)
        Reply.done(c, id, cmd, null, extra = arrayOf("host" to Json.str(host), "sent" to sent.toString(), "got" to got.toString(), "avg" to avg?.let { Json.num(it, 100.0) }))
    }

    private class Hop(val ip: String?, val ms: Double?, val last: Boolean, val unreachable: Boolean, val elapsedMs: Double)

    /** Одна проба traceroute: ping -c 1 -t TTL. Ответ «Time to live exceeded» несёт адрес узла на пути, обычный ответ — конец пути; процесс снимается сразу после ответа. */
    private fun traceHop(host: String, ttl: Int, wait: Int, iface: String? = null): Hop {
        val t0 = System.nanoTime()
        val p = try { ProcessBuilder(ArrayList<String>().apply { add("/system/bin/ping"); if (iface != null) { add("-I"); add(iface) }; addAll(listOf("-c", "1", "-W", wait.toString(), "-t", ttl.toString(), host)) }).redirectErrorStream(true).start() }
                catch (e: Exception) { return Hop(null, null, false, false, 0.0) }
        var ip: String? = null; var ms: Double? = null; var fin = false; var unr = false; var tFirst = 0L
        val rd = Thread { try { p.inputStream.bufferedReader().forEachLine { l ->
            if (ip == null) {
                NetParse.reply(l)?.let { r -> ip = r.from; ms = r.ms; fin = true; tFirst = System.nanoTime() }
                    ?: NetParse.exceeded(l)?.let { e -> ip = e.first; unr = e.second; fin = e.second; tFirst = System.nanoTime() }
                if (ip != null) p.destroy()
            }
        } } catch (e: Exception) {} }.also { it.isDaemon = true; it.start() }
        if (!p.waitFor((wait + 2).toLong(), TimeUnit.SECONDS)) p.destroy()
        rd.join(500)
        return Hop(ip, ms, fin, unr, if (tFirst > 0) (tFirst - t0) / 1e6 else 0.0)
    }

    /**
     * traceroute без root: `net.trace {host, max, first, timeout, silent, run}` — пробы ping с растущим TTL; каждый узел на пути — запись
     * {src:'net', ev:'trace', host, hop, ip, ms, ok, final, run}. Время «пустого» ping (запуск процесса) вычитается: его меряем на 127.0.0.1.
     * Ответ маршрутизатора приходит без времени — оно считается от запуска пробы, поэтому это оценка с точностью в миллисекунду-две.
     */
    private fun trace(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        val host = Args.host(j.optString("host")) ?: return Reply.done(c, id, cmd, "host")
        val max = j.optInt("max", 30).coerceIn(1, 64); val first = j.optInt("first", 1).coerceIn(1, max)
        val wait = j.optInt("timeout", 2).coerceIn(1, 5); val silentMax = j.optInt("silent", 5).coerceIn(1, 64)
        val run = j.optString("run").takeIf { it.isNotEmpty() && it.length <= 40 && Regex("[A-Za-z0-9_.:-]+").matches(it) }
        val iface = NetSel.pick(cm, j.optString("net"))?.second?.iface?.takeIf { Regex("[A-Za-z0-9_.-]{1,15}").matches(it) }
        val base = traceHop("127.0.0.1", 64, 1).let { if (it.ip != null) (it.elapsedMs - (it.ms ?: 0.0)).coerceAtLeast(0.0) else 0.0 }
        var silent = 0; var reached = false; var hops = 0
        for (ttl in first..max) {
            val h = traceHop(host, ttl, wait, iface); hops++
            val ms = if (h.ip == null) null else h.ms ?: (h.elapsedMs - base).coerceAtLeast(0.05)
            rec("trace", "host" to Json.str(host), "hop" to ttl.toString(), "ip" to h.ip?.let { Json.str(it) }, "ms" to ms?.let { Json.num(it, 100.0) },
                "ok" to (if (h.ip != null) "1" else "0"), "final" to (if (h.last) "1" else "0"), "unreachable" to (if (h.unreachable) "1" else null), "run" to run?.let { Json.str(it) })
            if (h.last) { reached = !h.unreachable; break }
            if (h.ip == null) { if (++silent >= silentMax) break } else silent = 0
        }
        Reply.done(c, id, cmd, null, extra = arrayOf("host" to Json.str(host), "hops" to hops.toString(), "reached" to (if (reached) "1" else "0")))
    }

    /**
     * Сырой IPv4-пакет с заголовком (root): `su -c app_process` запускает RawMain из APK от имени root — у него есть CAP_NET_RAW.
     * Включается тем же переключателем root-функций в Settings, что и перехват пакетов. Hex и интерфейс идут в оболочку только после проверки.
     */
    private fun raw(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        if (!cfg.sniffer) return Reply.done(c, id, cmd, "root features are off — tick «Allow root features» in the app Settings", "forbidden")
        val d = Args.hex(j.optString("hex"), 1500)?.takeIf { it.size >= 20 && (it[0].toInt() shr 4) == 4 } ?: return Reply.done(c, id, cmd, "hex: a complete IPv4 packet (header + payload), 20…1500 bytes")
        val apk = ctx.applicationInfo.sourceDir
        if (!Regex("[A-Za-z0-9_./=-]+").matches(apk)) return Reply.done(c, id, cmd, "unexpected app path")
        val (code, out) = RootSh.run("CLASSPATH=$apk app_process /system/bin app.dsp.phone.RawMain ${Hex.of(d)}")
        if (code == 0) Reply.done(c, id, cmd, null, extra = arrayOf("n" to d.size.toString()))
        else Reply.done(c, id, cmd, if (code == -1) "su: ${out.trim().ifEmpty { "no root" }}" else "raw send failed: ${out.trim().take(200)}")
    }

    fun held(): Int = tcp.size + servers.size + udp.size

    /** Закрывает сокеты, оставленные открытыми; сам пул остаётся — новые команды работают. */
    fun release() {
        for (t in tcp.values) try { t.s.close() } catch (e: Exception) {}
        for (s in servers.values) try { s.close() } catch (e: Exception) {}
        for (s in udp.values) try { s.close() } catch (e: Exception) {}
        tcp.clear(); servers.clear(); udp.clear(); mcIds.clear(); info.clear(); mcRelease(); watchOff()
    }

    fun close() {
        for (t in tcp.values) try { t.s.close() } catch (e: Exception) {}
        for (s in servers.values) try { s.close() } catch (e: Exception) {}
        for (s in udp.values) try { s.close() } catch (e: Exception) {}
        tcp.clear(); servers.clear(); udp.clear(); mcIds.clear(); info.clear(); mcRelease(); watchOff(); sched.shutdownNow(); pool.shutdownNow()
    }
}

/** Запускается под root через app_process (см. NetHub.raw): отправляет один IPv4-пакет сырым сокетом. Печатает «ok» или ошибку. */
object RawMain {
    @JvmStatic
    fun main(args: Array<String>) {
        try {
            val d = Args.hex(args.firstOrNull()) ?: throw IllegalArgumentException("hex")
            val dst = InetAddress.getByAddress(byteArrayOf(d[16], d[17], d[18], d[19]))
            val fd = android.system.Os.socket(android.system.OsConstants.AF_INET, android.system.OsConstants.SOCK_RAW, android.system.OsConstants.IPPROTO_RAW)
            try { android.system.Os.sendto(fd, d, 0, d.size, 0, dst, 0) } finally { android.system.Os.close(fd) }
            println("ok")
        } catch (e: Throwable) { println("error: ${e.message}"); System.exit(1) }
    }
}

/** Очередь отправки одного соединения: задачи выполняются одна за другой в одном потоке, поток засыпает через 5 с простоя. */
class SerialTx {
    private val ex = java.util.concurrent.ThreadPoolExecutor(0, 1, 5L, java.util.concurrent.TimeUnit.SECONDS, java.util.concurrent.LinkedBlockingQueue<Runnable>(), java.util.concurrent.ThreadFactory { r -> Thread(r, "dsp-net-tx").also { it.isDaemon = true } })
    fun execute(r: Runnable) { ex.execute(r) }
}
