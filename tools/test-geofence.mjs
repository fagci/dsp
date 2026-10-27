// Геозоны: node tools/test-geofence.mjs
import fs from 'node:fs';
import vm from 'node:vm';
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const ctx=vm.createContext({Math,Number,String,Object,Array,JSON,Map,Set,isFinite,Infinity});
vm.runInContext(fs.readFileSync(new URL('../modules/geofence-kernels.js',import.meta.url),'utf8')+';this.K={gfParseZones,gfZoneFromRec,gfSigned,gfStep,gfShapes,gfDist};',ctx);
const K=ctx.K;
ok('distance: 1° of latitude ≈ 111.2 km',Math.abs(K.gfDist(0,0,1,0)-111195)<200);
const z=K.gfParseZones('# comment\nHome: circle 55.75 37.62 200\nPark: poly 55.76,37.60 55.76,37.64 55.74,37.64 55.74,37.60\nbad line\nTiny: circle 91 0 5');
ok('parser: circle, polygon, errors',z.zones.length===2 && z.zones[0].r===200 && z.zones[1].geom.length===4 && z.errors.length===2,JSON.stringify(z.errors));
ok('parser: JSON form',K.gfParseZones('[{"name":"A","type":"circle","lat":1,"lon":2,"r":50}]').zones[0].r===50);
ok('Map record → zone (circle, polygon with a JSON string)',K.gfZoneFromRec({name:'c',gtype:'circle',lat:1,lon:2,radius:30}).r===30 && K.gfZoneFromRec({name:'p',gtype:'polygon',geom:'[[0,0],[0,1],[1,1]]'}).geom.length===3 && K.gfZoneFromRec({name:'x',gtype:'line'})===null);
const home=z.zones[0], park=z.zones[1];
ok('circle: inside is negative, outside positive',K.gfSigned(home,55.75,37.62)<-190 && Math.abs(K.gfSigned(home,55.7518,37.62)-0)<5 && K.gfSigned(home,55.76,37.62)>900);
ok('polygon: inside / outside / distance to an edge',K.gfSigned(park,55.75,37.62)<0 && K.gfSigned(park,55.80,37.62)>0 && Math.abs(Math.abs(K.gfSigned(park,55.75,37.62))-1100)<30,K.gfSigned(park,55.75,37.62));
ok('polygon edge distance outside matches the circle formula',Math.abs(K.gfSigned(park,55.77,37.62)-1107)<30,K.gfSigned(park,55.77,37.62));
// события
const st={}, ev=[]; const step=(lat,lon,t,o)=>{ const r=K.gfStep(st,[home],lat,lon,t,o); ev.push(...r.events.map(e=>e.ev)); return r; };
step(55.80,37.62,0); step(55.80,37.62,1);
ok('first fix outside → no event',ev.length===0);
step(55.75,37.62,2); ok('enter',ev.join()==='enter');
step(55.75,37.62,3); ok('no repeat while inside',ev.length===1);
step(55.7515,37.62,4); ok('still inside near the edge',ev.length===1);
step(55.80,37.62,5); ok('exit',ev.join()==='enter,exit');
// гистерезис 50 м: на границе дребезга нет
const st2={}, e2=[]; const s2=(lat,t)=>e2.push(...K.gfStep(st2,[home],lat,37.62,t,{hyst:50}).events.map(e=>e.ev));
s2(55.80,0); s2(55.7515,1); s2(55.7523,2); s2(55.7515,3); s2(55.7523,4);       // колеблемся в ±25 м у границы (≈200 м)
ok('hysteresis: jitter at the edge gives no events',e2.length===0,e2.join());
s2(55.7490,5); ok('hysteresis: deep inside → enter',e2.join()==='enter');
// задержка: 5 с
const st3={}, e3=[]; const s3=(lat,t)=>e3.push(...K.gfStep(st3,[home],lat,37.62,t*1000,{dwell:5}).events.map(e=>e.ev));
s3(55.80,0); s3(55.75,1); s3(55.75,3); ok('dwell: not yet',e3.length===0); s3(55.75,6.5); ok('dwell: after 5 s',e3.join()==='enter');
s3(55.80,7); s3(55.75,8); s3(55.80,9); ok('dwell: a short excursion cancels itself',e3.length===1);
// точность
const st4={}; ok('inaccurate fixes are skipped',K.gfStep(st4,[home],55.75,37.62,0,{accMax:30,acc:80}).skipped===true && K.gfStep(st4,[home],55.75,37.62,0,{accMax:30,acc:10}).skipped===undefined);
// first
const st5={}; ok('first:true reports a zone you start in',K.gfStep(st5,[home],55.75,37.62,0,{first:true}).events[0].ev==='enter');
// несколько зон и ближайшая
const st6={}; const r6=K.gfStep(st6,[home,park],55.75,37.62,0); ok('inside several zones, nearest',r6.inside.length===2 && r6.nearest!==null && r6.dist<0);
const r7=K.gfStep(st6,[park],55.75,37.62,1); ok('removed zones are forgotten',st6.z.size===1);
const sh=K.gfShapes(z.zones,['Home']); ok('shapes for the map: circle radius, polygon geom, colour by state',sh[0].gtype==='circle' && sh[0].radius===200 && sh[0].color==='#ff4040' && sh[1].gtype==='polygon' && JSON.parse(sh[1].geom).length===4 && sh[1].color==='#ffb400' && sh[0].label.includes('●'));
console.log(bad?bad+' FAILED':'all ok'); process.exit(bad?1:0);
