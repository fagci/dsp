// Каналайзер (iqChan) и сумма потоков (iqAdd)
const TWO = [
  ['iqGen', {sr:'1024000', fc:100e6, off:96000, lvl:-20, noise:-80, tone:1000, mode:'FM', dev:5000}],
  ['iqGen', {sr:'1024000', fc:100e6, off:-160000, lvl:-20, noise:-80, tone:700, mode:'AM', depth:.5}],
  ['iqAdd', {}],
  ['iqChan', {N:'32', ov:'2', P:'16', K:'2', sel:'manual', freqs:'100.096, 99.84'}],
  ['iqDemod', {mode:'FM', dev:5000}], ['iqAudio', {}],
  ['iqDemod', {mode:'AM'}], ['iqAudio', {}],
];
const TWO_W = ['0.iq>2.a', '1.iq>2.b', '2.out>3.in', '3.ch1>4.in', '4.out>5.in', '3.ch2>6.in', '6.out>7.in'];

// в странице, один раз: прогон ядра на синтетическом потоке кусками sizes, выход слота q
export function setup(){
  window.chanRun = (p, sig, L, sizes, q=0) => {
    const n = {p:{N:'16', ov:'2', P:'16', K:'1', sel:'manual', freqs:'', thr:10, hold:1, skipDc:true, upd:100, ...p}};
    IQK.iqChan.init(n);
    const re = new Float32Array(L), im = new Float32Array(L);
    for(let i=0; i<L; i++){ const [a, b] = sig(i); re[i] = a; im[i] = b; }
    const outR = [], outI = []; let pos = 0, k = 0, last;
    while(pos < L){
      const c = Math.min(sizes[k++ % sizes.length], L-pos);
      const s = {sr:160000, fc:0, chunks:[], t:0};
      if(c > 0) s.chunks.push({re:re.subarray(pos, pos+c), im:im.subarray(pos, pos+c), t0:pos, tag:null});
      pos += c;
      last = IQK.iqChan.process(n, {in:s}, {block:512, sr:48000});
      for(const ch of last['ch'+(q+1)]?.chunks || []){ outR.push(...ch.re); outI.push(...ch.im); }
    }
    return {re:outR, im:outI, n, last};
  };
  // средняя частота комплексного сигнала по приращению фазы и средний модуль (после переходного)
  window.cplxTone = (o, sr) => {
    let d = 0, m = 0, k = 0;
    for(let i=o.re.length>>1; i<o.re.length; i++){
      d += Math.atan2(o.im[i]*o.re[i-1]-o.re[i]*o.im[i-1], o.re[i]*o.re[i-1]+o.im[i]*o.im[i-1]);
      m += Math.hypot(o.re[i], o.im[i]); k++;
    }
    return {f:d/k*sr/(2*Math.PI), mag:m/k};
  };
  return true;
}

export default [
  {name:'chan: channel 3 of 16 at 160 kS/s: +1 kHz tone, gain 1', fn(){
    // шаг 10 кГц; тон 31 кГц → канал 3 (30 кГц), в канале +1 кГц; выход 20 кС/с
    const o = chanRun({freqs:'0.03'}, i => [0.5*Math.cos(2*Math.PI*31000*i/160000), 0.5*Math.sin(2*Math.PI*31000*i/160000)], 32000, [4096]);
    const t = cplxTone(o, 20000);
    return Math.abs(t.f-1000) < 1 && Math.abs(t.mag-0.5) < 0.01 && o.last.ch1.fc === 30000 || `f=${t.f.toFixed(2)} mag=${t.mag.toFixed(4)} fc=${o.last.ch1.fc}`;
  }},
  {name:'chan: negative-frequency channel', fn(){
    const f = -42000;   // канал −4 (−40 кГц), в канале −2 кГц
    const o = chanRun({freqs:'-0.04'}, i => [Math.cos(2*Math.PI*f*i/160000), Math.sin(2*Math.PI*f*i/160000)], 32000, [4096]);
    const t = cplxTone(o, 20000);
    return Math.abs(t.f+2000) < 1 && Math.abs(t.mag-1) < 0.02 || `f=${t.f.toFixed(2)} mag=${t.mag.toFixed(4)}`;
  }},
  {name:'chan: neighbour channel centre rejected > 60 dB (ov 2, 16 taps)', fn(){
    const o = chanRun({freqs:'0.03'}, i => [Math.cos(2*Math.PI*40000*i/160000), Math.sin(2*Math.PI*40000*i/160000)], 32000, [4096]);
    const t = cplxTone(o, 20000), db = 20*Math.log10(t.mag);
    return db < -60 || `neighbour at ${db.toFixed(1)} dB`;
  }},
  {name:'chan: output does not depend on chunking', fn(){
    const sig = i => [Math.cos(i*0.37)+0.2*Math.cos(i*1.9), Math.sin(i*0.37)];
    const a = chanRun({freqs:'0.01'}, sig, 5000, [5000]), b = chanRun({freqs:'0.01'}, sig, 5000, [3, 0, 17, 1, 250, 0, 7, 64]);
    if(a.re.length !== b.re.length || a.re.length !== Math.floor(5000/8)) return `lengths ${a.re.length} ${b.re.length}`;
    let d = 0; for(let i=0; i<a.re.length; i++) d = Math.max(d, Math.abs(a.re[i]-b.re[i]), Math.abs(a.im[i]-b.im[i]));
    return d < 1e-6 || `max diff ${d}`;
  }},
  {name:'chan: strongest mode picks both signals, one slot each', arg:[TWO.slice(0, 4).map(([t, p]) => t==='iqChan' ? [t, {...p, sel:'strongest', K:'3'}] : [t, p]), TWO_W.slice(0, 3)],
   fn([g, w]){
    const ns = T.build(g, w);
    T.run(1);
    const got = ns[3].ui.slots.filter(f => f != null).map(f => Math.round((f-100e6)/1000)).sort((a, b) => a-b);
    return JSON.stringify(got) === '[-160,96]' && ns[3].out.active === 2 || 'slots '+JSON.stringify(ns[3].ui.slots)+' active '+ns[3].out.active;
  }},
  {name:'chan: two receivers at once — FM 1 kHz and AM 700 Hz', arg:[TWO, TWO_W], fn([g, w]){
    const ns = T.build(g, w);
    const out = {a:[], b:[]};
    T.run(1.5);                                   // AM: среднее несущей устанавливается ~1 с
    const cnt = Math.ceil(1*Eng.sr/BLOCK);
    for(let i=0; i<cnt; i++){ for(const nd of Graph.order) evalNode(nd); out.a.push(...ns[5].out.out); out.b.push(...ns[7].out.out); }
    const e = T.errors(); if(e.length) return e.join('; ');
    const fa = T.toneHz(Float32Array.from(out.a), Eng.sr), fb = T.toneHz(Float32Array.from(out.b), Eng.sr);
    const pa = T.peak(out.a), pb = T.peak(out.b);
    return Math.abs(fa-1000) < 2 && Math.abs(fb-700) < 2 && pa > 0.9 && pa < 1.1 && Math.abs(pb-0.5) < 0.05
      || `FM ${fa.toFixed(1)} Hz peak ${pa.toFixed(3)}, AM ${fb.toFixed(1)} Hz peak ${pb.toFixed(3)}`;
  }},
  {name:'chan: two receivers in a worker', arg:[TWO, TWO_W], async fn([g, w]){
    Islands.setEnabled(true);
    try{
      const ns = T.build(g, w);
      if(!ns[3]._isl || ns[5]._isl) return 'islands: '+ns.map(n => !!n._isl);
      const out = {a:[], b:[]};
      await T.realtime(2.5, t => { if(t > 1.5){ out.a.push(...ns[5].out.out); out.b.push(...ns[7].out.out); } });
      const fa = T.toneHz(Float32Array.from(out.a), Eng.sr), fb = T.toneHz(Float32Array.from(out.b), Eng.sr);
      return Math.abs(fa-1000) < 2 && Math.abs(fb-700) < 2 || `FM ${fa.toFixed(1)}, AM ${fb.toFixed(1)}`;
    } finally { Islands.setEnabled(false); }
  }},
  {name:'chan: changing outputs rebuilds ports and drops dead wires', arg:[TWO, TWO_W], fn([g, w]){
    const ns = T.build(g, w), ch = ns[3];
    if(!portsOf(ch, 'outs').some(p => p.n==='ch2')) return 'no ch2';
    ch.set ? ch.set.K('1') : (ch.p.K = '1');
    MOD.iqChan.params.find(p => p.n==='K').fn(ch);
    retopo();
    const bad = Graph.edges.filter(e => e.from===ch.id && e.fp==='ch2').length;
    return bad === 0 && !portsOf(ch, 'outs').some(p => p.n==='ch2') && Graph.edges.some(e => e.from===ch.id && e.fp==='ch1') || 'ch2 wires: '+bad;
  }},
];
