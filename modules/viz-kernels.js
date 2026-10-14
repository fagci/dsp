"use strict";
/* ============================ VIZ KERNELS ============================ */
// Ядро визуализаторов: группировка спектра в полосы, детектор бита, цвет. Без DOM.

// границы nb полос в Гц: scale = log | mel | linear
function vzEdges(nb,fmin,fmax,scale){
  fmin=Math.max(1,fmin); fmax=Math.max(fmin*1.01,fmax);
  const fw=scale==='mel' ? f=>2595*Math.log10(1+f/700) : scale==='linear' ? f=>f : Math.log;
  const bw=scale==='mel' ? m=>700*(Math.pow(10,m/2595)-1) : scale==='linear' ? m=>m : Math.exp;
  const a=fw(fmin), b=fw(fmax), e=new Float64Array(nb+1);
  for(let i=0;i<=nb;i++) e[i]=bw(a+(b-a)*i/nb);
  return e;
}

// амплитудный спектр mag[] (шаг binHz) → полосы out[] в дБ; tilt — наклон дБ/окт. относительно 1 кГц.
// Узкая полоса (< бина) берёт интерполированное значение, широкая — энергию бинов с долями на краях.
function vzGroup(mag,binHz,edges,out,tilt){
  const nb=out.length, N=mag.length;
  for(let b=0;b<nb;b++){
    const x0=edges[b]/binHz, x1=edges[b+1]/binHz;
    let p;
    if(x1-x0<=1){
      const xc=Math.min(N-1,Math.max(0,(x0+x1)/2)), i=Math.floor(xc), j=Math.min(N-1,i+1), f=xc-i;
      const a=mag[i], c=mag[j];
      p=a*a*(1-f)+c*c*f;
    } else {
      const i0=Math.max(0,Math.floor(x0+.5)), i1=Math.min(N-1,Math.floor(x1+.5));
      p=0;
      for(let i=i0;i<=i1;i++){
        const w=Math.min(x1,i+.5)-Math.max(x0,i-.5);
        if(w>0) p+=mag[i]*mag[i]*w;
      }
    }
    let db=10*Math.log10(p+1e-18);
    if(tilt) db+=tilt*Math.log2(Math.sqrt(edges[b]*edges[b+1])/1000);
    out[b]=db;
  }
  return out;
}

const vzNorm=(db,lo,hi)=>{ const v=(db-lo)/((hi-lo)||1); return v<0?0:v>1?1:v; };
// сглаживание: быстрая атака (tau в с), медленный спад
const vzFollow=(cur,v,atk,rel,dt)=>{ const t=v>cur?atk:rel; return t>0 ? cur+(v-cur)*(1-Math.exp(-dt/t)) : v; };

// детектор бита: энергия против скользящего среднего, не чаще раза в refr с;
// true — бит в этом блоке, st.bpm — по медиане интервалов
function vzBeatNew(){ return {avg:0, t:0, last:-9, iv:[], bpm:0}; }
function vzBeat(st,e,dt,sens,refr){
  st.t+=dt;
  if(!st.on){ st.on=1; st.avg=e; }
  st.avg+=(e-st.avg)*(1-Math.exp(-dt/1.0));
  const hit=e>st.avg*sens && e>1e-4 && st.t-st.last>refr;
  if(hit){
    const gap=st.t-st.last;
    if(gap<2){ st.iv.push(gap); if(st.iv.length>12) st.iv.shift();
      if(st.iv.length>=4){ const s=st.iv.slice().sort((a,b)=>a-b); let b=60/s[s.length>>1];
        while(b<70) b*=2; while(b>180) b/=2; st.bpm=b; } }
    st.last=st.t;
  }
  return hit;
}

const vzHsl=(h,s,l,a)=>'hsla('+(((h%360)+360)%360).toFixed(0)+','+s+'%,'+l+'%,'+(a==null?1:a)+')';
// цвет по режиму: t — позиция 0..1 (по оси), v — значение 0..1
function vzColor(mode,t,v,a){
  if(mode==='rainbow') return vzHsl(t*300,90,55,a);
  if(mode==='heat') return vzHsl(240-v*240,95,40+v*20,a);
  return null;
}
