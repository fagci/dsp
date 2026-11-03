"use strict";
/* ============================ Room Walk: ядро ============================
   Комната по замерам «азимут + расстояние до стены» из одной точки: телефон повёрнут лицом к стене (Echo Ranger даёт расстояние, компас — азимут).
   Стена k — прямая n·p = d, где n = (sin θ, cos θ) (восток, север), d — расстояние от точки до стены по нормали. Угол комнаты — пересечение соседних стен
   (по азимуту). Для прямоугольной комнаты азимуты можно «прижать» к общему углу φ + 90°·m — компас шумит, а стены ровные.
   Ядро чистое, без DOM: node tools/test-roomwalk.mjs */

const RW_D=Math.PI/180;
const rwWrap=a=>((a%360)+360)%360;
const rwDiff=(a,b)=>{ const d=Math.abs(rwWrap(a)-rwWrap(b)); return d>180 ? 360-d : d; };
// «az d» по строке (запятая — десятичная; # — комментарий): [{az,d}]
function rwParse(text){
  const out=[], bad=[];
  String(text||'').split('\n').forEach((raw,i)=>{
    const l=raw.replace(/#.*/,'').trim(); if(!l) return;
    const t=l.replace(/(\d),(\d)/g,'$1.$2').split(/[\s;]+/).map(Number);
    if(t.length>=2 && isFinite(t[0]) && isFinite(t[1]) && t[1]>0) out.push({az:rwWrap(t[0]),d:t[1]}); else bad.push({line:i+1,text:l});
  });
  return {shots:out,bad};
}
// повторные замеры одной стены (азимут в пределах merge°) — в одну: круговое среднее азимутов, среднее расстояний, n — число замеров
function rwMerge(shots,merge=20){
  const S=shots.slice().sort((a,b)=>a.az-b.az), groups=[];
  for(const s of S){ const g=groups.find(g=>rwDiff(g.az,s.az)<=merge); if(g){ g.m.push(s); g.az=rwMean(g.m.map(x=>x.az)); } else groups.push({az:s.az,m:[s]}); }
  return groups.map(g=>({az:rwMean(g.m.map(x=>x.az)),d:g.m.reduce((a,x)=>a+x.d,0)/g.m.length,n:g.m.length})).sort((a,b)=>a.az-b.az);
}
function rwMean(az){ let s=0,c=0; for(const a of az){ s+=Math.sin(a*RW_D); c+=Math.cos(a*RW_D); } return rwWrap(Math.atan2(s,c)/RW_D); }
// общий угол прямоугольной комнаты: φ из четвёртой гармоники азимутов (стены через 90° дают один и тот же φ)
function rwOrient(shots){ let s=0,c=0; for(const x of shots){ s+=Math.sin(4*x.az*RW_D); c+=Math.cos(4*x.az*RW_D); } return rwWrap(Math.atan2(s,c)/RW_D/4); }
// решение: walls — слитые стены, corners — углы по порядку азимутов, area, ориентация. opt.rect — прижать азимуты к φ + 90°·m
function rwSolve(shots,opt={}){
  let w=rwMerge(shots,opt.merge||20), phi=null;
  if(opt.rect && w.length>=2){
    phi=rwOrient(w);
    const sn=w.map(x=>({az:rwWrap(phi+90*Math.round(rwWrap(x.az-phi+180)/90-2)),d:x.d,n:x.n}));
    // одинаковые после прижатия — слить (взвесить по n)
    const g=new Map(); for(const x of sn){ const k=Math.round(x.az); const e=g.get(k); if(e){ e.d=(e.d*e.n+x.d*x.n)/(e.n+x.n); e.n+=x.n; } else g.set(k,{...x}); }
    w=[...g.values()].sort((a,b)=>a.az-b.az);
  }
  const out={walls:w,corners:[],area:0,perimeter:0,phi,open:[],ok:false};
  if(w.length<3) return out;
  for(let i=0;i<w.length;i++){
    const a=w[i], b=w[(i+1)%w.length], ta=a.az*RW_D, tb=b.az*RW_D, det=Math.sin(ta-tb);
    if(Math.abs(det)<.2){ out.open.push([i,(i+1)%w.length]); continue; }                     // стены почти параллельны — угла нет
    const x=(a.d*Math.cos(tb)-b.d*Math.cos(ta))/det, y=(b.d*Math.sin(ta)-a.d*Math.sin(tb))/det;
    out.corners.push({x,y,between:[i,(i+1)%w.length]});
  }
  if(out.open.length || out.corners.length<3) return out;
  let a2=0, per=0; const C=out.corners;
  for(let i=0;i<C.length;i++){ const p=C[i], q=C[(i+1)%C.length]; a2+=p.x*q.y-q.x*p.y; per+=Math.hypot(q.x-p.x,q.y-p.y); }
  out.area=Math.abs(a2)/2; out.perimeter=per; out.ok=true;
  // точка стояния внутри? (иначе азимуты или расстояния перепутаны)
  out.inside=rwInside(C,0,0);
  return out;
}
function rwInside(P,x,y){ let c=false; for(let i=0,j=P.length-1;i<P.length;j=i++) if((P[i].y>y)!==(P[j].y>y) && x<(P[j].x-P[i].x)*(y-P[i].y)/(P[j].y-P[i].y)+P[i].x) c=!c; return c; }
// погрешность угла, м: расстояние и азимут (°): σ² = σd² + (d·σaz)²
const rwSigma=(d,sd,saz)=>Math.hypot(sd,d*saz*RW_D);
// строки для Site Plan: стояние O, углы «R1 at x y ± σ», контур. name — префикс углов
function rwLines(R,o={}){
  if(!R.ok) return '';
  const f=v=>String(+v.toFixed(3)), pre=(o.prefix||'R').replace(/[\s-]+/g,'_'), sd=o.sd>0 ? o.sd : .03, saz=o.saz>0 ? o.saz : 3;
  const dm=R.walls.reduce((a,w)=>a+w.d,0)/R.walls.length, s=rwSigma(dm,sd,saz), L=[];
  R.corners.forEach((c,i)=>L.push(pre+(i+1)+' at '+f(c.x)+' '+f(c.y)+' ± '+f(s)));
  L.push('poly '+R.corners.map((_,i)=>pre+(i+1)).join(' '));
  return L.join('\n');
}
