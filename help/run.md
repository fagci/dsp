# Running and settings

## Run and stop
**▶** in the toolbar starts the engine, the same button stops it. While running the status field shows the speed and the load. Modules whose result nobody uses are not computed (**skip unused** in the power profile).

## Settings (the sliders button)
| Setting | Meaning |
|---|---|
| Run speed | ×1 is real time; ×2…×32 runs faster (audio is distorted); useful for files and decoders |
| Block size | samples per processing step; larger — less CPU, more delay |
| Redraw rate | auto slows down when idle, max keeps 60 fps |
| Sample rate | default or a fixed rate for the engine |
| CORS proxy | for sites without CORS headers; `{url}` is replaced by the address |
| Keep screen on | while the graph is running |
| All data | export and import patches, tables and files in one archive |

Changing the block size restarts the engine; inputs (microphone, SDR) have to be switched on again.

## Errors
A red badge in the toolbar appears when something fails in the session; click it to see the list and to send a report.

## Power profile (the ⚡ button)

Shows what eats the processor: the total (processing + drawing, % of one core), a graph of the last minute and the top modules. A row is a bar split into **processing** and **drawing**; **now / peak** switches the sort between the current load and the maximum since the panel was opened. A click on a row centres the canvas on that module and makes it flash; **❄** freezes / resumes the module. With **heat** on, busy modules are outlined on the canvas (amber from 4 %, thick from 15 %, red from 40 % of a core), so a heavy node can be found without opening the list. The battery drain is shown too. **skip unused** does not compute modules whose result nobody uses. Kernel: `modules/power-kernels.js`, `node tools/test-power.mjs`.
