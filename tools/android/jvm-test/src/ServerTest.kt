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

fun main() {
    val ctx = FakeCtx()
    val cfg = Config(ctx)
    cfg.port = 0
    val subsChanged = java.util.concurrent.atomic.AtomicInteger()
    val srv = BridgeServer(cfg, CameraHub(ctx) {}, { Json.obj("src" to "\"bridge\"", "level" to "\"hello\"", "ver" to "1") }, { "status-text" }) { subsChanged.incrementAndGet() }
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
    val pre = get("/camera.mjpg", "https://fagci.github.io", "OPTIONS")
    ok("preflight 204", pre.statusCode() == 204 && pre.headers().firstValue("access-control-allow-private-network").isPresent)
    ok("camera without permission: 503 with reason", get("/snapshot.jpg").let { it.statusCode() == 503 && it.body().contains("permission") }, get("/snapshot.jpg").body())

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
    srv.stop()
    ok("stopped", !srv.listening)
    println(if (bad == 0) "all ok" else "$bad FAILED")
}
