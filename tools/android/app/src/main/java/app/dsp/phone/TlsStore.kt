package app.dsp.phone

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext

/**
 * TLS для wss:// и https:// самого приложения. Закрытый ключ создаёт и хранит сам телефон (EC P-256, закрытая папка приложения) и
 * никуда не отдаёт: страница получает открытый ключ (tls.csr), подписывает для него сертификат своим центром (cert-kernels.js)
 * и присылает только сертификат (tls.install). Так по сети не ходит ничего секретного.
 */
object TlsStore {
    private fun key(dir: File) = File(dir, "key.pk8")
    private fun pub(dir: File) = File(dir, "pub.spki")
    private fun cert(dir: File) = File(dir, "cert.pem")

    /** Открытый ключ устройства (SubjectPublicKeyInfo, DER); ключа нет или renew — создаётся новый, прежний сертификат становится ненужным. */
    @Synchronized
    fun publicKey(dir: File, renew: Boolean = false): ByteArray {
        if (!renew && key(dir).exists() && pub(dir).exists()) return pub(dir).readBytes()
        dir.mkdirs()
        val g = KeyPairGenerator.getInstance("EC"); g.initialize(ECGenParameterSpec("secp256r1"))
        val kp = g.generateKeyPair()
        cert(dir).delete()
        writePrivate(key(dir), kp.private.encoded); pub(dir).writeBytes(kp.public.encoded)
        return kp.public.encoded
    }

    private fun writePrivate(f: File, data: ByteArray) {
        f.writeBytes(data)
        f.setReadable(false, false); f.setReadable(true, true); f.setWritable(false, false); f.setWritable(true, true)   // только владелец (приложение)
    }

    fun parseChain(pem: String): List<X509Certificate> {
        val cf = CertificateFactory.getInstance("X.509")
        val blocks = Regex("-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----", RegexOption.DOT_MATCHES_ALL).findAll(pem).map { it.groupValues[1] }.toList()
        require(blocks.isNotEmpty()) { "no certificate in the PEM" }
        require(blocks.size <= 5) { "too many certificates in the chain" }
        return blocks.map { cf.generateCertificate(ByteArrayInputStream(Base64.decode(it.replace(Regex("\\s"), ""), Base64.DEFAULT))) as X509Certificate }
    }

    /** Сохраняет сертификат (цепочку) для ключа этого устройства; текст ошибки или null. Чужой сертификат не принимается. */
    @Synchronized
    fun install(dir: File, certPem: String): String? {
        if (!key(dir).exists() || !pub(dir).exists()) return "no key on this device yet — ask for tls.csr first"
        val chain = try { parseChain(certPem) } catch (e: Exception) { return "certificate: ${e.message}" }
        val leaf = chain[0]
        if (!leaf.publicKey.encoded.contentEquals(pub(dir).readBytes())) return "the certificate was made for another key, not for this device's key (ask for tls.csr and sign that)"
        try { leaf.checkValidity() } catch (e: Exception) { return "certificate is not valid now: ${e.message}" }
        if (leaf.subjectAlternativeNames.isNullOrEmpty()) return "the certificate has no subject alternative names — browsers refuse such a certificate"
        cert(dir).writeText(certPem)
        return null
    }

    /** Контекст для сервера: ключ + цепочка; null, если сертификата ещё нет или он не подходит. */
    @Synchronized
    fun context(dir: File): SSLContext? {
        if (!key(dir).exists() || !cert(dir).exists()) return null
        return try {
            val chain = parseChain(cert(dir).readText())
            val priv = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(key(dir).readBytes()))
            if (!chain[0].publicKey.encoded.contentEquals(pub(dir).readBytes())) return null
            val ks = KeyStore.getInstance(KeyStore.getDefaultType()); ks.load(null, null)
            ks.setKeyEntry("dsp", priv, CharArray(0), chain.toTypedArray())
            val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()); kmf.init(ks, CharArray(0))
            SSLContext.getInstance("TLS").also { it.init(kmf.keyManagers, null, null) }
        } catch (e: Exception) { null }
    }

    @Synchronized fun remove(dir: File) { key(dir).delete(); pub(dir).delete(); cert(dir).delete() }

    /** Для tls.status: установлен ли сертификат, до какого срока, для каких имён. */
    fun status(dir: File): JSONObject {
        val o = JSONObject().put("key", key(dir).exists()).put("installed", false)
        try {
            if (cert(dir).exists()) {
                val leaf = parseChain(cert(dir).readText())[0]
                o.put("installed", true).put("notAfter", leaf.notAfter.time).put("subject", leaf.subjectX500Principal.name)
                val names = org.json.JSONArray(); for (n in leaf.subjectAlternativeNames ?: emptyList()) names.put(n[1].toString()); o.put("names", names)
            }
        } catch (e: Exception) { /* повреждённый файл — как «не установлен» */ }
        return o
    }
}

/** Команды tls.* (нужен c.power: страница приложения или «любая страница» в настройках). */
class TlsCmds(private val ctx: Context, private val server: BridgeServer) {
    private val dir get() = File(ctx.filesDir, "tls")

    /** При запуске службы: если сертификат уже стоит — поднять TLS. */
    fun start() { TlsStore.context(dir)?.let { server.setTls(it) } }

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        try {
            when (cmd) {
                "tls.csr" -> {
                    val renew = j.optBoolean("renew")
                    val spki = TlsStore.publicKey(dir, renew)
                    if (renew) server.setTls(null)
                    Reply.done(c, id, cmd, null, extra = arrayOf("spki" to Json.str(Base64.encodeToString(spki, Base64.NO_WRAP))))
                }
                "tls.install" -> {
                    val err = TlsStore.install(dir, j.optString("cert"))
                    if (err != null) return Reply.done(c, id, cmd, err)
                    val sc = TlsStore.context(dir) ?: return Reply.done(c, id, cmd, "the certificate does not fit the key")
                    val e = server.setTls(sc)
                    if (e != null) return Reply.done(c, id, cmd, e)
                    Reply.done(c, id, cmd, null, extra = arrayOf("port" to server.tlsPort.toString()))
                }
                "tls.remove" -> { TlsStore.remove(dir); server.setTls(null); Reply.done(c, id, cmd, null) }
                "tls.status" -> Reply.done(c, id, cmd, null, extra = arrayOf("port" to server.tlsPort.toString(), "info" to TlsStore.status(dir).toString()))
                else -> Reply.done(c, id, cmd, "unknown", "unknown")
            }
        } catch (e: Exception) { Reply.done(c, id, cmd, e.message ?: e.javaClass.simpleName) }
    }
}
