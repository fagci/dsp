"use strict";
/* ============================ Rec Queue ============================
   Для-каждого-с-ожиданием: записи с входа становятся очередью, выдаются по одной — после ответа (ack), по таймеру или по шагу (next).
   Нужен для автопоиска (нашли устройство → подключились → подождали ответ → следующее) без отдельных Control-блоков на каждый шаг.
   Ядро — modules/flow-kernels.js (без DOM, проверяется tools/test-flow.mjs); lgEdge — общий детектор фронта (modules/logic.js). */

def({ id:'recQueue', title:'Rec Queue', cat:'Control', kw:'queue for each loop sequence automation wait ack next item one at a time',
  ins:[{n:'rec',t:'rec'},{n:'next',t:'num'},{n:'ack',t:'num'},{n:'clear',t:'num'}],
  outs:[{n:'item',t:'rec'},{n:'go',t:'num'},{n:'done',t:'num'},{n:'qlen',t:'num'},{n:'sent',t:'num'}],
  readout:true,
  params:[
    {n:'mode',t:'select',opts:['wait for ack','every period','on next only'],d:'wait for ack',label:'release the next item'},
    {n:'interval',t:'range',min:0,max:60,step:.1,d:1,label:'period, s (mode: every period)'},
    {n:'timeout',t:'range',min:0,max:120,step:1,d:10,label:'give up waiting for ack after, s (0 — forever; mode: wait for ack)'},
    {n:'key',t:'text',d:'',label:'skip repeats by field (empty — queue everything)'},
    {n:'max',t:'range',min:1,max:5000,step:1,d:500,label:'queue limit'},
  ],
  init:n=>{ n.st=rqNew(); n.lg={}; },
  process(n,I){
    rqPush(n.st,I.rec,String(n.p.key||'').trim(),+n.p.max||500);
    const mode=n.p.mode==='every period' ? 'interval' : n.p.mode==='on next only' ? 'manual' : 'await';
    const r=rqStep(n.st,{next:lgEdge(n,'n',I.next),ack:lgEdge(n,'a',I.ack),clear:lgEdge(n,'c',I.clear)},Date.now(),{mode,interval:+n.p.interval,timeout:+n.p.timeout});
    return {item:r.item, go:r.item?1:0, done:r.done?1:0, qlen:n.st.q.length, sent:n.st.sent};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t='queued '+n.st.q.length+' · sent '+n.st.sent+(n.st.busy ? ' · waiting for ack' : '')+(n.st.cur ? '\n→ '+JSON.stringify(n.st.cur).slice(0,200) : '');
    if(r.textContent!==t) r.textContent=t; }
});

/* ============================ Rule (If → Command) ============================
   Условие (JS-выражение над последней подошедшей записью r — rec с датчика, геозоны, событий sys…) → при переходе в «истина»
   (или всё время, пока истина) выдаёт готовую команду («cmd» rec); «on» — просто уровень условия (0/1), его можно подать на вход-пин
   чекбокса любого узла (Phone sensors: wifi, ble, bt…). Шаблоны команд — в списке «tpl». Выход cmd годится прямо во вход cmd у BLE GATT / Bluetooth,
   Network, Phone Control & Automation и Phone Actions (все они принимают записи с полем cmd как есть). Строковое значение "$имя"
   в команде берёт поле из той же записи r. ruleApply — modules/flow-kernels.js (tools/test-flow.mjs); условие компилируется
   так же, как у Rec Filter (recFilterCompile, modules/geo.js). */
const RULE_TPL0='— insert a command template —';
const RULE_TPL={
  'vibrate':'{"cmd":"vibrate","ms":300}',
  'notification (text from the record: $zone, $ev…)':'{"cmd":"notify","title":"Rule","text":"$zone $ev"}',
  'speak aloud':'{"cmd":"tts.speak","text":"Rule fired"}',
  'torch on':'{"cmd":"torch","on":true}',
  'torch off':'{"cmd":"torch","on":false}',
  'toast on screen':'{"cmd":"toast","text":"Rule fired"}',
  'launch an app':'{"cmd":"app.launch","pkg":"com.android.chrome"}',
  'media: play / pause':'{"cmd":"media","key":"toggle"}',
};
def({ id:'rule', title:'Rule (If → Command)', cat:'Control', kw:'automation if then condition trigger rule command action geofence sys event',
  ins:[{n:'rec',t:'rec'}], outs:[{n:'cmd',t:'rec'},{n:'go',t:'num'},{n:'on',t:'num'}],
  readout:true,
  params:[
    {n:'expr',t:'text',d:"r && r.src==='sys' && r.ev==='screen' && r.on==0",label:'condition (r — last record); true/false'},
    {n:'fire',t:'select',opts:['becomes true','stays true (repeat)'],d:'becomes true',label:'send the command'},
    {n:'cooldown',t:'range',min:0,max:3600,step:1,d:0,label:'at least, s between commands (0 — no limit)'},
    {n:'tpl',t:'select',opts:[RULE_TPL0,...Object.keys(RULE_TPL)],d:RULE_TPL0,label:'fill the command below from a template'},
    {n:'cmd',t:'code',plain:true,d:'{"cmd":"vibrate","ms":300}',label:'command when true (JSON; a string value "$field" is replaced with that field of r)'},
  ],
  init:n=>{ n.was=false; n.lastFire=0; n.sent=0; n.err=''; n.lastR=null; n._tmpl=null; n._tmplSrc=null; n.tmplErr=''; },
  process(n,I){
    if(n.p.tpl!==RULE_TPL0){ const t=RULE_TPL[n.p.tpl]; if(t) setMod(n,'cmd',t); setMod(n,'tpl',RULE_TPL0); }
    const recs=recList(I.rec);
    if(recs.length) n.lastR=recs[recs.length-1];
    if(!n._fn || n._fn.src!==(n.p.expr||'true')) recFilterCompile(n);
    let truthy=n.was;
    if(n._fn.ready) truthy = n._fn.f ? (()=>{ try{ const v=!!n._fn.f(n.lastR); n.err=''; return v; }catch(e){ n.err=e.message; return false; } })() : false;
    const edge=truthy && !n.was, repeat=truthy && n.p.fire==='stays true (repeat)';
    n.was=truthy;
    let cmd=null, go=0;
    if(edge || repeat){
      const now=Date.now(), cd=+n.p.cooldown*1000;
      if(!cd || now-n.lastFire>=cd){
        n.lastFire=now;
        if(n._tmplSrc!==n.p.cmd){ n._tmplSrc=n.p.cmd; try{ n._tmpl=JSON.parse(n.p.cmd||'{}'); n.tmplErr=''; }catch(e){ n._tmpl=null; n.tmplErr=e.message; } }
        if(n._tmpl){ cmd=[ruleApply(n._tmpl,n.lastR)]; go=1; n.sent++; }
      }
    }
    return {cmd, go, on:truthy ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    let t=(n.was?'true':'false')+' · sent '+n.sent;
    if(n.err) t+='\n⚠ condition: '+n.err;
    if(n.tmplErr) t+='\n⚠ command JSON: '+n.tmplErr;
    if(r.textContent!==t) r.textContent=t; }
});
