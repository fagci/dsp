package app.dsp.phone

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import org.libtorrent4j.AnnounceEntry
import org.libtorrent4j.Priority
import org.libtorrent4j.Sha1Hash
import org.libtorrent4j.SessionManager
import org.libtorrent4j.TcpEndpoint
import org.libtorrent4j.TorrentFlags
import org.libtorrent4j.TorrentHandle
import org.libtorrent4j.TorrentInfo
import org.libtorrent4j.TorrentStatus
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.net.URLEncoder
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** Чистая логика торрент-стриминга (без libtorrent и Android — проверяется на JVM). */
object TorrentArgs {
    val VIDEO = setOf("mp4", "m4v", "mkv", "webm", "avi", "mov", "ts", "m2ts", "mts", "mpg", "mpeg", "flv", "wmv", "ogv", "vob")
    const val READAHEAD = 24                    // кусков, которые просим заранее после читаемого места

    fun ext(name: String) = name.substringAfterLast('.', "").lowercase()
    fun isVideo(name: String) = ext(name) in VIDEO
    fun mime(name: String): String = when (ext(name)) {
        "mp4", "m4v" -> "video/mp4"; "webm" -> "video/webm"; "mkv" -> "video/x-matroska"; "ts", "m2ts", "mts" -> "video/mp2t"
        "avi" -> "video/x-msvideo"; "mov" -> "video/quicktime"; "ogv" -> "video/ogg"; "mpg", "mpeg", "vob" -> "video/mpeg"
        "flv" -> "video/x-flv"; "wmv" -> "video/x-ms-wmv"; else -> "application/octet-stream"
    }

    /** magnet:?xt=urn:btih:… или http(s)-адрес .torrent; "" — не годится. */
    fun kind(src: String): String {
        val s = src.trim()
        return when {
            Regex("^magnet:\\?.*xt=urn:btih:[0-9A-Za-z]{32,40}", RegexOption.IGNORE_CASE).containsMatchIn(s) -> "magnet"
            Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(s) -> "url"
            else -> ""
        }
    }

    /** Заголовок Range → [начало, конец] включительно для файла размера size; null — нельзя удовлетворить (416). Нет заголовка — весь файл. */
    fun range(h: String?, size: Long): LongArray? {
        if (size <= 0) return null
        if (h == null || h.isBlank()) return longArrayOf(0, size - 1)
        val m = Regex("^\\s*bytes\\s*=\\s*(\\d*)\\s*-\\s*(\\d*)\\s*(,.*)?$", RegexOption.IGNORE_CASE).find(h) ?: return longArrayOf(0, size - 1)   // чужую единицу игнорируем
        val a = m.groupValues[1]; val b = m.groupValues[2]
        if (a.isEmpty() && b.isEmpty()) return null
        if (a.isEmpty()) { val n = b.toLongOrNull() ?: return null; if (n <= 0) return null; return longArrayOf((size - n).coerceAtLeast(0), size - 1) }
        val s = a.toLongOrNull() ?: return null
        if (s >= size) return null
        val e = if (b.isEmpty()) size - 1 else (b.toLongOrNull() ?: return null).coerceAtMost(size - 1)
        return if (e < s) null else longArrayOf(s, e)
    }

    /** Номера кусков [первый, последний], на которые попадают байты [pos, pos+len) файла, лежащего в торренте со смещения fileOffset. */
    fun pieces(fileOffset: Long, pos: Long, len: Long, pieceLen: Int): IntArray {
        val a = (fileOffset + pos) / pieceLen
        val b = (fileOffset + pos + (if (len > 0) len else 1) - 1) / pieceLen
        return intArrayOf(a.toInt(), b.toInt())
    }

    /** Открытые трекеры, добавляемые к magnet, где их мало (у многих ссылок только DHT, а он в первые секунды пуст). */
    val TRACKERS = listOf(
        "udp://tracker.opentrackr.org:1337/announce", "udp://open.demonii.com:1337/announce", "udp://tracker.openbittorrent.com:6969/announce",
        "udp://explodie.org:6969/announce", "udp://tracker.torrent.eu.org:451/announce", "udp://open.stealth.si:80/announce",
        "udp://exodus.desync.com:6969/announce", "udp://tracker.tiny-vps.com:6969/announce",
    )

    /** magnet с трекерами: если в ссылке меньше трёх tr=, дописываются открытые (уже указанные не повторяются). */
    fun withTrackers(src: String): String {
        val have = Regex("[?&]tr=([^&]+)", RegexOption.IGNORE_CASE).findAll(src).map { java.net.URLDecoder.decode(it.groupValues[1], "UTF-8").lowercase() }.toSet()
        if (have.size >= 3) return src
        val sb = StringBuilder(src)
        for (t in TRACKERS) if (t.lowercase() !in have) sb.append("&tr=").append(URLEncoder.encode(t, "UTF-8"))
        return sb.toString()
    }

    /** Хэш из magnet (hex 40 или base32 32 символа → hex 40), "" — нет. */
    fun magnetHash(src: String): String {
        val m = Regex("xt=urn:btih:([0-9A-Za-z]{32,40})", RegexOption.IGNORE_CASE).find(src) ?: return ""
        val h = m.groupValues[1]
        if (h.length == 40) return h.lowercase()
        if (h.length != 32) return ""
        val al = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        var bits = 0; var acc = 0; val sb = StringBuilder()
        for (ch in h.uppercase()) {
            val v = al.indexOf(ch); if (v < 0) return ""
            acc = (acc shl 5) or v; bits += 5
            if (bits >= 8) { bits -= 8; sb.append(String.format("%02x", (acc shr bits) and 0xFF)) }
        }
        return sb.toString()
    }
}

/** Сессия libtorrent + файлы раздач: добавление, выбор файла, ожидание кусков. */
class TorrentCore(private val sm: SessionManager, val root: File) {
    class Item(val id: String, val ti: TorrentInfo, val dir: File) {
        @Volatile var th: TorrentHandle? = null
        @Volatile var file = -1
        @Volatile var lastUse = System.currentTimeMillis()
    }

    private val items = ConcurrentHashMap<String, Item>()
    fun get(id: String): Item? = items[id.lowercase()]
    fun all(): List<Item> = items.values.toList()

    fun add(ti: TorrentInfo, peers: List<TcpEndpoint>? = null): Item {
        val id = ti.infoHash().toHex().lowercase()
        items[id]?.let { return it }
        val dir = File(root, id); dir.mkdirs()
        val it = Item(id, ti, dir)
        items[id] = it
        // ни один файл не качается, пока плеер не выбрал свой (stream); порядок — по дедлайнам кусков
        sm.download(ti, dir, null, Priority.array(Priority.IGNORE, ti.numFiles()), peers, TorrentFlags.SEQUENTIAL_DOWNLOAD)
        val end = System.currentTimeMillis() + 10_000
        while (it.th == null && System.currentTimeMillis() < end) {
            val h = sm.find(ti.infoHash())
            if (h != null && h.isValid) it.th = h else Thread.sleep(50)
        }
        it.th?.let { h -> h.unsetFlags(TorrentFlags.AUTO_MANAGED); h.resume(); moreTrackers(h) }
        return it
    }

    /** У торрента мало трекеров — добавить открытые и сразу спросить трекеры и DHT. */
    private fun moreTrackers(h: TorrentHandle) {
        try {
            val have = h.trackers().map { t -> t.url().lowercase() }.toSet()
            if (have.size < 3) for (t in TorrentArgs.TRACKERS) if (t.lowercase() !in have) h.addTracker(AnnounceEntry(t))
            h.forceReannounce(); h.forceDHTAnnounce()
        } catch (e: Exception) { }
    }

    /**
     * Magnet: торрент добавляется в сессию сразу (в режиме UPLOAD_MODE — пока только метаданные) и остаётся в ней: соединения с пирами, найденными
     * при поиске метаданных, не теряются (раньше метаданные искал временный торрент, а потом файл заново искал пиров с нуля — «0 peers»).
     * Нет метаданных за timeoutSec — null, поиск продолжается в фоне, следующий вызов ждёт дальше.
     */
    fun addMagnet(src: String, timeoutSec: Int): Item? {
        val hash = TorrentArgs.magnetHash(src)
        if (hash.length != 40) throw IllegalArgumentException("not a magnet link with a btih hash")
        items[hash]?.let { return it }
        val sha = Sha1Hash.parseHex(hash)
        var h = sm.find(sha)?.takeIf { x -> x.isValid }
        if (h == null) {
            val dir = File(root, hash); dir.mkdirs()
            sm.download(TorrentArgs.withTrackers(src), dir, TorrentFlags.UPLOAD_MODE)
            val t0 = System.currentTimeMillis()
            while (h == null && System.currentTimeMillis() - t0 < 10_000) { h = sm.find(sha)?.takeIf { x -> x.isValid }; if (h == null) Thread.sleep(50) }
            if (h == null) throw IllegalStateException("the session did not accept the magnet")
            h.unsetFlags(TorrentFlags.AUTO_MANAGED); h.resume()
        }
        val end = System.currentTimeMillis() + timeoutSec * 1000L
        while (!h.status().hasMetadata() && System.currentTimeMillis() < end) Thread.sleep(250)
        if (!h.status().hasMetadata()) return null
        val ti = h.torrentFile() ?: return null
        val it = items.computeIfAbsent(hash) { _ -> Item(hash, ti, File(root, hash)) }
        it.th = h
        h.prioritizeFiles(Priority.array(Priority.IGNORE, ti.numFiles()))     // ни один файл не качается, пока плеер не выбрал свой
        h.unsetFlags(TorrentFlags.UPLOAD_MODE)
        moreTrackers(h)
        return it
    }

    /** Состояние трекеров одной строкой: «opentrackr: ok; explodie: timed out». */
    fun trackers(h: TorrentHandle): String = try {
        h.trackers().take(5).joinToString("; ") { a ->
            val host = a.url().substringAfter("://").substringBefore('/').substringBefore(':')
            val ep = a.endpoints().firstOrNull()?.infohashV1()
            host + ": " + (if (ep == null) "…" else if (ep.fails() > 0) ep.message().ifEmpty { "failed ×" + ep.fails() } else if (ep.updating()) "contacting…" else if (ep.isWorking()) "ok" else "…")
        }
    } catch (e: Exception) { "" }

    /** Файл номер idx — тот, что смотрят: он качается (остальные — нет). */
    fun select(it: Item, idx: Int) {
        val h = it.th ?: return
        for (i in 0 until it.ti.numFiles()) h.filePriority(i, if (i == idx) Priority.TOP_PRIORITY else Priority.IGNORE)
        it.file = idx
    }

    fun filePath(it: Item, idx: Int) = File(it.dir, it.ti.files().filePath(idx))

    /**
     * Ждёт, пока куски, покрывающие байты [pos, pos+len) файла idx, будут скачаны (просит их с дедлайнами и дальше на READAHEAD кусков).
     * false — за stallMs не пришло ни одного нового куска.
     */
    fun await(it: Item, idx: Int, pos: Long, len: Long, stallMs: Long = 45_000): Boolean {
        val h = it.th ?: return false
        it.lastUse = System.currentTimeMillis()
        val fs = it.ti.files()
        val pl = it.ti.pieceLength(); val np = it.ti.numPieces()
        val (a, b) = TorrentArgs.pieces(fs.fileOffset(idx), pos, len, pl).let { r -> r[0] to r[1] }
        var lastGood = System.currentTimeMillis()
        var have = -1
        while (true) {
            var cnt = 0
            for (p in a..b) if (h.havePiece(p)) cnt++
            if (cnt == b - a + 1) break
            if (cnt != have) { have = cnt; lastGood = System.currentTimeMillis() }
            if (System.currentTimeMillis() - lastGood > stallMs) return false
            for (p in a..b) if (!h.havePiece(p)) h.setPieceDeadline(p, ((p - a) * 200).coerceAtMost(4000))
            Thread.sleep(80)
        }
        val fileEnd = (fs.fileOffset(idx) + fs.fileSize(idx) - 1) / pl
        var k = 0
        for (p in (b + 1)..minOf(b + TorrentArgs.READAHEAD, minOf(np - 1L, fileEnd).toInt())) {
            if (!h.havePiece(p)) h.setPieceDeadline(p, 3000 + (k++) * 300)
        }
        return true
    }

    fun status(it: Item): TorrentStatus? = it.th?.takeIf { h -> h.isValid }?.status()

    fun remove(id: String, deleteFiles: Boolean) {
        val it = items.remove(id.lowercase()) ?: return
        try { it.th?.let { h -> if (h.isValid) sm.remove(h) } } catch (e: Exception) { }
        if (deleteFiles) it.dir.deleteRecursively()
    }
}

/** Локальный HTTP-сервер (только 127.0.0.1, токен в пути): отдаёт файл раздачи по Range, ожидая куски, — его читает <video> страницы или ExoPlayer. */
class TorrentHttp(private val core: TorrentCore, val token: String) {
    private var ss: ServerSocket? = null
    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "torrent-http").also { t -> t.isDaemon = true } }
    val port: Int get() = ss?.localPort ?: 0

    @Synchronized fun start(): Int {
        ss?.let { return it.localPort }
        val s = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1")); ss = s
        pool.execute { try { while (true) { val c = s.accept(); pool.execute { serve(c) } } } catch (e: Exception) { } }
        return s.localPort
    }

    @Synchronized fun stop() { try { ss?.close() } catch (e: Exception) { }; ss = null }

    fun url(id: String, file: Int, name: String): String =
        "http://127.0.0.1:$port/t/$token/$id/$file/" + URLEncoder.encode(name, "UTF-8").replace("+", "%20")

    private fun serve(s: Socket) {
        s.use {
            try {
                s.soTimeout = 30_000
                val inp = s.getInputStream().bufferedReader(Charsets.ISO_8859_1)
                val line = inp.readLine() ?: return
                var range: String? = null
                while (true) { val h = inp.readLine() ?: break; if (h.isEmpty()) break; if (h.startsWith("range:", true)) range = h.substring(6).trim() }
                val out = s.getOutputStream()
                fun send(code: Int, msg: String, extra: String = "", body: String = "") {
                    out.write(("HTTP/1.1 $code $msg\r\nConnection: close\r\nContent-Length: ${body.toByteArray().size}\r\n$extra\r\n$body").toByteArray()); out.flush()
                }
                val parts = line.split(' ')
                if (parts.size < 2 || (parts[0] != "GET" && parts[0] != "HEAD")) return send(405, "Method Not Allowed")
                val seg = parts[1].substringBefore('?').split('/').filter { x -> x.isNotEmpty() }
                if (seg.size < 4 || seg[0] != "t" || seg[1] != token) return send(404, "Not Found")
                val item = core.get(seg[2]) ?: return send(404, "Not Found")
                val idx = seg[3].toIntOrNull()?.takeIf { x -> x in 0 until item.ti.numFiles() } ?: return send(404, "Not Found")
                val fs = item.ti.files(); val size = fs.fileSize(idx); val name = fs.fileName(idx)
                if (item.file != idx) core.select(item, idx)
                val r = TorrentArgs.range(range, size) ?: return send(416, "Range Not Satisfiable", "Content-Range: bytes */$size\r\n")
                val partial = range != null && !(r[0] == 0L && r[1] == size - 1 && !range!!.contains("bytes"))
                val total = r[1] - r[0] + 1
                // первые куски — до заголовков: нет пиров → честный 503 (плеер повторит), а не пустое «200» и ошибка формата
                if (parts[0] == "GET" && !core.await(item, idx, r[0], minOf(128 * 1024L, total), 60_000)) return send(503, "Service Unavailable", "Retry-After: 3\r\n", "no pieces yet: no peers")
                val hdr = "HTTP/1.1 ${if (partial) "206 Partial Content" else "200 OK"}\r\nConnection: close\r\nAccept-Ranges: bytes\r\nContent-Type: ${TorrentArgs.mime(name)}\r\n" +
                    "Content-Length: $total\r\n" + (if (partial) "Content-Range: bytes ${r[0]}-${r[1]}/$size\r\n" else "") + "Access-Control-Allow-Origin: *\r\n\r\n"
                out.write(hdr.toByteArray(Charsets.ISO_8859_1)); out.flush()
                if (parts[0] == "HEAD") return
                var pos = r[0]; val end = r[1] + 1
                val buf = ByteArray(128 * 1024)
                var raf: RandomAccessFile? = null
                try {
                    while (pos < end) {
                        val n = minOf(buf.size.toLong(), end - pos).toInt()
                        if (!core.await(item, idx, pos, n.toLong())) return           // нет пиров / кусок не приходит — обрываем, плеер покажет ошибку
                        if (raf == null) { val f = core.filePath(item, idx); var w = 0; while (!f.exists() && w++ < 50) Thread.sleep(100); raf = RandomAccessFile(f, "r") }
                        raf.seek(pos); raf.readFully(buf, 0, n)
                        out.write(buf, 0, n)
                        pos += n
                    }
                    out.flush()
                } finally { try { raf?.close() } catch (e: Exception) { } }
            } catch (e: IOException) { /* плеер закрыл соединение */ } catch (e: Exception) { }
        }
    }
}

/**
 * Торренты для страницы (мост приложения): torrent.add {src: magnet: | http(s) .torrent | b64, timeout} → {id, name, files:[{i,name,path,size,video}]},
 * torrent.stream {id, file} → {url, size, name} (адрес для <video> / ExoPlayer: файл докачивается по мере просмотра, перемотка по Range),
 * torrent.status {id} → {state, progress, down, up, peers, seeds, done, total, file_done}, torrent.list, torrent.remove {id, keep}.
 * Только страница приложения. Файлы — в личной папке приложения, удаляются командой remove и при остановке службы.
 */
class TorrentHub(private val ctx: Context) {
    private var sm: SessionManager? = null
    private var core: TorrentCore? = null
    private var http: TorrentHttp? = null

    @Synchronized private fun up(): TorrentCore {
        core?.let { return it }
        val s = SessionManager(); s.start()
        val root = File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "torrents").also { it.mkdirs() }
        val c = TorrentCore(s, root); sm = s; core = c
        val tok = ByteArray(12).also { SecureRandom().nextBytes(it) }.joinToString("") { String.format("%02x", it) }
        http = TorrentHttp(c, tok).also { it.start() }
        return c
    }

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        if (!c.trusted) return Reply.done(c, id, cmd, "only the page of the DSP app may use it", "forbidden")
        try {
            when (cmd) {
                "torrent.add" -> {
                    val src = j.optString("src").trim()
                    val core = up()
                    val item = when {
                        j.has("b64") -> core.add(TorrentInfo.bdecode(Base64.getDecoder().decode(j.optString("b64"))))
                        TorrentArgs.kind(src) == "magnet" ->
                            core.addMagnet(src, j.optInt("timeout", 90).coerceIn(5, 300))
                                ?: return Reply.done(c, id, cmd, "no metadata yet (DHT nodes: ${sm?.dhtNodes() ?: 0}): nobody has answered in time. The search goes on in the background — press again to wait further; a torrent without seeds, a network that blocks UDP, or DHT is still starting", "timeout")
                        TorrentArgs.kind(src) == "url" -> core.add(TorrentInfo.bdecode(URL(src).openStream().use { it.readNBytes(8 * 1024 * 1024) }))
                        else -> return Reply.done(c, id, cmd, "src: a magnet: link, an http(s) address of a .torrent, or b64 of the file", "args")
                    }
                    val ti = item.ti
                    val it = item
                    val fs = ti.files(); val arr = JSONArray()
                    for (i in 0 until ti.numFiles()) arr.put(JSONObject().put("i", i).put("name", fs.fileName(i)).put("path", fs.filePath(i)).put("size", fs.fileSize(i)).put("video", TorrentArgs.isVideo(fs.fileName(i))))
                    Reply.done(c, id, cmd, null, extra = arrayOf("tid" to Json.str(it.id), "name" to Json.str(ti.name()), "files" to arr.toString(), "n" to ti.numFiles().toString()))
                }
                "torrent.stream" -> {
                    val core = up(); val it = core.get(j.optString("tid")) ?: return Reply.done(c, id, cmd, "no such torrent — torrent.add first", "args")
                    val idx = j.optInt("file", -1)
                    if (idx !in 0 until it.ti.numFiles()) return Reply.done(c, id, cmd, "file: 0…${it.ti.numFiles() - 1}", "args")
                    core.select(it, idx)
                    val fs = it.ti.files()
                    Reply.done(c, id, cmd, null, extra = arrayOf("url" to Json.str(http!!.url(it.id, idx, fs.fileName(idx))), "size" to fs.fileSize(idx).toString(), "name" to Json.str(fs.fileName(idx))))
                }
                "torrent.status" -> {
                    val core = up()
                    val it = core.get(j.optString("tid")) ?: run {
                        // метаданные ещё ищутся (torrent.add ждёт в другом потоке): состояние сессии и поиска — чтобы страница показывала ход дела
                        val hash = TorrentArgs.magnetHash("magnet:?xt=urn:btih:" + j.optString("hash"))
                        val h = if (hash.length == 40) sm?.find(org.libtorrent4j.Sha1Hash.parseHex(hash)) else null
                        val st = if (h != null && h.isValid) h.status() else null
                        return Reply.done(c, id, cmd, null, extra = arrayOf("state" to Json.str(st?.state()?.name?.lowercase() ?: "starting"), "peers" to (st?.numPeers() ?: 0).toString(),
                            "seeds" to (st?.numSeeds() ?: 0).toString(), "dht" to (sm?.dhtNodes() ?: 0L).toString(), "progress" to "0", "down" to "0",
                            "trk" to Json.str(if (h != null && h.isValid) core.trackers(h) else "")))
                    }
                    val st = core.status(it) ?: return Reply.done(c, id, cmd, null, extra = arrayOf("state" to Json.str("starting")))
                    val idx = it.file
                    val fdone = if (idx >= 0) (it.th?.fileProgress()?.getOrNull(idx) ?: 0L) else 0L
                    Reply.done(c, id, cmd, null, extra = arrayOf("state" to Json.str(st.state().name.lowercase()), "progress" to st.progress().toString(), "down" to st.downloadRate().toString(),
                        "up" to st.uploadRate().toString(), "peers" to st.numPeers().toString(), "seeds" to st.numSeeds().toString(), "done" to st.totalDone().toString(),
                        "total" to st.totalWanted().toString(), "file_done" to fdone.toString(), "dht" to (sm?.dhtNodes() ?: 0L).toString(),
                        "trk" to Json.str(it.th?.let { h -> core.trackers(h) } ?: "")))
                }
                "torrent.list" -> {
                    val core = up(); val arr = JSONArray()
                    for (it in core.all()) arr.put(JSONObject().put("tid", it.id).put("name", it.ti.name()).put("files", it.ti.numFiles()))
                    Reply.done(c, id, cmd, null, extra = arrayOf("items" to arr.toString(), "n" to arr.length().toString()))
                }
                "torrent.remove" -> { up().remove(j.optString("tid"), !j.optBoolean("keep", false)); Reply.done(c, id, cmd, null) }
                "torrent.stop" -> { close(); Reply.done(c, id, cmd, null) }
                else -> Reply.done(c, id, cmd, "unknown torrent command", "args")
            }
        } catch (e: Exception) {
            Reply.done(c, id, cmd, e.message ?: e.javaClass.simpleName)
        }
    }

    /** Остановка службы: сессия закрывается, скачанное — удаляется (кэш просмотра, не хранилище). */
    @Synchronized fun close() {
        http?.stop(); http = null
        val c = core; core = null
        try { c?.all()?.forEach { c.remove(it.id, true) } } catch (e: Exception) { }
        try { sm?.stop() } catch (e: Exception) { }
        sm = null
    }
}
