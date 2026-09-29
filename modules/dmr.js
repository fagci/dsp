"use strict";
/* ============================ DMR ============================
   DMR Decoder (ядро в dmr-kernels.js): IQ (или ЧМ-звук) → 4FSK 4800 Бод → синхрослова, слоты, колор-код →
   голосовые вызовы (LC, встроенный LC, talker alias), CSBK, данные и SMS, Short LC; сырые кадры AMBE — отдельным выходом. */

defIQ({ id:'dmrRx', title:'DMR Decoder', cat:'Decoders', tall:true, resize:true, w:480,
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'},{n:'voice',t:'rec'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    const s=u.st, ts=u.mode==='bs' || u.mode==='direct' ? ['TS1','TS2'] : ['slot A','slot B'];
    const head=(u.fs/1000).toFixed(1)+' kS/s'+(u.M>1 ? ' (÷'+u.M+')' : '')+' · '+
      (u.locked ? ({bs:'repeater',ms:'mobile',direct:'direct mode'})[u.mode]+(u.inv ? ', inverted' : '')+' · CC '+(u.cc==null ? '?' : u.cc) : 'searching sync')+
      (u.age!=null ? ' · last '+(u.age/1000).toFixed(0)+' s ago' : '');
    const cnt=s.bursts+' bursts · '+s.voice+' voice · '+s.data+' data · '+s.csbk+' CSBK · '+s.msgs+' messages · '+s.bad+' FEC errors'+
      (u.sys ? ' · net '+u.sys.net+' site '+u.sys.site : '');
    return head+'\n'+cnt+'\n'+u.slots.map((l,i)=>ts[i]+': '+l).join('\n')+(u.recent.length ? '\n'+u.recent.join('\n') : ''); });
