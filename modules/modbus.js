"use strict";
/* ============================ Modbus master ============================
   Опрос регистров / катушек и запись: RTU по WebSerial (RS-485 / RS-232 адаптер) или TCP через мост WebSocket
   (websocat --binary ws-l:127.0.0.1:5020 tcp:plc:502). Один запрос в полёте; записи идут вне очереди чтения. Ядро — modbus-kernels.js. */

const MB_FN={'holding 03':3,'input 04':4,'coils 01':1,'discrete 02':2};
async function mdTeardown(n){
  n.want=false; n.ok=false; clearInterval(n.pollT); clearTimeout(n.waitT); n.pollT=n.waitT=null; n.wait=null; n.queue=[];
  const ws=n.ws; n.ws=null;
  if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
  if(n.reader){ try{ await n.reader.cancel(); }catch(e){} n.reader=null; }
  if(n.writer){ try{ n.writer.releaseLock(); }catch(e){} n.writer=null; }
  if(n.port){ try{ await n.port.close(); }catch(e){} n.port=null; }
}
async function mdStop(n){ await mdTeardown(n); n.status='disconnected'; }
async function mdStart(n){
  if(n.connecting) return;
  await mdTeardown(n); n.rtu=new MbRtuParser(); n.tcp=new MbTcpParser(); n.tid=0; n.want=true;
  if(n.p.transport==='WebSocket TCP (bridge)') return mdOpenWs(n);
  if(!navigator.serial){ n.status='WebSerial unavailable (needs Chrome/Edge, HTTPS)'; n.want=false; return; }
  n.connecting=true; n.status='choose a port…';
  try{
    const port=await navigator.serial.requestPort();
    await port.open({baudRate:+n.p.baud||9600,parity:n.p.parity,dataBits:8,stopBits:n.p.parity==='none' ? 2 : 1});
    n.port=port; n.writer=port.writable.getWriter(); n.ok=true; n.status='connected, '+n.p.baud+' baud '+n.p.parity;
    mdRead(n); mdPollStart(n);
  }catch(e){ n.want=false; n.status=e.name==='NotFoundError' ? 'no port selected' : 'error: '+e.message; }
  n.connecting=false;
}
async function mdRead(n){
  const reader=n.port.readable.getReader(); n.reader=reader;
  try{ for(;;){ const {value,done}=await reader.read(); if(done) break; mdFeed(n,value); } }
  catch(e){ n.status='read error: '+e.message; }
  n.ok=false; if(n.reader===reader) n.reader=null;
}
function mdOpenWs(n){
  const url=String(n.p.url||'').trim();
  if(!/^wss?:\/\//i.test(url)){ n.status='URL must start with ws:// or wss://'; n.want=false; return; }
  n.warn=netInsecure(url) ? NET_INSECURE_MSG : '';
  let ws; try{ ws=new WebSocket(url); }catch(e){ n.status='error: '+e.message; return; }
  ws.binaryType='arraybuffer'; n.ws=ws; n.status='connecting…';
  ws.onopen=()=>{ n.ok=true; n.status='connected'; mdPollStart(n); };
  ws.onerror=()=>{ n.status='connection error (is the websocat bridge to the device running?)'; };
  ws.onmessage=e=>{ if(e.data instanceof ArrayBuffer) mdFeed(n,new Uint8Array(e.data)); };
  ws.onclose=()=>{ if(n.ws!==ws) return; n.ws=null; n.ok=false; clearInterval(n.pollT); n.status='closed'; };
}
function mdPollStart(n){ clearInterval(n.pollT); n.pollT=setInterval(()=>mdPoll(n),Math.max(.1,n.p.period)*1000); mdPoll(n); }
function mdPoll(n){
  if(!n.ok || n.wait || n.queue.some(q=>q.kind==='read')) return;
  n.queue.push({kind:'read',unit:n.p.unit|0,fc:MB_FN[n.p.fn],addr:n.p.addr|0,arg:n.p.count|0}); mdPump(n);
}
function mdPump(n){
  if(n.wait || !n.queue.length || !n.ok) return;
  const q=n.queue.shift(), pdu=mbPdu(q.fc,q.addr,q.arg);
  const bytes=n.ws ? mbTcpFrame(q.tid=(++n.tid)&0xFFFF,q.unit,pdu) : mbRtuFrame(q.unit,pdu);
  n.wait=q;
  if(n.ws) n.ws.send(bytes); else n.chain=n.chain.then(()=>n.writer?.write(bytes)).catch(e=>{ n.status='write error: '+e.message; });
  n.waitT=setTimeout(()=>{ if(n.wait===q){ n.wait=null; n.errs++; n.status='no answer from unit '+q.unit; mdPump(n); } },Math.max(200,+n.p.timeout*1000||1000));
}
function mdFeed(n,bytes){
  const frames=n.ws ? n.tcp.push(bytes) : n.rtu.push(bytes);
  for(const f of frames){
    const q=n.wait; if(!q || f.unit!==q.unit || (n.ws && f.tid!==q.tid)) continue;
    const r=mbPduParse(f.pdu); if(!r || r.fc!==q.fc) continue;
    clearTimeout(n.waitT); n.wait=null;
    if(r.exc!==undefined){ n.errs++; n.status='exception '+r.exc+': '+(MB_EXC[r.exc]||'?')+' (unit '+q.unit+', fn '+q.fc+', addr '+q.addr+')'; }
    else if(q.kind==='write'){ n.wrote++; n.status='written '+r.addr+' = '+r.val; }
    else mdValues(n,q,r);
    mdPump(n);
  }
}
function mdValues(n,q,r){
  const t=Date.now(), sc=+n.p.scale; const k=isFinite(sc) && sc!==0 ? sc : 1;
  let vals, step=1, raw=null;
  if(q.fc<=2) vals=mbBits(r.bytes,q.arg);
  else{
    raw=mbRegs(r.bytes); vals=mbDecodeRegs(raw,n.p.type,n.p.low);
    step=(n.p.type==='u32' || n.p.type==='i32' || n.p.type==='f32') ? 2 : 1;
    vals=vals.map(v=>Math.round(v*k*1e6)/1e6);
  }
  n.polls++; n.vals=vals; n.q.push(vals);
  vals.forEach((v,i)=>n.recQ.push({t,unit:q.unit,addr:q.addr+i*step,value:v}));
  if(n.q.length>2000) n.q.splice(0,n.q.length-2000);
  if(n.recQ.length>20000) n.recQ.splice(0,n.recQ.length-20000);
  n.status='ok: unit '+q.unit+' '+n.p.fn+' @'+q.addr;
}
def({ id:'modbusM', title:'Modbus Master', cat:'Protocols', kw:'modbus rtu tcp plc rs485 rs-485 industrial register coil holding input sensor meter energy',
  ins:[{n:'write',t:'num'}],
  outs:[{n:'value',t:'num'},{n:'text',t:'txt'},{n:'rec',t:'rec'},{n:'new',t:'num'},{n:'ok',t:'num'},{n:'errors',t:'num'}], readout:true, tall:true,
  params:[{n:'transport',t:'select',opts:['WebSerial RTU','WebSocket TCP (bridge)'],d:'WebSerial RTU'},
          {n:'baud',t:'select',opts:['1200','2400','4800','9600','19200','38400','57600','115200'],d:'9600'},
          {n:'parity',t:'select',opts:['none','even','odd'],d:'none',label:'parity (none → 2 stop bits, as the standard says)'},
          {n:'url',t:'text',d:'ws://127.0.0.1:5020',label:'bridge to Modbus TCP: ws:// wss://'},
          {n:'unit',t:'range',min:0,max:247,step:1,d:1,label:'unit (slave) address'},
          {n:'fn',t:'select',opts:Object.keys(MB_FN),d:'holding 03',label:'read'},
          {n:'addr',t:'range',min:0,max:65535,step:1,d:0,label:'start address (0-based, as on the wire)'},
          {n:'count',t:'range',min:1,max:64,step:1,d:2,label:'count'},
          {n:'type',t:'select',opts:['u16','i16','u32','i32','f32'],d:'u16',label:'registers as'},
          {n:'low',t:'check',d:false,label:'low word first (32-bit: CD AB)'},
          {n:'scale',t:'text',d:'1',label:'multiply values by'},
          {n:'period',t:'range',min:.1,max:60,step:.1,d:1,label:'poll period, s'},
          {n:'timeout',t:'range',min:.2,max:5,step:.1,d:1,label:'answer timeout, s'},
          {n:'wen',t:'check',d:false,label:'allow writing (the write input changes the device!)'},
          {n:'wkind',t:'select',opts:['holding register','coil'],d:'holding register',label:'write as'},
          {n:'waddr',t:'range',min:0,max:65535,step:1,d:0,label:'write address'},
          {n:'connect',t:'button',label:'Connect',fn:n=>mdStart(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>mdStop(n)}],
  init:n=>{ n.ws=null; n.port=n.reader=n.writer=null; n.want=false; n.ok=false; n.connecting=false; n.pollT=n.waitT=null; n.chain=Promise.resolve();
            n.rtu=new MbRtuParser(); n.tcp=new MbTcpParser(); n.tid=0; n.queue=[]; n.wait=null; n.q=[]; n.recQ=[]; n.vals=[]; n.val=0;
            n.polls=0; n.wrote=0; n.errs=0; n.lastW=undefined; n.status='not connected'; n.warn=''; },
  dispose:n=>mdTeardown(n),
  process(n,I){
    if(typeof I.write==='number' && isFinite(I.write) && I.write!==n.lastW){
      if(!n.p.wen){ n.lastW=I.write; }
      else if(n.ok){
        const coil=n.p.wkind==='coil';
        n.queue.unshift({kind:'write',unit:n.p.unit|0,fc:coil ? 5 : 6,addr:n.p.waddr|0,arg:coil ? (I.write>.5 ? 1 : 0) : mbEncodeValue(I.write,n.p.type)[0]});
        n.lastW=I.write; mdPump(n);
      }
    }
    const v=n.q.length ? n.q.shift() : null;
    if(v){ n.text=v.join(' '); if(v.length) n.val=v[0]; }
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    return {value:n.val,text:v ? n.text : null,rec,new:v ? 1 : 0,ok:n.ok ? 1 : 0,errors:n.errs};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=(n.warn && !n.ok ? '⚠ '+n.warn+'\n' : '')+n.status+' · polls '+n.polls+(n.wrote ? ' · written '+n.wrote : '')+(n.errs ? ' · errors '+n.errs : '')+(n.vals.length ? '\n'+n.vals.slice(0,12).join('  ')+(n.vals.length>12 ? ' …' : '') : '');
    if(r.textContent!==t) r.textContent=t; }
});
