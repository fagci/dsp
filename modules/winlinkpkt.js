"use strict";
/* ============================ Winlink по пакетному радио (AX.25 + B2F) ============================
   Winlink Packet — станция: AX.25 в режиме соединения (ax25link-kernels.js) и сессия B2F (winlink-kernels.js, сжатие LZHUF).
   Клиент (role = client) по Connect набирает шлюз (peer), обменивается почтой и отключается; шлюз (role = gateway) принимает
   соединение от кого угодно. Кадры идут «как есть»: blk на входе (от Receive AX.25) и на выходе frame, либо битовым потоком bit
   (HDLC + NRZI, как у Transmit AX.25) в Bell 202-модем. Почта: поля to / subject / body и кнопка Queue message либо вход msg
   (rec {to, subject, body}); принятые письма — в rec. Лишний пакет «шлюза» не излучать: это проверка без эфира. VARA и Pactor
   здесь нет (проприетарные); совместимость с живым RMS / CMS не проверялась (см. winlink-kernels.js). */

const wpShow=(n,t)=>{ const r=n.el && n.el.querySelector('.readout'); if(r && r.textContent!==t) r.textContent=t; };
const wpMid=()=>{ let s=''; const a='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; for(let i=0;i<12;i++) s+=a[Math.floor(Math.random()*a.length)]; return s; };
const wpDate=()=>{ const d=new Date(), p=x=>String(x).padStart(2,'0'); return d.getUTCFullYear()+'/'+p(d.getUTCMonth()+1)+'/'+p(d.getUTCDate())+' '+p(d.getUTCHours())+':'+p(d.getUTCMinutes()); };
function wpQueue(n,o){
  const my=String(n.p.mycall).toUpperCase(), to=String(o.to||n.p.to||'').trim(); if(!to) return false;
  const m={mid:wpMid(), date:wpDate(), type:'Private', from:my, to:[to], subject:String(o.subject??n.p.subject), body:String(o.body??n.p.body), files:[]};
  n.outbox.push(m); n.status='queued '+m.mid+' → '+to; n.rev++; return true;
}
// блок ±1 (MSB первым) ↔ байты; ax25Rx отдаёт кадр без FCS
const wpBytes=b=>{ if(!b || !b.d) return null; const n=b.n>>3, o=new Uint8Array(n); for(let i=0;i<n;i++){ let v=0; for(let k=0;k<8;k++) v=(v<<1)|(b.d[i*8+k]>0 ? 1 : 0); o[i]=v; } return o; };
const wpBlk=(bytes,id)=>{ const d=new Float32Array(bytes.length*8); for(let i=0;i<bytes.length;i++) for(let k=0;k<8;k++) d[i*8+k]=(bytes[i]>>(7-k))&1 ? 1 : -1; return {d,n:d.length,id}; };
// кадр → уровни NRZI по битам (флаги, данные с FCS и вставкой нулей, флаги)
function wpWire(bytes,pre,post){
  const body=Array.from(bytes), fcs=crcCalc(body,CRCS['CRC-16/X.25 (HDLC)']); body.push(fcs&255,(fcs>>8)&255);
  const flag=[0,1,1,1,1,1,1,0], bits=[];
  for(let i=0;i<pre;i++) bits.push(...flag);
  bits.push(...ax25StuffBits(body));
  for(let i=0;i<post;i++) bits.push(...flag);
  let lvl=0; return bits.map(b=>{ if(!b) lvl^=1; return lvl; });
}
function wpSession(n){
  n.sess=wlSessNew(n.p.role==='client' ? 'client' : 'server',{call:String(n.p.mycall).toUpperCase(), outbox:n.outbox.slice(), seen:n.seen});
  n.sess.snap=n.outbox.slice(); wlSessStart(n.sess); n.inN=0;
}
def({ id:'winlinkPkt', title:'Winlink Packet (AX.25 + B2F)', cat:'Protocols', readout:true, tall:true, w:360,
  kw:'winlink packet radio ax25 b2f lzhuf email rms gateway message ares emcomm connected mode',
  ins:[{n:'blk',t:'blk'},{n:'connect',t:'num'},{n:'msg',t:'rec'}],
  outs:[{n:'bit',t:'sig'},{n:'frame',t:'blk'},{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'connected',t:'num'},{n:'busy',t:'num'}],
  params:[{n:'role',t:'select',opts:['client','gateway'],d:'client',label:'role: client dials, gateway answers'},
          {n:'mycall',t:'text',d:'N0CALL-1',label:'my callsign-SSID'},
          {n:'peer',t:'text',d:'W1AW-10',label:'gateway to dial (client)'},
          {n:'via',t:'text',d:'',label:'digipeaters, comma separated (empty — direct)'},
          {n:'to',t:'text',d:'W1AW@winlink.org',label:'message: to'},
          {n:'subject',t:'text',d:'Status report',label:'message: subject'},
          {n:'body',t:'text',d:'All stations checked in. Test message from DSP workbench.',label:'message: body'},
          {n:'queue',t:'button',label:'Queue message',fn:n=>{ wpQueue(n,{}); }},
          {n:'dial',t:'button',label:'Connect (client)',fn:n=>{ n.want=true; }},
          {n:'autoMsg',t:'check',d:false,label:'queue the message above at start'},
          {n:'autoDial',t:'check',d:false,label:'dial 1 s after start (client)'},
          {n:'baud',t:'range',min:300,max:9600,step:1,d:1200,log:true,label:'bit rate of the «bit» output'},
          {n:'paclen',t:'range',min:32,max:256,step:8,d:128,label:'bytes in a frame (paclen)'},
          {n:'t1',t:'range',min:1,max:20,step:.5,d:4,label:'T1, s (wait before a repeat)'},
          {n:'loss',t:'range',min:0,max:60,step:1,d:0,label:'drop frames on output, % (channel test)'}],
  init:n=>{ n.link=null; n.sess=null; n.outbox=[]; n.seen=[]; n.inbox=[]; n.want=false; n.prevC=0; n.txq=[]; n.fq=[]; n.cur=0; n.left=0; n.status='waiting'; n.rev=0;
            n.t0=0; n.auto=false; n.fid=0; n.inN=0; n.lastState='disc'; n.log=[]; n.key=''; n.lastFrame=null; n.lastIn=-1; n.dialed=false; n.nlog=0; },
  process(n,I){
    const p=n.p, key=[p.mycall,p.peer,p.via,p.role,p.paclen,p.t1].join('|');
    if(n.key!==key || !n.link){
      n.key=key; const old=n.link;
      n.link=axLinkNew({mycall:String(p.mycall).toUpperCase(), peer:p.role==='client' ? String(p.peer).toUpperCase() : null, digis:String(p.via).split(',').map(s=>s.trim()).filter(Boolean).map(axCall).filter(Boolean),
        listen:p.role!=='client', paclen:+p.paclen, t1:+p.t1, n2:12});
      if(old && old.state==='conn'){ n.link.state='disc'; } n.sess=null; n.lastState='disc';
    }
    const dt=BLOCK/Eng.sr, L=n.link;
    if(!n.auto){ n.auto=true; n.t0=0; if(p.autoMsg) wpQueue(n,{}); }
    n.t0+=dt;
    if(p.autoDial && p.role==='client' && !n.dialed && n.t0>1){ n.dialed=true; n.want=true; }
    const c=I.connect||0; if(c>.5 && n.prevC<=.5) n.want=true; n.prevC=c;
    // сообщения с провода
    for(const m of recList(I.msg)) if(m && (m.to || m.subject!==undefined)) wpQueue(n,{to:m.to,subject:m.subject,body:m.body ?? m.text});
    if(n.want && p.role==='client' && L.state==='disc'){ n.want=false; wpSession(n); n.sess.state='idle'; axLinkConnect(L); n.status='dialing '+p.peer; n.rev++; }
    else if(n.want) n.want=false;
    // кадры на входе
    const fb=I.blk && wpBytes(I.blk);
    if(fb && I.blk.id!==n.lastIn){ n.lastIn=I.blk.id; axLinkRx(L,fb); }
    axLinkTick(L,dt);
    // переходы звена → сессия
    if(L.state==='conn' && n.lastState!=='conn'){ if(p.role==='client' && n.sess){ n.sess=null; } wpSession(n); n.status='link up with '+axName(L.peer); n.rev++; }
    if(L.state==='disc' && n.lastState!=='disc'){ n.status='link down'+(n.sess ? ' ('+(n.sess.done ? 'session done' : 'session cut') +')' : ''); n.sess=null; n.rev++; }
    n.lastState=L.state;
    const recs=[];
    if(L.state==='conn' && n.sess){
      if(L.rxData.length){ wlSessRx(n.sess,Uint8Array.from(L.rxData.splice(0))); }
      const out=wlSessOut(n.sess); if(out.length) axLinkSend(L,out);
      while(n.inN<n.sess.inbox.length){ const m=n.sess.inbox[n.inN++]; n.seen.push(m.mid); n.inbox.push(m);
        recs.push({t:Date.now(), src:'WINLINK', id:m.mid, kind:'message', mid:m.mid, from:m.from, to:m.to.join(', '), subject:m.subject, body:m.body, files:m.files.length, text:m.from+' → '+m.to.join(', ')+': '+m.subject}); n.rev++; }
      if(n.sess.done && !L.out.length && !L.sendQ.length && p.role==='client' && !n.sess.disc){ axLinkDisc(L); n.sess.disc=true; }
      n.outbox=n.outbox.filter(m=>!(n.sess.snap.includes(m) && !n.sess.outbox.includes(m)));      // отправленные уходят из очереди
    }
    // кадры на выходе: по одному за такт; последний кадр держится на выходе (получатель отличает его по id)
    for(const f of L.tx.splice(0)) if(Math.random()*100>=+p.loss) n.fq.push(f);
    if(n.fq.length){ const f=n.fq.shift(); n.lastFrame=wpBlk(f,++n.fid); if(p.baud>0) n.txq.push(...wpWire(f,6,2)); }
    const o=buf(n,'bit'), spb=Eng.sr/Math.max(1,+p.baud);
    for(let i=0;i<BLOCK;i++){
      if(n.left<=0){ if(n.txq.length) n.cur=n.txq.shift(); n.left=spb; }
      n.left--; o[i]=n.cur ? 1 : -1;
    }
    for(const e of L.events.splice(0)){ n.log.push(e); }
    if(n.sess) for(const e of n.sess.log.splice(0)) n.log.push(e);
    if(n.log.length>14) n.log.splice(0,n.log.length-14);
    return {bit:o, frame:n.lastFrame||null, rec:recs.length ? recs : null, text:recs.length ? recs.map(r=>r.text).join('\n') : null, connected:L.state==='conn' ? 1 : 0, busy:(n.fq.length||n.txq.length||L.out.length||L.sendQ.length) ? 1 : 0};
  },
  drawKey:n=>n.rev+'|'+(n.link&&n.link.state)+'|'+n.log.length+'|'+n.inbox.length,
  draw(n){ const L=n.link; if(!L) return;
    wpShow(n,n.p.role+' '+n.p.mycall+' · '+L.state+(L.peer ? ' ↔ '+axName(L.peer) : '')+' · out '+n.outbox.length+' · in '+n.inbox.length+'\n'+n.status+
      (n.inbox.length ? '\n✉ '+n.inbox.slice(-3).map(m=>m.from+': '+m.subject).join('\n✉ ') : '')+(n.log.length ? '\n'+n.log.slice(-8).join('\n') : '')); }
});
