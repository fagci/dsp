"use strict";
/* ============================ RNode (KISS) и Reticulum: ядро ============================
   Команды и форматы — по RNode_Firmware (Framing.h) и RNS/Interfaces/RNodeInterface.py, пакеты — по RNS/Packet.py,
   Identity.py и Destination.py. Разбор Reticulum пассивный: заголовок и announce; содержимое обычных пакетов
   зашифровано, подпись announce не проверяется. Узел и транспорт — rnode.js. */

const RN={FEND:0xC0,FESC:0xDB,TFEND:0xDC,TFESC:0xDD,DATA:0x00,FREQ:0x01,BW:0x02,TXP:0x03,SF:0x04,CR:0x05,STATE:0x06,LOCK:0x07,DETECT:0x08,
  READY:0x0F,STAT_RX:0x21,STAT_TX:0x22,RSSI:0x23,SNR:0x24,CHTM:0x25,BAT:0x27,TEMP:0x29,PLATFORM:0x48,MCU:0x49,FW:0x50,ERROR:0x90,
  DETECT_REQ:0x73,DETECT_RESP:0x46,RSSI_OFFSET:157};
const RN_ERRORS={1:'radio init failed',2:'transmit failed',3:'EEPROM locked',4:'queue full',5:'memory low',6:'modem timeout'};
const RN_PLATFORMS={0x90:'AVR',0x80:'ESP32',0x70:'NRF52'};

function kissEscape(b){ const o=[]; for(const x of b){ if(x===RN.FEND) o.push(RN.FESC,RN.TFEND); else if(x===RN.FESC) o.push(RN.FESC,RN.TFESC); else o.push(x); } return o; }
const kissFrame=(cmd,data)=>Uint8Array.from([RN.FEND,cmd,...kissEscape(data||[]),RN.FEND]);
const be32=v=>[(v>>>24)&255,(v>>>16)&255,(v>>>8)&255,v&255];

// ---- команды хосту → RNode ----
const rnDetect=()=>Uint8Array.from([...kissFrame(RN.DETECT,[RN.DETECT_REQ]),...kissFrame(RN.FW,[0]),...kissFrame(RN.PLATFORM,[0]),...kissFrame(RN.MCU,[0])]);
// частота и полоса в Гц, как в RNodeInterface.initRadio; радио включается последним
function rnConfig(c){
  return [kissFrame(RN.FREQ,be32(Math.round(c.freq))),kissFrame(RN.BW,be32(Math.round(c.bw))),kissFrame(RN.TXP,[c.txp&255]),
    kissFrame(RN.SF,[c.sf&255]),kissFrame(RN.CR,[c.cr&255]),kissFrame(RN.STATE,[c.on===false?0:1])];
}
const rnData=b=>kissFrame(RN.DATA,b);

// ---- поток KISS от RNode → кадры {cmd, data} ----
function rnStream(){ return {inF:false,esc:false,cmd:-1,buf:[]}; }
function rnPush(st,bytes){
  const out=[];
  for(const x of bytes){
    if(x===RN.FEND){
      if(st.inF && st.cmd>=0) out.push({cmd:st.cmd,data:Uint8Array.from(st.buf)});
      st.inF=true; st.esc=false; st.cmd=-1; st.buf=[]; continue;
    }
    if(!st.inF) continue;
    if(st.cmd<0){ st.cmd=x; continue; }
    let v=x;
    if(st.esc){ v=x===RN.TFEND ? RN.FEND : x===RN.TFESC ? RN.FESC : x; st.esc=false; }
    else if(x===RN.FESC){ st.esc=true; continue; }
    if(st.buf.length<600) st.buf.push(v);
  }
  return out;
}
const rnU32=d=>d.length>=4 ? ((d[0]<<24)|(d[1]<<16)|(d[2]<<8)|d[3])>>>0 : null;
// кадр → поле состояния {…} или {data}/{err}; RSSI и SNR прилетают отдельными кадрами перед кадром данных
function rnEvent(f){
  const d=f.data;
  switch(f.cmd){
    case RN.DATA: return {data:d};
    case RN.RSSI: return d.length ? {rssi:d[0]-RN.RSSI_OFFSET} : {};
    case RN.SNR: return d.length ? {snr:((d[0]<<24)>>24)*0.25} : {};
    case RN.FREQ: return {freq:rnU32(d)};
    case RN.BW: return {bw:rnU32(d)};
    case RN.TXP: return d.length ? {txp:d[0]} : {};
    case RN.SF: return d.length ? {sf:d[0]} : {};
    case RN.CR: return d.length ? {cr:d[0]} : {};
    case RN.STATE: return d.length ? {on:d[0]===1} : {};
    case RN.FW: return d.length>=2 ? {fw:d[0]+'.'+d[1]} : {};
    case RN.PLATFORM: return d.length ? {platform:RN_PLATFORMS[d[0]]||('0x'+d[0].toString(16))} : {};
    case RN.DETECT: return {detected:d[0]===RN.DETECT_RESP};
    case RN.BAT: return d.length>=2 ? {battery:Math.min(100,d[1]),batState:d[0]} : {};
    case RN.TEMP: return d.length ? (d[0]-120>=-30 && d[0]-120<=90 ? {temp:d[0]-120} : {}) : {};
    case RN.CHTM: return d.length>=11 ? {airShort:(d[0]<<8|d[1])/100,airLong:(d[2]<<8|d[3])/100,loadShort:(d[4]<<8|d[5])/100,loadLong:(d[6]<<8|d[7])/100,
      chRssi:d[8]-RN.RSSI_OFFSET,noise:d[9]-RN.RSSI_OFFSET} : {};
    case RN.STAT_RX: return {rxBytes:rnU32(d)};
    case RN.STAT_TX: return {txBytes:rnU32(d)};
    case RN.ERROR: return {err:RN_ERRORS[d[0]]||('error '+d[0])};
    default: return {};
  }
}

// ---- Reticulum: заголовок пакета ----
const RNS_PTYPES=['data','announce','linkrequest','proof'];
const RNS_DTYPES=['single','group','plain','link'];
const RNS_CONTEXTS={0:'none',1:'resource',2:'resource adv',3:'resource req',4:'resource hmu',5:'resource proof',6:'resource icl',7:'resource rcl',8:'cache request',
  9:'request',10:'response',11:'path response',12:'command',13:'command status',14:'channel',0xFA:'keepalive',0xFB:'link identify',0xFC:'link close',
  0xFD:'link proof',0xFE:'link rtt',0xFF:'link request proof'};
const RNS_HASH=16, RNS_NAMEHASH=10, RNS_KEY=64, RNS_SIG=64, RNS_RATCHET=32;
const rnsHex=(b,a,e)=>Array.from(b.subarray(a,e),x=>x.toString(16).padStart(2,'0')).join('');
function rnsParse(b){
  if(b.length<2+RNS_HASH+1) return null;
  const fl=b[0], o={ifac:!!(fl&0x80),headerType:(fl>>6)&1,ctxFlag:(fl>>5)&1,transport:(fl>>4)&1,destType:(fl>>2)&3,packetType:fl&3,hops:b[1]};
  o.typeName=RNS_PTYPES[o.packetType]; o.destName=RNS_DTYPES[o.destType];
  if(o.ifac) return o;                                         // с IFAC после заголовка идёт защита интерфейса — состав не разобрать
  let i=2;
  if(o.headerType===1){ if(b.length<2+2*RNS_HASH+1) return null; o.transportId=rnsHex(b,2,2+RNS_HASH); i=2+RNS_HASH; }
  o.dest=rnsHex(b,i,i+RNS_HASH); i+=RNS_HASH;
  o.context=b[i++]; o.contextName=RNS_CONTEXTS[o.context]||('0x'+o.context.toString(16));
  o.data=b.subarray(i);
  return o;
}

// имена назначений по их name_hash (SHA-256 имени, первые 10 байт)
const RNS_NAMES={'6ec60bc318e2c0f0d908':'lxmf.delivery','e03a09b77ac21b22258e':'lxmf.propagation','213e6311bcec54ab4fde':'nomadnetwork.node',
  '4848a053c16415bed6c8':'rnstransport.remote.management','8e702e333a40d4b1ffd9':'rnstransport.probes'};

// минимальный msgpack: хватает для app_data LXMF (массив [имя, стоимость штампа])
function mpRead(b,s){
  if(s.i>=b.length) throw new Error('eof');
  const t=b[s.i++], take=n=>{ if(s.i+n>b.length) throw new Error('eof'); const r=b.subarray(s.i,s.i+n); s.i+=n; return r; };
  const str=n=>new TextDecoder().decode(take(n));
  if(t<=0x7f) return t; if(t>=0xe0) return t-256;
  if(t>=0xa0 && t<=0xbf) return str(t&31);
  if(t>=0x90 && t<=0x9f){ const a=[]; for(let k=t&15;k>0;k--) a.push(mpRead(b,s)); return a; }
  switch(t){
    case 0xc0: return null; case 0xc2: return false; case 0xc3: return true;
    case 0xc4: case 0xd9: return str(take(1)[0]);              // bin8 и str8 показываем текстом: имена приходят байтами
    case 0xc5: case 0xda: { const l=take(2); return str((l[0]<<8)|l[1]); }
    case 0xcc: return take(1)[0];
    case 0xcd: { const v=take(2); return (v[0]<<8)|v[1]; }
    case 0xce: { const v=take(4); return ((v[0]<<24)|(v[1]<<16)|(v[2]<<8)|v[3])>>>0; }
    case 0xdc: { const l=take(2); const a=[]; for(let k=(l[0]<<8)|l[1];k>0;k--) a.push(mpRead(b,s)); return a; }
  }
  throw new Error('msgpack 0x'+t.toString(16));
}
// announce: ключ(64) | name_hash(10) | random(10; последние 5 — время, с, BE) | [ratchet(32), если ctxFlag] | подпись(64) | app_data
function rnsAnnounce(p){
  if(!p || p.packetType!==1 || !p.data) return null;
  const d=p.data, need=RNS_KEY+RNS_NAMEHASH+10+(p.ctxFlag?RNS_RATCHET:0)+RNS_SIG;
  if(d.length<need) return null;
  let i=RNS_KEY;
  const nameHash=rnsHex(d,i,i+RNS_NAMEHASH); i+=RNS_NAMEHASH;
  const time=d[i+5]*4294967296+(((d[i+6]<<24)|(d[i+7]<<16)|(d[i+8]<<8)|d[i+9])>>>0); i+=10;
  if(p.ctxFlag) i+=RNS_RATCHET;
  i+=RNS_SIG;
  const app=d.subarray(i);
  const o={dest:p.dest,nameHash,name:RNS_NAMES[nameHash]||null,time,ratchet:!!p.ctxFlag,appDataHex:rnsHex(app,0,app.length)};
  if(app.length){
    if(o.name==='lxmf.delivery'){ try{ const v=mpRead(app,{i:0}); if(Array.isArray(v) && typeof v[0]==='string') o.appName=v[0]; }catch(e){} }
    else if(o.name==='nomadnetwork.node' || o.name==='lxmf.propagation'){ const s=new TextDecoder().decode(app); if(/^[\x20-\x7e -￿]+$/.test(s)) o.appName=s; }
  }
  return o;
}

if(typeof module!=='undefined') module.exports={RN,kissFrame,rnDetect,rnConfig,rnData,rnStream,rnPush,rnEvent,rnsParse,rnsAnnounce,mpRead};
