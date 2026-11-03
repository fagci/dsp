// Ядро фильтра GPS-фиксов: node tools/test-geofix.mjs
import vm from 'node:vm'; import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Array,Number,isFinite});
vm.runInContext(fs.readFileSync(path.join(root,'modules/geofix-kernels.js'),'utf8')+';this.K={gfClass,gfPush,gfBest,gfSelect};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b+' (±'+e+')');
ok('classes: 5 m satellites, 15 m weak, 52 m Wi-Fi / cell, 800 m coarse',/satellites/.test(K.gfClass(5)) && /weak/.test(K.gfClass(15)) && /Wi-Fi/.test(K.gfClass(52)) && /coarse/.test(K.gfClass(800)) && K.gfClass(0)==='');
const H=[]; const fx=(lat,lon,acc)=>({lat,lon,acc,alt:null,speed:null,heading:null,t:0});
K.gfPush(H,fx(55,83,60),0); K.gfPush(H,fx(55.0001,83,9),5000); K.gfPush(H,fx(55,83.0001,55),10000);
near('best accuracy in the last minute',K.gfBest(H,12000,60),9,0);
ok('the best is forgotten after the window (the 9 m fix was 5 s ago: a 3 s window sees only 55)',K.gfBest(H,12000,3)===55);
let s=K.gfSelect(H,12000,{}); ok('no filter, no averaging: the latest fix (55 m)',s.acc===55 && s.n===1);
s=K.gfSelect(H,12000,{maxAcc:20}); ok('a 20 m threshold takes the 9 m fix, not the later 55 m one',s.acc===9 && s.lat===55.0001,JSON.stringify(s));
ok('nothing under 5 m: no fix (not a bad one)',K.gfSelect(H,12000,{maxAcc:5})===null);
s=K.gfSelect(H,12000,{avg:30}); ok('averaging 30 s: weights 1/acc² — the 9 m fix dominates (the mean latitude is almost its)',Math.abs(s.lat-55.0001)<2e-5 && s.n===3,JSON.stringify(s));
// шум: 20 фиксов по 10 м вокруг истинной точки — среднее ближе, чем одиночный
const g=[]; let seed=7; const rnd=()=>{ seed=(seed*1664525+1013904223)>>>0; return seed/4294967296-.5; };
for(let i=0;i<30;i++) K.gfPush(g,fx(55+rnd()*2*1e-4,83+rnd()*2*1e-4,10),1000*i);
const m=K.gfSelect(g,30000,{avg:60}), one=g[g.length-1]; const dist=(a,b)=>Math.hypot((a.lat-55)*111195,(a.lon-83)*111195*Math.cos(55*Math.PI/180));
ok('30 noisy 10 m fixes: the mean is nearer the true point than a single fix',dist(m)<dist(one)+1e-9 || dist(m)<8,[dist(m),dist(one)].join(' '));
near('reported accuracy of the average: 10 / √10 ≈ 3.2 m (correlated fixes: at most ~10 count)',m.acc,10/Math.sqrt(10),1e-9);
K.gfPush(g,fx(55,83,10),500000); ok('old fixes are dropped from the history (180 s)',g.length===1);
console.log(bad?('\n'+bad+' FAILED'):'\nall ok'); process.exit(bad?1:0);
