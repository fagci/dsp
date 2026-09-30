"use strict";
// Воркер острова (см. core-islands.js): узлы с ядром из IQK, свой топологический порядок.
// config — состав острова (состояние узлов с теми же id сохраняется), tick — один такт движка.
const Q=self.location.search;
importScripts('core-dsp.js'+Q, 'modules/iq-kernels.js'+Q, 'modules/ccsds-kernels.js'+Q, 'modules/lrpt-msumr.js'+Q, 'modules/sonde-kernels.js'+Q, 'modules/inmarsat-kernels.js'+Q, 'modules/mpt1327-kernels.js'+Q, 'modules/ism-kernels.js'+Q, 'modules/fsk4-kernels.js'+Q, 'modules/dmr-kernels.js'+Q, 'modules/p25-kernels.js'+Q, 'modules/nxdn-kernels.js'+Q, 'modules/m17-kernels.js'+Q);

let nodes=new Map(), order=[], edges=[], outs={};
const sent=new Map();               // id → {port: последнее отправленное не-iq значение}

self.onmessage=e=>{
  const m=e.data;
  if(m.type==='config'){
    const next=new Map();
    for(const {id,type} of m.nodes){
      let st=nodes.get(id);
      if(!st || st.type!==type){ st={id, type, p:{}, out:{}}; st.init=false; }
      next.set(id,st);
    }
    nodes=next; order=m.nodes.map(x=>x.id); edges=m.edges; outs=m.outs;
    for(const id of [...sent.keys()]) if(!nodes.has(id)) sent.delete(id);
    return;
  }
  if(m.type!=='tick') return;
  const ctx={block:m.block, sr:m.sr}, res={}, tr=new Set();
  for(const id of order){
    const st=nodes.get(id), inp=m.in[id];
    if(!st || !inp) continue;
    st.p=inp.p;
    if(!st.init){ st.init=true; IQK[st.type].init(st); }
    const I=Object.assign({}, inp.I);
    for(const k in I){ const v=I[k];                   // сырые отсчёты АЦП → float здесь, а не в главном потоке
      if(v && v.chunks) for(const c of v.chunks) if(c.raw){ [c.re,c.im]=iqUnpack(c.raw,c.fmt); c.raw=null; } }
    for(const e of edges) if(e.to===id){ const src=nodes.get(e.from); I[e.tp]=src ? src.out[e.fp] ?? null : null; }
    let err=null;
    try{ st.out=IQK[st.type].process(st,I,ctx) || {}; }
    catch(x){ st.out={}; err=x.message||String(x); }
    const r={out:{}, ui:st.ui};
    if(err) r.err=err;
    const last=sent.get(id)||sent.set(id,{}).get(id);
    for(const port of outs[id]||[]){
      const v=st.out[port];
      if(v && v.chunks){
        r.out[port]={sr:v.sr, fc:v.fc, chunks:v.chunks.map(c=>{
          tr.add(c.re.buffer); if(c.im) tr.add(c.im.buffer);
          return {re:c.re, im:c.im, t0:c.t0, tag:c.tag}; })};
      } else if(v!==last[port]){ last[port]=v; r.out[port]=v; }   // числа и спектры — только при изменении
    }
    res[id]=r;
  }
  self.postMessage({res}, [...tr]);
};
