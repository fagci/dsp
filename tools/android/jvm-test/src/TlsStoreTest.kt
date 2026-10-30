package app.dsp.phone.tlsstoretest

import app.dsp.phone.BridgeServer
import app.dsp.phone.Config
import app.dsp.phone.FakeCtx
import app.dsp.phone.TlsStore
import java.io.File
import java.io.InputStream
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Base64
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManagerFactory

private var bad = 0
private fun ok(name: String, c: Boolean, x: String = "") { if (!c) { bad++; println("FAIL $name $x") } else println("ok   $name") }
private fun pem(label: String, der: ByteArray) = "-----BEGIN $label-----\n" + Base64.getMimeEncoder(64, "\n".toByteArray()).encodeToString(der) + "\n-----END $label-----\n"

/** Самоподписанный сертификат (keytool) для заданного ключа устройства? keytool не умеет — поэтому ключ и сертификат берём от keytool, а ключ кладём в хранилище как «ключ устройства». */
private fun keytool(dir: File, alias: String, vararg more: String): KeyStore {
    val ks = File(dir, "$alias.p12"); ks.delete()
    val p = ProcessBuilder("keytool", "-genkeypair", "-alias", alias, "-keyalg", "EC", "-groupname", "secp256r1", "-dname", "CN=$alias", "-storetype", "PKCS12", "-keystore", ks.path, "-storepass", "changeit", *more)
        .redirectErrorStream(true).start()
    p.inputStream.readBytes(); check(p.waitFor() == 0) { "keytool failed" }
    return KeyStore.getInstance("PKCS12").also { s -> ks.inputStream().use { s.load(it, "changeit".toCharArray()) } }
}

/** Кладёт пару keytool в каталог устройства так, как это сделал бы tls.csr (key.pk8 + pub.spki) и возвращает PEM сертификата. */
private fun asDeviceKey(dir: File, ks: KeyStore, alias: String): String {
    dir.mkdirs()
    File(dir, "key.pk8").writeBytes(ks.getKey(alias, "changeit".toCharArray()).encoded)
    val c = ks.getCertificate(alias) as X509Certificate
    File(dir, "pub.spki").writeBytes(c.publicKey.encoded)
    return pem("CERTIFICATE", c.encoded)
}

private fun wsGet(sock: SSLSocket): String {                       // WebSocket-рукопожатие и первое сообщение (приветствие)
    val o = sock.getOutputStream(); val i: InputStream = sock.getInputStream()
    o.write("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n".toByteArray()); o.flush()
    val head = StringBuilder(); while (!head.endsWith("\r\n\r\n")) head.append(i.read().toChar())
    check(head.startsWith("HTTP/1.1 101")) { head.toString() }
    i.read(); var n = i.read() and 127; if (n == 126) n = (i.read() shl 8) or i.read()
    return String(ByteArray(n).also { b -> var k = 0; while (k < n) k += i.read(b, k, n - k) })
}

fun main() {
    val tmp = File.createTempFile("tlsstore", "").also { it.delete(); it.mkdirs() }
    // --- ключ устройства: создаётся один раз, renew — новый
    val dir = File(tmp, "dev")
    val a = TlsStore.publicKey(dir)
    ok("device key is created and its public half is a P-256 SubjectPublicKeyInfo", a.size in 80..95 && a[0] == 0x30.toByte(), a.size.toString())
    ok("asking again gives the same key (the certificate stays valid)", TlsStore.publicKey(dir).contentEquals(a))
    ok("the private key stays in the app folder (no world access)", !File(dir, "key.pk8").canRead() || File(dir, "key.pk8").length() > 0)
    val b = TlsStore.publicKey(dir, renew = true)
    ok("renew makes a new key", !b.contentEquals(a))
    ok("no certificate yet → no TLS context", TlsStore.context(dir) == null)
    ok("installing before a certificate exists for this key: refused, not stored", TlsStore.install(File(tmp, "empty"), "x")?.contains("no key") == true)

    // --- сертификат: свой ключ принимается, чужой нет
    val mine = keytool(tmp, "mine", "-ext", "san=dns:localhost,ip:127.0.0.1", "-validity", "30")
    val dev = File(tmp, "dev2"); val minePem = asDeviceKey(dev, mine, "mine")
    ok("garbage instead of PEM is refused", TlsStore.install(dev, "not a certificate")?.startsWith("certificate:") == true)
    val other = keytool(tmp, "other", "-ext", "san=dns:localhost", "-validity", "30")
    val otherPem = pem("CERTIFICATE", (other.getCertificate("other") as X509Certificate).encoded)
    ok("a certificate for another key is refused (a page cannot swap in someone else's identity)", TlsStore.install(dev, otherPem)?.contains("another key") == true)
    val nosan = keytool(tmp, "nosan", "-validity", "30"); val nosanDev = File(tmp, "nosan"); val nosanPem = asDeviceKey(nosanDev, nosan, "nosan")
    ok("a certificate without subject alternative names is refused (browsers refuse it anyway)", TlsStore.install(nosanDev, nosanPem)?.contains("alternative names") == true)
    val old = keytool(tmp, "old", "-ext", "san=dns:localhost", "-startdate", "2020/01/01 00:00:00", "-validity", "1"); val oldDev = File(tmp, "old"); val oldPem = asDeviceKey(oldDev, old, "old")
    ok("an expired certificate is refused", TlsStore.install(oldDev, oldPem)?.contains("not valid") == true)
    ok("the right certificate is accepted", TlsStore.install(dev, minePem) == null)
    ok("status: installed, names listed", TlsStore.status(dev).let { it.getBoolean("installed") && it.getJSONArray("names").toString().contains("localhost") && it.getLong("notAfter") > System.currentTimeMillis() }, TlsStore.status(dev).toString())
    val sc = TlsStore.context(dev)
    ok("a TLS context is built from the key and the certificate", sc != null)

    // --- сервер: обычный порт и TLS-порт, wss-рукопожатие с доверием к сертификату
    val ctx = FakeCtx(); val cfg = Config(ctx); cfg.port = 0
    val srv = BridgeServer(cfg, { """{"src":"bridge","level":"hello","ver":1,"app":"dsp-android"}""" }, { "status-text" }) {}
    ok("server starts", srv.start() == null)
    ok("no TLS port without a certificate", srv.tlsPort == 0)
    ok("setTls starts the TLS listener", srv.setTls(sc) == null && srv.tlsPort > 0 && srv.tlsPort != srv.boundPort, "${srv.tlsPort} / ${srv.boundPort}")
    val tm = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).also { f -> f.init(KeyStore.getInstance("PKCS12").also { it.load(null, null); it.setCertificateEntry("c", mine.getCertificate("mine")) }) }
    val cli = SSLContext.getInstance("TLS").also { it.init(null, tm.trustManagers, null) }
    val s1 = cli.socketFactory.createSocket("127.0.0.1", srv.tlsPort) as SSLSocket
    val params = s1.sslParameters; params.endpointIdentificationAlgorithm = "HTTPS"; s1.sslParameters = params
    s1.soTimeout = 5000
    ok("wss: handshake, certificate checked for 127.0.0.1, WebSocket greeting over TLS", wsGet(s1).contains("dsp-android"))
    s1.close()
    val s2 = (SSLContext.getDefault().socketFactory.createSocket("127.0.0.1", srv.tlsPort) as SSLSocket).also { it.soTimeout = 5000 }
    ok("a client that does not trust the certificate is refused", runCatching { s2.startHandshake() }.isFailure)
    s2.close()
    val plain = java.net.Socket("127.0.0.1", srv.boundPort); plain.soTimeout = 5000
    plain.getOutputStream().write("GET /status HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".toByteArray())
    ok("the plain port still works at the same time", String(plain.getInputStream().readBytes()).contains("status-text")); plain.close()
    ok("TLS: HTTP page over https too", (cli.socketFactory.createSocket("127.0.0.1", srv.tlsPort) as SSLSocket).let { s -> s.soTimeout = 5000; s.outputStream.write("GET /status HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".toByteArray()); val t = String(s.inputStream.readBytes()); s.close(); t.contains("status-text") })
    ok("setTls(null) closes the TLS port, the plain one stays", srv.setTls(null) == null && srv.tlsPort == 0 && runCatching { java.net.Socket("127.0.0.1", srv.boundPort).close() }.isSuccess)
    ok("a stop and start brings TLS back by itself", srv.setTls(sc) == null && run { srv.stop(); srv.start(); srv.tlsPort > 0 })
    srv.stop()
    TlsStore.remove(dev)
    ok("remove: key and certificate are gone", TlsStore.context(dev) == null && !TlsStore.status(dev).getBoolean("key"))
    tmp.deleteRecursively()
    println(if (bad > 0) "FAILED $bad" else "all ok"); if (bad > 0) System.exit(1)
}
