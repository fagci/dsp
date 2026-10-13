"use strict";
/* ============================ Packet Link ============================
   Сбор пакетов из любого канала в записи rec (hex + hexSchema) для Table, HEX Structure, PCAP Writer.
   Каналы: WebSocket (мост к TCP / UDP / pcap / rtl_*: websocat, websockify, свой скрипт, ESP32 с WebSocket-сервером),
   HTTP-поток (SSE, NDJSON, chunked, pcap; через CORS-прокси из настроек), WebSerial, Web Bluetooth (Nordic UART / HM-10);
   входы bin и text — для всего остального (MQTT, WebRTC Data, Serial Port, BLE UART, файл).
   Кадровщик — link-kernels.js. Примеры:
     tcpdump -i wlan0 -U -w - | websocat -b -s 8767                  (frame: pcap)
     websocat -b -s 8767 udp-l:0.0.0.0:5000                            (frame: message — датаграмма = пакет)
     websockify 8767 192.168.1.20:3333                               (TCP-сервер устройства; frame по протоколу) */

const LK_BAUD=['9600','57600','115200','230400','460800','921600','1000000','2000000'];
const LK_ENC=new TextEncoder();
const lkStatus=(n,s)=>{ n.status=s; };

function lkSetFramer(n){
  if(n.fr && n.frKind===n.p.frame && n.frMax===+n.p.maxLen) return;
  n.frKind=n.p.frame; n.frMax=+n.p.maxLen; n.fr=lkFramer(n.frKind,n.frMax);
}
// байты канала → кадровщик → записи
function lkIn(n,u){
  if(!u || !u.length) return;
  lkSetFramer(n);
  n.rx+=u.length;
  const now=Date.now();
  for(const p of n.fr.push(u)){
    n.seq++;
    n.pend.push(lkRec(p,{src:n.p.src||'link',seq:n.seq,schema:n.p.schema||'auto',now}));
    if(p.data.length){ n.lastPkt=p.data; n.pktId++; }
    n.lastText=n.pend[n.pend.length-1].text;
  }
  if(n.pend.length>5000) n.pend.splice(0,n.pend.length-5000);
}
// текст: строковые кадровщики получают его как есть, остальные — как байты UTF-8
function lkInText(n,s){
  lkSetFramer(n);
  s=String(s);
  lkIn(n,LK_ENC.encode(lkIsLines(n.p.frame) && !/\n$/.test(s) ? s+'\n' : s));
}
function lkTx(n,u){
  const via=n.p.via;
  if(via==='websocket' && n.ws && n.ws.readyState===1){ n.ws.send(u); n.tx+=u.length; }
  else if(via==='serial' && n.connected){ serialWriteBytes(n,u); n.tx+=u.length; }
  else if(via==='ble uart' && n.connected && n.wr){ const el=n.wr; n.chain=n.chain.then(()=>bleWrite(n,el,u)).then(()=>{ n.tx+=u.length; },e=>{ lkStatus(n,'write error: '+e.message); }); }
}
function lkStop(n){
  n.want=false; clearTimeout(n.timer); n.timer=null;
  if(n.abort){ try{ n.abort.abort(); }catch(e){} n.abort=null; }
  const ws=n.ws; n.ws=null;
  if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
  if(n.port || n.reader) serialTeardown(n).catch(e=>console.error('link serial:',e));
  if(n.dev) bleTeardown(n);
  n.connected=false; n.connecting=false;
}
function lkRetry(n,fn,ms){ if(n.want && n.p.reconnect){ clearTimeout(n.timer); n.timer=setTimeout(()=>{ if(n.want) fn(); },ms); } }
function lkWs(n,url){
  let ws;
  try{ ws=new WebSocket(url); }catch(e){ lkStatus(n,'error: '+e.message); lkRetry(n,()=>lkWs(n,url),5000); return; }
  n.ws=ws; lkStatus(n,'connecting…'); ws.binaryType='arraybuffer';
  ws.onopen=()=>{ lkStatus(n,'connected'); n.connected=true; };
  ws.onerror=()=>{ lkStatus(n,'connection error'); };
  ws.onclose=e=>{
    if(n.ws!==ws) return;
    n.ws=null; n.connected=false;
    lkStatus(n,'closed'+(e.code!==1000 ? ' ('+e.code+')' : '')+(n.p.reconnect ? ' — reconnecting…' : ''));
    lkRetry(n,()=>lkWs(n,url),2000);
  };
  ws.onmessage=e=>{ if(typeof e.data==='string') lkInText(n,e.data); else if(e.data instanceof ArrayBuffer) lkIn(n,new Uint8Array(e.data)); };
}
async function lkHttp(n,url){
  if(!n.want) return;
  const ac=n.abort=new AbortController();
  try{
    const r=await fetch(n.p.proxy ? Net.url(url) : url,{cache:'no-store',signal:ac.signal});
    if(!r.ok) throw new Error('HTTP '+r.status);
    lkStatus(n,'streaming'); n.connected=true;
    const rd=r.body.getReader();
    for(;;){ const {value,done}=await rd.read(); if(done) break; lkIn(n,value); }
    lkStatus(n,'stream ended'+(n.p.reconnect ? ' — reconnecting…' : ''));
  }catch(e){
    if(ac.signal.aborted) return;
    lkStatus(n,'error: '+e.message+(e instanceof TypeError ? ' (no CORS headers on the server, or blocked — try «use CORS proxy»)' : ''));
  }
  n.connected=false;
  if(n.abort===ac){ n.abort=null; lkRetry(n,()=>lkHttp(n,url),3000); }
}
function lkStart(n){
  lkStop(n);
  const via=n.p.via, url=String(n.p.url||'').trim();
  n.warn='';
  if(via==='websocket' || via==='http stream'){
    const ok=via==='websocket' ? /^wss?:\/\//i : /^https?:\/\//i;
    if(!ok.test(url)){ lkStatus(n,'URL must start with '+(via==='websocket' ? 'ws:// or wss://' : 'http:// or https://')); return; }
    if(netInsecure(url) && !(via==='http stream' && n.p.proxy)) n.warn=NET_INSECURE_MSG;
    n.want=true;
    if(via==='websocket') lkWs(n,url); else lkHttp(n,url);
  } else if(via==='serial') serialConnect(n);
  else if(via==='ble uart') bleConnect(n);
  else lkStatus(n,'inputs only: wire bin or text');
}

def({ id:'plink', title:'Packet Link', cat:'Sources', kw:'packets capture transport sniffer pcap websocket serial ble bluetooth http stream sse tcp udp bridge proxy slip kiss hdlc cobs frames wireshark esp32 hex',
  ins:[{n:'bin',t:'bin'},{n:'text',t:'txt'},{n:'send',t:'bin'},{n:'sendText',t:'txt'}],
  outs:[{n:'rec',t:'rec'},{n:'bin',t:'bin'},{n:'count',t:'num'},{n:'bytes',t:'num'}],
  readout:true, tall:true, w:380, resize:true,
  params:[
    {n:'via',t:'select',opts:['websocket','http stream','serial','ble uart','inputs only'],d:'websocket',label:'channel'},
    {n:'url',t:'text',d:'ws://127.0.0.1:8767',label:'URL (ws:// wss:// http:// https://)'},
    {n:'frame',t:'select',opts:LK_FRAMES,d:'message',label:'frame (how the stream is cut into packets)'},
    {n:'schema',t:'text',d:'auto',label:'HEX schema of the packets (auto, eth, wifi, …)'},
    {n:'src',t:'text',d:'link',label:'source label'},
    {n:'connect',t:'button',label:'Connect',fn:n=>lkStart(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>{ lkStop(n); lkStatus(n,'disconnected'); }},
    {n:'clr',t:'button',label:'Clear counters',fn:n=>{ n.pend=[]; n.seq=0; n.rx=0; n.tx=0; n.sent=0; n.fr?.reset(); }},
    {n:'reconnect',t:'check',d:true,label:'reconnect'},
    {n:'proxy',t:'check',d:false,label:'http: through the CORS proxy from Settings',adv:true},
    {n:'baud',t:'select',opts:LK_BAUD,d:'115200',label:'serial: baud (ignored by USB-CDC chips)',adv:true},
    {n:'profile',t:'select',opts:Object.keys(BLE_PROFILES),d:'Nordic UART',label:'BLE: profile',adv:true},
    {n:'name',t:'text',d:'',label:'BLE: device name starts with (empty — any)',adv:true},
    {n:'any',t:'check',d:false,label:'BLE: list all devices',adv:true},
    {n:'chunk',t:'range',min:1,max:512,step:1,d:20,label:'BLE: bytes per write',adv:true},
    {n:'ack',t:'check',d:false,label:'BLE: write with response',adv:true},
    {n:'maxLen',t:'num',min:16,max:65535,step:256,d:4096,label:'len8 / len16: max packet length',adv:true},
  ],
  init:n=>{
    n.pend=[]; n.seq=0; n.rx=0; n.tx=0; n.sent=0; n.pktId=0; n.binSent=0; n.binOut=null; n.lastPkt=null; n.lastText='';
    n.fr=null; n.frKind=null; n.frMax=0; n.status='not connected'; n.warn=''; n.want=false; n.timer=null; n.abort=null; n.ws=null;
    n.lastBin=null; n.lastIn=undefined; n.lastSendB=null; n.lastSendT=undefined;
    // каналы serial и BLE используют общие помощники sources.js / ble.js
    n.port=null; n.reader=null; n.connected=false; n.connecting=false; n.reading=false; n.binQ=[]; n.chain=Promise.resolve();
    n.dev=null; n.chs=[]; n.pollT=null; n.wr=null; n.onDisc=bleOnDisc(n);
    n.onVal=e=>{ const v=e.target.value; lkIn(n,new Uint8Array(v.buffer.slice(v.byteOffset,v.byteOffset+v.byteLength))); };   // уведомление BLE — пакет целиком
    n.plan=n=>{
      const pr=BLE_PROFILES[n.p.profile]||BLE_PROFILES['Nordic UART'];
      return {services:[bleUuid(pr.svc)],setup:async(n,server)=>{
        const rx=await bleChar(server,pr.svc,pr.rx); await rx.startNotifications(); rx.addEventListener('characteristicvaluechanged',n.onVal);
        n.wr=pr.tx===pr.rx ? rx : await bleChar(server,pr.svc,pr.tx);
        n.chs=[{el:rx,notify:true}]; } };
    };
  },
  dispose:n=>{ lkStop(n); },
  process(n,I){
    if(I.bin && I.bin.d && I.bin!==n.lastBin){ n.lastBin=I.bin; lkIn(n,I.bin.d); }
    if(typeof I.text==='string' && I.text!==n.lastIn){ n.lastIn=I.text; if(I.text) lkInText(n,I.text); }
    if(n.binQ.length) for(const u of n.binQ.splice(0)) lkIn(n,u);          // serial: порядок чтений сохраняется
    if(I.send && I.send.d && I.send!==n.lastSendB){ n.lastSendB=I.send; lkTx(n,I.send.d); }
    if(typeof I.sendText==='string' && I.sendText!==n.lastSendT){ n.lastSendT=I.sendText; if(I.sendText) lkTx(n,LK_ENC.encode(I.sendText+'\n')); }
    const recs=n.pend; n.pend=[]; n.sent+=recs.length;
    if(n.binSent!==n.pktId && n.lastPkt){ n.binSent=n.pktId; n.binOut=binObj(n.lastPkt,'packet-'+n.seq+'.bin'); }
    return {rec:recs.length ? recs : null, bin:n.binOut, count:n.seq, bytes:n.rx};
  },
  draw(n){
    const r=n.el.querySelector('.readout'); if(!r) return;
    const t=(n.warn && !n.connected ? '⚠ '+n.warn+'\n' : '')+(n.p.via==='inputs only' && !n.rx ? 'inputs only · wire bin or text' : n.status)+
      ' · '+n.seq+' packets · rx '+n.rx+' B'+(n.tx ? ' · tx '+n.tx+' B' : '')+(n.lastText ? '\n'+n.lastText.slice(0,300) : '');
    if(r.textContent!==t) r.textContent=t;
  }
});
