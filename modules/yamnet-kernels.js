"use strict";
/* ============================ YAMNet: звуковые классы (AudioSet, 521) — чистая логика ============================
   Нейросеть (MediaPipe + YAMNet) живёт в yamnet.js; здесь окно звука, разбор результата и список «следить за». Тест tools/test-yamnet.mjs. */

// кольцо последних N отсчётов: get() отдаёт их по порядку (старые → новые); filled — сколько реально накоплено
function ynRing(N){
  const b=new Float32Array(N); let w=0, filled=0;
  return {
    N, get filled(){ return filled; },
    push(x){ for(let i=0;i<x.length;i++){ b[w]=x[i]; w=(w+1)%N; } filled=Math.min(N,filled+x.length); },
    get(){ const o=new Float32Array(N); o.set(b.subarray(w),0); o.set(b.subarray(0,w),N-w); return o; },
    clear(){ b.fill(0); w=0; filled=0; }
  };
}
// результат MediaPipe (AudioClassifierResult[]) → [{label, score}] по убыванию; несколько кусков — берём максимум по классу
function ynTop(results,n,min){
  const m=new Map();
  for(const r of results||[]) for(const c of r.classifications||[]) for(const k of c.categories||[]){
    const label=k.displayName || k.categoryName; if(!label) continue;
    if(!(m.get(label)>=k.score)) m.set(label,k.score);
  }
  return [...m].map(([label,score])=>({label,score})).filter(d=>d.score>=min).sort((a,b)=>b.score-a.score).slice(0,Math.max(1,n|0));
}
const ynClasses=s=>{ const a=String(s||'').split(/[,;\n]/).map(x=>x.trim().toLowerCase()).filter(Boolean); return a.length ? new Set(a) : null; };
// первый найденный из списка слежения (подстрока без учёта регистра: «speech» ловит «Speech» и «Male speech, man speaking»)
function ynWatch(list,watch,thr){
  if(!watch) return null;
  for(const d of list) if(d.score>=thr){ const l=d.label.toLowerCase(); for(const w of watch) if(l.includes(w)) return d; }
  return null;
}
const ynText=list=>list.length ? list.map(d=>d.label+' '+Math.round(d.score*100)+'%').join('\n') : 'silence / no class above the threshold';

// окно любой длины → ровно n отсчётов на 16 кГц (YAMNet: 15600 = 0.975 с); усреднение по ячейкам = фильтр от наложения при понижении частоты.
// Ровно один кусок для MediaPipe: иначе он делит окно и добавляет «тишину» из хвоста
function ynTo16k(x,n){
  n=n||15600;
  const L=x.length, r=L/n, ps=new Float64Array(L+1);
  for(let i=0;i<L;i++) ps[i+1]=ps[i]+x[i];
  const at=t=>{ const i=Math.floor(t), f=t-i; return ps[i]+(i<L ? x[i]*f : 0); };
  const o=new Float32Array(n);
  for(let j=0;j<n;j++) o[j]=(at((j+1)*r)-at(j*r))/r;
  return o;
}
