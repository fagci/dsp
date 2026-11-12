"use strict";
/* SMB2 (2.0.2 / 2.1) клиент поверх сокетов приложения (netsock-kernels.js): общая папка Windows, Samba, NAS, роутера с USB-диском.
   Вход NTLMv2 (или гостевой), подпись сообщений HMAC-SHA256 — если сервер требует. Операции: stat, list, read, write, mkdir, remove, rename.
   SMB1 и SMB3 (шифрование, AES-CMAC) не поддерживаются: на сервере должен быть открыт SMB 2.x (у Windows и Samba он есть по умолчанию).
   Хэши (MD4 для NT-пароля, MD5 для HMAC-MD5, SHA-256 для подписи) — свои: SubtleCrypto не знает MD4 / MD5 и недоступен на http-странице.
   Без DOM — tools/test-smb.mjs (против сервера impacket). */

/* ---------- хэши ---------- */
const smbRol=(x,n)=>(x<<n)|(x>>>(32-n));
function smbPad(msg,be){                                     // дополнение до 64 байт: 0x80, нули, длина в битах (LE для MD4 / MD5, BE для SHA)
  const n=msg.length, tot=((n+9+63)>>6)<<6, b=new Uint8Array(tot); b.set(msg); b[n]=0x80;
  const dv=new DataView(b.buffer), bits=n*8;
  if(be){ dv.setUint32(tot-8,Math.floor(bits/4294967296)); dv.setUint32(tot-4,bits>>>0); }
  else { dv.setUint32(tot-8,bits>>>0,true); dv.setUint32(tot-4,Math.floor(bits/4294967296),true); }
  return dv;
}
function smbMd4(msg){
  const dv=smbPad(msg,false), X=new Int32Array(16); let a0=0x67452301|0, b0=0xefcdab89|0, c0=0x98badcfe|0, d0=0x10325476|0;
  const F=(x,y,z)=>(x&y)|(~x&z), G=(x,y,z)=>(x&y)|(x&z)|(y&z), H=(x,y,z)=>x^y^z;
  const O2=[0,4,8,12,1,5,9,13,2,6,10,14,3,7,11,15], O3=[0,8,4,12,2,10,6,14,1,9,5,13,3,11,7,15];
  for(let off=0;off<dv.byteLength;off+=64){
    for(let i=0;i<16;i++) X[i]=dv.getInt32(off+i*4,true);
    let a=a0, b=b0, c=c0, d=d0, t;
    for(let i=0;i<16;i++){ t=smbRol((a+F(b,c,d)+X[i])|0,[3,7,11,19][i&3]); a=d; d=c; c=b; b=t; }
    for(let i=0;i<16;i++){ t=smbRol((a+G(b,c,d)+X[O2[i]]+0x5a827999)|0,[3,5,9,13][i&3]); a=d; d=c; c=b; b=t; }
    for(let i=0;i<16;i++){ t=smbRol((a+H(b,c,d)+X[O3[i]]+0x6ed9eba1)|0,[3,9,11,15][i&3]); a=d; d=c; c=b; b=t; }
    a0=(a0+a)|0; b0=(b0+b)|0; c0=(c0+c)|0; d0=(d0+d)|0;
  }
  const o=new Uint8Array(16), ov=new DataView(o.buffer); ov.setInt32(0,a0,true); ov.setInt32(4,b0,true); ov.setInt32(8,c0,true); ov.setInt32(12,d0,true); return o;
}
const SMB_MD5K=Int32Array.from({length:64},(_,i)=>Math.floor(Math.abs(Math.sin(i+1))*4294967296)|0);
const SMB_MD5S=[7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
function smbMd5(msg){
  const dv=smbPad(msg,false), M=new Int32Array(16); let a0=0x67452301|0, b0=0xefcdab89|0, c0=0x98badcfe|0, d0=0x10325476|0;
  for(let off=0;off<dv.byteLength;off+=64){
    for(let i=0;i<16;i++) M[i]=dv.getInt32(off+i*4,true);
    let a=a0, b=b0, c=c0, d=d0;
    for(let i=0;i<64;i++){
      let f,g;
      if(i<16){ f=(b&c)|(~b&d); g=i; } else if(i<32){ f=(d&b)|(~d&c); g=(5*i+1)&15; } else if(i<48){ f=b^c^d; g=(3*i+5)&15; } else { f=c^(b|~d); g=(7*i)&15; }
      const t=d; d=c; c=b; b=(b+smbRol((a+f+SMB_MD5K[i]+M[g])|0,SMB_MD5S[i]))|0; a=t;
    }
    a0=(a0+a)|0; b0=(b0+b)|0; c0=(c0+c)|0; d0=(d0+d)|0;
  }
  const o=new Uint8Array(16), ov=new DataView(o.buffer); ov.setInt32(0,a0,true); ov.setInt32(4,b0,true); ov.setInt32(8,c0,true); ov.setInt32(12,d0,true); return o;
}
const SMB_SHAK=(()=>{ const k=[]; for(let n=2;k.length<64;n++){ let p=true; for(let d=2;d*d<=n;d++) if(n%d===0){ p=false; break; } if(p) k.push(Math.floor((Math.cbrt(n)%1)*4294967296)|0); } return Int32Array.from(k); })();
function smbSha256(msg){
  const dv=smbPad(msg,true), W=new Int32Array(64);
  const H=Int32Array.from([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const ror=(x,n)=>(x>>>n)|(x<<(32-n));
  for(let off=0;off<dv.byteLength;off+=64){
    for(let i=0;i<16;i++) W[i]=dv.getInt32(off+i*4);
    for(let i=16;i<64;i++){ const a=W[i-15], b=W[i-2]; W[i]=(W[i-16]+(ror(a,7)^ror(a,18)^(a>>>3))+W[i-7]+(ror(b,17)^ror(b,19)^(b>>>10)))|0; }
    let a=H[0], b=H[1], c=H[2], d=H[3], e=H[4], f=H[5], g=H[6], h=H[7];
    for(let i=0;i<64;i++){
      const t1=(h+(ror(e,6)^ror(e,11)^ror(e,25))+((e&f)^(~e&g))+SMB_SHAK[i]+W[i])|0, t2=((ror(a,2)^ror(a,13)^ror(a,22))+((a&b)^(a&c)^(b&c)))|0;
      h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
    }
    H[0]+=a; H[1]+=b; H[2]+=c; H[3]+=d; H[4]+=e; H[5]+=f; H[6]+=g; H[7]+=h;
  }
  const o=new Uint8Array(32), ov=new DataView(o.buffer); for(let i=0;i<8;i++) ov.setInt32(i*4,H[i]); return o;
}
function smbHmac(hash,key,msg){                              // блок 64 байта у MD5 и SHA-256
  if(key.length>64) key=hash(key);
  const ip=new Uint8Array(64+msg.length), op=new Uint8Array(64+hash(new Uint8Array(0)).length);
  for(let i=0;i<64;i++){ const k=i<key.length ? key[i] : 0; ip[i]=k^0x36; op[i]=k^0x5c; }
  ip.set(msg,64); op.set(hash(ip),64); return hash(op);
}
const smbHmacMd5=(k,m)=>smbHmac(smbMd5,k,m), smbHmacSha256=(k,m)=>smbHmac(smbSha256,k,m);

/* ---------- NTLMv2 ---------- */
const smbU16=s=>{ const o=new Uint8Array(s.length*2); for(let i=0;i<s.length;i++){ const c=s.charCodeAt(i); o[i*2]=c&255; o[i*2+1]=c>>8; } return o; };
const smbFromU16=b=>{ let s=''; for(let i=0;i+1<b.length;i+=2) s+=String.fromCharCode(b[i]|(b[i+1]<<8)); return s; };
const smbCat=list=>{ let n=0; for(const a of list) n+=a.length; const o=new Uint8Array(n); let k=0; for(const a of list){ o.set(a,k); k+=a.length; } return o; };
const SMB_NTLM_SIG=[0x4e,0x54,0x4c,0x4d,0x53,0x53,0x50,0];
const SMB_NTLM_FLAGS=0xa2888215>>>0;                          // UNICODE · REQUEST_TARGET · SIGN · NTLM · ALWAYS_SIGN · EXTENDED_SESSIONSECURITY · TARGET_INFO · VERSION · 128 · 56
function smbFiletime(ms){ const t=(ms+11644473600000)*10000; const o=new Uint8Array(8), dv=new DataView(o.buffer); dv.setUint32(0,t%4294967296,true); dv.setUint32(4,Math.floor(t/4294967296),true); return o; }
function ntlmNegotiate(){
  const b=new Uint8Array(40), dv=new DataView(b.buffer); b.set(SMB_NTLM_SIG); dv.setUint32(8,1,true); dv.setUint32(12,SMB_NTLM_FLAGS,true);
  dv.setUint32(16+4,40,true); dv.setUint32(24+4,40,true);      // домен и рабочая станция пусты (смещение — в конец)
  b[32]=10; b[35]=0; b[39]=15; dv.setUint16(34,19041,true);   // версия 10.0.19041, NTLM rev 15
  return b;
}
// → {server challenge, targetInfo, ts (8 байт AV_TIMESTAMP или null), flags}
function ntlmParseChallenge(buf){
  let i=-1; for(let k=0;k+8<=buf.length;k++){ let m=true; for(let j=0;j<8;j++) if(buf[k+j]!==SMB_NTLM_SIG[j]){ m=false; break; } if(m){ i=k; break; } }
  if(i<0) throw new Error('the server answered without an NTLM challenge');
  const m=buf.subarray(i), dv=new DataView(m.buffer,m.byteOffset,m.byteLength);
  if(dv.getUint32(8,true)!==2) throw new Error('unexpected NTLM message');
  const tiLen=dv.getUint16(40,true), tiOff=dv.getUint32(44,true), info=m.slice(tiOff,tiOff+tiLen);
  let ts=null; for(let p=0;p+4<=info.length;){ const id=info[p]|(info[p+1]<<8), len=info[p+2]|(info[p+3]<<8); if(id===0) break; if(id===7 && len===8) ts=info.slice(p+4,p+12); p+=4+len; }
  return {chal:m.slice(24,32),info,ts,flags:dv.getUint32(20,true)};
}
// → {msg, key}: AUTHENTICATE и ключ сессии (для подписи). user '' — анонимный вход
function ntlmAuthenticate(ch,user,pass,domain,ws,rnd,now){
  const dom=smbU16(domain||''), usr=smbU16(user||''), wst=smbU16(ws||'DSP');
  let lm, nt, key=null;
  if(user){
    const ntowf1=smbMd4(smbU16(pass||'')), ntowf2=smbHmacMd5(ntowf1,smbU16(String(user).toUpperCase()+(domain||'')));
    const cc=rnd(8), ts=ch.ts||smbFiletime(now), z4=new Uint8Array(4);
    const temp=smbCat([Uint8Array.from([1,1,0,0,0,0,0,0]),ts,cc,z4,ch.info,z4]);
    const proof=smbHmacMd5(ntowf2,smbCat([ch.chal,temp]));
    nt=smbCat([proof,temp]); key=smbHmacMd5(ntowf2,proof);
    lm=ch.ts ? new Uint8Array(24) : smbCat([smbHmacMd5(ntowf2,smbCat([ch.chal,cc])),cc]);
  } else { nt=new Uint8Array(0); lm=new Uint8Array(1); }
  const pay=[dom,usr,wst,lm,nt,new Uint8Array(0)], head=72, offs=[]; let o=head;
  for(const p of pay){ offs.push(o); o+=p.length; }
  const b=new Uint8Array(o), dv=new DataView(b.buffer); b.set(SMB_NTLM_SIG); dv.setUint32(8,3,true);
  const field=(at,len,off)=>{ dv.setUint16(at,len,true); dv.setUint16(at+2,len,true); dv.setUint32(at+4,off,true); };
  field(12,lm.length,offs[3]); field(20,nt.length,offs[4]); field(28,dom.length,offs[0]); field(36,usr.length,offs[1]); field(44,wst.length,offs[2]); field(52,0,offs[5]);
  dv.setUint32(60,SMB_NTLM_FLAGS,true); b[64]=10; dv.setUint16(66,19041,true); b[71]=15;
  pay.forEach((p,i)=>b.set(p,offs[i]));
  return {msg:b,key};
}
// SPNEGO: обёртка NTLMSSP в токен (серверы принимают и «голый» NTLMSSP, но обёртка — как у всех клиентов)
const smbDer=(tag,body)=>{ const n=body.length; const h=n<128 ? [tag,n] : n<256 ? [tag,0x81,n] : [tag,0x82,n>>8,n&255]; return smbCat([Uint8Array.from(h),body]); };
function spnegoInit(ntlm){
  const oidNtlm=Uint8Array.from([0x06,0x0a,0x2b,0x06,0x01,0x04,0x01,0x82,0x37,0x02,0x02,0x0a]);
  const mechTypes=smbDer(0xa0,smbDer(0x30,oidNtlm)), mechToken=smbDer(0xa2,smbDer(0x04,ntlm));
  const init=smbDer(0xa0,smbDer(0x30,smbCat([mechTypes,mechToken])));
  return smbDer(0x60,smbCat([Uint8Array.from([0x06,0x06,0x2b,0x06,0x01,0x05,0x05,0x02]),init]));
}
const spnegoResp=ntlm=>smbDer(0xa1,smbDer(0x30,smbDer(0xa2,smbDer(0x04,ntlm))));

/* ---------- SMB2 ---------- */
const SMB_CMD={NEGOTIATE:0,SESSION:1,LOGOFF:2,TREE:3,TREE_DISC:4,CREATE:5,CLOSE:6,FLUSH:7,READ:8,WRITE:9,QUERY_DIR:14,SET_INFO:17};
const SMB_ERRS={0xC000000F:'file not found',0xC0000034:'file not found',0xC000003A:'path not found',0xC0000033:'bad file name',0xC0000022:'access denied',0xC000006D:'logon failed — wrong user, password or domain',
  0xC000006E:'logon failed — account restriction',0xC0000072:'account is disabled',0xC0000071:'password expired',0xC0000234:'account is locked out',0xC000015B:'logon type not allowed',
  0xC0000035:'already exists',0xC0000101:'folder is not empty',0xC00000BA:'it is a folder',0xC0000103:'not a folder',0xC00000CC:'share not found (check the share name)',
  0xC0000043:'file is in use by another program',0xC0000056:'delete is pending',0xC000007F:'disk full',0xC0000011:'end of file',0xC00000C9:'network name deleted',
  0xC0000120:'cancelled',0xC00000B5:'timeout',0xC0000225:'not found',0xC0000010:'invalid request',0xC000000D:'invalid parameter',0xC00000BB:'not supported',0xC000009A:'server is out of resources',
  0xC0000203:'user session deleted',0xC000005E:'no logon server'};
const SMB_NO_MORE=0x80000006, SMB_PENDING=0x103, SMB_MORE=0xC0000016, SMB_EOF=0xC0000011;
class SmbError extends Error{ constructor(status,what){ super((what ? what+': ' : '')+(SMB_ERRS[status] || ('status 0x'+status.toString(16))));  this.status=status; } }
const smbToWin=p=>String(p||'').replace(/\//g,'\\').replace(/^\\+|\\+$/g,'');
const smbFt=(dv,o)=>{ const t=dv.getUint32(o,true)+dv.getUint32(o+4,true)*4294967296; return t ? Math.round(t/10000-11644473600000) : 0; };

class SmbClient{
  // opt: user, pass, domain, timeout (мс на ответ, по умолчанию 30000), rnd(n) → случайные байты
  constructor(ns,opt={}){ this.ns=ns; this.opt=opt; this.c=null; this.mid=0; this.credits=1; this.credWait=[]; this.pend=new Map(); this.sid=new Uint8Array(8); this.tid=0; this.dialect=0; this.signKey=null; this.maxRead=65536; this.maxWrite=65536; this.share=''; this.closed=true; this.guest=false; this.lock=Promise.resolve(); this.sendQ=Promise.resolve(); }
  _rnd(n){ if(this.opt.rnd) return this.opt.rnd(n); const b=new Uint8Array(n); (globalThis.crypto||{getRandomValues:a=>{ for(let i=0;i<a.length;i++) a[i]=Math.random()*256; }}).getRandomValues(b); return b; }
  async connect(host,port=445,share='',timeoutMs=8000){
    this.share=String(share||'').replace(/^[\\/]+|[\\/]+$/g,''); if(!this.share) throw new Error('set the share name (smb://host/SHARE/…)');
    this.c=await this.ns.connect(host,port||445,timeoutMs); this.closed=false; this._loop();
    try{
      const nb=new Uint8Array(36+4), nv=new DataView(nb.buffer);
      nv.setUint16(0,36,true); nv.setUint16(2,2,true); nv.setUint16(4,1,true); nb.set(this._rnd(16),12); nv.setUint16(36,0x0202,true); nv.setUint16(38,0x0210,true);
      const n=await this._req(SMB_CMD.NEGOTIATE,nb,{nosess:true});
      if(n.status) throw new SmbError(n.status,'negotiate');
      const dv=new DataView(n.msg.buffer,n.msg.byteOffset+64,n.msg.length-64);
      this.dialect=dv.getUint16(4,true); if(this.dialect!==0x0202 && this.dialect!==0x0210) throw new Error('the server wants SMB '+(this.dialect>>8)+'.'+(this.dialect&255)+' or newer; only SMB 2.0.2 / 2.1 are supported — enable them on the server');
      const secMode=dv.getUint16(2,true); this.maxRead=Math.min(65536,dv.getUint32(32,true)||65536); this.maxWrite=Math.min(65536,dv.getUint32(36,true)||65536);
      // вход: NTLM, два обмена
      const ch=await this._setup(spnegoInit(ntlmNegotiate()),true);
      const chal=ntlmParseChallenge(ch.sec);
      const au=ntlmAuthenticate(chal,this.opt.user||'',this.opt.pass||'',this.opt.domain||'','DSP',n2=>this._rnd(n2),Date.now());
      const fin=await this._setup(spnegoResp(au.msg),false);
      if(fin.status) throw new SmbError(fin.status,'login');
      this.guest=!!(fin.flags&3);
      if(au.key && !this.guest && ((secMode&2) || this.opt.sign)) this.signKey=au.key;                      // подписываем, если сервер подпись требует
      else if((secMode&2) && !this.guest && !au.key) throw new Error('the server requires signing: anonymous access is not possible');
      const path=smbU16('\\\\'+host+'\\'+this.share), tb=new Uint8Array(8+path.length), tv=new DataView(tb.buffer);
      tv.setUint16(0,9,true); tv.setUint16(4,72,true); tv.setUint16(6,path.length,true); tb.set(path,8);
      const t=await this._req(SMB_CMD.TREE,tb); if(t.status) throw new SmbError(t.status,'share «'+this.share+'»');
      this.tid=new DataView(t.msg.buffer,t.msg.byteOffset).getUint32(36,true);
    }catch(e){ await this.close(); throw e; }
    return {dialect:(this.dialect>>8)+'.'+(this.dialect&255),signing:!!this.signKey,guest:this.guest};
  }
  async _setup(blob,first){
    const b=new Uint8Array(24+blob.length), dv=new DataView(b.buffer);
    dv.setUint16(0,25,true); b[3]=1; dv.setUint16(12,88,true); dv.setUint16(14,blob.length,true); b.set(blob,24);
    const r=await this._req(SMB_CMD.SESSION,b,{nosess:true});
    if(first){
      if(r.status!==SMB_MORE) throw new SmbError(r.status,'login');
      this.sid=r.msg.slice(40,48);
    }
    const v=new DataView(r.msg.buffer,r.msg.byteOffset+64,r.msg.length-64);
    const so=v.getUint16(4,true), sl=v.getUint16(6,true);
    return {status:r.status,flags:r.status===0 ? v.getUint16(2,true) : 0,sec:so ? r.msg.subarray(so,so+sl) : new Uint8Array(0)};
  }
  async _loop(){
    try{
      for(;;){
        const h=await this.c.read(4,0); if(!h || h.length<4) break;
        const len=(h[1]<<16)|(h[2]<<8)|h[3]; if(!len) continue;
        const m=await this.c.read(len,0); if(!m || m.length<len) break;
        if(m.length<64 || m[0]!==0xFE || m[1]!==0x53) continue;
        const dv=new DataView(m.buffer,m.byteOffset,m.length), id=dv.getUint32(24,true)+dv.getUint32(28,true)*4294967296, status=dv.getUint32(8,true), cr=dv.getUint16(14,true);
        this.credits+=cr; this._creditsWake();
        const w=this.pend.get(id); if(!w) continue;
        if(status===SMB_PENDING && (dv.getUint32(16,true)&2)) continue;           // промежуточный ответ: ждём настоящий
        this.pend.delete(id); clearTimeout(w.timer); w.res({status,msg:m});
      }
    }catch(e){ /* обрыв */ }
    this.closed=true;
    for(const [id,w] of this.pend){ clearTimeout(w.timer); w.rej(new Error('connection closed')); } this.pend.clear(); this._creditsWake();
  }
  _creditsWake(){ for(const f of this.credWait.splice(0)) f(); }
  async _req(cmd,body,o={}){
    while(this.credits<=0 && !this.closed) await new Promise(r=>this.credWait.push(r));
    if(this.closed) throw new Error('connection closed');
    this.credits--;
    const id=this.mid++, m=new Uint8Array(64+body.length), dv=new DataView(m.buffer);
    m.set([0xFE,0x53,0x4D,0x42]); dv.setUint16(4,64,true); dv.setUint16(6,this.dialect>0x202 && cmd!==SMB_CMD.NEGOTIATE ? 1 : 0,true);
    dv.setUint16(12,cmd,true); dv.setUint16(14,64,true); dv.setUint32(24,id%4294967296,true); dv.setUint32(28,Math.floor(id/4294967296),true);
    dv.setUint32(32,0xfeff,true); if(!o.nosess) dv.setUint32(36,this.tid,true); m.set(this.sid,40);
    m.set(body,64);
    if(this.signKey && cmd!==SMB_CMD.NEGOTIATE && !(cmd===SMB_CMD.SESSION && !this.sid.some(x=>x) )){ dv.setUint32(16,8,true); m.set(smbHmacSha256(this.signKey,m).subarray(0,16),48); }
    const fr=new Uint8Array(4+m.length); fr[1]=m.length>>16; fr[2]=(m.length>>8)&255; fr[3]=m.length&255; fr.set(m,4);
    const p=new Promise((res,rej)=>{ const timer=setTimeout(()=>{ this.pend.delete(id); rej(new Error('the server did not answer')); },this.opt.timeout||30000); this.pend.set(id,{res,rej,timer}); });
    const prev=this.sendQ; let done; this.sendQ=new Promise(r=>{ done=r; });      // кадры уходят по одному: write() режет данные на куски, два вызова разом перемешали бы их
    try{ await prev; await this.c.write(fr); } finally { done(); }
    return p;
  }
  _ok(r,what){ if(r.status) throw new SmbError(r.status,what); return r; }
  async _create(path,o){
    const name=smbU16(smbToWin(path)), b=new Uint8Array(56+Math.max(1,name.length)), dv=new DataView(b.buffer);
    dv.setUint16(0,57,true); dv.setUint32(4,2,true); dv.setUint32(24,o.access,true); dv.setUint32(28,o.attrs||0,true); dv.setUint32(32,7,true); dv.setUint32(36,o.disp,true); dv.setUint32(40,o.opts||0,true);
    dv.setUint16(44,120,true); dv.setUint16(46,name.length,true); b.set(name,56);
    const r=await this._req(SMB_CMD.CREATE,b); if(r.status) return {status:r.status};
    const v=new DataView(r.msg.buffer,r.msg.byteOffset+64,r.msg.length-64);
    return {status:0,fid:r.msg.slice(64+64,64+80),size:v.getUint32(48,true)+v.getUint32(52,true)*4294967296,attrs:v.getUint32(56,true),mtime:smbFt(v,24),action:v.getUint32(4,true)};
  }
  async _closeFid(fid){ const b=new Uint8Array(24); new DataView(b.buffer).setUint16(0,24,true); b.set(fid,8); try{ await this._req(SMB_CMD.CLOSE,b); }catch(e){} }
  // сериализация: один «разговор» за раз (операции над файлами внутри сами конвейерные)
  _lock(fn){ if(this.closed) return Promise.reject(new Error('not connected')); const run=this.lock.then(fn,fn); this.lock=run.then(()=>{},()=>{}); return run; }
  stat(p){ return this._lock(async()=>{
    p=String(p||''); const norm=smbToWin(p);
    if(!norm) return {name:'',dir:true,size:0,mtime:0};
    const f=await this._create(p,{access:0x00120080,disp:1});
    if(f.status===0xC000000F || f.status===0xC0000034 || f.status===0xC000003A || f.status===0xC0000033) return null;
    if(f.status) throw new SmbError(f.status,p);
    await this._closeFid(f.fid);
    return {name:norm.split('\\').pop(),dir:!!(f.attrs&0x10),size:(f.attrs&0x10) ? 0 : f.size,mtime:f.mtime};
  }); }
  list(p){ return this._lock(async()=>{
    const f=await this._create(p,{access:0x00100081,disp:1,opts:1,attrs:0}); if(f.status) throw new SmbError(f.status,p||'/');
    const out=[];
    try{
      for(let first=true;;first=false){
        const pat=smbU16('*'), b=new Uint8Array(32+pat.length), dv=new DataView(b.buffer);
        dv.setUint16(0,33,true); b[2]=1; b[3]=first ? 1 : 0; b.set(f.fid,8); dv.setUint16(24,96,true); dv.setUint16(26,pat.length,true); dv.setUint32(28,65536,true); b.set(pat,32);
        const r=await this._req(SMB_CMD.QUERY_DIR,b);
        if(r.status===SMB_NO_MORE) break; if(r.status) throw new SmbError(r.status,p||'/');
        const rv=new DataView(r.msg.buffer,r.msg.byteOffset,r.msg.length), off=rv.getUint16(64+2,true), len=rv.getUint32(64+4,true);
        for(let o=off;;){
          const nx=rv.getUint32(o,true), nl=rv.getUint32(o+60,true), attr=rv.getUint32(o+56,true), name=smbFromU16(r.msg.subarray(o+64,o+64+nl));
          if(name!=='.' && name!=='..') out.push({name,dir:!!(attr&0x10),size:(attr&0x10) ? 0 : rv.getUint32(o+40,true)+rv.getUint32(o+44,true)*4294967296,mtime:smbFt(rv,o+24)});
          if(!nx) break; o+=nx; if(o>=off+len) break;
        }
      }
    } finally { await this._closeFid(f.fid); }
    return out.sort((a,b)=>(b.dir-a.dir)||a.name.localeCompare(b.name));
  }); }
  // конвейер из k запросов: job(i) → Promise для i = 0 … n-1
  async _pipe(n,k,job){ let next=0; const run=async()=>{ for(;;){ const i=next++; if(i>=n) return; await job(i); } }; await Promise.all(Array.from({length:Math.min(k,n)},run)); }
  read(p,a=0,b){ return this._lock(async()=>{
    const f=await this._create(p,{access:0x00120089,disp:1,opts:0x40}); if(f.status) throw new SmbError(f.status,p);
    try{
      const end=b==null ? f.size : Math.min(b,f.size); if(end<=a) return new Uint8Array(0);
      const out=new Uint8Array(end-a), ch=this.maxRead, n=Math.ceil((end-a)/ch);
      await this._pipe(n,4,async i=>{
        let pos=a+i*ch; const stop=Math.min(end,pos+ch);
        while(pos<stop){
          const bb=new Uint8Array(49), dv=new DataView(bb.buffer);
          dv.setUint16(0,49,true); bb[2]=0x50; dv.setUint32(4,stop-pos,true); dv.setUint32(8,pos%4294967296,true); dv.setUint32(12,Math.floor(pos/4294967296),true); bb.set(f.fid,16); dv.setUint32(32,1,true);
          const r=await this._req(SMB_CMD.READ,bb); if(r.status===SMB_EOF) break; if(r.status) throw new SmbError(r.status,p);
          const rv=new DataView(r.msg.buffer,r.msg.byteOffset,r.msg.length), off=r.msg[64+2], dl=rv.getUint32(64+4,true);
          if(!dl) break; out.set(r.msg.subarray(off,off+dl),pos-a); pos+=dl;
        }
      });
      return out;
    } finally { await this._closeFid(f.fid); }
  }); }
  write(p,bytes){ return this._lock(async()=>{
    if(typeof bytes==='string') bytes=new TextEncoder().encode(bytes);
    const f=await this._create(p,{access:0x00120116,disp:5,opts:0x40,attrs:0x80}); if(f.status) throw new SmbError(f.status,p);
    try{
      const ch=this.maxWrite, n=Math.max(1,Math.ceil(bytes.length/ch));
      await this._pipe(bytes.length ? n : 0,4,async i=>{
        const pos=i*ch, part=bytes.subarray(pos,pos+ch), bb=new Uint8Array(48+part.length), dv=new DataView(bb.buffer);
        dv.setUint16(0,49,true); dv.setUint16(2,112,true); dv.setUint32(4,part.length,true); dv.setUint32(8,pos%4294967296,true); dv.setUint32(12,Math.floor(pos/4294967296),true); bb.set(f.fid,16); bb.set(part,48);
        this._ok(await this._req(SMB_CMD.WRITE,bb),p);
      });
    } finally { await this._closeFid(f.fid); }
    return bytes.length;
  }); }
  mkdir(p){ return this._lock(async()=>{                                 // со всеми промежуточными папками; существующая — не ошибка
    const parts=smbToWin(p).split('\\').filter(Boolean); let cur='';
    for(const s of parts){
      cur+=(cur ? '\\' : '')+s;
      let f=await this._create(cur,{access:0x00100080,disp:1,opts:1});                          // уже есть — идём дальше
      if(f.status===0xC000000F || f.status===0xC0000034 || f.status===0xC000003A) f=await this._create(cur,{access:0x00100080,disp:2,opts:1,attrs:0x10});
      if(f.status) throw new SmbError(f.status,cur); await this._closeFid(f.fid);
    }
  }); }
  _setInfo(fid,cls,buf){ const b=new Uint8Array(32+buf.length), dv=new DataView(b.buffer); dv.setUint16(0,33,true); b[2]=1; b[3]=cls; dv.setUint32(4,buf.length,true); dv.setUint16(8,96,true); b.set(fid,16); b.set(buf,32); return this._req(SMB_CMD.SET_INFO,b); }
  remove(p){ return this._lock(async()=>{                               // файл или пустая папка
    const f=await this._create(p,{access:0x00110000|0x80,disp:1}); if(f.status) throw new SmbError(f.status,p);
    try{ this._ok(await this._setInfo(f.fid,13,Uint8Array.from([1])),p); } finally { await this._closeFid(f.fid); }
    return true;
  }); }
  rename(a,b){ return this._lock(async()=>{
    const f=await this._create(a,{access:0x00110000|0x80,disp:1}); if(f.status) throw new SmbError(f.status,a);
    try{
      const nm=smbU16(smbToWin(b)), buf=new Uint8Array(20+nm.length), dv=new DataView(buf.buffer); buf[0]=1; dv.setUint32(16,nm.length,true); buf.set(nm,20);
      this._ok(await this._setInfo(f.fid,10,buf),a+' → '+b);
    } finally { await this._closeFid(f.fid); }
  }); }
  async close(){
    const c=this.c; this.c=null; this.closed=true;
    if(c){ try{ await c.close(); }catch(e){} }
    for(const [id,w] of this.pend){ clearTimeout(w.timer); w.rej(new Error('connection closed')); } this.pend.clear(); this._creditsWake();
  }
}
