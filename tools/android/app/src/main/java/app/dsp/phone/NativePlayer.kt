@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package app.dsp.phone

import android.app.Activity
import android.content.Context
import android.annotation.SuppressLint
import android.graphics.Color
import android.graphics.PixelFormat
import android.view.MotionEvent
import android.view.WindowManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.UdpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.ui.PlayerView
import org.json.JSONObject

/**
 * Нативный плеер страницы (см. PlayerApi): ExoPlayer на системных декодерах, картинка на весь экран поверх WebView со своими
 * кнопками (перемотка, пауза, дорожки) и крестиком. Состояние уходит странице в window.dspPlayer({...}) дважды в секунду, команды
 * приходят через DspApp.playerCmd. Адреса: http(s) файл / HLS / DASH, rtsp://, udp://@239.x.x.x:порт (голый MPEG-TS) и
 * rtp://@239.x.x.x:порт (RTP с MPEG-TS; заголовок снимает RtpDataSource). Для multicast держится Wi-Fi multicast lock.
 */
class NativePlayer(private val act: Activity, private val web: WebView) : PlayerApi {
    private var player: ExoPlayer? = null
    private var root: FrameLayout? = null
    private var fview: FrameLayout? = null            // плавающее окно поверх других приложений (вместо экрана)
    private var fwm: WindowManager? = null
    private var lock: WifiManager.MulticastLock? = null
    private var prevUi = 0
    private var title = ""
    private val h = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() { report(null); h.postDelayed(this, 500) }
    }

    /** Открыт на весь экран (Назад закрывает); плавающее окно живёт само, Назад его не трогает. */
    override fun isOpen(): Boolean = player != null && fview == null

    override fun open(json: String): Boolean {
        val j = try { JSONObject(json) } catch (e: Exception) { return false }
        val url = j.optString("url").trim()
        if (url.isEmpty()) return false
        act.runOnUiThread {
            try { start(url, j.optLong("pos", 0), j.optBoolean("autoplay", true), j.optDouble("speed", 1.0).toFloat(), j.optString("title"), j.optBoolean("float", false)) }
            catch (e: Exception) { send(JSONObject().put("t", "state").put("err", e.message ?: e.javaClass.simpleName).put("closed", true)) }
        }
        return true
    }

    override fun cmd(json: String) {
        val j = try { JSONObject(json) } catch (e: Exception) { return }
        act.runOnUiThread {
            val p = player ?: return@runOnUiThread
            val v = j.optDouble("v", 0.0)
            when (j.optString("a")) {
                "play" -> p.play()
                "pause" -> p.pause()
                "toggle" -> if (p.isPlaying) p.pause() else p.play()
                "seek" -> p.seekTo(v.toLong().coerceAtLeast(0))
                "seekBy" -> p.seekTo((p.currentPosition + v.toLong()).coerceAtLeast(0).let { if (p.duration != C.TIME_UNSET) it.coerceAtMost(p.duration) else it })
                "speed" -> p.playbackParameters = PlaybackParameters(v.toFloat().coerceIn(0.25f, 4f))
                "close" -> close()
            }
            report(null)
        }
    }

    override fun release() { act.runOnUiThread { close(silent = true) } }

    private fun start(url: String, pos: Long, autoplay: Boolean, speed: Float, ttl: String, floating: Boolean = false) {
        close(silent = true)
        title = ttl
        val scheme = Uri.parse(url).scheme?.lowercase() ?: ""
        val multicast = scheme == "udp" || scheme == "rtp"
        if (multicast) acquireLock()
        val item = MediaItem.Builder().setUri(if (multicast) RtpStrip.udpUrl(url) else url).apply {
            if (multicast) setMimeType(MimeTypes.VIDEO_MP2T)              // у адреса нет расширения: считаем, что внутри MPEG-TS
        }.build()
        val factory: MediaSource.Factory = when (scheme) {
            "rtp" -> ProgressiveMediaSource.Factory(DataSource.Factory { RtpDataSource() })
            "udp" -> ProgressiveMediaSource.Factory(DataSource.Factory { UdpDataSource() })
            else -> DefaultMediaSourceFactory(act)
        }
        val p = ExoPlayer.Builder(act).build()
        p.setMediaSource(factory.createMediaSource(item))
        p.playbackParameters = PlaybackParameters(speed.coerceIn(0.25f, 4f))
        p.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) { report(null) }
            override fun onIsPlayingChanged(isPlaying: Boolean) { report(null) }
            override fun onPlayerError(e: PlaybackException) { report(e.errorCodeName + (e.message?.let { ": $it" } ?: "")) }
        })
        p.prepare()
        if (pos > 0) p.seekTo(pos)
        p.playWhenReady = autoplay
        player = p

        if (floating) buildFloat(p) else buildFullscreen(p)
        h.removeCallbacks(tick); h.post(tick)
        report(null)
    }

    private fun buildFullscreen(p: ExoPlayer) {
        val box = FrameLayout(act)
        box.setBackgroundColor(Color.BLACK)
        val pv = PlayerView(act)
        pv.player = p
        pv.keepScreenOn = true
        pv.controllerShowTimeoutMs = 3500
        box.addView(pv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val x = TextView(act)
        x.text = "✕"; x.textSize = 22f; x.setTextColor(Color.WHITE); x.setPadding(36, 20, 36, 20)
        x.setBackgroundColor(0x66000000)
        x.setOnClickListener { close() }
        val lp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.END)
        box.addView(x, lp)
        val deco = act.window.decorView as ViewGroup
        deco.addView(box, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root = box
        @Suppress("DEPRECATION")
        run {
            prevUi = deco.systemUiVisibility
            deco.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        }
    }

    /**
     * Окно поверх других приложений (разрешение «Показ поверх других окон», как у FloatWin): ExoPlayer прямо в окне, поэтому показывает любой поток,
     * в том числе без CORS, — кадры через холст страницы тут не нужны. ✥ двигает, ◢ меняет размер (16:9), ✕ закрывает; кнопки перемотки — на самом плеере.
     */
    @SuppressLint("ClickableViewAccessibility")
    private fun buildFloat(p: ExoPlayer) {
        val app = act.applicationContext
        val wm = app.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val dm = app.resources.displayMetrics
        val w0 = (dm.widthPixels * 0.62f).toInt().coerceAtLeast(360)
        val lp = WindowManager.LayoutParams(w0, w0 * 9 / 16, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, PixelFormat.TRANSLUCENT)
        lp.gravity = Gravity.TOP or Gravity.START
        lp.x = dm.widthPixels / 5; lp.y = dm.heightPixels / 6
        val box = FrameLayout(app)
        box.setBackgroundColor(Color.BLACK)
        val pv = PlayerView(app)
        pv.player = p
        pv.controllerShowTimeoutMs = 3000
        box.addView(pv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        fun handle(txt: String, gravity: Int): TextView {
            val t = TextView(app)
            t.text = txt; t.textSize = 18f; t.setTextColor(Color.WHITE); t.setPadding(26, 12, 26, 12); t.setBackgroundColor(0x66000000)
            box.addView(t, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, gravity))
            return t
        }
        val move = handle("✥", Gravity.TOP or Gravity.START)
        val xBtn = handle("✕", Gravity.TOP or Gravity.END)
        val grip = handle("◢", Gravity.BOTTOM or Gravity.END)
        xBtn.setOnClickListener { close() }
        var sx = 0f; var sy = 0f; var ox = 0; var oy = 0; var ow = 0
        move.setOnTouchListener { _, e ->
            when (e.action) {
                MotionEvent.ACTION_DOWN -> { sx = e.rawX; sy = e.rawY; ox = lp.x; oy = lp.y }
                MotionEvent.ACTION_MOVE -> { lp.x = ox + (e.rawX - sx).toInt(); lp.y = oy + (e.rawY - sy).toInt(); try { wm.updateViewLayout(box, lp) } catch (x: Exception) { } }
            }
            true
        }
        grip.setOnTouchListener { _, e ->
            when (e.action) {
                MotionEvent.ACTION_DOWN -> { sx = e.rawX; ow = lp.width }
                MotionEvent.ACTION_MOVE -> {
                    lp.width = (ow + (e.rawX - sx).toInt()).coerceIn(300, dm.widthPixels); lp.height = lp.width * 9 / 16
                    try { wm.updateViewLayout(box, lp) } catch (x: Exception) { }
                }
            }
            true
        }
        wm.addView(box, lp)
        fview = box; fwm = wm
    }

    private fun close(silent: Boolean = false) {
        h.removeCallbacks(tick)
        val p = player
        val last = if (p != null) JSONObject().put("t", "state").put("pos", p.currentPosition).put("dur", if (p.duration == C.TIME_UNSET) 0L else p.duration) else null
        player = null
        try { p?.release() } catch (e: Exception) {}
        val wasFull = root != null
        root?.let { (it.parent as? ViewGroup)?.removeView(it) }
        root = null
        fview?.let { try { fwm?.removeView(it) } catch (e: Exception) { } }
        fview = null; fwm = null
        @Suppress("DEPRECATION")
        run { if (p != null && wasFull) act.window.decorView.systemUiVisibility = prevUi }
        try { lock?.release() } catch (e: Exception) {}
        lock = null
        if (!silent && last != null) send(last.put("playing", false).put("closed", true))
    }

    private fun acquireLock() {
        try {
            val wm = act.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            lock = wm.createMulticastLock("dsp-player").also { it.setReferenceCounted(false); it.acquire() }
        } catch (e: Exception) {}
    }

    private fun report(err: String?) {
        val p = player ?: return
        val o = JSONObject().put("t", "state")
            .put("pos", p.currentPosition).put("dur", if (p.duration == C.TIME_UNSET) 0L else p.duration)
            .put("playing", p.isPlaying).put("ended", p.playbackState == Player.STATE_ENDED)
            .put("buffering", p.playbackState == Player.STATE_BUFFERING).put("live", p.isCurrentMediaItemLive).put("float", fview != null)
        if (err != null) o.put("err", err)
        send(o)
    }

    private fun send(o: JSONObject) {
        o.put("title", title)
        web.evaluateJavascript("window.dspPlayer&&dspPlayer($o)", null)
    }

    /** rtp://: UDP-датаграммы без заголовка RTP — голый MPEG-TS для TsExtractor. */
    private class RtpDataSource : BaseDataSource(true) {
        private val udp = UdpDataSource()
        private val buf = ByteArray(8192)
        private var pos = 0
        private var lim = 0

        override fun open(dataSpec: DataSpec): Long {
            transferInitializing(dataSpec)
            udp.open(dataSpec.buildUpon().setUri(Uri.parse(RtpStrip.udpUrl(dataSpec.uri.toString()))).build())
            pos = 0; lim = 0
            transferStarted(dataSpec)
            return C.LENGTH_UNSET.toLong()
        }

        override fun read(target: ByteArray, offset: Int, length: Int): Int {
            if (length == 0) return 0
            while (pos >= lim) {
                val n = udp.read(buf, 0, buf.size)
                if (n == C.RESULT_END_OF_INPUT) return n
                val s = RtpStrip.span(buf, n) ?: continue                // не RTP — пропускаем датаграмму
                pos = s.off; lim = s.off + s.len
            }
            val c = minOf(length, lim - pos)
            System.arraycopy(buf, pos, target, offset, c)
            pos += c
            bytesTransferred(c)
            return c
        }

        override fun getUri(): Uri? = udp.uri

        override fun close() {
            try { udp.close() } finally { pos = 0; lim = 0; transferEnded() }
        }
    }
}
