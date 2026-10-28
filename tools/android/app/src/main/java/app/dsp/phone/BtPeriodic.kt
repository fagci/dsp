package app.dsp.phone

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.le.PeriodicAdvertisingCallback
import android.bluetooth.le.PeriodicAdvertisingReport
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Приём периодической рекламы BLE (синхронизация с передатчиком, Android 8+): ble.sync.start {addr, skip, timeout} цепляется к
 * устройству, чью расширенную рекламу с периодическим интервалом скан уже видел (источник ble с legacy:false, в записи есть pint), и
 * отдаёт каждый пакет. Записи источника blesync: {src:'blesync', ev:'established'|'data'|'lost', addr, sid, hex, rssi, txp}.
 */
@SuppressLint("MissingPermission")
class PeriodicSyncHub(private val ctx: Context, private val emit: Emit, private val needs: Needs, private val ble: BleHub) {
    private val thread = HandlerThread("dsp-psync").also { it.start() }
    private val h = Handler(thread.looper)
    private val syncs = ConcurrentHashMap<String, PeriodicAdvertisingCallback>()
    private val byHandle = ConcurrentHashMap<Int, String>()

    private fun rec(ev: String, addr: String?, vararg kv: Pair<String, String?>) =
        emit("blesync", Json.obj("src" to "\"blesync\"", "ev" to Json.str(ev), "t" to System.currentTimeMillis().toString(), "addr" to addr?.let { Json.str(it) }, *kv))

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        val perms = if (Build.VERSION.SDK_INT >= 31) listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT) else emptyList()
        if (!needs.need(c, id, cmd, perms)) return
        h.post {
            try { run(c, id, cmd, j) } catch (e: SecurityException) { Reply.done(c, id, cmd, "permission: ${e.message}", "permission") }
            catch (e: Exception) { Reply.done(c, id, cmd, e.message ?: e.javaClass.simpleName) }
        }
    }

    private fun run(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        val ad = (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter?.takeIf { it.isEnabled }
            ?: return Reply.done(c, id, cmd, "Bluetooth is off")
        when (cmd) {
            "ble.sync.list" -> Reply.done(c, id, cmd, null, extra = arrayOf("devices" to Json.arr(syncs.keys.toList())))
            "ble.sync.stop" -> {
                val a = Args.mac(j.optString("addr"))
                val pam = ad.periodicAdvertisingManager
                for ((k, cb) in syncs.entries.toList()) if (a == null || a == k) { try { pam?.unregisterSync(cb) } catch (e: Exception) {}; syncs.remove(k) }
                Reply.done(c, id, cmd, null)
            }
            "ble.sync.start" -> {
                if (!ad.isLePeriodicAdvertisingSupported) return Reply.done(c, id, cmd, "this phone has no periodic advertising")
                val addr = Args.mac(j.optString("addr")) ?: return Reply.done(c, id, cmd, "addr: AA:BB:CC:DD:EE:FF")
                if (syncs.size >= 4 && !syncs.containsKey(addr)) return Reply.done(c, id, cmd, "4 syncs at most")
                val sr = ble.periodicOf(addr) ?: return Reply.done(c, id, cmd, "no periodic advertisement seen from $addr — scan with ble {legacy:false} first and wait for a record with pint")
                val pam = ad.periodicAdvertisingManager ?: return Reply.done(c, id, cmd, "no periodic advertising manager")
                syncs.remove(addr)?.let { try { pam.unregisterSync(it) } catch (e: Exception) {} }
                var answered = false
                val cb = object : PeriodicAdvertisingCallback() {
                    override fun onSyncEstablished(handle: Int, d: BluetoothDevice, sid: Int, skip: Int, timeout: Int, status: Int) {
                        h.post {
                            if (status == 0) { byHandle[handle] = d.address; rec("established", d.address, "sid" to sid.toString(), "handle" to handle.toString()) }
                            else syncs.remove(d.address)
                            if (!answered) { answered = true; Reply.done(c, id, cmd, if (status == 0) null else "sync failed (status $status)", "error", "addr" to Json.str(d.address), "sid" to sid.toString()) }
                        }
                    }
                    override fun onPeriodicAdvertisingReport(r: PeriodicAdvertisingReport) {
                        val b = r.data?.bytes ?: ByteArray(0)
                        h.post { rec("data", byHandle[r.syncHandle], "hex" to Json.str(Hex.of(b)), "n" to b.size.toString(), "rssi" to r.rssi.toString(), "txp" to r.txPower.toString(), "text" to Json.str(String(b, Charsets.UTF_8))) }
                    }
                    override fun onSyncLost(handle: Int) { h.post { val a = byHandle.remove(handle); if (a != null) syncs.remove(a); rec("lost", a) } }
                }
                syncs[addr] = cb
                pam.registerSync(sr, Args.syncSkip(j.optInt("skip", 0)), Args.syncTimeout(j.optInt("timeout", 10_000)), cb, h)
                h.postDelayed({ if (!answered) { answered = true; syncs.remove(addr)?.let { try { pam.unregisterSync(it) } catch (e: Exception) {} }; Reply.done(c, id, cmd, "no sync within 15 s — the device may have stopped, or is out of range", "timeout") } }, 15_000)
            }
            else -> Reply.done(c, id, cmd, "unknown command", "unknown")
        }
    }

    fun held(): Int = syncs.size

    fun release() {
        h.post {
            val pam = (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter?.periodicAdvertisingManager
            for (cb in syncs.values) try { pam?.unregisterSync(cb) } catch (e: Exception) {}
            syncs.clear(); byHandle.clear()
        }
    }

    fun close() { release(); thread.quitSafely() }
}
