"use strict";
/* ============================ Packet Link: ядро ============================
   Байты из любого канала (serial, WebSocket, HTTP-поток, BLE, вход bin) → пакеты. Кадровщик режет поток по правилу:
   message — одно сообщение канала = пакет; hex / json / text lines — строки; slip, kiss, hdlc, cobs — разделители с экранированием;
   len8 / len16be / len16le — длина впереди; pcap — потоковый pcap (tcpdump -U -w -, dumpcap -P -w -).
   push(u8) → [{data:Uint8Array, t?, link?, rec?, prefix?}]. Запись rec (lkRec) несёт hex и hexSchema — для HEX Structure / Table.
   Проверка: node tools/test-link.mjs */

const LK_FRAMES=['message','hex lines','json lines','text lines','slip','kiss','hdlc','cobs','len8','len16be','len16le','pcap'];
const LK_JSON_HEX=['hex','data','payload','raw','frame','bytes'];
const LK_MAXBUF=1<<20;                                   // потолок накопления: мусорный поток не должен съесть память
const lkCat=(a,b)=>{ if(!a.length) return b; const o=new Uint8Array(a.length+b.length); o.set(a); o.set(b,a.length); return o; };

// строка с hex: берём самую длинную серию байтов (пробелы, ':', '-', '.' между ними допустимы), текст перед ней — prefix
function lkLineHex(line){
  const re=/[0-9a-fA-F]{2}(?:[ :.-]?[0-9a-fA-F]{2})*/g;
  let best=null, m;
  while((m=re.exec(line))){
    const hex=m[0].replace(/[^0-9a-fA-F]/g,'');
    if(hex.length>=8 && hex.length%2===0 && (!best || hex.length>best.hex.length)) best={hex,at:m.index};
  }
  if(!best) return null;
  const u=new Uint8Array(best.hex.length/2);
  for(let i=0;i<u.length;i++) u[i]=parseInt(best.hex.substr(i*2,2),16);
  const prefix=line.slice(0,best.at).replace(/[\s,;:|]+$/,'');
  return {data:u,...(prefix ? {prefix} : {})};
}
function lkLineJson(line){
  let o; try{ o=JSON.parse(line); }catch(e){ return null; }
  if(!o || typeof o!=='object' || Array.isArray(o)) return null;
  let data=new Uint8Array(0);
  for(const k of LK_JSON_HEX){
    const v=o[k];
    if(typeof v==='string' && /^(?:[0-9a-fA-F]{2}[ :]?)+$/.test(v.trim())){ const h=lkLineHex(v.trim()); if(h){ data=h.data; break; } }
  }
  return {data,rec:o};
}
const lkSseStrip=l=>l.replace(/^data: ?/,'');

function lkLines(kind){
  let buf='', dec=new TextDecoder();
  return {push(u){
    buf+=dec.decode(u,{stream:true});
    const out=[]; let i;
    while((i=buf.indexOf('\n'))>=0){
      const line=lkSseStrip(buf.slice(0,i).replace(/\r$/,'')); buf=buf.slice(i+1);
      if(!line.trim()) continue;
      let p=null;
      if(kind==='hex lines') p=lkLineHex(line);
      else if(kind==='json lines') p=lkLineJson(line);
      else p={data:new TextEncoder().encode(line),rec:{line}};
      if(p) out.push(p);
    }
    if(buf.length>LK_MAXBUF) buf='';
    return out;
  }, reset(){ buf=''; }};
}
// разделитель FEND (SLIP/KISS) или флаг 0x7E (HDLC) с экранированием
function lkEscaped(kind){
  const FLAG=kind==='hdlc' ? 0x7E : 0xC0, ESC=kind==='hdlc' ? 0x7D : 0xDB;
  let cur=[], esc=false;
  return {push(u){
    const out=[];
    for(const b of u){
      if(b===FLAG){
        if(cur.length){
          let d=Uint8Array.from(cur), p={data:d};
          if(kind==='kiss'){ p={data:d.subarray(1),rec:{port:d[0]>>4,cmd:d[0]&15}}; }
          if(kind!=='kiss' || (d[0]&15)===0) out.push(p);
        }
        cur=[]; esc=false; continue;
      }
      if(b===ESC){ esc=true; continue; }
      if(esc){ esc=false; cur.push(kind==='hdlc' ? b^0x20 : b===0xDC ? 0xC0 : b===0xDD ? 0xDB : b); }
      else cur.push(b);
      if(cur.length>LK_MAXBUF){ cur=[]; esc=false; }
    }
    return out;
  }, reset(){ cur=[]; esc=false; }};
}
function lkCobsDecode(u){
  const o=[]; let i=0;
  while(i<u.length){
    const c=u[i++]; if(c===0 || c-1>u.length-i) return null;
    for(let k=1;k<c;k++) o.push(u[i++]);
    if(c<255 && i<u.length) o.push(0);
  }
  return Uint8Array.from(o);
}
function lkCobs(){
  let cur=[];
  return {push(u){
    const out=[];
    for(const b of u){
      if(b===0){ if(cur.length){ const d=lkCobsDecode(Uint8Array.from(cur)); if(d && d.length) out.push({data:d}); } cur=[]; }
      else { cur.push(b); if(cur.length>LK_MAXBUF) cur=[]; }
    }
    return out;
  }, reset(){ cur=[]; }};
}
// длина впереди; при нелепой длине сдвигаемся на байт (потеря синхронизации)
function lkLength(kind,maxLen){
  const w=kind==='len8' ? 1 : 2, le=kind==='len16le';
  let buf=new Uint8Array(0);
  return {push(u){
    buf=lkCat(buf,u);
    const out=[];
    for(;;){
      if(buf.length<w) break;
      const len=w===1 ? buf[0] : le ? buf[0]|buf[1]<<8 : buf[0]<<8|buf[1];
      if(len>maxLen){ buf=buf.subarray(1); continue; }
      if(buf.length<w+len) break;
      if(len) out.push({data:buf.slice(w,w+len)});
      buf=buf.subarray(w+len);
    }
    if(buf.length>LK_MAXBUF) buf=new Uint8Array(0);
    return out;
  }, reset(){ buf=new Uint8Array(0); }};
}
// потоковый pcap: глобальный заголовок 24 Б, затем записи (16 Б заголовок + данные)
function lkPcap(){
  let buf=new Uint8Array(0), hdr=null;
  return {push(u){
    buf=lkCat(buf,u);
    const out=[];
    if(!hdr){
      if(buf.length<24) return out;
      const dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength), m=dv.getUint32(0,false);
      const k={0xA1B2C3D4:[false,false],0xD4C3B2A1:[true,false],0xA1B23C4D:[false,true],0x4D3CB2A1:[true,true]}[m];
      if(!k){ buf=new Uint8Array(0); return out; }                    // не pcap (pcapng в потоке не разбираем)
      hdr={le:k[0],nano:k[1],link:dv.getUint32(20,k[0])}; buf=buf.subarray(24);
    }
    for(;;){
      if(buf.length<16) break;
      const dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength), le=hdr.le;
      const cap=dv.getUint32(8,le);
      if(cap>LK_MAXBUF){ hdr=null; buf=new Uint8Array(0); break; }
      if(buf.length<16+cap) break;
      out.push({data:buf.slice(16,16+cap), t:(dv.getUint32(0,le)+dv.getUint32(4,le)/(hdr.nano ? 1e9 : 1e6))*1000, link:hdr.link, rec:{orig:dv.getUint32(12,le)}});
      buf=buf.subarray(16+cap);
    }
    return out;
  }, reset(){ buf=new Uint8Array(0); hdr=null; }};
}
function lkFramer(kind,maxLen){
  maxLen=maxLen||4096;
  switch(kind){
    case 'hex lines': case 'json lines': case 'text lines': return lkLines(kind);
    case 'slip': case 'kiss': case 'hdlc': return lkEscaped(kind);
    case 'cobs': return lkCobs();
    case 'len8': case 'len16be': case 'len16le': return lkLength(kind,maxLen);
    case 'pcap': return lkPcap();
    default: return {push:u=>u.length ? [{data:u.slice()}] : [], reset(){}};
  }
}
const lkIsLines=kind=>/ lines$/.test(kind);

// пакет → запись rec (hex + hexSchema для HEX Structure; поля из JSON и kiss — рядом)
function lkRec(p,o){
  const d=p.data, t=p.t||o.now, r={t, src:o.src||'link', kind:'packet', n:o.seq, len:d.length};
  if(d.length){ r.hex=hexToHex(d); r.hexSchema=p.link!=null && typeof PCAP_SCHEMA!=='undefined' && PCAP_SCHEMA[p.link] ? PCAP_SCHEMA[p.link] : (o.schema||'auto'); }
  if(p.prefix) r.prefix=p.prefix;
  if(p.rec) for(const k in p.rec) if(!(k in r) || k==='t' && typeof p.rec[k]==='number') r[k]=p.rec[k];
  r.time=new Date(typeof r.t==='number' && isFinite(r.t) ? r.t : t).toISOString();
  r.text='#'+o.seq+' '+d.length+' B'+(p.prefix ? ' '+p.prefix : '');
  return r;
}

if(typeof module!=='undefined') module.exports={lkFramer,lkRec,lkLineHex,lkCobsDecode,LK_FRAMES};
