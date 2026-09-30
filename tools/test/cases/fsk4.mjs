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
  window.dstarCheck = (r, mode, noisy) => {
    const k = x => r.recs.filter(q => q.kind === x);
    const late = mode === 'late';
    if(!k('call').some(q => q.my === 'N0CALL' && q.my2 === 'TEST' && q.your === 'CQCQCQ' && q.rpt1 === 'DB0XX  B' && q.rpt2 === 'DB0XX  G' && q.source === (late ? 'slow data' : 'header'))) return 'no call: '+JSON.stringify(k('call'));
    if(mode === 'gps'){ if(!k('gps').some(q => q.nmea.startsWith('$GPGGA,123519') && q.nmea.endsWith('*47'))) return 'no GPS: '+JSON.stringify(k('gps')); }
    else if(!k('text').some(q => q.message === 'Hello D-STAR world!!')) return 'no text: '+JSON.stringify(k('text'));
    if(!late && !k('end').some(q => q.by === 'end pattern')) return 'no end pattern';
    if(r.voice.length < 30) return 'voice frames '+r.voice.length;
    let x = 0xD57A4; const rnd = () => { x ^= x<<13; x ^= x>>>17; x ^= x<<5; return x & 255; };
    const exp = new Set(Array.from({length:63}, () => fskHex(Uint8Array.from({length:9}, rnd))));
    const bad = r.voice.filter(v => !exp.has(v.ambe));
    if(bad.length > (noisy ? r.voice.length*.25 : 0)) return 'AMBE '+bad.length+' of '+r.voice.length;
    return true;
  };
  window.dpmrCheck = (r, noisy) => {
    const k = x => r.recs.filter(q => q.kind === x);
    if(r.ui.cc !== 5) return 'colour code '+r.ui.cc;
    if(!k('call').some(q => q.from === '7654321' && q.to === '1234567' && q.cc === 5)) return 'no call: '+JSON.stringify(k('call'));
    if(r.voice.length < 40) return 'voice frames '+r.voice.length;
    if(!k('header').some(q => q.type === 'communication start' && q.from === '7654321' && q.to === '1234567' && q.modeName === 'voice' && q.format === 1)) return 'no header: '+JSON.stringify(k('header'));
    if(!k('call').some(q => q.source === 'HEADER')) return 'call not from the header';
    if(!k('end').some(q => q.by === 'FS3' && q.from === '7654321')) return 'no FS3 end: '+JSON.stringify(k('end'));
    let x = 0xD9312A; const rnd = () => { x ^= x<<13; x ^= x>>>17; x ^= x<<5; return x & 255; };
    // те же TCH, что у генератора: по 72 бита (биты — младший бит xorshift), 8 на блок, 6 блоков
    const exp = new Set(); for(let u=0; u<6; u++) for(let t=0; t<8; t++){ const b = Uint8Array.from({length:72}, () => rnd()&1); exp.add(fskHex(p25Bytes(b))); }
    const bad = r.voice.filter(v => !exp.has(v.ambe));
    if(bad.length > (noisy ? r.voice.length*.25 : 0)) return 'TCH '+bad.length+' of '+r.voice.length;
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
  {name:'p25: TDULC — Golay(24,12) and RS(24,12,13) against dsd-fme encoders (hexbits in transmission order = reverse of dsd order)', arg:V, fn(V){
    for(let t=0; t<3; t++){ const [d, p] = V['tdulc_g'+t].split(' '); if((m17Golay(parseInt(d, 2)) & 0xFFF).toString(2).padStart(12, '0') !== p) return 'golay '+t; }
    const B = s => Uint8Array.from(s, c => +c), dh = p25BitsHex(B(V.tdulc_rsd)), ph = p25BitsHex(B(V.tdulc_rsp));
    if(Array.from(p25RsEnc(Uint8Array.from(Array.from(dh).reverse()), 24).subarray(12)).reverse().join() !== Array.from(ph).join()) return 'RS(24,12)';
    // кадр TDULC: кодер → декодер, ошибки в словах
    const lc = new Uint8Array(9); lc[0] = 0x0F; lc[4] = 0x10; lc[5] = 0xE1; lc[6] = 0x12; lc[7] = 0xD6; lc[8] = 0x87;
    const F = p25Frame(0x293, 15, p25TdulcBody(dmrBitsOf(lc)), 216), got = p25TdulcDecode(F);
    if(!got || fskHex(p25Bytes(got)) !== fskHex(lc)) return 'TDULC round trip';
    for(const i of [60, 61, 100, 150, 190]) F[i] ^= 1;
    const g2 = p25TdulcDecode(F); return (g2 && fskHex(p25Bytes(g2)) === fskHex(lc)) || 'TDULC with bit errors';
  }},
  {name:'dpmr: dsd-fme primitives — scrambler x⁹+x⁵+1, 12×6 interleave, Hamming(12,8), CRC-7, address digits, colour codes; encoders round trip', arg:V, fn(V){
    for(let t=0; t<6; t++){
      const inb = Uint8Array.from(V['dpmr_in'+t], c => +c), want = V['dpmr_deint'+t];
      if(Array.from(dpmrDeint(dpmrScr(inb))).join('') !== want) return 'descramble + deinterleave '+t;
      const [okf, dataS] = V['dpmr_ham'+t].split(' '), c = dpmrCch(inb);
      if(Array.from(c.bits).join('') !== dataS || (c.ham ? '1' : '0') !== okf) return 'Hamming '+t+' '+Array.from(c.bits).join('')+' vs '+dataS;
      if(dpmrCrc7(c.bits, 41).toString(16).toUpperCase().padStart(2, '0') !== V['dpmr_crc'+t]) return 'CRC-7 '+t;
    }
    for(const [v, s] of [[0, '0000000'], [1806845, '1234567'], [4321987, '295219*'], [1464100, '1000000']]) if(dpmrAiToStr(v) !== s || dpmrStrToAi(s) !== v) return 'address '+v;
    if(dpmrHamEnc([1, 0, 1, 1, 0, 0, 1, 0]).join('') !== V.dpmr_henc) return 'Hamming encoder';
    for(let i=0; i<64; i++) if(dpmrColor(Uint8Array.from({length:24}, (_, k) => (DPMR_CC[i]>>(23-k))&1)) !== i) return 'colour code '+i;
    for(let it=0; it<40; it++){
      const cch = dpmrCchEncode(it&3, (it*37)&4095, it&7, it&3, 1, it&1, (it*911)&0x3FFFF), bad = cch.slice();
      const d = dpmrCch(cch); if(!d.ok || !d.ham || dmrNum(d.bits, 0, 2) !== (it&3) || dmrNum(d.bits, 2, 12) !== ((it*37)&4095)) return 'CCH round trip '+it;
      bad[(it*7)%72] ^= 1;
      const e = dpmrCch(bad); if(!e.ok || dmrNum(e.bits, 2, 12) !== ((it*37)&4095)) return 'CCH with a bit error '+it;
    }
    return true;
  }},
  {name:'dstar: MMDVM firmware header FEC (K=3 convolution, 24×28 interleave, scrambler) and CRC, MMDVMHost slow data text; encoder bit for bit', arg:V, fn(V){
    const h = fskUnhex(V.dstar_header), fec = fskUnhex(V.dstar_fec);
    if(dstarCrc(h, 39) !== (h[39] | (h[40]<<8))) return 'crc';
    const want = []; for(let i=0; i<83; i++) for(let j=0; j<8; j++) want.push((fec[i]>>j)&1);
    if(Array.from(dstarHeaderEncode(h)).join('') !== want.slice(4, 664).join('')) return 'header FEC encoder';
    const bits = Uint8Array.from(want.slice(4, 664)), r = dstarHeaderDecode(bits);
    if(!r.ok || dstarText(r.h, 27, 8) !== 'N0CALL' || dstarText(r.h, 19, 8) !== 'CQCQCQ' || dstarText(r.h, 3, 8) !== 'DB0XX  G' || dstarText(r.h, 35, 4) !== 'TEST') return 'header decode '+JSON.stringify(r.ok);
    const bad = bits.slice(); for(const i of [10, 200, 333, 500, 600]) bad[i] ^= 1;
    if(!dstarHeaderDecode(bad).ok) return 'header with 5 bit errors';
    const sl = fskUnhex(V.dstar_slow), txt = [];
    for(let i=0; i<8; i++) txt.push(...Array.from(sl.subarray(3*i, 3*i+3), (v, j) => v^DSTAR_SLOW_SCR[j]));
    let enc = []; for(const e of dstarSlowElements('Hello D-STAR world!!', null, null).slice(0, 4)) enc.push(...e);
    return txt.join() === enc.join() || 'slow data text: '+txt.join()+' vs '+enc.join();
  }},
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
    for(const ch of [NXDN_CH.sacch, NXDN_CH.facch1, NXDN_CH.udch, NXDN_CH.cac]){
      for(let it=0; it<20; it++){
        const d = Uint8Array.from({length:ch.data}, () => rnd(2)), e = nxdnChEncode(ch, d), bad = e.slice();
        for(let k=0; k<2; k++) bad[rnd(ch.len)] ^= 1;
        const r = nxdnChDecode(ch, bad);
        if(!r.ok || r.bits.subarray(0, ch.data).join('') !== d.join('')) return 'channel '+ch.len+' with two bit errors, run '+it;
      }
    }
    return true;
  }},
  {name:'nxdn: CAC — frames that dsd-fme decodes with CRC 0, error correction, L3 fields', arg:V, fn(V){
    for(const i of [0, 1]){
      const e = Uint8Array.from(V['cac_'+i+'_coded'], c => +c), d = V['cac_'+i+'_data'];
      if(nxdnChEncode(NXDN_CH.cac, Uint8Array.from(d.slice(0, 155), c => +c)).join('') !== e.join('')) return 'CAC encoder '+i;
      const bad = e.slice(); bad[7] ^= 1; bad[150] ^= 1; bad[290] ^= 1;
      const r = nxdnChDecode(NXDN_CH.cac, bad);
      if(!r.ok || r.bits.subarray(0, 155).join('') !== d.slice(0, 155)) return 'CAC decode '+i;
    }
    const m = nxdnL3(Uint8Array.from({length:147}, (_, i) => { const b = [[0x04,6,2],[1,3,16],[1234,16,24],[4321,16,40],[9,6,56],[301,10,62]]; for(const [v, n, o] of b) if(i >= o && i < o+n) return (v>>(n-1-i+o))&1; return 0; }));
    if(m.name !== 'VCALL_ASSGN' || m.from !== 1234 || m.to !== 4321 || m.channel !== 301 || m.timer !== 9) return 'VCALL_ASSGN '+JSON.stringify(m);
    return true;
  }},
  {name:'nxdn: generator → decoder, control channel (CAC: SITE_INFO, VCALL_ASSGN), 256 kS/s, +2 kHz; inverted spectrum', arg:[[GEN('256000', 2000, -45, 'NXDN 9600 control channel (CAC)', 'nxdn'), {}], [GEN('256000', 0, -45, 'NXDN 9600 control channel (CAC)', 'nxdn'), {conj:true}]], fn(cfg){
    for(const [[g, w], opt] of cfg){
      const ns = T.build(g, w), r = fskRun(ns, 3, opt), k = r.recs.filter(q => q.kind === 'msg');
      const e = T.errors(); if(e.length) return e.join('; ');
      if(r.ui.ran !== 5) return 'ran '+r.ui.ran;
      if(!k.some(q => q.msg === 'SITE_INFO' && q.location === '123456' && q.ch1 === 17 && q.ch2 === 433 && q.adj === 2 && q.version === 3 && q.source === 'CAC')) return 'no SITE_INFO: '+JSON.stringify(k);
      if(!k.some(q => q.msg === 'VCALL_ASSGN' && q.from === 1234 && q.to === 4321 && q.channel === 301 && q.source === 'CAC')) return 'no VCALL_ASSGN: '+JSON.stringify(k);
      if(r.ui.st.cac < 4 || r.ui.st.bad > 1) return 'cac '+r.ui.st.cac+' bad '+r.ui.st.bad;
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
  {name:'p25: PDU — rate ¾ trellis (MMDVMHost), CRC-32 and CRC-9 (dsd-fme) vectors', arg:V, fn(V){
    const pay = fskUnhex(V.tr34_pay), enc = p25Tr34Enc(pay), want = fskDib(V.tr34).subarray(0, 98);
    if(enc.join('') !== want.join('')) return 'trellis 3/4 encoder';
    const d = p25Tr34Dec(want);
    if(fskHex(d.bytes) !== V.tr34_pay || d.err) return 'trellis 3/4 decoder '+fskHex(d.bytes);
    const bad = want.slice(); bad[60] ^= 1;
    if(fskHex(p25Tr34Dec(bad).bytes) !== V.tr34_pay) return 'trellis 3/4 with a dibit error';
    const m = Uint8Array.from({length:64}, (_, i) => (i*13+5)&255);
    if(p25Crc32(m, 60).toString(16).toUpperCase() !== V.crc32mbf.replace(/^0+/, '')) return 'CRC-32 '+p25Crc32(m, 60).toString(16);
    const bits = Array.from(dmrBitsOf(m)).slice(0, 135);
    if(dmrCrc9(bits).toString(16).toUpperCase() !== V.crc9) return 'CRC-9 '+dmrCrc9(bits).toString(16);
    return true;
  }},
  {name:'p25: generator → decoder, data PDUs (UDP, confirmed ¾ data, NMEA location, response, MBT NET_STS_BCST), 256 kS/s, +2 kHz; inverted, clock ±300 ppm',
   arg:[[GEN('256000', 2000, -45, 'P25 data (PDU)', 'p25'), {}], [GEN('256000', 0, -45, 'P25 data (PDU)', 'p25'), {conj:true}], [GEN('256000', 0, -45, 'P25 data (PDU)', 'p25'), {ppm:300}], [GEN('256000', 0, -45, 'P25 data (PDU)', 'p25'), {ppm:-300}]], fn(cfg){
    for(const [[g, w], opt] of cfg){
      const ns = T.build(g, w), r = fskRun(ns, 6, opt), k = r.recs.filter(q => q.kind === 'pdu'), tag = JSON.stringify(opt)+': ';
      const e = T.errors(); if(e.length) return e.join('; ');
      const u = k.find(q => q.sap === 4 && q.service === 'UDP 5000');
      if(!u || u.crc !== 'ok' || u.llid !== 0x123456 || u.io !== 1 || u.ip !== '10.1.2.3 → 10.4.5.6') return tag+'unconfirmed UDP: '+JSON.stringify(k.slice(0, 2));
      const c = k.find(q => q.an === 1 && q.fmt === 0x16);
      if(!c || c.crc !== 'ok' || c.confirmedBlocks !== '5/5' || c.llid !== 0xABCD || c.service !== 'UDP 5001' || c.bytes !== 71) return tag+'confirmed data: '+JSON.stringify(c);
      const n = k.find(q => q.sap === 48);
      if(!n || n.crc !== 'ok' || Math.abs(n.lat-48.1173) > 1e-3 || Math.abs(n.lon-11.5167) > 1e-3 || n.llid !== 1234567) return tag+'NMEA: '+JSON.stringify(n);
      if(!k.some(q => q.fmt === 3 && q.response === 'ACK' && q.llid === 0x123456)) return tag+'response: '+JSON.stringify(k.map(q => q.fmt));
      const m = r.recs.find(q => q.kind === 'mbt');
      if(!m || m.msg !== 'NET_STS_BCST' || m.wacn !== 0xBEE00 || m.sysid !== 0x123 || m.chT !== 0x1064 || m.lra !== 10) return tag+'MBT: '+JSON.stringify(m);
      if(r.ui.st.bad > (opt.ppm ? 12 : 2)) return tag+'FEC errors '+r.ui.st.bad;
    }
    return true;
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
  {name:'nxdn 4800 (2400 Bd): generator → decoder, voice and CAC; 256 kS/s, 48 kS/s, inverted spectrum, clock ±300 ppm',
   arg:[[GEN('256000', 2000, -45, 'NXDN 4800 voice', 'nxdn48'), {}], [GEN('48000', 1500, -35, 'NXDN 4800 voice', 'nxdn48'), {}],
        [GEN('256000', 0, -45, 'NXDN 4800 voice', 'nxdn48'), {conj:true}], [GEN('256000', 0, -45, 'NXDN 4800 voice', 'nxdn48'), {ppm:300}], [GEN('256000', 0, -45, 'NXDN 4800 voice', 'nxdn48'), {ppm:-300}],
        [GEN('256000', 1000, -45, 'NXDN 4800 control channel (CAC)', 'nxdn48'), {}]], fn(cfg){
    for(const [[g, w], opt] of cfg){
      const ns = T.build(g, w), r = fskRun(ns, 8, opt), gen = g[0][1].fsk4;
      const e = T.errors(); if(e.length) return e.join('; ');
      if(gen.includes('CAC')){
        if(!r.recs.some(q => q.msg === 'SITE_INFO' && q.location === '123456' && q.source === 'CAC') || !r.recs.some(q => q.msg === 'VCALL_ASSGN' && q.channel === 301)) return 'CAC: '+JSON.stringify(r.recs.slice(0, 3));
        continue;
      }
      const c = nxdnCheck(r, false, g[0][1].sr === '48000' || !!opt.ppm); if(c !== true) return g[0][1].sr+' '+JSON.stringify(opt)+': '+c;
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
  {name:'dstar: generator → decoder, header, slow data text, AMBE, end pattern (2FSK, GMSK-like), 256 kS/s, +2 kHz', arg:GEN('256000', 2000, -45, 'D-STAR voice', 'dstar'), fn([g, w]){
    const ns = T.build(g, w), r = fskRun(ns, 4);
    const e = T.errors(); if(e.length) return e.join('; ');
    return dstarCheck(r, 'text');
  }},
  {name:'dstar: GPS slow data and late entry (header from slow data); 48 kS/s, inverted spectrum, clock ±300 ppm',
   arg:[[GEN('256000', -3000, -45, 'D-STAR GPS', 'dstar'), {}, 'gps'], [GEN('256000', 1000, -45, 'D-STAR late entry (header in slow data)', 'dstar'), {}, 'late'],
        [GEN('48000', 1500, -35, 'D-STAR voice', 'dstar'), {}, 'text'], [GEN('256000', 0, -45, 'D-STAR voice', 'dstar'), {conj:true}, 'text'],
        [GEN('256000', 0, -45, 'D-STAR voice', 'dstar'), {ppm:300}, 'text'], [GEN('256000', 0, -45, 'D-STAR voice', 'dstar'), {ppm:-300}, 'text']], fn(cfg){
    for(const [[g, w], opt, mode] of cfg){
      const ns = T.build(g, w), r = fskRun(ns, mode === 'late' ? 5 : 4, opt);
      const c = dstarCheck(r, mode, g[0][1].sr === '48000' || !!opt.ppm); if(c !== true) return g[0][1].fsk4+' '+g[0][1].sr+' '+JSON.stringify(opt)+': '+c;
    }
    return true;
  }},
  {name:'dpmr: header word (FS1, HI) — frames encoded by dsdcc (Hamming(12,8), LFSR, 120-bit interleave, CRC-8) decode to the same fields, errors corrected', arg:V, fn(V){
    for(const line of V.dpmr_hdr){
      const [ht, called, own, mode, fmt, dib] = line.split(' '), bits = fsk4Unpack(Uint8Array.from(dib, c => +c), 0, 60);
      const r = dpmrHi(bits);
      if(!r.ok || r.f.htype !== +ht || r.f.called !== dpmrAiToStr(parseInt(called, 16)) || r.f.own !== dpmrAiToStr(parseInt(own, 16)) || r.f.mode !== +mode || r.f.format !== +fmt) return 'decode '+line.slice(0, 24)+' '+JSON.stringify(r.f);
      const enc = dpmrHiEncode({htype:+ht, called:r.f.called, own:r.f.own, mode:+mode, format:+fmt});
      if(enc.join('') !== Array.from(bits).join('')) return 'encoder '+line.slice(0, 24);
      const bad = bits.slice(); bad[7] ^= 1; bad[80] ^= 1;
      if(!dpmrHi(bad).ok) return 'two bit errors '+line.slice(0, 24);
    }
    return true;
  }},
  {name:'dpmr: generator → decoder (FS2, CC, CCH called / calling IDs, TCH), 256 kS/s, +2 kHz', arg:GEN('256000', 2000, -45, 'dPMR voice', 'dpmr'), fn([g, w]){
    const ns = T.build(g, w), r = fskRun(ns, 4);
    const e = T.errors(); if(e.length) return e.join('; ');
    return dpmrCheck(r);
  }},
  {name:'dpmr: packet data header (FS4) — same HI / CC / HI1 layout, version, format, emergency and message information; no call, no end frame; also with the spectrum inverted (FS4 is FS1 with the levels flipped)',
   arg:[[GEN('256000', 1500, -45, 'dPMR packet data header (FS4)', 'dpmr'), {}], [GEN('256000', 0, -45, 'dPMR packet data header (FS4)', 'dpmr'), {conj:true}]], fn(cfg){
    for(const [[g, w], opt] of cfg){
      const ns = T.build(g, w), r = fskRun(ns, 2, opt), h = r.recs.filter(q => q.kind === 'header'), tag = JSON.stringify(opt)+': ';
      const e = T.errors(); if(e.length) return e.join('; ');
      if(!h.length) return tag+'no header';
      const q = h[0];
      if(!q.packet || q.from !== '5312468' || q.to !== '2468135' || q.mode !== 4 || q.modeName !== 'packet data' || q.version !== 1 || q.format !== 1 || q.emergency !== 1 || q.info !== 0x2A5) return tag+JSON.stringify(q);
      if(r.ui.cc !== 9) return tag+'colour code '+r.ui.cc;
      if(r.recs.some(x => x.kind === 'call' || x.kind === 'end')) return tag+'call or end from a packet header';
    }
    return true;
  }},
  {name:'dpmr: 48 kS/s, inverted spectrum, clock ±300 ppm',
   arg:[[GEN('48000', 1500, -35, 'dPMR voice', 'dpmr'), {}], [GEN('256000', 0, -45, 'dPMR voice', 'dpmr'), {conj:true}], [GEN('256000', 0, -45, 'dPMR voice', 'dpmr'), {ppm:300}], [GEN('256000', 0, -45, 'dPMR voice', 'dpmr'), {ppm:-300}]], fn(cfg){
    for(const [[g, w], opt] of cfg){
      const ns = T.build(g, w), r = fskRun(ns, 4, opt);
      const c = dpmrCheck(r, g[0][1].sr === '48000' || !!opt.ppm); if(c !== true) return g[0][1].sr+' '+JSON.stringify(opt)+': '+c;
    }
    return true;
  }},
  {name:'fskRx auto: every protocol is picked by its sync words (P25, NXDN, M17, YSF, D-STAR, dPMR, DMR) — one node, all channels',
   arg:[['P25 voice', 'p25'], ['NXDN 9600 voice', 'nxdn'], ['NXDN 4800 voice', 'nxdn'], ['M17 voice stream', 'm17'], ['YSF V/D mode 2', 'ysf'], ['D-STAR voice', 'dstar'], ['dPMR voice', 'dpmr']], fn(list){
    for(const [gen, id] of list){
      const [g, w] = [[['iqGen', {sr:'256000', fc:433e6, mode:'4FSK', off:1000, lvl:-20, noise:-45, fsk4:gen}], ['fskRx', {proto:'auto'}]], ['0.iq>1.in']];
      const ns = T.build(g, w), r = fskRun(ns, 4);
      const e = T.errors(); if(e.length) return e.join('; ');
      const srcs = new Set(r.recs.map(q => q.src));
      const want = {p25:'P25', nxdn:'NXDN', m17:'M17', ysf:'YSF', dstar:'D-STAR', dpmr:'dPMR'}[id];
      if(!srcs.has(want) || srcs.size !== 1) return gen+': records from '+[...srcs].join(', ')+', '+r.recs.length+' total';
      if(!r.voice.length && id !== 'p25') return gen+': no voice frames';
    }
    // DMR (тот же канал 4800 Бод, что у P25 / NXDN / YSF)
    const ns = T.build([['iqGen', {sr:'256000', fc:438e6, mode:'DMR', off:2000, lvl:-20, noise:-45}], ['fskRx', {proto:'auto'}]], ['0.iq>1.in']);
    const r = fskRun(ns, 8);
    if(!r.recs.some(q => q.src === 'DMR' && q.kind === 'call' && q.from === 2600123) || r.recs.some(q => q.src !== 'DMR')) return 'DMR through the universal node: '+[...new Set(r.recs.map(q => q.src))].join(', ');
    return true;
  }},
  {name:'fskRx: universal node in a worker island, all protocols loaded there', arg:GEN('256000', 2000, -45, 'P25 voice', 'auto'), async fn([g, w]){
    g.push(['recLog', {}]); w.push('1.rec>2.rec');
    Islands.setEnabled(true);
    try{
      const ns = T.build(g, w);
      if(!ns[1]._isl) return 'not in a worker';
      await T.realtime(4);
      await new Promise(r => setTimeout(r, 300)); for(const nd of Graph.order) evalNode(nd);
      const e = T.errors(); if(e.length) return e.join('; ');
      return ns[2].rows.some(q => q.src === 'P25' && q.kind === 'call') || 'rows '+ns[2].rows.length;
    } finally { Islands.setEnabled(false); }
  }},
  {name:'p25: generator → decoder, voice ended by TDULC (link control: call termination, source and destination)', arg:GEN('256000', 2000, -45, 'P25 voice, TDULC', 'p25'), fn([g, w]){
    const ns = T.build(g, w), r = fskRun(ns, 4);
    const e = T.errors(); if(e.length) return e.join('; ');
    const k = x => r.recs.filter(q => q.kind === x);
    if(!k('lc').some(q => q.source === 'TDULC' && q.type === 'terminate' && q.to === 4321 && q.from === 1234567)) return 'no TDULC LC: '+JSON.stringify(k('lc'));
    if(!k('end').some(q => q.by === 'TDULC' && q.from === 1234567)) return 'no end: '+JSON.stringify(k('end'));
    return r.ui.st.bad <= 2 || 'FEC errors '+r.ui.st.bad;
  }},
  {name:'p25: noise alone — no lock, no records', arg:GEN('256000', 2000, -45, 'P25 voice', 'p25'), fn([g, w]){
    g[0][1].mode = 'off'; g[0][1].noise = -30;
    const ns = T.build(g, w), r = fskRun(ns, 3);
    return r.recs.length === 0 && r.voice.length === 0 && r.ui.st.frames === 0 || 'records '+r.recs.length+' frames '+r.ui.st.frames;
  }},
];


export const nxdnTests = [];
