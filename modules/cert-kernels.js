"use strict";
/* ============================ Сертификаты: свой центр (CA) и серверные сертификаты ============================
   X.509 v3 на чистом JS: DER собираем сами, подписываем Web Crypto (ECDSA P-256 + SHA-256) — одинаково в браузере и в Node 20+.
   Зачем: wss:// и https:// у мостов в локальной сети (страница по https не открывает ws:// без «allow insecure content»), а позже —
   разбор TLS-трафика собственного устройства. Центр можно ОГРАНИЧИТЬ именами (name constraints): если его ключ утечёт, им нельзя
   подписать сертификат для чужого сайта — только для localhost, .local / .lan и частных адресов. Проверено openssl и настоящим
   TLS-рукопожатием: tools/test-cert.mjs. Нужны msgr-kernels.js (mgCat, mgB64, mgUnhex, mgRandom, mgSha). */

// ---------- ASN.1 DER ----------
const cdLen=n=>n<128 ? [n] : n<256 ? [0x81,n] : n<65536 ? [0x82,n>>8,n&255] : [0x83,n>>16,(n>>8)&255,n&255];
const cdTLV=(tag,body)=>mgCat(Uint8Array.from([tag,...cdLen(body.length)]),body);
const cdSeq=(...a)=>cdTLV(0x30,mgCat(...a)), cdSet=(...a)=>cdTLV(0x31,mgCat(...a));
function cdInt(b){ let i=0; while(i<b.length-1 && b[i]===0) i++; b=b.slice(i); return cdTLV(0x02,b[0]&0x80 ? mgCat(Uint8Array.of(0),b) : b); }
const cdSmall=n=>cdInt(Uint8Array.of(n));
function cdOid(s){
  const p=s.split('.').map(Number), out=[p[0]*40+p[1]];
  for(const v of p.slice(2)){ const t=[v&127]; let x=v>>>7; while(x){ t.unshift((x&127)|128); x>>>=7; } out.push(...t); }
  return cdTLV(0x06,Uint8Array.from(out));
}
const cdUtf8=s=>cdTLV(0x0c,mgUtf8(s)), cdOct=b=>cdTLV(0x04,b), cdBool=v=>cdTLV(0x01,Uint8Array.of(v ? 0xff : 0));
const cdBits=(b,unused)=>cdTLV(0x03,mgCat(Uint8Array.of(unused||0),b));
function cdTime(d){                                            // UTCTime до 2049, дальше GeneralizedTime
  const z=(n,w=2)=>String(n).padStart(w,'0'), y=d.getUTCFullYear();
  const s=(y<2050 ? z(y%100) : z(y,4))+z(d.getUTCMonth()+1)+z(d.getUTCDate())+z(d.getUTCHours())+z(d.getUTCMinutes())+z(d.getUTCSeconds())+'Z';
  return cdTLV(y<2050 ? 0x17 : 0x18,mgUtf8(s));
}
const cdName=(cn,org)=>cdSeq(...(org ? [cdSet(cdSeq(cdOid('2.5.4.10'),cdUtf8(org)))] : []),cdSet(cdSeq(cdOid('2.5.4.3'),cdUtf8(cn))));
const cdExt=(oid,crit,value)=>cdSeq(cdOid(oid),...(crit ? [cdBool(true)] : []),cdOct(value));
const CD_ECDSA_SHA256='1.2.840.10045.4.3.2';

// IP-адрес → байты (IPv4 4, IPv6 16); null, если это не адрес
function cdIp(s){
  s=String(s).trim();
  const m4=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if(m4){ const b=m4.slice(1).map(Number); return b.every(x=>x<256) ? Uint8Array.from(b) : null; }
  if(!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(':')) return null;
  let head=s, v4=null; const t=/(\d+\.\d+\.\d+\.\d+)$/.exec(s); if(t){ v4=cdIp(t[1]); if(!v4) return null; head=s.slice(0,-t[1].length)+'0:0'; }
  const parts=head.split('::'); if(parts.length>2) return null;
  const side=x=>x ? x.split(':') : [], a=side(parts[0]), b=parts.length===2 ? side(parts[1]) : [];
  const fill=8-a.length-b.length; if(parts.length===1 ? a.length!==8 : fill<1) return null;
  const words=[...a,...Array(parts.length===2 ? fill : 0).fill('0'),...b]; if(words.length!==8 || words.some(w=>!/^[0-9a-fA-F]{1,4}$/.test(w))) return null;
  const out=new Uint8Array(16); words.forEach((w,i)=>{ const n=parseInt(w,16); out[2*i]=n>>8; out[2*i+1]=n&255; });
  if(v4) out.set(v4,12);
  return out;
}
const cdSan=(dns,ips)=>cdSeq(...dns.map(d=>cdTLV(0x82,mgUtf8(d))),...ips.map(i=>cdTLV(0x87,cdIp(i))));
const cdSubtree=g=>cdSeq(g);                                 // GeneralSubtree: base (minimum 0, без maximum — по умолчанию)
// ограничение имён: центр может выписывать только эти имена и эти сети (IPv4 — адрес+маска)
function cdNameConstraints(dns,nets){
  const sub=[...dns.map(d=>cdSubtree(cdTLV(0x82,mgUtf8(d)))),...nets.map(([ip,bits])=>{
    const a=cdIp(ip), mask=new Uint8Array(a.length); for(let i=0;i<bits;i++) mask[i>>3]|=0x80>>(i&7);
    return cdSubtree(cdTLV(0x87,mgCat(a,mask)));
  })];
  return cdSeq(cdTLV(0xa0,mgCat(...sub)));
}
// по умолчанию центр ограничен локальными именами и частными сетями
const CD_LOCAL_DNS=['localhost','.local','.lan','.home.arpa','.internal'];
const CD_LOCAL_NETS=[['127.0.0.0',8],['10.0.0.0',8],['172.16.0.0',12],['192.168.0.0',16],['169.254.0.0',16],['100.64.0.0',10],['::1',128],['fc00::',7],['fe80::',10]];

// ---------- подпись и PEM ----------
const cdSub=()=>{ const s=typeof crypto!=='undefined' && crypto.subtle; if(!s) throw new Error('Web Crypto is not available'); return s; };
function cdSigDer(p1363){                                      // r‖s (WebCrypto) → SEQUENCE{INTEGER r, INTEGER s}
  const h=p1363.length/2; return cdSeq(cdInt(p1363.slice(0,h)),cdInt(p1363.slice(h)));
}
function cdPem(label,der){
  const b=mgB64(der).replace(/.{1,64}/g,'$&\n');
  return '-----BEGIN '+label+'-----\n'+b+'-----END '+label+'-----\n';
}
function cdUnpem(pem){ const m=/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(String(pem)); if(!m) return null; return Uint8Array.from(atob(m[2].replace(/\s+/g,'')),c=>c.charCodeAt(0)); }
async function cdKeyId(spki){                                  // SubjectKeyIdentifier = SHA-1 битов открытого ключа
  const bits=cdReadTLV(cdReadTLV(spki,0).body,0); const second=cdReadTLV(cdReadTLV(spki,0).body,bits.end);   // SEQ{ algId, BITSTRING }
  return new Uint8Array(await cdSub().digest('SHA-1',second.body.slice(1)));
}
function cdReadTLV(b,pos){                                     // → {tag, body, start, end}
  const tag=b[pos]; let l=b[pos+1], o=pos+2;
  if(l&0x80){ const n=l&0x7f; l=0; for(let i=0;i<n;i++) l=l*256+b[o+i]; o+=n; }
  if(o+l>b.length) throw new Error('bad DER');
  return {tag,body:b.slice(o,o+l),start:pos,end:o+l};
}

async function cdBuild(o){                                     // o: {serial,issuer(DER Name),subject(DER Name),spki,days,exts[],signKey,startBefore}
  const now=Date.now(), from=new Date(Math.floor((now-3600e3)/1000)*1000), to=new Date(Math.floor((now+o.days*86400e3)/1000)*1000);
  const sigAlg=cdSeq(cdOid(CD_ECDSA_SHA256));
  const tbs=cdSeq(cdTLV(0xa0,cdSmall(2)),cdInt(o.serial),sigAlg,o.issuer,cdSeq(cdTime(from),cdTime(to)),o.subject,o.spki,cdTLV(0xa3,cdSeq(...o.exts)));
  const sig=new Uint8Array(await cdSub().sign({name:'ECDSA',hash:'SHA-256'},o.signKey,tbs));
  return cdSeq(tbs,sigAlg,cdBits(cdSigDer(sig),0));
}
const cdSerial=()=>{ const b=mgRandom(16); b[0]&=0x7f; if(b[0]===0) b[0]=1; return b; };
const cdGen=ext=>cdSub().generateKey({name:'ECDSA',namedCurve:'P-256'},ext!==false,['sign','verify']);

// Центр сертификации. o: {name, org, days (3650), constrain: {dns,nets}|null|false (по умолчанию — локальные имена и сети), extractable (true)}
async function certNewCA(o){
  o=o||{}; const s=cdSub(), pair=await cdGen(o.extractable), spki=new Uint8Array(await s.exportKey('spki',pair.publicKey)), ski=await cdKeyId(spki);
  const subject=cdName(o.name||'DSP local CA',o.org||'DSP workbench');
  const con=o.constrain===false ? null : (o.constrain||{dns:CD_LOCAL_DNS,nets:CD_LOCAL_NETS});
  const exts=[cdExt('2.5.29.19',true,cdSeq(cdBool(true),cdSmall(0))),cdExt('2.5.29.15',true,cdBits(Uint8Array.of(0x06),1)),cdExt('2.5.29.14',false,cdOct(ski)),
    ...(con ? [cdExt('2.5.29.30',true,cdNameConstraints(con.dns,con.nets))] : [])];
  const der=await cdBuild({serial:cdSerial(),issuer:subject,subject,spki,days:o.days||3650,exts,signKey:pair.privateKey});
  return {der,pem:cdPem('CERTIFICATE',der),key:pair.privateKey,keyPem:o.extractable===false ? '' : cdPem('PRIVATE KEY',new Uint8Array(await s.exportKey('pkcs8',pair.privateKey))),subject,ski,constrained:!!con};
}
// Загрузка сохранённого центра из PEM (сертификат + закрытый ключ PKCS#8)
async function certLoadCA(certPem,keyPem){
  const der=cdUnpem(certPem), kd=cdUnpem(keyPem); if(!der || !kd) throw new Error('bad PEM');
  const cert=cdReadTLV(der,0), tbs=cdReadTLV(cert.body,0); let p=0;
  const kids=[]; while(p<tbs.body.length){ const t=cdReadTLV(tbs.body,p); kids.push(t); p=t.end; }
  const i=kids[0].tag===0xa0 ? 1 : 0, subject=tbs.body.slice(kids[i+4].start,kids[i+4].end), spki=tbs.body.slice(kids[i+5].start,kids[i+5].end);
  const key=await cdSub().importKey('pkcs8',kd,{name:'ECDSA',namedCurve:'P-256'},true,['sign']);
  return {der,pem:cdPem('CERTIFICATE',der),key,keyPem:cdPem('PRIVATE KEY',kd),subject,ski:await cdKeyId(spki),constrained:true};
}
// Серверный сертификат. o: {cn, dns:[], ips:[], days (365), extractable, spki}
// spki — DER открытого ключа СЕРВЕРА (его создало само устройство, например приложение Android): тогда ключ не генерируем и закрытого ключа у нас нет
async function certNewLeaf(ca,o){
  const s=cdSub(), own=!o.spki, pair=own ? await cdGen(o.extractable) : null, spki=own ? new Uint8Array(await s.exportKey('spki',pair.publicKey)) : o.spki;
  const dns=(o.dns||[]).filter(Boolean), ips=(o.ips||[]).filter(i=>cdIp(i));
  if(!dns.length && !ips.length) throw new Error('give at least one name or IP address');
  // CN у сертификата только с IP не должен быть похож на имя: OpenSSL сверяет такой CN с ограничениями имён центра и отказывает (permitted subtree violation)
  const cn=o.cn||dns[0]||'DSP device', subject=cdName(cn,null);
  const exts=[cdExt('2.5.29.19',true,cdSeq()),cdExt('2.5.29.15',true,cdBits(Uint8Array.of(0x80),7)),cdExt('2.5.29.37',false,cdSeq(cdOid('1.3.6.1.5.5.7.3.1'),cdOid('1.3.6.1.5.5.7.3.2'))),
    cdExt('2.5.29.17',false,cdSan(dns,ips)),cdExt('2.5.29.14',false,cdOct(await cdKeyId(spki))),cdExt('2.5.29.35',false,cdSeq(cdTLV(0x80,ca.ski)))];
  const der=await cdBuild({serial:cdSerial(),issuer:ca.subject,subject,spki,days:o.days||365,exts,signKey:ca.key});
  const keyPem=own ? cdPem('PRIVATE KEY',new Uint8Array(await s.exportKey('pkcs8',pair.privateKey))) : '';
  return {der,pem:cdPem('CERTIFICATE',der),keyPem,chainPem:cdPem('CERTIFICATE',der)+ca.pem,dns,ips,cn};
}
