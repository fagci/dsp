package app.dsp.phone.mictest

import app.dsp.phone.MicArgs

var bad = 0
fun ok(name: String, cond: Boolean) { if (!cond) { bad++; println("FAIL $name") } else println("ok   $name") }

fun main() {
    ok("source: names → AudioSource", MicArgs.source("unprocessed") == 9 && MicArgs.source("MIC") == 1 && MicArgs.source(" camcorder ") == 5 && MicArgs.source("voice_recognition") == 6 && MicArgs.source("voice_comm") == 7)
    ok("source: auto and junk → null", MicArgs.source("auto") == null && MicArgs.source("") == null && MicArgs.source(null) == null && MicArgs.source("bogus") == null)
    ok("source: call sources", MicArgs.source("voice_call") == 4 && MicArgs.source("downlink") == 3 && MicArgs.source("uplink") == 2 && MicArgs.source("submix") == 8)
    ok("rootOnly: call and submix only", MicArgs.rootOnly("voice_call") && MicArgs.rootOnly("DOWNLINK") && MicArgs.rootOnly("uplink") && MicArgs.rootOnly("submix") &&
        !MicArgs.rootOnly("unprocessed") && !MicArgs.rootOnly("mic") && !MicArgs.rootOnly("auto") && !MicArgs.rootOnly(null))
    ok("sourceName round trip", listOf("unprocessed", "mic", "camcorder", "voice_recognition", "voice_comm", "performance", "voice_call", "downlink", "uplink", "submix").all { MicArgs.sourceName(MicArgs.source(it)!!) == it })
    ok("rate: clamp", MicArgs.rate(0) == 16000 && MicArgs.rate(-5) == 16000 && MicArgs.rate(100) == 8000 && MicArgs.rate(48000) == 48000 && MicArgs.rate(500000) == 192000)
    ok("fallbackRates: wanted first, then the nearest standard ones", MicArgs.fallbackRates(96000).take(3) == listOf(96000, 48000, 44100))
    ok("fallbackRates: no duplicates, all standard ones present", MicArgs.fallbackRates(44100).let { it.distinct() == it && it.containsAll(listOf(192000, 96000, 48000, 44100, 8000)) && it[0] == 44100 && it[1] == 48000 })
    ok("fallbackRates: odd rate is tried first", MicArgs.fallbackRates(50000).let { it[0] == 50000 && it[1] == 48000 })
    ok("deviceTypes", MicArgs.deviceTypes("usb") == listOf(11, 22) && MicArgs.deviceTypes("WIRED") == listOf(3, 4) && MicArgs.deviceTypes("bluetooth").contains(7) && MicArgs.deviceTypes("builtin") == listOf(15) && MicArgs.deviceTypes("auto").isEmpty() && MicArgs.deviceTypes(null).isEmpty())
    ok("chunk is 20 ms", MicArgs.chunk(48000) == 960 && MicArgs.chunk(16000) == 320)
    ok("chunk: 10 ms in low latency", MicArgs.chunk(48000, true) == 480 && MicArgs.chunk(16000, true) == 160 && MicArgs.chunk(48000, false) == 960)
    ok("bufferBytes: 8 pieces normally, 2 in low latency, never below the minimum", MicArgs.bufferBytes(1000, 960, false) == 960 * 2 * 8 && MicArgs.bufferBytes(1000, 480, true) == 1920 && MicArgs.bufferBytes(5000, 480, true) == 5000)
    ok("channels: stereo / 2 → 2, everything else mono", MicArgs.channels("stereo") == 2 && MicArgs.channels(" STEREO ") == 2 && MicArgs.channels("2") == 2 && MicArgs.channels("mono") == 1 && MicArgs.channels("") == 1 && MicArgs.channels(null) == 1)
    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
