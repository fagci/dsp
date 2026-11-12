# Keys and gestures

| Action | Key or gesture |
|---|---|
| Help | **F1** (the module under selection) or the **?** button |
| This page | **?** (Shift+/) |
| Graph commands in the palette: «clear canvas», «arrange», «run», «fit», «undo», «select all», «dashboard», «power profile», «save file», «settings», «zoom in»… (also in Russian) | **Ctrl+K** / **/** / **>**, type the command, **Enter** |
| Command palette: modules and patches, fuzzy | **Ctrl+K** or **/** (**>** too: with one module selected the palette opens already continuing from it) |
| Chain of modules (Emmet-style, live preview on the canvas) | **Ctrl+K**, **/** or the **›_** toolbar button (the only way on a phone), then `mic>fft>sa`, **Enter** · `>fft>sa` continues from the selected module (with one module selected the palette opens with `>` already typed) · `usb>(dac,sa,iqshift>iqdec)` — branches in parentheses, separated by commas · **pins** after a module: `usb>sa[spec>spec, steerFreq<centerFreq]` (`A>B` — pin A of the previous module feeds pin B of this one, `A<B` — pin B of this one feeds pin A of the previous; names are fuzzy; with a `>` item the automatic choice is off) · **parameters**: `usb{sr:2.4M, freq:433.9M}` (suffixes k, M, G) · **chunks**: `mysdr = usb*>sa[spec>spec, steerFreq<centerFreq]` + **Enter** saves a named chain (`*` — the module the next link starts from), `mysdr =` saves the selected modules, then `mysdr>iqshift>demod` expands it in place |
| Run / stop | **Space** |
| Save the patch | **Ctrl+S** |
| Select all modules | **Ctrl+A** |
| Nudge selected modules | **Arrow keys** (Shift — a bigger step) |
| Zoom | wheel or pinch; **+** / **−** |
| Delete selected modules | **Delete** |
| Undo | **Ctrl+Z** |
| Redo | **Ctrl+Shift+Z** or **Ctrl+Y** |
| Add a module | double-click an empty spot; or drop a wire on an empty spot |
| Pan | drag an empty spot |
| Select several | Shift+click |
| Fold a module | double-tap its title |
| Pin picker | double-click a pin |
| Close help / panels | **Esc** |

Hotkeys are off in text fields and in tiles-only mode.
