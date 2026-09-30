"use strict";
/* ============================ Аналоговое видео: ТВ и FPV ============================
   TV Demodulator (IQ-блок, ядро в video-kernels.js): IQ ≥ 8 МС/с → композитный видеосигнал (вещественный поток, синхроимпульсы внизу).
   TV Decoder: строчная и кадровая синхронизация, PAL / NTSC, цвет → картинка на `img` (показывает узел Frame). */

defIQ({ id:'tvDemod', title:'TV Demodulator', cat:'IQ',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'iq'}],
  params:[{n:'mode',t:'select',opts:['FM','AM (negative)','AM (positive)'],d:'FM',label:'FM: FPV 5.8 GHz, satellite; AM negative: broadcast TV (tune to the vision carrier)'},
          {n:'dev',t:'num',d:8000000,label:'FM: deviation, sync tip to white, Hz (only scales the level)'},
          {n:'bw',t:'range',min:1e6,max:8e6,step:1e5,d:5e6,label:'video bandwidth, Hz'},
          {n:'inv',t:'check',d:false,label:'invert (FM with the opposite sign)'}]},
  n=>n.ui ? (n.ui.sr<8e6 ? 'needs ≥ 8 MS/s for colour! · ' : '')+n.p.mode+' · '+(n.ui.sr/1e6)+' MS/s · video '+(n.ui.bw/1e6).toFixed(1)+' MHz' : 'no input');

defIQ({ id:'tvDecode', title:'TV Decoder', cat:'Decoders',
  ins:[{n:'in',t:'iq'}], outs:[{n:'img',t:'img'},{n:'lock',t:'num'},{n:'fps',t:'num'}],
  params:[{n:'std',t:'select',opts:['auto','PAL','NTSC'],d:'auto',label:'standard (auto: by lines per field)'},
          {n:'width',t:'select',opts:['384','480','600','720','960'],d:'600',label:'picture width, px'},
          {n:'invert',t:'select',opts:['auto','off','on'],d:'auto',label:'polarity (auto: flips when there is no sync)'},
          {n:'interlace',t:'select',opts:['weave','bob'],d:'weave',label:'fields: weave (sharp; combs on motion) or bob (line doubling)'},
          {n:'color',t:'check',d:true,label:'colour (needs a colour burst and a sample rate ≥ 2.4 × subcarrier: 10.6 MS/s PAL, 8.6 MS/s NTSC; off — luma only)'},
          {n:'bright',t:'range',min:-.5,max:.5,step:.01,d:0,label:'brightness'},
          {n:'contrast',t:'range',min:.5,max:2,step:.01,d:1,label:'contrast'},
          {n:'hshift',t:'range',min:-4,max:4,step:.1,d:0,label:'picture shift, µs'},
          {n:'vshift',t:'range',min:-12,max:12,step:1,d:0,label:'picture shift, lines'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    return (u.lock ? 'locked' : 'searching sync')+' · '+u.std+(u.fps ? ' · '+u.fps.toFixed(1)+' fields/s' : '')+
      (u.lines ? ' · '+u.lines+' lines/field' : '')+' · '+(u.color ? 'colour' : u.cOK ? 'no burst' : 'B/W (sample rate too low for colour)')+
      (u.inv ? ' · inverted' : '')+' · '+u.w+'×'+u.h; });
