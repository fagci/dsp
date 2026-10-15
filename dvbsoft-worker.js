"use strict";
/* Воркер программного DVB-S / DVB-S2 (modules/leandvb-kernels.js + vendor/leandvb.wasm): IQ с главного потока → транспортный поток и состояние.
   Сообщения: {type:'init', cfg} · {type:'iq', f:Float32Array (I,Q,I,Q…)} → {type:'ts', d}, {type:'st', st, drop, lost, ack} · {type:'err', msg}. */
const Q=self.location.search;
importScripts('modules/leandvb-kernels.js'+Q);
let dvb=null, wasm={}, chain=Promise.resolve(), std='';
const post=(m,tr)=>self.postMessage(m,tr||[]);
self.onmessage=e=>{
  const m=e.data;
  chain=chain.then(async()=>{
    try{
      if(m.type==='init'){
        std=m.cfg.std; const t2=std==='DVB-T2', file=t2 ? 'vendor/dvbofdm.wasm' : 'vendor/leandvb.wasm';
        if(!wasm[file]){ const r=await fetch(file+Q); if(!r.ok) throw new Error(file+': HTTP '+r.status); wasm[file]=await r.arrayBuffer(); }
        dvb=t2 ? await DvbOfdm.create(wasm[file]) : await LeanDvb.create(wasm[file]); dvb.init(m.cfg); post({type:'ready'});
      }else if(m.type==='iq' && dvb){
        dvb.feed(m.f);
        const t=dvb.take();
        if(t) post({type:'ts', d:t},[t.buffer]);
        post({type:'st', st:dvb.st, drop:dvb.drop, lost:dvb.lostIn, ack:1, info:dvb.st.info||'', js:dvb.js||null});
      }else if(m.type==='iq') post({type:'st', st:null, ack:1});
    }catch(x){ dvb=null; post({type:'err', msg:x.message||String(x)}); }
  });
};
