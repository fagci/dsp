"use strict";
/* ============================ Фильтр и усреднение GPS-фиксов: ядро ============================
   Браузерная геолокация отдаёт то, что решил телефон: спутники (≈ 3–10 м под открытым небом) или оценку по Wi-Fi / вышкам (20–100 м и хуже), и они чередуются.
   Здесь: классификация точности, лучшая точность за минуту, отбор по порогу и усреднение с весами 1/acc² (случайная ошибка падает, систематическая — нет).
   Чистая логика без DOM: node tools/test-geofix.mjs */

function gfClass(acc){
  if(!(acc>0)) return '';
  if(acc<=8) return 'satellites, open sky';
  if(acc<=25) return 'GPS, weak (buildings, trees)';
  if(acc<=100) return 'probably a Wi-Fi / cell estimate, not the satellites';
  return 'cell towers only (coarse)';
}
function gfPush(hist,fix,now,keepS=180){ hist.push({lat:fix.lat,lon:fix.lon,acc:fix.acc,alt:fix.alt,speed:fix.speed,heading:fix.heading,t:fix.t,at:now}); while(hist.length && now-hist[0].at>keepS*1000) hist.shift(); }
function gfBest(hist,now,sec=60){ let b=null; for(const h of hist) if(now-h.at<=sec*1000 && h.acc>0 && (b===null || h.acc<b)) b=h.acc; return b; }
// фикс по настройкам: avg — секунд усреднения (0 — последний), maxAcc — худшие отбрасываются (0 — берём все)
function gfSelect(hist,now,o={}){
  const ok=h=>h.acc>0 ? (!(o.maxAcc>0) || h.acc<=o.maxAcc) : !(o.maxAcc>0);
  const use=hist.filter(h=>ok(h) && (o.avg>0 ? now-h.at<=o.avg*1000 : true));
  if(!use.length) return null;
  if(!(o.avg>0)){ const h=use[use.length-1]; return {lat:h.lat,lon:h.lon,acc:h.acc,alt:h.alt,speed:h.speed,heading:h.heading,t:h.t,n:1}; }
  let sw=0,la=0,lo=0,sa=0,swa=0; const accs=[];
  for(const h of use){ const a=h.acc>0 ? h.acc : 50, w=1/(a*a); sw+=w; la+=h.lat*w; lo+=h.lon*w; if(h.alt!=null && isFinite(h.alt)){ sa+=h.alt*w; swa+=w; } accs.push(a); }
  accs.sort((a,b)=>a-b); const med=accs[accs.length>>1], last=use[use.length-1];
  // фиксы коррелируют: эффективно не больше ~10 независимых
  return {lat:la/sw,lon:lo/sw,acc:med/Math.sqrt(Math.min(use.length,10)),alt:swa ? sa/swa : null,speed:last.speed,heading:last.heading,t:last.t,n:use.length};
}
