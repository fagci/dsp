// Ядро Video Overlay: node tools/test-overlay.mjs
// Солнце / Луна — по примерам Meeus «Astronomical Algorithms» (25.a, 47.a); рельеф и OSM — синтетические данные.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,isFinite,parseFloat,isNaN,Infinity});
vm.runInContext(fs.readFileSync(path.join(root,'modules/overlay-kernels.js'),'utf8')+
  ';this.K={ovkSunEcl,ovkMoonEcl,ovkEclToEq,ovkAzEl,ovkSkyBodies,ovkPlanets,ovkPrecess,ovkSkyObjects,ovkLosBuild,ovkVisible,ovkOsmQuery,ovkOsmParse,ovkPosePush,ovkPoseAt,ovkTrailPush,ovkWrap,ovkNorm,ovkSunVec,ovkDayK,ovkLit,ovkShadowed,OVK_RING0,OVK_RING_K};',ctx);
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

// Венера, 1992-12-20 0h TD (Meeus 33.a): α = 316.17°, δ = −18.89°, Δ = 0.91085 а.е.
T=(2448976.5-2451545)/36525;
const ven=K.ovkPlanets(T).find(x=>x.id==='venus');
near('venus α',ven.ra,316.17,0.3); near('venus δ',ven.dec,-18.89,0.3); near('venus Δ',ven.dist,0.91085,0.01);
ok('venus bright',ven.mag<-3.5 && ven.mag>-4.9,String(ven.mag));
// Юпитер, 2026-01-10 — противостояние: ярче −2.5, рядом с Близнецами (α ≈ 7.4ч, δ ≈ +22°)
const jup=K.ovkPlanets((2461050.5-2451545)/36525).find(x=>x.id==='jupiter');
near('jupiter α',jup.ra/15,7.4,0.2); near('jupiter δ',jup.dec,22.5,1.5); ok('jupiter bright',jup.mag<-2.3,String(jup.mag));
// прецессия: Полярная в 2026 — α ≈ 3.2ч, δ ≈ 89.37°
const pol=K.ovkPrecess(2.5303*15,89.2641,0.26);
near('polaris δ 2026',pol.dec,89.37,0.03);
// Сириус в Новосибирске: кульминация в январе, угол места = 90 − 55 − 16.7 ≈ 18.3°
let best=-99;
for(let m=0;m<1440;m+=5){ const o=K.ovkSkyObjects(Date.UTC(2026,0,10,0,m),55,82.9,{starMag:0}).find(x=>x.id==='sirius'); best=Math.max(best,o.el); }
near('sirius culmination',best,18.3,0.5);
const all=K.ovkSkyObjects(Date.UTC(2026,0,10,12,0),55,82.9,{planets:true,starMag:2.5,deep:true});
ok('objects count',all.length>=7+30,String(all.length));

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
// Солнце для света и теней: направление, день/ночь, освещённость, тень от рельефа
const sv=K.ovkSunVec(90,0); near('sun vector east on the horizon',sv[0],1,1e-9); near('sun vector zenith',K.ovkSunVec(0,90)[2],1,1e-9);
near('day factor night',K.ovkDayK(-10),0,0); near('day factor noon',K.ovkDayK(40),1,0); near('day factor twilight',K.ovkDayK(0),.5,1e-9);
const up=[0,0,1], s45=K.ovkSunVec(180,45);
near('lit: flat ground',K.ovkLit(up,s45,45),.8,1e-9); ok('lit: night is dark',K.ovkLit(up,K.ovkSunVec(0,-10),-10)===0);
const tilt=[Math.sin(.3)*Math.sin(Math.PI),-Math.sin(.3),Math.cos(.3)];                 // склон, повёрнутый к Солнцу (юг, наклон на юг)
ok('lit: slope towards the Sun is brighter than flat',K.ovkLit([0,-Math.sin(.3),Math.cos(.3)],s45,45)>K.ovkLit(up,s45,45));
ok('lit: slope away is darker than flat',K.ovkLit([0,Math.sin(.3),Math.cos(.3)],s45,45)<K.ovkLit(up,s45,45));
ok('lit: steep wall away from the Sun is dark',K.ovkLit([0,.99,.1],s45,45)<.05);
const wall=(la,lo)=>(lo>0.0045 ? 200 : 0);                                              // стена 200 м в ~500 м к востоку
ok('shadow: low Sun behind the wall',K.ovkShadowed(wall,0,0,0,90,10,3000)===true);
ok('shadow: high Sun clears the wall',K.ovkShadowed(wall,0,0,0,90,30,3000)===false);
ok('shadow: Sun on the other side',K.ovkShadowed(wall,0,0,0,270,10,3000)===false);
ok('shadow: Sun at the horizon is handled by the light, not the ray',K.ovkShadowed(wall,0,0,0,90,1,3000)===false);
ok('shadow: point above the wall is lit',K.ovkShadowed(wall,0,0,300,90,10,3000)===false);
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad?1:0);
