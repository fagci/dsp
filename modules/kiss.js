"use strict";
/* ============================ KISS TNC ============================
   Пакетный TNC по KISS: аппаратный (WebSerial) или Direwolf / soundmodem по TCP через мост WebSocket
   (websocat --binary ws-l:127.0.0.1:8001 tcp:127.0.0.1:8001 — у Direwolf порт KISS 8001). Приём — строки TNC2 и записи для карты,
   передача — строка TNC2 на входе, только с флагом «allow transmit». Ядро — aprs-kernels.js. */

function apPush(n,line){                                   // строка TNC2 → очереди выходов
  const p=tnc2Parse(line); if(!p) return;
  n.msgs++; n.q.push(line); n.recQ.push(aprsRecord(p,Date.now()));
  if(n.q.length>5000) n.q.splice(0,n.q.length-5000);
  if(n.recQ.length>20000) n.recQ.splice(0,n.recQ.length-20000);
}
function ksFeed(n,bytes){
  for(const f of n.kp.push(bytes)){
    const a=ax25ToTnc2(f.data);
    if(a) apPush(n,a.tnc2); else n.skipped++;
  }
}
async function ksTeardown(n){
  n.want=false; clearTimeout(n.timer); n.timer=null; n.ok=false;
  const ws=n.ws; n.ws=null;
  if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
  if(n.reader){ try{ await n.reader.cancel(); }catch(e){} n.reader=null; }
  if(n.writer){ try{ n.writer.releaseLock(); }catch(e){} n.writer=null; }
  if(n.port){ try{ await n.port.close(); }catch(e){} n.port=null; }
}
async function ksStop(n){ await ksTeardown(n); n.status='disconnected'; }
async function ksStart(n){
  if(n.connecting) return;
  await ksTeardown(n); n.kp=new KissParser(); n.want=true;
  if(n.p.transport==='WebSocket (KISS TCP bridge)') return ksOpenWs(n);
  if(!navigator.serial){ n.status='WebSerial unavailable (needs Chrome/Edge, HTTPS)'; n.want=false; return; }
  n.connecting=true; n.status='choose a port…';
  try{
    const port=await navigator.serial.requestPort();
    await port.open({baudRate:+n.p.baud||9600});
    n.port=port; n.writer=port.writable.getWriter(); n.ok=true; n.status='connected, '+n.p.baud+' baud';
    ksSerRead(n);
  }catch(e){ n.want=false; n.status=e.name==='NotFoundError' ? 'no port selected' : 'error: '+e.message; }
  n.connecting=false;
}
async function ksSerRead(n){
  const reader=n.port.readable.getReader(); n.reader=reader;
  try{ for(;;){ const {value,done}=await reader.read(); if(done) break; ksFeed(n,value); } }
  catch(e){ n.status='read error: '+e.message; }
  n.ok=false; if(n.reader===reader) n.reader=null;
}
function ksOpenWs(n){
  const url=String(n.p.url||'').trim();
  if(!/^wss?:\/\//i.test(url)){ n.status='URL must start with ws:// or wss://'; n.want=false; return; }
  n.warn=netInsecure(url) ? NET_INSECURE_MSG : '';
  let ws; try{ ws=new WebSocket(url); }catch(e){ n.status='error: '+e.message; return; }
  ws.binaryType='arraybuffer'; n.ws=ws; n.status='connecting…';
  ws.onopen=()=>{ n.ok=true; n.status='connected'; };
  ws.onerror=()=>{ n.status='connection error (is the websocat bridge to the TNC running?)'; };
  ws.onmessage=e=>{ if(e.data instanceof ArrayBuffer) ksFeed(n,new Uint8Array(e.data)); };
  ws.onclose=()=>{
    if(n.ws!==ws) return;
    n.ws=null; n.ok=false; n.status='closed'+(n.p.reconnect ? ' — reconnecting…' : '');
    if(n.want && n.p.reconnect){ clearTimeout(n.timer); n.timer=setTimeout(()=>{ if(n.want) ksOpenWs(n); },3000); }
  };
}
function ksWrite(n,bytes){
  if(n.ws && n.ws.readyState===1){ n.ws.send(bytes); return true; }
  if(n.writer){ n.chain=n.chain.then(()=>n.writer?.write(bytes)).catch(e=>{ n.status='write error: '+e.message; }); return true; }
  return false;
}
def({ id:'kissTnc', title:'KISS TNC', cat:'Protocols', kw:'kiss tnc packet radio ax.25 aprs direwolf soundmodem serial tcp',
  ins:[{n:'text',t:'txt'}],
  outs:[{n:'text',t:'txt'},{n:'rec',t:'rec'},{n:'new',t:'num'},{n:'ok',t:'num'}], readout:true, tall:true,
  params:[{n:'transport',t:'select',opts:['WebSerial','WebSocket (KISS TCP bridge)'],d:'WebSerial'},
          {n:'baud',t:'select',opts:['1200','2400','4800','9600','19200','38400','57600','115200'],d:'9600',label:'serial baud'},
          {n:'url',t:'text',d:'ws://127.0.0.1:8001',label:'bridge to the TNC: ws:// wss://'},
          {n:'port',t:'range',min:0,max:15,step:1,d:0,label:'KISS port (multi-port TNC)'},
          {n:'tx',t:'check',d:false,label:'allow transmit (the TNC sends the TNC2 line of the text wire)'},
          {n:'reconnect',t:'check',d:true,label:'reconnect (WebSocket)'},
          {n:'connect',t:'button',label:'Connect',fn:n=>ksStart(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>ksStop(n)}],
  init:n=>{ n.ws=null; n.port=n.reader=n.writer=null; n.want=false; n.ok=false; n.connecting=false; n.timer=null; n.chain=Promise.resolve();
            n.kp=new KissParser(); n.q=[]; n.recQ=[]; n.msgs=0; n.sent=0; n.skipped=0; n.lastTx=undefined;
            n.last=''; n.status='not connected'; n.warn=''; },
  dispose:n=>ksTeardown(n),
  process(n,I){
    if(typeof I.text==='string' && I.text!==n.lastTx){
      if(!n.p.tx){ if(I.text) n.status=n.ok ? 'connected (transmit is off: tick «allow transmit»)' : n.status; n.lastTx=I.text; }
      else if(!I.text) n.lastTx=I.text;
      else if(n.ok){
        const f=tnc2ToAx25(I.text);
        if(!f){ n.status='not a TNC2 line (CALL>DEST,PATH:info)'; n.lastTx=I.text; }
        else if(ksWrite(n,kissEncode(f,n.p.port))){ n.sent++; n.lastTx=I.text; }
      }
    }
    const t=n.q.length ? n.q.shift() : null; if(t!==null) n.last=t;
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    return {text:t,rec,new:t!==null ? 1 : 0,ok:n.ok ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=(n.warn && !n.ok ? '⚠ '+n.warn+'\n' : '')+n.status+' · frames '+n.msgs+(n.skipped ? ' (skipped '+n.skipped+')' : '')+' · sent '+n.sent+(n.q.length ? ' · queued '+n.q.length : '')+(n.last ? '\n'+n.last.slice(0,300) : '');
    if(r.textContent!==t) r.textContent=t; }
});
