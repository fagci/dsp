"use strict";
/* ============================ Network Monitor (DSP app, VPN) ============================
   Какое приложение телефона куда ходит: адрес, порт, протокол, имя сервера (из DNS-ответов, TLS SNI или заголовка HTTP
   Host — без расшифровки, сертификат не подменяется) и объём трафика. Работает через системную VPN — Android сама
   спрашивает разрешение («Запрос на подключение»); настоящие соединения приложение открывает напрямую (protect()),
   через сам туннель данные никуда не ходят — это только зеркало для подсчёта и разбора заголовков. Только IPv4.
   Движок — tools/android/.../VpnEngine.kt (без android.*, проверен в tools/android/jvm-test против настоящего ядра
   Linux: TCP, UDP, DNS, и SNI из подлинного ClientHello openssl). Разбор записей здесь — vpnmon-kernels.js,
   без DOM, tools/test-vpnmon.mjs. Нужен доверенный клиент — та же дверь, что у Network (DSP app). */

function vpnStop(n){
  n.want=false; clearTimeout(n.timer); n.timer=null;
  const ws=n.ws; n.ws=null;
  if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
  n.on=false; n.status='disconnected';
}
function vpnConnect(n){
  vpnStop(n);
  let key=''; try{ key=(window.DspApp && DspApp.appKey && DspApp.appKey()) || ''; }catch(e){}
  const url=phoneUrl(n.p.url,key);
  if(!url){ n.status='URL must start with ws:// or wss://'; return; }
  n.want=true; n.warn=netInsecure(url) ? NET_INSECURE_MSG : '';
  let ws; try{ ws=new WebSocket(url); }catch(e){ n.status='error: '+e.message; return; }
  n.ws=ws; n.status='connecting…'; n.sentSub=null;
  ws.onopen=()=>{ n.status='connected · press Start'; vpnSub(n); for(const c of n.pend.splice(0)) vpnSend(n,c); if(n.wantOn) vpnSend(n,vpnCmd('start',n.p)); };
  ws.onerror=()=>{ n.status='connection error — is the DSP app running?'; };
  ws.onclose=e=>{
    if(n.ws!==ws) return;
    n.ws=null; n.on=false; n.status='closed'+(e.code!==1000 ? ' ('+e.code+')' : '')+(n.p.reconnect ? ' — reconnecting…' : '');
    if(n.want && n.p.reconnect){ clearTimeout(n.timer); n.timer=setTimeout(()=>{ if(n.want) vpnConnect(n); },3000); }
  };
  ws.onmessage=e=>{
    if(typeof e.data!=='string') return;
    let j; try{ j=JSON.parse(e.data); }catch(x){ return; }
    for(const r of Array.isArray(j) ? j : [j]) vpnFeed(n,r);
  };
}
function vpnSub(n){
  const m=JSON.stringify({sub:['vpn']});
  if(n.ws && n.ws.readyState===1 && m!==n.sentSub){ n.sentSub=m; n.ws.send(m); }
}
function vpnSend(n,cmd){
  if(!cmd) return;
  if(!n.ws || n.ws.readyState!==1){ n.pend.push(cmd); if(n.pend.length>20) n.pend.shift(); if(!n.ws) vpnConnect(n); return; }
  n.ws.send(JSON.stringify({...cmd,id:++n.seq}));
}
// подключены — шлём сразу; иначе только просим соединение, «on open» отправит start сама (через wantOn) — без двойной отправки
function vpnStart(n){ n.wantOn=true; if(n.ws && n.ws.readyState===1) vpnSend(n,vpnCmd('start',n.p)); else if(!n.ws) vpnConnect(n); }
function vpnStopMon(n){ n.wantOn=false; vpnSend(n,vpnCmd('stop',n.p)); }

function vpnFeed(n,r){
  if(!r || typeof r!=='object') return;
  n.count++; n.last=vpnLine(r);
  if(r.src==='bridge'){ if(r.level==='error' || r.level==='warn') n.bridgeMsg=r.msg; return; }
  if(r.src==='cmd'){ if(!r.ok && r.msg) n.last=(r.cmd||'')+': '+r.msg; return; }
  if(r.src!=='vpn') return;
  if(r.ev==='state'){ n.on=!!r.on; n.status=n.on ? 'monitoring' : 'stopped'+(r.msg ? ' ('+r.msg+')' : ''); }
  else if(r.ev==='summary'){ n.open=r.open|0; n.flows=r.flows|0; n.bytesUp=+r.bytesUp||0; n.bytesDown=+r.bytesDown||0; }
  const fr=vpnFlowRow(r); if(fr) n.flowQ.push(fr);
  const ar=vpnAppAgg(n.apps,r); if(ar) n.appQ.push(vpnAppRow(ar));
  n.recQ.push({t:r.t||Date.now(),...r});
  if(n.recQ.length>5000) n.recQ.splice(0,n.recQ.length-5000);
  if(n.flowQ.length>5000) n.flowQ.splice(0,n.flowQ.length-5000);
  if(n.appQ.length>2000) n.appQ.splice(0,n.appQ.length-2000);
}

def({ id:'vpnmon', title:'Network Monitor (DSP app, VPN)', cat:'Sources', always:true,
  kw:'vpn monitor firewall netguard glasswire traffic per app which app connects where network spy inspector dns sni host owner uid packet capture android',
  ins:[{n:'go',t:'num'}],
  outs:[{n:'rec',t:'rec'},{n:'flows',t:'rec'},{n:'apps',t:'rec'},{n:'count',t:'num'},{n:'bytesUp',t:'num'},{n:'bytesDown',t:'num'},{n:'on',t:'num'}],
  readout:true, tall:true,
  params:[
    {n:'url',t:'text',d:'ws://127.0.0.1:8765',label:'bridge of the DSP app'},
    {n:'packets',t:'check',d:false,label:'also stream full packets (hex, outs → rec, ev «pkt») — heavy, for a short capture only'},
    {n:'reconnect',t:'check',d:true,label:'reconnect'},
    {n:'startBtn',t:'button',label:'Start',fn:n=>vpnStart(n)},
    {n:'stopBtn',t:'button',label:'Stop',fn:n=>vpnStopMon(n)},
    {n:'connect',t:'button',label:'Connect',fn:n=>vpnConnect(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>vpnStop(n)}],
  init:n=>{ n.ws=null; n.want=false; n.wantOn=false; n.timer=null; n.seq=0; n.pend=[]; n.sentSub=null;
            n.recQ=[]; n.flowQ=[]; n.appQ=[]; n.apps=new Map(); n.count=0; n.open=0; n.flows=0; n.bytesUp=0; n.bytesDown=0;
            n.on=false; n.status='not connected'; n.warn=''; n.bridgeMsg=''; n.last=''; n.prevGo=0; },
  dispose:n=>vpnStop(n),
  process(n,I){
    vpnSub(n);
    const go=(I.go||0)>.5; if(go && !n.prevGo){ if(n.on) vpnStopMon(n); else vpnStart(n); } n.prevGo=go;
    const rec=n.recQ.length ? n.recQ.splice(0) : null, flows=n.flowQ.length ? n.flowQ.splice(0) : null, apps=n.appQ.length ? n.appQ.splice(0) : null;
    return {rec, flows, apps, count:n.open, bytesUp:n.bytesUp, bytesDown:n.bytesDown, on:n.on ? 1 : 0}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    let t=(n.warn&&!n.ws ? '⚠ '+n.warn+'\n' : '')+n.status+' · open '+n.open+' · total '+n.flows;
    t+='\n'+vpnFmtBytes(n.bytesUp)+' up · '+vpnFmtBytes(n.bytesDown)+' down';
    if(n.bridgeMsg) t+='\n⚠ '+n.bridgeMsg;
    if(n.last) t+='\n'+n.last;
    if(r.textContent!==t) r.textContent=t; }
});
