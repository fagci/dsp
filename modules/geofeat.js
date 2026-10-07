"use strict";
/* ============================ Geo Features: загрузка ============================
   Аэродромы / полосы ('air') и населённые пункты ('pop') ячейками 0.5° из Overpass. Каждая ячейка — отдельная запись
   в IndexedDB (как тайлы высот, но свои ключи): скачанное не качается повторно, виды качаются независимо.
   Читают Video Overlay (показ) и Flight Sim (старт на полосе). Ядро — geofeat-kernels.js. */

const GF_URLS=['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter','https://overpass.private.coffee/api/interpreter'], GF_GAP=1200, GF_TRIES=5, GF_VER=2;
const GF_MEM=new Map();                                 // ключ ячейки → данные, чтобы не читать базу на каждый кадр
let gfChain=Promise.resolve(), gfLast=0;

// запросы к Overpass — строго по одному и не чаще раза в GF_GAP мс (публичный сервер банит за частоту).
// «Сервер занят» (429/502/503/504, 200 с remark, текст вместо JSON) — не данные: пауза и следующее зеркало
function gfFetch(kind,ix,iy){
  const job=gfChain.then(async()=>{
    let err;
    for(let k=0;k<GF_TRIES;k++){
      const wait=gfLast+GF_GAP-Date.now(); if(wait>0) await new Promise(r=>setTimeout(r,wait));
      let busy=false;
      try{
        const r=await fetch(GF_URLS[k%GF_URLS.length],{method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'data='+encodeURIComponent(gfQuery(kind,ix,iy))});
        gfLast=Date.now();
        if([429,502,503,504].includes(r.status)){ err=new Error('server busy (HTTP '+r.status+')'); busy=true; }
        else if(!r.ok) throw new Error('HTTP '+r.status);
        else {
          let j=null; try{ j=await r.json(); }catch(e){ err=new Error('server busy (not JSON)'); busy=true; }
          if(j){ const re=gfRemarkError(j); if(re){ err=new Error('server busy: '+re); busy=true; } else return gfParse(kind,j); }
        }
      }catch(e){ err=e; gfLast=Date.now(); }
      if(!busy && !(err instanceof TypeError)) break;                 // сеть и «занят» — пробуем дальше, 4xx — нет
      await new Promise(r=>setTimeout(r,3000*(k+1)));
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
  if(d && !d.v && gfEmpty(d)) d=null;                  // пустые ячейки старого формата могли быть ответом «сервер занят» — перекачать
  if(!d){
    if(!net) return null;
    d={...await gfFetch(kind,ix,iy), v:GF_VER};
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
