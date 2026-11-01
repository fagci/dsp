package app.dsp.phone

import android.content.Context
import org.json.JSONObject
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/** Чистая логика VLC Source (без libVLC и Android — проверяется на JVM). */
object VlcArgs {
    /** Схемы, которые можно отдать libVLC: сеть, multicast, сетевые папки; fd:// / file:// / content:// — нет (файлы приложения и телефона закрыты). */
    private val SCHEMES = setOf("http", "https", "rtsp", "rtp", "udp", "rtmp", "mms", "mmsh", "smb", "ftp", "ftps", "sftp", "nfs", "upnp", "dav", "davs")

    fun urlOk(url: String): Boolean {
        val i = url.indexOf("://")
        if (i <= 0 || url.length > 2000 || url.any { c -> c.code < 32 }) return false
        return url.substring(0, i).lowercase() in SCHEMES
    }

    /** Звук в сырой PCM s16le по UDP на loopback: libVLC декодирует любой формат, страница получает отсчёты. */
    fun sout(port: Int, rate: Int, channels: Int): String {
        val r = rate.coerceIn(8000, 192000); val ch = channels.coerceIn(1, 2)
        return ":sout=#transcode{acodec=s16l,channels=$ch,samplerate=$r}:std{access=udp,mux=raw,dst=127.0.0.1:${port.coerceIn(1024, 65535)}}"
    }

    /** Параметры libVLC для источника: без картинки, своя очередь сети, без вывода на экран и в динамик. */
    fun options(port: Int, rate: Int, channels: Int, cachingMs: Int): List<String> =
        listOf(sout(port, rate, channels), ":no-video", ":no-sout-all", ":network-caching=${cachingMs.coerceIn(100, 10_000)}")

    fun portOk(p: Int) = p in 1024..65535
}

/**
 * VLC Source для графа DSP (мост приложения): vlc.open {url, port, rate, channels, caching} — libVLC открывает любой адрес (файл по сети, поток,
 * multicast, smb:// ftp:// upnp://, AC3 / DTS / FLAC / экзотические кодеки), декодирует звук и шлёт его сырым PCM s16le на 127.0.0.1:port —
 * страница слушает этот порт командой udp.open моста и превращает в аудиосигнал узла. vlc.close {vid}, vlc.cmd {vid, a: play | pause | seek, v (мс)},
 * vlc.list. События (состояние, название, позиция, ошибка) приходят записями {src:"vlc", ev:"state", vid, state, title, pos, dur, msg}.
 * Только страница приложения; libVLC — в отдельном экземпляре на источник.
 */
class VlcHub(private val ctx: Context) {
    private class Src(val vid: Int, val lib: LibVLC, val mp: MediaPlayer, val client: BridgeServer.Client)
    private val srcs = ConcurrentHashMap<Int, Src>()
    private val ids = AtomicInteger(0)

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        if (!c.trusted) return Reply.done(c, id, cmd, "only the page of the DSP app may use it", "forbidden")
        try {
            when (cmd) {
                "vlc.open" -> {
                    val url = j.optString("url").trim()
                    if (!VlcArgs.urlOk(url)) return Reply.done(c, id, cmd, "url: http(s) rtsp rtp udp rtmp smb ftp sftp nfs upnp … (not file:// or fd://)", "args")
                    val port = j.optInt("port", 0)
                    if (!VlcArgs.portOk(port)) return Reply.done(c, id, cmd, "port: 1024…65535 (the page's UDP port on 127.0.0.1)", "args")
                    if (srcs.size >= 4) return Reply.done(c, id, cmd, "4 sources at most", "limit")
                    val vid = ids.incrementAndGet()
                    val lib = LibVLC(ctx.applicationContext, arrayListOf("--no-video", "--http-reconnect"))
                    val mp = MediaPlayer(lib)
                    val media = Media(lib, android.net.Uri.parse(url))
                    for (o in VlcArgs.options(port, j.optInt("rate", 48000), j.optInt("channels", 2), j.optInt("caching", 1000))) media.addOption(o)
                    mp.media = media
                    media.release()
                    val s = Src(vid, lib, mp, c)
                    srcs[vid] = s
                    mp.setEventListener(MediaPlayer.EventListener { ev -> onEvent(s, ev) })
                    mp.play()
                    Reply.done(c, id, cmd, null, extra = arrayOf("vid" to vid.toString()))
                }
                "vlc.close" -> { close(j.optInt("vid", -1)); Reply.done(c, id, cmd, null) }
                "vlc.cmd" -> {
                    val s = srcs[j.optInt("vid", -1)] ?: return Reply.done(c, id, cmd, "no such source", "args")
                    when (j.optString("a")) {
                        "play" -> s.mp.play()
                        "pause" -> s.mp.pause()
                        "seek" -> s.mp.time = j.optLong("v", 0).coerceAtLeast(0)
                        else -> return Reply.done(c, id, cmd, "a: play | pause | seek", "args")
                    }
                    Reply.done(c, id, cmd, null)
                }
                "vlc.list" -> Reply.done(c, id, cmd, null, extra = arrayOf("n" to srcs.size.toString(), "vids" to srcs.keys.sorted().joinToString(",", "[", "]")))
                else -> Reply.done(c, id, cmd, "unknown vlc command", "args")
            }
        } catch (e: Throwable) {
            Reply.done(c, id, cmd, e.message ?: e.javaClass.simpleName)
        }
    }

    private fun onEvent(s: Src, ev: MediaPlayer.Event) {
        val state = when (ev.type) {
            MediaPlayer.Event.Opening -> "opening"
            MediaPlayer.Event.Buffering -> "buffering"
            MediaPlayer.Event.Playing -> "playing"
            MediaPlayer.Event.Paused -> "paused"
            MediaPlayer.Event.Stopped -> "stopped"
            MediaPlayer.Event.EndReached -> "ended"
            MediaPlayer.Event.EncounteredError -> "error"
            else -> return
        }
        val o = JSONObject().put("src", "vlc").put("ev", "state").put("vid", s.vid).put("state", state)
            .put("pos", s.mp.time).put("dur", maxOf(s.mp.length, 0L))
        try { s.mp.media?.getMeta(org.videolan.libvlc.interfaces.IMedia.Meta.Title)?.let { t -> o.put("title", t) } } catch (e: Throwable) { }
        if (state == "error") o.put("msg", "libVLC cannot open or decode this address (the format, the server, the login)")
        try { s.client.send(o.toString()) } catch (e: Throwable) { }
    }

    private fun close(vid: Int) {
        val s = srcs.remove(vid) ?: return
        try { s.mp.setEventListener(null); s.mp.stop(); s.mp.release() } catch (e: Throwable) { }
        try { s.lib.release() } catch (e: Throwable) { }
    }

    /** Остановка службы. */
    fun close() { for (k in srcs.keys.toList()) close(k) }
}
