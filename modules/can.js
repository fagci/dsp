"use strict";
/* ============================ CAN (SLCAN) и OBD-II ============================
   CAN: адаптер SLCAN / Lawicel (CANable, USBtin, CANUSB…) по WebSerial; кадры наружу строкой «123#DEADBEEF», внутрь — тем же видом.
   По умолчанию шина только слушается (listen-only): ничего не отправляется, пока не выбран обычный режим и не стоит «allow transmit».
   OBD-II: запрашивает PID режима 01 по кругу и разбирает ответы; с CAN-узлом соединяется проводами text. Ядро — can-kernels.js. */

async function cnTeardown(n){
  n.want=false; n.ok=false;
  if(n.reader){ try{ await n.reader.cancel(); }catch(e){} n.reader=null; }
  if(n.writer){ try{ if(n.opened) await n.writer.write(new TextEncoder().encode('C\r')); }catch(e){} try{ n.writer.releaseLock(); }catch(e){} n.writer=null; }
  if(n.port){ try{ await n.port.close(); }catch(e){} n.port=null; }
  n.opened=false;
}
async function cnStop(n){ await cnTeardown(n); n.status='disconnected'; }
function cnWrite(n,s){
  if(!n.writer) return false;
  const data=new TextEncoder().encode(s);
  n.chain=n.chain.then(()=>n.writer?.write(data)).catch(e=>{ n.status='write error: '+e.message; });
  return true;
}
async function cnStart(n){
  if(n.connecting) return;
  await cnTeardown(n);
  if(!navigator.serial){ n.status='WebSerial unavailable (needs Chrome/Edge, HTTPS)'; return; }
  n.connecting=true; n.status='choose a port…';
  try{
    const port=await navigator.serial.requestPort();
    await port.open({baudRate:+n.p.baud||115200});
    n.port=port; n.writer=port.writable.getWriter(); n.sp=new SlcanParser(); n.want=true;
    cnWrite(n,'C\r'+SLCAN_RATES[n.p.bitrate]+'\r'+(n.p.mode==='listen-only' ? 'L' : 'O')+'\r');
    n.opened=true; n.ok=true; n.status='open, '+n.p.bitrate+'bit/s, '+n.p.mode;
    cnRead(n);
  }catch(e){ n.status=e.name==='NotFoundError' ? 'no port selected' : 'error: '+e.message; }
  n.connecting=false;
}
async function cnRead(n){
  const reader=n.port.readable.pipeThrough(new TextDecoderStream('latin1')).getReader(); n.reader=reader;
  try{
    for(;;){
      const {value,done}=await reader.read(); if(done) break;
      for(const o of n.sp.push(value)){
        if(o.err){ n.errs++; continue; }
        const f=slcanParse(o.line); if(f) cnFrame(n,f);
      }
    }
  }catch(e){ n.status='read error: '+e.message; }
  n.ok=false; if(n.reader===reader) n.reader=null;
}
function cnFilter(n){
  const s=String(n.p.ids||'').trim(); if(!s) return null;
  return new Set(s.split(/[\s,]+/).filter(Boolean).map(x=>parseInt(x,16)));
}
function cnFrame(n,f){
  const flt=cnFilter(n); if(flt && !flt.has(f.id)) return;
  const text=canFormat(f);
  n.msgs++; n.q.push(text);
  n.recQ.push({t:Date.now(),can_id:f.id.toString(16).toUpperCase(),ext:f.ext ? 1 : 0,dlc:f.rtr ? f.dlc : f.data.length,data:f.rtr ? '' : canHex(f.data)});
  if(n.q.length>5000) n.q.splice(0,n.q.length-5000);
  if(n.recQ.length>20000) n.recQ.splice(0,n.recQ.length-20000);
}
def({ id:'canSlcan', title:'CAN (SLCAN)', cat:'Protocols', kw:'can bus slcan lawicel canable usbtin obd candump cansend automotive can-fd',
  ins:[{n:'text',t:'txt'}],
  outs:[{n:'text',t:'txt'},{n:'rec',t:'rec'},{n:'new',t:'num'},{n:'ok',t:'num'}], readout:true, tall:true,
  params:[{n:'baud',t:'select',opts:['115200','230400','460800','921600','1000000','2000000'],d:'115200',label:'serial baud (USB adapters usually ignore it)'},
          {n:'bitrate',t:'select',opts:Object.keys(SLCAN_RATES),d:'500k',label:'CAN bit rate'},
          {n:'mode',t:'select',opts:['listen-only','normal'],d:'listen-only',label:'mode (listen-only never sends)'},
          {n:'ids',t:'text',d:'',label:'only these ids (hex, space / comma; empty — all)'},
          {n:'tx',t:'check',d:false,label:'allow transmit (normal mode: the text wire goes onto the bus)'},
          {n:'connect',t:'button',label:'Connect',fn:n=>cnStart(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>cnStop(n)}],
  init:n=>{ n.port=n.reader=n.writer=null; n.want=false; n.ok=false; n.opened=false; n.connecting=false; n.chain=Promise.resolve();
            n.sp=new SlcanParser(); n.q=[]; n.recQ=[]; n.msgs=0; n.sent=0; n.errs=0; n.lastTx=undefined; n.last=''; n.status='not connected'; },
  dispose:n=>cnTeardown(n),
  process(n,I){
    if(typeof I.text!=='string') n.lastTx=undefined;          // событие: то же сообщение снова после паузы — снова кадр
    else if(I.text!==n.lastTx){
      n.lastTx=I.text;
      if(I.text.trim() && n.p.tx && n.ok){
        const f=canParse(I.text);
        if(!f) n.status='not a frame (ID#DATA, like 123#DEADBEEF)';
        else if(n.p.mode!=='normal') n.status='listen-only: switch the mode to normal and reconnect to send';
        else if(cnWrite(n,slcanEncode(f))) n.sent++;
      }
    }
    const t=n.q.length ? n.q.shift() : null; if(t!==null) n.last=t;
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    return {text:t,rec,new:t!==null ? 1 : 0,ok:n.ok ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+' · frames '+n.msgs+' · sent '+n.sent+(n.errs ? ' · adapter errors '+n.errs : '')+(n.q.length ? ' · queued '+n.q.length : '')+(n.last ? '\n'+n.last : '');
    if(r.textContent!==t) r.textContent=t; }
});

/* ---------- OBD-II ---------- */
const OBD_OUTS=['rpm','speed','coolant','throttle','load'];
def({ id:'obd2', title:'OBD-II', cat:'Protocols', kw:'obd obd2 obd-ii car vehicle ecu pid rpm speed coolant diagnostic can',
  ins:[{n:'text',t:'txt'}],
  outs:[{n:'text',t:'txt'},{n:'rec',t:'rec'},{n:'rpm',t:'num'},{n:'speed',t:'num'},{n:'coolant',t:'num'},{n:'throttle',t:'num'},{n:'load',t:'num'},{n:'new',t:'num'}],
  readout:true, tall:true,
  params:[{n:'pids',t:'text',d:'0C 0D 05 11 04',label:'PIDs of mode 01, hex (0C rpm, 0D speed, 05 coolant, 11 throttle, 04 load, 2F fuel, 42 voltage…)'},
          {n:'period',t:'range',min:.05,max:5,step:.05,d:.2,label:'one request every, s'},
          {n:'run',t:'check',d:true,label:'ask (off — only decode what comes)'}],
  init:n=>{ n.t=0; n.k=0; n.vals={}; n.cnt=0; n.last=''; n.status='waiting for CAN frames'; },
  process(n,I){
    let req=null;
    if(n.p.run){
      n.t+=BLOCK/Eng.sr;
      if(n.t>=n.p.period){ n.t=0; const l=obdPids(n.p.pids); if(l.length){ n.k=(n.k+1)%l.length; req=canFormat(obdRequest(l[n.k])); } }
    }
    const rec=[]; let nw=0;
    if(typeof I.text==='string' && I.text){
      for(const line of I.text.split(/\n/)){
        const f=canParse(line.replace(/^\S+\s+(?=[0-9A-Fa-f]+#)/,'')); const r=f && obdDecode(f); if(!r) continue;   // «can0 7E8#…» от candump тоже
        n.vals[r.name]=r.value; n.cnt++; nw=1; n.last=r.name+' = '+r.value+' '+r.unit; n.status='answers '+n.cnt;
        rec.push({t:Date.now(),pid:r.pid.toString(16).toUpperCase().padStart(2,'0'),name:r.name,value:r.value,unit:r.unit,ecu:r.ecu});
      }
    }
    const o={text:req,rec:rec.length ? rec : null,new:nw};
    for(const k of OBD_OUTS) o[k]=n.vals[k]!==undefined ? n.vals[k] : 0;
    return o;
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+'\n'+Object.keys(n.vals).map(k=>k+' '+n.vals[k]).join(' · ');
    if(r.textContent!==t) r.textContent=t; }
});
