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
- Add modules right on the canvas: double-click an empty spot (or **+** in the graph pane) and search
- Groups (nested subgraphs) with custom inputs/outputs
- Undo/redo, duplicate, multi-select, module search (Ctrl+K)
- Save/load patches to local storage or JSON files
- 68 built-in presets: demos, quick scenarios, radio protocols, music, analysis
- Adjustable block size, sample rate and run speed (×1…×32)
- AudioWorklet engine, SharedArrayBuffer path when cross-origin isolated
- Installable PWA with offline support

### Sources
- Oscillator, sweep/jammer, constant, LFO, text source
- Microphone (stereo A+B), audio file, audio stream URL, tab/screen audio capture
- **USB SDRs** directly via WebUSB: RTL-SDR, HackRF, Airspy R2/Mini, SDRplay RSP1 / MSi2500, RX-888 (mkI/mkII/mkIII) — multiple tuners/demodulators per device, wideband sweep with a panoramic waterfall, IQ recording and playback in WAV / SigMF (see [USB SDR](#usb-sdr))
- **KiwiSDR** remote receivers (public list included)
- Camera, video, image, accelerometer and Generic Sensor API
- **tinySA / tinySA Ultra** spectrum analyzer over WebSerial: sweep into the spectrum/waterfall, screenshots, signal generator (see [tinySA](#tinysa))
- Serial port (WebSerial), CSV files, lists
- **Text over Network**: WebSocket (`ws://`, `wss://`, with reconnect and a `send` input) or HTTP(S) polling; lines one per block like the serial port, JSON objects/arrays straight into records. Example — Wi-Fi scan from Android (Termux): `websocat -t ws-l:0.0.0.0:8765 sh-c:'while :; do termux-wifi-scaninfo | jq -c .; sleep 30; done'`. [`tools/termux/wifi-scan.sh`](tools/termux/wifi-scan.sh) adds the phone's GPS position to every scan — preset *Wi-Fi: Locate Access Points (Termux)* puts each access point on the map while you walk around. From the https demo the browser only allows `wss://`/`https://` to other devices (`ws://`/`http://` work to localhost, or when the app is opened over http)

### Analysis
- Spectrum analyzer / waterfall (optional phosphor view; the waterfall keeps its history at full resolution, so zoom, dB range and palette changes redraw it without losing detail), persistence spectrum, oscilloscope (auto/normal/single trigger with level, slope, position, hysteresis and holdoff; sub-sample trigger alignment, averaging, persistence, sin(x)/x interpolation, XY, math channel, AC/DC coupling, time/level cursors, automatic measurements, Autoset, Run/Stop with history scroll), constellation, eye diagram
- CFAR signal detector (noise estimate in linear power: OS — 75th percentile, robust to strong neighbours; SO — smallest of the two sides; CA — mean; a target is shown after M hits in the last N spectrum frames, so single noise spikes are dropped; outputs SNR of the strongest target and the noise floor), channel SNR, channel grid, band scanner, auto frequency scanner
- Band plans, bookmarks, signal recognition
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
- **4FSK Digital Voice** — one decoder for **DMR, P25 Phase 1, NXDN 9600, YSF, M17, D-STAR and dPMR**: the protocol is found by its sync words (or picked by hand), records and raw vocoder frames on separate outputs (see [4FSK Digital Voice](#4fsk-digital-voice))
- **DMR** (Tier II / III, repeater, mobile or direct mode): 4FSK 4800 Bd → colour code, time slots, voice calls (from → to, emergency, encrypted, talker alias), CSBK, data and SMS, raw AMBE+2 frames (see [DMR](#dmr))
- Building blocks: CRC, scrambler, interleaver, convolutional encoder / Viterbi, sync word search, async serial, NRZ clock, text ↔ bits

### Music
- Synths (2 osc, 4 voices), acid bass (303), drum sequencer, sample library with an audio editor (see [Sample editor](#sample-editor))
- **Tracker**: plays and edits MOD (ProTracker), S3M (Scream Tracker 3) and XM (FastTracker 2); split into graph nodes: song, single channels, instruments played by your own generator modules, pattern view, and every editor panel as its own node — lay them out in dashboard tiles as your own Renoise-style editor (see [Tracker](#tracker))
- **Sampler**: polyphonic (4 voices) player of Sample Library clips, pitched by `freq` — plays from the tracker, piano roll or MIDI
- Piano roll, step sequencer, generative melody, arrangement playlist, master clock
- MIDI keyboard input, ADSR envelope

### Output & extensibility
- Sound card output (per-node output device selection, peak/clip meter), WAV / MP3 recording (files named by date and time), CSV log, trigger recorder
- **Map** (offline vector base map, optional OSM tiles, tracks, markers — see [Map and records](#map-and-records)), screen transmitter, indicators
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

- **IQ Generator** — a test signal (carrier, AM, FM, **WFM stereo** with a pilot and RDS station name — the tone in the left channel only, to check separation — USB, LSB, **ADS-B** — DF17 frames from three simulated aircraft, **LRPT** — Meteor-M CCSDS frames with an MSU-MR test picture, OQPSK + NRZ-M or QPSK, **RS41** — a radiosonde going up, **STD-C** — an Inmarsat-C TDM carrier with EGC warnings, **MPT1327** — a control channel with test codewords, **ISM433** — OOK or 2-FSK telegrams of a Nexus-type sensor, an EV1527 remote and an unknown Manchester packet, **DMR** — a repeater downlink with a voice call, CSBK and text messages, or a mobile uplink / direct-mode signal, **4FSK** — a test transmitter per digital voice protocol: P25 voice and control channel, NXDN, YSF, M17, D-STAR, dPMR) at an offset from the center, plus noise; sample rate up to 2.4 MS/s. *clock error, ppm* simulates a source whose clock differs from the sound card
- **USB SDR → `iq`** — the raw IQ at the native rate (live or from IQ file playback); samples of the old frequency after a retune are not passed on. The USB buffers go on as they are (8 or 16 bit) and are turned into floats by whoever reads them — for an IQ chain in a worker that happens in the worker, not on the main thread
- **IQ Frequency Shift** — brings `freq` (absolute Hz, e.g. marker `f1` of a Spectrum Analyzer) or center + *offset* down to 0 Hz
- **IQ Decimator** — windowed-sinc FIR (Blackman) and decimation by 2…64; *cutoff* is a fraction of the output rate. Works on complex and real streams
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

## 4FSK Digital Voice

**4FSK Digital Voice** (`fskRx`, Decoders, worker) is a universal receiver for the digital voice systems that share one physical layer: an FM discriminator, a root-raised-cosine matched filter, eight clock phases per symbol and a sync-word search. **DMR Decoder** is the same engine with only DMR switched on. The *protocol* parameter is *auto* (all of them at once: channels of the same baud rate, roll-off and level count share one filter chain — 4800 Bd RRC 0.2 for DMR / P25 / NXDN / YSF, 4800 Bd RRC 0.5 for M17, 4800 Bd 2FSK for D-STAR, 2400 Bd for dPMR) or one protocol. Input is IQ at any rate (or FM audio); polarity is found by the sync words and by FEC. Every protocol has its own lock, so a decoder that sees a wrong sync gives it up after the first frame that does not decode.

Outputs: `rec` — records (`src` = protocol, `kind` = call / end / message / …, and a `text` line), `voice` — raw vocoder frames as hex (`ambe`, `imbe`, `codec2` fields). Voice is **not** decoded to audio. The IQ Generator has a **4FSK** mode with a test transmitter for each protocol.

| Protocol | What is decoded |
| --- | --- |
| **P25 Phase 1** (C4FM 4800 Bd) | NID (NAC, DUID; BCH(63,16)), HDU (Golay + RS(36,20), MI, algorithm, key, talkgroup), LDU1 link control (group / private call, source, destination, emergency, encryption) and LDU2 encryption sync (RS(24,12) / (24,16), Hamming(10,6)), low-speed data, TDU, TDULC (link control at the end of a call), **TSDU / TSBK** with 1–3 blocks (trellis ½ + CRC): channel identifiers (IDEN_UP, with frequency arithmetic), RFSS / network / adjacent-site status, group grants with frequency, affiliation / registration, service broadcast; PDU header. Frame clock drift is tracked across the 180 ms LDUs. |
| **NXDN 9600** (4FSK 4800 Bd) | LICH, SACCH superframes (RAN, layer 3 in four segments), FACCH1 (CRC-12), UDCH (CRC-15), K=5 convolution with puncturing, scrambler; layer-3 messages (voice call, TX release, disconnect, data call header…), 72-bit AMBE frames. Control channel (CAC, 300 bits, CRC-16 as in dsd-fme): SITE_INFO (location, channels, services), VCALL_ASSGN with channel and other layer-3 messages. NXDN 4800 is not decoded. |
| **M17** (4FSK 4800 Bd, RRC 0.5) | LSF (callsigns, TYPE, META: text / GNSS / extended callsigns, CRC), stream frames (LICH with Golay(24,12), frame number, 16 bytes of Codec 2, last-frame flag), late-entry LSF from LICH chunks, packet mode (SMS text, CRC), BERT (PRBS9 statistics). |
| **YSF** (C4FM 4800 Bd) | FICH (Golay + convolution + CRC-16: frame type, DT, FN / FT, DG-ID), header / communications / terminator, callsigns (destination, source, downlink, uplink) in V/D mode 1 and 2, raw AMBE blocks; data and voice full-rate frames come out raw. |
| **D-STAR** (GMSK 4800 Bd) | Header (K=3 convolution, 24×28 interleave, scrambler, CRC-16: MY, YOUR, RPT1, RPT2), voice frames, slow data (text, GPS NMEA, header copy — a call is recognised even if the header was missed), end pattern. |
| **dPMR** (4FSK 2400 Bd) | FS2 payload units: colour code, control channel (scrambler, Hamming(12,8), CRC-7: called and calling ID, mode, version), 8 raw traffic-channel frames per unit. Header (FS1) and end frames are not decoded. |

How much is checked: the codes and frame layouts are compared with the code of other implementations — P25, NXDN, YSF and D-STAR against MMDVMHost / the MMDVM firmware (real encoder output), M17 against libm17, dPMR primitives against dsd-fme (`tools/test/ref` has the reference programs, `tools/test/data/fsk4-vectors.json` the vectors). Whole signals are checked generator → decoder (all sample rates, noise, inverted spectrum, ±300 ppm clock error); **on-air reception has not been tried on real hardware yet**, and dPMR has no independent frame encoder to compare with.

## DMR

**DMR Decoder** (Decoders, worker) decodes ETSI DMR (TS 102 361) from raw IQ or FM audio: MotoTRBO, Hytera, Anytone and other radios, amateur and commercial repeaters, direct mode.

- **Input:** IQ (any rate, decimated to ≥48 kS/s inside; put *IQ Frequency Shift* before it if the channel is off-centre, about ±4 kHz is fine) or FM audio. A 12.5 kHz channel, 4FSK at 4800 Bd (±1.944 kHz).
- **Chain:** FM discriminator → slow DC block → RRC (α=0.2) matched filter → 8 bit-clock phases → search for the 48-bit sync words (repeater, mobile, direct mode TS1 / TS2, voice and data, 4 bit errors to lock, more once locked) → the frame grid (30 ms, CACH + burst) is held from the sync words; levels and clock phase are refitted on every sync. The voice and data sync words of a system are each other's inverse, so the polarity of the spectrum is taken from whichever reading makes the slot type / EMB pass FEC — an inverted signal (swapped I/Q) is decoded too.
- **Slots and colour code:** repeater downlink — slot from the CACH (TACT, Hamming 7,4); mobile and direct mode have no CACH — direct mode gives the slot from the sync word, a mobile uplink is shown as *slot A / B*. Colour code from the slot type (Golay 20,8) and EMB (QR 16,7); the CACH Short LC (4 fragments, Hamming 17,12 + CRC-8) gives slot activity and Tier III net / site.
- **Voice:** LC header and terminator (BPTC 196,96 + Reed-Solomon 12,9 with the masks): from, to, group / private, emergency, encrypted, priority; PI header (algorithm, key id, MI); embedded LC (Hamming 16,11 + CRC-5) for late entry; **talker alias** (7-bit, ISO 8-bit, UTF-8, UTF-16). The AMBE+2 voice is *not* turned into sound (no vocoder) — the `voice` output carries the 3 raw frames of each burst (27 bytes hex) with slot, call and A…F position, ready for an external decoder.
- **CSBK / MBC:** **multi-block control** (header + continuation blocks, CRC-16 over the continuations) is assembled into one record; a grant with an absolute channel gets its `rx` / `tx` frequencies (MHz) and `freq` — a place to start when a Tier III system shows up. Opcode names (preamble, BS_Dwn_Act, grants, ACK, alert, radio check…), from / to for the common ones, raw hex; CRC-CCITT with the mask. Tier III: **C_ALOHA** (net / site / model, registration, version) and channel grants (logical channel, slot, emergency).
- **Data and SMS:** data header (unconfirmed, confirmed, short data, UDT, response, proprietary) + rate ½ (BPTC), rate ¾ (8-state trellis) and rate 1 (no FEC) blocks are collected into a message, checked with the CRC-32 (confirmed blocks also with their own CRC-9), and read: IPv4 / UDP (**Motorola TMS text**, LRRP / ARS / XCMP by port), short data by DD format (7-bit, 8-bit), UDT text. **Positions:** LRRP (UDP 4001: circle / point tokens, time, heading) and NMEA GGA / RMC in UDT come out as `lat` / `lon` (+ `id`, `label`) and show up on a *Map* node wired to `rec`.
- **Output:** records `{kind: call|end|alias|csbk|data-header|message|pi|slc|emb-lc|…, slot, cc, from, to, text, …}`; the node shows the mode, colour code, both slots, counters and the last events.
- **Checked against:** MMDVMHost (BPTC, LC, CSBK, slot type, EMB, embedded LC, Short LC and CRC vectors from its own classes) and dsd-fme (rate ¾ trellis decoder, CRC-32 convention).
- **Not done:** AMBE+2 to audio; the LIP position report in USBD (only the raw block is shown); Hytera / Motorola manufacturer extensions beyond the generic LC; encryption (only flagged). The CRC-32 byte order, the TMS layout and the LRRP tokens follow dsd-fme and were not checked on a real recording. The generator sends valid frames built by the same tables as the decoder, so it proves the chain, not the interoperability.

**DMR Call Log** (Output) turns the decoder's records into an activity log: who called whom, when and for how long (calls, with the length from the terminator or from the voice-burst count; messages as rows too), counters **per radio ID** (calls, seconds, messages, emergency / encrypted calls, last heard, last group, talker alias, position) and **per talkgroup** (calls, seconds, number of stations). The readout shows the active slots, the latest stations and the last calls. Buttons: *Calls CSV*, *Stations CSV*, *Groups CSV*, *Replay stations*, *Clear*. Outputs: `stations` (one record per changed station, `id` = `dmr:<radio>`, with `lat`/`lon` once it has sent a position — wire it to a *Map*), `calls` (one `call-log` record per finished call), `count`.

Presets: *DMR: Calls, SMS and CSBK (Generator)*, *DMR: Repeater or Direct Mode (USB SDR)*, *DMR: Activity Log and Station Map (Generator)*, *DMR: Activity Log and Station Map (USB SDR)*.

## Inmarsat STD-C

**Inmarsat STD-C Decoder** (Decoders, worker) decodes the LES TDM / NCS carriers of the geostationary Inmarsat satellites (L band, 1537–1545 MHz; a patch or helix antenna is enough). It follows SatDump's `inmarsat_stdc` (GPLv3).
- **Demodulation:** PSK Demodulator in BPSK mode, 1200 Bd, RRC α=0.6. For offsets comparable to the symbol rate it searches the frequency on the wide band before the matched filter.
- **Frames:** 64×162-symbol frames every 8.64 s. Unique word (≥ 120 of 128, either polarity), row de-permutation, de-interleaving, Viterbi K=7 (polynomials 109, 79), bit reversal and descrambling → 640 bytes.
- **Packets:** short / medium / long descriptors and the two-byte checksum (bad packets are dropped); multi-frame packets are joined. Bulletin Board gives satellite, LES and frame number. EGC packets (single and double header) are assembled into messages by sequence number.
- **Output:** `rec` per message (`service` — SafetyNET NAVAREA/METAREA, coastal, SAR, FleetNET…, `priority`, `text`, `sat`, `les`) and `text`.

The chain is tested with the generator's STD-C mode (frames with a Bulletin Board and two SafetyNET warnings split over frames) down to Es/N0 ≈ 5 dB, but not yet on a real recording.

Presets: *Inmarsat STD-C: EGC Messages (Generator)*, *Inmarsat STD-C: EGC Messages (USB SDR, 1.5 GHz)*.

## Tests

Smoke tests run the engine without a sound card in headless Chromium: a few presets (decoded RTTY text, APRS frames with a good CRC, sound on the output) and the IQ chain (tone frequency and level after FM/AM/SSB, sideband rejection, bridge lock to a drifting clock, decimator and channelizer independent of chunk sizes, channelizer gain, offset and neighbour rejection, two receivers from one channelizer, WFM stereo separation and RDS, SAM lock with a carrier offset, SSB AGC, de-emphasis, noise blanker, squelch, ADS-B (reference frames, generator → decoder at 2 and 2.4 MS/s, bit correction), DC block, I/Q merge, auto notch, USB SDR `iq` output from an IQ file), and the same chains in workers: one island per connected chain, values and spectra coming back, parameters followed on the fly, the worker and its state kept when wires change, fallback to the main thread when workers are blocked, and the workers starting on a cross-origin isolated page (as served by the service worker). For GSM: the SCH convolutional code / CRC round-trip and BSIC/frame-number parsing, channel estimation + MLSE recovering a synthetic normal burst, FCCH detection with carrier-offset estimation, and the BCCH chain (xCCH de-interleave + Viterbi + FIRE CRC, SI3 → Cell ID / PLMN / LAC, and CRC rejecting a corrupted block). For Meteor-M LRPT / CCSDS: convolutional code vs SatDump's sync pattern, RS parity vs `reedsolo`, PN, RS correcting up to 16 bytes and the dual basis, generator → PSK demodulator → CCSDS decoder for OQPSK+NRZ-M and QPSK (with internal decimation), a weak signal, noise alone giving no frames, the worker island and both presets; MSU-MR: Huffman codes as in SatDump's tables, segment encode → decode, M_PDU demux with a lost frame, the test picture coming out of the generator preset. For RS41: reference frames and a real recording against `rs41mod`, generator at 256k and 1.024M with T/RH, noise only, worker island, presets. For STD-C: frame round trip (also with 6% symbol errors), checksum, Bulletin Board, EGC assembly, generator → BPSK demodulator → decoder at +900 Hz and at Es/N0 ≈ 5 dB, noise only, worker island, presets. For ISM 433: pulse train → Nexus / EV1527 fields with ±8…10% timing jitter, a single repeat, an unknown Manchester packet described (encoding, T, bits), random pulses giving no protocol, generator → decoder for OOK at 250 kS/s, 1.024 MS/s and 2.4 MS/s and for FSK, repeats skipped by the window, noise only, the worker island, preset. For MPT 1327: the CRC-15 check value, encode → check with a single-bit error rejected, generator → decoder at 48 kS/s, 256 kS/s and 1.024 MS/s, noise only, presets. For DMR: slot type and EMB codewords with errors, BPTC / LC / CSBK / header / embedded LC / Short LC vectors from MMDVMHost, the rate ¾ trellis against dsd-fme, CRC-32 and TMS parsing, generator → decoder at 48 kS/s, 256 kS/s and 1.024 MS/s (colour code, both slots, call, alias, terminator, TMS, LRRP position and short data with a good CRC, CSBK incl. C_ALOHA and a grant, an MBC grant with rx / tx frequencies, confirmed data with CRC-9, rate 1 data, Short LC); the call log: counters per radio and per group, call durations, the position on the map, CSV, outputs and both presets, NMEA / LRRP parsing, inverted spectrum, ±200…300 ppm of clock error, mobile uplink and direct mode TS1 / TS2, noise only, the worker island, presets. For RTL-SDR gain: every librtlsdr step, the USB worker source compiling with the gain tables, the slider switching auto off. For records: `recUniq` dedup by key with counts and first/last time.

```
cd tools/test
npm install            # playwright
npx playwright install chromium
npm test               # or: node run.mjs <part of a test name>
```

The same runs in GitHub Actions on every pull request.

Performance tools in the same folder: `node bench.mjs [sr] [M]` measures each IQ block's share of a CPU core in Node; `node profile.mjs ["preset" | baseline]` plays a synthetic 2.4 MS/s IQ file through a USB SDR preset in Chromium and prints main-thread stalls and the top functions by self time.

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

## Map and records

**Records** (`rec` port) carry objects with arbitrary fields — `{lat, lon, id, snr, …}` — from decoders, CSV files and sensors to the map, logs and filters.

- **Fields → Rec** builds a record from its inputs (the field list is editable, ports appear on *Apply fields*); constants like `icon=plane; color=#f80` are added to every record. With the `rec` input it adds/overrides fields in passing records. Emits on change, on a `go` trigger, or every block.
- **Rec → Fields** splits the last record back into ports; *Fields from last rec* fills the list from what actually arrives.
- **CSV → Rec** (text lines or a whole file, header or explicit field names, `,` `;` tab), **Rec Log** (save CSV / GeoJSON, replay), **Rec Filter** (JS condition over `r`).
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
