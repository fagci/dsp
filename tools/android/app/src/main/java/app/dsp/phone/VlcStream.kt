package app.dsp.phone

import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.ExecutorService

/**
 * Чистая логика vlc.stream.*: libVLC открывает любой адрес и «переупаковывает» его в HLS (mpegts-сегменты в кэше приложения), а страница играет
 * это штатным `<video>` (+ hls.js). Видео и звук, которые браузер знает (H.264, AAC / MP3), идут как есть (ремукс — почти без нагрузки),
 * остальное (DivX, MPEG-2, VP9, AC3, DTS, FLAC…) перекодируется в H.264 / AAC. Проверяется на JVM, без libVLC.
 */
object VlcStreamArgs {
    const val INDEX = "live.m3u8"
    const val SEG = "seg-########.ts"
    private val NAME = Regex("[A-Za-z0-9_.-]{1,64}")
    private val DIR = Regex("[A-Za-z0-9_./-]{1,300}")

    /** Видео, которое браузер играет из mpegts без перекодирования (fourcc libVLC); HEVC — только если страница сказала, что её <video> его декодирует (обычно аппаратно). */
    fun copyV(codec: String, hevc: Boolean = false): Boolean {
        val c = codec.lowercase().trim()
        return c in setOf("h264", "avc1") || (hevc && c in setOf("hevc", "hvc1", "hev1", "h265"))
    }
    /** Звук, который браузер играет из mpegts без перекодирования: AAC (mp4a), MPEG audio (mpga), MP3. */
    fun copyA(codec: String) = codec.lowercase().trim() in setOf("mp4a", "mpga", "mp3")

    /** Что перекодировать: mode — auto (по кодекам) | remux (ничего) | transcode (всё); пустой кодек — неизвестно (auto: перекодировать). */
    class Plan(val video: Boolean, val audio: Boolean, val hasVideo: Boolean, val hasAudio: Boolean)
    fun plan(mode: String, vcodec: String, acodec: String, burnSubs: Boolean, deint: Boolean, hevc: Boolean = false): Plan {
        val hasV = vcodec != "-"; val hasA = acodec != "-"
        val v = hasV && when (mode) { "remux" -> false; "transcode" -> true; else -> !copyV(vcodec, hevc) || burnSubs || deint }
        val a = hasA && when (mode) { "remux" -> false; "transcode" -> true; else -> !copyA(acodec) }
        return Plan(v, a, hasV, hasA)
    }

    /** Сегменты и список — в `dir` (путь приложения; допустимы только безопасные символы, иначе строка sout развалится). */
    fun dirOk(dir: String) = DIR.matches(dir) && !dir.contains("..")
    fun nameOk(n: String) = NAME.matches(n) && !n.startsWith(".")

    fun sout(dir: String, p: Plan, vkbps: Int, width: Int, abr: Int, burnSubs: Boolean, deint: Boolean, seg: Int, num: Int): String? {
        if (!dirOk(dir)) return null
        val tc = ArrayList<String>()
        if (p.hasVideo && p.video) {
            tc += "vcodec=h264"; tc += "vb=${vkbps.coerceIn(200, 20_000)}"
            if (width > 0) tc += "width=${width.coerceIn(160, 3840)}"
            if (deint) tc += "vfilter=deinterlace"
            tc += "venc=x264{preset=veryfast,tune=zerolatency}"
            if (burnSubs) tc += "soverlay"
        }
        if (p.hasAudio && p.audio) { tc += "acodec=mp4a"; tc += "ab=${abr.coerceIn(32, 512)}"; tc += "channels=2"; tc += "samplerate=48000" }
        val head = if (tc.isEmpty()) "#" else "#transcode{" + tc.joinToString(",") + "}:"
        return ":sout=${head}std{access=livehttp{seglen=${seg.coerceIn(1, 10)},delsegs=true,numsegs=${num.coerceIn(5, 200)},index=$dir/$INDEX,index-url=$SEG},mux=ts{use-key-frames},dst=$dir/$SEG}"
    }

    /** Параметры входа: старт (мс), дорожки (номер среди дорожек своего типа, -1 — по умолчанию), задержка звука (мс), субтитры. */
    fun options(startMs: Long, audio: Int, sub: Int, audioDelayMs: Int, cachingMs: Int, rate: Float): List<String> {
        val o = ArrayList<String>()
        if (startMs > 0) o += ":start-time=${startMs / 1000.0}"
        if (audio >= 0) o += ":audio-track=$audio"
        if (sub >= 0) o += ":sub-track=$sub" else o += ":no-spu"
        if (audioDelayMs != 0) o += ":audio-desync=${audioDelayMs.coerceIn(-5000, 5000)}"
        if (rate > 0f && rate != 1f) o += ":rate=${rate.coerceIn(0.5f, 2f)}"
        o += ":sout-keep"; o += ":network-caching=${cachingMs.coerceIn(100, 10_000)}"
        return o
    }

    fun contentType(name: String) = when {
        name.endsWith(".m3u8") -> "application/vnd.apple.mpegurl"
        name.endsWith(".ts") -> "video/mp2t"
        name.endsWith(".vtt") -> "text/vtt"
        else -> null
    }

    /** «GET /токен/имя HTTP/1.1» → метод и имя файла (null — чужой токен или имя вне списка). */
    fun route(requestLine: String, token: String): Pair<String, String>? {
        val l = requestLine.split(' ')
        if (l.size < 3 || !l[2].startsWith("HTTP/")) return null
        val path = l[1].substringBefore('?')
        val pre = "/$token/"
        if (!path.startsWith(pre)) return if (l[0] == "OPTIONS") l[0] to "" else null
        val name = path.removePrefix(pre)
        return if (nameOk(name) && contentType(name) != null) l[0] to name else null
    }
}

/**
 * Статический сервер каталога HLS только на 127.0.0.1, путь со случайным токеном, заголовки CORS (libVLC их не ставит). Список ждёт, пока libVLC
 * его создаст (до 25 с): страница может прийти раньше первого сегмента.
 */
class HlsRelay(private val dir: File, private val pool: ExecutorService) {
    private val server = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
    val token = ByteArray(12).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    val port: Int get() = server.localPort
    val url: String get() = "http://127.0.0.1:$port/$token/${VlcStreamArgs.INDEX}"

    fun start() {
        pool.execute {
            while (!server.isClosed) {
                val c = try { server.accept() } catch (e: Exception) { break }
                pool.execute { try { handle(c) } catch (e: Exception) { } finally { try { c.close() } catch (e: Exception) { } } }
            }
        }
    }
    fun close() { try { server.close() } catch (e: Exception) { } }

    private fun head(s: Socket): String {
        val i = s.getInputStream(); val b = StringBuilder()
        while (b.length < 8192) { val x = i.read(); if (x < 0) break; b.append(x.toChar()); if (b.endsWith("\r\n\r\n")) break }
        return b.toString()
    }

    private fun handle(c: Socket) {
        c.soTimeout = 15_000
        val o = c.getOutputStream()
        val cors = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\n"
        val rq = VlcStreamArgs.route(head(c).lineSequence().firstOrNull() ?: "", token) ?: run { o.write("HTTP/1.1 404 Not Found\r\n${cors}Content-Length: 0\r\n\r\n".toByteArray()); return }
        if (rq.first == "OPTIONS") { o.write("HTTP/1.1 204 No Content\r\n${cors}Content-Length: 0\r\n\r\n".toByteArray()); return }
        if (rq.first != "GET") { o.write("HTTP/1.1 405 Method Not Allowed\r\n${cors}Content-Length: 0\r\n\r\n".toByteArray()); return }
        val f = File(dir, rq.second)
        val t0 = System.currentTimeMillis()
        while ((!f.isFile || f.length() == 0L) && System.currentTimeMillis() - t0 < 25_000 && !server.isClosed) Thread.sleep(200)
        if (!f.isFile) { o.write("HTTP/1.1 404 Not Found\r\n${cors}Content-Length: 0\r\n\r\n".toByteArray()); return }
        val body = try { f.readBytes() } catch (e: Exception) { o.write("HTTP/1.1 404 Not Found\r\n${cors}Content-Length: 0\r\n\r\n".toByteArray()); return }
        o.write("HTTP/1.1 200 OK\r\nContent-Type: ${VlcStreamArgs.contentType(rq.second)}\r\n${cors}Cache-Control: no-store\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray())
        o.write(body); o.flush()
    }
}
