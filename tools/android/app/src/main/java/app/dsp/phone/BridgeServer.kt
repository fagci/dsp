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
 * Локальный сервер: WebSocket с JSON-записями (протокол tools/termux/bridge.mjs).
 *   ws://host:port/?token=…            {"sub":["accel","gps",…],"hz":200} → записи (массивами по ~40 мс)
 *   http://host:port/status
 */
class BridgeServer(
    private val cfg: Config,
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
        @Volatile var micSrc = ""
        @Volatile var micDev = ""
        @Volatile var micLow = false
        @Volatile var iface = ""
        @Volatile var filter = ""
        @Volatile var snap = 0
        @Volatile var bleOpts = ""
        /** Может ли клиент пользоваться действиями (сеть, Bluetooth-соединения, речь, автоматизация): страница приложения или включено «любая страница» в Settings. */
        @Volatile var power = false
        /** Страница самого приложения (знает ключ UsbKey): ей можно читать SMS и контакты и слать SMS, чужим сайтам — нет. */
        @Volatile var trusted = false
        @Volatile var dead = false
        /** Кто подключён: адрес, страница (Origin) и подписки — для списка клиентов моста. */
        @Volatile var origin = ""
        val since = System.currentTimeMillis()
        val out = LinkedBlockingQueue<ByteArray>(4096)
        fun send(text: String) { out.offer(frame(text.toByteArray(Charsets.UTF_8))) }   // переполнена — медленный клиент теряет записи
    }

    /** Что просят клиенты: источники и их параметры (при нескольких клиентах — самые частые / первые заданные). */
    data class Want(
        val subs: Set<String>, val hz: Int, val wifiEvery: Int,
        val cellEvery: Int = 5, val micHz: Int = 16000, val micSrc: String = "", val micDev: String = "", val micLow: Boolean = false, val iface: String = "any", val filter: String = "", val snap: Int = 256, val bleOpts: String = "",
    )

    private class Req(val method: String, val path: String, val query: Map<String, String>, val headers: Map<String, String>)

    /** Команды клиента: {"cmd":"notify|torch|sms.send|…","id":N,…}; ответ — запись {src:'cmd', id, ok, …} только этому клиенту. */
    @Volatile var onCommand: ((Client, JSONObject) -> Unit)? = null

    /** USB-бэкенд для /usb; без него путь отвечает 404. */
    @Volatile var usb: UsbBackend? = null

    private val clients = CopyOnWriteArraySet<Client>()

    /** Внутренний получатель записей (запись на диск, RecHub): подписки и частоты учитываются в wanted() как у клиента, а записи идут в on, не в сокет. */
    class Sink(val subs: Set<String>, val hz: Int = 0, val wifiEvery: Int = 0, val cellEvery: Int = 0, val on: (List<String>) -> Unit,
              val micHz: Int = 0, val micSrc: String = "", val micDev: String = "")
    private val sinks = CopyOnWriteArraySet<Sink>()
    fun addSink(s: Sink) { sinks.add(s); onSubs() }
    fun removeSink(s: Sink) { if (sinks.remove(s)) onSubs() }
    val sinkCount: Int get() = sinks.size
    private val conns = CopyOnWriteArraySet<Socket>()
    private val pending = ArrayList<Pair<String, String>>()
    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "dsp-conn").also { it.isDaemon = true } }
    private var ss: ServerSocket? = null
    @Volatile private var running = false

    /** TLS (wss:// и https://): порт на единицу выше обычного (с портом 0 — любой свободный); поднимается, когда есть контекст с сертификатом. */
    @Volatile private var tlsCtx: javax.net.ssl.SSLContext? = null
    private var tlsSs: ServerSocket? = null
    val tlsPort: Int get() = tlsSs?.localPort ?: 0

    /** Меняет сертификат (null — выключает TLS); текст ошибки или null. Обычный порт не трогает. */
    @Synchronized
    fun setTls(ctx: javax.net.ssl.SSLContext?): String? {
        try { tlsSs?.close() } catch (e: IOException) {}
        tlsSs = null; tlsCtx = ctx
        return if (ctx != null && running) startTls() else null
    }

    @Synchronized
    private fun startTls(): String? {
        val c = tlsCtx ?: return null
        val s = c.serverSocketFactory.createServerSocket()
        try {
            s.reuseAddress = true
            s.bind(InetSocketAddress(InetAddress.getByName(if (cfg.shareLan) "0.0.0.0" else "127.0.0.1"), if (cfg.port == 0) 0 else cfg.port + 1))
        } catch (e: Exception) {
            try { s.close() } catch (x: IOException) {}
            return "TLS port ${cfg.port + 1}: ${e.message}"
        }
        tlsSs = s
        pool.execute { acceptLoop(s) }
        return null
    }

    val clientCount: Int get() = clients.size
    /** Сколько записей ждёт отправки у самого медленного клиента — по нему тяжёлые источники (кадры экрана) пропускают кадры, а не копят их в памяти. */
    fun backlog(): Int = clients.maxOfOrNull { it.out.size } ?: 0
    /** Строки «адрес · страница · подписки» по одной на клиента. */
    fun clientLines(): List<String> = clients.map { c ->
        val a = c.sock.inetAddress?.hostAddress?.removePrefix("::ffff:") ?: "?"
        listOf(a, whoOf(c), c.subs.sorted().joinToString(",")).filter { it.isNotEmpty() }.joinToString(" · ")
    }
    /** Кто подключён: страница самого приложения (её виртуальный адрес appassets.androidplatform.net — не сетевой хост) — «DSP app»; иначе адрес страницы. */
    private fun whoOf(c: Client): String {
        val o = c.origin.trimEnd('/')
        return if (o == Config.APP_ORIGIN) "DSP app" else o.removePrefix("https://").removePrefix("http://").ifEmpty { if (c.trusted) "DSP app" else "" }
    }
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
        startTls()
        // ждём записей, а не опрашиваем каждые 40 мс: без подписчиков поток спит и не будит процессор
        pool.execute {
            while (running) {
                try {
                    synchronized(pending) { while (running && pending.isEmpty()) (pending as java.lang.Object).wait(30_000) }
                    Thread.sleep(if (urgentMic()) 8 else 40)        // накопить пачку; микрофон в режиме низкой задержки — почти сразу
                } catch (e: InterruptedException) { return@execute }
                flush()
            }
        }
        return null
    }

    fun stop() {
        running = false
        try { ss?.close() } catch (e: IOException) {}
        ss = null
        try { tlsSs?.close() } catch (e: IOException) {}
        tlsSs = null
        for (s in conns) try { s.close() } catch (e: IOException) {}
        conns.clear(); clients.clear()
        synchronized(pending) { pending.clear(); (pending as java.lang.Object).notifyAll() }
    }

    fun wanted(): Want {
        val subs = HashSet<String>()
        var msrc = ""; var mdev = ""; var mlow = false
        var hz = 0; var wifi = 0; var cell = 0; var mic = 0; var iface = ""; var filter = ""; var snap = 0; var ble = ""
        for (k in sinks) {
            subs.addAll(k.subs)
            if (k.hz > hz) hz = k.hz
            if (k.wifiEvery > 0 && (wifi == 0 || k.wifiEvery < wifi)) wifi = k.wifiEvery
            if (k.cellEvery > 0 && (cell == 0 || k.cellEvery < cell)) cell = k.cellEvery
            if (k.micHz > mic) mic = k.micHz
            if (msrc.isEmpty()) msrc = k.micSrc                       // получатель записи (звонок) главнее страницы: его источник берётся первым
            if (mdev.isEmpty()) mdev = k.micDev
        }
        for (c in clients) {
            subs.addAll(c.subs)
            if (c.hz > hz) hz = c.hz
            if (c.wifiEvery > 0 && (wifi == 0 || c.wifiEvery < wifi)) wifi = c.wifiEvery
            if (c.cellEvery > 0 && (cell == 0 || c.cellEvery < cell)) cell = c.cellEvery
            if (c.micHz > mic) mic = c.micHz
            if (msrc.isEmpty()) msrc = c.micSrc
            if (mdev.isEmpty()) mdev = c.micDev
            if (c.micLow) mlow = true
            if (iface.isEmpty()) iface = c.iface
            if (filter.isEmpty()) filter = c.filter
            if (c.snap > snap) snap = c.snap
            if (ble.isEmpty()) ble = c.bleOpts
        }
        return Want(subs, if (hz > 0) hz.coerceIn(1, 1000) else 20, if (wifi > 0) wifi else 10,
            if (cell > 0) cell else 5, if (mic > 0) mic else 16000, msrc, mdev, mlow, iface.ifEmpty { "any" }, filter, if (snap > 0) snap else 256, ble)
    }

    /** Запись от источника; уйдёт подписанным клиентам в ближайшей пачке. */
    fun emit(src: String, json: String) {
        if (clients.none { src in it.subs } && sinks.none { src in it.subs }) return
        synchronized(pending) { pending.add(src to json); (pending as java.lang.Object).notify() }
    }

    fun note(level: String, msg: String) { val j = Json.note(level, msg); for (c in clients) c.send(j) }

    /** Есть клиент с микрофоном в режиме низкой задержки и запись mic уже ждёт отправки. */
    private fun urgentMic(): Boolean = clients.any { it.micLow && "mic" in it.subs } && synchronized(pending) { pending.any { it.first == "mic" } }

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
        for (k in sinks) {
            val l = batch.filter { it.first in k.subs }.map { it.second }
            if (l.isNotEmpty()) try { k.on(l) } catch (e: Exception) { }
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
            req.path == "/usb" -> serveUsb(sock, req, remote, origin)
            req.headers["upgrade"]?.equals("websocket", true) == true -> serveWs(sock, req)
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

    // ---------- WebSocket ----------

    /** Ответ 101 на запрос WebSocket; false — запрос без ключа (ответ 400 уже отправлен). */
    private fun handshake(sock: Socket, req: Req): Boolean {
        val key = req.headers["sec-websocket-key"]
        if (key == null) { respond(sock, 400, "Bad Request", "text/plain", "no Sec-WebSocket-Key", null); return false }
        val accept = Base64.encodeToString(MessageDigest.getInstance("SHA-1")
            .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()), Base64.NO_WRAP)
        val os = sock.getOutputStream()
        os.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n").toByteArray())
        os.flush()
        sock.soTimeout = 0
        return true
    }

    /**
     * USB телефона для страницы приложения. Только с этого телефона и только с ключом (UsbKey), который знает лишь страница
     * приложения: через /usb идёт чтение и запись в подключённые устройства, открывать его всем сайтам нельзя.
     */
    private fun serveUsb(sock: Socket, req: Req, remote: Boolean, origin: String?) {
        val b = usb
        val k = req.query["k"] ?: ""
        if (b == null) return respond(sock, 404, "Not Found", "text/plain", "usb is not available", origin)
        if (remote || !MessageDigest.isEqual(k.toByteArray(), UsbKey.value.toByteArray()))
            return respond(sock, 403, "Forbidden", "text/plain", "usb: only the DSP app may use it", origin)
        if (req.headers["upgrade"]?.equals("websocket", true) != true) return respond(sock, 400, "Bad Request", "text/plain", "websocket only", origin)
        if (!handshake(sock, req)) return
        UsbSession(sock, b).run()
    }

    private fun serveWs(sock: Socket, req: Req) {
        if (!handshake(sock, req)) return
        val c = Client(sock)
        c.trusted = sock.inetAddress.isLoopbackAddress && MessageDigest.isEqual((req.query["k"] ?: "").toByteArray(), UsbKey.value.toByteArray())
        c.origin = req.headers["origin"] ?: ""
        c.power = c.trusted || cfg.openCmds
        c.subs = allowed(c, (req.query["sources"] ?: "").split(',').map { it.trim() }.filter { it.isNotEmpty() }.toSet())
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

    /** Источники, которые клиенту можно: чувствительные (SMS) — только странице приложения. */
    private fun allowed(c: Client, want: Set<String>): Set<String> {
        val ok = want.filter { (it !in SENSITIVE || c.trusted) && (it !in POWER_SRC || c.power) }.toSet()
        if (ok.size != want.size) c.send(Json.note("error", "${(want - ok).joinToString(",")}: not allowed for this page — only the page of the DSP app (or any page, if allowed in the app Settings) may use it"))
        return ok
    }

    private fun onMessage(c: Client, text: String) {
        val j = try { JSONObject(text) } catch (e: Exception) { return }
        if (j.has("cmd")) { onCommand?.invoke(c, j); return }
        val sub = j.optJSONArray("sub") ?: return
        c.subs = allowed(c, (0 until sub.length()).map { sub.optString(it) }.filter { it.isNotEmpty() }.toSet())
        c.hz = j.optInt("hz", 0)
        c.wifiEvery = j.optInt("wifiEvery", 0)
        c.cellEvery = j.optInt("cellEvery", 0)
        c.micHz = j.optInt("micHz", 0)
        c.micSrc = j.optString("micSrc", "").take(24)
        c.micDev = j.optString("micDev", "").take(24)
        c.micLow = j.optBoolean("micLow", false)
        c.iface = j.optString("iface", "")
        c.filter = j.optString("filter", "")
        c.snap = j.optInt("snap", 0)
        c.bleOpts = j.optJSONObject("ble")?.toString() ?: ""
        c.send(Json.note("info", "sub: " + c.subs.joinToString(",")))
        onSubs()
    }

    companion object {
        /** Источники, которые отдают личные данные. */
        val SENSITIVE = setOf("sms", "screen")

        /** Источники действий: пользуются тем, что телефон соединён с чем-то (речь, GATT, сеть, события системы). */
        val POWER_SRC = setOf("speech", "gatt", "gattsrv", "l2cap", "btlink", "net", "sys", "vpn", "screen")

        /** Команды действий: сокеты и ping, соединения Bluetooth, речь, управление телефоном. Нужен c.power. */
        fun powerCmd(name: String) = POWER_PREFIX.any { name.startsWith(it) } || name == "ping"
        private val POWER_PREFIX = listOf("tcp.", "udp.", "net.", "raw.", "gatt.", "gattsrv.", "l2cap.", "nsd.", "wifi.", "aware.", "p2p.", "bt.", "ble.adv.", "speech.", "alarm.", "boot.", "cal.", "rec.", "callrec.", "media.", "fs.", "ussd.", "call.", "screenrec.", "sys.", "activity.", "ui.", "app.", "tls.", "intent", "vol.", "gps.mock", "tts.", "clip.", "media.", "screen.", "toast", "vpn.")

        /** Команды с личными данными или платные (SMS, контакты) — только доверенному клиенту. */
        fun sensitiveCmd(name: String) = name.startsWith("sms.") || name.startsWith("contacts.") || name.startsWith("boot.") || name.startsWith("cal.")

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
