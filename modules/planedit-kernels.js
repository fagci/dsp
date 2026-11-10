"use strict";
/* ============================ Plan Editor: ядро ============================
   Сцена плана: точки (x, y — метры, восток / север), стены между ними (толщина, высота, материал, фиксированная длина), проёмы (двери, окна — доля вдоль стены),
   примитивы (ящик, колонна), комнаты (замкнутые контуры точек), камеры (положение, высота, азимут, наклон, угол обзора, дальность) и антенны (положение, высота,
   азимут, ширина луча, EIRP, частота). Расчёты: перетаскивание точки с сохранением длин зафиксированных стен (итерации по ограничениям), видимость камер с
   тенями от стен, уровень сигнала антенн с потерями на стенах, охват и «слепые зоны». Ядро чистое, без DOM: node tools/test-planedit.mjs */

const PE_D=Math.PI/180;
// затухание стены, дБ на 10 см толщины: уровень сигнала на пути через стену = мат × толщина / 0,1 м
const PE_MAT={brick:4,concrete:6,block:3,drywall:1.5,wood:2,glass:1,metal:20,mesh:6,cord:0};          // mesh — сетка-рабица (забор): 0,05 м → 3 дБ          // block — газо- / пеноблок (ячеистый бетон)
// частотная зависимость: потери = таблица (на 2,4 ГГц) × (f / 2,4 ГГц)^k; k — по материалу (эмпирика типа ITU-R P.2040: плотные материалы растут быстрее, металл почти не зависит)
const PE_MATCOL={brick:[196,132,104],concrete:[168,174,180],block:[214,206,186],drywall:[230,229,222],wood:[190,146,96],glass:[150,206,232],metal:[118,128,148],mesh:[160,170,180],cord:[236,196,58]};   // цвет стены по материалу (3D / план)
const PE_MATK={brick:.8,concrete:.9,block:.8,mesh:.3,drywall:.5,wood:.6,glass:.6,metal:.1};
const PE_OPEN_LOSS={door:3,window:2};                          // проём: тонкая дверь / стекло, дБ на 2,4 ГГц
const PE_OPEN_K={door:.4,window:.6};
const peFk=(f,k)=>Math.pow(Math.max(30,Math.min(100000,f||2400))/2400,k);
const peMatLoss=(mat,f,t)=>(PE_MAT[mat]??4)*peFk(f,PE_MATK[mat]??.7)*(t??.2)/.1;      // потери стены толщиной t (м) на частоте f (МГц), дБ
const peOpenLoss=(type,f)=>PE_OPEN_LOSS[type]*peFk(f,PE_OPEN_K[type]);
const PE_TYPES=['box','column','door','window'];               // примитивы (door / window — проёмы в стене)
const peWrap180=a=>((a+180)%360+360)%360-180;
const peWrap360=a=>((a%360)+360)%360;

function peNew(){ return {pts:[],walls:[],objs:[],cams:[],ants:[],rooms:[],slabs:[],roofs:[],levels:[],grounds:[],elec:[],wires:[],hv:[],pp:[],seq:1}; }
function peId(s,p){ return p+(s.seq++); }
const pePt=(s,id)=>s.pts.find(p=>p.id===id);
function peAddPoint(s,x,y){ const p={id:peId(s,'p'),x,y}; s.pts.push(p); return p; }
function peAddWall(s,a,b,o={}){
  if(a===b) return null; const lv=o.lv||0;
  let w=s.walls.find(w=>(w.lv||0)===lv && ((w.a===a&&w.b===b)||(w.a===b&&w.b===a))); if(w) return w;      // та же пара точек на другом этаже — другая стена
  w={id:peId(s,'w'),a,b,t:o.t??.2,h:o.h??2.7,mat:o.mat||'brick',len:0}; if(lv){ w.lv=lv; w.z0=o.z0||0; } s.walls.push(w); return w;
}
const peWall=(s,id)=>s.walls.find(w=>w.id===id);
function peWallEnds(s,w){ const a=pePt(s,w.a), b=pePt(s,w.b); return [a,b]; }
function peWallLen(s,w){ const [a,b]=peWallEnds(s,w); return Math.hypot(b.x-a.x,b.y-a.y); }
function peDelWall(s,id){
  s.walls=s.walls.filter(w=>w.id!==id); s.objs=s.objs.filter(o=>o.wall!==id);
  s.rooms=s.rooms.filter(r=>r.free || r.pts.every((p,i)=>s.walls.some(w=>(w.a===p&&w.b===r.pts[(i+1)%r.pts.length])||(w.b===p&&w.a===r.pts[(i+1)%r.pts.length]))));
}
function peDelPoint(s,id){ for(const w of s.walls.filter(w=>w.a===id||w.b===id)) peDelWall(s,w.id); s.pts=s.pts.filter(p=>p.id!==id); }
function peDel(s,kind,id){
  if(kind==='pt') peDelPoint(s,id); else if(kind==='wall') peDelWall(s,id);
  else if(kind==='obj') s.objs=s.objs.filter(o=>o.id!==id); else if(kind==='cam') s.cams=s.cams.filter(o=>o.id!==id); else if(kind==='ant') s.ants=s.ants.filter(o=>o.id!==id);
  else if(kind==='room') s.rooms=s.rooms.filter(o=>o.id!==id);
  else if(kind==='el') peDelEl(s,id); else if(kind==='wire') s.wires=s.wires.filter(o=>o.id!==id);
  else if(kind==='hv'){ s.hv=(s.hv||[]).filter(d=>d.id!==id); s.pp=(s.pp||[]).filter(l=>l.a!==id&&l.b!==id); } else if(kind==='pp') s.pp=(s.pp||[]).filter(l=>l.id!==id);
}
// проём / примитив
function peAddObj(s,type,o){
  const base={box:{w:1,d:.6,h:.8,rot:0},column:{w:.3,d:.3,h:2.7,rot:0},door:{w:.9,h:2.05,sill:0,u:.5},window:{w:1.2,h:1.2,sill:.9,u:.5}}[type]; if(!base) return null;
  const ob={id:peId(s,'o'),type,x:0,y:0,z:0,name:'',...base,...o}; s.objs.push(ob); return ob;
}
function peAddCam(s,x,y,o={}){ const c={id:peId(s,'c'),name:'Cam'+(s.cams.length+1),x,y,z:2.6,az:0,tilt:25,fov:90,range:12,...o}; s.cams.push(c); return c; }
function peAddAnt(s,x,y,o={}){ const a={id:peId(s,'a'),role:'tx',name:'AP'+(s.ants.filter(q=>q.role!=='rx').length+1),x,y,z:2.4,az:0,bw:360,eirp:20,f:2437,...o}; s.ants.push(a); return a; }
// приёмная антенна: усиление, чувствительность, частота, диаграмма (bw < 360 — направленная, az — куда смотрит)
function peAddRx(s,x,y,o={}){ const a={id:peId(s,'a'),role:'rx',name:'RX'+(s.ants.filter(q=>q.role==='rx').length+1),x,y,z:1,az:0,bw:360,gain:2,sens:-85,f:2437,...o}; s.ants.push(a); return a; }
const peIsRx=a=>a.role==='rx';
// комната по замкнутой цепочке точек (id); площадь — по формуле шнурования
function peAddRoom(s,ids,name){ const r={id:peId(s,'r'),pts:ids.slice(),name:name||'Room'+(s.rooms.length+1)}; s.rooms.push(r); return r; }
// быстрые комнаты: контур по точкам (существующие точки в пределах 5 см берутся, а не дублируются — общие стены у соседних комнат), стены по сторонам, комната
const peFindPt=(s,x,y,tol=.05)=>s.pts.find(p=>Math.hypot(p.x-x,p.y-y)<=tol);
// разрезать стену точкой p на ней: вторая половина — новая стена с теми же свойствами; проёмы и комнаты, у которых это сторона, переносятся (в комнату добавляется p)
function peSplitWall(s,w,p){ if(w.src) return null; const [a,b]=peWallEnds(s,w); if(!a||!b||p.id===w.a||p.id===w.b) return null; const L=Math.hypot(b.x-a.x,b.y-a.y), d=Math.hypot(p.x-a.x,p.y-a.y); if(d<.05||L-d<.05) return null;
  const w2={...w,id:peId(s,'w'),a:p.id,b:w.b,len:0}; w.b=p.id; w.len=0;
  for(const o of s.objs) if(o.wall===w.id){ const pos=o.u*L; if(pos<d) o.u=pos/d; else { o.wall=w2.id; o.u=(pos-d)/(L-d); } }
  s.walls.push(w2);
  for(const r of s.rooms){ if((r.lv||0)!==(w.lv||0)) continue; const n=r.pts.length; for(let i=0;i<n;i++){ const x=r.pts[i], y=r.pts[(i+1)%n]; if((x===w.a&&y===w2.b)||(x===w2.b&&y===w.a)){ r.pts.splice(i+1,0,p.id); break; } } }
  return w2; }
const peOnSeg=(p,a,b,tol=.05)=>{ const dx=b.x-a.x, dy=b.y-a.y, L2=dx*dx+dy*dy; if(L2<1e-12) return false; const u=((p.x-a.x)*dx+(p.y-a.y)*dy)/L2; if(u<=0||u>=1) return false; return Math.hypot(p.x-(a.x+dx*u),p.y-(a.y+dy*u))<=tol && Math.hypot(p.x-a.x,p.y-a.y)>tol && Math.hypot(p.x-b.x,p.y-b.y)>tol; };
function peAddPolyRoom(s,P,o={}){ if(!Array.isArray(P)||P.length<3) return null; let ids=[]; for(const q of P){ const p=peFindPt(s,+q[0],+q[1])||peAddPoint(s,+q[0],+q[1]); if(ids[ids.length-1]!==p.id) ids.push(p.id); }
  if(ids.length>1 && ids[0]===ids[ids.length-1]) ids.pop(); if(ids.length<3 || new Set(ids).size!==ids.length) return null;
  // существующие точки на сторонах нового контура становятся его углами (сторона не накладывается на чужую стену); новые углы на чужих стенах режут их
  { const ext=[]; for(let i=0;i<ids.length;i++){ const A=pePt(s,ids[i]), B=pePt(s,ids[(i+1)%ids.length]); ext.push(ids[i]);
      const mid=s.pts.filter(p=>!ids.includes(p.id) && peOnSeg(p,A,B)).sort((u,v)=>Math.hypot(u.x-A.x,u.y-A.y)-Math.hypot(v.x-A.x,v.y-A.y)); for(const p of mid) ext.push(p.id); } ids=ext; }
  for(const id of ids){ const p=pePt(s,id); for(const w of s.walls.slice()){ if(w.a===id||w.b===id||(w.lv||0)!==(o.lv||0)) continue; const [a,b]=peWallEnds(s,w); if(a&&b&&peOnSeg(p,a,b)) peSplitWall(s,w,p); } }
  if(s.rooms.some(r=>(r.lv||0)===(o.lv||0) && r.pts.length===ids.length && ids.every(i=>r.pts.includes(i)))) return null;
  const ws=ids.map((a,i)=>peAddWall(s,a,ids[(i+1)%ids.length],{t:o.t>0 ? o.t : undefined,h:o.h>0 ? o.h : undefined,mat:o.mat,lv:o.lv,z0:o.z0})); const r=peAddRoom(s,ids,o.name); if(o.lv){ r.lv=o.lv; r.z0=o.z0||0; } return {room:r,walls:ws,pts:ids}; }
const peAddRectRoom=(s,x0,y0,w,h,o={})=>w>0&&h>0 ? peAddPolyRoom(s,[[x0,y0],[x0+w,y0],[x0+w,y0+h],[x0,y0+h]],o) : null;
// прямоугольная ли комната (4 точки, стороны по осям): {x0,y0,x1,y1,w,h}
function peRoomRect(s,r){ if(!r||r.pts.length!==4) return null; const P=r.pts.map(id=>pePt(s,id)); if(P.some(p=>!p)) return null; const xs=[...new Set(P.map(p=>+p.x.toFixed(3)))], ys=[...new Set(P.map(p=>+p.y.toFixed(3)))];
  if(xs.length!==2||ys.length!==2) return null; const x0=Math.min(...xs), x1=Math.max(...xs), y0=Math.min(...ys), y1=Math.max(...ys); return {x0,y0,x1,y1,w:x1-x0,h:y1-y0}; }
// размеры прямоугольной комнаты: правая и верхняя стороны сдвигаются (левый нижний угол на месте); зафиксированные длины соседей подтягиваются (peDrag)
function peRoomResize(s,r,w,h){ const R=peRoomRect(s,r); if(!R||!(w>0)||!(h>0)) return false;
  for(const id of r.pts){ const p=pePt(s,id), mx=Math.abs(p.x-R.x1)<1e-3, my=Math.abs(p.y-R.y1)<1e-3; if(mx||my) peDrag(s,id,mx ? R.x0+w : p.x,my ? R.y0+h : p.y); } return true; }
// куда ставить новую комнату: справа от выбранной (общая стена), иначе правее всего плана; пустой план — в нуле
function peNextRoomPos(s,r){ const P=r ? r.pts.map(id=>pePt(s,id)).filter(Boolean) : s.pts; if(!P.length) return {x:0,y:0}; return {x:Math.max(...P.map(p=>p.x)),y:Math.min(...P.map(p=>p.y))}; }
function peRoomArea(s,r){ let a=0; for(let i=0;i<r.pts.length;i++){ const p=pePt(s,r.pts[i]), q=pePt(s,r.pts[(i+1)%r.pts.length]); a+=p.x*q.y-q.x*p.y; } return Math.abs(a)/2; }
function peRoomPoly(s,r){ return r.pts.map(id=>{ const p=pePt(s,id); return [p.x,p.y]; }); }
function peInPoly(P,x,y){ let c=false; for(let i=0,j=P.length-1;i<P.length;j=i++) if((P[i][1]>y)!==(P[j][1]>y) && x<(P[j][0]-P[i][0])*(y-P[i][1])/(P[j][1]-P[i][1])+P[i][0]) c=!c; return c; }
function peInRooms(s,x,y){ for(const r of s.rooms) if(peInPoly(peRoomPoly(s,r),x,y)) return true; return false; }

// ---------- электрика: розетки, выключатели, светильники и провода между ними ----------
// Устройство: {id,type,name,x,y,z,watt}; провод: {id,a,b (id устройств),cable,via:[[x,y]…],zr} — идёт от a к b через точки via на высоте трассы zr (не задана — выше из двух устройств),
// к каждому устройству спускается / поднимается по вертикали. Длина = путь в плане + спуски; запас на подрезку и разделку — PE_RESERVE.
const PE_EL={socket:{z:.3,watt:200,pre:'S'},switch:{z:1.1,watt:0,pre:'SW'},light:{z:2.6,watt:60,pre:'L'},panel:{z:1.6,watt:0,pre:'P'},inlet:{z:3,watt:0,pre:'IN'},junction:{z:2.4,watt:0,pre:'J'},load:{z:.3,watt:2000,pre:'LD'}};   // щиток, ввод в здание, распредкоробка, потребитель (бойлер, плита, кондиционер…)
// сечение по умолчанию: ввод — 5x2.5, розетка — 3x2.5, остальное — 3x1.5
const peDefCable=(a,b)=>a==='inlet'||b==='inlet' ? '5x2.5' : a==='socket'||b==='socket' ? '3x2.5' : '3x1.5';
const PE_CABLES=['2x0.75','2x1.5','2x2.5','3x1.5','3x2.5','3x4','3x6','4x2.5','5x1.5','5x2.5','5x4','5x6'];            // ходовые: число жил × сечение, мм²; в тексте Site Plan годится любое «NxS»
const peCableOk=c=>/^\d{1,2}x\d{1,3}(\.\d{1,2})?$/.test(String(c)) && +String(c).split('x')[1]>0;
const peCableCol=c=>{ const s=+String(c).split('x')[1]; return s<=.75 ? '#90caf9' : s<=1.5 ? '#ffd54f' : s<=2.5 ? '#ff8a65' : s<=4 ? '#f48fb1' : s<=6 ? '#ba68c8' : '#b0bec5'; };   // цвет по сечению
const PE_RESERVE=1.1;
const peElOf=(s,id)=>(s.elec||[]).find(e=>e.id===id);
function peAddEl(s,type,x,y,o={}){ const b=PE_EL[type]; if(!b) return null; (s.elec??=[]);
  const e={id:peId(s,'e'),type,name:b.pre+(s.elec.filter(q=>q.type===type).length+1),x,y,z:b.z,watt:b.watt,...o}; s.elec.push(e); return e; }
function peDelEl(s,id){ s.elec=(s.elec||[]).filter(e=>e.id!==id); s.wires=(s.wires||[]).filter(w=>w.a!==id&&w.b!==id); }
function peAddWire(s,a,b,o={}){ if(a===b||!peElOf(s,a)||!peElOf(s,b)) return null; (s.wires??=[]);
  let w=s.wires.find(w=>(w.a===a&&w.b===b)||(w.a===b&&w.b===a)); if(w) return w;
  w={id:peId(s,'k'),a,b,cable:peDefCable(peElOf(s,a).type,peElOf(s,b).type),via:[],...o}; s.wires.push(w); return w; }
// высота трассы: заданная (w.zr) или по умолчанию — выше из двух устройств (без лишнего подъёма к потолку)
const peRunZ=(A,B,w)=>w.zr>0 ? w.zr : Math.max(A.z||0,B.z||0);
// длина провода: путь в плане, вертикальные спуски до высоты трассы, всего с запасом
function peWireLen(s,w){ const A=peElOf(s,w.a), B=peElOf(s,w.b); if(!A||!B) return {plan:0,drop:0,total:0,len:0};
  const P=[[A.x,A.y],...(w.via||[]),[B.x,B.y]]; let plan=0; for(let i=1;i<P.length;i++) plan+=Math.hypot(P[i][0]-P[i-1][0],P[i][1]-P[i-1][1]);
  const zr=peRunZ(A,B,w), drop=Math.abs(zr-(A.z||0))+Math.abs(zr-(B.z||0)); return {plan,drop,len:plan+drop,total:(plan+drop)*PE_RESERVE}; }
// трасса провода как ломаная [x,y,z]: от устройства вверх до высоты трассы, по via, вниз ко второму
function peWirePath(s,w){ const A=peElOf(s,w.a), B=peElOf(s,w.b); if(!A||!B) return null; const zr=peRunZ(A,B,w);
  return [[A.x,A.y,A.z||0],[A.x,A.y,zr],...(w.via||[]).map(q=>[q[0],q[1],zr]),[B.x,B.y,zr],[B.x,B.y,B.z||0]]; }
// сводка: числа устройств, мощность, длины кабеля по сечениям
function peElecStats(s){
  const n={socket:0,switch:0,light:0,panel:0,inlet:0,junction:0,load:0}, cab={}; let watt=0, len=0, tot=0;
  for(const e of s.elec||[]){ n[e.type]=(n[e.type]||0)+1; watt+=+e.watt||0; }
  for(const w of s.wires||[]){ const L=peWireLen(s,w); cab[w.cable]=(cab[w.cable]||0)+L.total; len+=L.len; tot+=L.total; }
  return {n,watt,len,total:tot,cables:cab};
}

// ---------- группы: расчёт линий от щитка ----------
// Группа — всё, что питается от одного провода, выходящего из щитка (дальше провода разветвляются через коробки, розетки, выключатели).
// Ток: I = P / (U·cosφ), 230 В, однофазная сеть; светильники cosφ 1, остальное PE_COSF. Автомат — ближайший номинал не ниже тока (или заданный на первом проводе: w.amp).
// Допустимый ток кабеля — медь, скрытая проводка (таблица PE_AMPACITY, мм² → А). Падение напряжения: ΔU = Σ 2·ρ·L·I/S по участкам пути, I — ток всего, что ниже по линии.
const PE_U=230, PE_COSF=.95, PE_RHO=.0175, PE_KC=.7, PE_DROP=5;                       // В, cosφ, Ом·мм²/м, коэффициент спроса щитка, допустимое падение, %
const PE_BREAKERS=[6,10,16,20,25,32,40,50,63,80,100];
const PE_AMPACITY={.75:11,1:15,1.5:19,2.5:27,4:38,6:46,10:70,16:85,25:115};
const peCableS=c=>+String(c).split('x')[1]||0;
const peAmpOf=c=>{ const S=peCableS(c), ks=Object.keys(PE_AMPACITY).map(Number).sort((a,b)=>a-b); let a=0; for(const k of ks) if(k<=S+1e-9) a=PE_AMPACITY[k]; return a; };   // ближайшее сечение не больше заданного
const peNeedS=I=>{ const ks=Object.keys(PE_AMPACITY).map(Number).sort((a,b)=>a-b); for(const k of ks) if(PE_AMPACITY[k]>=I) return k; return ks[ks.length-1]; };
const peBrkFor=I=>PE_BREAKERS.find(b=>b>=I-1e-9)||PE_BREAKERS[PE_BREAKERS.length-1];
const PE_U3=400;                                                                          // линейное напряжение; трёхфазная группа — симметричная нагрузка, ток фазы I = P/(√3·400·cosφ)
const peDevAmp=(e,t3)=>{ const w=+e.watt||0, c=e.type==='light' ? 1 : PE_COSF; return t3 ? w/(Math.sqrt(3)*PE_U3*c) : w/(PE_U*c); };
function peGroups(s){
  const el=s.elec||[], wi=s.wires||[], by=new Map(el.map(e=>[e.id,e])), adj=new Map(el.map(e=>[e.id,[]]));
  for(const w of wi) if(by.has(w.a)&&by.has(w.b)){ adj.get(w.a).push([w.b,w]); adj.get(w.b).push([w.a,w]); }
  const stop=e=>e.type==='panel'||e.type==='inlet', seen=new Set(), groups=[], panels=[];
  for(const P of el.filter(e=>e.type==='panel')){
    const pg=[]; let k=0;
    for(const w of wi){ const o=w.a===P.id ? by.get(w.b) : w.b===P.id ? by.get(w.a) : null; if(!o||stop(o)) continue;
      // обход от первого соседа, не заходя в щитки и вводы; parent — провод, по которому пришли
      const order=[o.id], par=new Map([[o.id,{wire:w,from:P.id,dist:peWireLen(s,w).len}]]); let fresh=!seen.has(o.id); if(!fresh) continue;
      seen.add(o.id);
      for(let i=0;i<order.length;i++){ const id=order[i], d=par.get(id).dist;
        for(const [nb,ww] of adj.get(id)){ const q=by.get(nb); if(stop(q)||seen.has(nb)||nb===P.id) continue; seen.add(nb); par.set(nb,{wire:ww,from:id,dist:d+peWireLen(s,ww).len}); order.push(nb); } }
      // ток по участкам: что ниже по линии
      const t3=order.some(id=>by.get(id).ph===3), cur=new Map(order.map(id=>[id,peDevAmp(by.get(id),t3)]));
      for(let i=order.length-1;i>0;i--){ const p=par.get(order[i]); cur.set(p.from,(cur.get(p.from)||0)+cur.get(order[i])); }
      const watt=order.reduce((a,id)=>a+(+by.get(id).watt||0),0), I=cur.get(o.id)||0;
      const amp=+w.amp>0 ? +w.amp : peBrkFor(I), name=w.gname||(P.name+'/'+(++k));
      const segs=order.map(id=>{ const p=par.get(id), c=cur.get(id), a=peAmpOf(p.wire.cable); return {wire:p.wire.id,cable:p.wire.cable,I:c,ok:a>=c-1e-9,allowed:a,need:peNeedS(c)}; });
      // падение напряжения до каждого потребителя; худший — по длине пути
      let drop=0, far=null; for(const id of order){ if(!(+by.get(id).watt>0)) continue; let du=0, x=id; while(par.has(x)){ const p=par.get(x), S=peCableS(p.wire.cable)||1; du+=(t3 ? Math.sqrt(3) : 2)*PE_RHO*peWireLen(s,p.wire).len*cur.get(x)/S; x=p.from; } if(du>drop){ drop=du; far=by.get(id).name; } }
      const trunk=segs[0], bad=[];
      if(amp<I-1e-9) bad.push('breaker '+amp+' A is below the current '+I.toFixed(1)+' A');
      for(const g of segs) if(g.allowed<amp-1e-9){ bad.push('cable '+g.cable+' ('+g.allowed+' A) is weaker than the '+amp+' A breaker'); break; }
      if(!bad.length) for(const g of segs) if(!g.ok){ bad.push('cable '+g.cable+' cannot carry the '+g.I.toFixed(1)+' A of its section'); break; }
      const Ub=t3 ? PE_U3 : PE_U;
      if(t3 && order.some(id=>(+by.get(id).watt>0) && by.get(id).ph!==3)) bad.push('single-phase devices on a three-phase line');
      if(t3 && segs.some(g=>(+String(g.cable).split('x')[0]||0)<4)) bad.push('a three-phase line needs 4+ cores (5x… with PE)');
      if(drop/Ub*100>PE_DROP) bad.push('voltage drop '+(drop/Ub*100).toFixed(1)+'% > '+PE_DROP+'%');
      pg.push({name,panel:P.name,head:w.id,devs:order.map(id=>by.get(id).name),watt,I,amp,cable:trunk.cable,need:peNeedS(Math.max(I,amp)),drop,dropPct:drop/Ub*100,ph:t3 ? 3 : 1,far,len:Math.max(...order.map(id=>par.get(id).dist)),segs,warn:bad,ok:!bad.length});
    }
    groups.push(...pg);
    // фазы: трёхфазные группы грузят все три, однофазные раскладываются по наименее загруженной (сначала самые мощные)
    const ph=[0,0,0]; for(const g of pg) if(g.ph===3) for(let i=0;i<3;i++) ph[i]+=g.I;
    for(const g of pg.filter(g=>g.ph!==3).sort((a,b)=>b.I-a.I)){ const i=ph.indexOf(Math.min(...ph)); ph[i]+=g.I; g.phase='L'+(i+1); }
    for(const g of pg) if(g.ph===3) g.phase='L1+L2+L3';
    const W=pg.reduce((a,g)=>a+g.watt,0), I=Math.max(...ph)*PE_KC, imb=Math.max(...ph)>0 ? (Math.max(...ph)-Math.min(...ph))/Math.max(...ph)*100 : 0;
    // питающий провод щитка — к вводу
    let feed=null; for(const w of wi){ const o=w.a===P.id ? by.get(w.b) : w.b===P.id ? by.get(w.a) : null; if(o&&o.type==='inlet'){ feed={wire:w.id,cable:w.cable,allowed:peAmpOf(w.cable)}; break; } }
    panels.push({name:P.name,phases:ph.map(x=>x*PE_KC),imbalance:imb,three:pg.some(g=>g.ph===3),groups:pg.length,watt:W,demandW:W*PE_KC,I,main:peBrkFor(I),feed,feedOk:!feed||feed.allowed>=I-1e-9});
  }
  const orphans=el.filter(e=>(+e.watt>0)&&!seen.has(e.id)).map(e=>e.name);                                   // потребители без питания от щитка
  return {groups,panels,orphans};
}

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
// сдвинуть стену целиком (оба конца на новые места), остальные зафиксированные стороны подтягиваются
function peMoveWall(s,wid,ax,ay,bx,by){ const w=peWall(s,wid); if(!w) return; const a=pePt(s,w.a), b=pePt(s,w.b); a.x=ax; a.y=ay; b.x=bx; b.y=by; a.fix=true; b.fix=true; peDrag(s,w.a,ax,ay); delete a.fix; delete b.fix; }
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
    const zb=w.z0||0, add=(s0,s1,z0,z1,kind)=>{ if(s1-s0<1e-6||z1-z0<1e-6) return; const m=(s0+s1)/2; out.push({cx:a.x+ux*m,cy:a.y+uy*m,ux,uy,l:s1-s0,t:w.t,z0:zb+z0,z1:zb+z1,kind,ref:w.id,mat:w.mat,lv:w.lv||0}); };
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
// препятствия для взгляда: отрезки [x1,y1,x2,y2,id,z0,z1] — с высотой (взгляд проходит над / под ними); сетка-рабица и стекло прозрачны;
// у проёма стена остаётся под подоконником и над проёмом; o.slabs — перекрытия (взгляд с этажа на этаж через них не проходит)
const PE_SEE_THROUGH={mesh:1,glass:1,cord:1};
function peOccluders(s,minH=0){
  const o=[];
  for(const w of s.walls){ if(PE_SEE_THROUGH[w.mat]) continue; const [a,b]=peWallEnds(s,w), P=peWallParts(s,w), ux=(b.x-a.x)/(P.L||1), uy=(b.y-a.y)/(P.L||1), z0=w.z0||0, z1=z0+w.h;
    const seg=(s0,s1,za,zb)=>{ if(s1-s0>1e-6 && zb-za>1e-6) o.push([a.x+ux*s0,a.y+uy*s0,a.x+ux*s1,a.y+uy*s1,w.id,za,zb]); };
    for(const [s0,s1] of P.solid) seg(s0,s1,z0,z1);
    for(const q of P.open){ seg(q.s0,q.s1,z0,z0+(q.sill||0)); seg(q.s0,q.s1,z0+(q.sill||0)+q.h,z1); } }
  o.slabs=s.slabs||[];
  for(const b of peBoxes(s)){ if(b.kind==='wall' || b.z1<minH) continue; const nx=-b.uy, ny=b.ux, h=b.l/2, q=b.t/2, C=[[b.cx+b.ux*h+nx*q,b.cy+b.uy*h+ny*q],[b.cx+b.ux*h-nx*q,b.cy+b.uy*h-ny*q],[b.cx-b.ux*h-nx*q,b.cy-b.uy*h-ny*q],[b.cx-b.ux*h+nx*q,b.cy-b.uy*h+ny*q]]; for(let i=0;i<4;i++) o.push([C[i][0],C[i][1],C[(i+1)%4][0],C[(i+1)%4][1],b.ref,b.z0,b.z1]); }
  return o;
}
// пересечение отрезка p→q с отрезком e; возвращает параметр t по p→q или -1
function peSegT(px,py,qx,qy,e){
  const rx=qx-px, ry=qy-py, sx=e[2]-e[0], sy=e[3]-e[1], den=rx*sy-ry*sx; if(Math.abs(den)<1e-12) return -1;
  const t=((e[0]-px)*sy-(e[1]-py)*sx)/den, u=((e[0]-px)*ry-(e[1]-py)*rx)/den; return t>=0&&t<=1&&u>=0&&u<=1 ? t : -1;
}
// есть ли на пути p→q препятствие (пересечения ближе skip метров к p не считаются — камера на стене)
// pz, qz — высоты концов взгляда: если заданы, препятствие с высотой [z0,z1] мешает, только когда линия проходит в его пределах; перекрытия — тоже
function peBlocked(occ,px,py,qx,qy,skip=.15,pz,qz){ const L=Math.hypot(qx-px,qy-py)||1, h3=isFinite(pz) && isFinite(qz);
  for(const e of occ){ const t=peSegT(px,py,qx,qy,e); if(t<0 || t*L<=skip) continue; if(h3 && e.length>6){ const z=pz+(qz-pz)*t; if(z<e[5] || z>e[6]) continue; } return true; }
  if(h3 && occ.slabs) for(const sl of occ.slabs){ const zs=sl.z-(sl.t||0)/2; if((zs-pz)*(zs-qz)>=0) continue; const k=(zs-pz)/(qz-pz); if(peInPoly(sl.poly,px+(qx-px)*k,py+(qy-py)*k)) return true; }
  return false; }

// ---------- камеры ----------
// видна ли точка (x, y) на высоте zt (по умолчанию 1 м — торс человека): угол по азимуту, дальность, вертикальный угол (наклон вниз tilt, поле fov·0,5625), линия видимости
function peSees(c,x,y,occ,zt=1){
  const dx=x-c.x, dy=y-c.y, d=Math.hypot(dx,dy); if(d>c.range) return false; if(d<.05) return false;
  if(Math.abs(peWrap180(Math.atan2(dx,dy)/PE_D-c.az))>c.fov/2) return false;
  const dep=Math.atan2(c.z-zt,d)/PE_D, v=c.fov*.5625;                                        // угол вниз до цели; допустимо tilt ± v/2
  if(dep<c.tilt-v/2 || dep>c.tilt+v/2) return false;
  return !peBlocked(occ,c.x,c.y,x,y,.15,c.z,zt);
}
// многоугольник видимости на уровне пола в секторе камеры (для рисования): веер лучей с тенями от стен; дальность ограничена range
// zt — высота цели (человек ≈ 1 м над полом): препятствие на расстоянии d с высотой [z0,z1] закрывает цель на дальностях t, где линия
// камера → цель проходит в его пределах: z(d) = c.z + (zt − c.z)·d/t; контур — до первой такой тени (за невысоким забором видно снова — это на растре)
function peVisPoly(c,occ,stepDeg=1,zt){
  const P=[[c.x,c.y]], h3=isFinite(zt) && isFinite(c.z);
  for(let a=-c.fov/2;a<=c.fov/2+1e-9;a+=stepDeg){
    const ang=(c.az+a)*PE_D, dx=Math.sin(ang), dy=Math.cos(ang); let t=c.range;
    for(const e of occ){ const h=peSegT(c.x,c.y,c.x+dx*c.range,c.y+dy*c.range,e); if(h<0) continue; const d=h*c.range; if(d<=.15 || d>=t) continue;
      if(h3 && e.length>6){ const k=zt-c.z; let ua=0, ub=1;                                   // u = d/t ∈ (0,1]: z = c.z + k·u в [z0,z1]
        if(Math.abs(k)<1e-9){ if(c.z<e[5] || c.z>e[6]) continue; } else { let u0=(e[5]-c.z)/k, u1=(e[6]-c.z)/k; if(u0>u1) [u0,u1]=[u1,u0]; ua=Math.max(ua,u0); ub=Math.min(ub,u1); if(ub<=ua || ub<=0) continue; }
        const t0=d/ub; if(t0<t) t=Math.max(d,t0); }
      else t=d; }
    P.push([c.x+dx*t,c.y+dy*t]);
  }
  return P;
}

// ---------- антенны ----------
function peFspl(d,fMHz){ return 20*Math.log10(Math.max(d,1))+20*Math.log10(fMHz)-27.55; }
function peAntGain(a,dx,dy){ if(!(a.bw<360)) return 0; const off=Math.abs(peWrap180(Math.atan2(dx,dy)/PE_D-a.az)); return -Math.min(25,12*Math.pow(off/Math.max(1,a.bw),2)); }
// потери на стенах по пути a→(x,y) на частоте f (МГц), дБ: пересечение оси стены = материал × толщина / 10 см × (f / 2,4 ГГц)^k; проём — потери проёма
// az, z — высоты концов луча (если заданы): стена считается, только если луч проходит через неё по высоте (этажи, проём — только в его пределах);
// перекрытия (s.slabs) между az и z добавляют свои потери там, где луч проходит сквозь их контур
function peWallLoss(s,ax,ay,x,y,f=2400,az,z,skip){
  let loss=0; const h3=isFinite(az) && isFinite(z);
  for(const w of s.walls){ if(skip && (w.id===skip || (skip.has && skip.has(w.id)))) continue;
    const [p,q]=peWallEnds(s,w), t=peSegT(ax,ay,x,y,[p.x,p.y,q.x,q.y]); if(t<0) continue;
    const hz=h3 ? az+(z-az)*t-(w.z0||0) : NaN; if(h3 && (hz<0 || hz>w.h)) continue;
    const hx=ax+(x-ax)*t, hy=ay+(y-ay)*t, L=Math.hypot(q.x-p.x,q.y-p.y)||1, u=Math.hypot(hx-p.x,hy-p.y)/L; let open=null;
    for(const o of s.objs) if(o.wall===w.id && (o.type==='door'||o.type==='window') && Math.abs(u-o.u)*L<=o.w/2 && (!h3 || (hz>=(o.sill||0) && hz<=(o.sill||0)+o.h))) open=o;
    loss+=open ? peOpenLoss(open.type,f) : peMatLoss(w.mat,f,w.t);
  }
  if(h3 && s.slabs) for(const sl of s.slabs){ const zs=sl.z-(sl.t||0)/2; if((zs-az)*(zs-z)>=0) continue; const k=(zs-az)/(z-az);
    if(peInPoly(sl.poly,ax+(x-ax)*k,ay+(y-ay)*k)) loss+=peMatLoss(sl.mat||'concrete',f,sl.t||.25); }
  return loss;
}
// ---------- отражения (метод мнимых источников) ----------
// потери на отражение от грани, дБ (|Γ|² типичных стройматериалов на 1–6 ГГц): металл почти зеркало, гипсокартон — слабо
const PE_REFL={brick:7,concrete:5,block:8,drywall:11,wood:9,glass:6,metal:1,mesh:6};
const peReflLoss=mat=>PE_REFL[mat]??8;
// отражающие грани: у каждой стены две — по обе стороны оси на t/2; n — наружу от стены на эту сторону
function peFaces(s){ const F=[]; for(const w of s.walls){ const [a,b]=peWallEnds(s,w), L=Math.hypot(b.x-a.x,b.y-a.y); if(L<.05) continue; const ux=(b.x-a.x)/L, uy=(b.y-a.y)/L;
  for(const sg of [1,-1]){ const nx=-uy*sg, ny=ux*sg, ox=a.x+nx*w.t/2, oy=a.y+ny*w.t/2; F.push({w,ax:ox,ay:oy,bx:ox+ux*L,by:oy+uy*L,ux,uy,nx,ny,L}); } } return F; }
const peFaceD=(f,x,y)=>(x-f.ax)*f.nx+(y-f.ay)*f.ny;
const peMirror=(f,x,y)=>{ const d=peFaceD(f,x,y); return [x-2*d*f.nx,y-2*d*f.ny]; };
// точка P на грани f по лучу из мнимого источника (ix,iy) в (x,y): [px,py,u] или null
function peFaceHit(f,ix,iy,x,y){ const t=peSegT(ix,iy,x,y,[f.ax,f.ay,f.bx,f.by]); if(t<0) return null; const px=ix+(x-ix)*t, py=iy+(y-iy)*t; return [px,py,((px-f.ax)*f.ux+(py-f.ay)*f.uy)/f.L]; }
// отражает ли грань в этой точке по высоте: стена есть (не выше / не ниже её) и это не проём (дверь / окно пропускают)
function peFaceSolid(s,f,u,z){ const w=f.w, zr=z-(w.z0||0); if(zr<0 || zr>w.h) return false;
  for(const o of s.objs) if(o.wall===w.id && (o.type==='door'||o.type==='window') && Math.abs(u-o.u)*f.L<=o.w/2 && zr>=(o.sill||0) && zr<=(o.sill||0)+o.h) return false; return true; }
// пути антенна → точка: прямой и отражения до opt.refl (0…2) порядка. → [{level, order, pts:[[x,y,z]…]}]; уровни — дБм каждого пути
function pePaths(s,a,x,y,zr=1,opt={}){
  const f0=a.f, dx=x-a.x, dy=y-a.y, out=[];
  const direct=a.eirp+peAntGain(a,dx,dy)-peFspl(Math.hypot(dx,dy,a.z-zr),f0)-peWallLoss(s,a.x,a.y,x,y,f0,a.z,zr);
  out.push({level:direct,order:0,pts:[[a.x,a.y,a.z],[x,y,zr]]});
  const ord=opt.refl|0; if(ord<1) return out;
  const F=opt.faces||peFaces(s), floor=Math.max(direct,-200)-(opt.cut??40);   // пути слабее прямого на cut дБ не считаем (их вклад < 0,01 %)
  const legs=(P,skips)=>{ let L=0; for(let i=0;i+1<P.length;i++) L+=peWallLoss(s,P[i][0],P[i][1],P[i+1][0],P[i+1][1],f0,P[i][2],P[i+1][2],skips[i]); return L; };
  for(const f of F){ if(peFaceD(f,a.x,a.y)<=0 || peFaceD(f,x,y)<=0) continue;
    const [ix,iy]=peMirror(f,a.x,a.y), h=peFaceHit(f,ix,iy,x,y); if(!h) continue;
    const d1=Math.hypot(h[0]-a.x,h[1]-a.y), d2=Math.hypot(x-h[0],y-h[1]), D=d1+d2, zP=a.z+(zr-a.z)*d1/(D||1); if(!peFaceSolid(s,f,h[2],zP)) continue;
    let lv=a.eirp+peAntGain(a,h[0]-a.x,h[1]-a.y)-peFspl(Math.hypot(D,a.z-zr),f0)-peReflLoss(f.w.mat); if(lv<floor) continue;
    const P=[[a.x,a.y,a.z],[h[0],h[1],zP],[x,y,zr]]; lv-=legs(P,[f.w.id,f.w.id]); if(lv>=floor) out.push({level:lv,order:1,pts:P}); }
  if(ord>=2) for(const f1 of F){ if(peFaceD(f1,a.x,a.y)<=0) continue; const [i1x,i1y]=peMirror(f1,a.x,a.y);
    for(const f2 of F){ if(f2.w===f1.w || peFaceD(f2,i1x,i1y)<=0 || peFaceD(f2,x,y)<=0) continue;
      const [i2x,i2y]=peMirror(f2,i1x,i1y), h2=peFaceHit(f2,i2x,i2y,x,y); if(!h2) continue; const h1=peFaceHit(f1,i1x,i1y,h2[0],h2[1]); if(!h1) continue;
      const d1=Math.hypot(h1[0]-a.x,h1[1]-a.y), d2=Math.hypot(h2[0]-h1[0],h2[1]-h1[1]), d3=Math.hypot(x-h2[0],y-h2[1]), D=d1+d2+d3;
      let lv=a.eirp+peAntGain(a,h1[0]-a.x,h1[1]-a.y)-peFspl(Math.hypot(D,a.z-zr),f0)-peReflLoss(f1.w.mat)-peReflLoss(f2.w.mat); if(lv<floor) continue;
      const z1=a.z+(zr-a.z)*d1/D, z2=a.z+(zr-a.z)*(d1+d2)/D; if(!peFaceSolid(s,f1,h1[2],z1) || !peFaceSolid(s,f2,h2[2],z2)) continue;
      const P=[[a.x,a.y,a.z],[h1[0],h1[1],z1],[h2[0],h2[1],z2],[x,y,zr]]; lv-=legs(P,[f1.w.id,new Set([f1.w.id,f2.w.id]),f2.w.id]); if(lv>=floor) out.push({level:lv,order:2,pts:P}); } }
  return out;
}
// сумма мощностей путей (некогерентно — фазы на сетке в 25 см усреднились бы в ноль), дБм
const peSumDb=L=>{ let p=0; for(const v of L) p+=Math.pow(10,v/10); return p>0 ? 10*Math.log10(p) : -200; };
// уровень сигнала антенны в точке, дБм (приёмник на высоте zr); opt.refl — порядок отражений (0 — только прямой путь)
function peAntLevel(s,a,x,y,zr=1,opt){
  if(opt && opt.refl>0) return peSumDb(pePaths(s,a,x,y,zr,opt).map(p=>p.level));
  const dx=x-a.x, dy=y-a.y, d3=Math.hypot(dx,dy,a.z-zr);
  return a.eirp+peAntGain(a,dx,dy)-peFspl(d3,a.f)-peWallLoss(s,a.x,a.y,x,y,a.f,a.z,zr);
}

// канал «передатчики → приёмник»: лучший по уровню передатчик на частоте приёмника (допуск max(10 МГц, 1 %)); уровень = EIRP + диаграмма передатчика − потери (дистанция, стены на этой частоте) + усиление и диаграмма приёмника; запас — над чувствительностью
function peRxLevel(s,rx,opt={}){
  const tol=opt.tol??Math.max(10,rx.f*.01), sens=rx.sens??-90; let best=null;
  for(const t of s.ants){ if(peIsRx(t) || Math.abs(t.f-rx.f)>tol) continue;
    const dx=rx.x-t.x, dy=rx.y-t.y, d3=Math.hypot(dx,dy,t.z-rx.z); let lv, paths=null;
    if(opt.refl>0){ paths=pePaths(s,t,rx.x,rx.y,rx.z,opt); for(const q of paths){ const pv=q.pts[q.pts.length-2]; q.level+=(rx.gain||0)+peAntGain(rx,pv[0]-rx.x,pv[1]-rx.y); } lv=peSumDb(paths.map(q=>q.level)); }   // диаграмма приёмника — по направлению прихода
    else lv=t.eirp+peAntGain(t,dx,dy)-peFspl(d3,t.f)-peWallLoss(s,t.x,t.y,rx.x,rx.y,t.f,t.z,rx.z)+(rx.gain||0)+peAntGain(rx,-dx,-dy);
    if(!best||lv>best.level) best={level:lv,from:t.id,name:t.name,paths}; }
  if(!best) return {level:-200,from:null,name:'',margin:-200-sens,ok:false};
  best.margin=best.level-sens; best.ok=best.margin>=0; return best;
}
// ---------- сетка охвата ----------
function peBounds(s,margin=1){ let x0=1e99,x1=-1e99,y0=1e99,y1=-1e99; const A=[...s.pts,...s.cams,...s.ants.filter(a=>!a.ext),...s.objs.filter(o=>o.type==='box'||o.type==='column')]; for(const p of A){ x0=Math.min(x0,p.x); x1=Math.max(x1,p.x); y0=Math.min(y0,p.y); y1=Math.max(y1,p.y); } return x0<=x1 ? {x0:x0-margin,x1:x1+margin,y0:y0-margin,y1:y1+margin} : null; }
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
  const tol=opt.f>0 ? Math.max(10,opt.f*.01) : 0, ants=(opt.id ? s.ants.filter(a=>a.id===opt.id) : s.ants).filter(a=>!peIsRx(a) && (!(opt.f>0) || Math.abs(a.f-opt.f)<=tol)), lvl=new Float32Array(g.nx*g.ny).fill(-200), polys=s.rooms.map(r=>peRoomPoly(s,r));
  const thr=opt.thr??-70, ro=opt.refl>0 ? {refl:opt.refl,faces:peFaces(s)} : null; let tot=0, ok=0, sum=0, mn=1e9;
  for(let j=0;j<g.ny;j++) for(let i=0;i<g.nx;i++){
    const x=g.x0+(i+.5)*g.cell, y=g.y0+(j+.5)*g.cell; let best=-200; for(const a of ants){ const v=peAntLevel(s,a,x,y,opt.zr??1,ro); if(v>best) best=v; } lvl[j*g.nx+i]=best;
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
  let n=0; s.elec??=[]; s.wires??=[];
  for(const r of recs||[]){ if(r && r.kind==='plan poly' && Array.isArray(r.names)){ r._poly=true; } }
  for(const r of recs||[]){ if(r && r.kind==='plan opening') r._op=true; }
  for(const r of recs||[]){ if(r && r.ext){ const nm=String(r.name??r.label??''), q=s.pts.find(p=>p.name===nm); if(q && !s.walls.some(w=>w.a===q.id||w.b===q.id)) s.pts=s.pts.filter(p=>p!==q); } }   // точка внешнего источника — не точка плана
  for(const r of recs||[]){ if(r && (r._poly || r._op || r.kind==='plan walls' || r.ext)) continue; const x=+r.x, y=+r.y, name=String(r.name??r.label??''); if(!name||!isFinite(x)||!isFinite(y)) continue;
    let p=s.pts.find(p=>p.name===name); if(p){ p.x=x; p.y=y; } else { p=peAddPoint(s,x,y); p.name=name; } p.imp=true; n++; }
  // контуры (kind 'plan poly', names): стены между соседними точками и комната, если их ещё нет
  for(const r of recs||[]){ if(!r || !r._poly) continue; const ids=r.names.map(nm=>s.pts.find(p=>p.name===nm)).filter(Boolean).map(p=>p.id); if(ids.length<3) continue;
    const key=ids.slice().sort().join(); let room=s.rooms.find(q=>q.pts.slice().sort().join()===key);
    if(r.nowalls){                                                // стены придут отдельно (plan walls): комната — только контур по замеру; старые стены по контуру убираем
      for(let i=0;i<ids.length;i++){ const a=ids[i], b=ids[(i+1)%ids.length], w=s.walls.find(w=>!w.src && ((w.a===a&&w.b===b)||(w.a===b&&w.b===a))); if(w){ s.walls=s.walls.filter(q=>q!==w); s.objs=s.objs.filter(o=>o.wall!==w.id); } }
      if(!room) room=peAddRoom(s,ids); room.free=true; if(r.name) room.name=String(r.name); if(+r.z0) room.z0=+r.z0; else delete room.z0; if(+r.lv) room.lv=+r.lv; else delete room.lv; }
    else { for(let i=0;i<ids.length;i++){ const w=peAddWall(s,ids[i],ids[(i+1)%ids.length]); if(w && +r.h>0) w.h=+r.h; }      // h — высота потолка комнаты (Site Plan)
      if(!room) peAddRoom(s,ids); }
    n++; delete r._poly; }
  // стены целиком (kind 'plan walls': walls [{id,x1,y1,x2,y2,t,h}], opens [{wall,u,w,h,sill,type}]): набор от источника заменяет прежний — лишние уходят, свои двигаются
  for(const r of recs||[]){ if(!r || r.kind!=='plan walls' || !Array.isArray(r.walls)) continue;
    const pre=String(r.id||'plan')+'|', keep=new Set();
    for(const q of r.walls){ const src=pre+q.id; keep.add(src); let w=s.walls.find(w=>w.src===src);
      if(!w){ const a=peAddPoint(s,+q.x1,+q.y1), b=peAddPoint(s,+q.x2,+q.y2); a.src=b.src=src; w=peAddWall(s,a.id,b.id,{t:+q.t,h:+q.h>0 ? +q.h : 2.7}); w.src=src; }
      const [a,b]=peWallEnds(s,w); a.x=+q.x1; a.y=+q.y1; b.x=+q.x2; b.y=+q.y2; w.t=+q.t>0 ? +q.t : w.t; if(+q.h>0) w.h=+q.h; if(q.mat && PE_MAT[q.mat]!=null) w.mat=q.mat;
      if(+q.z0) w.z0=+q.z0; else delete w.z0; if(+q.lv) w.lv=+q.lv; else delete w.lv; }
    s.slabs=Array.isArray(r.slabs) ? r.slabs.map(q=>({z:+q.z,t:+q.t,mat:q.mat,lv:+q.lv||0,poly:q.poly})) : [];          // перекрытия, крыша, этажи — целиком от источника
    s.roofs=Array.isArray(r.roofs) ? r.roofs.map(q=>({...q})) : [];
    s.levels=Array.isArray(r.levels) ? r.levels.map(q=>({name:String(q.name),z:+q.z,idx:+q.idx})) : [];
    s.grounds=Array.isArray(r.grounds) ? r.grounds.map(g=>({cover:String(g.cover),poly:g.poly})) : [];
    // внешние источники: антенны-передатчики «ext» (вне рамки карты), набор от источника заменяет прежний
    const skeep=new Set(); for(const q of r.sources||[]){ const src=pre+'src:'+q.name; skeep.add(src); let a=s.ants.find(x=>x.src===src);
      if(!a){ a=peAddAnt(s,+q.x,+q.y,{}); a.src=src; a.ext=true; } Object.assign(a,{name:String(q.name),x:+q.x,y:+q.y,z:+q.z,eirp:+q.eirp,f:+q.f,az:+q.az||0,bw:+q.bw||360}); }
    s.ants=s.ants.filter(a=>!a.src || !a.src.startsWith(pre) || skeep.has(a.src));
    for(const w of s.walls.filter(w=>w.src && w.src.startsWith(pre) && !keep.has(w.src))){ s.walls=s.walls.filter(q=>q!==w); s.objs=s.objs.filter(o=>o.wall!==w.id); s.pts=s.pts.filter(p=>p.src!==w.src); }
    const okeep=new Set();
    for(const q of r.stakes||[]){ const src=pre+'stake:'+q.id; okeep.add(src); const h=+q.h>0 ? +q.h : .5, v={x:+q.x,y:+q.y,w:.05,d:.05,h,name:'stake'}; const ob=s.objs.find(o=>o.src===src); if(ob) Object.assign(ob,v); else peAddObj(s,'column',{...v,src}); }      // колышки забора-шнура: тонкие столбики
    (r.opens||[]).forEach((o,i)=>{ const w=s.walls.find(w=>w.src===pre+o.wall); if(!w) return; const src=pre+'o'+i+':'+o.wall, type=o.type==='door' ? 'door' : 'window'; okeep.add(src);
      const v={type,wall:w.id,u:Math.max(0,Math.min(1,+o.u||0)),w:+o.w>0 ? +o.w : 1,...(+o.h>0 ? {h:+o.h} : {}),...(isFinite(+o.sill) && o.sill!=null ? {sill:+o.sill} : {})};
      const ob=s.objs.find(q=>q.src===src); if(ob) Object.assign(ob,v); else peAddObj(s,type,{...v,src}); });
    s.objs=s.objs.filter(o=>!o.src || !o.src.startsWith(pre) || okeep.has(o.src));
    // электрика: устройства и провода от источника заменяют прежние с тем же префиксом (свои, нарисованные руками, остаются)
    { const ekeep=new Set(); for(const q of r.elec||[]){ const src=pre+'el:'+q.name; ekeep.add(src); let e=s.elec.find(x=>x.src===src);
        if(!e){ e=peAddEl(s,PE_EL[q.type] ? q.type : 'socket',+q.x,+q.y,{}); e.src=src; }
        Object.assign(e,{name:String(q.name),x:+q.x,y:+q.y,z:+q.z,watt:+q.watt||0}); if(+q.ph===3) e.ph=3; else delete e.ph; }
      s.elec=s.elec.filter(e=>!e.src || !e.src.startsWith(pre) || ekeep.has(e.src));
      const wkeep=new Set(); for(const q of r.wires||[]){ const A=s.elec.find(e=>e.src===pre+'el:'+q.a), B=s.elec.find(e=>e.src===pre+'el:'+q.b); if(!A||!B||A===B) continue;
        const src=pre+'wire:'+q.a+'-'+q.b; wkeep.add(src); let w=s.wires.find(x=>x.src===src);
        if(!w){ w=peAddWire(s,A.id,B.id,{}); if(!w) continue; w.src=src; }
        w.cable=peCableOk(q.cable) ? q.cable : w.cable; if(+q.z>0) w.zr=+q.z; if(+q.amp>0) w.amp=+q.amp; else delete w.amp; }
      s.wires=s.wires.filter(w=>(!w.src || !w.src.startsWith(pre) || wkeep.has(w.src)) && peElOf(s,w.a) && peElOf(s,w.b)); }
    if(typeof hvImport==='function') hvImport(s,r,pre);                                           // отопление и вентиляция (hvac-kernels.js)
    s.objs=s.objs.filter(o=>!(o.src && String(o.src).startsWith('sp:') && !String(o.src).startsWith(pre) && (o.type==='door'||o.type==='window')));   // проёмы старого вида (по углам) — заменены
    n++; }
  // проёмы (kind 'plan opening': type, a, b — имена углов, from — от a до ближнего края, w, h, sill): на стену a-b, повторный импорт обновляет тот же
  for(const r of recs||[]){ if(!r || !r._op) continue; delete r._op;
    const A=s.pts.find(p=>p.name===r.a), B=s.pts.find(p=>p.name===r.b), type=r.type==='door' ? 'door' : 'window'; if(!A||!B) continue;
    const w=s.walls.find(w=>(w.a===A.id&&w.b===B.id)||(w.a===B.id&&w.b===A.id)); if(!w) continue;
    const L=peWallLen(s,w)||1, wd=+r.w>0 ? +r.w : 1; let u=Math.max(0,Math.min(1,((+r.from||0)+wd/2)/L)); if(w.a!==A.id) u=1-u;
    const src=String(r.id||type+':'+r.a+'-'+r.b+':'+r.from), p={type,wall:w.id,u,w:wd,...(+r.h>0 ? {h:+r.h} : {}),...(isFinite(+r.sill) && r.sill!=='' && r.sill!=null ? {sill:+r.sill} : {})};
    const ob=s.objs.find(o=>o.src===src); if(ob) Object.assign(ob,p); else peAddObj(s,type,{...p,src}); n++; }
  return n;
}
// привязка линейки: углы стен (по граням), иначе ближайшая точка на грани стены, иначе null; tol — м
function peSnapFace(s,x,y,tol){
  let best=null, bd=tol;
  for(const w of s.walls){ const [a,b]=peWallEnds(s,w), L=Math.hypot(b.x-a.x,b.y-a.y)||1e-9, ux=(b.x-a.x)/L, uy=(b.y-a.y)/L, nx=-uy*w.t/2, ny=ux*w.t/2;
    for(const [px,py] of [[a.x+nx,a.y+ny],[a.x-nx,a.y-ny],[b.x+nx,b.y+ny],[b.x-nx,b.y-ny]]){ const d=Math.hypot(px-x,py-y); if(d<bd){ bd=d; best={x:px,y:py,kind:'corner'}; } } }
  if(best) return best; bd=tol*.7;
  for(const w of s.walls){ const [a,b]=peWallEnds(s,w), L=Math.hypot(b.x-a.x,b.y-a.y)||1e-9, ux=(b.x-a.x)/L, uy=(b.y-a.y)/L;
    for(const sg of [1,-1]){ const ox=a.x-uy*w.t/2*sg, oy=a.y+ux*w.t/2*sg, u=Math.max(0,Math.min(L,(x-ox)*ux+(y-oy)*uy)), px=ox+ux*u, py=oy+uy*u, d=Math.hypot(px-x,py-y); if(d<bd){ bd=d; best={x:px,y:py,kind:'face'}; } } }
  return best;
}
// какой этаж показывать: sel — 'all' или номер; в плане 'all' — первый этаж (0), в 3D — все и крыша; номер в 3D — он и всё ниже (разрез)
// «all» в 3D — дом над землёй (подвал — при выборе −1 / 0: земля не непрозрачная)
function peLvShow(sel,d3){ if(sel==='all' || sel==null) return d3 ? lv=>(lv||0)>=0 : lv=>(lv||0)===0; const k=+sel; return d3 ? lv=>(lv||0)<=k : lv=>(lv||0)===k; }
// ---------- этажи: список, создание, копия этажа, этаж устройства по высоте ----------
const peLvName=i=>i===0 ? '1' : i>0 ? String(i+1) : 'B'+(-i);
function peEnsureLevel(s,idx,h=2.7,slab=.25){ s.levels??=[]; const has=i=>s.levels.find(q=>q.idx===i); if(!s.levels.length) s.levels.push({name:'1',z:0,idx:0});
  for(let g=0;!has(idx)&&g<20;g++){ if(idx>0){ const top=Math.max(...s.levels.map(q=>q.idx)), T=has(top); s.levels.push({name:peLvName(top+1),z:+(T.z+h+slab).toFixed(3),idx:top+1}); }
    else { const bot=Math.min(...s.levels.map(q=>q.idx)), B=has(bot); s.levels.push({name:peLvName(bot-1),z:+(B.z-h-slab).toFixed(3),idx:bot-1}); } }
  return has(idx)||null; }
// высотный диапазон этажа idx: [z0, z1) — до пола следующего (верхний — без предела; нижний — без нижнего)
function peLevelRange(s,idx){ const L=(s.levels||[]).slice().sort((a,b)=>a.idx-b.idx), me=L.find(q=>q.idx===idx), up=L.find(q=>q.idx>idx), low=L.find(q=>q.idx<idx);
  return {z0:me ? (low ? me.z : -Infinity) : (idx===0 ? (low ? 0 : -Infinity) : 0),z1:up ? up.z : Infinity}; }
// виден ли предмет на высоте z при выбранном этаже: «all» в плане — этаж 0, в 3D — всё; число — этот этаж (в 3D — и нижние)
function peOnLevel(s,sel,z,d3){ if(!(s.levels||[]).length) return true; const all=sel==='all'||sel==null; if(all && d3) return true; const R=peLevelRange(s,all ? 0 : +sel); return d3 ? z<R.z1-.3 : (z>=R.z0-.3 && z<R.z1-.3); }
// копия этажа from на этаж to: точки, стены, проёмы, комнаты (устройства и камеры остаются)
function peCopyLevel(s,from,to,h=2.7){ const ws=s.walls.filter(w=>(w.lv||0)===from), rs=s.rooms.filter(r=>(r.lv||0)===from); if(!ws.length&&!rs.length) return null; const L=peEnsureLevel(s,to,h); if(!L) return null;
  const pm=new Map(), P=id=>{ if(!pm.has(id)){ const p=pePt(s,id); pm.set(id,peAddPoint(s,p.x,p.y).id); } return pm.get(id); }, wm=new Map(); let nw=0, no=0, nr=0;
  for(const w of ws){ const a=P(w.a), b=P(w.b), c=peAddWall(s,a,b,{t:w.t,h:w.h,mat:w.mat,lv:to,z0:L.z}); if(c){ wm.set(w.id,c.id); nw++; } }
  for(const o of s.objs.slice()){ if(!wm.has(o.wall)) continue; const {id,src,wall,...rest}=o; const c=peAddObj(s,o.type,{...rest,wall:wm.get(o.wall)}); if(c) no++; }
  for(const r of rs){ const c=peAddRoom(s,r.pts.map(P),r.name); for(const k of ['use','people','tin','gas','free','nofloor','noroof']) if(r[k]!=null) c[k]=r[k]; c.lv=to; c.z0=L.z; nr++; }
  return {walls:nw,openings:no,rooms:nr,level:L}; }
const peLvZ=(s,sel)=>{ const L=(s.levels||[]).find(q=>q.idx===(sel==='all' ? 0 : +sel)); return L ? L.z : 0; };
// служебные точки, которые не рисуются (при «points: auto»): концы стен из Site Plan и углы комнат, у которых нет своих стен
function peHiddenPts(s){
  const used=new Set(); for(const w of s.walls){ used.add(w.a); used.add(w.b); }
  const h=new Set(); for(const p of s.pts) if(p.src) h.add(p.id);
  for(const r of s.rooms) if(r.free) for(const id of r.pts) if(!used.has(id)) h.add(id);
  for(const p of s.pts) if(p.imp && !used.has(p.id)) h.add(p.id);                    // пришедшие извне (углы забора, газона, дороги) и не концы стен
  return h;
}
// история правок: base — последнее закреплённое состояние (JSON), u / r — стеки отмены и повтора
function peHistNew(base){ return {base:String(base),u:[],r:[]}; }
function peHistCommit(h,cur){ if(cur===h.base) return false; h.u.push(h.base); if(h.u.length>100) h.u.shift(); h.r.length=0; h.base=cur; return true; }
function peHistUndo(h,cur){ peHistCommit(h,cur); if(!h.u.length) return null; h.r.push(h.base); h.base=h.u.pop(); return h.base; }
function peHistRedo(h,cur){ peHistCommit(h,cur); if(!h.r.length) return null; h.u.push(h.base); h.base=h.r.pop(); return h.base; }
function peParse(text){ try{ const o=JSON.parse(text); if(o && Array.isArray(o.pts)){ for(const k of ['walls','objs','cams','ants','rooms','slabs','roofs','levels','grounds','elec','wires','hv','pp']) if(!Array.isArray(o[k])) o[k]=[]; if(!(o.seq>0)) o.seq=1000; return o; } }catch(e){} return peNew(); }

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
  for(const a of s.ants){ const g=peGeo(o,a.x,a.y); out.push({id:'plan:'+a.id,label:a.name+(peIsRx(a) ? ' RX '+a.sens+' dBm' : ' '+a.eirp+' dBm'),kind:'antenna',lat:+g[0].toFixed(8),lon:+g[1].toFixed(8),alt_m:+((o.alt||0)+a.z).toFixed(2),color:'#ffb74d',icon:'dot',az:+peAzTrue(o,a.az).toFixed(1),bw:a.bw,role:a.role||'tx',freq_mhz:a.f,...(peIsRx(a) ? {gain_dbi:a.gain,sens_dbm:a.sens} : {eirp:a.eirp})}); }
  for(const p of s.pts){ const g=peGeo(o,p.x,p.y); out.push({id:'plan:'+p.id,label:p.name||'',kind:'plan point',lat:+g[0].toFixed(8),lon:+g[1].toFixed(8),alt_m:+(o.alt||0).toFixed(2),x:+p.x.toFixed(3),y:+p.y.toFixed(3),color:'#9fb0b6',icon:'dot'}); }
  return out;
}

// ---------- экспорт: SVG (чертёж с толщинами) и DXF (2D и 3D) ----------
// сплошные прямоугольники стен [x,y]×4 по частям (без проёмов) + ящики / колонны — для чертежа
function peSolidRects(s){
  const out=[];
  for(const b of peBoxes(s)){ const nx=-b.uy, ny=b.ux, h=b.l/2, q=b.t/2; out.push({kind:b.kind,ref:b.ref,z0:b.z0,z1:b.z1,c:[[b.cx+b.ux*h+nx*q,b.cy+b.uy*h+ny*q],[b.cx+b.ux*h-nx*q,b.cy+b.uy*h-ny*q],[b.cx-b.ux*h-nx*q,b.cy-b.uy*h-ny*q],[b.cx-b.ux*h+nx*q,b.cy-b.uy*h+ny*q]]}); }
  return out;
}
const peF=(v,d=3)=>String(+(+v).toFixed(d));
const peFx=(v,d)=>(+v).toFixed(d);                           // с хвостовыми нулями — для подписей
const peEsc=t=>String(t).replace(/[<&>"]/g,c=>'&#'+c.charCodeAt(0)+';');
// opt: scale (знаменатель масштаба, 50 → 1:50), dims (размеры стен), devices (камеры и антенны), coverage (зоны камер), rooms (подписи комнат)
function peSVG(s,opt={}){
  const b=peBounds(s,.8); if(!b) return '';
  const sc=opt.scale>0 ? opt.scale : 50, W=b.x1-b.x0, H=b.y1-b.y0, o=[];
  const T=(x,y)=>peF(x)+','+peF(-y);                                  // y вверх → вниз
  o.push('<svg xmlns="http://www.w3.org/2000/svg" width="'+peF(W*1000/sc,1)+'mm" height="'+peF(H*1000/sc,1)+'mm" viewBox="'+peF(b.x0)+' '+peF(-b.y1)+' '+peF(W)+' '+peF(H)+'" font-family="sans-serif">');
  o.push('<rect x="'+peF(b.x0)+'" y="'+peF(-b.y1)+'" width="'+peF(W)+'" height="'+peF(H)+'" fill="#fff"/>');
  const txt=(x,y,t,size,o2={})=>'<text transform="translate('+peF(x)+','+peF(-y)+') rotate('+peF(-(o2.rot||0),1)+')" font-size="'+size+'" text-anchor="middle"'+(o2.fill?' fill="'+o2.fill+'"':'')+(o2.bold?' font-weight="bold"':'')+'>'+peEsc(t)+'</text>';
  if(opt.rooms!==false) for(const r of s.rooms){ const P=peRoomPoly(s,r); o.push('<polygon points="'+P.map(q=>T(q[0],q[1])).join(' ')+'" fill="#eef6fb" stroke="none"/>'); }
  if(opt.coverage) for(const c of s.cams){ const P=peVisPoly(c,peOccluders(s),2); o.push('<polygon points="'+P.map(q=>T(q[0],q[1])).join(' ')+'" fill="#4caf50" fill-opacity=".18" stroke="#4caf50" stroke-width=".02"/>'); }
  for(const r of peSolidRects(s)) o.push('<polygon points="'+r.c.map(q=>T(q[0],q[1])).join(' ')+'" fill="'+(r.kind==='wall' ? '#8c9499' : r.kind==='box' ? '#d9b38c' : '#aab2b7')+'" stroke="#222" stroke-width=".015"/>');
  for(const ob of s.objs){ if(ob.type!=='door'&&ob.type!=='window') continue; const pl=peOpenPlace(s,ob); if(!pl) continue; const h=ob.w/2, ax=pl.x-pl.ux*h, ay=pl.y-pl.uy*h, bx=pl.x+pl.ux*h, by=pl.y+pl.uy*h, nx=-pl.uy, ny=pl.ux, q=pl.t/2;
    if(ob.type==='window'){ for(const k of [-1,0,1]) o.push('<line x1="'+peF(ax+nx*q*k*.6)+'" y1="'+peF(-(ay+ny*q*k*.6))+'" x2="'+peF(bx+nx*q*k*.6)+'" y2="'+peF(-(by+ny*q*k*.6))+'" stroke="#2a7fb8" stroke-width=".02"/>'); }
    else { const r=ob.w, ex=ax+nx*r, ey=ay+ny*r; o.push('<line x1="'+peF(ax)+'" y1="'+peF(-ay)+'" x2="'+peF(ex)+'" y2="'+peF(-ey)+'" stroke="#7a5a2a" stroke-width=".03"/><path d="M '+peF(ex)+' '+peF(-ey)+' A '+peF(r)+' '+peF(r)+' 0 0 '+(1)+' '+peF(bx)+' '+peF(-by)+'" fill="none" stroke="#7a5a2a" stroke-width=".015" stroke-dasharray=".06 .04"/>'); } }
  if(opt.rooms!==false) for(const r of s.rooms){ const P=peRoomPoly(s,r), cx=P.reduce((a,q)=>a+q[0],0)/P.length, cy=P.reduce((a,q)=>a+q[1],0)/P.length; o.push(txt(cx,cy,(r.name||'')+'  '+peFx(peRoomArea(s,r),1)+' m²',.22,{fill:'#345'})); }
  if(opt.dims!==false) for(const w of s.walls){ const [a,c]=peWallEnds(s,w), L=peWallLen(s,w), ang=Math.atan2(c.y-a.y,c.x-a.x)/PE_D, nx=-(c.y-a.y)/L, ny=(c.x-a.x)/L, off=w.t/2+.18; let rot=ang; if(rot>90||rot<-90) rot+=180; o.push(txt((a.x+c.x)/2+nx*off,(a.y+c.y)/2+ny*off,peFx(L,2)+(w.len>0 ? ' 🔒' : ''),.16,{rot,fill:'#555'})); }
  if(opt.devices!==false){
    for(const c of s.cams){ o.push('<polygon points="'+[[0,.12],[-.1,-.1],[.1,-.1]].map(q=>{ const a=c.az*PE_D, x=q[0]*Math.cos(a)+q[1]*Math.sin(a), y=-q[0]*Math.sin(a)+q[1]*Math.cos(a); return T(c.x+x,c.y+y); }).join(' ')+'" fill="#2e7d32"/>'); o.push(txt(c.x,c.y+.3,c.name,.15,{fill:'#2e7d32'})); }
    for(const a of s.ants){ o.push('<circle cx="'+peF(a.x)+'" cy="'+peF(-a.y)+'" r=".1" fill="#ef6c00"/>'); o.push(txt(a.x,a.y+.3,a.name+' '+a.eirp+' dBm',.15,{fill:'#ef6c00'})); } }
  // масштабная линейка 1 м и север
  const bx=b.x0+.3, by=b.y0+.3; o.push('<g stroke="#000" stroke-width=".03"><line x1="'+peF(bx)+'" y1="'+peF(-by)+'" x2="'+peF(bx+1)+'" y2="'+peF(-by)+'"/><line x1="'+peF(bx)+'" y1="'+peF(-by-.05)+'" x2="'+peF(bx)+'" y2="'+peF(-by+.05)+'"/><line x1="'+peF(bx+1)+'" y1="'+peF(-by-.05)+'" x2="'+peF(bx+1)+'" y2="'+peF(-by+.05)+'"/></g>'+txt(bx+.5,by+.1,'1 m   (1:'+sc+')',.14));
  if(opt.north!==undefined){ const nx=b.x1-.4, ny=b.y1-.6, a=(opt.north||0)*PE_D; o.push('<g stroke="#000" stroke-width=".03"><line x1="'+peF(nx)+'" y1="'+peF(-ny)+'" x2="'+peF(nx+Math.sin(-a)*.4)+'" y2="'+peF(-(ny+Math.cos(a)*.4))+'"/></g>'+txt(nx+Math.sin(-a)*.55,ny+Math.cos(a)*.55,'N',.16,{bold:true})); }
  o.push('</svg>'); return o.join('\n');
}
// DXF R12: слои WALLS / DOORS / WINDOWS / OBJECTS / ROOMS / CAMERAS / ANTENNAS / TEXT; three — ещё 3D-грани (3DFACE) стен и объектов на слое WALLS3D
function peDXF(s,opt={}){
  const L=[], g=(c,v)=>{ L.push(String(c),String(v)); }, f=v=>peF(v,4);
  const layers=[['WALLS',8],['DOORS',30],['WINDOWS',4],['OBJECTS',32],['ROOMS',5],['CAMERAS',3],['ANTENNAS',2],['TEXT',7],['WALLS3D',9]];
  g(0,'SECTION'); g(2,'HEADER'); g(9,'$ACADVER'); g(1,'AC1009'); g(9,'$INSUNITS'); g(70,6); g(0,'ENDSEC');
  g(0,'SECTION'); g(2,'TABLES'); g(0,'TABLE'); g(2,'LAYER'); g(70,layers.length);
  for(const [n,c] of layers){ g(0,'LAYER'); g(2,n); g(70,0); g(62,c); g(6,'CONTINUOUS'); } g(0,'ENDTAB'); g(0,'ENDSEC');
  g(0,'SECTION'); g(2,'ENTITIES');
  const poly=(layer,P,closed=true,z=0)=>{ g(0,'POLYLINE'); g(8,layer); g(66,1); g(70,closed ? 1 : 0); for(const q of P){ g(0,'VERTEX'); g(8,layer); g(10,f(q[0])); g(20,f(q[1])); g(30,f(z)); } g(0,'SEQEND'); g(8,layer); };
  const text=(layer,x,y,h,t)=>{ g(0,'TEXT'); g(8,layer); g(10,f(x)); g(20,f(y)); g(30,0); g(40,h); g(1,t); };
  const rects=peSolidRects(s);
  for(const r of rects) poly(r.kind==='wall' ? 'WALLS' : 'OBJECTS',r.c);
  for(const ob of s.objs){ if(ob.type!=='door'&&ob.type!=='window') continue; const pl=peOpenPlace(s,ob); if(!pl) continue; const h=ob.w/2, ax=pl.x-pl.ux*h, ay=pl.y-pl.uy*h, bx=pl.x+pl.ux*h, by=pl.y+pl.uy*h, nx=-pl.uy, ny=pl.ux, q=pl.t/2;
    if(ob.type==='window'){ for(const k of [-1,1]) poly('WINDOWS',[[ax+nx*q*k,ay+ny*q*k],[bx+nx*q*k,by+ny*q*k]],false); }
    else { const a0=Math.atan2(by-ay,bx-ax)/PE_D; g(0,'LINE'); g(8,'DOORS'); g(10,f(ax)); g(20,f(ay)); g(30,0); g(11,f(ax+nx*ob.w)); g(21,f(ay+ny*ob.w)); g(31,0); g(0,'ARC'); g(8,'DOORS'); g(10,f(ax)); g(20,f(ay)); g(30,0); g(40,f(ob.w)); g(50,f(peWrap360(a0))); g(51,f(peWrap360(a0+90))); } }
  for(const r of s.rooms){ const P=peRoomPoly(s,r); poly('ROOMS',P); text('TEXT',P.reduce((a,q)=>a+q[0],0)/P.length,P.reduce((a,q)=>a+q[1],0)/P.length,.25,(r.name||'')+' '+peFx(peRoomArea(s,r),1)+' m2'); }
  for(const c of s.cams){ poly('CAMERAS',peVisPoly(c,peOccluders(s),2)); g(0,'POINT'); g(8,'CAMERAS'); g(10,f(c.x)); g(20,f(c.y)); g(30,f(c.z)); text('TEXT',c.x+.1,c.y+.1,.15,c.name); }
  for(const a of s.ants){ g(0,'POINT'); g(8,'ANTENNAS'); g(10,f(a.x)); g(20,f(a.y)); g(30,f(a.z)); text('TEXT',a.x+.1,a.y+.1,.15,a.name+' '+a.eirp+' dBm'); }
  if(opt.three) for(const b of peBoxes(s)){ const nx=-b.uy, ny=b.ux, h=b.l/2, q=b.t/2, C=[[b.cx+b.ux*h+nx*q,b.cy+b.uy*h+ny*q],[b.cx+b.ux*h-nx*q,b.cy+b.uy*h-ny*q],[b.cx-b.ux*h-nx*q,b.cy-b.uy*h-ny*q],[b.cx-b.ux*h+nx*q,b.cy-b.uy*h+ny*q]];
    const face=(P)=>{ g(0,'3DFACE'); g(8,'WALLS3D'); for(let i=0;i<4;i++){ g(10+i,f(P[i][0])); g(20+i,f(P[i][1])); g(30+i,f(P[i][2])); } };
    face(C.map(c=>[c[0],c[1],b.z1])); face(C.map(c=>[c[0],c[1],b.z0]));
    for(let i=0;i<4;i++){ const p=C[i], r=C[(i+1)%4]; face([[p[0],p[1],b.z0],[r[0],r[1],b.z0],[r[0],r[1],b.z1],[p[0],p[1],b.z1]]); } }
  g(0,'ENDSEC'); g(0,'EOF'); return L.join('\n')+'\n';
}

// ---------- автоподбор мест камер и антенн ----------
// Задача максимального охвата: клетки комнат (с весами — у дверей и окон важнее), кандидаты «позиция × азимут» знают, какие клетки закроют;
// жадный выбор берёт кандидата с наибольшим выигрышем, потом несколько проходов замен улучшают набор (каждый по очереди переставляется при остальных на месте).
// Это приближение (1 − 1/e) к оптимуму, на практике близко к нему. Генераторы отдают {phase, done, total} — вызывающий делит работу по времени; peRunGen доводит до конца.
function peRunGen(gen){ for(;;){ const r=gen.next(); if(r.done) return r.value; } }
// клетки внутри комнат: {g, k (индексы), x, y, w (веса), W (сумма)}; doors — вес 3 в радиусе 1,5 м от двери / окна
function peRoomCells(s,cell,doors){
  const g=peGrid(s,cell,120); if(!g || !s.rooms.length) return null;
  const polys=s.rooms.map(r=>peRoomPoly(s,r)), op=doors ? s.objs.filter(o=>o.type==='door'||o.type==='window').map(o=>peOpenPlace(s,o)).filter(Boolean) : [];
  const k=[], x=[], y=[], w=[]; let W=0;
  for(let j=0;j<g.ny;j++) for(let i=0;i<g.nx;i++){ const cx=g.x0+(i+.5)*g.cell, cy=g.y0+(j+.5)*g.cell; if(!polys.some(P=>peInPoly(P,cx,cy))) continue;
    let wt=1; for(const o of op) if(Math.hypot(cx-o.x,cy-o.y)<1.5){ wt=3; break; } k.push(j*g.nx+i); x.push(cx); y.push(cy); w.push(wt); W+=wt; }
  return {g,k,x,y,w,W,n:k.length};
}
function pePosDedupe(P,r=.15){ const out=[]; for(const p of P) if(!out.some(q=>Math.hypot(q[0]-p[0],q[1]-p[1])<r)) out.push(p); return out; }
function peMountPoints(s,mode,step=.6){
  const out=[], inRoom=(x,y)=>peInRooms(s,x,y);
  if(mode!=='anywhere'){
    for(const r of s.rooms){ const P=peRoomPoly(s,r), cx=P.reduce((a,q)=>a+q[0],0)/P.length, cy=P.reduce((a,q)=>a+q[1],0)/P.length;
      for(const q of P){ const d=Math.hypot(cx-q[0],cy-q[1])||1, x=q[0]+(cx-q[0])/d*.25, y=q[1]+(cy-q[1])/d*.25; if(inRoom(x,y)) out.push([x,y]); } }
  }
  if(mode==='walls'){
    for(const w of s.walls){ const [a,b]=peWallEnds(s,w), L=Math.hypot(b.x-a.x,b.y-a.y), ux=(b.x-a.x)/L, uy=(b.y-a.y)/L, parts=peWallParts(s,w), off=w.t/2+.08;
      for(let u=step/2;u<L;u+=step){ if(parts.open.some(o=>u>o.s0-.3 && u<o.s1+.3)) continue; for(const sg of [-1,1]){ const x=a.x+ux*u-uy*off*sg, y=a.y+uy*u+ux*off*sg; if(inRoom(x,y)) out.push([x,y]); } } }
  }
  if(mode==='anywhere'){ const g=peGrid(s,1,60); if(g) for(let j=0;j<g.ny;j++) for(let i=0;i<g.nx;i++){ const x=g.x0+(i+.5)*g.cell, y=g.y0+(j+.5)*g.cell; if(inRoom(x,y)) out.push([x,y]); } }
  return pePosDedupe(out);
}
// общий жадный отбор + замены. cands: [{x,y,az,cells:Int32Array}]; pre — Uint8Array уже покрытых (стоящие камеры / антенны)
function* peGreedy(cands,w,W,pre,opt){
  const n=w.length, cnt=new Uint8Array(n); for(let i=0;i<n;i++) cnt[i]=pre[i] ? 1 : 0;
  const gainOf=c=>{ let g=0; const L=c.cells; for(let i=0;i<L.length;i++){ const k=L[i]; if(!cnt[k]) g+=w[k]; } return g; };
  const coverW=()=>{ let c=0; for(let i=0;i<n;i++) if(cnt[i]) c+=w[i]; return c; };
  const chosen=[], curve=[], base=coverW()/W; let t0=performance_now();
  const maxN=opt.n>0 ? opt.n : 64;
  for(let it=0;it<maxN;it++){
    let best=null, bg=1e-9; for(let ci=0;ci<cands.length;ci++){ const g=gainOf(cands[ci]); if(g>bg){ bg=g; best=cands[ci]; } if(performance_now()-t0>12){ yield {phase:'choose',done:it,total:maxN}; t0=performance_now(); } }
    if(!best) break;
    for(const k of best.cells) cnt[k]++; chosen.push(best); curve.push(coverW()/W);
    if(opt.target>0 && curve[curve.length-1]>=opt.target-1e-9 && !(opt.n>0 && chosen.length<opt.n && false)) break;
  }
  // замены: по очереди снимаем один выбранный и ищем лучшую замену при остальных на месте
  if(opt.refine!==false) for(let pass=0;pass<2;pass++){ let moved=false;
    for(let i=0;i<chosen.length;i++){ for(const k of chosen[i].cells) cnt[k]--; let best=chosen[i], bg=gainOf(best);
      for(const c of cands){ const g=gainOf(c); if(g>bg+1e-9){ bg=g; best=c; } if(performance_now()-t0>12){ yield {phase:'refine',done:pass*chosen.length+i,total:2*chosen.length}; t0=performance_now(); } }
      if(best!==chosen[i]){ chosen[i]=best; moved=true; } for(const k of best.cells) cnt[k]++; }
    if(!moved) break; }
  const final=coverW()/W; if(curve.length) curve[curve.length-1]=final;
  return {chosen,curve,cover:final,base};
}
const performance_now=()=>typeof performance!=='undefined' ? performance.now() : Date.now();
// камеры: tpl {z, tilt, fov, range}; opt {n, target (0…1), mount, azStep, cell, doors, refine}. Стоящие камеры (без auto) считаются уже установленными.
function* peCamPlan(s,opt){
  const tpl=opt.tpl, rc=peRoomCells(s,opt.cell||.5,opt.doors); if(!rc) return {error:'draw at least one room first (a closed contour of walls)'};
  const occ=peOccluders(s), pre=new Uint8Array(rc.n), fixed=s.cams.filter(c=>!c.auto);
  for(let i=0;i<rc.n;i++) for(const c of fixed) if(peSees(c,rc.x[i],rc.y[i],occ)){ pre[i]=1; break; }
  let P=peMountPoints(s,opt.mount||'walls'); if(P.length>400) P=P.filter((_,i)=>i%Math.ceil(P.length/400)===0);
  const azStep=opt.azStep||15, v=tpl.fov*.5625, cands=[]; let t0=performance_now();
  for(let pi=0;pi<P.length;pi++){
    const [px,py]=P[pi], vis=[];
    for(let i=0;i<rc.n;i++){ const dx=rc.x[i]-px, dy=rc.y[i]-py, d=Math.hypot(dx,dy); if(d>tpl.range||d<.05) continue; const dep=Math.atan2(tpl.z-1,d)/PE_D; if(dep<tpl.tilt-v/2||dep>tpl.tilt+v/2) continue;
      if(peBlocked(occ,px,py,rc.x[i],rc.y[i],.02)) continue; vis.push([i,Math.atan2(dx,dy)/PE_D]); }
    for(let az=0;az<360;az+=azStep){ const L=[]; for(const [i,b] of vis) if(Math.abs(peWrap180(b-az))<=tpl.fov/2) L.push(i); if(L.length) cands.push({x:px,y:py,az,cells:Int32Array.from(L)}); }
    if(performance_now()-t0>12){ yield {phase:'visibility',done:pi,total:P.length}; t0=performance_now(); }
  }
  const r=yield* peGreedy(cands,rc.w,rc.W,pre,opt);
  return {...r,cams:r.chosen.map(c=>({x:+c.x.toFixed(3),y:+c.y.toFixed(3),az:c.az})),positions:P.length,candidates:cands.length,cells:rc.n,area:rc.n*rc.g.cell*rc.g.cell};
}
// антенны: tpl {z, eirp, f, bw}; opt {n, target, thr (дБм), step, cell, refine}. Кандидаты — сетка внутри комнат не ближе 0,3 м к стенам.
function* peAntPlan(s,opt){
  const tpl=opt.tpl, rc=peRoomCells(s,opt.cell||.5,false); if(!rc) return {error:'draw at least one room first (a closed contour of walls)'};
  const thr=opt.thr??-70, pre=new Uint8Array(rc.n), fixed=s.ants.filter(a=>!a.auto && !peIsRx(a));
  for(let i=0;i<rc.n;i++) for(const a of fixed) if(peAntLevel(s,a,rc.x[i],rc.y[i])>=thr){ pre[i]=1; break; }
  const step=opt.step||.75, g=peGrid(s,step,80), cands=[]; let t0=performance_now(), done=0, total=0;
  const spots=[]; if(g) for(let j=0;j<g.ny;j++) for(let i=0;i<g.nx;i++){ const x=g.x0+(i+.5)*g.cell, y=g.y0+(j+.5)*g.cell; if(!peInRooms(s,x,y)) continue; let near=1e9; for(const w of s.walls){ const [a,b]=peWallEnds(s,w), dx=b.x-a.x, dy=b.y-a.y, u=Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/(dx*dx+dy*dy||1))); near=Math.min(near,Math.hypot(x-a.x-dx*u,y-a.y-dy*u)); } if(near>=.3) spots.push([x,y]); }
  total=spots.length; const azs=tpl.bw<360 ? [0,45,90,135,180,225,270,315] : [0];
  for(const [x,y] of spots){ for(const az of azs){ const a={...tpl,x,y,az}, L=[]; for(let i=0;i<rc.n;i++) if(peAntLevel(s,a,rc.x[i],rc.y[i])>=thr) L.push(i); if(L.length) cands.push({x,y,az,cells:Int32Array.from(L)}); }
    done++; if(performance_now()-t0>12){ yield {phase:'signal',done,total}; t0=performance_now(); } }
  const r=yield* peGreedy(cands,rc.w,rc.W,pre,opt);
  return {...r,ants:r.chosen.map(c=>({x:+c.x.toFixed(3),y:+c.y.toFixed(3),az:c.az})),positions:spots.length,candidates:cands.length,cells:rc.n,area:rc.n*rc.g.cell*rc.g.cell,thr};
}
// применить результат: прежние auto-устройства того же вида убираются, новые помечаются auto
function peApplyPlan(s,res,kind,tpl){
  if(kind==='cam'){ s.cams=s.cams.filter(c=>!c.auto); res.cams.forEach((c,i)=>{ const o=peAddCam(s,c.x,c.y,{...tpl,az:c.az,name:'Cam auto '+(i+1)}); o.auto=1; }); }
  else { s.ants=s.ants.filter(a=>!a.auto); res.ants.forEach((c,i)=>{ const o=peAddAnt(s,c.x,c.y,{...tpl,az:c.az,name:'AP auto '+(i+1)}); o.auto=1; }); }
}
function peClearAuto(s){ const n=s.cams.filter(c=>c.auto).length+s.ants.filter(a=>a.auto).length; s.cams=s.cams.filter(c=>!c.auto); s.ants=s.ants.filter(a=>!a.auto); return n; }

// ---------- порядок рисования блоков (алгоритм художника без ошибок «длинная стена перед ящиком») ----------
// Сортировка по центру ломается, когда протяжённый блок (стена) по центру далеко, а краем стоит перед близким. Вместо этого каждая пара блоков сравнивается по
// разделяющей оси (у выпуклых ориентированных прямоугольников она есть среди четырёх нормалей): какая сторона ближе к зрителю — тот и рисуется позже;
// потом топологическая сортировка. На виде сверху (горизонтальной составляющей взгляда нет) порядок — по высоте: нижний раньше.
// ---------- вид из камеры (3D) ----------
// базис камеры: f — куда смотрит (азимут от севера по часовой, наклон вниз), r — вправо, u — вверх
function peCamBasis(c){ const a=(c.az||0)*PE_D, t=(c.tilt||0)*PE_D, f=[Math.sin(a)*Math.cos(t),Math.cos(a)*Math.cos(t),-Math.sin(t)], r=[Math.cos(a),-Math.sin(a),0];
  return {f,r,u:[r[1]*f[2]-r[2]*f[1],r[2]*f[0]-r[0]*f[2],r[0]*f[1]-r[1]*f[0]]}; }
// сцена многоугольниками в мире: земля, покрытия участка, полы комнат, стены / ящики / колонны (все грани), перекрытия, крыша
function peScenePolys(s){
  const out=[], b=peBounds(s,30); if(!b) return out;
  out.push({pts:[[b.x0,b.y0,-.002],[b.x1,b.y0,-.002],[b.x1,b.y1,-.002],[b.x0,b.y1,-.002]],rgb:[150,160,140]});
  const GC={asphalt:[95,98,104],gravel:[170,165,150],tile:[196,170,146],grass:[120,175,90],garden:[150,115,70],water:[90,150,210]};
  for(const g of s.grounds||[]) out.push({pts:g.poly.map(q=>[q[0],q[1],.004]),rgb:GC[g.cover]||GC.grass});
  for(const r of s.rooms){ const z=(r.z0||0)+.006; out.push({pts:peRoomPoly(s,r).map(q=>[q[0],q[1],z]),rgb:[206,202,190]}); }
  for(const bx of peBoxes(s)){ const C=peBoxCorners(bx), rgb=bx.kind==='wall' ? (PE_MATCOL[bx.mat]||[200,208,214]) : bx.kind==='box' ? [201,143,90] : [160,168,173];
    out.push({pts:C.map(c=>[c[0],c[1],bx.z1]),rgb},{pts:C.map(c=>[c[0],c[1],bx.z0]).reverse(),rgb});
    for(let i=0;i<4;i++){ const p=C[i], q=C[(i+1)%4]; out.push({pts:[[p[0],p[1],bx.z0],[q[0],q[1],bx.z0],[q[0],q[1],bx.z1],[p[0],p[1],bx.z1]],rgb}); } }
  for(const sl of s.slabs||[]){ const rgb=PE_MATCOL[sl.mat]||[168,174,180]; out.push({pts:sl.poly.map(q=>[q[0],q[1],sl.z]),rgb},{pts:sl.poly.map(q=>[q[0],q[1],sl.z-(sl.t||.25)]),rgb}); }
  for(const r of s.roofs||[]) for(const f of r.faces) out.push({pts:f.pts,rgb:f.kind==='roof' ? [150,78,64] : (PE_MATCOL[r.wallMat]||[200,208,214])});
  return out;
}
// отрезать многоугольник по плоскости (n·p ≥ d) — Сазерленд — Ходжмен
function peClipPlane(P,n,d){ const out=[], val=p=>p[0]*n[0]+p[1]*n[1]+p[2]*n[2]-d;
  for(let i=0;i<P.length;i++){ const a=P[i], b=P[(i+1)%P.length], va=val(a), vb=val(b);
    if(va>=0) out.push(a); if((va>=0)!==(vb>=0)){ const t=va/(va-vb); out.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t]); } }
  return out; }
// картинка из камеры c (x, y, z, az, tilt, fov — по горизонтали, 16:9): RGBA W×H, глубина — 1/расстояние (линейна на экране для перспективы)
function peCamView(s,c,W,H,opt={}){
  const {f,r,u}=peCamBasis(c), fx=(W/2)/Math.tan(Math.max(5,Math.min(170,c.fov||90))*PE_D/2), near=.05, ox=c.x, oy=c.y, oz=c.z;
  const proj=(x,y,z)=>{ const dx=x-ox, dy=y-oy, dz=z-oz, F=dx*f[0]+dy*f[1]+dz*f[2], X=dx*r[0]+dy*r[1]+dz*r[2], Y=dx*u[0]+dy*u[1]+dz*u[2]; return [W/2+X/F*fx,H/2-Y/F*fx,-1/F]; };
  const dN=ox*f[0]+oy*f[1]+oz*f[2]+near, polys=[];
  for(const q of opt.polys||peScenePolys(s)){ const P=peClipPlane(q.pts,f,dN); if(P.length>=3) polys.push({pts:P,rgb:q.rgb}); }
  return peZRaster([],proj,W,H,{cam:[0,0],ce:1,color:()=>[0,0,0],polys,crease:.0015,seal:0});
}
function peBoxCorners(b){ const nx=-b.uy, ny=b.ux, h=b.l/2, q=b.t/2; return [[b.cx+b.ux*h+nx*q,b.cy+b.uy*h+ny*q],[b.cx+b.ux*h-nx*q,b.cy+b.uy*h-ny*q],[b.cx-b.ux*h-nx*q,b.cy-b.uy*h-ny*q],[b.cx-b.ux*h+nx*q,b.cy-b.uy*h+ny*q]]; }
// 1 — a рисуется раньше b (b ближе к зрителю); -1 — наоборот; 0 — порядок не важен. view: {dx, dy — горизонтальное направление на зрителя (единичное), h — доля горизонтальной составляющей взгляда (cos угла места)}
function peBefore(a,b,ca,cb,view){
  const eps=1e-6; let best=null;
  if(view.h>.12) for(const [ax,ay] of [[a.ux,a.uy],[-a.uy,a.ux],[b.ux,b.uy],[-b.uy,b.ux]]){
    let a0=1e99,a1=-1e99,b0=1e99,b1=-1e99; for(const c of ca){ const v=c[0]*ax+c[1]*ay; if(v<a0)a0=v; if(v>a1)a1=v; } for(const c of cb){ const v=c[0]*ax+c[1]*ay; if(v<b0)b0=v; if(v>b1)b1=v; }
    const sc=Math.abs(view.dx*ax+view.dy*ay); if(sc<.05) continue;
    if(a1<=b0+eps){ if(!best||sc>best.sc) best={sc,aNeg:true,dot:view.dx*ax+view.dy*ay}; }
    else if(b1<=a0+eps){ if(!best||sc>best.sc) best={sc,aNeg:false,dot:view.dx*ax+view.dy*ay}; }
  }
  if(best){ const viewerOnPositive=best.dot>0; return best.aNeg ? (viewerOnPositive ? 1 : -1) : (viewerOnPositive ? -1 : 1); }
  if(a.z1<=b.z0+eps) return 1; if(b.z1<=a.z0+eps) return -1; return 0;
}
// индексы блоков в порядке рисования (дальние раньше); depth(b) — запасной ключ для несравнимых пар
function peBoxOrder(B,view,depth){
  const n=B.length, C=B.map(peBoxCorners), out=[[]], adj=Array.from({length:n},()=>[]), indeg=new Int32Array(n);
  for(let i=0;i<n;i++) for(let j=i+1;j<n;j++){ const r=peBefore(B[i],B[j],C[i],C[j],view); if(r===1){ adj[i].push(j); indeg[j]++; } else if(r===-1){ adj[j].push(i); indeg[i]++; } }
  const key=B.map(b=>depth(b)), ready=[]; for(let i=0;i<n;i++) if(!indeg[i]) ready.push(i);
  const res=[], used=new Uint8Array(n);
  while(res.length<n){
    if(!ready.length){ let m=-1; for(let i=0;i<n;i++) if(!used[i] && (m<0||key[i]>key[m])) m=i; ready.push(m); indeg[m]=0; }          // цикл: берём самый дальний
    ready.sort((p,q)=>key[q]-key[p]); const i=ready.shift(); if(used[i]) continue; used[i]=1; res.push(i);
    for(const j of adj[i]){ indeg[j]--; if(indeg[j]<=0 && !used[j] && !ready.includes(j)) ready.push(j); }
  }
  return res;
}

// ---------- пересечения объёмов ----------
// ящик / колонна, вошедшие в стену, дают неверный порядок рисования в 3D (объёмы пересекаются) и просто неверный план: находим такие пары
function peRectsOverlap(ca,cb,eps=1e-4){
  for(const R of [ca,cb]) for(let i=0;i<4;i++){ const p=R[i], q=R[(i+1)%4], nx=-(q[1]-p[1]), ny=q[0]-p[0]; let a0=1e99,a1=-1e99,b0=1e99,b1=-1e99;
    for(const c of ca){ const v=c[0]*nx+c[1]*ny; if(v<a0)a0=v; if(v>a1)a1=v; } for(const c of cb){ const v=c[0]*nx+c[1]*ny; if(v<b0)b0=v; if(v>b1)b1=v; }
    const sc=Math.hypot(nx,ny)||1; if(a1<=b0+eps*sc || b1<=a0+eps*sc) return false; }
  return true;
}
function peOverlaps(s){
  const B=peBoxes(s), out=[], seen=new Set();
  for(const o of B){ if(o.kind==='wall') continue; const co=peBoxCorners(o);
    for(const w of B){ if(w.kind!=='wall' || w.z1<=o.z0+1e-6 || o.z1<=w.z0+1e-6) continue; if(peRectsOverlap(co,peBoxCorners(w))){ const k=o.ref+'|'+w.ref; if(!seen.has(k)){ seen.add(k); out.push({obj:o.ref,wall:w.ref}); } } } }
  return out;
}

// ---------- 3D с z-буфером ----------
// Порядок рисования блоков (peBoxOrder) не годится для пересекающихся объёмов и циклических расположений; z-буфер не зависит от порядка вовсе:
// каждая грань закрашивает пиксели, где она ближе всего. Проекция ортографическая, значит глубина по экрану линейна, и по каждой грани она задаётся плоскостью.
// B — блоки (peBoxes), proj(x,y,z) → [sx, sy, depth] (чем меньше depth, тем ближе), W×H — размер, o: {cam:[dx,dy] горизонталь на зрителя, ce: cos угла места, sel: Set ref, color(b)→[r,g,b], edge: true}
function peZRaster(B,proj,W,H,o){
  const img=new Uint8ClampedArray(W*H*4), zb=new Float32Array(W*H).fill(Infinity), gid=new Int32Array(W*H), cam=o.cam, ce=o.ce, L=o.light||[.5,-.8];
  const fill=(V,rgb)=>{
    // плоскость глубины d = a·x + b·y + c по трём несовпадающим вершинам
    const [p0,p1,p2]=V, ux=p1[0]-p0[0], uy=p1[1]-p0[1], vx=p2[0]-p0[0], vy=p2[1]-p0[1], det=ux*vy-uy*vx; if(Math.abs(det)<1e-9) return;
    const G=((rgb[0]>>3)<<16|(rgb[1]>>3)<<8|(rgb[2]>>3))+1;     // оттенок огрублён: почти параллельные грани (доли градуса) — одна группа                  // группа: один цвет = одна ориентация и вид; одна плоскость двух блоков сливается
    const du=p1[2]-p0[2], dv=p2[2]-p0[2], a=(du*vy-dv*uy)/det, bq=(dv*ux-du*vx)/det, c=p0[2]-a*p0[0]-bq*p0[1];
    let y0=1e9,y1=-1e9; for(const q of V){ if(q[1]<y0)y0=q[1]; if(q[1]>y1)y1=q[1]; }
    const ys=Math.max(0,Math.ceil(y0-.5)), ye=Math.min(H-1,Math.floor(y1-.5));
    for(let y=ys;y<=ye;y++){
      const yc=y+.5; let xa=1e9,xb=-1e9;
      for(let i=0;i<V.length;i++){ const p=V[i], q=V[(i+1)%V.length]; if((p[1]<=yc&&q[1]>yc)||(q[1]<=yc&&p[1]>yc)){ const x=p[0]+(yc-p[1])/(q[1]-p[1])*(q[0]-p[0]); if(x<xa)xa=x; if(x>xb)xb=x; } }
      const xs=Math.max(0,Math.ceil(xa-.5)), xe=Math.min(W-1,Math.floor(xb-.5));
      for(let x=xs;x<=xe;x++){ const d=a*(x+.5)+bq*yc+c, k=y*W+x; if(d<=zb[k]){ zb[k]=d; gid[k]=G; const j=k*4; img[j]=rgb[0]; img[j+1]=rgb[1]; img[j+2]=rgb[2]; img[j+3]=255; } }
    }
  };
  const edge=(p,q,rgb)=>{ const n=Math.ceil(Math.max(Math.abs(q[0]-p[0]),Math.abs(q[1]-p[1]))); for(let i=0;i<=n;i++){ const t=n ? i/n : 0, x=Math.round(p[0]+(q[0]-p[0])*t-.5), y=Math.round(p[1]+(q[1]-p[1])*t-.5); if(x<0||y<0||x>=W||y>=H) continue; const d=p[2]+(q[2]-p[2])*t, k=y*W+x; if(d<=zb[k]+.02){ const j=k*4; img[j]=rgb[0]; img[j+1]=rgb[1]; img[j+2]=rgb[2]; img[j+3]=255; } } };
  const faces=[];
  const seal=o.seal??.01;                                              // стены чуть длиннее (только на картинке): миллиметровые щели стыков не светятся швом
  for(const b0 of B){
    const b=b0.kind==='wall' && seal ? {...b0,l:b0.l+2*seal} : b0;
    const C=peBoxCorners(b), base=o.color(b), sel=o.sel&&o.sel.has(b.ref), shade=k=>base.map(v=>Math.round(Math.min(255,v*k+(sel?40:0))));
    const top=C.map(c=>proj(c[0],c[1],b.z1)); faces.push([top,shade(.95)]);
    const nx=-b.uy, ny=b.ux, sides=[[0,1,[b.ux,b.uy]],[1,2,[-nx,-ny]],[2,3,[-b.ux,-b.uy]],[3,0,[nx,ny]]];
    for(const [i,j,nr] of sides){ if((nr[0]*cam[0]+nr[1]*cam[1])*ce<=.02) continue; const k=.5+.2*Math.max(0,nr[0]*L[0]+nr[1]*L[1]);
      faces.push([[proj(C[i][0],C[i][1],b.z0),proj(C[j][0],C[j][1],b.z0),proj(C[j][0],C[j][1],b.z1),proj(C[i][0],C[i][1],b.z1)],shade(k)]); }
  }
  // произвольные плоские многоугольники (скаты, фронтоны): {pts:[[x,y,z]…], rgb}; тон — по нормали
  for(const q of o.polys||[]){ const P=q.pts, n=[0,0,0]; for(let i=0;i<P.length;i++){ const a=P[i], b=P[(i+1)%P.length]; n[0]+=(a[1]-b[1])*(a[2]+b[2]); n[1]+=(a[2]-b[2])*(a[0]+b[0]); n[2]+=(a[0]-b[0])*(a[1]+b[1]); }
    const nl=Math.hypot(...n)||1, k=.55+.4*Math.abs(n[2]/nl)*.6+.25*Math.max(0,Math.abs((n[0]*L[0]+n[1]*L[1])/nl));
    faces.push([P.map(p=>proj(p[0],p[1],p[2])),q.rgb.map(v=>Math.round(Math.min(255,v*k)))]); }
  for(const [V,rgb] of faces) fill(V,rgb);
  if(o.edge===false) return {data:img,w:W,h:H,zb};
  // монолит (по умолчанию): линии только на настоящих рёбрах — смена ориентации / вида грани или скачок глубины (силуэт, заслонение);
  // стыки блоков в одной плоскости (угол, перемычка над дверью, общая стена) не видны. o.edge==='faces' — старый вид: контур каждой грани
  if(o.edge!=='faces'){
    const thr=o.crease>0 ? o.crease : .04, M=new Uint8Array(W*H), dz=(a,b,c)=>Math.abs(zb[a]-2*zb[b]+zb[c]);
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){ const k=y*W+x; if(zb[k]===Infinity) continue;
      for(const [st,ok] of [[1,x+1<W],[W,y+1<H]]){ if(!ok) continue; const n1=k+st;
        if(zb[n1]===Infinity || gid[n1]!==gid[k]){ M[k]=1; continue; }
        const okPrev=st===1 ? x>0 : y>0, p0=k-st;
        if(okPrev && zb[p0]!==Infinity && gid[p0]===gid[k] && dz(p0,k,n1)>thr) M[k]=1; } }
    for(let k=0;k<W*H;k++) if(M[k]){ const j=k*4; img[j]=img[j]*.45; img[j+1]=img[j+1]*.45; img[j+2]=img[j+2]*.45; }
    return {data:img,w:W,h:H,zb};
  }
  for(const [V,rgb] of faces){ const dk=rgb.map(v=>Math.round(v*.45)); for(let i=0;i<V.length;i++) edge(V[i],V[(i+1)%V.length],dk); }
  return {data:img,w:W,h:H,zb};
}
