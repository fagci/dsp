package app.dsp.phone

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import org.json.JSONObject
import java.io.File
import java.io.OutputStream

/** Разбор дескриптора HID: есть ли report id и длина самого длинного отчёта (с байтом id) — для `report_length` USB-гаджета. Чистая логика, тест UsbHidTest. */
object HidDesc {
    data class Info(val ids: Boolean, val maxLen: Int)

    fun info(d: ByteArray): Info {
        var i = 0; var size = 0; var count = 0; var id = 0; var ids = false
        val bits = HashMap<Int, Int>()                                    // report id → самый длинный из input / output / feature, бит
        val perKind = HashMap<Pair<Int, Int>, Int>()
        while (i < d.size) {
            val h = d[i].toInt() and 0xFF
            if (h == 0xFE) { i += 3 + (d.getOrElse(i + 1) { 0 }.toInt() and 0xFF); continue }     // длинный элемент
            val n = if ((h and 3) == 3) 4 else h and 3
            var v = 0
            for (k in 0 until n) v = v or ((d.getOrElse(i + 1 + k) { 0 }.toInt() and 0xFF) shl (8 * k))
            i += 1 + n
            val type = (h shr 2) and 3; val tag = h shr 4
            if (type == 1) { when (tag) { 7 -> size = v; 9 -> count = v; 8 -> { id = v; ids = true } } }
            else if (type == 0 && (tag == 8 || tag == 9 || tag == 11)) {
                val k = id to tag; perKind[k] = (perKind[k] ?: 0) + size * count
                bits[id] = maxOf(bits[id] ?: 0, perKind[k]!!)
            }
        }
        val bytes = (bits.values.maxOrNull() ?: 0).let { (it + 7) / 8 }
        return Info(ids, bytes + if (ids) 1 else 0)
    }
}

/** Скрипты root для USB-гаджета (configfs). Подставляются только числа и пути, которые строит само приложение. */
object UsbHidScript {
    private const val FN = "hid.dsp"

    /** Находит гаджет, добавляет функцию hid с дескриптором из файла, переподключает UDC. Печатает `OK node=/dev/hidgN udc=ИМЯ` или `ERR …`. */
    fun up(descFile: String, subclass: Int, protocol: Int, reportLen: Int): String = """
        G=${'$'}(ls -d /config/usb_gadget/* 2>/dev/null | head -n1)
        [ -n "${'$'}G" ] || { echo "ERR no USB gadget in configfs (/config/usb_gadget): this kernel or ROM does not use it"; exit 3; }
        C=${'$'}(ls -d ${'$'}G/configs/* 2>/dev/null | head -n1)
        [ -n "${'$'}C" ] || { echo "ERR the gadget has no configuration"; exit 3; }
        U=${'$'}(ls /sys/class/udc 2>/dev/null | head -n1)
        [ -n "${'$'}U" ] || { echo "ERR no USB device controller (/sys/class/udc)"; exit 3; }
        F=${'$'}G/functions/$FN
        echo "" > ${'$'}G/UDC 2>/dev/null
        rm -f ${'$'}C/$FN 2>/dev/null; rmdir ${'$'}F 2>/dev/null
        if ! mkdir ${'$'}F 2>/dev/null; then echo ${'$'}U > ${'$'}G/UDC; echo "ERR this kernel has no USB HID gadget function (CONFIG_USB_F_HID / CONFIG_USB_CONFIGFS_F_HID)"; exit 4; fi
        echo $protocol > ${'$'}F/protocol; echo $subclass > ${'$'}F/subclass; echo $reportLen > ${'$'}F/report_length
        cat $descFile > ${'$'}F/report_desc || { rmdir ${'$'}F; echo ${'$'}U > ${'$'}G/UDC; echo "ERR the kernel refused the report descriptor"; exit 5; }
        ln -s ${'$'}F ${'$'}C/$FN || { rmdir ${'$'}F; echo ${'$'}U > ${'$'}G/UDC; echo "ERR cannot add the function to the configuration"; exit 6; }
        echo ${'$'}U > ${'$'}G/UDC || { echo "ERR cannot bind the USB controller"; exit 7; }
        MM=${'$'}(cat ${'$'}F/dev 2>/dev/null)
        N=""
        for t in 1 2 3 4 5 6 7 8 9 10; do
          for d in /dev/hidg*; do
            [ -e "${'$'}d" ] || continue
            m=${'$'}(stat -c '%t:%T' ${'$'}d 2>/dev/null); a=${'$'}(printf '%d:%d' 0x${'$'}{m%%:*} 0x${'$'}{m##*:})
            if [ "${'$'}a" = "${'$'}MM" ] || [ -z "${'$'}MM" ]; then N=${'$'}d; fi
          done
          [ -n "${'$'}N" ] && break
          sleep 0.2
        done
        [ -n "${'$'}N" ] || { echo "ERR the device node /dev/hidg* did not appear"; exit 8; }
        chmod 666 ${'$'}N 2>/dev/null
        echo "OK node=${'$'}N udc=${'$'}U"
    """.trimIndent()

    /** Убирает функцию и возвращает гаджет как был. */
    fun down(): String = """
        G=${'$'}(ls -d /config/usb_gadget/* 2>/dev/null | head -n1); [ -n "${'$'}G" ] || exit 0
        C=${'$'}(ls -d ${'$'}G/configs/* 2>/dev/null | head -n1)
        U=${'$'}(ls /sys/class/udc 2>/dev/null | head -n1)
        echo "" > ${'$'}G/UDC 2>/dev/null
        rm -f ${'$'}C/$FN 2>/dev/null; rmdir ${'$'}G/functions/$FN 2>/dev/null
        [ -n "${'$'}U" ] && echo ${'$'}U > ${'$'}G/UDC
        exit 0
    """.trimIndent()

    /** Разбор ответа up(): node и udc. */
    fun parse(out: String): Pair<String, String>? {
        val m = Regex("OK node=(/dev/hidg\\d+) udc=([A-Za-z0-9._\\-]+)").find(out) ?: return null
        return m.groupValues[1] to m.groupValues[2]
    }
    fun error(out: String): String = out.lineSequence().firstOrNull { it.startsWith("ERR ") }?.removePrefix("ERR ") ?: out.trim().lines().lastOrNull().orEmpty().ifBlank { "root script failed" }

    /** Строка оболочки: записать готовый файл отчёта в открытый дескриптор 3 одним write(). */
    fun write(file: String) = "cat $file >&3"
}

/**
 * USB-HID (root): телефон как USB-клавиатура / мышь / пульт / геймпад для ТВ, ПК, приставки по кабелю. Поднимает функцию `hid` в USB-гаджете ядра
 * через configfs (то же, что делают NetHunter и HID-скрипты) — нужен root и ядро с CONFIG_USB_F_HID. Те же записи, что у `hid.*`: канал `hid`,
 * {src:'hid', ev:'app'|'connected'|'disconnected'|'data', addr:'usb'}; подключение хоста — по состоянию UDC (`configured`).
 * Команды: usbhid.register {name, descriptor}, usbhid.report {id, hex}, usbhid.unregister, usbhid.list.
 */
class UsbHidHub(private val ctx: Context, private val emit: Emit, private val needs: Needs) {
    private val thread = HandlerThread("dsp-usbhid").also { it.start() }
    private val h = Handler(thread.looper)
    @Volatile private var node: String? = null
    private var udc = ""
    private var ids = true
    private var writer: Process? = null
    private var wout: OutputStream? = null
    private var reader: Process? = null
    private var connected = false
    private val frame = File(ctx.cacheDir, "usbhid-report.bin")
    private val desc = File(ctx.cacheDir, "usbhid-desc.bin")

    private fun rec(ev: String, vararg kv: Pair<String, String?>) =
        emit("hid", Json.obj("src" to "\"hid\"", "ev" to Json.str(ev), "t" to System.currentTimeMillis().toString(), "addr" to "\"usb\"", *kv))

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        h.post { try { run(c, id, cmd, j) } catch (e: Exception) { Reply.done(c, id, cmd, e.message ?: e.javaClass.simpleName) } }
    }

    private fun run(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        when (cmd) {
            "usbhid.register" -> {
                val d = Args.hex(j.optString("descriptor"), 4096)?.takeIf { it.isNotEmpty() } ?: return Reply.done(c, id, cmd, "descriptor: hex HID report descriptor, up to 4096 bytes")
                if (node != null) return Reply.done(c, id, cmd, null, extra = arrayOf("again" to "true", "node" to node))
                val info = HidDesc.info(d)
                desc.writeBytes(d)
                val sub = j.optInt("subclass", 0); val proto = if (sub and 0x40 != 0) 1 else if (sub and 0x80 != 0) 2 else 0
                val (code, out) = RootSh.run(UsbHidScript.up(desc.absolutePath, if (proto != 0) 1 else 0, proto, info.maxLen.coerceIn(1, 1024)), 25_000)
                val ok = UsbHidScript.parse(out)
                if (code != 0 || ok == null) return Reply.done(c, id, cmd, if (code == -1) "root is not available: ${out.trim()}" else UsbHidScript.error(out))
                node = ok.first; udc = ok.second; ids = info.ids
                if (!openWriter()) { teardown(); return Reply.done(c, id, cmd, "cannot open ${ok.first} as root") }
                startReader()
                rec("app", "registered" to "1", "node" to Json.str(ok.first))
                pollState()
                Reply.done(c, id, cmd, null, extra = arrayOf("node" to node, "udc" to udc, "ids" to ids.toString(), "len" to info.maxLen.toString()))
            }
            "usbhid.unregister" -> { teardown(); Reply.done(c, id, cmd, null) }
            "usbhid.report" -> {
                val o = wout ?: return Reply.done(c, id, cmd, "no USB HID device — usbhid.register first")
                val data = Args.payload(j, 64) ?: return Reply.done(c, id, cmd, "hex or text: up to 64 bytes")
                val rid = j.optInt("id", 0)
                val bytes = if (ids) byteArrayOf(rid.toByte()) + data else data
                frame.writeBytes(bytes)
                try { o.write((UsbHidScript.write(frame.absolutePath) + "\n").toByteArray()); o.flush() }
                catch (e: Exception) { teardown(); return Reply.done(c, id, cmd, "write failed: ${e.message}") }
                Reply.done(c, id, cmd, null)
            }
            "usbhid.list" -> Reply.done(c, id, cmd, null, extra = arrayOf("registered" to (node != null).toString(), "devices" to Json.arr(if (connected) listOf("usb") else emptyList()), "node" to node?.let { Json.str(it) }))
            else -> Reply.done(c, id, cmd, "unknown command", "unknown")
        }
    }

    private fun openWriter(): Boolean = try {
        val p = ProcessBuilder("su").redirectErrorStream(true).start()
        Thread { try { p.inputStream.copyTo(java.io.OutputStream.nullOutputStream()) } catch (e: Exception) {} }.also { it.isDaemon = true; it.start() }
        wout = p.outputStream; writer = p
        wout!!.write("exec 3<>$node\n".toByteArray()); wout!!.flush()
        true
    } catch (e: Exception) { false }

    /** Output-отчёты хоста (светодиоды клавиатуры): чтение /dev/hidgN, первый байт — report id, если в дескрипторе они есть. */
    private fun startReader() {
        val n = node ?: return
        try {
            val p = ProcessBuilder("su", "-c", "cat $n").start(); reader = p
            Thread {
                val buf = ByteArray(128)
                try {
                    while (true) {
                        val k = p.inputStream.read(buf); if (k <= 0) break
                        val b = buf.copyOf(k)
                        h.post { if (ids && b.size > 1) rec("data", "id" to (b[0].toInt() and 0xFF).toString(), "hex" to Json.str(Hex.of(b.copyOfRange(1, b.size))))
                                 else rec("data", "id" to "0", "hex" to Json.str(Hex.of(b))) }
                    }
                } catch (e: Exception) {}
            }.also { it.isDaemon = true; it.start() }
        } catch (e: Exception) {}
    }

    /** Хост подключён, когда UDC в состоянии configured. */
    private fun pollState() {
        if (node == null) return
        val s = try { File("/sys/class/udc/$udc/state").readText().trim() } catch (e: Exception) { RootSh.run("cat /sys/class/udc/$udc/state", 2_000).second.trim() }
        val now = s == "configured"
        if (now != connected) { connected = now; rec(if (now) "connected" else "disconnected") }
        h.postDelayed({ pollState() }, 1500)
    }

    private fun teardown() {
        val was = node != null
        h.removeCallbacksAndMessages(null)
        try { wout?.close() } catch (e: Exception) {}
        writer?.destroy(); reader?.destroy(); writer = null; wout = null; reader = null
        if (was) { RootSh.run(UsbHidScript.down(), 15_000); node = null }
        if (connected) { connected = false; rec("disconnected") }
        if (was) rec("app", "registered" to "0")
    }

    fun held(): Int = if (node != null) 1 else 0
    fun release() { h.post { teardown() } }
    fun close() { h.post { teardown() }; thread.quitSafely() }
}
