"use strict";
/* ============================ Geo Data ============================
   Высота точки по карте высот (Terrarium-тайлы, те же что у Horizon: качаются разово и лежат в IndexedDB),
   узел Point Elevation, импорт объектов из открытых источников в списки Table (вышки: OSM Overpass, OpenCelliD),
   векторные слои и слои рельефа для Map. Ядро — geodata-kernels.js. */

/* ---------- высота точки ---------- */
const GD_ELEV_C=new Map();                               // 'lat,lon' (4 знака) → высота, м
const GD={view:null, err:''};                            // view — последняя нарисованная карта (область по умолчанию для импорта)
const gdElevKey=(lat,lon)=>lat.toFixed(4)+','+lon.toFixed(4);
// байты тайла из сети (Horizon: IndexedDB + сеть) или только из IndexedDB (net=false)
async function gdDemTile(z,x,y,net){
  if(net!==false) return horizonTile(z,x,y);
  const buf=await geoGet('dem:'+z+'/'+x+'/'+y).catch(()=>null);
  if(!buf) throw new Error('tile not downloaded');
  return horizonDecode(buf);
}
// высота рельефа в точке, м над уровнем моря; NaN — данных нет (нет сети / вне покрытия)
async function geoElevAt(lat,lon,o){
  o=o||{};
  const z=Math.round(o.z||11), net=o.net!==false;
  if(!(Math.abs(lat)<=85) || !isFinite(lon)) return NaN;
  const ck=gdElevKey(lat,lon), hit=GD_ELEV_C.get(ck); if(hit!==undefined) return hit;
  const H=Horizon;
  if(H.hAt && H.lat!=null && geoDist(H.lat,H.lon,lat,lon)<H.radius*.95){ const h=H.hAt(lat,lon); if(h===h) return h; }
  const W=(1<<z)*256, fx=mercX(lon)*W-.5, fy=mercY(lat)*W-.5, x0=Math.floor(fx), y0=Math.floor(fy), tiles=new Map();
  for(const [ix,iy] of [[x0,y0],[x0+1,y0],[x0,y0+1],[x0+1,y0+1]]){
    if(iy<0 || iy>=W) continue;
    const wx=(((ix%W)+W)%W)>>8, k=wx+'/'+(iy>>8);
    if(tiles.has(k)) continue;
    try{ tiles.set(k,await gdDemTile(z,wx,iy>>8,net)); }catch(e){ GD.err=e.message; }
  }
  if(!tiles.size) return NaN;
  const h=horizonSampler(tiles,z)(lat,lon);
  if(h===h){ if(GD_ELEV_C.size>5000) GD_ELEV_C.delete(GD_ELEV_C.keys().next().value); GD_ELEV_C.set(ck,h); }
  return h;
}

// Входящие записи получают ground (рельеф под точкой) и alt / h; провода lat / lon — то же числами.
def({ id:'geoElev', title:'Point Elevation', cat:'Geo', kw:'elevation altitude height ground terrain dem srtm point above sea level agl',
  ins:[{n:'rec',t:'rec'},{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'h',t:'num'}],
  outs:[{n:'rec',t:'rec'},{n:'ground',t:'num'},{n:'alt',t:'num'},{n:'count',t:'num'}],
  readout:true,
  params:[{n:'hdef',t:'num',d:0,label:'height above ground for points without h and alt, m (alt = ground + h)'},
          {n:'force',t:'check',d:false,label:'recalculate alt = ground + h even when alt is set'},
          {n:'zoom',t:'range',min:8,max:13,step:1,d:11,label:'terrain zoom (10 ≈ 150 m per pixel, 12 ≈ 40 m)'},
          {n:'net',t:'check',d:true,label:'download missing terrain tiles'}],
  init:n=>{ n.q=[]; n.done=[]; n.busy=false; n.count=0; n.miss=0; n.ground=null; n.alt=null; n.ptKey=''; n.last=null; },
  process(n,I){
    for(const r of recList(I.rec)) n.q.push(r);
    if(n.q.length>5000) n.q.splice(0,n.q.length-5000);
    if(n.q.length && !n.busy) gdElevPump(n);
    const lat=recNum(I.lat), lon=recNum(I.lon), h=recNum(I.h);
    if(lat!=null && lon!=null){
      const key=[lat,lon,h,n.p.hdef,n.p.zoom].join('|');
      if(key!==n.ptKey){
        n.ptKey=key;
        geoElevAt(lat,lon,{z:n.p.zoom,net:n.p.net}).then(g=>{
          if(n.ptKey!==key) return;
          n.ground=g===g ? g : null; n.alt=g===g ? g+(h ?? (+n.p.hdef||0)) : null;
        });
      }
    }
    const out=n.done.length ? n.done.splice(0) : null;
    return {rec:out, ground:n.ground, alt:n.alt, count:n.count};
  },
  draw(n){ n.el.querySelector('.readout').textContent='points '+n.count+(n.miss ? ' · no terrain '+n.miss+(GD.err ? ' ('+GD.err+')' : '') : '')+
    (n.last ? '\n'+recText(n.last,new Set(['icon','label'])) : ''); }});
async function gdElevPump(n){
  n.busy=true;
  try{
    while(n.q.length){
      const r=n.q.shift(), pos=geoRecPos(r);
      if(!pos){ n.done.push(r); continue; }
      const g=await geoElevAt(pos.lat,pos.lon,{z:n.p.zoom,net:n.p.net}).catch(()=>NaN);
      let o=r;
      if(g===g){
        if(recNum(r.h)==null && recNum(r.alt)==null) o={...r,h:+n.p.hdef||0};
        o=gdApplyGround(o,g,n.p.force); n.count++;
      } else n.miss++;
      n.last=o; n.done.push(o);
    }
  } finally{ n.busy=false; }
}

/* ---------- объекты из открытых источников → списки Table ---------- */
// строки в список (по id без дублей; недостающие колонки добавляются) — по очереди с остальными записями geostore
const gdUpsert=(list,cols,rows)=>gsSerial(async()=>{
  if(!rows.length) return 0;
  const have=new Set((await gsRead(list)).map(r=>String(r.id)));
  const fresh=rows.filter(r=>!have.has(String(r.id)));
  if(fresh.length) await tblPut(list,cols,fresh);
  return fresh.length;
});
// объекты вида kind в рамке bbox. Возвращает {rows, added, list}
async function gdImportOsm(kind,bbox,o){
  o=o||{};
  const km2=gdBboxKm2(bbox);
  if(km2>(kind==='peaks' ? 40000 : 10000)) throw new Error('area is '+Math.round(km2)+' km² — zoom in or lower the radius');
  const json=await gfPost(gdQuery(kind,bbox,o.custom));
  let rows, cols, list;
  if(kind==='custom'){ const g=gdParseGeneric(json); rows=g.rows; cols=g.cols; list=o.list||'geo/osm'; }
  else { rows=gdParseOverpass(kind,json); cols=GD_COLS[kind]; list=GD_KINDS[kind].list; }
  return {rows, added:await gdUpsert(list,cols,rows), list, cols};
}
async function gdImportCellApi(key,bbox,onMsg){
  const rows=[], seen=new Set(), page=200;
  for(let off=0;off<page*20;off+=page){
    onMsg?.('OpenCelliD '+rows.length+'…');
    const r=await fetch(Net.url(gdCellUrl(key,bbox,page,off)));
    if(!r.ok) throw new Error(r.status===401||r.status===403 ? 'OpenCelliD refused the key (HTTP '+r.status+')' : 'OpenCelliD: HTTP '+r.status);
    const j=await r.json().catch(()=>null), cells=j?.cells;
    if(!Array.isArray(cells)) throw new Error('OpenCelliD: '+(j?.error||j?.message||'unexpected answer'));
    for(const c of cells){ const x=gdCellRow(c); if(x && !seen.has(x.id)){ seen.add(x.id); rows.push(x); } }
    if(cells.length<page) break;
  }
  return {rows, added:await gdUpsert(GD_KINDS.towers.list,GD_COLS.towers,rows), list:GD_KINDS.towers.list};
}
// дамп OpenCelliD (cell_towers.csv или .csv.gz, десятки миллионов строк): поточно, в память только то, что прошло фильтр
async function gdImportCellFile(file,o,onMsg){
  const f=gdCellFilter(o), rows=[], seen=new Set(), max=o.max||50000;
  let stream=file.stream();
  if(/\.gz$/i.test(file.name)){
    if(typeof DecompressionStream==='undefined') throw new Error('this browser cannot unpack .gz — unpack the file first');
    stream=stream.pipeThrough(new DecompressionStream('gzip'));
  }
  const rd=stream.pipeThrough(new TextDecoderStream()).getReader();
  let tail='', n=0, tick=0;
  const eat=line=>{ n++; const r=f(line.trim()); if(r && !seen.has(r.id)){ seen.add(r.id); rows.push(r); } };
  for(;;){
    const {done,value}=await rd.read(); if(done) break;
    const parts=(tail+value).split('\n'); tail=parts.pop();
    for(const l of parts) eat(l);
    if(rows.length>=max){ rd.cancel().catch(()=>{}); break; }
    if(++tick%20===0){ onMsg?.('read '+Math.round(n/1000)+'k lines · matched '+rows.length); await new Promise(r=>setTimeout(r)); }
  }
  if(tail) eat(tail);
  return {rows, added:await gdUpsert(GD_KINDS.towers.list,GD_COLS.towers,rows), list:GD_KINDS.towers.list, capped:rows.length>=max};
}

// область: «lat, lon, км» или «view» (рамка последней карты); по умолчанию — карта, иначе My Position
function gdAskArea(){
  const v=GD.view?.n ? gdMapBox(GD.view.n) : null;
  const def=v ? 'view' : GeoMe.lat!=null ? GeoMe.lat.toFixed(4)+', '+GeoMe.lon.toFixed(4)+', 10' : '55.0, 83.0, 10';
  const s=prompt('Area: "lat, lon, radius km" or "view" (what the Map shows now):',def); if(s==null) return null;
  if(/^\s*view\s*$/i.test(s)){ if(!v){ alert('no Map has been drawn yet'); return null; } return v; }
  const m=s.split(/[\s,;]+/).map(Number);
  if(m.length<3 || m.slice(0,3).some(x=>!isFinite(x))){ alert('need three numbers: lat, lon, radius km'); return null; }
  return gdBboxAround(m[0],m[1],Math.min(m[2],200));
}
function gdMapBox(n){
  const cv=n.cv; if(!cv) return null;
  const v=geoView(n,cv.width,cv.height);
  const lat1=unmercY(clamp(v.oy/v.S,0,1)), lat0=unmercY(clamp((v.oy+v.H)/v.S,0,1));
  const lon0=unmercX((v.ox)/v.S), lon1=unmercX((v.ox+v.W)/v.S);
  if(lon1-lon0>=360 || lon1<lon0) return null;
  return [lat0,lon0,lat1,lon1];
}
// записи для карты из строк списка
function gdRowsToRecs(rows){
  return rows.filter(r=>isFinite(+r.lat) && isFinite(+r.lon)).map(r=>{
    const o={...r}; for(const k in o) if(o[k]==='' || o[k]==null) delete o[k];
    o.label=r.name || r.radio || r.id; o.track=0; return o;
  });
}
function gdKindTitle(k){ return GD_KINDS[k]?.title || k; }

// меню «open data» в Table
function gdOpenMenu(n){
  const root=n.ui.root; root.querySelector('.tbl-menu')?.remove();
  const m=document.createElement('div'); m.className='tbl-menu';
  m.style.cssText='position:absolute;z-index:20;left:0;right:0;top:20px;max-height:75%;overflow-y:auto;background:#161b1e;border:1px solid #2a3136;border-radius:3px;box-shadow:0 4px 14px #000a;';
  const item=(title,desc,fn)=>{
    const d=document.createElement('div'); d.style.cssText='padding:4px 8px;cursor:pointer;border-bottom:1px solid #1d2226;';
    d.innerHTML='<div style="color:#c8d2d6;">'+escapeHtml(title)+'</div><div style="color:#6c7a80;font-size:9px;white-space:normal;">'+escapeHtml(desc)+'</div>';
    d.addEventListener('mouseenter',()=>{ d.style.background='#1f3a36'; }); d.addEventListener('mouseleave',()=>{ d.style.background=''; });
    d.addEventListener('click',()=>{ m.remove(); fn().catch(e=>alert(e.message||e)); }); m.append(d);
  };
  const done=async r=>{ n.dataMsg=''; alert(r.added+' new of '+r.rows.length+' found → list "'+r.list+'"'+(r.capped ? '\n(stopped at the limit — narrow the area or the MCC)' : '')); await tblPick(n,r.list); tblRenderAll(n); };
  const osm=kind=>async()=>{ const b=gdAskArea(); if(b) await done(await gdImportOsm(kind,b)); };
  item('Cell towers around a point (OpenStreetMap)','No key. Masts and towers tagged as mobile / GSM / UMTS / LTE / 5G, antennas. Coverage depends on the mappers — OpenCelliD below is usually denser. → geo/towers',osm('towers'));
  item('Cell towers: OpenCelliD (API key)','Free key from opencellid.org (Account → API). Cell id, MCC / MNC / LAC / CID, radio, estimated range (drawn as a circle on the Map). The key is kept in this browser; a CORS proxy from Settings is used if set. → geo/towers',async()=>{
    let key=LS.get('dsp-opencellid')||''; key=(prompt('OpenCelliD API key:',key)||'').trim(); if(!key) return;
    LS.set('dsp-opencellid',key);
    const b=gdAskArea(); if(!b) return;
    await done(await gdImportCellApi(key,b,s=>{ n.dataMsg=s; }));
  });
  item('Cell towers: OpenCelliD dump file (.csv / .csv.gz)','The full dump from opencellid.org/downloads (needs a token there). Read in a stream, only the area and the MCC you give are kept — works offline. → geo/towers',async()=>{
    const b=gdAskArea(); if(!b) return;
    const mcc=prompt('MCC filter (country code, e.g. 250 for Russia; empty — all):','')??null; if(mcc==null) return;
    const inp=document.createElement('input'); inp.type='file'; inp.accept='.csv,.gz,.txt,text/csv';
    inp.onchange=async()=>{
      const f=inp.files[0]; if(!f) return;
      try{ await done(await gdImportCellFile(f,{bbox:b,mcc},s=>{ n.dataMsg=s; if(n.ui) n.ui.count.textContent=s; })); }catch(e){ alert(e.message||e); }
    };
    inp.click();
  });
  item('Broadcast masts: FM / TV (OpenStreetMap)','Masts tagged communication:radio / television. → geo/towers',osm('broadcast'));
  item('All communication masts and towers (OpenStreetMap)','tower:type=communication, communications_tower. → geo/towers',osm('masts'));
  item('Amateur radio repeaters (OpenStreetMap)','repeater=*, amateur_radio. → geo/repeaters',osm('repeaters'));
  item('Peaks with elevation (OpenStreetMap)','natural=peak. → geo/peaks',osm('peaks'));
  item('Custom Overpass query…','Any Overpass QL; {{bbox}} is replaced by the area. Columns come from the tags found. → geo/osm',async()=>{
    const q=prompt('Overpass QL, e.g.  nwr["amenity"="hospital"]{{bbox}};out center;','nwr["amenity"="hospital"]{{bbox}};out center;'); if(!q) return;
    const b=gdAskArea(); if(b) await done(await gdImportOsm('custom',b,{custom:q}));
  });
  item('⛰ Fill ground elevation of this list','Adds the column «ground» (terrain height at lat / lon, m); alt is filled from h where it is empty.',async()=>{ await gdTableElev(n); });
  root.append(m);
  const off=e=>{ if(!m.contains(e.target)){ m.remove(); document.removeEventListener('pointerdown',off,true); } };
  setTimeout(()=>document.addEventListener('pointerdown',off,true));
}
// колонка ground для строк с координатами (альтитуда alt — из ground + h, если пуста); правки пачкой, дерево один раз
async function gdTableElev(n){
  if(tblRO(n)){ alert('built-in list is read-only: copy it first'); return; }
  if(!n.latCol || !n.lonCol){ alert('this list has no lat / lon columns'); return; }
  if(!n.cl.includes('ground')) await tblColsEdit(n,[...n.cl,'ground']);
  const hasAlt=n.cl.includes('alt'), hasH=n.cl.includes('h'), db=tblKind(n.p.list)==='db';
  let ok=0, miss=0;
  for(let k=0;k<n.all.length;k++){
    const r=n.all[k], la=recNum(r[n.latCol]), lo=recNum(r[n.lonCol]);
    if(la==null || lo==null || (r.ground!=='' && r.ground!=null)) continue;
    const g=await geoElevAt(la,lo).catch(()=>NaN);
    if(g!==g){ miss++; continue; }
    const x=gdApplyGround(r,g,false), o={...r,ground:x.ground};
    if(hasAlt && (r.alt==='' || r.alt==null) && x.alt!=null) o.alt=x.alt;
    if(hasH && (r.h==='' || r.h==null) && x.h!=null) o.h=x.h;
    n.all[k]=o; ok++;
    if(db){ const it=tblToItem(o,n.cl); await ListDB.update(n.ids[k],{name:it.name,fields:it.fields,value:it.fields.value??''}); }
    if(ok%20===0 && n.ui) n.ui.count.textContent='ground '+ok+'…';
  }
  if(!db) await tblSave(n);
  tblDerive(n); tblRenderAll(n);
  alert(ok+' rows filled'+(miss ? ', '+miss+' without terrain data ('+(GD.err||'no network?')+')' : ''));
}

/* ---------- Map: клик с учётом высоты, импорт в окне, векторные слои ---------- */
// тап по пустому месту: запись pick уходит, когда известна высота рельефа (ground); без данных — без неё
function geoMapPick(n,lat,lon){
  const t=Date.now(), grid=latLonToGrid(lat,lon,6);
  n.info={lat,lon,t,ground:undefined};
  const info=n.info;
  Promise.race([geoElevAt(lat,lon,{z:11,net:n.p.net}), new Promise(r=>setTimeout(()=>r(NaN),5000))]).then(g=>{
    const rec={t,lat:+lat.toFixed(6),lon:+lon.toFixed(6),grid};
    if(g===g){ rec.ground=Math.round(g*10)/10; info.ground=rec.ground; } else info.ground=null;
    info.t=Date.now(); n.pickRec=[rec]; n.dirtyGen=(n.dirtyGen|0)+1;
  });
  n.pickLat=lat; n.pickLon=lon;
}
// объекты OSM в окне карты: на карту и в список Table (geo/towers …)
async function gdMapImport(n,kind){
  const b=gdMapBox(n);
  if(!b){ n.vmsg='zoom in a little'; return; }
  n.vmsg='loading '+gdKindTitle(kind)+'…'; geoMapChanged(n);
  try{
    const r=await gdImportOsm(kind,b);
    for(const x of gdRowsToRecs(r.rows)) geoMapAdd(n,x);
    n.vmsg=r.rows.length+' found, '+r.added+' new → '+r.list;
  }catch(e){ n.vmsg='error: '+(e.message||e); }
  geoMapChanged(n);
}

// векторный слой: {name, feats} хранится в IndexedDB ('vec:'+name), в патче — только имена (p.vlayers)
function gdVecAdd(n,layer,persist){
  const vs=n.vec || (n.vec=new Map());
  const prep=gdVecPrep(layer,vs.size);
  vs.set(layer.name,{layer,prep});
  for(const r of prep.points) geoMapAdd(n,r);
  n.vgen=(n.vgen|0)+1; geoMapChanged(n);
  if(persist){
    const names=Array.isArray(n.p.vlayers) ? n.p.vlayers.filter(x=>x!==layer.name) : [];
    n.p.vlayers=[...names,layer.name];
    geoPut('vec:'+layer.name,layer).catch(()=>{});
  }
  n.vmsg=layer.name+': '+prep.lines.length+' lines, '+prep.polys.length+' polygons, '+prep.points.length+' points'+(prep.nv>=2e6 ? ' (vertex limit reached)' : '');
}
function gdVecFile(n,f){
  const rd=new FileReader();
  rd.onload=()=>{
    try{ gdVecAdd(n,gdParseVector(String(rd.result),f.name.replace(/\.[^.]+$/,'')),true); }
    catch(e){ n.vmsg='vector: '+e.message+(/\.(zip|shp|gpkg)$/i.test(f.name) ? ' (convert to GeoJSON first)' : ''); }
  };
  rd.readAsText(f);
}
function gdVecClear(n){
  for(const nm of n.p.vlayers||[]) geoPut('vec:'+nm,null).catch(()=>{});
  for(const k of [...n.ents.keys()]) if(k.startsWith('id:v:')) n.ents.delete(k);
  n.vec=new Map(); n.p.vlayers=[]; n.vgen=(n.vgen|0)+1; n.vmsg=''; geoMapChanged(n);
}
async function gdVecRestore(n){
  if(n.vec) return;
  n.vec=new Map();
  for(const nm of n.p.vlayers||[]){
    const l=await geoGet('vec:'+nm).catch(()=>null);
    if(l && l.feats) gdVecAdd(n,l,false);
  }
}
// линии и полигоны слоёв — в подложку (кэшируется вместе с ней)
function gdVecDraw(n,cx,v){
  if(!n.vec || !n.vec.size) return;
  cx.save(); cx.lineJoin='round'; cx.lineCap='round';
  for(const {prep} of n.vec.values()){
    for(const P of prep.polys){
      cx.beginPath(); geoPathLayer(cx,P.rings,v,99);
      cx.globalAlpha=P.fillAlpha ?? .22; cx.fillStyle=P.col; cx.fill('evenodd');
      cx.globalAlpha=.9; cx.strokeStyle=P.col; cx.lineWidth=1; cx.stroke();
    }
    const byCol=new Map();
    for(const L of prep.lines){ const a=byCol.get(L.col); if(a) a.push(L); else byCol.set(L.col,[L]); }
    cx.globalAlpha=.95; cx.lineWidth=2;
    for(const [col,arr] of byCol){ cx.beginPath(); geoPathLayer(cx,arr,v,99); cx.strokeStyle=col; cx.stroke(); }
  }
  cx.restore();
}
