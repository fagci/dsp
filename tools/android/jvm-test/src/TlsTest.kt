package app.dsp.phone.tlstest

import app.dsp.phone.Tls
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import java.security.KeyStore
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManagerFactory

private var bad = 0
private fun ok(name: String, c: Boolean, x: String = "") { if (!c) { bad++; println("FAIL $name $x") } else println("ok   $name") }

fun main() {
    // самоподписанный сертификат для localhost, ему же и доверяем (системное хранилище в тесте ни при чём)
    val dir = File.createTempFile("tls", "").also { it.delete(); it.mkdirs() }
    val ks = File(dir, "k.p12")
    val p = ProcessBuilder("keytool", "-genkeypair", "-alias", "t", "-keyalg", "RSA", "-keysize", "2048", "-dname", "CN=localhost", "-ext", "san=dns:localhost",
        "-validity", "2", "-storetype", "PKCS12", "-keystore", ks.path, "-storepass", "changeit").redirectErrorStream(true).start()
    p.inputStream.readBytes(); check(p.waitFor() == 0) { "keytool failed" }
    val store = KeyStore.getInstance("PKCS12").also { s -> ks.inputStream().use { s.load(it, "changeit".toCharArray()) } }
    val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).also { it.init(store, "changeit".toCharArray()) }
    val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).also { it.init(store) }
    val srvCtx = SSLContext.getInstance("TLS").also { it.init(kmf.keyManagers, null, null) }
    val cliCtx = SSLContext.getInstance("TLS").also { it.init(null, tmf.trustManagers, null) }

    // «сервер»: сначала открытый обмен (как STARTTLS: PROCEED), потом TLS и эхо
    val ss = java.net.ServerSocket(0, 5, java.net.InetAddress.getByName("127.0.0.1"))          // обычный: TLS поверх него поднимает сам обработчик
    Thread {
        repeat(3) {
            try {
                val raw = ss.accept()
                val t = srvCtx.socketFactory.createSocket(raw, null, raw.port, true) as SSLSocket
                t.useClientMode = false
                val line = t.inputStream.bufferedReader().readLine()
                t.outputStream.write(("echo:$line\n").toByteArray()); t.outputStream.flush(); t.close()
            } catch (e: Exception) { /* клиент отказался — это и проверяем */ }
        }
    }.apply { isDaemon = true }.start()
    val port = ss.localPort

    // 1) верное имя: рукопожатие проходит, данные ходят, таймаут сброшен
    val s1 = Socket(); s1.connect(InetSocketAddress("127.0.0.1", port), 3000)
    val t1 = Tls.wrap(s1, "localhost", cliCtx.socketFactory, javax.net.ssl.HostnameVerifier { _, _ -> true })
    t1.outputStream.write("hello\n".toByteArray()); t1.outputStream.flush()
    ok("TLS to the right host: echo", t1.inputStream.bufferedReader().readLine() == "echo:hello")
    ok("read timeout cleared after the handshake", t1.soTimeout == 0)
    t1.close()

    // 2) чужое имя: сертификат выдан для localhost — должно быть отказом (проверка имени внутри рукопожатия)
    val s2 = Socket(); s2.connect(InetSocketAddress("127.0.0.1", port), 3000)
    val r2 = runCatching { Tls.wrap(s2, "other.example", cliCtx.socketFactory, javax.net.ssl.HostnameVerifier { _, _ -> true }) }
    ok("certificate for another host is refused", r2.isFailure, r2.exceptionOrNull()?.toString() ?: "accepted!")

    // 3) недоверенный сертификат: системное хранилище JVM не знает самоподписанный — отказ
    val s3 = Socket(); s3.connect(InetSocketAddress("127.0.0.1", port), 3000)
    val r3 = runCatching { Tls.wrap(s3, "localhost") }
    ok("untrusted certificate is refused", r3.isFailure, r3.exceptionOrNull()?.toString() ?: "accepted!")

    ss.close(); dir.deleteRecursively()
    println(if (bad > 0) "FAILED $bad" else "all ok"); if (bad > 0) System.exit(1)
}
