package app.dsp.phone.rtptest

import app.dsp.phone.RtpStrip

var bad = 0
fun ok(name: String, cond: Boolean) { if (!cond) { bad++; println("FAIL $name") } else println("ok   $name") }

private fun pkt(b0: Int, extra: ByteArray, payload: ByteArray, pad: Int = 0): ByteArray {
    val h = ByteArray(12); h[0] = b0.toByte(); h[1] = 33; h[2] = 0; h[3] = 1
    val tail = if (pad > 0) ByteArray(pad).also { it[pad - 1] = pad.toByte() } else ByteArray(0)
    return h + extra + payload + tail
}

fun main() {
    val ts = ByteArray(188 * 7) { if (it % 188 == 0) 0x47 else 1 }
    val a = pkt(0x80, ByteArray(0), ts)
    val s = RtpStrip.span(a, a.size)
    ok("plain: 12 byte header", s != null && s.off == 12 && s.len == ts.size)
    val c = pkt(0x82, ByteArray(8), ts)                                    // CC = 2 → +8 байт
    ok("CSRC list", RtpStrip.span(c, c.size)!!.let { it.off == 20 && it.len == ts.size })
    val ext = byteArrayOf(0xBE.toByte(), 0xDE.toByte(), 0, 2) + ByteArray(8)   // расширение: 2 слова
    val e = pkt(0x90, ext, ts)
    ok("extension", RtpStrip.span(e, e.size)!!.let { it.off == 12 + 4 + 8 && it.len == ts.size })
    val p = pkt(0xA0, ByteArray(0), ts, pad = 4)
    ok("padding", RtpStrip.span(p, p.size)!!.let { it.off == 12 && it.len == ts.size })
    ok("not RTP (version 1)", RtpStrip.span(pkt(0x40, ByteArray(0), ts), 12 + ts.size) == null)
    ok("too short", RtpStrip.span(ByteArray(11), 11) == null)
    ok("truncated extension", RtpStrip.span(pkt(0x90, ByteArray(0), ByteArray(0)), 12) == null)
    ok("empty payload", RtpStrip.span(pkt(0x80, ByteArray(0), ByteArray(0)), 12) == null)
    ok("padding larger than payload", RtpStrip.span(pkt(0xA0, ByteArray(0), ByteArray(2)).also { it[it.size - 1] = 9 }, 14) == null)
    ok("len beyond buffer", RtpStrip.span(ByteArray(20), 40) == null)
    ok("udp url from rtp @", RtpStrip.udpUrl("rtp://@239.1.1.1:5004") == "udp://239.1.1.1:5004")
    ok("udp url from udp @", RtpStrip.udpUrl("udp://@239.1.1.1:1234") == "udp://239.1.1.1:1234")
    ok("udp url unicast", RtpStrip.udpUrl("UDP://10.0.0.5:1234") == "udp://10.0.0.5:1234")
    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
