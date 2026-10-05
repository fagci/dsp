"use strict";
/* ============================ APRS / KISS: ядро ============================
   KISS-кадрирование (TNC по Serial или TCP), кадр AX.25 UI ↔ строка TNC2 «SRC>DST,PATH:info», позиция из APRS, пароль APRS-IS.
   Без DOM и сети — проверяется отдельно. Mic-E (позиция в адресе назначения) не разбирается. */

const KISS={FEND:0xC0,FESC:0xDB,TFEND:0xDC,TFESC:0xDD};
// кадр AX.25 (без FCS) → кадр KISS: FEND, команда (порт<<4 | cmd), данные с экранированием, FEND
function kissEncode(data,port=0,cmd=0){
  const o=[KISS.FEND,((port&15)<<4)|(cmd&15)];
  for(const b of data){
    if(b===KISS.FEND) o.push(KISS.FESC,KISS.TFEND);
    else if(b===KISS.FESC) o.push(KISS.FESC,KISS.TFESC);
    else o.push(b);
  }
  o.push(KISS.FEND); return Uint8Array.from(o);
}
class KissParser{
  constructor(){ this.buf=[]; this.esc=false; }
  // байты → кадры данных {port, data}; кадры других команд (параметры TNC) отбрасываются
  push(bytes){
    const out=[];
    for(const b of bytes){
      if(b===KISS.FEND){
        if(this.buf.length>1 && (this.buf[0]&15)===0) out.push({port:this.buf[0]>>4,data:Uint8Array.from(this.buf.slice(1))});
        this.buf=[]; this.esc=false; continue;
      }
      if(this.esc){ this.esc=false; this.buf.push(b===KISS.TFEND ? KISS.FEND : b===KISS.TFESC ? KISS.FESC : b); continue; }
      if(b===KISS.FESC){ this.esc=true; continue; }
      this.buf.push(b);
      if(this.buf.length>2048){ this.buf=[]; }            // мусор без FEND
    }
    return out;
  }
}
const apCallRe=/^([A-Z0-9]{1,6})(?:-(\d{1,2}))?(\*?)$/;
function apAddr(call,last,flag){                           // flag: C-бит (dst/src) или H-бит (digi)
  const m=apCallRe.exec(String(call).trim().toUpperCase()); if(!m) return null;
  const ssid=Math.min(15,+m[2]||0), s=m[1].padEnd(6,' '), b=[];
  for(let i=0;i<6;i++) b.push(s.charCodeAt(i)<<1);
  b.push(0x60|(ssid<<1)|(flag ? 0x80 : 0)|(last ? 1 : 0));
  return b;
}
// строка TNC2 → байты кадра UI (без FCS); null, если адреса не разбираются
function tnc2ToAx25(line){
  const m=/^([^>\s]+)>([^:,\s]+)((?:,[^:,\s]+)*):([\s\S]*)$/.exec(String(line).replace(/[\r\n]+$/,''));
  if(!m) return null;
  const digis=m[3] ? m[3].slice(1).split(',') : [];
  if(digis.length>8) return null;
  let lastH=-1; digis.forEach((d,i)=>{ if(d.endsWith('*')) lastH=i; });   // «*» — этот и все до него уже ретранслировали
  const addrs=[apAddr(m[2],false,true), apAddr(m[1].replace(/\*$/,''),digis.length===0,false)];
  digis.forEach((d,i)=>addrs.push(apAddr(d.replace(/\*$/,''),i===digis.length-1,i<=lastH)));
  if(addrs.some(a=>!a)) return null;
  const b=[]; for(const a of addrs) b.push(...a);
  b.push(0x03,0xF0);
  for(const ch of m[4]) b.push(ch.charCodeAt(0)&0xFF);
  return Uint8Array.from(b);
}
// байты кадра AX.25 без FCS (как в KISS) → {src,dst,path,info,tnc2}; null, если не UI-кадр
function ax25ToTnc2(b){
  if(b.length<16) return null;
  const addr=i=>{ let s=''; for(let k=0;k<6;k++){ const c=(b[i+k]>>1)&0x7f; if(c!==32) s+=String.fromCharCode(c); }
    const ss=(b[i+6]>>1)&15; return {call:s+(ss ? '-'+ss : ''),h:!!(b[i+6]&0x80)}; };
  const dst=addr(0), src=addr(7); let p=14; const digis=[];
  while(!(b[p-1]&1) && p+7<=b.length && digis.length<8){ digis.push(addr(p)); p+=7; }
  if(!(b[p-1]&1) || p+2>b.length || (b[p]&0xEF)!==0x03) return null;
  let info=''; for(let i=p+2;i<b.length;i++) info+=String.fromCharCode(b[i]);
  let lastH=-1; digis.forEach((d,i)=>{ if(d.h) lastH=i; });
  const path=digis.map((d,i)=>d.call+(i===lastH ? '*' : ''));
  return {src:src.call,dst:dst.call,path,info,tnc2:src.call+'>'+dst.call+(path.length ? ','+path.join(',') : '')+':'+info};
}
// строка TNC2 / APRS-IS → {src,dst,path,info}; null для комментариев сервера («# …») и мусора
function tnc2Parse(line){
  const m=/^([^>\s#]+)>([^:,\s]+)((?:,[^:,\s]+)*):([\s\S]*)$/.exec(String(line).replace(/[\r\n]+$/,''));
  return m ? {src:m[1],dst:m[2],path:m[3] ? m[3].slice(1).split(',') : [],info:m[4]} : null;
}
const apB91=s=>{ let v=0; for(const c of s) v=v*91+(c.charCodeAt(0)-33); return v; };
// информационное поле APRS → {lat,lon,sym,comment}: позиции ! = / @ (с метками времени и без), сжатые и обычные; иначе null
function aprsPosition(info){
  const t=info[0]; let s;
  if(t==='!' || t==='=') s=info.slice(1);
  else if(t==='/' || t==='@') s=info.slice(8);
  else return null;
  if(!s) return null;
  if(/^[\/\\A-Za-j]/.test(s) && s.length>=13 && !/^\d/.test(s)){
    const lat=90-apB91(s.slice(1,5))/380926, lon=-180+apB91(s.slice(5,9))/190463;
    if(!(Math.abs(lat)<=90 && Math.abs(lon)<=180)) return null;
    return {lat,lon,sym:s[0]+s[9],comment:s.slice(13)};
  }
  const m=/^([\d ]{2})([\d ]{2}\.[\d ]{2})([NS])(.)([\d ]{3})([\d ]{2}\.[\d ]{2})([EW])(.)([\s\S]*)$/.exec(s);
  if(!m) return null;
  const z=x=>x.replace(/ /g,'0');                           // пробелы — потеря точности (ambiguity)
  let lat=+z(m[1])+(+z(m[2]))/60, lon=+z(m[5])+(+z(m[6]))/60;
  if(m[3]==='S') lat=-lat; if(m[7]==='W') lon=-lon;
  if(!(Math.abs(lat)<=90 && Math.abs(lon)<=180)) return null;
  return {lat,lon,sym:m[4]+m[8],comment:m[9]};
}
// запись для карты и журнала из разобранной строки
function aprsRecord(p,t){
  const o={t,id:p.src,label:p.src,call:p.src,dst:p.dst,path:p.path.join(','),text:p.info};
  const pos=aprsPosition(p.info);
  if(pos){ o.lat=pos.lat; o.lon=pos.lon; o.sym=pos.sym; o.text=pos.comment; }
  return o;
}
// пароль APRS-IS по позывному (без SSID)
function aprsPasscode(call){
  const c=String(call).toUpperCase().split('-')[0]; let h=0x73e2;
  for(let i=0;i<c.length;i+=2){ h^=c.charCodeAt(i)<<8; if(i+1<c.length) h^=c.charCodeAt(i+1); }
  return h&0x7fff;
}
