"use strict";
/* Сокеты приложения DSP для протоколов: промисы поверх команд tcp.* / udp.* моста (tools/android, NetHub.kt).
   Без DOM — проверяется в tools/test-netsock.mjs (на сокетах Node вместо приложения).
   Команды приложения выполняются в пуле потоков, порядок не гарантирован — поэтому write() ждёт ответ на каждый кусок. */

const NS_CHUNK=32768;
const nsHex=b=>{ let s=''; for(let i=0;i<b.length;i++) s+=(b[i]<16?'0':'')+b[i].toString(16); return s; };
const nsBytes=h=>{ const b=new Uint8Array(h.length>>1); for(let i=0;i<b.length;i++) b[i]=parseInt(h.substr(i*2,2),16); return b; };
const nsEnc=s=>new TextEncoder().encode(s);
const nsDec=b=>new TextDecoder().decode(b);
const nsCat=list=>{ let n=0; for(const a of list) n+=a.length; const o=new Uint8Array(n); let k=0; for(const a of list){ o.set(a,k); k+=a.length; } return o; };
const nsFind=(b,pat,from=0)=>{ outer: for(let i=from;i<=b.length-pat.length;i++){ for(let j=0;j<pat.length;j++) if(b[i+j]!==pat[j]) continue outer; return i; } return -1; };

/* Поток TCP-соединения: байты копятся, читаются асинхронно (read / readUntil / readLine / readAny / readAll). */
class NsConn{
  constructor(ns,id,peer){ this.ns=ns; this.id=id; this.peer=peer||''; this.q=[]; this.off=0; this.len=0; this.open=true; this.w=null; this.rx=0; this.tx=0; }
  _push(b){ if(!b.length) return; this.q.push(b); this.len+=b.length; this.rx+=b.length; this._pump(); }
  _closed(){ this.open=false; this._pump(); }
  _flat(){ if(this.q.length>1 || this.off){ const f=nsCat(this.q).subarray(this.off); this.q=f.length ? [f] : []; this.off=0; } return this.q[0]||new Uint8Array(0); }
  _take(n){ const f=this._flat(), o=f.slice(0,n); this.q=n>=f.length ? [] : [f.subarray(n)]; this.len-=o.length; return o; }
  _pump(){
    const w=this.w; if(!w) return;
    const r=w.test(); if(r===undefined) return;
    this.w=null; clearTimeout(w.timer); w.res(r);
  }
  _wait(test,ms){
    if(this.w) return Promise.reject(new Error('one reader at a time'));
    const r=test(); if(r!==undefined) return Promise.resolve(r);
    return new Promise((res,rej)=>{
      const timer=ms>0 ? setTimeout(()=>{ if(this.w){ this.w=null; rej(new Error('timeout')); } },ms) : 0;
      this.w={test,res,timer};
    });
  }
  read(n,ms){ return this._wait(()=> this.len>=n ? this._take(n) : !this.open ? this._take(this.len) : undefined,ms); }
  readAny(ms){ return this._wait(()=> this.len ? this._take(this.len) : !this.open ? null : undefined,ms); }
  readUntil(pat,ms,max=1<<20){
    const p=typeof pat==='string' ? nsEnc(pat) : pat;
    return this._wait(()=>{
      const i=this.len ? nsFind(this._flat(),p) : -1;
      if(i>=0) return this._take(i+p.length);
      if(this.len>max) throw new Error('line too long');
      return !this.open ? (this.len ? this._take(this.len) : null) : undefined;
    },ms);
  }
  async readLine(ms){ const b=await this.readUntil('\n',ms); return b ? nsDec(b).replace(/\r?\n$/,'') : null; }
  readAll(ms,max=1<<30){ return this._wait(()=> this.len>max ? (()=>{ throw new Error('too big'); })() : !this.open ? this._take(this.len) : undefined,ms); }
  async write(b){
    if(typeof b==='string') b=nsEnc(b);
    for(let i=0;i<b.length || i===0 && !b.length;i+=NS_CHUNK){
      if(!this.open) throw new Error('closed');
      const part=b.subarray(i,i+NS_CHUNK); if(!part.length) break;
      await this.ns.call('tcp.send',{conn:this.id,hex:nsHex(part)});
      this.tx+=part.length;
    }
  }
  async close(){ if(!this.open) return; this.open=false; this.ns.conns.delete(this.id); try{ await this.ns.call('tcp.close',{conn:this.id}); }catch(e){} this._pump(); }
}

/* UDP-сокет: очередь пришедших датаграмм {bytes, peer}. */
class NsUdp{
  constructor(ns,id,port){ this.ns=ns; this.id=id; this.port=port; this.q=[]; this.w=null; this.open=true; }
  _push(d){ this.q.push(d); if(this.w){ const w=this.w; this.w=null; clearTimeout(w.timer); w.res(this.q.shift()); } }
  _closed(){ this.open=false; if(this.w){ const w=this.w; this.w=null; clearTimeout(w.timer); w.res(null); } }
  recv(ms){
    if(this.q.length) return Promise.resolve(this.q.shift());
    if(!this.open) return Promise.resolve(null);
    return new Promise((res,rej)=>{
      const timer=ms>0 ? setTimeout(()=>{ this.w=null; rej(new Error('timeout')); },ms) : 0;
      this.w={res,timer};
    });
  }
  send(host,port,b,opt){ return this.ns.udpSend(host,port,b,{conn:this.id,...opt}); }
  async close(){ this.open=false; this.ns.udps.delete(this.id); try{ await this.ns.call('udp.close',{conn:this.id}); }catch(e){} this._closed(); }
}

class NetSock{
  // send(obj) — отправить команду мосту (JSON); feed(rec) — принять запись моста
  constructor(send){ this.send=send; this.seq=0; this.wait=new Map(); this.conns=new Map(); this.udps=new Map(); this.servers=new Map(); this.hooks=new Set(); this.limbo=new Map(); }
  feed(r){
    if(!r || typeof r!=='object') return;
    if(r.src==='cmd'){
      const w=this.wait.get(r.id); if(!w) return;
      this.wait.delete(r.id); clearTimeout(w.timer);
      if(r.ok){ try{ w.on?.(r); }catch(e){} w.res(r); }
      else w.rej(Object.assign(new Error(r.msg||r.err||'error'),{reply:r}));
      return;
    }
    if(r.src!=='net') return;
    for(const h of this.hooks) h(r);
    if(r.ev==='accept'){
      const s=this.servers.get(r.server);
      if(!s) return;                                   // чужой сервер (другой узел на том же мосту)
      const c=new NsConn(this,r.conn,r.peer); this.conns.set(r.conn,c); s.onAccept(c);
    } else if(r.ev==='data' && r.proto==='udp'){
      const u=this.udps.get(r.conn); if(u) u._push({bytes:r.hex ? nsBytes(r.hex) : nsEnc(r.text||''),peer:r.peer||''});
    } else if(r.ev==='data'){
      const c=this.conns.get(r.conn); if(c) c._push(r.hex ? nsBytes(r.hex) : nsEnc(r.text||''));
    } else if(r.ev==='close' && r.proto==='udp'){
      const u=this.udps.get(r.conn); if(u){ this.udps.delete(r.conn); u._closed(); }
    } else if(r.ev==='close' && r.conn!=null){
      const c=this.conns.get(r.conn); if(c){ this.conns.delete(r.conn); c._closed(); }
    } else if(r.ev==='close' && r.server!=null){
      const s=this.servers.get(r.server); if(s){ this.servers.delete(r.server); s.open=false; s.onClose?.(); }
    }
  }
  // on — вызывается сразу при разборе ответа: до следующей записи моста (данные могут идти следом)
  call(cmd,args={},ms=15000,on){
    return new Promise((res,rej)=>{
      const id=++this.seq, timer=ms>0 ? setTimeout(()=>{ this.wait.delete(id); rej(new Error(cmd+': no answer')); },ms) : 0;
      this.wait.set(id,{res,rej,timer,on});
      try{ this.send({...args,cmd,id}); }catch(e){ this.wait.delete(id); clearTimeout(timer); rej(e); }
    });
  }
  async connect(host,port,timeout=5000){
    let c=null;
    const r=await this.call('tcp.connect',{host,port,timeout},timeout+3000,r=>{ c=new NsConn(this,r.conn,host+':'+port); this.conns.set(r.conn,c); });
    return c||new NsConn(this,r.conn,host+':'+port);
  }
  // onAccept(conn) — каждое входящее соединение; возвращает {server, port, close()}
  async listen(port,onAccept,lan=true){
    let s=null;
    const r=await this.call('tcp.listen',{port,lan},15000,r=>{ s={id:r.server,port:r.port,open:true,onAccept}; this.servers.set(r.server,s); });
    s=s||this.servers.get(r.server);
    s.close=async()=>{ if(!s.open) return; s.open=false; this.servers.delete(s.id); try{ await this.call('tcp.close',{server:s.id}); }catch(e){} };
    return s;
  }
  async udpOpen(port=0,broadcast=false){
    let u=null;
    const r=await this.call('udp.open',{port,broadcast},15000,r=>{ u=new NsUdp(this,r.conn,r.port); this.udps.set(r.conn,u); });
    return u||this.udps.get(r.conn);
  }
  udpSend(host,port,b,o={}){
    const w=typeof b==='string' ? {text:b} : {hex:nsHex(b)};
    return this.call('udp.send',{host,port,...(o.conn ? {conn:o.conn} : {}),...(o.broadcast ? {broadcast:true} : {}),...w});
  }
  // один запрос — один ответ; bytes ответа и время, мс
  async udpRequest(host,port,b,timeout=3000){
    const w=typeof b==='string' ? {text:b} : {hex:nsHex(b)};
    const r=await this.call('udp.request',{host,port,timeout,...w},timeout+3000);
    return {bytes:r.hex ? nsBytes(r.hex) : new Uint8Array(0),ms:r.ms};
  }
}
