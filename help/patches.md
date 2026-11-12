# Patches and presets

## The patch list
The **Patches** tab has built-in presets (hundreds of them: demos, radio protocols, music, analysis, tools) grouped by topic, and your own patches. The search looks in the names first, then in the category, in the **modules a preset uses** («usb sdr», «table») and in the **text of its Note** («waterfall», «trilateration»): all the words must be found, in any of these, a name hit ranks above a module hit, and a note hit comes last; typos are forgiven when nothing matches exactly. Under a result found not by its name, a grey line shows where: `uses: USB SDR`, `category: …` or a piece of the Note. The same search works in the command palette (Ctrl+K). Nothing is built to search: the index is read from the source of the preset (about 40 ms the first time). A preset normally holds a Note with a description.

- Click a patch to load it. Drag it onto the canvas (or press **＋**) to *add* it to the current graph.
- **Save** (the disk icon in the patch panel) stores the current patch under a name in the browser.
- **Open file / Save to file** (toolbar) work with `.json` patch files.
- **Copy link** gives an address that opens the same patch; `#p=Name` opens a patch by name, `?readonly-tiles` shows only the tiles.
- **Share…** in the settings panel sends the patch through the system share menu.

## Autosave
The current canvas is saved in idle time; reopening the page brings it back. Presets are rebuilt when the app updates; your saved patches are never touched.

## Updating
**Refresh app files** (the broom in the toolbar) re-downloads the app and its cache. Patches, tables and other data are never erased.
