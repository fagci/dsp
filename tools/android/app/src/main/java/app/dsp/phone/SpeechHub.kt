package app.dsp.phone

import android.Manifest
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import org.json.JSONObject

/**
 * Потоковое распознавание речи системным SpeechRecognizer: промежуточные фразы (partial) идут по мере речи, итоговые (final) — после паузы.
 * Работает, пока клиент не скажет speech.stop; Android обрывает сессию после тишины, поэтому сервис запускает её заново.
 * Записи: {src:'speech', text, final, conf, lang}. Нужны RECORD_AUDIO и сервис распознавания в системе (Google или офлайн-пакет языка).
 */
class SpeechHub(private val ctx: Context, private val emit: Emit, private val needs: Needs) {
    private val main = Handler(Looper.getMainLooper())
    private var rec: SpeechRecognizer? = null
    private var want = false
    private var lang = ""
    private var partial = true
    private var offline = false
    private var gen = 0
    @Volatile var active = false; private set

    private fun intent(): Intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, partial)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.packageName)
        if (offline) putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        if (lang.isNotEmpty()) putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
    }

    private fun out(text: String, final: Boolean, conf: Float?) {
        emit("speech", Json.obj("src" to "\"speech\"", "t" to System.currentTimeMillis().toString(), "text" to Json.str(text),
            "final" to if (final) "1" else "0", "conf" to conf?.takeIf { it >= 0 }?.let { Json.num(it.toDouble(), 100.0) }, "lang" to Json.str(lang)))
    }

    private fun note(level: String, msg: String) = emit("speech", Json.note(level, msg))

    private fun listener(g: Int) = object : RecognitionListener {
        override fun onReadyForSpeech(p: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(v: Float) {}
        override fun onBufferReceived(b: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(t: Int, p: Bundle?) {}
        private fun best(b: Bundle?): Pair<String, Float?>? {
            val l = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION) ?: return null
            val t = l.firstOrNull()?.takeIf { it.isNotBlank() } ?: return null
            return t to b.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)?.firstOrNull()
        }
        override fun onPartialResults(b: Bundle?) { if (g == gen) best(b)?.let { out(it.first, false, null) } }
        override fun onResults(b: Bundle?) { if (g != gen) return; best(b)?.let { out(it.first, true, it.second) }; again(g, 150) }
        override fun onError(e: Int) {
            if (g != gen) return
            when (e) {
                SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> again(g, 150)           // тишина — обычный конец сессии
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY, SpeechRecognizer.ERROR_CLIENT -> { rebuild(g); again(g, 800) }
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> { note("error", "speech: allow the microphone for the DSP app"); want = false; active = false }
                else -> { note("error", "speech: error $e (${errName(e)})"); again(g, 2000) }
            }
        }
    }

    private fun errName(e: Int) = when (e) {
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "network"
        SpeechRecognizer.ERROR_AUDIO -> "audio"
        SpeechRecognizer.ERROR_SERVER -> "server"
        12 -> "language not supported"
        13 -> "language unavailable (download the offline pack)"
        else -> "unknown"
    }

    private fun again(g: Int, delay: Long) {
        main.postDelayed({ if (g == gen && want) try { rec?.startListening(intent()) } catch (e: Exception) { note("error", "speech: ${e.message}") } }, delay)
    }

    private fun rebuild(g: Int) {
        try { rec?.destroy() } catch (e: Exception) {}
        rec = build(g)
    }

    private fun build(g: Int): SpeechRecognizer? {
        val r = try {
            if (offline && android.os.Build.VERSION.SDK_INT >= 33 && SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx)) SpeechRecognizer.createOnDeviceSpeechRecognizer(ctx)
            else if (SpeechRecognizer.isRecognitionAvailable(ctx)) SpeechRecognizer.createSpeechRecognizer(ctx)
            else null
        } catch (e: Exception) { null }
        r?.setRecognitionListener(listener(g))
        return r
    }

    /** speech.start {lang, partial, offline}; speech.stop. */
    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        when (cmd) {
            "speech.stop" -> main.post { stop(); Reply.done(c, id, cmd, null) }
            "speech.start" -> {
                if (!needs.need(c, id, cmd, listOf(Manifest.permission.RECORD_AUDIO))) return
                main.post {
                    stop()
                    lang = j.optString("lang").take(16); partial = j.optBoolean("partial", true); offline = j.optBoolean("offline", false)
                    val g = ++gen
                    val r = build(g)
                    if (r == null) { Reply.done(c, id, cmd, "no speech recognition service on this phone (install Google speech services or an offline pack)"); return@post }
                    rec = r; want = true; active = true
                    again(g, 0)
                    Reply.done(c, id, cmd, null, extra = arrayOf("lang" to Json.str(lang)))
                }
            }
        }
    }

    fun stop() {
        want = false; active = false; gen++
        main.removeCallbacksAndMessages(null)
        try { rec?.cancel(); rec?.destroy() } catch (e: Exception) {}
        rec = null
    }

    fun close() { main.post { stop() } }
}
