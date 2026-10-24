// Нейросети для звука (потоковая обмотка): node tools/test-nnaudio.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,Array});
vm.runInContext(fs.readFileSync(path.join(root,'modules/nnaudio-kernels.js'),'utf8')+';this.T={nnResampler,nnStream};',ctx);
const T=ctx.T;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };

// 48 кГц, кадр 480, блок 512 (не кратен кадру): тождественная модель даёт сигнал с задержкой latency, без разрывов
{
  const sr=48000, B=512, st=T.nnStream(sr,48000,480,f=>Float32Array.from(f));
  const N=B*40, x=new Float32Array(N); for(let i=0;i<N;i++) x[i]=Math.sin(i*.05)*.5+Math.sin(i*.31)*.2;
  const y=new Float32Array(N);
  for(let b=0;b<N;b+=B) y.set(st.push(x.subarray(b,b+B)),b);
  const d=Math.round(st.latency*sr); let err=0;
  for(let i=d;i<N;i++) err=Math.max(err,Math.abs(y[i]-x[i-d]));
  ok('identity 48k: delayed copy',err<1e-6,'delay '+d+' err '+err.toExponential(1));
  ok('no underruns',st.underruns===0,String(st.underruns));
}
// 16 кГц → модель 48 кГц и обратно: синус сохраняет амплитуду и частоту
{
  const sr=16000, B=512, st=T.nnStream(sr,48000,480,f=>Float32Array.from(f));
  const N=B*60, x=new Float32Array(N), f0=440;
  for(let i=0;i<N;i++) x[i]=Math.sin(2*Math.PI*f0*i/sr)*.5;
  const y=new Float32Array(N);
  for(let b=0;b<N;b+=B) y.set(st.push(x.subarray(b,b+B)),b);
  let pk=0; for(let i=N>>1;i<N;i++) pk=Math.max(pk,Math.abs(y[i]));
  let z=0; for(let i=N>>1;i<N-1;i++) if(y[i]<=0 && y[i+1]>0) z++;
  const hz=z/((N>>1)/sr);
  ok('16k resampled amplitude',Math.abs(pk-.5)<.03,pk.toFixed(3));
  ok('16k resampled frequency',Math.abs(hz-f0)<6,hz.toFixed(1));
  ok('16k no underruns',st.underruns===0,String(st.underruns));
}
// модель видит кадры ровно нужной длины и по порядку; fn(x)=x*2 даёт усиление
{
  const lens=[], st=T.nnStream(48000,48000,480,f=>{ lens.push(f.length); return f.map(v=>v*2); });
  const out=[]; for(let b=0;b<20;b++) out.push(st.push(new Float32Array(300).fill(.1)));
  ok('frame length',lens.every(l=>l===480) && lens.length===12,lens.length+' frames');
  ok('gain applied',Math.abs(out[19][299]-.2)<1e-6,String(out[19][299]));
}
// ресэмплер: число отсчётов в отношении частот, без накопления ошибки
{
  const r=T.nnResampler(44100,48000); let tot=0; for(let i=0;i<200;i++) tot+=r.run(new Float32Array(441)).length;
  ok('resampler ratio',Math.abs(tot-200*441*48000/44100)<3,String(tot));
}
console.log(bad ? bad+' failed' : 'all ok'); process.exit(bad?1:0);
