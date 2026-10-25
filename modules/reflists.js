"use strict";
/* ============================ Справочники для опознавания (списки Table «Reference/…») ============================
   Качаются кнопкой «⇩ offline» в Files (OfflineData.item) и ложатся в обычные списки Table — их видно в дереве списков, они листаются,
   фильтруются и служат источником для вычисляемых полей: lookup() / between() (modules/lookup-kernels.js, table-lookup.js).
     Reference/MAC vendors (OUI)        prefix, vendor, bits              — IEEE OUI (MA-L / MA-M / MA-S) из nmap-mac-prefixes; lookup('…','prefix',[mac],'vendor','mac')
     Reference/Signals (intercept)      name, lo, hi, bw_lo, bw_hi, mod…  — каталог сигналов с sigidwiki: between('…','lo','hi',[freq],'name')
     Reference/WEFAX stations           name, callsign, country, hz…      — станции метеофакса
     Reference/Spy stations             name, nickname, type, country, hz, primary, mode…  — number stations и дипломатические HF-сети (priyom.org)
     Reference/TSCM bands               group, name, lo, hi, risk         — частоты подслушивающих устройств
     Reference/Wi-Fi SSID patterns      pattern, kind, vendor             — дроны, камеры: lookup('…','pattern',[ssid],'kind','contains')
     Reference/MAC prefixes (drones, trackers, cameras)   prefix, vendor, kind
     Reference/BLE trackers             company, name, risk, patterns, description
   Данные intercept (smittix/intercept, Apache-2.0) лежат в data/ (tools/intercept/build.py) и берутся оттуда; signals и wefax — запасной адрес на GitHub.
   Списки не синхронизируются между устройствами (sync.js, syHidden): на каждом устройстве докачиваются сами. */

const REF_DIR='Reference/', REF_VER='1';
const REF_OUI=REF_DIR+'MAC vendors (OUI)', REF_SIG=REF_DIR+'Signals (intercept)', REF_WEFAX=REF_DIR+'WEFAX stations', REF_TSCM=REF_DIR+'TSCM bands',
  REF_SSID=REF_DIR+'Wi-Fi SSID patterns', REF_MAC=REF_DIR+'MAC prefixes (drones, trackers, cameras)', REF_BLE=REF_DIR+'BLE trackers', REF_SPY=REF_DIR+'Spy stations';
const REF_RAW='https://raw.githubusercontent.com/smittix/intercept/main/data/';

// id пункта в Offline data; names — списки, которые он создаёт; urls — по порядку; parse(text) → {имя списка: {cols, rows}}
const REF_SRC=[
  {id:'oui', label:'MAC vendors (IEEE OUI, ~52 000 prefixes)', mb:1.4, names:[REF_OUI],
    urls:['https://raw.githubusercontent.com/nmap/nmap/master/nmap-mac-prefixes'], parse:t=>({[REF_OUI]:luParseNmapMac(t)})},
  {id:'signals', label:'Signal catalog (intercept / sigidwiki, ~1000 ranges)', mb:0.8, names:[REF_SIG],
    urls:['data/intercept-signals.json',REF_RAW+'signals.json'], parse:t=>({[REF_SIG]:luParseSignals(t)})},
  {id:'wefax', label:'WEFAX stations (intercept)', mb:0.03, names:[REF_WEFAX],
    urls:['data/intercept-wefax.json',REF_RAW+'wefax_stations.json'], parse:t=>({[REF_WEFAX]:luParseWefax(t)})},
  {id:'spy', label:'Number stations and diplomatic HF networks (intercept / priyom.org)', mb:0.05, names:[REF_SPY],
    urls:['data/intercept-spy.json'], parse:t=>({[REF_SPY]:luParseSpy(t)})},
  {id:'ids', label:'Drones, trackers, cameras, TSCM bands (intercept)', mb:0.01, names:[REF_TSCM,REF_SSID,REF_MAC,REF_BLE],
    urls:['data/intercept-ids.json'], parse:t=>{ const o=luParseIds(t); return {[REF_TSCM]:o.tscm,[REF_SSID]:o.ssid,[REF_MAC]:o.mac,[REF_BLE]:o.ble}; }},
];

async function refFetch(urls){
  let err=null;
  for(const u of urls){
    for(const via of /^https?:/.test(u) && typeof Net!=='undefined' && Net.url ? [u,Net.url(u)] : [u]){       // сперва напрямую, потом через CORS-прокси из настроек
      try{ const r=await fetch(via); if(!r.ok) throw new Error(u+' HTTP '+r.status); return await r.text(); }
      catch(e){ err=e; }
    }
  }
  throw err||new Error('no source');
}
// список → хранилище целиком: старое стирается, запись кусками (звук SDR не рвётся), метка версии — последней, по ней видно, что запись дошла до конца
async function refWrite(name,t){
  await ListDB.deleteList(name);
  for(let i=0;i<t.rows.length;i+=4000){
    await ListDB.addMany(name,t.rows.slice(i,i+4000).map(r=>tblToItem(r,t.cols)));
    await new Promise(r=>setTimeout(r,10));
  }
  await tblMetaSet(name,{cols:t.cols,ref:REF_VER});
}
async function refHas(s){
  try{ for(const name of s.names) if((await ListDB.getMeta(name))?.ref!==REF_VER) return false; return true; }
  catch(e){ return false; }
}
// текст файла → списки (разбор целиком до записи: битый файл не стирает прежний справочник)
async function refIngest(s,text){
  const lists=s.parse(text);
  for(const name in lists) await refWrite(name,lists[name]);
}
const refGet=async s=>refIngest(s,await refFetch(s.urls));

for(const s of REF_SRC) OfflineData.item({id:'ref-'+s.id, label:s.label, mb:s.mb, auto:true,
  has:()=>refHas(s), get:()=>refGet(s),
  manual:()=>s.urls.map((u,i)=>({name:s.id+i, label:u.split('/').pop(), url:u, has:()=>refHas(s)})),
  ingest:async f=>{ await refIngest(s,await f.text()); }});
