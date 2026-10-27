package app.dsp.phone.recordstest

import app.dsp.phone.Ad
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

    // --- JSON-помощники дают валидный JSON ---
    val j = JSONObject(Json.obj("src" to "\"ble\"", "mfr" to Json.map(mapOf("004c" to "02")), "uuids" to Json.arr(listOf("180f", "a\"b")), "n" to null, "x" to Json.num(1.23456789, 1e4)))
    ok("json helpers", j.getJSONObject("mfr").getString("004c") == "02" && j.getJSONArray("uuids").getString(1) == "a\"b" && !j.has("n") && j.getDouble("x") == 1.2346)
    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
