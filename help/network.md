# Network tools (the Android app)

A browser can talk HTTP and WebSocket, nothing more: no raw sockets, no ICMP, no multicast. The **DSP app for Android** has a bridge service that opens those for your patches, so the modules below exist only where the bridge is available (they are marked *(DSP app)* in the module list).

| Module | What it does |
|---|---|
| **Network Scanner** | who is on the network: hosts of the /24 (ping, then TCP knocks, MAC from the ARP table with root), open TCP / UDP ports, banners |
| **Device Discovery** | SSDP / UPnP and mDNS: cameras, printers, TVs, Chromecast, NAS |
| **Traceroute / MTR** | the path to an address, router by router, with the time of every hop; several rounds give loss and spread per hop (mtr) |
| **Network Tools** | Wake-on-LAN, NTP time offset, syslog, SMTP mail, TFTP get and put |
| **Syslog / TFTP Server** | the phone as a log collector or a TFTP server for routers and cameras |
| **Telnet Terminal, HTTP / FTP servers and clients** | talk to devices and serve files from the phone |
| **VPN traffic monitor** | which app talks to which address (no decryption) |
| **DNS Benchmark** | response time of DNS servers from where you are |

## Seeing a network as a graph
The scanners emit records; **Rec → Entities** turns them into nodes and links by rules (templates *Network scan* and *Traceroute*), a **Table** with key `id` keeps one row per node, and **Graph** draws it. See [Tables and records](data.md). In Graph, `layout: LR` draws a path from left to right, `group` colours nodes and a click on a node lets you add a comment.

## Traceroute in short
1. Open the preset **Network: Traceroute and MTR — the Path to a Host as a Graph (Phone App)**.
2. Press **Run** in the Traceroute node. The path grows hop by hop; the last node (the destination) is a red diamond.
3. Raise **rounds** to 10: the second Table becomes an mtr — loss %, last, average, best and worst per hop.
4. A hop that shows `*` is a router that does not answer pings; the path continues around it. Loss on a hop that does not continue to the next ones is just rate limiting of that router.

Needs no root. IPv4 only.

## Safety
These commands make the phone open sockets and send packets, so they need a *trusted client*: the app's own page, or any page when *Let any page use actions* is ticked in the app settings (off by default). Scan and trace only networks you are allowed to.
