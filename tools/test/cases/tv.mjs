// Аналоговое видео: генератор (таблица, PAL / NTSC, FM / AM) → TV Demodulator → TV Decoder, картинка против эталона
const CHAIN = (gen, dem={}, dec={}) => [[['iqGen', {sr:'20000000', fc:5.8e9, mode:'Analog TV', tv:'PAL', tvm:'FM', tvdev:5e6, off:0, lvl:-20, noise:-60, ...gen}],
  ['tvDemod', {mode:'FM', dev:5e6, bw:5e6, ...dem}], ['tvDecode', dec]], ['0.iq>1.in', '1.out>2.in']];

export function setup(){
  // среднее отклонение кадра от таблицы (внутри рамки): по яркости и по цвету
  window.tvError = n => {
    const f = n.frame, W = f.w, H = f.h, px = f.px;
    let e = 0, ey = 0, k = 0;
    for(let y = Math.ceil(H*.04); y < H*.96; y++) for(let x = Math.ceil(W*.04); x < W*.96; x++){
      const p = tvPat((x+.5)/W, (y+.5)/H), o = (y*W+x)*4;
      const yp = .299*p[0]+.587*p[1]+.114*p[2], yd = (.299*px[o]+.587*px[o+1]+.114*px[o+2])/255;
      ey += Math.abs(yp-yd);
      for(let c = 0; c < 3; c++) e += Math.abs(p[c]-px[o+c]/255);
      k++;
    }
    return {rgb: +(e/k/3).toFixed(4), luma: +(ey/k).toFixed(4)};
  };
  window.show = r => JSON.stringify({u:r.u, e:r.e});
  window.tvRun = (chain, sec) => {
    const ns = T.build(...chain);
    T.run(sec);
    const err = T.errors();
    if(err.length) return {bad: err.join('; ')};
    return {u: ns[2].ui, e: tvError(ns[2]), ns};
  };
}

export default [
  {name:'tv: PAL FM colour bars, 20 MS/s: lock, standard, field rate, picture matches the test card', arg:CHAIN({}), fn(chain){
    const r = tvRun(chain, .25);
    if(r.bad) return r.bad;
    const {u, e} = r;
    return u.lock && u.std === 'PAL' && u.color && u.lines >= 303 && u.lines <= 306 && Math.abs(u.fps-50) < 1 && e.luma < .04 && e.rgb < .05 || show(r);
  }},
  {name:'tv: NTSC FM at 10 MS/s: standard found by the number of lines (auto), colour', arg:CHAIN({sr:'10000000', tv:'NTSC'}), fn(chain){
    const r = tvRun(chain, .3);
    if(r.bad) return r.bad;
    const {u, e} = r;
    return u.lock && u.std === 'NTSC' && u.color && u.lines >= 251 && u.lines <= 254 && Math.abs(u.fps-59.94) < 1 && e.luma < .09 && e.rgb < .1 || show(r);
  }},
  {name:'tv: AM negative modulation (broadcast), PAL, 12 MS/s', arg:CHAIN({sr:'12000000', tvm:'AM'}, {mode:'AM (negative)'}), fn(chain){
    const r = tvRun(chain, .3);
    if(r.bad) return r.bad;
    const {u, e} = r;
    return u.lock && u.std === 'PAL' && u.color && e.luma < .09 && e.rgb < .1 || show(r);
  }},
  {name:'tv: inverted video — polarity found automatically', arg:CHAIN({sr:'12000000'}, {inv:true}), fn(chain){
    const r = tvRun(chain, 1);
    if(r.bad) return r.bad;
    const {u, e} = r;
    return u.lock && u.inv && u.color && e.luma < .09 && e.rgb < .1 || show(r);
  }},
  {name:'tv: colour off gives luma only; noisy FM (CNR ~20 dB) keeps sync and colour', arg:[CHAIN({}, {}, {color:false}), CHAIN({noise:-40})], fn([bw, noisy]){
    const a = tvRun(bw, .25);
    if(a.bad) return a.bad;
    if(!(a.u.lock && a.e.luma < .04 && a.e.rgb > .1)) return 'luma only '+show(a);
    const b = tvRun(noisy, .3);
    if(b.bad) return b.bad;
    return b.u.lock && b.u.color && b.e.luma < .1 && b.e.rgb < .12 || 'noisy '+show(b);
  }},
  {name:'tv: worker island delivers the picture (Frame node gets the image)', arg:CHAIN({sr:'12000000'}), async fn([nodes, wires]){
    Islands.setEnabled(true);
    try{
      const ns = T.build([...nodes, ['imgview', {}]], [...wires, '2.img>3.img']);
      if(!ns[2]._isl || ns[3]._isl) return 'wrong islands';
      await T.realtime(6);
      await new Promise(r => setTimeout(r, 500)); for(const nd of Graph.order) evalNode(nd);
      const e = T.errors(); if(e.length) return e.join('; ');
      const im = ns[3].i, u = ns[2].ui;
      if(!im || !(im.data instanceof ImageData)) return 'no image, dropped '+Islands.dropped+', ui '+JSON.stringify(u);
      return im.w === 600 && im.h === 576 && u.lock || 'image '+im.w+'×'+im.h+', ui '+JSON.stringify(u);
    } finally { Islands.setEnabled(false); }
  }},
  {name:'preset: Analog TV: Test Card (Generator)', fn(){
    T.preset('Analog TV: Test Card (Generator)'); T.run(.4);
    const e = T.errors(); if(e.length) return e.join('; ');
    const u = T.byType('tvDecode')[0].ui;
    return u && u.lock && u.color && u.std === 'PAL' || 'decoder '+JSON.stringify(u);
  }},
  {name:'preset: Analog TV: FPV / TV Receiver (USB SDR) (not connected)', fn(){
    T.preset('Analog TV: FPV / TV Receiver (USB SDR)'); T.run(.3);
    const e = T.errors(); return e.length ? e.join('; ') : true;
  }},
];
