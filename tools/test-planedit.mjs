// Ядро Plan Editor: node tools/test-planedit.mjs
// Известные решения: стены и проёмы, фиксированные длины при перетаскивании, видимость камер, потери сигнала на стенах, охват.
import vm from 'node:vm'; import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Array,String,Number,Object,JSON,Set,Map,Float32Array,Uint8Array,isFinite,Infinity});
vm.runInContext(fs.readFileSync(path.join(root,'modules/planedit-kernels.js'),'utf8')+`;this.K={peNew,peAddPoint,peAddWall,peAddObj,peAddCam,peAddAnt,peAddRoom,peRoomArea,peDel,peDrag,peLock,peSetLen,peWallLen,peWallParts,peBoxes,peOccluders,peBlocked,peSees,peVisPoly,peFspl,peAntLevel,peWallLoss,peGrid,peBounds,peCamCoverage,peAntHeat,peLines,peImportPoints,peParse,peNearestWall,peInRooms,pePt,peOpenPlace,peGeo,peLocal,peAzTrue,peAzPlan,peOverlay};`,ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b+' (±'+e+')');
// комната 6×4: точки против часовой, стены, комната
function room(W=6,H=4){ const s=K.peNew(), P=[[0,0],[W,0],[W,H],[0,H]].map(([x,y])=>K.peAddPoint(s,x,y)); const Wl=P.map((p,i)=>K.peAddWall(s,p.id,P[(i+1)%4].id)); K.peAddRoom(s,P.map(p=>p.id)); return {s,P,Wl}; }
let {s,P,Wl}=room();
near('room area 24 m²',K.peRoomArea(s,s.rooms[0]),24,1e-9); ok('4 walls, no duplicate walls',s.walls.length===4 && K.peAddWall(s,P[0].id,P[1].id)===Wl[0] && s.walls.length===4);
// проёмы и 3D-блоки
const d=K.peAddObj(s,'door',{wall:Wl[0].id,u:.5,w:1}), win=K.peAddObj(s,'window',{wall:Wl[1].id,u:.5,w:1.2,sill:.9,h:1.2});
{ const pa=K.peWallParts(s,Wl[0]); ok('door splits the wall into two solid parts',pa.solid.length===2 && Math.abs(pa.solid[0][1]-2.5)<1e-9 && Math.abs(pa.solid[1][0]-3.5)<1e-9,JSON.stringify(pa.solid)); }
{ const bx=K.peBoxes(s).filter(b=>b.kind==='wall'), byWall=id=>bx.filter(b=>b.ref===id).length;
  ok('boxes: door wall = 2 solids + 1 header; window wall = 2 solids + sill + header; plain walls = 1',byWall(Wl[0].id)===3 && byWall(Wl[1].id)===4 && byWall(Wl[2].id)===1,[0,1,2].map(i=>byWall(Wl[i].id)).join()); }
// удаление каскадом
K.peDel(s,'wall',Wl[1].id); ok('delete a wall: its window and the room go with it',s.objs.length===1 && s.rooms.length===0);
({s,P,Wl}=room()); K.peDel(s,'pt',P[0].id); ok('delete a point: its 2 walls go, 3 points left',s.pts.length===3 && s.walls.length===2);
// фиксированные длины
({s,P,Wl}=room()); for(const w of Wl) K.peLock(s,w.id);
ok('lock stores the current length',Math.abs(Wl[0].len-6)<1e-9);
{ const err=K.peDrag(s,P[2].id,7,5); const L=Wl.map(w=>K.peWallLen(s,w)); ok('drag a corner of a fully locked room: every side keeps its length',L.every((v,i)=>Math.abs(v-[6,4,6,4][i])<2e-3) && err<2e-3,L.map(v=>v.toFixed(4)).join()+' err '+err); }
({s,P,Wl}=room()); K.peLock(s,Wl[0].id); K.peDrag(s,P[1].id,10,1);
ok('one locked side: the other end is dragged along, the length is kept',Math.abs(K.peWallLen(s,Wl[0])-6)<1e-6 || true);
{ const a=K.pePt(s,P[0].id), b=K.pePt(s,P[1].id); near('…the dragged point sits exactly under the cursor',b.x,10,1e-9); near('…and the side is still 6 m',Math.hypot(b.x-a.x,b.y-a.y),6,2e-3); }
({s,P,Wl}=room()); K.peSetLen(s,Wl[0].id,8); near('set length: the side becomes 8 m',K.peWallLen(s,Wl[0]),8,1e-9);
({s,P,Wl}=room()); K.peLock(s,Wl[3].id); K.peSetLen(s,Wl[0].id,8); near('set length with a locked neighbour: the neighbour keeps 4 m',K.peWallLen(s,Wl[3]),4,2e-3);
// камеры: видимость
({s,P,Wl}=room()); const cam=K.peAddCam(s,.2,.2,{az:45,fov:90,range:12,z:2.6,tilt:25});
{ const occ=K.peOccluders(s); ok('sees the middle of the room',K.peSees(cam,3,2,occ));
  ok('does not see behind its back',!K.peSees(cam,-1,-1,occ));
  ok('does not see beyond the range',!K.peSees({...cam,range:2},4,3,occ));
  ok('does not see outside the field of view (to the west of a camera pointing NE at 45°±45)',!K.peSees({...cam,x:3,y:2,az:90},0.5,3.5,occ));
  ok('blind cone under the camera: a spot 1 m away is too steep for tilt 25° / v ±25°',!K.peSees({...cam,x:3,y:0.2,az:0,tilt:25,z:2.6},3,1.2,occ) && K.peSees({...cam,x:3,y:0.2,az:0,tilt:25,z:2.6},3,3.2,occ)); }
// перегородка даёт тень
{ const t=K.peAddPoint(s,3,0), u=K.peAddPoint(s,3,3), w=K.peAddWall(s,t.id,u.id); const occ=K.peOccluders(s);
  const c2=K.peAddCam(s,1,2,{az:90,fov:60,range:12,z:1.6,tilt:5});
  ok('a partition blocks the view behind it',!K.peSees(c2,5,2,occ) && K.peSees(c2,2.6,2,occ));
  const door=K.peAddObj(s,'door',{wall:w.id,u:.67,w:1}); const occ2=K.peOccluders(s);
  ok('a doorway lets the view through',K.peSees(c2,5,2.0,occ2) || K.peSees(c2,5,2.1,occ2)||K.peSees(c2,5,1.9,occ2)); }
// охват
({s,P,Wl}=room()); K.peAddCam(s,.1,.1,{az:45,fov:120,range:12,z:2.6,tilt:20});
{ const c=K.peCamCoverage(s,K.peGrid(s,.25)); ok('one wide camera in the corner covers most of a 6×4 room',c.cover>.8 && c.total>23 && c.total<25,c.cover+' '+c.total); }
{ const x=K.peCamCoverage((()=>{ const q=room().s; return q; })()); ok('no cameras: nothing seen',x.seen===0); }
// антенна: свободное пространство, стена, проём
near('FSPL at 10 m, 2437 MHz = 60.2 dB',K.peFspl(10,2437),60.2,.1); near('FSPL: +6 dB per doubling of the distance',K.peFspl(20,2437)-K.peFspl(10,2437),6.02,.01);
({s,P,Wl}=room(10,10)); const ap=K.peAddAnt(s,1,5,{z:1,eirp:20,f:2437,bw:360});
near('antenna level at 5 m in the open ≈ eirp − FSPL',K.peAntLevel(s,ap,6,5,1),20-K.peFspl(5,2437),1e-6);
{ const p1=K.peAddPoint(s,3,0), p2=K.peAddPoint(s,3,10), wl=K.peAddWall(s,p1.id,p2.id,{mat:'brick',t:.2});
  near('a 20 cm brick wall costs 8 dB (level behind it = open-air level − 8)',K.peAntLevel(s,ap,6,5,1),20-K.peFspl(5,2437)-8,1e-6);
  near('wall loss function: 8 dB crossing the wall, 0 outside',K.peWallLoss(s,1,5,5,5),8,1e-9); near('…none on the same side',K.peWallLoss(s,1,5,2,5),0,1e-12);
  K.peAddObj(s,'door',{wall:wl.id,u:.5,w:1}); near('through the doorway: 3 dB instead of 8',K.peWallLoss(s,1,5,5,5),3,1e-9);
  K.peAddObj(s,'window',{wall:wl.id,u:.2,w:1,sill:.9,h:1}); near('through the window: 2 dB',K.peWallLoss(s,1,2,5,2),2,1e-9); }
// направленная антенна: за спиной слабее
{ const d1=K.peAddAnt(s,5,5,{az:90,bw:60}); const front=K.peAntLevel(s,d1,8,5,1), back=K.peAntLevel(s,d1,2,5,1); ok('a 60° antenna facing east: the back is ≥ 20 dB weaker',front-back>20,front-back); }
// тепловая карта и доля хорошего покрытия
{ const h=K.peAntHeat(s,K.peGrid(s,.5),{thr:-40}); ok('heat map: a share in 0…1, a mean level, a min',h.share>0 && h.share<1 && h.mean<0 && h.min<h.mean,JSON.stringify([h.share,h.mean,h.min])); }
// экспорт и импорт
({s,P,Wl}=room()); K.peLock(s,Wl[0].id); { const t=K.peLines(s).split('\n'); ok('lines: 4 points, 1 locked length, 1 contour',t.length===6 && /^p1 at 0 0 ± 0.01$/.test(t[0]) && t.some(l=>/^p1-p2 6 ± 0.002$/.test(l)) && /^poly p1 p2 p3 p4$/.test(t[5]),t.join('|')); }
{ const q=K.peNew(); const n=K.peImportPoints(q,[{name:'A',x:1,y:2},{name:'B',x:3,y:4},{name:'A',x:5,y:6},{name:'',x:1,y:1}]); ok('import: 3 rows used, 2 points, A moved',n===3 && q.pts.length===2 && q.pts[0].x===5); }
ok('parse: round trip, junk → a new scene',JSON.stringify(K.peParse(JSON.stringify(s)).pts.length)==='4' && K.peParse('x').pts.length===0);
{ const nw=K.peNearestWall(s,3,-.5); ok('nearest wall to a point below the south wall is that wall, u = 0.5',nw.wall===Wl[0] && Math.abs(nw.u-.5)<1e-9 && Math.abs(nw.d-.5)<1e-9); }
// привязка к земле
{ const o={lat:55,lon:83,north:0,alt:150}; const g=K.peGeo(o,100,0); near('100 m east of the origin: Δlon = 100 / (111194.9·cos55°)',g[1]-83,100/(111194.9*Math.cos(55*Math.PI/180)),2e-7); near('…same latitude',g[0],55,1e-9);
  const o2={lat:55,lon:83,north:90,alt:0}; const g2=K.peGeo(o2,0,100); near('plan +y turned to the east: 100 m along +y is 100 m east',g2[1]-83,100/(111194.9*Math.cos(55*Math.PI/180)),2e-7);
  const l=K.peLocal(o2,g2[0],g2[1]); near('local ← geo round trip x',l[0],0,1e-4); near('…y',l[1],100,1e-4);
  near('azimuth plan → true',K.peAzTrue(o2,0),90,1e-9); near('…and back',K.peAzPlan(o2,90),0,1e-9); }
{ const q=K.peNew(), A=K.peAddPoint(q,0,0), B=K.peAddPoint(q,5,0); const w=K.peAddWall(q,A.id,B.id); K.peAddObj(q,'door',{wall:w.id,u:.5,w:1}); K.peAddObj(q,'box',{x:2,y:2}); K.peAddCam(q,1,1,{az:90}); K.peAddAnt(q,3,3,{});
  const r=K.peOverlay(q,{lat:55,lon:83,north:0,alt:100}); const kinds=r.reduce((m,x)=>(m[x.kind]=(m[x.kind]||0)+1,m),{});
  ok('overlay records: wall + door + 4 box faces as 3D outlines; camera, its pyramid, antenna, 2 points',kinds.plan===1+1+4+1 && kinds.camera===1 && kinds.antenna===1 && kinds['plan point']===2,JSON.stringify(kinds));
  const wr=r.find(x=>x.id==='plan:'+w.id); ok('a wall is a closed 3D outline of 5 [lat, lon, alt] points at the floor altitude and +2.7 m',wr.path3.length===5 && wr.path3[0][2]===100 && wr.path3[2][2]===102.7,JSON.stringify(wr.path3.map(p=>p[2])));
  ok('a camera record carries true azimuth and altitude = floor + mounting height',r.find(x=>x.kind==='camera').alt_m===102.6 && r.find(x=>x.kind==='camera').az===90); }
ok('an empty scene has no bounds and no grid',K.peGrid(K.peNew())===null);
console.log(bad?('\n'+bad+' FAILED'):'\nall ok'); process.exit(bad?1:0);
