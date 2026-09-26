# DSP workbench

A browser-based modular DSP lab: build signal chains by wiring nodes on a canvas. Runs fully client-side, no build step, works offline as a PWA.

## Features

### Workbench
- Node graph editor: pan/zoom canvas, drag-and-drop modules, typed ports (signal, number, spectrum, image, text, block)
- Dashboard view (split panes, draggable dividers) for building instrument-like UIs
- Groups (nested subgraphs) with custom inputs/outputs
- Undo/redo, duplicate, multi-select, module search (Ctrl+K)
- Save/load patches to local storage or JSON files
- 66 built-in presets: demos, quick scenarios, radio protocols, music, analysis
- Adjustable block size, sample rate and run speed (×1…×32)
- AudioWorklet engine, SharedArrayBuffer path when cross-origin isolated
- Installable PWA with offline support

### Sources
- Oscillator, sweep/jammer, constant, LFO, text source
- Microphone (stereo A+B), audio file, audio stream URL, tab/screen audio capture
- **USB SDRs** directly via WebUSB: RTL-SDR, HackRF, Airspy R2/Mini, SDRplay RSP1 / MSi2500 — multiple tuners/demodulators per device, wideband sweep with a panoramic waterfall, IQ recording and playback in WAV / SigMF (see [USB SDR](#usb-sdr))
- **KiwiSDR** remote receivers (public list included)
- Camera, video, image, accelerometer and Generic Sensor API
- Serial port (WebSerial), CSV files, lists

### Analysis
- Spectrum analyzer / waterfall (optional phosphor view; the waterfall keeps its history at full resolution, so zoom, dB range and palette changes redraw it without losing detail), persistence spectrum, oscilloscope, constellation, eye diagram
- CFAR signal detector, channel SNR, channel grid, band scanner, auto frequency scanner
- Band plans, bookmarks, signal recognition and signal type identifier
- Goertzel, autocorrelation, cross-correlation, frequency response / coherence
- Harmonics & THD, third-octaves, LUFS-like loudness, level statistics, spectral descriptors
- Impulse response & RT60, bird song analyzer, frequency meter, trend charts

### Processing
- Filters, gain, mixers (4/12 ch), AGC, squelch, mains notch, adaptive hum canceller (tracks mains frequency, all harmonics), comb notch, adaptive filter, spectral denoiser
- FFT, Zoom-FFT (I/Q), Hilbert transform, quadrature shift, magnitude/phase, wavelet (constant-Q), cepstrum
- Beamformer, phase scope (X-Y), envelope, calibration, capture & loop
- Audio effects: delay, reverb, distortion, compressor/limiter, EQ, chorus/flanger/phaser, pitch shifter

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
- HFDL: full receive chain down to ACARS / ADS-C with aircraft map
- Building blocks: CRC, scrambler, interleaver, convolutional encoder / Viterbi, sync word search, async serial, NRZ clock, text ↔ bits

### Music
- Synths (2 osc, 4 voices), acid bass (303), drum sequencer, sample library
- Piano roll, step sequencer, generative melody, arrangement playlist, master clock
- MIDI keyboard input, ADSR envelope

### Output & extensibility
- Sound card output, WAV recording, CSV log, trigger recorder
- Aircraft map, screen transmitter, indicators
- Module Builder and Script nodes for writing custom DSP code in the browser

## USB SDR

The **USB SDR** node talks to the receiver directly over WebUSB (Chrome, Edge, Opera), no drivers or native software needed. Up to 4 demodulator channels share one device.

| Device | Sample rate | Samples | Linux kernel modules to unload |
|---|---|---|---|
| RTL-SDR (RTL2832U + R820T/R828D, incl. Blog V4) | up to 3.2 MSPS | 8 bit | `dvb_usb_rtl28xxu` |
| HackRF One / Jawbreaker / rad1o | 2–20 MSPS | 8 bit | `hackrf` |
| Airspy R2 / Mini | rates reported by firmware | 12 bit | `airspy` |
| SDRplay RSP1 and clones, MSi2500 + MSi001 TV sticks | 1.3–15 MSPS | 14 bit up to 6 MSPS, then 12 / 10 / 8 bit | `msi001`, `msi2500` |

Common controls: gain (auto or manual), bias-tee, ppm correction, center shift off DC.

- **HackRF** has separate LNA / VGA / amp controls instead of the gain slider.
- **SDRplay / MSi2500** has no hardware AGC: *auto* sets a fixed 62 dB, the manual slider covers 0–102 dB of LNA + mixer + baseband gain. The driver is a port of [libmirisdr-4](https://github.com/f4exb/libmirisdr-4). RSP1A / RSP2 IDs are recognized but untested; RSPduo, RSPdx and newer models need the closed SDRplay API and are not supported.

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

### Dashboard tiles

The ▦ button switches to a tiled dashboard built from the modules of the current patch:

- Pick any module for each pane from its dropdown
- Split panes right (⬌) or down (⬍), remove them (✕), drag dividers to resize
- ⛶ shows only the module's display, without controls and header
- The layout is saved with the patch and works on touch devices (wide scroll rail for long panes)

## Screenshots

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
