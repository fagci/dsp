// Ядро Site Plan: node tools/test-siteplan.mjs
// Известные решения: прямоугольник с диагональю, замкнутый ход с невязкой, клинометр, GPS + рулетка, вес замеров, 3D по dz, экспорт.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float64Array,Float32Array,Set,Map,Number,String,JSON,isFinite,Infinity,Array,Object});
vm.runInContext(fs.readFileSync(path.join(root,'modules/siteplan-kernels.js'),'utf8')+';this.K={spSolve,spParse,spTilt,spPoly,spDXF,spGeoJSON,spSVG,spCSV,spFrame,spNice,spGridFrame,spToFrame,spFilePath,spFromFrame,spGridLines,spWalls,spHouse,spRoof,spRowToLine,spUniqueNames,spCanopy};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b+' (±'+e+')');
const P=(R,n)=>R.pts.find(p=>p.name===n);

// 1. прямоугольник 10×5: четыре стороны и диагональ
let R=K.spSolve('A-B 10\nB-C 5\nC-D 10\nD-A 5\nA-C 11.1803\npoly A B C D');
ok('rect: no parse errors',R.errors.length===0,JSON.stringify(R.errors));
near('rect: area 50 m²',R.polys[0].area,50,.02);
near('rect: perimeter 30 m',R.polys[0].perimeter,30,.01);
near('rect: diagonal BD = 11.18',Math.hypot(P(R,'B').x-P(R,'D').x,P(R,'B').y-P(R,'D').y),11.1803,.01);
ok('rect: flat, z = 0',R.pts.every(p=>Math.abs(p.z)<1e-6));
ok('rect: rms of residuals is tiny',R.rms<.1,R.rms);

// 2. неровные измерения: невязка распределяется, крупная ошибка помечается
R=K.spSolve('A-B 10\nB-C 5\nC-D 10\nD-A 5\nA-C 11.1803\nB-D 11.1803\nA-B 10.01\nB-C 4.99\nC-D 10\nA-D 8');
{ const w=R.res.reduce((m,r)=>r.nmax>m.nmax ? r : m); ok('outlier: the gross error (line 10) has the largest normalized residual and is flagged',w.li===10 && w.out,JSON.stringify(w)); }
// 2b. зеркало: расстояния до двух точек дают два решения, азимут выбирает сторону
for(const [az,sgn] of [[118,-1],[62,1]]){ R=K.spSolve('A at 0 0\nB at 24.8 0\nA-E 8\nB-E 18.1\nA-E az '+az); near('mirror: az '+az+' puts E on the '+(sgn>0 ? 'north' : 'south')+' side',Math.sign(P(R,'E').y),sgn,0); }
// 3. вес: рулетка ±1 см против второго измерения ±1 м — решение у рулетки
R=K.spSolve('A-B 10 ±0.01\nA-B 11 ±1');
near('weights: mean is pulled to the precise one',Math.hypot(P(R,'B').x-P(R,'A').x,P(R,'B').y-P(R,'A').y),10.0001,.01);
// 4. клинометр
const q=K.spTilt(20,30,1.6);
near('tilt: 1.6 + 20 tan30',q.dz,1.6+20*Math.tan(Math.PI/6),1e-9);
R=K.spSolve('G-T tilt 45 10 eye 1.5\nG z 100');
near('tilt line: top at 100 + 1.5 + 10',P(R,'T').z,111.5,.01);
near('tilt line: horizontal distance 10',Math.hypot(P(R,'T').x-P(R,'G').x,P(R,'T').y-P(R,'G').y),10,.01);
// 5. 3D: склон — расстояние по склону 13 и превышение 5 → по горизонтали 12
R=K.spSolve('A-B 13\nA-B dz 5\nA z 10');
near('slope: B at height 15',P(R,'B').z,15,.01);
near('slope: horizontal distance = 12',Math.hypot(P(R,'B').x-P(R,'A').x,P(R,'B').y-P(R,'A').y),12,.02);
// 6. GPS + азимут: привязка к земле; рулетка задаёт форму
R=K.spSolve('A gps 55.0 83.0 ±3\nA-B 100\nA-B az 90\npoly A B');
ok('gps+az: georeferenced',R.georef===true);
near('gps+az: B is due east, same latitude',P(R,'B').lat,55.0,2e-5);
near('gps+az: 100 m east ≈ 0.001566° lon at 55°N',P(R,'B').lon-83.0,100/(111194.9*Math.cos(55*Math.PI/180)),2e-6);
R=K.spSolve('A gps 55.0 83.0\nA-B 100');
ok('one gps, no azimuth: not georeferenced (orientation unknown)',R.georef===false);
// 7. несколько GPS-замеров усредняются
R=K.spSolve('A gps 55.0000 83.0 ±5\nA gps 55.0002 83.0 ±5\nB gps 55.0 83.001 ±5\nB gps 55.0 83.001 ±5');
near('gps average: A latitude between the fixes',P(R,'A').lat,55.0001,2e-6);
// 8. три точки на «земле» с рельефом
R=K.spSolve('A gps 55 83\nB gps 55.001 83\nC gps 55.001 83.001',{ground:(la,lo)=>100+(la-55)*1000});
near('ground: B height 101 from the terrain',P(R,'B').z,101,.1);
// 9. угол при вершине
R=K.spSolve('A-B 10\nB-C 10\nA-B-C 90\nA-C 14.1421');
near('angle 90°: AC = 14.14',Math.hypot(P(R,'A').x-P(R,'C').x,P(R,'A').y-P(R,'C').y),14.1421,.02);
// 10. разбор: запятая, комментарии, ошибки
R=K.spSolve('A-B 10,5 # note\nfoo bar\nA-B zz');
near('comma decimals',Math.hypot(P(R,'B').x-P(R,'A').x,P(R,'B').y-P(R,'A').y),10.5,.001);
ok('bad lines are reported with line numbers',R.errors.length===2 && R.errors[0].line===2);
R=K.spSolve('A-B 10 # note; with semicolon\nA-C 3; C-B 4');
ok('a semicolon inside a comment does not split the line; outside it does',R.errors.length===0 && R.obs===undefined && R.res.length===3,JSON.stringify(R.errors));
// 11. поверхность наклонного контура
R=K.spSolve('A at 0 0\nB at 10 0\nC at 10 10\nD at 0 10\nA z 0\nB z 0\nC z 5\nD z 5\npoly A B C D');
near('tilted plot: plan 100, surface ≈ 111.8',R.polys[0].surf,111.803,.1);
near('tilted plot: slope 26.57° = 50%',R.polys[0].slopePct,50,.3);
// 12. экспорт
R=K.spSolve('A gps 55 83\nB gps 55.001 83\nC gps 55.001 83.001\npoly A B C');
ok('geojson has a polygon and 3 points',JSON.parse(K.spGeoJSON(R)).features.length===4);
ok('dxf: entities and EOF',/ENTITIES[\s\S]*POLYLINE[\s\S]*EOF/.test(K.spDXF(R)));
ok('svg: area label',/m²/.test(K.spSVG(R)));
ok('csv: header + 3 rows',K.spCSV(R).trim().split('\n').length===4);
ok('empty text: no crash',K.spSolve('').pts.length===0);
// 13. сетка
near('nice step: 7.3 → 10',K.spNice(7.3),10,0); near('nice step: 0.13 → 0.2',K.spNice(.13),.2,1e-12); near('nice step: 4 → 5',K.spNice(4),5,0);
R=K.spSolve('A at 10 5\nB at 10 15\nC at 0 15\nD at 0 5\npoly A B C D');
{ const f=K.spGridFrame(R,'structure'); near('structure frame: origin at the first vertex',f.ox,10,1e-9);
  const q=K.spToFrame(f,10,15); near('structure frame: the first side is the u axis (length 10)',q[0],10,1e-9); near('…and v = 0 on it',q[1],0,1e-9);
  const w=K.spFromFrame(f,3,2); near('round trip x',K.spToFrame(f,...w)[0],3,1e-12); near('round trip y',K.spToFrame(f,...w)[1],2,1e-12);
  const n=K.spGridFrame(R,'north'); ok('north frame is the plan frame',n.ux===1 && n.uy===0 && n.vy===1 && n.ox===0);
  const g=K.spGridLines(R,n,5,0); ok('grid lines cover the points at a nice step',g.step===5 && g.u[0]<=0 && g.u[g.u.length-1]>=10 && g.v[0]<=5 && g.v[g.v.length-1]>=15,JSON.stringify(g.u)+JSON.stringify(g.v)); }
// зеркало без азимута: 4 стороны + угол — D по двум расстояниям встаёт по обе стороны диагонали AC; контур poly выбирает неперекрученный вариант
for(const extra of ['D-A 3.74','D-A 3.74\nC-D-A 90','C-D-A 90']){
  R=K.spSolve('A-B 4.48\nB-C 3.74\nC-D 4.46\nA-B-C 90\n'+extra+'\npoly A B C D');
  near('room ('+extra.replace('\n',' + ')+'): area ≈ 4.47 × 3.74, not a folded quad',R.polys[0].area,16.72,.1);
  ok('room ('+extra.replace('\n',' + ')+'): all measurements fit',R.rms<.1,R.rms);
}
// недоопределённо (3 стороны + угол): замеры всё равно выполнены, D помечена слабой
R=K.spSolve('A-B 4.48\nB-C 3.74\nC-D 4.46\nA-B-C 90\npoly A B C D');
ok('room, D free: measurements fit exactly',R.rms<.01,R.rms);
ok('room, D free: D is flagged weak, a contour is drawn',P(R,'D').weak && R.polys[0].area>10,JSON.stringify(P(R,'D')));
// «room»: обход по периметру без имён точек
R=K.spSolve('room Zal 4.48 3.74 4.46 3.74');
ok('room: no errors, 4 corners named Zal1…Zal4',R.errors.length===0 && R.names.join()==='Zal1,Zal2,Zal3,Zal4',JSON.stringify(R.errors)+R.names);
near('room: area ≈ 16.7 m²',R.polys[0].area,16.72,.1);
ok('room: no weak corners (right angles fix the shape)',R.pts.every(p=>!p.weak));
R=K.spSolve('room K 5 4/? 5/? 4/? d 6.4031');
near('room with only a diagonal (corners «/?»): 5×4 rectangle',R.polys[0].area,20,.05);
R=K.spSolve('room T 3 4/? 5/?');
near('room: a triangle 3-4-5 from the sides alone',R.polys[0].area,6,.01);
R=K.spSolve('room 4 4 4'); ok('room without a name is an error',R.errors.length===1);
R=K.spSolve('room Z 4 x 4'); ok('room with a bad side is an error',R.errors.length===1);
R=K.spSolve('room A 4 3 4 3\nroom B 2 3 2 3\nA2-B1 0.4\nA2-A3-B1 180\nA2-B4 0.4'); ok('two rooms linked by a wall line',R.errors.length===0 && R.polys.length===2,JSON.stringify(R.errors));
// «wall»: комнаты через стену, без наложения
for(const [w,c4,c1] of [['wall Zal2-Zal3 kor4-kor1 0.37',[14.85,-0],[14.85,-5.9]],['wall Zal2-Zal3 kor1-kor4 0.37 shift -1',[14.85,-4.9],[14.85,1]],['wall Zal3-Zal2 kor4-kor1 0.37',[14.85,-3.74],[14.85,2.16]]]){
  R=K.spSolve('Zal1 at 10 0\nZal1-Zal2 az 90\nroom Zal 4.48 3.74 4.46 3.74\nroom kor 1.36 5.9 1.33 5.9\n'+w);
  const a=P(R,'kor4'), b=P(R,'kor1'), cx=R.polys[1].cx;
  ok('wall «'+w+'»: corners across the wall',Math.hypot(a.x-c4[0],a.y-c4[1])<.05 && Math.hypot(b.x-c1[0],b.y-c1[1])<.05,JSON.stringify([a,b]));
  ok('wall «'+w+'»: corridor outside the hall, fits',cx>14.85 && R.rms<.2 && R.pts.every(p=>!p.weak),cx+' '+R.rms);
}
R=K.spSolve('room Zal 4 3 4 3\nzal2-x 1'); ok('names differing only by case are reported',R.errors.some(e=>/case-sensitive/.test(e.msg)));
// «mirror»: без компаса план отражается слева направо, размеры те же
{ const t='room zal 4.48 3.74 4.46 3.74\nroom kor 1.36 5.9 1.33 5.9\nwall zal2-zal3 kor1-kor4 0.37\n';
  const A=K.spSolve(t), B=K.spSolve(t+'mirror'), side=R=>Math.sign(R.polys[1].cx-R.polys[0].cx);
  ok('mirror: the corridor moves to the other side of the hall',side(A)===-side(B) && B.mirror,side(A)+' '+side(B));
  near('mirror: areas unchanged',B.polys[0].area+B.polys[1].area,A.polys[0].area+A.polys[1].area,1e-9);
  R=K.spSolve(t+'mirror\nzal1-zal2 az 90'); ok('mirror with a compass is ignored and reported',!R.mirror && R.errors.some(e=>/mirror/.test(e.msg))); }
// высота потолка
R=K.spSolve('height 2.7\nroom A 4 3 4 3 h 2.5\nroom B 2 3 2 3\nwall A2-A3 B1-B4 0.3');
ok('ceiling: room h overrides the default height',R.polys[0].h===2.5 && R.polys[1].h===2.7,JSON.stringify(R.polys.map(p=>p.h)));
near('ceiling: volume = area × h',R.polys[0].volume,30,.01);
R=K.spSolve('A-B 3\nB-C 3\nC-A 3\npoly A B C h x'); ok('poly with a bad h is an error',R.errors.length===1);
// окна и двери
R=K.spSolve('room zal 4.48 3.74 4.46 3.74\nwindow zal1-zal2 1.20 1.40 h 1.45 sill 0.85\ndoor zal3-zal4 0.10 0.80');
ok('openings: a window and a door, no errors',R.errors.length===0 && R.opens.length===2,JSON.stringify(R.errors));
ok('openings: window values and defaults of the door',R.opens[0].kind==='window' && R.opens[0].h===1.45 && R.opens[0].sill===.85 && Math.abs(R.opens[0].L-4.48)<.01 && R.opens[1].h===2.05 && R.opens[1].sill===0,JSON.stringify(R.opens));
R=K.spSolve('room zal 4.48 3.74 4.46 3.74\nwindow zal1-zal2 4.0 1.0'); ok('openings: longer than the wall is an error',R.errors.length===1 && !R.opens.length);
R=K.spSolve('room zal 4.48 3.74 4.46 3.74\nwindow zal1-zal3 1 1'); ok('openings: a diagonal is not a wall',R.errors.length===1);
R=K.spSolve('room zal 4.48 3.74 4.46 3.74\nwindow zal1-zal2 1 1 x 2'); ok('openings: an unknown key is an error',R.errors.length===1);
// стены снаружи замера: наружные outer, общая — во всю щель, углы закрыты, дверь пробивает общую стену
{ const t='Zal1 at 0 0\nZal1-Zal2 az 90\nroom Zal 4 3 4 3\nroom Kor 1.5 3 1.5 3\nwall Zal2-Zal3 Kor1-Kor4 0.37\nouter 0.5\ndoor Zal2-Zal3 1 0.8\ndoor Kor4-Kor1 1.2 0.8\nwindow Zal4-Zal1 1 1';
  R=K.spSolve(t); const W=K.spWalls(R,{outer:R.outer}), inn=W.walls.filter(w=>w.kind==='inner');
  ok('walls: one shared wall 0.37 thick between the rooms',inn.length===1 && Math.abs(inn[0].t-.37)<.01,JSON.stringify(inn));
  ok('walls: outer ones are 0.5',W.walls.filter(w=>w.kind==='outer').every(w=>w.t===.5));
  const inside=(x,y)=>W.walls.some(w=>{ const dx=w.x2-w.x1, dy=w.y2-w.y1, L=Math.hypot(dx,dy), u=((x-w.x1)*dx+(y-w.y1)*dy)/L, v=Math.abs((x-w.x1)*dy-(y-w.y1)*dx)/L; return u>=-1e-6 && u<=L+1e-6 && v<=w.t/2+1e-6; });
  ok('walls: the inner face is the measurement (no wall inside the room)',!inside(.02,-.02) && !inside(3.98,-2.98) && inside(-.02,.02));
  const X0=-.5, X1=4+.37+1.5+.5, Y0=-3.5, Y1=.5; let holes=0;
  for(let k=0;k<=200;k++){ const f=k/200; for(const [x,y] of [[X0+.01+(X1-X0-.02)*f,Y1-.01],[X0+.01+(X1-X0-.02)*f,Y0+.01],[X0+.01,Y0+.01+(Y1-Y0-.02)*f],[X1-.01,Y0+.01+(Y1-Y0-.02)*f]]) if(!inside(x,y)) holes++; }
  ok('walls: the outer shell is closed (corners filled, the shared wall meets the shell)',holes===0,holes+' holes');
  ok('walls: the shared wall is solid between the faces',inside(4.185,-1.5) && inside(4.185,.25));
  const doors=W.opens.filter(o=>o.type==='door');
  ok('walls: the door written from both rooms is one opening in the shared wall',doors.length===1 && doors[0].wall===inn[0].id,JSON.stringify(W.opens));
  ok('walls: the window goes into the outer wall',W.opens.some(o=>o.type==='window' && W.walls.find(w=>w.id===o.wall).kind==='outer'));
  const w0=W.walls.find(w=>w.id===doors[0].wall), Lw=Math.hypot(w0.x2-w0.x1,w0.y2-w0.y1), cy=w0.y1+(w0.y2-w0.y1)*doors[0].u;
  near('walls: the door centre is 1.4 m from Zal2',cy,-1.4,.02); }
// материалы стен
{ const t='Zal1 at 0 0\nZal1-Zal2 az 90\nroom Zal 4 3 4 3\nroom Kor 1.5 3 1.5 3\nroom Kit 2 3 2 3\nwall Zal2-Zal3 Kor1-Kor4 0.37\nwall Kor2-Kor3 Kit1-Kit4 0.12 гкл\nouter 0.5 бетон\ninner block\nmaterial Zal4-Zal1 glass';
  R=K.spSolve(t); const W=K.spWalls(R,{outer:R.outer}), at=(x,y)=>W.walls.find(w=>{ const dx=w.x2-w.x1, dy=w.y2-w.y1, L=Math.hypot(dx,dy), u=((x-w.x1)*dx+(y-w.y1)*dy)/L, v=Math.abs((x-w.x1)*dy-(y-w.y1)*dx)/L; return u>=0 && u<=L && v<=w.t/2+1e-6; });
  ok('materials: no errors',R.errors.length===0,JSON.stringify(R.errors));
  ok('materials: outer walls are concrete (Russian name)',at(2,.25)?.mat==='concrete');
  ok('materials: shared walls take «inner»',at(4.18,-1.5)?.mat==='block');
  ok('materials: a «wall» line sets its wall',at(4+.37+1.5+.06,-1.5)?.mat==='drywall');
  ok('materials: «material A-B» sets the wall of that side',at(-.25,-1.5)?.mat==='glass');
  R=K.spSolve('room A 4 3 4 3\nmaterial A1-A3 glass'); ok('materials: a diagonal is not a side',R.errors.length===1);
  R=K.spSolve('room A 4 3 4 3\nouter 0.4 cheese'); ok('materials: unknown material is an error',R.errors.length===1); }
// порядок строк не важен: комната за стеной, упомянутая раньше, всё равно встаёт по свою сторону
for(const t of ['material Kit2-Kit3 concrete\nroom Hall 4.48 3.74 4.46 3.74\nroom Kit 3.10 3.74 3.10 3.74\nwall Hall2-Hall3 Kit1-Kit4 0.40','wall Hall2-Hall3 Kit1-Kit4 0.40\nroom Kit 3.10 3.74 3.10 3.74\nroom Hall 4.48 3.74 4.46 3.74']){
  R=K.spSolve(t); const W=K.spWalls(R,{});
  ok('order of lines: no overlap, one shared wall ('+t.split('\n')[0]+')',R.rms<.2 && W.walls.filter(w=>w.kind==='inner').length===1,R.rms+' '+W.walls.map(w=>w.kind).join()); }
// ровный фасад: наружные грани соседних стен в одну линию, внутренние (замер) на месте; B сдвинута на 3 см к северу
{ R=K.spSolve('A1 at 0 0\nA2 at 4 0\nA3 at 4 -3\nA4 at 0 -3\npoly A1 A2 A3 A4\nB1 at 4.3 0.03\nB2 at 7.3 0.03\nB3 at 7.3 -2.97\nB4 at 4.3 -2.97\npoly B1 B2 B3 B4'); const W=K.spWalls(R,{});
  const top=W.walls.filter(w=>w.kind==='outer' && Math.abs(w.y1-w.y2)<.01 && w.y1>-.1).sort((a,b)=>a.x1+a.x2-b.x1-b.x2);
  ok('facade: the north outer faces are on one line',top.length===2 && Math.abs((top[0].y1+top[0].t/2)-(top[1].y1+top[1].t/2))<1e-6,JSON.stringify(top.map(w=>[w.y1,w.t])));
  near('facade: the inner face of A stays at 0',top[0].y1-top[0].t/2,0,1e-3); near('…and of B at 0.03',top[1].y1-top[1].t/2,.03,1e-3);
  R=K.spSolve('A1 at 0 0\nA2 at 4 0\nA3 at 4 -3\nA4 at 0 -3\npoly A1 A2 A3 A4\nB1 at 4.3 0.3\nB2 at 7.3 0.3\nB3 at 7.3 -2.7\nB4 at 4.3 -2.7\npoly B1 B2 B3 B4');
  ok('facade: a real step (30 cm) stays a step',new Set(K.spWalls(R,{}).walls.filter(w=>w.kind==='outer' && Math.abs(w.y1-w.y2)<.01 && w.y1>-.1).map(w=>(w.y1+w.t/2).toFixed(3))).size===2); }
// дом целиком: стены без дыр и без перекрытий (перекрытие удвоило бы потери на луче через стык)
{ R=K.spSolve('room zal 4.48 3.74 4.46 3.74 h 2.71\nroom kor 1.36 5.9 1.33 5.9\nroom our 3.28 2.98 3.28 3.01\nroom skl 4.45 3.1 4.45 3.1\nroom kit 3.27 3.88 3.25 3.89\nroom toi 1.32 1.04 1.32 1.04\nwall zal2-zal3 kor1-kor4 0.37\nwall kor2-kor3 kit1-kit4 0.38\nwall kor3-kor4 toi2-toi1 0.2\nwall our4-our1 toi3-toi2 0.38\nwall toi4-toi1 skl3-skl2 0.37\nmirror\nwindow zal1-zal4 0.92 2.03 h 1.43 sill 0.69\nwindow kit2-kit3 1.27 1.33 h 1.44 sill 0.72\nwindow our2-our3 0.87 1.32 h 1.45 sill 0.7\ndoor zal2-zal3 0.92 0.86 h 1.88\ndoor kor1-kor2 0.26 0.96 h 1.93\ndoor kor2-kor3 1.02 0.84 h 1.87\ndoor kor2-kor3 4.89 0.88 h 1.88\ndoor kor3-kor4 0.38 0.60 h 1.91\ndoor kor4-kor1 0.10 0.75 h 1.77'); const W=K.spWalls(R,{outer:R.outer});
  const inW=(x,y,e)=>W.walls.filter(w=>{ const dx=w.x2-w.x1, dy=w.y2-w.y1, L=Math.hypot(dx,dy), u=((x-w.x1)*dx+(y-w.y1)*dy)/L, v=Math.abs((x-w.x1)*dy-(y-w.y1)*dx)/L; return u>=-e && u<=L+e && v<=w.t/2+e; }).length;
  const Q=R.polys.map(pl=>pl.names.map(n=>{ const p=P(R,n); return [p.x,p.y]; }));
  const pip=(Z,x,y)=>{ let c=false; for(let i=0,j=Z.length-1;i<Z.length;j=i++) if((Z[i][1]>y)!==(Z[j][1]>y) && x<(Z[j][0]-Z[i][0])*(y-Z[i][1])/(Z[j][1]-Z[i][1])+Z[i][0]) c=!c; return c; };
  let xs=[], ys=[]; for(const w of W.walls){ xs.push(w.x1,w.x2); ys.push(w.y1,w.y2); }
  let holes=0, dbl=0; for(let x=Math.min(...xs)+.21;x<Math.max(...xs)-.21;x+=.02) for(let y=Math.min(...ys)+.21;y<Math.max(...ys)-.21;y+=.02){
    if(!Q.some(Z=>pip(Z,x,y)) && !inW(x,y,.004)) holes++; if(inW(x,y,-.004)>1) dbl++; }
  ok('house: no errors, all 9 openings placed',R.errors.length===0 && W.opens.length===9,JSON.stringify(R.errors)+W.opens.length);
  ok('house: no holes between the walls and the rooms',holes===0,holes);
  ok('house: no overlapping walls',dbl===0,dbl); }
// этажи, подвал, перекрытия, крыша
{ R=K.spSolve('room A 6 4 6 4\nlevel cellar z -2\nroom C 6 4 6 4 h 1.8\nsame C1 A1\nsame C2 A2\nlevel 2\nroom U 6 4 6 4 h 2.5\nsame U1 A1\nsame U2 A2\nroof gable 30 overhang 0.5');
  ok('levels: no errors, consistent',R.errors.length===0 && R.rms<.1,JSON.stringify(R.errors)+R.rms);
  ok('levels: numbered from the ground floor, the cellar is −1',JSON.stringify(R.levels.map(q=>[q.name,q.idx]))==='[["cellar",-1],["1",0],["2",1]]',JSON.stringify(R.levels));
  near('levels: an upper floor without z stands on the floor below + its height + the slab',R.levels[2].z,2.7+.25,1e-9);
  ok('levels: two «same» corners put the upper floor exactly above',R.pts.filter(p=>/^U/.test(p.name)).every(p=>!p.weak) && Math.abs(P(R,'U3').x-P(R,'A3').x)<.01 && Math.abs(P(R,'U3').y-P(R,'A3').y)<.01);
  const H=K.spHouse(R,{});
  ok('house: walls on each level at its floor',[-2,0,2.95].every(z=>H.walls.some(w=>Math.abs(w.z0-z)<1e-9)));
  ok('house: outer walls under an upper floor reach its floor (no gap in the facade)',H.walls.filter(w=>w.lv===0 && w.kind==='outer').every(w=>Math.abs(w.h-2.95)<1e-6),H.walls.filter(w=>w.lv===0).map(w=>w.h).join());
  ok('house: slabs under the ground floor and the upper floor, none under the cellar',H.slabs.length===2 && H.slabs.every(q=>q.lv>=0));
  const r=H.roofs[0], span=4+.8, len=6+.8, tg=Math.tan(30*Math.PI/180);
  near('roof: over the top floor, eaves = its top − overhang·tan',r.eave,2.95+2.5-.5*tg,1e-6);
  near('roof: ridge = top + span/2·tan',r.ridge,2.95+2.5+span/2*tg,1e-6);
  near('roof: gable slope area = 2·(len+2o)·(span/2+o)/cos',r.area,2*(len+1)*(span/2+.5)/Math.cos(30*Math.PI/180),1e-3);
  ok('roof: gable — 2 slopes and 2 gable walls',r.faces.filter(f=>f.kind==='roof').length===2 && r.faces.filter(f=>f.kind==='gable').length===2);
  for(const [t,nr] of [['hip',4],['shed',1],['flat',1]]){ R=K.spSolve('room A 6 4 6 4\nroof '+t+' 25'); const q=K.spHouse(R,{}).roofs[0]; ok('roof '+t+': '+nr+' slope(s)',q.faces.filter(f=>f.kind==='roof').length===nr); }
  R=K.spSolve('room A 6 4 6 4\nroof flat overhang 0.3'); near('flat roof area = (len+2o)(span+2o)',K.spHouse(R,{}).roofs[0].area,(6.8+.6)*(4.8+.6),1e-6);
  R=K.spSolve('room A 6 4 6 4\nroof dome'); ok('unknown roof type is an error',R.errors.length===1);
  R=K.spSolve('room A 6 4 6 4\nroof gable 30 level 7'); K.spHouse(R,{}); ok('roof over a missing level is reported',R.errors.some(e=>/no level/.test(e.msg))); }
// участок: забор, дорога, площадка, внешний источник
{ R=K.spSolve('H1 at 0 0\nH2 at 6 0\nroom H 6 4 6 4\nF1 at -5 5\nF2 at 15 5\nF3 at 15 -15\nF4 at -5 -15\nfence F1 F2 F3 F4 closed h 2 профлист\nR1 at -5 8\nR2 at 15 8\nroad R1 R2 w 4 asphalt\nG1 at 8 -2\nG2 at 14 -2\nG3 at 14 -12\nG4 at 8 -12\narea G1 G2 G3 G4 газон\nT at 300 400\nsource BS T h 30 eirp 46 f 1800 az 200 bw 65');
  ok('yard: no errors',R.errors.length===0,JSON.stringify(R.errors));
  const H=K.spHouse(R,{}), F=H.walls.filter(w=>w.kind==='fence');
  ok('fence: a closed contour of 4 runs, sheet metal (Russian name), 2 m',F.length===4 && F.every(w=>w.mat==='metal' && w.h===2 && w.t===.1));
  near('fence length',F.reduce((t,w)=>t+Math.hypot(w.x2-w.x1,w.y2-w.y1),0),80,1e-6);
  const road=H.grounds.find(g=>g.cover==='asphalt'), lawn=H.grounds.find(g=>g.cover==='grass'), pa=P=>{ let a=0; for(let i=0;i<P.length;i++){ const p=P[i], q=P[(i+1)%P.length]; a+=p[0]*q[1]-q[0]*p[1]; } return Math.abs(a)/2; };
  near('road: a strip 20 × 4 m',pa(road.poly),80,1e-6); near('lawn area 6 × 10',pa(lawn.poly),60,1e-6);
  const q=H.sources[0]; ok('source: above its point, with its EIRP, frequency and beam',q.name==='BS' && q.x===300 && q.y===400 && q.z===30 && q.eirp===46 && q.f===1800 && q.bw===65 && q.az===200,JSON.stringify(q));
  R=K.spSolve('fence A'); ok('fence needs two points',R.errors.length===1);
  R=K.spSolve('A at 0 0\nsource X A power 5'); ok('source: unknown key is an error',R.errors.length===1); }
{ const a=K.spFilePath('Plans/dacha'), b=K.spFilePath(' a\\b/../c.plan '), c=K.spFilePath('  ');
  ok('file path: folders and .txt',a.dirs.join('/')==='Plans' && a.name==='dacha.txt');
  ok('file path: backslash, «..» dropped, extension kept',b.dirs.join('/')==='a/b' && b.name==='c.plan');
  ok('file path: empty is null',c===null); }
{ const R=K.spSolve('room A 4 3 4 3\nmaterial шлакоблок'), H=K.spHouse(R,{outer:R.outer});
  ok('material шлакоблок: no errors, all walls block',R.errors.length===0 && H.walls.length>0 && H.walls.every(w=>w.mat==='block'),JSON.stringify(R.errors)); }
{ const R=K.spSolve('room A 5 4 5 4\nlight L1 A1 dx 2 dy 2 h 2.6\nswitch SW1 A1 dx 0.2 dy 0.1 h 1.1\nsocket S1 A3 dx -0.3 dy -0.3\nwire L1 SW1 S1 z 2.4'), e=Object.fromEntries(R.elec.map(x=>[x.name,x]));
  ok('electrics: no errors',R.errors.length===0,JSON.stringify(R.errors));
  near('light: A1 + (2, 2) east / north',Math.hypot(e.L1.x-P(R,'A1').x,e.L1.y-P(R,'A1').y),Math.SQRT2*2,1e-6); near('light height 2.6',e.L1.z,2.6,1e-6); ok('defaults: light 60 W, socket 200 W',e.L1.watt===60 && e.S1.watt===200);
  ok('wire chain L1 SW1 S1 → 2 wires, cable by endpoint',R.wires.length===2 && R.wires[0].cable==='3x1.5' && R.wires[1].cable==='3x2.5' && R.wires[0].z===2.4,JSON.stringify(R.wires));
  { const Q=K.spSolve('room A 5 4 5 4\ninlet IN1 A1 dx 0.1 h 3\npanel P1 A1 dx 0.3 dy -0.4\njunction J1 A2 dx -1 dy -0.5\nlight L1 A1 dx 2 dy -2\nwire IN1 P1 J1 L1'), e=Object.fromEntries(Q.elec.map(x=>[x.name,x]));
    ok('inlet, panel, junction box: heights 3 / 1.6 / 2.4, no power',Q.errors.length===0 && e.IN1.z===3 && e.P1.z===1.6 && Math.abs(e.J1.z-2.4)<1e-9 && e.P1.watt===0,JSON.stringify(Q.errors));
    ok('cable: inlet 5x2.5, then 3x1.5',Q.wires.length===3 && Q.wires[0].cable==='5x2.5' && Q.wires[1].cable==='3x1.5' && Q.wires[2].cable==='3x1.5',JSON.stringify(Q.wires)); }
  { const Q=K.spSolve('room A 5 4 5 4\nlight L1 A1\nlight L2 A2\nwire L1 L2 cable 2x1.5'), W=K.spSolve('room A 5 4 5 4\nlight L1 A1\nlight L2 A2\nwire L1 L2 cable abc');
    ok('any «NxS» cable is accepted: 2x1.5',Q.errors.length===0 && Q.wires[0].cable==='2x1.5',JSON.stringify(Q.errors)); ok('a nonsense cable is an error',W.errors.length===1 && /cross-section/.test(W.errors[0].msg)); }
  { const Q=K.spSolve('room A 5 4 5 4\npanel P1 A1 dx 0.3\nload LD1 A3 dx -0.5 w 3500\nwire P1 LD1 cable 3x2.5 amp 25'), l=Q.elec.find(x=>x.name==='LD1');
    ok('load: 0.3 m, own watts; wire amp 25',Q.errors.length===0 && l.type==='load' && l.z===Q.pts[2].z+.3 && l.watt===3500 && Q.wires[0].amp===25,JSON.stringify(Q.errors)+JSON.stringify(Q.wires));
    ok('load without w: 2000 W; bad amp is an error',K.spSolve('room A 5 4 5 4\nload LD1 A1').elec[0].watt===2000 && K.spSolve('room A 5 4 5 4\nload X A1\nload Y A2\nwire X Y amp 0').errors.length===1); }
  { const Q=K.spSolve('room A 5 4 5 4\nload H A1 w 9000 ph 3\nload X A2'); ok('load ph 3 → ph:3 in the result; default has none',Q.errors.length===0 && Q.elec[0].ph===3 && Q.elec[1].ph===undefined,JSON.stringify(Q.errors));
    ok('ph 2 and ph on a socket are errors',K.spSolve('room A 5 4 5 4\nload H A1 ph 2').errors.length===1 && K.spSolve('room A 5 4 5 4\nsocket H A1 ph 3').errors.length===1); }
  const B=K.spSolve('room A 4 3 4 3\nwire L1 L2'); ok('wire to an undeclared device is an error',B.errors.length>0 && /unknown device/.test(B.errors[0].msg)); }
// электрика на стене комнаты: «socket S1 A1-A2 along 1 off 0.1» — от угла A1 вдоль стены, вглубь комнаты
{ const R=K.spSolve('room A 4 3 4 3\nsocket S1 A1-A2 along 1 off 0.1 h 0.3\nsocket S2 A2-A1 along 1\nlight L1 A3-A4 along 2 off -0.2'), e=Object.fromEntries(R.elec.map(x=>[x.name,x])), a1=P(R,'A1'), a2=P(R,'A2'), a3=P(R,'A3');
  const cx=(a1.x+a3.x)/2, cy=(a1.y+a3.y)/2, L=Math.hypot(a2.x-a1.x,a2.y-a1.y), ux=(a2.x-a1.x)/L, uy=(a2.y-a1.y)/L;
  ok('wall devices: no errors',R.errors.length===0,JSON.stringify(R.errors));
  near('wall: S1 is 1 m from A1 along the wall',(e.S1.x-a1.x)*ux+(e.S1.y-a1.y)*uy,1,1e-6);
  near('wall: S1 is 0.1 m from the wall line',Math.abs((e.S1.x-a1.x)*(-uy)+(e.S1.y-a1.y)*ux),.1,1e-6);
  ok('wall: S1 shifted into the room (toward its centre)',(cx-a1.x)*(e.S1.x-a1.x-ux*1)+(cy-a1.y)*(e.S1.y-a1.y-uy*1)>0);
  near('wall: S2 along A2→A1, 1 m from A2',Math.hypot(e.S2.x-a2.x,e.S2.y-a2.y),1,1e-6); near('wall: S1 height',e.S1.z,.3,1e-6);
  { const a4=P(R,'A4'), l=Math.hypot(a4.x-a3.x,a4.y-a3.y), w={x:a3.x+(a4.x-a3.x)/l*2,y:a3.y+(a4.y-a3.y)/l*2};
    ok('wall: a negative off goes outside the room, 0.2 m from the wall',(cx-w.x)*(e.L1.x-w.x)+(cy-w.y)*(e.L1.y-w.y)<0 && Math.abs(Math.hypot(e.L1.x-w.x,e.L1.y-w.y)-.2)<1e-6); }
  ok('wall: the same spot after turning the plan (az 30)',(()=>{ const Q=K.spSolve('A at 0 0\nA-B az 30\nroom Q 4 3 4 3\nQ1 at 0 0\nQ1-Q2 az 30\nsocket S1 Q1-Q2 along 1 off 0.1'); return Q.errors.length===0 && Math.abs(Math.hypot(Q.elec[0].x-P(Q,'Q1').x,Q.elec[0].y-P(Q,'Q1').y)-Math.hypot(1,.1))<1e-3; })()); }
{ let Q=K.spSolve('room A 4 3 4 3\nsocket S1 A1-A3 along 1'); ok('a diagonal is not a wall',Q.errors.some(e=>/not a side/.test(e.msg)),JSON.stringify(Q.errors));
  Q=K.spSolve('room A 4 3 4 3\nsocket S1 A1-A2 along 9'); ok('along past the wall end is reported',Q.errors.some(e=>/past the end/.test(e.msg)),JSON.stringify(Q.errors));
  Q=K.spSolve('room A 4 3 4 3\nsocket S1 A1-A2 dx 1'); ok('dx on a wall is an error',Q.errors.length===1 && /for a point/.test(Q.errors[0].msg),JSON.stringify(Q.errors));
  Q=K.spSolve('room A 4 3 4 3\nsocket S1 A1 along 1'); ok('along at a point is an error',Q.errors.length===1 && /for a wall/.test(Q.errors[0].msg),JSON.stringify(Q.errors));
  Q=K.spSolve('room A 4 3 4 3\nsocket S1 A1-A1'); ok('a wall of one corner is an error',Q.errors.length===1,JSON.stringify(Q.errors)); }
// колышки и шнур вместо забора, контур участка без стен, фигуры с карты
{ const R=K.spSolve('A at 0 0\nB at 10 0\nC at 10 6\nD at 0 6\nplot A B C D\nfence A B C D closed stakes every 5'), H=K.spHouse(R,{});
  ok('stakes: no errors',R.errors.length===0,JSON.stringify(R.errors));
  ok('plot: area and perimeter, but no walls of its own',Math.abs(R.polys[0].area-60)<.02 && R.polys[0].plot===true && !H.walls.some(w=>w.kind==='outer'),JSON.stringify(H.walls.map(w=>w.kind)));
  ok('stakes: a cord (thin, no signal loss) between the corner pegs, 4 sides',H.walls.length===4 && H.walls.every(w=>w.mat==='cord' && w.t===.01 && w.kind==='fence'));
  ok('stakes: 4 corners + 1 per 10 m side (every 5), none extra on the 6 m side → 6',H.stakes.length===6,H.stakes.length);
  ok('stakes: default height 1 m, the cord near the top',H.stakes.every(q=>q.h===1) && H.walls.every(w=>Math.abs(w.z0-.96)<1e-9));
  const Q=K.spSolve('A at 0 0\nB at 10 0\nfence A B stakes h 0.8'), HQ=K.spHouse(Q,{});
  ok('stakes: an open line, two pegs at the ends, the given height',HQ.stakes.length===2 && HQ.stakes[0].h===.8 && HQ.walls.length===1,JSON.stringify(HQ.stakes));
  ok('«every» only for stakes',K.spSolve('A at 0 0\nB at 10 0\nfence A B mesh every 5').errors.length===1);
  const Z=K.spSolve('A at 0 0\nB at 10 0\nC at 10 6\nD at 0 6\nroom H 4 3 4 3\nH1 at 20 20\nplot A B C D'), HZ=K.spHouse(Z,{});
  ok('plot next to a room: only the room gets walls',HZ.walls.length>0 && HZ.walls.every(w=>w.x1>=15 && w.x2>=15),JSON.stringify(HZ.walls.slice(0,2))); }
{ const L=K.spRowToLine({gtype:'polygon',name:'house1',geom:JSON.stringify([[50.1,85.1],[50.1,85.2],[50.2,85.2]])}).split('\n');
  ok('map polygon → 3 GPS points and a poly',L.length===4 && /^house1_1 gps 50.1 85.1 ± 0.5$/.test(L[0]) && L[3]==='poly house1_1 house1_2 house1_3',L.join(' | '));
  ok('map polygon named plot… → plot',K.spRowToLine({gtype:'polygon',name:'plot',geom:[[50,85],[50,86],[51,86]]}).split('\n').pop()==='plot plot_1 plot_2 plot_3');
  ok('map polygon named fence… → a closed fence on stakes',K.spRowToLine({gtype:'polygon',name:'fence2',geom:[[50,85],[50,86],[51,86]]}).split('\n').pop()==='fence fence2_1 fence2_2 fence2_3 stakes closed');
  ok('map line → a fence on stakes',K.spRowToLine({gtype:'line',name:'L1',geom:[[50,85],[50,86]]}).split('\n').pop()==='fence L1_1 L1_2 stakes');
  ok('map shape with too few vertices → nothing',K.spRowToLine({gtype:'polygon',name:'x',geom:[[50,85],[50,86]]})==='' && K.spRowToLine({gtype:'polygon',name:'x',geom:'oops'})==='');
  const R=K.spSolve(K.spRowToLine({gtype:'polygon',name:'plot',geom:[[50.0001,85],[50,85.0003],[50.0002,85.0003]]}));
  ok('the lines from a map polygon solve without errors and give an area',R.errors.length===0 && R.polys[0].area>0 && R.georef,JSON.stringify(R.errors)); }
// запись с карты: занятое имя фигуры заменяется свободным
{ const ex='A gps 50 85 ±1\npoly polygon1_1 polygon1_2 polygon1_3\npolygon1_1 gps 50.1 85.1 ± 0.5\npolygon2_1 gps 50.2 85.2 ± 0.5\n# polygon3_1 in a comment';
  const L=['polygon1_1 gps 50.3 85.3 ± 0.5','polygon1_2 gps 50.3 85.4 ± 0.5','polygon1_3 gps 50.4 85.4 ± 0.5','poly polygon1_1 polygon1_2 polygon1_3'];
  const R=K.spUniqueNames(ex,L);
  ok('map write: polygon1 is taken (and polygon2) → polygon3, all lines renamed',R.length===4 && R[0]==='polygon3_1 gps 50.3 85.3 ± 0.5' && R[3]==='poly polygon3_1 polygon3_2 polygon3_3',R.join(' | '));
  ok('map write: a free name stays',K.spUniqueNames('A gps 1 1',L).join('|')===L.join('|'));
  const two=K.spUniqueNames('',L.concat(L.map(l=>l)).filter((l,i,a)=>true));
  ok('map write: two shapes with the same name in one batch get different names',new Set(two.filter(l=>/ gps /.test(l)).map(l=>l.split(' ')[0])).size===6,two.join(' | '));
  const S=K.spSolve(ex.replace('A gps 50 85 ±1','A gps 50 85 ±1')+'\n'+R.join('\n')); ok('map write: the result has no duplicate points',!S.errors.some(e=>/different points/.test(e.msg)) && S.pts.filter(p=>p.name==='polygon3_1').length===1); }
// столб (post) и навес (canopy)
{ const R=K.spSolve('A at 0 0\nB at 10 0\nC at 10 4\nD at 0 4\nroom H 10 4 10 4\nH1 at 0 0\nH2 at 10 0\nP at 5 -6\npost P h 3.2 d 0.25\ncanopy H1 H2 w 1.5 h 2.95 2.75 off 0.4 posts 2 5 8 d 0.12'), H=K.spHouse(R,{});
  ok('post+canopy: no errors',R.errors.length===0,JSON.stringify(R.errors));
  const p0=H.posts.find(q=>q.name==='P'); ok('post: at the point, given height and diameter',p0 && Math.abs(p0.x-5)<.05 && Math.abs(p0.y+6)<.05 && p0.h===3.2 && p0.d===.25,JSON.stringify(p0));
  const cp=H.posts.filter(q=>q.name==='canopy post'); ok('canopy: three columns at 2, 5, 8 m from A, height at the outer edge',cp.length===3 && cp.every(q=>q.h===2.75),JSON.stringify(cp));
  const rf=H.roofs.find(r=>r.type==='canopy'); ok('canopy: one slope, 10 m long, sloping from 2.95 to 2.75',rf && rf.faces.length===1 && rf.ridge===2.95 && rf.eave===2.75 && Math.abs(rf.area-10*Math.hypot(1.5,.2))<.01,rf && rf.area);
  const ys=rf.faces[0].pts.map(q=>q[1]), yo=Math.max(...ys.map(Math.abs)), yi=Math.min(...ys.map(Math.abs)), h3=R.pts.find(q=>q.name==='H3');
  ok('canopy: outside = away from the room, 0.4 m off the wall line, 1.5 m deep',Math.abs(yi-.4)<.05 && Math.abs(yo-1.9)<.05 && Math.sign(ys[0])===-Math.sign(h3.y),ys.join(',')+' H3.y='+h3.y); }
ok('post: bad height → error',K.spSolve('P at 0 0\npost P h -1').errors.length===1 && K.spSolve('P at 0 0\npost P x 1').errors.length===1);
ok('canopy: A = B → error',K.spSolve('P at 0 0\ncanopy P P').errors.length===1);
// outer по комнатам / сторонам и колонны ends
{ const R=K.spSolve('outer 0.4 brick\nroom A 6 4 6 4\nroom B 3 4 3 4\nwall A2-A3 B1-B4 0.2\nA1 at 0 0\nA2 at 6 0\nouter B 0.04 дерево\nouter A1-A2 0.1'), H=K.spHouse(R,{});
  ok('outer by room: no errors',R.errors.length===0,JSON.stringify(R.errors));
  const ow=H.walls.filter(w=>w.kind==='outer'), b=ow.filter(w=>/spw:B/.test(w.id)), a1=ow.find(w=>/spw:A1-A2/.test(w.id)), a3=ow.find(w=>/spw:A3-A4/.test(w.id));
  ok('outer B 0.04 wood: outer sides of B are 4 cm wood',b.length>0 && b.every(w=>w.t===.04 && w.mat==='wood'),JSON.stringify(b.map(w=>[w.id,w.t,w.mat])));
  ok('outer A1-A2 0.1: one side of A',a1 && a1.t===.1,a1 && a1.t); ok('other sides of A stay at the general outer 0.4 (brick)',a3 && a3.t===.4 && a3.mat==='brick',JSON.stringify(a3));
  ok('the wall between A and B stays inner',H.walls.some(w=>w.kind==='inner' && Math.abs(w.t-.2)<.02)); }
ok('outer: unknown room → error',K.spSolve('A1 at 0 0\nroom A 3 3 3 3\nouter Zed 0.04').errors.length===1 && K.spSolve('room A 3 3 3 3\nouter A').errors.length===1);
{ const H=K.spHouse(K.spSolve('H1 at 0 0\nH2 at 10 0\nroom H 10 4 10 4\ncanopy H1 H2 w 1.5 h 3 2.8 off 0.04 posts 5 ends d 0.1'),{}), cp=H.posts.filter(q=>q.name==='canopy post');
  ok('canopy ends: a column at each end (inset by d/2) + the given one → 3',cp.length===3,cp.length);
  const R=K.spSolve('H1 at 0 0\nH2 at 10 0\nroom H 10 4 10 4\ncanopy H1 H2 off 0.04'), r=K.spHouse(R,{}).roofs.find(r=>r.type==='canopy'); ok('canopy: off 0.04 → the slope starts 4 cm from the line',r && Math.abs(Math.min(...r.faces[0].pts.map(q=>Math.abs(q[1])))-.04)<.01); }
console.log(bad?('\n'+bad+' FAILED'):'\nall ok'); process.exit(bad?1:0);
