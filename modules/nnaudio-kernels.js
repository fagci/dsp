"use strict";
/* ============================ Нейросети для звука: потоковая обмотка вокруг модели ============================
   Модели работают кадрами фиксированной длины на своей частоте (RNNoise — 480 отсчётов на 48 кГц), а граф — блоками BLOCK на частоте движка.
   nnStream берёт блоки, при необходимости пересчитывает частоту (линейная интерполяция), копит кадры, гоняет через fn и отдаёт блок той же длины.
   Задержка — один кадр (RNNoise: 10 мс) плюс пересчёт; на старте тишина. Чистая логика без DOM, проверяется tools/test-nnaudio.mjs. */

// потоковый линейный ресэмплер: run(блок) → блок, длины в отношении to/from, без щелчков на стыках
function nnResampler(from,to){
  const step=from/to; let p=0, last=0;
  return { step, run(x){
    const n=x.length, out=new Float32Array(Math.ceil(n/step)+2); let k=0;
    while(p<n-1){
      const i=Math.floor(p), f=p-i, a=i<0 ? last : x[i];
      out[k++]=a+(x[i+1]-a)*f; p+=step;
    }
    p-=n; if(n) last=x[n-1];
    return out.subarray(0,k);
  }};
}

// sr — частота блоков, model — частота модели, frame — длина кадра модели, fn(кадр Float32Array(frame)) → Float32Array(frame)
function nnStream(sr,model,frame,fn){
  const up=sr!==model ? nnResampler(sr,model) : null, dn=sr!==model ? nnResampler(model,sr) : null;
  let inq=new Float32Array(frame*8), ni=0;
  let outq=new Float32Array(frame*16), no=0;
  const pre=Math.ceil(frame*sr/model)+2;                 // запас, чтобы блоки не кратные кадру не давали разрывов
  no=pre; let under=0;
  const add=(q,n,x)=>{ if(n+x.length>q.length){ const b=new Float32Array(Math.max(q.length*2,n+x.length)); b.set(q.subarray(0,n)); q=b; } q.set(x,n); return q; };
  return {
    latency:pre/sr,                                      // секунды
    get underruns(){ return under; },
    push(x){
      const m=up ? up.run(x) : x;
      inq=add(inq,ni,m); ni+=m.length;
      let off=0;
      while(ni-off>=frame){
        const o=fn(inq.subarray(off,off+frame)), r=dn ? dn.run(o) : o;
        outq=add(outq,no,r); no+=r.length; off+=frame;
      }
      if(off){ inq.copyWithin(0,off,ni); ni-=off; }
      const out=new Float32Array(x.length), k=Math.min(no,x.length);
      out.set(outq.subarray(0,k));
      if(k<x.length) under++;
      outq.copyWithin(0,k,no); no-=k;
      return out;
    }};
}
