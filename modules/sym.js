"use strict";
/* ============================ Символьный тракт: узлы ============================
   Ядра — в sym-kernels.js. Цепочка 4FSK-приёмника руками: IQ → FM Discriminator → RRC → Symbol Slicer → Symbol Sync Search → кадры (blk).
   Символы идут по IQ-проводу как вещественный поток на частоте символов. */

defIQ({ id:'fmDisc', title:'FM Discriminator', cat:'IQ', kw:'fm demodulator 4fsk frequency',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'iq'}],
  params:[{n:'bw',t:'range',min:0,max:50000,step:100,d:5500,label:'channel filter cutoff, Hz (0 — off)'},
          {n:'dc',t:'range',min:0,max:2,step:.05,d:.2,label:'DC block time constant, s (0 — off)'}]},
  n=>n.ui ? 'FM · '+(n.ui.sr/1000)+' kS/s' : 'no input');

defIQ({ id:'symRrc', title:'RRC Matched Filter', cat:'IQ', kw:'root raised cosine 4fsk symbol',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'iq'}],
  params:[{n:'baud',t:'num',d:4800,label:'symbol rate, Bd'},
          {n:'alpha',t:'range',min:.05,max:1,step:.01,d:.2,label:'roll-off α (DMR, P25 0.2; M17 0.5)'}]},
  n=>n.ui ? n.ui.sps.toFixed(2)+' samples per symbol · '+n.ui.taps+' taps' : 'no input');

defIQ({ id:'symSlicer', title:'Symbol Slicer (4-level)', cat:'IQ', kw:'4fsk symbol clock timing recovery',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'iq'}],
  params:[{n:'baud',t:'num',d:4800,label:'symbol rate, Bd'},
          {n:'loop',t:'range',min:.001,max:.2,step:.001,d:.05,label:'timing loop gain',adv:true},
          {n:'agc',t:'range',min:16,max:16384,step:16,d:256,log:true,label:'level tracking time, symbols',adv:true}]},
  n=>!n.ui ? 'no input' : n.ui.err || n.ui.sps.toFixed(2)+' samples per symbol · '+n.ui.symbols+' symbols · timing '+n.ui.timing.toFixed(3));

defIQ({ id:'pskRx', title:'PSK/QAM Receiver (EVM)', cat:'Analysis', kw:'evm mer constellation bpsk qpsk 8psk 16qam symbol timing carrier recovery costas gardner',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'iq'},{n:'evm',t:'num'},{n:'mer',t:'num'},{n:'foff',t:'num'},{n:'lock',t:'num'}],
  params:[{n:'mod',t:'select',opts:['BPSK','QPSK','8PSK','16QAM'],d:'QPSK',label:'modulation'},
          {n:'baud',t:'num',d:25000,label:'symbol rate, Bd (≥ 2 samples per symbol at the input)'},
          {n:'alpha',t:'range',min:.1,max:1,step:.01,d:.35,label:'RRC roll-off'},
          {n:'tbw',t:'range',min:.001,max:.05,step:.001,log:true,d:.01,label:'timing loop bandwidth, × symbol rate'},
          {n:'cbw',t:'range',min:.002,max:.1,step:.001,log:true,d:.02,label:'carrier loop bandwidth, × symbol rate'},
          {n:'win',t:'select',opts:['500','1000','2000','5000','20000'],d:'2000',label:'EVM window, symbols'}]},
  n=>{ const u=n.ui;
    if(!u) return 'no input';
    if(u.err) return u.err;
    if(u.evm==null) return 'acquiring… '+u.n+' symbols';
    return (u.lock ? 'LOCK' : 'no lock')+' · EVM '+(u.evm*100).toFixed(2)+' % ('+(20*Math.log10(Math.max(u.evm,1e-4))).toFixed(1)+' dB) · MER '+u.mer.toFixed(1)+' dB · Δf '+(u.foff>=0?'+':'')+u.foff.toFixed(1)+' Hz'; });

defIQ({ id:'symSync', title:'Symbol Sync Search', cat:'Protocols', kw:'4fsk sync word frame m17 dmr',
  ins:[{n:'in',t:'iq'}], outs:[{n:'blk',t:'blk'}],
  params:[{n:'word',t:'text',d:'55F7 FF5D 75FF DF55',label:'sync words (hex, several separated by spaces)'},
          {n:'len',t:'range',min:1,max:4096,step:1,d:184,label:'frame length after the word, symbols'},
          {n:'tol',t:'range',min:0,max:8,step:1,d:1,label:'error tolerance, bits of the word'},
          {n:'corr',t:'range',min:.5,max:.99,step:.01,d:.9,label:'minimum correlation with the word'},
          {n:'pol',t:'select',opts:['auto','normal','inverted'],d:'auto',label:'polarity'},
          {n:'pre',t:'range',min:0,max:256,step:1,d:0,label:'symbols before the word to include in the frame (DMR 66)',adv:true},
          {n:'period',t:'range',min:0,max:4096,step:1,d:0,label:'frame period, symbols: keep the frame grid after a lock, also when the word is missing (0 — off; DMR 144)',adv:true},
          {n:'lockTol',t:'range',min:0,max:24,step:1,d:1,label:'error tolerance while the grid is held, bits of the word',adv:true},
          {n:'miss',t:'range',min:1,max:100,step:1,d:12,label:'frames in a row without the word before the lock is dropped',adv:true}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    const hits=Object.entries(u.sync).map(([w,c])=>w+' ×'+c).join('  ');
    return u.frames+' frames'+(u.locked ? ' · locked' : '')+(hits ? ' · '+hits : ''); });

/* ---- передатчик: зеркало приёмной цепочки ---- */
defIQ({ id:'symPlay', title:'Symbol Player', cat:'Protocols', kw:'4fsk transmit frames symbols tx',
  ins:[{n:'blk',t:'blk'}], outs:[{n:'out',t:'iq'}],
  params:[{n:'baud',t:'num',d:4800,label:'symbol rate, Bd'}]},
  n=>!n.ui ? '…' : n.ui.sending ? 'sending · '+n.ui.left+' symbols left · '+n.ui.queued+' queued' : 'idle · '+n.ui.sent+' sent');

defIQ({ id:'symShape', title:'RRC Pulse Shaper', cat:'IQ', kw:'root raised cosine 4fsk transmit tx',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'iq'}],
  params:[{n:'sr',t:'select',opts:IQ_SR_OPTS,d:'256000',label:'output sample rate'},
          {n:'alpha',t:'range',min:.05,max:1,step:.01,d:.5,label:'roll-off α (M17 0.5; DMR, P25 0.2)'}]},
  n=>n.ui ? (n.ui.sps).toFixed(2)+' samples per symbol → '+(n.ui.sr/1000)+' kS/s' : 'no input');

defIQ({ id:'fmMod', title:'FM Modulator', cat:'IQ', kw:'4fsk transmit tx frequency modulator',
  ins:[{n:'in',t:'iq'}], outs:[{n:'iq',t:'iq'}],
  params:[{n:'fc',t:'num',d:433000000,label:'center frequency, Hz'},
          {n:'off',t:'num',d:100000,label:'carrier offset from center, Hz (transmit on center + offset)'},
          {n:'dev',t:'range',min:50,max:20000,step:10,d:800,log:true,label:'deviation per unit level, Hz (M17 800; DMR 648; P25 600)'},
          {n:'lvl',t:'range',min:-60,max:0,step:1,d:-6,label:'output level, dBFS'}]},
  n=>n.ui ? 'FM · '+(n.ui.air/1e6).toFixed(4)+' MHz' : 'no input');

// остальные протоколы 4FSK (P25, NXDN, YSF, D-STAR, dPMR, а также DMR и M17 целиком): код протокола из Digital Voice Decoder на выходе согласованного фильтра
defIQ({ id:'fskSym', title:'Protocol Decoder (4FSK)', cat:'Decoders', tall:true, resize:true, w:480,
  kw:'p25 nxdn ysf m17 d-star dstar dpmr dmr 4fsk decoder digital voice',
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'},{n:'voice',t:'rec'}],
  params:[{n:'proto',t:'select',opts:['auto',...FSK4.order],d:'auto',label:'protocol (auto: every one with the symbol rate below, picked by sync words)'},
          {n:'baud',t:'num',d:4800,label:'symbol rate for auto, Bd'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    if(u.err) return u.err;
    const a=u.active && u.protos[u.active], ids=Object.keys(u.protos);
    if(a) return a.text;
    const recent=ids.flatMap(id=>u.protos[id].recent||[]).slice(-6);
    return (u.fs/1000).toFixed(1)+' kS/s · searching sync ('+ids.join(', ')+')'+(recent.length ? '\n'+recent.join('\n') : ''); });
