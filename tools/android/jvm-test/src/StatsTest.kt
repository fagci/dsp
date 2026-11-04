package app.dsp.phone.statstest

import app.dsp.phone.Batts

/** Парсер batterystats (Batts, StatsHub.kt): uid → мА·ч, uid из строки — на обычной JVM, без Android. */

private var fails = 0
private fun ok(name: String, cond: Boolean) { if (!cond) { fails++; println("FAIL $name") } else println("ok $name") }

fun main() {
    ok("u0a203 → 10203", Batts.uidNumber("u0a203") == 10203)
    ok("u10a55 → 10055", Batts.uidNumber("u10a55") == 10055)
    ok("system → 1000", Batts.uidNumber("system") == 1000)
    ok("root → 0", Batts.uidNumber("root") == 0)
    ok("u0 → 0", Batts.uidNumber("u0") == 0)
    ok("isolated u0i123 — null", Batts.uidNumber("u0i123") == null)
    ok("junk — null", Batts.uidNumber("blah") == null)

    val dump = """
        Estimated power use (mAh):
            Capacity: 4500, Computed drain: 2150.5, actual drain: 2150.5
            Screen: 460.1 ( cpu=0.0 screen=460.1 )
            Uid u0a203: 300.25 ( cpu=200.0 wakeup=100.0 )
            Uid u0a10: 12.5 ( cpu=12.5 )
            Uid u0a77: 88 ( cpu=88 )
            Uid u0a300: 0.001 ( cpu=0.001 )
        Statistics since last charge:
          Uid u0a203:
            cpu=200.0 ( fg=180.0 )
    """.trimIndent()
    val list = Batts.uidMah(dump)
    ok("uid+mAh parsed, sorted desc", list == listOf("u0a203" to 300.25, "u0a77" to 88.0, "u0a10" to 12.5, "u0a300" to 0.001))
    ok("section header and detail lines skipped", list.none { it.first == "u0" } && list.size == 4)

    ok("empty → empty", Batts.uidMah("nothing here").isEmpty())
    ok("no numbers → empty", Batts.uidMah("  Uid u0a1:\n  Uid u0a2: ( cpu=1 )").isEmpty())

    if (fails > 0) { println("$fails FAILED"); kotlin.system.exitProcess(1) }
    println("StatsTest OK")
}
