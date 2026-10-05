"use strict";
/* ============================ AIS (161.975 / 162.025 МГц) ============================
   AIS Decoder (ядро в ais-kernels.js): IQ (или ЧМ-звук) → GMSK 9600 Бод → HDLC с CRC → сообщения
   (позиции, статика, базовые станции, знаки навигации), суда по MMSI с именем и размерами; записи для карты
   и предложения !AIVDM на выходе text. */

defIQ({ id:'aisRx', title:'AIS Decoder', cat:'Decoders', tall:true, resize:true, w:460,
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'}],
  params:[{n:'ch',t:'select',opts:['A','B'],d:'A',label:'channel letter in !AIVDM (A 161.975, B 162.025 MHz)'},
          {n:'ttl',t:'range',min:1,max:120,step:1,d:30,label:'forget a vessel after, min'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    const head=(u.fs/1000).toFixed(1)+' kS/s'+(u.M>1 ? ' (÷'+u.M+')' : '')+' · '+u.frames+' frames · '+u.msgs+' messages · '+u.ships+' vessels'+
      (u.age!=null ? ' · last '+(u.age/1000).toFixed(0)+' s ago' : '');
    return head+(u.recent.length ? '\n'+u.recent.join('\n') : '\nno frames yet'); });
