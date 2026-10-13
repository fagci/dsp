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

/* Широкополосный сканер: вся полоса приёма разом, детекторы и декодеры rtl_433 (wasm) на каждом канале (ядро — ism-scan-kernels.js) */
defIQ({ id:'ismScan', title:'ISM Scanner (rtl_433)', cat:'Decoders', tall:true, resize:true, w:480,
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'},{n:'spec',t:'spec'},{n:'active',t:'num'}],
  params:[{n:'plan',t:'select',opts:['4','2'],d:'4',label:'channel overlap (4: a signal always fits in one channel, 2: half the CPU, a signal between channels may be lost)'},
          {n:'gain',t:'select',opts:['auto','-20','-10','0','10','20','30'],d:'auto',label:'gain into the detectors, dB (auto: noise ≈ 300 of 32767, the strongest signal below 0.7)'},
          {n:'dc',t:'select',opts:['subtract','skip','none'],d:'subtract',label:'centre channel (DC spike of the SDR)'},
          {n:'snr',t:'range',min:8,max:40,step:1,d:20,label:'min. signal over noise, dB (lower: weaker sensors, more false packets)'},
          {n:'devs',t:'select',opts:['default','all'],d:'default',label:'decoders (default: as rtl_433 runs them; all: also the ones it keeps off by default)'},
          {n:'only',adv:true,t:'text',d:'',label:'only these decoders (names or numbers, comma-separated; empty — all enabled)'},
          {n:'minp',adv:true,t:'range',min:4,max:64,step:1,d:8,label:'min. pulses in a packet'},
          {n:'raw',t:'check',d:false,label:'log unidentified packets (pulse analysis → bits, hex)'},
          {n:'minBits',adv:true,t:'range',min:8,max:64,step:1,d:16,label:'unidentified: min. bits'},
          {n:'dedup',t:'range',min:0,max:5000,step:50,d:1000,label:'skip identical packets within, ms'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    if(u.loading) return u.err ? 'rtl_433 module: '+u.err : 'loading rtl_433 (vendor/rtl433.wasm)…';
    const head=u.N+' × '+(u.chW/1000).toFixed(0)+' kHz → '+(u.srOut/1000).toFixed(0)+' kS/s · '+u.dev+' decoders · '+u.st.dec+' decoded, '+u.st.unk+' unknown, '+u.st.dups+' repeats'+
      ' · noise '+(u.nz==null ? '?' : u.nz.toFixed(0))+' dB, gain '+u.gain.toFixed(0)+' dB · '+u.act+' busy ch · queue '+u.q+(u.st.drop ? ' (lost '+u.st.drop+')' : '')+' · '+u.load.toFixed(1)+' ms/tick'+
      (u.age!=null ? ' · last '+(u.age/1000).toFixed(0)+' s ago' : '');
    return head+(u.recent.length ? '\n'+u.recent.join('\n') : '\nno packet yet'); });
