"use strict";
/* ============================ Reticulum + LXMF: ядро ============================
   Чистая логика без DOM — общая для страницы и Node-моста. Нужны msgr-kernels.js (mgSha, mgHex, mgCat, mgRandom…)
   и Web Crypto (X25519, Ed25519, AES-CBC, HMAC, HKDF — Chrome 137+, Firefox 130+, Safari 17+, Node 20+).
   Сверено с reference-реализацией (RNS 1.5, LXMF 1.2): tools/test-rns.mjs гоняет узел против настоящего rnsd и Python-LXMF.
   Что умеем: подключиться к узлу Reticulum по TCP (HDLC), объявить свой адрес (lxmf.delivery), слышать чужие анонсы, принимать
   LXMF-сообщения (одиночным пакетом и по Link), подтверждать их, отправлять сообщения одиночным пакетом (до ~290 байт текста)
   и получать подтверждения доставки. НЕ умеем: Resource (длинные сообщения / вложения), узлы-пропагаторы, stamps (proof-of-work),
   транспорт (сами пакеты не пересылаем), IFAC. */

const RN_MTU=500, RN_DEST=16, RN_NAME=10;
const RNS={DATA:0,ANNOUNCE:1,LINKREQ:2,PROOF:3, SINGLE:0,GROUP:1,PLAIN:2,LINK:3, CTX_NONE:0,CTX_PATHRESP:0x0b,CTX_KEEPALIVE:0xfa,CTX_LINKCLOSE:0xfc,CTX_LRRTT:0xfe,CTX_LRPROOF:0xff};

// ---------- msgpack (минимум для LXMF: nil, bool, int, float, str, bin, array, map) ----------
class RnFloat{ constructor(v,bits){ this.v=v; this.bits=bits||64; } }
function rnMpEnc(v,out){
  out=out||[];
  const u8=(...a)=>{ for(const x of a) out.push(x); };
  const be=(n,bytes)=>{ for(let i=bytes-1;i>=0;i--) out.push(Math.floor(n/Math.pow(2,8*i))&255); };
  if(v===null || v===undefined) u8(0xc0);
  else if(v===true) u8(0xc3); else if(v===false) u8(0xc2);
  else if(v instanceof RnFloat){ const b=new DataView(new ArrayBuffer(8)); if(v.bits===32){ b.setFloat32(0,v.v); u8(0xca); for(let i=0;i<4;i++) out.push(b.getUint8(i)); } else { b.setFloat64(0,v.v); u8(0xcb); for(let i=0;i<8;i++) out.push(b.getUint8(i)); } }
  else if(typeof v==='number'){
    if(!Number.isInteger(v)){ const b=new DataView(new ArrayBuffer(8)); b.setFloat64(0,v); u8(0xcb); for(let i=0;i<8;i++) out.push(b.getUint8(i)); }
    else if(v>=0){ if(v<128) u8(v); else if(v<256){ u8(0xcc,v); } else if(v<65536){ u8(0xcd); be(v,2); } else if(v<4294967296){ u8(0xce); be(v,4); } else { u8(0xcf); be(v,8); } }
    else if(v>=-32) u8(v&255); else if(v>=-128) u8(0xd0,v&255); else if(v>=-32768){ u8(0xd1); be(v+65536,2); } else { u8(0xd2); be(v+4294967296,4); }
  }
  else if(typeof v==='string'){ const b=mgUtf8(v), n=b.length; if(n<32) u8(0xa0|n); else if(n<256) u8(0xd9,n); else if(n<65536){ u8(0xda); be(n,2); } else { u8(0xdb); be(n,4); } for(const x of b) out.push(x); }
  else if(v instanceof Uint8Array){ const n=v.length; if(n<256) u8(0xc4,n); else if(n<65536){ u8(0xc5); be(n,2); } else { u8(0xc6); be(n,4); } for(const x of v) out.push(x); }
  else if(Array.isArray(v)){ const n=v.length; if(n<16) u8(0x90|n); else if(n<65536){ u8(0xdc); be(n,2); } else { u8(0xdd); be(n,4); } for(const x of v) rnMpEnc(x,out); }
  else if(v instanceof Map || typeof v==='object'){ const es=v instanceof Map ? [...v.entries()] : Object.entries(v), n=es.length; if(n<16) u8(0x80|n); else if(n<65536){ u8(0xde); be(n,2); } else { u8(0xdf); be(n,4); } for(const [k,x] of es){ rnMpEnc(k,out); rnMpEnc(x,out); } }
  else throw new Error('msgpack: unsupported value');
  return out;
}
const rnMpPack=v=>Uint8Array.from(rnMpEnc(v));
function rnMpUnpack(b,pos){                                  // → {v, end}; map → Map, bin → Uint8Array, float → RnFloat
  const st={p:pos||0}, dv=new DataView(b.buffer,b.byteOffset,b.byteLength);
  const need=n=>{ if(st.p+n>b.length) throw new Error('msgpack: truncated'); };
  const uint=n=>{ need(n); let v=0; for(let i=0;i<n;i++) v=v*256+b[st.p+i]; st.p+=n; return v; };
  const raw=n=>{ need(n); const r=b.slice(st.p,st.p+n); st.p+=n; return r; };
  const dec=(depth)=>{
    if(depth>16) throw new Error('msgpack: too deep');
    need(1); const t=b[st.p++];
    if(t<0x80) return t; if(t>=0xe0) return t-256;
    if(t>=0xa0 && t<=0xbf) return new TextDecoder().decode(raw(t&31));
    if(t>=0x90 && t<=0x9f) return Array.from({length:t&15},()=>dec(depth+1));
    if(t>=0x80 && t<=0x8f){ const m=new Map(); for(let i=0;i<(t&15);i++){ const k=dec(depth+1); m.set(k,dec(depth+1)); } return m; }
    switch(t){
      case 0xc0: return null; case 0xc2: return false; case 0xc3: return true;
      case 0xc4: return raw(uint(1)); case 0xc5: return raw(uint(2)); case 0xc6: return raw(uint(4));
      case 0xca: { need(4); const v=dv.getFloat32(st.p); st.p+=4; return new RnFloat(v,32); }
      case 0xcb: { need(8); const v=dv.getFloat64(st.p); st.p+=8; return new RnFloat(v,64); }
      case 0xcc: return uint(1); case 0xcd: return uint(2); case 0xce: return uint(4); case 0xcf: return uint(8);
      case 0xd0: { const v=uint(1); return v>127 ? v-256 : v; } case 0xd1: { const v=uint(2); return v>32767 ? v-65536 : v; } case 0xd2: { const v=uint(4); return v>2147483647 ? v-4294967296 : v; }
      case 0xd9: return new TextDecoder().decode(raw(uint(1))); case 0xda: return new TextDecoder().decode(raw(uint(2))); case 0xdb: return new TextDecoder().decode(raw(uint(4)));
      case 0xdc: case 0xdd: { const n=uint(t===0xdc ? 2 : 4); if(n>65536) throw new Error('msgpack: too long'); return Array.from({length:n},()=>dec(depth+1)); }
      case 0xde: case 0xdf: { const n=uint(t===0xde ? 2 : 4); if(n>65536) throw new Error('msgpack: too long'); const m=new Map(); for(let i=0;i<n;i++){ const k=dec(depth+1); m.set(k,dec(depth+1)); } return m; }
    }
    throw new Error('msgpack: unsupported type 0x'+t.toString(16));
  };
  const v=dec(0); return {v,end:st.p};
}
const rnNum=v=>v instanceof RnFloat ? v.v : v;
const rnText=v=>v instanceof Uint8Array ? new TextDecoder().decode(v) : typeof v==='string' ? v : '';

// ---------- Web Crypto: ключи, ECDH, подпись, HKDF, Token ----------
const rnSub=()=>{ const s=typeof crypto!=='undefined' && crypto.subtle; if(!s) throw new Error('Web Crypto is not available'); return s; };
const RN_PK8_X=Uint8Array.from([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x6e,0x04,0x22,0x04,0x20]);
const RN_PK8_E=Uint8Array.from([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
function rnB64uDec(s){ s=s.replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4) s+='='; return Uint8Array.from(atob(s),c=>c.charCodeAt(0)); }
async function rnPubOf(key){ return rnB64uDec((await rnSub().exportKey('jwk',key)).x); }
// identity: 64 байта приватного ключа (X25519 32 + Ed25519 seed 32) — как у RNS; hash = SHA-256(публичные 64 байта)[:16]
async function rnIdentity(prv){
  prv=prv || mgRandom(64);
  if(prv.length!==64) throw new Error('identity key must be 64 bytes');
  const s=rnSub(), xk=await s.importKey('pkcs8',mgCat(RN_PK8_X,prv.slice(0,32)),'X25519',true,['deriveBits']), sk=await s.importKey('pkcs8',mgCat(RN_PK8_E,prv.slice(32)),'Ed25519',true,['sign']);
  const xPub=await rnPubOf(xk), sPub=await rnPubOf(sk), pub=mgCat(xPub,sPub);
  return {prv,xk,sk,xPub,sPub,pub,hash:mgSha(pub).slice(0,16)};
}
const rnPeerId=pub=>({pub,xPub:pub.slice(0,32),sPub:pub.slice(32,64),hash:mgSha(pub).slice(0,16)});
async function rnSign(id,msg){ return new Uint8Array(await rnSub().sign('Ed25519',id.sk,msg)); }
async function rnVerify(sPub,sig,msg){ try{ const k=await rnSub().importKey('raw',sPub,'Ed25519',false,['verify']); return await rnSub().verify('Ed25519',k,sig,msg); }catch(e){ return false; } }
async function rnEcdh(priv,pub32){ const s=rnSub(), pk=await s.importKey('raw',pub32,'X25519',false,[]); return new Uint8Array(await s.deriveBits({name:'X25519',public:pk},priv,256)); }
async function rnHkdf(secret,salt,len){ const s=rnSub(), k=await s.importKey('raw',secret,'HKDF',false,['deriveBits']); return new Uint8Array(await s.deriveBits({name:'HKDF',hash:'SHA-256',salt,info:new Uint8Array(0)},k,len*8)); }
// Token — Fernet без версии и времени: IV(16) + AES-CBC(PKCS7) + HMAC-SHA256(IV+шифртекст); ключ 64 байта: подпись 32 + шифрование 32
async function rnTokenEnc(key,plain){
  const s=rnSub(), h=key.length/2, iv=mgRandom(16);
  const ak=await s.importKey('raw',key.slice(h),'AES-CBC',false,['encrypt']), ct=new Uint8Array(await s.encrypt({name:'AES-CBC',iv},ak,plain));
  const body=mgCat(iv,ct), hk=await s.importKey('raw',key.slice(0,h),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return mgCat(body,new Uint8Array(await s.sign('HMAC',hk,body)));
}
async function rnTokenDec(key,tok){
  if(tok.length<48 || (tok.length-48)%16) return null;
  try{
    const s=rnSub(), h=key.length/2, body=tok.slice(0,-32), hk=await s.importKey('raw',key.slice(0,h),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    if(!await s.verify('HMAC',hk,tok.slice(-32),body)) return null;
    const ak=await s.importKey('raw',key.slice(h),'AES-CBC',false,['decrypt']);
    return new Uint8Array(await s.decrypt({name:'AES-CBC',iv:body.slice(0,16)},ak,body.slice(16)));
  }catch(e){ return null; }
}
// шифрование «для личности»: эфемерный X25519 → HKDF(соль = hash личности) → Token; результат = эфемерный публичный ключ + token
async function rnEncryptFor(peer,plain,target){
  const s=rnSub(), eph=await s.generateKey('X25519',true,['deriveBits']), ephPub=new Uint8Array(await s.exportKey('raw',eph.publicKey));
  const key=await rnHkdf(await rnEcdh(eph.privateKey,target||peer.xPub),peer.hash,64);
  return mgCat(ephPub,await rnTokenEnc(key,plain));
}
async function rnDecryptWith(id,tok){
  if(tok.length<32+48) return null;
  try{ return await rnTokenDec(await rnHkdf(await rnEcdh(id.xk,tok.slice(0,32)),id.hash,64),tok.slice(32)); }catch(e){ return null; }
}

// ---------- пакеты ----------
const rnNameHash=name=>mgSha(mgUtf8(name)).slice(0,RN_NAME);
const rnDestHash=(nameHash,idHash)=>mgSha(idHash ? mgCat(nameHash,idHash) : nameHash).slice(0,RN_DEST);
function rnPack(p){
  const flags=((p.headerType||0)<<6)|((p.contextFlag||0)<<5)|((p.transport||0)<<4)|((p.destType||0)<<2)|p.packetType;
  const head=Uint8Array.from([flags,p.hops||0]);
  const raw=mgCat(head,p.headerType===1 ? mgCat(p.transportId,p.dest) : p.dest,Uint8Array.from([p.context||0]),p.data);
  if(raw.length>RN_MTU) throw new Error('packet of '+raw.length+' bytes exceeds the MTU of '+RN_MTU);
  return raw;
}
function rnUnpack(raw){
  if(raw.length<19) return null;
  const flags=raw[0], ht=(flags>>6)&1, p={raw,flags,hops:raw[1],headerType:ht,contextFlag:(flags>>5)&1,transport:(flags>>4)&1,destType:(flags>>2)&3,packetType:flags&3};
  if(p.hops>=128) return null;
  if(ht===1){ if(raw.length<36) return null; p.transportId=raw.slice(2,18); p.dest=raw.slice(18,34); p.context=raw[34]; p.data=raw.slice(35); }
  else { p.transportId=null; p.dest=raw.slice(2,18); p.context=raw[18]; p.data=raw.slice(19); }
  if(!p.data.length) return null;
  p.hashable=mgCat(Uint8Array.from([flags&15]),ht===1 ? raw.slice(18) : raw.slice(2));
  p.hash=mgSha(p.hashable);
  return p;
}
// HDLC поверх TCP (TCPClientInterface): 0x7E … 0x7E, экранирование 0x7D
function rnHdlc(data){
  const out=[0x7e]; for(const b of data){ if(b===0x7d) out.push(0x7d,0x5d); else if(b===0x7e) out.push(0x7d,0x5e); else out.push(b); }
  out.push(0x7e); return Uint8Array.from(out);
}
function rnDeframer(onFrame){
  let inFrame=false, esc=false, buf=[];
  return bytes=>{
    for(const b of bytes){
      if(inFrame && b===0x7e){ inFrame=false; if(buf.length>=19) onFrame(Uint8Array.from(buf)); buf=[]; }
      else if(b===0x7e){ inFrame=true; buf=[]; esc=false; }
      else if(inFrame && buf.length<1100){
        if(b===0x7d) esc=true;
        else { let v=b; if(esc){ if(v===0x5e) v=0x7e; else if(v===0x5d) v=0x7d; esc=false; } buf.push(v); }
      }
    }
  };
}

// ---------- анонсы ----------
// data = pub(64) + name_hash(10) + random_hash(10) [+ ratchet(32)] + подпись(64) + app_data; подписано: dest + всё до подписи + app_data
async function rnAnnounce(id,nameHash,appData){
  const dest=rnDestHash(nameHash,id.hash), t=Math.floor(Date.now()/1000);
  const rnd=mgCat(mgRandom(5),Uint8Array.from([0,1,2,3,4].map(i=>Math.floor(t/Math.pow(2,8*(4-i)))&255)));
  const signed=mgCat(dest,id.pub,nameHash,rnd,appData), sig=await rnSign(id,signed);
  return rnPack({packetType:RNS.ANNOUNCE,destType:RNS.SINGLE,dest,context:RNS.CTX_NONE,data:mgCat(id.pub,nameHash,rnd,sig,appData)});
}
async function rnAnnounceParse(p){                           // → {dest,peer,nameHash,appData,ratchet,random} или null
  if(p.packetType!==RNS.ANNOUNCE) return null;
  const d=p.data, ratchet=p.contextFlag===1, min=64+RN_NAME+10+64+(ratchet ? 32 : 0);
  if(d.length<min) return null;
  const pub=d.slice(0,64), nameHash=d.slice(64,74), random=d.slice(74,84), rat=ratchet ? d.slice(84,116) : new Uint8Array(0);
  const o=84+rat.length, sig=d.slice(o,o+64), appData=d.slice(o+64);
  const peer=rnPeerId(pub);
  if(mgHex(rnDestHash(nameHash,peer.hash))!==mgHex(p.dest)) return null;
  if(!await rnVerify(peer.sPub,sig,mgCat(p.dest,pub,nameHash,random,rat,appData))) return null;
  return {dest:p.dest,peer,nameHash,appData,ratchet:ratchet ? rat : null,random};
}

// ---------- LXMF ----------
async function rnLxmfPack(id,srcDest,destHash,title,content,when){    // srcDest — наш адрес lxmf.delivery
  const payload=rnMpPack([new RnFloat(when/1000,64),mgUtf8(title||''),mgUtf8(content),new Map()]);
  const hashed=mgCat(destHash,srcDest,payload), msgId=mgSha(hashed), sig=await rnSign(id,mgCat(hashed,msgId));
  return {msgId,src:srcDest,sig,payload};
}
async function rnLxmfUnpack(lxmf,known){                     // lxmf = dest(16)+src(16)+подпись(64)+payload; known(srcHash) → peer | undefined
  if(lxmf.length<16+16+64+4) return null;
  const dest=lxmf.slice(0,16), src=lxmf.slice(16,32), sig=lxmf.slice(32,96), rest=lxmf.slice(96);
  let v,end; try{ ({v,end}=rnMpUnpack(rest)); }catch(e){ return null; }
  if(!Array.isArray(v) || v.length<3) return null;
  const hashedPayload=v.length===4 ? rest.slice(0,end) : rnMpPack(v.slice(0,4));          // со штампом хэш считается без него
  const hashed=mgCat(dest,src,hashedPayload), msgId=mgSha(hashed), peer=known ? known(src) : null;
  const verified=peer ? await rnVerify(peer.sPub,sig,mgCat(hashed,msgId)) : null;
  return {dest,src,msgId,verified,t:rnNum(v[0])*1000||Date.now(),title:rnText(v[1]),content:rnText(v[2])};
}

// ---------- узел: идентичность, анонсы, сообщения, Link ----------
// o: {prv,name,write(bytes),onMsg(m),onStatus(text,state),announceMs,pathWaitMs}
class RnsNode{
  constructor(o){ this.o=o; this.peers=new Map(); this.links=new Map(); this.pending=new Map(); this.seen=new Set(); this.q=Promise.resolve(); this.nameHash=rnNameHash('lxmf.delivery'); this.dead=false; this.waiters=new Map(); }
  async start(){
    this.id=await rnIdentity(this.o.prv);
    this.dest=rnDestHash(this.nameHash,this.id.hash); this.destHex=mgHex(this.dest);
    this.deframe=rnDeframer(raw=>{ this.q=this.q.then(()=>this.onRaw(raw)).catch(()=>{}); });
    await this.announce();
    this.timer=setInterval(()=>this.announce().catch(()=>{}),this.o.announceMs||1800000);
    this.o.onStatus('Reticulum: your address <'+this.destHex+'>','up');
  }
  stop(){ this.dead=true; clearInterval(this.timer); for(const w of this.waiters.values()) clearTimeout(w.t); }
  feed(bytes){ this.deframe(bytes); }
  tx(raw){ if(!this.dead) this.o.write(rnHdlc(raw)); }
  appData(){ return rnMpPack([mgUtf8(String(this.o.name||'dsp')),null,[]]); }
  async announce(){ this.tx(await rnAnnounce(this.id,this.nameHash,this.appData())); }

  async onRaw(raw){
    const p=rnUnpack(raw); if(!p) return;
    const hx=mgHex(p.hash); if(this.seen.has(hx)) return; this.seen.add(hx); if(this.seen.size>4000) this.seen.delete(this.seen.values().next().value);
    if(p.packetType===RNS.ANNOUNCE) return this.onAnnounce(p);
    if(p.packetType===RNS.LINKREQ) return this.onLinkRequest(p);
    if(p.packetType===RNS.PROOF) return this.onProof(p);
    if(p.packetType===RNS.DATA){
      if(p.destType===RNS.LINK) return this.onLinkData(p);
      if(mgHex(p.dest)===this.destHex) return this.onData(p);
    }
  }
  async onAnnounce(p){
    const a=await rnAnnounceParse(p); if(!a) return;
    const hex=mgHex(a.dest);
    if(hex===this.destHex) return;
    if(mgHex(a.nameHash)!==mgHex(this.nameHash)) return;      // нас интересуют только почтовые адреса LXMF
    let name='', stamp=0;
    try{ const {v}=rnMpUnpack(a.appData); if(Array.isArray(v)){ name=rnText(v[0]); stamp=+v[1]||0; } }catch(e){ name=new TextDecoder().decode(a.appData); }
    const old=this.peers.get(hex);
    this.peers.set(hex,{dest:a.dest,hex,peer:a.peer,name:name||(old&&old.name)||'',stamp,ratchet:a.ratchet,hops:p.hops+1,via:p.headerType===1 ? p.transportId : null});
    if(this.peers.size>3000) this.peers.delete(this.peers.keys().next().value);
    const w=this.waiters.get(hex); if(w){ clearTimeout(w.t); this.waiters.delete(hex); w.res(true); }
    if(this.o.onPeer) this.o.onPeer(this.peers.get(hex));
  }
  known(srcHash){ const p=this.peers.get(mgHex(srcHash)); return p ? p.peer : null; }
  async deliver(lxmf,viaLink){
    const m=await rnLxmfUnpack(lxmf,h=>this.known(h)); if(!m) return;
    const p=this.peers.get(mgHex(m.src));
    this.o.onMsg({from:(p && p.name) || mgHex(m.src).slice(0,12),fromHash:mgHex(m.src),to:this.destHex,text:(m.title ? '['+m.title+'] ' : '')+m.content,title:m.title,t:m.t,id:mgHex(m.msgId),unverified:m.verified!==true,link:!!viaLink});
  }
  // одиночный пакет на наш адрес: личность-шифртекст → LXMF без dest-hash в начале
  async onData(p){
    if(p.destType!==RNS.SINGLE) return;
    const plain=await rnDecryptWith(this.id,p.data); if(!plain) return;
    await this.proveTo(p);
    await this.deliver(mgCat(this.dest,plain),false);
  }
  async proveTo(p){                                          // неявное доказательство доставки: подпись хэша пакета
    const sig=await rnSign(this.id,p.hash);
    this.tx(rnPack({packetType:RNS.PROOF,destType:RNS.SINGLE,dest:p.hash.slice(0,16),context:0,data:sig}));
  }
  async onProof(p){
    if(p.context===RNS.CTX_LRPROOF) return;
    const pend=this.pending.get(mgHex(p.dest)); if(!pend) return;
    let sig=p.data, full=null;
    if(sig.length===96){ full=sig.slice(0,32); sig=sig.slice(32); } else if(sig.length!==64) return;
    if(full && mgHex(full).slice(0,32)!==mgHex(p.dest)) return;
    if(await rnVerify(pend.peer.peer.sPub,sig,full || pend.hash)){ this.pending.delete(mgHex(p.dest)); clearTimeout(pend.t); this.o.onStatus('message delivered to '+(pend.peer.name||pend.peer.hex.slice(0,12)),'up'); if(this.o.onDelivered) this.o.onDelivered(pend); }
  }

  // ---- Link (приём «прямой» доставки: так шлёт Sideband / NomadNet) ----
  async onLinkRequest(p){
    if(mgHex(p.dest)!==this.destHex) return;
    const n=p.data.length; if(n!==64 && n!==67) return;
    const hashable=n>64 ? p.hashable.slice(0,p.hashable.length-(n-64)) : p.hashable, linkId=mgSha(hashable).slice(0,16);
    const sig3=n===67 ? p.data.slice(64,67) : null, mode=sig3 ? (sig3[0]&0xe0)>>5 : 1;
    if(mode!==1) return;                                        // RNS включает только AES-256-CBC
    const s=rnSub(), eph=await s.generateKey('X25519',true,['deriveBits']), ephPub=new Uint8Array(await s.exportKey('raw',eph.publicKey));
    const key=await rnHkdf(await rnEcdh(eph.privateKey,p.data.slice(0,32)),linkId,64);
    const signalling=sig3 || Uint8Array.from([0x20,0x01,0xf4]);   // без сигналов в запросе: MTU 500, режим AES-256 (как у RNS)
    const sig=await rnSign(this.id,mgCat(linkId,ephPub,this.id.sPub,signalling));
    this.links.set(mgHex(linkId),{id:linkId,key,t:Date.now()});
    if(this.links.size>200) this.links.delete(this.links.keys().next().value);
    this.tx(rnPack({packetType:RNS.PROOF,destType:RNS.LINK,dest:linkId,context:RNS.CTX_LRPROOF,data:mgCat(sig,ephPub,signalling)}));
  }
  async onLinkData(p){
    const l=this.links.get(mgHex(p.dest)); if(!l) return;
    l.t=Date.now();
    if(p.context===RNS.CTX_KEEPALIVE){ if(p.data.length===1 && p.data[0]===0xff) this.tx(rnPack({packetType:RNS.DATA,destType:RNS.LINK,dest:l.id,context:RNS.CTX_KEEPALIVE,data:Uint8Array.from([0xfe])})); return; }
    if(p.context===RNS.CTX_LINKCLOSE){ this.links.delete(mgHex(l.id)); return; }
    if(p.context===RNS.CTX_LRRTT){ return; }
    if(p.context!==RNS.CTX_NONE){ if(p.context===1 || p.context===2) this.o.onStatus('Reticulum: a long message (Resource) was ignored — it does not fit one packet','warn'); return; }
    const plain=await rnTokenDec(l.key,p.data); if(!plain) return;
    const sig=await rnSign(this.id,p.hash);                       // явное доказательство по ссылке: хэш пакета + подпись
    this.tx(rnPack({packetType:RNS.PROOF,destType:RNS.LINK,dest:l.id,context:0,data:mgCat(p.hash,sig)}));
    await this.deliver(plain,true);
  }

  // ---- отправка: одиночным пакетом ----
  // to — hex адреса (32 знака) или имя из анонсов (начало, без регистра)
  findPeer(to){
    to=String(to||'').trim().replace(/^<|>$/g,'').toLowerCase(); if(!to) return null;
    if(/^[0-9a-f]{32}$/.test(to)) return this.peers.get(to) || {hex:to,unknown:true,dest:mgUnhex(to)};
    let best=null; for(const p of this.peers.values()) if(p.name && p.name.toLowerCase().startsWith(to) && (!best || p.name.length<best.name.length)) best=p;
    return best;
  }
  requestPath(dest){
    const data=mgCat(dest,mgRandom(16)), d=rnDestHash(rnNameHash('rnstransport.path.request'),null);
    this.tx(rnPack({packetType:RNS.DATA,destType:RNS.PLAIN,dest:d,context:0,data}));
  }
  async waitPeer(hex,ms){
    if(this.peers.has(hex)) return true;
    this.requestPath(mgUnhex(hex));
    return new Promise(res=>{ this.waiters.set(hex,{res,t:setTimeout(()=>{ this.waiters.delete(hex); res(false); },ms)}); });
  }
  async send(text,to){
    let t=this.findPeer(to);
    if(!t){ this.o.onStatus('Reticulum: no address «'+to+'» among the announces heard — use the 32-character address','warn'); return false; }
    if(t.unknown){ this.o.onStatus('Reticulum: asking the network for the path to '+t.hex.slice(0,12)+'…','connecting'); if(!await this.waitPeer(t.hex,this.o.pathWaitMs||15000)){ this.o.onStatus('Reticulum: no answer for '+t.hex.slice(0,12)+' — it has not announced lately','warn'); return false; } t=this.peers.get(t.hex); }
    if(t.stamp>0){ this.o.onStatus('Reticulum: '+(t.name||t.hex.slice(0,12))+' requires a stamp (proof of work) — not supported','warn'); return false; }
    const parts=mgSplit(String(text),240); let ok=true;
    for(const part of parts){
      const m=await rnLxmfPack(this.id,this.dest,t.dest,'',part,Date.now());
      const plain=mgCat(m.src,m.sig,m.payload);
      const tok=await rnEncryptFor(t.peer,plain,t.ratchet);
      const via=t.hops>1 && t.via ? {headerType:1,transport:1,transportId:t.via} : {};
      let raw; try{ raw=rnPack({packetType:RNS.DATA,destType:RNS.SINGLE,dest:t.dest,context:0,data:tok,...via}); }catch(e){ this.o.onStatus('Reticulum: '+e.message,'warn'); return false; }
      const pk=rnUnpack(raw);
      const hex=mgHex(pk.hash.slice(0,16)), pend={peer:t,hash:pk.hash,t:setTimeout(()=>this.pending.delete(hex),120000)};
      this.pending.set(hex,pend); this.tx(raw);
    }
    return ok;
  }
}
