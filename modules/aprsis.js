"use strict";
/* ============================ APRS-IS ============================
   Клиент APRS-IS (интернет-сеть APRS). Сервер говорит по TCP (порт 14580), браузер TCP не открывает — нужен мост WebSocket:
   websocat --text ws-l:127.0.0.1:14580 tcp:rotate.aprs2.net:14580. Строки сервера — TNC2; «# …» — служебные. Ядро — aprs-kernels.js. */

function aiStop(n){
  n.want=false; clearTimeout(n.timer); clearInterval(n.keepT); n.timer=n.keepT=null;
  const ws=n.ws; n.ws=null; n.ok=false;
  if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
  n.status='disconnected';
}
function aiStart(n){
  aiStop(n);
  const url=String(n.p.url||'').trim(), call=String(n.p.call||'').trim().toUpperCase();
  if(!/^wss?:\/\//i.test(url)){ n.status='URL must start with ws:// or wss://'; return; }
  if(!/^[A-Z0-9]{1,6}(-\d{1,2})?$/.test(call)){ n.status='enter your callsign (like N0CALL or N0CALL-5)'; return; }
  n.warn=netInsecure(url) ? NET_INSECURE_MSG : '';
  n.want=true; aiOpen(n,url);
}
function aiLogin(n){
  const call=String(n.p.call).trim().toUpperCase(), ps=String(n.p.pass).trim();
  const pass=ps==='' ? '-1' : ps.toLowerCase()==='auto' ? String(aprsPasscode(call)) : ps;
  const f=String(n.p.filter||'').trim();
  n.canSend=pass!=='-1'; n.ws.send('user '+call+' pass '+pass+' vers dsp 1'+(f ? ' filter '+f : '')+'\r\n');
}
function aiOpen(n,url){
  let ws; try{ ws=new WebSocket(url); }catch(e){ n.status='error: '+e.message; return; }
  n.ws=ws; n.status='connecting…'; n.buf='';
  ws.onopen=()=>{ n.ok=true; n.status='connected, logging in…'; aiLogin(n);
    clearInterval(n.keepT); n.keepT=setInterval(()=>{ if(n.ws && n.ws.readyState===1) n.ws.send('#keepalive\r\n'); },60000); };
  ws.onerror=()=>{ n.status='connection error (is the websocat bridge to an APRS-IS server running?)'; };
  ws.onclose=()=>{
    if(n.ws!==ws) return;
    n.ws=null; n.ok=false; clearInterval(n.keepT); n.status='closed'+(n.p.reconnect ? ' — reconnecting…' : '');
    if(n.want && n.p.reconnect){ clearTimeout(n.timer); n.timer=setTimeout(()=>{ if(n.want) aiOpen(n,url); },5000); }
  };
  ws.onmessage=e=>{
    if(typeof e.data!=='string') return;
    n.buf+=e.data; let i;
    while((i=n.buf.indexOf('\n'))>=0){ const l=n.buf.slice(0,i).replace(/\r$/,''); n.buf=n.buf.slice(i+1); aiLine(n,l); }
    if(n.buf.length>20000) n.buf='';
  };
}
function aiLine(n,l){
  if(!l) return;
  if(l[0]==='#'){
    const m=/logresp\s+(\S+)\s+(verified|unverified)/i.exec(l);
    if(m){ n.status=m[2].toLowerCase()==='verified' ? 'connected as '+m[1]+' (verified)' : 'connected as '+m[1]+' (receive only)'; n.canSend=n.canSend && /^verified/i.test(m[2]); }
    return;
  }
  if(tnc2Parse(l)) apPush(n,l);
}
def({ id:'aprsIs', title:'APRS-IS', cat:'Protocols', kw:'aprs internet aprs-is igate packet radio tracker map position client',
  ins:[{n:'text',t:'txt'}],
  outs:[{n:'text',t:'txt'},{n:'rec',t:'rec'},{n:'new',t:'num'},{n:'ok',t:'num'}], readout:true, tall:true,
  params:[{n:'url',t:'text',d:'ws://127.0.0.1:14580',label:'bridge to an APRS-IS server: ws:// wss://'},
          {n:'call',t:'text',d:'',label:'your callsign (login)'},
          {n:'pass',t:'text',d:'',label:'passcode (empty — receive only; auto — computed from the callsign)'},
          {n:'filter',t:'text',d:'r/55.0/83.0/200',label:'server filter (r/lat/lon/km, b/call*, t/p …)'},
          {n:'send',t:'check',d:false,label:'allow sending the text wire to APRS-IS (needs a passcode)'},
          {n:'reconnect',t:'check',d:true,label:'reconnect'},
          {n:'connect',t:'button',label:'Connect',fn:n=>aiStart(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>aiStop(n)}],
  init:n=>{ n.ws=null; n.want=false; n.ok=false; n.timer=n.keepT=null; n.buf=''; n.q=[]; n.recQ=[]; n.msgs=0; n.sent=0; n.canSend=false; n.lastTx=undefined;
            n.last=''; n.status='not connected'; n.warn=''; },
  dispose:n=>aiStop(n),
  process(n,I){
    if(typeof I.text==='string' && I.text!==n.lastTx){
      if(!I.text || !n.p.send) n.lastTx=I.text;
      else if(n.ok && n.canSend){
        if(!tnc2Parse(I.text)) n.status='not a TNC2 line (CALL>DEST,PATH:info)';
        else if(n.ws.readyState===1){ n.ws.send(I.text.replace(/[\r\n]+$/,'')+'\r\n'); n.sent++; }
        n.lastTx=I.text;
      }
    }
    const t=n.q.length ? n.q.shift() : null; if(t!==null) n.last=t;
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    return {text:t,rec,new:t!==null ? 1 : 0,ok:n.ok ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=(n.warn && !n.ok ? '⚠ '+n.warn+'\n' : '')+n.status+' · packets '+n.msgs+' · sent '+n.sent+(n.q.length ? ' · queued '+n.q.length : '')+(n.last ? '\n'+n.last.slice(0,300) : '');
    if(r.textContent!==t) r.textContent=t; }
});
