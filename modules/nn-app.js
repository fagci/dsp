"use strict";
/* ============================ Нейросети на телефоне (приложение Android, TFLite + GPU-делегат) ============================
   Notes (Basic Pitch) и Sound Classifier (YAMNet) могут считать не в браузере (TF.js / MediaPipe на CPU), а в приложении: модель TFLite float32
   грузится командой nn.load — на GPU (OpenGL ES / OpenCL, это почти любой телефон, не только Adreno), иначе на CPU с XNNPACK (dotprod);
   окно звука уходит командой nn.run (тензоры float32 в base64), назад — выходы сети. Подготовка звука и разбор выходов остались на странице.
   Сторона телефона — AiHub.kt / AiCore.kt (NnCore) / TfliteEngine.kt; проверка — tools/test-nnapp.mjs. */

// модель: файл на телефоне и откуда его взять — из самого приложения (asset, без сети) или по адресу (один раз)
const NN_BP={name:'nmp.tflite',asset:'vendor/basicpitch/nmp.tflite'};                                      // Basic Pitch, 204 КБ, лежит в репозитории
const NN_YN={name:'yamnet.tflite',url:'https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite'};   // YAMNet, 4 МБ
const NN={ready:{},loading:{},info:{},prog:{},unsupported:false};

function nnB64(f){
  const u=new Uint8Array(f.buffer,f.byteOffset,f.byteLength); let o='';
  for(let i=0;i<u.length;i+=0x8000) o+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));
  return btoa(o);
}
function nnFromB64(s){
  const b=atob(s), u=new Uint8Array(b.length);
  for(let i=0;i<b.length;i++) u[i]=b.charCodeAt(i);
  return new Float32Array(u.buffer);
}
// модель на телефоне и в памяти движка; повторные вызовы с теми же настройками — мгновенно
function nnEnsure(spec,gpu){
  const key=spec.name+'|'+(gpu ? 'gpu' : 'cpu');
  if(NN.ready[spec.name]===key) return Promise.resolve(NN.info[spec.name]);
  if(NN.loading[spec.name] && NN.loading[spec.name].key===key) return NN.loading[spec.name].p;
  const p=(async()=>{
    NN.prog[spec.name]='asking the phone…';
    const l=await AppLink.call('model.list',{},10000);
    if(!l.models.some(m=>m.name===spec.name && !m.partial)){
      NN.prog[spec.name]=spec.asset ? 'copying '+spec.name+' from the app…' : 'downloading '+spec.name+'…';
      await AppLink.call('model.get',spec.asset ? {name:spec.name,asset:spec.asset} : {name:spec.name,url:spec.url},0);
    }
    NN.prog[spec.name]='loading '+spec.name+'…';
    const r=await AppLink.call('nn.load',{model:spec.name,gpu:!!gpu},120000);
    NN.ready[spec.name]=key; NN.info[spec.name]=r; NN.prog[spec.name]='';
    return r;
  })().catch(e=>{ NN.ready[spec.name]=''; NN.prog[spec.name]=''; throw e; }).finally(()=>{ delete NN.loading[spec.name]; });
  NN.loading[spec.name]={key,p};
  return p;
}
// запуск: массивы Float32Array → [{name, shape, data: Float32Array}] в порядке выходов модели
async function nnRun(name,inputs){
  const r=await AppLink.call('nn.run',{model:name,inputs:inputs.map(nnB64)},60000);
  return r.outputs.map(o=>({name:o.name,shape:o.shape,data:nnFromB64(o.data)}));
}
const nnReady=(spec,gpu)=>NN.ready[spec.name]===spec.name+'|'+(gpu ? 'gpu' : 'cpu');
// «GPU (TFLite) · 3 ms»: на чём реально считает сеть и что сказал делегат
const nnWhere=spec=>{ const i=NN.info[spec.name]; return i ? (i.delegate==='gpu' ? 'GPU' : 'CPU')+' (TFLite)'+(i.note ? ' · '+i.note : '') : ''; };
// пункт «⇩ offline» в Files: YAMNet на телефоне (Basic Pitch лежит в самом приложении)
if(typeof OfflineData!=='undefined' && typeof AppLink!=='undefined' && AppLink.ok){
  OfflineData.item({id:'nn-app-yamnet',label:'Sound Classifier on the phone: YAMNet (DSP app, TFLite on the GPU)',mb:4,
    has:async()=>{ try{ return (await AppLink.call('model.list',{},10000)).models.some(m=>m.name===NN_YN.name && !m.partial); }catch(e){ return false; } },
    get:()=>AppLink.call('model.get',{name:NN_YN.name,url:NN_YN.url},0)});
}
