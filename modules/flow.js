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

/* ============================ Cases (If → Value / Command) ============================
   Несколько состояний вместо одного условия: строка «[имя:] условие => значение => {команда}», выигрывает первая подошедшая, а при
   отсутствии подошедших состояние держится (поэтому события вроде «вошёл в зону» работают как уровни). В условиях: r — последняя запись,
   a b c d — числа с одноимённых входов (не подключён — undefined). Значение — число (433.92M) или выражение; выходы val / state / name,
   s1…s4 (уровни первых четырёх строк), cmd — команда при входе в строку, changed — импульс смены. Разбор — modules/flow-kernels.js (tools/test-flow.mjs). */
const CASES_TPL0='— add an example line —';
const CASES_TPL={
  'level on / off':'on: a>=.5 => 1\noff: a<.5 => 0',
  'value by place (e.g. SDR frequency; a = Geofence «in»)':'home: a==1 => 145.5M\naway: a==0 => 433.92M',
  'by level with a command (a = light)':'dark: a<10 => 1 => {"cmd":"torch","on":true}\nbright: a>=10 => 0 => {"cmd":"torch","on":false}',
  'by record field (Geofence events)':"enter: r && r.ev==='enter' => 1 => {\"cmd\":\"notify\",\"title\":\"Zone\",\"text\":\"$zone\"}\nexit: r && r.ev==='exit' => 0",
  'value from an expression':'scaled: true => a*2+b',
};
function casesCompile(n){
  const {rows,errors}=casesParse(n.p.cases), src=casesSource(rows), tok=n._ct={};
  n.src=n.p.cases; n.rows=rows; n.perr=errors.join('; '); n.ready=false; n.fns=null; n.st={cur:-1,cand:-1,since:0};
  const url=URL.createObjectURL(new Blob([src],{type:'text/javascript'}));
  import(url).then(m=>{ if(n._ct===tok){ n.fns=m.default; n.ready=true; n.err=''; } })
    .catch(e=>{ if(n._ct===tok){ n.err=e.message; } })
    .finally(()=>URL.revokeObjectURL(url));
}
def({ id:'cases', title:'Cases (If → Value / Command)', cat:'Control', kw:'automation switch states conditions if else value command geofence frequency level hysteresis multiple state machine',
  ins:[{n:'rec',t:'rec'},{n:'a',t:'num'},{n:'b',t:'num'},{n:'c',t:'num'},{n:'d',t:'num'}],
  outs:[{n:'val',t:'num'},{n:'state',t:'num'},{n:'name',t:'txt'},{n:'cmd',t:'rec'},{n:'changed',t:'num'},{n:'s1',t:'num'},{n:'s2',t:'num'},{n:'s3',t:'num'},{n:'s4',t:'num'}],
  readout:true,
  params:[
    {n:'cases',t:'code',plain:true,d:'home: a==1 => 145.5M\naway: a==0 => 433.92M',label:'states, one per line: [name:] condition => value => {command JSON}. First match wins; no match — keeps the state. r — last record, a b c d — inputs; value 433.92M / 2k / expression; "$field" in a command takes a field of r'},
    {n:'settle',t:'range',min:0,max:300,step:.5,d:0,label:'a new state must hold for, s (0 — switch at once)'},
    {n:'tpl',t:'select',opts:[CASES_TPL0,...Object.keys(CASES_TPL)],d:CASES_TPL0,label:'add an example to the list above'},
  ],
  init:n=>{ n.lastR=null; n.src=null; n.rows=[]; n.fns=null; n.ready=false; n.err=''; n.perr=''; n.st={cur:-1,cand:-1,since:0}; n.sent=0; n.valErr=''; n.val=null; },
  process(n,I){
    if(n.p.tpl!==CASES_TPL0){ const t=CASES_TPL[n.p.tpl]; if(t) setMod(n,'cases',(n.p.cases ? n.p.cases.replace(/\n*$/,'\n') : '')+t); setMod(n,'tpl',CASES_TPL0); }
    const recs=recList(I.rec);
    if(recs.length) n.lastR=recs[recs.length-1];
    if(n.src!==n.p.cases) casesCompile(n);
    const num=v=>typeof v==='number' && isFinite(v) ? v : undefined;
    const args=[n.lastR,num(I.a),num(I.b),num(I.c),num(I.d)];
    let changed=0, cmd=null, idx=-1;
    if(n.ready && n.fns){
      for(let i=0;i<n.fns.length;i++){
        try{ if(n.fns[i][0](...args)){ idx=i; break; } }catch(e){ n.err='line '+n.rows[i].line+': '+e.message; }
      }
      if(casesStep(n.st,idx,Date.now(),n.p.settle)){
        changed=1; const row=n.rows[n.st.cur];
        if(row && row.cmd){ cmd=[ruleApply(row.cmd,n.lastR)]; n.sent++; }
      }
    }
    const cur=n.st.cur, row=n.rows[cur];
    let val=null;
    if(row){
      if(row.val!=null) val=row.val;
      else if(n.fns && n.fns[cur] && n.fns[cur][1]){ try{ const v=+n.fns[cur][1](...args); val=isFinite(v) ? v : null; }catch(e){ n.err='line '+row.line+': '+e.message; } }
    }
    n.val=val;
    return {val, state:cur, name:row ? row.name : '', cmd, changed, s1:cur===0?1:0, s2:cur===1?1:0, s3:cur===2?1:0, s4:cur===3?1:0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const row=n.rows[n.st.cur];
    let t=(row ? row.name+' (#'+(n.st.cur+1)+')' : 'no state yet')+' · value '+(n.val==null ? '—' : +n.val.toPrecision(9))+' · sent '+n.sent;
    if(n.perr) t+='\n⚠ '+n.perr;
    if(n.err) t+='\n⚠ '+n.err;
    if(r.textContent!==t) r.textContent=t; }
});
