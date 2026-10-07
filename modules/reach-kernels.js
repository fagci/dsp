"use strict";
/* ============================ Ядро Radio Reach ============================
   До какого расстояния по каждому азимуту виден самолёт на заданной высоте из точки с антенной: рельеф вдоль луча,
   кривизна Земли с рефракцией (k), за пределами карты высот — опорная земля. Без DOM — tools/test-reach.mjs. */

const RR_R=6371008.8, RR_D=Math.PI/180, RR_FT=.3048;

// «FL100, 3000m, 10000» → [{m, label}]; без единицы — по умолчанию unit ('ft' или 'm'); FLnnn — сотни футов
function rrParseAlts(text,unit){
  const out=[];
  for(const t of String(text||'').split(/[,;\s]+/).filter(Boolean)){
    let m=null, label=t, x;
    if((x=/^fl\s*(\d+)$/i.exec(t))) m=+x[1]*100*RR_FT, label='FL'+x[1];
    else if((x=/^(\d+(?:\.\d+)?)\s*(m|ft)?$/i.exec(t))){ const u=(x[2]||unit).toLowerCase(); m=+x[1]*(u==='ft' ? RR_FT : 1); label=x[1]+' '+u; }
    if(m!=null && m>=0 && m<=30000) out.push({m,label});
  }
  return out;
}
const rrParseNums=text=>String(text||'').split(/[,;\s]+/).filter(Boolean).map(Number).filter(x=>isFinite(x) && x>=0);

// расстояния выборки вдоль луча, м: step до границы карты высот rh, дальше шагом 1 км до dmax
function rrDists(rh,step,dmax){
  const d=[];
  for(let x=step;x<=Math.min(rh,dmax);x+=step) d.push(x);
  for(let x=Math.max(step,Math.floor(rh/1000)*1000+1000);x<=dmax;x+=1000) d.push(x);
  return d;
}
// точка на азимуте az (°) в d метрах
function rrDest(lat,lon,az,d){
  const la=lat*RR_D, lo=lon*RR_D, th=az*RR_D, dl=d/RR_R, sd=Math.sin(dl), cd=Math.cos(dl), sl=Math.sin(la), cl=Math.cos(la);
  const s2=sl*cd+cl*sd*Math.cos(th), la2=Math.asin(s2), lo2=lo+Math.atan2(Math.sin(th)*sd*cl,cd-sl*s2);
  return [la2/RR_D, lo2/RR_D];
}
// высоты местности вдоль азимута по расстояниям d; hAt(lat,lon) → м или NaN (нет данных)
function rrTerrain(hAt,lat,lon,az,d){
  const out=new Float32Array(d.length);
  for(let i=0;i<d.length;i++){ const p=rrDest(lat,lon,az,d[i]); out[i]=hAt(p[0],p[1]); }
  return out;
}
// расстояние до первой потери цели на высоте H (над уровнем моря) для антенны на высоте h0 (над уровнем моря);
// ht — высоты местности в точках d (NaN — нет данных → gref), k — рефракция. Цель на расстоянии di видна, если угол на неё
// не меньше наибольшего угла местности (и сферы) между антенной и di. Возвращает метры
function rrReachAz(d,ht,h0,H,k,gref){
  const Re=RR_R*k; let m=-Infinity, pf=0, pd=0;
  for(let i=0;i<d.length;i++){
    const di=d[i], curv=di*di/(2*Re), f=Math.atan2(H-h0-curv,di)-m;
    if(f<0){
      if(i===0 || !isFinite(pf)) return pd;
      return pd+(di-pd)*pf/(pf-f);                       // пересечение между соседними выборками
    }
    pf=f; pd=di;                                         // запас на этой выборке: рельеф самой выборки цель на ней не закрывает
    const h=ht[i]===ht[i] ? ht[i] : gref, a=Math.atan2(h-h0-curv,di);
    if(a>m) m=a;
  }
  return d[d.length-1];
}
// по всем азимутам (ht[az] — массивы местности по градусам 0…359) → Float32Array(360), м
function rrReachAll(d,ht,h0,H,k,gref){
  const out=new Float32Array(360);
  for(let a=0;a<360;a++) out[a]=rrReachAz(d,ht[a],h0,H,k,gref);
  return out;
}
// min / avg / max (км), азимуты худшего и лучшего, площадь покрытия (км²)
function rrStats(reach){
  let mn=Infinity, mx=-Infinity, sum=0, a0=0, a1=0, area=0;
  for(let a=0;a<reach.length;a++){
    const r=reach[a]/1000; sum+=r; area+=.5*r*r*(2*Math.PI/reach.length);
    if(r<mn){ mn=r; a0=a; } if(r>mx){ mx=r; a1=a; }
  }
  return {min:mn, avg:sum/reach.length, max:mx, minAz:a0, maxAz:a1, area};
}
// многоугольник на карту: каждые stepDeg°, замкнутый
function rrPolygon(lat,lon,reach,stepDeg){
  const out=[];
  for(let a=0;a<=360;a+=stepDeg){ const p=rrDest(lat,lon,a%360,reach[a%360]); out.push([+p[0].toFixed(5),+p[1].toFixed(5)]); }
  return out;
}
// расстояние (км) и азимут от точки до точки
function rrDistKm(la1,lo1,la2,lo2){
  const dy=(la2-la1)*111.19, dx=(lo2-lo1)*111.19*Math.cos((la1+la2)/2*RR_D); return Math.hypot(dx,dy);
}
function rrBearing(la1,lo1,la2,lo2){
  const dy=la2-la1, dx=(lo2-lo1)*Math.cos((la1+la2)/2*RR_D); return ((Math.atan2(dx,dy)/RR_D)%360+360)%360;
}
// наблюдаемые максимальные дальности по секторам: bins — Float32Array(72)
function rrObsPush(bins,az,km){ const i=Math.floor(((az%360)+360)%360/(360/bins.length)); if(km>bins[i]) bins[i]=km; }
