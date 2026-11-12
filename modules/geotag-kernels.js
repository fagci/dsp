"use strict";
/* ============================ Geotag: ядро ============================
   Привязка позиции к чему угодно (node tools/test-geotag.mjs): записи (уровень SDR, пакет, Wi-Fi, замер) и числа получают lat / lon / acc.
   Позиция берётся ПО ВРЕМЕНИ записи: между двумя фиксами — линейно (запись пришла с задержкой — всё равно попадёт в точку, где её приняли),
   после последнего — последний, если он не старше maxAge, иначе позиции нет. Прореживание: не чаще чем через step метров / dt секунд. */

const GT_KEEP_S=900, GT_CAP=6000;
function gtNew(){ return {fix:[], dist:0, last:null}; }

// время записи → мс эпохи: уже мс (> 1e11), секунды (1e8…1e11) или нет (null)
function gtTime(t){
  const v=typeof t==='number' ? t : typeof t==='string' && t.trim()!=='' ? +t : NaN;
  if(!isFinite(v)) return null;
  return v>1e11 ? v : v>1e8 ? v*1000 : null;
}
function gtNum(v){ if(v==null||v==='') return null; const x=+v; return isFinite(x) ? x : null; }
// запись с координатами → фикс {lat,lon,acc,alt,speed,t} или null
function gtFixOf(r,now){
  if(!r || typeof r!=='object') return null;
  const lat=gtNum(r.lat ?? r.latitude), lon=gtNum(r.lon ?? r.lng ?? r.longitude);
  if(lat==null||lon==null||Math.abs(lat)>90||Math.abs(lon)>180) return null;
  return {lat,lon,acc:gtNum(r.acc ?? r.accuracy),alt:gtNum(r.alt ?? r.altitude),speed:gtNum(r.speed),t:gtTime(r.t ?? r.time ?? r.ts)??now};
}
function gtPush(st,f){
  if(!f||!isFinite(f.lat)||!isFinite(f.lon)||!isFinite(f.t)) return false;
  const a=st.fix; let i=a.length;
  while(i>0 && a[i-1].t>f.t) i--;                                   // фиксы могут прийти не по порядку
  if(i>0 && a[i-1].t===f.t) a[i-1]=f; else a.splice(i,0,f);
  const cut=a[a.length-1].t-GT_KEEP_S*1000; let k=0; while(k<a.length-1 && a[k].t<cut) k++; if(k) a.splice(0,k);
  if(a.length>GT_CAP) a.splice(0,a.length-GT_CAP);
  return true;
}
// позиция на момент t (мс): {lat,lon,acc,alt,speed,age (с до ближайшего фикса),how:'interp'|'last'|'first'} или null
function gtAt(st,t,maxAge){
  const a=st.fix; if(!a.length) return null;
  const lim=(maxAge>0 ? maxAge : 5)*1000;
  let i=0; while(i<a.length && a[i].t<t) i++;
  const pick=(f,how,age)=>({lat:f.lat,lon:f.lon,acc:f.acc,alt:f.alt,speed:f.speed,age:age/1000,how});
  if(i===a.length){ const f=a[a.length-1], d=t-f.t; return d<=lim ? pick(f,'last',d) : null; }
  if(i===0){ const f=a[0], d=f.t-t; return d<=lim ? pick(f,'first',d) : null; }
  const p=a[i-1], q=a[i], span=q.t-p.t;
  if(span>lim*2){                                                   // дыра между фиксами — берём ближайший, если он свежий
    const dp=t-p.t, dq=q.t-t, f=dp<=dq ? p : q, d=Math.min(dp,dq);
    return d<=lim ? pick(f,'last',d) : null;
  }
  const u=span>0 ? (t-p.t)/span : 0, L=(x,y)=>x==null||y==null ? (x ?? y) : x+(y-x)*u;
  return {lat:p.lat+(q.lat-p.lat)*u, lon:p.lon+(q.lon-p.lon)*u, acc:p.acc!=null&&q.acc!=null ? Math.max(p.acc,q.acc) : (p.acc ?? q.acc),
    alt:L(p.alt,q.alt), speed:L(p.speed,q.speed), age:Math.min(t-p.t,q.t-t)/1000, how:'interp'};
}
// расстояние, м
function gtDist(lat1,lon1,lat2,lon2){
  const R=6371008.8, r=Math.PI/180, dp=(lat2-lat1)*r, dl=(lon2-lon1)*r;
  const h=Math.sin(dp/2)**2+Math.cos(lat1*r)*Math.cos(lat2*r)*Math.sin(dl/2)**2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));
}
// прореживание: пускаем, если ушли от прошлой пропущенной точки на step м И прошло dt с (0 — не проверять). Считает пройденный путь.
function gtStep(st,pos,t,o){
  const L=st.last;
  if(!L){ st.last={lat:pos.lat,lon:pos.lon,t}; return true; }
  const d=gtDist(L.lat,L.lon,pos.lat,pos.lon);
  if((o.step>0 && d<o.step) || (o.dt>0 && (t-L.t)/1000<o.dt)) return false;
  st.dist+=d; st.last={lat:pos.lat,lon:pos.lon,t}; return true;
}
// запись + позиция → новая запись. Свои lat/lon у записи сохраняются, если не override. gage — возраст фикса, с; gfix — как найдено
function gtTag(r,pos,o){
  const out={...r}, keep=!(o&&o.override);
  if(!keep || out.lat==null || out.lon==null){ out.lat=+pos.lat.toFixed(7); out.lon=+pos.lon.toFixed(7); }
  if(pos.acc!=null && (!keep || out.acc==null)) out.acc=+pos.acc.toFixed(1);
  if(pos.alt!=null && (!keep || out.alt==null)) out.alt=+pos.alt.toFixed(1);
  if(pos.speed!=null && (!keep || out.speed==null)) out.speed=+pos.speed.toFixed(2);
  out.gage=+pos.age.toFixed(1); out.gfix=pos.how;
  return out;
}

if(typeof module!=='undefined') module.exports={gtNew,gtTime,gtNum,gtFixOf,gtPush,gtAt,gtDist,gtStep,gtTag};
