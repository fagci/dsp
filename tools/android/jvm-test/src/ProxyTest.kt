package app.dsp.phone.proxytest

import android.net.Uri
import android.webkit.WebResourceRequest
import app.dsp.phone.CorsProxy
import com.sun.net.httpserver.HttpServer
import java.io.ByteArrayOutputStream
import java.net.InetSocketAddress
import java.util.zip.GZIPOutputStream

private var bad = 0
private fun ok(name: String, c: Boolean, x: String = "") { if (!c) { bad++; println("FAIL $name $x") } else println("ok   $name") }

private class Req(val u: String, val m: String = "GET", val h: Map<String, String> = emptyMap(), val main: Boolean = false) : WebResourceRequest {
    override fun getUrl(): Uri = Uri.parse(u)
    override fun isForMainFrame() = main
    override fun isRedirect() = false
    override fun hasGesture() = false
    override fun getMethod() = m
    override fun getRequestHeaders() = h
}

fun main() {
    val srv = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    fun reply(ex: com.sun.net.httpserver.HttpExchange, code: Int, body: ByteArray, vararg hdr: Pair<String, String>) {
        for ((k, v) in hdr) ex.responseHeaders.add(k, v)
        ex.sendResponseHeaders(code, if (ex.requestMethod == "HEAD") -1 else body.size.toLong())
        if (ex.requestMethod != "HEAD") ex.responseBody.write(body)
        ex.close()
    }
    srv.createContext("/plain") { reply(it, 200, "hello".toByteArray(), "Content-Type" to "text/plain; charset=utf-8", "Access-Control-Allow-Origin" to "https://other.example", "Set-Cookie" to "a=b") }
    srv.createContext("/gz") {
        val b = ByteArrayOutputStream(); GZIPOutputStream(b).use { g -> g.write("""{"k":1}""".toByteArray()) }
        if ((it.requestHeaders.getFirst("Accept-Encoding") ?: "").contains("gzip")) reply(it, 200, b.toByteArray(), "Content-Type" to "application/json", "Content-Encoding" to "gzip")
        else reply(it, 200, """{"k":1}""".toByteArray(), "Content-Type" to "application/json")
    }
    srv.createContext("/redir") { reply(it, 302, ByteArray(0), "Location" to "/redir2") }
    srv.createContext("/redir2") { reply(it, 301, ByteArray(0), "Location" to "/plain") }
    srv.createContext("/loop") { reply(it, 302, ByteArray(0), "Location" to "/loop") }
    srv.createContext("/missing") { reply(it, 404, "nope".toByteArray(), "Content-Type" to "text/plain") }
    srv.createContext("/range") {
        if (it.requestHeaders.getFirst("Range") != null) reply(it, 206, "ab".toByteArray(), "Content-Range" to "bytes 0-1/10", "Content-Type" to "video/mp4")
        else reply(it, 200, "0123456789".toByteArray(), "Content-Type" to "video/mp4")
    }
    srv.createContext("/headers") {
        val sb = StringBuilder()
        for ((k, v) in it.requestHeaders) sb.append(k.lowercase()).append('=').append(v.joinToString(",")).append('\n')
        reply(it, 200, sb.toString().toByteArray(), "Content-Type" to "text/plain")
    }
    srv.start()
    val base = "http://127.0.0.1:${srv.address.port}"
    fun body(r: android.webkit.WebResourceResponse) = r.data.readBytes().toString(Charsets.UTF_8)

    val p = CorsProxy.handle(Req("$base/plain", h = mapOf("Origin" to "https://appassets.androidplatform.net")))!!
    ok("GET: status, body, mime, charset", p.statusCode == 200 && body(p) == "hello" && p.mimeType == "text/plain" && p.encoding == "utf-8")
    val h = p.responseHeaders
    ok("CORS: origin echoed, upstream ACAO replaced (one value)", h["Access-Control-Allow-Origin"] == "https://appassets.androidplatform.net" && h.keys.count { it.equals("access-control-allow-origin", true) } == 1, h.toString())
    ok("CORS: expose + CORP, cookies dropped", h["Access-Control-Expose-Headers"] == "*" && h["Cross-Origin-Resource-Policy"] == "cross-origin" && h.keys.none { it.equals("set-cookie", true) })
    ok("no Origin → *", CorsProxy.handle(Req("$base/plain"))!!.responseHeaders["Access-Control-Allow-Origin"] == "*")

    val g = CorsProxy.handle(Req("$base/gz", h = mapOf("Accept-Encoding" to "br, gzip")))!!
    ok("gzip is decoded, Content-Encoding not passed on", body(g) == """{"k":1}""" && g.responseHeaders.keys.none { it.equals("content-encoding", true) } && g.mimeType == "application/json", g.responseHeaders.toString())
    val r1 = CorsProxy.handle(Req("$base/redir"))!!
    ok("redirects are followed (302 → 301 → 200)", r1.statusCode == 200 && body(r1) == "hello")
    val lp = CorsProxy.handle(Req("$base/loop"))!!
    ok("redirect loop → 502 with CORS", lp.statusCode == 502 && lp.responseHeaders.containsKey("Access-Control-Allow-Origin"))
    val nf = CorsProxy.handle(Req("$base/missing"))!!
    ok("404 passes through with body and CORS", nf.statusCode == 404 && body(nf) == "nope" && nf.responseHeaders.containsKey("Access-Control-Allow-Origin"))
    val rg = CorsProxy.handle(Req("$base/range", h = mapOf("Range" to "bytes=0-1")))!!
    ok("Range → 206 with Content-Range", rg.statusCode == 206 && body(rg) == "ab" && rg.responseHeaders.entries.any { it.key.equals("content-range", true) && it.value == "bytes 0-1/10" }, "${rg.statusCode} ${rg.responseHeaders}")
    val hd = body(CorsProxy.handle(Req("$base/headers", h = mapOf("Authorization" to "Basic QQ==", "User-Agent" to "UA/1", "Origin" to "https://x", "Referer" to "https://x/", "Cookie" to "s=1",
        "If-None-Match" to "\"e\"", "Sec-Fetch-Mode" to "cors", "Accept" to "image/*")))!!)
    ok("Authorization, User-Agent, Accept forwarded", hd.contains("authorization=Basic QQ==") && hd.contains("user-agent=UA/1") && hd.contains("accept=image/*"), hd)
    ok("Origin, Referer, Cookie, conditionals, Sec-* not forwarded", !hd.contains("origin=") && !hd.contains("referer=") && !hd.contains("cookie=") && !hd.contains("if-none-match") && !hd.contains("sec-fetch"), hd)
    val hh = CorsProxy.handle(Req("$base/plain", "HEAD"))!!
    ok("HEAD: 200 and no body", hh.statusCode == 200 && hh.data.readBytes().isEmpty())
    val op = CorsProxy.handle(Req("$base/plain", "OPTIONS", mapOf("Access-Control-Request-Headers" to "authorization,x-a", "Origin" to "https://x")))!!
    ok("preflight answered without the network", op.statusCode == 204 && op.responseHeaders["Access-Control-Allow-Headers"] == "authorization,x-a" && op.responseHeaders["Access-Control-Allow-Origin"] == "https://x")
    ok("preflight works even if the host is down", CorsProxy.handle(Req("http://127.0.0.1:1/x", "OPTIONS"))!!.statusCode == 204)
    ok("POST is left to the WebView", CorsProxy.handle(Req("$base/plain", "POST")) == null)
    ok("main frame navigation is left to the WebView", CorsProxy.handle(Req("$base/plain", main = true)) == null)
    ok("other schemes are left to the WebView", CorsProxy.handle(Req("data:text/plain,hi")) == null && CorsProxy.handle(Req("blob:https://x/1")) == null)
    val dead = CorsProxy.handle(Req("http://127.0.0.1:1/x"))!!
    ok("unreachable host → 502 with a reason and CORS", dead.statusCode == 502 && body(dead).startsWith("fetch failed") && dead.responseHeaders.containsKey("Access-Control-Allow-Origin"))
    srv.stop(0)
    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
