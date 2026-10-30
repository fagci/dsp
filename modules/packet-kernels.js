"use strict";
/* ============================ ПАКЕТЫ: крафт, краткий разбор, фильтр, форматы ============================
   Чистая логика без DOM (проверка: node tools/test-packet.mjs). Опирается на HEX Structure (hexBuild / hexParse, схемы eth / arp / ipv4 /
   ipv6 / tcp / udp / icmp / icmpv6 из hex-formats.js) и на pcap-kernels.js — они должны быть загружены к моменту вызова.
   pktCraft(spec)      → {bytes, hex, link, layers, warn}: Ethernet / ARP / IPv4 / IPv6 / TCP / UDP / ICMP / ICMPv6 + полезная нагрузка,
                          длины и контрольные суммы (с псевдозаголовком) считаются сами, можно испортить нарочно;
   pktTemplates        → готовые заготовки: ARP, ping, SYN, DNS, mDNS, SSDP, DHCP, Wake-on-LAN…;
   pktInfo(bytes,link) → запись для rec и строка в духе tshark («1234 → 80 [SYN] Seq=1 Win=64240 Len=0»);
   pktFilter(expr)     → функция-фильтр по записи (ip.addr == 10.0.0.0/8 && tcp.port == 443 && !dns, contains "GET");
   pktExport / pktImport → pcap, pcapng, текстовый дамп (text2pcap / Wireshark «Import from Hex Dump»), xxd, JSON, CSV, C / Python / base64. */

/* ---------- байты и числа ---------- */
const PK_TCPF={FIN:1,SYN:2,RST:4,PSH:8,ACK:16,URG:32,ECE:64,CWR:128,NS:256};
const PK_LINK={0:'null',1:'eth',101:null,105:'wifi',108:'null',113:'sll',127:'radiotap',228:'ipv4',229:'ipv6'};
function pkFlags(v){
  if(typeof v==='number') return v|0;
  let x=0;
  for(const t of String(v==null ? '' : v).toUpperCase().split(/[\s,|+]+/)){ if(!t) continue; if(/^(0X[0-9A-F]+|\d+)$/.test(t)) x|=Number(t); else if(PK_TCPF[t]) x|=PK_TCPF[t]; }
  return x;
}
function pkFlagsText(x){ const o=[]; for(const k of ['SYN','FIN','RST','PSH','ACK','URG','ECE','CWR']) if(x&PK_TCPF[k]) o.push(k); return o.join(', '); }
function pkNum(v,d){ if(v===''||v==null) return d; const x=typeof v==='number' ? v : Number(String(v).trim()); return isFinite(x) ? x : d; }
function pkBytes(s){                                   // «de ad be ef», «0xde,0xad», «\xde\xad», «deadbeef» → байты
  s=String(s==null ? '' : s).replace(/\\x/gi,' ').replace(/0x/gi,' ').replace(/[^0-9a-f]+/gi,' ').trim();
  const o=[];
  for(const t of s.split(' ')){ if(!t) continue; const q=t.length%2 ? '0'+t : t; for(let i=0;i<q.length;i+=2) o.push(parseInt(q.substr(i,2),16)); }
  return Uint8Array.from(o);
}
const pkHexStr=b=>{ let s=''; for(const x of b) s+=(x<16 ? '0' : '')+x.toString(16); return s; };
function pkUnescape(s){                                // \r \n \t \\ \xNN в тексте полезной нагрузки
  const o=[]; s=String(s);
  for(let i=0;i<s.length;i++){
    const c=s[i];
    if(c==='\\' && i+1<s.length){
      const n=s[i+1];
      if(n==='r'){ o.push(13); i++; } else if(n==='n'){ o.push(10); i++; } else if(n==='t'){ o.push(9); i++; } else if(n==='\\'){ o.push(92); i++; }
      else if(n==='0'){ o.push(0); i++; }
      else if(n==='x' && /^[0-9a-f]{2}$/i.test(s.substr(i+2,2))){ o.push(parseInt(s.substr(i+2,2),16)); i+=3; }
      else o.push(92);
    } else { const u=new TextEncoder().encode(c); for(const x of u) o.push(x); }
  }
  return Uint8Array.from(o);
}
function pkPayload(s){
  const f=s.payloadFmt||'text', v=s.payload==null ? '' : String(s.payload);
  if(f==='hex') return pkBytes(v);
  if(f==='zeros') return new Uint8Array(clampN(pkNum(v,0),0,65000));
  if(f==='pattern'){ const n=clampN(pkNum(v,0),0,65000), o=new Uint8Array(n); for(let i=0;i<n;i++) o[i]=97+i%26; return o; }   // abcdefg… как у ping
  return pkUnescape(v);
}
const clampN=(x,a,b)=>Math.max(a,Math.min(b,x));
const pkMac=s=>{ const b=pkBytes(String(s||'').replace(/[:\-.]/g,' ')); return b.length===6 ? Array.from(b).map(x=>(x<16 ? '0' : '')+x.toString(16)).join(':') : '00:00:00:00:00:00'; };

/* ---------- DNS (запрос и разбор) ---------- */
const PK_DNST={A:1,NS:2,CNAME:5,SOA:6,PTR:12,MX:15,TXT:16,AAAA:28,SRV:33,ANY:255};
const PK_DNSN=Object.fromEntries(Object.entries(PK_DNST).map(([k,v])=>[v,k]));
function pkDnsQuery(name,type,id,rd){
  const t=typeof type==='number' ? type : PK_DNST[String(type||'A').toUpperCase()]||1, b=[(id>>8)&255,id&255,rd===false ? 0 : 1,0,0,1,0,0,0,0,0,0];
  for(const l of String(name||'').replace(/\.$/,'').split('.')){ if(!l) continue; b.push(Math.min(63,l.length)); for(const c of l.slice(0,63)) b.push(c.charCodeAt(0)&255); }
  b.push(0,t>>8,t&255,0,1);
  return Uint8Array.from(b);
}
function pkDnsName(d,o){                                // имя со сжатием; → [строка, следующая позиция]
  const parts=[]; let next=-1, hops=0;
  while(o<d.length && hops++<40){
    const l=d[o];
    if(l===0){ o++; break; }
    if((l&0xC0)===0xC0){ if(o+1>=d.length) break; if(next<0) next=o+2; o=((l&0x3F)<<8)|d[o+1]; continue; }
    parts.push(String.fromCharCode(...d.subarray(o+1,o+1+l))); o+=1+l;
  }
  return [parts.join('.'),next<0 ? o : next];
}
function pkDnsParse(d){
  if(d.length<12) return null;
  const id=(d[0]<<8)|d[1], qr=d[2]>>7, rcode=d[3]&15, qd=(d[4]<<8)|d[5], an=(d[6]<<8)|d[7], r={id,qr,rcode,qd:[],an:[]};
  let o=12;
  for(let i=0;i<qd && o<d.length;i++){ const [nm,p]=pkDnsName(d,o); o=p+4; r.qd.push({name:nm,type:PK_DNSN[(d[p]<<8)|d[p+1]]||String((d[p]<<8)|d[p+1])}); }
  for(let i=0;i<an && o+10<=d.length;i++){
    const [nm,p]=pkDnsName(d,o), t=(d[p]<<8)|d[p+1], rl=(d[p+8]<<8)|d[p+9], v=d.subarray(p+10,p+10+rl); let val='';
    if(t===1 && rl===4) val=Array.from(v).join('.');
    else if(t===28 && rl===16){ const g=[]; for(let k=0;k<16;k+=2) g.push(((v[k]<<8)|v[k+1]).toString(16)); val=g.join(':'); }
    else if(t===5 || t===2 || t===12) val=pkDnsName(d,p+10)[0];
    else val=pkHexStr(v.subarray(0,16));
    r.an.push({name:nm,type:PK_DNSN[t]||String(t),val}); o=p+10+rl;
  }
  return r;
}

/* ---------- крафт ---------- */
const PK_DEF={l2:'eth',l3:'ipv4',l4:'udp',ethSrc:'02:00:00:00:00:01',ethDst:'ff:ff:ff:ff:ff:ff',ethType:'0x88b5',
  ipSrc:'192.168.1.10',ipDst:'192.168.1.1',ttl:64,id:1,df:false,tos:0,ipProto:253,ipOpts:'',
  sport:40000,dport:80,seq:1,ack:0,flags:'SYN',win:64240,urg:0,tcpOpts:'',
  icmpType:8,icmpCode:0,icmpId:1,icmpSeq:1,icmpBody:'',
  arpOp:1,arpSha:'',arpSpa:'',arpTha:'00:00:00:00:00:00',arpTpa:'',
  payload:'',payloadFmt:'text',badIp:false,badL4:false};
function pktCraft(spec){
  const s=Object.assign({},PK_DEF,spec||{}), warn=[], V={}, l3=s.l3, l4=s.l4;
  let l2=s.l2==='eth'; const layers=[];
  if(l3==='arp') l2=true;                                  // ARP живёт только в кадре Ethernet
  const pl=pkPayload(s);
  let schema, pre='';
  if(l2){
    schema='eth'; layers.push('eth');
    V.dst=pkMac(s.ethDst); V.src=pkMac(s.ethSrc);
    V.type= l3==='ipv4' ? 2048 : l3==='arp' ? 2054 : l3==='ipv6' ? 34525 : pkNum(s.ethType,0x88b5);
    pre='payload.';
  }
  const ip4=l3==='ipv4', ip6=l3==='ipv6';
  if(l3==='arp'){
    if(!l2) warn.push('ARP needs Ethernet');
    const mk=(k,v)=>{ V[pre+k]=v; };
    mk('htype',1); mk('ptype',0x800); mk('hlen',6); mk('plen',4); mk('op',pkNum(s.arpOp,1));
    mk('sha',pkMac(s.arpSha||s.ethSrc)); mk('spa',s.arpSpa||s.ipSrc); mk('tha',pkMac(s.arpTha)); mk('tpa',s.arpTpa||s.ipDst);
    layers.push('arp');
  } else if(ip4 || ip6){
    if(!l2) schema=l3;
    const proto= l4==='tcp' ? 6 : l4==='udp' ? 17 : l4==='icmp' ? 1 : l4==='icmpv6' ? 58 : pkNum(s.ipProto,253);
    if(ip4){
      layers.push('ipv4');
      V[pre+'ver']=4; V[pre+'dscp']=clampN(pkNum(s.tos,0),0,63); V[pre+'id']=pkNum(s.id,1)&0xFFFF; V[pre+'flags']=s.df ? 2 : 0; V[pre+'frag']=0;
      V[pre+'ttl']=pkNum(s.ttl,64)&255; V[pre+'proto']= l4==='icmpv6' ? 58 : proto; V[pre+'src']=s.ipSrc; V[pre+'dst']=s.ipDst;
      if(s.ipOpts) V[pre+'opts']=pkHexStr(pkBytes(s.ipOpts));
    } else {
      layers.push('ipv6');
      V[pre+'ver']=6; V[pre+'tc']=clampN(pkNum(s.tos,0),0,255); V[pre+'flow']=0; V[pre+'next']=proto; V[pre+'hop']=pkNum(s.ttl,64)&255;
      V[pre+'src']=s.ipSrc; V[pre+'dst']=s.ipDst;
    }
    const p4=pre+'payload.';
    if(l4==='tcp'){ layers.push('tcp');
      Object.assign(V,{[p4+'sport']:pkNum(s.sport,0),[p4+'dport']:pkNum(s.dport,0),[p4+'seq']:pkNum(s.seq,0)>>>0,[p4+'ack']:pkNum(s.ack,0)>>>0,
        [p4+'rsv']:0,[p4+'flags']:pkFlags(s.flags),[p4+'win']:pkNum(s.win,0),[p4+'urg']:pkNum(s.urg,0),[p4+'data']:pkHexStr(pl)});
      if(s.tcpOpts) V[p4+'opts']=pkHexStr(pkBytes(s.tcpOpts)); }
    else if(l4==='udp'){ layers.push('udp');
      Object.assign(V,{[p4+'sport']:pkNum(s.sport,0),[p4+'dport']:pkNum(s.dport,0),[p4+'data']:pkHexStr(pl)}); }
    else if(l4==='icmp' || l4==='icmpv6'){ layers.push(l4);
      const ty=pkNum(s.icmpType,l4==='icmp' ? 8 : 128), echo=l4==='icmp' ? (ty===8||ty===0) : (ty===128||ty===129);
      const head= echo ? [s.icmpId>>8&255,s.icmpId&255,s.icmpSeq>>8&255,s.icmpSeq&255] : [];
      const extra= s.icmpBody ? pkBytes(s.icmpBody) : pl;
      Object.assign(V,{[p4+'type']:ty,[p4+'code']:pkNum(s.icmpCode,0),[p4+'body']:pkHexStr(Uint8Array.from([...head,...extra]))}); }
    else if(pl.length) V[p4.slice(0,-1)]=pkHexStr(pl);
  } else if(l2 && pl.length) V.payload=pkHexStr(pl);
  if(!schema){ // без L2 и L3 — голый L4 (контрольные суммы без псевдозаголовка)
    if(l4==='tcp' || l4==='udp' || l4==='icmp' || l4==='icmpv6'){ schema=l4; layers.push(l4);
      if(l4==='tcp') Object.assign(V,{sport:pkNum(s.sport,0),dport:pkNum(s.dport,0),seq:pkNum(s.seq,0)>>>0,ack:pkNum(s.ack,0)>>>0,rsv:0,flags:pkFlags(s.flags),win:pkNum(s.win,0),urg:0,data:pkHexStr(pl)});
      else if(l4==='udp') Object.assign(V,{sport:pkNum(s.sport,0),dport:pkNum(s.dport,0),data:pkHexStr(pl)});
      else Object.assign(V,{type:pkNum(s.icmpType,8),code:pkNum(s.icmpCode,0),body:pkHexStr(pl)});
    } else return {bytes:pl,hex:pkHexStr(pl),link:147,layers:['raw'],warn};
  }
  const r=hexBuild(schema,V);
  let bytes=r.bytes; for(const w of r.warn||[]) warn.push(String(w));
  // нарочно испорченные контрольные суммы
  const base=l2 ? 14 : 0;
  if(s.badIp && ip4 && bytes.length>=base+12){ bytes[base+10]^=0xFF; bytes[base+11]^=0xFF; }
  if(s.badL4 && (ip4 || ip6)){
    const o=base+(ip4 ? (bytes[base]&15)*4 : 40), off={tcp:16,udp:6,icmp:2,icmpv6:2}[l4];
    if(off!==undefined && bytes.length>o+off+1){ bytes[o+off]^=0xFF; bytes[o+off+1]^=0xFF; if(l4==='udp' && bytes[o+off]===0 && bytes[o+off+1]===0) bytes[o+off]=1; }
  }
  return {bytes,hex:pkHexStr(bytes),link:l2 ? 1 : ip4 ? 228 : ip6 ? 229 : 147,layers,warn};
}

/* ---------- заготовки ---------- */
function pkDhcp(mac,xid){
  const b=new Uint8Array(300); b[0]=1; b[1]=1; b[2]=6; b[4]=xid>>>24&255; b[5]=xid>>>16&255; b[6]=xid>>>8&255; b[7]=xid&255; b[10]=0x80;
  b.set(pkBytes(String(mac).replace(/[:\-]/g,' ')),28);
  b.set([99,130,83,99, 53,1,1, 55,4,1,3,6,15, 255],236);
  return b.subarray(0,236+14);
}
function pkSsdp(){ return 'M-SEARCH * HTTP/1.1\\r\\nHOST: 239.255.255.250:1900\\r\\nMAN: "ssdp:discover"\\r\\nMX: 2\\r\\nST: ssdp:all\\r\\n\\r\\n'; }
const pktTemplates={
  'ARP who-has':      {l2:'eth',l3:'arp',l4:'none',arpOp:1,ethDst:'ff:ff:ff:ff:ff:ff'},
  'ARP reply (is-at)':{l2:'eth',l3:'arp',l4:'none',arpOp:2,arpTha:'02:00:00:00:00:02'},
  'ICMP echo (ping)': {l2:'none',l3:'ipv4',l4:'icmp',icmpType:8,payloadFmt:'pattern',payload:'32'},
  'ICMPv6 echo':      {l2:'none',l3:'ipv6',l4:'icmpv6',icmpType:128,ipSrc:'fe80::1',ipDst:'ff02::1',payloadFmt:'pattern',payload:'32'},
  'TCP SYN':          {l2:'none',l3:'ipv4',l4:'tcp',flags:'SYN',dport:80},
  'TCP RST':          {l2:'none',l3:'ipv4',l4:'tcp',flags:'RST, ACK',dport:80},
  'TCP FIN scan':     {l2:'none',l3:'ipv4',l4:'tcp',flags:'FIN',dport:80},
  'TCP Xmas scan':    {l2:'none',l3:'ipv4',l4:'tcp',flags:'FIN, PSH, URG',dport:80},
  'UDP datagram':     {l2:'none',l3:'ipv4',l4:'udp',dport:9999,payload:'hello'},
  'DNS query (A)':    {l2:'none',l3:'ipv4',l4:'udp',dport:53,payloadFmt:'hex',payload:()=>pkHexStr(pkDnsQuery('example.com','A',0x1234,true))},
  'mDNS query':       {l2:'eth',l3:'ipv4',l4:'udp',ethDst:'01:00:5e:00:00:fb',ipDst:'224.0.0.251',sport:5353,dport:5353,ttl:255,payloadFmt:'hex',payload:()=>pkHexStr(pkDnsQuery('_services._dns-sd._udp.local','PTR',0,false))},
  'SSDP M-SEARCH':    {l2:'eth',l3:'ipv4',l4:'udp',ethDst:'01:00:5e:7f:ff:fa',ipDst:'239.255.255.250',sport:40000,dport:1900,payload:pkSsdp()},
  'DHCP discover':    {l2:'eth',l3:'ipv4',l4:'udp',ipSrc:'0.0.0.0',ipDst:'255.255.255.255',sport:68,dport:67,payloadFmt:'hex',payload:()=>pkHexStr(pkDhcp('02:00:00:00:00:01',0x3903F326))},
  'Wake-on-LAN':      {l2:'eth',l3:'ipv4',l4:'udp',ipDst:'255.255.255.255',dport:9,payloadFmt:'hex',payload:()=>{ const m=pkBytes('02 00 00 00 00 99'); return 'ff'.repeat(6)+pkHexStr(m).repeat(16); }},
  'NTP request':      {l2:'none',l3:'ipv4',l4:'udp',dport:123,sport:123,payloadFmt:'hex',payload:'e30004fa000100000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000'}
};
function pktTemplate(name){
  const t=pktTemplates[name]; if(!t) return null;
  const o={}; for(const k in t) o[k]=typeof t[k]==='function' ? t[k]() : t[k];
  return o;
}

/* ---------- разбор в запись и строку ---------- */
function pktInfo(d,link){
  if(!(d instanceof Uint8Array)) d=Uint8Array.from(d);
  const rec={len:d.length,link:link||1,layers:[],proto:'?',info:'',src:'',dst:''};
  let sch=PK_LINK[rec.link];
  if(sch===undefined || sch===null) sch= d.length>=20 && d[0]>>4===4 ? 'ipv4' : d.length>=40 && d[0]>>4===6 ? 'ipv6' : d.length>=14 ? 'eth' : null;
  if(!sch || !HEX_LIB[sch]){ rec.info='unsupported link type '+rec.link; return rec; }
  let res; try{ res=hexParse(sch,d); }catch(e){ rec.info='parse error: '+e.message; return rec; }
  const V=res.vals; rec.ok=res.ok; let pre='';
  const raw=(name)=>{ const f=res.fields.find(r=>r.n===name); return f&&f.raw ? f.raw : null; };
  if(sch==='wifi' || sch==='radiotap'){ rec.layers.push(sch); rec.proto='802.11'; const o=hexToRec(res,true); rec.src=o.sa||o.addr2||''; rec.dst=o.da||o.addr1||''; rec.info=String(o.subtype_name||o.kind||''); return rec; }
  if(sch==='eth'){
    rec.layers.push('eth'); rec['eth.src']=rec.src=V.src; rec['eth.dst']=rec.dst=V.dst; rec['eth.type']=V.type; rec.proto='Ethernet'; pre='payload.';
    sch=V.type===2048 ? 'ipv4' : V.type===2054 ? 'arp' : V.type===34525 ? 'ipv6' : null;
    if(!sch){ rec.info='ethertype 0x'+Number(V.type).toString(16); return rec; }
  }
  if(sch==='arp'){
    rec.layers.push('arp'); rec.proto='ARP'; const op=V[pre+'op'], spa=V[pre+'spa'], tpa=V[pre+'tpa'];
    rec['arp.op']=op; rec['arp.spa']=spa; rec['arp.tpa']=tpa; rec['arp.sha']=V[pre+'sha']; rec['arp.tha']=V[pre+'tha'];
    rec.src=spa; rec.dst=tpa;
    rec.info= op===1 ? 'Who has '+tpa+'? Tell '+spa : op===2 ? spa+' is at '+V[pre+'sha'] : 'op '+op;
    return rec;
  }
  let next=null, proto=0;
  if(sch==='ipv4'){
    rec.layers.push('ipv4'); const L=pre; proto=V[L+'proto'];
    rec['ip.src']=rec.src=V[L+'src']; rec['ip.dst']=rec.dst=V[L+'dst']; rec['ip.ttl']=V[L+'ttl']; rec['ip.proto']=proto; rec['ip.len']=V[L+'len']; rec['ip.id']=V[L+'id'];
    rec['ip.flags']=V[L+'flags']; rec['ip.frag']=V[L+'frag']; rec.ttl=V[L+'ttl']; rec.proto='IPv4'; pre=L+'payload.';
    next=V[L+'frag']>0 ? null : proto===6 ? 'tcp' : proto===17 ? 'udp' : proto===1 ? 'icmp' : null;
    if(!next) rec.info='protocol '+proto+(V[L+'frag']>0 ? ' (fragment)' : '');
  } else if(sch==='ipv6'){
    rec.layers.push('ipv6'); const L=pre; proto=V[L+'next'];
    rec['ip.src']=rec.src=V[L+'src']; rec['ip.dst']=rec.dst=V[L+'dst']; rec['ip.ttl']=V[L+'hop']; rec['ip.proto']=proto; rec.ttl=V[L+'hop']; rec.proto='IPv6'; pre=L+'payload.';
    next=proto===6 ? 'tcp' : proto===17 ? 'udp' : proto===58 ? 'icmpv6' : null;
    if(!next) rec.info='next header '+proto;
  } else next=sch;                                      // голый L4
  if(next==='tcp' && V[pre+'sport']!==undefined){
    rec.layers.push('tcp'); rec.proto='TCP'; const sp=V[pre+'sport'], dp=V[pre+'dport'], fl=V[pre+'flags'], dat=raw(pre+'data');
    rec['tcp.srcport']=rec.sport=sp; rec['tcp.dstport']=rec.dport=dp; rec['tcp.seq']=V[pre+'seq']; rec['tcp.ack']=V[pre+'ack']; rec['tcp.flags']=fl; rec['tcp.win']=V[pre+'win'];
    for(const k of ['FIN','SYN','RST','PSH','ACK','URG']) rec['tcp.flags.'+k.toLowerCase()]=fl&PK_TCPF[k] ? 1 : 0;
    rec.flags=pkFlagsText(fl); rec.payloadLen=dat ? dat.length : 0; rec.text=pkAscii(dat);
    rec.info=sp+' → '+dp+' ['+rec.flags+'] Seq='+V[pre+'seq']+' Ack='+V[pre+'ack']+' Win='+V[pre+'win']+' Len='+rec.payloadLen;
    pkApp(rec,dat,sp,dp);
  } else if(next==='udp' && V[pre+'sport']!==undefined){
    rec.layers.push('udp'); rec.proto='UDP'; const sp=V[pre+'sport'], dp=V[pre+'dport'], dat=raw(pre+'data');
    rec['udp.srcport']=rec.sport=sp; rec['udp.dstport']=rec.dport=dp; rec['udp.length']=V[pre+'len']; rec.payloadLen=dat ? dat.length : 0; rec.text=pkAscii(dat);
    rec.info=sp+' → '+dp+' Len='+rec.payloadLen;
    pkApp(rec,dat,sp,dp);
  } else if(next==='icmp' && V[pre+'type']!==undefined){
    rec.layers.push('icmp'); rec.proto='ICMP'; const t=V[pre+'type'], c=V[pre+'code'], body=raw(pre+'body');
    rec['icmp.type']=t; rec['icmp.code']=c;
    const nm={0:'Echo (ping) reply',3:'Destination unreachable',8:'Echo (ping) request',11:'Time-to-live exceeded'}[t]||'type '+t;
    rec.info=nm+(c ? ' (code '+c+')' : '')+((t===0||t===8) && body && body.length>=4 ? ' id=0x'+pkHexStr(body.subarray(0,2))+', seq='+((body[2]<<8)|body[3]) : '');
  } else if(next==='icmpv6' && V[pre+'type']!==undefined){
    rec.layers.push('icmpv6'); rec.proto='ICMPv6'; const t=V[pre+'type'];
    rec['icmp.type']=t; rec.info={128:'Echo request',129:'Echo reply',133:'Router solicitation',134:'Router advertisement',135:'Neighbor solicitation',136:'Neighbor advertisement'}[t]||'type '+t;
  }
  return rec;
}
const pkAscii=b=>{ if(!b) return ''; let s=''; for(let i=0;i<Math.min(b.length,512);i++) s+=b[i]>=32 && b[i]<127 ? String.fromCharCode(b[i]) : '.'; return s; };
function pkApp(rec,dat,sp,dp){                          // DNS / HTTP по номеру порта и виду данных
  if(!dat || !dat.length) return;
  if([53,5353,5355].includes(sp) || [53,5353,5355].includes(dp)){
    const q=pkDnsParse(dat);
    if(q && q.qd.length){ rec.layers.push('dns'); rec.dns=true; rec['dns.id']=q.id; rec['dns.qry.name']=q.qd[0].name; rec['dns.qr']=q.qr;
      rec.proto=sp===5353||dp===5353 ? 'MDNS' : 'DNS';
      rec.info=(q.qr ? 'Standard query response' : 'Standard query')+' 0x'+q.id.toString(16).padStart(4,'0')+' '+q.qd[0].type+' '+q.qd[0].name+(q.an.length ? ' → '+q.an.map(a=>a.type+' '+a.val).join(', ') : '')+(q.qr && q.rcode ? ' (rcode '+q.rcode+')' : ''); }
    return;
  }
  const t=pkAscii(dat);
  const m=/^(GET|POST|PUT|HEAD|DELETE|OPTIONS|PATCH|M-SEARCH|NOTIFY) (\S+) HTTP\/1\.[01]/.exec(t) || /^(HTTP\/1\.[01] \d+[^\r\n.]*)/.exec(t);
  if(m){ rec.layers.push('http'); rec.http=true; rec.proto=/^M-SEARCH|^NOTIFY/.test(t) ? 'SSDP' : 'HTTP'; rec.info=t.split('..')[0].slice(0,120); }
  else if(dat[0]===0x16 && dat[1]===3 && dat.length>5){ rec.layers.push('tls'); rec.proto='TLS'; rec.info=({1:'Client Hello',2:'Server Hello',11:'Certificate',16:'Client Key Exchange'}[dat[5]]||'Handshake')+' (TLS 1.'+(dat[2]-1)+' record)'; }
}
function pktLine(r){
  const t=new Date(r.t||0), p=x=>String(x).padStart(2,'0');
  return (r.t ? p(t.getHours())+':'+p(t.getMinutes())+':'+p(t.getSeconds())+'.'+String(t.getMilliseconds()).padStart(3,'0')+'  ' : '')+
    String(r.src||'?').padEnd(15)+' → '+String(r.dst||'?').padEnd(15)+'  '+String(r.proto).padEnd(7)+String(r.len).padStart(5)+'  '+r.info;
}

/* ---------- фильтр показа ---------- */
// ip.addr == 10.0.0.0/8 && (tcp.port == 80 || udp.port == 53) && !arp && frame.len > 100 && contains "GET"
function pkTok(s){
  const out=[], re=/\s*(?:("(?:[^"\\]|\\.)*")|(&&|\|\||==|!=|<=|>=|[<>()!])|([A-Za-z0-9_.:\/\-]+))/y;
  re.lastIndex=0; let m;
  while(re.lastIndex<s.length && (m=re.exec(s))){ if(m[1]!==undefined) out.push({s:JSON.parse(m[1])}); else if(m[2]!==undefined) out.push({o:m[2]}); else out.push({w:m[3]}); }
  if(re.lastIndex<s.length && s.slice(re.lastIndex).trim()) throw new Error('bad character near «'+s.slice(re.lastIndex).trim().slice(0,12)+'»');
  return out;
}
function pkIp4(s){ const m=/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s); return m ? ((+m[1]<<24)|(+m[2]<<16)|(+m[3]<<8)|+m[4])>>>0 : null; }
function pkCmp(a,op,b){
  if(a===undefined || a===null) return op==='!=';
  if(typeof b==='string' && b.includes('/') && typeof a==='string'){            // CIDR
    const [ip,bits]=b.split('/'), x=pkIp4(a), y=pkIp4(ip), n=+bits;
    if(x===null || y===null) return false;
    const mask=n===0 ? 0 : (0xFFFFFFFF<<(32-n))>>>0, hit=(x&mask)===(y&mask);
    return op==='!=' ? !hit : hit;
  }
  const na=typeof a==='number' ? a : Number(a), nb=Number(b), num=isFinite(na) && isFinite(nb) && b!=='' && typeof a!=='string';
  const A=num ? na : String(a).toLowerCase(), B=num ? nb : String(b).toLowerCase();
  switch(op){ case '==': return A===B; case '!=': return A!==B; case '<': return A<B; case '>': return A>B; case '<=': return A<=B; case '>=': return A>=B; }
  return false;
}
function pktFilter(expr){
  expr=String(expr||'').trim();
  if(!expr) return ()=>true;
  const T=pkTok(expr); let i=0;
  const PROTO=new Set(['eth','arp','ipv4','ipv6','tcp','udp','icmp','icmpv6','dns','http','tls']);
  const val=(r,k)=>{
    switch(k){
      case 'frame.len': return r.len; case 'frame.time': return r.t;
      case 'ip.addr': return [r['ip.src'],r['ip.dst']]; case 'eth.addr': return [r['eth.src'],r['eth.dst']];
      case 'tcp.port': return [r['tcp.srcport'],r['tcp.dstport']]; case 'udp.port': return [r['udp.srcport'],r['udp.dstport']];
      case 'port': return [r.sport,r.dport]; case 'addr': return [r.src,r.dst];
      case 'proto': return r.proto; case 'src': return r.src; case 'dst': return r.dst; case 'info': return r.info; case 'len': return r.len;
      case 'ip.version': return r.layers.includes('ipv4') ? 4 : r.layers.includes('ipv6') ? 6 : undefined;
    }
    return r[k];
  };
  const test=(r,k,op,b)=>{ const v=val(r,k); if(Array.isArray(v)) return op==='!=' ? v.every(x=>pkCmp(x,'!=',b)) : v.some(x=>pkCmp(x,op,b)); return pkCmp(v,op,b); };
  function prim(){
    const t=T[i++]; if(!t) throw new Error('unexpected end');
    if(t.o==='!'){ const f=prim(); return r=>!f(r); }
    if(t.o==='('){ const f=or(); if(!(T[i] && T[i].o===')')) throw new Error('missing )'); i++; return f; }
    if(t.w!==undefined){
      const w=t.w.toLowerCase(), n=T[i];
      if(w==='not'){ const f=prim(); return r=>!f(r); }
      if(n && n.w && /^(contains|matches)$/i.test(n.w)){
        i++; const a=T[i++]; if(!a) throw new Error('value expected after '+n.w);
        const s=(a.s!==undefined ? a.s : a.w);
        if(n.w.toLowerCase()==='contains'){ const q=s.toLowerCase(); return r=>{ const v=val(r,w); return Array.isArray(v) ? v.some(x=>String(x||'').toLowerCase().includes(q)) : String(v==null ? '' : v).toLowerCase().includes(q); }; }
        const rx=new RegExp(s,'i'); return r=>rx.test(String(val(r,w)==null ? '' : val(r,w)));
      }
      if(n && n.o && /^(==|!=|<=|>=|<|>)$/.test(n.o)){
        i++; const a=T[i++]; if(!a) throw new Error('value expected after '+n.o);
        const b=a.s!==undefined ? a.s : a.w; if(b===undefined) throw new Error('value expected after '+n.o);
        return r=>test(r,t.w,n.o,b);
      }
      if(PROTO.has(w)) return r=>r.layers.includes(w) || (w==='dns' && r.proto==='DNS');
      if(w==='true') return ()=>true; if(w==='false') return ()=>false;
      return r=>{ const v=val(r,t.w); return Array.isArray(v) ? v.some(x=>x!==undefined && x!==0 && x!=='') : v!==undefined && v!==0 && v!==''; };   // голое имя поля: «есть»
    }
    throw new Error('unexpected «'+(t.o||t.s)+'»');
  }
  function and(){ let f=prim(); while(T[i] && (T[i].o==='&&' || (T[i].w && T[i].w.toLowerCase()==='and'))){ i++; const g=prim(), h=f; f=r=>h(r)&&g(r); } return f; }
  function or(){ let f=and(); while(T[i] && (T[i].o==='||' || (T[i].w && T[i].w.toLowerCase()==='or'))){ i++; const g=and(), h=f; f=r=>h(r)||g(r); } return f; }
  const f=or();
  if(i<T.length) throw new Error('unexpected «'+(T[i].o||T[i].w||T[i].s)+'»');
  return f;
}

/* ---------- форматы: запись ---------- */
function pkLE32(a,o,v){ a[o]=v&255; a[o+1]=v>>>8&255; a[o+2]=v>>>16&255; a[o+3]=v>>>24&255; }
function pcapngWrite(packets,link){
  const parts=[], pad4=n=>(n+3)&~3;
  const blk=(type,body)=>{ const len=12+pad4(body.length), b=new Uint8Array(len); pkLE32(b,0,type); pkLE32(b,4,len); b.set(body,8); pkLE32(b,len-4,len); parts.push(b); };
  const opt=(code,data)=>{ const b=new Uint8Array(4+pad4(data.length)); b[0]=code&255; b[1]=code>>8; b[2]=data.length&255; b[3]=data.length>>8; b.set(data,4); return b; };
  const cat=(...a)=>{ const n=a.reduce((s,x)=>s+x.length,0), o=new Uint8Array(n); let p=0; for(const x of a){ o.set(x,p); p+=x.length; } return o; };
  const shb=new Uint8Array(16); pkLE32(shb,0,0x1A2B3C4D); shb[4]=1; shb[5]=0; shb[6]=0; shb[7]=0; shb.fill(255,8,16);
  blk(0x0A0D0D0A,cat(shb,opt(4,new TextEncoder().encode('DSP workbench')),opt(0,new Uint8Array(0))));
  const idb=new Uint8Array(8); idb[0]=(link||1)&255; idb[1]=(link||1)>>8; pkLE32(idb,4,65535);
  blk(1,cat(idb,opt(9,Uint8Array.from([6])),opt(0,new Uint8Array(0))));       // if_tsresol = 10^-6
  for(const p of packets){
    const us=Math.round((p.t||0)*1000), hi=Math.floor(us/4294967296), lo=us>>>0, cap=p.data.length;
    const h=new Uint8Array(20); pkLE32(h,4,hi); pkLE32(h,8,lo); pkLE32(h,12,cap); pkLE32(h,16,p.orig||cap);
    const body=new Uint8Array(20+pad4(cap)); body.set(h); body.set(p.data,20); blk(6,body);
  }
  return cat(...parts);
}
function pkHexdumpLines(d,offBase){
  const out=[];
  for(let i=0;i<d.length;i+=16){
    out.push((i+(offBase||0)).toString(16).padStart(4,'0')+'  '+Array.from(d.subarray(i,i+16)).map(x=>(x<16 ? '0' : '')+x.toString(16)).join(' '));
  }
  return out;
}
function pkXxd(d){
  const out=[];
  for(let i=0;i<d.length;i+=16){
    const c=d.subarray(i,i+16); let h='';
    for(let k=0;k<16;k+=2) h+=(k<c.length ? (c[k]<16 ? '0' : '')+c[k].toString(16) : '  ')+(k+1<c.length ? (c[k+1]<16 ? '0' : '')+c[k+1].toString(16) : '  ')+' ';
    out.push(i.toString(16).padStart(8,'0')+': '+h+' '+pkAscii(c));
  }
  return out.join('\n');
}
function pkFmtBytes(d,fmt){
  switch(fmt){
    case 'hex': return pkHexStr(d);
    case 'spaced': return Array.from(d).map(x=>(x<16 ? '0' : '')+x.toString(16)).join(' ');
    case 'c': return 'const uint8_t packet['+d.length+'] = {\n'+Array.from(d).reduce((a,x,i)=>{ if(i%12===0) a.push('  '); a[a.length-1]+='0x'+(x<16 ? '0' : '')+x.toString(16)+(i<d.length-1 ? ', ' : ''); return a; },[]).join('\n')+'\n};';
    case 'python': return "b'"+Array.from(d).map(x=>'\\x'+(x<16 ? '0' : '')+x.toString(16)).join('')+"'";
    case 'base64': { let s=''; for(const x of d) s+=String.fromCharCode(x); return typeof btoa==='function' ? btoa(s) : Buffer.from(d).toString('base64'); }
    case 'xxd': return pkXxd(d);
    case 'dump': return pkHexdumpLines(d).join('\n');
  }
  return pkHexStr(d);
}
// пакеты [{t, data, link, rec?}] → {name, bytes|text}
const PK_FORMATS=['pcap','pcapng','hexdump (text2pcap)','xxd','json','csv','c array','python bytes'];
function pktExport(packets,fmt,link){
  const enc=s=>new TextEncoder().encode(s);
  if(fmt==='pcap') return {name:'capture.pcap',bytes:pcapWrite(packets,link||1),mime:'application/vnd.tcpdump.pcap'};
  if(fmt==='pcapng') return {name:'capture.pcapng',bytes:pcapngWrite(packets,link||1),mime:'application/x-pcapng'};
  if(fmt==='hexdump (text2pcap)'){
    const L=[]; for(const p of packets){ L.push('# '+new Date(p.t||0).toISOString()+'  '+p.data.length+' bytes'); L.push(...pkHexdumpLines(p.data)); L.push(''); }
    return {name:'capture.txt',bytes:enc(L.join('\n')),mime:'text/plain'};
  }
  if(fmt==='xxd') return {name:'capture.xxd.txt',bytes:enc(packets.map(p=>'# '+new Date(p.t||0).toISOString()+'\n'+pkXxd(p.data)).join('\n\n')),mime:'text/plain'};
  const infos=packets.map(p=>Object.assign({t:p.t},pktInfo(p.data,p.link||link||1),{hex:pkHexStr(p.data)}));
  if(fmt==='json') return {name:'capture.json',bytes:enc(JSON.stringify(infos.map(r=>{ const o=Object.assign({},r); delete o.layers; o.layers=r.layers.join(','); return o; }),null,1)),mime:'application/json'};
  if(fmt==='csv'){
    const q=v=>{ const s=String(v==null ? '' : v); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
    const cols=['t','src','dst','proto','len','sport','dport','info','hex'];
    return {name:'capture.csv',bytes:enc([cols.join(','),...infos.map(r=>cols.map(c=>q(r[c])).join(','))].join('\n')),mime:'text/csv'};
  }
  if(fmt==='c array') return {name:'packets.h',bytes:enc(packets.map((p,i)=>pkFmtBytes(p.data,'c').replace('packet[','packet'+i+'[')).join('\n\n')),mime:'text/plain'};
  if(fmt==='python bytes') return {name:'packets.py',bytes:enc('packets = [\n'+packets.map(p=>'  '+pkFmtBytes(p.data,'python')+',').join('\n')+'\n]\n'),mime:'text/plain'};
  throw new Error('unknown format '+fmt);
}
/* ---------- форматы: чтение ---------- */
// текст → пакеты: Wireshark «Import from Hex Dump» / text2pcap (смещения, # комментарии, пустая строка между пакетами),
// xxd и hexdump -C (после «|» и двойного пробела — ASCII, отбрасывается), одна строка hex, «\x..», «0x..,», C-массив, base64
function pktImport(text){
  text=String(text||'').replace(/\r/g,'');
  const t=text.trim();
  if(/^[A-Za-z0-9+\/]+={0,2}$/.test(t) && t.length%4===0 && t.length>=8 && !/^[0-9a-fA-F]+$/.test(t)){
    try{ const s=typeof atob==='function' ? atob(t) : Buffer.from(t,'base64').toString('binary'); return [{t:0,data:Uint8Array.from(s,c=>c.charCodeAt(0))}]; }catch(e){}
  }
  if(/\\x[0-9a-f]{2}/i.test(t) || /0x[0-9a-f]{2}\s*,/i.test(t)) return [{t:0,data:pkBytes(t.replace(/\bb(['"])/g,'$1').replace(/\/\/.*$/gm,'').replace(/[{}\[\];=]|const|uint8_t|\w+\s*\[\d*\]/g,' '))}];
  const pk=[]; let cur=[], ts=0;
  const flush=()=>{ if(cur.length){ pk.push({t:ts,data:Uint8Array.from(cur)}); cur=[]; ts=0; } };
  for(let line of text.split('\n')){
    if(!line.trim()){ flush(); continue; }
    if(line.trim()[0]==='#'){ const m=/(\d{4}-\d\d-\d\dT[\d:.]+Z?)/.exec(line); if(m) ts=Date.parse(m[1])||0; continue; }
    line=line.replace(/\|.*$/,'');
    const m=/^\s*([0-9a-f]{4,8})(:?)\s+(.*)$/i.exec(line);
    if(m && /^[0-9a-f]{2}(\s|$)|^[0-9a-f]{4}\s/i.test(m[3])){          // со смещением
      let bytes;
      if(m[2]===':') bytes=pkBytes(m[3].split(/\s{2}/)[0]);               // xxd: слова по 4 hex, ASCII после двух пробелов
      else { const o=[]; for(const t of m[3].trim().split(/\s+/)){ if(!/^[0-9a-f]{2}$/i.test(t)) break; o.push(parseInt(t,16)); } bytes=Uint8Array.from(o); }   // hexdump -C и text2pcap
      if(parseInt(m[1],16)===0 && cur.length) flush();
      for(const b of bytes) cur.push(b);
    } else for(const b of pkBytes(line)) cur.push(b);
  }
  flush();
  return pk;
}
