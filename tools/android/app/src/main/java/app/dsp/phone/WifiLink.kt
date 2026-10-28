package app.dsp.phone

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.ScanResult
import android.net.wifi.WifiManager
import android.net.wifi.aware.AttachCallback
import android.net.wifi.aware.DiscoverySessionCallback
import android.net.wifi.aware.PeerHandle
import android.net.wifi.aware.PublishConfig
import android.net.wifi.aware.PublishDiscoverySession
import android.net.wifi.aware.SubscribeConfig
import android.net.wifi.aware.SubscribeDiscoverySession
import android.net.wifi.aware.WifiAwareManager
import android.net.wifi.aware.WifiAwareSession
import android.net.wifi.aware.DiscoverySession
import android.net.wifi.rtt.RangingRequest
import android.net.wifi.rtt.RangingResult
import android.net.wifi.rtt.RangingResultCallback
import android.net.wifi.rtt.WifiRttManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import org.json.JSONArray
import org.json.JSONObject

/** Разбор имён и адресов для NSD / RTT / Aware (чистая логика — проверяется на JVM). */
object WifiArgs {
    private val NSD_TYPE = Regex("_[A-Za-z0-9][A-Za-z0-9-]{0,14}\\._(tcp|udp)")
    private val AWARE_NAME = Regex("[A-Za-z0-9_.-]{1,255}")

    /** «_http._tcp» (точка в конце и подтипы отбрасываются); null — не тип службы DNS-SD. */
    fun nsdType(s: String?): String? {
        val t = (s ?: return null).trim().trimEnd('.').substringBefore(",")
        return t.takeIf { NSD_TYPE.matches(it) }
    }

    /** Имя экземпляра службы: непустое, до 63 байт UTF-8, без управляющих символов. */
    fun nsdName(s: String?): String? = s?.trim()?.takeIf { it.isNotEmpty() && it.toByteArray(Charsets.UTF_8).size <= 63 && it.none { c -> c.isISOControl() } }

    /** Имя службы Wi-Fi Aware: буквы, цифры, «_», «.», «-». */
    fun awareName(s: String?): String? = s?.trim()?.takeIf { AWARE_NAME.matches(it) }

    /** Список BSSID из JSON: строки «AA:BB:…» (или «aa-bb-…»), неверные — отказ целиком; до max штук. */
    fun macList(a: JSONArray?, max: Int): List<String>? {
        if (a == null) return emptyList()
        if (a.length() > max) return null
        val out = ArrayList<String>()
        for (i in 0 until a.length()) out.add(Args.mac(a.optString(i).replace('-', ':')) ?: return null)
        return out
    }

    /** Миллиметры RTT → метры с точностью до мм. */
    fun metres(mm: Int): Double = Math.round(mm.toDouble()) / 1000.0
}

/**
 * Сетевое радио, которого нет в браузере: DNS-SD / mDNS (nsd.discover, nsd.register), Wi-Fi RTT — расстояние до точек доступа
 * 802.11mc (wifi.rtt), Wi-Fi Aware (NAN) — обнаружение соседей без точки доступа и сообщения между ними (aware.*).
 * Записи идут в источник net: {src:'net', ev:'nsd'|'rtt'|'aware', …}.
 */
@SuppressLint("MissingPermission")
class WifiLinkHub(private val ctx: Context, private val emit: Emit, private val needs: Needs) {
    private val thread = HandlerThread("dsp-wifilink").also { it.start() }
    private val h = Handler(thread.looper)
    private val appCtx = ctx.applicationContext

    private fun rec(ev: String, vararg kv: Pair<String, String?>) =
        emit("net", Json.obj("src" to "\"net\"", "ev" to Json.str(ev), "t" to System.currentTimeMillis().toString(), *kv))

    private fun radioPerms() = listOf(if (Build.VERSION.SDK_INT >= 33) "android.permission.NEARBY_WIFI_DEVICES" else android.Manifest.permission.ACCESS_FINE_LOCATION)

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        if ((cmd == "wifi.rtt" || cmd.startsWith("aware.")) && !needs.need(c, id, cmd, radioPerms())) return
        h.post {
            try { run(c, id, cmd, j) } catch (e: SecurityException) { Reply.done(c, id, cmd, "permission: ${e.message}", "permission") }
            catch (e: Exception) { Reply.done(c, id, cmd, e.message ?: e.javaClass.simpleName) }
        }
    }

    private fun run(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        when (cmd) {
            "nsd.discover" -> nsdDiscover(c, id, cmd, j)
            "nsd.stop" -> { nsdStop(); Reply.done(c, id, cmd, null) }
            "nsd.register" -> nsdRegister(c, id, cmd, j)
            "nsd.unregister" -> { nsdUnregister(); Reply.done(c, id, cmd, null) }
            "wifi.rtt" -> rtt(c, id, cmd, j)
            "aware.publish", "aware.subscribe" -> awareStart(c, id, cmd, j)
            "aware.send" -> awareSend(c, id, cmd, j)
            "aware.stop" -> { awareStop(); Reply.done(c, id, cmd, null) }
            else -> Reply.done(c, id, cmd, "unknown command", "unknown")
        }
    }

    // ---------- DNS-SD ----------

    private val nsd by lazy { appCtx.getSystemService(Context.NSD_SERVICE) as NsdManager }
    private var disco: NsdManager.DiscoveryListener? = null
    private var regL: NsdManager.RegistrationListener? = null
    private val resolveQ = ArrayDeque<NsdServiceInfo>()
    private var resolving = false

    private fun nsdStop() {
        disco?.let { try { nsd.stopServiceDiscovery(it) } catch (e: Exception) {} }; disco = null
        resolveQ.clear(); resolving = false
    }

    private fun nsdUnregister() { regL?.let { try { nsd.unregisterService(it) } catch (e: Exception) {} }; regL = null }

    private fun nsdKv(i: NsdServiceInfo, kind: String): Array<Pair<String, String?>> {
        val kv = ArrayList<Pair<String, String?>>()
        kv.add("kind" to Json.str(kind)); kv.add("name" to Json.str(i.serviceName)); kv.add("type" to Json.str(i.serviceType?.trim('.')))
        if (kind == "resolved") {
            @Suppress("DEPRECATION") val host = i.host
            host?.hostAddress?.let { kv.add("host" to Json.str(it)) }
            kv.add("port" to i.port.toString())
            val a = i.attributes
            if (a != null && a.isNotEmpty()) kv.add("txt" to Json.map(a.entries.associate { it.key to String(it.value ?: ByteArray(0), Charsets.UTF_8) }))
        }
        return kv.toTypedArray()
    }

    private fun nsdDiscover(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        val type = WifiArgs.nsdType(j.optString("type")) ?: return Reply.done(c, id, cmd, "type: _http._tcp")
        nsdStop()
        val resolve = j.optBoolean("resolve", true)
        var answered = false
        val l = object : NsdManager.DiscoveryListener {
            override fun onStartDiscoveryFailed(t: String, code: Int) { h.post { disco = null; if (!answered) { answered = true; Reply.done(c, id, cmd, "discovery failed (code $code)") } } }
            override fun onStopDiscoveryFailed(t: String, code: Int) {}
            override fun onDiscoveryStarted(t: String) { h.post { if (!answered) { answered = true; Reply.done(c, id, cmd, null, extra = arrayOf("type" to Json.str(type))) } } }
            override fun onDiscoveryStopped(t: String) {}
            override fun onServiceFound(i: NsdServiceInfo) { h.post { rec("nsd", *nsdKv(i, "found")); if (resolve) { resolveQ.addLast(i); pumpResolve() } } }
            override fun onServiceLost(i: NsdServiceInfo) { h.post { rec("nsd", *nsdKv(i, "lost")) } }
        }
        disco = l
        nsd.discoverServices("$type.", NsdManager.PROTOCOL_DNS_SD, l)
        val t = j.optInt("timeout", 0).coerceIn(0, 3_600_000)
        if (t > 0) h.postDelayed({ if (disco === l) nsdStop() }, t.toLong())
    }

    /** Android разрешает одно разрешение имени за раз. */
    @Suppress("DEPRECATION")
    private fun pumpResolve() {
        if (resolving) return
        val i = resolveQ.removeFirstOrNull() ?: return
        resolving = true
        val done = Runnable { resolving = false; pumpResolve() }
        try {
            nsd.resolveService(i, object : NsdManager.ResolveListener {
                override fun onResolveFailed(s: NsdServiceInfo, code: Int) { h.post { rec("nsd", *nsdKv(s, "resolve failed"), "code" to code.toString()); done.run() } }
                override fun onServiceResolved(s: NsdServiceInfo) { h.post { rec("nsd", *nsdKv(s, "resolved")); done.run() } }
            })
        } catch (e: Exception) { done.run() }
        h.postDelayed({ if (resolving) { resolving = false; pumpResolve() } }, 8_000)
    }

    private fun nsdRegister(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        val type = WifiArgs.nsdType(j.optString("type")) ?: return Reply.done(c, id, cmd, "type: _http._tcp")
        val name = WifiArgs.nsdName(j.optString("name", "DSP")) ?: return Reply.done(c, id, cmd, "name: 1…63 bytes")
        val port = j.optInt("port"); if (!Args.port(port)) return Reply.done(c, id, cmd, "port: 1…65535")
        nsdUnregister()
        val info = NsdServiceInfo().also { it.serviceName = name; it.serviceType = type; it.port = port }
        j.optJSONObject("txt")?.let { o -> for (k in o.keys()) if (k.isNotEmpty() && k.length <= 9 && !k.contains('=')) info.setAttribute(k, o.optString(k).take(200)) }
        val l = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(i: NsdServiceInfo) { h.post { Reply.done(c, id, cmd, null, extra = arrayOf("name" to Json.str(i.serviceName), "type" to Json.str(type), "port" to port.toString())) } }
            override fun onRegistrationFailed(i: NsdServiceInfo, code: Int) { h.post { regL = null; Reply.done(c, id, cmd, "registration failed (code $code)") } }
            override fun onServiceUnregistered(i: NsdServiceInfo) {}
            override fun onUnregistrationFailed(i: NsdServiceInfo, code: Int) {}
        }
        regL = l
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, l)
    }

    // ---------- Wi-Fi RTT ----------

    private fun rtt(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        if (Build.VERSION.SDK_INT < 28 || !appCtx.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_RTT)) return Reply.done(c, id, cmd, "this phone has no Wi-Fi RTT")
        val mgr = appCtx.getSystemService(Context.WIFI_RTT_RANGING_SERVICE) as? WifiRttManager ?: return Reply.done(c, id, cmd, "this phone has no Wi-Fi RTT")
        if (!mgr.isAvailable) return Reply.done(c, id, cmd, "Wi-Fi RTT is off — turn Wi-Fi and Location on")
        val want = WifiArgs.macList(j.optJSONArray("bssids"), 64) ?: return Reply.done(c, id, cmd, "bssids: AA:BB:CC:DD:EE:FF, up to 64")
        val wm = appCtx.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val seen = wm.scanResults.filter { it.is80211mcResponder }
        val pick: List<ScanResult> = (if (want.isEmpty()) seen.sortedByDescending { it.level } else seen.filter { it.BSSID.uppercase() in want })
            .take(minOf(RangingRequest.getMaxPeers(), j.optInt("max", 10).coerceIn(1, 20)))
        if (pick.isEmpty()) return Reply.done(c, id, cmd, if (want.isEmpty()) "no 802.11mc access points in the last scan — enable the wifi source and wait for a scan" else "none of those BSSIDs is a known 802.11mc responder (scan first)")
        val names = pick.associate { it.BSSID.uppercase() to it.SSID }
        val req = RangingRequest.Builder().addAccessPoints(pick).build()
        val count = j.optInt("count", 1).coerceIn(1, 50); val every = j.optLong("every", 1_000).coerceIn(500, 60_000)
        Reply.done(c, id, cmd, null, extra = arrayOf("aps" to pick.size.toString(), "count" to count.toString()))
        fun once(left: Int) {
            mgr.startRanging(req, { r -> h.post(r) }, object : RangingResultCallback() {
                override fun onRangingFailure(code: Int) { rec("rtt", "ok" to "false", "code" to code.toString(), "msg" to Json.str(if (code == RangingResultCallback.STATUS_CODE_FAIL_RTT_NOT_AVAILABLE) "RTT not available" else "ranging failed ($code)")); next(left) }
                override fun onRangingResults(l: List<RangingResult>) {
                    for (r in l) {
                        val mac = (if (r.macAddress != null) r.macAddress.toString() else "").uppercase()
                        val ok = r.status == RangingResult.STATUS_SUCCESS
                        rec("rtt", "bssid" to Json.str(mac), "ssid" to names[mac]?.let { Json.str(it) }, "ok" to ok.toString(), "status" to r.status.toString(),
                            "dist" to if (ok) Json.num(WifiArgs.metres(r.distanceMm), 1000.0) else null, "std" to if (ok) Json.num(WifiArgs.metres(r.distanceStdDevMm), 1000.0) else null,
                            "rssi" to if (ok) r.rssi.toString() else null, "tried" to if (ok) r.numAttemptedMeasurements.toString() else null, "good" to if (ok) r.numSuccessfulMeasurements.toString() else null)
                    }
                    next(left)
                }
                fun next(left: Int) { if (left > 1) h.postDelayed({ once(left - 1) }, every) }
            })
        }
        once(count)
    }

    // ---------- Wi-Fi Aware ----------

    private var aware: WifiAwareSession? = null
    private var disc: DiscoverySession? = null
    private val peers = ArrayList<PeerHandle>()
    private var msgId = 0

    private fun peerId(p: PeerHandle): Int {
        val i = peers.indexOf(p)
        if (i >= 0) return i + 1
        if (peers.size >= 64) peers.removeAt(0)
        peers.add(p); return peers.size
    }

    private fun awareStop() {
        try { disc?.close() } catch (e: Exception) {}; disc = null
        try { aware?.close() } catch (e: Exception) {}; aware = null; peers.clear()
    }

    private fun awareStart(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        if (!appCtx.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_AWARE)) return Reply.done(c, id, cmd, "this phone has no Wi-Fi Aware")
        val mgr = appCtx.getSystemService(Context.WIFI_AWARE_SERVICE) as? WifiAwareManager ?: return Reply.done(c, id, cmd, "this phone has no Wi-Fi Aware")
        if (!mgr.isAvailable) return Reply.done(c, id, cmd, "Wi-Fi Aware is off — turn Wi-Fi on (it is not available while a hotspot or Wi-Fi Direct holds the radio)")
        val name = WifiArgs.awareName(j.optString("service")) ?: return Reply.done(c, id, cmd, "service: letters, digits, _ . -")
        val info = if (j.has("hex") || j.has("text")) Args.payload(j, 255) ?: return Reply.done(c, id, cmd, "info: hex or text up to 255 bytes") else null
        val pub = cmd == "aware.publish"
        val begin = { s: WifiAwareSession ->
            try { disc?.close() } catch (e: Exception) {}; disc = null
            val cb = object : DiscoverySessionCallback() {
                override fun onPublishStarted(s: PublishDiscoverySession) { h.post { disc = s; rec("aware", "kind" to Json.str("published"), "service" to Json.str(name)); Reply.done(c, id, cmd, null, extra = arrayOf("service" to Json.str(name))) } }
                override fun onSubscribeStarted(s: SubscribeDiscoverySession) { h.post { disc = s; rec("aware", "kind" to Json.str("subscribed"), "service" to Json.str(name)); Reply.done(c, id, cmd, null, extra = arrayOf("service" to Json.str(name))) } }
                override fun onSessionConfigFailed() { h.post { Reply.done(c, id, cmd, "Aware session config failed") } }
                override fun onSessionTerminated() { h.post { disc = null; rec("aware", "kind" to Json.str("terminated")) } }
                override fun onServiceDiscovered(p: PeerHandle, i: ByteArray?, f: MutableList<ByteArray>?) {
                    h.post { val b = i ?: ByteArray(0); rec("aware", "kind" to Json.str("peer"), "peer" to peerId(p).toString(), "hex" to Json.str(Hex.of(b)), "text" to Json.str(String(b, Charsets.UTF_8))) }
                }
                override fun onMessageReceived(p: PeerHandle, m: ByteArray) {
                    h.post { rec("aware", "kind" to Json.str("message"), "peer" to peerId(p).toString(), "hex" to Json.str(Hex.of(m)), "n" to m.size.toString(), "text" to Json.str(String(m, Charsets.UTF_8))) }
                }
                override fun onMessageSendSucceeded(m: Int) { h.post { rec("aware", "kind" to Json.str("sent"), "msg" to m.toString(), "ok" to "true") } }
                override fun onMessageSendFailed(m: Int) { h.post { rec("aware", "kind" to Json.str("sent"), "msg" to m.toString(), "ok" to "false") } }
            }
            if (pub) {
                val b = PublishConfig.Builder().setServiceName(name).setPublishType(if (j.optBoolean("solicited", false)) PublishConfig.PUBLISH_TYPE_SOLICITED else PublishConfig.PUBLISH_TYPE_UNSOLICITED)
                if (info != null) b.setServiceSpecificInfo(info)
                s.publish(b.build(), cb, h)
            } else {
                val b = SubscribeConfig.Builder().setServiceName(name).setSubscribeType(if (j.optBoolean("active", true)) SubscribeConfig.SUBSCRIBE_TYPE_ACTIVE else SubscribeConfig.SUBSCRIBE_TYPE_PASSIVE)
                if (info != null) b.setServiceSpecificInfo(info)
                s.subscribe(b.build(), cb, h)
            }
        }
        aware?.let { return begin(it) }
        mgr.attach(object : AttachCallback() {
            override fun onAttached(s: WifiAwareSession) { h.post { aware = s; rec("aware", "kind" to Json.str("attached")); begin(s) } }
            override fun onAttachFailed() { h.post { Reply.done(c, id, cmd, "Aware attach failed (another app holds it, or the radio is busy)") } }
        }, h)
    }

    private fun awareSend(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        val d = disc ?: return Reply.done(c, id, cmd, "no Aware session — aware.publish / aware.subscribe first")
        val p = peers.getOrNull(j.optInt("peer", 0) - 1) ?: return Reply.done(c, id, cmd, "peer: the number from a «peer» / «message» record")
        val data = Args.payload(j, 255) ?: return Reply.done(c, id, cmd, "hex or text up to 255 bytes")
        val m = ++msgId
        d.sendMessage(p, m, data)
        Reply.done(c, id, cmd, null, extra = arrayOf("msg" to m.toString()))
    }

    fun held(): Int = (if (disco != null) 1 else 0) + (if (regL != null) 1 else 0) + (if (aware != null) 1 else 0)

    fun release() { h.post { nsdStop(); nsdUnregister(); awareStop() } }

    fun close() { release(); thread.quitSafely() }
}
