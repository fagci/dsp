"use strict";
/* ============================ Plan Editor: мастер «новый дом» ============================
   peBuildHouse({w,d,floors,layout,roof,angle,h,t,mat,slab,over}) → новая сцена: прямоугольный дом w × d м, этажи (копия нижнего), планировка (одна комната, две, три, четыре),
   наружные стены заданной толщины и материала, окна по наружным стенам, входная дверь, межкомнатные двери (каждая комната достижима из гостиной), перекрытия, кровля
   (gable — двускатная, hip — вальмовая, shed — односкатная, none). Дальше сцена правится руками; расчёты (климат, нагрузки, лист) читают её как любую другую.
   Грузится после planedit-kernels.js, hvac-kernels.js (peAddRectRoom, peCopyLevel, peEnsureLevel, hvRoomUse). Ядро чистое: node tools/test-wizard.mjs */

const PW_LAYOUTS={'one room':1,'two rooms':2,'three rooms':3,'four rooms':4};
const PW_ROOFS=['none','gable','hip','shed'];

function pwArea3(P){ let nx=0,ny=0,nz=0; for(let i=0;i<P.length;i++){ const p=P[i], q=P[(i+1)%P.length]; nx+=(p[1]-q[1])*(p[2]+q[2]); ny+=(p[2]-q[2])*(p[0]+q[0]); nz+=(p[0]-q[0])*(p[1]+q[1]); } return Math.hypot(nx,ny,nz)/2; }
// комнаты: прямоугольники [имя, x, y, w, d] по числу комнат
function pwRooms(W,D,n){
  if(n<=1) return [['Living',0,0,W,D]];
  const wl=Math.round(W*.6*10)/10;
  if(n===2) return [['Living',0,0,wl,D],['Kitchen',wl,0,W-wl,D]];
  if(n===3){ const dk=Math.round(D*.6*10)/10; return [['Living',0,0,wl,D],['Kitchen',wl,0,W-wl,dk],['Bath',wl,dk,W-wl,D-dk]]; }
  const dl=Math.round(D*.6*10)/10, dk=Math.round(D*.55*10)/10; return [['Living',0,0,wl,dl],['Bedroom',0,dl,wl,D-dl],['Kitchen',wl,0,W-wl,dk],['Bath',wl,dk,W-wl,D-dk]];
}
// комнаты по обе стороны стены (индексы в s.rooms этажа lv)
function pwSides(s,w,lv){ const [a,b]=peWallEnds(s,w), L=Math.hypot(b.x-a.x,b.y-a.y), ux=(b.x-a.x)/L, uy=(b.y-a.y)/L, mx=(a.x+b.x)/2, my=(a.y+b.y)/2, off=(w.t||.2)/2+.15, rs=s.rooms.filter(r=>(r.lv||0)===lv), out=[];
  for(const sg of [1,-1]){ const r=rs.find(r=>peInPoly(peRoomPoly(s,r),mx-uy*off*sg,my+ux*off*sg)); out.push(r||null); } return out; }

function pwRoof(s,o){ const {W,D,zTop,type,angle,over,mat}=o; if(type==='none'||!PW_ROOFS.includes(type)) return; const ta=Math.tan(angle*Math.PI/180), ov=over, zE=zTop-ov*ta, F=[];
  const along=W>=D, L=along ? W : D, Wd=along ? D : W;              // L — длинная сторона, Wd — короткая; строим для along и поворачиваем (x↔y)
  const P=(x,y,z)=>along ? [x,y,z] : [y,x,z];
  if(type==='gable'){ const zR=zTop+Wd/2*ta;
    F.push({kind:'roof',pts:[P(-ov,-ov,zE),P(L+ov,-ov,zE),P(L+ov,Wd/2,zR),P(-ov,Wd/2,zR)]},{kind:'roof',pts:[P(-ov,Wd+ov,zE),P(L+ov,Wd+ov,zE),P(L+ov,Wd/2,zR),P(-ov,Wd/2,zR)]},
      {kind:'gable',pts:[P(0,0,zTop),P(0,Wd,zTop),P(0,Wd/2,zR)]},{kind:'gable',pts:[P(L,0,zTop),P(L,Wd,zTop),P(L,Wd/2,zR)]});
    s.roofs.push({type,angle,faces:F,ridge:zR,eave:zE,wallMat:mat}); }
  else if(type==='hip'){ const zR=zTop+Wd/2*ta, r0=Wd/2, r1=L-Wd/2;
    F.push({kind:'roof',pts:[P(-ov,-ov,zE),P(L+ov,-ov,zE),P(r1,Wd/2,zR),P(r0,Wd/2,zR)]},{kind:'roof',pts:[P(L+ov,Wd+ov,zE),P(-ov,Wd+ov,zE),P(r0,Wd/2,zR),P(r1,Wd/2,zR)]},
      {kind:'roof',pts:[P(-ov,Wd+ov,zE),P(-ov,-ov,zE),P(r0,Wd/2,zR)]},{kind:'roof',pts:[P(L+ov,-ov,zE),P(L+ov,Wd+ov,zE),P(r1,Wd/2,zR)]});
    s.roofs.push({type,angle,faces:F,ridge:zR,eave:zE,wallMat:mat}); }
  else { const zR=zE+(Wd+2*ov)*ta;                                    // shed: один скат вдоль короткой стороны
    F.push({kind:'roof',pts:[P(-ov,-ov,zE),P(L+ov,-ov,zE),P(L+ov,Wd+ov,zR),P(-ov,Wd+ov,zR)]},{kind:'gable',pts:[P(0,0,zTop),P(0,Wd,zTop),P(0,Wd,zTop+Wd*ta)]},{kind:'gable',pts:[P(L,0,zTop),P(L,Wd,zTop),P(L,Wd,zTop+Wd*ta)]});
    s.roofs.push({type,angle,faces:F,ridge:zR,eave:zE,wallMat:mat}); }
  const r=s.roofs[s.roofs.length-1]; r.area=r.faces.filter(f=>f.kind==='roof').reduce((q,f)=>q+pwArea3(f.pts),0); }

function peBuildHouse(o={}){
  const W=Math.max(3,Math.min(60,+o.w||10)), D=Math.max(3,Math.min(60,+o.d||8)), F=Math.max(1,Math.min(4,Math.round(+o.floors||1))), h=+o.h>0 ? +o.h : 2.7, t=+o.t>0 ? +o.t : .4, mat=o.mat||'brick', slab=+o.slab>0 ? +o.slab : .22;
  const n=PW_LAYOUTS[o.layout]||(+o.layout>0 ? +o.layout : 3), s=peNew(), opt={t,h,mat};
  for(const [name,x,y,w,d] of pwRooms(W,D,n)) peAddRectRoom(s,x,y,w,d,{...opt,name});
  const rooms=s.rooms.slice(), living=rooms[0], connected=new Set([living.id]), doors=[], walls=s.walls.slice();
  // окна и входная дверь по наружным стенам, двери между комнатами (BFS от гостиной)
  let entrance=false; const outer=[], inner=[];
  for(const w of walls){ const [A,B]=pwSides(s,w,0), L=peWallLen(s,w); if(!!A!==!!B) outer.push({w,r:A||B,L}); else if(A&&B&&A!==B) inner.push({w,A,B,L}); }
  const south=outer.filter(q=>q.r===living && Math.abs(peWallEnds(s,q.w)[0].y-peWallEnds(s,q.w)[1].y)<1e-6 && peWallEnds(s,q.w)[0].y<1e-6).sort((a,b)=>b.L-a.L)[0]||outer.filter(q=>q.r===living).sort((a,b)=>b.L-a.L)[0];
  for(const q of outer){ const bath=hvRoomUse(q.r)==='bath';
    if(q===south && q.L>=1.6){ peAddObj(s,'door',{wall:q.w.id,u:.2,w:.9,h:2.05,sill:0}); entrance=true; if(q.L>=3.4) peAddObj(s,'window',{wall:q.w.id,u:.68,w:1.5,h:1.4,sill:.9}); continue; }
    if(bath){ if(q.L>=1.2) peAddObj(s,'window',{wall:q.w.id,u:.5,w:.6,h:.6,sill:1.4}); continue; }
    if(q.L>=2) peAddObj(s,'window',{wall:q.w.id,u:.5,w:Math.min(1.5,q.L-.8),h:1.4,sill:.9}); }
  for(let g=0;g<8 && connected.size<rooms.length;g++) for(const q of inner.sort((a,b)=>b.L-a.L)){ const ca=connected.has(q.A.id), cb=connected.has(q.B.id); if(ca===cb||q.L<1.3) continue; const door=peAddObj(s,'door',{wall:q.w.id,u:.5,w:.9,h:2.05,sill:0}); connected.add(q.A.id); connected.add(q.B.id); break; }
  // этажи: копия нижнего; на верхних — спальни, без входной двери
  for(let i=1;i<F;i++){ peCopyLevel(s,0,i,h); }
  for(const r of s.rooms.filter(r=>(r.lv||0)>0)){ const u=hvRoomUse({name:r.name,use:r.use}); if(u!=='bath'){ r.use='bedroom'; r.name='Bedroom '+r.lv+(rooms.length>1 ? '.'+(s.rooms.filter(q=>q.lv===r.lv&&q.use==='bedroom').length) : ''); } else r.name='Bath '+r.lv; }
  for(const ob of s.objs.slice()){ if(ob.type!=='door') continue; const w=peWall(s,ob.wall); if(w && (w.lv||0)>0){ const [A,B]=pwSides(s,w,w.lv||0); if(!!A!==!!B) s.objs=s.objs.filter(q=>q!==ob); } }
  const zTop=(F>1 ? peEnsureLevel(s,F-1,h).z : 0)+h;
  for(let i=1;i<F;i++){ const L=peEnsureLevel(s,i,h); s.slabs.push({lv:i,z:L.z,t:slab,mat:'concrete',poly:[[0,0],[W,0],[W,D],[0,D]]}); }
  pwRoof(s,{W,D,zTop,type:o.roof||'gable',angle:+o.angle>0 ? +o.angle : 30,over:o.over>=0 ? +o.over : .5,mat});
  return s; }
