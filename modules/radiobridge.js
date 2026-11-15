"use strict";
/* ============================ Radio Bridge (ESP32-C5) ============================
   Wi-Fi (2.4 / 5 ГГц, mgmt + ctrl + data), BLE и 802.15.4 (Zigbee / Thread) через USB WebSerial; прошивка — tools/radio-bridge-esp32c5.
   Каждый принятый кадр — запись rec с одинаковыми именами для всех протоколов (proto, kind, src, dst, net, ie.ssid, ad.name …)
   и полем hex: её можно отдать в Rec Filter, Table, Graph, HEX Structure. Передача: входы tx / txrec / txbin → «TX <протокол> <hex>».
   Опции: «Wi-Fi PHY / MCS / noise» (META — формат 11b/g/n/ac/ax, MCS, ширина, шум, SNR, метка времени в записи), «BLE 5 extended» (BLEEXT — расширенная
   реклама и LE Coded), «FTM» (802.11mc: вход ftm — «mac [кадров] [канал]» или запись с mac; выход ftm — дистанция в метрах; ответчик — «answer FTM»).
   Ещё: «ZB energy» (ZED — энергия по каналам 11…26 в stat, записи zb-ed), «+ BLE» (BLE одновременно с Wi-Fi или ZB), «USB format: binary» (FMT BIN — пакеты с CRC,
   вдвое меньше трафика, метка времени чипа ts_us у BLE и ZB), «board» (метка платы в каждой записи), CSI: индекс движения motion / present (radioCsiMotion).
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
  const st={};                                         // поток: текстовые строки и (FMT BIN) двоичные пакеты вперемешку
  try{
    while(n.connected){
      const {value,done}=await reader.read();
      if(done) break;
      if(!value) continue;
      const r=radioDemux(st,value);
      for(const line of r.lines) radioFeed(n,line);
      for(const f of r.frames) radioFeedF(n,f);
      if(r.bad) n.binBad=(n.binBad|0)+r.bad;
    }
    if(n.connected){ n.status='port closed by device'; radioTeardown(n); }
  }catch(e){
    if(n.connected){ n.status='read error: '+e.message; radioTeardown(n); }
  }
}
function radioFeed(n,line){
  const f=radioLine(line);
  if(!f){ const st=radioStatus(line); if(st) n.reply=st; return; }
  if(f.zed){ n.pendStat.push(radioZedRec(f)); if(n.pendStat.length>500) n.pendStat.splice(0,n.pendStat.length-500); return; }
  if(f.ftm){ n.pendFtm.push(radioFtmRec(f,n.p.ftmCal)); if(n.pendFtm.length>200) n.pendFtm.splice(0,n.pendFtm.length-200); return; }
  if(f.stat){ n.pendStat.push(radioStatRec(f)); if(n.pendStat.length>500) n.pendStat.splice(0,n.pendStat.length-500); return; }
  if(f.csi){ const cr=radioCsiMotion(n.csiSt,radioCsiRec(f),n.p.csiThr); if(n.p.tag) cr.board=n.p.tag; n.pendCsi.push(cr); if(n.pendCsi.length>100) n.pendCsi.splice(0,n.pendCsi.length-100); return; }
  radioFeedF(n,f);
}
// кадр (объект f из radioLine или из двоичного пакета) → запись; tag — метка платы, чтобы записи двух C5 различались в одной таблице
function radioFeedF(n,f){
  n.frames++;
  let r; try{ r=radioRec(f); }catch(e){ return; }
  if(r.kind==='touchlink-scan-resp' && r.ieee) n.zllSeen.set(r.ieee,{ch:r.chan,tid:r.tid});
  if(n.p.tag) r.board=n.p.tag;
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
  let s='FMT '+(p.fmt==='binary' ? 'BIN' : 'TEXT')+'\n';
  if(mode==='WIFI'){
    s+='BAND '+p.band+'\nTYPES '+(types||'MGMT')+'\nSNAP '+p.snap+'\nDSNAP '+p.dsnap+'\n';
    s+=p.stat ? 'STAT '+p.statMs+'\n' : 'STAT OFF\n';
    s+='CSIMODE '+(p.csiAll ? 'ALL' : 'LEG')+'\n';
    s+=p.csi ? 'CSI ON '+p.csiMs+'\n' : 'CSI OFF\n';
  }
  if(mode==='WIFI') s+=p.meta ? 'META ON\n' : 'META OFF\n';
  if(mode==='WIFI' && (p.ftmResp || n.ftmRespSent)) s+='FTMRESP '+(p.ftmResp ? 'ON' : 'OFF')+'\n';
  if(mode==='BLE') s+='BLESCAN '+p.bleScan+'\nBLEEXT '+(p.bleExt ? (p.bleCoded ? 'CODED' : 'ON') : 'OFF')+'\n';
  if(mode==='WIFI') n.ftmRespSent=!!p.ftmResp;
  s+='MODE '+mode+((mode==='WIFI' || mode==='ZB') && p.withBle ? '+BLE' : '')+'\n';
  if(mode==='ZB') s+=p.zed ? 'ZED ON '+p.zedMs+'\n' : 'ZED OFF\n';
  if(mode!=='OFF' && mode!=='BLE' && !(mode==='ZB' && p.zed)) s+=p.chan>0 ? 'HOP OFF\nCH '+p.chan+'\n' : 'HOP ON '+p.dwell+'\n';
  return s;
}
async function radioSend(n,text){
  if(!n.port || !n.port.writable) return;
  const w=n.port.writable.getWriter();
  try{ await w.write(new TextEncoder().encode(text)); }catch(e){} finally{ w.releaseLock(); }
}
function radioFtmNow(n,src){
  const line=radioFtmCmd(src,n.p.ftmFrames,n.p.ftmChan);
  if(!line){ n.txErr='bad ftm input (need a MAC)'; return; }
  n.txErr=''; n.ftmReq++; n.txLast=line; radioSend(n,line+'\n');
}
function radioTxNow(n,src,proto){
  const line=radioTx(src,proto || n.p.txProto,n.p.csma);
  if(!line){ n.txErr='bad tx input'; return; }
  n.txErr=''; n.txCount++; n.txLast=line.length>60 ? line.slice(0,60)+'…' : line;
  radioSend(n,line+'\n');
}

// ---- «кто здесь?» и подсветка: активные запросы по каналам, Touchlink identify, BLE Find Me ----
const RADIO_CH5=[36,40,44,48,52,56,60,64,100,104,108,112,116,120,124,128,132,136,140,144,149,153,157,161,165];
const radioSleep=ms=>new Promise(r=>setTimeout(r,ms));
function radioNeed(n,mode){ if(n.p.mode!==mode){ n.txErr='set radio to '+mode; return false; } if(!n.connected){ n.txErr='not connected'; return false; } n.txErr=''; return true; }
// steps: [{ch, tx:[строка команды…], dwell}] — по каналу: CH, пауза, кадры, ожидание ответов; в конце возвращаем настройку узла
async function radioSweep(n,steps,label){
  const tok=n.sweepTok=(n.sweepTok||0)+1;
  await radioSend(n,'HOP OFF\n');
  for(let i=0;i<steps.length;i++){
    if(tok!==n.sweepTok) return;
    const st=steps[i]; n.sweepMsg=label+' '+(i+1)+'/'+steps.length+' (ch '+st.ch+')';
    await radioSend(n,'CH '+st.ch+'\n'); await radioSleep(60);
    for(const t of st.tx) if(t){ await radioSend(n,t+'\n'); await radioSleep(30); }
    await radioSleep(st.dwell);
  }
  if(tok===n.sweepTok){ n.sweepMsg=''; await radioSend(n,radioCfg(n)); }
}
function radioWhoWifi(n){
  if(!radioNeed(n,'WIFI')) return;
  const chans=n.p.band==='5G' ? RADIO_CH5 : [1,2,3,4,5,6,7,8,9,10,11,12,13];
  radioSweep(n,chans.map((ch,i)=>({ch,dwell:150,tx:[0,1].map(k=>radioTx(radioProbeReq({src:n.p.probeSrc,ssid:n.p.probeSsid,seq:(n.arSeq=(n.arSeq+1)&4095)}),'WIFI'))})),'Wi-Fi probe');
}
function radioWhoZb(n){
  if(!radioNeed(n,'ZB')) return;
  const chans=[]; for(let c=11;c<=26;c++) chans.push(c);
  radioSweep(n,chans.map(ch=>({ch,dwell:300,tx:[radioTx(radioZbBeaconReq(n.zbSeq=(n.zbSeq+1)&255),'ZB',true)]})),'Zigbee beacon request');
}
function radioTlScan(n){
  if(!radioNeed(n,'ZB')) return;
  n.zllTid=(Math.random()*0x100000000)>>>0;
  radioSweep(n,ZLL_CH.map(ch=>({ch,dwell:400,tx:[0,1].map(k=>radioTx(zllBuild('scan',{tid:n.zllTid,seq:n.zbSeq=(n.zbSeq+1)&255,zseq:n.zbSeq}),'ZB',false))})),'Touchlink scan');
}
// Identify: мигает / пищит устройство, ответившее на Scan request (канал и tid берём из его ответа)
function radioIdentify(n,target){
  if(!radioNeed(n,'ZB')) return;
  let ieee=''; if(target && typeof target==='object') ieee=String(target.ieee||target.id||''); else ieee=String(target||'');
  ieee=ieee.trim().toLowerCase();
  const seen=n.zllSeen.get(ieee), ch=seen ? seen.ch : (n.p.chan>0 ? n.p.chan : 11);
  const f=zllBuild('identify',{dst:ieee,tid:seen ? seen.tid : n.zllTid,duration:+n.p.identSec||5,seq:n.zbSeq=(n.zbSeq+1)&255,zseq:n.zbSeq});
  if(!f){ n.txErr='bad IEEE address (aa:bb:cc:dd:ee:ff:00:11)'; return; }
  n.identCount++; n.identLast=ieee+' ch'+ch;
  radioSweep(n,[{ch,dwell:300,tx:[0,1,2].map(k=>radioTx(f,'ZB',true))}],'Touchlink identify');
}
function radioBleFind(n,target){
  if(!n.connected){ n.txErr='not connected'; return; }
  let addr='', at=0; if(target && typeof target==='object'){ addr=String(target.src||target.addr||target.id||''); at=target.addr_type==='random' ? 1 : 0; } else addr=String(target||'');
  addr=addr.trim().toLowerCase();
  if(!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(addr)){ n.txErr='bad BLE address'; return; }
  if(n.p.mode!=='BLE' && !n.p.withBle){ n.txErr='set radio to BLE (or tick + BLE)'; return; }
  n.txErr=''; n.findCount++; n.findLast=addr; radioSend(n,'BLEFIND '+addr+' '+at+' '+(+n.p.findLevel||2)+'\n');
}

def({ id:'radioBridge', lazy:'manual', title:'Radio Bridge (ESP32-C5)', cat:'Sources', kw:'esp32 c5 wifi ble bluetooth zigbee thread matter 802.15.4 802.11 sniffer inject transmit tx rx packets frames probe beacon p2p wifi direct espnow',
  ins:[{n:'text',t:'txt'},{n:'tx',t:'txt'},{n:'txrec',t:'rec'},{n:'txbin',t:'bin'},{n:'ftm',t:'txt'},{n:'identify',t:'rec'},{n:'find',t:'rec'}],
  outs:[{n:'rec',t:'rec'},{n:'stat',t:'rec'},{n:'csi',t:'rec'},{n:'ftmr',t:'rec'},{n:'bin',t:'bin'},{n:'count',t:'num'},{n:'frames',t:'num'}],
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
          {n:'csiAll',t:'check',d:false,label:'CSI: HT / VHT / HE frames too (default — legacy and HT20)',short:'CSI all PHY',fn:n=>radioSend(n,radioCfg(n))},
          {n:'csiThr',t:'range',min:0.01,max:1,step:0.01,d:0.1,label:'CSI: presence threshold of the motion index (calibrate on an empty room)',short:'CSI thr'},
          {n:'withBle',t:'check',d:false,label:'also scan BLE (Wi-Fi or ZB radio + BLE at once; the chip shares the antenna, expect some losses)',short:'+ BLE',fn:n=>radioSend(n,radioCfg(n))},
          {n:'zed',t:'check',d:false,label:'ZB: energy scan of channels 11…26 → stat (zb-ed records, level and busy % per channel)',short:'ZB energy',fn:n=>radioSend(n,radioCfg(n))},
          {n:'zedMs',t:'range',min:20,max:2000,step:10,d:100,label:'ZB energy: window per channel, ms',short:'ZB window',fn:n=>radioSend(n,radioCfg(n))},
          {n:'fmt',t:'select',opts:['text','binary'],d:'text',label:'USB format (binary: about half the traffic, hardware timestamp for BLE / ZB too)',short:'USB format',fn:n=>radioSend(n,radioCfg(n))},
          {n:'tag',t:'text',d:'',label:'board name (added to every record as «board» — two ESP32-C5 in one table)',short:'board'},
          {n:'meta',t:'check',d:false,label:'Wi-Fi: PHY / MCS / bandwidth / noise / timestamp in each record (11ax shows as phy 11ax)',short:'PHY meta',fn:n=>radioSend(n,radioCfg(n))},
          {n:'bleScan',t:'select',opts:['PASSIVE','ACTIVE'],d:'PASSIVE',label:'BLE scan',fn:n=>radioSend(n,radioCfg(n))},
          {n:'bleExt',t:'check',d:false,label:'BLE 5 extended advertising (needs CONFIG_BT_NIMBLE_EXT_ADV in the firmware build)',short:'BLE 5 ext',fn:n=>radioSend(n,radioCfg(n))},
          {n:'bleCoded',t:'check',d:false,label:'BLE 5: also LE Coded PHY (long range)',short:'LE Coded',fn:n=>radioSend(n,radioCfg(n))},
          {n:'probeSsid',t:'text',d:'',label:'who is here, Wi-Fi: SSID of the probe request (empty — any network)',short:'probe SSID'},
          {n:'probeSrc',t:'text',d:'02:c5:00:00:00:01',label:'who is here, Wi-Fi: source MAC of the probe request',short:'probe MAC'},
          {n:'whoWifi',t:'button',label:'Who is here: Wi-Fi (probe request on every channel)',fn:n=>radioWhoWifi(n)},
          {n:'whoZb',t:'button',label:'Who is here: Zigbee (beacon request, channels 11…26)',fn:n=>radioWhoZb(n)},
          {n:'tlScan',t:'button',label:'Who is here: Touchlink scan (channels 11 / 15 / 20 / 25)',fn:n=>radioTlScan(n)},
          {n:'identTarget',t:'text',d:'',label:'highlight Zigbee: IEEE address of a device that answered the Touchlink scan (or wire its row to «identify»)',short:'identify'},
          {n:'identSec',t:'range',min:1,max:30,step:1,d:5,label:'highlight Zigbee: blink time, s',short:'blink s'},
          {n:'identGo',t:'button',label:'Highlight Zigbee device (Touchlink identify)',fn:n=>radioIdentify(n,n.p.identTarget)},
          {n:'findTarget',t:'text',d:'',label:'highlight BLE: address of a Find Me tag (or wire its row to «find»)',short:'BLE find'},
          {n:'findLevel',t:'select',opts:['2','1','0'],d:'2',label:'highlight BLE: alert level (2 high, 1 mild, 0 off)',short:'alert'},
          {n:'findGo',t:'button',label:'Highlight BLE device (Find Me alert)',fn:n=>radioBleFind(n,n.p.findTarget)},
          {n:'ftmPeer',t:'text',d:'',label:'FTM: responder MAC (aa:bb:cc:dd:ee:ff)',short:'FTM peer'},
          {n:'ftmFrames',t:'select',opts:['8','16','24','32','64'],d:'16',label:'FTM: frames per burst',short:'FTM frames'},
          {n:'ftmChan',t:'num',d:0,label:'FTM: responder channel (0 — current)',short:'FTM ch'},
          {n:'ftmCal',t:'num',d:0,label:'FTM: calibration offset, m (subtracted from distance)',short:'FTM cal'},
          {n:'ftmGo',t:'button',label:'Range (FTM)',fn:n=>radioFtmNow(n,n.p.ftmPeer)},
          {n:'ftmResp',t:'check',d:false,label:'answer FTM requests (our AP becomes visible as «bridge»; its MAC is in the reply line)',short:'answer FTM',fn:n=>radioSend(n,radioCfg(n))},
          {n:'arProbe',t:'check',d:false,label:'auto-reply to Probe requests (Wi-Fi; set a fixed channel)'},
          {n:'arSsid',t:'text',d:'',label:'auto-reply: SSID to answer for'},
          {n:'arBssid',t:'text',d:'02:00:00:00:00:01',label:'auto-reply: our BSSID (MAC)'},
          {n:'txProto',t:'select',opts:['WIFI','BLE','ZB'],d:'WIFI',label:'tx: protocol for bare hex'},
          {n:'csma',t:'check',d:false,label:'tx: ZB with CSMA'},
          {n:'baud',t:'num',d:115200,label:'baud (ignored by USB-CDC chips)',adv:true},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ n.pend=[]; n.pendStat=[]; n.pendCsi=[]; n.pendFtm=[]; n.frames=0; n.sent=0; n.txCount=0; n.replies=0; n.ftmReq=0; }}],
  init:n=>{ n.zllSeen=new Map(); n.zllTid=0; n.zbSeq=0; n.sweepTok=0; n.sweepMsg=''; n.identCount=0; n.identLast=''; n.findCount=0; n.findLast=''; n.lastIdent=null; n.lastFind=null; n.csiSt=new Map(); n.binBad=0; n.pend=[]; n.pendStat=[]; n.pendCsi=[]; n.pendFtm=[]; n.ftmReq=0; n.ftmRespSent=false; n.lastFtm=null; n.frames=0; n.sent=0; n.lastText=null; n.lastBin=null; n.lastProto='wifi'; n.binId=0; n.binSent=0; n.binOut=null;
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
    if(typeof I.ftm==='string' && I.ftm!==n.lastFtm){
      n.lastFtm=I.ftm;
      for(const line of I.ftm.split(/[\r\n;]+/)) if(line.trim()) radioFtmNow(n,line);
    }
    if(I.identify!==n.lastIdent){ n.lastIdent=I.identify; const r=recList(I.identify)[0]; if(r) radioIdentify(n,r); }     // щелчок по строке таблицы → устройство мигает
    if(I.find!==n.lastFind){ n.lastFind=I.find; const r=recList(I.find)[0]; if(r) radioBleFind(n,r); }
    if(I.txrec!==n.lastTxRec){ n.lastTxRec=I.txrec; for(const r of recList(I.txrec)) radioTxNow(n,r); }
    if(I.txbin && I.txbin.id!==n.lastTxBin){ n.lastTxBin=I.txbin.id; if(I.txbin.d && I.txbin.d.length) radioTxNow(n,I.txbin.d); }
    const recs=n.pend; n.pend=[]; n.sent+=recs.length;
    const st=n.pendStat, cs=n.pendCsi, fr=n.pendFtm; n.pendStat=[]; n.pendCsi=[]; n.pendFtm=[];
    if(n.binSent!==n.binId){ n.binSent=n.binId; n.binOut=binObj(n.lastBin,n.lastProto+'-frame'); }
    return {rec:recs.length ? recs : null, stat:st.length ? st : null, csi:cs.length ? cs : null, ftmr:fr.length ? fr : null, bin:n.binOut, count:n.sent, frames:n.frames};
  },
  drawKey:n=>n.sweepMsg+'|'+n.identCount+'|'+n.findCount+'|'+n.status+'|'+n.binBad+'|'+n.frames+'|'+n.txCount+'|'+n.replies+'|'+n.reply+'|'+n.txErr,
  draw(n){
    const el=n.el.querySelector('.readout'); if(!el) return;
    const s=n.status+' · '+n.frames+' frames · '+n.sent+' records · tx '+n.txCount+(n.replies ? ' ('+n.replies+' auto-replies)' : '')+(n.ftmReq ? ' · ftm '+n.ftmReq : '')+(n.binBad ? ' · bad packets '+n.binBad : '')+(n.sweepMsg ? '\n'+n.sweepMsg : '')+(n.identLast ? '\nidentify '+n.identLast : '')+(n.findLast ? '\nBLE find '+n.findLast : '')+(n.txErr ? ' ('+n.txErr+')' : '')+
      (n.reply ? '\n'+n.reply : '')+(n.txLast ? '\ntx: '+n.txLast : '');
    if(el.textContent!==s) el.textContent=s;
  }});
