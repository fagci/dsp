"use strict";
/* Воркер Signal Analyzer: разбор захвата (modules/siglab-kernels.js). {id, re, im, sr, cfg} → {id, R} или {id, err}. */
const Q=self.location.search;
importScripts('modules/siglab-kernels.js'+Q);
self.onmessage=e=>{
  const d=e.data;
  try{
    const R=slAnalyzeFull(d.re,d.im,d.sr,d.cfg), tr=[], seen=new Set();
    for(const k of ['mag','dem','pyrM','pyrD']){ const a=R[k]; if(a && !seen.has(a.buffer)){ seen.add(a.buffer); tr.push(a.buffer); } }
    self.postMessage({id:d.id,R},tr);
  }catch(x){ self.postMessage({id:d.id,err:x.message||String(x)}); }
};
