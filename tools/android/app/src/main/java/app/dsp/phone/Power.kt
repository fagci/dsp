package app.dsp.phone

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager

/** Во сколько раз реже опрашивать источники при разряде, экономии энергии и перегреве: 1 — как просили, 2 / 4 — реже. */
object PowerPolicy {
    /** prev — прежний коэффициент: порог выхода выше порога входа, чтобы на границе не дребезжало. */
    fun factor(pct: Int, charging: Boolean, saver: Boolean, thermal: Int, prev: Int = 1): Int {
        val h = if (prev > 1) 3 else 0
        var f = 1
        if (thermal >= 3) f = 4 else if (thermal == 2) f = 2
        if (!charging && pct >= 0) {
            if (pct < 10 + h) f = maxOf(f, 4) else if (pct < 20 + h) f = maxOf(f, 2)
        }
        if (saver && !charging) f = maxOf(f, 2)
        return f
    }
}

/** Питание телефона: заряд, режим экономии, нагрев. Источник power и коэффициент, на который сервис замедляет опрос. */
class PowerHub(private val ctx: Context, private val cfg: Config, private val emit: Emit, private val extra: () -> List<Pair<String, String?>>, private val onChange: () -> Unit) : BroadcastReceiver() {
    @Volatile var factor = 1
        private set
    private var pct = -1
    private var charging = false
    private var saver = false
    private var thermal = 0
    private var thermalCb: Any? = null

    fun start() {
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        saver = pm.isPowerSaveMode
        val f = IntentFilter(Intent.ACTION_BATTERY_CHANGED).apply { addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED) }
        ctx.registerReceiver(this, f)?.let { read(it) }
        if (Build.VERSION.SDK_INT >= 29) {
            val cb = PowerManager.OnThermalStatusChangedListener { s -> thermal = s; recalc() }
            thermalCb = cb
            try { pm.addThermalStatusListener(ctx.mainExecutor, cb); thermal = pm.currentThermalStatus } catch (e: Exception) { thermalCb = null }
        }
        recalc()
    }

    fun close() {
        try { ctx.unregisterReceiver(this) } catch (e: IllegalArgumentException) {}
        if (Build.VERSION.SDK_INT >= 29) (thermalCb as? PowerManager.OnThermalStatusChangedListener)?.let {
            try { (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager).removeThermalStatusListener(it) } catch (e: Exception) {}
        }
        thermalCb = null
    }

    override fun onReceive(c: Context, i: Intent) {
        if (i.action == PowerManager.ACTION_POWER_SAVE_MODE_CHANGED) saver = (c.getSystemService(Context.POWER_SERVICE) as PowerManager).isPowerSaveMode
        else read(i)
        recalc()
    }

    private fun read(i: Intent) {
        val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
        if (level >= 0 && scale > 0) pct = level * 100 / scale
        val st = i.getIntExtra(BatteryManager.EXTRA_STATUS, 0)
        charging = st == BatteryManager.BATTERY_STATUS_CHARGING || st == BatteryManager.BATTERY_STATUS_FULL
    }

    @Synchronized
    private fun recalc() {
        val f = if (cfg.autoThrottle) PowerPolicy.factor(pct, charging, saver, thermal, factor) else 1
        val changed = f != factor
        factor = f
        push()
        if (changed) onChange()
    }

    /** Текущее состояние подписчикам power (и при каждой смене подписок: новый клиент сразу получает запись). */
    fun push() {
        emit("power", Json.obj("src" to "\"power\"", "t" to System.currentTimeMillis().toString(), "pct" to pct.toString(), "charging" to if (charging) "1" else "0",
            "saver" to if (saver) "1" else "0", "thermal" to thermal.toString(), "throttle" to factor.toString(), *extra().toTypedArray()))
    }
}
