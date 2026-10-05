"use strict";
/* ============================ SSE In ============================
   Server-Sent Events (text/event-stream) через fetch: заголовки, свой переподключатель, отмена. Разбор — net-kernels.js.
   Сервер должен отдавать CORS-заголовки; со страницы по https http:// чужих хостов блокируется. */

function ssStop(n){
  n.want=false; clearTimeout(n.timer); n.timer=null; n.ok=false;
  if(n.abort){ try{ n.abort.abort(); }catch(e){} n.abort=null; }
  n.status='stopped';
}
function ssStart(n){
  ssStop(n);
  const url=String(n.p.url||'').trim();
  if(!/^https?:\/\//i.test(url)){ n.status='URL must start with http:// or https://'; return; }
  n.warn=netInsecure(url) ? NET_INSECURE_MSG : '';
  n.want=true; n.lastId=''; ssRun(n,url);
}
function ssRetry(n,url,ms){ if(n.want && n.p.reconnect){ clearTimeout(n.timer); n.timer=setTimeout(()=>{ if(n.want) ssRun(n,url); },ms); } }
async function ssRun(n,url){
  const ac=new AbortController(); n.abort=ac; n.status='connecting…';
  const h={Accept:'text/event-stream',...netHeaders(n.p.headers)};
  if(n.lastId && n.p.resume) h['Last-Event-ID']=n.lastId;   // нестандартный заголовок → CORS preflight, у части серверов он не обработан
  let wait=3000;
  try{
    const r=await fetch(url,{headers:h,cache:'no-store',signal:ac.signal});
    if(!r.ok){ n.status='HTTP '+r.status+' '+r.statusText+(n.p.reconnect ? ' — retrying…' : ''); n.ok=false; if(r.status>=400 && r.status<500 && r.status!==408 && r.status!==429){ n.want=false; n.status='HTTP '+r.status+' '+r.statusText; } }
    else if(!r.body){ n.status='the browser gives no stream body'; n.want=false; }
    else{
      n.ok=true; n.status='connected';
      const rd=r.body.getReader(), dec=new TextDecoder(), ps=new SseParser();
      for(;;){
        const {done,value}=await rd.read(); if(done) break;
        for(const e of ps.push(dec.decode(value,{stream:true}))) ssEvent(n,e);
        if(ps.id) n.lastId=ps.id;
        if(ps.retry!==null) wait=Math.min(60000,Math.max(500,ps.retry));
      }
      n.ok=false; n.status='stream ended'+(n.p.reconnect ? ' — reconnecting…' : '');
    }
  }catch(e){
    n.ok=false;
    if(e.name==='AbortError') return;
    n.status='failed: '+e.message+(e instanceof TypeError ? ' (no CORS headers on the server, blocked, or mixed content)' : '')+(n.p.reconnect ? ' — reconnecting…' : '');
  }
  if(n.abort===ac) n.abort=null;
  ssRetry(n,url,wait);
}
function ssEvent(n,e){
  const want=String(n.p.events||'').split(/[\s,]+/).filter(Boolean);
  if(want.length && !want.includes(e.event)) return;
  const m=netParse(e.data,n.p.field,n.p.records,Date.now(),{event:e.event});
  n.msgs++; m.event=e.event;
  n.q.push(m); n.recQ.push(...m.rec);
  if(n.q.length>5000) n.q.splice(0,n.q.length-5000);
  if(n.recQ.length>20000) n.recQ.splice(0,n.recQ.length-20000);
}
def({ id:'sseIn', title:'SSE In', cat:'Sources', kw:'sse server-sent events eventsource stream push http json live',
  outs:[{n:'text',t:'txt'},{n:'event',t:'txt'},{n:'value',t:'num'},{n:'rec',t:'rec'},{n:'new',t:'num'},{n:'ok',t:'num'}], readout:true, tall:true,
  params:[{n:'url',t:'text',d:'https://stream.wikimedia.org/v2/stream/recentchange',label:'http:// https://'},
          {n:'events',t:'text',d:'',label:'event names to take (space or comma; empty — all)'},
          {n:'field',t:'text',d:'length.new',label:'JSON field for the value output (a.b.0.c)'},
          {n:'records',t:'text',d:'',label:'JSON path to an object / array for rec (empty — the root)'},
          {n:'headers',t:'text',d:'',label:'headers (Name: value; Name: value)'},
          {n:'reconnect',t:'check',d:true,label:'reconnect'},
          {n:'resume',t:'check',d:false,label:'resume with Last-Event-ID (the server must answer the CORS preflight)'},
          {n:'start',t:'button',label:'Start',fn:n=>ssStart(n)},
          {n:'stop',t:'button',label:'Stop',fn:n=>ssStop(n)}],
  init:n=>{ n.want=false; n.timer=null; n.abort=null; n.q=[]; n.recQ=[]; n.msgs=0; n.ok=false; n.lastId='';
            n.last={text:'',event:'',val:0}; n.status='stopped'; n.warn=''; },
  dispose:n=>ssStop(n),
  process(n){
    const m=n.q.length ? n.q.shift() : null;
    if(m) n.last={text:m.text,event:m.event,val:m.val!==null ? m.val : n.last.val};
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    return {text:m ? m.text : null, event:m ? m.event : null, value:n.last.val, rec, new:m ? 1 : 0, ok:n.ok ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=(n.warn && !n.ok ? '⚠ '+n.warn+'\n' : '')+n.status+' · events '+n.msgs+(n.q.length ? ' · queued '+n.q.length : '')+
      (n.last.text ? '\n'+n.last.event+': '+n.last.text.slice(0,300) : '');
    if(r.textContent!==t) r.textContent=t; }
});
