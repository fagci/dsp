package app.dsp.phone.dialtest

import app.dsp.phone.BridgeServer
import app.dsp.phone.DialArgs

var bad = 0
fun ok(name: String, cond: Boolean) { if (!cond) { bad++; println("FAIL $name") } else println("ok   $name") }

fun main() {
    ok("ussd: ordinary codes pass", DialArgs.ussd("*100#") == "*100#" && DialArgs.ussd(" *100*1# ") == "*100*1#" && DialArgs.ussd("#100#") == "#100#" && DialArgs.ussd("*#06#") == "*#06#")
    ok("ussd: must end with # and be only digits * # +", DialArgs.ussd("123") == null && DialArgs.ussd("*100") == null && DialArgs.ussd("*100#; rm") == null && DialArgs.ussd("abc#") == null && DialArgs.ussd("") == null && DialArgs.ussd(null) == null)
    ok("ussd: service and wipe codes are refused", DialArgs.ussd("*2767*3855#") == null && DialArgs.ussd("*#*#4636#*#*") == null && DialArgs.ussd("*#7780#") == null && DialArgs.ussd("*#9900#") == null && DialArgs.ussd("#*#*1234#*#") == null)
    ok("ussd: length", DialArgs.ussd("*" + "1".repeat(70) + "#") == null)
    ok("number: ordinary", DialArgs.number("+79001234567") == "+79001234567" && DialArgs.number("112") == "112" && DialArgs.number("*31#+7900123") == "*31#+7900123" && DialArgs.number("123,,4") == "123,,4")
    ok("number: junk and service codes refused", DialArgs.number("tel:123") == null && DialArgs.number("") == null && DialArgs.number(null) == null && DialArgs.number("***") == null && DialArgs.number("*#*#4636#*#*") == null && DialArgs.number("*2767*3855#") == null && DialArgs.number("1".repeat(40)) == null)
    val subs = listOf(0 to 3, 1 to 5)
    ok("subIdOf: slot → subscription id", DialArgs.subIdOf(0, subs) == 3 && DialArgs.subIdOf(1, subs) == 5 && DialArgs.subIdOf(2, subs) == null && DialArgs.subIdOf(0, emptyList()) == null)
    ok("failureName", DialArgs.failureName(-1) == "failure" && DialArgs.failureName(-2) == "service unavailable" && DialArgs.failureName(7) == "error 7")
    ok("ussd / call commands need the app page", BridgeServer.powerCmd("ussd.send") && BridgeServer.powerCmd("call.dial") && BridgeServer.powerCmd("call.end"))
    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
