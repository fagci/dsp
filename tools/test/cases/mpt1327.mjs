// MPT 1327: CRC-15, кодовые слова, генератор → декодер
const GEN = (sr, off, noise) => [[['iqGen', {sr, fc:160e6, mode:'MPT1327', off, lvl:-20, noise}], ['mpt1327Rx', {}]], ['0.iq>1.in']];

export function setup(){
  window.mptRun = (ns, sec) => {
    const recs = [], n = Math.ceil(sec*Eng.sr/BLOCK);
    for(let b=0; b<n; b++){
      for(const o of Eng.outs) o.fill(0);
      for(const nd of Graph.order) evalNode(nd);
      Eng.blocks++;
      if(ns[1].out.rec) recs.push(...ns[1].out.rec);
    }
    return recs;
  };
  // слова совпадают с теми, что шлёт генератор: сообщение k — адрес PFIX 5+k%3, IDENT 1000+37k%3000
  window.mptCheckRecs = recs => {
    const addr = recs.filter(r => r.kind === 'address');
    for(const r of addr){
      if(r.chan !== 'control') return 'chan '+r.chan;
      if(r.pfix < 5 || r.pfix > 7 || r.ident < 1000 || r.ident >= 4000) return 'fields '+JSON.stringify(r);
    }
    return true;
  };
}

export default [
  {name:'mpt1327: CRC-15/MPT1327 check value, encode → check, single-bit error rejected', fn(){
    const s = '123456789', c = mptCrcBits(i => (s.charCodeAt(i>>3) >> (7-(i&7))) & 1, 72);
    if(c !== 0x2566) return 'crc 0x'+c.toString(16);
    const b48 = new Uint8Array(48); b48[0] = 1; for(let i=1; i<48; i++) b48[i] = (i*7+3)%5 < 2 ? 1 : 0;
    const w = mptEncode(b48);
    let w1 = 0, w0 = 0;
    for(let i=0; i<32; i++) w1 = (w1*2+w[i]) >>> 0;
    for(let i=32; i<64; i++) w0 = (w0*2+w[i]) >>> 0;
    if(!mptCheck(w1, w0)) return 'valid word rejected';
    if(mptField(w1, w0, 0, 1) !== 1) return 'address bit';
    for(const bit of [0, 5, 31]) if(mptCheck((w1 ^ (1 << bit)) >>> 0, w0)) return 'data bit '+bit+' accepted';
    for(const bit of [0, 1, 10]) if(mptCheck(w1, (w0 ^ (1 << bit)) >>> 0)) return 'check bit '+bit+' accepted';
    return true;
  }},
  {name:'mpt1327: generator → decoder, 256 kS/s, +7 kHz', arg:GEN('256000', 7000, -50), fn([g, w]){
    const ns = T.build(g, w), recs = mptRun(ns, 12);
    const e = T.errors(); if(e.length) return e.join('; ');
    const u = ns[1].ui;
    if(!u || u.syncs < 15 || u.addr < 15 || u.data < 5) return 'ui '+JSON.stringify(u);
    if(u.inv || u.chan !== 'control') return 'polarity/chan '+u.inv+' '+u.chan;
    return mptCheckRecs(recs);
  }},
  {name:'mpt1327: 48 kS/s (no decimation), noise −35 dBFS', arg:GEN('48000', -3000, -35), fn([g, w]){
    const ns = T.build(g, w), recs = mptRun(ns, 12);
    const u = ns[1].ui;
    if(!u || u.addr < 10) return 'ui '+JSON.stringify(u);
    return mptCheckRecs(recs);
  }},
  {name:'mpt1327: 1.024 MS/s', arg:GEN('1024000', -6000, -50), fn([g, w]){
    const ns = T.build(g, w), recs = mptRun(ns, 12);
    const u = ns[1].ui;
    if(!u || u.addr < 10) return 'ui '+JSON.stringify(u);
    return mptCheckRecs(recs);
  }},
  {name:'mpt1327: noise alone — no codewords', arg:GEN('256000', 0, -30), fn([g, w]){
    g[0][1].mode = 'off';
    const ns = T.build(g, w); mptRun(ns, 20);
    return ns[1].ui.words === 0 || 'words '+ns[1].ui.words;
  }},
  {name:'preset: MPT 1327: Control Channel (Generator)', fn(){
    T.preset('MPT 1327: Control Channel (Generator)'); T.run(12);
    const e = T.errors(); if(e.length) return e.join('; ');
    const log = T.byType('recLog')[0];
    return log.rows.length >= 10 && mptCheckRecs(log.rows) === true || 'rows '+log.rows.length+' '+mptCheckRecs(log.rows);
  }},
];
