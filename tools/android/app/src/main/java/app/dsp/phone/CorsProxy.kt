package app.dsp.phone

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

object CorsProxy {
    private val DROP = setOf("host", "origin", "referer", "cookie", "accept-encoding", "if-none-match", "if-modified-since", "if-range",
        "cache-control", "pragma", "x-requested-with", "upgrade-insecure-requests")

    /**
     * Запросы страницы к чужим хостам (GET / HEAD / OPTIONS) идут из приложения, а не из браузерного стека:
     * ответ получает CORS-заголовки, поэтому CORS-прокси не нужен. POST с телом WebView перехватить не даёт — он идёт как обычно.
     */
    fun handle(r: WebResourceRequest): WebResourceResponse? {
        val scheme = r.url.scheme
        if (r.isForMainFrame || (scheme != "http" && scheme != "https")) return null
        val m = r.method.uppercase()
        val origin = r.requestHeaders.entries.firstOrNull { it.key.equals("origin", true) }?.value
        val cors = mutableMapOf(
            "Access-Control-Allow-Origin" to (origin ?: "*"), "Vary" to "Origin", "Access-Control-Expose-Headers" to "*",
            "Timing-Allow-Origin" to "*", "Cross-Origin-Resource-Policy" to "cross-origin",
        )
        if (m == "OPTIONS") {
            cors["Access-Control-Allow-Methods"] = "GET, HEAD, POST, PUT, DELETE, OPTIONS"
            cors["Access-Control-Allow-Headers"] = r.requestHeaders.entries.firstOrNull { it.key.equals("access-control-request-headers", true) }?.value ?: "*"
            cors["Access-Control-Max-Age"] = "600"
            return WebResourceResponse("text/plain", "utf-8", 204, "No Content", cors, "".byteInputStream())
        }
        if (m != "GET" && m != "HEAD") return null
        try {
            var url = URL(r.url.toString())
            for (hop in 0..8) {
                val c = url.openConnection() as HttpURLConnection
                c.instanceFollowRedirects = false
                c.connectTimeout = 15_000; c.readTimeout = 60_000
                c.requestMethod = m
                for ((k, v) in r.requestHeaders) {
                    val l = k.lowercase()
                    // Accept-Encoding ставит сам HttpURLConnection (и сам распаковывает); условные заголовки убираем — 304 отдать нельзя
                    if (l in DROP || l.startsWith("sec-") || l.startsWith("access-control-")) continue
                    c.setRequestProperty(k, v)
                }
                val code = c.responseCode
                if (code in 300..399 && code != 304) {
                    val loc = c.getHeaderField("Location")
                    c.disconnect()
                    if (loc == null) break
                    url = URL(url, loc)
                    continue
                }
                if (code < 200 || code in 300..399) { c.disconnect(); break }
                for ((k, v) in c.headerFields) {
                    if (k == null || v.isEmpty()) continue
                    val l = k.lowercase()
                    if (l.startsWith("access-control-") || l == "set-cookie" || l == "vary" || l == "cross-origin-resource-policy") continue
                    cors[k] = v.joinToString(", ")
                }
                val ct = c.contentType ?: "application/octet-stream"
                val mime = ct.substringBefore(';').trim().ifEmpty { "application/octet-stream" }
                val enc = Regex("charset=([^;\\s]+)", RegexOption.IGNORE_CASE).find(ct)?.groupValues?.get(1)?.trim('"')
                val body: InputStream = try { (if (code >= 400) c.errorStream else c.inputStream) ?: "".byteInputStream() } catch (e: IOException) { "".byteInputStream() }
                val stream = object : FilterInputStream(body) {          // отмена запроса страницей закрывает поток — закрываем и соединение
                    override fun close() { try { super.close() } finally { c.disconnect() } }
                }
                return WebResourceResponse(mime, enc, code, c.responseMessage?.ifEmpty { null } ?: "OK", cors, stream)
            }
            return WebResourceResponse("text/plain", "utf-8", 502, "Bad Gateway", cors, "bad redirect".byteInputStream())
        } catch (e: Exception) {
            return WebResourceResponse("text/plain", "utf-8", 502, "Bad Gateway", cors, ("fetch failed: " + e.message).byteInputStream())
        }
    }
}
