"use strict";
/* ============================ MPT 1327 ============================
   MPT 1327 Decoder (ядро в mpt1327-kernels.js): IQ (или ЧМ-звук) → FFSK 1200 Бод → кодовые слова с CRC →
   адресные слова (PFIX/IDENT) и слова данных, записи для журнала. */

defIQ({ id:'mpt1327Rx', title:'MPT 1327 Decoder', cat:'Decoders', tall:true, resize:true, w:460,
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    const head=(u.fs/1000).toFixed(1)+' kS/s'+(u.M>1 ? ' (÷'+u.M+')' : '')+' · '+u.words+' codewords ('+u.addr+' address, '+u.data+' data) · '+u.syncs+' syncs'+
      (u.chan ? ' · '+u.chan+' channel'+(u.inv ? ', inverted' : '') : '')+(u.age!=null ? ' · last '+(u.age/1000).toFixed(0)+' s ago' : '');
    return head+(u.recent.length ? '\n'+u.recent.join('\n') : '\nno sync yet'); });
