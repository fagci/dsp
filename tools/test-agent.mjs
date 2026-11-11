// Agent: цикл модель → инструмент → результат (modules/agent-kernels.js, agent.js): node tools/test-agent.mjs
// Узел проверяется целиком: подставной узел Ollama читает провода агента (prompt, system, send, clear, halt) и отвечает по заранее заданному сценарию.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const defs={}, clock={t:0}, calls={http:[],app:[]};
const ctx=vm.createContext({Math,JSON,Set,Object,Array,String,Number,Date,Error,RegExp,Promise,URL,AbortController,setTimeout,clearTimeout,Map,
  performance:{now:()=>clock.t}, def:d=>{ defs[d.id]=d; },
  ndFetch:async(n,url)=>{ calls.http.push(url); return {ok:true,status:200,text:async()=>'<html><script>x()</script><body>Temp <b>+4</b> °C</body></html>'}; },
  AppLink:{ok:true,call:async(cmd,args)=>{ calls.app.push([cmd,args]); return {}; }}});
vm.runInContext(['agent-kernels.js','agent.js'].map(f=>fs.readFileSync(path.join(root,'modules/'+f),'utf8')).join('\n')+';this.K={agParseTools,agToolList,agAllowed,agSystemPrompt,agParseCalls,agCalc,agRunCall,agNew,agDecide,agFormatResults,agTraceLine,AG_BUILTIN,AG_SAMPLE};',ctx);
const K=ctx.K, D=defs.agent;
const node=(p={})=>{ const n={p:{...Object.fromEntries(D.params.filter(q=>q.d!==undefined).map(q=>[q.n,q.d])),...p},el:null}; D.init(n); return n; };

// --- описание инструментов узла
const pt=K.agParseTools(`# comment\nread a "temperature, °C"\nread s1\nwrite o1 "alert" 3 0\nwrite o2 "free number"\nwrite t1 "report"\nread z "bad pin"\nwrite a "bad pin"\nsomething odd\nwrite o3 "gain, dB" -10 10`);
ok('tools: reads and writes with their meanings, text and number pins told apart',pt.reads.length===2 && pt.reads[0].pin==='a' && pt.reads[0].num && pt.reads[0].desc==='temperature, °C' && pt.reads[1].pin==='s1' && !pt.reads[1].num && pt.writes.length===4);
ok('tools: a range is ordered min…max, absent for text and for a number without one',pt.writes[0].min===0 && pt.writes[0].max===3 && pt.writes[1].min===undefined && pt.writes[2].min===undefined && pt.writes[3].min===-10 && pt.writes[3].max===10);
ok('tools: unknown pins and odd lines are reported, not silently dropped',pt.errs.length===3 && /read z/.test(pt.errs[0]) && /write a/.test(pt.errs[1]) && /cannot read/.test(pt.errs[2]),JSON.stringify(pt.errs));
ok('tools: the sample of the node parses without errors',K.agParseTools(K.AG_SAMPLE).errs.length===0 && K.agParseTools(K.AG_SAMPLE).reads.length===3);
const al=K.agAllowed('calc, time;read http_get bogus WRITE');
ok('allow: names split by commas / spaces, unknown ones dropped, case ignored; the default is the safe set',al.size===5 && al.has('write') && !al.has('bogus') && [...K.agAllowed(undefined)].join()==='calc,time,read,write' && K.agAllowed('').size===0);
const tl=K.agToolList(pt,K.agAllowed('calc,read,write,speak'));
ok('tool list: only the allowed ones, read / write list their pins',tl.map(t=>t.name).join()==='calc,read,write,speak' && tl[1].parameters.properties.pin.enum.join()==='a,s1' && tl[2].parameters.properties.pin.enum.join()==='o1,o2,t1,o3');
ok('tool list: read / write vanish when no pins are declared',K.agToolList({reads:[],writes:[],errs:[]},K.agAllowed('calc,read,write')).map(t=>t.name).join()==='calc');
const sp=K.agSystemPrompt(pt,tl,'');
ok('system prompt: tools as JSON, the call format, the pins with meanings and ranges',/<tools>/.test(sp) && /"name":"calc"/.test(sp) && /<tool_call>/.test(sp) && /a — temperature, °C \(number\)/.test(sp) && /o1 — alert \(number, 0…3\)/.test(sp) && /WITHOUT a tool call/.test(sp));
ok('system prompt: no tools → says so',/no tools/.test(K.agSystemPrompt({reads:[],writes:[]},[],'')));

// --- разбор вызовов
const c1=K.agParseCalls('Let me check. <tool_call>{"name":"calc","arguments":{"expression":"1+1"}}</tool_call><tool_call>{"name":"time","arguments":{}}</tool_call>');
ok('calls: Hermes tags (several in one answer), the text around is kept',c1.calls.length===2 && c1.calls[0].name==='calc' && c1.calls[0].args.expression==='1+1' && c1.calls[1].name==='time' && c1.rest==='Let me check.');
ok('calls: an unterminated tag (the answer was cut) still works',K.agParseCalls('<tool_call>{"name":"time","arguments":{}}').calls.length===1);
ok('calls: bare JSON, JSON in a fence, other key names, a string of arguments, a trailing comma',
   K.agParseCalls('{"name":"time","arguments":{}}').calls.length===1 && K.agParseCalls('```json\n{"tool":"calc","args":{"expression":"2"}}\n```').calls[0].args.expression==='2'
   && K.agParseCalls('<tool_call>{"name":"calc","arguments":"{\\"expression\\":\\"3\\"}"}</tool_call>').calls[0].args.expression==='3'
   && K.agParseCalls('<tool_call>{"name":"calc","arguments":{"expression":"4",},}</tool_call>').calls[0].args.expression==='4');
ok('calls: plain text, a broken tag and JSON that is not a call are not calls',K.agParseCalls('The answer is 42.').calls.length===0 && K.agParseCalls('<tool_call>not json</tool_call>').calls.length===0 && K.agParseCalls('{"answer":42}').calls.length===0 && K.agParseCalls('').calls.length===0);
ok('calls: arguments that are not an object become an empty object',K.agParseCalls('<tool_call>{"name":"time","arguments":[1,2]}</tool_call>').calls[0].args && Object.keys(K.agParseCalls('<tool_call>{"name":"time","arguments":[1,2]}</tool_call>').calls[0].args).length===0);

// --- калькулятор
const calc=e=>{ try{ return K.agCalc(e); }catch(x){ return 'ERR:'+x.message; } };
ok('calc: arithmetic with the usual precedence (unary minus below ^, ^ to the right)',calc('2+3*4')===14 && calc('-2^2')===-4 && calc('2^3^2')===512 && calc('(1+2)*3')===9 && calc('10%4')===2 && calc('2**3')===8 && calc('3*-2')===-6);
ok('calc: functions and constants',Math.abs(calc('20*log(2.5)+3')-10.9588)<1e-3 && calc('sqrt(16)+abs(-3)')===7 && calc('max(1,5,3)')===5 && Math.abs(calc('sin(pi/2)')-1)<1e-12 && calc('round(2.5)')===3 && calc('1,000+1')===1001);
ok('calc: nothing but math — names, calls and prototype tricks are refused',['constructor','process','__proto__(1)','toString(1)','(1)(2)','this','globalThis','alert(1)','1;2','"a"','sin'].every(e=>String(calc(e)).startsWith('ERR:')),JSON.stringify(['constructor','process','alert(1)'].map(calc)));
ok('calc: errors are clear, 0/0 is not a number, a huge expression is refused',/unexpected end/.test(calc('1+')) && /not a number/.test(calc('0/0')) && /too long/.test(calc('1+'.repeat(200)+'1')) && /empty/.test(calc('')) && /too deep/.test(calc('('.repeat(40)+'1'+')'.repeat(40))));

// --- решение по ответу
const s=K.agNew();
ok('decide: no call → final text',K.agDecide(s,'It is 42.',{maxSteps:6}).kind==='final' && s.steps===1);
const d1=K.agDecide(K.agNew(),'<tool_call>{"name":"calc","arguments":{"expression":"1"}}</tool_call>',{maxSteps:6});
ok('decide: a call → tools',d1.kind==='tools' && d1.calls.length===1);
const sl=K.agNew(); const cl='<tool_call>{"name":"time","arguments":{}}</tool_call>'; K.agDecide(sl,cl,{maxSteps:9}); K.agDecide(sl,cl,{maxSteps:9});
const d3=K.agDecide(sl,cl,{maxSteps:9});
ok('decide: the same call the third time stops the run (a model stuck in a loop), with the reason',d3.kind==='stop' && /three times/.test(d3.reason),JSON.stringify(d3));
const sm=K.agNew(); sm.steps=5;
ok('decide: the step limit stops it',K.agDecide(sm,'<tool_call>{"name":"calc","arguments":{"expression":"7"}}</tool_call>',{maxSteps:6}).kind==='stop');
ok('decide: no more than maxCalls calls per step',K.agDecide(K.agNew(),Array.from({length:9},(_,i)=>'<tool_call>{"name":"calc","arguments":{"expression":"'+i+'"}}</tool_call>').join(''),{maxSteps:9,maxCalls:3}).calls.length===3);
ok('results go back as <tool_response> blocks',K.agFormatResults([{name:'calc',result:'2'},{name:'time',result:'x'}])==='<tool_response>{"name":"calc","result":"2"}</tool_response>\n<tool_response>{"name":"time","result":"x"}</tool_response>');

// --- выполнение вызовов
const vals={a:21.5,s1:'CQ CQ de R1ABC'}, outs={}; const parsed=K.agParseTools('read a "t"\nread s1\nwrite o1 "alert" 0 3\nwrite t1\nwrite o2');
const rc=(name,args,allow='calc,time,read,write,http_get,notify,speak',c={})=>K.agRunCall({name,args},{now:()=>new Date(Date.UTC(2026,10,11,12,0,0)),read:p=>vals[p],write:(p,v)=>{ outs[p]=v; return v; },...c},parsed,K.agAllowed(allow));
ok('run: calc, time',await rc('calc',{expression:'20*log(2.5)'})==='7.95880017344' && JSON.parse(await rc("time",{})).unix===1794398400);
ok('run: read a number and a text, an unknown pin, a pin without a value',await rc('read',{pin:'a'})==='21.5' && await rc('read',{pin:'s1'})==='CQ CQ de R1ABC' && /no input «q»/.test(await rc('read',{pin:'q'})) && await rc('read',{pin:'a'},undefined,{read:()=>undefined})==='no value yet');
ok('run: write clamps a number to the declared range, takes numbers sent as text, refuses non-numbers',await rc('write',{pin:'o1',value:7})==='ok, o1 = 3' && outs.o1===3 && await rc('write',{pin:'o1',value:'1+1'})==='ok, o1 = 2' && /takes a number/.test(await rc('write',{pin:'o1',value:'abc'})) && await rc('write',{pin:'o2',value:-50})==='ok, o2 = -50');
ok('run: write of text, objects become JSON, a read-only pin cannot be written',await rc('write',{pin:'t1',value:'alert!'})==='ok, t1 = "alert!"' && outs.t1==='alert!' && /no output «a»/.test(await rc('write',{pin:'a',value:1})));
ok('run: unknown and not allowed tools are explained',/unknown tool «rm»/.test(await rc('rm',{})) && /not allowed/.test(await rc('calc',{expression:'1'},'time')) && /not allowed/.test(await rc('http_get',{url:'https://x'},'calc')));
ok('run: errors never throw, they come back as text for the model',/^error: /.test(await rc('calc',{expression:'1+'})) && /^error: /.test(await rc('calc',null)));
ok('run: http_get / notify / speak without their support say so',/no allowed hosts/.test(await rc('http_get',{url:'https://x'})) && /only in the DSP app/.test(await rc('notify',{text:'x'})) && /only in the DSP app/.test(await rc('speak',{text:'x'})));
ok('run: a long result is cut with its length',/\(cut, 3000 chars\)$/.test(await rc('read',{pin:'s1'},undefined,{read:()=>'x'.repeat(3000)})));

// --- узел целиком: подставной Ollama на проводах
// сценарий: массив ответов; модель «думает» delay тактов; возвращает записи обмена
function llm(script,delay=2){
  const log=[], st={i:0,wait:-1,last:'',pulse:0};
  return {log,
    feed(o){                                      // выходы агента → вход «модели»; возвращает то, что модель подаёт обратно {reply,new}
      if(o.clear) log.push({clear:1});
      if(o.send){ log.push({prompt:o.prompt,system:o.system}); st.wait=delay; }
      if(o.halt) { log.push({halt:1}); st.wait=-1; }
      let nw=0;
      if(st.wait>0){ st.wait--; if(st.wait===0){ st.last=script[st.i++]; nw=1; st.wait=-1; } }
      return {reply:st.last,new:nw};
    }};
}
async function run(n,m,inputs={},ticks=60,pre){
  let I={}, last, seq=[];
  for(let k=0;k<ticks;k++){
    clock.t+=100;
    last=D.process(n,{...inputs,...I,...(pre&&pre(k)||{})});
    seq.push(last);
    I=m.feed(last);
    await wait(2);
    if(n.phase==='idle' && k>3) break;
  }
  return {last,seq};
}
const call=(name,args)=>'<tool_call>'+JSON.stringify({name,arguments:args})+'</tool_call>';

// A: два шага — вычисление и ответ
let n=node({task:'What is 20*log(2.5)?'}), m=llm([call('calc',{expression:'20*log(2.5)'}),'It is about 7.96.']);
D.params.find(p=>p.n==='run').fn(n);
let r=await run(n,m);
ok('agent: the answer arrives, two model steps were used',n.final==='It is about 7.96.' && n.s.steps===2 && r.last.text==='It is about 7.96.' && r.last.done===1,n.final);
ok('agent: the dialogue is cleared first, then the task is sent with the system prompt',m.log[0].clear===1 && m.log[1].prompt==='What is 20*log(2.5)?' && /<tools>/.test(m.log[1].system) && /calc/.test(m.log[1].system),JSON.stringify(m.log.slice(0,2)).slice(0,200));
ok('agent: the tool result goes to the model as the next message',/^<tool_response>\{"name":"calc","result":"7\.95880017344"\}<\/tool_response>$/.test(m.log[2].prompt),m.log[2].prompt);
ok('agent: the trace lists the call and its result, the rec events too',/calc\(\{"expression":"20\*log\(2\.5\)"\}\) → 7\.9588/.test(n.trace[0]) && n.q.length===0 && r.seq.some(o=>o.rec && o.rec.some(e=>e.kind==='tool' && e.name==='calc')) && r.seq.some(o=>o.rec && o.rec.some(e=>e.kind==='final')));
ok('agent: pulses are single ticks (send, clear), busy only while it works',r.seq.filter(o=>o.send).length===2 && r.seq.filter(o=>o.clear).length===1 && r.seq[0].busy===1 && r.last.busy===0);

// B: чтение входа, запись выхода с ограничением, текстовый выход
n=node({task:'Check the weather'}); m=llm([call('read',{pin:'a'})+call('read',{pin:'b'}),call('write',{pin:'o1',value:9})+call('write',{pin:'t1',value:'Ducting likely'}),'Alert set.']);
D.params.find(p=>p.n==='run').fn(n); r=await run(n,m,{a:21.5,b:1031});
ok('agent: two reads in one step come back together, with the real input values',/"result":"21\.5"/.test(m.log[2].prompt) && /"result":"1031"/.test(m.log[2].prompt) && m.log[2].prompt.split('\n').length===2);
ok('agent: write is clamped to 0…3 and the outputs hold their values on the pins',r.last.o1===3 && r.last.t1==='Ducting likely' && r.last.o2===null && n.final==='Alert set.',JSON.stringify([r.last.o1,r.last.t1]));
ok('agent: the system prompt tells the model what the pins mean (from the «tools» text)',/a — temperature, °C \(number\)/.test(m.log[1].system) && /o1 — alert level/.test(m.log[1].system));

// C: модель молчит — таймаут, модели велено остановиться
n=node({task:'x',timeout:20}); m=llm([],9999); D.params.find(p=>p.n==='run').fn(n);
r=await run(n,m,{},400);
ok('timeout: the run stops with the reason and the model gets «halt»',n.phase==='idle' && /did not answer in 20 s/.test(n.final) && m.log.some(e=>e.halt) && r.seq.some(o=>o.halt===1),n.final);
// D: стоп по проводу
n=node({task:'x'}); m=llm([],9999); D.params.find(p=>p.n==='run').fn(n);
r=await run(n,m,{},6); const st=D.process(n,{stop:1}); const st2=D.process(n,{stop:1});
ok('stop pin: ends the run once, tells the model to halt',n.phase==='idle' && st.halt===1 && st2.halt===0 && /stopped by the stop pin/.test(n.final));
// E: зацикливание
n=node({task:'x',maxSteps:15}); m=llm(Array(10).fill(call('time',{})));
D.params.find(p=>p.n==='run').fn(n); r=await run(n,m,{},200);
ok('loop guard: the same call three times ends the run, not fifteen steps',n.phase==='idle' && /three times/.test(n.final) && n.s.steps<=3,n.final+' steps '+n.s.steps);
// F: лимит шагов
n=node({task:'x',maxSteps:3}); m=llm([call('calc',{expression:'1'}),call('calc',{expression:'2'}),call('calc',{expression:'3'}),call('calc',{expression:'4'})]);
D.params.find(p=>p.n==='run').fn(n); r=await run(n,m,{},200);
ok('step limit: the run ends with a note and the model text so far',/step limit \(3\)/.test(n.final) && n.s.steps===3);
// G: вторая задача во время работы
n=node({task:'one'}); m=llm(['done'],5); D.params.find(p=>p.n==='run').fn(n); D.process(n,{});
D.params.find(p=>p.n==='run').fn(n); ok('a second task while busy is refused with a note',/busy/.test(n.note) && n.phase!=='idle');
// H: задача с провода
n=node(); m=llm(['ok done']); r=await run(n,m,{task:'ping'},60);
ok('the «task» wire starts a run by itself (and only when its text changes)',n.final==='ok done' && n.s.task==='ping' && m.log.filter(e=>e.prompt).length===1);
n=node({task:'saved task'}); m=llm(['fine']); r=await run(n,m,{go:1},60,k=>({go:k===0 ? 1 : 0}));
ok('the «go» pulse runs the task from the parameter',n.final==='fine' && n.s.task==='saved task');
n=node(); D.params.find(p=>p.n==='run').fn(n); ok('an empty task is refused',/empty/.test(n.note) && n.phase==='idle');
// I: http_get
n=node({task:'t',allow:'calc,http_get',hosts:'api.open-meteo.com',tools:''}); m=llm([call('http_get',{url:'https://api.open-meteo.com/v1/forecast?x=1'}),call('http_get',{url:'https://evil.example/x'}),call('http_get',{url:'http://api.open-meteo.com/'}),'done']);
D.params.find(p=>p.n==='run').fn(n); r=await run(n,m,{},300);
ok('http_get: an allowed host works (tags and scripts stripped), a foreign host and plain http are refused',/Temp \+4 °C/.test(m.log[2].prompt) && !/script/.test(m.log[2].prompt) && /not in «hosts»/.test(m.log[3].prompt) && /https only/.test(m.log[4].prompt) && calls.http.length===1,JSON.stringify(calls.http));
n=node({task:'t',allow:'calc,http_get',hosts:'',tools:''}); m=llm([call('http_get',{url:'https://x.org'}),'d']); D.params.find(p=>p.n==='run').fn(n); await run(n,m,{},200);
ok('http_get: without «hosts» it does not work',/no allowed hosts/.test(m.log[2].prompt));
// J: телефон
calls.app.length=0; n=node({task:'t',allow:'notify,speak',tools:''}); m=llm([call('notify',{text:'Ducting!'})+call('speak',{text:'Ducting'}),'sent']); D.params.find(p=>p.n==='run').fn(n); await run(n,m,{},200);
ok('phone tools: a notification and speech go to the bridge only when allowed',calls.app.length===2 && calls.app[0][0]==='notify' && calls.app[0][1].text==='Ducting!' && calls.app[1][0]==='tts.speak');
calls.app.length=0; n=node({task:'t',allow:'calc',tools:''}); m=llm([call('notify',{text:'x'}),'d']); D.params.find(p=>p.n==='run').fn(n); await run(n,m,{},200);
ok('phone tools: not allowed → refused, nothing reaches the bridge',calls.app.length===0 && /not allowed/.test(m.log[2].prompt));
// K: остановка кнопкой во время работы инструмента: результат не применяется
n=node({task:'t'}); m=llm([call('calc',{expression:'1'}),'x']); D.params.find(p=>p.n==='run').fn(n);
for(let k=0;k<5;k++){ clock.t+=100; const o=D.process(n,{}); m.feed(o); }
D.params.find(p=>p.n==='stopb').fn(n); await wait(10);
ok('stop by hand: the run ends at once and a late tool result does not revive it',n.phase==='idle' && /stopped by hand/.test(n.final));
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
