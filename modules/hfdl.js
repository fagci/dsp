"use strict";
/* ==========================================================================================
 * HFDL: LPDU→HFNPDU→ACARS→ADS-C, порт из dumphfdl (szpajder/dumphfdl, GPLv3) и
 * libacars (szpajder/libacars) по исходникам, присланным пользователем в чате кусками.
 * Каждый слой ниже самопроверен (см. комментарии), кроме явно помеченных заглушек.
 *
 * СТАТУС (актуально на момент сборки):
 *   [ГОТОВО, проверено]  CRC-16/X-25 (HDLC FCS, уровень HFDL)              — crc16_x25
 *   [ГОТОВО, проверено]  CRC-16/CCITT нерефл. (уровень ACARS-конверта)     — crc16_ccitt_true
 *   [ГОТОВО, проверено]  ACARS-конверт (mode/reg/label/txt/no/flightId)    — acarsParse
 *   [ГОТОВО, проверено]  ADS-C (Basic report, Flight ID, Airframe ID)      — adscParseDownlink
 *   [ГОТОВО, проверено]  HFNPDU (Performance/Frequency Data, Enveloped)    — hfnpduParse
 *   [ГОТОВО, проверено]  LPDU (типы, FCS, кеш ac_id→ICAO)                  — lpduParse
 *   [ГОТОВО, проверено]  MPDU (заголовок uplink/downlink, список LPDU)     — mpduParse
 *   [ГОТОВО]             валидность координат + достройка времени         — positionInfoExtract
 *   [ЗАГЛУШКА, НЕ ФАКТ]  parse_coordinate() 20-бит (Performance/Frequency) — parseCoordinate20_UNVERIFIED
 *   [НЕ ПОДТВЕРЖДЁН]     la_check_crc16_arinc() — сам алгоритм не встречался, НО в оригинале это
 *                         чисто информационный флаг (crc_ok), разбор ADS-C от него не зависит —
 *                         поэтому здесь просто не проверяю CRC вообще, парсинг идёт как есть.
 *   [ГОТОВО, проверено]  ARINC-622 конверт (IMI-поиск, hex-payload, ADS-C/DIS диспатч) — arincParse
 *   [ГОТОВО, самопроверено round-trip]  Витерби K=7 r=1/2 (FEC) — v27Create/v27UpdateBlk/v27Chainback
 *                         (на практике используй уже имеющийся у себя viterbiDec с g1=155,g2=117
 *                         восьмеричными — проверено эквивалентно, см. переписку)
 *   [ГОТОВО, выведено из liquid-dsp/hfdl.c, самопроверено]  символ→биты — symbolToBits()
 *                         (фазовый сдвиг d_phi, Грей-код, порядок бит MSB-первым — всё подтверждено
 *                         исходником modem_psk.c, не подобрано эмпирически)
 *   [ГОТОВО, из hfdl.c]  reverseBytes() — ОБЯЗАТЕЛЕН между Витерби и mpduParse (уже применяется
 *                         внутри hfdlStack)
 *   [ГОТОВО, из hfdl.c]  averageChipPairs() — для code_rate=4 (300/600 bps), не подключено
 *                         автоматически в hfdlStack (там пока жёстко код_rate=2 подразумевается)
 *   [ГОТОВО, из hfdl.c, структурно самопроверено]  makeDeinterleaver() — push/pop с разными
 *                         сдвигами (17или23 / фикс.9) — НЕ используется пока в hfdlStack напрямую,
 *                         это отдельный кубик под замену твоего hfdlDeint, если он не совпадает
 *   [ГОТОВО из hfdl.c]  averageChipPairs() — теперь ПОДКЛЮЧЕНО (узел hfdlChipAvg,
 *                         между hfdlDeint и Витерби, автоматически по M1)
 *   [ГОТОВО]              soft-значения (не hard-quantized) — BPSK: проекция I напрямую;
 *                         QPSK/8PSK: symbolToSoftBits() — дистанция до ближайших точек
 *                         созвездия с bit=0/1 (эвристический масштаб, не строгий LLR).
 *                         hfdlDeint хранит блок как Float32Array и не
 *                         квантует — soft проходит через деперемежитель без потерь.
 *   [НЕ ХВАТАЕТ]         CPDLC (AT1/CR1/CC1/DR1) — для позиций не нужен, не портировал
 *   [НЕ ХВАТАЕТ]         SPDU-разбор не подключён к диспетчеру (нет DSP-узла, только функция spduParse
 *                         в отдельном файле spdu.js — не перенесена сюда)
 * ========================================================================================== */

/* ---------- CRC-16/X-25 (HDLC FCS, HFDL LPDU/MPDU) ---------- */
// poly 0x8408 (=0x1021 отражённый), init 0xFFFF, финальный XOR 0xFFFF.
// Самопроверено на эталонном векторе CRC-16/X-25: "123456789" -> 0x906E.
function crc16_x25(buf, len){
  let crc=0xFFFF;
  for(let i=0;i<len;i++){
    crc^=buf[i];
    for(let b=0;b<8;b++) crc=(crc&1)?(crc>>>1)^0x8408:(crc>>>1);
  }
  return (crc^0xFFFF)&0xFFFF;
}
function hfdlPduFcsCheck(buf, hdrLen){
  const fcsCheck=buf[hdrLen]|(buf[hdrLen+1]<<8);
  return fcsCheck===crc16_x25(buf, hdrLen);
}

/* ---------- CRC-16/CCITT нерефлексированный (ACARS-конверт) ---------- */
// poly 0x1021, без отражения. Самопроверено на эталоне CRC-16/XMODEM: "123456789" -> 0x31C3.
function crc16_ccitt_true(buf, len, init){
  let crc=init>>>0;
  for(let i=0;i<len;i++){ crc^=(buf[i]<<8);
    for(let b=0;b<8;b++) crc=(crc&0x8000)?((crc<<1)^0x1021)&0xFFFF:(crc<<1)&0xFFFF; }
  return crc&0xFFFF;
}

/* ---------- ACARS-конверт (libacars, src/acars.c) ---------- */
const ACARS_DEL=0x7f, ACARS_ETX=0x03;
function acarsCandidateArinc622(label){
  if(!label||label.length<2) return false;
  const c0=label[0], c1=label[1];
  if((c0==='A'||c0==='B')&&(c1==='6'||c1==='A')) return true;
  return c0==='H'&&c1==='1';
}
function acarsParse(buf){
  let len=buf.length;
  if(len<16) return { err:true, reason:'too_short' };
  if(buf[len-1]!==ACARS_DEL) return { err:true, reason:'no_del' };
  len--;
  const crcOk=(crc16_ccitt_true(buf,len,0)===0);
  len-=3;
  if(len<12) return { err:true, reason:'too_short_after_strip', crcOk };
  const b2=new Uint8Array(len);
  for(let i=0;i<len;i++) b2[i]=buf[i]&0x7f;
  let k=0;
  const mode=String.fromCharCode(b2[k++]);
  let reg=''; for(let i=0;i<7;i++,k++) reg+=String.fromCharCode(b2[k]);
  let ack=b2[k++]; if(ack===0x15) ack='!'.charCodeAt(0); ack=String.fromCharCode(ack);
  let l0=b2[k++], l1=b2[k++]; if(l1===0x7f) l1='d'.charCodeAt(0);
  const label=String.fromCharCode(l0)+String.fromCharCode(l1);
  let blockId=b2[k++]; if(blockId===0) blockId=' '.charCodeAt(0); blockId=String.fromCharCode(blockId);
  const txtStart=b2[k];
  let no='', flightId='', txt='';
  if(k>=len || txtStart===ACARS_ETX) return { err:false, crcOk, mode, reg, ack, label, blockId, no, flightId, txt };
  k++;
  if(mode<='Z' && blockId<='9'){
    for(let i=0;i<4&&k<len;i++,k++) no+=String.fromCharCode(b2[k]);
    for(let i=0;i<6&&k<len;i++,k++) flightId+=String.fromCharCode(b2[k]);
  } else k--;
  const txtBytes=b2.subarray(k,len);
  for(let i=0;i<txtBytes.length;i++) txt+= txtBytes[i]===0?'.':String.fromCharCode(txtBytes[i]);
  const msgDir=(blockId>='0'&&blockId<='9')?'air2gnd':'gnd2air';
  return { err:false, crcOk, mode, reg, ack, label, blockId, no, flightId, txt, msgDir,
    arinc622Candidate: acarsCandidateArinc622(label) };
}

/* ---------- ADS-C (libacars, src/adsc.c) — только downlink-теги ---------- */
function bitReader(buf){
  let bitpos=0;
  return { read(n){ let v=0; for(let i=0;i<n;i++){
    const byteIdx=bitpos>>3, bitIdx=7-(bitpos&7);
    v=(v<<1)|((buf[byteIdx]>>bitIdx)&1); bitpos++; } return v>>>0; } };
}
function signExtend(v,bits){ const m=1<<(bits-1); return (v^m)-m; }
function adscCoord(c){ const r=signExtend(c,21); return (180.0-90.0/Math.pow(2,19))*r/0xfffff; }
function adscAlt(a){ return signExtend(a,16)*4; }
function adscTimestamp(t){ return t*0.125; }
function adscBasicReport(buf){
  const br=bitReader(buf);
  const lat=adscCoord(br.read(21)), lon=adscCoord(br.read(21));
  const alt=adscAlt(br.read(16)), timestamp=adscTimestamp(br.read(15));
  const flags=br.read(7);
  return { lat, lon, alt, timestamp, redundancy:flags&1, accuracy:(flags>>1)&7, tcas:(flags>>4)&1 };
}
function adscFlightId(buf){
  const br=bitReader(buf); let id='';
  for(let i=0;i<8;i++){ let tmp=br.read(6); if((tmp&0x20)===0) tmp+=0x40; id+=String.fromCharCode(tmp); }
  return id;
}
function adscAirframeId(buf){ return [...buf].map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase(); }
const ADSC_DOWNLINK_LEN={3:1,6:0,12:6,13:17,14:5,15:5,16:4,17:3,22:8,23:9,255:1,7:10,9:10,10:10,18:10,19:10,20:10};
function adscParseDownlink(buf){
  let pos=0; const tags=[];
  while(pos<buf.length){
    const tag=buf[pos]; pos++;
    let len;
    if(tag===4){ if(pos+2>buf.length) break; len=[1,2,7].includes(buf[pos+1])?3:2; }
    else if(tag===5) break;
    else len=ADSC_DOWNLINK_LEN[tag];
    if(len==null||pos+len>buf.length) break;
    const payload=buf.subarray(pos,pos+len);
    if(len===10 && [7,9,10,18,19,20].includes(tag)) tags.push({tag,report:adscBasicReport(payload)});
    else if(tag===17) tags.push({tag,icao:adscAirframeId(payload)});
    else if(tag===12) tags.push({tag,flightId:adscFlightId(payload)});
    else tags.push({tag,raw:payload.slice()});
    pos+=len;
  }
  return tags;
}

/* ---------- ARINC-622 конверт (libacars, src/arinc.c) ---------- */
const ARINC_IMI_MAP=[
  {imiString:'.AT1',imi:'AT1'},{imiString:'.CR1',imi:'CR1'},{imiString:'.CC1',imi:'CC1'},
  {imiString:'.DR1',imi:'DR1'},{imiString:'.ADS',imi:'ADS'},{imiString:'.DIS',imi:'DIS'},
];
function isNumericOrUppercase(str,off,len){
  for(let i=0;i<len;i++){ const c=str[off+i]; if(c===undefined) return false;
    if(!((c>='A'&&c<='Z')||(c>='0'&&c<='9'))) return false; }
  return true;
}
function guessArincMsgType(txt){                      // ищет первый по порядку IMI-тип, встретившийся где угодно в txt
  let imi=null, idx=-1;
  for(const m of ARINC_IMI_MAP){ const i=txt.indexOf(m.imiString); if(i>=0){ imi=m.imi; idx=i; break; } }
  if(imi===null) return null;
  let gsAddr=null;
  if(idx>=8 && (txt[idx-8]==='/'||txt[idx-8]===' ') && isNumericOrUppercase(txt,idx-7,7)) gsAddr=txt.substr(idx-7,7);
  if(gsAddr===null && idx>=5 && txt[idx-5]==='/' && isNumericOrUppercase(txt,idx-4,4)) gsAddr=txt.substr(idx-4,4);
  if(gsAddr===null) return null;
  return { imi, gsAddr, payload: txt.slice(idx+1) };  // idx+1 — только точку пропустить, "ADS"/"DIS" остаются в payload
}
function slurpHexString(str){                          // пары hex-символов → байты, до первого невалидного/конца строки
  const bytes=[];
  for(let i=0;i+1<str.length;i+=2){
    const byte=parseInt(str.substr(i,2),16);
    if(isNaN(byte)) break;
    bytes.push(byte);
  }
  return new Uint8Array(bytes);
}
function arincParse(txt){
  const g=guessArincMsgType(txt);
  if(!g) return null;
  const payload=g.payload;
  if(payload.length < 3+7+2*2) return null;             // IMI(3)+air_reg(7)+CRC(2 байта = 4 hex-символа) минимум
  const airReg=payload.slice(3,10);
  const buf=slurpHexString(payload.slice(10));
  if(buf.length<2) return null;
  const binBuf=buf.subarray(0,buf.length-2);            // последние 2 байта — CRC (la_check_crc16_arinc), не проверяю
  let adscTags=null;
  if(g.imi==='ADS'||g.imi==='DIS') adscTags=adscParseDownlink(binBuf);
  return { imi:g.imi, gsAddr:g.gsAddr, airReg, adscTags };
}
function adscPositionExtract(tags){                     // аналог adsc_position_info_extract (document #76)
  let report=null, icao=null, flightId=null;
  for(const t of tags){
    if(t.report) report=t.report;
    else if(t.icao) icao=parseInt(t.icao,16);
    else if(t.flightId) flightId=t.flightId;
  }
  if(!report) return null;
  const min=Math.trunc(report.timestamp/60), sec=Math.trunc(report.timestamp-60*min);
  return { lat:report.lat, lon:report.lon, icaoAddress:icao, flightId,
    ts:{ min, sec, minPresent:true, secPresent:true, hourPresent:false } };
}

/* ---------- HFNPDU (dumphfdl, src/hfdl/hfnpdu.c) ---------- */
const HFNPDU_TYPE={ SYSTEM_TABLE:0xD0, PERFORMANCE_DATA:0xD1, SYSTEM_TABLE_REQUEST:0xD2,
  FREQUENCY_DATA:0xD5, DELAYED_ECHO:0xDE, ENVELOPED_DATA:0xFF };
function signExtend20(v){ const m=1<<19; return (v^m)-m; }
function parseCoordinate20_UNVERIFIED(c){             // см. статус в шапке файла — не подтверждено
  const r=signExtend20(c); return (180.0-90.0/Math.pow(2,18))*r/0x7ffff;
}
function extractUint16(buf,off){ return buf[off]|(buf[off+1]<<8); }
function parseUtcTime(t){ return { hour:Math.floor(t/3600), min:Math.floor((t%3600)/60), sec:t%60 }; }
function bytesToAscii(buf,off,len){ let s=''; for(let i=0;i<len;i++) s+=String.fromCharCode(buf[off+i]); return s.replace(/\0.*$/,''); }
function performanceDataParse(buf){
  const LEN=47; if(buf.length<LEN) return null;
  const flightId=bytesToAscii(buf,2,6);
  let coord=buf[8]|(buf[9]<<8)|((buf[10]&0xF)<<16); const lat=parseCoordinate20_UNVERIFIED(coord);
  coord=((buf[10]&0xF0)>>4)|(buf[11]<<4)|(buf[12]<<12); const lon=parseCoordinate20_UNVERIFIED(coord);
  const utc=parseUtcTime(2*extractUint16(buf,13));
  return { flightId, lat, lon, utc, version:buf[15], flightLeg:buf[16], gsId:buf[17]&0x7F, freqId:buf[18] };
}
function frequencyDataParse(buf){
  const MIN_LEN=15, BLOCK=6, MAXF=6; if(buf.length<MIN_LEN) return null;
  const flightId=bytesToAscii(buf,2,6);
  let coord=buf[8]|(buf[9]<<8)|((buf[10]&0xF)<<16); const lat=parseCoordinate20_UNVERIFIED(coord);
  coord=((buf[10]&0xF0)>>4)|(buf[11]<<4)|(buf[12]<<12); const lon=parseCoordinate20_UNVERIFIED(coord);
  const utc=parseUtcTime(2*extractUint16(buf,13));
  const freqs=[];
  for(let f=0;f<MAXF;f++){ const pos=MIN_LEN+f*BLOCK; if(pos+BLOCK>buf.length) break;
    freqs.push({ gsId:buf[pos]&0x7F,
      propFreqs: buf[pos+1]|(buf[pos+2]<<8)|((buf[pos+3]&0xF)<<16),
      tunedFreqs: ((buf[pos+3]&0xF0)>>4)|(buf[pos+4]<<4)|(buf[pos+5]<<12) }); }
  return { flightId, lat, lon, utc, freqs };
}
function hfnpduParse(buf){
  if(buf.length===0) return null;
  if(buf[0]!==0xFF) return { notHfnpdu:true, raw:buf };
  if(buf.length<2) return { err:true, reason:'too_short' };
  const type=buf[1];
  switch(type){
    case HFNPDU_TYPE.PERFORMANCE_DATA: { const d=performanceDataParse(buf); return d?{type,data:d}:{type,err:true}; }
    case HFNPDU_TYPE.FREQUENCY_DATA: { const d=frequencyDataParse(buf); return d?{type,data:d}:{type,err:true}; }
    case HFNPDU_TYPE.ENVELOPED_DATA: {
      const am=acarsParse(buf.subarray(2));
      return { type, acars: am.err?null:am };
    }
    case HFNPDU_TYPE.SYSTEM_TABLE: case HFNPDU_TYPE.SYSTEM_TABLE_REQUEST: case HFNPDU_TYPE.DELAYED_ECHO:
      return { type };
    default: return { type, unknown:true };
  }
}

/* ---------- LPDU (dumphfdl, src/hfdl/lpdu.c) + кеш ac_id→ICAO ---------- */
const LPDU_TYPE={ UNNUMBERED_DATA:0x0D, UNNUMBERED_ACKED_DATA:0x1D, LOGON_DENIED:0x2F, LOGOFF_REQUEST:0x3F,
  LOGON_RESUME_CONFIRM:0x5F, LOGON_RESUME:0x4F, LOGON_REQUEST_NORMAL:0x8F, LOGON_CONFIRM:0x9F, LOGON_REQUEST_DLS:0xBF };
function parseIcaoHex(buf,off){ return (buf[off]<<16)|(buf[off+1]<<8)|buf[off+2]; }
function icaoToHex(v){ return v.toString(16).toUpperCase().padStart(6,'0'); }
const acCache=new Map();
function acCacheKey(freq,acId){ return freq+':'+acId; }
function acCacheCreate(freq,acId,icao){ acCache.set(acCacheKey(freq,acId), icao); }
function acCacheDelete(freq,icao){ for(const [k,v] of acCache) if(v===icao) acCache.delete(k); }
function acCacheLookup(freq,acId){ return acCache.get(acCacheKey(freq,acId)); }
function logonConfirmParse(buf){ if(buf.length<8) return null; return { icaoAddress:parseIcaoHex(buf,1), acId:buf[4] }; }
function logonRequestParse(buf){ if(buf.length<4) return null; return { icaoAddress:parseIcaoHex(buf,1) }; }
function logoffRequestParse(buf){ if(buf.length<5) return null; return { icaoAddress:parseIcaoHex(buf,1), reasonCode:buf[4] }; }
function lpduParse(buf, mpduHeader){
  const freq=mpduHeader.freq;
  if(buf.length<3) return { err:true, reason:'too_short' };
  const len=buf.length-2;
  if(!hfdlPduFcsCheck(buf,len)) return { err:true, reason:'bad_fcs', crcOk:false };
  const type=buf[0]; let consumed=0, data={};
  switch(type){
    case LPDU_TYPE.UNNUMBERED_DATA: case LPDU_TYPE.UNNUMBERED_ACKED_DATA: consumed=1; break;
    case LPDU_TYPE.LOGON_DENIED: case LPDU_TYPE.LOGOFF_REQUEST: {
      const r=logoffRequestParse(buf.subarray(0,len));
      if(r){ consumed=5; data=r; acCacheDelete(freq,r.icaoAddress); } else consumed=-1; break; }
    case LPDU_TYPE.LOGON_CONFIRM: case LPDU_TYPE.LOGON_RESUME_CONFIRM: {
      const r=logonConfirmParse(buf.subarray(0,len));
      if(r){ consumed=8; data=r; acCacheCreate(freq,r.acId,r.icaoAddress); } else consumed=-1; break; }
    case LPDU_TYPE.LOGON_RESUME: case LPDU_TYPE.LOGON_REQUEST_NORMAL: case LPDU_TYPE.LOGON_REQUEST_DLS: {
      const r=logonRequestParse(buf.subarray(0,len));
      if(r){ consumed=4; data=r; } else consumed=-1; break; }
    default: consumed=len;
  }
  if(consumed<0) return { err:true, reason:'malformed', type };
  const result={ err:false, crcOk:true, type, direction:mpduHeader.direction, mpduHeader, data };
  if(consumed<len) result.hfnpduPayload=buf.subarray(consumed,len);
  return result;
}
function lpduFillIcao(lpdu, posInfo){
  if(!posInfo || posInfo.icaoAddress!=null) return posInfo;
  if([LPDU_TYPE.LOGON_RESUME,LPDU_TYPE.LOGON_REQUEST_NORMAL,LPDU_TYPE.LOGON_REQUEST_DLS].includes(lpdu.type)){
    posInfo.icaoAddress=lpdu.data.icaoAddress; return posInfo; }
  const acId=lpdu.direction==='uplink'?lpdu.mpduHeader.dstId:lpdu.mpduHeader.srcId;
  const icao=acCacheLookup(lpdu.mpduHeader.freq, acId);
  if(icao!=null){ posInfo.icaoAddress=icao; return posInfo; }
  return null;
}

/* ---------- MPDU (dumphfdl, src/hfdl/mpdu.c) ---------- */
function parseLpduList(buf, sizePtr, dataPtr, len, lpduCnt, mpduHeader){
  const lpdus=[]; let consumed=0;
  for(let j=0;j<lpduCnt;j++){
    const lpduLen=buf[sizePtr]+1;
    if(dataPtr+lpduLen>len) return { err:true, reason:'lpdu_truncated' };
    const node=lpduParse(buf.subarray(dataPtr,dataPtr+lpduLen), mpduHeader);
    if(node) lpdus.push(node);
    dataPtr+=lpduLen; consumed+=lpduLen; sizePtr++;
  }
  return { err:false, lpdus, consumed };
}
function mpduParse(buf, freq){
  const len=buf.length; if(len<1) return { err:true, reason:'empty' };
  let lpduCnt=0, aircraftCnt=0, hdrLen=0; const aircraftBlocks=[]; let direction;
  if(buf[0]&0x2){ direction='downlink'; lpduCnt=(buf[0]>>2)&0xF; hdrLen=6+lpduCnt; }
  else {
    direction='uplink'; aircraftCnt=((buf[0]&0x70)>>4)+1; hdrLen=2;
    for(let i=0;i<aircraftCnt;i++){
      if(len<hdrLen+2) return { err:true, reason:'too_short_uplink_header' };
      const dstId=buf[hdrLen], cnt=(buf[hdrLen+1]>>4)&0xF;
      aircraftBlocks.push({dstId,lpduCnt:cnt}); hdrLen+=2+cnt;
    }
  }
  if(len<hdrLen+2) return { err:true, reason:'too_short' };
  if(!hfdlPduFcsCheck(buf,hdrLen)) return { err:true, reason:'bad_fcs' };
  let dataPtr=hdrLen+2; const lpdus=[];
  if(direction==='downlink'){
    const mpduHeader={ freq, direction, srcId:buf[2], dstId:buf[1]&0x7f, crcOk:true };
    const r=parseLpduList(buf,6,dataPtr,len,lpduCnt,mpduHeader);
    if(r.err) return { err:true, reason:r.reason };
    lpdus.push(...r.lpdus);
  } else {
    const srcId=buf[1]&0x7f; let sizePtr=2;
    for(const block of aircraftBlocks){
      const mpduHeader={ freq, direction, srcId, dstId:block.dstId, crcOk:true };
      const r=parseLpduList(buf,sizePtr,dataPtr,len,block.lpduCnt,mpduHeader);
      if(r.err) return { err:true, reason:r.reason };
      lpdus.push(...r.lpdus); sizePtr+=block.lpduCnt; dataPtr+=r.consumed;
    }
  }
  return { err:false, direction, lpdus };
}

/* ---------- position.c (валидность координат, достройка времени) ---------- */
function locationIsValid(lat,lon){ return Math.abs(lat)<=90.0 && Math.abs(lon)<=180.0; }
function fixupTimestamp(ts, now){
  now=now||new Date();
  let {hour,min,sec}=ts;
  if(!ts.secPresent) sec=0;
  if(!ts.hourPresent){
    const nowM=now.getUTCMinutes(), nowS=now.getUTCSeconds();
    hour=(min<nowM||(min===nowM&&sec<=nowS))?now.getUTCHours():(now.getUTCHours()>0?now.getUTCHours()-1:23);
  }
  let d=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate(),hour,min,sec));
  if(d.getTime()>now.getTime()) d=new Date(d.getTime()-86400000);
  return d;
}
function positionInfoExtract(posInfo, now){
  if(!posInfo || !locationIsValid(posInfo.lat,posInfo.lon)) return null;
  if(posInfo.ts) posInfo.timestamp=fixupTimestamp(posInfo.ts, now);
  return posInfo;
}

/* ---------- Витерби K=7 r=1/2 (libfec, Phil Karn KA9Q, LGPL) — HFDL FEC ---------- */
// Самопроверено round-trip: собственный энкодер теми же полиномами → 0 ошибок на чистом
// канале и при ~8% жёстко испорченных символов (200/160 бит тестовых прогонов).
const V27POLYA=0x6d, V27POLYB=0x4f;
function parityByte(x){ x^=x>>4; x^=x>>2; x^=x>>1; return x&1; }
function v27MakeBranchtab(polys){
  const bt=[new Uint8Array(32), new Uint8Array(32)];
  for(let k=0;k<2;k++){
    const inv=polys[k]<0, poly=Math.abs(polys[k]);
    for(let i=0;i<32;i++) bt[k][i]=(inv^parityByte((2*i)&poly))?255:0;
  }
  return bt;
}
function v27Create(polys){
  return { bt:v27MakeBranchtab(polys), oldM:new Int32Array(64), newM:new Int32Array(64), decisions:[] };
}
function v27Init(vp,startState){ vp.oldM.fill(63); vp.oldM[startState&63]=0; vp.decisions.length=0; }
function v27UpdateBlk(vp, syms){                      // syms: 0..255 мягкие символы, по 2 на шаг
  const nsteps=syms.length>>1;
  for(let s=0;s<nsteps;s++){
    const sym0=syms[2*s], sym1=syms[2*s+1];
    const dec=new Uint8Array(64);
    for(let i=0;i<32;i++){
      const metric=(vp.bt[0][i]^sym0)+(vp.bt[1][i]^sym1);
      let m0=vp.oldM[i]+metric, m1=vp.oldM[i+32]+(510-metric);
      let decision=(m0-m1)>0;
      vp.newM[2*i]=decision?m1:m0; dec[2*i]=decision?1:0;
      m0-=(metric+metric-510); m1+=(metric+metric-510);
      decision=(m0-m1)>0;
      vp.newM[2*i+1]=decision?m1:m0; dec[2*i+1]=decision?1:0;
    }
    vp.decisions.push(dec);
    const tmp=vp.oldM; vp.oldM=vp.newM; vp.newM=tmp;
  }
}
function v27Chainback(vp, nbits, endstate){           // nbits — данные, БЕЗ хвостовых 6 пар
  const data=new Uint8Array((nbits+7)>>3);
  endstate=(endstate&63)<<2;
  let n=nbits;
  while(n!==0){
    n--;
    const state=endstate>>2;
    const k=vp.decisions[6+n][state];
    endstate=(endstate>>1)|(k<<7);
    data[n>>3]=endstate;
  }
  return data;
}

/* ==========================================================================================
 * DSP-модуль: принимает биты (blk, как из hfdlDeint) → гоняет через весь стек выше.
 * ВАЖНО про типы портов: num/txt-порты в этом движке — обычные JS-числа/строки,
 * НЕ поблочные буферы (в отличие от 'sig'). См. пример 'lfo': process возвращает
 * {out:число}, а не Float32Array.
 * ========================================================================================== */
def({ id:'hfdlViterbi', title:'Viterbi K=7 r=1/2 (HFDL FEC)', cat:'Decoders', readout:true,
  ins:[{n:'blk',t:'blk'}],
  outs:[{n:'blk',t:'blk'}],
  params:[{n:'polyConv',t:'select',opts:['raw (no convention)','NASA-DSN','CCSDS'],d:'raw (no convention)',
           label:'polynomial convention'},
          {n:'endstate',t:'num',d:0,label:'end state (usually 0 — zero tail)'}],
  init:n=>{ n.bid=-1; n.txt='no data'; },
  process(n,I){
    const b=I.blk;
    if(!b || b.id===n.bid) return { blk:n.blkOut||null };
    n.bid=b.id;
    const polys = n.p.polyConv==='NASA-DSN' ? [-V27POLYA, V27POLYB]
                : n.p.polyConv==='CCSDS' ? [V27POLYB, -V27POLYA]
                : [V27POLYA, V27POLYB];
    // вход: b.d — мягкие/жёсткие символы в диапазоне -1..1, конвенция как везде в этом движке
    // (bit=1 → +1, bit=0 → -1, см. hfdlA()) → сюда: -1→0 (уверенный 0), +1→255 (уверенная 1)
    const nSteps=Math.floor(b.n/2);
    const syms=new Uint8Array(nSteps*2);
    for(let i=0;i<nSteps*2;i++){
      const v=b.d[i];
      syms[i]=Math.max(0,Math.min(255, Math.round((v+1)*127.5)));
    }
    const nbits=nSteps;                                 // HFDL НЕ добавляет хвостовые нули кодера
                                                          // (сверено с hfdl.c: viterbi_output_len =
                                                          // viterbi_input_len/CONV_CODE_RATE, без -6).
                                                          // НО v27Chainback физически требует ещё 6 шагов
                                                          // запаса в решётке (decisions[6+n]) — паддинг
                                                          // нейтральными (128) символами, чтобы получить
                                                          // все nSteps бит без выхода за границы массива.
    if(nbits<=0){ n.txt='block too short'; return { blk:n.blkOut||null }; }
    const symsPadded=new Uint8Array((nSteps+6)*2);
    symsPadded.set(syms); symsPadded.fill(128, nSteps*2);
    const vp=v27Create(polys);
    v27Init(vp,0);
    v27UpdateBlk(vp,symsPadded);
    const bytes=v27Chainback(vp, nbits, n.p.endstate|0);
    const outBits=new Float32Array(nbits);
    for(let i=0;i<nbits;i++) outBits[i]=((bytes[i>>3]>>(7-(i%8)))&1)?1:-1;
    n.blkOut={ d:outBits, n:nbits, id:b.id };
    n.txt='bits decoded: '+nbits;
    return { blk:n.blkOut };
  },
  draw(n){ n.el.querySelector('.readout').textContent=n.txt; }});

/* ---------- PHY-слой HFDL (dumphfdl hfdl.c + liquid-dsp modem_psk.c) ---------- */
// Таблица параметров кадра по M1-индексу, реверс байта после Витерби, усреднение chip'ов
// для rate=1/4, деперемежитель с раздельными push/pop сдвигами, символ→биты (Грей+фазовый
// сдвиг, порядок бит MSB-первым) — всё выведено из присланных исходников, самопроверено.
const HFDL_FRAME_PARAMS = [
  { scheme:'BPSK', dataSegmentCnt:72,  codeRate:4, deintPushShift:17 },
  { scheme:'BPSK', dataSegmentCnt:72,  codeRate:2, deintPushShift:17 },
  { scheme:'QPSK', dataSegmentCnt:72,  codeRate:2, deintPushShift:17 },
  { scheme:'8PSK', dataSegmentCnt:72,  codeRate:2, deintPushShift:17 },
  { scheme:'BPSK', dataSegmentCnt:168, codeRate:4, deintPushShift:23 },
  { scheme:'BPSK', dataSegmentCnt:168, codeRate:2, deintPushShift:23 },
  { scheme:'QPSK', dataSegmentCnt:168, codeRate:2, deintPushShift:23 },
  { scheme:'8PSK', dataSegmentCnt:168, codeRate:2, deintPushShift:23 },
];
const HFDL_SCHEME_BITS = { BPSK:1, QPSK:2, '8PSK':3 };
const DEINTERLEAVER_ROW_CNT=40, DEINTERLEAVER_POP_ROW_SHIFT=9, DATA_FRAME_LEN=30;
const M2_LEN=15, T_LEN=15;                            // длины участков M2-пропуска и тренировочной BPSK-последовательности
const T_REF=0x9AF;                                    // эталонная 15-битная T-последовательность (hfdl.c), не зависит от FEC-стека

function reverseByte(b){                              // REVERSE_BYTE — ОБЯЗАТЕЛЕН после Витерби, до mpduParse
  b=((b&0xF0)>>4)|((b&0x0F)<<4);
  b=((b&0xCC)>>2)|((b&0x33)<<2);
  b=((b&0xAA)>>1)|((b&0x55)<<1);
  return b;
}
function reverseBytes(bytes){
  const out=new Uint8Array(bytes.length);
  for(let i=0;i<bytes.length;i++) out[i]=reverseByte(bytes[i]);
  return out;
}
function averageChipPairs(bits){                      // для code_rate=4 — каждый чип передан дважды
  const out=new Uint8Array(bits.length>>1);
  for(let i=0;i<out.length;i++){ const a=bits[2*i], b=bits[2*i+1]; out[i]=(a&b)+((a^b)>>1); }
  return out;
}
function makeDeinterleaver(m1Index){                  // push со сдвигом из таблицы, pop — фикс. шаг 9
  const p=HFDL_FRAME_PARAMS[m1Index];
  const bitsPerSym=HFDL_SCHEME_BITS[p.scheme];
  const colCnt=Math.floor(p.dataSegmentCnt*DATA_FRAME_LEN*bitsPerSym/DEINTERLEAVER_ROW_CNT);
  const table=Array.from({length:DEINTERLEAVER_ROW_CNT},()=>new Uint8Array(colCnt));
  let pRow=0,pCol=0, gRow=0,gCol=0;
  return { colCnt,
    push(val){ table[pRow][pCol]=val; pRow++;
      if(pRow===DEINTERLEAVER_ROW_CNT){ pRow=0; pCol++; }
      pCol-=p.deintPushShift; if(pCol<0) pCol+=colCnt; },
    pop(){ const ret=table[gRow][gCol];
      gRow=(gRow+DEINTERLEAVER_POP_ROW_SHIFT)%DEINTERLEAVER_ROW_CNT;
      if(gRow===0) gCol++; return ret; }
  };
}
function grayEncode(b){ return b ^ (b>>1); }
function grayDecode(g){ let b=g; for(let s=1;s<16;s<<=1) b^=(b>>s); return b; }
function pskPhaseOffset(M){ return Math.PI*(1-1/M); }
function symbolToBits(angleRad, bitsPerSym){          // угол → сектор(со сдвигом) → Грей → биты MSB-первым
  const M=1<<bitsPerSym, st=2*Math.PI/M;
  let d=angleRad-pskPhaseOffset(M);
  d=((d%(2*Math.PI))+2*Math.PI)%(2*Math.PI);
  const kNatural=Math.round(d/st)%M;
  const kGray=grayEncode(kNatural);
  const bits=new Array(bitsPerSym);
  for(let b=0;b<bitsPerSym;b++) bits[b]=(kGray>>(bitsPerSym-1-b))&1;
  return bits;
}
// мягкая версия symbolToBits: та же геометрия созвездия (Грей, тот же offset),
// но вместо одного сектора — расстояние до ближайших точек с bit=0/1 на каждой
// позиции. Эвристический масштаб (/2), не строгий LLR, но даёт Витерби запас
// метрики вместо жёсткого ±1 на QPSK/8PSK (раньше был именно жёсткий вариант).
function symbolToSoftBits(ii, qq, bitsPerSym){
  const M=1<<bitsPerSym, st=2*Math.PI/M, off=pskPhaseOffset(M);
  const d0=new Array(bitsPerSym).fill(Infinity), d1=new Array(bitsPerSym).fill(Infinity);
  for(let k=0;k<M;k++){
    const a=off+k*st, px=Math.cos(a), py=Math.sin(a);
    const dist=(ii-px)*(ii-px)+(qq-py)*(qq-py);
    const g=grayEncode(k);
    for(let b=0;b<bitsPerSym;b++){
      const bit=(g>>(bitsPerSym-1-b))&1;
      const arr=bit?d1:d0;
      if(dist<arr[b]) arr[b]=dist;
    }
  }
  const out=new Array(bitsPerSym);
  for(let b=0;b<bitsPerSym;b++) out[b]=clamp((d0[b]-d1[b])/2,-1,1);   // >0 → бит=1
  return out;
}

function hfdlLfsr(){                                 // та же 120-битная фикс. последовательность используется в hfdlDescr
  let state=0x4d4b; const g=0x4001, mask=(1<<15)-1, out=[];
  for(let i=0;i<120;i++){
    let x=state&g, b=0; while(x){ b^=x&1; x>>=1; }
    state=((state<<1)|b)&mask;
    out.push(b);
  }
  return out;
}

// Таблица M1 из hfdl.c (M1_bits, M_shifts) — те же 127 бит, циклически сдвинутые на 8
// разных величин, каждый сдвиг = одна из 8 комбинаций скорость/слот.
const HFDL_M1_BITS=[0,1,1,1,0,1,1,0,1,1,1,1,0,1,0,0,0,1,0,1,1,0,0,
  1,0,1,1,1,1,1,0,0,0,1,0,0,0,0,0,0,1,1,0,0,1,1,0,1,1,
  0,0,0,1,1,1,0,0,1,1,1,0,1,0,1,1,1,0,0,0,0,1,0,0,1,1,
  0,0,0,0,0,1,0,1,0,1,0,1,1,0,1,0,0,1,0,0,1,0,1,0,0,1,
  1,1,1,0,0,1,0,0,0,1,1,0,1,0,1,0,0,0,0,1,1,1,1,1,1,1];
const HFDL_M1_SHIFTS=[72,82,113,123,61,103,93,9];
const HFDL_M1_LEN=127;
// A-последовательность (127 бит) — идёт ДВАЖДЫ перед M1 в реальном кадре (A1, затем A2 через
// 127 символов), взята из настоящего hfdl.c (dumphfdl) как есть. У нас раньше её не было вообще —
// Костас шёл прямо в поиск M1 без предварительного разгона/проверки. Сверено с исходником,
// но узла-детектора и подключения в граф ЕЩЁ НЕТ — сама по себе константа decode не чинит
// (проверено: наивный гейт "M1 доверяем только если недавно была A1" не снизил train-BER,
// потому что наша A-корреляция страдает от той же слабости демода, что и M1). Нужен более
// качественный front-end (Гарднер/Костас), не просто использование этой константы. См. SESSION_NOTES.md.
const HFDL_A_LEN=127;
const HFDL_A_BITS=[-1,1,-1,1,1,-1,1,1,1,-1,1,1,1,1,-1,-1,-1,1,1,1,-1,1,-1,-1,-1,1,-1,1,-1,1,1,1,-1,-1,-1,-1,-1,-1,1,1,1,1,-1,1,1,-1,-1,1,1,-1,-1,-1,1,-1,-1,1,-1,-1,1,1,1,-1,-1,1,1,1,1,1,-1,-1,1,-1,-1,-1,-1,-1,1,-1,-1,-1,1,1,-1,1,-1,1,-1,1,-1,-1,1,1,-1,1,1,-1,1,-1,-1,1,-1,1,-1,-1,-1,-1,1,-1,1,1,-1,-1,-1,-1,1,1,-1,-1,1,-1,1,1,1,1,1,1,1];
function hfdlM1Bits(shift){                           // ±1, как и остальные образцы в corr
  const out=new Int8Array(HFDL_M1_LEN);
  for(let j=0;j<HFDL_M1_LEN;j++) out[j]=HFDL_M1_BITS[(shift+j)%HFDL_M1_LEN]?1:-1;
  return out;
}

// Аналог match_sequence() из hfdl.c: пробует все 8 шаблонов M1 одновременно на одном
// скользящем окне, выдаёт индекс победителя (m1) и импульс начала кадра (go), когда
// корреляция уверенно выше порога — так что заранее знать скорость станции НЕ нужно.
def({ id:'hfdlM1Match', title:'HFDL: M1 Detector (rate)', cat:'Protocols', readout:true,
  ins:[{n:'in',t:'sig'},{n:'baud',t:'num'},{n:'thr',t:'num'}],
  outs:[{n:'go',t:'sig'},{n:'m1',t:'num'},{n:'peak',t:'num'},{n:'corr',t:'sig'},{n:'flip',t:'num'}],
  view:{h:80}, resize:true,
  params:[{n:'baud',t:'range',min:1,max:4800,step:.01,d:1800,log:true},
          {n:'thr',t:'range',min:.1,max:1,step:.01,d:.5,label:'threshold'},
          {n:'dead',t:'range',min:0,max:5000,step:1,d:1500,label:'dead time, ms'}],
  // 'flip' — знак сырой (не abs) корреляции в момент пика: BPSK-Костас ловит фазу
  // с точностью до 180°, знак говорит, в какую именно из двух он попал (см. hfdl.c:
  // c->bitmask = corr_A1 > 0 ? 0 : ~0, применяется как доп. инверсия ко всем data-символам).
  init:n=>{ n.m1=0; n.m2=0; n.dead=0; n.peak=0; n.m1out=0; n.flipOut=0; n.lastSign=0;
    n.txt='searching M1…'; n.hist=[]; n.curIdx=0; n.curC=0; },
  process(n,I){
    if(typeof I.baud==='number') setMod(n,'baud',I.baud);
    if(typeof I.thr==='number') setMod(n,'thr',I.thr);
    const og=buf(n,'go'), oc=buf(n,'corr');
    const sps=Math.max(1,Eng.sr/n.p.baud);
    const key=sps.toFixed(3);
    if(n.key!==key){
      n.key=key;
      n.tmpl=HFDL_M1_SHIFTS.map(sh=>hfdlM1Bits(sh));
      const P=HFDL_M1_LEN;
      n.taps=new Int32Array(P);
      for(let k=0;k<P;k++) n.taps[k]=Math.round(k*sps);
      n.L=n.taps[P-1]+1; n.ring=new Float32Array(n.L); n.w=0; n.ss=0; n.P=P;
    }
    const P=n.P, L=n.L, ring=n.ring, taps=n.taps;
    let bestOverBlock=0, bestIdxOverBlock=n.curIdx, rawAccMax=0, rmsLast=0;
    for(let i=0;i<BLOCK;i++){
      const old=ring[n.w], nv=I.in?I.in[i]:0;
      n.ss += nv*nv - old*old;
      ring[n.w]=nv;
      const rms=Math.sqrt(Math.max(0,n.ss)/L);
      rmsLast=rms;
      let bestC=0, bestIdx=0, bestRawAcc=0, bestAcc=0;
      for(let sIdx=0;sIdx<8;sIdx++){
        const pat=n.tmpl[sIdx];
        let acc=0;
        for(let k=0;k<P;k++) acc+=ring[(n.w-taps[k]+L*2)%L]*pat[P-1-k];
        const c=clamp(Math.abs(acc/(P*rms+1e-9)),0,2);   // ЗАЩИТА: без неё при просадке rms→0 значение улетало в тысячи
        if(c>bestC){ bestC=c; bestIdx=sIdx; bestRawAcc=Math.abs(acc); bestAcc=acc; }
      }
      if(bestRawAcc>rawAccMax) rawAccMax=bestRawAcc;
      oc[i]=bestC;
      if(bestC>bestOverBlock){ bestOverBlock=bestC; bestIdxOverBlock=bestIdx; }
      let hit=(n.m1>=n.p.thr && n.m1>n.m2 && n.m1>=bestC);
      if(n.dead>0){ n.dead--; hit=false; }
      else if(hit) n.dead=Math.round(n.p.dead*Eng.sr/1000);
      og[i]=hit?1:0;
      if(hit){ n.m1out=n.lastIdx; n.peak=n.m1; n.flipOut=n.lastSign<0?1:0; }
      n.m2=n.m1; n.m1=bestC; n.lastIdx=bestIdx; n.lastSign=bestAcc;
      n.w=(n.w+1)%L;
    }
    n.curC=n.curC*.8+bestOverBlock*.2; n.curIdx=bestIdxOverBlock;   // сглаженная "текущая" оценка для живого статуса
    n.hist.push(bestOverBlock); if(n.hist.length>200) n.hist.shift();
    // rms/rawAcc — для диагностики: если rms не реагирует на всплеск, сигнал не доходит с амплитудой
    // (проблема раньше по цепочке); если rms реагирует, а rawAcc/rms(=corr) — нет, значит демодулированные
    // биты не совпадают ни с одним шаблоном M1 (Костас/RRC/Гарднер дают не то, что ожидается).
    n.txt='now: '+n.curC.toFixed(2)+' (M1='+n.curIdx+')  ·  RMS='+rmsLast.toFixed(4)+
      '  ·  raw corr='+rawAccMax.toFixed(2)+'  ·  last hit: M1='+n.m1out+' peak '+n.peak.toFixed(2);
    return { go:og, m1:n.m1out, peak:n.peak, corr:oc, flip:n.flipOut };
  },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height; cx.clearRect(0,0,W,H);
    cx.strokeStyle='#e05c5c66'; cx.beginPath();
    const ty=H-Math.min(1,n.p.thr/2)*H; cx.moveTo(0,ty); cx.lineTo(W,ty); cx.stroke();
    cx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--t-sig');
    cx.beginPath();
    for(let i=0;i<n.hist.length;i++){ const x=i/200*W, y=H-clamp(n.hist[i]/2,0,1)*H;
      i?cx.lineTo(x,y):cx.moveTo(x,y); }
    cx.stroke();
    n.el.querySelector('.readout').textContent=n.txt;
  }});

// Планировщик схемы модуляции для costas.order: та же самая state-machine кадра
// (M2→9×тренировка→[данные+тренировка]), что в hfdlSymToBits, но выдаёт ТОЛЬКО номер
// текущей схемы (1=BPSK/2=QPSK/3=8PSK) как sig — Костас переключается синхронно с фреймером,
// а не молотит один и тот же (обычно неверный для преамбулы/тренировки) режим весь кадр.
// Держи ОБА узла (этот и hfdlSymToBits) на одних и тех же go/m1 — иначе разъедутся по времени.
def({ id:'hfdlOrderSched', title:'HFDL: Modulation Scheme Planner', cat:'Decoders', readout:true,
  ins:[{n:'clk',t:'sig'},{n:'go',t:'sig'},{n:'m1',t:'num'}],
  outs:[{n:'order',t:'sig'}],
  params:[{n:'m1',t:'range',min:0,max:7,step:1,d:3,label:'M1 (if go/m1 not connected)'}],
  init:n=>{ n.prevClk=0; n.prevGo=0; n.armed=false; n.state='idle'; n.symCtr=0; n.trainRep=0; n.cur=1; n.txt='waiting for frame'; },
  process(n,I){
    const o=buf(n,'order');
    for(let i=0;i<BLOCK;i++){
      const go=I.go?I.go[i]:0;
      if(go>0.5 && n.prevGo<=0.5) n.armed=true;
      n.prevGo=go;
      const c=I.clk?I.clk[i]:0;
      if(c>.5 && n.prevClk<=.5){
        if(n.armed){
          n.armed=false;
          const m1=typeof I.m1==='number'?(I.m1|0):n.p.m1;
          const p=HFDL_FRAME_PARAMS[clamp(m1,0,7)];
          n.bps=HFDL_SCHEME_BITS[p.scheme];
          n.dataSegLeft=p.dataSegmentCnt;
          n.state='M2'; n.symCtr=0; n.cur=1;
        }
        if(n.state!=='idle'){
          n.symCtr++;
          switch(n.state){
            case 'M2':
              if(n.symCtr>=M2_LEN){ n.state='EQTRAIN'; n.symCtr=0; n.trainRep=1; n.cur=1; }
              break;
            case 'EQTRAIN':
              if(n.symCtr>=T_LEN){
                n.symCtr=0;
                if(n.trainRep<9){ n.trainRep++; }
                else { n.state = n.dataSegLeft>0 ? 'DATA' : 'idle'; n.cur = n.state==='DATA'?n.bps:1; }
              }
              break;
            case 'DATA':
              if(n.symCtr>=DATA_FRAME_LEN){ n.symCtr=0; n.state='TRAIN'; n.cur=1; }
              break;
            case 'TRAIN':
              if(n.symCtr>=T_LEN){
                n.symCtr=0; n.dataSegLeft--;
                n.state = n.dataSegLeft>0 ? 'DATA' : 'idle';
                n.cur = n.state==='DATA'?n.bps:1;
              }
              break;
          }
        }
      }
      n.prevClk=c;
      o[i]=n.cur;
    }
    n.txt=n.state+' · order='+n.cur;
    return { order:o };
  },
  draw(n){ n.el.querySelector('.readout').textContent=n.txt; }});

def({ id:'hfdlSymToBits', title:'HFDL: Symbol→Bits (I/Q, with framer)', cat:'Decoders', readout:true, resize:true,
  ins:[{n:'I',t:'sig'},{n:'Q',t:'sig'},{n:'clk',t:'sig'},{n:'go',t:'sig'},{n:'m1',t:'num'},{n:'flip',t:'num'}],
  outs:[{n:'blk',t:'blk'},{n:'m1',t:'num'}],
  params:[{n:'m1',t:'range',min:0,max:7,step:1,d:3,label:'M1 (0-7, if go/m1 not connected)'},
          {n:'descramble',t:'check',d:true,label:'descramble (per-symbol LFSR)'},
          {n:'eqBw',t:'range',min:0,max:.5,step:.005,d:.1,label:'equalizer adaptation rate'}],
  // Между M1 и данными в реальном кадре НЕ сплошной поток payload-символов (см. hfdl.c):
  // M2(15, пропуск) → EQ_TRAIN(15×9, пропуск, BPSK для эквалайзера) →
  // [ДАННЫЕ 30][TRAIN 15] × dataSegmentCnt раз. Без этого фреймера тренировочные символы
  // подмешивались бы в поток данных, и деперемежитель/Витерби получали бы мусор
  // независимо от того, насколько верно подобраны дескремблинг/сдвиги/полином.
  // 'go' — sig-импульс от hfdlM1Match (не num!), фронт ищется посэмпловo и "вооружает"
  // сброс состояния, который реально срабатывает на ближайшем такте 'clk' — иначе
  // фреймер стартовал бы не в границе символа.
  //
  // Выход 'm1' — СВОЙ, синхронизированный с текущим кадром (то M1, с которым этот кадр
  // реально начался), а НЕ проксирование hfdlM1Match.m1 напрямую. Это важно: hfdlM1Match.m1 —
  // "живой" сигнал, который может успеть смениться на СЛЕДУЮЩИЙ кадр, пока текущий кадр ещё
  // копится здесь и идёт через hfdlDeint — на практике это давало hfdlChipAvg (и любому
  // другому узлу ниже по цепочке, который сам не фреймирует) СТАРОЕ/чужое M1, не совпадающее
  // с реально обрабатываемым blk. Бери m1 отсюда, а не из hfdlM1Match, для всего, что стоит
  // ПОСЛЕ этого узла.
  // Между Костас/Гарднер и решением по биту в оригинале стоит ещё адаптивный LMS-эквалайзер
  // (eqlms_cccf, 15 отводов) — обучается прямо на известной T-последовательности во время
  // EQTRAIN/TRAIN и компенсирует КВ-канал (многолучевость/ISI) ПЕРЕД демодуляцией. Без него
  // Костас с Гарднером могут быть идеально захвачены, а посимвольное решение всё равно
  // мусор — именно это и наблюдалось на реальных записях (M1 находится матч-фильтром по
  // 127 символам, устойчивым к лёгкому ISI, а единичное решение по символу — нет).
  // T-обучение continuous: тренировка есть и в преамбуле (9×EQTRAIN), и после каждого
  // DATA-сегмента (TRAIN) — эквалайзер переобучается весь кадр, отслеживая уход канала.
  init:n=>{ n.prevClk=0; n.prevGo=0; n.armed=false; n.bits=[]; n.bid=0; n.txt='waiting for frame (go)';
    n.state='idle'; n.symCtr=0; n.trainRep=0; n.hf=0; n.curM1=0; n.curFlip=0;
    n.trainAcc=0; n.trainErr=0; n.trainTot=0;
    n.eqHr=new Float32Array(15); n.eqHi=new Float32Array(15);   // история (raw, до эквализации)
    n.eqTr=new Float32Array(15); n.eqTi=new Float32Array(15);   // отводы фильтра
    n.eqTr[7]=1; },                                             // старт как пропускающий фильтр (единичный центр. отвод)
  process(n,I){
    if(!n.hseq) n.hseq=hfdlLfsr();
    for(let i=0;i<BLOCK;i++){
      const go=I.go?I.go[i]:0;
      if(go>0.5 && n.prevGo<=0.5) n.armed=true;         // фронт запомнили, ждём ближайший clk
      n.prevGo=go;

      const c=I.clk?I.clk[i]:0;
      if(c>.5 && n.prevClk<=.5){
        let justArmed=false;
        if(n.armed){
          n.armed=false; justArmed=true;
          const m1=typeof I.m1==='number'?(I.m1|0):n.p.m1;
          n.curM1=m1;                                    // фиксируем M1 именно на старте ЭТОГО кадра
          n.curFlip=typeof I.flip==='number'?(I.flip|0):0; // 180°-неоднозначность BPSK-Костас, тоже на старте кадра
          const p=HFDL_FRAME_PARAMS[clamp(m1,0,7)];
          n.bps=HFDL_SCHEME_BITS[p.scheme];
          n.dataSegLeft=p.dataSegmentCnt;
          n.state='M2'; n.symCtr=0; n.hf=0; n.bits.length=0; n.trainAcc=0; n.trainErr=0; n.trainTot=0;
          n.eqHr.fill(0); n.eqHi.fill(0); n.eqTr.fill(0); n.eqTi.fill(0); n.eqTr[7]=1;
          n.txt='frame started, M1='+m1+' ('+p.scheme+')';
        }
        // symCtr должен стартовать СО СЛЕДУЮЩЕГО тика после 'go' — сам тик, на котором сработал
        // armed, ещё "принадлежит" концу M1, а не M2. Раньше он ошибочно засчитывался первым
        // символом M2, из-за чего вся граница M2→EQTRAIN→DATA была сдвинута на 1 символ раньше
        // истинной (проверено побитово против настоящего dumphfdl: наши DATA-биты совпадали
        // с истинными 30/30 только при искусственном сдвиге +1 — вот его источник).
        if(n.state!=='idle' && !justArmed){
          let ii=I.I?I.I[i]:0, qq=I.Q?I.Q[i]:0;
          const isData=(n.state==='DATA');
          const isTrain=(n.state==='EQTRAIN'||n.state==='TRAIN');
          if(isData||isTrain){
            const Hr=n.eqHr, Hi=n.eqHi, Tr=n.eqTr, Ti=n.eqTi;
            for(let k=14;k>0;k--){ Hr[k]=Hr[k-1]; Hi[k]=Hi[k-1]; }
            Hr[0]=ii; Hi[0]=qq;
            let eqI=0, eqQ=0;
            for(let k=0;k<15;k++){ eqI+=Tr[k]*Hr[k]-Ti[k]*Hi[k]; eqQ+=Tr[k]*Hi[k]+Ti[k]*Hr[k]; }
            if(isTrain){
              const tBit=(T_REF>>(14-n.symCtr))&1;                // T_REF: см. ниже, бит по позиции внутри T-блока
              const desired=(tBit^n.curFlip)?1:-1;                // train всегда BPSK, эталон чисто вещественный
              const errRe=desired-eqI, errIm=-eqQ;
              let pow=1e-6; for(let k=0;k<15;k++) pow+=Hr[k]*Hr[k]+Hi[k]*Hi[k];
              const mu=n.p.eqBw/pow;                              // NLMS: без этого отводы просто росли по амплитуде,
              for(let k=0;k<15;k++){                               // "уверенность" метрики росла, а реальный BER — нет
                Tr[k]+=mu*(Hr[k]*errRe+Hi[k]*errIm);
                Ti[k]+=mu*(Hr[k]*errIm-Hi[k]*errRe);
              }
            }
            ii=eqI; qq=eqQ;
          }
          // train-BER: жёсткий бит тренировки (уже после эквалайзера) против известного T=0x9AF —
          // независимый от деперемежителя/Витерби замер, hfdl.c: bit ^= bitmask&1
          if(isTrain) n.trainAcc=((n.trainAcc<<1)|((ii>0?1:0)^n.curFlip))&0x7fff;
          // ЛФСР сдвигается только на data-символах (descrambler_advance вызывается
          // только внутри decode_user_data в оригинале — не на train/M2)
          if(isData){
            let flip=n.curFlip;                          // hfdl.c: phase_flip[descrambler_bit]*phase_flip[bitmask&1]
            if(n.p.descramble && n.hseq[n.hf]) flip^=1;
            if(flip){ ii=-ii; qq=-qq; }
            n.hf=(n.hf+1)%120;
          }
          n.symCtr++;
          switch(n.state){
            case 'M2':
              if(n.symCtr>=M2_LEN){ n.state='EQTRAIN'; n.symCtr=0; n.trainRep=1; }
              break;
            case 'EQTRAIN':
              if(n.symCtr>=T_LEN){
                n.symCtr=0;
                let x=n.trainAcc^T_REF, e=0; while(x){ e+=x&1; x>>=1; } n.trainErr+=e; n.trainTot+=T_LEN;
                if(n.trainRep<9){ n.trainRep++; }
                else n.state = n.dataSegLeft>0 ? 'DATA' : 'idle';
              }
              break;
            case 'DATA':
              if(n.bps===1){
                // BPSK — угол/Грей-код не нужны, знак=бит. Отдаём саму проекцию I как
                // мягкое значение (не hard-quantized ±1) — на реальной записи именно
                // огрубление здесь до жёсткого решения съедало запас по метрике Витерби.
                n.bits.push(clamp(ii,-1,1));
              } else {
                const sb=symbolToSoftBits(ii, qq, n.bps);
                for(const v of sb) n.bits.push(v);          // мягкие биты, не жёсткое решение
              }
              if(n.symCtr>=DATA_FRAME_LEN){ n.symCtr=0; n.state='TRAIN'; }
              break;
            case 'TRAIN':
              if(n.symCtr>=T_LEN){
                n.symCtr=0; n.dataSegLeft--;
                let x=n.trainAcc^T_REF, e=0; while(x){ e+=x&1; x>>=1; } n.trainErr+=e; n.trainTot+=T_LEN;
                n.state = n.dataSegLeft>0 ? 'DATA' : 'idle';
                if(n.state==='idle') n.txt='frame assembled: '+n.bits.length+' bits · train-BER '+
                  (100*n.trainErr/n.trainTot).toFixed(1)+'% ('+n.trainErr+'/'+n.trainTot+')';
              }
              break;
          }
        }
      }
      n.prevClk=c;
    }
    let blk=null;
    if(n.state==='idle' && n.bits.length>0){
      const d=new Float32Array(n.bits); n.bits=[];
      n.bid++;
      blk={ d, n:d.length, id:n.bid };
    } else if(n.state!=='idle') n.txt=n.state+' ('+n.symCtr+'), data collected: '+n.bits.length;
    return { blk, m1:n.curM1 };
  },
  draw(n){ n.el.querySelector('.readout').textContent=n.txt; }});

// Мост между hfdlDeint и Витерби: для BPSK-скоростей (M1=0,1,4,5) codeRate=4 — каждый чип
// передан дважды, нужно попарно усреднить ПЕРЕД Витерби (иначе решётка получает вдвое
// больше "бит", чем реально закодировано, и разъезжается независимо от всего остального).
// Для codeRate=2 (QPSK/8PSK) — просто пропускает как есть, без усреднения.
// Крошечный мост: M1 -> нужный сдвиг push для hfdlDeint (17 один слот / 23 два слота).
// Та же таблица HFDL_FRAME_PARAMS, что и везде — держит одно место истины по параметрам M1.
def({ id:'hfdlShiftFromM1', title:'HFDL: Deinterleaver Shift from M1', cat:'Decoders', readout:true,
  ins:[{n:'m1',t:'num'}], outs:[{n:'shiftCols',t:'num'}],
  params:[{n:'m1',t:'range',min:0,max:7,step:1,d:3,label:'M1 (if input not connected)'}],
  process(n,I){
    const m1=typeof I.m1==='number'?(I.m1|0):n.p.m1;
    const s=HFDL_FRAME_PARAMS[clamp(m1,0,7)].deintPushShift;
    n.txt='M1='+m1+' → shift '+s;
    return { shiftCols:s };
  },
  draw(n){ n.el.querySelector('.readout').textContent=n.txt||''; }});

def({ id:'hfdlChipAvg', title:'HFDL: Chip-Pair Averaging (rate 1/4)', cat:'Decoders', readout:true,
  ins:[{n:'blk',t:'blk'},{n:'m1',t:'num'}],
  outs:[{n:'blk',t:'blk'}],
  params:[{n:'m1',t:'range',min:0,max:7,step:1,d:0,label:'M1 (0-7, if m1 input not connected)'}],
  init:n=>{ n.bid=-1; n.txt='no data'; },
  process(n,I){
    const b=I.blk;
    if(!b || b.id===n.bid) return { blk:n.blkOut||null };
    n.bid=b.id;
    const m1=typeof I.m1==='number'?(I.m1|0):n.p.m1;
    const codeRate=HFDL_FRAME_PARAMS[clamp(m1,0,7)].codeRate;
    if(codeRate===4){
      // конвенция движка: bit=1→+1, bit=0→-1. Усредняем в исходной 0..255-подобной шкале
      // формулой из hfdl.c, затем обратно в -1..1.
      const nOut=b.n>>1;
      const out=new Float32Array(nOut);
      let agree=0;                                             // диагностика: пара — это правда повтор одного бита?
      for(let i=0;i<nOut;i++){
        const s1=b.d[2*i]>0, s2=b.d[2*i+1]>0;
        if(s1===s2) agree++;
        const a=(b.d[2*i]+1)*127.5, c=(b.d[2*i+1]+1)*127.5;   // -1..1 -> 0..255
        const avg=(a&c)+((a^c)>>1);
        out[i]=avg/127.5-1;                                    // обратно в -1..1
      }
      n.blkOut={ d:out, n:nOut, id:b.id };
      // если пары chip'ов — правда повтор одного и того же кодового бита, согласие
      // знаков должно быть заметно выше 50%. Около 50% — сигнал, что пары (2i,2i+1)
      // после деперемежителя НЕ соответствуют друг другу (пары не рядом, как думали).
      n.txt='rate 1/4: '+b.n+' -> '+nOut+' (averaged) · pair agreement '+(100*agree/nOut).toFixed(1)+'%';
    } else {
      n.blkOut=b;
      n.txt='rate 1/2: no averaging, '+b.n+' bits';
    }
    return { blk:n.blkOut };
  },
  draw(n){ n.el.querySelector('.readout').textContent=n.txt; }});

// Наземные станции HFDL: ID -> координаты (публичные данные, hfdl.observer, сверено 09.09.2026).
const HFDL_GS_STATIONS = {
  1:{name:'San Francisco',lat:38.384587,lon:-121.759647},
  2:{name:'Molokai',lat:21.184428,lon:-157.186846},
  3:{name:'Reykjavik',lat:63.847168,lon:-22.455754},
  4:{name:'Riverhead',lat:40.881922,lon:-72.63762},
  5:{name:'Auckland',lat:-37.015757,lon:174.809637},
  6:{name:'Hat Yai',lat:6.937536,lon:100.388451},
  7:{name:'Shannon',lat:52.744089,lon:-8.926752},
  8:{name:'Johannesburg',lat:-26.129658,lon:28.206078},
  9:{name:'Barrow',lat:71.25849,lon:-156.577447},
  10:{name:'Muan',lat:35.032377,lon:126.238644},
  11:{name:'Albrook',lat:9.084681,lon:-79.373969},
  13:{name:'Santa Cruz',lat:-17.671199,lon:-63.157088},
  14:{name:'Krasnoyarsk',lat:56.152603,lon:92.583337},
  15:{name:'Al Muharraq',lat:26.268773,lon:50.648978},
  16:{name:'Agana',lat:13.488833,lon:144.828233},
  17:{name:'Canarias',lat:27.960945,lon:-15.405608},
};

def({ id:'hfdlStack', title:'HFDL: LPDU→HFNPDU→ACARS→ADS-C', cat:'Decoders', readout:true, resize:true,
  ins:[{n:'blk',t:'blk'},{n:'freq',t:'num'}],
  outs:[{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'trig',t:'num'},{n:'id',t:'txt'},
        {n:'gsLat',t:'num'},{n:'gsLon',t:'num'},{n:'gsTrig',t:'num'},{n:'gsName',t:'txt'}],
  params:[{n:'freq',t:'num',d:11384,label:'frequency, kHz'}],
  init:n=>{ n.bid=-1; n.lastLat=0; n.lastLon=0; n.lastId=''; n.log='no data';
    n.gsLat=0; n.gsLon=0; n.gsName=''; },
  process(n,I){
    const b=I.blk;
    let trig=0, gsTrig=0;
    if(b && b.id!==n.bid){
      n.bid=b.id;
      const freq=typeof I.freq==='number'?I.freq:n.p.freq;
      const nBytes=Math.floor(b.n/8);
      const bytesRaw=new Uint8Array(nBytes);
      for(let i=0;i<nBytes;i++){ let v=0; for(let k=0;k<8;k++) v=(v<<1)|(b.d[i*8+k]>0?1:0); bytesRaw[i]=v; }
      const bytes=reverseBytes(bytesRaw);              // REVERSE_BYTE из hfdl.c — обязателен перед mpduParse
      try{
        const mres=mpduParse(bytes, freq);
        if(!mres.err){
          for(const lpdu of mres.lpdus){
            if(lpdu.err) continue;
            // ID наземной станции всегда на "GS"-стороне линка, независимо от направления —
            // uplink: srcId это GS; downlink: dstId это GS. Показываем на карте, если знаем координаты.
            const gsId = lpdu.mpduHeader.direction==='uplink' ? lpdu.mpduHeader.srcId : lpdu.mpduHeader.dstId;
            const gs = HFDL_GS_STATIONS[gsId];
            if(gs){ n.gsLat=gs.lat; n.gsLon=gs.lon; n.gsName='📡 '+gs.name; gsTrig=1; }
            if(!lpdu.hfnpduPayload) continue;
            const h=hfnpduParse(lpdu.hfnpduPayload);
            if(!h || h.err) continue;
            let posInfo=null;
            if(h.type===HFNPDU_TYPE.PERFORMANCE_DATA || h.type===HFNPDU_TYPE.FREQUENCY_DATA){
              posInfo={ lat:h.data.lat, lon:h.data.lon,
                ts:{...h.data.utc, hourPresent:true, minPresent:true, secPresent:true} };
              n.log=(h.type===HFNPDU_TYPE.PERFORMANCE_DATA?'Performance':'Frequency')+' Data: '+h.data.flightId;
            } else if(h.type===HFNPDU_TYPE.ENVELOPED_DATA && h.acars){
              n.log='ACARS '+h.acars.reg+' label='+h.acars.label+': '+(h.acars.txt||'').slice(0,50);
              if(h.acars.arinc622Candidate){
                const arinc=arincParse(h.acars.txt);
                const adscPos=arinc && arinc.adscTags ? adscPositionExtract(arinc.adscTags) : null;
                if(adscPos){
                  posInfo={ lat:adscPos.lat, lon:adscPos.lon, flightId:adscPos.flightId,
                    icaoAddress: adscPos.icaoAddress!=null?adscPos.icaoAddress:null, ts:adscPos.ts };
                  n.log='ADS-C '+(adscPos.flightId||h.acars.reg)+': lat='+adscPos.lat.toFixed(4)+' lon='+adscPos.lon.toFixed(4);
                }
              }
            }
            if(posInfo){
              const filled=lpduFillIcao(lpdu, posInfo);
              const checked=positionInfoExtract(filled);
              if(checked){
                n.lastLat=checked.lat; n.lastLon=checked.lon;
                n.lastId=checked.icaoAddress!=null?icaoToHex(checked.icaoAddress):(checked.flightId||h.data?.flightId||'?');
                trig=1;
              }
            }
          }
        } else n.log='MPDU: '+mres.reason;
      }catch(e){ n.log='error: '+e.message; }
    }
    return { lat:n.lastLat, lon:n.lastLon, trig, id:n.lastId,
             gsLat:n.gsLat, gsLon:n.gsLon, gsTrig, gsName:n.gsName };
  },
  draw(n){ n.el.querySelector('.readout').textContent=n.log; }});

// planeMap уже перенесён в output.js — здесь не дублирую, чтобы не ловить
// предупреждение "дублирующийся id модуля".

/* ==========================================================================================
 * Ниже — узлы физического/канального уровня HFDL, которые раньше жили в общих файлах
 * (protocols.js, modulation.js) вперемешку с неспецифичными узлами. Перенесены сюда, чтобы
 * всё HFDL в одном месте.
 * ========================================================================================== */

/* ---------- параметры физического уровня (из dumphfdl, GPLv3) ---------- */
const HFDL_A=[0b01011011,0b10111100,0b01110100,0b01010111,0b00000011,0b11011001,
  0b10001001,0b00111001,0b11110010,0b00001000,0b11010101,0b00110110,
  0b10010100,0b00101100,0b00110010,0b11111110];
const HFDL_M1=[0,1,1,1,0,1,1,0,1,1,1,1,0,1,0,0,0,1,0,1,1,0,0,
  1,0,1,1,1,1,1,0,0,0,1,0,0,0,0,0,0,1,1,0,0,1,1,0,1,1,
  0,0,0,1,1,1,0,0,1,1,1,0,1,0,1,1,1,0,0,0,0,1,0,0,1,1,
  0,0,0,0,0,1,0,1,0,1,0,1,1,0,1,0,0,1,0,0,1,0,1,0,0,1,
  1,1,1,0,0,1,0,0,0,1,1,0,1,0,1,0,0,0,0,1,1,1,1,1,1,1];
const HFDL_SHIFTS=[72,82,113,123,61,103,93,9];      // сдвиг M1 кодирует скорость и слот
const HFDL_RATES=['300 baud BPSK, 1 slot','600 baud BPSK, 1 slot','1200 QPSK, 1 slot',
  '1800 8PSK, 1 slot','300 baud BPSK, 2 slots','600 baud BPSK, 2 slots',
  '1200 QPSK, 2 slots','1800 8PSK, 2 slots'];
// используются извне (modules/protocols.js: узел 'corr', PATTERNS 'HFDL: преамбула A' / 'HFDL: M1')
function hfdlA(){                                    // 127 бит опорной последовательности A
  const b=[];
  for(const oct of HFDL_A) for(let k=7;k>=0;k--) b.push((oct>>k)&1);
  return b.slice(0,127).map(v=>v?1:-1);
}
function hfdlM1(shift){
  const out=[];
  for(let j=0;j<127;j++) out.push(HFDL_M1[(HFDL_SHIFTS[shift]+j)%127]?1:-1);
  return out;
}
// hfdlLfsr() уже определена выше (используется и hfdlSymToBits, и hfdlDescr)
function hfdlDeintBits(bits,shiftCols){                  // 40 строк, сдвиг столбца при записи
  const R=40, C=Math.floor(bits.length/R);
  const t=Array.from({length:R},()=>new Float32Array(C));
  let row=0,col=0;
  for(let i=0;i<R*C;i++){
    t[row][col]=bits[i];
    if(++row===R){ row=0; col++; }
    col-=shiftCols; if(col<0) col+=C; }
  const out=new Float32Array(R*C);
  row=0; col=0;
  for(let i=0;i<R*C;i++){
    out[i]=t[row][col];
    row=(row+9)%R;                                   // чтение с шагом 9 строк
    if(row===0) col++; }
  return out;
}

// HFDL использует фиксированную 120-битную последовательность вместо LFSR —
// не частный случай самосинхр. скремблера (scrambleTx/Rx в protocols.js), поэтому отдельный узел.
// НЕ используется в рабочей авто-цепочке ('HFDL: приём и карта самолётов') — там
// дескремблинг встроен в hfdlSymToBits (по data-символам, а не по baud-такту).
// Этот узел остался от раннего пресета 'HFDL: обнаружение и кадр' (без фреймера).
def({ id:'hfdlDescr', title:'HFDL: Descrambler', cat:'Decoders',
  ins:[{n:'in',t:'sig'},{n:'baud',t:'num'}], outs:[{n:'out',t:'sig'}],
  params:[{n:'baud',t:'range',min:1,max:9600,step:.01,d:1800,log:true}],
  init:n=>{n.ph=0;n.cur=1;n.hf=0;},
  process(n,I){
    if(typeof I.baud==='number') setMod(n,'baud',I.baud);
    const o=buf(n,'out'), inc=n.p.baud/Eng.sr;
    if(!n.hseq) n.hseq=hfdlLfsr();
    for(let i=0;i<BLOCK;i++){
      n.ph+=inc;
      if(n.ph>=1){ n.ph-=1;
        const b=(I.in?I.in[i]:0)>0?1:0;
        n.cur=(b^n.hseq[n.hf])?1:-1;
        n.hf=(n.hf+1)%120; }
      o[i]=n.cur; }
    return {out:o}; }});

// HFDL перемежает по фиксированной схеме 40×N со сдвигом столбцов — не то же самое,
// что общая построчная/постолбцовая матрица (interleavePerm в protocols.js).
def({ id:'hfdlDeint', title:'HFDL: Deinterleaver', cat:'Decoders',
  ins:[{n:'blk',t:'blk'},{n:'shiftCols',t:'num'}], outs:[{n:'blk',t:'blk'},{n:'text',t:'txt'}],
  readout:true,
  params:[{n:'shiftCols',t:'range',min:1,max:64,step:1,d:17,label:'column shift'}],
  init:n=>{n.bid=-1;n.txt='';},
  process(n,I){
    if(typeof I.shiftCols==='number') setMod(n,'shiftCols',I.shiftCols);
    const b=I.blk; if(!b||b.id===n.bid) return {blk:n.blkOut||null,text:n.txt};
    n.bid=b.id;
    const o=hfdlDeintBits(b.d,n.p.shiftCols);
    n.blkOut={d:o,n:o.length,id:b.id};
    n.txt='HFDL: 40×'+Math.floor(b.n/40)+', shift '+n.p.shiftCols;
    return {blk:n.blkOut,text:n.txt}; },
  draw(n){ n.el.querySelector('.readout').textContent=n.txt||'…'; }});

// Символьная синхронизация через polyphase-фильтрбанк (порт symsync_crcf_create_kaiser
// из liquid-dsp, см. src/filter/src/symsync.proto.c в исходниках dumphfdl/liquid-dsp).
// В отличие от 'gardner' (ближайший отсчёт, без интерполяции) — здесь честная интерполяция
// через M=16 полифазных веток Kaiser-фильтра + Mueller&Muller-подобная петля по производному
// фильтру. САМ является согласованным фильтром — подавай на вход СЫРОЙ (не RRC-фильтрованный)
// комплексный baseband, не соединяй последовательно с узлом 'rrc'.
// НАЙДЕННЫЙ И ИСПРАВЛЕННЫЙ БАГ (сверка с реальным symsync_crcf на единичном импульсе):
// коэффициенты фильтра нужно домножить на k*M (число веток * SPS), иначе выход занижен
// ровно в это число раз — с этой правкой импульсный отклик совпадает с оригиналом день-в-день.
// На реальных записях (Hf-acars.wav) даёт train-BER 5.8-9.7% против ~40-50% у 'gardner' —
// подтверждено, не гипотеза. Подробности и как воспроизвести сравнение — SESSION_NOTES.md.
function besselI0(x){
  let sum=1, term=1;
  for(let k=1;k<50;k++){ term*=(x/(2*k))*(x/(2*k)); sum+=term; if(term<1e-12*sum) break; }
  return sum;
}
function kaiserWin(i,wlen,beta){
  const t=i-(wlen-1)/2, r=2*t/(wlen-1);
  return besselI0(beta*Math.sqrt(Math.max(0,1-r*r)))/besselI0(beta);
}
function kaiserBetaAs(as){
  as=Math.abs(as);
  if(as>50) return 0.1102*(as-8.7);
  if(as>21) return 0.5842*Math.pow(as-21,0.4)+0.07886*(as-21);
  return 0;
}
function symsyncSinc(x){ return Math.abs(x)<1e-8?1:Math.sin(Math.PI*x)/(Math.PI*x); }
function symsyncBuildFilters(k,m,M){
  const H_len=2*M*k*m+1, fc=0.75/(k*M), beta=kaiserBetaAs(40.0);
  const H=new Float64Array(H_len);
  for(let i=0;i<H_len;i++){
    const t=i-(H_len-1)/2;
    H[i]=symsyncSinc(2*fc*t)*kaiserWin(i,H_len,beta)*2*fc*(k*M); // ×kM — см. комментарий выше
  }
  const dH=new Float64Array(H_len);
  let hdhMax=0;
  for(let i=0;i<H_len;i++){
    if(i===0) dH[i]=H[i+1]-H[H_len-1];
    else if(i===H_len-1) dH[i]=H[0]-H[i-1];
    else dH[i]=H[i+1]-H[i-1];
    const v=Math.abs(H[i]*dH[i]); if(v>hdhMax||i===0) hdhMax=v;
  }
  for(let i=0;i<H_len;i++) dH[i]*=0.06/hdhMax;
  const hSubLen=Math.floor(H_len/M), mfBranch=[], dmfBranch=[];
  for(let br=0;br<M;br++){
    const hb=new Float64Array(hSubLen), db=new Float64Array(hSubLen);
    for(let n2=0;n2<hSubLen;n2++){ const idx=br+n2*M; hb[n2]=idx<H_len?H[idx]:0; db[n2]=idx<H_len?dH[idx]:0; }
    mfBranch.push(hb); dmfBranch.push(db);
  }
  return {hSubLen, mfBranch, dmfBranch};
}
def({ id:'hfdlSymsync', title:'HFDL: Symbol Sync (polyphase)', cat:'Modulation',
  ins:[{n:'I',t:'sig'},{n:'Q',t:'sig'},{n:'baud',t:'num'}],
  outs:[{n:'sI',t:'sig'},{n:'sQ',t:'sig'},{n:'clk',t:'sig'}],
  params:[{n:'baud',t:'range',min:10,max:4800,step:.01,d:1800,log:true},
          {n:'lfBw',t:'range',min:0.0001,max:.05,step:.0001,d:.001,label:'timing loop bandwidth'}],
  init:n=>{ n.sI=0; n.sQ=0; n.resampPhase=0; n.prevI=0; n.prevQ=0; },
  process(n,I){
    if(typeof I.baud==='number') setMod(n,'baud',I.baud);
    const k=3, m=3, M=16; // SPS=3 (внутренний), delay=3 символа, 16 веток — как в hfdl.c
    const key=n.p.baud+'/'+Eng.sr;
    if(n.key!==key){
      n.key=key;
      const f=symsyncBuildFilters(k,m,M);
      n.hSubLen=f.hSubLen; n.mfBranch=f.mfBranch; n.dmfBranch=f.dmfBranch;
      n.winRe=new Float64Array(n.hSubLen); n.winIm=new Float64Array(n.hSubLen); n.winPos=0;
      n.kOut=2; n.rate=k/n.kOut; n.del=n.rate; n.tau=0; n.bf=0; n.b=0; n.decimCounter=0;
      n.qPrev=0; n.qPrev2=0; n.qHatPrev=0; n.qHatPrev2=0;
      const bt=n.p.lfBw, alpha=1-bt;
      n.B=[0.22*bt,0,0]; n.A=[1-0.5*alpha,-0.495*alpha,0]; n.rateAdjustment=0.5*bt;
      n.resampStep=(k*n.p.baud)/Eng.sr;
      n.symsyncOutIdx=0;
    }
    const oi=buf(n,'sI'), oq=buf(n,'sQ'), ok=buf(n,'clk');
    for(let i=0;i<BLOCK;i++){
      const xi=I.I?I.I[i]:0, xq=I.Q?I.Q[i]:0;
      n.resampPhase+=n.resampStep; let clk=0;
      while(n.resampPhase>=1){
        n.resampPhase-=1;
        const frac=1-n.resampPhase/n.resampStep;
        const rI=n.prevI+frac*(xi-n.prevI), rQ=n.prevQ+frac*(xq-n.prevQ);
        // push в кольцевой буфер
        n.winPos=(n.winPos+1)%n.hSubLen; n.winRe[n.winPos]=rI; n.winIm[n.winPos]=rQ;
        while(n.b<M){
          let mfRe=0, mfIm=0; const br=n.mfBranch[n.b];
          for(let n2=0;n2<n.hSubLen;n2++){ const idx=(n.winPos-n2+n.hSubLen*4)%n.hSubLen; mfRe+=br[n2]*n.winRe[idx]; mfIm+=br[n2]*n.winIm[idx]; }
          const symI=mfRe/k, symQ=mfIm/k;
          if(n.decimCounter===n.kOut){
            n.decimCounter=0;
            let dmfRe=0, dmfIm=0; const dbr=n.dmfBranch[n.b];
            for(let n2=0;n2<n.hSubLen;n2++){ const idx=(n.winPos-n2+n.hSubLen*4)%n.hSubLen; dmfRe+=dbr[n2]*n.winRe[idx]; dmfIm+=dbr[n2]*n.winIm[idx]; }
            let q=mfRe*dmfRe/(k*k)+mfIm*dmfIm/(k*k); q=clamp(q,-1,1);
            const qHat=n.B[0]*q+n.B[1]*n.qPrev+n.B[2]*n.qPrev2 - n.A[1]*n.qHatPrev - n.A[2]*n.qHatPrev2;
            n.qPrev2=n.qPrev; n.qPrev=q; n.qHatPrev2=n.qHatPrev; n.qHatPrev=qHat;
            n.rate+=n.rateAdjustment*qHat; n.del=n.rate+qHat;
          }
          n.decimCounter++;
          n.tau+=n.del; n.bf=n.tau*M; n.b=Math.round(n.bf);
          n.symsyncOutIdx++;
          if(n.symsyncOutIdx&1){ n.sI=symI; n.sQ=symQ; clk=1; }  // держим каждый 2й (output_rate=2 → 1 симв/такт)
        }
        n.tau-=1; n.bf-=M; n.b-=M;
        n.prevI=xi; n.prevQ=xq;
      }
      oi[i]=n.sI; oq[i]=n.sQ; ok[i]=clk;
    }
    return {sI:oi,sQ:oq,clk:ok};
  }});
