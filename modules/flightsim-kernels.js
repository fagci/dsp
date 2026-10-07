"use strict";
/* ============================ Ядро Flight Sim ============================
   Аркадная модель полёта, камеры, цель из записей ADS-B. Без DOM — проверяется tools/test-flightsim.mjs. */

const FLY_D=Math.PI/180, FLY_R=6371008.8, FLY_G=9.80665, FLY_KT=0.514444, FLY_FT=0.3048;
const flyNorm=a=>((a%360)+360)%360;
const flyWrap=a=>((a+540)%360+360)%360-180;
const flyClamp=(v,a,b)=>v<a ? a : v>b ? b : v;
// модель: vmin — скорость, ниже которой самолёт срывается; vrot — отрыв; vland — максимум при касании
const FLY_MODEL={vmin:30, vmax:100, vrot:38, vland:60, rollMax:60, rollRate:90, pitchMax:30, pitchRate:40,
  accel:.4, amax:6, climb:.5, gear:1.5, crashVs:6, steer:25};

function flyMove(lat,lon,dE,dN){ return {lat:lat+dN/FLY_R/FLY_D, lon:lon+dE/(FLY_R*Math.cos(lat*FLY_D))/FLY_D}; }
// ENU (м) точки b относительно a
function flyEnu(a,b){ const k=FLY_R*FLY_D; return [flyWrap(b.lon-a.lon)*k*Math.cos(a.lat*FLY_D), (b.lat-a.lat)*k, b.alt-a.alt]; }
function flyLook(e){ return {az:flyNorm(Math.atan2(e[0],e[1])/FLY_D), el:Math.atan2(e[2],Math.hypot(e[0],e[1]))/FLY_D, range:Math.hypot(e[0],e[1],e[2])}; }

// состояние: lat lon alt (м над уровнем моря) hdg pitch roll (°) spd (м/с) thr (0…1) vs (м/с) gnd crashed
function flyInit(lat,lon,gh,agl,hdg,P){
  const m={...FLY_MODEL,...P}, air=agl>m.gear+1;
  return {lat,lon,alt:gh+(air ? agl : m.gear), hdg:flyNorm(hdg), pitch:0, roll:0, spd:air ? m.vmin*1.4 : 0, thr:air ? .5 : 0,
    vs:0, gnd:!air, crashed:false};
}
// c: {ail,elev,rud −1…1, thr 0…1}; gh — высота земли под самолётом, м
function flyStep(s,c,dt,P,gh){
  const m={...FLY_MODEL,...P};
  if(s.crashed || !(dt>0)) return s;
  s.thr+=(c.thr-s.thr)*Math.min(1,dt*1.5);
  const idle=m.vmin*1.1;
  if(s.gnd){
    const tgt=s.thr*m.vmax;
    s.spd+=flyClamp((tgt-s.spd)*m.accel, -m.amax, m.amax)*dt;
    s.spd=Math.max(0,s.spd);
    s.hdg=flyNorm(s.hdg+c.rud*m.steer*Math.min(1,s.spd/10)*dt);
    s.roll=0;
    const rot=s.spd>=m.vrot && c.elev>.1;
    s.pitch=rot ? flyClamp(c.elev*m.pitchMax,0,m.pitchMax) : 0;
  } else {
    const tgt=idle+s.thr*(m.vmax-idle);
    s.spd+=(flyClamp((tgt-s.spd)*m.accel, -m.amax, m.amax)-FLY_G*Math.sin(s.pitch*FLY_D)*m.climb)*dt;
    s.spd=Math.max(5,s.spd);
    s.roll+=flyClamp(c.ail*m.rollMax-s.roll, -m.rollRate*dt, m.rollRate*dt);
    const stall=Math.max(0,(m.vmin-s.spd)/m.vmin)*120;               // срыв: нос падает, пока скорость не вернётся
    s.pitch+=flyClamp(flyClamp(c.elev*m.pitchMax-stall,-60,m.pitchMax)-s.pitch, -m.pitchRate*dt, m.pitchRate*dt);
    const rate=FLY_G*Math.tan(s.roll*FLY_D)/s.spd/FLY_D+c.rud*10;
    s.hdg=flyNorm(s.hdg+rate*dt);
  }
  const h=s.spd*Math.cos(s.pitch*FLY_D), v=s.spd*Math.sin(s.pitch*FLY_D), hr=s.hdg*FLY_D;
  const p=flyMove(s.lat,s.lon,h*Math.sin(hr)*dt,h*Math.cos(hr)*dt);
  s.lat=p.lat; s.lon=p.lon; s.vs=v;
  s.alt+=(s.gnd ? 0 : v)*dt;
  if(s.gnd){
    s.alt=gh+m.gear;
    if(s.spd>=m.vrot && s.pitch>2){ s.gnd=false; s.alt+=.1; s.vs=Math.max(0,v); }
  } else if(s.alt<=gh+m.gear){
    s.alt=gh+m.gear;
    if(v<-m.crashVs || s.spd>m.vland || Math.abs(s.roll)>25){ s.crashed=true; s.spd=0; s.vs=0; }
    else { s.gnd=true; s.pitch=0; s.roll=0; s.vs=0; }
  }
  return s;
}

// ---------- цель из ADS-B ----------
// запись → {lat,lon,alt (м),hdg,spd (м/с),vs (м/с)}; null — нет координат
function flyRecState(r){
  const lat=recNum(r.lat), lon=recNum(r.lon); if(lat==null || lon==null) return null;
  const adsb=r.icao!=null || r.src==='ADS-B';
  let alt=0, v;
  if((v=recNum(r.alt_km))!=null) alt=v*1000;
  else if((v=recNum(r.alt_m ?? r.altitude_m))!=null) alt=v;
  else if((v=recNum(r.alt ?? r.altGnss))!=null) alt=adsb ? v*FLY_FT : v;
  const sp=recNum(r.speed ?? r.gs), vr=recNum(r.vr);
  return {lat, lon, alt, hdg:recNum(r.heading ?? r.track ?? r.hdg), spd:sp!=null ? (adsb ? sp*FLY_KT : sp) : null,
    vs:vr!=null ? vr*.00508 : 0, ground:!!r.ground};
}
// запись о самолёте: положение по последнему отчёту, поправка гаснет за ~1.5 с, крен — по скорости поворота курса
function flyTrackPush(tr,r,now){
  const q=flyRecState(r); if(!q) return tr;
  if(!tr) return {...q, t:now, off:[0,0,0], roll:0, hdg:q.hdg ?? 0, spd:q.spd ?? 0, id:r.id};
  const cur=flyTrackAt(tr,now), dt=(now-tr.t)/1000;
  let roll=tr.roll;
  if(q.hdg!=null && dt>.2 && dt<10 && q.spd>20){
    const tgt=flyClamp(Math.atan(q.spd*flyWrap(q.hdg-tr.hdg)*FLY_D/dt/FLY_G)/FLY_D,-45,45);
    roll+=(tgt-roll)*.5;
  }
  const e=flyEnu({lat:q.lat,lon:q.lon,alt:q.alt},cur);
  return {...q, t:now, off:e, roll, hdg:q.hdg ?? tr.hdg, spd:q.spd ?? tr.spd, id:tr.id};
}
function flyTrackAt(tr,now){
  const dt=Math.min(15,Math.max(0,(now-tr.t)/1000)), hr=tr.hdg*FLY_D, k=Math.exp(-dt/1.5);
  const p=flyMove(tr.lat,tr.lon,tr.spd*Math.sin(hr)*dt+tr.off[0]*k, tr.spd*Math.cos(hr)*dt+tr.off[1]*k);
  const alt=tr.ground ? tr.alt : tr.alt+tr.vs*dt+tr.off[2]*k;
  return {lat:p.lat, lon:p.lon, alt, hdg:tr.hdg, spd:tr.spd, vs:tr.ground ? 0 : tr.vs, roll:tr.roll, pitch:tr.spd>1 ? Math.atan2(tr.vs,tr.spd)/FLY_D : 0};
}

// ---------- камеры ----------
// T — цель {lat,lon,alt,hdg,pitch,roll}; o — точка башни {lat,lon,alt}; st — состояние камеры между кадрами {hdg, orb}
// opt: dist, height (м), orbit (°/с), fov (°), zoom (доля кадра, 0 — выкл.), size (м) — размах крыла для автозума
function flyCamera(mode,T,o,st,dt,opt){
  const lookAt=(c,t)=>{ const l=flyLook(flyEnu(c,t)); return {az:l.az, el:l.el, range:l.range}; };
  const out=(c,az,el,roll,fov)=>({lat:c.lat, lon:c.lon, alt:c.alt, az, el, roll, fov});
  if(mode==='cockpit') return out({lat:T.lat,lon:T.lon,alt:T.alt+1.2},T.hdg,T.pitch,T.roll,opt.fov);
  const tgt={lat:T.lat,lon:T.lon,alt:T.alt};
  if(mode==='tower'){
    const l=lookAt(o,tgt);
    let fov=opt.fov;
    if(opt.zoom>0) fov=flyClamp(2*Math.atan(opt.size/(2*opt.zoom*Math.max(1,l.range)))/FLY_D,3,opt.fov);
    st.fov=st.fov==null ? fov : st.fov+(fov-st.fov)*Math.min(1,dt*3);
    return out(o,l.az,l.el,0,st.fov);
  }
  let a;                                                  // направление от цели к камере
  if(mode==='orbit'){ st.orb=flyNorm((st.orb||0)+opt.orbit*dt); a=st.orb*FLY_D; }
  else {                                                  // chase: сзади по сглаженному курсу
    st.hdg=st.hdg==null ? T.hdg : flyNorm(st.hdg+flyWrap(T.hdg-st.hdg)*Math.min(1,dt*2.5));
    a=(st.hdg+180)*FLY_D;
  }
  const p=flyMove(T.lat,T.lon,Math.sin(a)*opt.dist,Math.cos(a)*opt.dist), c={lat:p.lat,lon:p.lon,alt:T.alt+opt.height};
  const l=lookAt(c,tgt);
  return out(c,l.az,l.el,0,opt.fov);
}
