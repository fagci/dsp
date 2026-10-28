"use strict";
/* ============================ Network (DSP app) ============================
   TCP client / server, UDP (incl. broadcast), ping, one-shot UDP request (also used for DNS), network info, raw IPv4 packet (root),
   mDNS / DNS-SD (find and announce services), Wi-Fi RTT (distance to 802.11mc access points), Wi-Fi Aware (peers without an access point: discovery and messages),
   Wi-Fi Direct (peers, group), a local-only hotspot, network suggestions (auto-join) and joining a given network,
   Wi-Fi monitor mode (root: iw, then frames arrive as pkt records from the Phone sensors node — feed them to Wi-Fi Sniffer).
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

def({ id:'netlink', title:'Network (DSP app)', cat:'Sources', kw:'wifi direct p2p hotspot access point suggestion join network tcp udp socket server client ping icmp dns traceroute raw packet internet network mdns bonjour zeroconf dns-sd nsd rtt ranging distance 802.11mc wifi aware nan',
  ins:[{n:'go',t:'num'},{n:'host',t:'txt'},{n:'data',t:'txt'},{n:'cmd',t:'rec'}],
  outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'hex',t:'txt'},{n:'ok',t:'num'},{n:'new',t:'num'}],
  readout:true, tall:true,
  groups:[{n:'TCP / UDP'},{n:'Ping'},{n:'DNS'},{n:'mDNS / DNS-SD',open:false},{n:'Wi-Fi RTT / Aware',open:false},{n:'Wi-Fi monitor (root)',open:false},{n:'Wi-Fi Direct / hotspot / join',open:false}],
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
    {n:'nsdType',t:'text',d:'_http._tcp',label:'service type (discover: what to look for; register: what to announce)',g:'mDNS / DNS-SD'},
    {n:'nsdResolve',t:'check',d:true,label:'discover: resolve each found service (host, port, TXT)',g:'mDNS / DNS-SD'},
    {n:'nsdTimeout',t:'range',min:0,max:600000,step:1000,d:0,label:'discover: stop after, ms (0 — until «nsd stop»)',g:'mDNS / DNS-SD'},
    {n:'nsdName',t:'text',d:'DSP',label:'register: instance name (the «port» field above is the port)',g:'mDNS / DNS-SD'},
    {n:'nsdTxt',t:'text',d:'',label:'register: TXT records «key=value; key=value» (keys up to 9 characters)',g:'mDNS / DNS-SD'},
    {n:'rttBssids',t:'text',d:'',label:'RTT: access points AA:BB:…, comma separated (the «host» input overrides; empty — the strongest 802.11mc ones from the last Wi-Fi scan, so run a Phone sensors node with Wi-Fi on)',g:'Wi-Fi RTT / Aware'},
    {n:'rttCount',t:'range',min:1,max:50,step:1,d:1,label:'RTT: rounds',g:'Wi-Fi RTT / Aware'},
    {n:'rttEvery',t:'range',min:500,max:60000,step:500,d:1000,label:'RTT: pause between rounds, ms (Android limits background apps to a few rounds per 10 minutes)',g:'Wi-Fi RTT / Aware'},
    {n:'rttMax',t:'range',min:1,max:20,step:1,d:10,label:'RTT: at most N access points per round',g:'Wi-Fi RTT / Aware'},
    {n:'awareService',t:'text',d:'dsp',label:'Aware: service name',g:'Wi-Fi RTT / Aware'},
    {n:'awareSolicited',t:'check',d:false,label:'publish: solicited (answer only to subscribers\' queries)',g:'Wi-Fi RTT / Aware'},
    {n:'awareActive',t:'check',d:true,label:'subscribe: active (ask, not only listen)',g:'Wi-Fi RTT / Aware'},
    {n:'awarePeer',t:'num',d:0,label:'send: peer # (from a «peer» / «message» record); the «data» field is the info for publish / subscribe and the text for send',g:'Wi-Fi RTT / Aware'},
    {n:'monIface',t:'text',d:'wlan0',label:'interface (needs root, iw and «Allow packet capture» in the app Settings; the phone\'s own Wi-Fi is off while it listens)',g:'Wi-Fi monitor (root)'},
    {n:'monChannel',t:'range',min:0,max:233,step:1,d:6,label:'channel (0 — not set)',g:'Wi-Fi monitor (root)'},
    {n:'monFreq',t:'range',min:0,max:7200,step:1,d:0,label:'or frequency, MHz (overrides the channel; 6 GHz channels are ambiguous)',g:'Wi-Fi monitor (root)'},
    {n:'monWidth',t:'select',opts:['','NOHT','HT20','HT40+','HT40-','80MHz','160MHz'],d:'',label:'width (empty — the driver\'s default)',g:'Wi-Fi monitor (root)'},
    {n:'monHop',t:'text',d:'',label:'on: hop between channels, e.g. 1,6,11 (empty — stay on one)',g:'Wi-Fi monitor (root)'},
    {n:'monDwell',t:'range',min:250,max:10000,step:50,d:500,label:'hop: time on each channel, ms',g:'Wi-Fi monitor (root)'},
    {n:'p2pAddr',t:'text',d:'',label:'Wi-Fi Direct: peer address from a «peer» record (the «host» input overrides)',g:'Wi-Fi Direct / hotspot / join'},
    {n:'p2pIntent',t:'range',min:-1,max:15,step:1,d:-1,label:'Wi-Fi Direct: wish to own the group, 0…15 (-1 — let Android decide)',g:'Wi-Fi Direct / hotspot / join'},
    {n:'p2pName',t:'text',d:'',label:'group create: name DIRECT-xy-… (empty both — Android picks name and passphrase; Android 10+ to set them)',g:'Wi-Fi Direct / hotspot / join'},
    {n:'p2pPass',t:'text',d:'',label:'group create: passphrase, 8…63 characters',g:'Wi-Fi Direct / hotspot / join'},
    {n:'wifiSsid',t:'text',d:'',label:'suggest / join: network name (the «host» input overrides); suggest remove with it empty removes all',g:'Wi-Fi Direct / hotspot / join'},
    {n:'wifiPass',t:'text',d:'',label:'suggest / join: passphrase (empty — open network)',g:'Wi-Fi Direct / hotspot / join'},
    {n:'wifiWpa3',t:'check',d:false,label:'passphrase is WPA3 (SAE), not WPA2',g:'Wi-Fi Direct / hotspot / join'},
    {n:'wifiBssid',t:'text',d:'',label:'only this access point, AA:BB:… (empty — any with that name)',g:'Wi-Fi Direct / hotspot / join'},
    {n:'wifiHidden',t:'check',d:false,label:'suggest: the SSID is hidden',g:'Wi-Fi Direct / hotspot / join'},
    {n:'wifiPriority',t:'range',min:0,max:1000,step:1,d:0,label:'suggest: priority (Android 12+; 0 — default)',g:'Wi-Fi Direct / hotspot / join'},
    {n:'wifiBind',t:'check',d:true,label:'join: send the app\'s own traffic (tcp / udp / ping) over that network, though it has no internet',g:'Wi-Fi Direct / hotspot / join'},
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
