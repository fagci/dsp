"use strict";
/* ============================ MeshCore: ядро ============================
   Разбор пакета MeshCore прямо из эфира (meshcore-dev/meshcore: Packet.cpp, Identity.h, Utils.cpp, AdvertDataHelpers.cpp).
   В отличие от Meshtastic (protobuf), формат — простые бинарные структуры; подпись Ed25519 у ADVERT не проверяем
   (её тело и так целиком открытое — подпись лишь подтверждает, что оно от владельца ключа, а не меняет видимость данных).
   Публичный канал «Public» (см. examples companion_radio MyMesh.cpp) расшифровывается ключом по умолчанию; свои каналы — своим PSK.
   Структурный разбор заголовка/path для HEX Structure — отдельно, modules/hex-formats.js (схема meshcore). */

const MC_PUBLIC_PSK='izOH6cXN6mrJ5e26oRXNcg=='; // base64, 16 байт — предустановленный канал «Public» в клиентах MeshCore
const MC_ROUTE=['transport flood','flood','direct','transport direct'];
const MC_TYPES={0:'request',1:'response',2:'text',3:'ack',4:'advert',5:'group text',6:'group data',7:'anon request',8:'path',9:'trace',10:'multipart',11:'control',15:'raw custom'};
const MC_ADV_TYPES={0:'none',1:'chat',2:'repeater',3:'room',4:'sensor'};

// ---- SHA-256 и HMAC-SHA256 (нужны для MAC группового сообщения и хеша канала) ----
const MC_SHA_K=Uint32Array.from([
0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
const mcRor=(x,n)=>((x>>>n)|(x<<(32-n)))>>>0;
function mcSha256(msg){
  const h=Uint32Array.from([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const bitLen=msg.length*8, padLen=(((msg.length+9+63)>>6)<<6), buf=new Uint8Array(padLen);
  buf.set(msg); buf[msg.length]=0x80;
  const dv=new DataView(buf.buffer); dv.setUint32(padLen-4,bitLen>>>0,false); dv.setUint32(padLen-8,Math.floor(bitLen/4294967296),false);
  const w=new Uint32Array(64);
  for(let off=0;off<padLen;off+=64){
    for(let i=0;i<16;i++) w[i]=dv.getUint32(off+i*4,false);
    for(let i=16;i<64;i++){
      const s0=mcRor(w[i-15],7)^mcRor(w[i-15],18)^(w[i-15]>>>3), s1=mcRor(w[i-2],17)^mcRor(w[i-2],19)^(w[i-2]>>>10);
      w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;
    }
    let [a,b,c,d,e,f,g,hh]=h;
    for(let i=0;i<64;i++){
      const S1=mcRor(e,6)^mcRor(e,11)^mcRor(e,25), ch=(e&f)^((~e)&g), t1=(hh+S1+ch+MC_SHA_K[i]+w[i])>>>0;
      const S0=mcRor(a,2)^mcRor(a,13)^mcRor(a,22), maj=(a&b)^(a&c)^(b&c), t2=(S0+maj)>>>0;
      hh=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    h[0]=(h[0]+a)>>>0; h[1]=(h[1]+b)>>>0; h[2]=(h[2]+c)>>>0; h[3]=(h[3]+d)>>>0;
    h[4]=(h[4]+e)>>>0; h[5]=(h[5]+f)>>>0; h[6]=(h[6]+g)>>>0; h[7]=(h[7]+hh)>>>0;
  }
  const out=new Uint8Array(32), odv=new DataView(out.buffer);
  for(let i=0;i<8;i++) odv.setUint32(i*4,h[i],false);
  return out;
}
function mcHmacSha256(key,msg){
  const B=64; let k=key.length>B ? mcSha256(key) : key;
  if(k.length<B){ const t=new Uint8Array(B); t.set(k); k=t; }
  const opad=new Uint8Array(B), ipad=new Uint8Array(B);
  for(let i=0;i<B;i++){ opad[i]=k[i]^0x5c; ipad[i]=k[i]^0x36; }
  return mcSha256(Uint8Array.from([...opad,...mcSha256(Uint8Array.from([...ipad,...msg]))]));
}

// ---- AES-128 (encrypt — для тестов/передачи, decrypt — для приёма), ECB по 16-байтным блокам, без IV — так у MeshCore ----
const MC_SBOX=Uint8Array.from([
0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16]);
const MC_ISBOX=new Uint8Array(256); for(let i=0;i<256;i++) MC_ISBOX[MC_SBOX[i]]=i;
const MC_RCON=[0,0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36,0x6c,0xd8,0xab,0x4d];
function mcAesSchedule(key){                                       // AES-128: Nk=4, Nr=10
  const Nk=4, Nr=10, w=[];
  for(let i=0;i<Nk;i++) w[i]=[key[4*i],key[4*i+1],key[4*i+2],key[4*i+3]];
  for(let i=Nk;i<4*(Nr+1);i++){
    let t=w[i-1].slice();
    if(i%Nk===0){ t=[MC_SBOX[t[1]],MC_SBOX[t[2]],MC_SBOX[t[3]],MC_SBOX[t[0]]]; t[0]^=MC_RCON[i/Nk]; }
    w[i]=w[i-Nk].map((b,j)=>b^t[j]);
  }
  return {w,Nr};
}
const mcGmul=(a,b)=>{ let p=0; for(let i=0;i<8;i++){ if(b&1) p^=a; const hi=a&0x80; a=(a<<1)&255; if(hi) a^=0x1b; b>>=1; } return p; };
const mcAddRK=(s,w,round)=>{ for(let c=0;c<4;c++) for(let r=0;r<4;r++) s[r][c]^=w[round*4+c][r]; };
function mcAesEncryptBlock(inp,sch){
  const {w,Nr}=sch, s=[[],[],[],[]];
  for(let c=0;c<4;c++) for(let r=0;r<4;r++) s[r][c]=inp[r+4*c];
  mcAddRK(s,w,0);
  for(let round=1;round<=Nr;round++){
    for(let r=0;r<4;r++) for(let c=0;c<4;c++) s[r][c]=MC_SBOX[s[r][c]];
    for(let r=1;r<4;r++){ const row=s[r].slice(); for(let c=0;c<4;c++) s[r][c]=row[(c+r)%4]; }
    if(round<Nr) for(let c=0;c<4;c++){
      const a0=s[0][c],a1=s[1][c],a2=s[2][c],a3=s[3][c];
      s[0][c]=mcGmul(a0,2)^mcGmul(a1,3)^a2^a3; s[1][c]=a0^mcGmul(a1,2)^mcGmul(a2,3)^a3;
      s[2][c]=a0^a1^mcGmul(a2,2)^mcGmul(a3,3); s[3][c]=mcGmul(a0,3)^a1^a2^mcGmul(a3,2);
    }
    mcAddRK(s,w,round);
  }
  const out=new Uint8Array(16); for(let c=0;c<4;c++) for(let r=0;r<4;r++) out[r+4*c]=s[r][c];
  return out;
}
function mcAesDecryptBlock(inp,sch){
  const {w,Nr}=sch, s=[[],[],[],[]];
  for(let c=0;c<4;c++) for(let r=0;r<4;r++) s[r][c]=inp[r+4*c];
  mcAddRK(s,w,Nr);
  for(let round=Nr-1;round>=1;round--){
    for(let r=1;r<4;r++){ const row=s[r].slice(); for(let c=0;c<4;c++) s[r][c]=row[(c-r+4)%4]; }
    for(let r=0;r<4;r++) for(let c=0;c<4;c++) s[r][c]=MC_ISBOX[s[r][c]];
    mcAddRK(s,w,round);
    for(let c=0;c<4;c++){
      const a0=s[0][c],a1=s[1][c],a2=s[2][c],a3=s[3][c];
      s[0][c]=mcGmul(a0,14)^mcGmul(a1,11)^mcGmul(a2,13)^mcGmul(a3,9); s[1][c]=mcGmul(a0,9)^mcGmul(a1,14)^mcGmul(a2,11)^mcGmul(a3,13);
      s[2][c]=mcGmul(a0,13)^mcGmul(a1,9)^mcGmul(a2,14)^mcGmul(a3,11); s[3][c]=mcGmul(a0,11)^mcGmul(a1,13)^mcGmul(a2,9)^mcGmul(a3,14);
    }
  }
  for(let r=1;r<4;r++){ const row=s[r].slice(); for(let c=0;c<4;c++) s[r][c]=row[(c-r+4)%4]; }
  for(let r=0;r<4;r++) for(let c=0;c<4;c++) s[r][c]=MC_ISBOX[s[r][c]];
  mcAddRK(s,w,0);
  const out=new Uint8Array(16); for(let c=0;c<4;c++) for(let r=0;r<4;r++) out[r+4*c]=s[r][c];
  return out;
}
function mcEcbDecrypt(key16,data){                                 // data: кратно 16 Б
  const sch=mcAesSchedule(key16), out=new Uint8Array(data.length);
  for(let off=0;off+16<=data.length;off+=16) out.set(mcAesDecryptBlock(data.subarray(off,off+16),sch),off);
  return out;
}
function mcEcbEncrypt(key16,data){                                 // для тестов/передачи — последний неполный блок дополняется нулями
  const sch=mcAesSchedule(key16), full=Math.ceil(data.length/16)*16, out=new Uint8Array(full), src=new Uint8Array(full);
  src.set(data);
  for(let off=0;off<full;off+=16) out.set(mcAesEncryptBlock(src.subarray(off,off+16),sch),off);
  return out;
}

// ---- каналы: PSK (base64, 16 или 32 Б) → secret (32 Б, хвост нулями при 16-байтном PSK) и его 1-байтный хеш (ровно как в прошивке) ----
function mcPskSecret(b64){
  let raw; try{ raw=atob(String(b64||'').trim()); }catch(e){ return null; }
  if(raw.length!==16 && raw.length!==32) return null;
  const secret=new Uint8Array(32);
  for(let i=0;i<raw.length;i++) secret[i]=raw.charCodeAt(i);
  return {secret, hash:mcSha256(secret.subarray(0,raw.length))[0], b64};
}
function mcMacThenDecrypt(secret32,bytes){                         // bytes: MAC(2) + шифртекст (кратно 16 Б)
  if(bytes.length<=2) return null;
  const mac=bytes.subarray(0,2), ct=bytes.subarray(2);
  if(ct.length%16!==0) return null;
  const h=mcHmacSha256(secret32,ct);
  if(h[0]!==mac[0] || h[1]!==mac[1]) return null;                  // неверный ключ или битые данные
  return mcEcbDecrypt(secret32.subarray(0,16),ct);
}
function mcEncryptThenMac(secret32,plain){                         // обратная операция — пригодится и для теста, и для передачи
  const ct=mcEcbEncrypt(secret32.subarray(0,16),plain), mac=mcHmacSha256(secret32,ct);
  return Uint8Array.from([mac[0],mac[1],...ct]);
}

// ---- заголовок и путь пакета (Packet.cpp: writeTo/readFrom) ----
function mcHeader(b0){ return {route:b0&3, type:(b0>>2)&15, ver:(b0>>6)&3}; }
function mcPacket(bytes){
  if(!bytes.length) return null;
  let i=0; const h=mcHeader(bytes[i++]);
  let transport=null;
  if(h.route===0 || h.route===3){ if(i+4>bytes.length) return null; transport=[bytes[i]|bytes[i+1]<<8,bytes[i+2]|bytes[i+3]<<8]; i+=4; }
  if(i>=bytes.length) return null;
  const pl=bytes[i++], hashSize=(pl>>6)+1, hashCount=pl&63, pathBytes=hashCount*hashSize;
  if(hashSize===4 || i+pathBytes>bytes.length) return null;        // hashSize 4 — зарезервировано, не бывает
  const path=bytes.subarray(i,i+pathBytes); i+=pathBytes;
  return {...h, transport, hashSize, hashCount, path, payload:bytes.subarray(i)};
}

// ---- ADVERT: целиком открытый текст (подпись Ed25519 не проверяем — см. заголовок файла) ----
function mcAdvert(payload){
  if(payload.length<32+4+64) return null;
  const pubKey=payload.subarray(0,32), timestamp=(payload[32]|payload[33]<<8|payload[34]<<16|payload[35]<<24)>>>0;
  const app=payload.subarray(32+4+64), o={pubKey:bytesHex(pubKey), id:bytesHex(pubKey.subarray(0,1)), timestamp};
  if(app.length){
    const flags=app[0]; o.advType=flags&15; o.advTypeName=MC_ADV_TYPES[o.advType]||('type '+o.advType);
    let j=1;
    if(flags&0x10 && j+8<=app.length){ o.lat=((app[j]|app[j+1]<<8|app[j+2]<<16|app[j+3]<<24)|0)/1e6; j+=4; o.lon=((app[j]|app[j+1]<<8|app[j+2]<<16|app[j+3]<<24)|0)/1e6; j+=4; }
    if(flags&0x20 && j+2<=app.length){ o.feat1=app[j]|app[j+1]<<8; j+=2; }
    if(flags&0x40 && j+2<=app.length){ o.feat2=app[j]|app[j+1]<<8; j+=2; }
    if(flags&0x80 && j<=app.length) o.name=new TextDecoder().decode(app.subarray(j));
  }
  return o;
}
// ---- группа: канал (1 Б хеш) + MAC(2) + AES-ECB; расшифровано — timestamp+текст («Имя: текст») или типизированный датаграм ----
function mcGroupText(plain){
  if(plain.length<5) return null;
  const timestamp=(plain[0]|plain[1]<<8|plain[2]<<16|plain[3]<<24)>>>0, txtType=plain[4];
  let end=5; while(end<plain.length && plain[end]!==0) end++;
  return {timestamp, txtType, text:new TextDecoder().decode(plain.subarray(5,end))};
}
function mcGroupData(plain){
  if(plain.length<3) return null;
  const dataType=plain[0]|plain[1]<<8, dataLen=Math.min(plain[2],plain.length-3);
  return {dataType, data:plain.subarray(3,3+dataLen)};
}
function mcGroupDecode(payload,pskList){
  if(!payload.length) return null;
  const channelHash=payload[0], rest=payload.subarray(1);
  for(const b64 of pskList){
    const ks=mcPskSecret(b64);
    if(!ks || ks.hash!==channelHash) continue;
    const plain=mcMacThenDecrypt(ks.secret,rest);
    if(plain) return {channelHash, psk:b64, plain};
  }
  return {channelHash, encrypted:true};
}
// ---- TRACE: открытый текст, но путь/SNR пакет копит по хопам — из одного кадра видно лишь срез на момент приёма ----
function mcTrace(payload){
  if(payload.length<9) return null;
  const tag=(payload[0]|payload[1]<<8|payload[2]<<16|payload[3]<<24)>>>0, auth=(payload[4]|payload[5]<<8|payload[6]<<16|payload[7]<<24)>>>0;
  const flags=payload[8], pathHashSize=1<<(flags&3);
  return {tag, auth, flags, pathHashSize, rest:bytesHex(payload.subarray(9))};
}
// ---- сборка результата по одному эфирному кадру ----
function mcDecode(bytes,pskList){
  const p=mcPacket(bytes); if(!p) return null;
  const o={route:MC_ROUTE[p.route], type:p.type, typeName:MC_TYPES[p.type]||('type '+p.type), ver:p.ver, hopCount:p.hashCount, path:bytesHex(p.path)};
  if(p.type===4){ const a=mcAdvert(p.payload); if(a) Object.assign(o,{advert:true},a); }
  else if(p.type===5 || p.type===6){
    const g=mcGroupDecode(p.payload,pskList&&pskList.length ? pskList : [MC_PUBLIC_PSK]);
    if(g){
      o.channelHash=g.channelHash;
      if(g.encrypted) o.encrypted=true;
      else{
        o.psk=g.psk;
        if(p.type===5){ const t=mcGroupText(g.plain); if(t) Object.assign(o,t); }
        else{ const d=mcGroupData(g.plain); if(d) Object.assign(o,{dataType:d.dataType, data:bytesHex(d.data)}); }
      }
    }
  } else if(p.type===9){ const t=mcTrace(p.payload); if(t) Object.assign(o,t); }
  else o.undecoded=true;                                           // text/request/response/anon/ack/path/multipart/control — нужен приватный ключ получателя
  return o;
}

if(typeof module!=='undefined') module.exports={mcSha256,mcHmacSha256,mcAesSchedule,mcAesEncryptBlock,mcAesDecryptBlock,mcEcbDecrypt,mcEcbEncrypt,
  mcPskSecret,mcMacThenDecrypt,mcEncryptThenMac,mcHeader,mcPacket,mcAdvert,mcGroupText,mcGroupData,mcGroupDecode,mcTrace,mcDecode,MC_PUBLIC_PSK,MC_ROUTE,MC_TYPES,MC_ADV_TYPES};
