package app.dsp.phone

import android.Manifest
import android.app.Activity
import android.app.PictureInPictureParams
import android.content.res.Configuration
import android.util.Rational
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.app.WallpaperManager
import android.graphics.BitmapFactory
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
open class MainActivity : Activity() {
    /** Пусто — основное окно; s1…s3 — окна-слоты в своих процессах (свой WebView и хранилище, см. Slots.kt). */
    protected open val slot: String = ""
    private lateinit var web: WebView
    private var chooser: ValueCallback<Array<Uri>>? = null
    private var pendingWeb: PermissionRequest? = null

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        UsbKey.init(this)
        if (slot.isNotEmpty() && Build.VERSION.SDK_INT >= 28) try { WebView.setDataDirectorySuffix(slot) } catch (e: Exception) {}
        BridgeService.start(this)
        // остальные разрешения (положение, камера, микрофон, Bluetooth, шаги) мост спрашивает сам, когда страница выбирает источник
        if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_MAIN)

        web = WebView(this)
        // процесс страницы остаётся «важным», даже когда окно приложения не на экране: иначе Android в фоне замораживает её, и всё, что она рисует в окна поверх приложений / обои, замирает
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
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
            override fun shouldInterceptRequest(v: WebView, r: WebResourceRequest): WebResourceResponse? = serve(r)
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                if (r.url.host == Config.APP_HOST) return false
                try { startActivity(Intent(Intent.ACTION_VIEW, r.url)) } catch (e: Exception) {}
                return true
            }
        }
        // страницы и воркеры — из assets; сервис-воркер приложению не нужен (файлы и так локальные)
        ServiceWorkerController.getInstance().setServiceWorkerClient(object : ServiceWorkerClient() {
            override fun shouldInterceptRequest(r: WebResourceRequest): WebResourceResponse? = serve(r)
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
        web.loadUrl(Config.APP_ORIGIN + "/index.html" + Launch.hash(intent, Config(this)))
    }

    // ---------- картинка в картинке: окно приложения целиком; страница на это время показывает только зеркало холста ----------

    private var pipArmed = false
    private var pipRatio = Rational(16, 9)

    private fun enterPip(): Boolean = try {
        if (!packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_PICTURE_IN_PICTURE)) false
        else enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(pipRatio).build())
    } catch (e: Exception) { false }

    /** Кнопка «Домой» при открытом зеркале — тоже уходит в PiP, не сворачивает приложение. */
    override fun onUserLeaveHint() { if (pipArmed) enterPip() }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        web.evaluateJavascript("window.dspPip&&dspPip($isInPictureInPictureMode)", null)
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, res: IntArray) {
        when (code) {
            REQ_MAIN -> BridgeService.start(this)             // типы foreground-сервиса зависят от разрешений
            REQ_WEB -> {
                val r = pendingWeb ?: return
                pendingWeb = null
                if (res.isNotEmpty() && res.all { it == PackageManager.PERMISSION_GRANTED }) r.grant(r.resources) else r.deny()
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

    // singleTask: клик по уведомлению и возврат из фона onCreate не вызывают — мост, убитый системой, поднимаем здесь
    override fun onNewIntent(i: Intent) {
        super.onNewIntent(i); setIntent(i); BridgeService.resume(this)
        // окно уже открыто: патч и запуск передаём странице через хэш (hashchange → loadFromHash)
        val h = Launch.hash(i, Config(this))
        if (h.isNotEmpty()) web.evaluateJavascript("location.hash=${JSONObject.quote(h)}", null)
    }
    override fun onRestart() { super.onRestart(); BridgeService.resume(this) }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else moveTaskToBack(true)     // мост остаётся работать
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    // ---------- файлы приложения ----------

    private fun serve(r: WebResourceRequest): WebResourceResponse? =
        if (r.url.host == Config.APP_HOST) asset(r.url) else CorsProxy.handle(r)

    private fun asset(u: Uri): WebResourceResponse? {
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
        "md" -> "text/markdown"
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
        /** Адрес USB-API моста для этой страницы (с ключом, который другие сайты не знают); веб-часть строит из него navigator.usb. */
        /** Окно приложения в PiP с отношением сторон w:h (Android принимает 1:2.39 … 2.39:1). false — на телефоне PiP нет. */
        @JavascriptInterface
        fun pip(w: Int, h: Int): Boolean {
            if (w <= 0 || h <= 0) return false
            pipRatio = Rational(w, h); pipArmed = true
            var ok = false
            val l = java.util.concurrent.CountDownLatch(1)
            runOnUiThread { ok = enterPip(); l.countDown() }
            l.await(1, java.util.concurrent.TimeUnit.SECONDS)
            return ok
        }

        /** Зеркало закрыто: «Домой» снова просто сворачивает приложение. */
        @JavascriptInterface
        fun pipOff() { pipArmed = false }

        /** Ключ приложения: страница добавляет его к адресу моста (?k=…), и ей открыты SMS и контакты; другие сайты его не знают. */
        @JavascriptInterface
        fun appKey(): String = UsbKey.value

        /** Кадр для живых обоев (modules/wallpaper.js): base64 JPEG → LiveWallpaperService. Декодирование — не в основном потоке: кадры идут несколько раз в секунду. */
        @JavascriptInterface
        fun wallpaper(b64: String) {
            Thread {
                try {
                    val b = Base64.decode(b64, Base64.DEFAULT)
                    val bmp = BitmapFactory.decodeByteArray(b, 0, b.size) ?: return@Thread
                    LiveWallpaperService.push(bmp)
                } catch (e: Exception) { /* битый кадр — следующий придёт через доли секунды */ }
            }.also { it.isDaemon = true }.start()
        }

        /** Можно ли показывать окна поверх других приложений («Показ поверх других окон»). */
        @JavascriptInterface
        fun floatCan(): Boolean = FloatWin.can(this@MainActivity)

        /** Открыть системный экран с этим разрешением; true — экран открыт. */
        @JavascriptInterface
        fun floatPerm(): Boolean {
            runOnUiThread { Toast.makeText(this@MainActivity, "Allow «Display over other apps» for DSP, then press the button again", Toast.LENGTH_LONG).show() }
            return try { startActivity(FloatWin.permissionIntent(this@MainActivity)); true } catch (e: Exception) { false }
        }

        /** Окно поверх приложений для узла id (modules/floatwin.js); opts — JSON {opacity, through, w}. false — разрешения нет. */
        @JavascriptInterface
        fun floatShow(id: String, opts: String): Boolean {
            if (!FloatWin.can(this@MainActivity)) return false
            // кадры снимает страница, но её таймеры и rAF в фоне душатся — поэтому окно само дёргает floatTick из нативного потока
            FloatWin.pump = { web.evaluateJavascript("window.floatTick&&floatTick()", null) }
            FloatWin.onClosed = { cid ->
                runOnUiThread { web.evaluateJavascript("window.floatClosed&&floatClosed(" + JSONObject.quote(cid) + ")", null) }
            }
            val o = try { JSONObject(opts) } catch (e: Exception) { JSONObject() }
            FloatWin.show(this@MainActivity, id, o)
            return true
        }

        /** Кадр окна: base64 WebP / JPEG / PNG; декодирование — не в основном потоке. */
        @JavascriptInterface
        fun floatFrame(id: String, b64: String) {
            Thread {
                try {
                    val b = Base64.decode(b64, Base64.DEFAULT)
                    val bmp = BitmapFactory.decodeByteArray(b, 0, b.size) ?: return@Thread
                    FloatWin.frame(id, bmp)
                } catch (e: Exception) { /* битый кадр — следующий придёт через доли секунды */ }
            }.also { it.isDaemon = true }.start()
        }

        @JavascriptInterface
        fun floatClose(id: String) { FloatWin.close(id) }

        /** Системный выбор «Задать живые обои» на DspLiveWallpaperService; ничего не делает, если обои не поддерживаются. */
        @JavascriptInterface
        fun wallpaperPick(): Boolean {
            val i = Intent(WallpaperManager.ACTION_CHANGE_LIVE_WALLPAPER)
                .putExtra(WallpaperManager.EXTRA_LIVE_WALLPAPER_COMPONENT, android.content.ComponentName(this@MainActivity, LiveWallpaperService::class.java))
            return try { startActivity(i); true } catch (e: Exception) { false }
        }

        @JavascriptInterface
        fun usbUrl(): String {
            val c = Config(this@MainActivity)
            return "ws://127.0.0.1:${c.port}/usb?k=${UsbKey.value}" + (if (c.strict && c.token.isNotEmpty()) "&token=${c.token}" else "")
        }

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
