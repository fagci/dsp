"use strict";
/* ============================ ОСТРОВА: узлы с ядром в воркере ============================
   Узлы с kernel (IQ-блоки), связанные проводами, образуют остров — он считается в своём
   воркере (iq-worker.js). В главном потоке вместо process() работает прокси: входы снаружи
   острова и параметры уходят в воркер раз в такт, выходы приходят асинхронно (такт-два спустя)
   и отдаются потребителям. Поток 'iq' задержку переносит (IQ → Audio держит запас), числа и
   спектры просто запаздывают. Узлы внутри групп и режим без воркеров — в главном потоке. */
const ISL_MAX_INFLIGHT=64;          // тактов без ответа (~0.7 с) — дальше входы выбрасываются
const ISL_Q=(document.currentScript?.src||'').split('?')[1]||'';

const Islands={
  enabled: typeof Worker!=='undefined',
  list: [],
  dropped: 0,                       // тактов, выброшенных из-за отставания воркеров
  setEnabled(v){ this.enabled=!!v; this.rebuild(); },
  // Связные компоненты узлов с ядром; воркер переиспользуется, если остров сохранил хоть один узел
  rebuild(){
    const kn=this.enabled ? Graph.order.filter(n=>MOD[n.type]?.kernel) : [];
    const par=new Map(kn.map(n=>[n.id,n.id]));
    const root=id=>{ while(par.get(id)!==id){ par.set(id,par.get(par.get(id))); id=par.get(id); } return id; };
    for(const e of Graph.edges) if(par.has(e.from) && par.has(e.to)) par.set(root(e.from), root(e.to));
    const comps=new Map();
    for(const n of kn){ const r=root(n.id); (comps.get(r)||comps.set(r,[]).get(r)).push(n); }
    const old=this.list, next=[];
    for(const nodes of comps.values()){
      const ids=new Set(nodes.map(n=>n.id));
      const i=old.findIndex(isl=>isl && isl.ids.some(id=>ids.has(id)));
      let isl;
      try{ isl=i>=0 ? old.splice(i,1,null)[0] : islNew(); }
      catch(e){                                  // new Worker запрещён (file://, политика) — без островов
        console.warn('[islands] воркеры недоступны:', e.message);
        this.list=old.filter(Boolean).concat(next); this.enabled=false; return this.rebuild();
      }
      islConfigure(isl, nodes, ids);
      next.push(isl);
    }
    for(const isl of old) if(isl) isl.w.terminate();
    for(const n of Graph.nodes) n._isl=null;
    for(const isl of next) for(const id of isl.ids) Graph.map[id]._isl=isl;
    this.list=next;
  },
};

function islNew(){
  const isl={w:new Worker('iq-worker.js'+(ISL_Q?'?'+ISL_Q:'')), ids:[], inflight:0,
    pending:new Map(), hold:new Map(), msg:null};
  isl.w.onmessage=e=>islResult(isl,e.data);
  // воркер не поднялся (нет файла в офлайн-кэше и т.п.) — всё обратно в главный поток
  isl.w.onerror=e=>{ console.error('[islands] воркер:', e.message, '— узлы считаются в главном потоке');
    e.preventDefault(); Islands.setEnabled(false); };
  return isl;
}
function islConfigure(isl, nodes, ids){
  isl.ids=nodes.map(n=>n.id);
  isl.first=isl.ids[0]; isl.last=isl.ids[isl.ids.length-1];
  isl.ext=new Map(); isl.outs=new Map();
  const inner=[];
  for(const e of Graph.edges){
    const fi=ids.has(e.from), ti=ids.has(e.to);
    if(fi && ti) inner.push({from:e.from, fp:e.fp, to:e.to, tp:e.tp});
    else if(ti) (isl.ext.get(e.to)||isl.ext.set(e.to,[]).get(e.to)).push(e.tp);
    else if(fi){ const s=isl.outs.get(e.from)||isl.outs.set(e.from,new Set()).get(e.from); s.add(e.fp); }
  }
  for(const id of [...isl.hold.keys()]) if(!ids.has(id)){ isl.hold.delete(id); isl.pending.delete(id); }
  isl.w.postMessage({type:'config', nodes:nodes.map(n=>({id:n.id, type:n.type})), edges:inner,
    outs:Object.fromEntries([...isl.outs].map(([id,s])=>[id,[...s]]))});
}
// параметры — только примитивы (в n.p бывают служебные объекты)
function islParams(p){
  const o={};
  for(const k in p){ const v=p[k]; if(v===null || typeof v!=='object' && typeof v!=='function') o[k]=v; }
  return o;
}
// Прокси вместо process(): вход — в сообщение такта, выход — что успело прийти из воркера
function islProcess(n,I){
  const isl=n._isl;
  if(n.id===isl.first || !isl.msg) isl.msg={type:'tick', block:BLOCK, sr:Eng.sr, in:{}};
  const inp={p:islParams(n.p)}, ext=isl.ext.get(n.id);
  if(ext){ inp.I={}; for(const port of ext) inp.I[port]=islPack(I[port]); }
  isl.msg.in[n.id]=inp;
  const out=islTake(isl,n);
  if(n.id===isl.last){
    // пока воркер грузит скрипты (ещё ни одного ответа), такты копятся в его очереди, а не теряются
    if(isl.inflight<(isl.ready ? ISL_MAX_INFLIGHT : 1000)){ isl.inflight++; isl.w.postMessage(isl.msg); }
    else Islands.dropped++;       // воркер не успевает: такт теряется, у потока будет разрыв t0
    isl.msg=null;
  }
  return out;
}
// поток — без служебных полей чанков (_z); сырые чанки уходят как есть, во float — уже в воркере
function islPack(v){
  if(!v || !v.chunks) return v;
  return {sr:v.sr, fc:v.fc, chunks:v.chunks.map(c=>c.raw ? {raw:c.raw, fmt:c.fmt, t0:c.t0, tag:c.tag}
    : {re:c.re, im:c.im, t0:c.t0, tag:c.tag})};
}
function islTake(isl,n){
  const r=isl.pending.get(n.id); isl.pending.delete(n.id);
  const hold=isl.hold.get(n.id)||isl.hold.set(n.id,{}).get(n.id);
  if(r){
    if(r.ui!==undefined) n.ui=r.ui;
    if(r.err){ if(!n.err) console.error('[islands] '+n.type+':', r.err); n.err=new Error(r.err); }
    for(const port in r.out) hold[port]=r.out[port];
  }
  const out={};
  for(const port in hold){
    const v=hold[port];
    // чанки отдаются один раз; без новых — пустой поток с прежними sr/fc
    out[port]=v && v.chunks && !(r && port in r.out) ? {sr:v.sr, fc:v.fc, chunks:[], t:0} : v;
  }
  return out;
}
// Ответ воркера: чанки копятся до ближайшего такта, числа и спектры — последнее значение
function islResult(isl,m){
  isl.ready=true;
  isl.inflight=Math.max(0,isl.inflight-1);
  for(const id in m.res){
    const r=m.res[id], p=isl.pending.get(id);
    if(!p){ isl.pending.set(id,r); continue; }
    if(r.ui!==undefined) p.ui=r.ui;
    if(r.err) p.err=r.err;
    for(const port in r.out){
      const v=r.out[port], q=p.out[port];
      if(v && v.chunks && q && q.chunks) q.chunks=q.chunks.concat(v.chunks), q.sr=v.sr, q.fc=v.fc;
      else p.out[port]=v;
    }
  }
}
