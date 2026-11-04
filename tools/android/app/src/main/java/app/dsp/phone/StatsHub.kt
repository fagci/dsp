package app.dsp.phone

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import java.util.Calendar
import java.util.concurrent.TimeUnit

/** Разбор `dumpsys batterystats`: оценка мА·ч по uid. Чистая логика без Android API — проверяется в jvm-тесте. */
object Batts {
    private val UID_MAH = Regex("""^ +Uid (\S+):\s+([0-9.]+)""")
    private val A_UID = Regex("""^u\d+a(\d+)$""")

    /** uid из batterystats в число: "u0a203" → 10203, "u0" → 0, "system" → 1000, "root" → 0; неизвестное — null. */
    fun uidNumber(uid: String): Int? = when (uid) {
        "system" -> 1000
        "root", "u0" -> 0
        else -> A_UID.find(uid)?.let { 10000 + it.groupValues[1].toInt() }
    }

    /** Секция Estimated power use: uid → мА·ч, по убыванию. Строки вида "  Uid u0a203: 12.34 ( cpu=… )". */
    fun uidMah(text: String): List<Pair<String, Double>> =
        text.lineSequence().mapNotNull { l ->
            UID_MAH.find(l)?.let { m -> m.groupValues[2].toDoubleOrNull()?.let { v -> m.groupValues[1] to v } }
        }.sortedByDescending { it.second }.toList()
}

/**
 * Источники bstat и usage: электрические величины батареи в реальном времени и статистика использования приложений.
 * bstat — каждые statEvery·throttle() с (по умолчанию 1 с): ток, напряжение, счётчик заряда (BatteryManager;
 * без значений — /sys/class/power_supply/battery через root). usage — не чаще раза в 30 с: топ приложений по времени
 * в foreground за сегодня и оценка мА·ч по приложениям из dumpsys batterystats (нужен DUMP по adb
 * `pm grant app.dsp.phone android.permission.DUMP`, иначе root; без обоих — только времена). Доступ к статистике
 * использования — особое разрешение: Settings → Apps → Special app access → Usage access.
 */
class StatsHub(private val ctx: Context, private val emit: Emit, private val throttle: () -> Int) {
    private val thread = HandlerThread("dsp-stats").also { it.start() }
    private val h = Handler(thread.looper)
    private val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
    private val pm = ctx.packageManager
    private var wantB = false
    private var wantU = false
    private var every = 1
    private var lastU = 0L
    private var rootTried = false

    /** Разрешён ли доступ к статистике использования (Settings → Special app access → Usage access). */
    @Volatile var usageGranted = false
        private set

    @Synchronized
    fun update(wantBstat: Boolean, wantUsage: Boolean, statEvery: Int) {
        every = statEvery.coerceIn(1, 600)
        wantB = wantBstat
        wantU = wantUsage
        h.removeCallbacks(tick)
        if (wantB || wantU) h.post(tick)
    }

    fun close() { h.removeCallbacks(tick); thread.quitSafely() }

    private val tick = object : Runnable {
        override fun run() {
            val f = maxOf(1, throttle())
            try { if (wantB) pushBstat() } catch (e: Exception) { }
            try { if (wantU && System.currentTimeMillis() - lastU >= maxOf(every, 30) * f * 1000L) { lastU = System.currentTimeMillis(); pushUsage() } } catch (e: Exception) { }
            synchronized(this@StatsHub) { if (wantB || wantU) h.postDelayed(this, every * 1000L * f) }
        }
    }

    /** Ток (мкА, знак зависит от устройства: чаще минус при разряде), напряжение (В), счётчик заряда (мкАч), ёмкость (%). */
    private fun pushBstat() {
        val ua = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW, Int.MIN_VALUE)
        val avg = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_AVERAGE, Int.MIN_VALUE)
        val uah = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER, Int.MIN_VALUE)
        val cap = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY, -1)
        val volt = ((ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))?.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1)) ?: -1) / 1000.0
        var sys = 0
        var ua2 = ua
        var volt2 = if (volt > 0) volt else Double.NaN
        var uah2 = uah
        if ((ua == Int.MIN_VALUE || ua == 0) && root()) {
            // sysfs ABI power_supply: current_now в мкА (на старых — мА), voltage_now в мкВ, charge_counter в мкАч
            val r = RootSh.run("for f in current_now voltage_now charge_counter; do cat /sys/class/power_supply/battery/$f 2>/dev/null; done", 8000)
            if (r.first == 0) {
                val lines = r.second.lineSequence().mapNotNull { it.trim().toIntOrNull() }.toList()
                if (lines.isNotEmpty()) { sys = 1; ua2 = lines[0] }
                if (lines.size > 1 && !volt2.isFinite()) volt2 = lines[1] / 1_000_000.0
                if (lines.size > 2 && uah2 == Int.MIN_VALUE) uah2 = lines[2]
            }
        }
        emit("bstat", Json.obj(
            "src" to "\"bstat\"", "t" to System.currentTimeMillis().toString(),
            "ua" to if (ua2 != Int.MIN_VALUE) ua2.toString() else null,
            "avg" to if (avg != Int.MIN_VALUE) avg.toString() else null,
            "uah" to if (uah2 != Int.MIN_VALUE) uah2.toString() else null,
            "cap" to if (cap >= 0) cap.toString() else null,
            "volt" to if (volt2.isFinite()) Json.num(volt2, 100.0) else null,
            "sys" to if (sys == 1) "1" else null,
        ))
    }

    /** Топ приложений по времени в foreground за сегодня и расход мА·ч по приложениям с последней зарядки. */
    private fun pushUsage() {
        val now = System.currentTimeMillis()
        val dayStart = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }.timeInMillis
        usageGranted = usageAllowed()
        val pairs = ArrayList<Pair<String, String?>>()
        pairs.add("src" to "\"usage\"")
        pairs.add("t" to now.toString())
        pairs.add("granted" to if (usageGranted) "1" else "0")
        if (usageGranted) {
            val usm = ctx.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
            val top = (usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, dayStart, now) ?: emptyList())
                .filter { it.totalTimeInForeground > 0 }.sortedByDescending { it.totalTimeInForeground }.take(10)
            pairs.add("top" to Json.rows(top.map { Json.obj("pkg" to Json.str(it.packageName), "min" to Json.num(it.totalTimeInForeground / 60000.0)) }))
            val ev = usm.queryEvents(dayStart, now)
            val e = UsageEvents.Event()
            var fg = ""
            while (ev.hasNextEvent()) { ev.getNextEvent(e); if (e.eventType == UsageEvents.Event.MOVE_TO_FOREGROUND) fg = e.packageName }
            pairs.add("fg" to Json.str(fg).takeIf { fg.isNotEmpty() })
        }
        val drain = drainMah()
        if (drain != null) pairs.add("drain" to Json.rows(drain.take(10).map { (app, mah) -> Json.obj("app" to Json.str(app), "mah" to Json.num(mah)) }))
        emit("usage", Json.obj(*pairs.toTypedArray()))
    }

    /** мА·ч по приложениям с последней зарядки: dumpsys batterystats (DUMP по adb или root), имена пакетов по uid. */
    private fun drainMah(): List<Pair<String, Double>>? {
        val text = if (dumpGranted()) execDumpsys()
        else if (root()) RootSh.run("dumpsys batterystats | grep -E ' Uid u[0-9a]+: [0-9]'", 30_000).let { if (it.first == 0) it.second else null }
        else null
        if (text.isNullOrBlank()) return null
        return Batts.uidMah(text).map { (uid, mah) -> (appName(uid) ?: uid) to mah }
    }

    /** Только строки Estimated power use: вывод большой (мегабайты), читаем потоком и отбрасываем лишнее. */
    private fun execDumpsys(): String? = try {
        val p = ProcessBuilder("dumpsys", "batterystats").redirectErrorStream(true).start()
        val out = StringBuilder()
        p.inputStream.bufferedReader().useLines { lines ->
            lines.forEach { l ->
                if (out.length < 20_000 && l.startsWith("  Uid ") && l.drop(6).firstOrNull() == 'u') out.appendLine(l)
            }
        }
        if (!p.waitFor(15, TimeUnit.SECONDS)) { p.destroy(); null } else if (out.isEmpty()) null else out.toString()
    } catch (e: Exception) { null }

    private fun appName(uid: String): String? {
        val n = Batts.uidNumber(uid) ?: return null
        if (n == 0) return "Android"
        return pm.getPackagesForUid(n)?.firstOrNull()
    }

    private fun usageAllowed(): Boolean = try {
        val aom = ctx.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        aom.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName) == AppOpsManager.MODE_ALLOWED
    } catch (e: Exception) { false }

    private fun dumpGranted(): Boolean = ctx.checkPermission(DUMP, Process.myPid(), Process.myUid()) == PackageManager.PERMISSION_GRANTED

    /** su отвечает — дальше /sys и dumpsys идут через root. Проверяем один раз, отказ запоминаем. */
    @Synchronized
    private fun root(): Boolean {
        if (!rootTried) {
            rootTried = true
            rootOk = RootSh.run("id -u", 5000).let { it.first == 0 && it.second.trim() == "0" }
        }
        return rootOk
    }

    @Volatile
    private var rootOk = false

    companion object {
        private const val DUMP = "android.permission.DUMP"
    }
}
