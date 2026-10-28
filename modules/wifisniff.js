"use strict";
/* ============================ Wi-Fi Sniffer (ESP32) ============================
   Кадры 802.11 с ESP32 по WebSerial (строки WIFI,<канал>,<rssi>,<hex>); прошивка — tools/wifi-sniffer-esp32.
   Каждый кадр — запись rec (тип, адреса, SSID, канал, безопасность) с полем hex: её можно отдать в HEX Structure
   (разбор по схеме wifi) или в Table. Без железа узел кормится входом text (те же строки) или входом rec — записями pkt из монитор-режима
   телефона (приложение DSP, root, wifi.monitor; поле dot11). Ядро — wifisniff-kernels.js. */

async function wifiTeardown(n){
  n.connected=false; n.connecting=false;
  if(n.reader){ try{ await n.reader.cancel(); }catch(e){} try{ n.reader.releaseLock(); }catch(e){} n.reader=null; }
  if(n.port){ try{ await n.port.close(); }catch(e){} n.port=null; }
}
async function wifiConnect(n){
  if(n.connecting) return;
  await wifiTeardown(n);
  if(!navigator.serial){ n.status='WebSerial unavailable (needs Chrome/Edge, HTTPS)'; return; }
  n.connecting=true; n.status='choose a port…';
  try{
    const port=await navigator.serial.requestPort();
    await port.open({baudRate:+n.p.baud||115200, bufferSize:65536});
    n.port=port; n.connecting=false; n.connected=true; n.status='connected';
    wifiSend(n,wifiCfg(n));
    wifiReadLoop(n);
  }catch(e){
    n.connecting=false;
    n.status=e.name==='NotFoundError' ? 'no port selected' : 'error: '+e.message;
    await wifiTeardown(n);
  }
}
async function wifiReadLoop(n){
  const reader=n.port.readable.getReader(); n.reader=reader;
  const dec=new TextDecoder(); let buf='';
  try{
    while(n.connected){
      const {value,done}=await reader.read();
      if(done) break;
      if(!value) continue;
      buf+=dec.decode(value,{stream:true});
      let i;
      while((i=buf.indexOf('\n'))>=0){ wifiFeed(n,buf.slice(0,i)); buf=buf.slice(i+1); }
      if(buf.length>4096) buf='';
    }
    if(n.connected){ n.status='port closed by device'; wifiTeardown(n); }
  }catch(e){
    if(n.connected){ n.status='read error: '+e.message; wifiTeardown(n); }
  }
}
function wifiFeed(n,line){
  const f=wifiLine(line); if(f) wifiPush(n,f);
}
function wifiPush(n,f){
  n.frames++;
  let r; try{ r=wifiRec(f); }catch(e){ return; }
  if(n.p.types!=='all' && r.ftype!==n.p.types) return;
  n.pend.push(r); n.lastBin=f.bytes; n.binId++;
  if(n.pend.length>500) n.pend.splice(0,n.pend.length-500);
}
const wifiCfg=n=>'TYPE '+n.p.types.toUpperCase()+'\nSNAP '+n.p.snap+'\n'+(n.p.chan>0 ? 'CH '+n.p.chan : 'HOP')+'\n';
async function wifiSend(n,text){
  if(!n.port || !n.port.writable) return;
  const w=n.port.writable.getWriter();
  try{ await w.write(new TextEncoder().encode(text)); }catch(e){} finally{ w.releaseLock(); }
}

def({ id:'wifiSniff', lazy:'manual', title:'Wi-Fi Sniffer (ESP32 / phone)', cat:'Sources', kw:'wifi 802.11 sniffer esp32 promiscuous beacon probe deauth packets frames monitor radiotap phone root',
  ins:[{n:'text',t:'txt'},{n:'rec',t:'rec'}], outs:[{n:'rec',t:'rec'},{n:'bin',t:'bin'},{n:'count',t:'num'},{n:'frames',t:'num'}],
  readout:true, tall:true, w:420, resize:true,
  params:[{n:'connect',t:'button',label:'Connect ESP32',fn:n=>wifiConnect(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>{ n.status='disconnected'; wifiTeardown(n); }},
          {n:'types',t:'select',opts:['all','mgmt','ctrl','data'],d:'mgmt',label:'frame types',fn:n=>wifiSend(n,wifiCfg(n))},
          {n:'chan',t:'range',min:0,max:13,step:1,d:0,label:'channel (0 — hop 1…13)',fn:n=>wifiSend(n,wifiCfg(n))},
          {n:'snap',t:'range',min:24,max:400,step:8,d:160,label:'bytes kept per frame',fn:n=>wifiSend(n,wifiCfg(n))},
          {n:'baud',t:'num',d:115200,label:'baud (ignored by USB-CDC chips)',adv:true},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ n.pend=[]; n.frames=0; n.sent=0; }}],
  init:n=>{ n.pend=[]; n.frames=0; n.sent=0; n.lastText=null; n.lastRec=null; n.lastBin=null; n.binId=0; n.binSent=0; n.binOut=null;
    n.port=null; n.reader=null; n.connected=false; n.connecting=false; n.status='not connected'; },
  dispose:n=>{ wifiTeardown(n).catch(e=>console.error('wifi dispose:',e)); },
  process(n,I){
    if(typeof I.text==='string' && I.text!==n.lastText){
      n.lastText=I.text;
      for(const line of I.text.split(/[\r\n;]+/)) wifiFeed(n,line);
    }
    if(Array.isArray(I.rec) && I.rec!==n.lastRec){            // pkt из Phone sensors (DSP app, root, wifi.monitor)
      n.lastRec=I.rec;
      for(const r of I.rec){ const f=wifiFromPkt(r); if(f) wifiPush(n,f); }
    }
    const recs=n.pend; n.pend=[]; n.sent+=recs.length;
    if(n.binSent!==n.binId){ n.binSent=n.binId; n.binOut=binObj(n.lastBin,'wifi-frame'); }
    return {rec:recs.length ? recs : null, bin:n.binOut, count:n.sent, frames:n.frames};
  },
  drawKey:n=>n.status+'|'+n.frames,
  draw(n){
    const el=n.el.querySelector('.readout'); if(!el) return;
    const s=n.status+' · '+n.frames+' frames · '+n.sent+' records'; if(el.textContent!==s) el.textContent=s;
  }});
