package app.dsp.phone

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * L2CAP-каналы LE (CoC, Android 10+): быстрый потоковый канал без GATT. Клиент (l2cap.connect по адресу и PSM) и сервер
 * (l2cap.listen — система выдаёт PSM, он приходит в ответе и записью). До 4 каналов.
 * Записи: {src:'l2cap', ev:'open'|'accept'|'listen'|'data'|'close', addr, psm, hex, text}.
 */
@SuppressLint("MissingPermission")
class L2capHub(private val ctx: Context, private val emit: Emit, private val needs: Needs) {
    private val thread = HandlerThread("dsp-l2cap").also { it.start() }
    private val h = Handler(thread.looper)
    private val socks = ConcurrentHashMap<String, BluetoothSocket>()
    private var server: BluetoothServerSocket? = null

    private fun perms() = if (Build.VERSION.SDK_INT >= 31) listOf(Manifest.permission.BLUETOOTH_CONNECT) else emptyList()

    private fun rec(ev: String, addr: String?, vararg kv: Pair<String, String?>) =
        emit("l2cap", Json.obj("src" to "\"l2cap\"", "ev" to Json.str(ev), "t" to System.currentTimeMillis().toString(), "addr" to addr?.let { Json.str(it) }, *kv))

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        if (Build.VERSION.SDK_INT < 29) return Reply.done(c, id, cmd, "L2CAP channels need Android 10+")
        if (!needs.need(c, id, cmd, perms())) return
        h.post {
            try { run(c, id, cmd, j) } catch (e: SecurityException) { Reply.done(c, id, cmd, "permission: ${e.message}", "permission") }
            catch (e: Exception) { Reply.done(c, id, cmd, e.message ?: e.javaClass.simpleName) }
        }
    }

    private fun run(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        val ad: BluetoothAdapter = (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter?.takeIf { it.isEnabled }
            ?: return Reply.done(c, id, cmd, "Bluetooth is off")
        when (cmd) {
            "l2cap.connect" -> {
                val addr = Args.mac(j.optString("addr")) ?: return Reply.done(c, id, cmd, "bad address")
                val psm = j.optInt("psm", 0); if (!Args.psm(psm)) return Reply.done(c, id, cmd, "psm: 1…65535 (LE dynamic 128…255)")
                if (socks.size >= 4) return Reply.done(c, id, cmd, "4 channels at most")
                socks.remove(addr)?.let { try { it.close() } catch (e: Exception) {} }
                Thread({
                    try {
                        ad.cancelDiscovery()
                        val d = ad.getRemoteDevice(addr)
                        val s = if (j.optBoolean("secure", true)) d.createL2capChannel(psm) else d.createInsecureL2capChannel(psm)
                        s.connect()
                        socks[addr] = s
                        rec("open", addr, "psm" to psm.toString())
                        Reply.done(c, id, cmd, null, extra = arrayOf("addr" to Json.str(addr), "psm" to psm.toString()))
                        pump(addr, s)
                    } catch (e: Exception) { Reply.done(c, id, cmd, "L2CAP: ${e.message}") }
                }, "dsp-l2cap").also { it.isDaemon = true }.start()
            }
            "l2cap.listen" -> {
                try { server?.close() } catch (e: Exception) {}
                val ss = if (j.optBoolean("secure", true)) ad.listenUsingL2capChannel() else ad.listenUsingInsecureL2capChannel()
                server = ss
                val psm = ss.psm
                rec("listen", null, "psm" to psm.toString())
                Thread({
                    try {
                        while (true) {
                            val s = ss.accept()
                            val addr = s.remoteDevice.address
                            socks.remove(addr)?.let { try { it.close() } catch (e: Exception) {} }
                            socks[addr] = s
                            rec("accept", addr, "psm" to psm.toString())
                            Thread({ pump(addr, s) }, "dsp-l2cap-rd").also { it.isDaemon = true }.start()
                        }
                    } catch (e: Exception) { /* сервер закрыт */ }
                }, "dsp-l2cap-srv").also { it.isDaemon = true }.start()
                Reply.done(c, id, cmd, null, extra = arrayOf("psm" to psm.toString()))
            }
            "l2cap.send" -> {
                val addr = Args.mac(j.optString("addr")) ?: return Reply.done(c, id, cmd, "bad address")
                val s = socks[addr] ?: return Reply.done(c, id, cmd, "no channel to $addr — l2cap.connect / l2cap.listen first")
                val data = Args.payload(j, 65535) ?: return Reply.done(c, id, cmd, "hex or text")
                try { s.outputStream.write(data); s.outputStream.flush(); Reply.done(c, id, cmd, null, extra = arrayOf("n" to data.size.toString())) }
                catch (e: Exception) { Reply.done(c, id, cmd, "send: ${e.message}") }
            }
            "l2cap.close" -> {
                val addr = Args.mac(j.optString("addr"))
                if (addr == null) release() else socks.remove(addr)?.let { try { it.close() } catch (e: Exception) {} }
                Reply.done(c, id, cmd, null)
            }
            else -> Reply.done(c, id, cmd, "unknown command", "unknown")
        }
    }

    private fun pump(addr: String, s: BluetoothSocket) {
        val buf = ByteArray(4096)
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

    fun close() { release(); thread.quitSafely() }
}
