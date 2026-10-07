"use strict";
/* ============================ Geo Features: загрузка ============================
   Аэродромы / полосы ('air') и населённые пункты ('pop') ячейками 0.5° из Overpass. Каждая ячейка — отдельная запись
   в IndexedDB (как тайлы высот, но свои ключи): скачанное не качается повторно, виды качаются независимо.
   Читают Video Overlay (показ) и Flight Sim (старт на полосе). Ядро — geofeat-kernels.js. */

const GF_URL='https://overpass-api.de/api/interpreter', GF_GAP=1200;
const GF_MEM=new Map();                                 // ключ ячейки → данные, чтобы не читать базу на каждый кадр
let gfChain=Promise.resolve(), gfLast=0;

// запросы к Overpass — строго по одному и не чаще раза в GF_GAP мс (публичный сервер банит за частоту)
function gfFetch(kind,ix,iy){
  const job=gfChain.then(async()=>{
    const wait=gfLast+GF_GAP-Date.now(); if(wait>0) await new Promise(r=>setTimeout(r,wait));
    let err;
    for(let k=0;k<3;k++){
      try{
        const r=await fetch(GF_URL,{method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'data='+encodeURIComponent(gfQuery(kind,ix,iy))});
        gfLast=Date.now();
        if(r.status===429 || r.status===504){ err=new Error('HTTP '+r.status); await new Promise(r=>setTimeout(r,5000*(k+1))); continue; }
        if(!r.ok) throw new Error('HTTP '+r.status);
        return gfParse(kind,await r.json());
      }catch(e){ err=e; break; }
    }
    throw err;
  });
  gfChain=job.catch(()=>{});
  return job;
}
// данные ячейки: из памяти, из базы, иначе (если net) из сети
async function gfCellData(kind,ix,iy,net){
  const key=gfKey(kind,ix,iy), m=GF_MEM.get(key); if(m) return m;
  let d=await geoGet(key).catch(()=>null);
  if(!d){
    if(!net) return null;
    d=await gfFetch(kind,ix,iy);
    await geoPut(key,d).catch(()=>{});
    horizonPersist();
  }
  GF_MEM.set(key,d);
  return d;
}
// набор данных вида kind вокруг точки; missing — сколько ячеек нет (при net=false их не качаем)
async function gfLoad(kind,lat,lon,rKm,net,onStep){
  const cells=gfCells(lat,lon,rKm), got=[]; let missing=0, i=0;
  for(const [ix,iy] of cells){
    const d=await gfCellData(kind,ix,iy,net);
    if(d) got.push(d); else missing++;
    onStep?.(++i,cells.length);
  }
  return {data:gfMerge(kind,got), missing, cells:cells.length};
}
// предзагрузка области: качаются только недостающие ячейки
async function gfPrefetch(kinds,lat,lon,rKm,onMsg){
  let total=0, done=0, bad=0, err='';
  for(const k of kinds) total+=gfCells(lat,lon,rKm).length;
  if(total>400){ onMsg('too large: '+total+' cells — lower the radius'); return; }
  for(const k of kinds){
    for(const [ix,iy] of gfCells(lat,lon,rKm)){
      try{ await gfCellData(k,ix,iy,true); }catch(e){ bad++; err=e.message; }
      onMsg('downloading '+(++done)+'/'+total+(bad ? ', '+bad+' failed' : ''));
    }
  }
  onMsg((total-bad)+' of '+total+' cells saved'+(bad ? ', '+bad+' failed ('+err+')' : ''));
}
