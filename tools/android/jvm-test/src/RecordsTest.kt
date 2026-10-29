package app.dsp.phone.recordstest

import app.dsp.phone.Ad
import app.dsp.phone.Args
import app.dsp.phone.BridgeServer
import app.dsp.phone.NetParse
import app.dsp.phone.Audio
import app.dsp.phone.Cmd
import app.dsp.phone.Frame
import app.dsp.phone.PcapReader
import app.dsp.phone.Perms
import app.dsp.phone.SnifferHub
import app.dsp.phone.UsbDesc
import app.dsp.phone.Bt
import app.dsp.phone.Gnss
import app.dsp.phone.GattSpec
import app.dsp.phone.WifiArgs
import app.dsp.phone.WifiNetArgs
import app.dsp.phone.Radiotap
import app.dsp.phone.Dot11
import app.dsp.phone.MonitorScript
import org.json.JSONArray
import app.dsp.phone.Json
import app.dsp.phone.ActivityModel
import app.dsp.phone.Launch
import app.dsp.phone.PowerPolicy
import app.dsp.phone.WifiUtil
import org.json.JSONObject

private var bad = 0
private fun ok(name: String, c: Boolean, x: String = "") { if (!c) { bad++; println("FAIL $name $x") } else println("ok   $name") }
private fun b(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }
private fun ascii(s: String) = s.toByteArray()

fun main() {
    // --- питание: во сколько раз реже опрашивать ---
    ok("power: full battery, cool → 1", PowerPolicy.factor(80, false, false, 0) == 1)
    ok("power: <20% → 2, <10% → 4", PowerPolicy.factor(15, false, false, 0) == 2 && PowerPolicy.factor(5, false, false, 0) == 4)
    ok("power: charging ignores low level", PowerPolicy.factor(5, true, false, 0) == 1)
    ok("power: saver → 2, saver on charger → 1", PowerPolicy.factor(80, false, true, 0) == 2 && PowerPolicy.factor(80, true, true, 0) == 1)
    ok("power: thermal moderate 2, severe 4 (also on charger)", PowerPolicy.factor(80, true, false, 2) == 2 && PowerPolicy.factor(80, true, false, 3) == 4)
    ok("power: hysteresis (19→22% stays throttled, 23% releases)", PowerPolicy.factor(22, false, false, 0, prev = 2) == 2 && PowerPolicy.factor(23, false, false, 0, prev = 2) == 1)
    ok("power: unknown level (-1) does not throttle", PowerPolicy.factor(-1, false, false, 0) == 1)

    // --- GATT-сервер: разбор служб, смещения, CCCD ---
    run {
        val p = GattSpec.parse(JSONArray("""[{"uuid":"180d","chars":[{"uuid":"2a37","props":["read","notify"],"hex":"0600"},{"uuid":"2a38","props":["write","writenr"],"auto":false,"secure":true}]}]"""))
        ok("gattsrv: parse ok", p.err == null && p.svcs.size == 1 && p.svcs[0].chars.size == 2, p.err ?: "")
        val c0 = p.svcs[0].chars[0]; val c1 = p.svcs[0].chars[1]
        ok("gattsrv: props / perms from names", c0.props == 0x02 or 0x10 && c0.perms == 0x01 && c1.props == 0x08 or 0x04 && c1.perms == 0x20 && !c1.auto)
        ok("gattsrv: value hex", c0.value.contentEquals(byteArrayOf(6, 0)))
        ok("gattsrv: uuid short form → full", p.svcs[0].uuid.toString() == "0000180d-0000-1000-8000-00805f9b34fb")
        ok("gattsrv: errors", GattSpec.parse(null).err != null && GattSpec.parse(JSONArray("""[{"uuid":"zz"}]""")).err != null &&
            GattSpec.parse(JSONArray("""[{"uuid":"180d","chars":[{"uuid":"2a37","props":["fly"]}]}]""")).err != null &&
            GattSpec.parse(JSONArray("""[{"uuid":"180d","chars":[{"uuid":"2a37","props":[]}]}]""")).err != null)
        ok("gattsrv: limits", GattSpec.parse(JSONArray((1..9).map { """{"uuid":"18$it"}""" }.joinToString(",", "[", "]").let { s -> s })).err != null)
        ok("gattsrv: slice with offset, invalid offset → null", GattSpec.slice(byteArrayOf(1, 2, 3), 1)!!.contentEquals(byteArrayOf(2, 3)) && GattSpec.slice(byteArrayOf(1), 2) == null && GattSpec.slice(byteArrayOf(1), 1)!!.isEmpty())
        ok("gattsrv: merge at offset pads with zeros", GattSpec.merge(byteArrayOf(1, 2), 1, byteArrayOf(9, 8, 7)).contentEquals(byteArrayOf(1, 9, 8, 7)) && GattSpec.merge(byteArrayOf(1), 3, byteArrayOf(5)).contentEquals(byteArrayOf(1, 0, 0, 5)))
        ok("gattsrv: cccd modes", GattSpec.cccdMode(byteArrayOf(1, 0)) == 1 && GattSpec.cccdMode(byteArrayOf(2, 0)) == 2 && GattSpec.cccdMode(null) == 0 && GattSpec.cccdBytes(2).contentEquals(byteArrayOf(2, 0)))
    }

    ok("l2cap: psm bounds", Args.psm(128) && Args.psm(65535) && !Args.psm(0) && !Args.psm(65536))

    // --- NSD / RTT / Aware: разбор аргументов ---
    ok("nsd: type normalised, bad ones refused", WifiArgs.nsdType("_http._tcp") == "_http._tcp" && WifiArgs.nsdType(" _ipp._tcp. ") == "_ipp._tcp" && WifiArgs.nsdType("_http._tcp,_printer") == "_http._tcp" &&
        WifiArgs.nsdType("http.tcp") == null && WifiArgs.nsdType("_http._icmp") == null && WifiArgs.nsdType("_a b._tcp") == null && WifiArgs.nsdType(null) == null)
    ok("nsd: name 1…63 bytes, no control chars", WifiArgs.nsdName("DSP phone") == "DSP phone" && WifiArgs.nsdName("") == null && WifiArgs.nsdName("a".repeat(64)) == null && WifiArgs.nsdName("a\nb") == null && WifiArgs.nsdName("я".repeat(32)) == null)
    ok("aware: service name", WifiArgs.awareName("dsp.chat-1") == "dsp.chat-1" && WifiArgs.awareName("bad name") == null && WifiArgs.awareName("") == null)
    ok("rtt: bssid list", WifiArgs.macList(JSONArray("""["aa:bb:cc:dd:ee:ff","11-22-33-44-55-66"]"""), 4)!!.joinToString() == "AA:BB:CC:DD:EE:FF, 11:22:33:44:55:66" &&
        WifiArgs.macList(JSONArray("""["zz"]"""), 4) == null && WifiArgs.macList(JSONArray("""["aa:bb:cc:dd:ee:ff","aa:bb:cc:dd:ee:00"]"""), 1) == null && WifiArgs.macList(null, 4)!!.isEmpty())
    ok("rtt: millimetres → metres", WifiArgs.metres(1234) == 1.234 && WifiArgs.metres(0) == 0.0)

    // --- монитор-режим: radiotap, заголовок 802.11, скрипты root ---
    run {
        // radiotap: версия 0, длина 16, present = flags | rate | channel | signal; flags 0x10 — в конце FCS
        val rt = byteArrayOf(0, 0, 16, 0, 0x2E, 0, 0, 0, 0x10, 0x0C, 0x6C, 0x09, 0xA0.toByte(), 0x00, 0xC8.toByte(), 0)
        val beacon = byteArrayOf(0x80.toByte(), 0, 0, 0, -1, -1, -1, -1, -1, -1, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0, 0)
        val r = Radiotap.parse(rt + beacon)!!
        ok("radiotap: length, frequency, signal, rate, FCS flag", r.len == 16 && r.freq == 2412 && r.signal == -56 && r.rateKbps == 6000 && r.fcs, "${r.len} ${r.freq} ${r.signal} ${r.rateKbps} ${r.fcs}")
        ok("radiotap: channel numbers", Radiotap.channel(2412) == 1 && Radiotap.channel(2484) == 14 && Radiotap.channel(5180) == 36 && Radiotap.channel(5955) == 1 && Radiotap.channel(1000) == 0)
        ok("radiotap: junk refused", Radiotap.parse(byteArrayOf(1, 0, 8, 0, 0, 0, 0, 0)) == null && Radiotap.parse(byteArrayOf(0, 0, 40, 0, 0, 0, 0, 0)) == null && Radiotap.parse(ByteArray(3)) == null)
        // TSFT (8 байт, выравнивание 8) перед остальными полями
        val withTsft = byteArrayOf(0, 0, 24, 0, 0x2F, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x0C, 0x71, 0x09, 0, 0, 0xC0.toByte(), 0)
        val t = Radiotap.parse(withTsft)!!
        ok("radiotap: TSFT is skipped with its alignment", t.freq == 2417 && t.signal == -64 && t.rateKbps == 6000 && !t.fcs, "${t.freq} ${t.signal}")
        val d = Dot11.parse(beacon)!!
        ok("dot11: beacon is mgmt/8 with three addresses and BSSID", d.typeName == "mgmt" && d.subtype == 8 && d.a1 == "ff:ff:ff:ff:ff:ff" && d.a2 == "11:22:33:44:55:66" && d.bssid == "11:22:33:44:55:66")
        val ack = Dot11.parse(byteArrayOf(0xD4.toByte(), 0, 0, 0, 1, 2, 3, 4, 5, 6))!!
        ok("dot11: ACK has only the receiver address", ack.typeName == "ctrl" && ack.subtype == 13 && ack.a1 == "01:02:03:04:05:06" && ack.a2 == null && ack.bssid == null)
        val toAp = Dot11.parse(byteArrayOf(0x08, 0x01, 0, 0) + byteArrayOf(0xA, 0xB, 0xC, 0xD, 0xE, 0xF) + ByteArray(6) { 2 } + ByteArray(6) { 3 })!!
        ok("dot11: data frame to the AP — BSSID is address 1", toAp.typeName == "data" && toAp.bssid == "0a:0b:0c:0d:0e:0f")
        ok("dot11: empty is null", Dot11.parse(ByteArray(1)) == null)
    }
    run {
        ok("monitor: iface names", MonitorScript.iface("wlan0") == "wlan0" && MonitorScript.iface(" mon0 ") == "mon0" && MonitorScript.iface("wlan0;reboot") == null && MonitorScript.iface("../x") == null && MonitorScript.iface("") == null && MonitorScript.iface("0wlan") == null)
        ok("monitor: tune", MonitorScript.tune(JSONObject("""{"channel":6,"width":"ht20"}""")) == "channel 6 HT20" && MonitorScript.tune(JSONObject("""{"freq":5180,"width":"80MHz"}""")) == "freq 5180 80MHz" &&
            MonitorScript.tune(JSONObject("""{"channel":0}""")) == null && MonitorScript.tune(JSONObject("""{"freq":100}""")) == null && MonitorScript.tune(JSONObject("""{"channel":6,"width":"HT20; reboot"}""")) == null && MonitorScript.tune(JSONObject("{}")) == null)
        val on = MonitorScript.on("wlan0", "channel 6 HT20")
        ok("monitor: on-script brings the interface down, switches type, up, tunes; restores it on failure", on.contains("ip link set wlan0 down") && on.contains("set type monitor") && on.contains("ip link set wlan0 up") && on.contains("set channel 6 HT20") && on.contains("|| { ip link set wlan0 up;") && on.contains("iw not found"))
        ok("monitor: off-script returns to managed", MonitorScript.off("wlan0").contains("set type managed") && MonitorScript.channel("wlan1", "freq 2437").endsWith("\$IW dev wlan1 set freq 2437"))
    }

    // --- периодическая реклама, Wi-Fi Direct, точка доступа, подсказки сетей ---
    ok("periodic: interval ms → 1.25 ms units, clamped", Args.periodicInterval(100.0) == 80 && Args.periodicInterval(1000.0) == 800 && Args.periodicInterval(1.0) == 80 && Args.periodicInterval(1e9) == 65519)
    ok("wifi: ssid 1…32 bytes", WifiNetArgs.ssid("Home") == "Home" && WifiNetArgs.ssid("") == null && WifiNetArgs.ssid("a".repeat(33)) == null && WifiNetArgs.ssid("я".repeat(17)) == null)
    ok("wifi: passphrase 8…63 printable ASCII", WifiNetArgs.pass("12345678") != null && WifiNetArgs.pass("1234567") == null && WifiNetArgs.pass("a".repeat(64)) == null && WifiNetArgs.pass("пароль1234") == null && WifiNetArgs.pass("pass\nword") == null)
    ok("p2p: group name DIRECT-xy-…", WifiNetArgs.p2pName("DIRECT-ab-DSP") == "DIRECT-ab-DSP" && WifiNetArgs.p2pName("DIRECT-ab-") == "DIRECT-ab-" && WifiNetArgs.p2pName("Home") == null && WifiNetArgs.p2pName("DIRECT-a-x") == null && WifiNetArgs.p2pName("DIRECT-ab-" + "x".repeat(23)) == null)
    ok("p2p: group owner intent 0…15", WifiNetArgs.p2pIntent(-3) == 0 && WifiNetArgs.p2pIntent(7) == 7 && WifiNetArgs.p2pIntent(99) == 15)
    ok("wifi: suggestion statuses are explained", WifiNetArgs.suggestStatus(0) == null && WifiNetArgs.suggestStatus(2)!!.contains("approve") && WifiNetArgs.suggestStatus(4)!!.contains("too many") && WifiNetArgs.suggestStatus(77)!!.contains("77"))
    ok("wifi: hotspot / p2p reasons", WifiNetArgs.hotspotReason(1).contains("channel") && WifiNetArgs.hotspotReason(4).contains("disallowed") && WifiNetArgs.p2pReason(1).contains("not supported") && WifiNetArgs.p2pReason(2).contains("busy"))

    // --- активность: лежит / движется / идёт ---
    run {
        val m = ActivityModel(walkSteps = 8, windowMs = 20_000, settleMs = 30_000)
        ok("activity: starts unknown", m.state == "unknown")
        ok("activity: stationary → still", m.still() && m.state == "still" && !m.still())
        ok("activity: motion → moving", m.motion() && m.state == "moving")
        var t = 1_000_000L; var c = 100f; var changed = false
        for (i in 0 until 12) { t += 1000; c += 1; if (m.steps(c, t)) changed = true }
        ok("activity: 12 steps in 12 s → walking", changed && m.state == "walking", m.state)
        ok("activity: cadence ≈ 60 steps/min", m.cadence() in 55..65, m.cadence().toString())
        ok("activity: motion does not demote walking", !m.motion() && m.state == "walking")
        ok("activity: still tick right after steps keeps walking", !m.tick(t + 10_000) && m.state == "walking")
        ok("activity: no steps for 30 s → moving", m.tick(t + 31_000) && m.state == "moving")
        ok("activity: then stationary → still", m.still() && m.state == "still")
        val q = ActivityModel(walkSteps = 8)
        var tt = 0L
        for (i in 0 until 5) q.steps(i.toFloat(), tt.also { tt += 4000 })
        ok("activity: slow steps over the window are not walking", q.state != "walking", q.state)
    }

    // --- запуск патча снаружи: хэш страницы ---
    ok("launch: name → #p=, spaces as %20", Launch.hash("My patch", null, false, false) == "#p=My%20patch")
    ok("launch: run flag", Launch.hash("a", null, true, false) == "#p=a&run=1")
    ok("launch: run without a patch does nothing", Launch.hash(null, null, true, false) == "")
    ok("launch: data refused unless allowed (falls back to the name)", Launch.hash("a", "AbC_-1", false, false) == "#p=a" && Launch.hash(null, "AbC_-1", false, false) == "")
    ok("launch: data accepted when allowed", Launch.hash("a", "AbC_-1", true, true) == "#d=AbC_-1&run=1")
    ok("launch: data with junk characters is dropped", Launch.hash(null, "x&run=1<script>", false, true) == "")
    ok("launch: unicode name is percent-encoded", Launch.hash("Радио", null, false, false) == "#p=%D0%A0%D0%B0%D0%B4%D0%B8%D0%BE")

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



    // --- команды: проверка аргументов ---
    ok("sms number", Cmd.number("+7 (900) 123-45-67") != null && Cmd.number("112") != null && Cmd.number("12") == null && Cmd.number("+7900;rm") == null && Cmd.number("abc") == null)
    val lim = Cmd.Limiter(3, 1000)
    ok("sms limiter: 3 per window, then free again", lim.allow(0) && lim.allow(10) && lim.allow(20) && !lim.allow(30) && lim.allow(1100))
    ok("ir pattern", Cmd.irPattern(org.json.JSONArray("[9000,4500,560,560]"))!!.size == 4 && Cmd.irPattern(org.json.JSONArray("[9000]")) == null &&
        Cmd.irPattern(org.json.JSONArray("[9000,0]")) == null && Cmd.irPattern(org.json.JSONArray("[9000,-5]")) == null && Cmd.irPattern(null) == null && Cmd.irPattern(org.json.JSONArray("[1,3000000]")) == null)
    ok("ir carrier must lie in the emitter ranges", Cmd.irFreqOk(38000, listOf(intArrayOf(30000, 60000))) && !Cmd.irFreqOk(20000, listOf(intArrayOf(30000, 60000))) && Cmd.irFreqOk(38000, emptyList()) && !Cmd.irFreqOk(0, emptyList()))
    ok("limit", Cmd.limit(0, 50, 500) == 50 && Cmd.limit(9999, 50, 500) == 500 && Cmd.limit(7, 50, 500) == 7)
    ok("perms: incoming SMS", Perms.forSubs(setOf("sms"), 34) == listOf("android.permission.RECEIVE_SMS"))




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
    ok("perms: location sources", Perms.forSubs(setOf("gps", "cell"), 34).size == 2 && Perms.forSubs(setOf("accel"), 34).isEmpty())
    ok("perms: bluetooth by version", Perms.forSubs(setOf("ble"), 34).any { it.endsWith("BLUETOOTH_SCAN") } && Perms.forSubs(setOf("ble"), 29).none { it.endsWith("BLUETOOTH_SCAN") })
    ok("perms: steps, mic", Perms.forSubs(setOf("steps", "mic"), 34).map { it.substringAfterLast('.') } == listOf("ACTIVITY_RECOGNITION", "RECORD_AUDIO"))
    ok("sniffer: interface and filter checked", Perms.iface("wlan0") == "wlan0" && Perms.iface("") == "any" && Perms.iface("a; reboot") == null && Perms.iface("a b") == null &&
        Perms.filter("tcp port 80 and not host 10.0.0.1") == "tcp port 80 and not host 10.0.0.1" && Perms.filter("tcp'; reboot; '") == null && Perms.filter("\$(id)") == null && Perms.filter("`id`") == null)
    ok("sniffer: script has no stray quotes", SnifferHub.script("any", 256, "tcp").contains("-i any -U -n -s 256 -w - 'tcp'"))
    ok("dbfs", Audio.dbfs(32768.0) == 0.0 && Math.abs(Audio.dbfs(3276.8) + 20.0) < 1e-9 && Audio.dbfs(0.0) == -120.0)
    // --- аргументы команд ---
    ok("args: hex", Args.hex("48 65:6c,0x6C")?.toList() == listOf<Byte>(0x48, 0x65, 0x6c, 0x6c) && Args.hex("4") == null && Args.hex("zz") == null && Args.hex("00".repeat(10), 5) == null)
    ok("args: host", Args.host("example.com") == "example.com" && Args.host("10.0.0.1") == "10.0.0.1" && Args.host("fe80::1") == "fe80::1" && Args.host("a b") == null && Args.host("a;reboot") == null && Args.host("-c1") == "-c1")
    ok("args: mac", Args.mac("aa:bb:cc:dd:ee:ff") == "AA:BB:CC:DD:EE:FF" && Args.mac("aa:bb:cc") == null && Args.mac("aa:bb:cc:dd:ee:f;") == null)
    ok("args: uuid 16 / 32 / 128 bit", Args.uuid("180d").toString() == "0000180d-0000-1000-8000-00805f9b34fb" && Args.uuid("0x180D") == Args.uuid("180d") &&
        Args.uuid("6e400001-b5a3-f393-e0a9-e50e24dcca9e") != null && Args.uuid("xyz") == null && Args.uuid("12345") == null)
    ok("args: short uuid", Args.uuidShort(Args.uuid("180d")!!) == "180d" && Args.uuidShort(Args.uuid("6e400001-b5a3-f393-e0a9-e50e24dcca9e")!!) == "6e400001-b5a3-f393-e0a9-e50e24dcca9e")
    ok("args: vibration pattern", Args.vibPattern(org.json.JSONArray("[0,200,100,200]"))?.size == 4 && Args.vibPattern(org.json.JSONArray("[0,0]")) == null &&
        Args.vibPattern(org.json.JSONArray("[0,70000]")) == null && Args.vibPattern(org.json.JSONArray("[]")) == null)
    ok("args: safe token", Args.safeToken("android.intent.action.VIEW") != null && Args.safeToken("a; reboot") == null && Args.safeToken("\$(id)") == null && Args.safeToken("") == null)
    ok("args: payload", Args.payload(JSONObject("{\"hex\":\"0102\"}"))?.size == 2 && Args.payload(JSONObject("{\"text\":\"héllo\"}"))?.size == 6 && Args.payload(JSONObject("{}")) == null)
    val pr = NetParse.reply("64 bytes from 8.8.8.8: icmp_seq=2 ttl=117 time=12.3 ms")
    ok("ping: reply", pr != null && pr.seq == 2 && pr.ttl == 117 && pr.ms == 12.3 && pr.from == "8.8.8.8" && pr.bytes == 64)
    val pn = NetParse.reply("64 bytes from router.lan (192.168.1.1): icmp_seq=1 ttl=64 time=1.5 ms")
    ok("ping: reply with a name in front of the address", pn != null && pn.from == "192.168.1.1" && pn.ms == 1.5)
    ok("trace: Time to live exceeded (iputils and toybox forms)", NetParse.exceeded("From 10.0.0.1 icmp_seq=1 Time to live exceeded") == ("10.0.0.1" to false) &&
        NetParse.exceeded("From 10.0.0.1: icmp_seq=1 Time to live exceeded") == ("10.0.0.1" to false) &&
        NetParse.exceeded("From gw.lan (192.168.0.1) icmp_seq=1 Time to live exceeded") == ("192.168.0.1" to false))
    ok("trace: unreachable ends the path", NetParse.exceeded("From 10.1.1.1 icmp_seq=1 Destination Host Unreachable") == ("10.1.1.1" to true) &&
        NetParse.exceeded("From 10.1.1.1 icmp_seq=1 Destination Net Unreachable")?.second == true)
    ok("trace: ordinary lines are not hops", NetParse.exceeded("PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.") == null && NetParse.exceeded("64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=12.3 ms") == null &&
        NetParse.exceeded("") == null)
    ok("ping: summary", NetParse.summary("4 packets transmitted, 3 received, 25% packet loss, time 3004ms") == (4 to 3) && NetParse.rtt("rtt min/avg/max/mdev = 10.1/12.5/15.0/1.2 ms")?.second == 12.5)
    ok("power commands are told from plain ones", BridgeServer.powerCmd("tcp.connect") && BridgeServer.powerCmd("gatt.write") && BridgeServer.powerCmd("ping") && BridgeServer.powerCmd("ui.tap") &&
        BridgeServer.powerCmd("sys.input") && BridgeServer.powerCmd("intent") && !BridgeServer.powerCmd("notify") && !BridgeServer.powerCmd("torch") && !BridgeServer.powerCmd("vibrate") && !BridgeServer.powerCmd("sms.send"))
    ok("perms: speech, sys, gatt", Perms.forSubs(setOf("speech"), 34) == listOf("android.permission.RECORD_AUDIO") && Perms.forSubs(setOf("sys"), 34) == listOf("android.permission.READ_PHONE_STATE") &&
        Perms.forSubs(setOf("gatt"), 34) == listOf("android.permission.BLUETOOTH_CONNECT") && Perms.forSubs(setOf("gatt"), 29).isEmpty())
    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
