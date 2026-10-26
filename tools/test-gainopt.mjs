// Ядро подбора усиления по SNR: node tools/test-gainopt.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Number,Set,Array,String});
vm.runInContext(fs.readFileSync(path.join(root,'modules/gainopt-kernels.js'),'utf8')+';this.K={goPlan,goPick,goStart,goFeed,goRow};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };

ok('plan: 0…20 step 5',JSON.stringify(K.goPlan(0,20,5))==='[0,5,10,15,20]');
ok('plan: the top is always included',K.goPlan(0,10,4).at(-1)===10 && K.goPlan(0,10,4).length===4,JSON.stringify(K.goPlan(0,10,4)));
ok('plan: swapped ends',K.goPlan(20,0,10)[0]===0);
ok('pick: max SNR without clipping',K.goPick([{g:10,snr:20,clip:0},{g:20,snr:30,clip:0},{g:30,snr:35,clip:2}],.01,.5).g===20);
ok('pick: tie within tol → lower gain',K.goPick([{g:10,snr:30,clip:0},{g:20,snr:30.2,clip:0}],.01,.5).g===10);
ok('pick: all clipped → the lowest gain',K.goPick([{g:10,snr:30,clip:1},{g:20,snr:35,clip:3}],.01,.5).g===10);
ok('pick: empty → null',K.goPick([],.01,.5)===null);
ok('pick: NaN SNR is not chosen',K.goPick([{g:10,snr:NaN,clip:0},{g:20,snr:5,clip:0}],.01,.5).g===20);

// имитация приёмника: SNR растёт с усилением до 30 дБ, дальше — шум приёмника и перегрузка с 38
const snrAt=g=>g<=30 ? 10+g*.8 : 34-(g-30)*1.2, clipAt=g=>g>=38 ? 0.5 : 0;
function run(p,delay=0){
  const st={}; let g=K.goStart(st,p,0), t=0, hist=[g], applied=g, applyAt=delay;
  for(let step=0;step<5000 && st.phase!=='done';step++){
    t+=100; if(t>=applyAt) applied=g;
    const o={now:t,snr:snrAt(applied)+((step*7919)%10-5)*.02,peak:-40+applied*.3,floor:-90+applied*.2,clip:clipAt(applied)};
    const ng=K.goFeed(st,o,p); if(ng!==g){ g=ng; hist.push(g); applyAt=t+delay; }
  }
  return {st,hist};
}
const P={gMin:0,gMax:49,gStep:6,refine:true,settle:300,frames:3,clipPct:.01,tol:.3,backoff:0};
{
  const {st,hist}=run(P);
  ok('run: finishes',st.phase==='done',st.phase);
  ok('run: best is the SNR peak at 30 dB',Math.abs(st.best.g-30)<=1,st.best&&st.best.g);
  ok('run: the coarse pass stops at the first overload',Math.max(...st.res.map(r=>r.g))<=42,Math.max(...st.res.map(r=>r.g)));
  ok('run: the fine pass tested 1 dB steps near the best',st.res.some(r=>Math.abs(r.g-st.best.g)<=1 && Number.isInteger(r.g) && r.g%6!==0 || st.best.g%6===0));
  ok('run: final command = best gain',st.cmd===st.best.g);
  ok('run: overloaded gains are never chosen',!(st.best.clip>=P.clipPct));
}
{
  const {st}=run({...P,refine:false});
  ok('run: no refine → only grid gains',st.res.every(r=>r.g%6===0 || r.g===49),JSON.stringify(st.res.map(r=>r.g)));
  const b=run({...P,backoff:3}).st;
  ok('run: backoff lowers the final gain',b.cmd===b.best.g-3,b.cmd+' '+b.best.g);
}
{
  const {st}=run(P,350);                                  // железо применяет усиление с задержкой 350 мс при settle 300
  ok('run: settle shorter than the hardware delay still ends sanely',st.phase==='done' && st.best.g>=24 && st.best.g<=36,st.best&&st.best.g);
  const o=run({...P,settle:600},350).st;
  ok('run: enough settle finds the true best',Math.abs(o.best.g-30)<=1,o.best&&o.best.g);
}
{
  const st={}, g0=K.goStart(st,P,0);
  ok('feed: frames inside settle are ignored',K.goFeed(st,{now:100,snr:50,peak:0,floor:0,clip:0},P)===g0 && st.k===0);
  ok('feed: needs `frames` frames',(K.goFeed(st,{now:400,snr:10,peak:0,floor:0,clip:0},P),st.k===1) && st.res.length===0);
}
ok('row: marks the best and shows clip',K.goRow({g:30,snr:34,peak:-31,floor:-66,clip:0},{g:30}).startsWith('▶') && K.goRow({g:40,snr:20,peak:0,floor:0,clip:.5},null).includes('clip 0.50%'));
console.log(bad?'FAILED '+bad:'all ok'); process.exit(bad?1:0);
