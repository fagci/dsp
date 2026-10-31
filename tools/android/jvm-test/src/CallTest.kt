package app.dsp.phone.calltest

import app.dsp.phone.BridgeServer
import app.dsp.phone.CallArgs
import app.dsp.phone.RecArgs
import app.dsp.phone.WavOut
import java.io.File
import java.time.ZoneId
import java.time.ZonedDateTime

var bad = 0
fun ok(name: String, cond: Boolean) { if (!cond) { bad++; println("FAIL $name") } else println("ok   $name") }

fun le32(b: ByteArray, o: Int) = (b[o].toLong() and 0xff) or ((b[o + 1].toLong() and 0xff) shl 8) or ((b[o + 2].toLong() and 0xff) shl 16) or ((b[o + 3].toLong() and 0xff) shl 24)

fun main() {
    ok("source: auto → voice_call with root, mic without", CallArgs.source("auto", true) == "voice_call" && CallArgs.source("auto", false) == "mic" && CallArgs.source("", false) == "mic" && CallArgs.source(null, true) == "voice_call")
    ok("source: explicit kept, junk → auto", CallArgs.source("downlink", false) == "downlink" && CallArgs.source(" UPLINK ", true) == "uplink" && CallArgs.source("bogus", true) == "voice_call")
    ok("rate: 8 / 16 / 48 kHz kept, others → 16000", CallArgs.rate(8000) == 8000 && CallArgs.rate(48000) == 48000 && CallArgs.rate(0) == 16000 && CallArgs.rate(96000) == 16000)
    val t = ZonedDateTime.parse("2026-10-31T09:05:03+03:00[Europe/Moscow]").toInstant().toEpochMilli()
    ok("fileName", CallArgs.fileName(t, ZoneId.of("Europe/Moscow"), "voice_call") == "call-20261031-090503-voicecall.wav")
    ok("fileName is a valid recording file", RecArgs.validFile(CallArgs.fileName(t, ZoneId.of("Europe/Moscow"), "mic")) != null && RecArgs.validFile("x.wav") != null && RecArgs.validFile("x.exe") == null)
    ok("keep: short recordings go", !CallArgs.keep(16000L * 2 * 2, 16000, 3) && CallArgs.keep(16000L * 2 * 3, 16000, 3) && CallArgs.keep(0, 16000, 0))
    val h = CallArgs.wavHeader(16000, 1000)
    ok("wav header: RIFF / WAVE / fmt / data, sizes", h.size == 44 && String(h, 0, 4) == "RIFF" && String(h, 8, 4) == "WAVE" && String(h, 12, 4) == "fmt " && String(h, 36, 4) == "data" &&
        le32(h, 4) == 1036L && le32(h, 24) == 16000L && le32(h, 28) == 32000L && le32(h, 40) == 1000L)
    val f = File.createTempFile("calltest", ".wav")
    try {
        val w = WavOut(f, 8000)
        w.write(ByteArray(16000) { 1 }); w.write(ByteArray(16000) { 2 }); w.close()
        val b = f.readBytes()
        ok("WavOut: file = header + data, sizes patched on close", b.size == 44 + 32000 && le32(b, 40) == 32000L && le32(b, 4) == 32036L && le32(b, 24) == 8000L && b[44].toInt() == 1 && b[44 + 16000].toInt() == 2 && w.bytes == 32000L)
    } finally { f.delete() }
    ok("call recording commands need the app page", BridgeServer.powerCmd("callrec.set") && BridgeServer.powerCmd("callrec.status"))
    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
