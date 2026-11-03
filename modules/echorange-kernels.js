"use strict";
/* ============================ Echo Ranger: ядро ============================
   Расстояние до стен звуком: динамик телефона играет чирп (линейная частотная модуляция f0→f1), микрофон пишет, согласованный фильтр (корреляция с самим
   чирпом) сжимает его в короткий пик — импульсную характеристику комнаты. Самый сильный пик — прямой путь динамик → микрофон (в нём сидят все задержки
   аудиотракта, они постоянны и сокращаются), пики позже — отражения: расстояние до стены = c·Δt/2. Разрешение c/(2B): полоса 8 кГц — 2 см.
   Ядро чистое, без DOM: node tools/test-echorange.mjs */

const erSpeed=T=>331.3+0.606*T;                                  // скорость звука, м/с, при температуре воздуха T, °C
// линейный чирп f0→f1 за dur с, окно Ханна по краям (меньше боковых лепестков)
function erChirp(sr,f0,f1,dur){
  const n=Math.max(8,Math.round(sr*dur)), x=new Float32Array(n), k=(f1-f0)/dur;
  for(let i=0;i<n;i++){ const t=i/sr, w=.5-.5*Math.cos(2*Math.PI*i/(n-1)); x[i]=w*Math.sin(2*Math.PI*(f0*t+.5*k*t*t)); }
  return x;
}
// БПФ по основанию 2 на месте (re, im — Float64Array длины 2^k)
function erFFT(re,im,inv){
  const n=re.length;
  for(let i=1,j=0;i<n;i++){ let b=n>>1; for(;j&b;b>>=1) j^=b; j^=b; if(i<j){ let t=re[i]; re[i]=re[j]; re[j]=t; t=im[i]; im[i]=im[j]; im[j]=t; } }
  for(let len=2;len<=n;len<<=1){
    const a=(inv ? 2 : -2)*Math.PI/len, wr=Math.cos(a), wi=Math.sin(a);
    for(let i=0;i<n;i+=len){ let cr=1, ci=0;
      for(let j=0;j<len/2;j++){ const u=i+j, v=u+len/2, xr=re[v]*cr-im[v]*ci, xi=re[v]*ci+im[v]*cr;
        re[v]=re[u]-xr; im[v]=im[u]-xi; re[u]+=xr; im[u]+=xi; const t=cr*wr-ci*wi; ci=cr*wi+ci*wr; cr=t; } }
  }
  if(inv) for(let i=0;i<n;i++){ re[i]/=n; im[i]/=n; }
}
const erPow2=n=>{ let p=1; while(p<n) p<<=1; return p; };
// огибающая корреляции записи mic с чирпом: |аналитический сигнал(corr)|; индекс i — задержка i отсчётов от начала записи
function erEnvelope(mic,chirp){
  const N=erPow2(mic.length+chirp.length), ar=new Float64Array(N), ai=new Float64Array(N), br=new Float64Array(N), bi=new Float64Array(N);
  ar.set(mic); br.set(chirp); erFFT(ar,ai,false); erFFT(br,bi,false);
  for(let i=0;i<N;i++){ const r=ar[i]*br[i]+ai[i]*bi[i], m=ai[i]*br[i]-ar[i]*bi[i]; ar[i]=r; ai[i]=m; }       // X · conj(C)
  for(let i=1;i<N/2;i++){ ar[i]*=2; ai[i]*=2; } for(let i=N/2+1;i<N;i++){ ar[i]=0; ai[i]=0; }               // аналитический сигнал: только положительные частоты
  erFFT(ar,ai,true);
  const e=new Float32Array(mic.length); for(let i=0;i<e.length;i++) e[i]=Math.hypot(ar[i],ai[i]); return e;
}
// прямой путь — самый сильный пик; возвращает огибающую от него: len отсчётов, [0] = прямой путь; directIdx — где он был
function erAlign(env,len,from=0){
  let d=from, m=-1; for(let i=from;i<env.length;i++) if(env[i]>m){ m=env[i]; d=i; }
  const o=new Float32Array(len); for(let i=0;i<len && d+i<env.length;i++) o[i]=env[d+i]; return {env:o,directIdx:d,direct:m};
}
// пики отражений в выровненной огибающей (индекс 0 — прямой путь). opt: sr, c (м/с), minDist (м), thrDb (ниже прямого, дБ), noiseK (во сколько раз выше медианы), bw (полоса чирпа, Гц)
function erPeaks(env,opt){
  const sr=opt.sr, c=opt.c||343, direct=env[0]||1e-12, min=Math.max(2,Math.round(2*opt.minDist/c*sr)), half=Math.max(2,Math.round(sr/(opt.bw||8000)*1.5));
  const tail=Array.from(env.subarray(min)).sort((a,b)=>a-b), med=tail.length ? tail[tail.length>>1] : 0;
  const thr=Math.max((opt.noiseK||6)*med, direct*Math.pow(10,-(opt.thrDb||40)/20)), out=[];
  for(let i=min;i<env.length-1;i++){
    const v=env[i]; if(v<thr || v<env[i-1] || v<env[i+1]) continue;
    let ok=true; for(let j=Math.max(min,i-half);j<=Math.min(env.length-1,i+half);j++) if(env[j]>v){ ok=false; break; } if(!ok) continue;
    // уточнение пика параболой по трём точкам
    const a=env[i-1], b=v, d=env[i+1], den=a-2*b+d, off=den<0 ? .5*(a-d)/den : 0, t=(i+off)/sr;
    out.push({t,dist:c*t/2,db:20*Math.log10(v/direct)});
  }
  return out;
}
// выбор: 'first' — ближайший, 'strongest' — самый сильный
function erPick(peaks,mode){ if(!peaks.length) return null; return mode==='strongest' ? peaks.reduce((a,b)=>b.db>a.db ? b : a) : peaks[0]; }
// синтетическая запись: прямой путь через latency отсчётов + эхо (dist м, амплитуда) + шум (для демо и тестов); burst — чирп; len — длина записи
function erSimulate(burst,sr,c,len,latency,echoes,noise,seed=1){
  const m=new Float32Array(len); let s=seed>>>0;
  const rnd=()=>{ s=(s*1664525+1013904223)>>>0; return s/4294967296-.5; };
  const put=(d,a)=>{ for(let i=0;i<burst.length;i++){ const j=d+i; if(j>=0 && j<len) m[j]+=a*burst[i]; } };
  put(latency,1); for(const [dist,a] of echoes) put(latency+Math.round(2*dist/c*sr),a);
  if(noise>0) for(let i=0;i<len;i++) m[i]+=noise*2*rnd();
  return m;
}
// «2.5:0.4, 4.1:0.2» → [[2.5,.4],[4.1,.2]]
const erParseSim=t=>String(t||'').split(/[,;]/).map(s=>s.trim().split(':').map(Number)).filter(a=>a.length===2 && a[0]>0 && isFinite(a[1]));
