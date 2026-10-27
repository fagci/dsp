package app.dsp.phone

import android.util.Base64
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Локальный сервер: WebSocket с JSON-записями (протокол tools/termux/bridge.mjs) и камера MJPEG на одном порту.
 *   ws://host:port/?token=…            {"sub":["accel","gps",…],"hz":200} → записи (массивами по ~40 мс)
 *   http://host:port/camera.mjpg?cam=back&w=640&fps=10&q=70&rot=0&token=…
 *   http://host:port/snapshot.jpg?…    http://host:port/status
 */
class BridgeServer(
    private val cfg: Config,
    private val camera: CameraHub,
    private val hello: () -> String,
    private val status: () -> String,
    private val onSubs: () -> Unit,
) {
    class Client(val sock: Socket) {
        @Volatile var subs: Set<String> = emptySet()
        @Volatile var hz = 0
        @Volatile var wifiEvery = 0
        @Volatile var cellEvery = 0
        @Volatile var micHz = 0
        @Volatile var iface = ""
        @Volatile var filter = ""
        @Volatile var snap = 0
        @Volatile var dead = false
        val out = LinkedBlockingQueue<ByteArray>(4096)
        fun send(text: String) { out.offer(frame(text.toByteArray(Charsets.UTF_8))) }   // переполнена — медленный клиент теряет записи
    }

    /** Что просят клиенты: источники и их параметры (при нескольких клиентах — самые частые / первые заданные). */
    data class Want(
        val subs: Set<String>, val hz: Int, val wifiEvery: Int,
        val cellEvery: Int = 5, val micHz: Int = 16000, val iface: String = "any", val filter: String = "", val snap: Int = 256,
    )

    private class Req(val method: String, val path: String, val query: Map<String, String>, val headers: Map<String, String>)

    private val clients = CopyOnWriteArraySet<Client>()
    private val conns = CopyOnWriteArraySet<Socket>()
    private val pending = ArrayList<Pair<String, String>>()
    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "dsp-conn").also { it.isDaemon = true } }
    private var ss: ServerSocket? = null
    @Volatile private var running = false

    val clientCount: Int get() = clients.size
    val listening: Boolean get() = running
    val boundPort: Int get() = ss?.localPort ?: 0

    /** Возвращает текст ошибки или null. */
    fun start(): String? {
        stop()
        val s = ServerSocket()
        try {
            s.reuseAddress = true
            s.bind(InetSocketAddress(InetAddress.getByName(if (cfg.shareLan) "0.0.0.0" else "127.0.0.1"), cfg.port))
        } catch (e: Exception) {
            try { s.close() } catch (x: IOException) {}
            return "port ${cfg.port}: ${e.message}"
        }
        ss = s
        running = true
        pool.execute { acceptLoop(s) }
        pool.execute { while (running) { try { Thread.sleep(40) } catch (e: InterruptedException) { return@execute }; flush() } }
        return null
    }

    fun stop() {
        running = false
        try { ss?.close() } catch (e: IOException) {}
        ss = null
        for (s in conns) try { s.close() } catch (e: IOException) {}
        conns.clear(); clients.clear()
        synchronized(pending) { pending.clear() }
    }

    fun wanted(): Want {
        val subs = HashSet<String>()
        var hz = 0; var wifi = 0; var cell = 0; var mic = 0; var iface = ""; var filter = ""; var snap = 0
        for (c in clients) {
            subs.addAll(c.subs)
            if (c.hz > hz) hz = c.hz
            if (c.wifiEvery > 0 && (wifi == 0 || c.wifiEvery < wifi)) wifi = c.wifiEvery
            if (c.cellEvery > 0 && (cell == 0 || c.cellEvery < cell)) cell = c.cellEvery
            if (c.micHz > mic) mic = c.micHz
            if (iface.isEmpty()) iface = c.iface
            if (filter.isEmpty()) filter = c.filter
            if (c.snap > snap) snap = c.snap
        }
        return Want(subs, if (hz > 0) hz.coerceIn(1, 1000) else 20, if (wifi > 0) wifi else 10,
            if (cell > 0) cell else 5, if (mic > 0) mic else 16000, iface.ifEmpty { "any" }, filter, if (snap > 0) snap else 256)
    }

    /** Запись от источника; уйдёт подписанным клиентам в ближайшей пачке. */
    fun emit(src: String, json: String) {
        if (clients.none { src in it.subs }) return
        synchronized(pending) { pending.add(src to json) }
    }

    fun note(level: String, msg: String) { val j = Json.note(level, msg); for (c in clients) c.send(j) }

    private fun flush() {
        val batch = synchronized(pending) {
            if (pending.isEmpty()) return
            ArrayList(pending).also { pending.clear() }
        }
        for (c in clients) {
            val sb = StringBuilder()
            var n = 0
            for ((src, j) in batch) if (src in c.subs) { sb.append(if (n++ == 0) '[' else ','); sb.append(j) }
            if (n > 0) c.send(sb.append(']').toString())
        }
    }

    // ---------- соединения ----------

    private fun acceptLoop(s: ServerSocket) {
        while (running) {
            val sock = try { s.accept() } catch (e: IOException) { return }
            conns.add(sock)
            pool.execute {
                try { handle(sock) } catch (e: Exception) { /* обрыв клиента */ }
                finally { try { sock.close() } catch (e: IOException) {}; conns.remove(sock) }
            }
        }
    }

    private fun handle(sock: Socket) {
        sock.tcpNoDelay = true
        sock.soTimeout = 10_000
        val req = readRequest(BufferedInputStream(sock.getInputStream(), 4096)) ?: return
        val origin = req.headers["origin"]
        if (cfg.checkOrigin && !originOk(origin)) return respond(sock, 403, "Forbidden", "text/plain", "origin not allowed — add it in the DSP app settings or turn the Origin check off", null)
        if (req.method == "OPTIONS") {
            val h = "Access-Control-Allow-Methods: GET, OPTIONS\r\nAccess-Control-Allow-Headers: " +
                (req.headers["access-control-request-headers"] ?: "authorization, content-type") + "\r\nAccess-Control-Max-Age: 600\r\n"
            return respond(sock, 204, "No Content", "text/plain", "", origin, h)
        }
        val remote = !sock.inetAddress.isLoopbackAddress
        val token = cfg.token
        if (token.isNotEmpty() && (remote || cfg.strict) && !MessageDigest.isEqual((req.query["token"] ?: "").toByteArray(), token.toByteArray()))
            return respond(sock, 401, "Unauthorized", "text/plain", "token required", origin)
        when {
            req.headers["upgrade"]?.equals("websocket", true) == true -> serveWs(sock, req)
            req.path == "/camera.mjpg" || req.path == "/camera" || req.path == "/stream" -> serveMjpeg(sock, req, origin)
            req.path == "/snapshot.jpg" || req.path == "/snapshot" -> serveSnapshot(sock, req, origin)
            req.path == "/" || req.path == "/status" -> respond(sock, 200, "OK", "text/plain; charset=utf-8", status(), origin)
            else -> respond(sock, 404, "Not Found", "text/plain", "not found", origin)
        }
    }

    private fun originOk(origin: String?): Boolean {
        if (origin == null) return true                      // не браузер (websocat, curl)
        val allowed = cfg.allowedOrigins()
        if ("*" in allowed || origin in allowed) return true
        val host = try { URI(origin).host } catch (e: Exception) { null } ?: return false
        return host == "localhost" || host == "[::1]" || Regex("127\\.\\d+\\.\\d+\\.\\d+").matches(host)
    }

    private fun readLine(inp: InputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val b = inp.read()
            if (b < 0) return if (sb.isEmpty()) null else sb.toString()
            if (b == '\n'.code) { if (sb.endsWith('\r')) sb.setLength(sb.length - 1); return sb.toString() }
            if (sb.length > 8192) return null
            sb.append(b.toChar())
        }
    }

    private fun readRequest(inp: InputStream): Req? {
        val first = readLine(inp)?.split(' ') ?: return null
        if (first.size < 2) return null
        val headers = HashMap<String, String>()
        for (i in 0 until 64) {
            val l = readLine(inp) ?: return null
            if (l.isEmpty()) break
            val k = l.indexOf(':')
            if (k > 0) headers[l.substring(0, k).trim().lowercase()] = l.substring(k + 1).trim()
        }
        val u = first[1]
        val q = u.indexOf('?')
        val query = HashMap<String, String>()
        if (q >= 0) for (kv in u.substring(q + 1).split('&')) {
            if (kv.isEmpty()) continue
            val e = kv.indexOf('=')
            try {
                if (e < 0) query[URLDecoder.decode(kv, "UTF-8")] = ""
                else query[URLDecoder.decode(kv.substring(0, e), "UTF-8")] = URLDecoder.decode(kv.substring(e + 1), "UTF-8")
            } catch (x: IllegalArgumentException) {}
        }
        return Req(first[0].uppercase(), if (q >= 0) u.substring(0, q) else u, query, headers)
    }

    private fun cors(origin: String?) =
        (if (origin != null) "Access-Control-Allow-Origin: $origin\r\nVary: Origin\r\nAccess-Control-Allow-Private-Network: true\r\n" else "") +
            "Cross-Origin-Resource-Policy: cross-origin\r\n"

    private fun respond(sock: Socket, code: Int, reason: String, ctype: String, body: String, origin: String?, extra: String = "") =
        respondBytes(sock, code, reason, ctype, body.toByteArray(Charsets.UTF_8), origin, extra)

    private fun respondBytes(sock: Socket, code: Int, reason: String, ctype: String, body: ByteArray, origin: String?, extra: String = "") {
        val h = "HTTP/1.1 $code $reason\r\n" + cors(origin) + extra + "Content-Type: $ctype\r\nContent-Length: ${body.size}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        val os = sock.getOutputStream()
        os.write(h.toByteArray()); os.write(body); os.flush()
    }

    // ---------- камера ----------

    private fun camCfg(q: Map<String, String>): CameraHub.Cfg {
        fun int(k: String, d: Int, lo: Int, hi: Int) = (q[k]?.toIntOrNull() ?: d).coerceIn(lo, hi)
        val facing = if (q["cam"] == "front") android.hardware.camera2.CameraCharacteristics.LENS_FACING_FRONT
            else android.hardware.camera2.CameraCharacteristics.LENS_FACING_BACK
        val rot = (int("rot", 0, 0, 359) / 90 * 90)
        return CameraHub.Cfg(facing, int("w", 640, 16, 8192), int("fps", 10, 1, 120), int("q", 70, 1, 100), rot)
    }

    private fun serveMjpeg(sock: Socket, req: Req, origin: String?) {
        val lease = camera.acquire(camCfg(req.query))
            ?: return respond(sock, 503, "Service Unavailable", "text/plain", camera.error.ifEmpty { "camera unavailable" }, origin)
        try {
            sock.soTimeout = 0
            val os = BufferedOutputStream(sock.getOutputStream(), 65536)
            os.write(("HTTP/1.1 200 OK\r\n" + cors(origin) + "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n" +
                "Cache-Control: no-store\r\nConnection: close\r\n\r\n").toByteArray())
            var last = 0L
            while (running && camera.valid(lease)) {
                val (jpeg, seq) = camera.next(lease, last, 5000) ?: continue
                last = seq
                os.write("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.size}\r\n\r\n".toByteArray())
                os.write(jpeg); os.write("\r\n".toByteArray()); os.flush()
            }
        } finally { camera.release() }
    }

    private fun serveSnapshot(sock: Socket, req: Req, origin: String?) {
        val lease = camera.acquire(camCfg(req.query))
            ?: return respond(sock, 503, "Service Unavailable", "text/plain", camera.error.ifEmpty { "camera unavailable" }, origin)
        try {
            val f = camera.next(lease, 0, 6000)
            if (f == null) respond(sock, 504, "Gateway Timeout", "text/plain", camera.error.ifEmpty { "no frame from the camera" }, origin)
            else respondBytes(sock, 200, "OK", "image/jpeg", f.first, origin)
        } finally { camera.release() }
    }

    // ---------- WebSocket ----------

    private fun serveWs(sock: Socket, req: Req) {
        val key = req.headers["sec-websocket-key"]
            ?: return respond(sock, 400, "Bad Request", "text/plain", "no Sec-WebSocket-Key", null)
        val accept = Base64.encodeToString(MessageDigest.getInstance("SHA-1")
            .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()), Base64.NO_WRAP)
        val os = sock.getOutputStream()
        os.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n").toByteArray())
        os.flush()
        sock.soTimeout = 0
        val c = Client(sock)
        c.subs = (req.query["sources"] ?: "").split(',').map { it.trim() }.filter { it.isNotEmpty() }.toSet()
        c.hz = req.query["hz"]?.toIntOrNull() ?: 0
        clients.add(c)
        pool.execute { writeLoop(c) }
        c.send(hello())
        onSubs()
        try { readLoop(c) } finally {
            c.dead = true; clients.remove(c)
            try { sock.close() } catch (e: IOException) {}
            onSubs()
        }
    }

    private fun writeLoop(c: Client) {
        try {
            val os = BufferedOutputStream(c.sock.getOutputStream(), 32768)
            val more = ArrayList<ByteArray>()
            while (!c.dead && running) {
                val first = c.out.poll(1, TimeUnit.SECONDS) ?: continue
                os.write(first)
                more.clear(); c.out.drainTo(more)
                for (b in more) os.write(b)
                os.flush()
            }
        } catch (e: Exception) { /* сокет закрыт */ }
        finally { c.dead = true; try { c.sock.close() } catch (e: IOException) {} }
    }

    private fun readLoop(c: Client) {
        val inp = DataInputStream(BufferedInputStream(c.sock.getInputStream()))
        val msg = ByteArrayOutputStream()
        while (!c.dead && running) {
            val b0 = inp.read()
            if (b0 < 0) return
            val b1 = inp.readUnsignedByte()
            val fin = (b0 and 0x80) != 0
            val op = b0 and 15
            var len = (b1 and 127).toLong()
            if (len == 126L) len = inp.readUnsignedShort().toLong() else if (len == 127L) len = inp.readLong()
            if (len < 0 || len > (1 shl 20)) return
            val mask = if ((b1 and 0x80) != 0) ByteArray(4).also { inp.readFully(it) } else null
            val pl = ByteArray(len.toInt())
            inp.readFully(pl)
            if (mask != null) for (i in pl.indices) pl[i] = (pl[i].toInt() xor mask[i and 3].toInt()).toByte()
            when (op) {
                8 -> return
                9 -> c.out.offer(frame(pl, 10))
                0, 1, 2 -> { msg.write(pl); if (fin) { onMessage(c, msg.toString("UTF-8")); msg.reset() } }
            }
        }
    }

    private fun onMessage(c: Client, text: String) {
        val j = try { JSONObject(text) } catch (e: Exception) { return }
        val sub = j.optJSONArray("sub") ?: return
        c.subs = (0 until sub.length()).map { sub.optString(it) }.filter { it.isNotEmpty() }.toSet()
        c.hz = j.optInt("hz", 0)
        c.wifiEvery = j.optInt("wifiEvery", 0)
        c.cellEvery = j.optInt("cellEvery", 0)
        c.micHz = j.optInt("micHz", 0)
        c.iface = j.optString("iface", "")
        c.filter = j.optString("filter", "")
        c.snap = j.optInt("snap", 0)
        c.send(Json.note("info", "sub: " + c.subs.joinToString(",")))
        onSubs()
    }

    companion object {
        fun frame(payload: ByteArray, op: Int = 1): ByteArray {
            val n = payload.size
            val h = when {
                n < 126 -> byteArrayOf((0x80 or op).toByte(), n.toByte())
                n < 65536 -> byteArrayOf((0x80 or op).toByte(), 126, (n shr 8).toByte(), n.toByte())
                else -> byteArrayOf((0x80 or op).toByte(), 127, 0, 0, 0, 0, (n shr 24).toByte(), (n shr 16).toByte(), (n shr 8).toByte(), n.toByte())
            }
            return h + payload
        }
    }
}
