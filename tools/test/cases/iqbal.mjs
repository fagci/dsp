// IQ Balance: зеркальный образ тона до/после, сдвиг каналов звуковой карты; LRPT на 192 кС/с
export function setup(){
  // прогон sec секунд; из узла ns[k] копится поток порта port
  window.iqCollect = (node, port, sec, skip=0) => {
    const re = [], im = [], n = Math.ceil((sec+skip)*Eng.sr/BLOCK), n0 = Math.ceil(skip*Eng.sr/BLOCK);
    let sr = 0;
    for(let b=0; b<n; b++){
      for(const o of Eng.outs) o.fill(0);
      for(const nd of Graph.order) evalNode(nd);
      Eng.blocks++;
      const s = node.out[port];
      if(b >= n0 && s && s.chunks) for(const c of s.chunks){ sr = s.sr; re.push(...c.re); im.push(...(c.im || new Float32Array(c.re.length))); }
    }
    return {re, im, sr};
  };
  // мощность на частоте f (Гц) комплексного потока
  window.iqPowerAt = (s, f) => {
    let a = 0, b = 0; const w = -2*Math.PI*f/s.sr;
    for(let i=0; i<s.re.length; i++){ const c = Math.cos(w*i), d = Math.sin(w*i); a += s.re[i]*c-s.im[i]*d; b += s.re[i]*d+s.im[i]*c; }
    return (a*a+b*b)/s.re.length**2;
  };
}

const TONE = (gen, bal) => [[['iqGen', {sr:'192000', fc:0, mode:'carrier', off:20000, lvl:-10, noise:-50, imbG:1, imbP:5, ...gen}],
  ['iqBalance', bal]], ['0.iq>1.in']];

export default [
  {name:'iq balance: auto removes the mirror image of a tone (1 dB, 5°)', arg:TONE({}, {auto:true, tau:.3}), fn([g, w]){
    const ns = T.build(g, w), s = iqCollect(ns[1], 'out', 1, 1.5);
    const e = T.errors(); if(e.length) return e.join('; ');
    const img = 10*Math.log10(iqPowerAt(s, -20000)/iqPowerAt(s, 20000)), u = ns[1].ui;
    if(!(u.before < -20 && u.before > -26)) return 'before '+u.before;
    if(Math.abs(u.gain-1) > .05 || Math.abs(u.phase-5) > .3) return `estimate ${u.gain} dB ${u.phase}°`;
    return img < -50 || 'image '+img.toFixed(1)+' dB';
  }},
  {name:'iq balance: manual values do the same', arg:TONE({}, {auto:false, gain:1, phase:5}), fn([g, w]){
    const ns = T.build(g, w), s = iqCollect(ns[1], 'out', .5, .2);
    const img = 10*Math.log10(iqPowerAt(s, -20000)/iqPowerAt(s, 20000));
    return img < -50 || 'image '+img.toFixed(1)+' dB';
  }},
  {name:'iq balance: off-balance input really has an image (control)', arg:TONE({}, {auto:false}), fn([g, w]){
    const ns = T.build(g, w), s = iqCollect(ns[1], 'out', .5, .2);
    const img = 10*Math.log10(iqPowerAt(s, -20000)/iqPowerAt(s, 20000));
    return img > -26 && img < -20 || 'image '+img.toFixed(1)+' dB';
  }},
  {name:'iq balance: Q one sample late — delay 1 fixes the image at any frequency', fn(){
    const bad = [];
    for(const off of [8000, 40000]){
      const ns = T.build([['iqGen', {sr:'192000', fc:0, mode:'carrier', off, lvl:-10, noise:-50, imbD:1}], ['iqBalance', {auto:false, delay:1}]], ['0.iq>1.in']);
      const s = iqCollect(ns[1], 'out', .5, .2), img = 10*Math.log10(iqPowerAt(s, -off)/iqPowerAt(s, off));
      if(!(img < -45)) bad.push(off+' Hz: '+img.toFixed(1));
    }
    return bad.length ? bad.join('; ') : true;
  }},
  {name:'preset: Sound Card IQ: HF Receiver (SoftRock-style) (no input)', fn(){
    T.preset('Sound Card IQ: HF Receiver (SoftRock-style)');
    T.byType('mic')[0].armed = true;                 // не включать захват: живой AudioContext мешает следующим тестам
    T.run(.5);
    const e = T.errors(); if(e.length) return e.join('; ');
    return T.byType('iqBalance')[0].ui ? true : 'balance got no stream';
  }},
  {name:'lrpt: 192 kS/s (sound card rate) through an unbalanced input + IQ Balance', fn(){
    const ns = T.build([['iqGen', {sr:'192000', fc:0, mode:'LRPT', lrpt:'OQPSK', off:-2000, lvl:-20, noise:-35, imbG:.8, imbP:4, imbD:1}],
      ['iqBalance', {auto:true, tau:.3, delay:1}], ['pskDemod', {mode:'OQPSK'}], ['ccsdsDecode', {}]],
      ['0.iq>1.in', '1.out>2.in', '2.out>3.in']);
    const recs = [], n = Math.ceil(4*Eng.sr/BLOCK);
    for(let b=0; b<n; b++){
      for(const o of Eng.outs) o.fill(0);
      for(const nd of Graph.order) evalNode(nd);
      Eng.blocks++;
      if(ns[3].out.rec) recs.push(...ns[3].out.rec);
    }
    const e = T.errors(); if(e.length) return e.join('; ');
    if(ns[2].ui.M !== 1) return 'decimation '+ns[2].ui.M;
    if(recs.length < 20) return 'frames '+recs.length+' '+JSON.stringify(ns[3].ui);
    for(let i=1; i<recs.length; i++) if(recs[i].cnt !== recs[i-1].cnt+1) return 'gap at '+recs[i].cnt;
    return recs.every(r => { const ref = lrptSimVcdu(r.cnt); return r.vcdu.every((v, k) => v === ref[k]); }) || 'payload mismatch';
  }},
];
