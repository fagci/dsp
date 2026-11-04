# Satellites

Satellite autopilot and Meteor-M LRPT decoding.

## Satellite Autopilot

**Satellite Autopilot** (`satPlan`, Radio; core `modules/satplan-kernels.js`) runs one receiver through the passes of the satellites you name, without you at the screen. Orbits are SGP4 from the same TLE as *Satellites* (groups `noaa, weather` by default; **Download TLE** once, set *My Position*), the passes of the next *plan ahead* hours are computed for every target and the best non-overlapping ones are planned: first by *priority*, then by maximum elevation; a pass that overlaps a better one is shown as busy with the name of the satellite that took its time (one receiver; *minimum gap* between windows).

- **Targets:** the *targets* parameter — `satellite; freq MHz; mode; min elevation; priority`, separated by commas, every field optional (`NOAA 19;;APT, METEOR-M2 3;;LRPT, ISS;145.8;NFM;20;9`) — or a [Table](#table) wired to `rows` with the columns `sat` (name or NORAD), `freq`, `mode`, `minEl`, `prio` (a row with `enabled` = 0 is skipped). Frequency empty: a built-in table for NOAA 15 / 18 / 19 (APT 137.620 / 137.9125 / 137.100), Meteor-M2 3 / M2 4 (LRPT 137.9) and the ISS (145.800), then the first downlink in SatNOGS. These are defaults only — channels move, check them.
- **The window:** `go` is high from *start before AOS* to *stop after LOS* (30 s by default), `above` only while the satellite is over the horizon of the target (*minimum elevation*). `freq` is the receive frequency **with the Doppler shift** (live, from the range rate), `f0` the nominal one, `shift` the difference, `mode` the target's mode as text, plus `sat`, `az`, `el`, `range`, `tAos` / `tLos` (seconds to the next AOS / to LOS of the current pass), `maxel`, `next` (text) and `count`.
- **Logs:** `plan` — one record per planned pass (`id`, `sat`, `aos`, `los`, `dur_s`, `maxel`, `az_aos`, `az_los`, `freq`, `mode`, `status` planned / skipped, `why`), sent when the plan changes; wire it to a Table with *upsert key col* = `id` for a live schedule. `rec` — `aos` and `los` events of the passes that were run.
- **Autopilot on a USB SDR:** `freq` → `tuneFreq`, `go` → the new `recGo` input of **USB SDR** (*record trigger: go input*): IQ recording of channel 1 starts when `go` rises, with *pre-roll*, stops when it falls, and is saved like a squelch-triggered one. At 137.5 MHz and 2.4 MS/s one receiver covers all NOAA and Meteor channels. Preset: *Satellites: Autopilot*.
- **Not done:** weather-satellite decoding itself is not in the node — the recording goes to the LRPT chain (see below), NOAA APT has only the free-running raster receiver (Video category); no antenna rotator control; plans come from TLE that age (accuracy falls within 1–2 weeks).
- **Tests:** `node tools/test-satplan.mjs` — target parsing, built-in frequencies, overlap resolution, the window phases (pre / pass / post / idle), and on a real SGP4 orbit (ISS TLE): pass count, AOS / LOS at the elevation threshold, Doppler of +2…4 kHz at AOS, −2…−4 kHz at LOS and about zero at the top, two targets on one orbit.

## Meteor-M LRPT

LRPT from Meteor-M satellites (137.1 / 137.9 MHz) from the raw IQ of a USB SDR, down to CCSDS frames. The parameters follow [SatDump](https://github.com/SatDump/SatDump) (GPLv3): M2-3/M2-4 use OQPSK 72 kBd + NRZ-M, the old M2 uses QPSK without NRZ-M; both use RS(255,223) with interleave 4 in the conventional basis.

- **PSK Demodulator** (IQ, worker): decimates to 3–6 samples per symbol by itself (1.024 MS/s → ÷4), RRC matched filter (α = 0.6), AGC, coarse frequency from the 4th-power spectrum (±*frequency search*, also for OQPSK), Gardner symbol timing with cubic interpolation (OQPSK: Q taken half a symbol later), 4th-order Costas loop. Out: soft symbols as an IQ stream at the symbol rate, `freq` (offset, Hz), `lock`; the node shows the constellation, offset and SNR.
- **CCSDS Decoder** (Decoders, worker): Viterbi sync by re-encoding errors over 8 variants (I/Q swap × 0/90° × pair shift; 180° is removed by NRZ-M or an inverted ASM), streaming Viterbi K=7 r=1/2 (polynomials 171/133), NRZ-M, ASM `1ACFFC1D` with 1024-byte frames, CCSDS derandomizer, RS(255,223)×4 (conventional or dual basis, or off). A lock without ASM for 4 frames is dropped as false. `rec` — one record per frame that passes RS: `scid`, `vcid`, `cnt` (VCDU counter), `rs` (bytes fixed), `vcdu` (892 bytes; hex in CSV). Plus `ber` (re-encoding error rate) and `lock` (0 none, 1 Viterbi, 2 frames synced).

Checked against independent references: the encoded ASM matches SatDump's correlator pattern, RS parity matches `reedsolo` with the CCSDS field, and the PN sequence matches CCSDS. End to end, generator → demodulator → decoder, every frame comes back byte for byte (OQPSK and QPSK, ±9 kHz offset, Es/N0 down to ~6 dB). It has not yet been tried on a real pass recording.

- **LRPT Image (MSU-MR)** (Decoders): frames of VC5 → packets (M_PDU first-header pointer, packets split across frames; a lost frame only drops the packets in it) → APID 64…69, channels 1…6 → segments: 14 blocks 8×8 compressed like baseline JPEG without markers (standard luminance Huffman and quantization tables scaled by the segment's QF) → lines 1568 px wide. Rows are placed by the packet counter in the 43-packet transmission loop (14 segments × 3 channels + telemetry), the same way as SatDump, so channels line up and gaps stay black. Composites RGB 221 (day), 123, 321, 125, or one channel; the node shows the latest part, **Save PNG** saves the whole pass; `img` (every 2 s, when wired) and `lines`.

The generator's LRPT mode carries a real MSU-MR stream: a test picture (a different pattern per channel) encoded into segments, packets and M_PDUs; it comes back with a mean error under 2 levels (QF 80).

Presets: *Meteor-M LRPT: Image (Generator)*, *Meteor-M LRPT: Image (USB SDR, 137 MHz)*.

