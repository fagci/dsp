package app.dsp.phone

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Общий USB-API моста: ws://host:port/usb?k=… — двоичные сообщения [u32 длина заголовка][заголовок JSON][данные].
 * Запрос {id, op, …}, ответ {id, ok:true, …} или {id, ok:false, err, msg}; событие {ev:'connect'|'disconnect', …}.
 * Операции: list, perm, open, close, config, claim, release, alt, control, in, out, clear, reset (подробнее — tools/android/README.md).
 * Страница в приложении получает адрес через DspApp.usbUrl(), веб-часть (modules/usb-bridge.js) строит из него navigator.usb.
 */
class UsbError(val name: String, msg: String) : Exception(msg)

/** Ключ доступа к /usb: известен только странице приложения (через DspApp), чужие сайты и приложения его не знают. */
object UsbKey {
    @Volatile private var dir: java.io.File? = null

    /** Ключ лежит в закрытой папке приложения: окна-слоты (другие процессы) читают тот же. Вызвать до первого value. */
    fun init(ctx: android.content.Context) { dir = ctx.filesDir }

    val value: String by lazy { load() }

    private fun gen(): String { val r = SecureRandom(); val a = "abcdefghijkmnpqrstuvwxyz23456789"; return String(CharArray(24) { a[r.nextInt(a.length)] }) }

    private fun load(): String {
        val d = dir ?: return gen()
        val f = java.io.File(d, "app-key")
        try {
            f.takeIf { it.exists() }?.readText()?.trim()?.takeIf { it.length >= 16 }?.let { return it }
            val k = gen(); val t = java.io.File(d, "app-key." + android.os.Process.myPid())
            t.writeText(k)
            try { java.nio.file.Files.createLink(f.toPath(), t.toPath()) } catch (e: java.nio.file.FileAlreadyExistsException) { /* другой процесс успел раньше */ } finally { t.delete() }
            return f.readText().trim().ifEmpty { k }
        } catch (e: Exception) { return gen() }
    }
}

interface UsbBackend {
    /** Устройства с описанием (JSON-объекты, см. AndroidUsb.describe) и признаком perm. */
    fun list(): JSONArray
    /** Ждёт ответа пользователя на системный запрос доступа. */
    fun permission(id: String): Boolean
    /** Открывает устройство; возвращает {configs, usb, speed} по сырым дескрипторам (точнее модели Android) или null. */
    fun open(id: String): JSONObject?
    fun close(id: String)
    fun config(id: String, value: Int)
    fun claim(id: String, num: Int)
    fun release(id: String, num: Int)
    fun alt(id: String, num: Int, alt: Int)
    /** Управляющая передача; для IN-запросов (rt & 0x80) возвращает данные длиной len, для OUT — пустой массив. */
    fun control(id: String, rt: Int, req: Int, value: Int, index: Int, len: Int, data: ByteArray?): ByteArray
    /** Чтение с конечной точки addr (с битом направления), до len байт; ждёт данные, пока сессия жива. */
    fun bulkIn(id: String, addr: Int, len: Int, alive: () -> Boolean): ByteArray
    fun bulkOut(id: String, addr: Int, data: ByteArray): Int
    fun clearHalt(id: String, addr: Int)
    fun reset(id: String)
    /** События подключения / отключения: (connect|disconnect, JSON). */
    fun listen(l: (String, JSONObject) -> Unit)
    fun unlisten(l: (String, JSONObject) -> Unit)
}

/** Одно WebSocket-соединение со страницей: разбор кадров и запросов, ответы из пула потоков. */
class UsbSession(private val sock: Socket, private val backend: UsbBackend) {
    @Volatile private var alive = true
    private val out: OutputStream = sock.getOutputStream()
    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "dsp-usb").also { it.isDaemon = true } }
    private val ev: (String, JSONObject) -> Unit = { name, j -> send(JSONObject(j.toString()).put("ev", name), null) }

    fun run() {
        backend.listen(ev)
        val inp = DataInputStream(sock.getInputStream().buffered(65536))
        val msg = ByteArrayOutputStream()
        try {
            while (alive) {
                val b0 = inp.read()
                if (b0 < 0) break
                val b1 = inp.readUnsignedByte()
                val fin = (b0 and 0x80) != 0
                val op = b0 and 15
                var len = (b1 and 127).toLong()
                if (len == 126L) len = inp.readUnsignedShort().toLong() else if (len == 127L) len = inp.readLong()
                if (len < 0 || len > MAX) break
                val mask = if ((b1 and 0x80) != 0) ByteArray(4).also { inp.readFully(it) } else null
                val pl = ByteArray(len.toInt())
                inp.readFully(pl)
                if (mask != null) for (i in pl.indices) pl[i] = (pl[i].toInt() xor mask[i and 3].toInt()).toByte()
                when (op) {
                    8 -> break
                    9 -> synchronized(out) { out.write(BridgeServer.frame(pl, 10)); out.flush() }
                    0, 1, 2 -> { msg.write(pl); if (fin) { val m = msg.toByteArray(); msg.reset(); pool.execute { handle(m) } } }
                }
            }
        } catch (e: Exception) { /* обрыв */ }
        finally {
            alive = false
            backend.unlisten(ev)
            pool.shutdownNow()
        }
    }

    private fun send(h: JSONObject, payload: ByteArray?) {
        if (!alive) return
        val hb = h.toString().toByteArray(Charsets.UTF_8)
        val body = ByteArray(4 + hb.size + (payload?.size ?: 0))
        body[0] = (hb.size shr 24).toByte(); body[1] = (hb.size shr 16).toByte(); body[2] = (hb.size shr 8).toByte(); body[3] = hb.size.toByte()
        System.arraycopy(hb, 0, body, 4, hb.size)
        if (payload != null) System.arraycopy(payload, 0, body, 4 + hb.size, payload.size)
        try { synchronized(out) { out.write(BridgeServer.frame(body, 2)); out.flush() } }
        catch (e: Exception) { alive = false; try { sock.close() } catch (x: Exception) {} }
    }

    private fun handle(m: ByteArray) {
        var id = -1
        try {
            if (m.size < 4) return
            val hl = ((m[0].toInt() and 255) shl 24) or ((m[1].toInt() and 255) shl 16) or ((m[2].toInt() and 255) shl 8) or (m[3].toInt() and 255)
            if (hl < 2 || 4 + hl > m.size) return
            val h = JSONObject(String(m, 4, hl, Charsets.UTF_8))
            id = h.optInt("id", -1)
            val payload = m.copyOfRange(4 + hl, m.size)
            val r = JSONObject().put("id", id).put("ok", true)
            var data: ByteArray? = null
            val dev = h.optString("dev")
            when (h.optString("op")) {
                "list" -> r.put("devices", backend.list())
                "perm" -> r.put("granted", backend.permission(dev))
                "open" -> backend.open(dev)?.let { r.put("configs", it.getJSONArray("configs")).put("usb", it.getString("usb")).put("speed", it.optString("speed"))
                    .put("raw", it.optString("raw")).put("other", it.optString("other")).put("mbps", it.optInt("mbps")) }
                "close" -> backend.close(dev)
                "config" -> backend.config(dev, h.optInt("value"))
                "claim" -> backend.claim(dev, h.optInt("num"))
                "release" -> backend.release(dev, h.optInt("num"))
                "alt" -> backend.alt(dev, h.optInt("num"), h.optInt("alt"))
                "control" -> data = backend.control(dev, h.optInt("rt"), h.optInt("req"), h.optInt("val"), h.optInt("idx"), h.optInt("len"), payload)
                "in" -> data = backend.bulkIn(dev, h.optInt("ep"), h.optInt("len").coerceIn(0, MAX_XFER)) { alive }
                "out" -> r.put("written", backend.bulkOut(dev, h.optInt("ep"), payload))
                "clear" -> backend.clearHalt(dev, h.optInt("ep"))
                "reset" -> backend.reset(dev)
                else -> throw UsbError("NotSupportedError", "unknown op")
            }
            send(r, data)
        } catch (e: UsbError) {
            send(JSONObject().put("id", id).put("ok", false).put("err", e.name).put("msg", e.message ?: ""), null)
        } catch (e: Exception) {
            send(JSONObject().put("id", id).put("ok", false).put("err", "NetworkError").put("msg", e.message ?: e.javaClass.simpleName), null)
        }
    }

    companion object {
        const val MAX = 16 shl 20
        const val MAX_XFER = 8 shl 20
    }
}

/** USB Host API Android: устройства, доступ, передачи. Один UsbDeviceConnection на устройство. */
class AndroidUsb(private val ctx: Context) : UsbBackend {
    private val um = ctx.getSystemService(Context.USB_SERVICE) as UsbManager
    private class Conn(val dev: UsbDevice, val c: UsbDeviceConnection, val raw: UsbDesc.Parsed?, val other: UsbDesc.Parsed? = null) { val claimed = HashMap<Int, UsbInterface>() }
    private val conns = HashMap<String, Conn>()
    private val listeners = CopyOnWriteArraySet<(String, JSONObject) -> Unit>()
    private val answers = HashMap<String, CountDownLatch>()
    private val granted = HashMap<String, Boolean>()
    private var receiving = false

    private val rx = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            @Suppress("DEPRECATION") val d = i.getParcelableExtra<UsbDevice>(UsbManager.EXTRA_DEVICE) ?: return
            when (i.action) {
                ACTION_PERM -> synchronized(answers) {
                    granted[d.deviceName] = i.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    answers.remove(d.deviceName)?.countDown()
                }
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    synchronized(this@AndroidUsb) { conns.remove(d.deviceName)?.let { try { it.c.close() } catch (e: Exception) {} } }
                    for (l in listeners) l("disconnect", JSONObject().put("id", d.deviceName))
                }
                UsbManager.ACTION_USB_DEVICE_ATTACHED -> if (um.hasPermission(d)) for (l in listeners) l("connect", describe(d))
            }
        }
    }

    override fun listen(l: (String, JSONObject) -> Unit) {
        listeners.add(l)
        synchronized(this) {
            if (receiving) return
            receiving = true
            val f = IntentFilter().apply { addAction(ACTION_PERM); addAction(UsbManager.ACTION_USB_DEVICE_DETACHED); addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED) }
            if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(rx, f, Context.RECEIVER_NOT_EXPORTED) else ctx.registerReceiver(rx, f)
        }
    }

    override fun unlisten(l: (String, JSONObject) -> Unit) { listeners.remove(l) }

    fun close() {
        synchronized(this) {
            for (c in conns.values) try { c.c.close() } catch (e: Exception) {}
            conns.clear()
            if (receiving) { receiving = false; try { ctx.unregisterReceiver(rx) } catch (e: IllegalArgumentException) {} }
        }
    }

    private fun find(id: String): UsbDevice = um.deviceList[id] ?: throw UsbError("NotFoundError", "device is gone")

    @Synchronized
    private fun conn(id: String): Conn = conns[id] ?: throw UsbError("InvalidStateError", "the device must be opened first")

    private fun typeName(t: Int) = when (t) {
        UsbConstants.USB_ENDPOINT_XFER_BULK -> "bulk"; UsbConstants.USB_ENDPOINT_XFER_INT -> "interrupt"
        UsbConstants.USB_ENDPOINT_XFER_ISOC -> "isochronous"; else -> "control"
    }

    private fun bcd(v: String?): String = v ?: "0.0"

    fun describe(d: UsbDevice): JSONObject {
        val perm = um.hasPermission(d)
        val cfgs = JSONArray()
        for (ci in 0 until d.configurationCount) {
            val c = d.getConfiguration(ci)
            val ifs = JSONArray()
            for (ii in 0 until c.interfaceCount) {
                val f = c.getInterface(ii)
                val eps = JSONArray()
                for (ei in 0 until f.endpointCount) {
                    val e = f.getEndpoint(ei)
                    eps.put(JSONObject().put("num", e.endpointNumber).put("in", e.direction == UsbConstants.USB_DIR_IN)
                        .put("type", typeName(e.type)).put("size", e.maxPacketSize))
                }
                ifs.put(JSONObject().put("num", f.id).put("alt", f.alternateSetting).put("cls", f.interfaceClass).put("sub", f.interfaceSubclass)
                    .put("proto", f.interfaceProtocol).put("name", f.name ?: JSONObject.NULL).put("eps", eps))
            }
            cfgs.put(JSONObject().put("value", c.id).put("name", c.name ?: JSONObject.NULL).put("ifaces", ifs))
        }
        // изготовитель, название и серийный номер Android отдаёт только с доступом
        fun priv(f: () -> String?): Any = try { if (perm) f() ?: JSONObject.NULL else JSONObject.NULL } catch (e: SecurityException) { JSONObject.NULL }
        return JSONObject().put("id", d.deviceName).put("perm", perm).put("vid", d.vendorId).put("pid", d.productId)
            .put("cls", d.deviceClass).put("sub", d.deviceSubclass).put("proto", d.deviceProtocol)
            .put("ver", bcd(d.version)).put("mfr", priv { d.manufacturerName }).put("prod", priv { d.productName }).put("serial", priv { d.serialNumber })
            .put("configs", cfgs)
    }

    override fun list(): JSONArray { val a = JSONArray(); for (d in um.deviceList.values) a.put(describe(d)); return a }

    override fun permission(id: String): Boolean {
        val d = find(id)
        if (um.hasPermission(d)) return true
        val latch = CountDownLatch(1)
        synchronized(answers) { granted.remove(id); answers[id] = latch }
        val pi = PendingIntent.getBroadcast(ctx, 0, Intent(ACTION_PERM).setPackage(ctx.packageName),
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        um.requestPermission(d, pi)
        latch.await(120, TimeUnit.SECONDS)
        synchronized(answers) { answers.remove(id) }
        return um.hasPermission(find(id))
    }

    /** Скорость порта по sysfs (Мбит/с; 12 — full-speed, 480 — high-speed); 0 — не удалось прочитать (SELinux, другая версия ядра). */
    private fun sysfsMbps(deviceName: String): Int = try {
        val m = Regex("/dev/bus/usb/(\\d+)/(\\d+)").matchEntire(deviceName)
        val bus = m?.groupValues?.get(1)?.toInt(); val dev = m?.groupValues?.get(2)?.toInt()
        var out = 0
        for (d in java.io.File("/sys/bus/usb/devices").listFiles() ?: emptyArray()) {
            if (java.io.File(d, "busnum").readText().trim().toIntOrNull() == bus && java.io.File(d, "devnum").readText().trim().toIntOrNull() == dev) {
                out = java.io.File(d, "speed").readText().trim().toDoubleOrNull()?.toInt() ?: 0; break
            }
        }
        out
    } catch (e: Exception) { 0 }

    /** Ответ на open: описание по сырым байтам (если разобралось) и данные для диагностики — скорость порта и сами дескрипторы. */
    private fun rawJson(c: Conn, name: String): JSONObject {
        val r = c.raw
        return JSONObject().put("configs", r?.configs ?: JSONArray()).put("usb", r?.usb ?: "2.00").put("speed", UsbDesc.speed(r, c.other))
            .put("raw", r?.rawHex ?: "").put("other", c.other?.rawHex ?: "").put("mbps", sysfsMbps(name))
    }

    @Synchronized
    override fun open(id: String): JSONObject? {
        conns[id]?.let { return rawJson(it, id) }
        val d = find(id)
        if (!um.hasPermission(d)) throw UsbError("SecurityError", "no access to the device — it was not allowed")
        val c = um.openDevice(d) ?: throw UsbError("NetworkError", "cannot open the device")
        val raw = try { c.rawDescriptors?.let { UsbDesc.parse(it) } } catch (e: Exception) { null }
        // GET_DESCRIPTOR(OTHER_SPEED_CONFIGURATION): что устройство отдало бы на другой скорости — по нему видно, что порт не дал high-speed
        val other = try { val buf = ByteArray(512); val n = c.controlTransfer(0x80, 6, 7 shl 8, 0, buf, buf.size, 1000); if (n > 0) UsbDesc.parse(buf.copyOf(n)) else null } catch (e: Exception) { null }
        val cn = Conn(d, c, raw, other)
        conns[id] = cn
        return rawJson(cn, id)
    }

    @Synchronized
    override fun close(id: String) {
        val c = conns.remove(id) ?: return
        for (f in c.claimed.values) try { c.c.releaseInterface(f) } catch (e: Exception) {}
        try { c.c.close() } catch (e: Exception) {}
    }

    override fun config(id: String, value: Int) {
        val c = conn(id)
        // Android открывает устройство с первой конфигурацией; переключаем, только если просят другую
        val want = (0 until c.dev.configurationCount).map { c.dev.getConfiguration(it) }.firstOrNull { it.id == value }
            ?: throw UsbError("NotFoundError", "no configuration $value")
        if (c.dev.configurationCount > 1 && want.id != c.dev.getConfiguration(0).id && !c.c.setConfiguration(want))
            throw UsbError("NetworkError", "cannot select the configuration")
    }

    private fun iface(c: Conn, num: Int, alt: Int, any: Boolean = false): UsbInterface {
        for (ci in 0 until c.dev.configurationCount) {
            val cfg = c.dev.getConfiguration(ci)
            for (ii in 0 until cfg.interfaceCount) { val f = cfg.getInterface(ii); if (f.id == num && (any || f.alternateSetting == alt)) return f }
        }
        throw UsbError("NotFoundError", "no interface $num")
    }

    override fun claim(id: String, num: Int) {
        val c = conn(id)
        val f = iface(c, num, 0, any = true)
        // force = true: отцепить драйвер ядра, если он занял интерфейс
        if (!c.c.claimInterface(f, true)) throw UsbError("NetworkError", "cannot claim the interface $num")
        synchronized(this) { c.claimed[num] = f }
    }

    override fun release(id: String, num: Int) {
        val c = conn(id)
        val f = synchronized(this) { c.claimed.remove(num) } ?: return
        c.c.releaseInterface(f)
    }

    override fun alt(id: String, num: Int, alt: Int) {
        val c = conn(id)
        if (!c.claimed.containsKey(num)) throw UsbError("InvalidStateError", "interface $num is not claimed")
        val known = try { iface(c, num, alt) } catch (e: UsbError) { null }
        // настройки, которых нет в модели Android, переключаем запросом SET_INTERFACE напрямую
        val ok = if (known != null) c.c.setInterface(known) else c.c.controlTransfer(0x01, 11, alt, num, null, 0, 1000) >= 0
        if (!ok) throw UsbError("NetworkError", "cannot select the alternate setting")
    }

    override fun control(id: String, rt: Int, req: Int, value: Int, index: Int, len: Int, data: ByteArray?): ByteArray {
        val c = conn(id)
        val inDir = (rt and 0x80) != 0
        val buf = if (inDir) ByteArray(len) else (data ?: ByteArray(0))
        val n = c.c.controlTransfer(rt, req, value, index, buf, if (inDir) len else buf.size, 5000)
        if (n < 0) throw UsbError("NetworkError", "control transfer failed")
        return if (inDir) buf.copyOf(n) else ByteArray(0)
    }

    private fun endpoint(c: Conn, addr: Int): android.hardware.usb.UsbEndpoint {
        for (f in c.claimed.values) for (e in 0 until f.endpointCount) { val ep = f.getEndpoint(e); if (ep.address == addr) return ep }
        // альтернативная настройка могла быть выбрана иначе — ищем по всем интерфейсам
        for (ci in 0 until c.dev.configurationCount) { val cfg = c.dev.getConfiguration(ci)
            for (ii in 0 until cfg.interfaceCount) { val f = cfg.getInterface(ii); for (e in 0 until f.endpointCount) if (f.getEndpoint(e).address == addr) return f.getEndpoint(e) } }
        // Android не показал точку (альтернативная настройка вне его модели) — собираем её по сырым дескрипторам
        val raw = c.raw?.configs
        if (raw != null) for (ci in 0 until raw.length()) { val ifs = raw.getJSONObject(ci).getJSONArray("ifaces")
            for (ii in 0 until ifs.length()) { val eps = ifs.getJSONObject(ii).getJSONArray("eps")
                for (ei in 0 until eps.length()) { val e = eps.getJSONObject(ei)
                    val a = e.getInt("num") or (if (e.getBoolean("in")) 0x80 else 0)
                    if (a == addr) return makeEndpoint(a, when (e.getString("type")) { "isochronous" -> 1; "bulk" -> 2; "interrupt" -> 3; else -> 0 }, e.getInt("size")) } } }
        throw UsbError("NotFoundError", "no endpoint 0x" + Integer.toHexString(addr))
    }

    /** UsbEndpoint без публичного конструктора: через отражение (на некоторых версиях закрыт). */
    private fun makeEndpoint(addr: Int, attrs: Int, size: Int): android.hardware.usb.UsbEndpoint = try {
        val k = android.hardware.usb.UsbEndpoint::class.java.getDeclaredConstructor(Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType)
        k.isAccessible = true
        k.newInstance(addr, attrs, size, 0)
    } catch (e: Exception) { throw UsbError("NotSupportedError", "endpoint 0x" + Integer.toHexString(addr) + " is not in the Android model of the device and cannot be built on this Android version") }

    override fun bulkIn(id: String, addr: Int, len: Int, alive: () -> Boolean): ByteArray {
        val c = conn(id)
        val ep = endpoint(c, addr)
        val out = ByteArray(len)
        var got = 0
        while (got < len) {
            val chunk = minOf(len - got, CHUNK)
            val tmp = ByteArray(chunk)
            val n = c.c.bulkTransfer(ep, tmp, chunk, 500)
            if (n < 0) {
                if (!alive() || synchronized(this) { conns[id] !== c }) throw UsbError("NetworkError", "the device is closed")
                if (got > 0) break                     // таймаут после части данных — отдаём, что есть
                continue                               // WebUSB ждёт данные без срока
            }
            System.arraycopy(tmp, 0, out, got, n); got += n
            if (n < chunk) break                       // короткий пакет — конец передачи
        }
        return out.copyOf(got)
    }

    override fun bulkOut(id: String, addr: Int, data: ByteArray): Int {
        val c = conn(id)
        val ep = endpoint(c, addr)
        var sent = 0
        while (sent < data.size) {
            val chunk = minOf(data.size - sent, CHUNK)
            val n = c.c.bulkTransfer(ep, data.copyOfRange(sent, sent + chunk), chunk, 5000)
            if (n < 0) throw UsbError("NetworkError", "transfer failed after $sent bytes")
            sent += n
        }
        return sent
    }

    override fun clearHalt(id: String, addr: Int) {
        val c = conn(id)
        // CLEAR_FEATURE(ENDPOINT_HALT) на конечную точку
        if (c.c.controlTransfer(0x02, 1, 0, addr, null, 0, 1000) < 0) throw UsbError("NetworkError", "cannot clear the halt")
    }

    override fun reset(id: String) {
        val c = conn(id)
        try { UsbDeviceConnection::class.java.getMethod("resetDevice").invoke(c.c) } catch (e: Exception) { /* не у всех версий */ }
    }

    companion object {
        const val ACTION_PERM = "app.dsp.phone.USB_PERMISSION"
        private const val CHUNK = 16384
    }
}
