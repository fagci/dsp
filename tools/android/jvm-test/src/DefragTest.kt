package app.dsp.phone.defragtest

import app.dsp.phone.AppRows
import app.dsp.phone.AppSel
import app.dsp.phone.DnsSniff
import app.dsp.phone.FlowInfo
import app.dsp.phone.Ip
import app.dsp.phone.IpDefrag
import app.dsp.phone.Owner
import app.dsp.phone.VpnEngine
import app.dsp.phone.VpnEvents
import app.dsp.phone.VpnSockets
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.Socket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** IpDefrag (сборка фрагментов IPv4), AppSel (выбор приложений для VPN) и фрагментированный UDP через настоящий VpnEngine. gradle runDefragTest */
private var bad = 0
private fun ok(name: String, c: Boolean, x: String = "") { if (!c) { bad++; println("FAIL $name $x") } else println("ok   $name") }
private fun addr(s: String) = InetAddress.getByName(s).address
private fun csumOk(b: ByteArray, len: Int): Boolean {
    var s = 0L; var i = 0
    while (i + 1 < len) { s += ((b[i].toInt() and 255) shl 8) or (b[i + 1].toInt() and 255); i += 2 }
    while (s shr 16 != 0L) s = (s and 0xFFFF) + (s shr 16)
    return s == 0xFFFFL
}

/** Режет целый IPv4-пакет на куски по [chunk] байт данных (кратно 8): тот же id, MF у всех кроме последнего, заголовок с верной суммой. */
private fun split(whole: ByteArray, chunk: Int): List<ByteArray> {
    val ihl = (whole[0].toInt() and 15) * 4; val data = whole.copyOfRange(ihl, whole.size); val out = ArrayList<ByteArray>()
    var off = 0
    while (off < data.size) {
        val n = minOf(chunk, data.size - off); val last = off + n >= data.size
        val p = ByteArray(ihl + n); System.arraycopy(whole, 0, p, 0, ihl); System.arraycopy(data, off, p, ihl, n)
        Ip.put16(p, 2, p.size); Ip.put16(p, 6, (off / 8) or (if (last) 0 else 0x2000)); Ip.put16(p, 10, 0); Ip.put16(p, 10, Ip.fold(Ip.sum(p, 0, ihl)))
        out.add(p); off += n
    }
    return out
}

fun main() {
    val src = addr("10.8.0.9"); val dst = addr("127.0.0.1")
    val payload = ByteArray(3000) { (it * 7).toByte() }
    val whole = Ip.udp(src, dst, 40000, 9, payload, 0, payload.size)
    val frags = split(whole, 1480)
    ok("split into 3 fragments", frags.size == 3 && frags.all { csumOk(it, 20) })

    // --- IpDefrag ---
    var d = IpDefrag()
    ok("whole packet passes through", d.add(whole, whole.size)?.contentEquals(whole) == true)
    ok("first fragment waits", d.add(frags[0], frags[0].size) == null && d.pending() == 1)
    ok("second fragment waits", d.add(frags[1], frags[1].size) == null)
    val r = d.add(frags[2], frags[2].size)
    ok("in order: whole datagram", r != null && r.size == whole.size && r.copyOfRange(20, r.size).contentEquals(whole.copyOfRange(20, whole.size)))
    ok("header: no MF/offset, length and checksum fresh", r != null && Ip.u16(r, 6) and 0x3FFF == 0 && Ip.u16(r, 2) == r.size && csumOk(r, 20))
    ok("nothing pending afterwards", d.pending() == 0 && d.done == 1)

    d = IpDefrag()
    ok("reverse order: waits", d.add(frags[2], frags[2].size) == null && d.add(frags[1], frags[1].size) == null)
    val r2 = d.add(frags[0], frags[0].size)
    ok("reverse order: whole datagram", r2 != null && r2.copyOfRange(20, r2.size).contentEquals(whole.copyOfRange(20, whole.size)))

    d = IpDefrag()
    d.add(frags[0], frags[0].size); d.add(frags[0], frags[0].size); d.add(frags[1], frags[1].size)
    ok("duplicate fragment does not complete early", d.pending() == 1 && d.done == 0)
    ok("... and the last one completes", d.add(frags[2], frags[2].size) != null)

    d = IpDefrag()
    d.add(frags[0], frags[0].size); d.add(frags[2], frags[2].size)
    ok("a hole keeps it waiting", d.pending() == 1 && d.done == 0)

    // другая датаграмма (другой id) не смешивается
    val other = Ip.udp(src, dst, 40001, 9, payload.copyOf(2000), 0, 2000); val of = split(other, 1480)
    Ip.put16(of[0], 4, 777); Ip.put16(of[1], 4, 777)
    d = IpDefrag()
    d.add(frags[0], frags[0].size); d.add(of[0], of[0].size); d.add(frags[1], frags[1].size)
    ok("two datagrams at once stay apart", d.pending() == 2 && d.add(frags[2], frags[2].size) != null && d.pending() == 1)

    d = IpDefrag(ttlMs = 1000)
    d.add(frags[0], frags[0].size, now = 0)
    d.add(of[0], of[0].size, now = 5000)
    ok("stale datagram is dropped", d.pending() == 1 && d.dropped == 1)

    d = IpDefrag(maxDatagrams = 2)
    for (i in 1..3) { val f = frags[0].copyOf(); Ip.put16(f, 4, 1000 + i); d.add(f, f.size) }
    ok("limit of pending datagrams", d.pending() == 2 && d.dropped == 1)

    val huge = split(whole, 1480)[1].copyOf(); Ip.put16(huge, 6, 8180)                    // смещение 65440 + 1480 > 65535
    ok("oversize datagram refused", IpDefrag().let { it.add(huge, huge.size) == null && it.dropped == 1 })

    // --- AppSel ---
    val pk = { u: Int -> if (u == 10234) listOf("com.a.one", "com.a.two") else emptyList() }
    fun parse(s: String) = AppSel.parse(JSONObject(s), pk)
    ok("no fields = all", parse("{}").first?.mode == "all")
    ok("apps without mode = only", parse("""{"apps":["com.a.one"]}""").first?.let { it.mode == "only" && it.pkgs == listOf("com.a.one") } == true)
    ok("apps as a string", parse("""{"apps":"com.a.one, com.b.two","mode":"except"}""").first?.let { it.mode == "except" && it.pkgs.size == 2 } == true)
    ok("uids turn into packages", parse("""{"uids":[10234]}""").first?.pkgs == listOf("com.a.one", "com.a.two"))
    ok("uids and apps merge without repeats", parse("""{"apps":["com.a.one"],"uids":[10234]}""").first?.pkgs == listOf("com.a.one", "com.a.two"))
    ok("bad package name refused", parse("""{"apps":["x; rm -rf"]}""").second?.contains("package name") == true)
    ok("bad uid refused", parse("""{"uids":["abc"]}""").second?.contains("number") == true)
    ok("only needs a list", parse("""{"mode":"only"}""").second?.contains("needs") == true)
    ok("unknown mode", parse("""{"mode":"nope","apps":["com.a.one"]}""").second?.contains("mode") == true)
    ok("same() ignores order", AppSel("only", listOf("a.b", "c.d")).same(AppSel("only", listOf("c.d", "a.b"))) && !AppSel("only", listOf("a.b")).same(AppSel("except", listOf("a.b"))))
    ok("toJson", JSONObject(AppSel("only", listOf("com.a.one")).toJson()).getJSONArray("apps").getString(0) == "com.a.one")

    // --- AppRows: общий uid — одна строка, системные скрыты ---
    val rows = AppRows.group(listOf(AppRows.App(10234, "com.a.two", "Two", false), AppRows.App(10234, "com.a.one", "One", false),
        AppRows.App(1000, "android", "Android", true), AppRows.App(10300, "com.b.x", "X", false)), false).map { JSONObject(it) }
    ok("shared uid is one row", rows.size == 2 && rows[0].getInt("uid") == 10234 && rows[0].getJSONArray("pkgs").length() == 2 && rows[0].getString("pkg") == "com.a.one")
    ok("system apps on request", AppRows.group(listOf(AppRows.App(1000, "android", "Android", true)), true).size == 1)

    // --- через настоящий VpnEngine: фрагментированный UDP до настоящего эхо-сервера ---
    val echo = DatagramSocket(0, InetAddress.getByName("127.0.0.1"))
    Thread({ val buf = ByteArray(65536); try { while (true) { val p = DatagramPacket(buf, buf.size); echo.receive(p); echo.send(DatagramPacket(p.data, p.length, p.address, p.port)) } } catch (e: Exception) { } }, "echo").apply { isDaemon = true; start() }
    val out = LinkedBlockingQueue<ByteArray>(); val seen = java.util.concurrent.CopyOnWriteArrayList<Pair<Boolean, Int>>()
    val engine = VpnEngine({ p -> out.add(p) }, object : VpnSockets {
        override fun tcp(dst: InetAddress, port: Int, timeoutMs: Int) = Socket(dst, port)
        override fun udp() = DatagramSocket()
    }, object : VpnEvents {
        override fun owner(proto: Int, src: java.net.InetSocketAddress, dst: java.net.InetSocketAddress) = Owner(10234, listOf("com.a.one"), "One")
        override fun packet(out: Boolean, p: ByteArray, len: Int, f: FlowInfo?) { seen.add(out to len) }
        override fun dns(f: FlowInfo?, q: DnsSniff.Msg, ms: Long) {}
    }, 1500)
    val big = ByteArray(2800) { (it % 251).toByte() }
    val bigPkt = Ip.udp(src, dst, 41000, echo.localPort, big, 0, big.size)
    val fr = split(bigPkt, 1480)
    for (f in fr.reversed()) engine.input(f, f.size)                                   // кусками и в обратном порядке
    val back = out.poll(5, TimeUnit.SECONDS)
    ok("fragmented UDP reaches the server and the echo returns", back != null && Ip.u8(back, 9) == 17 && back.size >= 2800)
    if (back != null) ok("echo payload intact", back.copyOfRange(28, 28 + 2800).contentEquals(big))
    ok("raw fragments are in the packet stream once each, the datagram is not repeated", seen.count { it.first && it.second == fr[0].size } == 1 && seen.count { it.first && it.second == bigPkt.size } == 0, seen.toString())
    ok("stats count the reassembly", engine.stats["reassembled"]?.get() == 1L, engine.stats.toString())
    ok("... and the flow was seen once", engine.snapshot().count { it.proto == 17 } == 1)
    engine.close(); echo.close()
    if (bad > 0) { println("FAILED $bad"); System.exit(1) }
    println("all ok")
}
