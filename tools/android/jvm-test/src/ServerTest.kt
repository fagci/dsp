package app.dsp.phone

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.WebSocket
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.CopyOnWriteArrayList

class MemPrefs : SharedPreferences {
    val m = HashMap<String, Any?>()
    override fun getAll() = m.toMutableMap()
    override fun getString(k: String, d: String?) = (m[k] as String?) ?: d
    override fun getStringSet(k: String, d: MutableSet<String>?) = d
    override fun getInt(k: String, d: Int) = (m[k] as Int?) ?: d
    override fun getLong(k: String, d: Long) = d
    override fun getFloat(k: String, d: Float) = d
    override fun getBoolean(k: String, d: Boolean) = (m[k] as Boolean?) ?: d
    override fun contains(k: String) = m.containsKey(k)
    override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
        override fun putString(k: String, v: String?) = apply { m[k] = v }
        override fun putStringSet(k: String, v: MutableSet<String>?) = this
        override fun putInt(k: String, v: Int) = apply { m[k] = v }
        override fun putLong(k: String, v: Long) = this
        override fun putFloat(k: String, v: Float) = this
        override fun putBoolean(k: String, v: Boolean) = apply { m[k] = v }
        override fun remove(k: String) = apply { m.remove(k) }
        override fun clear() = this
        override fun commit() = true
        override fun apply() {}
    }
    override fun registerOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) {}
    override fun unregisterOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) {}
}

class FakeCtx : ContextWrapper(null) {
    val prefs = MemPrefs()
    override fun getSharedPreferences(n: String?, mode: Int): SharedPreferences = prefs
    override fun checkSelfPermission(p: String) = android.content.pm.PackageManager.PERMISSION_DENIED
}

var bad = 0
fun ok(name: String, c: Boolean, x: String = "") { if (!c) { bad++; println("FAIL $name $x") } else println("ok   $name") }
fun until(ms: Long = 4000, f: () -> Boolean): Boolean { val t = System.currentTimeMillis(); while (System.currentTimeMillis() - t < ms) { if (f()) return true; Thread.sleep(20) }; return false }


/** Поддельный USB для проверки протокола /usb (без Android). */
class FakeUsb : UsbBackend {
    val log = java.util.concurrent.CopyOnWriteArrayList<String>()
    val ls = java.util.concurrent.CopyOnWriteArraySet<(String, org.json.JSONObject) -> Unit>()
    override fun list() = org.json.JSONArray().put(org.json.JSONObject().put("id", "d1").put("perm", true).put("vid", 0x0bda).put("pid", 0x2838))
    override fun permission(id: String) = id == "d1"
    override fun open(id: String): org.json.JSONObject? { if (id != "d1") throw UsbError("NotFoundError", "device is gone"); log.add("open")
        return org.json.JSONObject().put("usb", "2.00").put("speed", "high-speed").put("configs", org.json.JSONArray().put(org.json.JSONObject().put("value", 1).put("ifaces", org.json.JSONArray()))) }
    override fun close(id: String) { log.add("close") }
    override fun config(id: String, value: Int) { log.add("config$value") }
    override fun claim(id: String, num: Int) { log.add("claim$num") }
    override fun release(id: String, num: Int) {}
    override fun alt(id: String, num: Int, alt: Int) {}
    override fun control(id: String, rt: Int, req: Int, value: Int, index: Int, len: Int, data: ByteArray?) =
        if (rt and 0x80 != 0) ByteArray(len) { (req + it).toByte() } else { log.add("ctl-out:" + (data?.size ?: -1) + ":" + value + ":" + index); ByteArray(0) }
    override fun bulkIn(id: String, addr: Int, len: Int, alive: () -> Boolean): ByteArray {
        if (addr == 0x85) { while (alive()) Thread.sleep(10); throw UsbError("NetworkError", "closed") }     // читает, пока сессия жива
        return ByteArray(len) { it.toByte() }
    }
    override fun bulkOut(id: String, addr: Int, data: ByteArray) = data.size
    override fun clearHalt(id: String, addr: Int) { log.add("clear$addr") }
    override fun reset(id: String) {}
    override fun listen(l: (String, org.json.JSONObject) -> Unit) { ls.add(l) }
    override fun unlisten(l: (String, org.json.JSONObject) -> Unit) { ls.remove(l) }
}

fun usbMsg(h: org.json.JSONObject, payload: ByteArray = ByteArray(0)): java.nio.ByteBuffer {
    val hb = h.toString().toByteArray()
    return java.nio.ByteBuffer.allocate(4 + hb.size + payload.size).putInt(hb.size).put(hb).put(payload).flip()
}

fun main() {
    val ctx = FakeCtx()
    val cfg = Config(ctx)
    cfg.port = 0
    val subsChanged = java.util.concurrent.atomic.AtomicInteger()
    val srv = BridgeServer(cfg, { Json.obj("src" to "\"bridge\"", "level" to "\"hello\"", "ver" to "1") }, { "status-text" }) { subsChanged.incrementAndGet() }
    ok("start", srv.start() == null)
    val port = srv.boundPort
    val http = HttpClient.newHttpClient()
    fun get(path: String, origin: String? = null, method: String = "GET"): HttpResponse<String> {
        val b = HttpRequest.newBuilder(URI("http://127.0.0.1:$port$path"))
        if (origin != null) b.header("Origin", origin)   // jdk блокирует Origin по умолчанию — см. -Djdk.httpclient.allowRestrictedHeaders
        b.method(method, HttpRequest.BodyPublishers.noBody())
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString())
    }
    ok("status page", get("/status").body() == "status-text")
    ok("404", get("/nope").statusCode() == 404)
    ok("default: any origin may connect", get("/status", "https://evil.example").statusCode() == 200)
    cfg.checkOrigin = true
    val ev = get("/status", "https://evil.example")
    ok("Origin check on: foreign origin refused", ev.statusCode() == 403, ev.statusCode().toString())
    val good = get("/status", "https://fagci.github.io")
    ok("allowed origin: ACAO + PNA", good.statusCode() == 200 && good.headers().firstValue("access-control-allow-origin").orElse("") == "https://fagci.github.io" &&
        good.headers().firstValue("access-control-allow-private-network").orElse("") == "true")
    ok("app origin allowed", get("/status", Config.APP_ORIGIN).statusCode() == 200)
    ok("localhost origin allowed", get("/status", "http://localhost:8000").statusCode() == 200)
    cfg.checkOrigin = false
    val pre = get("/status", "https://fagci.github.io", "OPTIONS")
    ok("preflight 204", pre.statusCode() == 204 && pre.headers().firstValue("access-control-allow-private-network").isPresent)

    val got = CopyOnWriteArrayList<String>()
    val buf = StringBuilder()
    val listener = object : WebSocket.Listener {
        override fun onOpen(w: WebSocket) { w.request(1) }
        override fun onText(w: WebSocket, d: CharSequence, last: Boolean): CompletionStage<*>? {
            buf.append(d); if (last) { got.add(buf.toString()); buf.setLength(0) }
            w.request(1); return CompletableFuture.completedFuture(null)
        }
    }
    val ws = HttpClient.newHttpClient().newWebSocketBuilder().buildAsync(URI("ws://127.0.0.1:$port/"), listener).get()
    ok("hello", until { got.any { it.contains("\"hello\"") } })
    ok("no records before sub", got.size == 1)
    ws.sendText("""{"sub":["accel","gyro"],"hz":200}""", true).get()
    ok("sub acknowledged", until { got.any { it.contains("sub: accel,gyro") } })
    ok("onSubs called", subsChanged.get() >= 2)
    val w = srv.wanted()
    ok("wanted: subs and hz", w.subs == setOf("accel", "gyro") && w.hz == 200 && w.wifiEvery == 10, w.toString())
    ws.sendText("""{"sub":["accel"],"hz":800}""", true).get()
    ok("rates above 200 Hz are passed on", until { srv.wanted().hz == 800 }, srv.wanted().toString())
    ws.sendText("""{"sub":["accel","gyro"],"hz":200}""", true).get()
    until { srv.wanted().hz == 200 }
    for (i in 0 until 5) srv.emit("accel", """{"src":"sensor","sensor":"accel","x":$i}""")
    srv.emit("light", """{"src":"sensor","sensor":"light","x":1}""")            // не подписан
    srv.emit("gyro", """{"src":"sensor","sensor":"gyro","x":9}""")
    ok("records come as arrays, only subscribed", until { got.any { it.startsWith("[") && it.contains("\"x\":4") && it.contains("gyro") } } && got.none { it.contains("light") })
    val arr = org.json.JSONArray(got.first { it.startsWith("[") })
    ok("array is valid JSON of 6 records", arr.length() == 6, arr.length().toString())
    srv.note("error", "some problem")
    ok("note reaches client", until { got.any { it.contains("some problem") } })
    val big = "x".repeat(70000)
    ws.sendText("""{"sub":["gps"],"pad":"$big"}""", true).get()
    ok("large (fragmented/extended length) message handled", until { got.any { it.contains("sub: gps") } })
    ok("wanted after resub", srv.wanted().subs == setOf("gps") && srv.wanted().hz == 20)
    srv.emit("gps", """{"src":"gps","lat":1}""")
    ok("gps record", until { got.any { it.contains("\"lat\":1") } })
    ws.sendClose(1000, "bye").get()
    ok("client removed after close", until { srv.clientCount == 0 })
    ok("wanted empty without clients", srv.wanted().subs.isEmpty())

    // токен: чужой адрес (эмулируем strict) и query sources
    cfg.strict = true
    ok("strict without a token set: open", get("/status").statusCode() == 200)
    cfg.token = "secret123"
    ok("strict: no token → 401", get("/status").statusCode() == 401)
    ok("strict: token → 200", get("/status?token=" + cfg.token).statusCode() == 200)
    cfg.strict = false
    val got2 = CopyOnWriteArrayList<String>()
    val l2 = object : WebSocket.Listener {
        override fun onText(w: WebSocket, d: CharSequence, last: Boolean): CompletionStage<*>? { got2.add(d.toString()); w.request(1); return null }
        override fun onOpen(w: WebSocket) { w.request(1) }
    }
    val ws2 = HttpClient.newHttpClient().newWebSocketBuilder().buildAsync(URI("ws://127.0.0.1:$port/?sources=battery,accel&hz=50"), l2).get()
    ok("query sources and hz", until { srv.wanted().subs == setOf("battery", "accel") && srv.wanted().hz == 50 })
    ws2.abort()
    ok("abrupt close removes client", until { srv.clientCount == 0 })

    // --- /usb: общий USB-API для страницы приложения ---
    val fu = FakeUsb()
    ok("/usb without a backend: 404", get("/usb?k=${UsbKey.value}").statusCode() == 404)
    srv.usb = fu
    ok("/usb without the key: 403", get("/usb").statusCode() == 403)
    ok("/usb with a wrong key: 403", get("/usb?k=nope").statusCode() == 403)
    ok("/usb with the key but without WebSocket: 400", get("/usb?k=${UsbKey.value}").statusCode() == 400)
    val replies = java.util.concurrent.LinkedBlockingQueue<Pair<org.json.JSONObject, ByteArray>>()
    val ubuf = java.io.ByteArrayOutputStream()
    val ul = object : WebSocket.Listener {
        override fun onOpen(w: WebSocket) { w.request(1) }
        override fun onBinary(w: WebSocket, d: java.nio.ByteBuffer, last: Boolean): CompletionStage<*>? {
            val a = ByteArray(d.remaining()); d.get(a); ubuf.write(a)
            if (last) {
                val m = ubuf.toByteArray(); ubuf.reset()
                val hl = java.nio.ByteBuffer.wrap(m).int
                replies.add(org.json.JSONObject(String(m, 4, hl)) to m.copyOfRange(4 + hl, m.size))
            }
            w.request(1); return null
        }
    }
    val uws = HttpClient.newHttpClient().newWebSocketBuilder().buildAsync(URI("ws://127.0.0.1:$port/usb?k=${UsbKey.value}"), ul).get()
    fun call(h: org.json.JSONObject, p: ByteArray = ByteArray(0)): Pair<org.json.JSONObject, ByteArray> {
        uws.sendBinary(usbMsg(h, p), true).get()
        return replies.poll(4, java.util.concurrent.TimeUnit.SECONDS) ?: (org.json.JSONObject().put("ok", false).put("err", "timeout") to ByteArray(0))
    }
    fun req(id: Int, op: String) = org.json.JSONObject().put("id", id).put("op", op).put("dev", "d1")
    val l1 = call(req(1, "list"))
    ok("usb list", l1.first.getBoolean("ok") && l1.first.getInt("id") == 1 && l1.first.getJSONArray("devices").getJSONObject(0).getInt("vid") == 0x0bda)
    ok("usb permission", call(req(2, "perm")).first.getBoolean("granted"))
    val op = call(req(3, "open"))
    ok("usb open returns descriptors from the raw bytes", op.first.getString("usb") == "2.00" && op.first.getString("speed") == "high-speed" && op.first.getJSONArray("configs").length() == 1)
    ok("usb open, config, claim reach the backend", op.first.getBoolean("ok") && call(req(4, "config").put("value", 1)).first.getBoolean("ok") &&
        call(req(5, "claim").put("num", 0)).first.getBoolean("ok") && fu.log.toList() == listOf("open", "config1", "claim0"), fu.log.toString())
    val ci = call(req(6, "control").put("rt", 0xC0).put("req", 5).put("val", 0).put("idx", 0).put("len", 4))
    ok("usb control IN returns data", ci.first.getBoolean("ok") && ci.second.toList() == listOf<Byte>(5, 6, 7, 8))
    val co = call(req(7, "control").put("rt", 0x40).put("req", 1).put("val", 2).put("idx", 3).put("len", 3), byteArrayOf(1, 2, 3))
    ok("usb control OUT carries the payload", co.first.getBoolean("ok") && fu.log.contains("ctl-out:3:2:3"), fu.log.toString())
    val bi = call(req(8, "in").put("ep", 0x81).put("len", 70000))
    ok("usb bulk IN: long payload in one message", bi.first.getBoolean("ok") && bi.second.size == 70000 && bi.second[69999] == 69999.toByte())
    val bo = call(req(9, "out").put("ep", 2), ByteArray(1000))
    ok("usb bulk OUT: written", bo.first.getInt("written") == 1000)
    val er = call(req(10, "open").put("dev", "nope"))
    ok("usb error mapped to a DOMException name", !er.first.getBoolean("ok") && er.first.getString("err") == "NotFoundError" && er.first.getString("msg") == "device is gone")
    ok("usb unknown op", call(req(11, "frobnicate")).first.getString("err") == "NotSupportedError")
    // долгое чтение не блокирует остальное: ответ на следующий запрос приходит, пока чтение висит
    uws.sendBinary(usbMsg(req(12, "in").put("ep", 0x85).put("len", 16)), true).get()
    val fast = call(req(13, "list"))
    ok("usb: a pending read does not block other requests", fast.first.getInt("id") == 13 && fast.first.getBoolean("ok"))
    for (l in fu.ls) l("disconnect", org.json.JSONObject().put("id", "d1"))
    val evr = replies.poll(3, java.util.concurrent.TimeUnit.SECONDS)
    ok("usb event pushed to the page", evr != null && evr.first.getString("ev") == "disconnect" && evr.first.getString("id") == "d1")
    uws.abort()
    ok("usb session unsubscribes on close", until { fu.ls.isEmpty() })

    // --- команды и доверие: SMS и контакты только странице приложения (с ключом) ---
    val cmds = java.util.concurrent.CopyOnWriteArrayList<Pair<Boolean, String>>()
    srv.onCommand = { c, j -> cmds.add(c.trusted to j.optString("cmd")); c.send(Json.obj("src" to "\"cmd\"", "cmd" to Json.str(j.optString("cmd")), "ok" to "true")) }
    fun cmdClient(query: String): Pair<WebSocket, java.util.concurrent.LinkedBlockingQueue<String>> {
        val q = java.util.concurrent.LinkedBlockingQueue<String>()
        val l = object : WebSocket.Listener {
            override fun onOpen(w: WebSocket) { w.request(1) }
            override fun onText(w: WebSocket, d: CharSequence, last: Boolean): CompletionStage<*>? { q.add(d.toString()); w.request(1); return null }
        }
        return HttpClient.newHttpClient().newWebSocketBuilder().buildAsync(URI("ws://127.0.0.1:$port/$query"), l).get() to q
    }
    val (guest, gq) = cmdClient("")
    gq.poll(3, java.util.concurrent.TimeUnit.SECONDS)
    guest.sendText("""{"sub":["sms","gps"]}""", true).get()
    val gm = generateSequence { gq.poll(3, java.util.concurrent.TimeUnit.SECONDS) }.take(3).toList()
    ok("guest: the sensitive source is refused with a note", gm.any { it.contains("only the page of the DSP app") } && until { srv.wanted().subs == setOf("gps") }, srv.wanted().toString())
    guest.sendText("""{"cmd":"notify","id":1}""", true).get()
    ok("guest: a command reaches the handler untrusted and is answered", until { cmds.contains(false to "notify") } && gq.poll(3, java.util.concurrent.TimeUnit.SECONDS) != null)
    val (own, oq) = cmdClient("?k=${UsbKey.value}")
    oq.poll(3, java.util.concurrent.TimeUnit.SECONDS)
    own.sendText("""{"sub":["sms"]}""", true).get()
    ok("the app page: SMS source allowed", until { "sms" in srv.wanted().subs })
    own.sendText("""{"cmd":"sms.list"}""", true).get()
    ok("the app page: command arrives trusted", until { cmds.contains(true to "sms.list") })
    val (fake, _) = cmdClient("?k=wrong")
    fake.sendText("""{"cmd":"sms.list"}""", true).get()
    ok("a wrong key is not trusted", until { cmds.count { it.second == "sms.list" } == 2 } && cmds.last() == (false to "sms.list"), cmds.toString())
    ok("sensitive command names", BridgeServer.sensitiveCmd("sms.send") && BridgeServer.sensitiveCmd("contacts.find") && !BridgeServer.sensitiveCmd("notify") && !BridgeServer.sensitiveCmd("torch"))
    guest.abort(); own.abort(); fake.abort()
    srv.stop()
    ok("stopped", !srv.listening)
    println(if (bad == 0) "all ok" else "$bad FAILED")
}
