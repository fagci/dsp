"use strict";
/* ============================ Agent: модель с инструментами ============================
   Узел-оркестратор: сам к модели не ходит, а ведёт цикл «ответ → вызов инструмента → результат → следующий вопрос» по проводам через узел Ollama
   (сервер или хост «app» — llama.cpp на телефоне; KV-кэш хоста «app» не пересчитывает историю на каждом шаге). Провода:
   Agent.prompt → Ollama.prompt, .system → .system, .send → .send, .clear → .clear, .halt → .stop;  Ollama.last → Agent.reply, .new → Agent.new.
   Инструменты (разрешённые в «allow»): calc, time, read / write (входы a…d s1 s2 и выходы o1…o4 t1 t2, объявленные в «tools»), http_get (только свои
   «hosts»), notify / speak (телефон). Запись в выход зажата в min…max из описания. Логика — agent-kernels.js, тест tools/test-agent.mjs. */

const AG_SAMPLE='# What the model sees and can do. Every line makes a pin on this node — wire it to anything.\n# read  name[:num|text|any] "meaning"                       input pin: the model reads its value\n# write name[:type] [min..max] "meaning" [confirm|auto]      output pin: the model sets a value (a number is clamped to min..max)\n# act   name(arg[:type] [min..max], …) [-> result_pin] "meaning" [confirm|auto]\n#       an action: a tool with its own arguments and an output pin «name» (one argument — its value goes out as it is, several —\n#       a record {arg: value}, none — a pulse); «-> pin» is an input pin whose answer comes back to the model; needs your approval unless «auto»\nread temp "temperature, °C"\nread press "pressure, hPa"\nread wind "wind, m/s"\nwrite alert:num 0..3 "alert level, 0 — none … 3 — strong"\nwrite report:text "one-line report for the operator"\n';
const agPulse=(n,k,v)=>{ const on=(v||0)>.5, was=n[k]; n[k]=on; return on && !was; };
// пины по объявлениям в «tools»: разбор кэшируется по тексту
function agParsed(n){ const t=String(n.p.tools||''); if(n._pt!==t){ n._pt=t; n._pp=agParseTools(t); } return n._pp; }
const agDynIns=n=>{ const p=agParsed(n); return [...p.reads.map(r=>({n:r.pin,t:'val',tip:r.desc||r.pin})),...p.acts.filter(a=>a.result).map(a=>({n:a.result,t:'val',tip:'answer of '+a.name}))]; };
const agDynOuts=n=>{ const p=agParsed(n); return [...p.writes.map(w=>({n:w.pin,t:'val',tip:w.desc||w.pin})),...p.acts.map(a=>({n:a.name,t:'val',tip:a.desc||a.name}))]; };
// объявления изменились — пересобрать пины, провода к исчезнувшим убрать (как у Pins (custom))
function agResize(n){
  const vi=new Set(portsOf(n,'ins').map(p=>p.n)), vo=new Set(portsOf(n,'outs').map(p=>p.n));
  Graph.edges.filter(e=>(e.to===n.id && !vi.has(e.tp)) || (e.from===n.id && !vo.has(e.fp))).forEach(delEdge);
  n.nkey=null; rebuildNode(n); markTopoDirty();
}

// перестройка пинов — после паузы и не пока курсор в поле: на полуслове набранное имя не должно рвать провода
function agResizeLater(n){
  clearTimeout(n._rz);
  n._rz=setTimeout(function t(){
    const ae=typeof document!=='undefined' ? document.activeElement : null;
    if(n.el && ae && ae.tagName==='TEXTAREA' && n.el.contains(ae)){ n._rz=setTimeout(t,800); return; }
    if(Graph.map[n.id]===n) agResize(n);
  },800);
}
const agSleep=ms=>new Promise(r=>setTimeout(r,ms));
// запрос подтверждения: ответ — кнопка, провод approve / deny или таймаут (тогда «нет»)
function agAsk(n,text){
  return new Promise(res=>{
    if(n.pend) agAnswer(n,false);
    n.pend={text,res,timer:setTimeout(()=>agAnswer(n,false,true),(+n.p.confirmWait||120)*1000)}; n.confirmText=text; n.rev++;
  });
}
function agAnswer(n,yes,timeout){
  const p=n.pend; if(!p) return;
  clearTimeout(p.timer); n.pend=null; n.confirmText=''; n.rev++;
  n.q.push({t:Date.now(),src:'agent',kind:'confirm',text:p.text,approved:!!yes,...(timeout ? {timeout:true} : {})});
  p.res(!!yes);
}
function agCtx(n){
  const id=n.runId;
  const ctx={now:()=>new Date(),read:p=>n.vals[p],write:(pin,v)=>{ n.o[pin]=v; n.rev++; return v; },confirm:text=>agAsk(n,text),
    // действие: значение уходит на выходной пин; с «-> пин» ждём, пока этот входной пин ответит, и отдаём ответ модели
    act:async(act,vals)=>{
      const keys=act.args.map(a=>a.name), v=keys.length===0 ? 1 : keys.length===1 ? vals[keys[0]] : {...vals};
      const snap=act.result ? JSON.stringify(n.vals[act.result]) : '';
      if(keys.length===1) n.o[act.name]=v; else n.emit[act.name]=v;                    // одно значение держится на пине, запись и импульс — на один такт
      n.rev++;
      if(!act.result) return 'done';
      const wait=(+n.p.actWait||3)*1000, t0=Date.now();
      while(Date.now()-t0<wait){
        await agSleep(40);
        if(n.runId!==id) return 'cancelled';
        const cur=n.vals[act.result]; if(JSON.stringify(cur)!==snap) return agShow(cur) || 'empty answer';
      }
      const cur=agShow(n.vals[act.result]);
      return 'sent, but «'+act.result+'» did not answer in '+(wait/1000)+' s'+(cur ? ' (it still shows: '+cur.slice(0,200)+')' : '');
    }};
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
  if(n.pend) agAnswer(n,false);                                        // ждущее подтверждение — отказ
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
      if(id!==n.runId) return;                                         // за время вызова запуск остановили
      results.push({name:c.name,result:r});
      const line=agTraceLine(n.s.steps,c,r); n.trace.push(line); if(n.trace.length>60) n.trace.shift();
      n.q.push({t:Date.now(),src:'agent',kind:'tool',step:n.s.steps,name:c.name,args:c.args,result:r.slice(0,300)});
    }
    n.pending=agFormatResults(results); n.phase='ask'; n.rev++;
  })();
}

def({ id:'agent', title:'Agent (LLM with tools)', cat:'Tools', readout:true, tall:true, w:340, resize:true,
  kw:'agent llm tools function calling tool use autonomous assistant ollama llama qwen planner react reason act graph control actions pins confirm',
  // task / go — задача и запуск; reply / new — ответ модели (Ollama.last / .new); approve / deny — ответ на запрос подтверждения;
  // остальные пины — из «tools»: read-пины и пины ответа действий (входы), write-пины и пины действий (выходы)
  ins:n=>[{n:'task',t:'txt'},{n:'go',t:'num'},{n:'stop',t:'num'},{n:'reply',t:'txt'},{n:'new',t:'num'},{n:'approve',t:'num'},{n:'deny',t:'num'},...agDynIns(n)],
  outs:n=>[{n:'prompt',t:'txt'},{n:'system',t:'txt'},{n:'send',t:'num'},{n:'clear',t:'num'},{n:'halt',t:'num'},
           {n:'text',t:'txt'},{n:'trace',t:'txt'},{n:'rec',t:'rec'},{n:'done',t:'num'},{n:'busy',t:'num'},{n:'steps',t:'num'},{n:'pending',t:'txt'},...agDynOuts(n)],
  params:[{n:'task',t:'text',d:'',label:'task (the wire «task» starts a run by itself when its text changes)'},
          {n:'run',t:'button',label:'▶ Run the task',fn:n=>agStart(n,n.p.task)},
          {n:'stopb',t:'button',label:'■ Stop',fn:n=>{ if(n.phase!=='idle') agFinish(n,'stop','stopped by hand',true); }},
          {n:'yes',t:'button',label:'✔ Approve the waiting action',fn:n=>agAnswer(n,true)},
          {n:'no',t:'button',label:'✖ Deny it',fn:n=>agAnswer(n,false)},
          {n:'tools',t:'code',plain:true,d:AG_SAMPLE,fn:agResizeLater,label:'what the model sees and can do — every line makes a pin: read name[:type] "meaning" · write name[:type] [min..max] "meaning" · act name(arg[:type] [min..max], …) [-> result_pin] "meaning" [confirm|auto]'},
          {n:'allow',t:'text',d:AG_ALLOW_DEFAULT,label:'built-in tools allowed: calc, time, read, write, http_get, notify, speak (notify / speak — in the DSP app); the actions you declare are always there'},
          {n:'hosts',t:'text',d:'',label:'http_get: allowed hosts, https only (e.g. api.open-meteo.com); empty — the tool does not work'},
          {n:'maxSteps',t:'range',min:1,max:15,step:1,d:6,label:'most steps (model answers) per task'},
          {n:'timeout',t:'range',min:20,max:900,step:10,d:240,label:'wait for the model, s (then the run stops and the model is told to halt)'},
          {n:'confirmWait',t:'range',min:10,max:600,step:10,d:120,label:'wait for your approval of an action, s (then it is denied)'},
          {n:'actWait',t:'range',min:.5,max:30,step:.5,d:3,label:'an action with «-> pin»: wait for the answer on that pin, s'},
          {n:'proxy',t:'check',d:false,label:'http_get: through the CORS proxy from Settings',adv:true}],
  init:n=>{ n.phase='idle'; n.s=agNew(); n.o={}; n.emit={}; n.vals={}; n.parsed={reads:[],writes:[],acts:[],errs:[]}; n.allow=new Set(); n.toolList=[]; n.sysOut=''; n.pending=''; n.runId=0; n.trace=[];
    n.final=''; n.text=''; n.note=''; n.q=[]; n.rev=0; n.pl={send:0,clear:0,halt:0}; n.goP=false; n.stP=false; n.nwP=false; n.apP=false; n.dnP=false; n.lastTask=''; n.waitAt=0; n.t0=0; n.go=0; n.promptOut='';
    n.pend=null; n.confirmText=''; },
  dispose:n=>{ n.runId++; clearTimeout(n._rz); if(n.pend) agAnswer(n,false); },
  drawKey:n=>n.rev+'|'+n.phase,
  process(n,I){
    n.vals=I;
    const t=typeof I.task==='string' ? I.task.trim() : '';
    if(agPulse(n,'goP',I.go)) agStart(n,t||n.p.task);
    else if(t && t!==n.lastTask){ n.lastTask=t; agStart(n,t); }
    if(agPulse(n,'stP',I.stop) && n.phase!=='idle') agFinish(n,'stop','stopped by the stop pin',true);
    if(agPulse(n,'apP',I.approve)) agAnswer(n,true);
    if(agPulse(n,'dnP',I.deny)) agAnswer(n,false);
    const nw=agPulse(n,'nwP',I.new);
    if(n.phase==='clear'){ n.pl.clear=1; n.phase='ask'; }                          // сначала чистая беседа у модели, на следующем такте — вопрос
    else if(n.phase==='ask'){ n.promptOut=n.pending; n.pl.send=1; n.phase='wait'; n.waitAt=performance.now(); }
    else if(n.phase==='wait'){
      if(nw) agReply(n,String(I.reply||''));
      else if(performance.now()-n.waitAt>(+n.p.timeout||240)*1000) agFinish(n,'stop','the model did not answer in '+(+n.p.timeout||240)+' s',true);
    }
    const pl=n.pl; n.pl={send:0,clear:0,halt:0};
    const q=n.q.length ? n.q.splice(0) : null, go=n.go; n.go=0;
    const res={prompt:n.promptOut||null,system:n.sysOut||null,send:pl.send,clear:pl.clear,halt:pl.halt,text:n.text,trace:n.trace.join('\n'),rec:q,done:go,busy:n.phase==='idle' ? 0 : 1,steps:n.s.steps,pending:n.confirmText||''};
    const pp=agParsed(n);
    for(const w of pp.writes) res[w.pin]=n.o[w.pin] ?? null;
    for(const a of pp.acts) res[a.name]=a.name in n.emit ? n.emit[a.name] : (n.o[a.name] ?? null);
    n.emit={};
    return res; },
  draw(n){
    const r=n.el.querySelector('.readout'); if(!r) return;
    const L=[];
    if(n.confirmText) L.push('❓ approve?  '+n.confirmText,'   (✔ / ✖ below, or the «approve» / «deny» pins)');
    if(n.phase==='idle') L.push(n.final ? 'done · '+n.s.steps+' step(s)' : 'idle — press «▶ Run the task» or send a text to «task»');
    else L.push('step '+(n.s.steps+1)+' · '+({clear:'starting',ask:'asking the model',wait:'the model is thinking',exec:'running tools'}[n.phase]||n.phase)+' · '+Math.round((performance.now()-n.t0)/1000)+' s');
    const pe=agParsed(n).errs; if(pe.length) L.push('tools: '+pe.join('; '));
    if(n.note && !pe.length) L.push(n.note);
    if(n.trace.length) L.push('— tools —',...n.trace.slice(-10));
    const outs=Object.keys(n.o).map(k=>k+' = '+(typeof n.o[k]==='number' ? n.o[k] : JSON.stringify(n.o[k]))); if(outs.length) L.push('— outputs —',...outs);
    if(n.final) L.push('— answer —',n.final);
    const t=L.join('\n'); if(r.textContent!==t) r.textContent=t; }
});
