"use strict";
/* Пул воркеров DVB-T2: каждый декодирует целый кадр (демодуляция, L1-post, FEC) по заданию воркера dvbsoft-worker.js (modules/leandvb-kernels.js + vendor/dvbofdm.wasm).
   Сообщения: {type:'init'} · {type:'job', seq, d:ArrayBuffer} → {type:'res', seq, d} · {type:'ready'} · {type:'err', msg, seq?} */
const Q=self.location.search;
importScripts('modules/leandvb-kernels.js'+Q);
let dvb=null, chain=Promise.resolve();
const post=(m,tr)=>self.postMessage(m,tr||[]);
self.onmessage=e=>{
  const m=e.data;
  chain=chain.then(async()=>{
    try{
      if(m.type==='init'){
        const r=await fetch('vendor/dvbofdm.wasm'+Q); if(!r.ok) throw new Error('vendor/dvbofdm.wasm: HTTP '+r.status);
        dvb=await DvbOfdm.create(await r.arrayBuffer()); dvb.initPool(); post({type:'ready'});
      }else if(m.type==='job' && dvb){
        const o=dvb.run(new Uint8Array(m.d));
        post({type:'res', seq:m.seq, d:o.buffer},[o.buffer]);
      }
    }catch(x){ post({type:'err', msg:x.message||String(x), seq:m.seq}); }
  });
};
