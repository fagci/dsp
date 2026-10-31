"use strict";
/* ============================ Phone Alarm Clock (DSP app) ============================
   Все будильники телефона в одном узле: список из приложения (время, дни, название, радио), строка включает/выключает,
   ✎ грузит будильник в поля ниже («Set alarm» заменяет будильник с тем же именем), ▶ звонит сразу, ✕ удаляет;
   во время звонка Snooze / Stop дублируют кнопки на экране блокировки. Звонит само приложение (AlarmManager.setAlarmClock):
   будильник сработает и без запущенной страницы/моста, переживает перезагрузку и смену часового пояса.
   Команды и записи — WebSocket-мост приложения, как у Phone Actions (ядро — alarmclock-kernels.js, tools/test-alarmclock.mjs;
   протокол — tools/android/README.md, alarm.*). */

function acStop(n){
  n.want=false; clearTimeout(n.timer); n.timer=null; clearTimeout(n.listT); n.listT=null;
  const ws=n.ws; n.ws=null;
  if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
  n.status='disconnected';
}
function acSubSend(n){
  const m=JSON.stringify({sub:n.p.alarmEv ? ['sys'] : []});
  if(n.ws && n.ws.readyState===1 && m!==n.sentSub){ n.sentSub=m; n.ws.send(m); }
}
function acStart(n){
  acStop(n);
  let key=''; try{ key=(window.DspApp && DspApp.appKey && DspApp.appKey()) || ''; }catch(e){}
  const url=phoneUrl(n.p.url,key);
  if(!url){ n.status=(typeof gwErr==='function' && gwErr(n.p.url))||'URL must start with ws:// or wss://'; return; }
  n.want=true; n.warn=netInsecure(url) ? NET_INSECURE_MSG : '';
  let ws;
  try{ ws=new WebSocket(url); }catch(e){ n.status='error: '+e.message; return; }
  n.ws=ws; n.status='connecting…'; n.sentSub=null;
  ws.onopen=()=>{ n.status='connected'; acSubSend(n); acList(n); for(const c of n.pend.splice(0)) acSend(n,c); };
  ws.onerror=()=>{ n.status='connection error — is the DSP app running?'; };
  ws.onclose=e=>{
    if(n.ws!==ws) return;
    n.ws=null; n.status='closed'+(e.code!==1000 ? ' ('+e.code+')' : '')+(n.p.reconnect ? ' — reconnecting…' : '');
    if(n.want && n.p.reconnect){ clearTimeout(n.timer); n.timer=setTimeout(()=>{ if(n.want) acStart(n); },3000); }
  };
  ws.onmessage=e=>{
    if(typeof e.data!=='string') return;
    let j; try{ j=JSON.parse(e.data); }catch(x){ return; }
    for(const r of Array.isArray(j) ? j : [j]) acFeed(n,r);
  };
}
// команда ушла сразу или ждёт соединения (его открывает сама)
function acSend(n,cmd){
  if(!cmd) return;
  if(cmd.error){ n.last=cmd.error; return; }
  if(!n.ws || n.ws.readyState!==1){
    n.pend.push(cmd); if(n.pend.length>20) n.pend.shift();
    if(!n.ws) acStart(n);
    return;
  }
  n.ws.send(JSON.stringify({...cmd,id:++n.seq}));
}
// свежий список из приложения: прямо сейчас или (soon) слитно после событий/ответов
function acList(n,soon){
  if(!n.ws || n.ws.readyState!==1) return;
  if(soon){ if(!n.listT) n.listT=setTimeout(()=>{ n.listT=null; acList(n); },700); return; }
  clearTimeout(n.listT); n.listT=null; n.rowsBuf=[];
  n.ws.send(JSON.stringify({cmd:'alarm.list',id:++n.seq}));
}
function acFeed(n,r){
  if(!r || typeof r!=='object') return;
  n.count++;
  if(r.src==='bridge'){ if(r.level==='error' || r.level==='warn') n.bridgeMsg=r.msg; return; }
  const line=alLine(r); if(line) n.last=line;
  if(r.src==='cmd'){
    n.ok=r.ok?1:0;
    if(r.cmd==='alarm.list' && r.ok){ n.alarms=alSort(n.rowsBuf.splice(0)); n.listSig=''; }
    else if(/^alarm\./.test(r.cmd||'') && r.cmd!=='alarm.list') acList(n,true);   // состав поменялся (или команда не прошла — список на странице устарел): показать свежий
  }
  if(r.src==='alarm') n.rowsBuf.push(alRow(r));
  if(r.src==='sys' && String(r.ev||'').startsWith('alarm.')){
    if(r.ev==='alarm.fire') n.ringing=1;
    if(r.ev==='alarm.snooze' || r.ev==='alarm.dismiss' || r.ev==='alarm.silent') n.ringing=0;
    acList(n,true);
  }
  n.fresh=1;
  n.recQ.push({t:Date.now(),...r});
  if(n.recQ.length>2000) n.recQ.splice(0,n.recQ.length-2000);
}
// команда из строки списка: сразу показать результат на странице, потом приложение подтвердит (или список поправится сам)
function acDo(n,cmd){ n.alarms=alOptimistic(n.alarms,cmd); n.listSig=''; acSend(n,cmd); }
// будильник из строки списка → в поля редактора
function acEdit(n,a){
  n.p.name=a.name; n.p.time=a.time;
  n.p.days=AL_DAYS_OPTS.includes(a.days) ? a.days : 'custom';
  if(n.p.days==='custom') n.p.daysCustom=a.days;
  n.p.label=a.label; n.p.stream=a.url; n.p.sample=a.sample||'default';
  n.last='editing «'+a.name+'» — change the fields, press Set alarm';
  rebuildNode(n); markTopoDirty();
}
// стили строк — инлайном: модуль самодостаточен, styles.css не трогаем
function acRowEl(n,a){
  const row=document.createElement('div'); row.className='alm-row';
  row.style.cssText='display:flex;align-items:center;gap:6px;padding:3px 4px;border:1px solid var(--line);border-radius:3px;background:var(--bg);font:11px/1.3 var(--mono)'+(a.enabled?'':';opacity:.55');
  const t=document.createElement('button'); t.className='alm-time'; t.textContent=a.time; t.title='edit this alarm';
  t.style.cssText='font-size:15px;font-weight:600;color:var(--txt);background:none;border:0;cursor:pointer;padding:0 2px;font-family:inherit';
  t.addEventListener('click',()=>acEdit(n,a));
  const info=document.createElement('span');
  info.textContent=a.name+(a.days&&a.days!=='once' ? ' · '+a.days : '')+(a.label ? ' · '+a.label : '')+(a.url ? ' · 📻' : '');
  info.title=info.textContent+(a.url ? '\n'+a.url : '');
  info.style.cssText='flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dim)';
  const mk=(txt,title,fn)=>{ const b=document.createElement('button'); b.className='alm-b'; b.textContent=txt; b.title=title;
    b.style.cssText='flex:none;min-width:26px;padding:1px 6px;font:10px var(--mono);cursor:pointer;background:var(--panel2);color:var(--txt);border:1px solid var(--line);border-radius:3px';
    b.addEventListener('click',e=>{ e.stopPropagation(); fn(); }); return b; };
  row.append(t,info,
    mk(a.enabled?'on':'off','enable / disable (the alarm stays in the phone)',()=>acDo(n,alToggleCmd(a))),
    mk('▶','ring it now',()=>acSend(n,{cmd:'alarm.test',name:a.name})),
    mk('✕','remove',()=>acDo(n,{cmd:'alarm.remove',name:a.name})));
  const sw=row.querySelector('.alm-b'); if(sw && a.enabled){ sw.style.color='var(--acc2)'; sw.style.borderColor='var(--acc2)'; }
  return row;
}
function acRenderList(n){
  const box=n.almEl; box.textContent='';
  if(!n.alarms.length){ const e=document.createElement('div');
    e.textContent=n.ws && n.ws.readyState===1 ? 'no alarms in the phone yet — set one below' : 'connect to the DSP app to see the alarms';
    e.style.cssText='color:var(--dim);font:11px/1.4 var(--mono);padding:4px 2px'; box.append(e); }
  for(const a of n.alarms) box.append(acRowEl(n,a));
  n.listSig=n.alarms.map(a=>a.name+a.time+a.days+a.enabled+a.label+a.url).join('');
}

def({ id:'alarmclock', title:'Phone Alarm Clock (DSP app)', cat:'Output', kw:'android app phone alarm clock alarms list wake up radio stream snooze dismiss schedule morning reminder будильник будильники',
  ins:[{n:'go',t:'num'},{n:'cmd',t:'rec'}],
  outs:[{n:'rec',t:'rec'},{n:'next',t:'txt'},{n:'ringing',t:'num'},{n:'ok',t:'num'},{n:'new',t:'num'}],
  readout:true, tall:true, resize:true, w:400,
  groups:[{n:'Sound'},{n:'Snooze / limits',open:false}],
  params:[
    {n:'url',t:'text',d:'ws://127.0.0.1:8765',dev:true,label:'bridge of the DSP app — an address, or @name from Settings → Devices'},
    {n:'name',t:'text',d:'wake',label:'alarm name (id) — Set replaces the alarm with the same name'},
    {n:'time',t:'text',d:'7:00',label:'time HH:MM'},
    {n:'days',t:'select',opts:AL_DAYS_OPTS,d:'weekdays',label:'days'},
    {n:'daysCustom',t:'text',d:'mon,wed,fri',label:'custom days (mon,tue…)',if:n=>n.p.days==='custom'},
    {n:'label',t:'text',d:'',label:'title on the lock screen'},
    {n:'stream',t:'text',d:'',label:'internet radio stream (http/https, .pls, .m3u, HLS) — plays on the alarm volume',g:'Sound'},
    {n:'sample',t:'text',d:'default',label:'fallback if the stream does not load or drops — file path / content:// / address; default — the system alarm tone, beep — built-in beeps',g:'Sound'},
    {n:'loadSec',t:'range',min:3,max:60,step:1,d:12,label:'wait for the stream to start, s (then the fallback)',g:'Sound'},
    {n:'ramp',t:'range',min:0,max:300,step:5,d:20,label:'volume rises over, s (0 — at once)',g:'Sound'},
    {n:'vol',t:'range',min:0,max:100,step:5,d:0,label:'alarm volume, % of the maximum (0 — leave as set)',g:'Sound'},
    {n:'snoozeMin',t:'range',min:1,max:120,step:1,d:9,label:'snooze, min',g:'Snooze / limits'},
    {n:'maxMin',t:'range',min:1,max:60,step:1,d:15,label:'stops ringing by itself after, min',g:'Snooze / limits'},
    {n:'alarmEv',t:'check',d:true,label:'alarm events (fire, fallback, snooze, dismiss…) → rec (asks for «phone state» permission)'},
    {n:'reconnect',t:'check',d:true,label:'reconnect'},
    {n:'set',t:'button',label:'Set alarm',fn:n=>acSend(n,alSetCmd(n.p))},
    {n:'test',t:'button',label:'Test now',fn:n=>{ const c=alSetCmd(n.p); acSend(n,c.error?{cmd:'alarm.test'}:{cmd:'alarm.test',url:c.url,sample:c.sample,ramp:3}); }},
    {n:'refresh',t:'button',label:'Refresh',fn:n=>acList(n)},
    {n:'snooze',t:'button',label:'Snooze',fn:n=>acSend(n,{cmd:'alarm.snooze'})},
    {n:'stop',t:'button',label:'Stop',fn:n=>acSend(n,{cmd:'alarm.stop'})},
    {n:'connect',t:'button',label:'Connect',fn:n=>acStart(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>acStop(n)},
  ],
  init:n=>{ n.ws=null; n.want=false; n.timer=null; n.listT=null; n.pend=[]; n.seq=0; n.count=0; n.ok=0; n.fresh=0;
            n.status='not connected'; n.warn=''; n.sentSub=null; n.bridgeMsg=''; n.last=''; n.prevGo=0; n.lastCmd=null;
            n.recQ=[]; n.rowsBuf=[]; n.alarms=[]; n.ringing=0; n.almEl=null; n.listSig=''; },
  dispose:n=>acStop(n),
  process(n,I){
    acSubSend(n);
    const go=(I.go||0)>.5; if(go && !n.prevGo) acSend(n,alSetCmd(n.p)); n.prevGo=go;
    if(Array.isArray(I.cmd) && I.cmd!==n.lastCmd){                   // записи с полем cmd уходят как есть
      n.lastCmd=I.cmd;
      for(const r of I.cmd) if(r && typeof r.cmd==='string') acSend(n,r);
    }
    const rec=n.recQ.length ? n.recQ.splice(0) : null, fresh=n.fresh; n.fresh=0;
    return {rec, next:alNextText(n.alarms,Date.now())||null, ringing:n.ringing, ok:n.ok, new:fresh};
  },
  draw(n){
    if(!n.almEl || !n.almEl.isConnected){
      const box=document.createElement('div'); box.className='alm';
      box.style.cssText='grid-column:1/-1;display:flex;flex-direction:column;gap:3px;width:100%;min-height:0;max-height:220px;overflow:auto';
      box.addEventListener('pointerdown',e=>e.stopPropagation());
      box.addEventListener('wheel',e=>e.stopPropagation());
      n.mid.append(box); n.almEl=box; n.listSig='';
    }
    const sig=n.alarms.map(a=>a.name+a.time+a.days+a.enabled+a.label+a.url).join('');
    if(sig!==n.listSig) acRenderList(n);
    const r=n.el.querySelector('.readout'); if(!r) return;
    let t=(n.warn&&!n.ws&&n.status!=='connected' ? '⚠ '+n.warn+'\n' : '')+n.status+' · alarms '+n.alarms.length+(n.ringing?' · RINGING':'');
    if(n.bridgeMsg) t+='\n⚠ '+n.bridgeMsg;
    const nx=alNextText(n.alarms,Date.now()); if(nx) t+='\nnext: '+nx;
    if(n.last) t+='\n'+n.last;
    if(r.textContent!==t) r.textContent=t; }
});
