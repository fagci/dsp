package app.dsp.phone

import java.net.Socket
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/**
 * TLS поверх уже открытого TCP-сокета: сразу после connect (imaps, ircs, xmpps…) или после STARTTLS (xmpp, smtp, imap).
 * Сертификат проверяется системным хранилищем Android и по имени хоста — без этого «TLS» защищал бы только от подслушивания.
 */
object Tls {
    fun wrap(
        s: Socket, host: String,
        factory: SSLSocketFactory = SSLSocketFactory.getDefault() as SSLSocketFactory,
        verifier: HostnameVerifier = HttpsURLConnection.getDefaultHostnameVerifier(),
        timeoutMs: Int = 15_000,
    ): SSLSocket {
        s.soTimeout = timeoutMs                                  // рукопожатие не должно висеть вечно
        val t = factory.createSocket(s, host, s.port, true) as SSLSocket
        try {
            val p = t.sslParameters
            p.endpointIdentificationAlgorithm = "HTTPS"          // имя хоста сверяется внутри рукопожатия
            t.sslParameters = p
            t.startHandshake()
            if (!verifier.verify(host, t.session)) throw SSLPeerUnverifiedException("certificate does not match $host")
        } catch (e: Exception) {
            try { t.close() } catch (x: Exception) { /* уже закрыт */ }
            throw e
        }
        t.soTimeout = 0
        return t
    }
}
