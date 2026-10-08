"use strict";
/* ============================ Ядро секундомера ============================
   Фронты в блоке с точностью до доли отсчёта и накопление статистики замеров. Без DOM — tools/test-stopwatch.mjs. */

// Восходящие фронты через порог thr (гистерезис hys). v — число (один отсчёт) или Float32Array.
// Возвращает позиции в отсчётах от начала блока (дробные; для i=0 может быть < 0 — пересечение на стыке блоков).
// Первое значение только запоминается: подключённый уровень не считается фронтом.
function swEdges(st,v,thr,hys){
  const out=[], hi=thr+hys, lo=thr-hys;
  const N=typeof v==='number' ? 1 : v.length;
  for(let i=0;i<N;i++){
    const x=typeof v==='number' ? v : v[i];
    if(st.hi===undefined){ st.hi=x>thr; st.last=x; continue; }
    if(!st.hi && x>hi){
      st.hi=true;
      const a=st.last, d=x-a;
      out.push(i===0 && typeof v==='number' ? 0 : (i-1)+(d>0 ? Math.min(1,Math.max(0,(thr-a)/d)) : 1));
    } else if(st.hi && x<lo) st.hi=false;
    st.last=x;
  }
  return out;
}

// Накопитель замеров (Welford): n, min, max, среднее, СКО (разброс = jitter)
function swStat(){ return {n:0,mean:0,m2:0,min:Infinity,max:-Infinity}; }
function swAdd(s,x){
  s.n++; const d=x-s.mean; s.mean+=d/s.n; s.m2+=d*(x-s.mean);
  if(x<s.min) s.min=x; if(x>s.max) s.max=x;
  return s;
}
function swSd(s){ return s.n>1 ? Math.sqrt(s.m2/(s.n-1)) : 0; }

// миллисекунды → «1 234.567 ms» / «12.345 s» / «123.4 µs»
function swFmt(ms){
  if(!isFinite(ms)) return '—';
  const a=Math.abs(ms);
  if(a>=60000) return Math.floor(ms/60000)+' min '+((ms%60000)/1000).toFixed(3)+' s';
  if(a>=1000) return (ms/1000).toFixed(3)+' s';
  if(a>=1) return ms.toFixed(3)+' ms';
  return (ms*1000).toFixed(1)+' µs';
}
