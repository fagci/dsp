"use strict";
/* ============================ Photo Measure и Clinometer ============================
   Photo Measure: снимок + известный прямоугольник в кадре (лист A4, карта…) → метры. Четыре клика по углам эталона (верхний левый, верхний правый,
   нижний правый, нижний левый), дальше клики по точкам на той же плоскости (пол, земля, стена): расстояния, площадь, строки для Site Plan.
   Clinometer: угол места камеры по акселерометру; высота дерева / дома с известного расстояния — без высоты глаза. Ядро — photomeasure-kernels.js. */

// ---------- демо-снимок: плоскость 4×3 м в перспективе, лист A4 и «грядка» 3×1.5 м ----------
const PM_DEMO={W:800,H:560, quad:[[190,520],[640,520],[560,170],[270,170]], A4at:[1.0,.5], bed:[[.5,1.0],[3.5,1.0],[3.5,2.5],[.5,2.5]]};
function pmDemo(){
  const D=PM_DEMO;
  const toPx=(u,v)=>{ const q=[[0,0],[4,0],[4,3],[0,3]], Q=[D.quad[0],D.quad[1],D.quad[2],D.quad[3]]; const H=pmHomography(q,Q); return pmApply(H,u,v); };
  const c=document.createElement('canvas'); c.width=D.W; c.height=D.H; const x=c.getContext('2d');
  x.fillStyle='#6b7f5a'; x.fillRect(0,0,D.W,D.H);
  x.fillStyle='#b9d4ef'; x.fillRect(0,0,D.W,120);
  const poly=(pts,fill,stroke,lw)=>{ x.beginPath(); pts.forEach((p,i)=>{ const q=toPx(p[0],p[1]); i ? x.lineTo(q[0],q[1]) : x.moveTo(q[0],q[1]); }); x.closePath(); if(fill){ x.fillStyle=fill; x.fill(); } if(stroke){ x.strokeStyle=stroke; x.lineWidth=lw||2; x.stroke(); } };
  poly([[0,0],[4,0],[4,3],[0,3]],'#8a9a73','#4c5a3d',2);
  for(let i=1;i<4;i++){ poly([[i,0],[i,3],[i,0]],null,'rgba(255,255,255,.18)',1); }
  for(let j=1;j<3;j++){ poly([[0,j],[4,j],[0,j]],null,'rgba(255,255,255,.18)',1); }
  poly(D.bed,'#5b4630','#e8d9a8',3);
  const [au,av]=D.A4at, sheet=[[au,av+.21],[au+.297,av+.21],[au+.297,av],[au,av]];       // TL, TR, BR, BL
  poly(sheet,'#fff','#222',2);
  return {canvas:c, ref:sheet.map(p=>toPx(p[0],p[1])), pts:D.bed.map(p=>toPx(p[0],p[1]))};
}

// ---------- Photo Measure ----------
const PM_CORN=['top-left','top-right','bottom-right','bottom-left'];
const PM_SCALE2='2 points: a scan / map scale';
const pmNeed=n=>n.p.ref===PM_SCALE2 ? 2 : 4;

// демо-скан: чертёж участка 30×18 м с домом на бумаге, масштабная линейка 10 м, север вверху
function pmDemoScan(){
  const W=800,H=560,c=document.createElement('canvas'); c.width=W; c.height=H; const x=c.getContext('2d'), k=20, X0=100, Y0=60;       // 20 px = 1 м
  x.fillStyle='#fbf7e8'; x.fillRect(0,0,W,H);
  x.strokeStyle='rgba(120,100,60,.15)'; x.lineWidth=1; for(let i=0;i<W;i+=k){ x.beginPath(); x.moveTo(i,0); x.lineTo(i,H); x.stroke(); } for(let j=0;j<H;j+=k){ x.beginPath(); x.moveTo(0,j); x.lineTo(W,j); x.stroke(); }
  const plot=[[0,18],[30,18],[30,0],[0,0]], P=q=>[X0+q[0]*k,Y0+(18-q[1])*k];                  // метры (v вверх) → пиксели
  x.strokeStyle='#223'; x.lineWidth=3; x.beginPath(); plot.forEach((q,i)=>{ const p=P(q); i ? x.lineTo(p[0],p[1]) : x.moveTo(p[0],p[1]); }); x.closePath(); x.stroke();
  x.fillStyle='rgba(160,120,80,.35)'; x.strokeStyle='#642'; x.lineWidth=2; x.beginPath(); [[5,5],[15,5],[15,11],[5,11]].forEach((q,i)=>{ const p=P(q); i ? x.lineTo(p[0],p[1]) : x.moveTo(p[0],p[1]); }); x.closePath(); x.fill(); x.stroke();
  x.fillStyle='#223'; x.font='14px sans-serif'; x.fillText('house',P([8,8])[0],P([8,8])[1]); x.fillText('N ↑',W-70,50);
  const a=[X0,H-60], b=[X0+10*k,H-60]; x.lineWidth=4; x.beginPath(); x.moveTo(a[0],a[1]); x.lineTo(b[0],b[1]); x.stroke(); x.fillText('10 m',a[0]+80,H-68);
  return {canvas:c, ref:[a,b], pts:plot.map(P)};
}
function pmLoad(n,f){
  createImageBitmap(f).then(bm=>{ n.bm?.close?.(); n.bm=bm; n.ref=[]; n.pts=[]; n.msg='image '+bm.width+'×'+bm.height+': click the '+(pmNeed(n)===2 ? '2 scale points' : '4 corners of the reference'); pmSave(n); n.dirty=true; },e=>{ n.msg='cannot read the image: '+e.message; });
}
function pmUseDemoScan(n){
  const d=pmDemoScan(); n.bm=d.canvas; n.ref=d.ref; n.pts=d.pts; n.p.ref=PM_SCALE2; n.set?.ref?.(PM_SCALE2); n.p.rd=10; n.set?.rd?.(10); n.p.mode='trace'; n.set?.mode?.('trace');
  n.msg='demo scan: a 30×18 m plot with a house; the scale line (10 m) is clicked, north is up'; pmSave(n); n.dirty=true;
}
function pmUseDemo(n){
  const d=pmDemo(); n.bm=d.canvas; n.ref=d.ref; n.pts=d.pts; n.msg='demo image: a 4×3 m plane in perspective, an A4 sheet and a 3×1.5 m bed'; pmSave(n); n.dirty=true;
}
function pmSave(n){ n.p.state=JSON.stringify({ref:n.ref,pts:n.pts}); }
function pmRefSize(n){
  const r=PM_REFS[n.p.ref]; return r ? r : [Math.max(.001,+n.p.rw),Math.max(.001,+n.p.rh)];
}
function pmCalc(n){                                               // гомография и точки в метрах
  n.H=null; n.mp=[];
  if(pmNeed(n)===2){
    if(n.ref.length===2){ n.H=pmScale2(n.ref[0],n.ref[1],+n.p.rd); n.bad=n.H ? '' : 'the two scale points coincide, or the distance is 0'; } else n.bad='';
  } else if(n.ref.length===4){
    if(!pmQuadOk(n.ref)){ n.H=null; n.bad='the corners must go top-left → top-right → bottom-right → bottom-left, around the reference'; }
    else { n.bad=''; const [w,h]=pmRefSize(n); n.H=pmHomography(n.ref,pmRect(w,h)); }
  } else n.bad='';
  if(n.H) n.mp=n.pts.map(q=>pmApply(n.H,q[0],q[1]));
  const nm=n.mp.map((_,i)=>(String(n.p.prefix||'P').replace(/[\s-]+/g,'_'))+(i+1));
  n.lines=!n.H ? '' : n.p.mode==='trace' ? (n.pts.length ? pmLinesTrace(n.mp,nm,+n.p.up||0,n.p.poly && n.pts.length>=3) : '') : n.pts.length>1 ? pmLines(n.mp,nm,n.p.mode,n.p.poly && n.pts.length>=3) : '';
}

def({ id:'photomeasure', title:'Photo Measure', cat:'Geo', touch:true, kw:'photo measure ruler a4 reference homography perspective distance area plan wall floor facade camera scale site',
  // lines — замеры для Site Plan (A-B 3.42 ± 0.06): расстояния между всеми парами точек; dist — последний отрезок, м; len — ломаная по порядку, м; area — площадь многоугольника, м²
  outs:[{n:'lines',t:'txt'},{n:'dist',t:'num'},{n:'len',t:'num'},{n:'area',t:'num'},{n:'n',t:'num'}],
  w:460, view:{h:360}, resize:true, readout:true,
  params:[{n:'file',t:'file',accept:'image/*',label:'photo (a phone offers the camera)',fn:(n,f)=>pmLoad(n,f)},
          {n:'demo',t:'button',label:'Demo photo',fn:n=>pmUseDemo(n)},
          {n:'demo2',t:'button',label:'Demo scan (plan with a scale line)',fn:n=>pmUseDemoScan(n)},
          {n:'ref',t:'select',opts:[...Object.keys(PM_REFS),PM_SCALE2],d:'A4 (297×210)',label:'reference in the frame (lying in the same plane as what you measure) · or the 2-point scale of a scan / map / satellite screenshot',fn:n=>{ n.ref=[]; n.dirty=true; pmSave(n); }},
          {n:'rd',t:'num',d:10,label:'scan scale: the real distance between the 2 clicked points, m',fn:n=>{ n.dirty=true; }},
          {n:'up',t:'range',min:-180,max:180,step:1,d:0,label:'scan north: bearing of the image’s «up», ° (0 — up is north; 90 — up is east)',fn:n=>{ n.dirty=true; }},
          {n:'rw',t:'num',d:.3,label:'custom reference width, m (top edge)',fn:n=>{ n.dirty=true; }},
          {n:'rh',t:'num',d:.2,label:'custom reference height, m (side edge)',fn:n=>{ n.dirty=true; }},
          {n:'mode',t:'select',opts:['ground','wall','trace'],d:'ground',label:'lines: ground / floor (distances between points) · wall (width and height; the reference’s top edge is horizontal) · trace (coordinates «P1 at x y» in metres, north up — for a scan / map)',fn:n=>{ n.dirty=true; }},
          {n:'prefix',t:'text',d:'P',label:'point name prefix for Site Plan (P → P1, P2…)'},
          {n:'poly',t:'check',d:true,label:'add «poly» (a contour through the points in order) to the lines'},
          {n:'undo',t:'button',label:'Undo last point',fn:n=>{ if(n.pts.length) n.pts.pop(); else n.ref.pop(); pmSave(n); n.dirty=true; }},
          {n:'reset',t:'button',label:'Reset points and reference',fn:n=>{ n.ref=[]; n.pts=[]; pmSave(n); n.msg='click the reference'; n.dirty=true; }},
          {n:'autodemo',t:'select',opts:['off','photo','scan'],d:'off',label:'load a demo image on start',adv:true},
          {n:'state',t:'text',d:'',hidden:true}],
  init:n=>{ n.bm=null; n.ref=[]; n.pts=[]; n.H=null; n.mp=[]; n.lines=''; n.msg=''; n.bad=''; n.dirty=true; n.drag=null; n.vt=null;
    try{ const s=JSON.parse(n.p.state||'null'); if(s){ n.ref=s.ref||[]; n.pts=s.pts||[]; } }catch(e){}
    if(n.p.autodemo==='photo') pmUseDemo(n); else if(n.p.autodemo==='scan') pmUseDemoScan(n); },
  process(n){
    if(n.dirty){ n.dirty=false; pmCalc(n); }
    const P=n.mp, m=P.length;
    let len=0; for(let i=1;i<m;i++) len+=pmDist(P[i-1],P[i]);
    return {lines:n.lines, dist:m>1 ? pmDist(P[m-2],P[m-1]) : null, len:m>1 ? len : null, area:m>2 ? pmArea(P) : null, n:n.pts.length};
  },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, L=[], fg=themeColor('--scr-txt')||'#9fb0b6';
    cx.fillStyle=themeColor('--screen')||'#0a0d0e'; cx.fillRect(0,0,W,H);
    if(n.msg) L.push(n.msg);
    if(n.bad) L.push('⚠ '+n.bad);
    if(!n.bm){ cx.fillStyle=fg; cx.font='12px sans-serif'; cx.textAlign='center'; cx.fillText('choose a photo or press «Demo image»',W/2,H/2); n.vt=null; }
    else {
      const iw=n.bm.width, ih=n.bm.height, s=Math.min(W/iw,H/ih), ox=(W-iw*s)/2, oy=(H-ih*s)/2; n.vt={s,ox,oy};
      cx.drawImage(n.bm,ox,oy,iw*s,ih*s);
      const X=q=>[ox+q[0]*s, oy+q[1]*s];
      cx.font='11px monospace'; cx.textBaseline='alphabetic';
      if(n.ref.length){
        cx.strokeStyle='#ffb74d'; cx.lineWidth=2; cx.beginPath(); n.ref.forEach((q,i)=>{ const p=X(q); i ? cx.lineTo(p[0],p[1]) : cx.moveTo(p[0],p[1]); }); if(n.ref.length===4 && pmNeed(n)===4) cx.closePath(); cx.stroke();
        n.ref.forEach((q,i)=>{ const p=X(q); cx.fillStyle='#ffb74d'; cx.beginPath(); cx.arc(p[0],p[1],5,0,7); cx.fill(); cx.fillStyle='#000'; cx.textAlign='center'; cx.fillText(String(i+1),p[0],p[1]+4); });
      }
      if(n.pts.length>1){ cx.strokeStyle='rgba(125,255,154,.85)'; cx.lineWidth=2; cx.beginPath(); n.pts.forEach((q,i)=>{ const p=X(q); i ? cx.lineTo(p[0],p[1]) : cx.moveTo(p[0],p[1]); }); if(n.pts.length>2 && n.p.poly) cx.closePath(); cx.stroke(); }
      if(n.H) for(let i=1;i<n.pts.length;i++){
        const a=X(n.pts[i-1]), b=X(n.pts[i]), d=pmDist(n.mp[i-1],n.mp[i]), t=(d<1 ? (d*100).toFixed(0)+' cm' : d.toFixed(2)+' m');
        const mx=(a[0]+b[0])/2, my=(a[1]+b[1])/2; cx.textAlign='center'; cx.lineWidth=3; cx.strokeStyle='rgba(0,0,0,.75)'; cx.strokeText(t,mx,my-5); cx.fillStyle='#fff'; cx.fillText(t,mx,my-5);
      }
      n.pts.forEach((q,i)=>{ const p=X(q); cx.fillStyle='#7dff9a'; cx.strokeStyle='#000'; cx.lineWidth=1.5; cx.beginPath(); cx.arc(p[0],p[1],5,0,7); cx.stroke(); cx.fill();
        cx.fillStyle='#fff'; cx.textAlign='left'; cx.strokeStyle='rgba(0,0,0,.75)'; cx.strokeText((n.p.prefix||'P')+(i+1),p[0]+8,p[1]-6); cx.fillText((n.p.prefix||'P')+(i+1),p[0]+8,p[1]-6); });
      if(n.ref.length<pmNeed(n)) L.push(pmNeed(n)===2 ? 'click scale point '+(n.ref.length+1)+'/2 (the ends of a distance of '+(+n.p.rd)+' m on the scan: a scale bar, a known wall)' : 'click reference corner '+(n.ref.length+1)+'/4: '+PM_CORN[n.ref.length]+' ('+(n.p.ref)+')');
      else if(n.H){
        const m=n.mp.length;
        L.push((pmNeed(n)===2 ? 'scale '+(+n.p.rd)+' m = '+Math.round(Math.hypot(n.ref[1][0]-n.ref[0][0],n.ref[1][1]-n.ref[0][1]))+' px' : 'reference '+pmRefSize(n).map(v=>+(v*100).toFixed(1)).join(' × ')+' cm')+' · '+m+' point'+(m===1 ? '' : 's')+' · click to add, drag to move'+(m>1 ? ' · error ≈ 1.5 % + 1 cm' : ''));
        if(m>1){ let len=0; for(let i=1;i<m;i++) len+=pmDist(n.mp[i-1],n.mp[i]); L.push('path '+len.toFixed(3)+' m'+(m>2 ? ' · area '+pmArea(n.mp).toFixed(3)+' m²' : '')); }
      }
    }
    indWire(n,cv,{
      down:(x,y)=>{
        if(!n.vt) return; const {s,ox,oy}=n.vt, near=q=>Math.hypot(ox+q[0]*s-x,oy+q[1]*s-y)<16;
        const ri=n.ref.findIndex(near), pi=n.pts.findIndex(near);
        if(ri>=0){ n.drag={k:'ref',i:ri}; return; }
        if(pi>=0){ n.drag={k:'pts',i:pi}; return; }
        const q=[(x-ox)/s,(y-oy)/s]; if(q[0]<0||q[1]<0||q[0]>n.bm.width||q[1]>n.bm.height) return;
        if(n.ref.length<pmNeed(n)){ n.ref.push(q); n.drag={k:'ref',i:n.ref.length-1}; } else { n.pts.push(q); n.drag={k:'pts',i:n.pts.length-1}; }
        n.dirty=true; pmSave(n); },
      move:(x,y)=>{ if(!n.drag||!n.vt) return; const {s,ox,oy}=n.vt; n[n.drag.k][n.drag.i]=[Math.max(0,Math.min(n.bm.width,(x-ox)/s)),Math.max(0,Math.min(n.bm.height,(y-oy)/s))]; n.dirty=true; },
      up:()=>{ if(n.drag){ n.drag=null; pmSave(n); } }});
    n.el.querySelector('.readout').textContent=L.join('\n');
  }});

// ---------- Clinometer ----------
function clinoSensor(n){
  if(n.onMot) return;
  const start=()=>{ n.onMot=e=>{ const a=e.accelerationIncludingGravity; if(a && a.x!=null) n.mot=[a.x,a.y,a.z]; }; window.addEventListener('devicemotion',n.onMot); n.msg='sensor on'; };
  try{
    if(typeof DeviceMotionEvent!=='undefined' && DeviceMotionEvent.requestPermission) DeviceMotionEvent.requestPermission().then(r=>{ if(r==='granted') start(); else n.msg='permission denied'; },e=>{ n.msg=String(e); });
    else if(typeof DeviceMotionEvent!=='undefined') start(); else n.msg='no motion sensor in this browser — wire ax / ay / az from Phone sensors';
  }catch(e){ n.msg=String(e); }
}
function clinoStop(n){ if(n.onMot){ window.removeEventListener('devicemotion',n.onMot); n.onMot=null; } }
const clinoSave=n=>{ n.p.state=JSON.stringify({top:n.top,base:n.base}); };
function clinoSight(n,which){
  if(!isFinite(n.elev)){ n.msg='no angle yet — allow the sensor or wire ax / ay / az (accelerometer with gravity)'; return; }
  n[which]=n.elev; clinoSave(n); n.msg=which+' sighted at '+n.elev.toFixed(2)+'°';
}

def({ id:'clinometer', title:'Clinometer', cat:'Geo', touch:true, kw:'clinometer height tree building inclinometer angle elevation sight tilt accelerometer phone distance',
  // ax / ay / az — акселерометр с гравитацией (Phone sensors, м/с²); без них — собственный датчик браузера («Allow sensor»).
  // elev — угол места оси задней камеры, °; height — высота объекта, м; dist — расстояние, м; eyeh — высота камеры, м; line — строка для Site Plan
  ins:[{n:'ax',t:'num'},{n:'ay',t:'num'},{n:'az',t:'num'}],
  outs:[{n:'elev',t:'num'},{n:'height',t:'num'},{n:'dist',t:'num'},{n:'eyeh',t:'num'},{n:'line',t:'txt'}],
  w:360, view:{h:150}, resize:true, readout:true,
  params:[{n:'on',t:'button',label:'Allow sensor',fn:n=>clinoSensor(n)},
          {n:'base',t:'button',label:'① Sight the BASE (point the back camera at the foot)',fn:n=>clinoSight(n,'base')},
          {n:'top',t:'button',label:'② Sight the TOP',fn:n=>clinoSight(n,'top')},
          {n:'d',t:'num',d:0,label:'horizontal distance to the object, m (0 — from the eye height and the base sighting)'},
          {n:'eye',t:'num',d:1.5,label:'eye (phone) height above the ground, m — used when there is no base sighting or no distance'},
          {n:'from',t:'text',d:'E',label:'standing point (name in Site Plan)'},
          {n:'to',t:'text',d:'R',label:'sighted point (name in Site Plan)'},
          {n:'tau',t:'range',min:0,max:1,step:.05,d:.2,label:'smoothing, s'},
          {n:'bias',t:'range',min:-5,max:5,step:.05,d:0,label:'angle offset, ° (put the phone on a level table: the offset is its reading)'},
          {n:'flip',t:'check',d:false,label:'flip the sign (iPhone)'},
          {n:'reset',t:'button',label:'Forget the sightings',fn:n=>{ n.top=null; n.base=null; clinoSave(n); n.msg=''; }},
          {n:'state',t:'text',d:'',hidden:true}],
  init:n=>{ n.mot=null; n.onMot=null; n.v=null; n.t0=0; n.elev=NaN; n.top=null; n.base=null; n.msg='';
    try{ const s=JSON.parse(n.p.state||'null'); if(s){ n.top=s.top ?? null; n.base=s.base ?? null; } }catch(e){} },
  dispose:n=>clinoStop(n),
  onStop:n=>clinoStop(n),
  process(n,I){
    const p=n.p, a=[recNum(I.ax),recNum(I.ay),recNum(I.az)], w=a.every(v=>v!==null) ? a : n.mot;
    if(w){
      const now=performance.now(), k=n.v && p.tau>0 ? 1-Math.exp(-(now-n.t0)/(1000*p.tau)) : 1; n.t0=now;
      n.v=n.v ? n.v.map((v,i)=>v+(w[i]-v)*k) : w.slice();
      n.elev=clinoElev(n.v[0],n.v[1],n.v[2],p.flip)-p.bias;
    }
    // высота: верх и низ → d (задано или из высоты глаза и прицела на основание); только верх → eye + d·tg
    let d=+p.d>0 ? +p.d : NaN, eye=+p.eye, h=null, line='';
    const top=n.top, base=n.base;
    if(base!==null && !(d>0) && eye>0) d=clinoDist(eye,base);
    if(top!==null && base!==null && d>0){ const r=clinoHeight(d,top,base); h=r.height; eye=r.eye; }
    else if(top!==null && d>0 && eye>=0) h=eye+d*Math.tan(top*Math.PI/180);
    if(top!==null && d>0) line=clinoLine(String(p.from||'E').replace(/[\s-]+/g,'_'),String(p.to||'R').replace(/[\s-]+/g,'_'),top,d,eye);
    n.r={h,d,eye,line};
    return {elev:isFinite(n.elev) ? n.elev : null, height:h, dist:d>0 ? d : null, eyeh:eye>=0 ? eye : null, line};
  },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, fg=themeColor('--scr-txt')||'#9fb0b6', L=[];
    cx.fillStyle=themeColor('--screen')||'#0a0d0e'; cx.fillRect(0,0,W,H);
    // шкала −60…+90°
    const lo=-60, hi=90, X0=14, X1=W-14, xa=a=>X0+(a-lo)/(hi-lo)*(X1-X0), y=H*.55;
    cx.strokeStyle=fg; cx.fillStyle=fg; cx.lineWidth=1; cx.font='10px monospace'; cx.textAlign='center';
    cx.beginPath(); cx.moveTo(X0,y); cx.lineTo(X1,y); cx.stroke();
    for(let a=lo;a<=hi;a+=10){ cx.beginPath(); cx.moveTo(xa(a),y-(a%30===0 ? 8 : 4)); cx.lineTo(xa(a),y+(a%30===0 ? 8 : 4)); cx.stroke(); if(a%30===0) cx.fillText(a+'°',xa(a),y+22); }
    const mark=(a,col,t)=>{ if(a===null || !isFinite(a)) return; cx.fillStyle=col; cx.beginPath(); cx.moveTo(xa(a),y-2); cx.lineTo(xa(a)-5,y-16); cx.lineTo(xa(a)+5,y-16); cx.closePath(); cx.fill(); cx.textAlign='center'; cx.fillText(t,xa(a),y-20); };
    mark(n.base,'#ffb74d','base'); mark(n.top,'#4fc3f7','top');
    if(isFinite(n.elev)){ cx.fillStyle='#7dff9a'; cx.fillRect(xa(Math.max(lo,Math.min(hi,n.elev)))-1,y-26,2,52); cx.font='16px monospace'; cx.textAlign='left'; cx.fillText(n.elev.toFixed(1)+'°',X0,22); }
    else { cx.font='11px sans-serif'; cx.textAlign='center'; cx.fillStyle=fg; cx.fillText('no angle: «Allow sensor» or wire ax / ay / az',W/2,22); }
    if(n.msg) L.push(n.msg);
    const r=n.r||{};
    if(n.base!==null) L.push('base '+n.base.toFixed(2)+'°'+(r.d>0 && !(+n.p.d>0) ? ' → distance '+r.d.toFixed(2)+' m (from the eye height '+(+n.p.eye).toFixed(2)+' m)' : ''));
    if(n.top!==null) L.push('top '+n.top.toFixed(2)+'°');
    if(r.h!==null && r.h!==undefined) L.push('height ≈ '+r.h.toFixed(2)+' m'+(n.base!==null && n.top!==null ? ' · eye '+r.eye.toFixed(2)+' m' : ' (eye '+(+n.p.eye).toFixed(2)+' m + d·tg)')+' · error ≈ '+(Math.max(.05,.02*r.h)).toFixed(2)+' m');
    else if(n.top!==null || n.base!==null) L.push('need the distance «d» (or sight the base with a known eye height) and the top');
    if(r.line) L.push('Site Plan line: '+r.line);
    n.el.querySelector('.readout').textContent=L.join('\n');
  }});
