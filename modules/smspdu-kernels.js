"use strict";
/* ============================ SMS PDU (3GPP TS 23.040 / 23.038) ============================
   Сборка и разбор TPDU: SMS-SUBMIT (телефон → сеть), SMS-DELIVER (сеть → телефон), SMS-STATUS-REPORT (только разбор).
   Алфавиты GSM 7 бит (с таблицей расширения), UCS-2, 8 бит; адреса (цифры, +, буквенные); отметка времени SCTS; срок жизни;
   заголовок данных UDH: склейка длинных сообщений и порты (data-SMS). Без DOM — проверяется в tools/test-smspdu.mjs. */

const SMS_GSM7="@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const SMS_EXT={0x0A:'\f',0x14:'^',0x28:'{',0x29:'}',0x2F:'\\',0x3C:'[',0x3D:'~',0x3E:']',0x40:'|',0x65:'€'};
const SMS_EXT_REV={}; for(const k in SMS_EXT) SMS_EXT_REV[SMS_EXT[k]]=+k;
const SMS_G7_REV={}; for(let i=0;i<128;i++) if(i!==27) SMS_G7_REV[SMS_GSM7[i]]=i;

const smsHex2=b=>(b&255).toString(16).toUpperCase().padStart(2,'0');
const smsToHex=a=>Array.from(a,smsHex2).join('');
function smsFromHex(s){
  const t=String(s||'').replace(/0x/ig,'').replace(/[\s:,_-]/g,'');
  if(!t || t.length%2 || /[^0-9a-f]/i.test(t)) return null;
  const o=new Uint8Array(t.length/2); for(let i=0;i<o.length;i++) o[i]=parseInt(t.substr(i*2,2),16);
  return o;
}

// текст → септеты GSM (с экранированием 0x1B); null, если есть символ вне алфавита
function smsGsm7Encode(text){
  const o=[];
  for(const ch of String(text)){
    if(ch in SMS_G7_REV) o.push(SMS_G7_REV[ch]);
    else if(ch in SMS_EXT_REV) o.push(27,SMS_EXT_REV[ch]);
    else return null;
  }
  return o;
}
function smsGsm7Decode(sept){
  let s='';
  for(let i=0;i<sept.length;i++){
    const c=sept[i];
    if(c===27){ i++; s+=SMS_EXT[sept[i]]||' '; } else s+=SMS_GSM7[c]??'?';
  }
  return s;
}
// упаковка септетов в октеты; pad — число битовых нулей перед первым септетом (после UDH)
function smsPack7(sept,pad=0){
  const out=[]; let acc=0, bits=pad;
  for(const s of sept){ acc|=(s&127)<<bits; bits+=7; while(bits>=8){ out.push(acc&255); acc>>=8; bits-=8; } }
  if(bits>0) out.push(acc&255);
  return out;
}
function smsUnpack7(bytes,count,pad=0){
  const o=[]; let acc=0, bits=0, i=0;
  if(pad){ acc=(bytes[0]||0)>>pad; bits=8-pad; i=1; }
  while(o.length<count){
    while(bits<7){ if(i>=bytes.length) return o; acc|=bytes[i++]<<bits; bits+=8; }
    o.push(acc&127); acc>>=7; bits-=7;
  }
  return o;
}
function smsUcs2Encode(text){ const o=[]; for(let i=0;i<text.length;i++){ const c=text.charCodeAt(i); o.push(c>>8,c&255); } return o; }
function smsUcs2Decode(b){ let s=''; for(let i=0;i+1<b.length;i+=2) s+=String.fromCharCode((b[i]<<8)|b[i+1]); return s; }

// ---------- адреса ----------
// «+79001234567» → {len: цифр, toa, bytes}; «Sender» (буквы) — тип 0xD0, 7-битная упаковка
function smsAddrEncode(num){
  const s=String(num||'').trim();
  if(!s) return {len:0,toa:0x81,bytes:[]};
  if(/[^\d+*#abc\s()-]/i.test(s)){
    const sept=smsGsm7Encode(s.slice(0,11)) || []; const b=smsPack7(sept);
    return {len:Math.ceil(sept.length*7/4),toa:0xD0,bytes:b};
  }
  const intl=s[0]==='+', d=s.replace(/[^\d*#abc]/gi,'');
  const nib=c=>c==='*' ? 10 : c==='#' ? 11 : /[abc]/i.test(c) ? 12+'abc'.indexOf(c.toLowerCase()) : +c;
  const bytes=[];
  for(let i=0;i<d.length;i+=2){ const lo=nib(d[i]), hi=i+1<d.length ? nib(d[i+1]) : 15; bytes.push(lo|(hi<<4)); }
  return {len:d.length,toa:intl ? 0x91 : 0x81,bytes};
}
function smsAddrDecode(len,toa,bytes){
  const type=(toa>>4)&7;
  if(type===5){ const septs=Math.floor(len*4/7); return {num:smsGsm7Decode(smsUnpack7(bytes,septs)),alpha:true}; }
  const sym='0123456789*#abc?';
  let d=''; for(const b of bytes){ d+=sym[b&15]; if((b>>4)!==15) d+=sym[b>>4]; }
  d=d.slice(0,len);
  return {num:(type===1 ? '+' : '')+d,alpha:false};
}
// SMSC: байт длины (в октетах, считая TOA), TOA, цифры
function smsSmscEncode(num){
  const a=smsAddrEncode(num); if(!a.len) return [0];
  return [a.bytes.length+1,a.toa,...a.bytes];
}

// ---------- время ----------
const smsBcd=n=>((n%10)<<4)|Math.floor(n/10)%10;              // десятки в младшем полубайте, как в SCTS
const smsUnbcd=b=>(b&15)*10+(b>>4);
// SCTS: 7 октетов (год, месяц, день, час, минуты, секунды, пояс в четвертях часа); tzMin — смещение в минутах
function smsScts(date,tzMin=0){
  const d=new Date(date.getTime()+tzMin*60000);
  const tz=Math.abs(tzMin)/15, tzb=smsBcd(tz)|(tzMin<0 ? 0x08 : 0);
  return [smsBcd(d.getUTCFullYear()%100),smsBcd(d.getUTCMonth()+1),smsBcd(d.getUTCDate()),smsBcd(d.getUTCHours()),smsBcd(d.getUTCMinutes()),smsBcd(d.getUTCSeconds()),tzb];
}
function smsSctsDecode(b){
  if(b.length<7) return null;
  const tzr=b[6], neg=!!(tzr&8), q=smsUnbcd(tzr&0xF7), tz=(neg ? -1 : 1)*q*15;
  const y=2000+smsUnbcd(b[0]);
  const iso=`${y}-${String(smsUnbcd(b[1])).padStart(2,'0')}-${String(smsUnbcd(b[2])).padStart(2,'0')}T${String(smsUnbcd(b[3])).padStart(2,'0')}:${String(smsUnbcd(b[4])).padStart(2,'0')}:${String(smsUnbcd(b[5])).padStart(2,'0')}`;
  const sg=tz<0 ? '-' : '+', a=Math.abs(tz);
  return {local:iso, tz:`${sg}${String(Math.floor(a/60)).padStart(2,'0')}:${String(a%60).padStart(2,'0')}`, tzMin:tz,
          ts:Date.parse(iso+'Z')-tz*60000};
}
// срок жизни (относительный): 0–143 → (n+1)·5 мин; 144–167 → 12 ч + (n−143)·30 мин; 168–196 → (n−166) сут; 197–255 → (n−192) нед
function smsVpDecode(v){
  if(v<=143) return (v+1)*5;
  if(v<=167) return 720+(v-143)*30;
  if(v<=196) return (v-166)*1440;
  return (v-192)*10080;
}
function smsVpEncode(min){
  if(min<=5) return 0;
  if(min<=720) return Math.ceil(min/5)-1;
  if(min<=1440) return 143+Math.ceil((min-720)/30);
  if(min<=43200) return 166+Math.ceil(min/1440);
  return Math.min(255,192+Math.ceil(min/10080));
}

// ---------- DCS ----------
// кодировка + «flash» (класс 0, показ без сохранения)
function smsDcs(enc,flash,cls){
  const e={gsm7:0,'8bit':4,ucs2:8}[enc]??0;
  if(flash) return 0x10|e;
  if(cls!=null && cls>=0 && cls<=3) return 0x10|e|cls;
  return e;
}
function smsDcsDecode(d){
  let enc='gsm7', cls=null, mwi=null;
  const g=d>>4;
  if(g<=3){ enc=['gsm7','8bit','ucs2','gsm7'][(d>>2)&3]; if(d&0x10) cls=d&3; }
  else if(g===0xF){ enc=d&4 ? '8bit' : 'gsm7'; cls=d&3; }
  else if(g>=0xC && g<=0xE){ mwi={store:g===0xD || g===0xE, active:!!(d&8), type:['voicemail','fax','email','other'][d&3]}; enc=g===0xE ? 'ucs2' : 'gsm7'; }
  return {enc,cls,mwi,flash:cls===0};
}

// ---------- UDH ----------
function smsUdhBuild(o){
  const e=[];
  if(o.concat) e.push(0x00,3,o.concat.ref&255,o.concat.total,o.concat.seq);
  if(o.ports){
    if(o.ports.dst>255 || o.ports.src>255) e.push(0x05,4,o.ports.dst>>8,o.ports.dst&255,o.ports.src>>8,o.ports.src&255);
    else e.push(0x04,2,o.ports.dst,o.ports.src);
  }
  return e.length ? [e.length,...e] : [];
}
function smsUdhParse(b){
  if(!b.length) return {len:0,ies:[]};
  const hl=b[0], ies=[]; let i=1, o={concat:null,ports:null};
  while(i+1<=hl){
    const id=b[i], l=b[i+1], d=b.slice(i+2,i+2+l); i+=2+l;
    ies.push({id,data:smsToHex(d)});
    if(id===0 && l===3) o.concat={ref:d[0],total:d[1],seq:d[2]};
    else if(id===8 && l===4) o.concat={ref:(d[0]<<8)|d[1],total:d[2],seq:d[3]};
    else if(id===4 && l===2) o.ports={dst:d[0],src:d[1]};
    else if(id===5 && l===4) o.ports={dst:(d[0]<<8)|d[1],src:(d[2]<<8)|d[3]};
  }
  return {len:hl+1,ies,...o};
}

// ---------- сборка ----------
/**
 * o: {type:'submit'|'deliver', smsc, to|from, text, enc:'auto'|'gsm7'|'ucs2'|'8bit', data:hex (для 8bit), flash, cls,
 *     ref, mr, rd, srr, vp (минуты, submit), rp, mms, sri, pid, ports:{dst,src}, date, tzMin}
 * → {parts:[{hex, tpdu, len, text}], enc, count}
 */
function smsBuild(o){
  const type=o.type==='deliver' ? 'deliver' : 'submit';
  let enc=o.enc||'auto', text=String(o.text||''), dataBytes=null;
  if(enc==='8bit'){ dataBytes=Array.from(smsFromHex(o.data||'')||new TextEncoder().encode(text)); }
  let sept=null;
  if(enc==='auto'){ sept=smsGsm7Encode(text); enc=sept ? 'gsm7' : 'ucs2'; }
  else if(enc==='gsm7'){ sept=smsGsm7Encode(text); if(!sept) return {error:'the text has characters outside the GSM 7-bit alphabet — use UCS-2'}; }
  const portsUdh=o.ports ? smsUdhBuild({ports:o.ports}) : [];
  // части: считаем по пределам с заголовком склейки (6 байт) + порты
  let chunks=[];
  const extra=portsUdh.length ? portsUdh.length-1 : 0;                // IE портов без UDHL
  const hdrFor=n=>{ const ie=extra+(n>1 ? 5 : 0); return ie ? ie+1 : 0; };    // байт заголовка с UDHL
  const tryPlan=n=>{
    const h=hdrFor(n);
    if(enc==='gsm7'){
      const pad=h ? (7-(h*8)%7)%7 : 0, cap=Math.floor((140*8-h*8-pad)/7);
      const cs=[]; let i=0;
      while(i<sept.length){ let k=Math.min(cap,sept.length-i); if(k<sept.length-i && sept[i+k-1]===27) k--; cs.push(sept.slice(i,i+k)); i+=k; }
      return cs.length ? cs : [[]];
    }
    const cap=140-h;
    if(enc==='ucs2'){
      const bytes=smsUcs2Encode(text), cs=[];
      for(let i=0;i<bytes.length;){ let k=Math.min(cap&~1,bytes.length-i); if(k<bytes.length-i && k>=2 && bytes[i+k-2]>=0xD8 && bytes[i+k-2]<=0xDB) k-=2; cs.push(bytes.slice(i,i+k)); i+=k; }
      return cs.length ? cs : [[]];
    }
    const cs=[]; for(let i=0;i<dataBytes.length;i+=cap) cs.push(dataBytes.slice(i,i+cap));
    return cs.length ? cs : [[]];
  };
  chunks=tryPlan(1);
  if(chunks.length>1) chunks=tryPlan(chunks.length);
  if(chunks.length>255) return {error:'text too long (more than 255 parts)'};
  const ref=(o.ref??Math.floor(Math.random()*256))&255, parts=[];
  const date=o.date instanceof Date ? o.date : new Date(o.date||Date.now());
  const mrBase=(o.mr??0)&255;
  chunks.forEach((ch,idx)=>{
    const udh=smsUdhBuild({concat:chunks.length>1 ? {ref,total:chunks.length,seq:idx+1} : null, ports:o.ports});
    let ud, udl;
    if(enc==='gsm7'){ const pad=udh.length ? (7-(udh.length*8)%7)%7 : 0; ud=[...udh,...smsPack7(ch,pad)]; udl=(udh.length ? Math.ceil(udh.length*8/7) : 0)+ch.length; }
    else { ud=[...udh,...ch]; udl=ud.length; }
    const udhi=udh.length>0;
    const addr=smsAddrEncode(type==='submit' ? o.to : o.from);
    const pdu=[];
    if(type==='submit'){
      const vpf=o.vp>0 ? 2 : 0;
      pdu.push(1|(o.rd ? 4 : 0)|(vpf<<3)|(o.srr ? 32 : 0)|(udhi ? 64 : 0)|(o.rp ? 128 : 0), (mrBase+idx)&255, addr.len, addr.toa, ...addr.bytes, o.pid||0, smsDcs(enc,o.flash,o.cls));
      if(vpf) pdu.push(smsVpEncode(o.vp));
    } else {
      pdu.push(0|(o.mms ? 0 : 4)|(o.sri ? 32 : 0)|(udhi ? 64 : 0)|(o.rp ? 128 : 0), addr.len, addr.toa, ...addr.bytes, o.pid||0, smsDcs(enc,o.flash,o.cls), ...smsScts(new Date(date.getTime()+idx*1000),o.tzMin||0));
    }
    pdu.push(udl,...ud);
    const smsc=smsSmscEncode(o.smsc);
    parts.push({hex:smsToHex([...smsc,...pdu]), tpdu:smsToHex(pdu), len:pdu.length, text:enc==='gsm7' ? smsGsm7Decode(ch) : enc==='ucs2' ? smsUcs2Decode(ch) : ''});
  });
  return {parts,enc,count:parts.length};
}

// ---------- разбор ----------
// withSmsc: true | false | 'auto' (в «auto» пробуем с SMSC и проверяем, что TPDU разбирается ровно до конца)
function smsParse(hex,withSmsc='auto'){
  const b=hex instanceof Uint8Array || Array.isArray(hex) ? Array.from(hex) : Array.from(smsFromHex(hex)||[]);
  if(!b.length) return {error:'not hex'};
  const tries=withSmsc==='auto' ? [true,false] : [!!withSmsc];
  let last=null;
  for(const w of tries){ const r=smsParseAt(b,w); if(!r.error) return r; last=r; }
  return last;
}
function smsParseAt(b,withSmsc){
  let p=0, smsc=null;
  if(withSmsc){
    const l=b[0]; if(l===undefined || 1+l>=b.length) return {error:'bad SMSC length'};
    if(l>0) smsc=smsAddrDecode(l*2-2,b[1],b.slice(2,1+l)).num;
    p=1+l;
  }
  const f=b[p++]; if(f===undefined) return {error:'short'};
  const mti=f&3, r={smsc,mti:['deliver','submit','status-report','reserved'][mti],flags:f,udhi:!!(f&64),rp:!!(f&128)};
  if(mti===3) return {error:'reserved TP-MTI'};
  try{
    if(mti===1){
      r.rd=!!(f&4); r.srr=!!(f&32); r.mr=b[p++];
      const al=b[p++], at=b[p++], n=Math.ceil(al/2);
      r.to=smsAddrDecode(al,at,b.slice(p,p+n)).num; r.toAlpha=smsAddrDecode(al,at,b.slice(p,p+n)).alpha; p+=n;
      r.pid=b[p++]; const dcs=b[p++]; r.dcs=dcs;
      const vpf=(f>>3)&3;
      if(vpf===2){ r.vpMin=smsVpDecode(b[p++]); } else if(vpf===1||vpf===3) p+=7;
      Object.assign(r,smsDcsDecode(dcs));
    } else if(mti===0){
      r.mms=!(f&4); r.sri=!!(f&32);
      const al=b[p++], at=b[p++], n=Math.ceil(al/2);
      const a=smsAddrDecode(al,at,b.slice(p,p+n)); r.from=a.num; r.fromAlpha=a.alpha; p+=n;
      r.pid=b[p++]; const dcs=b[p++]; r.dcs=dcs;
      r.scts=smsSctsDecode(b.slice(p,p+7)); p+=7;
      Object.assign(r,smsDcsDecode(dcs));
    } else {
      r.mr=b[p++];
      const al=b[p++], at=b[p++], n=Math.ceil(al/2);
      r.to=smsAddrDecode(al,at,b.slice(p,p+n)).num; p+=n;
      r.scts=smsSctsDecode(b.slice(p,p+7)); p+=7;
      r.dscts=smsSctsDecode(b.slice(p,p+7)); p+=7;
      const st=b[p++]; r.status=st; r.statusText=st===0 ? 'delivered' : st<32 ? 'delivered (other)' : st<64 ? 'temporary error, still trying' : st<96 ? 'permanent error' : 'temporary error, gave up';
      if(p>=b.length) return {...r,text:'',udl:0,tpduLen:p};
      const pi=b[p++]; if(pi&1) p++; if(pi&2){ r.dcs=b[p++]; Object.assign(r,smsDcsDecode(r.dcs)); } if(pi&4){ /* UDL */ }
    }
    if(p>b.length) return {error:'truncated'};
    const udl=b[p++]; if(udl===undefined) return {error:'no user data'};
    r.udl=udl;
    const enc=r.enc||'gsm7';
    const udBytes=enc==='gsm7' ? Math.ceil(udl*7/8) : udl;
    const ud=b.slice(p,p+udBytes);
    if(ud.length<udBytes) return {error:'user data shorter than TP-UDL says'};
    if(withSmsc && p+udBytes!==b.length) return {error:'trailing bytes after user data'};
    r.tpduLen=p+udBytes;
    let hdr={len:0,ies:[]};
    if(r.udhi){ hdr=smsUdhParse(ud); r.udh=hdr.ies; r.concat=hdr.concat; r.ports=hdr.ports; }
    r.udHex=smsToHex(ud);
    if(enc==='gsm7'){
      const skip=hdr.len ? Math.ceil(hdr.len*8/7) : 0;                       // текст начинается с септета, следующего за заголовком (с выравниванием)
      const sept=smsUnpack7(ud,udl);
      r.text=smsGsm7Decode(sept.slice(skip));
    } else if(enc==='ucs2') r.text=smsUcs2Decode(ud.slice(hdr.len));
    else { const body=ud.slice(hdr.len); r.data=smsToHex(body); r.text=Array.from(body,c=>c>=32 && c<127 ? String.fromCharCode(c) : '.').join(''); }
  }catch(e){ return {error:String(e.message||e)}; }
  return r;
}

// разобранный PDU → плоская запись для rec
function smsRec(r){
  if(!r || r.error) return {error:r&&r.error||'parse'};
  const o={kind:r.mti,smsc:r.smsc||undefined,enc:r.enc,text:r.text,udl:r.udl};
  if(r.from!=null) o.from=r.from; if(r.to!=null) o.to=r.to;
  if(r.scts) o.sent=r.scts.local+r.scts.tz;
  if(r.concat){ o.ref=r.concat.ref; o.part=r.concat.seq; o.parts=r.concat.total; }
  if(r.ports){ o.dport=r.ports.dst; o.sport=r.ports.src; }
  if(r.data!=null) o.data=r.data;
  if(r.flash) o.flash=1;
  if(r.status!=null){ o.status=r.status; o.statusText=r.statusText; }
  if(r.mr!=null) o.mr=r.mr;
  if(r.pid) o.pid=r.pid;
  o.dcs=r.dcs;
  return o;
}

// склейка частей длинного сообщения: s — Map ключ → {total, parts:Map seq→текст}; возвращает текст, когда все части на месте
function smsJoin(s,r){
  if(!r || r.error || !r.concat) return r&&!r.error ? {done:true,text:r.text,from:r.from??r.to} : null;
  const key=(r.from??r.to)+'#'+r.concat.ref+'/'+r.concat.total;
  let e=s.get(key); if(!e){ e={total:r.concat.total,parts:new Map(),t:Date.now()}; s.set(key,e); if(s.size>200) s.delete(s.keys().next().value); }
  e.parts.set(r.concat.seq,r.text);
  if(e.parts.size<e.total) return {done:false,have:e.parts.size,total:e.total};
  s.delete(key);
  let t=''; for(let i=1;i<=e.total;i++) t+=e.parts.get(i)??'';
  return {done:true,text:t,from:r.from??r.to,parts:e.total};
}

if(typeof module!=='undefined') module.exports={smsBuild,smsParse,smsRec,smsJoin,smsGsm7Encode,smsGsm7Decode,smsPack7,smsUnpack7,smsFromHex,smsToHex,smsAddrEncode,smsVpEncode,smsVpDecode};
