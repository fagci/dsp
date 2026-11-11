package app.dsp.phone.x509test

import app.dsp.phone.X509Gen
import java.io.File
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.KeyStore
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/** X509Gen: центр и листовые сертификаты DER вручную — проверка openssl'ом и настоящим TLS-рукопожатием. gradle runX509GenTest */
private var bad = 0
private fun ok(name: String, c: Boolean, x: String = "") { if (!c) { bad++; println("FAIL $name $x") } else println("ok   $name") }

private fun opensslVerify(root: File, leaf: File): Pair<Int, String> {
    val p = ProcessBuilder("openssl", "verify", "-CAfile", root.path, leaf.path).redirectErrorStream(true).start()
    val out = p.inputStream.bufferedReader().readText(); p.waitFor(); return p.exitValue() to out
}
private fun pem(label: String, der: ByteArray): String {
    val b64 = java.util.Base64.getMimeEncoder(64, "\n".toByteArray()).encodeToString(der)
    return "-----BEGIN $label-----\n$b64\n-----END $label-----\n"
}
private fun ksFromLeaf(leaf: X509Gen.Cert): KeyStore {
    val ks = KeyStore.getInstance(KeyStore.getDefaultType()); ks.load(null, null)
    ks.setKeyEntry("dsp", leaf.key, CharArray(0), leaf.chain.toTypedArray())
    return ks
}

fun main() {
    val dir = File.createTempFile("x509", "").also { it.delete(); it.mkdirs() }
    val ca = X509Gen.selfSignedCa("DSP workbench debug CA")
    val rootFile = File(dir, "root.pem").apply { writeText(pem("CERTIFICATE", ca.chain[0].encoded)) }
    ok("CA: self-signed, verifies against itself", opensslVerify(rootFile, rootFile).first == 0)
    ok("CA: basic constraints CA:true", ca.chain[0].basicConstraints >= 0)
    val now = System.currentTimeMillis()
    ok("CA: ~10y validity", ca.chain[0].notAfter.time - now in (3600_000L * 24 * 3600)..(3600_000L * 24 * 3700))

    val leaf1 = X509Gen.leaf("example.test", ca)
    val leafFile = File(dir, "leaf.pem").apply { writeText(pem("CERTIFICATE", leaf1.chain[0].encoded)) }
    val (code, out) = opensslVerify(rootFile, leafFile)
    ok("leaf: openssl verifies it against the CA", code == 0, out)
    ok("leaf: CN/SAN carry the host", leaf1.chain[0].subjectAlternativeNames.any { it[1] == "example.test" } && leaf1.chain[0].subjectX500Principal.name.contains("example.test"))
    ok("leaf: issuer matches the CA's subject", leaf1.chain[0].issuerX500Principal == ca.chain[0].subjectX500Principal)
    ok("leaf: basic constraints CA:false (not a CA)", leaf1.chain[0].basicConstraints == -1)
    ok("leaf: chain carries the CA too", leaf1.chain.size == 2 && leaf1.chain[1] === ca.chain[0])
    ok("leaf: does not outlive the CA", leaf1.chain[0].notAfter.time <= ca.chain[0].notAfter.time)

    // две выписки для одного хоста — разные ключи и сертификаты (каждый раз новая пара, не кэш внутри X509Gen самого)
    val leaf2 = X509Gen.leaf("example.test", ca)
    ok("leaf: a second issue is a fresh keypair", !leaf1.key.encoded!!.contentEquals(leaf2.key.encoded!!))

    // чужой хост получает отказ при проверке имени, даже с доверенным корнем
    val wrong = X509Gen.leaf("other.example", ca)

    // --- настоящее TLS-рукопожатие: клиент доверяет только нашему корню, сервер отдаёт листовой сертификат ---
    val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    val trustKs = KeyStore.getInstance(KeyStore.getDefaultType()); trustKs.load(null, null); trustKs.setCertificateEntry("ca", ca.chain[0]); tmf.init(trustKs)
    val cliCtx = SSLContext.getInstance("TLS").also { it.init(null, tmf.trustManagers, null) }

    val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).also { it.init(ksFromLeaf(leaf1), CharArray(0)) }
    val srvCtx = SSLContext.getInstance("TLS").also { it.init(kmf.keyManagers, null, null) }
    val ss = ServerSocket(0, 5, java.net.InetAddress.getByName("127.0.0.1"))
    Thread {
        repeat(2) {
            try {
                val raw = ss.accept()
                val t = srvCtx.socketFactory.createSocket(raw, null, raw.port, true) as SSLSocket; t.useClientMode = false
                val line = t.inputStream.bufferedReader().readLine()
                t.outputStream.write(("echo:$line\n").toByteArray()); t.outputStream.flush(); t.close()
            } catch (e: Exception) { }
        }
    }.apply { isDaemon = true }.start()
    val port = ss.localPort

    val s1 = Socket(); s1.connect(InetSocketAddress("127.0.0.1", port), 3000)
    val t1 = cliCtx.socketFactory.createSocket(s1, "example.test", port, true) as SSLSocket
    t1.startHandshake()
    t1.outputStream.write("hi\n".toByteArray()); t1.outputStream.flush()
    ok("forged leaf accepted by a client that trusts our CA", t1.inputStream.bufferedReader().readLine() == "echo:hi")
    t1.close()

    // доверяет корню, но сертификат выписан для другого имени — клиент должен отказать (имя не совпало)
    val kmf2 = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).also { it.init(ksFromLeaf(wrong), CharArray(0)) }
    val srvCtx2 = SSLContext.getInstance("TLS").also { it.init(kmf2.keyManagers, null, null) }
    val ss2 = ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))
    Thread { try { val raw = ss2.accept(); (srvCtx2.socketFactory.createSocket(raw, null, raw.port, true) as SSLSocket).apply { useClientMode = false }.startHandshake() } catch (e: Exception) { } }.apply { isDaemon = true }.start()
    val s2 = Socket(); s2.connect(InetSocketAddress("127.0.0.1", ss2.localPort), 3000)
    // plain SSLSocket does not check the hostname on its own (classic JSSE gotcha) — endpointIdentificationAlgorithm makes it,
    // the same setting the real upstream-verification engine (TlsSplice) must set, or "real validation" would be a no-op
    val r2 = runCatching {
        val t = cliCtx.socketFactory.createSocket(s2, "example.test", ss2.localPort, true) as SSLSocket
        t.sslParameters = t.sslParameters.also { it.endpointIdentificationAlgorithm = "HTTPS" }
        t.startHandshake()
    }
    ok("wrong-host leaf is refused even though the CA is trusted", r2.isFailure, r2.exceptionOrNull()?.toString() ?: "accepted!")

    // без доверия к нашему CA — отказ, как у любого самоподписанного
    val sysCtx = SSLContext.getInstance("TLS").also { it.init(null, null, null) }
    val ss3 = ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))
    val kmf3 = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).also { it.init(ksFromLeaf(leaf1), CharArray(0)) }
    val srvCtx3 = SSLContext.getInstance("TLS").also { it.init(kmf3.keyManagers, null, null) }
    Thread { try { val raw = ss3.accept(); (srvCtx3.socketFactory.createSocket(raw, null, raw.port, true) as SSLSocket).apply { useClientMode = false }.startHandshake() } catch (e: Exception) { } }.apply { isDaemon = true }.start()
    val s3 = Socket(); s3.connect(InetSocketAddress("127.0.0.1", ss3.localPort), 3000)
    val r3 = runCatching { (sysCtx.socketFactory.createSocket(s3, "example.test", ss3.localPort, true) as SSLSocket).startHandshake() }
    ok("without trusting our CA, the forged leaf is refused like any self-signed cert", r3.isFailure)

    ss.close(); ss2.close(); ss3.close(); dir.deleteRecursively()
    println(if (bad > 0) "FAILED $bad" else "all ok"); if (bad > 0) System.exit(1)
}
