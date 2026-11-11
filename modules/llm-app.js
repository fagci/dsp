"use strict";
/* ============================ Языковые модели на телефоне (приложение Android, llama.cpp) ============================
   Хост «app» в узле Ollama: чат идёт не на сервер Ollama, а в llama.cpp внутри приложения — на CPU с dotprod, а где есть OpenCL (Adreno) — с GPU.
   Модели — файлы GGUF в каталоге приложения (model.get качает и докачивает); ответ приходит по мосту по токенам (записи ev:'tok').
   Для GPU берите квантование Q4_0 (ядра ggml-opencl под Adreno рассчитаны на него и на Q8_0), остальные идут на CPU.
   Сторона телефона — AiHub.kt / AiCore.kt / native/llama/llama_jni.cpp; проверка — tools/test-llmapp.mjs. */

const LLM_CATALOG={
  'qwen2.5-1.5b-instruct-q4_0':{mb:1000,url:'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_0.gguf',note:'fast, Russian is fair'},
  'qwen2.5-3b-instruct-q4_0':{mb:1900,url:'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_0.gguf',note:'better Russian, wants a phone with 8 GB'},
  'llama-3.2-3b-instruct-q4_0':{mb:1900,url:'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_0.gguf',note:'English first, Russian is weaker'}};
// что написано в поле model → файл на телефоне и откуда его взять: ключ каталога, адрес .gguf или имя файла, уже лежащего на телефоне
function llmSpec(m){
  let t=String(m||'').trim(); if(!t) return null;
  const key=t.replace(/\.gguf$/i,'').toLowerCase();
  if(LLM_CATALOG[key]) return {name:key+'.gguf',url:LLM_CATALOG[key].url,mb:LLM_CATALOG[key].mb};
  if(/^https?:\/\/\S+$/i.test(t)){
    let seg=''; try{ seg=decodeURIComponent(new URL(t).pathname.split('/').pop()||''); }catch(e){}
    seg=seg.replace(/[^A-Za-z0-9._-]/g,'_').replace(/^[._-]+/,'');
    if(!/\.gguf$/i.test(seg)) seg=(seg||'model')+'.gguf';
    return {name:seg.slice(0,100),url:t,mb:0};
  }
  if(!/\.gguf$/i.test(t)) t+='.gguf';
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(t) ? {name:t,url:'',mb:0} : null;
}
const LLMAP={ready:'',key:'',loading:null,prog:'',info:'',unsupported:false,off:null};
function llmWatch(){
  if(LLMAP.off || !AppLink.ok) return;
  LLMAP.off=AppLink.on(r=>{
    if(r.src!=='ai' || r.ev!=='progress' || !/\.gguf$/i.test(r.name||'')) return;
    const mb=b=>Math.round(b/1048576);
    LLMAP.prog='downloading '+r.name+' · '+(r.total>0 ? Math.round(100*r.done/r.total)+'% · '+mb(r.done)+' / '+mb(r.total)+' MB' : mb(r.done)+' MB');
  });
}
// файлы .gguf на телефоне: [{name,size}]
async function llmAppModels(){
  const l=await AppLink.call('model.list',{},10000);
  return (l.models||[]).filter(m=>/\.gguf$/i.test(m.name) && !m.partial).map(m=>({name:m.name,size:m.size}));
}
// модель на телефоне и в памяти движка; повторные вызовы с теми же настройками — мгновенно
function llmAppLoad(spec,o){
  const key=spec.name+'|'+(o.gpu ? 'gpu' : 'cpu')+'|'+o.ctx;
  if(LLMAP.ready===key) return Promise.resolve();
  if(LLMAP.loading && LLMAP.key===key) return LLMAP.loading;
  LLMAP.key=key; llmWatch();
  return LLMAP.loading=(async()=>{
    LLMAP.prog='asking the phone…';
    const c=await AppLink.call('ai.caps',{},10000);
    if(!c.dotprod || !c.fp16 || !c.arm64){ LLMAP.unsupported=true; throw new Error('this phone cannot run the native engine (arm64 with dotprod and fp16 needed)'); }
    if(!(await llmAppModels()).some(m=>m.name===spec.name)){
      if(!spec.url) throw new Error('no file «'+spec.name+'» on the phone — pick a model from the list («⟳ Models») or give an address of a .gguf');
      LLMAP.prog='downloading '+spec.name+'…';
      await AppLink.call('model.get',{name:spec.name,url:spec.url},0);
    }
    LLMAP.prog='loading '+spec.name+' into memory…';
    const r=await AppLink.call('llm.load',{model:spec.name,gpu:!!o.gpu,ctx:o.ctx},300000);
    LLMAP.ready=key; LLMAP.info=(r.gpu ? 'GPU (OpenCL)' : 'CPU')+(r.ms ? ' · loaded in '+(r.ms/1000).toFixed(1)+' s' : '')+' · context '+r.ctx; LLMAP.prog='';
    return r;
  })().catch(e=>{ LLMAP.ready=''; LLMAP.prog=''; throw e; }).finally(()=>{ LLMAP.loading=null; });
}
// ответ по токенам: onTok(текст) на каждый кусок; signal.abort() останавливает генерацию на телефоне и бросает AbortError
async function llmAppRun(spec,o,onTok){
  await llmAppLoad(spec,o);
  const ns=await AppLink.link();
  const id=ns.seq+1;                                              // номер команды: записи ev:'tok' несут его как rid (call() берёт номер синхронно)
  const off=AppLink.on(r=>{ if(r.src==='ai' && r.ev==='tok' && r.rid===id) onTok(r.text); });
  const stop=()=>{ AppLink.call('llm.stop',{},5000).catch(()=>{}); };
  o.signal?.addEventListener('abort',stop);
  try{
    return await ns.call('llm.chat',{messages:o.messages,max:o.max||512,temp:o.temp ?? .7,seed:o.seed||0,...(o.threads>0 ? {threads:o.threads} : {})},0);
  }catch(e){
    if(o.signal?.aborted) throw Object.assign(new Error('aborted'),{name:'AbortError'});
    throw e;
  }finally{ off(); o.signal?.removeEventListener('abort',stop); }
}
// замер на этом телефоне: короткая генерация при разном числе потоков (без KV-кэша); → {rows:[{threads,tps,ptps}], best, fast}
async function llmAppBench(spec,o){
  await llmAppLoad(spec,o);
  return AppLink.call('llm.bench',{},600000);
}
const llmBenchText=r=>r.rows.map(x=>x.threads+' threads: '+x.tps+' tok/s (request '+x.ptps+' tok/s)'+(x.threads===r.best ? ' ◀ best' : '')).join('\n');
// пункты «⇩ offline» в Files: модели на телефоне (внутри приложения)
if(typeof OfflineData!=='undefined' && typeof AppLink!=='undefined' && AppLink.ok){
  for(const k of Object.keys(LLM_CATALOG)){
    const sp=llmSpec(k);
    OfflineData.item({id:'llm-app-'+k,label:'LLM on the phone: '+k+' (DSP app, llama.cpp — '+LLM_CATALOG[k].note+')',mb:LLM_CATALOG[k].mb,
      has:async()=>{ try{ return (await llmAppModels()).some(m=>m.name===sp.name); }catch(e){ return false; } },
      get:async()=>{ llmWatch(); await AppLink.call('model.get',{name:sp.name,url:sp.url},0); }});
  }
}
