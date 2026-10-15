"use strict";
/* Воркер программного DVB-S / DVB-S2 (modules/leandvb-kernels.js + vendor/leandvb.wasm): IQ с главного потока → транспортный поток и состояние.
   Сообщения: {type:'init', cfg} · {type:'iq', f:Float32Array (I,Q,I,Q…)} → {type:'ts', d}, {type:'st', st, drop, lost, ack} · {type:'err', msg}. */
const Q=self.location.search;
importScripts('modules/leandvb-kernels.js'+Q);
let dvb=null, wasm=null, chain=Promise.resolve();
const post=(m,tr)=>self.postMessage(m,tr||[]);
self.onmessage=e=>{
  const m=e.data;
  chain=chain.then(async()=>{
    try{
      if(m.type==='init'){
        if(!wasm){ const r=await fetch('vendor/leandvb.wasm'+Q); if(!r.ok) throw new Error('vendor/leandvb.wasm: HTTP '+r.status); wasm=await r.arrayBuffer(); }
        dvb=await LeanDvb.create(wasm); dvb.init(m.cfg); post({type:'ready'});
      }else if(m.type==='iq' && dvb){
        dvb.feed(m.f);
        const t=dvb.take();
        if(t) post({type:'ts', d:t},[t.buffer]);
        post({type:'st', st:dvb.st, drop:dvb.drop, lost:dvb.lostIn, ack:1});
      }else if(m.type==='iq') post({type:'st', st:null, ack:1});
    }catch(x){ dvb=null; post({type:'err', msg:x.message||String(x)}); }
  });
};
