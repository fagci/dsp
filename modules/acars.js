"use strict";
/* ============================ ACARS ============================
   ACARS Decoder (ядро в acars-kernels.js): IQ (или AM-звук) → огибающая → MSK 2400 Бод → блоки с CRC →
   борт, метка, номер рейса, текст; записи для журнала. */

defIQ({ id:'acarsRx', title:'ACARS Decoder', cat:'Decoders', tall:true, resize:true, w:460,
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'}],
  params:[{n:'fix',t:'check',d:true,label:'fix up to 2 parity errors (accepted only if the CRC matches)'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    const head=(u.fs/1000).toFixed(1)+' kS/s'+(u.M>1 ? ' (÷'+u.M+')' : '')+' · '+u.frames+' messages ('+u.fixed+' fixed, '+u.bad+' bad CRC) · '+u.syncs+' syncs · carrier '+u.lvl.toFixed(0)+' dB'+
      (u.interp ? ' · '+u.interp : '')+(u.age!=null ? ' · last '+(u.age/1000).toFixed(0)+' s ago' : '');
    return head+(u.recent.length ? '\n'+u.recent.join('\n') : '\nno message yet'); });
