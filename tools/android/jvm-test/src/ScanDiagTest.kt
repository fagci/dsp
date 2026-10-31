package app.dsp.phone.scandiagtest

import app.dsp.phone.PosArgs
import app.dsp.phone.ScanDiag

var bad = 0
fun ok(name: String, cond: Boolean) { if (!cond) { bad++; println("FAIL $name") } else println("ok   $name") }

fun main() {
    ok("accWithAge: a fresh fix keeps its accuracy", PosArgs.accWithAge(5.0, 0, 3.0) == 5.0 && PosArgs.accWithAge(5.0, 5000, 3.0) == 5.0)
    ok("accWithAge: an old fix grows by age × max(speed, 1 m/s)", PosArgs.accWithAge(5.0, 60_000, 0.0) == 65.0 && PosArgs.accWithAge(5.0, 60_000, 2.0) == 125.0 && PosArgs.accWithAge(10.0, 120_000, 0.5) == 130.0)
    ok("a fix older than 120 s is not used (limit)", PosArgs.MAX_AGE_MS == 120_000L && PosArgs.FRESH_MS == 5_000L)
    ok("wifiStale: not yet / fresh scan", !ScanDiag.wifiStale(100_000, 0, 5) && !ScanDiag.wifiStale(100_000, 50_000, 5) && !ScanDiag.wifiStale(1_000_000, 950_000, 10))
    ok("wifiStale: at least 90 s, or 6 periods", ScanDiag.wifiStale(200_000, 100_000, 5) && !ScanDiag.wifiStale(180_000, 100_000, 5) && !ScanDiag.wifiStale(400_000, 100_000, 60) && ScanDiag.wifiStale(500_000, 100_000, 60))
    ok("gpsStale: 90 s", !ScanDiag.gpsStale(89_000) && ScanDiag.gpsStale(91_000) && ScanDiag.gpsStale(Long.MAX_VALUE))
    val calm = ScanDiag.State(screenOn = true, idle = false, optExempt = true, bgLocation = true, saver = false, throttle = false)
    ok("hints: nothing found on a calm phone — says so", ScanDiag.hints(calm, "wifi").single().startsWith("no obvious reason"))
    ok("hints: screen off, nothing else — vendor limits", ScanDiag.hints(ScanDiag.State(false, false, true, true, false, false), "wifi").single().contains("vendor"))
    val bad1 = ScanDiag.State(screenOn = false, idle = true, optExempt = false, bgLocation = false, saver = true, throttle = true)
    val h = ScanDiag.hints(bad1, "wifi")
    ok("hints: every cause is named", h.size == 5 && h.any { it.contains("Allow all the time") } && h.any { it.contains("battery optimization") } && h.any { it.contains("Doze") } && h.any { it.contains("battery saver") } && h.any { it.contains("scan throttling") })
    ok("hints: the throttling advice is only for Wi-Fi, the BLE one only for BLE with the screen off", ScanDiag.hints(bad1, "gps").none { it.contains("throttling") || it.contains("BLE") } && ScanDiag.hints(bad1, "ble").any { it.contains("filter") } && ScanDiag.hints(calm, "ble").none { it.contains("filter") })
    ok("hints: bgLocation null (before Android 10) is not blamed", ScanDiag.hints(ScanDiag.State(true, false, false, null, false, null), "wifi").none { it.contains("Allow all the time") })
    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
