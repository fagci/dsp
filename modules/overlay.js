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
const OV_RING_K=OVK_RING_K, OV_AZ_STEP=2, OV_SHADES=8;
const OV_MAT=[[70,100,55],[112,96,70],[125,125,132],[238,242,246]], OV_HAZE=[150,172,200], OV_SUN=(()=>{ const v=[-.5,-.4,.77], l=Math.hypot(...v); return v.map(x=>x/l); })();
function ovRelief(n,obs,lat,lon,alt){
  const H=Horizon;
  if(!H.hAt || H.lat==null || Math.abs(H.lat-lat)>.02) return null;
  const key=H.ver+'|'+lat+'|'+lon+'|'+alt;
  if(n.relKey===key) return n.rel;
  const R=6371000, la=lat*ORI_D, lo=lon*ORI_D, sl=Math.sin(la), cl=Math.cos(la), NA=360/OV_AZ_STEP, rings=[], dist=[];
  for(let d=OVK_RING0; d<=H.radius*1000; d*=OV_RING_K){
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
  n.relKey=key; n.rel={rings,NA,cells,colors,los:ovkLosBuild(rings,NA)};
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
      txt=await r.text(); geoPut(key,txt).catch(()=>{});
    }
    if(n.osmReq!==gen) return;
    n.osm=ovkOsmParse(JSON.parse(txt)); n.osmFor={lat,lon}; n.osmGen=(n.osmGen|0)+1; n.osmMsg='';
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
          {n:'osm',t:'check',d:false,label:'OSM: peaks, towns, roads, rivers (asks overpass-api.de, needs Horizon heights)'},
          {n:'osmR',t:'range',min:5,max:50,step:1,d:25,label:'OSM radius, km',adv:true},
          {n:'osmLoad',t:'button',label:'Load OSM now',fn:n=>{ n.osmT=0; n.osmFor=null; },adv:true},
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
            n.pickOut=null; n.selInfo=null; n.visOut=null; n.nvis=0; n.nhid=0; n.osm=null; n.osmFor=null; n.osmT=0; n.osmMsg=''; n.osmGen=0; },
  dispose:n=>{ n.osmReq=null; },
  process(n,I){
    const now=Date.now(), tr=+n.p.trail*1000;
    n.I=I;
    for(const k of ['rec','rec2']) for(const r of recList(I[k])){
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
    else { const g=cx.createLinearGradient(0,0,0,H); g.addColorStop(0,'#0a1830'); g.addColorStop(1,'#1d3a5a');
      cx.fillStyle=g; cx.fillRect(0,0,W,H); }
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

    const rel=obs ? ovRelief(n,obs,lat,lon,alt) : null;
    const los=rel && p.los ? rel.los : null;
    if(proj && rel && p.relief!=='off') ovDrawRelief(cx,rel,proj,p.relief==='solid' || p.relief==='auto' && !vw);
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

    // Солнце и Луна: положение по времени и месту, диски — в натуральную величину (но не мельче 6 px)
    if(proj && p.sky && havePos){
      const sb=n.skyAt && now-n.skyAt<1000 && n.skyKey===lat+'|'+lon ? n.sky : (n.sky=ovkSkyBodies(now,lat,lon), n.skyAt=now, n.skyKey=lat+'|'+lon, n.sky);
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
    if(proj && havePos && (p.planets || +p.starMag>-1 || p.deep)){
      const k=lat+'|'+lon+'|'+p.planets+'|'+p.starMag+'|'+p.deep;
      const objs=n.sky2At && now-n.sky2At<1000 && n.sky2Key===k ? n.sky2 : (n.sky2At=now, n.sky2Key=k,
        n.sky2=ovkSkyObjects(now,lat,lon,{planets:p.planets, starMag:+p.starMag>-1 ? +p.starMag : null, deep:p.deep}));
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
        for(const [arr,kind] of [[g.peaks,'peak'],[g.places,'place']]){
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
                ch=Math.cos(hd), sh=Math.sin(hd);
          const T=(x,y,z)=>proj([e[0]+(x*ch+y*sh)*k, e[1]+(-x*sh+y*ch)*k, e[2]+z*k]);
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
    L.forEach((s,i)=>cx.fillText(s,rx+6,ry+32+i*13));
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
    else if(n.osmMsg) { cx.fillStyle='#ffb347'; cx.fillText(n.osmMsg,rx+6,ry+rh-4); }
    cx.textAlign='right'; cx.textBaseline='bottom'; cx.globalAlpha=.8; cx.fillStyle=col;
    const st=[]; if(!haveCam) st.push('no orientation'); if(!havePos) st.push('no position');
    st.push(shown+' in view'+(off?', '+off+' off':'')+(rel && p.los && nhid ? ', '+nhid+' no LOS' : ''));
    cx.fillText(st.join(' · '),rx+rw-6,ry+rh-4);
    cx.globalAlpha=1;
  }});
