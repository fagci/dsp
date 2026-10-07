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

// ---------- планеты, яркие звёзды, глубокий космос ----------
// Планеты: кеплеровы элементы Standish (JPL, 1800–2050) — точность порядка угловой минуты, для AR-метки хватает.
// [a, e, I, L, ϖ, Ω] и их скорости за столетие; Земля — барицентр Земля–Луна
const OVK_ELEM={
  mercury:[[0.38709927,0.20563593,7.00497902,252.25032350,77.45779628,48.33076593],[0.00000037,0.00001906,-0.00594749,149472.67411175,0.16047689,-0.12534081]],
  venus:  [[0.72333566,0.00677672,3.39467605,181.97909950,131.60246718,76.67984255],[0.00000390,-0.00004107,-0.00078890,58517.81538729,0.00268329,-0.27769418]],
  earth:  [[1.00000261,0.01671123,-0.00001531,100.46457166,102.93768193,0],[0.00000562,-0.00004392,-0.01294668,35999.37244981,0.32327364,0]],
  mars:   [[1.52371034,0.09339410,1.84969142,-4.55343205,-23.94362959,49.55953891],[0.00001847,0.00007882,-0.00813131,19140.30268499,0.44441088,-0.29257343]],
  jupiter:[[5.20288700,0.04838624,1.30439695,34.39644051,14.72847983,100.47390909],[-0.00011607,-0.00013253,-0.00183714,3034.74612775,0.21252668,0.20469106]],
  saturn: [[9.53667594,0.05386179,2.48599187,49.95424423,92.59887831,113.66242448],[-0.00125060,-0.00050991,0.00193609,1222.49362201,-0.41897216,-0.28867794]],
  uranus: [[19.18916464,0.04725744,0.77263783,313.23810451,170.95427630,74.01692503],[-0.00196176,-0.00004397,-0.00242939,428.48202785,0.40805281,0.04240589]],
  neptune:[[30.06992276,0.00859048,1.77004347,-55.12002969,44.96476227,131.78422574],[0.00026291,0.00005105,0.00035372,218.45945325,-0.32241464,-0.00508664]],
};
// id, название, угловой диаметр на 1 а.е., ″; блеск — по формулам Astronomical Almanac (кольца Сатурна не учтены)
const OVK_PLANETS=[
  {id:'mercury',label:'Mercury',d0:6.74},{id:'venus',label:'Venus',d0:16.92},{id:'mars',label:'Mars',d0:9.36},
  {id:'jupiter',label:'Jupiter',d0:196.74},{id:'saturn',label:'Saturn',d0:165.6},
  {id:'uranus',label:'Uranus',d0:65.8},{id:'neptune',label:'Neptune',d0:62.2}];
const OVK_MAG0={mercury:-0.42,venus:-4.40,mars:-1.52,jupiter:-9.40,saturn:-8.88,uranus:-7.19,neptune:-6.87};
function ovkHelio(id,T){                              // гелиоцентрические эклиптические J2000, а.е.
  const [e0,r]=OVK_ELEM[id], v=e0.map((x,i)=>x+r[i]*T);
  const a=v[0], e=v[1], I=v[2]*OVK_D, w=(v[4]-v[5])*OVK_D, Om=v[5]*OVK_D;
  let M=ovkWrap(v[3]-v[4])*OVK_D, E=M+e*Math.sin(M);
  for(let i=0;i<8;i++) E-=(E-e*Math.sin(E)-M)/(1-e*Math.cos(E));
  const xp=a*(Math.cos(E)-e), yp=a*Math.sqrt(1-e*e)*Math.sin(E);
  const cw=Math.cos(w), sw=Math.sin(w), cO=Math.cos(Om), sO=Math.sin(Om), cI=Math.cos(I), sI=Math.sin(I);
  return [(cw*cO-sw*sO*cI)*xp+(-sw*cO-cw*sO*cI)*yp, (cw*sO+sw*cO*cI)*xp+(-sw*sO+cw*cO*cI)*yp, sw*sI*xp+cw*sI*yp];
}
// прецессия экваториальных координат J2000 → на эпоху T (веков от J2000), °
function ovkPrecess(raD,decD,T){
  const s=OVK_D/3600, zeta=(2306.2181*T+0.30188*T*T)*s, z=(2306.2181*T+1.09468*T*T)*s, th=(2004.3109*T-0.42665*T*T)*s;
  const a=raD*OVK_D, d=decD*OVK_D;
  const A=Math.cos(d)*Math.sin(a+zeta), B=Math.cos(th)*Math.cos(d)*Math.cos(a+zeta)-Math.sin(th)*Math.sin(d), C=Math.sin(th)*Math.cos(d)*Math.cos(a+zeta)+Math.cos(th)*Math.sin(d);
  return {ra:ovkNorm((Math.atan2(A,B)+z)/OVK_D), dec:Math.asin(Math.max(-1,Math.min(1,C)))/OVK_D};
}
// планеты для эпохи T: ra, dec (на эпоху), dist (а.е.), mag, size (°), frac — освещённая доля
function ovkPlanets(T){
  const E=ovkHelio('earth',T), eps=23.43928*OVK_D, ce=Math.cos(eps), se=Math.sin(eps), R=Math.hypot(...E), out=[];
  for(const P of OVK_PLANETS){
    const h=ovkHelio(P.id,T), x=h[0]-E[0], y=h[1]-E[1], z=h[2]-E[2], D=Math.hypot(x,y,z), r=Math.hypot(...h);
    const ra=Math.atan2(y*ce-z*se,x)/OVK_D, dec=Math.asin((y*se+z*ce)/D)/OVK_D, q=ovkPrecess(ovkNorm(ra),dec,T);
    const i=Math.acos(Math.max(-1,Math.min(1,(r*r+D*D-R*R)/(2*r*D))))/OVK_D;      // фазовый угол
    let m=OVK_MAG0[P.id]+5*Math.log10(r*D);
    if(P.id==='mercury') m+=0.0380*i-0.000273*i*i+0.000002*i*i*i;
    else if(P.id==='venus') m+=0.0009*i+0.000239*i*i-0.00000065*i*i*i;
    else if(P.id==='mars') m+=0.016*i;
    else if(P.id==='jupiter') m+=0.005*i;
    out.push({id:P.id,label:P.label,kind:'planet',ra:q.ra,dec:q.dec,dist:D,mag:m,size:P.d0/D/3600,frac:(1+Math.cos(i*OVK_D))/2});
  }
  return out;
}
// [id, название, α J2000 (ч), δ J2000 (°), блеск, вид]; deep — туманности, галактики, скопления
const OVK_STARS=[
  ['sirius','Sirius',6.7525,-16.7161,-1.46],['canopus','Canopus',6.3992,-52.6957,-0.74],['arcturus','Arcturus',14.2610,19.1824,-0.05],
  ['rigilkent','Rigil Kent.',14.6600,-60.8354,-0.01],['vega','Vega',18.6156,38.7837,0.03],['capella','Capella',5.2782,45.9980,0.08],
  ['rigel','Rigel',5.2423,-8.2016,0.13],['procyon','Procyon',7.6550,5.2250,0.34],['achernar','Achernar',1.6286,-57.2368,0.46],
  ['betelgeuse','Betelgeuse',5.9195,7.4071,0.50],['hadar','Hadar',14.0637,-60.3730,0.61],['altair','Altair',19.8464,8.8683,0.76],
  ['acrux','Acrux',12.4433,-63.0991,0.76],['aldebaran','Aldebaran',4.5987,16.5093,0.85],['antares','Antares',16.4901,-26.4320,0.96],
  ['spica','Spica',13.4199,-11.1613,0.97],['pollux','Pollux',7.7553,28.0262,1.14],['fomalhaut','Fomalhaut',22.9608,-29.6222,1.16],
  ['deneb','Deneb',20.6905,45.2803,1.25],['mimosa','Mimosa',12.7953,-59.6888,1.25],['regulus','Regulus',10.1395,11.9672,1.35],
  ['adhara','Adhara',6.9771,-28.9721,1.50],['castor','Castor',7.5767,31.8883,1.58],['shaula','Shaula',17.5601,-37.1038,1.63],
  ['gacrux','Gacrux',12.5194,-57.1132,1.64],['bellatrix','Bellatrix',5.4189,6.3497,1.64],['elnath','Elnath',5.4382,28.6075,1.65],
  ['alnilam','Alnilam',5.6036,-1.2019,1.69],['alnair','Alnair',22.1372,-46.9610,1.74],['alnitak','Alnitak',5.6793,-1.9426,1.77],
  ['alioth','Alioth',12.9005,55.9598,1.77],['dubhe','Dubhe',11.0621,61.7510,1.79],['mirfak','Mirfak',3.4054,49.8612,1.80],
  ['wezen','Wezen',7.1399,-26.3932,1.84],['kaus','Kaus Austr.',18.4029,-34.3846,1.85],['alkaid','Alkaid',13.7923,49.3133,1.86],
  ['polaris','Polaris',2.5303,89.2641,1.98],['alpheratz','Alpheratz',0.1398,29.0904,2.06],['schedar','Schedar',0.6751,56.5373,2.24],
  ['mizar','Mizar',13.3988,54.9254,2.23],['caph','Caph',0.1529,59.1498,2.27],['merak','Merak',11.0307,56.3824,2.37],
  ['phecda','Phecda',11.8972,53.6948,2.44],['navi','Navi',0.9451,60.7167,2.47],['imai','Imai',12.2524,-58.7489,2.80],
  ['megrez','Megrez',12.2571,57.0326,3.31]];
const OVK_DEEP=[
  ['m31','Andromeda Galaxy',0.7123,41.269,3.4],['m45','Pleiades',3.7900,24.105,1.6],['m42','Orion Nebula',5.5881,-5.391,4.0],
  ['lmc','Large Magellanic Cloud',5.3917,-69.756,0.9],['smc','Small Magellanic Cloud',0.8767,-72.80,2.7],
  ['omegacen','Omega Centauri',13.4472,-47.480,3.7],['gc','Galactic Centre',17.7611,-29.008,null],['m13','Hercules Cluster',16.6947,36.460,5.8]];
// планеты (mag ≤ planetMag), звёзды (mag ≤ starMag), глубокий космос (deep) — азимут и угол места в точке lat/lon
function ovkSkyObjects(ms,lat,lon,opt){
  const jd=ovkJd(ms), T=(jd-2451545)/36525, res=[];
  const put=(o,ra,dec)=>{ const h=ovkAzEl(ra,dec,jd,lat,lon); o.az=h.az; o.el=h.el; res.push(o); };
  if(opt.planets) for(const P of ovkPlanets(T)) put(P,P.ra,P.dec);
  const st=(arr,kind,lim)=>{
    for(const s of arr){
      if(s[4]!=null && s[4]>lim) continue;
      const q=ovkPrecess(s[2]*15,s[3],T);
      put({id:s[0],label:s[1],kind,mag:s[4],size:0},q.ra,q.dec);
    }
  };
  if(opt.starMag!=null) st(OVK_STARS,'star',opt.starMag);
  if(opt.deep) st(OVK_DEEP,'deep',99);
  return res;
}

// ---------- видимость по рельефу ----------
// rings[j] — Float32Array(NA·4): e, n, u, h точек кольца j (NaN — нет данных), азимуты через 360/NA.
// cum[j][i] — наибольший угол места (рад) по кольцам ближе j в азимутах i−1…i+1: то, что заслоняет точку дальше кольца j.
function ovkLosBuild(rings,NA){
  const nr=rings.length, cum=[], low=[], run=new Float32Array(NA).fill(-Infinity);
  for(let j=0;j<=nr;j++){
    const c=new Float32Array(NA), l=new Float32Array(NA);
    for(let i=0;i<NA;i++){ c[i]=Math.max(run[i],run[(i+NA-1)%NA],run[(i+1)%NA]); l[i]=Math.min(run[i],run[(i+1)%NA]); }
    cum.push(c); low.push(l);
    if(j===nr) break;
    const a=rings[j];
    for(let i=0;i<NA;i++){
      const o=i*4; if(a[o]!==a[o]) continue;
      const ang=Math.atan2(a[o+2],Math.hypot(a[o],a[o+1]));
      if(ang>run[i]) run[i]=ang;
    }
  }
  return {cum,low,NA,nr};
}
// ячейка (j, i) между кольцами j и j+1 целиком закрыта ближними кольцами: все её вершины ниже линии, по которой ближний рельеф перекрывает оба азимута
function ovkCellHidden(los,rings,j,i){
  const NA=los.NA, a=rings[j], b=rings[j+1], l=los.low[j][i], i1=((i+1)%NA)*4, i0=i*4;
  if(!(l>-Infinity)) return false;
  for(const [r,o] of [[a,i0],[a,i1],[b,i0],[b,i1]])
    if(Math.atan2(r[o+2],Math.hypot(r[o],r[o+1]))>=l-0.004) return false;
  return true;
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

// ---------- здания и улицы OSM ----------
// way[building] с контуром (высота — тег height, иначе building:levels × 3 м, иначе 7 м) и улицы вокруг
const OVK_STREETS='motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service';
function ovkBldQuery(lat,lon,rM){
  const a='(around:'+Math.round(rM)+','+lat.toFixed(5)+','+lon.toFixed(5)+')';
  return '[out:json][timeout:60];way["building"]'+a+'->.b;way["highway"~"^('+OVK_STREETS+')$"]'+a+'->.r;.b out geom 30000;.r out geom 20000;';
}
// ближние max зданий: {id, h, lv, pts:[[lat,lon]…] без замыкающей точки, lat, lon (центр), d — расстояние до центра запроса, м}
function ovkBldParse(json,lat,lon,max=30000){
  const out=[], kx=111320*Math.cos(lat*OVK_D);
  for(const el of (json?.elements||[])){
    if(el.type!=='way' || !el.geometry || !el.tags || !el.tags.building) continue;
    let pts=el.geometry.filter(q=>q && q.lat!=null).map(q=>[q.lat,q.lon]);
    if(pts.length>1 && pts[0][0]===pts[pts.length-1][0] && pts[0][1]===pts[pts.length-1][1]) pts.pop();
    if(pts.length<3) continue;
    let cl=0, co=0; for(const q of pts){ cl+=q[0]; co+=q[1]; } cl/=pts.length; co/=pts.length;
    const t=el.tags, hh=parseFloat(t.height), lv=parseFloat(t['building:levels']), lvl=isFinite(lv) ? Math.max(1,Math.round(lv)) : null;
    const h=isFinite(hh) && hh>0 ? hh : lvl ? lvl*3 : 7;
    out.push({id:el.id, h:Math.min(h,400), lv:lvl || Math.max(1,Math.round(h/3)), pts, lat:cl, lon:co, d:Math.hypot((cl-lat)*111320,(co-lon)*kx)});
  }
  out.sort((a,b)=>a.d-b.d);
  return out.slice(0,max);
}
// улицы: точки через stepM метров вдоль линии (фонари); ближние первыми, всего не больше maxPts точек; [{kind, pts:[[lat,lon]…]}]
function ovkBldRoads(json,lat,lon,stepM=25,maxPts=20000){
  const res=[], kx=111320*Math.cos(lat*OVK_D);
  for(const el of (json?.elements||[])){
    const hw=el.tags?.highway;
    if(el.type!=='way' || !el.geometry || !hw) continue;
    const g=el.geometry.filter(q=>q && q.lat!=null), pts=[];
    for(let i=0;i<g.length;i++){
      if(!i){ pts.push([g[0].lat,g[0].lon]); continue; }
      const a=g[i-1], b=g[i], dy=(b.lat-a.lat)*111320, dx=(b.lon-a.lon)*kx, L=Math.hypot(dx,dy), m=Math.max(1,Math.round(L/stepM));
      for(let q=1;q<=m;q++) pts.push([a.lat+(b.lat-a.lat)*q/m, a.lon+(b.lon-a.lon)*q/m]);
    }
    if(pts.length<2) continue;
    const mid=pts[pts.length>>1];
    res.push({kind:hw, pts, d:Math.hypot((mid[0]-lat)*111320,(mid[1]-lon)*kx)});
  }
  res.sort((a,b)=>a.d-b.d);
  let budget=maxPts;
  return res.filter(w=>(budget-=w.pts.length)>=0);
}

// ---------- свет и тени рельефа ----------
// направление на Солнце в ENU
const ovkSunVec=(az,el)=>[Math.sin(az*OVK_D)*Math.cos(el*OVK_D), Math.cos(az*OVK_D)*Math.cos(el*OVK_D), Math.sin(el*OVK_D)];
// 0 — ночь, 1 — день; сумерки между −6° и +6°
const ovkDayK=el=>Math.max(0,Math.min(1,(el+6)/12));
// освещённость ячейки 0…1 по нормали (вверх) n и направлению на Солнце s; плоская земля ≈ .8, склон к Солнцу — 1
function ovkLit(n,s,el){
  if(el<=0) return 0;
  const d=n[0]*s[0]+n[1]*s[1]+n[2]*s[2];
  return Math.max(0,Math.min(1,d/Math.max(.35,Math.sin(el*OVK_D))/1.25));
}
// точка в тени рельефа: луч к Солнцу уходит над землёй? hAt(lat,lon) → высота, м; hTop — высота самой высокой точки окна; шаги растут ×1.25, кривизна не учитывается
function ovkShadowed(hAt,la,lo,h,az,el,maxM,hTop=Infinity){
  if(el<2) return false;
  const t=Math.tan(el*OVK_D), kLat=1/111320, kLon=1/(111320*Math.cos(la*OVK_D)), dN=Math.cos(az*OVK_D), dE=Math.sin(az*OVK_D);
  for(let d=100; d<=maxM; d*=1.25){
    if(h+d*t>hTop) return false;                         // луч выше любой вершины окна
    const q=hAt(la+d*dN*kLat, lo+d*dE*kLon);
    if(q===q && q>h+d*t+3) return true;
  }
  return false;
}

// ---------- цвет и дымка рельефа ----------
// цвет поверхности по высоте, м: зелень → бурый → камень → снег (линейно между опорными точками)
const OVK_PAL=[[0,[62,96,52]],[600,[92,108,58]],[1300,[122,104,72]],[2100,[130,118,104]],[2900,[142,140,142]],[3700,[236,240,246]]];
function ovkPalette(h){
  const P=OVK_PAL;
  if(h<=P[0][0]) return P[0][1].slice();
  for(let i=1;i<P.length;i++) if(h<=P[i][0]){
    const k=(h-P[i-1][0])/(P[i][0]-P[i-1][0]);
    return P[i-1][1].map((v,q)=>v+(P[i][1][q]-v)*k);
  }
  return P[P.length-1][1].slice();
}
// доля дымки 0…1 на расстоянии d (м) при видимости visKm; в горах (выше) воздух чище — высоко лежащие склоны дымятся слабее
function ovkFog(d,visKm,h){
  return (1-Math.exp(-d/(visKm*1000)))*(1-.55*Math.max(0,Math.min(1,h/3500)));
}
// на сколько градусов видимый горизонт ниже уровня на высоте hM (с рефракцией)
const ovkDip=hM=>.0293*Math.sqrt(Math.max(0,hM));

// ---------- связи ----------
// Связь — запись с двумя концами (lat, lon → lat2, lon2) или с ломаной path3 [[lat, lon, alt?], …] (прямой путь, путь с отражением).
// Высота конца: alt — над уровнем моря, иначе h — над землёй. Возвращает [{lat,lon,alt|null,h}, …] или null, если записи нет концов
function ovkLinkPts(r){
  const num=v=>{ const x=typeof v==='number' ? v : parseFloat(v); return isFinite(x) ? x : null; };
  let p3=r.path3;                                   // из ячейки Table приходит строкой JSON
  if(typeof p3==='string' && p3[0]==='['){ try{ p3=JSON.parse(p3); }catch(e){ p3=null; } }
  if(Array.isArray(p3) && p3.length>1){
    const out=p3.map(q=>({lat:num(q[0]),lon:num(q[1]),alt:num(q[2]),h:0}));
    return out.every(q=>q.lat!=null && q.lon!=null) ? out : null;
  }
  const la=num(r.lat), lo=num(r.lon), la2=num(r.lat2), lo2=num(r.lon2);
  if(la==null || lo==null || la2==null || lo2==null) return null;
  return [{lat:la,lon:lo,alt:num(r.alt),h:num(r.h) ?? 0},{lat:la2,lon:lo2,alt:num(r.alt2),h:num(r.h2) ?? num(r.h) ?? 0}];
}
// отрезок a→b (ENU, м), обрезанный плоскостью перед камерой (z — проекция на взгляд f, не меньше eps); null — целиком позади
function ovkClipNear(a,b,f,eps){
  const za=a[0]*f[0]+a[1]*f[1]+a[2]*f[2], zb=b[0]*f[0]+b[1]*f[1]+b[2]*f[2];
  if(za<=eps && zb<=eps) return null;
  if(za>=eps && zb>=eps) return [a,b];
  const t=(eps-za)/(zb-za), c=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t];
  return za<eps ? [c,b] : [a,c];
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
