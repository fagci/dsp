package app.dsp.phone.shortcuttest

import app.dsp.phone.Launch
import app.dsp.phone.ShortcutArgs

var bad = 0
fun ok(name: String, cond: Boolean) { if (!cond) { bad++; println("FAIL $name") } else println("ok   $name") }

fun main() {
    ok("parse: names in order, trimmed, no duplicates or empties", ShortcutArgs.parse("[\" A \",\"B\",\"A\",\"\",\"C\"]") == listOf("A", "B", "C"))
    ok("parse: at most max", ShortcutArgs.parse("[\"1\",\"2\",\"3\",\"4\"]", 2) == listOf("1", "2") && ShortcutArgs.parse((1..20).joinToString(",", "[", "]") { "\"p$it\"" }).size == ShortcutArgs.MAX)
    ok("parse: junk is an empty list", ShortcutArgs.parse("not json") == emptyList<String>() && ShortcutArgs.parse(null) == emptyList<String>() && ShortcutArgs.parse("[]") == emptyList<String>() && ShortcutArgs.parse("{}") == emptyList<String>())
    ok("parse: a name over 200 characters is dropped", ShortcutArgs.parse("[\"" + "x".repeat(201) + "\",\"ok\"]") == listOf("ok"))
    ok("shortLabel: the prefix before «: » goes, 25 characters at most", ShortcutArgs.shortLabel("Phone App: Alarm Clock Node — List of Alarms") == "Alarm Clock Node — List o" && ShortcutArgs.shortLabel("Vibration (Accelerometer)") == "Vibration (Accelerometer)" && ShortcutArgs.shortLabel("x".repeat(60)).length == 25)
    ok("longLabel: 80 characters at most", ShortcutArgs.longLabel("y".repeat(200)).length == 80 && ShortcutArgs.longLabel("short") == "short")
    ok("id: stable and different for different names", ShortcutArgs.id("A") == ShortcutArgs.id("A") && ShortcutArgs.id("A") != ShortcutArgs.id("B") && ShortcutArgs.id("A").startsWith("p"))
    ok("uri: the name is percent-encoded, run=1", ShortcutArgs.uri("Phone App: Calendar — Events") == "dsp://run?patch=Phone%20App%3A%20Calendar%20%E2%80%94%20Events&run=1")
    ok("uri round trip: the hash the page opens", Launch.hash("Phone App: Calendar — Events", null, true, false) == "#p=Phone%20App%3A%20Calendar%20%E2%80%94%20Events&run=1")
    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
