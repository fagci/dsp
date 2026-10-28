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
// клиент читает файл
async function tftpGet(ns,host,port,file,o={}){
  const u=await ns.udpOpen(0,false);
  try{
    let peer=null, bs=512, expect=1, got=0, tsize=0; const out=[];
    const send=pkt=>peer ? u.send(peer.h,peer.p,pkt) : u.send(host,port,pkt);
    let pkt=tftpReq(1,file,'octet',o.blksize ? {blksize:o.blksize,tsize:0} : {});
    for(;;){
      const {p,d}=await tftpExchange(u,send,pkt,peer,p=>(p.op===6 && expect===1 && !got) || (p.op===3 && (p.blk===(expect&65535) || p.blk===((expect-1)&65535))),o);
      if(!peer) peer=tftpSplit(d.peer);
      if(p.op===6){ bs=+p.opts.blksize||512; tsize=+p.opts.tsize||0; pkt=tftpAck(0); continue; }
      if(p.blk!==(expect&65535)){ pkt=tftpAck(p.blk); continue; }              // повтор уже принятого блока
      out.push(p.data); got+=p.data.length; o.onProgress?.(got,tsize);
      pkt=tftpAck(p.blk); expect++;
      if(p.data.length<bs){ await send(pkt); return nsCat(out); }
    }
  } finally { await u.close(); }
}
// клиент пишет файл
async function tftpPut(ns,host,port,file,bytes,o={}){
  if(typeof bytes==='string') bytes=nsEnc(bytes);
  const u=await ns.udpOpen(0,false);
  try{
    let peer=null, bs=512, blk=0;
    const send=pkt=>peer ? u.send(peer.h,peer.p,pkt) : u.send(host,port,pkt);
    let pkt=tftpReq(2,file,'octet',o.blksize ? {blksize:o.blksize,tsize:bytes.length} : {});
    for(;;){
      const {p,d}=await tftpExchange(u,send,pkt,peer,p=>(p.op===6 && blk===0) || (p.op===4 && p.blk===(blk&65535)),o);
      if(!peer) peer=tftpSplit(d.peer);
      if(p.op===6) bs=+p.opts.blksize||512;
      if(blk>0) o.onProgress?.(Math.min(bytes.length,blk*bs),bytes.length);
      if(blk*bs>bytes.length) return bytes.length;                            // подтверждён последний (в том числе пустой) блок
      blk++; pkt=tftpData(blk,bytes.subarray((blk-1)*bs,blk*bs));
    }
  } finally { await u.close(); }
}
// сервер: слушает port (от 1024), на каждый запрос — свой сокет (свой TID). vfs — как у FTP / HTTP; write — разрешить WRQ
class TftpServer{
  constructor(ns,vfs,opt={}){ this.ns=ns; this.vfs=vfs; this.opt=opt; this.u=null; this.on=false; this.stats={reads:0,writes:0,tx:0,rx:0}; }
  async start(port){ this.u=await this.ns.udpOpen(port,false); this.on=true; this._loop(); return this.u.port; }
  async stop(){ this.on=false; if(this.u) await this.u.close(); this.u=null; }
  async _loop(){
    while(this.on && this.u){
      let d; try{ d=await this.u.recv(0); }catch(e){ break; } if(!d) break;
      const p=tftpParse(d.bytes); if(!p || (p.op!==1 && p.op!==2)) continue;
      this._xfer(p,d.peer).catch(()=>{});
    }
  }
  async _xfer(p,peerStr){
    const peer=tftpSplit(peerStr), u=await this.ns.udpOpen(0,false), send=pkt=>u.send(peer.h,peer.p,pkt), o={timeout:this.opt.timeout,retries:this.opt.retries};
    try{
      const path=vfsNorm('/'+p.file), st=await this.vfs.stat(path), oack={}; let bs=512;
      if(p.opts.blksize){ bs=Math.max(8,Math.min(65464,+p.opts.blksize||512)); oack.blksize=bs; }
      const log=(ev,n)=>this.opt.onLog?.({ev,path,bytes:n,peer:peerStr});
      if(p.op===1){
        if(!st || st.dir){ await send(tftpErr(1)); return; }
        const bytes=await this.vfs.read(path);
        if(p.opts.tsize!==undefined) oack.tsize=bytes.length;
        if(Object.keys(oack).length) await tftpExchange(u,send,tftpOack(oack),peer,a=>a.op===4 && a.blk===0,o);
        const total=Math.floor(bytes.length/bs)+1;
        for(let blk=1;blk<=total;blk++) await tftpExchange(u,send,tftpData(blk,bytes.subarray((blk-1)*bs,blk*bs)),peer,a=>a.op===4 && a.blk===(blk&65535),o);
        this.stats.reads++; this.stats.tx+=bytes.length; log('download',bytes.length);
      } else {
        if(!this.opt.write){ await send(tftpErr(2,'read only')); return; }
        if(st && st.dir){ await send(tftpErr(2,'is a directory')); return; }
        const chunks=[]; let expect=1, got=0;
        let pkt=Object.keys(oack).length ? tftpOack(oack) : tftpAck(0);
        for(;;){
          const {p:a}=await tftpExchange(u,send,pkt,peer,a=>a.op===3 && (a.blk===(expect&65535) || a.blk===((expect-1)&65535)),o);
          if(a.blk!==(expect&65535)){ pkt=tftpAck(a.blk); continue; }
          chunks.push(a.data); got+=a.data.length; pkt=tftpAck(a.blk); expect++;
          if(a.data.length<bs){ await send(pkt); break; }
          if(got>(this.opt.maxBytes||(64<<20))){ await send(tftpErr(3)); return; }
        }
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
