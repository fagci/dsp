"use strict";
/* ============================ Quansheng UV-K5: прошивальщик ============================
   Узел поверх flasher.js; протокол — uvk5-kernels.js. Радио включить с зажатой PTT (режим загрузчика), затем Flash. */

defFlasher({ id:'flashK5', title:'Flasher: Quansheng UV-K5', kw:'quansheng uv-k5 k5 uvk5 k6 5r plus firmware bootloader',
  baud:K5_BAUD, accept:'.bin,application/octet-stream',
  prepare:(bytes)=>k5Prepare(bytes),
  run:(io,fw,p,report)=>k5Flash(io,fw,{},report) });
