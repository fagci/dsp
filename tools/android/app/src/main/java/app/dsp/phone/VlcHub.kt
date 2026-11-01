package app.dsp.phone

import android.content.Context
import org.json.JSONObject
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.RendererDiscoverer
import org.videolan.libvlc.RendererItem
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.concurrent.CopyOnWriteArrayList
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

/** Чистая логика VLC Out (звук графа наружу через libVLC): строки sout и проверка полей — без libVLC, проверяется на JVM. */
object VlcOutArgs {
    val MODES = setOf("http", "rtp", "icecast", "file", "renderer")
    /** Кодек → (кодер libVLC, контейнер). */
    private val CODECS = mapOf("mp3" to ("mp3" to "mp3"), "aac" to ("mp4a" to "ts"), "opus" to ("opus" to "ogg"), "flac" to ("flac" to "raw"))
    private val HOST = Regex("^[A-Za-z0-9._\\-\\[\\]:]{1,253}$")
    private val MOUNT = Regex("^[A-Za-z0-9._\\-/]{1,80}$")
    private val FILE = Regex("^[A-Za-z0-9._\\-]{1,60}$")

    fun hostOk(h: String) = HOST.matches(h)
    fun mountOk(m: String) = MOUNT.matches(m) && !m.contains("..")
    fun fileOk(f: String) = FILE.matches(f) && !f.startsWith(".")
    /** Логин и пароль идут в адрес Icecast: без разделителей адреса, кавычек и пробелов (процентное кодирование libVLC не снимает). */
    fun credOk(s: String) = s.length <= 100 && s.none { c -> c.code <= 32 || c in "@:/?#'\"\\{},=;" }
    fun ext(codec: String) = when (codec) { "mp3" -> "mp3"; "aac" -> "ts"; "opus" -> "opus"; "flac" -> "flac"; else -> "bin" }

    /** Частота кодера: opus — только 48000; остальным 44100 или 48000. */
    fun outRate(codec: String, want: Int) = if (codec == "opus") 48000 else if (want == 44100) 44100 else 48000

    /** Цепочка sout для режима; null — режим без sout (renderer) или недопустимое сочетание кодека и режима. */
    fun sout(mode: String, codec: String, kbps: Int, rate: Int, ch: Int, host: String, port: Int, mount: String, user: String, pass: String, path: String, ttl: Int): String? {
        val (ac, mux) = CODECS[codec] ?: return null
        val tc = "transcode{acodec=$ac,ab=${kbps.coerceIn(32, 320)},channels=${ch.coerceIn(1, 2)},samplerate=${outRate(codec, rate)}}"
        return when (mode) {
            "http" -> ":sout=#$tc:std{access=http,mux=$mux,dst=:${port.coerceIn(1024, 65535)}/${mount.trimStart('/')}}"
            "rtp" -> if (codec == "mp3" || codec == "aac") ":sout=#$tc:rtp{dst=$host,port=${port.coerceIn(1, 65535)},mux=ts,ttl=${ttl.coerceIn(1, 32)}}" else null
            "icecast" -> if (codec == "mp3" || codec == "opus") ":sout=#$tc:std{access=shout,mux=$mux,dst='//$user:$pass@$host:${port.coerceIn(1, 65535)}/${mount.trimStart('/')}'}" else null
            "file" -> ":sout=#$tc:std{access=file,mux=$mux,dst='$path'}"
            else -> null
        }
    }

    /** Вход libVLC: сырой PCM s16le с loopback (страница шлёт его командой udp.send). */
    fun input(port: Int, rate: Int, ch: Int, cachingMs: Int, withSout: Boolean): Pair<String, List<String>> =
        "udp://@127.0.0.1:${port.coerceIn(1024, 65535)}" to listOf(":demux=rawaud", ":rawaud-fourcc=s16l", ":rawaud-channels=${ch.coerceIn(1, 2)}", ":rawaud-samplerate=${rate.coerceIn(8000, 192000)}",
            ":network-caching=${cachingMs.coerceIn(50, 5000)}", ":no-video") + (if (withSout) listOf(":no-sout-video") else emptyList())

    /** Устройство по названию: точное, потом по вхождению (без учёта регистра); -1 — нет. */
    fun pick(names: List<String>, want: String): Int {
        val w = want.trim().lowercase(); if (w.isEmpty()) return -1
        val i = names.indexOfFirst { it.lowercase() == w }
        return if (i >= 0) i else names.indexOfFirst { it.lowercase().contains(w) }
    }
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
    private class Out(val oid: Int, val lib: LibVLC, val mp: MediaPlayer, val client: BridgeServer.Client) { @Volatile var dead = false }
    private val outs = ConcurrentHashMap<Int, Out>()
    private val pool = java.util.concurrent.Executors.newCachedThreadPool()
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
                "vlc.out.open" -> outOpen(c, id, cmd, j)
                "vlc.out.close" -> { outClose(j.optInt("oid", -1)); Reply.done(c, id, cmd, null) }
                "vlc.out.renderers" -> pool.execute {
                    try {
                        val lib = LibVLC(ctx.applicationContext, arrayListOf("--no-video"))
                        try {
                            val names = discover(lib, j.optInt("ms", 4000).coerceIn(1000, 10_000), null).first
                            Reply.done(c, id, cmd, null, extra = arrayOf("names" to org.json.JSONArray(names).toString()))
                        } finally { try { lib.release() } catch (e: Throwable) { } }
                    } catch (e: Throwable) { Reply.done(c, id, cmd, e.message ?: e.javaClass.simpleName) }
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

    /** Устройства вывода libVLC (Chromecast, UPnP / DLNA): ждёт ms миллисекунд, пока опрос находит; want — вернуть как только найдено нужное. */
    private fun discover(lib: LibVLC, ms: Int, want: String?): Pair<List<String>, RendererItem?> {
        val found = CopyOnWriteArrayList<RendererItem>()
        val rds = ArrayList<RendererDiscoverer>()
        try {
            for (d in RendererDiscoverer.list(lib) ?: emptyArray()) {
                val rd = RendererDiscoverer(lib, d.name)
                rd.setEventListener(RendererDiscoverer.EventListener { e ->
                    if (e.type == RendererDiscoverer.Event.ItemAdded) { e.item.retain(); found.add(e.item) }
                })
                if (rd.start()) rds.add(rd) else rd.release()
            }
            val t0 = System.currentTimeMillis(); var hit: RendererItem? = null
            while (System.currentTimeMillis() - t0 < ms) {
                if (want != null) { val i = VlcOutArgs.pick(found.map { it.displayName }, want); if (i >= 0) { hit = found[i]; break } }
                Thread.sleep(150)
            }
            return found.map { it.displayName + " (" + it.type + ")" } to hit
        } finally {
            for (rd in rds) { try { rd.setEventListener(null); rd.stop(); rd.release() } catch (e: Throwable) { } }
        }
    }

    private fun localIps(): List<String> = try {
        NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback }.flatMap { it.inetAddresses.toList() }
            .filterIsInstance<Inet4Address>().map { it.hostAddress ?: "" }.filter { it.isNotEmpty() }
    } catch (e: Throwable) { emptyList() }

    private fun freePort(): Int { DatagramSocket(0).use { return it.localPort } }

    /**
     * vlc.out.open {mode: http | rtp | icecast | file | renderer, codec: mp3 | aac | opus | flac, bitrate (кбит/с), rate (входа, Гц), outrate, channels, host, port, mount, user, pass, name, renderer, ttl, caching}:
     * приложение выбирает порт на loopback и отвечает {oid, port, ips, path}; страница шлёт на него PCM s16le командой udp.send, libVLC кодирует и отдаёт наружу.
     */
    private fun outOpen(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        val mode = j.optString("mode"); val codec = j.optString("codec", "mp3")
        if (mode !in VlcOutArgs.MODES) return Reply.done(c, id, cmd, "mode: http | rtp | icecast | file | renderer", "args")
        if (outs.size >= 2) return Reply.done(c, id, cmd, "2 outputs at most", "limit")
        val host = j.optString("host").trim(); val mount = j.optString("mount", "dsp").trim().ifEmpty { "dsp" }
        val user = j.optString("user", "source"); val pass = j.optString("pass")
        val port = j.optInt("port", 0)
        if ((mode == "rtp" || mode == "icecast") && !VlcOutArgs.hostOk(host)) return Reply.done(c, id, cmd, "host: a name or an address", "args")
        if ((mode == "http" || mode == "icecast") && !VlcOutArgs.mountOk(mount)) return Reply.done(c, id, cmd, "path: letters, digits . _ - /", "args")
        if (mode == "http" && port !in 1024..65535) return Reply.done(c, id, cmd, "port: 1024…65535", "args")
        if ((mode == "rtp" || mode == "icecast") && port !in 1..65535) return Reply.done(c, id, cmd, "port: 1…65535", "args")
        if (mode == "icecast" && !(VlcOutArgs.credOk(user) && VlcOutArgs.credOk(pass))) return Reply.done(c, id, cmd, "login / password: no spaces and none of @ : / ? # ' \" { } , = ;", "args")
        var path = ""
        if (mode == "file") {
            val name = j.optString("name").trim().ifEmpty { "dsp" }.let { if (it.contains('.')) it else it + "." + VlcOutArgs.ext(codec) }
            if (!VlcOutArgs.fileOk(name)) return Reply.done(c, id, cmd, "file name: letters, digits . _ -", "args")
            val dir = (ctx.getExternalFilesDir("vlcout") ?: ctx.filesDir).also { it.mkdirs() }
            path = java.io.File(dir, name).absolutePath
        }
        val ch = j.optInt("channels", 2).coerceIn(1, 2); val rate = j.optInt("rate", 48000).coerceIn(8000, 192000)
        val sout = VlcOutArgs.sout(mode, codec, j.optInt("bitrate", 128), j.optInt("outrate", 48000), ch, host, port, mount, user, pass, path, j.optInt("ttl", 4))
        if (mode != "renderer" && sout == null) return Reply.done(c, id, cmd, "this mode does not take the codec $codec (rtp: mp3 aac; icecast: mp3 opus)", "args")
        val inPort = freePort()
        val (url, opts) = VlcOutArgs.input(inPort, rate, ch, j.optInt("caching", 300), sout != null)
        val oid = ids2.incrementAndGet()
        pool.execute {
            var lib: LibVLC? = null
            try {
                lib = LibVLC(ctx.applicationContext, arrayListOf("--no-video"))
                val mp = MediaPlayer(lib)
                val media = Media(lib, android.net.Uri.parse(url))
                for (o in opts) media.addOption(o)
                if (sout != null) media.addOption(sout)
                mp.media = media; media.release()
                var devs = ""
                if (mode == "renderer") {
                    val (all, item) = discover(lib, 8000, j.optString("renderer"))
                    if (item == null) { mp.release(); lib.release(); return@execute Reply.done(c, id, cmd, "no such device (found: ${if (all.isEmpty()) "none — the same Wi-Fi network?" else all.joinToString("; ")})", "args") }
                    mp.setRenderer(item); devs = item.displayName
                }
                val o = Out(oid, lib, mp, c); outs[oid] = o
                mp.setEventListener(MediaPlayer.EventListener { ev -> onOutEvent(o, ev) })
                mp.play()
                Reply.done(c, id, cmd, null, extra = arrayOf("oid" to oid.toString(), "port" to inPort.toString(), "ips" to org.json.JSONArray(localIps()).toString(), "path" to Json.str(path), "device" to Json.str(devs)))
            } catch (e: Throwable) {
                try { lib?.release() } catch (x: Throwable) { }
                Reply.done(c, id, cmd, e.message ?: e.javaClass.simpleName)
            }
        }
    }
    private val ids2 = AtomicInteger(0)

    private fun onOutEvent(o: Out, ev: MediaPlayer.Event) {
        val state = when (ev.type) {
            MediaPlayer.Event.Opening -> "opening"
            MediaPlayer.Event.Buffering -> "buffering"
            MediaPlayer.Event.Playing -> "playing"
            MediaPlayer.Event.Stopped -> "stopped"
            MediaPlayer.Event.EncounteredError -> "error"
            else -> return
        }
        val j = JSONObject().put("src", "vlc").put("ev", "out").put("oid", o.oid).put("state", state)
        if (state == "error") j.put("msg", "libVLC cannot send there (the server, the login, the network, a missing plugin)")
        try { o.client.send(j.toString()) } catch (e: Throwable) { }
    }

    private fun outClose(oid: Int) {
        val o = outs.remove(oid) ?: return
        try { o.mp.setEventListener(null); o.mp.stop(); o.mp.release() } catch (e: Throwable) { }
        try { o.lib.release() } catch (e: Throwable) { }
    }

    private fun close(vid: Int) {
        val s = srcs.remove(vid) ?: return
        try { s.mp.setEventListener(null); s.mp.stop(); s.mp.release() } catch (e: Throwable) { }
        try { s.lib.release() } catch (e: Throwable) { }
    }

    /** Остановка службы. */
    fun close() { for (k in srcs.keys.toList()) close(k); for (k in outs.keys.toList()) outClose(k) }
}
