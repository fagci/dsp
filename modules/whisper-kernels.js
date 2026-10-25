"use strict";
/* ============================ Whisper: распознавание речи — чистая логика ============================
   Сама нейросеть (Transformers.js + ONNX Runtime) живёт в whisper-worker.js, обвязка узла — в whisper.js.
   Здесь: пересчёт в 16 кГц, нарезка потока на фразы по паузам, отсев «галлюцинаций» на тишине, склейка текста. Тест tools/test-whisper.mjs. */

// любой кусок на частоте sr → 16 кГц (усреднение по ячейкам = фильтр от наложения при понижении частоты)
function wsTo16k(x,sr){
  const L=x.length, n=Math.floor(L*16000/sr);
  if(sr===16000) return Float32Array.from(x);
  const r=sr/16000, ps=new Float64Array(L+1);
  for(let i=0;i<L;i++) ps[i+1]=ps[i]+x[i];
  const at=t=>{ const i=Math.min(L,Math.floor(t)), f=t-i; return ps[i]+(i<L ? x[i]*f : 0); };
  const o=new Float32Array(n);
  if(r<1){ for(let j=0;j<n;j++){ const t=j*r, i=Math.floor(t), f=t-i; o[j]=x[i]+((x[i+1]!==undefined ? x[i+1] : x[i])-x[i])*f; } return o; }
  for(let j=0;j<n;j++) o[j]=(at((j+1)*r)-at(j*r))/r;
  return o;
}

/* Нарезка потока на фразы. Блок считается речью, если его среднеквадратичное выше порога: max(thr, 3 × шумовая полка, но не больше 8 × thr).
   Шумовая полка — самый тихий полусекундный отрезок за последние 8 с: ровный шум её поднимает и речью не считается. Фраза начинается с запасом pre секунд до первой речи, кончается через
   hang секунд тишины или при длине max (Whisper принимает до 30 с). Короче min секунд — выбрасывается (щелчок).
   push(блок) → массив готовых фраз (Float32Array на sr узла); flush() — досрочно закончить текущую. */
function wsSegmenter(sr,o){
  const thr=o.thr, pre=Math.round(sr*o.pre), hang=o.hang, max=o.max, min=o.min;
  let floor=0, bk=[], bmin=Infinity, bt=0, speech=false, quiet=0, len=0, parts=[], ring=[], ringN=0, t=0;
  const cat=ps=>{ let n=0; for(const p of ps) n+=p.length; const r=new Float32Array(n); let k=0; for(const p of ps){ r.set(p,k); k+=p.length; } return r; };
  const out=[];
  function end(){
    if(speech && len/sr-quiet>=min) out.push(cat(parts));
    speech=false; quiet=0; len=0; parts=[];
  }
  return {
    get speaking(){ return speech; },
    get floor(){ return floor; },
    push(x){
      out.length=0;
      let s=0; for(let i=0;i<x.length;i++) s+=x[i]*x[i];
      const rms=Math.sqrt(s/Math.max(1,x.length)), dt=x.length/sr; t+=dt;
      bmin=Math.min(bmin,rms); bt+=dt;
      if(bt>=.5){ bk.push(bmin); if(bk.length>16) bk.shift(); bmin=Infinity; bt=0; }
      floor=bk.length ? Math.min(bmin,...bk) : 0;
      const loud=rms>Math.max(thr,Math.min(floor*3,thr*8));
      if(!speech){
        ring.push(x); ringN+=x.length;
        while(ringN-ring[0].length>=pre && ring.length>1){ ringN-=ring[0].length; ring.shift(); }
        if(loud){ speech=true; parts=ring; len=ringN; quiet=0; ring=[]; ringN=0; }
      }else{
        parts.push(x); len+=x.length;
        if(loud) quiet=0; else quiet+=dt;
        if(quiet>=hang || len/sr>=max) end();
      }
      return out.slice();
    },
    flush(){ out.length=0; end(); return out.slice(); },
    reset(){ speech=false; quiet=0; len=0; parts=[]; ring=[]; ringN=0; }
  };
}

// Whisper на тишине и шуме «сочиняет» привычные концовки роликов и пустые теги — их выбрасываем
const WS_JUNK=['thank you','thank you.','thanks for watching','thanks for watching!','thank you for watching','thank you for watching.','subtitles by','bye','bye.','you',
  'продолжение следует','субтитры сделал dimatorzok','субтитры создавал dimatorzok','редактор субтитров','корректор','спасибо за просмотр','спасибо за внимание'];
function wsJunk(text){
  const t=String(text||'').trim().toLowerCase();
  if(!t) return true;
  if(/^[\s.,!?…\-–—♪♫*\[\]()]*$/.test(t)) return true;                         // только знаки
  if(/^[\[(][^\])]*(blank|silence|music|noise|applause|тишин|музык|шум|аплодис)[^\])]*[\])]$/.test(t)) return true;   // [BLANK_AUDIO], (music)
  return WS_JUNK.includes(t.replace(/[.!]+$/,'')) || WS_JUNK.includes(t);
}
// фразы подряд не склеиваем повторами: Whisper иногда зацикливается на одной и той же строке
function wsLoop(text){
  const w=String(text||'').trim().split(/\s+/);
  if(w.length<12) return false;
  const u=new Set(w.map(x=>x.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'')));
  return u.size<=Math.max(2,w.length/6);
}
// «слово слово слово слово…» (или короткая фраза, повторённая ≥4 раза подряд) — зацикливание декодера: оставляем одно вхождение
function wsDeloop(text){
  let t=String(text||'');
  for(let k=1;k<=4;k++) t=t.replace(new RegExp('(^|\\s)((?:\\S+\\s+){'+(k-1)+'}\\S+?[.,!?…]*)(?:\\s+\\2){3,}(?=\\s|$)','giu'),'$1$2');
  return t.trim();
}
function wsAppend(full,text,cap,sep){
  const s=full ? full+(sep||' ')+text : text;
  return s.length>cap ? s.slice(s.length-cap).replace(/^\S*\s/,'') : s;
}
// имя файла модели в Files → Offline data: по адресу huggingface.co/<репо>/resolve/<ветка>/<путь>
function wsFileName(url){
  const m=/^https:\/\/huggingface\.co\/(.+?)\/resolve\/[^/]+\/(.+?)(?:\?.*)?$/.exec(url);
  return m ? 'Whisper · '+m[1]+' · '+m[2] : null;
}
// стенограмма с временем: "[0:03] текст"
function wsStamp(sec){ sec=Math.max(0,Math.round(sec)); return '['+Math.floor(sec/60)+':'+String(sec%60).padStart(2,'0')+']'; }

// файлы модели для ручной загрузки: ссылки открываются в новой вкладке, скачанное выбирается кнопкой «выбрать файлы»
const WS_FILES=['config.json','generation_config.json','preprocessor_config.json','tokenizer.json','tokenizer_config.json',
                'onnx/encoder_model_quantized.onnx','onnx/decoder_model_merged_quantized.onnx'];
const wsFileUrl=(repo,path)=>'https://huggingface.co/'+repo+'/resolve/main/'+path;
// имя скачанного файла → имя в Offline data: у браузера пропадает папка, а .onnx лежат в onnx/
function wsManualName(repo,fname){
  const f=String(fname||'').replace(/^.*[\\/]/,'').replace(/ \(\d+\)(?=\.[^.]*$)/,'');     // «tokenizer (1).json» → tokenizer.json
  return 'Whisper · '+repo+' · '+(/\.onnx(_data.*)?$/.test(f) ? 'onnx/' : '')+f;
}
