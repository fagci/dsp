package app.dsp.phone.netseltest

import android.net.NetworkCapabilities
import app.dsp.phone.NetInfo
import app.dsp.phone.NetSel

/** NetSel.kt: разбор «net:», вид сети по транспортам, выбор из списка (validated раньше, номер точно), запись net.list. */
private var fails = 0
private fun ok(name: String, c: Boolean) { if (!c) { fails++; println("FAIL $name") } else println("ok   $name") }
private fun n(id: Int, kind: String, v: Boolean = true, a: Boolean = false, ips: List<String> = listOf("10.0.0.$id")) =
    NetInfo(id, kind, "if$id", ips, listOf("1.1.1.1"), "10.0.0.1", v, false, a, 0, 0)

fun main() {
    ok("empty = default", NetSel.parse("")?.let { it.kind == null && it.id == null } == true)
    ok("default word", NetSel.parse(" Default ")?.kind == null)
    ok("aliases", NetSel.parse("Mobile")?.kind == "cell" && NetSel.parse("wlan")?.kind == "wifi" && NetSel.parse("ethernet")?.kind == "eth" && NetSel.parse("lte")?.kind == "cell")
    ok("number", NetSel.parse("101")?.id == 101)
    ok("garbage refused", NetSel.parse("wifi;rm") == null && NetSel.parse("-3") == null && NetSel.parse("5g") == null)

    ok("kind: wifi", NetSel.kindOf(setOf(NetworkCapabilities.TRANSPORT_WIFI)) == "wifi")
    ok("kind: vpn over wifi", NetSel.kindOf(setOf(NetworkCapabilities.TRANSPORT_WIFI, NetworkCapabilities.TRANSPORT_VPN)) == "vpn")
    ok("kind: cell", NetSel.kindOf(setOf(NetworkCapabilities.TRANSPORT_CELLULAR)) == "cell")
    ok("kind: usb tether", NetSel.kindOf(setOf(NetworkCapabilities.TRANSPORT_USB)) == "usb")
    ok("kind: none = other", NetSel.kindOf(emptySet()) == "other")

    val all = listOf(n(100, "wifi", v = false), n(101, "cell", a = true), n(102, "wifi", v = true), n(103, "vpn"))
    ok("wifi: validated first", NetSel.choose(all, NetSel.parse("wifi")!!)?.id == 102)
    ok("by number", NetSel.choose(all, NetSel.parse("100")!!)?.id == 100)
    ok("missing kind", NetSel.choose(all, NetSel.parse("eth")!!) == null)
    ok("default chooses nothing", NetSel.choose(all, NetSel.parse("")!!) == null)
    ok("label", NetSel.label(null) == "default" && NetSel.label(all[1]) == "cell#101")
    ok("ip4 skips v6", NetSel.ip4(n(7, "wifi", ips = listOf("fe80::1", "192.168.1.5"))) == "192.168.1.5" && NetSel.ip4(n(8, "cell", ips = listOf("2001:db8::1"))) == null)

    val js = org.json.JSONObject(n(101, "cell", a = true).toJson())
    ok("json fields", js.getInt("id") == 101 && js.getString("kind") == "cell" && js.getBoolean("default") && js.getJSONArray("dns").getString(0) == "1.1.1.1" && js.getString("gateway") == "10.0.0.1")
    if (fails > 0) { println("FAILED $fails"); System.exit(1) }
    println("all ok")
}
