"use strict";
/* Телеметрия дронов из байтового потока: MAVLink v1/v2, CRSF, MSP v1/v2 (ответы), LTM. Все разборщики идут по одному потоку
   параллельно, кадр принимается только с верной контрольной суммой. Результат — состояние telemApply: lat, lon, alt, hdg, pitch, roll… */

const TLM_CRC_EXTRA={0:50, 1:124, 24:24, 30:39, 33:104, 74:20};          // MAVLink crc_extra известных сообщений
const TLM_MAV_LEN={0:9, 1:31, 24:30, 30:28, 33:28, 74:20};                // длина полезной нагрузки (v2 режет нули в конце)

function tlmCrcX25(b,from,to,extra){
  let c=0xFFFF;
  const add=x=>{ let t=(x^(c&255))&255; t=(t^(t<<4))&255; c=((c>>8)^(t<<8)^(t<<3)^(t>>4))&0xFFFF; };
  for(let i=from;i<to;i++) add(b[i]);
  if(extra!=null) add(extra);
  return c;
}
function tlmCrc8(b,from,to){                                              // CRC-8 DVB-S2, полином 0xD5
  let c=0;
  for(let i=from;i<to;i++){ c^=b[i]; for(let k=0;k<8;k++) c=(c&0x80) ? ((c<<1)^0xD5)&255 : (c<<1)&255; }
  return c;
}
const tlmI16=(b,o)=>(b[o]|b[o+1]<<8)<<16>>16, tlmU16=(b,o)=>b[o]|b[o+1]<<8;
const tlmI32=(b,o)=>b[o]|b[o+1]<<8|b[o+2]<<16|b[o+3]<<24;
const tlmBI16=(b,o)=>(b[o]<<8|b[o+1])<<16>>16, tlmBU16=(b,o)=>b[o]<<8|b[o+1];
const tlmBI32=(b,o)=>b[o]<<24|b[o+1]<<16|b[o+2]<<8|b[o+3];
const tlmF32=(b,o)=>new DataView(b.buffer,b.byteOffset+o,4).getFloat32(0,true);

// каждый extract: байты → {msgs, used} (used — сколько байт можно выбросить из начала буфера)
function tlmMavlink(b){
  const msgs=[]; let i=0;
  while(i<b.length){
    const s=b[i];
    if(s===0xFE){
      if(b.length-i<8) break;
      const len=b[i+1], tot=len+8;
      if(b.length-i<tot) break;
      const id=b[i+5], ex=TLM_CRC_EXTRA[id];
      if(ex!=null && tlmCrcX25(b,i+1,i+6+len,ex)===tlmU16(b,i+6+len)){ msgs.push({proto:'MAVLink',id,payload:b.slice(i+6,i+6+len)}); i+=tot; } else i++;
    } else if(s===0xFD){
      if(b.length-i<12) break;
      const len=b[i+1], tot=len+12+((b[i+2]&1)?13:0);
      if(b.length-i<tot) break;
      const id=b[i+7]|b[i+8]<<8|b[i+9]<<16, ex=TLM_CRC_EXTRA[id];
      if(ex!=null && tlmCrcX25(b,i+1,i+10+len,ex)===tlmU16(b,i+10+len)){
        const p=new Uint8Array(Math.max(len,TLM_MAV_LEN[id]||0)); p.set(b.subarray(i+10,i+10+len));   // v2: нули в конце отрезаны
        msgs.push({proto:'MAVLink',id,payload:p}); i+=tot;
      } else i++;
    } else i++;
  }
  return {msgs, used:i};
}
function tlmCrsf(b){
  const msgs=[]; let i=0;
  while(i<b.length){
    const a=b[i];
    if(a!==0xC8 && a!==0xEA && a!==0xEC && a!==0xEE){ i++; continue; }
    if(b.length-i<4) break;
    const len=b[i+1];
    if(len<2 || len>62){ i++; continue; }
    if(b.length-i<len+2) break;
    if(tlmCrc8(b,i+2,i+1+len)===b[i+1+len]){ msgs.push({proto:'CRSF',id:b[i+2],payload:b.slice(i+3,i+1+len)}); i+=len+2; } else i++;
  }
  return {msgs, used:i};
}
function tlmMsp(b){
  const msgs=[]; let i=0;
  while(i<b.length){
    if(b[i]!==0x24){ i++; continue; }
    if(b.length-i<3) break;
    const v=b[i+1];
    if(v===0x4D){                                                          // '$M>' размер, команда, данные, XOR
      if(b.length-i<6) break;
      const sz=b[i+3], tot=sz+6;
      if(b.length-i<tot) break;
      let x=0; for(let k=i+3;k<i+5+sz;k++) x^=b[k];
      if(b[i+2]===0x3E && x===b[i+5+sz]){ msgs.push({proto:'MSP',id:b[i+4],payload:b.slice(i+5,i+5+sz)}); i+=tot; } else i++;
    } else if(v===0x58){                                                   // '$X>' флаг, команда(2), размер(2), данные, CRC8
      if(b.length-i<9) break;
      const sz=b[i+6]|b[i+7]<<8, tot=sz+9;
      if(sz>2048){ i++; continue; }
      if(b.length-i<tot) break;
      if(b[i+2]===0x3E && tlmCrc8(b,i+3,i+8+sz)===b[i+8+sz]){ msgs.push({proto:'MSP',id:b[i+4]|b[i+5]<<8,payload:b.slice(i+8,i+8+sz)}); i+=tot; } else i++;
    } else i++;
  }
  return {msgs, used:i};
}
const TLM_LTM_LEN={0x47:14, 0x41:6, 0x53:7};                               // G, A, S
function tlmLtm(b){
  const msgs=[]; let i=0;
  while(i<b.length){
    if(b[i]!==0x24){ i++; continue; }
    if(b.length-i<2) break;
    if(b[i+1]!==0x54){ i++; continue; }
    if(b.length-i<3) break;
    const n=TLM_LTM_LEN[b[i+2]];
    if(!n){ i++; continue; }
    if(b.length-i<n+4) break;
    let x=0; for(let k=i+3;k<i+3+n;k++) x^=b[k];
    if(x===b[i+3+n]){ msgs.push({proto:'LTM',id:b[i+2],payload:b.slice(i+3,i+3+n)}); i+=n+4; } else i++;
  }
  return {msgs, used:i};
}
const TLM_PARSERS={MAVLink:tlmMavlink, CRSF:tlmCrsf, MSP:tlmMsp, LTM:tlmLtm};

// поток: буфер на каждый протокол, счётчик принятых кадров; protos — какие слушать
function tlmStream(){ return {buf:{}, count:{}}; }
function tlmPush(st,bytes,protos){
  const out=[];
  for(const name of protos){
    const f=TLM_PARSERS[name]; if(!f) continue;
    let b=st.buf[name];
    if(b && b.length) { const t=new Uint8Array(b.length+bytes.length); t.set(b); t.set(bytes,b.length); b=t; } else b=bytes;
    const r=f(b);
    st.buf[name]=b.length-r.used>512 ? b.slice(b.length-512) : b.slice(r.used);
    if(r.msgs.length){ st.count[name]=(st.count[name]||0)+r.msgs.length; out.push(...r.msgs); }
  }
  return out;
}

// сообщение → поля состояния s (единицы: градусы, метры, м/с, вольты, амперы)
function tlmApply(s,m){
  const p=m.payload, set=(k,v)=>{ if(v!=null && isFinite(v)) s[k]=v; };
  const yaw=a=>((a%360)+360)%360;
  s.proto=m.proto;
  if(m.proto==='MAVLink'){
    switch(m.id){
      case 0: s.armed=(p[6]&0x80)!==0; set('mode',tlmI32(p,0)>>>0); break;
      case 1: { const v=tlmU16(p,14), a=tlmI16(p,16); if(v!==65535) set('volts',v/1000); if(a!==-1) set('amps',a/100); if(p[30]<=100) set('batt',p[30]); break; }
      case 24: { set('sats',p[29]); if(p[28]>=2){ set('lat',tlmI32(p,8)/1e7); set('lon',tlmI32(p,12)/1e7); set('alt',tlmI32(p,16)/1000); } break; }
      case 30: set('roll',tlmF32(p,4)*180/Math.PI); set('pitch',tlmF32(p,8)*180/Math.PI); set('hdg',yaw(tlmF32(p,12)*180/Math.PI)); break;
      case 33: { const la=tlmI32(p,4), lo=tlmI32(p,8);
        if(la||lo){ set('lat',la/1e7); set('lon',lo/1e7); set('alt',tlmI32(p,12)/1000); }
        set('ralt',tlmI32(p,16)/1000); set('speed',Math.hypot(tlmI16(p,20),tlmI16(p,22))/100);
        if(tlmU16(p,26)!==65535) set('hdg',tlmU16(p,26)/100); break; }
      case 74: set('speed',tlmF32(p,4)); set('climb',tlmF32(p,12)); break;
    }
  } else if(m.proto==='CRSF'){
    switch(m.id){
      case 0x02: { const la=tlmBI32(p,0), lo=tlmBI32(p,4);
        if(la||lo){ set('lat',la/1e7); set('lon',lo/1e7); }
        set('speed',tlmBU16(p,8)/36); set('hdg',tlmBU16(p,10)/100); set('alt',tlmBU16(p,12)-1000); set('sats',p[14]); break; }
      case 0x08: set('volts',tlmBU16(p,0)/10); set('amps',tlmBU16(p,2)/10); set('batt',p[7]); break;
      case 0x1E: set('pitch',tlmBI16(p,0)/1e4*180/Math.PI); set('roll',tlmBI16(p,2)/1e4*180/Math.PI); set('hdg',yaw(tlmBI16(p,4)/1e4*180/Math.PI)); break;
      case 0x14: set('rssi',-p[0]); set('lq',p[2]); set('snr',p[3]<<24>>24); break;
      case 0x21: { let t=''; for(let i=0;i<p.length&&p[i];i++) t+=String.fromCharCode(p[i]); s.mode=t; break; }
    }
  } else if(m.proto==='MSP'){
    switch(m.id){
      case 108: set('roll',tlmI16(p,0)/10); set('pitch',tlmI16(p,2)/10); set('hdg',yaw(tlmI16(p,4))); break;
      case 106: { set('sats',p[1]); if(p[0]){ set('lat',tlmI32(p,2)/1e7); set('lon',tlmI32(p,6)/1e7); set('alt',tlmU16(p,10)); } set('speed',tlmU16(p,12)/100); break; }
      case 110: set('volts',p[0]/10); set('rssi',tlmU16(p,3)); set('amps',tlmI16(p,5)/100); break;
      case 109: set('ralt',tlmI32(p,0)/100); set('climb',tlmI16(p,4)/100); break;
    }
  } else if(m.proto==='LTM'){
    switch(m.id){
      case 0x47: { const la=tlmI32(p,0), lo=tlmI32(p,4);
        if(la||lo){ set('lat',la/1e7); set('lon',lo/1e7); set('alt',tlmI32(p,9)/100); }
        set('speed',p[8]); set('sats',p[13]>>2); break; }
      case 0x41: set('pitch',tlmI16(p,0)); set('roll',tlmI16(p,2)); set('hdg',yaw(tlmI16(p,4))); break;
      case 0x53: set('volts',tlmU16(p,0)/1000); set('rssi',p[4]); s.armed=(p[6]&1)===1; break;
    }
  }
  s.t=Date.now();
}
