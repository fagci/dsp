package app.dsp.phone

/**
 * Сборка фрагментированных IPv4-датаграмм (RFC 791): куски одной датаграммы (src, dst, id, proto) приходят в любом порядке, повторы допустимы;
 * когда набралась вся длина — отдаётся целый пакет с пересчитанным заголовком (без MF и смещения, длина и контрольная сумма новые).
 * Без android.* — проверяется на JVM. Защита: не больше [maxDatagrams] незавершённых, до [maxSize] байт каждая, лишнее живёт [ttlMs].
 */
class IpDefrag(private val maxDatagrams: Int = 64, private val maxSize: Int = 65535, private val ttlMs: Long = 30_000) {
    private class Part(val off: Int, val data: ByteArray)
    private class Dgram(val t0: Long, var hdr: ByteArray) {
        val parts = ArrayList<Part>()
        var total = -1                                        // длина данных известна, когда пришёл последний кусок (MF = 0)
        var got = 0
    }
    private val pend = LinkedHashMap<String, Dgram>()
    var dropped = 0; private set                              // отброшено: переполнение, слишком большая датаграмма, истёк срок
    var done = 0; private set

    /** Целый пакет (не фрагмент) — это же и есть b[0, len); фрагмент — null, пока не собрана вся датаграмма, потом собранный пакет. */
    @Synchronized
    fun add(b: ByteArray, len: Int, now: Long = System.currentTimeMillis()): ByteArray? {
        if (len < 20) return null
        val ihl = (Ip.u8(b, 0) and 15) * 4; val total = Ip.u16(b, 2)
        if (ihl < 20 || total > len || total < ihl) return null
        val ff = Ip.u16(b, 6); val mf = ff and 0x2000 != 0; val off = (ff and 0x1FFF) * 8
        if (!mf && off == 0) return b.copyOf(total)           // не фрагмент
        expire(now)
        val dlen = total - ihl
        if (dlen <= 0 || (mf && dlen % 8 != 0) || off + dlen > maxSize - ihl) { dropped++; return null }
        val key = Ip.str(b, 12) + ">" + Ip.str(b, 16) + "#" + Ip.u16(b, 4) + "/" + Ip.u8(b, 9)
        var d = pend[key]
        if (d == null) {
            if (pend.size >= maxDatagrams) { pend.remove(pend.keys.first()); dropped++ }
            d = Dgram(now, b.copyOf(ihl)); pend[key] = d
        }
        if (d.parts.any { it.off == off && it.data.size >= dlen }) return null     // повтор того же куска
        d.parts.add(Part(off, b.copyOfRange(ihl, total)))
        if (!mf) d.total = off + dlen
        // заголовок берём у первого куска (смещение 0): у остальных options могут быть сокращены
        if (off == 0) d.hdr = b.copyOf(ihl)
        if (d.total < 0) return null
        val cov = BooleanArray(d.total)
        for (p in d.parts) for (i in p.off until minOf(d.total, p.off + p.data.size)) cov[i] = true
        if (cov.any { !it }) return null
        val h = d.hdr; val hl = (Ip.u8(h, 0) and 15) * 4
        val out = ByteArray(hl + d.total)
        System.arraycopy(h, 0, out, 0, hl)
        for (p in d.parts.sortedBy { it.off }) System.arraycopy(p.data, 0, out, hl + p.off, minOf(p.data.size, d.total - p.off))
        Ip.put16(out, 2, out.size); Ip.put16(out, 6, 0); Ip.put16(out, 10, 0)
        Ip.put16(out, 10, Ip.fold(Ip.sum(out, 0, hl)))
        pend.remove(key); done++
        return out
    }

    @Synchronized fun pending() = pend.size

    private fun expire(now: Long) {
        val it = pend.entries.iterator()
        while (it.hasNext()) if (now - it.next().value.t0 > ttlMs) { it.remove(); dropped++ }
    }
}
