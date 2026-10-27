package app.dsp.phone
fun main() {
    var bad = 0
    for ((w, h) in listOf(6 to 4, 4 to 8, 2 to 2, 8 to 6)) {
        val src = ByteArray(w * h * 3 / 2) { (it * 7 + 3).toByte() }
        fun yAt(a: ByteArray, ww: Int, x: Int, y: Int) = a[y * ww + x]
        fun uvAt(a: ByteArray, ww: Int, hh: Int, x: Int, y: Int): Pair<Byte, Byte> { val o = ww * hh + (y / 2) * ww + (x / 2) * 2; return a[o] to a[o + 1] }
        for (rot in listOf(90, 180, 270)) {
            val d = Yuv.rotate(src, w, h, rot)
            val nw = if (rot == 180) w else h; val nh = if (rot == 180) h else w
            for (y in 0 until h) for (x in 0 until w) {
                val (nx, ny) = when (rot) { 90 -> (h - 1 - y) to x; 180 -> (w - 1 - x) to (h - 1 - y); else -> y to (w - 1 - x) }
                if (yAt(src, w, x, y) != yAt(d, nw, nx, ny)) { bad++; println("Y mismatch $w x $h rot $rot at $x,$y") }
                if (uvAt(src, w, h, x, y) != uvAt(d, nw, nh, nx, ny)) { bad++; println("UV mismatch $w x $h rot $rot at $x,$y") }
            }
        }
        if (!Yuv.rotate(src, w, h, 0).contentEquals(src)) { bad++; println("rot 0") }
    }
    println(if (bad == 0) "rotate ok" else "$bad FAILED")
}
