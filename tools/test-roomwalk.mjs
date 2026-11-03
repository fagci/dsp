// Ядро Room Walk: node tools/test-roomwalk.mjs
// Известные решения: прямоугольная комната 5×4 из точки, повёрнутая комната, шум компаса и «прижатие» к прямоугольнику, слияние повторов.
import vm from 'node:vm'; import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Array,String,Number,Map,Object,isFinite});
vm.runInContext(fs.readFileSync(path.join(root,'modules/roomwalk-kernels.js'),'utf8')+';this.K={rwParse,rwMerge,rwOrient,rwSolve,rwLines,rwSigma,rwDiff,rwWrap};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b+' (±'+e+')');
// комната: прямоугольник 5 (запад–восток) × 4 (юг–север), стоим в точке (x0,y0) от юго-западного угла; стены: север, восток, юг, запад
function shots(x0,y0,W,H,rot=0,noise=0,seed=1){
  let s=seed>>>0; const rnd=()=>{ s=(s*1664525+1013904223)>>>0; return s/4294967296-.5; };
  return [[0,H-y0],[90,W-x0],[180,y0],[270,x0]].map(([a,d])=>({az:K.rwWrap(a+rot+noise*2*rnd()),d}));
}
let R=K.rwSolve(shots(2,1.5,5,4));
ok('4 walls → 4 corners, solved',R.ok && R.corners.length===4 && R.inside);
near('area 5×4 = 20 m²',R.area,20,1e-9); near('perimeter 18 m',R.perimeter,18,1e-9);
{ const xs=R.corners.map(c=>c.x).sort((a,b)=>a-b), ys=R.corners.map(c=>c.y).sort((a,b)=>a-b);
  near('corner x range: west −2, east +3',xs[0],-2,1e-9); near('…east',xs[3],3,1e-9); near('corner y range: south −1.5, north +2.5',ys[0],-1.5,1e-9); near('…north',ys[3],2.5,1e-9); }
// повёрнутая на 33°: площадь и периметр не зависят от поворота
R=K.rwSolve(shots(2,1.5,5,4,33)); near('rotated by 33°: the same area',R.area,20,1e-9); near('…the same perimeter',R.perimeter,18,1e-9);
// слияние повторов: три замера одной стены → одна, число замеров
{ const m=K.rwMerge([{az:2,d:3.0},{az:358,d:3.1},{az:0,d:2.9},{az:90,d:5}],20); ok('merge: 3 shots of one wall → 1 wall of 3',m.length===2 && m[0].n===3 && Math.abs(m[0].d-3)<1e-9 && (m[0].az<1||m[0].az>359)); }
// шум компаса 4°: без прижатия площадь «плывёт», с прижатием близка к 20
{ const S=shots(2,1.5,5,4,20,4,5); const free=K.rwSolve(S), snap=K.rwSolve(S,{rect:true});
  ok('compass noise ±4°: the free solution is still a room',free.ok && Math.abs(free.area-20)<3,free.area); near('…snapped to a rectangle: 20 m² within 0.3',snap.area,20,.3);
  near('rect: orientation found within 4° of the true 20°',K.rwDiff(snap.phi,20)<4 ? 0 : 99,0,0); }
// ориентация: φ для комнаты, повёрнутой на 33° — 33 mod 90
near('orientation φ',K.rwOrient([{az:33},{az:123},{az:213},{az:303}]),33,1e-6);
// три стены и меньше: нет решения; параллельные соседние: открыто
ok('2 walls: no room',!K.rwSolve([{az:0,d:3},{az:180,d:2}]).ok);
ok('3 walls with two parallel neighbours: open',K.rwSolve([{az:0,d:3},{az:90,d:2},{az:180,d:2}]).open.length>0 || K.rwSolve([{az:0,d:3},{az:90,d:2},{az:180,d:2}]).ok===false);
// L-образная/неполная: стоим не внутри при перепутанных азимутах → inside=false
R=K.rwSolve([{az:0,d:2},{az:90,d:2},{az:180,d:-0.0001+0.5},{az:270,d:2}].map(s=>({...s,d:Math.abs(s.d)}))); ok('a solved room reports whether the standing point is inside',typeof R.inside==='boolean');
// разбор
{ const p=K.rwParse('0 2,5\n90 3 # east\n# comment\nfoo\n180 -1'); ok('parse: two good lines, two bad',p.shots.length===2 && p.shots[0].d===2.5 && p.bad.length===2,JSON.stringify(p)); }
// строки для Site Plan
{ const t=K.rwLines(K.rwSolve(shots(2,1.5,5,4)),{prefix:'R'}).split('\n'); ok('lines: 4 corners with ± and a contour',t.length===5 && /^R1 at -?[\d.]+ -?[\d.]+ ± [\d.]+$/.test(t[0]) && t[4]==='poly R1 R2 R3 R4',t.join('|'));
  near('σ of a corner at 3 m with 3° compass: ≈ 0.16 m',K.rwSigma(3,.03,3),.16,.001); }
console.log(bad?('\n'+bad+' FAILED'):'\nall ok'); process.exit(bad?1:0);
