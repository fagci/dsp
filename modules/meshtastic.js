"use strict";
/* ============================ Meshtastic ============================
   Клиент ноды Meshtastic по её API: BLE (общая обвязка bleConnect из ble.js) или WebSerial (кадры 0x94 0xC3 + длина).
   Радио и шифрование остаются на ноде: сообщения приходят уже расшифрованными ключами её каналов.
   Ядро (protobuf, разбор) — meshtastic-kernels.js. */

async function mshSerialTeardown(n){
  n.connected=false; n.connecting=false;
  if(n.reader){ try{ await n.reader.cancel(); }catch(e){} try{ n.reader.releaseLock(); }catch(e){} n.reader=null; }
  if(n.writer){ try{ n.writer.releaseLock(); }catch(e){} n.writer=null; }
  if(n.port){ try{ await n.port.close(); }catch(e){} n.port=null; }
}
async function mshTeardown(n){ await bleTeardown(n); await mshSerialTeardown(n); n.toEl=null; n.ready=false; }
async function mshConnect(n){
  if(n.p.transport==='Serial') return mshSerialConnect(n);
  return bleConnect(n);
}
async function mshSerialConnect(n){
  if(n.connecting) return;
  await mshTeardown(n);
  if(!navigator.serial){ n.status='WebSerial unavailable (needs Chrome/Edge, HTTPS)'; return; }
  n.connecting=true; n.status='choose a port…';
  try{
    const port=await navigator.serial.requestPort();
    await port.open({baudRate:+n.p.baud||115200,bufferSize:65536});
    n.port=port; n.writer=port.writable.getWriter(); n.frames=mshFrameStream();
    n.connecting=false; n.connected=true; n.status='connected, loading config…';
    mshSerialRead(n);
    await n.writer.write(new Uint8Array(32).fill(0xC3));        // будим ноду, как делает клиент на Python
    await n.writer.write(mshFrameWrap(mshWantConfig(++n.cfgId)));
  }catch(e){
    n.connecting=false;
    n.status=e.name==='NotFoundError' ? 'no port selected' : 'error: '+e.message;
    await mshSerialTeardown(n);
  }
}
async function mshSerialRead(n){
  const reader=n.port.readable.getReader(); n.reader=reader;
  try{
    while(n.connected){
      const {value,done}=await reader.read();
      if(done) break;
      if(value) for(const f of mshFramePush(n.frames,value)) mshFrame(n,f);
    }
    if(n.connected){ n.status='port closed by device'; mshSerialTeardown(n); }
  }catch(e){
    if(n.connected){ n.status='read error: '+e.message; mshSerialTeardown(n); }
  }
}
// BLE: читаем fromRadio, пока не придёт пустое значение
async function mshDrain(n){
  if(n.draining){ n.again=true; return; }
  n.draining=true;
  try{
    do{
      n.again=false;
      for(let i=0;i<2000 && n.toEl && n.fromEl;i++){
        const v=await n.fromEl.readValue();
        if(!v.byteLength) break;
        mshFrame(n,new Uint8Array(v.buffer,v.byteOffset,v.byteLength));
      }
    }while(n.again);
  }catch(e){ n.status='read error: '+e.message; }
  n.draining=false;
}
function mshSend(n,payload){
  n.chain=n.chain.then(()=>{
    if(n.p.transport==='Serial') return n.writer && n.writer.write(mshFrameWrap(payload));
    return n.toEl && n.toEl.writeValue(payload);
  }).then(()=>{ n.sent++; },e=>{ n.status='write error: '+e.message; });
}

function mshFrame(n,bytes){
  let r; try{ r=mshFromRadio(bytes); }catch(e){ n.bad++; return; }
  const now=Date.now();
  if(r.kind==='myinfo') n.me=r.num;
  else if(r.kind==='complete'){ n.ready=true; n.status='connected to '+(n.name||'node')+' · '+n.nodes.size+' nodes'; }
  else if(r.kind==='node'){
    const x=r.node, u=mshNodeUpdate(n,x.num,x);
    n.rq.push(mshClean({t:now,kind:'node',...mshWho(n,x.num),snr:x.snr,heard:x.heard,lat:u.lat,lon:u.lon,alt:u.alt,battery:u.battery}));
  } else if(r.kind==='packet'){
    const p=r.pkt, d=p.data; n.got++;
    if(!d){ n.rq.push(mshClean({t:now,kind:'encrypted',...mshWho(n,p.from),to:mshNodeId(p.to),snr:p.snr,rssi:p.rssi})); return; }
    const upd={}; for(const k of ['lat','lon','alt','battery','voltage','temp','hum','press','uptime','chUtil','airUtil']) if(d[k]!==undefined) upd[k]=d[k];
    if(d.user) { upd.user=d.user; }
    if(p.snr!==undefined) upd.snr=p.snr;
    const u=mshNodeUpdate(n,p.from,upd);
    const rec=mshClean({t:now,kind:d.portName,...mshWho(n,p.from),to:p.to===MSH_BROADCAST?'all':mshNodeId(p.to),ch:p.channel,snr:p.snr,rssi:p.rssi,hop:p.hop,
      text:d.text,lat:u.lat,lon:u.lon,alt:d.alt,battery:d.battery,voltage:d.voltage,temp:d.temp,hum:d.hum,press:d.press,uptime:d.uptime,chUtil:d.chUtil,airUtil:d.airUtil});
    n.rq.push(rec);
    if(d.port===1){ n.tq.push({text:d.text,from:rec.name||rec.id,snr:p.snr}); if(n.tq.length>500) n.tq.shift(); }
  }
  if(n.rq.length>3000) n.rq.splice(0,n.rq.length-3000);
}
function mshNodeUpdate(n,num,x){
  const o=n.nodes.get(num)||{num};
  for(const k in x) if(x[k]!==undefined && k!=='num') o[k]=x[k];
  n.nodes.set(num,o);
  return o;
}
function mshWho(n,num){
  const o=n.nodes.get(num);
  return {id:mshNodeId(num),name:o&&o.user ? (o.user.long||o.user.short) : undefined};
}
const mshClean=o=>{ for(const k in o) if(o[k]===undefined) delete o[k]; return o; };

def({ id:'meshtastic', title:'Meshtastic (BLE / Serial)', cat:'Sources', kw:'meshtastic lora mesh node chat text position telemetry bluetooth serial heltec t-beam rak',
  ins:[{n:'text',t:'txt'}], outs:[{n:'text',t:'txt'},{n:'from',t:'txt'},{n:'go',t:'num'},{n:'snr',t:'num'},{n:'rec',t:'rec'},{n:'new',t:'num'}], readout:true, tall:true,
  params:[{n:'transport',t:'select',opts:['BLE','Serial'],d:'BLE',label:'link to the node'},
          {n:'baud',t:'num',d:115200,label:'Serial: baud rate',adv:true},
          {n:'dest',t:'text',d:'^all',label:'send to: ^all or a node id (!a1b2c3d4)'},
          {n:'ch',t:'range',min:0,max:7,step:1,d:0,label:'send on channel index'},
          {n:'name',t:'text',d:'Meshtastic',label:'BLE: device name starts with (empty — by service)'},
          {n:'any',t:'check',d:false,label:'BLE: list all devices (ignore the filters)'},
          {n:'reconnect',t:'check',d:true,label:'BLE: reconnect'},
          {n:'connect',t:'button',label:'Connect',fn:n=>mshConnect(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>{ n.status='disconnected'; mshTeardown(n); }}],
  init:n=>{ n.dev=null; n.chs=[]; n.connected=n.connecting=false; n.timer=n.pollT=null; n.status='not connected';
            n.nodes=new Map(); n.rq=[]; n.tq=[]; n.got=0; n.sent=0; n.bad=0; n.me=null; n.ready=false; n.cfgId=1;
            n.lastText=undefined; n.chain=Promise.resolve(); n.last=null; n.snr=0;
            n.toEl=n.fromEl=null; n.port=n.reader=n.writer=null; n.draining=false; n.again=false;
            n.onDisc=bleOnDisc(n);
            n.plan=n=>({services:[MSH_BLE.svc],setup:async(n,server)=>{
              const svc=await server.getPrimaryService(MSH_BLE.svc);
              n.toEl=await svc.getCharacteristic(MSH_BLE.toRadio); n.fromEl=await svc.getCharacteristic(MSH_BLE.fromRadio);
              const num=await svc.getCharacteristic(MSH_BLE.fromNum);
              n.onVal=()=>mshDrain(n);
              await num.startNotifications(); num.addEventListener('characteristicvaluechanged',n.onVal);
              n.chs=[{el:num,notify:true}]; n.nodes.clear(); n.ready=false;
              await n.toEl.writeValue(mshWantConfig(++n.cfgId));
              mshDrain(n); }}); },
  dispose:n=>{ mshTeardown(n); },
  process(n,I){
    if(typeof I.text==='string' && I.text && I.text!==n.lastText){
      n.lastText=I.text;
      const to=mshParseNode(n.p.dest);
      if(to===null) n.status='bad destination: '+n.p.dest;
      else if(n.connected && (n.toEl || n.writer)) mshSend(n,mshTextPacket(I.text,to,+n.p.ch||0,(Math.random()*0xFFFFFFFF)>>>0));
    } else if(!I.text) n.lastText=undefined;
    let go=0; if(n.tq.length){ n.last=n.tq.shift(); go=1; n.snr=n.last.snr||0; }
    const rec=n.rq.length ? n.rq.splice(0) : null;
    return {text:n.last?n.last.text:null,from:n.last?n.last.from:null,go,snr:n.snr,rec,new:rec?1:0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+' · packets '+n.got+' · sent '+n.sent+(n.bad ? ' · bad '+n.bad : '')+' · nodes '+n.nodes.size+
      (n.last ? '\n'+(n.last.from||'?')+': '+String(n.last.text).slice(0,300) : '');
    if(r.textContent!==t) r.textContent=t; }
});
