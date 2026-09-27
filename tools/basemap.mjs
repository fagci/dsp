// Сборка офлайн-подложки карты из Natural Earth 10m (public domain) в data/basemap.json.
// Запуск: node tools/basemap.mjs [каталог-кэша исходников]
// Исходники берутся с raw.githubusercontent.com (nvkelso/natural-earth-vector), если их нет в кэше.
// Формат: координаты квантуются до 1/Q градуса, линия — плоский массив [x0,y0,dx1,dy1,...].
import fs from 'node:fs';
import path from 'node:path';

const SRC='https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
const dir=process.argv[2]||'.ne-cache';
const OUT=path.join(path.dirname(new URL(import.meta.url).pathname),'..','data','basemap.json');
const Q=1000;

async function load(name){
  const f=path.join(dir,name+'.geojson');
  if(!fs.existsSync(f)){
    fs.mkdirSync(dir,{recursive:true});
    console.log('download',name);
    const r=await fetch(SRC+name+'.geojson'); if(!r.ok) throw new Error(name+': '+r.status);
    fs.writeFileSync(f,Buffer.from(await r.arrayBuffer()));
  }
  return JSON.parse(fs.readFileSync(f,'utf8')).features;
}

// Дуглас-Пекер, итеративно (глубокая рекурсия на длинных береговых линиях)
function simplify(pts,tol){
  if(pts.length<3) return pts;
  const keep=new Uint8Array(pts.length); keep[0]=keep[pts.length-1]=1;
  const st=[[0,pts.length-1]], t2=tol*tol;
  while(st.length){
    const [a,b]=st.pop(); const [ax,ay]=pts[a],[bx,by]=pts[b];
    const dx=bx-ax, dy=by-ay, L=dx*dx+dy*dy;
    let mi=-1, md=t2;
    for(let i=a+1;i<b;i++){
      const [px,py]=pts[i];
      let d;
      if(L===0) d=(px-ax)**2+(py-ay)**2;
      else { const t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/L));
        d=(px-ax-t*dx)**2+(py-ay-t*dy)**2; }
      if(d>md){ md=d; mi=i; }
    }
    if(mi>=0){ keep[mi]=1; st.push([a,mi],[mi,b]); }
  }
  return pts.filter((_,i)=>keep[i]);
}
function enc(pts){
  const o=[]; let px=0,py=0;
  for(const [x,y] of pts){ const qx=Math.round(x*Q), qy=Math.round(y*Q);
    if(o.length && qx===px && qy===py) continue;
    o.push(qx-px,qy-py); px=qx; py=qy; }
  return o;
}
function lines(geom){                                   // все линии/кольца геометрии
  if(!geom) return [];
  const c=geom.coordinates;
  switch(geom.type){
    case 'LineString': return [c];
    case 'MultiLineString': return c;
    case 'Polygon': return c;
    case 'MultiPolygon': return c.flat();
  }
  return [];
}
function layer(feats,tol,{mz=()=>0,filter=()=>true,minPts=2}={}){
  const L={mz:[],p:[]};
  for(const f of feats){
    if(!filter(f.properties)) continue;
    const z=Math.max(0,Math.round(mz(f.properties)||0));
    for(const ln of lines(f.geometry)){
      const e=enc(simplify(ln,tol));
      if(e.length/2<minPts) continue;
      L.mz.push(z); L.p.push(e);
    }
  }
  return L;
}
const r3=v=>Math.round(v*Q)/Q;

const land=await load('ne_10m_land');
const lakes=await load('ne_10m_lakes');
const rivers=await load('ne_10m_rivers_lake_centerlines');
const adm0=await load('ne_10m_admin_0_boundary_lines_land');
const adm1=await load('ne_10m_admin_1_states_provinces_lines');
const adm1poly=await load('ne_10m_admin_1_states_provinces');
const countries=await load('ne_50m_admin_0_countries');
const places=await load('ne_10m_populated_places');

const out={
  v:1, q:Q,
  src:'Natural Earth 10m (public domain), naturalearthdata.com',
  land:layer(land,0.01,{minPts:3}),
  lakes:layer(lakes,0.01,{mz:p=>p.min_zoom,minPts:3}),
  rivers:layer(rivers,0.01,{mz:p=>p.min_zoom}),
  adm0:layer(adm0,0.005),
  adm1:layer(adm1,0.01,{mz:p=>p.MIN_ZOOM}),
  // подписи: [lon,lat,name,minZoom], у стран ещё ISO3 и ISO2
  countryLabels:countries.map(f=>{ const p=f.properties;
    return [r3(p.LABEL_X),r3(p.LABEL_Y),p.NAME_EN||p.NAME,Math.round(p.MIN_LABEL||2),p.ADM0_A3,p.ISO_A2_EH||p.ISO_A2]; }),
  adm1Labels:adm1poly.filter(f=>f.properties.latitude!=null).map(f=>{ const p=f.properties;
    return [r3(p.longitude),r3(p.latitude),p.name_en||p.name,Math.round(p.min_label||6)]; }),
  // [lon,lat,name,minZoom,pop,kind] kind: 2 — столица страны, 1 — центр региона, 0 — прочие
  places:places.map(f=>{ const p=f.properties;
    const kind=p.ADM0CAP?2:(/Admin-1 capital/.test(p.FEATURECLA)?1:0);
    return [r3(p.LONGITUDE),r3(p.LATITUDE),p.NAME_EN||p.NAME,Math.round(p.MIN_ZOOM||6),p.POP_MAX|0,kind]; }),
};
fs.mkdirSync(path.dirname(OUT),{recursive:true});
fs.writeFileSync(OUT,JSON.stringify(out));
const cnt=k=>out[k].p.reduce((s,a)=>s+a.length/2,0);
console.log('written',OUT,(fs.statSync(OUT).size/1e6).toFixed(2)+' MB',
  Object.fromEntries(['land','lakes','rivers','adm0','adm1'].map(k=>[k,cnt(k)])));
