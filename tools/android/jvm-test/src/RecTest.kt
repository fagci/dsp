package app.dsp.phone.rectest

import app.dsp.phone.BridgeServer
import app.dsp.phone.RecArgs
import java.time.ZoneId
import java.time.ZonedDateTime

var bad = 0
fun ok(name: String, cond: Boolean) { if (!cond) { bad++; println("FAIL $name") } else println("ok   $name") }

fun main() {
    ok("subs: text, case, duplicates", RecArgs.subs("GPS, wifi;ble gps") == listOf("gps", "wifi", "ble"))
    ok("subs: sms / mic / pkt are never recorded", RecArgs.subs("sms,mic,pkt,gps") == listOf("gps"))
    ok("subs: junk names dropped", RecArgs.subs("a b!,x".replace(" ", ",")) == listOf("a", "x") && RecArgs.subs("../etc") == emptyList<String>())
    ok("subs: at most 30", RecArgs.subs((1..50).map { "s$it" }).size == 30)
    ok("stamp: adds the receive time", RecArgs.stamp("{\"src\":\"gps\",\"lat\":1}", 42) == "{\"_t\":42,\"src\":\"gps\",\"lat\":1}" && RecArgs.stamp("{}", 7) == "{\"_t\":7}")
    ok("stamp: not an object — as is", RecArgs.stamp("[1,2]", 1) == "[1,2]")
    ok("safeName", RecArgs.safeName("my rec/../x") == "my_rec_.._x".replace(".", "_") && RecArgs.safeName("") == "rec" && RecArgs.safeName(null) == "rec")
    val z = ZoneId.of("Europe/Moscow")
    val t = ZonedDateTime.parse("2026-10-31T09:05:03+03:00[Europe/Moscow]").toInstant().toEpochMilli()
    ok("fileName: name, time, part", RecArgs.fileName("walk", t, 0, z) == "walk-20261031-090503.jsonl" && RecArgs.fileName("walk", t, 2, z) == "walk-20261031-090503-2.jsonl")
    ok("validFile: ours only", RecArgs.validFile("walk-20261031-090503.jsonl") != null && RecArgs.validFile("../x.jsonl") == null && RecArgs.validFile("a/b.jsonl") == null && RecArgs.validFile("x.txt") == null && RecArgs.validFile(null) == null && RecArgs.validFile("a..b.jsonl") == null)
    val fs = listOf("a.jsonl" to 100L, "b.jsonl" to 100L, "c.jsonl" to 100L)
    ok("overflow: oldest go first", RecArgs.overflow(fs, 150, "c.jsonl") == listOf("a.jsonl", "b.jsonl") && RecArgs.overflow(fs, 300, null).isEmpty() && RecArgs.overflow(fs, 250, null) == listOf("a.jsonl"))
    ok("overflow: the live file is kept", RecArgs.overflow(fs, 50, "a.jsonl") == listOf("b.jsonl", "c.jsonl"))
    ok("recording commands need the app page", BridgeServer.powerCmd("rec.start") && BridgeServer.powerCmd("rec.read"))
    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
