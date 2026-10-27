"use strict";
/* ============================ Геозоны: расчёт ============================
   Зоны — круги и многоугольники; положение → расстояние до границы со знаком (метры, внутри — отрицательное), события входа / выхода
   с гистерезисом, задержкой и отсевом неточных замеров. Без DOM — проверяется в tools/test-geofence.mjs. */

const GF_R=6371008.8, GF_D2R=Math.PI/180;
function gfDist(lat1,lon1,lat2,lon2){                                      // м, гаверсинус
  const dp=(lat2-lat1)*GF_D2R, dl=(lon2-lon1)*GF_D2R;
  const a=Math.sin(dp/2)**2+Math.cos(lat1*GF_D2R)*Math.cos(lat2*GF_D2R)*Math.sin(dl/2)**2;
  return 2*GF_R*Math.asin(Math.min(1,Math.sqrt(a)));
}
// «имя: circle lat lon радиус_м», «имя: poly lat,lon lat,lon …»; строки с # — комментарии; можно JSON-массив зон
function gfParseZones(text){
  const zones=[], errors=[];
  const t=String(text||'').trim();
  if(!t) return {zones,errors};
  if(t[0]==='['){
    try{ for(const z of JSON.parse(t)){ const q=gfZoneFromRec(z); if(q) zones.push(q); else errors.push('bad zone '+JSON.stringify(z).slice(0,40)); } }
    catch(e){ errors.push('JSON: '+e.message); }
    return {zones,errors};
  }
  t.split(/\n|;/).forEach((line,i)=>{
    line=line.replace(/#.*/,'').trim(); if(!line) return;
    const m=/^(?:([^:]+?)\s*:\s*)?(circle|poly(?:gon)?)\s+(.+)$/i.exec(line);
    if(!m){ errors.push('line '+(i+1)+': name: circle lat lon radius  |  name: poly lat,lon lat,lon …'); return; }
    const name=(m[1]||('zone'+(zones.length+1))).trim(), nums=m[3].match(/-?\d+(?:\.\d+)?/g)?.map(Number)||[];
    if(/^circle$/i.test(m[2])){
      if(nums.length<3 || Math.abs(nums[0])>90 || Math.abs(nums[1])>180 || !(nums[2]>0)){ errors.push('line '+(i+1)+': circle needs lat lon radius_m'); return; }
      zones.push({name,type:'circle',lat:nums[0],lon:nums[1],r:nums[2]});
    } else {
      if(nums.length<6 || nums.length%2){ errors.push('line '+(i+1)+': polygon needs at least 3 points'); return; }
      const g=[]; for(let k=0;k<nums.length;k+=2) g.push([nums[k],nums[k+1]]);
      if(g.some(p=>Math.abs(p[0])>90||Math.abs(p[1])>180)){ errors.push('line '+(i+1)+': coordinate out of range'); return; }
      zones.push({name,type:'polygon',geom:g});
    }
  });
  return {zones,errors};
}
// запись карты (Map → edit: {name, gtype: circle|polygon, lat, lon, radius, geom}) или своя {type, r, geom} → зона
function gfZoneFromRec(r){
  if(!r || typeof r!=='object') return null;
  const name=String(r.name ?? r.label ?? r.id ?? '').trim(); if(!name) return null;
  const type=String(r.gtype ?? r.type ?? '').toLowerCase();
  if(type==='circle'){
    const lat=+r.lat, lon=+r.lon, rad=+(r.radius ?? r.r);
    return isFinite(lat) && isFinite(lon) && rad>0 ? {name,type:'circle',lat,lon,r:rad,...(r.color ? {color:r.color} : {})} : null;
  }
  if(type==='polygon' || type==='poly'){
    let g=r.geom; if(typeof g==='string'){ try{ g=JSON.parse(g); }catch(e){ return null; } }
    return Array.isArray(g) && g.length>2 && g.every(p=>Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])) ? {name,type:'polygon',geom:g.map(p=>[+p[0],+p[1]]),...(r.color ? {color:r.color} : {})} : null;
  }
  return null;
}
// расстояние до границы со знаком: < 0 — внутри
function gfSigned(z,lat,lon){
  if(z.type==='circle') return gfDist(lat,lon,z.lat,z.lon)-z.r;
  const kx=Math.cos(lat*GF_D2R)*111320, ky=110574;                       // локальная плоскость вокруг точки, м
  const P=z.geom.map(p=>[(p[1]-lon)*kx,(p[0]-lat)*ky]);
  let inside=false, best=Infinity;
  for(let i=0,j=P.length-1;i<P.length;j=i++){
    const [x1,y1]=P[i], [x2,y2]=P[j];
    if((y1>0)!==(y2>0) && 0<(x2-x1)*(0-y1)/(y2-y1)+x1) inside=!inside;
    const dx=x2-x1, dy=y2-y1, l2=dx*dx+dy*dy;
    const t=l2 ? Math.max(0,Math.min(1,-(x1*dx+y1*dy)/l2)) : 0;
    best=Math.min(best,Math.hypot(x1+t*dx,y1+t*dy));
  }
  return inside ? -best : best;
}
function gfCenter(z){
  if(z.type==='circle') return [z.lat,z.lon];
  return [z.geom.reduce((a,p)=>a+p[0],0)/z.geom.length, z.geom.reduce((a,p)=>a+p[1],0)/z.geom.length];
}
/**
 * Один замер → события. st — состояние (хранится в узле): {z: Map имя → {in, cand, since}}.
 * o: {hyst (м), dwell (с), accMax (м, 0 — не проверять), acc, first (событие при первом замере: enter для зон, где уже внутри)}.
 * → {events:[{zone, ev:'enter'|'exit', dist}], dist (до ближайшей границы, со знаком), nearest, inside:[имена]}
 */
function gfStep(st,zones,lat,lon,t,o={}){
  const res={events:[],dist:null,nearest:null,inside:[]};
  if(!isFinite(lat) || !isFinite(lon)) return res;
  if(o.accMax>0 && o.acc>o.accMax) return {...res,skipped:true};
  if(!st.z) st.z=new Map();
  const names=new Set(zones.map(z=>z.name));
  for(const k of st.z.keys()) if(!names.has(k)) st.z.delete(k);
  const hy=+o.hyst||0, dwell=(+o.dwell||0)*1000;
  for(const z of zones){
    const d=gfSigned(z,lat,lon);
    if(res.dist===null || Math.abs(d)<Math.abs(res.dist)){ res.dist=d; res.nearest=z.name; }
    let s=st.z.get(z.name);
    if(!s){ s={in:d<0,cand:null,since:0,init:true}; st.z.set(z.name,s); if(o.first && s.in) res.events.push({zone:z.name,ev:'enter',dist:d}); }
    else {
      const want= s.in ? !(d>hy) : d<-hy;                                      // куда хочет перейти состояние с учётом гистерезиса
      if(want===s.in){ s.cand=null; }
      else {
        if(s.cand!==want){ s.cand=want; s.since=t; }
        if(t-s.since>=dwell){ s.in=want; s.cand=null; res.events.push({zone:z.name,ev:want ? 'enter' : 'exit',dist:d}); }
      }
    }
    if(s.in) res.inside.push(z.name);
  }
  return res;
}
// зоны → записи для Map: круг — gtype circle + radius, многоугольник — gtype polygon + geom; цвет по состоянию
function gfShapes(zones,insideNames,colors={}){
  const inn=new Set(insideNames||[]);
  return zones.map(z=>{
    const c=gfCenter(z), col=z.color || (inn.has(z.name) ? (colors.in||'#ff4040') : (colors.out||'#ffb400'));
    const base={id:'gf:'+z.name,name:z.name,label:z.name+(inn.has(z.name) ? ' ●' : ''),icon:'dot',size:3,color:col,track:0,lat:+c[0].toFixed(6),lon:+c[1].toFixed(6)};
    return z.type==='circle' ? {...base,gtype:'circle',radius:z.r} : {...base,gtype:'polygon',geom:JSON.stringify(z.geom)};
  });
}

if(typeof module!=='undefined') module.exports={gfParseZones,gfZoneFromRec,gfSigned,gfStep,gfShapes,gfDist};
