package app.dsp.phone.alarmtest

import app.dsp.phone.AlarmCalc
import app.dsp.phone.BridgeServer
import java.time.ZoneId
import java.time.ZonedDateTime

var bad = 0
fun ok(name: String, cond: Boolean) { if (!cond) { bad++; println("FAIL $name") } else println("ok   $name") }

fun main() {
    val z = ZoneId.of("Europe/Moscow")
    fun at(s: String) = ZonedDateTime.parse("$s[Europe/Moscow]")
    ok("time: formats", AlarmCalc.time("7:30") == (7 to 30) && AlarmCalc.time("07:05") == (7 to 5) && AlarmCalc.time("0730") == (7 to 30) && AlarmCalc.time("24:00") == null && AlarmCalc.time("7:60") == null && AlarmCalc.time("x") == null)
    ok("days: words", AlarmCalc.days("") == 0 && AlarmCalc.days("daily") == 127 && AlarmCalc.days("weekdays") == 31 && AlarmCalc.days("weekend") == 96 && AlarmCalc.days("mon, wed fri") == (1 or 4 or 16) && AlarmCalc.days("blah") == null)
    ok("days: text", AlarmCalc.daysText(0) == "once" && AlarmCalc.daysText(31) == "weekdays" && AlarmCalc.daysText(1 or 4) == "mon,wed")
    // 2026-10-30 — пятница
    val fri = at("2026-10-30T10:00:00+03:00")
    ok("once: today if still ahead", AlarmCalc.next(fri, 11, 0, 0) == at("2026-10-30T11:00:00+03:00"))
    ok("once: tomorrow if passed", AlarmCalc.next(fri, 9, 0, 0) == at("2026-10-31T09:00:00+03:00"))
    ok("once: exactly now is not ahead", AlarmCalc.next(fri, 10, 0, 0) == at("2026-10-31T10:00:00+03:00"))
    ok("weekdays from Friday evening → Monday", AlarmCalc.next(at("2026-10-30T20:00:00+03:00"), 7, 0, 31) == at("2026-11-02T07:00:00+03:00"))
    ok("weekend from Friday → Saturday", AlarmCalc.next(fri, 9, 0, 96) == at("2026-10-31T09:00:00+03:00"))
    ok("single day a week ahead", AlarmCalc.next(fri, 9, 0, 1 shl 4) == at("2026-11-06T09:00:00+03:00"))
    ok("nextMs agrees", AlarmCalc.nextMs(fri.toInstant().toEpochMilli(), z, 11, 0, 0) == at("2026-10-30T11:00:00+03:00").toInstant().toEpochMilli())
    val dst = ZonedDateTime.parse("2026-03-28T23:00:00+01:00[Europe/Berlin]")        // сутки спустя часы переведены на летнее время: 07:00 остаётся 07:00 по стенным часам
    ok("clock change keeps the wall time", AlarmCalc.next(dst, 7, 0, 0).hour == 7)
    val w = AlarmCalc.beepWav()
    ok("beep wav: header and size", String(w, 0, 4) == "RIFF" && String(w, 8, 4) == "WAVE" && w.size == 44 + 22050 * 2 * 2 && w.any { it.toInt() != 0 })
    ok("playlist: pls", AlarmCalc.streamFromPlaylist("http://x/r.pls", "[playlist]\nNumberOfEntries=1\nFile1=http://s.example/live\nTitle1=A") == "http://s.example/live")
    ok("playlist: m3u", AlarmCalc.streamFromPlaylist("http://x/r.m3u", "#EXTM3U\n#EXTINF:-1,A\nhttps://s.example/a.mp3\n") == "https://s.example/a.mp3")
    ok("playlist: HLS and plain streams stay", AlarmCalc.streamFromPlaylist("http://x/r.m3u8", "#EXTM3U\n#EXT-X-VERSION:3\nhttp://a/seg.ts") == "http://x/r.m3u8" && AlarmCalc.streamFromPlaylist("http://x/live", "junk") == "http://x/live")
    ok("alarm commands need the app page", BridgeServer.powerCmd("alarm.set") && BridgeServer.powerCmd("alarm.test"))
    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
