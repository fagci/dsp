"use strict";
/* ============================ PACKETS: крафт и анализатор ============================
   Packet Crafter — слои Ethernet / ARP / IPv4 / IPv6 / TCP / UDP / ICMP / ICMPv6 + полезная нагрузка, длины и контрольные суммы считаются сами
   (можно испортить нарочно); выходы bin / hex / rec / cmd. Команда cmd готова для DSP-приложения: raw.send (IPv4-пакет целиком, root) или udp.send.
   Packet Analyzer — записи с hex из любого источника (Network Monitor VPN, root tcpdump, Wi-Fi Sniffer, PCAP Reader, Packet Crafter) или файл
   pcap / pcapng / текстовый дамп: краткий разбор, фильтр показа, статистика, экспорт в pcap / pcapng / hexdump / xxd / JSON / CSV / C / Python.
   Ядро — packet-kernels.js (тест: node tools/test-packet.mjs). */

const PKC_NONE='— load a template —';
const PKC_VIA=['outputs only','raw IPv4 (root, DSP app)','UDP socket (DSP app)'];
const PKC_INC=['none','sport','dport','ttl','id','seq'];
const pkcBin=(d,name,mime)=>typeof binObj==='function' ? binObj(d,name,mime||'application/octet-stream') : {d,name,mime:mime||'',id:Date.now()};
const PKC_G=['Layers','Ethernet / ARP','IP','TCP / UDP','ICMP','Payload','Send'];
const pkcSpec=(p,I)=>{
  const s={}; for(const k of Object.keys(PK_DEF)) if(p[k]!==undefined) s[k]=p[k];
  s.arpOp=+p.arpOp; s.df=!!p.df; s.badIp=!!p.badIp; s.badL4=!!p.badL4;
  if(typeof I.dst==='string' && I.dst.trim()) s.ipDst=I.dst.trim();
  if(typeof I.dport==='number' && isFinite(I.dport)) s.dport=I.dport;
  if(typeof I.payload==='string') s.payload=I.payload;
  return s;
};
function pkcStripL2(c,s){                                // IPv4 / IPv6 без кадра Ethernet — то, что принимает raw.send
  const b=c.bytes;
  if(c.link===1){ if(s.l3==='ipv4' || s.l3==='ipv6') return b.subarray(14); return null; }
  return c.link===228 || c.link===229 ? b : null;
}
def({ id:'pktcraft', title:'Packet Crafter', cat:'Data', kw:'packet craft forge build raw ethernet arp ip tcp udp icmp syn ping dns dhcp wake on lan scapy hping checksum inject send',
  ins:[{n:'go',t:'num'},{n:'dst',t:'txt'},{n:'dport',t:'num'},{n:'payload',t:'txt'}],
  outs:[{n:'bin',t:'bin'},{n:'hex',t:'txt'},{n:'rec',t:'rec'},{n:'cmd',t:'rec'},{n:'count',t:'num'}],
  readout:true, tall:true, w:340,
  groups:PKC_G.map((n,i)=>({n,open:i===0 || i===6})),
  params:[
    {n:'tpl',t:'select',opts:[PKC_NONE,...Object.keys(pktTemplates)],d:PKC_NONE,label:'fill the layers below from a template',g:'Layers'},
    {n:'l2',t:'select',opts:['eth','none'],d:'none',label:'link layer',g:'Layers'},
    {n:'l3',t:'select',opts:['ipv4','ipv6','arp','none'],d:'ipv4',label:'network layer',g:'Layers'},
    {n:'l4',t:'select',opts:['udp','tcp','icmp','icmpv6','none'],d:'udp',label:'transport layer',g:'Layers'},
    {n:'ethSrc',t:'text',d:PK_DEF.ethSrc,label:'source MAC',g:'Ethernet / ARP'},
    {n:'ethDst',t:'text',d:PK_DEF.ethDst,label:'destination MAC',g:'Ethernet / ARP'},
    {n:'ethType',t:'text',d:PK_DEF.ethType,label:'EtherType when there is no IP / ARP (0x88b5 — experimental)',g:'Ethernet / ARP'},
    {n:'arpOp',t:'select',opts:['1','2'],d:'1',label:'ARP: 1 who-has, 2 is-at',g:'Ethernet / ARP'},
    {n:'arpSha',t:'text',d:'',label:'ARP sender MAC (empty — source MAC)',g:'Ethernet / ARP'},
    {n:'arpSpa',t:'text',d:'',label:'ARP sender IP (empty — IP source)',g:'Ethernet / ARP'},
    {n:'arpTha',t:'text',d:PK_DEF.arpTha,label:'ARP target MAC',g:'Ethernet / ARP'},
    {n:'arpTpa',t:'text',d:'',label:'ARP target IP (empty — IP destination)',g:'Ethernet / ARP'},
    {n:'ipSrc',t:'text',d:PK_DEF.ipSrc,label:'source IP',g:'IP'},
    {n:'ipDst',t:'text',d:PK_DEF.ipDst,label:'destination IP',g:'IP'},
    {n:'ttl',t:'range',min:1,max:255,step:1,d:64,label:'TTL / hop limit',g:'IP'},
    {n:'id',t:'num',d:1,label:'IPv4 identification',g:'IP'},
    {n:'df',t:'check',d:false,label:"IPv4 «don't fragment»",g:'IP'},
    {n:'tos',t:'num',d:0,label:'DSCP (IPv4) / traffic class (IPv6)',g:'IP'},
    {n:'ipProto',t:'num',d:253,label:'protocol / next header when there is no transport layer',g:'IP'},
    {n:'ipOpts',t:'text',d:'',label:'IPv4 options, hex (length multiple of 4)',g:'IP'},
    {n:'sport',t:'num',d:40000,label:'source port',g:'TCP / UDP'},
    {n:'dport',t:'num',d:80,label:'destination port',g:'TCP / UDP'},
    {n:'seq',t:'num',d:1,label:'TCP sequence number',g:'TCP / UDP'},
    {n:'ack',t:'num',d:0,label:'TCP acknowledgement number',g:'TCP / UDP'},
    {n:'flags',t:'text',d:'SYN',label:'TCP flags: SYN, ACK, FIN, RST, PSH, URG, ECE, CWR or a number',g:'TCP / UDP'},
    {n:'win',t:'num',d:64240,label:'TCP window',g:'TCP / UDP'},
    {n:'tcpOpts',t:'text',d:'',label:'TCP options, hex (e.g. 020405b4 — MSS 1460)',g:'TCP / UDP'},
    {n:'icmpType',t:'num',d:8,label:'type (8 / 0 echo, ICMPv6 128 / 129)',g:'ICMP'},
    {n:'icmpCode',t:'num',d:0,label:'code',g:'ICMP'},
    {n:'icmpId',t:'num',d:1,label:'echo identifier',g:'ICMP'},
    {n:'icmpSeq',t:'num',d:1,label:'echo sequence',g:'ICMP'},
    {n:'icmpBody',t:'text',d:'',label:'body as hex (empty — the payload below)',g:'ICMP'},
    {n:'payloadFmt',t:'select',opts:['text','hex','zeros','pattern'],d:'text',label:'payload is: text (\\r \\n \\xNN allowed), hex, N zero bytes, N bytes of abc…',g:'Payload'},
    {n:'payload',t:'text',d:'',label:'payload',g:'Payload'},
    {n:'badIp',t:'check',d:false,label:'break the IPv4 header checksum',g:'Payload'},
    {n:'badL4',t:'check',d:false,label:'break the TCP / UDP / ICMP checksum',g:'Payload'},
    {n:'via',t:'select',opts:PKC_VIA,d:PKC_VIA[0],label:'send with (wire «cmd» to the cmd pin of Network (DSP app))',g:'Send'},
    {n:'count',t:'num',d:1,label:'packets per send (at most 10000)',g:'Send'},
    {n:'rate',t:'range',min:0,max:1000,step:1,d:0,label:'packets per second (0 — all at once)',g:'Send'},
    {n:'inc',t:'select',opts:PKC_INC,d:'none',label:'add 1 to this field in every next packet (port sweep, TTL ladder, new ids)',g:'Send'},
    {n:'send',t:'button',label:'Send',fn:n=>{ n.trig=true; },g:'Send'}],
  init:n=>{ n.key=''; n.c=null; n.todo=0; n.sent=0; n.acc=0; n.prevGo=0; n.trig=false; n.text=''; n.total=0; n.binOut=null; n.lastErr=''; n.bk=''; },
  process(n,I){
    const p=n.p;
    if(p.tpl!==PKC_NONE){ const t=pktTemplate(p.tpl); if(t) for(const k in t) setMod(n,k,t[k]); setMod(n,'tpl',PKC_NONE); }
    const s=pkcSpec(p,I), key=JSON.stringify(s);
    if(key!==n.key){
      n.key=key;
      try{ n.c=pktCraft(s); n.lastErr=''; n.info=pktInfo(n.c.bytes,n.c.link); n.binOut=pkcBin(n.c.bytes,'packet.bin'); }
      catch(e){ n.c=null; n.lastErr=e.message; }
    }
    const go=(I.go||0)>.5, rise=go && !n.prevGo; n.prevGo=go;
    if((rise || n.trig) && n.c){ n.todo=clamp(Math.round(+p.count)||1,1,10000); n.sent=0; n.acc=0; n.total=n.todo; }
    n.trig=false;
    let recs=null, cmds=null;
    if(n.todo>0 && n.c){
      let take=n.todo;
      if(+p.rate>0){ n.acc+=p.rate*BLOCK/Eng.sr; take=Math.min(take,Math.floor(n.acc)); n.acc-=take; }
      take=Math.min(take,1000);
      if(take>0){
        recs=[]; cmds=[];
        for(let i=0;i<take;i++){
          const k=n.sent+i, sp=Object.assign({},s);
          if(p.inc!=='none'){ const f=p.inc, base=+sp[f]||0, mod={sport:65536,dport:65536,ttl:256,id:65536,seq:4294967296}[f]; sp[f]=(base+k)%mod; }
          const c=k===0 && p.inc==='none' ? n.c : pktCraft(sp), info=pktInfo(c.bytes,c.link);
          recs.push(Object.assign({},info,{t:Date.now(),source:'craft',n:k+1,hex:c.hex,text:'#'+(k+1)+' '+c.bytes.length+' B'}));
          if(p.via===PKC_VIA[1]){ const ip=pkcStripL2(c,sp); if(ip) cmds.push({cmd:'raw.send',hex:pkHexStr(ip)}); else n.lastErr='raw.send needs an IPv4 packet (ARP / IPv6 / no IP — outputs only)'; }
          else if(p.via===PKC_VIA[2]){ if(sp.l4==='udp') cmds.push({cmd:'udp.send',host:sp.ipDst,port:pkNum(sp.dport,0),hex:pkHexStr(pkPayload(sp))}); else n.lastErr='UDP socket needs the UDP transport layer'; }
        }
        n.sent+=take; n.todo-=take;
      }
    }
    const c=n.c;
    n.text= n.lastErr ? '⚠ '+n.lastErr+'\n' : '';
    if(c){ const dump=[]; for(let i=0;i<Math.min(c.bytes.length,96);i+=16) dump.push(pkFmtBytes(c.bytes.subarray(i,i+16),'spaced'));
      n.text+=c.layers.join(' / ')+' · '+c.bytes.length+' B'+(n.info && n.info.ok===false ? ' · checksum bad' : '')+'\n'+(n.info ? n.info.proto+': '+n.info.info+'\n' : '')+dump.join('\n')+(c.bytes.length>96 ? '\n…' : '');
      const w=c.warn.filter(x=>!/no value/.test(x)); if(w.length) n.text+='\n⚠ '+w.join('; '); }   // «no value» — поля, которые считаются сами
    if(n.total) n.text+='\n'+(n.todo>0 ? 'sending '+n.sent+' / '+n.total : 'sent '+n.sent)+(p.via===PKC_VIA[0] ? ' (outputs only)' : '');
    return {bin:n.binOut, hex:c ? c.hex : null, rec:recs && recs.length ? recs : null, cmd:cmds && cmds.length ? cmds : null, count:n.sent}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(r && r.textContent!==n.text) r.textContent=n.text; } });

/* ---------- Packet Analyzer ---------- */
const PKA_LINKS=['auto','1 Ethernet','101 raw IP','105 802.11','127 radiotap + 802.11','113 Linux cooked'];
def({ id:'pktsniff', title:'Packet Analyzer', cat:'Data', kw:'packet sniffer analyzer capture wireshark tshark pcap pcapng dissect filter display filter export hexdump text2pcap tcpdump vpn',
  ins:[{n:'rec',t:'rec'},{n:'bin',t:'bin'},{n:'go',t:'num'}],
  outs:[{n:'rec',t:'rec'},{n:'line',t:'txt'},{n:'bin',t:'bin'},{n:'count',t:'num'},{n:'shown',t:'num'}],
  readout:true, tall:true, w:420,
  params:[{n:'filter',t:'text',d:'',label:'display filter: tcp.port == 443 && ip.addr == 10.0.0.0/8, !arp, dns, info contains "GET"'},
          {n:'link',t:'select',opts:PKA_LINKS,d:PKA_LINKS[0],label:'link type of records without «link» (auto — by the first byte)'},
          {n:'show',t:'select',opts:['list','last packet: fields','last packet: hexdump'],d:'list'},
          {n:'rows',t:'range',min:4,max:60,step:1,d:14,label:'rows in the list'},
          {n:'freeze',t:'check',d:false,label:'freeze (ignore new packets)'},
          {n:'fmt',t:'select',opts:PK_FORMATS,d:'pcap',label:'export format'},
          {n:'which',t:'select',opts:['matching the filter','all'],d:'matching the filter',label:'export'},
          {n:'save',t:'button',label:'Export',fn:n=>{ n.trig=true; }},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ n.pk=[]; n.view=[]; n.tot={n:0,b:0,p:{}}; n.dirty=true; }},
          {n:'max',t:'num',d:5000,min:100,max:100000,step:1000,label:'packets kept',adv:true}],
  init:n=>{ n.pk=[]; n.view=[]; n.tot={n:0,b:0,p:{}}; n.fk=null; n.ff=null; n.ferr=''; n.lastRec=null; n.lastBin=null; n.trig=false; n.prevGo=0; n.binOut=null; n.text=''; n.dirty=true; n.last=null; n.seq=0; },
  process(n,I){
    const p=n.p, lk=parseInt(p.link,10) || 0;
    if(n.fk!==p.filter){ n.fk=p.filter; try{ n.ff=pktFilter(p.filter); n.ferr=''; }catch(e){ n.ff=()=>true; n.ferr=e.message; } n.view=n.pk.filter(x=>n.ff(x.rec)); n.dirty=true; }
    const fresh=[];
    const add=(data,t,link,extra)=>{
      const rec=Object.assign(pktInfo(data,link||lk||(data.length>=20 && (data[0]>>4===4 || data[0]>>4===6) ? 101 : 1)),{t:t||Date.now(),n:++n.seq,source:'sniff',hex:pkHexStr(data)},extra||{});
      const x={t:rec.t,data,link:rec.link,orig:extra&&extra.orig,rec};
      n.pk.push(x); if(n.pk.length>p.max) n.pk.shift();
      n.tot.n++; n.tot.b+=data.length; n.tot.p[rec.proto]=(n.tot.p[rec.proto]||0)+1;
      if(n.ff(rec)){ n.view.push(x); if(n.view.length>p.max) n.view.shift(); fresh.push(rec); }
      n.last=x; n.dirty=true; };
    if(!p.freeze){
      let rs=I.rec; if(rs && !Array.isArray(rs)) rs=[rs];
      if(rs && rs!==n.lastRec){
        n.lastRec=rs;
        for(const r of rs){ if(r && typeof r.hex==='string' && /^[0-9a-f\s]+$/i.test(r.hex)){ const d=hexFromHex(r.hex.replace(/\s/g,'')); if(d.length) add(d,r.t,+r.link>0 ? +r.link : 0); } }
      }
      const o=I.bin;
      if(o && o.d && o!==n.lastBin){
        n.lastBin=o; const d=o.d instanceof Uint8Array ? o.d : Uint8Array.from(o.d);
        try{ const r=pcapRead(d,p.max); for(const q of r.packets) add(q.data,q.t,q.link,{orig:q.orig}); }
        catch(e){ try{ const t=pktImport(new TextDecoder().decode(d)); if(!t.length) throw e; for(const q of t) add(q.data,q.t,0); }catch(e2){ n.ferr='file: '+e.message; } }
      }
    }
    const go=(I.go||0)>.5, rise=go && !n.prevGo; n.prevGo=go;
    if((n.trig || rise) && n.pk.length){
      const src=(p.which==='all' ? n.pk : n.view);
      if(src.length){ try{ const e=pktExport(src,p.fmt,src[0].link||1); n.binOut=pkcBin(e.bytes,e.name,e.mime); n.ferr=''; }catch(e){ n.ferr=e.message; } }
    }
    n.trig=false;
    if(n.dirty){
      n.dirty=false; const L=[];
      const top=Object.entries(n.tot.p).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>k+' '+v).join(' · ');
      if(n.ferr) L.push('⚠ '+n.ferr);
      L.push(n.tot.n+' packets · '+n.tot.b+' B · shown '+n.view.length+(top ? ' · '+top : ''));
      const last=n.last;
      if(p.show==='list'){ const rows=Math.round(p.rows); for(const x of n.view.slice(-rows)) L.push('#'+String(x.rec.n).padEnd(5)+pktLine(x.rec)); }
      else if(last){
        if(p.show==='last packet: hexdump') L.push(pktLine(last.rec),...pkFmtBytes(last.data,'xxd').split('\n'));
        else { L.push(pktLine(last.rec)); const g={}; for(const k in last.rec){ if(k==='hex' || k==='text' || k==='info' || k==='layers' || k==='t') continue; const q=k.includes('.') ? k.slice(0,k.indexOf('.')) : 'frame'; (g[q]=g[q]||[]).push(k.replace(/^[a-z0-9]+\./,'')+'='+last.rec[k]); }
          L.push('layers: '+last.rec.layers.join(' › ')+(last.rec.ok===false ? '  ⚠ checksum / length mismatch' : '')); for(const q in g) L.push(q+': '+g[q].join(' · ')); }
      }
      n.text=L.join('\n');
    }
    return {rec:fresh.length ? fresh : null, line:fresh.length ? pktLine(fresh[fresh.length-1]) : null, bin:n.binOut, count:n.tot.n, shown:n.view.length}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(r && r.textContent!==n.text) r.textContent=n.text; } });
