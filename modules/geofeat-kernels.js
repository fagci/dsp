"use strict";
/* ============================ Ядро Geo Features ============================
   Аэродромы, взлётные полосы и населённые пункты из OSM Overpass: ячейки 0.5°, разбор ответа, ближайшая полоса.
   Без DOM — проверяется tools/test-geofeat.mjs. */

const GF_CELL=.5, GF_D=Math.PI/180;
const GF_PLACE_RANK={city:0,town:1,village:2};

const gfKey=(kind,ix,iy)=>'gf:'+kind+':'+ix+':'+iy;
// ячейки, которых касается квадрат со стороной 2·rKm вокруг точки
function gfCells(lat,lon,rKm){
  const dLat=rKm/111.19, dLon=Math.min(180,dLat/Math.max(.05,Math.cos(lat*GF_D))), out=[];
  const x0=Math.floor((lon-dLon)/GF_CELL), x1=Math.floor((lon+dLon)/GF_CELL),
        y0=Math.floor(Math.max(-85,lat-dLat)/GF_CELL), y1=Math.floor(Math.min(85,lat+dLat)/GF_CELL);
  for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++) out.push([x,y]);
  return out;
}
function gfQuery(kind,ix,iy){
  const s=iy*GF_CELL, w=ix*GF_CELL, bb='('+[s,w,s+GF_CELL,w+GF_CELL].join(',')+')';
  if(kind==='air') return '[out:json][timeout:60];nwr["aeroway"~"^(aerodrome|helipad)$"]'+bb+';out center;way["aeroway"="runway"]'+bb+';out geom;';
  return '[out:json][timeout:60];node["place"~"^(city|town|village)$"]["name"]'+bb+';out;';
}
// ответ → компактные данные ячейки: air {ap, rw}, pop {pl}
function gfParse(kind,json){
  const els=json?.elements||[];
  if(kind==='pop'){
    const pl=[];
    for(const el of els){
      const t=el.tags||{};
      if(el.type==='node' && el.lat!=null && t.place in GF_PLACE_RANK && t.name)
        pl.push({id:'n'+el.id, lat:el.lat, lon:el.lon, name:t.name, kind:t.place, pop:parseInt(t.population)||0});
    }
    return {pl};
  }
  const ap=[], rw=[];
  for(const el of els){
    const t=el.tags||{}, id=el.type[0]+el.id;
    if(t.aeroway==='runway'){
      const g=(el.geometry||[]).filter(q=>q && q.lat!=null);
      if(g.length<2) continue;
      const first=g[0], last=g[g.length-1];
      if(first.lat===last.lat && first.lon===last.lon) continue;           // замкнутый контур — площадь, не полоса
      rw.push({id, pts:[[first.lat,first.lon],[last.lat,last.lon]], ref:t.ref||'', width:parseFloat(t.width)||0, surface:t.surface||''});
    } else if((t.aeroway==='aerodrome' || t.aeroway==='helipad') && !t.disused){
      const c=el.center||el; if(c.lat==null) continue;
      ap.push({id, lat:c.lat, lon:c.lon, name:t.name||t['name:en']||'', icao:t.icao||'', iata:t.iata||'', ele:parseFloat(t.ele),
        kind:t.aeroway==='helipad' ? 'heli' : 'aerodrome'});
    }
  }
  return {ap, rw};
}
// несколько ячеек одного вида → один набор без дублей (полоса на стыке ячеек приходит дважды)
function gfMerge(kind,cells){
  const keys=kind==='pop' ? ['pl'] : ['ap','rw'], out={};
  for(const k of keys){
    const seen=new Set(); out[k]=[];
    for(const c of cells) for(const it of (c?.[k]||[])) if(!seen.has(it.id)){ seen.add(it.id); out[k].push(it); }
  }
  return out;
}
function gfDistKm(la1,lo1,la2,lo2){
  const dy=(la2-la1)*111.19, dx=(lo2-lo1)*111.19*Math.cos((la1+la2)/2*GF_D);
  return Math.hypot(dx,dy);
}
function gfBearing(la1,lo1,la2,lo2){
  const dy=la2-la1, dx=(lo2-lo1)*Math.cos((la1+la2)/2*GF_D);
  return ((Math.atan2(dx,dy)/GF_D)%360+360)%360;
}
// ближайшая к точке полоса (по середине) в пределах maxKm: начало, курс вдоль полосы, длина (м), имя аэродрома рядом
function gfNearestRunway(data,lat,lon,maxKm){
  let best=null, bd=maxKm;
  for(const r of (data?.rw||[])){
    const a=r.pts[0], b=r.pts[r.pts.length-1], d=gfDistKm(lat,lon,(a[0]+b[0])/2,(a[1]+b[1])/2);
    if(d<bd){ bd=d; best=r; }
  }
  if(!best) return null;
  const a=best.pts[0], b=best.pts[best.pts.length-1], mid=[(a[0]+b[0])/2,(a[1]+b[1])/2];
  let ap=null, ad=5;
  for(const q of (data.ap||[])){ const d=gfDistKm(mid[0],mid[1],q.lat,q.lon); if(d<ad){ ad=d; ap=q; } }
  return {lat:a[0], lon:a[1], hdg:gfBearing(a[0],a[1],b[0],b[1]), len:gfDistKm(a[0],a[1],b[0],b[1])*1000, ref:best.ref,
    name:ap ? (ap.name||ap.icao) : '', distKm:bd};
}
