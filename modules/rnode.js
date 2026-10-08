"use strict";
/* ============================ RNode (LoRa-модем по KISS) ============================
   Плата с прошивкой RNode по WebSerial или BLE (Nordic UART, общая обвязка bleConnect из ble.js): настройка радио,
   приём и передача сырых LoRa-кадров, RSSI / SNR, при желании пассивный разбор пакетов Reticulum (заголовок и announce).
   Ядро — rnode-kernels.js. */

async function rnSerialTeardown(n){
  n.connected=false; n.connecting=false;
  if(n.reader){ try{ await n.reader.cancel(); }catch(e){} try{ n.reader.releaseLock(); }catch(e){} n.reader=null; }
  if(n.writer){ try{ n.writer.releaseLock(); }catch(e){} n.writer=null; }
  if(n.port){ try{ await n.port.close(); }catch(e){} n.port=null; }
}
async function rnTeardown(n){ await bleTeardown(n); await rnSerialTeardown(n); n.wr=null; n.cfgKey=''; }
function rnConnect(n){ return n.p.transport==='Serial' ? rnSerialConnect(n) : bleConnect(n); }
async function rnSerialConnect(n){
  if(n.connecting) return;
  await rnTeardown(n);
  if(!navigator.serial){ n.status='WebSerial unavailable (needs Chrome/Edge, HTTPS)'; return; }
  n.connecting=true; n.status='choose a port…';
  try{
    const port=await navigator.serial.requestPort();
    await port.open({baudRate:+n.p.baud||115200,bufferSize:65536});
    n.port=port; n.writer=port.writable.getWriter(); n.kiss=rnStream();
    n.connecting=false; n.connected=true; n.status='connected, detecting…'; n.cfgKey='';
    rnSerialRead(n);
    rnWrite(n,rnDetect());
  }catch(e){
    n.connecting=false;
    n.status=e.name==='NotFoundError' ? 'no port selected' : 'error: '+e.message;
    await rnSerialTeardown(n);
  }
}
async function rnSerialRead(n){
  const reader=n.port.readable.getReader(); n.reader=reader;
  try{
    while(n.connected){
      const {value,done}=await reader.read();
      if(done) break;
      if(value) rnBytes(n,value);
    }
    if(n.connected){ n.status='port closed by device'; rnSerialTeardown(n); }
  }catch(e){
    if(n.connected){ n.status='read error: '+e.message; rnSerialTeardown(n); }
  }
}
function rnWrite(n,bytes){
  n.chain=n.chain.then(()=>{
    if(n.p.transport==='Serial') return n.writer && n.writer.write(bytes);
    return n.wr && bleWrite(n,n.wr,bytes);
  }).catch(e=>{ n.status='write error: '+e.message; });
}
function rnBytes(n,bytes){
  for(const f of rnPush(n.kiss,bytes)){
    const ev=rnEvent(f);
    if(ev.data) rnFrame(n,ev.data);
    else{
      if(ev.rssi!==undefined) n.pRssi=ev.rssi;
      if(ev.snr!==undefined) n.pSnr=ev.snr;
      if(ev.err) n.status='RNode: '+ev.err;
      Object.assign(n.rep,ev);
      if(ev.detected===false) n.status='no RNode answered (wrong port or firmware)';
    }
  }
}
function rnFrame(n,d){
  n.rx++;
  const hex=Array.from(d,x=>x.toString(16).padStart(2,'0')).join('');
  const rec={t:Date.now(),kind:'lora',len:d.length,rssi:n.pRssi,snr:n.pSnr,hex};
  if(n.p.rns){
    let p=null; try{ p=rnsParse(d); }catch(e){}
    if(p){
      rec.kind='rns '+p.typeName; rec.hops=p.hops; rec.dest=p.dest; rec.destType=p.destName; if(p.ifac) rec.ifac=true;
      if(p.contextName && p.packetType!==1) rec.context=p.contextName;
      const a=p.packetType===1 ? rnsAnnounce(p) : null;
      if(a){ rec.kind='rns announce'; rec.name=a.name||undefined; rec.appName=a.appName; rec.announced=a.time; rec.ratchet=a.ratchet; rec.appData=a.appDataHex||undefined;
        n.peers.set(a.dest,{t:rec.t,name:a.name,appName:a.appName,rssi:n.pRssi}); }
    }
  }
  for(const k in rec) if(rec[k]===undefined) delete rec[k];
  n.rq.push(rec); if(n.rq.length>3000) n.rq.shift();
  n.hq.push({hex,rssi:n.pRssi,snr:n.pSnr}); if(n.hq.length>500) n.hq.shift();
  n.pRssi=n.pSnr=undefined;
}
function rnCfg(n,I){
  const f=I.freq!=null && I.freq>0 ? +I.freq : (+n.p.freq||867.2)*1e6;
  return {freq:Math.round(f),bw:Math.round((+n.p.bw||125)*1000),txp:+n.p.txp||0,sf:+n.p.sf||8,cr:+n.p.cr||5};
}

def({ id:'rnode', title:'RNode LoRa Modem (KISS) / Reticulum', cat:'Sources', kw:'rnode reticulum lora kiss modem rns lxmf nomadnet sideband announce mesh heltec t-beam rak',
  ins:[{n:'send',t:'txt'},{n:'freq',t:'num'}], outs:[{n:'hex',t:'txt'},{n:'go',t:'num'},{n:'rssi',t:'num'},{n:'snr',t:'num'},{n:'noise',t:'num'},{n:'rec',t:'rec'},{n:'new',t:'num'}],
  readout:true, tall:true,
  params:[{n:'transport',t:'select',opts:['Serial','BLE'],d:'Serial',label:'link to the RNode'},
          {n:'baud',t:'num',d:115200,label:'Serial: baud rate',adv:true},
          {n:'freq',t:'num',d:867.2,label:'frequency, MHz (a wire on `freq`, in Hz, overrides)'},
          {n:'bw',t:'num',d:125,label:'bandwidth, kHz (7.8 … 500)'},
          {n:'sf',t:'range',min:5,max:12,step:1,d:8,label:'spreading factor'},
          {n:'cr',t:'range',min:5,max:8,step:1,d:5,label:'coding rate 4/x'},
          {n:'txp',t:'range',min:0,max:22,step:1,d:7,label:'TX power, dBm (keep within your local limits)'},
          {n:'rns',t:'check',d:true,label:'parse Reticulum packets (header, announces)'},
          {n:'sendfmt',t:'select',opts:['hex','text'],d:'hex',label:'`send` input is'},
          {n:'name',t:'text',d:'RNode',label:'BLE: device name starts with (empty — by service)'},
          {n:'any',t:'check',d:false,label:'BLE: list all devices (ignore the filters)'},
          {n:'chunk',t:'range',min:1,max:512,step:1,d:20,label:'BLE: bytes per write',adv:true},
          {n:'ack',t:'check',d:false,label:'BLE: write with response',adv:true},
          {n:'reconnect',t:'check',d:true,label:'BLE: reconnect'},
          {n:'connect',t:'button',label:'Connect',fn:n=>rnConnect(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>{ n.status='disconnected'; rnTeardown(n); }}],
  init:n=>{ n.dev=null; n.chs=[]; n.connected=n.connecting=false; n.timer=n.pollT=null; n.status='not connected';
            n.rq=[]; n.hq=[]; n.rx=0; n.tx=0; n.rep={}; n.peers=new Map(); n.pRssi=n.pSnr=undefined; n.lastSend=undefined;
            n.chain=Promise.resolve(); n.cfgKey=''; n.cfgAt=0; n.last=null; n.rssi=-157; n.snr=0;
            n.kiss=rnStream(); n.wr=null; n.port=n.reader=n.writer=null;
            n.onDisc=bleOnDisc(n);
            n.onVal=e=>rnBytes(n,new Uint8Array(e.target.value.buffer,e.target.value.byteOffset,e.target.value.byteLength));
            n.plan=n=>{
              const pr=BLE_PROFILES['Nordic UART'];
              return {services:[pr.svc],setup:async(n,server)=>{
                const rx=await bleChar(server,pr.svc,pr.rx); await rx.startNotifications(); rx.addEventListener('characteristicvaluechanged',n.onVal);
                n.wr=await bleChar(server,pr.svc,pr.tx); n.chs=[{el:rx,notify:true}]; n.kiss=rnStream(); n.cfgKey='';
                rnWrite(n,rnDetect()); } }; }; },
  dispose:n=>{ rnTeardown(n); },
  process(n,I){
    const cfg=rnCfg(n,I), key=JSON.stringify(cfg), now=Date.now();
    if(n.connected && key!==n.cfgKey && now-n.cfgAt>400){                // новые настройки уходят в радио сразу, но не чаще раза в 0,4 с
      n.cfgKey=key; n.cfgAt=now; for(const f of rnConfig(cfg)) rnWrite(n,f);
    }
    if(typeof I.send==='string' && I.send && I.send!==n.lastSend){
      n.lastSend=I.send;
      const b=n.p.sendfmt==='text' ? new TextEncoder().encode(I.send) : bleParseHex(I.send);
      if(!b) n.status='bad hex in send';
      else if(b.length>508) n.status='frame longer than 508 bytes';
      else if(n.connected){ rnWrite(n,rnData(b)); n.tx++; }
    } else if(!I.send) n.lastSend=undefined;
    let go=0; if(n.hq.length){ n.last=n.hq.shift(); go=1; if(n.last.rssi!==undefined) n.rssi=n.last.rssi; if(n.last.snr!==undefined) n.snr=n.last.snr; }
    const rec=n.rq.length ? n.rq.splice(0) : null;
    return {hex:n.last?n.last.hex:null,go,rssi:n.rssi,snr:n.snr,noise:n.rep.noise!==undefined ? n.rep.noise : -157,rec,new:rec?1:0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const s=n.rep, t=n.status+(n.rep.fw ? ' · fw '+s.fw+(s.platform ? ' '+s.platform : '') : '')+
      (s.freq ? '\n'+(s.freq/1e6).toFixed(3)+' MHz · BW '+(s.bw/1000)+' kHz · SF'+s.sf+' · CR 4/'+s.cr+' · '+s.txp+' dBm · radio '+(s.on ? 'on' : 'off') : '')+
      '\nrx '+n.rx+' · tx '+n.tx+(n.p.rns ? ' · RNS peers '+n.peers.size : '')+(s.noise!==undefined ? ' · noise '+s.noise+' dBm' : '')+
      (s.battery!==undefined ? ' · batt '+s.battery+'%' : '')+(s.temp!==undefined ? ' · '+s.temp+'°C' : '')+
      (n.last ? '\nlast: '+n.last.hex.slice(0,60)+' ('+(n.last.rssi!==undefined ? n.last.rssi+' dBm' : '')+')' : '');
    if(r.textContent!==t) r.textContent=t; }
});
