"use strict";
/* Open Drone ID (Remote ID), ASTM F3411 / ASD-STAN prEN 4709-002: разбор 25-байтных сообщений и Message Pack.
   Транспорт (Wi-Fi beacon / NAN, BLE) снимает прошивка, сюда приходят байты сообщений. Числа — little endian. */

const ODID_UA=['none','aeroplane','multirotor','gyroplane','hybrid lift','ornithopter','glider','kite','free balloon','captive balloon','airship','parachute','rocket','tethered','ground obstacle','other'];
const ODID_IDTYPE=['none','serial','CAA registration','UTM UUID','session ID'];
const ODID_STATUS=['undeclared','ground','airborne','emergency','system failure'];
const ODID_OPLOC=['takeoff','dynamic','fixed'];
const ODID_EPOCH=1546300800;                          // 2019-01-01 00:00:00 UTC, отсчёт времени System

const odidU16=(b,o)=>b[o]|b[o+1]<<8;
const odidI32=(b,o)=>b[o]|b[o+1]<<8|b[o+2]<<16|b[o+3]<<24;
const odidStr=(b,o,n)=>{ let s=''; for(let i=o;i<o+n;i++){ if(!b[i]) break; s+=String.fromCharCode(b[i]); } return s.trim(); };
const odidAlt=v=>v===0 ? null : v*0.5-1000;           // 0 — неизвестно
const odidCoord=(la,lo)=>(la===0 && lo===0) ? null : {lat:la/1e7, lon:lo/1e7};

// одно сообщение: b — байты, o — смещение; null, если заголовок не похож на ODID
function odidMessage(b,o=0){
  if(b.length<o+25) return null;
  const type=b[o]>>4, ver=b[o]&15, m={type, ver};
  switch(type){
    case 0:
      m.kind='basic'; m.idType=b[o+1]>>4; m.uaType=b[o+1]&15;
      m.idTypeName=ODID_IDTYPE[m.idType]||'?'; m.uaName=ODID_UA[m.uaType]||'?'; m.id=odidStr(b,o+2,20);
      if(!m.id && !m.idType) return null; break;               // нулевой кадр — мусор
    case 1: {
      m.kind='location';
      const f=b[o+1]; m.status=f>>4; m.statusName=ODID_STATUS[m.status]||'?';
      m.heightRef=(f>>2)&1 ? 'ground' : 'takeoff';
      const ew=(f>>1)&1, mult=f&1, d=b[o+2]+(ew?180:0);
      m.dir=d>359 ? null : d;
      m.speed=b[o+3]===255 ? null : (mult ? b[o+3]*0.75+255*0.25 : b[o+3]*0.25);
      const vs=b[o+4]>127 ? b[o+4]-256 : b[o+4];
      m.vspeed=vs===63 ? null : vs*0.5;
      const c=odidCoord(odidI32(b,o+5),odidI32(b,o+9)); m.lat=c?c.lat:null; m.lon=c?c.lon:null;
      m.altBaro=odidAlt(odidU16(b,o+13)); m.altGeo=odidAlt(odidU16(b,o+15)); m.height=odidAlt(odidU16(b,o+17));
      m.ts=odidU16(b,o+21)===0xFFFF ? null : odidU16(b,o+21)/10;    // с начала часа
      break; }
    case 2:
      m.kind='auth'; m.authType=b[o+1]>>4; m.page=b[o+1]&15; break;
    case 3:
      m.kind='selfid'; m.descType=b[o+1]; m.text=odidStr(b,o+2,23); break;
    case 4: {
      m.kind='system'; m.opLocType=b[o+1]&3; m.opLocName=ODID_OPLOC[m.opLocType]||'?';
      const c=odidCoord(odidI32(b,o+2),odidI32(b,o+6)); m.opLat=c?c.lat:null; m.opLon=c?c.lon:null;
      m.areaCount=odidU16(b,o+10); m.areaRadius=b[o+12]*10;
      m.areaCeil=odidAlt(odidU16(b,o+13)); m.areaFloor=odidAlt(odidU16(b,o+15));
      m.category=b[o+17]>>4; m.class=b[o+17]&15; m.opAlt=odidAlt(odidU16(b,o+18));
      const t=odidI32(b,o+20)>>>0; m.time=t ? (ODID_EPOCH+t)*1000 : null;
      break; }
    case 5:
      m.kind='operator'; m.opIdType=b[o+1]; m.id=odidStr(b,o+2,20); break;
    default: return null;
  }
  return m;
}

// кадр: Message Pack (0xF), одиночное сообщение или то же со счётчиком впереди (BLE / Wi-Fi vendor IE)
function odidParse(b){
  const out=[];
  const pack=o=>{
    if(b.length<o+3 || b[o]>>4!==0xF || b[o+1]!==25) return false;
    const cnt=Math.min(b[o+2],9);
    for(let i=0;i<cnt;i++){ const m=odidMessage(b,o+3+i*25); if(m) out.push(m); }
    return out.length>0;
  };
  const single=o=>{ const m=b[o]>>4<=5 && (b[o]&15)<=2 ? odidMessage(b,o) : null; if(m) out.push(m); return !!m; };
  if(pack(0) || pack(1)) return out;
  single(b.length%25===1 ? 1 : 0);
  return out;
}

function odidHex(s){
  const h=String(s).replace(/[^0-9a-f]/gi,'');
  const b=new Uint8Array(h.length>>1);
  for(let i=0;i<b.length;i++) b[i]=parseInt(h.substr(i*2,2),16);
  return b;
}

// строка прошивки: "ODID,<wifi|ble>,<rssi>,<mac>,<hex>"; голая hex-строка тоже годится
function odidLine(line){
  const t=String(line).trim(); if(!t) return null;
  const p=t.split(',');
  if(p[0]==='ODID' && p.length>=5) return {transport:p[1], rssi:+p[2], mac:p[3].toLowerCase(), msgs:odidParse(odidHex(p.slice(4).join('')))};
  if(/^[0-9a-f\s:]{50,}$/i.test(t)) return {transport:null, rssi:null, mac:'', msgs:odidParse(odidHex(t))};
  return null;
}

/* ---------- сборка (зеркало odidMessage / odidParse) ---------- */
const ODID_KIND={basic:0, location:1, auth:2, selfid:3, system:4, operator:5};
const odidPutStr=(b,o,n,s)=>{ s=String(s==null ? '' : s); for(let i=0;i<n && i<s.length;i++) b[o+i]=s.charCodeAt(i)&255; };
const odidPutI32=(b,o,v)=>{ v=Math.round(v)|0; b[o]=v&255; b[o+1]=(v>>8)&255; b[o+2]=(v>>16)&255; b[o+3]=(v>>24)&255; };
const odidPutU16=(b,o,v)=>{ v=Math.max(0,Math.min(65535,Math.round(v))); b[o]=v&255; b[o+1]=v>>8; };
const odidPutAlt=(b,o,v)=>odidPutU16(b,o,v==null ? 0 : Math.max(1,(v+1000)*2));    // 0 — неизвестно
const odidPutLL=(b,o,lat,lon)=>{ if(lat==null || lon==null){ odidPutI32(b,o,0); odidPutI32(b,o+4,0); } else { odidPutI32(b,o,lat*1e7); odidPutI32(b,o+4,lon*1e7); } };
// m — те же поля, что даёт odidMessage (kind, ver, idType/uaType, lat, lon, …) → 25 байт
function odidBuild(m){
  const type=ODID_KIND[m.kind]; if(type===undefined) throw new Error('unknown ODID message kind: '+m.kind);
  const b=new Uint8Array(25); b[0]=(type<<4)|((m.ver==null ? 2 : m.ver)&15);
  switch(type){
    case 0: b[1]=((m.idType||0)<<4)|((m.uaType||0)&15); odidPutStr(b,2,20,m.id); break;
    case 1: {
      const dir=m.dir==null ? 361 : ((m.dir%360)+360)%360, ew=dir>=180 ? 1 : 0;
      const sp=m.speed, mult=sp!=null && sp>63.75 ? 1 : 0;
      b[1]=((m.status||0)<<4)|(m.heightRef==='ground' ? 4 : 0)|(ew<<1)|mult;
      b[2]=Math.round(dir-(ew ? 180 : 0)) & 255;
      b[3]=sp==null ? 255 : Math.min(254,Math.round(mult ? (sp-63.75)/0.75 : sp/0.25));
      b[4]=m.vspeed==null ? 63 : Math.round(m.vspeed/0.5)&255;
      odidPutLL(b,5,m.lat,m.lon);
      odidPutAlt(b,13,m.altBaro); odidPutAlt(b,15,m.altGeo); odidPutAlt(b,17,m.height);
      odidPutU16(b,21,m.ts==null ? 0xFFFF : m.ts*10);
      break; }
    case 2: b[1]=((m.authType||0)<<4)|((m.page||0)&15); break;
    case 3: b[1]=m.descType||0; odidPutStr(b,2,23,m.text); break;
    case 4:
      b[1]=(m.opLocType||0)&3; odidPutLL(b,2,m.opLat,m.opLon);
      odidPutU16(b,10,m.areaCount==null ? 1 : m.areaCount); b[12]=Math.min(255,Math.round((m.areaRadius||0)/10));
      odidPutAlt(b,13,m.areaCeil); odidPutAlt(b,15,m.areaFloor);
      b[17]=((m.category||0)<<4)|((m.class||0)&15); odidPutAlt(b,18,m.opAlt);
      odidPutI32(b,20,m.time ? Math.round(m.time/1000)-ODID_EPOCH : 0);
      break;
    case 5: b[1]=m.opIdType||0; odidPutStr(b,2,20,m.id); break;
  }
  return b;
}
// список сообщений → Message Pack (0xF), до 9 штук
function odidPack(msgs){
  const n=Math.min(msgs.length,9), b=new Uint8Array(3+25*n); b[0]=0xF2; b[1]=25; b[2]=n;
  for(let i=0;i<n;i++) b.set(odidBuild(msgs[i]),3+i*25);
  return b;
}
