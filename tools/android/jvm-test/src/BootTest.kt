package app.dsp.phone.boottest

import app.dsp.phone.BootPatches
import app.dsp.phone.BridgeServer

var bad = 0
fun ok(name: String, cond: Boolean) { if (!cond) { bad++; println("FAIL $name") } else println("ok   $name") }

fun main() {
    ok("parse: separators, trim, duplicates", BootPatches.parse(" A ; B\nC;;A ") == listOf("A", "B", "C"))
    ok("parse: empty and null", BootPatches.parse("") == emptyList<String>() && BootPatches.parse(null) == emptyList<String>())
    ok("parse: at most MAX", BootPatches.parse((1..20).joinToString(";") { "p$it" }).size == BootPatches.MAX)
    ok("parse: a very long name is dropped", BootPatches.parse("x".repeat(201) + ";ok") == listOf("ok"))
    val u = BootPatches.url("Phone App: Locate 1")
    ok("url: opens the patch, runs it, headless flag", u.contains("#p=Phone%20App%3A%20Locate%201&run=1&hl=1"))
    ok("boot commands need the app page", BridgeServer.powerCmd("boot.run") && BridgeServer.sensitiveCmd("boot.set"))
    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
