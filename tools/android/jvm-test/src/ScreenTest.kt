package app.dsp.phone.screentest

import app.dsp.phone.BridgeServer
import app.dsp.phone.RecArgs
import app.dsp.phone.ScreenArgs
import java.time.ZoneId
import java.time.ZonedDateTime

var bad = 0
fun ok(name: String, cond: Boolean) { if (!cond) { bad++; println("FAIL $name") } else println("ok   $name") }

fun main() {
    ok("size: long side capped, even", ScreenArgs.size(1080, 2400, 1280) == (576 to 1280) && ScreenArgs.size(2400, 1080, 1280) == (1280 to 576))
    ok("size: never bigger than the screen", ScreenArgs.size(720, 1280, 1920) == (720 to 1280) && ScreenArgs.size(480, 800, 3840) == (480 to 800))
    ok("size: odd screen → even sizes", ScreenArgs.size(1081, 2401, 0).let { it.first % 2 == 0 && it.second % 2 == 0 && it.second <= 1280 })
    ok("size: default max side is 1280, tiny values are lifted", ScreenArgs.size(1080, 2400, 0).second == 1280 && ScreenArgs.size(1080, 2400, 10).second == 320)
    ok("fps", ScreenArgs.fps(0) == 30 && ScreenArgs.fps(-5) == 30 && ScreenArgs.fps(2) == 5 && ScreenArgs.fps(24) == 24 && ScreenArgs.fps(240) == 60)
    ok("bitrate: given kbps, clamped to 200…40000", ScreenArgs.bitrate(576, 1280, 30, 4000) == 4_000_000 && ScreenArgs.bitrate(576, 1280, 30, 50) == 200_000)
    ok("bitrate: automatic by pixels and rate", ScreenArgs.bitrate(576, 1280, 30, 0) == (576L * 1280 * 30 * 0.07).toInt() && ScreenArgs.bitrate(2, 2, 5, 0) == 500_000 && ScreenArgs.bitrate(3840, 2160, 60, 0) == 20_000_000)
    ok("bitrate: kbps upper bound", ScreenArgs.bitrate(1280, 720, 30, 999_999) == 40_000_000)
    val t = ZonedDateTime.parse("2026-10-31T09:05:03+03:00[Europe/Moscow]").toInstant().toEpochMilli()
    ok("fileName", ScreenArgs.fileName(t, ZoneId.of("Europe/Moscow")) == "screen-20261031-090503.mp4")
    ok("stream fps: default 8, 1…15", ScreenArgs.streamFps(0) == 8 && ScreenArgs.streamFps(-3) == 8 && ScreenArgs.streamFps(1) == 1 && ScreenArgs.streamFps(10) == 10 && ScreenArgs.streamFps(60) == 15)
    ok("stream quality: default 60, 20…95", ScreenArgs.quality(0) == 60 && ScreenArgs.quality(5) == 20 && ScreenArgs.quality(80) == 80 && ScreenArgs.quality(200) == 95)
    ok("screen frames are for the app page only", BridgeServer.SENSITIVE.contains("screen") && BridgeServer.POWER_SRC.contains("screen") && BridgeServer.powerCmd("screenrec.stream"))
    ok("the recording file is a valid recordings file", RecArgs.validFile(ScreenArgs.fileName(t, ZoneId.of("Europe/Moscow"))) != null && RecArgs.validFile("x.mp4") != null && RecArgs.validFile("../x.mp4") == null)
    ok("screen recording commands need the app page", BridgeServer.powerCmd("screenrec.start") && BridgeServer.powerCmd("screenrec.stop"))
    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
