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
        val pos = posPairs(gps.recent())
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

/**
 * Микрофон: PCM 16 бит кусками по 20 мс, моно или стерео (micCh: mono / stereo; стерео — один AudioRecord с двумя каналами, отсчёты L и R из одного кадра АЦП, сдвига по времени между микрофонами нет; pcm чередует L,R). Запись: {sr, ch, ms (источник), dev (устройство), rms, peak (dBFS), pcm (base64, little-endian)}.
 * Источник (micSrc): auto (unprocessed, если телефон умеет, иначе mic) / unprocessed / mic / camcorder / voice_recognition / voice_comm / performance;
 * с root («Allow root features») ещё voice_call / downlink / uplink / submix — их открывает помощник RootAudio от root. Частота до 192 кГц
 * (что звуковая подсистема не откроет — ближайшая стандартная, в записи sr — реальная); шумодав / АРУ / эхоподавитель принудительно выключаются;
 * micDev — предпочтительное устройство (usb / wired / bluetooth / builtin). Это обходит обработку звука в WebView / Chrome (getUserMedia).
 */
class MicHub(private val ctx: Context, private val cfg: Config, private val emit: Emit, private val onFail: () -> Unit = {}) {
    private var thread: Thread? = null
    private var key = ""
    @Volatile private var deadKey = ""
    private var proc: Process? = null
    private val fx = ArrayList<android.media.audiofx.AudioEffect>()
    @Volatile private var recNow: AudioRecord? = null       // открытый AudioRecord — чтобы освободить его, даже если поток чтения завис
    @Volatile private var infoJson: String? = null
    private var infoSeq = 0
    @Volatile private var run = false
    @Volatile var lastError = ""

    @Synchronized
    fun update(want: Boolean, hz: Int, srcName: String = "", devName: String = "", low: Boolean = false, ch: Int = 1): Boolean {
        if (!want) { stopLocked(); deadKey = ""; return true }
        val r = MicArgs.rate(hz); val k = "$r|$srcName|$devName|$low|$ch"
        if (key == k && deadKey == k) return false                  // уже не открылось — ждём, пока параметры сменятся
        if (thread != null && key == k) return true
        stopLocked()
        key = k; deadKey = ""
        val src = MicArgs.source(srcName)
        return if (MicArgs.rootOnly(srcName)) startRoot(r, src ?: 4, k, ch) else startNative(r, src, devName, k, low, ch)
    }

    private fun startNative(want: Int, src: Int?, devName: String, k: String, low: Boolean, wantCh: Int): Boolean {
        if (!ctx.granted(android.Manifest.permission.RECORD_AUDIO)) { lastError = "mic: allow Microphone for the DSP app"; return false }
        val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        // auto: «сырой» вход без шумодава и АРУ, если телефон умеет
        val raw = am.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) == "true"
        val first = src ?: if (raw) 9 else 1
        var rec: AudioRecord? = null; var used = want; var usedSrc = first; var usedCh = wantCh
        // стерео: пробуем сперва его (источник, потом частоты); не открылось — моно с пометкой, а не молчаливая подмена
        search@ for (c in listOf(wantCh, 1).distinct()) for (s in listOf(first, 1).distinct()) for (rr in MicArgs.fallbackRates(want)) {
            rec = open(rr, s, low, c)
            if (rec != null) { used = rr; usedSrc = s; usedCh = c; break@search }
        }
        val r = rec ?: run { lastError = "mic: cannot open the microphone (busy, not allowed in the background, or no source for $want Hz)"; return false }
        effectsOff(r)
        val types = MicArgs.deviceTypes(devName)
        var devNote = ""
        if (types.isNotEmpty() || MicArgs.deviceAddr(devName).isNotEmpty()) {
            val devs = am.getDevices(AudioManager.GET_DEVICES_INPUTS)
            val d = MicArgs.pickDevice(devs.map { Triple(it.type, addrOf(it), "${it.productName}") }, devName)?.let { devs[it] }
            if (d != null) r.setPreferredDevice(d) else devNote = "mic: no $devName input found — the default one is used"
        }
        lastError = (if (usedCh != wantCh) "mic: stereo is not available for ${MicArgs.sourceName(usedSrc)} on this phone, mono. " else "") + (if (usedSrc != first) "mic: ${MicArgs.sourceName(first)} is not available, using mic. " else "") + devNote
        run = true; recNow = r; infoJson = null; infoSeq = 0
        thread = Thread({ loop(r, used, MicArgs.chunk(used, low), MicArgs.sourceName(usedSrc), usedCh) }, "dsp-mic").also { it.isDaemon = true; it.start() }
        return true
    }

    private fun open(rate: Int, source: Int, low: Boolean, ch: Int): AudioRecord? {
        val mask = if (ch == 2) AudioFormat.CHANNEL_IN_STEREO else AudioFormat.CHANNEL_IN_MONO
        val min = AudioRecord.getMinBufferSize(rate, mask, AudioFormat.ENCODING_PCM_16BIT)
        if (min <= 0) return null
        return try {
            val rec = AudioRecord.Builder().setAudioSource(source)
                .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate).setChannelMask(mask).build())
                .setBufferSizeInBytes(MicArgs.bufferBytes(min, MicArgs.chunk(rate, low) * ch, low)).build()
            if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); null } else rec
        } catch (e: Exception) { null }
    }

    /** Шумодав, АРУ и эхоподавитель на входе — выключить (на части телефонов они включены по умолчанию даже для MIC). */
    private fun effectsOff(rec: AudioRecord) {
        val id = rec.audioSessionId
        try { if (android.media.audiofx.NoiseSuppressor.isAvailable()) android.media.audiofx.NoiseSuppressor.create(id)?.let { it.enabled = false; fx.add(it) } } catch (e: Exception) { }
        try { if (android.media.audiofx.AutomaticGainControl.isAvailable()) android.media.audiofx.AutomaticGainControl.create(id)?.let { it.enabled = false; fx.add(it) } } catch (e: Exception) { }
        try { if (android.media.audiofx.AcousticEchoCanceler.isAvailable()) android.media.audiofx.AcousticEchoCanceler.create(id)?.let { it.enabled = false; fx.add(it) } } catch (e: Exception) { }
    }

    private fun startRoot(r: Int, src: Int, k: String, ch: Int): Boolean {
        if (!cfg.sniffer) { lastError = "mic: the source ${MicArgs.sourceName(src)} needs root — turn on «Allow root features» in the app Settings"; return false }
        val p = try { ProcessBuilder("su", "-c", "CLASSPATH=${ctx.applicationInfo.sourceDir} app_process /system/bin app.dsp.phone.RootAudio $src $r $ch").start() }
        catch (e: Exception) { lastError = "mic: su: ${e.message}"; return false }
        proc = p; run = true; lastError = ""
        val name = MicArgs.sourceName(src)
        Thread({ try { p.errorStream.bufferedReader().forEachLine { if (it.startsWith("ERR")) fail(k, "mic (root, $name): " + it.removePrefix("ERR:").trim()) } } catch (e: Exception) { } }, "dsp-mic-err").also { it.isDaemon = true; it.start() }
        thread = Thread({ pump(p.inputStream, r, MicArgs.chunk(r), name, "root", k, ch) }, "dsp-mic").also { it.isDaemon = true; it.start() }
        return true
    }

    /** AudioDeviceInfo.address — с Android 9; на 8 адреса нет. */
    private fun addrOf(d: android.media.AudioDeviceInfo): String = if (android.os.Build.VERSION.SDK_INT >= 28) d.address ?: "" else ""

    private fun fail(k: String, msg: String) { lastError = msg; deadKey = k; run = false; onFail() }

    private fun stopLocked() {
        run = false
        proc?.let { p -> try { p.destroy() } catch (e: Exception) { }; Thread { RootSh.run("pkill -f app.dsp.phone.RootAudio", 3000) }.also { it.isDaemon = true; it.start() } }
        proc = null
        thread?.join(500)
        // поток не вышел (завис в read) — освобождаем вход сами: иначе микрофон и эффекты остаются занятыми до конца процесса
        recNow?.let { r -> if (thread?.isAlive == true) { try { r.stop() } catch (e: Exception) { }; try { r.release() } catch (e: Exception) { } } }
        recNow = null; infoJson = null; thread = null; key = ""
        for (e in fx) try { e.release() } catch (x: Exception) { }
        fx.clear()
    }

    fun close() = update(false, 0).let { }

    /** Порции PCM 16 бит из потока (root-помощник) → записи mic. */
    private fun pump(ins: InputStream, sr: Int, chunk: Int, name: String, dev: String, k: String, ch: Int) {
        val b = ByteArray(chunk * 2 * ch)
        try {
            while (run) {
                var n = 0
                while (n < b.size && run) { val c = ins.read(b, n, b.size - n); if (c < 0) { if (run) fail(k, lastError.ifEmpty { "mic (root): the helper stopped" }); return }; n += c }
                if (n < b.size) break
                emitChunk(b, chunk, sr, name, dev, ch)
            }
        } catch (e: Exception) { if (run) fail(k, "mic: ${e.message}") }
    }

    /** chunk — кадров (в кадре по отсчёту на канал, каналы чередуются L,R); rms / peak — по всем отсчётам. */
    private fun emitChunk(b: ByteArray, chunk: Int, sr: Int, name: String, dev: String, ch: Int) {
        var sum = 0.0; var peak = 0
        for (i in 0 until chunk * ch) {
            val v = ((b[2 * i + 1].toInt() shl 8) or (b[2 * i].toInt() and 0xff)).toShort().toInt()
            sum += v.toDouble() * v; if (Math.abs(v) > peak) peak = Math.abs(v)
        }
        val n = chunk * ch
        val t = System.currentTimeMillis() - chunk * 1000L / sr
        emit("mic", Json.obj(
            "src" to "\"mic\"", "t" to t.toString(), "sr" to sr.toString(), "ch" to ch.toString(), "ms" to Json.str(name), "dev" to Json.str(dev),
            "rms" to Json.num(Audio.dbfs(Math.sqrt(sum / n)), 100.0), "peak" to Json.num(Audio.dbfs(peak.toDouble()), 100.0),
            "pcm" to "\"" + Base64.encodeToString(b, Base64.NO_WRAP) + "\"",
            "info" to infoJson?.takeIf { infoSeq++ % 100 == 0 },        // описание микрофонов — с первой порцией и раз в ~2 с (страница может подключиться позже)
        ))
    }

    /**
     * Что телефон говорит о своих микрофонах: {devs: устройства ввода (id, тип, адрес, имя), mics: [{id, desc, addr, loc, grp, idx, pos, dir, ch}]}.
     * mics — активные микрофоны этой записи (Android 10+, ch — какой канал записи какому микрофону соответствует: [канал, 1 = прямой / 2 = обработанный]),
     * а если их не вернули — все микрофоны телефона (Android 9+). pos / dir — координаты (м) и направление в системе телефона.
     */
    @android.annotation.TargetApi(28)
    private fun micInfo(rec: AudioRecord): String? = try {
        if (android.os.Build.VERSION.SDK_INT < 28) throw UnsupportedOperationException()
        val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val devs = am.getDevices(AudioManager.GET_DEVICES_INPUTS).map { Json.obj("id" to it.id.toString(), "type" to it.type.toString(), "addr" to Json.str(addrOf(it)), "name" to Json.str("${it.productName}")) }
        var mics: List<android.media.MicrophoneInfo> = emptyList(); var active = false
        if (android.os.Build.VERSION.SDK_INT >= 29) try { mics = rec.activeMicrophones; active = mics.isNotEmpty() } catch (e: Exception) { }
        if (mics.isEmpty() && android.os.Build.VERSION.SDK_INT >= 28) try { mics = am.microphones } catch (e: Exception) { }
        val ms = mics.map { m ->
            val p = m.position; val o = m.orientation
            Json.obj("id" to Json.str(m.id.toString()), "desc" to Json.str(m.description), "addr" to Json.str(m.address), "loc" to m.location.toString(), "grp" to m.group.toString(), "idx" to m.indexInTheGroup.toString(),
                "pos" to "[${Json.num(p.x.toDouble(), 1e4)},${Json.num(p.y.toDouble(), 1e4)},${Json.num(p.z.toDouble(), 1e4)}]", "dir" to "[${Json.num(o.x.toDouble(), 1e3)},${Json.num(o.y.toDouble(), 1e3)},${Json.num(o.z.toDouble(), 1e3)}]",
                "ch" to m.channelMapping.joinToString(",", "[", "]") { "[${it.first},${it.second}]" })
        }
        Json.obj("devs" to Json.rows(devs), "mics" to Json.rows(ms), "active" to active.toString())
    } catch (e: Exception) { null }

    private fun loop(rec: AudioRecord, sr: Int, chunk: Int, name: String, ch: Int) {
        val ns = chunk * ch; val s = ShortArray(ns); val b = ByteArray(ns * 2)
        try {
            rec.startRecording()
            infoJson = micInfo(rec)
            val dev = rec.routedDevice?.let { "${it.productName}".ifEmpty { "type${it.type}" } } ?: ""
            while (run) {
                var n = 0
                while (n < ns && run) { val k = rec.read(s, n, ns - n); if (k <= 0) { lastError = "mic: read error ($k)"; return }; n += k }
                if (n < ns) break
                for (i in 0 until ns) { val v = s[i].toInt(); b[2 * i] = v.toByte(); b[2 * i + 1] = (v shr 8).toByte() }
                emitChunk(b, chunk, sr, name, dev, ch)
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
            val rt = if (link == 127) Radiotap.parse(d) else null                           // кадр из монитор-режима: radiotap + 802.11
            val body = rt?.let { d.copyOfRange(it.len, d.size - (if (it.fcs && d.size - it.len >= 4) 4 else 0)) }
            val w = body?.let { Dot11.parse(it) }
            emit("pkt", Json.obj(
                "src" to "\"pkt\"", "t" to ms.toString(), "iface" to Json.str(iface), "link" to Json.str(h.link), "len" to orig.toString(), "cap" to d.size.toString(),
                "smac" to (h.srcMac ?: w?.a2)?.let { Json.str(it) }, "dmac" to (h.dstMac ?: w?.a1)?.let { Json.str(it) },
                "ethtype" to if (h.ethType != 0) Json.str(String.format("%04x", h.ethType)) else null, "if" to if (h.ifIndex != 0) h.ifIndex.toString() else null,
                "ip" to h.src?.let { Json.str(it) }, "dip" to h.dst?.let { Json.str(it) }, "proto" to if (h.ver != 0) h.proto.toString() else null,
                "sport" to if (h.sport != 0) h.sport.toString() else null, "dport" to if (h.dport != 0) h.dport.toString() else null,
                "hex" to Json.str(Hex.of(d)),
                "freq" to rt?.takeIf { it.freq > 0 }?.freq?.toString(), "ch" to rt?.let { Radiotap.channel(it.freq) }?.takeIf { it > 0 }?.toString(),
                "rssi" to rt?.signal?.toString(), "rate" to rt?.rateKbps?.let { Json.num(it / 1000.0, 10.0) }, "dot11" to body?.let { Json.str(Hex.of(it)) },
                "ftype" to w?.let { Json.str(it.typeName) }, "fsub" to w?.subtype?.toString(),
                "a1" to w?.a1?.let { Json.str(it) }, "a2" to w?.a2?.let { Json.str(it) }, "a3" to w?.a3?.let { Json.str(it) }, "bssid" to w?.bssid?.let { Json.str(it) },
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
