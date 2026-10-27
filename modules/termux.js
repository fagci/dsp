"use strict";
/* ============================ Termux / приложение DSP ============================
   Телефон как источник (Termux-мост или приложение tools/android): GPS, датчики, батарея, Wi-Fi и соты. Мост tools/termux/bridge.mjs
   или приложение DSP отдаёт JSON-записи по WebSocket; узел сам просит нужные источники ({"sub":[…],"hz":200}).
   Приложение ещё отдаёт камеру MJPEG на том же порту — адрес на выходе camurl (→ url узла IP Camera).
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
  const url=String(n.p.url||'').trim();
  if(!/^wss?:/i.test(url)){ n.status='URL must start with ws:// or wss://'; return; }
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
  const wall=performance.now()/1000, dur=a.length/sr;
  if(!n.micT || Math.abs(n.micT-(wall-dur))>.5){ n.micT=wall-dur; if(n.micT0) ssInit(n,1); n.micT0=1; n.sExact=true; n.sLag=.25; }
  for(let i=0;i<a.length;i++) ssPush(n,n.micT+i/sr,[a[i]]);
  n.micT+=dur;
}
// яркость кадра высокоскоростной камеры (DSP app): пачка отсчётов v с шагом dt мс, последний — только что снят → поток отсчётов с метками, как у микрофона
function termuxLum(n,r){
  const v=r.v, dt=(+r.dt||0)/1000; if(!Array.isArray(v) || !v.length || !(dt>0)) return;
  let L=n.lumS; if(!L){ L=n.lumS={}; ssInit(L,1); }
  const wall=performance.now()/1000, dur=v.length*dt;
  if(!L.T || Math.abs(L.T-(wall-dur))>.5){ L.T=wall-dur; if(L.T0) ssInit(L,1); L.T0=1; L.sExact=true; L.sLag=.25; }
  for(let i=0;i<v.length;i++) ssPush(L,L.T+i*dt,[+v[i]||0]);
  L.T+=dur; n.lumRate=1/dt;
}
function termuxFeed(n,r){
  if(!r || typeof r!=='object') return;
  n.msgs++; n.last=termuxLine(r);
  if(r.src==='bridge'){ if(r.level==='error' || r.level==='warn') n.bridgeMsg=r.msg; if(r.level==='hello' && Array.isArray(r.cameraInfo)) n.camInfo=r.cameraInfo; return; }
  termuxApply(n.vals,r);
  const d=termuxDev(r);                       // wifi / ble / bt / cell: dev, name, rssi; точка замера — на выход pts
  if(d){
    r={...r,...d};
    if(!termuxThin(n.devSeen,r,Date.now(),+n.p.devEvery,+n.p.devMove)) return;
    if(typeof r.lat==='number' && typeof r.rssi==='number'){ n.ptQ.push(termuxPoint(r,'m'+(++n.ptSeq))); if(n.ptQ.length>5000) n.ptQ.splice(0,n.ptQ.length-5000); }
  }
  if(r.src==='mic'){ termuxMic(n,r); return; }
  if(r.src==='lum'){ termuxLum(n,r); return; }
  if(r.src==='nmea'){ if(r.line){ n.nmeaQ.push(r.line); if(n.nmeaQ.length>2000) n.nmeaQ.splice(0,n.nmeaQ.length-2000); } return; }
  n.recQ.push({t:Date.now(), ...r});
  if(n.recQ.length>20000) n.recQ.splice(0,n.recQ.length-20000);
  n.lineQ.push(n.last);
  if(n.lineQ.length>2000) n.lineQ.splice(0,n.lineQ.length-2000);
}

const TERMUX_OUTS=['lat','lon','alt','acc','speed','hdg','ax','ay','az','gx','gy','gz','mx','my','mz','light','press','prox','atemp','humid','steps','heading','hinge','yaw','pitch','roll','orient','still','sigm','cdbm','crsrp','crsrq','csinr','micdb','lumv','batt','charging','temp','nsat','nused','cn0'];
def({ id:'termux', title:'Phone sensors (Termux / DSP app)', cat:'Sources', kw:'termux android app phone camera background bluetooth ble gnss satellites nmea raw measurements gps accelerometer gyroscope magnetometer battery wifi cell sensors',
  ins:[], outs:[{n:'rec',t:'rec'},{n:'pts',t:'rec'},{n:'line',t:'txt'},{n:'camurl',t:'txt'},{n:'nmeatxt',t:'txt'},{n:'mic',t:'sig'},{n:'lum',t:'sig'},{n:'go',t:'num'},...TERMUX_OUTS.map(k=>({n:k,t:'num'}))],
  readout:true, tall:true,
  params:[
    {n:'url',t:'text',d:'ws://127.0.0.1:8765',label:'bridge: ws://host:8765/?token=…'},
    {n:'gps',t:'check',d:true,label:'GPS position'},
    {n:'battery',t:'check',d:true,label:'battery'},
    {n:'accel',t:'check',d:false,label:'accelerometer'},
    {n:'gyro',t:'check',d:false,label:'gyroscope'},
    {n:'mag',t:'check',d:false,label:'magnetometer'},
    {n:'light',t:'check',d:false,label:'light'},
    {n:'pressure',t:'check',d:false,label:'pressure'},
    {n:'gravity',t:'check',d:false,label:'gravity (DSP app) → rec'},
    {n:'linear',t:'check',d:false,label:'linear acceleration, no gravity (DSP app) → rec'},
    {n:'rotation',t:'check',d:false,label:'rotation vector → yaw / pitch / roll (DSP app)'},
    {n:'gamerot',t:'check',d:false,label:'game rotation vector, no magnetometer (DSP app) → rec'},
    {n:'georot',t:'check',d:false,label:'geomagnetic rotation vector (DSP app) → rec'},
    {n:'accelraw',t:'check',d:false,label:'accelerometer, uncalibrated + bias (DSP app) → rec'},
    {n:'gyroraw',t:'check',d:false,label:'gyroscope, uncalibrated + drift bias (DSP app) → rec'},
    {n:'magraw',t:'check',d:false,label:'magnetometer, uncalibrated + bias (DSP app) → rec'},
    {n:'proximity',t:'check',d:false,label:'proximity, cm (DSP app)'},
    {n:'ambtemp',t:'check',d:false,label:'ambient temperature, °C (DSP app; few phones have it)'},
    {n:'humidity',t:'check',d:false,label:'relative humidity, % (DSP app; few phones have it)'},
    {n:'steps',t:'check',d:false,label:'step counter since boot (DSP app; needs Physical activity permission)'},
    {n:'heading',t:'check',d:false,label:'compass heading, ° (DSP app; Android 14+)'},
    {n:'hinge',t:'check',d:false,label:'hinge angle, ° (DSP app; foldables)'},
    {n:'wifi',t:'check',d:false,label:'Wi-Fi scan (with the position; DSP app: channel, width, security, standard, WPS, country)'},
    {n:'wifiEvery',t:'range',min:1,max:600,step:1,d:10,label:'Wi-Fi scan every, s (DSP app; Android limits it)'},
    {n:'ble',t:'check',d:false,label:'Bluetooth LE advertisements (DSP app)'},
    {n:'bt',t:'check',d:false,label:'Bluetooth classic discovery (DSP app)'},
    {n:'gnss',t:'check',d:false,label:'GNSS: every satellite — system, C/N0, elevation, azimuth, used in fix (DSP app)'},
    {n:'gnssraw',t:'check',d:false,label:'GNSS: raw measurements — pseudorange rate, carrier phase, clock (DSP app)'},
    {n:'nmea',t:'check',d:false,label:'NMEA sentences → output «nmeatxt» → NMEA Parser (DSP app)'},
    {n:'devEvery',t:'range',min:0,max:60,step:1,d:0,label:'Wi-Fi / BLE / BT / cells: one record per device at most every N s (0 — all)'},
    {n:'devMove',t:'range',min:0,max:200,step:1,d:0,label:'… and only after moving N m (0 — any)'},
    {n:'cell',t:'check',d:false,label:'cell towers: operator, cell id, band, RSRP / RSRQ / SINR (rec; serving cell → cdbm crsrp crsrq csinr)'},
    {n:'cellEvery',t:'range',min:1,max:120,step:1,d:5,label:'cell poll every, s (DSP app)'},
    {n:'lum',t:'check',d:false,label:'camera brightness per frame → output «lum» (signal at the camera frame rate) and «lumv» (DSP app; the camera runs while a viewer, e.g. IP Camera on «camurl», is connected; high-speed mode: fps above the camera\'s normal limit)'},
    {n:'mic',t:'check',d:false,label:'microphone → output «mic» (signal), level in «micdb» (DSP app, also with the screen locked)'},
    {n:'micHz',t:'select',opts:['8000','16000','22050','44100','48000'],d:'16000',label:'microphone: sample rate, Hz'},
    {n:'pkt',t:'check',d:false,label:'packet capture, frames in hex → rec (DSP app; root + tcpdump; allow it in the app Settings)'},
    {n:'iface',t:'text',d:'any',label:'capture: interface (any, wlan0, rmnet_data0…)'},
    {n:'filter',t:'text',d:'',label:'capture: filter (tcpdump syntax, e.g. tcp port 80)'},
    {n:'snap',t:'select',opts:['64','128','256','512','1500','65535'],d:'256',label:'capture: bytes per frame'},
    {n:'step',t:'check',d:false,label:'step detector (DSP app) → rec'},
    {n:'devorient',t:'check',d:false,label:'screen orientation 0–3 (DSP app; Android 13+)'},
    {n:'sigmotion',t:'check',d:false,label:'significant motion (DSP app; one-shot trigger)'},
    {n:'stationary',t:'check',d:false,label:'stationary detect → still=1 (DSP app)'},
    {n:'motion',t:'check',d:false,label:'motion detect → still=0 (DSP app)'},
    {n:'hz',t:'select',opts:['0','10','50','100','200','500','1000'],d:'0',label:'sensor rate, Hz (DSP app; 0 — default; the phone gives what the sensor can)'},
    {n:'cam',t:'select',opts:n=>termuxCamOpts(n.camInfo,n.p.cam),d:'off',label:'camera stream (DSP app) → output «camurl» → IP Camera; the list shows every camera of the phone after Connect (thermal / IR / depth / external too)'},
    {n:'campal',t:'select',opts:['gray','iron'],d:'gray',label:'thermal / depth cameras: palette'},
    {n:'camw',t:'select',opts:['320','640','1280','1920','3840'],d:'640',label:'camera: width, px'},
    {n:'camfps',t:'range',min:1,max:240,step:1,d:10,label:'camera: frames per second (above the camera\'s normal limit — high-speed mode, lower resolution)'},
    {n:'camq',t:'range',min:10,max:100,step:5,d:70,label:'camera: JPEG quality'},
    {n:'reconnect',t:'check',d:true,label:'reconnect'},
    {n:'connect',t:'button',label:'Connect',fn:n=>termuxStart(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>termuxStop(n)},
  ],
  init:n=>{ ssInit(n,1); n.sExact=true; n.sLag=.25; n.micT=0; n.micT0=0; n.devSeen=new Map(); n.ptQ=[]; n.ptSeq=0; n.ws=null; n.want=false; n.timer=null; n.recQ=[]; n.lineQ=[]; n.nmeaQ=[]; n.vals={}; n.last=''; n.msgs=0; n.count=0;
            n.status='not connected'; n.warn=''; n.sentSub=null; n.bridgeMsg=''; n.camInfo=null; },
  dispose:n=>termuxStop(n),
  process(n){
    termuxSendSub(n);
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    let line=n.lineQ.length ? n.lineQ[n.lineQ.length-1] : n.lastLine||'';
    n.lineQ.length=0; n.lastLine=line;
    const nm=n.nmeaQ.length ? n.nmeaQ.splice(0).join('\n')+'\n' : '';
    const o={rec, pts:n.ptQ.length ? n.ptQ.splice(0) : null, line, camurl:termuxCamUrl(n.p.url,n.p), nmeatxt:nm, go:rec ? 1 : 0};
    for(const k of TERMUX_OUTS) o[k]=n.vals[k] ?? null;
    if(n.p.mic){ const m=buf(n,'mic'); ssProcess(n,[m]); o.mic=m; }
    else { if(n.micT){ ssInit(n,1); n.micT=0; n.micT0=0; n.sExact=true; n.sLag=.25; } o.mic=buf(n,'mic').fill(0); }
    if(n.p.lum && n.lumS && n.lumS.sLastT){ const m=buf(n,'lum'); ssProcess(n.lumS,[m]); o.lum=m; } else o.lum=buf(n,'lum').fill(0);
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
    if(n.p.lum && n.lumRate) t+='\nbrightness stream '+Math.round(n.lumRate)+' Hz';
    if(o.micdb!=null) t+='\nmic '+f(o.micdb,0)+' dBFS';
    if(o.orient!=null) t+='\nscreen orientation '+f(o.orient,0);
    if(o.still!=null) t+='\n'+(o.still ? 'stationary' : 'moving');
    if(o.light!=null) t+='\nlight '+f(o.light,0)+' lx';
    if(o.press!=null) t+='\npressure '+f(o.press,1)+' hPa';
    if(o.batt!=null) t+='\nbattery '+f(o.batt,0)+'%'+(o.charging ? ' (charging)' : '')+(o.temp!=null ? '  '+f(o.temp,1)+' °C' : '');
    if(r.textContent!==t) r.textContent=t; }
});
