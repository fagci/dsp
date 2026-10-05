"use strict";
/* ============================ Modbus: ядро ============================
   Master: запросы чтения 01 / 02 / 03 / 04 и записи 05 / 06, кадры RTU (адрес, PDU, CRC-16 младшим вперёд) и TCP (MBAP).
   Потоковые разборщики ответов и декодирование регистров (u16 / i16 / u32 / i32 / f32, порядок слов). Без DOM и сети. */

function mbCrc(b){
  let c=0xFFFF;
  for(let i=0;i<b.length;i++){ c^=b[i]; for(let k=0;k<8;k++) c=(c&1) ? (c>>1)^0xA001 : c>>1; }
  return c;
}
// PDU запроса: чтение (fc 1…4: адрес, количество) и запись одного (5: катушка, 6: регистр)
function mbPdu(fc,addr,arg){
  const p=new Uint8Array(5); p[0]=fc; p[1]=addr>>8; p[2]=addr&255;
  if(fc===5){ p[3]=arg ? 0xFF : 0; p[4]=0; }
  else { p[3]=(arg>>8)&255; p[4]=arg&255; }
  return p;
}
function mbRtuFrame(unit,pdu){
  const o=new Uint8Array(pdu.length+3); o[0]=unit; o.set(pdu,1);
  const c=mbCrc(o.subarray(0,pdu.length+1)); o[pdu.length+1]=c&255; o[pdu.length+2]=c>>8; return o;
}
function mbTcpFrame(tid,unit,pdu){
  const o=new Uint8Array(pdu.length+7), dv=new DataView(o.buffer);
  dv.setUint16(0,tid); dv.setUint16(2,0); dv.setUint16(4,pdu.length+1); o[6]=unit; o.set(pdu,7); return o;
}
// ответ: PDU → {fc, exc} | {fc, bytes} | {fc, addr, val}
function mbPduParse(pdu){
  const fc=pdu[0];
  if(fc&0x80) return {fc:fc&0x7F,exc:pdu[1]};
  if(fc>=1 && fc<=4) return pdu.length>=2+pdu[1] ? {fc,bytes:pdu.subarray(2,2+pdu[1])} : null;
  if(fc===5 || fc===6) return pdu.length>=5 ? {fc,addr:(pdu[1]<<8)|pdu[2],val:(pdu[3]<<8)|pdu[4]} : null;
  return null;
}
const MB_EXC={1:'illegal function',2:'illegal data address',3:'illegal data value',4:'device failure',5:'acknowledge',6:'device busy',8:'memory parity error',10:'gateway path unavailable',11:'gateway target failed to respond'};
// поток RTU → кадры {unit, pdu}. Длина — по коду функции; кадр принимается только с верным CRC. Начало ищется с любого смещения:
// мусор перед кадром может выглядеть как заголовок длинного кадра, и ждать его недостающие байты нельзя
class MbRtuParser{
  constructor(){ this.buf=[]; }
  push(bytes){
    for(const x of bytes) this.buf.push(x);
    const out=[], b=this.buf;
    for(;;){
      let hit=false;
      for(let s=0;s+5<=b.length;s++){
        const fc=b[s+1]; let len;
        if(fc&0x80) len=5; else if(fc>=1 && fc<=4) len=3+b[s+2]+2; else if(fc===5 || fc===6) len=8; else continue;
        if(s+len>b.length) continue;
        const f=Uint8Array.from(b.slice(s,s+len)), c=mbCrc(f.subarray(0,len-2));
        if((c&255)===f[len-2] && (c>>8)===f[len-1]){ out.push({unit:f[0],pdu:f.subarray(1,len-2)}); b.splice(0,s+len); hit=true; break; }
      }
      if(!hit) break;
    }
    if(b.length>600) b.splice(0,b.length-8);
    return out;
  }
}
// поток MBAP → кадры {tid, unit, pdu}
class MbTcpParser{
  constructor(){ this.buf=[]; }
  push(bytes){
    for(const x of bytes) this.buf.push(x);
    const out=[];
    for(;;){
      const b=this.buf; if(b.length<8) break;
      const proto=(b[2]<<8)|b[3], len=(b[4]<<8)|b[5];
      if(proto!==0 || len<2 || len>254){ b.shift(); continue; }
      if(b.length<6+len) break;
      out.push({tid:(b[0]<<8)|b[1],unit:b[6],pdu:Uint8Array.from(b.slice(7,6+len))}); b.splice(0,6+len);
    }
    if(this.buf.length>600) this.buf=[];
    return out;
  }
}
// регистры (массив uint16) → значения; wlo: слово с меньшим адресом — младшее (CD AB)
function mbDecodeRegs(regs,type,wlo){
  const o=[], sz=(type==='u32' || type==='i32' || type==='f32') ? 2 : 1;
  for(let i=0;i+sz<=regs.length;i+=sz){
    if(sz===1){ o.push(type==='i16' ? (regs[i]<<16)>>16 : regs[i]); continue; }
    const hi=wlo ? regs[i+1] : regs[i], lo=wlo ? regs[i] : regs[i+1], u=((hi<<16)|lo)>>>0;
    o.push(type==='u32' ? u : type==='i32' ? u|0 : new Float32Array(Uint32Array.of(u).buffer)[0]);
  }
  return o;
}
function mbEncodeValue(v,type,wlo){                              // значение → регистры для записи (только 16 бит поддерживаются узлом)
  const x=Math.round(v); return [type==='i16' ? (x&0xFFFF) : Math.max(0,Math.min(65535,x))];
}
const mbBits=(bytes,n)=>{ const o=[]; for(let i=0;i<n;i++) o.push((bytes[i>>3]>>(i&7))&1); return o; };
const mbRegs=bytes=>{ const o=[]; for(let i=0;i+1<bytes.length;i+=2) o.push((bytes[i]<<8)|bytes[i+1]); return o; };
