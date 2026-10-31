package app.dsp.phone

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject

/** Список патчей для автозапуска без окна («boot patches»): «имя; имя» или по одному в строке. */
object BootPatches {
    const val MAX = 6
    fun parse(s: String?): List<String> =
        (s ?: "").split(';', '\n').map { it.trim() }.filter { it.isNotEmpty() && it.length <= 200 }.distinct().take(MAX)

    /** Адрес страницы: открыть патч по имени, запустить, режим hl=1 (страница не пишет автосохранение — им владеет окно приложения). */
    fun url(name: String): String = Config.APP_ORIGIN + "/index.html" + Launch.hash(name, null, true, false) + "&hl=1"
}

/**
 * Патчи без окна: на каждый — свой WebView в окне 1×1 пиксель поверх приложений (TYPE_APPLICATION_OVERLAY, не принимает касаний).
 * Окно «видимо» для системы, поэтому таймеры, аудио и воркеры страницы не душатся, как у не показанного WebView; нужно разрешение
 * «Показ поверх других окон» (то же, что у окон-индикаторов). Хранилище общее с основным окном (патчи из «Patches»); граф, которым
 * владеет окно приложения, и автозапуск не мешают друг другу — страница с hl=1 автосохранение не пишет.
 * Команды страницы: boot.set / list / run / stop (только страница приложения).
 */
class HeadlessHub(private val ctx: Context, private val cfg: Config, private val emit: Emit) {
    private val app = ctx.applicationContext
    private val ui = Handler(Looper.getMainLooper())
    private val pages = LinkedHashMap<String, WebView>()           // только основной поток
    @Volatile private var names: List<String> = emptyList()
    private val wm get() = app.getSystemService(Context.WINDOW_SERVICE) as WindowManager

    fun running(): List<String> = names

    fun startAll() { ui.post { for (n in BootPatches.parse(cfg.bootPatches)) open(n) } }

    /** null — запуск принят; иначе причина отказа. */
    fun start(name: String): String? {
        if (!FloatWin.can(app)) return "needs «Display over other apps» for DSP (Settings → Apps → DSP) — a window of 1 pixel hosts the page"
        ui.post { open(name) }
        return null
    }

    fun stop(name: String) { ui.post { close(name) } }
    fun stopAll() { ui.post { pages.keys.toList().forEach { close(it) } } }

    private fun note(ev: String, name: String, why: String? = null) =
        emit("sys", Json.obj("src" to "\"sys\"", "ev" to Json.str("boot.$ev"), "t" to System.currentTimeMillis().toString(), "name" to Json.str(name), "why" to why?.let { Json.str(it) }))

    @SuppressLint("SetJavaScriptEnabled")
    private fun open(name: String) {
        close(name)
        if (pages.size >= BootPatches.MAX) { note("failed", name, "at most ${BootPatches.MAX} patches at once"); return }
        if (!FloatWin.can(app)) { note("failed", name, "no permission «Display over other apps»"); return }
        val web = WebView(app)
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        web.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true; mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false; allowContentAccess = false; mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        web.addJavascriptInterface(HeadlessApp(app), "DspApp")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(v: WebView, r: WebResourceRequest): WebResourceResponse? = PageAssets.serve(app, r)
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean = r.url.host != Config.APP_HOST
            override fun onRenderProcessGone(v: WebView, d: RenderProcessGoneDetail): Boolean {       // страница упала — поднимаем заново
                note("crashed", name)
                ui.post { close(name); ui.postDelayed({ if (name in BootPatches.parse(cfg.bootPatches)) open(name) }, 3000) }
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(r: PermissionRequest) {      // микрофон и камера, если разрешение у приложения уже есть
                ui.post {
                    if (!r.origin.toString().startsWith(Config.APP_ORIGIN)) { r.deny(); return@post }
                    val ok = r.resources.filter {
                        (it == PermissionRequest.RESOURCE_AUDIO_CAPTURE && app.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) ||
                        (it == PermissionRequest.RESOURCE_VIDEO_CAPTURE && app.checkSelfPermission(android.Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED)
                    }
                    if (ok.isEmpty()) r.deny() else r.grant(ok.toTypedArray())
                }
            }
            override fun onGeolocationPermissionsShowPrompt(origin: String, cb: android.webkit.GeolocationPermissions.Callback) {
                cb.invoke(origin, app.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED, false)
            }
        }
        val lp = WindowManager.LayoutParams(1, 1, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT).apply { gravity = Gravity.TOP or Gravity.START; title = "dsp-headless" }
        try { wm.addView(web, lp) } catch (e: Exception) { web.destroy(); note("failed", name, e.message); return }
        pages[name] = web; names = pages.keys.toList()
        web.loadUrl(BootPatches.url(name))
        note("started", name)
    }

    private fun close(name: String) {
        val web = pages.remove(name) ?: return
        names = pages.keys.toList()
        try { wm.removeView(web) } catch (e: Exception) { }
        try { web.stopLoading(); web.destroy() } catch (e: Exception) { }
        note("stopped", name)
    }

    fun shutdown() { ui.post { pages.keys.toList().forEach { close(it) } } }

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        if (!c.trusted) return Reply.done(c, id, cmd, "only the page of the DSP app may use it", "forbidden")
        fun list(k: String): List<String> {
            val a = j.optJSONArray(k)
            return if (a != null) (0 until a.length()).map { a.optString(it) }.let { BootPatches.parse(it.joinToString(";")) } else BootPatches.parse(j.optString(k))
        }
        when (cmd) {
            "boot.set" -> {
                val l = list("patches"); cfg.bootPatches = l.joinToString(";")
                Reply.done(c, id, cmd, null, extra = arrayOf("n" to l.size.toString()))
            }
            "boot.list" -> {
                val cfgd = BootPatches.parse(cfg.bootPatches); val run = running()
                val rows = (cfgd + run.filter { it !in cfgd }).map { n -> Json.obj("src" to "\"boot\"", "name" to Json.str(n), "boot" to (n in cfgd).toString(), "running" to (n in run).toString()) }
                if (rows.isNotEmpty()) c.send(Json.rows(rows))
                Reply.done(c, id, cmd, null, extra = arrayOf("n" to rows.size.toString(), "overlay" to FloatWin.can(app).toString()))
            }
            "boot.run" -> {
                val l = list("name").ifEmpty { BootPatches.parse(cfg.bootPatches) }
                if (l.isEmpty()) return Reply.done(c, id, cmd, "no patch: give name, or set the list with boot.set first", "args")
                for (n in l) { val e = start(n); if (e != null) return Reply.done(c, id, cmd, e, "permission") }
                Reply.done(c, id, cmd, null, extra = arrayOf("n" to l.size.toString()))
            }
            "boot.stop" -> {
                val l = list("name"); if (l.isEmpty()) stopAll() else l.forEach { stop(it) }
                Reply.done(c, id, cmd, null)
            }
            else -> Reply.done(c, id, cmd, "unknown boot command", "args")
        }
    }
}

/** DspApp для страницы без окна: страница видит приложение (адрес USB-моста, ключ), но окон, PiP и обоев у неё нет. */
class HeadlessApp(private val ctx: Context) {
    @JavascriptInterface fun appKey(): String = UsbKey.value
    @JavascriptInterface fun usbUrl(): String {
        val c = Config(ctx)
        return "ws://127.0.0.1:${c.port}/usb?k=${UsbKey.value}" + (if (c.strict && c.token.isNotEmpty()) "&token=${c.token}" else "")
    }
    @JavascriptInterface fun pip(w: Int, h: Int): Boolean = false
    @JavascriptInterface fun pipOff() {}
    @JavascriptInterface fun floatCan(): Boolean = false
    @JavascriptInterface fun floatPerm(): Boolean = false
    @JavascriptInterface fun floatShow(id: String, opts: String): Boolean = false
    @JavascriptInterface fun floatFrame(id: String, b64: String) {}
    @JavascriptInterface fun floatClose(id: String) {}
    @JavascriptInterface fun wallpaper(b64: String) {}
    @JavascriptInterface fun wallpaperPick(): Boolean = false
    @JavascriptInterface fun chunk(id: String, name: String, mime: String, b64: String, last: Boolean) {}
}
