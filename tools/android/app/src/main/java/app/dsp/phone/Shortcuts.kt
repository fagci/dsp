package app.dsp.phone

import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.net.Uri
import org.json.JSONArray
import java.net.URLEncoder

/** Чистая логика ярлыков (без Android-вызовов — проверяется на JVM). */
object ShortcutArgs {
    const val MAX = 8

    /** Имена избранных патчей из JSON-массива страницы: без пустых, слишком длинных (Launch принимает до 200 знаков) и повторов; не больше max. */
    fun parse(json: String?, max: Int = MAX): List<String> = try {
        val a = JSONArray(json ?: "[]")
        (0 until a.length()).map { a.optString(it).trim() }.filter { it.isNotEmpty() && it.length <= 200 }.distinct().take(max.coerceAtLeast(0))
    } catch (e: Exception) { emptyList() }

    /** Короткая подпись: без префикса «Phone App: » и подобных до «: », не длиннее 25 знаков (лаунчер обрежет сам). */
    fun shortLabel(name: String): String = name.substringAfter(": ", name).take(25)

    fun longLabel(name: String): String = name.take(80)

    /** Постоянный идентификатор ярлыка по имени патча. */
    fun id(name: String): String = "p" + Integer.toHexString(name.hashCode())

    /** Адрес, который MainActivity уже понимает (Launch.hash): открыть патч по имени и запустить. */
    fun uri(name: String): String = "dsp://run?patch=" + URLEncoder.encode(name, "UTF-8").replace("+", "%20") + "&run=1"
}

/**
 * Ярлыки приложения по долгому нажатию на иконку: избранные патчи страницы (звезда в списке). Страница вызывает DspApp.setShortcuts(json) при каждой
 * перемене звёзд; здесь они становятся динамическими ярлыками ShortcutManager, каждый открывает патч и запускает его (dsp://run?patch=ИМЯ&run=1).
 * Сколько ярлыков покажет лаунчер, решает он сам (обычно 4–5, первые по порядку звёзд).
 */
object Shortcuts {
    /** Возвращает, сколько ярлыков стало; −1 — не вышло (система отказала). */
    fun set(ctx: Context, names: List<String>): Int = try {
        val sm = ctx.getSystemService(ShortcutManager::class.java)
        if (sm == null) -1
        else {
            val list = names.take(minOf(ShortcutArgs.MAX, sm.maxShortcutCountPerActivity)).mapIndexed { i, n ->
                ShortcutInfo.Builder(ctx, ShortcutArgs.id(n)).setShortLabel(ShortcutArgs.shortLabel(n)).setLongLabel(ShortcutArgs.longLabel(n))
                    .setIcon(Icon.createWithResource(ctx, android.R.drawable.star_big_on))
                    .setIntent(Intent(Intent.ACTION_VIEW, Uri.parse(ShortcutArgs.uri(n)), ctx, MainActivity::class.java)).setRank(i).build()
            }
            if (list.isEmpty()) sm.removeAllDynamicShortcuts() else sm.setDynamicShortcuts(list)
            list.size
        }
    } catch (e: Exception) { -1 }
}
