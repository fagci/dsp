"use strict";
/* ============================ Телеметрия дрона (WebSerial) ============================
   MAVLink v1/v2, CRSF, MSP, LTM из последовательного порта полётного контроллера, радиомодема телеметрии или приёмника
   (ELRS / Crossfire → UART). Разбор — telemetry-kernels.js. Узел можно кормить и без железа: вход text — байты в hex. */

const TLM_BAUDS=['9600','19200','38400','57600','115200','230400','400000','420000','921600','1000000'];
const TLM_OUTS=['lat','lon','alt','az','el','roll','speed','volts','amps','rssi','lq','sats','batt'];
const TLM_MSP_POLL=[108,106,110,109];                       // ATTITUDE, RAW_GPS, ANALOG, ALTITUDE

async function tlmTeardown(n){
  n.connected=false; n.connecting=false; clearInterval(n.pollT); n.pollT=null;
  if(n.reader){ try{ await n.reader.cancel(); }catch(e){} try{ n.reader.releaseLock(); }catch(e){} n.reader=null; }
  if(n.writer){ try{ n.writer.releaseLock(); }catch(e){} n.writer=null; }
  if(n.port){ try{ await n.port.close(); }catch(e){} n.port=null; }
}
async function tlmConnect(n){
  if(n.connecting) return;
  await tlmTeardown(n);
  if(!navigator.serial){ n.status='WebSerial unavailable (needs Chrome/Edge, HTTPS)'; return; }
  n.connecting=true; n.status='choose a port…';
  try{
    const port=await navigator.serial.requestPort();
    await port.open({baudRate:+n.p.baud||115200, bufferSize:65536});
    n.port=port; n.writer=port.writable.getWriter(); n.connecting=false; n.connected=true; n.status='connected';
    n.pollT=setInterval(()=>tlmPoll(n),200);
    tlmReadLoop(n);
  }catch(e){
    n.connecting=false;
    n.status=e.name==='NotFoundError' ? 'no port selected' : 'error: '+e.message;
    await tlmTeardown(n);
  }
}
async function tlmReadLoop(n){
  const reader=n.port.readable.getReader(); n.reader=reader;
  try{
    while(n.connected){
      const {value,done}=await reader.read();
      if(done) break;
      if(value) tlmFeed(n,value);
    }
    if(n.connected){ n.status='port closed by device'; tlmTeardown(n); }
  }catch(e){
    if(n.connected){ n.status='read error: '+e.message; tlmTeardown(n); }
  }
}
// MSP ничего не шлёт сам — запрашиваем (v1: $M< размер команда XOR)
function tlmPoll(n){
  if(!n.connected || !n.writer || !n.p.poll || (n.p.proto!=='auto' && n.p.proto!=='MSP')) return;
  const f=[];
  for(const c of TLM_MSP_POLL) f.push(0x24,0x4D,0x3C,0,c,c);
  n.writer.write(new Uint8Array(f)).catch(()=>{});
}
function tlmFeed(n,bytes){
  const protos=n.p.proto==='auto' ? Object.keys(TLM_PARSERS) : [n.p.proto];
  for(const m of tlmPush(n.st,bytes,protos)){ tlmApply(n.s,m); n.msgs++; n.dirty=true; }
}
function tlmHex(s){
  const h=String(s).replace(/0x/gi,'').replace(/[^0-9a-f]/gi,'');
  const b=new Uint8Array(h.length>>1);
  for(let i=0;i<b.length;i++) b[i]=parseInt(h.substr(i*2,2),16);
  return b;
}

def({ id:'telem', lazy:'manual', title:'Telemetry (MAVLink / CRSF / MSP / LTM)', cat:'Sources', kw:'drone uav telemetry mavlink crsf msp ltm betaflight inav ardupilot px4 elrs crossfire serial hud osd',
  ins:[{n:'text',t:'txt'}],
  outs:[{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'alt',t:'num'},{n:'az',t:'num'},{n:'el',t:'num'},{n:'roll',t:'num'},
        {n:'speed',t:'num'},{n:'volts',t:'num'},{n:'amps',t:'num'},{n:'rssi',t:'num'},{n:'lq',t:'num'},{n:'sats',t:'num'},{n:'batt',t:'num'},
        {n:'rec',t:'rec'},{n:'mode',t:'txt'}],
  readout:true, tall:true, w:420, resize:true,
  params:[{n:'connect',t:'button',label:'Connect port',fn:n=>tlmConnect(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>{ n.status='disconnected'; tlmTeardown(n); }},
          {n:'baud',t:'select',opts:TLM_BAUDS,d:'115200',label:'baud (MAVLink 57600 / 115200, MSP 115200, CRSF 420000, LTM 2400–19200)'},
          {n:'proto',t:'select',opts:['auto',...Object.keys(TLM_PARSERS)],d:'auto',label:'protocol (auto: all four at once, a frame counts only with a valid checksum)'},
          {n:'poll',t:'check',d:true,label:'MSP: ask for attitude, GPS, battery and altitude (MSP only answers requests)'},
          {n:'id',t:'text',d:'uav',label:'name on the map'},
          {n:'clr',t:'button',label:'Reset',fn:n=>{ n.s={}; n.st=tlmStream(); n.msgs=0; }}],
  init:n=>{
    n.s={}; n.st=tlmStream(); n.msgs=0; n.dirty=false; n.lastText=null; n.lastRecT=0;
    n.port=null; n.reader=null; n.writer=null; n.connected=false; n.connecting=false; n.pollT=null; n.status='not connected';
  },
  dispose:n=>{ tlmTeardown(n).catch(e=>console.error('telem dispose:',e)); },
  process(n,I){
    if(typeof I.text==='string' && I.text!==n.lastText){ n.lastText=I.text; tlmFeed(n,tlmHex(I.text)); }
    const s=n.s, out={};
    for(const k of TLM_OUTS) out[k]=s[k]!=null ? s[k] : null;
    out.az=s.hdg!=null ? s.hdg : null; out.el=s.pitch!=null ? s.pitch : null;
    out.mode=s.mode!=null ? String(s.mode) : null;
    out.rec=null;
    if(n.dirty && s.lat!=null){
      n.dirty=false;
      out.rec={t:s.t, id:n.p.id||'uav', label:(n.p.id||'uav')+(s.armed ? ' ▲' : ''), lat:s.lat, lon:s.lon, icon:'plane', color:'#ff8a3d', src:s.proto,
        ...(s.alt!=null ? {alt_m:s.alt} : {}), ...(s.hdg!=null ? {heading:s.hdg} : {}), ...(s.speed!=null ? {speed:s.speed} : {})};
    }
    return out;
  },
  drawKey:n=>n.status+'|'+n.msgs+'|'+Math.floor(Date.now()/500),
  draw(n){
    const el=n.el.querySelector('.readout'); if(!el) return;
    const s=n.s, f=(v,d=1,u='')=>v!=null ? v.toFixed(d)+u : '–';
    const cnt=Object.entries(n.st.count).map(([k,v])=>k+' '+v).join(' · ');
    const rows=[n.status+' · '+(s.proto||'no frames')+(cnt ? '  ('+cnt+')' : '')+(s.armed!=null ? (s.armed ? ' · ARMED' : ' · disarmed') : '')+(s.mode!=null ? ' · mode '+s.mode : ''),
      'pos '+(s.lat!=null ? s.lat.toFixed(6)+', '+s.lon.toFixed(6) : '–')+' · alt '+f(s.alt,0,' m')+(s.ralt!=null ? ' (rel '+f(s.ralt,0)+')' : '')+' · sats '+(s.sats!=null ? s.sats : '–'),
      'hdg '+f(s.hdg,0,'°')+' · pitch '+f(s.pitch,1,'°')+' · roll '+f(s.roll,1,'°')+' · speed '+f(s.speed,1,' m/s'),
      'batt '+f(s.volts,2,' V')+' '+f(s.amps,1,' A')+(s.batt!=null ? ' '+s.batt+'%' : '')+' · link rssi '+f(s.rssi,0)+(s.lq!=null ? ' lq '+s.lq+'%' : '')+(s.snr!=null ? ' snr '+s.snr : ''),
      s.t ? 'last frame '+Math.round((Date.now()-s.t)/1000)+' s ago' : ''];
    const t=rows.filter(Boolean).join('\n'); if(el.textContent!==t) el.textContent=t;
  }});
