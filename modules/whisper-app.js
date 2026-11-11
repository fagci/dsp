"use strict";
/* ============================ Whisper на телефоне (приложение Android, whisper.cpp) ============================
   Движок узла Speech to Text, когда страница открыта в приложении: звук фразы уходит по мосту (asr.run, 16 кГц / 16 бит, base64), распознаёт
   whisper.cpp в процессе приложения — на CPU с dotprod, а где есть OpenCL (Adreno) — с GPU. Модели ggml лежат в каталоге приложения
   (model.get качает и докачивает), браузерный ONNX-Whisper при этом не нужен. Большие модели (large-v3-turbo, medium) знают русский намного
   лучше tiny / base из браузера. Сторона телефона — AiHub.kt / AiCore.kt / native/whisper_jni.cpp; проверка — tools/test-whisperapp.mjs. */

// ggml-модели whisper.cpp (huggingface.co/ggerganov/whisper.cpp): размер в МБ и пометка по русскому
const WAP_MODELS={
  'large-v3-turbo-q5_0':{mb:574,note:'best Russian, heaviest'},
  'large-v3-turbo-q8_0':{mb:874,note:'turbo, more exact quantization'},
  'medium-q5_0':{mb:539,note:'good Russian, lighter than turbo'},
  'small-q5_1':{mb:181,note:'fast, Russian is so-so'},
  'base-q5_1':{mb:60,note:'very fast, weak'},
  'tiny-q5_1':{mb:32,note:'only to try'}};
const wapFile=m=>'ggml-'+m+'.bin';
const wapUrl=m=>'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'+wapFile(m);
// своя модель: адрес .bin → имя файла на телефоне (только безопасные символы, расширение .bin)
function wapCustom(url){
  const t=String(url||'').trim(); if(!/^https?:\/\/\S+$/i.test(t)) return null;
  let seg=''; try{ seg=decodeURIComponent(new URL(t).pathname.split('/').pop()||''); }catch(e){}
  seg=seg.replace(/[^A-Za-z0-9._-]/g,'_').replace(/^[._-]+/,'');
  if(!/\.bin$/i.test(seg)) seg=(seg||'model')+'.bin';
  return {name:seg.slice(0,100),url:t};
}
// Float32 [-1, 1] → s16le → base64
function wapB64(f){
  const n=f.length, u=new Uint8Array(n*2);
  for(let i=0;i<n;i++){ const v=Math.max(-1,Math.min(1,f[i])), s=v<0 ? Math.round(v*32768) : Math.round(v*32767); u[2*i]=s&255; u[2*i+1]=(s>>8)&255; }
  let o=''; for(let i=0;i<u.length;i+=0x8000) o+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));
  return btoa(o);
}
const wapMb=b=>Math.round(b/1048576);
// что умеет телефон — одной строкой для строки состояния
function wapCapsLine(c){
  if(!c) return '';
  const b=[]; if(c.soc) b.push(c.soc);
  b.push('dotprod '+(c.dotprod ? '✓' : '✗')+(c.i8mm ? ' i8mm ✓' : ''));
  b.push(c.opencl ? 'OpenCL ✓' : 'no OpenCL (CPU)');
  b.push(wapMb(c.availMb*1048576)+' / '+c.ramMb+' MB free');
  return b.join(' · ');
}

const WAP={gpuOn:false, why:'', unsupported:false, caps:null, ready:'', key:'', loading:null, prog:'', info:'', chain:Promise.resolve(), off:null, dl:new Map()};
function wapCaps(){
  if(WAP.caps) return Promise.resolve(WAP.caps);
  return AppLink.call('ai.caps',{},10000).then(c=>{ WAP.caps=c; return c; });
}
// прогресс загрузки модели на телефон приходит записями {src:'ai', ev:'progress', name, done, total}
function wapWatch(){
  if(WAP.off || !AppLink.ok) return;
  WAP.off=AppLink.on(r=>{
    if(r.src!=='ai' || r.ev!=='progress') return;
    const p=r.total>0 ? Math.round(100*r.done/r.total)+'% · '+wapMb(r.done)+' / '+wapMb(r.total)+' MB' : wapMb(r.done)+' MB';
    WAP.dl.set(r.name,p); WAP.prog='downloading '+r.name.replace(/^ggml-|\.bin$/g,'')+' · '+p;
  });
}
async function wapHas(name){
  try{ const l=await AppLink.call('model.list',{},10000); return l.models.some(m=>m.name===name && !m.partial); }catch(e){ return false; }
}
// модель на телефон (докачка сама); name — файл на телефоне, url — откуда
async function wapGet(name,url){
  wapWatch();
  if(await wapHas(name)) return;
  WAP.prog='downloading '+name+'…';
  try{ await AppLink.call('model.get',{name,url},0); }
  finally{ WAP.prog=''; WAP.dl.delete(name); }
}
// модель на телефоне и в памяти движка; повторные вызовы с теми же настройками — мгновенно
function wapLoad(a){
  const key=a.name+'|'+(a.gpu ? 'gpu' : 'cpu');
  if(WAP.ready===key) return Promise.resolve();
  if(WAP.loading && WAP.key===key) return WAP.loading;
  const prev=WAP.loading; WAP.key=key;
  const p=WAP.loading=(async()=>{
    if(prev) await prev.catch(()=>{});                      // другая модель ещё грузится — ждём её: на телефоне загрузки идут по очереди
    if(WAP.ready===key) return;
    WAP.prog='asking the phone…';
    const c=await wapCaps();
    if(!c.dotprod || !c.fp16 || !c.arm64){ WAP.unsupported=true; throw new Error('this phone cannot run the native engine (arm64 with dotprod and fp16 needed) — pick the browser engine'); }
    await wapGet(a.name,a.url);
    WAP.prog='loading '+a.name+' into memory…';
    const r=await AppLink.call('asr.load',{model:a.name,gpu:!!a.gpu},300000);
    WAP.gpuOn=!!r.gpu;
    WAP.why=a.gpu && !r.gpu ? (!c.opencl ? 'no OpenCL library on this phone' : 'OpenCL is there, but ggml-opencl found no supported GPU — Adreno 7xx / 8xx needed') : '';     // почему просили GPU, а считает CPU
    WAP.ready=key; WAP.info=(r.gpu ? 'GPU (OpenCL)' : 'CPU'+(WAP.why ? ' ('+WAP.why+')' : ''))+(r.ms ? ' · loaded in '+(r.ms/1000).toFixed(1)+' s' : ''); WAP.prog='';
    return r;
  })().catch(e=>{ if(WAP.key===key){ WAP.ready=''; WAP.prog=''; } throw e; }).finally(()=>{ if(WAP.loading===p) WAP.loading=null; });
  return p;
}
// короткое окно энкодера (audio_ctx по длине фразы): стоимость растёт с длиной звука, а не с окном в 30 с — на CPU это разница между «успевает» и «нет».
// fastMode: auto — включено, когда GPU не подключён (на GPU окно полное — точнее), on / off — как сказано; a.fast === true — принудительно (черновики)
const wapFastOn=a=>a.fast===true || a.fastMode==='on' || (a.fastMode!=='off' && !WAP.gpuOn);
// одна фраза (Float32Array 16 кГц) → {text, ms, audioMs}; запуски идут по очереди
function wapRun(audio,o){
  const job=WAP.chain.then(async()=>{
    await wapLoad(o.app);
    const r=await AppLink.call('asr.run',{pcm:wapB64(audio),lang:o.language||'auto',translate:o.task==='translate',prompt:o.app.prompt||'',beam:o.app.beam||1,
      fast:wapFastOn(o.app),suppressNst:true,temperature:0},600000);
    return {text:String(r.text||'').trim(),ms:r.ms,audioMs:r.audioMs};
  });
  WAP.chain=job.catch(()=>{});
  return job;
}
// прервать идущее распознавание (устаревший черновик): ответ придёт ошибкой «stopped», которую вызывающий отбрасывает
function wapAbort(){ return AppLink.call('asr.stop',{},5000).catch(()=>{}); }
// пункты «⇩ offline» в Files: модели на телефоне (внутри приложения; в браузерное хранилище не попадают)
if(typeof OfflineData!=='undefined' && typeof AppLink!=='undefined' && AppLink.ok){
  for(const m of ['large-v3-turbo-q5_0','medium-q5_0','small-q5_1'])
    OfflineData.item({id:'whisper-app-'+m,label:'Whisper on the phone: '+m+' (DSP app, whisper.cpp — '+WAP_MODELS[m].note+')',mb:WAP_MODELS[m].mb,
      has:()=>wapHas(wapFile(m)),get:()=>wapGet(wapFile(m),wapUrl(m))});
}
