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
- USB SDR `iq` output (raw IQ at the native rate, also from IQ file playback), IQ generator, IQ spectrum

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

Common controls: gain (auto or manual), bias-tee, ppm correction, center shift off DC.

**ADC overload**: the status line shows the ADC peak and mean power in dBFS over the last ~0.5 s, and **⚠ OVERLOAD** (held for 3 s) when more than 0.01% of I/Q samples sit on the ADC rails. With an 8-bit RTL-SDR a strong local station easily does that, and the spectrum then fills with intermod products that are not real signals — lower the gain until the warning goes away; a mean level around −30…−15 dBFS is usually a good spot. Outputs `adcPk`, `adcRms` (dBFS), `clip` (% of samples) and `ovl` (0/1) let a patch react, e.g. gate a detector or step the gain down.

The `spec` output uses all the IQ that arrives between updates, not one FFT frame: frames overlap by 50% and their power is averaged (Welch's method, **spectrum averaging** sets the maximum number of frames, `all` by default). At 2.4 MSPS with a 4096-point FFT that is ~90 frames per update, so the noise floor spread drops from ~±5 dB to ~±0.5 dB and weak carriers stand out; detectors (CFAR, channel SNR) can run with a lower threshold. Levels are in dBFS: 0 dB is a full-scale complex tone, whatever the window.

**Signal level and squelch** (per channel): RSSI is the power inside the channel filter in dBFS (for FM and SSB a separate sharp band filter is used for the measurement, so neighbours in the transition band don't count); SNR is taken from the spectrum — mean level inside the channel against the quieter of the two bands just outside it, so a busy neighbour on one side does not raise the noise estimate. **squelch** mutes a channel by `SNR` (does not depend on gain) or by `level` (RSSI threshold, dBFS), with 3 dB hysteresis and a **hang** time; the gate is applied to the audio exactly at the chunk the level was measured on. Outputs `rssi`/`snr` (and `rssi2…4`, `snr2…4` for the other channels) and `sqOpen` for channel 1, e.g. to start a recorder. On a Spectrum Analyzer wired to `spec` the channel band shows the squelch in the trace's own scale: a dashed line at the threshold and a solid line at the current mean level in the channel (solid above dashed — open, the band label says `SQL open/closed`); a marker sitting on a channel shows that channel's RSSI (dBFS) / SNR — exactly the numbers the squelch compares — instead of the peak level around the marker.

Fine marker tuning (e.g. SSB): the mouse wheel over a marker's label moves it by 10 Hz (Ctrl — 1 Hz, Shift — 100 Hz); dragging the label moves it at 1/10 of the normal pan speed; clicking the active marker's label asks for an exact frequency.

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

## IQ blocks

A wire of the **IQ** type (lime) carries a stream at its own sample rate: each engine block it brings as many samples as the source produced since the previous block (none, one chunk or several), together with the stream's sample rate and center frequency. So a chain can run at 2.4 MS/s next to audio at 48 kHz, and a receiver is wired from blocks instead of being hidden inside the SDR node.

- **IQ Generator** — a test signal (carrier, AM, FM, USB, LSB) at an offset from the center, plus noise; sample rate up to 2.4 MS/s. *clock error, ppm* simulates a source whose clock differs from the sound card
- **USB SDR → `iq`** — the raw IQ at the native rate (live or from IQ file playback); samples of the old frequency after a retune are not passed on. The USB buffers go on as they are (8 or 16 bit) and are turned into floats by whoever reads them — for an IQ chain in a worker that happens in the worker, not on the main thread
- **IQ Frequency Shift** — brings `freq` (absolute Hz, e.g. marker `f1` of a Spectrum Analyzer) or center + *offset* down to 0 Hz
- **IQ Decimator** — windowed-sinc FIR (Blackman) and decimation by 2…64; *cutoff* is a fraction of the output rate. Works on complex and real streams
- **IQ Demodulator** — FM (deviation, 50/75 µs de-emphasis), AM (normalized to the carrier: the output is the modulation depth), USB/LSB (Weaver, 8th-order filter); the output is a real stream at the input rate
- **IQ → Audio** — the bridge into the engine's audio: ring buffer and a cubic resampler to the sound card rate. The source clock (SDR, file) and the sound card drift apart; the read rate follows the buffer fill within ±2000 ppm, the readout shows the buffer and the correction. Decimate to about the audio rate before it: the bridge has no anti-alias filter
- **IQ Spectrum** — Welch spectrum of a stream (absolute frequencies for complex streams) for the Spectrum Analyzer

**Workers.** IQ blocks wired to each other form an *island* that runs in its own Web Worker: the main thread only sends it the inputs coming from outside (e.g. the SDR's raw IQ) and the parameters once per engine block, and hands its outputs to the rest of the graph when they come back a block or two later. The IQ → Audio bridge keeps the stream continuous (its buffer covers the delay); numbers and spectra from an island lag by a few milliseconds. Only outputs wired to nodes outside the island come back. IQ → Audio stays on the main thread (it outputs audio), and so do IQ blocks inside groups. The readout of a block in a worker ends with *· worker*. On the generator preset the main-thread load drops from ~40% to ~2%.

Presets: *IQ: Receiver from Blocks (Generator)* (no hardware needed) and *USB SDR: FM Receiver from Blocks*.

## Tests

Smoke tests run the engine without a sound card in headless Chromium: a few presets (decoded RTTY text, APRS frames with a good CRC, sound on the output) and the IQ chain (tone frequency and level after FM/AM/SSB, sideband rejection, bridge lock to a drifting clock, decimator independent of chunk sizes, USB SDR `iq` output from an IQ file), and the same chains in workers: one island per connected chain, values and spectra coming back, parameters followed on the fly, the worker and its state kept when wires change, fallback to the main thread when workers are blocked, and the workers starting on a cross-origin isolated page (as served by the service worker).

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

Presets: *Internet Radio on the Map*, *Satellites: Track and Doppler*, *FT8: Propagation Map*, *Fox Hunt: Locate Transmitter*, *HF: Who Is On Air (Schedule)*, *Map: My Position and Points from CSV*, *HFDL: Receive and Aircraft Map*.

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
