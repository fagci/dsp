package app.dsp.phone.mitmcatest

import app.dsp.phone.MitmCa
import app.dsp.phone.TlsPump
import java.io.File
import java.security.KeyStore
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/** MitmCa (центр + листья по SNI, персистентность) и TlsPump (SSLEngine без сокета) — полное рукопожатие и обмен данными «в памяти». gradle runMitmCaTest */
private var bad = 0
private fun ok(name: String, c: Boolean, x: String = "") { if (!c) { bad++; println("FAIL $name $x") } else println("ok   $name") }

/** Клиентский SSLEngine, доверяющий только корню [root], с реальной проверкой имени (endpointIdentificationAlgorithm). */
private fun clientEngine(root: java.security.cert.X509Certificate, host: String): javax.net.ssl.SSLEngine {
    val ks = KeyStore.getInstance(KeyStore.getDefaultType()); ks.load(null, null); ks.setCertificateEntry("ca", root)
    val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); tmf.init(ks)
    val ctx = SSLContext.getInstance("TLS"); ctx.init(null, tmf.trustManagers, null)
    val e = ctx.createSSLEngine(host, 443); e.useClientMode = true
    e.sslParameters = e.sslParameters.also { it.endpointIdentificationAlgorithm = "HTTPS" }
    return e
}

/** Две стороны одного TLS-соединения без сокета: writeCipher каждой лишь копит байты в своей очереди — НЕ зовёт unwrap другой стороны
 *  напрямую (вложенные вызовы друг в друга путают внутренний счётчик записей TLS 1.3 у настоящего SSLEngine — не вопрос TlsPump,
 *  тот же эффект и с голым SSLEngineImpl; в реальном TlsSplice этого не бывает — там writeCipher это запись в сокет или в очередь
 *  отправки устройству, ни то ни другое не возвращается обратно в сам движок). Качаем очереди по кругу до тишины — как настоящая сеть. */
private class Wire { val q = ArrayDeque<ByteArray>() }
private fun pumpBoth(c: TlsPump, s: TlsPump, c2s: Wire, s2c: Wire, onC: (ByteArray) -> Unit, onS: (ByteArray) -> Unit) {
    var moved: Boolean
    do {
        moved = false
        while (c2s.q.isNotEmpty()) { s.unwrap(c2s.q.removeFirst(), onS); moved = true }
        while (s2c.q.isNotEmpty()) { c.unwrap(s2c.q.removeFirst(), onC); moved = true }
    } while (moved)
}

fun main() {
    val dir = File.createTempFile("mitm", "").also { it.delete(); it.mkdirs() }

    val root1 = MitmCa.ca(dir).chain[0]
    val root2 = MitmCa.ca(dir).chain[0]                              // второй вызов — тот же центр (уже на диске), не новый
    ok("CA is created once and reused", root1 == root2)
    ok("fingerprint is stable and SHA-256-shaped", MitmCa.fingerprint(dir).matches(Regex("([0-9A-F]{2}:){31}[0-9A-F]{2}")))

    fun handshakeCert(host: String, ca: java.security.cert.X509Certificate): java.security.cert.X509Certificate {
        val se = MitmCa.serverEngine(dir, host); val ce = clientEngine(ca, host)
        val c2s = Wire(); val s2c = Wire()
        val cp = TlsPump(ce) { c2s.q.add(it) }; val sp = TlsPump(se) { s2c.q.add(it) }
        cp.beginHandshake(); pumpBoth(cp, sp, c2s, s2c, {}, {})
        return se.session.localCertificates[0] as java.security.cert.X509Certificate
    }
    val caRoot = MitmCa.ca(dir).chain[0]
    val c1 = handshakeCert("a.test", caRoot); val c1again = handshakeCert("a.test", caRoot)
    ok("same leaf certificate reused for a.test", c1 == c1again)
    val c2 = handshakeCert("b.test", caRoot)
    ok("a different host gets a different leaf", c2 != c1)

    val before = MitmCa.status(dir).getInt("leaves")
    MitmCa.reset(dir)
    ok("reset clears the leaf cache", MitmCa.status(dir).getInt("leaves") == 0 && before >= 2)
    val root3 = MitmCa.ca(dir).chain[0]
    ok("reset makes a genuinely new CA", root3 != root1)
    val root4PemLoad = run {                                          // новый процесс читал бы с диска — тут проверяем саму персистентность файлов
        MitmCa.ca(File(dir.parentFile, dir.name))
    }.chain[0]
    ok("still the reset CA after re-reading", root4PemLoad == root3)

    // --- настоящее рукопожатие и обмен данными между двумя SSLEngine, безо всякого сокета ---
    val host = "intercepted.example"
    val serverEngine = MitmCa.serverEngine(dir, host)
    val ca = MitmCa.ca(dir).chain[0]
    val clientE = clientEngine(ca, host)

    val c2s = Wire(); val s2c = Wire()
    val clientPlainIn = StringBuilder(); val serverPlainIn = StringBuilder()
    val c = TlsPump(clientE) { c2s.q.add(it) }
    val s = TlsPump(serverEngine) { s2c.q.add(it) }
    c.beginHandshake()
    pumpBoth(c, s, c2s, s2c, { d -> clientPlainIn.append(String(d)) }, { d -> serverPlainIn.append(String(d)) })
    ok("handshake completed (client engine)", clientE.session.cipherSuite != "SSL_NULL_WITH_NULL_NULL", clientE.session.cipherSuite)
    ok("handshake completed (server engine)", serverEngine.session.cipherSuite != "SSL_NULL_WITH_NULL_NULL")
    ok("client saw the forged leaf for the real host", clientE.session.peerCertificates[0] == serverEngine.session.localCertificates[0])

    c.wrap("GET / HTTP/1.1\r\n".toByteArray())
    pumpBoth(c, s, c2s, s2c, { d -> clientPlainIn.append(String(d)) }, { d -> serverPlainIn.append(String(d)) })
    ok("plaintext request reaches the server side", serverPlainIn.toString() == "GET / HTTP/1.1\r\n", serverPlainIn.toString())
    s.wrap("HTTP/1.1 200 OK\r\n".toByteArray())
    pumpBoth(c, s, c2s, s2c, { d -> clientPlainIn.append(String(d)) }, { d -> serverPlainIn.append(String(d)) })
    ok("plaintext response reaches the client side", clientPlainIn.toString() == "HTTP/1.1 200 OK\r\n")

    // большой кусок, несколько TLS-записей подряд, через те же два насоса; байты — не только текст, аккуратно (не через String, он портит не-UTF8)
    val bigOut = java.io.ByteArrayOutputStream()
    val big = ByteArray(40000) { (it % 251).toByte() }
    c.wrap(big)
    pumpBoth(c, s, c2s, s2c, {}, { d -> bigOut.write(d) })
    ok("large plaintext (multiple TLS records) relayed intact", bigOut.toByteArray().contentEquals(big))

    // чужой хост (не a.test/b.test/intercepted.example) по-настоящему не доверился бы, если бы клиент ждал ДРУГОЕ имя — здесь просто
    // убеждаемся, что разные вызовы serverEngine для РАЗНЫХ имён дают сертификаты именно с тем SAN, что просили
    ok("leaf for b.test carries b.test in SAN", c2.subjectAlternativeNames.any { it[1] == "b.test" })

    dir.deleteRecursively()
    println(if (bad > 0) "FAILED $bad" else "all ok"); if (bad > 0) System.exit(1)
}
