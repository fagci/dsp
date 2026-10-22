"use strict";
/* ============================ Termux ============================
   Телефон с Termux как источник: GPS, датчики, батарея, Wi-Fi и соты. Мост tools/termux/bridge.mjs
   отдаёт JSON-записи по WebSocket; узел сам просит у него нужные источники ({"sub":[…]}).
   Разбор записей — в termux-kernels.js, транспорт и mixed-content проверка — как у Text over Network. */

function termuxStop(n){
  n.want=false; clearTimeout(n.timer); n.timer=null;
  const ws=n.ws; n.ws=null;
  if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
  n.status='disconnected';
}
function termuxSendSub(n){
  const sub=termuxSub(n.p), sig=sub.join();
  if(n.ws && n.ws.readyState===1 && sig!==n.sentSub){ n.sentSub=sig; n.ws.send(JSON.stringify({sub})); }
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
def({ id:'termux', title:'Termux (phone sensors)', cat:'Sources', kw:'termux android phone gps accelerometer gyroscope magnetometer battery wifi cell sensors',
  ins:[], outs:[{n:'rec',t:'rec'},{n:'line',t:'txt'},{n:'go',t:'num'},...TERMUX_OUTS.map(k=>({n:k,t:'num'}))],
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
    const o={rec, line, go:rec ? 1 : 0};
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
