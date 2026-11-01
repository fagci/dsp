package app.dsp.phone

/**
 * Нативный видеоплеер приложения (ExoPlayer, NativePlayer.kt) для страницы: форматы и адреса, которых нет у <video> WebView —
 * mkv / ts / avi, AC3 / DTS, `udp://@239.1.1.1:1234` и `rtp://@…` (multicast провайдера), rtsp://.
 * Интерфейс отдельно от реализации: MainActivity находит NativePlayer по имени, а JVM-тесты логики моста собираются без media3.
 */
interface PlayerApi {
    /** json: {url, pos (мс), autoplay, speed, title}. false — адрес пустой. Картинка — на весь экран поверх страницы, со своими кнопками. */
    fun open(json: String): Boolean
    /** json: {a: play | pause | toggle | seek | seekBy | speed | close, v: число (мс / скорость)} */
    fun cmd(json: String)
    fun isOpen(): Boolean
    fun release()
}
