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
function ovCamera(az,el,roll,tilt){
  const a=az*ORI_D, e=el*ORI_D, r=roll*ORI_D, ce=Math.cos(e);
  const f=[Math.sin(a)*ce, Math.cos(a)*ce, Math.sin(e)];
  let rx=f[1], ry=-f[0], rn=Math.hypot(rx,ry);
  if(rn<1e-6){ rx=Math.cos(a); ry=-Math.sin(a); rn=1; }
  rx/=rn; ry/=rn;
  const r0=[rx,ry,0], u0=[ry*f[2], -rx*f[2], rx*f[1]-ry*f[0]], cr=Math.cos(r), sr=Math.sin(r);
  const R=[r0[0]*cr-u0[0]*sr, r0[1]*cr-u0[1]*sr, -u0[2]*sr], U=[u0[0]*cr+r0[0]*sr, u0[1]*cr+r0[1]*sr, u0[2]*cr];
  if(!tilt) return {f, r:R, u:U};
  const ct=Math.cos(tilt*OVK_D), st=Math.sin(tilt*OVK_D);              // наклон камеры вокруг её правой оси (FPV-камера задрана вверх)
  return {f:[f[0]*ct+U[0]*st, f[1]*ct+U[1]*st, f[2]*ct+U[2]*st], r:R, u:[U[0]*ct-f[0]*st, U[1]*ct-f[1]*st, U[2]*ct-f[2]*st]};
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
  drone:{L:.9, seg:[[-.3,-.3,0,.3,.3,0],[-.3,.3,0,.3,-.3,0],[-.4,-.3,0,-.2,-.3,0],[-.3,-.4,0,-.3,-.2,0],[.2,-.3,0,.4,-.3,0],[.3,-.4,0,.3,-.2,0],
      [-.4,.3,0,-.2,.3,0],[-.3,.2,0,-.3,.4,0],[.2,.3,0,.4,.3,0],[.3,.2,0,.3,.4,0],[0,0,0,0,.35,0]]},
  flag:{L:8, seg:[[0,0,0,0,0,8],[0,0,8,5,0,6.5],[5,0,6.5,0,0,5]]},
  other:{L:10, seg:[[-5,0,0,5,0,0],[0,-5,0,0,5,0],[0,0,-5,0,0,5]]},
};
function ovModelOf(r){
  const ic=String(r.icon||'');
  if(ic==='flag') return OV_MODELS.flag;
  if(ic==='drone' || r.src==='Remote ID') return OV_MODELS.drone;
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
const OV_RING_K=OVK_RING_K, OV_AZ_STEP=2, OV_SHADES=16, OV_MATS=12, OV_MAT_TOP=4000, OV_REL_MOVE=60, OV_REL_UP=40, OV_SHADOW_KM=12000;
const OV_HAZE_DAY=[150,188,226], OV_HAZE_NIGHT=[12,20,38], OV_TINT=[10,18,40];
const ovMix=(a,b,k)=>a.map((v,i)=>v+(b[i]-v)*k);
// Солнце (az, el) для места и времени t; пересчёт раз в секунду
function ovSky(n,now,t,lat,lon){
  if(n.skyAt && now-n.skyAt<1000 && n.skyKey===lat+'|'+lon) return n.sky;
  n.skyAt=now; n.skyKey=lat+'|'+lon; return n.sky=ovkSkyBodies(t,lat,lon);
}
// нормали вершин сетки по центральным разностям соседей (гладкое освещение вместо граней)
function ovVertexNormals(rings,NA){
  const NR=rings.length, out=[];
  for(let j=0;j<NR;j++){
    const a=rings[j], p=rings[Math.max(0,j-1)], q=rings[Math.min(NR-1,j+1)], v=new Float32Array(NA*3).fill(NaN);
    for(let i=0;i<NA;i++){
      const o=i*4, l=((i+NA-1)%NA)*4, r=((i+1)%NA)*4;
      const t1x=a[r]-a[l], t1y=a[r+1]-a[l+1], t1z=a[r+2]-a[l+2], t2x=q[o]-p[o], t2y=q[o+1]-p[o+1], t2z=q[o+2]-p[o+2];
      let nx=t1y*t2z-t1z*t2y, ny=t1z*t2x-t1x*t2z, nz=t1x*t2y-t1y*t2x;
      const nl=Math.hypot(nx,ny,nz); if(!(nl>0)) continue;
      if(nz<0){ nx=-nx; ny=-ny; nz=-nz; }
      v[i*3]=nx/nl; v[i*3+1]=ny/nl; v[i*3+2]=nz/nl;
    }
    out.push(v);
  }
  return out;
}
function ovRelief(n,obs,lat,lon,alt,sun,shadows,vis){
  const H=Horizon;
  if(!H.hAt || H.lat==null || Math.abs(H.lat-lat)>.02) return null;
  const r0=n.rel;                                           // камера сместилась немного — те же кольца со сдвигом (rel.off), без пересборки
  if(r0 && n.relVer===H.ver && r0.shadows===shadows && r0.vis===vis && Math.abs(ovkWrap(r0.sun.az-sun.az))<.5 && Math.abs(r0.sun.el-sun.el)<.5){
    const e=ovEnu(r0.obs,lat,lon,alt);
    if(Math.hypot(e[0],e[1])<OV_REL_MOVE && Math.abs(e[2])<OV_REL_UP){ r0.off=e; return r0; }
  }
  const R=6371000, la=lat*ORI_D, lo=lon*ORI_D, sl=Math.sin(la), cl=Math.cos(la), NA=360/OV_AZ_STEP, rings=[], dist=[], lats=[], lons=[]; let hTop=-Infinity;
  for(let d=OVK_RING0; d<=H.radius*1000; d*=OV_RING_K){
    const dl=d/R, sd=Math.sin(dl), cd=Math.cos(dl), a=new Float32Array(NA*4).fill(NaN), pla=new Float64Array(NA), plo=new Float64Array(NA);
    for(let i=0;i<NA;i++){
      const th=i*OV_AZ_STEP*ORI_D, s2=sl*cd+cl*sd*Math.cos(th), la2=Math.asin(s2),
            lo2=lo+Math.atan2(Math.sin(th)*sd*cl,cd-sl*s2), h=H.hAt(la2/ORI_D,lo2/ORI_D);
      pla[i]=la2/ORI_D; plo[i]=lo2/ORI_D;
      if(h!==h) continue;
      const e=ovEnu(obs,la2/ORI_D,lo2/ORI_D,h);
      a[i*4]=e[0]; a[i*4+1]=e[1]; a[i*4+2]=e[2]; a[i*4+3]=h;
    }
    rings.push(a); dist.push(d); lats.push(pla); lons.push(plo);
    for(let i=0;i<NA;i++) if(a[i*4+3]>hTop) hTop=a[i*4+3];
  }
  const sv=ovkSunVec(sun.az,sun.el), dk=ovkDayK(sun.el), amb=.12+.26*dk, haze=ovMix(OV_HAZE_NIGHT,OV_HAZE_DAY,dk),
        shOn=shadows && sun.el>=2 && sun.el<60, shMax=shOn ? Math.min(12000,2500/Math.tan(sun.el*ORI_D)) : 0, VN=ovVertexNormals(rings,NA);
  // ячейка (j, i) — между кольцами j и j+1, азимутами i и i+1: код цвета = ступень высоты × OV_SHADES + освещение
  const cells=[];
  for(let j=0;j<rings.length-1;j++){
    const a=rings[j], b=rings[j+1], va=VN[j], vb=VN[j+1], c=new Int16Array(NA).fill(-1), shStep=dist[j]<3000 ? 2 : 4; let sdw=false;
    for(let i=0;i<NA;i++){
      const i1=(i+1)%NA, o0=i*4, o1=i1*4;
      if(a[o0]!==a[o0] || a[o1]!==a[o1] || b[o0]!==b[o0] || b[o1]!==b[o1]) continue;
      let nx=va[i*3]+va[i1*3]+vb[i*3]+vb[i1*3], ny=va[i*3+1]+va[i1*3+1]+vb[i*3+1]+vb[i1*3+1], nz=va[i*3+2]+va[i1*3+2]+vb[i*3+2]+vb[i1*3+2];
      const nl=Math.hypot(nx,ny,nz); if(!(nl>0)) continue;
      let sh=ovkLit([nx/nl,ny/nl,nz/nl],sv,sun.el);
      if(shOn && sh>0 && dist[j]<=OV_SHADOW_KM){            // тень — через ячейку по азимуту (вдали реже) и только вблизи
        if(i%shStep===0) sdw=ovkShadowed(H.hAt,lats[j][i],lons[j][i],a[o0+3],sun.az,sun.el,shMax,hTop);
        if(sdw) sh=0;
      }
      const h=(a[o0+3]+a[o1+3]+b[o0+3]+b[o1+3])/4, m=Math.max(0,Math.min(OV_MATS-1,Math.round(h/OV_MAT_TOP*(OV_MATS-1))));
      c[i]=m*OV_SHADES+Math.round(sh*(OV_SHADES-1));
    }
    cells.push(c);
  }
  // цвета считаются при первом обращении: у каждого кольца своя дымка
  const cc=[], col=(j,k)=>{
    const row=cc[j]||(cc[j]=new Array(OV_MATS*OV_SHADES));
    if(row[k]) return row[k];
    const m=(k/OV_SHADES)|0, l=k%OV_SHADES, hm=m/(OV_MATS-1)*OV_MAT_TOP, f=amb+(1-amb)*l/(OV_SHADES-1), base=ovkPalette(hm), fog=ovkFog(dist[j],vis,hm);
    return row[k]='rgb('+[0,1,2].map(q=>Math.round((base[q]*f+(1-f)*OV_TINT[q]*(.3+.7*dk))*(1-fog)+haze[q]*fog)).join(',')+')';
  };
  n.relVer=H.ver; n.rel={rings,NA,cells,col,los:ovkLosBuild(rings,NA),obs,off:[0,0,0],sun:{az:sun.az,el:sun.el},shadows,vis};
  return n.rel;
}
// небо: от верха к горизонту; ниже видимого горизонта (он ниже уровня на ovkDip) — дальняя земля в цвете дымки
function ovDrawSky(cx,W,H,c0,cam,cel,dk,ground){
  const top=ovMix([10,24,48],[47,111,181],dk), hor=ovMix(OV_HAZE_NIGHT,OV_HAZE_DAY,dk), rgb=a=>'rgb('+a.map(Math.round).join(',')+')';
  const yh=c0 ? c0.y : cel<0 ? -1e4 : 1e4, p=Math.max(.05,Math.min(1.5,yh/H));
  const g=cx.createLinearGradient(0,0,0,H); g.addColorStop(0,rgb(top)); g.addColorStop(Math.min(1,p),rgb(hor)); if(p<1) g.addColorStop(1,rgb(hor));
  cx.fillStyle=g; cx.fillRect(0,0,W,H);
  if(!ground) return;
  cx.fillStyle=rgb(hor);
  if(!c0){ if(cel<0) cx.fillRect(0,0,W,H); return; }
  const BIG=W+H; cx.save(); cx.translate(c0.x,c0.y); cx.rotate(Math.atan2(cam.r[2],cam.u[2])); cx.fillRect(-BIG,0,2*BIG,BIG); cx.restore();
}
// кольца от дальних к ближним — ближние перекрывают дальние; ячейки одного цвета в кольце — одним путём
function ovDrawRelief(cx,rel,proj,solid){
  const {rings,NA,cells,col,off}=rel, nr=rings.length, P=[];
  for(let j=0;j<nr;j++){
    const a=rings[j], X=new Float32Array(NA).fill(NaN), Y=new Float32Array(NA);
    for(let i=0;i<NA;i++){
      const o=i*4; if(a[o]!==a[o]) continue;
      const q=proj([a[o]-off[0],a[o+1]-off[1],a[o+2]-off[2]]); if(q){ X[i]=q.x; Y[i]=q.y; }
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
      for(const [k,pa] of paths){ const cl=col(j,k); cx.fillStyle=cl; cx.fill(pa); cx.strokeStyle=cl; cx.lineWidth=.7; cx.stroke(pa); }   // обводка — без щелей между ячейками
    }
    const A=P[0], c=cells[0], bottom=cx.canvas.height+60;         // земля под ближним кольцом — до низа кадра
    for(let i=0;i<NA;i++){
      const i1=(i+1)%NA;
      if(c[i]<0 || A.X[i]!==A.X[i] || A.X[i1]!==A.X[i1]) continue;
      cx.fillStyle=cx.strokeStyle=col(0,c[i]); cx.lineWidth=.7;
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


// ---------- OSM Overpass: пики, города, дороги, реки ----------
async function ovOsmLoad(n,lat,lon,rKm){
  const key='osm:'+lat.toFixed(2)+','+lon.toFixed(2)+','+rKm, gen=n.osmReq={};
  n.osmMsg='loading map features…';
  try{
    let txt=await geoGet(key).catch(()=>null);
    if(!txt){
      const r=await fetch('https://overpass-api.de/api/interpreter',{method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'data='+encodeURIComponent(ovkOsmQuery(lat,lon,rKm*1000))});
      if(!r.ok) throw new Error('HTTP '+r.status);
      txt=await r.text();
      let j=null; try{ j=JSON.parse(txt); }catch(e){ throw new Error('server busy, try later'); }
      const re=gfRemarkError(j); if(re) throw new Error('server busy: '+re);          // не кэшировать ответ-ошибку
      geoPut(key,txt).catch(()=>{});
    }
    if(n.osmReq!==gen) return;
    n.osm=ovkOsmParse(JSON.parse(txt)); n.osmFor={lat,lon}; n.osmGen=(n.osmGen|0)+1; n.osmMsg='';
    gsUpsert('peak',n.osm.peaks.map(q=>({id:'pk'+q.lat.toFixed(4)+','+q.lon.toFixed(4),name:q.name,lat:q.lat,lon:q.lon,ele:isFinite(q.ele) ? q.ele : '',src:'osm'}))).catch(()=>{});     // вершины и города — в таблицы geo/…
    gsUpsert('pop',n.osm.places.map(q=>({id:'pl'+q.lat.toFixed(4)+','+q.lon.toFixed(4),name:q.name,kind:q.kind,lat:q.lat,lon:q.lon,pop:'',src:'osm'}))).catch(()=>{});
  }catch(e){ if(n.osmReq===gen){ n.osmMsg='OSM: '+e.message; n.osmT=Date.now()+90000; } }
}
// вершины линий и точки — в ENU один раз на наблюдателя: высота по карте высот (+3 м), признак видимости из точки наблюдения
function ovOsmGeo(n,obs,rel,alt,okey){
  const o=n.osm; if(!o) return null;
  const key=okey+'|'+n.osmGen+'|'+Horizon.ver;
  if(n.osmGeoKey===key) return n.osmGeo;
  const hAt=Horizon.hAt, ground=(la,lo)=>{ const h=hAt ? hAt(la,lo) : alt-2; return h===h ? h : null; };
  const pt=(la,lo,h,up,m)=>{ const e=ovEnu(obs,la,lo,h+up); return {e,vis:ovkVisible(rel?.los,e[0],e[1],e[2],m)}; };   // m: запас по углу — кольца рельефа грубые, точка на склоне иначе «закрыта» самим склоном
  const line=ws=>ws.map(w=>({kind:w.kind, pts:w.pts.map(q=>{ const h=ground(q[0],q[1]); return h==null ? null : pt(q[0],q[1],h,3,.02); })}));
  const dots=(a,max)=>a.slice(0,max).map(q=>{
    const h=isFinite(q.ele) ? q.ele : ground(q.lat,q.lon); if(h==null) return null;
    return {...pt(q.lat,q.lon,h,0,.02), name:q.name, ele:q.ele, kind:q.kind}; }).filter(Boolean);
  n.osmGeoKey=key;
  return n.osmGeo={roads:line(o.roads), rivers:line(o.rivers), peaks:dots(o.peaks,60), places:dots(o.places,40)};
}

// ---------- аэродромы, полосы и населённые пункты (geofeat.js: ячейки OSM в базе браузера) ----------
const OV_FEAT_KINDS=['air','pop'];
// Точки берутся из списков Table (geo/airfields, geo/runways, geo/places и свои списки из параметра lists), а не из памяти загрузчика:
// правки в таблицах видны сразу (ListDB.rev), а те же точки доступны карте и анализу
async function ovFeatRead(n,lat,lon,rKm,kinds,lists){
  const res={air:null,pop:null,my:[]};
  if(kinds.includes('air')){
    const [ap,rw]=await Promise.all([gsRead(GS_LISTS.air),gsRead(GS_LISTS.rw)]);
    res.air={ap:gsNear(ap,gfApFromRow,lat,lon,rKm,40), rw:gsNear(rw,gfRwFromRow,lat,lon,rKm,60)};
  }
  if(kinds.includes('pop')) res.pop={pl:gsNear(await gsRead(GS_LISTS.pop),gfPlFromRow,lat,lon,rKm,150)};
  for(const l of lists){
    const rows=await gsRead(l).catch(()=>[]);
    res.my.push(...gsNear(rows,r=>gfMyFromRow(r,l),lat,lon,rKm,200));
  }
  n.feat=res; n.featCtr={lat,lon}; n.featRev=ListDB.rev; n.featGen=(n.featGen|0)+1; redraw(n);
}
const ovFeatLists=p=>String(p.lists||'').split(',').map(s=>s.trim()).filter(Boolean);
async function ovFeatLoad(n,lat,lon,rKm,kinds){
  const gen=n.featReq={}, key=kinds.join()+'|'+rKm+'|'+ovFeatLists(n.p).join();
  n.featMsg='loading '+(kinds.includes('air') ? 'airfields' : kinds.length ? 'towns' : 'points')+'…'; redraw(n);
  const poll=setInterval(()=>{ if(GF_STATE.msg && n.featMsg!==GF_STATE.msg){ n.featMsg=GF_STATE.msg; redraw(n); } },400);
  const errs=[], lists=ovFeatLists(n.p), read=()=>n.featReq===gen && ovFeatRead(n,lat,lon,rKm,kinds,lists);
  try{
    await read();                                           // что уже лежит в таблицах — сразу
    for(const k of kinds){
      if(k==='pop'){ await gsEnsureBuiltin(lat,lon,rKm); await read(); }      // встроенные города — без сети
      const r=await gsEnsure(k,lat,lon,rKm,true);
      if(n.featReq!==gen) return;
      if(r.error) errs.push((k==='air' ? 'airfields' : 'villages')+': '+r.error);
      await read();
    }
    n.featMsg=errs.length ? errs[0]+' — retry in a minute' : '';
    if(errs.length){ n.featT=Date.now()+60000; n.featFor=null; } else n.featFor={lat,lon,key};
  }catch(e){ if(n.featReq===gen){ n.featMsg='map data: '+e.message; n.featT=Date.now()+60000; n.featFor=null; } }
  finally{ clearInterval(poll); }
  redraw(n);
}
async function ovFeatDownload(n){
  const L=n.last; if(!L || L.lat==null){ n.featMsg='no position yet'; redraw(n); return; }
  const kinds=OV_FEAT_KINDS.filter(k=>n.p[k]); if(!kinds.length) kinds.push(...OV_FEAT_KINDS);
  const R=+n.p.featDlR; let bad='';
  for(const k of kinds){
    if(k==='pop') await gsEnsureBuiltin(L.lat,L.lon,R);
    const r=await gsEnsure(k,L.lat,L.lon,R,true,(i,m)=>{ n.featMsg=(k==='air' ? 'airfields' : 'towns')+' '+i+'/'+m+' → tables geo/…'; redraw(n); });
    if(r.error) bad=r.error;
  }
  n.featMsg=bad ? 'downloaded with errors: '+bad : 'saved to the tables geo/airfields, geo/runways, geo/places'; n.featRev=-1; redraw(n);
}
// положение на земле и видимость точек один раз на наблюдателя (как ovOsmGeo)
function ovFeatGeo(n,obs,rel,alt,okey){
  const f=n.feat; if(!f.air && !f.pop && !f.my?.length) return null;
  const key=okey+'|'+n.featGen+'|'+Horizon.ver;
  if(n.featGeoKey===key) return n.featGeo;
  const hAt=Horizon.hAt, ground=(la,lo,fb)=>{ const h=hAt ? hAt(la,lo) : alt-2; return h===h ? h : (fb!=null && isFinite(fb) ? fb : null); };
  const pt=(la,lo,h)=>{ const e=ovEnu(obs,la,lo,h); return {e, vis:ovkVisible(rel?.los,e[0],e[1],e[2],.02)}; };
  const dot=(q,up,fb)=>{ const h=ground(q.lat,q.lon,fb); return h==null ? null : {...pt(q.lat,q.lon,h+up), name:q.name, icao:q.icao, kind:q.kind, pop:q.pop}; };
  const rw=[];
  for(const r of f.air?.rw||[]){
    const a=r.pts[0], b=r.pts[1], ha=ground(a[0],a[1]), hb=ground(b[0],b[1]); if(ha==null || hb==null) continue;
    rw.push({a:pt(a[0],a[1],ha+.4), b:pt(b[0],b[1],hb+.4), ref:r.ref, width:r.width || 30});
  }
  const my=(f.my||[]).map(q=>{ const h=q.alt!=null ? q.alt : ground(q.lat,q.lon); return h==null ? null : {...pt(q.lat,q.lon,q.alt!=null ? h : h+q.h), name:q.name, color:q.color, list:q.list}; }).filter(Boolean);
  n.featGeoKey=key;
  return n.featGeo={rw, ap:(f.air?.ap||[]).map(q=>dot(q,0,q.ele)).filter(Boolean), pl:(f.pop?.pl||[]).map(q=>dot(q,0)).filter(Boolean), my};
}

// выбор цели для калибровки: auto — ближайшая к перекрестию в пределах 30°
function ovAlign(n){
  const L=n.last; if(!L){ return; }
  const want=n.p.calib, c=[];
  for(const t of L.cands){
    if(want==='Sun' && t.key!=='sky:sun' || want==='Moon' && t.key!=='sky:moon') continue;
    if(want==='selected' && t.key!==n.sel) continue;
    if(want==='find' && !t.find) continue;
    c.push(t);
  }
  const d=t=>{ const a=L.cdir, b=[Math.sin(t.az*OVK_D)*Math.cos(t.el*OVK_D),Math.cos(t.az*OVK_D)*Math.cos(t.el*OVK_D),Math.sin(t.el*OVK_D)];
    return Math.acos(Math.max(-1,Math.min(1,a[0]*b[0]+a[1]*b[1]+a[2]*b[2])))/OVK_D; };
  c.sort((a,b)=>d(a)-d(b));
  const t=c[0];
  if(!t || want==='auto' && d(t)>30){ n.msg={t:performance.now(), s:'no target near the crosshair'}; return; }
  const dAz=ovkWrap(+n.p.dAz+ovkWrap(t.az-L.caz)), dEl=Math.max(-90,Math.min(90,+n.p.dEl+(t.el-L.cel)));
  setMod(n,'dAz',+dAz.toFixed(1)); setMod(n,'dEl',+dEl.toFixed(1));
  n.msg={t:performance.now(), s:`aligned to ${t.name}: azimuth ${dAz>=0?'+':''}${dAz.toFixed(1)}°, elevation ${dEl>=0?'+':''}${dEl.toFixed(1)}°`};
}

def({ id:'overlay', lazy:true, title:'Video Overlay', cat:'Video', kw:'ar augmented reality hud camera satellite adsb 3d drone fpv sky sun moon planets stars galaxy nebula osm trails line of sight',
  // Видео (vid, или растр img — например, из TV Decoder) + объекты (rec) в 3D + HUD. Камера: lat / lon / alt (м) — где она стоит, az / el / roll — куда смотрит.
  // Без видео рисует небо с горизонтом. Входы a…d — числа в HUD (подписи — параметр «HUD»).
  ins:[{n:'vid',t:'vid'},{n:'img',t:'img'},{n:'rec',t:'rec'},{n:'rec2',t:'rec'},
       {n:'lat',t:'num'},{n:'lon',t:'num'},{n:'alt',t:'num'},
       {n:'az',t:'num'},{n:'el',t:'num'},{n:'roll',t:'num'},{n:'fov',t:'num'},
       {n:'a',t:'num'},{n:'b',t:'num'},{n:'c',t:'num'},{n:'d',t:'num'}],
  // vid — готовая картинка с объектами и HUD (для Record Video); pick — выбранный касанием объект; vis — объекты в прямой видимости
  outs:[{n:'vid',t:'vid'},{n:'pick',t:'rec'},{n:'paz',t:'num'},{n:'pel',t:'num'},{n:'prange',t:'num'},
        {n:'vis',t:'rec'},{n:'nvis',t:'num'},{n:'nhid',t:'num'}],
  w:420, view:{h:300}, resize:true,
  params:[{n:'fov',t:'range',min:10,max:140,step:1,d:60,label:'field of view across the image width, °'},
          {n:'tilt',t:'range',min:-90,max:90,step:1,d:0,label:'camera tilt relative to the el input (FPV camera tilted up), °'},
          {n:'lag',t:'range',min:0,max:1500,step:10,d:0,label:'video delay, ms (the pose is taken from that long ago)'},
          {n:'ttl',t:'range',min:2,max:600,step:1,d:60,label:'keep an object without updates, s',adv:true},
          {n:'models',t:'check',d:true,label:'3D stub models',adv:true},
          {n:'scale',t:'range',min:1,max:200,step:1,d:1,label:'model scale (×)',adv:true},
          {n:'minpx',t:'range',min:8,max:80,step:1,d:26,label:'model minimal size, px',adv:true},
          {n:'labels',t:'check',d:true,label:'labels',adv:true},
          {n:'trails',t:'check',d:true,label:'paths (path field)',adv:true},
          {n:'trail',t:'range',min:0,max:600,step:10,d:120,label:'trails of moving objects, s (0 — off)'},
          {n:'sky',t:'check',d:true,label:'Sun and Moon'},
          {n:'planets',t:'check',d:true,label:'planets (Mercury … Neptune)'},
          {n:'starMag',t:'range',min:-1,max:4,step:.1,d:2,label:'stars brighter than magnitude (−1 — none)'},
          {n:'deep',t:'check',d:true,label:'deep sky: Andromeda, Pleiades, Orion Nebula, Magellanic Clouds…'},
          {n:'terrain',t:'check',d:true,label:'skyline from Horizon',adv:true},
          {n:'relief',t:'select',opts:['off','auto','lines','solid'],d:'auto',label:'terrain relief 3D from Horizon (auto: solid without video, lines over video)'},
          {n:'vis',t:'range',min:5,max:150,step:1,d:35,label:'haze: visibility, km (distant mountains fade into the sky)'},
          {n:'shadows',t:'check',d:true,label:'terrain shadows from the real Sun (cost: a few ms when the mesh is rebuilt)'},
          {n:'tshift',t:'range',min:-12,max:12,step:.25,d:0,label:'Sun time shift, h (0 — real time; moves the Sun, the light and the sky)',adv:true},
          {n:'osm',t:'check',d:false,label:'OSM: peaks, towns, roads, rivers (asks overpass-api.de, needs Horizon heights)'},
          {n:'osmR',t:'range',min:5,max:50,step:1,d:25,label:'OSM radius, km',adv:true},
          {n:'osmLoad',t:'button',label:'Load OSM now',fn:n=>{ n.osmT=0; n.osmFor=null; },adv:true},
          {n:'air',t:'check',d:false,label:'airfields and runways (OSM, saved in the browser; needs Horizon heights)'},
          {n:'pop',t:'check',d:false,label:'towns and villages (OSM, saved in the browser; needs Horizon heights)'},
          {n:'lists',t:'text',d:'',label:'own points: Table lists, comma-separated (columns name, lat, lon; h — height above ground, m, or alt — above sea level; color) — signal sources, observation posts'},
          {n:'featR',t:'range',min:10,max:100,step:5,d:40,label:'airfields / towns radius, km'},
          {n:'featDl',t:'button',label:'Download area for offline',fn:n=>ovFeatDownload(n)},
          {n:'featDlR',t:'range',min:20,max:200,step:10,d:100,label:'download area radius, km (airfields and towns are downloaded apart from the terrain)',adv:true},
          {n:'los',t:'check',d:true,label:'line of sight: dim objects behind the relief, mark them “no LOS”',adv:true},
          {n:'find',t:'text',d:'',label:'find: name or id (an arrow at the edge)'},
          {n:'home',t:'select',opts:['off','first fix'],d:'off',label:'home: first position fix (distance and bearing on the HUD)'},
          {n:'sethome',t:'button',label:'Set home here',fn:n=>{ const L=n.last; if(L && L.lat!=null){ n.home={lat:L.lat,lon:L.lon,alt:L.alt}; setMod(n,'home','first fix'); } }},
          {n:'hud',t:'text',d:'A, B, C, D',label:'HUD inputs a…d: name[:unit], …'},
          {n:'calib',t:'select',opts:['auto','Sun','Moon','selected','find'],d:'auto',label:'align to: the target nearest to the crosshair, or a chosen one'},
          {n:'align',t:'button',label:'Align crosshair to target',fn:n=>ovAlign(n)},
          {n:'dAz',t:'range',min:-180,max:180,step:.1,d:0,label:'azimuth correction, °',adv:true},
          {n:'dEl',t:'range',min:-90,max:90,step:.1,d:0,label:'elevation correction, °',adv:true},
          {n:'dRoll',t:'range',min:-180,max:180,step:.5,d:0,label:'roll correction, °',adv:true},
          {n:'resetc',t:'button',label:'Reset corrections',fn:n=>{ for(const k of ['dAz','dEl','dRoll']) setMod(n,k,0); },adv:true}],
  init:n=>{ n.ents=new Map(); n.I={}; n.seq=0; n.pose=[]; n.sel=null; n.hits=[]; n.last=null; n.msg=null; n.home=null;
            n.pickOut=null; n.selInfo=null; n.visOut=null; n.nvis=0; n.nhid=0; n.osm=null; n.osmFor=null; n.osmT=0; n.osmMsg=''; n.osmGen=0;
            n.feat={air:null,pop:null,my:[]}; n.featCtr=null; n.featReading=false; n.featRev=-1; n.featFor=null; n.featT=0; n.featMsg=''; n.featGen=0; n.featBusy=false; },
  dispose:n=>{ n.osmReq=null; n.featReq=null; },
  process(n,I){
    const now=Date.now(), tr=+n.p.trail*1000;
    n.I=I;
    for(const k of ['rec','rec2']) for(const r of recList(I[k])){
      if(r && r.gone && r.id!=null){ n.ents.delete(k+':'+r.id); continue; }            // gone: убрать объект сразу, не ждать ttl
      if(!r || recNum(r.lat)==null && recNum(r.az)==null) continue;
      const id=r.id!=null ? String(r.id) : r.label!=null ? String(r.label) : 'o'+(n.seq++), key=k+':'+id, old=n.ents.get(key), en={r,t:now,trail:old?.trail||[]};
      const la=recNum(r.lat), lo=recNum(r.lon);
      if(tr>0 && la!=null && lo!=null && !Array.isArray(r.path) && r.norad==null) ovkTrailPush(en.trail,la,lo,ovAlt(r),now,tr);
      else if(!tr) en.trail=[];
      n.ents.set(key,en);
    }
    if(n.ents.size>2000 || now-(n.pruned||0)>2000){
      n.pruned=now; const ttl=n.p.ttl*1000;
      for(const [key,e] of n.ents) if(now-e.t>ttl) n.ents.delete(key);
    }
    const az=recNum(I.az), el=recNum(I.el);
    if(az!=null && el!=null) ovkPosePush(n.pose,performance.now(),az,el,recNum(I.roll)??0);
    const si=n.selInfo, o={vid:n.outCv||null, pick:n.pickOut, paz:si?si.az:null, pel:si?si.el:null, prange:si?si.range:null,
      vis:n.visOut, nvis:n.nvis, nhid:n.nhid};
    n.pickOut=null; n.visOut=null;
    return o;
  },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, I=n.I||{}, p=n.p, now=Date.now();
    n.outCv=cv;
    if(n._wired!==cv){                                // касание по объекту — выбрать, мимо — снять выбор
      n._wired=cv;
      cv.addEventListener('click',ev=>{
        const r=cv.getBoundingClientRect(), k=cv.width/r.width, x=(ev.clientX-r.left)*k, y=(ev.clientY-r.top)*k;
        let best=null, bd=1e9;
        for(const h of n.hits){ const d=Math.hypot(h.x-x,h.y-y); if(d<Math.max(h.rad,24*k) && d<bd){ bd=d; best=h; } }
        n.sel=best && best.key!==n.sel ? best.key : null;
        n.pickOut=null; n.selInfo=null;
      });
    }
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
    const tnow=now+(+p.tshift||0)*3600000, gla=recNum(I.lat) ?? GeoMe.lat, glo=recNum(I.lon) ?? GeoMe.lon,
          sun0=gla!=null && glo!=null ? ovSky(n,now,tnow,gla,glo).sun : null, dk=sun0 ? ovkDayK(sun0.el) : 0;
    if(!(vw && vh)){ cx.fillStyle='#000'; cx.fillRect(0,0,W,H); }          // небо рисуется ниже, когда известна камера
    cx.save(); cx.beginPath(); cx.rect(rx,ry,rw,rh); cx.clip();

    const lat=recNum(I.lat) ?? GeoMe.lat, lon=recNum(I.lon) ?? GeoMe.lon,
          hzOk=lat!=null && Horizon.prof && Math.abs(Horizon.lat-lat)<.02,
          alt=recNum(I.alt) ?? (hzOk && Horizon.ground!=null ? Horizon.ground+2 : 0);   // без alt — на земле по карте высот
    let az0=recNum(I.az), el0=recNum(I.el), ro0=recNum(I.roll)??0;
    if(az0!=null && el0!=null && +p.lag>0){                           // видео опаздывает — берём позу из прошлого
      const q=ovkPoseAt(n.pose,performance.now()-p.lag); if(q){ az0=q.az; el0=q.el; ro0=q.roll; } }
    const haveCam=az0!=null && el0!=null, havePos=lat!=null && lon!=null;
    const fov=Math.max(5,recNum(I.fov) ?? +p.fov), foc=(rw/2)/Math.tan(fov*OVK_D/2), cxp=rx+rw/2, cyp=ry+rh/2;
    const cam=haveCam ? ovCamera(az0+ +p.dAz, Math.max(-90,Math.min(90,el0+ +p.dEl)), ro0+ +p.dRoll, +p.tilt) : null;
    const obs=havePos ? ovObserver(lat,lon,alt) : null, okey=lat+'|'+lon+'|'+alt;
    const col=themeColor('--acc')||'#7dff9a';
    const caz=cam ? ovkNorm(Math.atan2(cam.f[0],cam.f[1])/OVK_D) : 0, cel=cam ? Math.asin(cam.f[2])/OVK_D : 0;   // куда смотрит центр кадра
    // точка в мире (ENU, м) → экран
    const proj=cam ? e=>{ const z=ovDot(e,cam.f); if(z<=1e-6) return null;
      return {x:cxp+foc*ovDot(e,cam.r)/z, y:cyp-foc*ovDot(e,cam.u)/z, z}; } : null;
    const dir=(az,el)=>{ const a=az*OVK_D, e=el*OVK_D; return [Math.sin(a)*Math.cos(e), Math.cos(a)*Math.cos(e), Math.sin(e)]; };
    const poly=(pts,close)=>{ let pen=false; cx.beginPath();
      for(const q of pts){ if(!q){ pen=false; continue; } if(pen) cx.lineTo(q.x,q.y); else cx.moveTo(q.x,q.y); pen=true; }
      if(close) cx.closePath(); cx.stroke(); };
    const halo=(s,x,y)=>{ cx.save(); cx.strokeStyle='rgba(0,0,0,.65)'; cx.lineWidth=3; cx.lineJoin='round'; cx.strokeText(s,x,y); cx.restore(); cx.fillText(s,x,y); };
    const ftxt=String(p.find||'').trim().toLowerCase();
    const cands=[], hits=[];

    const dip=ovkDip(Math.max(0,alt)), solid=p.relief==='solid' || p.relief==='auto' && !vw;      // видимый горизонт ниже уровня на dip
    if(!vw) ovDrawSky(cx,W,H,proj ? proj(dir(caz,-dip)) : null,cam,cel,dk,p.relief!=='off');
    const rel=obs && sun0 ? ovRelief(n,obs,lat,lon,alt,sun0,p.shadows,+p.vis) : null;
    const los=rel && p.los ? rel.los : null;
    if(proj && rel && p.relief!=='off') ovDrawRelief(cx,rel,proj,solid);
    if(proj){
      cx.font='10px monospace'; cx.textBaseline='middle'; cx.textAlign='center';
      // горизонт, стороны света, градусные метки
      cx.lineWidth=1; cx.strokeStyle='rgba(255,255,255,.55)'; cx.fillStyle='rgba(255,255,255,.8)';
      const hz=[]; for(let a=0;a<=360;a+=3) hz.push(proj(dir(a,-dip)));
      poly(hz);
      const NS=['N','NE','E','SE','S','SW','W','NW'];
      for(let a=0;a<360;a+=10){
        const q=proj(dir(a,-dip)); if(!q) continue;
        const big=a%45===0;
        cx.beginPath(); cx.moveTo(q.x,q.y); cx.lineTo(q.x,q.y+(big?8:4)); cx.stroke();
        if(big) cx.fillText(NS[a/45],q.x,q.y+16); else if(a%30===0) cx.fillText(a+'°',q.x,q.y+12);
      }
      // лестница углов места
      cx.strokeStyle='rgba(255,255,255,.28)'; cx.fillStyle='rgba(255,255,255,.55)';
      for(let e=-80;e<=80;e+=10){ if(!e) continue;
        const a=proj(dir(caz-4,e)), b=proj(dir(caz+4,e));
        if(a&&b){ cx.beginPath(); cx.moveTo(a.x,a.y); cx.lineTo(b.x,b.y); cx.stroke();
          cx.fillText(e+'°',b.x+14,b.y); } }
      // горизонт рельефа из Horizon
      if(p.terrain && havePos && Horizon.prof && !(rel && solid) && Math.abs(alt-(Horizon.h0 ?? alt))<25){           // профиль верен только для высоты, где он посчитан
        const sk=[]; let any=false;
        for(let a=0;a<=360;a+=2){ const h=horizonAt(a%360,lat,lon); if(h) any=true; sk.push(proj(dir(a,h))); }
        if(any){ cx.strokeStyle='rgba(255,170,60,.9)'; cx.lineWidth=1.5; poly(sk); cx.lineWidth=1; }
      }
    } else {
      cx.fillStyle='rgba(255,255,255,.7)'; cx.font='12px monospace'; cx.textAlign='center'; cx.textBaseline='middle';
      cx.fillText('wire az / el (Orientation) to see the sky',cxp,cyp);
    }

    // Солнце и Луна: положение по времени и месту, диски — в натуральную величину (но не мельче 6 px)
    if(proj && p.sky && havePos){
      const sb=ovSky(n,now,tnow,lat,lon);
      for(const b of [sb.sun,sb.moon]){
        if(b.el<-3) continue;
        const key='sky:'+b.id, d=1e7, e=dir(b.az,b.el).map(x=>x*d), c=proj(e);
        cands.push({key, name:b.label, az:b.az, el:b.el, find:ftxt && b.label.toLowerCase().includes(ftxt)});
        if(!c) continue;
        const R=Math.max(b.id==='sun' ? 6 : 7, foc*Math.tan(b.size*OVK_D/2)), vis=ovkVisible(los,e[0],e[1],e[2],.001);
        cx.save(); cx.globalAlpha=vis ? 1 : .35;
        if(b.id==='sun'){
          const g=cx.createRadialGradient(c.x,c.y,R*.6,c.x,c.y,R*4); g.addColorStop(0,'rgba(255,230,120,.55)'); g.addColorStop(1,'rgba(255,230,120,0)');
          cx.fillStyle=g; cx.fillRect(c.x-R*4,c.y-R*4,R*8,R*8);
          cx.fillStyle='#ffe27a'; cx.beginPath(); cx.arc(c.x,c.y,R,0,7); cx.fill();
        } else {
          const sc=proj(dir(sb.sun.az,sb.sun.el).map(x=>x*d)), ang=sc ? Math.atan2(sc.y-c.y,sc.x-c.x) : -Math.PI/2;   // освещённый край — к Солнцу
          cx.translate(c.x,c.y); cx.rotate(ang);
          cx.fillStyle='rgba(40,48,60,.85)'; cx.beginPath(); cx.arc(0,0,R,0,7); cx.fill();
          const a=R*(1-2*b.frac);
          cx.fillStyle='#e8e8dc'; cx.beginPath(); cx.arc(0,0,R,-Math.PI/2,Math.PI/2,false);
          cx.ellipse(0,0,Math.max(.01,Math.abs(a)),R,0,Math.PI/2,a>=0 ? -Math.PI/2 : 1.5*Math.PI,a>=0); cx.fill();
        }
        cx.restore();
        cx.font='10px monospace'; cx.textAlign='left'; cx.textBaseline='alphabetic'; cx.fillStyle=b.id==='sun' ? '#ffe27a' : '#e8e8dc';
        halo(b.label+(b.id==='moon' ? ' '+Math.round(b.frac*100)+'%' : ''),c.x+R+4,c.y-2);
        if(c.x>=rx && c.x<=rx+rw && c.y>=ry && c.y<=ry+rh) hits.push({key,x:c.x,y:c.y,rad:R+6,rec:{id:b.id,label:b.label,az:+b.az.toFixed(2),el:+b.el.toFixed(2),size_deg:+b.size.toFixed(3),...(b.id==='moon' ? {illuminated:+b.frac.toFixed(3)} : {})},az:b.az,el:b.el,range:null});
        if(n.sel===key){ cx.strokeStyle='#ffd84a'; cx.lineWidth=1.5; cx.beginPath(); cx.arc(c.x,c.y,R+5,0,7); cx.stroke(); }
      }
    }

    // планеты, яркие звёзды, глубокий космос: точки с подписью, размер — по блеску
    if(proj && havePos && (p.planets || +p.starMag>-1 || p.deep) && (vw || sun0.el<-3)){          // без видео днём звёзд нет
      const k=lat+'|'+lon+'|'+p.planets+'|'+p.starMag+'|'+p.deep;
      const objs=n.sky2At && now-n.sky2At<1000 && n.sky2Key===k ? n.sky2 : (n.sky2At=now, n.sky2Key=k,
        n.sky2=ovkSkyObjects(tnow,lat,lon,{planets:p.planets, starMag:+p.starMag>-1 ? +p.starMag : null, deep:p.deep}));
      cx.font='10px monospace'; cx.textAlign='left'; cx.textBaseline='alphabetic';
      for(const b of objs){
        if(b.el<-1) continue;
        const key='sky:'+b.id, e=dir(b.az,b.el).map(x=>x*1e7), c=proj(e);
        cands.push({key, name:b.label, az:b.az, el:b.el, find:ftxt && b.label.toLowerCase().includes(ftxt)});
        if(!c) continue;
        const vis=ovkVisible(los,e[0],e[1],e[2],.001), m=b.mag ?? 3;
        const R=b.kind==='deep' ? 7 : Math.max(2,Math.min(6,3.2-m*.6)), pr=b.kind==='planet' ? Math.max(R,foc*Math.tan(b.size*OVK_D/2)) : R;
        cx.save(); cx.globalAlpha=vis ? 1 : .35;
        if(b.kind==='deep'){
          cx.strokeStyle='#9fd0ff'; cx.lineWidth=1.2; cx.beginPath(); cx.ellipse(c.x,c.y,R,R*.55,-.5,0,7); cx.stroke();
        } else {
          const clr=b.kind==='planet' ? {mercury:'#c8b8a0',venus:'#fff0c0',mars:'#ff8a5c',jupiter:'#ffd9a0',saturn:'#e8d49a',uranus:'#9ae8e8',neptune:'#7aa0ff'}[b.id] : '#ffffff';
          cx.fillStyle=clr; cx.beginPath(); cx.arc(c.x,c.y,pr,0,7); cx.fill();
        }
        cx.restore();
        cx.fillStyle=b.kind==='planet' ? '#ffe9b8' : b.kind==='deep' ? '#9fd0ff' : 'rgba(255,255,255,.85)';
        halo(b.label,c.x+pr+4,c.y-2);
        if(c.x>=rx && c.x<=rx+rw && c.y>=ry && c.y<=ry+rh) hits.push({key,x:c.x,y:c.y,rad:pr+6,
          rec:{id:b.id,label:b.label,kind:b.kind,az:+b.az.toFixed(2),el:+b.el.toFixed(2),...(b.mag!=null ? {mag:+b.mag.toFixed(1)} : {})},az:b.az,el:b.el,range:null});
        if(n.sel===key){ cx.strokeStyle='#ffd84a'; cx.lineWidth=1.5; cx.beginPath(); cx.arc(c.x,c.y,pr+5,0,7); cx.stroke(); }
      }
    }

    // карта OSM: реки и дороги по рельефу, подписи вершин и городов
    if(proj && obs && p.osm){
      if(!n.osmFor || geoDist(n.osmFor.lat,n.osmFor.lon,lat,lon)>Math.max(2,+p.osmR/4)){
        if(now>=n.osmT && !n.osmBusy){ n.osmT=now+30000; n.osmBusy=true; ovOsmLoad(n,lat,lon,Math.min(+p.osmR,Horizon.radius||50)).finally(()=>{ n.osmBusy=false; }); }
      }
      const g=ovOsmGeo(n,obs,rel,alt,okey);
      if(g){
        cx.lineJoin='round';
        const lines=(ws,style,w)=>{
          for(const wl of ws){
            cx.strokeStyle=style; cx.lineWidth=wl.kind==='motorway' ? w*1.5 : w; cx.beginPath(); let pen=false;
            for(const q of wl.pts){
              const c=q && q.vis ? proj(q.e) : null;
              if(!c){ pen=false; continue; }
              if(pen) cx.lineTo(c.x,c.y); else cx.moveTo(c.x,c.y); pen=true;
            }
            cx.stroke();
          }
        };
        cx.globalAlpha=.85; lines(g.rivers,'#4da3ff',1.4); lines(g.roads,'#ffb347',1.4); cx.globalAlpha=1;
        const boxes=[], free=(x,y,w,h)=>{ for(const b of boxes) if(x<b[0]+b[2] && x+w>b[0] && y<b[1]+b[3] && y+h>b[1]) return false; boxes.push([x,y,w,h]); return true; };
        cx.font='10px monospace'; cx.textAlign='left'; cx.textBaseline='alphabetic';
        for(const [arr,kind] of [[g.peaks,'peak'],[p.pop ? [] : g.places,'place']]){
          let shown=0;
          for(const q of arr){
            if(shown>=25 || !q.vis) continue;
            const c=proj(q.e); if(!c || c.x<rx || c.x>rx+rw || c.y<ry+24 || c.y>ry+rh) continue;
            const label=q.name+(kind==='peak' && isFinite(q.ele) ? ' '+Math.round(q.ele)+' m' : ''), tw=cx.measureText(label).width+14;
            if(!free(c.x-4,c.y-12,tw,14)) continue;
            shown++;
            if(kind==='peak'){ cx.fillStyle='#e8e0c8'; cx.beginPath(); cx.moveTo(c.x,c.y-5); cx.lineTo(c.x+4,c.y+1); cx.lineTo(c.x-4,c.y+1); cx.closePath(); cx.fill(); }
            else { cx.fillStyle='#ffffff'; cx.fillRect(c.x-2,c.y-2,4,4); }
            cx.fillStyle=kind==='peak' ? '#e8e0c8' : '#ffffff'; halo(label,c.x+7,c.y);
          }
        }
      }
    }

    // аэродромы, полосы, населённые пункты
    if(proj && obs && (p.air || p.pop || p.lists)){
      const kinds=OV_FEAT_KINDS.filter(k=>p[k]), lists=ovFeatLists(p), fkey=kinds.join()+'|'+p.featR+'|'+lists.join();
      for(const k of OV_FEAT_KINDS) if(!p[k]) n.feat[k]=null;
      if((!n.featFor || n.featFor.key!==fkey || geoDist(n.featFor.lat,n.featFor.lon,lat,lon)>Math.max(3,+p.featR/4)) && now>=n.featT && !n.featBusy){
        n.featBusy=true; n.featT=now+1500;
        ovFeatLoad(n,lat,lon,+p.featR,kinds).finally(()=>{ n.featBusy=false; });
      }
      if(n.featCtr && n.featRev!==ListDB.rev && !n.featReading){            // таблицы правили (Table, загрузка) — перечитать, даже пока идёт загрузка
        n.featReading=true; ovFeatRead(n,n.featCtr.lat,n.featCtr.lon,+p.featR,kinds,lists).finally(()=>{ n.featReading=false; });
      }
      const g=ovFeatGeo(n,obs,rel,alt,okey);
      if(g){
        const boxes=[], free=(x,y,w,h)=>{ for(const b of boxes) if(x<b[0]+b[2] && x+w>b[0] && y<b[1]+b[3] && y+h>b[1]) return false; boxes.push([x,y,w,h]); return true; };
        cx.font='10px monospace'; cx.textAlign='left'; cx.textBaseline='alphabetic'; cx.lineJoin='round';
        for(const r of g.rw){                                       // полоса: реальная ширина, но не тоньше 3 px
          if(!r.a.vis && !r.b.vis) continue;
          const A=r.a.e, B=r.b.e, mid=proj([(A[0]+B[0])/2,(A[1]+B[1])/2,(A[2]+B[2])/2]); if(!mid) continue;
          const dx=B[0]-A[0], dy=B[1]-A[1], L=Math.hypot(dx,dy)||1, hw=Math.max(r.width/2,1.5*mid.z/foc), nx=-dy/L*hw, ny=dx/L*hw;
          const C=[[A[0]+nx,A[1]+ny,A[2]],[A[0]-nx,A[1]-ny,A[2]],[B[0]-nx,B[1]-ny,B[2]],[B[0]+nx,B[1]+ny,B[2]]].map(proj);
          if(C.some(c=>!c)) continue;
          cx.beginPath(); C.forEach((c,i)=>i ? cx.lineTo(c.x,c.y) : cx.moveTo(c.x,c.y)); cx.closePath();
          cx.fillStyle='rgba(58,63,70,.92)'; cx.fill(); cx.strokeStyle='rgba(235,235,225,.9)'; cx.lineWidth=1; cx.stroke();
          const a=proj([A[0],A[1],A[2]+.2]), b=proj([B[0],B[1],B[2]+.2]);
          if(a && b){ cx.setLineDash([6,8]); cx.strokeStyle='rgba(255,255,255,.8)'; cx.beginPath(); cx.moveTo(a.x,a.y); cx.lineTo(b.x,b.y); cx.stroke(); cx.setLineDash([]); }
          if(r.ref && mid.x>=rx && mid.x<=rx+rw && mid.y>=ry+24 && mid.y<=ry+rh && free(mid.x+4,mid.y-12,50,14)){ cx.fillStyle='#ffffff'; halo(r.ref,mid.x+6,mid.y-2); }
        }
        for(const q of g.ap){
          if(!q.vis) continue; const c=proj(q.e); if(!c || c.x<rx || c.x>rx+rw || c.y<ry+24 || c.y>ry+rh) continue;
          const label=(q.icao||q.name||(q.kind==='heli' ? 'heliport' : 'airfield'))+(q.icao && q.name ? ' '+q.name : ''), tw=cx.measureText(label).width+14;
          if(!free(c.x-4,c.y-12,tw,14)) continue;
          cx.strokeStyle='#6fd0ff'; cx.lineWidth=1.5; cx.beginPath(); cx.arc(c.x,c.y,4,0,7); cx.stroke();
          cx.fillStyle='#6fd0ff'; halo(label,c.x+7,c.y);
        }
        for(const q of g.my){                                       // свои точки из таблиц: источники сигналов, посты наблюдения — первыми, чтобы подписи не вытеснялись
          if(!q.vis) continue; const c=proj(q.e); if(!c || c.x<rx || c.x>rx+rw || c.y<ry+24 || c.y>ry+rh) continue;
          const km=Math.hypot(q.e[0],q.e[1],q.e[2])/1000, label=q.name+' '+(km>=10 ? Math.round(km) : km.toFixed(1))+' km', tw=cx.measureText(label).width+14;
          if(!free(c.x-6,c.y-12,tw,14)) continue;
          const col=q.color||'#ff6bd6';
          cx.fillStyle=col; cx.strokeStyle='rgba(0,0,0,.8)'; cx.lineWidth=1.5; cx.beginPath();
          cx.moveTo(c.x,c.y-6); cx.lineTo(c.x+5,c.y); cx.lineTo(c.x,c.y+6); cx.lineTo(c.x-5,c.y); cx.closePath(); cx.stroke(); cx.fill();
          halo(label,c.x+9,c.y+3);
        }
        let shown=0;
        for(const q of g.pl){
          if(shown>=25 || !q.vis) continue; const c=proj(q.e); if(!c || c.x<rx || c.x>rx+rw || c.y<ry+24 || c.y>ry+rh) continue;
          const km=Math.hypot(q.e[0],q.e[1])/1000, label=q.name+' '+(km>=10 ? Math.round(km) : km.toFixed(1))+' km', tw=cx.measureText(label).width+14;
          if(!free(c.x-4,c.y-12,tw,14)) continue;
          shown++;
          const sz=q.kind==='city' ? 3 : q.kind==='town' ? 2.5 : 2;
          cx.fillStyle='#ffe9a8'; cx.fillRect(c.x-sz,c.y-sz,sz*2,sz*2); halo(label,c.x+7,c.y);
        }
      }
    }

    // дом: точка взлёта / первая позиция
    if(p.home==='first fix' && !n.home && havePos) n.home={lat,lon,alt};
    if(p.home==='off') n.home=null;

    // объекты
    let shown=0, off=0, nvis=0, nhid=0; const visList=[];
    cx.font='10px monospace'; cx.textBaseline='alphabetic';
    if(proj){
      const items=[];
      const addItem=(key,r,en)=>{
        let e=null, dt=en ? (now-en.t)/1000 : 0;
        const rlat=recNum(r.lat), rlon=recNum(r.lon);
        if(obs && rlat!=null && rlon!=null){
          let la=rlat, lo=rlon, h=ovAlt(r);
          if(r.ground || r.icon==='flag' || r.height_m!=null){           // на земле / высота над точкой взлёта — отсчёт от рельефа
            const g=Horizon.hAt && hzOk ? Horizon.hAt(la,lo) : NaN;
            if(g===g) h=g+(r.height_m!=null ? +r.height_m : r.icon==='flag' ? 2 : 0); }
          const sp=recNum(r.speed), hd=recNum(r.heading ?? r.track ?? r.hdg);
          if(r.icao!=null && sp!=null && hd!=null && dt>0 && dt<30){           // ADS-B: узлы → смещение по курсу
            const d=sp*0.514444*dt/6371000/OVK_D; la+=d*Math.cos(hd*OVK_D); lo+=d*Math.sin(hd*OVK_D)/Math.max(.1,Math.cos(la*OVK_D));
            const vr=recNum(r.vr); if(vr!=null) h+=vr*0.00508*dt; }
          e=ovEnu(obs,la,lo,h);
        } else if(recNum(r.az)!=null && recNum(r.el)!=null){
          const d=(recNum(r.range_km) ?? 100)*1000; e=dir(r.az,r.el).map(x=>x*d);
        }
        if(!e) return;
        const rng=Math.hypot(e[0],e[1],e[2]); if(rng<1) return;
        items.push({key,r,e,rng,en});
      };
      for(const [k,en] of n.ents) addItem('ent:'+k,en.r,en);
      if(n.home && obs && Math.hypot(...ovEnu(obs,n.home.lat,n.home.lon,n.home.alt??alt).slice(0,2))>3){
        const hh=Horizon.hAt && hzOk ? Horizon.hAt(n.home.lat,n.home.lon) : NaN;
        addItem('home',{id:'home',label:'HOME',icon:'flag',color:'#4da3ff',lat:n.home.lat,lon:n.home.lon,alt_m:hh===hh ? hh : n.home.alt},null);
      }
      items.sort((a,b)=>b.rng-a.rng);                      // дальние — под ближними
      const trailKey=okey;
      for(const it of items.slice(-400)){
        const {r,e,rng,en,key}=it, c=proj(e);
        const name=String(r.label ?? r.id ?? ''), isFind=ftxt && (name.toLowerCase().includes(ftxt) || String(r.id??'').toLowerCase().includes(ftxt));
        const eAz=ovkNorm(Math.atan2(e[0],e[1])/OVK_D), eEl=Math.asin(e[2]/rng)/OVK_D;
        const seen=rel ? ovkVisible(los,e[0],e[1],e[2],.002) : !(p.los && hzOk && e[2]/rng<Math.sin(horizonAt(eAz,lat,lon)*OVK_D));   // не за горой
        const above=e[2]/rng>-.02 && seen;
        const color=isFind ? '#ffd84a' : (r.color||col), sel=n.sel===key;
        if(key!=='home'){ if(seen) nvis++; else nhid++; }
        if(key!=='home' && seen && visList.length<300) visList.push({...r,az:+eAz.toFixed(2),el:+eEl.toFixed(2),range_km:+(rng/1000).toFixed(3),los:true});
        cands.push({key,name,az:eAz,el:eEl,find:isFind});
        if(sel){
          const rec={...r,az:+eAz.toFixed(2),el:+eEl.toFixed(2),range_km:+(rng/1000).toFixed(3),los:seen};
          if(!n.selInfo || n.selInfo.key!==key || now-(n.selInfo.t||0)>1000){ n.pickOut=rec; }
          n.selInfo={key,az:eAz,el:eEl,range:rng/1000,rec,t:now};
        }
        if(!c || c.x<rx-40 || c.x>rx+rw+40 || c.y<ry-40 || c.y>ry+rh+40){
          if(isFind || sel){                               // стрелка к объекту за кадром
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
        if(en && en.trail.length>1 && obs){                // след по истории позиций: четыре отрезка, старее — прозрачнее
          const tp=en.trail.map(q=>{ if(q.k!==trailKey){ q.e=ovEnu(obs,q.la,q.lo,q.h); q.k=trailKey; } return proj(q.e); });
          tp.push(c);
          const seg=Math.ceil(tp.length/4); cx.lineWidth=1;
          for(let s=0;s<4;s++){ cx.globalAlpha=(above ? 1 : .35)*(.15+.2*s); poly(tp.slice(Math.max(0,s*seg-1),(s+1)*seg)); }
          cx.globalAlpha=above ? 1 : .35; cx.lineWidth=1.5;
        }
        const md=ovModelOf(r);
        if(p.models){
          const ppm=foc/c.z, k=Math.max(+p.scale, +p.minpx/(md.L*ppm)), hd=(recNum(r.heading ?? r.track ?? r.hdg)||0)*OVK_D,
                ch=Math.cos(hd), sh=Math.sin(hd), mr=(recNum(r.roll)||0)*OVK_D, mp=(recNum(r.pitch)||0)*OVK_D,
                cr=Math.cos(mr), sr=Math.sin(mr), cp=Math.cos(mp), sp=Math.sin(mp);
          const T=(x0,y0,z0)=>{ const x=x0*cr+z0*sr, z1=z0*cr-x0*sr, y=y0*cp-z1*sp, z=y0*sp+z1*cp;       // крен вокруг оси y, тангаж вокруг x
            return proj([e[0]+(x*ch+y*sh)*k, e[1]+(-x*sh+y*ch)*k, e[2]+z*k]); };
          cx.beginPath();
          for(const s of md.seg){ const a=T(s[0],s[1],s[2]), b=T(s[3],s[4],s[5]); if(a&&b){ cx.moveTo(a.x,a.y); cx.lineTo(b.x,b.y); } }
          cx.stroke();
        } else { cx.beginPath(); cx.arc(c.x,c.y,4,0,7); cx.stroke(); }
        if(isFind || sel){ cx.strokeStyle='#ffd84a'; cx.beginPath(); cx.arc(c.x,c.y,+p.minpx*.8,0,7); cx.stroke(); }
        hits.push({key,x:c.x,y:c.y,rad:+p.minpx*.8,rec:r,az:eAz,el:eEl,range:rng/1000});
        if(p.labels){
          cx.textAlign='left';
          const t2=(rng>=10000 ? Math.round(rng/1000)+' km' : (rng/1000).toFixed(1)+' km')+(md===OV_MODELS.plane ? ' · '+Math.round(ovAlt(r)/.3048/100)*100+' ft' : '')+(seen || !p.los || !rel ? '' : ' · no LOS');
          halo(name,c.x+12,c.y-4);
          cx.globalAlpha*=.75; halo(t2,c.x+12,c.y+8);
        }
        cx.globalAlpha=1;
      }
    }
    cx.restore();
    if(n.sel && !cands.some(t=>t.key===n.sel)){ n.sel=null; n.selInfo=null; }
    n.hits=hits; n.nvis=nvis; n.nhid=nhid;
    if(visList.length && (!n.visT || now-n.visT>2000)){ n.visT=now; n.visOut=visList; }
    n.last={lat,lon,alt,caz,cel,cdir:cam ? cam.f : [0,1,0],cands};

    // HUD: перекрестие, лента курса, значения
    cx.strokeStyle=col; cx.fillStyle=col; cx.lineWidth=1.5; cx.globalAlpha=.9;
    cx.beginPath(); cx.moveTo(cxp-12,cyp); cx.lineTo(cxp-4,cyp); cx.moveTo(cxp+4,cyp); cx.lineTo(cxp+12,cyp);
    cx.moveTo(cxp,cyp-12); cx.lineTo(cxp,cyp-4); cx.moveTo(cxp,cyp+4); cx.lineTo(cxp,cyp+12); cx.stroke();
    cx.font='11px monospace'; cx.textBaseline='top';
    if(haveCam){
      const ppd=rw/fov, ty=ry+3;
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
    if(haveCam) L.push(`AZ ${caz.toFixed(0)}°  EL ${cel.toFixed(0)}°  R ${(ro0+ +p.dRoll).toFixed(0)}°`);
    const hl=String(p.hud||'').split(',');
    ['a','b','c','d'].forEach((k,i)=>{ const x=recNum(I[k]); if(x==null) return;
      const [nm,un]=(hl[i]||k.toUpperCase()).split(':').map(s=>s.trim());
      L.push(`${nm} ${Math.abs(x)>=1000 ? x.toFixed(0) : x.toFixed(1)}${un?' '+un:''}`); });
    let homeArrow=null;
    if(n.home && obs){
      const he=ovEnu(obs,n.home.lat,n.home.lon,n.home.alt??alt), hd=Math.hypot(he[0],he[1]);
      if(hd>3){ const br=ovkNorm(Math.atan2(he[0],he[1])/OVK_D); homeArrow=ovkWrap(br-caz); L.push(`HOME ${hd>=1000 ? (hd/1000).toFixed(2)+' km' : Math.round(hd)+' m'}  ${br.toFixed(0)}°`); }
    }
    cx.textAlign='left';
    L.forEach((s,i)=>halo(s,rx+6,ry+32+i*13));
    if(homeArrow!=null){                                   // стрелка «домой» относительно направления камеры
      const ax=rx+rw-24, ay=ry+44;
      cx.save(); cx.translate(ax,ay); cx.rotate(homeArrow*OVK_D); cx.strokeStyle='#4da3ff'; cx.fillStyle='#4da3ff'; cx.lineWidth=2;
      cx.beginPath(); cx.moveTo(0,10); cx.lineTo(0,-10); cx.stroke(); cx.beginPath(); cx.moveTo(0,-14); cx.lineTo(-6,-4); cx.lineTo(6,-4); cx.closePath(); cx.fill(); cx.restore();
    }
    // карточка выбранного объекта
    const si=n.selInfo;
    if(si){
      const r=si.rec, b=[], num=(v,d,u)=>v!=null && isFinite(v) ? (+v).toFixed(d)+u : null;
      b.push(String(r.label ?? r.id)+(r.src ? ' · '+r.src : ''));
      b.push(`az ${si.az.toFixed(1)}°  el ${si.el.toFixed(1)}°`+(si.range!=null ? '  '+(si.range>=100 ? Math.round(si.range) : si.range.toFixed(1))+' km' : ''));
      const ex=[r.alt!=null ? 'alt '+r.alt+(r.icao!=null ? ' ft' : ' m') : null, num(r.alt_km,0,' km alt'), num(r.alt_m,0,' m alt'), r.speed!=null ? 'speed '+r.speed : null,
        (r.heading??r.track)!=null ? 'hdg '+Math.round(r.heading??r.track)+'°' : null, r.squawk!=null ? 'squawk '+r.squawk : null, r.freqs ? String(r.freqs).slice(0,40) : null, r.los===false ? 'no line of sight' : null].filter(Boolean);
      if(ex.length) b.push(ex.join(' · '));
      cx.font='11px monospace'; cx.textBaseline='top'; cx.textAlign='left';
      const w=Math.min(rw-12,Math.max(...b.map(s=>cx.measureText(s).width))+12), h=b.length*14+8, bx=rx+6, by=ry+rh-h-22;
      cx.globalAlpha=.78; cx.fillStyle='#000'; cx.fillRect(bx,by,w,h); cx.globalAlpha=1; cx.fillStyle='#ffd84a';
      b.forEach((s,i)=>{ cx.fillStyle=i ? '#e8e8e8' : '#ffd84a'; cx.fillText(s,bx+6,by+4+i*14); });
    }
    cx.textAlign='left'; cx.textBaseline='bottom'; cx.globalAlpha=.9; cx.fillStyle='#ffd84a';
    if(n.msg && performance.now()-n.msg.t<5000) cx.fillText(n.msg.s,rx+6,ry+rh-4);
    else if(n.osmMsg || n.featMsg) { cx.fillStyle='#ffb347'; cx.fillText(n.osmMsg||n.featMsg,rx+6,ry+rh-4); }
    cx.textAlign='right'; cx.textBaseline='bottom'; cx.globalAlpha=.8; cx.fillStyle=col;
    const st=[]; if(!haveCam) st.push('no orientation'); if(!havePos) st.push('no position');
    if(sun0 && p.sky) st.push('sun '+Math.round(sun0.az)+'°/'+Math.round(sun0.el)+'°');
    st.push(shown+' in view'+(off?', '+off+' off':'')+(rel && p.los && nhid ? ', '+nhid+' no LOS' : ''));
    cx.fillText(st.join(' · '),rx+rw-6,ry+rh-4);
    cx.globalAlpha=1;
  }});
