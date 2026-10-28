package app.dsp.phone

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.MacAddress
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSpecifier
import android.net.wifi.WifiNetworkSuggestion
import android.net.wifi.WpsInfo
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pDevice
import android.net.wifi.p2p.WifiP2pManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import org.json.JSONObject

/** Разбор имён и паролей Wi-Fi и расшифровка кодов ошибок (чистая логика — проверяется на JVM). */
object WifiNetArgs {
    private val P2P_NAME = Regex("DIRECT-[A-Za-z0-9]{2}-[ -~]{0,22}")

    /** SSID: 1…32 байта UTF-8. */
    fun ssid(s: String?): String? = s?.takeIf { it.isNotEmpty() && it.toByteArray(Charsets.UTF_8).size <= 32 }

    /** Пароль WPA2 / WPA3: 8…63 печатных ASCII-символа; пустой — открытая сеть (null без ошибки через ok). */
    fun pass(s: String?): String? = s?.takeIf { it.length in 8..63 && it.all { c -> c in ' '..'~' } }

    /** Имя группы Wi-Fi Direct: «DIRECT-xy-…», xy — два символа, всего не больше 32. */
    fun p2pName(s: String?): String? = s?.trim()?.takeIf { P2P_NAME.matches(it) }

    fun p2pIntent(v: Int): Int = v.coerceIn(0, 15)

    fun suggestStatus(code: Int): String? = when (code) {
        0 -> null
        1 -> "internal error"
        2 -> "Android did not allow suggestions from this app — approve them in the notification, or in Settings → Apps → Special access → Wi-Fi network suggestions"
        3 -> "already suggested"
        4 -> "too many suggestions from this app"
        5 -> "no such suggestion"
        6 -> "not allowed right now (Wi-Fi is off, or a work profile forbids it)"
        7 -> "invalid suggestion (SSID / passphrase / BSSID)"
        else -> "status $code"
    }

    fun hotspotReason(code: Int): String = when (code) {
        1 -> "no channel available for the hotspot"
        2 -> "the hotspot could not start (turn Location on; another hotspot or tethering may be running)"
        3 -> "the phone is in a mode that cannot host a hotspot now (Wi-Fi tethering or a repeater is on)"
        4 -> "tethering is disallowed on this phone"
        else -> "hotspot failed (code $code)"
    }

    fun p2pReason(code: Int): String = when (code) {
        0 -> "Wi-Fi Direct error"
        1 -> "Wi-Fi Direct is not supported on this phone"
        2 -> "Wi-Fi Direct is busy — try again in a moment"
        3 -> "no service requests"
        else -> "Wi-Fi Direct failed (code $code)"
    }
}

/**
 * Что телефон может с Wi-Fi помимо скана: Wi-Fi Direct (p2p.*), локальная точка доступа (wifi.hotspot.*), подсказки сетей для
 * автоподключения (wifi.suggest*), временное подключение к конкретной сети (wifi.connect / wifi.disconnect — для сетей без интернета,
 * например точки другого устройства). Записи идут в источник net: {src:'net', ev:'p2p'|'hotspot'|'wifi', …}.
 */
@SuppressLint("MissingPermission")
class WifiNetHub(private val ctx: Context, private val emit: Emit, private val needs: Needs) {
    private val thread = HandlerThread("dsp-wifinet").also { it.start() }
    private val h = Handler(thread.looper)
    private val app = ctx.applicationContext

    private fun rec(ev: String, vararg kv: Pair<String, String?>) =
        emit("net", Json.obj("src" to "\"net\"", "ev" to Json.str(ev), "t" to System.currentTimeMillis().toString(), *kv))

    private fun radioPerms() = listOf(if (Build.VERSION.SDK_INT >= 33) "android.permission.NEARBY_WIFI_DEVICES" else android.Manifest.permission.ACCESS_FINE_LOCATION)

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        if ((cmd.startsWith("p2p.") || cmd == "wifi.hotspot.start") && !needs.need(c, id, cmd, radioPerms())) return
        h.post {
            try { run(c, id, cmd, j) } catch (e: SecurityException) { Reply.done(c, id, cmd, "permission: ${e.message}", "permission") }
            catch (e: Exception) { Reply.done(c, id, cmd, e.message ?: e.javaClass.simpleName) }
        }
    }

    private fun run(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        when {
            cmd.startsWith("p2p.") -> p2pRun(c, id, cmd, j)
            cmd == "wifi.hotspot.start" -> hotspotStart(c, id, cmd)
            cmd == "wifi.hotspot.stop" -> { hotspotStop(); Reply.done(c, id, cmd, null) }
            cmd == "wifi.suggest" -> suggest(c, id, cmd, j)
            cmd == "wifi.suggest.remove" -> suggestRemove(c, id, cmd, j)
            cmd == "wifi.suggest.list" -> Reply.done(c, id, cmd, null, extra = arrayOf("ssids" to Json.arr(suggestions.keys.toList())))
            cmd == "wifi.connect" -> connect(c, id, cmd, j)
            cmd == "wifi.disconnect" -> { disconnect(); Reply.done(c, id, cmd, null) }
            else -> Reply.done(c, id, cmd, "unknown command", "unknown")
        }
    }

    // ---------- Wi-Fi Direct ----------

    private val p2p by lazy { app.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager }
    private var chan: WifiP2pManager.Channel? = null
    private var p2pRx: BroadcastReceiver? = null

    private fun channel(): WifiP2pManager.Channel? {
        val m = p2p ?: return null
        chan?.let { return it }
        val ch = m.initialize(app, thread.looper, null) ?: return null
        chan = ch
        val rx = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) { h.post { p2pEvent(i) } }
        }
        p2pRx = rx
        app.registerReceiver(rx, IntentFilter().also {
            it.addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION); it.addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
            it.addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION); it.addAction(WifiP2pManager.WIFI_P2P_THIS_DEVICE_CHANGED_ACTION)
        }, null, h)
        return ch
    }

    private fun statusName(s: Int) = when (s) { WifiP2pDevice.CONNECTED -> "connected"; WifiP2pDevice.INVITED -> "invited"; WifiP2pDevice.FAILED -> "failed"; WifiP2pDevice.AVAILABLE -> "available"; else -> "unavailable" }

    private fun p2pEvent(i: Intent) {
        val m = p2p ?: return; val ch = chan ?: return
        when (i.action) {
            WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION ->
                rec("p2p", "kind" to Json.str("state"), "on" to (i.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, 0) == WifiP2pManager.WIFI_P2P_STATE_ENABLED).toString())
            WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION ->
                m.requestPeers(ch) { l -> h.post { for (d in l.deviceList) rec("p2p", "kind" to Json.str("peer"), "addr" to Json.str(d.deviceAddress), "name" to Json.str(d.deviceName),
                    "status" to Json.str(statusName(d.status)), "type" to Json.str(d.primaryDeviceType ?: ""), "go" to d.isGroupOwner.toString()) } }
            WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION ->
                m.requestConnectionInfo(ch) { info ->
                    h.post {
                        if (!info.groupFormed) { rec("p2p", "kind" to Json.str("group"), "formed" to "false"); return@post }
                        val owner = info.groupOwnerAddress?.hostAddress
                        m.requestGroupInfo(ch) { g ->
                            h.post {
                                rec("p2p", "kind" to Json.str("group"), "formed" to "true", "owner" to info.isGroupOwner.toString(), "ownerAddr" to owner?.let { Json.str(it) },
                                    "ssid" to g?.networkName?.let { Json.str(it) }, "pass" to g?.passphrase?.let { Json.str(it) }, "iface" to g?.`interface`?.let { Json.str(it) },
                                    "clients" to g?.clientList?.let { l -> Json.arr(l.map { it.deviceAddress }) })
                            }
                        }
                    }
                }
            WifiP2pManager.WIFI_P2P_THIS_DEVICE_CHANGED_ACTION -> {
                @Suppress("DEPRECATION") val d = i.getParcelableExtra<WifiP2pDevice>(WifiP2pManager.EXTRA_WIFI_P2P_DEVICE) ?: return
                rec("p2p", "kind" to Json.str("this"), "addr" to Json.str(d.deviceAddress), "name" to Json.str(d.deviceName), "status" to Json.str(statusName(d.status)))
            }
        }
    }

    private fun listener(c: BridgeServer.Client, id: Any?, cmd: String, vararg extra: Pair<String, String?>) = object : WifiP2pManager.ActionListener {
        override fun onSuccess() { h.post { Reply.done(c, id, cmd, null, extra = extra) } }
        override fun onFailure(reason: Int) { h.post { Reply.done(c, id, cmd, WifiNetArgs.p2pReason(reason)) } }
    }

    @Suppress("DEPRECATION")
    private fun p2pRun(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        val m = p2p ?: return Reply.done(c, id, cmd, "this phone has no Wi-Fi Direct")
        val ch = channel() ?: return Reply.done(c, id, cmd, "Wi-Fi Direct could not start")
        when (cmd) {
            "p2p.discover" -> m.discoverPeers(ch, listener(c, id, cmd))
            "p2p.stop" -> m.stopPeerDiscovery(ch, listener(c, id, cmd))
            "p2p.connect" -> {
                val addr = Args.mac(j.optString("addr")) ?: return Reply.done(c, id, cmd, "addr: the device address from a peer record")
                val cfg = WifiP2pConfig().also { it.deviceAddress = addr; it.wps.setup = WpsInfo.PBC; it.groupOwnerIntent = if (j.has("intent")) WifiNetArgs.p2pIntent(j.optInt("intent")) else -1 }
                m.connect(ch, cfg, listener(c, id, cmd, "addr" to Json.str(addr)))
            }
            "p2p.disconnect" -> { m.cancelConnect(ch, null); m.removeGroup(ch, listener(c, id, cmd)) }
            "p2p.group.remove" -> m.removeGroup(ch, listener(c, id, cmd))
            "p2p.group.create" -> {
                val name = j.optString("name").takeIf { it.isNotEmpty() }; val pw = j.optString("pass").takeIf { it.isNotEmpty() }
                if (name == null && pw == null) return m.createGroup(ch, listener(c, id, cmd))
                if (Build.VERSION.SDK_INT < 29) return Reply.done(c, id, cmd, "a named group needs Android 10+ — leave name and pass empty")
                val n = WifiNetArgs.p2pName(name) ?: return Reply.done(c, id, cmd, "name: DIRECT-xy-… (xy — two letters or digits, at most 32 characters)")
                val p = WifiNetArgs.pass(pw) ?: return Reply.done(c, id, cmd, "pass: 8…63 characters")
                m.createGroup(ch, WifiP2pConfig.Builder().setNetworkName(n).setPassphrase(p).enablePersistentMode(false).build(), listener(c, id, cmd))
            }
            "p2p.info" -> m.requestConnectionInfo(ch) { info -> h.post { Reply.done(c, id, cmd, null, extra = arrayOf("formed" to info.groupFormed.toString(), "owner" to info.isGroupOwner.toString(), "ownerAddr" to info.groupOwnerAddress?.hostAddress?.let { Json.str(it) })) } }
            else -> Reply.done(c, id, cmd, "unknown command", "unknown")
        }
    }

    // ---------- локальная точка доступа ----------

    private var hotspot: WifiManager.LocalOnlyHotspotReservation? = null

    private fun hotspotStop() { try { hotspot?.close() } catch (e: Exception) {}; hotspot = null }

    @Suppress("DEPRECATION")
    private fun hotspotStart(c: BridgeServer.Client, id: Any?, cmd: String) {
        val wm = app.getSystemService(Context.WIFI_SERVICE) as WifiManager
        hotspotStop()
        var answered = false
        wm.startLocalOnlyHotspot(object : WifiManager.LocalOnlyHotspotCallback() {
            override fun onStarted(r: WifiManager.LocalOnlyHotspotReservation) {
                h.post {
                    hotspot = r
                    val (ssid, pass) = if (Build.VERSION.SDK_INT >= 30) r.softApConfiguration.let { it.ssid to it.passphrase } else r.wifiConfiguration.let { it?.SSID to it?.preSharedKey }
                    rec("hotspot", "on" to "true", "ssid" to ssid?.let { Json.str(it) }, "pass" to pass?.let { Json.str(it) })
                    if (!answered) { answered = true; Reply.done(c, id, cmd, null, extra = arrayOf("ssid" to ssid?.let { Json.str(it) }, "pass" to pass?.let { Json.str(it) })) }
                }
            }
            override fun onStopped() { h.post { hotspot = null; rec("hotspot", "on" to "false") } }
            override fun onFailed(reason: Int) { h.post { if (!answered) { answered = true; Reply.done(c, id, cmd, WifiNetArgs.hotspotReason(reason)) } } }
        }, h)
    }

    // ---------- подсказки сетей ----------

    private val suggestions = LinkedHashMap<String, WifiNetworkSuggestion>()

    private fun suggest(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        if (Build.VERSION.SDK_INT < 29) return Reply.done(c, id, cmd, "network suggestions need Android 10+")
        val ssid = WifiNetArgs.ssid(j.optString("ssid")) ?: return Reply.done(c, id, cmd, "ssid: 1…32 bytes")
        val b = WifiNetworkSuggestion.Builder().setSsid(ssid)
        val pw = j.optString("pass")
        if (pw.isNotEmpty()) { val p = WifiNetArgs.pass(pw) ?: return Reply.done(c, id, cmd, "pass: 8…63 characters"); if (j.optBoolean("wpa3", false)) b.setWpa3Passphrase(p) else b.setWpa2Passphrase(p) }
        if (j.has("bssid")) b.setBssid(MacAddress.fromString(Args.mac(j.optString("bssid")) ?: return Reply.done(c, id, cmd, "bssid: AA:BB:CC:DD:EE:FF")))
        if (j.optBoolean("hidden", false)) b.setIsHiddenSsid(true)
        if (Build.VERSION.SDK_INT >= 31 && j.has("priority")) b.setPriority(j.optInt("priority").coerceIn(0, 1000))
        val s = b.build()
        val wm = app.getSystemService(Context.WIFI_SERVICE) as WifiManager
        suggestions[ssid]?.let { wm.removeNetworkSuggestions(listOf(it)) }
        val st = wm.addNetworkSuggestions(listOf(s))
        if (st == 0 || st == 3) suggestions[ssid] = s
        Reply.done(c, id, cmd, if (st == 0 || st == 3) null else WifiNetArgs.suggestStatus(st), "error", "ssid" to Json.str(ssid))
    }

    private fun suggestRemove(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        if (Build.VERSION.SDK_INT < 29) return Reply.done(c, id, cmd, "network suggestions need Android 10+")
        val wm = app.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val ssid = j.optString("ssid")
        val list = if (ssid.isEmpty()) suggestions.values.toList() else listOfNotNull(suggestions[ssid])
        if (list.isEmpty()) return Reply.done(c, id, cmd, if (ssid.isEmpty()) "nothing suggested by this app" else "no suggestion for $ssid")
        val st = wm.removeNetworkSuggestions(list)
        if (st == 0) { if (ssid.isEmpty()) suggestions.clear() else suggestions.remove(ssid) }
        Reply.done(c, id, cmd, WifiNetArgs.suggestStatus(st), "error", "n" to list.size.toString())
    }

    // ---------- временное подключение к сети ----------

    private var netCb: ConnectivityManager.NetworkCallback? = null
    private var bound = false

    private fun disconnect() {
        val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        if (bound) { cm.bindProcessToNetwork(null); bound = false }
        netCb?.let { try { cm.unregisterNetworkCallback(it) } catch (e: Exception) {} }; netCb = null
    }

    /** Подключение к сети без интернета (точка другого телефона, устройство со своей точкой): сокеты приложения идут через неё, пока не wifi.disconnect. */
    private fun connect(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        if (Build.VERSION.SDK_INT < 29) return Reply.done(c, id, cmd, "joining a network needs Android 10+")
        val ssid = WifiNetArgs.ssid(j.optString("ssid")) ?: return Reply.done(c, id, cmd, "ssid: 1…32 bytes")
        val b = WifiNetworkSpecifier.Builder().setSsid(ssid)
        val pw = j.optString("pass")
        if (pw.isNotEmpty()) { val p = WifiNetArgs.pass(pw) ?: return Reply.done(c, id, cmd, "pass: 8…63 characters"); if (j.optBoolean("wpa3", false)) b.setWpa3Passphrase(p) else b.setWpa2Passphrase(p) }
        if (j.has("bssid")) b.setBssid(MacAddress.fromString(Args.mac(j.optString("bssid")) ?: return Reply.done(c, id, cmd, "bssid: AA:BB:CC:DD:EE:FF")))
        val req = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).setNetworkSpecifier(b.build()).build()
        val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        disconnect()
        val bind = j.optBoolean("bind", true)
        var answered = false
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(n: Network) {
                h.post {
                    if (bind) bound = cm.bindProcessToNetwork(n)
                    rec("wifi", "kind" to Json.str("connected"), "ssid" to Json.str(ssid), "bound" to bound.toString())
                    if (!answered) { answered = true; Reply.done(c, id, cmd, null, extra = arrayOf("ssid" to Json.str(ssid), "bound" to bound.toString())) }
                }
            }
            override fun onUnavailable() { h.post { netCb = null; if (!answered) { answered = true; Reply.done(c, id, cmd, "could not join $ssid — not in range, wrong passphrase, or you declined Android's dialog", "timeout") } } }
            override fun onLost(n: Network) { h.post { if (bound) { cm.bindProcessToNetwork(null); bound = false }; rec("wifi", "kind" to Json.str("lost"), "ssid" to Json.str(ssid)) } }
        }
        netCb = cb
        cm.requestNetwork(req, cb, h)
        h.postDelayed({ if (!answered) { answered = true; if (netCb === cb) disconnect(); Reply.done(c, id, cmd, "could not join $ssid in time", "timeout") } }, j.optLong("timeout", 30_000).coerceIn(5_000, 120_000))
    }

    fun held(): Int = (if (chan != null) 1 else 0) + (if (hotspot != null) 1 else 0) + (if (netCb != null) 1 else 0)

    fun release() {
        h.post {
            try { p2p?.let { m -> chan?.let { m.stopPeerDiscovery(it, null); m.cancelConnect(it, null); m.removeGroup(it, null) } } } catch (e: Exception) {}
            hotspotStop(); disconnect()
        }
    }

    fun close() {
        release()
        h.post { p2pRx?.let { try { app.unregisterReceiver(it) } catch (e: Exception) {} }; p2pRx = null; chan = null; thread.quitSafely() }
    }
}
