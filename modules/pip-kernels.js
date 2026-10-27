"use strict";
/* PiP: пропорции окна. Android принимает отношение сторон от 1:2.39 до 2.39:1 — вне него окно PiP не откроется. Без DOM — tools/test-pip.mjs */

// ширина и высота холста → целые числа для окна PiP (отношение внутри допустимых границ)
function pipRatio(w,h){
  w=+w; h=+h;
  if(!(w>0) || !(h>0)) return [16,9];
  let r=w/h;
  r=Math.max(1/2.39,Math.min(2.39,r));
  return [Math.round(r*1000),1000];
}

// вписать картинку w×h в окно W×H без искажений (как object-fit: contain); возвращает целые размеры
function pipFit(w,h,W,H){
  if(!(w>0) || !(h>0) || !(W>0) || !(H>0)) return [Math.max(1,W|0),Math.max(1,H|0)];
  const k=Math.min(W/w,H/h);
  return [Math.max(1,Math.floor(w*k)),Math.max(1,Math.floor(h*k))];
}
