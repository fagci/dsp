"use strict";
/* ============================ VDL Mode 2 (136.650–136.975 МГц) ============================
   VDL Mode 2 Decoder (ядро в vdl2-kernels.js): IQ канала → D8PSK 10500 Бод → заголовок и Рид—Соломон → HDLC / AVLC →
   ACARS внутри кадров (борт, метка, рейс, текст); остальные кадры (XID, X.25 / ATN) — записью с hex. */

defIQ({ id:'vdl2Rx', title:'VDL Mode 2 Decoder', cat:'Decoders', tall:true, resize:true, w:460,
  kw:'vdl vdl2 vdlm2 acars avlc d8psk aircraft datalink 136.975 airband',
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'locked',t:'num'}],
  params:[]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    if(u.err) return u.err;
    const head=(u.fs/1000).toFixed(1)+' kS/s · '+u.state+' · '+u.frames+' frames ('+u.acars+' ACARS, '+u.fixed+' fixed by FEC) · '+u.bursts+' bursts, '+u.bad+' rejected · noise '+u.lvl.toFixed(0)+' dB'+
      (u.age!=null ? ' · last '+(u.age/1000).toFixed(0)+' s ago' : '');
    return head+(u.recent.length ? '\n'+u.recent.join('\n') : '\nno frame yet'); });
