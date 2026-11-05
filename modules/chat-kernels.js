"use strict";
/* ============================ Chat: ядро (без DOM) ============================
   Модель мессенджера: сообщения (записи rec Messenger: {t, proto, dir, from, to, room, text, id, thread, atts}) собираются в разговоры
   (личный с человеком или комната / канал), внутри — треды (общий thread), поверх — фильтры по человеку из Contacts, протоколу, тексту
   (умный поиск dbsearch-kernels.js: ФИО в любом порядке, ё=е, раскладка, номера), «непрочитанные».
   Человек определяется по адресной книге (book из узла Contacts: {name, addr, proto}), а не по подписи в протоколе: один человек в
   разных протоколах — один и тот же собеседник. Проверяется tools/test-chat.mjs. */

const CH_ROOM=/^[#&]/;
const chStr=v=>String(v==null?'':v).trim();
const chProto=p=>{ p=chStr(p).toLowerCase(); return p==='sms' ? 'phone' : p; };      // SMS и звонки — один адрес: номер телефона

// записи книги → индекс «proto:адрес» → имя; ключи те же, что у контактов (contacts-kernels.js ctKey)
function chBookIndex(book){
  const idx=new Map();
  for(const r of Array.isArray(book)?book:[]){
    if(!r || typeof r!=='object') continue;
    const name=chStr(r.name), addr=chStr(r.addr||r.address||r.email), proto=chProto(r.proto);
    if(!name || !addr) continue;
    const k=ctKey(proto||'email',addr); if(k && !idx.has(k)) idx.set(k,name);
    if(!proto){ for(const p of ['email','phone','telegram','matrix','xmpp','irc','nostr']){ const k2=ctKey(p,addr); if(k2 && !idx.has(k2)) idx.set(k2,name); } }
  }
  return idx;
}
// кто это: имя человека из книги по адресу собеседника в этом протоколе, иначе ''
function chPerson(idx,proto,addr){
  if(!idx || !idx.size) return '';
  const k=ctKey(chProto(proto),addr); return (k && idx.get(k)) || '';
}
// разговор сообщения: {key, title, kind:'dm'|'room', peer}. Комната — по полю room или каналу в to; иначе личный: собеседник = from (входящее) / to (исходящее)
function chConv(r){
  const proto=chStr(r.proto).toLowerCase()||'chat', room=chStr(r.room)||(CH_ROOM.test(chStr(r.to)) ? chStr(r.to) : '');
  if(room) return {key:proto+':room:'+room.toLowerCase(),title:room,kind:'room',proto,peer:''};
  const peer=chStr(r.dir==='out' ? (r.to||r.from) : (r.fromAddr||r.from||r.to));
  const norm=ctAddr(proto==='sms'?'phone':proto,peer)||peer.toLowerCase();
  return {key:proto+':dm:'+norm,title:chStr(r.dir==='out' ? (r.to||peer) : (r.from||peer)),kind:'dm',proto,peer};
}
// подготовить сообщение: разговор, человек (по книге), автор для показа, свой/чужой
function chAnnotate(r,idx,me){
  const c=chConv(r), mine=r.dir==='out' || (!!me && chStr(r.from)===chStr(me));
  const addr=r.fromAddr||r.from, per=c.kind==='dm' ? chPerson(idx,c.proto,c.peer) : chPerson(idx,c.proto,addr);
  return {...r,conv:c.key,convTitle:per && c.kind==='dm' ? per : c.title,kind_:c.kind,proto:c.proto,mine,person:per,author:mine ? 'me' : (per||chStr(r.from))};
}

/* ---------- фильтры ---------- */
// f: {conv, person (имя человека), proto, q (умный поиск), unreadFrom (индекс-метка), threadId, onlyMine}
function chFilter(msgs,f){
  f=f||{};
  const terms=f.q ? chStr(f.q).split(/\s+/).filter(Boolean).map(dbTerm) : [];
  const per=chStr(f.person).toLowerCase();
  return msgs.filter(m=>{
    if(f.conv && m.conv!==f.conv) return false;
    if(f.proto && m.proto!==f.proto) return false;
    if(per && chStr(m.person).toLowerCase()!==per && chStr(m.convTitle).toLowerCase()!==per) return false;
    if(f.threadId && chStr(m.thread)!==f.threadId) return false;
    if(terms.length){
      const fields={text:m.text,author:m.author,from:m.from,title:m.convTitle,subject:m.subject,room:m.room,addr:m.fromAddr,to:m.to};
      if(!terms.every(t=>t && Object.keys(fields).some(c=>dbMatch(t,fields[c],c)))) return false;
    }
    return true;
  });
}
// список разговоров по сообщениям: [{key,title,kind,proto,last,count,unread,person}] — свежие выше; read: {key: сколько сообщений прочитано}
function chConvs(msgs,read){
  const map=new Map();
  msgs.forEach((m,i)=>{
    let c=map.get(m.conv);
    if(!c){ c={key:m.conv,title:m.convTitle,kind:m.kind_,proto:m.proto,person:m.person,last:m,count:0,unread:0,idx:0}; map.set(m.conv,c); }
    c.count++; c.last=m; c.idx=i; c.title=m.convTitle||c.title; if(m.person) c.person=m.person;
    if(!m.mine && c.count>((read||{})[m.conv]||0)) c.unread++;
  });
  return [...map.values()].sort((a,b)=>b.idx-a.idx);
}
// треды внутри списка сообщений: сообщения с общим thread собираются в группу на месте первого; остальные — поодиночке
function chThreads(msgs){
  const out=[], at=new Map();
  for(const m of msgs){
    const id=chStr(m.thread);
    if(!id){ out.push({id:'',msgs:[m]}); continue; }
    let g=at.get(m.conv+'\u0000'+id);
    if(!g){ g={id,msgs:[]}; at.set(m.conv+'\u0000'+id,g); out.push(g); }
    g.msgs.push(m);
  }
  return out;
}

/* ---------- показ ---------- */
function chDayLabel(t,now){
  const d=new Date(t), n=new Date(now||Date.now()), day=x=>Date.UTC(x.getFullYear(),x.getMonth(),x.getDate());
  const diff=Math.round((day(n)-day(d))/864e5), p2=x=>String(x).padStart(2,'0');
  if(diff===0) return 'Today';
  if(diff===1) return 'Yesterday';
  return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate());
}
const chDayKey=t=>{ const d=new Date(t); return d.getFullYear()+'-'+d.getMonth()+'-'+d.getDate(); };
// в одну «пачку» (без повторной подписи автора): тот же автор в том же разговоре не позже gapMs
const chSameRun=(a,b,gapMs)=>!!a && !!b && a.conv===b.conv && a.author===b.author && a.mine===b.mine && chDayKey(a.t)===chDayKey(b.t) && Math.abs(b.t-a.t)<=(gapMs||300000);
// разметка текста: **жирный**, *курсив* / _курсив_, ~~зачёркнутый~~, `код`, ссылки http(s); → [{t:'text'|'b'|'i'|'s'|'code'|'a', v}]; HTML не используется, узлы строятся через DOM
function chMd(text){
  const s=String(text==null?'':text), out=[];
  const re=/`([^`\n]+)`|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])|(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])|(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;
  let last=0, m;
  while((m=re.exec(s))){
    if(m.index>last) out.push({t:'text',v:s.slice(last,m.index)});
    if(m[1]!==undefined) out.push({t:'code',v:m[1]});
    else if(m[2]!==undefined) out.push({t:'b',v:m[2]});
    else if(m[3]!==undefined) out.push({t:'s',v:m[3]});
    else if(m[4]!==undefined || m[5]!==undefined) out.push({t:'i',v:m[4]!==undefined ? m[4] : m[5]});
    else out.push({t:'a',v:m[6]});
    last=re.lastIndex;
  }
  if(last<s.length) out.push({t:'text',v:s.slice(last)});
  return out;
}
// первая строка превью для списка разговоров
const chPreview=(m,n)=>{ const t=chStr(m&&m.text).replace(/\s+/g,' '); const s=(m&&m.mine ? 'You: ' : '')+t; return s.length>(n||60) ? s.slice(0,(n||60)-1)+'…' : s; };

/* ---------- история в списке Table ---------- */
const CH_HIST_COLS=['time','proto','dir','from','from_addr','to','room','subject','thread','text','atts','conv','t','kind','ref','op'];      // kind=reaction: ref — на что, text — эмодзи через пробел, op — add / remove / set
// короткая свёртка строки (для ключа сообщения без id)
function chHash(s){ let h=2166136261>>>0; s=String(s); for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619)>>>0; } return h.toString(36); }
// ключ сообщения: протокол + id, а без id — время, автор и свёртка текста (повторная выдача истории не плодит дубли)
const chHistKey=r=>r.kind==='reaction'
  ? chStr(r.proto||'chat').toLowerCase()+':rx:'+(chStr(r.id) ? chStr(r.id) : (+r.t||0)+':'+chHash(chStr(r.author||r.from)+'\u0000'+chStr(r.target)+'\u0000'+(r.emojis||[]).join(' ')+'\u0000'+chStr(r.op)))
  : chStr(r.proto||'chat').toLowerCase()+':'+(chStr(r.id) ? 'id:'+chStr(r.id) : (+r.t||0)+':'+chHash(chStr(r.from)+'\u0000'+chStr(r.fromAddr)+'\u0000'+chStr(r.text)));
// сообщение → запись списка {name, fields}; name — ключ, поля — читаемые колонки (список можно листать и искать в Table)
function chToItem(r){
  const t=+r.t||Date.now(), d=new Date(t), p2=x=>String(x).padStart(2,'0');
  if(r.kind==='reaction') return {name:chHistKey(r),fields:{time:d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())+' '+p2(d.getHours())+':'+p2(d.getMinutes())+':'+p2(d.getSeconds()),
    proto:chStr(r.proto),dir:chStr(r.dir)==='out' ? 'out' : 'in',from:chStr(r.author||r.from),to:chStr(r.to),room:chStr(r.room),text:(r.emojis||[]).join(' '),conv:chConv({...r,from:r.author||r.from}).key,t:t,kind:'reaction',ref:chStr(r.target),op:chStr(r.op)||'add'}};
  return {name:chHistKey(r),fields:{
    time:d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())+' '+p2(d.getHours())+':'+p2(d.getMinutes())+':'+p2(d.getSeconds()),
    proto:chStr(r.proto),dir:chStr(r.dir),from:chStr(r.from),from_addr:chStr(r.fromAddr),to:chStr(r.to),room:chStr(r.room),subject:chStr(r.subject),thread:chStr(r.thread),
    text:String(r.text==null?'':r.text),atts:(r.atts||[]).map(a=>a&&a.name).filter(Boolean).join(' | '),conv:chConv(r).key,t:t,ref:chStr(r.ref)}};
}
// запись списка → сообщение (то, что пришло бы в rec); вложения — только имена (файлы лежат в Files)
function chFromItem(it){
  const f=(it&&it.fields)||{};
  if(chStr(f.kind)==='reaction'){
    const r={t:+f.t||0,proto:chStr(f.proto)||'chat',dir:chStr(f.dir)==='out' ? 'out' : 'in',kind:'reaction',target:chStr(f.ref),author:chStr(f.from),emojis:chStr(f.text).split(/\s+/).filter(Boolean),op:chStr(f.op)||'add',from:chStr(f.from),text:''};
    if(chStr(f.room)) r.room=chStr(f.room); if(chStr(f.to)) r.to=chStr(f.to);
    const nm=chStr(it&&it.name), pre=r.proto.toLowerCase()+':rx:'; if(nm.startsWith(pre) && !/^\d+:/.test(nm.slice(pre.length))) r.id=nm.slice(pre.length);
    return r;
  }
  const id=chStr(it&&it.name).startsWith(chStr(f.proto).toLowerCase()+':id:') ? chStr(it.name).slice(chStr(f.proto).length+4) : '';
  const r={t:+f.t||0,proto:chStr(f.proto)||'chat',dir:chStr(f.dir)==='out' ? 'out' : 'in',from:chStr(f.from),text:String(f.text==null?'':f.text)};
  if(chStr(f.from_addr)) r.fromAddr=chStr(f.from_addr); if(chStr(f.to)) r.to=chStr(f.to); if(chStr(f.room)) r.room=chStr(f.room);
  if(chStr(f.subject)) r.subject=chStr(f.subject); if(chStr(f.thread)) r.thread=chStr(f.thread); if(id) r.id=id; if(chStr(f.ref)) r.ref=chStr(f.ref);
  if(chStr(f.atts)) r.atts=chStr(f.atts).split('|').map(s=>({name:s.trim(),mime:'',size:0})).filter(a=>a.name);
  return r;
}
// последние max сообщений списка по времени (старые идут на выброс при trim)
const chHistTail=(items,max)=>items.map(chFromItem).filter(r=>r.t).sort((a,b)=>a.t-b.t).slice(-max);
// метки «прочитано до» по разговорам → сколько сообщений каждого разговора уже прочитано
function chReadCounts(msgs,readT){
  const out={}; readT=readT||{};
  for(const m of msgs){ if(m.t<=(readT[m.conv]||0)) out[m.conv]=(out[m.conv]||0)+1; else out[m.conv]=out[m.conv]||0; }
  return out;
}

/* ---------- реакции ---------- */
const CH_ME='\u0001me';                                           // автор «я» в состоянии реакций
const CH_EMOJI=['👍','❤️','😂','😮','😢','🙏'];
const CH_REACT_PROTOS=['matrix','xmpp','telegram','nostr'];       // где реакции уходят в протокол (в остальных — только чужие, если придут)
// состояние: Map цель → Map автор → Set эмодзи. ev: {target, author, emojis, op:'add'|'remove'|'set'}; «set» — полный набор автора (XMPP, Telegram)
function chReactApply(state,ev){
  const t=chStr(ev&&ev.target); if(!t) return;
  let by=state.get(t); if(!by){ by=new Map(); state.set(t,by); }
  const a=chStr(ev.author)||'?', es=(ev.emojis||[]).map(chStr).filter(Boolean);
  let set=by.get(a)||new Set();
  if(ev.op==='set') set=new Set(es); else if(ev.op==='remove') for(const e of es) set.delete(e); else for(const e of es) set.add(e);
  if(set.size) by.set(a,set); else by.delete(a);
  if(!by.size) state.delete(t);
}
// сводка по сообщению: [{emoji, count, mine, who:[имена]}] — чаще выше, при равенстве — в порядке появления
function chReactSummary(state,target){
  const by=state.get(chStr(target)); if(!by) return [];
  const m=new Map();
  for(const [a,set] of by) for(const e of set){ let x=m.get(e); if(!x){ x={emoji:e,count:0,mine:false,who:[],ord:m.size}; m.set(e,x); } x.count++; if(a===CH_ME) x.mine=true; x.who.push(a===CH_ME ? 'You' : a); }
  return [...m.values()].sort((p,q)=>q.count-p.count || p.ord-q.ord).map(({ord,...x})=>x);
}
const chReactMine=(state,target)=>{ const by=state.get(chStr(target)); return new Set(by && by.get(CH_ME) || []); };
