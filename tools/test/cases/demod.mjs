// Демодуляция блоками (всё, что умел встроенный демодулятор USB SDR)
const RX = (gen, chain) => {
  const nodes = [['iqGen', {sr:'1024000', fc:100e6, off:100000, lvl:-20, noise:-80, tone:1000, ...gen}], ['iqShift', {offset:100000}], ...chain];
  const wires = []; for(let i=0; i<nodes.length-1; i++) wires.push(`${i}.${i===0 ? 'iq' : 'out'}>${i+1}.in`);
  return [nodes, wires];
};

export function setup(){
  // сигнал порта за sec секунд после прогрева skip
  window.grab = (n, port, sec, skip) => {
    T.run(skip); const a = [];
    for(let b=0; b<Math.ceil(sec*Eng.sr/BLOCK); b++){ for(const nd of Graph.order) evalNode(nd); a.push(...n.out[port]); }
    return Float32Array.from(a);
  };
  window.goertzel = (a, f, sr) => {
    const w = 2*Math.PI*f/sr, c = 2*Math.cos(w); let s1 = 0, s2 = 0;
    for(const v of a){ const s = v+c*s1-s2; s2 = s1; s1 = s; }
    return Math.sqrt(s1*s1+s2*s2-c*s1*s2)*2/a.length;          // амплитуда тона
  };
}

export default [
  {name:'demod: WFM stereo — separation, RDS name, pilot lock', arg:RX({mode:'WFM stereo', ps:'DSP TEST'},
      [['iqDecim', {M:'4', cut:.45}], ['iqDemod', {mode:'WFM', deemph:'off'}], ['iqAudio', {}]]), fn([g, w]){
    const ns = T.build(g, w);
    ns[4].p.stereo = true;
    Graph.edges.find(e => e.from===ns[3].id).fp = 'stereo'; retopo();
    const L = grab(ns[4], 'out', 1, 2), R = ns[4].out.q;           // R — только последний блок; меряем L и отдельно R ниже
    const r = [];
    for(let b=0; b<Math.ceil(Eng.sr/BLOCK); b++){ for(const nd of Graph.order) evalNode(nd); r.push(...ns[4].out.q); }
    const aL = goertzel(L, 1000, Eng.sr), aR = goertzel(Float32Array.from(r), 1000, Eng.sr), sep = 20*Math.log10(aL/aR);
    const d = ns[3];
    const ok = Math.abs(aL-0.9) < 0.05 && sep > 25 && d.out.ps === 'DSP TEST' && d.out.pilot === 1 && d.ui.ar >= 40000;
    return ok || `L ${aL.toFixed(3)}, separation ${sep.toFixed(1)} dB, ps ${JSON.stringify(d.out.ps)}, pilot ${d.out.pilot}, ar ${d.ui.ar}`;
  }},
  {name:'demod: WFM mono when stereo is off', arg:RX({mode:'WFM stereo'},
      [['iqDecim', {M:'4', cut:.45}], ['iqDemod', {mode:'WFM', deemph:'off', stereo:false}], ['iqAudio', {}]]), fn([g, w]){
    const ns = T.build(g, w);
    Graph.edges.find(e => e.from===ns[3].id).fp = 'stereo'; retopo();
    const L = grab(ns[4], 'out', 1, 2), aL = goertzel(L, 1000, Eng.sr);
    return Math.abs(aL-0.45) < 0.03 || `L ${aL.toFixed(3)} (mono = (L+R)/2·0.9)`;
  }},
  {name:'demod: SAM locks to a carrier 20 Hz off, both / USB / LSB', arg:RX({mode:'AM', depth:.5, tone:700},
      [['iqDecim', {M:'16'}], ['iqDemod', {mode:'SAM', samSb:'both'}], ['iqAudio', {}]]), fn([g, w]){
    const ns = T.build(g, w);
    ns[1].p.offset = 99980;                                        // несущая на +20 Гц в канале
    const res = [];
    for(const sb of ['both', 'USB', 'LSB']){
      ns[3].p.samSb = sb;
      const a = grab(ns[4], 'out', 1, 1.5), f = T.toneHz(a, Eng.sr), amp = goertzel(a, 700, Eng.sr);
      res.push(`${sb}: ${f.toFixed(1)} Hz ${amp.toFixed(3)} lock ${ns[3].out.lock} (${ns[3].ui.hz.toFixed(1)} Hz)`);
      if(!(Math.abs(f-700) < 1 && Math.abs(amp-0.5) < 0.05 && ns[3].out.lock === 1 && Math.abs(ns[3].ui.hz-20) < 2)) return res.join('; ');
    }
    return true;
  }},
  {name:'demod: SSB AGC brings a weak signal up to ~0.3', arg:RX({mode:'USB', lvl:-50, tone:1200},
      [['iqDecim', {M:'16'}], ['iqDemod', {mode:'USB'}], ['iqAudio', {}]]), fn([g, w]){
    const ns = T.build(g, w);
    const on = T.peak(grab(ns[4], 'out', 1, 1.5));
    ns[3].p.agc = false;
    const off = T.peak(grab(ns[4], 'out', 1, 0.5));
    return on > 0.25 && on < 0.35 && off < 0.01 || `AGC on ${on.toFixed(3)}, off ${off.toFixed(4)}`;
  }},
  {name:'demod: FM with 50 µs de-emphasis rolls off highs', arg:RX({mode:'FM', dev:3000, tone:3000},
      [['iqDecim', {M:'16'}], ['iqDemod', {mode:'FM', dev:3000, deemph:'50 µs'}], ['iqAudio', {}]]), fn([g, w]){
    const ns = T.build(g, w);
    const a = goertzel(grab(ns[4], 'out', 1, 0.5), 3000, Eng.sr), exp = 1/Math.hypot(1, 2*Math.PI*3000*50e-6);
    return Math.abs(a-exp) < 0.03 || `3 kHz at ${a.toFixed(3)}, expected ${exp.toFixed(3)}`;
  }},
  {name:'nb: impulses blanked, clean signal passes', fn(){
    const n = {p:{level:'mid'}}; IQK.iqNb.init(n);
    const sr = 1000000, L = sr/2, re = new Float32Array(L), im = new Float32Array(L);
    let x = 7; const rnd = () => { x ^= x<<13; x ^= x>>>17; x ^= x<<5; return (x>>>0)/4294967296-0.5; };
    let clean = 0;
    for(let i=0; i<L; i++){ re[i] = 0.05*rnd(); im[i] = 0.05*rnd(); clean += re[i]*re[i]+im[i]*im[i];
      if(i%10000 < 5 && i > 20000){ re[i] += 0.9; im[i] -= 0.9; } }
    let inp = 0; for(let i=0; i<L; i++) inp += re[i]*re[i]+im[i]*im[i];
    const o = IQK.iqNb.process(n, {in:{sr, fc:0, chunks:[{re, im, t0:0, tag:null}]}}).out;
    let out = 0; for(const c of o.chunks) for(let i=0; i<c.re.length; i++) out += c.re[i]*c.re[i]+c.im[i]*c.im[i];
    const inDb = 10*Math.log10(inp/clean), outDb = 10*Math.log10(out/clean);
    return inDb > 3 && Math.abs(outDb) < 0.1 && n.ui.pct < 2 || `impulses +${inDb.toFixed(1)} dB, after NB ${outDb.toFixed(2)} dB, blanked ${n.ui.pct.toFixed(2)}%`;
  }},
  {name:'squelch: opens on a carrier, closes after hang', arg:RX({mode:'FM', lvl:-30, noise:-70},
      [['iqDecim', {M:'16'}], ['iqSquelch', {mode:'SNR', thr:10, hang:300}]]), fn([g, w]){
    const ns = T.build(g, w), sq = ns[3], gen = ns[0];
    gen.p.mode = 'off'; T.run(1.5);
    const quiet = sq.out.open;
    gen.p.mode = 'FM'; T.run(0.3);
    const on = sq.out.open, snr = sq.out.snr;
    gen.p.mode = 'off'; T.run(0.15);
    const hang = sq.out.open; T.run(0.5);
    const off = sq.out.open;
    return quiet===0 && on===1 && snr > 30 && hang===1 && off===0 || `quiet ${quiet}, on ${on} (SNR ${snr?.toFixed(1)}), in hang ${hang}, after ${off}`;
  }},
  {name:'dc block: offset removed', fn(){
    const n = {p:{fc:150}}; IQK.iqDc.init(n);
    const L = 100000, re = new Float32Array(L).fill(0.3), im = new Float32Array(L).fill(-0.2);
    const o = IQK.iqDc.process(n, {in:{sr:250000, fc:0, chunks:[{re, im, t0:0, tag:null}]}}).out.chunks[0];
    return Math.abs(o.re[L-1]) < 1e-4 && Math.abs(o.im[L-1]) < 1e-4 || `left ${o.re[L-1]}, ${o.im[L-1]}`;
  }},
  {name:'iq merge: I/Q signals → stream, swap', arg:[[['osc', {freq:3000, amp:.5}], ['hilbert', {}], ['iqMerge', {fc:7e6}], ['iqSpec', {size:'1024', upd:20}]],
      ['0.out>1.in', '1.I>2.I', '1.Q>2.Q', '2.iq>3.in']], fn([g, w]){
    const ns = T.build(g, w);
    T.run(0.3);
    const pk = sp => { let k = 0; for(let i=1; i<sp.mag.length; i++) if(sp.mag[i] > sp.mag[k]) k = i; return sp.freqs[k]; };
    const f1 = pk(ns[3].out.spec);
    ns[2].p.swap = true; T.run(0.3);
    const f2 = pk(ns[3].out.spec);
    const bin = Eng.sr/1024;
    return Math.abs(f1-(7e6+3000)) < bin && Math.abs(f2-(7e6-3000)) < bin && ns[2].out.iq.sr === Eng.sr || `peaks ${f1}, ${f2}`;
  }},
  {name:'anf: steady tone removed, noise passes', arg:[[['osc', {freq:1000, amp:.3}], ['osc', {wave:'noise', amp:.1}], ['sum', {ka:1, kb:1}], ['anf', {}]],
      ['0.out>2.a', '1.out>2.b', '2.out>3.in']], fn([g, w]){
    const ns = T.build(g, w);
    T.run(2);
    const a = grab(ns[3], 'out', 1, 0), inp = grab(ns[2], 'out', 1, 0);
    const tIn = goertzel(inp, 1000, Eng.sr), tOut = goertzel(a, 1000, Eng.sr), red = 20*Math.log10(tIn/tOut);
    const nIn = T.rms(inp), nOut = T.rms(a);
    return red > 20 && nOut > 0.5*Math.sqrt(nIn*nIn-0.045) || `tone −${red.toFixed(1)} dB, rms ${nIn.toFixed(3)} → ${nOut.toFixed(3)}`;
  }},
];
