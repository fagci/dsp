"use strict";
/* ======================= SLEEP TIMER — ядро ======================= */
// Таймер сна без DOM: node tools/test-sleep.mjs. Считает усиление по оставшемуся времени: до начала затухания 1, дальше плавно к 0.

const SLP_CURVES=['quadratic','cosine','linear'];

// left — секунд до конца, fade — длина затухания; квадратичная кривая ближе к тому, как ухо слышит громкость (линейный спад «обрывается» в конце)
function slGain(left,fade,curve){
  fade=Math.max(.001,+fade||0);
  if(!(left>0)) return 0;
  if(left>=fade) return 1;
  const u=left/fade;
  return curve==='cosine' ? .5-.5*Math.cos(Math.PI*u) : curve==='linear' ? u : u*u;
}
// 3725 → «1:02:05», 74 → «1:14»
function slFmt(s){
  s=Math.max(0,Math.ceil((+s||0)-1e-9));
  const h=Math.floor(s/3600), m=Math.floor(s%3600/60), x=s%60, p=v=>String(v).padStart(2,'0');
  return h ? h+':'+p(m)+':'+p(x) : m+':'+p(x);
}
