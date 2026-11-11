# Network tools (the Android app)

A browser can talk HTTP and WebSocket, nothing more: no raw sockets, no ICMP, no multicast. The **DSP app for Android** has a bridge service that opens those for your patches, so the modules below exist only where the bridge is available (they are marked *(DSP app)* in the module list).

| Module | What it does |
|---|---|
| **Network Scanner** | who is on the network: hosts of the /24 (ping, then TCP knocks, MAC from the ARP table with root), open TCP / UDP ports, banners |
| **Device Discovery** | SSDP / UPnP and mDNS: cameras, printers, TVs, Chromecast, NAS |
| **Traceroute / MTR** | the path to an address, router by router, with the time of every hop; several rounds give loss and spread per hop (mtr) |
| **Network Links** | the phone's networks (Wi-Fi, mobile data, Ethernet over OTG, VPN) and the open sockets / servers of the app on each, with speed; the picture is drawn by **Graph** (output `rows`), changes come as records |
| **Batch Check** | a list in, the answers in the same rows: ping, tcp port, web page (code, text, css block), IPTV stream, domain expiry, SMS with delivery report, SIM balance by USSD |
| **Network Tools** | Wake-on-LAN, NTP time offset, syslog, SMTP mail, TFTP get and put |
| **Syslog / TFTP Server** | the phone as a log collector or a TFTP server for routers and cameras |
| **Telnet Terminal, HTTP / FTP servers and clients** | talk to devices and serve files from the phone |
| **VPN traffic monitor** | which app talks to which address (no decryption) |
| **DNS Benchmark** | response time of DNS servers from where you are |

## Seeing a network as a graph
The scanners emit records; **Rec → Entities** turns them into nodes and links by rules (templates *Network scan* and *Traceroute*), a **Table** with key `id` keeps one row per node, and **Graph** draws it. See [Tables and records](data.md). In Graph, `layout: LR` draws a path from left to right, `group` colours nodes and a click on a node lets you add a comment.

## Several networks at once
Android keeps Wi-Fi, mobile data, Ethernet and a VPN up at the same time, and a socket normally goes through the one Android prefers. The bridge commands `tcp.connect`, `tcp.listen`, `udp.open`, `udp.send`, `udp.request`, `ping`, `net.trace` and `net.info` take a field **`net`**: `wifi`, `cell`, `eth`, `vpn`, `bt`, `usb`, or the number from `net.list`. Empty or `default` — the system's choice.
- `tcp.connect {host, port, net:"cell"}` goes over mobile data while Wi-Fi is on; the name is resolved by that network's DNS. `udp.request {host:"@dns", net:"cell"}` asks that network's DNS server.
- `tcp.listen {port, net:"wifi"}` listens only on the address of that network (several servers at once: up to 16; the reply carries `addr` and `net`).
- `ping` and `net.trace` with `net` send through the network's interface (`ping -I`); some phones refuse it — then the answer says so.
- No such network → the error lists what exists now (`wifi#101, cell#102`).
- `net.list` — the networks (`id`, `kind`, `iface`, `ips`, `dns`, `gateway`, `validated`, `metered`, `default`, `down`/`up` kbit/s). `net.sockets` — everything the app holds open: `{id, kind: tcp|tcp-server|udp, addr, net, server, age, rx, tx}`. `net.watch {on}` — a record `{src:'net', ev:'networks', nets, socks}` on every change (a network came up, went down, lost the internet).
- The **Network Links** node shows it all; open the preset **Network: Phone Networks and Open Sockets — Live Map (Phone App)**. The bridge lost → the last state stays, marked *stale*.

## Traceroute in short
1. Open the preset **Network: Traceroute and MTR — the Path to a Host as a Graph (Phone App)**.
2. Press **Run** in the Traceroute node. The path grows hop by hop; the last node (the destination) is a red diamond.
3. Raise **rounds** to 10: the second Table becomes an mtr — loss %, last, average, best and worst per hop.
4. A hop that shows `*` is a router that does not answer pings; the path continues around it. Loss on a hop that does not continue to the next ones is just rate limiting of that router.

Needs no root. IPv4 only.

## Batch Check in short
1. Open the preset **Batch Check: Ping, Site, IPTV, Domain, SMS and SIM Balance in a Table**.
2. Every row of the **Table** is one job: the `kind` column says what to do (`ping`, `tcp`, `http`, `iptv`, `domain`, `sms`, `ussd`) and the address column says with whom (`target`, `host`, `ip`, `url`, `domain`, `to`…). A row's own columns override the node's parameters: `port`, `expect` (200, 2xx, `<400`), `contains` (a text or `/regex/`), `selector` (a css block that must be on the page), `warn` (days), `text`, `code`, `sim`.
3. Press **Run**. Each result is a record `{id, kind, ok, status, ms, detail, …}` on `rec`; wired back into the same Table (same key `id`) it updates the row it came from. Extra fields by kind: `code`, `found`, `block` (http), `stream`, `kbps` (iptv), `expires`, `days`, `registrar` (domain), `delivery` (sms: delivered / failed / unknown — not every carrier sends a report), `balance`, `reply` (ussd).
4. `status` is `ok`, `fail` (the check ran and the answer is bad) or `error` (it could not run: no app, no permission, no number). **every** repeats the run; **conc** sets how many go at once (SMS and USSD always one by one — the app sends 5 a minute at most, the node waits).

### Your own handler per row (kind `node`)
Set `kind` to `node` (the node parameter or a column) and the row is handled by **your own chain of modules**: Batch puts the row on the **`task`** output (the whole row plus `attempt`), waits for a record on the **`result`** input for `nodeTimeout` seconds, and writes the verdict into the row: `ok`, `status`, `attempts`, `ms`, `detail` and the fields of the answer. Batch knows nothing about the modules in between — an auto-dialler (task → call → «answered» → result), a sensor poll (task → command to Serial / Network / BLE → reply → result), an antenna test (task → Rotator → wait → measure → result).
- **Retries** (`retries`, `retryDelay`, or `retries` / `retryDelay` columns) work for every kind: a failed check is repeated, then marked `fail` with `attempts`. SMS is never repeated.
- **Success** is the answer itself (unless it carries `ok=0`), or a condition over the answer `r` and the task `t`: `r.level > t.min`. No answer in time is a failure.
- **One task at a time** by default (`nodeConc` 1) — a device is usually one; with more, the handler must keep the key field (`id`) in the answer so it finds its task. A late answer to an earlier attempt is ignored when `attempt` is carried.
- Helpers for handlers (Control): **Wait Until** (a value must meet a condition for N seconds without a break, with a timeout — «the rotator has stopped») and **Measure Window** (average / min / max of a value over a window). *Rec → Fields* and *Fields → Rec* (Data) open the task and pack the answer. Preset: **Batch Check: Your Own Graph per Row — Antenna Turn, Wait, Measure (Simulator)**.

Pages, https, ping, tcp and whois go through a **bridge** (`url` of the node): the phone app, or the Node bridge on a computer (`ws://127.0.0.1:8777` — ping, tcp, http(s), whois; SMS and USSD exist only on the phone and answer *unsupported* at once). Without a bridge an http page is read by the browser's `fetch` when the site allows CORS, and if *Settings → CORS proxy* is set (for example the same Node bridge, `/proxy`), through it — then http, iptv and RDAP work with no bridge connection at all. A USSD balance is the number in the network's answer near «баланс / balance / остаток», or group 1 of your own `balanceRe`. SMS and USSD can cost money — an empty `to` is an error and sends nothing.

## Safety
These commands make the phone open sockets and send packets, so they need a *trusted client*: the app's own page, or any page when *Let any page use actions* is ticked in the app settings (off by default). Scan and trace only networks you are allowed to.
