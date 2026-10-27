package app.dsp.phone

import org.json.JSONArray
import org.json.JSONObject

/**
 * Дескрипторы USB из сырых байт (UsbDeviceConnection.getRawDescriptors: дескриптор устройства и все конфигурации).
 * Модель UsbDevice в Android может не показывать альтернативные настройки интерфейсов — а у SDR-донглов потоковая точка
 * бывает только в них (Mirics: alt 3). Чистая логика без Android-типов — проверяется на JVM.
 */
object UsbDesc {
    class Parsed(val usb: String, val speedHint: String, val configs: JSONArray)

    private fun u8(b: ByteArray, o: Int) = b[o].toInt() and 255
    private fun u16(b: ByteArray, o: Int) = u8(b, o) or (u8(b, o + 1) shl 8)
    private fun bcd(v: Int) = "${(v shr 8) and 255}.${String.format("%02x", v and 255)}"

    private fun type(attrs: Int) = when (attrs and 3) { 1 -> "isochronous"; 2 -> "bulk"; 3 -> "interrupt"; else -> "control" }

    fun parse(b: ByteArray): Parsed {
        var usb = "2.00"
        var p = 0
        if (b.size >= 18 && u8(b, 1) == 1) { usb = bcd(u16(b, 2)); p = u8(b, 0) }
        val cfgs = JSONArray()
        var maxBulk = 0
        while (p + 2 <= b.size) {
            val len = u8(b, p)
            if (len < 2 || p + len > b.size) break
            if (u8(b, p + 1) == 2 && len >= 9) {                         // конфигурация: тело — до wTotalLength
                val end = minOf(b.size, p + u16(b, p + 2))
                val ifs = JSONArray()
                var cur: JSONObject? = null
                var q = p + len
                while (q + 2 <= end) {
                    val l = u8(b, q)
                    if (l < 2 || q + l > end) break
                    when (u8(b, q + 1)) {
                        4 -> if (l >= 9) {                               // интерфейс (каждая альтернативная настройка — отдельный)
                            cur = JSONObject().put("num", u8(b, q + 2)).put("alt", u8(b, q + 3)).put("cls", u8(b, q + 5)).put("sub", u8(b, q + 6))
                                .put("proto", u8(b, q + 7)).put("name", JSONObject.NULL).put("eps", JSONArray())
                            ifs.put(cur)
                        }
                        5 -> if (l >= 7 && cur != null) {                // конечная точка
                            val a = u8(b, q + 2); val at = u8(b, q + 3); val w = u16(b, q + 4)
                            val size = (w and 0x7ff) * (1 + ((w shr 11) and 3))
                            if ((at and 3) == 2) maxBulk = maxOf(maxBulk, size)
                            cur.getJSONArray("eps").put(JSONObject().put("num", a and 15).put("in", (a and 0x80) != 0).put("type", type(at)).put("size", size))
                        }
                    }
                    q += l
                }
                cfgs.put(JSONObject().put("value", u8(b, p + 5)).put("name", JSONObject.NULL).put("ifaces", ifs))
                p = if (end > p + len) end else p + len
                continue
            }
            p += len
        }
        // размер bulk-пакета выдаёт скорость порта: 512 — high-speed, 64 — full-speed (через хаб или кабель OTG бывает ниже, чем у устройства)
        val hint = when { maxBulk >= 512 -> "high-speed"; maxBulk in 1..64 -> "full-speed"; else -> "" }
        return Parsed(usb, hint, cfgs)
    }
}
