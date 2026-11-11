"use strict";
/* ============================ Agent: модель с инструментами ============================
   Узел-оркестратор: сам к модели не ходит, а ведёт цикл «ответ → вызов инструмента → результат → следующий вопрос» по проводам через узел Ollama
   (сервер или хост «app» — llama.cpp на телефоне; KV-кэш хоста «app» не пересчитывает историю на каждом шаге). Провода:
   Agent.prompt → Ollama.prompt, .system → .system, .send → .send, .clear → .clear, .halt → .stop;  Ollama.last → Agent.reply, .new → Agent.new.
   Инструменты (разрешённые в «allow»): calc, time, read / write (входы a…d s1 s2 и выходы o1…o4 t1 t2, объявленные в «tools»), http_get (только свои
   «hosts»), notify / speak (телефон). Запись в выход зажата в min…max из описания. Логика — agent-kernels.js, тест tools/test-agent.mjs. */

const AG_SAMPLE='# What the model may read (a…d numbers, s1 s2 text) and set (o1…o4 numbers, t1 t2 text); «write» takes a range to clamp the number\nread a "temperature, °C"\nread b "pressure, hPa"\nread c "wind, m/s"\nwrite o1 "alert level, 0 — none … 3 — strong" 0 3\nwrite t1 "one-line report for the operator"\n';
const agPulse=(n,k,v)=>{ const on=(v||0)>.5, was=n[k]; n[k]=on; return on && !was; };

function agCtx(n){
  const ctx={now:()=>new Date(),read:p=>n.vals[p],write:(pin,v)=>{ n.o[pin]=v; n.rev++; return v; }};
  const hosts=String(n.p.hosts||'').split(/[\s,;]+/).map(h=>h.trim().toLowerCase()).filter(Boolean);
  if(hosts.length && n.allow.has('http_get')) ctx.http=async url=>{
    let u; try{ u=new URL(url); }catch(e){ throw new Error('not an address'); }
    if(u.protocol!=='https:') throw new Error('https only');
    if(!hosts.some(h=>u.hostname===h || u.hostname.endsWith('.'+h))) throw new Error('host «'+u.hostname+'» is not in «hosts»');
    const ac=new AbortController(), tm=setTimeout(()=>ac.abort(),15000);
    try{
      const r=await (typeof ndFetch==='function' ? ndFetch(n,u.href,{signal:ac.signal}) : fetch(u.href,{signal:ac.signal}));
      if(!r.ok) throw new Error('HTTP '+r.status);
      return (await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,4000);
    }finally{ clearTimeout(tm); }
  };
  if(typeof AppLink!=='undefined' && AppLink.ok){
    if(n.allow.has('notify')) ctx.notify=t=>AppLink.call('notify',{title:'Agent',text:t},10000);
    if(n.allow.has('speak')) ctx.speak=t=>AppLink.call('tts.speak',{text:t},15000);
  }
  return ctx;
}
function agStart(n,task){
  if(n.phase!=='idle'){ n.note='busy with the previous task — stop it first'; n.rev++; return; }
  task=String(task||'').trim(); if(!task){ n.note='the task is empty'; n.rev++; return; }
  n.parsed=agParseTools(n.p.tools); n.allow=agAllowed(n.p.allow);
  n.toolList=agToolList(n.parsed,n.allow);
  n.sysOut=agSystemPrompt(n.parsed,n.toolList,'');
  n.s=agNew(); n.s.task=task; n.pending=task; n.runId++; n.trace=[]; n.final=''; n.note=n.parsed.errs.length ? 'tools: '+n.parsed.errs.join('; ') : '';
  n.phase='clear'; n.t0=performance.now(); n.rev++;
}
function agFinish(n,kind,text,halt,partial){
  const was=n.phase; n.phase='idle'; n.runId++;
  n.final=kind==='final' ? text : '(stopped: '+text+')'+(partial ? '\n'+partial : '');
  n.text=n.final;
  if(halt && was==='wait') n.pl.halt=1;
  n.q.push({t:Date.now(),src:'agent',kind,text:n.final,steps:n.s.steps,task:n.s.task});
  n.go=1; n.rev++;
}
function agReply(n,text){
  const d=agDecide(n.s,text,{maxSteps:+n.p.maxSteps||6});
  if(d.kind==='final') return agFinish(n,'final',d.text);
  if(d.kind==='stop') return agFinish(n,'stop',d.reason,false,d.text);
  const id=n.runId; n.phase='exec'; n.rev++;
  (async()=>{
    const ctx=agCtx(n), results=[];
    for(const c of d.calls){
      const r=await agRunCall(c,ctx,n.parsed,n.allow);
      results.push({name:c.name,result:r});
      const line=agTraceLine(n.s.steps,c,r); n.trace.push(line); if(n.trace.length>60) n.trace.shift();
      n.q.push({t:Date.now(),src:'agent',kind:'tool',step:n.s.steps,name:c.name,args:c.args,result:r.slice(0,300)});
    }
    if(id!==n.runId) return;                                           // за время вызова запуск остановили
    n.pending=agFormatResults(results); n.phase='ask'; n.rev++;
  })();
}

def({ id:'agent', title:'Agent (LLM with tools)', cat:'Tools', readout:true, tall:true, w:340, resize:true,
  kw:'agent llm tools function calling tool use autonomous assistant ollama llama qwen planner react reason act graph control',
  // task / go — задача и запуск; reply / new — ответ модели (Ollama.last / .new); a…d s1 s2 — что модель может прочитать; o1…o4 t1 t2 — что может задать
  ins:[{n:'task',t:'txt'},{n:'go',t:'num'},{n:'stop',t:'num'},{n:'reply',t:'txt'},{n:'new',t:'num'},
       {n:'a',t:'num'},{n:'b',t:'num'},{n:'c',t:'num'},{n:'d',t:'num'},{n:'s1',t:'txt'},{n:'s2',t:'txt'}],
  outs:[{n:'prompt',t:'txt'},{n:'system',t:'txt'},{n:'send',t:'num'},{n:'clear',t:'num'},{n:'halt',t:'num'},
        {n:'text',t:'txt'},{n:'trace',t:'txt'},{n:'rec',t:'rec'},{n:'done',t:'num'},{n:'busy',t:'num'},{n:'steps',t:'num'},
        {n:'o1',t:'num'},{n:'o2',t:'num'},{n:'o3',t:'num'},{n:'o4',t:'num'},{n:'t1',t:'txt'},{n:'t2',t:'txt'}],
  params:[{n:'task',t:'text',d:'',label:'task (the wire «task» starts a run by itself when its text changes)'},
          {n:'run',t:'button',label:'▶ Run the task',fn:n=>agStart(n,n.p.task)},
          {n:'stopb',t:'button',label:'■ Stop',fn:n=>{ if(n.phase!=='idle') agFinish(n,'stop','stopped by hand',true); }},
          {n:'tools',t:'code',plain:true,d:AG_SAMPLE,label:'inputs and outputs the model may use: read a "meaning" · write o1 "meaning" min max (a…d, s1 s2 / o1…o4, t1 t2)'},
          {n:'allow',t:'text',d:AG_ALLOW_DEFAULT,label:'tools allowed: calc, time, read, write, http_get, notify, speak (notify / speak — in the DSP app)'},
          {n:'hosts',t:'text',d:'',label:'http_get: allowed hosts, https only (e.g. api.open-meteo.com); empty — the tool does not work'},
          {n:'maxSteps',t:'range',min:1,max:15,step:1,d:6,label:'most steps (model answers) per task'},
          {n:'timeout',t:'range',min:20,max:900,step:10,d:240,label:'wait for the model, s (then the run stops and the model is told to halt)'},
          {n:'proxy',t:'check',d:false,label:'http_get: through the CORS proxy from Settings',adv:true}],
  init:n=>{ n.phase='idle'; n.s=agNew(); n.o={}; n.vals={}; n.parsed={reads:[],writes:[],errs:[]}; n.allow=new Set(); n.toolList=[]; n.sysOut=''; n.pending=''; n.runId=0; n.trace=[];
    n.final=''; n.text=''; n.note=''; n.q=[]; n.rev=0; n.pl={send:0,clear:0,halt:0}; n.goP=false; n.stP=false; n.nwP=false; n.lastTask=''; n.waitAt=0; n.t0=0; n.go=0; n.promptOut=''; },
  dispose:n=>{ n.runId++; },
  drawKey:n=>n.rev+'|'+n.phase,
  process(n,I){
    n.vals={a:I.a,b:I.b,c:I.c,d:I.d,s1:I.s1,s2:I.s2};
    const t=typeof I.task==='string' ? I.task.trim() : '';
    if(agPulse(n,'goP',I.go)) agStart(n,t||n.p.task);
    else if(t && t!==n.lastTask){ n.lastTask=t; agStart(n,t); }
    if(agPulse(n,'stP',I.stop) && n.phase!=='idle') agFinish(n,'stop','stopped by the stop pin',true);
    const nw=agPulse(n,'nwP',I.new);
    if(n.phase==='clear'){ n.pl.clear=1; n.phase='ask'; }                          // сначала чистая беседа у модели, на следующем такте — вопрос
    else if(n.phase==='ask'){ n.promptOut=n.pending; n.pl.send=1; n.phase='wait'; n.waitAt=performance.now(); }
    else if(n.phase==='wait'){
      if(nw) agReply(n,String(I.reply||''));
      else if(performance.now()-n.waitAt>(+n.p.timeout||240)*1000) agFinish(n,'stop','the model did not answer in '+(+n.p.timeout||240)+' s',true);
    }
    const pl=n.pl; n.pl={send:0,clear:0,halt:0};
    const q=n.q.length ? n.q.splice(0) : null, go=n.go; n.go=0;
    return {prompt:n.promptOut||null,system:n.sysOut||null,send:pl.send,clear:pl.clear,halt:pl.halt,text:n.text,trace:n.trace.join('\\n'),rec:q,done:go,busy:n.phase==='idle' ? 0 : 1,steps:n.s.steps,
      o1:n.o.o1??null,o2:n.o.o2??null,o3:n.o.o3??null,o4:n.o.o4??null,t1:n.o.t1??null,t2:n.o.t2??null}; },
  draw(n){
    const r=n.el.querySelector('.readout'); if(!r) return;
    const L=[];
    if(n.phase==='idle') L.push(n.final ? 'done · '+n.s.steps+' step(s)' : 'idle — press «▶ Run the task» or send a text to «task»');
    else L.push('step '+(n.s.steps+1)+' · '+({clear:'starting',ask:'asking the model',wait:'the model is thinking',exec:'running tools'}[n.phase]||n.phase)+' · '+Math.round((performance.now()-n.t0)/1000)+' s');
    if(n.note) L.push(n.note);
    if(n.trace.length) L.push('— tools —',...n.trace.slice(-10));
    const outs=Object.keys(n.o).map(k=>k+' = '+(typeof n.o[k]==='number' ? n.o[k] : JSON.stringify(n.o[k]))); if(outs.length) L.push('— outputs —',...outs);
    if(n.final) L.push('— answer —',n.final);
    const t=L.join('\\n'); if(r.textContent!==t) r.textContent=t; }
});
