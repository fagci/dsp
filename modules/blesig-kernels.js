"use strict";
/* ============================ BLE-сигнатуры — ядро ============================
   Запись приложения DSP (src=ble: addr, name, mfr {companyId:hex}, svc {uuid:hex}, uuids [..], raw) → вид устройства:
   flipper — Flipper Zero и подобные тулы; tracker — метки (AirTag / Find My, Samsung SmartTag, Tile, Chipolo, Google Find Hub);
   glasses — умные очки и гарнитуры (Meta / Ray-Ban Meta, Snap Spectacles, Even Realities, Rokid, XREAL, Vuzix…).
   Это эвристика по рекламе: имя, id компании (Bluetooth SIG), службы; ложные срабатывания возможны, маскированное имя ничего не даст.
   bsClassify(rec) → {kind,label,why} | null;  bsNew / bsSee / bsRows — «кто и когда был рядом»: строки для Rec → Entities (вход top).
   Проверяется в tools/test-blesig.mjs. */

const BS_KINDS=['flipper','tracker','glasses'];
const bsHex=s=>String(s??'').toLowerCase().replace(/[^0-9a-f]/g,'');
// 16-битное имя службы: «fd5a», «0000fd5a-0000-1000-8000-00805f9b34fb», 0xfd5a → 'fd5a'; длинные 128-битные — как есть
function bsU16(u){
  const s=String(u??'').toLowerCase().replace(/^0x/,'');
  const m=/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(s);
  return m ? m[1] : /^[0-9a-f]{1,4}$/.test(s) ? s.padStart(4,'0') : s;
}
function bsSets(r){
  const mfr=new Map(), svc=new Map(), uu=new Set();
  const obj=v=>v && typeof v==='object' && !Array.isArray(v) ? v : {};
  for(const k in obj(r.mfr)) mfr.set(bsU16(k),bsHex(r.mfr[k]));
  for(const k in obj(r.svc)) svc.set(bsU16(k),bsHex(r.svc[k]));
  for(const u of Array.isArray(r.uuids) ? r.uuids : []) uu.add(bsU16(u));
  for(const k of svc.keys()) uu.add(k);
  if(Array.isArray(r.mfrId)) for(const k of r.mfrId) if(!mfr.has(bsU16(k))) mfr.set(bsU16(k),'');
  return {mfr,svc,uu};
}
const BS_NAME=[
  ['flipper',  /^flipper\b/i, 'Flipper Zero'],
  ['tracker',  /^(tile|chipolo|pebblebee|smarttag|galaxy\s*smarttag|airtag|nut\b|cube tracker|orbit|eufy\s*(security\s*)?smarttrack|tracki)/i, 'tracker'],
  ['glasses',  /ray-?ban|meta\s*(ai\s*)?glasses|oakley\s*meta|spectacles|even\s*(realities\s*)?g[12](?![a-z0-9])|rokid|xreal|nreal|vuzix|brilliant\s*(labs)?\b|inmo\s*air|solos\b|halo\b.*glass|rayneo|viture/i, 'smart glasses']];
function bsClassify(r){
  if(!r || typeof r!=='object') return null;
  const name=String(r.name??'').replace(/\0+$/,'').trim(), S=bsSets(r);
  // Flipper Zero: имя «Flipper …» и/или службы 0x3081 (white) / 0x3082 (black) / 0x3083 (transparent)
  if(/^flipper\b/i.test(name)) return {kind:'flipper',label:'Flipper Zero',why:'name «'+name+'»'};
  for(const u of ['3081','3082','3083']) if(S.uu.has(u)) return {kind:'flipper',label:'Flipper Zero',why:'service 0x'+u};
  // метки
  const ap=S.mfr.get('004c');
  if(ap!==undefined && ap!==''){
    const t=ap.slice(0,2);
    if(t==='12') return {kind:'tracker',label:ap.slice(2,4)==='19' ? 'Apple AirTag / Find My' : 'Apple Find My accessory',why:'Apple 0x12'+(ap.slice(2,4)==='19' ? ' len 25' : '')};
  }
  if(S.uu.has('fd5a')) return {kind:'tracker',label:'Samsung SmartTag',why:'service 0xfd5a'};
  if(S.uu.has('feed') || S.uu.has('feec')) return {kind:'tracker',label:'Tile',why:'service 0x'+(S.uu.has('feed') ? 'feed' : 'feec')};
  const ee=S.svc.get('feaa');
  if(ee && (ee.startsWith('40') || ee.startsWith('41'))) return {kind:'tracker',label:'Google Find Hub tag',why:'0xfeaa frame '+ee.slice(0,2)};
  // очки и гарнитуры
  if(S.mfr.has('01ab') || S.mfr.has('058e')) return {kind:'glasses',label:'Meta (glasses / headset)',why:'company 0x'+(S.mfr.has('01ab') ? '01ab' : '058e')};
  if(S.mfr.has('03c2')) return {kind:'glasses',label:'Snap (Spectacles)',why:'company 0x03c2'};
  for(const [kind,re,label] of BS_NAME) if(re.test(name)) return {kind,label:name||label,why:'name «'+name+'»'};
  return null;
}
// наблюдения: по устройству — вид, имя, лучший/последний уровень, сколько раз и когда
function bsNew(){ return {dev:new Map()}; }
function bsSee(st,r,now,kinds){
  const c=bsClassify(r); if(!c || (kinds && !kinds.includes(c.kind))) return null;
  const id=String(r.addr??r.bssid??r.id??''); if(!id) return null;
  let d=st.dev.get(id), fresh=false;
  if(!d){ d={id,kind:c.kind,label:c.label,why:c.why,name:String(r.name??'').replace(/\0+$/,'').trim(),first:now,last:now,n:0,rssi:null,best:null}; st.dev.set(id,d); fresh=true; }
  d.n++; d.last=now; d.kind=c.kind; d.label=c.label; d.why=c.why;
  if(typeof r.rssi==='number'){ d.rssi=r.rssi; if(d.best==null || r.rssi>d.best) d.best=r.rssi; }
  if(r.lat!=null && r.lon!=null){ d.lat=r.lat; d.lon=r.lon; }
  return {dev:d,fresh};
}
function bsPrune(st,now,ttlMin){ const ttl=(+ttlMin||0)*60; if(ttl>0) for(const [k,d] of st.dev) if(now-d.last>ttl) st.dev.delete(k); }
// строки: ближе (сильнее сигнал) — выше; status — «near» (слышно сейчас, не позже 30 с) / «recent»
function bsRows(st,now){
  return [...st.dev.values()].sort((a,b)=>(b.rssi??-200)-(a.rssi??-200)).map(d=>({
    id:d.id, name:d.name||d.label, kind:d.kind, label:d.label, why:d.why, rssi:d.rssi==null ? '' : d.rssi, best:d.best==null ? '' : d.best,
    seen:d.n, ago_s:Math.round(now-d.last), status:now-d.last<=30 ? 'near' : 'recent'}));
}
if(typeof module!=='undefined') module.exports={bsClassify,bsNew,bsSee,bsRows,bsPrune,BS_KINDS};
