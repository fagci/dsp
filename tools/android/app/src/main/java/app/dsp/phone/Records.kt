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

/** Разбор потока pcap (tcpdump -w -): заголовок файла, затем записи; пакеты отдаются по мере накопления байт. */
class PcapReader(private val onPacket: (tsMs: Long, link: Int, orig: Int, data: ByteArray) -> Unit) {
    private var buf = ByteArray(1 shl 16)
    private var len = 0
    private var le = true
    private var nano = false
    var link = 1; private set
    private var head = false

    /** false — это не pcap (поток дальше не разбирается). */
    var valid = true; private set

    private fun u32(o: Int): Long {
        val b = buf
        val v = if (le) (b[o].toLong() and 255) or ((b[o + 1].toLong() and 255) shl 8) or ((b[o + 2].toLong() and 255) shl 16) or ((b[o + 3].toLong() and 255) shl 24)
        else (b[o + 3].toLong() and 255) or ((b[o + 2].toLong() and 255) shl 8) or ((b[o + 1].toLong() and 255) shl 16) or ((b[o].toLong() and 255) shl 24)
        return v
    }

    fun feed(b: ByteArray, n: Int = b.size) {
        if (!valid) return
        if (len + n > buf.size) buf = buf.copyOf(maxOf(buf.size * 2, len + n))
        System.arraycopy(b, 0, buf, len, n); len += n
        var p = 0
        if (!head) {
            if (len < 24) return
            val m = ((buf[0].toLong() and 255) shl 24) or ((buf[1].toLong() and 255) shl 16) or ((buf[2].toLong() and 255) shl 8) or (buf[3].toLong() and 255)
            when (m) {
                0xa1b2c3d4L -> { le = false; nano = false }
                0xd4c3b2a1L -> { le = true; nano = false }
                0xa1b23c4dL -> { le = false; nano = true }
                0x4d3cb2a1L -> { le = true; nano = true }
                else -> { valid = false; return }
            }
            link = u32(20).toInt(); head = true; p = 24
        }
        while (len - p >= 16) {
            val incl = u32(p + 8)
            if (incl > 262144) { valid = false; return }
            if (len - p < 16 + incl) break
            val ms = u32(p) * 1000 + (if (nano) u32(p + 4) / 1_000_000 else u32(p + 4) / 1000)
            onPacket(ms, link, u32(p + 12).toInt(), buf.copyOfRange(p + 16, p + 16 + incl.toInt()))
            p += 16 + incl.toInt()
        }
        if (p > 0) { System.arraycopy(buf, p, buf, 0, len - p); len -= p }
    }
}

/** Заголовки пакета: Ethernet / Linux cooked / чистый IP → MAC, IP, протокол, порты. Данные — hex самого кадра. */
object Frame {
    class Info(
        val link: String, val srcMac: String?, val dstMac: String?, val ethType: Int, val ifIndex: Int,
        val ver: Int, val src: String?, val dst: String?, val proto: Int, val sport: Int, val dport: Int,
    )

    fun linkName(t: Int): String = when (t) { 1 -> "eth"; 101, 12 -> "ip"; 113 -> "sll"; 276 -> "sll2"; 0 -> "null"; 105 -> "wifi"; 127 -> "radiotap"; else -> "link$t" }

    private fun u8(b: ByteArray, o: Int) = b[o].toInt() and 255
    private fun u16(b: ByteArray, o: Int) = (u8(b, o) shl 8) or u8(b, o + 1)
    private fun mac(b: ByteArray, o: Int) = (0 until 6).joinToString(":") { String.format("%02x", u8(b, o + it)) }
    private fun v4(b: ByteArray, o: Int) = "${u8(b, o)}.${u8(b, o + 1)}.${u8(b, o + 2)}.${u8(b, o + 3)}"
    private fun v6(b: ByteArray, o: Int) = (0 until 8).joinToString(":") { Integer.toHexString(u16(b, o + 2 * it)) }

    fun parse(link: Int, b: ByteArray): Info {
        var off = 0; var type = 0; var sm: String? = null; var dm: String? = null; var ifx = 0
        when (link) {
            1 -> if (b.size >= 14) {
                dm = mac(b, 0); sm = mac(b, 6); type = u16(b, 12); off = 14
                while ((type == 0x8100 || type == 0x88a8) && b.size >= off + 4) { type = u16(b, off + 2); off += 4 }
            }
            113 -> if (b.size >= 16) { type = u16(b, 14); off = 16; if (u16(b, 4) == 6) sm = mac(b, 6) }
            276 -> if (b.size >= 20) { type = u16(b, 0); ifx = (u8(b, 4) shl 24) or (u8(b, 5) shl 16) or (u8(b, 6) shl 8) or u8(b, 7); off = 20; if (u8(b, 11) == 6) sm = mac(b, 12) }
            101, 12 -> if (b.isNotEmpty()) type = when (u8(b, 0) shr 4) { 4 -> 0x0800; 6 -> 0x86dd; else -> 0 }
        }
        var ver = 0; var src: String? = null; var dst: String? = null; var proto = 0; var sp = 0; var dp = 0
        if (type == 0x0800 && b.size >= off + 20) {
            ver = 4; val ihl = (u8(b, off) and 15) * 4; proto = u8(b, off + 9)
            src = v4(b, off + 12); dst = v4(b, off + 16)
            if ((proto == 6 || proto == 17) && ihl >= 20 && b.size >= off + ihl + 4) { sp = u16(b, off + ihl); dp = u16(b, off + ihl + 2) }
        } else if (type == 0x86dd && b.size >= off + 40) {
            ver = 6; proto = u8(b, off + 6); src = v6(b, off + 8); dst = v6(b, off + 24)
            if ((proto == 6 || proto == 17) && b.size >= off + 44) { sp = u16(b, off + 40); dp = u16(b, off + 42) }
        }
        return Info(linkName(link), sm, dm, type, ifx, ver, src, dst, proto, sp, dp)
    }
}

/** Камеры: вид по набору форматов вывода (тепловизоры и ИК-камеры отдают не YUV, а 16-битные кадры). */
object Cam {
    const val YUV = 0x23; const val Y16 = 0x20363159; const val DEPTH16 = 0x44363153; const val JPEG = 0x100; const val RAW = 0x20

    /** visible — обычная; ir — NIR-фильтр; thermal — 16 бит яркости (Y16) без YUV; depth — карта глубины (ToF / структурный свет). */
    fun kind(formats: Set<Int>, nir: Boolean): String = when {
        Y16 in formats && YUV !in formats -> "thermal"
        DEPTH16 in formats && YUV !in formats -> "depth"
        nir -> "ir"
        YUV in formats || JPEG in formats -> "visible"
        else -> "other"
    }

    /** Формат, в котором читаем кадры: YUV, иначе 16-битный. null — читать нечем. */
    fun pick(formats: Set<Int>): Int? = listOf(YUV, Y16, DEPTH16).firstOrNull { it in formats }
}

/** 16-битные кадры (тепловизор, глубина) → NV21 с автоконтрастом и палитрой; чистая логика — на JVM. */
object Gray16 {
    // «железо»: чёрный → фиолетовый → красный → жёлтый → белый (RGB)
    private val IRON = arrayOf(intArrayOf(0, 0, 0), intArrayOf(60, 0, 110), intArrayOf(200, 20, 30), intArrayOf(255, 220, 0), intArrayOf(255, 255, 255))

    /** Y, U, V для уровня t (0..255) по палитре gray / iron (BT.601). */
    fun yuv(t: Int, pal: String): IntArray {
        if (pal != "iron") return intArrayOf(t, 128, 128)
        val x = t / 255.0 * (IRON.size - 1); val i = minOf(x.toInt(), IRON.size - 2); val f = x - i
        val r = IRON[i][0] + (IRON[i + 1][0] - IRON[i][0]) * f; val g = IRON[i][1] + (IRON[i + 1][1] - IRON[i][1]) * f; val b = IRON[i][2] + (IRON[i + 1][2] - IRON[i][2]) * f
        return intArrayOf((0.299 * r + 0.587 * g + 0.114 * b).toInt().coerceIn(0, 255), (128 - 0.169 * r - 0.331 * g + 0.5 * b).toInt().coerceIn(0, 255),
            (128 + 0.5 * r - 0.419 * g - 0.081 * b).toInt().coerceIn(0, 255))
    }

    /** Границы контраста: 1 и 99 процентили ненулевых значений (ноль — нет данных). */
    fun range(vals: IntArray): Pair<Int, Int> {
        val hist = IntArray(65536); var n = 0
        for (v in vals) if (v != 0) { hist[v and 0xffff]++; n++ }
        if (n == 0) return 0 to 1
        var acc = 0; var lo = -1; var hi = 65535
        for (i in 1..65535) { acc += hist[i]; if (lo < 0 && acc > n / 100) lo = i; if (acc >= n - n / 100) { hi = i; break } }
        return maxOf(lo, 1) to maxOf(hi, maxOf(lo, 1) + 1)
    }

    /** vals — w×h (для DEPTH16 — уже только дальность). */
    fun toNv21(vals: IntArray, w: Int, h: Int, pal: String): ByteArray {
        val (lo, hi) = range(vals)
        val span = hi - lo
        val out = ByteArray(w * h * 3 / 2)
        val lut = Array(256) { yuv(it, pal) }
        for (y in 0 until h) for (x in 0 until w) {
            val v = vals[y * w + x]
            val c = lut[if (v == 0) 0 else ((v - lo).coerceIn(0, span) * 255L / span).toInt()]
            out[y * w + x] = c[0].toByte()
            if ((x and 1) == 0 && (y and 1) == 0) { val o = w * h + (y / 2) * w + x; out[o] = c[2].toByte(); out[o + 1] = c[1].toByte() }   // NV21: V, U
        }
        return out
    }
}

/** Что просить у системы под каждый источник; проверка строк, которые уходят в оболочку root. */
object Perms {
    private val LOC = listOf("android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION")
    private val POSITION = setOf("gps", "wifi", "ble", "bt", "gnss", "gnssraw", "nmea", "cell")

    /** Разрешения, нужные для набора источников (sdk — версия Android). Выданные отсеивает вызывающий. */
    fun forSubs(subs: Set<String>, sdk: Int, camera: Boolean): List<String> {
        val l = LinkedHashSet<String>()
        if (subs.any { it in POSITION }) l.addAll(LOC)
        if (sdk >= 31 && subs.any { it == "ble" || it == "bt" }) { l.add("android.permission.BLUETOOTH_SCAN"); l.add("android.permission.BLUETOOTH_CONNECT") }
        if (sdk >= 29 && ("steps" in subs || "step" in subs)) l.add("android.permission.ACTIVITY_RECOGNITION")
        if ("mic" in subs) l.add("android.permission.RECORD_AUDIO")
        if ("sms" in subs) l.add("android.permission.RECEIVE_SMS")
        if (camera) l.add("android.permission.CAMERA")
        return l.toList()
    }

    private val IFACE = Regex("[A-Za-z0-9_.:-]{1,32}")
    private val FILTER = Regex("[A-Za-z0-9 .:()!&|<>=\\[\\]/_-]{0,200}")
    fun iface(s: String): String? = s.trim().ifEmpty { "any" }.takeIf { IFACE.matches(it) }
    fun filter(s: String): String? = s.trim().takeIf { FILTER.matches(it) }
}
