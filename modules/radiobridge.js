"use strict";
/* ============================ Radio Bridge (ESP32-C5) ============================
   Wi-Fi (2.4 / 5 ГГц, mgmt + ctrl + data), BLE и 802.15.4 (Zigbee / Thread) через USB WebSerial; прошивка — tools/radio-bridge-esp32c5.
   Каждый принятый кадр — запись rec с одинаковыми именами для всех протоколов (proto, kind, src, dst, net, ie.ssid, ad.name …)
   и полем hex: её можно отдать в Rec Filter, Table, Graph, HEX Structure. Передача: входы tx / txrec / txbin → «TX <протокол> <hex>».
   Выход stat — окно по каналу (макс. RSSI, занятость %), csi — амплитуда / фаза по поднесущим; оба отдельно от rec.
   Без железа узел кормится входом text (те же строки). Ядро — radiobridge-kernels.js. */

async function radioTeardown(n){
  n.connected=false; n.connecting=false;
  if(n.reader){ try{ await n.reader.cancel(); }catch(e){} try{ n.reader.releaseLock(); }catch(e){} n.reader=null; }
  if(n.port){ try{ await n.port.close(); }catch(e){} n.port=null; }
}
async function radioConnect(n){
  if(n.connecting) return;
  await radioTeardown(n);
  if(!navigator.serial){ n.status='WebSerial unavailable (needs Chrome/Edge, HTTPS)'; return; }
  n.connecting=true; n.status='choose a port…';
  try{
    const port=await navigator.serial.requestPort();
    await port.open({baudRate:+n.p.baud||115200, bufferSize:65536});
    n.port=port; n.connecting=false; n.connected=true; n.status='connected';
    radioSend(n,radioCfg(n));
    radioReadLoop(n);
  }catch(e){
    n.connecting=false;
    n.status=e.name==='NotFoundError' ? 'no port selected' : 'error: '+e.message;
    await radioTeardown(n);
  }
}
async function radioReadLoop(n){
  const reader=n.port.readable.getReader(); n.reader=reader;
  const dec=new TextDecoder(); let buf='';
  try{
    while(n.connected){
      const {value,done}=await reader.read();
      if(done) break;
      if(!value) continue;
      buf+=dec.decode(value,{stream:true});
      let i;
      while((i=buf.indexOf('\n'))>=0){ radioFeed(n,buf.slice(0,i)); buf=buf.slice(i+1); }
      if(buf.length>8192) buf='';
    }
    if(n.connected){ n.status='port closed by device'; radioTeardown(n); }
  }catch(e){
    if(n.connected){ n.status='read error: '+e.message; radioTeardown(n); }
  }
}
function radioFeed(n,line){
  const f=radioLine(line);
  if(!f){ const st=radioStatus(line); if(st) n.reply=st; return; }
  if(f.stat){ n.pendStat.push(radioStatRec(f)); if(n.pendStat.length>500) n.pendStat.splice(0,n.pendStat.length-500); return; }
  if(f.csi){ n.pendCsi.push(radioCsiRec(f)); if(n.pendCsi.length>100) n.pendCsi.splice(0,n.pendCsi.length-100); return; }
  n.frames++;
  let r; try{ r=radioRec(f); }catch(e){ return; }
  n.pend.push(r); n.lastBin=f.bytes; n.lastProto=f.proto; n.binId++;
  if(n.pend.length>500) n.pend.splice(0,n.pend.length-500);
  if(n.p.arProbe) radioAutoReply(n,r);
}
// автоответчик: Probe request на наш SSID (или широковещательный) → Probe response; не чаще раза в секунду на адрес
function radioAutoReply(n,r){
  if(r.kind!=='probe-req' || !r.src) return;
  const now=Date.now(), last=n.arLast.get(r.src);
  if(last && now-last<1000) return;
  let b=null; try{ b=radioProbeResp(r,{ssid:n.p.arSsid, bssid:n.p.arBssid, seq:n.arSeq}); }catch(e){}
  if(!b) return;
  if(n.arLast.size>500) n.arLast.clear();
  n.arLast.set(r.src,now); n.arSeq++; n.replies++;
  radioTxNow(n,b,'WIFI');
}
// настройка прошивки из параметров узла; порядок важен: диапазон → типы → режим → канал
function radioCfg(n){
  const p=n.p, mode=p.mode;
  const types=[p.tMgmt&&'MGMT',p.tCtrl&&'CTRL',p.tData&&'DATA'].filter(Boolean).join(',');
  let s='';
  if(mode==='WIFI'){
    s+='BAND '+p.band+'\nTYPES '+(types||'MGMT')+'\nSNAP '+p.snap+'\nDSNAP '+p.dsnap+'\n';
    s+=p.stat ? 'STAT '+p.statMs+'\n' : 'STAT OFF\n';
    s+=p.csi ? 'CSI ON '+p.csiMs+'\n' : 'CSI OFF\n';
  }
  if(mode==='BLE') s+='BLESCAN '+p.bleScan+'\n';
  s+='MODE '+mode+'\n';
  if(mode!=='OFF' && mode!=='BLE') s+=p.chan>0 ? 'HOP OFF\nCH '+p.chan+'\n' : 'HOP ON '+p.dwell+'\n';
  return s;
}
async function radioSend(n,text){
  if(!n.port || !n.port.writable) return;
  const w=n.port.writable.getWriter();
  try{ await w.write(new TextEncoder().encode(text)); }catch(e){} finally{ w.releaseLock(); }
}
function radioTxNow(n,src,proto){
  const line=radioTx(src,proto || n.p.txProto,n.p.csma);
  if(!line){ n.txErr='bad tx input'; return; }
  n.txErr=''; n.txCount++; n.txLast=line.length>60 ? line.slice(0,60)+'…' : line;
  radioSend(n,line+'\n');
}

def({ id:'radioBridge', lazy:'manual', title:'Radio Bridge (ESP32-C5)', cat:'Sources', kw:'esp32 c5 wifi ble bluetooth zigbee thread matter 802.15.4 802.11 sniffer inject transmit tx rx packets frames probe beacon p2p wifi direct espnow',
  ins:[{n:'text',t:'txt'},{n:'tx',t:'txt'},{n:'txrec',t:'rec'},{n:'txbin',t:'bin'}],
  outs:[{n:'rec',t:'rec'},{n:'stat',t:'rec'},{n:'csi',t:'rec'},{n:'bin',t:'bin'},{n:'count',t:'num'},{n:'frames',t:'num'}],
  readout:true, tall:true, w:420, resize:true,
  params:[{n:'connect',t:'button',label:'Connect ESP32-C5',fn:n=>radioConnect(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>{ n.status='disconnected'; radioTeardown(n); }},
          {n:'mode',t:'select',opts:['WIFI','BLE','ZB','OFF'],d:'WIFI',label:'radio',fn:n=>radioSend(n,radioCfg(n))},
          {n:'band',t:'select',opts:['2G','5G'],d:'2G',label:'Wi-Fi band',fn:n=>radioSend(n,radioCfg(n))},
          {n:'tMgmt',t:'check',d:true,label:'Wi-Fi: management',fn:n=>radioSend(n,radioCfg(n))},
          {n:'tCtrl',t:'check',d:true,label:'Wi-Fi: control',fn:n=>radioSend(n,radioCfg(n))},
          {n:'tData',t:'check',d:false,label:'Wi-Fi: data (busy networks flood the link)',fn:n=>radioSend(n,radioCfg(n))},
          {n:'chan',t:'num',d:0,label:'channel (0 — hop; Wi-Fi 1…13 / 36…165, ZB 11…26)',fn:n=>radioSend(n,radioCfg(n))},
          {n:'dwell',t:'range',min:20,max:2000,step:10,d:250,label:'hop dwell, ms',fn:n=>radioSend(n,radioCfg(n))},
          {n:'snap',t:'range',min:24,max:512,step:8,d:320,label:'Wi-Fi bytes kept per frame',fn:n=>radioSend(n,radioCfg(n))},
          {n:'dsnap',t:'range',min:24,max:512,step:8,d:96,label:'Wi-Fi bytes kept per data frame',fn:n=>radioSend(n,radioCfg(n))},
          {n:'stat',t:'check',d:false,label:'Wi-Fi: channel stats → stat (level / airtime of every frame, even unselected types)',fn:n=>radioSend(n,radioCfg(n))},
          {n:'statMs',t:'range',min:100,max:5000,step:100,d:1000,label:'stat window, ms (hop: per dwell)',fn:n=>radioSend(n,radioCfg(n))},
          {n:'csi',t:'check',d:false,label:'Wi-Fi: CSI → csi',fn:n=>radioSend(n,radioCfg(n))},
          {n:'csiMs',t:'range',min:0,max:2000,step:10,d:100,label:'CSI: min interval, ms',fn:n=>radioSend(n,radioCfg(n))},
          {n:'bleScan',t:'select',opts:['PASSIVE','ACTIVE'],d:'PASSIVE',label:'BLE scan',fn:n=>radioSend(n,radioCfg(n))},
          {n:'arProbe',t:'check',d:false,label:'auto-reply to Probe requests (Wi-Fi; set a fixed channel)'},
          {n:'arSsid',t:'text',d:'',label:'auto-reply: SSID to answer for'},
          {n:'arBssid',t:'text',d:'02:00:00:00:00:01',label:'auto-reply: our BSSID (MAC)'},
          {n:'txProto',t:'select',opts:['WIFI','BLE','ZB'],d:'WIFI',label:'tx: protocol for bare hex'},
          {n:'csma',t:'check',d:false,label:'tx: ZB with CSMA'},
          {n:'baud',t:'num',d:115200,label:'baud (ignored by USB-CDC chips)',adv:true},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ n.pend=[]; n.pendStat=[]; n.pendCsi=[]; n.frames=0; n.sent=0; n.txCount=0; n.replies=0; }}],
  init:n=>{ n.pend=[]; n.pendStat=[]; n.pendCsi=[]; n.frames=0; n.sent=0; n.lastText=null; n.lastBin=null; n.lastProto='wifi'; n.binId=0; n.binSent=0; n.binOut=null;
    n.arLast=new Map(); n.arSeq=0; n.replies=0;
    n.lastTx=null; n.lastTxRec=null; n.lastTxBin=null; n.txCount=0; n.txLast=''; n.txErr=''; n.reply='';
    n.port=null; n.reader=null; n.connected=false; n.connecting=false; n.status='not connected'; },
  dispose:n=>{ radioTeardown(n).catch(e=>console.error('radio dispose:',e)); },
  process(n,I){
    if(typeof I.text==='string' && I.text!==n.lastText){
      n.lastText=I.text;
      for(const line of I.text.split(/[\r\n;]+/)) radioFeed(n,line);
    }
    if(typeof I.tx==='string' && I.tx!==n.lastTx){
      n.lastTx=I.tx;
      for(const line of I.tx.split(/[\r\n;]+/)) if(line.trim()) radioTxNow(n,line);
    }
    if(I.txrec!==n.lastTxRec){ n.lastTxRec=I.txrec; for(const r of recList(I.txrec)) radioTxNow(n,r); }
    if(I.txbin && I.txbin.id!==n.lastTxBin){ n.lastTxBin=I.txbin.id; if(I.txbin.d && I.txbin.d.length) radioTxNow(n,I.txbin.d); }
    const recs=n.pend; n.pend=[]; n.sent+=recs.length;
    const st=n.pendStat, cs=n.pendCsi; n.pendStat=[]; n.pendCsi=[];
    if(n.binSent!==n.binId){ n.binSent=n.binId; n.binOut=binObj(n.lastBin,n.lastProto+'-frame'); }
    return {rec:recs.length ? recs : null, stat:st.length ? st : null, csi:cs.length ? cs : null, bin:n.binOut, count:n.sent, frames:n.frames};
  },
  drawKey:n=>n.status+'|'+n.frames+'|'+n.txCount+'|'+n.replies+'|'+n.reply+'|'+n.txErr,
  draw(n){
    const el=n.el.querySelector('.readout'); if(!el) return;
    const s=n.status+' · '+n.frames+' frames · '+n.sent+' records · tx '+n.txCount+(n.replies ? ' ('+n.replies+' auto-replies)' : '')+(n.txErr ? ' ('+n.txErr+')' : '')+
      (n.reply ? '\n'+n.reply : '')+(n.txLast ? '\ntx: '+n.txLast : '');
    if(el.textContent!==s) el.textContent=s;
  }});
