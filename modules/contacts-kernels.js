"use strict";
/* ============================ Контакты: ядро (без DOM) ============================
   Модель — две таблицы Table со связью:
     «contacts/people»      человек: name, phones, emails, org, birthday, tags, note, photo (несколько значений — через « | »)
     «contacts/identities»  как с ним связаться: proto, addr, name (как он подписан в протоколе), contact (связь → people), seen, key
   Один человек — много идентичностей (телефон, e-mail, Telegram, Matrix, IRC…); «слить» двух людей = перевесить идентичности и склеить поля.
   Каноническое имя адреса (key) делает «+7 (916) 123-45-67» и «89161234567» одним и тем же, а «Bob <Bob@Ex.org>» — «bob@ex.org».
   Проверяется tools/test-contacts.mjs; страница — modules/contacts.js. */

const CT_SEP=' | ';
const CT_MULTI=['phones','emails','tags'];                       // поля со списком значений
const CT_PEOPLE_COLS=['name','phones','emails','org','birthday','tags','note','photo'];
const CT_IDENT_COLS=['proto','addr','name','contact','seen','key'];

const ctStr=v=>String(v==null?'':v).trim();
const ctList=v=>ctStr(v).split('|').map(s=>s.trim()).filter(Boolean);

// телефон → «+7916…»; меньше 5 цифр — не телефон (''). 8XXXXXXXXXX (11 цифр) → +7…, 00… → +…, 10 цифр без кода (9XXXXXXXXX) → +7…
function ctPhone(s){
  s=ctStr(s); if(!s) return '';
  const plus=/^\s*(\+|00)/.test(s);
  let d=s.replace(/[^\d]/g,'');
  if(/^00/.test(s.replace(/[^\d+]/g,''))) d=d.replace(/^00/,'');
  if(d.length<5) return '';
  if(!plus){
    if(d.length===11 && d[0]==='8') d='7'+d.slice(1);
    else if(d.length===10 && d[0]==='9') d='7'+d;
  }
  return '+'+d;
}
// адрес в каноническую форму по протоколу
function ctAddr(proto,addr){
  proto=ctStr(proto).toLowerCase(); let a=ctStr(addr);
  if(!a) return '';
  if(proto==='phone' || proto==='sms') return ctPhone(a);
  if(proto==='email'){ const m=/<([^>]+)>/.exec(a); if(m) a=m[1]; return a.trim().toLowerCase(); }
  if(proto==='xmpp') return a.replace(/\/.*$/,'').toLowerCase();                       // user@domain/resource → user@domain
  if(proto==='matrix') return a.toLowerCase();
  if(proto==='telegram') return /^-?\d+$/.test(a) ? a : '@'+a.replace(/^@/,'').toLowerCase();
  if(proto==='aprs') return a.toUpperCase();
  if(proto==='irc') return a.replace(/^[@+~&%]/,'').toLowerCase();
  return a.toLowerCase();                                                              // nostr (hex / npub), bluesky, mastodon, reticulum…
}
const ctKey=(proto,addr)=>{ const a=ctAddr(proto,addr); return a ? ctStr(proto).toLowerCase()+':'+a : ''; };

/* ---------- vCard 2.1 / 3.0 / 4.0 ---------- */
function ctQP(s,charset){
  const b=[]; s=s.replace(/=\r?\n/g,'');
  for(let i=0;i<s.length;i++){ if(s[i]==='=' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i+1,2))){ b.push(parseInt(s.substr(i+1,2),16)); i+=2; } else { for(const x of new TextEncoder().encode(s[i])) b.push(x); } }
  try{ return new TextDecoder(charset||'utf-8').decode(Uint8Array.from(b)); }catch(e){ return new TextDecoder().decode(Uint8Array.from(b)); }
}
const ctUnesc=s=>s.replace(/\\([nN,;\\])/g,(_,c)=>c==='n'||c==='N' ? '\n' : c);
function ctVcardParse(text){
  text=String(text||'').replace(/^﻿/,'').replace(/\r\n?/g,'\n');
  // склейка строк: продолжение начинается с пробела / табуляции; в vCard 2.1 QUOTED-PRINTABLE продолжается мягким переносом «=» в конце
  const raw=text.split('\n'), lines=[];
  for(let i=0;i<raw.length;i++){
    let l=raw[i];
    if(/^[ \t]/.test(l) && lines.length){ lines[lines.length-1]+=l.slice(1); continue; }
    while(/QUOTED-PRINTABLE/i.test(l.split(':')[0]) && /=$/.test(l) && i+1<raw.length){ l=l.slice(0,-1)+raw[++i]; }
    lines.push(l);
  }
  const out=[]; let c=null;
  for(const l of lines){
    const u=l.trim().toUpperCase();
    if(u==='BEGIN:VCARD'){ c={name:'',phones:[],emails:[],org:'',note:'',birthday:'',tags:[]}; continue; }
    if(u==='END:VCARD'){ if(c){ if(!c.name) c.name=c.fn||c.phones[0]||c.emails[0]||''; delete c.fn; if(c.name||c.phones.length||c.emails.length) out.push(c); } c=null; continue; }
    if(!c) continue;
    const i=l.indexOf(':'); if(i<1) continue;
    const head=l.slice(0,i).split(';'), prop=head[0].replace(/^[^.]*\./,'').toUpperCase();     // «item1.TEL» → TEL
    const par={}; for(const p of head.slice(1)){ const k=p.indexOf('='); if(k<0) par[p.toUpperCase()]=true; else par[p.slice(0,k).toUpperCase()]=p.slice(k+1); }
    let val=l.slice(i+1);
    if(par.ENCODING && /quoted-printable/i.test(par.ENCODING)) val=ctQP(val,par.CHARSET); else val=ctUnesc(val);
    if(prop==='FN') c.fn=val.trim();
    else if(prop==='N'){ const [fam,giv,mid,pre,suf]=val.split(';').map(s=>s.trim()); const nm=[pre,giv,mid,fam,suf].filter(Boolean).join(' '); if(nm) c.name=nm; }
    else if(prop==='TEL'){ const p=ctPhone(val.replace(/^tel:/i,'')); if(p && !c.phones.includes(p)) c.phones.push(p); }
    else if(prop==='EMAIL'){ const e=ctAddr('email',val); if(e && !c.emails.includes(e)) c.emails.push(e); }
    else if(prop==='ORG') c.org=val.split(';').map(s=>s.trim()).filter(Boolean).join(', ');
    else if(prop==='NOTE') c.note=val.trim();
    else if(prop==='BDAY'){ const m=/^(\d{4})-?(\d{2})-?(\d{2})/.exec(val.trim()); if(m) c.birthday=m[1]+'-'+m[2]+'-'+m[3]; }
    else if(prop==='CATEGORIES') c.tags.push(...val.split(',').map(s=>s.trim()).filter(Boolean));
  }
  return out;
}

/* ---------- строки таблиц ---------- */
function ctPersonRow(c){
  return {name:ctStr(c.name),phones:(c.phones||[]).join(CT_SEP),emails:(c.emails||[]).join(CT_SEP),org:ctStr(c.org),birthday:ctStr(c.birthday),
    tags:(c.tags||[]).join(CT_SEP),note:ctStr(c.note),photo:''};
}
// идентичности человека: все телефоны и почты (+ extra: [{proto,addr}])
function ctIdentRows(c,extra){
  const rows=[], seen=new Set(), nm=ctStr(c.name);
  const add=(proto,addr,name)=>{ const key=ctKey(proto,addr); if(!key || seen.has(key)) return; seen.add(key); rows.push({proto,addr:ctAddr(proto,addr),name:name||nm,contact:nm,seen:'',key}); };
  for(const p of c.phones||[]) add('phone',p);
  for(const e of c.emails||[]) add('email',e);
  for(const x of extra||[]) add(x.proto,x.addr,x.name);
  return rows;
}

// сообщение из Messenger (rec) → кто это: {proto, addr, name}; свои исходящие и ленты — пропускаем
function ctFromRec(r){
  if(!r || typeof r!=='object') return null;
  if(r.dir==='out' || r.self) return null;
  const proto=ctStr(r.proto).toLowerCase();
  if(!proto || proto==='rss' || proto==='mastodon' || proto==='bluesky') return null;
  const addr=ctStr(r.fromAddr||r.addr||(proto==='email' ? '' : r.from));
  if(!addr) return null;
  const key=ctKey(proto,addr); if(!key) return null;
  return {proto,addr:ctAddr(proto,addr),name:ctStr(r.fromName||r.from)||ctAddr(proto,addr),key};
}
// строка контактов с телефона (Phone Actions → contacts.find): {src:'contact', name, phones:[…]|'a|b'}
function ctFromPhoneRec(r){
  if(!r || r.src!=='contact') return null;
  const ph=Array.isArray(r.phones) ? r.phones : ctList(r.phones);
  const phones=[...new Set(ph.map(ctPhone).filter(Boolean))];
  if(!ctStr(r.name) && !phones.length) return null;
  return {name:ctStr(r.name)||phones[0],phones,emails:[],org:'',note:'',birthday:'',tags:[]};
}

/* ---------- слияние ---------- */
function ctMergeTwo(a,b){
  const o={...a};
  for(const k of Object.keys(b)){
    if(CT_MULTI.includes(k)){ o[k]=[...new Set([...ctList(a[k]),...ctList(b[k])])].join(CT_SEP); }
    else if(k==='note'){ const x=ctStr(a.note), y=ctStr(b.note); o.note=!y||x===y||x.includes(y) ? x : !x ? y : x+'\n'+y; }
    else if(!ctStr(a[k])) o[k]=b[k];
  }
  return o;
}
// группы людей с общей идентичностью (телефон, почта, …): [[имя, имя, …], …]. Связь идентичности с человеком — по полю contact (имя).
function ctDupGroups(people,idents){
  const names=people.map(p=>ctStr(p.name)), parent=new Map(names.map(n=>[n,n]));
  const find=x=>{ while(parent.get(x)!==x){ parent.set(x,parent.get(parent.get(x))); x=parent.get(x); } return x; };
  const byKey=new Map();
  const touch=(key,name)=>{ if(!key||!parent.has(name)) return; if(byKey.has(key)){ const r1=find(byKey.get(key)), r2=find(name); if(r1!==r2) parent.set(r2,r1); } else byKey.set(key,name); };
  for(const i of idents){ const key=ctStr(i.key)||ctKey(i.proto,i.addr); for(const nm of ctList(i.contact)) touch(key,nm); }
  for(const p of people){ const nm=ctStr(p.name); for(const ph of ctList(p.phones)) touch('phone:'+ctPhone(ph),nm); for(const e of ctList(p.emails)) touch('email:'+ctAddr('email',e),nm); }
  const g=new Map(); for(const n of names){ const r=find(n); if(!g.has(r)) g.set(r,[]); g.get(r).push(n); }
  return [...g.values()].filter(x=>x.length>1);
}
// слияние группы имён в одного человека: берём того, у кого заполнено больше полей; идентичности перевешиваются на него
function ctMergePlan(people,idents,group){
  const set=new Set(group), mem=people.filter(p=>set.has(ctStr(p.name)));
  if(mem.length<2) return null;
  const score=p=>CT_PEOPLE_COLS.reduce((s,k)=>s+(ctStr(p[k])?1:0),0);
  const sorted=[...mem].sort((x,y)=>score(y)-score(x));
  const target=sorted[0], tn=ctStr(target.name);
  let merged={...target}; for(const p of sorted.slice(1)) merged=ctMergeTwo(merged,p);
  const moved=idents.filter(i=>ctList(i.contact).some(n=>set.has(n)&&n!==tn)).map(i=>({...i,contact:ctList(i.contact).map(n=>set.has(n)?tn:n).filter((n,k,a)=>a.indexOf(n)===k).join(CT_SEP)}));
  return {target:tn,person:merged,remove:sorted.slice(1).map(p=>ctStr(p.name)),idents:moved};
}

/* ---------- адресная книга для Messenger / Chat ---------- */
// строки {name, addr, proto}: Messenger резолвит @имя → адрес (mgAddrResolve берёт name/alias и addr)
function ctBook(people,idents){
  const rows=[], seen=new Set();
  for(const i of idents){
    const addr=ctAddr(i.proto,i.addr); if(!addr) continue;
    for(const nm of ctList(i.contact)){ const k=nm.toLowerCase()+'|'+i.proto+'|'+addr; if(seen.has(k)) continue; seen.add(k); rows.push({name:nm,addr,proto:ctStr(i.proto)}); }
  }
  return rows;
}
// ключ → имя человека (кто это написал)
function ctWho(idents){
  const m=new Map();
  for(const i of idents){ const key=ctStr(i.key)||ctKey(i.proto,i.addr); const nm=ctList(i.contact)[0]; if(key&&nm&&!m.has(key)) m.set(key,nm); }
  return m;
}
// есть ли уже человек по телефону / почте (для импорта без дублей): имя или ''
function ctFindPerson(people,c){
  const ph=new Set((c.phones||[]).map(ctPhone).filter(Boolean)), em=new Set((c.emails||[]).map(e=>ctAddr('email',e)).filter(Boolean));
  for(const p of people){
    if((ctList(p.phones).map(ctPhone).some(x=>ph.has(x))) || (ctList(p.emails).map(e=>ctAddr('email',e)).some(x=>em.has(x)))) return ctStr(p.name);
  }
  return '';
}
