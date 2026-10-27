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
    private val cameraInfo: () -> String,
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
                "body" to Json.str(m.joinToString("") { it.messageBody ?: "" }), "t" to m[0].timestampMillis.toString()))
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

    private fun done(c: BridgeServer.Client, id: Any?, cmd: String, err: String?, code: String = "error", vararg extra: Pair<String, String?>) {
        val kv = ArrayList<Pair<String, String?>>()
        kv.add("src" to "\"cmd\""); kv.add("cmd" to Json.str(cmd)); if (id != null) kv.add("id" to (if (id is Number) id.toString() else Json.str(id.toString())))
        kv.add("ok" to if (err == null) "true" else "false")
        if (err != null) { kv.add("err" to Json.str(code)); kv.add("msg" to Json.str(err)) }
        kv.addAll(extra)
        c.send(Json.obj(*kv.toTypedArray()))
    }

    /** Нужные разрешения: нет — просим (окно или уведомление) и отвечаем ошибкой, команду повторят после выдачи. */
    private fun need(c: BridgeServer.Client, id: Any?, cmd: String, perms: List<String>): Boolean {
        val miss = perms.filter { !ctx.granted(it) }
        if (miss.isEmpty()) return true
        askPerms(miss)
        done(c, id, cmd, "allow ${miss.joinToString { it.substringAfterLast('.').lowercase().replace('_', ' ') }} in the window (or the notification) and repeat", "permission")
        return false
    }

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
            "cam.list" -> done(c, id, cmd, null, extra = arrayOf("cameras" to cameraInfo()))
            "cam.root.info", "cam.root.unhide", "cam.root.restore", "cam.root.sysuid" -> rootCam(c, id, cmd)
            "cam.probe" -> done(c, id, cmd, null, extra = arrayOf("text" to Json.str(probeCameras())))
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

    /** Камеры с root; команды только доверенному клиенту (BridgeServer.sensitiveCmd) и только если root-возможности включены в настройках приложения. */
    private fun rootCam(c: BridgeServer.Client, id: Any?, cmd: String) {
        if (!cfg.sniffer) return done(c, id, cmd, "root features are off — tick «Allow root features» in the app Settings", "forbidden")
        fun count() = try { JSONArray(cameraInfo()).length() } catch (e: Exception) { 0 }
        val before = count()
        val (code, out) = when (cmd) {
            "cam.root.info" -> RootSh.run(RootCam.INFO)
            "cam.root.sysuid" -> RootSh.run(RootCam.sysCamScript(ctx.packageName) ?: return done(c, id, cmd, "bad package name"), 30_000)
            else -> {
                val script = (if (cmd == "cam.root.unhide") RootCam.unhideScript(ctx.packageName) else RootCam.restoreScript(ctx.packageName)) ?: return done(c, id, cmd, "bad package name")
                val r = RootSh.run(script)
                if (RootCam.done(r.second)) { Thread.sleep(4000); 0 to r.second }       // камерный сервис поднимается заново; перезапуск мог убить и оболочку — код выхода не смотрим
                else r
            }
        }
        if (code != 0) return done(c, id, cmd, if (code < 0) "no root (su): " + RootCam.clip(out, 200) else "su exit $code: " + RootCam.clip(out, 300))
        done(c, id, cmd, null, extra = arrayOf("text" to Json.str(RootCam.clip(out, 6000)), "before" to before.toString(), "after" to count().toString(), "cameras" to cameraInfo()))
    }

    /** Без root: для номеров 0…9 — есть ли в списке, отдаёт ли камерный сервис её характеристики и открывается ли она. */
    private fun probeCameras(): String {
        val listed = try { cm.cameraIdList.toSet() } catch (e: Exception) { emptySet() }
        val sb = StringBuilder("listed: ${listed.sorted().joinToString(",")}\n")
        val canOpen = ctx.granted(Manifest.permission.CAMERA)
        for (n in 0..9) {
            val id = n.toString()
            val ch = try { cm.getCameraCharacteristics(id) } catch (e: Exception) { sb.append("id $id: no characteristics (${e.javaClass.simpleName})\n"); continue }
            val map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            val ae = ch.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)?.joinToString(" ") { "${it.lower}-${it.upper}" }
            val hs = try { map?.highSpeedVideoFpsRanges?.joinToString(" ") { "${it.lower}-${it.upper}" } } catch (e: Exception) { null }
            sb.append("id $id: ${if (id in listed) "listed" else "NOT listed"}, caps=${SysCam.capNames(ch.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES))}, fps=[$ae]" +
                (if (!hs.isNullOrEmpty()) " high-speed=[$hs]" else ""))
            if (!canOpen) { sb.append(", open: no camera permission\n"); continue }
            val latch = java.util.concurrent.CountDownLatch(1)
            var res = "timeout"
            try {
                cm.openCamera(id, object : android.hardware.camera2.CameraDevice.StateCallback() {
                    override fun onOpened(d: android.hardware.camera2.CameraDevice) { res = "opens"; d.close(); latch.countDown() }
                    override fun onDisconnected(d: android.hardware.camera2.CameraDevice) { res = "disconnected"; d.close(); latch.countDown() }
                    override fun onError(d: android.hardware.camera2.CameraDevice, code: Int) { res = "error $code"; d.close(); latch.countDown() }
                }, handler)
                latch.await(2, java.util.concurrent.TimeUnit.SECONDS)
            } catch (e: Exception) { res = "${e.javaClass.simpleName}: ${e.message?.take(80)}" }
            sb.append(", open: $res\n")
        }
        return sb.toString()
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
