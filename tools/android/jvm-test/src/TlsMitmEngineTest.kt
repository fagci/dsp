package app.dsp.phone.tlsmitmtest

import app.dsp.phone.*
import java.io.File
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.KeyStore
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManagerFactory

/**
 * Полный круг TLS-перехвата через настоящий VpnEngine: поддельное «устройство» ведёт настоящее TLS-рукопожатие (доверяя
 * корню MitmCa) против движка, движок отдельным TLS-рукопожатием (с честной проверкой сертификата) говорит с настоящим
 * сервером; открытый текст проверяется на обоих концах и в onPlain. gradle runTlsMitmEngineTest
 */
private var bad = 0
private fun ok(name: String, c: Boolean, x: String = "") { if (!c) { bad++; println("FAIL $name $x") } else println("ok   $name") }
private fun ipAddr(s: String): ByteArray = InetAddress.getByName(s).address
private fun pseudoSum(src: ByteArray, dst: ByteArray, proto: Int, len: Int): Long {
    var s = 0L
    for (a in listOf(src, dst)) { s += ((a[0].toInt() and 255) shl 8) or (a[1].toInt() and 255); s += ((a[2].toInt() and 255) shl 8) or (a[3].toInt() and 255) }
    return s + proto + len
}

/** Урезанная копия FakeDevice из VpnEngineTest.kt (та — file-private): только TCP-рукопожатие и сырой обмен сегментами;
 *  TLS поверх него ведёт TlsPump снаружи (driveTls). */
private class FakeDevice(val my: ByteArray, val myPort: Int, val peer: ByteArray, val peerPort: Int, val toEngine: (ByteArray) -> Unit) {
    var seq = (Math.random() * 1_000_000).toInt() + 10_000
    var ack = 0
    val inbox = LinkedBlockingQueue<ByteArray>()

    fun accept(p: ByteArray) = inbox.add(p)
    fun send(flags: Int, payload: ByteArray = ByteArray(0)) { toEngine(Ip.tcp(my, peer, myPort, peerPort, seq, ack, flags, 65535, payload, 0, payload.size)); seq += payload.size + (if (flags and 0x01 != 0) 1 else 0) }
    fun write(payload: ByteArray) { var o = 0; while (o < payload.size) { val n = minOf(1400, payload.size - o); send(0x18, payload.copyOfRange(o, o + n)); o += n } }

    fun syn(mss: Int = 1460): ByteArray {
        val t = ByteArray(24)
        t[0] = (myPort shr 8).toByte(); t[1] = myPort.toByte(); t[2] = (peerPort shr 8).toByte(); t[3] = peerPort.toByte()
        putSeq(t, 4, seq); t[12] = (6 shl 4).toByte(); t[13] = 0x02; t[14] = -1; t[15] = -1
        t[20] = 2; t[21] = 4; t[22] = (mss shr 8).toByte(); t[23] = mss.toByte()
        var s = pseudoSum(my, peer, 6, t.size); var i = 0
        while (i + 1 < t.size) { s += ((t[i].toInt() and 255) shl 8) or (t[i + 1].toInt() and 255); i += 2 }
        while (s shr 16 != 0L) s = (s and 0xFFFF) + (s shr 16)
        val c = s.inv().toInt() and 0xFFFF; t[16] = (c shr 8).toByte(); t[17] = c.toByte()
        seq += 1
        val pkt = ipWrap(my, peer, 6, t); toEngine(pkt); return pkt
    }
    private fun putSeq(t: ByteArray, o: Int, v: Int) { t[o] = (v shr 24).toByte(); t[o + 1] = (v shr 16).toByte(); t[o + 2] = (v shr 8).toByte(); t[o + 3] = v.toByte() }

    fun waitFor(ms: Long = 4000, pred: (ByteArray) -> Boolean): ByteArray? {
        val end = System.currentTimeMillis() + ms
        while (true) { val left = end - System.currentTimeMillis(); if (left <= 0) return null; val p = inbox.poll(left, TimeUnit.MILLISECONDS) ?: return null; if (pred(p)) return p }
    }
    fun handleSynAck(): Boolean { val p = waitFor { tcpFlags(it) and 0x12 == 0x12 } ?: return false; ack = tcpSeq(p) + 1; send(0x10); return true }

    companion object {
        fun tcpOff(ip: ByteArray) = (ip[0].toInt() and 15) * 4
        fun tcpFlags(ip: ByteArray) = ip[tcpOff(ip) + 13].toInt() and 255
        fun tcpSeq(ip: ByteArray) = Ip.u32(ip, tcpOff(ip) + 4)
        fun tcpPayload(ip: ByteArray): ByteArray { val ihl = tcpOff(ip); val total = Ip.u16(ip, 2); val doff = ihl + ((ip[ihl + 12].toInt() shr 4) * 4); return if (doff >= total) ByteArray(0) else ip.copyOfRange(doff, total) }
        fun ipWrap(src: ByteArray, dst: ByteArray, proto: Int, payload: ByteArray): ByteArray {
            val p = ByteArray(20 + payload.size); p[0] = 0x45; p[8] = 64; p[9] = proto.toByte()
            val tot = 20 + payload.size; p[2] = (tot shr 8).toByte(); p[3] = tot.toByte()
            System.arraycopy(src, 0, p, 12, 4); System.arraycopy(dst, 0, p, 16, 4)
            var s = 0L; var i = 0; while (i < 20) { s += ((p[i].toInt() and 255) shl 8) or (p[i + 1].toInt() and 255); i += 2 }
            while (s shr 16 != 0L) s = (s and 0xFFFF) + (s shr 16)
            val c = s.inv().toInt() and 0xFFFF; p[10] = (c shr 8).toByte(); p[11] = c.toByte()
            System.arraycopy(payload, 0, p, 20, payload.size); return p
        }
    }
}

/** Качает TCP-поток fd: входящее от движка идёт в TlsPump.unwrap, то, что pump просит отправить (writeCipher), уже ушло
 *  через fd.send сразу (wrap/beginHandshake вызывают writeCipher синхронно) — тут только читаем и ack'аем. */
private fun pumpFakeDevice(fd: FakeDevice, pump: TlsPump, until: () -> Boolean, timeoutMs: Long = 8000): Boolean {
    val end = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < end) {
        if (until()) return true
        val p = fd.inbox.poll(100, TimeUnit.MILLISECONDS) ?: continue
        val flags = FakeDevice.tcpFlags(p); val seq = FakeDevice.tcpSeq(p); val payload = FakeDevice.tcpPayload(p)
        if (payload.isNotEmpty() && seq == fd.ack) { fd.ack += payload.size; pump.unwrap(payload) { }; fd.send(0x10) }
        else if (payload.isNotEmpty()) fd.send(0x10)
    }
    return until()
}

fun main() {
    val dir = File.createTempFile("mitmeng", "").also { it.delete(); it.mkdirs() }

    // --- настоящий «источник» (сайт, который перехватываем): самоподписанный TLS-сервер, как у TlsTest.kt ---
    val ks = File(dir, "origin.p12")
    val p = ProcessBuilder("keytool", "-genkeypair", "-alias", "o", "-keyalg", "RSA", "-keysize", "2048", "-dname", "CN=origin.test", "-ext", "san=dns:origin.test",
        "-validity", "2", "-storetype", "PKCS12", "-keystore", ks.path, "-storepass", "changeit").redirectErrorStream(true).start()
    p.inputStream.readBytes(); check(p.waitFor() == 0) { "keytool failed" }
    val store = KeyStore.getInstance("PKCS12").also { s -> ks.inputStream().use { s.load(it, "changeit".toCharArray()) } }
    val originCert = store.getCertificate("o") as java.security.cert.X509Certificate
    val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).also { it.init(store, "changeit".toCharArray()) }
    val originCtx = SSLContext.getInstance("TLS").also { it.init(kmf.keyManagers, null, null) }
    val originSrv = ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))
    val originPort = originSrv.localPort
    Thread {
        try {
            while (true) {
                val raw = originSrv.accept()
                Thread {
                    try {
                        val t = originCtx.socketFactory.createSocket(raw, null, raw.port, true) as SSLSocket; t.useClientMode = false
                        val line = t.inputStream.bufferedReader().readLine()
                        t.outputStream.write(("echo:$line\n").toByteArray()); t.outputStream.flush(); t.close()
                    } catch (e: Exception) { }
                }.start()
            }
        } catch (e: Exception) { }
    }.apply { isDaemon = true }.start()

    // --- VpnEngine: кандидат на расшифровку — только этот порт; decrypt строит TlsMitm из MitmCa (deviceSide) и доверия к origin (upstreamSide) ---
    val plain = ConcurrentLinkedQueue<Pair<Boolean, String>>(); val errors = CopyOnWriteArrayList<String>()
    val host = "origin.test"
    val sockets = object : VpnSockets {
        override fun tcp(dst: InetAddress, port: Int, timeoutMs: Int): Socket = Socket().apply { connect(InetSocketAddress(dst, port), timeoutMs) }
        override fun udp(): DatagramSocket = DatagramSocket()
    }
    val ev = object : VpnEvents {
        override fun decryptCandidate(f: FlowInfo) = f.dport == originPort
        override fun decrypt(f: FlowInfo, h: String): TlsMitm? {
            if (h != host) return null
            return object : TlsMitm {
                override fun deviceSide() = MitmCa.serverEngine(dir, h)
                override fun upstreamSide(): javax.net.ssl.SSLEngine {
                    val tks = KeyStore.getInstance(KeyStore.getDefaultType()); tks.load(null, null); tks.setCertificateEntry("origin", originCert)
                    val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); tmf.init(tks)
                    val ctx = SSLContext.getInstance("TLS"); ctx.init(null, tmf.trustManagers, null)
                    val e = ctx.createSSLEngine(h, originPort); e.useClientMode = true
                    e.sslParameters = e.sslParameters.also { it.endpointIdentificationAlgorithm = "HTTPS" }
                    return e
                }
                override fun onPlain(up: Boolean, data: ByteArray) { plain.add(up to String(data)) }
                override fun onError(msg: String) { errors.add(msg) }
            }
        }
    }
    val out = LinkedBlockingQueue<ByteArray>()
    val engine = VpnEngine({ p2 -> out.add(p2) }, sockets, ev, 1500)
    val local = ipAddr("10.8.0.9"); val originIp = ipAddr("127.0.0.1")
    val fd = FakeDevice(local, 51000, originIp, originPort) { pkt -> engine.input(pkt, pkt.size) }
    val pump = Thread { try { while (true) { val pkt = out.poll(50, TimeUnit.MILLISECONDS) ?: continue; fd.accept(pkt) } } catch (e: Exception) { } }
    pump.isDaemon = true; pump.start()

    fd.syn()
    ok("3-way handshake with the engine", fd.handleSynAck())

    // --- поддельное «устройство»: настоящий TLS-клиент, доверяющий только корню MitmCa ---
    val tks2 = KeyStore.getInstance(KeyStore.getDefaultType()); tks2.load(null, null); tks2.setCertificateEntry("ca", MitmCa.ca(dir).chain[0])
    val tmf2 = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); tmf2.init(tks2)
    val devCtx = SSLContext.getInstance("TLS"); devCtx.init(null, tmf2.trustManagers, null)
    val devEngine = devCtx.createSSLEngine(host, originPort); devEngine.useClientMode = true
    devEngine.sslParameters = devEngine.sslParameters.also { it.endpointIdentificationAlgorithm = "HTTPS" }
    val devPump = TlsPump(devEngine) { bytes -> fd.write(bytes) }

    devPump.beginHandshake()
    ok("device TLS handshake completes against the forged cert", pumpFakeDevice(fd, devPump, { devEngine.session.cipherSuite != "SSL_NULL_WITH_NULL_NULL" }))
    ok("device sees a cert for origin.test issued by our own CA, not origin's real one",
        devEngine.session.peerCertificates.isNotEmpty() && (devEngine.session.peerCertificates[0] as java.security.cert.X509Certificate) != originCert,
        "peer=${devEngine.session.peerCertificates.getOrNull(0)}")
    ok("decryptCandidate/decrypt were consulted (no leftover errors so far)", errors.isEmpty(), errors.toString())

    devPump.wrap("hello-through-mitm\n".toByteArray())
    pumpFakeDevice(fd, devPump, { plain.any { it.first && it.second.contains("hello-through-mitm") } }, 6000)
    ok("request plaintext reached onPlain (up) exactly as sent", plain.any { it.first && it.second == "hello-through-mitm\n" }, plain.toString())

    pumpFakeDevice(fd, devPump, { plain.any { !it.first && it.second.contains("echo:hello-through-mitm") } }, 6000)
    ok("real origin's echo reached onPlain (down) through the real upstream TLS", plain.any { !it.first && it.second == "echo:hello-through-mitm\n" }, plain.toString())

    originSrv.close(); dir.deleteRecursively()
    println(if (bad > 0) "FAILED $bad" else "all ok"); if (bad > 0) System.exit(1)
}
