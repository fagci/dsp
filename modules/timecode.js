"use strict";
/* ============================ DCF77 / WWVB ============================
   Time Signal Decoder (ядро в timecode-kernels.js): несущая 77.5 кГц (DCF77) или 60 кГц (WWVB) → провалы мощности в начале
   секунды → биты → кадр минуты с проверкой → время UTC; записи и числа. */

defIQ({ id:'timeRx', title:'Time Signal Decoder', cat:'Decoders', tall:true, resize:true, w:460,
  ins:[{n:'in',t:'iq'}],
  outs:[{n:'rec',t:'rec'},{n:'bit',t:'num'},{n:'sec',t:'num'},{n:'min',t:'num'},{n:'hour',t:'num'},{n:'ok',t:'num'},{n:'lvl',t:'num'},{n:'depth',t:'num'}],
  params:[{n:'station',t:'select',opts:['DCF77','WWVB'],d:'DCF77',label:'station (DCF77 77.5 kHz, WWVB 60 kHz)'},
          {n:'carrier',t:'select',opts:['stream center','audio tone','envelope (AM audio)'],d:'stream center',
           label:'where the carrier is: the station frequency minus the stream centre (SDR, a sound card at 192 kS/s), an audio tone, or an AM-demodulated level'},
          {n:'tone',t:'num',d:1000,label:'audio tone, Hz (carrier = audio tone)'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    if(u.err) return u.err;
    const head=(u.sync ? 'sec '+u.sec+'/59' : 'no sync')+' · carrier '+(u.lvl>0 ? (20*Math.log10(u.lvl)).toFixed(0)+' dB' : '—')+' · depth '+(u.depth*100).toFixed(0)+'%'
      +' · frames '+u.good+' ok, '+u.bad+' rejected'+(u.confirmed ? ' · confirmed' : '');
    return head+'\n'+u.bits+(u.last ? '\n'+u.last.text : '')+(u.recent.length ? '\n'+u.recent.join('\n') : ''); });
