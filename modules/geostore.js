"use strict";
/* ============================ Geo Store: точки у земной поверхности в списках Table ============================
   Аэродромы, полосы, населённые пункты, вершины лежат в списках geo/airfields, geo/runways, geo/places, geo/peaks
   (браузерная база списков Table, как и свои точки пользователя) — их видно в Table, их можно править, брать на карту
   (rec / rows → Map), в Video Overlay и анализ. Загрузчики (geofeat.js: OurAirports, Overpass, встроенные города) только
   дописывают недостающее: строка с известным id не перезаписывается, правки пользователя остаются.
   Ядро (схемы, строки) — geofeat-kernels.js. */

const GS_CELLS_KEY='gs:cells';                           // какие ячейки уже перенесены в таблицы (ключи в базе geo)
let gsDone=null;                                          // Set ключей 'kind:ix:iy'
const gsIds=new Map();                                    // список → {rev, ids:Set} (id уже есть в таблице)
const gsCache=new Map();                                  // список → {rev, rows, p}

// строки списка {cols,rows}; кэш по ListDB.rev
async function gsRead(list){
  const c=gsCache.get(list);
  if(c && c.rev===ListDB.rev) return c.rows;
  if(c?.p) return c.p;
  const rev=ListDB.rev, ent=c||{};
  ent.p=(async()=>{
    const [items,meta]=await Promise.all([ListDB.list(list),ListDB.getMeta(list)]);
    const rows=tblDbRows(items,meta).rows;
    ent.rev=rev; ent.rows=rows; ent.p=null; return rows;
  })();
  gsCache.set(list,ent);
  return ent.p;
}
// то же без ожидания: что есть сейчас; если список изменился — запускает перечитывание и зовёт onChange
function gsPeek(list,onChange){
  const c=gsCache.get(list);
  if(!c || (c.rev!==ListDB.rev && !c.p)) gsRead(list).then(()=>onChange?.()).catch(()=>{});
  return gsCache.get(list)?.rows || [];
}
// записи в списки идут строго по очереди (Overlay, Flight Sim и OSM пишут одновременно — без дублей строк)
let gsQ=Promise.resolve();
const gsSerial=f=>{ const j=gsQ.then(f); gsQ=j.catch(()=>{}); return j; };
// добавить строки, которых нет по id; cols — схема списка (недостающие колонки добавляются, порядок сохраняется)
const gsUpsert=(kind,rows)=>gsSerial(()=>gsUpsertRaw(kind,rows));
async function gsUpsertRaw(kind,rows){
  if(!rows.length) return 0;
  const list=GS_LISTS[kind], cols=GS_COLS[kind];
  const have=new Set((await gsRead(list)).map(r=>String(r.id)));
  const fresh=rows.filter(r=>!have.has(String(r.id)));
  if(!fresh.length) return 0;
  await tblPut(list,cols,fresh);
  return fresh.length;
}
async function gsRegistry(){
  if(!gsDone) gsDone=new Set((await geoGet(GS_CELLS_KEY).catch(()=>null)) || []);
  return gsDone;
}
// перенести область вокруг точки в таблицы: нужные ячейки качаются (net) и записываются; уже перенесённые пропускаются
const gsEnsure=(kind,lat,lon,rKm,net,onStep)=>gsSerial(()=>gsEnsureRun(kind,lat,lon,rKm,net,onStep));
async function gsEnsureRun(kind,lat,lon,rKm,net,onStep){
  const reg=await gsRegistry(), cells=gfCells(lat,lon,rKm); let added=0, error='', i=0;
  for(const [ix,iy] of cells){
    onStep?.(++i,cells.length);
    const key=kind+':'+ix+':'+iy; if(reg.has(key)) continue;
    let data;
    try{ data=await gfCellData(kind,ix,iy,net); }catch(e){ error=e.message; break; }
    if(!data) continue;                                   // нет в базе и сети нет — в следующий раз
    const src=kind==='air' ? (gfOa ? 'ourairports' : 'osm') : 'osm';
    const rows=gfToRows(data,src);
    for(const k of kind==='air' ? ['air','rw'] : ['pop']) added+=await gsUpsertRaw(k,rows[k]);
    reg.add(key); await geoPut(GS_CELLS_KEY,[...reg]).catch(()=>{});
  }
  return {added,error};
}
// встроенные города (Natural Earth / GeoNames из Map) → geo/places, один раз на ячейку 1°
const gsEnsureBuiltin=(lat,lon,rKm)=>gsSerial(()=>gsEnsureBuiltinRun(lat,lon,rKm));
// встроенные города: базовая карта (Natural Earth, без сети) и, если скачаны, GeoNames — в радиусе rKm
function gsLocalPlaces(lat,lon,rKm){
  const out=[], push=(id,la,lo,name,pop)=>{ if(name && gfDistKm(lat,lon,la,lo)<=rKm) out.push({id,lat:la,lon:lo,name,kind:gfPopKind(pop),pop}); };
  const G=GeoBase.places;
  if(G){
    const dLat=Math.ceil(rKm/111.19)+1, dLon=Math.ceil(rKm/(111.19*Math.max(.05,Math.cos(lat*D2R))))+1, la0=Math.floor(lat+90), lo0=Math.floor(lon+180);
    for(let a=la0-dLat;a<=la0+dLat;a++) for(let b=lo0-dLon;b<=lo0+dLon;b++){
      for(const i of (G.cells.get(a*360+((b%360)+360)%360)||[])) push('g'+i,G.lat[i],G.lon[i],G.name[i],G.pop[i]);
    }
  } else for(const q of (GeoBase.data?.places||[])) push('b'+q.name+q.x,unmercY(q.y),unmercX(q.x),q.name,q.pop);
  return out;
}
async function gsEnsureBuiltinRun(lat,lon,rKm){
  const reg=await gsRegistry(); await geoBaseLoad().catch(()=>{});
  const dLat=Math.ceil(rKm/111.19), dLon=Math.ceil(rKm/(111.19*Math.max(.05,Math.cos(lat*D2R)))); let added=0;
  for(let a=Math.floor(lat)-dLat;a<=Math.floor(lat)+dLat;a++) for(let b=Math.floor(lon)-dLon;b<=Math.floor(lon)+dLon;b++){
    const key='pop:builtin:'+a+':'+b; if(reg.has(key)) continue;
    const pl=gsLocalPlaces(a+.5,b+.5,80).filter(q=>Math.floor(q.lat)===a && Math.floor(q.lon)===b);
    added+=await gsUpsertRaw('pop',pl.map(q=>({id:q.id,name:q.name,kind:q.kind,lat:q.lat,lon:q.lon,pop:q.pop||'',src:'builtin'})));
    reg.add(key);
  }
  if(added) await geoPut(GS_CELLS_KEY,[...reg]).catch(()=>{});
  return added;
}
// строки списка вокруг точки в формате потребителей; fromRow — gfApFromRow и т.п.
function gsNear(rows,fromRow,lat,lon,rKm,max){
  const out=[];
  for(const r of rows){
    const q=fromRow(r); if(!q) continue;
    const la=q.lat ?? (q.pts[0][0]+q.pts[1][0])/2, lo=q.lon ?? (q.pts[0][1]+q.pts[1][1])/2, d=gfDistKm(lat,lon,la,lo);
    if(d<=rKm) out.push({q,d});
  }
  return out.sort((a,b)=>a.d-b.d).slice(0,max).map(x=>x.q);
}

// аэродромы и полосы вокруг точки из таблиц (при необходимости сначала переносит область в таблицы)
async function gsAir(lat,lon,rKm,net){
  const r=await gsEnsure('air',lat,lon,rKm,net);
  const [ap,rw]=await Promise.all([gsRead(GS_LISTS.air),gsRead(GS_LISTS.rw)]);
  return {data:{ap:gsNear(ap,gfApFromRow,lat,lon,rKm,200), rw:gsNear(rw,gfRwFromRow,lat,lon,rKm,400)}, error:r.error};
}
