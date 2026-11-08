# Phone tools

Bluetooth LE, Meshtastic and MeshCore — near the phone, with or without it.

### Tools (phone)

Small instruments for the phone (category Tools); sensors come from the wires (Accelerometer, Orientation, Termux, WebSocket sensor), the blocks only compute and draw.

- **Unit Converter** — length, area, volume, mass, speed, temperature, pressure, energy, power (W, dBm, dBW), force, angle, time, frequency, data; the value is typed or comes from a wire.
- **Screen Ruler** — mm and inches, two draggable marks with the distance, fullscreen. The browser does not know the pixel size, so calibrate with a bank card outline or by the screen diagonal.
- **Height Meter** — from the camera angle (Orientation → `el`) to the top and the base of an object: with a known distance or with the eye height; or by pressure difference (a barometer from Termux / a WebSocket sensor).
- **True North (declination)** — adds the magnetic declination to a heading (for Compass).
- **Slope / Level / Plumb** — slope in degrees, percent and the uphill direction, a bubble level and a plumb line from gravity; zeroing on a flat surface; `level` pin.
- **Flashlight** — the phone LED (Chrome / Android) or a white screen; steady, strobe, SOS.
- **Rangefinder** — distance to a point on the ground from the angle down and the eye height, or to an object of a known height from the angles to its top and base (Orientation → `el`).
- **Protractor** — the angle between two marked directions (azimuth + elevation, 3D) and the differences of azimuth and elevation.
- **Sound Level Meter** — dB(A) / dB(Z), fast / slow, Leq, max, peak, 60 s history; calibrate against a known level (the phone microphone is only good to a few dB).
- **Light Meter** — lux → EV → shutter or aperture for the ISO (Ambient Light or typed).
- **Metal Detector** — change of the magnetic field strength |B| against a slowly following reference (magnetometer from Sensor (Generic Sensor API)); finds iron and steel.
- **Calculator** — an expression of `a b c d` (pins or typed) with the Table formula functions, without `eval`.
- **Sun & Moon** — sunrise, noon, sunset, day length, solar elevation and azimuth, moon phase for a place (NOAA formulas, ±1–2 min, no refraction).
- **Timer** — countdown with beep, vibration and flash, optional repeat, a big fullscreen clock; `start` and `done` pins.
- **Random** — dice (`2d6+3`), coin, number, password (no look-alike characters), pick from a list; unbiased, `crypto.getRandomValues`.
- **Alarm Siren** — siren / two-tone / beeps with a flashing screen, switched by the `on` pin.
- **Motion Guard** — a phone alarm: arms after a delay, latches when the acceleration vector changes; `alarm` pin → Alarm Siren.
- **Pedometer** — steps, steps per minute and distance from the acceleration peaks. While the graph runs the screen stays awake and a silent sound keeps the page alive; a locked screen can still pause the sensors in some browsers.

Presets: the *Tools* group (*Unit Converter*, *Screen Ruler*, *Height Meter*, *Compass with True North*, *Slope Meter*, *Bubble Level and Plumb*, *Flashlight*, *Pedometer*). Logic: `modules/tools-kernels.js`, tests: `node tools/test-tools.mjs`.


## Bluetooth LE

Web Bluetooth works in Chrome, Edge and Opera (desktop and Android) on https or localhost; Firefox and iOS do not support it. The device chooser opens only on a click (*Connect* / *Choose device*). Without the filters the chooser lists every device (*list all devices*); by default it is filtered by the service, or by the name prefix.

- **BLE UART**: `line` / `go` (a line per block, split on line feed) and the `text` input, which writes in chunks (20 bytes by default — safe on any device; with a larger MTU raise it). Profiles: *Nordic UART* (service `6e400001-…`), *HM-10 / FFE0*, *custom* (service, characteristic from the device, characteristic to the device). The line end for sending is selectable. The same line protocols as on a serial port work: wire the `line` output to *IR Decode*, or *Parse CSV Line*.
- **BLE GATT**: service and characteristic as a name (`heart_rate`), a 16-bit hex (`180D`) or a 128-bit UUID; *notify* or *read every period*; the format turns the bytes into a number (`value` with scale and offset), `hex` is always given, `rec` has a record per value. The `write` input sends hex or text to the characteristic (relays, LED strips, thermometers' settings).
- **BLE Advertisements**: RSSI (smoothed), TX power, manufacturer data and `present` (0 after the silence set in the parameters) of one chosen device — `watchAdvertisements`, Chrome 85+ (some versions need `chrome://flags/#enable-experimental-web-platform-features`).
- After a disconnect from the device side the node reconnects every 3 s without the chooser (*reconnect*).

Presets: *BLE: Heart Rate Monitor*, *BLE: Find a Beacon by RSSI*, *BLE: UART Terminal*.

### Meshtastic

**Meshtastic (BLE / Serial)** (Sources) talks to a Meshtastic node through its client API — Bluetooth LE (service `6ba1b218-…`) or WebSerial (115200, frames `0x94 0xC3`). The node does the radio and the decryption with its channel keys; the page gets ready messages, positions and telemetry. On connect the node sends its config and the node list.

- **Outputs:** `text` / `from` / `go` / `snr` — incoming chat messages, one per block; `rec` — every packet as a record `{t, kind, id, name, to, ch, snr, rssi, hop, text, lat, lon, alt, battery, voltage, temp, hum, press…}` (kinds: `text`, `position`, `telemetry`, `nodeinfo`, `node` from the config dump, `encrypted` for a channel the node has no key for). Positions of known nodes are added to their other records, so the records go to the *Map* and the *Table* as they are.
- **Input:** `text` is sent to *send to* (`^all` or a node id like `!a1b2c3d4`) on the chosen channel index.
- A node accepts one BLE client at a time: disconnect the phone app first. Not covered: node settings (admin messages).
- The parser is checked against the protobuf layout only (`node tools/test-meshtastic.mjs`), not on real hardware yet.

Preset: *Meshtastic: Chat and Nodes on the Map*.

**Meshtastic Sniffer (LoRa)** (Decoders) is a passive receiver, no node needed: wire *LoRa Decoder*'s `rec` (sync word `2B`) into it. It tries to AES-CTR-decrypt the payload with the channel PSK (base64, comma-separated for several; default `AQ==` — the default public key of the pre-set `LongFast`/`Default` channel, which carries most of the network's open traffic) and, once decrypted, parses it the same way as the live node: text, position, telemetry, nodeinfo, waypoint, traceroute. Frames none of the given PSKs could open (someone else's private channel) are hidden by default (*hide undecrypted*). A channel with its own PSK reads just as well — pass it in.

### MeshCore

**MeshCore Sniffer (LoRa)** (Decoders) is the same idea for [MeshCore](https://github.com/meshcore-dev/meshcore): no node, just *LoRa Decoder*'s `rec` (sync word `12` — the common private/default LoRa sync, shared with other non-Meshtastic LoRa gear too, so content is the only way to tell MeshCore apart). Unlike Meshtastic, most of the packet is plain binary, not protobuf:

- **Advert** (a node announcing itself) is entirely plaintext — public key, name, type (chat / repeater / room / sensor) and an optional position — no key needed. The Ed25519 signature over it (public key ‖ time ‖ app data) **is checked** (the *verify* switch, on by default; pure JS, ~4 ms, repeats come from a cache): the record carries `sig` = `valid` / `invalid`, an invalid one is marked `[BAD SIGNATURE]` in the text and in the node list, and *drop bad signatures* removes it. Without the check a forged advert would pass as a real node.
- **Group text / group data** are AES-128-ECB with a 2-byte HMAC-SHA256 MAC, keyed by the channel PSK (base64; default `izOH6cXN6mrJ5e26oRXNcg==` — the pre-set `Public` channel most clients ship with). Several PSKs, comma-separated, are tried in turn by their 1-byte channel hash.
- Direct messages and anything else keyed by a *recipient's* private key (text, request/response, path, ack, …) cannot be read passively — that needs the node that message was sent to, same as a private Meshtastic channel.

Frames that cannot be MeshCore — version other than 0, a reserved packet type, a group packet shorter than channel + MAC — are false CRC hits of the LoRa decoder and are dropped (counted as *not MeshCore* in the node). Hop count 0 means the node was heard directly (`direct`), more is a relayed copy.

Presets: *MeshCore: Advert Loopback (Generator)* (a signed advert through the LoRa modulator and decoder, no radio) and *MeshCore: Receive (USB SDR, 910.525 MHz)* (USA channel; Europe is 869.525 MHz — check the LoRa settings with your local community).

**Outputs:** `text` / `from` / `lat` / `lon` / `new`, and `rec` — `{t, kind, route, hop, direct, from, name, sig, text, lat, lon, channelHash, psk, encrypted…}`. The parser is checked against the wire format only (`node tools/test-meshcore.mjs`), not on real hardware yet. See also the `meshcore` structure in *HEX Structure* for a field-by-field dump of the header and path without decrypting anything.

