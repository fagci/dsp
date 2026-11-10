// Проверка плана и слои: node tools/test-plancheck.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float64Array,Float32Array,Set,Map,Number,String,JSON,isFinite,Infinity,Array,Object,RegExp});
const src=['modules/planedit-kernels.js','modules/hvac-kernels.js','modules/plancheck-kernels.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n');
vm.runInContext(src+';this.K={peNew,peAddPoint,peAddWall,peAddRoom,peAddObj,peAddEl,peAddWire,hvAdd,hvLink,pcCheck,pcShow,pcHvSys,PC_SHOW,peAddPolyRoom,peAddRectRoom,peSplitWall,peAddObj,peImportPoints,peDetach,pePt,peEnsureLevel,peCopyLevel,peOnLevel,peLevelRange,peAddWall,hvRoomZ,peRoomRect,peRoomResize,peNextRoomPos,peRoomArea,peWallLen,peSetLen,peLock};',ctx);
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
// этажи
{ const q=K.peNew(); const A=K.peAddRectRoom(q,0,0,5,4); K.peAddObj(q,'door',{wall:A.walls[1].id,u:.5,w:.9,h:2,sill:0}); A.room.use='bedroom'; A.room.name='Спальня';
  const L1=K.peEnsureLevel(q,1); ok('a floor above: ground made too, z = 2.7 + 0.25',q.levels.length===2 && q.levels[0].idx===0 && Math.abs(L1.z-2.95)<1e-9 && L1.name==='2',JSON.stringify(q.levels));
  const Lm=K.peEnsureLevel(q,-1); ok('a cellar below, 2.95 down',Math.abs(Lm.z+2.95)<1e-9 && Lm.name==='B1');
  const up=K.peAddRectRoom(q,0,0,5,4,{lv:1,z0:2.95}); ok('the same outline on another floor is a new room with its own walls',up && q.walls.length===8 && q.rooms.length===2 && up.room.lv===1 && up.room.z0===2.95 && up.walls.every(w=>w.lv===1&&w.z0===2.95));
  ok('floors do not trigger the overlap check',!K.pcCheck(q).some(z=>/overlap|top of each other/.test(z.msg)),JSON.stringify(K.pcCheck(q)));
  const c=K.peCopyLevel(q,0,2); ok('copy of the ground floor to floor 3: walls, door, room with its use',c && c.walls===4 && c.openings===1 && c.rooms===1 && q.rooms.find(r=>r.lv===2).use==='bedroom' && q.rooms.find(r=>r.lv===2).z0===q.levels.find(l=>l.idx===2).z,JSON.stringify(c));
  ok('an empty floor cannot be copied',K.peCopyLevel(q,3,4)===null);
  ok('the copy has its own points (moving the lower floor does not drag it)',new Set(q.walls.filter(w=>(w.lv||0)===2).flatMap(w=>[w.a,w.b])).size===4 && !q.walls.filter(w=>(w.lv||0)===2).some(w=>q.walls.some(v=>(v.lv||0)===0 && (v.a===w.a||v.b===w.a))));
  ok('hvac reads the room height from the floor: room z0 of floor 2',Math.abs(K.hvRoomZ(q,q.rooms.find(r=>r.lv===1))-2.95)<1e-9);
  ok('device on a floor: plan "all" shows the ground only, 3D all shows everything',K.peOnLevel(q,'all',.3,false) && !K.peOnLevel(q,'all',3.4,false) && K.peOnLevel(q,'all',3.4,true));
  ok('floor 1 in the plan: ground items hidden, its own shown; in 3D the floors below stay',!K.peOnLevel(q,'1',.3,false) && K.peOnLevel(q,'1',3.4,false) && K.peOnLevel(q,'1',.3,true) && !K.peOnLevel(q,'0',3.4,true));
  ok('cellar devices belong to the lowest level range',K.peOnLevel(q,'-1',-2.5,false) && !K.peOnLevel(q,'0',-2.5,false)); }
{ const q=K.peNew(); ok('no floors defined: everything is visible',K.peOnLevel(q,'1',5,false)); }
// отвязка от Site Plan
{ const q=K.peNew(); const rec=()=>({id:'sp:walls',kind:'plan walls',walls:[{id:'w1',x1:0,y1:0,x2:5,y2:0,t:.3,h:2.7,mat:'brick'},{id:'w2',x1:5,y1:0,x2:5,y2:4,t:.3,h:2.7,mat:'brick'}],opens:[{wall:'w1',u:.5,w:1,h:1.2,sill:.9,type:'window'}],elec:[{type:'socket',name:'S1',x:1,y:1,z:.3,watt:200}],hv:[{type:'radiator',name:'R1',x:2,y:1,z:.5,watt:1000}],pp:[],uses:[]});
  K.peImportPoints(q,[rec()]); const w1=q.walls.find(w=>w.src==='sp:walls|w1'), n0=q.walls.length;
  ok('detach a wall: it loses src, keeps det, its openings and end points go with it',K.peDetach(q,'wall',w1.id) && !w1.src && w1.det==='sp:walls|w1' && q.objs.every(o=>!o.src && o.det) && q.pts.filter(p=>p.src==='sp:walls|w1').length===0);
  const r2=rec(); r2.walls[0].x2=6; r2.opens[0].w=2; K.peImportPoints(q,[r2]);
  ok('a re-import does not touch the detached wall, make a copy of it, nor change its window',q.walls.length===n0 && q.pts.find(p=>p.id===w1.a).x===0 && q.objs.length===1 && q.objs[0].w===1,q.walls.length+' vs '+n0+' '+q.objs.length);
  ok('the other wall still follows the text',(()=>{ const r3=rec(); r3.walls[1].y2=7; K.peImportPoints(q,[r3]); const w=q.walls.find(w=>w.src==='sp:walls|w2'); return K.pePt(q,w.b).y===7; })());
  const s1=q.elec.find(e=>e.name==='S1'); ok('detach a device; a re-import with a moved device leaves it alone, no duplicate',K.peDetach(q,'el',s1.id) && (()=>{ const r3=rec(); r3.elec[0].x=9; K.peImportPoints(q,[r3]); return q.elec.length===1 && q.elec[0].x===1; })());
  const h1=q.hv.find(d=>d.name==='R1'); ok('the same for a heating device',K.peDetach(q,'hv',h1.id) && (()=>{ const r3=rec(); r3.hv[0].x=9; K.peImportPoints(q,[r3]); return q.hv.length===1 && q.hv[0].x===2; })());
  ok('a hand-drawn item cannot be detached',K.peDetach(q,'el',s1.id)===false); }
// слои
ok('layers: all shows everything, one shows only itself',K.pcShow('all','electrics') && K.pcShow('electrics','electrics') && !K.pcShow('heating','electrics') && K.pcShow(undefined,'radio'));
ok('heat devices vs air devices',K.pcHvSys('radiator')==='heating' && K.pcHvSys('heater')==='heating' && K.pcHvSys('ahu')==='ventilation' && K.pcHvSys('extract')==='ventilation');
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
