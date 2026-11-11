package app.dsp.phone

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Прямой канал датчика (SensorDirectChannel): ЦП телефона не участвует — датчик пишет отсчёты в общую память,
 * мы только читаем её. Частоты стабильные (50 / 200 / 800 Гц), без джиттера Binder-доставки и без пропусков,
 * потому для вибро- и аудио-анализа это лучше обычного registerListener.
 *
 * Память — кольцо записей по 104 байта (sensors_event_t, формат задан Android):
 *   +0 int32 размер (104) · +4 int32 токен датчика · +8 int32 тип · +12 uint32 счётчик записи (0 — слот пуст)
 *   +16 int64 время, нс (elapsedRealtime) · +24 float[16] значения.
 * Счётчик пишется последним и растёт с каждым кругом, поэтому «слот новый» = счётчик ≠ 0 и ≠ виденного в этом слоте.
 */
class DirectRing(mem: ByteBuffer, val slots: Int = mem.capacity() / SIZE) {
    companion object {
        const val SIZE = 104
        /** Уровни частоты SensorDirectChannel: RATE_NORMAL, RATE_FAST, RATE_VERY_FAST (Гц по документации). */
        val RATE_HZ = intArrayOf(0, 50, 200, 800)

        /** Минимальный уровень (1…3), дающий не меньше hz; больше предела датчика не берём. 0 — прямой канал не нужен/нельзя. */
        fun level(hz: Int, highest: Int): Int {
            if (highest < 1) return 0
            val want = when { hz <= 50 -> 1; hz <= 200 -> 2; else -> 3 }
            return minOf(want, highest.coerceAtMost(3))
        }
        /** Размер памяти под ~0,5 с отсчётов самой высокой частоты (800 Гц × 0,5 = 400 → 512 записей). */
        const val MEM_BYTES = 512 * SIZE
    }

    private val b = mem.duplicate().order(ByteOrder.LITTLE_ENDIAN)
    private val seen = IntArray(slots)
    private var pos = 0
    private val vals = FloatArray(16)

    /** Отдаёт все новые записи по порядку: токен датчика, время (нс), значения. Возвращает их число. */
    fun drain(cb: (token: Int, tNs: Long, v: FloatArray) -> Unit): Int {
        var n = 0
        var guard = slots
        while (guard-- > 0) {
            val o = pos * SIZE
            val c = b.getInt(o + 12)
            if (c == 0 || c == seen[pos]) break
            if (b.getInt(o) != SIZE) break                          // запись ещё не доведена (или чужой формат)
            seen[pos] = c
            val t = b.getLong(o + 16)
            for (i in 0 until 16) vals[i] = b.getFloat(o + 24 + i * 4)
            cb(b.getInt(o + 4), t, vals)
            n++
            pos = (pos + 1) % slots
        }
        return n
    }
}
