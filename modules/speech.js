"use strict";
/* ============================ Speech In / Speech Out ============================
   Web Speech API. Speech In: распознавание речи с микрофона (Chrome / Edge / Safari; в Chrome аудио уходит на сервер распознавания).
   Speech Out: озвучка текста с провода (SpeechSynthesis, голоса системы — без сети). */

function spStop(n){
  n.want=false; clearTimeout(n.timer); n.timer=null;
  const r=n.rec; n.rec=null; n.ok=false;
  if(r){ r.onstart=r.onresult=r.onerror=r.onend=null; try{ r.abort(); }catch(e){} }
  n.interim=''; n.status='stopped';
}
function spStart(n){
  const SR=window.SpeechRecognition || window.webkitSpeechRecognition;
  spStop(n);
  if(!SR){ n.status='speech recognition is not supported (Chrome, Edge, Safari)'; return; }
  n.want=true; n.restarts=0; spOpen(n,SR);
}
function spOpen(n,SR){
  const r=new SR(); n.rec=r;
  r.lang=String(n.p.lang||'').trim() || navigator.language || 'en-US';
  r.continuous=true; r.interimResults=true; r.maxAlternatives=1;
  r.onstart=()=>{ n.ok=true; n.status='listening ('+r.lang+')'; };
  r.onresult=e=>{
    for(let i=e.resultIndex;i<e.results.length;i++){
      const res=e.results[i], alt=res[0];
      if(res.isFinal){
        const text=String(alt.transcript).trim(); if(!text) continue;
        n.q.push({text,conf:typeof alt.confidence==='number' ? alt.confidence : 0}); n.interim=''; n.phrases++;
        n.recQ.push({t:Date.now(),text,conf:Math.round((alt.confidence||0)*100)/100,lang:r.lang});
        if(n.q.length>500) n.q.splice(0,n.q.length-500);
        if(n.recQ.length>5000) n.recQ.splice(0,n.recQ.length-5000);
      } else n.interim=String(alt.transcript);
    }
  };
  r.onerror=e=>{
    const m={'not-allowed':'microphone is blocked','service-not-allowed':'the browser refused the speech service','no-speech':'','aborted':'','audio-capture':'no microphone','network':'no connection to the speech service','language-not-supported':'language not supported'}[e.error];
    if(m) n.status=m; else if(m===undefined) n.status='error: '+e.error;
    if(e.error==='not-allowed' || e.error==='service-not-allowed' || e.error==='audio-capture' || e.error==='language-not-supported') n.want=false;
  };
  r.onend=()=>{
    if(n.rec!==r) return;
    n.ok=false; n.rec=null; n.interim='';
    if(!n.want) return;
    if(!n.p.keep){ n.want=false; n.status='stopped'; return; }
    if(++n.restarts>40){ n.want=false; n.status='stopped: too many restarts'; return; }   // браузер сам закрывает сессию после тишины — тогда перезапуск, но не по кругу без конца
    clearTimeout(n.timer); n.timer=setTimeout(()=>{ if(n.want){ try{ spOpen(n,SR); }catch(e){ n.status='error: '+e.message; } } },300);
  };
  try{ r.start(); n.status='starting…'; }catch(e){ n.status='error: '+e.message; n.want=false; }
}
def({ id:'speechIn', title:'Speech In', cat:'Sources', kw:'speech recognition voice dictation stt microphone words transcribe web speech',
  outs:[{n:'text',t:'txt'},{n:'interim',t:'txt'},{n:'conf',t:'num'},{n:'rec',t:'rec'},{n:'new',t:'num'},{n:'ok',t:'num'}], readout:true,
  params:[{n:'lang',t:'text',d:'',label:'language (en-US, ru-RU, de-DE…; empty — the browser\'s)'},
          {n:'keep',t:'check',d:true,label:'keep listening (restart after a pause)'},
          {n:'start',t:'button',label:'Start',fn:n=>spStart(n)},
          {n:'stop',t:'button',label:'Stop',fn:n=>spStop(n)}],
  init:n=>{ n.rec=null; n.want=false; n.ok=false; n.timer=null; n.q=[]; n.recQ=[]; n.phrases=0; n.restarts=0; n.interim=''; n.conf=0; n.last=''; n.status='stopped'; },
  dispose:n=>spStop(n),
  process(n){
    const m=n.q.length ? n.q.shift() : null;
    if(m){ n.conf=m.conf; n.last=m.text; }
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    return {text:m ? m.text : null,interim:n.interim,conf:n.conf,rec,new:m ? 1 : 0,ok:n.ok ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+' · phrases '+n.phrases+(n.interim ? '\n… '+n.interim : '')+(n.last ? '\n'+n.last.slice(0,300) : '');
    if(r.textContent!==t) r.textContent=t; }
});

/* ---------- Speech Out ---------- */
function soSpeak(n,text){
  const ss=window.speechSynthesis; if(!ss || typeof SpeechSynthesisUtterance==='undefined'){ n.status='speech synthesis is not supported'; return false; }
  const u=new SpeechSynthesisUtterance(String(text).slice(0,2000));
  const lang=String(n.p.lang||'').trim(); if(lang) u.lang=lang;
  const vn=String(n.p.voice||'').trim().toLowerCase();
  if(vn){ const v=ss.getVoices().find(v=>v.name.toLowerCase().includes(vn)); if(v){ u.voice=v; if(!lang) u.lang=v.lang; } }
  u.rate=+n.p.rate; u.pitch=+n.p.pitch; u.volume=+n.p.volume;
  u.onend=u.onerror=()=>{ n.pending=Math.max(0,n.pending-1); };
  if(n.p.mode==='replace'){ ss.cancel(); n.pending=0; }
  n.pending++; n.said++; n.last=String(text); ss.speak(u); n.status='speaking'; return true;
}
def({ id:'speechOut', title:'Speech Out', cat:'Output', kw:'speech tts voice speak say read aloud synthesis announce',
  ins:[{n:'text',t:'txt'},{n:'value',t:'num'}],
  outs:[{n:'busy',t:'num'}], readout:true,
  params:[{n:'lang',t:'text',d:'',label:'language (en-US, ru-RU…; empty — the voice\'s own)'},
          {n:'voice',t:'text',d:'',label:'voice (a part of its name; empty — default)'},
          {n:'rate',t:'range',min:.5,max:2,step:.05,d:1},
          {n:'pitch',t:'range',min:0,max:2,step:.05,d:1},
          {n:'volume',t:'range',min:0,max:1,step:.05,d:1},
          {n:'mode',t:'select',opts:['replace','queue'],d:'replace',label:'a new phrase while speaking'},
          {n:'template',t:'text',d:'{v}',label:'template for the value input ({v} or {v:N} digits after the point)'},
          {n:'say',t:'button',label:'Test',fn:n=>soSpeak(n,'Speech out is working')},
          {n:'stop',t:'button',label:'Stop',fn:n=>{ window.speechSynthesis?.cancel(); n.pending=0; }}],
  init:n=>{ n.lastText=undefined; n.lastVal=undefined; n.pending=0; n.said=0; n.last=''; n.status='idle'; },
  dispose:n=>{ if(n.pending) window.speechSynthesis?.cancel(); },
  process(n,I){
    if(typeof I.text==='string' && I.text!==n.lastText){ n.lastText=I.text; if(I.text.trim()) soSpeak(n,I.text); }
    if(typeof I.value==='number' && isFinite(I.value) && I.value!==n.lastVal){
      n.lastVal=I.value;
      soSpeak(n,String(n.p.template||'{v}').replace(/\{v(?::(\d+))?\}/g,(_,d)=>d ? I.value.toFixed(+d) : String(I.value)));
    }
    if(!n.pending && n.status==='speaking') n.status='idle';
    return {busy:n.pending>0 ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+' · said '+n.said+(n.last ? '\n'+n.last.slice(0,200) : '');
    if(r.textContent!==t) r.textContent=t; }
});
