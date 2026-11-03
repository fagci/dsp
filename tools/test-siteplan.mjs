// Ядро Site Plan: node tools/test-siteplan.mjs
// Известные решения: прямоугольник с диагональю, замкнутый ход с невязкой, клинометр, GPS + рулетка, вес замеров, 3D по dz, экспорт.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float64Array,Float32Array,Set,Map,Number,String,JSON,isFinite,Infinity,Array,Object});
vm.runInContext(fs.readFileSync(path.join(root,'modules/siteplan-kernels.js'),'utf8')+';this.K={spSolve,spParse,spTilt,spPoly,spDXF,spGeoJSON,spSVG,spCSV,spFrame};',ctx);
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
console.log(bad?('\n'+bad+' FAILED'):'\nall ok'); process.exit(bad?1:0);
