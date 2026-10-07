"use strict";
/* ============================ Ядро Video Overlay ============================
   Солнце и Луна (низкоточные ряды по Meeus), видимость точки по рельефу (кольца вокруг наблюдателя),
   разбор ответа OSM Overpass, буфер позы для сдвига по времени. Без DOM — проверяется tools/test-overlay.mjs. */

const OVK_D=Math.PI/180;
const OVK_RING0=250, OVK_RING_K=1.08;                 // кольца рельефа: 250 м, дальше ×1.08

const ovkNorm=a=>((a%360)+360)%360;
const ovkWrap=a=>((a+540)%360+360)%360-180;           // −180…180
const ovkJd=ms=>ms/86400000+2440587.5;

function ovkEclToEq(lonD,latD,T){
  const e=(23.439291-0.0130042*T)*OVK_D, l=lonD*OVK_D, b=latD*OVK_D;
  const ra=Math.atan2(Math.sin(l)*Math.cos(e)-Math.tan(b)*Math.sin(e), Math.cos(l));
  const dec=Math.asin(Math.sin(b)*Math.cos(e)+Math.cos(b)*Math.sin(e)*Math.sin(l));
  return {ra:ovkNorm(ra/OVK_D), dec:dec/OVK_D};
}
// экваториальные → азимут (0 — север, по часовой) и угол места, °
function ovkAzEl(raD,decD,jd,lat,lon){
  const gmst=ovkNorm(280.46061837+360.98564736629*(jd-2451545)), H=(gmst+lon-raD)*OVK_D, la=lat*OVK_D, de=decD*OVK_D;
  const el=Math.asin(Math.sin(la)*Math.sin(de)+Math.cos(la)*Math.cos(de)*Math.cos(H));
  const az=Math.atan2(Math.sin(H), Math.cos(H)*Math.sin(la)-Math.tan(de)*Math.cos(la))/OVK_D+180;
  return {az:ovkNorm(az), el:el/OVK_D};
}
function ovkSunEcl(T){
  const L0=280.46646+36000.76983*T, M=(357.52911+35999.05029*T)*OVK_D;
  const C=1.914602*Math.sin(M)+0.019993*Math.sin(2*M)+0.000289*Math.sin(3*M);
  return {lon:ovkNorm(L0+C-0.00569-0.00478*Math.sin((125.04-1934.136*T)*OVK_D))};     // видимая долгота (нутация, аберрация)
}
function ovkMoonEcl(T){
  const r=a=>a*OVK_D, s=Math.sin;
  const Lp=218.3164477+481267.88123421*T, D=r(297.8501921+445267.1114034*T), M=r(357.5291092+35999.0502909*T),
        Mp=r(134.9633964+477198.8675055*T), F=r(93.2720950+483202.0175233*T);
  const lon=Lp+6.289*s(Mp)+1.274*s(2*D-Mp)+0.658*s(2*D)+0.214*s(2*Mp)-0.186*s(M)-0.114*s(2*F)+0.059*s(2*D-2*Mp)
           +0.057*s(2*D-M-Mp)+0.053*s(2*D+Mp)+0.046*s(2*D-M)+0.041*s(Mp-M)-0.035*s(D)-0.030*s(M+Mp);
  const lat=5.128*s(F)+0.281*s(Mp+F)+0.278*s(Mp-F)+0.173*s(2*D-F)+0.055*s(2*D-Mp+F)+0.046*s(2*D-Mp-F)+0.033*s(2*D+F-Mp);
  const c=Math.cos, dist=385001-20905*c(Mp)-3699*c(2*D-Mp)-2956*c(2*D)-570*c(2*Mp)+246*c(2*Mp-2*D)-205*c(M-2*D)-171*c(Mp+2*D)-152*c(Mp+M-2*D);
  return {lon:ovkNorm(lon), lat, dist};
}
// Солнце и Луна для точки lat/lon в момент ms: az, el (°), size — угловой диаметр, °;
// у Луны ещё frac — освещённая доля диска, waxing — растёт ли
function ovkSkyBodies(ms,lat,lon){
  const jd=ovkJd(ms), T=(jd-2451545)/36525, S=ovkSunEcl(T), Mo=ovkMoonEcl(T);
  const se=ovkEclToEq(S.lon,0,T), me=ovkEclToEq(Mo.lon,Mo.lat,T);
  const sun=ovkAzEl(se.ra,se.dec,jd,lat,lon), moon=ovkAzEl(me.ra,me.dec,jd,lat,lon);
  const par=Math.asin(6378.14/Mo.dist)/OVK_D;                       // параллакс: Луна близко, из точки наблюдателя она ниже
  moon.el-=par*Math.cos(moon.el*OVK_D);
  const cosPsi=Math.cos(Mo.lat*OVK_D)*Math.cos((Mo.lon-S.lon)*OVK_D);
  return {
    sun:{id:'sun', label:'Sun', az:sun.az, el:sun.el, size:0.533},
    moon:{id:'moon', label:'Moon', az:moon.az, el:moon.el, size:2*Math.asin(1737.4/Mo.dist)/OVK_D,
          frac:(1-cosPsi)/2, waxing:Math.sin((Mo.lon-S.lon)*OVK_D)>0, dist:Mo.dist},
  };
}

// ---------- видимость по рельефу ----------
// rings[j] — Float32Array(NA·4): e, n, u, h точек кольца j (NaN — нет данных), азимуты через 360/NA.
// cum[j][i] — наибольший угол места (рад) по кольцам ближе j в азимутах i−1…i+1: то, что заслоняет точку дальше кольца j.
function ovkLosBuild(rings,NA){
  const nr=rings.length, cum=[], run=new Float32Array(NA).fill(-Infinity);
  for(let j=0;j<=nr;j++){
    const c=new Float32Array(NA);
    for(let i=0;i<NA;i++) c[i]=Math.max(run[i],run[(i+NA-1)%NA],run[(i+1)%NA]);
    cum.push(c);
    if(j===nr) break;
    const a=rings[j];
    for(let i=0;i<NA;i++){
      const o=i*4; if(a[o]!==a[o]) continue;
      const ang=Math.atan2(a[o+2],Math.hypot(a[o],a[o+1]));
      if(ang>run[i]) run[i]=ang;
    }
  }
  return {cum,NA,nr};
}
// точка в ENU (м): видна ли из центра колец. margin — запас, рад (против самозаслонения точек на поверхности)
function ovkVisible(los,e,n,u,margin){
  if(!los) return true;
  const hd=Math.hypot(e,n); if(hd<OVK_RING0) return true;
  const k=Math.min(los.nr,Math.max(0,Math.ceil(Math.log(hd*0.95/OVK_RING0)/Math.log(OVK_RING_K))));
  if(k<=0) return true;
  const i=Math.round(ovkNorm(Math.atan2(e,n)/OVK_D)/(360/los.NA))%los.NA;
  return Math.atan2(u,hd)>=los.cum[k][i]-(margin??0.002);
}

// ---------- OSM Overpass ----------
function ovkOsmQuery(lat,lon,rM){
  const a='(around:'+Math.round(rM)+','+lat.toFixed(5)+','+lon.toFixed(5)+')';
  return '[out:json][timeout:25];('+
    'node["natural"="peak"]["name"]'+a+';'+
    'node["place"~"^(city|town|village)$"]["name"]'+a+';'+
    'way["highway"~"^(motorway|trunk|primary)$"]'+a+';'+
    'way["waterway"="river"]'+a+';'+
    ');out geom 6000;';
}
function ovkSimplify(g,minM){                         // убрать точки чаще minM метров (последнюю оставить)
  const out=[]; let last=null;
  for(let i=0;i<g.length;i++){
    const p=g[i]; if(!p || p.lat==null) continue;
    if(last){
      const dy=(p.lat-last[0])*111320, dx=(p.lon-last[1])*111320*Math.cos(p.lat*OVK_D);
      if(Math.hypot(dx,dy)<minM && i<g.length-1) continue;
    }
    out.push([p.lat,p.lon]); last=[p.lat,p.lon];
  }
  return out;
}
const OVK_PLACE_RANK={city:0,town:1,village:2}, OVK_ROAD_RANK={motorway:0,trunk:1,primary:2};
function ovkOsmParse(json,minM=80){
  const res={peaks:[],places:[],roads:[],rivers:[]};
  for(const el of (json?.elements||[])){
    const t=el.tags||{};
    if(el.type==='node' && el.lat!=null){
      if(t.natural==='peak') res.peaks.push({lat:el.lat,lon:el.lon,name:t['name:en']||t.name||'',ele:parseFloat(t.ele)});
      else if(t.place in OVK_PLACE_RANK) res.places.push({lat:el.lat,lon:el.lon,name:t.name||'',kind:t.place});
    } else if(el.type==='way' && el.geometry){
      const pts=ovkSimplify(el.geometry,minM); if(pts.length<2) continue;
      if(t.highway in OVK_ROAD_RANK) res.roads.push({pts,kind:t.highway,name:t.name||t.ref||''});
      else if(t.waterway==='river') res.rivers.push({pts,name:t.name||''});
    }
  }
  res.peaks.sort((a,b)=>(isNaN(b.ele)?-1:b.ele)-(isNaN(a.ele)?-1:a.ele));
  res.places.sort((a,b)=>OVK_PLACE_RANK[a.kind]-OVK_PLACE_RANK[b.kind]);
  res.roads.sort((a,b)=>OVK_ROAD_RANK[a.kind]-OVK_ROAD_RANK[b.kind]);
  let budget=5000;                                    // всего вершин линий — чтобы кадр не тормозил
  for(const k of ['roads','rivers']) res[k]=res[k].filter(w=>(budget-=w.pts.length)>=0);
  return res;
}

// ---------- поза камеры во времени (сдвиг видео относительно датчиков) ----------
function ovkPosePush(buf,t,az,el,roll){
  const l=buf[buf.length-1];
  if(l && t-l.t<4) return;
  buf.push({t,az,el,roll});
  while(buf.length>1 && t-buf[0].t>3000) buf.shift();
}
function ovkPoseAt(buf,t){
  const nb=buf.length; if(!nb) return null;
  if(t>=buf[nb-1].t) return buf[nb-1];
  if(t<=buf[0].t) return buf[0];
  let i=nb-1; while(i>0 && buf[i-1].t>t) i--;
  const a=buf[i-1], b=buf[i], f=(t-a.t)/(b.t-a.t||1), ang=(x,y)=>ovkNorm(x+ovkWrap(y-x)*f);
  return {t, az:ang(a.az,b.az), el:a.el+(b.el-a.el)*f, roll:a.roll+ovkWrap(b.roll-a.roll)*f};
}
// след объекта: новая точка, если сдвинулся больше minM или прошло 5 с; старше keepMs — отбрасываем
function ovkTrailPush(tr,la,lo,h,t,keepMs,minM=40){
  const l=tr[tr.length-1];
  if(l){
    const d=Math.hypot((la-l.la)*111320,(lo-l.lo)*111320*Math.cos(la*OVK_D));
    if(d<minM && t-l.t<5000) return;
  }
  tr.push({la,lo,h,t});
  while(tr.length && t-tr[0].t>keepMs) tr.shift();
}
