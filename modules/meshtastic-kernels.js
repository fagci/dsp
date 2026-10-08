"use strict";
/* ============================ Meshtastic: ядро ============================
   Минимальный protobuf (чтение и запись), разбор FromRadio / MeshPacket / Data и сборка ToRadio.
   Говорим с нодой по её клиентскому API (BLE или Serial), радио-уровень и шифрование остаются на ноде.
   Номера полей — по meshtastic/protobufs (mesh.proto, portnums.proto, telemetry.proto). Узлы и транспорт — meshtastic.js. */

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

if(typeof module!=='undefined') module.exports={pbRead,pbVarint,mshFromRadio,mshWantConfig,mshTextPacket,mshParseNode,mshNodeId,mshFrameWrap,mshFrameStream,mshFramePush,MSH_BLE,MSH_BROADCAST};
