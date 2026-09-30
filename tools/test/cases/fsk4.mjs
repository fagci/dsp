// 4FSK-протоколы (общий приёмник fsk4-kernels.js и плагины): FEC против кода MMDVMHost, генератор → декодер, режимы, автоопределение
// Векторы data/fsk4-vectors.json сняты с классов MMDVMHost (см. ref/README.md).
import {readFileSync} from 'node:fs';
const V = JSON.parse(readFileSync(new URL('../data/fsk4-vectors.json', import.meta.url), 'utf8'));

// iqGen(4FSK) → fskRx; sr, offset, шум, протокол генератора и приёмника
const GEN = (sr, off, noise, fsk4, proto) => [[['iqGen', {sr, fc:851e6, mode:'4FSK', off, lvl:-20, noise, fsk4}], ['fskRx', {proto:proto||'auto'}]], ['0.iq>1.in']];

export function setup(){
  const unhex = s => Uint8Array.from(s.match(/../g), h => parseInt(h, 16));
  window.fskUnhex = unhex;
  window.fskHex = a => Array.from(a, x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  // байты вектора → дибиты кадра (pre — число нулевых дибитов перед ними)
  window.fskDib = (h, pre) => { const d = fsk4Dib(dmrBitsOf(unhex(h))); return pre ? p25Cat(new Uint8Array(pre), d) : d; };
  // как dmrRun: блоки по 0.5 с в цепочку, записи всех выходов; conj — инвертированный спектр; ppm — уход тактовой частоты приёмника
  window.fskRun = (ns, sec, opt) => {
    opt = opt || {};
    const recs = [], voice = [], n = Math.ceil(sec*Eng.sr/BLOCK);
    for(let b=0; b<n; b++){
      for(const o of Eng.outs) o.fill(0);
      evalNode(ns[0]);
      const s = ns[0].out.iq;
      if(opt.conj) for(const c of s.chunks) for(let i=0; i<c.im.length; i++) c.im[i] = -c.im[i];
      if(opt.ppm) s.sr = s.sr*(1+opt.ppm*1e-6);
      evalNode(ns[1]);
      Eng.blocks++;
      if(ns[1].out.rec) recs.push(...ns[1].out.rec);
      if(ns[1].out.voice) voice.push(...ns[1].out.voice);
    }
    return {recs, voice, ui:ns[1].ui};
  };
  // тот же xorshift, что в генераторе P25: ожидаемые кадры IMBE
  window.p25Rnd = () => { let x = 0x1234567; return () => { x ^= x<<13; x ^= x>>>17; x ^= x<<5; return x & 255; }; };
  window.p25Check = (r, ctl, noisy) => {
    const k = x => r.recs.filter(q => q.kind === x);
    if(r.ui.nac !== 0x293 && r.ui.protos?.p25?.nac !== 0x293) return 'nac '+JSON.stringify(r.ui.nac);
    if(!ctl){
      if(!k('hdu').some(q => q.to === 4321 && q.algid === 0x80 && q.mi === '010203040506070809' && q.mfid === 0)) return 'no HDU: '+JSON.stringify(k('hdu'));
      if(!k('call').some(q => q.from === 1234567 && q.to === 4321 && q.call === 'group' && !q.emergency)) return 'no call: '+JSON.stringify(k('call'));
      if(!k('end').some(q => q.from === 1234567 && q.by === 'TDU' && q.ldu >= 4)) return 'no end: '+JSON.stringify(k('end'));
      if(!k('lsd').some(q => q.lsd === 0x5A)) return 'no LSD: '+JSON.stringify(k('lsd'));
      if(r.voice.length < 36 || r.voice.some(v => v.imbe.length !== 36)) return 'voice frames '+r.voice.length;
      // кадры IMBE — тот же xorshift, что в генераторе: LDU1, LDU2, LDU1, LDU2 по 9 × 18 байт
      const rnd = p25Rnd(), all = Uint8Array.from({length:4*162}, rnd), at = (base, n) => fskHex(all.subarray(base+(n-1)*18, base+n*18));
      // сырые кадры без FEC: при шуме часть бит ошибочна — тогда достаточно, чтобы большинство совпало
      const bad = r.voice.filter(v => ![v.seq === 'LDU1' ? 0 : 162, v.seq === 'LDU1' ? 324 : 486].some(b => at(b, v.n) === v.imbe));
      if(bad.length > (noisy ? r.voice.length*.25 : 0)) return 'IMBE '+bad.length+' of '+r.voice.length+': '+bad[0].seq+' '+bad[0].n+' '+bad[0].imbe;
      return true;
    }
    const t = k('tsbk'), has = (n, f) => t.some(q => q.name === n && f(q));
    if(!has('IDEN_UP', q => q.iden === 1 && q.base === 851012500 && q.step === 12500)) return 'no IDEN_UP: '+JSON.stringify(t);
    if(!has('RFSS_STS_BCST', q => q.sysid === 0x293 && q.rfss === 1 && q.site === 7 && q.freq === 851025000)) return 'no RFSS: '+JSON.stringify(t.filter(q => q.op === 0x3A));
    if(!has('NET_STS_BCST', q => q.wacn === 0xBEE00 && q.sysid === 0x293 && q.freq === 851025000)) return 'no NET_STS: '+JSON.stringify(t.filter(q => q.op === 0x3B));
    if(!has('GRP_V_CH_GRANT', q => q.to === 4321 && q.from === 1234567 && q.freq === 851050000 && q.opts === 0x40)) return 'no grant: '+JSON.stringify(t.filter(q => q.op === 0));
    if(!has('GRP_AFF_RSP', q => q.to === 4321 && q.from === 1234567 && q.gav === 0)) return 'no GRP_AFF_RSP';
    if(!has('SYS_SRV_BCST', q => q.svcAvail === 0x0F0F0F && q.svcSupp === 0x0F0F0F)) return 'no SYS_SRV_BCST';
    if(!t.some(q => q.text.includes('851.05000 MHz'))) return 'channel text';
    return true;
  };
}

export default [
  {name:'p25: MMDVMHost vectors — Golay(18,6,8), NID BCH(63,16), trellis ½, HDU RS(36,20), LDU1/2 LC + ESS RS(24,12) / (24,16), TSBK CRC-16', arg:V, fn(V){
    const D = fskDib;
    for(const [dv, w] of [[0, 0], [9, 0x952D], [0x12, 0x12A59], [0x1B, 0x1BF74], [0x24, 0x24C5A], [0x2D, 0x2D977], [0x36, 0x36603], [0x3F, 0x3F32E]])
      if(P25_G18[dv] !== (w & 0x3FFFF)) return 'golay '+dv+' 0x'+P25_G18[dv].toString(16);
    for(const d of P25_DUIDS){
      const b = fsk4Unpack(p25Data(D(V['nid_'+d.toString(16).toUpperCase()], 24), 24, 32), 0, 32), r = p25NidFind(b, 0);
      if(!r || r.nac !== 0x293 || r.duid !== d) return 'NID duid '+d+' '+JSON.stringify(r);
      if(p25NidBits(0x293, d).join('') !== Array.from(b).join('')) return 'NID bits, duid '+d;
    }
    const dd = D(V.tr12).subarray(0, 98), tr = p25Tr12Dec(dd);
    if(fskHex(tr.bytes) !== V.tsbk_pay || tr.err) return 'trellis decode '+fskHex(tr.bytes);
    if(p25Tr12Enc(fskUnhex(V.tsbk_pay)).join('') !== Array.from(dd).join('')) return 'trellis encode';
    let w = p25LduWords(D(V.ldu1), 12), f = w && p25Lc(w.bits.subarray(0, 72));
    if(!f || f.type !== 'group' || f.to !== 4321 || f.from !== 1234567 || !f.emergency || f.mfid !== 0) return 'LDU1 group LC '+JSON.stringify(f);
    w = p25LduWords(D(V.ldu1p), 12); f = w && p25Lc(w.bits.subarray(0, 72));
    if(!f || f.type !== 'private' || f.to !== 0x123456 || f.from !== 0xABCDEF) return 'LDU1 private LC '+JSON.stringify(f);
    w = p25LduWords(D(V.ldu2), 16);
    if(!w || fskHex(p25Bytes(w.bits)) !== '01020304050607080981BEEF') return 'LDU2 ESS '+(w && fskHex(p25Bytes(w.bits)));
    const h = p25HduDecode(D(V.hdu));
    if(!h || fskHex(h) !== '010203040506070809908412340BAD') return 'HDU '+(h && fskHex(h));
    const ts = p25Tr12Dec(p25Data(D(V.tsdu), 56, 98));
    if(fskHex(ts.bytes.subarray(0, 10)) !== '82004000000777A1B2C3' || dmrCrc16(ts.bytes, 10) !== ts.bytes[10]*256+ts.bytes[11]) return 'TSBK '+fskHex(ts.bytes);
    const bits = dmrBitsOf(ts.bytes), rec = p25Tsbk({idens:{}}, bits);
    return rec.f.op === 2 && rec.f.lb === 1 || 'TSBK fields '+JSON.stringify(rec.f);
  }},
  {name:'p25: encoders — RS(24,12) / (24,16) / (36,20) up to t errors, NID with 8 bit errors, trellis ½ with a dibit error, Hamming(10,6), LSD cyclic code', fn(){
    let x = 12345; const rnd = n => { x ^= x<<13; x ^= x>>>17; x ^= x<<5; return (x>>>0) % n; };
    for(const [n, k] of [[24, 12], [24, 16], [36, 20]]){
      const t = (n-k)>>1;
      for(let it=0; it<60; it++){
        const d = Uint8Array.from({length:k}, () => rnd(64)), cw = p25RsEnc(d, n), bad = cw.slice();
        const pos = new Set(); while(pos.size < t) pos.add(rnd(n));
        for(const p of pos) bad[p] ^= 1+rnd(63);
        const ec = p25RsDec(bad, k);
        if(ec !== t || bad.join() !== cw.join()) return 'RS('+n+','+k+') '+t+' errors → '+ec;
      }
    }
    for(let it=0; it<150; it++){
      const nac = rnd(4096), duid = P25_DUIDS[rnd(7)], b = p25NidBits(nac, duid), e = new Set(); while(e.size < 8) e.add(rnd(64));
      for(const i of e) b[i] ^= 1;
      const r = p25NidFind(b, 10);
      if(!r || r.nac !== nac || r.duid !== duid) return 'NID '+nac+'/'+duid+' → '+JSON.stringify(r);
    }
    for(let it=0; it<30; it++){
      const b = Uint8Array.from({length:12}, () => rnd(256)); b[10] = 0; b[11] = 0;
      const c = dmrCrc16(b, 10); b[10] = c>>8; b[11] = c&255;
      const e = p25Tr12Enc(b), bad = e.slice();
      bad[rnd(98)] ^= 1+rnd(3);
      const r = p25Tr12Dec(bad);
      if(fskHex(r.bytes) !== fskHex(b)) return 'trellis with a dibit error '+it;
    }
    for(let v=0; v<64; v++){
      const b = new Uint8Array(10); for(let i=0; i<6; i++) b[i] = (v>>(5-i))&1;
      dmrHamEnc(P25_H1063, b, 0);
      const w = b.slice(); w[rnd(10)] ^= 1;
      if(dmrHam(P25_H1063, w, 0) < 0 || w.join() !== b.join()) return 'hamming '+v;
    }
    for(let d=0; d<256; d++){
      const w = (d<<8)|p25LsdPar(d), bad = w ^ (1<<rnd(16));
      if(p25Lsd(w) !== d || (bad !== w && p25Lsd(bad) !== d)) return 'lsd '+d;
    }
    if(p25LsdPar(1) !== 0x39 || p25LsdPar(2) !== 0x72) return 'lsd parity table';
    return true;
  }},
  {name:'p25: generator → decoder, voice (HDU, LDU1/2, LSD, TDU), 256 kS/s, +2 kHz', arg:GEN('256000', 2000, -45, 'P25 voice', 'p25'), fn([g, w]){
    const ns = T.build(g, w), r = fskRun(ns, 4);
    const e = T.errors(); if(e.length) return e.join('; ');
    if(!r.ui.locked && !r.ui.st.frames) return 'ui '+JSON.stringify(r.ui);
    if(r.ui.st.bad > 2) return 'FEC errors '+r.ui.st.bad;
    return p25Check(r);
  }},
  {name:'p25: generator → decoder, control channel (IDEN_UP, RFSS / net status, grant, affiliation, services), three TSDU sizes', arg:GEN('256000', -4000, -45, 'P25 control channel', 'p25'), fn([g, w]){
    const ns = T.build(g, w), r = fskRun(ns, 4);
    const e = T.errors(); if(e.length) return e.join('; ');
    if(r.ui.st.bad > 2) return 'FEC errors '+r.ui.st.bad;
    return p25Check(r, true);
  }},
  {name:'p25: 48 kS/s (no decimation), noise −35 dBFS; inverted spectrum; clock off by +200 / −300 ppm',
   arg:[[GEN('48000', -3000, -35, 'P25 voice', 'p25'), {}], [GEN('256000', 1500, -45, 'P25 voice', 'p25'), {conj:true}],
        [GEN('256000', 0, -45, 'P25 voice', 'p25'), {ppm:200}], [GEN('256000', 0, -45, 'P25 voice', 'p25'), {ppm:-300}]], fn(cfg){
    for(const [[g, w], opt] of cfg){
      const ns = T.build(g, w), r = fskRun(ns, 4, opt);
      const c = p25Check(r, false, true); if(c !== true) return g[0][1].sr+' '+JSON.stringify(opt)+': '+c;
    }
    return true;
  }},
  {name:'p25: noise alone — no lock, no records', arg:GEN('256000', 2000, -45, 'P25 voice', 'p25'), fn([g, w]){
    g[0][1].mode = 'off'; g[0][1].noise = -30;
    const ns = T.build(g, w), r = fskRun(ns, 3);
    return r.recs.length === 0 && r.voice.length === 0 && r.ui.st.frames === 0 || 'records '+r.recs.length+' frames '+r.ui.st.frames;
  }},
];
