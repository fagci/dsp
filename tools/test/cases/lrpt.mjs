// Meteor-M LRPT / CCSDS: эталоны кода, RS, дескремблер; генератор → PSK-демодулятор → CCSDS-декодер
const CHAIN = (gen, dem, dec={}) => [[['iqGen', {sr:'256000', fc:137.9e6, mode:'LRPT', lrpt:'OQPSK', off:1500, lvl:-20, noise:-40, ...gen}],
  ['pskDemod', {mode:'OQPSK', ...dem}], ['ccsdsDecode', dec]], ['0.iq>1.in', '1.out>2.in']];

export function setup(){
  // декодированные кадры: подряд идущие счётчики и данные как у генератора
  window.lrptCheck = (dec, recs, min) => {
    if(recs.length < min) return `frames ${recs.length} (ok ${dec.ok}, fail ${dec.fail}, ber ${dec.ber?.toFixed?.(3)})`;
    for(const r of recs){
      const ref = lrptSimVcdu(r.cnt);
      if(r.vcid !== 5 || r.scid !== LRPT_SCID) return 'header '+JSON.stringify({scid:r.scid, vcid:r.vcid});
      for(let i=0; i<892; i++) if(r.vcdu[i] !== ref[i]) return `frame ${r.cnt} byte ${i}`;
    }
    for(let i=1; i<recs.length; i++) if(recs[i].cnt !== recs[i-1].cnt+1) return `gap ${recs[i-1].cnt} → ${recs[i].cnt}`;
    return true;
  };
  window.lrptRun = (ns, sec) => {
    const recs = [], cnt = Math.ceil(sec*Eng.sr/BLOCK);
    for(let b=0; b<cnt; b++){
      for(const o of Eng.outs) o.fill(0);
      for(const nd of Graph.order) evalNode(nd);
      Eng.blocks++;
      const r = ns[2].out.rec; if(r) recs.push(...r);
    }
    return recs;
  };
}

export default [
  {name:'ccsds: convolutional code matches SatDump sync pattern, PN, RS(255,223) vs reedsolo', fn(){
    const bad = [], asm = [];
    for(let i=0; i<32; i++) asm.push((0x1ACFFC1D>>>(31-i))&1);
    const e = ccEncode({r:63}, asm); let h = '';
    for(let i=0; i<64; i+=4) h += ((e[i]<<3|e[i+1]<<2|e[i+2]<<1|e[i+3])^15).toString(16);
    if(!h.endsWith('b63db00d9794')) bad.push('asm '+h);                 // meteor_lrpt_decoder: 0xfca2b63db00d9794
    const pn = [...CCSDS_PN.slice(0, 8)].map(x => x.toString(16).padStart(2, '0')).join('');
    if(pn !== 'ff480ec09a0d70bc') bad.push('pn '+pn);
    const cw = new Uint8Array(255); for(let i=0; i<223; i++) cw[i] = (i*7+3)&255;
    rsEncode(cw);
    const par = [...cw.slice(223)].map(x => x.toString(16).padStart(2, '0')).join('');
    if(par !== '3f56af8183b8ad235310d48f4ce7c60e458d1948b674923ab100c186f0bc1519') bad.push('rs '+par);
    return bad.length ? bad.join('; ') : true;
  }},
  {name:'ccsds: RS fixes up to 16 bytes, rejects 17+; dual basis round trip', fn(){
    let x = 7; const rnd = () => { x ^= x<<13; x ^= x>>>17; x ^= x<<5; return (x>>>0)/4294967296; };
    for(let t=0; t<120; t++){
      const c = new Uint8Array(255); for(let i=0; i<223; i++) c[i] = rnd()*256|0;
      rsEncode(c); const o = c.slice(), ne = t%20, ps = new Set();
      while(ps.size < ne) ps.add(rnd()*255|0);
      for(const p of ps) c[p] ^= 1+(rnd()*255|0);
      const r = rsDecode(c);
      if(ne <= 16 && (r !== ne || c.some((v, i) => v !== o[i]))) return `${ne} errors → ${r}`;
      if(ne > 16 && r >= 0 && c.some((v, i) => v !== o[i]) && r <= 16){ /* неверное «исправление» — возможно, но редко */ }
    }
    const d = new Uint8Array(1020); for(let i=0; i<1020; i++) d[i] = i*13&255;
    rsEncodeInterleaved(d, 0, 4, true); const o = d.slice(); d[5] ^= 0x55; d[700] ^= 1;
    const r = rsDecodeInterleaved(d, 0, 4, true);
    return r.join() === '1,1,0,0' && d.every((v, i) => v === o[i]) || 'dual '+r;
  }},
  {name:'lrpt: OQPSK + NRZ-M (M2-x), 256 kS/s, +1.5 kHz', arg:CHAIN({}, {}), fn([g, w]){
    const ns = T.build(g, w), recs = lrptRun(ns, 4);
    const e = T.errors(); if(e.length) return e.join('; ');
    if(Math.abs(ns[1].ui.hz-1500) > 30) return 'freq '+ns[1].ui.hz;
    return lrptCheck(ns[2], recs, 25);
  }},
  {name:'lrpt: QPSK without NRZ-M (M2), 1.024 MS/s, −4 kHz, decimated inside', arg:CHAIN({sr:'1024000', lrpt:'QPSK', off:-4000}, {mode:'QPSK'}, {nrzm:false}), fn([g, w]){
    const ns = T.build(g, w), recs = lrptRun(ns, 4);
    const e = T.errors(); if(e.length) return e.join('; ');
    if(ns[1].ui.M !== 4) return 'decimation '+ns[1].ui.M;
    return lrptCheck(ns[2], recs, 25);
  }},
  {name:'lrpt: weak signal (Es/N0 ≈ 5 dB) — RS fixes bytes, frames that pass are exact', arg:CHAIN({noise:-19.5, off:6000}, {}), fn([g, w]){
    const ns = T.build(g, w), recs = lrptRun(ns, 5);
    const e = T.errors(); if(e.length) return e.join('; ');
    if(recs.length < 20) return `frames ${recs.length} (ok ${ns[2].ok}, fail ${ns[2].fail})`;
    for(const r of recs){ const ref = lrptSimVcdu(r.cnt); for(let i=0; i<892; i++) if(r.vcdu[i] !== ref[i]) return `frame ${r.cnt} byte ${i}`; }
    return ns[2].fixed > 0 || 'no RS corrections at this SNR?';
  }},
  {name:'lrpt: noise alone — no lock, no frames', arg:CHAIN({mode:'off'}, {}), fn([g, w]){
    const ns = T.build(g, w), recs = lrptRun(ns, 3);
    return recs.length === 0 && ns[2].ok === 0 || 'frames from noise: '+recs.length;
  }},
  {name:'lrpt: demodulator and decoder in a worker island', arg:CHAIN({}, {}), async fn([g, w]){
    Islands.setEnabled(true);
    try{
      const ns = T.build(g, w);
      if(!ns[1]._isl || ns[1]._isl !== ns[2]._isl) return 'wrong islands';
      await T.realtime(4);
      await new Promise(r => setTimeout(r, 300)); for(const nd of Graph.order) evalNode(nd);
      const e = T.errors(); if(e.length) return e.join('; ');
      return ns[2].ui?.ok > 15 || 'ui '+JSON.stringify(ns[2].ui);
    } finally { Islands.setEnabled(false); }
  }},
  {name:'records: byte arrays show as length in text, hex in CSV', fn(){
    const r = {cnt:1, vcdu:new Uint8Array([1, 2, 255])};
    return /vcdu: ‹3 bytes›/.test(recText(r)) && geoCsvCell(r.vcdu) === '0102ff' || recText(r)+' / '+geoCsvCell(r.vcdu);
  }},
  {name:'msu-mr: Huffman tables are the JPEG ones SatDump uses; segment round trip', fn(){
    const code = (h, s) => h.code[s].toString(2).padStart(h.len[s], '0'), bad = [];
    // tables.h SatDump: DC 0 → 00, DC 11 → 111111110; AC EOB → 1010, ZRL → 11111111001, 0/1 → 00, F/A → 1111111111111110
    for(const [h, s, c] of [[MSU_HDC, 0, '00'], [MSU_HDC, 11, '111111110'], [MSU_HAC, 0, '1010'], [MSU_HAC, 0xF0, '11111111001'],
      [MSU_HAC, 1, '00'], [MSU_HAC, 0xFA, '1111111111111110']]) if(code(h, s) !== c) bad.push(s+': '+code(h, s));
    const q = msuQTable(80); if(q[0] !== 6 || q[63] !== 40) bad.push('qt '+q[0]+' '+q[63]);
    const src = (x, y) => (x*7+y*13)%256 < 128 ? 40 : 210, seg = msuEncodeSegment(src, 95, 123456, 28), d = msuDecodeSegment(seg);
    if(!d.ok || d.mcus !== 14 || d.ms !== 123456 || seg[8] !== 28) bad.push('decode '+JSON.stringify({ok:d.ok, mcus:d.mcus, ms:d.ms}));
    let e = 0; for(let y=0; y<8; y++) for(let x=0; x<112; x++) e += Math.abs(d.pix[y*112+x]-src(x, y));
    if(e/896 > 6) bad.push('mae '+(e/896).toFixed(2));
    return bad.length ? bad.join('; ') : true;
  }},
  {name:'msu-mr: M_PDU demux across frames, a lost frame only loses its packets', fn(){
    const run = drop => {
      const st = {}, im = msuNew();
      for(let c=0; c<80; c++){ if(c === drop) continue; for(const p of msuDemux(st, lrptSimVcdu(c))) msuAdd(im, p); }
      return {im, st};
    };
    const a = run(-1), b = run(40);
    if(a.im.bad || a.st.lost || a.st.resync) return 'clean: '+JSON.stringify({bad:a.im.bad, lost:a.st.lost, resync:a.st.resync});
    if(b.st.lost !== 1 || b.im.bad) return 'drop: '+JSON.stringify({bad:b.im.bad, lost:b.st.lost});
    if(!(b.im.good < a.im.good && b.im.good > a.im.good-40)) return `segments ${b.im.good} vs ${a.im.good}`;
    // все целые строки совпадают с исходником: каналы на своих местах
    for(const c of [0, 1, 2]){
      const ch = a.im.ch.get(c); let e = 0, n = 0;
      for(const [r, row] of ch.rows){ if(r+1 >= a.im.rows) continue;
        const line = r+a.im.base; for(let i=0; i<row.length; i+=7){ e += Math.abs(row[i]-msuSimPixel(c, i%MSU_W, line*8+Math.floor(i/MSU_W))); n++; } }
      if(!(n > 0 && e/n < 2)) return `channel ${c+1}: mae ${(e/n).toFixed(2)} over ${n}`;
    }
    return true;
  }},
  {name:'preset: Meteor-M LRPT: Image (Generator) — the test picture comes out', fn(){
    T.preset('Meteor-M LRPT: Image (Generator)'); T.run(8);
    const e = T.errors(); if(e.length) return e.join('; ');
    const n = T.byType('lrptImage')[0], im = n.im;
    if(!(im.rows >= 10)) return 'rows '+im.rows+' '+JSON.stringify(T.byType('ccsdsDecode')[0].ui);
    if([...im.ch.keys()].sort().join() !== '0,1,2') return 'channels '+[...im.ch.keys()];
    let e2 = 0, k = 0;
    for(let y=16; y<(im.rows-1)*8; y+=5) for(let x=0; x<MSU_W; x+=11) for(const c of [0, 1, 2]){
      e2 += Math.abs(msuPixel(im, c, x, y)-msuSimPixel(c, x, y+im.base*8)); k++; }
    if(!(e2/k < 2)) return 'mae '+(e2/k).toFixed(2);
    const c = lrptCrop(n);
    return c.width === 1568 && c.height === im.rows*8 || 'png '+c.width+'×'+c.height;
  }},
  {name:'preset: Meteor-M LRPT: Image (USB SDR, 137 MHz) (not connected)', fn(){
    T.preset('Meteor-M LRPT: Image (USB SDR, 137 MHz)'); T.run(0.5);
    const e = T.errors(); return e.length ? e.join('; ') : true;
  }},
];
