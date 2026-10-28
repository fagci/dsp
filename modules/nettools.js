"use strict";
/* ============================ Сетевые мелочи (приложение DSP) ============================
   Network Tools (Wake-on-LAN, NTP, syslog, SMTP, TFTP — разовые действия), Syslog / TFTP Server, Telnet Terminal.
   Протоколы — netmisc-kernels.js (проверяются в tools/test-netmisc.mjs); связь с мостом и помощники — netsvc.js. */

const NTOOL_ACTIONS=['wake-on-lan','ntp time','syslog send','smtp send mail','tftp get','tftp put'];
function nettoolRun(n){
  const host=String(n.hostIn||n.p.host||'').trim(), textIn=n.textIn!=null && n.textIn!=='' ? String(n.textIn) : '';
  const act=n.p.action;
  nsvClientRun(n,async ns=>{
    switch(act){
      case 'wake-on-lan': {
        const mac=(textIn || n.p.mac || host).trim(), pkt=wolPacket(mac), info=await ns.call('net.info').catch(()=>null);
        const targets=new Set(['255.255.255.255']); for(const ip of (info&&info.ips)||[]) if(/^\d+\.\d+\.\d+\.\d+$/.test(ip)) targets.add(wolBroadcast(ip));
        if(host && /^\d+\.\d+\.\d+\.\d+$/.test(host)) targets.add(host);
        for(const t of targets) for(const port of [9,7]) await ns.udpSend(t,port,pkt,{broadcast:true}).catch(()=>{});
        return {status:'magic packet for '+mac.toUpperCase()+' sent to '+[...targets].join(', '),rows:[{src:'wol',ev:'sent',mac,targets:[...targets]}]};
      }
      case 'ntp time': {
        if(!host) throw new Error('set the NTP server (e.g. pool.ntp.org or the router address)');
        const t1=Date.now(), ans=await ns.udpRequest(host,+n.p.port||123,ntpRequest(t1),+n.p.timeout||3000), t4=Date.now(), r=ntpParse(ans.bytes,t1,t4);
        n.val=r.offset;
        return {status:'offset '+(r.offset>=0 ? '+' : '')+r.offset.toFixed(1)+' ms · delay '+r.delay.toFixed(1)+' ms · stratum '+r.stratum,text:new Date(r.server).toISOString(),
          rows:[{src:'ntp',ev:'time',server:host,offset:+r.offset.toFixed(2),delay:+r.delay.toFixed(2),stratum:r.stratum,refid:r.refid,time:new Date(r.server).toISOString()}]};
      }
      case 'syslog send': {
        if(!host) throw new Error('set the syslog server');
        const msg=textIn || String(n.p.body||''); if(!msg) throw new Error('nothing to send: wire a text or fill the message');
        const line=syslogBuild({facility:n.p.facility,severity:n.p.severity,format:n.p.format==='RFC 5424' ? '5424' : '3164',host:n.p.sender||'dsp',app:n.p.app||'dsp',msg});
        await ns.udpSend(host,+n.p.port||514,line);
        return {status:'sent: '+line,rows:[{src:'syslog',ev:'sent',host,raw:line}]};
      }
      case 'smtp send mail': {
        if(!host) throw new Error('set the SMTP server');
        const body=textIn || String(n.p.body||''); if(!n.p.from || !n.p.to) throw new Error('set «from» and «to»');
        const r=await smtpSend(ns,{host,port:+n.p.port||25,from:n.p.from,to:n.p.to,subject:n.p.subject,body,user:n.p.user,pass:n.p.pass});
        return {status:'sent: '+r,rows:[{src:'smtp',ev:'sent',host,from:n.p.from,to:n.p.to,subject:n.p.subject,reply:r}]};
      }
      case 'tftp get': {
        if(!host) throw new Error('set the TFTP server'); const file=String(n.p.file||'').trim(); if(!file) throw new Error('set the file name');
        const b=await tftpGet(ns,host,+n.p.port||69,file,{blksize:+n.p.blksize||0,timeout:+n.p.timeout||2000,onProgress:(g)=>{ n.status='receiving '+fmSize(g); }});
        return {status:'received '+fmSize(b.length),bin:nsvBin(b,nsvName(file),httpMime(file)),code:b.length,rows:[{src:'tftp',ev:'get',host,file,bytes:b.length}]};
      }
      case 'tftp put': {
        if(!host) throw new Error('set the TFTP server');
        const bytes=n.binIn ? n.binIn.d : textIn ? nsEnc(textIn) : n.p.body ? nsEnc(String(n.p.body)) : null; if(!bytes) throw new Error('nothing to send: wire a file to «bin» or a text to «text»');
        const file=String(n.p.file||'').trim() || n.binIn?.name || 'dsp.bin';
        await tftpPut(ns,host,+n.p.port||69,file,bytes,{blksize:+n.p.blksize||0,timeout:+n.p.timeout||2000,onProgress:(g,t)=>{ n.status='sending '+fmSize(g)+' / '+fmSize(t); }});
        return {status:'sent '+fmSize(bytes.length)+' as '+file,code:bytes.length,rows:[{src:'tftp',ev:'put',host,file,bytes:bytes.length}]};
      }
    }
    throw new Error('unknown action');
  });
}
def({ id:'nettool', title:'Network Tools (DSP app)', cat:'Sources', kw:'wake on lan wol magic packet ntp time sync syslog send smtp mail email tftp get put firmware config router camera',
  ins:[{n:'go',t:'num'},{n:'host',t:'txt'},{n:'text',t:'txt'},{n:'bin',t:'bin'}], outs:[...NSV_CLI_OUTS,{n:'value',t:'num'}], readout:true, tall:true,
  groups:[{n:'Wake-on-LAN / NTP'},{n:'Syslog',open:false},{n:'SMTP',open:false},{n:'TFTP',open:false}],
  params:[
    {n:'url',t:'text',d:NSV_URL,label:'bridge of the DSP app'},
    {n:'action',t:'select',opts:NTOOL_ACTIONS,d:NTOOL_ACTIONS[0],label:'action (Run, or a rising edge on go)'},
    {n:'host',t:'text',d:'',label:'server / device address (the «host» input overrides)'},
    {n:'port',t:'range',min:0,max:65535,step:1,d:0,label:'port (0 — the standard one: NTP 123, syslog 514, SMTP 25, TFTP 69)'},
    {n:'timeout',t:'range',min:500,max:30000,step:500,d:3000,label:'wait for the answer, ms'},
    {n:'mac',t:'text',d:'',label:'Wake-on-LAN: MAC address AA:BB:CC:DD:EE:FF (the «text» input overrides; sent as UDP broadcast to ports 9 and 7 of every /24 the phone is in)',g:'Wake-on-LAN / NTP'},
    {n:'body',t:'text',d:'',label:'message / mail text / file text when nothing is wired to «text» (or «bin» for TFTP)',g:'Syslog'},
    {n:'facility',t:'select',opts:['user','kern','mail','daemon','auth','syslog','lpr','news','cron','local0','local1','local2','local3','local4','local5','local6','local7'],d:'user',g:'Syslog'},
    {n:'severity',t:'select',opts:['emerg','alert','crit','err','warning','notice','info','debug'],d:'info',g:'Syslog'},
    {n:'format',t:'select',opts:['RFC 3164','RFC 5424'],d:'RFC 3164',g:'Syslog'},
    {n:'sender',t:'text',d:'dsp',label:'host name in the message',g:'Syslog'},
    {n:'app',t:'text',d:'dsp',label:'program name',g:'Syslog'},
    {n:'from',t:'text',d:'',label:'from (address)',g:'SMTP'},
    {n:'to',t:'text',d:'',label:'to (addresses, comma separated)',g:'SMTP'},
    {n:'subject',t:'text',d:'DSP',g:'SMTP'},
    {n:'user',t:'text',d:'',label:'login (AUTH PLAIN / LOGIN; there is no TLS here — only for a LAN server, a router, a mail trap)',g:'SMTP'},
    {n:'pass',t:'text',d:'',label:'password',g:'SMTP'},
    {n:'file',t:'text',d:'',label:'file name on the server',g:'TFTP'},
    {n:'blksize',t:'range',min:0,max:65464,step:8,d:0,label:'block size (0 — 512; a larger one is much faster, if the server knows the option)',g:'TFTP'},
    {n:'run',t:'button',label:'Run',fn:n=>nettoolRun(n)}],
  init:n=>{ n.nsP=null; n.ns=null; n.ws=null; n.recQ=[]; n.busy=false; n.status='idle'; n.ok=0; n.code=0; n.pulse=0; n.outBin=null; n.outText=null; n.prevGo=0; n.hostIn=''; n.textIn=''; n.binIn=null; n.cliSrc='net'; n.warn=''; n.val=0; },
  dispose:n=>nsvDrop(n),
  process(n,I){
    n.hostIn=typeof I.host==='string' ? I.host : ''; n.textIn=typeof I.text==='string' ? I.text : ''; n.binIn=I.bin||null;
    const go=(I.go||0)>.5; if(go && !n.prevGo) nettoolRun(n); n.prevGo=go;
    return {...nsvClientOut(n),value:n.val}; },
  draw:nsvClientDraw });

/* ---------- Syslog / TFTP Server ---------- */
const NLISTEN_MODES=['syslog receiver','tftp server'];
async function netlistenStart(n){
  if(n.running || n.starting) return;
  n.starting=true; n.status='connecting…';
  try{
    const ns=await nsvLink(n), info=await ns.call('net.info').catch(()=>null);
    const ips=(info&&info.ips&&info.ips.length) ? info.ips : ['127.0.0.1'];
    if(n.p.mode===NLISTEN_MODES[0]){
      const port=+n.p.port||5514;
      n.srv=await syslogListen(ns,port,r=>{ n.count++; nsvPush(n,{...r,id:undefined}); n.upText=r.msg||r.raw; n.last=(r.severity ? r.severity+' ' : '')+(r.host ? r.host+' ' : r.from+' ')+(r.app ? r.app+': ' : '')+(r.msg||r.raw); n.lines.push(n.last); if(n.lines.length>12) n.lines.shift(); n.pulse=2; });
      n.urls=ips.map(ip=>'udp://'+ip+':'+n.srv.port); n.status='receiving syslog on UDP '+n.srv.port;
    } else {
      n.vfs=new VfsFiles(n.p.folder,new Map());
      const t=new TftpServer(ns,n.vfs,{write:!!n.p.write,onLog:r=>{ n.count++; nsvPush(n,{src:'tftp',...r}); },onUpload:(path,bytes)=>{ n.upQ.push({path,name:vfsSplit(path)[1],bytes,mime:httpMime(path)}); }});
      const port=await t.start(+n.p.port||6969); n.srv={port,close:()=>t.stop(),tftp:t};
      n.urls=ips.map(ip=>'tftp://'+ip+':'+port); n.status='TFTP server on UDP '+port;
    }
    n.running=true;
  }catch(e){ n.status='error: '+(e.message||e); n.running=false; try{ await n.srv?.close(); }catch(x){} n.srv=null; }
  n.starting=false;
}
async function netlistenStop(n){ n.running=false; n.urls=null; try{ await n.srv?.close(); }catch(e){} n.srv=null; n.status='stopped'; }
def({ id:'netlisten', title:'Syslog / TFTP Server (DSP app)', cat:'Sources', kw:'syslog receiver collector logs tftp server firmware router camera upload phone lan udp',
  ins:[{n:'start',t:'num'}], outs:NSV_SRV_OUTS, readout:true, tall:true,
  params:[
    {n:'url',t:'text',d:NSV_URL,label:'bridge of the DSP app'},
    {n:'mode',t:'select',opts:NLISTEN_MODES,d:NLISTEN_MODES[0],label:'what to run'},
    {n:'port',t:'range',min:1024,max:65535,step:1,d:5514,label:'UDP port (below 1024 an app cannot listen: syslog 514 → 5514, tftp 69 → 6969; point the device at that port)'},
    {n:'folder',t:'text',d:'Share',label:'tftp: folder in Files (empty — the whole Files)'},
    {n:'write',t:'check',d:false,label:'tftp: allow clients to upload files'},
    {n:'startBtn',t:'button',label:'Start',fn:n=>netlistenStart(n)},
    {n:'stopBtn',t:'button',label:'Stop',fn:n=>netlistenStop(n)}],
  init:n=>{ n.nsP=null; n.ns=null; n.ws=null; n.srv=null; n.vfs=null; n.running=false; n.starting=false; n.status='stopped'; n.urls=null; n.warn='';
            n.recQ=[]; n.upQ=[]; n.count=0; n.pulse=0; n.lastUp=null; n.upText=null; n.upName=''; n.prevStart=0; n.lines=[]; n.last=''; },
  dispose:n=>{ netlistenStop(n); nsvDrop(n); },
  process(n,I){
    const st=(I.start||0)>.5; if(st && !n.prevStart) netlistenStart(n); n.prevStart=st;
    n.stat=n.srv?.tftp ? 'reads '+n.srv.tftp.stats.reads+' · writes '+n.srv.tftp.stats.writes : n.lines.join('\n');
    return nsvServerOutputs(n); },
  draw:nsvDrawSrv });

/* ---------- Telnet / TCP Terminal ---------- */
async function telnetConnect(n){
  if(n.conn || n.starting) return;
  const host=String(n.hostIn||n.p.host||'').trim(); if(!host){ n.status='set the host'; return; }
  n.starting=true; n.status='connecting…';
  try{
    const ns=await nsvLink(n), c=await ns.connect(host,+n.p.port||23,+n.p.timeout||5000), codec=new TelnetCodec();
    n.conn=c; n.status='connected to '+host+':'+(+n.p.port||23); n.lines.length=0; n.ok=1;
    nsvPush(n,{src:'telnet',ev:'open',host,port:+n.p.port||23});
    (async()=>{
      let part='';
      for(;;){
        let b; try{ b=await c.readAny(0); }catch(e){ break; } if(b==null) break;
        let txt;
        if(n.p.mode==='telnet'){ const r=codec.feed(b); if(r.reply.length) c.write(r.reply).catch(()=>{}); txt=nsDec(r.text); } else txt=nsDec(b);
        if(!txt) continue;
        n.outText=txt; n.pulse=2;
        nsvPush(n,{src:'telnet',ev:'data',text:txt});
        part+=txt.replace(/\r/g,'');
        const ls=part.split('\n'); part=ls.pop(); for(const l of ls) n.lines.push(l); n.view=part;
        if(n.lines.length>200) n.lines.splice(0,n.lines.length-200);
      }
      if(n.conn===c){ n.conn=null; n.ok=0; n.status='closed by the other side'; nsvPush(n,{src:'telnet',ev:'close'}); }
    })();
  }catch(e){ n.status='error: '+(e.message||e); n.conn=null; n.ok=0; }
  n.starting=false;
}
async function telnetClose(n){ const c=n.conn; n.conn=null; n.ok=0; if(c) await c.close().catch(()=>{}); n.status='disconnected'; }
async function telnetSend(n,text){
  const c=n.conn; if(!c){ n.status='not connected — press Connect'; return; }
  const eol=n.p.eol==='CR' ? '\r' : n.p.eol==='LF' ? '\n' : n.p.eol==='none' ? '' : '\r\n';
  let b=nsEnc(String(text).replace(/\r?\n$/,'')+eol); if(n.p.mode==='telnet') b=telnetEscape(b);
  try{ await c.write(b); nsvPush(n,{src:'telnet',ev:'send',text:String(text)}); }catch(e){ n.status='error: '+e.message; }
}
def({ id:'telnet', title:'Telnet / TCP Terminal (DSP app)', cat:'Sources', kw:'telnet terminal tcp raw socket console router switch bbs mud netcat nc line text session',
  ins:[{n:'text',t:'txt'},{n:'host',t:'txt'},{n:'go',t:'num'}], outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'ok',t:'num'},{n:'new',t:'num'}], readout:true, tall:true,
  params:[
    {n:'url',t:'text',d:NSV_URL,label:'bridge of the DSP app'},
    {n:'host',t:'text',d:'',label:'host (the «host» input overrides)'},
    {n:'port',t:'range',min:1,max:65535,step:1,d:23},
    {n:'mode',t:'select',opts:['telnet','raw tcp'],d:'telnet',label:'telnet answers option requests (no echo games, no window size) and escapes 0xFF; raw tcp passes bytes as they are'},
    {n:'eol',t:'select',opts:['CR LF','CR','LF','none'],d:'CR LF',label:'line ending added to every sent line'},
    {n:'line',t:'text',d:'',label:'line to send (Send, or any text on the «text» input — each new value is sent)'},
    {n:'timeout',t:'range',min:500,max:30000,step:500,d:5000,label:'connect timeout, ms',adv:true},
    {n:'connect',t:'button',label:'Connect',fn:n=>telnetConnect(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>telnetClose(n)},
    {n:'send',t:'button',label:'Send',fn:n=>telnetSend(n,n.p.line||'')}],
  init:n=>{ n.nsP=null; n.ns=null; n.ws=null; n.conn=null; n.starting=false; n.recQ=[]; n.lines=[]; n.view=''; n.status='not connected'; n.ok=0; n.pulse=0; n.outText=null; n.hostIn=''; n.lastText=null; n.prevGo=0; n.warn=''; },
  dispose:n=>{ telnetClose(n); nsvDrop(n); },
  process(n,I){
    n.hostIn=typeof I.host==='string' ? I.host : '';
    const go=(I.go||0)>.5; if(go && !n.prevGo) telnetConnect(n); n.prevGo=go;
    if(typeof I.text==='string' && I.text!==n.lastText){ n.lastText=I.text; if(I.text) telnetSend(n,I.text); }
    const pl=n.pulse>0 ? 1 : 0; if(n.pulse>0) n.pulse--;
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    return {rec,text:n.outText??null,ok:n.ok,new:pl}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=(n.warn&&!n.ns ? '⚠ '+n.warn+'\n' : '')+n.status+'\n'+n.lines.slice(-14).join('\n')+(n.view ? '\n'+n.view : '');
    if(r.textContent!==t) r.textContent=t; } });

/* ---------- DNS Benchmark ---------- */
function dnsbenchRun(n){
  nsvJobStart(n,async(ns,info,job)=>{
    const servers=dnsbServers(n.rowsIn,n.hostIn||n.p.servers);
    if(!servers.length) throw new Error('no servers: wire a Table with a «server» (or «ip») column to «rows», or list them in «servers» (name=ip per line)');
    const names=String(n.p.names||'').split(/[\s,;]+/).filter(Boolean);
    n.best='';
    const r=await dnsBench(ns,servers,{names,rounds:+n.p.rounds,mode:n.p.mode,domain:n.p.domain,timeout:+n.p.timeout,gap:+n.p.gap,stop:()=>job.stop,
      onRec:rec=>{ rec.id=rec.id; n.found++; nsvPush(n,rec); if(rec.rank===1){ n.best=rec.id; n.bestMs=rec.score; } },
      onProgress:(d,t)=>{ n.progress=t ? d/t : 0; n.status='measuring · '+d+' / '+t+' queries'; }});
    return r.tested+' server(s)'+(r.best ? ' · fastest '+r.best.name+' ('+r.best.server+') '+r.best.score+' ms' : ' · none answered');
  });
}
def({ id:'dnsbench', title:'DNS Benchmark (DSP app)', cat:'Sources', kw:'dns benchmark speed latency response time resolver servers cloudflare google quad9 test fastest rank cache nxdomain hijack',
  ins:[{n:'go',t:'num'},{n:'rows',t:'bands'},{n:'servers',t:'txt'}], outs:[{n:'rec',t:'rec'},{n:'best',t:'txt'},{n:'ms',t:'num'},{n:'progress',t:'num'},{n:'count',t:'num'},{n:'busy',t:'num'},{n:'done',t:'num'}], readout:true, tall:true,
  params:[
    {n:'url',t:'text',d:NSV_URL,label:'bridge of the DSP app'},
    {n:'servers',t:'text',d:'',label:'servers when nothing is wired to «rows»: name=ip, one per line or comma separated (the «servers» input overrides)'},
    {n:'mode',t:'select',opts:['both','cached','fresh'],d:'both',label:'cached — popular names the resolver has (after a warm-up), fresh — a random name every time (the way to the authoritative server), both — the score is 60 % cached + 40 % fresh'},
    {n:'names',t:'text',d:DNSB_NAMES.join(', '),label:'names for the cached test'},
    {n:'domain',t:'text',d:'example.com',label:'fresh test: random-label.domain (must not exist; the right answer is NXDOMAIN)'},
    {n:'rounds',t:'range',min:1,max:20,step:1,d:3,label:'queries per name (fresh: twice this many)'},
    {n:'timeout',t:'range',min:200,max:5000,step:100,d:1500,label:'wait for an answer, ms (silence counts as a loss)'},
    {n:'gap',t:'range',min:0,max:1000,step:10,d:0,label:'pause between queries, ms (some servers limit the rate)',adv:true},
    {n:'run',t:'button',label:'Run',fn:n=>dnsbenchRun(n)},
    {n:'stopBtn',t:'button',label:'Stop',fn:n=>{ if(n.job) n.job.stop=true; }}],
  init:n=>{ n.nsP=null; n.ns=null; n.ws=null; n.recQ=[]; n.job=null; n.status='idle'; n.found=0; n.progress=0; n.done=0; n.prevGo=0; n.hostIn=''; n.rowsIn=null; n.best=''; n.bestMs=0; n.warn=''; },
  dispose:n=>{ if(n.job) n.job.stop=true; nsvDrop(n); },
  process(n,I){
    n.hostIn=typeof I.servers==='string' ? I.servers : ''; n.rowsIn=Array.isArray(I.rows) ? I.rows : null;
    const go=(I.go||0)>.5; if(go && !n.prevGo) dnsbenchRun(n); n.prevGo=go;
    return {...nsvRecOut(n),best:n.best||'',ms:n.bestMs||0}; },
  draw:nsvClientDraw });
