package app.dsp.phone

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock

typealias Emit = (src: String, json: String) -> Unit

fun Context.granted(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED
fun Context.hasLocation() = granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION)

/** Акселерометр, гироскоп и прочие датчики до 200 Гц (в фоне только пока работает foreground-сервис). */
class SensorHub(ctx: Context, private val emit: Emit) : SensorEventListener {
    private val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val thread = HandlerThread("dsp-sensors").also { it.start() }
    private val handler = Handler(thread.looper)
    private val active = HashMap<String, Int>()      // вид → Гц

    companion object {
        val TYPES = linkedMapOf(
            "accel" to Sensor.TYPE_ACCELEROMETER, "gyro" to Sensor.TYPE_GYROSCOPE, "mag" to Sensor.TYPE_MAGNETIC_FIELD,
            "light" to Sensor.TYPE_LIGHT, "pressure" to Sensor.TYPE_PRESSURE, "proximity" to Sensor.TYPE_PROXIMITY,
            "gravity" to Sensor.TYPE_GRAVITY, "linear" to Sensor.TYPE_LINEAR_ACCELERATION, "rotation" to Sensor.TYPE_ROTATION_VECTOR,
        )
        private val XYZ = setOf("accel", "gyro", "mag", "gravity", "linear", "rotation")
    }

    private val kindOf = TYPES.entries.associate { it.value to it.key }

    fun available(): List<String> = TYPES.filter { sm.getDefaultSensor(it.value) != null }.keys.toList()

    /** Включает нужные датчики с частотой hz, лишние выключает. Возвращает виды, которых на телефоне нет. */
    @Synchronized
    fun update(want: Set<String>, hz: Int): List<String> {
        val missing = ArrayList<String>()
        for ((kind, type) in TYPES) {
            val sensor = sm.getDefaultSensor(type)
            if (kind in want) {
                if (sensor == null) { missing.add(kind); continue }
                if (active[kind] == hz) continue
                sm.unregisterListener(this, sensor)
                if (sm.registerListener(this, sensor, 1_000_000 / hz.coerceIn(1, 200), handler)) active[kind] = hz
            } else if (active.remove(kind) != null) {
                sm.unregisterListener(this, sensor)
            }
        }
        return missing
    }

    @Synchronized
    fun stop() { sm.unregisterListener(this); active.clear() }

    fun close() { stop(); thread.quitSafely() }

    override fun onSensorChanged(e: SensorEvent) {
        val kind = kindOf[e.sensor.type] ?: return
        val v = e.values
        // время события в часах телефона (elapsedRealtime) → мс эпохи
        val t = System.currentTimeMillis() - (SystemClock.elapsedRealtimeNanos() - e.timestamp) / 1_000_000
        val xyz = kind in XYZ && v.size >= 3
        emit(kind, Json.obj(
            "src" to "\"sensor\"", "sensor" to "\"$kind\"", "t" to t.toString(),
            "x" to Json.num(v[0].toDouble()),
            "y" to if (xyz) Json.num(v[1].toDouble()) else null,
            "z" to if (xyz) Json.num(v[2].toDouble()) else null,
            "w" to if (kind == "rotation" && v.size >= 4) Json.num(v[3].toDouble()) else null,
        ))
    }

    override fun onAccuracyChanged(s: Sensor?, a: Int) {}
}

/** Положение: GPS и по сети; последнее — для Wi-Fi записей. */
class GpsHub(private val ctx: Context, private val emit: Emit) : LocationListener {
    private val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private val thread = HandlerThread("dsp-gps").also { it.start() }
    private var on = false
    @Volatile var fix: Location? = null

    /** false — нет разрешения или выключена геолокация. */
    @Synchronized
    fun update(want: Boolean): Boolean {
        if (want == on) return true
        if (!want) { lm.removeUpdates(this); on = false; return true }
        if (!ctx.hasLocation()) return false
        var any = false
        try {
            for (p in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
                if (lm.isProviderEnabled(p)) { lm.requestLocationUpdates(p, 1000L, 0f, this, thread.looper); any = true }
            }
        } catch (e: SecurityException) { return false }
        on = any
        return any
    }

    @Synchronized
    fun close() { lm.removeUpdates(this); on = false; thread.quitSafely() }

    override fun onLocationChanged(l: Location) {
        fix = l
        emit("gps", Json.obj(
            "src" to "\"gps\"", "id" to "\"me\"", "provider" to Json.str(l.provider),
            "lat" to Json.num(l.latitude, 1e7), "lon" to Json.num(l.longitude, 1e7),
            "alt" to if (l.hasAltitude()) Json.num(l.altitude, 10.0) else null,
            "acc" to if (l.hasAccuracy()) Json.num(l.accuracy.toDouble(), 10.0) else null,
            "speed" to if (l.hasSpeed()) Json.num(l.speed.toDouble(), 100.0) else null,
            "bearing" to if (l.hasBearing()) Json.num(l.bearing.toDouble(), 10.0) else null,
        ))
    }

    @Deprecated("старые версии Android вызывают его") override fun onStatusChanged(p: String?, s: Int, e: android.os.Bundle?) {}
    override fun onProviderEnabled(p: String) {}
    override fun onProviderDisabled(p: String) {}
}

/** Wi-Fi точки: ssid, bssid, rssi, частота + последнее положение. Android сам ограничивает частоту сканов. */
class WifiHub(private val ctx: Context, private val gps: GpsHub, private val emit: Emit) : BroadcastReceiver() {
    private val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private val thread = HandlerThread("dsp-wifi").also { it.start() }
    private val handler = Handler(thread.looper)
    private var on = false
    private var every = 10
    private var lastStamp = 0L

    private val tick = object : Runnable {
        override fun run() {
            if (!on) return
            try { @Suppress("DEPRECATION") wm.startScan() } catch (e: SecurityException) {}
            handler.postDelayed(this, every * 1000L)
        }
    }

    /** false — нет разрешения на геолокацию (без него Android не отдаёт список). */
    @Synchronized
    fun update(want: Boolean, everySec: Int): Boolean {
        every = everySec.coerceIn(2, 600)
        if (want == on) return true
        if (!want) {
            on = false; handler.removeCallbacksAndMessages(null)
            try { ctx.unregisterReceiver(this) } catch (e: IllegalArgumentException) {}
            return true
        }
        if (!ctx.hasLocation()) return false
        on = true
        ctx.registerReceiver(this, IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION), null, handler)
        handler.post(tick)
        return true
    }

    fun close() { update(false, every); thread.quitSafely() }

    override fun onReceive(c: Context, i: Intent) {
        val list = try { wm.scanResults } catch (e: SecurityException) { return } ?: return
        if (list.isEmpty()) return
        // тот же скан приходит повторно (кэш) — по самой свежей метке времени
        val stamp = list.maxOf { it.timestamp }
        if (stamp == lastStamp) return
        lastStamp = stamp
        val f = gps.fix?.takeIf { SystemClock.elapsedRealtime() - it.elapsedRealtimeNanos / 1_000_000 < 30_000 }
        for (r in list) {
            @Suppress("DEPRECATION") val ssid = r.SSID
            emit("wifi", Json.obj(
                "src" to "\"wifi\"", "bssid" to Json.str(r.BSSID), "ssid" to Json.str(ssid),
                "rssi" to r.level.toString(), "freq" to r.frequency.toString(),
                "lat" to f?.let { Json.num(it.latitude, 1e7) }, "lon" to f?.let { Json.num(it.longitude, 1e7) },
                "acc" to f?.takeIf { it.hasAccuracy() }?.let { Json.num(it.accuracy.toDouble(), 10.0) },
            ))
        }
    }
}

/** Батарея: процент, состояние, температура. */
class BatteryHub(private val ctx: Context, private val emit: Emit) : BroadcastReceiver() {
    private var on = false

    @Synchronized
    fun update(want: Boolean) {
        if (want == on) return
        on = want
        if (want) ctx.registerReceiver(this, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        else try { ctx.unregisterReceiver(this) } catch (e: IllegalArgumentException) {}
    }

    fun close() = update(false)

    override fun onReceive(c: Context, i: Intent) {
        val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
        if (level < 0 || scale <= 0) return
        val status = when (i.getIntExtra(BatteryManager.EXTRA_STATUS, 0)) {
            BatteryManager.BATTERY_STATUS_CHARGING -> "CHARGING"
            BatteryManager.BATTERY_STATUS_FULL -> "FULL"
            BatteryManager.BATTERY_STATUS_DISCHARGING -> "DISCHARGING"
            BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "NOT_CHARGING"
            else -> "UNKNOWN"
        }
        val plugged = when (i.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)) {
            BatteryManager.BATTERY_PLUGGED_AC -> "PLUGGED_AC"
            BatteryManager.BATTERY_PLUGGED_USB -> "PLUGGED_USB"
            BatteryManager.BATTERY_PLUGGED_WIRELESS -> "PLUGGED_WIRELESS"
            else -> "UNPLUGGED"
        }
        val temp = i.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
        emit("battery", Json.obj(
            "src" to "\"battery\"", "pct" to Json.num(level * 100.0 / scale, 10.0), "status" to "\"$status\"", "plugged" to "\"$plugged\"",
            "temp" to if (temp != Int.MIN_VALUE) Json.num(temp / 10.0, 10.0) else null,
        ))
    }
}
