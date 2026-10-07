// Ядро Flight Sim: node tools/test-flightsim.mjs
// Модель полёта, камеры, цель из ADS-B — синтетические сценарии.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,isFinite,Number,Object});
vm.runInContext(`function recNum(v){ if(typeof v==='number') return isFinite(v) ? v : null; if(typeof v==='string' && v.trim()!==''){ const x=Number(v); return isFinite(x) ? x : null; } return null; }`+
  fs.readFileSync(path.join(root,'modules/flightsim-kernels.js'),'utf8')+
  ';this.K={flyMove,flyEnu,flyLook,flyInit,flyStep,flyRecState,flyTrackPush,flyTrackAt,flyCamera,flyWrap,flyNorm};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b+' (±'+e+')');
const run=(s,c,sec,gh=0,P={})=>{ for(let i=0;i<sec*50;i++) K.flyStep(s,c,.02,P,gh); return s; };
const lvl={ail:0,elev:0,rud:0,thr:.5};

// геометрия
const a={lat:55,lon:82,alt:0}, b=K.flyMove(a.lat,a.lon,1000,0), e=K.flyEnu(a,{...b,alt:50});
near('move east 1 km',e[0],1000,.5); near('move east: no north drift',e[1],0,.5); near('enu alt',e[2],50,1e-9);
const l=K.flyLook([0,1000,1000]); near('look az north',l.az,0,1e-9); near('look el 45',l.el,45,1e-9);
near('look range',l.range,1414.2,.1); near('look az west',K.flyLook([-1,0,0]).az,270,1e-9);
near('enu across the date line',K.flyEnu({lat:0,lon:179.9,alt:0},{lat:0,lon:-179.9,alt:0})[0],22239,10);

// полёт: прямо и ровно
let s=K.flyInit(55,82,100,300,90,{});
near('start alt',s.alt,400,1e-9); ok('starts airborne',!s.gnd);
run(s,lvl,20,100);
near('level: altitude steady',s.alt,400,1);
ok('level: heading steady',Math.abs(K.flyWrap(s.hdg-90))<.5,s.hdg);
const d=K.flyEnu({lat:55,lon:82,alt:400},{lat:s.lat,lon:s.lon,alt:400});
ok('flies east',d[0]>500 && Math.abs(d[1])<5,d.join());
// крен → поворот в нужную сторону, стандартный темп
s=K.flyInit(55,82,100,300,0,{}); run(s,{ail:.5,elev:0,rud:0,thr:.5},2,100);
near('bank follows stick',s.roll,30,.5); ok('right bank turns right',K.flyWrap(s.hdg)>0,s.hdg);
s=K.flyInit(55,82,100,300,0,{}); run(s,{ail:-.5,elev:0,rud:0,thr:.5},5,100);
ok('left bank turns left',K.flyWrap(s.hdg)<0,s.hdg);
// тангаж: набор и снижение
s=K.flyInit(55,82,100,300,0,{}); run(s,{ail:0,elev:.3,rud:0,thr:.8},10,100);
ok('pull climbs',s.alt>450,s.alt);
s=K.flyInit(55,82,100,300,0,{}); run(s,{ail:0,elev:-.3,rud:0,thr:.5},4,100);
ok('push descends',s.alt<370,s.alt);
// малый газ: самолёт не должен ускоряться, крутой набор срывает
s=K.flyInit(55,82,100,300,0,{}); run(s,{ail:0,elev:1,rud:0,thr:0},15,100);
ok('idle full pull does not climb forever',s.alt<500 || s.pitch<30,s.alt+' '+s.pitch);
// газ → скорость
s=K.flyInit(55,82,100,300,0,{}); run(s,{ail:0,elev:0,rud:0,thr:1},30,100);
near('full throttle reaches vmax',s.spd,100,2);
// касание: мягкое — остаётся на земле, жёсткое — авария
s=K.flyInit(55,82,0,20,0,{}); s.spd=45; s.pitch=-3; s.thr=0;
run(s,{ail:0,elev:-.1,rud:0,thr:0},12,0); ok('soft touchdown',s.gnd && !s.crashed,JSON.stringify(s));
near('on ground at gear height',s.alt,1.5,.01);
s=K.flyInit(55,82,0,60,0,{}); run(s,{ail:0,elev:-1,rud:0,thr:.5},10,0); ok('dive crashes',s.crashed,JSON.stringify(s));
const sc=run(s,lvl,5,0); near('crashed state frozen',sc.spd,0,1e-9);
s=K.flyInit(55,82,0,30,0,{}); s.spd=90; s.thr=1; run(s,{ail:0,elev:-.1,rud:0,thr:1},10,0); ok('fast into the ground crashes',s.crashed);
// взлёт с земли
s=K.flyInit(55,82,0,0,0,{}); ok('agl 0 → on ground',s.gnd && s.spd===0);
run(s,{ail:0,elev:0,rud:0,thr:1},8,0); ok('accelerates on ground',s.gnd && s.spd>38,s.spd);
run(s,{ail:0,elev:.5,rud:0,thr:1},6,0); ok('rotates and leaves the ground',!s.gnd && s.alt>20,s.alt+' '+s.gnd);
s=K.flyInit(55,82,0,0,0,{}); run(s,{ail:0,elev:1,rud:0,thr:.2},10,0); ok('no lift-off below rotation speed',s.gnd);
// рельеф: набор высоты склона не «втягивает» самолёт под землю
s=K.flyInit(55,82,0,100,0,{}); for(let i=0;i<500;i++) K.flyStep(s,{ail:0,elev:.1,rud:0,thr:.6},.02,{},i*.2);
ok('terrain rises, aircraft stays above or crashes cleanly',s.alt>=100-1e-6 || s.crashed);

// ADS-B
const rec={id:'ABC123',icao:'ABC123',lat:55,lon:82,alt:35000,speed:450,heading:90,vr:0};
const st=K.flyRecState(rec);
near('adsb alt ft→m',st.alt,35000*.3048,.01); near('adsb speed kt→m/s',st.spd,450*.514444,.01);
near('adsb vr ft/min→m/s',K.flyRecState({...rec,vr:1000}).vs,5.08,.01);
ok('no coords → null',K.flyRecState({id:1})===null);
near('non-adsb alt in m',K.flyRecState({lat:1,lon:2,alt_m:120}).alt,120,1e-9);
let tr=K.flyTrackPush(null,rec,0);
let p=K.flyTrackAt(tr,10000);
near('extrapolates along heading',K.flyEnu({lat:55,lon:82,alt:0},{...p,alt:0})[0],450*.514444*10,1);
near('track carries vertical speed',K.flyTrackAt(K.flyTrackPush(null,{...rec,vr:1000},0),1000).vs,5.08,.01);
near('extrapolation capped at 15 s',K.flyEnu({lat:55,lon:82,alt:0},{...K.flyTrackAt(tr,60000),alt:0})[0],450*.514444*15,1);
// новый отчёт: позиция не скачет, поправка гаснет
const r2={...rec,...K.flyMove(55,82,300,0)};
const before=K.flyTrackAt(tr,1000);
tr=K.flyTrackPush(tr,r2,1000);
const after=K.flyTrackAt(tr,1000);
near('no jump on new report (lat)',after.lat,before.lat,1e-9); near('no jump on new report (lon)',after.lon,before.lon,1e-9);
const fin=K.flyTrackAt(tr,9000), expect=K.flyMove(r2.lat,r2.lon,450*.514444*8,0);
near('offset decays',fin.lon,expect.lon,2e-4);
// поворот → крен
let t2=K.flyTrackPush(null,{...rec,heading:90},0);
for(let i=1;i<=6;i++) t2=K.flyTrackPush(t2,{...rec,heading:90+3*i*1.0*1,speed:450},i*1000);
ok('turning right → positive bank',t2.roll>5,t2.roll);
t2=K.flyTrackPush(null,{...rec,heading:90},0); for(let i=1;i<=6;i++) t2=K.flyTrackPush(t2,{...rec,heading:90-3*i},i*1000);
ok('turning left → negative bank',t2.roll<-5,t2.roll);

// камеры
const T={lat:55,lon:82,alt:1000,hdg:90,pitch:5,roll:20}, opt={dist:50,height:10,orbit:30,fov:60,zoom:0,size:40};
let c=K.flyCamera('cockpit',T,null,{},.02,opt);
near('cockpit az',c.az,90,1e-9); near('cockpit el',c.el,5,1e-9); near('cockpit roll',c.roll,20,1e-9); near('cockpit above the aircraft',c.alt-T.alt,1.2,1e-9);
c=K.flyCamera('chase',T,null,{},.02,opt);
const ce=K.flyEnu({lat:T.lat,lon:T.lon,alt:T.alt},c);
near('chase behind (west)',ce[0],-50,.5); near('chase above',ce[2],10,1e-9);
near('chase looks east',c.az,90,.5); ok('chase looks down at the aircraft',c.el<0,c.el);
const stc={}; K.flyCamera('chase',T,null,stc,.02,opt);
for(let i=0;i<10;i++) K.flyCamera('chase',{...T,hdg:180},null,stc,.02,opt);
ok('chase heading lags behind a turn',stc.hdg>90 && stc.hdg<180,stc.hdg);
const so={}; const o1=K.flyCamera('orbit',T,null,so,1,opt), o2=K.flyCamera('orbit',T,null,so,1,opt);
near('orbit advances',K.flyWrap(o2.az-o1.az)!==0 ? 1 : 0,1,0); near('orbit keeps distance',Math.hypot(K.flyEnu({lat:T.lat,lon:T.lon,alt:T.alt},o2)[0],K.flyEnu({lat:T.lat,lon:T.lon,alt:T.alt},o2)[1]),50,.5);
const tw={lat:55,lon:81.9,alt:100};
c=K.flyCamera('tower',T,tw,{},.02,opt);
near('tower stays put',c.lon,81.9,1e-12); ok('tower looks east and up',Math.abs(K.flyWrap(c.az-90))<1 && c.el>0,c.az+' '+c.el);
const z1=K.flyCamera('tower',T,tw,{},1,{...opt,zoom:.1}), z2=K.flyCamera('tower',{...T,lon:82.5},tw,{},1,{...opt,zoom:.1});
ok('autozoom narrows with distance',z2.fov<z1.fov && z1.fov<=60,z1.fov+' '+z2.fov);

console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad?1:0);
