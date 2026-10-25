"use strict";
/* ============================ Inmarsat Aero, P-канал (1545 МГц) ============================
   Inmarsat Aero Decoder (ядро в aero-kernels.js): IQ канала → MSK 600 / 1200 Бод → синхрослово → кадры с Витерби и CRC →
   сигнальные единицы: таблицы системы, назначения голосовых каналов (частоты, борт), ISU → ACARS через спутник. */

defIQ({ id:'aeroRx', title:'Inmarsat Aero Decoder', cat:'Decoders', tall:true, resize:true, w:480,
  kw:'inmarsat aero jaero acars satellite l-band 1545 p channel msk 600 1200 aircraft satcom voice c-channel',
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'locked',t:'num'}],
  params:[{n:'baud',t:'select',opts:['600','1200'],d:'600',label:'P channel rate, bit/s (MSK symbols per second): the squared-signal line pair tells which'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    if(u.err) return u.err;
    const head=(u.fs/1000).toFixed(1)+' kS/s · P'+u.baud+' · '+(u.lock ? 'carrier '+(u.fc>=0 ? '+' : '')+u.fc.toFixed(0)+' Hz (+'+u.pairDb.toFixed(0)+' dB)' : 'no carrier')+' · '+u.uw+' sync, '+u.frames+' frames'+
      (u.ber!=null ? ' (BER '+(100*u.ber).toFixed(1)+'%)' : '')+' · SU '+u.suOk+' ok / '+u.suBad+' bad · '+u.msgs+' ACARS'+
      (u.sat ? ' · sat '+u.sat.id+' '+Math.abs(u.sat.lon)+'°'+(u.sat.lon<0 ? 'W' : 'E') : '')+(u.age!=null ? ' · last '+(u.age/1000).toFixed(0)+' s ago' : '');
    return head+(u.recent.length ? '\n'+u.recent.join('\n') : '\nno data yet'); });
