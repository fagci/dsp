package app.dsp.phone.caltest

import app.dsp.phone.BridgeServer
import app.dsp.phone.CalArgs
import java.time.ZoneId
import java.time.ZonedDateTime

var bad = 0
fun ok(name: String, cond: Boolean) { if (!cond) { bad++; println("FAIL $name") } else println("ok   $name") }

fun main() {
    val z = ZoneId.of("Europe/Moscow")
    fun ms(s: String) = ZonedDateTime.parse("$s[Europe/Moscow]").toInstant().toEpochMilli()
    val D = CalArgs.DAY
    ok("window: defaults to the next 7 days", CalArgs.window(0, 0, 1000) == (1000L to 1000L + 7 * D))
    ok("window: explicit range kept", CalArgs.window(5, 9, 1000) == (5L to 9L))
    ok("window: end before start → 7 days from start", CalArgs.window(500, 100, 1000) == (500L to 500L + 7 * D))
    ok("window: capped at 366 days", CalArgs.window(0, 10_000L * D, 1000).let { it.second - it.first == 366 * D })
    ok("reminders: from text", CalArgs.reminders("10, 60;1440 x -5 99999 10") == listOf(10, 60, 1440))
    ok("reminders: at most 5", CalArgs.reminders((1..9).toList()).size == 5)
    val utc = { s: String -> ZonedDateTime.parse("$s[UTC]").toInstant().toEpochMilli() }
    ok("all day: same day → one day", CalArgs.allDay(ms("2026-11-02T10:00:00+03:00"), ms("2026-11-02T18:00:00+03:00"), z) == (utc("2026-11-02T00:00:00Z") to utc("2026-11-03T00:00:00Z")))
    ok("all day: no end → one day", CalArgs.allDay(ms("2026-11-02T00:30:00+03:00"), 0, z) == (utc("2026-11-02T00:00:00Z") to utc("2026-11-03T00:00:00Z")))
    ok("all day: the end midnight is not included", CalArgs.allDay(ms("2026-11-02T00:00:00+03:00"), ms("2026-11-04T00:00:00+03:00"), z) == (utc("2026-11-02T00:00:00Z") to utc("2026-11-04T00:00:00Z")))
    ok("calendar commands need the app page", BridgeServer.powerCmd("cal.add") && BridgeServer.sensitiveCmd("cal.list"))
    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
