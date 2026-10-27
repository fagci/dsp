package app.dsp.phone

import android.content.Context
import java.security.SecureRandom

/** Настройки моста: порт, доступ из сети, токен, разрешённые сайты. */
class Config(ctx: Context) {
    private val sp = ctx.getSharedPreferences("bridge", Context.MODE_PRIVATE)

    var port: Int
        get() = sp.getInt("port", 8765)
        set(v) { sp.edit().putInt("port", v).apply() }

    /** Слушать все интерфейсы (иначе только 127.0.0.1). Токен тогда обязателен для чужих устройств. */
    var shareLan: Boolean
        get() = sp.getBoolean("shareLan", false)
        set(v) { sp.edit().putBoolean("shareLan", v).apply() }

    /** Требовать токен и с этого телефона. */
    var strict: Boolean
        get() = sp.getBoolean("strict", false)
        set(v) { sp.edit().putBoolean("strict", v).apply() }

    /** Сайты (Origin) через запятую, которым можно подключаться, кроме приложения и localhost. */
    var origins: String
        get() = sp.getString("origins", DEFAULT_ORIGIN) ?: ""
        set(v) { sp.edit().putString("origins", v).apply() }

    var token: String
        get() {
            val t = sp.getString("token", "") ?: ""
            if (t.isNotEmpty()) return t
            return newToken().also { sp.edit().putString("token", it).apply() }
        }
        set(v) { sp.edit().putString("token", v).apply() }

    fun allowedOrigins(): Set<String> =
        (origins.split(',', ' ', '\n').map { it.trim().trimEnd('/') }.filter { it.isNotEmpty() } + APP_ORIGIN).toSet()

    fun newToken(): String {
        val a = "abcdefghijkmnpqrstuvwxyz23456789"
        val r = SecureRandom()
        return String(CharArray(16) { a[r.nextInt(a.length)] })
    }

    companion object {
        const val APP_HOST = "appassets.androidplatform.net"
        const val APP_ORIGIN = "https://$APP_HOST"
        const val DEFAULT_ORIGIN = "https://fagci.github.io"
    }
}
