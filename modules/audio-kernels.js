"use strict";
/* ============================ Ядро аудио-вложений ============================
   В ячейке колонки audio лежат id клипов библиотеки семплов: «sm-12 sm-15». Сам звук остаётся в dsp-samples,
   поэтому клип открывается и в Sample Library / Sampler, а ссылка попадает в полную копию вместе с семплами.
   Без DOM — проверяется tools/test-audio.mjs. */

// «sm-12 sm-15», «12;15», число 12 → [12,15]; остальное отбрасывается, повторы убираются
function auIds(cell){
  const out=[];
  for(const s of String(cell??'').split(/[\s,;]+/)){
    const m=/^(?:sm-)?(\d+)$/i.exec(s), id=m ? +m[1] : 0;
    if(id>0 && !out.includes(id)) out.push(id);
  }
  return out;
}
const auJoin=ids=>ids.map(i=>'sm-'+i).join(' ');
