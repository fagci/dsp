package app.dsp.phone

import org.json.JSONObject

/** Сборка JSON-записей вручную: датчики дают сотни записей в секунду. */
object Json {
    fun num(v: Double, scale: Double = 1e4): String =
        if (v.isFinite()) (Math.round(v * scale) / scale).toString() else "null"

    fun arr(l: List<String>): String = l.joinToString(",", "[", "]") { str(it) }

    fun rows(l: List<String>): String = l.joinToString(",", "[", "]")

    fun map(m: Map<String, String>): String = m.entries.joinToString(",", "{", "}") { str(it.key) + ":" + str(it.value) }

    fun str(s: String?): String = JSONObject.quote(s ?: "")

    fun obj(vararg kv: Pair<String, String?>): String {
        val sb = StringBuilder("{")
        var first = true
        for ((k, v) in kv) {
            if (v == null) continue
            if (!first) sb.append(',')
            first = false
            sb.append('"').append(k).append("\":").append(v)
        }
        return sb.append('}').toString()
    }

    fun note(level: String, msg: String): String =
        obj("src" to str("bridge"), "level" to str(level), "msg" to str(msg))
}
