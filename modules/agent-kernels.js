"use strict";
/* ============================ Агент: цикл «модель → инструмент → результат → модель» — чистая логика ============================
   Узел Agent (agent.js) не говорит с моделью сам: он ведёт цикл по проводам через узел Ollama (сервер или хост «app» — llama.cpp на телефоне).
   Здесь — то, что можно проверить без сети: описание инструментов узла, подсказка модели, разбор её вызовов (<tool_call>…</tool_call>, как у Qwen /
   Hermes; для других моделей понимается и голый JSON), безопасный калькулятор (без eval) и решение, что делать с ответом. Тест tools/test-agent.mjs. */

const AG_READ=['a','b','c','d','s1','s2'], AG_WRITE=['o1','o2','o3','o4','t1','t2'];
const agIsNum=p=>/^[a-d]$|^o\d$/.test(p);

// Описание входов и выходов, видимых модели. Строки: read a "что это"; write o1 "что это" min max; # — комментарий.
// read — a…d (числа), s1 s2 (текст); write — o1…o4 (числа, min / max ограничивают запись), t1 t2 (текст).
function agParseTools(text){
  const reads=[], writes=[], errs=[];
  for(const raw of String(text||'').split('\n')){
    const l=raw.trim(); if(!l || l[0]==='#') continue;
    const m=/^(read|write)\s+(\w{1,3})\s*(?:"([^"]*)")?\s*(?:(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?))?\s*$/i.exec(l);
    if(!m){ errs.push('cannot read the line: '+l.slice(0,60)); continue; }
    const kind=m[1].toLowerCase(), pin=m[2].toLowerCase(), desc=m[3]||'', ok=(kind==='read' ? AG_READ : AG_WRITE).includes(pin);
    if(!ok){ errs.push(kind+' '+pin+': '+(kind==='read' ? 'pins are '+AG_READ.join(' ') : 'pins are '+AG_WRITE.join(' '))); continue; }
    if(kind==='read') reads.push({pin,desc,num:agIsNum(pin)});
    else{
      const w={pin,desc,num:agIsNum(pin)};
      if(w.num && m[4]!=null){ w.min=Math.min(+m[4],+m[5]); w.max=Math.max(+m[4],+m[5]); }
      writes.push(w);
    }
  }
  return {reads,writes,errs};
}

// Встроенные инструменты: описание для модели (JSON-схема), в allow — какие разрешил пользователь
const AG_BUILTIN={
  calc:{description:'Evaluate a math expression. Numbers, + - * / % ^, parentheses, pi, e, sin cos tan asin acos atan sqrt log (base 10) ln exp abs min max pow floor ceil round.',
    parameters:{type:'object',properties:{expression:{type:'string',description:'e.g. 20*log(2.5)+3'}},required:['expression']}},
  time:{description:'Current date and time (ISO, UTC and local) and the Unix time.',parameters:{type:'object',properties:{}}},
  read:{description:'Read the current value of a graph input.',parameters:{type:'object',properties:{pin:{type:'string',description:'input name'}},required:['pin']}},
  write:{description:'Set a graph output (the graph reacts to it).',parameters:{type:'object',properties:{pin:{type:'string',description:'output name'},value:{description:'new value'}},required:['pin','value']}},
  http_get:{description:'Fetch a web page or JSON (GET, https only, allowed hosts only); returns the beginning of the text.',parameters:{type:'object',properties:{url:{type:'string'}},required:['url']}},
  notify:{description:'Show a notification on the phone.',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}},
  speak:{description:'Say a text aloud on the phone.',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}}};
const AG_ALLOW_DEFAULT='calc,time,read,write';
const agAllowed=s=>{ const a=String(s==null ? AG_ALLOW_DEFAULT : s).split(/[\s,;]+/).map(x=>x.trim().toLowerCase()).filter(Boolean); return new Set(a.filter(x=>AG_BUILTIN[x])); };

// список инструментов для этой настройки: read / write есть, только если объявлены пины
function agToolList(parsed,allow){
  const out=[];
  for(const name of Object.keys(AG_BUILTIN)){
    if(!allow.has(name)) continue;
    if(name==='read' && !parsed.reads.length) continue;
    if(name==='write' && !parsed.writes.length) continue;
    const spec=JSON.parse(JSON.stringify(AG_BUILTIN[name]));
    if(name==='read') spec.parameters.properties.pin.enum=parsed.reads.map(r=>r.pin);
    if(name==='write') spec.parameters.properties.pin.enum=parsed.writes.map(r=>r.pin);
    out.push({name,...spec});
  }
  return out;
}
function agSystemPrompt(parsed,tools,extra){
  const L=['You are an agent inside a signal-processing workbench. Solve the task step by step; use the tools when you need a value, a calculation or an effect, and never invent a tool result.',''];
  if(tools.length){
    L.push('# Tools','<tools>',...tools.map(t=>JSON.stringify({name:t.name,description:t.description,parameters:t.parameters})),'</tools>','',
      'To call a tool, reply with exactly one or more blocks and nothing else:','<tool_call>{"name": "tool_name", "arguments": {"arg": "value"}}</tool_call>',
      'The results come back as <tool_response>…</tool_response> messages; then continue. When you have the answer, reply in plain text WITHOUT a tool call.','');
  }else L.push('There are no tools: answer from what you know.','');
  if(parsed.reads.length) L.push('Inputs you can read: '+parsed.reads.map(r=>r.pin+(r.desc ? ' — '+r.desc : '')+(r.num ? ' (number)' : ' (text)')).join('; ')+'.');
  if(parsed.writes.length) L.push('Outputs you can set: '+parsed.writes.map(w=>w.pin+(w.desc ? ' — '+w.desc : '')+(w.num ? ' (number'+(w.min!=null ? ', '+w.min+'…'+w.max : '')+')' : ' (text)')).join('; ')+'.');
  L.push('Answer in the language of the task. Be brief.');
  if(extra) L.push('',String(extra));
  return L.join('\n');
}

// --- разбор вызовов в ответе модели
function agJson(s){ try{ return JSON.parse(s); }catch(e){} try{ return JSON.parse(String(s).replace(/,\s*([}\]])/g,'$1')); }catch(e){ return null; } }   // запятая перед скобкой — частая оплошность малых моделей
function agCall(o){
  if(!o || typeof o!=='object') return null;
  const name=o.name ?? o.tool ?? o.function?.name; if(typeof name!=='string' || !name) return null;
  let args=o.arguments ?? o.args ?? o.parameters ?? o.function?.arguments ?? {};
  if(typeof args==='string') args=agJson(args) ?? {};
  return {name:name.trim(),args:args && typeof args==='object' && !Array.isArray(args) ? args : {}};
}
function agParseCalls(text){
  const t=String(text||''), calls=[];
  let rest=t.replace(/<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/gi,(m,body)=>{ const c=agCall(agJson(body.trim())); if(c) calls.push(c); return c ? '' : m; });
  if(!calls.length){                                                  // без тегов: весь ответ — JSON (в ``` или без)
    const fence=/^\s*```(?:json)?\s*([\s\S]*?)```\s*$/i.exec(t), body=(fence ? fence[1] : t).trim();
    if(body[0]==='{' || body[0]==='['){ const j=agJson(body); for(const o of Array.isArray(j) ? j : [j]){ const c=agCall(o); if(c) calls.push(c); } if(calls.length) rest=''; }
  }
  return {calls,rest:rest.trim()};
}

// --- безопасный калькулятор: разбор выражения без eval
const AG_FN={sin:Math.sin,cos:Math.cos,tan:Math.tan,asin:Math.asin,acos:Math.acos,atan:Math.atan,sqrt:Math.sqrt,log:Math.log10,ln:Math.log,exp:Math.exp,abs:Math.abs,
  floor:Math.floor,ceil:Math.ceil,round:Math.round,min:Math.min,max:Math.max,pow:Math.pow};
function agCalc(expr){
  const s=String(expr||'').replace(/,(?=\d{3}\b)/g,'').trim();
  if(!s || s.length>200) throw new Error('expression is empty or too long');
  const tok=[]; const re=/\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)|([A-Za-z_]\w*)|(\*\*|[-+*/%^(),]))/gy; let m, last=0;
  while(last<s.length && (m=re.exec(s))){ last=re.lastIndex; tok.push(m[1]!=null ? {n:+m[1]} : m[2]!=null ? {id:m[2].toLowerCase()} : {op:m[3]==='**' ? '^' : m[3]}); }
  if(s.slice(last).trim()) throw new Error('unexpected character «'+s.slice(last).trim()[0]+'»');
  let i=0, depth=0;
  const peek=()=>tok[i], take=()=>tok[i++];
  const expect=o=>{ const t=take(); if(!t || t.op!==o) throw new Error('«'+o+'» expected'); };
  function prim(){
    const t=take(); if(!t) throw new Error('unexpected end');
    if(t.n!=null) return t.n;
    if(t.op==='('){ if(++depth>30) throw new Error('too deep'); const v=add(); expect(')'); depth--; return v; }
    if(t.id){
      if(t.id==='pi') return Math.PI; if(t.id==='e') return Math.E;
      if(!Object.prototype.hasOwnProperty.call(AG_FN,t.id)) throw new Error('unknown name «'+t.id+'»');
      expect('('); const args=[]; if(peek() && peek().op===')') take(); else{ for(;;){ args.push(add()); const c=take(); if(c && c.op===')') break; if(!c || c.op!==',') throw new Error('«)» expected'); } }
      if(args.length>8) throw new Error('too many arguments');
      return AG_FN[t.id](...args);
    }
    throw new Error('unexpected «'+(t.op||'?')+'»');
  }
  function unary(){                                                   // унарный минус слабее степени: -2^2 = -4; степень правоассоциативна: 2^3^2 = 512
    const t=peek();
    if(t && t.op==='-'){ take(); if(++depth>60) throw new Error('too deep'); const v=-unary(); depth--; return v; }
    if(t && t.op==='+'){ take(); return unary(); }
    return pow();
  }
  function pow(){ const b=prim(); if(peek() && peek().op==='^'){ take(); if(++depth>60) throw new Error('too deep'); const e=unary(); depth--; return Math.pow(b,e); } return b; }
  function mul(){ let v=unary(); for(;;){ const t=peek(); if(t && (t.op==='*' || t.op==='/' || t.op==='%')){ take(); const r=unary(); v=t.op==='*' ? v*r : t.op==='/' ? v/r : v%r; } else return v; } }
  function add(){ let v=mul(); for(;;){ const t=peek(); if(t && (t.op==='+' || t.op==='-')){ take(); const r=mul(); v=t.op==='+' ? v+r : v-r; } else return v; } }
  const v=add(); if(i<tok.length) throw new Error('unexpected «'+(tok[i].op||tok[i].id||tok[i].n)+'»');
  if(typeof v!=='number' || Number.isNaN(v)) throw new Error('not a number');
  return v;
}
const agNum=v=>Number.isFinite(v) ? String(+v.toPrecision(12)) : String(v);

// --- выполнение вызова: sync-инструменты здесь, остальные (сеть, телефон) — через ctx
// ctx: {now(), read(pin), write(pin,value) → записанное, http(url) → text, notify(text), speak(text)}; результат всегда строка (ошибка — «error: …»)
const AG_MAX_RESULT=1500;
async function agRunCall(call,ctx,parsed,allow){
  const cut=s=>{ s=String(s); return s.length>AG_MAX_RESULT ? s.slice(0,AG_MAX_RESULT)+'… (cut, '+s.length+' chars)' : s; };
  try{
    const name=call.name, a=call.args||{};
    if(!AG_BUILTIN[name]) return 'error: unknown tool «'+String(name).slice(0,40)+'» (tools: '+[...allow].join(', ')+')';
    if(!allow.has(name)) return 'error: the tool «'+name+'» is not allowed';
    if(name==='calc') return agNum(agCalc(a.expression));
    if(name==='time'){ const d=ctx.now(); return JSON.stringify({iso:d.toISOString(),local:d.toString().replace(/ GMT.*/,''),unix:Math.floor(d.getTime()/1000)}); }
    if(name==='read'){
      const pin=String(a.pin||'').toLowerCase(), r=parsed.reads.find(x=>x.pin===pin);
      if(!r) return 'error: no input «'+pin+'» (inputs: '+parsed.reads.map(x=>x.pin).join(', ')+')';
      const v=ctx.read(pin); return v==null || v==='' ? 'no value yet' : typeof v==='number' ? agNum(v) : cut(v);
    }
    if(name==='write'){
      const pin=String(a.pin||'').toLowerCase(), w=parsed.writes.find(x=>x.pin===pin);
      if(!w) return 'error: no output «'+pin+'» (outputs: '+parsed.writes.map(x=>x.pin).join(', ')+')';
      let v=a.value;
      if(w.num){ try{ v=typeof v==='string' ? agCalc(v) : +v; }catch(e){ v=NaN; } if(!Number.isFinite(v)) return 'error: «'+pin+'» takes a number'; if(w.min!=null) v=Math.min(w.max,Math.max(w.min,v)); }
      else v=cut(v==null ? '' : typeof v==='object' ? JSON.stringify(v) : v);
      const set=ctx.write(pin,v); return 'ok, '+pin+' = '+(typeof set==='number' ? agNum(set) : JSON.stringify(set));
    }
    if(name==='http_get'){ if(!ctx.http) return 'error: no allowed hosts (set «hosts»)'; return cut(await ctx.http(String(a.url||''))); }
    if(name==='notify'){ if(!ctx.notify) return 'error: only in the DSP app'; await ctx.notify(String(a.text||'').slice(0,400)); return 'ok'; }
    if(name==='speak'){ if(!ctx.speak) return 'error: only in the DSP app'; await ctx.speak(String(a.text||'').slice(0,600)); return 'ok'; }
    return 'error: unsupported';
  }catch(e){ return 'error: '+String(e && e.message || e).slice(0,200); }
}

// --- состояние цикла: что делать с очередным ответом модели
function agNew(){ return {st:'idle',steps:0,seen:{},task:'',trace:[]}; }
function agDecide(s,text,cfg){
  s.steps++;
  const {calls,rest}=agParseCalls(text);
  if(!calls.length) return {kind:'final',text:(rest || String(text||'')).trim()};
  const key=calls.map(c=>c.name+JSON.stringify(c.args)).join('|'); s.seen[key]=(s.seen[key]||0)+1;
  if(s.seen[key]>=3) return {kind:'stop',reason:'the same call repeated three times',text:rest};
  if(s.steps>=cfg.maxSteps) return {kind:'stop',reason:'step limit ('+cfg.maxSteps+')',text:rest};
  return {kind:'tools',calls:calls.slice(0,cfg.maxCalls||4),say:rest};
}
const agFormatResults=rs=>rs.map(r=>'<tool_response>'+JSON.stringify({name:r.name,result:r.result})+'</tool_response>').join('\n');
const agTraceLine=(step,call,result)=>'#'+step+' '+call.name+'('+JSON.stringify(call.args).slice(0,120)+') → '+String(result).replace(/\s+/g,' ').slice(0,160);
