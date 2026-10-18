"use strict";
/* ============================ Radtel RT-880: прошивальщик ============================
   Узел поверх flasher.js; протокол — rt880-kernels.js. Радио перевести в режим загрузчика, затем Flash. */

defFlasher({ id:'flashRT880', title:'Flasher: Radtel RT-880', kw:'radtel rt-880 rt880 iradio firmware bootloader intel hex',
  baud:RT_BAUD, accept:'.bin,.hex,application/octet-stream',
  params:[
    {n:'format',t:'select',opts:['auto','bin','hex'],d:'auto',label:'file format (auto — Intel HEX if it starts with «:»)'},
    {n:'iradio',t:'check',d:false,label:'iRadio variant (other commands and checksum)'},
  ],
  prepare:(bytes,p)=>rtPrepare(bytes,p.format),
  run:(io,fw,p,report)=>rtFlash(io,fw,{iradio:!!p.iradio},report) });
