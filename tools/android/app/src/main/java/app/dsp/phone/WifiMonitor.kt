package app.dsp.phone

import org.json.JSONObject

/** Заголовок radiotap (link type 127) у кадров из монитор-режима: частота, уровень, скорость, наличие FCS. Читаются только поля до «signal». */
object Radiotap {
    class Info(val len: Int, val freq: Int, val signal: Int?, val rateKbps: Int?, val fcs: Boolean)

    private fun u16(b: ByteArray, o: Int) = (b[o].toInt() and 255) or ((b[o + 1].toInt() and 255) shl 8)
    private fun u32(b: ByteArray, o: Int) = u16(b, o).toLong() or (u16(b, o + 2).toLong() shl 16)

    // размер и выравнивание полей 0…5: TSFT, flags, rate, channel, FHSS, dBm antenna signal
    private val SIZE = intArrayOf(8, 1, 1, 4, 2, 1)
    private val ALIGN = intArrayOf(8, 1, 1, 2, 1, 1)

    fun parse(b: ByteArray): Info? {
        if (b.size < 8 || b[0].toInt() != 0) return null
        val len = u16(b, 2)
        if (len < 8 || len > b.size) return null
        var present = u32(b, 4); var off = 8
        while (present and 0x80000000L != 0L) {                 // цепочка слов present
            if (off + 4 > len) return null
            present = u32(b, off); off += 4
        }
        val first = u32(b, 4)
        var freq = 0; var signal: Int? = null; var rate: Int? = null; var fcs = false
        for (bit in 0..5) {
            if (first and (1L shl bit) == 0L) continue
            off = (off + ALIGN[bit] - 1) and (ALIGN[bit] - 1).inv()
            if (off + SIZE[bit] > len) return null
            when (bit) {
                1 -> fcs = b[off].toInt() and 0x10 != 0
                2 -> rate = (b[off].toInt() and 255) * 500
                3 -> freq = u16(b, off)
                5 -> signal = b[off].toInt()
            }
            off += SIZE[bit]
        }
        return Info(len, freq, signal, rate, fcs)
    }

    /** Частота, МГц → номер канала Wi-Fi; 0 — не канал Wi-Fi. */
    fun channel(f: Int): Int = when {
        f == 2484 -> 14
        f in 2412..2472 -> (f - 2407) / 5
        f in 5160..5885 -> (f - 5000) / 5
        f in 5955..7115 -> (f - 5950) / 5
        else -> 0
    }
}

/** Заголовок кадра 802.11: тип, подтип, адреса (сколько их есть в кадре) и BSSID. */
object Dot11 {
    class Info(val type: Int, val subtype: Int, val a1: String?, val a2: String?, val a3: String?, val bssid: String?) {
        val typeName get() = when (type) { 0 -> "mgmt"; 1 -> "ctrl"; 2 -> "data"; else -> "ext" }
    }

    private fun mac(b: ByteArray, o: Int) = (0 until 6).joinToString(":") { String.format("%02x", b[o + it].toInt() and 255) }

    fun parse(b: ByteArray): Info? {
        if (b.size < 2) return null
        val fc = (b[0].toInt() and 255) or ((b[1].toInt() and 255) shl 8)
        val type = (fc shr 2) and 3; val sub = (fc shr 4) and 15
        val toDs = fc and 0x100 != 0; val fromDs = fc and 0x200 != 0
        val a1 = if (b.size >= 10) mac(b, 4) else null
        val a2 = if (b.size >= 16) mac(b, 10) else null
        val a3 = if (b.size >= 22) mac(b, 16) else null
        val bssid = when (type) { 0 -> a3; 2 -> if (!toDs && !fromDs) a3 else if (toDs && !fromDs) a1 else if (fromDs && !toDs) a2 else null; else -> null }
        return Info(type, sub, a1, a2, a3, bssid)
    }
}

/** Скрипты root для монитор-режима. Всё, что подставляется в текст, прошло проверку здесь; из страницы строк в оболочку не попадает. */
object MonitorScript {
    private val IFACE = Regex("[a-z][a-z0-9]{0,14}")
    private val WIDTHS = setOf("NOHT", "HT20", "HT40+", "HT40-", "80MHz", "160MHz")
    private const val BINS = "iw /system/bin/iw /system/xbin/iw /data/local/tmp/iw /data/data/com.termux/files/usr/bin/iw"
    private const val FIND = "for B in $BINS; do command -v \$B >/dev/null 2>&1 && IW=\$B && break; done; [ -n \"\$IW\" ] || { echo 'iw not found' >&2; exit 127; }; "

    fun iface(s: String?): String? = s?.trim()?.takeIf { IFACE.matches(it) }

    /** «channel 6 HT20» или «freq 5180 80MHz»; null — не задано или не прошло проверку. */
    fun tune(j: JSONObject): String? {
        val w = j.optString("width", "").takeIf { it.isNotEmpty() }?.let { v -> WIDTHS.firstOrNull { it.equals(v, true) } ?: return null }
        val tail = if (w != null) " $w" else ""
        if (j.has("freq")) { val f = j.optInt("freq"); return if (f in 2400..7200) "freq $f$tail" else null }
        if (j.has("channel")) { val c = j.optInt("channel"); return if (c in 1..233) "channel $c$tail" else null }
        return null
    }

    fun on(iface: String, tune: String?): String =
        FIND + "( ip link set $iface down && \$IW dev $iface set type monitor && ip link set $iface up" + (if (tune != null) " && \$IW dev $iface set $tune" else "") +
            " ) || { ip link set $iface up; echo 'monitor mode failed — this chip or driver does not support it' >&2; exit 1; }"

    fun off(iface: String): String = FIND + "ip link set $iface down; \$IW dev $iface set type managed; ip link set $iface up"

    fun channel(iface: String, tune: String): String = FIND + "\$IW dev $iface set $tune"
}

/**
 * Монитор-режим Wi-Fi (только root): wifi.monitor включает его на интерфейсе (iw), по желанию с перебором каналов, wifi.channel
 * переключает канал; сами кадры идут источником pkt (tcpdump) с разобранным radiotap. Монитор-режим отключает обычный Wi-Fi телефона:
 * при остановке сервиса и по простою он возвращается в managed. Нужен включённый в Settings перехват пакетов (cfg.sniffer).
 */
class MonitorHub(private val cfg: Config) {
    @Volatile private var iface: String? = null
    @Volatile private var hop: Thread? = null
    @Volatile private var hopStop = false

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        if (!cfg.sniffer) return Reply.done(c, id, cmd, "packet capture is off — enable it in the app Settings (needs root)", "forbidden")
        Thread({
            try { run(c, id, cmd, j) } catch (e: Exception) { Reply.done(c, id, cmd, e.message ?: e.javaClass.simpleName) }
        }, "dsp-monitor").also { it.isDaemon = true }.start()
    }

    private fun run(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        when (cmd) {
            "wifi.monitor" -> {
                val i = MonitorScript.iface(j.optString("iface", "wlan0")) ?: return Reply.done(c, id, cmd, "iface: wlan0, wlan1…")
                if (!j.optBoolean("on", true)) { off(); return Reply.done(c, id, cmd, null, extra = arrayOf("iface" to Json.str(i), "on" to "false")) }
                val hopList = j.optJSONArray("hop")
                val tune = MonitorScript.tune(j)
                if ((j.has("channel") || j.has("freq")) && tune == null) return Reply.done(c, id, cmd, "channel 1…233 or freq 2400…7200, width NOHT / HT20 / HT40+ / HT40- / 80MHz / 160MHz")
                var chans: List<String>? = null
                if (hopList != null) {
                    if (hopList.length() == 0 || hopList.length() > 40) return Reply.done(c, id, cmd, "hop: 1…40 channels")
                    chans = (0 until hopList.length()).map { k -> MonitorScript.tune(JSONObject().put("channel", hopList.optInt(k)).also { o -> if (j.has("width")) o.put("width", j.optString("width")) }) ?: return Reply.done(c, id, cmd, "hop: channels 1…233") }
                }
                off()
                val (code, out) = RootSh.run(MonitorScript.on(i, tune ?: chans?.first()), 20_000)
                if (code != 0) return Reply.done(c, id, cmd, (if (code == -1) "no root (su): " else "") + out.trim().take(300).ifEmpty { "exit $code" })
                iface = i
                if (chans != null && chans.size > 1) startHop(i, chans, j.optInt("dwell", 500).coerceIn(250, 10_000))
                Reply.done(c, id, cmd, null, extra = arrayOf("iface" to Json.str(i), "on" to "true"))
            }
            "wifi.channel" -> {
                val i = iface ?: return Reply.done(c, id, cmd, "monitor mode is off — wifi.monitor first")
                val tune = MonitorScript.tune(j) ?: return Reply.done(c, id, cmd, "channel 1…233 or freq 2400…7200")
                stopHop()
                val (code, out) = RootSh.run(MonitorScript.channel(i, tune), 10_000)
                if (code != 0) return Reply.done(c, id, cmd, out.trim().take(300).ifEmpty { "exit $code" })
                Reply.done(c, id, cmd, null)
            }
            else -> Reply.done(c, id, cmd, "unknown command", "unknown")
        }
    }

    private fun startHop(i: String, chans: List<String>, dwellMs: Int) {
        stopHop(); hopStop = false
        hop = Thread({
            var k = 0
            while (!hopStop && iface == i) {
                try { Thread.sleep(dwellMs.toLong()) } catch (e: InterruptedException) { break }
                if (hopStop) break
                k = (k + 1) % chans.size
                RootSh.run(MonitorScript.channel(i, chans[k]), 5_000)
            }
        }, "dsp-hop").also { it.isDaemon = true; it.start() }
    }

    private fun stopHop() { hopStop = true; hop?.interrupt(); hop = null }

    /** Вернуть интерфейс в обычный режим. */
    private fun off() {
        stopHop()
        val i = iface ?: return
        iface = null
        RootSh.run(MonitorScript.off(i), 15_000)
    }

    fun held(): Int = if (iface != null) 1 else 0

    fun release() { Thread({ off() }, "dsp-monitor-off").also { it.isDaemon = true }.start() }

    fun close() = off()
}
