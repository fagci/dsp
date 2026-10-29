# Start here

DSP workbench is a modular lab in the browser. You build a chain from **modules** (nodes) on a canvas and connect them with **wires**. It runs entirely on your device, needs no installation and works offline.

## Your first patch in a minute
1. Open the **Patches** tab in the sidebar and pick any preset — the list is grouped by topic (SDR, digital voice, music, tools…). Most presets carry a note with a description of what to press.
2. Press **▶** in the toolbar. The modules start working, the status shows the speed.
3. Change a parameter on a module and watch the result change. Hover a pin to see what it carries.
4. To build your own: open the **Modules** tab (or double-click an empty spot of the canvas), type a name, tap a module. Drag from an output pin to an input pin to connect.

The preset «Help: Your First Patch» is the smallest working example.

## The three ideas
- **Module** — a block with input pins on the left, output pins on the right and parameters in the middle. The colour of the header is its category; the icon shows the role (circle: source, square: processor, hexagon: sink).
- **Wire** — carries one *type* of data (audio, numbers, spectrum, text, records…). See [Wires and port types](wires.md).
- **Patch** — the whole canvas with its parameters. Patches are saved in the browser, can be exported to a file and shared as a link. See [Patches and presets](patches.md).

## Where to look next
- Nothing is wired and you do not know which module you need — type what you want in the module search (several words are allowed: title, id, category and keywords are searched).
- A module does something unclear — press **?** in its header (or select it and press **F1**) for its card: pins, parameters, the manual text and the presets that use it.
- The full manual: the search in this help also looks through the README.
