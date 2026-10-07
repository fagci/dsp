"use strict";
/* ============================ Flight Sim ============================
   Аркадный самолёт на ручках (Joystick / Gamepad) или просмотр рейса из ADS-B, и камера: кабина, сзади, башня, облёт.
   Выходы lat / lon / alt / az / el / roll / fov — на входы Video Overlay и Horizon (рельеф и объекты вокруг камеры).
   Высота земли — Horizon.hAt (если есть узел Horizon), иначе плоская по параметру ground. Ядро — flightsim-kernels.js. */

const FLY_CAMS=['chase','cockpit','tower','orbit'];
const FLY_TTL=90000, FLY_WAIT=20000;

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
function flySpawn(n,I,now){
  const pt=n.spawnAt || flyPoint(n,I);
  if(!pt){ n.msg='no start point — add My Position or wire lat / lon'; return false; }
  if(!n.spawnAt){ n.spawnAt=pt; n.spawnT=now; n.gh=null; n.tower=pt; }
  const h=Horizon.hAt ? Horizon.hAt(pt.lat,pt.lon) : NaN, haveHz=Graph.nodes.some(x=>x.type==='horizon');
  if(h!==h && haveHz && now-n.spawnT<FLY_WAIT){ n.msg='waiting for terrain (Horizon)…'; return false; }
  const gh=h===h ? h : +n.p.ground; n.gh=gh;
  n.s=flyInit(pt.lat,pt.lon,gh,+n.p.agl0,+n.p.hdg0,flyModelP(n.p));
  n.spawnAt=null; n.cs={}; n.msg='';
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
          {n:'th',t:'range',min:0,max:100,step:1,d:8,label:'tower height above ground, m'},
          {n:'agl0',t:'range',min:0,max:3000,step:10,d:300,label:'start height above ground, m (0 — on the ground)'},
          {n:'hdg0',t:'range',min:0,max:359,step:1,d:90,label:'start heading, °'},
          {n:'thrm',t:'select',opts:['stick −1…1','lever 0…1'],d:'stick −1…1',label:'thr input range'},
          {n:'inv',t:'check',d:false,label:'invert elevator (stick forward — nose down)'},
          {n:'vmin',t:'num',d:30,label:'stall speed, m/s',adv:true},
          {n:'vmax',t:'num',d:100,label:'top speed, m/s',adv:true},
          {n:'ground',t:'num',d:0,label:'ground height without Horizon, m',adv:true},
          {n:'slat',t:'num',d:55.7558,label:'start lat, ° (no My Position, no wire)',adv:true},
          {n:'slon',t:'num',d:37.6173,label:'start lon, °',adv:true},
          {n:'id',t:'text',d:'sim',label:'record id',adv:true}],
  init:n=>{ n.s=null; n.spawnAt=null; n.tower=null; n.cs={}; n.t=0; n.tracks=new Map(); n.pickId=null; n.nextPick=false;
            n.thrCmd=.5; n.edge={reset:0,cam:0,next:0}; n.gh=null; n.msg=''; n.txt=''; n.camKey=''; n.out=null; },
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
        if(tv!=null) n.thrCmd=p.thrm==='lever 0…1' ? Math.max(0,Math.min(1,tv)) : Math.max(0,Math.min(1,(tv+1)/2));
        const c={ail:clamp1(recNum(I.ail)??0), elev:(p.inv?-1:1)*clamp1(recNum(I.elev)??0), rud:clamp1(recNum(I.rud)??0), thr:n.thrCmd};
        const steps=Math.ceil(dt/.02), h=dt/Math.max(1,steps), P=flyModelP(p);
        for(let i=0;i<steps;i++) flyStep(s,c,h,P,flyGround(n,s.lat,s.lon));
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
    if(cam) n.lastAz=cam.az;
    // ----- выходы -----
    const kts=own ? own.spd/FLY_KT : null, agl=own ? own.alt-flyGroundAt(n,own.lat,own.lon) : null;
    const showOwn=!watch && own && p.cam!=='cockpit';
    const rec=!watch ? [showOwn
      ? {t:ts, id, label:'SIM', lat:own.lat, lon:own.lon, alt_m:own.alt, heading:own.hdg, pitch:own.pitch, roll:own.roll, icon:'plane',
         color:'#7dff9a', ...(n.s.gnd ? {ground:true} : {})}
      : {id, gone:true}] : null;
    if(!watch) text=n.s ? (n.s.crashed ? 'CRASHED — press Reset' : '') : n.msg;
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
