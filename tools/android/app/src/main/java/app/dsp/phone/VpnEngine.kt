package app.dsp.phone

import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * Пользовательский стек IPv4 для VPN-службы: пакеты приложений приходят из TUN (или со страницы), каждое TCP-соединение и UDP-поток
 * переносится на настоящий сокет, ответы собираются в пакеты обратно. Так телефон остаётся в сети, а мы видим каждое соединение
 * (приложение, адрес, имя из DNS / SNI / Host, байты) и, если нужно, каждый пакет целиком.
 * Без android.* — проверяется на JVM против настоящего TCP ядра Linux (tools/android/jvm-test, tools/vpn-e2e).
 *
 * TCP: TUN без потерь и перестановок, поэтому стек простой — принимает сегменты по порядку (чужой порядок — повторный ACK), окно
 * 65535 без масштабирования, MSS по MTU, повтор неподтверждённого по таймеру. IPv6, фрагменты IP и ICMP не разбираются (считаются).
 */
object Ip {
    fun u8(b: ByteArray, o: Int) = b[o].toInt() and 255
    fun u16(b: ByteArray, o: Int) = (u8(b, o) shl 8) or u8(b, o + 1)
    fun u32(b: ByteArray, o: Int): Int = (u8(b, o) shl 24) or (u8(b, o + 1) shl 16) or (u8(b, o + 2) shl 8) or u8(b, o + 3)
    fun put16(b: ByteArray, o: Int, v: Int) { b[o] = (v shr 8).toByte(); b[o + 1] = v.toByte() }
    fun put32(b: ByteArray, o: Int, v: Int) { b[o] = (v shr 24).toByte(); b[o + 1] = (v shr 16).toByte(); b[o + 2] = (v shr 8).toByte(); b[o + 3] = v.toByte() }
    fun str(b: ByteArray, o: Int) = "${u8(b, o)}.${u8(b, o + 1)}.${u8(b, o + 2)}.${u8(b, o + 3)}"

    /** Сумма 16-битных слов (без инверсии) — для псевдозаголовка и тела. */
    fun sum(b: ByteArray, off: Int, len: Int, init: Long = 0): Long {
        var s = init; var i = off; val end = off + len
        while (i + 1 < end) { s += (u8(b, i) shl 8) or u8(b, i + 1); i += 2 }
        if (i < end) s += u8(b, i) shl 8
        return s
    }
    fun fold(s0: Long): Int { var s = s0; while (s shr 16 != 0L) s = (s and 0xFFFF) + (s shr 16); return s.inv().toInt() and 0xFFFF }
    fun pseudo(src: ByteArray, dst: ByteArray, proto: Int, len: Int): Long = sum(src, 0, 4) + sum(dst, 0, 4) + proto + len

    private val ids = AtomicInteger((Math.random() * 65535).toInt())

    /** IPv4-пакет: заголовок без опций + полезная нагрузка уже лежит в payload[0, plen). */
    fun wrap(src: ByteArray, dst: ByteArray, proto: Int, payload: ByteArray, plen: Int): ByteArray {
        val p = ByteArray(20 + plen)
        p[0] = 0x45; put16(p, 2, 20 + plen); put16(p, 4, ids.incrementAndGet() and 0xFFFF); put16(p, 6, 0x4000)
        p[8] = 64; p[9] = proto.toByte()
        System.arraycopy(src, 0, p, 12, 4); System.arraycopy(dst, 0, p, 16, 4)
        put16(p, 10, fold(sum(p, 0, 20)))
        System.arraycopy(payload, 0, p, 20, plen)
        return p
    }

    fun tcp(src: ByteArray, dst: ByteArray, sport: Int, dport: Int, seq: Int, ack: Int, flags: Int, win: Int, data: ByteArray?, doff: Int, dlen: Int, mss: Int = 0): ByteArray {
        val opt = if (mss > 0) 4 else 0
        val t = ByteArray(20 + opt + dlen)
        put16(t, 0, sport); put16(t, 2, dport); put32(t, 4, seq); put32(t, 8, ack)
        t[12] = (((20 + opt) / 4) shl 4).toByte(); t[13] = flags.toByte(); put16(t, 14, win)
        if (mss > 0) { t[20] = 2; t[21] = 4; put16(t, 22, mss) }
        if (dlen > 0) System.arraycopy(data!!, doff, t, 20 + opt, dlen)
        put16(t, 16, fold(sum(t, 0, t.size, pseudo(src, dst, 6, t.size))))
        return wrap(src, dst, 6, t, t.size)
    }

    fun udp(src: ByteArray, dst: ByteArray, sport: Int, dport: Int, data: ByteArray, doff: Int, dlen: Int): ByteArray {
        val u = ByteArray(8 + dlen)
        put16(u, 0, sport); put16(u, 2, dport); put16(u, 4, 8 + dlen)
        System.arraycopy(data, doff, u, 8, dlen)
        var c = fold(sum(u, 0, u.size, pseudo(src, dst, 17, u.size))); if (c == 0) c = 0xFFFF
        put16(u, 6, c)
        return wrap(src, dst, 17, u, u.size)
    }
}

/** DNS-ответ: имя вопроса и адреса из ответов (A, AAAA) — чтобы подписать соединения именами. */
object DnsSniff {
    class Msg(val response: Boolean, val rcode: Int, val name: String, val type: Int, val ips: List<String>)

    fun parse(b: ByteArray, off: Int, len: Int): Msg? {
        try {
            val end = off + len; if (len < 12) return null
            val flags = Ip.u16(b, off + 2); val qd = Ip.u16(b, off + 4); val an = Ip.u16(b, off + 6)
            var p = off + 12; var name = ""; var type = 0
            for (i in 0 until qd) { val (n, np) = readName(b, off, end, p); if (i == 0) { name = n; type = Ip.u16(b, np) }; p = np + 4 }
            val ips = ArrayList<String>()
            for (i in 0 until an) {
                val (_, np) = readName(b, off, end, p); p = np
                val t = Ip.u16(b, p); val rl = Ip.u16(b, p + 8); p += 10
                if (p + rl > end) break
                if (t == 1 && rl == 4) ips.add(Ip.str(b, p))
                else if (t == 28 && rl == 16) ips.add(InetAddress.getByAddress(b.copyOfRange(p, p + 16)).hostAddress ?: "")
                p += rl
            }
            return Msg(flags and 0x8000 != 0, flags and 15, name, type, ips)
        } catch (e: Exception) { return null }
    }

    private fun readName(b: ByteArray, base: Int, end: Int, start: Int): Pair<String, Int> {
        val sb = StringBuilder(); var p = start; var next = -1; var hops = 0
        while (true) {
            val l = Ip.u8(b, p)
            if (l == 0) { p++; break }
            if (l and 0xC0 == 0xC0) { if (next < 0) next = p + 2; p = base + (((l and 0x3F) shl 8) or Ip.u8(b, p + 1)); if (++hops > 20) throw IllegalArgumentException("loop"); continue }
            if (sb.isNotEmpty()) sb.append('.')
            sb.append(String(b, p + 1, l, Charsets.ISO_8859_1)); p += 1 + l
            if (p > end) throw IllegalArgumentException("long")
        }
        return Pair(sb.toString(), if (next >= 0) next else p)
    }
}

/** Имя сервера из первых байт потока: TLS ClientHello (SNI) или HTTP-запрос (Host). */
object NameSniff {
    fun host(b: ByteArray, off: Int, len: Int): String? = tls(b, off, len) ?: http(b, off, len)

    fun tls(b: ByteArray, off: Int, len: Int): String? {
        try {
            if (len < 48 || Ip.u8(b, off) != 0x16 || Ip.u8(b, off + 5) != 1) return null
            val end = off + len; var p = off + 9 + 2 + 32
            p += 1 + Ip.u8(b, p)
            p += 2 + Ip.u16(b, p)
            p += 1 + Ip.u8(b, p)
            val extEnd = minOf(end, p + 2 + Ip.u16(b, p)); p += 2
            while (p + 4 <= extEnd) {
                val t = Ip.u16(b, p); val l = Ip.u16(b, p + 2); p += 4
                if (t == 0 && l >= 5) { val nl = Ip.u16(b, p + 3); return String(b, p + 5, minOf(nl, extEnd - p - 5), Charsets.ISO_8859_1) }
                p += l
            }
        } catch (e: Exception) { }
        return null
    }

    fun http(b: ByteArray, off: Int, len: Int): String? {
        if (len < 16) return null
        val head = String(b, off, minOf(len, 1024), Charsets.ISO_8859_1)
        if (!Regex("^(GET|POST|HEAD|PUT|DELETE|OPTIONS|PATCH|CONNECT) ").containsMatchIn(head)) return null
        return Regex("\r\nHost:[ \t]*([^\r\n]+)", RegexOption.IGNORE_CASE).find(head)?.groupValues?.get(1)?.trim()
    }
}

/** Кто владелец соединения: uid и пакеты (если приложение известно). */
class Owner(val uid: Int, val pkgs: List<String>, val label: String)

class FlowInfo(val id: Int, val proto: Int, val src: String, val sport: Int, val dst: String, val dport: Int) {
    @Volatile var owner: Owner? = null
    @Volatile var host: String? = null
    @Volatile var l7: String? = null          // tls / http / dns — по первым байтам
    @Volatile var state = "new"
    @Volatile var up = 0L; @Volatile var down = 0L
    @Volatile var pktUp = 0; @Volatile var pktDown = 0
    val started = System.currentTimeMillis()
    @Volatile var last = started
    @Volatile var reported = 0L
}

interface VpnSockets {
    /** Соединённый TCP-сокет к серверу (в Android — protect()-нутый, чтобы не зациклиться в TUN). */
    fun tcp(dst: InetAddress, port: Int, timeoutMs: Int): Socket
    fun udp(): DatagramSocket
}

interface VpnEvents {
    fun owner(proto: Int, src: InetSocketAddress, dst: InetSocketAddress): Owner? = null
    /** kind: open | host | close; промежуточные счётчики — snapshot(). */
    fun flow(f: FlowInfo, kind: String) {}
    /** Каждый пакет целиком: out — от приложения в сеть; f — поток (null, если ещё не заведён). */
    fun packet(out: Boolean, p: ByteArray, len: Int, f: FlowInfo?) {}
    fun dns(f: FlowInfo?, q: DnsSniff.Msg, ms: Long) {}
}

class VpnEngine(private val out: (ByteArray) -> Unit, private val socks: VpnSockets, private val ev: VpnEvents, val mtu: Int = 1500) {
    private val mss = mtu - 40
    private val flows = ConcurrentHashMap<String, Any>()
    private val ids = AtomicInteger(0)
    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "dsp-vpn").also { it.isDaemon = true } }
    private val timer: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "dsp-vpn-timer").also { it.isDaemon = true } }
    private val names = ConcurrentHashMap<String, Pair<String, Long>>()      // ip → имя из DNS-ответов
    @Volatile private var running = true
    val maxFlows = 3000
    val stats = ConcurrentHashMap<String, AtomicLong>()
    private fun count(k: String) = stats.computeIfAbsent(k) { AtomicLong() }.incrementAndGet()
    private val lock = Any()

    init { timer.scheduleWithFixedDelay({ try { tick() } catch (e: Throwable) { } }, 250, 250, TimeUnit.MILLISECONDS) }

    /** Пакет от приложения (из TUN): разбор и передача потоку. */
    fun input(b: ByteArray, len: Int) {
        if (!running || len < 20) return
        val ver = Ip.u8(b, 0) shr 4
        if (ver != 4) { count(if (ver == 6) "ipv6 dropped" else "bad version"); return }
        val ihl = (Ip.u8(b, 0) and 15) * 4; val total = Ip.u16(b, 2)
        if (ihl < 20 || total > len || total < ihl) { count("bad length"); return }
        if (Ip.u16(b, 6) and 0x3FFF != 0) { count("fragment dropped"); return }
        val proto = Ip.u8(b, 9)
        when (proto) {
            6 -> tcpIn(b, ihl, total)
            17 -> udpIn(b, ihl, total)
            else -> { count("proto $proto dropped"); ev.packet(true, b, total, null) }
        }
    }

    fun snapshot(): List<FlowInfo> = flows.values.map { if (it is TcpFlow) it.info else (it as UdpFlow).info }

    fun nameOf(ip: String): String? = names[ip]?.first

    fun close() {
        running = false
        timer.shutdownNow()
        for (f in flows.values.toList()) if (f is TcpFlow) f.close(false) else (f as UdpFlow).close()
        pool.shutdownNow()
    }

    // ------------------------------------------------------------ UDP

    private fun udpIn(b: ByteArray, ihl: Int, total: Int) {
        val src = b.copyOfRange(12, 16); val dst = b.copyOfRange(16, 20)
        val sport = Ip.u16(b, ihl); val dport = Ip.u16(b, ihl + 2); val ulen = Ip.u16(b, ihl + 4)
        if (ulen < 8 || ihl + ulen > total) { count("bad udp"); return }
        val key = "u|${Ip.str(src, 0)}:$sport|${Ip.str(dst, 0)}:$dport"
        var f = flows[key] as UdpFlow?
        if (f == null) {
            if (flows.size >= maxFlows) { count("flow limit"); return }
            f = try { UdpFlow(key, src, sport, dst, dport) } catch (e: Exception) { count("udp socket failed"); return }
            flows[key] = f
            f.start()
        }
        ev.packet(true, b, total, f.info)
        f.send(b, ihl + 8, ulen - 8)
    }

    private inner class UdpFlow(val key: String, val csrc: ByteArray, val cport: Int, val sdst: ByteArray, val sport: Int) {
        val info = FlowInfo(ids.incrementAndGet(), 17, Ip.str(csrc, 0), cport, Ip.str(sdst, 0), sport)
        val sock: DatagramSocket = socks.udp()
        val dest = InetSocketAddress(InetAddress.getByAddress(sdst), sport)
        @Volatile var closed = false
        @Volatile var asked = 0L
        val idle = if (sport == 53 || sport == 5353) 10_000L else 60_000L

        fun start() {
            info.owner = ev.owner(17, InetSocketAddress(InetAddress.getByAddress(csrc), cport), dest)
            info.host = nameOf(info.dst)
            if (sport == 53) info.l7 = "dns"
            info.state = "open"; ev.flow(info, "open")
            pool.execute { receive() }
        }

        fun send(b: ByteArray, off: Int, len: Int) {
            info.last = System.currentTimeMillis(); info.up += len; info.pktUp++
            if (sport == 53) { asked = System.nanoTime(); DnsSniff.parse(b, off, len)?.let { if (!it.response && info.host == null) info.host = it.name } }
            try { sock.send(DatagramPacket(b.copyOfRange(off, off + len), len, dest)) } catch (e: Exception) { count("udp send failed") }
        }

        private fun receive() {
            val buf = ByteArray(65535)
            try {
                while (!closed) {
                    val p = DatagramPacket(buf, buf.size); sock.receive(p)
                    info.last = System.currentTimeMillis(); info.down += p.length; info.pktDown++
                    if (sport == 53) DnsSniff.parse(buf, 0, p.length)?.let { m ->
                        if (m.response) { for (ip in m.ips) names[ip] = Pair(m.name, System.currentTimeMillis()); ev.dns(info, m, if (asked > 0) (System.nanoTime() - asked) / 1_000_000 else 0) }
                    }
                    // ответ приходит с адреса, куда слали; если сервер ответил с другого (многоадресные), подмены не делаем — только вернём как есть
                    val pkt = Ip.udp(sdst, csrc, sport, cport, buf, 0, p.length)
                    ev.packet(false, pkt, pkt.size, info)
                    out(pkt)
                }
            } catch (e: Exception) { }
            close()
        }

        fun close() {
            if (closed) return; closed = true
            try { sock.close() } catch (e: Exception) { }
            flows.remove(key); info.state = "closed"; ev.flow(info, "close")
        }
    }

    // ------------------------------------------------------------ TCP

    private fun tcpIn(b: ByteArray, ihl: Int, total: Int) {
        if (total - ihl < 20) { count("bad tcp"); return }
        val src = b.copyOfRange(12, 16); val dst = b.copyOfRange(16, 20)
        val sport = Ip.u16(b, ihl); val dport = Ip.u16(b, ihl + 2)
        val flags = Ip.u8(b, ihl + 13)
        val key = "t|${Ip.str(src, 0)}:$sport|${Ip.str(dst, 0)}:$dport"
        var f = flows[key] as TcpFlow?
        if (f == null) {
            if (flags and 0x04 != 0) return                                            // RST по неизвестному потоку
            if (flags and 0x12 != 0x02) {                                              // не SYN — стёртый поток: сообщаем отказом
                ev.packet(true, b, total, null)
                val seq = Ip.u32(b, ihl + 4); val ack = Ip.u32(b, ihl + 8)
                val dlen = total - ihl - ((Ip.u8(b, ihl + 12) shr 4) * 4)
                val r = if (flags and 0x10 != 0) Ip.tcp(dst, src, dport, sport, ack, 0, 0x04, 0, null, 0, 0)
                        else Ip.tcp(dst, src, dport, sport, 0, seq + dlen + (if (flags and 0x03 != 0) 1 else 0), 0x14, 0, null, 0, 0)
                out(r); return
            }
            if (flows.size >= maxFlows) { count("flow limit"); out(Ip.tcp(dst, src, dport, sport, 0, Ip.u32(b, ihl + 4) + 1, 0x14, 0, null, 0, 0)); return }
            f = TcpFlow(key, src, sport, dst, dport)
            flows[key] = f
            ev.packet(true, b, total, f.info)
            f.syn(b, ihl, total)
            return
        }
        ev.packet(true, b, total, f.info)
        f.segment(b, ihl, total)
    }

    private fun seqLt(a: Int, b: Int) = (a - b) < 0
    private fun seqLe(a: Int, b: Int) = (a - b) <= 0

    private class Seg(val seq: Int, val data: ByteArray, val fin: Boolean) {
        var sentAt = System.currentTimeMillis(); var tries = 0
        val end: Int get() = seq + data.size + (if (fin) 1 else 0)
    }

    private val EOF = ByteArray(0)

    private inner class TcpFlow(val key: String, val csrc: ByteArray, val cport: Int, val sdst: ByteArray, val sport: Int) {
        val info = FlowInfo(ids.incrementAndGet(), 6, Ip.str(csrc, 0), cport, Ip.str(sdst, 0), sport)
        val lock = Object()
        var state = 0                    // 0 соединяемся, 1 послан SYN-ACK, 2 установлено, 3 закрыто
        var rcvNxt = 0; var sndNxt = 0; var sndUna = 0; var isn = 0
        var peerWnd = 65535; var peerMss = 536
        var sock: Socket? = null
        val unacked = ArrayDeque<Seg>()
        var finSent = false; var clientFin = false
        val writeQ = LinkedBlockingQueue<ByteArray>(); val queued = AtomicInteger(0)
        var sniffed = false; var synAckAt = 0L; var synAckTries = 0
        var lastWndSent = 65535

        val ourWnd: Int get() = (65535 - queued.get()).coerceIn(0, 65535)

        fun send(flags: Int, data: ByteArray?, off: Int, len: Int, seq: Int, mssOpt: Int = 0) {
            val w = ourWnd; lastWndSent = w
            val p = Ip.tcp(sdst, csrc, sport, cport, seq, rcvNxt, flags, w, data, off, len, mssOpt)
            ev.packet(false, p, p.size, info); info.pktDown++
            out(p)
        }

        fun ack() = send(0x10, null, 0, 0, sndNxt)

        fun syn(b: ByteArray, ihl: Int, total: Int) {
            rcvNxt = Ip.u32(b, ihl + 4) + 1
            peerWnd = Ip.u16(b, ihl + 14)
            // опции: MSS
            var p = ihl + 20; val oEnd = ihl + ((Ip.u8(b, ihl + 12) shr 4) * 4)
            while (p < oEnd) { val k = Ip.u8(b, p); if (k == 0) break; if (k == 1) { p++; continue }; val l = Ip.u8(b, p + 1); if (l < 2) break; if (k == 2 && l == 4) peerMss = Ip.u16(b, p + 2); p += l }
            info.owner = ev.owner(6, InetSocketAddress(InetAddress.getByAddress(csrc), cport), InetSocketAddress(InetAddress.getByAddress(sdst), sport))
            info.host = nameOf(info.dst); info.state = "connecting"; ev.flow(info, "open")
            pool.execute {
                try {
                    val s = socks.tcp(InetAddress.getByAddress(sdst), sport, 8000)
                    s.tcpNoDelay = true
                    synchronized(lock) {
                        if (state == 3) { try { s.close() } catch (e: Exception) { }; return@execute }
                        sock = s; isn = (Math.random() * Int.MAX_VALUE).toInt(); sndNxt = isn + 1; sndUna = isn
                        state = 1; synAckAt = System.currentTimeMillis()
                        send(0x12, null, 0, 0, isn, minOf(mss, 1460))
                    }
                } catch (e: Exception) {
                    info.state = "failed: ${e.javaClass.simpleName}"
                    synchronized(lock) { state = 3 }
                    flows.remove(key)
                    val p = Ip.tcp(sdst, csrc, sport, cport, 0, rcvNxt, 0x14, 0, null, 0, 0); ev.packet(false, p, p.size, info); out(p)
                    ev.flow(info, "close")
                }
            }
        }

        fun segment(b: ByteArray, ihl: Int, total: Int) {
            val flags = Ip.u8(b, ihl + 13); val seq = Ip.u32(b, ihl + 4); val ackNo = Ip.u32(b, ihl + 8)
            val doff = ihl + ((Ip.u8(b, ihl + 12) shr 4) * 4); val dlen = total - doff
            synchronized(lock) {
                if (state == 3) return
                if (flags and 0x04 != 0) { close(false); return }                       // RST от приложения
                if (state == 0) return                                                   // повтор SYN, пока соединяемся
                if (flags and 0x02 != 0) {                                               // повтор SYN: повторим SYN-ACK
                    if (state == 1) { synAckAt = System.currentTimeMillis(); send(0x12, null, 0, 0, isn, minOf(mss, 1460)) }
                    return
                }
                if (flags and 0x10 != 0) {
                    if (state == 1 && ackNo == isn + 1) { state = 2; info.state = "established"; startPumps() }
                    if (state == 2 && seqLe(sndUna, ackNo) && seqLe(ackNo, sndNxt)) {
                        while (unacked.isNotEmpty() && seqLe(unacked.first().end, ackNo)) unacked.removeFirst()
                        sndUna = ackNo; peerWnd = Ip.u16(b, ihl + 14); lock.notifyAll()
                        if (finSent && sndUna == sndNxt && clientFin) { close(false); return }
                    }
                }
                if (state != 2) return
                var start = doff; var n = dlen; var s = seq
                if (n > 0 || flags and 0x01 != 0) {
                    if (seqLt(s, rcvNxt)) {                                              // уже принятое (повтор): пересечение обрезаем
                        val skip = rcvNxt - s
                        if (skip >= n) { n = 0; s = rcvNxt } else { start += skip; n -= skip; s = rcvNxt }
                    }
                    if (s != rcvNxt) { ack(); return }                                   // пропуск впереди: повторный ACK
                    if (n > 0) {
                        if (!sniffed) { sniffed = true; val h = NameSniff.host(b, start, n); if (h != null) { info.host = h; info.l7 = if (NameSniff.tls(b, start, n) != null) "tls" else "http"; ev.flow(info, "host") } }
                        val chunk = b.copyOfRange(start, start + n); rcvNxt += n; info.up += n; info.last = System.currentTimeMillis()
                        queued.addAndGet(n); writeQ.add(chunk)
                    }
                    if (flags and 0x01 != 0 && !clientFin) { clientFin = true; rcvNxt += 1; writeQ.add(EOF) }
                    ack()
                }
            }
        }

        private fun startPumps() {
            val s = sock ?: return
            pool.execute {                                                               // приложение → сервер
                try {
                    val os = s.getOutputStream()
                    while (true) {
                        val c = writeQ.take()
                        if (c === EOF) { try { s.shutdownOutput() } catch (e: Exception) { }; break }
                        os.write(c); os.flush()
                        val before = queued.getAndAdd(-c.size)
                        if (before >= 32768 && before - c.size < 32768) synchronized(lock) { if (state == 2) ack() }     // окно снова открыто
                    }
                } catch (e: Exception) { close(true) }
            }
            pool.execute {                                                               // сервер → приложение
                val buf = ByteArray(mss)
                try {
                    val ins = s.getInputStream()
                    while (true) {
                        var allow: Int
                        synchronized(lock) {
                            while (state == 2) {
                                allow = minOf(minOf(mss, peerMss), minOf(peerWnd, 262144) - (sndNxt - sndUna))
                                if (allow > 0) break
                                lock.wait(500)
                            }
                            if (state != 2) return@execute
                        }
                        allow = minOf(minOf(mss, peerMss), buf.size)
                        val n = ins.read(buf, 0, allow)
                        synchronized(lock) {
                            if (state != 2) return@execute
                            if (n < 0) {
                                if (!finSent) { finSent = true; unacked.addLast(Seg(sndNxt, EOF, true)); send(0x11, null, 0, 0, sndNxt); sndNxt += 1; info.state = "closing" }
                                return@execute
                            }
                            val d = buf.copyOf(n)
                            unacked.addLast(Seg(sndNxt, d, false))
                            send(0x18, d, 0, n, sndNxt); sndNxt += n; info.down += n; info.last = System.currentTimeMillis()
                        }
                    }
                } catch (e: Exception) { close(true) }
            }
        }

        fun retransmit(now: Long) {
            synchronized(lock) {
                if (state == 1 && now - synAckAt > 1000) {
                    if (++synAckTries > 4) { close(true); return }
                    synAckAt = now; send(0x12, null, 0, 0, isn, minOf(mss, 1460)); return
                }
                if (state != 2) return
                val s = unacked.firstOrNull() ?: return
                val rto = minOf(8000L, 800L shl minOf(s.tries, 4))
                if (now - s.sentAt < rto) return
                if (++s.tries > 10) { close(true); return }
                s.sentAt = now
                send(if (s.fin) 0x11 else 0x18, s.data, 0, s.data.size, s.seq)
            }
        }

        fun idleFor(now: Long) = now - info.last

        fun close(rst: Boolean) {
            synchronized(lock) {
                if (state == 3) return
                val was = state; state = 3
                if (rst && was >= 1) { val p = Ip.tcp(sdst, csrc, sport, cport, sndNxt, rcvNxt, 0x14, 0, null, 0, 0); ev.packet(false, p, p.size, info); out(p) }
                try { sock?.close() } catch (e: Exception) { }
                writeQ.add(EOF); lock.notifyAll()
            }
            flows.remove(key); info.state = "closed"; ev.flow(info, "close")
        }
    }

    private fun tick() {
        val now = System.currentTimeMillis()
        for (f in flows.values.toList()) {
            if (f is TcpFlow) { f.retransmit(now); if (f.idleFor(now) > 900_000) f.close(true) }
            else if (f is UdpFlow && now - f.info.last > f.idle) f.close()
        }
        val old = now - 600_000; names.entries.removeIf { it.value.second < old }
    }
}
