// Проверка плана и слои: node tools/test-plancheck.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float64Array,Float32Array,Set,Map,Number,String,JSON,isFinite,Infinity,Array,Object,RegExp});
const src=['modules/planedit-kernels.js','modules/hvac-kernels.js','modules/plancheck-kernels.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n');
vm.runInContext(src+';this.K={peNew,peAddPoint,peAddWall,peAddRoom,peAddObj,peAddEl,peAddWire,hvAdd,hvLink,pcCheck,pcShow,pcHvSys,PC_SHOW,peAddPolyRoom,peAddRectRoom,peSplitWall,peAddObj,peRoomRect,peRoomResize,peNextRoomPos,peRoomArea,peWallLen,peSetLen,peLock};',ctx);
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
// быстрые комнаты
{ const q=K.peNew(); const a=K.peAddRectRoom(q,0,0,5,4,{t:.3,h:2.6,mat:'block'}); ok('a rect room: 4 points, 4 walls, 20 m², the wall defaults taken',q.pts.length===4 && q.walls.length===4 && Math.abs(K.peRoomArea(q,a.room)-20)<1e-9 && q.walls.every(w=>w.t===.3&&w.h===2.6&&w.mat==='block'));
  ok('a clean quick room passes the check',K.pcCheck(q).length===0,JSON.stringify(K.pcCheck(q)));
  ok('the same room twice is refused',K.peAddRectRoom(q,0,0,5,4)===null && q.rooms.length===1);
  ok('a degenerate room is refused',K.peAddRectRoom(q,0,0,0,4)===null && K.peAddPolyRoom(q,[[0,0],[1,1]])===null);
  const at=K.peNextRoomPos(q,a.room), b=K.peAddRectRoom(q,at.x,0,4,4); ok('the next room goes right of the selected one and shares its wall (6 points, 7 walls)',at.x===5 && q.pts.length===6 && q.walls.length===7 && q.rooms.length===2,q.pts.length+' '+q.walls.length);
  ok('rooms side by side do not overlap',!K.pcCheck(q).some(z=>/overlap/.test(z.msg)));
  const R=K.peRoomRect(q,a.room); ok('rect detection',R && R.w===5 && R.h===4 && K.peRoomRect(q,b.room).w===4);
  ok('resize 6 × 3 succeeds: the area is 18',K.peRoomResize(q,a.room,6,3) && Math.abs(K.peRoomArea(q,a.room)-18)<1e-6);
  ok('the shared corners drag the neighbour: it becomes a trapezoid of 10.5 m²',Math.abs(K.peRoomArea(q,b.room)-10.5)<1e-6,K.peRoomArea(q,b.room));
  const R2=K.peRoomRect(q,a.room); ok('after the resize the room is 6 × 3',R2 && Math.abs(R2.w-6)<1e-6 && Math.abs(R2.h-3)<1e-6,JSON.stringify(R2)); }
{ const q=K.peNew(); K.peAddRectRoom(q,0,0,5,4); const r=K.peAddPolyRoom(q,[[5.03,0.02],[8,0],[8,3]]); ok('a corner within 5 cm reuses the existing point',r && q.pts.length===6 && r.pts[0]===q.pts[1].id);
  ok('a triangle is not a rectangle',K.peRoomRect(q,r.room)===null && K.peRoomResize(q,r.room,3,3)===false);
  const q2=K.peNew(), a=K.peAddRectRoom(q2,0,0,4,4); a.walls[0].len=0; K.peLock(q2,a.walls[3].id,4); K.peRoomResize(q2,a.room,6,4); ok('a locked wall length is kept while resizing',Math.abs(K.peWallLen(q2,a.walls[3])-4)<1e-3,K.peWallLen(q2,a.walls[3])); }
{ const q=K.peNew(); ok('an empty plan starts at 0, 0',JSON.stringify(K.peNextRoomPos(q,null))==='{"x":0,"y":0}'); K.peAddRectRoom(q,2,1,3,3); ok('no room selected: right of the whole plan',K.peNextRoomPos(q,null).x===5 && K.peNextRoomPos(q,null).y===1); }
// стык с более длинной стеной: стена режется, наложений нет
{ const q=K.peNew(); const A=K.peAddRectRoom(q,0,0,5,4); const w=A.walls[2]; const dr=K.peAddObj(q,'door',{wall:w.id,u:.9,w:.8,h:2,sill:0}), wn=K.peAddObj(q,'window',{wall:w.id,u:.2,w:1,h:1.2,sill:.9}); const C=K.peAddRectRoom(q,0,4,3,2.5);
  ok('a small room on a long wall: it splits (8 walls, 7 points + 1)',q.walls.length===8 && q.pts.length===7,q.walls.length+' '+q.pts.length);
  ok('no walls lie on top of each other',!K.pcCheck(q).some(z=>/on top of each other/.test(z.msg)),JSON.stringify(K.pcCheck(q)));
  ok('openings keep their place: the wall runs east→west: the window stays 1 m from the start (2 m half), the door moves to the 3 m half, 2.5 m from the split',wn.wall===w.id && Math.abs(wn.u*2-1)<1e-6 && dr.wall!==w.id && Math.abs(dr.u*3-2.5)<1e-6,JSON.stringify([wn,dr]));
  ok('the room A got the new corner on its side',A.room.pts.length===5); }
{ const q=K.peNew(); K.peAddRectRoom(q,0,0,3,4); const A=K.peAddRectRoom(q,0,4,5,4);
  ok('a big room over a small one takes its corner: 5 points, 8 walls, no overlap',A && A.pts.length===5 && q.walls.length===8 && !K.pcCheck(q).some(z=>/top of each other|overlap/.test(z.msg)),q.walls.length+' '+JSON.stringify(K.pcCheck(q))); }
// слои
ok('layers: all shows everything, one shows only itself',K.pcShow('all','electrics') && K.pcShow('electrics','electrics') && !K.pcShow('heating','electrics') && K.pcShow(undefined,'radio'));
ok('heat devices vs air devices',K.pcHvSys('radiator')==='heating' && K.pcHvSys('heater')==='heating' && K.pcHvSys('ahu')==='ventilation' && K.pcHvSys('extract')==='ventilation');
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
