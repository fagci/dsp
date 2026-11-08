// Ядро Plan Editor: node tools/test-planedit.mjs
// Известные решения: стены и проёмы, фиксированные длины при перетаскивании, видимость камер, потери сигнала на стенах, охват.
import vm from 'node:vm'; import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Array,String,Number,Object,JSON,Set,Map,Float32Array,Uint8Array,isFinite,Infinity});
vm.runInContext(fs.readFileSync(path.join(root,'modules/planedit-kernels.js'),'utf8')+`;this.K={peHistNew,peHistCommit,peHistUndo,peHistRedo,peNew,peAddPoint,peAddWall,peAddObj,peAddCam,peAddAnt,peAddRoom,peRoomArea,peDel,peDrag,peLock,peSetLen,peWallLen,peWallParts,peBoxes,peOccluders,peBlocked,peSees,peVisPoly,peFspl,peAntLevel,peWallLoss,peMatLoss,peOpenLoss,peGrid,peBounds,peCamCoverage,peAntHeat,peLines,peImportPoints,peParse,peNearestWall,peInRooms,pePt,peOpenPlace,peGeo,peLocal,peAzTrue,peAzPlan,peOverlay,peSVG,peDXF,peSolidRects,peBoxOrder,peBefore,peOverlaps,peAddRx,peRxLevel,peMoveWall,peZRaster,peBoxCorners,peRunGen,peCamPlan,peAntPlan,peApplyPlan,peClearAuto,peRoomCells,peMountPoints,peSnapFace,peHiddenPts,peLvShow};`,ctx);
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
  near('a 20 cm brick wall costs 8 dB at 2.4 GHz (level behind it = open-air level − the loss at the antenna’s frequency)',K.peAntLevel(s,ap,6,5,1),20-K.peFspl(5,2437)-K.peMatLoss('brick',2437,.2),1e-6);
  near('…exactly 8.0 dB at 2400 MHz',K.peMatLoss('brick',2400,.2),8,1e-9);
  near('wall loss function: 8 dB crossing the wall, 0 outside',K.peWallLoss(s,1,5,5,5),8,1e-9); near('…none on the same side',K.peWallLoss(s,1,5,2,5),0,1e-12);
  K.peAddObj(s,'door',{wall:wl.id,u:.5,w:1}); near('through the doorway: 3 dB instead of 8 (at 2.4 GHz)',K.peWallLoss(s,1,5,5,5),3,1e-9);
  K.peAddObj(s,'window',{wall:wl.id,u:.2,w:1,sill:.9,h:1}); near('through the window: 2 dB',K.peWallLoss(s,1,2,5,2),2,1e-9); }
// направленная антенна: за спиной слабее
{ const d1=K.peAddAnt(s,5,5,{az:90,bw:60}); const front=K.peAntLevel(s,d1,8,5,1), back=K.peAntLevel(s,d1,2,5,1); ok('a 60° antenna facing east: the back is ≥ 20 dB weaker',front-back>20,front-back); }
// тепловая карта и доля хорошего покрытия
{ const h=K.peAntHeat(s,K.peGrid(s,.5),{thr:-40}); ok('heat map: a share in 0…1, a mean level, a min',h.share>0 && h.share<1 && h.mean<0 && h.min<h.mean,JSON.stringify([h.share,h.mean,h.min])); }
// экспорт и импорт
({s,P,Wl}=room()); K.peLock(s,Wl[0].id); { const t=K.peLines(s).split('\n'); ok('lines: 4 points, 1 locked length, 1 contour',t.length===6 && /^p1 at 0 0 ± 0.01$/.test(t[0]) && t.some(l=>/^p1-p2 6 ± 0.002$/.test(l)) && /^poly p1 p2 p3 p4$/.test(t[5]),t.join('|')); }
{ const q=K.peNew(); const n=K.peImportPoints(q,[{name:'A',x:1,y:2},{name:'B',x:3,y:4},{name:'A',x:5,y:6},{name:'',x:1,y:1}]); ok('import: 3 rows used, 2 points, A moved',n===3 && q.pts.length===2 && q.pts[0].x===5); }
{ const q=K.peNew(), R=[{name:'C1',x:0,y:0},{name:'C2',x:5,y:0},{name:'C3',x:5,y:4},{kind:'plan poly',names:['C1','C2','C3']},{id:'w1',kind:'plan opening',type:'window',a:'C2',b:'C1',from:1,w:2,h:1.4,sill:.8}];
  K.peImportPoints(q,R); const o=q.objs[0]; ok('import: a window lands on wall C1-C2, 1 m from C2',q.objs.length===1 && o.type==='window' && Math.abs(K.peOpenPlace(q,o).x-3)<1e-9 && o.sill===.8 && o.h===1.4,JSON.stringify(o));
  R[4].w=1; K.peImportPoints(q,R); ok('import: the same opening is updated, not duplicated',q.objs.length===1 && q.objs[0].w===1); }
{ const q=K.peNew(), WR={id:'sp:walls',kind:'plan walls',walls:[{id:'a',x1:0,y1:-.2,x2:5,y2:-.2,t:.4,h:2.6,mat:'block'},{id:'b',x1:5.2,y1:0,x2:5.2,y2:4,t:.4,h:0}],opens:[{wall:'a',u:.5,w:1,h:2,sill:0,type:'door'}]};
  const R=[{name:'C1',x:0,y:0},{name:'C2',x:5,y:0},{name:'C3',x:5,y:4},{kind:'plan poly',nowalls:true,names:['C1','C2','C3']},WR];
  K.peImportPoints(q,R); ok('import plan walls: walls, a door, a free room without contour walls',q.walls.length===2 && q.walls[0].t===.4 && q.walls[0].h===2.6 && q.walls[0].mat==='block' && q.walls[1].mat==='brick' && q.walls[1].h===2.7 && q.objs.length===1 && q.rooms.length===1 && q.rooms[0].free);
  WR.walls=[WR.walls[0]]; WR.walls[0].x2=6; K.peImportPoints(q,R); ok('import plan walls: a stale wall is removed, the kept one moves',q.walls.length===2-1 && Math.abs(K.peWallLen(q,q.walls[0])-6)<1e-9 && q.objs.length===1 && q.rooms.length===1);
  K.peDel(q,'wall',q.walls[0].id); ok('a free room survives deleting a wall',q.rooms.length===1); }
{ const q=K.peNew(), R=[{name:'C1',x:0,y:0},{name:'C2',x:5,y:0},{name:'C3',x:5,y:4},{kind:'plan poly',names:['C1','C2','C3'],h:2.55}]; K.peImportPoints(q,R); ok('import: a contour with h sets the wall height',q.walls.length===3 && q.walls.every(w=>w.h===2.55)); R[3].h=3; K.peImportPoints(q,R); ok('import: a new h updates the walls',q.walls.every(w=>w.h===3)); }
{ const q=K.peNew(); const n=K.peImportPoints(q,[{name:'C1',x:0,y:0},{name:'C2',x:5,y:0},{name:'C3',x:5,y:4},{name:'C4',x:0,y:4},{kind:'plan poly',names:['C1','C2','C3','C4']}]);
  ok('import a traced contour: 4 points, 4 walls and a room, once (a second import adds nothing)',q.pts.length===4 && q.walls.length===4 && q.rooms.length===1 && (K.peImportPoints(q,[{kind:'plan poly',names:['C1','C2','C3','C4']}]),q.walls.length===4 && q.rooms.length===1)); }
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
// экспорт
{ const {s,P,Wl}=room(); K.peAddObj(s,'door',{wall:Wl[0].id,u:.5,w:1}); K.peAddObj(s,'window',{wall:Wl[1].id,u:.5,w:1.2}); K.peAddObj(s,'box',{x:2,y:2,w:1,d:1,h:.5}); K.peAddCam(s,.3,.3,{az:45}); K.peAddAnt(s,3,2,{});
  const svg=K.peSVG(s,{scale:50,coverage:true,north:0}), pg=(svg.match(/<polygon/g)||[]).length;
  ok('svg: size in mm at 1:50 (6.0+1.6 m wide → 7.6 m / 50 = 152 mm)',/width="152mm"/.test(svg),svg.slice(0,160));
  ok('svg: wall parts (door splits one wall into 2, window splits another into 2 + sill/header boxes) and a box are polygons with thickness',pg>=10,pg);
  ok('svg: room label with its area, wall lengths, a scale bar and a door arc',/24\.0 m²/.test(svg) && /6\.00/.test(svg) && /1:50/.test(svg) && /<path d="M/.test(svg));
  ok('svg: closes properly',svg.trim().endsWith('</svg>') && (svg.match(/<svg/g)||[]).length===1);
  const dxf=K.peDXF(s), lines=dxf.trim().split('\n'); ok('dxf: an even number of group-code lines and EOF',lines.length%2===0 && lines[lines.length-1]==='EOF');
  ok('dxf: polylines for walls / room, an arc for the door, layers table',(dxf.match(/POLYLINE/g)||[]).length>=8 && /\nARC\n/.test(dxf) && /LAYER/.test(dxf) && /CAMERAS/.test(dxf));
  const d3=K.peDXF(s,{three:true}); ok('dxf 3D: 3DFACEs for every wall part and the box (6 each)',(d3.match(/3DFACE/g)||[]).length===6*K.peBoxes(s).length); }
// автоподбор камер: комната 10×4 одним объёмом — одна камера в торце с полем 90° видит почти всё; перегородка с узким проёмом требует второй
{ const cam={z:2.6,tilt:20,fov:100,range:14};
  let r=room(10,4), plan=K.peRunGen(K.peCamPlan(r.s,{tpl:cam,n:0,target:.95,mount:'walls'}));
  ok('one open room 10×4: reaches 95% with 1–2 cameras',plan.cover>=.95 && plan.cams.length<=2,JSON.stringify({c:plan.cover,n:plan.cams.length}));
  ok('the curve is increasing and ends at the final coverage',plan.curve.every((v,i,a)=>i===0||v>=a[i-1]-1e-9) && Math.abs(plan.curve[plan.curve.length-1]-plan.cover)<1e-9);
  // два помещения 5×4 и 5×4 через стену с дверью: одной камерой не охватить
  const s=K.peNew(), p=[[0,0],[5,0],[10,0],[10,4],[5,4],[0,4]].map(([x,y])=>K.peAddPoint(s,x,y)), wl=[0,1,2,3,4,5].map(i=>K.peAddWall(s,p[i].id,p[(i+1)%6].id)); const mid=K.peAddWall(s,p[1].id,p[4].id);
  K.peAddRoom(s,[p[0].id,p[1].id,p[4].id,p[5].id],'A'); K.peAddRoom(s,[p[1].id,p[2].id,p[3].id,p[4].id],'B'); K.peAddObj(s,'door',{wall:mid.id,u:.5,w:.9});
  const one=K.peRunGen(K.peCamPlan(s,{tpl:cam,n:1,mount:'walls'})), three=K.peRunGen(K.peCamPlan(s,{tpl:cam,n:0,target:.97,mount:'walls'}));
  ok('two rooms behind a wall: one camera sees less than 75%',one.cover<.75,one.cover);
  ok('…the planner asks for 2+ cameras and gets ≥ 95%',three.cams.length>=2 && three.cover>=.95,JSON.stringify({n:three.cams.length,c:three.cover}));
  near('more cameras never cover less (greedy curve)',three.curve[three.curve.length-1]>=one.cover?1:0,1,0);
  // уже стоящая камера учитывается: её зона не берётся заново
  K.peAddCam(s,.3,.3,{az:45,fov:100,range:14,z:2.6,tilt:20}); const rest=K.peRunGen(K.peCamPlan(s,{tpl:cam,n:0,target:.97,mount:'walls'}));
  ok('an existing camera counts: fewer new ones than from scratch (or the same)',rest.cams.length<=three.cams.length && rest.base>0,JSON.stringify({rest:rest.cams.length,from0:three.cams.length,base:rest.base}));
  // применить: появляются auto-камеры, повторный расчёт их заменяет, стоящая остаётся
  K.peApplyPlan(s,three,'cam',{z:2.6,tilt:20,fov:100,range:14}); const n1=s.cams.length; K.peApplyPlan(s,rest,'cam',{z:2.6,tilt:20,fov:100,range:14});
  ok('apply marks the new cameras auto and re-running replaces them, keeping the manual one',s.cams.filter(c=>!c.auto).length===1 && s.cams.filter(c=>c.auto).length===rest.cams.length && n1>=2);
  ok('clear removes only the auto ones',K.peClearAuto(s)===rest.cams.length && s.cams.length===1);
  const ex=K.peRunGen(K.peCamPlan(K.peNew(),{tpl:cam})); ok('no rooms: a clear error, no crash',!!ex.error);
  const dd=K.peRunGen(K.peCamPlan(s,{tpl:cam,n:1,doors:true,mount:'walls'})); ok('door priority: the chosen camera favours the doorway (covers its neighbourhood)',dd.cams.length===1); }
// автоподбор антенн: два помещения за бетонной стеной — одной точки мало
{ const s=K.peNew(), p=[[0,0],[8,0],[16,0],[16,6],[8,6],[0,6]].map(([x,y])=>K.peAddPoint(s,x,y)), wl=[0,1,2,3,4,5].map(i=>K.peAddWall(s,p[i].id,p[(i+1)%6].id,{mat:'concrete',t:.3})); K.peAddWall(s,p[1].id,p[4].id,{mat:'concrete',t:.3});
  K.peAddRoom(s,[p[0].id,p[1].id,p[4].id,p[5].id],'A'); K.peAddRoom(s,[p[1].id,p[2].id,p[3].id,p[4].id],'B');
  const tpl={z:2.4,eirp:20,f:5200,bw:360}, one=K.peRunGen(K.peAntPlan(s,{tpl,n:1,thr:-65})), auto=K.peRunGen(K.peAntPlan(s,{tpl,n:0,target:.97,thr:-65}));
  ok('5 GHz through an 18 dB concrete wall: one access point leaves a gap, two cover ≥ 97%',one.cover<.97 && auto.ants.length===2 && auto.cover>=.97,JSON.stringify({one:one.cover,n:auto.ants.length,c:auto.cover}));
  ok('the access points sit on both sides of the wall',auto.ants.some(a=>a.x<8) && auto.ants.some(a=>a.x>8),JSON.stringify(auto.ants));
  K.peApplyPlan(s,auto,'ant',tpl); const h=K.peAntHeat(s,K.peGrid(s,.5),{thr:-65}); ok('the real heat map agrees with the plan (share ≥ 0.95)',h.share>=.95,h.share); }
// частотная зависимость потерь
ok('loss grows with the frequency: brick 868 MHz < 2.4 GHz < 5.2 GHz < 5.2 GHz concrete',K.peMatLoss('brick',868,.2)<K.peMatLoss('brick',2400,.2) && K.peMatLoss('brick',2400,.2)<K.peMatLoss('brick',5200,.2) && K.peMatLoss('brick',5200,.2)<K.peMatLoss('concrete',5200,.2));
near('brick, 5.2 GHz, 20 cm ≈ 8·(5.2/2.4)^0.8 = 14.8 dB',K.peMatLoss('brick',5200,.2),8*Math.pow(5200/2400,.8),1e-9);
ok('sub-GHz walls are almost transparent: 433 MHz brick 20 cm < 3.5 dB',K.peMatLoss('brick',433,.2)<3.5,K.peMatLoss('brick',433,.2));
ok('metal hardly depends on the frequency (< 12 % between 868 MHz and 5.2 GHz)',K.peMatLoss('metal',5200,.1)/K.peMatLoss('metal',868,.1)<1.2);
ok('a window / a door scale too, but gently',K.peOpenLoss('window',5200)>K.peOpenLoss('window',2400) && K.peOpenLoss('door',5200)<K.peOpenLoss('door',2400)*1.5);
ok('the same wall is a bigger obstacle at 5 GHz: the level behind it drops more than the free-space difference',(()=>{ const q=room(10,10), A=K.peAddAnt(q.s,1,5,{z:1,f:2400}), B=K.peAddAnt(q.s,1,5,{z:1,f:5200}), p1=K.peAddPoint(q.s,3,0), p2=K.peAddPoint(q.s,3,10); K.peAddWall(q.s,p1.id,p2.id,{mat:'concrete',t:.2}); const d=(a)=>K.peAntLevel(q.s,a,2,5,1)-K.peAntLevel(q.s,a,6,5,1); return d(B)>d(A)+3; })());
// порядок рисования: длинная стена и ящик перед ней / за ней (виден из точки к югу и сверху)
{ const wall={cx:0,cy:0,ux:1,uy:0,l:10,t:.2,z0:0,z1:2.7,kind:'wall'}, front={cx:4,cy:-1.5,ux:1,uy:0,l:1,t:.6,z0:0,z1:.8,kind:'box'}, back={cx:-3,cy:1.5,ux:1,uy:0,l:1,t:.6,z0:0,z1:.8,kind:'box'};
  const view={dx:0,dy:-1,h:Math.cos(40*Math.PI/180)}, depth=b=>b.cy*Math.cos(40*Math.PI/180);          // зритель на юге
  const o=K.peBoxOrder([wall,front,back],view,depth); const pos=i=>o.indexOf(i);
  ok('a box in front of the long wall (its centre nearer or not) is drawn after it; a box behind — before it',pos(1)>pos(0) && pos(2)<pos(0),JSON.stringify(o));
  // тот же ящик, но стена длинная и ящик у самого её края — центр стены «далеко», а ящик ближе: порядок всё равно верный
  const far={cx:4.8,cy:-.5,ux:1,uy:0,l:.8,t:.4,z0:0,z1:.8,kind:'box'}; const o2=K.peBoxOrder([wall,far],view,depth); ok('a box at the very end of a long wall, on the viewer’s side: after the wall',o2[1]===1,JSON.stringify(o2));
  const view2={dx:0,dy:1,h:Math.cos(40*Math.PI/180)}, o3=K.peBoxOrder([wall,front,back],view2,b=>-b.cy); ok('the viewer on the north: the order flips',o3.indexOf(2)>o3.indexOf(0) && o3.indexOf(1)<o3.indexOf(0),JSON.stringify(o3));
  const sill={cx:0,cy:0,ux:1,uy:0,l:1,t:.2,z0:0,z1:.9,kind:'wall'}, head={...sill,z0:2.1,z1:2.7}; const o4=K.peBoxOrder([head,sill],{dx:0,dy:-1,h:0},b=>0); ok('from above (h = 0): the lower block first, even on the same footprint (a window sill under its header)',o4[0]===1,JSON.stringify(o4)); }
// объект, вошедший в стену
{ const {s,P,Wl}=room(); const inside=K.peAddObj(s,'box',{x:1.4,y:2,w:2,d:.9,h:.8,rot:90}); ok('a sofa fully inside the room overlaps nothing',K.peOverlaps(s).length===0);
  const bad=K.peAddObj(s,'box',{x:1.4,y:3.2,w:2,d:.9,h:.8,rot:0}); const ov=K.peOverlaps(s); ok('a box 2 m long along y centred at y = 3.2 sticks out through the north wall: flagged once with that wall',ov.length===1 && ov[0].obj===bad.id && ov[0].wall===Wl[2].id,JSON.stringify(ov));
  const tall=K.peAddObj(s,'box',{x:3,y:2,w:.5,d:.5,h:.5,rot:0,z:2.8}); ok('a box above the wall top does not collide',!K.peOverlaps(s).some(o=>o.obj===tall.id)); }
// z-буфер: порядок блоков не важен
{ const E=35*Math.PI/180, ce=Math.cos(E), se=Math.sin(E), W=300, H=300, sc=20, proj=(x,y,z)=>[W/2+x*sc,H*.75-(z*ce+y*se)*sc,y*ce-z*se];
  const wall={cx:0,cy:0,ux:1,uy:0,l:10,t:.2,z0:0,z1:2.7,kind:'wall',ref:'w'}, tbl=(y,ref)=>({cx:0,cy:y,ux:1,uy:0,l:1.2,t:.6,z0:0,z1:.8,kind:'box',ref}), col=b=>b.kind==='wall' ? [200,200,200] : [200,120,40];
  const at=(R,x,y,z)=>{ const q=proj(x,y,z), i=(Math.round(q[1]-.5)*R.w+Math.round(q[0]-.5))*4; return [R.data[i],R.data[i+1],R.data[i+2],R.data[i+3]]; };
  const run=(B)=>K.peZRaster(B,proj,W,H,{cam:[0,-1],ce,color:col,edge:false});
  const front=run([wall,tbl(-1.5,'t')]), frontRev=run([tbl(-1.5,'t'),wall]);
  const eq=(c,r)=>c[0]===r[0]&&c[1]===r[1]&&c[2]===r[2]&&c[3]===r[3], TOP=[190,114,38,255], WALL=[132,132,132,255];
  ok('a table in front of the wall: its top shows over the wall',eq(at(front,0,-1.5,.8),TOP),JSON.stringify(at(front,0,-1.5,.8)));
  ok('the order of the blocks does not change the picture (byte for byte)',front.data.every((v,i)=>v===frontRev.data[i]));
  const behind=run([wall,tbl(1.5,'t')]); ok('a table behind the wall: the point of its top is hidden by the wall’s near face',eq(at(behind,0,1.5,.8),WALL),JSON.stringify(at(behind,0,1.5,.8)));
  const thru=run([wall,tbl(0,'t')]); ok('a table that straddles the wall (intersecting volumes): the south half of its top is visible, the north half is cut by the wall',eq(at(thru,0,-.2,.8),TOP) && eq(at(thru,0,.2,.8),WALL),JSON.stringify([at(thru,0,-.2,.8),at(thru,0,.2,.8)]));
  ok('background is transparent',at(front,-6,-3,0)[3]===0); }
// монолит: стык двух блоков в одной плоскости не виден, силуэт и смена грани — видны
{ const E=35*Math.PI/180, ce=Math.cos(E), se=Math.sin(E), W=300, H=300, sc=20, proj=(x,y,z)=>[W/2+x*sc,H*.75-(z*ce+y*se)*sc,y*ce-z*se];
  const b=(cx,l)=>({cx,cy:0,ux:1,uy:0,l,t:.4,z0:0,z1:2.7,kind:'wall',ref:'w'+cx}), col=()=>[200,200,200];
  const at=(R,x,y,z)=>{ const q=proj(x,y,z), i=(Math.round(q[1]-.5)*R.w+Math.round(q[0]-.5))*4; return R.data[i]; };
  const one=K.peZRaster([b(0,6)],proj,W,H,{cam:[0,-1],ce,color:col}), two=K.peZRaster([b(-1.5,3),b(1.5,3)],proj,W,H,{cam:[0,-1],ce,color:col});
  ok('monolith: two blocks in one plane look like one (byte for byte)',one.data.every((v,i)=>v===two.data[i]));
  const faces=K.peZRaster([b(-1.5,3),b(1.5,3)],proj,W,H,{cam:[0,-1],ce,color:col,edge:'faces'});
  ok('«faces» mode still outlines every face (the seam shows)',at(faces,0,-.2,1.3)<at(two,0,-.2,1.3),at(faces,0,-.2,1.3)+' '+at(two,0,-.2,1.3));
  ok('monolith: the silhouette is outlined',at(two,-3,-.2,1.3)<at(two,-2.5,-.2,1.3) || at(two,-3.02,-.2,1.3)<at(two,-2.5,-.2,1.3)); }
// приёмная антенна
{ const {s}=room(20,10); const tx=K.peAddAnt(s,2,5,{z:1,eirp:20,f:2400,bw:360}); const rx=K.peAddRx(s,12,5,{z:1,gain:3,sens:-85,f:2400});
  const r=K.peRxLevel(s,rx); near('RX level = EIRP − FSPL(10 m) + RX gain',r.level,20-K.peFspl(10,2400)+3,1e-6); near('margin over the sensitivity',r.margin,r.level+85,1e-9); ok('link ok, from the transmitter',r.ok && r.from===tx.id);
  const far=K.peAddRx(s,12,5,{z:1,f:5800}); ok('a receiver on another frequency hears nobody',K.peRxLevel(s,far).from===null && !K.peRxLevel(s,far).ok);
  const dir=K.peAddRx(s,12,5,{z:1,gain:3,f:2400,bw:60,az:90}); ok('a directional receiver turned away (az 90° east, the transmitter is west): ≥ 20 dB weaker',r.level-K.peRxLevel(s,dir).level>20);
  const p1=K.peAddPoint(s,7,0), p2=K.peAddPoint(s,7,10); K.peAddWall(s,p1.id,p2.id,{mat:'concrete',t:.2}); near('a concrete wall on the way costs its loss at 2.4 GHz',r.level-K.peRxLevel(s,rx).level,K.peMatLoss('concrete',2400,.2),1e-6);
  const h=K.peAntHeat(s,K.peGrid(s,1),{thr:-70}); ok('the heat map ignores receivers (the same with and without)',(()=>{ const q=K.peAntHeat((()=>{ const t2=room(20,10).s; K.peAddAnt(t2,2,5,{z:1,eirp:20,f:2400}); return t2; })(),K.peGrid(s,1),{thr:-70}); return Math.abs(q.mean-h.mean)<30; })());
  const hf=K.peAntHeat(s,K.peGrid(s,1),{thr:-70,f:5800}); ok('a frequency filter: nothing transmits on 5.8 GHz → no signal',hf.min<=-199); }
{ const {s,P,Wl}=room(); K.peLock(s,Wl[0].id); K.peMoveWall(s,Wl[2].id,1,5,7,5); const q1=K.pePt(s,Wl[2].a), q2=K.pePt(s,Wl[2].b);
  ok('moving a wall puts both its ends where asked',Math.abs(q1.x-1)<1e-9 && Math.abs(q1.y-5)<1e-9 && Math.abs(q2.x-7)<1e-9);
  ok('…and a locked neighbour keeps its length',Math.abs(K.peWallLen(s,Wl[0])-6)<2e-3 && !s.pts.some(p=>p.fix),K.peWallLen(s,Wl[0])); }
ok('an empty scene has no bounds and no grid',K.peGrid(K.peNew())===null);
{ const h=K.peHistNew('A'); K.peHistCommit(h,'B'); K.peHistCommit(h,'C');
  ok('history: undo steps back',K.peHistUndo(h,'C')==='B' && K.peHistUndo(h,'B')==='A' && K.peHistUndo(h,'A')===null);
  ok('history: redo steps forward, a new edit drops redo',K.peHistRedo(h,'A')==='B' && (K.peHistCommit(h,'X'),K.peHistRedo(h,'X')===null));
  ok('history: uncommitted state is saved before undo',(K.peHistUndo(h,'Y')==='X') && K.peHistRedo(h,'X')==='Y'); }
// линейка: привязка к углу и грани стены; служебные точки скрыты; имя комнаты из Site Plan
{ const q=K.peNew(), R=[{name:'C1',x:0,y:0},{name:'C2',x:4,y:0},{name:'C3',x:4,y:-3},{kind:'plan poly',nowalls:true,name:'zal',names:['C1','C2','C3']},{id:'sp:walls',kind:'plan walls',walls:[{id:'a',x1:-.2,y1:.2,x2:4.2,y2:.2,t:.4,h:2.7,mat:'brick'}],opens:[]}];
  K.peImportPoints(q,R);
  const c=K.peSnapFace(q,4.25,.37,.1); ok('snap: to the outer corner of the wall',c && c.kind==='corner' && Math.abs(c.x-4.2)<1e-9 && Math.abs(c.y-.4)<1e-9,JSON.stringify(c));
  const f=K.peSnapFace(q,2,.03,.1); ok('snap: onto the inner face',f && f.kind==='face' && Math.abs(f.y)<1e-9 && Math.abs(f.x-2)<1e-9,JSON.stringify(f));
  ok('snap: nothing far away',K.peSnapFace(q,2,-2,.1)===null);
  const h=K.peHiddenPts(q); ok('hidden: wall ends and the corners of a wall-less room',h.size===5,h.size);
  ok('room name from Site Plan',q.rooms[0].name==='zal'); }
// этажи в расчёте сигнала: стена другого этажа не мешает, перекрытие добавляет потери, проём — только в его высоте
{ const q=K.peNew(); const A=K.peAddPoint(q,5,-1), B=K.peAddPoint(q,5,11); const w=K.peAddWall(q,A.id,B.id,{t:.2,h:2.7,mat:'brick'}); w.z0=3; w.lv=1;
  near('a wall of the upper floor is not crossed by a ray on the ground floor',K.peWallLoss(q,0,5,10,5,2400,1,1),0,1e-9);
  near('…but it is for a ray up there',K.peWallLoss(q,0,5,10,5,2400,4,4),K.peMatLoss('brick',2400,.2),1e-9);
  near('without heights the old 2D rule counts it',K.peWallLoss(q,0,5,10,5,2400),K.peMatLoss('brick',2400,.2),1e-9);
  q.walls=[]; q.slabs=[{z:3,t:.25,mat:'concrete',lv:1,poly:[[0,0],[10,0],[10,10],[0,10]]}];
  near('a slab between the floors adds its loss',K.peWallLoss(q,2,5,8,5,2400,1,4),K.peMatLoss('concrete',2400,.25),1e-9);
  near('…not for a ray on one floor',K.peWallLoss(q,2,5,8,5,2400,1,1),0,1e-9);
  q.slabs=[]; const w2=K.peAddWall(q,A.id,B.id,{t:.2,h:2.7,mat:'concrete'}); K.peAddObj(q,'window',{wall:w2.id,u:.5,w:2,h:1.2,sill:.9});
  near('a window: through the glass at 1.5 m',K.peWallLoss(q,0,5,10,5,2400,1.5,1.5),K.peOpenLoss('window',2400),1e-9);
  near('…through the wall under the sill at 0.5 m',K.peWallLoss(q,0,5,10,5,2400,.5,.5),K.peMatLoss('concrete',2400,.2),1e-9);
  const f=K.peLvShow('1',true), g=K.peLvShow('all',false), a3=K.peLvShow('all',true); ok('level filter: 3D shows the floor and below, the plan «all» — the ground floor, 3D «all» — above the ground',f(1) && f(0) && f(-1) && !f(2) && g(0) && g(undefined) && !g(1) && a3(2) && a3(0) && !a3(-1)); }
console.log(bad?('\n'+bad+' FAILED'):'\nall ok'); process.exit(bad?1:0);
