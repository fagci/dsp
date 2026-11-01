@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package app.dsp.phone

import android.app.Activity
import android.content.Context
import android.graphics.Color
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
    private var lock: WifiManager.MulticastLock? = null
    private var prevUi = 0
    private var title = ""
    private val h = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() { report(null); h.postDelayed(this, 500) }
    }

    override fun isOpen(): Boolean = player != null

    override fun open(json: String): Boolean {
        val j = try { JSONObject(json) } catch (e: Exception) { return false }
        val url = j.optString("url").trim()
        if (url.isEmpty()) return false
        act.runOnUiThread {
            try { start(url, j.optLong("pos", 0), j.optBoolean("autoplay", true), j.optDouble("speed", 1.0).toFloat(), j.optString("title")) }
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

    private fun start(url: String, pos: Long, autoplay: Boolean, speed: Float, ttl: String) {
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
        h.removeCallbacks(tick); h.post(tick)
        report(null)
    }

    private fun close(silent: Boolean = false) {
        h.removeCallbacks(tick)
        val p = player
        val last = if (p != null) JSONObject().put("t", "state").put("pos", p.currentPosition).put("dur", if (p.duration == C.TIME_UNSET) 0L else p.duration) else null
        player = null
        try { p?.release() } catch (e: Exception) {}
        root?.let { (it.parent as? ViewGroup)?.removeView(it) }
        root = null
        @Suppress("DEPRECATION")
        run { if (p != null) act.window.decorView.systemUiVisibility = prevUi }
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
            .put("buffering", p.playbackState == Player.STATE_BUFFERING).put("live", p.isCurrentMediaItemLive)
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
