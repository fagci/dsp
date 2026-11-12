"use strict";
/* ============================ Контроллер репитера: DTMF-команды ============================
   Чистая логика без DOM (страница и Node). Пара «разбор ↔ сборка» зеркальна (tools/test-repctl.mjs): rcParse ↔ rcBuild.
   Команда: «*» + пароль + код команды + аргумент(ы) + «#», например *1234 1 05 # (связать узел 05):
     1 nn — связать с узлом nn, 0 nn — отвязать (0 без аргумента — отвязать все), 8 — экстренный режим вкл, 9 — выкл,
     5 — передать позывной сейчас, 7 — репитер выключить (не ретранслировать), 6 — включить.
   Автомат (rcNew / rcStep): тишина между цифрами > digitTimeout — набор сброшен; 3 неверных пароля подряд — блокировка команд
   на lockout секунд; PTT = несущая (COS) + «хвост» hang; несущая дольше tot секунд — таймаут передатчика (PTT снят до
   пропажи несущей); позывной — раз в idEvery секунд во время работы и по окончании передачи, если с прошлого прошло ≥ idMin.
   Экстренный режим: таймаут отключён, хвост не короче 5 с, позывной вдвое чаще. События — {kind, text, …}. */

const RC_CMD={'1':'link','0':'unlink','8':'emergency on','9':'emergency off','5':'id now','7':'disable','6':'enable'};
const RC_CODE=Object.fromEntries(Object.entries(RC_CMD).map(([k,v])=>[v,k]));
// «*1234105#» → {ok,cmd,args} | {ok:false,why}; pass — ожидаемый пароль
function rcParse(seq,pass){
  const m=/^\*(\d+)#$/.exec(String(seq||''));
  if(!m) return {ok:false, why:'format'};
  const body=m[1], pw=String(pass);
  if(!body.startsWith(pw)) return {ok:false, why:'password'};
  const rest=body.slice(pw.length);
  if(!rest) return {ok:false, why:'empty'};
  const cmd=RC_CMD[rest[0]]; if(!cmd) return {ok:false, why:'command'};
  const args=rest.slice(1);
  if((cmd==='link') && !args) return {ok:false, why:'argument'};
  if(cmd!=='link' && cmd!=='unlink' && args) return {ok:false, why:'argument'};
  return {ok:true, cmd, args};
}
// зеркало: команда → последовательность DTMF
function rcBuild(cmd,args,pass){
  const c=RC_CODE[cmd]; if(c===undefined) return null;
  return '*'+String(pass)+c+String(args||'').replace(/\D/g,'')+'#';
}
function rcNew(cfg){
  const c=Object.assign({pass:'1234', digitTimeout:5, hang:2, tot:180, idEvery:600, idMin:30, lockout:60, minMs:40, needCos:true}, cfg||{});
  return {c, buf:'', bufT:0, bad:0, lockT:0, linked:new Set(), emergency:false, disabled:false,
    cos:false, carT:0, hangT:0, lock:false, ptt:false, active:false, sinceId:0, idT:0, prevD:-1, holdD:0, took:-1};
}
const RC_KEYS='0123456789ABCD*#';
// dt — секунды такта; digit — индекс DTMF 0..15 (или -1); cos — несущая (0/1). Возвращает список событий.
function rcStep(st,dt,digit,cos){
  const c=st.c, ev=[];
  st.cos=!c.needCos || cos>.5;
  // цифра: принимается после minMs непрерывного звучания, одна на нажатие
  if(digit>=0 && digit===st.prevD) st.holdD+=dt*1000; else { st.prevD=digit; st.holdD=0; if(digit<0) st.took=-1; }
  if(digit>=0 && st.holdD>=c.minMs && st.took!==digit){ st.took=digit; rcKey(st,RC_KEYS[digit],ev); }
  st.bufT+=dt;
  if(st.buf && st.bufT>c.digitTimeout){ st.buf=''; ev.push({kind:'timeout', text:'command timed out'}); }
  if(st.lockT>0) st.lockT=Math.max(0,st.lockT-dt);
  // несущая, TOT, хвост
  if(st.cos){ st.carT+=dt; st.hangT=st.emergency ? Math.max(c.hang,5) : c.hang; if(!st.emergency && c.tot>0 && st.carT>c.tot && !st.lock){ st.lock=true; ev.push({kind:'tot', text:'time-out: transmitter off until the carrier drops'}); } }
  else { st.carT=0; st.lock=false; st.hangT=Math.max(0,st.hangT-dt); }
  const on=!st.disabled && !st.lock && (st.cos || st.hangT>0);
  if(on!==st.ptt){ st.ptt=on; ev.push({kind:'ptt', text:on ? 'PTT on' : 'PTT off', on}); }
  // позывной
  if(on){ st.active=true; st.sinceId+=dt; const every=st.emergency ? c.idEvery/2 : c.idEvery; if(every>0 && st.sinceId>=every){ st.sinceId=0; ev.push({kind:'id', text:'station ID (periodic)'}); } }
  else if(st.active){ st.active=false; if(c.idEvery>0 && st.sinceId>=c.idMin){ st.sinceId=0; ev.push({kind:'id', text:'station ID (end of transmission)'}); } }
  return ev;
}
function rcKey(st,ch,ev){
  if(ch==='*'){ st.buf='*'; st.bufT=0; return; }
  if(!st.buf) return;
  st.buf+=ch; st.bufT=0;
  if(ch!=='#') { if(st.buf.length>24){ st.buf=''; } return; }
  const seq=st.buf; st.buf='';
  if(st.lockT>0){ ev.push({kind:'denied', text:'commands locked', why:'lockout'}); return; }
  const r=rcParse(seq,st.c.pass);
  if(!r.ok){
    if(r.why==='password' || r.why==='format'){
      if(++st.bad>=3){ st.bad=0; st.lockT=st.c.lockout; ev.push({kind:'denied', text:'3 wrong passwords: commands locked for '+st.c.lockout+' s', why:'lockout'}); }
      else ev.push({kind:'denied', text:'wrong password', why:r.why});
    } else ev.push({kind:'denied', text:'bad command ('+r.why+')', why:r.why});
    return;
  }
  st.bad=0;
  const e={kind:'cmd', cmd:r.cmd, args:r.args, text:r.cmd+(r.args ? ' '+r.args : '')};
  switch(r.cmd){
    case 'link': st.linked.add(r.args); ev.push({kind:'link', node:r.args, on:true, text:'link '+r.args+' on'}); break;
    case 'unlink':
      if(r.args){ st.linked.delete(r.args); ev.push({kind:'link', node:r.args, on:false, text:'link '+r.args+' off'}); }
      else { for(const n of st.linked) ev.push({kind:'link', node:n, on:false, text:'link '+n+' off'}); st.linked.clear(); }
      break;
    case 'emergency on': st.emergency=true; st.lock=false; ev.push({kind:'emergency', on:true, text:'EMERGENCY mode on'}); break;
    case 'emergency off': st.emergency=false; ev.push({kind:'emergency', on:false, text:'emergency mode off'}); break;
    case 'id now': st.sinceId=0; ev.push({kind:'id', text:'station ID (command)'}); break;
    case 'disable': st.disabled=true; break;
    case 'enable': st.disabled=false; break;
  }
  ev.unshift(e);
}
