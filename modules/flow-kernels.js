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
