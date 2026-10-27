"use strict";
/* ============================ DNS: сборка запроса и разбор ответа (RFC 1035, 3596, 2782…) ============================
   Запрос уходит UDP-пакетом через приложение DSP (команда udp.request), ответ разбирается здесь: флаги, коды, записи любого из
   частых типов, сжатие имён. Без DOM — проверяется в tools/test-dnsq.mjs. */

const DNS_TYPES={A:1,NS:2,CNAME:5,SOA:6,PTR:12,MX:15,TXT:16,AAAA:28,SRV:33,NAPTR:35,DS:43,RRSIG:46,DNSKEY:48,HTTPS:65,CAA:257,ANY:255,AXFR:252};
const DNS_TYPE_NAME={}; for(const k in DNS_TYPES) DNS_TYPE_NAME[DNS_TYPES[k]]=k;
const DNS_RCODE=['NOERROR','FORMERR','SERVFAIL','NXDOMAIN','NOTIMP','REFUSED'];
const dnsHexB=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');

// «1.2.3.4» → «4.3.2.1.in-addr.arpa», IPv6 → nibble-форма ip6.arpa
function dnsReverse(ip){
  ip=String(ip).trim();
  if(/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.split('.').reverse().join('.')+'.in-addr.arpa';
  if(ip.includes(':')){
    let [h,t]=ip.split('::'); const hp=h?h.split(':'):[], tp=t!==undefined && t ? t.split(':') : [];
    const mid=t===undefined ? [] : Array(Math.max(0,8-hp.length-tp.length)).fill('0');
    const full=[...hp,...mid,...tp].map(x=>x.padStart(4,'0')).join('');
    return full.split('').reverse().join('.')+'.ip6.arpa';
  }
  return ip;
}
function dnsName(name){
  const out=[];
  for(const l of String(name).replace(/\.$/,'').split('.')){
    if(!l) continue;
    if(l.length>63) throw new Error('label longer than 63 bytes');
    out.push(l.length,...Array.from(l,c=>c.charCodeAt(0)&255));
  }
  out.push(0); return out;
}
// o: {name, type:'A'|number, id, rd (recursion desired, по умолчанию да), cd, ad, edns (размер UDP, 0 — без), do (DNSSEC), class}
function dnsQuery(o){
  const t=typeof o.type==='number' ? o.type : (DNS_TYPES[String(o.type||'A').toUpperCase()] ?? parseInt(o.type,10));
  if(!(t>=0)) throw new Error('unknown record type');
  const id=(o.id ?? Math.floor(Math.random()*65536))&0xFFFF;
  const flags=(o.rd===false ? 0 : 0x0100)|(o.ad ? 0x20 : 0)|(o.cd ? 0x10 : 0);
  const name=/^\d+\.\d+\.\d+\.\d+$|:/.test(o.name) && t===12 ? dnsReverse(o.name) : o.name;
  const ed=o.edns>0 ? [0,0,41,o.edns>>8,o.edns&255,0,0,o.do ? 0x80 : 0,0,0,0] : null;
  const b=[id>>8,id&255,flags>>8,flags&255,0,1,0,0,0,0,0,ed ? 1 : 0, ...dnsName(name), t>>8,t&255, 0,(o.class??1)];
  if(ed) b.push(...ed);
  return Uint8Array.from(b);
}
function dnsReadName(b,p){
  const labels=[]; let jumped=false, end=p, guard=0;
  for(;;){
    if(p>=b.length || ++guard>128) throw new Error('bad name');
    const l=b[p];
    if(l===0){ if(!jumped) end=p+1; break; }
    if((l&0xC0)===0xC0){ if(!jumped) end=p+2; p=((l&0x3F)<<8)|b[p+1]; jumped=true; continue; }
    labels.push(String.fromCharCode(...b.slice(p+1,p+1+l))); p+=1+l;
  }
  return {name:labels.join('.')||'.',end};
}
const dnsU16=(b,p)=>(b[p]<<8)|b[p+1], dnsU32=(b,p)=>((b[p]*16777216)+(b[p+1]<<16)+(b[p+2]<<8)+b[p+3]);
function dnsRdata(b,p,len,type){
  const end=p+len;
  switch(type){
    case 1: return len===4 ? Array.from(b.slice(p,end)).join('.') : null;
    case 28: { const g=[]; for(let i=0;i<8;i++) g.push(dnsU16(b,p+i*2).toString(16)); return g.join(':').replace(/(^|:)0(:0)+(:|$)/,'::').replace(/:{3,}/,'::'); }
    case 2: case 5: case 12: return dnsReadName(b,p).name;
    case 15: return {pref:dnsU16(b,p),host:dnsReadName(b,p+2).name};
    case 16: { const t=[]; let i=p; while(i<end){ const l=b[i++]; t.push(String.fromCharCode(...b.slice(i,i+l))); i+=l; } return t.join(''); }
    case 33: return {prio:dnsU16(b,p),weight:dnsU16(b,p+2),port:dnsU16(b,p+4),host:dnsReadName(b,p+6).name};
    case 6: { const m=dnsReadName(b,p), r=dnsReadName(b,m.end), q=r.end; return {mname:m.name,rname:r.name,serial:dnsU32(b,q),refresh:dnsU32(b,q+4),retry:dnsU32(b,q+8),expire:dnsU32(b,q+12),minimum:dnsU32(b,q+16)}; }
    case 257: { const fl=b[p], tl=b[p+1]; return {flags:fl,tag:String.fromCharCode(...b.slice(p+2,p+2+tl)),value:String.fromCharCode(...b.slice(p+2+tl,end))}; }
    default: return dnsHexB(b.slice(p,end));
  }
}
function dnsParse(buf){
  const b=buf instanceof Uint8Array ? buf : Uint8Array.from(buf);
  if(b.length<12) return {error:'short packet'};
  const f=dnsU16(b,2), r={id:dnsU16(b,0),qr:!!(f&0x8000),opcode:(f>>11)&15,aa:!!(f&0x400),tc:!!(f&0x200),rd:!!(f&0x100),ra:!!(f&0x80),ad:!!(f&0x20),rcode:f&15,
    qd:dnsU16(b,4),an:dnsU16(b,6),ns:dnsU16(b,8),ar:dnsU16(b,10),questions:[],answers:[],authority:[],additional:[]};
  r.rcodeName=DNS_RCODE[r.rcode]||('rcode '+r.rcode);
  try{
    let p=12;
    for(let i=0;i<r.qd;i++){ const n=dnsReadName(b,p); p=n.end; r.questions.push({name:n.name,type:DNS_TYPE_NAME[dnsU16(b,p)]||dnsU16(b,p)}); p+=4; }
    for(const [key,cnt] of [['answers',r.an],['authority',r.ns],['additional',r.ar]]){
      for(let i=0;i<cnt;i++){
        const n=dnsReadName(b,p); p=n.end;
        const type=dnsU16(b,p), cls=dnsU16(b,p+2), ttl=dnsU32(b,p+4), len=dnsU16(b,p+8); p+=10;
        if(p+len>b.length) throw new Error('truncated record');
        r[key].push({name:n.name,type:DNS_TYPE_NAME[type]||type,class:cls,ttl,data:dnsRdata(b,p,len,type)});
        p+=len;
      }
    }
  }catch(e){ r.error=e.message; }
  return r;
}
// ответ → плоские записи для rec: по строке на запись ответа
function dnsRecs(r,server){
  if(!r || r.error && !r.answers) return [];
  const flat=d=>d==null ? '' : typeof d==='object' ? Object.entries(d).map(([k,v])=>k+'='+v).join(' ') : String(d);
  const base={server,rcode:r.rcodeName,aa:r.aa?1:0,tc:r.tc?1:0,ra:r.ra?1:0,ad:r.ad?1:0,q:r.questions[0]?.name};
  const rows=r.answers.map(a=>({...base,section:'answer',name:a.name,type:a.type,ttl:a.ttl,data:flat(a.data)}));
  for(const a of r.authority) rows.push({...base,section:'authority',name:a.name,type:a.type,ttl:a.ttl,data:flat(a.data)});
  if(!rows.length) rows.push({...base,section:'none',name:r.questions[0]?.name,type:r.questions[0]?.type,data:''});
  return rows;
}

if(typeof module!=='undefined') module.exports={dnsQuery,dnsParse,dnsRecs,dnsReverse};
