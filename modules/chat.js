"use strict";
/* ============================ CHAT ============================
   Окно переписки: вход text — входящие сообщения (добавляются при смене строки), поле внизу — исходящие:
   Enter / Send кладёт сообщение в очередь, выход text держит последнее, go — импульс на один блок. */

const CH_KEEP=300;
function chPush(n,d,text){
  n.log.push({d,t:Date.now(),text}); n.dirty=true;
  if(n.log.length>CH_KEEP){ n.log.splice(0,n.log.length-CH_KEEP); n.full=true; }
}
function chSend(n,text){
  text=String(text).trim(); if(!text) return;
  n.outQ.push(text); if(n.p.echo) chPush(n,'out',text);
}
function chMsgEl(n,m){
  const e=document.createElement('div'); e.className='chat-msg chat-'+m.d;
  if(n.p.time){ const t=document.createElement('span'); t.className='chat-t'; t.textContent=new Date(m.t).toTimeString().slice(0,8); e.append(t); }
  e.append(document.createTextNode(m.text)); return e;
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
  row.append(inp,btn); box.append(log,row); n.mid.append(box);
  n.chat=box; n.logEl=log; n.shown=0; n.full=true;
}
function chRender(n){
  const log=n.logEl, stick=log.scrollHeight-log.scrollTop-log.clientHeight<24;
  if(n.full){ log.textContent=''; n.shown=0; n.full=false; }
  for(;n.shown<n.log.length;n.shown++) log.append(chMsgEl(n,n.log[n.shown]));
  if(stick) log.scrollTop=log.scrollHeight;
  n.dirty=false;
}

def({ id:'chat', title:'Chat', cat:'Output', kw:'chat messages text terminal console send receive', resize:true, w:340,
  ins:[{n:'text',t:'txt'},{n:'send',t:'txt'}],
  outs:[{n:'text',t:'txt'},{n:'go',t:'num'}],
  params:[{n:'echo',t:'check',d:true,label:'show sent messages'},
          {n:'time',t:'check',d:false,label:'timestamps',fn:n=>{ n.full=true; n.dirty=true; }},
          {n:'clear',t:'button',label:'Clear',fn:n=>{ n.log=[]; n.full=true; n.dirty=true; }}],
  init:n=>{ n.log=[]; n.outQ=[]; n.lastIn=undefined; n.lastSend=undefined; n.last=''; n.dirty=false; n.full=true; n.chat=null; },
  process(n,I){
    if(typeof I.text==='string' && I.text!==n.lastIn){ n.lastIn=I.text; if(I.text) chPush(n,'in',I.text); }
    if(typeof I.send==='string' && I.send!==n.lastSend){ n.lastSend=I.send; chSend(n,I.send); }   // исходящее с провода
    let go=0;
    if(n.outQ.length){ n.last=n.outQ.shift(); go=1; }
    return {text:n.last, go}; },
  draw(n){
    if(!n.chat || !n.chat.isConnected) chMount(n);
    if(n.dirty || n.full) chRender(n); }
});
