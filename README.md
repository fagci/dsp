# DSP workbench

A browser-based modular DSP lab: build signal chains by wiring nodes on a canvas. Runs fully client-side, no build step, works offline as a PWA.

**[▶ Live demo](https://fagci.github.io/dsp/)** · **[📦 Releases](https://github.com/fagci/dsp/releases)** (signed Android app) · **[💛 Boosty — support the project](https://boosty.to/fagci)**

[![FT8 propagation map in DSP workbench — open the demo](docs/screenshots/map-ft8.png)](https://fagci.github.io/dsp/)

[More screenshots ↓](#screenshots)

## Features

- **A full DSP lab in the browser** — hundreds of modules wired on a canvas with typed ports: signal in → process → see, hear, decode. No install, no build step, works offline as a PWA.
- **Fuzzy everywhere, chains like Emmet** — the palette, the **Ctrl+K** command palette and the help search forgive typos and abbreviations (`phose` finds Phone sensors); build a chain by typing `mic>fft>sa`, with a live preview on the canvas before you press Enter.
- **Real radio** — USB SDRs (RTL-SDR, HackRF, Airspy, SDRplay, RX-888), remote SDRs (rtl_tcp, SpyServer, KiwiSDR, OpenWebRX), tinySA: [SDR and receivers](help/sdr.md)
- **The analysis bench** — spectrum, waterfall, oscilloscope, persistence, CFAR signal detector, band scanners, signal identification: [Analysis](help/analysis.md)
- **Decoders as nodes** — GSM, ADS-B, DMR, TETRA, POCSAG, AIS, ACARS, Inmarsat, JS8Call, digital voice and more, wired like any other module: [Radio](help/radio.md) · [Satellites](help/satellites.md)
- **Your phone is a node** — the Android app feeds GPS, Wi-Fi, BLE, cells and sensors (with the screen locked), scans networks, traces routes, runs automations: [Phone](help/phone.md) · [Network](help/network.md)
- **Records pipeline** — decoders emit records → Table, Graph, Map, entity rules, charts: [Data](help/data.md) · [Map](help/map.md)
- **Video and cameras** — analog and digital TV (DVB-S/S2/T2), IP cameras and archives, camera tools, podcasts: [Video](help/video.md)
- **Music** — tracker, sample editor, a Winamp-style player, Internet radio: [Media](help/media.md)
- **Out to the world** — serial (incl. Android OTG), Bluetooth LE, MQTT, network text and bytes, WebRTC between browsers, firmware flashers: [Protocols](help/protocols.md)
- Around it all: dashboards and tiles, undo, patches saved and shared by link, 160+ presets, installable offline app. **The full story — [the manual](help/README.md).**

## Manual

The full manual lives in [help/](help/README.md) — the same pages render here on GitHub, inside the app (the **?** button) and offline.

- **Getting started** — [Start here](help/start.md) · [Canvas and modules](help/canvas.md) · [Wires and port types](help/wires.md) · [Running and settings](help/run.md) · [Patches and presets](help/patches.md) · [Keys and gestures](help/shortcuts.md) · [Dashboard](help/dashboard.md)
- **Signals** — [SDR and receivers](help/sdr.md) · [Analysis](help/analysis.md) · [Radio: decoders and digital modes](help/radio.md) · [Satellites](help/satellites.md) · [Processing and interface](help/processing.md) · [Video and cameras](help/video.md) · [Media](help/media.md)
- **Data** — [Tables and records](help/data.md) · [Map and records](help/map.md)
- **Hardware and protocols** — [Phone tools](help/phone.md) · [Network tools (Android app)](help/network.md) · [Protocols and firmware](help/protocols.md) · [Module reference](help/modules.md)
- **Operation** — [Offline and the phone app](help/offline.md)

## Screenshots

### Map: FT8 propagation

Heard stations from their locators, lines to your position, Maidenhead grid; colour — SNR.

<img src="docs/screenshots/map-ft8.png" alt="FT8 propagation map">

### Source location (trilateration)

Fox hunt: RSSI marks along the route plus two bearings from a directional antenna; Source Locator shows the probability map and puts the estimate with its error radius on the map.

<img src="docs/screenshots/foxhunt.png" alt="Source Locator: trilateration by RSSI and bearings">

### Satellites

ISS: footprint, ground track ahead, sky plot, next passes and Doppler-corrected downlink.

<img src="docs/screenshots/satellites.png" alt="Satellite tracking with sky plot and map">

### SDR software

<img width="1920" height="927" alt="image" src="https://github.com/user-attachments/assets/6a573888-5e1d-48f7-bd0b-b8cd517c1445" />

### WeFax

<img width="1316" height="845" alt="image" src="https://github.com/user-attachments/assets/5491c805-5bd3-44aa-91f9-6572466f4909" />

### ft8

<img width="1591" height="734" alt="image" src="https://github.com/user-attachments/assets/be648341-2275-49e4-9c37-264a1ce0abbf" />

### RTTY

<img width="1377" height="836" alt="image" src="https://github.com/user-attachments/assets/33482242-2e84-4fed-9eda-784e1bc98c33" />

### Chirp modem (wip)

<img width="1920" height="846" alt="image" src="https://github.com/user-attachments/assets/b40b1d21-6fdb-4232-bcd8-cb531d7f6b3d" />

### Music making (wip)

<img width="1168" height="741" alt="image" src="https://github.com/user-attachments/assets/5e8232b4-fccc-4196-97d6-1ca90fcfa97c" />

### Generator + Oscilloscope

<img width="719" height="667" alt="image" src="https://github.com/user-attachments/assets/73cacb96-2b82-4550-8068-7d4ddbb47a30" />

### Misc

<img width="925" height="724" alt="image" src="https://github.com/user-attachments/assets/962b3167-53fa-4bf8-ae8c-c035521d4476" />

<img width="1373" height="721" alt="image" src="https://github.com/user-attachments/assets/e45690c5-187f-46fe-a801-bd0e49b4b05c" />

<img width="1221" height="719" alt="image" src="https://github.com/user-attachments/assets/83aacc0a-e61b-4d46-bed7-65bbfe542233" />

## Proxy for KiwiSDR and lists

The **CORS proxy** from the settings panel is used for list downloads (Satellites, Station Schedule, SDR Receivers Directory…) and for the **KiwiSDR** and **OpenWebRX** nodes (OpenWebRX: `http://host:port/ws/`). For Kiwi the address `http://host:port/<ts>/SND` is substituted into the proxy URL the same way (`{url}` is replaced by the encoded address, otherwise the address is appended) and the scheme `http(s)` becomes `ws(s)`, so the proxy must pass WebSocket. Without a proxy the node connects to `ws://host:port` directly, which an https page cannot do (mixed content).

nginx, setting `https://example.com/proxy/` (the address is appended):

```nginx
# http {} block
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

# server {} block
location ~ ^/proxy/(?<sch>https?):/+(?<hst>[^/]+)(?<pth>/.*)?$ {
    resolver 1.1.1.1;
    proxy_pass $sch://$hst$pth$is_args$args;
    proxy_http_version 1.1;
    proxy_set_header Host $hst;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_ssl_server_name on;
    proxy_read_timeout 3600s;
    add_header Access-Control-Allow-Origin * always;
}
```

This is an open proxy to any host: restrict it (`allow`/`deny`, basic auth, or a whitelist of hosts) before exposing it. Lists need the CORS header, Kiwi only the WebSocket upgrade.

Pitfalls:
- The `location` prefix must match the one set in Settings (`/proxy/`, `/p/`…).
- An address with `.php` in the path (e.g. Celestrak `gp.php`) is caught by `location ~ \.php$` if that one comes earlier in the file: among regex locations the first match wins. Put the proxy `location` above it, otherwise you get a 404 without the CORS header.
- `always` in `add_header` is required: without it the header is not added to 4xx/5xx responses, and the browser shows "blocked by CORS policy" instead of the real error.
- Check: `curl -s -D- 'https://example.com/proxy/https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle' | head` — expect `200` and `Access-Control-Allow-Origin: *`.
