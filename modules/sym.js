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
          {n:'loop',t:'range',min:.001,max:.1,step:.001,d:.01,label:'timing loop gain',adv:true},
          {n:'agc',t:'range',min:16,max:16384,step:16,d:256,log:true,label:'level tracking time, symbols',adv:true}]},
  n=>!n.ui ? 'no input' : n.ui.err || n.ui.sps.toFixed(2)+' samples per symbol · '+n.ui.symbols+' symbols · timing '+n.ui.timing.toFixed(3));

defIQ({ id:'symSync', title:'Symbol Sync Search', cat:'Protocols', kw:'4fsk sync word frame m17 dmr',
  ins:[{n:'in',t:'iq'}], outs:[{n:'blk',t:'blk'}],
  params:[{n:'word',t:'text',d:'55F7 FF5D 75FF DF55',label:'sync words (hex, several separated by spaces)'},
          {n:'len',t:'range',min:1,max:4096,step:1,d:184,label:'frame length after the word, symbols'},
          {n:'tol',t:'range',min:0,max:8,step:1,d:1,label:'error tolerance, bits of the word'},
          {n:'corr',t:'range',min:.5,max:.99,step:.01,d:.9,label:'minimum correlation with the word'},
          {n:'pol',t:'select',opts:['auto','normal','inverted'],d:'auto',label:'polarity'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    const hits=Object.entries(u.sync).map(([w,c])=>w+' ×'+c).join('  ');
    return u.frames+' frames'+(hits ? ' · '+hits : ''); });

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
