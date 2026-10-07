"use strict";
/* ============================ Ядро Geo Data ============================
   Высота точки по карте высот, объекты из открытых источников (OSM Overpass, OpenCelliD) → строки Table,
   векторные слои (GeoJSON / KML / GPX) → линии и полигоны для карты. Без DOM — проверяется tools/test-geodata.mjs. */

const GD_D=Math.PI/180;
const gdMx=lon=>(lon+180)/360;
const gdMy=lat=>{ const s=Math.sin(Math.max(-85.0511,Math.min(85.0511,lat))*GD_D); return 0.5-Math.log((1+s)/(1-s))/(4*Math.PI); };
const gdNum=v=>{ const x=typeof v==='number' ? v : parseFloat(v); return isFinite(x) ? x : null; };

/* ---------- высота точки ---------- */
// Terrarium: высота = R·256 + G + B/256 − 32768, м
const gdTerrarium=(r,g,b)=>r*256+g+b/256-32768;
// Запись с землёй под точкой: ground — над уровнем моря; h — над землёй, alt — над уровнем моря.
// Есть h — alt = ground + h; есть alt без h — h = alt − ground (антенна/GPS над землёй). force — пересчитать alt при любом h.
function gdApplyGround(r,ground,force){
  if(ground==null || !isFinite(ground)) return r;
  const o={...r}, g=Math.round(ground*10)/10, h=gdNum(r.h), alt=gdNum(r.alt);
  o.ground=g;
  if(h!=null && (alt==null || force)) o.alt=Math.round((g+h)*10)/10;
  else if(h==null && alt!=null) o.h=Math.round((alt-g)*10)/10;
  return o;
}
// цвета рельефа: высота → [r,g,b]; shade 0.5…1.5 — подсветка склона
const GD_RAMP=[[-50,[40,70,130]],[0,[60,130,90]],[200,[110,160,80]],[600,[190,190,100]],[1200,[170,130,80]],[2500,[140,110,100]],[4000,[230,230,235]],[6000,[255,255,255]]];
function gdReliefColor(h,shade=1){
  if(!(h===h)) return [0,0,0];
  let a=GD_RAMP[0], b=GD_RAMP[GD_RAMP.length-1];
  if(h<=a[0]) b=a; else if(h>=b[0]) a=b; else for(let i=1;i<GD_RAMP.length;i++) if(h<=GD_RAMP[i][0]){ a=GD_RAMP[i-1]; b=GD_RAMP[i]; break; }
  const t=b[0]===a[0] ? 0 : (h-a[0])/(b[0]-a[0]);
  return [0,1,2].map(k=>Math.max(0,Math.min(255,Math.round((a[1][k]+(b[1][k]-a[1][k])*t)*shade))));
}

// Тайл высот 256×256 (Float32, м) → RGBA. mode 'color': гипсометрия с подсветкой склонов; 'shade': только светотень (серый, прозрачный на ровном).
// mpp — метров в пикселе; свет с северо-запада, высота 45°; zf — вертикальное преувеличение
function gdDemShade(h,mpp,mode,zf=2){
  const out=new Uint8ClampedArray(256*256*4), L=[-.5,.5,.7071], k=zf/(2*Math.max(mpp,1));
  for(let y=0;y<256;y++){
    const ya=y>0 ? y-1 : y, yb=y<255 ? y+1 : y;
    for(let x=0;x<256;x++){
      const xa=x>0 ? x-1 : x, xb=x<255 ? x+1 : x, i=y*256+x;
      const dx=(h[y*256+xb]-h[y*256+xa])*k*(x>0&&x<255 ? 1 : 2), dy=(h[yb*256+x]-h[ya*256+x])*k*(y>0&&y<255 ? 1 : 2);
      const nl=Math.sqrt(dx*dx+dy*dy+1), s=Math.max(0,(-dx*L[0]+dy*L[1]+L[2])/nl), f=s/.7071, o=i*4;
      if(mode==='shade'){
        const dark=f<1;
        out[o]=out[o+1]=out[o+2]=dark ? 0 : 255; out[o+3]=Math.round(Math.min(1,dark ? (1-f)*1.1 : (f-1)*.9)*150);
      } else {
        const c=gdReliefColor(h[i],.35+.65*Math.min(1.4,f));
        out[o]=c[0]; out[o+1]=c[1]; out[o+2]=c[2]; out[o+3]=255;
      }
    }
  }
  return out;
}

/* ---------- Overpass: объекты в рамке ---------- */
// bbox = [south, west, north, east]
const GD_KINDS={
  towers:{title:'Cell towers & masts (OSM)', list:'geo/towers', icon:'tx',
    q:b=>`nwr["man_made"~"^(mast|tower)$"]["tower:type"="communication"]["communication:mobile_phone"="yes"]${b};`+
         `nwr["man_made"~"^(mast|tower)$"]["communication:mobile_phone"="yes"]${b};`+
         `nwr["man_made"~"^(mast|tower)$"]["tower:type"="communication"][~"^communication:(gsm|umts|lte|5g|nr)$"~"^yes$"]${b};`+
         `nwr["telecom"~"^(antenna|cell_tower|base_station)$"]${b};`},
  broadcast:{title:'Broadcast masts: FM / TV / radio (OSM)', list:'geo/towers', icon:'tx',
    q:b=>`nwr["man_made"~"^(mast|tower)$"][~"^communication:(radio|television|fm|dvb)"~"^yes$"]${b};`+
         `nwr["man_made"~"^(mast|tower)$"]["tower:type"="communication"]["communication:radio"]${b};`},
  masts:{title:'All communication masts and towers (OSM)', list:'geo/towers', icon:'tx',
    q:b=>`nwr["man_made"~"^(mast|tower)$"]["tower:type"="communication"]${b};nwr["man_made"="communications_tower"]${b};`},
  repeaters:{title:'Radio repeaters, amateur (OSM)', list:'geo/repeaters', icon:'antenna',
    q:b=>`nwr["repeater"]${b};nwr["communication:amateur_radio"="yes"]${b};nwr["amenity"="amateur_radio_repeater"]${b};`},
  peaks:{title:'Peaks with elevation (OSM)', list:'geo/peaks', icon:'triangle',
    q:b=>`node["natural"="peak"]["name"]${b};`},
};
const GD_COLS={
  towers:['id','name','operator','kind','radio','ref','lat','lon','h','ele','mcc','mnc','lac','cid','range','samples','updated','icon','radius','src'],
  repeaters:['id','name','operator','freq','tone','mode','lat','lon','h','ele','icon','src'],
  peaks:['id','name','lat','lon','ele','src'],
};
function gdQuery(kind,bbox,custom){
  const b='('+bbox.map(v=>+v.toFixed(5)).join(',')+')';
  if(kind==='custom'){
    const q=String(custom||'').replace(/\{\{bbox\}\}/g,b).trim();
    return /\[out:json\]/.test(q) ? q : '[out:json][timeout:60];'+q;
  }
  const K=GD_KINDS[kind]; if(!K) throw new Error('unknown kind: '+kind);
  return '[out:json][timeout:60];('+K.q(b)+');out center tags 4000;';
}
function gdBboxAround(lat,lon,rKm){
  const dLat=rKm/111.19, dLon=Math.min(180,dLat/Math.max(.05,Math.cos(lat*GD_D)));
  return [Math.max(-85,lat-dLat),lon-dLon,Math.min(85,lat+dLat),lon+dLon];
}
const gdBboxKm2=b=>(b[2]-b[0])*111.19*(b[3]-b[1])*111.19*Math.cos((b[0]+b[2])/2*GD_D);
// ширина тега height: «45», «45 m», «150 ft»
function gdHeight(s){
  const m=String(s??'').trim().match(/^(-?[\d.]+)\s*(m|ft|')?/i); if(!m) return '';
  const v=+m[1]*(m[2] && m[2].toLowerCase()!=='m' ? .3048 : 1); return isFinite(v) ? Math.round(v*10)/10 : '';
}
function gdTowerRadio(t){
  const r=[]; for(const [k,n] of [['gsm','GSM'],['umts','UMTS'],['lte','LTE'],['5g','5G'],['nr','5G']]) if(t['communication:'+k]==='yes' && !r.includes(n)) r.push(n);
  if(t['communication:mobile_phone']==='yes' && !r.length) r.push('cell');
  if(t['communication:radio']==='yes' || t['communication:fm']==='yes') r.push('FM');
  if(t['communication:television']==='yes' || t['communication:dvb']==='yes') r.push('TV');
  return r.join(',');
}
// ответ Overpass → строки списка kind
function gdParseOverpass(kind,json){
  const out=[], seen=new Set();
  for(const el of (json?.elements||[])){
    const c=el.center||el, t=el.tags||{};
    if(c.lat==null || c.lon==null) continue;
    const id='osm:'+el.type[0]+el.id; if(seen.has(id)) continue; seen.add(id);
    const name=t.name||t['name:en']||t.ref||'', ele=gdNum(t.ele);
    if(kind==='peaks'){ out.push({id,name,lat:c.lat,lon:c.lon,ele:ele ?? '',src:'osm'}); continue; }
    if(kind==='repeaters'){
      out.push({id,name,operator:t.operator||'',freq:t['repeater:output']||t.frequency||t['communication:amateur_radio:freq']||'',tone:t.ctcss||t['repeater:tone']||'',
        mode:t.mode||'',lat:c.lat,lon:c.lon,h:gdHeight(t.height),ele:ele ?? '',icon:'antenna',src:'osm'}); continue;
    }
    const radio=gdTowerRadio(t), cell=/gsm|umts|lte|5g|cell|mobile|base/.test(radio.toLowerCase()) || t.telecom;
    out.push({id,name:name||t.operator||'',operator:t.operator||t.brand||'',kind:cell ? 'cell' : t['man_made']||'mast',radio,ref:t.ref||'',
      lat:+(+c.lat).toFixed(6),lon:+(+c.lon).toFixed(6),h:gdHeight(t.height),ele:ele ?? '',icon:'tx',src:'osm'});
  }
  return out;
}

// любой ответ Overpass (свой запрос) → строки: id, name, lat, lon + теги (до 24 самых частых)
function gdParseGeneric(json){
  const els=[], cnt=new Map();
  for(const el of (json?.elements||[])){
    const c=el.center||el; if(c.lat==null || c.lon==null) continue;
    const t=el.tags||{}; els.push({el,c,t});
    for(const k in t) cnt.set(k,(cnt.get(k)||0)+1);
  }
  const tags=[...cnt.entries()].sort((a,b)=>b[1]-a[1]).map(e=>e[0]).filter(k=>!['name','id','lat','lon'].includes(k)).slice(0,24);
  const cols=['id','name','lat','lon',...tags,'src'], seen=new Set(), rows=[];
  for(const {el,c,t} of els){
    const id='osm:'+el.type[0]+el.id; if(seen.has(id)) continue; seen.add(id);
    const r={id,name:t.name||t['name:en']||'',lat:+(+c.lat).toFixed(6),lon:+(+c.lon).toFixed(6)};
    for(const k of tags) r[k]=t[k] ?? '';
    r.src='osm'; rows.push(r);
  }
  return {cols,rows};
}

/* ---------- OpenCelliD ---------- */
// getInArea (нужен ключ): BBOX = latmin,lonmin,latmax,lonmax; ответ {count, cells:[…]}
function gdCellUrl(key,bbox,limit,offset){
  return 'https://opencellid.org/cell/getInArea?key='+encodeURIComponent(key)+'&BBOX='+[bbox[0],bbox[1],bbox[2],bbox[3]].map(v=>+v.toFixed(5)).join(',')+
    '&format=json&limit='+(limit||200)+(offset ? '&offset='+offset : '');
}
const GD_CELL_RADIO={GSM:'GSM',UMTS:'UMTS',LTE:'LTE',NR:'5G',CDMA:'CDMA'};
// запись OpenCelliD: {radio,mcc,net,area,cell,lon,lat,range,samples,updated} → строка списка
function gdCellRow(c){
  const lat=gdNum(c.lat), lon=gdNum(c.lon); if(lat==null || lon==null) return null;
  const radio=GD_CELL_RADIO[String(c.radio||'').toUpperCase()]||String(c.radio||''), range=gdNum(c.range);
  const upd=gdNum(c.updated);
  const id=['cell',c.mcc,c.net ?? c.mnc,c.area ?? c.lac,c.cell ?? c.cid].join(':');
  return {id,name:radio+' '+[c.mcc,c.net ?? c.mnc,c.area ?? c.lac,c.cell ?? c.cid].join('-'),operator:'',kind:'cell',radio,ref:'',lat,lon,h:'',ele:'',
    mcc:c.mcc ?? '',mnc:c.net ?? c.mnc ?? '',lac:c.area ?? c.lac ?? '',cid:c.cell ?? c.cid ?? '',range:range ?? '',samples:gdNum(c.samples) ?? '',
    updated:upd!=null ? new Date(upd*1000).toISOString().slice(0,10) : '',icon:'tx',radius:range!=null && range>0 && range<50000 ? range : '',src:'opencellid'};
}
// строка дампа cell_towers.csv: radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,created,updated,averageSignal
function gdCellFromCsv(f){
  if(f.length<9) return null;
  return gdCellRow({radio:f[0],mcc:f[1],net:f[2],area:f[3],cell:f[4],lon:f[6],lat:f[7],range:f[8],samples:f[9],updated:f[12]});
}
// фильтр дампа: рамка и/или MCC; возвращает функцию строка → строка списка | null
function gdCellFilter(o){
  const b=o.bbox, mcc=o.mcc ? String(o.mcc).trim() : '';
  return line=>{
    if(!line || line.startsWith('radio,')) return null;
    const f=line.split(',');
    if(mcc && f[1]!==mcc) return null;
    if(b){ const la=+f[7], lo=+f[6]; if(!(la>=b[0] && la<=b[2] && lo>=b[1] && lo<=b[3])) return null; }
    return gdCellFromCsv(f);
  };
}

/* ---------- векторные слои: GeoJSON / KML / GPX ---------- */
// → {name, feats:[{g:'Point'|'Line'|'Poly', c, p}]}; Point c=[lon,lat], Line c=[[lon,lat]…], Poly c=[ring…]
function gdGeomAdd(out,geom,props){
  if(!geom) return;
  const t=geom.type, c=geom.coordinates;
  const pos=a=>Array.isArray(a) && isFinite(a[0]) && isFinite(a[1]);
  if(t==='Point'){ if(pos(c)) out.push({g:'Point',c:[+c[0],+c[1],gdNum(c[2])],p:props}); }
  else if(t==='MultiPoint') for(const q of c||[]) gdGeomAdd(out,{type:'Point',coordinates:q},props);
  else if(t==='LineString'){ const l=(c||[]).filter(pos); if(l.length>1) out.push({g:'Line',c:l,p:props}); }
  else if(t==='MultiLineString') for(const q of c||[]) gdGeomAdd(out,{type:'LineString',coordinates:q},props);
  else if(t==='Polygon'){ const r=(c||[]).map(x=>x.filter(pos)).filter(x=>x.length>2); if(r.length) out.push({g:'Poly',c:r,p:props}); }
  else if(t==='MultiPolygon') for(const q of c||[]) gdGeomAdd(out,{type:'Polygon',coordinates:q},props);
  else if(t==='GeometryCollection') for(const q of geom.geometries||[]) gdGeomAdd(out,q,props);
}
function gdParseGeoJson(text){
  const o=JSON.parse(text), feats=[];
  const one=f=>{ if(!f) return; if(f.type==='Feature') gdGeomAdd(feats,f.geometry,f.properties||{}); else gdGeomAdd(feats,f,{}); };
  if(o.type==='FeatureCollection') (o.features||[]).forEach(one); else one(o);
  return feats;
}
const gdXmlText=s=>String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&').trim();
const gdKmlCoords=s=>String(s).trim().split(/\s+/).map(q=>q.split(',').map(Number)).filter(a=>isFinite(a[0]) && isFinite(a[1]));
function gdParseKml(text){
  const feats=[];
  for(const m of text.matchAll(/<Placemark\b[\s\S]*?<\/Placemark>/gi)){
    const b=m[0], nm=b.match(/<name>([\s\S]*?)<\/name>/i), ds=b.match(/<description>([\s\S]*?)<\/description>/i);
    const p={}; if(nm) p.name=gdXmlText(nm[1]); if(ds) p.description=gdXmlText(ds[1]);
    for(const d of b.matchAll(/<Data name="([^"]*)">\s*<value>([\s\S]*?)<\/value>/gi)) p[d[1]]=gdXmlText(d[2]);
    for(const g of b.matchAll(/<Polygon\b[\s\S]*?<\/Polygon>/gi)){
      const rings=[...g[0].matchAll(/<LinearRing>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/gi)].map(r=>gdKmlCoords(r[1]));
      if(rings.length) gdGeomAdd(feats,{type:'Polygon',coordinates:rings},p);
    }
    const rest=b.replace(/<Polygon\b[\s\S]*?<\/Polygon>/gi,'');
    for(const g of rest.matchAll(/<LineString\b[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/gi)) gdGeomAdd(feats,{type:'LineString',coordinates:gdKmlCoords(g[1])},p);
    for(const g of rest.matchAll(/<Point\b[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/gi)){ const c=gdKmlCoords(g[1])[0]; if(c) gdGeomAdd(feats,{type:'Point',coordinates:c},p); }
  }
  return feats;
}
function gdParseGpx(text){
  const feats=[], pt=a=>{ const la=a.match(/lat="([^"]+)"/), lo=a.match(/lon="([^"]+)"/); return la && lo ? [+lo[1],+la[1]] : null; };
  for(const m of text.matchAll(/<wpt\b([^>]*)>([\s\S]*?)<\/wpt>/gi)){
    const c=pt(m[1]), nm=m[2].match(/<name>([\s\S]*?)<\/name>/i), el=m[2].match(/<ele>([\s\S]*?)<\/ele>/i);
    if(c) gdGeomAdd(feats,{type:'Point',coordinates:el ? [...c,+el[1]] : c},nm ? {name:gdXmlText(nm[1])} : {});
  }
  for(const m of text.matchAll(/<(trk|rte)\b[\s\S]*?<\/\1>/gi)){
    const nm=m[0].match(/<name>([\s\S]*?)<\/name>/i), p=nm ? {name:gdXmlText(nm[1])} : {};
    const segs=m[1]==='trk' ? [...m[0].matchAll(/<trkseg>[\s\S]*?<\/trkseg>/gi)].map(s=>s[0]) : [m[0]];
    for(const s of segs){
      const l=[...s.matchAll(/<(?:trkpt|rtept)\b([^>]*)>/gi)].map(q=>pt(q[1])).filter(Boolean);
      gdGeomAdd(feats,{type:'LineString',coordinates:l},p);
    }
  }
  return feats;
}
function gdParseVector(text,name){
  const t=String(text).replace(/^﻿/,''), head=t.trimStart();
  let feats;
  if(head[0]==='{' || head[0]==='[') feats=gdParseGeoJson(t);
  else if(/<kml\b|<Placemark\b/i.test(t)) feats=gdParseKml(t);
  else if(/<gpx\b/i.test(t)) feats=gdParseGpx(t);
  else throw new Error('unknown format: GeoJSON, KML or GPX expected');
  if(!feats.length) throw new Error('no features in the file');
  return {name:name||'layer', feats};
}
// простые стили GeoJSON (simplestyle): stroke, fill; иначе цвет слоя
const GD_PALETTE=['#e0b23c','#4ec9b0','#e06c75','#61afef','#c678dd','#98c379','#d19a66'];
// → {lines:[{xy,bb,col}], polys:[{rings:[{xy,bb}],col}], points:[rec], nv}; xy — Меркатор в долях мира
function gdVecPrep(layer,idx,maxV){
  const col=GD_PALETTE[(idx||0)%GD_PALETTE.length], out={lines:[],polys:[],points:[],nv:0}, cap=maxV||2e6;
  const path=pts=>{
    const xy=new Float64Array(pts.length*2); let x0=1,y0=1,x1=0,y1=0;
    pts.forEach((q,i)=>{ const x=gdMx(q[0]), y=gdMy(q[1]); xy[2*i]=x; xy[2*i+1]=y; if(x<x0) x0=x; if(x>x1) x1=x; if(y<y0) y0=y; if(y>y1) y1=y; });
    return {xy,bb:[x0,y0,x1,y1],mz:0};
  };
  let k=0;
  for(const f of layer.feats){
    const p=f.p||{}, c=String(p.stroke||p.color||col);
    if(f.g==='Point'){
      const r={id:'v:'+layer.name+':'+(k++),lat:f.c[1],lon:f.c[0],track:0,color:String(p['marker-color']||p.color||col),layer:layer.name};
      if(f.c[2]!=null) r.alt=f.c[2];
      for(const key in p) if(p[key]!=null && typeof p[key]!=='object' && !(key in r) && key!=='marker-color') r[key]=p[key];
      r.label=p.name ?? p.title ?? p.label ?? '';
      out.points.push(r); continue;
    }
    if(f.g==='Line'){ if(out.nv+f.c.length>cap) break; out.nv+=f.c.length; out.lines.push({...path(f.c),col:c}); }
    else {
      const rings=[];
      for(const ring of f.c){ if(out.nv+ring.length>cap) break; out.nv+=ring.length; rings.push(path(ring)); }
      if(rings.length) out.polys.push({rings,col:String(p.fill||p.stroke||col),fillAlpha:gdNum(p['fill-opacity'])});
    }
  }
  return out;
}
