package app.dsp.phone.directtest

import app.dsp.phone.DirectRing
import java.nio.ByteBuffer
import java.nio.ByteOrder

var bad = 0
fun ok(name: String, cond: Boolean) { if (!cond) { bad++; println("FAIL $name") } else println("ok   $name") }

/** Пишет запись так, как это делает датчик: счётчик — последним. */
fun put(b: ByteBuffer, slot: Int, counter: Int, token: Int, tNs: Long, x: Float, y: Float, z: Float) {
    val o = slot * DirectRing.SIZE
    b.putInt(o, DirectRing.SIZE); b.putInt(o + 4, token); b.putInt(o + 8, 1)
    b.putLong(o + 16, tNs); b.putFloat(o + 24, x); b.putFloat(o + 28, y); b.putFloat(o + 32, z)
    b.putInt(o + 12, counter)
}

fun main() {
    ok("level: hz → 1 / 2 / 3", DirectRing.level(10, 3) == 1 && DirectRing.level(50, 3) == 1 && DirectRing.level(51, 3) == 2 && DirectRing.level(200, 3) == 2 && DirectRing.level(500, 3) == 3 && DirectRing.level(1000, 3) == 3)
    ok("level: capped by what the sensor can, 0 — no direct mode", DirectRing.level(800, 2) == 2 && DirectRing.level(800, 1) == 1 && DirectRing.level(200, 0) == 0 && DirectRing.level(50, -1) == 0)

    val slots = 8
    val mem = ByteBuffer.allocate(slots * DirectRing.SIZE).order(ByteOrder.LITTLE_ENDIAN)
    val r = DirectRing(mem)
    val got = ArrayList<Triple<Int, Long, Float>>()
    fun drain() = r.drain { tok, t, v -> got.add(Triple(tok, t, v[0])) }

    ok("empty ring gives nothing", drain() == 0 && got.isEmpty())
    put(mem, 0, 1, 7, 1000L, 1f, 2f, 3f); put(mem, 1, 2, 7, 1010L, 4f, 5f, 6f)
    ok("two new records come in order", drain() == 2 && got.map { it.third } == listOf(1f, 4f) && got[0].first == 7 && got[1].second == 1010L)
    ok("the same records are not read twice", drain() == 0 && got.size == 2)
    put(mem, 2, 3, 7, 1020L, 9f, 0f, 0f)
    ok("a later record is picked up", drain() == 1 && got.last().third == 9f)

    // дописываем до конца круга и дальше: второй круг, счётчик слота растёт
    for (i in 3 until slots) put(mem, i, i + 1, 7, 1000L + i * 10, i.toFloat() * 10, 0f, 0f)
    ok("up to the end of the ring", drain() == slots - 3 && got.size == slots)
    put(mem, 0, slots + 1, 7, 2000L, 111f, 0f, 0f); put(mem, 1, slots + 2, 7, 2010L, 222f, 0f, 0f)
    ok("second lap: slots with a new counter are read again", drain() == 2 && got[slots].third == 111f && got[slots + 1].third == 222f)

    // слот с неполной записью (размер не 104) не читается и не двигает позицию
    val half = ByteBuffer.allocate(4 * DirectRing.SIZE).order(ByteOrder.LITTLE_ENDIAN)
    val r2 = DirectRing(half)
    half.putInt(12, 5)
    ok("a half-written slot (no size) waits", r2.drain { _, _, _ -> } == 0)
    half.putInt(0, DirectRing.SIZE)
    ok("…and is read once it is complete", r2.drain { _, _, _ -> } == 1)

    // счётчик переходит через 2^32
    val w = ByteBuffer.allocate(4 * DirectRing.SIZE).order(ByteOrder.LITTLE_ENDIAN)
    val r3 = DirectRing(w); var n3 = 0
    put(w, 0, -2, 1, 1L, 1f, 0f, 0f); put(w, 1, -1, 1, 2L, 2f, 0f, 0f); put(w, 2, 1, 1, 3L, 3f, 0f, 0f)
    r3.drain { _, _, _ -> n3++ }
    ok("counter wrap (0xFFFFFFFF → 1)", n3 == 3)

    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
