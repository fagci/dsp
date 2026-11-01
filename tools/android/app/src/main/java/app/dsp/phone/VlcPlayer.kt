package app.dsp.phone

import android.app.Activity
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import org.json.JSONObject
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.util.VLCVideoLayout

/**
 * Нативный плеер на libVLC (LGPL 2.1): играет почти всё — mkv / avi / DivX, AC3 / DTS, multicast udp:// rtp://, rtsp://, rtmp://, и сам ходит в
 * smb:// ftp:// sftp:// nfs:// upnp:// (сетевые модули libVLC). Тот же PlayerApi, что у ExoPlayer: страница открывает его командами DspApp.player*,
 * состояние возвращается в window.dspPlayer. Внизу своя панель: ±10 с, пауза, ползунок, дорожки звука и субтитров (по кругу).
 */
class VlcPlayer(private val act: Activity, private val web: WebView) : PlayerApi {
    private var lib: LibVLC? = null
    private var mp: MediaPlayer? = null
    private var overlay: PlayerOverlay.Handle? = null
    private var floating = false
    private var title = ""
    private var pendingSeek = 0L
    private var lastErr: String? = null
    private var ended = false
    private var seekBar: SeekBar? = null
    private var timeView: TextView? = null
    private var playBtn: Button? = null
    private var dragging = false
    private val h = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() { updateUi(); report(null); h.postDelayed(this, 500) }
    }

    override fun isOpen(): Boolean = mp != null && !floating

    override fun open(json: String): Boolean {
        val j = try { JSONObject(json) } catch (e: Exception) { return false }
        val url = j.optString("url").trim()
        if (url.isEmpty()) return false
        act.runOnUiThread {
            try { start(url, j.optLong("pos", 0), j.optBoolean("autoplay", true), j.optDouble("speed", 1.0).toFloat(), j.optString("title"), j.optBoolean("float", false)) }
            catch (e: Throwable) { send(JSONObject().put("t", "state").put("err", e.message ?: e.javaClass.simpleName).put("closed", true)) }
        }
        return true
    }

    override fun cmd(json: String) {
        val j = try { JSONObject(json) } catch (e: Exception) { return }
        act.runOnUiThread {
            val p = mp ?: return@runOnUiThread
            val v = j.optDouble("v", 0.0)
            when (j.optString("a")) {
                "play" -> p.play()
                "pause" -> p.pause()
                "toggle" -> if (p.isPlaying) p.pause() else p.play()
                "seek" -> p.time = v.toLong().coerceAtLeast(0)
                "seekBy" -> p.time = (p.time + v.toLong()).coerceAtLeast(0).let { t -> if (p.length > 0) t.coerceAtMost(p.length) else t }
                "speed" -> p.rate = v.toFloat().coerceIn(0.25f, 4f)
                "close" -> close()
            }
            report(null)
        }
    }

    override fun release() { act.runOnUiThread { close(silent = true) } }

    private fun start(url: String, pos: Long, autoplay: Boolean, speed: Float, ttl: String, floatMode: Boolean) {
        close(silent = true)
        title = ttl; floating = floatMode; pendingSeek = pos; lastErr = null; ended = false
        val scheme = Uri.parse(url).scheme?.lowercase() ?: ""
        val opts = arrayListOf("--http-reconnect", "--network-caching=1500")
        val l = LibVLC(act.applicationContext, opts)
        val p = MediaPlayer(l)
        lib = l; mp = p
        val layout = VLCVideoLayout(act)
        p.attachViews(layout, null, true, false)
        val media = Media(l, Uri.parse(url))
        if (scheme == "udp" || scheme == "rtp") media.addOption(":network-caching=1000")      // multicast: меньше задержка
        p.media = media
        media.release()
        p.rate = speed
        p.setEventListener(MediaPlayer.EventListener { ev -> onEvent(ev) })

        val content = FrameLayout(act)
        content.addView(layout, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        content.addView(controls(), FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        overlay = if (floatMode) PlayerOverlay.floating(act, content) { onUserClosed() } else PlayerOverlay.fullscreen(act, content) { onUserClosed() }
        if (autoplay) p.play()
        h.removeCallbacks(tick); h.post(tick)
        report(null)
    }

    private fun controls(): LinearLayout {
        val bar = LinearLayout(act)
        bar.orientation = LinearLayout.HORIZONTAL
        bar.gravity = Gravity.CENTER_VERTICAL
        bar.setBackgroundColor(0x99000000.toInt())
        bar.setPadding(8, 4, 8, 4)
        fun btn(txt: String, f: () -> Unit): Button {
            val b = Button(act)
            b.text = txt; b.setTextColor(Color.WHITE); b.isAllCaps = false; b.minWidth = 0; b.minimumWidth = 0
            b.setPadding(14, 0, 14, 0); b.setBackgroundColor(0x00000000)
            b.setOnClickListener { f() }
            bar.addView(b, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            return b
        }
        btn("−10") { mp?.let { p -> p.time = (p.time - 10_000).coerceAtLeast(0) } }
        playBtn = btn("⏸") { mp?.let { p -> if (p.isPlaying) p.pause() else p.play() } }
        btn("+10") { mp?.let { p -> p.time = if (p.length > 0) (p.time + 10_000).coerceAtMost(p.length) else p.time + 10_000 } }
        val sb = SeekBar(act)
        sb.max = 1000
        sb.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(s: SeekBar, v: Int, fromUser: Boolean) { if (fromUser) mp?.let { p -> if (p.isSeekable) p.position = v / 1000f } }
            override fun onStartTrackingTouch(s: SeekBar) { dragging = true }
            override fun onStopTrackingTouch(s: SeekBar) { dragging = false }
        })
        bar.addView(sb, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val tv = TextView(act); tv.setTextColor(Color.WHITE); tv.textSize = 12f; tv.setPadding(10, 0, 10, 0)
        bar.addView(tv); timeView = tv; seekBar = sb
        btn("🔊") { cycleAudio() }
        btn("CC") { cycleSubs() }
        return bar
    }

    /** Следующая дорожка звука (по кругу). */
    private fun cycleAudio() {
        val p = mp ?: return
        val t = p.audioTracks ?: return
        if (t.size < 2) return
        val i = t.indexOfFirst { x -> x.id == p.audioTrack }
        p.audioTrack = t[(i + 1) % t.size].id
    }

    /** Следующие субтитры; после последних — выключены (-1). */
    private fun cycleSubs() {
        val p = mp ?: return
        val t = p.spuTracks ?: return
        val ids = t.map { x -> x.id }.filter { id -> id >= 0 }
        if (ids.isEmpty()) return
        val cur = p.spuTrack
        val i = ids.indexOf(cur)
        p.spuTrack = if (cur < 0) ids[0] else if (i + 1 < ids.size) ids[i + 1] else -1
    }

    private fun onEvent(ev: MediaPlayer.Event) {
        val p = mp ?: return
        when (ev.type) {
            MediaPlayer.Event.Playing -> { if (pendingSeek > 0) { p.time = pendingSeek; pendingSeek = 0 }; report(null) }
            MediaPlayer.Event.EndReached -> { ended = true; report(null) }
            MediaPlayer.Event.EncounteredError -> { lastErr = "libVLC cannot play this address (the format, the server or the credentials)"; report(lastErr) }
            MediaPlayer.Event.Paused, MediaPlayer.Event.Stopped -> report(null)
        }
    }

    private fun updateUi() {
        val p = mp ?: return
        val len = p.length
        if (!dragging && len > 0) seekBar?.progress = (p.time * 1000 / len).toInt().coerceIn(0, 1000)
        timeView?.text = fmt(p.time) + if (len > 0) " / " + fmt(len) else " · live"
        playBtn?.text = if (p.isPlaying) "⏸" else "▶"
    }

    private fun fmt(ms: Long): String {
        val s = (ms / 1000).coerceAtLeast(0)
        val hh = s / 3600; val mm = (s / 60) % 60; val ss = s % 60
        return if (hh > 0) String.format("%d:%02d:%02d", hh, mm, ss) else String.format("%d:%02d", mm, ss)
    }

    private fun onUserClosed() {
        val last = JSONObject().put("t", "state").put("pos", mp?.time ?: 0L).put("dur", maxOf(mp?.length ?: 0L, 0L)).put("playing", false).put("closed", true)
        overlay = null
        close(silent = true)
        send(last)
    }

    private fun close(silent: Boolean = false) {
        h.removeCallbacks(tick)
        val p = mp
        val last = if (p != null) JSONObject().put("t", "state").put("pos", p.time).put("dur", maxOf(p.length, 0L)) else null
        mp = null
        try { p?.setEventListener(null); p?.stop(); p?.detachViews(); p?.release() } catch (e: Exception) { }
        try { lib?.release() } catch (e: Exception) { }
        lib = null
        overlay?.close(); overlay = null
        seekBar = null; timeView = null; playBtn = null
        if (!silent && last != null) send(last.put("playing", false).put("closed", true).put("engine", "vlc"))
        floating = false
    }

    private fun report(err: String?) {
        val p = mp ?: return
        val len = p.length
        val o = JSONObject().put("t", "state").put("engine", "vlc")
            .put("pos", p.time).put("dur", maxOf(len, 0L)).put("playing", p.isPlaying).put("ended", ended)
            .put("live", len <= 0).put("float", floating)
        if (err != null) o.put("err", err)
        send(o)
    }

    private fun send(o: JSONObject) {
        o.put("title", title)
        web.evaluateJavascript("window.dspPlayer&&dspPlayer($o)", null)
    }
}
