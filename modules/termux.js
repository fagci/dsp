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
function termuxFeed(n,r){
  if(!r || typeof r!=='object') return;
  n.msgs++; n.last=termuxLine(r);
  if(r.src==='bridge'){ if(r.level==='error' || r.level==='warn') n.bridgeMsg=r.msg; return; }
  termuxApply(n.vals,r);
  n.recQ.push({t:Date.now(), ...r});
  if(n.recQ.length>20000) n.recQ.splice(0,n.recQ.length-20000);
  n.lineQ.push(n.last);
  if(n.lineQ.length>2000) n.lineQ.splice(0,n.lineQ.length-2000);
}

const TERMUX_OUTS=['lat','lon','alt','acc','speed','hdg','ax','ay','az','gx','gy','gz','mx','my','mz','light','press','batt','charging','temp'];
def({ id:'termux', title:'Phone sensors (Termux / DSP app)', cat:'Sources', kw:'termux android app phone camera background gps accelerometer gyroscope magnetometer battery wifi cell sensors',
  ins:[], outs:[{n:'rec',t:'rec'},{n:'line',t:'txt'},{n:'camurl',t:'txt'},{n:'go',t:'num'},...TERMUX_OUTS.map(k=>({n:k,t:'num'}))],
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
    {n:'wifi',t:'check',d:false,label:'Wi-Fi scan (with the position)'},
    {n:'cell',t:'check',d:false,label:'cell towers'},
    {n:'hz',t:'select',opts:['0','10','50','100','200'],d:'0',label:'sensor rate, Hz (DSP app; 0 — default)'},
    {n:'cam',t:'select',opts:['off','back','front'],d:'off',label:'camera stream (DSP app) → output «camurl» → IP Camera'},
    {n:'camw',t:'select',opts:['320','640','1280','1920'],d:'640',label:'camera: width, px'},
    {n:'camfps',t:'range',min:1,max:30,step:1,d:10,label:'camera: frames per second'},
    {n:'camq',t:'range',min:30,max:95,step:5,d:70,label:'camera: JPEG quality'},
    {n:'reconnect',t:'check',d:true,label:'reconnect'},
    {n:'connect',t:'button',label:'Connect',fn:n=>termuxStart(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>termuxStop(n)},
  ],
  init:n=>{ n.ws=null; n.want=false; n.timer=null; n.recQ=[]; n.lineQ=[]; n.vals={}; n.last=''; n.msgs=0; n.count=0;
            n.status='not connected'; n.warn=''; n.sentSub=null; n.bridgeMsg=''; },
  dispose:n=>termuxStop(n),
  process(n){
    termuxSendSub(n);
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    let line=n.lineQ.length ? n.lineQ[n.lineQ.length-1] : n.lastLine||'';
    n.lineQ.length=0; n.lastLine=line;
    const o={rec, line, camurl:termuxCamUrl(n.p.url,n.p), go:rec ? 1 : 0};
    for(const k of TERMUX_OUTS) o[k]=n.vals[k] ?? null;
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
    if(o.light!=null) t+='\nlight '+f(o.light,0)+' lx';
    if(o.press!=null) t+='\npressure '+f(o.press,1)+' hPa';
    if(o.batt!=null) t+='\nbattery '+f(o.batt,0)+'%'+(o.charging ? ' (charging)' : '')+(o.temp!=null ? '  '+f(o.temp,1)+' °C' : '');
    if(r.textContent!==t) r.textContent=t; }
});
