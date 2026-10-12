"use strict";
/* ============================ PCAP: чтение и запись ============================
   Классический pcap (микро- и наносекунды, оба порядка байт) и pcapng (SHB / IDB / EPB / SPB).
   pcapRead(байты) → {linktype, packets:[{t, data, orig, link}]}; pcapWrite(пакеты, linktype) → байты.
   linktype → схема HEX Structure: PCAP_SCHEMA. Проверка: node tools/test-hex.mjs */

const PCAP_SCHEMA={0:'null', 1:'eth', 101:'auto', 105:'wifi', 108:'null', 113:'sll', 127:'radiotap', 228:'ipv4', 229:'ipv6'};
function pcapRead(d,max){
  max=max||20000;
  if(!(d instanceof Uint8Array)) d=Uint8Array.from(d);
  if(d.length<12) throw new Error('too short for a capture file');
  const dv=new DataView(d.buffer,d.byteOffset,d.byteLength);
  const m=dv.getUint32(0,false);
  if(m===0x0A0D0D0A) return pcapReadNg(d,dv,max);
  let le, nano;
  if(m===0xA1B2C3D4){ le=false; nano=false; } else if(m===0xD4C3B2A1){ le=true; nano=false; }
  else if(m===0xA1B23C4D){ le=false; nano=true; } else if(m===0x4D3CB2A1){ le=true; nano=true; }
  else throw new Error('not a pcap file');
  if(d.length<24) throw new Error('truncated pcap header');
  const link=dv.getUint32(20,le), out=[];
  for(let o=24;o+16<=d.length && out.length<max;){
    const sec=dv.getUint32(o,le), frac=dv.getUint32(o+4,le), cap=dv.getUint32(o+8,le), orig=dv.getUint32(o+12,le);
    o+=16;
    if(o+cap>d.length) break;
    out.push({t:(sec+frac/(nano ? 1e9 : 1e6))*1000, data:d.slice(o,o+cap), orig, link});
    o+=cap;
  }
  return {linktype:link, packets:out, format:'pcap'};
}
function pcapReadNg(d,dv,max){
  let le=true; const ifs=[], out=[];
  for(let o=0;o+12<=d.length && out.length<max;){
    const type=dv.getUint32(o,le);
    if(type===0x0A0D0D0A){ le=dv.getUint32(o+8,false)===0x1A2B3C4D ? false : true; }
    const len=dv.getUint32(o+4,le);
    if(len<12 || o+len>d.length) break;
    if(type===1){                                    // interface description
      let res=6;                                     // if_tsresol по умолчанию — микросекунды
      for(let p=o+16;p+4<=o+len-4;){ const c=dv.getUint16(p,le), l=dv.getUint16(p+2,le); if(c===0) break; if(c===9) res=d[p+4]; p+=4+((l+3)&~3); }
      ifs.push({link:dv.getUint16(o+8,le), res});
    } else if(type===6){                             // enhanced packet
      const id=dv.getUint32(o+8,le), hi=dv.getUint32(o+12,le), lo=dv.getUint32(o+16,le), cap=dv.getUint32(o+20,le), orig=dv.getUint32(o+24,le);
      const f=ifs[id]||{link:1,res:6};
      const ticks=hi*4294967296+lo, div=(f.res&0x80) ? Math.pow(2,f.res&0x7f) : Math.pow(10,f.res);
      if(o+28+cap<=o+len) out.push({t:ticks/div*1000, data:d.slice(o+28,o+28+cap), orig, link:f.link});
    } else if(type===3){                             // simple packet
      const orig=dv.getUint32(o+8,le), cap=Math.min(orig,len-16), f=ifs[0]||{link:1};
      out.push({t:0, data:d.slice(o+12,o+12+cap), orig, link:f.link});
    }
    o+=(len+3)&~3;
  }
  return {linktype:ifs.length ? ifs[0].link : 1, packets:out, format:'pcapng'};
}
// пакеты [{t (мс), data}] → классический pcap (микросекунды, little-endian)
function pcapWrite(packets,linktype){
  let n=24; for(const p of packets) n+=16+p.data.length;
  const o=new Uint8Array(n), dv=new DataView(o.buffer);
  dv.setUint32(0,0xA1B2C3D4,true); dv.setUint16(4,2,true); dv.setUint16(6,4,true);
  dv.setUint32(16,65535,true); dv.setUint32(20,linktype||1,true);
  let q=24;
  for(const p of packets){
    const ms=p.t||0, sec=Math.floor(ms/1000);
    dv.setUint32(q,sec,true); dv.setUint32(q+4,Math.round((ms-sec*1000)*1000),true);
    dv.setUint32(q+8,p.data.length,true); dv.setUint32(q+12,p.orig||p.data.length,true);
    o.set(p.data,q+16); q+=16+p.data.length;
  }
  return o;
}
