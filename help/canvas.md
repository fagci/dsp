# Canvas and modules

## Adding a module
- **Modules** tab: type in the search (several words, all must match; titles starting with a word rank first), tap a module to add it, or drag it onto the canvas. On a phone the panel stays open so you can add several in a row.
- **Double-click an empty spot** of the canvas and search.
- **Drop a wire on an empty spot** (or select a pin and tap an empty spot): the picker lists only modules that have a matching pin and connects the new one for you.
- **→+ (quick chain)** in the toolbar, with one module selected: the picker shows what fits the free output of the selected module, connects the new module and selects it — repeat to grow a chain.
- **Chains in the command palette** (**Ctrl+K**, **/** or **>**): `usb>(dac,sa)` builds modules and wires with a live preview. After a module name `[A>B, A<B]` chooses the pins to join with the previous module (the palette lists which pins were connected and why a pin was not found), `{sr:2.4M}` sets parameters, and a **chunk** is a named chain: `mysdr = usb*>sa[spec>spec, steerFreq<centerFreq]` saves it (or `mysdr =` with modules selected), `mysdr>demod` expands it. Chunks are kept in the browser, listed in the palette and included in the backup. A wire that joins two inputs cannot be written in a chain: it is left out when saving the selection (the palette says so). Preset «Chain: SDR with Spectrum Steering (Pins and Chunks)». Logic: `modules/chain-kernels.js`, `node tools/test-chain.mjs`.
- Patches can be dragged from the list onto the canvas: they are *added* to the current graph.

## On a phone
- The toolbar is at the bottom and scrolls sideways: menu, run, tiles, fit, undo / redo and quick chain come first, files and clear are at the end.
- A preset opens fitted to the screen. Select a module and press **tiles**: it fills the screen — the picture on top, the parameters under it (scroll), the corner-arrows button leaves the picture alone. Plan Studio keeps its tabs in every mode.

## Moving around
- Drag an empty spot to pan, wheel or pinch to zoom, **Fit** (the corners button) shows everything.
- Drag a module by its header. Select several with Shift+click, then **Align** or **Duplicate** from the toolbar.

## The module header
| Control | What it does |
|---|---|
| double-tap the title | fold: full → compact card → dot (the **detail** button does it for all modules) |
| ↺ | reset all parameters to the defaults |
| ✎ | rename the module |
| ✕ | delete it |
| ? | open the help card of this module |
Header buttons appear when the pointer is over the module or the module is selected.

## Parameters
A module's parameters are drawn in its body: sliders, fields, checks, selects, buttons. Many have a tooltip. A line under *advanced* hides rarely used ones. A parameter can also be driven from outside by a wire when the module has a pin of the same name.

## Groups and notes
- A **Note** module holds text for you and for readers of the patch.
- Groups (nested subgraphs) pack part of a patch into one module with your own inputs and outputs.

## Undo
**Ctrl+Z** undoes, **Ctrl+Shift+Z** or **Ctrl+Y** redoes; the toolbar has the same buttons.
