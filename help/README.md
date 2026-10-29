# DSP workbench — help

The same pages are shown in the app (the **?** button in the toolbar, or **F1**) and here on GitHub. They work offline.

- [Start here](start.md) — what the workbench is and your first patch
- [Canvas and modules](canvas.md) — adding, moving, folding and deleting modules
- [Wires and port types](wires.md) — connecting modules, what the pin colours mean
- [Running and settings](run.md) — run / stop, speed, block size, sample rate
- [Patches and presets](patches.md) — the patch list, saving, sharing, links
- [Tables and records](data.md) — `rec` and `rows`, Table, Graph, Map
- [Dashboard](dashboard.md) — panes and tiles for instrument-like screens
- [Offline and the phone app](offline.md) — PWA, offline data, the Android bridge
- [Keys and gestures](shortcuts.md)
- [Module reference](modules.md) — every module with its pins and parameters (generated)

The full manual is the [README](../README.md) of the repository: every module is described there.
In the app, search looks through the topics, the module list and the manual at once.

Adding a page: put a `.md` file in this folder and a link to it in this list — the app builds its topic list from here.
`modules.md` is generated: `node tools/gen-modref.mjs`.
