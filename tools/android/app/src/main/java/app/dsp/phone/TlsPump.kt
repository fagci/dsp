package app.dsp.phone

import java.nio.ByteBuffer
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLEngineResult

/**
 * Ведёт один SSLEngine синхронно, без NIO: шифротекст извне идёт в [unwrap] (хендшейк гонится сам, открытый текст приходит через
 * onPlain), открытый текст наружу — в [wrap] (результат уходит через writeCipher). TlsSplice держит два TlsPump — один на сторону
 * одного TCP-потока — и перекладывает открытый текст одного в другой. Вызовы на одном TlsPump сериализует вызывающий (как и весь
 * остальной VpnEngine — по потоку на соединение, не NIO/async).
 */
class TlsPump(private val engine: SSLEngine, private val writeCipher: (ByteArray) -> Unit) {
    private var inBuf = ByteBuffer.allocate(engine.session.packetBufferSize + 256)     // режим заполнения: [0,position) — непрочитанное
    private var pending = ByteArray(0)         // открытый текст, пришедший в wrap() раньше, чем у ЭТОГО движка закончился свой хендшейк со своим собеседником
    private var started = false
    @Volatile var closed = false; private set

    /** Начинает хендшейк — нужно стороне, которая говорит первой (клиент); сервер начинает сам при первом unwrap. */
    fun beginHandshake() { ensureStarted(); runHandshake() }

    /** Шифротекст от собеседника: гонит хендшейк и/или отдаёт открытый текст через onPlain (может прийти несколько кусков). */
    fun unwrap(cipher: ByteArray, onPlain: (ByteArray) -> Unit) {
        if (closed || cipher.isEmpty()) return
        ensureStarted()
        grow(cipher.size); inBuf.put(cipher)
        inBuf.flip(); drain(onPlain); inBuf.compact()
    }

    /** Открытый текст на отправку: шифрует (одной TLS-записью или несколькими, если больше max fragment) и шлёт через writeCipher.
     *  Если у ЭТОГО движка (например upstream к настоящему серверу) свой хендшейк ещё не закончен — данные ждут в pending
     *  и уходят сами, когда runHandshake() продвинется (вызывается из drain() при каждом unwrap, который меняет статус). */
    fun wrap(plain: ByteArray) {
        if (closed || plain.isEmpty()) return
        pending = if (pending.isEmpty()) plain else pending + plain
        flushPending()
    }

    private fun flushPending() {
        if (pending.isEmpty() || closed) return
        ensureStarted()
        val src = ByteBuffer.wrap(pending)
        while (src.hasRemaining()) {
            val out = ByteBuffer.allocate(engine.session.packetBufferSize)
            val before = src.position()
            val r = engine.wrap(src, out)
            if (r.status == SSLEngineResult.Status.CLOSED) { closed = true; break }
            flush(out); runTasks()
            if (src.position() == before && out.position() == 0) break        // застряли на NEED_UNWRAP — остаток ждёт, пока собеседник ответит
            if (r.status == SSLEngineResult.Status.BUFFER_OVERFLOW) break      // не должно случаться при packetBufferSize-буфере — защита от зависания
        }
        pending = if (src.hasRemaining()) ByteArray(src.remaining()).also { src.get(it) } else ByteArray(0)
    }

    /** close_notify наружу (штатное закрытие с этой стороны); unwrap продолжает принимать ответный close_notify как обычно. */
    fun closeOutbound() { if (closed) return; ensureStarted(); engine.closeOutbound(); runHandshake() }

    private fun ensureStarted() { if (!started) { started = true; engine.beginHandshake() } }

    private fun drain(onPlain: (ByteArray) -> Unit) {
        runHandshake()
        while (inBuf.hasRemaining()) {
            val out = ByteBuffer.allocate(engine.session.applicationBufferSize + 256)
            val pos = inBuf.position()
            val r = engine.unwrap(inBuf, out)
            when (r.status) {
                SSLEngineResult.Status.BUFFER_UNDERFLOW -> { inBuf.position(pos); return }       // неполный рекорд — ждём ещё байт следующим unwrap
                SSLEngineResult.Status.CLOSED -> { closed = true; return }
                SSLEngineResult.Status.OK -> {
                    out.flip()
                    if (out.hasRemaining()) { val d = ByteArray(out.remaining()); out.get(d); onPlain(d) }
                    if (r.handshakeStatus != SSLEngineResult.HandshakeStatus.NOT_HANDSHAKING) runHandshake()
                }
                else -> return
            }
        }
    }

    /** NEED_WRAP/NEED_TASK хендшейка — без входных байт (ClientHello, ServerHello…, финальный close_notify). */
    private fun runHandshake() {
        while (true) {
            when (engine.handshakeStatus) {
                SSLEngineResult.HandshakeStatus.NEED_TASK -> runTasks()
                SSLEngineResult.HandshakeStatus.NEED_WRAP -> {
                    val out = ByteBuffer.allocate(engine.session.packetBufferSize)
                    val r = engine.wrap(ByteBuffer.allocate(0), out)
                    flush(out)
                    if (r.status == SSLEngineResult.Status.CLOSED) { closed = true; return }
                }
                else -> { flushPending(); return }
            }
        }
    }

    private fun flush(out: ByteBuffer) { out.flip(); if (out.hasRemaining()) writeCipher(out.array().copyOf(out.limit())) }
    private fun runTasks() { while (true) { val t = engine.delegatedTask ?: break; t.run() } }
    private fun grow(extra: Int) {
        if (inBuf.remaining() >= extra) return
        val old = inBuf.duplicate().also { it.flip() }                            // [0,validLen) того, что ещё не прочитано
        val nb = ByteBuffer.allocate(maxOf(old.remaining() + extra, inBuf.capacity() * 2))
        nb.put(old); inBuf = nb
    }
}
