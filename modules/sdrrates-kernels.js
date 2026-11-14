"use strict";
/* ============================ Частоты дискретизации USB-приёмников (ядро) ============================
   Драйвер сообщает, что умеет донгл: rates — точный список (Airspy, Airspy HF+ отдают его сами) или rateRange — [мин, макс] Гц
   (RTL-SDR, HackRF, Mirics, RX-888). sdrRateOpts строит список для выбора: точный список как есть, диапазон — значения
   общей сетки внутри него, без донгла (или файл) — вся сетка. sdrRateSnap берёт ближайшую допустимую (по отношению частот).
   Проверка: node tools/test-sdrrates.mjs */

function sdrRateOpts(dev, grid){
  if(dev && Array.isArray(dev.rates) && dev.rates.length) return [...new Set(dev.rates.map(Number))].filter(r=>r>0).sort((a,b)=>a-b);
  const r=dev && dev.rateRange;
  if(Array.isArray(r) && r.length===2){
    const l=grid.filter(x=>x>=r[0] && x<=r[1]);
    if(l.length) return l;
  }
  return grid.slice();
}
function sdrRateSnap(list, v){
  v=+v; if(!(v>0) || !list.length) return list[0];
  return list.reduce((a,b)=>Math.abs(Math.log(b/v))<Math.abs(Math.log(a/v)) ? b : a);
}
