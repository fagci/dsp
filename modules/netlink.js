"use strict";
/* ============================ Network (DSP app) ============================
   TCP client / server, UDP (incl. broadcast), ping, one-shot UDP request (also used for DNS), network info, raw IPv4 packet (root).
   Sockets live in the DSP app, not the browser — this is what lets the phone be a TCP/UDP server and ping with real ICMP.
   Needs a trusted client (the app's own page, or «Let any page use actions» in its Settings) — same gate as Phone Actions.
   Commands / records — tools/android/README.md (tcp.*, udp.*, ping, net.info, raw.send). Building and decoding — phonelink-kernels.js
   (DNS query bytes — dnsq-kernels.js), no DOM, tested in tools/test-phonelink.mjs / tools/test-dnsq.mjs. */

function netStop(n){
  n.want=false; clearTimeout(n.timer); n.timer=null;
  const ws=n.ws; n.ws=null;
  if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
  n.status='disconnected';
}
function netStart(n){
  netStop(n);
  let key=''; try{ key=(window.DspApp && DspApp.appKey && DspApp.appKey()) || ''; }catch(e){}
  const url=phoneUrl(n.p.url,key);
  if(!url){ n.status='URL must start with ws:// or wss://'; return; }
  n.want=true; n.warn=netInsecure(url) ? NET_INSECURE_MSG : '';
  let ws;
  try{ ws=new WebSocket(url); }catch(e){ n.status='error: '+e.message; return; }
  n.ws=ws; n.status='connecting…'; n.sentSub=null;
  ws.onopen=()=>{ n.status='connected'; netSub(n); for(const c of n.pend.splice(0)) netSend(n,c); };
  ws.onerror=()=>{ n.status='connection error — is the DSP app running?'; };
  ws.onclose=e=>{
    if(n.ws!==ws) return;
    n.ws=null; n.status='closed'+(e.code!==1000 ? ' ('+e.code+')' : '')+(n.p.reconnect ? ' — reconnecting…' : '');
    if(n.want && n.p.reconnect){ clearTimeout(n.timer); n.timer=setTimeout(()=>{ if(n.want) netStart(n); },3000); }
  };
  ws.onmessage=e=>{
    if(typeof e.data!=='string') return;
    let j; try{ j=JSON.parse(e.data); }catch(x){ return; }
    for(const r of Array.isArray(j) ? j : [j]) netFeed(n,r);
  };
}
function netSub(n){
  const m=JSON.stringify({sub:['net']});
  if(n.ws && n.ws.readyState===1 && m!==n.sentSub){ n.sentSub=m; n.ws.send(m); }
}
function netSend(n,cmd){
  if(!cmd || cmd.error) return;
  const {_dns,...wire}=cmd;
  if(!n.ws || n.ws.readyState!==1){ n.pend.push(cmd); if(n.pend.length>20) n.pend.shift(); if(!n.ws) netStart(n); return; }
  n.seq++; n.ws.send(JSON.stringify({...wire,id:n.seq}));
  if(_dns) n.pendingDns=n.seq;
}
function netFeed(n,r){
  if(!r || typeof r!=='object') return;
  n.count++;
  if(r.src==='bridge'){ if(r.level==='error' || r.level==='warn') n.bridgeMsg=r.msg; return; }
  const line=plLine(r); if(line) n.last=line;
  if(r.src==='cmd'){
    n.ok=r.ok?1:0;
    if(r.ok && r.id===n.pendingDns && typeof r.hex==='string'){
      n.pendingDns=0;
      try{
        const {parsed,rows}=plDnsReply(r,{});
        n.last='dns: '+parsed.rcodeName+' · '+(parsed.answers.length||parsed.authority.length)+' record(s), '+(r.ms!=null ? r.ms.toFixed(1)+' ms' : '');
        for(const row of rows) n.recQ.push({t:Date.now(),...row});
        n.fresh=1;
      }catch(e){ n.last='dns: bad reply ('+e.message+')'; }
    } else if(!r.ok && r.msg){ n.last=(r.cmd||'')+': '+r.msg; }
    if(typeof r.hex==='string'){ n.hex=r.hex; n.txt=r.n>0 ? (()=>{ try{ const b=new Uint8Array(r.hex.length>>1); for(let i=0;i<b.length;i++) b[i]=parseInt(r.hex.substr(i*2,2),16); return new TextDecoder().decode(b); }catch(e){ return ''; } })() : ''; n.fresh=1; }
  }
  if(r.src==='net' && typeof r.text==='string'){ n.txt=r.text; n.hex=r.hex||''; n.fresh=1; }
  n.recQ.push({t:Date.now(),...r});
  if(n.recQ.length>5000) n.recQ.splice(0,n.recQ.length-5000);
}

def({ id:'netlink', title:'Network (DSP app)', cat:'Sources', kw:'tcp udp socket server client ping icmp dns traceroute raw packet internet network',
  ins:[{n:'go',t:'num'},{n:'host',t:'txt'},{n:'data',t:'txt'},{n:'cmd',t:'rec'}],
  outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'hex',t:'txt'},{n:'ok',t:'num'},{n:'new',t:'num'}],
  readout:true, tall:true,
  groups:[{n:'TCP / UDP'},{n:'Ping'},{n:'DNS'}],
  params:[
    {n:'url',t:'text',d:'ws://127.0.0.1:8765',label:'bridge of the DSP app'},
    {n:'action',t:'select',opts:PL_NET_ACTIONS,d:'ping',label:'action (the Run button, or a rising edge on go)'},
    {n:'host',t:'text',d:'',label:'host (the «host» input overrides it)'},
    {n:'port',t:'range',min:0,max:65535,step:1,d:80,label:'port',g:'TCP / UDP'},
    {n:'conn',t:'num',d:0,label:'connection # (from the «open» / «accept» record)',g:'TCP / UDP'},
    {n:'data',t:'text',d:'',label:'send: hex or text (the «data» input overrides it)',g:'TCP / UDP'},
    {n:'dfmt',t:'select',opts:['text','hex'],d:'text',label:'send as',g:'TCP / UDP'},
    {n:'lan',t:'check',d:true,label:'tcp listen: allow other devices on the network',g:'TCP / UDP'},
    {n:'broadcast',t:'check',d:false,label:'udp: broadcast',g:'TCP / UDP'},
    {n:'timeout',t:'range',min:100,max:30000,step:100,d:5000,label:'timeout, ms',g:'TCP / UDP'},
    {n:'count',t:'range',min:1,max:30,step:1,d:4,label:'pings to send',g:'Ping'},
    {n:'size',t:'range',min:0,max:1400,step:4,d:56,label:'payload size, bytes',g:'Ping'},
    {n:'ttl',t:'range',min:0,max:64,step:1,d:0,label:'TTL override (0 — default; «traceroute step» uses this)',g:'Ping'},
    {n:'dnsType',t:'select',opts:['A','AAAA','CNAME','MX','TXT','NS','SRV','PTR','SOA','CAA','ANY'],d:'A',label:'record type',g:'DNS'},
    {n:'dnsServer',t:'text',d:'@dns',label:'DNS server (@dns — the network\'s own)',g:'DNS'},
    {n:'dnsPort',t:'num',d:53,label:'port',g:'DNS'},
    {n:'dnsEdns',t:'check',d:false,label:'EDNS (1232-byte UDP, needed for DNSSEC / large answers)',g:'DNS'},
    {n:'dnsRd',t:'check',d:true,label:'recursion desired',g:'DNS'},
    {n:'reconnect',t:'check',d:true,label:'reconnect'},
    {n:'run',t:'button',label:'Run',fn:n=>{ const c=plNetCmd(n.p,{host:n.hostIn,data:n.dataIn}); if(c.error) n.last=c.error; else netSend(n,c); }},
    {n:'connect',t:'button',label:'Connect',fn:n=>netStart(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>netStop(n)},
  ],
  init:n=>{ n.ws=null; n.want=false; n.timer=null; n.recQ=[]; n.pend=[]; n.seq=0; n.pendingDns=0; n.lastCmd=null; n.count=0; n.ok=0; n.hex=''; n.txt=''; n.fresh=0;
            n.status='not connected'; n.warn=''; n.sentSub=null; n.bridgeMsg=''; n.last=''; n.prevGo=0; n.hostIn=''; n.dataIn=''; },
  dispose:n=>netStop(n),
  process(n,I){
    netSub(n);
    n.hostIn=typeof I.host==='string' ? I.host : ''; n.dataIn=typeof I.data==='string' ? I.data : '';
    const go=(I.go||0)>.5;
    if(go && !n.prevGo){ const c=plNetCmd(n.p,{host:n.hostIn,data:n.dataIn}); if(c.error) n.last=c.error; else netSend(n,c); }
    n.prevGo=go;
    if(Array.isArray(I.cmd) && I.cmd!==n.lastCmd){                   // записи с полем cmd уходят как есть (собрать их можно Rec Filter / Fields → Rec)
      n.lastCmd=I.cmd;
      for(const r of I.cmd) if(r && typeof r.cmd==='string') netSend(n,r);
    }
    const rec=n.recQ.length ? n.recQ.splice(0) : null, fresh=n.fresh; n.fresh=0;
    return {rec, text:n.txt||null, hex:n.hex||null, ok:n.ok, new:fresh};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    let t=(n.warn&&!n.ws&&n.status!=='connected' ? '⚠ '+n.warn+'\n' : '')+n.status+' · records '+n.count;
    if(n.bridgeMsg) t+='\n⚠ '+n.bridgeMsg;
    if(n.last) t+='\n'+n.last;
    if(r.textContent!==t) r.textContent=t; }
});
