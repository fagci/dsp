"use strict";
/* ============================ LEDGER ============================ */
// Учёт и планирование по таблицам: операции (факты), правила повторений (план) и начальные остатки.
// Всё — строки Table, поэтому редактор, импорт CSV, поля, связи и карточки уже есть; узел только
// считает. Любая дата, прошлая или будущая: at = today / 2026-12-31 / +3m / -1y.
//
// rows  — операции: date, amount (со знаком) или income/outcome, account, type, category…
// rules — повторения: start, period, every, end/count, amount/last/amounts, weekday, monthday…
// base  — начальные остатки: account, amount, currency, date.
// Выходы: rows / rec — все движения (факт + план) с balance (по счёту) и total (всего);
// accounts — остаток на дату по каждому счёту; series — ряд для Table Chart (t / date / balance);
// next — ближайшие будущие движения; balance — итог на дату.
//
// Колонки не обязаны называться одинаково: txmap / rmap / bmap — «роль=колонка» по строке,
// пусто — автоопределение (date, income, outcome, payee, categoryName… — формат ZenMoney).
// Логика — modules/ledger-kernels.js, тест — node tools/test-ledger.mjs.

const LG_RULE_MAP_TIP='role=column, one per line; empty — auto. Roles:\nstart end count period every weekday monthday amount last amounts type account to category name currency skip id note\nExample: start=начало, amount=сумма, account=счёт, type=тип';
const LG_TX_MAP_TIP='role=column, one per line; empty — auto. Roles:\ndate amount in out account inAccount outAccount type category name note currency inCurrency outCurrency id transfer to rate skip\nZenMoney: in=income, out=outcome, inAccount=incomeAccountName, outAccount=outcomeAccountName, name=payee, category=categoryName, note=comment.\nWrite amount=none to disable the signed amount and use only in/out.';
const LG_BASE_MAP_TIP='role=column, one per line; empty — auto. Roles: account amount currency date id';

def({ id:'ledger', title:'Ledger', cat:'Data',
  kw:'finance money budget account balance income expense transaction csv plan recurring schedule loan credit payment subscription table rows ledger forecast',
  ins:[{n:'rows',t:'bands'},{n:'rules',t:'bands'},{n:'base',t:'bands'},{n:'rec',t:'rec'},{n:'at',t:'val'}],
  outs:[{n:'rows',t:'bands'},{n:'rec',t:'rec'},{n:'accounts',t:'bands'},{n:'series',t:'bands'},
        {n:'next',t:'rec'},{n:'balance',t:'num'},{n:'count',t:'num'},{n:'at',t:'txt'},{n:'ok',t:'num'}],
  readout:true, tall:true, w:380, h:280,
  params:[
    {n:'at',t:'text',d:'today',label:'state at',tip:'today, 2026-12-31, +3m, -1y, or a date from the at input. Past and future use the same rules'},
    {n:'from',t:'text',d:'',label:'series from',tip:'empty — the first event or the earliest rule'},
    {n:'to',t:'text',d:'',label:'series to',tip:'empty — state at + future months, but not shorter than the last actual event'},
    {n:'bucket',t:'select',opts:['day','week','month','year','none'],d:'month',label:'series step'},
    {n:'account',t:'text',d:'',label:'balance account',tip:'empty — the sum of all accounts'},
    {n:'currency',t:'text',d:'',label:'currency',tip:'empty — all currencies are added as numbers; set it to keep one currency'},
    {n:'include',t:'select',opts:['all','actual','rules'],d:'all',label:'include',tip:'all — facts and the plan; actual — only rows; rules — only recurring rules'},
    {n:'horizon',t:'num',min:0,max:600,step:1,d:24,label:'future, months',tip:'how far open-ended rules are expanded when series to is empty'},
    {n:'next',t:'num',min:0,max:100,step:1,d:8,label:'next events'},
    {n:'limit',t:'num',min:100,max:200000,step:100,d:50000,label:'max occurrences',adv:true},
    {n:'perAccount',t:'check',d:false,label:'series per account',tip:'add a row per account to series (by account), otherwise only the total (*)'},
    {n:'defaultAccount',t:'text',d:'main',label:'account when empty',adv:true},
    {n:'txmap',t:'code',plain:true,d:'',label:'transactions: role=column',tip:LG_TX_MAP_TIP},
    {n:'rmap',t:'code',plain:true,d:'',label:'rules: role=column',tip:LG_RULE_MAP_TIP},
    {n:'bmap',t:'code',plain:true,d:'',label:'opening balances: role=column',tip:LG_BASE_MAP_TIP,adv:true}
  ],
  init:n=>{
    n.res=null; n.err='';
    n._rows=null; n._rowsLen=-1; n._rules=null; n._rulesLen=-1; n._base=null; n._baseLen=-1;
    n._live=null; n._liveLen=-1; n._atVal=null; n._psig='';
  },
  process(n,I){
    const p=n.p;
    const rows=Array.isArray(I.rows) ? I.rows : (I.rows ? [I.rows] : []);
    const rules=Array.isArray(I.rules) ? I.rules : (I.rules ? [I.rules] : []);
    const base=Array.isArray(I.base) ? I.base : (I.base ? [I.base] : []);
    const live=I.rec ? (Array.isArray(I.rec) ? I.rec : [I.rec]) : null;
    const at=typeof I.at==='string' && I.at.trim() ? I.at.trim() : (typeof I.at==='number' ? I.at : p.at);
    const psig=[p.at,p.from,p.to,p.bucket,p.account,p.currency,p.include,p.horizon,p.next,p.limit,p.perAccount,p.defaultAccount,p.txmap,p.rmap,p.bmap].join('\u0001');
    if(n._rows!==rows || n._rowsLen!==rows.length || n._rules!==rules || n._rulesLen!==rules.length ||
       n._base!==base || n._baseLen!==base.length || n._live!==live || n._liveLen!==(live?live.length:-1) ||
       n._atVal!==at || n._psig!==psig){
      n._rows=rows; n._rowsLen=rows.length; n._rules=rules; n._rulesLen=rules.length;
      n._base=base; n._baseLen=base.length; n._live=live; n._liveLen=live?live.length:-1;
      n._atVal=at; n._psig=psig;
      const allRows=live && live.length ? rows.concat(live) : rows;
      try{
        n.res=lgCompute({rows:allRows,rules,base,at,from:p.from,to:p.to,bucket:p.bucket,account:p.account,
          currency:p.currency,include:p.include,horizon:p.horizon,next:p.next,limit:p.limit,
          perAccount:p.perAccount,defaultAccount:p.defaultAccount,txMap:p.txmap,rMap:p.rmap,bMap:p.bmap});
        n.err='';
      }catch(e){ n.res=null; n.err='ledger: '+(e && e.message || e); }
    }
    const r=n.res;
    if(!r) return {rows:null,rec:null,accounts:null,series:null,next:null,balance:0,count:0,at:'',ok:0};
    return {
      rows:r.rowsOut.length ? r.rowsOut : null,
      rec:r.rowsOut.length ? r.rowsOut : null,
      accounts:r.accounts.length ? r.accounts : null,
      series:r.series.length ? r.series : null,
      next:r.next.length ? r.next : null,
      balance:r.balance, count:r.count, at:r.at, ok:1
    };
  },
  draw(n){
    const el=n.el?.querySelector('.readout'); if(!el) return;
    const r=n.res;
    let t;
    if(n.err) t='⚠ '+n.err;
    else if(!r) t='no data';
    else{
      t=(r.warnings.length ? '⚠ '+r.warnings.join('\n⚠ ')+'\n' : '')+
        'at '+r.at+' · balance '+lgMoney(r.balance)+' · events '+r.count;
      if(r.accounts.length>1) t+='\n'+r.accounts.map(a=>a.account+' '+lgMoney(a.balance)).join(' · ');
      else if(r.accounts.length===1) t+=' · '+r.accounts[0].account;
      if(r.next.length) t+='\nnext:\n'+r.next.slice(0,5).map(e=>e.date+'  '+lgMoney(e.amount)+'  '+(e.name||e.category||e.account)).join('\n');
      const c=r.cols.tx;
      if(c && c.date) t+='\ncols: date='+c.date+(c.in?' in='+c.in:'')+(c.out?' out='+c.out:'')+(c.amount?' amount='+c.amount:'');
    }
    if(el.textContent!==t) el.textContent=t;
  }
});
defGroups('ledger',[
  {n:'When',p:'at from to bucket'},
  {n:'Sources',p:'txmap rmap bmap include currency account'},
  {n:'Plan',p:'horizon next limit perAccount defaultAccount',open:false}
]);
