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
// Overpass при перегрузке отвечает 200 и пустым elements, а причину кладёт в remark — это не пустая ячейка
function gfRemarkError(json){
  const r=json && typeof json.remark==='string' ? json.remark : '';
  return /runtime error|timeout|too busy|out of memory|rate.?limit|try again/i.test(r) ? r.replace(/^Error:\s*/,'').slice(0,120) : '';
}
const gfEmpty=d=>!d || !((d.ap&&d.ap.length)||(d.rw&&d.rw.length)||(d.pl&&d.pl.length));
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

// ---------- OurAirports (статические CSV, не зависят от Overpass) ----------
// rows: массивы строк CSV с заголовком в первой. Результат компактный: ap [ident,lat,lon,name,icao,iata,ele_m,kind,size], rw [lat1,lon1,lat2,lon2,ref,width_m,surface,ident]
const GF_OA_TYPES={large_airport:0, medium_airport:1, small_airport:2, heliport:3};
function gfCsvCols(rows){
  const h=(rows[0]||[]).map(s=>String(s).trim().toLowerCase());
  return k=>h.indexOf(k);
}
function gfOaParse(apRows,rwRows){
  const A=gfCsvCols(apRows), ap=[], pos=new Map();
  const iId=A('ident'), iT=A('type'), iN=A('name'), iLa=A('latitude_deg'), iLo=A('longitude_deg'), iE=A('elevation_ft'), iIata=A('iata_code'), iGps=A('gps_code');
  for(let r=1;r<apRows.length;r++){
    const x=apRows[r], size=GF_OA_TYPES[x[iT]]; if(size===undefined) continue;
    const lat=parseFloat(x[iLa]), lon=parseFloat(x[iLo]); if(!isFinite(lat) || !isFinite(lon)) continue;
    const ident=x[iId], icao=/^[A-Z]{4}$/.test(x[iGps]||'') ? x[iGps] : /^[A-Z]{4}$/.test(ident) ? ident : '', ele=parseFloat(x[iE]);
    ap.push([ident,lat,lon,x[iN]||'',icao,x[iIata]||'',isFinite(ele) ? Math.round(ele*.3048) : null,size===3 ? 'heli' : 'aerodrome',size]);
    pos.set(ident,[lat,lon]);
  }
  const B=gfCsvCols(rwRows), rw=[];
  const jA=B('airport_ident'), jL=B('length_ft'), jW=B('width_ft'), jS=B('surface'), jC=B('closed'),
        jle=B('le_ident'), jla1=B('le_latitude_deg'), jlo1=B('le_longitude_deg'), jh1=B('le_heading_degt'),
        jhe=B('he_ident'), jla2=B('he_latitude_deg'), jlo2=B('he_longitude_deg'), jh2=B('he_heading_degt');
  for(let r=1;r<rwRows.length;r++){
    const x=rwRows[r]; if(x[jC]==='1' || !pos.has(x[jA])) continue;
    let la1=parseFloat(x[jla1]), lo1=parseFloat(x[jlo1]), la2=parseFloat(x[jla2]), lo2=parseFloat(x[jlo2]);
    if(![la1,lo1,la2,lo2].every(isFinite)){                       // концов нет — от точки аэродрома по курсу и длине
      const len=parseFloat(x[jL])*.3048; if(!(len>100)) continue;
      let hd=parseFloat(x[jh1]); if(!isFinite(hd)){ const h2=parseFloat(x[jh2]); hd=isFinite(h2) ? h2+180 : (parseInt(x[jle])||NaN)*10; }
      if(!isFinite(hd)) continue;
      const c=pos.get(x[jA]), dN=Math.cos(hd*GF_D)*len/2, dE=Math.sin(hd*GF_D)*len/2, kLat=1/111320, kLon=1/(111320*Math.cos(c[0]*GF_D));
      la1=c[0]-dN*kLat; lo1=c[1]-dE*kLon; la2=c[0]+dN*kLat; lo2=c[1]+dE*kLon;
    }
    const w=parseFloat(x[jW]);
    rw.push([la1,lo1,la2,lo2,[x[jle],x[jhe]].filter(Boolean).join('/'),isFinite(w) ? Math.round(w*.3048) : 0,x[jS]||'',x[jA]]);
  }
  return {ap,rw};
}
// компактные данные → индекс по ячейкам 0.5°
function gfOaIndex(db){
  const m=new Map(), cell=(la,lo)=>Math.floor(lo/GF_CELL)+':'+Math.floor(la/GF_CELL);
  const get=k=>{ let c=m.get(k); if(!c) m.set(k,c={ap:[],rw:[]}); return c; };
  for(const a of db.ap) get(cell(a[1],a[2])).ap.push(a);
  for(const r of db.rw){ const k1=cell(r[0],r[1]), k2=cell(r[2],r[3]); get(k1).rw.push(r); if(k2!==k1) get(k2).rw.push(r); }
  return m;
}
// ячейка индекса → данные в том же виде, что gfParse('air')
function gfOaCell(idx,ix,iy){
  const c=idx.get(ix+':'+iy);
  if(!c) return {ap:[],rw:[]};
  return {
    ap:c.ap.map(a=>({id:'a'+a[0], lat:a[1], lon:a[2], name:a[3], icao:a[4], iata:a[5], ele:a[6]===null ? NaN : a[6], kind:a[7]})),
    rw:c.rw.map(r=>({id:'r'+r[7]+':'+r[4], pts:[[r[0],r[1]],[r[2],r[3]]], ref:r[4], width:r[5], surface:r[6]})),
  };
}

// ---------- встроенный список населённых пунктов ----------
const gfPopKind=pop=>pop>=200000 ? 'city' : pop>=20000 ? 'town' : 'village';
// к пунктам OSM добавить пункты из встроенного списка, которых в OSM-данных нет (то же имя ближе 3 км — дубль)
function gfMergePlaces(osm,local){
  const out=osm.slice();
  for(const q of local){
    if(osm.some(o=>o.name===q.name && gfDistKm(o.lat,o.lon,q.lat,q.lon)<3)) continue;
    out.push(q);
  }
  return out;
}
