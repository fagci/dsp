"use strict";
/* ============================ ISM 433 МГц ============================
   ISM 433 Decoder (ядро в ism-kernels.js): IQ → OOK / FSK → импульсы → модуляция (PWM, PPM, Манчестер) →
   протокол (EV1527/PT2262, Nexus) или неопознанный пакет с тайминга́ми и битами; записи для журнала. */

defIQ({ id:'ismRx', title:'ISM 433 Decoder', cat:'Decoders', tall:true, resize:true, w:460,
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'}],
  params:[{n:'mod',t:'select',opts:['OOK','FSK','OOK+FSK'],d:'OOK',label:'modulation (OOK+FSK gives more false unknown packets)'},
          {n:'bw',t:'select',opts:['50000','100000','200000'],d:'100000',label:'channel width, Hz'},
          {n:'snr',t:'range',min:6,max:30,step:1,d:12,label:'min. signal over noise, dB'},
          {n:'reset',t:'range',min:1000,max:20000,step:100,d:12000,label:'end of packet: silence longer than, µs'},
          {n:'minBits',t:'range',min:8,max:64,step:1,d:16,label:'min. bits in a packet'},
          {n:'raw',t:'check',d:true,label:'log unidentified packets'},
          {n:'dedup',t:'range',min:0,max:5000,step:50,d:1000,label:'skip identical packets within, ms'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    const head=(u.fs/1000).toFixed(0)+' kS/s'+(u.M>1 ? ' (÷'+u.M+')' : '')+' · '+u.packets+' packets ('+u.dec+' decoded, '+u.unk+' unknown, '+u.dups+' repeats skipped)'+
      ' · signal '+u.hi.toFixed(0)+' dB, noise '+u.nz.toFixed(0)+' dB'+(u.age!=null ? ' · last '+(u.age/1000).toFixed(0)+' s ago' : '');
    return head+(u.recent.length ? '\n'+u.recent.join('\n') : '\nno packet yet'); });
