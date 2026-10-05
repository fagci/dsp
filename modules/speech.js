"use strict";
/* ============================ Speech to Text ============================
   Распознавание речи браузером (Web Speech API, Chrome / Edge / Safari; в Chrome звук уходит на сервер распознавания).
   Слушает микрофон по умолчанию — не сигнал графа. Запускается только по клику (Listen). */

function spStop(n){
  n.want=false; clearTimeout(n.timer); n.timer=null;
  const r=n.rec; n.rec=null;
  if(r){ r.onresult=r.onerror=r.onend=null; try{ r.abort(); }catch(e){} }
  n.status='stopped'; n.interim='';
}
function spStart(n){
  spStop(n);
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){ n.status='SpeechRecognition is not supported by this browser'; return; }
  const r=new SR(); n.rec=r; n.want=true;
  r.lang=String(n.p.lang||'').trim()||navigator.language||'en-US';
  r.continuous=true; r.interimResults=!!n.p.interim; r.maxAlternatives=1;
  r.onstart=()=>{ n.status='listening ('+r.lang+')'; };
  r.onresult=e=>{
    let interim='';
    for(let i=e.resultIndex;i<e.results.length;i++){
      const a=e.results[i][0], t=a.transcript.trim();
      if(e.results[i].isFinal){ if(t) n.q.push({t:Date.now(), src:'speech', text:t, conf:+a.confidence.toFixed(2), lang:r.lang}); }
      else interim+=t+' ';
    }
    n.interim=interim.trim();
  };
  r.onerror=e=>{
    if(e.error==='no-speech' || e.error==='aborted') return;
    n.status='error: '+e.error+(e.error==='not-allowed' || e.error==='service-not-allowed' ? ' (microphone or recognition service blocked)' : '');
    if(e.error==='not-allowed' || e.error==='service-not-allowed' || e.error==='language-not-supported') n.want=false;
  };
  r.onend=()=>{                                       // браузер сам обрывает сессию через время — перезапуск
    if(n.rec!==r) return;
    if(n.want && n.p.restart){ clearTimeout(n.timer); n.timer=setTimeout(()=>{ if(n.want && n.rec===r){ try{ r.start(); }catch(e){} } },300); }
    else { n.rec=null; n.want=false; n.status='stopped'; }
  };
  try{ r.start(); n.status='starting…'; }catch(e){ n.status='error: '+e.message; n.rec=null; n.want=false; }
}
def({ id:'speech', lazy:'proc', title:'Speech to Text', cat:'Sources', kw:'speech recognition voice dictation stt microphone words',
  outs:[{n:'text',t:'txt'},{n:'go',t:'num'},{n:'rec',t:'rec'},{n:'count',t:'num'}],
  readout:true, tall:true,
  params:[
    {n:'lang',t:'text',d:'',label:'language (en-US, ru-RU…; empty — browser language)'},
    {n:'interim',t:'check',d:true,label:'show interim text'},
    {n:'restart',t:'check',d:true,label:'restart when the browser stops'},
    {n:'listen',t:'button',label:'Listen',fn:n=>spStart(n)},
    {n:'stop',t:'button',label:'Stop',fn:n=>spStop(n)},
  ],
  init:n=>{ n.rec=null; n.want=false; n.timer=null; n.q=[]; n.text=''; n.interim=''; n.count=0;
            n.status=(window.SpeechRecognition||window.webkitSpeechRecognition) ? 'not started — press Listen' : 'SpeechRecognition is not supported by this browser'; },
  dispose:n=>spStop(n),
  process(n){
    let go=0; const rec=n.q.length ? n.q.splice(0) : null;
    if(rec){ n.text=rec[rec.length-1].text; n.count+=rec.length; go=1; }
    return {text:n.text, go, rec, count:n.count}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    r.textContent=n.status+(n.count ? ' · phrases '+n.count : '')+(n.interim ? '\n… '+n.interim : '')+(n.text ? '\n'+n.text.slice(0,400) : ''); }
});
