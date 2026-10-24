"use strict";
/* ============================ Нейросети для звука ============================
   Модели крутятся прямо в браузере. Потоковая обмотка (пересчёт частоты, кадры, задержка) — nnaudio-kernels.js, тест tools/test-nnaudio.mjs.
   RNNoise (BSD-3, Xiph; сборка Jitsi, wasm 112 КБ в vendor/rnnoise.wasm): шумоподавление речи рекуррентной сетью, кадры 480 отсчётов на 48 кГц,
   на выходе ещё и вероятность речи в кадре. Модель из версии 0.1 библиотеки. Большие модели (Silero, YAMNet…) лежат в Files → Offline data. */

const RN={p:null, mod:null, err:''};
function rnLoad(){
  if(RN.p) return RN.p;
  return RN.p=(async()=>{
    const [wasm]=await Promise.all([
      fetch('vendor/rnnoise.wasm').then(r=>{ if(!r.ok) throw new Error('rnnoise.wasm HTTP '+r.status); return r.arrayBuffer(); }),
      new Promise((res,rej)=>{ if(self.createRNNWasmModule) return res();
        const s=document.createElement('script'); s.src='vendor/rnnoise.js?v=0.2.1'; s.onload=()=>res(); s.onerror=()=>rej(new Error('rnnoise.js did not load')); document.head.append(s); })]);
    RN.mod=await self.createRNNWasmModule({wasmBinary:wasm});
  })().catch(e=>{ RN.err=String(e.message||e); RN.p=null; });
}
// один потоковый шумодав: состояние сети в куче wasm, буферы кадра рядом
function rnNew(sr,mixOf){
  const M=RN.mod, st=M._rnnoise_create(0), pi=M._malloc(480*4), po=M._malloc(480*4), o={st,pi,po,vad:0,dead:false};
  o.stream=nnStream(sr,48000,480,f=>{
    const H=M.HEAPF32, a=pi>>2;                           // HEAPF32 меняется при росте памяти — берём заново
    for(let i=0;i<480;i++) H[a+i]=f[i]*32768;
    o.vad=M._rnnoise_process_frame(st,po,pi);
    const H2=M.HEAPF32, b=po>>2, m=mixOf(), r=new Float32Array(480);
    for(let i=0;i<480;i++) r[i]=f[i]*(1-m)+H2[b+i]/32768*m;
    return r;
  });
  o.free=()=>{ if(o.dead) return; o.dead=true; M._rnnoise_destroy(st); M._free(pi); M._free(po); };
  return o;
}

def({ id:'rnnoise', title:'Denoiser (RNNoise, neural)', cat:'Audio', readout:true, w:240,
  kw:'noise suppression denoise speech voice neural network rnnoise ai vad clean radio',
  // in — звук; mix — доля очищенного звука; vad — вероятность речи (0…1), speech — 1, когда она выше порога
  ins:[{n:'in',t:'sig'},{n:'mix',t:'num'}],
  outs:[{n:'out',t:'sig'},{n:'vad',t:'num'},{n:'speech',t:'num'}],
  params:[{n:'mix',t:'range',min:0,max:1,step:.01,d:1,label:'cleaned share (1 — fully cleaned, 0 — original)'},
          {n:'thr',t:'range',min:.1,max:.95,step:.01,d:.6,label:'speech threshold (for the speech output)'}],
  init(n){ n.rn=null; n.rsr=0; n.status='loading RNNoise…'; n.hold=0; },
  dispose(n){ n.rn?.free(); n.rn=null; },
  process(n,I){
    if(typeof I.mix==='number') setMod(n,'mix',I.mix);
    const x=I.in||buf(n,'z'), out=buf(n,'out');
    if(!RN.mod){ rnLoad(); n.status=RN.err ? 'error: '+RN.err : 'loading RNNoise…'; out.set(x); return {out,vad:0,speech:0}; }
    if(!n.rn || n.rsr!==Eng.sr){ n.rn?.free(); n.rn=rnNew(Eng.sr,()=>n.p.mix); n.rsr=Eng.sr; }
    out.set(n.rn.stream.push(x));
    const v=n.rn.vad, sp=v>=n.p.thr ? 1 : 0;
    n.status='RNNoise · delay '+(n.rn.stream.latency*1000).toFixed(0)+' ms · speech '+Math.round(v*100)+'%'+(Eng.sr!==48000 ? ' · resampled from '+Eng.sr+' Hz' : '');
    return {out,vad:v,speech:sp}; },
  drawKey:n=>n.status,
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.status; }});
