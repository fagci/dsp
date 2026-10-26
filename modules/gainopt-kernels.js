"use strict";
/* ======================= GAIN OPTIMIZER — ядро ======================= */
// Подбор усиления приёмника по максимуму SNR, без DOM: node tools/test-gainopt.mjs.
// Узел шлёт на приёмник усиление шагами, на каждом ждёт установления, усредняет SNR цели по кадрам спектра
// и берёт лучшее усиление без перегрузки АЦП (clip). Грубый проход, затем (refine) мелкий вокруг лучшего.

// усиления от gMin до gMax с шагом step (включая оба конца)
function goPlan(gMin,gMax,step){
  const lo=Math.min(gMin,gMax), hi=Math.max(gMin,gMax), st=Math.max(.1,+step||1), a=[];
  for(let g=lo;g<hi-1e-9;g+=st) a.push(Math.round(g*10)/10);
  a.push(hi);
  return a;
}
// лучшее усиление: максимум SNR среди шагов без перегрузки; в пределах tol дБ от максимума — самое низкое усиление
// (запас по динамике). Перегружены все — самое низкое из проверенных.
function goPick(res,clipPct,tol){
  if(!res.length) return null;
  const ok=res.filter(r=>!(r.clip>=clipPct) && Number.isFinite(r.snr));
  if(!ok.length) return res.reduce((a,r)=>r.g<a.g?r:a,res[0]);
  const mx=ok.reduce((a,r)=>r.snr>a?r.snr:a,-Infinity);
  return ok.filter(r=>r.snr>=mx-(tol||0)).reduce((a,r)=>r.g<a.g?r:a);
}
// запуск: возвращает первое усиление
function goStart(st,p,now){
  st.phase='coarse'; st.list=goPlan(p.gMin,p.gMax,p.gStep); st.i=0; st.res=[]; st.cmd=st.list[0];
  st.set=now; st.k=0; st.sum=0; st.pk=0; st.fl=0; st.clip=0; st.stopUp=false; st.best=null;
  return st.cmd;
}
// измерение очередного кадра спектра: o={now,snr,peak,floor,clip}. Возвращает усиление, которое нужно выставить сейчас.
// Кадры раньше p.settle мс после смены усиления отбрасываются (на железе смена асинхронна).
function goFeed(st,o,p){
  if(st.phase!=='coarse' && st.phase!=='fine') return st.cmd;
  if(o.now-st.set<p.settle) return st.cmd;
  if(Number.isFinite(o.snr)){ st.sum+=o.snr; st.pk+=o.peak; st.fl+=o.floor; st.k++; }
  if(o.clip>st.clip) st.clip=o.clip;
  if(st.k<Math.max(1,p.frames|0)) return st.cmd;
  st.res.push({g:st.cmd,snr:st.sum/st.k,peak:st.pk/st.k,floor:st.fl/st.k,clip:st.clip});
  if(st.clip>=p.clipPct && st.phase==='coarse') st.stopUp=true;   // выше будет только хуже — грубый проход обрываем
  st.i++; st.k=0; st.sum=st.pk=st.fl=st.clip=0;
  if(st.phase==='coarse' && (st.i>=st.list.length || st.stopUp)){
    const b=goPick(st.res,p.clipPct,p.tol);
    if(p.refine && b && p.gStep>1.5){                       // мелкий проход ±gStep вокруг лучшего, шаг 1 дБ, без уже проверенных
      const have=new Set(st.res.map(r=>r.g));
      st.list=goPlan(Math.max(p.gMin,b.g-p.gStep),Math.min(p.gMax,b.g+p.gStep),1).filter(g=>!have.has(g));
      if(st.stopUp) st.list=st.list.filter(g=>g<=b.g+1e-9 || st.res.every(r=>r.g>g || !(r.clip>=p.clipPct)));   // не лезем в зону, где уже была перегрузка
      st.list=st.list.filter(g=>!st.res.some(r=>r.clip>=p.clipPct && g>=r.g));
      if(st.list.length){ st.phase='fine'; st.i=0; st.cmd=st.list[0]; st.set=o.now; return st.cmd; }
    }
    return goFinish(st,p);
  }
  if(st.phase==='fine' && st.i>=st.list.length) return goFinish(st,p);
  st.cmd=st.list[st.i]; st.set=o.now; return st.cmd;
}
function goFinish(st,p){
  const b=goPick(st.res,p.clipPct,p.tol);
  st.best=b; st.phase='done';
  st.cmd=b ? Math.max(p.gMin,b.g-(p.backoff||0)) : st.cmd;
  return st.cmd;
}
// строка таблицы для узла
function goRow(r,best){
  return (best&&r.g===best.g ? '▶ ' : '  ')+String(r.g.toFixed(1)).padStart(5)+' dB  SNR '+(Number.isFinite(r.snr)?r.snr.toFixed(1):'—').padStart(5)+
    '  pk '+r.peak.toFixed(0).padStart(4)+'  floor '+r.floor.toFixed(0).padStart(4)+(r.clip>0 ? '  clip '+r.clip.toFixed(2)+'%' : '');
}
