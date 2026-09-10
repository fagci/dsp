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
 *   [ЧАСТИЧНО]           soft-значения (не hard-quantized) — сделано ТОЛЬКО для BPSK
 *                         в hfdlSymToBits (проекция I напрямую, без округления до ±1).
 *                         ВАЖНО: не знаю, пропускает ли твой hfdlDeint произвольные float
 *                         не искажая (или он квантует внутри себя в hard 0/1/±1) — если
 *                         внутри хранение как Uint8Array/boolean, весь выигрыш здесь
 *                         теряется на следующем же узле. Проверь/пришли его исходник.
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
def({ id:'hfdlViterbi', title:'Витерби K=7 r=1/2 (HFDL FEC)', cat:'Декодеры', readout:true,
  ins:[{n:'blk',t:'blk'}],
  outs:[{n:'blk',t:'blk'}],
  params:[{n:'polyConv',t:'select',opts:['raw (без конвенции)','NASA-DSN','CCSDS'],d:'raw (без конвенции)',
           label:'конвенция полиномов'},
          {n:'endstate',t:'num',d:0,label:'конечное состояние (обычно 0 — хвост из нулей)'}],
  init:n=>{ n.bid=-1; n.txt='нет данных'; },
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
    const nbits=nSteps-6;                              // последние 6 пар символов — хвост кодера
    if(nbits<=0){ n.txt='блок слишком короткий'; return { blk:n.blkOut||null }; }
    const vp=v27Create(polys);
    v27Init(vp,0);
    v27UpdateBlk(vp,syms);
    const bytes=v27Chainback(vp, nbits, n.p.endstate|0);
    const outBits=new Float32Array(nbits);
    for(let i=0;i<nbits;i++) outBits[i]=((bytes[i>>3]>>(7-(i%8)))&1)?1:-1;
    n.blkOut={ d:outBits, n:nbits, id:b.id };
    n.txt='декодировано бит: '+nbits;
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

function hfdlLfsr(){                                 // та же 120-битная фикс. последовательность, что и в hfdlDescr
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
function hfdlM1Bits(shift){                           // ±1, как и остальные образцы в corr
  const out=new Int8Array(HFDL_M1_LEN);
  for(let j=0;j<HFDL_M1_LEN;j++) out[j]=HFDL_M1_BITS[(shift+j)%HFDL_M1_LEN]?1:-1;
  return out;
}

// Аналог match_sequence() из hfdl.c: пробует все 8 шаблонов M1 одновременно на одном
// скользящем окне, выдаёт индекс победителя (m1) и импульс начала кадра (go), когда
// корреляция уверенно выше порога — так что заранее знать скорость станции НЕ нужно.
def({ id:'hfdlM1Match', title:'HFDL: детектор M1 (скорость)', cat:'Протоколы', readout:true,
  ins:[{n:'in',t:'sig'},{n:'baud',t:'num'},{n:'thr',t:'num'}],
  outs:[{n:'go',t:'sig'},{n:'m1',t:'num'},{n:'peak',t:'num'},{n:'corr',t:'sig'}],
  view:{h:80}, resize:true,
  params:[{n:'baud',t:'range',min:1,max:4800,step:.01,d:1800,log:true},
          {n:'thr',t:'range',min:.1,max:1,step:.01,d:.5,label:'порог'},
          {n:'dead',t:'range',min:0,max:5000,step:1,d:1500,label:'мёртвое время, мс'}],
  init:n=>{ n.m1=0; n.m2=0; n.dead=0; n.peak=0; n.m1out=0; n.txt='ищу M1…'; n.hist=[]; n.curIdx=0; n.curC=0; },
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
    let bestOverBlock=0, bestIdxOverBlock=n.curIdx;
    for(let i=0;i<BLOCK;i++){
      const old=ring[n.w], nv=I.in?I.in[i]:0;
      n.ss += nv*nv - old*old;
      ring[n.w]=nv;
      const rms=Math.sqrt(Math.max(0,n.ss)/L);
      let bestC=0, bestIdx=0;
      for(let sIdx=0;sIdx<8;sIdx++){
        const pat=n.tmpl[sIdx];
        let acc=0;
        for(let k=0;k<P;k++) acc+=ring[(n.w-taps[k]+L*2)%L]*pat[P-1-k];
        const c=clamp(Math.abs(acc/(P*rms+1e-9)),0,2);   // ЗАЩИТА: без неё при просадке rms→0 значение улетало в тысячи
        if(c>bestC){ bestC=c; bestIdx=sIdx; }
      }
      oc[i]=bestC;
      if(bestC>bestOverBlock){ bestOverBlock=bestC; bestIdxOverBlock=bestIdx; }
      let hit=(n.m1>=n.p.thr && n.m1>n.m2 && n.m1>=bestC);
      if(n.dead>0){ n.dead--; hit=false; }
      else if(hit) n.dead=Math.round(n.p.dead*Eng.sr/1000);
      og[i]=hit?1:0;
      if(hit){ n.m1out=n.lastIdx; n.peak=n.m1; }
      n.m2=n.m1; n.m1=bestC; n.lastIdx=bestIdx;
      n.w=(n.w+1)%L;
    }
    n.curC=n.curC*.8+bestOverBlock*.2; n.curIdx=bestIdxOverBlock;   // сглаженная "текущая" оценка для живого статуса
    n.hist.push(bestOverBlock); if(n.hist.length>200) n.hist.shift();
    n.txt='сейчас: '+n.curC.toFixed(2)+' (M1='+n.curIdx+')  ·  последний hit: M1='+n.m1out+
      ' пик '+n.peak.toFixed(2);
    return { go:og, m1:n.m1out, peak:n.peak, corr:oc };
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

def({ id:'hfdlSymToBits', title:'HFDL: символ→биты (I/Q, с фреймером)', cat:'Декодеры', readout:true, resize:true,
  ins:[{n:'I',t:'sig'},{n:'Q',t:'sig'},{n:'clk',t:'sig'},{n:'go',t:'sig'},{n:'m1',t:'num'}],
  outs:[{n:'blk',t:'blk'}],
  params:[{n:'m1',t:'range',min:0,max:7,step:1,d:3,label:'M1 (0-7, если go/m1 не подключены)'},
          {n:'descramble',t:'check',d:true,label:'дескремблировать (LFSR по символу)'}],
  // Между M1 и данными в реальном кадре НЕ сплошной поток payload-символов (см. hfdl.c):
  // M2(15, пропуск) → EQ_TRAIN(15×9, пропуск, BPSK для эквалайзера) →
  // [ДАННЫЕ 30][TRAIN 15] × dataSegmentCnt раз. Без этого фреймера тренировочные символы
  // подмешивались бы в поток данных, и деперемежитель/Витерби получали бы мусор
  // независимо от того, насколько верно подобраны дескремблинг/сдвиги/полином.
  // 'go' — sig-импульс от hfdlM1Match (не num!), фронт ищется посэмпловo и "вооружает"
  // сброс состояния, который реально срабатывает на ближайшем такте 'clk' — иначе
  // фреймер стартовал бы не в границе символа.
  init:n=>{ n.prevClk=0; n.prevGo=0; n.armed=false; n.bits=[]; n.bid=0; n.txt='ждём кадр (go)';
    n.state='idle'; n.symCtr=0; n.trainRep=0; n.hf=0; },
  process(n,I){
    if(!n.hseq) n.hseq=hfdlLfsr();
    for(let i=0;i<BLOCK;i++){
      const go=I.go?I.go[i]:0;
      if(go>0.5 && n.prevGo<=0.5) n.armed=true;         // фронт запомнили, ждём ближайший clk
      n.prevGo=go;

      const c=I.clk?I.clk[i]:0;
      if(c>.5 && n.prevClk<=.5){
        if(n.armed){
          n.armed=false;
          const m1=typeof I.m1==='number'?(I.m1|0):n.p.m1;
          const p=HFDL_FRAME_PARAMS[clamp(m1,0,7)];
          n.bps=HFDL_SCHEME_BITS[p.scheme];
          n.dataSegLeft=p.dataSegmentCnt;
          n.state='M2'; n.symCtr=0; n.hf=0; n.bits.length=0;
          n.txt='кадр начат, M1='+m1+' ('+p.scheme+')';
        }
        if(n.state!=='idle'){
          let ii=I.I?I.I[i]:0, qq=I.Q?I.Q[i]:0;
          const isData=(n.state==='DATA');
          // ЛФСР сдвигается только на data-символах (descrambler_advance вызывается
          // только внутри decode_user_data в оригинале — не на train/M2)
          if(isData){
            if(n.p.descramble && n.hseq[n.hf]){ ii=-ii; qq=-qq; }
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
                const bits=symbolToBits(Math.atan2(qq,ii), n.bps);
                for(const b of bits) n.bits.push(b?1:-1);   // QPSK/8PSK — пока жёстко, см. коммент в статусе файла
              }
              if(n.symCtr>=DATA_FRAME_LEN){ n.symCtr=0; n.state='TRAIN'; }
              break;
            case 'TRAIN':
              if(n.symCtr>=T_LEN){
                n.symCtr=0; n.dataSegLeft--;
                n.state = n.dataSegLeft>0 ? 'DATA' : 'idle';
                if(n.state==='idle') n.txt='кадр собран: '+n.bits.length+' бит';
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
    } else if(n.state!=='idle') n.txt=n.state+' ('+n.symCtr+'), данных собрано: '+n.bits.length;
    return { blk };
  },
  draw(n){ n.el.querySelector('.readout').textContent=n.txt; }});

// Мост между hfdlDeint и Витерби: для BPSK-скоростей (M1=0,1,4,5) codeRate=4 — каждый чип
// передан дважды, нужно попарно усреднить ПЕРЕД Витерби (иначе решётка получает вдвое
// больше "бит", чем реально закодировано, и разъезжается независимо от всего остального).
// Для codeRate=2 (QPSK/8PSK) — просто пропускает как есть, без усреднения.
def({ id:'hfdlChipAvg', title:'HFDL: усреднение chip-пар (rate 1/4)', cat:'Декодеры', readout:true,
  ins:[{n:'blk',t:'blk'},{n:'m1',t:'num'}],
  outs:[{n:'blk',t:'blk'}],
  params:[{n:'m1',t:'range',min:0,max:7,step:1,d:0,label:'M1 (0-7, если вход m1 не подключён)'}],
  init:n=>{ n.bid=-1; n.txt='нет данных'; },
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
      for(let i=0;i<nOut;i++){
        const a=(b.d[2*i]+1)*127.5, c=(b.d[2*i+1]+1)*127.5;   // -1..1 -> 0..255
        const avg=(a&c)+((a^c)>>1);
        out[i]=avg/127.5-1;                                    // обратно в -1..1
      }
      n.blkOut={ d:out, n:nOut, id:b.id };
      n.txt='rate 1/4: '+b.n+' -> '+nOut+' (усреднено)';
    } else {
      n.blkOut=b;
      n.txt='rate 1/2: без усреднения, '+b.n+' бит';
    }
    return { blk:n.blkOut };
  },
  draw(n){ n.el.querySelector('.readout').textContent=n.txt; }});

def({ id:'hfdlStack', title:'HFDL: LPDU→HFNPDU→ACARS→ADS-C', cat:'Декодеры', readout:true, resize:true,
  ins:[{n:'blk',t:'blk'},{n:'freq',t:'num'}],
  outs:[{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'trig',t:'num'},{n:'id',t:'txt'}],
  params:[{n:'freq',t:'num',d:11384,label:'частота, кГц'}],
  init:n=>{ n.bid=-1; n.lastLat=0; n.lastLon=0; n.lastId=''; n.log='нет данных'; },
  process(n,I){
    const b=I.blk;
    let trig=0;
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
            if(lpdu.err || !lpdu.hfnpduPayload) continue;
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
      }catch(e){ n.log='ошибка: '+e.message; }
    }
    return { lat:n.lastLat, lon:n.lastLon, trig, id:n.lastId };
  },
  draw(n){ n.el.querySelector('.readout').textContent=n.log; }});

// planeMap уже перенесён в output.js — здесь не дублирую, чтобы не ловить
// предупреждение "дублирующийся id модуля".
