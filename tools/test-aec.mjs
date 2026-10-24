// Эхокомпенсатор (PBFDAF): node tools/test-aec.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const rd=f=>fs.readFileSync(path.join(root,f),'utf8');
const ctx=vm.createContext({Math,Float32Array,Float64Array,Array,Set,Map,Number,String,Uint32Array,Uint8Array,Date,console});
vm.runInContext(rd('core-dsp.js')+rd('modules/aec-kernels.js')+';this.T={aecStream,aecCore};',ctx);
const T=ctx.T;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };
let seed=7; const rnd=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296*2-1);
const gauss=()=>(rnd()+rnd()+rnd()+rnd())/2;
// «речь»: шум через резонансный фильтр с медленной огибающей слогов и паузами
function speech(N,sr,gain=.3,sd=1){
  seed=sd*7919+3; const y=new Float32Array(N); let a=0,b=0,env=0,tgt=0,cnt=0;
  for(let i=0;i<N;i++){
    if(cnt--<=0){ cnt=Math.round(sr*(.08+.2*Math.abs(rnd()))); tgt=Math.abs(rnd())>.25 ? .3+Math.abs(rnd()) : 0; }
    env+= (tgt-env)*.002;
    const x=gauss(); const v=x+1.55*a-.8*b; b=a; a=v; y[i]=v*env*gain*.35;
  }
  return y;
}
const conv=(x,h,N)=>{ const y=new Float32Array(N); for(let i=0;i<N;i++){ let s=0; for(let k=0;k<h.length&&k<=i;k++) s+=h[k]*x[i-k]; y[i]=s; } return y; };
const sr=16000, N=sr*14;
const h=new Float32Array(900); for(let k=0;k<h.length;k++) h[k]=(k<320?0:Math.exp(-(k-320)/180)*rnd())*.6;   // 20 мс задержки, хвост ≈ 50 мс
const far=speech(N,sr,1,1), echo=conv(far,h,N);
const run=(d,x,o={})=>{ const s=T.aecStream({sr,ms:128,...o}); const out=new Float32Array(N); for(let i=0;i<N;i+=512) out.set(s.push(d.subarray(i,i+512),x&&x.subarray(i,i+512)),i); return {out,s}; };
const rmsR=(a,b,e)=>{ let s=0; for(let i=b;i<e;i++) s+=a[i]*a[i]; return Math.sqrt(s/(e-b)); };
const db=(a,b)=>20*Math.log10((a+1e-12)/(b+1e-12));

// 1) только эхо: ERLE после сходимости
{
  const r=run(echo,far,{suppress:0});
  const erle=db(rmsR(echo,N-sr*4,N),rmsR(r.out,N-sr*4,N)), lat=256;
  ok('single talk: echo cancelled (linear part, ERLE ≥ 25 dB)',erle>=25,erle.toFixed(1)+' dB');
  ok('latency = one block',Math.abs(r.s.latency*sr-256)<1);
  let ah=0; for(let k=0;k<h.length;k++) if(Math.abs(h[k])>Math.abs(h[ah])) ah=k;
  const pk=r.s.core.peak(); ok('delay estimate = strongest tap of the path',Math.abs(pk-ah)<=2,pk+' vs '+ah+' samples');
  const r2=run(echo,far,{suppress:1}), erle2=db(rmsR(echo,N-sr*4,N),rmsR(r2.out,N-sr*4,N));
  ok('residual suppression adds attenuation',erle2>erle+3,erle2.toFixed(1)+' dB');
}
// 2) двойная речь: ближний голос сохраняется, фильтр не расходится
{
  const near=speech(N,sr,1,5), mic=new Float32Array(N); for(let i=0;i<N;i++) mic[i]=echo[i]+(i>sr*6&&i<sr*9 ? near[i] : 0);
  const r=run(mic,far,{suppress:.5}), a=sr*6+4000, b=sr*9-100;
  let num=0,e1=0,e2=0; for(let i=a;i<b;i++){ const o=r.out[i+256], v=near[i]; num+=o*v; e1+=o*o; e2+=v*v; }
  const corr=num/Math.sqrt(e1*e2+1e-18);
  ok('double talk: near voice kept (corr ≥ .85)',corr>=.85,corr.toFixed(3));
  const erle=db(rmsR(echo,N-sr*3,N),rmsR(r.out,N-sr*3,N));
  ok('after double talk: filter still converged (ERLE ≥ 20 dB)',erle>=20,erle.toFixed(1)+' dB');
}
// 3) ничего не говорят в опоре: микрофон проходит без изменений (с задержкой в блок)
{
  const sig=speech(N,sr,1,9), silent=new Float32Array(N), r=run(sig,silent,{});
  let err=0,e0=0; for(let i=2000;i<N-300;i++){ err+=(r.out[i+256]-sig[i])**2; e0+=sig[i]**2; }
  ok('silent reference: pass-through',err/e0<1e-4,(err/e0).toExponential(1));
}
// 4) один микрофон: эхо этого же голоса через 150 мс гасится, сам голос остаётся
{
  const D=Math.round(.15*sr), s=speech(N,sr,1,11), x=new Float32Array(N); for(let i=0;i<N;i++) x[i]=s[i]+(i>=D ? .5*s[i-D] : 0);
  const r=run(x,null,{ms:300,minDelay:60,suppress:0,mu:.4});
  const lagCorr=(a,lag,from,to)=>{ let n=0,e1=0,e2=0; for(let i=from;i<to;i++){ n+=a[i]*a[i-lag]; e1+=a[i]*a[i]; e2+=a[i-lag]*a[i-lag]; } return n/Math.sqrt(e1*e2+1e-18); };
  const c0=lagCorr(x,D,sr*8,N-300), c1=lagCorr(r.out.subarray(256),D,sr*8,N-556);
  ok('one mic: correlation at the echo lag drops',c1<c0*.4,c0.toFixed(2)+' → '+c1.toFixed(2));
  let num=0,e1=0,e2=0; for(let i=sr*8;i<N-300;i++){ const o=r.out[i+256], v=s[i]; num+=o*v; e1+=o*o; e2+=v*v; }
  ok('one mic: voice kept (corr ≥ .9)',num/Math.sqrt(e1*e2)>=.9,(num/Math.sqrt(e1*e2)).toFixed(3));
}
// 5) произвольные размеры блоков на входе дают тот же результат
{
  const mk=sz=>{ const s=T.aecStream({sr,ms:64,suppress:.3}); const o=new Float32Array(sr*3); for(let i=0;i<o.length;i+=sz){ const e=Math.min(i+sz,o.length); o.set(s.push(echo.subarray(i,e),far.subarray(i,e)),i); } return o; };
  const a=mk(512), c=mk(300);
  let dmax=0; for(let i=0;i<a.length;i++) dmax=Math.max(dmax,Math.abs(a[i]-c[i]));
  ok('block size independent',dmax<1e-4,dmax.toExponential(1));
}
console.log(bad ? bad+' failed' : 'all ok'); process.exit(bad?1:0);
