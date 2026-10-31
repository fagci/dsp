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

    /** Проверять Origin браузера (CORS-подобная защита от чужих сайтов). Выключено: пускаем любые страницы. */
    var checkOrigin: Boolean
        get() = sp.getBoolean("checkOrigin", false)
        set(v) { sp.edit().putBoolean("checkOrigin", v).apply() }

    /** Сайты (Origin) через запятую, когда проверка включена, которым можно подключаться, кроме приложения и localhost. */
    var origins: String
        get() = sp.getString("origins", DEFAULT_ORIGIN) ?: ""
        set(v) { sp.edit().putString("origins", v).apply() }

    /** Перехват пакетов через root (su + tcpdump). Выключено: любая страница с доступом к порту иначе могла бы запросить root. */
    var sniffer: Boolean
        get() = sp.getBoolean("sniffer", false)
        set(v) { sp.edit().putBoolean("sniffer", v).apply() }

    /** Действия (сеть, соединения Bluetooth, речь, управление телефоном) — не только странице приложения, а любой странице с доступом к порту. SMS и контакты это не открывает. */
    var openCmds: Boolean
        get() = sp.getBoolean("openCmds", false)
        set(v) { sp.edit().putBoolean("openCmds", v).apply() }

    /** Пусто — без токена. */
    var token: String
        get() = sp.getString("token", "") ?: ""
        set(v) { sp.edit().putString("token", v).apply() }

    /** Запускать мост при загрузке телефона (BootReceiver), не дожидаясь, пока откроют приложение. */
    var autoStart: Boolean
        get() = sp.getBoolean("autoStart", false)
        set(v) { sp.edit().putBoolean("autoStart", v).apply() }

    /** Патчи, которые запускаются без окна при загрузке телефона (имена через «;», до BootPatches.MAX): HeadlessHub. */
    var bootPatches: String
        get() = sp.getString("bootPatches", "") ?: ""
        set(v) { sp.edit().putString("bootPatches", v).apply() }

    /** Другие приложения (Tasker, MacroDroid) управляют мостом интентом app.dsp.phone.EXT. */
    var extIntents: Boolean
        get() = sp.getBoolean("extIntents", false)
        set(v) { sp.edit().putBoolean("extIntents", v).apply() }

    /** Ссылка dsp://run?data=… может нести патч целиком (иначе принимаются только имена уже сохранённых патчей). */
    var extPatch: Boolean
        get() = sp.getBoolean("extPatch", false)
        set(v) { sp.edit().putBoolean("extPatch", v).apply() }

    /** Реже опрашивать датчики и радио при разряде, экономии энергии и перегреве (PowerPolicy). */
    var autoThrottle: Boolean
        get() = sp.getBoolean("autoThrottle", true)
        set(v) { sp.edit().putBoolean("autoThrottle", v).apply() }

    /** Через сколько минут без единого клиента закрыть оставленные соединения и слушатели (GATT, RFCOMM, сокеты, реклама). 0 — не закрывать. */
    var idleMin: Int
        get() = sp.getInt("idleMin", 30)
        set(v) { sp.edit().putInt("idleMin", v.coerceIn(0, 1440)).apply() }

    /** Писать смены «лежит / идёт / экран заблокирован» в файл без открытой страницы (источник activity). */
    var activityLog: Boolean
        get() = sp.getBoolean("activityLog", false)
        set(v) { sp.edit().putBoolean("activityLog", v).apply() }

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
