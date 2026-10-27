package app.dsp.phone

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.ConsumerIrManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.ContactsContract
import android.provider.Telephony
import android.telephony.SmsManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** Проверки аргументов команд (чистая логика — на JVM). */
object Cmd {
    private val NUMBER = Regex("[+0-9 ()*#-]{3,24}")
    fun number(s: String): String? = s.trim().takeIf { NUMBER.matches(it) && it.count { c -> c.isDigit() } >= 3 }

    /** Не больше max отправок SMS за окно (мс): защита от цикла в патче, из-за которого уйдёт сотня платных SMS. */
    class Limiter(private val max: Int, private val windowMs: Long) {
        private val t = ArrayDeque<Long>()
        @Synchronized fun allow(now: Long): Boolean {
            while (t.isNotEmpty() && now - t.first() > windowMs) t.removeFirst()
            if (t.size >= max) return false
            t.addLast(now); return true
        }
    }

    /** Паттерн ИК: чередование «горит / пауза» в микросекундах. null — неверный. */
    fun irPattern(a: JSONArray?): IntArray? {
        if (a == null || a.length() < 2 || a.length() > 4000) return null
        val out = IntArray(a.length())
        for (i in out.indices) { val v = a.optInt(i, -1); if (v < 1 || v > 2_000_000) return null; out[i] = v }
        return out
    }

    /** Несущая лежит в одном из диапазонов [мин, макс] Гц; диапазонов нет (неизвестно) — пропускаем. */
    fun irFreqOk(freq: Int, ranges: List<IntArray>) = freq in 1000..1_000_000 && (ranges.isEmpty() || ranges.any { freq in it[0]..it[1] })

    fun limit(v: Int, def: Int, max: Int) = if (v <= 0) def else minOf(v, max)
}

/**
 * Действия телефона по командам страницы: уведомление с кнопками, фонарь, SMS (чтение / отправка / приём), контакты, ИК-передатчик.
 * SMS и контакты — только для доверенного клиента (страница приложения с ключом). Каждая команда отвечает записью {src:'cmd', id, ok, …}.
 */
class PhoneActions(
    private val ctx: Context,
    private val emit: Emit,
    private val askPerms: (List<String>) -> Unit,
    private val cfg: Config,
) {
    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "dsp-action").also { it.isDaemon = true } }
    private val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    private val thread = HandlerThread("dsp-actions").also { it.start() }
    private val handler = Handler(thread.looper)
    private val nid = AtomicInteger(1000)
    private val limiter = Cmd.Limiter(5, 60_000)
    private class Pending(val c: BridgeServer.Client, val id: Any?, var left: Int, var err: String? = null)
    private val sending = ConcurrentHashMap<Int, Pending>()
    private val reqs = AtomicInteger(1)

    private val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    private val ir = ctx.getSystemService(Context.CONSUMER_IR_SERVICE) as? ConsumerIrManager
    private val vib: Vibrator? = if (Build.VERSION.SDK_INT >= 31) (ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        else @Suppress("DEPRECATION") (ctx.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator)
    @Volatile private var torchId: String? = null
    @Volatile var torchOn = false; private set
    @Volatile private var torchMax = 1

    private val rx = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            when (i.action) {
                ACTION_NOTIFY -> emit("notify", Json.obj("src" to "\"notify\"", "nid" to i.getIntExtra("nid", 0).toString(),
                    "action" to Json.str(i.getStringExtra("action") ?: ""), "t" to System.currentTimeMillis().toString()))
                ACTION_SMS_SENT -> {
                    val p = sending[i.getIntExtra("req", 0)] ?: return
                    if (resultCode != Activity.RESULT_OK && p.err == null) p.err = "send failed (code $resultCode)"
                    if (--p.left <= 0) { sending.remove(i.getIntExtra("req", 0)); done(p.c, p.id, "sms.send", p.err) }
                }
            }
        }
    }

    private val smsRx = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            val m = try { Telephony.Sms.Intents.getMessagesFromIntent(i) } catch (e: Exception) { null } ?: return
            if (m.isEmpty()) return
            emit("sms", Json.obj("src" to "\"sms\"", "dir" to "\"in\"", "addr" to Json.str(m[0].originatingAddress),
                "body" to Json.str(m.joinToString("") { it.messageBody ?: "" }), "t" to m[0].timestampMillis.toString(),
                "pdu" to m[0].pdu?.let { Json.str(Hex.of(it)) }, "pdus" to Json.arr(m.mapNotNull { it.pdu?.let { b -> Hex.of(b) } }),
                "parts" to m.size.toString(), "sc" to m[0].serviceCenterAddress?.let { Json.str(it) },
                "fmt" to i.getStringExtra("format")?.let { Json.str(it) }))
        }
    }
    private var smsOn = false

    init {
        val f = IntentFilter().apply { addAction(ACTION_NOTIFY); addAction(ACTION_SMS_SENT) }
        if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(rx, f, Context.RECEIVER_NOT_EXPORTED) else ctx.registerReceiver(rx, f)
        nm.createNotificationChannel(NotificationChannel(CH_ACT, "Notifications from patches", NotificationManager.IMPORTANCE_HIGH))
        try {
            torchId = cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true }
            if (Build.VERSION.SDK_INT >= 33) torchId?.let { torchMax = cm.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_STRENGTH_MAXIMUM_LEVEL) ?: 1 }
            cm.registerTorchCallback(object : CameraManager.TorchCallback() {
                override fun onTorchModeChanged(id: String, on: Boolean) {
                    if (id != torchId) return
                    torchOn = on
                    emit("torch", Json.obj("src" to "\"torch\"", "on" to if (on) "1" else "0", "t" to System.currentTimeMillis().toString()))
                }
            }, handler)
        } catch (e: Exception) { torchId = null }
    }

    fun close() {
        try { ctx.unregisterReceiver(rx) } catch (e: IllegalArgumentException) {}
        update(false)
        thread.quitSafely(); pool.shutdownNow()
    }

    /** Приём SMS: false — нет разрешения. */
    @Synchronized
    fun update(want: Boolean): Boolean {
        if (want == smsOn) return true
        if (!want) { try { ctx.unregisterReceiver(smsRx) } catch (e: IllegalArgumentException) {}; smsOn = false; return true }
        if (!ctx.granted(Manifest.permission.RECEIVE_SMS)) return false
        // SMS_RECEIVED шлёт только система (у неё BROADCAST_SMS) — приёмник закрыт этим разрешением от чужих приложений
        val f = IntentFilter(Telephony.Sms.Intents.SMS_RECEIVED_ACTION)
        if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(smsRx, f, Manifest.permission.BROADCAST_SMS, null, Context.RECEIVER_EXPORTED)
        else ctx.registerReceiver(smsRx, f, Manifest.permission.BROADCAST_SMS, null)
        smsOn = true
        return true
    }

    fun info(): String = Json.obj(
        "torch" to if (torchId != null) "true" else "false", "torchMax" to torchMax.toString(),
        "ir" to if (ir?.hasIrEmitter() == true) "true" else "false",
        "vibrate" to if (vib?.hasVibrator() == true) "true" else "false", "vibAmp" to if (vib?.hasAmplitudeControl() == true) "true" else "false",
        "sms" to if (ctx.packageManager.hasSystemFeature("android.hardware.telephony")) "true" else "false",
    )

    // ---------- команды ----------

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val name = j.optString("cmd"); val id = j.opt("id")
        if (BridgeServer.sensitiveCmd(name) && !c.trusted) return done(c, id, name, "only the page of the DSP app may use it", "forbidden")
        pool.execute {
            try { run(c, id, name, j) }
            catch (e: SecurityException) { done(c, id, name, "permission: ${e.message}", "permission") }
            catch (e: Exception) { done(c, id, name, e.message ?: e.javaClass.simpleName) }
        }
    }

    private fun done(c: BridgeServer.Client, id: Any?, cmd: String, err: String?, code: String = "error", vararg extra: Pair<String, String?>) =
        Reply.done(c, id, cmd, err, code, *extra)

    private val needs = Needs(ctx, askPerms)
    private fun need(c: BridgeServer.Client, id: Any?, cmd: String, perms: List<String>) = needs.need(c, id, cmd, perms)

    private fun run(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        when (cmd) {
            "notify" -> {
                if (Build.VERSION.SDK_INT >= 33 && !need(c, id, cmd, listOf(Manifest.permission.POST_NOTIFICATIONS))) return
                val n = if (j.has("nid")) j.optInt("nid") else nid.incrementAndGet()
                nm.notify(n, notification(n, j))
                done(c, id, cmd, null, extra = arrayOf("nid" to n.toString()))
            }
            "notify.cancel" -> { nm.cancel(j.optInt("nid")); done(c, id, cmd, null) }
            "torch" -> {
                val t = torchId ?: return done(c, id, cmd, "this phone has no flash")
                val on = j.optBoolean("on", true)
                if (on && Build.VERSION.SDK_INT >= 33 && j.has("level")) cm.turnOnTorchWithStrengthLevel(t, j.optInt("level", torchMax).coerceIn(1, torchMax))
                else cm.setTorchMode(t, on)
                done(c, id, cmd, null, extra = arrayOf("on" to if (on) "true" else "false", "max" to torchMax.toString()))
            }
            "ir.info" -> done(c, id, cmd, null, extra = arrayOf("has" to if (ir?.hasIrEmitter() == true) "true" else "false",
                "ranges" to Json.rows(irRanges().map { "[${it[0]},${it[1]}]" })))
            "ir.send" -> {
                val m = ir?.takeIf { it.hasIrEmitter() } ?: return done(c, id, cmd, "this phone has no IR emitter")
                val f = j.optInt("freq", 38000)
                val p = Cmd.irPattern(j.optJSONArray("pattern")) ?: return done(c, id, cmd, "pattern: 2…4000 durations, 1…2000000 µs each")
                if (!Cmd.irFreqOk(f, irRanges())) return done(c, id, cmd, "carrier $f Hz is outside what the emitter supports")
                m.transmit(f, p)
                done(c, id, cmd, null, extra = arrayOf("us" to p.sum().toString()))
            }
            "vibrate" -> {
                val v = vib?.takeIf { it.hasVibrator() } ?: return done(c, id, cmd, "this phone has no vibrator")
                val amp = j.optInt("amp", 0).let { if (it in 1..255 && v.hasAmplitudeControl()) it else VibrationEffect.DEFAULT_AMPLITUDE }
                val eff: VibrationEffect = when {
                    j.has("effect") -> {
                        if (Build.VERSION.SDK_INT < 29) return done(c, id, cmd, "effects need Android 10+")
                        VibrationEffect.createPredefined(when (j.optString("effect")) {
                            "click" -> VibrationEffect.EFFECT_CLICK; "double" -> VibrationEffect.EFFECT_DOUBLE_CLICK
                            "heavy" -> VibrationEffect.EFFECT_HEAVY_CLICK; "tick" -> VibrationEffect.EFFECT_TICK
                            else -> return done(c, id, cmd, "effect: click, double, heavy or tick")
                        })
                    }
                    j.has("pattern") -> {
                        val p = Args.vibPattern(j.optJSONArray("pattern")) ?: return done(c, id, cmd, "pattern: 1…200 durations 0…60000 ms (off, on, off, …), 10 minutes at most")
                        val rep = j.optInt("repeat", -1)
                        if (rep >= p.size) return done(c, id, cmd, "repeat: -1 or an index inside the pattern")
                        if (amp != VibrationEffect.DEFAULT_AMPLITUDE) VibrationEffect.createWaveform(p, IntArray(p.size) { if (it % 2 == 1) amp else 0 }, maxOf(rep, -1))
                        else VibrationEffect.createWaveform(p, maxOf(rep, -1))
                    }
                    else -> VibrationEffect.createOneShot(j.optLong("ms", 200).coerceIn(1, 60_000), amp)
                }
                v.vibrate(eff)
                done(c, id, cmd, null)
            }
            "vibrate.stop" -> { vib?.cancel(); done(c, id, cmd, null) }
            "sms.data" -> {
                if (!need(c, id, cmd, listOf(Manifest.permission.SEND_SMS))) return
                val to = Cmd.number(j.optString("to")) ?: return done(c, id, cmd, "bad number")
                val data = Args.hex(j.optString("hex"), 140)?.takeIf { it.isNotEmpty() } ?: return done(c, id, cmd, "hex: 1…140 bytes")
                val port = j.optInt("port", 0); if (port !in 0..65535) return done(c, id, cmd, "port: 0…65535")
                if (!limiter.allow(System.currentTimeMillis())) return done(c, id, cmd, "no more than 5 SMS per minute", "rate")
                val sm = if (Build.VERSION.SDK_INT >= 31) ctx.getSystemService(SmsManager::class.java) else @Suppress("DEPRECATION") SmsManager.getDefault()
                val req = reqs.incrementAndGet()
                sending[req] = Pending(c, id, 1)
                sm.sendDataMessage(to, null, port.toShort(), data, PendingIntent.getBroadcast(ctx, req * 100,
                    Intent(ACTION_SMS_SENT).setPackage(ctx.packageName).setData(Uri.parse("dsp://sms/$req/0")).putExtra("req", req), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT), null)
            }
            "crash.last" -> done(c, id, cmd, null, extra = arrayOf("text" to Json.str(try { java.io.File(ctx.filesDir, BridgeService.CRASH_FILE).readText() } catch (e: Exception) { "no crash recorded" })))
            "sms.send" -> {
                if (!need(c, id, cmd, listOf(Manifest.permission.SEND_SMS))) return
                val to = Cmd.number(j.optString("to")) ?: return done(c, id, cmd, "bad number")
                val text = j.optString("text"); if (text.isEmpty() || text.length > 1000) return done(c, id, cmd, "text: 1…1000 characters")
                if (!limiter.allow(System.currentTimeMillis())) return done(c, id, cmd, "no more than 5 SMS per minute", "rate")
                val sm = if (Build.VERSION.SDK_INT >= 31) ctx.getSystemService(SmsManager::class.java) else @Suppress("DEPRECATION") SmsManager.getDefault()
                val parts = sm.divideMessage(text)
                val req = reqs.incrementAndGet()
                sending[req] = Pending(c, id, parts.size)
                val pis = ArrayList<PendingIntent>()
                for (k in 0 until parts.size) pis.add(PendingIntent.getBroadcast(ctx, req * 100 + k,
                    Intent(ACTION_SMS_SENT).setPackage(ctx.packageName).setData(Uri.parse("dsp://sms/$req/$k")).putExtra("req", req), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
                sm.sendMultipartTextMessage(to, null, parts, pis, null)                 // ответ придёт, когда уйдут все части
            }
            "sms.send_raw" -> {
                if (!need(c, id, cmd, listOf(Manifest.permission.SEND_SMS))) return
                val pdu = Args.hex(j.optString("pdu"), 300)?.takeIf { it.isNotEmpty() } ?: return done(c, id, cmd, "pdu: hex TPDU, no SMSC prefix — the \u00abtpdu\u00bb output of SMS PDU")
                val smsc = j.optString("smsc").takeIf { it.isNotEmpty() }?.let { Args.hex(it, 20) }
                if (!limiter.allow(System.currentTimeMillis())) return done(c, id, cmd, "no more than 5 SMS per minute", "rate")
                val req = reqs.incrementAndGet()
                sending[req] = Pending(c, id, 1)
                val sentPi = PendingIntent.getBroadcast(ctx, req * 100,
                    Intent(ACTION_SMS_SENT).setPackage(ctx.packageName).setData(Uri.parse("dsp://sms/$req/0")).putExtra("req", req), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                try {
                    val ok = RawPdu.send(ctx.packageName, smsc, pdu, sentPi)
                    if (!ok) { sending.remove(req); done(c, id, cmd, "no sendRawPdu on this phone \u2014 blocked by Android's hidden-API policy on this build (there is no public API for it; see tools/android/README.md)") }
                } catch (e: Exception) { sending.remove(req); done(c, id, cmd, "raw send: ${e.message} \u2014 likely blocked by hidden-API policy on this Android version") }
            }
            "sms.list" -> {
                if (!need(c, id, cmd, listOf(Manifest.permission.READ_SMS))) return
                val box = when (j.optString("box", "all")) { "inbox" -> Telephony.Sms.Inbox.CONTENT_URI; "sent" -> Telephony.Sms.Sent.CONTENT_URI; else -> Telephony.Sms.CONTENT_URI }
                val lim = Cmd.limit(j.optInt("limit"), 50, 500)
                val q = j.optString("q"); val since = j.optLong("since", 0)
                val sel = ArrayList<String>(); val args = ArrayList<String>()
                if (q.isNotEmpty()) { sel.add("(body LIKE ? OR address LIKE ?)"); args.add("%$q%"); args.add("%$q%") }
                if (since > 0) { sel.add("date > ?"); args.add(since.toString()) }
                val out = ArrayList<String>()
                ctx.contentResolver.query(box, arrayOf("address", "body", "date", "type", "read"), sel.joinToString(" AND ").ifEmpty { null },
                    args.toTypedArray().takeIf { it.isNotEmpty() }, "date DESC")?.use { cur ->
                    while (cur.moveToNext() && out.size < lim) out.add(Json.obj("src" to "\"sms\"", "dir" to if (cur.getInt(3) == 1) "\"in\"" else "\"out\"",
                        "addr" to Json.str(cur.getString(0)), "body" to Json.str(cur.getString(1)), "t" to cur.getLong(2).toString(), "read" to if (cur.getInt(4) == 1) "1" else "0"))
                }
                if (out.isNotEmpty()) c.send(Json.rows(out))
                done(c, id, cmd, null, extra = arrayOf("n" to out.size.toString()))
            }
            "contacts.find" -> {
                if (!need(c, id, cmd, listOf(Manifest.permission.READ_CONTACTS))) return
                val lim = Cmd.limit(j.optInt("limit"), 50, 500); val q = j.optString("q")
                val by = LinkedHashMap<Long, Triple<String, ArrayList<String>, ArrayList<String>>>()
                val like = "%$q%"
                ctx.contentResolver.query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                    arrayOf(ContactsContract.CommonDataKinds.Phone.CONTACT_ID, ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER),
                    if (q.isEmpty()) null else "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ? OR ${ContactsContract.CommonDataKinds.Phone.NUMBER} LIKE ?",
                    if (q.isEmpty()) null else arrayOf(like, like), ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)?.use { cur ->
                    while (cur.moveToNext() && by.size <= lim) by.getOrPut(cur.getLong(0)) { Triple(cur.getString(1) ?: "", ArrayList(), ArrayList()) }.second.add(cur.getString(2) ?: "")
                }
                val out = by.entries.take(lim).map { (cid, v) -> Json.obj("src" to "\"contact\"", "id" to cid.toString(), "name" to Json.str(v.first), "phones" to Json.arr(v.second.distinct())) }
                if (out.isNotEmpty()) c.send(Json.rows(out))
                done(c, id, cmd, null, extra = arrayOf("n" to out.size.toString()))
            }
            else -> done(c, id, cmd, "unknown command", "unknown")
        }
    }

    private fun irRanges(): List<IntArray> = try { ir?.carrierFrequencies?.map { intArrayOf(it.minFrequency, it.maxFrequency) } ?: emptyList() } catch (e: Exception) { emptyList() }

    @Suppress("DEPRECATION")
    private fun notification(n: Int, j: JSONObject): Notification {
        fun pi(action: String) = PendingIntent.getBroadcast(ctx, n * 31 + action.hashCode(),
            Intent(ACTION_NOTIFY).setPackage(ctx.packageName).setData(Uri.parse("dsp://notify/$n/$action")).putExtra("nid", n).putExtra("action", action),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val b = Notification.Builder(ctx, CH_ACT).setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentTitle(j.optString("title", "DSP")).setContentText(j.optString("text")).setAutoCancel(true)
            .setStyle(Notification.BigTextStyle().bigText(j.optString("text")))
            .setOngoing(j.optBoolean("ongoing", false)).setDeleteIntent(pi("dismiss"))
        // open: нажатие открывает приложение (событие не приходит — с Android 12 из приёмника окно не открыть); иначе — событие «tap»
        b.setContentIntent(if (j.optBoolean("open", false)) PendingIntent.getActivity(ctx, n, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_IMMUTABLE) else pi("tap"))
        val a = j.optJSONArray("actions")
        if (a != null) for (i in 0 until minOf(a.length(), 3)) {
            val o = a.optJSONObject(i) ?: continue
            val aid = o.optString("id").ifEmpty { "a$i" }.take(40)
            b.addAction(android.R.drawable.ic_menu_send, o.optString("label", aid).take(30), pi(aid))
        }
        return b.build()
    }

    companion object {
        const val ACTION_NOTIFY = "app.dsp.phone.NOTIFY"
        const val ACTION_SMS_SENT = "app.dsp.phone.SMS_SENT"
        private const val CH_ACT = "actions"
    }
}
