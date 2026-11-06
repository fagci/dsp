"use strict";
/* ============================ Rec Queue: очередь записей, по одной ============================
   Записи с входа ставятся в очередь и выдаются по одной: по ответу (ack — «обработали, давай следующую»), по таймеру или по команде next.
   Это «для каждого» с ожиданием: найденное устройство → подключиться → дождаться ответа → следующее. Без DOM — tools/test-flow.mjs. */

function rqNew(){ return {q:[],busy:false,sentAt:0,lastEmit:-Infinity,seen:new Set(),sent:0,total:0,drained:true,cur:null}; }
// записи → очередь; key — поле, по которому не повторяем (пусто — все подряд); max — предел длины очереди
function rqPush(st,recs,key,max){
  let n=0;
  for(const r of Array.isArray(recs) ? recs : recs&&typeof recs==='object' ? [recs] : []){
    if(!r || typeof r!=='object') continue;
    if(key){ const k=r[key]; if(k==null) continue; if(st.seen.has(k)) continue; st.seen.add(k); if(st.seen.size>5000) st.seen.delete(st.seen.values().next().value); }
    if(st.q.length>=max) break;
    st.q.push(r); st.total++; st.drained=false; n++;
  }
  return n;
}
/**
 * Один тик. e: {next, ack, clear} — фронты (true в тик, когда вход пошёл вверх); t — мс;
 * o: {mode: 'await'|'interval'|'manual', interval (с), timeout (с, 0 — ждать вечно)}.
 * → {item, done}
 */
function rqStep(st,e,t,o){
  if(e.clear){ st.q.length=0; st.busy=false; st.seen.clear(); st.drained=true; st.cur=null; return {item:null,done:false,cleared:true}; }
  if(e.ack) st.busy=false;
  if(st.busy && o.mode==='await' && +o.timeout>0 && t-st.sentAt>=o.timeout*1000) st.busy=false;     // ответа нет — идём дальше
  let go=false;
  if(st.q.length){
    if(o.mode==='manual') go=!!e.next;
    else if(o.mode==='interval') go=!!e.next || (t-st.lastEmit>=Math.max(0,+o.interval||0)*1000);
    else go=!!e.next || !st.busy;
  }
  let item=null;
  if(go){ item=st.q.shift(); st.cur=item; st.busy=true; st.sentAt=st.lastEmit=t; st.sent++; if(o.mode==='interval') st.busy=false; }
  let done=false;
  if(!st.q.length && !st.busy && !st.drained && !item){ st.drained=true; done=true; }
  return {item,done};
}

if(typeof module!=='undefined') module.exports={rqNew,rqPush,rqStep};

// шаблон команды для Rule (If → Command): строковое значение "$field" берёт поле из последней подошедшей под условие записи
function ruleApply(tmpl,r){
  const out={};
  for(const k in tmpl){
    const v=tmpl[k];
    out[k]=(typeof v==='string' && v[0]==='$' && v.length>1 && r && typeof r==='object' && r[v.slice(1)]!==undefined) ? r[v.slice(1)] : v;
  }
  return out;
}

if(typeof module!=='undefined') Object.assign(module.exports,{ruleApply});

/* ============================ Cases: состояния «условие → значение → команда» ============================
   Строка: [имя:] условие => значение => {команда JSON}. Значение — число (суффиксы k / M / G) или выражение JS; без значения — null.
   Выигрывает первая подошедшая строка; если не подошла ни одна — состояние держится. */
const CASES_MUL={k:1e3,m:1e6,g:1e9};
function casesNum(s){
  const m=/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([kmg])?(?:hz)?$/i.exec(String(s).trim());
  return m ? +m[1]*(m[2] ? CASES_MUL[m[2].toLowerCase()] : 1) : null;
}
function casesParse(text){
  const rows=[], errors=[];
  String(text||'').split('\n').forEach((raw,i)=>{
    let s=raw.trim(); if(!s || s[0]==='#' || s.startsWith('//')) return;
    let name=''; const m=/^([\p{L}_][\p{L}\p{N}_ .-]*?)\s*:\s+/u.exec(s);
    if(m){ name=m[1]; s=s.slice(m[0].length); }
    const parts=[]; let rest=s;
    for(let k=0;k<2;k++){ const j=rest.indexOf('=>'); if(j<0) break; parts.push(rest.slice(0,j)); rest=rest.slice(j+2); }
    parts.push(rest);
    const row={name:name||('case '+(rows.length+1)), cond:parts[0].trim()||'true', val:null, valExpr:'', cmd:null, line:i+1};
    const v=parts.length>1 ? parts[1].trim() : '';
    if(v){ const x=casesNum(v); if(x!=null) row.val=x; else row.valExpr=v; }
    const c=parts.length>2 ? parts[2].trim() : '';
    if(c){ try{ const o=JSON.parse(c); if(o && typeof o==='object' && !Array.isArray(o)) row.cmd=o; else throw new Error('not an object'); }
           catch(e){ errors.push('line '+(i+1)+': command JSON: '+e.message); } }
    rows.push(row);
  });
  return {rows,errors};
}
// исходник модуля с функциями [условие, значение] на строку
function casesSource(rows){
  const f=e=>'(r,a,b,c,d)=>('+e+')';
  return 'export default ['+rows.map(r=>'['+f(r.cond)+','+(r.valExpr ? f(r.valExpr) : 'null')+']').join(',')+'];';
}
// idx — первая подошедшая строка (−1 — никакая); settle — с, сколько новое состояние должно продержаться; → true, если состояние сменилось
function casesStep(st,idx,t,settle){
  if(idx<0) idx=st.cur;
  if(idx===st.cur){ st.cand=idx; return false; }
  if(st.cand!==idx){ st.cand=idx; st.since=t; }
  if(st.cur<0 || t-st.since>=(+settle||0)*1000){ st.cur=idx; return true; }
  return false;
}
if(typeof module!=='undefined') Object.assign(module.exports,{casesNum,casesParse,casesSource,casesStep});


/* ---- Command Templates: «TUNE {f}» — поля подставляются со входов, отправка по импульсу/кнопке ---- */
// строки-шаблоны: по одной команде на строку, пустые и комментарии (# или //) пропускаются
function cmdTpls(src){ return String(src==null?'':src).split('\n').map(s=>s.trim()).filter(s=>s && !s.startsWith('#') && !s.startsWith('//')); }
// {имя} в шаблоне — допустимые имена полей (буквы/цифры/подчёркивание), без повторов, в порядке появления
function cmdFields(tpl){ const out=[]; for(const m of String(tpl).matchAll(/\{([^}]+)\}/g)){ const f=m[1].trim(); if(/^[A-Za-zА-Яа-яЁё0-9_]+$/.test(f) && !out.includes(f)) out.push(f); } return out; }
// все поля списка шаблонов, без повторов
function cmdNames(tpls){ const out=[]; for(const t of tpls) for(const f of cmdFields(t)) if(!out.includes(f)) out.push(f); return out; }
// число в команду: целые — без точки, дробные — до 6 знаков без хвостовых нулей
function cmdFmtVal(v){ if(typeof v==='number'){ if(!isFinite(v)) return ''; return Math.abs(v%1)>1e-9 ? String(+v.toFixed(6)) : String(Math.round(v)); } return v==null?'':String(v); }
// подстановка: нет значения — placeholder остаётся как есть (видно в выводе, что не хватает входа)
function cmdFill(tpl,vals){ return String(tpl).replace(/\{([^}]+)\}/g,(m,f)=>{ const k=f.trim(); return Object.prototype.hasOwnProperty.call(vals,k)?cmdFmtVal(vals[k]):m; }); }
if(typeof module!=='undefined') Object.assign(module.exports,{cmdTpls,cmdFields,cmdNames,cmdFmtVal,cmdFill});

/* ============================ Wait Until / Measure Window ============================
   Шаги обработчика задачи (Batch Check, kind node): дождаться, пока прибор «успокоится», и усреднить замер за окно.
   Чистые функции: состояние st, события e, время t (мс), настройки o; результат — импульсы на один шаг. Проверка: node tools/test-flow.mjs */
function wuNew(){ return {on:false,t0:0,since:null,ok:0,held:0}; }
// условие над числом v: < <= > >= == != и «в диапазоне a…b»
function wuTest(v,op,a,b){
  if(typeof v!=='number' || !isFinite(v)) return false;
  switch(op){
    case '<': return v<a; case '<=': return v<=a; case '>': return v>a; case '>=': return v>=a;
    case '==': return Math.abs(v-a)<1e-9; case '!=': return Math.abs(v-a)>=1e-9;
    case 'in a…b': return v>=Math.min(a,b) && v<=Math.max(a,b);
    default: return false;
  }
}
// arm — начать ждать; условие должно держаться stable с подряд; не дождались за timeout с (0 — вечно) — timeout
function wuStep(st,e,t,o){
  if(e.arm){ st.on=true; st.t0=t; st.since=null; st.ok=0; st.held=0; }
  const r={done:false,timeout:false};
  if(!st.on) return r;
  if(wuTest(e.v,o.op,+o.a,+o.b)){ if(st.since==null) st.since=t; } else st.since=null;
  st.held=st.since==null ? 0 : (t-st.since)/1000;
  if(st.since!=null && t-st.since>=(+o.stable||0)*1000){ st.on=false; st.ok=1; r.done=true; return r; }
  if(+o.timeout>0 && t-st.t0>=o.timeout*1000){ st.on=false; st.ok=0; r.timeout=true; }
  return r;
}
function winNew(){ return {on:false,t0:0,n:0,sum:0,min:Infinity,max:-Infinity,avg:null,ok:0}; }
// arm — начать собирать v; окно window с (или samples отсчётов, если mode 'samples'); по окончании done и avg / min / max / n
function winStep(st,e,t,o){
  if(e.arm){ st.on=true; st.t0=t; st.n=0; st.sum=0; st.min=Infinity; st.max=-Infinity; st.avg=null; st.ok=0; }
  const r={done:false};
  if(!st.on) return r;
  if(typeof e.v==='number' && isFinite(e.v)){ st.n++; st.sum+=e.v; if(e.v<st.min) st.min=e.v; if(e.v>st.max) st.max=e.v; }
  const over=o.mode==='samples' ? st.n>=Math.max(1,+o.samples||1) : t-st.t0>=(+o.window||0)*1000;
  if(over){
    st.on=false; st.ok=st.n>0 ? 1 : 0; st.avg=st.n>0 ? st.sum/st.n : null; r.done=true;
    if(!st.n){ st.min=null; st.max=null; }
  }
  return r;
}
if(typeof module!=='undefined') Object.assign(module.exports,{wuNew,wuTest,wuStep,winNew,winStep});
