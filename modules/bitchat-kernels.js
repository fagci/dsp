"use strict";
/* ============================ bitchat: ядро протокола ============================
   Бинарный протокол bitchat (permissionlesstech/bitchat, BinaryProtocol.swift) — только v1,
   без Noise/маршрутов: нам нужен только публичный broadcast-чат (type announce/message),
   приватные (Noise) сообщения не реализуем. Крипто (Ed25519 подпись, SHA-256 для peerID) —
   в bitchat.js через Web Crypto (kernels — чистая упаковка байт, без crypto, по образцу meshcore-kernels.js).
   Разбор — tools/test-bitchat.mjs. Service/characteristic UUID — data/bluetooth-uuids.json (tools/bt-uuids.mjs). */

const BC_SERVICE_UUID='f47b5e2d-4a9e-4c5a-9b3f-8e1d2c3a4b5c';      // mainnet; debug-сборки bitchat используют …4b5a
const BC_CHAR_UUID='a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d';
const BC_TYPES={1:'announce',2:'message',3:'leave',4:'courierEnvelope',0x10:'noiseHandshake',0x11:'noiseEncrypted',0x20:'fragment',0x21:'requestSync',0x26:'ping',0x27:'pong'};
const BC_FLAG_RECIPIENT=0x01, BC_FLAG_SIGNATURE=0x02, BC_FLAG_COMPRESSED=0x04;
const BC_SENDER_SIZE=8, BC_SIG_SIZE=64;

function bcU64(v){ const b=new Uint8Array(8); for(let i=7;i>=0;i--){ b[i]=v%256; v=Math.floor(v/256); } return b; }
function bcReadU64(b,o){ let v=0; for(let i=0;i<8;i++) v=v*256+b[o+i]; return v; }

// Пакет без сжатия (для исходящих — короткие сообщения чата, сжимать незачем) и без паддинга
// (его bitchat добавляет только к Noise-кадрам — WHITEPAPER.md; наши публичные кадры идут как есть).
function bcEncode(p){
  const payload=p.payload||new Uint8Array(0);
  const hasRecipient=!!p.recipientID, hasSignature=!!p.signature;
  const senderID=(p.senderID||new Uint8Array(BC_SENDER_SIZE)).slice(0,BC_SENDER_SIZE);
  const size=14+BC_SENDER_SIZE+(hasRecipient?8:0)+payload.length+(hasSignature?BC_SIG_SIZE:0);
  const out=new Uint8Array(size); let o=0;
  out[o++]=1;                                   // version
  out[o++]=p.type&255;
  out[o++]=p.ttl&255;
  out.set(bcU64(p.timestamp||0),o); o+=8;
  out[o++]=(hasRecipient?BC_FLAG_RECIPIENT:0)|(hasSignature?BC_FLAG_SIGNATURE:0);
  out[o++]=(payload.length>>8)&255; out[o++]=payload.length&255;
  out.set(senderID,o); o+=BC_SENDER_SIZE;       // короче 8 байт — остаток уже нулевой (Uint8Array)
  if(hasRecipient){ const r=p.recipientID.slice(0,8); out.set(r,o); o+=8; }
  out.set(payload,o); o+=payload.length;
  if(hasSignature){ out.set(p.signature.slice(0,BC_SIG_SIZE),o); o+=BC_SIG_SIZE; }
  return out;
}

// Байты для подписи/проверки — тот же пакет, но ttl=0 и без подписи (BitchatPacket.toBinaryDataForSigning:
// TTL меняется при ретрансляции, поэтому в подпись не входит).
function bcSigningBytes(p){ return bcEncode({...p,ttl:0,signature:null}); }

function bcDecode(bytes){
  if(bytes.length<14+BC_SENDER_SIZE) return null;
  const version=bytes[0]; if(version!==1 && version!==2) return null;
  const headerSize=version===2 ? 16 : 14;
  if(bytes.length<headerSize+BC_SENDER_SIZE) return null;
  let o=1;
  const type=bytes[o++], ttl=bytes[o++];
  const timestamp=bcReadU64(bytes,o); o+=8;
  const flags=bytes[o++];
  const hasRecipient=!!(flags&BC_FLAG_RECIPIENT), hasSignature=!!(flags&BC_FLAG_SIGNATURE), isCompressed=!!(flags&BC_FLAG_COMPRESSED);
  let payloadLength;
  if(version===2){ payloadLength=((bytes[o]<<24)|(bytes[o+1]<<16)|(bytes[o+2]<<8)|bytes[o+3])>>>0; o+=4; }
  else { payloadLength=(bytes[o]<<8)|bytes[o+1]; o+=2; }
  const senderID=bytes.slice(o,o+BC_SENDER_SIZE); o+=BC_SENDER_SIZE;
  let recipientID=null;
  if(hasRecipient){ if(o+8>bytes.length) return null; recipientID=bytes.slice(o,o+8); o+=8; }
  if(version===2 && (flags&0x08)){ const n=bytes[o]; o+=1+n*8; }  // route (v2) — пропускаем, не используем
  if(o+payloadLength>bytes.length) return null;
  let payload=bytes.slice(o,o+payloadLength); o+=payloadLength;
  let originalSize=null;
  if(isCompressed){
    const lf=version===2?4:2;
    if(payload.length<lf) return null;
    originalSize=version===2 ? ((payload[0]<<24)|(payload[1]<<16)|(payload[2]<<8)|payload[3])>>>0 : (payload[0]<<8)|payload[1];
    payload=payload.slice(lf);                  // сжатые байты; распаковка (DecompressionStream) — в bitchat.js
  }
  let signature=null;
  if(hasSignature){ if(o+BC_SIG_SIZE>bytes.length) return null; signature=bytes.slice(o,o+BC_SIG_SIZE); o+=BC_SIG_SIZE; }
  return {version,type,typeName:BC_TYPES[type]||('0x'+type.toString(16)),ttl,timestamp,senderID,recipientID,payload,isCompressed,originalSize,signature};
}

// PKCS#7-подобный паддинг Noise-кадров (MessagePadding.swift) — не используем для своих публичных
// кадров, но распаковка может понадобиться, если нам прилетит что-то с паддингом.
const BC_PAD_BLOCKS=[256,512,1024,2048];
function bcPad(data,targetSize){
  if(data.length>=targetSize) return data;
  const need=targetSize-data.length; if(need<=0||need>255) return data;
  const out=new Uint8Array(data.length+need); out.set(data); out.fill(need,data.length);
  return out;
}
function bcUnpad(data){
  if(!data.length) return data;
  const n=data[data.length-1]; if(n<=0||n>data.length) return data;
  for(let i=data.length-n;i<data.length;i++) if(data[i]!==n) return data;
  return data.slice(0,data.length-n);
}
function bcOptimalBlockSize(n){ const t=n+16; for(const b of BC_PAD_BLOCKS) if(t<=b) return b; return n; }

// TLV announce (AnnouncementPacket.swift) — отдаём/берём только то, что нужно базовому чату:
// никнейм + два публичных ключа (Noise/X25519, подписи/Ed25519); остальные TLV при разборе пропускаем.
const BC_TLV={nickname:1,noisePub:2,signPub:3,neighbors:4,capabilities:5,bridgeGeohash:6};
function bcEncodeAnnounce(a){
  const te=s=>new TextEncoder().encode(s);
  const nick=te(a.nickname||'').slice(0,255);
  const parts=[Uint8Array.of(BC_TLV.nickname,nick.length),nick,
               Uint8Array.of(BC_TLV.noisePub,a.noisePublicKey.length),a.noisePublicKey,
               Uint8Array.of(BC_TLV.signPub,a.signingPublicKey.length),a.signingPublicKey];
  let size=0; for(const p of parts) size+=p.length;
  const out=new Uint8Array(size); let o=0; for(const p of parts){ out.set(p,o); o+=p.length; }
  return out;
}
function bcDecodeAnnounce(bytes){
  let o=0; const r={nickname:null,noisePublicKey:null,signingPublicKey:null};
  while(o+2<=bytes.length){
    const t=bytes[o], len=bytes[o+1]; o+=2;
    if(o+len>bytes.length) break;
    const v=bytes.slice(o,o+len); o+=len;
    if(t===BC_TLV.nickname) r.nickname=new TextDecoder().decode(v);
    else if(t===BC_TLV.noisePub) r.noisePublicKey=v;
    else if(t===BC_TLV.signPub) r.signingPublicKey=v;
    // directNeighbors/capabilities/bridgeGeohash — для базового чата не разбираем
  }
  if(!r.nickname || !r.noisePublicKey || !r.signingPublicKey) return null;
  return r;
}

// Адаптивный TTL входящего стартового пакета (TransportConfig.messageTTLDefault = 7, WHITEPAPER.md)
const BC_TTL_DEFAULT=7;

function bcHex(u8){ let s=''; for(let i=0;i<u8.length;i++) s+=u8[i].toString(16).padStart(2,'0'); return s; }
function bcUnhex(s){ s=String(s||'').replace(/[^0-9a-f]/ig,''); const n=s.length>>1, u8=new Uint8Array(n); for(let i=0;i<n;i++) u8[i]=parseInt(s.substr(i*2,2),16); return u8; }

if(typeof module!=='undefined') module.exports={bcEncode,bcDecode,bcSigningBytes,bcEncodeAnnounce,bcDecodeAnnounce,bcPad,bcUnpad,bcOptimalBlockSize,bcHex,bcUnhex,BC_SERVICE_UUID,BC_CHAR_UUID,BC_TTL_DEFAULT,BC_TYPES};
