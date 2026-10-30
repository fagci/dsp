package app.dsp.phone

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationManager
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.speech.tts.TextToSpeech
import android.telephony.TelephonyManager
import android.view.KeyEvent
import java.util.concurrent.TimeUnit
import android.widget.Toast
import org.json.JSONObject
import java.util.Locale

/** Чтение уведомлений других приложений (нужен особый доступ: Settings → «Notification access»). События уходят в источник sys. */
class NotifyListener : NotificationListenerService() {
    override fun onListenerConnected() { inst = this }
    override fun onListenerDisconnected() { if (inst === this) inst = null }
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val sink = sink ?: return
        val n = sbn.notification ?: return
        val e = n.extras
        sink(Json.obj("src" to "\"sys\"", "ev" to "\"notification\"", "t" to System.currentTimeMillis().toString(), "pkg" to Json.str(sbn.packageName),
            "key" to Json.str(sbn.key), "title" to Json.str(e?.getCharSequence("android.title")?.toString()), "text" to Json.str(e?.getCharSequence("android.text")?.toString()),
            "ongoing" to if (sbn.isOngoing) "1" else "0"))
    }
    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        val sink = sink ?: return
        sink(Json.obj("src" to "\"sys\"", "ev" to "\"notification.removed\"", "t" to System.currentTimeMillis().toString(), "pkg" to Json.str(sbn.packageName), "key" to Json.str(sbn.key)))
    }
    companion object {
        @Volatile var sink: ((String) -> Unit)? = null
        @Volatile var inst: NotifyListener? = null
    }
}

/**
 * Автоматизация телефона: события системы (экран, зарядка, наушники, Bluetooth, Wi-Fi, звонок, сеть, установка приложений, уведомления)
 * и команды управления (громкость, речь телефона, буфер обмена, медиа-клавиши, экран, intent, запуск приложения, toast; под root — svc и input).
 * Нажатия, свайпы и чтение экрана без root — через сервис доступности (UiService, включается в системных настройках).
 */
class SysHub(private val ctx: Context, private val cfg: Config, private val emit: Emit, private val needs: Needs) {
    private val main = Handler(Looper.getMainLooper())
    private var on = false
    private var cb: ConnectivityManager.NetworkCallback? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val mock = MockGps(ctx)
    fun stopMock() = mock.stop()
    private var bcastRx: BroadcastReceiver? = null

    private fun rec(ev: String, vararg kv: Pair<String, String?>) =
        emit("sys", Json.obj("src" to "\"sys\"", "ev" to Json.str(ev), "t" to System.currentTimeMillis().toString(), *kv))

    private val rx = object : BroadcastReceiver() {
        @Suppress("DEPRECATION")
        override fun onReceive(c: Context, i: Intent) {
            when (i.action) {
                Intent.ACTION_SCREEN_ON -> rec("screen", "on" to "1")
                Intent.ACTION_SCREEN_OFF -> rec("screen", "on" to "0")
                Intent.ACTION_USER_PRESENT -> rec("unlock")
                Intent.ACTION_POWER_CONNECTED -> rec("power", "plugged" to "1")
                Intent.ACTION_POWER_DISCONNECTED -> rec("power", "plugged" to "0")
                Intent.ACTION_BATTERY_LOW -> rec("battery.low")
                Intent.ACTION_BATTERY_OKAY -> rec("battery.ok")
                Intent.ACTION_AIRPLANE_MODE_CHANGED -> rec("airplane", "on" to if (i.getBooleanExtra("state", false)) "1" else "0")
                Intent.ACTION_HEADSET_PLUG -> rec("headset", "plugged" to i.getIntExtra("state", 0).toString(), "mic" to i.getIntExtra("microphone", 0).toString(), "name" to Json.str(i.getStringExtra("name")))
                Intent.ACTION_TIMEZONE_CHANGED -> rec("timezone")
                Intent.ACTION_LOCALE_CHANGED -> rec("locale")
                Intent.ACTION_PACKAGE_ADDED -> rec("package.added", "pkg" to Json.str(i.data?.schemeSpecificPart), "update" to if (i.getBooleanExtra(Intent.EXTRA_REPLACING, false)) "1" else "0")
                Intent.ACTION_PACKAGE_REMOVED -> if (!i.getBooleanExtra(Intent.EXTRA_REPLACING, false)) rec("package.removed", "pkg" to Json.str(i.data?.schemeSpecificPart))
                BluetoothAdapter.ACTION_STATE_CHANGED -> rec("bluetooth", "state" to i.getIntExtra(BluetoothAdapter.EXTRA_STATE, 0).toString())
                WifiManager.WIFI_STATE_CHANGED_ACTION -> rec("wifi", "state" to i.getIntExtra(WifiManager.EXTRA_WIFI_STATE, 0).toString())
                BluetoothDevice.ACTION_ACL_CONNECTED, BluetoothDevice.ACTION_ACL_DISCONNECTED -> {
                    val d = i.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE)
                    val name = try { d?.name } catch (e: SecurityException) { null }
                    rec(if (i.action == BluetoothDevice.ACTION_ACL_CONNECTED) "bt.connected" else "bt.disconnected", "addr" to Json.str(d?.address), "name" to Json.str(name))
                }
                TelephonyManager.ACTION_PHONE_STATE_CHANGED -> rec("call", "state" to Json.str(i.getStringExtra(TelephonyManager.EXTRA_STATE)))
            }
        }
    }

    @Synchronized
    fun update(want: Boolean) {
        if (want == on) return
        on = want
        if (!want) {
            try { ctx.unregisterReceiver(rx) } catch (e: IllegalArgumentException) {}
            cb?.let { try { (ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it) } catch (e: Exception) {} }; cb = null
            NotifyListener.sink = null; UiService.sink = null
            return
        }
        val f = IntentFilter()
        for (a in listOf(Intent.ACTION_SCREEN_ON, Intent.ACTION_SCREEN_OFF, Intent.ACTION_USER_PRESENT, Intent.ACTION_POWER_CONNECTED, Intent.ACTION_POWER_DISCONNECTED,
            Intent.ACTION_BATTERY_LOW, Intent.ACTION_BATTERY_OKAY, Intent.ACTION_AIRPLANE_MODE_CHANGED, Intent.ACTION_HEADSET_PLUG, Intent.ACTION_TIMEZONE_CHANGED,
            Intent.ACTION_LOCALE_CHANGED, BluetoothAdapter.ACTION_STATE_CHANGED, WifiManager.WIFI_STATE_CHANGED_ACTION, BluetoothDevice.ACTION_ACL_CONNECTED,
            BluetoothDevice.ACTION_ACL_DISCONNECTED, TelephonyManager.ACTION_PHONE_STATE_CHANGED)) f.addAction(a)
        ctx.registerReceiver(rx, f)
        val pk = IntentFilter().also { it.addAction(Intent.ACTION_PACKAGE_ADDED); it.addAction(Intent.ACTION_PACKAGE_REMOVED); it.addDataScheme("package") }
        ctx.registerReceiver(rx, pk)
        try {
            val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val n = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(net: Network) { report(cm, net, true) }
                override fun onLost(net: Network) { rec("network", "up" to "0") }
                override fun onCapabilitiesChanged(net: Network, c: NetworkCapabilities) { report(cm, net, true) }
            }
            cm.registerDefaultNetworkCallback(n); cb = n
        } catch (e: Exception) { /* нет разрешения на состояние сети */ }
        NotifyListener.sink = { emit("sys", it) }
        UiService.sink = { emit("sys", it) }
    }

    private var lastNet = ""
    private fun report(cm: ConnectivityManager, n: Network, up: Boolean) {
        val c = cm.getNetworkCapabilities(n) ?: return
        val kind = when { c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"; c.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cell"; c.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"; c.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"; else -> "other" }
        val s = "$up$kind${c.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)}"
        if (s == lastNet) return
        lastNet = s
        rec("network", "up" to if (up) "1" else "0", "kind" to Json.str(kind), "internet" to if (c.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) "1" else "0")
    }

    // ---------- команды ----------

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        main.post {
            try { run(c, id, cmd, j) }
            catch (e: SecurityException) { Reply.done(c, id, cmd, "permission: ${e.message}", "permission") }
            catch (e: Exception) { Reply.done(c, id, cmd, e.message ?: e.javaClass.simpleName) }
        }
    }

    private fun stream(s: String) = when (s) {
        "ring" -> AudioManager.STREAM_RING; "alarm" -> AudioManager.STREAM_ALARM; "notification" -> AudioManager.STREAM_NOTIFICATION
        "call" -> AudioManager.STREAM_VOICE_CALL; "system" -> AudioManager.STREAM_SYSTEM; else -> AudioManager.STREAM_MUSIC
    }

    @SuppressLint("WakelockTimeout", "MissingPermission")
    @Suppress("DEPRECATION")
    private fun run(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        when (cmd) {
            "toast" -> { Toast.makeText(ctx, j.optString("text").take(200), Toast.LENGTH_LONG).show(); Reply.done(c, id, cmd, null) }
            "vol.get" -> {
                val st = stream(j.optString("stream", "music"))
                Reply.done(c, id, cmd, null, extra = arrayOf("level" to am.getStreamVolume(st).toString(), "max" to am.getStreamMaxVolume(st).toString(), "ringer" to am.ringerMode.toString()))
            }
            "vol.set" -> {
                val st = stream(j.optString("stream", "music")); val max = am.getStreamMaxVolume(st)
                val lv = if (j.has("pct")) Math.round(j.optDouble("pct") / 100.0 * max).toInt() else j.optInt("level", -1)
                if (lv < 0) return Reply.done(c, id, cmd, "level (0…$max) or pct")
                am.setStreamVolume(st, lv.coerceIn(0, max), if (j.optBoolean("ui", false)) AudioManager.FLAG_SHOW_UI else 0)
                Reply.done(c, id, cmd, null, extra = arrayOf("level" to am.getStreamVolume(st).toString(), "max" to max.toString()))
            }
            "vol.adjust" -> {                       // как кнопки громкости: шаг вверх / вниз / mute, можно несколько шагов сразу
                val st = stream(j.optString("stream", "music")); val steps = j.optInt("steps", 1).coerceIn(1, 20)
                val flag = if (j.optBoolean("ui", true)) AudioManager.FLAG_SHOW_UI else 0
                val dir = when (j.optString("dir")) { "up" -> AudioManager.ADJUST_RAISE; "down" -> AudioManager.ADJUST_LOWER; "mute" -> AudioManager.ADJUST_MUTE
                    "unmute" -> AudioManager.ADJUST_UNMUTE; "toggle" -> AudioManager.ADJUST_TOGGLE_MUTE; else -> return Reply.done(c, id, cmd, "dir: up, down, mute, unmute or toggle") }
                repeat(if (dir == AudioManager.ADJUST_RAISE || dir == AudioManager.ADJUST_LOWER) steps else 1) { am.adjustStreamVolume(st, dir, flag) }
                Reply.done(c, id, cmd, null, extra = arrayOf("level" to am.getStreamVolume(st).toString(), "max" to am.getStreamMaxVolume(st).toString()))
            }
            "gps.mock.start" -> {                   // фиктивное местоположение (нужно выбрать приложение в «Для разработчиков»)
                val arr = j.optJSONArray("providers"); val names = ArrayList<String>()
                if (arr != null) for (i in 0 until arr.length()) names.add(arr.optString(i))
                try { mock.start(names) }
                catch (e: SecurityException) { return Reply.done(c, id, cmd, "DSP is not the mock location app: Settings → Developer options → Select mock location app → DSP", "permission") }
                Reply.done(c, id, cmd, null, extra = arrayOf("providers" to mock.names()))
            }
            "gps.mock" -> {                         // одна точка; без gps.mock.start запускает провайдер gps сама
                if (!j.has("lat") || !j.has("lon")) return Reply.done(c, id, cmd, "lat and lon")
                val lat = j.optDouble("lat"); val lon = j.optDouble("lon")
                if (lat.isNaN() || lon.isNaN() || Math.abs(lat) > 90 || Math.abs(lon) > 180) return Reply.done(c, id, cmd, "lat −90…90, lon −180…180")
                if (!mock.on) {
                    try { mock.start(emptyList()) }
                    catch (e: SecurityException) { return Reply.done(c, id, cmd, "DSP is not the mock location app: Settings → Developer options → Select mock location app → DSP", "permission") }
                }
                val alt = if (j.has("alt")) j.optDouble("alt") else Double.NaN
                val sp = if (j.has("speed")) j.optDouble("speed") else Double.NaN
                val br = if (j.has("bearing")) j.optDouble("bearing") else Double.NaN
                mock.set(lat, lon, if (alt.isNaN()) null else alt, if (sp.isNaN()) null else sp.toFloat(), if (br.isNaN()) null else br.toFloat(), j.optDouble("acc", 5.0).toFloat())
                Reply.done(c, id, cmd, null)
            }
            "gps.mock.stop" -> { mock.stop(); Reply.done(c, id, cmd, null) }
            "gps.mock.status" -> Reply.done(c, id, cmd, null, extra = arrayOf("on" to (if (mock.on) "1" else "0"), "providers" to mock.names()))
            "vol.ringer" -> {
                val m = when (j.optString("mode")) { "normal" -> AudioManager.RINGER_MODE_NORMAL; "vibrate" -> AudioManager.RINGER_MODE_VIBRATE; "silent" -> AudioManager.RINGER_MODE_SILENT; else -> return Reply.done(c, id, cmd, "mode: normal, vibrate or silent") }
                val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                if (m != AudioManager.RINGER_MODE_NORMAL && !nm.isNotificationPolicyAccessGranted && m == AudioManager.RINGER_MODE_SILENT) return Reply.done(c, id, cmd, "silent mode needs Do Not Disturb access for the DSP app (system settings)", "permission")
                am.ringerMode = m; Reply.done(c, id, cmd, null)
            }
            "tts.speak" -> {
                val text = j.optString("text").take(3000); if (text.isEmpty()) return Reply.done(c, id, cmd, "text")
                val lang = j.optString("lang"); val rate = j.optDouble("rate", 1.0).toFloat(); val pitch = j.optDouble("pitch", 1.0).toFloat()
                val go = {
                    tts?.let { t ->
                        if (lang.isNotEmpty()) t.language = Locale.forLanguageTag(lang)
                        t.setSpeechRate(rate.coerceIn(0.1f, 4f)); t.setPitch(pitch.coerceIn(0.1f, 4f))
                        val r = t.speak(text, if (j.optBoolean("queue", false)) TextToSpeech.QUEUE_ADD else TextToSpeech.QUEUE_FLUSH, null, "dsp" + System.nanoTime())
                        Reply.done(c, id, cmd, if (r == TextToSpeech.SUCCESS) null else "TTS refused")
                    }
                }
                if (ttsReady) go() else {
                    tts = TextToSpeech(ctx) { st -> main.post { if (st == TextToSpeech.SUCCESS) { ttsReady = true; go() } else Reply.done(c, id, cmd, "no speech synthesis engine on this phone") } }
                }
            }
            "tts.stop" -> { tts?.stop(); Reply.done(c, id, cmd, null) }
            "clip.set" -> {
                (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("dsp", j.optString("text").take(100_000)))
                Reply.done(c, id, cmd, null)
            }
            "clip.get" -> {
                // с Android 10 читать буфер можно только с открытым окном приложения
                val t = (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString()
                Reply.done(c, id, cmd, null, extra = arrayOf("text" to Json.str(t ?: ""), "hint" to if (t == null) "\"empty, or Android hides the clipboard from background apps — open the DSP app\"" else null))
            }
            "media" -> {
                val k = when (j.optString("key")) {
                    "play" -> KeyEvent.KEYCODE_MEDIA_PLAY; "pause" -> KeyEvent.KEYCODE_MEDIA_PAUSE; "toggle" -> KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
                    "next" -> KeyEvent.KEYCODE_MEDIA_NEXT; "prev" -> KeyEvent.KEYCODE_MEDIA_PREVIOUS; "stop" -> KeyEvent.KEYCODE_MEDIA_STOP
                    else -> return Reply.done(c, id, cmd, "key: play, pause, toggle, next, prev or stop")
                }
                am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, k)); am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, k))
                Reply.done(c, id, cmd, null)
            }
            "screen.wake" -> {
                val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
                pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE, "dsp:wake").acquire(j.optLong("ms", 5000).coerceIn(500, 60_000))
                Reply.done(c, id, cmd, null)
            }
            "app.list" -> {
                val pm = ctx.packageManager
                val l = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
                val q = j.optString("q").lowercase()
                val rows = l.map { Json.obj("src" to "\"app\"", "pkg" to Json.str(it.activityInfo.packageName), "label" to Json.str(it.loadLabel(pm).toString())) }
                    .filter { q.isEmpty() || it.lowercase().contains(q) }.take(Cmd.limit(j.optInt("limit"), 200, 500))
                if (rows.isNotEmpty()) c.send(Json.rows(rows))
                Reply.done(c, id, cmd, null, extra = arrayOf("n" to rows.size.toString()))
            }
            "app.launch" -> {
                val pkg = Args.safeToken(j.optString("pkg")) ?: return Reply.done(c, id, cmd, "pkg")
                val i = ctx.packageManager.getLaunchIntentForPackage(pkg) ?: return Reply.done(c, id, cmd, "no launchable app $pkg")
                if (j.optBoolean("root", false)) return rootAm(c, id, cmd, "start -n ${i.component?.flattenToString()}")
                ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                Reply.done(c, id, cmd, null, extra = arrayOf("hint" to "\"Android 10+ starts a window from the background only for apps on screen; use root:true or open the DSP app\""))
            }
            "intent" -> intent(c, id, cmd, j)
            "sys.svc" -> {
                val what = j.optString("what"); val on = j.optBoolean("on", true)
                if (what !in listOf("wifi", "data", "bluetooth", "nfc")) return Reply.done(c, id, cmd, "what: wifi, data, bluetooth or nfc")
                root(c, id, cmd) { "svc $what ${if (on) "enable" else "disable"}" }
            }
            "sys.input" -> {
                val a = when (j.optString("kind")) {
                    "tap" -> "input tap ${num(j, "x")} ${num(j, "y")}"
                    "swipe" -> "input swipe ${num(j, "x")} ${num(j, "y")} ${num(j, "x2")} ${num(j, "y2")} ${j.optInt("ms", 300).coerceIn(10, 5000)}"
                    "key" -> "input keyevent ${j.optInt("code", -1).takeIf { it in 0..400 } ?: return Reply.done(c, id, cmd, "code: 0…400")}"
                    "text" -> "input text '${j.optString("text").take(200).filter { it.isLetterOrDigit() }.ifEmpty { return Reply.done(c, id, cmd, "text: letters and digits only") }}'"
                    else -> return Reply.done(c, id, cmd, "kind: tap, swipe, key or text")
                }
                root(c, id, cmd) { a }
            }
            "sys.notif.dismiss" -> {
                val l = NotifyListener.inst ?: return Reply.done(c, id, cmd, "give the DSP app Notification access in its Settings", "permission")
                val k = j.optString("key"); if (k.isEmpty()) l.cancelAllNotifications() else l.cancelNotification(k)
                Reply.done(c, id, cmd, null)
            }
            "ui.tap", "ui.swipe", "ui.global", "ui.click", "ui.screen", "ui.text" -> {
                val u = UiService.inst ?: return Reply.done(c, id, cmd, "turn the DSP app on in system Settings → Accessibility", "permission")
                u.exec(c, id, cmd, j)
            }
            "sys.bcast.listen" -> {
                val actions = j.optJSONArray("actions")?.let { a -> (0 until a.length()).mapNotNull { k -> a.optString(k).takeIf { it.isNotEmpty() } } } ?: emptyList()
                if (actions.isEmpty()) return Reply.done(c, id, cmd, "actions: a non-empty list of intent actions, e.g. android.intent.action.AIRPLANE_MODE_CHANGED")
                if (actions.any { !it.matches(Regex("[A-Za-z0-9_.]{1,150}")) }) return Reply.done(c, id, cmd, "actions: letters, digits, dot and underscore only")
                bcastRx?.let { try { ctx.unregisterReceiver(it) } catch (e: Exception) {} }
                val f = IntentFilter(); for (a in actions) f.addAction(a)
                val r = object : BroadcastReceiver() {
                    override fun onReceive(cx: Context, i: Intent) {
                        val kv = ArrayList<Pair<String, String?>>()
                        kv.add("action" to Json.str(i.action)); kv.add("pkg" to i.`package`?.let { Json.str(it) })
                        i.extras?.let { ex ->
                            val rows = ex.keySet().map { k -> Json.obj("k" to Json.str(k), "v" to Json.str(ex.get(k)?.toString())) }
                            if (rows.isNotEmpty()) kv.add("extras" to Json.rows(rows))
                        }
                        rec("broadcast", *kv.toTypedArray())
                    }
                }
                try {
                    if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(r, f, Context.RECEIVER_EXPORTED) else ctx.registerReceiver(r, f)
                    bcastRx = r
                    Reply.done(c, id, cmd, null, extra = arrayOf("n" to actions.size.toString()))
                } catch (e: Exception) { Reply.done(c, id, cmd, "bcast.listen: ${e.message}") }
            }
            "sys.bcast.stop" -> { bcastRx?.let { try { ctx.unregisterReceiver(it) } catch (e: Exception) {} }; bcastRx = null; Reply.done(c, id, cmd, null) }
            "sys.shell.exec" -> {
                val script = j.optString("script").takeIf { it.isNotEmpty() } ?: return Reply.done(c, id, cmd, "script: a shell command line")
                val root = j.optBoolean("root", false)
                val timeout = j.optLong("timeout", 15_000).coerceIn(100, 60_000)
                if (root && !cfg.sniffer) return Reply.done(c, id, cmd, "root features are off — tick «Allow root features» in the app Settings", "forbidden")
                Thread({
                    if (root) {
                        val (code, out) = RootSh.run(script, timeout)
                        Reply.done(c, id, cmd, null, extra = arrayOf("code" to code.toString(), "out" to Json.str(out.take(20_000))))
                    } else try {
                        val p = ProcessBuilder("sh", "-c", script).redirectErrorStream(true).start()
                        val out = StringBuilder()
                        val t = Thread({ try { p.inputStream.bufferedReader().forEachLine { if (out.length < 20_000) out.appendLine(it) } } catch (e: Exception) {} }).also { it.isDaemon = true; it.start() }
                        val finished = p.waitFor(timeout, TimeUnit.MILLISECONDS)
                        if (!finished) p.destroy()
                        t.join(500)
                        Reply.done(c, id, cmd, null, extra = arrayOf("code" to (if (finished) p.exitValue() else -1).toString(), "out" to Json.str(out.toString().take(20_000) + (if (!finished) "\n(timeout)" else ""))))
                    } catch (e: Exception) { Reply.done(c, id, cmd, "shell: ${e.message}") }
                }, "dsp-shell").also { it.isDaemon = true }.start()
            }
            else -> Reply.done(c, id, cmd, "unknown command", "unknown")
        }
    }

    private fun num(j: JSONObject, k: String) = j.optInt(k, 0).coerceIn(0, 10_000)

    /** Команда под root из фиксированных шаблонов; нужен тот же переключатель, что у перехвата пакетов. */
    private fun root(c: BridgeServer.Client, id: Any?, cmd: String, script: () -> String) {
        if (!cfg.sniffer) return Reply.done(c, id, cmd, "root features are off — tick «Allow root features» in the app Settings", "forbidden")
        Thread {
            val (code, out) = RootSh.run(script())
            Reply.done(c, id, cmd, if (code == 0) null else if (code == -1) "su: ${out.trim().ifEmpty { "no root" }}" else "failed ($code): ${out.trim().take(200)}")
        }.also { it.isDaemon = true }.start()
    }

    private fun rootAm(c: BridgeServer.Client, id: Any?, cmd: String, args: String) = root(c, id, cmd) { "am $args" }

    private fun intent(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        val kind = j.optString("kind", "broadcast")
        val i = Intent()
        j.optString("action").takeIf { it.isNotEmpty() }?.let { i.action = Args.safeToken(it) ?: return Reply.done(c, id, cmd, "action") }
        val data = j.optString("data"); val type = j.optString("type")
        if (data.isNotEmpty()) { val u = Uri.parse(data); if (type.isNotEmpty()) i.setDataAndType(u, type) else i.data = u } else if (type.isNotEmpty()) i.type = type
        val pkg = j.optString("pkg"); val cls = j.optString("cls")
        if (pkg.isNotEmpty() && cls.isNotEmpty()) i.component = ComponentName(Args.safeToken(pkg) ?: return Reply.done(c, id, cmd, "pkg"), Args.safeToken(cls) ?: return Reply.done(c, id, cmd, "cls"))
        else if (pkg.isNotEmpty()) i.setPackage(Args.safeToken(pkg) ?: return Reply.done(c, id, cmd, "pkg"))
        j.optJSONObject("extras")?.let { o -> for (k in o.keys()) when (val v = o.get(k)) { is Int -> i.putExtra(k, v); is Long -> i.putExtra(k, v); is Double -> i.putExtra(k, v); is Boolean -> i.putExtra(k, v); else -> i.putExtra(k, v.toString()) } }
        when (kind) {
            "broadcast" -> ctx.sendBroadcast(i)
            "service" -> ctx.startService(i)
            "activity" -> {
                if (j.optBoolean("root", false)) {
                    val a = StringBuilder("start")
                    i.action?.let { a.append(" -a ").append(it) }
                    if (data.isNotEmpty()) a.append(" -d ").append(Args.safeToken(data) ?: return Reply.done(c, id, cmd, "data: plain URL characters only under root"))
                    i.component?.let { a.append(" -n ").append(it.flattenToString()) }
                    return rootAm(c, id, cmd, a.toString())
                }
                ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            else -> return Reply.done(c, id, cmd, "kind: broadcast, service or activity")
        }
        Reply.done(c, id, cmd, null)
    }

    fun held(): Int = if (bcastRx != null) 1 else 0

    fun release() { bcastRx?.let { try { ctx.unregisterReceiver(it) } catch (e: Exception) {} }; bcastRx = null }

    fun close() { update(false); tts?.shutdown(); tts = null; bcastRx?.let { try { ctx.unregisterReceiver(it) } catch (e: Exception) {} } }
}
