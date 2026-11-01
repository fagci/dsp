package app.dsp.phone

/**
 * RTP (RFC 3550) → полезная нагрузка. Multicast-IPTV `rtp://@239.1.1.1:5004` несёт MPEG-TS (обычно 7 пакетов по 188 байт) после
 * заголовка RTP; ExoPlayer читает голый TS, поэтому заголовок (12 байт + CSRC + расширение, дополнение в конце) снимается.
 */
object RtpStrip {
    class Span(val off: Int, val len: Int)

    /** Где в датаграмме b[0 until len] полезная нагрузка; null — это не RTP версии 2 или заголовок обрезан. */
    fun span(b: ByteArray, len: Int): Span? {
        if (len < 12 || len > b.size) return null
        val b0 = b[0].toInt() and 0xFF
        if (b0 ushr 6 != 2) return null
        var off = 12 + (b0 and 0x0F) * 4
        if (b0 and 0x10 != 0) {                                           // расширение: 4 байта (профиль, длина в словах) + слова
            if (len < off + 4) return null
            val words = ((b[off + 2].toInt() and 0xFF) shl 8) or (b[off + 3].toInt() and 0xFF)
            off += 4 + words * 4
        }
        var end = len
        if (b0 and 0x20 != 0) {                                           // дополнение: последний байт — сколько байт убрать
            val pad = b[len - 1].toInt() and 0xFF
            if (pad == 0 || pad > len - off) return null
            end = len - pad
        }
        return if (off in 0 until end) Span(off, end - off) else null
    }

    /** Адрес для UdpDataSource: `rtp://@239.1.1.1:5004` → `udp://239.1.1.1:5004` (`@` — признак multicast в адресах IPTV, Android Uri его не любит). */
    fun udpUrl(url: String): String = url.replaceFirst(Regex("^(rtp|udp)://@?", RegexOption.IGNORE_CASE), "udp://")
}
