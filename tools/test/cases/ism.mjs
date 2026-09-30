// ISM 433: анализатор импульсов, протоколы, генератор → декодер (OOK, FSK), шум
const GEN = (sr, off, noise, ism='OOK') => [[['iqGen', {sr, fc:433920000, mode:'ISM433', ism, off, lvl:-20, noise}], ['ismRx', ism==='FSK' ? {mod:'FSK'} : {}]], ['0.iq>1.in']];

export function setup(){
  window.ismRun = (ns, sec) => {
    const recs = [], n = Math.ceil(sec*Eng.sr/BLOCK);
    for(let b=0; b<n; b++){
      for(const o of Eng.outs) o.fill(0);
      for(const nd of Graph.order) evalNode(nd);
      Eng.blocks++;
      if(ns[1].out.rec) recs.push(...ns[1].out.rec);
    }
    return recs;
  };
  // цепочка импульсов из сегментов генератора: без тишины, с дрожанием длительностей
  window.ismPulses = (k, jit) => {
    let x = 12345 + k;
    const rnd = () => { x = (x*1103515245 + 12345) & 0x7FFFFFFF; return x/0x7FFFFFFF; };
    const seg = ismTelegram(k).filter(s => s[0] !== 2), E = seg.map(s => s[1]*(1 + jit*(2*rnd()-1)));
    if(seg[0][0] !== 1 || seg[seg.length-1][0] !== 1) E.length = 0;
    return E;
  };
  // сообщения k=3v (Nexus) и k=3v+1 (EV1527) совпадают с генератором
  window.ismCheck = recs => {
    let nx = 0, ev = 0, un = 0;
    for(const r of recs){
      if(r.proto === 'Nexus'){
        let ok = false;
        for(let v=0; v<60 && !ok; v++){
          const t = ((v%2) ? -35 : 215) + 7*(v%9);
          ok = r.dev === (0x5A+(v%3)).toString(16).toUpperCase() && r.channel === 1+(v%3) && Math.abs(r.temp_c - t/10) < 1e-9 &&
               r.humidity === 40+(v*7)%50 && r.battery_ok === (v%4 ? 1 : 0);
        }
        if(!ok) return 'nexus '+JSON.stringify(r);
        nx++;
      } else if(r.proto === 'EV1527/PT2262'){
        if(r.addr !== 'A5C31' || r.data < 1 || r.data > 15) return 'ev1527 '+JSON.stringify(r);
        ev++;
      } else if(r.kind === 'unknown'){
        if(r.enc !== 'MAN' || r.bitlen !== 48) return 'unknown '+JSON.stringify(r);
        un++;
      } else return 'unexpected '+JSON.stringify(r);
    }
    return {nx, ev, un};
  };
}

export default [
  {name:'ism: Nexus pulse train → fields (also with ±8% timing jitter)', fn(){
    const b = ismNexusBits(0x5A, 1, 2, -35, 47);
    if(b.length !== 36) return 'bits '+b.length;
    for(const jit of [0, .08]){
      const an = ismAnalyze(ismPulses(0, jit), 6000);
      if(!an || an.mod !== 'PPM') return 'analyze '+JSON.stringify(an && an.mod)+' jit '+jit;
      if(an.rows.length !== 5) return 'rows '+an.rows.length+' jit '+jit;
      const d = ismDecode(an);
      if(d.proto !== 'Nexus' || d.dev !== '5A' || d.channel !== 1 || d.humidity !== 40) return JSON.stringify(d);
      if(Math.abs(d.temp_c - 21.5) > 1e-9 || d.battery_ok !== 0 || d.agree !== 5) return JSON.stringify(d);
    }
    return true;
  }},
  {name:'ism: EV1527 pulse train → address, data, trits (also with jitter)', fn(){
    for(const jit of [0, .1]){
      const an = ismAnalyze(ismPulses(1, jit), 8000);
      if(!an || an.mod !== 'PWM' || an.rows.length !== 6) return 'analyze '+(an && an.mod+' rows '+an.rows.length)+' jit '+jit;
      const d = ismDecode(an);
      if(d.proto !== 'EV1527/PT2262' || d.addr !== 'A5C31' || d.data !== 1) return JSON.stringify(d);
      if(d.trits.length !== 12 || d.agree !== 6) return JSON.stringify(d);
    }
    return true;
  }},
  {name:'ism: single repeat and a packet with a lost gap still decode', fn(){
    // один повтор EV1527: пауза только в начале
    let E = ismPulses(1, 0);
    const first = E.findIndex((x, i) => i % 2 === 1 && x > 5000), second = E.findIndex((x, i) => i > first && i % 2 === 1 && x > 5000);
    const one = E.slice(first+1, second-2);           // 24 бита, последний кончается меткой
    one.unshift(E[0], E[1]);
    let d = ismDecode(ismAnalyze(one, 8000));
    if(d.proto !== 'EV1527/PT2262' || d.addr !== 'A5C31') return 'ev single '+JSON.stringify(d);
    // один повтор Nexus (36 бит + синхроимпульс)
    E = ismPulses(0, 0);
    d = ismDecode(ismAnalyze(E.slice(0, 73), 6000));
    if(d.proto !== 'Nexus' || d.humidity !== 40) return 'nexus single '+JSON.stringify(d);
    return true;
  }},
  {name:'ism: Manchester packet is not identified but described (PCM/MAN, T, bits)', fn(){
    const an = ismAnalyze(ismPulses(2, .05), 8000), d = an && ismDecode(an);
    if(!an || an.mod !== 'MAN' || d.kind !== 'unknown') return JSON.stringify(d);
    if(d.bitlen !== 48 || !d.hex.startsWith('00') || Math.abs(an.T-250) > 30) return JSON.stringify(d)+' T '+an.T;
    return true;
  }},
  {name:'ism: noisy NRZ (FSK, no gaps) → PCM bits with the bit period found', fn(){
    let x = 99; const rnd = () => { x = (x*1103515245 + 12345) & 0x7FFFFFFF; return x/0x7FFFFFFF; };
    for(const T of [104, 208, 52]){
      const bits = [1, 0, 1, 0, 1, 0, 1, 0]; for(let i=0; i<120; i++) bits.push(rnd() < .5 ? 1 : 0); bits.push(1, 0);
      const runs = []; let cur = 1, n = 0;
      for(const b of bits){ if(b === cur) n++; else { runs.push(n); cur = b; n = 1; } }
      runs.push(n);
      const E = runs.map(r => r*T + (rnd()-.5)*.3*T);     // ±15% T дрожания краёв
      if(E.length % 2 === 0) E.pop();
      const an = ismAnalyze(E, 8000);
      if(!an || an.mod !== 'PCM') return 'T '+T+': '+(an && an.mod);
      if(Math.abs(an.T/T - 1) > .05) return 'T '+T+' found '+an.T;
      const got = Array.from(an.rows.reduce((a, r) => r.length > a.length ? r : a, an.rows[0]));
      let bad = 0; for(let i=0; i<Math.min(got.length, bits.length); i++) if(got[i] !== bits[i]) bad++;
      if(bad || Math.abs(got.length - bits.length) > 2) return 'T '+T+' bits differ '+bad+' len '+got.length+' vs '+bits.length;
    }
    return true;
  }},
  {name:'ism: random pulses give no packet', fn(){
    let x = 7; const rnd = () => { x = (x*1103515245 + 12345) & 0x7FFFFFFF; return x/0x7FFFFFFF; };
    let found = 0;
    for(let k=0; k<200; k++){
      const E = []; for(let i=0; i<41; i++) E.push(100 + rnd()*3000);
      const an = ismAnalyze(E, 8000);
      if(an && ismDecode(an).kind !== 'unknown') found++;
    }
    return found === 0 || 'false protocol matches '+found;
  }},
  {name:'ism: generator → decoder OOK, 1.024 MS/s, +20 kHz', arg:GEN('1024000', 20000, -50), fn([g, w]){
    const ns = T.build(g, w), recs = ismRun(ns, 12);
    const e = T.errors(); if(e.length) return e.join('; ');
    const c = ismCheck(recs); if(typeof c === 'string') return c;
    if(c.nx < 2 || c.ev < 2 || c.un < 2) return 'counts '+JSON.stringify(c);
    if(!recs.every(r => r.mod === 'OOK' && Math.abs(r.freq - 433940000) < 15000)) return 'freq '+recs[0].freq;
    return true;
  }},
  {name:'ism: 250 kS/s (no decimation) and 2.4 MS/s', arg:[GEN('250000', -10000, -40), GEN('2400000', 30000, -45)], fn(a){
    for(const [g, w] of a){
      const ns = T.build(g, w), recs = ismRun(ns, 12);
      const c = ismCheck(recs); if(typeof c === 'string') return Eng.sr+': '+c;
      if(c.nx < 2 || c.ev < 2) return 'counts '+JSON.stringify(c)+' at '+g[0][1].sr;
    }
    return true;
  }},
  {name:'ism: generator → decoder FSK, 1.024 MS/s', arg:GEN('1024000', 15000, -50, 'FSK'), fn([g, w]){
    const ns = T.build(g, w), recs = ismRun(ns, 12);
    const c = ismCheck(recs); if(typeof c === 'string') return c;
    if(c.nx < 2 || c.ev < 2) return 'counts '+JSON.stringify(c);
    if(!recs.every(r => r.mod === 'FSK')) return 'mod';
    return true;
  }},
  {name:'ism: repeats split by a short packet gap are skipped within the window, all kept with dedup 0', arg:GEN('256000', 0, -50), fn([g, w]){
    const ns = T.build([g[0], ['ismRx', {reset:3000}]], w), a = ismRun(ns, 6), skipped = ns[1].ui.dups;
    const ns2 = T.build([g[0], ['ismRx', {reset:3000, dedup:0}]], w), b = ismRun(ns2, 6);
    if(typeof ismCheck(a) === 'string' || typeof ismCheck(b) === 'string') return 'decode '+ismCheck(a)+' '+ismCheck(b);
    return (skipped > 0 && b.length > a.length) || 'dedup '+a.length+' '+b.length+' skipped '+skipped;
  }},
  {name:'ism: decoder in a worker island, records reach the log', arg:GEN('256000', 5000, -45), async fn([g, w]){
    g.push(['recLog', {}]); w.push('1.rec>2.rec');
    Islands.setEnabled(true);
    try{
      const ns = T.build(g, w);
      if(!ns[1]._isl) return 'not in a worker';
      await T.realtime(6);
      await new Promise(r => setTimeout(r, 300)); for(const nd of Graph.order) evalNode(nd);
      const e = T.errors(); if(e.length) return e.join('; ');
      const c = ismCheck(ns[2].rows);
      return typeof c !== 'string' && c.nx >= 1 && c.ev >= 1 || 'rows '+ns[2].rows.length+' '+JSON.stringify(c);
    } finally { Islands.setEnabled(false); }
  }},
  {name:'ism: noise alone — no packets', arg:GEN('1024000', 0, -30), fn([g, w]){
    g[0][1].mode = 'off';
    const ns = T.build(g, w), recs = ismRun(ns, 20);
    return recs.length === 0 && ns[1].ui.packets === 0 || 'packets '+recs.length+' '+ns[1].ui.packets;
  }},
  {name:'preset: ISM 433: Sensors and Remotes (Generator)', fn(){
    T.preset('ISM 433: Sensors and Remotes (Generator)'); T.run(12);
    const e = T.errors(); if(e.length) return e.join('; ');
    const log = T.byType('recLog')[0], c = ismCheck(log.rows);
    return typeof c !== 'string' && c.nx >= 2 && c.ev >= 2 || 'rows '+log.rows.length+' '+JSON.stringify(c);
  }},
];
