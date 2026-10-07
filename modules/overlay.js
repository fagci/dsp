"use strict";
/* ============================ ОРИЕНТАЦИЯ И AR-ОВЕРЛЕЙ ============================ */
// Orientation — датчик ориентации телефона (AbsoluteOrientationSensor, запасной путь — deviceorientation):
// направление, куда смотрит камера (az — азимут, el — угол места) и крен roll. Это отдельный источник —
// оверлей сам датчиков не читает, все данные приходят на его входы.
// Overlay — видео (порт vid) + 3D-оверлей объектов из rec (спутники, ADS-B, суда...) + HUD.
// Объекты из lat / lon / высоты проецируются в камеру наблюдателя, модели — заглушки (каркасы).

const ORI_D=Math.PI/180;
const OV_WGS_A=6378137, OV_WGS_E2=0.00669437999014;

// ---------- Orientation ----------
// R — матрица устройство → мир (x — восток, y — север, z — вверх), массив из 9 чисел по строкам
function oriFromQuat(q){
  const [x,y,z,w]=q;
  return [1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w),
          2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w),
          2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)];
}
function oriFromEuler(a,b,g){                   // W3C: alpha (Z), beta (X'), gamma (Y'')
  const k=Math.PI/180, cA=Math.cos(a*k), sA=Math.sin(a*k), cB=Math.cos(b*k), sB=Math.sin(b*k),
        cG=Math.cos(g*k), sG=Math.sin(g*k);
  return [cA*cG-sA*sB*sG, -cB*sA, cG*sA*sB+cA*sG,
          cG*sA+cA*sB*sG, cA*cB, sA*sG-cA*cG*sB,
          -cB*sG, sB, cB*cG];
}
function oriStop(n){
  if(n.sensor){ try{ n.sensor.stop(); }catch(e){} n.sensor=null; }
  if(n.onOri){ window.removeEventListener(n.oriEv,n.onOri); n.onOri=null; }
  n.via=''; n.status='stopped';
}
async function oriEvents(n,note){
  if(!window.DeviceOrientationEvent){ n.status='API unavailable (needs a phone, HTTPS)'; return; }
  try{
    if(DeviceOrientationEvent.requestPermission){
      if(await DeviceOrientationEvent.requestPermission()!=='granted'){ n.status='permission denied'; return; }
    }
  }catch(e){ n.status='error: '+e.message; return; }
  const abs='ondeviceorientationabsolute' in window;
  n.oriEv=abs ? 'deviceorientationabsolute' : 'deviceorientation';
  n.via=n.oriEv; n.status='waiting for '+n.oriEv+'…';
  n.onOri=e=>{
    let a=e.alpha;
    if(e.webkitCompassHeading!=null) a=360-e.webkitCompassHeading;     // iOS: alpha относительная
    if(a==null || e.beta==null || e.gamma==null) return;
    n.R=oriFromEuler(a,e.beta,e.gamma);
    n.status=(note||'')+(abs||e.absolute||e.webkitCompassHeading!=null ? '' : 'no compass — azimuth is relative');
  };
  window.addEventListener(n.oriEv,n.onOri);
}
function oriStart(n){
  oriStop(n); n.status='starting…';
  if(window.AbsoluteOrientationSensor){
    try{
      const s=new AbsoluteOrientationSensor({frequency:60});
      s.addEventListener('reading',()=>{ if(s.quaternion){ n.R=oriFromQuat(s.quaternion); n.status=''; } });
      s.addEventListener('error',e=>{
        if(n.sensor!==s) return;
        oriStop(n); oriEvents(n,(e.error?.name||'sensor error')+' → events. '); });
      s.start(); n.sensor=s; n.via='AbsoluteOrientationSensor'; return;
    }catch(e){}
  }
  oriEvents(n,'');
}
// направление взгляда f и «верх кадра» u в мире → az, el, roll (по часовой — правая сторона кадра вниз)
function oriAngles(f,u){
  const el=Math.asin(Math.max(-1,Math.min(1,f[2])))/ORI_D, az=Math.atan2(f[0],f[1])/ORI_D;
  let rx=f[1], ry=-f[0], rn=Math.hypot(rx,ry);              // right0 = f × Z
  if(rn<1e-6){ rx=1; ry=0; rn=1; }
  rx/=rn; ry/=rn;
  const u0=[ ry*f[2], -rx*f[2], rx*f[1]-ry*f[0] ];          // up0 = right0 × f  (right0 = (rx,ry,0))
  const roll=Math.atan2(u[0]*rx+u[1]*ry, u[0]*u0[0]+u[1]*u0[1]+u[2]*u0[2])/ORI_D;
  return {az:(az+360)%360, el, roll};
}

def({ id:'orient', title:'Orientation', cat:'Sources', kw:'compass azimuth pitch roll gyroscope magnetometer phone camera direction',
  // Куда смотрит камера телефона: az (0 — север, по часовой), el (угол над горизонтом), roll (крен).
  outs:[{n:'az',t:'num'},{n:'el',t:'num'},{n:'roll',t:'num'}],
  readout:true,
  params:[{n:'cam',t:'select',opts:['rear','front'],d:'rear',label:'camera that looks along the axis'},
          {n:'tau',t:'range',min:0,max:1,step:.01,d:.08,label:'smoothing, s'},
          {n:'go',t:'button',label:'Start',fn:n=>oriStart(n)},
          {n:'stop',t:'button',label:'Stop',fn:n=>oriStop(n)}],
  init:n=>{ n.sensor=null; n.onOri=null; n.R=null; n.status='not started'; n.via=''; n.f=null; n.u=null; n.t=0; n.o=null; },
  dispose:n=>oriStop(n),
  process(n){
    const R=n.R;
    if(!R) return {az:null,el:null,roll:null};
    const sg=n.p.cam==='front' ? 1 : -1;
    const ang=((screen.orientation?.angle ?? window.orientation ?? 0)%360)*ORI_D, sa=Math.sin(ang), ca=Math.cos(ang);
    const f=[sg*R[2],sg*R[5],sg*R[8]];                      // ось Z устройства в мире
    const u=[R[0]*sa+R[1]*ca, R[3]*sa+R[4]*ca, R[6]*sa+R[7]*ca];   // верх кадра с учётом поворота экрана
    const now=performance.now(), dt=Math.min(1,(now-n.t)/1000), tau=+n.p.tau;
    const k=!n.f || tau<=0 ? 1 : 1-Math.exp(-dt/tau);
    n.t=now;
    if(!n.f){ n.f=f; n.u=u; }
    else for(let i=0;i<3;i++){ n.f[i]+=(f[i]-n.f[i])*k; n.u[i]+=(u[i]-n.u[i])*k; }
    const fl=Math.hypot(...n.f)||1, F=n.f.map(v=>v/fl);
    const a=oriAngles(F,n.u.map(v=>v/(Math.hypot(...n.u)||1)));
    n.o=a;
    return {az:a.az, el:a.el, roll:a.roll};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const o=n.o;
    r.textContent=n.status || (o ? `az ${o.az.toFixed(0)}°  el ${o.el.toFixed(0)}°  roll ${o.roll.toFixed(0)}°`+(n.via?' · '+n.via:'') : n.via||''); }});

// ---------- геометрия ----------
function ovEcef(lat,lon,h){
  const la=lat*ORI_D, lo=lon*ORI_D, s=Math.sin(la), c=Math.cos(la),
        N=OV_WGS_A/Math.sqrt(1-OV_WGS_E2*s*s);
  return [(N+h)*c*Math.cos(lo), (N+h)*c*Math.sin(lo), (N*(1-OV_WGS_E2)+h)*s];
}
// точка lat/lon/h → ENU относительно наблюдателя o = {x,y,z (ECEF), sl,cl,so,co}
function ovObserver(lat,lon,h){
  const la=lat*ORI_D, lo=lon*ORI_D;
  return {p:ovEcef(lat,lon,h), sl:Math.sin(la), cl:Math.cos(la), so:Math.sin(lo), co:Math.cos(lo)};
}
function ovEnu(o,lat,lon,h){
  const p=ovEcef(lat,lon,h), dx=p[0]-o.p[0], dy=p[1]-o.p[1], dz=p[2]-o.p[2];
  return [-o.so*dx+o.co*dy,
          -o.sl*o.co*dx-o.sl*o.so*dy+o.cl*dz,
           o.cl*o.co*dx+o.cl*o.so*dy+o.sl*dz];
}
// камера: fwd / right / up в ENU
function ovCamera(az,el,roll){
  const a=az*ORI_D, e=el*ORI_D, r=roll*ORI_D, ce=Math.cos(e);
  const f=[Math.sin(a)*ce, Math.cos(a)*ce, Math.sin(e)];
  let rx=f[1], ry=-f[0], rn=Math.hypot(rx,ry);
  if(rn<1e-6){ rx=Math.cos(a); ry=-Math.sin(a); rn=1; }
  rx/=rn; ry/=rn;
  const r0=[rx,ry,0], u0=[ry*f[2], -rx*f[2], rx*f[1]-ry*f[0]], cr=Math.cos(r), sr=Math.sin(r);
  return {f, r:[r0[0]*cr-u0[0]*sr, r0[1]*cr-u0[1]*sr, -u0[2]*sr],
             u:[u0[0]*cr+r0[0]*sr, u0[1]*cr+r0[1]*sr, u0[2]*cr]};
}
const ovDot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

// ---------- модели-заглушки: отрезки в метрах, x — вправо, y — вперёд, z — вверх ----------
const OV_MODELS={
  plane:{L:40, seg:[[0,-20,0,0,20,0],[-18,-4,0,0,6,0],[0,6,0,18,-4,0],[-6,-18,0,0,-14,0],[0,-14,0,6,-18,0],[0,-18,0,0,-14,7]]},
  sat:{L:16, seg:[[-1.5,-1.5,-1.5,1.5,-1.5,-1.5],[1.5,-1.5,-1.5,1.5,1.5,-1.5],[1.5,1.5,-1.5,-1.5,1.5,-1.5],[-1.5,1.5,-1.5,-1.5,-1.5,-1.5],
      [-1.5,-1.5,1.5,1.5,-1.5,1.5],[1.5,-1.5,1.5,1.5,1.5,1.5],[1.5,1.5,1.5,-1.5,1.5,1.5],[-1.5,1.5,1.5,-1.5,-1.5,1.5],
      [-1.5,-1.5,-1.5,-1.5,-1.5,1.5],[1.5,-1.5,-1.5,1.5,-1.5,1.5],[1.5,1.5,-1.5,1.5,1.5,1.5],[-1.5,1.5,-1.5,-1.5,1.5,1.5],
      [1.5,0,0,8,0,0],[-1.5,0,0,-8,0,0],[3,-2,0,8,-2,0],[3,2,0,8,2,0],[8,-2,0,8,2,0],[3,-2,0,3,2,0],
      [-3,-2,0,-8,-2,0],[-3,2,0,-8,2,0],[-8,-2,0,-8,2,0],[-3,-2,0,-3,2,0]]},
  ship:{L:30, seg:[[-3,-12,0,3,-12,0],[3,-12,0,3,6,0],[3,6,0,0,15,0],[0,15,0,-3,6,0],[-3,6,0,-3,-12,0],[0,-4,0,0,-4,6]]},
  other:{L:10, seg:[[-5,0,0,5,0,0],[0,-5,0,0,5,0],[0,0,-5,0,0,5]]},
};
function ovModelOf(r){
  const ic=String(r.icon||'');
  if(ic==='plane' || r.icao!=null) return OV_MODELS.plane;
  if(ic==='sat' || r.norad!=null) return OV_MODELS.sat;
  if(ic==='ship' || ic==='boat' || r.mmsi!=null) return OV_MODELS.ship;
  return OV_MODELS.other;
}
// высота записи, м
function ovAlt(r){
  if(r.ground) return 0;
  let v=recNum(r.alt_km); if(v!=null) return v*1000;
  v=recNum(r.alt_m ?? r.altitude_m); if(v!=null) return v;
  v=recNum(r.alt ?? r.altGnss);
  if(v!=null) return r.icao!=null || r.src==='ADS-B' ? v*0.3048 : v;      // у ADS-B высота в футах
  return 0;
}

// ---------- рельеф ----------
// Сетка «азимут × дальность» вокруг наблюдателя по карте высот Horizon (hAt). Кольца — с шагом ×1.08 от 250 м,
// точки в ENU (e, n, u) + высота над уровнем моря (h). Цвет ячейки: материал по высоте, освещение по наклону, дымка по дальности.
const OV_RING_K=1.08, OV_AZ_STEP=2, OV_SHADES=8;
const OV_MAT=[[70,100,55],[112,96,70],[125,125,132],[238,242,246]], OV_HAZE=[150,172,200], OV_SUN=(()=>{ const v=[-.5,-.4,.77], l=Math.hypot(...v); return v.map(x=>x/l); })();
function ovRelief(n,obs,lat,lon,alt){
  const H=Horizon;
  if(!H.hAt || H.lat==null || Math.abs(H.lat-lat)>.02) return null;
  const key=H.ver+'|'+lat+'|'+lon+'|'+alt;
  if(n.relKey===key) return n.rel;
  const R=6371000, la=lat*ORI_D, lo=lon*ORI_D, sl=Math.sin(la), cl=Math.cos(la), NA=360/OV_AZ_STEP, rings=[], dist=[];
  for(let d=250; d<=H.radius*1000; d*=OV_RING_K){
    const dl=d/R, sd=Math.sin(dl), cd=Math.cos(dl), a=new Float32Array(NA*4).fill(NaN);
    for(let i=0;i<NA;i++){
      const th=i*OV_AZ_STEP*ORI_D, s2=sl*cd+cl*sd*Math.cos(th), la2=Math.asin(s2),
            lo2=lo+Math.atan2(Math.sin(th)*sd*cl,cd-sl*s2), h=H.hAt(la2/ORI_D,lo2/ORI_D);
      if(h!==h) continue;
      const e=ovEnu(obs,la2/ORI_D,lo2/ORI_D,h);
      a[i*4]=e[0]; a[i*4+1]=e[1]; a[i*4+2]=e[2]; a[i*4+3]=h;
    }
    rings.push(a); dist.push(d);
  }
  // ячейка (j, i) — между кольцами j и j+1, азимутами i и i+1: код цвета = материал × OV_SHADES + освещение
  const cells=[], colors=[];
  for(let j=0;j<rings.length-1;j++){
    const a=rings[j], b=rings[j+1], c=new Int16Array(NA).fill(-1);
    for(let i=0;i<NA;i++){
      const o0=i*4, o1=((i+1)%NA)*4;
      if(a[o0]!==a[o0] || a[o1]!==a[o1] || b[o0]!==b[o0] || b[o1]!==b[o1]) continue;
      const ax=a[o1]-a[o0], ay=a[o1+1]-a[o0+1], az=a[o1+2]-a[o0+2], bx=b[o0]-a[o0], by=b[o0+1]-a[o0+1], bz=b[o0+2]-a[o0+2];
      let nx=ay*bz-az*by, ny=az*bx-ax*bz, nz=ax*by-ay*bx;
      const nl=Math.hypot(nx,ny,nz)||1; if(nz<0){ nx=-nx; ny=-ny; nz=-nz; }
      const sh=Math.max(0,Math.min(1,.3+.8*(nx*OV_SUN[0]+ny*OV_SUN[1]+nz*OV_SUN[2])/nl));
      const h=(a[o0+3]+a[o1+3]+b[o0+3]+b[o1+3])/4, m=h<400 ? 0 : h<1500 ? 1 : h<2500 ? 2 : 3;
      c[i]=m*OV_SHADES+Math.round(sh*(OV_SHADES-1));
    }
    cells.push(c);
    const fog=1-Math.exp(-dist[j]/45000), row=[];            // цвета для этого кольца
    for(let m=0;m<OV_MAT.length;m++) for(let k=0;k<OV_SHADES;k++){
      const f=.35+.65*k/(OV_SHADES-1), base=OV_MAT[m];
      row.push('rgb('+[0,1,2].map(q=>Math.round((base[q]*f)*(1-fog)+OV_HAZE[q]*fog)).join(',')+')');
    }
    colors.push(row);
  }
  n.relKey=key; n.rel={rings,NA,cells,colors};
  return n.rel;
}
// кольца от дальних к ближним — ближние перекрывают дальние; ячейки одного цвета в кольце — одним путём
function ovDrawRelief(cx,rel,proj,solid){
  const {rings,NA,cells,colors}=rel, nr=rings.length, P=[];
  for(let j=0;j<nr;j++){
    const a=rings[j], X=new Float32Array(NA).fill(NaN), Y=new Float32Array(NA);
    for(let i=0;i<NA;i++){
      const o=i*4; if(a[o]!==a[o]) continue;
      const q=proj([a[o],a[o+1],a[o+2]]); if(q){ X[i]=q.x; Y[i]=q.y; }
    }
    P.push({X,Y});
  }
  if(solid){
    for(let j=nr-2;j>=0;j--){
      const A=P[j], B=P[j+1], c=cells[j], paths=new Map();
      for(let i=0;i<NA;i++){
        const k=c[i], i1=(i+1)%NA;
        if(k<0 || A.X[i]!==A.X[i] || A.X[i1]!==A.X[i1] || B.X[i]!==B.X[i] || B.X[i1]!==B.X[i1]) continue;
        let pa=paths.get(k); if(!pa){ pa=new Path2D(); paths.set(k,pa); }
        pa.moveTo(A.X[i],A.Y[i]); pa.lineTo(A.X[i1],A.Y[i1]); pa.lineTo(B.X[i1],B.Y[i1]); pa.lineTo(B.X[i],B.Y[i]); pa.closePath();
      }
      for(const [k,pa] of paths){ cx.fillStyle=colors[j][k]; cx.fill(pa); cx.strokeStyle=colors[j][k]; cx.lineWidth=.7; cx.stroke(pa); }   // обводка — без щелей между ячейками
    }
    const A=P[0], c=cells[0], bottom=cx.canvas.height+60;         // земля под ближним кольцом — до низа кадра
    for(let i=0;i<NA;i++){
      const i1=(i+1)%NA;
      if(c[i]<0 || A.X[i]!==A.X[i] || A.X[i1]!==A.X[i1]) continue;
      cx.fillStyle=cx.strokeStyle=colors[0][c[i]]; cx.lineWidth=.7;
      cx.beginPath(); cx.moveTo(A.X[i],A.Y[i]); cx.lineTo(A.X[i1],A.Y[i1]); cx.lineTo(A.X[i1],bottom); cx.lineTo(A.X[i],bottom); cx.closePath(); cx.fill(); cx.stroke();
    }
    return;
  }
  cx.lineWidth=1;                                          // каркас: каждое 3-е кольцо и меридианы через 10°
  for(let j=nr-1;j>=0;j-=1){
    const t=j/(nr-1), A=P[j];
    cx.strokeStyle=`rgba(255,200,90,${(.7-.5*t).toFixed(2)})`;
    if(j%3===0){
      cx.beginPath(); let pen=false;
      for(let i=0;i<=NA;i++){ const k=i%NA; if(A.X[k]!==A.X[k]){ pen=false; continue; }
        if(pen) cx.lineTo(A.X[k],A.Y[k]); else cx.moveTo(A.X[k],A.Y[k]); pen=true; }
      cx.stroke();
    }
    if(j<nr-1){
      const B=P[j+1]; cx.beginPath();
      for(let i=0;i<NA;i+=5){ if(A.X[i]!==A.X[i] || B.X[i]!==B.X[i]) continue; cx.moveTo(A.X[i],A.Y[i]); cx.lineTo(B.X[i],B.Y[i]); }
      cx.stroke();
    }
  }
}

def({ id:'overlay', lazy:true, title:'Video Overlay', cat:'Video', kw:'ar augmented reality hud camera satellite adsb 3d drone fpv sky',
  // Видео (vid, или растр img — например, из TV Decoder) + объекты (rec) в 3D + HUD. Камера: lat / lon / alt (м) — где она стоит, az / el / roll — куда смотрит.
  // Без видео рисует небо с горизонтом. Входы a…d — числа в HUD (подписи — параметр «HUD»).
  ins:[{n:'vid',t:'vid'},{n:'img',t:'img'},{n:'rec',t:'rec'},{n:'rec2',t:'rec'},
       {n:'lat',t:'num'},{n:'lon',t:'num'},{n:'alt',t:'num'},
       {n:'az',t:'num'},{n:'el',t:'num'},{n:'roll',t:'num'},{n:'fov',t:'num'},
       {n:'a',t:'num'},{n:'b',t:'num'},{n:'c',t:'num'},{n:'d',t:'num'}],
  outs:[{n:'vid',t:'vid'}],                       // готовая картинка с объектами и HUD — для Record Video
  w:420, view:{h:300}, resize:true,
  params:[{n:'fov',t:'range',min:10,max:140,step:1,d:60,label:'field of view across the image width, °'},
          {n:'ttl',t:'range',min:2,max:600,step:1,d:60,label:'keep an object without updates, s'},
          {n:'models',t:'check',d:true,label:'3D stub models'},
          {n:'scale',t:'range',min:1,max:200,step:1,d:1,label:'model scale (×)'},
          {n:'minpx',t:'range',min:8,max:80,step:1,d:26,label:'model minimal size, px'},
          {n:'labels',t:'check',d:true,label:'labels'},
          {n:'trails',t:'check',d:true,label:'paths (path field)'},
          {n:'terrain',t:'check',d:true,label:'skyline from Horizon'},
          {n:'relief',t:'select',opts:['off','auto','lines','solid'],d:'auto',label:'terrain relief 3D from Horizon (auto: solid without video, lines over video)'},
          {n:'find',t:'text',d:'',label:'find: name or id (an arrow at the edge)'},
          {n:'hud',t:'text',d:'A, B, C, D',label:'HUD inputs a…d: name[:unit], …'},
          {n:'dAz',t:'range',min:-180,max:180,step:.5,d:0,label:'azimuth correction, °'},
          {n:'dEl',t:'range',min:-90,max:90,step:.5,d:0,label:'elevation correction, °'},
          {n:'dRoll',t:'range',min:-180,max:180,step:.5,d:0,label:'roll correction, °'}],
  init:n=>{ n.ents=new Map(); n.I={}; n.seq=0; n.info=''; },
  process(n,I){
    const now=Date.now();
    n.I=I;
    for(const k of ['rec','rec2']) for(const r of recList(I[k])){
      if(!r || recNum(r.lat)==null && recNum(r.az)==null) continue;
      const id=r.id!=null ? String(r.id) : r.label!=null ? String(r.label) : 'o'+(n.seq++);
      n.ents.set(k+':'+id,{r,t:now});
    }
    if(n.ents.size>2000 || now-(n.pruned||0)>2000){
      n.pruned=now; const ttl=n.p.ttl*1000;
      for(const [key,e] of n.ents) if(now-e.t>ttl) n.ents.delete(key);
    }
    return {vid:n.outCv||null};
  },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, I=n.I||{}, p=n.p, now=Date.now();
    n.outCv=cv;
    cx.fillStyle='#000'; cx.fillRect(0,0,W,H);
    // видео вписывается в холст; FOV — по ширине кадра
    let v=I.vid;
    if(!v && I.img){                                 // растр из декодера (TV Decoder, SSTV...) — через холст
      const im=I.img, c=n.imCv||(n.imCv=document.createElement('canvas'));
      if(c.width!==im.w || c.height!==im.h){ c.width=im.w; c.height=im.h; n.imCx=c.getContext('2d'); n.imGray=null; }
      if(im.gray){
        if(!n.imGray) n.imGray=n.imCx.createImageData(im.w,im.h);
        const d=n.imGray.data, g=im.buf;
        for(let k=0;k<g.length;k++){ const x=g[k]*255, j=k*4; d[j]=d[j+1]=d[j+2]=x; d[j+3]=255; }
        n.imCx.putImageData(n.imGray,0,0);
      } else if(im.data) n.imCx.putImageData(im.data,0,0);
      v=c;
    }
    const vw=v?.videoWidth||v?.width||0, vh=v?.videoHeight||v?.height||0;
    let rx=0, ry=0, rw=W, rh=H;
    if(vw && vh){ const s=Math.min(W/vw,H/vh); rw=vw*s; rh=vh*s; rx=(W-rw)/2; ry=(H-rh)/2;
      try{ cx.drawImage(v,rx,ry,rw,rh); }catch(e){} }
    else { const g=cx.createLinearGradient(0,0,0,H); g.addColorStop(0,'#0a1830'); g.addColorStop(1,'#1d3a5a');
      cx.fillStyle=g; cx.fillRect(0,0,W,H); }
    cx.save(); cx.beginPath(); cx.rect(rx,ry,rw,rh); cx.clip();

    const lat=recNum(I.lat) ?? GeoMe.lat, lon=recNum(I.lon) ?? GeoMe.lon,
          hzOk=lat!=null && Horizon.prof && Math.abs(Horizon.lat-lat)<.02,
          alt=recNum(I.alt) ?? (hzOk && Horizon.ground!=null ? Horizon.ground+2 : 0);   // без alt — на земле по карте высот
    const az0=recNum(I.az), el0=recNum(I.el), ro0=recNum(I.roll)??0;
    const haveCam=az0!=null && el0!=null, havePos=lat!=null && lon!=null;
    const fov=Math.max(5,recNum(I.fov) ?? +p.fov), foc=(rw/2)/Math.tan(fov*ORI_D/2), cxp=rx+rw/2, cyp=ry+rh/2;
    const cam=haveCam ? ovCamera(az0+ +p.dAz, Math.max(-90,Math.min(90,el0+ +p.dEl)), ro0+ +p.dRoll) : null;
    const obs=havePos ? ovObserver(lat,lon,alt) : null;
    const col=themeColor('--acc')||'#7dff9a';
    // точка в мире (ENU, м) → экран
    const proj=cam ? e=>{ const z=ovDot(e,cam.f); if(z<=1e-6) return null;
      return {x:cxp+foc*ovDot(e,cam.r)/z, y:cyp-foc*ovDot(e,cam.u)/z, z}; } : null;
    const dir=(az,el)=>{ const a=az*ORI_D, e=el*ORI_D; return [Math.sin(a)*Math.cos(e), Math.cos(a)*Math.cos(e), Math.sin(e)]; };
    const poly=(pts,close)=>{ let pen=false; cx.beginPath();
      for(const q of pts){ if(!q){ pen=false; continue; } if(pen) cx.lineTo(q.x,q.y); else cx.moveTo(q.x,q.y); pen=true; }
      if(close) cx.closePath(); cx.stroke(); };
    const lines=[];

    if(proj && obs && p.relief!=='off'){
      const rel=ovRelief(n,obs,lat,lon,alt);
      if(rel) ovDrawRelief(cx,rel,proj,p.relief==='solid' || p.relief==='auto' && !vw);
    }
    if(proj){
      cx.font='10px monospace'; cx.textBaseline='middle'; cx.textAlign='center';
      // горизонт, стороны света, градусные метки
      cx.lineWidth=1; cx.strokeStyle='rgba(255,255,255,.55)'; cx.fillStyle='rgba(255,255,255,.8)';
      const hz=[]; for(let a=0;a<=360;a+=3) hz.push(proj(dir(a,0)));
      poly(hz);
      const NS=['N','NE','E','SE','S','SW','W','NW'];
      for(let a=0;a<360;a+=10){
        const q=proj(dir(a,0)); if(!q) continue;
        const big=a%45===0;
        cx.beginPath(); cx.moveTo(q.x,q.y); cx.lineTo(q.x,q.y+(big?8:4)); cx.stroke();
        if(big) cx.fillText(NS[a/45],q.x,q.y+16); else if(a%30===0) cx.fillText(a+'°',q.x,q.y+12);
      }
      // лестница углов места
      cx.strokeStyle='rgba(255,255,255,.28)'; cx.fillStyle='rgba(255,255,255,.55)';
      const caz=(az0+ +p.dAz+360)%360;
      for(let e=-80;e<=80;e+=10){ if(!e) continue;
        const a=proj(dir(caz-4,e)), b=proj(dir(caz+4,e));
        if(a&&b){ cx.beginPath(); cx.moveTo(a.x,a.y); cx.lineTo(b.x,b.y); cx.stroke();
          cx.fillText(e+'°',b.x+14,b.y); } }
      // горизонт рельефа из Horizon
      if(p.terrain && havePos && Horizon.prof){
        const sk=[]; let any=false;
        for(let a=0;a<=360;a+=2){ const h=horizonAt(a%360,lat,lon); if(h) any=true; sk.push(proj(dir(a,h))); }
        if(any){ cx.strokeStyle='rgba(255,170,60,.9)'; cx.lineWidth=1.5; poly(sk); cx.lineWidth=1; }
      }
    } else {
      cx.fillStyle='rgba(255,255,255,.7)'; cx.font='12px monospace'; cx.textAlign='center'; cx.textBaseline='middle';
      cx.fillText('wire az / el (Orientation) to see the sky',cxp,cyp);
    }

    // объекты
    let shown=0, off=0; const ftxt=String(p.find||'').trim().toLowerCase();
    cx.font='10px monospace'; cx.textBaseline='alphabetic';
    if(proj){
      const items=[];
      for(const [,en] of n.ents){
        const r=en.r; let e=null, rng=0, dt=(now-en.t)/1000;
        const rlat=recNum(r.lat), rlon=recNum(r.lon);
        if(obs && rlat!=null && rlon!=null){
          let la=rlat, lo=rlon, h=ovAlt(r);
          const sp=recNum(r.speed), hd=recNum(r.heading ?? r.track ?? r.hdg);
          if(r.icao!=null && sp!=null && hd!=null && dt>0 && dt<30){           // ADS-B: узлы → смещение по курсу
            const d=sp*0.514444*dt/6371000/ORI_D; la+=d*Math.cos(hd*ORI_D); lo+=d*Math.sin(hd*ORI_D)/Math.max(.1,Math.cos(la*ORI_D));
            const vr=recNum(r.vr); if(vr!=null) h+=vr*0.00508*dt; }
          e=ovEnu(obs,la,lo,h);
        } else if(recNum(r.az)!=null && recNum(r.el)!=null){
          const d=(recNum(r.range_km) ?? 100)*1000; e=dir(r.az,r.el).map(x=>x*d);
        }
        if(!e) continue;
        rng=Math.hypot(e[0],e[1],e[2]);
        if(rng<1) continue;
        items.push({r,e,rng});
      }
      items.sort((a,b)=>b.rng-a.rng);                      // дальние — под ближними
      for(const it of items.slice(-400)){
        const {r,e,rng}=it, c=proj(e);
        const name=String(r.label ?? r.id ?? ''), isFind=ftxt && (name.toLowerCase().includes(ftxt) || String(r.id??'').toLowerCase().includes(ftxt));
        const color=isFind ? '#ffd84a' : (r.color||col);
        const eAz=((Math.atan2(e[0],e[1])/ORI_D)+360)%360, hid=hzOk && e[2]/rng<Math.sin(horizonAt(eAz,lat,lon)*ORI_D);   // за горой
        const above=e[2]/rng>-.02 && !hid;
        if(!c || c.x<rx-40 || c.x>rx+rw+40 || c.y<ry-40 || c.y>ry+rh+40){
          if(isFind){                                      // стрелка к объекту за кадром
            const dx=ovDot(e,cam.r), dy=ovDot(e,cam.u), an=Math.atan2(-dy,dx), m=Math.min(rw,rh)/2-14;
            const px=cxp+Math.cos(an)*m*(rw/Math.min(rw,rh)), py=cyp+Math.sin(an)*m*(rh/Math.min(rw,rh));
            cx.save(); cx.translate(Math.max(rx+10,Math.min(rx+rw-10,px)),Math.max(ry+10,Math.min(ry+rh-10,py)));
            cx.rotate(an); cx.fillStyle='#ffd84a'; cx.beginPath(); cx.moveTo(10,0); cx.lineTo(-6,-7); cx.lineTo(-6,7); cx.closePath(); cx.fill(); cx.restore();
            cx.fillStyle='#ffd84a'; cx.textAlign='center'; cx.fillText(name,Math.max(rx+30,Math.min(rx+rw-30,px)),Math.max(ry+24,Math.min(ry+rh-8,py+18)));
          }
          off++; continue;
        }
        shown++;
        cx.globalAlpha=above ? 1 : .35; cx.strokeStyle=color; cx.fillStyle=color; cx.lineWidth=1.5;
        if(p.trails && Array.isArray(r.path) && obs){
          const h=ovAlt(r), pts=r.path.map(q=>proj(ovEnu(obs,q[0],q[1],h)));
          cx.setLineDash([3,4]); cx.lineWidth=1; poly(pts); cx.setLineDash([]); cx.lineWidth=1.5;
        }
        const md=ovModelOf(r);
        if(p.models){
          const ppm=foc/c.z, k=Math.max(+p.scale, +p.minpx/(md.L*ppm)), hd=(recNum(r.heading ?? r.track ?? r.hdg)||0)*ORI_D,
                ch=Math.cos(hd), sh=Math.sin(hd);
          const T=(x,y,z)=>proj([e[0]+(x*ch+y*sh)*k, e[1]+(-x*sh+y*ch)*k, e[2]+z*k]);
          cx.beginPath();
          for(const s of md.seg){ const a=T(s[0],s[1],s[2]), b=T(s[3],s[4],s[5]); if(a&&b){ cx.moveTo(a.x,a.y); cx.lineTo(b.x,b.y); } }
          cx.stroke();
        } else { cx.beginPath(); cx.arc(c.x,c.y,4,0,7); cx.stroke(); }
        if(isFind){ cx.beginPath(); cx.arc(c.x,c.y,+p.minpx*.8,0,7); cx.stroke(); }
        if(p.labels){
          cx.textAlign='left';
          const az=((Math.atan2(e[0],e[1])/ORI_D)+360)%360, el=Math.asin(e[2]/rng)/ORI_D;
          cx.save(); cx.strokeStyle='rgba(0,0,0,.65)'; cx.lineWidth=3; cx.lineJoin='round';
          const t2=(rng>=10000 ? Math.round(rng/1000)+' km' : (rng/1000).toFixed(1)+' km')+(md===OV_MODELS.plane ? ' · '+Math.round(ovAlt(r)/.3048/100)*100+' ft' : '');
          cx.strokeText(name,c.x+12,c.y-4); cx.strokeText(t2,c.x+12,c.y+8); cx.restore();     // обводка — читается на фоне гор
          cx.fillText(name,c.x+12,c.y-4);
          cx.globalAlpha*=.75;
          cx.fillText((rng>=10000 ? Math.round(rng/1000)+' km' : (rng/1000).toFixed(1)+' km')+(md===OV_MODELS.plane ? ' · '+Math.round(ovAlt(r)/.3048/100)*100+' ft' : ''),c.x+12,c.y+8);
        }
        cx.globalAlpha=1;
      }
    }
    cx.restore();

    // HUD: перекрестие, лента курса, значения
    cx.strokeStyle=col; cx.fillStyle=col; cx.lineWidth=1.5; cx.globalAlpha=.9;
    cx.beginPath(); cx.moveTo(cxp-12,cyp); cx.lineTo(cxp-4,cyp); cx.moveTo(cxp+4,cyp); cx.lineTo(cxp+12,cyp);
    cx.moveTo(cxp,cyp-12); cx.lineTo(cxp,cyp-4); cx.moveTo(cxp,cyp+4); cx.lineTo(cxp,cyp+12); cx.stroke();
    cx.font='11px monospace'; cx.textBaseline='top';
    if(haveCam){
      const caz=(az0+ +p.dAz+360)%360, ppd=rw/fov, ty=ry+3;
      cx.save(); cx.beginPath(); cx.rect(rx,ry,rw,20); cx.clip(); cx.textAlign='center'; cx.lineWidth=1;
      for(let d=Math.floor((caz-fov/2)/5)*5; d<=caz+fov/2+5; d+=5){
        const x=cxp+(d-caz)*ppd, a=((d%360)+360)%360, big=a%10===0;
        cx.beginPath(); cx.moveTo(x,ty+(big?10:14)); cx.lineTo(x,ty+18); cx.stroke();
        if(big){ const nm=a%90===0 ? 'NESW'[a/90] : a%30===0 ? String(a) : ''; if(nm) cx.fillText(nm,x,ty); }
      }
      cx.restore();
      cx.beginPath(); cx.moveTo(cxp-4,ry+22); cx.lineTo(cxp+4,ry+22); cx.lineTo(cxp,ry+27); cx.closePath(); cx.fill();
    }
    const L=[];
    if(haveCam) L.push(`AZ ${((az0+ +p.dAz+360)%360).toFixed(0)}°  EL ${(el0+ +p.dEl).toFixed(0)}°  R ${(ro0+ +p.dRoll).toFixed(0)}°`);
    const hl=String(p.hud||'').split(',');
    ['a','b','c','d'].forEach((k,i)=>{ const x=recNum(I[k]); if(x==null) return;
      const [nm,un]=(hl[i]||k.toUpperCase()).split(':').map(s=>s.trim());
      L.push(`${nm} ${Math.abs(x)>=1000 ? x.toFixed(0) : x.toFixed(1)}${un?' '+un:''}`); });
    cx.textAlign='left';
    L.forEach((s,i)=>cx.fillText(s,rx+6,ry+32+i*13));
    cx.textAlign='right'; cx.textBaseline='bottom'; cx.globalAlpha=.8;
    const st=[]; if(!haveCam) st.push('no orientation'); if(!havePos) st.push('no position');
    st.push(shown+' in view'+(off?', '+off+' off':''));
    cx.fillText(st.join(' · '),rx+rw-6,ry+rh-4);
    cx.globalAlpha=1;
  }});
