"use strict";
/* ============================ AX.25 в режиме соединения (пакетное радио, mod 8) ============================
   Чистая логика без DOM (страница и Node). Пары: axBuild ↔ axParse (кадр без FCS: адреса, управляющее поле, PID, данные) и
   axLinkSend ↔ приём на другой стороне (tools/test-ax25link.mjs). Кадры: I (номер отправленного и принятого), S (RR / RNR /
   REJ), U (SABM / UA / DISC / DM / UI / FRMR). Звено (axLinkNew): соединение SABM → UA, окно k кадров, go-back-N по REJ и по
   таймеру T1 (N2 повторов), делится на кадры по paclen, отключение DISC → UA. Данные приходят в l.rxData, готовые кадры — в l.tx.
   Один канал на звено; множественные соединения, SREJ и mod 128 не делаются. */

const AX_REGEX=/^([A-Z0-9]{1,6})(?:-(\d{1,2}))?$/;
function axCall(s){ const m=AX_REGEX.exec(String(s).toUpperCase().trim()); if(!m) return null; return {call:m[1],ssid:m[2]?+m[2]:0}; }
const axName=a=>a.call+(a.ssid ? '-'+a.ssid : '');
// c — бит команда/ответ (бит 7 SSID-байта), last — признак конца адресного поля
function axAddr(a,c,last){
  const o=[]; for(let i=0;i<6;i++) o.push(((a.call.charCodeAt(i)||32)<<1)&0xFE);
  o.push(0x60|((a.ssid&15)<<1)|(c ? 0x80 : 0)|(last ? 1 : 0));
  return o;
}
const AX_U={SABM:0x2F,UA:0x63,DISC:0x43,DM:0x0F,UI:0x03,FRMR:0x87}, AX_S={RR:0,RNR:1,REJ:2,SREJ:3};
// f: {dst,src,digis:[],cmd:true|false, type:'I'|'RR'|'RNR'|'REJ'|'SABM'|…, ns, nr, pf, pid, info}
function axBuild(f){
  const dst=typeof f.dst==='string' ? axCall(f.dst) : f.dst, src=typeof f.src==='string' ? axCall(f.src) : f.src;
  const digis=(f.digis||[]).map(d=>typeof d==='string' ? axCall(d) : d);
  const o=[...axAddr(dst,f.cmd!==false,false), ...axAddr(src,f.cmd===false,!digis.length)];
  digis.forEach((d,i)=>o.push(...axAddr(d,false,i===digis.length-1)));
  const pf=f.pf ? 0x10 : 0, t=f.type;
  if(t==='I') o.push(((f.nr&7)<<5)|pf|((f.ns&7)<<1), f.pid??0xF0, ...(f.info||[]));
  else if(AX_S[t]!==undefined) o.push(((f.nr&7)<<5)|pf|(AX_S[t]<<2)|1);
  else { o.push(AX_U[t]|pf); if(t==='UI') o.push(f.pid??0xF0, ...(f.info||[])); }
  return Uint8Array.from(o);
}
function axParse(b){
  if(b.length<15) return null;
  const addr=i=>{ let s=''; for(let k=0;k<6;k++){ const c=(b[i+k]>>1)&0x7F; if(c!==32) s+=String.fromCharCode(c); } return {call:s,ssid:(b[i+6]>>1)&15,c:(b[i+6]&0x80)!==0,last:(b[i+6]&1)!==0}; };
  const dst=addr(0), src=addr(7), digis=[]; let p=14, last=src.last;
  while(!last){ if(p+7>b.length) return null; const d=addr(p); digis.push(d); last=d.last; p+=7; }
  if(p>=b.length) return null;
  const ctl=b[p], f={dst:{call:dst.call,ssid:dst.ssid}, src:{call:src.call,ssid:src.ssid}, digis:digis.map(d=>({call:d.call,ssid:d.ssid})), cmd:dst.c&&!src.c};
  if((ctl&1)===0){ if(p+1>=b.length) return null; Object.assign(f,{type:'I',ns:(ctl>>1)&7,nr:(ctl>>5)&7,pf:(ctl&0x10)!==0,pid:b[p+1],info:b.slice(p+2)}); }
  else if((ctl&3)===1){ const t=Object.keys(AX_S).find(k=>AX_S[k]===((ctl>>2)&3)); Object.assign(f,{type:t,nr:(ctl>>5)&7,pf:(ctl&0x10)!==0}); }
  else { const u=ctl&~0x10, t=Object.keys(AX_U).find(k=>AX_U[k]===u); if(!t) return null; Object.assign(f,{type:t,pf:(ctl&0x10)!==0}); if(t==='UI'&&p+1<b.length){ f.pid=b[p+1]; f.info=b.slice(p+2); } }
  return f;
}

/* ---------- звено ---------- */
function axLinkNew(o){
  return {my:axCall(o.mycall), peer:o.peer?axCall(o.peer):null, digis:o.digis||[], t1:o.t1??3, n2:o.n2??10, k:Math.min(7,o.k??4), paclen:o.paclen??128,
    state:'disc', vs:0, vr:0, va:0, sendQ:[], out:[], clk:0, retry:0, tx:[], rxData:[], events:[], listen:!!o.listen, rejSent:false, stats:{i:0,retx:0,rej:0}};
}
const axEv=(l,t)=>{ l.events.push(t); if(l.events.length>40) l.events.shift(); };
function axSendFrame(l,f){ l.tx.push(axBuild({dst:l.peer,src:l.my,digis:l.digis,...f})); }
function axLinkConnect(l,peer){ if(peer) l.peer=axCall(peer); if(!l.peer) return false; l.state='connecting'; l.retry=0; l.clk=0; l.vs=l.vr=l.va=0; l.out=[]; axSendFrame(l,{type:'SABM',pf:true,cmd:true}); axEv(l,'SABM → '+axName(l.peer)); return true; }
function axLinkDisc(l){ if(l.state==='disc') return; l.state='disconnecting'; l.retry=0; l.clk=0; axSendFrame(l,{type:'DISC',pf:true,cmd:true}); axEv(l,'DISC'); }
function axLinkSend(l,bytes){ for(const b of bytes) l.sendQ.push(b); axFill(l); }
function axFill(l){
  if(l.state!=='conn') return;
  while(l.out.length<l.k && l.sendQ.length){
    const info=l.sendQ.splice(0,l.paclen), f={type:'I',ns:l.vs,nr:l.vr,pf:false,pid:0xF0,info:Uint8Array.from(info),cmd:true};
    l.out.push(f); l.vs=(l.vs+1)&7; axSendFrame(l,f); l.stats.i++; if(l.out.length===1) l.clk=0;
  }
}
const axInWin=(l,nr)=>{ // nr подтверждает кадры va…nr-1
  let n=0; for(let v=l.va;v!==nr && n<8;v=(v+1)&7) n++;
  return n<=l.out.length; };
function axAck(l,nr){
  if(!axInWin(l,nr)) return;
  while(l.va!==nr){ l.out.shift(); l.va=(l.va+1)&7; l.retry=0; l.clk=0; }
}
function axRetx(l){ for(const f of l.out){ axSendFrame(l,{...f,nr:l.vr}); l.stats.retx++; } }
function axLinkRx(l,bytes){
  const f=axParse(bytes); if(!f) return;
  if(f.dst.call!==l.my.call || f.dst.ssid!==l.my.ssid) return;
  if(l.peer && (f.src.call!==l.peer.call || f.src.ssid!==l.peer.ssid)){
    if(!(l.listen && l.state==='disc' && f.type==='SABM')) return;
  }
  switch(f.type){
    case 'SABM':
      if(l.state==='disc' && !l.listen && !l.peer){ return; }
      l.peer=l.peer||f.src; l.state='conn'; l.vs=l.vr=l.va=0; l.out=[]; l.retry=0; l.rejSent=false;
      axSendFrame(l,{type:'UA',pf:f.pf,cmd:false}); axEv(l,'connected (from '+axName(f.src)+')'); break;
    case 'UA':
      if(l.state==='connecting'){ l.state='conn'; l.retry=0; l.clk=0; axEv(l,'connected'); axFill(l); }
      else if(l.state==='disconnecting'){ l.state='disc'; axEv(l,'disconnected'); }
      break;
    case 'DM': if(l.state==='connecting'||l.state==='disconnecting'){ l.state='disc'; axEv(l,'refused / disconnected (DM)'); } break;
    case 'DISC':
      if(l.state!=='disc'){ l.state='disc'; l.out=[]; axSendFrame(l,{type:'UA',pf:f.pf,cmd:false}); axEv(l,'peer disconnected'); }
      else axSendFrame(l,{type:'DM',pf:f.pf,cmd:false});
      break;
    case 'I':
      if(l.state!=='conn') { axSendFrame(l,{type:'DM',pf:f.pf,cmd:false}); break; }
      axAck(l,f.nr);
      if(f.ns===l.vr){ for(const x of f.info) l.rxData.push(x); l.vr=(l.vr+1)&7; l.rejSent=false; axSendFrame(l,{type:'RR',nr:l.vr,pf:f.pf,cmd:false}); }
      else if(!l.rejSent){ l.rejSent=true; l.stats.rej++; axSendFrame(l,{type:'REJ',nr:l.vr,pf:f.pf,cmd:false}); }
      else axSendFrame(l,{type:'RR',nr:l.vr,pf:f.pf,cmd:false});            // повтор уже принятого: подтвердить, иначе отправитель не узнает
      axFill(l); break;
    case 'RR': case 'RNR':
      if(l.state!=='conn') break;
      axAck(l,f.nr);
      if(f.cmd && f.pf) axSendFrame(l,{type:'RR',nr:l.vr,pf:true,cmd:false});
      axFill(l); break;
    case 'REJ':
      if(l.state!=='conn') break;
      axAck(l,f.nr); axRetx(l); l.clk=0; axFill(l); break;
  }
}
// dt — секунды; по T1 без подтверждения: повтор, после N2 повторов звено рвётся
function axLinkTick(l,dt){
  if(l.state==='disc') return;
  const wait=l.state==='connecting'||l.state==='disconnecting'||l.out.length>0;
  if(!wait) return;
  l.clk+=dt;
  if(l.clk<l.t1) return;
  l.clk=0;
  if(++l.retry>l.n2){ l.state='disc'; l.out=[]; axEv(l,'link failed: no answer after '+l.n2+' tries'); return; }
  if(l.state==='connecting') axSendFrame(l,{type:'SABM',pf:true,cmd:true});
  else if(l.state==='disconnecting') axSendFrame(l,{type:'DISC',pf:true,cmd:true});
  else axRetx(l);
}
