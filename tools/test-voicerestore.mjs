// Восстановление «бубнящей» речи: node tools/test-voicerestore.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const rd=f=>fs.readFileSync(path.join(root,f),'utf8');
const ctx=vm.createContext({Math,Float32Array,Float64Array,Int32Array,Array,Set,Map,Number,String,Uint32Array,Uint8Array,Object,Date,console});
vm.runInContext(rd('core-dsp.js')+rd('modules/voicerestore-kernels.js')+';this.T={vrRestore,vrStft,vrBands,vrTmpl};',ctx);
const T=ctx.T;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };
let seed=3; const rnd=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296*2-1);
const sr=16000;

// 1) STFT без обработки восстанавливает сигнал с задержкой latency
{
  const st=T.vrStft(512,()=>{}), N=sr*2, x=new Float32Array(N); for(let i=0;i<N;i++) x[i]=Math.sin(i*.07)*.5+Math.sin(i*.31)*.2+rnd()*.05;
  const y=new Float32Array(N); for(let i=0;i<N;i+=300){ const e=Math.min(N,i+300); y.set(st.push(x.subarray(i,e)),i); }
  let err=0; for(let i=1000;i<N;i++) err=Math.max(err,Math.abs(y[i]-x[i-512]));
  ok('stft identity (delay = N)',err<1e-4,err.toExponential(1));
}
// 2) полосы: покрывают всё, не уже двух бинов
{
  const b=T.vrBands(1024,48000); let min=1e9; for(let i=1;i<b.edges.length;i++) min=Math.min(min,b.edges[i]-b.edges[i-1]);
  ok('bands',b.edges[0]===1 && b.edges[b.edges.length-1]===512 && min>=2 && b.centers.length>15,b.centers.length+' bands');
  ok('template',Math.abs(T.vrTmpl(500))<1e-9 && T.vrTmpl(4000)<T.vrTmpl(1000) && T.vrTmpl(10)<T.vrTmpl(125));
}
// «речь»: гортанные импульсы с меняющимся тоном через четыре форманты, слоги, шумные «с» между ними
function speech(sec){
  const N=Math.round(sec*sr), y=new Float32Array(N); seed=11;
  const res=(f,bw)=>{ const r=Math.exp(-Math.PI*bw/sr), c=2*r*Math.cos(2*Math.PI*f/sr); return {a1:c,a2:-r*r,g:1-r,y1:0,y2:0}; };
  const vowels=[[700,1200,2600,3500],[300,2200,3000,3700],[450,900,2500,3400],[350,1800,2600,3600]];
  let ph=0, vi=0, cnt=0, kind=0, env=0, fs=[]; let rs=null;
  const setV=()=>{ const v=vowels[vi%vowels.length]; rs=v.map((f,i)=>res(f,70+i*40)); };
  setV(); let hp=0, ns=0;
  for(let i=0;i<N;i++){
    if(cnt--<=0){ kind=(kind+1)%3; cnt=Math.round(sr*(kind===2 ? .09 : .22)); if(kind===0){ vi++; setV(); } }
    const f0=130+25*Math.sin(i/sr*2*Math.PI*.7);
    ph+=f0/sr; let src=0; if(ph>=1){ ph-=1; src=1; }
    const voiced = kind===0 ? 1 : 0;
    let x=src*voiced*8, v=0;
    if(voiced){ for(const r of rs){ const o=x*r.g+r.a1*r.y1+r.a2*r.y2; r.y2=r.y1; r.y1=o; v+=o*.5; } }
    // «с»: шум, поднятый вверх (разность первого порядка), 3–8 кГц
    let fr=0; if(kind===2){ const n=rnd(); fr=(n-hp)*.5; hp=n; }
    const tgt=kind===1 ? 0 : 1; env+=(tgt-env)*.003;
    y[i]=(v*.5+fr*.35)*env;
  }
  return y;
}
const lp=(x,fc,order)=>{ let s=Float32Array.from(x); for(let k=0;k<order;k++){ const w=Math.tan(Math.PI*fc/sr), q=Math.SQRT1_2, n=1/(1+w/q+w*w), b0=w*w*n, b1=2*b0, a1=2*(w*w-1)*n, a2=(1-w/q+w*w)*n; let x1=0,x2=0,y1=0,y2=0; const o=new Float32Array(s.length); for(let i=0;i<s.length;i++){ const v=b0*s[i]+b1*x1+b0*x2-a1*y1-a2*y2; x2=x1; x1=s[i]; y2=y1; y1=v; o[i]=v; } s=o; } return s; };
// долговременный спектр по октавам 250…6000 Гц, дБ
function bands(x,from){
  const N=512, edges=[250,500,1000,2000,3000,4000,6000], P=new Float64Array(edges.length-1); let cnt=0;
  const re=new Float64Array(N), im=new Float64Array(N);
  for(let s=from;s+N<=x.length;s+=256){ for(let i=0;i<N;i++){ re[i]=x[s+i]*(.5-.5*Math.cos(2*Math.PI*i/N)); im[i]=0; } ctx.fft(re,im);
    for(let b=0;b<P.length;b++){ let e=0,c=0; for(let k=Math.round(edges[b]*N/sr);k<Math.round(edges[b+1]*N/sr);k++){ e+=re[k]*re[k]+im[k]*im[k]; c++; } P[b]+=e/c; } cnt++; }
  return Array.from(P,v=>10*Math.log10(v/cnt+1e-20));
}
const run=(x,o)=>{ const r=T.vrRestore({sr,...o}); const y=new Float32Array(x.length); for(let i=0;i<x.length;i+=512){ const e=Math.min(x.length,i+512); y.set(r.push(x.subarray(i,e)),i); } return {y,r}; };
const dist=(a,b)=>{ const m=(a[1]+a[2])/2-(b[1]+b[2])/2; let s=0; for(let i=0;i<a.length;i++) s+=Math.abs(a[i]-b[i]-m); return s/a.length; };   // выравнивание по полосам 500–2000

const orig=speech(40), Bo=bands(orig,sr*10);
// 3) мягкая потеря верха (−6 дБ/окт выше 800 Гц): эквалайзер возвращает форму спектра
{
  const soft=lp(orig,1500,1);                                       // 12 дБ/окт выше 1.5 кГц, верха нет, но не «стена»
  const Bm=bands(soft,sr*10), {y}=run(soft,{strength:1,extend:0,boom:0}), By=bands(y,sr*10+512);
  const d0=dist(Bm,Bo), d1=dist(By,Bo);
  ok('equalizer: spectrum closer to speech (extend off)',d1<d0*.7,d0.toFixed(1)+' → '+d1.toFixed(1)+' dB');
}
// 4) глухая стена (ФНЧ 1.2 кГц 4-го порядка): достройка верха приближает спектр
{
  const wall=lp(orig,1200,2), Bm=bands(wall,sr*10);
  const a=run(wall,{strength:1,extend:0,boom:0}), b=run(wall,{strength:1,extend:1,boom:0});
  const dm=dist(Bm,Bo), da=dist(bands(a.y,sr*10+512),Bo), db=dist(bands(b.y,sr*10+512),Bo);
  ok('wall: extension improves over EQ alone',db<da && db<dm*.8,dm.toFixed(1)+' → EQ '+da.toFixed(1)+' → +extend '+db.toFixed(1)+' dB');
  ok('cutoff found near the filter edge',b.r.info.cutoff>800 && b.r.info.cutoff<3000,b.r.info.cutoff.toFixed(0)+' Hz');
}
// 5) тишина и шум: без NaN, шум не раздувается
{
  const z=new Float32Array(sr*3), {y}=run(z,{}); ok('silence stays silent',y.every(v=>v===0||Math.abs(v)<1e-9));
  const nz=new Float32Array(sr*12); for(let i=0;i<nz.length;i++) nz[i]=rnd()*.05;
  const {y:yn}=run(nz,{strength:1,extend:1}); let r0=0,r1=0; for(let i=sr*6;i<nz.length;i++){ r0+=nz[i-512]*nz[i-512]; r1+=yn[i]*yn[i]; }
  ok('noise is not amplified (≤ +3 dB)',10*Math.log10(r1/r0)<=3 && yn.every(Number.isFinite),(10*Math.log10(r1/r0)).toFixed(1)+' dB');
}
// 6) речь с типовым спектром почти не меняется (≤ 3 дБ по полосам): слоговый шум, прошедший через форму LTASS
{
  const N=sr*30, w=new Float32Array(N); let env=0, tgt=1, cnt=0; for(let i=0;i<N;i++){ if(cnt--<=0){ cnt=Math.round(sr*(.1+.15*Math.abs(rnd()))); tgt=Math.abs(rnd())>.2 ? .3+Math.abs(rnd()) : 0; } env+=(tgt-env)*.003; w[i]=rnd()*env*.3; }
  const st=T.vrStft(512,(re,im)=>{ for(let k=1;k<256;k++){ const g=Math.pow(10,T.vrTmpl(k*sr/512)/20); re[k]*=g; im[k]*=g; } });
  const sp=new Float32Array(N); for(let i=0;i<N;i+=512) sp.set(st.push(w.subarray(i,Math.min(N,i+512))),i);
  const Bs=bands(sp,sr*10), {y}=run(sp,{strength:.7,extend:.5}), By=bands(y,sr*10+512);
  let mx=0; const off=(By[1]+By[2])/2-(Bs[1]+Bs[2])/2; for(let i=0;i<Bs.length;i++) mx=Math.max(mx,Math.abs(By[i]-Bs[i]-off));
  ok('speech with the typical spectrum is left alone',mx<3,mx.toFixed(1)+' dB max band change');
}
console.log(bad ? bad+' failed' : 'all ok'); process.exit(bad?1:0);
