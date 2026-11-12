"use strict";
/* ============================ Пакет «граф + офлайн-данные» ============================
   Один файл .dspbundle (JSON): граф (как «Save to file») и выбранные файлы из Files → «Offline data» (модели, словари, карты).
   Открывается тем же «Open file»: файлы кладутся на место, граф загружается. Без DOM — tools/test-bundle.mjs. Нужен backup-kernels.js (bkEnc/bkDec). */

const BUNDLE_FORMAT='dsp-bundle';
// graph — результат serialize(); files — [{name, blob}] → Blob пакета
async function bundlePack(graph,files){
  const off=[]; for(const f of files||[]) off.push({name:f.name, data:await bkEnc(f.blob)});
  return new Blob([JSON.stringify({format:BUNDLE_FORMAT, v:1, t:new Date().toISOString(), graph, offline:off})],{type:'application/json'});
}
// объект пакета → {graph, files:[{name, blob}]}; бросает на чужом или неполном файле
function bundleUnpack(o){
  if(!o || o.format!==BUNDLE_FORMAT) throw new Error('not a DSP bundle');
  if(!o.graph || typeof o.graph!=='object') throw new Error('the bundle has no graph');
  const files=[];
  for(const f of Array.isArray(o.offline) ? o.offline : []){
    if(!f || typeof f.name!=='string' || !f.name || /[\\/]/.test(f.name)) continue;     // имя без путей: кладём только в «Offline data»
    const b=bkDec(f.data); if(b instanceof Blob && b.size) files.push({name:f.name, blob:b});
  }
  return {graph:o.graph, files};
}
const bundleMB=b=>(b/1048576).toFixed(b<1048576*10 ? 1 : 0)+' MB';
