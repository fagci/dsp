"use strict";
/* ============================ Sound Classifier (YAMNet) ============================
   Нейросеть YAMNet (Google, Apache-2.0) определяет, что за звук: речь, музыка, сирена, мотор, лай, звонок… — 521 класс AudioSet.
   Запускается через MediaPipe Tasks Audio (wasm) прямо в браузере. Файлы (~11 МБ: vendor/mediapipe/, запасной путь — jsDelivr и
   storage.googleapis.com) один раз попадают в Files → Offline data, дальше работает без сети. Окно ~1 с, как в модели.
   Логика (кольцо звука, разбор результата, слежение за классами) — yamnet-kernels.js, тест tools/test-yamnet.mjs. */

const YN_MP='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@1.1.1/';
const YN_FILES=[['MediaPipe audio 1.1.1 (audio_bundle.mjs)','vendor/mediapipe/audio_bundle.mjs',YN_MP+'audio_bundle.mjs'],
                ['MediaPipe audio 1.1.1 (audio_wasm_internal.js)','vendor/mediapipe/audio_wasm_internal.js',YN_MP+'wasm/audio_wasm_internal.js'],
                ['MediaPipe audio 1.1.1 (audio_wasm_internal.wasm)','vendor/mediapipe/audio_wasm_internal.wasm',YN_MP+'wasm/audio_wasm_internal.wasm'],
                ['YAMNet (yamnet.tflite)','vendor/mediapipe/yamnet.tflite','https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite']];
OfflineData.fileItem({id:'yamnet',label:'Sound Classifier: YAMNet and MediaPipe',mb:11,files:YN_FILES.map(f=>[f[0],[f[1],f[2]]])});

const YN={p:null, cls:null, err:''};
function ynLoad(){
  if(YN.p) return YN.p;
  return YN.p=(async()=>{
    const b=[]; for(const f of YN_FILES) b.push(await OfflineData.blob(f[0],[f[1],f[2]]));
    const url=(blob,type)=>URL.createObjectURL(new Blob([blob],{type}));        // тип — JS: модульные скрипты проверяют MIME
    const mp=await import(url(b[0],'text/javascript'));
    const fileset={wasmLoaderPath:url(b[1],'text/javascript'), wasmBinaryPath:url(b[2],'application/wasm')};
    YN.cls=await mp.AudioClassifier.createFromOptions(fileset,{baseOptions:{modelAssetBuffer:new Uint8Array(await b[3].arrayBuffer())},maxResults:-1});
  })().catch(e=>{ YN.err=String(e.message||e); YN.p=null; });
}

def({ id:'yamnet', title:'Sound Classifier (YAMNet, neural)', cat:'Analysis', readout:true, tall:true, w:260, resize:true,
  kw:'sound classification classifier yamnet audioset speech music siren dog alarm event detect neural network ai tagging',
  // in — звук; text — список классов, label — главный класс, score — его доля; hit — 1, пока слышен класс из watch; rec — событие при появлении
  ins:[{n:'in',t:'sig'}],
  outs:[{n:'text',t:'txt'},{n:'label',t:'txt'},{n:'score',t:'num'},{n:'hit',t:'num'},{n:'rec',t:'rec'}],
  params:[{n:'period',t:'range',min:.25,max:5,step:.05,d:1,label:'classify every, s'},
          {n:'top',t:'range',min:1,max:10,step:1,d:5,label:'classes to show'},
          {n:'min',t:'range',min:.05,max:.9,step:.01,d:.15,label:'min share'},
          {n:'watch',t:'text',d:'',label:'watch for (e.g. speech, siren, dog; empty — off)'},
          {n:'wthr',t:'range',min:.1,max:.95,step:.01,d:.4,label:'watch threshold'}],
  init(n){ n.ring=null; n.rsr=0; n.t=0; n.list=[]; n.text=''; n.label=''; n.hit=0; n.q=[]; n.seen=''; n.status='loading YAMNet…'; n.ms=0; },
  process(n,I){
    const sr=Eng.sr;
    if(!n.ring || n.rsr!==sr){ n.ring=ynRing(Math.round(sr*0.975)); n.rsr=sr; }     // окно модели — 0.975 с
    n.ring.push(I.in||buf(n,'z'));
    if(!YN.cls){ ynLoad(); n.status=YN.err ? 'error: '+YN.err : 'loading YAMNet (about 11 MB, once — then kept in Files → Offline data)…'; }
    else{
      n.t+=BLOCK/sr;
      if(n.t>=n.p.period && n.ring.filled>=n.ring.N){
        n.t=0;
        try{
          const t0=performance.now();
          n.list=ynTop(YN.cls.classify(ynTo16k(n.ring.get()),16000),n.p.top,n.p.min); n.ms=performance.now()-t0;
          n.text=ynText(n.list); n.label=n.list[0]?.label||'';
          const w=ynWatch(n.list,ynClasses(n.p.watch),n.p.wthr);
          n.hit=w ? 1 : 0;
          if(w && w.label!==n.seen) n.q.push({t:Date.now(),src:'yamnet',label:w.label,score:+w.score.toFixed(3)});
          n.seen=w ? w.label : '';
          n.status=n.text+'\n· '+n.ms.toFixed(0)+' ms'; n.rev=(n.rev|0)+1;
        }catch(e){ n.status='error: '+(e.message||e); }
      }
    }
    const rec=n.q.length ? n.q.splice(0) : null;
    return {text:n.text, label:n.label, score:n.list[0]?.score||0, hit:n.hit, rec}; },
  dispose(n){ n.ring=null; },
  drawKey:n=>n.status,
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.status; }});
