"use strict";
/* Сканер сети поверх сокетов приложения (netsock-kernels.js): живые узлы подсети, порты TCP / UDP, таблица ARP.
   Приложение не может слать сырые ARP / SYN-пакеты (без root), поэтому узел «жив», если на подключение пришёл ответ
   (открыто или «отказ» — RST) или «нет маршрута» сказал сам Android; тишина до таймаута — фильтр или нет хоста.
   Без DOM — tools/test-netscan.mjs. */

const SCAN_SERVICES={7:'echo',20:'ftp-data',21:'ftp',22:'ssh',23:'telnet',25:'smtp',53:'dns',67:'dhcp',69:'tftp',80:'http',110:'pop3',111:'rpcbind',123:'ntp',135:'msrpc',137:'netbios-ns',139:'netbios-ssn',
  143:'imap',161:'snmp',389:'ldap',443:'https',445:'smb',465:'smtps',500:'ike',514:'syslog',515:'lpd',548:'afp',554:'rtsp',587:'submission',631:'ipp',636:'ldaps',873:'rsync',993:'imaps',995:'pop3s',
  1080:'socks',1194:'openvpn',1433:'mssql',1723:'pptp',1883:'mqtt',1900:'ssdp',2049:'nfs',2121:'ftp-alt',2222:'ssh-alt',3000:'http-dev',3306:'mysql',3389:'rdp',3689:'daap',4242:'dsp',5000:'upnp / http',5001:'http',
  5060:'sip',5353:'mdns',5432:'postgres',5555:'adb',5683:'coap',5900:'vnc',5985:'winrm',6379:'redis',6443:'k8s',7000:'airplay',7100:'airplay',8000:'http-alt',8008:'chromecast',8009:'chromecast',8080:'http-proxy',
  8081:'http-alt',8123:'home-assistant',8443:'https-alt',8554:'rtsp-alt',8765:'dsp-bridge',8883:'mqtts',8888:'http-alt',9000:'http-alt',9090:'http-alt',9100:'jetdirect',9200:'elasticsearch',10000:'webmin',
  27017:'mongodb',32400:'plex',49152:'upnp',50000:'upnp',62078:'iphone-sync'};
const SCAN_TOP=[21,22,23,25,53,80,110,111,135,139,143,443,445,515,548,554,631,993,995,1883,1900,3000,3306,3389,5000,5060,5353,5555,5900,7000,8000,8008,8009,8080,8081,8123,8443,8554,8888,9000,9100,32400,49152,62078];
const SCAN_HTTP=new Set([80,81,3000,5000,5001,8000,8008,8080,8081,8123,8888,9000,9090,10000,32400,49152,50000]);
const SCAN_PING_PORTS=[80,443,22,445,8080,53,62078,5353,7000,139,21,23];       // чем гонять узел, если ping нельзя

const scanIp=n=>[(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255].join('.');
const scanIpNum=s=>{ const m=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s).trim()); if(!m || m.slice(1).some(x=>+x>255)) return null; return ((+m[1]<<24)>>>0)+(+m[2]<<16)+(+m[3]<<8)+(+m[4]); };

// «192.168.1.0/24», «192.168.1.5-60», «192.168.1.5», «10.0.0.1,10.0.0.9» → список адресов (до max); /32 и /31 — как есть
function scanTargets(text,max=4096){
  const out=[], seen=new Set();
  const add=n=>{ const s=scanIp(n); if(!seen.has(s)){ seen.add(s); out.push(s); } };
  for(const part of String(text||'').split(/[\s,;]+/).filter(Boolean)){
    let m;
    if((m=/^([\d.]+)\/(\d{1,2})$/.exec(part))){
      const base=scanIpNum(m[1]), bits=+m[2]; if(base==null || bits<12 || bits>32) throw new Error('bad network: '+part+' (/12…/32)');
      const size=2**(32-bits), net=(base>>>0)-((base>>>0)%size);
      for(let i=0;i<size;i++){ if(bits<31 && (i===0 || i===size-1)) continue; add(net+i); if(out.length>max) throw new Error('more than '+max+' addresses'); }
    } else if((m=/^([\d.]+)-(\d{1,3}|[\d.]+)$/.exec(part))){
      const a=scanIpNum(m[1]); let b=m[2].includes('.') ? scanIpNum(m[2]) : a-(a%256)+ +m[2];
      if(a==null || b==null || b<a) throw new Error('bad range: '+part);
      for(let i=a;i<=b;i++){ add(i); if(out.length>max) throw new Error('more than '+max+' addresses'); }
    } else {
      const a=scanIpNum(part); if(a==null) throw new Error('bad address: '+part);
      add(a);
    }
  }
  return out;
}
// «22,80,8000-8010,top» → порты; top — список частых
function scanPortList(text,max=65535){
  const out=[], seen=new Set();
  for(const part of String(text||'').split(/[\s,;]+/).filter(Boolean)){
    let m;
    if(/^top$/i.test(part)) for(const p of SCAN_TOP){ if(!seen.has(p)){ seen.add(p); out.push(p); } }
    else if(/^all$/i.test(part)) for(let p=1;p<=65535;p++){ if(!seen.has(p)){ seen.add(p); out.push(p); } }
    else if((m=/^(\d+)-(\d+)$/.exec(part))){ const a=+m[1], b=+m[2]; if(a<1 || b>65535 || b<a) throw new Error('bad ports: '+part); for(let p=a;p<=b;p++) if(!seen.has(p)){ seen.add(p); out.push(p); } }
    else if(/^\d+$/.test(part)){ const p=+part; if(p<1 || p>65535) throw new Error('bad port: '+part); if(!seen.has(p)){ seen.add(p); out.push(p); } }
    else throw new Error('bad port: '+part);
    if(out.length>max) throw new Error('too many ports');
  }
  return out;
}
// подсеть телефона: первый частный IPv4 из net.info, /24
function scanLocalCidr(ips){
  for(const ip of ips||[]){ if(/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)){ const n=scanIpNum(ip); return scanIp(n-(n%256))+'/24'; } }
  return '';
}

// как закончился connect: refused — на той стороне есть стек (узел жив), unreach — Android сам понял, что узла нет, timeout — тишина
function scanClassify(msg){
  const m=String(msg||'');
  if(/refused|ECONNREFUSED/i.test(m)) return 'refused';
  if(/unreach|no route|EHOSTUNREACH|ENETUNREACH/i.test(m)) return 'unreach';
  if(/time[d ]*out|timeout|ETIMEDOUT/i.test(m)) return 'timeout';
  return 'error';
}

async function scanPool(items,limit,fn,stop){
  let i=0; const res=new Array(items.length);
  const worker=async()=>{ for(;;){ if(stop && stop()) return; const k=i++; if(k>=items.length) return; res[k]=await fn(items[k],k); } };
  await Promise.all(Array.from({length:Math.max(1,Math.min(limit,items.length))},worker));
  return res;
}

// TCP-порт: open / closed (отказ) / filtered; banner — первые байты или заголовок Server у http
async function scanTcp(ns,ip,port,o={}){
  const t0=performance.now(), to=o.timeout||600;
  let c;
  try{ c=await ns.connect(ip,port,to); }
  catch(e){ const k=scanClassify(e.message); return {state:k==='refused' ? 'closed' : k==='unreach' ? 'down' : 'filtered',how:k,ms:Math.round(performance.now()-t0),msg:e.message}; }
  const ms=Math.round(performance.now()-t0); let banner='';
  if(o.banner!==false){
    try{
      const head='HEAD / HTTP/1.0\r\nHost: '+ip+'\r\nUser-Agent: DSP\r\n\r\n', wait=o.bannerWait||400;
      let b=null;
      if(SCAN_HTTP.has(port)){ await c.write(head); b=await c.readAny(wait).catch(()=>null); }
      else {
        b=await c.readAny(Math.min(wait,250)).catch(()=>null);                            // сначала слушаем (ssh, ftp, smtp говорят первыми)
        if(!b){ await c.write(head).catch(()=>{}); b=await c.readAny(wait).catch(()=>null); }   // молчит — спросим по-http
      }
      if(b && b.length){
        const t=nsDec(b);
        const srv=/^server:\s*(.+)$/im.exec(t), first=t.split(/\r?\n/)[0];
        banner=(srv ? srv[1].trim()+' · ' : '')+(/^HTTP\//.test(first) ? first : t.replace(/[^\x20-\x7e]+/g,' ').trim()).slice(0,120);
        if(/^\x03\x00|^[\x15-\x17]\x03/.test(t)) banner='TLS';
      }
    }catch(e){}
  }
  await c.close();
  return {state:'open',ms,banner};
}

// узел жив? ping (если можно), потом TCP на частые порты: открыт или отказ — жив
async function scanHost(ns,ip,o={}){
  const t0=performance.now(); let how='', open=[], alive=false, rtt=null;
  if(o.ping){
    try{ const r=await ns.call('ping',{host:ip,count:1,timeout:1},8000); if(+r.got>0){ alive=true; how='ping'; rtt=r.avg; } }catch(e){}
  }
  if(!alive || o.ports){
    for(const p of (o.ports||SCAN_PING_PORTS)){
      const r=await scanTcp(ns,ip,p,{timeout:o.timeout||400,banner:false});
      if(r.state==='open'){ alive=true; how=how||'tcp'; open.push(p); rtt=rtt??r.ms; }
      else if(r.state==='closed'){ alive=true; how=how||'tcp-rst'; rtt=rtt??r.ms; }
      else if(r.state==='down'){ if(!alive) return {ip,alive:false,how:'unreach',ms:Math.round(performance.now()-t0)}; }
      if(alive && !o.ports) break;
    }
  }
  return {ip,alive,how,open,rtt,ms:Math.round(performance.now()-t0)};
}

/* ---------- UDP: у каждого протокола свой запрос, ответ = порт открыт ---------- */
const scanHx=s=>nsBytes(s.replace(/\s+/g,''));
const SCAN_UDP={
  53:{name:'dns',pkt:()=>scanHx('0001 0100 0001 0000 0000 0000 076578616d706c6503636f6d00 0001 0001'),parse:b=>'rcode '+(b[3]&15)+', answers '+((b[6]<<8)|b[7])},
  69:{name:'tftp',pkt:()=>nsCat([new Uint8Array([0,1]),nsEnc('dsp-probe'),new Uint8Array([0]),nsEnc('octet'),new Uint8Array([0])]),parse:b=>b[1]===5 ? 'error '+nsDec(b.subarray(4,b.length-1)) : 'opcode '+b[1]},
  123:{name:'ntp',pkt:()=>{ const p=new Uint8Array(48); p[0]=0x1b; return p; },parse:b=>'stratum '+b[1]},
  137:{name:'netbios',pkt:()=>nsCat([scanHx('0001 0000 0001 0000 0000 0000 20'),nsEnc('CK'+'A'.repeat(30)),scanHx('00 0021 0001')]),parse:scanNbNames},
  161:{name:'snmp',pkt:()=>scanHx('302602010004067075626c6963a019020101020100020100300e300c06082b060102010101000500'),parse:scanSnmpDescr},
  1900:{name:'ssdp',pkt:()=>nsEnc('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ssdp:all\r\n\r\n'),parse:b=>{ const t=nsDec(b), s=/^server:\s*(.+)$/im.exec(t); return s ? s[1].trim() : (t.split(/\r?\n/)[0]||'').slice(0,80); }},
  5353:{name:'mdns',pkt:()=>scanHx('0000 0000 0001 0000 0000 0000 095f7365727669636573075f646e732d7364045f756470056c6f63616c00 000c 0001'),parse:b=>'answers '+((b[6]<<8)|b[7])},
};
// NetBIOS NBSTAT: имена узла (рабочая группа, имя компьютера)
function scanNbNames(b){
  try{
    let i=56; const n=b[i++], out=[];
    for(let k=0;k<n;k++){ out.push(nsDec(b.subarray(i,i+15)).replace(/[\0\s]+$/,'')+'<'+b[i+15].toString(16).padStart(2,'0')+'>'); i+=18; }
    const uniq=out.filter(x=>/<00>$/.test(x) || /<20>$/.test(x)).map(x=>x.replace(/<..>$/,''));
    return [...new Set(uniq)].join(' ')||out.join(' ');
  }catch(e){ return ''; }
}
// SNMP: строка sysDescr из ответа GetResponse
function scanSnmpDescr(b){
  try{
    for(let i=0;i<b.length-3;i++) if(b[i]===0x06 && b[i+1]===8 && b[i+2]===0x2b){      // OID sysDescr
      let k=i+10; if(b[k]!==4) continue;
      let len=b[k+1], s=k+2; if(len&0x80){ const nb=len&0x7f; len=0; for(let j=0;j<nb;j++) len=(len<<8)|b[s++]; }
      return nsDec(b.subarray(s,s+len)).replace(/\s+/g,' ').slice(0,120);
    }
  }catch(e){}
  return 'snmp';
}
async function scanUdp(ns,ip,port,o={}){
  const pr=SCAN_UDP[port], t0=performance.now();
  try{
    const r=await ns.udpRequest(ip,port,pr ? pr.pkt() : new Uint8Array(0),o.timeout||800);
    let banner=''; try{ banner=pr && r.bytes.length ? String(pr.parse(r.bytes)||'') : r.bytes.length+' B'; }catch(e){ banner=r.bytes.length+' B'; }
    return {state:'open',ms:Math.round(performance.now()-t0),banner,bytes:r.bytes.length};
  }catch(e){
    return {state:'open|filtered',ms:Math.round(performance.now()-t0),banner:''};
  }
}

/* ---------- таблица ARP (/proc/net/arp, ip neigh) ---------- */
function scanArpParse(text){
  const out=[], seen=new Set();
  for(const l of String(text||'').split(/\r?\n/)){
    let m=/^(\d+\.\d+\.\d+\.\d+)\s+0x\w+\s+(0x\w+)\s+([0-9a-f:]{17})\s+\S+\s+(\S+)/i.exec(l);                 // /proc/net/arp
    if(m){ if(m[3]!=='00:00:00:00:00:00' && parseInt(m[2],16)&2 && !seen.has(m[1])){ seen.add(m[1]); out.push({ip:m[1],mac:m[3].toLowerCase(),dev:m[4]}); } continue; }
    m=/^(\d+\.\d+\.\d+\.\d+)\s+dev\s+(\S+)\s+lladdr\s+([0-9a-f:]{17})\s+(\w+)/i.exec(l);                      // ip neigh
    if(m && !/FAILED|INCOMPLETE/i.test(m[4]) && !seen.has(m[1])){ seen.add(m[1]); out.push({ip:m[1],mac:m[3].toLowerCase(),dev:m[2]}); }
  }
  return out;
}

/* ---------- запуск ---------- */
// o: mode ('hosts' | 'ports' | 'udp' | 'arp'), cidr, host, ports, ping, arp, concurrency, timeout, banner, onRec(rec), stop(), onProgress(done,total)
async function scanRun(ns,o){
  const emit=o.onRec||(()=>{}), prog=o.onProgress||(()=>{}), stop=o.stop||(()=>false), t=Date.now();
  const conc=Math.max(1,Math.min(+o.concurrency||24,28));
  const mac=new Map();
  const readArp=async()=>{
    try{
      const r=await ns.call('sys.shell.exec',{script:'cat /proc/net/arp 2>/dev/null; ip neigh show 2>/dev/null',timeout:5000},9000);
      for(const e of scanArpParse(r.out||'')) mac.set(e.ip,e);
      return mac.size;
    }catch(e){ return -1; }
  };
  if(o.mode==='arp'){
    const n=await readArp();
    if(n<0) throw new Error('the ARP table needs «Allow root features» in the app Settings (sys.shell.exec)');
    for(const e of mac.values()) emit({src:'scan',kind:'host',ip:e.ip,mac:e.mac,dev:e.dev,state:'up',how:'arp',t:Date.now()});
    return {hosts:mac.size,ms:Date.now()-t};
  }
  if(o.mode==='hosts'){
    const ips=scanTargets(o.cidr), found=[]; let done=0;
    await scanPool(ips,conc,async ip=>{
      const r=await scanHost(ns,ip,{ping:!!o.ping,timeout:o.timeout||400,ports:o.ports ? scanPortList(o.ports) : null});
      done++; prog(done,ips.length);
      if(r.alive){ found.push(r); emit({src:'scan',kind:'host',ip,state:'up',how:r.how,open:r.open,ms:r.rtt!=null ? Math.round(+r.rtt) : r.ms,t:Date.now()}); }
    },stop);
    if(o.arp!==false && found.length){                                         // MAC после обхода: узлы попали в таблицу соседей
      if(await readArp()>0) for(const r of found){ const e=mac.get(r.ip); if(e) emit({src:'scan',kind:'host',ip:r.ip,mac:e.mac,state:'up',how:'arp',t:Date.now()}); }
    }
    return {hosts:found.length,scanned:ips.length,ms:Date.now()-t};
  }
  if(o.mode==='ports' || o.mode==='udp'){
    const ips=scanTargets(o.host||o.cidr,256), ports=scanPortList(o.ports||'top'), jobs=[];
    for(const ip of ips) for(const p of ports) jobs.push([ip,p]);
    let done=0, open=0;
    await scanPool(jobs,o.mode==='udp' ? Math.min(conc,12) : conc,async ([ip,p])=>{
      const r=o.mode==='udp' ? await scanUdp(ns,ip,p,{timeout:o.timeout||800}) : await scanTcp(ns,ip,p,{timeout:o.timeout||600,banner:o.banner!==false});
      done++; prog(done,jobs.length);
      const svc=(o.mode==='udp' && SCAN_UDP[p]?.name)||SCAN_SERVICES[p]||'';
      if(r.state==='open'){ open++; emit({src:'scan',kind:'port',proto:o.mode==='udp' ? 'udp' : 'tcp',ip,port:p,state:'open',service:svc,banner:r.banner||'',ms:r.ms,t:Date.now()}); }
      else if(r.state==='open|filtered' && o.showFiltered) emit({src:'scan',kind:'port',proto:'udp',ip,port:p,state:'open|filtered',service:svc,t:Date.now()});
      else if(r.state==='closed' && o.showClosed) emit({src:'scan',kind:'port',proto:'tcp',ip,port:p,state:'closed',service:svc,t:Date.now()});
    },stop);
    return {open,scanned:jobs.length,ms:Date.now()-t};
  }
  throw new Error('unknown mode: '+o.mode);
}
