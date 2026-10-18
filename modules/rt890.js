"use strict";
/* ============================ Radtel RT-890: прошивальщик ============================
   Узел поверх flasher.js; протокол — rt890-kernels.js. Радио включить с зажатыми обеими боковыми клавишами, затем Flash. */

defFlasher({ id:'flashRT890', title:'Flasher: Radtel RT-890', kw:'radtel rt-890 rt890 firmware bootloader',
  baud:115200, accept:'.bin,application/octet-stream',
  prepare:bytes=>rtbPrepare(bytes,RTB_PROFILES.rt890),
  run:(io,fw,p,report)=>rtbFlash(io,fw,RTB_PROFILES.rt890,{},report) });
