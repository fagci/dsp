"use strict";
/* ============================ Chat: режим «conversations» (интерфейс) ============================
   Список разговоров (личные и комнаты, по протоколам) с непрочитанным и превью; внутри — сообщения по дням, подряд идущие одного автора
   в одной «пачке», треды сворачиваются, ответ на сообщение, разметка **жирный** / *курсив* / `код` / ссылки; сверху фильтры: человек
   (из книги Contacts), протокол, умный поиск, «только непрочитанные». Отправка идёт адресату открытого разговора: выход to + text → Messenger.
   Логика — chat-kernels.js (tools/test-chat.mjs); сообщения — записи rec узла Messenger. */

const CHC_KEEP=2000, CHC_PENDING_MS=15000;
const chcEl=(tag,cls,txt)=>{ const e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; return e; };

function chcInit(n){
  n.msgs=[]; n.read={}; n.seen=new Set(); n.pid=0; n.bookIdx=new Map(); n.bookSig='';
  n.cs={open:'',q:'',person:'',proto:'',unread:false,reply:null,fo:false,fold:new Set(),edit:null,pick:''};
  n.outTo=''; n.cvEl=null; n.cvDirty=true; n.unreadN=0; n.lastBook=undefined;
  n.react=new Map(); n.reactQ=[]; n.editQ=[]; n.mods=new Map();
  n.hist={loaded:false,loading:false,queue:[],early:[],timer:null,name:'',err:''};
}
// записи книги (Contacts → book): имена людей по адресам; при смене книги сообщения переразмечаются
function chcSetBook(n,rows){
  const sig=rows.length+':'+rows.slice(0,50).map(r=>(r&&r.name)+'|'+(r&&r.addr)).join(',');
  if(sig===n.bookSig) return; n.bookSig=sig;
  n.bookIdx=chBookIndex(rows);
  n.msgs=n.msgs.map(m=>({...chAnnotate(m.raw,n.bookIdx,n.p.me),pending:m.pending,pid:m.pid,sentAt:m.sentAt,edited:m.edited,deleted:m.deleted,thread:m.thread||m.raw.thread,raw:m.raw})); n.cvDirty=true;
}
function chcAdd(n,r,quiet){
  if(!r || typeof r!=='object' || r.kind==='roster') return;
  if(r.kind==='edit' || r.kind==='delete'){                                      // правка / удаление — событие над сообщением
    const ev={...r,t:+r.t||Date.now(),proto:r.proto||'chat'}, k=chHistKey(ev);
    if(n.seen.has(k)) return; n.seen.add(k);
    const i=n.msgs.findIndex(m=>m.proto===ev.proto && chcRef(m)===String(ev.target));
    if(i>=0){ if(chCanModify(n.msgs[i],ev)) n.msgs[i]=chApplyMod(n.msgs[i],ev); }
    else { let a=n.mods.get(String(ev.target)); if(!a){ a=[]; n.mods.set(String(ev.target),a); } a.push(ev); if(n.mods.size>2000) n.mods.delete(n.mods.keys().next().value); }       // сообщение ещё не пришло — применим, когда придёт
    n.cvDirty=true;
    if(!quiet && chcStore(n)){ n.hist.queue.push(chToItem(ev)); chcSchedule(n); }
    return;
  }
  if(r.kind==='reaction'){                                                      // реакция — событие над сообщением, строки в журнале не даёт
    const rr={...r,t:+r.t||Date.now(),proto:r.proto||'chat'}, k=chHistKey(rr);
    if(n.seen.has(k)) return; n.seen.add(k);
    chReactApply(n.react,{target:rr.target,author:rr.dir==='out' ? CH_ME : (rr.author||rr.from||'?'),emojis:rr.emojis,op:rr.op});
    n.cvDirty=true;
    if(!quiet && chcStore(n)){ n.hist.queue.push(chToItem(rr)); chcSchedule(n); }
    return;
  }
  const text=r.text ?? r.msg ?? r.message; if(text==null || text==='') return;
  const raw={...r,text:String(text),t:+r.t||Date.now(),dir:r.dir||(String(r.from||'')===String(n.p.me||'') && n.p.me ? 'out' : 'in'),proto:r.proto||'chat'};
  const key=chHistKey(raw);                                                     // тот же ключ, что у записи истории: повторная выдача сервера и перезагрузка не плодят дубли
  if(n.seen.has(key)) return; n.seen.add(key); if(n.seen.size>50000) n.seen.delete(n.seen.values().next().value);
  const m={...chAnnotate(raw,n.bookIdx,n.p.me),raw};
  if(m.mine){                                                                     // своё сообщение с сервера заменяет «отправляется»
    const i=n.msgs.findIndex(x=>x.pending && x.conv===m.conv && x.text===m.text);
    if(i>=0){ m.thread=m.thread||n.msgs[i].thread; n.msgs.splice(i,1); }
  }
  n.msgs.push(m); if(n.msgs.length>CHC_KEEP) n.msgs.splice(0,n.msgs.length-CHC_KEEP);
  const pend=n.mods.get(chcRef(m));
  if(pend){ n.mods.delete(chcRef(m)); const li=n.msgs.length-1; for(const ev of pend) if(n.msgs[li] && chCanModify(n.msgs[li],ev)) n.msgs[li]=chApplyMod(n.msgs[li],ev); }
  n.cvDirty=true;
  if(!quiet && chcStore(n)){ n.hist.queue.push(chToItem(raw)); chcSchedule(n); }
}
// реакция на сообщение m: поставить / снять эмодзи. Состояние обновляется сразу, в Messenger уходит строка выхода react
const chcRef=m=>String(m.ref||m.id||'');
function chcReactable(m){
  if(!CH_REACT_PROTOS.includes(m.proto) || m.pending) return false;
  const ref=chcRef(m); if(!ref) return false;
  return m.proto!=='telegram' || /^-?\d+:\d+$/.test(ref);
}
// куда адресовать действие над сообщением m: комната или собеседник
function chcDest(m){
  const room=m.kind_==='room', r=room ? (m.raw.room||m.convTitle||'') : '';
  return {room:r,to:room ? r : (m.mine ? chStr(m.raw.to) : chStr(m.raw.fromAddr||m.raw.from))};
}
const chcOwnRef=m=>{ const ref=chcRef(m); return !!ref && m.mine && !m.pending && !m.deleted && (m.proto!=='telegram' || /^-?\d+:\d+$/.test(ref)); };
const chcEditable=m=>chcOwnRef(m) && CH_EDIT_PROTOS.includes(m.proto);
const chcDeletable=m=>chcOwnRef(m) && CH_DELETE_PROTOS.includes(m.proto);
function chcEditStart(n,m){ n.cs.edit={ref:chcRef(m),m}; n.cs.reply=null; n.cs.pick=''; n.cvDirty=true; if(n.cvInp){ n.cvInp.value=m.text; n.cvInp.focus(); } }
function chcEditCancel(n){ if(n.cs.edit && n.cvInp) n.cvInp.value=''; n.cs.edit=null; n.cvDirty=true; }
function chcEditApply(n,text){
  const ed=n.cs.edit; n.cs.edit=null; n.cvDirty=true; if(!ed) return;
  text=String(text).trim(); if(!text || text===ed.m.text) return;
  const d=chcDest(ed.m);
  chcAdd(n,{t:Date.now(),proto:ed.m.proto,dir:'out',kind:'edit',target:ed.ref,author:'me',text,room:d.room,to:d.to});       // сразу видно у нас
  n.editQ.push({op:'edit',target:ed.ref,text,room:d.room,to:d.to});
}
function chcDelete(n,m){
  if(!confirm('Delete this message'+(m.proto==='nostr' ? ' (relays are asked to remove it, some may keep it)' : ' for everyone')+'?')) return;
  const d=chcDest(m);
  chcAdd(n,{t:Date.now(),proto:m.proto,dir:'out',kind:'delete',target:chcRef(m),author:'me',room:d.room,to:d.to});
  n.editQ.push({op:'delete',target:chcRef(m),room:d.room,to:d.to});
}
function chcReact(n,m,emoji){
  const ref=chcRef(m), mine=chReactMine(n.react,ref), on=!mine.has(emoji);
  let next=new Set(mine);
  if(m.proto==='telegram') next=on ? new Set([emoji]) : new Set();               // бот Telegram держит одну реакцию
  else if(on) next.add(emoji); else next.delete(emoji);
  chReactApply(n.react,{target:ref,author:CH_ME,emojis:[...next],op:'set'});
  const room=m.kind_==='room', to=chcDest(m).to;
  n.reactQ.push({target:ref,emoji,on,mine:[...next],room:room ? (m.raw.room||m.convTitle||'') : '',to});
  if(chcStore(n)){ n.hist.queue.push(chToItem({t:Date.now(),proto:m.proto,dir:'out',kind:'reaction',target:ref,author:'me',emojis:[...next],op:'set',room:room ? (m.raw.room||'') : '',to})); chcSchedule(n); }
  n.cs.pick=''; n.cvDirty=true;
}
function chcSend(n,text){
  if(n.cs.edit){ chcEditApply(n,text); return; }                              // строка ввода в режиме правки: это новый текст, а не новое сообщение
  text=String(text).trim(); if(!text) return;
  const cv=n.cs, convs=chConvs(n.msgs,n.read), c=convs.find(x=>x.key===cv.open);
  if(!c){ n.cs.hint='open a conversation first'; n.cvDirty=true; return; }
  const last=n.msgs.filter(m=>m.conv===c.key && !m.mine).pop() || n.msgs.filter(m=>m.conv===c.key).pop();
  const to=c.kind==='room' ? (c.title||'') : (last ? (last.mine ? chStr(last.raw.to) : chStr(last.raw.fromAddr||last.raw.from)) : '');
  const re=cv.reply;
  const raw={t:Date.now(),proto:c.proto,dir:'out',from:String(n.p.me||'me'),to,room:c.kind==='room' ? c.title : '',text,id:'',thread:re ? (re.thread||re.id||'') : ''};
  const m={...chAnnotate(raw,n.bookIdx,n.p.me),raw,pending:true,pid:++n.pid,sentAt:Date.now()};
  if(n.p.echo!==false) n.msgs.push(m);
  n.outQ.push(text); n.outTo=to; cv.reply=null; chcMarkRead(n,c.key); n.cvDirty=true;
}

// ---------- история в списке Table (store) ----------
const chcStore=n=>String(n.p.store||'').trim();
const chcReadKey=n=>'dsp-chat-read:'+chcStore(n);
function chcReadT(n){ try{ return JSON.parse(localStorage.getItem(chcReadKey(n))||'{}')||{}; }catch(e){ return {}; } }
function chcMarkRead(n,key){
  const list=n.msgs.filter(m=>m.conv===key);
  if(n.read[key]===list.length) return;
  n.read[key]=list.length;
  if(!chcStore(n) || !list.length) return;
  try{ const t=chcReadT(n); t[key]=list[list.length-1].t; localStorage.setItem(chcReadKey(n),JSON.stringify(t)); }catch(e){ /* без хранилища — прочитанное живёт до перезагрузки */ }
}
function chcSchedule(n){ if(n.hist.timer) return; n.hist.timer=setTimeout(()=>{ n.hist.timer=null; chcFlush(n); },600); }
async function chcFlush(n){                                               // записи пачкой: одна транзакция вместо десятков
  const h=n.hist, name=chcStore(n), items=h.queue.splice(0);
  if(!items.length || !name || typeof ListDB==='undefined') return;
  try{ await ListDB.addMany(name,items); h.err=''; }
  catch(e){ h.err='history not saved: '+(e&&e.message||e); n.cs.hint=h.err; n.cvDirty=true; }
}
async function chcLoad(n){
  const h=n.hist, name=chcStore(n); h.loading=true;
  try{
    if(!(await ListDB.listNames()).includes(name)) await ListDB.setMeta(name,{cols:['name',...CH_HIST_COLS],types:{text:{t:'long'}}});
    const items=await ListDB.list(name);
    for(const r of chHistTail(items,CHC_KEEP)) chcAdd(n,r,true);              // последние — в память (chcAdd сам отмечает ключи)
    for(const it of items) n.seen.add(String(it.name));                       // …а всё сохранённое, даже не влезшее в память, — «уже видели»
    n.msgs.sort((a,b)=>a.t-b.t);
    n.read=chReadCounts(n.msgs,chcReadT(n));                                   // непрочитанное — по сохранённому времени
  }catch(e){ h.err='history not loaded: '+(e&&e.message||e); n.cs.hint=h.err; }
  h.loaded=true; h.loading=false; n.cvDirty=true;
  const early=h.early.splice(0); for(const r of early) chcAdd(n,r);          // что пришло, пока грузилась история
}
async function chcWipe(n){
  const name=chcStore(n); if(!name) return;
  if(!confirm('Delete the whole chat history from the list «'+name+'»? Messages already shown stay until reload.')) return;
  try{ await chcFlush(n); await ListDB.replaceList(name,[]); n.seen.clear(); n.msgs=[]; n.read={}; try{ localStorage.removeItem(chcReadKey(n)); }catch(e){} n.cvDirty=true; n.cs.hint='history deleted'; }
  catch(e){ n.cs.hint='cannot delete: '+(e&&e.message||e); n.cvDirty=true; }
}

// ---------- разметка ----------
function chcMd(text,into){
  for(const t of chMd(text)){
    if(t.t==='text'){ into.append(document.createTextNode(t.v)); continue; }
    if(t.t==='a'){ const a=chcEl('a','chat-a',t.v); a.href=t.v; a.target='_blank'; a.rel='noopener noreferrer'; a.addEventListener('click',e=>e.stopPropagation()); into.append(a); continue; }
    into.append(chcEl(t.t==='b' ? 'b' : t.t==='i' ? 'i' : t.t==='s' ? 's' : 'code',null,t.v));
  }
}
const chcTime=t=>{ const d=new Date(t), p=x=>String(x).padStart(2,'0'); return p(d.getHours())+':'+p(d.getMinutes()); };

// ---------- сообщение ----------
function chcMsgEl(n,m,run,showWho){
  const mine=m.mine, e=chcEl('div','cv-msg '+(mine ? 'out' : 'in')+(run ? ' run' : ''));
  const bub=chcEl('div','cv-bub');
  if(showWho && !mine && !run){
    const who=chcEl('div','cv-who',m.author); who.title='show only '+m.author; who.addEventListener('click',ev=>{ ev.stopPropagation(); n.cs.person=m.person||''; if(!n.cs.person) n.cs.q=m.author; n.cs.open=''; n.cs.fo=true; n.cvDirty=true; });
    bub.append(who);
  }
  if(m.subject && !run) bub.append(chcEl('div','cv-subj',m.subject));
  const body=chcEl('div','cv-text'+(m.deleted ? ' gone' : '')); if(m.deleted) body.textContent='message deleted'; else chcMd(m.text,body); bub.append(body);
  if(!m.deleted && m.atts && m.atts.length) bub.append(chcEl('div','cv-atts','📎 '+m.atts.map(a=>a.name).join(', ')));
  const ref=chcRef(m), sum=ref && !m.deleted ? chReactSummary(n.react,ref) : [], can=chcReactable(m) && !m.deleted;
  if(sum.length){                                                               // реакции под сообщением: чип = эмодзи + число; клик — поставить / снять свою
    const rx=chcEl('div','cv-rx');
    for(const x of sum){ const b=chcEl('button','cv-chip'+(x.mine ? ' mine' : ''),x.emoji+(x.count>1 ? ' '+x.count : '')); b.type='button'; b.title=x.who.join(', ')+(can ? '' : ' (reactions to this message cannot be sent from here)'); if(can) b.addEventListener('click',ev=>{ ev.stopPropagation(); chcReact(n,m,x.emoji); }); else b.disabled=true; rx.append(b); }
    bub.append(rx);
  }
  if(can && n.cs.pick===ref){
    const pk=chcEl('div','cv-pick');
    for(const em of CH_EMOJI){ const b=chcEl('button',null,em); b.type='button'; b.addEventListener('click',ev=>{ ev.stopPropagation(); chcReact(n,m,em); }); pk.append(b); }
    bub.append(pk);
  }
  const foot=chcEl('div','cv-foot'); if(m.edited && !m.deleted) foot.append(chcEl('span','cv-edited','edited')); foot.append(chcEl('span','cv-time',chcTime(m.t)));
  if(can){ const rb=chcEl('button','cv-re cv-rb','☺'); rb.type='button'; rb.title='react'; rb.addEventListener('click',ev=>{ ev.stopPropagation(); n.cs.pick=n.cs.pick===ref ? '' : ref; n.cvDirty=true; }); foot.append(rb); }
  if(mine){ const st=m.pending ? (Date.now()-m.sentAt>CHC_PENDING_MS ? '⚠' : '…') : '✓'; foot.append(chcEl('span','cv-st'+(m.pending ? ' wait' : ''),st)); foot.lastChild.title=m.pending ? (st==='⚠' ? 'no confirmation from the channel' : 'sending') : 'sent'; }
  if(chcEditable(m)){ const eb=chcEl('button','cv-re','✎'); eb.type='button'; eb.title='edit'; eb.addEventListener('click',ev=>{ ev.stopPropagation(); chcEditStart(n,m); }); foot.append(eb); }
  if(chcDeletable(m)){ const db=chcEl('button','cv-re','🗑'); db.type='button'; db.title='delete'; db.addEventListener('click',ev=>{ ev.stopPropagation(); chcDelete(n,m); }); foot.append(db); }
  const re=chcEl('button','cv-re','↩'); re.title='reply'; re.type='button';
  re.addEventListener('click',ev=>{ ev.stopPropagation(); n.cs.reply={id:m.id||('p'+(m.pid||'')),thread:m.thread||m.id||'',text:chPreview(m,50),author:m.author}; n.cvDirty=true; if(n.cvInp) n.cvInp.focus(); });
  foot.append(re); bub.append(foot); e.append(bub);
  return e;
}

// ---------- представления ----------
function chcFilters(n){
  const cv=n.cs;
  return {conv:cv.open,person:cv.person,proto:cv.proto,q:cv.q};
}
const chcActive=n=>!!(n.cs.person||n.cs.proto||n.cs.q||n.cs.unread);
function chcList(n,body){
  const cv=n.cs, f=chcFilters(n);
  let convs=chConvs(chFilter(n.msgs,{...f,conv:''}),n.read);
  // «только непрочитанные» и поиск считаются по всем сообщениям разговора, unread — по меткам прочитанного
  const all=new Map(chConvs(n.msgs,n.read).map(c=>[c.key,c]));
  convs=convs.map(c=>({...c,unread:all.get(c.key)?.unread||0}));
  if(cv.unread) convs=convs.filter(c=>c.unread>0);
  if(!convs.length){ body.append(chcEl('div','cv-empty',n.msgs.length ? 'nothing matches the filters' : 'no messages yet — wire a Messenger «rec» into this Chat')); return; }
  for(const c of convs){
    const row=chcEl('div','cv-conv'+(c.unread ? ' unread' : ''));
    row.append(tcAvatar('',c.title,36));
    const mid=chcEl('div','cv-cmid'), t=chcEl('div','cv-ct'); t.append(chcEl('span','cv-ctitle',c.title),chcEl('span','cv-proto',c.proto+(c.kind==='room' ? ' · room' : '')));
    mid.append(t,chcEl('div','cv-prev',chPreview(c.last,70)));
    const side=chcEl('div','cv-side'); side.append(chcEl('div','cv-when',chcTime(c.last.t)));
    if(c.unread) side.append(chcEl('span','cv-badge',String(c.unread)));
    row.append(mid,side);
    row.addEventListener('click',()=>{ cv.open=c.key; chcMarkRead(n,c.key); cv.reply=null; n.cvDirty=true; n.cvStick=true; });
    body.append(row);
  }
}
function chcThread(n,body){
  const cv=n.cs, f=chcFilters(n);
  const list=chFilter(n.msgs,f);
  if(!list.length){ body.append(chcEl('div','cv-empty','no messages')); return; }
  const room=list[0].kind_==='room';
  const groups=chThreads(list);
  let prev=null, lastDay='';
  for(const g of groups){
    const multi=g.id && g.msgs.length>1;
    const wrap=multi ? chcEl('div','cv-thr') : body;
    if(multi){
      const folded=cv.fold.has(g.id);
      const h=chcEl('div','cv-thr-h',(folded ? '▸ ' : '▾ ')+'thread · '+g.msgs.length+' messages'+(g.msgs[0].subject ? ' · '+g.msgs[0].subject : ''));
      h.addEventListener('click',()=>{ folded ? cv.fold.delete(g.id) : cv.fold.add(g.id); n.cvDirty=true; });
      body.append(wrap); wrap.append(h);
      if(folded){ prev=null; continue; }
    }
    for(const m of g.msgs){
      const dk=chDayLabel(m.t); if(dk!==lastDay){ lastDay=dk; body.append(chcEl('div','cv-day',dk)); prev=null; }
      const run=chSameRun(prev,m,300000); prev=m;
      (multi ? wrap : body).append(chcMsgEl(n,m,run,room));
    }
  }
}
function chcResults(n,body){                                            // фильтры без открытого разговора: найденные сообщения всех разговоров
  const list=chFilter(n.msgs,chcFilters(n)).slice(-200);
  if(!list.length){ body.append(chcEl('div','cv-empty','nothing found')); return; }
  for(const m of list.reverse()){
    const row=chcEl('div','cv-hit'); row.append(chcEl('div','cv-hit-h',m.convTitle+' · '+m.proto+' · '+new Date(m.t).toLocaleString()));
    const t=chcEl('div','cv-text'); chcMd(m.text,t); row.append(t);
    row.addEventListener('click',()=>{ n.cs.open=m.conv; n.cs.q=''; n.cs.person=''; n.cs.proto=''; n.cs.unread=false; chcMarkRead(n,m.conv); n.cvDirty=true; n.cvStick=true; });
    body.append(row);
  }
}

function chcMount(n){
  const box=chcEl('div','chat cv'), cv=n.cs;
  const head=chcEl('div','cv-head'), back=chcEl('button','cv-back','←'), title=chcEl('div','cv-title','Chats'), fbtn=chcEl('button','cv-fbtn','Filters');
  back.type=fbtn.type='button'; back.title='back to the list'; fbtn.title='filter by person, protocol, text';
  back.addEventListener('click',()=>{ cv.open=''; cv.reply=null; n.cvDirty=true; });
  fbtn.addEventListener('click',()=>{ cv.fo=!cv.fo; n.cvDirty=true; });
  head.append(back,title,fbtn);
  const fl=chcEl('div','cv-filters'), q=chcEl('input'), per=chcEl('select'), pro=chcEl('select'), un=chcEl('label','cv-un'), unc=chcEl('input');
  q.type='text'; q.placeholder='search: name, text, phone…'; q.autocomplete='off'; unc.type='checkbox'; un.append(unc,document.createTextNode(' unread'));
  q.addEventListener('keydown',e=>e.stopPropagation()); q.addEventListener('input',()=>{ cv.q=q.value; n.cvDirty=true; });
  per.addEventListener('change',()=>{ cv.person=per.value; n.cvDirty=true; }); pro.addEventListener('change',()=>{ cv.proto=pro.value; n.cvDirty=true; });
  unc.addEventListener('change',()=>{ cv.unread=unc.checked; n.cvDirty=true; });
  fl.append(q,per,pro,un);
  const body=chcEl('div','cv-body'), hint=chcEl('div','cv-hint'), rep=chcEl('div','cv-reply');
  const row=chcEl('div','chat-row'), inp=chcEl('input'), btn=chcEl('button',null,'Send');
  inp.type='text'; inp.placeholder='message…'; inp.autocomplete='off';
  const go=()=>{ chcSend(n,inp.value); inp.value=''; inp.focus(); };
  btn.addEventListener('click',go); inp.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter'){ e.preventDefault(); go(); } else if(e.key==='Escape' && cv.edit){ e.preventDefault(); chcEditCancel(n); } });
  row.append(inp,btn);
  box.addEventListener('pointerdown',e=>e.stopPropagation()); box.addEventListener('wheel',e=>e.stopPropagation());
  box.append(head,fl,body,hint,rep,row); n.mid.append(box);
  if(n.size && n.size.h>0) box.style.height=n.size.h+'px';
  Object.assign(n,{cvEl:box,cvHead:head,cvBack:back,cvTitle:title,cvFilters:fl,cvQ:q,cvPer:per,cvPro:pro,cvUnc:unc,cvBody:body,cvHint:hint,cvRep:rep,cvRow:row,cvInp:inp,cvDirty:true});
}
function chcRender(n){
  const cv=n.cs, body=n.cvBody;
  const stick=body.scrollHeight-body.scrollTop-body.clientHeight<30 || n.cvStick, top=body.scrollTop;
  n.cvStick=false;
  // фильтры: список людей и протоколов из сообщений
  const people=[...new Set(n.msgs.map(m=>m.person).filter(Boolean))].sort((a,b)=>a.localeCompare(b)), protos=[...new Set(n.msgs.map(m=>m.proto))].sort();
  const fill=(sel,first,vals,cur)=>{ sel.textContent=''; const o0=chcEl('option',null,first); o0.value=''; sel.append(o0); for(const v of vals){ const o=chcEl('option',null,v); o.value=v; sel.append(o); } sel.value=cur; };
  fill(n.cvPer,'any person',people,cv.person); fill(n.cvPro,'any protocol',protos,cv.proto);
  n.cvFilters.hidden=!cv.fo && !chcActive(n); n.cvQ.value!==cv.q && (n.cvQ.value=cv.q); n.cvUnc.checked=cv.unread;
  const convs=chConvs(n.msgs,n.read), cur=convs.find(c=>c.key===cv.open);
  if(cv.open && !cur) cv.open='';
  n.cvBack.hidden=!cv.open; n.cvRow.hidden=!cv.open; n.cvRep.hidden=!cv.open || !(cv.reply || cv.edit);
  n.cvTitle.textContent=cur ? cur.title+(cur.kind==='room' ? '' : '') : (chcActive(n) ? 'Search' : 'Chats');
  n.cvTitle.title=cur ? cur.proto+(cur.kind==='room' ? ' · room' : '') : '';
  body.textContent='';
  if(cv.open){ chcThread(n,body); chcMarkRead(n,cv.open); }       // открытый разговор читается
  else if(chcActive(n) && (cv.q || cv.person) ) chcResults(n,body);
  else chcList(n,body);
  n.cvRep.textContent=''; if(cv.edit){ n.cvRep.hidden=false; n.cvRep.append(chcEl('span',null,'✎ editing: '+chPreview(cv.edit.m,60))); const xe=chcEl('button',null,'✕'); xe.type='button'; xe.title='cancel (Esc)'; xe.addEventListener('click',()=>chcEditCancel(n)); n.cvRep.append(xe); }
  else if(cv.reply){ n.cvRep.append(chcEl('span',null,'↪ '+cv.reply.author+': '+cv.reply.text)); const x=chcEl('button',null,'✕'); x.type='button'; x.addEventListener('click',()=>{ cv.reply=null; n.cvDirty=true; }); n.cvRep.append(x); }
  n.cvHint.textContent=cv.hint||''; n.cvHint.hidden=!cv.hint; cv.hint='';
  n.unreadN=convs.reduce((s,c)=>s+(c.key===cv.open ? 0 : c.unread),0);
  if(cv.open){ if(stick) body.scrollTop=body.scrollHeight; else body.scrollTop=top; } else body.scrollTop=0;
  n.cvDirty=false;
}
