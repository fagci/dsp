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

## Power profile
The ⚡ button shows how much CPU every module takes and how fast the battery drains. Click a row to freeze a module.

## Errors
A red badge in the toolbar appears when something fails in the session; click it to see the list and to send a report.
