// Inmarsat STD-C: кадр туда-обратно, пакеты и EGC, генератор → BPSK-демодулятор → декодер
const GEN = (off, noise, extra=[]) => [[['iqGen', {sr:'48000', fc:1541.45e6, mode:'STD-C', off, lvl:-20, noise}],
  ['pskDemod', {mode:'BPSK', rate:1200, bw:.02, pull:3000}], ['stdcDecode', {}], ...extra], ['0.iq>1.in', '1.out>2.in']];

export function setup(){
  window.stdcRun = (ns, sec, k=2) => {
    const recs = [], n = Math.ceil(sec*Eng.sr/BLOCK);
    for(let b=0; b<n; b++){
      for(const o of Eng.outs) o.fill(0);
      for(const nd of Graph.order) evalNode(nd);
      Eng.blocks++;
      if(ns[k].out.rec) recs.push(...ns[k].out.rec);
    }
    return recs;
  };
  // сообщения: целые совпадают с исходными, начатые на середине — их концы
  window.stdcCheck = (recs, full) => {
    let whole = 0;
    for(const r of recs){
      const src = STDC_SIM_MSGS[r.seq-0x1200];
      if(!src) return 'seq '+r.seq;
      if(r.text === src) whole++;
      else if(!src.endsWith(r.text)) return 'text '+JSON.stringify(r.text);
      if(r.service !== 'SafetyNET: NAVAREA/METAREA' || r.sat !== 'IOR' || r.les !== 12) return 'meta '+JSON.stringify(r);
    }
    return whole >= full || 'whole messages '+whole+' of '+recs.length;
  };
}

export default [
  {name:'stdc: frame round trip — unique word, permutation, interleaving, code, scrambler', fn(){
    const f = stdcSimFrame(7), sym = stdcEncodeFrame(f), d = stdcDecodeFrame(Float32Array.from(sym));
    const [m, inv] = stdcMatch(k => sym[k]), [mi, ii] = stdcMatch(k => -sym[k]);
    if(m !== 128 || inv || mi !== 128 || !ii) return 'uw '+[m, inv, mi, ii];
    if(!d.bytes.every((v, i) => v === f[i]) || d.ber) return 'bytes/ber '+d.ber;
    // 6% символов с ошибкой — Витерби исправляет
    let x = 11; const rnd = () => { x ^= x<<13; x ^= x>>>17; x ^= x<<5; return (x>>>0)/4294967296; };
    const noisy = Float32Array.from(sym, v => rnd() < .06 ? -v*.3 : v);
    const e = stdcDecodeFrame(noisy);
    return e.bytes.every((v, i) => v === f[i]) && e.ber > .03 || 'noisy ber '+e.ber;
  }},
  {name:'stdc: packets — checksum, Bulletin Board, EGC parts assembled', fn(){
    const q = new Uint8Array([0x7D, 1, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), [a, b] = stdcCrc(q, 0, 14);
    q[12] = a; q[13] = b;
    if(stdcCrc(q, 0, 14).join() !== [a, b].join()) return 'crc';
    const st = stdcState(), msgs = [];
    for(let k=0; k<STDC_SIM_PARTS.length; k++) msgs.push(...stdcParse(st, stdcSimFrame(k)).msgs);
    if(st.badPkt || st.bb?.sat !== 3 || st.bb?.les !== 12 || st.bb?.frame !== STDC_SIM_PARTS.length-1) return 'bb '+JSON.stringify(st.bb)+' bad '+st.badPkt;
    if(msgs.length !== 2 || msgs[0].text !== STDC_SIM_MSGS[0] || msgs[1].text !== STDC_SIM_MSGS[1]) return 'msgs '+JSON.stringify(msgs);
    if(msgs[0].priority !== 'Urgency' || msgs[1].priority !== 'Safety') return 'priority';
    // битая сумма — пакет отброшен
    const f = stdcSimFrame(1); f[20] ^= 1;
    const s2 = stdcState(); stdcParse(s2, f);
    return s2.badPkt === 1 || 'bad packets '+s2.badPkt;
  }},
  {name:'stdc: generator → BPSK demodulator → decoder, +900 Hz', arg:GEN(900, -30), fn([g, w]){
    const ns = T.build(g, w), recs = stdcRun(ns, 40);
    const e = T.errors(); if(e.length) return e.join('; ');
    if(Math.abs(ns[1].ui.hz-900) > 5) return 'freq '+ns[1].ui.hz;
    if(ns[2].frames < 3) return 'frames '+ns[2].frames;
    return stdcCheck(recs, 1);
  }},
  {name:'stdc: weak signal (Es/N0 ≈ 5 dB), −2 kHz', arg:GEN(-2000, -9), fn([g, w]){
    const ns = T.build(g, w), recs = stdcRun(ns, 40);
    if(ns[2].frames < 3) return 'frames '+ns[2].frames+' uw '+ns[2].ui.uw;
    return stdcCheck(recs, 1);
  }},
  {name:'stdc: noise alone — no frames', arg:GEN(0, -20), fn([g, w]){
    g[0][1].mode = 'off';
    const ns = T.build(g, w); stdcRun(ns, 20);
    return ns[2].frames === 0 || 'frames '+ns[2].frames;
  }},
  {name:'stdc: demodulator and decoder in a worker island', arg:GEN(900, -30), async fn([g, w]){
    Islands.setEnabled(true);
    try{
      const ns = T.build(g, w);
      if(!ns[1]._isl || ns[1]._isl !== ns[2]._isl) return 'wrong islands';
      await T.realtime(12);
      await new Promise(r => setTimeout(r, 300)); for(const nd of Graph.order) evalNode(nd);
      const e = T.errors(); if(e.length) return e.join('; ');
      return ns[2].ui?.frames >= 1 || 'ui '+JSON.stringify(ns[2].ui);
    } finally { Islands.setEnabled(false); }
  }},
  {name:'preset: Inmarsat STD-C: EGC Messages (Generator)', fn(){
    T.preset('Inmarsat STD-C: EGC Messages (Generator)'); T.run(40);
    const e = T.errors(); if(e.length) return e.join('; ');
    const log = T.byType('recLog')[0];
    return log.rows.length >= 2 && stdcCheck(log.rows, 1) === true || 'rows '+log.rows.length+' '+stdcCheck(log.rows, 1);
  }},
  {name:'preset: Inmarsat STD-C: EGC Messages (USB SDR, 1.5 GHz) (not connected)', fn(){
    T.preset('Inmarsat STD-C: EGC Messages (USB SDR, 1.5 GHz)'); T.run(.5);
    const e = T.errors(); return e.length ? e.join('; ') : true;
  }},
];
