package app.dsp.phone

import org.json.JSONArray
import org.json.JSONObject

/**
 * Какие приложения идут через VPN-монитор: все, только выбранные («only» — остальные ходят мимо туннеля, их не видно и не замедляет)
 * или все кроме выбранных. Выбор — пакетами или uid (из таблицы установленных приложений или из трафика). Чистая логика — проверяется на JVM.
 */
class AppSel(val mode: String, val pkgs: List<String>) {
    fun same(o: AppSel) = mode == o.mode && pkgs.toSet() == o.pkgs.toSet()
    fun toJson(): String = Json.obj("mode" to Json.str(mode), "apps" to Json.arr(pkgs))

    companion object {
        val ALL = AppSel("all", emptyList())
        private val PKG = Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+")
        const val MAX = 500

        /** Из команды: `mode` all | only | except, `apps` (массив или строка через запятую / пробел), `uids` (массив чисел или строка).
         *  Без mode: есть список — «only», нет — «all». uid превращается в пакеты через [pkgsOf] (getPackagesForUid). Ошибка — текст во второй части. */
        fun parse(j: JSONObject, pkgsOf: (Int) -> List<String>): Pair<AppSel?, String?> {
            val names = LinkedHashSet<String>()
            for (s in items(j.opt("apps"))) {
                if (!PKG.matches(s)) return null to "apps: «$s» is not a package name (com.example.app)"
                names.add(s)
            }
            for (s in items(j.opt("uids"))) {
                val u = s.toIntOrNull()?.takeIf { it >= 0 } ?: return null to "uids: «$s» is not a number"
                names.addAll(pkgsOf(u))
            }
            if (names.size > MAX) return null to "at most $MAX apps"
            val mode = j.optString("mode").trim().lowercase().ifEmpty { if (names.isEmpty()) "all" else "only" }
            return when (mode) {
                "all" -> ALL to null
                "only", "except" -> if (names.isEmpty()) null to "mode «$mode» needs apps or uids" else AppSel(mode, names.toList()) to null
                else -> null to "mode: all | only | except"
            }
        }

        private fun items(v: Any?): List<String> = when (v) {
            null, JSONObject.NULL -> emptyList()
            is JSONArray -> (0 until v.length()).map { v.opt(it).toString().trim() }.filter { it.isNotEmpty() }
            else -> v.toString().split(Regex("[,;\\s]+")).map { it.trim() }.filter { it.isNotEmpty() }
        }
    }
}

/** Строка таблицы установленных приложений: uid общий у нескольких пакетов (sharedUserId) — они сливаются в одну строку. */
object AppRows {
    class App(val uid: Int, val pkg: String, val label: String, val system: Boolean)

    fun group(apps: List<App>, withSystem: Boolean): List<String> =
        apps.filter { withSystem || !it.system }.groupBy { it.uid }.toSortedMap().map { (uid, l) ->
            val first = l.minByOrNull { it.pkg }!!
            Json.obj("src" to Json.str("app"), "uid" to uid.toString(), "pkg" to Json.str(first.pkg), "pkgs" to Json.arr(l.map { it.pkg }.sorted()),
                "label" to Json.str(first.label), "system" to l.all { it.system }.toString())
        }
}
