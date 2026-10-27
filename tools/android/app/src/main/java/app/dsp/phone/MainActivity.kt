package app.dsp.phone

import android.Manifest
import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ServiceWorkerClient
import android.webkit.ServiceWorkerController
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.OutputStream

/** DSP в WebView: страницы из assets/www (работает без сети) + запуск моста датчиков и камеры. */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private var chooser: ValueCallback<Array<Uri>>? = null
    private var pendingWeb: PermissionRequest? = null

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        BridgeService.start(this)
        val need = mutableListOf(Manifest.permission.CAMERA, Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33) need.add(Manifest.permission.POST_NOTIFICATIONS)
        if (Build.VERSION.SDK_INT >= 31) { need.add(Manifest.permission.BLUETOOTH_SCAN); need.add(Manifest.permission.BLUETOOTH_CONNECT) }
        val miss = need.filter { !granted(it) }
        if (miss.isNotEmpty()) requestPermissions(miss.toTypedArray(), REQ_MAIN)

        web = WebView(this)
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        web.addJavascriptInterface(Downloads(), "DspApp")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(v: WebView, r: WebResourceRequest): WebResourceResponse? = serve(r.url)
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                if (r.url.host == Config.APP_HOST) return false
                try { startActivity(Intent(Intent.ACTION_VIEW, r.url)) } catch (e: Exception) {}
                return true
            }
        }
        // страницы и воркеры — из assets; сервис-воркер приложению не нужен (файлы и так локальные)
        ServiceWorkerController.getInstance().setServiceWorkerClient(object : ServiceWorkerClient() {
            override fun shouldInterceptRequest(r: WebResourceRequest): WebResourceResponse? = serve(r.url)
        })
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(r: PermissionRequest) {
                runOnUiThread {
                    if (!r.origin.toString().startsWith(Config.APP_ORIGIN)) { r.deny(); return@runOnUiThread }
                    val miss = ArrayList<String>()
                    for (res in r.resources) {
                        if (res == PermissionRequest.RESOURCE_VIDEO_CAPTURE && !granted(Manifest.permission.CAMERA)) miss.add(Manifest.permission.CAMERA)
                        if (res == PermissionRequest.RESOURCE_AUDIO_CAPTURE && !granted(Manifest.permission.RECORD_AUDIO)) miss.add(Manifest.permission.RECORD_AUDIO)
                    }
                    if (miss.isEmpty()) r.grant(r.resources)
                    else { pendingWeb?.deny(); pendingWeb = r; requestPermissions(miss.toTypedArray(), REQ_WEB) }
                }
            }
            override fun onGeolocationPermissionsShowPrompt(origin: String, cb: GeolocationPermissions.Callback) {
                cb.invoke(origin, hasLocation(), false)
            }
            override fun onShowFileChooser(v: WebView, cb: ValueCallback<Array<Uri>>, p: FileChooserParams): Boolean {
                chooser?.onReceiveValue(null)
                chooser = cb
                val i = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                    .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, p.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                try { startActivityForResult(Intent.createChooser(i, null), REQ_FILE) }
                catch (e: Exception) { chooser = null; cb.onReceiveValue(null); return false }
                return true
            }
        }
        web.setDownloadListener { url, _, disp, mime, _ ->
            if (url.startsWith("blob:")) {
                val name = URLUtil.guessFileName(url, disp, mime)
                web.evaluateJavascript(blobJs(url, name, mime ?: ""), null)
            } else {
                try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (e: Exception) {}
            }
        }
        web.loadUrl(Config.APP_ORIGIN + "/index.html")
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, res: IntArray) {
        when (code) {
            REQ_MAIN -> BridgeService.start(this)             // типы foreground-сервиса зависят от разрешений
            REQ_WEB -> {
                val r = pendingWeb ?: return
                pendingWeb = null
                if (res.isNotEmpty() && res.all { it == PackageManager.PERMISSION_GRANTED }) r.grant(r.resources) else r.deny()
                if (perms.contains(Manifest.permission.CAMERA)) BridgeService.start(this)
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(code: Int, result: Int, data: Intent?) {
        if (code == REQ_FILE) {
            chooser?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data))
            chooser = null
        } else super.onActivityResult(code, result, data)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else moveTaskToBack(true)     // мост остаётся работать
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    // ---------- файлы приложения ----------

    private fun serve(u: Uri): WebResourceResponse? {
        if (u.host != Config.APP_HOST) return null
        var path = u.path ?: "/"
        if (path == "/") path = "/index.html"
        val h = mapOf("Cross-Origin-Opener-Policy" to "same-origin", "Cross-Origin-Embedder-Policy" to "credentialless",
            "Cross-Origin-Resource-Policy" to "same-origin", "Cache-Control" to "no-cache")
        val bad = path.contains("..") || path == "/sw.js"
        val stream = if (bad) null else try { assets.open("www$path") } catch (e: IOException) { null }
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
        "mp3" -> "audio/mpeg"
        "woff2" -> "font/woff2"
        else -> "application/octet-stream"
    }

    // ---------- скачивание blob: страница читает файл кусками и отдаёт сюда ----------

    private fun blobJs(url: String, name: String, mime: String) =
        "(async()=>{const b=await (await fetch(${JSONObject.quote(url)})).blob(),id=String(Date.now()),N=1<<20;" +
            "for(let o=0;o<b.size||o===0;o+=N){const s=await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result.split(',')[1]||'');f.readAsDataURL(b.slice(o,o+N));});" +
            "DspApp.chunk(id,${JSONObject.quote(name)},${JSONObject.quote(mime)},s,o+N>=b.size);if(b.size===0)break;}})()"

    inner class Downloads {
        private var id = ""
        private var out: OutputStream? = null
        private var label = ""

        @JavascriptInterface
        @Synchronized
        fun chunk(id: String, name: String, mime: String, b64: String, last: Boolean) {
            try {
                if (id != this.id) { out?.close(); out = open(name, mime); this.id = id; label = name }
                if (b64.isNotEmpty()) out?.write(Base64.decode(b64, Base64.DEFAULT))
                if (last) {
                    out?.close(); out = null; this.id = ""
                    runOnUiThread { Toast.makeText(this@MainActivity, "Saved to Downloads: $label", Toast.LENGTH_LONG).show() }
                }
            } catch (e: Exception) {
                try { out?.close() } catch (x: IOException) {}
                out = null; this.id = ""
                runOnUiThread { Toast.makeText(this@MainActivity, "Save failed: ${e.message}", Toast.LENGTH_LONG).show() }
            }
        }

        private fun open(name: String, mime: String): OutputStream {
            val safe = name.replace(Regex("[\\\\/:*?\"<>|]"), "_")
            if (Build.VERSION.SDK_INT >= 29) {
                val v = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, safe)
                    put(MediaStore.Downloads.MIME_TYPE, mime.ifEmpty { "application/octet-stream" })
                    put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                }
                val u = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v) ?: throw IOException("no Downloads")
                return contentResolver.openOutputStream(u) ?: throw IOException("cannot write")
            }
            val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: filesDir
            return File(dir, safe).outputStream()
        }
    }

    companion object {
        private const val REQ_MAIN = 1
        private const val REQ_WEB = 2
        private const val REQ_FILE = 3
    }
}
