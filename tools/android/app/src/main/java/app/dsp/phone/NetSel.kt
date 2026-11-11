package app.dsp.phone

import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities

/**
 * Выбор сети для сокетов: Wi-Fi, мобильная, Ethernet (OTG), VPN — по имени или по номеру. Android держит несколько сетей одновременно,
 * а сокет по умолчанию идёт в «лучшую»; `Network.bindSocket` отправляет его в нужную (мобильные данные при включённом Wi-Fi и наоборот).
 * Описание сети (NetInfo) и выбор из списка — чистая логика, проверяется на JVM (NetSelTest); запрос к системе — NetSel.query.
 */
class NetInfo(
    val id: Int, val kind: String, val iface: String, val ips: List<String>, val dns: List<String>, val gateway: String,
    val validated: Boolean, val metered: Boolean, val active: Boolean, val downKbps: Int, val upKbps: Int, val roaming: Boolean = false,
) {
    fun toJson(): String = Json.obj(
        "id" to id.toString(), "kind" to Json.str(kind), "iface" to Json.str(iface), "ips" to Json.arr(ips), "dns" to Json.arr(dns), "gateway" to Json.str(gateway),
        "validated" to validated.toString(), "metered" to metered.toString(), "default" to active.toString(),
        "down" to downKbps.toString(), "up" to upKbps.toString(), "roaming" to roaming.toString())
}

object NetSel {
    /** Что именно просит страница: вид сети (wifi / cell / eth / vpn / bt / usb / aware) или номер из net.list. Пусто и «default» — сеть системы, без привязки. */
    class Spec(val kind: String?, val id: Int?)

    private val KINDS = setOf("wifi", "cell", "eth", "vpn", "bt", "usb", "aware", "lowpan", "other")
    private val ALIAS = mapOf("mobile" to "cell", "cellular" to "cell", "lte" to "cell", "data" to "cell", "ethernet" to "eth", "lan" to "eth",
        "wi-fi" to "wifi", "wlan" to "wifi", "bluetooth" to "bt")

    /** null — строка непонятна (ошибку отдаёт вызывающий); Spec(null, null) — «по умолчанию». */
    fun parse(s: String?): Spec? {
        val t = (s ?: "").trim().lowercase()
        if (t.isEmpty() || t == "default" || t == "system") return Spec(null, null)
        t.toIntOrNull()?.let { return if (it >= 0) Spec(null, it) else null }
        val k = ALIAS[t] ?: t
        return if (k in KINDS) Spec(k, null) else null
    }

    /** Вид сети по её транспортам (константы NetworkCapabilities.TRANSPORT_*): VPN важнее нижележащего Wi-Fi или мобильной. */
    fun kindOf(transports: Set<Int>): String = when {
        NetworkCapabilities.TRANSPORT_VPN in transports -> "vpn"
        NetworkCapabilities.TRANSPORT_WIFI in transports -> "wifi"
        NetworkCapabilities.TRANSPORT_CELLULAR in transports -> "cell"
        NetworkCapabilities.TRANSPORT_ETHERNET in transports -> "eth"
        NetworkCapabilities.TRANSPORT_BLUETOOTH in transports -> "bt"
        NetworkCapabilities.TRANSPORT_USB in transports -> "usb"
        NetworkCapabilities.TRANSPORT_WIFI_AWARE in transports -> "aware"
        NetworkCapabilities.TRANSPORT_LOWPAN in transports -> "lowpan"
        else -> "other"
    }

    /** Подходящая сеть из списка: по номеру — точно, по виду — рабочая (validated) раньше, затем используемая системой. null — не нашлась. */
    fun choose(all: List<NetInfo>, spec: Spec): NetInfo? {
        spec.id?.let { want -> return all.firstOrNull { it.id == want } }
        val k = spec.kind ?: return null
        return all.filter { it.kind == k }.sortedWith(compareByDescending<NetInfo> { it.validated }.thenByDescending { it.active }.thenBy { it.id }).firstOrNull()
    }

    /** Подпись выбора для записей и net.sockets: «wifi#101», «default». */
    fun label(n: NetInfo?): String = if (n == null) "default" else "${n.kind}#${n.id}"

    /** Первый IPv4-адрес сети — на него привязывается сервер (tcp.listen {net}); null — у сети нет IPv4. */
    fun ip4(n: NetInfo): String? = n.ips.firstOrNull { Regex("\\d+\\.\\d+\\.\\d+\\.\\d+").matches(it) }

    fun describe(id: Int, lp: LinkProperties?, caps: NetworkCapabilities?, active: Boolean): NetInfo {
        val tr = (0..8).filter { caps?.hasTransport(it) == true }.toSet()
        return NetInfo(
            id = id, kind = kindOf(tr), iface = lp?.interfaceName ?: "",
            ips = lp?.linkAddresses?.mapNotNull { it.address?.hostAddress?.substringBefore('%') } ?: emptyList(),
            dns = lp?.dnsServers?.mapNotNull { it.hostAddress } ?: emptyList(),
            gateway = lp?.routes?.firstOrNull { it.isDefaultRoute && it.gateway?.address?.size == 4 }?.gateway?.hostAddress
                ?: lp?.routes?.firstOrNull { it.isDefaultRoute }?.gateway?.hostAddress ?: "",
            validated = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true,
            metered = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) != true,
            active = active, downKbps = caps?.linkDownstreamBandwidthKbps ?: 0, upKbps = caps?.linkUpstreamBandwidthKbps ?: 0,
            roaming = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_ROAMING) == false)
    }

    /** Все сети телефона сейчас (в порядке номера). Network для привязки сокета берётся по тому же номеру: NetSel.network. */
    @Suppress("DEPRECATION")
    fun query(cm: ConnectivityManager): List<NetInfo> {
        val act = cm.activeNetwork
        return cm.allNetworks.mapNotNull { n ->
            val id = n.toString().toIntOrNull() ?: return@mapNotNull null
            val caps = cm.getNetworkCapabilities(n) ?: return@mapNotNull null
            describe(id, cm.getLinkProperties(n), caps, n == act)
        }.sortedBy { it.id }
    }

    @Suppress("DEPRECATION")
    fun network(cm: ConnectivityManager, id: Int): Network? = cm.allNetworks.firstOrNull { it.toString().toIntOrNull() == id }

    /** Выбор по запросу страницы: null — сеть системы (привязки нет). Нет такой сети — IllegalArgumentException с перечнем того, что есть. */
    fun pick(cm: ConnectivityManager, s: String?): Pair<Network, NetInfo>? {
        val spec = parse(s) ?: throw IllegalArgumentException("net: default | wifi | cell | eth | vpn | bt | usb | a number from net.list")
        if (spec.kind == null && spec.id == null) return null
        val all = query(cm)
        val n = choose(all, spec) ?: throw IllegalArgumentException("no such network (${s?.trim()}); now: " + (all.joinToString { label(it) }.ifEmpty { "none" }))
        val net = network(cm, n.id) ?: throw IllegalArgumentException("the network ${label(n)} has just gone")
        return net to n
    }
}
