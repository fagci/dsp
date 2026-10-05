"use strict";
/* ============================ HTTP In ============================
   Опрос HTTP-адреса по таймеру: тело ответа → текст, число из JSON, записи. Разбор — net-kernels.js.
   Сервер должен отдавать CORS-заголовки, со страницы по https http:// чужих хостов блокируется. */

function hiStop(n){
  n.want=false; clearTimeout(n.timer); n.timer=null;
  if(n.abort){ try{ n.abort.abort(); }catch(e){} n.abort=null; }
  n.status='stopped';
}
function hiStart(n){
  hiStop(n);
  const url=String(n.p.url||'').trim();
  if(!/^https?:\/\//i.test(url)){ n.status='URL must start with http:// or https://'; return; }
  n.warn=netInsecure(url) ? NET_INSECURE_MSG : '';
  n.want=true; hiPoll(n);
}
async function hiPoll(n){
  if(!n.want) return;
  const url=String(n.p.url||'').trim(), post=n.p.method==='POST';
  const ac=new AbortController(); n.abort=ac;
  const to=setTimeout(()=>ac.abort(),Math.max(5000,n.p.period*1000));
  try{
    const r=await fetch(url,{method:n.p.method,headers:netHeaders(n.p.headers),body:post ? String(n.p.body||'') : undefined,cache:'no-store',signal:ac.signal});
    const text=await r.text();
    n.code=r.status; n.ok=r.ok;
    n.status='HTTP '+r.status+(r.ok ? '' : ' '+r.statusText);
    if(r.ok || n.p.errors){
      const m=netParse(text,n.p.field,n.p.records,Date.now(),{url});
      n.polls++; n.q.push(m); n.recQ.push(...m.rec);
      if(n.q.length>200) n.q.splice(0,n.q.length-200);
      if(n.recQ.length>20000) n.recQ.splice(0,n.recQ.length-20000);
    }
  }catch(e){
    n.ok=false;
    n.status=e.name==='AbortError' ? (n.want ? 'timeout' : 'stopped')
      : 'failed: '+e.message+(e instanceof TypeError ? ' (no CORS headers on the server, blocked, or mixed content)' : '');
  }
  clearTimeout(to); n.abort=null;
  if(n.want){ clearTimeout(n.timer); n.timer=setTimeout(()=>hiPoll(n),Math.max(.2,n.p.period)*1000); }
}
def({ id:'httpIn', title:'HTTP In', cat:'Sources', kw:'http rest api json poll fetch get url web weather sensor',
  outs:[{n:'text',t:'txt'},{n:'value',t:'num'},{n:'rec',t:'rec'},{n:'new',t:'num'},{n:'ok',t:'num'}], readout:true, tall:true,
  params:[{n:'url',t:'text',d:'https://api.open-meteo.com/v1/forecast?latitude=55&longitude=83&current=temperature_2m',label:'http:// https://'},
          {n:'method',t:'select',opts:['GET','POST'],d:'GET'},
          {n:'body',t:'text',d:'',label:'POST body'},
          {n:'period',t:'range',min:.5,max:3600,step:.5,d:30,label:'poll period, s'},
          {n:'field',t:'text',d:'current.temperature_2m',label:'JSON field for the value output (a.b.0.c; empty — the body, if it is a number)'},
          {n:'records',t:'text',d:'',label:'JSON path to an object / array for rec (empty — the root)'},
          {n:'headers',t:'text',d:'',label:'headers (Name: value; Name: value)'},
          {n:'errors',t:'check',d:false,label:'also take the body of error answers'},
          {n:'start',t:'button',label:'Start',fn:n=>hiStart(n)},
          {n:'stop',t:'button',label:'Stop',fn:n=>hiStop(n)}],
  init:n=>{ n.want=false; n.timer=null; n.abort=null; n.q=[]; n.recQ=[]; n.polls=0; n.ok=false; n.code=0;
            n.last={text:'',val:0}; n.status='stopped'; n.warn=''; },
  dispose:n=>hiStop(n),
  process(n){
    const m=n.q.length ? n.q.shift() : null;
    if(m) n.last={text:m.text,val:m.val!==null ? m.val : n.last.val};
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    return {text:m ? m.text : null, value:n.last.val, rec, new:m ? 1 : 0, ok:n.ok ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=(n.warn && !n.ok ? '⚠ '+n.warn+'\n' : '')+n.status+' · answers '+n.polls+(n.last.text ? '\n'+n.last.text.slice(0,300) : '');
    if(r.textContent!==t) r.textContent=t; }
});
