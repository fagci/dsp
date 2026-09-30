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
  window.nxdnCheck = (r, data, noisy) => {
    const k = x => r.recs.filter(q => q.kind === x);
    if(r.ui.ran !== 5) return 'ran '+r.ui.ran;
    if(data){
      if(!k('msg').some(q => q.msg === 'DCALL_HEADER' && q.from === 777 && q.to === 888 && q.call === 'individual' && q.source === 'UDCH')) return 'no DCALL_HEADER: '+JSON.stringify(k('msg'));
      if(!k('call').some(q => q.from === 42 && q.to === 43 && q.call === 'individual' && q.source === 'FACCH1')) return 'no FACCH1 call: '+JSON.stringify(k('call'));
      return true;
    }
    if(!k('call').some(q => q.from === 1234 && q.to === 4321 && q.call === 'conference' && q.source === 'SACCH' && !q.emergency && !q.cipher)) return 'no call: '+JSON.stringify(k('call'));
    if(!k('end').some(q => q.from === 1234 && q.by === 'TX_REL')) return 'no end: '+JSON.stringify(k('end'));
    if(r.voice.length < 36) return 'voice frames '+r.voice.length;
    // те же 72-битные кадры, что в генераторе: xorshift, старший бит не берём — только младший
    let x = 0x2468ACE; const bit = () => { x ^= x<<13; x ^= x>>>17; x ^= x<<5; return x & 1; };
    const exp = new Set(); for(let i=0; i<18; i++){ const b = Uint8Array.from({length:72}, bit); exp.add(fskHex(p25Bytes(b))); }
    const bad = r.voice.filter(v => !exp.has(v.ambe));
    if(bad.length > (noisy ? r.voice.length*.25 : 0)) return 'AMBE '+bad.length+' of '+r.voice.length+': '+bad[0].ambe;
    return true;
  };
  window.m17Check = (r, pkt, noisy) => {
    const k = x => r.recs.filter(q => q.kind === x);
    if(pkt){
      if(!k('call').some(q => q.from === 'N0CALL' && q.to === 'ECHO' && q.mode === 'packet' && q.can === 1)) return 'no packet LSF: '+JSON.stringify(k('call'));
      if(!k('packet').some(q => q.message === 'Hello from M17' && q.crc === 'ok' && q.proto === 5 && q.bytes === 16)) return 'no packet: '+JSON.stringify(k('packet'));
      return true;
    }
    if(!k('call').some(q => q.from === 'SP5WWP' && q.to === 'W2FBI' && q.mode === 'voice' && q.can === 3 && q.source === 'LSF')) return 'no call: '+JSON.stringify(k('call'));
    if(!k('end').some(q => q.from === 'SP5WWP' && q.by === 'last frame')) return 'no end: '+JSON.stringify(k('end'));
    if(r.voice.length < 20) return 'voice frames '+r.voice.length;
    let x = 0x13579BD; const rnd = () => { x ^= x<<13; x ^= x>>>17; x ^= x<<5; return x & 255; };
    const exp = Array.from({length:12}, () => fskHex(Uint8Array.from({length:16}, rnd)));
    const bad = r.voice.filter(v => exp[v.fn] !== v.codec2);
    if(bad.length > (noisy ? r.voice.length*.25 : 0)) return 'Codec 2 bytes '+bad.length+' of '+r.voice.length+': fn '+bad[0].fn;
    return true;
  };
  window.ysfCheck = (r, vd1, noisy) => {
    const k = x => r.recs.filter(q => q.kind === x);
    if(!k('call').some(q => q.from === 'N0CALL' && q.to === 'CQCQCQ' && q.downlink === 'DOWNLINK' && q.uplink === 'UPLINK' && q.dgid === 7 && q.dtype === (vd1 ? 'V/D mode 1' : 'V/D mode 2'))) return 'no call: '+JSON.stringify(k('call'));
    if(!k('end').some(q => q.by === 'terminator')) return 'no terminator';
    if(r.voice.length < 35) return 'voice blocks '+r.voice.length;
    if(!noisy && r.ui.st.bad > 2) return 'FEC errors '+r.ui.st.bad;
    return true;
  };
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
  {name:'ysf: MMDVMHost frames — FICH (Golay + convolution + CRC-16), header CSD1 / CSD2, V/D mode 2 DCH and VCH; encoders equal', arg:V, fn(V){
    const B = h => dmrBitsOf(fskUnhex(h));
    let r = ysfFichDecode(B(V.ysf_fich_vd2).subarray(40, 240)), f = r && ysfFich(r.f);
    if(!f || f.fi !== 1 || f.fn !== 3 || f.ft !== 6 || f.mr !== 1 || f.dt !== 2 || f.dgid !== 5 || !f.sql) return 'FICH VD2 '+JSON.stringify(f);
    r = ysfFichDecode(B(V.ysf_fich_hdr).subarray(40, 240)); f = r && ysfFich(r.f);
    if(!f || f.fi !== 0 || f.cs !== 2 || f.cm !== 1 || f.bn !== 1 || f.bt !== 2 || f.fn !== 5 || f.ft !== 7 || !f.dev || f.mr !== 2 || f.dt !== 0 || f.dgid !== 18) return 'FICH header '+JSON.stringify(f);
    const hd = B(V.ysf_frame_hdr), d1 = ysfDchDecode(hd, 240, 1), d2 = ysfDchDecode(hd, 312, 1);
    if(!d1 || ysfText(d1.subarray(0, 10)) !== 'CQCQCQ' || ysfText(d1.subarray(10, 20)) !== 'N0CALL') return 'CSD1';
    if(!d2 || ysfText(d2.subarray(0, 10)) !== 'DOWNLINK' || ysfText(d2.subarray(10, 20)) !== 'UPLINK') return 'CSD2';
    const v2 = B(V.ysf_frame_vd2), dd = ysfDchDecode(v2, 240, 2);
    if(!dd || ysfText(dd) !== 'N0CALL') return 'VD2 DCH';
    for(let j=0; j<5; j++) if(fskHex(ysfVch(v2, 240+144*j+40)) !== fskHex(Uint8Array.from({length:13}, (_, i) => j*16+i+1))) return 'VD2 VCH '+j;
    const enc = new Uint8Array(960); enc.set(Uint8Array.from(YSF_SYNC.bits, c => +c)); enc.set(ysfFichEncode(Uint8Array.of(1<<6, (1<<3)|6, 2, 7)), 40);
    ysfDchEncode(ysfPad('N0CALL', 10), 2, enc, 240); for(let j=0; j<5; j++) ysfVchEncode(Uint8Array.from({length:13}, (_, i) => j*16+i+1), enc, 240+144*j+40);
    if(enc.join('') !== Array.from(v2).join('')) return 'V/D mode 2 frame encoder';
    const e2 = new Uint8Array(960); e2.set(Uint8Array.from(YSF_SYNC.bits, c => +c)); e2.set(ysfFichEncode(Uint8Array.of(0, 6, 1, 0)), 40);
    ysfDchEncode(p25Cat(ysfPad('CQCQCQ', 10), ysfPad('N0CALL', 10)), 1, e2, 240); ysfDchEncode(p25Cat(ysfPad('DOWNLINK', 10), ysfPad('UPLINK', 10)), 1, e2, 312);
    if(e2.join('') !== Array.from(hd).join('')) return 'header frame encoder';
    return true;
  }},
  {name:'m17: libm17 frames — LSF, six stream frames (LICH Golay, FN, Codec 2 bytes), packet, BERT: encoders bit for bit; callsigns, CRC-16, decoders', arg:V, fn(V){
    const D = h => Uint8Array.from(h, c => +c), lsf = new Uint8Array(30);
    lsf.set(fskUnhex(V.m17_lsf_dst), 0); lsf.set(fskUnhex(V.m17_lsf_src), 6); lsf.set(fskUnhex(V.m17_lsf_type), 12); lsf.set(fskUnhex(V.m17_lsf_meta), 14); lsf.set(fskUnhex(V.m17_lsf_crc), 28);
    if(m17Crc(lsf, 30) !== 0 || m17Crc(Uint8Array.of(65), 1) !== 0x206E || m17Crc(Uint8Array.from('123456789', c => c.charCodeAt(0)), 9) !== 0x772B) return 'crc';
    if(fskHex(m17CallEnc('AB1CD')) !== '0000009FDD51' || m17CallDec(fskUnhex('0000009FDD51')) !== 'AB1CD' || m17CallDec(lsf.subarray(6, 12)) !== 'SP5WWP' || m17CallDec(lsf.subarray(0, 6)) !== 'W2FBI') return 'callsign';
    const same = (n, mine) => Array.from(mine).join('') === V['m17_'+n] || n+' encoder';
    let r = same('lsf_frame', m17Frame('lsf', m17EncLsf(lsf))); if(r !== true) return r;
    const data = Uint8Array.from({length:16}, (_, i) => 0x10+i);
    for(let c=0; c<6; c++){ r = same('str_'+c, m17Frame('str', m17EncStream(lsf, c, c === 5 ? 0x8005 : 100+c, data))); if(r !== true) return r; }
    const pk = new Uint8Array(26); for(let i=0; i<25; i++) pk[i] = 0x41+i;
    r = same('pkt_0', m17Frame('pkt', m17EncPacket(pk))); if(r !== true) return r;
    const pk2 = new Uint8Array(26); for(let i=0; i<25; i++) pk2[i] = 0x61+i; pk2[25] = 0x80|(7<<2);
    r = same('pkt_1', m17Frame('pkt', m17EncPacket(pk2))); if(r !== true) return r;
    r = same('bert', m17Frame('bert', m17EncBert(Uint8Array.from({length:25}, (_, i) => 0xA5^i)))); if(r !== true) return r;
    // декодеры на кадрах libm17
    const P = {st:{lsf:0, stream:0, packet:0, bert:0, voice:0, calls:0}, recent:[], lich:null, call:null, pkt:null, now:0}, L = {}, out = {recs:[], voice:[]};
    const pay = n => m17Il(m17Rnd(fsk4Unpack(D(V['m17_'+n]), 8, 184)));
    const pr = FSK4.protos.m17;
    if(!pr.decode(P, L, 'lsf', pay('lsf_frame'), out)) return 'LSF not decoded';
    const c = out.recs.find(q => q.kind === 'call');
    if(!c || c.from !== 'SP5WWP' || c.to !== 'W2FBI' || c.can !== 3 || c.mode !== 'voice' || c.enc !== 0) return 'call '+JSON.stringify(c);
    for(let k=0; k<6; k++) if(!pr.decode(P, L, 'str', pay('str_'+k), out)) return 'stream frame '+k;
    if(out.voice.length !== 6 || out.voice[0].fn !== 100 || out.voice[0].codec2 !== '101112131415161718191A1B1C1D1E1F' || out.voice[5].fn !== 5) return 'voice '+JSON.stringify(out.voice[0]);
    if(!out.recs.some(q => q.kind === 'end' && q.by === 'last frame')) return 'no end at FN msb';
    if(!pr.decode(P, L, 'pkt', pay('pkt_0'), out) || !pr.decode(P, L, 'pkt', pay('pkt_1'), out)) return 'packet frames';
    const pk3 = out.recs.find(q => q.kind === 'packet');
    if(!pk3 || pk3.bytes !== 30 || pk3.crc !== 'bad') return 'packet '+JSON.stringify(pk3);          // CRC этого вектора — не пакетный, ожидаем bad
    if(!pr.decode(P, L, 'bert', pay('bert'), out)) return 'BERT';
    return true;
  }},
  {name:'m17: convolutional code, Golay(24,12) and CRC — errors and erasures', fn(){
    let x = 4242; const rnd = n => { x ^= x<<13; x ^= x>>>17; x ^= x<<5; return (x>>>0) % n; };
    for(let d=0; d<4096; d+=7){
      const w = m17Golay(d), bad = w ^ (1<<rnd(24)) ^ (1<<rnd(24)) ^ (1<<rnd(24));
      const g = m17GolayDec(bad);
      if(!g || g.v !== d) return 'golay '+d;
    }
    for(const [n, steps, pat, len] of [[240, 244, M17_P1, 368], [144, 148, M17_P2, 272], [206, 210, M17_P3, 368]]){
      for(let it=0; it<10; it++){
        const d = Uint8Array.from({length:n}, () => rnd(2)), e = m17Enc(d, steps, pat);
        if(e.length !== len) return 'punctured length '+e.length+' for '+n;
        const bad = e.slice(); for(let k=0; k<2; k++) bad[rnd(len)] ^= 1;
        const r = m17Dec(bad, steps, pat);
        if(r.bits.subarray(0, n).join('') !== d.join('')) return 'viterbi '+n+' run '+it;
      }
    }
    return true;
  }},
  {name:'nxdn: MMDVMHost frames — scrambler, LICH, SACCH (CRC-6), FACCH1 (CRC-12), UDCH (CRC-15), encoders both ways', arg:V, fn(V){
    const D = h => fsk4Dib(dmrBitsOf(fskUnhex(h)));
    for(const k of ['A', 'B', 'C']){
      const F = D(V['nxdn_frame'+k]);
      for(let i=10; i<192; i++) F[i] ^= nxdnScrBit(i)<<1;
      const bits = fsk4Unpack(F, 0, 192);
      if(bits.join('') !== Array.from(dmrBitsOf(fskUnhex(V['nxdn_frame'+k+'_plain']))).join('')) return k+': descrambled frame';
      const l = nxdnLich(F.slice(10, 18));
      if(k === 'A' && (l.rfct !== 1 || l.fct !== 2 || l.opt !== 1 || l.dir !== 1 || !l.ok)) return 'LICH A '+JSON.stringify(l);
      if(k === 'B' && (l.rfct !== 2 || l.fct !== 1 || l.opt !== 3 || l.dir !== 0 || !l.ok)) return 'LICH B '+JSON.stringify(l);
      if(k !== 'C' && nxdnLichBits(l.rfct, l.fct, l.opt, l.dir) !== l.raw) return 'LICH encoder '+k;
      if(k === 'B'){
        const r = nxdnChDecode(NXDN_CH.udch, bits.subarray(36));
        if(!r.ok || dmrNum(r.bits, 0, 8) !== 7 || fskHex(p25Bytes(r.bits.subarray(8, 184))) !== 'A0A1A2A3A4A5A6A7A8A9AAABACADAEAFB0B1B2B3B4B5') return 'UDCH';
        const ud = new Uint8Array(184); ud.set(dmrBitsOf(Uint8Array.of(7)), 0); ud.set(dmrBitsOf(Uint8Array.from({length:22}, (_, i) => 0xA0+i)), 8);
        if(nxdnChEncode(NXDN_CH.udch, ud).join('') !== Array.from(bits.subarray(36)).join('')) return 'UDCH encoder';
        continue;
      }
      const s = nxdnChDecode(NXDN_CH.sacch, bits.subarray(36));
      if(!s.ok || dmrNum(s.bits, 2, 6) !== (k === 'A' ? 5 : 33) || dmrNum(s.bits, 0, 2) !== (k === 'A' ? 3 : 0)) return 'SACCH '+k+' '+JSON.stringify([s.ok, dmrNum(s.bits, 2, 6)]);
      if(k === 'A' && Array.from(s.bits.subarray(8, 26)).join('') !== '100000010000001000') return 'SACCH data';
      const f1 = nxdnChDecode(NXDN_CH.facch1, bits.subarray(96));
      if(!f1.ok || fskHex(p25Bytes(f1.bits.subarray(0, 80))) !== (k === 'A' ? '01000412340064000000' : '080004ABCD0064000000')) return 'FACCH1 '+k;
      if(k === 'A'){
        if(nxdnChDecode(NXDN_CH.facch1, bits.subarray(240)).ok) return 'voice half accepted as FACCH1';
        if(nxdnChEncode(NXDN_CH.facch1, dmrBitsOf(fskUnhex('01000412340064000000'))).join('') !== Array.from(bits.subarray(96, 240)).join('')) return 'FACCH1 encoder';
      } else {
        const f2 = nxdnChDecode(NXDN_CH.facch1, bits.subarray(240));
        if(!f2.ok || fskHex(p25Bytes(f2.bits.subarray(0, 80))) !== '080004ABCD0064000000') return 'FACCH1 second half';
        const m = nxdnL3(f1.bits.subarray(0, 72));
        if(m.name !== 'TX_REL' || m.from !== 0xABCD) return 'layer 3 '+JSON.stringify(m);
      }
    }
    return true;
  }},
  {name:'nxdn: convolutional code and CRC — errors and erasures, all three channels', fn(){
    let x = 777; const rnd = n => { x ^= x<<13; x ^= x>>>17; x ^= x<<5; return (x>>>0) % n; };
    for(const ch of [NXDN_CH.sacch, NXDN_CH.facch1, NXDN_CH.udch]){
      for(let it=0; it<20; it++){
        const d = Uint8Array.from({length:ch.data}, () => rnd(2)), e = nxdnChEncode(ch, d), bad = e.slice();
        for(let k=0; k<2; k++) bad[rnd(ch.len)] ^= 1;
        const r = nxdnChDecode(ch, bad);
        if(!r.ok || r.bits.subarray(0, ch.data).join('') !== d.join('')) return 'channel '+ch.len+' with two bit errors, run '+it;
      }
    }
    return true;
  }},
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
  {name:'nxdn: generator → decoder, voice (SACCH superframe, AMBE, FACCH1 TX_REL), 256 kS/s, +2 kHz', arg:GEN('256000', 2000, -45, 'NXDN 9600 voice', 'nxdn'), fn([g, w]){
    const ns = T.build(g, w), r = fskRun(ns, 4);
    const e = T.errors(); if(e.length) return e.join('; ');
    if(r.ui.st.bad > 3) return 'FEC errors '+r.ui.st.bad;
    return nxdnCheck(r);
  }},
  {name:'nxdn: generator → decoder, UDCH data call header and FACCH1 call; 48 kS/s, inverted spectrum, clock ±300 ppm',
   arg:[[GEN('256000', -3000, -45, 'NXDN 9600 data and FACCH1', 'nxdn'), {}], [GEN('48000', 1500, -35, 'NXDN 9600 data and FACCH1', 'nxdn'), {}],
        [GEN('256000', 0, -45, 'NXDN 9600 voice', 'nxdn'), {conj:true}], [GEN('256000', 0, -45, 'NXDN 9600 voice', 'nxdn'), {ppm:300}], [GEN('256000', 0, -45, 'NXDN 9600 voice', 'nxdn'), {ppm:-300}]], fn(cfg){
    for(const [[g, w], opt] of cfg){
      const ns = T.build(g, w), r = fskRun(ns, 4, opt), data = g[0][1].fsk4.includes('data');
      const c = nxdnCheck(r, data, g[0][1].sr === '48000' || !!opt.ppm); if(c !== true) return g[0][1].fsk4+' '+g[0][1].sr+' '+JSON.stringify(opt)+': '+c;
    }
    return true;
  }},
  {name:'m17: generator → decoder, voice stream (LSF, LICH, FN, Codec 2 bytes, last frame), 256 kS/s, +2 kHz', arg:GEN('256000', 2000, -45, 'M17 voice stream', 'm17'), fn([g, w]){
    const ns = T.build(g, w), r = fskRun(ns, 4);
    const e = T.errors(); if(e.length) return e.join('; ');
    if(r.ui.st.bad > 3) return 'FEC errors '+r.ui.st.bad;
    return m17Check(r);
  }},
  {name:'m17: generator → decoder, packet mode SMS; 48 kS/s, inverted spectrum, clock ±300 ppm',
   arg:[[GEN('256000', -3000, -45, 'M17 packet (SMS)', 'm17'), {}], [GEN('48000', 1500, -35, 'M17 voice stream', 'm17'), {}],
        [GEN('256000', 0, -45, 'M17 voice stream', 'm17'), {conj:true}], [GEN('256000', 0, -45, 'M17 voice stream', 'm17'), {ppm:300}], [GEN('256000', 0, -45, 'M17 voice stream', 'm17'), {ppm:-300}]], fn(cfg){
    for(const [[g, w], opt] of cfg){
      const ns = T.build(g, w), r = fskRun(ns, 4, opt), pkt = g[0][1].fsk4.includes('packet');
      const c = m17Check(r, pkt, g[0][1].sr === '48000' || !!opt.ppm); if(c !== true) return g[0][1].fsk4+' '+g[0][1].sr+' '+JSON.stringify(opt)+': '+c;
    }
    return true;
  }},
  {name:'ysf: generator → decoder, V/D mode 2 (header, FN 0…6 callsigns, 5 VCH per frame, terminator), 256 kS/s, +2 kHz', arg:GEN('256000', 2000, -45, 'YSF V/D mode 2', 'ysf'), fn([g, w]){
    const ns = T.build(g, w), r = fskRun(ns, 4);
    const e = T.errors(); if(e.length) return e.join('; ');
    return ysfCheck(r, false);
  }},
  {name:'ysf: generator → decoder, V/D mode 1; 48 kS/s, inverted spectrum, clock ±300 ppm',
   arg:[[GEN('256000', -3000, -45, 'YSF V/D mode 1', 'ysf'), {}], [GEN('48000', 1500, -35, 'YSF V/D mode 2', 'ysf'), {}],
        [GEN('256000', 0, -45, 'YSF V/D mode 2', 'ysf'), {conj:true}], [GEN('256000', 0, -45, 'YSF V/D mode 2', 'ysf'), {ppm:300}], [GEN('256000', 0, -45, 'YSF V/D mode 2', 'ysf'), {ppm:-300}]], fn(cfg){
    for(const [[g, w], opt] of cfg){
      const ns = T.build(g, w), r = fskRun(ns, 4, opt);
      const c = ysfCheck(r, g[0][1].fsk4.includes('mode 1'), g[0][1].sr === '48000' || !!opt.ppm); if(c !== true) return g[0][1].fsk4+' '+g[0][1].sr+' '+JSON.stringify(opt)+': '+c;
    }
    return true;
  }},
  {name:'p25: noise alone — no lock, no records', arg:GEN('256000', 2000, -45, 'P25 voice', 'p25'), fn([g, w]){
    g[0][1].mode = 'off'; g[0][1].noise = -30;
    const ns = T.build(g, w), r = fskRun(ns, 3);
    return r.recs.length === 0 && r.voice.length === 0 && r.ui.st.frames === 0 || 'records '+r.recs.length+' frames '+r.ui.st.frames;
  }},
];


export const nxdnTests = [];
