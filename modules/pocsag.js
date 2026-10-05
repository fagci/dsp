"use strict";
/* ============================ POCSAG (пейджеры) ============================
   POCSAG Decoder (ядро в pocsag-kernels.js): IQ (или ЧМ-звук) → 2-FSK 512 / 1200 / 2400 Бод → пакеты с BCH(31,21) →
   адрес (RIC), функция, текст или цифры; записи для журнала и узла Messages. */

defIQ({ id:'pocsagRx', title:'POCSAG Decoder', cat:'Decoders', tall:true, resize:true, w:460,
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'}],
  params:[{n:'baud',t:'select',opts:['auto','512','1200','2400'],d:'auto',label:'baud rate (auto tries all three)'},
          {n:'fix',t:'select',opts:['2','1','0'],d:'2',label:'correct up to N bit errors per codeword (2 = full BCH power, more false messages in noise)'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    const head=(u.fs/1000).toFixed(1)+' kS/s'+(u.M>1 ? ' (÷'+u.M+')' : '')+' · '+u.msgs+' messages · '+u.cws+' codewords ('+u.fixed+' fixed, '+u.bad+' bad)'+
      (u.baud ? ' · '+u.baud+' Bd' : '')+(u.age!=null ? ' · last '+(u.age/1000).toFixed(0)+' s ago' : '');
    return head+(u.recent.length ? '\n'+u.recent.join('\n') : '\nno sync yet'); });
