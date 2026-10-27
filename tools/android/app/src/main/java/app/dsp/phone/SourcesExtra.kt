package app.dsp.phone

import android.content.Context
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.telephony.CellInfo
import android.telephony.CellInfoCdma
import android.telephony.CellInfoGsm
import android.telephony.CellInfoLte
import android.telephony.CellInfoNr
import android.telephony.CellInfoWcdma
import android.telephony.CellIdentityNr
import android.telephony.CellSignalStrengthNr
import android.telephony.TelephonyManager
import android.util.Base64
import java.io.InputStream
import java.util.concurrent.Executor

private const val NA = Int.MAX_VALUE        // CellInfo.UNAVAILABLE
private fun Int.ok(): String? = if (this == NA) null else toString()

/** Соты: опрос TelephonyManager раз в N секунд; записи несут последнее положение. Нужна геолокация. */
class CellHub(private val ctx: Context, private val gps: GpsHub, private val emit: Emit) {
    private val tm = ctx.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
    private val thread = HandlerThread("dsp-cell").also { it.start() }
    private val handler = Handler(thread.looper)
    private var on = false
    private var every = 5
    @Volatile var lastError = ""

    private val tick = object : Runnable {
        override fun run() {
            if (!on) return
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    tm.requestCellInfoUpdate(Executor { handler.post(it) }, object : TelephonyManager.CellInfoCallback() {
                        override fun onCellInfo(l: MutableList<CellInfo>) = report(l)
                        override fun onError(code: Int, e: Throwable?) { lastError = "cell: update failed ($code)"; fallback() }
                    })
                } else fallback()
            } catch (e: SecurityException) { lastError = "cell: allow Location for the DSP app" }
            handler.postDelayed(this, every * 1000L)
        }
    }

    @Suppress("DEPRECATION", "MissingPermission")
    private fun fallback() { try { report(tm.allCellInfo ?: return) } catch (e: SecurityException) { lastError = "cell: allow Location for the DSP app" } }

    @Synchronized
    fun update(want: Boolean, everySec: Int): Boolean {
        every = everySec.coerceIn(1, 600)
        if (want == on) return true
        if (!want) { on = false; handler.removeCallbacksAndMessages(null); return true }
        if (!ctx.hasLocation()) { lastError = "cell: allow Location for the DSP app"; return false }
        on = true; handler.post(tick)
        return true
    }

    fun close() { update(false, every); thread.quitSafely() }

    private fun report(list: List<CellInfo>) {
        val f = gps.recent()
        val pos = arrayOf(
            "lat" to f?.let { Json.num(it.latitude, 1e7) }, "lon" to f?.let { Json.num(it.longitude, 1e7) },
            "acc" to f?.takeIf { it.hasAccuracy() }?.let { Json.num(it.accuracy.toDouble(), 10.0) },
        )
        for (c in list) record(c)?.let { emit("cell", Json.obj(*(it + pos))) }
    }

    @Suppress("DEPRECATION")
    private fun record(c: CellInfo): Array<Pair<String, String?>>? {
        val reg = "reg" to if (c.isRegistered) "1" else "0"
        val src = "src" to "\"cell\""
        return when {
            c is CellInfoLte -> {
                val i = c.cellIdentity; val s = c.cellSignalStrength
                arrayOf(src, "type" to "\"LTE\"", reg, "mcc" to i.mccString?.let { Json.str(it) }, "mnc" to i.mncString?.let { Json.str(it) },
                    "cid" to i.ci.ok(), "pci" to i.pci.ok(), "tac" to i.tac.ok(), "arfcn" to i.earfcn.ok(),
                    "band" to if (Build.VERSION.SDK_INT >= 30) i.bands.joinToString(",").ifEmpty { null }?.let { Json.str(it) } else null,
                    "bw" to i.bandwidth.ok(), "rsrp" to s.rsrp.ok(), "rsrq" to s.rsrq.ok(), "sinr" to s.rssnr.ok(), "cqi" to s.cqi.ok(), "ta" to s.timingAdvance.ok(),
                    "rssi" to if (Build.VERSION.SDK_INT >= 29) s.rssi.ok() else null, "dbm" to s.dbm.ok(), "lvl" to s.level.toString())
            }
            Build.VERSION.SDK_INT >= 29 && c is CellInfoNr -> {
                val i = c.cellIdentity as CellIdentityNr; val s = c.cellSignalStrength as CellSignalStrengthNr
                arrayOf(src, "type" to "\"NR\"", reg, "mcc" to i.mccString?.let { Json.str(it) }, "mnc" to i.mncString?.let { Json.str(it) },
                    "cid" to i.nci.takeIf { it != Long.MAX_VALUE }?.toString(), "pci" to i.pci.ok(), "tac" to i.tac.ok(), "arfcn" to i.nrarfcn.ok(),
                    "band" to if (Build.VERSION.SDK_INT >= 30) i.bands.joinToString(",").ifEmpty { null }?.let { Json.str(it) } else null,
                    "rsrp" to s.ssRsrp.ok(), "rsrq" to s.ssRsrq.ok(), "sinr" to s.ssSinr.ok(), "dbm" to s.dbm.ok(), "lvl" to s.level.toString())
            }
            c is CellInfoGsm -> {
                val i = c.cellIdentity; val s = c.cellSignalStrength
                arrayOf(src, "type" to "\"GSM\"", reg, "mcc" to i.mccString?.let { Json.str(it) }, "mnc" to i.mncString?.let { Json.str(it) },
                    "cid" to i.cid.ok(), "lac" to i.lac.ok(), "arfcn" to i.arfcn.ok(), "bsic" to i.bsic.ok(), "ta" to s.timingAdvance.ok(), "dbm" to s.dbm.ok(), "lvl" to s.level.toString())
            }
            c is CellInfoWcdma -> {
                val i = c.cellIdentity; val s = c.cellSignalStrength
                arrayOf(src, "type" to "\"WCDMA\"", reg, "mcc" to i.mccString?.let { Json.str(it) }, "mnc" to i.mncString?.let { Json.str(it) },
                    "cid" to i.cid.ok(), "lac" to i.lac.ok(), "psc" to i.psc.ok(), "arfcn" to i.uarfcn.ok(), "dbm" to s.dbm.ok(), "lvl" to s.level.toString())
            }
            c is CellInfoCdma -> {
                val i = c.cellIdentity; val s = c.cellSignalStrength
                arrayOf(src, "type" to "\"CDMA\"", reg, "sid" to i.systemId.ok(), "nid" to i.networkId.ok(), "bid" to i.basestationId.ok(), "dbm" to s.dbm.ok(), "lvl" to s.level.toString())
            }
            else -> null
        }
    }
}

/** Микрофон: PCM 16 бит моно кусками по 20 мс. Запись: {sr, rms, peak (dBFS), pcm (base64, little-endian)}. */
class MicHub(private val ctx: Context, private val emit: Emit) {
    private var thread: Thread? = null
    private var rate = 0
    @Volatile private var run = false
    @Volatile var lastError = ""

    @Synchronized
    fun update(want: Boolean, hz: Int): Boolean {
        val r = hz.coerceIn(8000, 48000)
        if (!want) { stopLocked(); return true }
        if (thread != null && rate == r) return true
        stopLocked()
        if (!ctx.granted(android.Manifest.permission.RECORD_AUDIO)) { lastError = "mic: allow Microphone for the DSP app"; return false }
        val min = AudioRecord.getMinBufferSize(r, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (min <= 0) { lastError = "mic: $r Hz is not supported"; return false }
        val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        // «сырой» вход без шумодава и АРУ, если телефон умеет
        val raw = am.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) == "true"
        val chunk = r / 50
        val rec = try {
            AudioRecord(if (raw) MediaRecorder.AudioSource.UNPROCESSED else MediaRecorder.AudioSource.MIC, r,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, chunk * 2 * 8))
        } catch (e: Exception) { lastError = "mic: ${e.message}"; return false }
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); lastError = "mic: cannot open the microphone (busy or not allowed in the background)"; return false }
        rate = r; run = true
        thread = Thread({ loop(rec, r, chunk) }, "dsp-mic").also { it.isDaemon = true; it.start() }
        return true
    }

    private fun stopLocked() { run = false; thread?.join(500); thread = null; rate = 0 }

    fun close() = update(false, 0).let { }

    private fun loop(rec: AudioRecord, sr: Int, chunk: Int) {
        val s = ShortArray(chunk)
        try {
            rec.startRecording()
            while (run) {
                var n = 0
                while (n < chunk && run) { val k = rec.read(s, n, chunk - n); if (k <= 0) { lastError = "mic: read error ($k)"; return }; n += k }
                if (n < chunk) break
                var sum = 0.0; var peak = 0
                val b = ByteArray(chunk * 2)
                for (i in 0 until chunk) {
                    val v = s[i].toInt(); sum += v.toDouble() * v; if (Math.abs(v) > peak) peak = Math.abs(v)
                    b[2 * i] = v.toByte(); b[2 * i + 1] = (v shr 8).toByte()
                }
                val t = System.currentTimeMillis() - chunk * 1000L / sr
                emit("mic", Json.obj(
                    "src" to "\"mic\"", "t" to t.toString(), "sr" to sr.toString(),
                    "rms" to Json.num(Audio.dbfs(Math.sqrt(sum / chunk)), 100.0), "peak" to Json.num(Audio.dbfs(peak.toDouble()), 100.0),
                    "pcm" to "\"" + Base64.encodeToString(b, Base64.NO_WRAP) + "\"",
                ))
            }
        } catch (e: Exception) { lastError = "mic: ${e.message}" }
        finally { try { rec.stop() } catch (e: Exception) {}; rec.release() }
    }
}

object Audio {
    /** Уровень относительно полной шкалы 16 бит, дБ (тишина — −120). */
    fun dbfs(v: Double): Double = if (v < 1.0) -120.0 else 20 * Math.log10(v / 32768.0)
}

/**
 * Перехват пакетов — только с root: `su -c tcpdump … -w -`, поток pcap разбирается в записи {src:'pkt'} с кадром в hex.
 * Без root Android не даёт сырых сокетов приложениям. Включается в настройках (Config.sniffer).
 */
class SnifferHub(private val cfg: Config, private val emit: Emit, private val note: (String, String) -> Unit) {
    private var proc: Process? = null
    private var key = ""
    private var thread: Thread? = null
    @Volatile var lastError = ""

    companion object {
        private val BINS = "tcpdump /data/data/com.termux/files/usr/bin/tcpdump /system/xbin/tcpdump /system/bin/tcpdump /data/local/tmp/tcpdump"

        /** Оболочка root: ищет tcpdump и запускает. iface и filter заранее проверены (Perms) — в кавычки попадает только безопасный набор. */
        fun script(iface: String, snap: Int, filter: String): String =
            "for B in $BINS; do command -v \$B >/dev/null 2>&1 && exec \$B -i $iface -U -n -s $snap -w - '$filter'; done; echo 'tcpdump not found' >&2; exit 127"
    }

    /** false — выключено в настройках или параметры не прошли проверку. */
    @Synchronized
    fun update(want: Boolean, iface: String, filter: String, snap: Int): Boolean {
        val i = Perms.iface(iface); val f = Perms.filter(filter)
        val k = if (want) "$i|$f|$snap" else ""
        if (k == key && (!want || thread?.isAlive == true)) return true
        stopLocked()
        if (!want) return true
        if (!cfg.sniffer) { lastError = "pkt: packet capture is off — enable it in the app Settings (needs root)"; return false }
        if (i == null || f == null) { lastError = "pkt: bad interface or filter"; return false }
        key = k
        val p = try { ProcessBuilder("su", "-c", script(i, snap.coerceIn(64, 65535), f)).start() }
        catch (e: Exception) { key = ""; lastError = "pkt: no root (su): ${e.message}"; return false }
        proc = p
        thread = Thread({ pump(p, i, snap) }, "dsp-pkt").also { it.isDaemon = true; it.start() }
        Thread({ err(p.errorStream) }, "dsp-pkt-err").also { it.isDaemon = true; it.start() }
        return true
    }

    private fun err(s: InputStream) {
        try { s.bufferedReader().useLines { for (l in it) if (l.isNotBlank() && !l.startsWith("tcpdump: listening") && !l.startsWith("tcpdump: data link")) note("warn", "pkt: " + l.take(200)) } }
        catch (e: Exception) {}
    }

    private fun pump(p: Process, iface: String, snap: Int) {
        val rd = PcapReader { ms, link, orig, d ->
            val h = Frame.parse(link, d)
            emit("pkt", Json.obj(
                "src" to "\"pkt\"", "t" to ms.toString(), "iface" to Json.str(iface), "link" to Json.str(h.link), "len" to orig.toString(), "cap" to d.size.toString(),
                "smac" to h.srcMac?.let { Json.str(it) }, "dmac" to h.dstMac?.let { Json.str(it) },
                "ethtype" to if (h.ethType != 0) Json.str(String.format("%04x", h.ethType)) else null, "if" to if (h.ifIndex != 0) h.ifIndex.toString() else null,
                "ip" to h.src?.let { Json.str(it) }, "dip" to h.dst?.let { Json.str(it) }, "proto" to if (h.ver != 0) h.proto.toString() else null,
                "sport" to if (h.sport != 0) h.sport.toString() else null, "dport" to if (h.dport != 0) h.dport.toString() else null,
                "hex" to Json.str(Hex.of(d)),
            ))
        }
        val buf = ByteArray(32768)
        try {
            val inp = p.inputStream
            while (true) {
                val n = inp.read(buf)
                if (n < 0) break
                rd.feed(buf, n)
                if (!rd.valid) { note("error", "pkt: the output is not pcap (su refused or this is not tcpdump)"); break }
            }
        } catch (e: Exception) {}
        p.destroy()
    }

    private fun stopLocked() {
        proc?.destroy(); proc = null; thread = null; key = ""
    }

    fun close() = synchronized(this) { stopLocked() }
}
