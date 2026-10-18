"use strict";
/* ============================ Radtel RT-4D: прошивальщик ============================
   Узел поверх flasher.js; протокол — rt890-kernels.js (профиль rt4d). Радио перевести в режим загрузчика, затем Flash. */

defFlasher({ id:'flashRT4D', title:'Flasher: Radtel RT-4D', kw:'radtel rt-4d rt4d firmware bootloader',
  baud:115200, accept:'.bin,application/octet-stream',
  prepare:bytes=>rtbPrepare(bytes,RTB_PROFILES.rt4d),
  run:(io,fw,p,report)=>rtbFlash(io,fw,RTB_PROFILES.rt4d,{},report) });
