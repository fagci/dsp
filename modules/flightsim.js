"use strict";
/* ============================ Flight Sim ============================
   Аркадный самолёт на ручках (Joystick / Gamepad) или просмотр рейса из ADS-B, и камера: кабина, сзади, башня, облёт.
   Выходы lat / lon / alt / az / el / roll / fov — на входы Video Overlay и Horizon (рельеф и объекты вокруг камеры).
   Высота земли — Horizon.hAt (если есть узел Horizon), иначе плоская по параметру ground. Ядро — flightsim-kernels.js. */

const FLY_CAMS=['chase','cockpit','tower','orbit','free'];
const FLY_TTL=90000, FLY_WAIT=20000, FLY_RWY_KM=30;

// высота земли: по карте Horizon, вне её — последняя известная, до первой — параметр
function flyGround(n,la,lo){
  const h=Horizon.hAt ? Horizon.hAt(la,lo) : NaN;
  if(h===h) n.gh=h;
  return n.gh ?? +n.p.ground;
}
function flyPoint(n,I){
  const la=recNum(I.lat) ?? GeoMe.lat ?? recNum(n.p.slat), lo=recNum(I.lon) ?? GeoMe.lon ?? recNum(n.p.slon);
  return la!=null && lo!=null ? {lat:la, lon:lo} : null;
}
function flyModelP(p){ return {vmin:+p.vmin, vmax:Math.max(+p.vmax,+p.vmin+10)}; }

// самолёт ставится, когда известна высота земли в точке старта: без неё агл дал бы неверную высоту
// ближайшая полоса из данных аэродромов (geofeat.js): undefined — ещё грузится, null — рядом нет
function flyRunway(n,pt){
  const key=pt.lat.toFixed(3)+','+pt.lon.toFixed(3);
  if(n.rwyKey!==key){ n.rwyKey=key; n.rwy=undefined; n.rwyBusy=false; }
  if(n.rwy===undefined && !n.rwyBusy){
    n.rwyBusy=true;
    gsAir(pt.lat,pt.lon,FLY_RWY_KM,true).then(r=>{ n.rwy=gfNearestRunway(r.data,pt.lat,pt.lon,FLY_RWY_KM); if(!n.rwy && r.error) n.rwyErr=r.error; })
      .catch(e=>{ n.rwy=null; n.rwyErr=e.message; }).finally(()=>{ n.rwyBusy=false; });
  }
  return n.rwy;
}
function flySpawn(n,I,now){
  let pt=n.spawnAt || flyPoint(n,I), hdg=+n.p.hdg0, agl=+n.p.agl0, note='';
  if(!pt){ n.msg='no start point — add My Position or wire lat / lon'; return false; }
  if(!n.spawnAt){ n.spawnAt=pt; n.spawnT=now; n.gh=null; n.tower=pt; n.spawnRwy=null; }
  if(n.p.start==='nearest runway' && !n.spawnRwy){
    const r=flyRunway(n,n.spawnAt);
    if(r===undefined){ n.msg='looking for a runway…'; return false; }
    n.spawnRwy=r || {none:true};
    if(r){ n.spawnAt=pt={lat:r.lat,lon:r.lon}; n.tower=pt; n.spawnT=now; }
  }
  if(n.p.start==='nearest runway'){
    if(n.spawnRwy.none) note='no runway within '+FLY_RWY_KM+' km'+(n.rwyErr ? ' ('+n.rwyErr+')' : '')+' — started at the point';
    else { hdg=n.spawnRwy.hdg; agl=0; note='runway '+(n.spawnRwy.ref||'')+' '+(n.spawnRwy.name||'')+', '+Math.round(n.spawnRwy.len)+' m'; }
  }
  const h=Horizon.hAt ? Horizon.hAt(pt.lat,pt.lon) : NaN, haveHz=Graph.nodes.some(x=>x.type==='horizon');
  if(h!==h && haveHz && now-n.spawnT<FLY_WAIT){ n.msg='waiting for terrain (Horizon)…'; return false; }
  const gh=h===h ? h : +n.p.ground; n.gh=gh;
  n.s=flyInit(pt.lat,pt.lon,gh,agl,hdg,flyModelP(n.p));
  if(agl<=0) n.thrCmd=0;
  n.spawnAt=null; n.cs={}; n.msg=''; n.note=note;
  return true;
}
function flyReset(n){ n.s=null; n.spawnAt=null; n.cs={}; }
function flyCycleCam(n){ const i=FLY_CAMS.indexOf(n.p.cam); setMod(n,'cam',FLY_CAMS[(i+1)%FLY_CAMS.length]); }
function flyMatch(tr,q){ return !q || (tr.id+' '+tr.label).toLowerCase().includes(q); }
function flyNext(n){ n.nextPick=true; }

def({ id:'flightsim', title:'Flight Sim', cat:'Sources',
  kw:'flight simulator plane aircraft fly camera chase cockpit tower orbit adsb watch follow joystick gamepad',
  // fly — самолёт на ручках; watch — камера на самолёте из ADS-B (rec). Нужен запущенный движок: время идёт по блокам.
  // lat / lon — точка старта / башни (иначе My Position, иначе параметры); ail elev rud −1…1 с Joystick, thr — газ (стик −1…1 или рычаг 0…1);
  // reset / cam / next — импульс (кнопка Joystick): сброс, смена камеры, следующий самолёт
  ins:[{n:'ail',t:'num'},{n:'elev',t:'num'},{n:'rud',t:'num'},{n:'thr',t:'num'},{n:'rec',t:'rec'},
       {n:'lat',t:'num'},{n:'lon',t:'num'},{n:'reset',t:'num'},{n:'cam',t:'num'},{n:'next',t:'num'}],
  // lat…fov — камера; kts, agl (м), vsi (м/с), hdg, pwr (%) — для HUD; rec — свой самолёт для камер снаружи
  outs:[{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'alt',t:'num'},{n:'az',t:'num'},{n:'el',t:'num'},{n:'roll',t:'num'},{n:'fov',t:'num'},
        {n:'rec',t:'rec'},{n:'kts',t:'num'},{n:'agl',t:'num'},{n:'vsi',t:'num'},{n:'hdg',t:'num'},{n:'pwr',t:'num'},{n:'text',t:'txt'}],
  w:340, readout:true,
  params:[{n:'mode',t:'select',opts:['fly','watch ADS-B'],d:'fly',label:'fly your own aircraft, or watch one from the rec input'},
          {n:'cam',t:'select',opts:FLY_CAMS,d:'chase',label:'camera'},
          {n:'follow',t:'text',d:'',label:'watch: callsign or ICAO (empty — the nearest to the tower)'},
          {n:'next',t:'button',label:'Next aircraft',fn:n=>flyNext(n)},
          {n:'reset',t:'button',label:'Reset',fn:n=>flyReset(n)},
          {n:'fov',t:'range',min:20,max:120,step:1,d:70,label:'field of view, °'},
          {n:'dist',t:'range',min:10,max:500,step:5,d:45,label:'chase / orbit distance, m'},
          {n:'height',t:'range',min:0,max:200,step:1,d:12,label:'chase / orbit height above the aircraft, m'},
          {n:'orbit',t:'range',min:0,max:90,step:1,d:15,label:'orbit speed, °/s'},
          {n:'zoom',t:'check',d:true,label:'tower: zoom on the aircraft'},
          {n:'fspeed',t:'range',min:5,max:2000,step:5,d:150,label:'free camera: speed at full stick, m/s (cam = free: ail turns, elev looks up / down, thr goes forward along the view, rud steps sideways; the aircraft stands still)'},
          {n:'th',t:'range',min:0,max:100,step:1,d:8,label:'tower height above ground, m'},
          {n:'agl0',t:'range',min:0,max:3000,step:10,d:300,label:'start height above ground, m (0 — on the ground)'},
          {n:'start',t:'select',opts:['point','nearest runway'],d:'point',label:'start: in the air at the point, or on the nearest runway (OSM, saved in the browser; heads along it, throttle idle)'},
          {n:'hdg0',t:'range',min:0,max:359,step:1,d:90,label:'start heading, °'},
          {n:'thrm',t:'select',opts:['stick −1…1','lever 0…1','stick up only 0…1'],d:'stick −1…1',label:'thr input: a stick −1…1 (centre = half), a lever 0…1, or a stick whose lower half is idle (hold-throttle Joystick: starts at idle)'},
          {n:'inv',t:'check',d:false,label:'invert elevator (stick forward — nose down)'},
          {n:'vmin',t:'num',d:30,label:'stall speed, m/s',adv:true},
          {n:'vmax',t:'num',d:100,label:'top speed, m/s',adv:true},
          {n:'ground',t:'num',d:0,label:'ground height without Horizon, m',adv:true},
          {n:'slat',t:'num',d:55.7558,label:'start lat, ° (no My Position, no wire)',adv:true},
          {n:'slon',t:'num',d:37.6173,label:'start lon, °',adv:true},
          {n:'id',t:'text',d:'sim',label:'record id',adv:true}],
  init:n=>{ n.s=null; n.spawnAt=null; n.tower=null; n.cs={}; n.t=0; n.tracks=new Map(); n.pickId=null; n.nextPick=false;
            n.thrCmd=.5; n.note=''; n.rwy=undefined; n.rwyKey=''; n.rwyBusy=false; n.rwyErr=''; n.spawnRwy=null; n.edge={reset:0,cam:0,next:0}; n.fc=null; n.gh=null; n.msg=''; n.txt=''; n.camKey=''; n.out=null; },
  process(n,I){
    const p=n.p, now=performance.now(), ts=Date.now(), dt=n.t ? Math.min(.1,(now-n.t)/1000) : 0; n.t=now;
    const rise=k=>{ const v=recNum(I[k])>.5 ? 1 : 0, r=v && !n.edge[k]; n.edge[k]=v; return r; };
    if(rise('reset')) flyReset(n);
    if(rise('cam')) flyCycleCam(n);
    if(rise('next')) flyNext(n);
    const watch=p.mode==='watch ADS-B';
    if(n.camKey!==p.cam+'|'+p.mode){ n.camKey=p.cam+'|'+p.mode; n.cs={}; }
    const clamp1=v=>Math.max(-1,Math.min(1,v));
    let T=null, own=null, id='', text='';
    // ----- цель -----
    if(watch){
      const rl=recList(I.rec);
      for(const r of rl){ if(!r || r.id==null) continue;
        const k=String(r.id), tr=flyTrackPush(n.tracks.get(k),r,ts); if(!tr) continue;
        tr.label=String(r.label ?? r.flight ?? k); n.tracks.set(k,tr); }
      for(const [k,tr] of n.tracks) if(ts-tr.t>FLY_TTL) n.tracks.delete(k);
      const pt=flyPoint(n,I);
      if(pt) n.tower=pt;
      const q=String(p.follow||'').trim().toLowerCase(), list=[...n.tracks.values()].filter(tr=>flyMatch(tr,q)).sort((a,b)=>a.id<b.id ? -1 : 1);
      if(n.nextPick && list.length){ const i=list.findIndex(tr=>tr.id===n.pickId); n.pickId=list[(i+1)%list.length].id; }
      n.nextPick=false;
      let pick=list.find(tr=>tr.id===n.pickId);
      if(!pick && list.length && n.tower){
        const o={lat:n.tower.lat,lon:n.tower.lon,alt:0}, dist=tr=>{ const e=flyEnu(o,{lat:tr.lat,lon:tr.lon,alt:0}); return Math.hypot(e[0],e[1]); };
        pick=list.reduce((a,b)=>dist(b)<dist(a) ? b : a); n.pickId=pick.id;
      }
      if(pick){ T=own=flyTrackAt(pick,ts); id=pick.label; }
      n.s=null;
    } else {
      if(!n.s) flySpawn(n,I,now);
      if(n.s){
        const s=n.s, tv=recNum(I.thr);
        if(tv!=null) n.thrCmd=p.thrm==='stick −1…1' ? Math.max(0,Math.min(1,(tv+1)/2)) : Math.max(0,Math.min(1,tv));
        const c={ail:clamp1(recNum(I.ail)??0), elev:(p.inv?-1:1)*clamp1(recNum(I.elev)??0), rud:clamp1(recNum(I.rud)??0), thr:n.thrCmd};
        const steps=Math.ceil(dt/.02), h=dt/Math.max(1,steps), P=flyModelP(p);
        if(p.cam!=='free') for(let i=0;i<steps;i++) flyStep(s,c,h,P,flyGround(n,s.lat,s.lon));          // свободная камера: самолёт стоит
        T={lat:s.lat,lon:s.lon,alt:s.alt,hdg:s.hdg,pitch:s.pitch,roll:s.roll}; own={...T,spd:s.spd,vs:s.vs};
        id=p.id||'sim';
      }
    }
    // ----- камера -----
    const o=n.tower ? {lat:n.tower.lat, lon:n.tower.lon, alt:flyGroundAt(n,n.tower.lat,n.tower.lon)+ +p.th} : null;
    let cam=null;
    const opt={dist:+p.dist, height:+p.height, orbit:+p.orbit, fov:+p.fov, zoom:p.zoom ? .12 : 0, size:35};
    if(T && (o || p.cam==='cockpit' || p.cam==='chase' || p.cam==='orbit')){
      cam=flyCamera(p.cam,T,o,n.cs,dt,opt);
      if(p.cam==='chase' || p.cam==='orbit'){
        const g=flyGroundAt(n,cam.lat,cam.lon)+2;
        if(cam.alt<g){ cam.alt=g; const l=flyLook(flyEnu(cam,T)); cam.az=l.az; cam.el=l.el; }
      }
    } else if(o) cam={lat:o.lat,lon:o.lon,alt:o.alt,az:n.lastAz ?? 0,el:5,roll:0,fov:+p.fov};
    // свободный полёт камеры: не привязана ни к самолёту, ни к башне. ail — поворот, elev — взгляд вверх / вниз, rud — шаг в сторону,
    // thr (−1…1) — вперёд / назад вдоль взгляда (с Joystick hold — «круиз»); стартует с того места, где была камера
    if(p.cam!=='free') n.fc=null;
    else {
      if(!n.fc && cam) n.fc={lat:cam.lat,lon:cam.lon,alt:cam.alt,az:cam.az,el:Math.max(-60,Math.min(60,cam.el))};
      const f=n.fc;
      if(f){
        const sp=+p.fspeed, c1=v=>Math.max(-1,Math.min(1,v??0));
        f.az=((f.az+c1(recNum(I.ail))*70*dt)%360+360)%360; f.el=Math.max(-89,Math.min(89,f.el+(p.inv?-1:1)*c1(recNum(I.elev))*50*dt));
        const a=f.az*Math.PI/180, e=f.el*Math.PI/180, fw=c1(recNum(I.thr))*sp*dt, st=c1(recNum(I.rud))*sp*dt;
        const q=flyMove(f.lat,f.lon,Math.sin(a)*Math.cos(e)*fw+Math.cos(a)*st, Math.cos(a)*Math.cos(e)*fw-Math.sin(a)*st);
        f.lat=q.lat; f.lon=q.lon; f.alt=Math.max(flyGroundAt(n,f.lat,f.lon)+2,f.alt+Math.sin(e)*fw);
        cam={lat:f.lat,lon:f.lon,alt:f.alt,az:f.az,el:f.el,roll:0,fov:+p.fov};
      }
    }
    if(cam) n.lastAz=cam.az;
    // ----- выходы -----
    const kts=own ? own.spd/FLY_KT : null, agl=own ? own.alt-flyGroundAt(n,own.lat,own.lon) : null;
    const showOwn=!watch && own && p.cam!=='cockpit';
    const rec=!watch ? [showOwn
      ? {t:ts, id, label:'SIM', lat:own.lat, lon:own.lon, alt_m:own.alt, heading:own.hdg, pitch:own.pitch, roll:own.roll, icon:'plane',
         color:'#7dff9a', ...(n.s.gnd ? {ground:true} : {})}
      : {id, gone:true}] : null;
    if(!watch) text=n.s ? (n.s.crashed ? 'CRASHED — press Reset' : n.note||'') : n.msg;
    else text=T ? '' : n.tracks.size ? 'no match for «'+p.follow+'»' : 'waiting for aircraft on rec…';
    n.txt=(cam ? (watch ? 'watch · ' : 'fly · ')+p.cam+(id ? ' · '+id : '') : '')+(own ? '\n'+Math.round(kts)+' kt · '+Math.round(own.alt)+' m (AGL '+Math.round(agl)+') · hdg '+String(Math.round(own.hdg)).padStart(3,'0')+
      ' · VS '+(own.vs>=0?'+':'')+own.vs.toFixed(1)+' m/s'+(!watch ? ' · THR '+Math.round(n.s.thr*100)+'%' : '') : '')+(text ? '\n'+text : '');
    return {lat:cam?.lat ?? null, lon:cam?.lon ?? null, alt:cam?.alt ?? null, az:cam?.az ?? null, el:cam?.el ?? null, roll:cam?.roll ?? null,
      fov:cam?.fov ?? null, rec, kts, agl, vsi:own?.vs ?? null, hdg:own?.hdg ?? null, pwr:!watch && n.s ? n.s.thr*100 : null, text:n.txt};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.txt||n.msg; }});

// высота земли в произвольной точке (камера, башня): как flyGround, но без обновления «земли под самолётом»
function flyGroundAt(n,la,lo){
  const h=Horizon.hAt ? Horizon.hAt(la,lo) : NaN;
  return h===h ? h : (n.gh ?? +n.p.ground);
}
