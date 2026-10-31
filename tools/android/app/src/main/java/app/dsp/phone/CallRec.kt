package app.dsp.phone

import android.Manifest
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Чистая логика записи звонков (без Android — проверяется на JVM). */
object CallArgs {
    private val KNOWN = setOf("voice_call", "downlink", "uplink", "mic", "voice_recognition", "voice_comm", "camcorder", "unprocessed")

    /** Источник звука звонка. auto: с root — voice_call (обе стороны), без root — микрофон (слышно собеседника только на громкой связи). */
    fun source(configured: String?, root: Boolean): String {
        val c = (configured ?: "").trim().lowercase()
        return if (c in KNOWN) c else if (root) "voice_call" else "mic"
    }

    /** Звонковый аудио-тракт обычно 8 / 16 / 48 кГц; остальное — 16000. */
    fun rate(hz: Int): Int = if (hz in 8000..48000) hz else 16000

    fun fileName(ms: Long, zone: ZoneId, src: String): String =
        "call-" + DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").format(Instant.ofEpochMilli(ms).atZone(zone)) + "-" + src.replace(Regex("[^a-z0-9]"), "") + ".wav"

    /** Оставлять ли запись: короче minSec секунд (сброшенный / пропущенный вызов, тишина) — стереть. */
    fun keep(bytes: Long, rate: Int, minSec: Int): Boolean = minSec <= 0 || bytes / 2 >= rate.toLong() * minSec

    /** Заголовок WAV: PCM 16 бит моно, dataBytes — размер данных. */
    fun wavHeader(rate: Int, dataBytes: Long): ByteArray {
        val b = java.io.ByteArrayOutputStream()
        fun le32(x: Long) { for (i in 0..3) b.write(((x shr (8 * i)) and 0xff).toInt()) }
        fun le16(x: Int) { b.write(x and 0xff); b.write((x shr 8) and 0xff) }
        b.write("RIFF".toByteArray()); le32(36 + dataBytes); b.write("WAVEfmt ".toByteArray()); le32(16); le16(1); le16(1); le32(rate.toLong()); le32(rate * 2L); le16(2); le16(16)
        b.write("data".toByteArray()); le32(dataBytes)
        return b.toByteArray()
    }
}

/** WAV-файл, который дописывается кусками; заголовок с размерами исправляется при close (и каждые несколько секунд — запись переживёт обрыв). */
class WavOut(val file: File, val rate: Int) {
    private val f = RandomAccessFile(file, "rw")
    var bytes = 0L; private set
    private var patchedAt = 0L

    init { f.setLength(0); f.write(CallArgs.wavHeader(rate, 0)) }

    @Synchronized
    fun write(pcm: ByteArray) {
        f.write(pcm); bytes += pcm.size
        if (bytes - patchedAt > rate * 2L * 5) patch()
    }

    private fun patch() { val pos = f.filePointer; f.seek(0); f.write(CallArgs.wavHeader(rate, bytes)); f.seek(pos); patchedAt = bytes }

    @Synchronized
    fun close() { try { patch() } catch (e: Exception) { }; try { f.close() } catch (e: Exception) { } }
}

/**
 * Запись звонков: служба слушает состояние звонка (READ_PHONE_STATE) и на время разговора берёт звук как получатель «mic» (источник из настроек:
 * с root voice_call — обе стороны, downlink — собеседник, uplink — вы; без root — микрофон, собеседника слышно на громкой связи; на новых Android
 * система может заглушить микрофон приложения во время звонка). Файл call-ГГГГММДД-ЧЧММСС-источник.wav лежит рядом с записями rec/; короче
 * minSec секунд — стирается. События в sys: callrec.start / stop / dropped / error. Закон многих стран требует предупредить собеседника о записи.
 * Команды (только страница приложения): callrec.set {mode:"auto"|"off", src, rate, minSec} / callrec.status / callrec.stop.
 */
class CallRec(private val ctx: Context, private val cfg: Config, private val server: BridgeServer, private val needs: Needs, private val dir: () -> File, private val emit: Emit) {
    private val main = Handler(Looper.getMainLooper())
    private val tm = ctx.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
    private var legacy: PhoneStateListener? = null
    private var modern: Any? = null
    @Volatile private var sink: BridgeServer.Sink? = null
    private var wav: WavOut? = null
    @Volatile private var curName = ""
    @Volatile private var curSrc = ""
    private var started = 0L

    private fun note(ev: String, vararg kv: Pair<String, String?>) =
        emit("sys", Json.obj("src" to "\"sys\"", "ev" to Json.str("callrec.$ev"), "t" to System.currentTimeMillis().toString(), "file" to Json.str(curName), "source" to Json.str(curSrc), *kv))

    /** Включить / выключить слушателя по настройкам (запуск службы, callrec.set). */
    fun apply() {
        main.post {
            unregister()
            if (cfg.callRec && ctx.granted(Manifest.permission.READ_PHONE_STATE)) register()
        }
    }

    private fun register() {
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                val cb = Modern { s -> onState(s) }
                tm.registerTelephonyCallback(ctx.mainExecutor, cb); modern = cb
            } else {
                @Suppress("DEPRECATION") val l = object : PhoneStateListener() { @Deprecated("") override fun onCallStateChanged(state: Int, phoneNumber: String?) { onState(state) } }
                @Suppress("DEPRECATION") tm.listen(l, PhoneStateListener.LISTEN_CALL_STATE); legacy = l
            }
        } catch (e: SecurityException) { note("error", "msg" to Json.str("allow Phone (READ_PHONE_STATE) for the DSP app")) }
        catch (e: Exception) { note("error", "msg" to Json.str(e.message)) }
    }

    private fun unregister() {
        try {
            if (Build.VERSION.SDK_INT >= 31) (modern as? TelephonyCallback)?.let { tm.unregisterTelephonyCallback(it) }
            else @Suppress("DEPRECATION") legacy?.let { tm.listen(it, PhoneStateListener.LISTEN_NONE) }
        } catch (e: Exception) { }
        modern = null; legacy = null
    }

    private class Modern(val f: (Int) -> Unit) : TelephonyCallback(), TelephonyCallback.CallStateListener {
        override fun onCallStateChanged(state: Int) { f(state) }
    }

    private fun onState(state: Int) {
        if (state == TelephonyManager.CALL_STATE_OFFHOOK) begin() else if (state == TelephonyManager.CALL_STATE_IDLE) end()
    }

    @Synchronized
    private fun begin() {
        if (sink != null || !cfg.callRec) return
        val root = cfg.sniffer
        val src = CallArgs.source(cfg.callSrc, root); curSrc = src
        if (MicArgs.rootOnly(src) && !root) { curName = ""; note("error", "msg" to Json.str("the source $src needs root — turn on «Allow root features» in the app Settings")); return }
        val rate = CallArgs.rate(cfg.callRate)
        curName = CallArgs.fileName(System.currentTimeMillis(), ZoneId.systemDefault(), src); started = System.currentTimeMillis(); wav = null
        val s = BridgeServer.Sink(setOf("mic"), on = { l -> chunk(l, rate) }, micHz = rate, micSrc = src)
        sink = s; server.addSink(s)
        note("start", "rate" to rate.toString())
    }

    /** Порции mic → WAV; частота файла — реальная sr из первой записи (источник мог открыться на другой). */
    @Synchronized
    private fun chunk(lines: List<String>, want: Int) {
        for (l in lines) {
            try {
                val j = JSONObject(l)
                val pcm = Base64.decode(j.getString("pcm"), Base64.DEFAULT)
                val w = wav ?: WavOut(File(dir(), curName), j.optInt("sr", want).takeIf { it > 0 } ?: want).also { wav = it }
                w.write(pcm)
            } catch (e: Exception) { note("error", "msg" to Json.str("write: " + e.message)); end(); return }
        }
    }

    @Synchronized
    fun end() {
        val s = sink ?: return
        server.removeSink(s); sink = null
        val w = wav; wav = null
        if (w == null) { note("dropped", "why" to Json.str("no audio came (the source is silent or not open)")); return }
        w.close()
        val sec = w.bytes / 2 / w.rate
        if (!CallArgs.keep(w.bytes, w.rate, cfg.callMin)) { w.file.delete(); note("dropped", "why" to Json.str("shorter than ${cfg.callMin} s"), "sec" to sec.toString()); return }
        note("stop", "sec" to sec.toString(), "bytes" to w.bytes.toString())
    }

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        if (!c.trusted) return Reply.done(c, id, cmd, "only the page of the DSP app may use it", "forbidden")
        when (cmd) {
            "callrec.set" -> {
                if (j.optString("mode", if (cfg.callRec) "auto" else "off") == "off") { cfg.callRec = false; end(); apply(); return Reply.done(c, id, cmd, null) }
                if (!needs.need(c, id, cmd, listOf(Manifest.permission.READ_PHONE_STATE))) return
                cfg.callRec = true
                if (j.has("src")) cfg.callSrc = j.optString("src", "auto").take(24)
                if (j.has("rate")) cfg.callRate = CallArgs.rate(j.optInt("rate"))
                if (j.has("minSec")) cfg.callMin = j.optInt("minSec")
                apply()
                Reply.done(c, id, cmd, null, extra = arrayOf("source" to Json.str(CallArgs.source(cfg.callSrc, cfg.sniffer)), "rate" to CallArgs.rate(cfg.callRate).toString()))
            }
            "callrec.status" -> {
                c.send(Json.rows(listOf(Json.obj("src" to "\"callrec\"", "mode" to Json.str(if (cfg.callRec) "auto" else "off"), "source" to Json.str(CallArgs.source(cfg.callSrc, cfg.sniffer)),
                    "rate" to CallArgs.rate(cfg.callRate).toString(), "minSec" to cfg.callMin.toString(), "active" to (sink != null).toString(), "file" to Json.str(if (sink != null) curName else ""),
                    "root" to cfg.sniffer.toString()))))
                Reply.done(c, id, cmd, null)
            }
            "callrec.stop" -> { end(); Reply.done(c, id, cmd, null) }
            else -> Reply.done(c, id, cmd, "unknown call recording command", "args")
        }
    }

    fun close() { end(); main.post { unregister() } }
}
