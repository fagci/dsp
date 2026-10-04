"use strict";
/* ============================ TETRA ============================
   TETRA Decoder (ядро в tetra-kernels.js): IQ → π/4-DQPSK 18 кБод → синхропакет (BSCH) → слоты → AACH, SYSINFO, MAC-RESOURCE,
   вызовы по маркеру использования; записи для журнала. Речь не декодируется. */

defIQ({ id:'tetraRx', title:'TETRA Decoder', cat:'Decoders', tall:true, resize:true, w:480,
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'},{n:'voice',t:'rec'}]},
  n=>{ const u=n.ui; if(!u) return 'no input'; if(u.err) return u.err;
    const sr=(u.fs/1000).toFixed(1)+' kS/s'+(u.M>1 ? ' (÷'+u.M+')' : '');
    if(!u.locked) return sr+' · searching for a sync burst'+(u.last ? ' ('+u.last+')' : '')+(u.recent.length ? '\n'+u.recent.join('\n') : '');
    const c=u.cell, s=u.si, k=u.cnt;
    return sr+' · MCC '+c.mcc+' MNC '+c.mnc+' · colour '+c.cc+' · TN '+u.tn+' FN '+u.fn+' MN '+u.mn+' · offset '+(u.ferr>=0 ? '+' : '')+u.ferr.toFixed(0)+' Hz'+(u.inv ? ' · inverted' : '')+
      (s ? '\n'+(s.dlHz/1e6).toFixed(4)+' MHz · LA '+s.la+(s.encrypted ? ' · air encryption' : '')+' · '+s.services.join(', ') : '')+
      '\n'+k.bursts+' bursts · blocks '+k.crcOk+' ok / '+k.crcBad+' bad · '+k.tch+' traffic'+(u.calls.length ? ' · calls on TN '+u.calls.map(c=>c.tn+' (UM '+c.marker+')').join(', ') : '')+
      (u.recent.length ? '\n'+u.recent.join('\n') : ''); });
