"use strict";
/* ============================ Satellite Autopilot: ядро ============================
   Чистая логика без DOM: node tools/test-satplan.mjs.
   Цели (спутник, частота, режим, мин. угол, приоритет) → пролёты на сутки вперёд → выбор непересекающихся
   по приоритету и углу → окно «pre-roll … пролёт … post-roll» и доплеровская поправка.
   Орбитная часть (SGP4) приходит снаружи — deps.passes / deps.rate (sat.js), поэтому ядро проверяется и на выдуманных пролётах. */

const SP_C=299792.458;                                     // км/с
const SP_KNOWN={                                           // частоты по умолчанию, МГц: NORAD → [downlink, режим]
  25338:[137.620,'APT'], 28654:[137.9125,'APT'], 33591:[137.100,'APT'],       // NOAA 15, 18, 19
  57166:[137.900,'LRPT'], 59051:[137.900,'LRPT'], 44387:[137.100,'LRPT'],     // Meteor-M2 3, M2 4, M2 2
  25544:[145.800,'NFM']};                                  // МКС (голос, SSTV)

// число частоты → Гц; < 10000 — МГц, как пишут в таблицах
function spHz(v){
  const x=typeof v==='number' ? v : parseFloat(String(v).replace(',','.'));
  if(!isFinite(x) || x<=0) return 0;
  const u=/k\s*hz?$/i.test(String(v)) ? 1e3 : /g\s*hz?$/i.test(String(v)) ? 1e9 : /m\s*hz?$/i.test(String(v)) ? 1e6 : 0;
  return u ? x*u : x<10000 ? x*1e6 : x;
}
// "NOAA 19; 137.1; APT; 15; 5" — спутник; частота (МГц или Гц, точка как разделитель); режим; мин. угол, °; приоритет.
// Пустое поле — по умолчанию. Цели разделяются запятой или переводом строки, # — комментарий
function spParseTargets(text){
  const out=[];
  for(const line of String(text||'').split(/\r?\n|,/)){
    const s=line.replace(/#.*$/,'').trim(); if(!s) continue;
    const a=s.split(/[;|\t]/).map(x=>x.trim());
    out.push({sat:a[0], f0:a[1] ? spHz(a[1]) : 0, mode:a[2]||'', minEl:a[3]!=null && a[3]!=='' ? +a[3] : null, prio:a[4]!=null && a[4]!=='' ? +a[4] : 0});
  }
  return out.filter(t=>t.sat);
}
// записи Table (выход rows): sat / name / norad, freq / lo (Гц или МГц), mode / demod, minEl, prio, enabled
function spFromRows(rows){
  const out=[];
  const pick=(r,names)=>{ for(const k of Object.keys(r)){ if(names.includes(k.toLowerCase().replace(/[\s_-]/g,''))) return r[k]; } return undefined; };
  for(const r of rows||[]){
    if(!r || typeof r!=='object') continue;
    const en=pick(r,['enabled','on','active']);
    if(en!==undefined && /^(0|false|no|off|)$/i.test(String(en).trim())) continue;
    const sat=pick(r,['sat','satellite','norad','name']);
    if(sat==null || String(sat).trim()==='') continue;
    const f=pick(r,['freq','frequency','f','downlink','dl']) ?? (r.lo>0 ? r.lo : 0);
    const el=pick(r,['minel','elmin','minelevation']), pr=pick(r,['prio','priority']);
    out.push({sat:String(sat).trim(), f0:f ? spHz(f) : 0, mode:String(pick(r,['mode','demod'])??''),
      minEl:el!=null && el!=='' && isFinite(+el) ? +el : null, prio:pr!=null && isFinite(+pr) ? +pr : 0});
  }
  return out;
}
// Пролёты всех целей: items = [{t:цель, s:спутник|null}]; → {passes (все), skipped (список без орбиты)}
// o: {from, hours, obs, minEl (общий), maxN}; deps.passes(s, from, hours, obs, minEl, maxN)
function spPasses(items, o, deps){
  const passes=[], noOrbit=[];
  items.forEach((it,i)=>{
    if(!it.s){ noOrbit.push(it.t.sat); return; }
    const minEl=it.t.minEl!=null ? it.t.minEl : o.minEl;
    for(const p of deps.passes(it.s, o.from, o.hours, o.obs, minEl, o.maxN||12))
      passes.push({...p, ti:i, sat:it.s.name, norad:it.s.norad, f0:it.f0||0, mode:it.t.mode||'', prio:it.t.prio||0, minEl});
  });
  passes.sort((a,b)=>a.aos-b.aos);
  return {passes, noOrbit};
}
// Одним приёмником: сначала лучшие (приоритет, затем максимальный угол), пересекающиеся окна отбрасываются.
// preMs / postMs — запас вокруг пролёта; gapMs — минимум между окнами
function spPick(passes, preMs, postMs, gapMs){
  const order=passes.slice().sort((a,b)=>(b.prio-a.prio) || (b.maxEl-a.maxEl) || (a.aos-b.aos));
  const taken=[];
  for(const p of order){
    const lo=p.aos-preMs, hi=p.los+postMs;
    const c=taken.find(q=>lo<q.los+postMs+gapMs && q.aos-preMs<hi+gapMs);
    if(c){ p.status='skipped'; p.why=c.sat; }
    else { p.status='planned'; p.why=''; taken.push(p); }
  }
  return passes.slice().sort((a,b)=>a.aos-b.aos);
}
// Что сейчас: cur — пролёт, чьё окно (с запасами) открыто; next — следующий запланированный после now
// phase: 'pre' (до AOS), 'pass' (над горизонтом цели), 'post' (после LOS), 'idle'
function spNow(plan, now, preMs, postMs){
  let cur=null, next=null;
  for(const p of plan){
    if(p.status!=='planned') continue;
    if(now>=p.aos-preMs && now<=p.los+postMs){ cur=p; continue; }
    if(!next && p.aos-preMs>now) next=p;
  }
  const phase=!cur ? 'idle' : now<cur.aos ? 'pre' : now<=cur.los ? 'pass' : 'post';
  return {cur, next, phase};
}
// частота приёма с поправкой; rate — скорость удаления, км/с (+ удаляется → частота ниже)
function spDoppler(f0, rate){ return f0 && rate!=null ? Math.round(f0*(1-rate/SP_C)) : (f0||null); }
// Частота цели: явная → таблица по NORAD → первый передатчик SatNOGS (tx: norad → [{dl,mode}])
function spFreq(t, norad, tx){
  if(t.f0>0) return {f0:t.f0, mode:t.mode};
  const k=SP_KNOWN[norad];
  if(k) return {f0:k[0]*1e6, mode:t.mode||k[1]};
  const a=tx && tx.get(norad) && tx.get(norad).find(x=>x.dl);
  return a ? {f0:a.dl, mode:t.mode||a.mode||''} : {f0:0, mode:t.mode};
}
function spFmtDur(ms){
  const s=Math.round(Math.abs(ms)/1000), h=Math.floor(s/3600), m=Math.floor(s%3600/60), x=s%60;
  return h ? h+'h '+String(m).padStart(2,'0')+'m' : m ? m+'m '+String(x).padStart(2,'0')+'s' : x+'s';
}
