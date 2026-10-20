"use strict";
/* ============================ CHAT ============================
   Окно переписки: вход text — входящие сообщения (добавляются при смене строки), поле внизу — исходящие:
   Enter / Send кладёт сообщение в очередь, выход text держит последнее, go — импульс на один блок.
   Групповой чат: rows — участники (записи Table: name, avatar, online, typing) — полоса аватарок и «печатает…»;
   from — автор входящего text, rec — готовые сообщения {from, text}; у сообщений аватарка и имя автора. */

const CH_KEEP=300;
function chPush(n,d,text,from){
  n.log.push({d,t:Date.now(),text,from:from||''}); n.dirty=true;
  if(n.log.length>CH_KEEP){ n.log.splice(0,n.log.length-CH_KEEP); n.full=true; }
}
function chSend(n,text){
  text=String(text).trim(); if(!text) return;
  n.outQ.push(text); if(n.p.echo) chPush(n,'out',text);
}
const chPeople=n=>n.people||[];
const chFind=(n,name)=>chPeople(n).find(p=>p.name===name);
function chMsgEl(n,m){
  const e=document.createElement('div'); e.className='chat-msg chat-'+m.d;
  const who=m.d==='in' ? m.from : String(n.p.me||'');
  const grp=!!who && (m.d==='in' || chFind(n,who));
  const body=grp ? document.createElement('div') : e;
  if(grp){
    const p=chFind(n,who);
    e.classList.add('chat-grp');
    e.append(tcAvatar(p?.avatar,who,28));
    body.className='chat-b';
    body.append(Object.assign(document.createElement('div'),{className:'chat-n',textContent:who}));
    e.append(body);
  }
  if(n.p.time){ const t=document.createElement('span'); t.className='chat-t'; t.textContent=new Date(m.t).toTimeString().slice(0,8); body.append(t); }
  body.append(document.createTextNode(m.text)); return e;
}
// участники из rows: [{name, avatar, online, typing}]
function chSetPeople(n,rows){
  const me=String(n.p.me||'');
  n.people=rows.map(tcPerson).filter(p=>p && p.name);
  n.peopleSig=n.people.map(p=>p.name+'\u0001'+p.avatar+'\u0001'+p.online).join('\u0002');
  n.typing=n.people.filter(p=>p.typing && p.name!==me).map(p=>p.name);
  n.typSig=n.typing.join(','); n.dirty=true;
}
function chRenderBar(n){
  const bar=n.barEl; bar.textContent='';
  bar.hidden=!n.people.length;
  for(const p of n.people){
    const c=document.createElement('div'); c.className='chat-p'; c.title=p.name+(p.online ? ' · '+p.online : '');
    const av=tcAvatar(p.avatar,p.name,30); tcDot(av,p.online);
    c.append(av,Object.assign(document.createElement('span'),{textContent:p.name}));
    bar.append(c);
  }
  n.shownSig=n.peopleSig;
}
function chRenderTyping(n){
  const t=n.typEl; t.textContent='';
  t.hidden=!n.typing.length;
  if(n.typing.length) t.append(tcTypingEl(),n.typing.join(', ')+(n.typing.length>1 ? ' are typing' : ' is typing'));
  n.shownTyp=n.typSig;
}
function chMount(n){
  const box=document.createElement('div'); box.className='chat';
  const log=document.createElement('div'); log.className='chat-log';
  const row=document.createElement('div'); row.className='chat-row';
  const inp=document.createElement('input'); inp.type='text'; inp.placeholder='message…'; inp.autocomplete='off';
  const btn=document.createElement('button'); btn.textContent='Send';
  const go=()=>{ chSend(n,inp.value); inp.value=''; inp.focus(); };
  btn.addEventListener('click',go);
  inp.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter'){ e.preventDefault(); go(); } });
  box.addEventListener('pointerdown',e=>e.stopPropagation());
  box.addEventListener('wheel',e=>e.stopPropagation());
  const bar=document.createElement('div'); bar.className='chat-bar'; bar.hidden=true;
  const typ=document.createElement('div'); typ.className='chat-typ'; typ.hidden=true;
  row.append(inp,btn); box.append(bar,log,typ,row); n.mid.append(box);
  n.chat=box; n.logEl=log; n.barEl=bar; n.typEl=typ; n.shown=0; n.full=true; n.shownSig=null; n.shownTyp=null;
}
function chRender(n){
  const log=n.logEl, stick=log.scrollHeight-log.scrollTop-log.clientHeight<24;
  if(n.full){ log.textContent=''; n.shown=0; n.full=false; }
  for(;n.shown<n.log.length;n.shown++) log.append(chMsgEl(n,n.log[n.shown]));
  if(n.shownSig!==n.peopleSig){ chRenderBar(n); n.full=true; chRender(n); return; }   // аватарки сообщений следуют за участниками
  if(n.shownTyp!==n.typSig) chRenderTyping(n);
  if(stick) log.scrollTop=log.scrollHeight;
  n.dirty=false;
}

def({ id:'chat', title:'Chat', cat:'Output', kw:'chat messages text terminal console send receive', resize:true, w:340, bare:true,
  ins:[{n:'text',t:'txt'},{n:'send',t:'txt'},{n:'from',t:'txt'},{n:'rec',t:'rec'},{n:'rows',t:'bands'}],
  outs:[{n:'text',t:'txt'},{n:'go',t:'num'}],
  params:[{n:'echo',t:'check',d:true,label:'show sent messages'},
          {n:'time',t:'check',d:false,label:'timestamps',fn:n=>{ n.full=true; n.dirty=true; }},
          {n:'me',t:'text',d:'',label:'my name (in rows)',fn:n=>{ n.full=true; n.dirty=true; n.peopleSig=null; }},
          {n:'clear',t:'button',label:'Clear',fn:n=>{ n.log=[]; n.full=true; n.dirty=true; }}],
  init:n=>{ n.log=[]; n.outQ=[]; n.lastIn=undefined; n.lastSend=undefined; n.last=''; n.people=[]; n.typing=[]; n.peopleSig=''; n.typSig=''; n.lastRec=undefined; n.lastRows=undefined; n.dirty=false; n.full=true; n.chat=null; },
  process(n,I){
    if(Array.isArray(I.rows) && I.rows!==n.lastRows){ n.lastRows=I.rows; chSetPeople(n,I.rows); }
    if(typeof I.text==='string' && I.text!==n.lastIn){
      n.lastIn=I.text;
      const solo=chPeople(n).filter(p=>p.name!==String(n.p.me||''));
      if(I.text) chPush(n,'in',I.text,typeof I.from==='string' && I.from ? I.from : solo.length===1 ? solo[0].name : '');   // в диалоге автор — собеседник
    }
    if(I.rec && I.rec!==n.lastRec){
      n.lastRec=I.rec;
      for(const r of Array.isArray(I.rec) ? I.rec : [I.rec]){
        if(!r || typeof r!=='object') continue;
        const text=r.text ?? r.msg ?? r.message, from=String(r.from ?? r.name ?? r.user ?? '');
        if(text!=null && text!=='') chPush(n,from && from===String(n.p.me||'') ? 'out' : 'in',String(text),from);
      }
    }
    if(typeof I.send==='string' && I.send!==n.lastSend){ n.lastSend=I.send; chSend(n,I.send); }   // исходящее с провода
    let go=0;
    if(n.outQ.length){ n.last=n.outQ.shift(); go=1; }
    return {text:n.last, go}; },
  draw(n){
    if(!n.chat || !n.chat.isConnected) chMount(n);
    if(n.dirty || n.full) chRender(n); }
});
