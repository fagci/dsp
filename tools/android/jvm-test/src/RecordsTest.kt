package app.dsp.phone.recordstest

import app.dsp.phone.Ad
import app.dsp.phone.Audio
import app.dsp.phone.Cam
import app.dsp.phone.Cmd
import app.dsp.phone.Gray16
import app.dsp.phone.RootCam
import app.dsp.phone.Frame
import app.dsp.phone.PcapReader
import app.dsp.phone.Perms
import app.dsp.phone.SnifferHub
import app.dsp.phone.UsbDesc
import app.dsp.phone.Bt
import app.dsp.phone.Gnss
import app.dsp.phone.Json
import app.dsp.phone.WifiUtil
import org.json.JSONObject

private var bad = 0
private fun ok(name: String, c: Boolean, x: String = "") { if (!c) { bad++; println("FAIL $name $x") } else println("ok   $name") }
private fun b(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }
private fun ascii(s: String) = s.toByteArray()

fun main() {
    // --- реклама BLE: флаги, имя, txpower, UUID 16/128, данные производителя и службы ---
    val adv = b(2, 0x01, 0x06) + b(5, 0x09) + ascii("Test") + b(2, 0x0A, 0xF4) +
        b(5, 0x03, 0x0F, 0x18, 0x0A, 0x18) +
        b(17, 0x07) + ByteArray(16) { (it + 1).toByte() } +
        b(8, 0xFF, 0x4C, 0x00, 0x02, 0x15, 0xAA, 0xBB, 0xCC) +
        b(6, 0x16, 0x6F, 0xFD, 0x01, 0x02, 0x03) + b(0, 0, 0)
    val p = Ad.parse(adv)
    ok("ble name / flags / txp", p.name == "Test" && p.flags == 6 && p.txp == -12, "${p.name} ${p.flags} ${p.txp}")
    ok("ble uuid16 little-endian", p.uuids.contains("180f") && p.uuids.contains("180a"), p.uuids.toString())
    ok("ble uuid128 reversed and dashed", p.uuids.any { it == "100f0e0d-0c0b-0a09-0807-060504030201" }, p.uuids.toString())
    ok("ble manufacturer (Apple 004c)", p.mfr["004c"] == "0215aabbcc", p.mfr.toString())
    ok("ble service data fd6f", p.svc["fd6f"] == "010203", p.svc.toString())
    ok("ble short name when no complete", Ad.parse(b(4, 0x08) + ascii("abc")).name == "abc")
    ok("ble broken length does not crash", Ad.parse(b(20, 0x09, 0x41)).name == null && Ad.parse(ByteArray(0)).uuids.isEmpty())
    ok("ble appearance", Ad.parse(b(3, 0x19, 0x41, 0x03)).appearance == 0x0341)

    // --- Wi-Fi ---
    ok("channels", WifiUtil.channel(2412) == 1 && WifiUtil.channel(2472) == 13 && WifiUtil.channel(2484) == 14 &&
        WifiUtil.channel(5180) == 36 && WifiUtil.channel(5745) == 149 && WifiUtil.channel(5955) == 1 && WifiUtil.channel(6415) == 93 && WifiUtil.channel(900) == 0)
    ok("bands", WifiUtil.band(2437) == "2.4" && WifiUtil.band(5500) == "5" && WifiUtil.band(5955) == "6")
    ok("widths", WifiUtil.width(0) == 20 && WifiUtil.width(2) == 80 && WifiUtil.width(3) == 160 && WifiUtil.width(5) == 320 && WifiUtil.width(9) == 0)
    ok("standards", WifiUtil.standard(4) == "n" && WifiUtil.standard(6) == "ax" && WifiUtil.standard(0) == null)
    val wps = b(0x00, 0x50, 0xF2, 0x04) + b(0x10, 0x21, 0x00, 0x04) + ascii("Acme") + b(0x10, 0x23, 0x00, 0x03) + ascii("R50") + b(0x10, 0x11, 0x00, 0x02) + ascii("AP")
    val ie = WifiUtil.ies(listOf(Triple(7, -1, ascii("RU") + b(1, 13, 20)), Triple(221, -1, wps), Triple(221, -1, b(0x00, 0x17, 0xF2, 1)), Triple(0, -1, ByteArray(0))))
    ok("ie country", ie.country == "RU", ie.country.toString())
    ok("ie wps attributes", ie.wps && ie.wpsMfr == "Acme" && ie.wpsModel == "R50" && ie.wpsName == "AP", "${ie.wpsMfr} ${ie.wpsModel} ${ie.wpsName}")
    ok("ie vendors OUIs", ie.vendors == listOf("0050f2", "0017f2"), ie.vendors.toString())
    ok("ie truncated wps does not crash", WifiUtil.ies(listOf(Triple(221, -1, b(0x00, 0x50, 0xF2, 0x04, 0x10, 0x21, 0x00, 0x40)))).wpsMfr == null)

    // --- ГНСС ---
    ok("constellations", Gnss.constellation(1) == "GPS" && Gnss.constellation(3) == "GLONASS" && Gnss.constellation(5) == "BEIDOU" && Gnss.constellation(6) == "GALILEO" && Gnss.constellation(99) == "UNKNOWN")
    ok("bands", Gnss.band(1575.42e6) == "L1" && Gnss.band(1176.45e6) == "L5" && Gnss.band(1227.6e6) == "L2" && Gnss.band(1602.5625e6) == "G1" && Gnss.band(1246.0e6) == "G2" && Gnss.band(100e6) == null)
    ok("bt major", Bt.major(0x200) == "PHONE" && Bt.major(0x700) == "WEARABLE" && Bt.major(0x1F00) == "UNCATEGORIZED")


    // --- сырые дескрипторы USB ---
    val dev = b(18, 1, 0x00, 0x02, 0, 0, 0, 64, 0xda, 0x0b, 0x38, 0x28, 0, 1, 1, 2, 3, 1)                       // bcdUSB 2.00
    val cfgBody = b(9, 4, 0, 0, 0, 255, 255, 255, 0) +                                                                // interface 0 alt 0, без точек
        b(9, 4, 0, 3, 1, 255, 255, 255, 0) + b(7, 5, 0x81, 0x02, 0x00, 0x02, 0) +                                     // alt 3: bulk IN 1, 512
        b(9, 4, 1, 0, 2, 255, 0, 0, 0) + b(7, 5, 0x02, 0x01, 0x00, 0x04 or 0x08, 1) + b(7, 5, 0x83, 0x03, 0x40, 0, 8)  // iso OUT 2 (3 транзакции/мкадр), interrupt IN 3
    val cfg = b(9, 2, 9 + cfgBody.size, 0, 2, 1, 0, 0x80, 250) + cfgBody
    val pd = UsbDesc.parse(dev + cfg)
    val c0 = pd.configs.getJSONObject(0)
    val ifs = c0.getJSONArray("ifaces")
    ok("usb desc: version, configuration value, each alternate is its own interface", pd.usb == "2.00" && c0.getInt("value") == 1 && ifs.length() == 3 &&
        ifs.getJSONObject(1).getInt("alt") == 3 && ifs.getJSONObject(0).getJSONArray("eps").length() == 0, pd.configs.toString())
    val e3 = ifs.getJSONObject(1).getJSONArray("eps").getJSONObject(0)
    ok("usb desc: bulk endpoint of alt 3", e3.getInt("num") == 1 && e3.getBoolean("in") && e3.getString("type") == "bulk" && e3.getInt("size") == 512)
    val eIso = ifs.getJSONObject(2).getJSONArray("eps").getJSONObject(0)
    ok("usb desc: isochronous endpoint, packet size with extra transactions", eIso.getString("type") == "isochronous" && !eIso.getBoolean("in") && eIso.getInt("size") == 1024 * 2 * 0 + 1024 * 2, eIso.toString())
    ok("usb desc: speed from the bulk packet size", pd.speedHint == "high-speed" && UsbDesc.parse(dev + b(9, 2, 25, 0, 1, 1, 0, 0x80, 50) + b(9, 4, 0, 0, 1, 255, 0, 0, 0) + b(7, 5, 0x81, 0x02, 0x40, 0, 0)).speedHint == "full-speed")
    ok("usb desc: truncated or empty input does not crash", UsbDesc.parse(ByteArray(0)).configs.length() == 0 && UsbDesc.parse((dev + cfg).copyOf(40)).usb == "2.00" && UsbDesc.parse(b(1, 1, 1)).configs.length() == 0)

    // скорость: нет bulk в текущей конфигурации, а в «другой» (тип 7) есть bulk 512 → устройство на full-speed
    val other = UsbDesc.parse(b(9, 7, 25, 0, 1, 1, 0, 0x80, 50) + b(9, 4, 0, 3, 1, 255, 255, 255, 0) + b(7, 5, 0x81, 0x02, 0x00, 0x02, 0))
    val own = UsbDesc.parse(dev + b(9, 2, 18, 0, 1, 1, 0, 0x80, 200) + b(9, 4, 0, 0, 0, 255, 255, 255, 0))
    ok("usb desc: other-speed configuration (type 7) is parsed", other.configs.length() == 1 && other.speedHint == "high-speed")
    ok("usb desc: no bulk here, bulk 512 in the other speed → full-speed", own.speedHint == "" && UsbDesc.speed(own, other) == "full-speed")
    ok("usb desc: own bulk 512 → high-speed; nothing known → empty", UsbDesc.speed(pd, null) == "high-speed" && UsbDesc.speed(own, null) == "" && UsbDesc.speed(null, null) == "")


    // --- камеры: тепловизор / ИК / глубина, 16-битные кадры ---
    ok("camera kinds by output formats", Cam.kind(setOf(Cam.YUV, Cam.JPEG), false) == "visible" && Cam.kind(setOf(Cam.Y16), false) == "thermal" &&
        Cam.kind(setOf(Cam.DEPTH16), false) == "depth" && Cam.kind(setOf(Cam.YUV), true) == "ir" && Cam.kind(setOf(Cam.RAW), false) == "other")
    ok("camera format pick: YUV first, then Y16, DEPTH16", Cam.pick(setOf(Cam.Y16, Cam.YUV)) == Cam.YUV && Cam.pick(setOf(Cam.DEPTH16, Cam.Y16)) == Cam.Y16 && Cam.pick(setOf(Cam.JPEG)) == null)
    val g = IntArray(16 * 16) { 1000 + (it % 16) * 100 }
    val (glo, ghi) = Gray16.range(g)
    ok("gray16 range ignores the extremes", glo in 1000..1200 && ghi in 2300..2500, "$glo $ghi")
    val gn = Gray16.toNv21(g, 16, 16, "gray")
    ok("gray16 → NV21 gray: left dark, right bright, chroma neutral", gn.size == 16 * 16 * 3 / 2 && (gn[0].toInt() and 255) < 30 && (gn[15].toInt() and 255) > 225 && (gn[16 * 16].toInt() and 255) == 128)
    val gi = Gray16.toNv21(g, 16, 16, "iron")
    ok("gray16 → NV21 iron: chroma follows the heat", (gi[16 * 16].toInt() and 255) != (gi[16 * 16 + 14].toInt() and 255) && (gi[15].toInt() and 255) > 200)
    ok("gray16: no data stays black, empty frame does not crash", (Gray16.toNv21(IntArray(64), 8, 8, "gray")[0].toInt() and 255) == 0 && Gray16.range(IntArray(4)) == (0 to 1))

    // --- команды: проверка аргументов ---
    ok("sms number", Cmd.number("+7 (900) 123-45-67") != null && Cmd.number("112") != null && Cmd.number("12") == null && Cmd.number("+7900;rm") == null && Cmd.number("abc") == null)
    val lim = Cmd.Limiter(3, 1000)
    ok("sms limiter: 3 per window, then free again", lim.allow(0) && lim.allow(10) && lim.allow(20) && !lim.allow(30) && lim.allow(1100))
    ok("ir pattern", Cmd.irPattern(org.json.JSONArray("[9000,4500,560,560]"))!!.size == 4 && Cmd.irPattern(org.json.JSONArray("[9000]")) == null &&
        Cmd.irPattern(org.json.JSONArray("[9000,0]")) == null && Cmd.irPattern(org.json.JSONArray("[9000,-5]")) == null && Cmd.irPattern(null) == null && Cmd.irPattern(org.json.JSONArray("[1,3000000]")) == null)
    ok("ir carrier must lie in the emitter ranges", Cmd.irFreqOk(38000, listOf(intArrayOf(30000, 60000))) && !Cmd.irFreqOk(20000, listOf(intArrayOf(30000, 60000))) && Cmd.irFreqOk(38000, emptyList()) && !Cmd.irFreqOk(0, emptyList()))
    ok("limit", Cmd.limit(0, 50, 500) == 50 && Cmd.limit(9999, 50, 500) == 500 && Cmd.limit(7, 50, 500) == 7)
    ok("perms: incoming SMS", Perms.forSubs(setOf("sms"), 34, false) == listOf("android.permission.RECEIVE_SMS"))


    // --- камеры с root: скрипты ---
    val us = RootCam.unhideScript("app.dsp.phone")!!
    ok("root cam: the unhide script names the package and both properties and restarts the service", us.contains("P='app.dsp.phone'") && us.contains("vendor.camera.aux.packagelist") && us.contains("persist.vendor.camera.privapp.list") && us.contains("killall camerahalserver cameraserver"), us)
    ok("root cam: the pkill pattern does not match the script's own command line (that was the exit 143)", Regex("camera[.]provider").containsMatchIn(us).not() && !us.contains("pkill -f camera.provider") && us.contains("pkill -f 'camera[.]provider'"))
    ok("root cam: the properties are set (and reported) before the restart can kill the shell", us.indexOf("echo propsset") in 1 until us.indexOf("pkill") && RootCam.done("OLD a=b\npropsset\n") && !RootCam.done("OLD a=b\n"))
    ok("root cam: shell variables survived the template", us.contains("getprop \$K") && us.contains("\${C:+\$C,}\$P") && !us.contains("§") && !us.contains("@PKG@") && !us.contains("@PROPS@"), us)
    ok("root cam: a package name with extra characters is refused", RootCam.unhideScript("a;rm -rf /") == null && RootCam.unhideScript("a b") == null && RootCam.unhideScript("") == null && RootCam.unhideScript("x'y") == null && RootCam.restoreScript("a;b") == null)
    val rs = RootCam.restoreScript("app.dsp.phone")!!
    ok("root cam: restore takes only our package out of each list and restarts", rs.contains("sed \"s/,\$P,/,/g;s/^,//;s/,\\\$//\"") && rs.contains("setprop \$K \"\$N\"") && rs.contains("echo propsset") && rs.contains("pkill -f 'camera[.]provider'"), rs)
    ok("root cam: the read-only script does not write anything", !RootCam.INFO.contains("setprop") && !RootCam.INFO.contains("kill") && RootCam.INFO.contains("dumpsys media.camera"))
    ok("root cam: clip", RootCam.clip("abc", 5) == "abc" && RootCam.clip("abcdef", 3).startsWith("abc\n…"))
    // сам sed-скрипт отката: убирает пакет из середины, начала и конца списка и ничего не трогает в остальном
    fun sedPkg(list: String): String? {
        val r = ProcessBuilder("sh", "-c", "P='app.dsp.phone'; C='$list'; echo \",\$C,\" | sed \"s/,\$P,/,/g;s/^,//;s/,\\\$//\"").redirectErrorStream(true).start()
        return r.inputStream.bufferedReader().readText().trim().also { r.waitFor() }
    }
    ok("root cam: the removal expression works on real sed", sedPkg("app.dsp.phone") == "" && sedPkg("a.b,app.dsp.phone") == "a.b" && sedPkg("app.dsp.phone,c.d") == "c.d" && sedPkg("a.b,app.dsp.phone,c.d") == "a.b,c.d" && sedPkg("a.b") == "a.b" && sedPkg("") == "")

    // --- JSON-помощники дают валидный JSON ---
    val j = JSONObject(Json.obj("src" to "\"ble\"", "mfr" to Json.map(mapOf("004c" to "02")), "uuids" to Json.arr(listOf("180f", "a\"b")), "n" to null, "x" to Json.num(1.23456789, 1e4)))
    ok("json helpers", j.getJSONObject("mfr").getString("004c") == "02" && j.getJSONArray("uuids").getString(1) == "a\"b" && !j.has("n") && j.getDouble("x") == 1.2346)

    // --- pcap, кадры, разрешения ---
    fun le32(v: Long) = byteArrayOf(v.toByte(), (v shr 8).toByte(), (v shr 16).toByte(), (v shr 24).toByte())
    fun pcapHead(link: Long) = le32(0xa1b2c3d4L) + b(2, 0, 4, 0) + le32(0) + le32(0) + le32(65535) + le32(link)
    fun rec(sec: Long, us: Long, d: ByteArray) = le32(sec) + le32(us) + le32(d.size.toLong()) + le32(d.size.toLong() + 10) + d
    val tcp = b(0x45, 0, 0, 40, 0, 0, 0, 0, 64, 6, 0, 0, 10, 0, 0, 1, 93, 184, 216, 34, 0x30, 0x39, 0, 80) + ByteArray(16)
    val eth = b(0xaa, 0xbb, 0xcc, 0, 0, 1, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x08, 0x00) + tcp
    val got = ArrayList<Triple<Long, Int, ByteArray>>()
    val rd = PcapReader { ms, link, orig, d -> got.add(Triple(ms, link * 1000 + orig - d.size, d)) }
    val stream = pcapHead(1) + rec(1700000000, 250000, eth) + rec(1700000001, 0, eth)
    for (i in stream.indices step 7) rd.feed(stream.copyOfRange(i, minOf(i + 7, stream.size)))     // кусками по 7 байт
    ok("pcap: two packets from chunked input", got.size == 2 && got[0].first == 1700000000250L && got[1].first == 1700000001000L, got.joinToString { it.first.toString() })
    ok("pcap: link type and original length", got[0].second == 1010 && got[0].third.contentEquals(eth))
    val junk = PcapReader { _, _, _, _ -> }; junk.feed(ByteArray(40) { 7 })
    ok("pcap: garbage is refused", !junk.valid)
    val h = Frame.parse(1, eth)
    ok("frame eth+ipv4+tcp", h.link == "eth" && h.dstMac == "aa:bb:cc:00:00:01" && h.srcMac == "11:22:33:44:55:66" && h.ethType == 0x800 &&
        h.src == "10.0.0.1" && h.dst == "93.184.216.34" && h.proto == 6 && h.sport == 12345 && h.dport == 80, "${h.src} ${h.dst} ${h.sport} ${h.dport}")
    val raw = Frame.parse(101, tcp)
    ok("frame raw ip", raw.link == "ip" && raw.src == "10.0.0.1" && raw.dport == 80)
    val sll = Frame.parse(113, b(0, 0, 0, 1, 0, 6, 1, 2, 3, 4, 5, 6, 0, 0, 0x08, 0x00) + tcp)
    ok("frame linux cooked", sll.link == "sll" && sll.srcMac == "01:02:03:04:05:06" && sll.dst == "93.184.216.34")
    val sll2 = Frame.parse(276, b(0x08, 0x00, 0, 0, 0, 0, 0, 3, 0, 1, 0, 6, 9, 8, 7, 6, 5, 4, 0, 0) + tcp)
    ok("frame linux cooked v2: interface index", sll2.link == "sll2" && sll2.ifIndex == 3 && sll2.srcMac == "09:08:07:06:05:04" && sll2.sport == 12345)
    val v6 = b(0x60, 0, 0, 0, 0, 8, 17, 64) + ByteArray(15) + b(1) + ByteArray(15) + b(2) + b(0, 53, 0xd4, 0x31, 0, 8, 0, 0)
    val f6 = Frame.parse(101, v6)
    ok("frame ipv6+udp", f6.ver == 6 && f6.proto == 17 && f6.sport == 53 && f6.dport == 0xd431 && f6.src == "0:0:0:0:0:0:0:1", "${f6.src} ${f6.sport}")
    ok("frame short does not crash", Frame.parse(1, b(1, 2, 3)).src == null && Frame.parse(276, ByteArray(0)).src == null)
    ok("perms: location sources", Perms.forSubs(setOf("gps", "cell"), 34, false).size == 2 && Perms.forSubs(setOf("accel"), 34, false).isEmpty())
    ok("perms: bluetooth by version", Perms.forSubs(setOf("ble"), 34, false).any { it.endsWith("BLUETOOTH_SCAN") } && Perms.forSubs(setOf("ble"), 29, false).none { it.endsWith("BLUETOOTH_SCAN") })
    ok("perms: steps, mic, camera", Perms.forSubs(setOf("steps", "mic"), 34, true).map { it.substringAfterLast('.') } == listOf("ACTIVITY_RECOGNITION", "RECORD_AUDIO", "CAMERA"))
    ok("sniffer: interface and filter checked", Perms.iface("wlan0") == "wlan0" && Perms.iface("") == "any" && Perms.iface("a; reboot") == null && Perms.iface("a b") == null &&
        Perms.filter("tcp port 80 and not host 10.0.0.1") == "tcp port 80 and not host 10.0.0.1" && Perms.filter("tcp'; reboot; '") == null && Perms.filter("\$(id)") == null && Perms.filter("`id`") == null)
    ok("sniffer: script has no stray quotes", SnifferHub.script("any", 256, "tcp").contains("-i any -U -n -s 256 -w - 'tcp'"))
    ok("dbfs", Audio.dbfs(32768.0) == 0.0 && Math.abs(Audio.dbfs(3276.8) + 20.0) < 1e-9 && Audio.dbfs(0.0) == -120.0)
    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
