package app.dsp.phone.vpntest

import app.dsp.phone.DnsSniff
import app.dsp.phone.FlowInfo
import app.dsp.phone.Ip
import app.dsp.phone.Owner
import app.dsp.phone.VpnEngine
import app.dsp.phone.VpnEvents
import app.dsp.phone.VpnSockets
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/*
 * VpnEngine — наш собственный TCP/UDP-стек (app/.../VpnEngine.kt), без android.* — проверяется здесь на настоящем ядре
 * Linux: движку дают реальные Socket/DatagramSocket к локальным серверам, а «устройство» (приложение на телефоне) изображаем
 * сами — собираем IP-пакеты руками и ведём свою половину TCP (seq/ack), как делал бы настоящий Android. Для SNI — подлинный
 * ClientHello от openssl s_client, а не выдуманные байты. gradle -p tools/android/jvm-test runVpnEngineTest
 */

private var bad = 0
private fun ok(name: String, c: Boolean, x: String = "") { if (!c) { bad++; println("FAIL $name $x") } else println("ok   $name") }

// Контрольные суммы проверяем своим, независимым кодом — не функциями движка, иначе тест доверял бы тому, что проверяет.
private fun csumOk(b: ByteArray, off: Int, len: Int): Boolean {
    var s = 0L; var i = off; val end = off + len
    while (i + 1 < end) { s += ((b[i].toInt() and 255) shl 8) or (b[i + 1].toInt() and 255); i += 2 }
    if (i < end) s += (b[i].toInt() and 255) shl 8
    while (s shr 16 != 0L) s = (s and 0xFFFF) + (s shr 16)
    return s == 0xFFFFL
}
private fun pseudoSum(src: ByteArray, dst: ByteArray, proto: Int, len: Int): Long {
    var s = 0L
    for (a in listOf(src, dst)) { s += ((a[0].toInt() and 255) shl 8) or (a[1].toInt() and 255); s += ((a[2].toInt() and 255) shl 8) or (a[3].toInt() and 255) }
    return s + proto + len
}
private fun udpCsumOk(ip: ByteArray): Boolean {
    val ihl = (ip[0].toInt() and 15) * 4; val total = Ip.u16(ip, 2)
    val src = ip.copyOfRange(12, 16); val dst = ip.copyOfRange(16, 20); val len = total - ihl
    var s = pseudoSum(src, dst, 17, len); var i = ihl; val end = ihl + len
    while (i + 1 < end) { s += ((ip[i].toInt() and 255) shl 8) or (ip[i + 1].toInt() and 255); i += 2 }
    if (i < end) s += (ip[i].toInt() and 255) shl 8
    while (s shr 16 != 0L) s = (s and 0xFFFF) + (s shr 16)
    return s == 0xFFFFL
}
private fun ipAddr(s: String): ByteArray = InetAddress.getByName(s).address

/** Половина TCP, которую вёл бы телефон: отдаёт SYN / данные / FIN / RST движку, разбирает то, что он прислал в ответ. */
private class FakeDevice(val my: ByteArray, val myPort: Int, val peer: ByteArray, val peerPort: Int, val toEngine: (ByteArray) -> Unit) {
    var seq = (Math.random() * 1_000_000).toInt() + 10_000
    var ack = 0
    val inbox = LinkedBlockingQueue<ByteArray>()
    val data = java.io.ByteArrayOutputStream()
    @Volatile var sawFin = false

    fun accept(p: ByteArray) = inbox.add(p)

    // FIN стоит одного номера последовательности, как и байт данных (RFC 793) — иначе наш ACK потом не совпадёт с тем, чего ждёт движок.
    private fun send(flags: Int, payload: ByteArray = ByteArray(0)) { toEngine(Ip.tcp(my, peer, myPort, peerPort, seq, ack, flags, 65535, payload, 0, payload.size)); seq += payload.size + (if (flags and 0x01 != 0) 1 else 0) }

    /** SYN собран вручную (с опцией MSS) — отдельно от Ip.tcp, чтобы проверить разбор опций движком. */
    fun syn(mss: Int = 1460): ByteArray {
        val t = ByteArray(24)
        t[0] = (myPort shr 8).toByte(); t[1] = myPort.toByte(); t[2] = (peerPort shr 8).toByte(); t[3] = peerPort.toByte()
        put32(t, 4, seq); t[12] = (6 shl 4).toByte(); t[13] = 0x02; t[14] = -1; t[15] = -1
        t[20] = 2; t[21] = 4; t[22] = (mss shr 8).toByte(); t[23] = mss.toByte()
        var s = pseudoSum(my, peer, 6, t.size); var i = 0
        while (i + 1 < t.size) { s += ((t[i].toInt() and 255) shl 8) or (t[i + 1].toInt() and 255); i += 2 }
        while (s shr 16 != 0L) s = (s and 0xFFFF) + (s shr 16)
        val c = s.inv().toInt() and 0xFFFF; t[16] = (c shr 8).toByte(); t[17] = c.toByte()
        seq += 1
        val pkt = ipWrap(my, peer, 6, t)
        toEngine(pkt)
        return pkt
    }

    fun waitFor(ms: Long = 4000, pred: (ByteArray) -> Boolean): ByteArray? {
        val end = System.currentTimeMillis() + ms
        while (true) { val left = end - System.currentTimeMillis(); if (left <= 0) return null; val p = inbox.poll(left, TimeUnit.MILLISECONDS) ?: return null; if (pred(p)) return p }
    }

    fun handleSynAck(): Boolean {
        val p = waitFor { tcpFlags(it) and 0x12 == 0x12 } ?: return false
        ack = tcpSeq(p) + 1; send(0x10); return true
    }

    /** Настоящий TCP-стек сегментирует перед тем, как отдать пакет TUN — отправляем кусками ~MSS, не одним гигантским IP-пакетом. */
    fun write(payload: ByteArray) { var o = 0; while (o < payload.size) { val n = minOf(1400, payload.size - o); send(0x18, payload.copyOfRange(o, o + n)); o += n } }
    fun rst() = send(0x04)

    /** Наш FIN, потом ждём FIN движка (он приходит отдельным пакетом, когда настоящий сервер на том конце закрылся) и подтверждаем его. */
    fun finAck(ms: Long = 6000): Boolean {
        send(0x11)
        val fin = waitFor(ms) { tcpFlags(it) and 0x01 != 0 } ?: return false
        ack = tcpSeq(fin) + 1; send(0x10)
        return true
    }

    /** Разбирает всё, что пришло от движка (данные и FIN), шлёт ACK; возвращает, когда накопится expectBytes или истечёт время. */
    fun drain(expectBytes: Int, ms: Long = 8000): Boolean {
        val end = System.currentTimeMillis() + ms
        while (data.size() < expectBytes) {
            val left = end - System.currentTimeMillis(); if (left <= 0) return false
            val p = inbox.poll(left, TimeUnit.MILLISECONDS) ?: continue
            val flags = tcpFlags(p); val s = tcpSeq(p); val payload = tcpPayload(p)
            if (payload.isNotEmpty() && s == ack) { data.write(payload); ack += payload.size; send(0x10) }
            else if (payload.isNotEmpty()) send(0x10)
            if (flags and 0x01 != 0 && !sawFin) { sawFin = true; ack += 1; send(0x11) }
        }
        return true
    }

    companion object {
        fun tcpOff(ip: ByteArray) = (ip[0].toInt() and 15) * 4
        fun tcpFlags(ip: ByteArray) = ip[tcpOff(ip) + 13].toInt() and 255
        fun tcpSeq(ip: ByteArray) = Ip.u32(ip, tcpOff(ip) + 4)
        fun tcpAck(ip: ByteArray) = Ip.u32(ip, tcpOff(ip) + 8)
        fun tcpPayload(ip: ByteArray): ByteArray {
            val ihl = tcpOff(ip); val total = Ip.u16(ip, 2); val doff = ihl + ((ip[ihl + 12].toInt() shr 4) * 4)
            return if (doff >= total) ByteArray(0) else ip.copyOfRange(doff, total)
        }
        private fun put32(t: ByteArray, o: Int, v: Int) { t[o] = (v shr 24).toByte(); t[o + 1] = (v shr 16).toByte(); t[o + 2] = (v shr 8).toByte(); t[o + 3] = v.toByte() }
        fun ipWrap(src: ByteArray, dst: ByteArray, proto: Int, payload: ByteArray): ByteArray {
            val p = ByteArray(20 + payload.size); p[0] = 0x45; p[8] = 64; p[9] = proto.toByte()
            val tot = 20 + payload.size; p[2] = (tot shr 8).toByte(); p[3] = tot.toByte()
            System.arraycopy(src, 0, p, 12, 4); System.arraycopy(dst, 0, p, 16, 4)
            var s = 0L; var i = 0; while (i < 20) { s += ((p[i].toInt() and 255) shl 8) or (p[i + 1].toInt() and 255); i += 2 }
            while (s shr 16 != 0L) s = (s and 0xFFFF) + (s shr 16)
            val c = s.inv().toInt() and 0xFFFF; p[10] = (c shr 8).toByte(); p[11] = c.toByte()
            System.arraycopy(payload, 0, p, 20, payload.size)
            return p
        }
    }
}

fun main() {
    val events = CopyOnWriteArrayList<Pair<FlowInfo, String>>()
    val dnsEvents = ConcurrentLinkedQueue<Triple<FlowInfo?, String, List<String>>>()
    val out = LinkedBlockingQueue<ByteArray>()
    val sockets = object : VpnSockets {
        override fun tcp(dst: InetAddress, port: Int, timeoutMs: Int): Socket = Socket().apply { connect(InetSocketAddress(dst, port), timeoutMs) }
        override fun udp(): DatagramSocket = DatagramSocket()
    }
    val ev = object : VpnEvents {
        override fun owner(proto: Int, src: InetSocketAddress, dst: InetSocketAddress) = Owner(10234, listOf("app.dsp.phone.test"), "DSP Test")
        override fun flow(f: FlowInfo, kind: String) { events.add(f to kind) }
        override fun dns(f: FlowInfo?, q: DnsSniff.Msg, ms: Long) { dnsEvents.add(Triple(f, q.name, q.ips)) }
    }
    val engine = VpnEngine({ p -> out.add(p) }, sockets, ev, 1500)
    val devices = CopyOnWriteArrayList<FakeDevice>()
    val misc = LinkedBlockingQueue<ByteArray>()
    val dispatch = Thread({
        while (true) {
            val p = out.take(); if (p.isEmpty()) break
            if ((p[9].toInt() and 255) == 6) { val ihl = (p[0].toInt() and 15) * 4; val d = devices.firstOrNull { it.myPort == Ip.u16(p, ihl + 2) }; if (d != null) d.accept(p) else misc.add(p) }
            else misc.add(p)
        }
    }, "dispatch").apply { isDaemon = true; start() }
    fun newDevice(port: Int, peer: ByteArray, peerPort: Int): FakeDevice { val d = FakeDevice(ipAddr("10.8.0.2"), port, peer, peerPort) { engine.input(it, it.size) }; devices.add(d); return d }

    // --- настоящий локальный эхо-сервер для всех TCP-сценариев ---
    val echo = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    Thread({
        while (!echo.isClosed) {
            val s = try { echo.accept() } catch (e: Exception) { break }
            Thread({
                try { val inp = s.getInputStream(); val outp = s.getOutputStream(); val buf = ByteArray(65536)
                    while (true) { val n = inp.read(buf); if (n < 0) break; outp.write(buf, 0, n) }
                } catch (e: Exception) { } finally { try { s.close() } catch (e: Exception) { } }
            }, "echo-conn").apply { isDaemon = true; start() }
        }
    }, "echo-accept").apply { isDaemon = true; start() }
    val echoPort = echo.localPort
    val local = ipAddr("127.0.0.1")

    // 1. рукопожатие, обмен данными, владелец потока
    val d1 = newDevice(44001, local, echoPort)
    d1.syn(); ok("TCP: SYN-ACK from the engine", d1.handleSynAck())
    d1.write("hello".toByteArray())
    ok("TCP: the echo server answers through the engine", d1.drain(5, 4000) && String(d1.data.toByteArray()) == "hello", String(d1.data.toByteArray()))
    ok("TCP: open event carries the owner", events.any { it.first.dport == echoPort && it.first.sport == 44001 && it.second == "open" && it.first.owner?.uid == 10234 })

    // 2. большая передача — проверяет окно, повтор сегментов и сборку по порядку на реальном трафике
    val d2 = newDevice(44002, local, echoPort)
    d2.syn(); ok("TCP big: handshake", d2.handleSynAck())
    val big = ByteArray(300_000) { (it * 7).toByte() }
    Thread({ d2.write(big) }, "big-write").apply { isDaemon = true; start() }
    ok("TCP big: 300 KB echoed back intact", d2.drain(big.size, 15000) && d2.data.toByteArray().contentEquals(big))
    ok("TCP big: closes cleanly (FIN both ways)", d2.finAck())
    ok("TCP big: byte counters match", run { val f = events.first { it.first.dport == echoPort && it.first.sport == 44002 }.first; f.up >= big.size.toLong() && f.down >= big.size.toLong() })

    // 3. повтор SYN до ACK — должен прийти тот же SYN-ACK (тот же ISN), а не новое соединение
    val d3 = newDevice(44003, local, echoPort)
    val synPkt = d3.syn()
    val sa1 = d3.waitFor { FakeDevice.tcpFlags(it) and 0x12 == 0x12 }
    ok("TCP: first SYN-ACK", sa1 != null)
    engine.input(synPkt, synPkt.size)
    val sa2 = d3.waitFor(2000) { FakeDevice.tcpFlags(it) and 0x12 == 0x12 }
    // байты совпадают, кроме IP id / контрольной суммы заголовка (растут с каждым исходящим пакетом, это нормально) — сверяем TCP-часть
    ok("TCP: duplicate SYN re-sends the same SYN-ACK", sa2 != null && sa1 != null && sa1.copyOfRange(20, sa1.size).contentEquals(sa2.copyOfRange(20, sa2.size)),
        "sa1=${sa1?.joinToString(""){ "%02x".format(it) }} sa2=${sa2?.joinToString(""){ "%02x".format(it) }}")

    // 4. отказ: порт, где заведомо никто не слушает
    val deadSrv = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")); val deadPort = deadSrv.localPort; deadSrv.close()
    val d4 = newDevice(44004, local, deadPort)
    d4.syn()
    ok("TCP: a refused port gets RST, not silence", d4.waitFor(5000) { FakeDevice.tcpFlags(it) and 0x04 != 0 } != null)
    ok("TCP: flow closed after the refusal", events.any { it.first.dport == deadPort && it.second == "close" })

    // 5. RST от устройства закрывает поток
    val d5 = newDevice(44005, local, echoPort)
    d5.syn(); d5.handleSynAck(); d5.rst()
    Thread.sleep(300)
    ok("TCP: RST from the device closes the flow", events.any { it.first.dport == echoPort && it.first.sport == 44005 && it.second == "close" })

    // --- UDP: настоящий эхо-сервер, содержимое и контрольные суммы проверены независимым кодом ---
    val udpEcho = DatagramSocket(0, InetAddress.getByName("127.0.0.1"))
    Thread({ val buf = ByteArray(65536); try { while (true) { val p = DatagramPacket(buf, buf.size); udpEcho.receive(p); udpEcho.send(DatagramPacket(p.data, p.length, p.address, p.port)) } } catch (e: Exception) { } }, "udp-echo").apply { isDaemon = true; start() }
    val udpPort = udpEcho.localPort
    val payload = "ping-udp".toByteArray()
    val udpPkt = Ip.udp(ipAddr("10.8.0.9"), local, 55001, udpPort, payload, 0, payload.size)
    engine.input(udpPkt, udpPkt.size)
    val back = misc.poll(4, TimeUnit.SECONDS)
    ok("UDP: engine relays the server's echo", back != null && (back[9].toInt() and 255) == 17)
    if (back != null) {
        val ihl = (back[0].toInt() and 15) * 4
        ok("UDP: payload intact", String(back.copyOfRange(ihl + 8, back.size)) == "ping-udp")
        ok("UDP: IP header checksum valid", csumOk(back, 0, ihl))
        ok("UDP: UDP checksum valid", udpCsumOk(back))
        ok("UDP: source/destination swapped correctly", Ip.str(back, 12) == "127.0.0.1" && Ip.u16(back, ihl) == udpPort && Ip.u16(back, ihl + 2) == 55001)
    }
    ok("UDP: flow open event fired", events.any { it.first.proto == 17 && it.first.dport == udpPort })

    // --- DNS: настоящий round-trip по UDP на порт 53 (движок распознаёт DNS только по номеру порта сервера) ---
    val dnsSrv = try { DatagramSocket(53, InetAddress.getByName("127.0.0.1")) } catch (e: Exception) { null }
    if (dnsSrv == null) println("skip DNS: port 53 is busy or not permitted in this sandbox")
    else {
        val resolvedIp = "93.184.216.34"
        Thread({ try { val buf = ByteArray(512); val p = DatagramPacket(buf, buf.size); dnsSrv.receive(p); val ans = buildDnsAnswer(p.data.copyOfRange(0, p.length), resolvedIp); dnsSrv.send(DatagramPacket(ans, ans.size, p.address, p.port)) } catch (e: Exception) { } }, "dns-fake").apply { isDaemon = true; start() }
        val query = buildDnsQuery("vpntest.example.org")
        val dnsPkt = Ip.udp(ipAddr("10.8.0.9"), local, 55555, 53, query, 0, query.size)
        engine.input(dnsPkt, dnsPkt.size)
        Thread.sleep(500)
        ok("DNS: sniffed on a real UDP round trip", dnsEvents.any { it.second == "vpntest.example.org" && it.third.contains(resolvedIp) }, dnsEvents.toString())
        ok("DNS: the name is remembered for that IP", engine.nameOf(resolvedIp) == "vpntest.example.org")
        dnsSrv.close()
    }

    // --- TLS SNI: подлинный ClientHello от openssl s_client ---
    val capture = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")); val capturePort = capture.localPort
    val captured = AtomicReference<ByteArray>()
    val capThread = Thread({ try { val s = capture.accept(); val buf = ByteArray(16384); val n = s.getInputStream().read(buf); if (n > 0) captured.set(buf.copyOf(n)) } catch (e: Exception) { } }, "tls-capture").apply { isDaemon = true; start() }
    val proc = try { ProcessBuilder("openssl", "s_client", "-connect", "127.0.0.1:$capturePort", "-servername", "vpn-sni-test.example.org")
        .redirectInput(ProcessBuilder.Redirect.from(java.io.File("/dev/null"))).redirectErrorStream(true).start() } catch (e: Exception) { null }
    capThread.join(4000)
    proc?.destroyForcibly()
    val hello = captured.get()
    if (hello == null) println("skip TLS SNI: openssl s_client unavailable here")
    else {
        val d6 = newDevice(44006, local, echoPort)
        d6.syn(); d6.handleSynAck(); d6.write(hello)
        Thread.sleep(300)
        val flow = events.lastOrNull { it.first.dport == echoPort && it.first.sport == 44006 }?.first
        ok("TLS SNI: host recognised from a real ClientHello", flow?.host == "vpn-sni-test.example.org", "host=${flow?.host}")
        ok("TLS SNI: marked as tls", flow?.l7 == "tls")
    }

    // --- мусор не должен ронять движок ---
    engine.input(ByteArray(5), 5)
    engine.input(byteArrayOf(0x60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), 20)
    ok("garbage input does not crash the engine", true)

    engine.close(); echo.close(); udpEcho.close(); capture.close()
    out.add(ByteArray(0)); dispatch.interrupt()
    println(if (bad == 0) "all ok" else "FAILED $bad")
    if (bad != 0) kotlin.system.exitProcess(1)
}

// ---- минимальный, но настоящий DNS-запрос/ответ (без сжатия в вопросе, RFC 1035) ----
private fun encodeName(name: String): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    for (l in name.split(".")) { out.write(l.length); out.write(l.toByteArray(Charsets.US_ASCII)) }
    out.write(0); return out.toByteArray()
}
private fun buildDnsQuery(name: String): ByteArray {
    val b = java.io.ByteArrayOutputStream()
    b.write(byteArrayOf(0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0))
    b.write(encodeName(name)); b.write(byteArrayOf(0, 1, 0, 1))
    return b.toByteArray()
}
private fun buildDnsAnswer(query: ByteArray, ip: String): ByteArray {
    var p = 12; while (query[p].toInt() != 0) p += (query[p].toInt() and 255) + 1
    val qend = p + 5
    val b = java.io.ByteArrayOutputStream()
    b.write(query.copyOfRange(0, 2)); b.write(byteArrayOf(0x81.toByte(), 0x80.toByte(), query[4], query[5], 0, 1, 0, 0, 0, 0))
    b.write(query.copyOfRange(12, qend))
    b.write(byteArrayOf(0xc0.toByte(), 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4))
    for (part in ip.split(".")) b.write(part.toInt())
    return b.toByteArray()
}
