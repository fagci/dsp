"use strict";
/* ============================ Band plan: вид модуляции, полоса и усиление по диапазону (ядро) ============================
   bpModeOf — какой демодулятор USB SDR и какая полоса подходят строке встроенного band plan (по названию, заметке, виду и частоте);
   значения «чтобы слушать / принимать», не стандарт службы. Строка с явными demod / bw / gain (колонки списка) берётся как есть.
   bpPick — по частоте f выбирает из строк плана самую специфичную (узкую) для каждого признака отдельно: вид и полосу из одной строки,
   усиление — из другой (например, из плана «RTL-SDR gain by range»). Точечные строки (lo = hi) — каналы: допуск половина шага. */
const BM_SKIP=/GSM|LTE|5G|UMTS|WCDMA|cellular|Wi-?Fi|Bluetooth|\bBLE\b|Zigbee|Thread|DECT|DVB|DAB|\bTV\b|телевид|GNSS|GPS|GLONASS|Galileo|BeiDou|Starlink|OneWeb|radar|Ku|\bKa\b|LNB|drone|FPV|DJI|nRF24|XN297|HaLow|V2X|DSRC|Iridium|Inmarsat|Thuraya|ANT\+/i;
// [regex по «название заметка вид план», fmin, fmax (Гц, необязательно), результат]
const BM_RULES=[
  [/ADS-?B|Mode ?S|1090/i, 1000e6, 1100e6, {demod:'IQ', bw:2000000}],
  [/\bAIS\b/i, 150e6, 170e6, {demod:'IQ', bw:25000}],
  [/ACARS|VDL|HFDL/i, 0, 140e6, {demod:'IQ', bw:25000}],
  [/POCSAG|FLEX|pager|пейджер/i, 100e6, 1000e6, {demod:'IQ', bw:25000}],
  [/TETRA|\bP25\b|\bDMR\b|NXDN|trunk|транк/i, 100e6, 1000e6, {demod:'IQ', bw:25000}, true],       // по названию строки: в названии плана («…TETRA, P25, trunking») и заметках PMR они упомянуты
  [/PMR|LPD|\bFRS\b|GMRS|MURS|Freenet|walkie|рации/i, 100e6, 1000e6, {demod:'NFM', bw:12500}],
  [/COSPAS|SARSAT|EPIRB|\bPLB\b/i, 400e6, 410e6, {demod:'IQ', bw:25000}],
  [/radiosonde|радиозонд|\bsonde\b|RS41|DFM-?\d|iMet/i, 400e6, 406.5e6, {demod:'IQ', bw:25000}],
  [/LRPT|Meteor|HRPT/i, 136e6, 138.5e6, {demod:'IQ', bw:150000}],
  [/NOAA.*(APT|sat)|\bAPT\b|weather sat|метео.?спутн/i, 136e6, 138.5e6, {demod:'NFM', bw:40000}],
  [/OIRT|FM broadcast|FM radio|broadcast FM|\bWFM\b|\bUKV\b|ФМ.?вещ|FM-вещ/i, 64e6, 110e6, {demod:'WFM', bw:180000}],
  [/\bVOR\b|\bILS\b|localizer|glide/i, 108e6, 118e6, {demod:'AM', bw:10000}],
  [/air ?band|aeronaut|aviation|авиа|\bATC\b|\bair\b|airfield|aircraft/i, 108e6, 138e6, {demod:'AM', bw:10000}],
  [/marine|maritime|\bsea\b|море|морск|\bship\b/i, 150e6, 165e6, {demod:'NFM', bw:16000}],
  [/NOAA|weather radio|\bSAME\b/i, 162e6, 163e6, {demod:'NFM', bw:12500}],
  [/\bCB\b|citizen/i, 25e6, 29e6, {demod:'AM', bw:10000}],
  [/beacon|маяк|\bNDB\b/i, 0, 30e6, {demod:'USB', bw:500}],                                           // КВ-маяки; маркерные маяки 75 МГц — не CW
  [/\bCW\b|\bBCN\b/i, 0, 1300e6, {demod:'USB', bw:500}],
  [/FT8|FT4|WSPR|JS8|PSK|RTTY|SSTV|digi|цифр|packet|пакет|Olivia|MFSK/i, 0, 1300e6, {demod:'USB', bw:3000}],
  [/\bSSB\b|phone|voice|speech|телефон|голос|\bDX\b/i, 0, 1300e6, {demod:'*SSB', bw:2800}],
  [/broadcast|вещан|\bAM\b|\bMW\b|\bLW\b|\bSW\b|shortwave|medium ?wave|long ?wave|КВ|СВ|ДВ|HF broadcast/i, 0.1e6, 30e6, {demod:'AM', bw:9000}],
  [/amateur|\bham\b|радиолюб|repeater|ретранслятор|\b(6|2|10)m\b|70 ?cm|23 ?cm/i, 28e6, 1300e6, {demod:'NFM', bw:12500}],
  [/ISM|SRD|433|868|915|315|remote|key ?fob|брелок|sensor|датчик|LoRa|Meshtastic|Sigfox|Z-Wave|wM-Bus/i, 300e6, 1000e6, {demod:'IQ', bw:250000}],
];
// строка band plan → {demod, bw} | null. lo, hi — Гц; step — шаг канала, Гц (0 — нет)
function bpModeOf(label,note,kind,lo,hi,plan,step){
  const own=(label||'')+' '+(note||'')+' '+(kind||''), text=own+' '+(plan||'');
  if(BM_SKIP.test(own)) return null;                                              // не RTL-приём: сотовая, Wi-Fi, ТВ, GNSS… — по самой строке, не по названию плана
  const mid=(lo+hi)/2;
  for(const [re,f0,f1,r,onlyLabel] of BM_RULES){
    if(!re.test(onlyLabel ? (label||'') : text)) continue;
    if(f0!=null && f1!=null && !(lo>=f0 && hi<=f1) && !(mid>=f0 && mid<=f1)) continue;   // правило для своего диапазона: слово в названии без частоты не считается
    let demod=r.demod;
    if(demod==='*SSB') demod=lo<10e6 ? 'LSB' : 'USB';                                      // боковая по обычаю диапазона
    let bw=r.bw;
    if(demod==='AM' && lo<30e6) bw=step>=10000 ? Math.min(10000,step) : step>0 && step<=5000 ? 6000 : bw;   // MW 9/10 кГц, КВ-вещание с шагом 5 кГц
    return {demod, bw};
  }
  // по частоте, если название ничего не сказало: только каналы связи с шагом
  if(mid>=64e6 && mid<=108e6 && hi-lo>=1e6) return {demod:'WFM', bw:180000};
  if(mid>=108e6 && mid<=137e6) return {demod:'AM', bw:10000};
  if(((mid>=137e6 && mid<=174e6) || (mid>=400e6 && mid<=470e6)) && step>0 && step<=25000) return {demod:'NFM', bw:step<=12500 ? 12500 : 16000};
  return null;
}
// «12.5k», «180 kHz», «2M», число → Гц; не число — NaN
function bpHz(v){
  if(typeof v==='number') return v;
  const m=String(v??'').trim().replace(',','.').match(/^([\d.]+)\s*([kKмМmM]?)(?:Hz|Гц)?$/);
  if(!m) return NaN;
  const x=parseFloat(m[1]); if(!isFinite(x)) return NaN;
  const u=m[2]; return u==='k'||u==='K' ? x*1e3 : u==='M'||u==='m'||u==='М'||u==='м' ? x*1e6 : x;
}
const BP_DEMODS=['IQ','WFM','NFM','AM','SAM','USB','LSB'];
// нормализация строк плана: [{lo,hi,span,tol,key,label,demod,bw,gain}]; строки без всех трёх признаков отброшены
function bpNorm(rows){
  const out=[];
  for(const r of (Array.isArray(rows) ? rows : [])){
    if(!r || r.sig) continue;
    const lo=bpHz(r.lo), hi0=bpHz(r.hi!=null && r.hi!=='' ? r.hi : r.lo);
    if(!isFinite(lo)) continue;
    const hi=isFinite(hi0) ? Math.max(lo,hi0) : lo, dm=String(r.demod||'').toUpperCase(), bw=bpHz(r.bw), g=+r.gain;
    const demod=BP_DEMODS.includes(dm) ? dm : '', bwv=bw>0 ? bw : 0, gain=r.gain!=null && r.gain!=='' && isFinite(g) ? g : null;
    if(!demod && !bwv && gain==null) continue;
    const st=bpHz(r.step);
    out.push({lo,hi,span:hi-lo,tol:hi===lo ? Math.max(500,isFinite(st) ? st/2 : 0) : 0,key:lo+'|'+hi+'|'+(r.label||r.name||''),label:String(r.label||r.name||''),demod,bw:bwv,gain});
  }
  return out;
}
// самая узкая строка с признаком attr, под частотой f
function bpPickAttr(rows,f,attr){
  let best=null;
  for(const r of rows){
    if(attr==='gain' ? r.gain==null : !r[attr]) continue;
    if(!(f>=r.lo-r.tol && f<=r.hi+r.tol)) continue;
    if(!best || r.span<best.span || (r.span===best.span && Math.abs(f-(r.lo+r.hi)/2)<Math.abs(f-(best.lo+best.hi)/2))) best=r;
  }
  return best;
}
// частота → {demod, bw, gain}: строка-источник на каждый признак (null — нет)
function bpPick(rows,f){
  return {demod:bpPickAttr(rows,f,'demod'), bw:bpPickAttr(rows,f,'bw'), gain:bpPickAttr(rows,f,'gain')};
}
