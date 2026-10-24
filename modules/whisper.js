"use strict";
/* ============================ Whisper: речь → текст ============================
   Whisper (OpenAI, MIT) в ONNX-виде (onnx-community на huggingface.co) крутится прямо в браузере: Transformers.js + ONNX Runtime (wasm) в отдельном
   потоке (whisper-worker.js), так что граф не подвисает. Работает по-русски и ещё на ~100 языках; может переводить на английский.
   Поток режется на фразы по паузам (whisper-kernels.js), каждая фраза уходит в сеть. Живой звук отстаёт на длину фразы плюс время распознавания.
   Офлайн: библиотека (vendor/whisper/, ~15 МБ) и файлы модели (tiny ≈ 45 МБ, base ≈ 85 МБ, small ≈ 270 МБ в квантовании q8) один раз попадают в
   Files → Offline data, дальше сеть не нужна. Файлы модели узел просит через страницу: воркер сам в сеть не ходит.
   Логика (пересчёт в 16 кГц, нарезка, отсев «галлюцинаций») — whisper-kernels.js, тест tools/test-whisper.mjs. */

const WS_RT=[['Whisper runtime · transformers.min.js',['vendor/whisper/transformers.min.js','https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js'],'text/javascript'],
             ['Whisper runtime · ort-wasm-simd-threaded.mjs',['vendor/whisper/ort-wasm-simd-threaded.mjs','https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.mjs'],'text/javascript'],
             ['Whisper runtime · ort-wasm-simd-threaded.wasm',['vendor/whisper/ort-wasm-simd-threaded.wasm','https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.wasm'],'application/wasm']];
const WS_MB={tiny:45,base:85,small:270,'tiny.en':45,'base.en':85,'small.en':270};
const wsRepo=(id,custom)=>custom && custom.trim() ? custom.trim() : 'onnx-community/whisper-'+id;
const wsKey=repo=>'dsp-whisper-files:'+repo;

OfflineData.fileItem({id:'whisper-rt',label:'Whisper: runtime (Transformers.js + ONNX Runtime)',mb:15,files:WS_RT.map(f=>[f[0],f[1]])});
// модель: что именно запросил Transformers.js, запоминаем при загрузке — по этому списку и проверяем, что она скачана
OfflineData.item({id:'whisper-tiny',label:'Whisper: tiny model (speech to text, many languages)',mb:WS_MB.tiny,
  has:async()=>{ try{ const l=JSON.parse(LS.get(wsKey(wsRepo('tiny')))||'[]'); if(!l.length) return false; for(const f of l) if(!await OfflineData.has(f)) return false; return true; }catch(e){ return false; } },
  get:()=>wsLoad(wsRepo('tiny'))});

const WS={w:null, repo:'', ready:'', files:[], prog:'', loading:null, chain:Promise.resolve(), pend:new Map(), jid:0};
async function wsRuntimeUrls(){
  const u=[];
  for(const f of WS_RT){ const b=await OfflineData.blob(f[0],f[1]); u.push(URL.createObjectURL(new Blob([b],{type:f[2]}))); }
  return {lib:u[0],mjs:u[1],wasm:u[2]};
}
function wsWorker(){
  if(WS.w) return WS.w;
  const w=WS.w=new Worker('whisper-worker.js',{type:'module'});
  w.onmessage=async e=>{
    const m=e.data;
    if(m.t==='need'){                                   // файл модели: из Offline data, иначе скачать и сохранить
      const name=wsFileName(m.url);
      let blob=null;
      try{ if(name){ WS.prog='loading '+m.url.replace(/^.*\/resolve\/[^/]+\//,''); blob=await OfflineData.blob(name,[m.url]); if(!WS.files.includes(name)) WS.files.push(name); } }catch(err){}
      w.postMessage({t:'file',id:m.id,blob});
    }
    else if(m.t==='prog'){ WS.prog=m.file ? (m.progress>=0 && m.progress<100 ? m.file+' '+Math.round(m.progress)+'%' : '') : ''; }
    else if(m.t==='res' || m.t==='err'){ const p=WS.pend.get(m.jid); if(p){ WS.pend.delete(m.jid); m.t==='res' ? p.res(m) : p.rej(new Error(m.error)); } }
    else if(m.t==='ready'){ const p=WS.pend.get('load'); if(p){ WS.pend.delete('load'); p.res(m); } }
  };
  w.onerror=e=>{ const er=new Error('worker: '+(e.message||'failed to start')); for(const p of WS.pend.values()) p.rej(er); WS.pend.clear(); w.terminate(); WS.w=null; WS.ready=''; WS.loading=null; };
  return w;
}
// модель загружена в воркер (повторные вызовы с той же моделью — мгновенно)
function wsLoad(repo){
  if(WS.ready===repo) return Promise.resolve();
  if(WS.loading && WS.repo===repo) return WS.loading;
  WS.repo=repo; WS.files=[];
  return WS.loading=(async()=>{
    const w=wsWorker(), u=await wsRuntimeUrls();
    const m=await new Promise((res,rej)=>{ WS.pend.set('load',{res,rej}); w.postMessage({t:'load',model:repo,threads:Math.min(4,(navigator.hardwareConcurrency||4)>>1),...u}); });
    WS.ready=repo; WS.prog='';
    try{ LS.set(wsKey(repo),JSON.stringify(WS.files)); }catch(e){}
    return m;
  })().catch(e=>{ WS.ready=''; throw e; }).finally(()=>{ WS.loading=null; });
}
// распознать одну фразу (Float32Array 16 кГц); запуски идут по очереди — в воркере одна сеть
function wsRun(audio,o){
  const job=WS.chain.then(async()=>{
    await wsLoad(o.repo);
    const jid=++WS.jid, w=wsWorker();
    return new Promise((res,rej)=>{ WS.pend.set(jid,{res,rej}); w.postMessage({t:'run',jid,audio,model:o.repo,language:o.language,task:o.task,threads:2},[audio.buffer]); });
  });
  WS.chain=job.catch(()=>{});
  return job;
}

function wsDownload(text,name){
  const a=document.createElement('a'), u=URL.createObjectURL(new Blob([text],{type:'text/plain'}));
  a.href=u; a.download=name; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(u),10000);
}
function wsCfg(n){ const p=n.p; return {repo:wsRepo(p.model,p.custom), language:p.lang, task:p.task}; }
function wsSegCfg(n){ const p=n.p; return {thr:Math.pow(10,p.thr/20), pre:.35, hang:+p.pause, max:+p.maxlen, min:.4}; }

// фраза в очередь распознавания; sec — время её конца от начала потока или файла
function wsEnqueue(n,audio,sec){
  if(n.jobs.length>=6){ n.jobs.shift(); n.dropped++; }
  n.jobs.push({audio,sec:Math.max(0,sec-audio.length/16000)});
  wsPump(n);
}
function wsPump(n){
  if(n.busy || !n.jobs.length) return;
  const j=n.jobs.shift(), cfg=wsCfg(n), gen=n.gen; n.busy=true;
  wsRun(j.audio,cfg).then(r=>{
    if(gen!==n.gen) return;
    const text=r.text; n.ms=r.ms;
    if(!text || (n.p.junk && (wsJunk(text) || wsLoop(text)))){ n.skipped++; return; }
    const line=n.p.stamps ? wsStamp(j.sec)+' '+text : text;
    n.text=text; n.full=wsAppend(n.full,line,20000,'\n'); n.count++; n.go=true;
    n.q.push({t:Date.now(),src:'whisper',text,sec:+j.sec.toFixed(1),model:cfg.repo});
    n.rev++; redraw(n);
  }).catch(e=>{ if(gen!==n.gen) return; n.err=String(e.message||e); n.retryAt=performance.now()+8000; n.rev++; redraw(n); })
    .finally(()=>{ if(gen===n.gen){ n.busy=false; wsPump(n); } });
}
function wsStatus(n){
  const cfg=wsCfg(n);
  if(n.err) return 'error: '+n.err;
  if(WS.ready!==cfg.repo){
    if(WS.loading) return 'loading Whisper '+cfg.repo.replace(/^.*\//,'')+(WS.prog ? ' · '+WS.prog : '')+' (once — then kept in Files → Offline data)…';
    return 'model is not loaded yet'+(n.p.listen ? ' — loads when sound arrives' : '');
  }
  const bits=[cfg.repo.replace(/^.*\//,'')];
  if(n.fileInfo) bits.push(n.fileInfo);
  else if(n.seg?.speaking) bits.push('hearing speech');
  else bits.push('listening');
  if(n.busy || n.jobs.length) bits.push('recognising · queue '+(n.jobs.length+(n.busy ? 1 : 0)));
  else if(n.ms) bits.push(Math.round(n.ms)+' ms per phrase');
  if(n.dropped) bits.push('dropped '+n.dropped);
  return bits.join(' · ');
}

// файл целиком: декодируем, режем теми же настройками, но быстрее реального времени
async function wsFile(n,file){
  const gen=n.gen;
  try{
    n.err=''; n.fileInfo='decoding…'; n.rev++; redraw(n);
    const d=await decodeAudioFile(file), x=wsTo16k(d.samples,d.sr), seg=wsSegmenter(16000,{...wsSegCfg(n),max:Math.min(+n.p.maxlen,28)}), B=1600;
    const total=x.length/16000;
    wsLoad(wsCfg(n).repo).catch(()=>{});
    for(let i=0;i<x.length;i+=B){
      if(gen!==n.gen || n.fileStop) break;
      for(const s of seg.push(x.subarray(i,i+B))) wsEnqueue(n,s,(i+B)/16000);
      n.fileInfo='file '+Math.round(i/16000)+' / '+Math.round(total)+' s';
      while(n.jobs.length>=5 && gen===n.gen && !n.fileStop) await new Promise(r=>setTimeout(r,200));     // не обгоняем сеть: очередь не теряет фразы
      if(i%(B*50)===0) await new Promise(r=>setTimeout(r));
    }
    if(!n.fileStop) for(const s of seg.flush()) wsEnqueue(n,s,total);
    while((n.busy || n.jobs.length) && gen===n.gen && !n.fileStop) await new Promise(r=>setTimeout(r,200));
    if(gen===n.gen) n.fileInfo=n.fileStop ? 'file stopped' : 'file done · '+file.name;
  }catch(e){ if(gen===n.gen){ n.err='file: '+(e.message||e); n.fileInfo=''; } }
  finally{ if(gen===n.gen){ n.fileRun=false; n.rev++; redraw(n); } }
}
function wsPickFile(n){
  if(n.fileRun){ n.fileStop=true; return; }
  const i=document.createElement('input'); i.type='file'; i.accept='audio/*,video/*';
  i.onchange=()=>{ const f=i.files[0]; if(!f) return; n.fileRun=true; n.fileStop=false; wsFile(n,f); };
  i.click();
}

def({ id:'whisper', lazy:'manual', title:'Speech to Text (Whisper, neural)', cat:'Analysis', readout:true, tall:true, w:300, resize:true,
  kw:'whisper speech to text recognition stt transcribe transcription subtitles voice neural network ai openai russian english translate offline radio',
  // in — звук; text — последняя фраза, full — вся стенограмма, go — импульс на новую фразу, rec — событие, busy — фраз в работе
  ins:[{n:'in',t:'sig'}],
  outs:[{n:'text',t:'txt'},{n:'full',t:'txt'},{n:'go',t:'num'},{n:'rec',t:'rec'},{n:'count',t:'num'},{n:'busy',t:'num'}],
  params:[{n:'model',t:'select',opts:['tiny','base','small','tiny.en','base.en','small.en'],d:'base',label:'model (tiny ≈45 MB fast, base ≈85, small ≈270 more exact; .en — English only)'},
          {n:'lang',t:'select',opts:['auto','en','ru','uk','de','fr','es','it','pt','nl','pl','cs','tr','ar','zh','ja','ko'],d:'auto',label:'language (auto — detect each phrase; a fixed one is more reliable on radio)'},
          {n:'task',t:'select',opts:['transcribe','translate'],d:'transcribe',label:'transcribe, or translate to English'},
          {n:'listen',t:'check',d:true,label:'listen to the input'},
          {n:'thr',t:'range',min:-60,max:-15,step:1,d:-42,label:'speech threshold, dBFS (the node also follows the noise level)'},
          {n:'pause',t:'range',min:.3,max:2.5,step:.05,d:.7,label:'pause that ends a phrase, s'},
          {n:'maxlen',t:'range',min:5,max:28,step:1,d:20,label:'longest phrase, s'},
          {n:'junk',t:'check',d:true,label:'drop typical Whisper inventions on silence ("Thank you.", [BLANK_AUDIO], loops)'},
          {n:'stamps',t:'check',d:false,label:'time stamps [m:ss] in the transcript'},
          {n:'file',t:'button',label:'Transcribe file… / stop',fn:n=>wsPickFile(n)},
          {n:'clear',t:'button',label:'Clear',fn:n=>{ n.full=''; n.text=''; n.count=0; n.skipped=0; n.dropped=0; n.rev++; redraw(n); }},
          {n:'save',t:'button',label:'Save text',fn:n=>{ if(n.full) wsDownload(n.full,'whisper-'+Date.now()+'.txt'); }},
          {n:'custom',t:'text',d:'',label:'own model repo on huggingface.co (ONNX for Transformers.js), e.g. onnx-community/whisper-large-v3-turbo; empty — by «model»',adv:true}],
  init(n){ n.seg=null; n.segKey=''; n.sr=0; n.clock=0; n.jobs=[]; n.busy=false; n.gen=0; n.q=[]; n.text=''; n.full=''; n.count=0; n.go=false;
           n.err=''; n.ms=0; n.skipped=0; n.dropped=0; n.rev=0; n.retryAt=0; n.fileRun=false; n.fileStop=false; n.fileInfo=''; n.pre=false; n.stat=''; },
  dispose(n){ n.gen++; n.jobs=[]; n.seg=null; },
  process(n,I){
    const x=I.in, sr=Eng.sr;
    if(x && n.p.listen && !n.fileRun){
      const key=[sr,n.p.thr,n.p.pause,n.p.maxlen].join('|');
      if(!n.seg || n.segKey!==key){ n.seg=wsSegmenter(sr,wsSegCfg(n)); n.segKey=key; }
      n.clock+=x.length/sr;
      if(!n.pre && performance.now()>=n.retryAt){ n.pre=true; wsLoad(wsCfg(n).repo).catch(e=>{ n.pre=false; n.err=String(e.message||e); n.retryAt=performance.now()+8000; n.rev++; redraw(n); }); }
      for(const s of n.seg.push(x)) wsEnqueue(n,wsTo16k(s,sr),n.clock);
    }
    if(n.err && performance.now()>=n.retryAt && n.retryAt){ n.err=''; n.retryAt=0; n.pre=false; }
    const st=wsStatus(n); if(st!==n.stat){ n.stat=st; redraw(n); }
    const rec=n.q.length ? n.q.splice(0) : null, go=n.go ? 1 : 0; n.go=false;
    return {text:n.text, full:n.full, go, rec, count:n.count, busy:n.jobs.length+(n.busy ? 1 : 0)}; },
  drawKey:n=>n.stat+'|'+n.rev,
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    r.textContent=n.stat+(n.skipped ? ' · skipped '+n.skipped : '')+(n.full ? '\n\n'+n.full.slice(-1200) : ''); }});
