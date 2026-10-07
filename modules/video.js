"use strict";
/* ============================ Аналоговое видео: ТВ и FPV ============================
   TV Demodulator (IQ-блок, ядро в video-kernels.js): IQ ≥ 8 МС/с → композитный видеосигнал (вещественный поток, синхроимпульсы внизу).
   TV Decoder: строчная и кадровая синхронизация, PAL / NTSC, цвет → картинка на `img` (показывает узел Frame). */

defIQ({ id:'tvDemod', title:'TV Demodulator', cat:'Modulation',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'iq'}],
  params:[{n:'mode',t:'select',opts:['FM','AM (negative)','AM (positive)'],d:'FM',label:'FM: FPV 5.8 GHz, satellite; AM negative: broadcast TV (tune to the vision carrier)'},
          {n:'dev',t:'num',d:8000000,label:'FM: deviation, sync tip to white, Hz (only scales the level)'},
          {n:'bw',t:'range',min:1e6,max:8e6,step:1e5,d:5e6,label:'video bandwidth, Hz'},
          {n:'inv',t:'check',d:false,label:'invert (FM with the opposite sign)'}]},
  n=>n.ui ? (n.ui.sr<8e6 ? 'needs ≥ 8 MS/s for colour! · ' : '')+n.p.mode+' · '+(n.ui.sr/1e6)+' MS/s · video '+(n.ui.bw/1e6).toFixed(1)+' MHz' : 'no input');

defIQ({ id:'tvDecode', title:'TV Decoder', cat:'Decoders',
  ins:[{n:'in',t:'iq'}], outs:[{n:'img',t:'img'},{n:'lock',t:'num'},{n:'fps',t:'num'}],
  params:[{n:'std',t:'select',opts:['auto','PAL','NTSC'],d:'auto',label:'standard (auto: by lines per field)'},
          {n:'sync',t:'select',opts:['auto','free'],d:'auto',label:'sync: auto, or free — no sync needed: lines at the nominal rate, levels from picture statistics (weak signal, narrow bandwidth)'},
          {n:'trim',t:'range',min:-20000,max:20000,step:1,d:0,label:'free: line rate trim, ppm (the picture stops slanting when it matches)'},
          {n:'width',t:'select',opts:['384','480','600','720','960'],d:'600',label:'picture width, px'},
          {n:'invert',t:'select',opts:['auto','off','on'],d:'auto',label:'polarity (auto: flips when there is no sync)'},
          {n:'interlace',t:'select',opts:['weave','bob'],d:'weave',label:'fields: weave (sharp; combs on motion) or bob (line doubling)'},
          {n:'color',t:'check',d:true,label:'colour (needs a colour burst and a sample rate ≥ 2.4 × subcarrier: 10.6 MS/s PAL, 8.6 MS/s NTSC; off — luma only)'},
          {n:'bright',t:'range',min:-.5,max:.5,step:.01,d:0,label:'brightness'},
          {n:'contrast',t:'range',min:.5,max:2,step:.01,d:1,label:'contrast'},
          {n:'hshift',t:'range',min:-4,max:4,step:.1,d:0,label:'picture shift, µs'},
          {n:'vshift',t:'range',min:-12,max:12,step:1,d:0,label:'picture shift, lines'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    if(u.free) return 'free-run (no sync) · '+u.std+' line rate · '+u.w+'×'+u.h;
    return (u.lock ? 'locked' : 'searching sync')+' · '+u.std+(u.fps ? ' · '+u.fps.toFixed(1)+' fields/s' : '')+
      (u.lines ? ' · '+u.lines+' lines/field' : '')+' · '+(u.color ? 'colour' : u.cOK ? 'no burst' : 'B/W (sample rate too low for colour)')+
      (u.inv ? ' · inverted' : '')+' · '+u.w+'×'+u.h; });

defIQ({ id:'tvHop', title:'TV Hopper (mosaic)', cat:'Decoders',
  ins:[{n:'in',t:'iq'},{n:'hold',t:'num'}], outs:[{n:'freq',t:'num'},{n:'img',t:'img'},{n:'sel',t:'img'},{n:'lock',t:'num'},{n:'ch',t:'num'}],
  params:[{n:'chs',t:'text',d:'5658,5695,5732,5769',label:'channels, MHz (up to 16, comma-separated): one receiver visits them in turn'},
          {n:'hold',t:'num',d:0,label:'hold: stay on channel number N (1…) and show its full frame on sel; 0 — hop'},
          {n:'dwell',t:'range',min:40,max:500,step:10,d:120,label:'max time on a channel without a field, ms'},
          {n:'probe',t:'range',min:40,max:300,step:10,d:80,label:'time on a channel that gave no field last time, ms (empty channels are also visited less often)'},
          {n:'settle',t:'range',min:50,max:1000,step:10,d:300,label:'wait for the receiver to reach the channel, ms'},
          {n:'stale',t:'range',min:1,max:20,step:1,d:3,label:'a channel not updated for this long is not counted as locked, s'},
          {n:'dev',t:'num',d:8000000,label:'FM deviation, Hz (only scales the level)',adv:true},
          {n:'bw',t:'range',min:1e6,max:8e6,step:1e5,d:5e6,label:'video bandwidth, Hz',adv:true},
          {n:'inv',t:'check',d:false,label:'invert',adv:true},
          {n:'std',t:'select',opts:['auto','PAL','NTSC'],d:'auto',label:'standard',adv:true},
          {n:'color',t:'check',d:true,label:'colour (needs ≥ 10.6 MS/s)',adv:true},
          {n:'bright',t:'range',min:-.5,max:.5,step:.01,d:0,label:'brightness',adv:true},
          {n:'contrast',t:'range',min:.5,max:2,step:.01,d:1,label:'contrast',adv:true}]},
  n=>{ const u=n.ui; if(!u) return 'no channels';
    return (u.hold ? 'hold ' : 'hop ')+(u.i+1)+'/'+u.n+' · '+u.chans.map((c,k)=>(k===u.i ? '▶' : '')+(c.f/1e6).toFixed(0)+(c.lock ? ' ●' : c.age!=null ? ' ○' : ' –')).join('  '); });
