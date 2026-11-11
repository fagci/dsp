package app.dsp.phone

import org.json.JSONObject
import java.io.File
import java.security.KeyFactory
import java.security.KeyStore
import java.security.MessageDigest
import java.security.spec.PKCS8EncodedKeySpec
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine

/**
 * Центр сертификатов для TLS-перехвата (расшифровка только выбранных приложений — см. TlsSel в DspVpnService): свой собственный, отдельный
 * от TlsStore (тот — для wss:// / https:// самого моста, этот — подписывает ЛИСТОВЫЕ сертификаты «на лету» под SNI настоящего сервера).
 * Ключ центра создаётся на телефоне и никуда не уходит; пользователь САМ ставит открытый сертификат в системное хранилище
 * (Settings → Security → Encryption → Install a certificate — системный экран, не наш) — только тогда приложения, которые ему доверяют,
 * перестают жаловаться; приложения с certificate pinning (банки, большинство мессенджеров) всё равно откажут — это ожидаемо и не обходится.
 */
object MitmCa {
    private fun dir(base: File) = File(base, "mitm_ca").also { it.mkdirs() }
    private fun key(d: File) = File(d, "ca_key.pk8")
    private fun cert(d: File) = File(d, "ca_cert.der")
    private fun subj(d: File) = File(d, "ca_subject.der")   // issuer для листьев — те же байты, что сертификат центра несёт как subject (не переразбираем их из X500Principal)

    @Volatile private var cached: Pair<File, X509Gen.Cert>? = null
    private val leaves = object : LinkedHashMap<String, X509Gen.Cert>(64, 0.75f, true) {
        override fun removeEldestEntry(e: MutableMap.MutableEntry<String, X509Gen.Cert>?) = size > MAX_LEAVES
    }

    /** Центр: уже на диске — читается, иначе создаётся и сохраняется. Один на приложение (не на запрос), поэтому синхронизирован. */
    @Synchronized
    fun ca(base: File): X509Gen.Cert {
        val d = dir(base)
        cached?.let { (f, c) -> if (f == d) return c }
        if (key(d).exists() && cert(d).exists() && subj(d).exists()) {
            try {
                val priv = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(key(d).readBytes()))
                val c = java.security.cert.CertificateFactory.getInstance("X.509").generateCertificate(cert(d).inputStream()) as java.security.cert.X509Certificate
                val loaded = X509Gen.Cert(priv, listOf(c), subj(d).readBytes())
                cached = d to loaded; return loaded
            } catch (e: Exception) { /* повреждённые файлы — выпускаем новый центр ниже */ }
        }
        return reset(base)
    }

    /** Новый центр взамен прежнего — прежние листовые сертификаты сразу забываются (подписаны уже недействующим ключом), старый
     *  корень пользователю придётся снять в системных настройках самому (приложение не трогает системное хранилище сертификатов). */
    @Synchronized
    fun reset(base: File): X509Gen.Cert {
        val d = dir(base)
        val c = X509Gen.selfSignedCa("DSP workbench debug CA")
        key(d).writeBytes(c.key.encoded); key(d).setReadable(false, false); key(d).setReadable(true, true); key(d).setWritable(false, false); key(d).setWritable(true, true)
        cert(d).writeBytes(c.chain[0].encoded); subj(d).writeBytes(c.subjectDer)
        cached = d to c; synchronized(leaves) { leaves.clear() }
        return c
    }

    fun rootPem(base: File): String = X509Gen.pem("CERTIFICATE", ca(base).chain[0].encoded)

    /** Отпечаток корня (SHA-256, в столбик как у браузеров) — чтобы сверить до установки, без слепого доверия файлу. */
    fun fingerprint(base: File): String =
        MessageDigest.getInstance("SHA-256").digest(ca(base).chain[0].encoded).joinToString(":") { "%02X".format(it) }

    fun status(base: File): JSONObject {
        val c = ca(base).chain[0]
        return JSONObject().put("fingerprint", fingerprint(base)).put("notAfter", c.notAfter.time)
            .put("leaves", synchronized(leaves) { leaves.size })
    }

    /** Листовой сертификат для host, из кэша или новый (кешируем — переподписывать на каждое соединение незачем; забывается по LRU/reset). */
    private fun leaf(base: File, host: String): X509Gen.Cert = synchronized(leaves) {
        leaves.getOrPut(host) { X509Gen.leaf(host, ca(base)) }
    }

    /** SSLEngine в роли «сервер» для устройства: свой подписанный сертификат под SNI, которому доверяет только тот, у кого установлен корень. */
    fun serverEngine(base: File, host: String): SSLEngine {
        val l = leaf(base, host)
        val ks = KeyStore.getInstance(KeyStore.getDefaultType()); ks.load(null, null)
        ks.setKeyEntry("leaf", l.key, CharArray(0), l.chain.toTypedArray())
        val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()); kmf.init(ks, CharArray(0))
        val ctx = SSLContext.getInstance("TLS"); ctx.init(kmf.keyManagers, null, null)
        return ctx.createSSLEngine(host, 443).also { it.useClientMode = false }
    }

    private const val MAX_LEAVES = 300
}
