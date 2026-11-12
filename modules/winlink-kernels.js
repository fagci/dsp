"use strict";
/* ============================ Winlink: сообщение, упаковка B2, обмен B2F ============================
   Чистая логика без DOM (страница и Node). Пары «разбор ↔ сборка» зеркальны (tools/test-winlink.mjs):
   • wlMsgBuild ↔ wlMsgParse — сообщение Winlink: заголовки «Mid / Date / Type / From / To / Subject / Body: длина», пустая строка,
     тело, вложения «File: длина имя»; CRLF;
   • wlPack ↔ wlUnpack — упаковка B2: LZHUF (lzhuf-kernels.js) с CRC-16 CCITT (поли 0x1021, начальное 0) перед потоком;
   • wlPropose ↔ wlParseProposals, wlFsBuild ↔ wlFsParse — строки «FC EM MID размер сжатый 0», «F> контрольная сумма», «FS +-=»;
   • wlFrame ↔ wlDeframe — блоки данных: SOH длина «тема NUL смещение NUL», STX длина данные (≤250), EOT контрольная сумма;
   • wlSessNew / wlSessRx / wlSessOut — сессия (клиент и шлюз) поверх байтового канала: SID, предложения, ответы, данные, FF / FQ.
   Порядок байтов CRC, состав контрольных сумм и подробности SID сверены по памяти, не с настоящим шлюзом RMS / CMS:
   между собой работает, совместимость с живым Winlink не проверена. VARA и Pactor (проприетарные) здесь не реализуются. */

const WL_SOH=1, WL_STX=2, WL_EOT=4, WL_BLOCK=250;
const wlEnc=s=>Uint8Array.from(Array.from(String(s)).map(c=>c.charCodeAt(0)&255));                 // ISO-8859-1
const wlStr=b=>Array.from(b).map(c=>String.fromCharCode(c)).join('');
function wlCrc16(b){ let c=0; for(const x of b){ c^=x<<8; for(let k=0;k<8;k++) c=(c&0x8000) ? ((c<<1)^0x1021)&0xFFFF : (c<<1)&0xFFFF; } return c; }
const wlSum=b=>{ let s=0; for(const x of b) s=(s+x)&255; return (256-s)&255; };

/* ---------- сообщение ---------- */
function wlMsgBuild(m){
  const body=wlEnc(m.body||''), files=m.files||[];
  const h=['Mid: '+m.mid,'Date: '+(m.date||''),'Type: '+(m.type||'Private'),'From: '+m.from];
  for(const t of [].concat(m.to||[])) h.push('To: '+t);
  for(const t of [].concat(m.cc||[])) h.push('Cc: '+t);
  h.push('Subject: '+(m.subject||''),'Mbo: '+(m.mbo||m.from.split('@')[0].split('-')[0]));
  if(m.p2p) h.push('X-P2P: true');
  h.push('Body: '+body.length);
  for(const f of files) h.push('File: '+f.data.length+' '+f.name);
  const head=wlEnc(h.join('\r\n')+'\r\n\r\n'), parts=[head,body,wlEnc('\r\n')];
  for(const f of files){ parts.push(f.data,wlEnc('\r\n')); }
  const out=new Uint8Array(parts.reduce((a,p)=>a+p.length,0)); let o=0; for(const p of parts){ out.set(p,o); o+=p.length; }
  return out;
}
function wlMsgParse(b){
  const s=wlStr(b), i=s.indexOf('\r\n\r\n'); if(i<0) return null;
  const m={mid:'',date:'',type:'',from:'',to:[],cc:[],subject:'',mbo:'',p2p:false,body:'',files:[]};
  let bodyLen=null; const fl=[];
  for(const line of s.slice(0,i).split('\r\n')){
    const k=line.indexOf(': '); if(k<0) return null;
    const key=line.slice(0,k).toLowerCase(), v=line.slice(k+2);
    if(key==='mid') m.mid=v; else if(key==='date') m.date=v; else if(key==='type') m.type=v; else if(key==='from') m.from=v;
    else if(key==='to') m.to.push(v); else if(key==='cc') m.cc.push(v); else if(key==='subject') m.subject=v; else if(key==='mbo') m.mbo=v;
    else if(key==='x-p2p') m.p2p=v==='true'; else if(key==='body') bodyLen=+v;
    else if(key==='file'){ const q=/^(\d+) (.+)$/.exec(v); if(!q) return null; fl.push({len:+q[1],name:q[2]}); }
  }
  if(bodyLen===null || !m.mid || !m.from) return null;
  let p=i+4;
  if(p+bodyLen>b.length) return null;
  m.body=wlStr(b.subarray(p,p+bodyLen)); p+=bodyLen+2;
  for(const f of fl){ if(p+f.len>b.length) return null; m.files.push({name:f.name,data:b.slice(p,p+f.len)}); p+=f.len+2; }
  return m;
}

/* ---------- упаковка B2 ---------- */
function wlPack(b){
  const z=lzEncode(b), crc=wlCrc16(z), out=new Uint8Array(z.length+2);
  out[0]=crc>>8; out[1]=crc&255; out.set(z,2); return out;
}
function wlUnpack(b){
  if(b.length<6) return null;
  const z=b.subarray(2);
  if(wlCrc16(z)!==((b[0]<<8)|b[1])) return null;
  return lzDecode(z);
}

/* ---------- предложения ---------- */
function wlPropose(list){
  let s='', sum=0;
  const lines=list.map(p=>'FC EM '+p.mid+' '+p.usize+' '+p.csize+' 0\r');
  for(const l of lines) s+=l;
  for(const c of s) sum=(sum+c.charCodeAt(0))&255;
  return s+'F> '+((256-sum)&255).toString(16).toUpperCase().padStart(2,'0')+'\r';
}
// строки «FC … » и «F> xx» (без возврата) → [{mid,usize,csize}] | null (контрольная сумма не сошлась)
function wlParseProposals(lines){
  const list=[]; let sum=0, cs=null;
  for(const l of lines){
    if(/^F> /.test(l)) cs=parseInt(l.slice(3),16);
    else { const m=/^FC EM (\S+) (\d+) (\d+) 0$/.exec(l); if(!m) return null; list.push({mid:m[1],usize:+m[2],csize:+m[3]}); for(const c of l+'\r') sum=(sum+c.charCodeAt(0))&255; }
  }
  return cs!==null && ((256-sum)&255)===cs ? list : null;
}
const wlFsBuild=a=>'FS '+a.map(x=>x==='accept'?'+':x==='defer'?'=':'-').join('')+'\r';
const wlFsParse=l=>{ const m=/^FS ([+\-=]+)$/.exec(l); return m ? Array.from(m[1]).map(c=>c==='+'?'accept':c==='='?'defer':'reject') : null; };

/* ---------- блоки данных ---------- */
function wlFrame(title,data){
  const out=[], tt=wlEnc(title+'\0'+'0'+'\0');
  out.push(WL_SOH,tt.length,...tt);
  let sum=0; for(const x of tt) sum=(sum+x)&255;
  for(let o=0;o<data.length;o+=WL_BLOCK){ const c=data.subarray(o,Math.min(data.length,o+WL_BLOCK)); out.push(WL_STX,c.length,...c); for(const x of c) sum=(sum+x)&255; }
  out.push(WL_EOT,(256-sum)&255);
  return Uint8Array.from(out);
}
// байты → {done,used,title,data,ok}; done=false — не хватает данных
function wlDeframe(b){
  let i=0, sum=0, title=null; const parts=[];
  if(b[0]!==WL_SOH) return {done:true,used:0,ok:false};
  while(i<b.length){
    const t=b[i];
    if(t===WL_SOH){ if(i+2>b.length) break; const n=b[i+1]; if(i+2+n>b.length) break; const p=b.subarray(i+2,i+2+n); for(const x of p) sum=(sum+x)&255; title=wlStr(p).split('\0')[0]; i+=2+n; }
    else if(t===WL_STX){ if(i+2>b.length) break; const n=b[i+1]||256; if(i+2+n>b.length) break; const p=b.subarray(i+2,i+2+n); for(const x of p) sum=(sum+x)&255; parts.push(p); i+=2+n; }
    else if(t===WL_EOT){ if(i+2>b.length) break; const ok=((sum+b[i+1])&255)===0; const data=new Uint8Array(parts.reduce((a,p)=>a+p.length,0)); let o=0; for(const p of parts){ data.set(p,o); o+=p.length; } return {done:true,used:i+2,ok,title,data}; }
    else return {done:true,used:i,ok:false};
  }
  return {done:false};
}

/* ---------- сессия ---------- */
// cfg: {call, sid}; role 'client' | 'server'; outbox — [{mid,…}] (сообщения wlMsgBuild-формата), inbox наполняется
function wlSessNew(role,cfg){
  return {role, call:cfg.call, peer:'', sid:cfg.sid||'[DSP-1.0-B2FIHM$]', out:[], rx:[], inbox:[], outbox:(cfg.outbox||[]).slice(), seen:new Set(cfg.seen||[]),
    state:'start', gotSid:false, lines:[], props:null, pending:null, sendQ:[], rcvQ:[], sentFF:false, peerFF:false, done:false, log:[], bad:0};
}
const wlLog=(st,t)=>{ st.log.push(t); if(st.log.length>50) st.log.shift(); };
const wlPut=(st,s)=>{ st.out.push(...wlEnc(s)); };
function wlSessStart(st){ if(st.role==='server'){ wlPut(st,'[WL2K-5.0-B2FWIHJM$]\r'); wlPut(st,st.call+' de DSP>\r'); st.state='wait-sid'; wlLog(st,'connected: gateway banner sent'); } else st.state='wait-sid'; }
function wlTurn(st){                                   // наш ход: предложить своё или передать ход
  if(st.outbox.length){
    const list=st.outbox.map(m=>{ const raw=wlMsgBuild(m), z=wlPack(raw); m._z=z; return {mid:m.mid,usize:raw.length,csize:z.length}; });
    st.pending=st.outbox.slice(); wlPut(st,wlPropose(list)); st.state='wait-fs'; wlLog(st,'proposed '+list.length+' message(s)');
  } else {
    if(st.peerFF){ wlPut(st,'FQ\r'); st.done=true; wlLog(st,'nothing more: FQ'); }
    else { wlPut(st,'FF\r'); st.sentFF=true; st.state='wait-turn'; wlLog(st,'nothing to send: FF'); }
  }
}
function wlSessRx(st,bytes){
  for(const b of bytes) st.rx.push(b);
  for(;;){
    if(st.done) return;
    if(st.state==='data'){
      const cur=st.rcvQ[0]; if(!cur) { st.state='wait-turn'; continue; }
      if(!st.rx.length) return;
      const r=wlDeframe(Uint8Array.from(st.rx)); if(!r.done) return;
      st.rx.splice(0,r.used);
      const m=r.ok && wlUnpack(r.data) && wlMsgParse(wlUnpack(r.data));
      if(m && m.mid===cur.mid){ st.inbox.push(m); st.seen.add(m.mid); wlLog(st,'received '+m.mid+' from '+m.from+': '+m.subject); }
      else { st.bad++; wlLog(st,'message '+cur.mid+' damaged'); }
      st.rcvQ.shift();
      if(!st.rcvQ.length){ st.state='wait-turn'; if(st.turnAfter!==false){ wlTurn(st); } }
      continue;
    }
    const i=st.rx.indexOf(13); if(i<0) return;
    const line=wlStr(st.rx.splice(0,i+1)).slice(0,-1);
    wlLine(st,line);
  }
}
function wlLine(st,line){
  if(/^\[.*\]$/.test(line)){ st.gotSid=true; st.peerSid=line; wlLog(st,'peer SID '+line);
    if(st.role==='client'){ wlPut(st,st.sid+'\r'); }
    return; }
  if(st.role==='client' && !st.started && /DSP>$/.test(line)){ st.started=true; wlTurn(st); return; }
  if(/^FC /.test(line) || /^F> /.test(line)){
    st.lines.push(line);
    if(/^F> /.test(line)){
      const list=wlParseProposals(st.lines); st.lines=[];
      if(!list){ wlPut(st,'FS '+'-'.repeat(1)+'\r'); st.bad++; wlLog(st,'proposal checksum error'); return; }
      const ans=list.map(p=>st.seen.has(p.mid) ? 'reject' : 'accept');
      wlPut(st,wlFsBuild(ans)); st.rcvQ=list.filter((p,i)=>ans[i]==='accept'); wlLog(st,'accepted '+st.rcvQ.length+' of '+list.length);
      if(st.rcvQ.length) st.state='data'; else { st.state='wait-turn'; wlTurn(st); }
    }
    return;
  }
  if(/^FS /.test(line)){
    const a=wlFsParse(line); if(!a){ st.bad++; return; }
    const sent=[];
    a.forEach((v,i)=>{ const m=st.pending[i]; if(!m) return; if(v==='accept'){ wlPutBytes(st,wlFrame(m.subject||m.mid,m._z)); sent.push(m.mid); } if(v!=='defer') st.outbox=st.outbox.filter(x=>x!==m); });
    wlLog(st,'sent '+sent.length+' message(s)'); st.pending=null; st.state='wait-turn'; st.turnAfter=true;
    return;
  }
  if(line==='FF'){ st.peerFF=true; wlLog(st,'peer: nothing to send'); wlTurn(st); return; }
  if(line==='FQ'){ st.done=true; wlLog(st,'peer: FQ — done'); return; }
}
const wlPutBytes=(st,b)=>{ for(const x of b) st.out.push(x); };
// всё, что накопили для отправки; очередь очищается
function wlSessOut(st){ const o=Uint8Array.from(st.out); st.out.length=0; return o; }
