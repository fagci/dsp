"use strict";
/* ============================ Power: ядро профайлера ============================
   Чистая логика панели «Power» (без DOM): класс нагрузки узла, кольцо истории, ранжирование, сводка и спарклайн.
   Проверка: node tools/test-power.mjs */

const PWR_HEAT=[[40,3],[15,2],[4,1]];                             // доля одного ядра, % → класс подсветки узла на холсте (0 — не светится)
function pwrHeat(pct){ for(const [lo,c] of PWR_HEAT) if(pct>=lo) return c; return 0; }

function pwrPush(hist,v,max){                                      // кольцо последних значений (на месте)
  hist.push(v); if(hist.length>(max||60)) hist.splice(0,hist.length-(max||60)); return hist;
}

// rows: [{key,name,p,d}] → отсортированные по p+d (или пику), с долей от суммы; peak — карта key → максимум за сессию
function pwrRank(rows,opt){
  const o=opt||{}, by=o.by||'now', peak=o.peak||{}, top=o.top||12;
  let sum=0; for(const r of rows) sum+=r.p+r.d;
  const val=r=>by==='peak' ? (peak[r.key]||0) : r.p+r.d;
  const out=rows.filter(r=>r.p+r.d>=0.05 || (peak[r.key]||0)>=0.05).slice().sort((a,b)=>val(b)-val(a)).slice(0,top)
    .map(r=>({key:r.key,name:r.name,p:r.p,d:r.d,tot:r.p+r.d,peak:peak[r.key]||0,share:sum>0?(r.p+r.d)/sum:0,heat:pwrHeat(r.p+r.d)}));
  return {rows:out,sum};
}

function pwrPeak(peak,rows){                                       // максимум за сессию по узлу
  for(const r of rows){ const t=r.p+r.d; if(t>(peak[r.key]||0)) peak[r.key]=t; }
  return peak;
}

// точки спарклайна: значения → [x,y] в рамке w×h, шкала 0…max(значений, floor)
function pwrSpark(hist,w,h,floor){
  const mx=Math.max(floor||10,...hist,1e-9), n=hist.length;
  return hist.map((v,i)=>[n>1?i*(w-1)/(n-1):w-1, h-1-(h-2)*Math.min(1,v/mx)]);
}

// ширина полосы: process / draw в долях от 100% одного ядра (шкала сжимается, если есть узел жирнее)
function pwrBar(r,scale){ const s=Math.max(scale||100,1e-9); return {p:Math.min(1,r.p/s),d:Math.min(1-Math.min(1,r.p/s),r.d/s)}; }

if(typeof module!=='undefined') module.exports={pwrHeat,pwrPush,pwrRank,pwrPeak,pwrSpark,pwrBar,PWR_HEAT};
