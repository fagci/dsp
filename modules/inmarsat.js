"use strict";
/* ============================ Inmarsat STD-C ============================
   STD-C Decoder (ядро в inmarsat-kernels.js): мягкие символы BPSK 1200 (PSK Demodulator) → кадры 8.64 с →
   пакеты → Bulletin Board (спутник, LES, номер кадра) и сообщения EGC (SafetyNET: навигационные и
   метеопредупреждения, FleetNET) — текстом и записями. */

defIQ({ id:'stdcDecode', title:'Inmarsat STD-C Decoder', cat:'Decoders', tall:true, resize:true, w:480,
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    const bb=u.bb ? ' · '+u.bb.satName+' LES '+u.bb.les+' · frame '+u.bb.frame : '';
    const head=u.frames+' frames'+(u.frames ? ' (BER '+(100*u.ber).toFixed(1)+'%)' : ' · sync '+u.uw+'/128')+bb+
      (u.bad ? ' · '+u.bad+' bad packets' : '')+' · '+u.total+' EGC messages';
    const msgs=u.msgs.slice().reverse().map(m=>'['+m.priority+'] '+m.service+(m.sat ? ' · '+m.sat : '')+'\n'+m.text);
    return head+(msgs.length ? '\n\n'+msgs.join('\n\n') : ''); });
