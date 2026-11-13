package app.dsp.phone

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothHidDevice
import android.bluetooth.BluetoothHidDeviceAppQosSettings
import android.bluetooth.BluetoothHidDeviceAppSdpSettings
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/** Отчёт стандартной boot-клавиатуры USB HID (8 байт: модификаторы, резерв, 6 кодов клавиш). Из приложения DSP идёт как есть. */
private val KEYBOARD_DESCRIPTOR = byteArrayOf(
    0x05, 0x01, 0x09, 0x06, 0xA1.toByte(), 0x01, 0x05, 0x07, 0x19, 0xE0.toByte(), 0x29, 0xE7.toByte(),
    0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95.toByte(), 0x08, 0x81.toByte(), 0x02, 0x95.toByte(), 0x01,
    0x75, 0x08, 0x81.toByte(), 0x01, 0x95.toByte(), 0x05, 0x75, 0x01, 0x05, 0x08, 0x19, 0x01, 0x29, 0x05,
    0x91.toByte(), 0x02, 0x95.toByte(), 0x01, 0x75, 0x03, 0x91.toByte(), 0x01, 0x95.toByte(), 0x06,
    0x75, 0x08, 0x15, 0x00, 0x25, 0x65, 0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x81.toByte(), 0x00, 0xC0.toByte()
)

/** Отчёт стандартной boot-мыши USB HID (3 байта: биты кнопок, dX, dY). */
private val MOUSE_DESCRIPTOR = byteArrayOf(
    0x05, 0x01, 0x09, 0x02, 0xA1.toByte(), 0x01, 0x09, 0x01, 0xA1.toByte(), 0x00, 0x05, 0x09, 0x19, 0x01,
    0x29, 0x03, 0x15, 0x00, 0x25, 0x01, 0x95.toByte(), 0x03, 0x75, 0x01, 0x81.toByte(), 0x02, 0x95.toByte(),
    0x01, 0x75, 0x05, 0x81.toByte(), 0x01, 0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x09, 0x38, 0x15, 0x81.toByte(),
    0x25, 0x7F, 0x75, 0x08, 0x95.toByte(), 0x03, 0x81.toByte(), 0x06, 0xC0.toByte(), 0xC0.toByte()
)

/**
 * HID-периферия (телефон как клавиатура / мышь / своё HID-устройство над классическим Bluetooth, API 28+).
 * Публичный API `BluetoothHidDevice`: регистрация приложения с SDP-записью и дескриптором отчётов, подключение
 * к хосту (ПК/приставка), отправка input-отчётов, обработка get/set-report и set-protocol от хоста.
 * Записи: {src:'hid', ev:'registered'|'unregistered'|'app'|'connected'|'disconnected'|'get'|'set'|'protocol'|'data', addr, hex}.
 */
@SuppressLint("MissingPermission")
class HidHub(private val ctx: Context, private val emit: Emit, private val needs: Needs) {
    private val thread = HandlerThread("dsp-hid").also { it.start() }
    private val h = Handler(thread.looper)
    private var proxy: BluetoothHidDevice? = null
    private var listener: BluetoothProfile.ServiceListener? = null
    private var pendingReg: Pair<BridgeServer.Client?, Any?>? = null
    @Volatile private var registered = false
    private val targets = ConcurrentHashMap<String, BluetoothDevice>()   // addr → устройство, которому разрешено подключаться/слать отчёты

    private fun rec(ev: String, addr: String?, vararg kv: Pair<String, String?>) =
        emit("hid", Json.obj("src" to "\"hid\"", "ev" to Json.str(ev), "t" to System.currentTimeMillis().toString(), "addr" to addr?.let { Json.str(it) }, *kv))

    private fun callback() = object : BluetoothHidDevice.Callback() {
        override fun onAppStatusChanged(dev: BluetoothDevice?, registeredNow: Boolean) {
            h.post {
                registered = registeredNow
                rec("app", dev?.address, "registered" to if (registeredNow) "1" else "0")
                pendingReg?.let { (c, id) -> if (c != null) Reply.done(c, id, "hid.register", if (registeredNow) null else "registration refused") }
                pendingReg = null
            }
        }
        override fun onConnectionStateChanged(dev: BluetoothDevice, state: Int) {
            h.post {
                when (state) {
                    BluetoothProfile.STATE_CONNECTED -> { targets[dev.address] = dev; rec("connected", dev.address) }
                    BluetoothProfile.STATE_DISCONNECTED -> rec("disconnected", dev.address)
                }
            }
        }
        override fun onGetReport(dev: BluetoothDevice, type: Byte, id: Byte, bufferSize: Int) {
            h.post {
                rec("get", dev.address, "type" to type.toString(), "id" to id.toString(), "n" to bufferSize.toString())
                // нет сохранённого значения — пустой отчёт успеха, иначе хост ждёт ответа бесконечно
                proxy?.replyReport(dev, type, id, ByteArray(0))
            }
        }
        override fun onSetReport(dev: BluetoothDevice, type: Byte, id: Byte, data: ByteArray) {
            h.post {
                rec("set", dev.address, "type" to type.toString(), "id" to id.toString(), "hex" to Json.str(Hex.of(data)))
                proxy?.reportError(dev, BluetoothHidDevice.ERROR_RSP_SUCCESS)
            }
        }
        override fun onSetProtocol(dev: BluetoothDevice, protocol: Byte) { h.post { rec("protocol", dev.address, "mode" to (if (protocol.toInt() == 0) "boot" else "report")) } }
        override fun onInterruptData(dev: BluetoothDevice, reportId: Byte, data: ByteArray) {
            h.post { rec("data", dev.address, "id" to reportId.toString(), "hex" to Json.str(Hex.of(data))) }
        }
        override fun onVirtualCableUnplug(dev: BluetoothDevice) {
            h.post { targets.remove(dev.address); rec("unplug", dev.address) }
        }
    }

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        val perms = if (Build.VERSION.SDK_INT >= 31) listOf(android.Manifest.permission.BLUETOOTH_CONNECT) else emptyList()
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
            "hid.register" -> {
                if (Build.VERSION.SDK_INT < 28) return Reply.done(c, id, cmd, "needs Android 9 (API 28)+")
                if (registered) return Reply.done(c, id, cmd, null, extra = arrayOf("again" to "true"))
                val type = j.optString("type", "keyboard")
                val descriptor = when (type) {
                    "keyboard" -> KEYBOARD_DESCRIPTOR
                    "mouse" -> MOUSE_DESCRIPTOR
                    "custom" -> Args.hex(j.optString("descriptor"), 4096) ?: return Reply.done(c, id, cmd, "descriptor: hex HID report descriptor, up to 4096 bytes")
                    else -> return Reply.done(c, id, cmd, "type: keyboard | mouse | custom")
                }
                val subclass = when (type) { "keyboard" -> 0x40; "mouse" -> 0x80; else -> j.optInt("subclass", 0x00) }
                val sdp = BluetoothHidDeviceAppSdpSettings(j.optString("name", "DSP $type").take(63), "DSP workbench HID", "DSP", subclass.toByte(), descriptor)
                val qos = BluetoothHidDeviceAppQosSettings(BluetoothHidDeviceAppQosSettings.SERVICE_BEST_EFFORT, 800, 9, 0, 11250, -1)
                pendingReg = c to id
                val ok = ad.getProfileProxy(ctx, object : BluetoothProfile.ServiceListener {
                    override fun onServiceConnected(p: Int, px: BluetoothProfile) {
                        proxy = px as BluetoothHidDevice
                        val ok = if (Build.VERSION.SDK_INT >= 30) {
                            val exec = java.util.concurrent.Executor { r -> h.post(r) }
                            proxy!!.registerApp(sdp, null, qos, exec, callback())
                        } else @Suppress("DEPRECATION") proxy!!.registerApp(sdp, null, qos, callback())
                        if (!ok) { pendingReg = null; Reply.done(c, id, cmd, "registerApp refused") }
                    }
                    override fun onServiceDisconnected(p: Int) { registered = false; proxy = null }
                }.also { listener = it }, BluetoothProfile.HID_DEVICE)
                if (!ok) { pendingReg = null; Reply.done(c, id, cmd, "getProfileProxy refused") }
                // ответ придёт из onAppStatusChanged — не пришёл за 10 с — отказ
                h.postDelayed({ if (pendingReg?.first === c && !registered) { pendingReg = null; Reply.done(c, id, cmd, "timeout", "timeout") } }, 10_000)
            }
            "hid.unregister" -> {
                val p = proxy ?: return Reply.done(c, id, cmd, null)
                p.unregisterApp(); registered = false; targets.clear()
                Reply.done(c, id, cmd, null)
            }
            "hid.connect" -> {
                val p = proxy ?: return Reply.done(c, id, cmd, "no HID app registered — hid.register first")
                val addr = Args.mac(j.optString("addr")) ?: return Reply.done(c, id, cmd, "bad address")
                val dev = ad.getRemoteDevice(addr)
                Reply.done(c, id, cmd, if (p.connect(dev)) null else "refused")
            }
            "hid.disconnect" -> {
                val p = proxy ?: return Reply.done(c, id, cmd, null)
                val dev = targets[Args.mac(j.optString("addr"))] ?: return Reply.done(c, id, cmd, "not connected")
                Reply.done(c, id, cmd, if (p.disconnect(dev)) null else "refused")
            }
            "hid.report" -> {
                val p = proxy ?: return Reply.done(c, id, cmd, "no HID app registered — hid.register first")
                val addr = Args.mac(j.optString("addr"))
                val data = Args.payload(j, 64) ?: return Reply.done(c, id, cmd, "hex or text: up to 64 bytes")
                val devs = if (addr != null) listOfNotNull(targets[addr]) else targets.values.toList()
                if (devs.isEmpty()) return Reply.done(c, id, cmd, "not connected to any host")
                val repId = j.optInt("id", 0).toByte()
                val okAll = devs.all { p.sendReport(it, repId.toInt(), data) }
                Reply.done(c, id, cmd, if (okAll) null else "sendReport refused")
            }
            "hid.list" -> Reply.done(c, id, cmd, null, extra = arrayOf("registered" to if (registered) "true" else "false", "devices" to Json.arr(targets.keys.toList())))
            else -> Reply.done(c, id, cmd, "unknown command", "unknown")
        }
    }

    fun held(): Int = (if (registered) 1 else 0) + targets.size

    fun release() {
        h.post {
            try { proxy?.unregisterApp() } catch (e: Exception) {}
            registered = false; targets.clear()
        }
    }

    fun close() {
        h.post {
            try { proxy?.unregisterApp() } catch (e: Exception) {}
            listener?.let { l -> try { (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter?.closeProfileProxy(BluetoothProfile.HID_DEVICE, proxy) } catch (e: Exception) {} }
            proxy = null; targets.clear()
        }
        thread.quitSafely()
    }
}
