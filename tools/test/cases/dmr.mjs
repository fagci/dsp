// DMR: FEC и кодовые слова против MMDVMHost (g4klx) и dsd-fme, генератор → декодер, режимы, инверсия, уход такта
// Векторы MMDVM: в стенде собраны его классы (CBPTC19696, CDMRFullLC, CDMRSlotType, CDMREMB, CDMREmbeddedData, CDMRShortLC, CCRC),
// каждому подана известная нагрузка, ниже — 33 байта кадра (9 байт Short LC), как их выдал MMDVM.
const GEN = (sr, off, noise, dmr) => [[['iqGen', {sr, fc:438e6, mode:'DMR', off, lvl:-20, noise, dmr:dmr||'repeater (BS)'}], ['dmrRx', {}]], ['0.iq>1.in']];
const V = {
  bptc:  '07A4069004F108682003A3C3400000000000000001082008CB530A460241179475',
  lc1:   '03B80F4201C81B880ED07320C00000000000000002B80BF82A2012A022811181A6',
  lc2:   '407F06D7157605A80BC02CA0000000000000000000A0197831901C606A501882FE',
  csbk:  '0297827386640B446D981610C0000000000000000382164093112F603ED822B819',
  hdr:   '0074C0852018139442490D60800000000000000000CD0058013802E10242133014',
  slot:  '0000000000000000000000002870000000000007F0000000000000000000000000',
  slot2: '0000000000000000000000003DA000000000000100000000000000000000000000',
  emb1:  '000000000000000000000000000320000000026000000000000000000000000000',
  emb2:  '000000000000000000000000000CC000000007D000000000000000000000000000',
  elc:   ['0000000000000000000000000000003060F0500000000000000000000000000000', '00000000000000000000000000000030A030000000000000000000000000000000', '000000000000000000000000000000F06050A00000000000000000000000000000', '0000000000000000000000000000005000F0900000000000000000000000000000'],
  slc:   '060FC050F3CAF63660',
  t34:   '02121301203023331002211133311130332120011112323311023232101130120310213113233121123000322323302102',
};

export function setup(){
  const unhex = s => Uint8Array.from(s.match(/../g), h => parseInt(h, 16));
  const hex = a => Array.from(a, x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  window.dmrUnhex = unhex; window.dmrHexS = hex;
  // n блоков по 0.5 с в цепочку, записи всех выходов; conj — инвертированный спектр; ppm — уход тактовой частоты приёмника
  window.dmrRun = (ns, sec, opt) => {
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
  // все ожидаемые записи сеанса генератора; возвращает true или строку с причиной
  window.dmrCheck = (r, o) => {
    o = o || {};
    const k = x => r.recs.filter(q => q.kind === x);
    const call = k('call').filter(q => q.from === 2600123 && q.to === 9 && q.call === 'group');
    if(!call.length) return 'no group call 2600123 → 9: '+JSON.stringify(k('call'));
    if(!k('alias').some(q => q.alias === 'DSPLAB')) return 'no talker alias';
    if(!k('end').some(q => q.from === 2600123 && q.voice >= 10)) return 'no terminator: '+JSON.stringify(k('end'));
    if(!r.voice.length || r.voice[0].ambe.length !== 54) return 'no AMBE frames';
    if(r.ui.cc !== 1) return 'cc '+r.ui.cc;
    if(o.simplex) return true;
    const m = k('message');
    if(!m.some(q => q.service === 'TMS' && q.message === 'Hello from DSP lab' && q.crc === 'ok' && q.from === 2600123 && q.to === 4001234)) return 'no TMS text: '+JSON.stringify(m);
    if(!m.some(q => q.service === 'short data' && q.message.startsWith('DMR TEST 34') && q.crc === 'ok' && q.rate === '3/4')) return 'no short data ¾: '+JSON.stringify(m);
    if(!k('csbk').some(q => q.name === 'Preamble' && q.data === 1 && q.from === 2600123 && q.to === 4001234)) return 'no preamble CSBK';
    if(!k('csbk').some(q => q.name === 'BS_Dwn_Act')) return 'no BS_Dwn_Act';
    if(!m.some(q => q.service === 'LRRP' && Math.abs(q.lat-55.0302) < 1e-4 && Math.abs(q.lon-82.9204) < 1e-4 && q.heading === 90 && q.time === '2026-09-29 18:30:15' && q.id === 'dmr:2600123')) return 'no LRRP position: '+JSON.stringify(m.filter(q => q.service === 'LRRP'));
    if(!k('csbk').some(q => q.name === 'C_ALOHA' && q.model === 'small' && q.net === 42 && q.site === 7 && q.reg === 1)) return 'no C_ALOHA: '+JSON.stringify(k('csbk').filter(q => q.op === 0x19));
    if(!k('csbk').some(q => q.name === 'TV_GRANT' && q.lpcn === 5 && q.ts === 2 && q.to === 9 && q.from === 2600123)) return 'no TV_GRANT';
    if(!m.some(q => q.message === 'Confirmed data ok' && q.blockCrc === 'ok' && q.crc === 'ok' && q.type === 'confirmed')) return 'no confirmed data: '+JSON.stringify(m.filter(q => q.type === 'confirmed'));
    if(!m.some(q => q.message === 'Rate one data works.' && q.rate === '1' && q.crc === 'ok')) return 'no rate 1 data: '+JSON.stringify(m.filter(q => q.rate === '1'));
    if(!k('mbc').some(q => q.name === 'TV_GRANT' && q.crc === 'ok' && q.rx === 433.7625 && q.tx === 438.7625 && q.apcn === 5 && q.to === 9 && q.from === 2600123)) return 'no MBC grant: '+JSON.stringify(k('mbc'));
    if(r.ui.sys?.net !== 42) return 'sys '+JSON.stringify(r.ui.sys);
    if(!k('slc').some(q => q.slco === 1 && q.ts1 === 'group voice' && q.ts2 === 'group data')) return 'no short LC: '+JSON.stringify(k('slc'));
    if(!r.recs.some(q => q.slot === 1) || !r.recs.some(q => q.slot === 2)) return 'slots';
    return true;
  };
}

export default [
  {name:'dmr: golay(20,8) slot type and QR(16,7) EMB: all words, up to 3 / 2 bit errors', fn(){
    for(let cc=0; cc<16; cc++) for(let dt=0; dt<12; dt++){
      const w = DMR_GOLAY[(cc<<4)|dt];
      for(const e of [0, 1<<3, (1<<0)|(1<<9)|(1<<19)]){
        const bits = new Uint8Array(264); for(let i=0; i<20; i++) bits[i<10 ? 98+i : 156+i-10] = ((w^e)>>(19-i))&1;
        const r = dmrSlotType(bits, 3);
        if(!r || r.cc !== cc || r.dt !== dt) return 'slot type '+cc+'/'+dt+' err '+e.toString(2);
      }
    }
    for(let v=0; v<128; v++){
      const bits = new Uint8Array(264), w = DMR_QR[v] ^ 0x0101;
      for(let i=0; i<8; i++){ bits[108+i] = (w>>(15-i))&1; bits[148+i] = (w>>(7-i))&1; }
      const r = dmrEmb(bits, 2);
      if(!r || r.cc !== (v>>3) || r.lcss !== (v&3) || r.pi !== ((v>>2)&1)) return 'EMB '+v;
    }
    return true;
  }},
  {name:'dmr: MMDVMHost vectors — BPTC(196,96), LC + RS(12,9), CSBK / data header CRC-CCITT, slot type, EMB', arg:V, fn(V){
    const B = h => dmrBitsOf(dmrUnhex(h)), raw = h => dmrRaw196(B(h));
    const dec = dmrBptcDec(raw(V.bptc));
    if(dmrHexS(dmrBytes(dec, 0, 12)) !== '000102030405060708090A0B') return 'bptc '+dmrHexS(dmrBytes(dec, 0, 12));
    const e = raw(V.bptc); e[3] ^= 1; e[77] ^= 1; e[150] ^= 1;
    if(dmrHexS(dmrBytes(dmrBptcDec(e), 0, 12)) !== '000102030405060708090A0B') return 'bptc 3 errors';
    let lc = dmrLc(dmrBptcDec(raw(V.lc1)), 0x96);
    if(!lc || dmrHexS(lc.subarray(0, 9)) !== '000000000009270FBB') return 'voice LC header';
    if(dmrLc(dmrBptcDec(raw(V.lc1)), 0x99)) return 'LC accepted with the wrong mask';
    lc = dmrLc(dmrBptcDec(raw(V.lc2)), 0x99);
    if(!lc || dmrHexS(lc.subarray(0, 9)) !== '030000000012345AB0') return 'terminator LC';
    const cs = dmrMasked(dmrBptcDec(raw(V.csbk)), 0xA5A5);
    if(!cs || dmrHexS(cs.subarray(0, 10)) !== '3D0080080040123427BB') return 'CSBK';
    const hd = dmrMasked(dmrBptcDec(raw(V.hdr)), 0xCCCC);
    if(!hd || dmrHexS(hd.subarray(0, 10)) !== '8D104001234000000000') return 'data header';
    if(dmrCrc16(dmrUnhex('00112233445566778899'), 10) !== 0xCB45) return 'crc16 0x'+dmrCrc16(dmrUnhex('00112233445566778899'), 10).toString(16);
    let st = dmrSlotType(B(V.slot), 0);
    if(!st || st.cc !== 10 || st.dt !== 1) return 'slot type '+JSON.stringify(st);
    st = dmrSlotType(B(V.slot2), 0);
    if(!st || st.cc !== 15 || st.dt !== 6) return 'slot type 2 '+JSON.stringify(st);
    let em = dmrEmb(B(V.emb1), 0);
    if(!em || em.cc !== 3 || em.pi !== 0 || em.lcss !== 1) return 'EMB '+JSON.stringify(em);
    em = dmrEmb(B(V.emb2), 0);
    if(!em || em.cc !== 12 || em.pi !== 1 || em.lcss !== 2) return 'EMB 2 '+JSON.stringify(em);
    // наш кодер = кодер MMDVM
    const mine = dmrEncLc(dmrUnhex('000000000009270FBB'), 0x96), ref = raw(V.lc1);
    if(!mine.every((v, i) => v === ref[i])) return 'LC encode differs from MMDVM';
    return true;
  }},
  {name:'dmr: MMDVMHost vectors — embedded LC (4×32 bit, Hamming 16,11 + CRC-5) both ways, Short LC + CRC-8', arg:V, fn(V){
    const raw = new Uint8Array(128);
    V.elc.forEach((h, k) => { const b = dmrBitsOf(dmrUnhex(h)); for(let j=0; j<32; j++) raw[32*k+j] = b[116+j]; });
    const lc = dmrEmbDecode(raw);
    if(!lc || dmrHexS(dmrBytes(lc, 0, 9)) !== '000000000009270FBB') return 'embedded LC';
    const mine = dmrEmbEncode(lc);
    if(!mine.every((v, i) => v === raw[i])) return 'embedded LC encode differs';
    raw[5] ^= 1; raw[70] ^= 1;
    if(!dmrEmbDecode(raw)) return 'embedded LC: two errors in different rows should be corrected';
    // Short LC: 4×17 бит из 68 (MMDVM кладёт 36 бит в кадр со сдвигом на 4 бита; CRC-8 считаем сами)
    const b = dmrBitsOf(dmrUnhex(V.slc)), fr = [0,1,2,3].map(j => b.slice(17*j, 17*j+17));
    const r = dmrShortLc(fr);
    if(!r) return 'short LC rejected';
    if(dmrHexS(dmrBytes(Uint8Array.from([0,0,0,0,...r]), 0, 5)) !== '018B5AA50D') return 'short LC '+dmrHexS(dmrBytes(Uint8Array.from([0,0,0,0,...r]), 0, 5));
    const bad = fr.map(x => x.slice()); bad[2][4] ^= 1; bad[0][9] ^= 1;
    if(!dmrShortLc(bad)) return 'short LC: one error per Hamming row should be corrected';
    return true;
  }},
  {name:'dmr: rate ¾ trellis — encoder against the dsd-fme decoder (vector), round trip and errors', arg:V, fn(V){
    const d = Uint8Array.from({length:18}, (_, i) => (i*29+7)&255), raw = dmrT34Enc(dmrBitsOf(d));
    let s = ''; for(let k=0; k<98; k++) s += raw[2*k]*2+raw[2*k+1];
    if(s !== V.t34) return 'dibits differ from the ones dsd-fme decodes to this data';
    let r = dmrT34Dec(raw);
    if(dmrHexS(dmrBytes(r.bits, 0, 18)) !== dmrHexS(d) || r.err) return 'round trip';
    const e = raw.slice(); e[20] ^= 1;
    r = dmrT34Dec(e);
    return r.err > 0 || 'a bit error goes unnoticed';
  }},
  {name:'dmr: NMEA (UDT) and LRRP position parsing', fn(){
    const n = dmrNmea('$GPGGA,123519,5501.812,N,08255.224,E,1,08,0.9,123.4,M,46.9,M,,*47\r\n$GPRMC,123519,A,5501.812,N,08255.224,E,022.4,084.4,230394,003.1,W*6A');
    if(Math.abs(n.lat-55.030200) > 1e-6 || Math.abs(n.lon-82.920400) > 1e-6 || n.alt !== 123.4 || n.speed !== 41.5 || n.heading !== 84.4) return 'nmea '+JSON.stringify(n);
    const s = dmrNmea('$GPRMC,1,A,3357.500,S,15112.000,W,0,0,1,0,W*00');
    if(s.lat >= 0 || s.lon >= 0) return 'nmea signs '+JSON.stringify(s);
    if(dmrLrrp(Uint8Array.from([1,2,3,4,5]), 0).lat != null) return 'lrrp accepted noise';
    return true;
  }},
  {name:'dmr: confirmed-block CRC-9 (½, ¾, rate 1) and MBC CRC-16 catch bit errors', fn(){
    const d = Uint8Array.from({length:22}, (_, i) => (i*13+5)&255);
    for(const [len, mask] of [[10, 0x0F0], [16, 0x1FF], [22, 0x10F]]){
      const bits = dmrConfEnc(d.subarray(0, len), 37, mask), r = dmrConfBlock(bits, mask);
      if(!r.ok || r.serial !== 37) return 'CRC-9 '+len+' '+JSON.stringify(r);
      bits[30] ^= 1; if(dmrConfBlock(bits, mask).ok) return 'CRC-9 '+len+' misses a bit error';
    }
    // MBC: CRC-16 по продолжениям
    const b = dmrEncMasked(Uint8Array.from([1,2,3,4,5,6,7,8,9,10]), 0), by = dmrBytes(dmrBptcDec(b), 0, 12);
    if(dmrCrc16(by, 10) !== ((by[10]<<8)|by[11])) return 'MBC continuation CRC';
    return true;
  }},
  {name:'dmr: CRC-32 of data messages, TMS text and IP/UDP parsing', fn(){
    const {blk, pad} = dmrMsgBlocks(dmrIpMsg(1234567, 7654321, 'Привет, DMR'), 12, 0);
    const m = new Uint8Array(blk.length*12); blk.forEach((b, i) => m.set(b, 12*i));
    const want = ((m[m.length-4]<<24)|(m[m.length-3]<<16)|(m[m.length-2]<<8)|m[m.length-1])>>>0;
    if(dmrCrc32(m, m.length-4) !== want) return 'CRC-32';
    m[3] ^= 1; if(dmrCrc32(m, m.length-4) === want) return 'CRC-32 misses a bit error'; m[3] ^= 1;
    const p = dmrPayload(4, null, m.subarray(0, m.length-4-pad));
    return p.service === 'TMS' && p.message === 'Привет, DMR' && p.port === 4007 && p.ip.startsWith('12.18.214.135') || JSON.stringify(p);
  }},
  {name:'dmr: generator → decoder, 256 kS/s, +2 kHz', arg:GEN('256000', 2000, -45), fn([g, w]){
    const ns = T.build(g, w), r = dmrRun(ns, 8);
    const e = T.errors(); if(e.length) return e.join('; ');
    const u = r.ui;
    if(!u.locked || u.mode !== 'bs' || u.inv) return 'ui '+JSON.stringify(u);
    if(u.st.bad > 4) return 'FEC errors '+u.st.bad;
    return dmrCheck(r);
  }},
  {name:'dmr: 48 kS/s (no decimation), noise −35 dBFS', arg:GEN('48000', -3000, -35), fn([g, w]){
    const ns = T.build(g, w), r = dmrRun(ns, 8);
    return dmrCheck(r);
  }},
  {name:'dmr: 1.024 MS/s', arg:GEN('1024000', -6000, -50), fn([g, w]){
    const ns = T.build(g, w), r = dmrRun(ns, 8);
    return dmrCheck(r);
  }},
  {name:'dmr: inverted spectrum (voice and data sync are each other\'s inverse — polarity comes from FEC)', arg:GEN('256000', 2000, -45), fn([g, w]){
    const ns = T.build(g, w), r = dmrRun(ns, 8, {conj:true});
    if(!r.ui.inv) return 'polarity not detected';
    return dmrCheck(r);
  }},
  {name:'dmr: transmitter clock off by +200 / −300 ppm', arg:GEN('256000', 2000, -45), fn([g, w]){
    for(const ppm of [200, -300]){
      const ns = T.build(g, w), r = dmrRun(ns, 8, {ppm});
      const c = dmrCheck(r); if(c !== true) return ppm+' ppm: '+c;
    }
    return true;
  }},
  {name:'dmr: mobile uplink and direct mode TS1 / TS2 (no CACH, one slot per 60 ms)', arg:['inbound (MS)', 'direct TS1', 'direct TS2'], fn(modes){
    for(const m of modes){
      const [g, w] = [[['iqGen', {sr:'256000', fc:438e6, mode:'DMR', off:2000, lvl:-20, noise:-45, dmr:m}], ['dmrRx', {}]], ['0.iq>1.in']];
      const ns = T.build(g, w), r = dmrRun(ns, 8), u = r.ui;
      const c = dmrCheck(r, {simplex:true}); if(c !== true) return m+': '+c;
      if(u.mode !== (m === 'inbound (MS)' ? 'ms' : 'direct')) return m+': mode '+u.mode;
      if(m.startsWith('direct') && !r.voice.some(v => v.slot === (m === 'direct TS1' ? 1 : 2))) return m+': slot';
    }
    return true;
  }},
  {name:'dmr: noise alone — no lock, no records', arg:GEN('256000', 0, -30), fn([g, w]){
    g[0][1].mode = 'off';
    const ns = T.build(g, w), r = dmrRun(ns, 12);
    return r.recs.length === 0 && r.ui.st.bursts === 0 || 'records '+r.recs.length+' bursts '+r.ui.st.bursts;
  }},
  {name:'dmr: decoder in a worker island, records reach the log', arg:GEN('256000', 2000, -45), async fn([g, w]){
    g.push(['recLog', {}]); w.push('1.rec>2.rec');
    Islands.setEnabled(true);
    try{
      const ns = T.build(g, w);
      if(!ns[1]._isl) return 'not in a worker';
      await T.realtime(6);
      await new Promise(r => setTimeout(r, 300)); for(const nd of Graph.order) evalNode(nd);
      const e = T.errors(); if(e.length) return e.join('; ');
      const rows = ns[2].rows;
      return rows.some(q => q.kind === 'message' && q.message === 'Hello from DSP lab') && rows.some(q => q.kind === 'call') && ns[1].ui?.cc === 1 || 'rows '+rows.length+' ui '+JSON.stringify(ns[1].ui?.st);
    } finally { Islands.setEnabled(false); }
  }},
  {name:'dmr call log: calls, seconds, messages, talkgroups, position, CSV, outputs', arg:GEN('256000', 2000, -45), fn([g, w]){
    g.push(['dmrLog', {}], ['recLog', {}], ['recLog', {}]); w.push('1.rec>2.rec', '2.stations>3.rec', '2.calls>4.rec');
    const ns = T.build(g, w); T.run(9);
    const e = T.errors(); if(e.length) return e.join('; ');
    const lg = ns[2], s = lg.st.get(2600123), tg = lg.tgs.get(9);
    if(!s) return 'no station: '+[...lg.st.keys()];
    if(s.calls < 3 || s.seconds < 1 || s.msgs < 4 || s.alias !== 'DSPLAB' || s.tg !== 9) return 'station '+JSON.stringify(s);
    if(Math.abs(s.lat-55.0302) > 1e-4 || Math.abs(s.lon-82.9204) > 1e-4) return 'position '+s.lat+' '+s.lon;
    if(!tg || tg.calls < 3 || !tg.stations.has(2600123)) return 'group '+JSON.stringify([tg?.calls]);
    const calls = lg.calls.filter(c => !c.data);
    if(calls.length < 3 || calls.some(c => !(c.dur > 0)) || calls.filter(c => c.dur > 1.3 && c.dur < 1.7).length < 2) return 'calls '+JSON.stringify(calls.map(c => c.dur));   // 4 суперкадра ≈ 1.5 с; первый вызов может быть неполным (вход в середине)
    if(!ns[3].rows.some(r => r.kind === 'station' && r.id === 'dmr:2600123' && r.lat != null)) return 'stations output';
    if(!ns[4].rows.some(r => r.kind === 'call-log' && r.radio === 2600123 && r.to === 9 && r.seconds > 0.5)) return 'calls output';
    const csv = [recsToCsv(dmrLogCallRows(lg)), recsToCsv(dmrLogStationRows(lg)), recsToCsv(dmrLogGroupRows(lg))];
    if(!csv[0].includes('2600123') || !csv[1].includes('DSPLAB') || !csv[2].split('\n')[0].includes('group')) return 'csv '+csv.map(x => x.slice(0, 60)).join(' | ');
    lg.p.max = 100; return true;
  }},
  {name:'preset: DMR: Activity Log and Station Map (Generator)', fn(){
    T.preset('DMR: Activity Log and Station Map (Generator)'); T.run(9);
    const e = T.errors(); if(e.length) return e.join('; ');
    const m = T.byType('geoMap')[0], pts = [...m.ents.values()].filter(x => x.rec.id === 'dmr:2600123');
    return pts.length === 1 && pts[0].rec.label === 'DSPLAB' || 'map '+pts.length+' '+pts[0]?.rec.label;
  }},
  {name:'preset: DMR: Activity Log and Station Map (USB SDR) loads', fn(){
    T.preset('DMR: Activity Log and Station Map (USB SDR)'); T.run(0.5);
    const e = T.errors(); return e.length ? e.join('; ') : true;
  }},
  {name:'preset: DMR: Calls, SMS and CSBK (Generator)', fn(){
    T.preset('DMR: Calls, SMS and CSBK (Generator)'); T.run(10);
    const e = T.errors(); if(e.length) return e.join('; ');
    const log = T.byType('recLog')[0];
    const m = T.byType('geoMap')[0], pts = [...m.ents.values()].filter(x => x.rec.id === 'dmr:2600123');
    return log.rows.some(q => q.kind === 'message' && q.message === 'Hello from DSP lab') && log.rows.some(q => q.kind === 'call') && pts.length === 1 || 'rows '+log.rows.length+' map '+pts.length;
  }},
  {name:'preset: DMR: Repeater or Direct Mode (USB SDR) loads', fn(){
    T.preset('DMR: Repeater or Direct Mode (USB SDR)'); T.run(0.5);
    const e = T.errors(); return e.length ? e.join('; ') : true;
  }},
];
