package app.dsp.phone

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.location.GnssMeasurementsEvent
import android.location.GnssStatus
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.os.ParcelUuid
import org.json.JSONObject

private fun Context.btAdapter(): BluetoothAdapter? = (getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

fun Context.hasBluetooth() = btAdapter() != null

/** С Android 12 сканированию нужно BLUETOOTH_SCAN (и геолокация, раз положение берём в записи), раньше — геолокация. */
fun Context.canScanBt() = if (Build.VERSION.SDK_INT >= 31) granted(Manifest.permission.BLUETOOTH_SCAN) && hasLocation() else hasLocation()

private fun lat(l: android.location.Location?) = posPairs(l)

/** BLE: каждая реклама — запись (адрес, имя, RSSI, данные производителя, службы, сырые байты) с последним положением. */
class BleHub(private val ctx: Context, private val gps: GpsHub, private val emit: Emit) : ScanCallback() {
    private var on = false
    private var cur = ""
    @Volatile var lastError = ""

    /**
     * Настройки скана (то, чего нет в Web Bluetooth): mode low_latency | balanced | low_power | opportunistic, legacy (false — и расширенная
     * реклама), phy all | 1m | coded, match aggressive | sticky, delay (мс, пакетная выдача), фильтры name / addr / uuid / mfr (hex id компании).
     */
    class Opts(val json: String) {
        val o = try { JSONObject(json.ifEmpty { "{}" }) } catch (e: Exception) { JSONObject() }
        fun settings(): ScanSettings {
            val b = ScanSettings.Builder().setScanMode(when (o.optString("mode", "low_latency")) {
                "balanced" -> ScanSettings.SCAN_MODE_BALANCED; "low_power" -> ScanSettings.SCAN_MODE_LOW_POWER
                "opportunistic" -> ScanSettings.SCAN_MODE_OPPORTUNISTIC; else -> ScanSettings.SCAN_MODE_LOW_LATENCY })
            if (o.has("legacy")) b.setLegacy(o.optBoolean("legacy", true))
            when (o.optString("phy", "all")) { "1m" -> b.setPhy(android.bluetooth.BluetoothDevice.PHY_LE_1M); "coded" -> b.setPhy(android.bluetooth.BluetoothDevice.PHY_LE_CODED); else -> b.setPhy(ScanSettings.PHY_LE_ALL_SUPPORTED) }
            if (o.optString("match") == "sticky") b.setMatchMode(ScanSettings.MATCH_MODE_STICKY) else if (o.optString("match") == "aggressive") b.setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE)
            val d = o.optLong("delay", 0); if (d > 0) b.setReportDelay(d.coerceAtMost(60_000))
            return b.build()
        }
        fun filters(): List<ScanFilter>? {
            val f = ScanFilter.Builder(); var any = false
            o.optString("name").takeIf { it.isNotEmpty() }?.let { f.setDeviceName(it); any = true }
            Args.mac(o.optString("addr"))?.let { f.setDeviceAddress(it); any = true }
            Args.uuid(o.optString("uuid"))?.let { f.setServiceUuid(ParcelUuid(it)); any = true }
            o.optString("mfr").toIntOrNull(16)?.let { f.setManufacturerData(it, ByteArray(0), ByteArray(0)); any = true }
            return if (any) listOf(f.build()) else null
        }
    }

    /** false — нет разрешения или Bluetooth выключен (причина в lastError). opts — JSON настроек скана (см. Opts). */
    @Synchronized
    fun update(want: Boolean, opts: String = ""): Boolean {
        if (want == on && (!want || opts == cur)) return true
        val sc = ctx.btAdapter()?.takeIf { it.isEnabled }?.bluetoothLeScanner
        if (on) { on = false; try { sc?.stopScan(this) } catch (e: Exception) {} }
        if (!want) return true
        if (!ctx.canScanBt()) { lastError = "ble: allow Nearby devices (Bluetooth) for the DSP app"; return false }
        if (sc == null) { lastError = "ble: Bluetooth is off"; return false }
        return try {
            val o = Opts(opts)
            sc.startScan(o.filters(), o.settings(), this)
            on = true; cur = opts; true
        } catch (e: Exception) { lastError = "ble: ${e.message}"; false }
    }

    fun close() { update(false) }

    override fun onScanFailed(code: Int) { on = false; lastError = "ble: scan failed ($code)" }

    override fun onBatchScanResults(l: MutableList<ScanResult>) { for (r in l) onScanResult(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, r) }

    override fun onScanResult(type: Int, r: ScanResult) {
        val bytes = r.scanRecord?.bytes ?: ByteArray(0)
        val ad = Ad.parse(bytes)
        val t = System.currentTimeMillis() - (SystemClock.elapsedRealtimeNanos() - r.timestampNanos) / 1_000_000
        val txp = ad.txp ?: if (Build.VERSION.SDK_INT >= 26 && r.txPower != ScanResult.TX_POWER_NOT_PRESENT) r.txPower else null
        val kv = ArrayList<Pair<String, String?>>()
        kv.add("src" to "\"ble\""); kv.add("t" to t.toString()); kv.add("addr" to Json.str(r.device.address))
        (ad.name ?: r.scanRecord?.deviceName)?.let { kv.add("name" to Json.str(it)) }
        kv.add("rssi" to r.rssi.toString())
        txp?.let { kv.add("txp" to it.toString()) }
        if (Build.VERSION.SDK_INT >= 26) {
            kv.add("conn" to if (r.isConnectable) "1" else "0"); kv.add("legacy" to if (r.isLegacy) "1" else "0")
            kv.add("pphy" to r.primaryPhy.toString()); kv.add("sphy" to r.secondaryPhy.toString())      // 1 — 1M, 2 — 2M, 3 — Coded, 0 — нет
            if (r.advertisingSid != ScanResult.SID_NOT_PRESENT) kv.add("sid" to r.advertisingSid.toString())
            if (r.periodicAdvertisingInterval != 0) kv.add("pint" to r.periodicAdvertisingInterval.toString())
        }
        ad.flags?.let { kv.add("flags" to it.toString()) }
        ad.appearance?.let { kv.add("app" to it.toString()) }
        if (ad.uuids.isNotEmpty()) kv.add("uuids" to Json.arr(ad.uuids))
        if (ad.mfr.isNotEmpty()) kv.add("mfr" to Json.map(ad.mfr))
        if (ad.svc.isNotEmpty()) kv.add("svc" to Json.map(ad.svc))
        if (bytes.isNotEmpty()) kv.add("raw" to Json.str(Hex.of(bytes)))
        kv.addAll(lat(gps.recent()))
        emit("ble", Json.obj(*kv.toTypedArray()))
    }
}

/** Классический Bluetooth: поиск устройств кругами (≈12 с), запись на каждое найденное. */
class BtHub(private val ctx: Context, private val gps: GpsHub, private val emit: Emit) : BroadcastReceiver() {
    private val thread = HandlerThread("dsp-bt").also { it.start() }
    private val handler = Handler(thread.looper)
    private var on = false
    @Volatile var lastError = ""

    private val kick = Runnable {
        val a = ctx.btAdapter()
        try { if (on && a != null && a.isEnabled && !a.isDiscovering) @Suppress("MissingPermission") a.startDiscovery() } catch (e: SecurityException) { lastError = "bt: no permission" }
    }

    @Synchronized
    fun update(want: Boolean): Boolean {
        if (want == on) return true
        val a = ctx.btAdapter()
        if (!want) {
            on = false; handler.removeCallbacksAndMessages(null)
            try { ctx.unregisterReceiver(this) } catch (e: IllegalArgumentException) {}
            try { @Suppress("MissingPermission") a?.cancelDiscovery() } catch (e: SecurityException) {}
            return true
        }
        if (!ctx.canScanBt()) { lastError = "bt: allow Nearby devices (Bluetooth) for the DSP app"; return false }
        if (a == null || !a.isEnabled) { lastError = "bt: Bluetooth is off"; return false }
        on = true
        val f = IntentFilter(BluetoothDevice.ACTION_FOUND).also { it.addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED) }
        ctx.registerReceiver(this, f, null, handler)
        handler.post(kick)
        return true
    }

    fun close() { update(false); thread.quitSafely() }

    @Suppress("DEPRECATION")
    override fun onReceive(c: Context, i: Intent) {
        if (i.action == BluetoothAdapter.ACTION_DISCOVERY_FINISHED) { if (on) handler.postDelayed(kick, 1500); return }
        val d = if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
            else i.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE)
        d ?: return
        val cls = if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(BluetoothDevice.EXTRA_CLASS, BluetoothClass::class.java)
            else i.getParcelableExtra<BluetoothClass>(BluetoothDevice.EXTRA_CLASS)
        val rssi = i.getShortExtra(BluetoothDevice.EXTRA_RSSI, Short.MIN_VALUE)
        val kv = ArrayList<Pair<String, String?>>()
        kv.add("src" to "\"bt\""); kv.add("t" to System.currentTimeMillis().toString()); kv.add("addr" to Json.str(d.address))
        i.getStringExtra(BluetoothDevice.EXTRA_NAME)?.let { kv.add("name" to Json.str(it)) }
        if (rssi != Short.MIN_VALUE) kv.add("rssi" to rssi.toString())
        if (cls != null) { kv.add("cls" to cls.deviceClass.toString()); kv.add("major" to Json.str(Bt.major(cls.majorDeviceClass))) }
        kv.addAll(lat(gps.recent()))
        emit("bt", Json.obj(*kv.toTypedArray()))
    }
}

/** ГНСС: по спутникам (status), сырые измерения (raw), строки NMEA. Работает, пока включено определение положения. */
@Suppress("DEPRECATION")
class GnssHub(private val ctx: Context, private val emit: Emit) {
    private val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private val thread = HandlerThread("dsp-gnss").also { it.start() }
    private val handler = Handler(thread.looper)
    private var status = false
    private var raw = false
    private var nmea = false

    private val statusCb = object : GnssStatus.Callback() {
        override fun onSatelliteStatusChanged(s: GnssStatus) {
            val t = System.currentTimeMillis().toString()
            var used = 0; var cn0 = 0.0
            for (i in 0 until s.satelliteCount) {
                val u = s.usedInFix(i)
                if (u) { used++; cn0 += s.getCn0DbHz(i) }
                val f = if (Build.VERSION.SDK_INT >= 26 && s.hasCarrierFrequencyHz(i)) s.getCarrierFrequencyHz(i).toDouble() else null
                emit("gnss", Json.obj(
                    "src" to "\"gnss\"", "kind" to "\"sat\"", "t" to t, "con" to Json.str(Gnss.constellation(s.getConstellationType(i))),
                    "svid" to s.getSvid(i).toString(), "cn0" to Json.num(s.getCn0DbHz(i).toDouble(), 10.0),
                    "el" to Json.num(s.getElevationDegrees(i).toDouble(), 10.0), "az" to Json.num(s.getAzimuthDegrees(i).toDouble(), 10.0),
                    "used" to if (u) "1" else "0", "eph" to if (s.hasEphemerisData(i)) "1" else "0", "alm" to if (s.hasAlmanacData(i)) "1" else "0",
                    "freq" to f?.let { Json.num(it, 1.0) }, "band" to f?.let { Gnss.band(it) }?.let { Json.str(it) },
                ))
            }
            emit("gnss", Json.obj("src" to "\"gnss\"", "kind" to "\"fix\"", "t" to t, "n" to s.satelliteCount.toString(), "used" to used.toString(),
                "cn0" to if (used > 0) Json.num(cn0 / used, 10.0) else null))
        }
    }

    private val rawCb = object : GnssMeasurementsEvent.Callback() {
        override fun onGnssMeasurementsReceived(e: GnssMeasurementsEvent) {
            val t = System.currentTimeMillis().toString()
            val c = e.clock
            emit("gnssraw", Json.obj(
                "src" to "\"gnssraw\"", "kind" to "\"clock\"", "t" to t, "tn" to c.timeNanos.toString(),
                "bias" to if (c.hasBiasNanos()) Json.num(c.biasNanos, 1e3) else null,
                "fullbias" to if (c.hasFullBiasNanos()) c.fullBiasNanos.toString() else null,
                "drift" to if (c.hasDriftNanosPerSecond()) Json.num(c.driftNanosPerSecond, 1e6) else null,
                "hw" to c.hardwareClockDiscontinuityCount.toString(),
            ))
            for (m in e.measurements) {
                val f = if (Build.VERSION.SDK_INT >= 26 && m.hasCarrierFrequencyHz()) m.carrierFrequencyHz.toDouble() else null
                emit("gnssraw", Json.obj(
                    "src" to "\"gnssraw\"", "kind" to "\"meas\"", "t" to t,
                    "con" to Json.str(Gnss.constellation(m.constellationType)), "svid" to m.svid.toString(),
                    "cn0" to Json.num(m.cn0DbHz, 10.0),
                    "prr" to Json.num(m.pseudorangeRateMetersPerSecond, 1e4), "prrunc" to Json.num(m.pseudorangeRateUncertaintyMetersPerSecond, 1e4),
                    "adr" to Json.num(m.accumulatedDeltaRangeMeters, 1e4), "adrstate" to m.accumulatedDeltaRangeState.toString(),
                    "tx" to m.receivedSvTimeNanos.toString(), "txunc" to m.receivedSvTimeUncertaintyNanos.toString(),
                    "state" to m.state.toString(), "off" to Json.num(m.timeOffsetNanos, 1e3), "mp" to m.multipathIndicator.toString(),
                    "freq" to f?.let { Json.num(it, 1.0) }, "band" to f?.let { Gnss.band(it) }?.let { Json.str(it) },
                ))
            }
        }
    }

    private val nmeaCb = android.location.OnNmeaMessageListener { msg, _ ->
        emit("nmea", Json.obj("src" to "\"nmea\"", "t" to System.currentTimeMillis().toString(), "line" to Json.str(msg.trim())))
    }

    /** false — нет разрешения на геолокацию. */
    @Synchronized
    fun update(wStatus: Boolean, wRaw: Boolean, wNmea: Boolean): Boolean {
        try {
            if (wStatus != status) { if (wStatus) { if (!ctx.hasLocation()) return false; lm.registerGnssStatusCallback(statusCb, handler) } else lm.unregisterGnssStatusCallback(statusCb); status = wStatus }
            if (wRaw != raw) { if (wRaw) { if (!ctx.hasLocation()) return false; lm.registerGnssMeasurementsCallback(rawCb, handler) } else lm.unregisterGnssMeasurementsCallback(rawCb); raw = wRaw }
            if (wNmea != nmea) { if (wNmea) { if (!ctx.hasLocation()) return false; lm.addNmeaListener(nmeaCb, handler) } else lm.removeNmeaListener(nmeaCb); nmea = wNmea }
        } catch (e: SecurityException) { return false }
        return true
    }

    fun close() { update(false, false, false); thread.quitSafely() }
}
