// Проверка плана и слои: node tools/test-plancheck.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float64Array,Float32Array,Set,Map,Number,String,JSON,isFinite,Infinity,Array,Object,RegExp});
const src=['modules/planedit-kernels.js','modules/hvac-kernels.js','modules/plancheck-kernels.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n');
vm.runInContext(src+';this.K={peNew,peAddPoint,peAddWall,peAddRoom,peAddObj,peAddEl,peAddWire,hvAdd,hvLink,pcCheck,pcShow,pcHvSys,PC_SHOW};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
function box(s,x0,y0,w,h,name,o={}){ const P=[[x0,y0],[x0+w,y0],[x0+w,y0+h],[x0,y0+h]].map(q=>K.peAddPoint(s,q[0],q[1])); const ids=P.map(p=>p.id);
  const ws=ids.map((a,i)=>K.peAddWall(s,a,ids[(i+1)%4],{t:.4,h:2.7,mat:'brick',...o})); return {ids,ws,room:K.peAddRoom(s,ids,name)}; }
const has=(L,re,kind)=>L.some(q=>re.test(q.msg)&&(!kind||q.kind===kind));

let s=K.peNew(); const A=box(s,0,0,5,4,'Liv'); K.peAddObj(s,'window',{wall:A.ws[0].id,u:.5,w:1.5,h:1.4,sill:.9}); K.peAddObj(s,'door',{wall:A.ws[1].id,u:.5,w:.9,h:2.05,sill:0});
K.peAddEl(s,'socket',1,1); K.peAddEl(s,'light',2,2); K.hvAdd(s,'radiator',2.5,.3);
ok('a clean house has no problems',K.pcCheck(s).length===0,JSON.stringify(K.pcCheck(s)));

{ const q=K.peNew(); const a=box(q,0,0,5,4,'Liv'); K.peAddObj(q,'window',{wall:a.ws[0].id,u:.5,w:6,h:1.4,sill:.9}); ok('a window wider than the wall',has(K.pcCheck(q),/wider than its wall/,'obj')); }
{ const q=K.peNew(); const a=box(q,0,0,5,4,'Liv'); K.peAddObj(q,'window',{wall:a.ws[0].id,u:.3,w:1.5,h:1.4,sill:.9}); K.peAddObj(q,'door',{wall:a.ws[0].id,u:.4,w:.9,h:2.05,sill:0}); ok('two openings on top of each other',has(K.pcCheck(q),/overlaps/,'obj')); }
{ const q=K.peNew(); const a=box(q,0,0,5,4,'Liv'); K.peAddObj(q,'window',{wall:a.ws[0].id,u:.5,w:1,h:2,sill:1.5}); ok('a window above the wall',has(K.pcCheck(q),/taller than the wall/)); }
{ const q=K.peNew(); const a=box(q,0,0,5,4,'Liv'); a.ws[0].t=0; a.ws[1].h=0; const L=K.pcCheck(q); ok('zero thickness / height',has(L,/strange thickness/,'wall')&&has(L,/without height/,'wall')); }
{ const q=K.peNew(); const a=box(q,0,0,5,4,'Liv'); const p1=K.peAddPoint(q,1,0), p2=K.peAddPoint(q,3,0); K.peAddWall(q,p1.id,p2.id); ok('a wall lying on another wall',has(K.pcCheck(q),/on top of each other/,'wall')); }
{ const q=K.peNew(); const P=[[0,0],[4,4],[4,0],[0,4]].map(p=>K.peAddPoint(q,p[0],p[1]).id); K.peAddRoom(q,P,'Bow'); ok('a self-crossing outline',has(K.pcCheck(q),/crosses itself/,'room')); }
{ const q=K.peNew(); box(q,0,0,5,4,'A'); box(q,3,1,5,4,'B',{}); ok('overlapping rooms',has(K.pcCheck(q),/overlap/,'room')); }
{ const q=K.peNew(); box(q,0,0,5,4,'A'); box(q,5,0,4,4,'B'); ok('rooms side by side are fine',!has(K.pcCheck(q),/overlap/)); }
{ const q=K.peNew(); const P=[[0,0],[5,0],[5,4],[0,4]].map(p=>K.peAddPoint(q,p[0],p[1]).id); K.peAddWall(q,P[0],P[1]); K.peAddWall(q,P[1],P[2]); K.peAddWall(q,P[2],P[3]); const r=K.peAddRoom(q,P,'Open'); r.free=true; ok('a room side without a wall',has(K.pcCheck(q),/without a wall/,'room')); }
{ const q=K.peNew(); box(q,0,0,5,4,'Liv'); const e=K.peAddEl(q,'socket',20,20); ok('a device outside the rooms',has(K.pcCheck(q),/outside any room/,'el')); e.x=1; e.y=1; e.z=5; ok('a device above the ceiling',has(K.pcCheck(q),/outside the floor and ceiling/,'el'));
  e.z=.3; const f=K.peAddEl(q,'socket',2,2); f.name=e.name; ok('the same name twice',has(K.pcCheck(q),/used twice/));
  const h=K.hvAdd(q,'boiler',30,30); ok('a boiler outside the rooms',has(K.pcCheck(q),/outside any room/,'hv')); }
{ const q=K.peNew(); const a=K.peAddEl(q,'panel',0,0), b=K.peAddEl(q,'socket',1,0); const w=K.peAddWire(q,a.id,b.id); q.elec=q.elec.filter(e=>e.id!==b.id); ok('a wire without an end',has(K.pcCheck(q),/wire without an end/,'wire')); }
{ const q=K.peNew(); const a=K.hvAdd(q,'boiler',1,1), b=K.hvAdd(q,'radiator',2,2); K.hvLink(q,a.id,b.id); q.hv=q.hv.filter(d=>d.id!==b.id); ok('a pipe without an end',has(K.pcCheck(q),/pipe \/ duct without an end/,'pp')); }
ok('no rooms at all: devices are not checked',K.pcCheck((()=>{ const q=K.peNew(); K.peAddEl(q,'socket',9,9); return q; })()).length===0);
{ const q=K.peNew(); box(q,0,0,5,4,'Liv'); K.peAddEl(q,'socket',2.5,-.05); K.peAddEl(q,'socket',2.5,.1); ok('a socket on the wall plane is not outside the room',K.pcCheck(q).length===0,JSON.stringify(K.pcCheck(q)));
  const o=K.peAddObj(q,'column',{x:0,y:2,w:.05,d:.05,h:.5,name:'stake'}); ok('fence stakes on a cord wall are not reported',!K.pcCheck(q).some(z=>/goes through/.test(z.msg))); }
// слои
ok('layers: all shows everything, one shows only itself',K.pcShow('all','electrics') && K.pcShow('electrics','electrics') && !K.pcShow('heating','electrics') && K.pcShow(undefined,'radio'));
ok('heat devices vs air devices',K.pcHvSys('radiator')==='heating' && K.pcHvSys('heater')==='heating' && K.pcHvSys('ahu')==='ventilation' && K.pcHvSys('extract')==='ventilation');
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
