package app.dsp.phone

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.IOException

/** Страницы приложения из assets/www (для окна MainActivity и для фонового хоста Headless) и чужие адреса через CorsProxy. */
object PageAssets {
    fun serve(ctx: Context, r: WebResourceRequest): WebResourceResponse? =
        if (r.url.host == Config.APP_HOST) asset(ctx, r.url) else CorsProxy.handle(r)

    private fun asset(ctx: Context, u: Uri): WebResourceResponse? {
        var path = u.path ?: "/"
        if (path == "/") path = "/index.html"
        val h = mapOf("Cross-Origin-Opener-Policy" to "same-origin", "Cross-Origin-Embedder-Policy" to "credentialless",
            "Cross-Origin-Resource-Policy" to "same-origin", "Cache-Control" to "no-cache")
        val bad = path.contains("..") || path == "/sw.js"
        val stream = if (bad) null else try { ctx.assets.open("www$path") } catch (e: IOException) { null }
        if (stream == null) return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", h, "".byteInputStream())
        val mime = mimeOf(path)
        return WebResourceResponse(mime, if (mime.startsWith("text/") || mime.contains("json") || mime.contains("javascript")) "utf-8" else null, 200, "OK", h, stream)
    }

    private fun mimeOf(path: String) = when (path.substringAfterLast('.', "").lowercase()) {
        "html", "htm" -> "text/html"
        "js", "mjs" -> "text/javascript"
        "css" -> "text/css"
        "json", "geojson" -> "application/json"
        "wasm" -> "application/wasm"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        "ico" -> "image/x-icon"
        "txt", "csv", "tsv" -> "text/plain"
        "md" -> "text/markdown"
        "mp3" -> "audio/mpeg"
        "woff2" -> "font/woff2"
        else -> "application/octet-stream"
    }
}
