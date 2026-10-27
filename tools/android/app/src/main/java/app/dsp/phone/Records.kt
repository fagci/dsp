package app.dsp.phone

/** Разбор данных без Android-типов — проверяется на JVM (tools/android/jvm-test). */
object Hex {
    private const val D = "0123456789abcdef"
    fun of(b: ByteArray, off: Int = 0, len: Int = b.size - off): String {
        val sb = StringBuilder(len * 2)
        for (i in off until off + len) { val v = b[i].toInt() and 255; sb.append(D[v shr 4]).append(D[v and 15]) }
        return sb.toString()
    }
}

/** Реклама BLE: AD-структуры из ScanRecord.getBytes() (реклама + ответ на скан). */
object Ad {
    class Parsed(
        val name: String?, val flags: Int?, val txp: Int?, val appearance: Int?,
        val uuids: List<String>, val mfr: Map<String, String>, val svc: Map<String, String>,
    )

    private fun uuid(b: ByteArray, off: Int, len: Int): String {
        val h = Hex.of(b.copyOfRange(off, off + len).reversedArray())             // в рекламе little-endian
        return if (len == 16) "${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}" else h
    }

    fun parse(b: ByteArray): Parsed {
        var name: String? = null; var short: String? = null; var flags: Int? = null; var txp: Int? = null; var app: Int? = null
        val uuids = LinkedHashSet<String>(); val mfr = LinkedHashMap<String, String>(); val svc = LinkedHashMap<String, String>()
        var i = 0
        while (i < b.size) {
            val len = b[i].toInt() and 255
            if (len == 0 || i + 1 + len > b.size) break
            val type = b[i + 1].toInt() and 255
            val o = i + 2; val n = len - 1                                          // данные: b[o until o+n]
            when (type) {
                0x01 -> if (n >= 1) flags = b[o].toInt() and 255
                0x02, 0x03 -> { var k = 0; while (k + 2 <= n) { uuids.add(uuid(b, o + k, 2)); k += 2 } }
                0x04, 0x05 -> { var k = 0; while (k + 4 <= n) { uuids.add(uuid(b, o + k, 4)); k += 4 } }
                0x06, 0x07 -> { var k = 0; while (k + 16 <= n) { uuids.add(uuid(b, o + k, 16)); k += 16 } }
                0x08 -> short = String(b, o, n, Charsets.UTF_8)
                0x09 -> name = String(b, o, n, Charsets.UTF_8)
                0x0A -> if (n >= 1) txp = b[o].toInt()
                0x19 -> if (n >= 2) app = (b[o].toInt() and 255) or ((b[o + 1].toInt() and 255) shl 8)
                0x16 -> if (n >= 2) svc[uuid(b, o, 2)] = Hex.of(b, o + 2, n - 2)
                0x20 -> if (n >= 4) svc[uuid(b, o, 4)] = Hex.of(b, o + 4, n - 4)
                0x21 -> if (n >= 16) svc[uuid(b, o, 16)] = Hex.of(b, o + 16, n - 16)
                0xFF -> if (n >= 2) {
                    val id = (b[o].toInt() and 255) or ((b[o + 1].toInt() and 255) shl 8)
                    mfr[String.format("%04x", id)] = Hex.of(b, o + 2, n - 2)
                }
            }
            i += 1 + len
        }
        return Parsed(name ?: short, flags, txp, app, uuids.toList(), mfr, svc)
    }
}

/** Wi-Fi: канал, полоса, разбор информационных элементов точки (API 30+). */
object WifiUtil {
    fun channel(f: Int): Int = when {
        f == 2484 -> 14
        f in 2412..2472 -> (f - 2407) / 5
        f in 5150..5895 -> (f - 5000) / 5
        f in 5955..7115 -> (f - 5950) / 5
        else -> 0
    }

    fun band(f: Int): String = if (f < 3000) "2.4" else if (f < 5925) "5" else "6"

    private val WIDTH = intArrayOf(20, 40, 80, 160, 160, 320)
    fun width(w: Int): Int = WIDTH.getOrElse(w) { 0 }

    /** Wi-Fi 4/5/6/6E/7 по ScanResult.WIFI_STANDARD_*: 1 legacy, 4 n, 5 ac, 6 ax, 7 ad, 8 be. */
    fun standard(s: Int): String? = when (s) { 1 -> "a/b/g"; 4 -> "n"; 5 -> "ac"; 6 -> "ax"; 7 -> "ad"; 8 -> "be"; else -> null }

    class Ies(val country: String?, val vendors: List<String>, val wpsMfr: String?, val wpsModel: String?, val wpsName: String?, val wps: Boolean)

    private fun ascii(b: ByteArray, o: Int, n: Int) = String(b, o, n, Charsets.UTF_8).trim { it <= ' ' }.ifEmpty { null }

    /** ies: (id, ext-id или -1, байты элемента без заголовка). */
    fun ies(list: List<Triple<Int, Int, ByteArray>>): Ies {
        var country: String? = null; var wps = false
        var mfr: String? = null; var model: String? = null; var dev: String? = null
        val vendors = LinkedHashSet<String>()
        for ((id, _, b) in list) {
            if (id == 7 && b.size >= 2) country = ascii(b, 0, 2)
            if (id == 221 && b.size >= 3) {
                val oui = Hex.of(b, 0, 3)
                if (vendors.size < 8) vendors.add(oui)
                if (oui == "0050f2" && b.size >= 4 && b[3].toInt() == 4) {                 // Wi-Fi Simple Configuration
                    wps = true
                    var k = 4
                    while (k + 4 <= b.size) {
                        val t = ((b[k].toInt() and 255) shl 8) or (b[k + 1].toInt() and 255)
                        val l = ((b[k + 2].toInt() and 255) shl 8) or (b[k + 3].toInt() and 255)
                        if (k + 4 + l > b.size) break
                        when (t) { 0x1021 -> mfr = ascii(b, k + 4, l); 0x1023 -> model = ascii(b, k + 4, l); 0x1011 -> dev = ascii(b, k + 4, l) }
                        k += 4 + l
                    }
                }
            }
        }
        return Ies(country, vendors.toList(), mfr, model, dev, wps)
    }
}

/** ГНСС: названия систем и диапазонов. */
object Gnss {
    fun constellation(t: Int): String = when (t) {
        1 -> "GPS"; 2 -> "SBAS"; 3 -> "GLONASS"; 4 -> "QZSS"; 5 -> "BEIDOU"; 6 -> "GALILEO"; 7 -> "IRNSS"; else -> "UNKNOWN"
    }

    /** Диапазон по несущей (Гц): L1/E1/B1C, L5/E5a/B2a, L2, GLONASS G1/G2, E5b/B2b, B1I, E6, B3. */
    fun band(hz: Double): String? {
        val m = hz / 1e6
        fun near(c: Double, tol: Double = 3.0) = Math.abs(m - c) <= tol
        return when {
            near(1575.42) -> "L1"; near(1176.45) -> "L5"; near(1227.6) -> "L2"; near(1561.098) -> "B1I"
            near(1207.14) -> "E5b"; near(1278.75) -> "E6"; near(1268.52) -> "B3"; near(1191.795) -> "E5"
            m in 1598.0..1610.0 -> "G1"; m in 1242.0..1252.0 -> "G2"; near(2492.028) -> "S"
            else -> null
        }
    }
}

/** Классический Bluetooth: основной класс устройства. */
object Bt {
    fun major(c: Int): String = when (c) {
        0x0000 -> "MISC"; 0x0100 -> "COMPUTER"; 0x0200 -> "PHONE"; 0x0300 -> "NETWORKING"; 0x0400 -> "AUDIO_VIDEO"
        0x0500 -> "PERIPHERAL"; 0x0600 -> "IMAGING"; 0x0700 -> "WEARABLE"; 0x0800 -> "TOY"; 0x0900 -> "HEALTH"; else -> "UNCATEGORIZED"
    }
}
