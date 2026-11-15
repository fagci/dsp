// Накопление пика и среднего за кадр вывода (modules/specacc-kernels.js). Проверка: node tools/test-specacc.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,Float64Array});
vm.runInContext(fs.readFileSync(path.join(root,'modules/specacc-kernels.js'),'utf8')+';globalThis.K={specAccPlan,specAccNew,specAccAdd,specAccTake,specAccKmax};',ctx);
const K=ctx.K; let bad=0; const ok=(c,m)=>{ if(!c){ bad++; console.log('FAIL',m); } };
const N=1024, hop=512;
// план: покрытие без дыр — окно = новые + N/2, K кадров по шагу N/2 укладываются в L
let p=K.specAccPlan(10000,50000,N,1000); ok(p.L===10000+hop && p.K===Math.floor((p.L-N)/hop)+1 && p.stride===1 && p.cover===1 && !p.auto,'plan basic '+JSON.stringify(p));
ok((p.K-1)*hop+N<=p.L && p.K*hop+N>p.L,'frames tile the window');
p=K.specAccPlan(100,50000,N,1000); ok(p.L===N && p.K===1,'few new samples: one frame');
const q=K.specAccPlan(10000,5000,N,1000); ok(q.L<=5000,'limited by avail');
// перегруз: шаг растёт сам, пропуски ровные, число БПФ в потолке, покрытие падает
p=K.specAccPlan(1e6,4e6,N,10); ok(p.auto && p.K<=10 && p.stride===Math.ceil(p.Kfull/10) && p.cover<1 && p.cover>0,'auto stride: '+JSON.stringify(p));
ok(K.specAccPlan(10,100,N,10).K===0,'not enough data');
// без перекрытия вдвое меньше БПФ при том же окне; покрытие 100 %
const a1=K.specAccPlan(100000,200000,N,1e6), a2=K.specAccPlan(100000,200000,N,1e6,N);
ok(Math.abs(a2.K*2-a1.K)<=2 && a2.cover===1,'no overlap halves the FFTs '+a1.K+' → '+a2.K);
// покрытие 25 %: каждый 8-й кадр при шаге N/2 даёт N/(8·N/2)=25 %
const c=K.specAccPlan(100000,200000,N,1e6,hop,4); ok(c.stride===4 && Math.abs(c.cover-.5)<1e-9 && c.K===Math.ceil(c.Kfull/4),'coverage 50 % at stride 4 '+JSON.stringify(c));
const c2=K.specAccPlan(100000,200000,N,1e6,hop,8); ok(Math.abs(c2.cover-.25)<1e-9,'coverage 25 %');
ok(K.specAccPlan(100000,200000,N,1e6,hop,2).cover===1,'overlap + stride 2 still covers all the time');
// накопитель: пик короткого всплеска не размазывается, среднее взвешено по K
const a=K.specAccNew(4);
K.specAccAdd(a,new Float32Array([1,1,1,1]),new Float32Array([1,1,1,1]),3);
K.specAccAdd(a,new Float32Array([1,2,1,1]),new Float32Array([1,5,1,1]),1);   // один кадр со всплеском 5 в бине 1
const r=K.specAccTake(a);
ok(r.max[1]===5 && r.max[0]===1,'peak kept');
ok(Math.abs(r.avg[1]-Math.sqrt((3*1+4)/4))<1e-6,'weighted mean power '+r.avg[1]);
ok(r.K===4,'K sum');
ok(K.specAccTake(a)===null,'reset after take');
K.specAccAdd(a,new Float32Array([1,1,1,1]),new Float32Array([1,1,1,1]),1);
ok(K.specAccTake(a).max[1]===1,'peak reset');
ok(K.specAccKmax(0.1,50)===175 && K.specAccKmax(0,50)===256 && K.specAccKmax(100,5)===1,'kmax');
console.log(bad?bad+' failed':'ok');
process.exit(bad?1:0);
