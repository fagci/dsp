"use strict";
/* ============================ Meshtastic: ядро ============================
   Минимальный protobuf (чтение и запись), разбор FromRadio / MeshPacket / Data и сборка ToRadio.
   Говорим с нодой по её клиентскому API (BLE или Serial), радио-уровень и шифрование остаются на ноде.
   Номера полей — по meshtastic/protobufs (mesh.proto, portnums.proto, telemetry.proto). Узлы и транспорт — meshtastic.js.
   Разбор кадра прямо из эфира (поверх LoRa Decoder) — AES-CTR и 16-байтный заголовок пакета — meshtastic-air.js. */

const MSH_BLE={svc:'6ba1b218-15a8-461f-9fa8-5dcae273eafd',toRadio:'f75c76d2-129e-4dad-a1dd-7866124401e7',
  fromRadio:'2c55e69e-4993-11ed-b878-0242ac120002',fromNum:'ed9da18c-a800-4f66-a670-aa7547e34453'};
const MSH_BROADCAST=0xFFFFFFFF;
const MSH_PORTS={0:'unknown',1:'text',2:'remote hw',3:'position',4:'nodeinfo',5:'routing',6:'admin',7:'text (compressed)',8:'waypoint',
  32:'reply',33:'ip tunnel',34:'paxcounter',64:'serial',65:'store&forward',66:'range test',67:'telemetry',70:'traceroute',71:'neighbor info',72:'atak',73:'map report'};

// ---- protobuf: чтение ----
// Поля раскладываются в {num:[значения]}: varint → число (uint32-диапазон), fixed32 → сырое беззнаковое, len → Uint8Array
function pbRead(b){
  const f={}; let i=0;
  const varint=()=>{ let lo=0,sh=0,x; do{ if(i>=b.length) throw new Error('eof'); x=b[i++]; if(sh<28) lo|=(x&0x7f)<<sh; else if(sh<35) lo|=(x&0x0f)<<28; sh+=7; }while(x&0x80 && sh<70); return lo>>>0; };
  while(i<b.length){
    const key=varint(), num=key>>>3, wt=key&7; let v;
    if(wt===0) v=varint();
    else if(wt===5){ if(i+4>b.length) throw new Error('eof'); v=(b[i]|b[i+1]<<8|b[i+2]<<16|b[i+3]<<24)>>>0; i+=4; }
    else if(wt===1){ if(i+8>b.length) throw new Error('eof'); v=b.slice(i,i+8); i+=8; }
    else if(wt===2){ const l=varint(); if(i+l>b.length) throw new Error('eof'); v=b.subarray(i,i+l); i+=l; }
    else throw new Error('wire type '+wt);
    (f[num]||(f[num]=[])).push(v);
  }
  return f;
}
const pbs32=v=>v|0;
const pbF32=v=>{ const d=new DataView(new ArrayBuffer(4)); d.setUint32(0,v); return d.getFloat32(0); };
const pbStr=u=>new TextDecoder().decode(u);
const pb1=(f,k)=>f[k] ? f[k][0] : undefined;

// ---- protobuf: запись ----
function pbVarint(v){ const o=[]; v=v>>>0; while(v>0x7f){ o.push((v&0x7f)|0x80); v>>>=7; } o.push(v); return o; }
const pbTag=(n,wt)=>pbVarint((n<<3)|wt);
const pbWVar=(n,v)=>[...pbTag(n,0),...pbVarint(v)];
const pbWFix32=(n,v)=>[...pbTag(n,5),v&255,(v>>>8)&255,(v>>>16)&255,(v>>>24)&255];
const pbWLen=(n,b)=>[...pbTag(n,2),...pbVarint(b.length),...b];

// ---- разбор сообщений ----
function mshPosition(u){
  const f=pbRead(u), o={};
  if(f[1]) o.lat=pbs32(f[1][0])/1e7;
  if(f[2]) o.lon=pbs32(f[2][0])/1e7;
  if(f[3]) o.alt=pbs32(f[3][0]);
  if(f[4]) o.time=f[4][0];
  if(f[19]) o.sats=f[19][0];
  if(f[15]) o.speed=f[15][0];
  if(o.lat===0 && o.lon===0) { delete o.lat; delete o.lon; }
  return o;
}
function mshUser(u){
  const f=pbRead(u), o={};
  if(f[1]) o.id=pbStr(f[1][0]);
  if(f[2]) o.long=pbStr(f[2][0]);
  if(f[3]) o.short=pbStr(f[3][0]);
  if(f[5]) o.hw=f[5][0];
  return o;
}
function mshDevMetrics(u,o){
  const d=pbRead(u);
  if(d[1]) o.battery=d[1][0]; if(d[2]) o.voltage=pbF32(d[2][0]); if(d[3]) o.chUtil=pbF32(d[3][0]);
  if(d[4]) o.airUtil=pbF32(d[4][0]); if(d[5]) o.uptime=d[5][0];
  return o;
}
function mshTelemetry(u){
  const f=pbRead(u), o={};
  if(f[2]) mshDevMetrics(f[2][0],o);
  if(f[3]){ const e=pbRead(f[3][0]);
    if(e[1]) o.temp=pbF32(e[1][0]); if(e[2]) o.hum=pbF32(e[2][0]); if(e[3]) o.press=pbF32(e[3][0]); }
  return o;
}
function mshData(u){
  const f=pbRead(u), port=f[1] ? f[1][0] : 0, pl=f[2] ? f[2][0] : new Uint8Array(0), o={port,portName:MSH_PORTS[port]||('port '+port),payload:pl};
  try{
    if(port===1) o.text=pbStr(pl);
    else if(port===3) Object.assign(o,mshPosition(pl));
    else if(port===4){ const us=mshUser(pl); o.user=us; }
    else if(port===67) Object.assign(o,mshTelemetry(pl));
  }catch(e){ o.err=e.message; }
  if(f[6]) o.requestId=f[6][0];
  return o;
}
function mshPacket(u){
  const f=pbRead(u), o={from:f[1]?f[1][0]:0,to:f[2]?f[2][0]:0,channel:f[3]?f[3][0]:0,id:f[6]?f[6][0]:0};
  if(f[7]) o.rxTime=f[7][0];
  if(f[8]) o.snr=pbF32(f[8][0]);
  if(f[9]) o.hop=f[9][0];
  if(f[12]) o.rssi=pbs32(f[12][0]);
  if(f[4]) o.data=mshData(f[4][0]);
  else if(f[5]) o.encrypted=true;
  return o;
}
function mshNodeInfo(u){
  const f=pbRead(u), o={num:f[1]?f[1][0]:0};
  if(f[2]) o.user=mshUser(f[2][0]);
  if(f[3]) Object.assign(o,mshPosition(f[3][0]));
  if(f[4]) o.snr=pbF32(f[4][0]);
  if(f[5]) o.heard=f[5][0];
  if(f[6]) mshDevMetrics(f[6][0],o);
  return o;
}
// FromRadio → {kind:'packet'|'node'|'myinfo'|'complete'|'other', ...}
function mshFromRadio(b){
  const f=pbRead(b);
  if(f[2]) return {kind:'packet',pkt:mshPacket(f[2][0])};
  if(f[4]) return {kind:'node',node:mshNodeInfo(f[4][0])};
  if(f[3]){ const m=pbRead(f[3][0]); return {kind:'myinfo',num:m[1]?m[1][0]:0}; }
  if(f[7]) return {kind:'complete',id:f[7][0]};
  return {kind:'other'};
}

// ---- ToRadio ----
const mshWantConfig=id=>Uint8Array.from(pbWVar(3,id>>>0));
function mshTextPacket(text,to,channel,id){
  const data=[...pbWVar(1,1),...pbWLen(2,Array.from(new TextEncoder().encode(text)))];
  const pkt=[...pbWFix32(2,to>>>0),...(channel?pbWVar(3,channel):[]),...pbWLen(4,data),...pbWFix32(6,id>>>0)];
  return Uint8Array.from(pbWLen(1,pkt));
}
// «!a1b2c3d4», «a1b2c3d4», «0xA1B2C3D4», «^all» / пусто — всем
function mshParseNode(s){
  s=String(s||'').trim().toLowerCase();
  if(!s || s==='^all' || s==='all' || s==='broadcast') return MSH_BROADCAST;
  const h=s.replace(/^(!|0x)/,'');
  return /^[0-9a-f]{1,8}$/.test(h) ? parseInt(h,16)>>>0 : null;
}
const mshNodeId=n=>'!'+(n>>>0).toString(16).padStart(8,'0');

// ---- Serial: 0x94 0xC3 длина(2, BE) protobuf; остальное — текст отладки прошивки ----
function mshFrameWrap(payload){ return Uint8Array.from([0x94,0xC3,payload.length>>8,payload.length&255,...payload]); }
function mshFrameStream(){ return {buf:[],need:-1}; }
function mshFramePush(st,bytes){
  const out=[];
  for(const x of bytes){
    const b=st.buf;
    if(b.length===0){ if(x===0x94) b.push(x); continue; }
    if(b.length===1){ if(x===0xC3) b.push(x); else { b.length=0; if(x===0x94) b.push(x); } continue; }
    b.push(x);
    if(b.length===4){ st.need=(b[2]<<8)|b[3]; if(st.need>512){ b.length=0; st.need=-1; } }
    if(st.need>=0 && b.length===4+st.need){ out.push(Uint8Array.from(b.slice(4))); b.length=0; st.need=-1; }
  }
  return out;
}

// ---- AES (только шифрование — довольно для CTR: keystream = AES(key, счётчик) XOR данные), ключи 128 и 256 бит ----
const AES_SBOX=Uint8Array.from([
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
const AES_RCON=[0,0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36,0x6c,0xd8,0xab,0x4d];
function aesKeySchedule(key){                                     // key: 16 или 32 байта → {w, Nr}
  const Nk=key.length/4, Nr=Nk+6, Nb=4, w=[];
  for(let i=0;i<Nk;i++) w[i]=[key[4*i],key[4*i+1],key[4*i+2],key[4*i+3]];
  for(let i=Nk;i<Nb*(Nr+1);i++){
    let t=w[i-1].slice();
    if(i%Nk===0){ t=[AES_SBOX[t[1]],AES_SBOX[t[2]],AES_SBOX[t[3]],AES_SBOX[t[0]]]; t[0]^=AES_RCON[i/Nk]; }
    else if(Nk>6 && i%Nk===4) t=t.map(b=>AES_SBOX[b]);
    w[i]=w[i-Nk].map((b,j)=>b^t[j]);
  }
  return {w,Nr};
}
const gmul=(a,b)=>{ let p=0; for(let i=0;i<8;i++){ if(b&1) p^=a; const hi=a&0x80; a=(a<<1)&255; if(hi) a^=0x1b; b>>=1; } return p; };
function aesEncryptBlock(inp,sch){                                 // один блок (16 Б), состояние — столбцы state[r][c]
  const {w,Nr}=sch, s=[[],[],[],[]];
  for(let c=0;c<4;c++) for(let r=0;r<4;r++) s[r][c]=inp[r+4*c];
  const addRK=round=>{ for(let c=0;c<4;c++) for(let r=0;r<4;r++) s[r][c]^=w[round*4+c][r]; };
  const subShift=()=>{
    for(let r=0;r<4;r++) for(let c=0;c<4;c++) s[r][c]=AES_SBOX[s[r][c]];
    for(let r=1;r<4;r++){ const row=s[r].slice(); for(let c=0;c<4;c++) s[r][c]=row[(c+r)%4]; }
  };
  addRK(0);
  for(let round=1;round<Nr;round++){
    subShift();
    for(let c=0;c<4;c++){
      const a0=s[0][c],a1=s[1][c],a2=s[2][c],a3=s[3][c];
      s[0][c]=gmul(a0,2)^gmul(a1,3)^a2^a3; s[1][c]=a0^gmul(a1,2)^gmul(a2,3)^a3;
      s[2][c]=a0^a1^gmul(a2,2)^gmul(a3,3); s[3][c]=gmul(a0,3)^a1^a2^gmul(a3,2);
    }
    addRK(round);
  }
  subShift(); addRK(Nr);
  const out=new Uint8Array(16);
  for(let c=0;c<4;c++) for(let r=0;r<4;r++) out[r+4*c]=s[r][c];
  return out;
}
function aesCtrXor(data,key,nonce){                                // CTR: keystream = AES(ctr), ctr++ (128-бит, big-endian) на каждый блок
  const sch=aesKeySchedule(key), out=new Uint8Array(data.length), ctr=nonce.slice();
  for(let off=0;off<data.length;off+=16){
    const ks=aesEncryptBlock(ctr,sch), m=Math.min(16,data.length-off);
    for(let i=0;i<m;i++) out[off+i]=data[off+i]^ks[i];
    for(let i=15;i>=0;i--){ ctr[i]=(ctr[i]+1)&255; if(ctr[i]) break; }
  }
  return out;
}

// ---- Meshtastic в эфире: 16-байтный заголовок пакета (LE) + AES-CTR поверх Data, канал PSK ----
const MSH_DEFAULT_KEY=Uint8Array.of(0xd4,0xf1,0xbb,0x3a,0x20,0x29,0x07,0x59,0xf0,0xbc,0xff,0xab,0xcf,0x4e,0x69,0x37); // defaultpsk прошивки — ключ «публичных» каналов (LongFast и т.п.)
function mshPskBytes(b64){                                         // base64 → байты PSK; пусто/плохой base64 → 0 байт
  try{ const s=String(b64||'').trim(); if(!s) return new Uint8Array(0);
    const bin=atob(s), o=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) o[i]=bin.charCodeAt(i); return o;
  }catch(e){ return new Uint8Array(0); }
}
function mshExpandPsk(b){                                          // 0 Б — без шифрования (null), 1 Б — «простой» ключ от defaultpsk, 16/32 Б — ключ как есть
  if(!b || !b.length) return null;
  if(b.length===1) return b[0]===0 ? null : Uint8Array.from(MSH_DEFAULT_KEY,(v,i)=>i===15 ? (v+b[0]-1)&255 : v);
  if(b.length===16 || b.length===32) return b;
  return undefined;                                                // неподходящая длина — не ключ вообще
}
const mshNonce=(id,from)=>Uint8Array.of(id&255,(id>>>8)&255,(id>>>16)&255,(id>>>24)&255,0,0,0,0,from&255,(from>>>8)&255,(from>>>16)&255,(from>>>24)&255,0,0,0,0);
function mshAirHeader(b){                                          // 16 Б: dest, from, id (все LE u32), flags, channel hash, next hop, relay node
  if(b.length<16) return null;
  const u32=o=>(b[o]|b[o+1]<<8|b[o+2]<<16|b[o+3]<<24)>>>0, flags=b[12];
  return {dest:u32(0), from:u32(4), id:u32(8), hopLimit:flags&7, wantAck:!!(flags&8), viaMqtt:!!(flags&16), hopStart:(flags>>5)&7,
    channelHash:b[13], nextHop:b[14], relayNode:b[15], payload:b.subarray(16)};
}
// расшифровка пробует ключи по очереди (строка PSK в base64, через запятую; по умолчанию AQ== — публичный LongFast), годный protobuf с известным портом — признак верного ключа
function mshAirDecode(bytes,pskCsv){
  const h=mshAirHeader(bytes); if(!h) return null;
  const list=String(pskCsv==null ? 'AQ==' : pskCsv).split(',').map(s=>s.trim()).filter(Boolean);
  if(!list.length) list.push('AQ==');
  for(const b64 of list){
    const key=mshExpandPsk(mshPskBytes(b64));
    if(key===undefined) continue;                                  // плохая длина PSK
    try{
      const pt=key ? aesCtrXor(h.payload,key,mshNonce(h.id,h.from)) : h.payload;
      const d=mshData(pt);
      if(d.port!==undefined && MSH_PORTS[d.port]!==undefined) return {...h, data:d, psk:b64, plain:!key};
    }catch(e){}
  }
  return {...h, encrypted:true};
}

if(typeof module!=='undefined') module.exports={pbRead,pbVarint,mshFromRadio,mshWantConfig,mshTextPacket,mshParseNode,mshNodeId,mshFrameWrap,mshFrameStream,mshFramePush,MSH_BLE,MSH_BROADCAST,
  aesKeySchedule,aesEncryptBlock,aesCtrXor,mshPskBytes,mshExpandPsk,mshNonce,mshAirHeader,mshAirDecode,MSH_DEFAULT_KEY};
