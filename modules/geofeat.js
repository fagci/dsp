"use strict";
/* ============================ Geo Features: загрузка ============================
   Аэродромы / полосы ('air') и населённые пункты ('pop') ячейками 0.5° из Overpass. Каждая ячейка — отдельная запись
   в IndexedDB (как тайлы высот, но свои ключи): скачанное не качается повторно, виды качаются независимо.
   Читают Video Overlay (показ) и Flight Sim (старт на полосе). Ядро — geofeat-kernels.js. */

const GF_URLS=['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter','https://overpass.private.coffee/api/interpreter'], GF_GAP=1200, GF_TRIES=5, GF_VER=2;
const GF_OA_URL='https://davidmegginson.github.io/ourairports-data/', GF_OA_KEY='oa:v1';
const GF_STATE={msg:''};                                // что сейчас качается — Overlay показывает в строке состояния
let gfOa=null, gfOaP=null, gfOaErr='';
const GF_MEM=new Map();                                 // ключ ячейки → данные, чтобы не читать базу на каждый кадр
let gfChain=Promise.resolve(), gfLast=0, gfDown=0;      // gfDown — до какого момента сеть не трогаем после полного отказа

// запросы к Overpass — строго по одному и не чаще раза в GF_GAP мс (публичный сервер банит за частоту).
// «Сервер занят» (429/502/503/504, 200 с remark, текст вместо JSON) — не данные: пауза и следующее зеркало.
// 400 на POST (зеркало потеряло тело запроса) — тот же запрос через GET. Возвращает разобранный JSON
function gfPost(query){
  const job=gfChain.then(async()=>{
    if(Date.now()<gfDown) throw new Error('Overpass is busy — waiting before the next try');
    let err;
    for(let k=0;k<GF_TRIES;k++){
      const wait=gfLast+GF_GAP-Date.now(); if(wait>0) await new Promise(r=>setTimeout(r,wait));
      let busy=false;
      try{
        const url=GF_URLS[k%GF_URLS.length];
        let r=await fetch(url,{method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'data='+encodeURIComponent(query)});
        if(r.status===400) r=await fetch(url+'?data='+encodeURIComponent(query));
        gfLast=Date.now();
        if([429,502,503,504].includes(r.status)){ err=new Error('server busy (HTTP '+r.status+')'); busy=true; }
        else if(!r.ok) throw new Error('HTTP '+r.status);
        else {
          let j=null; try{ j=await r.json(); }catch(e){ err=new Error('server busy (not JSON)'); busy=true; }
          if(j){ const re=gfRemarkError(j); if(re){ err=new Error('server busy: '+re); busy=true; } else return j; }
        }
      }catch(e){ err=e; gfLast=Date.now(); }
      if(!busy && !(err instanceof TypeError)) break;                 // сеть и «занят» — пробуем дальше, 4xx — нет
      await new Promise(r=>setTimeout(r,2000*(k+1)));
    }
    gfDown=Date.now()+60000;
    throw err;
  });
  gfChain=job.catch(()=>{});
  return job;
}
const gfFetch=(kind,ix,iy)=>gfPost(gfQuery(kind,ix,iy)).then(j=>gfParse(kind,j));
// База аэродромов OurAirports (два статических CSV, ~14 МБ): качается один раз целиком, хранится в базе браузера, дальше по ячейкам из памяти.
// Не зависит от Overpass; null — базы нет и сети нет (или не скачалась): тогда ячейки берутся из Overpass
function gfOaLoad(net){
  if(gfOa) return Promise.resolve(gfOa);
  if(gfOaP) return gfOaP;
  return gfOaP=(async()=>{
    let db=await geoGet(GF_OA_KEY).catch(()=>null);
    if(!db){
      if(!net) return null;
      try{
        GF_STATE.msg='downloading the airport database (OurAirports, ~14 MB)…';
        const get=async f=>{ const r=await fetch(GF_OA_URL+f); if(!r.ok) throw new Error(f+': HTTP '+r.status); return geoCsvParse(await r.text(),','); };
        db=gfOaParse(await get('airports.csv'),await get('runways.csv'));
        if(!db.ap.length) throw new Error('empty database');
        await geoPut(GF_OA_KEY,db).catch(()=>{});
        horizonPersist(); gfOaErr='';
      }catch(e){ gfOaErr=e.message; return null; }
      finally{ GF_STATE.msg=''; }
    }
    return gfOa=gfOaIndex(db);
  })().finally(()=>{ gfOaP=null; });
}
// данные ячейки: из памяти, из базы, иначе (если net) из сети
async function gfCellData(kind,ix,iy,net){
  const key=gfKey(kind,ix,iy), m=GF_MEM.get(key); if(m) return m;
  if(kind==='air'){ const oa=await gfOaLoad(net); if(oa) return gfOaCell(oa,ix,iy); }
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
// набор данных вида kind вокруг точки; missing — сколько ячеек нет (при net=false их не качаем);
// первая же ошибка загрузки прерывает цикл (error), уже полученное возвращается
async function gfLoad(kind,lat,lon,rKm,net,onStep){
  const cells=gfCells(lat,lon,rKm), got=[]; let missing=0, i=0, error='';
  for(const [ix,iy] of cells){
    if(error){ missing++; continue; }
    try{ const d=await gfCellData(kind,ix,iy,net); if(d) got.push(d); else missing++; }
    catch(e){ error=e.message; missing++; }
    onStep?.(++i,cells.length);
  }
  return {data:gfMerge(kind,got), missing, cells:cells.length, error};
}
// предзагрузка области: качаются только недостающие ячейки
async function gfPrefetch(kinds,lat,lon,rKm,onMsg){
  let total=0, done=0, bad=0, err='';
  for(const k of kinds) total+=gfCells(lat,lon,rKm).length;
  if(total>400){ onMsg('too large: '+total+' cells — lower the radius'); return; }
  for(const k of kinds){
    if(k==='air'){                                         // база OurAirports покрывает весь мир — ячейки Overpass не нужны
      onMsg('airport database…');
      if(await gfOaLoad(true)){ done+=gfCells(lat,lon,rKm).length; continue; }
      onMsg('airport database: '+gfOaErr+' — trying Overpass');
    }
    for(const [ix,iy] of gfCells(lat,lon,rKm)){
      try{ await gfCellData(k,ix,iy,true); }catch(e){ bad++; err=e.message; }
      onMsg('downloading '+(++done)+'/'+total+(bad ? ', '+bad+' failed' : ''));
    }
  }
  onMsg((total-bad)+' of '+total+' cells saved'+(bad ? ', '+bad+' failed ('+err+')' : ''));
}
