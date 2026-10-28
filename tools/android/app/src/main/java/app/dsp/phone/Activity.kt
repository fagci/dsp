package app.dsp.phone

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.TriggerEvent
import android.hardware.TriggerEventListener
import android.os.HandlerThread
import android.os.SystemClock
import java.io.File

/**
 * Что делает владелец по датчикам телефона: still — лежит / стоит, moving — движется, walking — идёт (шаги). Чистая логика, без Android.
 * Время — мс эпохи. Датчики «неподвижен» / «движение» срабатывают раз (их взводят заново), шагомер даёт счётчик.
 */
class ActivityModel(private val walkSteps: Int = 8, private val windowMs: Long = 20_000, private val settleMs: Long = 30_000) {
    var state = "unknown"; private set
    var steps = -1f; private set
    private val hist = ArrayDeque<Pair<Long, Float>>()
    private var lastStepT = 0L

    private fun set(s: String): Boolean { if (s == state) return false; state = s; return true }

    fun still(): Boolean = set("still")
    fun motion(): Boolean = if (state == "walking") false else set("moving")

    /** Новый отсчёт счётчика шагов. true — состояние сменилось. */
    fun steps(count: Float, t: Long): Boolean {
        if (steps >= 0 && count > steps) lastStepT = t
        steps = count
        hist.addLast(t to count)
        while (hist.size > 1 && t - hist.first().first > windowMs) hist.removeFirst()
        return if (count - hist.first().second >= walkSteps) set("walking") else false
    }

    /** Шагов в минуту по окну (0 — мало данных). */
    fun cadence(): Int {
        if (hist.size < 2) return 0
        val a = hist.first(); val b = hist.last()
        return if (b.first - a.first < 3_000) 0 else ((b.second - a.second) * 60_000f / (b.first - a.first)).toInt()
    }

    /** Шаги прекратились: «идёт» → «движется»; дальше «неподвижен» придёт от датчика. */
    fun tick(now: Long): Boolean = state == "walking" && now - lastStepT > settleMs && set("moving")
}

/**
 * Источник activity: состояние ActivityModel + экран (погашен / заблокирован). Работает на датчиках с пробуждением и пакетном шагомере
 * (задержка до 60 с), поэтому не будит процессор на каждый шаг — можно держать всю ночь с заблокированным экраном. Смены состояния пишутся
 * в файл (Settings → «Log activity»), команда activity.log отдаёт историю без открытой страницы.
 */
class ActivityHub(private val ctx: Context, private val cfg: Config, private val emit: Emit) {
    private val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val kg = ctx.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
    private val thread = HandlerThread("dsp-activity").also { it.start() }
    private val handler = android.os.Handler(thread.looper)
    private val model = ActivityModel()
    private val file = File(ctx.filesDir, "activity.csv")
    private var on = false
    private val armed = HashSet<Int>()
    private var screen = true
    private var lastUse = 0L
    private var logged = ""

    private fun ms(nanos: Long) = System.currentTimeMillis() - (SystemClock.elapsedRealtimeNanos() - nanos) / 1_000_000

    private val trig = object : TriggerEventListener() {
        override fun onTrigger(e: TriggerEvent) {
            synchronized(this@ActivityHub) {
                val type = e.sensor.type
                armed.remove(type)
                if (!on) return
                val ch = if (type == Sensor.TYPE_STATIONARY_DETECT) model.still() else model.motion()
                arm(type)
                if (ch) publish()
            }
        }
    }

    private val stepL = object : SensorEventListener {
        override fun onSensorChanged(e: SensorEvent) {
            synchronized(this@ActivityHub) { if (on && model.steps(e.values[0], ms(e.timestamp))) publish() }
        }
        override fun onAccuracyChanged(s: Sensor?, a: Int) {}
    }

    private val rx = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            synchronized(this@ActivityHub) {
                when (i.action) {
                    Intent.ACTION_SCREEN_OFF -> screen = false
                    Intent.ACTION_SCREEN_ON -> screen = true
                    Intent.ACTION_USER_PRESENT -> lastUse = System.currentTimeMillis()
                }
                if (on) publish()
            }
        }
    }

    private fun arm(type: Int) {
        if (type in armed) return
        val s = sm.getDefaultSensor(type, true) ?: sm.getDefaultSensor(type) ?: return      // версия с пробуждением процессора
        if (sm.requestTriggerSensor(trig, s)) armed.add(type)
    }

    /** Включить / выключить; зовётся при каждой смене подписок и настроек. */
    @Synchronized
    fun update(want: Boolean): Boolean {
        if (want == on) return true
        on = want
        if (!want) {
            sm.unregisterListener(stepL)
            for (t in armed.toList()) (sm.getDefaultSensor(t, true) ?: sm.getDefaultSensor(t))?.let { sm.cancelTriggerSensor(trig, it) }
            armed.clear()
            try { ctx.unregisterReceiver(rx) } catch (e: IllegalArgumentException) {}
            return true
        }
        screen = (ctx.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager).isInteractive
        ctx.registerReceiver(rx, IntentFilter(Intent.ACTION_SCREEN_OFF).apply { addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_USER_PRESENT) })
        arm(Sensor.TYPE_STATIONARY_DETECT); arm(Sensor.TYPE_MOTION_DETECT); arm(Sensor.TYPE_SIGNIFICANT_MOTION)
        val st = sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
        var ok = armed.isNotEmpty()
        val canSteps = android.os.Build.VERSION.SDK_INT < 29 || ctx.granted(android.Manifest.permission.ACTIVITY_RECOGNITION)
        if (st != null && canSteps)
            ok = sm.registerListener(stepL, st, SensorManager.SENSOR_DELAY_NORMAL, 60_000_000, handler) || ok
        publish()
        return ok
    }

    @Synchronized
    fun close() { update(false); thread.quitSafely() }

    @Synchronized
    fun tick() { if (on && model.tick(System.currentTimeMillis())) publish() }

    @Synchronized
    fun push() { if (on) emit("activity", record(System.currentTimeMillis())) }

    private fun record(t: Long) = Json.obj("src" to "\"activity\"", "t" to t.toString(), "state" to Json.str(model.state),
        "locked" to if (kg.isKeyguardLocked) "1" else "0", "screen" to if (screen) "1" else "0",
        "steps" to model.steps.takeIf { it >= 0 }?.toLong()?.toString(), "cadence" to model.cadence().toString(), "unlocked" to lastUse.takeIf { it > 0 }?.toString())

    /** Смена состояния подписчикам; в файл — только когда сменилось состояние или экран. */
    private fun publish() {
        val t = System.currentTimeMillis()
        emit("activity", record(t))
        if (!cfg.activityLog) return
        val key = model.state + (if (kg.isKeyguardLocked) "L" else "U") + (if (screen) "S" else "-")
        if (key == logged) return
        logged = key
        try {
            if (file.length() > 400_000) file.writeText(file.readLines().takeLast(2000).joinToString("\n", postfix = "\n"))
            file.appendText("$t,${model.state},${if (kg.isKeyguardLocked) 1 else 0},${if (screen) 1 else 0},${model.steps.takeIf { it >= 0 }?.toLong() ?: ""}\n")
        } catch (e: Exception) { /* нет места — история не критична */ }
    }

    /** История из файла: записи {src:'activity', hist:1, t, state, locked, screen, steps} с метки since (мс), не больше limit. */
    fun history(since: Long, limit: Int): List<String> {
        val out = ArrayList<String>()
        try {
            for (l in file.readLines()) {
                val p = l.split(',')
                val t = p.getOrNull(0)?.toLongOrNull() ?: continue
                if (t < since || p.size < 4) continue
                out.add(Json.obj("src" to "\"activity\"", "hist" to "1", "t" to t.toString(), "state" to Json.str(p[1]), "locked" to p[2], "screen" to p[3], "steps" to p.getOrNull(4)?.takeIf { it.isNotEmpty() }))
            }
        } catch (e: Exception) {}
        return out.takeLast(limit.coerceIn(1, 5000))
    }
}
