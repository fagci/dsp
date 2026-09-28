// Поток 'iq': генератор → сдвиг → децимация → демодулятор → мост в звук.
// fn выполняется в странице, замыканий там нет — граф передаётся через arg
const RX = ['0.iq>1.in', '1.out>2.in', '2.out>3.in', '3.out>4.in'];
const chain = (gen, dem) => [
  ['iqGen', {sr:'1024000', fc:100e6, off:100000, lvl:-20, noise:-60, tone:1000, ...gen}],
  ['iqShift', {offset:100000}],
  ['iqDecim', {M:'16'}],
  ['iqDemod', dem],
  ['iqAudio', {}],
];

export default [
  {name:'iq: FM chain → 1 kHz tone, level = deviation', arg:[chain({mode:'FM', dev:5000}, {mode:'FM', dev:5000}), RX], fn([g, w]){
    const ns = T.build(g, w);
    const a = T.capture(ns[4], 'out', 1, 0.5);
    const e = T.errors(); if(e.length) return e.join('; ');
    const f = T.toneHz(a, Eng.sr), pk = T.peak(a);
    return Math.abs(f-1000) < 2 && pk > 0.9 && pk < 1.1 || `f=${f.toFixed(2)} peak=${pk.toFixed(3)}`;
  }},
  {name:'iq: FM chain via absolute freq input',
   arg:[[...chain({mode:'FM', dev:3000, tone:700}, {mode:'FM', dev:3000}), ['const', {v:100.1e6}]], [...RX, '5.out>1.freq']],
   fn([g, w]){
    const ns = T.build(g, w);
    ns[1].p.offset = 0;
    const a = T.capture(ns[4], 'out', 1, 0.5);
    const e = T.errors(); if(e.length) return e.join('; ');
    const f = T.toneHz(a, Eng.sr);
    return Math.abs(f-700) < 2 && ns[1].out.offset === 100000 || `f=${f.toFixed(2)} offset=${ns[1].out.offset}`;
  }},
  {name:'iq: AM chain → depth', arg:[chain({mode:'AM', depth:.5}, {mode:'AM'}), RX], fn([g, w]){
    const ns = T.build(g, w);
    const a = T.capture(ns[4], 'out', 1, 1);
    const f = T.toneHz(a, Eng.sr), pk = T.peak(a);
    return Math.abs(f-1000) < 2 && Math.abs(pk-0.5) < 0.05 || `f=${f.toFixed(2)} peak=${pk.toFixed(3)}`;
  }},
  {name:'iq: USB passes, LSB rejects', arg:[chain({mode:'USB', tone:1200}, {mode:'USB'}), RX], fn([g, w]){
    const ns = T.build(g, w);
    const a = T.capture(ns[4], 'out', 1, 0.5);
    const f = T.toneHz(a, Eng.sr), ru = T.rms(a);
    ns[3].p.mode = 'LSB';
    const b = T.capture(ns[4], 'out', 1, 0.5), rl = T.rms(b);
    const rej = 20*Math.log10(ru/rl);
    return Math.abs(f-1200) < 2 && rej > 30 || `f=${f.toFixed(2)} rejection=${rej.toFixed(1)} dB`;
  }},
  {name:'iq: bridge keeps buffer, no drift, no starvation', arg:[chain({mode:'FM'}, {mode:'FM'}), RX], fn([g, w]){
    const ns = T.build(g, w);
    T.run(3);
    const b = ns[4];
    const ok = b.starves === 0 && b.drops === 0 && Math.abs(b.ppm) < 50 && Math.abs(b.out.fill-100) < 15;
    return ok || `starves=${b.starves} drops=${b.drops} ppm=${b.ppm.toFixed(1)} fill=${b.out.fill.toFixed(1)}`;
  }},
  {name:'iq: bridge locks to a source clock off by +300 ppm', arg:[chain({mode:'FM', ppm:300}, {mode:'FM'}), RX], fn([g, w]){
    const ns = T.build(g, w);
    T.run(20);
    const b = ns[4];
    const ok = b.starves === 0 && b.drops === 0 && Math.abs(b.ppm-300) < 60;
    return ok || `starves=${b.starves} drops=${b.drops} ppm=${b.ppm.toFixed(1)} fill=${b.out.fill.toFixed(1)}`;
  }},
  {name:'iq: decimator output does not depend on chunking', fn(){
    const mk = () => { const n = {p:{M:'8', cut:.4, tpp:'16'}}; MOD.iqDecim.init(n); return n; };
    const L = 5000, re = new Float32Array(L), im = new Float32Array(L);
    for(let i=0; i<L; i++){ re[i] = Math.cos(i*0.01)+0.3*Math.cos(i*1.3); im[i] = Math.sin(i*0.01); }
    const run = (n, sizes) => {
      const out = []; let p = 0, k = 0;
      while(p < L){
        const s = {sr:80000, fc:0, chunks:[], t:0};
        const c = Math.min(sizes[k++ % sizes.length], L-p);
        if(c > 0) s.chunks.push({re:re.subarray(p, p+c), im:im.subarray(p, p+c), t0:p, tag:null});
        p += c;
        const o = MOD.iqDecim.process(n, {in:s}).out;
        for(const ch of o.chunks) for(let i=0; i<ch.re.length; i++) out.push(ch.re[i], ch.im[i]);
      }
      return out;
    };
    const a = run(mk(), [L]), b = run(mk(), [3, 0, 17, 1, 250, 0, 7]);
    if(a.length !== b.length) return `lengths ${a.length} vs ${b.length}`;
    if(a.length !== 2*Math.ceil(L/8)) return `count ${a.length/2}, expected ${Math.ceil(L/8)}`;
    let d = 0; for(let i=0; i<a.length; i++) d = Math.max(d, Math.abs(a[i]-b[i]));
    return d < 1e-6 || `max diff ${d}`;
  }},
  {name:'iq: spectrum peak at fc + offset', fn(){
    const ns = T.build([['iqGen', {sr:'1024000', fc:145e6, off:-123000, mode:'carrier', noise:-80}], ['iqSpec', {size:'4096'}]],
      ['0.iq>1.in']);
    T.run(0.5);
    const sp = ns[1].out.spec; if(!sp) return 'no spectrum';
    let k = 0; for(let i=1; i<sp.mag.length; i++) if(sp.mag[i] > sp.mag[k]) k = i;
    const db = 20*Math.log10(sp.mag[k]);
    return Math.abs(sp.freqs[k]-(145e6-123000)) <= 250 && Math.abs(db+20) < 2 || `peak ${sp.freqs[k]} Hz, ${db.toFixed(1)} dB`;
  }},
  {name:'iq: USB SDR iq output (IQ file playback) → FM chain', async fn(){
    // cu8, 1.024 MS/s, NFM ±3 кГц тоном 1 кГц на +100 кГц; частота и скорость — из имени файла
    const sr = 1024000, L = sr*3, u8 = new Uint8Array(2*L);
    let ph = 0;
    for(let i=0; i<L; i++){
      ph += 2*Math.PI*(100000 + 3000*Math.sin(2*Math.PI*1000*i/sr))/sr;
      u8[2*i] = Math.round(127.5+60*Math.cos(ph)); u8[2*i+1] = Math.round(127.5+60*Math.sin(ph));
    }
    const file = new File([u8], 'test_100000000Hz_1.024Msps.cu8');
    const ns = T.build([['rtlsdr', {sr:'1024000'}], ['iqShift', {}], ['iqDecim', {M:'16'}], ['iqDemod', {mode:'FM', dev:3000}], ['iqAudio', {}],
      ['const', {v:100.1e6}]], ['0.iq>1.in', '1.out>2.in', '2.out>3.in', '3.out>4.in', '5.out>1.freq']);
    const rx = ns[0];
    const src = await iqParseFiles([file], 'auto');
    const dev = iqFileDevice(src, 1024000, 100000000);
    dev.onFreq = f => { rx.actualFreq = f; rx.p.freq = f; rx.appliedFreq = f; };
    rx.p.freq = await dev.setCenterFrequency(); rx.dev = dev;
    await rtlStart(rx, dev.rate);
    // в реальном времени: файл читается по часам, граф — по мере прошедшего времени
    const a = []; let t0 = performance.now(), done = 0;
    while(performance.now()-t0 < 2500){
      await new Promise(r => setTimeout(r, 10));
      const need = Math.floor((performance.now()-t0)/1000*Eng.sr/BLOCK);
      for(; done<need; done++){
        for(const nd of Graph.order) evalNode(nd);
        if(performance.now()-t0 > 1500) a.push(...ns[4].out.out);
      }
    }
    await rtlDisconnect(rx);
    const e = T.errors(); if(e.length) return e.join('; ');
    const f = T.toneHz(Float32Array.from(a), Eng.sr), pk = T.peak(a);
    return Math.abs(f-1000) < 5 && pk > 0.8 && pk < 1.2 || `f=${f.toFixed(2)} peak=${pk.toFixed(3)} fs=${ns[4].state}`;
  }},
];
