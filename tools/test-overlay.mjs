// Ядро Video Overlay: node tools/test-overlay.mjs
// Солнце / Луна — по примерам Meeus «Astronomical Algorithms» (25.a, 47.a); рельеф и OSM — синтетические данные.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,isFinite,parseFloat,isNaN,Infinity});
vm.runInContext(fs.readFileSync(path.join(root,'modules/overlay-kernels.js'),'utf8')+
  ';this.K={ovkSunEcl,ovkMoonEcl,ovkEclToEq,ovkAzEl,ovkSkyBodies,ovkLosBuild,ovkVisible,ovkOsmQuery,ovkOsmParse,ovkPosePush,ovkPoseAt,ovkTrailPush,ovkWrap,ovkNorm,OVK_RING0,OVK_RING_K};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b+' (±'+e+')');

// Солнце, 1992-10-13 0h TD (JD 2448908.5): λ = 199.90895°, α = 198.38083°, δ = −7.78507°
let T=(2448908.5-2451545)/36525;
const s=K.ovkSunEcl(T), se=K.ovkEclToEq(s.lon,0,T);
near('sun λ',s.lon,199.90895,0.02); near('sun α',se.ra,198.38083,0.03); near('sun δ',se.dec,-7.78507,0.03);
// Луна, 1992-04-12 0h TD (JD 2448724.5): λ = 133.162655°, β = −3.229126°, Δ = 368409.7 км
T=(2448724.5-2451545)/36525;
const m=K.ovkMoonEcl(T);
near('moon λ',m.lon,133.162655,0.3); near('moon β',m.lat,-3.229126,0.3); near('moon Δ',m.dist,368409.7,2500);
// Солнце в полдень на экваторе у солнцестояния: угол места ≈ 90 − 23.44, азимут — север
const b=K.ovkSkyBodies(Date.UTC(2000,5,21,12,2,0),0,0);
near('sun noon el',b.sun.el,66.56,0.4); ok('sun noon az ~ north',Math.min(b.sun.az,360-b.sun.az)<4,String(b.sun.az));
// ночью в Новосибирске (55, 82.9) зимой Солнце под горизонтом, диски разумных размеров
const n2=K.ovkSkyBodies(Date.UTC(2026,0,10,20,0,0),55,82.9);
ok('sun below at night',n2.sun.el<-10,String(n2.sun.el)); near('moon size',n2.moon.size,0.52,0.06);
ok('moon frac in 0…1',n2.moon.frac>=0&&n2.moon.frac<=1);
// полнолуние: 2026-01-03 ~10:03 UTC → доля ≈ 1, Луна напротив Солнца
const fm=K.ovkSkyBodies(Date.UTC(2026,0,3,10,3,0),0,0);
ok('full moon frac',fm.moon.frac>0.99,String(fm.moon.frac));

// видимость: хребет 1000 м на севере (азимут 0) в ~10 км
const NA=180, rings=[], R=6371000;
for(let d=K.OVK_RING0; d<=50000; d*=K.OVK_RING_K){
  const a=new Float32Array(NA*4);
  for(let i=0;i<NA;i++){ const th=i*2*Math.PI/180; let u=-d*d/(2*R); if(i===0 && d>9000 && d<11000) u+=1000;
    a[i*4]=d*Math.sin(th); a[i*4+1]=d*Math.cos(th); a[i*4+2]=u; a[i*4+3]=0; }
  rings.push(a);
}
const los=K.ovkLosBuild(rings,NA);
ok('behind ridge → hidden',!K.ovkVisible(los,0,30000,500));
ok('high plane → visible',K.ovkVisible(los,0,30000,5000));
ok('other azimuth → visible',K.ovkVisible(los,30000,0,500));
ok('before ridge → visible',K.ovkVisible(los,0,5000,100));
ok('near ring → visible',K.ovkVisible(los,0,100,0));
ok('ridge shadow covers neighbouring azimuth (±1 cell)',!K.ovkVisible(los,Math.sin(1.5*Math.PI/180)*30000,Math.cos(1.5*Math.PI/180)*30000,500));

// OSM
const q=K.ovkOsmQuery(55.01,82.65,25000);
ok('query',q.includes('around:25000,55.01000,82.65000') && q.includes('natural"="peak') && q.includes('waterway'),q);
const osm=K.ovkOsmParse({elements:[
  {type:'node',lat:55.1,lon:82.7,tags:{natural:'peak',name:'Low',ele:'300'}},
  {type:'node',lat:55.2,lon:82.8,tags:{natural:'peak',name:'High',ele:'1200'}},
  {type:'node',lat:55.0,lon:82.9,tags:{place:'village',name:'V'}},
  {type:'node',lat:55.0,lon:83.0,tags:{place:'city',name:'C'}},
  {type:'way',tags:{highway:'primary',ref:'M51'},geometry:[{lat:55,lon:82},{lat:55.0001,lon:82.0001},{lat:55.01,lon:82.01},{lat:55.02,lon:82.02}]},
  {type:'way',tags:{highway:'motorway'},geometry:[{lat:55,lon:82},{lat:55.1,lon:82.1}]},
  {type:'way',tags:{waterway:'river',name:'Ob'},geometry:[{lat:55,lon:82},{lat:55.05,lon:82.05}]},
  {type:'way',tags:{highway:'residential'},geometry:[{lat:55,lon:82},{lat:55.05,lon:82.05}]},
]});
ok('peaks sorted by ele',osm.peaks[0].name==='High' && osm.peaks[0].ele===1200);
ok('places: city first',osm.places[0].kind==='city');
ok('roads: motorway first, minor dropped',osm.roads.length===2 && osm.roads[0].kind==='motorway');
ok('simplify drops close points',osm.roads[1].pts.length===3,JSON.stringify(osm.roads[1].pts));
ok('river',osm.rivers.length===1 && osm.rivers[0].name==='Ob');

// поза: интерполяция через 0°
const buf=[]; K.ovkPosePush(buf,1000,350,0,-170); K.ovkPosePush(buf,1100,10,10,170);
const pm=K.ovkPoseAt(buf,1050);
near('pose az across north',K.ovkWrap(pm.az),0,0.01); near('pose el',pm.el,5,0.01); near('pose roll across 180',Math.abs(K.ovkWrap(pm.roll)),180,0.01);
ok('pose clamp after',K.ovkPoseAt(buf,5000).az===10); ok('pose clamp before',K.ovkPoseAt(buf,0).az===350);
K.ovkPosePush(buf,1102,0,0,0); ok('pose throttle',buf.length===2);
K.ovkPosePush(buf,9000,0,0,0); ok('pose trims old',buf.length===1);
// след
const tr=[]; K.ovkTrailPush(tr,55,82,0,0,60000); K.ovkTrailPush(tr,55.00001,82,0,1000,60000); K.ovkTrailPush(tr,55.01,82,0,2000,60000);
ok('trail: skip near, keep far',tr.length===2);
K.ovkTrailPush(tr,55.02,82,0,90000,60000); ok('trail: old dropped',tr.length===1);
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad?1:0);
