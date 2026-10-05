# DSP workbench

A browser-based modular DSP lab: build signal chains by wiring nodes on a canvas. Runs fully client-side, no build step, works offline as a PWA.

**Live demo: [fagci.github.io/dsp](https://fagci.github.io/dsp/)**

[![FT8 propagation map in DSP workbench — open the demo](docs/screenshots/map-ft8.png)](https://fagci.github.io/dsp/)

[More screenshots ↓](#screenshots)

## Features

### Workbench
- Node graph editor: pan/zoom canvas, drag-and-drop modules, typed ports (signal, number, spectrum, image, text, block, IQ stream)
- Dashboard view (split panes, draggable dividers) for building instrument-like UIs
- **Module graph** pane in the dashboard: the regular node canvas inside a tile, next to the modules opened in other panes (SunVox-style) — see [Module graph pane](#module-graph-pane)
- **Detail levels (LOD)**: double-tap a module's title to collapse it to a compact card (title only), to a **dot** (a circle with initials; the full name shows on hover / when selected) or back to full. Service modules (the auto adapters *IQ → Audio*, *I/Q → IQ*) are added as dots. The **detail** button in the toolbar switches all modules at once: full → compact → dots. The level is saved in patches
- **Quick chain** (**→+** in the toolbar, enabled when one module is selected): the picker opens for the module's free signal output (a module without one — its free signal input, e.g. Sound Card), lists only what fits, connects the new module and selects it, so the next tap continues the chain — a receiver or a patch can be built with taps alone, without dragging wires
- **Module picker**: search takes several words (all must match title / id / category; titles starting with a word rank first). Drop a wire on an empty spot — or select a port and tap an empty spot — and the picker lists only modules that have a matching port, shows which pin the wire will go to and connects it on pick; modules that need an automatic *iq* ↔ signal adapter come after the exact matches. Every module gets a generated icon: initials on the category colour, the shape follows the main output type (circle — IQ, diamond — spectrum, square — records / text / images, hexagon — no outputs)
- Add modules right on the canvas: double-click an empty spot (or **+** in the graph pane) and search
- Groups (nested subgraphs) with custom inputs/outputs
- Undo/redo, duplicate, multi-select, module search (Ctrl+K)
- Save/load patches to local storage or JSON files
- 70 built-in presets: demos, quick scenarios, radio protocols, music, analysis
- Adjustable block size, sample rate and run speed (×1…×32); redraw rate switch in the toolbar: *fps auto* (60 → 30 → 20 fps as the interface sits idle, 10 fps with a USB SDR connected), *fps max* (always 60 fps — the waterfall does not slow down at rest, but the main thread has less time for USB and audio) and *fps min* (10 fps, lightest on CPU)
- AudioWorklet engine, SharedArrayBuffer path when cross-origin isolated
- Installable PWA with offline support

### Sources
- Oscillator, sweep/jammer, constant, LFO, text source
- Microphone (stereo A+B), audio file, audio stream URL, tab/screen audio capture
- **USB SDRs** directly via WebUSB: RTL-SDR, HackRF, Airspy R2/Mini, SDRplay RSP1 / MSi2500, RX-888 (mkI/mkII/mkIII) — multiple tuners/demodulators per device, wideband sweep with a panoramic waterfall, IQ recording and playback in WAV / SigMF (see [USB SDR](#usb-sdr))
- **KiwiSDR** remote receivers (public list included)
- Camera, video, image, accelerometer and Generic Sensor API
- **tinySA / tinySA Ultra** spectrum analyzer over WebSerial: sweep into the spectrum/waterfall, screenshots, signal generator (see [tinySA](#tinysa))
- Serial port (WebSerial), lists, **Data Sequencer** (CSV / KML / GPX / GeoJSON played row by row), Trigger Clock, Time Base — see [Data Sequencer](#data-sequencer)
- **Bluetooth LE** (Web Bluetooth): **BLE UART** (Nordic UART, HM-10 / FFE0 or your own UUIDs — a serial terminal without a cable), **BLE GATT** (any characteristic: notifications or periodic read, write; formats — heart rate, battery, temperature, uint / int / float, hex), **BLE Advertisements** (RSSI, TX power and manufacturer data of one device without connecting — proximity, finding a beacon) — see [Bluetooth LE](#bluetooth-le)
- **IQ over Network**: a remote SDR as an `iq` source — **rtl_tcp** through a TCP → WebSocket bridge (header, rate, tuning, gain, ppm, bias-T, direct sampling are sent as rtl_tcp commands; a wire on the frequency retunes) or a **raw stream** (uint8 / int8 / int16 / float32, rate and center set by hand) from any program that writes IQ to a pipe — see [Remote SDR](#remote-sdr)
- **Gamepad** (Gamepad API): a gamepad, joystick, steering wheel or pedals as numbers — axes `a1…` (with a dead zone) and buttons `b1…` (analog triggers 0…1), the counts are parameters, the device is chosen by index or the first connected one; the `rumble` / `weak` inputs vibrate it. The browser shows the device only after a button is pressed on it
- **HID Device** (WebHID): any USB / Bluetooth HID device without a driver — foot pedals, remote controls, USB scales and sensors, barcode scanners, your own boards (Leonardo / Pro Micro, RP2040). Input reports as hex and as records, one field of the report as a number (offset, format, bit, scale, report id filter), the `send` input writes output or feature reports. Keyboards and mice are closed to WebHID by the browser
- **NFC** (Web NFC, Chrome on Android over https): read NDEF tags — serial number, the first text / URL / JSON record as text, every record as a `rec`; write text, a URL or JSON to a tag (the *Write* button, a pulse on `go`, or a text on the `write` input)
- **MQTT In** (over WebSocket, QoS 0/1, username/password, auto-reconnect): subscribe to topic filters (`+` / `#`); a message comes out as text, topic, a number (the payload itself, or a JSON field — `temp.value`) and as records (a JSON object or array becomes `rec` with the topic added, so Tasmota / ESPHome / Home Assistant sensors with lat / lon go straight to the map). The browser cannot open `mqtt://` itself: give the broker a WebSocket listener (Mosquitto `listener 9001` + `protocol websockets`, EMQX, HiveMQ, the Home Assistant add-on); from the https page only `wss://` works — see [MQTT](#mqtt)
- **Text over Network**: WebSocket (`ws://`, `wss://`, with reconnect and a `send` input) or HTTP(S) polling; lines one per block like the serial port, JSON objects/arrays straight into records. Example — Wi-Fi scan from Android (Termux): `websocat -t ws-l:0.0.0.0:8765 sh-c:'while :; do termux-wifi-scaninfo | jq -c .; sleep 30; done'`. [`tools/termux/wifi-scan.sh`](tools/termux/wifi-scan.sh) adds the phone's GPS position to every scan — preset *Wi-Fi: Locate Access Points (Termux)* puts each access point on the map while you walk around. From the https demo the browser only allows `wss://`/`https://` to other devices (`ws://`/`http://` work to localhost, or when the app is opened over http)

### Analysis
- Spectrum analyzer / waterfall (optional phosphor view; the waterfall keeps its history at full resolution, so zoom, dB range and palette changes redraw it without losing detail), persistence spectrum, oscilloscope (auto/normal/single trigger with level, slope, position, hysteresis and holdoff; sub-sample trigger alignment, averaging, persistence, sin(x)/x interpolation, XY, math channel, AC/DC coupling, time/level cursors, automatic measurements, Autoset, Run/Stop with history scroll), constellation, eye diagram
- CFAR signal detector (noise estimate in linear power: OS — 75th percentile, robust to strong neighbours; SO — smallest of the two sides; CA — mean; a target is shown after M hits in the last N spectrum frames, so single noise spikes are dropped; outputs SNR of the strongest target and the noise floor), channel SNR, channel grid, band scanner, auto frequency scanner
- Band plans, bookmarks, signal recognition
- **Blind analysis of an unknown transmission**: *Baud Estimator*, *CMA Equalizer*, *Sync Word Hunter*, *Conv Code Finder*, *CRC Finder* and a test transmitter *Unknown Signal* — from raw IQ to the message without knowing the symbol rate, the sync word, the code or the checksum (see [Blind analysis](#blind-analysis))
- **Signal type identifier**: finds every signal in a spectrum from any source and names its modulation — on an SDR from the raw IQ (see [Signal type identifier](#signal-type-identifier))
- Goertzel, autocorrelation, cross-correlation, frequency response / coherence
- Harmonics & THD, third-octaves, LUFS-like loudness, level statistics, spectral descriptors
- Impulse response & RT60, bird song analyzer, frequency meter, trend charts

### Processing
- Filters, gain, mixers (4/12 ch), AGC, squelch, mains notch, adaptive hum canceller (tracks mains frequency, all harmonics), comb notch, adaptive filter, spectral denoiser
- FFT, Zoom-FFT (I/Q), Hilbert transform, quadrature shift, magnitude/phase, wavelet (constant-Q), cepstrum
- Beamformer, phase scope (X-Y), envelope, calibration, capture & loop
- Audio effects: delay, reverb, distortion, compressor/limiter, EQ, chorus/flanger/phaser, pitch shifter

### IQ blocks
- **IQ stream** wires carry complex (or real) samples at their own sample rate, not the engine's — build a receiver from blocks: source → frequency shift → decimator → demodulator → IQ → Audio (see [IQ blocks](#iq-blocks))
- USB SDR `iq` output (raw IQ at the native rate, also from IQ file playback), IQ generator, IQ spectrum, ADS-B demodulator, PSK (QPSK/OQPSK) demodulator

### Modulation & radio
- AM/FM/SSB demodulator, FSK demodulator, generic modulator
- Carrier acquisition, matched filter, symbol sync
- OFDM modulator/demodulator, chirp modem (transmit/receive)
- HF propagation, WWV/WWVH/CHU time decoder
- Doppler radar, 2D chirp radar, monostatic sonar

### Infrared
- **IR Encode / Decode / Learn** — NEC, NEC-ext, Samsung, Sony SIRC 12/15/20, RC5, RC6, JVC, Panasonic; unknown frames (air conditioners) are broken down into header, pulse lengths and bytes; any code can be stored and replayed. The nodes know nothing about the hardware, the adapters do: sound card (**IR Sound TX / RX**) and a serial port (**IR Serial**: Arduino / ESP / Pico, Flipper Zero) — see [Infrared](#infrared-1)

### Digital modes & decoders
- FT8, RTTY, Morse (TX/RX, including from camera), DTMF, PSK31, Feld Hell
- Olivia, Contestia, AX.25/APRS (TX/RX)
- WEFAX, NOAA APT, SSTV-style raster
- HFDL: full receive chain down to ACARS / ADS-C, aircraft tracks and ground stations on the map
- **ADS-B / Mode S** (1090 MHz) from raw SDR IQ: aircraft on the map with callsign, altitude, speed and heading (see [ADS-B](#ads-b))
- GSM: downlink physical-layer receiver from raw IQ — FCCH tone sync, SCH decode (BSIC + frame number), GMSK burst extraction (see [GSM](#gsm))
- **Meteor-M LRPT** (137 MHz) from raw IQ, frame level: QPSK/OQPSK demodulator, CCSDS decoder (Viterbi K=7, NRZ-M, ASM, derandomizer, RS(255,223)×4) → VCDU frames → **MSU-MR image** (packets, JPEG-like 8×8 segments, RGB composites, PNG) (see [Meteor-M LRPT](#meteor-m-lrpt))
- **Radiosondes: Vaisala RS41** (400–406 MHz) from raw IQ or FM audio: serial, position, height, climb, speed, temperature, humidity → map (see [Radiosondes](#radiosondes-rs41))
- **Inmarsat STD-C** (1.5 GHz): BPSK 1200 → frames → packets → SafetyNET / FleetNET EGC messages (see [Inmarsat STD-C](#inmarsat-std-c))
- **MPT 1327** (analogue trunking control channel): FM → FFSK 1200 Bd → codewords with CRC → PFIX/IDENT (see [MPT 1327](#mpt-1327))
- **ISM 433 MHz** (sensors, remotes, doorbells; OOK and FSK): pulse train → PWM / PPM / Manchester → EV1527/PT2262, Nexus, or an unknown packet with timings and bits (see [ISM 433](#ism-433))
- **ACARS** (VHF 131 MHz, AM + MSK 2400 Bd): envelope → MSK → blocks with CRC and parity → aircraft registration, label, flight, text (see [ACARS](#acars))
- **Digital Voice Decoder** — one decoder for **DMR, P25 Phase 1, NXDN 9600 and 4800, YSF, M17, D-STAR and dPMR**: the protocol is found by its sync words (or picked by hand), records and raw vocoder frames on separate outputs, turned into sound by the mbelib [Vocoder](#vocoder-mbelib) (see [4FSK Digital Voice](#4fsk-digital-voice))
- **TETRA** (base-station downlink, π/4-DQPSK 18 kBd, 25 kHz channels): sync burst → cell (MCC / MNC, colour code, frequency, location area, services), slot timing, AACH, calls by usage marker, MAC-RESOURCE addresses and channel allocations, names of LLC / MLE / MM / CMCE messages, SDS text / status / positions (Messages, Subscribers, map), speech of traffic slots (see [TETRA](#tetra))
- **DMR** (Tier II / III, repeater, mobile or direct mode): 4FSK 4800 Bd → colour code, time slots, voice calls (from → to, emergency, encrypted, talker alias), CSBK, data and SMS, raw AMBE+2 frames (see [DMR](#dmr))
- **Analog video** (FPV 5.8 GHz, broadcast and satellite TV) from raw SDR IQ: FM / AM demodulator → composite video → line and field sync, PAL / NTSC, colour, interlace → picture (see [Analog video](#analog-video))
- Building blocks: CRC, scrambler, interleaver, convolutional encoder / Viterbi, sync word search, async serial, NRZ clock, text ↔ bits

### Music
- Synths (2 osc, 4 voices), acid bass (303), drum sequencer, sample library with an audio editor (see [Sample editor](#sample-editor))
- **Tracker**: plays and edits MOD (ProTracker), S3M (Scream Tracker 3) and XM (FastTracker 2); split into graph nodes: song, single channels, instruments played by your own generator modules, pattern view, and every editor panel as its own node — lay them out in dashboard tiles as your own Renoise-style editor (see [Tracker](#tracker))
- **Sampler**: polyphonic (4 voices) player of Sample Library clips, pitched by `freq` — plays from the tracker, piano roll or MIDI
- Piano roll, step sequencer, generative melody, arrangement playlist, master clock
- MIDI keyboard input, ADSR envelope

### Output & extensibility
- Sound card output (per-node output device selection, peak/clip meter), WAV / MP3 recording (files named by date and time; optionally streamed straight to a disk file, so the length is not limited by memory — Chrome/Edge), CSV log, trigger recorder
- Sound card output (per-node output device selection, peak/clip meter), WAV / MP3 recording (files named by date and time), CSV log, trigger recorder
- **Network Out**: WebSocket (`ws://`, `wss://`, reconnect) — text on change, numbers as a JSON object every period, or mono PCM16 audio (a JSON header first, then binary blocks). Example: `websocat -s 8765` on the receiving side
- **Map** (offline vector base map, optional OSM tiles, tracks, markers — see [Map and records](#map-and-records)), screen transmitter, indicators
- **Notify**: speaks a text aloud (speech synthesis), shows a system notification and/or vibrates — on a new text or a `go` pulse, with a minimum gap between alerts (e.g. a decoded message or a CFAR detection → voice alert)
- **MQTT Out**: publish text or a number (template `{v}` / `{v:N}`) on change; topic from a parameter or a wire, QoS 0/1, retain. Example — an IR blaster on Tasmota: *IR Encode* (output format «tasmota mqtt») → MQTT Out `cmnd/<device>/IRsend`
- **Serial Out (WebSerial)**: write text or a numeric value to a serial port — Arduino, relays, transceiver CAT control (template `FA{v:11};` turns a frequency into a Kenwood command); device replies come back on the `reply` output
- **HTTP Out**: webhook request (POST / PUT / GET, custom headers) — text on change, or numbers as a JSON object on a `go` pulse or every period. The server must allow CORS, and from the https demo only `https://` (or localhost) works
- **MIDI Out** (Web MIDI): `gate` → note on/off, `note` (or `freq` in Hz straight from *MIDI Keyboard*) with velocity, and a `cc` input for control change — drive hardware synths and a DAW from any signal
- Module Builder and Script nodes for writing custom DSP code in the browser

## USB SDR

The **USB SDR** node talks to the receiver directly over WebUSB (Chrome, Edge, Opera), no drivers or native software needed. Up to 4 demodulator channels share one device.

Modes: WFM (stereo, RDS), NFM, AM, SAM, USB, LSB, raw IQ. **SAM** (synchronous AM) locks a PLL onto the carrier and detects coherently: less distortion during selective fading, and **SAM sideband** = USB/LSB keeps only one sideband to dodge interference on the other. In AM/SAM/SSB the tuner is always parked sr/4 away from the channel, so the DC spike never lands on the carrier.

For HF: **noise blanker** cuts short impulses (power-line, switching supplies) on the raw wideband IQ before the channel filter, where a pulse is still short; **auto notch** (NLMS predictor) removes steady whistles/heterodynes from AM/SAM/SSB audio; **SAM sideband = ISB** puts the upper sideband in the left channel and the lower in the right, so you hear which side the interference is on.

| Device | Sample rate | Samples | Linux kernel modules to unload |
|---|---|---|---|
| RTL-SDR (RTL2832U + R820T/R828D, incl. Blog V4) | up to 3.2 MSPS | 8 bit | `dvb_usb_rtl28xxu` |
| HackRF One / Jawbreaker / rad1o | 2–20 MSPS | 8 bit | `hackrf` |
| Airspy R2 / Mini | rates reported by firmware | 12 bit | `airspy` |
| SDRplay RSP1 and clones, MSi2500 + MSi001 TV sticks | 1.3–15 MSPS | 14 bit up to 6 MSPS, then 12 / 10 / 8 bit | `msi001`, `msi2500` |
| RX-888 mkI / mkII / mkIII (SDDC, Cypress FX3) | 0.25–10 MSPS out of a 16-bit ADC at up to 66 MSPS | 16 bit ADC, DDC in the browser | — |

Common controls: gain (auto or manual), bias-tee, ppm correction, center shift off DC. Manual gain works only with *auto* off — moving the gain slider (or wiring its input) switches *auto* off by itself. On R820T / R828D (incl. RTL-SDR Blog V4) the LNA and mixer steps follow librtlsdr's table exactly (29 steps, 0–49.6 dB, VGA 16.3 dB); the slider rounds up to the next step.

**ADC overload**: the status line shows the ADC peak and mean power in dBFS over the last ~0.5 s, and **⚠ OVERLOAD** (held for 3 s) when more than 0.01% of I/Q samples sit on the ADC rails. With an 8-bit RTL-SDR a strong local station easily does that, and the spectrum then fills with intermod products that are not real signals — lower the gain until the warning goes away; a mean level around −30…−15 dBFS is usually a good spot. Outputs `adcPk`, `adcRms` (dBFS), `clip` (% of samples) and `ovl` (0/1) let a patch react, e.g. gate a detector or step the gain down.

The `spec` output uses all the IQ that arrives between updates, not one FFT frame: frames overlap by 50% and their power is averaged (Welch's method, **spectrum averaging** sets the maximum number of frames, `all` by default). At 2.4 MSPS with a 4096-point FFT that is ~90 frames per update, so the noise floor spread drops from ~±5 dB to ~±0.5 dB and weak carriers stand out; detectors (CFAR, channel SNR) can run with a lower threshold. Levels are in dBFS: 0 dB is a full-scale complex tone, whatever the window.

**Signal level and squelch** (per channel): RSSI is the power inside the channel filter in dBFS (for FM and SSB a separate sharp band filter is used for the measurement, so neighbours in the transition band don't count); SNR is taken from the spectrum — mean level inside the channel against the quieter of the two bands just outside it, so a busy neighbour on one side does not raise the noise estimate. **squelch** mutes a channel by `SNR` (does not depend on gain) or by `level` (RSSI threshold, dBFS), with 3 dB hysteresis and a **hang** time; the gate is applied to the audio exactly at the chunk the level was measured on. Outputs `rssi`/`snr` (and `rssi2…4`, `snr2…4` for the other channels) and `sqOpen` for channel 1, e.g. to start a recorder. On a Spectrum Analyzer wired to `spec` the channel band shows the squelch in the trace's own scale: a dashed line at the threshold and a solid line at the current mean level in the channel (solid above dashed — open, the band label says `SQL open/closed`); a marker sitting on a channel shows that channel's RSSI (dBFS) / SNR — exactly the numbers the squelch compares — instead of the peak level around the marker.

Fine marker tuning (e.g. SSB): the mouse wheel over a marker's label moves it by 10 Hz (Ctrl — 1 Hz, Shift — 100 Hz); dragging the label moves it at 1/10 of the normal pan speed; clicking the active marker's label asks for an exact frequency.

- **HackRF** has separate LNA / VGA / amp controls instead of the gain slider.
- **HackRF TX** (IQ category): transmits any `iq` stream. The air frequency is the stream's centre frequency plus the signal offset, e.g. in IQ Generator / IQ Modulator `fc` + `off`; the sample rate also comes from the stream (2–20 MS/s). Keep `off` away from 0 (e.g. 100 kHz): HackRF has a carrier spike at the centre. Audio → radio: *any audio node → **IQ Modulator** (AM / NFM / WFM / USB / LSB, audio ±1 = full deviation or depth) → HackRF TX*; for baseband I/Q already in the engine use *I/Q → IQ*. The node has TX VGA (0–47 dB) and amp +14 dB, both off by default. It takes the whole device, so do not keep the same HackRF open in USB SDR. If the stream is slower than the USB, zeros (no carrier) go out and *underruns* counts them. **You must comply with local radio regulations: transmit only where and how the law allows.** Transmission is also switched by the **`tx` pin** (a number ≥ 0.5 = on): it starts on a rising edge (a pin that is already high when the patch loads does nothing), stops on a falling edge or when the wire is removed. Safety: with no data for 0.4 s (graph stopped, source silent) the driver turns the RF path off completely — a stream of zeros would leave the LO carrier — and transmits again when data returns; removing the node, Disconnect, Stop and closing the tab all send the stop command (on a crash or USB unplug the firmware cannot be told, so check the transmitter after one). Test into a dummy load with the amp off.
- **SDRplay / MSi2500** has no hardware AGC: *auto* sets a fixed 62 dB, the manual slider covers 0–102 dB of LNA + mixer + baseband gain. The driver is a port of [libmirisdr-4](https://github.com/f4exb/libmirisdr-4). RSP1A (`1df7:3020`) / RSP2 IDs are recognized but untested; RSPduo, RSPdx and newer models need the closed SDRplay API and are not supported. On Android Chrome an RSP1 may expose only alternate setting 0 (no streaming endpoint), so it works on desktop only; try a direct OTG cable without a hub.
- **RX-888** (and other SDDC boards: HF103, BBRF103): on power-up it is an empty Cypress FX3 boot loader; Connect uploads the firmware (`vendor/SDDC_FX3.img` from [ExtIO_sddc](https://github.com/ik1xpv/ExtIO_sddc), MIT) and the board comes back as a new USB device — if the browser does not pick it up by itself, press Connect again and choose it. On HF the ADC samples the antenna directly: the ADC clock is the sample rate × 2^k (up to 66 MHz over USB 3, 16 MHz over USB 2), and HF is everything below half of it — 1.024, 2.048 or 8 MSPS give the whole 0–30 MHz, 2.4 MSPS only up to 19 MHz, and tuning and decimation to the selected sample rate run in the browser (NCO + half-band filters, 80 dB alias rejection) spread over several workers. Above the ADC's Nyquist frequency the VHF tuner is used (R820T / R828D; mkIII — RDA5815 from 220 MHz). Gain on HF: the slider first removes the 0–31.5 dB attenuator, then raises the AD8370 VGA; *auto* = no attenuation, +10 dB VGA. On Windows the board needs the WinUSB driver (Zadig) for both the boot loader and the running device. Untested on real hardware yet.

On Linux unload the kernel driver before connecting, e.g. `sudo rmmod msi001 msi2500`, or blacklist it in `/etc/modprobe.d/`. The device also needs user access through a udev rule (as for `rtl-sdr` / `hackrf` / `airspy` packages).

### Wideband sweep

**wideband sweep** turns the node into a panoramic scanner (like `rtl_power` / `hackrf_sweep`): the receiver steps across **sweep from … to** (MHz), each step keeps the central **usable band fraction** of the FFT (the edges are rolled off by the anti-alias filter), and the pieces are stitched into one spectrum on the `spec` output. A Spectrum Analyzer on it shows the whole range; its waterfall gets one line per full pass. The readout shows the current step and seconds per line.

- **sweep FFT size** sets the resolution (sample rate / size per bin), **averages per step** — how many FFT frames are averaged (or max-held with the **max** detector) at each step
- a marker on `tuneFreq` (e.g. marker 1 of the Spectrum Analyzer wired to it) pauses the sweep and tunes there: the demodulators play as usual and the live spectrum is drawn over its part of the panorama; remove the marker to resume from the same step
- use manual gain: with AGC each step gets its own level and the waterfall is striped. **shift center off DC** keeps the listened station away from the DC spike
- the speed depends on the retune time over USB: roughly 20–50 ms per step, i.e. a few seconds per line for 100 MHz at 2.4 MSPS and ~30–45 s for the whole RTL-SDR range. A HackRF at 20 MSPS covers ~8× more per step
- the Spectrum Analyzer keeps the waterfall history at full resolution (**waterfall history memory**, 128 MB by default), so zooming into an old part of the panorama shows the real bins, not stretched pixels. Over the budget the oldest lines keep only a max-decimated copy
- ready-made patch: **USB SDR: Wideband Sweep**

### IQ recording and playback

- **● Record IQ** writes the stream to a temporary file in the browser's site storage (OPFS, so long recordings don't sit in memory; without it — up to 1 GB in memory); **■ Stop recording** opens the save dialog (or downloads the file). If saving was cancelled or the recording stopped on its own (error, disconnect), press Stop again to save it
  - **WAV** — 2-channel 16-bit PCM with the plain 44-byte header SDR++ expects (8-bit sources are widened to 16 bit); center frequency in the file name (`baseband_<Hz>Hz_…`, SDR++) and in an `auxi` chunk after the data (SDR#, HDSDR); limited to 4 GB
  - **SigMF** — `.sigmf` archive (`.sigmf-data` + `.sigmf-meta`), retuning while recording adds a new `captures` segment
- **Open IQ file…** plays a recording through the same chain (spectrum, 4 channels, demodulators) in real time, with loop and position controls
  - WAV (8/16-bit PCM, 32/64-bit float), SigMF archive or `.sigmf-meta` + `.sigmf-data` pair (`cu8`, `ci8`, `ci16_le`, `cf32_le`, `cf64_le`)
  - raw `.cu8` / `.cs8` / `.cs16` / `.cf32` / `.cf64` (e.g. `rtl_sdr` output; the format is guessed from the extension or set by **IQ file format**): frequency and rate are taken from the file name (`…_433920000Hz_2.4Msps.cf32`), otherwise from the node settings

## Remote SDR

The **IQ over Network** node gives the same `iq` output as the USB SDR, so every IQ block (shift, decimator, demodulators, spectrum, decoders) works on a receiver that sits somewhere else: a Raspberry Pi on the roof, a server, another PC. A browser cannot open TCP sockets, so the receiver's stream goes through a small bridge to WebSocket; from the https page only `wss://` works, from a local copy over http `ws://` too.

- **rtl_tcp**: on the machine with the RTL-SDR run `rtl_tcp -a 0.0.0.0 -s 1024000` and a bridge next to it, e.g. `websockify 8766 127.0.0.1:1234` (any proxy that passes bytes will do), enter `ws://host:8766`. The node checks the `RTL0` header, shows the tuner (R820T…), sends the sample rate, frequency, gain (0 — auto), ppm, RTL AGC, bias-T and the direct sampling branch, and sends again whatever changes — also when a wire drives the frequency (the stream is tagged `retune`).
- **raw stream**: bytes of interleaved I / Q with the format, sample rate and center frequency set by hand. Examples: `rtl_sdr -f 100e6 -s 1024000 - | websocat -b -s 8766`, `hackrf_transfer -r - -f 100000000 -s 2000000 | websocat -b -s 8766` (set *int8*), GNU Radio or SoapySDR with a pipe sink, your own script. Samples that arrive cut in the middle (a byte boundary in a WebSocket message) are put together.
- The queue holds 2 seconds; when the page cannot keep up the oldest data is dropped, the stream is tagged `gap` and the overflow counter in the readout grows. The readout shows the real received rate next to the set one.

Preset: *Remote SDR: FM Receiver (rtl_tcp over WebSocket)*. SpyServer, SoapyRemote and other protocols with their own framing are not supported yet.

## tinySA

The **tinySA** node talks to a tinySA or tinySA Ultra over its USB serial console (WebSerial, Chrome/Edge). Wire `spec` to a Spectrum Analyzer to get the trace and a waterfall in dBm.

- **start / stop / points** — sweep range and resolution; `scanraw` (binary, any number of points) is used by default, **transfer format → text** falls back to `scan` (up to 290 / 450 points). Old firmware without `scanraw` is switched to text automatically
- **RBW**, **attenuation**, **spur removal**, **LNA** (Ultra) are sent to the device when changed; **hold** pauses sweeping
- `start` / `stop` inputs (Hz) set the range; `steerFreq` (from `centerFreq` of the Spectrum Analyzer) moves it while keeping the span, so dragging the spectrum pans the tinySA
- outputs: `peakF` / `peakDb` — the highest point of the last sweep
- **Screenshot** reads the device screen (`capture`) to the node and the `img` output, **Save PNG** downloads it
- **gen** (signal generator mode) — `mode low|high output`, frequency, level and **RF on**; `genFreq` (Hz) and `genLevel` (dBm) inputs let the graph drive it (e.g. a stepped frequency sweep)
- ready-made patch: **tinySA: Spectrum**

## Signal type identifier

The **Signal Type Identifier** (`sigid`) node labels every signal it finds and suggests a decoder for it. It doesn't care where the signal comes from:

- `spec`: a spectrum from any node (USB SDR, FFT, tinySA…). The node finds the signals and classifies them by shape: bandwidth (99% power), flat top, carrier over the sidebands, which sideband holds the energy, and on/off keying over time
- USB SDR: the node also reads the **raw IQ at the native sample rate** that comes with the spectrum. It takes one signal at a time, shifts it to zero, decimates it and measures the envelope, the instantaneous frequency, the lines in z, z² and z⁴, and the keying rate. The heavy part runs in a Web Worker
- `in`: audio (microphone, KiwiSDR, a receiver's output). Without `spec` the node computes its own spectrum, and it analyses the audio samples the same way
- **whole spectrum** / **search range**: limit where signals are looked for. The `fmin` / `fmax` inputs set the range too, e.g. from a Band Plan's `lo` / `hi`, so clicking a band limits the search to that band. A new value on these inputs unticks **whole spectrum**
- `plan`: a band plan for context. Its label is shown next to each signal, and a matching mode adds some confidence

What it recognises: carrier, CW (with WPM), OOK, AM, USB/LSB, NFM (with CTCSS tone), WFM (with the stereo pilot), 2-FSK / 4-FSK with shift and baud (RTTY, AFSK 1200 / APRS, POCSAG, DMR/P25-like 4800 Bd), MFSK (FT8-like, Olivia/Contestia-like), BPSK / QPSK with symbol rate (PSK31…), OFDM, DTMF keys. Each result says whether it came from the spectrum or from the samples. It is a heuristic, not a decoder.

The `bands` output carries the labels. Wire it into a Spectrum Analyzer's `bands`, or into a **Band Plan**'s `sigs` so the labels show together with the bands: each signal gets a bracket at its peak level with its type above it.

Ready-made patches: **USB SDR: Signal Identifier**, **HF: Quick-Decode All Protocols**.

## Blind analysis

Nodes for taking apart a digital transmission whose parameters are not known. Each one prints what it found in its readout; wires carry the result on (a symbol rate to the filter and the slicer, frames to the next finder). The preset *Unknown Signal: Blind Analysis (Generator)* has the whole chain wired and a test transmitter in front of it.

`IQ → Baud Estimator → [CMA Equalizer] → FM Discriminator → RRC → Symbol Slicer → Sync Word Hunter → Conv Code Finder → CRC Finder → Block Viewer`

- **Baud Estimator** (`blindBaud`, Analysis, worker): the symbol rate of any IQ or real stream. Symbol edges give the spectrum of four features — the envelope, jumps of the envelope, jumps of the frequency, jumps of the complex sample — a line at the symbol rate (random NRZ data has no such line itself, the jumps do). Welch-averaged spectra, a peak search between *min* and *max*, harmonics folded to the fundamental (a line at f/2 or f/3 counts only when it is not weaker than −3 dB), the features vote. Outputs `baud` (held: it changes only after a shift of more than 0.3 %, so the slicer behind it is not restarted by every refinement; empty until a peak stands *thr* dB above the noise, so a wire from it leaves the downstream value alone), `conf` (dB), `sps`. Tested on 2FSK, GFSK, BPSK and QPSK from 1.2 to 19.2 kBd: the error is below 0.02 %.
- **CMA Equalizer** (`blindEq`, IQ, worker): a blind equalizer for constant-modulus signals (FSK, GMSK, PSK without a pulse shape, FM): y = Σ w·x, w ← w − μ·y(|y|² − 1)·x*. The echo of a multipath channel spoils the modulus of the envelope, the equalizer brings it back without knowing the data. The readout shows the dispersion of the modulus before → after (0.18 → 0.004 on 2FSK with a 0.35 echo). *taps* are at the stream rate (about 4 symbols × samples per symbol); *freeze* stops the adaptation.
- **Sync Word Hunter** (`syncHunt`, Protocols, worker): the input is the stream of symbols at the symbol rate (output of *Symbol Slicer*; *levels* 2 — a bit per symbol, 4 — a dibit). All words of *len* bits in the last *depth* bits are counted; candidates are the words that repeat at the same distance. Each candidate grows to the common run of all its repeats (preamble + word + a constant header), the alternating preamble is stripped (whole bytes) and the rest is the sync word; a run with a preamble wins, then the longest. The locked word stays while it is in the window. Frames of *period − word* bits (or *flen*) are cut after every match (*tol* bit errors) and go to `blk`; the frames of the window at the moment of the lock are replayed. `word` set by hand skips the search.
- **Conv Code Finder** (`convFind`, Protocols, worker): the frames of a convolutional code of rate 1/2 or 1/3, constraint length 3…9, polynomials in the usual octal notation (171, 133 for K=7). The streams of the outputs obey g_j·c_i = g_i·c_j whatever the data was, so the test does not need to know it: all pairs of polynomials are checked by that syndrome (about 0.1 s per pair of streams and bit phase, one such step per engine block). The true pair agrees over the whole message, a false one only over constant headers: the ranking is by the accumulated excess of agreement, then the shortest K (multiples of a pair agree as well; a wrong bit phase gives K + 1). The end of the coded part comes from the change point of that sum and, when the frame ends with K−1 zero bits (*tail*), from the minimum of the zero-state path metric. A candidate is accepted only if the Viterbi decoder leaves ≤ 7 % errors on real frames (uncoded text or random bits fail). Outputs `blk` — decoded frames — and `found`, `k`. An inverted output and bit errors (up to about 2 %) are fine; puncturing is not supported.
- **CRC Finder** (`crcFind`, Protocols, worker): the frames end with a checksum. A catalog of 51 CRC models (CRC-8, 16, 24, 32; every model is checked against the check value of "123456789") and four plain sums is tried with MSB- and LSB-first bytes, big- and little-endian, *maxSkip* header bytes the sum does not cover, optionally bit offsets 0–7, and up to *tail* extra bytes after the checksum (a pause, the next preamble). Not in the catalog: an unknown 8- or 16-bit polynomial is searched from frames of one length — a CRC is linear, so crc(a) ⊕ crc(b) = raw(a ⊕ b) whatever the init and xorout are; init and xorout are then given as the pair that fits that length. Outputs `blk` (frames without the checksum, only those that pass), `ok`, `found`.
- **Unknown Signal** (`blindGen`, IQ): a test transmission with known parameters: 2FSK, GFSK, BPSK or QPSK, preamble + sync word + message + checksum (a catalog CRC) + optional convolutional code (K=3, 5, 7, 9; rate 1/3 with K=7), random bits between frames, noise and an echo (gain, delay in symbols, phase). The `tx` output carries the frames as they were sent.

What was checked: every node against the generator and, for the finders, against synthetic frames with bit errors (the whole chain finds 9600 Bd 2FSK, B38D2E5A, K=7 (171, 133) and CRC-16/X-25, also with K=3/5/9, rate 1/3, GFSK, CRC-8/16/32 and without a code; the sync, code and CRC searches do not fire on random bits or uncoded text). **Not checked on a real recording.** No PSK demodulator is in the chain (the estimator works on PSK, the hunter takes symbols from a slicer); the finders search a code and a checksum by their algebra only — frames with burst errors, scramblers and interleavers have to be undone first.

## GSM

The **GSM: Receive Bursts (IQ)** (`gsmRx`) node is a downlink physical-layer receiver, ported from [gr-gsm](https://github.com/ptrkrysik/gr-gsm) (GPLv3) and [libosmocore](https://github.com/osmocom/libosmocore) (GPLv2+). It takes an **IQ stream** and locks onto a C0 (BCCH) carrier the way a real receiver does:

- resamples the input (any rate ≥ ~1.08 MS/s) to 4×270.833 kS/s (cubic interpolation), with an internal frequency-correction loop
- **FCCH**: finds the frequency-correction bursts (a pure tone) and pulls the carrier onto centre
- **SCH**: estimates the channel from the extended training sequence, detects the burst with an MLSE (Viterbi) equaliser, then convolutionally decodes and CRC-checks it — giving the **BSIC** (NCC/BCC) and the **frame number** (`t1/t2/t3`)
- once synchronized, it steps through the 51-multiframe on TS0, extracts every burst (FCCH / SCH / normal / dummy) with the same equaliser, and outputs them as **148 soft bits** on the `burst` port (a `blk` carrying its frame number and timeslot)
- it also decodes the **BCCH System Information**: four normal bursts on TS0 (frames 2–5) → de-interleave → convolutional decode (xCCH) → FIRE CRC → RR message. From **SI Type 3** it reads the **Cell ID** and the **Location Area Identification** (MCC/MNC/LAC), from SI4 the LAI — i.e. it identifies the cell, not just its BSIC

Outputs: `rec` (records for the log/map — SCH sync with BSIC, and BCCH cells with `id` = `PLMN-LAC-CID`, plus `ci`, `mcc`, `mnc`, `lac`, frequency, dBm and time), `burst` (per-burst bits), `freq` (current offset estimate, Hz), `sync` (1 when locked). Tune to a GSM900 BCCH (935–960 MHz) or DCS1800 (1805–1880 MHz).

To keep a **list of cells**, wire `rec` into **Rec: Unique by Key** (`recUniq`, key = `id`): it keeps one row per cell with a hit count and first/last time, and saves to CSV / GeoJSON. The node is generic — it dedups any records by any field (aircraft by ICAO, stations by callsign, …).

The heavy parts (SCH and xCCH convolutional codes + CRC/FIRE, BSIC/frame-number and SI3 Cell ID / MCC-MNC-LAC parsing, channel estimation + MLSE burst detection, FCCH tone detection and offset estimation) are covered by smoke tests on synthetic bursts; on-air reception is untested on real hardware yet. It stops at System Information — traffic channels are not decoded.

Ready-made patch: **GSM: Receive Bursts (USB SDR)** (spectrum → tap a channel → receiver → cell list → log).

## IQ blocks

A wire of the **IQ** type (lime) carries a stream at its own sample rate: each engine block it brings as many samples as the source produced since the previous block (none, one chunk or several), together with the stream's sample rate and center frequency. So a chain can run at 2.4 MS/s next to audio at 48 kHz, and a receiver is wired from blocks instead of being hidden inside the SDR node.

- **IQ Generator** — a test signal (carrier, AM, FM, **WFM stereo** with a pilot and RDS station name — the tone in the left channel only, to check separation — USB, LSB, **ADS-B** — DF17 frames from three simulated aircraft, **LRPT** — Meteor-M CCSDS frames with an MSU-MR test picture, OQPSK + NRZ-M or QPSK, **RS41** — a radiosonde going up, **STD-C** — an Inmarsat-C TDM carrier with EGC warnings, **MPT1327** — a control channel with test codewords, **ISM433** — OOK or 2-FSK telegrams of a Nexus-type sensor, an EV1527 remote and an unknown Manchester packet, **DMR** — a repeater downlink with a voice call, CSBK and text messages, or a mobile uplink / direct-mode signal, **4FSK** — a test transmitter per digital voice protocol: P25 voice and control channel, NXDN, YSF, M17, D-STAR, dPMR, **TETRA** — a test cell: sync burst, control channel with addresses and messages, a call in slot 2, **Analog TV** — a PAL / NTSC test card, FM or AM, at 8–20 MS/s) at an offset from the center, plus noise; sample rate up to 2.4 MS/s (up to 20 MS/s for Analog TV). *clock error, ppm* simulates a source whose clock differs from the sound card
- **USB SDR → `iq`** — the raw IQ at the native rate (live or from IQ file playback); samples of the old frequency after a retune are not passed on. The USB buffers go on as they are (8 or 16 bit) and are turned into floats by whoever reads them — for an IQ chain in a worker that happens in the worker, not on the main thread
- **IQ Frequency Shift** — brings `freq` (absolute Hz, e.g. marker `f1` of a Spectrum Analyzer) or center + *offset* down to 0 Hz
- **IQ Decimator** — windowed-sinc FIR (Blackman) and decimation by 2…64; *cutoff* is a fraction of the output rate. Works on complex and real streams
- **IQ Interpolator** — the reverse: raises the sample rate by 2…64 (zero-stuffing + polyphase FIR, gain compensated), the centre frequency is unchanged; *cutoff* is a fraction of the input rate (images are about −70 dB). Use it to feed a narrow band to a wideband sink: *IQ file → Frequency Shift → Decimator → … → Interpolator → Frequency Shift → HackRF TX* re-transmits one cut-out channel (HackRF TX needs ≥ 2 MS/s, so e.g. 48 kS/s × 50 = 2.4 MS/s). The shifts set the air frequency: the stream centre `fc` is what HackRF tunes to, the signal sits at its offset from it
- **IQ Demodulator** — everything the USB SDR's own demodulator does, as a block. `out` is the audio as a real stream, `stereo` a complex one (re — left, im — right; mono duplicated), so IQ → Audio gives L on `out` and R on `q`
  - **FM** — deviation, 50/75 µs de-emphasis
  - **WFM** — 75 kHz; stereo from a PLL on the 19 kHz pilot (switched in smoothly when locked), **RDS**: station name and radiotext on the `ps` / `rt` outputs and in the readout; audio low-passed at 15 kHz and decimated to ≥ 40 kS/s. Feed it ~150–260 kS/s
  - **AM** — with AGC the output is the modulation depth (level does not depend on signal strength)
  - **SAM** — synchronous AM: a PLL on the carrier (wide to acquire, narrow when locked, holds phase through fades), coherent detector; sideband both / USB / LSB / **ISB** (upper → left, lower → right on `stereo`). `lock` output, carrier offset in the readout
  - **USB / LSB** — Weaver, 8th-order filter, peak AGC (instant attack, 0.3 s hold, 0.4 s release)
- **IQ DC Block** — removes the LO spike of zero-IF receivers from I/Q
- **IQ Noise Blanker** — blanks short impulses (ignition, switching supplies) on the wide band before the channel filter, where they are still short
- **IQ Squelch** — RSSI (dBFS) and SNR over a tracked noise floor; opens by SNR or level with 3 dB hysteresis and a hang time, fades in/out in 5 ms; `rssi`, `snr`, `open` outputs
- **I/Q → IQ** — two engine signals (e.g. the stereo line input from a receiver with an IQ output, or Hilbert I/Q) into an IQ stream; IQ → Audio does the reverse. For a sound card: Microphone (A+B) in *stereo device* mode (up to 192 kHz; the engine rate at the top sets the band) → I/Q → IQ → IQ Balance
- **IQ Balance** — fixes the I/Q mismatch of sound-card and direct-conversion receivers (the mirror image): Q gain and phase, *auto* (blind, from the I², Q², I·Q averages — needs a spectrum symmetric on average: noise, a busy band) or manual, plus a fractional Q delay (channel skew, often ±1 sample on sound cards). The readout shows the estimate and the image level before → after (1 dB / 5° → about −23 dB, corrected below −50 dB)
- **Auto Notch (NLMS)** (Processing) — removes steady whistles and heterodynes from audio; `tones` is what was removed
- **IQ → Audio** — the bridge into the engine's audio: ring buffer and a cubic resampler to the sound card rate. The source clock (SDR, file) and the sound card drift apart; the read rate follows the buffer within ±2000 ppm, the readout shows the buffer and the correction. **buffer** is the minimum kept: data comes in bursts (worker, USB), so the bridge watches the lowest fill over 0.5 s, not the average. One second after start the excess that was in flight while a worker spun up is dropped at once instead of being drained slowly with a pitch offset. Decimate to about the audio rate before it: the bridge has no anti-alias filter
- **IQ Spectrum** — Welch spectrum of a stream (absolute frequencies for complex streams) for the Spectrum Analyzer
- **IQ Channelizer** — a polyphase filter bank: cuts the stream into N channels (8…1024) spaced sr/N with one FFT for all of them, so many signals can be received at once. Each channel comes out at sr/N (**oversampling 1**) or 2·sr/N (**2**: flat to the channel edge, no aliasing there; with 16 taps per channel the neighbour's centre is rejected by more than 60 dB). **outputs** (1…8) are slots: **manual** — the channels of the listed frequencies (or `f1…` inputs), **strongest** — the strongest active channels above the noise floor (median of the channel powers) + threshold, one slot per signal peak, held for **hold** seconds after it goes quiet; the centre channel (DC spike) is skipped. `spec` is the power of every channel, `active` — how many slots are busy. About 15% of a core at 1.024 MS/s (64 channels, 2× oversampling, 16 taps) — in its worker
- **One `iq` pin instead of I and Q** — the modules that took or gave a pair of signals now have a single `iq` pin: *Constellation*, *Zoom-FFT (I/Q)*, *Magnitude/Phase*, *PSK Slicer*, *Symbol Sync*, *HFDL: Symbol Sync*, *HFDL: Symbol→Bits* (inputs) and *AM/FM/SSB Demodulator*, *Carrier Acquisition*, *Quadrature Shift*, *Hilbert Transform*, the synchronizers' symbol outputs (outputs). A wire from any `iq` source (USB SDR, IQ blocks) goes straight to it; the node gets I and Q at the engine rate through the same bridge as *IQ → Audio* (decimate to about the audio rate before it — the bridge has no anti-alias filter), and its own I/Q come out as an `iq` stream like *I/Q → IQ* does. The old I and Q pins are hidden until a wire is connected to them, so saved patches and presets keep working unchanged and still show their wires; a wire on I / Q wins over `iq`
- **Auto adapters** — wiring `iq` to a signal pin (or a signal to an `iq` pin) in the editor inserts the converter by itself: *IQ → Audio* for `iq` → signal, *I/Q → IQ* for signal → `iq`. A pin named `Q` / `q` goes to the second channel, any other to the first; a second wire from the same source reuses the adapter. So one `iq` pin is enough on a module, no separate I and Q pins
- **Symbol chain** — the 4FSK receiver taken apart into blocks (the same path *Digital Voice Decoder* runs as one piece). Symbols travel on an IQ wire as a real stream at the symbol rate, levels about ±1, ±3 (dibit 00 → +1, 01 → +3, 10 → −1, 11 → −3):
  - **FM Discriminator** — IQ → frequency in Hz (channel filter cutoff, slow DC block); a real input is taken as FM audio
  - **RRC Matched Filter** (`symRrc`) — baud and roll-off α
  - **Symbol Slicer (4-level)** — samples at the symbol rate with cubic interpolation; the timing follows the symbol energy (maximum at the sampling instant, early / late samples at ⅛ symbol), the level from the mean |y|
  - **Symbol Sync Search** (Protocols) — several sync words at once (hex, separated by spaces); a candidate is a window whose correlation with the word is at least *minimum correlation*, then gain and offset are fitted on the word (the sign of the gain is the polarity — an inverted spectrum is turned back) and *tolerance* bits may differ. The frame (*length* symbols after the word) goes out on `blk` as ±1 soft bits (`d`, like Sync Word → Frame; feeds Block Viewer, CRC, Scrambler, Interleaver, Viterbi) plus dibits (`dib`), the word, polarity and error count. Words that are inverses of each other (M17 LSF 55F7 / stream FF5D) are told apart by the polarity-first rule
  - **Frame grid in Symbol Sync Search** (advanced parameters): *symbols before the word* (the frame starts earlier than the word — DMR 66), *frame period* (after a lock a frame goes out every *period* symbols, also where the word is missing — DMR voice bursts B–F — the word is looked for ±1 symbol from the expected place, with a looser *error tolerance while the grid is held*, and *frames without the word before the lock is dropped*) and the whole frame on `blk` (`fr`, with `at` = the word's position, `hit`, `outer`). *timing loop gain* of the slicer is 0.05 by default (DMR's α = 0.2 needs a faster loop than 0.01)
  - **Protocol Decoder (4FSK)** (`fskSym`, Decoders) — the other 4FSK protocols (P25, NXDN 9600 / 4800, YSF, D-STAR, dPMR; also DMR and M17 in one piece) on a chain of blocks: its input is the output of *RRC Matched Filter* (a real stream at any rate ≥ 2 × baud; no Symbol Slicer in front of it), and it runs the protocol code of *Digital Voice Decoder* unchanged — 8 clock phases per symbol, the best phase and the levels from a fit on the sync word, frame grid, NID / LDU / TSBK / CAC / headers, records and raw vocoder frames. These protocols have narrow eyes (α = 0.2, strict limits on sync-word errors and fit residual), and a blind timing loop in front of them loses frames; choosing the phase by the data is what the single node does and what this node does. `protocol` picks one, `auto` — every protocol with the symbol rate in `baud`. **Expand into blocks** now works for every protocol: `IQ Decimator → FM Discriminator → RRC → Protocol Decoder` (M17 and DMR keep their longer chains). Preset **P25: Receiver Built from Blocks (Generator)**. Checked on all 17 generator signals (P25 ×4, NXDN 9600 ×3, NXDN 4800 ×2, YSF ×2, D-STAR ×3, dPMR ×2): the same records and vocoder frames as the single node
  - **DMR Frame Parser** (Decoders) — `blk` from a Symbol Sync Search with the DMR chain → `rec` and `voice` (raw AMBE+2): the channel layer of *Digital Voice Decoder* with `proto = dmr` (CACH / Short LC, slot type, EMB, BPTC, Reed-Solomon, CRC, LC, CSBK / MBC, data, SMS). Polarity comes from the FEC (voice and data words are inverses of each other): at once from a data frame with a correct slot type, otherwise from two frames in a row that agree on polarity and colour code; an idle TDMA slot (an unmodulated carrier, which slices into a constant pattern that is a valid EMB of CC 0 once flipped) is dropped by the share of outer levels. **Expand into blocks** works for `proto = dmr` too. Preset **DMR: Receiver Built from Blocks (Generator)**. On the generator's DMR signals — repeater, mobile and both direct-mode slots, clock error 0–300 ppm — the chain decodes every call, end and alias, and for the repeater the same CSBK, data headers and messages as the single node (a few more of them)
  - **M17 Frame Parser** (Decoders) — `blk` from Symbol Sync Search → `rec` (call, end, packet / SMS, BERT) and `voice` (raw Codec 2 frames): the same channel layer as *Digital Voice Decoder* with `proto = m17` (de-randomizer, interleaver, convolutional decoder, Golay, CRC, LSF reassembly from LICH), without the physical layer. The frame type comes from the sync word (55F7 LSF, FF5D stream, 75FF packet, DF55 BERT)
  - preset **M17: Receiver Built from Blocks (Generator)**.
  - **Transmitter, the mirror of the receive chain:** **M17 Frame Builder** (Protocols: from / to callsigns, CAN, message text; frames go out on `go` (rising edge) or the *Send* button — a packet burst of preamble, LSF, SMS packets with CRC and EOT; the `text` input replaces the message, *auto* sends when it changes) → **Symbol Player** (frames → symbols at the baud rate, the carrier stays unmodulated between bursts) → **RRC Pulse Shaper** (symbols → samples at the chosen rate, α, constant symbols keep their level) → **FM Modulator** (IQ at center + offset, deviation per level unit — M17 800 Hz, level −6 dBFS), then HackRF TX (the shaper's output rate must be ≥ 2 MS/s for it). Preset **M17: Transmitter Built from Blocks (Loopback)** feeds the result straight into the receiver chain. Checked in Node: the message comes out of the chain and of the single *Digital Voice Decoder* node, also with noise and at 256 kS/s and 2 MS/s. Voice: **Vocoder Encoder (Codec 2)** (`c2Enc`, Protocols) turns the audio of any node (microphone, file, …) into M17 voice frames — it resamples to 8 kHz and encodes in mode 3200, 16 bytes per 40 ms, as `voice` records of the same shape *Vocoder (mbelib)* reads; the `ptt` input (or always on, when not wired) gates it. **M17 Frame Builder** in *voice (stream)* mode takes them on its `voice` input: while PTT is on (the `ptt` pin or the *PTT on / off* button) it sends the preamble and the LSF, a stream frame per 16 bytes with the LICH and frame number, and at release the last frame (end flag) and EOT. The Codec 2 encoder is the same library as the decoder (`vendor/codec2.wasm`, now with `c2_encode`; byte for byte the same output as a native build of the same sources, checked on 300 frames in both modes). Preset **M17: Voice Transmitter, Microphone to Speaker (Loopback)**: microphone → … → receiver chain → Vocoder → sound card (use headphones)
 On the generator's M17 voice and packet signals the chain plus the parser decode the same calls, packets and Codec 2 frames as the monolith (no FEC errors; a few extra false syncs inside preambles are rejected by the parser's FEC)
- **IQ Add** — sum of two streams of the same rate (for test signals)
- **ADS-B Demodulator** — Mode S frames from a 1090 MHz stream (see [ADS-B](#ads-b))
- **PSK Demodulator** — soft BPSK/QPSK/OQPSK symbols out as an IQ stream at the symbol rate (see [Meteor-M LRPT](#meteor-m-lrpt), [Inmarsat STD-C](#inmarsat-std-c))

**Workers.** IQ blocks wired to each other form an *island* that runs in its own Web Worker: the main thread only sends it the inputs coming from outside (e.g. the SDR's raw IQ) and the parameters once per engine block, and hands its outputs to the rest of the graph when they come back a block or two later. The IQ → Audio bridge keeps the stream continuous (its buffer covers the delay); numbers and spectra from an island lag by a few milliseconds. Records (`rec`) from an island are queued and delivered once each. Only outputs wired to nodes outside the island come back. IQ → Audio stays on the main thread (it outputs audio), and so do IQ blocks inside groups. The readout of a block in a worker ends with *· worker*. On the generator preset the main-thread load drops from ~40% to ~2%.

Presets: *IQ: Receiver from Blocks (Generator)* and *IQ: Channelizer — Three Signals at Once (Generator)* (no hardware needed), *USB SDR: FM Receiver from Blocks* (stereo, RDS), *USB SDR: HF AM / SSB from Blocks* (DC block, noise blanker, SAM, squelch, auto notch), *USB SDR: Listen to the Strongest Channels* (four strongest NFM channels at once, spread across the stereo field), *Sound Card IQ: HF Receiver (SoftRock-style)* (line-in IQ → balance → SSB/AM).

## ADS-B

Mode S / ADS-B at 1090 MHz from the raw IQ of a USB SDR — no dump1090 needed.

- **ADS-B Demodulator** (IQ): magnitude → preamble search (pulses at 0, 1, 3.5, 4.5 µs over the gaps by *preamble* dB) → PPM bits, 1 µs each → CRC-24. Half-bit windows are integrated at fractional positions, so any rate from 2 MS/s works (2.4 MS/s is better); the bit phase is refined in quarter-half-bit steps. DF11/17/18 are accepted by CRC, DF17/18 with one wrong bit fixed (or two of the 12 least certain bits — *2 weak bits*: more range, a rare ghost); DF0/4/5/16/20/21 carry the address in the CRC and are accepted only for aircraft heard in DF11/17/18 in the last minute. `rec` — the frames (`raw` hex, `df`, `icao`, `rssi` dBFS), `rate` — frames per second. Runs in a worker; ~18% of a core at 2.4 MS/s.
- **ADS-B Decoder** (Decoders): frames from the demodulator, or AVR text lines (`*8D…;`, also `@timestamp…;`) on `text` — e.g. from dump1090 port 30002 via *Text over Network*. Decodes callsign and category, airborne and surface positions (CPR: globally from an even/odd pair within 10 s, then locally from the last position; surface ones relative to the receiver), barometric and GNSS altitude (25 ft and Gillham), ground speed and track, heading and IAS/TAS, vertical rate, squawk and emergency (DF5/21, TC28), altitude from DF4/20, callsign from Comm-B BDS 2,0. Positions that jump faster than ~1000 kt or lie farther than *reject* km from the receiver (position from `lat`/`lon`, the parameters or *My Position*) are dropped. The readout is a table like dump1090's interactive view; `rec` goes to the map with `icon: plane`, heading and a colour by altitude; `count`, `msgs`, `range` (max, km).

Presets: *ADS-B: Aircraft Map (Generator)* (no hardware), *ADS-B: Aircraft Map (USB SDR, 1090 MHz)*.

## Meteor-M LRPT

LRPT from Meteor-M satellites (137.1 / 137.9 MHz) from the raw IQ of a USB SDR, down to CCSDS frames. The parameters follow [SatDump](https://github.com/SatDump/SatDump) (GPLv3): M2-3/M2-4 use OQPSK 72 kBd + NRZ-M, the old M2 uses QPSK without NRZ-M; both use RS(255,223) with interleave 4 in the conventional basis.

- **PSK Demodulator** (IQ, worker): decimates to 3–6 samples per symbol by itself (1.024 MS/s → ÷4), RRC matched filter (α = 0.6), AGC, coarse frequency from the 4th-power spectrum (±*frequency search*, also for OQPSK), Gardner symbol timing with cubic interpolation (OQPSK: Q taken half a symbol later), 4th-order Costas loop. Out: soft symbols as an IQ stream at the symbol rate, `freq` (offset, Hz), `lock`; the node shows the constellation, offset and SNR.
- **CCSDS Decoder** (Decoders, worker): Viterbi sync by re-encoding errors over 8 variants (I/Q swap × 0/90° × pair shift; 180° is removed by NRZ-M or an inverted ASM), streaming Viterbi K=7 r=1/2 (polynomials 171/133), NRZ-M, ASM `1ACFFC1D` with 1024-byte frames, CCSDS derandomizer, RS(255,223)×4 (conventional or dual basis, or off). A lock without ASM for 4 frames is dropped as false. `rec` — one record per frame that passes RS: `scid`, `vcid`, `cnt` (VCDU counter), `rs` (bytes fixed), `vcdu` (892 bytes; hex in CSV). Plus `ber` (re-encoding error rate) and `lock` (0 none, 1 Viterbi, 2 frames synced).

Checked against independent references: the encoded ASM matches SatDump's correlator pattern, RS parity matches `reedsolo` with the CCSDS field, and the PN sequence matches CCSDS. End to end, generator → demodulator → decoder, every frame comes back byte for byte (OQPSK and QPSK, ±9 kHz offset, Es/N0 down to ~6 dB). It has not yet been tried on a real pass recording.

- **LRPT Image (MSU-MR)** (Decoders): frames of VC5 → packets (M_PDU first-header pointer, packets split across frames; a lost frame only drops the packets in it) → APID 64…69, channels 1…6 → segments: 14 blocks 8×8 compressed like baseline JPEG without markers (standard luminance Huffman and quantization tables scaled by the segment's QF) → lines 1568 px wide. Rows are placed by the packet counter in the 43-packet transmission loop (14 segments × 3 channels + telemetry), the same way as SatDump, so channels line up and gaps stay black. Composites RGB 221 (day), 123, 321, 125, or one channel; the node shows the latest part, **Save PNG** saves the whole pass; `img` (every 2 s, when wired) and `lines`.

The generator's LRPT mode carries a real MSU-MR stream: a test picture (a different pattern per channel) encoded into segments, packets and M_PDUs; it comes back with a mean error under 2 levels (QF 80).

Presets: *Meteor-M LRPT: Image (Generator)*, *Meteor-M LRPT: Image (USB SDR, 137 MHz)*.

## Radiosondes (RS41)

**RS41 Radiosonde** (Decoders, worker) receives Vaisala RS41 weather balloons at 400–406 MHz. It follows zilog80's `rs41mod` ([rs1729/RS](https://github.com/rs1729/RS), GPLv3), the decoder behind radiosonde_auto_rx.
- **Input:** raw IQ at any rate (decimation, ±10 kHz channel, FM discriminator), or a real stream that is already FM audio, e.g. a recording from a scanner.
- **Frames:** GFSK 4800 Bd. The 64-bit header is found by normalized correlation over fractional bit windows, in either polarity; bit timing is tracked on transitions.
- **Decoding:** 64-byte XOR mask, RS(255,231)×2 (GF 0x11D) for 320- and 518-byte frames, then CRC-16 blocks: status (frame number, serial, battery, one of 51 calibration pieces), PTU, GPS week/time, ECEF position and velocity.
- **Output:** records per frame with a position (`id`/`label` = serial, `lat`, `lon`, `alt` m, `climb`, `vh` m/s, `heading`, `sats`, `frame`, `batt`, `temp` °C and `rh` % once the calibration pieces have come in, time from GPS) with a balloon icon for the map. The node lists the sondes it hears.

Checked on real data: the two sample frames from rs1729/RS (RS corrects exactly the two bytes it should, serials, positions), and a 6 s recording of RS41 L1830070 (`tools/test/data`). Every frame matches `rs41mod`'s output to its last printed digit, temperature included.

Presets: *Radiosonde RS41: Map (Generator)*, *Radiosonde RS41: Map (USB SDR, 400–406 MHz)*.

## MPT 1327

**MPT 1327 Decoder** (Decoders, worker) reads the control channel of analogue trunked systems (MPT 1327, common in UK, Eastern Europe and Asia).

- **Input:** IQ (any rate, decimated to ~24 kS/s inside; put *IQ Frequency Shift* before it if the channel is off-centre, ±11 kHz is passed) or an already demodulated FM audio.
- **Chain:** FM discriminator → slow DC block → FFSK 1200 Bd (1 = 1200 Hz, 0 = 1800 Hz, tone energies in a one-bit window) at 8 bit-clock phases → sync word (`0xC4D7` control, `0x3B28` traffic, one error allowed; an inverted signal is recognised by the CRC) → 64-bit codewords: CRC-15 (polynomial `0x6815`, xorout 1) and overall even parity. Data codewords are taken only right after a valid one.
- **Output:** records `{chan, kind: address|data, pfix, ident, raw, text}`; the node lists the last codewords, counts and the polarity.
- **Not done:** the message layer (ALOHA, GTC, ACK…) is not interpreted — only PFIX/IDENT of address codewords and the raw 48 bits are shown. The generator sends test codewords with valid CRC, not real system messages.

Presets: *MPT 1327: Control Channel (Generator)*, *MPT 1327: Control Channel (USB SDR)*.

## ISM 433

**ISM 433 Decoder** (Decoders, worker) decodes short telegrams of the 433.92 MHz band (also 315 / 868 / 915 MHz): weather sensors, door and gate remotes, doorbells. It is a base for adding protocols, not a replacement of a catalogue like `rtl_433`.

- **Input:** IQ at any rate (decimated to ~250 kS/s inside; put *IQ Frequency Shift* before it if the signal is off-centre, keep it off the DC spike of the SDR).
- **Slicer:** channel filter (*channel width*) → envelope for OOK, frequency for 2-FSK (the level is the middle of the seen frequency span). The threshold follows the peak and the noise floor (needs *min. signal over noise*), with hysteresis; runs shorter than 30 µs are merged with the neighbours. A packet ends after a silence longer than *end of packet* (default 12 ms).
- **Analyzer:** the pulse train (mark, space, … in µs) is clustered by duration. A rare long space with a regular step splits the packet into repeats (rows). Then the encoding is chosen: **PWM** (two mark widths, constant period), **PPM** (two space widths), **MAN** (Manchester, widths are multiples of T, 01 = 1 / 10 = 0, phase per row) or **PCM** (the same lattice, raw levels). If the durations do not fall into a few clusters (noisy FSK, NRZ without gaps), the bit period T is found from the periodicity of the run lengths and the bits come out as PCM; runs longer than 12 T end a segment.
- **Protocols:** `EV1527 / PT2262` (PWM, 20-bit address + 4 data bits, tri-state view of PT2262) and `Nexus` (TFA / Digitech-type clones: id, channel, battery, temperature, humidity). The most frequent row among the repeats wins (`agree` of `nrows`). A protocol is a function `an → fields | null` in `ISM_PROTOS` (`modules/ism-kernels.js`): it gets the rows of bits and the timings.
- **Unknown packets** (*log unidentified packets*) are logged too: encoding, bit count, hex, short / long / gap in µs. Use them to find out the timings of a device and write its parser.
- **Output:** records `{t, src:'ISM', mod: OOK|FSK, proto, kind: sensor|remote|unknown, id, text, freq, foff, rssi, snr, enc, pulses, short, long, gap, …fields}`; identical packets within *skip identical packets* are dropped (by the stream time, so it works on recordings too). Rec Log saves CSV, *Rec: Unique by Key* (key `id`) keeps one line per device.
- **Not done:** the protocols were checked against the generator and hand-made vectors, not against real devices — check a new one with your own captures. Only mark-first, single-frequency packets are handled; a trailing run of zeros in FSK is lost (it looks like silence); no CRC-based protocols yet (Oregon, LaCrosse, Fine Offset…); OOK+FSK mode gives duplicates and false unknown packets.

Presets: *ISM 433: Sensors and Remotes (Generator)*, *ISM 433: Sensors and Remotes (USB SDR)*.

## ACARS

**ACARS Decoder** (Decoders, worker) reads aircraft datalink messages on VHF (131 MHz band, AM, 25 kHz channels): position and OOOI reports, gate and weather messages, link tests.

- **Input:** IQ at any rate (decimated to ~24 kS/s inside) or an already demodulated AM audio. The envelope is taken, so the carrier may be off-centre within the passband (about ±10 kHz); put *IQ Frequency Shift* before it to stay away from the DC spike of the SDR.
- **Chain:** AM envelope → DC block → mix 1800 Hz to zero → low-pass → phase step per bit (MSK, 1200 / 2400 Hz) at 8 bit-clock phases → sync word `'*' SYN SYN SOH` (two bit errors allowed) → bytes (7 bits LSB first + odd parity) → ETX / ETB, BCS, DEL. The tone polarity and the differential variant (tone change or repeat = bit) are not assumed: all four readings of the bit stream are tried and the sync word picks the right one, shown in the node header.
- **Check:** BCS is CRC-16 (reflected, polynomial `0x8408`, initial 0) over the bytes from the mode to the BCS, with parity bits included; the result must be zero. With *fix up to 2 parity errors* on, the bits of bytes that fail parity are flipped one by one, and the block is accepted only if the CRC then matches (those are marked `fixed`). Frames with a wrong CRC are only counted.
- **Output:** records `{t, src:'ACARS', kind:'message', id, reg, mode, ack, label, blk, dir: air2gnd|gnd2air, no, flight, etb, txt, text, rssi, fixed}`. For downlink blocks (block id is a digit) the message number and flight id are split off the text. Rec Log saves CSV, *Rec: Unique by Key* (key `reg`) gives a list of aircraft heard.
- **Not done:** the message layer is not interpreted (labels, ARINC 620/622 formats, OOOI fields) and positions are not extracted — feed the text to *Geo from Text* if a message carries coordinates (`N55123E037456`). Multi-block messages (ETB) come out as separate records. One channel at a time. The decoder was checked against the generator (including noise at 8 dB SNR, ±300 ppm clock error, inverted and differential tones, single parity errors), **not against real recordings**: the CRC convention and the tone mapping follow the common ACARS decoders from memory, so check them on your own captures first.

Presets: *ACARS: VHF Messages (Generator)*, *ACARS: VHF Messages (USB SDR, 131 MHz)*.

## Analog video

Two blocks turn an IQ stream into a picture: **TV Demodulator** (IQ, worker) and **TV Decoder** (Decoders, worker; the picture is on the `img` output — show it with a *Frame* node).

- **TV Demodulator:** *FM* (FPV video transmitters on 5.8 GHz, analog satellite TV) — a discriminator with a fast arctangent; *AM (negative)* / *AM (positive)* — envelope detector for broadcast TV (tune to the vision carrier). Then a 4th-order Butterworth low-pass (*video bandwidth*, up to 0.45 × the sample rate). The output is a real stream at the input rate with the sync tips down; *invert* flips the sign. *Deviation* only scales the level.
- **TV Decoder:** input is a real stream at ≥ 8 MS/s (colour: ≥ 2.4 × the colour subcarrier — 10.6 MS/s PAL, 8.6 MS/s NTSC; HackRF at 12–20 MS/s, Airspy 10 MS/s).
  - *Sync:* a slicer between the sync tip and the blanking level (first from the minimum and maximum, then from the measured levels), sub-sample edge times, pulse widths tell a line sync (4.7 µs) from equalizing (2.35 µs) and field (27 µs) pulses. The line period is tracked (±3 %), a missing line is filled in, a lost lock is found again. The sync tip and the back porch of every line set the black level and the gain, so the picture does not need a level setting.
  - *Standard:* *auto* counts the lines between field syncs (≈ 305 → PAL 625, ≈ 253 → NTSC 525); or set PAL / NTSC by hand.
  - *Sync:* *free* needs no sync at all (weak signal, narrow bandwidth, a lost carrier): lines are drawn at the nominal line rate, the levels come from the statistics of each line, so even a trace of a picture shows. The picture slants or rolls until *trim* (ppm of the line period) matches the transmitter; *picture shift* moves it. No colour in this mode.
  - *Polarity:* *auto* flips it if there is no sync for half a second.
  - *Colour:* the burst of every line gives the phase and the gain of the subcarrier (the reference phase runs on across lines). PAL: the swinging burst gives the V-switch, the chroma is averaged with the previous line of the field. Luma = the composite minus the reconstructed chroma, so the subcarrier does not show on coloured areas; a weak chroma is treated as luma leakage. No burst (B/W) — luma only; *colour* off gives luma only too.
  - *Picture:* 384…960 px wide, 576 (PAL) or 480 (NTSC) lines; *weave* puts two fields in one frame, *bob* doubles the lines of every field (no combing on motion); brightness, contrast, picture shift in µs and lines.
  - Outputs: `img`, `lock` (0 / 1), `fps` (fields per second).
- **Not done:** SECAM (the picture comes out B/W), teletext and VBI lines, sound, VCR and other unstable line timing beyond ±3 %, blind PAL / NTSC colour of a signal whose subcarrier is off by several kHz. The field order (top or bottom first) is not detected, it follows the order of the syncs. Checked against the generator and hand-made signals, not against real cameras — the timing constants are the standard ones (PAL-B/G/I, NTSC-M without setup), check your own captures. At 12–20 MS/s the chain takes about one core: it runs in one worker island, lower the run speed if it does not keep up.

The IQ Generator mode **Analog TV** sends a test card (75 % colour bars, grey scale, white frame) in PAL or NTSC, FM (*deviation*) or AM with negative modulation.

Presets: *Analog TV: Test Card (Generator)*, *Analog TV: FPV / TV Receiver (USB SDR)*.

## Digital Voice Decoder (4FSK)

**Digital Voice Decoder** (`fskRx`, Decoders, worker) is a universal receiver for the digital voice systems that share one physical layer: an FM discriminator, a root-raised-cosine matched filter, eight clock phases per symbol and a sync-word search. The former separate *DMR Decoder* is now this node with *protocol = dmr* (old patches are converted on load; the DMR presets use it that way). The *protocol* parameter is *auto* (all of them at once: channels of the same baud rate, roll-off and level count share one filter chain — 4800 Bd RRC 0.2 for DMR / P25 / NXDN / YSF, 4800 Bd RRC 0.5 for M17, 4800 Bd 2FSK for D-STAR, 2400 Bd for dPMR and NXDN 4800) or one protocol. Input is IQ at any rate (or FM audio); polarity is found by the sync words and by FEC. Every protocol has its own lock, so a decoder that sees a wrong sync gives it up after the first frame that does not decode.

**Expand into blocks** (button on the node, for protocols that have a block chain — M17 so far): the node is replaced by *IQ Decimator* (when the receiver was decimating — run the graph once first so the rate is known) → *FM Discriminator* → *RRC Matched Filter* → *Symbol Slicer* → *Symbol Sync Search* → the protocol's frame parser (*M17 Frame Parser*), with the protocol's baud, α, sync words and frame length filled in; the input and output wires are moved over and Undo puts the single node back. Use it to see every stage, change a parameter or a sync word, or to build a new protocol on the same chain. On the generator's M17 signal the chain takes about 0.14 s of CPU per second of signal against 0.175 s for the single node (it looks at one clock phase per symbol where the single node watches eight), so nothing is lost by building the receiver from blocks.

Outputs: `rec` — records (`src` = protocol, `kind` = call / end / message / …, and a `text` line), `voice` — raw vocoder frames as hex (`ambe`, `imbe`, `codec2` fields). Voice is **not** decoded to audio. The IQ Generator has a **4FSK** mode with a test transmitter for each protocol.

| Protocol | What is decoded |
| --- | --- |
| **P25 Phase 1** (C4FM 4800 Bd) | NID (NAC, DUID; BCH(63,16)), HDU (Golay + RS(36,20), MI, algorithm, key, talkgroup), LDU1 link control (group / private call, source, destination, emergency, encryption) and LDU2 encryption sync (RS(24,12) / (24,16), Hamming(10,6)), low-speed data, TDU, TDULC (link control at the end of a call), **TSDU / TSBK** with 1–3 blocks (trellis ½ + CRC): channel identifiers (IDEN_UP, with frequency arithmetic), RFSS / network / adjacent-site status, group grants with frequency, affiliation / registration, service broadcast; **PDU data**: header (½ trellis, CRC-16), unconfirmed blocks (½) and confirmed blocks (¾ trellis, DBSN, CRC-9), CRC-32 of the packet, extended address and encryption sync headers, IPv4 / UDP (TMS, LRRP…), NMEA location, responses (ACK / NACK), alternate multi-block trunking messages (NET / RFSS / adjacent status, group grant). Frame clock drift is tracked across the 180 ms LDUs. |
| **NXDN 9600** (4FSK 4800 Bd) | LICH, SACCH superframes (RAN, layer 3 in four segments), FACCH1 (CRC-12), UDCH (CRC-15), K=5 convolution with puncturing, scrambler; layer-3 messages (voice call, TX release, disconnect, data call header…), 72-bit AMBE frames. Control channel (CAC, 300 bits, CRC-16 as in dsd-fme): SITE_INFO (location, channels, services), VCALL_ASSGN with channel and other layer-3 messages. **NXDN 4800** (2400 Bd, same frame layout at 80 ms) is a separate protocol in the list. |
| **M17** (4FSK 4800 Bd, RRC 0.5) | LSF (callsigns, TYPE, META: text / GNSS / extended callsigns, CRC), stream frames (LICH with Golay(24,12), frame number, 16 bytes of Codec 2, last-frame flag), late-entry LSF from LICH chunks, packet mode (SMS text, CRC), BERT (PRBS9 statistics). |
| **YSF** (C4FM 4800 Bd) | FICH (Golay + convolution + CRC-16: frame type, DT, FN / FT, DG-ID), header / communications / terminator, callsigns (destination, source, downlink, uplink) in V/D mode 1 and 2, **GPS position** (short / long packet from the data blocks: radio model, latitude, longitude; parser compared with YSFGateway `GPS.cpp`), raw AMBE blocks; data and voice full-rate frames come out raw. |
| **D-STAR** (GMSK 4800 Bd) | Header (K=3 convolution, 24×28 interleave, scrambler, CRC-16: MY, YOUR, RPT1, RPT2), voice frames, slow data (text, GPS NMEA, header copy — a call is recognised even if the header was missed), end pattern. |
| **dPMR** (4FSK 2400 Bd) | FS2 payload units: colour code, control channel (scrambler, Hamming(12,8), CRC-7: called and calling ID, mode, version), 8 raw traffic-channel frames per unit. **Header** (FS1: type, called and own ID, mode, format; Hamming(12,8) ×10, CRC-8) and **end frame** (FS3) are decoded, and so is the packet-data header (FS4: same layout, version / format / emergency / message information; the packet frames after it are not). FS4 is FS1 with the levels flipped, so the word's CRC decides the polarity. |

How much is checked: the codes and frame layouts are compared with the code of other implementations — P25, NXDN, YSF and D-STAR against MMDVMHost / the MMDVM firmware (real encoder output), M17 against libm17, dPMR primitives against dsd-fme, the header word against dsdcc (`tools/test/ref` has the reference programs, `tools/test/data/fsk4-vectors.json` the vectors). Whole signals are checked generator → decoder (all sample rates, noise, inverted spectrum, ±300 ppm clock error); **on-air reception has not been tried on real hardware yet**, and dPMR has no independent frame encoder to compare with.

### Messages and Subscribers

Two output nodes work on the `rec` output of *Digital Voice Decoder*, whatever the protocol:

- **Messages** (`msgLog`) — the meaningful messages as a separate stream in one common shape (`time, protocol, type, from, to, text, service, lat, lon, ip …`): DMR SMS / LRRP / IP-UDP / NMEA, P25 data PDUs (IP / UDP, NMEA position), NXDN data calls, M17 packets (SMS), D-STAR slow-data text and GPS, YSF GPS. `type` is *text*, *location*, *data* or *signalling*; the *signalling* check adds trunking messages, headers and encryption sync (P25 TSBK / MBT, DMR CSBK, NXDN messages, dPMR headers). Filter by protocol, save CSV, replay. The `msgs` output carries the records on.
- **Subscribers** (`subLog`) — a registry per protocol: ID or callsign, talker alias, calls, times heard as a destination, talk seconds, messages sent, last group, repeater / reflector (D-STAR, YSF), position when a message had one. Talk groups are counted apart (P25 TG, DMR TG, NXDN conference, `CQCQCQ`) with their stations. The `stations` records carry `lat` / `lon` for the map; CSV for subscribers and groups.

Both *Digital Voice Decoder* presets have them wired. D-STAR callsigns are taken without the `/suffix` (the header has it, the end of the call does not).

### Vocoder (mbelib)

**Vocoder (mbelib)** (`mbeVoice`, Decoders) turns the raw vocoder frames from the `voice` output of *Digital Voice Decoder* into sound: **P25 IMBE**, **DMR / NXDN / dPMR / YSF (V/D mode 1 and 2) AMBE+2** and **D-STAR AMBE**. The AMBE / IMBE decoder is [mbelib](https://github.com/szechyjs/mbelib) (ISC licence) compiled to WebAssembly — `vendor/mbelib.wasm`, built by `tools/mbelib/build.sh` with clang's wasm32 target (no Emscripten; `cosf` / `powf` / `exp` / `log` come from the browser's `Math`). Frames are put into mbelib's matrices with the interleave schedules of dsd-fme, decoded to 8 kHz (160 samples per 20 ms), then queued (120 ms pre-buffer), resampled to the engine rate and mixed. Streams are kept apart per protocol and DMR slot (the *DMR slot* parameter picks one). **M17** goes through [Codec 2](https://github.com/drowe67/codec2) (LGPL 2.1, no patent issue) in a second module, `vendor/codec2.wasm` (`tools/codec2/build.sh`; modes 3200 — two 8-byte frames per stream frame — and 1600 — one frame plus 8 data bytes, chosen by the TYPE field of the LSF). *YSF V/D mode 2* carries the 49 AMBE+2 bits without Golay FEC (27 bits sent three times, 22 bits plain): the Vocoder takes a majority vote, rebuilds the Golay words and the PRNG modulation of the 72-bit frame and decodes it as DMR AMBE+2 (layout from MMDVM_CM `ModeConv`; the rebuilt frame decodes back to the same 49 bits in mbelib). **TETRA** speech (ACELP, from the `voice` output of *TETRA Decoder*) is a third, optional module, `vendor/tetra-acelp.wasm`, which you build yourself (`tools/tetra-acelp/build.sh`, see [TETRA](#tetra)); two 137-bit frames per traffic slot, 240 samples (30 ms) each. The `err` output (num) is 1 while the frames decoded in the current block had corrected bit errors, 0 otherwise (IMBE / AMBE only; Codec 2 and ACELP report none). Encrypted calls come out as noise unless a key is given: **P25 ADP** (ALGID 0xAA) and **DMR Enhanced Privacy** (ALG 0x21), both RC4 with a 40-bit key, are decrypted (`modules/voicecrypt.js`). The *RC4 keys* parameter and the `key` input (text, e.g. from *Text Source*; both are merged, the input wins) take entries separated by `;` or new lines: `0123456789` (any call), `7=0123456789` (key ID 7 from the call header) or `tg:5000=0123456789` (talkgroup / destination 5000); the most specific entry wins, so several streams can have their own keys. The keystream is applied to the vocoder parameter bits before FEC, so each frame is Golay / Hamming-decoded, XORed and re-encoded for mbelib (the layout was checked bit for bit against the mbelib decoder). RC4 key = key ‖ MI (P25: first 8 bytes of the MI, keystream from byte 267, 11 bytes per frame, +101 for LDU2, +2 for the LSD before frame 9, the MI of the next superframe comes from the LDU2 ESS or the 64-bit LFSR; DMR: 4-byte MI from the PI header, keystream from byte 256, 7 bytes per frame counted from the voice LC header — a lost burst breaks the sync until the next call). The offsets follow dsd-fme and were not tested against a real capture. The stream line in the readout shows the algorithm, key ID and whether it is decrypting, has no key, waits for the MI or the algorithm is not supported (DES, AES, Hytera, …).

- **Checked:** the wasm gives the same samples and error counts as a native build of the same mbelib sources for IMBE, AMBE+2 and AMBE frames (`tools/test/ref/mbelibref.c`), and the whole chain generator → Digital Voice Decoder → Vocoder produces sound. The Codec 2 module is only smoke-tested (it loads and decodes frames without errors), not compared with a native build. **Not checked on real speech** — no encoder for these vocoders is available, so the frame layouts are those of dsd-fme and the output quality is that of mbelib (AMBE+2 in particular is only approximated). The generator sends random frames, so it plays noise.
- **Patents:** IMBE / AMBE / AMBE+2 are DVSI vocoders and their algorithms may be covered by patents in some countries (mbelib's own README says so). The ISC licence covers the code, not that. Check what applies to you before using or distributing it; to leave it out, delete `vendor/mbelib.wasm` — the node then just says the module is missing.
- The page's Content-Security-Policy allows `'wasm-unsafe-eval'` for this.

## DMR

**Digital Voice Decoder** with *protocol = dmr* (the old *DMR Decoder* node is the same engine; saved patches with it open as this node) decodes ETSI DMR (TS 102 361) from raw IQ or FM audio: MotoTRBO, Hytera, Anytone and other radios, amateur and commercial repeaters, direct mode.

- **Input:** IQ (any rate, decimated to ≥48 kS/s inside; put *IQ Frequency Shift* before it if the channel is off-centre, about ±4 kHz is fine) or FM audio. A 12.5 kHz channel, 4FSK at 4800 Bd (±1.944 kHz).
- **Chain:** FM discriminator → slow DC block → RRC (α=0.2) matched filter → 8 bit-clock phases → search for the 48-bit sync words (repeater, mobile, direct mode TS1 / TS2, voice and data, 4 bit errors to lock, more once locked) → the frame grid (30 ms, CACH + burst) is held from the sync words; levels and clock phase are refitted on every sync. The voice and data sync words of a system are each other's inverse, so the polarity of the spectrum is taken from whichever reading makes the slot type / EMB pass FEC — an inverted signal (swapped I/Q) is decoded too.
- **Slots and colour code:** repeater downlink — slot from the CACH (TACT, Hamming 7,4); mobile and direct mode have no CACH — direct mode gives the slot from the sync word, a mobile uplink is shown as *slot A / B*. Colour code from the slot type (Golay 20,8) and EMB (QR 16,7); the CACH Short LC (4 fragments, Hamming 17,12 + CRC-8) gives slot activity and Tier III net / site.
- **Voice:** LC header and terminator (BPTC 196,96 + Reed-Solomon 12,9 with the masks): from, to, group / private, emergency, encrypted, priority; PI header (algorithm, key id, MI); embedded LC (Hamming 16,11 + CRC-5) for late entry; **talker alias** (7-bit, ISO 8-bit, UTF-8, UTF-16). The AMBE+2 voice is *not* turned into sound (no vocoder) — the `voice` output carries the 3 raw frames of each burst (27 bytes hex) with slot, call and A…F position, ready for an external decoder.
- **CSBK / MBC:** **multi-block control** (header + continuation blocks, CRC-16 over the continuations) is assembled into one record; a grant with an absolute channel gets its `rx` / `tx` frequencies (MHz) and `freq` — a place to start when a Tier III system shows up. Opcode names (preamble, BS_Dwn_Act, grants, ACK, alert, radio check…), from / to for the common ones, raw hex; CRC-CCITT with the mask. Tier III: **C_ALOHA** (net / site / model, registration, version) and channel grants (logical channel, slot, emergency).
- **Data and SMS:** data header (unconfirmed, confirmed, short data, UDT, response, proprietary) + rate ½ (BPTC), rate ¾ (8-state trellis) and rate 1 (no FEC) blocks are collected into a message, checked with the CRC-32 (confirmed blocks also with their own CRC-9), and read: IPv4 / UDP (**Motorola TMS text**, LRRP / ARS / XCMP by port), short data by DD format (7-bit, 8-bit), UDT text, **UDT dialer digits (BCD), appended addresses, IP address and address + UTF-16 text** (layout of dsd-fme `dmr_udt_decoder`; the pad nibbles from the header are applied). **Positions:** LRRP (UDP 4001: circle / point tokens, time, heading) and NMEA GGA / RMC in UDT come out as `lat` / `lon` (+ `id`, `label`) and show up on a *Map* node wired to `rec`.
- **Output:** records `{kind: call|end|alias|csbk|data-header|message|pi|slc|emb-lc|…, slot, cc, from, to, text, …}`; the node shows the mode, colour code, both slots, counters and the last events.
- **Checked against:** MMDVMHost (BPTC, LC, CSBK, slot type, EMB, embedded LC, Short LC and CRC vectors from its own classes) and dsd-fme (rate ¾ trellis decoder, CRC-32 convention).
- **Not done:** AMBE+2 to audio; the LIP position report in USBD (only the raw block is shown); Hytera / Motorola manufacturer extensions beyond the generic LC; encryption (only flagged). The CRC-32 byte order, the TMS layout and the LRRP tokens follow dsd-fme and were not checked on a real recording. The generator sends valid frames built by the same tables as the decoder, so it proves the chain, not the interoperability.

**DMR Call Log** (Output) turns the decoder's records into an activity log: who called whom, when and for how long (calls, with the length from the terminator or from the voice-burst count; messages as rows too), counters **per radio ID** (calls, seconds, messages, emergency / encrypted calls, last heard, last group, talker alias, position) and **per talkgroup** (calls, seconds, number of stations). The readout shows the active slots, the latest stations and the last calls. Buttons: *Calls CSV*, *Stations CSV*, *Groups CSV*, *Replay stations*, *Clear*. Outputs: `stations` (one record per changed station, `id` = `dmr:<radio>`, with `lat`/`lon` once it has sent a position — wire it to a *Map*), `calls` (one `call-log` record per finished call), `count`.

Presets: *DMR: Calls, SMS and CSBK (Generator)*, *DMR: Repeater or Direct Mode (USB SDR)*, *DMR: Activity Log and Station Map (Generator)*, *DMR: Activity Log and Station Map (USB SDR)*.

## TETRA

**TETRA Decoder** (`tetraRx`, Decoders, worker) takes the IQ of one 25 kHz channel (any sample rate from 48 kS/s; a signal within about ±6 kHz of the center is fine, the offset is measured and shown) and decodes the **downlink** of a base station's main carrier. Receiver: decimation to 72–144 kS/s, root-raised-cosine 0.35, eight timing phases per symbol (cubic interpolation), differential detection of the π/4-DQPSK phase steps. The *synchronization burst* is found without any prior knowledge: the 32-symbol frequency-correction field (constant +π/4 steps — it also gives the carrier offset), then the 19-symbol synchronization training sequence (normal or spectrum-inverted). The BSCH block (60 bits) is decoded with the fixed scrambling code; it gives colour code, MCC, MNC and the slot / frame / multiframe number, which fixes the cell scrambler. After that the slot grid (255 symbols, ±3 symbols of search per slot, offset tracked) is followed by the training sequences; a cell that is not heard for 12 slots, or gives no valid block for two multiframes, is dropped and the search starts again.

Blocks: descrambling → deinterleaving → depuncturing (RCPC 2/3) → soft Viterbi (K = 5, rate 1/4) → CRC-16. AACH goes through the Reed–Muller (30,14) code. Records (`rec`, `src: TETRA`):

| kind | contents |
|---|---|
| `sync` | MCC, MNC, colour code, TN / FN / MN, sharing mode, late entry |
| `sysinfo` | downlink / uplink frequency (band, carrier, offset, duplex spacing), location area, BS services (voice, SNDCP, air encryption …) |
| `resource` | MAC-RESOURCE: address type and SSI (`to`), event label / usage marker, **encryption mode** (the part after the address is then not readable), channel allocation (timeslot, direction, carrier and frequency from SYSINFO), LLC type and — for MM / CMCE / MLE — the message name (`D-SETUP`, `D-LOCATION UPDATE ACCEPT`, `D-SDS DATA` …); the first bytes of the message as `hex` |
| `message` | **SDS** (see below): `from`, `to`, `service`, `message` (text), `lat` / `lon` / `speed` / `heading` (LIP), `status`, `hex`; with a position also `id` / `label` for the map |
| `call`, `end` | a traffic usage marker appears / disappears in the AACH of a timeslot; duration and number of traffic bursts at the end |

**SDS** (short data, the SMS of TETRA): fragmented MAC messages (MAC-RESOURCE start, MAC-FRAG, MAC-END on the same timeslot) are put together, the LLC / MLE / CMCE layers are peeled off and `D-SDS-DATA` is read: calling SSI, the receiver comes from the MAC address. Decoded: **text** — simple text messaging (PID 2 / 9) and SDS-TL text (PID 130 / 137, with the storage-and-forward fields skipped), alphabets GSM 7-bit, ISO 8859-1 and UCS-2; **status** (the 16-bit short data type); **position** — the LIP short location report (PID 10: longitude, latitude, speed, heading, accuracy, reason); anything else as hex with its protocol ID. Position records carry `id` and `label` like DMR's, so [Messages and Subscribers](#messages-and-subscribers) and the map take them as they are (Messages / Subscribers have a *TETRA* protocol; *signalling too* adds SYNC, SYSINFO and RESOURCE). Not decoded: concatenated SDS (PID 12 / 140), LLC-level segmentation (AL-*), the long LIP report and other LIP PDUs, SDS-TL GPS, other text alphabets; encrypted messages stay encrypted (their records show only the address). The field layouts follow EN 300 392-2 / SDS-TL as implemented in dsd-neo's parser and TS 100 392-18-1 (the PDU type of the short report is 2 bits, which an open-source Go library gets wrong; scaling checked against XPro's LIP PDU generator); the decoder is tested only against the generator here, **not against real SDS captures**.

Slots with a traffic marker are counted, and their speech goes out as `voice` records (`slot`, `usage`, `acelp` — the two 137-bit codec frames of the slot, hex; `encrypted` repeats the air-encryption flag of SYSINFO). The channel decoder is for the full-slot traffic channel TCH/S: matrix deinterleaving, class 0 (102 bits, unprotected) and the 1/3 convolutional code of classes 1 and 2 (8/12 and 8/18 puncturing), bit order of table 4 of EN 300 395-2. Encryption is not looked at: an encrypted call is decoded just the same and sounds like noise. Slots where the first half is stolen (STCH) are tried as signalling and not played.

The ACELP decoder itself is [Vocoder (mbelib)](#vocoder-mbelib)'s third module, `vendor/tetra-acelp.wasm`, built by `tools/tetra-acelp/build.sh` (clang with the wasm32 target, no Emscripten, no libc; fixed-point, nothing is imported from the browser) from [outerplane/tetra-codec](https://github.com/outerplane/tetra-codec), a port of the ETSI EN 300 395-2 V1.3.1 reference decoder — the old TETRA ACELP (240 samples / 137 bits per 30 ms frame), not AMR-WB or EVS. The wasm gives exactly the samples of the ETSI reference decoder on the 30 slots of the "Hello Tetra" recording (14 400 samples, no differences). **Patents and licence:** the TETRA codec may be covered by patents, and the ETSI source terms and the licence of that port are not clear (the port carries no licence file): check them before embedding this in a product. If the file is missing (a fork without it) the Vocoder says *TETRA ACELP not built* and the rest of the decoder works as before. Several PDUs in one block are walked through by their length; fragmented messages are counted but not reassembled, so a long SDS is not shown as text — the message names and addresses are what the decoder gives.

IQ Generator, mode *TETRA*: a test cell on 391.0 MHz (MCC 262, MNC 1011, colour 5) — sync burst in frame 18, control channel in slot 1 (SCH/F and SCH/HD, messages in turn, a channel allocation now and then), a call in slot 2 (traffic bursts with random bits), and SDS: text in three encodings (one long, sent in MAC fragments), statuses and LIP position reports of three moving radios. Presets *TETRA: Test Cell (Generator)* and *TETRA: Control Channel (USB SDR)*.

How much is checked: the channel coding (scrambler, block interleaver, RCPC puncturing and the convolutional encoder, CRC-16, the Reed–Muller generator matrix) gives the same bits as the reference code of [osmo-tetra](https://github.com/osmocom/osmo-tetra) (`tetra_conv_enc`, `tetra_interleave`, `tetra_scramb`, `tetra_rm3014`, `crc_simple`, built and compared on random blocks for BSCH, SCH/HD and SCH/F). The speech channel decoder reproduces the codec frames of the ETSI reference decoder bit for bit on a real recording (the 30 slots of telive's "Hello Tetra" sample, from the test fixtures of dsd-neo: 8220 bits, no differences). The speech channel decoder reproduces the codec frames of the ETSI reference decoder bit for bit on a real recording (the 30 slots of telive's "Hello Tetra" sample, taken from the test fixtures of dsd-neo: 8220 bits, no differences). The ACELP wasm is bit-exact against the ETSI reference output on the same recording (the whole chain: channel decoder + codec → 14 400 samples without a difference). Burst layout, training sequences, SYNC / SYSINFO / MAC-RESOURCE fields and message names follow the same code. Whole signals are checked generator → decoder at 72 kS/s … 2.4 MS/s, with carrier offsets up to ±5.5 kHz, inverted spectrum, ±300 ppm clock error and noise (a broadband SNR of about −4 dB at 288 kS/s still decodes most blocks). The generator and the decoder are written by the same hand, so a wrong symbol-to-bits mapping (the 01 / 10 steps) would not show there — it follows the table of EN 300 392-2 as osmo-tetra uses it. **On-air reception has not been tried on real hardware**; direct-mode, uplink, π/4-DQPSK channels with other bandwidths and the QAM modes are not supported; the speech CRC-8 is not checked, bad frames are not concealed.

## Inmarsat STD-C

**Inmarsat STD-C Decoder** (Decoders, worker) decodes the LES TDM / NCS carriers of the geostationary Inmarsat satellites (L band, 1537–1545 MHz; a patch or helix antenna is enough). It follows SatDump's `inmarsat_stdc` (GPLv3).
- **Demodulation:** PSK Demodulator in BPSK mode, 1200 Bd, RRC α=0.6. For offsets comparable to the symbol rate it searches the frequency on the wide band before the matched filter.
- **Frames:** 64×162-symbol frames every 8.64 s. Unique word (≥ 120 of 128, either polarity), row de-permutation, de-interleaving, Viterbi K=7 (polynomials 109, 79), bit reversal and descrambling → 640 bytes.
- **Packets:** short / medium / long descriptors and the two-byte checksum (bad packets are dropped); multi-frame packets are joined. Bulletin Board gives satellite, LES and frame number. EGC packets (single and double header) are assembled into messages by sequence number.
- **Output:** `rec` per message (`service` — SafetyNET NAVAREA/METAREA, coastal, SAR, FleetNET…, `priority`, `text`, `sat`, `les`) and `text`.

The chain is tested with the generator's STD-C mode (frames with a Bulletin Board and two SafetyNET warnings split over frames) down to Es/N0 ≈ 5 dB, but not yet on a real recording.

Presets: *Inmarsat STD-C: EGC Messages (Generator)*, *Inmarsat STD-C: EGC Messages (USB SDR, 1.5 GHz)*.

## Sample editor

The **Sample Library** node keeps clips in the browser (IndexedDB). **import** (or drop files on it) adds audio files, **● rec** records a new clip: from the `in` port when it is wired and the graph runs, otherwise from the microphone. Tap a clip to open the editor; ▶ in the list plays the clip through the node's `out`.

The editor fills the screen and plays through its own audio output, no wiring needed:

- **Selection**: drag on the waveform; drag the edge handles to adjust it; tap to place the cursor. Drag on the time ruler or the overview strip to scroll; pinch horizontally to zoom in time, vertically to zoom the amplitude (mouse: wheel zooms, Shift+wheel scrolls, Alt+wheel zooms the amplitude)
- **Zoom** goes down to single samples (dots and stems); the amplitude zoom goes down to one 16-bit step. **✏ draw** redraws samples by hand, e.g. to fix a click
- **Playback**: the selection or from the cursor, with **🔁 loop** (the loop region follows the selection)
- **Edits**: crop to selection, delete, cut / copy / paste (between clips too, resampled when the rates differ), silence, fade in / out, normalize (−1 dBFS, DC removed), gain, reverse. Every edit can be undone / redone (Ctrl+Z / Ctrl+Shift+Z)
- **Spectrogram** (〰): under the waveform or alone, with a frequency scale (linear or log), FFT size, palette and dB range. It is computed for the visible range, so it stays sharp at any zoom
- **Noise reduction by profile**: select a piece with noise only → **noise profile**, then select the part to clean (or nothing for the whole clip) → **apply**. It is a spectral gate on the original samples (reduction, sensitivity, frequency and time smoothing); **preview** listens without changing the clip, **residue** lets you hear what gets removed
- **save** overwrites the clip, **＋copy** saves a new one, **⭳ wav** downloads the selection or the whole clip as 16-bit WAV

Keys: Space play/stop, L loop, Del delete, T crop, Ctrl+A/X/C/V, Ctrl+S save, +/−/0 zoom, S view, ←/→ move the cursor, Esc close.

## Tracker

The tracker is a set of nodes in **Music**, wired by the pink `song` port:

- **Tracker Song** — the song, its sequencer and the channel voices. Open a `.mod`, `.s3m` or `.xm` file, tick **play**. `L`/`R` is the mix of all channels (when they are not wired, it plays straight to the default output). `clk` gives a pulse on every row — wire it to the Drum Sequencer, Piano Roll or Sequencer `clk` and they follow the tracker's tempo, speed changes included. **stereo** is the channel separation, **interpolation** — linear or none (the raw Amiga sound). `row`/`pos` give the current row and position. **✎ Edit** opens the full-screen editor
- **Tracker Instrument** — makes an instrument play a generator of the graph instead of samples: every note of instrument **N**, from any channel, goes to up to 4 voices `freq`/`gate`/`vel` (`freq2`/`gate2`… for the others) — exactly the inputs of Synth (4 voices), Sampler, Acid Bass, Synth (2 osc). Portamento, vibrato, arpeggio are in `freq`, volume effects in `vel`, key off / note cut close the `gate`. While the node is wired, the tracker does not look for samples of that instrument (the list marks it `⇢ module`); the synth's output goes wherever you wire it
- **Tracker Channel** — one channel on its own: `out` (mono, after volume), `L`/`R` (with the channel's panning), and the notes: `gate`, `freq`, `note` (MIDI), `vel`, `inst`. **take out of the song mix** removes the channel from the song's `L`/`R`, so it can go through its own effects
- **Tracker Pattern View** — the live pattern with channel meters; double click opens the editor
- **The editor, panel by panel**: **Tracker: Transport**, **Pattern Editor**, **Pattern Sequencer**, **Instrument List**, **Sample / Instrument**, **Keypad**, **Mixer**. Each shows one panel of the same editing session (cursor, current instrument, octave, undo are shared): put them into dashboard tiles (▦) and you get your own tracker layout. Keys go to the tracker after a click in any of its panels. Preset *Tracker Studio (tiles)* lays them out like Renoise: transport on top, pattern sequencer left, pattern in the middle, instruments right, sample/instrument editor, mixer and the module graph below — switch on ▦ after loading it

Preset *Tracker: Synths as Instruments* plays a bass line on the 303 and chords on the 4-voice synth through two Tracker Instrument nodes, and runs the drum machine from `clk`. *Tracker: Channels through Effects* sends channel 1 through a delay.

The **Sampler** node plays a Sample Library clip on 4 voices: pick the clip (↻ library re-reads the list), set **root note** — the MIDI note the clip sounds at — and wire `freq`/`gate` from a Tracker Instrument, the piano roll or a MIDI keyboard. In the tracker itself a slot can also take a clip straight from the library (**library…** in the sample panel).

Formats: MOD (M.K./M!K!/FLT4, 2–32 channels xCHN/xxCH, 15-sample Soundtracker), S3M (8/16-bit samples, channel panning), XM 1.04 (instruments with several samples and a note map, volume and panning envelopes with sustain and loop, fadeout, auto-vibrato, 16-bit and ping-pong samples, linear or Amiga frequencies, 1–256 rows per pattern). Each song is saved back in its own format; MOD converts to S3M or XM, S3M to XM.

The replayer follows each tracker's effect rules: MOD/XM 0–F and E-commands, XM G H K L P R T X and the volume column, S3M A–X with the ST3 shared memories (D/K/L, E/F), fine and extra fine slides, note cut/delay, pattern loop and delay, retrigger, tremor, key off. It was checked against libxmp tick by tick on its test modules.

**Editor** — full screen (**✎ Edit**) or the panel nodes above. Edits are heard right away and are kept in the browser (IndexedDB) together with the patch; **⭳** downloads the song as a regular module file.

- **Pattern**: the cursor row stays in the middle. Arrows move, Tab / Shift+Tab jump between channels, PgUp/PgDn by 16 rows, Home/End. Mouse: click places the cursor, drag selects a block, wheel scrolls (Shift+wheel — channels). Touch: tap places the cursor, drag scrolls
- **Entry**: **Enter** toggles edit mode (red cursor). The keyboard is a piano in the FT2 layout (Z S X D C… — lower octave, Q 2 W 3 E… — upper), physical keys, so it works with any layout; `1` or `` ` `` enters key off (XM) / note cut (S3M). F1–F8 or numpad +/− set the octave, **step** is how many rows the cursor goes down after a note. Instrument and parameter columns take hex digits (S3M instrument and volume — decimal), the effect column — 0–F for MOD, 0–9 and A–Z for XM, letters for S3M. The XM volume column: 00–40 is the volume, 6x–Fx are commands (slides, vibrato, panning, portamento). The status line explains the effect under the cursor
- **Block**: Shift+arrows or mouse drag select, Ctrl+A selects the channel (twice — the whole pattern), Ctrl+C/X/V copy / cut / paste, Del clears, Ctrl+↑/↓ transposes by a semitone (with Shift — by an octave), Insert / Backspace insert / delete a row in the channel. Ctrl+Z / Ctrl+Shift+Z — undo / redo of every edit
- **Channels**: click a channel header to mute it, double click — solo; `⇢` marks a channel taken out by a Tracker Channel node
- **Song** tab: order list (tap a position to edit its pattern), insert / delete positions, change the pattern at a position, new / clone / clear pattern, pattern length (XM), channels, initial speed / tempo, global volume, restart position, linear frequencies (XM)
- **Samples** tab (**Instruments** for XM): name, volume, finetune (MOD/XM), C-4 rate (S3M), panning and relative note (XM), loop off / forward / ping-pong; drag on the waveform to set the loop, ▶ plays the sample. **load** (or drop an audio file on the tracker) imports any audio file — for MOD resampled to play at its own pitch on C-3, for S3M/XM kept at its rate and tuned to C-4; **✎ edit** opens it in the [sample editor](#sample-editor), **save** there writes it back. XM instruments: several samples, the note map (tap or drag over the keys to give them the selected sample), volume and panning envelopes (drag points, double click adds one, **sus** / **loop** at the selected point), fadeout, auto-vibrato
- **Keys** tab / Keypad — the same on screen for phones: two-octave piano, hex and letter pads, key off, cursor keys, block operations
- **Mixer** tab / node — per channel: level meter, volume, panning, mute, solo (volume is kept with the song in the browser; the formats have no place for it)
- Space plays the song from the current position, Shift+Space loops the current pattern from the cursor row; **⇣ follow** keeps the cursor on the playing row

## Data Sequencer

A table of any fields played out row by row — to imitate a moving vehicle, step through frequencies, replay packets and calls, or send a beacon.

- **Data Sequencer** (Sources): load a CSV / TSV, **KML** (Point, LineString, `gx:Track`), **GPX** (waypoints, routes, tracks) or **GeoJSON**, or type the table in *advanced → table* and press *Apply table*. The table is saved in the patch. Every column becomes an output port (a column named like a fixed port gets a `_`); `rec` carries the whole row as a record (for the map, Rec Log, filters), `text` — the *text col* (or the whole row), `row` / `count` / `next` (pulse per row) / `done`. Raw packets work too: put them in a column (hex, text) and wire the port.
- **Advance** (`trig` always steps by one row as well): **rate** — rows/s (0 = only `trig`); **dwell** — each row is held for the seconds in its *dwell col* (frequency stepping: `freq,dwell`); **time** — rows come out at their own timestamps (column `t`, `time`, `timestamp`… ISO, epoch s/ms or `HH:MM:SS`), speed `time ×`; with absolute timestamps and a *Time Base* on `t` the rows follow that clock (set it back and the replay restarts); **distance** — the next row comes out when the path along `lat`/`lon` reaches it at the given `speed` (km/h, m/s or knots; a *speed col* overrides it per row). With *interpolate* the marker moves smoothly between points (*rows/s* = update rate). `dist`, `bearing`, `progress` describe the current leg.
- **Order**: sequential, ping-pong, **random**, **shuffle** (every row once, then again); *loop*, *first row* / *last row* range, the `row` input picks a row (1…N).
- **Trigger Clock** (Control): `trig` pulse and `gate` window. Modes: *interval* (with *jitter* %), *random* (min…max), *poisson* (mean = interval), *schedule* (`08:00, 12:30:15, */15s, */5m` — time of day or every N s/m/h, UTC or local; uses `t` from Time Base when wired). *burst* + *gap*, *delay*, *max N*, `gate` width (a window of N s after every trigger), `reset` input. The pulse lasts one block with a gap of one block between pulses.
- **Time Base** (Control): virtual time — the system clock or a manually set start (UTC) with any speed; outputs `t` (epoch s), `iso`, `tod`; the `set` input takes a new time.

Presets: *Sequencer: Vehicle Track on the Map*, *Sequencer: Frequency Stepper (CSV → Oscillator)*, *Sequencer: Random Beacon (Trigger Clock)*.

### Control logic

Small universal blocks on number wires (a pulse is 0/1, an edge is a crossing of 0.5; unwired inputs are ignored). The *inputs* select (2…8) adds or removes ports; every numeric parameter of every block can also be driven by a wire.

- **Math**: sum, mean, product, min, max, `in1 − rest`, `in1 ÷ rest`, `in1 ^ in2`, `|in1 − in2|`, then gain and offset.
- **Compare**: *above / below / inside / outside* a threshold or window, with hysteresis and a minimum on-time; outputs `out`, `rise`, `fall`. The tile is a small screen: the level history, threshold and hysteresis lines, the on-state shaded. Feed it from Level (dB), Frequency Meter, CFAR SNR, a trend or any number.
- **Logic**: AND, OR, XOR, NAND, NOR, XNOR of 2…8 inputs, `out` and `not`.
- **Select**: `in1…inN` picked by the `sel` index (0 = in1) — e.g. a Flip-Flop output chooses between two frequencies.
- **Flip-Flop**: `set`, `reset`, `clk` (toggle) on rising edges; priority and start state. Two clocks switch something on and off.
- **Sample & Hold**: samples `in` on the `trig` edge, or follows it while `trig` is high.
- **Counter**: counts `clk` edges by *step*, modulo N; `wrap` is a pulse every N-th clock (divider), `phase` is count/N.
- **One-Shot**: a trigger starts a `gate` of *width* after *delay*; `end` pulses when it finishes (a delayed trigger). Retriggerable.
- The **Oscilloscope** has a `hit` output: a pulse each time its trigger fires.

Presets: *Control: Clocks Switch a Tone On and Off*, *Control: Level Trigger (Compare, Counter, One-Shot)*, *Control: Logic Test Bench (all blocks)* (every block in one patch: arpeggio from Counter + Select + Math, gate from Flip-Flop + Compare + Logic, Sample & Hold, One-Shot, scope `hit` counter).

### Indicators

Visual blocks on number wires (Indicators). They draw on a dark screen in both themes and work in the dashboard as tiles.

- **Lamps**: 1…16 round lamps with a glow and labels, one input each. *Threshold* mode lights a lamp at or above the level, *brightness* mode follows the value (0…full scale). *Hold / fade* lets a lamp fade out over the given time, so a one-block pulse (Compare `rise`, a trigger, a flip-flop) is still visible; *blink while on*. Colors are a cycled list: `green, amber, red, blue, teal, violet, pink` or `#rrggbb`.
- **Gauge**: analog needle with a 240° scale, tick labels, optional green / amber / red zones (`amber from`, `red from`), peak marker, needle damping and the value with a unit under the hub. *min* / *max* can be wired.
- **LED Bar**: segmented ladder (horizontal or vertical, by the tile's shape) with the same zones, instant attack, smooth fall and a peak marker. Defaults fit a dB level: −60…0, amber from −18, red from −3.
- **Compass**: azimuth dial with N / E / S / W; `az` is the arrow, `az2` a second marker on the rim (a bearing and a heading, a satellite and the antenna). *Rotate the dial* turns the dial to `az2`. The needle takes the shortest way round 359° → 0°.
- **7-Segment Display**: seven-segment digits (1…12, decimals, leading zeros, unlit segments); *frequency* format turns Hz into kHz / MHz / GHz with the unit. Overflow shows dashes.

- **Sky Plot**: polar plot for azimuth / elevation — north up, the horizon on the rim, zenith in the centre, rings at 30° and 60°. `az` / `el` is the main object, `az2` / `el2` a second one (a satellite and the antenna); a fading trail shows the pass (*trail*, s). An object below the *horizon* is drawn hollow. Wire the `az` / `el` outputs of *Satellites* or a rotator controller to it.
- **S-Meter**: receiver scale S1…S9 (6 dB per step), then +10 … +60 dB; *S9 level* is set in dBm (−73 is the HF standard, use −93 for VHF). Fast attack and slow fall like a real meter, peak marker, the S reading and the level in the corner. The `s` output is the reading in S units (9 = S9, 15 = S9 + 36 dB).
- **Text Ticker**: the latest lines from `text` (a new string is a new line) and `rec` (the *field* is shown, or all fields as `key=value`), as a scrolling log with optional timestamps or as a running line (*marquee*). *Clear* empties it. Good for a decoder's messages next to the other indicators.

Presets: *Indicators: Lamps, Gauge, LED Bar, Compass, Display*, *Indicators: Sky Plot, S-Meter, Text Ticker*.

### Logic Analyzer

**Logic Analyzer** (Analysis): 1…8 channels → digital traces on a common time axis, with a decoder that gives out the **bits and bytes**.

- **Input wires**: *signal* (audio rate — the usual choice, e.g. the `bit` output of *Transmit Chars*, a demodulator's soft output, a square wave) or *number* (one sample per engine block, ~Eng.sr / block, for slow things: lamps, triggers, flip-flops, Compare outputs). A *threshold* with *hysteresis* turns each wire into 0 / 1. The `d1…dN` outputs are the digitised channels. At 44.1 kHz async serial works up to ~9600 baud (at least 4 samples per bit) and I²C / SPI clocks up to ~10 kHz; the readout warns when the baud is too high for the sample rate.
- **Display**: the *window* (1 ms … 10 s) is drawn from the list of edges, not samples, so even long windows are cheap. *Trigger* on a rising / falling edge of a chosen channel (the trigger sits at 25 % of the window; the time axis is relative to it), *single shot* with **Arm**, **Hold / Run** freezes the picture. Decoded bytes are drawn as bubbles on the trace (hex and the character, errors in red).
- **Decoders** (*decoder*; channels are set in the advanced parameters):
  - **UART**: baud, 5…16 data bits, parity (none / even / odd), idle level, bit order (LSB first by default). Start bit is checked in the middle, every bit is sampled at its centre; framing and parity errors are marked and not sent to `text`.
  - **SPI**: clock, MOSI, MISO (optional), CS (optional, active low), word size, order (MSB first by default), sampling edge (rising = modes 0 / 3, falling = modes 1 / 2).
  - **I²C**: SCL + SDA; START / repeated START / STOP, 7-bit address with R / W, data bytes, ACK / NAK (a NAK is marked with `!`).
- **Outputs**: `byte` (last byte), `new` (pulse in the block where a byte arrived — wire it to a lamp or a counter), `text` (a line: UART — on a line feed, after 80 characters or after 1 s of silence; SPI — `MOSI … | MISO …` after CS goes high; I²C — `S 3C+W 00 AF P` after STOP), `rec` (a record per byte: `proto`, `byte`, `hex`, `ch`, `time` — seconds from the start, `err`; I²C adds `kind` and `addr`, SPI `line`), `hit` (a pulse on every trigger). `text` goes to a *Text Ticker*, `rec` to a *Rec Log*.

- **USB logic analyzers** (WebUSB; `input` → *USB* in the advanced parameters): cheap 8-channel analyzers on the Cypress FX2 (Saleae clones, boards with sigrok **fx2lafw** firmware). Channels 1…8 are D0…D7, 8-bit samples at 20 kHz … 24 MS/s straight into the same traces, trigger and UART / SPI / I²C decoders (the `ch` wires disappear). Buttons: *USB: connect* (opens the chooser), *USB: load firmware (.fw)*, *USB: start*, *USB: stop*. A board without firmware (it does not answer the version request) needs a fx2lafw image: take it from the `sigrok-firmware-fx2lafw` package (`/usr/share/sigrok-firmware/`) or from PulseView (`fx2lafw-saleae-logic.fw` for Saleae clones, `fx2lafw-cypress-fx2.fw` for a bare CY7C68013A board) — it is GPL-2.0+, so it is not bundled; it is loaded into the board's RAM and lives until the power is cut. The board then restarts; connect again. The page keeps up with a few MS/s: the readout shows the rate and the captured samples and warns when samples are dropped. Chrome / Edge / Opera only; on Linux the device needs a udev rule (or `chmod`) for the browser to open it.

Presets: *Logic Analyzer: UART Decode*, *Logic Analyzer: USB (fx2lafw)*.

## Infrared

The IR layer is split in three, so the same patch works with any hardware:

1. **A frame is a list of pulse lengths** (µs: mark, space, mark, …) and a carrier. On a wire it is a text `F:38000 9000 4500 560 …`, an event: the text is present only in the block where the frame arrived (the same frame twice in a row is two events). Any of these formats is read automatically and can be written back: plain µs numbers (LIRC), Flipper (`ir tx RAW F:… DC:… …` and `.ir` raw data), Tasmota (`IRsend …`, the MQTT body `38000,9000,…`, `IrReceived.RawData` JSON), Pronto hex.
2. **Codecs** (hardware-independent):
   - **IR Encode** (`go` pulse, the *Send* button, or a text on `text`: `NEC 0x04 0x08`, `Sony12 1 21`, `RC5 5 12 t`, `Samsung 7 2`, `NEC rep`) → `raw`. Protocol, address and command are also wire inputs. RC5 / RC6 flip the toggle bit on every send.
   - **IR Decode**: `raw` → `text` (`NEC addr 0x04 cmd 0x08 [04 FB 08 F7]`), `rec` (a record per frame), `addr`, `cmd`, `new`, and `info` with the analysis of an unknown frame: clusters of mark and space lengths and, for pulse-distance protocols, the header, both pause lengths and the bytes (LSB first). A NEC repeat frame repeats the last code.
   - **IR Learn**: stores the first frame (or the next one after *Capture next*) in a text field saved with the patch — a code in any format can be pasted there; *Replay* or a `go` pulse sends it, with a repeat count and a gap.
   - **IR Merge**: up to four frame sources on one adapter input.
3. **Adapters** (hardware):
   - **IR Sound TX**: the carrier as a sine straight to the sound card (**96 kHz or more**: the sample rate must be at least 2.5 × the carrier) → a transistor and an IR LED; *envelope* gives only the envelope for an external 36–40 kHz modulator (works at any rate).
   - **IR Sound RX**: *baseband* — the output of an IR receiver module (TSOP / VS1838) into the line / microphone input; *carrier* — a photodiode with an amplifier (96 kHz or more): the signal is mixed with the carrier and filtered. Adaptive threshold, glitch filter, a frame ends after a pause (*gap*, 20 ms by default; raise it for air conditioners, whose frames have long pauses inside).
   - **IR Serial (WebSerial)**: `sketch` — [`tools/ir/ir-serial.ino`](tools/ir/ir-serial.ino), a bridge for Arduino / ESP32 / ESP8266 / Pico with the IRremote library (`TX <Hz> <µs…>` / `RX <µs…>`); `flipper` — the Flipper Zero console (`ir tx RAW …`, `ir rx raw`); `wire` — your own firmware, plain `F:38000 …` lines both ways.

Presets: *IR: Remote Codes Loopback (No Hardware)*, *IR: Learn and Replay (Sound Card)*, *IR: Arduino / ESP / Flipper (WebSerial)*.

IR as a data link (not a remote): the same adapters carry any frame, and *Transmit Chars* / *Receive Chars* and the *Logic Analyzer* work on the demodulated line.

## Bluetooth LE

Web Bluetooth works in Chrome, Edge and Opera (desktop and Android) on https or localhost; Firefox and iOS do not support it. The device chooser opens only on a click (*Connect* / *Choose device*). Without the filters the chooser lists every device (*list all devices*); by default it is filtered by the service, or by the name prefix.

- **BLE UART**: `line` / `go` (a line per block, split on line feed) and the `text` input, which writes in chunks (20 bytes by default — safe on any device; with a larger MTU raise it). Profiles: *Nordic UART* (service `6e400001-…`), *HM-10 / FFE0*, *custom* (service, characteristic from the device, characteristic to the device). The line end for sending is selectable. The same line protocols as on a serial port work: wire the `line` output to *IR Decode*, or *Parse CSV Line*.
- **BLE GATT**: service and characteristic as a name (`heart_rate`), a 16-bit hex (`180D`) or a 128-bit UUID; *notify* or *read every period*; the format turns the bytes into a number (`value` with scale and offset), `hex` is always given, `rec` has a record per value. The `write` input sends hex or text to the characteristic (relays, LED strips, thermometers' settings).
- **BLE Advertisements**: RSSI (smoothed), TX power, manufacturer data and `present` (0 after the silence set in the parameters) of one chosen device — `watchAdvertisements`, Chrome 85+ (some versions need `chrome://flags/#enable-experimental-web-platform-features`).
- After a disconnect from the device side the node reconnects every 3 s without the chooser (*reconnect*).

Presets: *BLE: Heart Rate Monitor*, *BLE: Find a Beacon by RSSI*, *BLE: UART Terminal*.

## MQTT

**MQTT In** and **MQTT Out** (MQTT 3.1.1 over WebSocket, written from scratch, no libraries) connect the workbench to any IoT stack. Each node keeps its own connection; `Connect` / `Disconnect` buttons, auto-reconnect every 3 s, a refused login (wrong user or password) is shown and not retried.

- **MQTT In**: `topic` takes several filters separated by spaces or commas. Outputs: `text` and `topic` (one message per block, a burst is queued), `value` (the payload as a number, or the JSON field named in *JSON field* — `a.b.c`; the last value is kept), `rec` (every message of the block: a JSON object or array → records with `topic` and `t` added; plain text or a number → `{topic, text}` / `{topic, value}`), `new` (a pulse per message).
- **MQTT Out**: `text` is published when it changes (empty text is skipped), `value` when it changes, through the template; the `topic` wire overrides the topic parameter; `ok` is 1 while connected. QoS 1 messages are acknowledged but not re-sent.
- Passwords are stored in the patch as plain text — do not share patches with real credentials.

Presets: *MQTT: Subscribe and Publish*, *IR: Tasmota Blaster over MQTT* (send with *IR Encode*, receive Tasmota `IrReceived.RawData` — *IR Decode* reads that JSON and the `38000,9000,…` body of `IRsend` directly).

## Map and records

**Records** (`rec` port) carry objects with arbitrary fields — `{lat, lon, id, snr, …}` — from decoders, CSV files and sensors to the map, logs and filters.

- **Fields → Rec** builds a record from its inputs (the field list is editable, ports appear on *Apply fields*); constants like `icon=plane; color=#f80` are added to every record. With the `rec` input it adds/overrides fields in passing records. Emits on change, on a `go` trigger, or every block.
- **Rec → Fields** splits the last record back into ports; *Fields from last rec* fills the list from what actually arrives.
- **CSV → Rec** (text lines or a whole file, header or explicit field names, `,` `;` tab), **Rec Log** (save CSV / GeoJSON / KML / GPX, replay; the map and *Rec: Unique by Key* export the same way), **Rec Filter** (JS condition over `r`).
- **My Position**: typed in (lat/lon or Maidenhead locator, ⌖ fills it once from geolocation) or live GPS. Other nodes use it for distances and bearings.
- **Geo from Text**: coordinates from any decoded text — degrees/minutes/seconds, NMEA and APRS (`4903.50N/07201.75W`), ACARS (`N55123E037456`), decimal pairs, 6-char locators (4-char optional).
- **Mark Point**: your position + RSSI/SNR/azimuth/frequency as a record, on a button, a trigger or every N seconds.
- **Source Locator**: finds a transmitter from marks (or many at once with *group by*, e.g. `bssid` — one estimate per access point) — signal level (log-distance model, unknown power) and/or bearings; outputs the estimate with an error radius and shows the probability map. Level-based location works on VHF/UHF at short range; on HF (skywave) only bearings make sense.
- **FT8** now outputs decoded messages (`msg`) and records: call, addressee, locator (remembered per call), SNR (2500 Hz, WSJT-X style estimate), distance and azimuth from your position — a propagation map in one wire.
- **Station Schedule** (Radio): EiBi CSV or your own CSV (`khz, time, days, station, lang, target, itu, lat, lon`). Stations on air now go to the spectrum (`bands` → Spectrum Analyzer), the ones on the tuned frequency to the `now` text, transmitters to the map (country centre when the file has no coordinates; EiBi `/XXX` relay sites are used). Download by URL (optional CORS proxy — eibispace.de has no CORS headers) or load the file; it is kept in the browser. Filters: *only aimed at my area* (EiBi target codes — `Eu`, `EEu`, `NAm`, `As`… — worked out from your position, or type your own list, country codes like `RUS` included), *max distance to transmitter*, and `spanLo`/`spanHi` inputs (wire `freqLo`/`freqHi` from USB SDR) to label only what the receiver sees.

**Map** fields: `lat`, `lon` (or `grid` — Maidenhead locator), `id` (same id → one object with a track), `t`, `label`, `icon` (`dot square triangle diamond star cross plus plane antenna tx rx me flag` or any emoji/text), `color`, `size`, `radius` (m, circle), `azimuth` + `range` (km, great-circle bearing line), `heading` (rotates plane/triangle; otherwise taken from the track), `lat2`/`lon2` (line to a second point), `path` (`[[lat,lon],…]` ahead), `track: 0` (no history line), `snr`/`rssi` (colour when no `color`). Everything else is shown as `key: value` on click. Tap on an empty spot — coordinates and locator on the `pick` output.

Works offline: the vector base map (Natural Earth 10m: coast, lakes, rivers, country and region borders, ~7 000 cities, English names) is fetched once from `data/basemap.json` and kept in IndexedDB. *Download places* adds ~130 000 towns from GeoNames (shown from zoom 8), or import a GeoNames dump / CSV `name,lat,lon[,population]`. Optional OSM / OpenTopoMap tiles are cached as you view them and stay available offline. Points can be saved in the browser under a name (*save points as*). Rebuild the base map: `node tools/basemap.mjs`.

- **Satellites** (Radio): SGP4 orbits from CelesTrak TLE groups (amateur, weather, NOAA, stations…) and uplink/downlink frequencies from the SatNOGS database — both downloaded once and kept in the browser (or imported from files; set a CORS proxy if a site refuses cross-origin requests). On the map: position, visibility footprint, ground track ahead; click a satellite to select it. For the selected one: az/el/range, next passes (24 h), sky plot, and **Doppler**: `freq` is the downlink as heard (wire it to `tuneFreq` of the USB SDR — the channel follows the pass), `up` is what to transmit. Downlinks of satellites above the horizon are marked on the spectrum (`bands`). Orbits: [satellite.js](https://github.com/shashwatak/satellite-js) 5.0.0 (MIT) in `vendor/`. TLEs age: refresh them every week or two.

- **Internet Radio** (Sources): search [radio-browser.info](https://www.radio-browser.info) — an open community database with a public API — by name, tag and country; the result is kept in the browser. Stations go to the map (without coordinates — around the country centre); click one to play it: its URL goes to *Audio Stream (URL)*, which now starts on a new URL from the wire. An https page cannot play `http://` streams, and only streams that send CORS headers can be captured into the graph.

Presets: *Internet Radio on the Map*, *Satellites: Track and Doppler*, *FT8: Propagation Map*, *Fox Hunt: Locate Transmitter*, *HF: Who Is On Air (Schedule)*, *Map: My Position and Points from CSV*, *HFDL: Receive and Aircraft Map*, *ADS-B: Aircraft Map (Generator)*.

## Themes

The UI follows the system color scheme (`prefers-color-scheme`). Instrument screens (scopes, spectra, waterfalls) stay dark in both themes.

| | Dark | Light |
|---|---|---|
| Desktop — graph | <img src="docs/screenshots/desktop-graph-dark.png" alt="Desktop — graph, dark"> | <img src="docs/screenshots/desktop-graph-light.png" alt="Desktop — graph, light"> |
| Desktop — dashboard tiles | <img src="docs/screenshots/desktop-dash-dark.png" alt="Desktop — dashboard tiles, dark"> | <img src="docs/screenshots/desktop-dash-light.png" alt="Desktop — dashboard tiles, light"> |
| Tablet — graph | <img src="docs/screenshots/tablet-graph-dark.png" alt="Tablet — graph, dark"> | <img src="docs/screenshots/tablet-graph-light.png" alt="Tablet — graph, light"> |
| Tablet — dashboard tiles | <img src="docs/screenshots/tablet-dash-dark.png" alt="Tablet — dashboard tiles, dark"> | <img src="docs/screenshots/tablet-dash-light.png" alt="Tablet — dashboard tiles, light"> |
| Phone — graph | <img width="260" src="docs/screenshots/phone-graph-dark.png" alt="Phone — graph, dark"> | <img src="docs/screenshots/phone-graph-light.png" alt="Phone — graph, light"> |
| Phone — dashboard tiles | <img width="260" src="docs/screenshots/phone-dash-dark.png" alt="Phone — dashboard tiles, dark"> | <img src="docs/screenshots/phone-dash-light.png" alt="Phone — dashboard tiles, light"> |
| Desktop — module graph pane | <img src="docs/screenshots/desktop-modgraph-dark.png" alt="Desktop — module graph pane, dark"> | <img src="docs/screenshots/desktop-modgraph-light.png" alt="Desktop — module graph pane, light"> |
| Phone — module graph pane | <img width="260" src="docs/screenshots/phone-modgraph-dark.png" alt="Phone — module graph pane, dark"> | <img src="docs/screenshots/phone-modgraph-light.png" alt="Phone — module graph pane, light"> |

### Dashboard tiles

The ▦ button switches to a tiled dashboard built from the modules of the current patch:

- Pick any module for each pane from its dropdown
- **Tabs in a pane**: **+** next to the dropdown adds a tab, so one pane switches between several modules; the dropdown belongs to the active tab, ⨯ closes it
- Split panes right (⬌) or down (⬍), remove them (✕), drag dividers to resize; panes sit edge to edge, 1px dividers
- **⊡** or a double-click (double-tap) on an empty spot of the pane header maximizes the pane; the same or Esc restores the layout
- In narrow panes and on touch the pane buttons fold into **⋯**
- ⛶ shows only the module's display, without controls and header
- **Tile pages**: **+** next to ▦ adds another set of tiles; switch pages with the numbered buttons (or Alt+1…9), tap the active one to rename, duplicate, reorder or delete it. A module can appear on several pages
- The layout is saved with the patch and works on touch devices (wide scroll rail for long panes)

### Module graph pane

Pick **◇ Module graph** in a pane's dropdown and that pane becomes a window into the regular node canvas — like the modules window in SunVox, with the modules' own controls in the panes around it.

- Nodes look and work exactly as outside the dashboard: drag, wire, pan, zoom (wheel or two fingers)
- A module opened in another pane stays on the graph as a dashed stub with its ports, so its wires are visible and can be re-patched
- **⊕** or a double-click on an empty spot opens module search (type, ↑/↓, Enter); **⤢** fits the patch into the pane
- One graph pane per tile page; it is saved with the layout

<img src="docs/screenshots/desktop-modgraph-dark.png" alt="Module graph pane with an acid bass and drum sequencer in neighbouring panes">

<img src="docs/screenshots/desktop-modpick-dark.png" alt="Adding a module from the graph pane: search popup">

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
