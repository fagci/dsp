"use strict";
/* ============================ Termux / приложение DSP ============================
   Телефон как источник (Termux-мост или приложение tools/android): GPS, датчики, батарея, Wi-Fi и соты. Мост tools/termux/bridge.mjs
   или приложение DSP отдаёт JSON-записи по WebSocket; узел сам просит нужные источники ({"sub":[…],"hz":200}).
   Разбор записей — в termux-kernels.js, транспорт и mixed-content проверка — как у Text over Network. */

function termuxStop(n){
  n.want=false; clearTimeout(n.timer); n.timer=null;
  const ws=n.ws; n.ws=null;
  if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
  n.status='disconnected';
}
function termuxSendSub(n){
  const m=termuxSubMsg(n.p), sig=JSON.stringify(m);
  if(n.ws && n.ws.readyState===1 && sig!==n.sentSub){ n.sentSub=sig; n.ws.send(sig); }
}
function termuxStart(n){
  termuxStop(n);
  const url=gwUrl(String(n.p.url||'').trim());
  if(!/^wss?:/i.test(url)){ n.status=gwErr(n.p.url)||'URL must start with ws:// or wss://'; return; }
  n.want=true; n.warn=netInsecure(url) ? NET_INSECURE_MSG : '';
  let ws;
  try{ ws=new WebSocket(url); }
  catch(e){ n.status='error: '+e.message; termuxRetry(n); return; }
  n.ws=ws; n.status='connecting…'; n.sentSub=null;
  ws.onopen=()=>{ n.status='connected'; termuxSendSub(n); };
  ws.onerror=()=>{ n.status='connection error — is the bridge running? (node bridge.mjs in Termux)'; };
  ws.onclose=e=>{
    if(n.ws!==ws) return;
    n.ws=null; n.status='closed'+(e.code!==1000 ? ' ('+e.code+')' : '')+(n.p.reconnect ? ' — reconnecting…' : '');
    termuxRetry(n);
  };
  ws.onmessage=e=>{
    if(typeof e.data!=='string') return;
    let j; try{ j=JSON.parse(e.data); }catch(x){ return; }
    for(const r of Array.isArray(j) ? j : [j]) termuxFeed(n,r);
  };
}
function termuxRetry(n){ if(n.want && n.p.reconnect){ clearTimeout(n.timer); n.timer=setTimeout(()=>{ if(n.want) termuxStart(n); },3000); } }
// PCM микрофона → поток отсчётов с метками (ssPush, sources.js): выдаётся по часам блоков движка, как у датчиков
function termuxMic(n,r){
  const a=termuxPcm(r), sr=+r.sr; if(!a || !(sr>0)) return;
  const K=termuxMicK(n.p), rc=+r.ch===2 ? 2 : 1, fr=a.length/rc|0;   // pcm чередует L,R: отсчёты обоих каналов — один кадр с одной меткой, сдвига между ними нет
  const wall=performance.now()/1000, dur=fr/sr;
  if(!n.micT || Math.abs(n.micT-(wall-dur))>.5){ n.micT=wall-dur; if(n.micT0) ssInit(n,K); n.micT0=1; n.sExact=true; n.sLag=termuxMicLag(n.p); }
  n.micCh=rc; if(r.info){ n.micInfo=termuxMicInfo(r.info); n.micInfoRaw=r.info; }
  for(let i=0;i<fr;i++){ const l=a[i*rc]; ssPush(n,n.micT+i/sr,K===2 ? [l,rc===2 ? a[i*rc+1] : l] : [l]); }
  n.micT+=dur;
}
function termuxFeed(n,r){
  if(!r || typeof r!=='object') return;
  n.msgs++; n.last=termuxLine(r);
  if(r.src==='bridge'){ if(r.level==='error' || r.level==='warn') n.bridgeMsg=r.msg; return; }
  termuxApply(n.vals,r);
  const d=termuxDev(r);                       // wifi / ble / bt / cell: dev, name, rssi; точка замера — на выход pts
  if(d){
    r={...r,...d};
    if(!termuxThin(n.devSeen,r,Date.now(),+n.p.devEvery,+n.p.devMove)) return;
    if(typeof r.lat==='number' && typeof r.rssi==='number'){ n.ptQ.push(termuxPoint(r,'m'+(++n.ptSeq))); if(n.ptQ.length>5000) n.ptQ.splice(0,n.ptQ.length-5000); }
  }
  if(r.src==='mic'){ termuxMic(n,r); return; }
  if(r.src==='nmea'){ if(r.line){ n.nmeaQ.push(r.line); if(n.nmeaQ.length>2000) n.nmeaQ.splice(0,n.nmeaQ.length-2000); } return; }
  n.recQ.push({t:Date.now(), ...r});
  if(n.recQ.length>20000) n.recQ.splice(0,n.recQ.length-20000);
  n.lineQ.push(n.last);
  if(n.lineQ.length>2000) n.lineQ.splice(0,n.lineQ.length-2000);
}

const TERMUX_OUTS=['lat','lon','alt','acc','speed','hdg','ax','ay','az','gx','gy','gz','mx','my','mz','light','press','prox','atemp','humid','steps','heading','hinge','yaw','pitch','roll','orient','still','sigm','cdbm','crsrp','crsrq','csinr','micdb','batt','charging','temp','nsat','nused','cn0','therm','saver','thr','extv','act','cadence','locked','screen','pick','wakeg','glanc','tiltc','offb'];
// Чекбоксы источников: у каждого есть скрытый вход-пин с тем же именем (число ≥0.5 — включить), появляется при подключении провода.
const TERMUX_PINS=['gps','battery','accel','gyro','mag','light','pressure','gravity','linear','rotation','gamerot','georot','accelraw','gyroraw','magraw','proximity','ambtemp','humidity','steps','heading','hinge','wifi','ble','bt','gnss','gnssraw','nmea','cell','mic','pkt','step','devorient','sigmotion','stationary','motion','power','ext','activity','pickup','wakegest','glance','tilt','offbody'];
def({ id:'termux', title:'Phone sensors (Termux / DSP app)', cat:'Sources', kw:'termux android app phone background bluetooth ble gnss satellites nmea raw measurements gps accelerometer gyroscope magnetometer battery wifi cell sensors enable gate away from home',
  ins:TERMUX_PINS.map(k=>({n:k,t:'num'})), outs:[{n:'rec',t:'rec'},{n:'pts',t:'rec'},{n:'line',t:'txt'},{n:'nmeatxt',t:'txt'},{n:'mic',t:'sig'},{n:'micB',t:'sig'},{n:'go',t:'num'},...TERMUX_OUTS.map(k=>({n:k,t:'num'}))],
  readout:true, tall:true,
  groups:[{n:'Position & battery'},{n:'Motion (accel · gyro · mag)',open:false},{n:'Orientation & activity',open:false},{n:'Environment',open:false},{n:'Wi-Fi',open:false},{n:'Bluetooth LE / classic',open:false},{n:'GNSS',open:false},{n:'Cell & microphone',open:false},{n:'Packet capture (root)',open:false},{n:'Device records',open:false}],
  params:[
    {n:'url',t:'text',d:'ws://127.0.0.1:8765',dev:true,label:'bridge: ws://host:8765/?token=… — or @name from Settings → Devices (the token stays there)'},
    {n:'gps',g:'Position & battery',t:'check',d:true,label:'GPS position'},
    {n:'battery',g:'Position & battery',t:'check',d:true,label:'battery'},
    {n:'power',g:'Position & battery',t:'check',d:false,label:'power state → «batt» «charging» «therm» (0–6, 3+ = severe) «saver» «thr» (how many times the app slows its polling) (DSP app)'},
    {n:'accel',g:'Motion (accel · gyro · mag)',t:'check',d:false,label:'accelerometer'},
    {n:'gyro',g:'Motion (accel · gyro · mag)',t:'check',d:false,label:'gyroscope'},
    {n:'mag',g:'Motion (accel · gyro · mag)',t:'check',d:false,label:'magnetometer'},
    {n:'light',g:'Environment',t:'check',d:false,label:'light'},
    {n:'pressure',g:'Environment',t:'check',d:false,label:'pressure'},
    {n:'gravity',g:'Motion (accel · gyro · mag)',t:'check',d:false,label:'gravity (DSP app) → rec'},
    {n:'linear',g:'Motion (accel · gyro · mag)',t:'check',d:false,label:'linear acceleration, no gravity (DSP app) → rec'},
    {n:'rotation',g:'Orientation & activity',t:'check',d:false,label:'rotation vector → yaw / pitch / roll (DSP app)'},
    {n:'gamerot',g:'Orientation & activity',t:'check',d:false,label:'game rotation vector, no magnetometer (DSP app) → rec'},
    {n:'georot',g:'Orientation & activity',t:'check',d:false,label:'geomagnetic rotation vector (DSP app) → rec'},
    {n:'accelraw',g:'Motion (accel · gyro · mag)',t:'check',d:false,label:'accelerometer, uncalibrated + bias (DSP app) → rec'},
    {n:'gyroraw',g:'Motion (accel · gyro · mag)',t:'check',d:false,label:'gyroscope, uncalibrated + drift bias (DSP app) → rec'},
    {n:'magraw',g:'Motion (accel · gyro · mag)',t:'check',d:false,label:'magnetometer, uncalibrated + bias (DSP app) → rec'},
    {n:'proximity',g:'Environment',t:'check',d:false,label:'proximity, cm (DSP app)'},
    {n:'ambtemp',g:'Environment',t:'check',d:false,label:'ambient temperature, °C (DSP app; few phones have it)'},
    {n:'humidity',g:'Environment',t:'check',d:false,label:'relative humidity, % (DSP app; few phones have it)'},
    {n:'steps',g:'Orientation & activity',t:'check',d:false,label:'step counter since boot (DSP app; needs Physical activity permission)'},
    {n:'heading',g:'Orientation & activity',t:'check',d:false,label:'compass heading, ° (DSP app; Android 14+)'},
    {n:'hinge',g:'Orientation & activity',t:'check',d:false,label:'hinge angle, ° (DSP app; foldables)'},
    {n:'wifi',g:'Wi-Fi',t:'check',d:false,label:'Wi-Fi scan (with the position; DSP app: channel, width, security, standard, WPS, country)'},
    {n:'wifiEvery',g:'Wi-Fi',t:'range',min:1,max:600,step:1,d:10,label:'Wi-Fi scan every, s (DSP app; Android limits it)'},
    {n:'ble',g:'Bluetooth LE / classic',t:'check',d:false,label:'Bluetooth LE advertisements (DSP app)'},
    {n:'bleMode',g:'Bluetooth LE / classic',t:'select',opts:['low_latency','balanced','low_power','opportunistic'],d:'low_latency',label:'BLE scan mode (opportunistic — only piggybacks on other apps\' scans)',adv:true},
    {n:'bleLegacy',g:'Bluetooth LE / classic',t:'select',opts:['legacy + extended','extended only'],d:'legacy + extended',label:'BLE advertising',adv:true},
    {n:'blePhy',g:'Bluetooth LE / classic',t:'select',opts:['all','1m','coded'],d:'all',label:'BLE scan PHY (coded — long range, 125/500 kbps)',adv:true},
    {n:'bleMatch',g:'Bluetooth LE / classic',t:'select',opts:['default','aggressive','sticky'],d:'default',label:'BLE match mode (aggressive — more results, more false matches)',adv:true},
    {n:'bleDelay',g:'Bluetooth LE / classic',t:'range',min:0,max:30000,step:500,d:0,label:'BLE batch delay, ms (0 — deliver each advertisement at once; saves battery)',adv:true},
    {n:'bleName',g:'Bluetooth LE / classic',t:'text',d:'',label:'BLE filter: name starts with',adv:true},
    {n:'bleAddr',g:'Bluetooth LE / classic',t:'text',d:'',label:'BLE filter: address AA:BB:CC:DD:EE:FF',adv:true},
    {n:'bleUuid',g:'Bluetooth LE / classic',t:'text',d:'',label:'BLE filter: advertised service UUID',adv:true},
    {n:'bleMfr',g:'Bluetooth LE / classic',t:'text',d:'',label:'BLE filter: manufacturer id, hex (004C — Apple, 0075 — Samsung…)',adv:true},
    {n:'bt',g:'Bluetooth LE / classic',t:'check',d:false,label:'Bluetooth classic discovery (DSP app)'},
    {n:'gnss',g:'GNSS',t:'check',d:false,label:'GNSS: every satellite — system, C/N0, elevation, azimuth, used in fix (DSP app)'},
    {n:'gnssraw',g:'GNSS',t:'check',d:false,label:'GNSS: raw measurements — pseudorange rate, carrier phase, clock (DSP app)'},
    {n:'nmea',g:'GNSS',t:'check',d:false,label:'NMEA sentences → output «nmeatxt» → NMEA Parser (DSP app)'},
    {n:'devEvery',g:'Device records',t:'range',min:0,max:60,step:1,d:0,label:'Wi-Fi / BLE / BT / cells: one record per device at most every N s (0 — all)'},
    {n:'devMove',g:'Device records',t:'range',min:0,max:200,step:1,d:0,label:'… and only after moving N m (0 — any)'},
    {n:'cell',g:'Cell & microphone',t:'check',d:false,label:'cell towers: operator, cell id, band, RSRP / RSRQ / SINR (rec; serving cell → cdbm crsrp crsrq csinr)'},
    {n:'cellEvery',g:'Cell & microphone',t:'range',min:1,max:120,step:1,d:5,label:'cell poll every, s (DSP app)'},
    {n:'mic',g:'Cell & microphone',t:'check',d:false,label:'microphone → output «mic» (signal), level in «micdb» (DSP app, also with the screen locked)'},
    {n:'micHz',g:'Cell & microphone',t:'select',opts:['8000','16000','22050','44100','48000','96000','192000'],d:'16000',label:'microphone: sample rate, Hz (the DSP app tries the nearest standard one if the phone cannot open it; the real one is in the record, sr). Above 8 kHz of signal needs 22050 and more'},
    {n:'micSrc',g:'Cell & microphone',t:'select',opts:['auto','unprocessed','mic','camcorder','voice_recognition','voice_comm','performance','voice_call','downlink','uplink','submix'],d:'auto',label:'microphone: source in the DSP app — auto = unprocessed (no noise suppression / AGC) if the phone has it, else mic; voice_call / downlink (the other side) / uplink (your voice) / submix (what the phone plays) need root («Allow root features» in the app Settings) and the phone\'s audio HAL to give them'},
    {n:'micAddr',g:'Cell & microphone',t:'select',opts:n=>termuxMicAddrs(n.micInfoRaw,n.p.micAddr),d:'auto',label:'microphone: input of the phone (DSP app) — the list is filled from what the phone reports while the microphone runs (open it after connecting; «bottom», «back»…). auto — by «preferred input» only'},
    {n:'micCh',g:'Cell & microphone',t:'select',opts:['mono','stereo'],d:'mono',label:'microphone: channels (DSP app) — stereo = two microphones of the phone in one recording: «mic» is the left, «micB» the right channel, samples of both from the same ADC frame, so there is no time shift between them (the phase difference is real). Use source unprocessed or camcorder; the order of the microphones depends on the phone; if it has no stereo input the app falls back to mono (see the status)',fn:n=>{ n.micT=0; }},
    {n:'micLow',g:'Cell & microphone',t:'check',d:false,label:'microphone: low latency (DSP app) — pieces of 10 ms, the bridge sends them at once, a small buffer on the phone and a short smoothing reserve here (below). Costs more CPU and risks gaps on a busy phone; for the least delay also set Block size 128 in the toolbar'},
    {n:'micLag',g:'Cell & microphone',t:'range',min:20,max:300,step:5,d:60,label:'microphone: smoothing reserve in low latency, ms (less — shorter delay, but gaps if the pieces come unevenly)',if:n=>n.p.micLow},
    {n:'micDev',g:'Cell & microphone',t:'select',opts:['auto','usb','wired','bluetooth','builtin'],d:'auto',label:'microphone: preferred input in the DSP app (a USB microphone / headset, wired, Bluetooth, built-in); noise suppression, AGC and echo cancellation are switched off anyway'},
    {n:'ext',g:'Device records',t:'check',d:false,label:'events from other apps (Tasker / MacroDroid intent app.dsp.phone.EXT) → rec, number in «extv» (DSP app; allow in its Settings)'},
    {n:'pkt',g:'Packet capture (root)',t:'check',d:false,label:'packet capture, frames in hex → rec (DSP app; root + tcpdump; allow it in the app Settings)'},
    {n:'iface',g:'Packet capture (root)',t:'text',d:'any',label:'capture: interface (any, wlan0, rmnet_data0…)'},
    {n:'filter',g:'Packet capture (root)',t:'text',d:'',label:'capture: filter (tcpdump syntax, e.g. tcp port 80)'},
    {n:'snap',g:'Packet capture (root)',t:'select',opts:['64','128','256','512','1500','65535'],d:'256',label:'capture: bytes per frame'},
    {n:'activity',g:'Orientation & activity',t:'check',d:false,label:'activity: still / moving / walking + screen locked → «act» (0 still, 1 moving, 2 walking) «cadence» «locked» «screen»; low power, works with the screen locked (DSP app; log to a file in its Settings)'},
    {n:'pickup',g:'Orientation & activity',t:'check',d:false,label:'pick-up gesture (phone lifted) → counter «pick»'},
    {n:'wakegest',g:'Orientation & activity',t:'check',d:false,label:'wake gesture → counter «wakeg»'},
    {n:'glance',g:'Orientation & activity',t:'check',d:false,label:'glance gesture → counter «glanc»'},
    {n:'tilt',g:'Orientation & activity',t:'check',d:false,label:'tilt detector → counter «tiltc»'},
    {n:'offbody',g:'Orientation & activity',t:'check',d:false,label:'off-body detector (watches, bands) → «offb» 1 on the body, 0 taken off'},
    {n:'step',g:'Orientation & activity',t:'check',d:false,label:'step detector (DSP app) → rec'},
    {n:'devorient',g:'Orientation & activity',t:'check',d:false,label:'screen orientation 0–3 (DSP app; Android 13+)'},
    {n:'sigmotion',g:'Orientation & activity',t:'check',d:false,label:'significant motion (DSP app; one-shot trigger)'},
    {n:'stationary',g:'Orientation & activity',t:'check',d:false,label:'stationary detect → still=1 (DSP app)'},
    {n:'motion',g:'Orientation & activity',t:'check',d:false,label:'motion detect → still=0 (DSP app)'},
    {n:'hz',g:'Motion (accel · gyro · mag)',t:'select',opts:['0','10','50','100','200','500','1000'],d:'0',label:'sensor rate, Hz (DSP app; 0 — default; the phone gives what the sensor can)'},
    {n:'reconnect',t:'check',d:true,label:'reconnect'},
    {n:'connect',t:'button',label:'Connect',fn:n=>termuxStart(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>{ n.resume=false; termuxStop(n); }},
  ],
  init:n=>{ ssInit(n,termuxMicK(n.p)); n.sExact=true; n.sLag=.25; n.micT=0; n.micT0=0; n.devSeen=new Map(); n.ptQ=[]; n.ptSeq=0; n.ws=null; n.want=false; n.timer=null; n.recQ=[]; n.lineQ=[]; n.nmeaQ=[]; n.vals={}; n.last=''; n.msgs=0; n.count=0;
            n.status='not connected'; n.warn=''; n.sentSub=null; n.bridgeMsg=''; },
  dispose:n=>termuxStop(n),
  onStop:n=>{ n.resume=n.want; termuxStop(n); },       // стоп движка — отпускаем мост (датчики, микрофон на телефоне)
  onRun:n=>{ if(n.resume){ n.resume=false; termuxStart(n); } },
  process(n,I){
    for(const k of TERMUX_PINS){ const v=I[k]; if(typeof v==='number' && isFinite(v) && n.p[k]!==(v>=.5)) setMod(n,k,v>=.5); }
    termuxSendSub(n);
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    let line=n.lineQ.length ? n.lineQ[n.lineQ.length-1] : n.lastLine||'';
    n.lineQ.length=0; n.lastLine=line;
    const nm=n.nmeaQ.length ? n.nmeaQ.splice(0).join('\n')+'\n' : '';
    const o={rec, pts:n.ptQ.length ? n.ptQ.splice(0) : null, line, nmeatxt:nm, go:rec ? 1 : 0};
    for(const k of TERMUX_OUTS) o[k]=n.vals[k] ?? null;
    const K=termuxMicK(n.p);
    if(n.p.mic){
      if(n.sK!==K){ ssInit(n,K); n.micT=0; n.micT0=0; n.sExact=true; }
      n.sLag=termuxMicLag(n.p); const m=buf(n,'mic'), mb=buf(n,'micB');
      if(K===2) ssProcess(n,[m,mb]); else { ssProcess(n,[m]); mb.fill(0); }
      o.mic=m; o.micB=mb; }
    else { if(n.micT || n.sK!==K){ ssInit(n,K); n.micT=0; n.micT0=0; n.sExact=true; n.sLag=.25; } o.mic=buf(n,'mic').fill(0); o.micB=buf(n,'micB').fill(0); }
    return o;
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const o=n.vals, f=(v,d)=>v==null ? '—' : (+v).toFixed(d);
    let t=(n.warn&&!n.ws&&n.status!=='connected' ? '⚠ '+n.warn+'\n' : '')+n.status+' · records '+n.msgs;
    if(n.bridgeMsg) t+='\n⚠ '+n.bridgeMsg;
    if(o.lat!=null) t+='\n'+f(o.lat,5)+', '+f(o.lon,5)+'  alt '+f(o.alt,0)+' m  ±'+f(o.acc,0)+' m  '+f(o.speed,1)+' m/s';
    if(o.ax!=null) t+='\naccel '+f(o.ax,2)+' '+f(o.ay,2)+' '+f(o.az,2);
    if(o.gx!=null) t+='\ngyro  '+f(o.gx,2)+' '+f(o.gy,2)+' '+f(o.gz,2);
    if(o.mx!=null) t+='\nmag   '+f(o.mx,1)+' '+f(o.my,1)+' '+f(o.mz,1);
    if(o.nsat!=null) t+='\nsatellites '+f(o.nused,0)+' used of '+f(o.nsat,0)+(o.cn0!=null ? ', C/N0 '+f(o.cn0,0)+' dB-Hz' : '');
    if(o.yaw!=null) t+='\norientation yaw '+f(o.yaw,0)+'° pitch '+f(o.pitch,0)+'° roll '+f(o.roll,0)+'°';
    if(o.heading!=null) t+='\nheading '+f(o.heading,0)+'°';
    if(o.prox!=null) t+='\nproximity '+f(o.prox,1)+' cm';
    if(o.atemp!=null) t+='\nambient '+f(o.atemp,1)+' °C';
    if(o.humid!=null) t+='\nhumidity '+f(o.humid,0)+' %';
    if(o.steps!=null) t+='\nsteps '+f(o.steps,0);
    if(o.hinge!=null) t+='\nhinge '+f(o.hinge,0)+'°';
    if(o.cdbm!=null) t+='\ncell '+f(o.cdbm,0)+' dBm'+(o.crsrp!=null ? '  RSRP '+f(o.crsrp,0)+' RSRQ '+f(o.crsrq,0) : '');
    if(n.p.mic && n.micInfo && n.micInfo.length) t+='\n'+n.micInfo.join('\n');
    if(o.micdb!=null) t+='\nmic '+f(o.micdb,0)+' dBFS'+(n.p.mic && n.micCh ? ' · '+(n.micCh===2 ? 'stereo' : 'mono')+(n.p.micCh==='stereo' && n.micCh!==2 ? ' (the phone gave no stereo)' : '') : '');
    if(n.p.mic && o.micdb!=null){ const l=typeof Eng!=='undefined' && Eng.latencyMs ? Eng.latencyMs() : null, buf=Math.max(n.sLag||0,3*(n.sDt||0))*1000;
      t+='\nmic → output ≈ '+Math.round(buf+(l ? l.totalMs : 0))+' ms (smoothing '+Math.round(buf)+(l ? ' + engine '+Math.round(l.queueMs)+' + device '+Math.round(l.hardwareMs) : '')+')'; }
    if(o.orient!=null) t+='\nscreen orientation '+f(o.orient,0);
    if(o.act!=null) t+='\nactivity '+['still','moving','walking'][o.act]+(o.cadence ? ' '+f(o.cadence,0)+' steps/min' : '')+(o.locked ? '  (screen locked)' : '');
    if(o.pick!=null) t+='\npicked up '+f(o.pick,0)+'×';
    if(o.still!=null) t+='\n'+(o.still ? 'stationary' : 'moving');
    if(o.light!=null) t+='\nlight '+f(o.light,0)+' lx';
    if(o.press!=null) t+='\npressure '+f(o.press,1)+' hPa';
    if(o.therm!=null) t+='\nthermal '+f(o.therm,0)+(o.saver ? '  power saver' : '')+(o.thr>1 ? '  polling ÷'+f(o.thr,0) : '');
    if(o.cpupct!=null) t+='\nbridge CPU '+f(o.cpupct,1)+' % of a core'+(o.wake ? ' · wake lock held' : '')+(o.nclients!=null ? ' · '+o.nclients+' client(s)' : '')+(o.held ? '\nholding open: '+o.held : '');
    if(o.extv!=null) t+='\next '+f(o.extv,2);
    if(o.batt!=null) t+='\nbattery '+f(o.batt,0)+'%'+(o.charging ? ' (charging)' : '')+(o.temp!=null ? '  '+f(o.temp,1)+' °C' : '');
    if(r.textContent!==t) r.textContent=t; }
});
