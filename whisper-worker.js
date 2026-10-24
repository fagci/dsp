/* Whisper в отдельном потоке: Transformers.js + ONNX Runtime (wasm). Библиотека, wasm и файлы модели приходят от страницы (modules/whisper.js):
   всё лежит в Files → Offline data, поэтому сеть воркеру не нужна. Вместо кэша браузера у Transformers.js подставлен env.customCache —
   на каждый файл huggingface.co он спрашивает страницу ({t:'need'}) и получает Blob обратно ({t:'file'}). */
let T=null, asr=null, curModel='', seq=0;
const wait=new Map();
const cache={
  async match(req){
    const url=typeof req==='string' ? req : req.url;
    if(!/^https:\/\/huggingface\.co\/.+\/resolve\//.test(url)) return undefined;
    const id=++seq;
    const b=await new Promise(res=>{ wait.set(id,res); postMessage({t:'need',id,url}); });
    return b ? new Response(b,{status:200,headers:{'content-length':String(b.size)}}) : undefined;     // нет файла — пусть Transformers.js сам решит, обязателен ли он
  },
  async put(){}                                       // страница уже сохранила файл в Offline data
};
async function boot(m){
  if(T) return;
  T=await import(m.lib);
  const env=T.env;
  env.allowLocalModels=false; env.useBrowserCache=false; env.useCustomCache=true; env.customCache=cache;
  const w=env.backends.onnx.wasm;
  w.wasmPaths={mjs:m.mjs,wasm:m.wasm};
  w.numThreads=self.crossOriginIsolated ? Math.max(1,Math.min(4,m.threads|0||2)) : 1;
}
async function load(m){
  await boot(m);
  if(asr && curModel===m.model) return;
  if(asr){ try{ await asr.dispose(); }catch(e){} asr=null; curModel=''; }
  asr=await T.pipeline('automatic-speech-recognition',m.model,{device:'wasm',dtype:'q8',
    progress_callback:p=>{ if(p.status==='progress' || p.status==='download' || p.status==='done') postMessage({t:'prog',file:p.file,progress:p.progress}); }});
  curModel=m.model;
}
onmessage=async e=>{
  const m=e.data;
  if(m.t==='file'){ const r=wait.get(m.id); wait.delete(m.id); if(r) r(m.blob); return; }
  try{
    if(m.t==='load'){ await load(m); postMessage({t:'ready',model:m.model}); }
    else if(m.t==='run'){
      await load(m);
      const o={chunk_length_s:30,return_timestamps:false};
      if(!/\.en$/.test(m.model)){ if(m.language && m.language!=='auto') o.language=m.language; o.task=m.task==='translate' ? 'translate' : 'transcribe'; }   // у .en-моделей языка и задачи нет
      const t0=performance.now(), r=await asr(m.audio,o);
      postMessage({t:'res',jid:m.jid,text:String(Array.isArray(r) ? r.map(x=>x.text).join(' ') : r.text||'').trim(),ms:performance.now()-t0});
    }
  }catch(err){ postMessage({t:'err',jid:m.t==='load' ? 'load' : m.jid,error:String(err&&err.message||err)}); }
};
