package app.dsp.phone

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.util.Date

/**
 * X.509v3 вручную (DER), EC P-256 + SHA-256: тот же приём, что у cert-kernels.js (страница подписывает сертификат для TlsStore), только
 * здесь — сам телефон подписывает ЛИСТОВЫЕ сертификаты своим собственным центром (MitmCa) для разбора TLS-перехвата на себе самом.
 * CertificateFactory используется только чтобы разобрать собранные байты обратно в X509Certificate — ничего не удостоверяет сама JVM.
 */
object X509Gen {
    private val OID_CN = byteArrayOf(0x55, 0x04, 0x03)                     // 2.5.4.3
    private const val OID_EC_SHA256 = "1.2.840.10045.4.3.2"
    private const val OID_BASIC_CONSTRAINTS = "2.5.29.19"
    private const val OID_KEY_USAGE = "2.5.29.15"
    private const val OID_EXT_KEY_USAGE = "2.5.29.37"
    private const val OID_SAN = "2.5.29.17"
    private const val OID_SKI = "2.5.29.14"
    private const val OID_AKI = "2.5.29.35"
    private const val OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1"

    // ---------- ASN.1 DER ----------
    private fun len(n: Int): ByteArray = when {
        n < 128 -> byteArrayOf(n.toByte())
        n < 256 -> byteArrayOf(0x81.toByte(), n.toByte())
        else -> byteArrayOf(0x82.toByte(), (n shr 8).toByte(), n.toByte())
    }
    private fun tlv(tag: Int, body: ByteArray): ByteArray { val out = ByteArrayOutputStream(); out.write(tag); out.write(len(body.size)); out.write(body); return out.toByteArray() }
    private fun seq(vararg a: ByteArray) = tlv(0x30, cat(*a))
    private fun seq(a: List<ByteArray>) = tlv(0x30, cat(*a.toTypedArray()))
    private fun setOf(vararg a: ByteArray) = tlv(0x31, cat(*a))
    private fun cat(vararg a: ByteArray): ByteArray { val out = ByteArrayOutputStream(); for (x in a) out.write(x); return out.toByteArray() }
    private fun int(b: ByteArray): ByteArray { var i = 0; while (i < b.size - 1 && b[i] == 0.toByte()) i++; val t = b.copyOfRange(i, b.size); return tlv(0x02, if (t.isNotEmpty() && (t[0].toInt() and 0x80) != 0) byteArrayOf(0) + t else t) }
    private fun smallInt(n: Int) = int(byteArrayOf(n.toByte()))
    private fun oid(s: String): ByteArray {
        val p = s.split('.').map { it.toInt() }
        val out = ByteArrayOutputStream(); out.write(p[0] * 40 + p[1])
        for (v in p.drop(2)) {
            var x = v; val t = ArrayList<Int>(); t.add(x and 127); x = x ushr 7
            while (x > 0) { t.add(0, (x and 127) or 128); x = x ushr 7 }
            for (b in t) out.write(b)
        }
        return tlv(0x06, out.toByteArray())
    }
    private fun utf8(s: String) = tlv(0x0c, s.toByteArray(Charsets.UTF_8))
    private fun octet(b: ByteArray) = tlv(0x04, b)
    private fun bool(v: Boolean) = tlv(0x01, byteArrayOf(if (v) 0xff.toByte() else 0))
    private fun bits(b: ByteArray, unused: Int = 0) = tlv(0x03, byteArrayOf(unused.toByte()) + b)
    private fun utcTime(d: Date): ByteArray {
        val c = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC")); c.time = d
        fun z(n: Int, w: Int = 2) = n.toString().padStart(w, '0')
        val y = c.get(java.util.Calendar.YEAR)
        val s = (if (y < 2050) z(y % 100) else z(y, 4)) + z(c.get(java.util.Calendar.MONTH) + 1) + z(c.get(java.util.Calendar.DAY_OF_MONTH)) +
            z(c.get(java.util.Calendar.HOUR_OF_DAY)) + z(c.get(java.util.Calendar.MINUTE)) + z(c.get(java.util.Calendar.SECOND)) + "Z"
        return tlv(if (y < 2050) 0x17 else 0x18, s.toByteArray(Charsets.US_ASCII))
    }
    private fun name(cn: String) = seq(setOf(seq(oid("2.5.4.3"), utf8(cn))))
    private fun ext(oidStr: String, critical: Boolean, value: ByteArray) = seq(*(listOf(oid(oidStr)) + (if (critical) listOf(bool(true)) else emptyList()) + listOf(octet(value))).toTypedArray())
    private fun serial(): ByteArray { val b = ByteArray(16); java.security.SecureRandom().nextBytes(b); b[0] = (b[0].toInt() and 0x7f).toByte(); if (b[0] == 0.toByte()) b[0] = 1; return b }
    private fun ski(pub: java.security.PublicKey): ByteArray {
        // keyIdentifier = SHA-1 of the subjectPublicKey BIT STRING contents (RFC 5280 §4.2.1.2 method 1); SPKI DER уже у pub.encoded
        return MessageDigest.getInstance("SHA-1").digest(readSpkiBits(pub.encoded))
    }
    // достаём содержимое BIT STRING (subjectPublicKey) из уже собранного SubjectPublicKeyInfo
    private fun readSpkiBits(spki: ByteArray): ByteArray {
        var p = 0
        fun readTlv(): Triple<Int, Int, Int> { val tag = spki[p].toInt() and 255; p++; var l = spki[p].toInt() and 255; p++; if (l and 0x80 != 0) { val n = l and 0x7f; l = 0; repeat(n) { l = (l shl 8) or (spki[p].toInt() and 255); p++ } }; return Triple(tag, p, l) }
        readTlv()                                          // outer SEQUENCE
        val (algTag, algStart, algLen) = readTlv(); p = algStart + algLen       // skip AlgorithmIdentifier
        val (bitTag, bitStart, bitLen) = readTlv()
        require(bitTag == 0x03) { "SPKI: expected BIT STRING" }
        return spki.copyOfRange(bitStart + 1, bitStart + bitLen)                // пропускаем байт «unused bits»
    }

    class Cert(val key: PrivateKey, val chain: List<X509Certificate>, val subjectDer: ByteArray)

    /** Самоподписанный корневой сертификат (CA:true) — остаётся только на телефоне; его открытую часть пользователь ставит на устройство. */
    fun selfSignedCa(cn: String, validDays: Int = 3650): Cert {
        val g = KeyPairGenerator.getInstance("EC"); g.initialize(ECGenParameterSpec("secp256r1")); val kp = g.generateKeyPair()
        val subj = name(cn)
        val der = build(kp, issuerName = subj, subjectName = subj, notBefore = Date(System.currentTimeMillis() - 86_400_000L), notAfter = Date(System.currentTimeMillis() + validDays * 86_400_000L),
            signerKey = kp.private, extra = listOf(ext(OID_BASIC_CONSTRAINTS, true, seq(bool(true))), ext(OID_KEY_USAGE, true, bits(byteArrayOf(0x04))), ext(OID_SKI, false, octet(ski(kp.public)))))
        return Cert(kp.private, listOf(parse(der)), subj)
    }

    /** Листовой сертификат для host (CN и SAN dNSName), подписанный центром [ca] (ключ и сертификат из selfSignedCa). */
    fun leaf(host: String, ca: Cert, validDays: Int = 397): Cert {
        val g = KeyPairGenerator.getInstance("EC"); g.initialize(ECGenParameterSpec("secp256r1")); val kp = g.generateKeyPair()
        val caCert = ca.chain[0]
        val san = seq(tlv(0x82, host.toByteArray(Charsets.US_ASCII)))         // [2] dNSName — один хост на сертификат (один хост, одно назначение)
        val aki = seq(tlv(0x80, ski(caCert.publicKey)))                      // [0] keyIdentifier
        val der = build(kp, issuerName = ca.subjectDer, subjectName = name(host),
            notBefore = Date(System.currentTimeMillis() - 86_400_000L), notAfter = Date(minOf(System.currentTimeMillis() + validDays * 86_400_000L, caCert.notAfter.time - 3600_000L)),
            signerKey = ca.key, extra = listOf(
                ext(OID_BASIC_CONSTRAINTS, true, seq(bool(false))), ext(OID_KEY_USAGE, true, bits(byteArrayOf(0x80.toByte()))),
                ext(OID_EXT_KEY_USAGE, false, seq(oid(OID_SERVER_AUTH))), ext(OID_SAN, false, san),
                ext(OID_SKI, false, octet(ski(kp.public))), ext(OID_AKI, false, aki)))
        return Cert(kp.private, listOf(parse(der), caCert), name(host))
    }

    private fun build(kp: KeyPair, issuerName: ByteArray, subjectName: ByteArray, notBefore: Date, notAfter: Date, signerKey: PrivateKey, extra: List<ByteArray>): ByteArray {
        val sigAlg = seq(oid(OID_EC_SHA256))
        val tbs = seq(
            tlv(0xa0, smallInt(2)),                                           // version v3
            serial().let { int(it) },
            sigAlg, issuerName,
            seq(utcTime(notBefore), utcTime(notAfter)),
            subjectName,
            kp.public.encoded,                                                // уже готовый SubjectPublicKeyInfo
            tlv(0xa3, seq(extra)))
        val sig = Signature.getInstance("SHA256withECDSA"); sig.initSign(signerKey); sig.update(tbs); val sv = sig.sign()
        return seq(tbs, sigAlg, bits(sv))
    }

    private fun parse(der: ByteArray): X509Certificate =
        CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der)) as X509Certificate

    fun pem(label: String, der: ByteArray): String {
        val b64 = java.util.Base64.getMimeEncoder(64, "\n".toByteArray()).encodeToString(der)
        return "-----BEGIN $label-----\n$b64\n-----END $label-----\n"
    }
}
