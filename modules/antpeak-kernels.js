"use strict";
/* ======================= ANTENNA PEAKER — ядро ======================= */
// Наведение антенны по постоянному сигналу, без DOM: node tools/test-antpeak.mjs.
// Быстрое и медленное среднее уровня, пик-холд лучшего, отклонение от него и высота тона для слуха.

// SNR цели по бинам [a..b] спектра (линейные амплитуды) над шумовой полкой floorDb (дБ на бин).
// peak — самый сильный бин (несущая); band — мощность всей полосы против шума в тех же бинах (модулированный канал).
function apLevel(mag,a,b,floorDb,kind){
  if(!(b>=a)) return NaN;
  if(kind==='band'){
    let s=0; for(let i=a;i<=b;i++) s+=mag[i]*mag[i];
    return 10*Math.log10(s+1e-24)-(floorDb+10*Math.log10(b-a+1));
  }
  let mx=0; for(let i=a;i<=b;i++) if(mag[i]>mx) mx=mag[i];
  return 20*Math.log10(mx+1e-12)-floorDb;
}
function apInit(){ return {n:0, fast:NaN, slow:NaN, best:NaN}; }
function apReset(st){ st.n=0; st.fast=st.slow=st.best=NaN; }
// кадр уровня x, дБ; dt — секунд с прошлого кадра; p={fastS,slowS,decay}. Пик-холд лучшего по быстрому среднему.
function apFeed(st,x,dt,p){
  if(!Number.isFinite(x)) return;
  dt=Math.max(0,dt||0);
  if(st.n===0){ st.fast=st.slow=st.best=x; st.n=1; return; }
  st.n++;
  const k=tau=>tau>0 ? 1-Math.exp(-dt/tau) : 1;
  st.fast+=k(p.fastS)*(x-st.fast);
  st.slow+=k(p.slowS)*(x-st.slow);
  st.best-=Math.max(0,p.decay||0)*dt;
  if(st.fast>st.best) st.best=st.fast;
}
// отклонение: 'best' — от лучшего (≤ 0), 'trend' — от медленного среднего (+ лучше, − хуже)
function apDelta(st,mode){
  if(!st.n) return NaN;
  return mode==='trend' ? st.fast-st.slow : st.fast-st.best;
}
// высота тона, Гц: 'best' — максимум у лучшего положения, падает на range дБ до fMin;
// 'trend' — середина при стоянии на месте, выше при улучшении, ниже при ухудшении (±range дБ — крайние). dead — мёртвая зона, дБ.
function apTone(delta,mode,p){
  if(!Number.isFinite(delta)) return NaN;
  const dead=Math.max(0,p.dead||0), range=Math.max(.1,p.range||10);
  let t;
  if(mode==='trend'){
    const d=Math.abs(delta)<dead ? 0 : delta-Math.sign(delta)*dead;
    t=.5+d/(2*range);
  } else t=1+Math.min(0,delta+dead)/range;
  t=t<0?0:t>1?1:t;
  return p.fMin*Math.pow(p.fMax/p.fMin,t);
}
// окно полосы бара, дБ: [lo,hi] вокруг лучшего — масштаб крупный там, где важна десятая доля дБ
function apScale(st,span){
  const hi=st.best+Math.max(.5,span*.08);
  return [hi-span, hi];
}
