// Жгуты проводов: геометрия bundleCurves из core-graph.js: node tools/test-bundle.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const src=fs.readFileSync(path.join(root,'core-graph.js'),'utf8');
const a=src.indexOf('// сегмент кривой'), b=src.indexOf('/* ---- история, выделение');
const code=src.slice(a,b).replace(/^try\{ bundleOn=.*$/m,'').replace('const ds','');
const ctx=vm.createContext({Math,Map,Array,clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))});
vm.runInContext(code+';this.f=bundleCurves',ctx);
const f=ctx.f;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const it=(from,to,x1,y1,x2,y2)=>({from,to,p1:{x:x1,y:y1},p2:{x:x2,y:y2}});
const nums=d=>d.match(/-?\d+(\.\d+)?/g).map(Number);
const ends=(d)=>{ const n=nums(d); return [n[0],n[1],n[n.length-2],n[n.length-1]]; };

ok('lone wire is not bundled',f([it('a','b',0,0,300,0)])[0]===undefined);
ok('two wires of unrelated pairs are not bundled',f([it('a','b',0,0,300,0),it('c','d',0,10,300,10)]).every(d=>d===undefined));
const r=f([it('a','b',0,0,300,0),it('a','b',0,20,300,40),it('a','b',0,40,300,20),it('c','d',0,0,300,0)]);
ok('three wires of a pair get a path, a lone one does not',r[0]&&r[1]&&r[2]&&r[3]===undefined);
ok('each path starts and ends at its own ports',[[0,0,0,300,0],[1,0,20,300,40],[2,0,40,300,20]].every(([i,x1,y1,x2,y2])=>{
  const [sx,sy,ex,ey]=ends(r[i]); return sx===x1+8000&&sy===y1+8000&&ex===x2+8000&&ey===y2+8000; }));
// конец веера у выходов (6-е и 7-е числа M+C: 2+6 → индексы 8,9) — на нём провода лежат рядом
const fanY=[0,1,2].map(i=>nums(r[i])[9]).sort((p,q)=>p-q);
ok('lanes are 3 px apart',fanY[1]-fanY[0]===3&&fanY[2]-fanY[1]===3,fanY.join());
// провода из одного узла к разным узлам делят ствол у выхода и расходятся
const fo=f([it('a','b',0,0,300,0),it('a','c',0,10,300,200)]);
ok('fan-out to different nodes shares a trunk',fo[0]&&fo[1]&&Math.abs(nums(fo[0])[8]-nums(fo[1])[8])<1e-9);
ok('fan-out wires still end at their own inputs',ends(fo[0])[3]===8000&&ends(fo[1])[3]===8200);
// провода из разных узлов в один — сходятся у входа
const fi=f([it('a','c',0,0,300,50),it('b','c',0,100,300,60)]);
ok('fan-in from different nodes converges',fi[0]&&fi[1]);
// тесные узлы: веера нет, но и ошибок нет
ok('close nodes get no fan',f([it('a','b',0,0,20,0),it('a','b',0,10,20,10)]).every(d=>d===undefined));
// вход левее выхода: веер не строится у стороны без места, путь всё равно непрерывный
const back=f([it('a','b',200,0,100,0),it('a','b',200,10,100,10)]);
ok('backward wires are not bundled',back.every(d=>d===undefined));
// веер у выхода: у узла с несколькими выходами отдалённый вход правее самого дальнего выхода
const fan=f([it('a','b',0,0,300,0),it('a','b',20,10,320,10)]);
ok('fan starts right of the farthest output',nums(fan[0])[6]>=20+8000);
// «одна сторона»: два входа в один узел от одного источника с другого узла, но целям тесно — путь строится, концы целы
const one=f([it('a','b',0,0,300,0),it('c','b',0,30,300,10),it('a','d',0,0,20,100)]);
ok('every path is finite',one.every(d=>d===undefined||nums(d).every(Number.isFinite)));
console.log(bad?'FAILED':'all ok'); process.exit(bad?1:0);
