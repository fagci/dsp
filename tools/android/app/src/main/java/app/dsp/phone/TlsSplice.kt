package app.dsp.phone

import java.net.Socket
import java.util.concurrent.ExecutorService

/**
 * Один TCP-поток с TLS-перехватом: два TlsPump на двух независимых SSLEngine (TlsMitm.deviceSide — к приложению на телефоне,
 * TlsMitm.upstreamSide — к настоящему серверу), открытый текст одной стороны идёт m.onPlain (видимость) и тут же — другой
 * стороне на переупаковку. Два потока с данными: вызывающий (TcpFlow через writeQ) зовёт feedFromDevice, свой собственный
 * (startUpstreamPump) читает настоящий сокет. TlsPump сам ждёт своего хендшейка, если данные пришли раньше (gонка «устройство
 * быстрее настоящего сервера» — обычное дело) — здесь об этом заботиться не нужно.
 */
class TlsSplice(private val m: TlsMitm, private val sendToDevice: (ByteArray) -> Unit, private val onFinFromServer: () -> Unit, private val onFail: () -> Unit) {
    @Volatile private var sockOut: java.io.OutputStream? = null
    @Volatile private var failed = false
    private val device = TlsPump(m.deviceSide()) { d -> sendToDevice(d) }
    private val upstream = TlsPump(m.upstreamSide()) { d -> writeUpstream(d) }

    fun fail(msg: String) {
        if (failed) return; failed = true
        try { m.onError(msg) } catch (e: Exception) { }
        try { onFail() } catch (e: Exception) { }
    }

    private fun writeUpstream(d: ByteArray) {
        val os = sockOut ?: return
        try { os.write(d); os.flush() } catch (e: Exception) { fail("upstream write: ${e.message}") }
    }

    private fun safePlain(up: Boolean, d: ByteArray) { try { m.onPlain(up, d) } catch (e: Exception) { } }

    /** Шифротекст от устройства (с самого ClientHello): распаковывается, открытый текст уходит на видимость и настоящему серверу. */
    fun feedFromDevice(cipher: ByteArray) {
        if (failed) return
        try { device.unwrap(cipher) { plain -> safePlain(true, plain); upstream.wrap(plain) } } catch (e: Exception) { fail("device TLS: ${e.message}") }
    }

    /** Устройство закрыло свою сторону (FIN) — close_notify настоящему серверу; его ответ придёт обычным путём в startUpstreamPump. */
    fun deviceClosed() { if (!failed) try { upstream.closeOutbound() } catch (e: Exception) { fail("device close: ${e.message}") } }

    /** Запускает upstream сразу (ClientHello настоящему серверу — он говорит первым) и поток чтения его ответов; deviceSide
     *  начинает свой (отдельный, не связанный) хендшейк сам при первом feedFromDevice. */
    fun startUpstreamPump(sock: Socket, pool: ExecutorService) {
        sockOut = sock.getOutputStream()
        upstream.beginHandshake()
        pool.execute {
            val buf = ByteArray(16709)                                // максимум одной TLS-записи
            try {
                val ins = sock.getInputStream()
                while (true) {
                    val n = ins.read(buf)
                    if (n < 0) { onFinFromServer(); return@execute }                 // настоящий сервер закрылся штатно
                    if (n > 0) upstream.unwrap(buf.copyOf(n)) { plain -> safePlain(false, plain); device.wrap(plain) }
                }
            } catch (e: Exception) { fail("upstream TLS: ${e.javaClass.simpleName}: ${e.message}") }
        }
    }
}
