package app.dsp.phone

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Ответ на команду: запись {src:'cmd', cmd, id, ok, …} только тому клиенту, который спросил. */
object Reply {
    fun done(c: BridgeServer.Client, id: Any?, cmd: String, err: String?, code: String = "error", vararg extra: Pair<String, String?>) {
        val kv = ArrayList<Pair<String, String?>>()
        kv.add("src" to "\"cmd\""); kv.add("cmd" to Json.str(cmd))
        if (id != null) kv.add("id" to (if (id is Number) id.toString() else Json.str(id.toString())))
        kv.add("ok" to if (err == null) "true" else "false")
        if (err != null) { kv.add("err" to Json.str(code)); kv.add("msg" to Json.str(err)) }
        kv.addAll(extra)
        c.send(Json.obj(*kv.toTypedArray()))
    }
}

/** Нужные разрешения: нет — просим (окно или уведомление) и отвечаем ошибкой, команду повторят после выдачи. */
class Needs(private val ctx: Context, private val askPerms: (List<String>) -> Unit) {
    fun need(c: BridgeServer.Client, id: Any?, cmd: String, perms: List<String>): Boolean {
        val miss = perms.filter { !ctx.granted(it) }
        if (miss.isEmpty()) return true
        askPerms(miss)
        Reply.done(c, id, cmd, "allow ${miss.joinToString { it.substringAfterLast('.').lowercase().replace('_', ' ') }} in the window (or the notification) and repeat", "permission")
        return false
    }
}

/** Разбор аргументов команд страницы (чистая логика — проверяется на JVM). Всё, что идёт к сокету, процессу или root, проходит здесь. */
object Args {
    private val HEX = Regex("[0-9a-fA-F]*")
    private val HOST = Regex("[A-Za-z0-9._\\-]{1,253}")
    private val MAC = Regex("([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}")
    private val SAFE = Regex("[A-Za-z0-9._:/@=+,\\-]{1,200}")

    /** «48 65 6c», «0x48,0x65», «48:65» → байты; null — не hex, нечётная длина или больше max. */
    fun hex(s: String?, max: Int = 65535): ByteArray? {
        val t = (s ?: return null).replace(Regex("0x|[\\s:,_-]", RegexOption.IGNORE_CASE), "")
        if (t.length % 2 != 0 || t.length / 2 > max || !HEX.matches(t)) return null
        return ByteArray(t.length / 2) { t.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }

    /** Полезная нагрузка команды: поле hex или text (UTF-8). */
    fun payload(j: JSONObject, max: Int = 65535): ByteArray? {
        if (j.has("hex")) return hex(j.optString("hex"), max)
        if (j.has("text")) return j.optString("text").toByteArray(Charsets.UTF_8).takeIf { it.size <= max }
        return null
    }

    fun port(v: Int) = v in 1..65535

    /** Интервал периодической рекламы: мс → единицы по 1,25 мс (80…65519, то есть 100 мс … 81,9 с). */
    fun periodicInterval(ms: Double): Int = Math.round(ms / 1.25).toInt().coerceIn(80, 65519)

    /** PSM канала L2CAP: стек сам отклонит лишнее, здесь только границы. */
    fun psm(v: Int) = v in 1..65535

    /** Имя хоста или IPv4/IPv6-адрес без пробелов и символов оболочки. */
    fun host(s: String?): String? = s?.trim()?.takeIf { HOST.matches(it) || (it.contains(':') && Regex("[0-9A-Fa-f:.]{2,45}").matches(it)) }

    fun mac(s: String?): String? = s?.trim()?.takeIf { MAC.matches(it) }?.uppercase()

    /** UUID: 16 бит («180d», «0x180D»), 32 бита или полный. */
    fun uuid(s: String?): UUID? {
        val t = (s ?: return null).trim().lowercase().removePrefix("0x")
        return try {
            when {
                Regex("[0-9a-f]{4}").matches(t) -> UUID.fromString("0000$t-0000-1000-8000-00805f9b34fb")
                Regex("[0-9a-f]{8}").matches(t) -> UUID.fromString("$t-0000-1000-8000-00805f9b34fb")
                Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").matches(t) -> UUID.fromString(t)
                else -> null
            }
        } catch (e: IllegalArgumentException) { null }
    }

    /** Короткая запись UUID: 16 бит, если он из базы Bluetooth SIG, иначе полный. */
    fun uuidShort(u: UUID): String {
        val s = u.toString()
        return if (s.startsWith("0000") && s.endsWith("-0000-1000-8000-00805f9b34fb")) s.substring(4, 8) else s
    }

    /** Узор вибрации: [пауза, вибро, пауза, …] в мс, до 200 элементов, каждый до 60 с, всего до 10 минут. */
    fun vibPattern(a: JSONArray?): LongArray? {
        if (a == null || a.length() < 1 || a.length() > 200) return null
        val out = LongArray(a.length()); var sum = 0L
        for (i in out.indices) { val v = a.optLong(i, -1); if (v < 0 || v > 60_000) return null; out[i] = v; sum += v }
        return out.takeIf { sum in 1..600_000 }
    }

    /** Токены для `am start` под root: только безопасные символы, чтобы из страницы в оболочку ничего лишнего не попало. */
    fun safeToken(s: String?): String? = s?.trim()?.takeIf { SAFE.matches(it) }
}

/** Разбор вывода системного ping (чистая логика). */
object NetParse {
    private val REPLY = Regex("(\\d+) bytes from (?:[^:\\s]+ \\()?([^:\\s)]+)\\)?.*?icmp_seq=(\\d+).*?(?:ttl=(\\d+))?.*?time[=<]([0-9.]+) ms")
    private val EXCEEDED = Regex("^From\\s+(?:\\S+\\s+\\()?(\\d{1,3}(?:\\.\\d{1,3}){3})\\)?[:\\s].*?(Time to live exceeded|[Uu]nreachable|prohibited|filtered)")
    private val SUMMARY = Regex("(\\d+) packets transmitted, (\\d+) (?:packets )?received")
    private val RTT = Regex("= ([0-9.]+)/([0-9.]+)/([0-9.]+)")

    class Reply(val bytes: Int, val from: String, val seq: Int, val ttl: Int?, val ms: Double)
    fun reply(line: String): Reply? {
        val m = REPLY.find(line) ?: return null
        val ttl = Regex("ttl=(\\d+)").find(line)?.groupValues?.get(1)?.toInt()
        return Reply(m.groupValues[1].toInt(), m.groupValues[2], m.groupValues[3].toInt(), ttl, m.groupValues[5].toDouble())
    }
    /** Ответ маршрутизатора на пробу с малым TTL: «From 10.0.0.1 icmp_seq=1 Time to live exceeded» → (адрес, конец пути?). «Unreachable» — путь дальше не идёт. */
    fun exceeded(line: String): Pair<String, Boolean>? {
        val m = EXCEEDED.find(line.trim()) ?: return null
        return m.groupValues[1] to !m.groupValues[2].startsWith("Time to live")
    }
    fun summary(line: String): Pair<Int, Int>? = SUMMARY.find(line)?.let { it.groupValues[1].toInt() to it.groupValues[2].toInt() }
    fun rtt(line: String): Triple<Double, Double, Double>? = RTT.find(line)?.let { Triple(it.groupValues[1].toDouble(), it.groupValues[2].toDouble(), it.groupValues[3].toDouble()) }
}
