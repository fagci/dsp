// Мастер «новый дом»: node tools/test-wizard.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float64Array,Float32Array,Set,Map,Number,String,JSON,isFinite,Infinity,Array,Object,RegExp});
const src=['modules/planedit-kernels.js','modules/hvac-kernels.js','modules/fence-kernels.js','modules/plancheck-kernels.js','modules/plansheet-kernels.js','modules/loads-kernels.js','modules/housewizard-kernels.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n');
vm.runInContext(src+';this.K={peBuildHouse,PW_LAYOUTS,PW_ROOFS,pcCheck,hvCalc,ldCalc,pcSheet,peRoomArea,peWall,peWallLen,peParse,pwSides};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b+' (±'+e+')');

for(const lay of Object.keys(K.PW_LAYOUTS)){
  const s=K.peBuildHouse({w:10,d:8,layout:lay,floors:1,roof:'gable'}), n=K.PW_LAYOUTS[lay], A=s.rooms.reduce((q,r)=>q+K.peRoomArea(s,r),0);
  ok('«'+lay+'»: '+n+' room(s), the areas add up to the house (80 m²)',s.rooms.length===n && Math.abs(A-80)<1e-6,s.rooms.length+' '+A);
  const C=K.pcCheck(s); ok('«'+lay+'»: the plan check is clean',C.length===0,JSON.stringify(C));
  // двери: каждая комната достижима из гостиной
  const doors=s.objs.filter(o=>o.type==='door'); ok('«'+lay+'»: an entrance and enough doors ('+doors.length+') for '+n+' rooms',doors.length>=n,doors.length);
  ok('«'+lay+'»: windows on the outer walls',s.objs.filter(o=>o.type==='window').length>=Math.min(2,n+1)); }
// дверной граф
{ const s=K.peBuildHouse({w:12,d:9,layout:'four rooms',floors:1,roof:'none'}); const adj=new Map(s.rooms.map(r=>[r.id,new Set()]));
  const rm=(w,sg)=>{ const [a,b]=[s.pts.find(p=>p.id===w.a),s.pts.find(p=>p.id===w.b)], L=Math.hypot(b.x-a.x,b.y-a.y), ux=(b.x-a.x)/L, uy=(b.y-a.y)/L, mx=(a.x+b.x)/2, my=(a.y+b.y)/2, off=(w.t||.2)/2+.15; return s.rooms.find(r=>{ const P=r.pts.map(id=>s.pts.find(p=>p.id===id)); let c=false; for(let i=0,j=P.length-1;i<P.length;j=i++){ const x=mx-uy*off*sg, y=my+ux*off*sg; if((P[i].y>y)!==(P[j].y>y) && x<(P[j].x-P[i].x)*(y-P[i].y)/(P[j].y-P[i].y)+P[i].x) c=!c; } return c; }); };
  for(const o of s.objs.filter(o=>o.type==='door')){ const w=K.peWall(s,o.wall), A=rm(w,1), B=rm(w,-1); if(A&&B){ adj.get(A.id).add(B.id); adj.get(B.id).add(A.id); } }
  const seen=new Set([s.rooms[0].id]), q=[s.rooms[0].id]; while(q.length){ for(const x of adj.get(q.shift())) if(!seen.has(x)){ seen.add(x); q.push(x); } }
  ok('every room can be reached from the living room through doors',seen.size===s.rooms.length,seen.size+' of '+s.rooms.length); }
// этажи
{ const s=K.peBuildHouse({w:10,d:8,layout:'three',floors:2,roof:'gable'});
  ok('two floors: 6 rooms, the upper ones are bedrooms / a bath, levels and a slab',s.rooms.length===6 && s.levels.length===2 && s.slabs.length===1 && s.rooms.filter(r=>r.lv===1).some(r=>r.use==='bedroom') && s.rooms.filter(r=>r.lv===1).some(r=>/Bath/.test(r.name)),JSON.stringify(s.rooms.map(r=>r.name+'@'+(r.lv||0))));
  { const outerDoors=lv=>s.objs.filter(o=>o.type==='door').filter(o=>{ const w=K.peWall(s,o.wall); if((w.lv||0)!==lv) return false; const [A,B]=K.pwSides(s,w,lv); return !!A!==!!B; }).length; ok('the entrance door is only on the ground floor (1 and 0)',outerDoors(0)===1 && outerDoors(1)===0,outerDoors(0)+' '+outerDoors(1)); }
  ok('two floors pass the plan check',K.pcCheck(s).length===0,JSON.stringify(K.pcCheck(s)));
  const t=K.peBuildHouse({w:10,d:8,floors:3,roof:'none'}); ok('three floors: 3 levels, 2 slabs',t.levels.length===3 && t.slabs.length===2 && t.roofs.length===0); }
// кровля
for(const [type,faces] of [['gable',4],['hip',4],['shed',3]]){ const s=K.peBuildHouse({w:10,d:8,layout:'one room',roof:type,angle:30,over:.5}); ok(type+' roof: '+faces+' faces, an area',s.roofs.length===1 && s.roofs[0].faces.length===faces && s.roofs[0].area>80 && s.roofs[0].type===type,JSON.stringify(s.roofs[0]&&s.roofs[0].area)); }
{ const s=K.peBuildHouse({w:10,d:8,layout:'one room',roof:'gable',angle:30,over:.5}); near('gable: two slopes, each (10 + 1) × (4 + 0.5) / cos 30°',s.roofs[0].area,2*11*4.5/Math.cos(Math.PI/6),.05);
  const t=K.peBuildHouse({w:8,d:10,layout:'one room',roof:'gable',angle:30,over:.5}); near('the ridge goes along the longer side whatever the orientation',t.roofs[0].area,s.roofs[0].area,.05);
  near('the eaves are lowered by the overhang: 2.7 − 0.5 tan 30°',s.roofs[0].eave,2.7-.5*Math.tan(Math.PI/6),1e-9); near('the ridge: 2.7 + 4 tan 30°',s.roofs[0].ridge,2.7+4*Math.tan(Math.PI/6),1e-9); }
// расчёты читают построенный дом
{ const s=K.peBuildHouse({w:10,d:8,layout:'three',floors:2,roof:'gable',mat:'brick',t:.4}), H=K.hvCalc(s,{tout:-25}), L=K.ldCalc(s,{snow:2});
  ok('the climate calculation sees every room',H.rooms.length===6 && H.house.loss>0); ok('the loads calculation: bearing walls, a roof, no «no roof» warning, the slab bears on walls',L.walls.length>=8 && L.house.roofS>0 && !L.warns.some(w=>/no roof|bears on no bearing/.test(w)),JSON.stringify(L.warns));
  ok('and the sheet is drawn',K.pcSheet(s,{paper:'A3'}).includes('Room explication')); }
// параметры
{ const s=K.peBuildHouse({w:10,d:8,layout:'two rooms',mat:'block',t:.3,h:2.5,roof:'none'}); ok('material, thickness and height are taken',s.walls.every(w=>w.mat==='block' && w.t===.3 && w.h===2.5)); }
{ const s=K.peBuildHouse({w:1,d:200,floors:9}); ok('the size is limited: 3…60 m, up to 4 floors',s.levels.length===4 && s.pts.length>0 && Math.max(...s.pts.map(p=>p.y))<=60); }
ok('the scene survives a save and a load',(()=>{ const s=K.peBuildHouse({w:10,d:8,floors:2}); const r=K.peParse(JSON.stringify(s)); return r.rooms.length===s.rooms.length && r.roofs.length===1 && r.slabs.length===1; })());
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
