package app.dsp.phone

import java.time.ZoneId
import java.time.ZonedDateTime

/** Расчёт будильников без Android (проверяется на JVM): время суток, дни недели, ближайший запуск, пропуски в WAV для запасного звука. */
object AlarmCalc {
    /** Дни недели маской: пн=1 … вс=64; 0 — один раз. */
    private val NAMES = listOf("mon", "tue", "wed", "thu", "fri", "sat", "sun")

    /** «7:30», «07:30», «0730» → (час, минута); null — не время. */
    fun time(s: String?): Pair<Int, Int>? {
        val t = (s ?: return null).trim()
        val m = Regex("(\\d{1,2}):?(\\d{2})").matchEntire(t) ?: return null
        val h = m.groupValues[1].toInt(); val mi = m.groupValues[2].toInt()
        return if (h in 0..23 && mi in 0..59) h to mi else null
    }

    /** «mon,wed,fri», «weekdays», «weekend», «daily» или пусто (один раз) → маска; null — непонятное слово. */
    fun days(s: String?): Int? {
        var mask = 0
        for (w in (s ?: "").lowercase().split(Regex("[\\s,;/]+")).filter { it.isNotEmpty() }) {
            mask = mask or when (w) {
                "daily", "every", "everyday", "all" -> 127
                "weekdays", "workdays" -> 31
                "weekend", "weekends" -> 96
                "once", "-" -> 0
                else -> { val i = NAMES.indexOfFirst { w.startsWith(it) || it.startsWith(w) && w.length >= 2 }; if (i < 0) return null; 1 shl i }
            }
        }
        return mask
    }

    fun daysText(mask: Int): String = when (mask) {
        0 -> "once"; 127 -> "daily"; 31 -> "weekdays"; 96 -> "weekend"
        else -> NAMES.filterIndexed { i, _ -> mask and (1 shl i) != 0 }.joinToString(",")
    }

    /** Ближайший запуск строго после now: mask=0 — сегодня или завтра, иначе первый подходящий день недели. */
    fun next(now: ZonedDateTime, hour: Int, minute: Int, mask: Int): ZonedDateTime {
        for (i in 0L..8L) {
            val d = now.plusDays(i).withHour(hour).withMinute(minute).withSecond(0).withNano(0)
            if (d.isAfter(now) && (mask == 0 || mask and (1 shl (d.dayOfWeek.value - 1)) != 0)) return d
        }
        return now.plusDays(1)
    }

    fun nextMs(nowMs: Long, zone: ZoneId, hour: Int, minute: Int, mask: Int): Long =
        next(ZonedDateTime.ofInstant(java.time.Instant.ofEpochMilli(nowMs), zone), hour, minute, mask).toInstant().toEpochMilli()

    /** Запасной звук, если нет ни сети, ни образца: WAV 16 бит, моно, ~2 с — три коротких «бип» и пауза (проигрывается по кругу). */
    fun beepWav(rate: Int = 22050): ByteArray {
        val n = rate * 2
        val pcm = ByteArray(n * 2)
        for (i in 0 until n) {
            val t = i.toDouble() / rate
            val slot = (t * 5).toInt()                              // 0.2 с: бип, бип, бип, тишина, тишина
            val on = slot < 3 && (t * 5 - slot) < 0.6
            val v = if (on) (Math.sin(2 * Math.PI * 880 * t) * 0.6 * 32767).toInt() else 0
            pcm[2 * i] = (v and 0xff).toByte(); pcm[2 * i + 1] = ((v shr 8) and 0xff).toByte()
        }
        val out = java.io.ByteArrayOutputStream()
        fun le32(x: Int) { out.write(x and 0xff); out.write((x shr 8) and 0xff); out.write((x shr 16) and 0xff); out.write((x shr 24) and 0xff) }
        fun le16(x: Int) { out.write(x and 0xff); out.write((x shr 8) and 0xff) }
        out.write("RIFF".toByteArray()); le32(36 + pcm.size); out.write("WAVEfmt ".toByteArray()); le32(16); le16(1); le16(1); le32(rate); le32(rate * 2); le16(2); le16(16)
        out.write("data".toByteArray()); le32(pcm.size); out.write(pcm)
        return out.toByteArray()
    }

    /** Адрес потока из плейлиста .pls / .m3u (первая строка с http); обычный адрес и .m3u8 (HLS) возвращаются как есть. */
    fun streamFromPlaylist(url: String, body: String): String {
        val low = url.substringBefore('?').lowercase()
        if (!(low.endsWith(".pls") || low.endsWith(".m3u")) || body.trimStart().startsWith("#EXTM3U") && body.contains("#EXT-X-")) return url
        for (line in body.lineSequence()) {
            val t = line.trim().let { if (it.startsWith("File", true) && it.contains('=')) it.substringAfter('=').trim() else it }
            if (t.startsWith("http://", true) || t.startsWith("https://", true)) return t
        }
        return url
    }
}
