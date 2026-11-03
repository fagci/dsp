"use strict";
/* ============================ Plan Editor: ядро ============================
   Сцена плана: точки (x, y — метры, восток / север), стены между ними (толщина, высота, материал, фиксированная длина), проёмы (двери, окна — доля вдоль стены),
   примитивы (ящик, колонна), комнаты (замкнутые контуры точек), камеры (положение, высота, азимут, наклон, угол обзора, дальность) и антенны (положение, высота,
   азимут, ширина луча, EIRP, частота). Расчёты: перетаскивание точки с сохранением длин зафиксированных стен (итерации по ограничениям), видимость камер с
   тенями от стен, уровень сигнала антенн с потерями на стенах, охват и «слепые зоны». Ядро чистое, без DOM: node tools/test-planedit.mjs */

const PE_D=Math.PI/180;
// затухание стены, дБ на 10 см толщины: уровень сигнала на пути через стену = мат × толщина / 0,1 м
const PE_MAT={brick:4,concrete:6,drywall:1.5,wood:2,glass:1,metal:20};
const PE_OPEN_LOSS={door:3,window:2};                          // проём: тонкая дверь / стекло, дБ
const PE_TYPES=['box','column','door','window'];               // примитивы (door / window — проёмы в стене)
const peWrap180=a=>((a+180)%360+360)%360-180;
const peWrap360=a=>((a%360)+360)%360;

function peNew(){ return {pts:[],walls:[],objs:[],cams:[],ants:[],rooms:[],seq:1}; }
function peId(s,p){ return p+(s.seq++); }
const pePt=(s,id)=>s.pts.find(p=>p.id===id);
function peAddPoint(s,x,y){ const p={id:peId(s,'p'),x,y}; s.pts.push(p); return p; }
function peAddWall(s,a,b,o={}){
  if(a===b) return null;
  let w=s.walls.find(w=>(w.a===a&&w.b===b)||(w.a===b&&w.b===a)); if(w) return w;
  w={id:peId(s,'w'),a,b,t:o.t??.2,h:o.h??2.7,mat:o.mat||'brick',len:0}; s.walls.push(w); return w;
}
const peWall=(s,id)=>s.walls.find(w=>w.id===id);
function peWallEnds(s,w){ const a=pePt(s,w.a), b=pePt(s,w.b); return [a,b]; }
function peWallLen(s,w){ const [a,b]=peWallEnds(s,w); return Math.hypot(b.x-a.x,b.y-a.y); }
function peDelWall(s,id){
  s.walls=s.walls.filter(w=>w.id!==id); s.objs=s.objs.filter(o=>o.wall!==id);
  s.rooms=s.rooms.filter(r=>r.pts.every((p,i)=>s.walls.some(w=>(w.a===p&&w.b===r.pts[(i+1)%r.pts.length])||(w.b===p&&w.a===r.pts[(i+1)%r.pts.length]))));
}
function peDelPoint(s,id){ for(const w of s.walls.filter(w=>w.a===id||w.b===id)) peDelWall(s,w.id); s.pts=s.pts.filter(p=>p.id!==id); }
function peDel(s,kind,id){
  if(kind==='pt') peDelPoint(s,id); else if(kind==='wall') peDelWall(s,id);
  else if(kind==='obj') s.objs=s.objs.filter(o=>o.id!==id); else if(kind==='cam') s.cams=s.cams.filter(o=>o.id!==id); else if(kind==='ant') s.ants=s.ants.filter(o=>o.id!==id);
  else if(kind==='room') s.rooms=s.rooms.filter(o=>o.id!==id);
}
// проём / примитив
function peAddObj(s,type,o){
  const base={box:{w:1,d:.6,h:.8,rot:0},column:{w:.3,d:.3,h:2.7,rot:0},door:{w:.9,h:2.05,sill:0,u:.5},window:{w:1.2,h:1.2,sill:.9,u:.5}}[type]; if(!base) return null;
  const ob={id:peId(s,'o'),type,x:0,y:0,z:0,name:'',...base,...o}; s.objs.push(ob); return ob;
}
function peAddCam(s,x,y,o={}){ const c={id:peId(s,'c'),name:'Cam'+(s.cams.length+1),x,y,z:2.6,az:0,tilt:25,fov:90,range:12,...o}; s.cams.push(c); return c; }
function peAddAnt(s,x,y,o={}){ const a={id:peId(s,'a'),name:'AP'+(s.ants.length+1),x,y,z:2.4,az:0,bw:360,eirp:20,f:2437,...o}; s.ants.push(a); return a; }
// комната по замкнутой цепочке точек (id); площадь — по формуле шнурования
function peAddRoom(s,ids,name){ const r={id:peId(s,'r'),pts:ids.slice(),name:name||'Room'+(s.rooms.length+1)}; s.rooms.push(r); return r; }
function peRoomArea(s,r){ let a=0; for(let i=0;i<r.pts.length;i++){ const p=pePt(s,r.pts[i]), q=pePt(s,r.pts[(i+1)%r.pts.length]); a+=p.x*q.y-q.x*p.y; } return Math.abs(a)/2; }
function peRoomPoly(s,r){ return r.pts.map(id=>{ const p=pePt(s,id); return [p.x,p.y]; }); }
function peInPoly(P,x,y){ let c=false; for(let i=0,j=P.length-1;i<P.length;j=i++) if((P[i][1]>y)!==(P[j][1]>y) && x<(P[j][0]-P[i][0])*(y-P[i][1])/(P[j][1]-P[i][1])+P[i][0]) c=!c; return c; }
function peInRooms(s,x,y){ for(const r of s.rooms) if(peInPoly(peRoomPoly(s,r),x,y)) return true; return false; }

// ---------- перетаскивание точки с сохранением длин ----------
// Итерации по ограничениям (position-based): точка id идёт за курсором, остальные подтягиваются так, чтобы зафиксированные стены (w.len > 0) сохранили длину.
// Возвращает наибольшую невязку, м.
function peDrag(s,id,x,y,iters=40){
  const p=pePt(s,id); if(!p) return 0; p.x=x; p.y=y;
  const lk=s.walls.filter(w=>w.len>0); if(!lk.length) return 0;
  let err=0;
  for(let it=0;it<iters;it++){
    err=0;
    for(const w of lk){
      const a=pePt(s,w.a), b=pePt(s,w.b), dx=b.x-a.x, dy=b.y-a.y, d=Math.hypot(dx,dy)||1e-9, diff=(d-w.len)/d;
      err=Math.max(err,Math.abs(d-w.len));
      const wa=w.a===id ? 0 : (a.fix ? 0 : 1), wb=w.b===id ? 0 : (b.fix ? 0 : 1), sw=wa+wb; if(!sw) continue;
      a.x+=dx*diff*wa/sw; a.y+=dy*diff*wa/sw; b.x-=dx*diff*wb/sw; b.y-=dy*diff*wb/sw;
    }
    if(err<1e-6) break;
  }
  return err;
}
// зафиксировать / отпустить длину стены (len — число, 0 — отпустить; без аргумента — переключить по текущей длине)
function peLock(s,wid,len){ const w=peWall(s,wid); if(!w) return; w.len=len===undefined ? (w.len>0 ? 0 : +peWallLen(s,w).toFixed(4)) : len; return w.len; }
// установить длину стены точно: сдвигаем второй конец (a остаётся) и подтягиваем соседей с зафиксированными длинами
function peSetLen(s,wid,len){ const w=peWall(s,wid); if(!w||!(len>0)) return; const a=pePt(s,w.a), b=pePt(s,w.b), d=Math.hypot(b.x-a.x,b.y-a.y)||1e-9;
  const was=w.len; w.len=0; peDrag(s,w.b,a.x+(b.x-a.x)*len/d,a.y+(b.y-a.y)*len/d); w.len=was>0 ? len : 0; }

// ---------- геометрия стен ----------
// стена → сплошные отрезки вдоль оси [s0,s1] и проёмы (по их u — доле длины; w — ширина; sill, h — высоты)
function peWallParts(s,w){
  const L=peWallLen(s,w), ops=s.objs.filter(o=>o.wall===w.id && (o.type==='door'||o.type==='window')).map(o=>({id:o.id,kind:o.type,s0:Math.max(0,o.u*L-o.w/2),s1:Math.min(L,o.u*L+o.w/2),sill:o.sill,h:o.h})).sort((a,b)=>a.s0-b.s0);
  const solid=[]; let c=0; for(const o of ops){ if(o.s0>c+1e-6) solid.push([c,o.s0]); c=Math.max(c,o.s1); } if(c<L-1e-6) solid.push([c,L]);
  return {L,solid,open:ops};
}
// ориентированные параллелепипеды для 3D: {cx,cy,ux,uy,l,t,z0,z1,kind,ref}; l — вдоль (ux,uy), t — поперёк
function peBoxes(s){
  const out=[];
  for(const w of s.walls){
    const [a,b]=peWallEnds(s,w), P=peWallParts(s,w), ux=(b.x-a.x)/(P.L||1), uy=(b.y-a.y)/(P.L||1);
    const add=(s0,s1,z0,z1,kind)=>{ if(s1-s0<1e-6||z1-z0<1e-6) return; const m=(s0+s1)/2; out.push({cx:a.x+ux*m,cy:a.y+uy*m,ux,uy,l:s1-s0,t:w.t,z0,z1,kind,ref:w.id}); };
    for(const [s0,s1] of P.solid) add(s0,s1,0,w.h,'wall');
    for(const o of P.open){ if(o.sill>0) add(o.s0,o.s1,0,o.sill,'wall'); add(o.s0,o.s1,Math.min(w.h,o.sill+o.h),w.h,'wall'); }
  }
  for(const o of s.objs){
    if(o.type==='box'){ const r=o.rot*PE_D; out.push({cx:o.x,cy:o.y,ux:Math.sin(r),uy:Math.cos(r),l:o.w,t:o.d,z0:o.z||0,z1:(o.z||0)+o.h,kind:'box',ref:o.id}); }
    else if(o.type==='column') out.push({cx:o.x,cy:o.y,ux:0,uy:1,l:o.d,t:o.w,z0:o.z||0,z1:(o.z||0)+o.h,kind:'column',ref:o.id});
  }
  return out;
}
// положение проёма в плане: центр и вдоль-вектор (для рисования)
function peOpenPlace(s,o){ const w=peWall(s,o.wall); if(!w) return null; const [a,b]=peWallEnds(s,w), L=Math.hypot(b.x-a.x,b.y-a.y)||1; return {x:a.x+(b.x-a.x)*o.u,y:a.y+(b.y-a.y)*o.u,ux:(b.x-a.x)/L,uy:(b.y-a.y)/L,t:w.t,L}; }
// ближайшая стена к точке: {wall,u,d,x,y} (u — доля, x,y — проекция)
function peNearestWall(s,x,y){
  let best=null;
  for(const w of s.walls){ const [a,b]=peWallEnds(s,w), dx=b.x-a.x, dy=b.y-a.y, L2=dx*dx+dy*dy||1e-12, u=Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/L2)), px=a.x+dx*u, py=a.y+dy*u, d=Math.hypot(x-px,y-py); if(!best||d<best.d) best={wall:w,u,d,x:px,y:py}; }
  return best;
}

// ---------- препятствия и пересечения ----------
// отрезки-препятствия [x0,y0,x1,y1]: сплошные части стен и габариты ящиков / колонн выше minH
function peOccluders(s,minH=1.2){
  const o=[];
  for(const w of s.walls){ const [a,b]=peWallEnds(s,w), P=peWallParts(s,w), ux=(b.x-a.x)/(P.L||1), uy=(b.y-a.y)/(P.L||1); for(const [s0,s1] of P.solid) o.push([a.x+ux*s0,a.y+uy*s0,a.x+ux*s1,a.y+uy*s1,w.id]); }
  for(const b of peBoxes(s)){ if(b.kind==='wall' || b.z1<minH) continue; const nx=-b.uy, ny=b.ux, h=b.l/2, q=b.t/2, C=[[b.cx+b.ux*h+nx*q,b.cy+b.uy*h+ny*q],[b.cx+b.ux*h-nx*q,b.cy+b.uy*h-ny*q],[b.cx-b.ux*h-nx*q,b.cy-b.uy*h-ny*q],[b.cx-b.ux*h+nx*q,b.cy-b.uy*h+ny*q]]; for(let i=0;i<4;i++) o.push([C[i][0],C[i][1],C[(i+1)%4][0],C[(i+1)%4][1],b.ref]); }
  return o;
}
// пересечение отрезка p→q с отрезком e; возвращает параметр t по p→q или -1
function peSegT(px,py,qx,qy,e){
  const rx=qx-px, ry=qy-py, sx=e[2]-e[0], sy=e[3]-e[1], den=rx*sy-ry*sx; if(Math.abs(den)<1e-12) return -1;
  const t=((e[0]-px)*sy-(e[1]-py)*sx)/den, u=((e[0]-px)*ry-(e[1]-py)*rx)/den; return t>=0&&t<=1&&u>=0&&u<=1 ? t : -1;
}
// есть ли на пути p→q препятствие (пересечения ближе skip метров к p не считаются — камера на стене)
function peBlocked(occ,px,py,qx,qy,skip=.15){ const L=Math.hypot(qx-px,qy-py)||1; for(const e of occ){ const t=peSegT(px,py,qx,qy,e); if(t>=0 && t*L>skip) return true; } return false; }

// ---------- камеры ----------
// видна ли точка (x, y) на высоте zt (по умолчанию 1 м — торс человека): угол по азимуту, дальность, вертикальный угол (наклон вниз tilt, поле fov·0,5625), линия видимости
function peSees(c,x,y,occ,zt=1){
  const dx=x-c.x, dy=y-c.y, d=Math.hypot(dx,dy); if(d>c.range) return false; if(d<.05) return false;
  if(Math.abs(peWrap180(Math.atan2(dx,dy)/PE_D-c.az))>c.fov/2) return false;
  const dep=Math.atan2(c.z-zt,d)/PE_D, v=c.fov*.5625;                                        // угол вниз до цели; допустимо tilt ± v/2
  if(dep<c.tilt-v/2 || dep>c.tilt+v/2) return false;
  return !peBlocked(occ,c.x,c.y,x,y);
}
// многоугольник видимости на уровне пола в секторе камеры (для рисования): веер лучей с тенями от стен; дальность ограничена range
function peVisPoly(c,occ,stepDeg=1){
  const P=[[c.x,c.y]]; for(let a=-c.fov/2;a<=c.fov/2+1e-9;a+=stepDeg){
    const ang=(c.az+a)*PE_D, dx=Math.sin(ang), dy=Math.cos(ang); let t=c.range;
    for(const e of occ){ const h=peSegT(c.x,c.y,c.x+dx*c.range,c.y+dy*c.range,e); if(h>=0 && h*c.range>.15 && h*c.range<t) t=h*c.range; }
    P.push([c.x+dx*t,c.y+dy*t]);
  }
  return P;
}

// ---------- антенны ----------
function peFspl(d,fMHz){ return 20*Math.log10(Math.max(d,1))+20*Math.log10(fMHz)-27.55; }
function peAntGain(a,dx,dy){ if(!(a.bw<360)) return 0; const off=Math.abs(peWrap180(Math.atan2(dx,dy)/PE_D-a.az)); return -Math.min(25,12*Math.pow(off/Math.max(1,a.bw),2)); }
// потери на стенах по пути a→(x,y), дБ: пересечение оси стены = материал × толщина / 10 см; проём — потери проёма
function peWallLoss(s,ax,ay,x,y){
  let loss=0;
  for(const w of s.walls){
    const [p,q]=peWallEnds(s,w), t=peSegT(ax,ay,x,y,[p.x,p.y,q.x,q.y]); if(t<0) continue;
    const hx=ax+(x-ax)*t, hy=ay+(y-ay)*t, L=Math.hypot(q.x-p.x,q.y-p.y)||1, u=Math.hypot(hx-p.x,hy-p.y)/L; let open=null;
    for(const o of s.objs) if(o.wall===w.id && (o.type==='door'||o.type==='window') && Math.abs(u-o.u)*L<=o.w/2) open=o;
    loss+=open ? PE_OPEN_LOSS[open.type] : (PE_MAT[w.mat]??4)*w.t/.1;
  }
  return loss;
}
// уровень сигнала антенны в точке, дБм (приёмник на высоте zr)
function peAntLevel(s,a,x,y,zr=1){
  const dx=x-a.x, dy=y-a.y, d3=Math.hypot(dx,dy,a.z-zr);
  return a.eirp+peAntGain(a,dx,dy)-peFspl(d3,a.f)-peWallLoss(s,a.x,a.y,x,y);
}

// ---------- сетка охвата ----------
function peBounds(s,margin=1){ let x0=1e99,x1=-1e99,y0=1e99,y1=-1e99; const A=[...s.pts,...s.cams,...s.ants,...s.objs.filter(o=>o.type==='box'||o.type==='column')]; for(const p of A){ x0=Math.min(x0,p.x); x1=Math.max(x1,p.x); y0=Math.min(y0,p.y); y1=Math.max(y1,p.y); } return x0<=x1 ? {x0:x0-margin,x1:x1+margin,y0:y0-margin,y1:y1+margin} : null; }
function peGrid(s,cell=.25,maxN=160){ const b=peBounds(s,.5); if(!b) return null; const span=Math.max(b.x1-b.x0,b.y1-b.y0), c=Math.max(cell,span/maxN), nx=Math.ceil((b.x1-b.x0)/c), ny=Math.ceil((b.y1-b.y0)/c); return {x0:b.x0,y0:b.y0,cell:c,nx,ny}; }
// охват камер: count — сколько камер видит клетку; stats по клеткам внутри комнат (если комнат нет — по всей рамке)
function peCamCoverage(s,g,zt=1){
  g=g||peGrid(s); if(!g) return null;
  const occ=peOccluders(s), count=new Uint8Array(g.nx*g.ny), inside=new Uint8Array(g.nx*g.ny), useRooms=s.rooms.length>0;
  const polys=s.rooms.map(r=>peRoomPoly(s,r)); let tot=0, seen=0, multi=0;
  for(let j=0;j<g.ny;j++) for(let i=0;i<g.nx;i++){
    const x=g.x0+(i+.5)*g.cell, y=g.y0+(j+.5)*g.cell, k=j*g.nx+i;
    const inn=useRooms ? polys.some(P=>peInPoly(P,x,y)) : true; inside[k]=inn ? 1 : 0;
    let n=0; for(const c of s.cams) if(peSees(c,x,y,occ,zt)) n++; count[k]=n;
    if(inn){ tot++; if(n>0) seen++; if(n>1) multi++; }
  }
  const a=g.cell*g.cell; return {g,count,inside,total:tot*a,seen:seen*a,multi:multi*a,cover:tot ? seen/tot : 0};
}
// уровень сигнала по сетке: лучший из антенн, дБм (по ids — только выбранные); статистика по клеткам внутри комнат
function peAntHeat(s,g,opt={}){
  g=g||peGrid(s); if(!g) return null;
  const ants=opt.id ? s.ants.filter(a=>a.id===opt.id) : s.ants, lvl=new Float32Array(g.nx*g.ny).fill(-200), polys=s.rooms.map(r=>peRoomPoly(s,r));
  const thr=opt.thr??-70; let tot=0, ok=0, sum=0, mn=1e9;
  for(let j=0;j<g.ny;j++) for(let i=0;i<g.nx;i++){
    const x=g.x0+(i+.5)*g.cell, y=g.y0+(j+.5)*g.cell; let best=-200; for(const a of ants){ const v=peAntLevel(s,a,x,y,opt.zr??1); if(v>best) best=v; } lvl[j*g.nx+i]=best;
    if(!polys.length || polys.some(P=>peInPoly(P,x,y))){ tot++; sum+=best; if(best>=thr) ok++; if(best<mn) mn=best; }
  }
  const a=g.cell*g.cell; return {g,lvl,thr,total:tot*a,good:ok*a,share:tot ? ok/tot : 0,mean:tot ? sum/tot : -200,min:tot ? mn : -200};
}

// ---------- экспорт ----------
// строки замеров для Site Plan: точки «name at x y», зафиксированные длины «A-B L ± 0.002», комнаты «poly …»; имена точек — по id ('p3' → P3) или своим name
function peLines(s){
  const nm=p=>String(p.name||p.id).replace(/[\s-]+/g,'_'), f=v=>String(+v.toFixed(3)), L=[];
  for(const p of s.pts) L.push(nm(p)+' at '+f(p.x)+' '+f(p.y)+' ± 0.01');
  for(const w of s.walls) if(w.len>0) L.push(nm(pePt(s,w.a))+'-'+nm(pePt(s,w.b))+' '+f(w.len)+' ± 0.002');
  for(const r of s.rooms) if(r.pts.length>=3) L.push('poly '+r.pts.map(id=>nm(pePt(s,id))).join(' '));
  return L.join('\n');
}
// точки из записей Site Plan (kind 'plan point': name, x, y, z) или любых (name, x, y): добавляет отсутствующие, существующие по имени двигает
function peImportPoints(s,recs){
  let n=0; for(const r of recs||[]){ const x=+r.x, y=+r.y, name=String(r.name??r.label??''); if(!name||!isFinite(x)||!isFinite(y)) continue;
    let p=s.pts.find(p=>p.name===name); if(p){ p.x=x; p.y=y; } else { p=peAddPoint(s,x,y); p.name=name; } n++; }
  return n;
}
function peParse(text){ try{ const o=JSON.parse(text); if(o && Array.isArray(o.pts)){ for(const k of ['walls','objs','cams','ants','rooms']) if(!Array.isArray(o[k])) o[k]=[]; if(!(o.seq>0)) o.seq=1000; return o; } }catch(e){} return peNew(); }

// ---------- привязка к земле (общее пространство с Video Overlay и Map) ----------
// o: {lat, lon, north, alt} — где точка (0, 0) плана, азимут оси +y плана от севера (по часовой, °) и высота пола над уровнем моря, м
const PE_R=6371008.8;
function peGeo(o,x,y){ const n=(o.north||0)*PE_D, e=x*Math.cos(n)+y*Math.sin(n), nn=-x*Math.sin(n)+y*Math.cos(n), k=PE_R*PE_D; return [o.lat+nn/k, o.lon+e/(k*Math.cos(o.lat*PE_D))]; }
function peLocal(o,lat,lon){ const k=PE_R*PE_D, e=(lon-o.lon)*k*Math.cos(o.lat*PE_D), nn=(lat-o.lat)*k, n=(o.north||0)*PE_D; return [e*Math.cos(n)-nn*Math.sin(n), e*Math.sin(n)+nn*Math.cos(n)]; }
const peAzTrue=(o,az)=>peWrap360(az+(o.north||0));            // азимут в плане → от истинного севера
const peAzPlan=(o,az)=>peWrap360(az-(o.north||0));
// записи для Video Overlay / Map / Table: стены, проёмы, ящики — каркасы path3 [lat, lon, alt_m]; камеры (с пирамидой обзора), антенны, точки — маркеры
function peOverlay(s,o){
  const out=[], P=(x,y,z)=>{ const g=peGeo(o,x,y); return [+g[0].toFixed(8),+g[1].toFixed(8),+((o.alt||0)+z).toFixed(2)]; };
  const loop=(id,label,color,pts)=>out.push({id,label,kind:'plan',color,path3:pts.map(q=>P(...q))});
  for(const w of s.walls){ const [a,b]=peWallEnds(s,w); loop('plan:'+w.id,'','#9fb0b6',[[a.x,a.y,0],[b.x,b.y,0],[b.x,b.y,w.h],[a.x,a.y,w.h],[a.x,a.y,0]]); }
  for(const ob of s.objs){
    if(ob.type==='door'||ob.type==='window'){ const q=peOpenPlace(s,ob); if(!q) continue; const h=ob.w/2; loop('plan:'+ob.id,ob.name||'',ob.type==='door' ? '#c9a06a' : '#6fd0ff',[[q.x-q.ux*h,q.y-q.uy*h,ob.sill],[q.x+q.ux*h,q.y+q.uy*h,ob.sill],[q.x+q.ux*h,q.y+q.uy*h,ob.sill+ob.h],[q.x-q.ux*h,q.y-q.uy*h,ob.sill+ob.h],[q.x-q.ux*h,q.y-q.uy*h,ob.sill]]); }
  }
  for(const b of peBoxes(s)){ if(b.kind==='wall') continue; const nx=-b.uy, ny=b.ux, h=b.l/2, q=b.t/2, C=[[b.cx+b.ux*h+nx*q,b.cy+b.uy*h+ny*q],[b.cx+b.ux*h-nx*q,b.cy+b.uy*h-ny*q],[b.cx-b.ux*h-nx*q,b.cy-b.uy*h-ny*q],[b.cx-b.ux*h+nx*q,b.cy-b.uy*h+ny*q]];
    for(let i=0;i<4;i++){ const p=C[i], r=C[(i+1)%4]; loop('plan:'+b.ref+':'+i,'','#c98f5a',[[p[0],p[1],b.z0],[r[0],r[1],b.z0],[r[0],r[1],b.z1],[p[0],p[1],b.z1],[p[0],p[1],b.z0]]); } }
  for(const c of s.cams){
    const g=peGeo(o,c.x,c.y); out.push({id:'plan:'+c.id,label:c.name,kind:'camera',lat:+g[0].toFixed(8),lon:+g[1].toFixed(8),alt_m:+((o.alt||0)+c.z).toFixed(2),color:'#7dff9a',icon:'dot',az:+peAzTrue(o,c.az).toFixed(1),tilt:c.tilt,fov:c.fov,range:c.range});
    const half=c.fov/2, L=Math.min(c.range,c.tilt-c.fov*.5625/2>0 ? Math.max(1,c.z/Math.tan((c.tilt-c.fov*.5625/2)*PE_D)) : c.range), pt=a=>[c.x+Math.sin((c.az+a)*PE_D)*L,c.y+Math.cos((c.az+a)*PE_D)*L,0];
    loop('plan:'+c.id+':fov','','#7dff9a',[[c.x,c.y,c.z],pt(-half),pt(half),[c.x,c.y,c.z]]);
  }
  for(const a of s.ants){ const g=peGeo(o,a.x,a.y); out.push({id:'plan:'+a.id,label:a.name+' '+a.eirp+' dBm',kind:'antenna',lat:+g[0].toFixed(8),lon:+g[1].toFixed(8),alt_m:+((o.alt||0)+a.z).toFixed(2),color:'#ffb74d',icon:'dot',az:+peAzTrue(o,a.az).toFixed(1),bw:a.bw,eirp:a.eirp,freq_mhz:a.f}); }
  for(const p of s.pts){ const g=peGeo(o,p.x,p.y); out.push({id:'plan:'+p.id,label:p.name||'',kind:'plan point',lat:+g[0].toFixed(8),lon:+g[1].toFixed(8),alt_m:+(o.alt||0).toFixed(2),x:+p.x.toFixed(3),y:+p.y.toFixed(3),color:'#9fb0b6',icon:'dot'}); }
  return out;
}
