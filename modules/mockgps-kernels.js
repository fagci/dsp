"use strict";
/* ============================ Mock GPS: маршруты и движение по точкам ============================
   Чистая логика без DOM (проверка: node tools/test-mockgps.mjs).
   mgParseRoute(текст) — «lat,lon[,alt]» построчно, GPX (trkpt / rtept / wpt), KML (coordinates: lon,lat,alt);
   mgRoute(точки) → маршрут с накопленными длинами; mgAt(маршрут, s, режим) → {lat, lon, alt, bearing, done};
   mgDest / mgDist / mgBearing — геодезия на сфере (R = 6 371 008.8 м). */

const MG_R=6371008.8, MG_RAD=Math.PI/180;
function mgDist(a,b){
  const p1=a.lat*MG_RAD, p2=b.lat*MG_RAD, dp=p2-p1, dl=(b.lon-a.lon)*MG_RAD;
  const h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2*MG_R*Math.asin(Math.min(1,Math.sqrt(h)));
}
function mgBearing(a,b){
  const p1=a.lat*MG_RAD, p2=b.lat*MG_RAD, dl=(b.lon-a.lon)*MG_RAD;
  const y=Math.sin(dl)*Math.cos(p2), x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
  return (Math.atan2(y,x)/MG_RAD+360)%360;
}
function mgDest(a,bearing,d){
  const p1=a.lat*MG_RAD, l1=a.lon*MG_RAD, br=bearing*MG_RAD, dr=d/MG_R;
  const p2=Math.asin(Math.sin(p1)*Math.cos(dr)+Math.cos(p1)*Math.sin(dr)*Math.cos(br));
  const l2=l1+Math.atan2(Math.sin(br)*Math.sin(dr)*Math.cos(p1),Math.cos(dr)-Math.sin(p1)*Math.sin(p2));
  return {lat:p2/MG_RAD,lon:((l2/MG_RAD+540)%360)-180};
}
const mgOk=(la,lo)=>isFinite(la) && isFinite(lo) && Math.abs(la)<=90 && Math.abs(lo)<=180;
function mgParseRoute(text){
  text=String(text||''); const out=[];
  if(/<gpx|<trkpt|<rtept|<wpt/i.test(text)){
    const re=/<(trkpt|rtept|wpt)\b([^>]*)>([\s\S]*?)<\/\1>|<(trkpt|rtept|wpt)\b([^>]*)\/>/gi; let m;
    while((m=re.exec(text))){
      const at=m[2]!==undefined ? m[2] : m[5], body=m[3]||'';
      const la=/lat\s*=\s*["']([-\d.eE+]+)["']/.exec(at), lo=/lon\s*=\s*["']([-\d.eE+]+)["']/.exec(at), el=/<ele>\s*([-\d.eE+]+)\s*<\/ele>/.exec(body);
      if(la && lo && mgOk(+la[1],+lo[1])) out.push({lat:+la[1],lon:+lo[1],alt:el ? +el[1] : null});
    }
    return out;
  }
  const km=/<coordinates>([\s\S]*?)<\/coordinates>/gi; let k, any=false;
  while((k=km.exec(text))){ any=true; for(const t of k[1].trim().split(/\s+/)){ const q=t.split(',').map(Number); if(q.length>=2 && mgOk(q[1],q[0])) out.push({lat:q[1],lon:q[0],alt:isFinite(q[2]) && q.length>2 ? q[2] : null}); } }
  if(any) return out;
  for(const line of text.split('\n')){
    const l=line.replace(/#.*$|\/\/.*$/,'').trim(); if(!l) continue;
    const q=l.split(/[\s,;]+/).map(Number);
    if(q.length>=2 && mgOk(q[0],q[1])) out.push({lat:q[0],lon:q[1],alt:q.length>2 && isFinite(q[2]) ? q[2] : null});
  }
  return out;
}
function mgRoute(pts){
  const cum=[0];
  for(let i=1;i<pts.length;i++) cum.push(cum[i-1]+mgDist(pts[i-1],pts[i]));
  return {pts,cum,total:cum[cum.length-1]||0};
}
// s — пройденный путь, м; mode: loop (по кругу), pingpong (туда-обратно), stop (встать в конце)
function mgAt(r,s,mode){
  const n=r.pts.length;
  if(!n) return null;
  if(n===1 || r.total<=0) return {lat:r.pts[0].lat,lon:r.pts[0].lon,alt:r.pts[0].alt,bearing:0,done:true};
  let d=s, back=false, done=false;
  if(mode==='loop'){ d=((s%r.total)+r.total)%r.total; }
  else if(mode==='pingpong'){ const p=((s%(2*r.total))+2*r.total)%(2*r.total); if(p>r.total){ d=2*r.total-p; back=true; } else d=p; }
  else if(s>=r.total){ d=r.total; done=true; } else if(s<0) d=0;
  let i=1; while(i<n-1 && r.cum[i]<d) i++;
  const a=r.pts[i-1], b=r.pts[i], seg=r.cum[i]-r.cum[i-1], f=seg>0 ? (d-r.cum[i-1])/seg : 0;
  const lat=a.lat+(b.lat-a.lat)*f, lon=a.lon+(b.lon-a.lon)*f;                // на отрезках в десятки километров погрешность линейной интерполяции несущественна
  const alt=a.alt!=null && b.alt!=null ? a.alt+(b.alt-a.alt)*f : (a.alt!=null ? a.alt : b.alt);
  let br=mgBearing(a,b); if(back) br=(br+180)%360;
  return {lat,lon,alt,bearing:br,done};
}
