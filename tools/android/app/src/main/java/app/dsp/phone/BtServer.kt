package app.dsp.phone

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Описание GATT-сервера из команды gattsrv.start (чистая логика — проверяется на JVM). */
object GattSpec {
    class Chr(val uuid: UUID, val props: Int, val perms: Int, val value: ByteArray, val auto: Boolean)
    class Svc(val uuid: UUID, val chars: List<Chr>)
    class Parsed(val svcs: List<Svc>, val err: String?)

    val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    const val MAX_SVC = 8
    const val MAX_CHR = 16
    const val MAX_VALUE = 512

    private val PROP = mapOf(
        "read" to BluetoothGattCharacteristic.PROPERTY_READ, "write" to BluetoothGattCharacteristic.PROPERTY_WRITE,
        "writenr" to BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE, "notify" to BluetoothGattCharacteristic.PROPERTY_NOTIFY,
        "indicate" to BluetoothGattCharacteristic.PROPERTY_INDICATE)

    /**
     * services: [{uuid, chars:[{uuid, props:["read","write","writenr","notify","indicate"], hex|text, auto, secure}]}].
     * auto:false — запросы чтения / записи уходят странице записью с полем req, ответ даёт gattsrv.respond.
     */
    fun parse(a: JSONArray?): Parsed {
        if (a == null || a.length() == 0) return Parsed(emptyList(), "services: [{uuid, chars:[{uuid, props:[read|write|writenr|notify|indicate]}]}]")
        if (a.length() > MAX_SVC) return Parsed(emptyList(), "$MAX_SVC services at most")
        val out = ArrayList<Svc>()
        for (i in 0 until a.length()) {
            val s = a.optJSONObject(i) ?: return Parsed(emptyList(), "services[$i]: object")
            val su = Args.uuid(s.optString("uuid")) ?: return Parsed(emptyList(), "services[$i].uuid: 16-bit (180d) or 128-bit UUID")
            val ca = s.optJSONArray("chars") ?: JSONArray()
            if (ca.length() > MAX_CHR) return Parsed(emptyList(), "$MAX_CHR characteristics at most per service")
            val cs = ArrayList<Chr>()
            for (k in 0 until ca.length()) {
                val c = ca.optJSONObject(k) ?: return Parsed(emptyList(), "services[$i].chars[$k]: object")
                val cu = Args.uuid(c.optString("uuid")) ?: return Parsed(emptyList(), "services[$i].chars[$k].uuid: UUID")
                var props = 0
                val pa = c.optJSONArray("props")
                if (pa != null) for (q in 0 until pa.length()) props = props or (PROP[pa.optString(q)] ?: return Parsed(emptyList(), "props: read, write, writenr, notify, indicate"))
                else props = BluetoothGattCharacteristic.PROPERTY_READ
                if (props == 0) return Parsed(emptyList(), "services[$i].chars[$k].props is empty")
                val sec = c.optBoolean("secure", false)
                var perms = 0
                if (props and BluetoothGattCharacteristic.PROPERTY_READ != 0)
                    perms = perms or (if (sec) BluetoothGattCharacteristic.PERMISSION_READ_ENCRYPTED else BluetoothGattCharacteristic.PERMISSION_READ)
                if (props and (BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0)
                    perms = perms or (if (sec) BluetoothGattCharacteristic.PERMISSION_WRITE_ENCRYPTED else BluetoothGattCharacteristic.PERMISSION_WRITE)
                val v = if (c.has("hex") || c.has("text")) Args.payload(c, MAX_VALUE) ?: return Parsed(emptyList(), "services[$i].chars[$k]: hex / text up to $MAX_VALUE bytes") else ByteArray(0)
                cs.add(Chr(cu, props, perms, v, c.optBoolean("auto", true)))
            }
            out.add(Svc(su, cs))
        }
        return Parsed(out, null)
    }

    /** Значение для ответа на чтение со смещением; null — смещение за концом (ATT: invalid offset). */
    fun slice(v: ByteArray, offset: Int): ByteArray? = if (offset < 0 || offset > v.size) null else if (offset == 0) v else v.copyOfRange(offset, v.size)

    /** Запись со смещением (prepared write): data ложится на old с позиции offset, дыра добивается нулями. */
    fun merge(old: ByteArray, offset: Int, data: ByteArray): ByteArray {
        val r = old.copyOf(maxOf(old.size, offset + data.size))
        System.arraycopy(data, 0, r, offset, data.size)
        return r
    }

    /** CCCD: 1 — notify, 2 — indicate, 0 — выкл. */
    fun cccdMode(v: ByteArray?): Int = if (v == null || v.isEmpty()) 0 else (v[0].toInt() and 3)

    fun cccdBytes(mode: Int): ByteArray = byteArrayOf((mode and 3).toByte(), 0)

    fun key(svc: UUID, chr: UUID) = Args.uuidShort(svc) + "/" + Args.uuidShort(chr)
}

/**
 * GATT-сервер: телефон как периферия со своими службами. Центральное устройство читает / пишет характеристики и подписывается
 * на notify / indicate. Рекламу со своими UUID и connectable:true запускает ble.adv.start.
 * Записи: {src:'gattsrv', ev:'connected'|'disconnected'|'read'|'write'|'sub'|'unsub'|'mtu'|'sent', addr, svc, chr, hex, req}.
 */
@SuppressLint("MissingPermission")
class GattServerHub(private val ctx: Context, private val emit: Emit, private val needs: Needs) {
    private val thread = HandlerThread("dsp-gattsrv").also { it.start() }
    private val h = Handler(thread.looper)

    private class Pending(val dev: BluetoothDevice, val requestId: Int, val offset: Int, val read: Boolean, val key: String, val data: ByteArray?)
    private class Notif(val dev: BluetoothDevice, val ch: BluetoothGattCharacteristic, val v: ByteArray, val confirm: Boolean)

    private var srv: BluetoothGattServer? = null
    private val devs = HashMap<String, BluetoothDevice>()
    private val subs = HashMap<String, Int>()                                  // «адрес|svc/chr» → режим CCCD
    private val values = HashMap<String, ByteArray>()                          // «svc/chr» → значение
    private val autos = HashMap<String, Boolean>()
    private val chars = HashMap<String, BluetoothGattCharacteristic>()
    private val pend = HashMap<Int, Pending>()
    private val prep = HashMap<String, ByteArray>()                            // «адрес|svc/chr» → накопленная запись по частям
    private val nq = ArrayDeque<Notif>()
    private var nbusy = false
    private var nextReq = 1
    private val toAdd = ArrayDeque<BluetoothGattService>()
    private var startC: BridgeServer.Client? = null
    private var startId: Any? = null
    private var startN = 0
    private var startTimer: Runnable? = null

    private fun perms() = if (Build.VERSION.SDK_INT >= 31) listOf(Manifest.permission.BLUETOOTH_CONNECT) else emptyList()

    private fun rec(ev: String, addr: String?, vararg kv: Pair<String, String?>) =
        emit("gattsrv", Json.obj("src" to "\"gattsrv\"", "ev" to Json.str(ev), "t" to System.currentTimeMillis().toString(), "addr" to addr?.let { Json.str(it) }, *kv))

    private fun chrKv(key: String): Array<Pair<String, String?>> {
        val i = key.indexOf('/')
        return arrayOf("svc" to Json.str(key.substring(0, i)), "chr" to Json.str(key.substring(i + 1)))
    }

    private fun keyOf(ch: BluetoothGattCharacteristic) = GattSpec.key(ch.service.uuid, ch.uuid)

    // ---------- обратные вызовы (Binder-потоки → h) ----------

    private val cb = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(d: BluetoothDevice, status: Int, state: Int) { h.post { conn(d, status, state) } }
        override fun onServiceAdded(status: Int, s: BluetoothGattService) { h.post { added(status) } }
        override fun onCharacteristicReadRequest(d: BluetoothDevice, req: Int, off: Int, ch: BluetoothGattCharacteristic) { h.post { readReq(d, req, off, ch) } }
        override fun onCharacteristicWriteRequest(d: BluetoothDevice, req: Int, ch: BluetoothGattCharacteristic, prepared: Boolean, resp: Boolean, off: Int, v: ByteArray?) {
            h.post { writeReq(d, req, ch, prepared, resp, off, v ?: ByteArray(0)) }
        }
        override fun onDescriptorReadRequest(d: BluetoothDevice, req: Int, off: Int, ds: BluetoothGattDescriptor) {
            h.post {
                val k = keyOf(ds.characteristic)
                val v = if (ds.uuid == GattSpec.CCCD) GattSpec.cccdBytes(subs[d.address + "|" + k] ?: 0) else ByteArray(0)
                reply(d, req, 0, off, GattSpec.slice(v, off), BluetoothGatt.GATT_INVALID_OFFSET)
            }
        }
        override fun onDescriptorWriteRequest(d: BluetoothDevice, req: Int, ds: BluetoothGattDescriptor, prepared: Boolean, resp: Boolean, off: Int, v: ByteArray?) {
            h.post {
                if (ds.uuid != GattSpec.CCCD) { if (resp) reply(d, req, BluetoothGatt.GATT_WRITE_NOT_PERMITTED, off, null); return@post }
                val k = keyOf(ds.characteristic)
                val allowed = (if (ds.characteristic.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) 1 else 0) or
                    (if (ds.characteristic.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) 2 else 0)
                val mode = GattSpec.cccdMode(v) and allowed
                subs[d.address + "|" + k] = mode
                rec(if (mode != 0) "sub" else "unsub", d.address, *chrKv(k), "mode" to Json.str(if (mode == 2) "indicate" else "notify"))
                if (resp) reply(d, req, 0, off, v)
            }
        }
        override fun onExecuteWrite(d: BluetoothDevice, req: Int, execute: Boolean) { h.post { exec(d, req, execute) } }
        override fun onNotificationSent(d: BluetoothDevice, status: Int) { h.post { nbusy = false; rec("sent", d.address, "status" to status.toString()); pumpN() } }
        override fun onMtuChanged(d: BluetoothDevice, mtu: Int) { h.post { rec("mtu", d.address, "mtu" to mtu.toString()) } }
    }

    private fun reply(d: BluetoothDevice, req: Int, status: Int, off: Int, v: ByteArray?, badOffset: Int = status) {
        val s = if (v == null && status == 0) badOffset else status
        try { srv?.sendResponse(d, req, s, off, v) } catch (e: Exception) {}
    }

    private fun conn(d: BluetoothDevice, status: Int, state: Int) {
        if (state == BluetoothProfile.STATE_CONNECTED) { devs[d.address] = d; rec("connected", d.address, "status" to status.toString()) }
        else {
            devs.remove(d.address)
            subs.keys.removeAll { it.startsWith(d.address + "|") }; prep.keys.removeAll { it.startsWith(d.address + "|") }
            pend.values.removeAll { it.dev.address == d.address }; nq.removeAll { it.dev.address == d.address }
            rec("disconnected", d.address, "status" to status.toString())
        }
    }

    private fun readReq(d: BluetoothDevice, req: Int, off: Int, ch: BluetoothGattCharacteristic) {
        val k = keyOf(ch)
        if (autos[k] != false) {
            val v = values[k] ?: ByteArray(0)
            rec("read", d.address, *chrKv(k), "hex" to Json.str(Hex.of(v)), "n" to v.size.toString())
            reply(d, req, 0, off, GattSpec.slice(v, off), BluetoothGatt.GATT_INVALID_OFFSET)
            return
        }
        val id = hold(Pending(d, req, off, true, k, null))
        rec("read", d.address, *chrKv(k), "req" to id.toString())
    }

    private fun writeReq(d: BluetoothDevice, req: Int, ch: BluetoothGattCharacteristic, prepared: Boolean, resp: Boolean, off: Int, v: ByteArray) {
        val k = keyOf(ch); val pk = d.address + "|" + k
        if (prepared) {
            prep[pk] = GattSpec.merge(prep[pk] ?: ByteArray(0), off, v)
            if (resp) reply(d, req, 0, off, v)
            return
        }
        val data = if (off > 0) GattSpec.merge(values[k] ?: ByteArray(0), off, v) else v
        if (resp && autos[k] == false) {
            val id = hold(Pending(d, req, off, false, k, v))
            rec("write", d.address, *chrKv(k), "hex" to Json.str(Hex.of(data)), "n" to data.size.toString(), "req" to id.toString())
            return
        }
        committed(d, k, data)
        if (resp) reply(d, req, 0, off, v)
    }

    private fun committed(d: BluetoothDevice, k: String, data: ByteArray) {
        values[k] = data
        rec("write", d.address, *chrKv(k), "hex" to Json.str(Hex.of(data)), "n" to data.size.toString())
    }

    private fun exec(d: BluetoothDevice, req: Int, execute: Boolean) {
        val mine = prep.keys.filter { it.startsWith(d.address + "|") }
        for (pk in mine) { val v = prep.remove(pk) ?: continue; if (execute) committed(d, pk.substringAfter('|'), v) }
        reply(d, req, 0, 0, null)
    }

    /** Запрос, на который ответит страница (auto:false): 5 с — иначе отказ. */
    private fun hold(p: Pending): Int {
        val id = nextReq++
        pend[id] = p
        h.postDelayed({ pend.remove(id)?.let { reply(it.dev, it.requestId, BluetoothGatt.GATT_FAILURE, it.offset, null) } }, 5_000)
        return id
    }

    // ---------- notify / indicate ----------

    @Suppress("DEPRECATION")
    private fun send(g: BluetoothGattServer, n: Notif): Boolean =
        if (Build.VERSION.SDK_INT >= 33) g.notifyCharacteristicChanged(n.dev, n.ch, n.confirm, n.v) == 0
        else { n.ch.value = n.v; g.notifyCharacteristicChanged(n.dev, n.ch, n.confirm) }

    private fun pumpN() {
        if (nbusy) return
        val n = nq.removeFirstOrNull() ?: return
        val g = srv ?: return
        val ok = try { send(g, n) } catch (e: Exception) { false }
        if (!ok) { rec("sent", n.dev.address, "status" to "-1"); pumpN(); return }
        nbusy = true
        h.postDelayed({ if (nbusy) { nbusy = false; pumpN() } }, 1_500)
    }

    // ---------- старт: службы добавляются по одной ----------

    private fun added(status: Int) {
        if (status != 0) return startDone("service refused (status $status)")
        val s = toAdd.removeFirstOrNull() ?: return startDone(null)
        if (srv?.addService(s) != true) startDone("addService refused")
    }

    private fun startDone(err: String?) {
        startTimer?.let { h.removeCallbacks(it) }; startTimer = null
        val c = startC; startC = null
        if (err != null) stop()
        if (c != null) Reply.done(c, startId, "gattsrv.start", err, "error", "services" to startN.toString())
    }

    private fun start(c: BridgeServer.Client, id: Any?, j: JSONObject) {
        val ad = (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)
        if (ad?.adapter?.isEnabled != true) return Reply.done(c, id, "gattsrv.start", "Bluetooth is off")
        val p = GattSpec.parse(j.optJSONArray("services"))
        if (p.err != null) return Reply.done(c, id, "gattsrv.start", p.err)
        stop()
        val s = ad.openGattServer(ctx, cb) ?: return Reply.done(c, id, "gattsrv.start", "this phone cannot open a GATT server")
        srv = s
        for (sv in p.svcs) {
            val gs = BluetoothGattService(sv.uuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
            for (ch in sv.chars) {
                val bc = BluetoothGattCharacteristic(ch.uuid, ch.props, ch.perms)
                if (ch.props and (BluetoothGattCharacteristic.PROPERTY_NOTIFY or BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0)
                    bc.addDescriptor(BluetoothGattDescriptor(GattSpec.CCCD, BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE))
                gs.addCharacteristic(bc)
                val k = GattSpec.key(sv.uuid, ch.uuid)
                values[k] = ch.value; autos[k] = ch.auto; chars[k] = bc
            }
            toAdd.addLast(gs)
        }
        startC = c; startId = id; startN = toAdd.size
        val t = Runnable { startDone("timeout") }
        startTimer = t; h.postDelayed(t, 10_000)
        added(0)
    }

    private fun stop() {
        startTimer?.let { h.removeCallbacks(it) }; startTimer = null
        try { srv?.close() } catch (e: Exception) {}
        srv = null; toAdd.clear(); devs.clear(); subs.clear(); values.clear(); autos.clear(); chars.clear(); pend.clear(); prep.clear(); nq.clear(); nbusy = false
    }

    // ---------- команды ----------

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        if (!needs.need(c, id, cmd, perms())) return
        h.post {
            try { run(c, id, cmd, j) } catch (e: SecurityException) { Reply.done(c, id, cmd, "permission: ${e.message}", "permission") }
            catch (e: Exception) { Reply.done(c, id, cmd, e.message ?: e.javaClass.simpleName) }
        }
    }

    private fun target(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject): String? {
        if (srv == null) { Reply.done(c, id, cmd, "the GATT server is not running — gattsrv.start first"); return null }
        val s = Args.uuid(j.optString("svc")); val ch = Args.uuid(j.optString("chr"))
        if (s == null || ch == null) { Reply.done(c, id, cmd, "svc and chr: 16-bit (180d) or 128-bit UUID"); return null }
        val k = GattSpec.key(s, ch)
        if (k !in chars) { Reply.done(c, id, cmd, "no such characteristic in the running server"); return null }
        return k
    }

    private fun run(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        when (cmd) {
            "gattsrv.start" -> start(c, id, j)
            "gattsrv.stop" -> { stop(); Reply.done(c, id, cmd, null) }
            "gattsrv.list" -> Reply.done(c, id, cmd, null, extra = arrayOf(
                "running" to (srv != null).toString(), "devices" to Json.arr(devs.keys.toList()), "chars" to Json.arr(chars.keys.toList()),
                "subs" to Json.arr(subs.filter { it.value != 0 }.keys.toList())))
            "gattsrv.disconnect" -> {
                val a = Args.mac(j.optString("addr")) ?: return Reply.done(c, id, cmd, "addr: AA:BB:CC:DD:EE:FF")
                val d = devs[a] ?: return Reply.done(c, id, cmd, "$a is not connected")
                srv?.cancelConnection(d); Reply.done(c, id, cmd, null)
            }
            "gattsrv.set" -> {
                val k = target(c, id, cmd, j) ?: return
                val v = Args.payload(j, GattSpec.MAX_VALUE) ?: return Reply.done(c, id, cmd, "hex or text, up to ${GattSpec.MAX_VALUE} bytes")
                values[k] = v; Reply.done(c, id, cmd, null)
            }
            "gattsrv.notify" -> {
                val k = target(c, id, cmd, j) ?: return
                val v = Args.payload(j, GattSpec.MAX_VALUE) ?: return Reply.done(c, id, cmd, "hex or text, up to ${GattSpec.MAX_VALUE} bytes")
                val only = j.optString("addr").takeIf { it.isNotEmpty() }?.let { Args.mac(it) ?: return Reply.done(c, id, cmd, "addr: AA:BB:CC:DD:EE:FF") }
                values[k] = v
                var n = 0
                for ((a, d) in devs) {
                    if (only != null && a != only) continue
                    val mode = subs["$a|$k"] ?: 0
                    if (mode == 0) continue
                    if (nq.size >= 256) nq.removeFirst()
                    nq.addLast(Notif(d, chars.getValue(k), v, mode == 2)); n++
                }
                pumpN()
                Reply.done(c, id, cmd, null, extra = arrayOf("n" to n.toString()))
            }
            "gattsrv.respond" -> {
                val req = j.optInt("req", -1)
                val p = pend.remove(req) ?: return Reply.done(c, id, cmd, "no pending request $req (answer within 5 s)")
                val status = j.optInt("status", 0)
                if (p.read) {
                    val v = if (status == 0) (Args.payload(j, GattSpec.MAX_VALUE) ?: return Reply.done(c, id, cmd, "hex or text").also { pend[req] = p }) else null
                    if (status == 0) values[p.key] = v!!
                    reply(p.dev, p.requestId, status, p.offset, if (status == 0) GattSpec.slice(v!!, p.offset) else null, BluetoothGatt.GATT_INVALID_OFFSET)
                } else {
                    if (status == 0) values[p.key] = GattSpec.merge(values[p.key] ?: ByteArray(0), p.offset, p.data ?: ByteArray(0))
                    reply(p.dev, p.requestId, status, p.offset, p.data)
                }
                Reply.done(c, id, cmd, null)
            }
            else -> Reply.done(c, id, cmd, "unknown command", "unknown")
        }
    }

    fun held(): Int = if (srv != null) 1 else 0

    fun release() { h.post { stop() } }

    fun close() { h.post { stop() }; thread.quitSafely() }
}
