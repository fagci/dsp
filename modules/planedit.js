"use strict";
/* ============================ Plan Editor ============================
   Редактор плана и 3D-модели: стены с толщиной / высотой / материалом, фиксированные длины сторон, проёмы (двери, окна), примитивы (ящик, колонна),
   камеры наблюдения (поле зрения, тени от стен, слепые зоны) и антенны (уровень сигнала с потерями на стенах). Один холст с общей орбитальной камерой:
   «plan» — вид сверху (север вверху), «3D» — вращение / масштаб / сдвиг; выбор, перетаскивание и добавление работают одинаково в обоих (луч от курсора
   падает на плоскость пола или на высоту объекта). Общее пространство с Video Overlay: привязка плана к земле (lat / lon / north / alt), выход rec
   отдаёт стены, камеры и антенны как 3D-каркасы и маркеры; поза телефона с тех же входов lat / lon / alt / az / el / fov рисуется в плане.
   Ядро — planedit-kernels.js (тест tools/test-planedit.mjs). */

const PE_TOOLS=[['select','☝','select'],['wall','▭','wall'],['point','•','point'],['door','🚪','door'],['window','▤','window'],['box','■','box'],['column','●','column'],['camera','🎥','camera'],['antenna','📶','TX'],['receiver','📡','RX'],['measure','📏','measure'],['erase','✕','erase']];
const PE_BANDS=[88,144,433,868,915,1575,1800,2100,2437,3500,5200,5800,6000,24000];       // частоты для шагов ± у антенн, МГц
const PE_MATS=Object.keys(PE_MAT);

// ---------- проекция: орбитальная камера, ортографическая ----------
function peProj(n,W,H){
  const d3=n.p.view==='3D', A=d3 ? (+n.p.vaz)*PE_D : 0, E=d3 ? (+n.p.vel)*PE_D : Math.PI/2, V=n.vw, ca=Math.cos(A), sa=Math.sin(A), ce=Math.cos(E), se=Math.sin(E), cx=W/2, cy=(H+PE_BAR)/2;
  const P={A,E,sc:V.sc,d3,ca,sa,ce,se,
    pt:(x,y,z)=>{ const X=x-V.tx, Y=y-V.ty, xr=X*ca+Y*sa, yr=-X*sa+Y*ca; return [cx+xr*V.sc, cy-(z*ce+yr*se)*V.sc, yr*ce-z*se]; },
    un:(sx,sy,z0)=>{ const xr=(sx-cx)/V.sc, yr=((cy-sy)/V.sc-z0*ce)/Math.max(se,.05); return [V.tx+xr*ca-yr*sa, V.ty+xr*sa+yr*ca]; }};
  return P;
}
const PE_BAR=(typeof matchMedia!=='undefined' && matchMedia('(pointer:coarse)').matches) ? 38 : 26;       // высота панели инструментов на холсте (на касании крупнее)
function peFit(n,W,H){
  let b=peBounds(n.sc,1.2); const V=n.vw; if(!b && n.under && n.under.b){ const u=n.under.b; b={x0:u.x0-.5,x1:u.x1+.5,y0:u.y0-.5,y1:u.y1+.5}; }
  if(!b){ V.cw=W; V.ch=H; V.tx=3; V.ty=2; V.sc=Math.max(20,Math.min(W,H-PE_BAR)/9); V.fit=true; return; }
  V.tx=(b.x0+b.x1)/2; V.ty=(b.y0+b.y1)/2; const sp=Math.max(b.x1-b.x0,b.y1-b.y0,1), k=n.p.view==='3D' ? .8 : 1.0;
  V.cw=W; V.ch=H; V.user=false; V.sc=Math.min((W-20)/Math.max(b.x1-b.x0,1),(H-PE_BAR-20)/Math.max((b.y1-b.y0)*(n.p.view==='3D' ? Math.sin((+n.p.vel)*PE_D) : 1)+(n.p.view==='3D' ? 3*Math.cos((+n.p.vel)*PE_D) : 0),1))*k; V.fit=true;
}

// ---------- изменения сцены ----------
function peTouch(n){ n.rev++; n.lastEdit=performance.now(); redraw(n);
  clearTimeout(n.histT); n.histT=setTimeout(()=>peCommit(n),450);
  if(!n.saveT) n.saveT=setTimeout(()=>{ n.saveT=0; n.p.scene=JSON.stringify(n.sc); },400); }
// отмена / повтор: правки склеиваются в шаг, пока пауза между ними короче 450 мс; перетаскивание — один шаг
function peCommit(n){ n.histT=0; if(n.dragging){ n.histT=setTimeout(()=>peCommit(n),200); return; } peHistCommit(n.hist,JSON.stringify(n.sc)); }
function peUndo(n,redo){
  clearTimeout(n.histT); n.histT=0; n.dragging=false; const r=(redo ? peHistRedo : peHistUndo)(n.hist,JSON.stringify(n.sc));
  if(r===null){ redraw(n); return; }
  n.sc=peParse(r); n.p.scene=r; if(n.sel){ if(peItem(n)) peLoad(n); else peSelect(n,null); }
  n.rev++; n.lastEdit=performance.now(); n.chain=null; n.chainPts=[]; redraw(n);
}
function peSelect(n,kind,id){ n.sel=kind ? {k:kind,id} : null; n.selKind=kind||''; peLoad(n); redraw(n); }
function peItem(n,sel=n.sel){ if(!sel) return null; const s=n.sc; return sel.k==='pt' ? pePt(s,sel.id) : sel.k==='wall' ? peWall(s,sel.id) : sel.k==='obj' ? s.objs.find(o=>o.id===sel.id) : sel.k==='cam' ? s.cams.find(o=>o.id===sel.id) : sel.k==='ant' ? s.ants.find(o=>o.id===sel.id) : null; }
// выбранное → параметры панели
function peLoad(n){
  const it=peItem(n), S=(k,v)=>{ if(v!==undefined) setMod(n,k,v); };
  if(!it) return;
  switch(n.sel.k){
    case 'pt': S('pname',it.name||''); break;
    case 'wall': S('wt',it.t); S('wh',it.h); S('mat',it.mat); S('wlen',it.len>0 ? it.len : 0); break;
    case 'obj': S('ow',it.w); S('od',it.d??.5); S('oh',it.h); S('orot',it.rot??0); S('osill',it.type==='box'||it.type==='column' ? (it.z||0) : it.sill); break;
    case 'cam': S('cname',it.name); S('cz',it.z); S('caz',it.az); S('ctilt',it.tilt); S('cfov',it.fov); S('crange',it.range); break;
    case 'ant': S('aname',it.name); S('arole',it.role==='rx' ? 'receive' : 'transmit'); S('az2',it.z); S('aaz',it.az); S('abw',it.bw); S('aeirp',it.eirp??20); S('again',it.gain??2); S('asens',it.sens??-85); S('afreq',it.f); break;
  }
}
// параметр панели → выбранное
function peApply(n,k){
  const it=peItem(n), p=n.p; if(!it) return;
  const set=(f,v)=>{ it[f]=v; };
  switch(n.sel.k){
    case 'pt': if(k==='pname') it.name=String(p.pname).trim(); break;
    case 'wall': if(k==='wt') it.t=+p.wt; if(k==='wh') it.h=+p.wh; if(k==='mat') it.mat=p.mat; if(k==='wlen'){ if(+p.wlen>0) peSetLen(n.sc,it.id,+p.wlen); else it.len=0; if(+p.wlen>0) it.len=+p.wlen; } break;
    case 'obj': if(k==='ow') it.w=+p.ow; if(k==='od') it.d=+p.od; if(k==='oh') it.h=+p.oh; if(k==='orot') it.rot=+p.orot; if(k==='osill'){ if(it.type==='box'||it.type==='column') it.z=+p.osill; else it.sill=+p.osill; } break;
    case 'cam': { const m={cname:'name',cz:'z',caz:'az',ctilt:'tilt',cfov:'fov',crange:'range'}[k]; if(m) it[m]=k==='cname' ? String(p[k]) : +p[k]; break; }
    case 'ant': { if(k==='arole'){ it.role=p.arole==='receive' ? 'rx' : 'tx'; if(it.role==='rx'){ it.gain??=2; it.sens??=-85; } else it.eirp??=20; break; } const m={aname:'name',az2:'z',aaz:'az',abw:'bw',aeirp:'eirp',again:'gain',asens:'sens',afreq:'f'}[k]; if(m) it[m]=k==='aname' ? String(p[k]) : +p[k]; break; }
  }
  peTouch(n);
}
const peOn=k=>n=>n.selKind===k;

// ---------- выбор по экрану ----------
// ручки-стрелки выбранного: ← → ↑ ↓ вдоль осей плана, квадрат — свободно; у двери и окна — две стрелки вдоль стены
function peGizmo(n,P){
  const it=peItem(n); if(!it || !n.sel) return []; const k=n.sel.k, s=n.sc, Lp=n.touch ? 54 : 40, out=[];
  let wx, wy, wz;
  if(k==='pt'){ wx=it.x; wy=it.y; wz=0; }
  else if(k==='wall'){ const [a,b]=peWallEnds(s,it); wx=(a.x+b.x)/2; wy=(a.y+b.y)/2; wz=0; }
  else if(k==='obj' && (it.type==='door'||it.type==='window')){
    const pl=peOpenPlace(s,it), w=peWall(s,it.wall); if(!pl || !w) return [];
    const [a,b]=peWallEnds(s,w), z=it.sill+it.h/2, A=P.pt(a.x,a.y,z), B=P.pt(b.x,b.y,z), l=Math.hypot(B[0]-A[0],B[1]-A[1])||1, u=[(B[0]-A[0])/l,(B[1]-A[1])/l], c=P.pt(pl.x,pl.y,z);
    for(const sg of [1,-1]) out.push({ax:'u',c,u:[u[0]*sg,u[1]*sg],a:[c[0]+u[0]*sg*14,c[1]+u[1]*sg*14],b:[c[0]+u[0]*sg*Lp,c[1]+u[1]*sg*Lp],col:'#4fc3f7'});
    return out;
  } else { wx=it.x; wy=it.y; wz=k==='obj' ? (it.z||0) : it.z; }
  const c=P.pt(wx,wy,wz); let sx=0, sy=0;
  for(const [ax,dx,dy,col] of [['x',1,0,'#ff6b6b'],['y',0,1,'#7dff9a']]){
    const e=P.pt(wx+dx,wy+dy,wz), vx=e[0]-c[0], vy=e[1]-c[1], m=Math.hypot(vx,vy); if(m<1e-6) continue;
    const u=[vx/m,vy/m]; sx+=u[0]; sy+=u[1];
    out.push({ax,u,m:Math.max(m,P.sc*.15),wz,a:[c[0]+u[0]*14,c[1]+u[1]*14],b:[c[0]+u[0]*Lp,c[1]+u[1]*Lp],col});
  }
  out.push({ax:'xy',wz,b:[c[0]+sx*Lp*.42,c[1]+sy*Lp*.42],a:[c[0]+sx*Lp*.42,c[1]+sy*Lp*.42],col:'#fff'});
  return out;
}
function peMoveStart(n){ const it=peItem(n), k=n.sel.k; if(k==='wall'){ const [a,b]=peWallEnds(n.sc,it); return {wa:[a.x,a.y],wb:[b.x,b.y]}; } return {x:it.x,y:it.y}; }
function peMoveBy(n,g,dx,dy){
  const it=peItem(n), k=n.sel?.k; if(!it) return; dx=Math.round(dx*100)/100; dy=Math.round(dy*100)/100;
  if(k==='wall') peMoveWall(n.sc,it.id,g.wa[0]+dx,g.wa[1]+dy,g.wb[0]+dx,g.wb[1]+dy);
  else if(k==='pt') peDrag(n.sc,it.id,g.x+dx,g.y+dy);
  else if(k==='obj' && (it.type==='door'||it.type==='window')) return;
  else { it.x=g.x+dx; it.y=g.y+dy; }
  peTouch(n);
}
function pePick(n,P,x,y){
  const s=n.sc, R=n.touch ? 20 : 13; let best=null; const hit=(kind,id,sx,sy,r,pri)=>{ const d=Math.hypot(sx-x,sy-y); if(d<=r){ const sc=pri*1000+d; if(!best||sc<best.sc) best={kind,id,sc}; } };
  const sel=n.sel, it=peItem(n);
  if(it && (sel.k==='cam'||sel.k==='ant')){ const h=peHandle(it,P); hit('handle',sel.id,h[0],h[1],R,0); }
  for(const h of peGizmo(n,P)){ const d=h.ax==='xy' ? Math.hypot(x-h.b[0],y-h.b[1]) : peSegDist(x,y,h.a[0],h.a[1],h.b[0],h.b[1]); if(d<=R*.8 && (!best||d<best.sc)) best={kind:'move',id:sel.id,h,sc:d}; }
  for(const c of s.cams){ const q=P.pt(c.x,c.y,c.z); hit('cam',c.id,q[0],q[1],R,1); }
  for(const a of s.ants){ const q=P.pt(a.x,a.y,a.z); hit('ant',a.id,q[0],q[1],R,1); }
  for(const o of s.objs){ let q; if(o.type==='door'||o.type==='window'){ const pl=peOpenPlace(s,o); if(!pl) continue; q=P.pt(pl.x,pl.y,o.sill+o.h/2); } else q=P.pt(o.x,o.y,(o.z||0)+o.h/2); hit('obj',o.id,q[0],q[1],R,2); }
  for(const p of s.pts){ const q=P.pt(p.x,p.y,0); hit('pt',p.id,q[0],q[1],R,3); if(P.d3){ const t=P.pt(p.x,p.y,Math.max(0,...s.walls.filter(w=>w.a===p.id||w.b===p.id).map(w=>w.h))); hit('pt',p.id,t[0],t[1],R,3); } }
  for(const w of s.walls){ const [a,b]=peWallEnds(s,w); for(const z of [0,w.h/2,w.h]){ const A=P.pt(a.x,a.y,z), B=P.pt(b.x,b.y,z), d=peSegDist(x,y,A[0],A[1],B[0],B[1]); if(d<=R*.7){ const sc=4000+d; if(!best||sc<best.sc) best={kind:'wall',id:w.id,sc}; } } }
  return best;
}
function peSegDist(x,y,ax,ay,bx,by){ const dx=bx-ax, dy=by-ay, L2=dx*dx+dy*dy||1e-9, u=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/L2)); return Math.hypot(x-(ax+dx*u),y-(ay+dy*u)); }
const peHandle=(it,P)=>{ const L=Math.max(1.2,Math.min(3,(it.range||4)/3)), a=it.az*PE_D; return P.pt(it.x+Math.sin(a)*L,it.y+Math.cos(a)*L,it.z); };
// точка на полу под курсором с прилипанием: к существующей точке → к сетке → (в цепочке стен) к углам кратным 15°
function peGround(n,P,x,y,o={}){
  const g=P.un(x,y,o.z||0), s=n.sc; let near=null, bd=14;
  if(!o.noPt) for(const p of s.pts){ const q=P.pt(p.x,p.y,0), d=Math.hypot(q[0]-x,q[1]-y); if(d<bd){ bd=d; near=p; } }
  if(near) return {x:near.x,y:near.y,pt:near};
  let gx=g[0], gy=g[1];
  if(o.from && n.p.ortho){ const dx=gx-o.from.x, dy=gy-o.from.y, d=Math.hypot(dx,dy), a=Math.atan2(dy,dx)/PE_D, sn=Math.round(a/15)*15; if(d>.01 && Math.abs(a-sn)<5){ gx=o.from.x+Math.cos(sn*PE_D)*d; gy=o.from.y+Math.sin(sn*PE_D)*d; } }
  const st=+n.p.snap; if(st>0){ gx=Math.round(gx/st)*st; gy=Math.round(gy/st)*st; }
  return {x:+gx.toFixed(4),y:+gy.toFixed(4),pt:null};
}
function peWallU(n,P,w,x,y){ const [a,b]=peWallEnds(n.sc,w), g=P.un(x,y,w.h/2), dx=b.x-a.x, dy=b.y-a.y, L2=dx*dx+dy*dy||1e-9; return Math.max(.02,Math.min(.98,((g[0]-a.x)*dx+(g[1]-a.y)*dy)/L2)); }

// ---------- иконки полосы инструментов: рисованные (одинаковы на всех устройствах, без эмодзи) ----------
// x, y — центр, r — полуразмер, col — цвет линий
function peIcon(cx,id,x,y,r,col){
  cx.save(); cx.translate(x,y); cx.scale(r/10,r/10); cx.strokeStyle=cx.fillStyle=col; cx.lineWidth=1.8; cx.lineJoin=cx.lineCap='round';
  const P=(...a)=>{ cx.beginPath(); cx.moveTo(a[0],a[1]); for(let i=2;i<a.length;i+=2) cx.lineTo(a[i],a[i+1]); };
  switch(id){
    case 'select': P(-5,-8,-5,7,-1,3,2,9,4,8,1,2,6,2); cx.closePath(); cx.stroke(); break;                                  // курсор-стрелка
    case 'wall': cx.strokeRect(-9,-3.5,18,7); P(-5,-3.5,-8,3.5); cx.stroke(); P(0,-3.5,-3,3.5); cx.stroke(); P(5,-3.5,2,3.5); cx.stroke(); P(9,-1,7,3.5); cx.stroke(); break;   // стена со штриховкой
    case 'point': cx.beginPath(); cx.arc(0,0,3,0,7); cx.fill(); P(-8,0,-5,0); cx.stroke(); P(5,0,8,0); cx.stroke(); P(0,-8,0,-5); cx.stroke(); P(0,5,0,8); cx.stroke(); break;
    case 'door': P(-8,8,-8,-8); cx.stroke(); P(-8,8,7,8); cx.stroke(); cx.lineWidth=2.6; P(-8,8,-8+13*Math.cos(-1.1),8+13*Math.sin(-1.1)); cx.stroke(); cx.lineWidth=1; cx.setLineDash([2,2]); cx.beginPath(); cx.arc(-8,8,13,-1.1,0); cx.stroke(); cx.setLineDash([]); break;   // проём с полотном и дугой
    case 'window': cx.strokeRect(-8,-8,16,16); P(0,-8,0,8); cx.stroke(); P(-8,0,8,0); cx.stroke(); break;
    case 'box': P(-7,-3,0,-7,7,-3,7,5,0,9,-7,5); cx.closePath(); cx.stroke(); P(-7,-3,0,1,7,-3); cx.stroke(); P(0,1,0,9); cx.stroke(); break;   // куб
    case 'column': cx.beginPath(); cx.ellipse(0,-6,5,2.2,0,0,7); cx.stroke(); P(-5,-6,-5,7); cx.stroke(); P(5,-6,5,7); cx.stroke(); cx.beginPath(); cx.ellipse(0,7,5,2.2,0,0,Math.PI); cx.stroke(); break;
    case 'camera': cx.strokeRect(-9,-5,12,10); P(3,-2,9,-6,9,6,3,2); cx.closePath(); cx.stroke(); cx.beginPath(); cx.arc(-3,0,2.2,0,7); cx.stroke(); break;   // корпус и объектив
    case 'antenna': P(0,9,0,-1); cx.stroke(); P(-4,9,4,9); cx.stroke(); cx.beginPath(); cx.arc(0,-3,1.8,0,7); cx.fill(); for(const k of [5,9]){ cx.beginPath(); cx.arc(0,-3,k,-2.4,-.75); cx.stroke(); } break;   // мачта и волны наружу
    case 'receiver': cx.beginPath(); cx.arc(-1,1,8,-.3,Math.PI*.8); cx.stroke(); P(-6,6,3,-3); cx.stroke(); cx.beginPath(); cx.arc(4,-4,1.8,0,7); cx.fill(); P(-1,9,3,9); cx.stroke(); P(7,-9,4,-6); cx.stroke(); P(4,-6,4,-8.5); cx.stroke(); P(4,-6,6.5,-6); cx.stroke(); break;   // тарелка, стрелка внутрь
    case 'measure': cx.save(); cx.rotate(-.6); cx.strokeRect(-10,-3.5,20,7); for(let k=-7;k<=7;k+=3.5) { P(k,-3.5,k,k%7===0 ? 1 : -.5); cx.stroke(); } cx.restore(); break;   // линейка с делениями
    case 'erase': P(-7,-7,7,7); cx.stroke(); P(7,-7,-7,7); cx.stroke(); break;
    case '#view3D': P(-7,-3,0,-7,7,-3,7,5,0,9,-7,5); cx.closePath(); cx.stroke(); P(-7,-3,0,1,7,-3); cx.stroke(); P(0,1,0,9); cx.stroke(); break;   // переключить в 3D
    case '#viewPlan': cx.strokeRect(-8,-8,16,16); P(-8,1,2,1,2,-8); cx.stroke(); P(2,1,2,8); cx.stroke(); break;   // переключить в план (вид сверху)
    case '#fit': for(const [sx,sy] of [[-1,-1],[1,-1],[1,1],[-1,1]]){ P(8*sx,3*sy,8*sx,8*sy,3*sx,8*sy); cx.stroke(); } cx.strokeRect(-3,-3,6,6); break;   // рамка «вписать»
    case '#undo': case '#redo': { if(id==='#redo') cx.scale(-1,1); cx.beginPath(); cx.arc(1,2,6,Math.PI*1.05,Math.PI*.15,false); cx.stroke(); P(-9,-4,-5,2,-.5,-3); cx.stroke(); break; }   // дуга со стрелкой
    default: cx.font='12px sans-serif'; cx.textAlign='center'; cx.textBaseline='middle'; cx.fillText('?',0,0);
  }
  cx.restore();
}

// ---------- вид из выбранной камеры: окно в углу (тап — во весь холст); картинка пересчитывается при правке сцены или камеры ----------
function peDrawCamView(n,cx,W,H){
  n.camBox=null; const c=n.sel && n.sel.k==='cam' ? n.sc.cams.find(q=>q.id===n.sel.id) : null; if(!c || n.p.camview===false) return;
  const big=!!n.camBig, w=Math.round(big ? W-16 : Math.min(W*.46,380)), h=Math.round(Math.min(w*9/16,big ? H-PE_BAR-60 : H*.4)), x=W-w-8, y=PE_BAR+8;
  const k=Math.min(1,560/w), rw=Math.max(32,Math.round(w*k)), rh=Math.max(18,Math.round(h*k)), key=[n.rev,c.x,c.y,c.z,c.az,c.tilt,c.fov,rw,rh].join('|');
  if(!n.camImg || n.camImg.key!==key){ const R=peCamView(n.sc,c,rw,rh), cv=n.camImg?.cv || document.createElement('canvas'); cv.width=rw; cv.height=rh; cv.getContext('2d').putImageData(new ImageData(R.data,rw,rh),0,0); n.camImg={key,cv}; }
  const gr=cx.createLinearGradient(0,y,0,y+h); gr.addColorStop(0,'#9cc7e8'); gr.addColorStop(1,'#dbe9f2');                    // небо за сценой
  cx.save(); cx.fillStyle=gr; cx.fillRect(x,y,w,h); cx.imageSmoothingEnabled=true; cx.drawImage(n.camImg.cv,x,y,w,h);
  cx.strokeStyle='#ffb74d'; cx.lineWidth=2; cx.strokeRect(x,y,w,h);
  cx.fillStyle='rgba(0,0,0,.55)'; cx.fillRect(x,y,w,18); cx.fillStyle='#fff'; cx.font='11px sans-serif'; cx.textAlign='left'; cx.textBaseline='middle';
  cx.fillText(c.name+' · '+c.fov+'° · '+c.z.toFixed(1)+' m · tilt '+c.tilt+'°'+(big ? '  (tap — small)' : '  (tap — large)'),x+6,y+9); cx.textBaseline='alphabetic'; cx.restore();
  n.camBox={x,y,w,h};
}

// ---------- действия инструментов ----------
function peUse(n,P,tool,x,y,hit){
  const s=n.sc, p=n.p;
  if(tool==='wall'){
    const g=peGround(n,P,x,y,{from:n.chain ? pePt(s,n.chain) : null}); let pt=g.pt; if(!pt) pt=peAddPoint(s,g.x,g.y);
    if(n.chain && n.chain!==pt.id){ const w=peAddWall(s,n.chain,pt.id,{t:+p.wt,h:+p.wh,mat:p.mat}); n.chainPts.push(pt.id);
      if(pt.id===n.chainPts[0] && n.chainPts.length>=4){ n.chainPts.pop(); peAddRoom(s,n.chainPts); n.chain=null; n.chainPts=[]; n.msg='room closed'; }
      else n.chain=pt.id; if(w) peSelect(n,'wall',w.id); }
    else if(!n.chain){ n.chain=pt.id; n.chainPts=[pt.id]; n.msg='wall: click the next point (the first one closes the room, Esc ends)'; }
    peTouch(n); return;
  }
  if(tool==='measure'){                                            // линейка: два клика — расстояние; привязка к углам и граням стен, затем к точкам
    const g0=P.un(x,y,0), f=peSnapFace(s,g0[0],g0[1],14/P.sc), g=f ? {x:f.x,y:f.y} : (()=>{ const q=peGround(n,P,x,y,{}); return q.pt ? {x:q.pt.x,y:q.pt.y} : {x:g0[0],y:g0[1]}; })();
    if(!n.ruler || n.ruler.b) n.ruler={a:[g.x,g.y],b:null}; else n.ruler.b=[g.x,g.y];
    if(n.ruler.b){ const d=Math.hypot(n.ruler.b[0]-n.ruler.a[0],n.ruler.b[1]-n.ruler.a[1]); n.msg='measure: '+d.toFixed(3)+' m (Δx '+(n.ruler.b[0]-n.ruler.a[0]).toFixed(3)+', Δy '+(n.ruler.b[1]-n.ruler.a[1]).toFixed(3)+')'; }
    else n.msg='measure: click the second point (it snaps to wall corners and faces)';
    redraw(n); return; }
  if(tool==='point'){ const g=peGround(n,P,x,y,{noPt:true}); const q=peAddPoint(s,g.x,g.y); peSelect(n,'pt',q.id); peTouch(n); return; }
  if(tool==='door'||tool==='window'){
    if(!hit || hit.kind!=='wall'){ n.msg='click a wall to put a '+tool+' in it'; redraw(n); return; }
    const w=peWall(s,hit.id), u=peWallU(n,P,w,x,y), o=peAddObj(s,tool,{wall:w.id,u}); peSelect(n,'obj',o.id); peTouch(n); return;
  }
  if(tool==='box'||tool==='column'){ const g=peGround(n,P,x,y,{noPt:true}), o=peAddObj(s,tool,{x:g.x,y:g.y}); peSelect(n,'obj',o.id); peTouch(n); return; }
  if(tool==='receiver'){ const g=peGround(n,P,x,y,{noPt:true}), o=peAddRx(s,g.x,g.y,{}); peSelect(n,'ant',o.id); peTouch(n); return; }
  if(tool==='camera'||tool==='antenna'){
    const g=peGround(n,P,x,y,{noPt:true}); let az=0; const R=s.rooms[0]; if(R){ const P2=peRoomPoly(s,R), cx=P2.reduce((a,q)=>a+q[0],0)/P2.length, cy=P2.reduce((a,q)=>a+q[1],0)/P2.length; az=Math.round(peWrap360(Math.atan2(cx-g.x,cy-g.y)/PE_D)); }
    const o=tool==='camera' ? peAddCam(s,g.x,g.y,{az}) : peAddAnt(s,g.x,g.y,{az}); peSelect(n,tool==='camera' ? 'cam' : 'ant',o.id); peTouch(n); return;
  }
  if(tool==='erase'){ if(hit && hit.kind!=='handle'){ const kind=hit.kind; peDel(s,kind,hit.id); if(n.sel && n.sel.id===hit.id) peSelect(n,null); peTouch(n); } return; }
}
function peDeleteSel(n){ if(!n.sel) return; peDel(n.sc,n.sel.k,n.sel.id); peSelect(n,null); peTouch(n); }

// ---------- жесты ----------
function peGesture(n,cv){
  if(n._gcv===cv) return; n._gcv=cv; cv.style.touchAction='none'; cv.tabIndex=0; cv.style.outline='none';
  const Ptr=new Map(), clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const pos=ev=>{ const r=cv.getBoundingClientRect(); return [(ev.clientX-r.left)/r.width*cv.width,(ev.clientY-r.top)/r.height*cv.height]; };
  const barHit=x=>{ const bw=cv.width/(PE_TOOLS.length+4); const i=Math.floor(x/bw); return i; };
  let g=null;
  cv.addEventListener('contextmenu',ev=>ev.preventDefault());
  cv.addEventListener('pointerdown',ev=>{
    ev.stopPropagation(); cv.focus({preventScroll:true}); cv.setPointerCapture(ev.pointerId); const q=pos(ev); n.touch=ev.pointerType==='touch'; Ptr.set(ev.pointerId,{p:q,b:ev.button});
    if(Ptr.size>1){ g={mode:'pinch'}; n.vw.user=true; n.dragging=false; return; }
    if(n.camBox && q[0]>=n.camBox.x && q[0]<=n.camBox.x+n.camBox.w && q[1]>=n.camBox.y && q[1]<=n.camBox.y+n.camBox.h){ n.camBig=!n.camBig; redraw(n); g={mode:'chip'}; return; }   // окно вида из камеры: тап — крупно / мелко
    if(n.chipBox && q[1]>=n.chipBox.y){ const r=n.chipRects.find(r=>q[0]>=r.x && q[0]<=r.x+r.w && q[1]>=r.y && q[1]<=r.y+r.h); if(r) peChipHit(n,r); g={mode:'chip'}; return; }
    if(q[1]<PE_BAR){ const i=barHit(q[0]); if(i<PE_TOOLS.length){ setMod(n,'tool',PE_TOOLS[i][0]); n.chain=null; n.chainPts=[]; } else if(i===PE_TOOLS.length){ setMod(n,'view',n.p.view==='3D' ? 'plan' : '3D'); peFit(n,cv.width,cv.height); } else if(i===PE_TOOLS.length+1){ peFit(n,cv.width,cv.height); } else peUndo(n,i>PE_TOOLS.length+2); redraw(n); g={mode:'bar'}; return; }
    const P=peProj(n,cv.width,cv.height), hit=pePick(n,P,q[0],q[1]), tool=n.p.tool, pan=ev.button===1||ev.button===2||ev.shiftKey;
    g={mode:'none',x0:q[0],y0:q[1],moved:false,hit,tool};
    if(tool==='select' && !pan && hit){
      if(hit.kind==='handle'){ g.mode='handle'; return; }
      if(hit.kind==='move'){ g.mode='move'; g.h=hit.h; g.q0=q; g.start=peMoveStart(n); if(hit.h.ax==='xy'){ const u=P.un(q[0],q[1],hit.h.wz); g.g0={x:u[0],y:u[1]}; } n.dragging=true; return; }
      g.mode='pendSel'; return;                                                   // короткое касание — выделить, протяжка — двигает вид (объект двигают только ручки-стрелки)
    }
    g.mode=pan||(!P.d3) ? 'pan' : 'orbit'; if(!pan && tool!=='select') g.mode='maybe';       // инструменты: короткий клик действует, протяжка двигает вид
  });
  const end=ev=>{
    const q=Ptr.get(ev.pointerId); Ptr.delete(ev.pointerId); if(!g) return;
    if(Ptr.size===0){
      const p=pos(ev), moved=Math.hypot(p[0]-(g.x0??p[0]),p[1]-(g.y0??p[1]))>6;
      if(g.mode==='maybe' && !moved){ const P=peProj(n,cv.width,cv.height); peUse(n,P,g.tool,p[0],p[1],pePick(n,P,p[0],p[1])); }
      else if((g.mode==='pan'||g.mode==='orbit') && !moved && g.tool==='select'){ peSelect(n,null); }
      else if(g.mode==='pan' && !moved && g.tool!=='select'){ const P=peProj(n,cv.width,cv.height); peUse(n,P,g.tool,p[0],p[1],pePick(n,P,p[0],p[1])); }
      if(g.mode==='pendSel' && !moved && g.hit) peSelect(n,g.hit.kind,g.hit.id);
      if(g.mode==='move'||g.mode==='handle'){ n.dragging=false; n.p.scene=JSON.stringify(n.sc); redraw(n); }
      g=null;
    }
  };
  cv.addEventListener('pointerup',end); cv.addEventListener('pointercancel',end);
  cv.addEventListener('pointermove',ev=>{
    const st=Ptr.get(ev.pointerId); if(!st||!g) return; const q=pos(ev), dx=q[0]-st.p[0], dy=q[1]-st.p[1], P=peProj(n,cv.width,cv.height), V=n.vw;
    if(Ptr.size===2){                                                            // щипок: масштаб и сдвиг вокруг точки между пальцами, в 3D ещё и поворот скруткой
      const e=[...Ptr.entries()].find(([id])=>id!==ev.pointerId)[1].p, m0=[(st.p[0]+e[0])/2,(st.p[1]+e[1])/2], m1=[(q[0]+e[0])/2,(q[1]+e[1])/2];
      const d0=Math.hypot(st.p[0]-e[0],st.p[1]-e[1]), d1=Math.hypot(q[0]-e[0],q[1]-e[1]), before=P.un(m0[0],m0[1],0);
      if(d0>0) V.sc=clamp(V.sc*d1/d0,2,600);
      if(P.d3){ let da=(Math.atan2(q[1]-e[1],q[0]-e[0])-Math.atan2(st.p[1]-e[1],st.p[0]-e[0]))*180/Math.PI; if(da>180) da-=360; if(da<-180) da+=360; if(Math.abs(da)>.05) setMod(n,'vaz',+((((+n.p.vaz+da+180)%360)+360)%360-180).toFixed(1)); }
      const P2=peProj(n,cv.width,cv.height), after=P2.un(m1[0],m1[1],0); V.tx+=before[0]-after[0]; V.ty+=before[1]-after[1];
      n.fastT=performance.now(); clearTimeout(n.fastRe); n.fastRe=setTimeout(()=>redraw(n),290); st.p=q; redraw(n); return;
    }
    const moved=Math.hypot(q[0]-g.x0,q[1]-g.y0)>6; if(moved) g.moved=true;
    if(g.mode==='maybe' && moved) g.mode=P.d3 ? 'orbit' : 'pan';
    if(moved && (g.mode==='pan'||g.mode==='orbit')){ n.vw.user=true; n.fastT=performance.now(); clearTimeout(n.fastRe); n.fastRe=setTimeout(()=>redraw(n),290); }
    if(g.mode==='pendSel' && moved){ g.mode=P.d3 ? 'orbit' : 'pan'; n.vw.user=true; }
    if(g.mode==='move'){ const h=g.h;
      if(h.ax==='u'){ const it=peItem(n), w=it && peWall(n.sc,it.wall); if(w){ it.u=peWallU(n,P,w,h.c[0]+q[0]-g.q0[0],h.c[1]+q[1]-g.q0[1]); peTouch(n); } }
      else if(h.ax==='xy'){ const u=P.un(q[0],q[1],h.wz); peMoveBy(n,g.start,u[0]-g.g0.x,u[1]-g.g0.y); }
      else { const t=((q[0]-g.q0[0])*h.u[0]+(q[1]-g.q0[1])*h.u[1])/h.m; peMoveBy(n,g.start,h.ax==='x' ? t : 0,h.ax==='y' ? t : 0); } }
    else if(g.mode==='pan'){ peShift(n,P,dx,dy); }
    else if(g.mode==='orbit'){ setMod(n,'vaz',+((((+n.p.vaz-dx*.4+180)%360)+360)%360-180).toFixed(1)); n.p.vel=+clamp(+n.p.vel+dy*.4,5,90).toFixed(1); if(!n.syncT){ n.syncT=setTimeout(()=>{ n.syncT=0; setMod(n,'vel',n.p.vel); },150); } }
    else if(g.mode==='handle'){ const it=peItem(n), gp=P.un(q[0],q[1],it.z); it.az=Math.round(peWrap360(Math.atan2(gp[0]-it.x,gp[1]-it.y)/PE_D)); setMod(n,n.sel.k==='cam' ? 'caz' : 'aaz',it.az); peTouch(n); }
    st.p=q; redraw(n);
  });
  cv.addEventListener('wheel',ev=>{ ev.preventDefault(); ev.stopPropagation(); const q=pos(ev), P=peProj(n,cv.width,cv.height), V=n.vw, before=P.un(q[0],q[1],0);
    n.vw.user=true; n.fastT=performance.now(); clearTimeout(n.fastRe); n.fastRe=setTimeout(()=>redraw(n),290); V.sc=clamp(V.sc*Math.exp(-ev.deltaY*(ev.ctrlKey ? .01 : .0015)),2,600); const P2=peProj(n,cv.width,cv.height), after=P2.un(q[0],q[1],0); V.tx+=before[0]-after[0]; V.ty+=before[1]-after[1]; redraw(n); },{passive:false});
  cv.addEventListener('dblclick',ev=>{ ev.stopPropagation(); peFit(n,cv.width,cv.height); redraw(n); });
  cv.addEventListener('keydown',ev=>{ ev.stopPropagation();
    const mod=ev.ctrlKey||ev.metaKey, K=ev.key.toLowerCase();
    if(mod && (K==='z'||K==='y')){ peUndo(n,K==='y'||ev.shiftKey); ev.preventDefault(); }
    else if(ev.key.startsWith('Arrow') && n.sel && !['door','window'].includes(peItem(n)?.type)){      // стрелки сдвигают выбранное на 5 см (Shift — 0.5 м)
      const st=ev.shiftKey ? .5 : .05, P=peProj(n,cv.width,cv.height), a=P.d3 ? P.A : 0, dx=ev.key==='ArrowRight' ? st : ev.key==='ArrowLeft' ? -st : 0, dy=ev.key==='ArrowUp' ? st : ev.key==='ArrowDown' ? -st : 0;
      peMoveBy(n,peMoveStart(n),dx*Math.cos(a)-dy*Math.sin(a),dx*Math.sin(a)+dy*Math.cos(a)); ev.preventDefault(); }
    else if(ev.key==='+'||ev.key==='='||ev.key==='-'){ n.vw.user=true; n.vw.sc=clamp(n.vw.sc*(ev.key==='-' ? 1/1.25 : 1.25),2,600); redraw(n); ev.preventDefault(); }
    else if(ev.key==='Delete'||ev.key==='Backspace'){ peDeleteSel(n); ev.preventDefault(); }
    else if(ev.key==='Escape'){ n.chain=null; n.chainPts=[]; n.ruler=null; setMod(n,'tool','select'); peSelect(n,null); n.msg=''; }
    else if(ev.key==='f'||ev.key==='Home'){ peFit(n,cv.width,cv.height); redraw(n); } });
}
function peShift(n,P,dx,dy){ // сдвиг вида на экранный вектор: цель двигается по плоскости пола
  const a=P.un(0,0,0), b=P.un(dx,dy,0); n.vw.tx-=b[0]-a[0]; n.vw.ty-=b[1]-a[1];
}

// ---------- расчёты: охват камер, уровень антенн, выходы ----------
function peOrigin(n){ return {lat:+n.p.olat||0,lon:+n.p.olon||0,north:+n.p.north||0,alt:+n.p.oalt||0}; }
function peRecalc(n){
  const reflWant=+n.p.refl||0, reflUse=n.dragging ? Math.min(1,reflWant) : reflWant; n.heatPartial=reflUse<reflWant;   // пока тянут — одно отражение, после — сколько задано
  const s=n.sc, g=peGrid(s,+n.p.cell||.25);
  n.camCov=s.cams.length&&g ? peCamCoverage(s,g,peLvZ(s,n.p.lv)+(+n.p.ztgt||1)) : null;              // цель — человек: ztgt над полом выбранного этажа
  n.antHeat=s.ants.some(a=>!peIsRx(a))&&g ? peAntHeat(s,g,{thr:+n.p.thr,f:+n.p.lfreq||0,zr:peLvZ(s,n.p.lv)+1,refl:reflUse}) : null;
  n.links={}; n.minMargin=null; const ro=+n.p.refl>0 ? {refl:+n.p.refl,faces:peFaces(s)} : {}; for(const a of s.ants) if(peIsRx(a)){ const r=peRxLevel(s,a,ro); n.links[a.id]=r; if(r.from && (n.minMargin===null || r.margin<n.minMargin)) n.minMargin=r.margin; }
  n.calcRev=n.rev; n.rasKey='';
  n.area=s.rooms.reduce((a,r)=>a+peRoomArea(s,r),0);
  n.overlaps=peOverlaps(s);
  n.lines=peLines(s);
  const o=peOrigin(n); n.georef=!!(o.lat||o.lon);
  n.recs=n.georef ? peOverlay(s,o) : peLocalRecs(s);
  n.emitDue=true;
}
function peLocalRecs(s){
  const out=[]; for(const p of s.pts) out.push({id:'plan:'+p.id,label:p.name||'',kind:'plan point',x:+p.x.toFixed(3),y:+p.y.toFixed(3),z:0});
  for(const c of s.cams) out.push({id:'plan:'+c.id,label:c.name,kind:'camera',x:+c.x.toFixed(3),y:+c.y.toFixed(3),z:c.z,az:c.az,tilt:c.tilt,fov:c.fov,range:c.range});
  for(const a of s.ants) out.push({id:'plan:'+a.id,label:a.name,kind:'antenna',x:+a.x.toFixed(3),y:+a.y.toFixed(3),z:a.z,az:a.az,bw:a.bw,eirp:a.eirp,freq_mhz:a.f});
  return out;
}
// растр слоя: клетки → канвас для drawImage с аффинным преобразованием
function peRaster(n){
  const L=n.p.layer, key=[L,n.calcRev,n.p.thr].join('|'); if(n.rasKey===key) return n.ras; n.rasKey=key; n.ras=null;
  const src=L==='cameras' ? n.camCov : L==='signal' ? n.antHeat : null; if(!src) return null;
  const g=src.g, c=document.createElement('canvas'); c.width=g.nx; c.height=g.ny; const x=c.getContext('2d'), im=x.createImageData(g.nx,g.ny), D=im.data;
  for(let j=0;j<g.ny;j++) for(let i=0;i<g.nx;i++){
    const k=j*g.nx+i, o=k*4; let r=0,gg=0,b=0,a=0;
    if(L==='cameras'){ const cnt=src.count[k], ins=src.inside[k]; if(cnt>0){ r=60; gg=220; b=120; a=cnt>1 ? 150 : 95; } else if(ins){ r=255; gg=70; b=70; a=70; } }
    else { const v=src.lvl[k], t=Math.max(0,Math.min(1,(v+90)/60)); if(v>-199){ r=Math.round(40+215*t); gg=Math.round(60+170*t); b=Math.round(220-200*t); a=v<src.thr ? 70 : 120; if(v<src.thr){ r=Math.round(r*.6)+60; gg=Math.round(gg*.4); b=Math.round(b*.6); } } }
    D[o]=r; D[o+1]=gg; D[o+2]=b; D[o+3]=a;
  }
  x.putImageData(im,0,0); n.ras={c,g}; return n.ras;
}

// ---------- автоподбор мест ----------
function peTpl(n,kind){
  const s=n.sc, it=peItem(n);
  const from=(o)=>kind==='cam' ? {z:o.z,tilt:o.tilt,fov:o.fov,range:o.range} : {z:o.z,eirp:o.eirp,f:o.f,bw:o.bw};
  if(it && n.sel.k===kind) return from(it);
  const first=(kind==='cam' ? s.cams : s.ants).find(o=>!o.auto) || (kind==='cam' ? s.cams : s.ants)[0];
  if(first) return from(first);
  return kind==='cam' ? {z:2.6,tilt:25,fov:90,range:12} : {z:2.4,eirp:20,f:2437,bw:360};
}
function pePlanStart(n){
  const p=n.p, kind=p.pkind==='antennas' ? 'ant' : 'cam', tpl=peTpl(n,kind);
  const opt={n:+p.pn,target:+p.ptarget/100,tpl,mount:{'walls & corners':'walls','corners only':'corners','anywhere':'anywhere'}[p.pmount]||'walls',doors:!!p.pdoors,thr:+p.thr,cell:.5};
  n.job={gen:kind==='cam' ? peCamPlan(n.sc,opt) : peAntPlan(n.sc,opt),kind,tpl,opt,t0:performance.now()}; n.msg='planning the '+(kind==='cam' ? 'cameras' : 'antennas')+'…'; redraw(n);
  const step=()=>{ const j=n.job; if(!j) return; let r; try{ r=j.gen.next(); }catch(e){ n.job=null; n.msg='planning failed: '+e.message; redraw(n); return; }
    if(!r.done){ const v=r.value; n.msg='planning '+(kind==='cam' ? 'cameras' : 'antennas')+': '+v.phase+' '+Math.round(100*v.done/Math.max(1,v.total))+'%'; redraw(n); setTimeout(step,0); return; }
    n.job=null; const res=r.value;
    if(res.error){ n.msg=res.error; redraw(n); return; }
    const list=kind==='cam' ? res.cams : res.ants;
    if(!list.length){ n.msg='nothing to add: '+(res.base>=.999 ? 'the existing devices already cover everything' : 'no candidate position covers anything (range / field of view / threshold too small?)'); redraw(n); return; }
    peApplyPlan(n.sc,res,kind,tpl); peTouch(n);
    n.msg=(kind==='cam' ? 'cameras' : 'antennas')+': '+list.length+' placed → '+Math.round(100*res.cover)+'% '+(kind==='cam' ? 'seen' : 'above '+opt.thr+' dBm')+' of '+res.area.toFixed(1)+' m² ('+res.curve.map((v,i)=>(i+1)+': '+Math.round(100*v)+'%').join(', ')+(res.base>0 ? '; already covered before: '+Math.round(100*res.base)+'%' : '')+'; '+res.candidates+' candidates)'; redraw(n); };
  setTimeout(step,0);
}
function peExport(n,kind){
  const s=n.sc; if(!s.pts.length){ n.msg='nothing to export yet'; redraw(n); return; }
  if(kind==='svg') sitepDl('plan.svg',peSVG(s,{scale:+n.p.escale,dims:!!n.p.edims,coverage:!!n.p.ecov,north:n.georef ? +n.p.north : undefined}),'image/svg+xml');
  else sitepDl(kind==='dxf3' ? 'plan3d.dxf' : 'plan.dxf',peDXF(s,{three:kind==='dxf3'}),'application/dxf');
  n.msg='exported '+(kind==='svg' ? 'plan.svg (1:'+n.p.escale+')' : kind==='dxf3' ? 'plan3d.dxf (walls and objects as 3D faces)' : 'plan.dxf (walls with thickness, doors, windows, rooms, devices)'); redraw(n);
}
// подложка: снимок → метры (ректификация) в канвас с прозрачностью; строка 0 — север
function peUnderBuild(n){
  const u=n.under; if(!u) return; u.cv=null; u.err='';
  try{
    const k=Math.min(1,1600/Math.max(u.w,u.h)), cw=Math.max(1,Math.round(u.w*k)), ch=Math.max(1,Math.round(u.h*k)), c=document.createElement('canvas'); c.width=cw; c.height=ch;
    const x=c.getContext('2d',{willReadFrequently:true}); x.drawImage(u.bm,0,0,cw,ch); const src=x.getImageData(0,0,cw,ch).data, H=u.H;
    const H2=[H[0]/k,H[1]/k,H[2],H[3]/k,H[4]/k,H[5],H[6]/k,H[7]/k,H[8]], b=pmUnderBounds(H2,u.up,cw,ch);
    if(!b){ u.err='the underlay is degenerate or too large (the horizon in the frame?): calibrate on a closer plane'; return; }
    const R=pmRectify(src,cw,ch,H2,u.up,b,100,1600); if(!R){ u.err='cannot rectify the image'; return; }
    const o=document.createElement('canvas'); o.width=R.w; o.height=R.h; o.getContext('2d').putImageData(new ImageData(R.data,R.w,R.h),0,0); u.cv=o; u.b=b; u.res=R.res;
  }catch(e){ u.err='underlay: '+e.message; }
}

// ---------- строка свойств на холсте: степперы для выбранного ----------
function peChips(n){
  const it=peItem(n); if(!it) return []; const s=n.sc, k=n.sel.k, C=[], clamp=(v,a,b)=>Math.max(a,Math.min(b,v)), R=v=>+(+v).toFixed(3);
  const num=(label,get,set,step,min,max,unit)=>C.push({label,show:()=>R(get())+(unit||''),bump:d=>set(clamp(R(get()+d*step),min,max)),edit:t=>{ const v=typeof meEval==='function' ? meEval(t) : parseFloat(t); if(isFinite(v)) set(clamp(v,min,max)); },cur:()=>R(get())});
  const wrap=(label,get,set,step)=>C.push({label,show:()=>Math.round(get())+'°',bump:d=>set(peWrap360(Math.round(get()+d*step))),edit:t=>{ const v=parseFloat(t); if(isFinite(v)) set(peWrap360(v)); },cur:()=>Math.round(get())});
  const btn=(label,show,tap)=>C.push({label,show,kind:'button',tap});
  const cyc=(label,get,set)=>C.push({label,show:get,bump:d=>set(d),edit:()=>set(1),cur:get,kind:'cycle'});
  const freq=(label,get,set)=>C.push({label,show:()=>(get()>=1000 ? R(get()/1000)+' GHz' : R(get())+' MHz'),bump:d=>{ const f=get(); let i; if(d>0){ i=PE_BANDS.findIndex(b=>b>f+1e-6); set(i<0 ? PE_BANDS[PE_BANDS.length-1] : PE_BANDS[i]); } else { i=PE_BANDS.slice().reverse().findIndex(b=>b<f-1e-6); set(i<0 ? PE_BANDS[0] : PE_BANDS.slice().reverse()[i]); } },edit:t=>{ const v=parseFloat(t); if(v>0) set(v); },cur:get});
  if(k==='pt') C.push({label:'name',show:()=>it.name||it.id,kind:'button',tap:()=>{ const t=prompt('point name',it.name||''); if(t!==null) it.name=String(t).trim(); }});
  else if(k==='wall'){
    num('thickness',()=>it.t,v=>{ it.t=v; },.05,.02,1.2,' m'); num('height',()=>it.h,v=>{ it.h=v; },.1,.5,8,' m');
    num('length',()=>peWallLen(s,it),v=>{ const was=it.len>0; peSetLen(s,it.id,v); if(was) it.len=v; },.1,.1,200,' m');
    btn('length lock',()=>it.len>0 ? '🔒 on' : 'off',()=>{ peLock(s,it.id); });
    cyc('material',()=>it.mat,d=>{ const i=PE_MATS.indexOf(it.mat); it.mat=PE_MATS[(i+d+PE_MATS.length)%PE_MATS.length]; });
  } else if(k==='obj'){
    const dw=it.type==='door'||it.type==='window';
    num('width',()=>it.w,v=>{ it.w=v; },.1,.1,6,' m'); if(it.type==='box') num('depth',()=>it.d,v=>{ it.d=v; },.1,.1,6,' m');
    num('height',()=>it.h,v=>{ it.h=v; },.05,.1,4,' m');
    if(it.type==='box') wrap('turn',()=>it.rot||0,v=>{ it.rot=peWrap180(v); },15);
    if(dw) num('sill',()=>it.sill,v=>{ it.sill=v; },.05,0,3,' m'); else num('base z',()=>it.z||0,v=>{ it.z=v; },.1,0,5,' m');
  } else if(k==='cam'){
    num('field of view',()=>it.fov,v=>{ it.fov=v; },5,20,180,'°'); num('tilt down',()=>it.tilt,v=>{ it.tilt=v; },5,-10,90,'°'); num('range',()=>it.range,v=>{ it.range=v; },1,1,60,' m');
    num('height',()=>it.z,v=>{ it.z=v; },.1,.3,8,' m'); wrap('azimuth',()=>it.az,v=>{ it.az=v; },5);
    btn('name',()=>it.name,()=>{ const t=prompt('camera name',it.name); if(t!==null) it.name=String(t); });
  } else if(k==='ant'){
    const rx=peIsRx(it);
    cyc('type',()=>rx ? 'receive' : 'transmit',()=>{ it.role=rx ? 'tx' : 'rx'; if(it.role==='rx'){ it.gain??=2; it.sens??=-85; } else it.eirp??=20; });
    freq('frequency',()=>it.f,v=>{ it.f=v; });
    if(rx){ num('gain',()=>it.gain??2,v=>{ it.gain=v; },1,-10,30,' dBi'); num('sensitivity',()=>it.sens??-85,v=>{ it.sens=v; },1,-120,-40,' dBm'); }
    else num('power (EIRP)',()=>it.eirp??20,v=>{ it.eirp=v; },1,-10,40,' dBm');
    num('beam width',()=>it.bw,v=>{ it.bw=v; },10,20,360,'°'); wrap('azimuth',()=>it.az,v=>{ it.az=v; },5); num('height',()=>it.z,v=>{ it.z=v; },.1,.3,8,' m');
    btn('name',()=>it.name,()=>{ const t=prompt('antenna name',it.name); if(t!==null) it.name=String(t); });
  }
  btn('delete',()=>'🗑',()=>{ peDeleteSel(n); });
  return C;
}
function peChipHit(n,r){
  const C=peChips(n), c=C[r.i]; if(!c) return;
  if(c.kind==='button') c.tap();
  else if(r.zone==='m') c.bump(-1); else if(r.zone==='p') c.bump(1);
  else if(c.kind==='cycle') c.bump(1);
  else { const t=prompt(c.label+':',String(c.cur())); if(t!==null) c.edit(t); }
  if(n.sel) peLoad(n); peTouch(n);
}
function peDrawChips(n,cx,W,H,fg){
  n.chipRects=[]; n.chipBox=null; const C=n.sel ? peChips(n) : []; if(!C.length) return;
  const ch=PE_BAR>30 ? 40 : 28, pad=4, fs=Math.round(ch*.38); cx.font=fs+'px sans-serif'; cx.textBaseline='middle';
  const widths=C.map(c=>c.kind==='button' ? Math.max(ch*2,cx.measureText(c.label+'  '+c.show()).width+16) : Math.max(ch*3.2,cx.measureText(c.label+'  '+c.show()).width+ch*2+16)), rows=[[]]; let x=pad;
  C.forEach((c,i)=>{ if(x+widths[i]>W-pad && rows[rows.length-1].length){ rows.push([]); x=pad; } rows[rows.length-1].push(i); x+=widths[i]+pad; });
  const top=H-rows.length*(ch+pad)-pad; cx.fillStyle='rgba(16,22,26,.92)'; cx.fillRect(0,top,W,H-top); n.chipBox={y:top};
  rows.forEach((r,ri)=>{ let x=pad; const y=top+pad+ri*(ch+pad);
    for(const i of r){ const c=C[i], w=widths[i], btn=c.kind==='button';
      cx.fillStyle='rgba(255,255,255,.09)'; cx.fillRect(x,y,w,ch);
      if(!btn){ cx.fillStyle='rgba(255,183,77,.22)'; cx.fillRect(x,y,ch,ch); cx.fillRect(x+w-ch,y,ch,ch); cx.fillStyle='#ffb74d'; cx.font=Math.round(ch*.55)+'px sans-serif'; cx.textAlign='center'; cx.fillText(c.kind==='cycle' ? '‹' : '−',x+ch/2,y+ch/2+1); cx.fillText(c.kind==='cycle' ? '›' : '+',x+w-ch/2,y+ch/2+1); }
      cx.font=fs+'px sans-serif'; cx.textAlign='center'; const mx=btn ? x+w/2 : x+w/2; cx.fillStyle='rgba(223,231,234,.65)'; cx.fillText(c.label,mx,y+ch*.32); cx.fillStyle='#fff'; cx.fillText(c.show(),mx,y+ch*.72);
      if(btn) n.chipRects.push({x,y,w,h:ch,i,zone:'c'}); else { n.chipRects.push({x,y,w:ch,h:ch,i,zone:'m'},{x:x+w-ch,y,w:ch,h:ch,i,zone:'p'},{x:x+ch,y,w:w-2*ch,h:ch,i,zone:'c'}); }
      x+=w+pad; } });
  cx.textBaseline='alphabetic';
}

def({ id:'planedit', title:'Plan Editor', cat:'Geo', touch:true, lazy:true, readout:true, view:{h:520}, w:640, resize:true,
  kw:'plan editor floor plan 3d walls thickness lock length door window furniture box column camera cctv antenna wifi coverage heat map blind spots video overlay augmented reality drag points',
  // rec — точки из Site Plan / Table (name, x, y) — добавляются или двигаются по имени (import); lat / lon / alt / az / el / fov — поза телефона (те же провода, что у Video Overlay): рисуется в плане;
  // lines — для Site Plan (точки at, зафиксированные длины, poly); rec — стены, проёмы, ящики (3D-каркасы path3 [lat, lon, alt]), камеры, антенны, точки — в Video Overlay / Map / Table (при заданной привязке к земле);
  // area — площадь комнат, м²; margin — наименьший запас приёмников над чувствительностью, дБ; cover — доля комнат под камерами, 0…1; sig — доля комнат с сигналом выше порога, 0…1; ncam / nant — число
  ins:[{n:'rec',t:'rec'},{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'alt',t:'num'},{n:'az',t:'num'},{n:'el',t:'num'},{n:'fov',t:'num'}],
  outs:[{n:'lines',t:'txt'},{n:'rec',t:'rec'},{n:'area',t:'num'},{n:'cover',t:'num'},{n:'sig',t:'num'},{n:'ncam',t:'num'},{n:'nant',t:'num'},{n:'margin',t:'num'}],
  params:[{n:'tool',t:'select',opts:PE_TOOLS.map(t=>t[0]),d:'select',label:'tool (also the strip on the canvas)',fn:n=>{ n.chain=null; n.chainPts=[]; redraw(n); }},
          {n:'view',t:'select',opts:['plan','3D'],d:'plan',label:'view'},
          {n:'vaz',t:'range',min:-180,max:180,step:1,d:-30,label:'3D: turn, °'},
          {n:'vel',t:'range',min:5,max:90,step:1,d:40,label:'3D: elevation, °'},
          {n:'snap',t:'select',opts:['0','0.05','0.1','0.25','0.5','1'],d:'0.1',label:'snap to the grid, m (0 — off)'},
          {n:'ortho',t:'check',d:true,label:'walls snap to 15° steps'},
          {n:'lv',t:'select',opts:['all','-2','-1','0','1','2','3'],d:'all',label:'level: all (3D — the house above the ground with the roof, plan — the ground floor) · a number — that floor (3D — it and the ones below; 0 — ground, −1 — cellar); the signal is computed 1 m above its floor',fn:n=>{ n.rev=(n.rev||0)+1; redraw(n); }},
          {n:'camview',t:'check',d:true,label:'the view from the selected camera (3D, a window in the corner; tap it to enlarge)'},
          {n:'ztgt',t:'range',min:.1,max:3,step:.1,d:1,label:'cameras: the target height above the floor, m (a person ≈ 1, a face ≈ 1.6, a car number plate ≈ 0.5) — a wall, a fence or a box hides it only where the line of sight passes within their height',fn:n=>{ n.rev=(n.rev||0)+1; redraw(n); }},
          {n:'refl',t:'select',opts:['0','1','2'],d:'1',label:'reflections: 0 — the direct ray only · 1 — plus one bounce off a wall · 2 — plus two (slower); the powers of the paths add up, each bounce costs by the material (metal 1, concrete 5, glass 6, brick 7, block 8, wood 9, drywall 11 dB); the rays to a receiver are drawn on the «signal» layer',fn:n=>{ n.rev=(n.rev||0)+1; redraw(n); }},
          {n:'layer',t:'select',opts:['none','cameras','signal'],d:'none',label:'layer: cameras (green — seen, red — blind) · signal (antennas, dBm)'},
          {n:'thr',t:'range',min:-100,max:-30,step:1,d:-70,label:'signal threshold, dBm (below — dim)'},
          {n:'cell',t:'range',min:.1,max:1,step:.05,d:.25,label:'coverage cell, m'},
          {n:'lfreq',t:'num',d:0,label:'signal layer: only the transmitters on this frequency, MHz (0 — all; ±1 %, at least 10 MHz)'},
          // подложка из Photo Measure
          {n:'uon',t:'check',d:true,label:'underlay (Photo Measure rec → here): show'},
          {n:'uop',t:'range',min:.1,max:1,step:.05,d:.6,label:'underlay opacity'},
          {n:'uox',t:'num',d:0,label:'underlay shift east, m',adv:true},
          {n:'uoy',t:'num',d:0,label:'underlay shift north, m',adv:true},
          {n:'urot',t:'range',min:-180,max:180,step:.1,d:0,label:'underlay turn, ° (counter-clockwise)',adv:true},
          {n:'usc',t:'range',min:.5,max:2,step:.001,d:1,label:'underlay scale ×',adv:true},
          // автоподбор мест камер / антенн
          {n:'pkind',t:'select',opts:['cameras','antennas'],d:'cameras',label:'PLAN PLACEMENT — what to place (the template is the selected camera / antenna, else the first one, else the defaults; devices already placed by hand count as covering)'},
          {n:'pn',t:'range',min:0,max:16,step:1,d:0,label:'how many at most (0 — as many as the target needs)'},
          {n:'ptarget',t:'range',min:50,max:100,step:1,d:95,label:'target: % of the rooms seen / above the signal threshold (the threshold is the one in the signal layer)'},
          {n:'pmount',t:'select',opts:['walls & corners','corners only','anywhere'],d:'walls & corners',label:'cameras: where they may be mounted'},
          {n:'pdoors',t:'check',d:true,label:'cameras: doors and windows weigh ×3 (a 1.5 m zone around them matters more)'},
          {n:'pplan',t:'button',label:'⚙ Plan the placement (adds «auto» devices, replacing earlier auto ones)',fn:n=>pePlanStart(n)},
          {n:'pclear',t:'button',label:'Remove the auto-placed devices',fn:n=>{ const k=peClearAuto(n.sc); n.msg=k ? 'removed '+k+' auto-placed' : 'no auto-placed devices'; peTouch(n); }},
          // экспорт
          {n:'escale',t:'select',opts:['20','50','100','200'],d:'50',label:'EXPORT — SVG scale 1:…'},
          {n:'edims',t:'check',d:true,label:'SVG: wall dimensions'},
          {n:'ecov',t:'check',d:false,label:'SVG: camera view zones'},
          {n:'esvg',t:'button',label:'⬇ SVG (to scale, walls with thickness, doors, windows, dimensions)',fn:n=>peExport(n,'svg')},
          {n:'edxf',t:'button',label:'⬇ DXF 2D (layers: walls, doors, windows, objects, rooms, cameras, antennas, text)',fn:n=>peExport(n,'dxf')},
          {n:'edxf3',t:'button',label:'⬇ DXF 3D (adds the walls and objects as 3D faces)',fn:n=>peExport(n,'dxf3')},
          // выбранное
          {n:'pname',t:'text',d:'',label:'point name',if:peOn('pt'),fn:n=>peApply(n,'pname')},
          {n:'wt',t:'range',min:.02,max:.8,step:.01,d:.2,label:'wall thickness, m (new walls take it too)',if:n=>n.selKind==='wall'||n.p.tool==='wall',fn:n=>peApply(n,'wt')},
          {n:'wh',t:'range',min:.5,max:6,step:.05,d:2.7,label:'wall height, m',if:n=>n.selKind==='wall'||n.p.tool==='wall',fn:n=>peApply(n,'wh')},
          {n:'mat',t:'select',opts:PE_MATS,d:'brick',label:'wall material: signal loss per 10 cm at 2.4 GHz — brick 4, concrete 6, aerated block 3, drywall 1.5, wood 2, glass 1, metal 20 dB; it grows with the frequency as f^k (brick 0.8, concrete 0.9, drywall 0.5, wood 0.6, glass 0.6, metal 0.1)',if:n=>n.selKind==='wall'||n.p.tool==='wall',fn:n=>peApply(n,'mat')},
          {n:'wlen',t:'num',d:0,label:'locked length, m (0 — free): the side keeps it while you drag the points',if:peOn('wall'),fn:n=>peApply(n,'wlen')},
          {n:'lockw',t:'button',label:'🔒 lock / unlock this side at its length',if:peOn('wall'),fn:n=>{ const w=peItem(n); if(w){ peLock(n.sc,w.id); setMod(n,'wlen',w.len||0); peTouch(n); } }},
          {n:'ow',t:'range',min:.1,max:6,step:.05,d:1,label:'width, m',if:peOn('obj'),fn:n=>peApply(n,'ow')},
          {n:'od',t:'range',min:.1,max:6,step:.05,d:.6,label:'depth, m (box)',if:n=>n.selKind==='obj' && peItem(n)?.type==='box',fn:n=>peApply(n,'od')},
          {n:'oh',t:'range',min:.1,max:4,step:.05,d:.8,label:'height, m',if:peOn('obj'),fn:n=>peApply(n,'oh')},
          {n:'orot',t:'range',min:-180,max:180,step:1,d:0,label:'rotation, °',if:n=>n.selKind==='obj' && peItem(n)?.type==='box',fn:n=>peApply(n,'orot')},
          {n:'osill',t:'range',min:0,max:3,step:.05,d:0,label:'sill / base height, m',if:peOn('obj'),fn:n=>peApply(n,'osill')},
          {n:'cname',t:'text',d:'',label:'camera name',if:peOn('cam'),fn:n=>peApply(n,'cname')},
          {n:'cz',t:'range',min:.3,max:8,step:.05,d:2.6,label:'camera height, m',if:peOn('cam'),fn:n=>peApply(n,'cz')},
          {n:'caz',t:'range',min:0,max:359,step:1,d:0,label:'camera azimuth, ° (drag the white handle)',if:peOn('cam'),fn:n=>peApply(n,'caz')},
          {n:'ctilt',t:'range',min:-10,max:90,step:1,d:25,label:'camera tilt down, °',if:peOn('cam'),fn:n=>peApply(n,'ctilt')},
          {n:'cfov',t:'range',min:20,max:180,step:1,d:90,label:'camera field of view (horizontal), °',if:peOn('cam'),fn:n=>peApply(n,'cfov')},
          {n:'crange',t:'range',min:1,max:60,step:.5,d:12,label:'camera range, m',if:peOn('cam'),fn:n=>peApply(n,'crange')},
          {n:'aname',t:'text',d:'',label:'antenna name',if:peOn('ant'),fn:n=>peApply(n,'aname')},
          {n:'az2',t:'range',min:.3,max:8,step:.05,d:2.4,label:'antenna height, m',if:peOn('ant'),fn:n=>peApply(n,'az2')},
          {n:'aaz',t:'range',min:0,max:359,step:1,d:0,label:'antenna azimuth, ° (drag the white handle)',if:peOn('ant'),fn:n=>peApply(n,'aaz')},
          {n:'abw',t:'range',min:20,max:360,step:5,d:360,label:'beam width, ° (360 — omni)',if:peOn('ant'),fn:n=>peApply(n,'abw')},
          {n:'arole',t:'select',opts:['transmit','receive'],d:'transmit',label:'antenna type: transmit (access point, base station) / receive (a phone, a sensor: its level and margin are calculated)',if:peOn('ant'),fn:n=>peApply(n,'arole')},
          {n:'aeirp',t:'range',min:-10,max:40,step:.5,d:20,label:'EIRP, dBm (Wi-Fi 20)',if:n=>n.selKind==='ant' && peItem(n)?.role!=='rx',fn:n=>peApply(n,'aeirp')},
          {n:'again',t:'range',min:-10,max:30,step:.5,d:2,label:'receiver gain, dBi',if:n=>n.selKind==='ant' && peItem(n)?.role==='rx',fn:n=>peApply(n,'again')},
          {n:'asens',t:'range',min:-120,max:-40,step:1,d:-85,label:'receiver sensitivity, dBm (the margin is the level above it)',if:n=>n.selKind==='ant' && peItem(n)?.role==='rx',fn:n=>peApply(n,'asens')},
          {n:'afreq',t:'num',d:2437,label:'frequency, MHz',if:peOn('ant'),fn:n=>peApply(n,'afreq')},
          {n:'undo',t:'button',label:'↶ Undo (Ctrl+Z)',fn:n=>peUndo(n,false)},
          {n:'redo',t:'button',label:'↷ Redo (Ctrl+Shift+Z)',fn:n=>peUndo(n,true)},
          {n:'del',t:'button',label:'✕ Delete the selected (Delete key)',if:n=>!!n.selKind,fn:n=>peDeleteSel(n)},
          // привязка к земле
          {n:'olat',t:'num',d:0,label:'origin (plan 0, 0): latitude, ° (0 / 0 — no georeference)',adv:true},
          {n:'olon',t:'num',d:0,label:'origin: longitude, °',adv:true},
          {n:'north',t:'range',min:-180,max:180,step:.5,d:0,label:'bearing of the plan’s +y (up) from true north, °',adv:true},
          {n:'oalt',t:'num',d:0,label:'floor altitude above sea level, m (Video Overlay camera alt is on this scale)',adv:true},
          {n:'setorg',t:'button',label:'Origin = the lat / lon / alt inputs (stand at the plan’s 0, 0)',adv:true,fn:n=>{ if(n.inPose.lat==null||n.inPose.lon==null){ n.msg='wire lat / lon (My Position) first'; redraw(n); return; } setMod(n,'olat',n.inPose.lat); setMod(n,'olon',n.inPose.lon); if(n.inPose.alt!=null) setMod(n,'oalt',n.inPose.alt); n.rev++; redraw(n); }},
          {n:'emit',t:'range',min:0,max:60,step:1,d:10,label:'repeat the records every … s (Video Overlay forgets objects after its «keep» time; 0 — only on change)',adv:true},
          {n:'pts',t:'select',opts:['auto','all'],d:'auto',label:'points: auto — hide the helper ones (wall ends and room corners from Site Plan) · all',adv:true},
          {n:'imp',t:'check',d:true,label:'input rec: add / move points by name (from Site Plan)',adv:true},
          {n:'newscene',t:'button',label:'Clear the whole scene',adv:true,fn:n=>{ n.sc=peNew(); n.sel=null; n.selKind=''; peTouch(n); n.vw.fit=false; }},
          {n:'scene',t:'text',d:'',hidden:true}],
  init:n=>{ n.sc=peParse(n.p.scene); n.hist=peHistNew(JSON.stringify(n.sc)); n.histT=0; n.rev=1; n.calcRev=0; n.sel=null; n.selKind=''; n.chain=null; n.chainPts=[]; n.vw={tx:0,ty:0,sc:40,fit:false}; n.msg=''; n.inPose={}; n.lastEdit=0; n.saveT=0; n.syncT=0;
    n.links={}; n.minMargin=null; n.chipRects=[]; n.chipBox=null; n.job=null; n.zcv=null; n.fastT=0; n.fastRe=0; n.overlaps=[]; n.under=null; n.camCov=null; n.antHeat=null; n.recs=[]; n.lines=''; n.area=0; n.emitDue=false; n.lastEmit=0; n.rasKey=''; n.ras=null; n.georef=false; n.touch=(typeof matchMedia!=='undefined' && matchMedia('(pointer:coarse)').matches); n.dragging=false; },
  dispose:n=>{ if(n.saveT){ clearTimeout(n.saveT); n.p.scene=JSON.stringify(n.sc); } },
  process(n,I){
    const num=v=>typeof v==='number' && isFinite(v) ? v : null;
    const pose={lat:num(I.lat),lon:num(I.lon),alt:num(I.alt),az:num(I.az),el:num(I.el),fov:num(I.fov)};
    if(JSON.stringify(pose)!==JSON.stringify(n.inPose)){ n.inPose=pose; redraw(n); }
    for(const r of recList(I.rec)){ if(r && r.kind==='underlay' && r.bm){ const sig=JSON.stringify([r.H,r.up,r.w,r.h]); if(!n.under || n.under.sig!==sig){ n.under={bm:r.bm,w:r.w,h:r.h,H:r.H,up:r.up||0,sig,cv:null,b:null,err:''}; peUnderBuild(n); n.vw.fit=false; redraw(n); } else n.under.bm=r.bm; } }
    if(n.p.imp){ const rows=recList(I.rec).filter(r=>r && ((r.x!=null && r.y!=null && (r.name!=null||r.label!=null)) || r.kind==='plan poly' || r.kind==='plan opening' || r.kind==='plan walls')); if(rows.length){ rows.forEach(r=>{ if(r.name==null && r.label!=null) r.name=r.label; }); if(peImportPoints(n.sc,rows)){ peTouch(n); n.vw.fit=false; } } }
    const now=performance.now();
    if(n.heatPartial && !n.dragging){ n.heatPartial=false; n.rev=(n.rev||0)+1; }
    if(n.calcRev!==n.rev && now-n.lastEdit>(n.dragging ? 180 : 60)){ peRecalc(n); redraw(n); }
    let rec=null; const every=+n.p.emit*1000;
    if(n.emitDue || (every>0 && n.recs.length && now-n.lastEmit>every)){ rec=n.recs.length ? n.recs : null; n.emitDue=false; n.lastEmit=now; }
    return {lines:n.lines, rec, area:n.sc.rooms.length ? n.area : null, cover:n.camCov ? n.camCov.cover : null, sig:n.antHeat ? n.antHeat.share : null, ncam:n.sc.cams.length, nant:n.sc.ants.length, margin:n.minMargin};
  },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, s=n.sc, p=n.p, L=[], fg=themeColor('--scr-txt')||'#9fb0b6'; peGesture(n,cv);
    if(n.calcRev!==n.rev && !n.dragging) peRecalc(n);                          // расчёты не зависят от того, запущен ли движок
    if(!n.vw.fit){ peFit(n,W,H); } else if(!n.vw.user && (n.vw.cw!==W || n.vw.ch!==H)) peFit(n,W,H);       // раскладка узла изменилась (телефон, окно) — вписываем заново, пока вид не трогали
    { const ro=n.el.querySelector('.readout'); if(ro && !ro._wrapped){ ro._wrapped=true; ro.style.whiteSpace='pre-wrap'; ro.style.textAlign='left'; ro.style.overflowWrap='anywhere'; } }
    const P=peProj(n,W,H);
    cx.fillStyle=themeColor('--screen')||'#0a0d0e'; cx.fillRect(0,0,W,H);
    // сетка
    { const step=(()=>{ const w=60/P.sc, e=Math.pow(10,Math.floor(Math.log10(w))), m=w/e; return (m<=1 ? 1 : m<=2 ? 2 : m<=5 ? 5 : 10)*e; })();
      const a=P.un(0,PE_BAR,0), b=P.un(W,PE_BAR,0), c=P.un(0,H,0), d=P.un(W,H,0), x0=Math.min(a[0],b[0],c[0],d[0]), x1=Math.max(a[0],b[0],c[0],d[0]), y0=Math.min(a[1],b[1],c[1],d[1]), y1=Math.max(a[1],b[1],c[1],d[1]);
      cx.strokeStyle='rgba(150,170,180,.16)'; cx.lineWidth=1; cx.beginPath(); let cnt=0;
      for(let x=Math.floor(x0/step)*step;x<=x1 && cnt<400;x+=step,cnt++){ const A=P.pt(x,y0,0), B=P.pt(x,y1,0); cx.moveTo(A[0],A[1]); cx.lineTo(B[0],B[1]); }
      for(let y=Math.floor(y0/step)*step;y<=y1 && cnt<800;y+=step,cnt++){ const A=P.pt(x0,y,0), B=P.pt(x1,y,0); cx.moveTo(A[0],A[1]); cx.lineTo(B[0],B[1]); }
      cx.stroke(); n.gridStep=step; }
    // подложка: ректифицированный снимок на плоскости пола (аффинно), сдвиг / поворот / масштаб — вручную
    if(n.under && n.under.cv && p.uon){ const u=n.under, a=+p.usc||1, r=(+p.urot||0)*PE_D, cr=Math.cos(r), sr=Math.sin(r), AL=(x,y)=>[(x*cr-y*sr)*a+(+p.uox||0),(x*sr+y*cr)*a+(+p.uoy||0)];
      const o0=AL(u.b.x0,u.b.y1), o1=AL(u.b.x0+1/u.res,u.b.y1), o2=AL(u.b.x0,u.b.y1-1/u.res), m=P.pt(o0[0],o0[1],0), ux=P.pt(o1[0],o1[1],0), uy=P.pt(o2[0],o2[1],0);
      cx.save(); cx.globalAlpha=+p.uop; /* матрицу умножаем, а не заменяем */ cx.transform(ux[0]-m[0],ux[1]-m[1],uy[0]-m[0],uy[1]-m[1],m[0],m[1]); cx.drawImage(u.cv,0,0); cx.restore(); }
    // слой охвата — аффинно на плоскость пола
    const R=peRaster(n);
    if(R){ const g=R.g, sc=P.sc*g.cell, m=P.pt(g.x0,g.y0,0), ux=P.pt(g.x0+g.cell,g.y0,0), uy=P.pt(g.x0,g.y0+g.cell,0);
      cx.save(); /* умножаем матрицу, а не заменяем: у холста приложения есть своя базовая */ cx.transform(ux[0]-m[0],ux[1]-m[1],uy[0]-m[0],uy[1]-m[1],m[0],m[1]); cx.imageSmoothingEnabled=false; cx.drawImage(R.c,0,0); cx.restore(); void sc; }
    // покрытие участка (дорога, газон…) — на земле, под комнатами
    const PE_GC={asphalt:[95,98,104],gravel:[170,165,150],tile:[196,170,146],grass:[120,175,90],garden:[150,115,70],water:[90,150,210]};
    if(!P.d3) for(const g of s.grounds||[]){ cx.beginPath(); g.poly.forEach((q,i)=>{ const A=P.pt(q[0],q[1],0); i ? cx.lineTo(A[0],A[1]) : cx.moveTo(A[0],A[1]); }); cx.closePath(); cx.fillStyle='rgba('+(PE_GC[g.cover]||PE_GC.grass).join(',')+',.45)'; cx.fill(); }
    // комнаты
    const lvOk=peLvShow(p.lv,P.d3);
    for(const r of s.rooms){ if(!lvOk(r.lv)) continue; const poly=peRoomPoly(s,r), rz=r.z0||0; cx.beginPath(); poly.forEach((q,i)=>{ const A=P.pt(q[0],q[1],rz); i ? cx.lineTo(A[0],A[1]) : cx.moveTo(A[0],A[1]); }); cx.closePath(); cx.fillStyle='rgba(79,195,247,.07)'; cx.fill();
      if(P.sc>10){ const cxm=poly.reduce((a,q)=>a+q[0],0)/poly.length, cym=poly.reduce((a,q)=>a+q[1],0)/poly.length, A=P.pt(cxm,cym,rz); cx.fillStyle='rgba(150,170,180,.7)'; cx.font='11px sans-serif'; cx.textAlign='center'; cx.fillText(p.layer==='signal' ? (r.name||'') : (r.name||'')+' '+peRoomArea(s,r).toFixed(1)+' m²',A[0],A[1]); } }
    // зоны видимости камер
    const occ=peOccluders(s);
    const zT=peLvZ(s,p.lv)+(+p.ztgt||1);
    for(const c of s.cams){ const poly=peVisPoly(c,occ,2,zT); cx.beginPath(); poly.forEach((q,i)=>{ const A=P.pt(q[0],q[1],P.d3 ? peLvZ(s,p.lv) : 0); i ? cx.lineTo(A[0],A[1]) : cx.moveTo(A[0],A[1]); }); cx.closePath(); cx.fillStyle='rgba(125,255,154,.10)'; cx.fill(); cx.strokeStyle='rgba(125,255,154,.55)'; cx.lineWidth=1; cx.stroke(); }
    // блоки: стены, ящики, колонны — по глубине издали к близким
    { const raw=peBoxes(s).filter(b=>b.kind!=='wall' || lvOk(b.lv)), cam=[P.sa,-P.ca], sel=n.sel;
      const roofPolys=P.d3 && (p.lv==='all' || p.lv==null) ? (s.roofs||[]).flatMap(r=>r.faces.map(f=>({pts:f.pts,rgb:f.kind==='roof' ? [150,78,64] : (PE_MATCOL[r.wallMat]||[200,208,214])}))) : [];
      if(P.d3) for(const g of s.grounds||[]) roofPolys.push({pts:g.poly.map(q=>[q[0],q[1],.005]),rgb:PE_GC[g.cover]||PE_GC.grass});
      if(P.d3) for(const sl of s.slabs||[]) if(lvOk(sl.lv)) roofPolys.push({pts:sl.poly.map(q=>[q[0],q[1],sl.z]),rgb:PE_MATCOL[sl.mat]||[168,174,180]});   // перекрытия — пол этажа
      if(P.d3){            // 3D: z-буфер — порядок блоков не важен, пересечения объёмов тоже рисуются верно; пока вид двигают — вдвое грубее, потом дорисовывается начисто
        const fast=performance.now()-(n.fastT||0)<260, k=fast ? .55 : 1, zw=Math.max(8,Math.round(W*k)), zh=Math.max(8,Math.round(H*k));
        const R=peZRaster(raw,(x,y,z)=>{ const q=P.pt(x,y,z); return [q[0]*k,q[1]*k,q[2]]; },zw,zh,{cam,ce:P.ce,sel:sel ? new Set([sel.id]) : null,polys:roofPolys,color:b=>b.kind==='wall' ? (PE_MATCOL[b.mat]||[200,208,214]) : b.kind==='box' ? [201,143,90] : [160,168,173]});
        if(!n.zcv){ n.zcv=document.createElement('canvas'); } if(n.zcv.width!==zw||n.zcv.height!==zh){ n.zcv.width=zw; n.zcv.height=zh; }
        n.zcv.getContext('2d').putImageData(new ImageData(R.data,zw,zh),0,0); cx.save(); cx.imageSmoothingEnabled=fast; cx.drawImage(n.zcv,0,0,W,H); cx.restore(); }
      const order=P.d3 ? [] : peBoxOrder(raw,{dx:cam[0],dy:cam[1],h:P.ce},b=>P.pt(b.cx,b.cy,(b.z0+b.z1)/2)[2]);
      for(const bi of order){ const b=raw[bi];
        const nx=-b.uy, ny=b.ux, h=b.l/2, q=b.t/2, C=[[b.cx+b.ux*h+nx*q,b.cy+b.uy*h+ny*q],[b.cx+b.ux*h-nx*q,b.cy+b.uy*h-ny*q],[b.cx-b.ux*h-nx*q,b.cy-b.uy*h-ny*q],[b.cx-b.ux*h+nx*q,b.cy-b.uy*h+ny*q]];
        const base=b.kind==='wall' ? (PE_MATCOL[b.mat]||[200,208,214]) : b.kind==='box' ? [201,143,90] : [160,168,173], isSel=sel && (sel.id===b.ref || (sel.k==='pt'&&false));
        const col=(k,a)=>'rgb('+base.map(v=>Math.round(Math.min(255,v*k+(isSel?40:0)))).join(',')+')';
        // боковые грани, обращённые к камере
        const sides=[[0,1,[ b.ux, b.uy]],[1,2,[-nx,-ny]],[2,3,[-b.ux,-b.uy]],[3,0,[nx,ny]]];
        for(const [i,j,nr] of sides){ const vis=(nr[0]*cam[0]+nr[1]*cam[1])*P.ce>.02; if(!vis) continue; const k=.5+.2*Math.max(0,nr[0]*.5+nr[1]*-.8);
          const a=P.pt(C[i][0],C[i][1],b.z0), c=P.pt(C[j][0],C[j][1],b.z0), d=P.pt(C[j][0],C[j][1],b.z1), e=P.pt(C[i][0],C[i][1],b.z1);
          cx.beginPath(); cx.moveTo(a[0],a[1]); cx.lineTo(c[0],c[1]); cx.lineTo(d[0],d[1]); cx.lineTo(e[0],e[1]); cx.closePath(); cx.fillStyle=col(k); cx.fill(); if(P.d3){ cx.strokeStyle='rgba(0,0,0,.35)'; cx.lineWidth=.6; cx.stroke(); } }
        const T=C.map(c=>P.pt(c[0],c[1],b.z1)); cx.beginPath(); T.forEach((t,i)=>i ? cx.lineTo(t[0],t[1]) : cx.moveTo(t[0],t[1])); cx.closePath(); cx.fillStyle=col(.92); cx.fill();
        if(P.d3){ cx.strokeStyle='rgba(0,0,0,.4)'; cx.lineWidth=.6; cx.stroke(); }
      } }
    // крыша на плане — пунктиром (скаты и конёк)
    if(!P.d3 && (p.lv==='all' || p.lv==null)) for(const r of s.roofs||[]){ cx.strokeStyle='rgba(255,138,101,.75)'; cx.lineWidth=1; cx.setLineDash([6,4]);
      for(const f of r.faces){ if(f.kind!=='roof') continue; cx.beginPath(); f.pts.forEach((c,k)=>{ const A=P.pt(c[0],c[1],0); k ? cx.lineTo(A[0],A[1]) : cx.moveTo(A[0],A[1]); }); cx.closePath(); cx.stroke(); } cx.setLineDash([]); }
    // символы проёмов в плане
    if(P.se>.75) for(const o of s.objs){ if(o.type!=='door'&&o.type!=='window') continue; const pl=peOpenPlace(s,o); if(!pl) continue; const h=o.w/2, a=P.pt(pl.x-pl.ux*h,pl.y-pl.uy*h,0), b=P.pt(pl.x+pl.ux*h,pl.y+pl.uy*h,0);
      if(o.type==='window'){ cx.strokeStyle='#6fd0ff'; cx.lineWidth=2.5; cx.beginPath(); cx.moveTo(a[0],a[1]); cx.lineTo(b[0],b[1]); cx.stroke(); }
      else { const hinge=a, ang=Math.atan2(-(b[1]-a[1]),b[0]-a[0]), r=Math.hypot(b[0]-a[0],b[1]-a[1]); cx.strokeStyle='#c9a06a'; cx.lineWidth=1.5; cx.beginPath(); cx.arc(hinge[0],hinge[1],r,-ang,-ang-Math.PI/2,true); cx.stroke(); cx.beginPath(); cx.moveTo(hinge[0],hinge[1]); cx.lineTo(hinge[0]+Math.sin(ang)*r*0+Math.cos(-ang-Math.PI/2)*r,hinge[1]+Math.sin(-ang-Math.PI/2)*r); cx.stroke(); } }
    // замки длин и размеры
    const roofOn=P.d3 && (p.lv==='all' || p.lv==null) && (s.roofs||[]).length;                 // под крышей размеры стен не видны — не пишем их поверх
    if(P.sc>14 && !roofOn) for(const w of s.walls){ if(!lvOk(w.lv)) continue; const [a,b]=peWallEnds(s,w), A=P.pt(a.x,a.y,P.d3 ? (w.z0||0)+w.h : 0), B=P.pt(b.x,b.y,P.d3 ? (w.z0||0)+w.h : 0), len=peWallLen(s,w); cx.font='10px monospace'; cx.textAlign='center'; cx.fillStyle=w.len>0 ? '#ffb74d' : 'rgba(180,195,200,.8)'; cx.fillText((w.len>0 ? '🔒' : '')+len.toFixed(2),(A[0]+B[0])/2,(A[1]+B[1])/2-5); }
    // точки
    const hidPts=p.pts==='all' ? null : peHiddenPts(s);
    for(const q of s.pts){ if(hidPts && hidPts.has(q.id) && !(n.sel && n.sel.k==='pt' && n.sel.id===q.id)) continue; const A=P.pt(q.x,q.y,0), isSel=n.sel && n.sel.k==='pt' && n.sel.id===q.id; cx.fillStyle=isSel ? '#ffb74d' : '#7dff9a'; cx.strokeStyle='#000'; cx.lineWidth=1.5; cx.beginPath(); cx.arc(A[0],A[1],isSel ? 5.5 : 4,0,7); cx.stroke(); cx.fill();
      if(q.name){ cx.fillStyle=fg; cx.font='10px monospace'; cx.textAlign='left'; cx.fillText(q.name,A[0]+7,A[1]-6); } }
    // лучи к приёмникам (слой «signal», отражения): прямой — сплошной, отражённые — пунктир; толще и ярче — сильнее
    if(p.layer==='signal' && n.links) for(const a of s.ants){ const L=n.links[a.id]; if(!peIsRx(a) || !L || !L.paths) continue; const top=Math.max(...L.paths.map(q=>q.level));
      for(const q of L.paths.slice().sort((u,v)=>u.level-v.level)){ const rel=Math.max(0,1+(q.level-top)/30); if(rel<=0) continue;
        cx.strokeStyle=q.order===0 ? 'rgba(255,213,79,'+(.35+.6*rel)+')' : q.order===1 ? 'rgba(129,212,250,'+(.25+.6*rel)+')' : 'rgba(206,147,216,'+(.2+.6*rel)+')'; cx.lineWidth=.8+2.2*rel; cx.setLineDash(q.order ? [5,3] : []);
        cx.beginPath(); q.pts.forEach((c,k)=>{ const A=P.pt(c[0],c[1],P.d3 ? c[2] : 0); k ? cx.lineTo(A[0],A[1]) : cx.moveTo(A[0],A[1]); }); cx.stroke(); } cx.setLineDash([]); }
    // линейка
    if(n.ruler){ const a=P.pt(n.ruler.a[0],n.ruler.a[1],0); cx.fillStyle='#ffd54f'; cx.beginPath(); cx.arc(a[0],a[1],3.5,0,7); cx.fill();
      if(n.ruler.b){ const b=P.pt(n.ruler.b[0],n.ruler.b[1],0), d=Math.hypot(n.ruler.b[0]-n.ruler.a[0],n.ruler.b[1]-n.ruler.a[1]);
        cx.strokeStyle='#ffd54f'; cx.lineWidth=2; cx.setLineDash([6,4]); cx.beginPath(); cx.moveTo(a[0],a[1]); cx.lineTo(b[0],b[1]); cx.stroke(); cx.setLineDash([]);
        cx.beginPath(); cx.arc(b[0],b[1],3.5,0,7); cx.fill(); cx.font='bold 12px sans-serif'; cx.textAlign='center'; cx.lineWidth=3; cx.strokeStyle='rgba(0,0,0,.7)';
        const t=d.toFixed(3)+' m', mx=(a[0]+b[0])/2, my=(a[1]+b[1])/2-6; cx.strokeText(t,mx,my); cx.fillText(t,mx,my); } }
    // камеры
    for(const c of s.cams){ const A=P.pt(c.x,c.y,c.z), F=P.pt(c.x,c.y,0), isSel=n.sel&&n.sel.id===c.id; if(P.d3){ cx.strokeStyle='rgba(125,255,154,.45)'; cx.beginPath(); cx.moveTo(A[0],A[1]); cx.lineTo(F[0],F[1]); cx.stroke(); }
      cx.save(); cx.translate(A[0],A[1]); const dir=P.pt(c.x+Math.sin(c.az*PE_D),c.y+Math.cos(c.az*PE_D),c.z), ang=Math.atan2(dir[1]-A[1],dir[0]-A[0]); cx.rotate(ang);
      cx.fillStyle=isSel ? '#ffb74d' : c.auto ? '#6fd0ff' : '#7dff9a'; cx.strokeStyle='#000'; cx.lineWidth=1.5; cx.beginPath(); cx.moveTo(10,0); cx.lineTo(-6,-6); cx.lineTo(-6,6); cx.closePath(); cx.stroke(); cx.fill(); cx.restore();
      cx.fillStyle=fg; cx.font='10px monospace'; cx.textAlign='left'; cx.fillText(c.name,A[0]+9,A[1]-8); }
    // антенны: передающие — ромб с волнами, приёмные — «вилка» с уровнем и запасом
    for(const a of s.ants){ const A=P.pt(a.x,a.y,a.z), F=P.pt(a.x,a.y,0), isSel=n.sel&&n.sel.id===a.id, rx=peIsRx(a); if(P.d3){ cx.strokeStyle=rx ? 'rgba(199,146,255,.55)' : 'rgba(255,183,77,.5)'; cx.beginPath(); cx.moveTo(A[0],A[1]); cx.lineTo(F[0],F[1]); cx.stroke(); }
      const col=isSel ? '#fff' : rx ? '#c792ff' : a.auto ? '#6fd0ff' : '#ffb74d';
      cx.fillStyle=col; cx.strokeStyle='#000'; cx.lineWidth=1.5; cx.beginPath();
      if(rx){ cx.arc(A[0],A[1],6,0,7); cx.stroke(); cx.fill(); cx.strokeStyle=col; cx.lineWidth=2; cx.beginPath(); cx.moveTo(A[0],A[1]-6); cx.lineTo(A[0],A[1]-14); cx.moveTo(A[0]-6,A[1]-14); cx.lineTo(A[0],A[1]-8); cx.lineTo(A[0]+6,A[1]-14); cx.stroke(); }
      else { cx.moveTo(A[0],A[1]-7); cx.lineTo(A[0]+6,A[1]); cx.lineTo(A[0],A[1]+7); cx.lineTo(A[0]-6,A[1]); cx.closePath(); cx.stroke(); cx.fill(); cx.strokeStyle='#ffb74d'; cx.lineWidth=1.2; for(const r of [10,15]){ cx.beginPath(); cx.arc(A[0],A[1],r,-2.4,-.75); cx.stroke(); } }
      cx.fillStyle=fg; cx.font='10px monospace'; cx.textAlign='left'; let lab=a.name+(rx ? '' : ' '+(a.f>=1000 ? (a.f/1000)+' GHz' : a.f+' MHz'));
      if(rx){ const L=n.links && n.links[a.id]; lab+=L ? (L.from ? ' '+L.level.toFixed(0)+' dBm '+(L.ok ? '✓' : '✗ '+L.margin.toFixed(0)+' dB') : ' — no signal') : ''; if(L) cx.fillStyle=L.ok ? '#7dff9a' : '#ff8a80'; }
      cx.fillText(lab,A[0]+10,A[1]-10); }
    // поза телефона (общее пространство с Video Overlay)
    { const o=peOrigin(n), ps=n.inPose; if(n.georef && ps.lat!=null && ps.lon!=null){ const l=peLocal(o,ps.lat,ps.lon), z=(ps.alt!=null ? ps.alt-o.alt : 1.5), A=P.pt(l[0],l[1],Math.max(0,z)); cx.fillStyle='#ff6bd6'; cx.strokeStyle='#000'; cx.lineWidth=1.5; cx.beginPath(); cx.arc(A[0],A[1],6,0,7); cx.stroke(); cx.fill();
        if(ps.az!=null){ const az=peAzPlan(o,ps.az), f=(ps.fov||60)/2, len=Math.min(4,3/Math.max(.2,Math.cos(((ps.el||0))*PE_D))); cx.strokeStyle='#ff6bd6'; cx.lineWidth=1.5; cx.beginPath(); for(const d of [-f,f]){ const T=P.pt(l[0]+Math.sin((az+d)*PE_D)*len,l[1]+Math.cos((az+d)*PE_D)*len,Math.max(0,z)); cx.moveTo(A[0],A[1]); cx.lineTo(T[0],T[1]); } cx.stroke(); }
        cx.fillStyle='#ff6bd6'; cx.font='10px monospace'; cx.textAlign='left'; cx.fillText('phone',A[0]+9,A[1]-8); } }
    // выбранное: рамка и ручка направления
    { const it=peItem(n); if(it){ const k=n.sel.k; cx.strokeStyle='#ffb74d'; cx.lineWidth=2;
        if(k==='wall'){ const [a,b]=peWallEnds(s,it), A=P.pt(a.x,a.y,it.h), B=P.pt(b.x,b.y,it.h); cx.beginPath(); cx.moveTo(A[0],A[1]); cx.lineTo(B[0],B[1]); cx.stroke(); }
        else if(k==='obj'){ let q; if(it.type==='door'||it.type==='window'){ const pl=peOpenPlace(s,it); q=pl ? P.pt(pl.x,pl.y,it.sill+it.h/2) : null; } else q=P.pt(it.x,it.y,(it.z||0)+it.h/2); if(q){ cx.beginPath(); cx.arc(q[0],q[1],11,0,7); cx.stroke(); } }
        else if(k==='cam'||k==='ant'){ const A=P.pt(it.x,it.y,it.z), h=peHandle(it,P); cx.beginPath(); cx.arc(A[0],A[1],13,0,7); cx.stroke(); cx.strokeStyle='rgba(255,255,255,.7)'; cx.lineWidth=1; cx.beginPath(); cx.moveTo(A[0],A[1]); cx.lineTo(h[0],h[1]); cx.stroke(); cx.fillStyle='#fff'; cx.strokeStyle='#000'; cx.beginPath(); cx.arc(h[0],h[1],6,0,7); cx.stroke(); cx.fill(); }
        else if(k==='pt'){ } } }
    for(const h of peGizmo(n,P)){
      cx.strokeStyle=cx.fillStyle=h.col; cx.lineWidth=3;
      if(h.ax==='xy'){ cx.fillRect(h.b[0]-6,h.b[1]-6,12,12); cx.strokeStyle='#000'; cx.lineWidth=1; cx.strokeRect(h.b[0]-6,h.b[1]-6,12,12); continue; }
      const ux=h.u[0], uy=h.u[1]; cx.beginPath(); cx.moveTo(h.a[0],h.a[1]); cx.lineTo(h.b[0]-ux*8,h.b[1]-uy*8); cx.stroke();
      cx.beginPath(); cx.moveTo(h.b[0],h.b[1]); cx.lineTo(h.b[0]-ux*13-uy*7,h.b[1]-uy*13+ux*7); cx.lineTo(h.b[0]-ux*13+uy*7,h.b[1]-uy*13-ux*7); cx.closePath(); cx.fill(); cx.strokeStyle='#000'; cx.lineWidth=1; cx.stroke();
    }
    // строка инструментов: подпись, если влезает, иначе только значок
    { cx.fillStyle='rgba(20,26,30,.92)'; cx.fillRect(0,0,W,PE_BAR); const items=PE_TOOLS.map(t=>({id:t[0],ic:t[0],name:t[2]})).concat([{id:'#view',ic:p.view==='3D' ? '#viewPlan' : '#view3D',name:p.view==='3D' ? 'plan' : '3D'},{id:'#fit',ic:'#fit',name:'fit'},{id:'#undo',ic:'#undo',name:'undo'},{id:'#redo',ic:'#redo',name:'redo'}]), bw=W/items.length;
      cx.textBaseline='middle'; cx.textAlign='center';
      items.forEach((it,i)=>{ const on=p.tool===it.id; cx.fillStyle=on ? '#ffb74d' : 'rgba(255,255,255,.06)'; cx.fillRect(i*bw+1,1,bw-2,PE_BAR-2); cx.fillStyle=on ? '#000' : '#dfe7ea';
        const col=on ? '#000' : '#dfe7ea', r=Math.min(PE_BAR*.34,bw*.32); cx.font=Math.round(PE_BAR*.36)+'px sans-serif'; const tw=cx.measureText(it.name).width;
        if(tw+2*r+10<bw){ const x0=i*bw+(bw-(2*r+4+tw))/2; peIcon(cx,it.ic,x0+r,PE_BAR/2,r,col); cx.textAlign='left'; cx.fillText(it.name,x0+2*r+4,PE_BAR/2+1); cx.textAlign='center'; }   // иконка и подпись, если влезает
        else peIcon(cx,it.ic,i*bw+bw/2,PE_BAR/2,r,col); });
      cx.textBaseline='alphabetic'; }
    peDrawCamView(n,cx,W,H);
    peDrawChips(n,cx,W,H,fg);
    // сводка
    if(n.msg) L.push(n.msg);
    { const it=peItem(n); if(it){ const k=n.sel.k; L.push('selected: '+(k==='pt' ? 'point '+(it.name||it.id)+' ('+it.x.toFixed(2)+', '+it.y.toFixed(2)+')' : k==='wall' ? 'wall '+peWallLen(s,it).toFixed(2)+' m, '+(it.t*100).toFixed(0)+' cm thick, '+it.h+' m high, '+it.mat+(it.len>0 ? ', length locked' : '')+(s.ants.length ? ' · signal loss '+peMatLoss(it.mat,s.ants[0].f,it.t).toFixed(1)+' dB at '+s.ants[0].f+' MHz' : '') : k==='obj' ? it.type+' '+it.w+(it.type==='box' ? '×'+it.d : '')+' m' : (k==='cam' ? 'camera ' : 'antenna ')+it.name+' at '+it.z+' m, az '+it.az+'°')); } }
    L.push(s.pts.length+' points · '+s.walls.length+' walls · '+s.objs.length+' objects · '+s.cams.length+' camera'+(s.cams.length===1 ? '' : 's')+' · '+s.ants.length+' antenna'+(s.ants.length===1 ? '' : 's')+(s.rooms.length ? ' · rooms '+n.area.toFixed(1)+' m²' : ''));
    if(n.under && n.under.err) L.push('⚠ '+n.under.err);
    if(n.overlaps && n.overlaps.length) L.push('⚠ '+n.overlaps.length+' object'+(n.overlaps.length===1 ? '' : 's')+' go through a wall ('+n.overlaps.slice(0,3).map(o=>{ const ob=s.objs.find(q=>q.id===o.obj); return ob ? (ob.name||ob.type) : o.obj; }).join(', ')+'): move them or turn them — the 3D picture and the plan are wrong there (a box’s width runs along the north at rotation 0)');
    for(const a of s.ants) if(peIsRx(a)){ const r=n.links && n.links[a.id]; L.push('receiver '+a.name+' ('+(a.f>=1000 ? a.f/1000+' GHz' : a.f+' MHz')+'): '+(r && r.from ? r.level.toFixed(1)+' dBm from '+r.name+', margin '+(r.margin>=0 ? '+' : '')+r.margin.toFixed(1)+' dB over '+a.sens+' dBm'+(r.paths && r.paths.length>1 ? ' · direct '+r.paths[0].level.toFixed(1)+' dBm + '+(r.paths.length-1)+' reflected (+'+(r.level-r.paths[0].level).toFixed(1)+' dB)' : '') : 'no transmitter on this frequency')); }
    if(n.camCov) L.push('cameras see '+(100*n.camCov.cover).toFixed(0)+'% of '+(s.rooms.length ? 'the rooms' : 'the area')+' ('+n.camCov.seen.toFixed(1)+' of '+n.camCov.total.toFixed(1)+' m², blind '+(n.camCov.total-n.camCov.seen).toFixed(1)+' m², by two or more '+n.camCov.multi.toFixed(1)+' m²)');
    if(n.antHeat) L.push('signal above '+p.thr+' dBm in '+(100*n.antHeat.share).toFixed(0)+'% · mean '+n.antHeat.mean.toFixed(0)+' dBm, weakest '+n.antHeat.min.toFixed(0)+' dBm');
    if(!n.sel && p.tool==='select') L.push('tap an item to select it: a strip with its parameters (thickness, height, length lock, field of view, power, frequency…) appears at the bottom of the canvas; drag the arrows on it to move it (the body itself is never dragged by accident), ↶ ↷ in the toolbar undo');
    L.push(p.tool==='select' ? (P.d3 ? 'drag empty space — turn the model · wheel / pinch — zoom at the cursor or between the fingers · twist two fingers — rotate · right drag / shift — move · click an object — select, drag its arrows — move' : 'click — select; the selected item has arrow handles (← → ↑ ↓, square — free) · empty space: drag — pan · wheel — zoom at the cursor · double click — fit · arrows nudge · Ctrl+Z / Ctrl+Shift+Z — undo / redo') : 'tool «'+p.tool+'»: click to use; drag moves the view; Esc — back to select');
    if(n.georef) L.push('georeferenced: records go to Video Overlay / Map (floor altitude '+(+p.oalt)+' m)'); else L.push('no georeference (advanced: origin lat / lon): the records carry local x, y, z');
    n.el.querySelector('.readout').textContent=L.join('\n');
  }});
