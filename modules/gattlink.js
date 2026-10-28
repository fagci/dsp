"use strict";
/* ============================ BLE GATT / Bluetooth (DSP app) ============================
   Всё, чего нет в Web Bluetooth: подключение к любому адресу без диалога выбора устройства, полный список служб и характеристик,
   чтение / запись / подписка по UUID, MTU, PHY, приоритет соединения, сопряжение (bond), классический Bluetooth (RFCOMM / SPP —
   клиент и сервер), BLE-реклама (телефон как маячок). Команды и записи — tools/android/README.md (gatt.*, bt.*, ble.adv.*).
   Нужен доверенный клиент (страница приложения, либо «Let any page use actions» в Settings приложения) — см. phoneact.js.
   Сборка команд и разбор значений — modules/phonelink-kernels.js (без DOM, tools/test-phonelink.mjs). */

function gattStop(n){
  n.want=false; clearTimeout(n.timer); n.timer=null;
  const ws=n.ws; n.ws=null;
  if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
  n.status='disconnected';
}
function gattStart(n){
  gattStop(n);
  let key=''; try{ key=(window.DspApp && DspApp.appKey && DspApp.appKey()) || ''; }catch(e){}
  const url=phoneUrl(n.p.url,key);
  if(!url){ n.status='URL must start with ws:// or wss://'; return; }
  n.want=true; n.warn=netInsecure(url) ? NET_INSECURE_MSG : '';
  let ws;
  try{ ws=new WebSocket(url); }catch(e){ n.status='error: '+e.message; return; }
  n.ws=ws; n.status='connecting…'; n.sentSub=null;
  ws.onopen=()=>{ n.status='connected'; gattSub(n); for(const c of n.pend.splice(0)) gattSend(n,c); };
  ws.onerror=()=>{ n.status='connection error — is the DSP app running?'; };
  ws.onclose=e=>{
    if(n.ws!==ws) return;
    n.ws=null; n.status='closed'+(e.code!==1000 ? ' ('+e.code+')' : '')+(n.p.reconnect ? ' — reconnecting…' : '');
    if(n.want && n.p.reconnect){ clearTimeout(n.timer); n.timer=setTimeout(()=>{ if(n.want) gattStart(n); },3000); }
  };
  ws.onmessage=e=>{
    if(typeof e.data!=='string') return;
    let j; try{ j=JSON.parse(e.data); }catch(x){ return; }
    for(const r of Array.isArray(j) ? j : [j]) gattFeed(n,r);
  };
}
function gattSub(n){
  const m=JSON.stringify({sub:['gatt','gattsrv','btlink','l2cap','blesync']});
  if(n.ws && n.ws.readyState===1 && m!==n.sentSub){ n.sentSub=m; n.ws.send(m); }
}
function gattSend(n,cmd){
  if(!cmd) return;
  if(!n.ws || n.ws.readyState!==1){ n.pend.push(cmd); if(n.pend.length>20) n.pend.shift(); if(!n.ws) gattStart(n); return; }
  n.ws.send(JSON.stringify({...cmd,id:++n.seq}));
}
function gattFeed(n,r){
  if(!r || typeof r!=='object') return;
  n.count++;
  if(r.src==='bridge'){ if(r.level==='error' || r.level==='warn') n.bridgeMsg=r.msg; return; }
  const line=plLine(r); if(line) n.last=line;
  if(r.src==='cmd'){ n.ok=r.ok?1:0; if(!r.ok && r.msg) n.last=(r.cmd||'')+': '+r.msg; }
  const svc=String(n.p.svc||'').trim().toLowerCase(), chr=String(n.p.chr||'').trim().toLowerCase();
  if(r.src==='gatt' && (r.ev==='read' || r.ev==='notify') && r.chr && svc && chr && r.svc.toLowerCase()===svc && r.chr.toLowerCase()===chr){
    const d=plDecode(r.hex,n.p.fmt,r.chr,+n.p.scale||1); n.val=d.value; n.hex=d.hex; n.txt=d.text; n.fresh=1;
  }
  n.fresh=n.fresh||0;
  n.recQ.push({t:Date.now(),...r});
  if(n.recQ.length>5000) n.recQ.splice(0,n.recQ.length-5000);
}

def({ id:'gattlink', title:'BLE GATT / Bluetooth (DSP app)', cat:'Sources', kw:'bluetooth le ble gatt rfcomm spp classic pairing bond uuid characteristic notify write advertise beacon peripheral connect',
  ins:[{n:'go',t:'num'},{n:'addr',t:'txt'},{n:'svc',t:'txt'},{n:'chr',t:'txt'},{n:'data',t:'txt'},{n:'cmd',t:'rec'}],
  outs:[{n:'rec',t:'rec'},{n:'value',t:'num'},{n:'hex',t:'txt'},{n:'text',t:'txt'},{n:'ok',t:'num'},{n:'new',t:'num'}],
  readout:true, tall:true,
  groups:[{n:'GATT'},{n:'GATT server (peripheral)',open:false},{n:'Classic / RFCOMM / L2CAP',open:false},{n:'Advertise (peripheral)',open:false},{n:'Periodic advertising',open:false},{n:'Decode value',open:false}],
  params:[
    {n:'url',t:'text',d:'ws://127.0.0.1:8765',label:'bridge of the DSP app'},
    {n:'action',t:'select',opts:PL_GATT_ACTIONS,d:'connect',label:'action (the Run button, or a rising edge on go)'},
    {n:'addr',t:'text',d:'',label:'device address AA:BB:CC:DD:EE:FF (the «addr» input overrides it)',g:'GATT'},
    {n:'svc',t:'text',d:'',label:'service UUID (16- or 128-bit; name from Reference/Bluetooth UUIDs via lookup() in Table)',g:'GATT'},
    {n:'chr',t:'text',d:'',label:'characteristic UUID',g:'GATT'},
    {n:'data',t:'text',d:'',label:'write: hex bytes or text (the «data» input overrides it)',g:'GATT'},
    {n:'wfmt',t:'select',opts:['hex','text'],d:'hex',label:'write as',g:'GATT'},
    {n:'resp',t:'check',d:true,label:'write with response',g:'GATT'},
    {n:'autoRead',t:'check',d:false,label:'after discover: read every readable characteristic',g:'GATT'},
    {n:'autoNotify',t:'check',d:false,label:'after discover: subscribe to every notifying characteristic',g:'GATT'},
    {n:'readMax',t:'range',min:0,max:200,step:1,d:0,label:'auto-read: at most N characteristics (0 — all)',g:'GATT'},
    {n:'phy',t:'select',opts:['1m','2m','coded','any'],d:'1m',label:'PHY',g:'GATT'},
    {n:'mtu',t:'range',min:0,max:517,step:1,d:0,label:'request MTU (0 — don\'t ask)',g:'GATT'},
    {n:'prio',t:'select',opts:['high','balanced','low'],d:'high',label:'connection priority',g:'GATT'},
    {n:'autoConn',t:'check',d:false,label:'auto-connect (wait for the device instead of a single attempt)',g:'GATT'},
    {n:'uuid',t:'text',d:'',label:'RFCOMM service UUID (empty — SPP 1101)',g:'Classic / RFCOMM / L2CAP'},
    {n:'secure',t:'check',d:true,label:'secure link (RFCOMM / L2CAP, encrypted)',g:'Classic / RFCOMM / L2CAP'},
    {n:'psm',t:'range',min:0,max:65535,step:1,d:0,label:'L2CAP PSM (LE: 128…255; the listener gets its own and reports it)',g:'Classic / RFCOMM / L2CAP'},
    {n:'srvDef',t:'code',plain:true,d:'180d/2a37 read,notify = 0600\n6e400001-b5a3-f393-e0a9-e50e24dcca9e/6e400002-b5a3-f393-e0a9-e50e24dcca9e write,writenr\n6e400001-b5a3-f393-e0a9-e50e24dcca9e/6e400003-b5a3-f393-e0a9-e50e24dcca9e read,notify = "hi"',label:'services: «svc/chr props = value» per line (props: read write writenr notify indicate manual secure; value: hex or "text"). Start advertising with connectable on and the service UUIDs so centrals can find it',g:'GATT server (peripheral)'},
    {n:'srvReq',t:'num',d:0,label:'respond: the req number of a «manual» read / write record',g:'GATT server (peripheral)'},
    {n:'srvStatus',t:'num',d:0,label:'respond: ATT status (0 — ok with the data, 3 — write not permitted, 257 — failure)',g:'GATT server (peripheral)'},
    {n:'advName',t:'check',d:false,label:'include the device name',g:'Advertise (peripheral)'},
    {n:'advUuids',t:'text',d:'',label:'service UUIDs, comma separated (180d, fe95…)',g:'Advertise (peripheral)'},
    {n:'advMfr',t:'text',d:'',label:'manufacturer data: id=hex (004C=0215AABBCCDD…), «;» for more',g:'Advertise (peripheral)'},
    {n:'advSvc',t:'text',d:'',label:'service data: uuid=hex',g:'Advertise (peripheral)'},
    {n:'advMode',t:'select',opts:['balanced','low_latency','low_power'],d:'balanced',label:'advertise mode',g:'Advertise (peripheral)'},
    {n:'advPower',t:'select',opts:['medium','ultra_low','low','high'],d:'medium',label:'tx power',g:'Advertise (peripheral)'},
    {n:'advConn',t:'check',d:false,label:'connectable',g:'Advertise (peripheral)'},
    {n:'advExt',t:'check',d:false,label:'extended advertising (2M / Coded PHY, >31 bytes)',g:'Advertise (peripheral)'},
    {n:'advTimeout',t:'range',min:0,max:180000,step:1000,d:0,label:'stop after, ms (0 — until ble.adv.stop)',g:'Advertise (peripheral)'},
    {n:'advPeriodic',t:'check',d:false,label:'advertise with a periodic train (needs the extended advertising support; not connectable) — receivers sync to it and get every packet',g:'Periodic advertising'},
    {n:'advPint',t:'range',min:100,max:81900,step:50,d:200,label:'periodic interval, ms (100 … 81900)',g:'Periodic advertising'},
    {n:'advPmfr',t:'text',d:'',label:'periodic data: manufacturer id=hex (FFFF=0102…); «adv pdata» replaces it while running',g:'Periodic advertising'},
    {n:'advPsvc',t:'text',d:'',label:'periodic data: service uuid=hex',g:'Periodic advertising'},
    {n:'syncSkip',t:'range',min:0,max:499,step:1,d:0,label:'receive: skip N events between packets',g:'Periodic advertising'},
    {n:'syncTimeout',t:'range',min:100,max:160000,step:100,d:10000,label:'receive: sync lost after, ms without a packet (the «addr» above is the transmitter; scan with ble legacy:false first so the phone has seen it)',g:'Periodic advertising'},
    {n:'fmt',t:'select',opts:['auto',...BLE_FORMATS],d:'auto',label:'value format (auto — Reference/Bluetooth UUIDs or hex)',g:'Decode value'},
    {n:'scale',t:'num',d:1,label:'scale',g:'Decode value'},
    {n:'reconnect',t:'check',d:true,label:'reconnect'},
    {n:'run',t:'button',label:'Run',fn:n=>{ const c=plGattCmd(n.p,{addr:n.addrIn,svc:n.svcIn,chr:n.chrIn,data:n.dataIn}); if(c.error) n.last=c.error; else gattSend(n,c); }},
    {n:'connect',t:'button',label:'Connect',fn:n=>gattStart(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>gattStop(n)},
  ],
  init:n=>{ n.ws=null; n.want=false; n.timer=null; n.recQ=[]; n.pend=[]; n.seq=0; n.lastCmd=null; n.count=0; n.ok=0; n.val=null; n.hex=''; n.txt=''; n.fresh=0;
            n.status='not connected'; n.warn=''; n.sentSub=null; n.bridgeMsg=''; n.last=''; n.prevGo=0; n.addrIn=''; n.svcIn=''; n.chrIn=''; n.dataIn=''; },
  dispose:n=>gattStop(n),
  process(n,I){
    gattSub(n);
    n.addrIn=typeof I.addr==='string' ? I.addr : ''; n.svcIn=typeof I.svc==='string' ? I.svc : ''; n.chrIn=typeof I.chr==='string' ? I.chr : ''; n.dataIn=typeof I.data==='string' ? I.data : '';
    const go=(I.go||0)>.5;
    if(go && !n.prevGo){ const c=plGattCmd(n.p,{addr:n.addrIn,svc:n.svcIn,chr:n.chrIn,data:n.dataIn}); if(c.error) n.last=c.error; else gattSend(n,c); }
    n.prevGo=go;
    if(Array.isArray(I.cmd) && I.cmd!==n.lastCmd){                   // записи с полем cmd уходят как есть (собрать их можно Rec Filter / Fields → Rec)
      n.lastCmd=I.cmd;
      for(const r of I.cmd) if(r && typeof r.cmd==='string') gattSend(n,r);
    }
    const rec=n.recQ.length ? n.recQ.splice(0) : null, fresh=n.fresh; n.fresh=0;
    return {rec, value:n.val, hex:n.hex||null, text:n.txt||null, ok:n.ok, new:fresh};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    let t=(n.warn&&!n.ws&&n.status!=='connected' ? '⚠ '+n.warn+'\n' : '')+n.status+' · records '+n.count;
    if(n.bridgeMsg) t+='\n⚠ '+n.bridgeMsg;
    if(n.last) t+='\n'+n.last;
    if(n.val!=null) t+='\nvalue '+(Math.round(n.val*1e4)/1e4)+(n.hex ? ' ['+n.hex.slice(0,60)+']' : '');
    if(r.textContent!==t) r.textContent=t; }
});
