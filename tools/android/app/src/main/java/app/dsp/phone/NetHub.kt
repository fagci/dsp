package app.dsp.phone

import android.content.Context
import android.net.ConnectivityManager
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Сеть из графа: TCP-клиент и сервер, UDP, ping, разовый UDP-запрос (для DNS и прочих запрос-ответ протоколов), сведения о сети
 * и сырые IPv4-пакеты (root). Записи: {src:'net', ev:'open'|'accept'|'data'|'close'|'ping'|'error', conn, proto, peer, hex, text}.
 * Все команды — только доверенному клиенту (страница приложения или «любая страница» в Settings): через них телефон ходит по сети.
 */
class NetHub(private val ctx: Context, private val cfg: Config, private val emit: Emit) {
    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "dsp-net").also { it.isDaemon = true } }
    private val ids = AtomicInteger(0)

    private class TcpConn(val s: Socket, val server: Int?)
    private val tcp = ConcurrentHashMap<Int, TcpConn>()
    private val servers = ConcurrentHashMap<Int, ServerSocket>()
    private val udp = ConcurrentHashMap<Int, DatagramSocket>()

    private fun rec(ev: String, vararg kv: Pair<String, String?>) =
        emit("net", Json.obj("src" to "\"net\"", "ev" to Json.str(ev), "t" to System.currentTimeMillis().toString(), *kv))

    private fun dataKv(b: ByteArray) = arrayOf<Pair<String, String?>>("hex" to Json.str(Hex.of(b)), "n" to b.size.toString(), "text" to Json.str(String(b, Charsets.UTF_8)))

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        pool.execute {
            try { run(c, id, cmd, j) }
            catch (e: SecurityException) { Reply.done(c, id, cmd, "permission: ${e.message}", "permission") }
            catch (e: Exception) { Reply.done(c, id, cmd, e.message ?: e.javaClass.simpleName) }
        }
    }

    private fun run(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        when (cmd) {
            "tcp.connect" -> {
                val host = Args.host(j.optString("host")) ?: return Reply.done(c, id, cmd, "host")
                val port = j.optInt("port"); if (!Args.port(port)) return Reply.done(c, id, cmd, "port: 1…65535")
                if (tcp.size >= 32) return Reply.done(c, id, cmd, "32 connections at most")
                val s = Socket()
                try { s.connect(InetSocketAddress(host, port), j.optInt("timeout", 5000).coerceIn(200, 60_000)) }
                catch (e: Exception) { s.close(); return Reply.done(c, id, cmd, "${e.javaClass.simpleName}: ${e.message}") }
                val n = ids.incrementAndGet(); tcp[n] = TcpConn(s, null)
                rec("open", "conn" to n.toString(), "proto" to "\"tcp\"", "peer" to Json.str("$host:$port"))
                Reply.done(c, id, cmd, null, extra = arrayOf("conn" to n.toString()))
                pool.execute { readTcp(n, s) }
            }
            "tcp.listen" -> {
                val port = j.optInt("port"); if (port !in 1024..65535) return Reply.done(c, id, cmd, "port: 1024…65535 (an app cannot take lower ones)")
                if (servers.size >= 4) return Reply.done(c, id, cmd, "4 servers at most")
                val ss = ServerSocket(); ss.reuseAddress = true
                ss.bind(InetSocketAddress(if (j.optBoolean("lan", true)) InetAddress.getByName("0.0.0.0") else InetAddress.getByName("127.0.0.1"), port))
                val sid = ids.incrementAndGet(); servers[sid] = ss
                Reply.done(c, id, cmd, null, extra = arrayOf("server" to sid.toString(), "port" to ss.localPort.toString()))
                pool.execute {
                    try {
                        while (true) {
                            val s = ss.accept()
                            if (tcp.size >= 32) { s.close(); continue }
                            val n = ids.incrementAndGet(); tcp[n] = TcpConn(s, sid)
                            rec("accept", "conn" to n.toString(), "server" to sid.toString(), "proto" to "\"tcp\"", "peer" to Json.str(s.remoteSocketAddress.toString().trimStart('/')))
                            pool.execute { readTcp(n, s) }
                        }
                    } catch (e: Exception) { /* закрыт */ }
                    servers.remove(sid); rec("close", "server" to sid.toString(), "proto" to "\"tcp\"")
                }
            }
            "tcp.send" -> {
                val t = tcp[j.optInt("conn")] ?: return Reply.done(c, id, cmd, "no such connection")
                val d = Args.payload(j) ?: return Reply.done(c, id, cmd, "hex or text")
                t.s.getOutputStream().apply { write(d); flush() }
                Reply.done(c, id, cmd, null, extra = arrayOf("n" to d.size.toString()))
            }
            "tcp.close", "udp.close" -> {
                val n = if (j.has("server")) j.optInt("server") else j.optInt("conn")
                tcp.remove(n)?.s?.close(); servers.remove(n)?.close(); udp.remove(n)?.close()
                Reply.done(c, id, cmd, null)
            }
            "udp.open" -> {
                val port = j.optInt("port", 0); if (port != 0 && port !in 1024..65535) return Reply.done(c, id, cmd, "port: 0 (any) or 1024…65535")
                if (udp.size >= 16) return Reply.done(c, id, cmd, "16 sockets at most")
                val s = DatagramSocket(null); s.reuseAddress = true; s.broadcast = j.optBoolean("broadcast", false)
                s.bind(InetSocketAddress(port))
                val n = ids.incrementAndGet(); udp[n] = s
                Reply.done(c, id, cmd, null, extra = arrayOf("conn" to n.toString(), "port" to s.localPort.toString()))
                pool.execute {
                    val buf = ByteArray(65535)
                    try {
                        while (true) {
                            val p = DatagramPacket(buf, buf.size); s.receive(p)
                            rec("data", "conn" to n.toString(), "proto" to "\"udp\"", "peer" to Json.str(p.address.hostAddress + ":" + p.port), *dataKv(buf.copyOf(p.length)))
                        }
                    } catch (e: Exception) { /* закрыт */ }
                    udp.remove(n); rec("close", "conn" to n.toString(), "proto" to "\"udp\"")
                }
            }
            "udp.send" -> {
                val host = Args.host(j.optString("host")) ?: return Reply.done(c, id, cmd, "host")
                val port = j.optInt("port"); if (!Args.port(port)) return Reply.done(c, id, cmd, "port: 1…65535")
                val d = Args.payload(j, 65507) ?: return Reply.done(c, id, cmd, "hex or text: up to 65507 bytes")
                val own = udp[j.optInt("conn")]
                val s = own ?: DatagramSocket().also { it.broadcast = j.optBoolean("broadcast", false) }
                try { s.send(DatagramPacket(d, d.size, InetAddress.getByName(host), port)) } finally { if (own == null) s.close() }
                Reply.done(c, id, cmd, null, extra = arrayOf("n" to d.size.toString()))
            }
            "udp.request" -> {
                // host «@dns» — первый DNS-сервер сети телефона
                var host = j.optString("host")
                if (host == "@dns") host = dnsServers().firstOrNull() ?: return Reply.done(c, id, cmd, "no DNS server in the network")
                host = Args.host(host) ?: return Reply.done(c, id, cmd, "host")
                val port = j.optInt("port", 53); if (!Args.port(port)) return Reply.done(c, id, cmd, "port: 1…65535")
                val d = Args.payload(j, 65507) ?: return Reply.done(c, id, cmd, "hex or text")
                DatagramSocket().use { s ->
                    s.soTimeout = j.optInt("timeout", 3000).coerceIn(100, 30_000)
                    val t0 = System.nanoTime()
                    s.send(DatagramPacket(d, d.size, InetAddress.getByName(host), port))
                    val buf = ByteArray(65535); val p = DatagramPacket(buf, buf.size)
                    try { s.receive(p) } catch (e: SocketTimeoutException) { return Reply.done(c, id, cmd, "no answer from $host:$port in ${s.soTimeout} ms", "timeout") }
                    val ms = (System.nanoTime() - t0) / 1e6
                    Reply.done(c, id, cmd, null, extra = arrayOf("hex" to Json.str(Hex.of(buf, 0, p.length)), "n" to p.length.toString(), "ms" to Json.num(ms, 100.0), "server" to Json.str(host)))
                }
            }
            "ping" -> ping(c, id, cmd, j)
            "net.info" -> {
                val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
                val lp = cm.activeNetwork?.let { cm.getLinkProperties(it) }
                val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
                Reply.done(c, id, cmd, null, extra = arrayOf(
                    "dns" to Json.arr(dnsServers()), "ips" to Json.arr(BridgeService.lan()),
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

    private fun dnsServers(): List<String> = try {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        cm.activeNetwork?.let { cm.getLinkProperties(it) }?.dnsServers?.mapNotNull { it.hostAddress } ?: emptyList()
    } catch (e: Exception) { emptyList() }

    private fun readTcp(n: Int, s: Socket) {
        val buf = ByteArray(8192)
        try {
            val inp = s.getInputStream()
            while (true) {
                val k = inp.read(buf); if (k < 0) break
                rec("data", "conn" to n.toString(), "proto" to "\"tcp\"", *dataKv(buf.copyOf(k)))
            }
        } catch (e: Exception) { /* обрыв */ }
        tcp.remove(n); try { s.close() } catch (e: Exception) {}
        rec("close", "conn" to n.toString(), "proto" to "\"tcp\"")
    }

    /** ping без root: системный /system/bin/ping (ICMP через ping-сокет); строки разбираются NetParse. */
    private fun ping(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        val host = Args.host(j.optString("host")) ?: return Reply.done(c, id, cmd, "host")
        val count = j.optInt("count", 4).coerceIn(1, 30); val wait = j.optInt("timeout", 2).coerceIn(1, 10)
        val size = j.optInt("size", 56).coerceIn(0, 1400); val ttl = j.optInt("ttl", 0).coerceIn(0, 255)
        val args = ArrayList<String>().apply {
            add("/system/bin/ping"); add("-c"); add(count.toString()); add("-W"); add(wait.toString()); add("-s"); add(size.toString())
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

    fun close() {
        for (t in tcp.values) try { t.s.close() } catch (e: Exception) {}
        for (s in servers.values) try { s.close() } catch (e: Exception) {}
        for (s in udp.values) try { s.close() } catch (e: Exception) {}
        tcp.clear(); servers.clear(); udp.clear(); pool.shutdownNow()
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
