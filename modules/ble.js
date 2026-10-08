"use strict";
/* ============================ Web Bluetooth: узлы ============================
   BLE UART (Nordic UART / HM-10 / свои UUID), BLE GATT (любая характеристика: уведомления или опрос, запись),
   BLE Advertisements (RSSI и данные рекламы выбранного устройства). Ядро — ble-kernels.js.
   Нужны Chrome / Edge / Opera и https (или localhost); Firefox и iOS Web Bluetooth не поддерживают.
   Окно выбора устройства открывается только по клику — кнопка Connect. */

const BLE_NO='Web Bluetooth unavailable (needs Chrome/Edge/Opera on https or localhost; not Firefox / iOS)';
const bleOpts=(n,services)=>{                          // фильтр окна выбора: по имени и службе или любое устройство
  const sv=services.filter(s=>s!==''&&s!=null), pre=String(n.p.name||'').trim();
  if(n.p.any || (!sv.length && !pre)) return {acceptAllDevices:true,optionalServices:sv};
  const f=[]; if(pre) f.push({namePrefix:pre,...(sv.length ? {services:sv} : {})}); else f.push({services:sv});
  return {filters:f,optionalServices:sv};
};
async function bleTeardown(n){
  n.connected=false; n.connecting=false; clearTimeout(n.timer); n.timer=null; clearInterval(n.pollT); n.pollT=null;
  const ch=n.chs||[];
  for(const c of ch){ try{ c.el.removeEventListener('characteristicvaluechanged',n.onVal); if(c.notify) await c.el.stopNotifications(); }catch(e){} }
  n.chs=[];
  const d=n.dev;
  if(d){ d.removeEventListener('gattserverdisconnected',n.onDisc); d.removeEventListener('advertisementreceived',n.onAdv);
    try{ d.gatt && d.gatt.connected && d.gatt.disconnect(); }catch(e){} }
  if(n.abort){ try{ n.abort.abort(); }catch(e){} n.abort=null; }
  n.dev=null;
}
// общий путь: выбрать устройство → GATT → службы / характеристики; n.plan(n) отдаёт {services, setup(n,server)}
async function bleConnect(n,again){
  if(n.connecting) return;
  if(!again) await bleTeardown(n);
  if(!navigator.bluetooth){ n.status=BLE_NO; return; }
  n.connecting=true; n.status=again ? 'reconnecting…' : 'choose a device…';
  try{
    const plan=n.plan(n);
    if(!again) n.dev=await navigator.bluetooth.requestDevice(bleOpts(n,plan.services));
    const d=n.dev; if(!d) throw new Error('no device');
    n.name=d.name||d.id||'device';
    d.removeEventListener('gattserverdisconnected',n.onDisc); d.addEventListener('gattserverdisconnected',n.onDisc);
    n.status='connecting to '+n.name+'…';
    const server=await d.gatt.connect();
    await plan.setup(n,server);
    n.connecting=false; n.connected=true; n.status='connected to '+n.name;
  }catch(e){
    n.connecting=false; n.connected=false;
    n.status=e.name==='NotFoundError' ? (/chosen|cancel/i.test(e.message) ? 'no device selected' : 'not found: '+e.message) : 'error: '+e.message;
    if(again) bleSchedule(n);
  }
}
function bleSchedule(n){ if(n.p.reconnect && n.dev && !n.timer) n.timer=setTimeout(()=>{ n.timer=null; if(n.dev && !n.connected) bleConnect(n,true); },3000); }
const bleOnDisc=n=>()=>{ n.connected=false; n.chs=[]; clearInterval(n.pollT); n.status='disconnected by the device'+(n.p.reconnect ? ' — reconnecting…' : ''); bleSchedule(n); };
function bleDisconnect(n){ n.status='disconnected'; bleTeardown(n); }
async function bleChar(server,svc,chr){ return (await server.getPrimaryService(bleUuid(svc))).getCharacteristic(bleUuid(chr)); }
async function bleWrite(n,el,bytes){
  const size=Math.max(1,+n.p.chunk||20);
  for(const c of bleChunks(bytes,size)){
    if(el.writeValueWithoutResponse && !n.p.ack) await el.writeValueWithoutResponse(c); else await el.writeValue(c);
  }
}

/* ---------- BLE UART ---------- */
def({ id:'bleUart', title:'BLE UART (Web Bluetooth)', cat:'Sources', kw:'bluetooth le ble serial nordic uart nus hm-10 esp32 arduino terminal',
  ins:[{n:'text',t:'txt'},{n:'bin',t:'bin'}], outs:[{n:'line',t:'txt'},{n:'go',t:'num'},{n:'bin',t:'bin'}], readout:true, tall:true,
  params:[{n:'profile',t:'select',opts:[...Object.keys(BLE_PROFILES),'custom'],d:'Nordic UART',label:'profile'},
          {n:'svc',t:'text',d:'',label:'custom: service UUID',adv:true},
          {n:'rx',t:'text',d:'',label:'custom: characteristic from the device (notify)',adv:true},
          {n:'tx',t:'text',d:'',label:'custom: characteristic to the device (write)',adv:true},
          {n:'name',t:'text',d:'',label:'device name starts with (empty — any)'},
          {n:'any',t:'check',d:false,label:'list all devices (ignore the filters)'},
          {n:'eol',t:'select',opts:['none','\\n','\\r','\\r\\n'],d:'\\n',label:'line end when sending'},
          {n:'chunk',t:'range',min:1,max:512,step:1,d:20,label:'bytes per write (20 is safe on any device)'},
          {n:'ack',t:'check',d:false,label:'write with response (slower, reliable)'},
          {n:'reconnect',t:'check',d:true,label:'reconnect'},
          {n:'connect',t:'button',label:'Connect',fn:n=>bleConnect(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>bleDisconnect(n)}],
  init:n=>{ n.dev=null; n.chs=[]; n.connected=n.connecting=false; n.timer=n.pollT=null; n.acc=''; n.q=[]; n.last=''; n.sent=0; n.got=0;
            n.status='not connected'; n.wr=null; n.lastText=undefined; n.chain=Promise.resolve(); n.dec=new TextDecoder();
            n.lastBin=null; n.binQ=[]; n.binOut=null; n.gotB=0;
            n.onDisc=bleOnDisc(n);
            n.onVal=e=>{ n.binQ.push(new Uint8Array(e.target.value.buffer.slice(e.target.value.byteOffset,e.target.value.byteOffset+e.target.value.byteLength))); if(n.binQ.length>4096) n.binQ.splice(0,n.binQ.length-4096); const r=bleLines(n.acc,n.dec.decode(e.target.value,{stream:true})); n.acc=r.rest; for(const l of r.lines){ n.q.push(l); n.got++; } if(n.q.length>2000) n.q.splice(0,n.q.length-2000); };
            n.plan=n=>{
              const pr=BLE_PROFILES[n.p.profile]||{svc:n.p.svc,rx:n.p.rx,tx:n.p.tx};
              return {services:[bleUuid(pr.svc)],setup:async(n,server)=>{
                const rx=await bleChar(server,pr.svc,pr.rx); await rx.startNotifications(); rx.addEventListener('characteristicvaluechanged',n.onVal);
                const tx=pr.tx===pr.rx ? rx : await bleChar(server,pr.svc,pr.tx);
                n.chs=[{el:rx,notify:true}]; n.wr=tx; n.acc=''; } }; }; },
  dispose:n=>{ bleTeardown(n); },
  process(n,I){
    if(typeof I.text==='string' && I.text && I.text!==n.lastText){
      n.lastText=I.text;
      if(n.connected && n.wr){
        const eol={'none':'','\\n':'\n','\\r':'\r','\\r\\n':'\r\n'}[n.p.eol]||'', el=n.wr;
        n.chain=n.chain.then(()=>bleWrite(n,el,new TextEncoder().encode(I.text+eol))).then(()=>{ n.sent++; },e=>{ n.status='write error: '+e.message; });
      }
    } else if(!I.text) n.lastText=undefined;
    if(I.bin && I.bin.d && I.bin!==n.lastBin){
      n.lastBin=I.bin;
      if(n.connected && n.wr){ const el=n.wr, d=I.bin.d;
        n.chain=n.chain.then(()=>bleWrite(n,el,d)).then(()=>{ n.sent++; },e=>{ n.status='write error: '+e.message; }); }
    }
    if(n.binQ.length){ const p=n.binQ.splice(0), d=p.length>1 ? binCat(...p) : p[0]; n.gotB+=d.length; n.binOut=binObj(d); }
    let go=0; if(n.q.length){ n.last=n.q.shift(); go=1; }
    return {line:go ? n.last : (n.last||null),go,bin:n.binOut};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+' · received '+n.got+(n.gotB ? ' ('+n.gotB+' B)' : '')+' · sent '+n.sent+(n.last ? '\n'+n.last.slice(0,300) : '');
    if(r.textContent!==t) r.textContent=t; }
});

/* ---------- BLE GATT ---------- */
def({ id:'bleGatt', title:'BLE GATT (Web Bluetooth)', cat:'Sources', kw:'bluetooth le ble gatt characteristic heart rate battery sensor notify read write temperature',
  ins:[{n:'write',t:'txt'}], outs:[{n:'value',t:'num'},{n:'hex',t:'txt'},{n:'rec',t:'rec'},{n:'new',t:'num'}], readout:true,
  params:[{n:'svc',t:'text',d:'heart_rate',label:'service: name, 16-bit (180D) or 128-bit UUID'},
          {n:'chr',t:'text',d:'heart_rate_measurement',label:'characteristic: name, 16-bit (2A37) or 128-bit UUID'},
          {n:'fmt',t:'select',opts:BLE_FORMATS,d:'heart rate (bpm)',label:'value format'},
          {n:'k',t:'num',d:1,label:'scale'},
          {n:'ofs',t:'num',d:0,label:'offset'},
          {n:'mode',t:'select',opts:['notify','read every period'],d:'notify',label:'get the value'},
          {n:'period',t:'range',min:.2,max:300,step:.1,d:2,label:'read period, s'},
          {n:'wfmt',t:'select',opts:['hex','text'],d:'hex',label:'`write` input is'},
          {n:'ack',t:'check',d:true,label:'write with response'},
          {n:'name',t:'text',d:'',label:'device name starts with (empty — by service)'},
          {n:'any',t:'check',d:false,label:'list all devices (ignore the filters)'},
          {n:'reconnect',t:'check',d:true,label:'reconnect'},
          {n:'connect',t:'button',label:'Connect',fn:n=>bleConnect(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>bleDisconnect(n)}],
  init:n=>{ n.dev=null; n.chs=[]; n.connected=n.connecting=false; n.timer=n.pollT=null; n.q=[]; n.val=0; n.hex=''; n.got=0; n.sent=0;
            n.status='not connected'; n.el_=null; n.lastW=undefined; n.chain=Promise.resolve();
            n.onDisc=bleOnDisc(n);
            n.onVal=e=>{ const r=bleDecode(e.target.value,n.p.fmt); n.q.push(r); n.got++; if(n.q.length>2000) n.q.shift(); };
            n.plan=n=>({services:[bleUuid(n.p.svc)],setup:async(n,server)=>{
              const el=await bleChar(server,n.p.svc,n.p.chr); n.el_=el;
              if(n.p.mode==='notify'){ await el.startNotifications(); el.addEventListener('characteristicvaluechanged',n.onVal); n.chs=[{el,notify:true}]; }
              else { n.chs=[{el,notify:false}]; el.addEventListener('characteristicvaluechanged',n.onVal);
                const rd=async()=>{ try{ n.onVal({target:{value:await el.readValue()}}); }catch(e){ n.status='read error: '+e.message; } };
                rd(); n.pollT=setInterval(rd,Math.max(200,(+n.p.period||2)*1000)); } }}); },
  dispose:n=>{ bleTeardown(n); },
  process(n,I){
    if(typeof I.write==='string' && I.write && I.write!==n.lastW){
      n.lastW=I.write;
      const b=n.p.wfmt==='text' ? new TextEncoder().encode(I.write) : bleParseHex(I.write), el=n.el_;
      if(n.connected && el && b) n.chain=n.chain.then(()=>n.p.ack ? el.writeValue(b) : (el.writeValueWithoutResponse||el.writeValue).call(el,b)).then(()=>{ n.sent++; },e=>{ n.status='write error: '+e.message; });
      else if(!b) n.status='bad hex in write';
    } else if(!I.write) n.lastW=undefined;
    let nw=0, rec=null;
    if(n.q.length){
      rec=[]; const t=Date.now();
      for(const r of n.q.splice(0)){
        if(r.value!==null) n.val=r.value*(+n.p.k||0)+(+n.p.ofs||0);
        n.hex=r.hex; nw=1;
        rec.push({t,...(r.value!==null ? {value:n.val} : {}),hex:r.hex});
      }
    }
    return {value:n.val,hex:n.hex||null,rec,new:nw};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+' · values '+n.got+(n.sent ? ' · written '+n.sent : '')+(n.hex ? '\n'+(Math.round(n.val*1e4)/1e4)+'  ['+n.hex.slice(0,80)+']' : '');
    if(r.textContent!==t) r.textContent=t; }
});

/* ---------- BLE Advertisements ---------- */
// RSSI и данные рекламы одного выбранного устройства (watchAdvertisements): близость, поиск маячка, термометры без подключения.
def({ id:'bleAdv', title:'BLE Advertisements (Web Bluetooth)', cat:'Sources', kw:'bluetooth le ble rssi beacon advertisement proximity find tracker',
  outs:[{n:'rssi',t:'num'},{n:'tx',t:'num'},{n:'present',t:'num'},{n:'mfr',t:'txt'},{n:'rec',t:'rec'},{n:'new',t:'num'}], readout:true,
  params:[{n:'name',t:'text',d:'',label:'device name starts with (empty — any)'},
          {n:'avg',t:'range',min:0,max:.95,step:.01,d:.5,label:'RSSI smoothing (0 — raw)'},
          {n:'lost',t:'range',min:1,max:120,step:1,d:15,label:'absent after silence of, s'},
          {n:'connect',t:'button',label:'Choose device',fn:n=>bleAdvStart(n)},
          {n:'disconnect',t:'button',label:'Stop',fn:n=>bleAdvStop(n)}],
  init:n=>{ n.dev=null; n.abort=null; n.q=[]; n.rssi=-120; n.sm=null; n.tx=0; n.seen=0; n.mfr=''; n.count=0; n.status='not started'; n.watching=false;
            n.onAdv=e=>{
              const r=typeof e.rssi==='number' ? e.rssi : null; if(r===null) return;
              const a=+n.p.avg||0; n.sm=n.sm===null || Date.now()-n.seen>(+n.p.lost||15)*1000 ? r : n.sm*a+r*(1-a);
              n.rssi=n.sm; n.tx=typeof e.txPower==='number' ? e.txPower : n.tx; n.seen=Date.now(); n.count++;
              let mfr=''; if(e.manufacturerData && e.manufacturerData.size){ for(const [id,dv] of e.manufacturerData){ mfr=id.toString(16).padStart(4,'0')+': '+bleHex(dv); break; } }
              n.mfr=mfr||n.mfr; n.name=e.name||(e.device&&e.device.name)||n.name||'';
              n.q.push({t:Date.now(),rssi:r,tx:typeof e.txPower==='number' ? e.txPower : undefined,name:n.name,mfr:mfr||undefined}); if(n.q.length>2000) n.q.shift(); }; },
  dispose:n=>{ bleAdvStop(n); },
  process(n){
    const present=n.seen && Date.now()-n.seen<(+n.p.lost||15)*1000 ? 1 : 0;
    const rec=n.q.length ? n.q.splice(0) : null;
    return {rssi:present ? n.rssi : -120,tx:n.tx,present,mfr:n.mfr||null,rec,new:rec ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+(n.count ? ' · packets '+n.count+(n.name ? ' · '+n.name : '')+'\nRSSI '+Math.round(n.rssi)+' dBm'+(n.mfr ? ' · '+n.mfr.slice(0,60) : '') : '');
    if(r.textContent!==t) r.textContent=t; }
});
function bleAdvStop(n){
  n.status='stopped'; n.watching=false;
  const d=n.dev; n.dev=null;
  if(d){ d.removeEventListener('advertisementreceived',n.onAdv); }
  if(n.abort){ try{ n.abort.abort(); }catch(e){} n.abort=null; }
}
async function bleAdvStart(n){
  bleAdvStop(n);
  if(!navigator.bluetooth){ n.status=BLE_NO; return; }
  n.status='choose a device…';
  try{
    const pre=String(n.p.name||'').trim();
    const d=await navigator.bluetooth.requestDevice(pre ? {filters:[{namePrefix:pre}]} : {acceptAllDevices:true});
    if(typeof d.watchAdvertisements!=='function'){ n.status='watchAdvertisements is not supported here (Chrome: chrome://flags/#enable-experimental-web-platform-features)'; return; }
    n.dev=d; n.name=d.name||''; n.sm=null; n.count=0;
    d.addEventListener('advertisementreceived',n.onAdv);
    n.abort=new AbortController();
    await d.watchAdvertisements({signal:n.abort.signal});
    n.watching=true; n.status='listening to '+(d.name||d.id||'device');
  }catch(e){
    n.status=e.name==='NotFoundError' ? 'no device selected' : 'error: '+e.message;
  }
}
