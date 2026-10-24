// Жгуты проводов: геометрия bundleCurves из core-graph.js: node tools/test-bundle.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const src=fs.readFileSync(path.join(root,'core-graph.js'),'utf8');
const a=src.indexOf('const BUNDLE_MIN_SPAN'), b=src.indexOf('/* ---- история, выделение');
const code=src.slice(a,b).replace(/^try\{ bundleOn=.*$/m,'');
const ctx=vm.createContext({Math,Map,Array});
vm.runInContext(code+';this.f=bundleCurves',ctx);
const f=ctx.f;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const it=(key,x1,y1,x2,y2)=>({key,p1:{x:x1,y:y1},p2:{x:x2,y:y2}});
const nums=d=>d.match(/-?\d+(\.\d+)?/g).map(Number);

ok('one wire is not bundled',f([it('a',0,0,300,0)])[0]===undefined);
ok('two different pairs are not bundled',f([it('a',0,0,300,0),it('b',0,10,300,10)]).every(d=>d===undefined));
const r=f([it('a',0,0,300,0),it('a',0,20,300,40),it('a',0,40,300,20),it('b',0,0,300,0)]);
ok('three wires of a pair get a path, the other pair does not',r[0]&&r[1]&&r[2]&&r[3]===undefined);
ok('each path starts and ends at its own ports',[[0,0,0,300,0],[1,0,20,300,40],[2,0,40,300,20]].every(([i,x1,y1,x2,y2])=>{
  const n=nums(r[i]); return n[0]===x1+8000&&n[1]===y1+8000&&n[n.length-2]===x2+8000&&n[n.length-1]===y2+8000; }));
// на магистрали (середина среднего сегмента) провода лежат рядом: разброс по y — (m-1)*3
const trunkY=[0,1,2].map(i=>{ const n=nums(r[i]); return n[11]; }).sort((p,q)=>p-q);
ok('lanes are 3 px apart',trunkY[1]-trunkY[0]===3&&trunkY[2]-trunkY[1]===3,trunkY.join());
const tight=f([it('a',0,0,50,0),it('a',0,10,50,10)]);
ok('close nodes are not bundled',tight.every(d=>d===undefined));
const back=f([it('a',200,0,100,0),it('a',200,10,100,10)]);
ok('backward wires are not bundled',back.every(d=>d===undefined));
const fan=f([it('a',0,0,300,0),it('a',20,10,320,10)]);   // порты на разной глубине — веер начинается правее самого дальнего выхода
ok('fan starts right of the farthest output',nums(fan[0])[6]>=20+8000);
console.log(bad?'FAILED':'all ok'); process.exit(bad?1:0);
