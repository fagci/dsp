"use strict";
/* ============================ Новые веб-API ============================
   Compute Pressure, Network Information, Idle Detection, BroadcastChannel, WebTransport.
   События складываются в очередь n.q и выдаются в process() пачкой. */

const WA_PRESSURE={nominal:0,fair:1,serious:2,critical:3};

function pressStop(n){
  if(n.obs){ try{ n.obs.disconnect(); }catch(e){} n.obs=null; }
  n.status='stopped';
}
async function pressStart(n){
  pressStop(n);
  if(typeof PressureObserver==='undefined'){ n.status='Compute Pressure unavailable (Chrome/Edge 125+, https)'; return; }
  try{
    const o=new PressureObserver(recs=>{
      for(const r of recs){ n.state=r.state; n.q.push({t:Date.now(),source:r.source,state:r.state,level:WA_PRESSURE[r.state]??0}); }
      if(n.q.length>500) n.q.splice(0,n.q.length-500); });
    await o.observe(n.p.source,{sampleInterval:+n.p.interval});
    n.obs=o; n.status='observing '+n.p.source;
  }catch(e){ n.status=e.name==='NotAllowedError' ? 'blocked by permissions policy' : e.name==='NotSupportedError' ? 'source not supported here' : 'error: '+e.message; }
}
def({ id:'pressure', title:'Compute Pressure', cat:'Sources', kw:'cpu load throttling thermal gpu pressure performance',
  outs:[{n:'level',t:'num'},{n:'state',t:'txt'},{n:'rec',t:'rec'},{n:'new',t:'num'}], readout:true,
  params:[{n:'source',t:'select',opts:['cpu'],d:'cpu',label:'source',fn:n=>{ if(n.obs) pressStart(n); }},
          {n:'interval',t:'select',opts:['1000','2000','5000','10000'],d:'1000',label:'sample interval, ms',fn:n=>{ if(n.obs) pressStart(n); }},
          {n:'go',t:'button',label:'Start',fn:n=>pressStart(n)},
          {n:'stop',t:'button',label:'Stop',fn:n=>pressStop(n)}],
  onRun:n=>{ if(!n.obs) pressStart(n); },
  onStop:n=>pressStop(n),
  init:n=>{ n.obs=null; n.q=[]; n.state=''; n.level=0; n.status='not started'; },
  dispose:n=>pressStop(n),
  process(n){
    if(!n.q.length) return {level:n.state?WA_PRESSURE[n.state]??0:0,state:n.state||null,rec:null,new:0};
    const rec=n.q.splice(0); n.level=rec[rec.length-1].level;
    return {level:n.level,state:n.state,rec,new:1}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+(n.state?' · '+n.state:''); if(r.textContent!==t) r.textContent=t; }});


// Network Information: тип сети, оценка скорости и RTT. Chrome/Android и десктопный Chrome; Firefox / Safari — нет.
function netinfoRead(n){
  const c=navigator.connection; if(!c) return null;
  return {t:Date.now(),type:c.type||'',effective:c.effectiveType||'',downlink:c.downlink??0,rtt:c.rtt??0,saveData:!!c.saveData,online:navigator.onLine};
}
def({ id:'netinfo', title:'Network Information', cat:'Sources', kw:'connection online offline rtt downlink bandwidth wifi cellular 4g',
  outs:[{n:'downlink',t:'num'},{n:'rtt',t:'num'},{n:'online',t:'num'},{n:'type',t:'txt'},{n:'rec',t:'rec'},{n:'new',t:'num'}], readout:true,
  init:n=>{ n.q=[]; n.cur=null; n.status='';
    n.onChange=()=>{ const r=netinfoRead(n); if(r){ n.cur=r; n.q.push(r); } };
    n.cur=netinfoRead(n);
    if(!navigator.connection) n.status='Network Information unavailable (Chrome / Edge)';
    navigator.connection?.addEventListener('change',n.onChange);
    window.addEventListener('online',n.onChange); window.addEventListener('offline',n.onChange); },
  dispose:n=>{ navigator.connection?.removeEventListener('change',n.onChange);
    window.removeEventListener('online',n.onChange); window.removeEventListener('offline',n.onChange); },
  process(n){
    const c=n.cur||{downlink:0,rtt:0,online:navigator.onLine,effective:'',type:''};
    const rec=n.q.length ? n.q.splice(0) : null;
    return {downlink:c.downlink,rtt:c.rtt,online:c.online?1:0,type:c.type||c.effective||null,rec,new:rec?1:0}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const c=n.cur, t=n.status||(c ? `${c.online?'online':'offline'} · ${c.effective||c.type||'?'} · ${c.downlink} Mbit/s · rtt ${c.rtt} ms`+(c.saveData?' · save-data':'') : '');
    if(r.textContent!==t) r.textContent=t; }});


// Idle Detection: пользователь ушёл / экран заблокирован. Нужно разрешение (по клику), Chrome/Edge.
function idleStop(n){
  if(n.abort){ try{ n.abort.abort(); }catch(e){} n.abort=null; }
  n.det=null; n.status='stopped';
}
async function idleStart(n){
  idleStop(n);
  if(typeof IdleDetector==='undefined'){ n.status='Idle Detection unavailable (Chrome/Edge 94+, https)'; return; }
  try{
    if(await IdleDetector.requestPermission()!=='granted'){ n.status='permission denied'; return; }
    const d=new IdleDetector(); n.det=d; n.abort=new AbortController();
    d.addEventListener('change',()=>{
      n.user=d.userState; n.screen=d.screenState;
      n.q.push({t:Date.now(),user:n.user,screen:n.screen}); });
    await d.start({threshold:Math.max(60000,(+n.p.threshold)*1000),signal:n.abort.signal});
    n.user=d.userState; n.screen=d.screenState; n.status='watching';
  }catch(e){ n.status=e.name==='AbortError' ? 'stopped' : 'error: '+e.message; }
}
def({ id:'idle', title:'Idle Detection', cat:'Sources', kw:'idle away user activity screen lock presence',
  outs:[{n:'idle',t:'num'},{n:'locked',t:'num'},{n:'state',t:'txt'},{n:'rec',t:'rec'},{n:'new',t:'num'}], readout:true,
  params:[{n:'threshold',t:'select',opts:['60','120','300','600','1800'],d:'300',label:'idle after, s (min 60)'},
          {n:'go',t:'button',label:'Allow and start',fn:n=>idleStart(n)},
          {n:'stop',t:'button',label:'Stop',fn:n=>idleStop(n)}],
  init:n=>{ n.det=null; n.abort=null; n.q=[]; n.user='active'; n.screen='unlocked'; n.status='not started — press Allow and start'; },
  dispose:n=>idleStop(n),
  process(n){
    const rec=n.q.length ? n.q.splice(0) : null;
    return {idle:n.user==='idle'?1:0,locked:n.screen==='locked'?1:0,state:n.user+(n.screen==='locked'?' (locked)':''),rec,new:rec?1:0}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+(n.det ? ` · ${n.user} · screen ${n.screen}` : ''); if(r.textContent!==t) r.textContent=t; }});


// BroadcastChannel: обмен между вкладками и окнами одного сайта. Свои сообщения узел не получает —
// только соседние вкладки и другие узлы с тем же именем канала.
function bcClose(n){ if(n.ch){ n.ch.onmessage=null; n.ch.close(); n.ch=null; } }
function bcOpen(n){
  bcClose(n);
  if(typeof BroadcastChannel==='undefined'){ n.status='BroadcastChannel unavailable'; return; }
  const name=String(n.p.channel||'dsp');
  n.ch=new BroadcastChannel(name);
  n.ch.onmessage=e=>{ n.q.push({t:Date.now(),data:typeof e.data==='string' ? e.data : JSON.stringify(e.data)});
    if(n.q.length>500) n.q.shift(); n.rx++; };
  n.status='channel «'+name+'»';
}
def({ id:'bcast', title:'Broadcast Channel', cat:'Sources', kw:'tabs windows interprocess ipc message sync channel',
  ins:[{n:'send',t:'txt'},{n:'val',t:'num'}],
  outs:[{n:'text',t:'txt'},{n:'rec',t:'rec'},{n:'new',t:'num'}], readout:true,
  params:[{n:'channel',t:'text',d:'dsp',label:'channel name',fn:n=>bcOpen(n)}],
  init:n=>{ n.ch=null; n.q=[]; n.rx=0; n.tx=0; n.lastText=undefined; n.lastVal=undefined; bcOpen(n); },
  dispose:n=>bcClose(n),
  process(n,I){
    if(n.ch){
      if(typeof I.send==='string' && I.send!=='' && I.send!==n.lastText){ n.ch.postMessage(I.send); n.tx++; }
      if(typeof I.val==='number' && I.val!==n.lastVal && n.lastVal!==undefined){ n.ch.postMessage(String(I.val)); n.tx++; }
    }
    n.lastText=typeof I.send==='string' ? I.send : n.lastText; n.lastVal=typeof I.val==='number' ? I.val : n.lastVal;
    if(!n.q.length) return {text:null,rec:null,new:0};
    const rec=n.q.splice(0);
    return {text:rec[rec.length-1].data,rec,new:1}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+` · rx ${n.rx} · tx ${n.tx}`; if(r.textContent!==t) r.textContent=t; }});


// WebTransport: датаграммы по HTTP/3 (QUIC) — без очередности и повторов, с малой задержкой.
// Нужен сервер HTTP/3 с WebTransport; самоподписанный сертификат (≤14 дней) — по SHA-256 в certhash.
function wtClose(n){
  const t=n.wt; n.wt=null; n.writer=null;
  if(t){ try{ t.close(); }catch(e){} }
  n.status='closed';
}
async function wtOpen(n){
  wtClose(n);
  if(typeof WebTransport==='undefined'){ n.status='WebTransport unavailable (Chrome / Edge / Firefox 114+, https)'; return; }
  const url=String(n.p.url||'').trim();
  if(!/^https:\/\//i.test(url)){ n.status='address must start with https://'; return; }
  const opts={};
  const hash=String(n.p.certhash||'').replace(/[^0-9a-f]/gi,'');
  if(hash.length===64) opts.serverCertificateHashes=[{algorithm:'sha-256',value:Uint8Array.from(hash.match(/../g),h=>parseInt(h,16))}];
  n.status='connecting…';
  try{
    const t=new WebTransport(url,opts); n.wt=t;
    t.closed.then(()=>{ if(n.wt===t){ n.wt=null; n.status='closed'; } },e=>{ if(n.wt===t){ n.wt=null; n.status='closed: '+(e.message||e); } });
    await t.ready;
    n.writer=t.datagrams.writable.getWriter(); n.status='connected';
    const rd=t.datagrams.readable.getReader(), td=new TextDecoder();
    for(;;){ const {value,done}=await rd.read(); if(done||n.wt!==t) break;
      const hex=Array.from(value.slice(0,64),b=>b.toString(16).padStart(2,'0')).join(' ');
      n.q.push({t:Date.now(),len:value.length,data:td.decode(value),hex}); n.rx++;
      if(n.q.length>500) n.q.shift(); }
  }catch(e){ if(n.wt || !n.status.startsWith('closed')) n.status='error: '+(e.message||e); }
}
def({ id:'wtransport', title:'WebTransport', cat:'Sources', kw:'http3 quic datagram udp low latency stream network',
  ins:[{n:'send',t:'txt'}],
  outs:[{n:'text',t:'txt'},{n:'rec',t:'rec'},{n:'new',t:'num'}], readout:true,
  params:[{n:'url',t:'text',d:'https://127.0.0.1:4433/dsp',label:'server address'},
          {n:'certhash',t:'text',d:'',label:'certificate SHA-256 (self-signed server; empty = normal certificate)'},
          {n:'go',t:'button',label:'Connect',fn:n=>wtOpen(n)},
          {n:'stop',t:'button',label:'Disconnect',fn:n=>wtClose(n)}],
  init:n=>{ n.wt=null; n.writer=null; n.q=[]; n.rx=0; n.tx=0; n.lastText=undefined; n.status='not connected'; },
  dispose:n=>wtClose(n),
  process(n,I){
    if(n.writer && typeof I.send==='string' && I.send!=='' && I.send!==n.lastText){
      n.writer.write(new TextEncoder().encode(I.send)).catch(()=>{}); n.tx++; }
    if(typeof I.send==='string') n.lastText=I.send;
    if(!n.q.length) return {text:null,rec:null,new:0};
    const rec=n.q.splice(0);
    return {text:rec[rec.length-1].data,rec,new:1}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+` · rx ${n.rx} · tx ${n.tx}`; if(r.textContent!==t) r.textContent=t; }});
