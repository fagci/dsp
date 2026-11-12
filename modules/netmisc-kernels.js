"use strict";
/* Небольшие протоколы поверх сокетов приложения (netsock-kernels.js): Wake-on-LAN, NTP, syslog (отправка и приём), TFTP (клиент и сервер),
   Telnet, SMTP (отправка письма без шифрования). Без DOM — tools/test-netmisc.mjs. */

/* ---------- Wake-on-LAN ---------- */
function wolPacket(mac){
  const h=String(mac||'').replace(/[^0-9a-f]/gi,'');
  if(h.length!==12) throw new Error('MAC: 6 bytes, e.g. AA:BB:CC:DD:EE:FF');
  const m=nsBytes(h), p=new Uint8Array(102); p.fill(255,0,6);
  for(let i=0;i<16;i++) p.set(m,6+i*6);
  return p;
}
// широковещательный адрес по IP телефона и маске /24 (маски приложение не отдаёт)
const wolBroadcast=ip=>{ const m=/^(\d+\.\d+\.\d+)\.\d+$/.exec(ip||''); return m ? m[1]+'.255' : '255.255.255.255'; };

/* ---------- NTP ---------- */
const NTP_EPOCH=2208988800;                                            // секунд между 1900 и 1970
function ntpRequest(nowMs=Date.now()){
  const p=new Uint8Array(48); p[0]=0x23;                               // LI 0, VN 4, режим клиента
  const s=nowMs/1000+NTP_EPOCH, sec=Math.floor(s), fr=Math.floor((s-sec)*4294967296);
  new DataView(p.buffer).setUint32(40,sec>>>0); new DataView(p.buffer).setUint32(44,fr>>>0);   // transmit — для сверки ответа
  return p;
}
const ntpTs=(dv,o)=>(dv.getUint32(o)-NTP_EPOCH)*1000+dv.getUint32(o+4)/4294967296*1000;     // мс от 1970
// t1 — отправили, t4 — получили (мс); смещение часов и задержка по RFC 5905
function ntpParse(b,t1,t4){
  if(b.length<48) throw new Error('short NTP answer');
  const dv=new DataView(b.buffer,b.byteOffset,b.byteLength), mode=b[0]&7, stratum=b[1];
  if(stratum===0) throw new Error('kiss-of-death: '+nsDec(b.subarray(12,16)));
  const t2=ntpTs(dv,32), t3=ntpTs(dv,40);
  return {stratum,mode,version:(b[0]>>3)&7,li:b[0]>>6,refid:stratum===1 ? nsDec(b.subarray(12,16)).replace(/\0+$/,'') : Array.from(b.subarray(12,16)).join('.'),
    offset:((t2-t1)+(t3-t4))/2,delay:(t4-t1)-(t3-t2),server:t3,poll:b[2],precision:(b[3]<<24>>24)};
}

/* ---------- syslog ---------- */
const SYSLOG_SEV=['emerg','alert','crit','err','warning','notice','info','debug'];
const SYSLOG_FAC=['kern','user','mail','daemon','auth','syslog','lpr','news','uucp','cron','authpriv','ftp','ntp','audit','alert','clock','local0','local1','local2','local3','local4','local5','local6','local7'];
const SYSLOG_MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function syslogBuild(o){
  const fac=Math.max(0,SYSLOG_FAC.indexOf(o.facility||'user')), sev=Math.max(0,SYSLOG_SEV.indexOf(o.severity||'info')), pri='<'+(fac*8+sev)+'>';
  const host=(o.host||'dsp').replace(/\s/g,'_'), app=(o.app||'dsp').replace(/\s/g,'_'), d=new Date(o.time||Date.now()), z=n=>String(n).padStart(2,'0');
  if(o.format==='5424') return pri+'1 '+d.toISOString()+' '+host+' '+app+' '+(o.pid||'-')+' - - '+(o.msg||'');
  return pri+SYSLOG_MON[d.getUTCMonth()]+' '+String(d.getUTCDate()).padStart(2,' ')+' '+z(d.getUTCHours())+':'+z(d.getUTCMinutes())+':'+z(d.getUTCSeconds())+' '+host+' '+app+(o.pid ? '['+o.pid+']' : '')+': '+(o.msg||'');
}
function syslogParse(text){
  const m=/^<(\d{1,3})>(.*)$/s.exec(String(text).replace(/\0+$/,'').trimEnd()); if(!m) return {msg:String(text).trim(),facility:'',severity:''};
  const pri=+m[1], r={facility:SYSLOG_FAC[pri>>3]||String(pri>>3),severity:SYSLOG_SEV[pri&7],rest:m[2]};
  let k;
  if((k=/^1 (\S+) (\S+) (\S+) (\S+) (\S+) (?:-|\[.*?\]) ?(.*)$/s.exec(m[2]))) return {...r,format:'5424',time:k[1],host:k[2],app:k[3],pid:k[4]==='-' ? '' : k[4],msg:k[6]};
  if((k=/^(\w{3} [ \d]\d \d\d:\d\d:\d\d) (\S+) (?:([^\s:\[]+)(?:\[(\d+)\])?: ?)?(.*)$/s.exec(m[2]))) return {...r,format:'3164',time:k[1],host:k[2],app:k[3]||'',pid:k[4]||'',msg:k[5]};
  return {...r,msg:m[2]};
}
// приём: udp.open на порту (от 1024); onRec(rec) на каждое сообщение
async function syslogListen(ns,port,onRec){
  const u=await ns.udpOpen(port,false); let on=true;
  (async()=>{ while(on && u.open){ let d; try{ d=await u.recv(0); }catch(e){ break; } if(!d) break; const t=nsDec(d.bytes); onRec({src:'syslog',peer:d.peer,from:d.peer.replace(/:\d+$/,''),raw:t.trimEnd(),...syslogParse(t)}); } })();
  return {port:u.port,close:async()=>{ on=false; await u.close(); }};
}

/* ---------- TFTP (RFC 1350, опции blksize / tsize — RFC 2347…2349) ---------- */
const TFTP_ERR={0:'not defined',1:'file not found',2:'access violation',3:'disk full',4:'illegal operation',5:'unknown transfer ID',6:'file exists',8:'option refused'};
const tftpErr=(code,msg)=>nsCat([new Uint8Array([0,5,code>>8,code&255]),nsEnc(msg||TFTP_ERR[code]||''),new Uint8Array([0])]);
const tftpAck=blk=>new Uint8Array([0,4,blk>>8&255,blk&255]);
const tftpData=(blk,d)=>nsCat([new Uint8Array([0,3,blk>>8&255,blk&255]),d]);
function tftpReq(op,file,mode='octet',opts={}){
  const parts=[new Uint8Array([0,op]),nsEnc(file),new Uint8Array([0]),nsEnc(mode),new Uint8Array([0])];
  for(const k in opts) parts.push(nsEnc(k),new Uint8Array([0]),nsEnc(String(opts[k])),new Uint8Array([0]));
  return nsCat(parts);
}
function tftpParse(b){
  if(b.length<4) return null;
  const op=(b[0]<<8)|b[1];
  if(op===3 || op===4) return {op,blk:(b[2]<<8)|b[3],data:b.subarray(4)};
  if(op===5) return {op,code:(b[2]<<8)|b[3],msg:nsDec(b.subarray(4)).replace(/\0.*$/s,'')};
  if(op===1 || op===2 || op===6){
    const parts=nsDec(b.subarray(2)).split('\0'); const r={op,file:parts[0],mode:(parts[1]||'').toLowerCase(),opts:{}};
    if(op===6){ r.opts={}; for(let i=0;i+1<parts.length;i+=2) if(parts[i]) r.opts[parts[i].toLowerCase()]=parts[i+1]; r.file=''; r.mode=''; }
    else for(let i=2;i+1<parts.length;i+=2) if(parts[i]) r.opts[parts[i].toLowerCase()]=parts[i+1];
    return r;
  }
  return null;
}
const tftpSplit=p=>{ const i=p.lastIndexOf(':'); return {h:p.slice(0,i),p:+p.slice(i+1),s:p}; };
const tftpOack=opts=>nsCat([new Uint8Array([0,6]),...Object.entries(opts).flatMap(([k,v])=>[nsEnc(k),new Uint8Array([0]),nsEnc(String(v)),new Uint8Array([0])])]);
async function tftpRecv(u,ms,peer){                                         // пакет от нужного отправителя (peer — «ip:port», пусто — от любого)
  const end=Date.now()+ms;
  for(;;){
    const left=end-Date.now(); if(left<=0) throw new Error('timeout');
    const d=await u.recv(left); if(!d) throw new Error('socket closed');
    if(!peer || d.peer===peer) return d;
  }
}
// обмен «отправил — жду нужный ответ»: повтор последнего пакета при тишине; onPkt(p) → true, когда ответ тот
async function tftpExchange(u,send,pkt,peer,onPkt,o){
  for(let tries=0;;){
    await send(pkt);
    for(;;){
      let d;
      try{ d=await tftpRecv(u,o.timeout||2000,peer ? peer.s : ''); }
      catch(e){ if(e.message!=='timeout') throw e; if(++tries>(o.retries||4)) throw new Error('no answer from the other side'); break; }
      const p=tftpParse(d.bytes); if(!p) continue;
      if(p.op===5) throw new Error(p.msg||TFTP_ERR[p.code]||('error '+p.code));
      const r=onPkt(p,d); if(r) return {p,d};
    }
  }
}
// Блоки: общий цикл отправки / приёма для клиента и сервера. Опции — blksize, tsize, timeout, windowsize (RFC 2347…2349, 7440).
// Номера блоков в счёте считаются сквозными, на проводе — по модулю 65536 (после 65535 идёт 0, как у iPXE и pxelinux).
// Отправитель: total — число блоков (последний короче bs, пустой, если размер кратен bs); getBlock(i) → байты блока i (с 1).
async function tftpSendLoop(u,send,peer,total,getBlock,win,o,onAck){
  let base=1, retries=0;
  while(base<=total){
    const top=Math.min(total,base+win-1);
    for(let b=base;b<=top;b++) await send(tftpData(b&65535,await getBlock(b)));
    for(;;){
      let d;
      try{ d=await tftpRecv(u,o.timeout||2000,peer.s); }
      catch(e){ if(e.message!=='timeout') throw e; if(++retries>(o.retries||4)) throw new Error('no answer from the other side'); break; }  // тишина → окно сначала
      const p=tftpParse(d.bytes); if(!p) continue;
      if(p.op===5) throw new Error(p.msg||TFTP_ERR[p.code]||('error '+p.code));
      if(p.op!==4) continue;
      const abs=(base-1)+(((p.blk-(base-1))%65536)+65536)%65536;       // 16 бит → сквозной номер в пределах окна
      if(abs<base || abs>top) continue;                                // повтор старого ACK — игнорируем (без «ученика чародея»)
      base=abs+1; retries=0; onAck?.(abs); break;
    }
  }
}
// Приёмник: first — уже принятый пакет данных (или null), lastPkt — что повторять при тишине (ACK/OACK); onBlock(bytes) — по порядку
async function tftpRecvLoop(u,send,peer,lastPkt,bs,win,o,onBlock,first){
  let expect=1, inWin=0, retries=0, pend=first||null;
  for(;;){
    let p;
    if(pend){ p=pend; pend=null; }
    else {
      let d;
      try{ d=await tftpRecv(u,o.timeout||2000,peer.s); }
      catch(e){ if(e.message!=='timeout') throw e; if(++retries>(o.retries||4)) throw new Error('no answer from the other side'); await send(lastPkt); continue; }
      p=tftpParse(d.bytes); if(!p) continue;
    }
    if(p.op===5) throw new Error(p.msg||TFTP_ERR[p.code]||('error '+p.code));
    if(p.op!==3) continue;
    retries=0;
    if(p.blk!==(expect&65535)){ lastPkt=tftpAck((expect-1)&65535); await send(lastPkt); inWin=0; continue; }   // пропуск или повтор: просим продолжить с нужного
    await onBlock(p.data); expect++; inWin++;
    if(p.data.length<bs){ lastPkt=tftpAck(p.blk); await send(lastPkt); return; }
    if(inWin>=win){ lastPkt=tftpAck(p.blk); await send(lastPkt); inWin=0; }
  }
}
// клиент читает файл. o: blksize, windowsize, timeout, retries, onProgress(got,tsize)
async function tftpGet(ns,host,port,file,o={}){
  const u=await ns.udpOpen(0,false);
  try{
    let peer=null, bs=512, win=1, tsize=0, got=0; const out=[];
    const send=pkt=>peer ? u.send(peer.h,peer.p,pkt) : u.send(host,port,pkt);
    const opts={}; if(o.blksize) opts.blksize=o.blksize; if(o.windowsize>1) opts.windowsize=o.windowsize; if(Object.keys(opts).length) opts.tsize=0;
    const req=tftpReq(1,file,'octet',opts);
    const {p,d}=await tftpExchange(u,send,req,null,p=>p.op===6 || (p.op===3 && p.blk===1),o);
    peer=tftpSplit(d.peer);
    let lastPkt, first=null;
    if(p.op===6){
      bs=Math.max(8,+p.opts.blksize||512); tsize=+p.opts.tsize||0; win=Math.max(1,+p.opts.windowsize||1);
      lastPkt=tftpAck(0); await send(lastPkt);
    } else { first=p; lastPkt=req; }
    await tftpRecvLoop(u,send,peer,lastPkt,bs,win,o,b=>{ out.push(b); got+=b.length; o.onProgress?.(got,tsize); },first);
    return nsCat(out);
  } finally { await u.close(); }
}
// клиент пишет файл
async function tftpPut(ns,host,port,file,bytes,o={}){
  if(typeof bytes==='string') bytes=nsEnc(bytes);
  const u=await ns.udpOpen(0,false);
  try{
    let peer=null, bs=512, win=1;
    const send=pkt=>peer ? u.send(peer.h,peer.p,pkt) : u.send(host,port,pkt);
    const opts={}; if(o.blksize) opts.blksize=o.blksize; if(o.windowsize>1) opts.windowsize=o.windowsize; if(Object.keys(opts).length) opts.tsize=bytes.length;
    const {p,d}=await tftpExchange(u,send,tftpReq(2,file,'octet',opts),null,p=>p.op===6 || (p.op===4 && p.blk===0),o);
    peer=tftpSplit(d.peer);
    if(p.op===6){ bs=Math.max(8,+p.opts.blksize||512); win=Math.max(1,+p.opts.windowsize||1); }
    const total=Math.floor(bytes.length/bs)+1;
    await tftpSendLoop(u,send,peer,total,i=>bytes.subarray((i-1)*bs,i*bs),win,o,abs=>o.onProgress?.(Math.min(bytes.length,abs*bs),bytes.length));
    return bytes.length;
  } finally { await u.close(); }
}
// сервер: слушает port, на каждый запрос — свой сокет (свой TID). vfs — как у FTP / HTTP; write — разрешить WRQ.
// Для сетевой загрузки (PXE, iPXE, pxelinux, U-Boot, прошивки): путь с «\» и «//» приводится к «/…», файл читается кусками (образ в сотни МБ не лежит в памяти целиком),
// опции blksize / tsize / windowsize / timeout принимаются, неизвестные молча отбрасываются. opt: maxBlk (по умолчанию 65464), maxWin (по умолчанию 64), maxBytes (запись)
class TftpServer{
  constructor(ns,vfs,opt={}){ this.ns=ns; this.vfs=vfs; this.opt=opt; this.u=null; this.on=false; this.active=0; this.stats={reads:0,writes:0,tx:0,rx:0,errors:0}; }
  async start(port){ this.u=await this.ns.udpOpen(port,false); this.on=true; this._loop(); return this.u.port; }
  async stop(){ this.on=false; if(this.u) await this.u.close(); this.u=null; }
  async _loop(){
    while(this.on && this.u){
      let d; try{ d=await this.u.recv(0); }catch(e){ break; } if(!d) break;
      const p=tftpParse(d.bytes); if(!p || (p.op!==1 && p.op!==2)) continue;
      this.active++; this._xfer(p,d.peer).catch(e=>{ this.stats.errors++; this.opt.onLog?.({ev:'error',path:p.file,bytes:0,peer:d.peer,msg:String(e&&e.message||e)}); }).finally(()=>{ this.active--; });
    }
  }
  async _xfer(p,peerStr){
    const peer=tftpSplit(peerStr), u=await this.ns.udpOpen(0,false), send=pkt=>u.send(peer.h,peer.p,pkt), o={timeout:this.opt.timeout,retries:this.opt.retries};
    try{
      const path=vfsNorm('/'+String(p.file).replace(/\\/g,'/')), oack={}; let bs=512, win=1;
      const st=await this.vfs.stat(path);
      if(p.opts.blksize){ bs=Math.max(8,Math.min(this.opt.maxBlk||65464,+p.opts.blksize||512)); oack.blksize=bs; }
      if(p.opts.timeout){ const t=Math.max(1,Math.min(255,+p.opts.timeout||0)); if(t){ oack.timeout=t; o.timeout=t*1000; } }
      if(p.opts.windowsize){ win=Math.max(1,Math.min(this.opt.maxWin||64,+p.opts.windowsize||1)); oack.windowsize=win; }
      const log=(ev,n)=>this.opt.onLog?.({ev,path,bytes:n,peer:peerStr});
      if(p.op===1){
        if(!st || st.dir){ await send(tftpErr(1)); this.opt.onLog?.({ev:'notfound',path,bytes:0,peer:peerStr}); return; }
        const size=st.size!=null ? st.size : (await this.vfs.read(path)).length;
        if(p.opts.tsize!==undefined) oack.tsize=size;
        if(Object.keys(oack).length) await tftpExchange(u,send,tftpOack(oack),peer,a=>a.op===4 && a.blk===0,o);
        const total=Math.floor(size/bs)+1, span=bs*Math.max(win,32);            // читаем из vfs кусками «span» байт, раздаём блоками
        let cache={a:0,b:0,d:null};
        const getBlock=async i=>{
          const a=(i-1)*bs, e=Math.min(size,a+bs);
          if(a>=size) return new Uint8Array(0);
          if(!cache.d || a<cache.a || e>cache.b){ const from=a, to=Math.min(size,a+span); cache={a:from,b:to,d:await this.vfs.read(path,from,to)}; }
          return cache.d.subarray(a-cache.a,e-cache.a);
        };
        let sent=0;
        await tftpSendLoop(u,send,peer,total,getBlock,win,o,abs=>{ sent=Math.min(size,abs*bs); });
        this.stats.reads++; this.stats.tx+=size; log('download',size);
      } else {
        if(!this.opt.write){ await send(tftpErr(2,'read only')); this.opt.onLog?.({ev:'denied',path,bytes:0,peer:peerStr}); return; }
        if(st && st.dir){ await send(tftpErr(2,'is a directory')); return; }
        const chunks=[]; let got=0;
        const last=Object.keys(oack).length ? tftpOack(oack) : tftpAck(0);
        await send(last);
        let over=false;
        try{
          await tftpRecvLoop(u,send,peer,last,bs,win,o,b=>{ chunks.push(b); got+=b.length; if(got>(this.opt.maxBytes||(64<<20))){ over=true; throw new Error('too big'); } });
        }catch(e){ if(over) await send(tftpErr(3)); throw e; }
        const all=nsCat(chunks); await this.vfs.write(path,all); this.stats.writes++; this.stats.rx+=all.length; log('upload',all.length); this.opt.onUpload?.(path,all);
      }
    } finally { await u.close(); }
  }
}

/* ---------- Telnet ---------- */
// Разбор потока: команды IAC убираются (на запросы отвечаем отказом, кроме подавления GA и эха сервера), остальное — текст
class TelnetCodec{
  constructor(){ this.state=0; this.cmd=0; this.sb=[]; this.out=[]; }
  // → {text: Uint8Array, reply: Uint8Array}
  feed(b){
    const text=[], reply=[];
    for(const x of b){
      switch(this.state){
        case 0: if(x===255) this.state=1; else text.push(x); break;
        case 1: if(x===255){ text.push(255); this.state=0; } else if(x>=251 && x<=254){ this.cmd=x; this.state=2; } else if(x===250){ this.sb=[]; this.state=3; } else this.state=0; break;
        case 2: {
          const opt=x;
          if(this.cmd===253) reply.push(255,252,opt);                                    // DO → WONT
          else if(this.cmd===251) reply.push(255,(opt===1 || opt===3) ? 253 : 254,opt);  // WILL: эхо и подавление GA принимаем, остальное DONT
          this.state=0; break;
        }
        case 3: if(x===255) this.state=4; else this.sb.push(x); break;
        case 4: this.state=x===240 ? 0 : 3; break;
      }
    }
    return {text:Uint8Array.from(text),reply:Uint8Array.from(reply)};
  }
}
const telnetEscape=b=>{ const o=[]; for(const x of b){ o.push(x); if(x===255) o.push(255); } return Uint8Array.from(o); };

const nsB64=b=>{ let s=''; for(let i=0;i<b.length;i+=8192) s+=String.fromCharCode.apply(null,b.subarray(i,i+8192)); return btoa(s); };

/* ---------- SMTP (без шифрования: порт 25 / 587 локальной сети, MTA на роутере, почтовые ловушки) ---------- */
function smtpMessage(o){
  const crlf=s=>String(s).replace(/\r?\n/g,'\r\n').replace(/^\./mg,'..');
  const h=['From: '+o.from,'To: '+(Array.isArray(o.to) ? o.to.join(', ') : o.to),'Subject: '+String(o.subject||'').replace(/[\r\n]+/g,' '),'Date: '+new Date(o.time||Date.now()).toUTCString(),
    'Message-ID: <'+Date.now().toString(36)+'.'+Math.random().toString(36).slice(2,8)+'@dsp>','MIME-Version: 1.0','Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: base64'];
  const b64=nsB64(nsEnc(String(o.body||'')));
  return h.join('\r\n')+'\r\n\r\n'+b64.replace(/(.{76})/g,'$1\r\n')+'\r\n';
}
async function smtpSend(ns,o){
  const c=await ns.connect(o.host,o.port||25,o.timeout||8000), ms=o.timeout||15000;
  const reply=async()=>{
    let code, text=''; for(;;){ const l=await c.readLine(ms); if(l==null) throw new Error('connection closed'); const m=/^(\d{3})([ -])(.*)$/.exec(l); if(!m) throw new Error('bad reply: '+l); code=+m[1]; text+=m[3]+'\n'; if(m[2]===' ') break; }
    return {code,text:text.trim()};
  };
  const cmd=async(line,ok)=>{ await c.write(line+'\r\n'); const r=await reply(); if(!ok.includes(r.code)) throw new Error(r.code+' '+r.text); return r; };
  try{
    const hi=await reply(); if(hi.code!==220) throw new Error(hi.code+' '+hi.text);
    const eh=await cmd('EHLO dsp.local',[250]);
    if(o.user){
      if(/AUTH[^\n]*PLAIN/i.test(eh.text)) await cmd('AUTH PLAIN '+btoa('\0'+o.user+'\0'+(o.pass||'')),[235]);
      else if(/AUTH[^\n]*LOGIN/i.test(eh.text)){ await cmd('AUTH LOGIN',[334]); await cmd(btoa(o.user),[334]); await cmd(btoa(o.pass||''),[235]); }
      else throw new Error('the server offers no AUTH without TLS');
    }
    await cmd('MAIL FROM:<'+o.from+'>',[250]);
    const to=Array.isArray(o.to) ? o.to : String(o.to).split(/[,;\s]+/).filter(Boolean);
    for(const t of to) await cmd('RCPT TO:<'+t+'>',[250,251]);
    await cmd('DATA',[354]);
    await c.write(smtpMessage({...o,to}).replace(/\r\n$/,'')+'\r\n.\r\n');
    const fin=await reply(); if(fin.code!==250) throw new Error(fin.code+' '+fin.text);
    try{ await cmd('QUIT',[221]); }catch(e){}
    return fin.text;
  } finally { await c.close(); }
}

/* ---------- сборка NTP и TFTP (зеркало ntpParse / tftpParse) ---------- */
const ntpPutTs=(dv,o,ms)=>{ const s=ms/1000+NTP_EPOCH, sec=Math.floor(s); dv.setUint32(o,sec>>>0); dv.setUint32(o+4,Math.floor((s-sec)*4294967296)>>>0); };
// ответ сервера: o {li,version,mode,stratum,poll,precision,refid,rx (приняли, мс от 1970),tx (отправили)}
function ntpBuild(o){
  const p=new Uint8Array(48), dv=new DataView(p.buffer);
  p[0]=((o.li||0)<<6)|(((o.version==null ? 4 : o.version)&7)<<3)|((o.mode==null ? 4 : o.mode)&7);
  p[1]=o.stratum==null ? 2 : o.stratum; p[2]=o.poll==null ? 6 : o.poll; p[3]=(o.precision==null ? -20 : o.precision)&255;
  const r=String(o.refid==null ? '' : o.refid);
  if(/^\d+\.\d+\.\d+\.\d+$/.test(r)) r.split('.').forEach((x,i)=>{ p[12+i]=+x&255; });
  else for(let i=0;i<4 && i<r.length;i++) p[12+i]=r.charCodeAt(i)&255;
  ntpPutTs(dv,32,o.rx); ntpPutTs(dv,40,o.tx);
  return p;
}
// o: {op, file, mode, opts} / {op, blk, data} / {op, code, msg}
function tftpBuild(o){
  const z=new Uint8Array([0]), op=o.op, hd=new Uint8Array([0,op]), W=(...n)=>new Uint8Array(n);
  if(op===3 || op===4) return nsCat([hd,W((o.blk>>8)&255,o.blk&255),op===3 ? (o.data||new Uint8Array(0)) : new Uint8Array(0)]);
  if(op===5) return nsCat([hd,W((o.code>>8)&255,o.code&255),nsEnc(o.msg||''),z]);
  if(op===1 || op===2 || op===6){
    const parts=[hd];
    if(op!==6) parts.push(nsEnc(o.file||''),z,nsEnc(o.mode||'octet'),z);
    for(const k in (o.opts||{})) parts.push(nsEnc(k),z,nsEnc(String(o.opts[k])),z);
    return nsCat(parts);
  }
  throw new Error('unknown TFTP opcode: '+op);
}
