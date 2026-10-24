"use strict";
/* ======================= SA: MULTIBAND PANES — ядро ======================= */
// Чистая логика панелей без DOM: node tools/test-sapanes.mjs.

// число столбцов спектра диапазона: два на канал сетки (степень двойки, 1024…4096); шаг неизвестен — 2048
function sapResFor(span,step){
  if(!(span>0) || !(step>0)) return 2048;
  let r=1024; while(r<span/step*2 && r<4096) r*=2;
  return r;
}
// шумовая полка: нижний квантиль (по умолчанию 20%) конечных значений — сигналы её не завышают, как медиана
function sapFloor(lv,q=.2,tmp){
  let m=0; const t=tmp && tmp.length>=lv.length ? tmp : new Float32Array(lv.length);
  for(let i=0;i<lv.length;i++){ const v=lv[i]; if(v===v) t[m++]=v; }
  if(m<8) return NaN;
  const s=t.subarray(0,m); s.sort();
  return s[Math.min(m-1,Math.max(0,Math.floor(m*q)))];
}
// усреднение в дБ: a — доля старого (0 — без усреднения); пустое место берёт новое значение
const sapEma=(old,nw,a)=> !(old===old) || !(a>0) ? nw : old+(nw-old)*(1-a);
// столбец «старый», если не обновлялся дольше sec секунд (0 — не различать); ts=0 — данных нет
const sapOld=(ts,now,sec)=> sec>0 && ts>0 && now-ts>sec*1000;
// пики панели: локальные максимумы выше полки на minSnr дБ, не ближе win столбцов друг к другу; сильнейшие первыми
function sapPeaks(lv,ts,lo,hi,floor,minSnr=6,win=4,max=50){
  const N=lv.length, c=[];
  for(let i=0;i<N;i++){
    const v=lv[i]; if(!(v===v) || v-floor<minSnr) continue;
    let top=true;
    for(let j=Math.max(0,i-win);j<=Math.min(N-1,i+win);j++) if(j!==i && lv[j]===lv[j] && (lv[j]>v || (lv[j]===v && j<i))){ top=false; break; }
    if(top) c.push({f:lo+(hi-lo)*(i+.5)/N, db:v, snr:v-floor, ts:ts ? ts[i] : 0});
  }
  return c.sort((a,b)=>b.db-a.db).slice(0,max);
}
// CSV пиков: rows — [{band,f,db,snr,age}]
function sapCsv(rows){
  const q=s=>/[",\n]/.test(s) ? '"'+String(s).replace(/"/g,'""')+'"' : String(s);
  return 'band,freq_hz,level_db,snr_db,age_s\n'+rows.map(r=>[q(r.band),Math.round(r.f),r.db.toFixed(1),r.snr.toFixed(1),r.age==null ? '' : r.age.toFixed(0)].join(',')).join('\n')+'\n';
}
