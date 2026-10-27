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
