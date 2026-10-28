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
