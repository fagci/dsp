// YAMNet (логика без сети и модели): node tools/test-yamnet.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,Array,Set,Map,String});
vm.runInContext(fs.readFileSync(path.join(root,'modules/yamnet-kernels.js'),'utf8')+';this.T={ynRing,ynTop,ynClasses,ynWatch,ynText,ynTo16k};',ctx);
const T=ctx.T;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };

const r=T.ynRing(5); r.push(Float32Array.of(1,2,3));
ok('ring partial',r.filled===3 && r.get().join()==='0,0,1,2,3');
r.push(Float32Array.of(4,5,6,7));
ok('ring wraps in order',r.filled===5 && r.get().join()==='3,4,5,6,7',r.get().join());
r.clear(); ok('ring clear',r.filled===0 && r.get().every(v=>v===0));

const res=[{classifications:[{categories:[{categoryName:'Speech',displayName:'Speech',score:.8},{categoryName:'Music',displayName:'',score:.3},{categoryName:'Dog',score:.05}]}]},
           {classifications:[{categories:[{categoryName:'Speech',score:.9},{categoryName:'Siren',score:.4}]}]}];
const top=T.ynTop(res,3,.1);
ok('top merges chunks by max',top[0].label==='Speech' && top[0].score===.9 && top.length===3 && top[1].label==='Siren' && top[2].label==='Music',JSON.stringify(top));
ok('top min score',T.ynTop(res,5,.5).length===1 && T.ynTop([],3,0).length===0 && T.ynTop(null,3,0).length===0);
ok('top n≥1',T.ynTop(res,0,0).length===1);
ok('classes parse',T.ynClasses(' Speech, siren;\n dog ').size===3 && T.ynClasses(' , ')===null && T.ynClasses('')===null);
const w=T.ynClasses('speech, siren');
ok('watch substring',T.ynWatch([{label:'Male speech, man speaking',score:.7}],w,.5)?.label==='Male speech, man speaking');
ok('watch threshold',T.ynWatch([{label:'Speech',score:.3}],w,.5)===null && T.ynWatch([{label:'Dog',score:.9}],w,.5)===null && T.ynWatch([{label:'Speech',score:.9}],null,.5)===null);
ok('text',T.ynText(top).split('\n')[0]==='Speech 90%' && T.ynText([]).startsWith('silence'));
// пересчёт окна в 16 кГц: длина ровно 15600, частота и амплитуда синуса сохраняются, постоянная составляющая тоже
for(const sr of [48000,44100,16000,8000]){
  const N=Math.round(sr*.975), x=new Float32Array(N), f=sr>=16000 ? 1000 : 500;
  for(let i=0;i<N;i++) x[i]=Math.sin(2*Math.PI*f*i/sr)*.5+.2;
  const y=T.ynTo16k(x);
  let z=0, pk=0; for(let i=1;i<y.length;i++){ if(y[i-1]-.2<=0 && y[i]-.2>0) z++; pk=Math.max(pk,Math.abs(y[i]-.2)); }
  const hz=z/.975, mean=y.reduce((a,b)=>a+b,0)/y.length;
  ok('to16k '+sr,y.length===15600 && Math.abs(hz-f)<3 && Math.abs(mean-.2)<.01 && (sr>=16000 ? Math.abs(pk-.5)<.05 : pk>.3),'len '+y.length+' Hz '+hz.toFixed(1)+' peak '+pk.toFixed(2)+' mean '+mean.toFixed(3));
}
{
  const hi=new Float32Array(46800); for(let i=0;i<hi.length;i++) hi[i]=(i&1?1:-1)*.5;     // 24 кГц на 48 кГц: выше полосы 16 кГц (8 кГц) — должно глушиться
  const y=T.ynTo16k(hi); let m=0; for(const v of y) m=Math.max(m,Math.abs(v));
  ok('to16k antialias (≥9 dB at 24 kHz)',m<.17,m.toFixed(3));
}
console.log(bad ? bad+' failed' : 'all ok'); process.exit(bad?1:0);
