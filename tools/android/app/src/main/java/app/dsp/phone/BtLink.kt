package app.dsp.phone

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.AdvertisingSet
import android.bluetooth.le.AdvertisingSetCallback
import android.bluetooth.le.AdvertisingSetParameters
import android.bluetooth.le.PeriodicAdvertisingParameters
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelUuid
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

private fun Context.adapter(): BluetoothAdapter? = (getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

/** Разрешение на подключения (Android 12+: BLUETOOTH_CONNECT; раньше хватает обычных). */
private fun btPerms(extra: String? = null): List<String> =
    (if (Build.VERSION.SDK_INT >= 31) listOf(Manifest.permission.BLUETOOTH_CONNECT) else emptyList()) + listOfNotNull(extra)

object GattProps {
    /** Биты свойств характеристики → имена. */
    fun names(p: Int): List<String> {
        val l = ArrayList<String>()
        if (p and BluetoothGattCharacteristic.PROPERTY_BROADCAST != 0) l.add("broadcast")
        if (p and BluetoothGattCharacteristic.PROPERTY_READ != 0) l.add("read")
        if (p and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0) l.add("writenr")
        if (p and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) l.add("write")
        if (p and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) l.add("notify")
        if (p and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) l.add("indicate")
        if (p and BluetoothGattCharacteristic.PROPERTY_SIGNED_WRITE != 0) l.add("signed")
        if (p and BluetoothGattCharacteristic.PROPERTY_EXTENDED_PROPS != 0) l.add("ext")
        return l
    }
}

/**
 * BLE-клиент (GATT): то, чего нет в Web Bluetooth — подключение к любому адресу без диалога, полный список служб и
 * характеристик, чтение / запись / подписка, MTU, PHY, приоритет соединения, несколько устройств сразу.
 * Операции каждого соединения идут по очереди (Android позволяет одну за раз), у каждой — таймаут.
 * Записи: {src:'gatt', ev:'connected'|'disconnected'|'services'|'char'|'read'|'write'|'notify'|'mtu'|'rssi', addr, svc, chr, hex, status}.
 */
@SuppressLint("MissingPermission")
class GattHub(private val ctx: Context, private val emit: Emit, private val needs: Needs) {
    private val thread = HandlerThread("dsp-gatt").also { it.start() }
    private val h = Handler(thread.looper)

    private class Op(val name: String, val c: BridgeServer.Client?, val id: Any?, val run: (BluetoothGatt) -> Boolean)

    private class Conn(val addr: String) {
        var gatt: BluetoothGatt? = null
        val q = ArrayDeque<Op>()
        var cur: Op? = null
        var tick: Runnable? = null
        var connC: BridgeServer.Client? = null
        var connId: Any? = null
        var connected = false
        var discover = true
        var autoRead = false
        var autoNotify = false
        var readMax = 0
    }

    private val conns = ConcurrentHashMap<String, Conn>()

    // ---------- записи ----------

    private fun rec(ev: String, addr: String, vararg kv: Pair<String, String?>) =
        emit("gatt", Json.obj("src" to "\"gatt\"", "ev" to Json.str(ev), "t" to System.currentTimeMillis().toString(), "addr" to Json.str(addr), *kv))

    private fun chrKv(ch: BluetoothGattCharacteristic) = arrayOf<Pair<String, String?>>(
        "svc" to Json.str(Args.uuidShort(ch.service.uuid)), "chr" to Json.str(Args.uuidShort(ch.uuid)))

    // ---------- очередь ----------

    private fun enqueue(cn: Conn, op: Op) { cn.q.addLast(op); pump(cn) }

    private fun pump(cn: Conn) {
        if (cn.cur != null) return
        val g = cn.gatt ?: return
        val op = cn.q.removeFirstOrNull() ?: return
        cn.cur = op
        val ok = try { op.run(g) } catch (e: SecurityException) { false } catch (e: Exception) { false }
        if (!ok) { finish(cn, op, "start failed", false); return }
        val t = Runnable { if (cn.cur === op) finish(cn, op, "timeout", false) }
        cn.tick = t; h.postDelayed(t, 12_000)
    }

    /** Операция закончилась (колбэк или таймаут): ответить тому, кто спросил, и взять следующую. */
    private fun finish(cn: Conn, op: Op, err: String?, ok: Boolean = err == null, vararg extra: Pair<String, String?>) {
        if (cn.cur !== op) return
        cn.tick?.let { h.removeCallbacks(it) }; cn.tick = null; cn.cur = null
        if (op.c != null) Reply.done(op.c, op.id, op.name, if (ok) null else (err ?: "failed"), if (err == "timeout") "timeout" else "error", *extra)
        pump(cn)
    }

    private fun find(g: BluetoothGatt, svc: UUID, chr: UUID, inst: Int = 0): BluetoothGattCharacteristic? =
        g.services.filter { it.uuid == svc }.getOrNull(inst)?.getCharacteristic(chr)

    // ---------- обратные вызовы ----------

    private fun callback(cn: Conn) = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, state: Int) { h.post { connState(cn, g, status, state) } }
        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) { h.post { services(cn, g, status) } }
        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            h.post { rec("mtu", cn.addr, "mtu" to mtu.toString(), "status" to status.toString()); cn.cur?.takeIf { it.name == "gatt.mtu" }?.let { finish(cn, it, if (status == 0) null else "status $status", extra = arrayOf("mtu" to mtu.toString())) } }
        }
        override fun onReadRemoteRssi(g: BluetoothGatt, rssi: Int, status: Int) {
            h.post { rec("rssi", cn.addr, "rssi" to rssi.toString()); cn.cur?.takeIf { it.name == "gatt.rssi" }?.let { finish(cn, it, if (status == 0) null else "status $status", extra = arrayOf("rssi" to rssi.toString())) } }
        }
        override fun onPhyUpdate(g: BluetoothGatt, tx: Int, rx: Int, status: Int) { h.post { rec("phy", cn.addr, "tx" to tx.toString(), "rx" to rx.toString()) } }

        override fun onCharacteristicRead(g: BluetoothGatt, ch: BluetoothGattCharacteristic, value: ByteArray, status: Int) { h.post { read(cn, ch, value, status) } }
        @Deprecated("API < 33")
        override fun onCharacteristicRead(g: BluetoothGatt, ch: BluetoothGattCharacteristic, status: Int) {
            if (Build.VERSION.SDK_INT < 33) { val v = ch.value ?: ByteArray(0); h.post { read(cn, ch, v, status) } }
        }
        override fun onCharacteristicWrite(g: BluetoothGatt, ch: BluetoothGattCharacteristic, status: Int) {
            h.post {
                rec("write", cn.addr, *chrKv(ch), "status" to status.toString())
                cn.cur?.takeIf { it.name == "gatt.write" }?.let { finish(cn, it, if (status == 0) null else "status $status") }
            }
        }
        override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic, value: ByteArray) { h.post { changed(cn, ch, value) } }
        @Deprecated("API < 33")
        override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT < 33) { val v = ch.value ?: ByteArray(0); h.post { changed(cn, ch, v) } }
        }
        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
            h.post {
                cn.cur?.takeIf { it.name == "gatt.notify" }?.let { finish(cn, it, if (status == 0) null else "status $status") }
            }
        }
    }

    private fun connState(cn: Conn, g: BluetoothGatt, status: Int, state: Int) {
        if (conns[cn.addr] !== cn) { try { g.close() } catch (e: Exception) {}; return }
        if (state == BluetoothProfile.STATE_CONNECTED) {
            cn.connected = true
            rec("connected", cn.addr, "status" to status.toString())
            cn.connC?.let { Reply.done(it, cn.connId, "gatt.connect", null, extra = arrayOf("addr" to Json.str(cn.addr))) }; cn.connC = null
            if (cn.discover) enqueue(cn, Op("gatt.discover", null, null) { it.discoverServices() })
        } else {
            val was = cn.connected
            cn.connected = false
            rec("disconnected", cn.addr, "status" to status.toString(), "was" to if (was) "1" else "0")
            cn.connC?.let { Reply.done(it, cn.connId, "gatt.connect", "connection failed (status $status)") }; cn.connC = null
            cn.cur?.let { finish(cn, it, "disconnected") }
            while (cn.q.isNotEmpty()) { val o = cn.q.removeFirst(); o.c?.let { c -> Reply.done(c, o.id, o.name, "disconnected") } }
            conns.remove(cn.addr)
            try { g.close() } catch (e: Exception) {}
        }
    }

    private fun services(cn: Conn, g: BluetoothGatt, status: Int) {
        if (status != 0) { cn.cur?.takeIf { it.name == "gatt.discover" }?.let { finish(cn, it, "status $status") }; return }
        var n = 0
        for (s in g.services) {
            for (ch in s.characteristics) {
                n++
                rec("char", cn.addr, *chrKv(ch), "props" to Json.arr(GattProps.names(ch.properties)), "pbits" to ch.properties.toString(),
                    "descs" to Json.arr(ch.descriptors.map { Args.uuidShort(it.uuid) }), "primary" to if (s.type == 0) "1" else "0")
            }
        }
        rec("services", cn.addr, "n" to g.services.size.toString(), "chars" to n.toString())
        cn.cur?.takeIf { it.name == "gatt.discover" }?.let { finish(cn, it, null, extra = arrayOf("n" to g.services.size.toString(), "chars" to n.toString())) }
        if (cn.autoRead || cn.autoNotify) dump(cn, g)
    }

    /** Автообход: прочитать все читаемые характеристики и подписаться на все с уведомлениями — по очереди, ошибки не прерывают обход. */
    private fun dump(cn: Conn, g: BluetoothGatt) {
        var reads = 0
        for (s in g.services) for (ch in s.characteristics) {
            val p = ch.properties
            if (cn.autoRead && p and BluetoothGattCharacteristic.PROPERTY_READ != 0 && (cn.readMax <= 0 || reads < cn.readMax)) { reads++; enqueue(cn, readOp(ch.service.uuid, ch.uuid, null, null)) }
            if (cn.autoNotify && p and (BluetoothGattCharacteristic.PROPERTY_NOTIFY or BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0) enqueue(cn, notifyOp(ch.service.uuid, ch.uuid, true, null, null))
        }
    }

    private fun read(cn: Conn, ch: BluetoothGattCharacteristic, v: ByteArray, status: Int) {
        rec("read", cn.addr, *chrKv(ch), "hex" to Json.str(Hex.of(v)), "n" to v.size.toString(), "status" to status.toString())
        cn.cur?.takeIf { it.name == "gatt.read" }?.let { finish(cn, it, if (status == 0) null else "status $status", extra = arrayOf("hex" to Json.str(Hex.of(v)), "svc" to Json.str(Args.uuidShort(ch.service.uuid)), "chr" to Json.str(Args.uuidShort(ch.uuid)))) }
    }

    private fun changed(cn: Conn, ch: BluetoothGattCharacteristic, v: ByteArray) =
        rec("notify", cn.addr, *chrKv(ch), "hex" to Json.str(Hex.of(v)), "n" to v.size.toString())

    // ---------- операции ----------

    private fun readOp(svc: UUID, chr: UUID, c: BridgeServer.Client?, id: Any?) = Op("gatt.read", c, id) { g ->
        val ch = find(g, svc, chr) ?: return@Op false
        g.readCharacteristic(ch)
    }

    @Suppress("DEPRECATION")
    private fun writeOp(svc: UUID, chr: UUID, data: ByteArray, resp: Boolean, c: BridgeServer.Client?, id: Any?) = Op("gatt.write", c, id) { g ->
        val ch = find(g, svc, chr) ?: return@Op false
        val type = if (resp) BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT else BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        val started = if (Build.VERSION.SDK_INT >= 33) g.writeCharacteristic(ch, data, type) == 0
        else { ch.writeType = type; ch.value = data; g.writeCharacteristic(ch) }
        // без ответа колбэк тоже приходит, но у части телефонов — нет: не ждём 12 с, закрываем операцию сразу
        started
    }

    @Suppress("DEPRECATION")
    private fun notifyOp(svc: UUID, chr: UUID, on: Boolean, c: BridgeServer.Client?, id: Any?) = Op("gatt.notify", c, id) { g ->
        val ch = find(g, svc, chr) ?: return@Op false
        if (!g.setCharacteristicNotification(ch, on)) return@Op false
        val d = ch.getDescriptor(UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")) ?: return@Op true.also {
            // нет CCCD — подписка локальная, ждать нечего
            h.post { conns.values.firstOrNull { it.gatt === g }?.let { cn -> cn.cur?.let { o -> finish(cn, o, null) } } }
        }
        val value = if (!on) BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
            else if (ch.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            else BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
        if (Build.VERSION.SDK_INT >= 33) g.writeDescriptor(d, value) == 0 else { d.value = value; g.writeDescriptor(d) }
    }

    // ---------- команды ----------

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        if (!needs.need(c, id, cmd, btPerms())) return
        h.post {
            try { run(c, id, cmd, j) } catch (e: SecurityException) { Reply.done(c, id, cmd, "permission: ${e.message}", "permission") }
            catch (e: Exception) { Reply.done(c, id, cmd, e.message ?: e.javaClass.simpleName) }
        }
    }

    private fun run(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        if (cmd == "gatt.list") {
            Reply.done(c, id, cmd, null, extra = arrayOf("devices" to Json.arr(conns.values.filter { it.connected }.map { it.addr })))
            return
        }
        val addr = Args.mac(j.optString("addr")) ?: return Reply.done(c, id, cmd, "addr: AA:BB:CC:DD:EE:FF")
        if (cmd == "gatt.connect") return connect(c, id, addr, j)
        val cn = conns[addr]?.takeIf { it.gatt != null } ?: return Reply.done(c, id, cmd, "not connected to $addr — gatt.connect first")
        fun uuids(): Pair<UUID, UUID>? {
            val s = Args.uuid(j.optString("svc")); val ch = Args.uuid(j.optString("chr"))
            if (s == null || ch == null) { Reply.done(c, id, cmd, "svc and chr: 16-bit (180d) or 128-bit UUID"); return null }
            return s to ch
        }
        when (cmd) {
            "gatt.disconnect" -> {
                Reply.done(c, id, cmd, null)
                cn.gatt?.disconnect()
            }
            "gatt.discover" -> { cn.autoRead = j.optBoolean("read", false); cn.autoNotify = j.optBoolean("notify", false); cn.readMax = j.optInt("max", 0); enqueue(cn, Op(cmd, c, id) { it.discoverServices() }) }
            "gatt.read" -> { val (s, ch) = uuids() ?: return; enqueue(cn, readOp(s, ch, c, id)) }
            "gatt.write" -> {
                val (s, ch) = uuids() ?: return
                val data = Args.payload(j, 512) ?: return Reply.done(c, id, cmd, "hex or text: up to 512 bytes")
                val resp = j.optBoolean("resp", true)
                if (!resp) {
                    // без ответа: операция считается законченной сразу после постановки в стек
                    val op = writeOp(s, ch, data, false, c, id)
                    enqueue(cn, Op("gatt.write", c, id) { g -> op.run(g).also { ok -> if (ok) h.postDelayed({ cn.cur?.takeIf { it.name == "gatt.write" }?.let { o -> finish(cn, o, null) } }, 30) } })
                } else enqueue(cn, writeOp(s, ch, data, true, c, id))
            }
            "gatt.notify" -> { val (s, ch) = uuids() ?: return; enqueue(cn, notifyOp(s, ch, j.optBoolean("on", true), c, id)) }
            "gatt.mtu" -> { val m = j.optInt("mtu", 247).coerceIn(23, 517); enqueue(cn, Op(cmd, c, id) { it.requestMtu(m) }) }
            "gatt.rssi" -> enqueue(cn, Op(cmd, c, id) { it.readRemoteRssi() })
            "gatt.priority" -> {
                val p = when (j.optString("mode", "balanced")) { "high" -> BluetoothGatt.CONNECTION_PRIORITY_HIGH; "low" -> BluetoothGatt.CONNECTION_PRIORITY_LOW_POWER; else -> BluetoothGatt.CONNECTION_PRIORITY_BALANCED }
                Reply.done(c, id, cmd, if (cn.gatt?.requestConnectionPriority(p) == true) null else "refused")
            }
            "gatt.phy" -> {
                val m = when (j.optString("phy", "1m")) { "2m" -> BluetoothDevice.PHY_LE_2M_MASK; "coded" -> BluetoothDevice.PHY_LE_CODED_MASK; else -> BluetoothDevice.PHY_LE_1M_MASK }
                cn.gatt?.setPreferredPhy(m, m, BluetoothDevice.PHY_OPTION_NO_PREFERRED)
                Reply.done(c, id, cmd, null)
            }
            else -> Reply.done(c, id, cmd, "unknown command", "unknown")
        }
    }

    private fun connect(c: BridgeServer.Client, id: Any?, addr: String, j: JSONObject) {
        val ad = ctx.adapter()?.takeIf { it.isEnabled } ?: return Reply.done(c, id, "gatt.connect", "Bluetooth is off")
        conns[addr]?.let { old -> if (old.connected) return Reply.done(c, id, "gatt.connect", null, extra = arrayOf("addr" to Json.str(addr), "again" to "true")); old.gatt?.close(); conns.remove(addr) }
        if (conns.size >= 7) return Reply.done(c, id, "gatt.connect", "7 connections at most")
        val dev = try { ad.getRemoteDevice(addr) } catch (e: IllegalArgumentException) { return Reply.done(c, id, "gatt.connect", "bad address") }
        val cn = Conn(addr)
        cn.connC = c; cn.connId = id
        cn.discover = j.optBoolean("discover", true); cn.autoRead = j.optBoolean("read", false); cn.autoNotify = j.optBoolean("notify", false); cn.readMax = j.optInt("max", 0)
        conns[addr] = cn
        val phy = when (j.optString("phy", "1m")) { "2m" -> BluetoothDevice.PHY_LE_2M_MASK; "coded" -> BluetoothDevice.PHY_LE_CODED_MASK; "any" -> BluetoothDevice.PHY_LE_1M_MASK or BluetoothDevice.PHY_LE_2M_MASK or BluetoothDevice.PHY_LE_CODED_MASK; else -> BluetoothDevice.PHY_LE_1M_MASK }
        val g = dev.connectGatt(ctx, j.optBoolean("auto", false), callback(cn), BluetoothDevice.TRANSPORT_LE, phy, h)
        cn.gatt = g ?: run { conns.remove(addr); return Reply.done(c, id, "gatt.connect", "connectGatt refused") }
        val mtu = j.optInt("mtu", 0)
        if (mtu > 23) enqueue(cn, Op("gatt.mtu", null, null) { it.requestMtu(mtu.coerceIn(23, 517)) })
        // ответ на connect придёт из onConnectionStateChange; не пришёл за 30 с — отказ
        h.postDelayed({
            if (conns[addr] === cn && !cn.connected) {
                cn.connC?.let { Reply.done(it, cn.connId, "gatt.connect", "timeout", "timeout") }; cn.connC = null
                try { g.disconnect(); g.close() } catch (e: Exception) {}
                conns.remove(addr)
            }
        }, j.optLong("timeout", 30_000).coerceIn(3_000, 120_000))
    }

    fun held(): Int = conns.size

    fun release() { h.post { for (cn in conns.values) try { cn.gatt?.disconnect(); cn.gatt?.close() } catch (e: Exception) {}; conns.clear() } }

    fun close() {
        h.post { for (cn in conns.values) try { cn.gatt?.close() } catch (e: Exception) {}; conns.clear() }
        thread.quitSafely()
    }
}

/**
 * Классический Bluetooth и сопряжение: список сопряжённых, bond / unbond, UUID служб (SDP), RFCOMM-клиент и сервер (SPP).
 * Записи: {src:'btlink', ev:'open'|'data'|'close'|'accept'|'bond', addr, hex, text}.
 */
@SuppressLint("MissingPermission")
class BtLinkHub(private val ctx: Context, private val emit: Emit, private val needs: Needs) {
    private val thread = HandlerThread("dsp-btlink").also { it.start() }
    private val h = Handler(thread.looper)
    private val socks = ConcurrentHashMap<String, BluetoothSocket>()
    private var server: BluetoothServerSocket? = null
    private val SPP = UUID.fromString("00001101-0000-1000-8000-00805f9b34fb")

    private fun rec(ev: String, addr: String?, vararg kv: Pair<String, String?>) =
        emit("btlink", Json.obj("src" to "\"btlink\"", "ev" to Json.str(ev), "t" to System.currentTimeMillis().toString(), "addr" to addr?.let { Json.str(it) }, *kv))

    private val bondRx = object : BroadcastReceiver() {
        @Suppress("DEPRECATION")
        override fun onReceive(c: Context, i: Intent) {
            val d = i.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE) ?: return
            when (i.action) {
                BluetoothDevice.ACTION_BOND_STATE_CHANGED -> rec("bond", d.address, "state" to Json.str(bondName(i.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, 0))),
                    "prev" to Json.str(bondName(i.getIntExtra(BluetoothDevice.EXTRA_PREVIOUS_BOND_STATE, 0))))
                BluetoothDevice.ACTION_UUID -> {
                    val u = i.getParcelableArrayExtra(BluetoothDevice.EXTRA_UUID)?.mapNotNull { (it as? ParcelUuid)?.uuid }?.map { Args.uuidShort(it) } ?: return
                    rec("uuids", d.address, "uuids" to Json.arr(u))
                }
            }
        }
    }
    private var rx = false
    private fun bondName(s: Int) = when (s) { BluetoothDevice.BOND_BONDED -> "bonded"; BluetoothDevice.BOND_BONDING -> "bonding"; else -> "none" }

    private fun listenEvents() {
        if (rx) return
        val f = IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED).also { it.addAction(BluetoothDevice.ACTION_UUID) }
        ctx.registerReceiver(bondRx, f, null, h); rx = true
    }

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        if (!needs.need(c, id, cmd, btPerms())) return
        h.post {
            try { run(c, id, cmd, j) } catch (e: SecurityException) { Reply.done(c, id, cmd, "permission: ${e.message}", "permission") }
            catch (e: Exception) { Reply.done(c, id, cmd, e.message ?: e.javaClass.simpleName) }
        }
    }

    private fun run(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        val ad = ctx.adapter()?.takeIf { it.isEnabled } ?: return Reply.done(c, id, cmd, "Bluetooth is off")
        listenEvents()
        when (cmd) {
            "bt.bonded" -> {
                val rows = ad.bondedDevices.map { d ->
                    Json.obj("src" to "\"btdev\"", "addr" to Json.str(d.address), "name" to Json.str(d.name), "type" to Json.str(when (d.type) { 1 -> "classic"; 2 -> "le"; 3 -> "dual"; else -> "unknown" }),
                        "bond" to "\"bonded\"", "cls" to d.bluetoothClass?.deviceClass?.toString(), "uuids" to d.uuids?.let { u -> Json.arr(u.map { Args.uuidShort(it.uuid) }) })
                }
                if (rows.isNotEmpty()) c.send(Json.rows(rows))
                Reply.done(c, id, cmd, null, extra = arrayOf("n" to rows.size.toString()))
            }
            "bt.bond" -> {
                val d = ad.getRemoteDevice(Args.mac(j.optString("addr")) ?: return Reply.done(c, id, cmd, "bad address"))
                Reply.done(c, id, cmd, if (d.bondState == BluetoothDevice.BOND_BONDED || d.createBond()) null else "refused")
            }
            "bt.unbond" -> {
                val d = ad.getRemoteDevice(Args.mac(j.optString("addr")) ?: return Reply.done(c, id, cmd, "bad address"))
                // публичного API нет: removeBond скрыт, на новых Android может быть закрыт
                val ok = try { d.javaClass.getMethod("removeBond").invoke(d) as? Boolean ?: false } catch (e: Exception) { false }
                Reply.done(c, id, cmd, if (ok) null else "Android hides unpairing from apps — remove the pairing in the system settings")
            }
            "bt.uuids" -> {
                val d = ad.getRemoteDevice(Args.mac(j.optString("addr")) ?: return Reply.done(c, id, cmd, "bad address"))
                val cached = d.uuids?.map { Args.uuidShort(it.uuid) }
                if (cached.isNullOrEmpty()) { d.fetchUuidsWithSdp(); Reply.done(c, id, cmd, null, extra = arrayOf("uuids" to "[]", "pending" to "true")) }
                else Reply.done(c, id, cmd, null, extra = arrayOf("uuids" to Json.arr(cached)))
            }
            "bt.connect" -> {
                val addr = Args.mac(j.optString("addr")) ?: return Reply.done(c, id, cmd, "bad address")
                val u = if (j.has("uuid")) Args.uuid(j.optString("uuid")) ?: return Reply.done(c, id, cmd, "bad uuid") else SPP
                if (socks.size >= 4) return Reply.done(c, id, cmd, "4 links at most")
                socks.remove(addr)?.let { try { it.close() } catch (e: Exception) {} }
                Thread({
                    try {
                        ad.cancelDiscovery()                            // поиск мешает подключению
                        val d = ad.getRemoteDevice(addr)
                        val s = if (j.optBoolean("secure", true)) d.createRfcommSocketToServiceRecord(u) else d.createInsecureRfcommSocketToServiceRecord(u)
                        s.connect()
                        socks[addr] = s
                        rec("open", addr, "uuid" to Json.str(Args.uuidShort(u)))
                        Reply.done(c, id, cmd, null, extra = arrayOf("addr" to Json.str(addr)))
                        pump(addr, s)
                    } catch (e: Exception) { Reply.done(c, id, cmd, "RFCOMM: ${e.message}") }
                }, "dsp-rfcomm").also { it.isDaemon = true }.start()
            }
            "bt.send" -> {
                val addr = Args.mac(j.optString("addr")) ?: return Reply.done(c, id, cmd, "bad address")
                val s = socks[addr] ?: return Reply.done(c, id, cmd, "no link to $addr — bt.connect first")
                val data = Args.payload(j, 65535) ?: return Reply.done(c, id, cmd, "hex or text")
                try { s.outputStream.write(data); s.outputStream.flush(); Reply.done(c, id, cmd, null, extra = arrayOf("n" to data.size.toString())) }
                catch (e: Exception) { Reply.done(c, id, cmd, "send: ${e.message}") }
            }
            "bt.close" -> {
                val addr = Args.mac(j.optString("addr"))
                if (addr == null) { server?.close(); server = null; for (s in socks.values) try { s.close() } catch (e: Exception) {}; socks.clear() }
                else socks.remove(addr)?.let { try { it.close() } catch (e: Exception) {} }
                Reply.done(c, id, cmd, null)
            }
            "bt.listen" -> {
                server?.close()
                val u = if (j.has("uuid")) Args.uuid(j.optString("uuid")) ?: return Reply.done(c, id, cmd, "bad uuid") else SPP
                val ss = if (j.optBoolean("secure", true)) ad.listenUsingRfcommWithServiceRecord(j.optString("name", "DSP").take(32), u)
                    else ad.listenUsingInsecureRfcommWithServiceRecord(j.optString("name", "DSP").take(32), u)
                server = ss
                Thread({
                    try {
                        while (true) {
                            val s = ss.accept()
                            val addr = s.remoteDevice.address
                            socks.remove(addr)?.let { try { it.close() } catch (e: Exception) {} }
                            socks[addr] = s
                            rec("accept", addr, "uuid" to Json.str(Args.uuidShort(u)))
                            Thread({ pump(addr, s) }, "dsp-rfcomm-rd").also { it.isDaemon = true }.start()
                        }
                    } catch (e: Exception) { /* сервер закрыт */ }
                }, "dsp-rfcomm-srv").also { it.isDaemon = true }.start()
                Reply.done(c, id, cmd, null, extra = arrayOf("uuid" to Json.str(Args.uuidShort(u))))
            }
            else -> Reply.done(c, id, cmd, "unknown command", "unknown")
        }
    }

    /** Чтение канала до закрытия; запись — hex и текст (если это печатный UTF-8). */
    private fun pump(addr: String, s: BluetoothSocket) {
        val buf = ByteArray(2048)
        try {
            while (true) {
                val n = s.inputStream.read(buf); if (n < 0) break
                val b = buf.copyOf(n)
                rec("data", addr, "hex" to Json.str(Hex.of(b)), "n" to n.toString(), "text" to Json.str(String(b, Charsets.UTF_8)))
            }
        } catch (e: Exception) { /* закрыт */ }
        if (socks[addr] === s) socks.remove(addr)
        try { s.close() } catch (e: Exception) {}
        rec("close", addr)
    }

    fun held(): Int = socks.size + (if (server != null) 1 else 0)

    fun release() { try { server?.close() } catch (e: Exception) {}; server = null; for (s in socks.values) try { s.close() } catch (e: Exception) {}; socks.clear() }

    fun close() {
        if (rx) try { ctx.unregisterReceiver(bondRx) } catch (e: Exception) {}
        server?.close(); for (s in socks.values) try { s.close() } catch (e: Exception) {}
        socks.clear(); thread.quitSafely()
    }
}

/**
 * Реклама BLE (телефон как маячок / периферия): имя, UUID служб, данные производителя и служб; режим, мощность, подключаемость.
 * Расширенная реклама (ext) — со вторичным PHY (2M / Coded), если чип умеет. Команды: ble.adv.start / ble.adv.stop.
 */
@SuppressLint("MissingPermission")
class AdvertiseHub(private val ctx: Context, private val needs: Needs) {
    private var legacyCb: AdvertiseCallback? = null
    private var setCb: AdvertisingSetCallback? = null
    private var curSet: AdvertisingSet? = null
    @Volatile var on = false; private set

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        val perms = if (Build.VERSION.SDK_INT >= 31) listOf(Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT) else emptyList()
        if (!needs.need(c, id, cmd, perms)) return
        try { run(c, id, cmd, j) } catch (e: SecurityException) { Reply.done(c, id, cmd, "permission: ${e.message}", "permission") }
        catch (e: Exception) { Reply.done(c, id, cmd, e.message ?: e.javaClass.simpleName) }
    }

    private fun stop() {
        val a = ctx.adapter()?.bluetoothLeAdvertiser
        legacyCb?.let { try { a?.stopAdvertising(it) } catch (e: Exception) {} }
        setCb?.let { try { a?.stopAdvertisingSet(it) } catch (e: Exception) {} }
        legacyCb = null; setCb = null; curSet = null; on = false
    }

    private fun data(j: JSONObject, scanResp: Boolean): AdvertiseData {
        val b = AdvertiseData.Builder()
        if (!scanResp) {
            b.setIncludeDeviceName(j.optBoolean("name", false)); b.setIncludeTxPowerLevel(j.optBoolean("txp", false))
            j.optJSONArray("uuids")?.let { a -> for (i in 0 until a.length()) Args.uuid(a.optString(i))?.let { b.addServiceUuid(ParcelUuid(it)) } }
        }
        val src = if (scanResp) j.optJSONObject("resp") ?: JSONObject() else j
        src.optJSONObject("mfr")?.let { o -> for (k in o.keys()) { val id = k.toIntOrNull(16) ?: continue; Args.hex(o.optString(k), 27)?.let { b.addManufacturerData(id, it) } } }
        src.optJSONObject("svc")?.let { o -> for (k in o.keys()) { val u = Args.uuid(k) ?: continue; Args.hex(o.optString(k), 27)?.let { b.addServiceData(ParcelUuid(u), it) } } }
        return b.build()
    }

    private fun run(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        if (cmd == "ble.adv.stop") { stop(); return Reply.done(c, id, cmd, null) }
        if (cmd == "ble.adv.pdata") {
            val s = curSet ?: return Reply.done(c, id, cmd, "no periodic advertising running — ble.adv.start with periodic first")
            s.setPeriodicAdvertisingData(data(j, false)); return Reply.done(c, id, cmd, null)
        }
        if (cmd != "ble.adv.start") return Reply.done(c, id, cmd, "unknown command", "unknown")
        val ad = ctx.adapter()?.takeIf { it.isEnabled } ?: return Reply.done(c, id, cmd, "Bluetooth is off")
        val adv = ad.bluetoothLeAdvertiser ?: return Reply.done(c, id, cmd, "this phone cannot advertise over BLE")
        stop()
        val conn = j.optBoolean("connectable", false)
        val timeout = j.optInt("timeout", 0).coerceIn(0, 180_000)
        val per = j.optJSONObject("periodic")
        val ext = j.optBoolean("ext", false) || j.optString("phy", "1m") != "1m" || per != null
        if (!ext) {
            val s = AdvertiseSettings.Builder().setConnectable(conn).setTimeout(timeout)
                .setAdvertiseMode(when (j.optString("mode", "balanced")) { "low_latency" -> AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY; "low_power" -> AdvertiseSettings.ADVERTISE_MODE_LOW_POWER; else -> AdvertiseSettings.ADVERTISE_MODE_BALANCED })
                .setTxPowerLevel(when (j.optString("power", "medium")) { "ultra_low" -> AdvertiseSettings.ADVERTISE_TX_POWER_ULTRA_LOW; "low" -> AdvertiseSettings.ADVERTISE_TX_POWER_LOW; "high" -> AdvertiseSettings.ADVERTISE_TX_POWER_HIGH; else -> AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM }).build()
            val cb = object : AdvertiseCallback() {
                override fun onStartSuccess(s: AdvertiseSettings) { on = true; Reply.done(c, id, cmd, null, extra = arrayOf("ext" to "false")) }
                override fun onStartFailure(e: Int) { legacyCb = null; Reply.done(c, id, cmd, "advertising failed (" + when (e) { ADVERTISE_FAILED_DATA_TOO_LARGE -> "data too large — 31 bytes in the packet"; ADVERTISE_FAILED_TOO_MANY_ADVERTISERS -> "too many advertisers"; ADVERTISE_FAILED_ALREADY_STARTED -> "already started"; ADVERTISE_FAILED_FEATURE_UNSUPPORTED -> "not supported"; else -> "code $e" } + ")") }
            }
            legacyCb = cb
            val resp = if (j.has("resp")) data(j, true) else null
            if (resp != null) adv.startAdvertising(s, data(j, false), resp, cb) else adv.startAdvertising(s, data(j, false), cb)
            return
        }
        if (!ad.isLeExtendedAdvertisingSupported) return Reply.done(c, id, cmd, "this phone has no extended advertising")
        val phy = when (j.optString("phy", "1m")) { "2m" -> BluetoothDevice.PHY_LE_2M; "coded" -> BluetoothDevice.PHY_LE_CODED; else -> BluetoothDevice.PHY_LE_1M }
        if (phy == BluetoothDevice.PHY_LE_CODED && !ad.isLeCodedPhySupported) return Reply.done(c, id, cmd, "this phone has no LE Coded PHY")
        if (phy == BluetoothDevice.PHY_LE_2M && !ad.isLe2MPhySupported) return Reply.done(c, id, cmd, "this phone has no LE 2M PHY")
        if (per != null && !ad.isLePeriodicAdvertisingSupported) return Reply.done(c, id, cmd, "this phone has no periodic advertising")
        val pp = per?.let { PeriodicAdvertisingParameters.Builder().setIncludeTxPower(it.optBoolean("txp", false)).setInterval(Args.periodicInterval(it.optDouble("interval", 100.0))).build() }
        val p = AdvertisingSetParameters.Builder().setLegacyMode(false).setConnectable(conn && false).setScannable(false)
            .setPrimaryPhy(if (phy == BluetoothDevice.PHY_LE_CODED) BluetoothDevice.PHY_LE_CODED else BluetoothDevice.PHY_LE_1M).setSecondaryPhy(phy)
            .setInterval(when (j.optString("mode", "balanced")) { "low_latency" -> AdvertisingSetParameters.INTERVAL_LOW; "low_power" -> AdvertisingSetParameters.INTERVAL_HIGH; else -> AdvertisingSetParameters.INTERVAL_MEDIUM })
            .setTxPowerLevel(when (j.optString("power", "medium")) { "ultra_low" -> AdvertisingSetParameters.TX_POWER_ULTRA_LOW; "low" -> AdvertisingSetParameters.TX_POWER_LOW; "high" -> AdvertisingSetParameters.TX_POWER_HIGH; else -> AdvertisingSetParameters.TX_POWER_MEDIUM }).build()
        val cb = object : AdvertisingSetCallback() {
            override fun onAdvertisingSetStarted(s: AdvertisingSet?, tx: Int, status: Int) {
                if (status == ADVERTISE_SUCCESS) { on = true; curSet = s; Reply.done(c, id, cmd, null, extra = arrayOf("ext" to "true", "tx" to tx.toString())) }
                else { setCb = null; Reply.done(c, id, cmd, "extended advertising failed (code $status)") }
            }
        }
        setCb = cb
        adv.startAdvertisingSet(p, data(j, false), null, pp, per?.let { data(it, false) }, cb)
    }

    fun held(): Int = if (on) 1 else 0

    fun release() = stop()

    fun close() = stop()
}
