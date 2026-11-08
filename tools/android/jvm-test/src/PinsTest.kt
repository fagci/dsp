package app.dsp.phone.pinstest

import app.dsp.phone.BridgeServer
import app.dsp.phone.Config
import app.dsp.phone.FakeCtx
import app.dsp.phone.Json
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.WebSocket
import java.nio.ByteBuffer
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.CopyOnWriteArrayList

/** Ретрансляция пинов в мосте приложения (PinRelay.kt) против настоящего BridgeServer: то же, что tools/test-pins.mjs для pin-bridge.mjs. */
private var fails = 0
private fun ok(name: String, c: Boolean, x: String = "") { if (!c) { fails++; println("FAIL $name $x") } else println("ok   $name") }
private fun until(ms: Long = 3000, f: () -> Boolean): Boolean { val t = System.currentTimeMillis(); while (System.currentTimeMillis() - t < ms) { if (f()) return true; Thread.sleep(10) }; return f() }

private class Sock(port: Int, path: String) {
    val texts = CopyOnWriteArrayList<String>()
    val bins = CopyOnWriteArrayList<ByteArray>()
    private val tb = StringBuilder(); private val bb = java.io.ByteArrayOutputStream()
    val ws: WebSocket = HttpClient.newHttpClient().newWebSocketBuilder().buildAsync(URI("ws://127.0.0.1:$port$path"), object : WebSocket.Listener {
        override fun onOpen(w: WebSocket) { w.request(1) }
        override fun onText(w: WebSocket, d: CharSequence, last: Boolean): CompletionStage<*>? { tb.append(d); if (last) { texts.add(tb.toString()); tb.setLength(0) }; w.request(1); return CompletableFuture.completedFuture(null) }
        override fun onBinary(w: WebSocket, d: ByteBuffer, last: Boolean): CompletionStage<*>? { val a = ByteArray(d.remaining()); d.get(a); bb.write(a); if (last) { bins.add(bb.toByteArray()); bb.reset() }; w.request(1); return CompletableFuture.completedFuture(null) }
    }).get()
    fun send(s: String) { ws.sendText(s, true).get() }
    fun sendBin(b: ByteArray) { ws.sendBinary(ByteBuffer.wrap(b), true).get() }
    fun json(t: String) = texts.mapNotNull { try { org.json.JSONObject(it) } catch (e: Exception) { null } }.filter { it.optString("t") == t }
    fun close() { ws.sendClose(1000, "").get() }
}

/** Кадр пина: kind, имя, данные (float32 LE или готовые байты). */
private fun frame(kind: Int, name: String, data: ByteArray): ByteArray {
    val nb = name.toByteArray(); val hl = 24 + ((nb.size + 3) and 3.inv())
    val o = ByteArray(hl + data.size); o[0] = kind.toByte(); o[1] = nb.size.toByte()
    System.arraycopy(nb, 0, o, 24, nb.size); System.arraycopy(data, 0, o, hl, data.size); return o
}
private fun floats(vararg f: Float): ByteArray { val b = ByteBuffer.allocate(4 * f.size).order(java.nio.ByteOrder.LITTLE_ENDIAN); for (x in f) b.putFloat(x); return b.array() }
private fun nameOf(f: ByteArray) = String(f, 24, f[1].toInt() and 255)
private fun payload(f: ByteArray) = f.copyOfRange(24 + (((f[1].toInt() and 255) + 3) and 3.inv()), f.size)

fun main() {
    val cfg = Config(FakeCtx()); cfg.port = 0
    val srv = BridgeServer(cfg, { Json.obj("src" to "\"bridge\"", "level" to "\"hello\"", "ver" to "1") }, { "status-text" }) { }
    ok("start", srv.start() == null)
    val port = srv.boundPort

    val page = Sock(port, "/")
    page.send("""{"t":"hello","role":"graph"}""")
    page.send("""{"t":"pins","out":[{"name":"chan1","kind":"iq","fc":1e8,"sr":48000},{"name":"spec"}],"in":[{"name":"tune"}]}""")
    val cli = Sock(port, "/")
    cli.send("""{"t":"pins"}""")
    ok("client sees the pin list", until { cli.json("pins").any { it.getJSONArray("out").length() == 2 && it.getJSONArray("in").getJSONObject(0).getString("name") == "tune" } }, cli.texts.toString())
    ok("page was told nothing is wanted yet", until { page.json("want").any { it.getJSONArray("names").length() == 0 } }, page.texts.toString())
    ok("/pins over HTTP", HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/pins")).build(), HttpResponse.BodyHandlers.ofString()).body().contains("\"chan1\""))

    cli.send("""{"t":"sub","names":["chan1"]}""")
    ok("page is told what is wanted", until { page.json("want").any { it.getJSONArray("names").join(",") == "\"chan1\"" } }, page.texts.toString())
    val iq = frame(2, "chan1", floats(1f, 3f, 2f, 4f))
    page.sendBin(iq)
    page.sendBin(frame(5, "other", "1".toByteArray()))
    ok("subscribed pin arrives with header", until { cli.bins.size >= 1 } && nameOf(cli.bins[0]) == "chan1" && cli.bins[0].contentEquals(iq))
    Thread.sleep(150)
    ok("unsubscribed pin does not", cli.bins.size == 1, cli.bins.size.toString())

    val raw = Sock(port, "/raw/chan1")
    ok("raw join widens wanted", until { page.json("want").size >= 2 })
    page.sendBin(iq)
    ok("raw gets payload only", until { raw.bins.size >= 1 } && raw.bins[0].contentEquals(payload(iq)), raw.bins.size.toString())
    ok("raw gets no text (no hello, no notes)", raw.texts.isEmpty(), raw.texts.toString())
    srv.note("info", "x"); Thread.sleep(150)
    ok("notes do not reach raw clients", raw.texts.isEmpty())

    cli.send("""{"t":"set","name":"tune","v":100500000}""")
    ok("set → graph", until { page.bins.any { nameOf(it) == "tune" && String(payload(it)) == "100500000" } }, page.bins.map { nameOf(it) }.toString())
    cli.send("""{"t":"set","name":"label","v":"hello"}""")
    ok("set string is quoted json", until { page.bins.any { nameOf(it) == "label" && String(payload(it)) == "\"hello\"" } })
    val mic = frame(1, "mic", floats(0.25f))
    cli.sendBin(mic)
    ok("binary from a client → graph", until { page.bins.any { it.contentEquals(mic) } })

    cli.send("""{"t":"make","name":"newpin","dir":"pub"}""")
    ok("make → graph", until { page.json("make").any { it.getString("name") == "newpin" && it.getString("dir") == "pub" } })
    cli.send("""{"t":"make","name":"x","dir":"evil"}""")
    Thread.sleep(150)
    ok("make with a bad direction ignored", page.json("make").size == 1)

    // страница B (Pins In) подписывается и получает пины страницы A: graph → graph
    val pageB = Sock(port, "/")
    pageB.send("""{"t":"hello","role":"graph"}""")
    pageB.send("""{"t":"sub","names":["chan1"]}""")
    // подписка B обрабатывается в потоке сервера: шлём кадр, пока она не вступит в силу (на CI один кадр сразу после sub мог уйти раньше)
    ok("page B takes page A's pin", until { page.sendBin(iq); pageB.bins.any { it.contentEquals(iq) } })
    ok("page A is not echoed its own frames", page.bins.none { it.contentEquals(iq) })
    ok("page B sees A's names in the list (not its own)", until { pageB.json("pins").any { it.getJSONArray("out").length() == 2 } })

    cli.send("""{"t":"sub","names":["*"]}""")
    ok("* means everything", until { page.json("want").any { it.getJSONArray("names").join(",") == "\"*\"" } })
    raw.close(); cli.close(); pageB.close()
    ok("wanted shrinks when everybody leaves", until { page.json("want").last().getJSONArray("names").length() == 0 }, page.json("want").last().toString())

    // существующий протокол не ломается: датчики и двоичный поток соединения живут рядом
    val old = Sock(port, "/")
    old.send("""{"sub":["accel"],"hz":50}""")
    ok("sensors still work next to pins", until { old.texts.any { it.contains("sub: accel") } }, old.texts.toString())
    old.close(); page.close(); srv.stop()
    if (fails > 0) { println("FAILED $fails"); System.exit(1) }
    println("all ok")
}
