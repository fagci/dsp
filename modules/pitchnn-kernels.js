"use strict";
/* ============================ Basic Pitch: ноты из звука (Spotify) — чистая логика ============================
   Сеть (pitchnn.js) на окне 43844 отсчётов 22050 Гц (≈2 с) даёт 172 кадра × 88 высот (MIDI 21…108, A0…C8): вероятность, что нота звучит.
   Здесь — выбор звучащих нот по последним кадрам, имена, частоты и события появления. Тест tools/test-pitchnn.mjs. */

const BP_SR=22050, BP_N=43844, BP_FRAMES=172, BP_LOW=21, BP_BINS=88;
const BP_NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const bpName=m=>BP_NAMES[((m%12)+12)%12]+(Math.floor(m/12)-1);
const bpFreq=m=>440*Math.pow(2,(m-69)/12);
// кадры frames[кадр][высота] (массив массивов или плоский Float32Array из BP_FRAMES·BP_BINS); берём среднее по кадрам [from,to) от начала окна;
// края окна у сети хуже видят контекст, поэтому по умолчанию — не последние 3 кадра, а 10 перед ними
function bpActive(frames,thr,from,to){
  from=from==null ? BP_FRAMES-13 : from; to=to==null ? BP_FRAMES-3 : to;
  const flat=!Array.isArray(frames), at=(t,b)=>flat ? frames[t*BP_BINS+b] : frames[t][b];
  const out=[];
  for(let b=0;b<BP_BINS;b++){
    let s=0; for(let t=from;t<to;t++) s+=at(t,b);
    s/=Math.max(1,to-from);
    if(s>=thr) out.push({midi:BP_LOW+b, name:bpName(BP_LOW+b), hz:bpFreq(BP_LOW+b), p:s});
  }
  // соседние высоты — один звук с «растёкшимся» пиком: оставляем наибольшую из подряд идущих
  const res=[];
  for(const n of out){
    const last=res[res.length-1];
    if(last && n.midi-last.midi===1){ if(n.p>last.p) res[res.length-1]=n; } else res.push(n);
  }
  return res;
}
// появившиеся относительно прошлого набора: [{midi,name,p}]
function bpNew(prev,cur){
  const had=new Set((prev||[]).map(n=>n.midi));
  return cur.filter(n=>!had.has(n.midi));
}
const bpText=list=>list.length ? list.map(n=>n.name).join(' ') : '—';
