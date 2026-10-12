"use strict";
/* ============================ Web Bluetooth: ядро ============================
   UUID, разбор значений характеристик, строки и нарезка записи. Узлы и работа с браузерным API — ble.js. */

// Web Bluetooth принимает число (16 бит), строку 128 бит в нижнем регистре или имя («heart_rate»)
function bleUuid(s){
  s=String(s||'').trim().toLowerCase();
  if(/^0x[0-9a-f]{1,8}$/.test(s)) return parseInt(s,16);
  if(/^[0-9a-f]{4}$/.test(s)) return parseInt(s,16);
  return s;
}
const BLE_PROFILES={
  'Nordic UART':{svc:'6e400001-b5a3-f393-e0a9-e50e24dcca9e',rx:'6e400003-b5a3-f393-e0a9-e50e24dcca9e',tx:'6e400002-b5a3-f393-e0a9-e50e24dcca9e'},   // rx — уведомления от устройства, tx — запись в него
  'HM-10 / FFE0':{svc:'ffe0',rx:'ffe1',tx:'ffe1'}
};
const BLE_FORMATS=['uint8','int8','uint16 LE','int16 LE','uint32 LE','int32 LE','float32 LE','heart rate (bpm)','battery %','temperature (°C)','hex only'];
const bleHex=dv=>Array.from(new Uint8Array(dv.buffer,dv.byteOffset,dv.byteLength),b=>b.toString(16).padStart(2,'0')).join(' ');
function bleDecode(dv,fmt){
  const n=dv.byteLength, ok=k=>n>=k;
  let v=null;
  switch(fmt){
    case 'uint8': case 'battery %': if(ok(1)) v=dv.getUint8(0); break;
    case 'int8': if(ok(1)) v=dv.getInt8(0); break;
    case 'uint16 LE': if(ok(2)) v=dv.getUint16(0,true); break;
    case 'int16 LE': if(ok(2)) v=dv.getInt16(0,true); break;
    case 'uint32 LE': if(ok(4)) v=dv.getUint32(0,true); break;
    case 'int32 LE': if(ok(4)) v=dv.getInt32(0,true); break;
    case 'float32 LE': if(ok(4)) v=dv.getFloat32(0,true); break;
    case 'heart rate (bpm)':                                   // 0x2A37: флаги, затем пульс uint8 или uint16 (бит 0)
      if(ok(2)) v=(dv.getUint8(0)&1) ? (ok(3) ? dv.getUint16(1,true) : null) : dv.getUint8(1); break;
    case 'temperature (°C)':                                   // 0x2A1C / 0x2A6E-подобные: флаги (бит 0 — °F) + FLOAT-32 IEEE-11073
      if(ok(5)){ const u=dv.getUint32(1,true); let m=u&0xFFFFFF; if(m&0x800000) m-=0x1000000;
        const e=(u>>>24)<<24>>24; v=m*Math.pow(10,e); if(dv.getUint8(0)&1) v=(v-32)/1.8; } break;
  }
  return {value:v!==null && Number.isFinite(v) ? v : null, hex:bleHex(dv)};
}
// «48 65 6c», «0x48,0x65», «4865»
function bleParseHex(s){
  const t=String(s||'').replace(/0x/ig,' ').replace(/[^0-9a-f]/ig,' ').trim();
  if(!t) return null;
  const parts=t.split(/\s+/);
  const flat=parts.length===1 && parts[0].length>2 ? parts[0].match(/.{1,2}/g) : parts;
  if(flat.some(p=>p.length>2)) return null;
  return Uint8Array.from(flat.map(p=>parseInt(p,16)));
}
const bleChunks=(b,size)=>{ const o=[]; for(let i=0;i<b.length;i+=size) o.push(b.slice(i,i+size)); return o; };
// поток текста → строки по \n; недописанный хвост остаётся в acc
function bleLines(acc,chunk){
  const s=acc+chunk, parts=s.split(/\r?\n/);
  return {rest:parts.pop().slice(-4096),lines:parts.map(l=>l.trim()).filter(Boolean)};
}

if(typeof module!=='undefined') module.exports={bleUuid,bleDecode,bleParseHex,bleChunks,bleLines,bleHex,BLE_PROFILES,BLE_FORMATS};

// событие рекламы Web Bluetooth → структуры AD (длина, тип, данные): имя, TX power, данные производителя и служб;
// сырых байт пакета API не даёт, поэтому AD собираются заново — для HEX Structure (схема ble-adv)
function bleAdBytes(e){
  const out=[], u8=dv=>Array.from(new Uint8Array(dv.buffer,dv.byteOffset,dv.byteLength));
  const ad=(type,b)=>{ out.push(b.length+1,type,...b); };
  if(e.name) ad(0x09,Array.from(typeof TextEncoder!=='undefined' ? new TextEncoder().encode(e.name) : Array.from(e.name,c=>c.charCodeAt(0)&255)).slice(0,29));
  if(typeof e.txPower==='number') ad(0x0A,[e.txPower&255]);
  if(e.manufacturerData) for(const [id,dv] of e.manufacturerData) ad(0xFF,[id&255,(id>>8)&255,...u8(dv)]);
  if(e.serviceData) for(const [uuid,dv] of e.serviceData){
    const u=String(uuid).toLowerCase(), m=/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(u);
    if(m){ const v=parseInt(m[1],16); ad(0x16,[v&255,v>>8,...u8(dv)]); }
    else if(/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(u)){
      const h=u.replace(/-/g,''), b=[]; for(let i=30;i>=0;i-=2) b.push(parseInt(h.substr(i,2),16)); ad(0x21,[...b,...u8(dv)]); }
  }
  return Uint8Array.from(out);
}
