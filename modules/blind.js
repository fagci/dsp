"use strict";
/* ============================ Слепой анализ неизвестного сигнала: узлы ============================
   Ядра — в blind-kernels.js. Порядок работы с неизвестной передачей:
   Baud Estimator (скорость символов) → FM Discriminator → RRC → Symbol Slicer → Sync Word Hunter (синхрослово, кадры) →
   Conv Code Finder (свёрточный код + Витерби) → CRC Finder (параметры CRC). CMA Equalizer ставится перед демодулятором при многолучёвости. */

defIQ({ id:'blindBaud', title:'Baud Estimator', cat:'Analysis', kw:'symbol rate baud blind unknown signal cyclostationary',
  ins:[{n:'in',t:'iq'}], outs:[{n:'baud',t:'num'},{n:'conf',t:'num'},{n:'sps',t:'num'},{n:'text',t:'txt'}],
  params:[{n:'min',t:'range',min:10,max:100000,step:10,d:100,log:true,label:'lowest symbol rate to look for, Bd'},
          {n:'max',t:'range',min:100,max:1000000,step:100,d:20000,log:true,label:'highest symbol rate to look for, Bd'},
          {n:'avg',t:'range',min:2,max:64,step:1,d:12,label:'spectrum averaging, frames'},
          {n:'thr',t:'range',min:4,max:30,step:.5,d:10,label:'peak above the noise to accept, dB'}]},
  n=>n.ui ? n.ui.text : 'no input');

defIQ({ id:'blindEq', title:'CMA Equalizer', cat:'IQ', kw:'blind equalizer multipath constant modulus cma fsk psk',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'iq'},{n:'cost',t:'num'}],
  params:[{n:'taps',t:'range',min:3,max:127,step:2,d:15,label:'taps (at the stream rate: ≈ 4 symbols × samples per symbol)'},
          {n:'mu',t:'range',min:.0001,max:.05,step:.0001,d:.003,log:true,label:'step size'},
          {n:'freeze',t:'check',d:false,label:'freeze the taps'}]},
  n=>!n.ui ? 'no input' : n.ui.taps+' taps · modulus dispersion '+n.ui.before.toFixed(3)+' → '+n.ui.after.toFixed(3));

defIQ({ id:'syncHunt', title:'Sync Word Hunter', cat:'Protocols', kw:'sync word preamble frame period blind unknown bits',
  ins:[{n:'in',t:'iq'}], outs:[{n:'blk',t:'blk'},{n:'word',t:'txt'},{n:'period',t:'num'},{n:'hits',t:'num'},{n:'text',t:'txt'}],
  params:[{n:'levels',t:'select',opts:['2','4'],d:'2',label:'symbol levels (2 — one bit per symbol, 4 — a dibit, levels ±1 ±3)'},
          {n:'len',t:'range',min:8,max:32,step:1,d:32,label:'sync word length, bits'},
          {n:'depth',t:'range',min:2048,max:131072,step:1024,d:16384,log:true,label:'bits kept for the search'},
          {n:'minHits',t:'range',min:2,max:30,step:1,d:4,label:'repeats needed'},
          {n:'tol',t:'range',min:0,max:6,step:1,d:1,label:'error tolerance when cutting frames, bits'},
          {n:'flen',t:'range',min:0,max:4096,step:1,d:0,label:'frame length after the word, bits (0 — the period found)'},
          {n:'word',t:'text',d:'',label:'sync word, hex (empty — search)'}]},
  n=>n.ui ? n.ui.text : 'no input');

defIQ({ id:'crcFind', title:'CRC Finder', cat:'Protocols', kw:'crc checksum polynomial reverse unknown frames',
  ins:[{n:'blk',t:'blk'}], outs:[{n:'blk',t:'blk'},{n:'ok',t:'num'},{n:'found',t:'num'},{n:'text',t:'txt'}], tall:true, resize:true, w:380,
  params:[{n:'min',t:'range',min:3,max:64,step:1,d:6,label:'frames needed'},
          {n:'keep',t:'range',min:8,max:128,step:1,d:40,label:'frames kept'},
          {n:'ratio',t:'range',min:.3,max:1,step:.05,d:.6,label:'share of frames that must pass'},
          {n:'maxSkip',t:'range',min:0,max:8,step:1,d:2,label:'header bytes the sum does not cover, tried up to'},
          {n:'tail',t:'range',min:0,max:64,step:1,d:32,label:'extra bytes after the checksum (pause, next preamble), tried up to'},
          {n:'bitOffs',t:'check',d:false,label:'try bit offsets 0–7'},
          {n:'unknown',t:'check',d:true,label:'search an unknown 8/16-bit polynomial (same-length frames)'}]},
  n=>n.ui ? n.ui.text : 'no input');

defIQ({ id:'convFind', title:'Conv Code Finder', cat:'Protocols', kw:'convolutional viterbi fec code polynomial blind unknown',
  ins:[{n:'blk',t:'blk'}], outs:[{n:'blk',t:'blk'},{n:'found',t:'num'},{n:'k',t:'num'},{n:'text',t:'txt'}], tall:true, resize:true, w:380,
  params:[{n:'rate',t:'select',opts:['auto','1/2','1/3'],d:'auto',label:'code rate'},
          {n:'maxK',t:'range',min:3,max:9,step:1,d:9,label:'longest constraint length to try'},
          {n:'thr',t:'range',min:.6,max:1,step:.01,d:.85,label:'syndrome consistency to accept'},
          {n:'min',t:'range',min:3,max:32,step:1,d:8,label:'frames needed'},
          {n:'keep',t:'range',min:8,max:128,step:1,d:40,label:'frames kept'},
          {n:'maxBits',t:'range',min:100,max:2000,step:50,d:600,label:'bits of a frame used for the search'},
          {n:'tail',t:'check',d:true,label:'frames end with K−1 zero bits (dropped after decoding)'}]},
  n=>n.ui ? n.ui.text : 'no input');

defIQ({ id:'blindGen', title:'Unknown Signal', cat:'IQ', kw:'generator test unknown fsk psk crc convolutional multipath',
  ins:[{n:'fc',t:'num'},{n:'off',t:'num'}], outs:[{n:'iq',t:'iq'},{n:'tx',t:'blk'}],
  params:[{n:'sr',t:'select',opts:IQ_SR_OPTS,d:'256000',label:'sample rate'},
          {n:'fc',t:'num',d:433920000,label:'center frequency, Hz'},
          {n:'off',t:'num',d:20000,label:'signal offset from center, Hz'},
          {n:'mod',t:'select',opts:['2FSK','GFSK','BPSK','QPSK'],d:'2FSK',label:'modulation'},
          {n:'baud',t:'num',d:9600,label:'symbol rate, Bd (hidden from the analysis chain)'},
          {n:'dev',t:'range',min:100,max:50000,step:100,d:4800,log:true,label:'FSK deviation, Hz'},
          {n:'word',t:'text',d:'B38D2E5A',label:'sync word, hex'},
          {n:'len',t:'range',min:4,max:64,step:1,d:16,label:'message, bytes'},
          {n:'crc',t:'select',opts:BLIND_GEN_CRC,d:'CRC-16/X-25',label:'checksum of the message'},
          {n:'fec',t:'select',opts:Object.keys(BLIND_GEN_FEC),d:'K=7 (171, 133)',label:'convolutional code of the message + checksum'},
          {n:'gap',t:'range',min:0,max:400,step:1,d:64,label:'random bits between frames'},
          {n:'lvl',t:'range',min:-100,max:0,step:1,d:-20,label:'signal level, dBFS'},
          {n:'noise',t:'range',min:-120,max:0,step:1,d:-55,label:'noise, dBFS'},
          {n:'echo',t:'range',min:0,max:.9,step:.01,d:0,label:'echo (multipath): gain'},
          {n:'echoDelay',t:'range',min:.1,max:3,step:.05,d:.7,label:'echo delay, symbols'},
          {n:'echoPhase',t:'range',min:0,max:360,step:5,d:90,label:'echo phase, °'}]},
  n=>n.ui ? n.p.mod+' '+n.p.baud+' Bd · '+n.ui.frames+' frames' : '…');
