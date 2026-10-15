"use strict";
/* Воркер программного DVB-S / DVB-S2 (modules/leandvb-kernels.js + vendor/leandvb.wasm): IQ с главного потока → транспортный поток и состояние.
   Сообщения: {type:'init', cfg} · {type:'iq', f:Float32Array (I,Q,I,Q…)} → {type:'ts', d}, {type:'st', st, drop, lost, ack} · {type:'err', msg}. */
const Q=self.location.search;
importScripts('modules/leandvb-kernels.js'+Q);
let dvb=null, wasm={}, chain=Promise.resolve(), std='';
const post=(m,tr)=>self.postMessage(m,tr||[]);
// transport stream, frame jobs for the pool and the status go to the main thread; ack tells how many input blocks were consumed
function flush(ack){
  const t=dvb.take();
  if(t) post({type:'ts', d:t},[t.buffer]);
  if(dvb.takeJobs) for(const j of dvb.takeJobs()) post({type:'job', seq:j.seq, d:j.d.buffer},[j.d.buffer]);
  post({type:'st', st:dvb.st, drop:dvb.drop, lost:dvb.lostIn, ack, info:dvb.st.info||'', js:dvb.js||null});
}
self.onmessage=e=>{
  const m=e.data;
  chain=chain.then(async()=>{
    try{
      if(m.type==='init'){
        std=m.cfg.std; const t2=std==='DVB-T2', file=t2 ? 'vendor/dvbofdm.wasm' : 'vendor/leandvb.wasm';
        if(!wasm[file]){ const r=await fetch(file+Q); if(!r.ok) throw new Error(file+': HTTP '+r.status); wasm[file]=await r.arrayBuffer(); }
        dvb=t2 ? await DvbOfdm.create(wasm[file]) : await LeanDvb.create(wasm[file]); dvb.init(m.cfg); if(t2 && m.cfg.par) dvb.setParallel(true); post({type:'ready'});
      }else if(m.type==='gap'){ if(dvb && dvb.gap) dvb.gap();
      }else if(m.type==='iq' && dvb){
        dvb.feed(m.f);
        flush(1);
      }else if(m.type==='result' && dvb){ dvb.result(new Uint8Array(m.d)); flush(0);
      }else if(m.type==='drop' && dvb){ dvb.skipJob(m.seq); flush(0);
      }else if(m.type==='iq') post({type:'st', st:null, ack:1});
    }catch(x){ dvb=null; post({type:'err', msg:x.message||String(x)}); }
  });
};
