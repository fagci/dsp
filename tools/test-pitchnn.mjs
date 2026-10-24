// Basic Pitch (логика без модели): node tools/test-pitchnn.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,Array,Set,Map});
vm.runInContext(fs.readFileSync(path.join(root,'modules/pitchnn-kernels.js'),'utf8')+';this.T={bpName,bpFreq,bpActive,bpNew,bpText,BP_FRAMES,BP_BINS,BP_LOW};',ctx);
const T=ctx.T;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };
ok('names',T.bpName(60)==='C4' && T.bpName(69)==='A4' && T.bpName(21)==='A0' && T.bpName(108)==='C8' && T.bpName(61)==='C#4');
ok('freq',Math.abs(T.bpFreq(69)-440)<1e-9 && Math.abs(T.bpFreq(60)-261.6256)<1e-3);
const mk=pairs=>{ const f=new Float32Array(T.BP_FRAMES*T.BP_BINS); for(const [midi,v,t0,t1] of pairs) for(let t=t0;t<t1;t++) f[t*T.BP_BINS+(midi-T.BP_LOW)]=v; return f; };
// аккорд C-E-G звучит в последних кадрах; шум ниже порога и «растёкшийся» пик (соседняя высота) схлопывается
let f=mk([[60,.9,100,172],[64,.8,100,172],[67,.7,100,172],[72,.1,0,172],[61,.4,100,172]]);
let a=T.bpActive(f,.3);
ok('chord found, neighbour merged',a.map(n=>n.midi).join()==='60,64,67',a.map(n=>n.name).join(' '));
ok('text',T.bpText(a)==='C4 E4 G4' && T.bpText([])==='—');
f=mk([[60,.9,0,100]]);
ok('note that ended is not active',T.bpActive(f,.3).length===0);
f=mk([[60,.9,169,172]]);
ok('last frames ignored',T.bpActive(f,.3).length===0);
ok('array-of-arrays input',T.bpActive(Array.from({length:T.BP_FRAMES},(_,t)=>Array.from({length:T.BP_BINS},(_,b)=>b===39?.9:0)),.3)[0].midi===60);
const b=T.bpNew([{midi:60}],[{midi:60},{midi:64}]);
ok('new notes only',b.length===1 && b[0].midi===64 && T.bpNew(null,[{midi:60}]).length===1);
console.log(bad ? bad+' failed' : 'all ok'); process.exit(bad?1:0);
