"use strict";
/* ============================ Байты и файлы: ядро ============================
   Порт bin несёт {d:Uint8Array, name, mime, id}: id новый на каждую передачу, по нему приёмник отличает новые данные от повтора.
   Кадр для любого канала (UART, WebSocket, MQTT, BLE, звук, радио): D5 7A | тип | xid u16 | seq u16 | total u16 | len u16 | тело | CRC-32.
   CRC считается от типа до конца тела. Тип 0 — META (size u32, CRC-32 файла, длина имени u8, имя, MIME), тип 1 — DATA.
   Кадры независимы: порядок и повторы не важны, потерянные добирает карусель (повтор передачи целиком). Числа — little-endian. */

const BIN_MAGIC0=0xD5, BIN_MAGIC1=0x7A, BIN_HDR=11, BIN_MAXPAY=65535;
const binEnc8=new TextEncoder(), binDec8=new TextDecoder();

const BIN_CRC_T=(()=>{ const t=new Uint32Array(256);
  for(let i=0;i<256;i++){ let c=i; for(let k=0;k<8;k++) c=c&1 ? 0xEDB88320^(c>>>1) : c>>>1; t[i]=c>>>0; }
  return t; })();
function binCrc32(u,from=0,to=u.length,crc=0){
  let c=~crc>>>0;
  for(let i=from;i<to;i++) c=BIN_CRC_T[(c^u[i])&255]^(c>>>8);
  return ~c>>>0;
}
const binCat=(...a)=>{ let n=0; for(const x of a) n+=x.length; const o=new Uint8Array(n); let k=0; for(const x of a){ o.set(x,k); k+=x.length; } return o; };

// ---- текстовые представления ----
const BIN_ENC=['base64','hex','base64url','utf8','latin1'];
function binToText(u,enc){
  if(enc==='hex'){ let s=''; for(let i=0;i<u.length;i++) s+=(u[i]<16 ? '0' : '')+u[i].toString(16); return s; }
  if(enc==='utf8') return binDec8.decode(u);
  let s=''; for(let i=0;i<u.length;i+=0x8000) s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));
  if(enc==='latin1') return s;
  const b=btoa(s);
  return enc==='base64url' ? b.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'') : b;
}
function binFromText(s,enc){
  s=String(s);
  if(enc==='utf8') return binEnc8.encode(s);
  if(enc==='hex'){
    const h=s.replace(/0x|[\s,:-]/gi,'');
    if(h.length&1 || /[^0-9a-f]/i.test(h)) throw new Error('not hex');
    const o=new Uint8Array(h.length>>1); for(let i=0;i<o.length;i++) o[i]=parseInt(h.substr(i*2,2),16);
    return o;
  }
  if(enc==='latin1') return Uint8Array.from(s,c=>c.charCodeAt(0)&255);
  let b=s.replace(/\s+/g,'').replace(/-/g,'+').replace(/_/g,'/');
  if(/[^A-Za-z0-9+/=]/.test(b)) throw new Error('not base64');
  b=b.replace(/=+$/,''); b+='='.repeat((4-b.length%4)%4);
  const r=atob(b), o=new Uint8Array(r.length); for(let i=0;i<r.length;i++) o[i]=r.charCodeAt(i);
  return o;
}
// строка кадра: hex начинается с D57A, иначе base64 / base64url
const binLineToFrame=s=>{ s=String(s).trim(); return binFromText(s,/^d57a/i.test(s) ? 'hex' : 'base64'); };

// ---- кадрирование ----
function binFrame(type,xid,seq,total,body){
  const f=new Uint8Array(BIN_HDR+body.length+4), dv=new DataView(f.buffer);
  f[0]=BIN_MAGIC0; f[1]=BIN_MAGIC1; f[2]=type; dv.setUint16(3,xid,true); dv.setUint16(5,seq,true); dv.setUint16(7,total,true); dv.setUint16(9,body.length,true);
  f.set(body,BIN_HDR); dv.setUint32(BIN_HDR+body.length,binCrc32(f,2,BIN_HDR+body.length),true);
  return f;
}
// данные → кадры: META, затем DATA 0…total-1
function binPack(data,o={}){
  const pay=Math.max(1,Math.min(BIN_MAXPAY,o.pay|0||64)), total=Math.ceil(data.length/pay), xid=(o.xid!=null ? o.xid : Math.random()*65536)&0xFFFF;
  if(total>65535) throw new Error('too many frames: '+total+' (raise the payload size)');
  const nm=binEnc8.encode(String(o.name||'').slice(0,200)).subarray(0,250), mm=binEnc8.encode(String(o.mime||'').slice(0,100));
  const meta=new Uint8Array(9+nm.length+mm.length), mv=new DataView(meta.buffer);
  mv.setUint32(0,data.length,true); mv.setUint32(4,binCrc32(data),true); meta[8]=nm.length; meta.set(nm,9); meta.set(mm,9+nm.length);
  const out=[binFrame(0,xid,0,total,meta)];
  for(let i=0;i<total;i++) out.push(binFrame(1,xid,i,total,data.subarray(i*pay,(i+1)*pay)));
  return out;
}
// один кадр целиком → {type,xid,seq,total,body} или null (не кадр / CRC)
function binParse(f){
  if(f.length<BIN_HDR+4 || f[0]!==BIN_MAGIC0 || f[1]!==BIN_MAGIC1) return null;
  const dv=new DataView(f.buffer,f.byteOffset,f.byteLength), len=dv.getUint16(9,true);
  if(f.length!==BIN_HDR+len+4 || dv.getUint32(BIN_HDR+len,true)!==binCrc32(f,2,BIN_HDR+len)) return null;
  return {type:f[2],xid:dv.getUint16(3,true),seq:dv.getUint16(5,true),total:dv.getUint16(7,true),body:f.subarray(BIN_HDR,BIN_HDR+len)};
}

// поток байтов произвольной нарезки → кадры; после мусора или порчи ищет следующую магию
class BinStream{
  constructor(){ this.buf=new Uint8Array(0); this.bad=0; }
  push(u){
    this.buf=this.buf.length ? binCat(this.buf,u) : u.slice();
    const out=[]; let b=this.buf, i=0;
    for(;;){
      while(i+1<b.length && !(b[i]===BIN_MAGIC0 && b[i+1]===BIN_MAGIC1)) i++;
      if(i+1>=b.length){ if(i<b.length && b[i]!==BIN_MAGIC0) i=b.length; break; }
      if(b.length-i<BIN_HDR) break;
      const len=b[i+9]|b[i+10]<<8, end=i+BIN_HDR+len+4;
      if(b.length<end) break;
      const p=binParse(b.subarray(i,end));
      if(p){ out.push(p); i=end; } else{ this.bad++; i++; }
    }
    this.buf=b.slice(i);
    if(this.buf.length>BIN_HDR+BIN_MAXPAY+4) this.buf=this.buf.slice(-(BIN_HDR+BIN_MAXPAY+4));
    return out;
  }
}

// кадры → файлы; несколько передач сразу (по xid), порядок и повторы не важны
class BinAssembler{
  constructor(){ this.tx=new Map(); this.done=new Map(); this.good=0; this.files=0; this.badFile=0; }
  // → {data,name,mime,xid} при завершении передачи; progress/stat — в полях
  push(p,now=Date.now()){
    this.good++;
    if(this.done.has(p.xid)){ this.done.set(p.xid,now); return null; }          // повтор уже принятого (карусель)
    let t=this.tx.get(p.xid);
    if(!t){ t={xid:p.xid,total:p.total,parts:new Map(),meta:null,at:now}; this.tx.set(p.xid,t); if(this.tx.size>16) this.tx.delete(this.tx.keys().next().value); }
    if(p.total!==t.total){ t.total=p.total; t.parts.clear(); }
    t.at=now;
    if(p.type===0 && p.body.length>=9){
      const dv=new DataView(p.body.buffer,p.body.byteOffset,p.body.byteLength), nl=p.body[8];
      t.meta={size:dv.getUint32(0,true),crc:dv.getUint32(4,true),name:binDec8.decode(p.body.subarray(9,9+nl)),mime:binDec8.decode(p.body.subarray(9+nl))};
    }else if(p.type===1 && p.seq<t.total) t.parts.set(p.seq,p.body.slice());
    if(!t.meta || t.parts.size<t.total) return null;
    const data=binCat(...Array.from({length:t.total},(_,i)=>t.parts.get(i)));
    this.tx.delete(p.xid);
    if(data.length!==t.meta.size || binCrc32(data)!==t.meta.crc){ this.badFile++; return null; }
    this.done.set(p.xid,now); if(this.done.size>32) this.done.delete(this.done.keys().next().value);
    this.files++;
    return {data,name:t.meta.name,mime:t.meta.mime,xid:p.xid};
  }
  // самая продвинутая незавершённая передача: доля 0…1 (META считается как кадр)
  progress(){ let m=0; for(const t of this.tx.values()) m=Math.max(m,(t.parts.size+(t.meta ? 1 : 0))/(t.total+1)); return m; }
  expire(now,ms){ for(const [k,t] of this.tx) if(now-t.at>ms) this.tx.delete(k); for(const [k,at] of this.done) if(now-at>ms) this.done.delete(k); }
}

if(typeof module!=='undefined') module.exports={binCrc32,binToText,binFromText,binLineToFrame,binFrame,binPack,binParse,BinStream,BinAssembler,BIN_ENC};
