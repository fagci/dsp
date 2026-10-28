package app.dsp.phone

import android.content.Intent
import java.net.URLEncoder

/**
 * Запуск патча снаружи: dsp://run?patch=ИМЯ&run=1 (или то же в extras patch / run / data). Строит хэш страницы (#p=… #d=… &run=1):
 * его уже понимает веб-часть (presets.js, loadFromHash).
 */
object Launch {
    /** data — патч целиком в ссылке (#d=…), его приложение принимает только когда включено «Let other apps open patches from a link». */
    fun hash(patch: String?, data: String?, run: Boolean, allowData: Boolean): String {
        val parts = ArrayList<String>()
        val d = data?.trim().orEmpty()
        val p = patch?.trim().orEmpty()
        if (d.isNotEmpty() && allowData && d.matches(B64)) parts.add("d=$d")
        else if (p.isNotEmpty() && p.length <= 200) parts.add("p=" + URLEncoder.encode(p, "UTF-8").replace("+", "%20"))
        if (run && parts.isNotEmpty()) parts.add("run=1")
        return if (parts.isEmpty()) "" else "#" + parts.joinToString("&")
    }

    fun hash(i: Intent?, cfg: Config): String {
        if (i == null) return ""
        val u = i.data
        val q = { k: String -> u?.getQueryParameter(k) ?: i.getStringExtra(k) }
        val run = (q("run") ?: if (i.hasExtra("run")) i.extras?.get("run")?.toString() else null).let { it != null && it !in OFF }
        return hash(q("patch"), q("data"), run, cfg.extPatch)
    }

    private val B64 = Regex("[A-Za-z0-9_-]{1,200000}")
    private val OFF = setOf("0", "false", "no", "off", "")
}
