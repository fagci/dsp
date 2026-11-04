# DSP workbench — help

The same pages are shown in the app (the **?** button in the toolbar, or **F1**) and here on GitHub. They work offline.

- [Start here](start.md) — what the workbench is and your first patch
- [Canvas and modules](canvas.md) — adding, moving, folding and deleting modules
- [Wires and port types](wires.md) — connecting modules, what the pin colours mean
- [Running and settings](run.md) — run / stop, speed, block size, sample rate
- [Patches and presets](patches.md) — the patch list, saving, sharing, links
- [Tables and records](data.md) — `rec` and `rows`, Table, viewers
- [Map and records](map.md) — points, layers, Rec → Entities rules
- [Dashboard](dashboard.md) — panes and tiles for instrument-like screens
- [SDR and receivers](sdr.md) — USB SDRs, remote SDRs, tinySA, telemetry
- [Analysis](analysis.md) — signal identification, measuring, logic analyzer
- [Radio: decoders and digital modes](radio.md) — GSM, ADS-B, DMR, TETRA, POCSAG, JS8…
- [Satellites](satellites.md) — satellite autopilot, Meteor-M LRPT
- [Processing and interface](processing.md) — IQ blocks, control logic, indicators, themes, tiles
- [Video and cameras](video.md) — analog/digital TV, IP cameras, podcasts
- [Media](media.md) — sample editor, tracker
- [Phone tools](phone.md) — Bluetooth LE, Meshtastic, MeshCore
- [Network tools](network.md) — scanner, traceroute / mtr, discovery and other things only the Android app can do
- [Protocols and firmware](protocols.md) — MQTT, bytes and files, flashers, Packet Link, HEX Structure
- [Offline and the phone app](offline.md) — PWA, offline data, the Android bridge
- [Keys and gestures](shortcuts.md)
- [Module reference](modules.md) — every module with its pins and parameters (generated)

The manual is these pages plus the [README](../README.md) of the repository (an overview with links here).
In the app, search looks through the topics, the module list and the manual at once.

Adding a page: put a `.md` file in this folder and a link to it in this list — the app builds its topic list from here.
`modules.md` is generated: `node tools/gen-modref.mjs`.
