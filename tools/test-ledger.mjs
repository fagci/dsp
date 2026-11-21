// Ledger: даты, повторения, операции, баланс на дату, ряд (modules/ledger-kernels.js)
import fs from 'fs';
import vm from 'vm';
const ctx=vm.createContext({console,Date,Math,Number,String,Object,Array,Map,Set,JSON,isFinite,isNaN,parseFloat,parseInt,Infinity});
vm.runInContext(fs.readFileSync(new URL('../modules/ledger-kernels.js',import.meta.url),'utf8')+
  ';this.K={lgParseDate,lgISO,lgToday,lgAddDays,lgAddMonths,lgMonthDays,lgWeekday,lgWhen,lgNum,lgAmounts,lgWeekdays,lgMonthdays,lgCompute,lgRuleEvents,lgRule,lgTxCols,lgColsOf};',ctx);
const K=ctx.K;
let bad=0;
const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const near=(a,b)=>a!=null && Math.abs(a-b)<1e-9;
const D=s=>K.lgParseDate(s), I=d=>K.lgISO(d);

/* ---------- даты ---------- */
ok('parse ISO / dots / slashes / datetime / compact',
  I(D('2026-11-21'))==='2026-11-21' && I(D('21.11.2026'))==='2026-11-21' &&
  I(D('21/11/2026'))==='2026-11-21' && I(D('2026-11-21 13:27:01'))==='2026-11-21' &&
  I(D('20261121'))==='2026-11-21');
ok('bad date is rejected',D('2026-02-30')===null && D('')===null && D('not a date')===null);
ok('epoch ms / seconds',I(D(Date.UTC(2026,10,21)))==='2026-11-21' && I(D(Date.UTC(2026,10,21)/1000))==='2026-11-21');
ok('month length and clamp',K.lgMonthDays(2024,2)===29 && I(K.lgAddMonths(D('2026-01-31'),1))==='2026-02-28' && I(K.lgAddMonths(D('2026-01-31'),2))==='2026-03-31');
ok('weekday 0=Mon',K.lgWeekday(D('2026-11-23'))===0 && K.lgWeekday(D('2026-11-22'))===6);
ok('relative dates',I(K.lgWhen('+3m',D('2026-11-22')))==='2027-02-22' && I(K.lgWhen('-1y',D('2026-11-22')))==='2025-11-22' && K.lgWhen('today',D('2026-11-22'))===D('2026-11-22'));

/* ---------- числа и списки ---------- */
ok('numbers: spaces, comma decimal, parentheses, thousands',
  near(K.lgNum('1 234,56'),1234.56) && near(K.lgNum('(300)'),-300) &&
  near(K.lgNum('1,234.56'),1234.56) && near(K.lgNum('1.234'),1234) && near(K.lgNum('12.34'),12.34));
ok('numbers: currency and unicode minus',near(K.lgNum('−1 000 ₽'),-1000) && K.lgNum('')===null);
ok('amounts / weekdays / monthdays',JSON.stringify(K.lgAmounts('105, 105, 110'))==='[105,105,110]' &&
  JSON.stringify(K.lgWeekdays('1,3,7,0'))==='[0,2,6]' && JSON.stringify(K.lgMonthdays('1,15,-1'))==='[-1,1,15]');

/* ---------- операции ---------- */
const rows=[
  {id:'1',date:'2026-01-01',name:'A',category:'x',account:'A',type:'income',amount:1000,currency:'RUB'},
  {id:'2',date:'2026-01-02',name:'B',category:'y',account:'A',type:'expense',amount:200,currency:'RUB'},
  {id:'3',date:'2026-01-03',name:'T',account:'A',to:'B',type:'transfer',amount:100,currency:'RUB'},
  {id:'4',date:'2026-01-04',name:'C',account:'B',type:'expense',amount:50,currency:'RUB'}
];
const base=[{account:'A',amount:5000,currency:'RUB'},{account:'B',amount:0,currency:'RUB'}];
let r=K.lgCompute({rows,base,at:'2026-01-03',bucket:'day',next:2});
ok('columns auto-detected',r.cols.tx.date==='date' && r.cols.tx.amount==='amount' && r.cols.tx.account==='account' && r.cols.tx.to==='to');
ok('transfer: two legs, total unchanged',r.rowsOut.length===5 && r.rowsOut.filter(e=>e.id.startsWith('3:')).length===2);
ok('balance at a past date',near(r.balance,5800) && near(r.accounts.find(a=>a.account==='A').balance,5700) && near(r.accounts.find(a=>a.account==='B').balance,100));
ok('per-account income / expense',near(r.accounts.find(a=>a.account==='A').income,1000) && near(r.accounts.find(a=>a.account==='A').expense,300));
ok('rows carry running balance and total',near(r.rowsOut[r.rowsOut.length-1].balance,50) && near(r.rowsOut[r.rowsOut.length-1].total,5750));
ok('series ends at the last event, balance there',r.series.length===4 && near(r.series[r.series.length-1].balance,5750));
ok('next events after the date',r.next.length===1 && near(r.next[0].amount,-50) && r.next[0].date==='2026-01-04');
ok('balance account filter',near(K.lgCompute({rows,base,at:'2026-01-03',account:'A'}).balance,5700));

/* ---------- ZenMoney CSV ---------- */
const z=[{date:'2026-11-21',categoryName:'',payee:'Михаил Ю.',comment:'',outcomeAccountName:'Платинум',outcome:'1359',
  outcomeCurrencyShortTitle:'RUB',incomeAccountName:'Платинум',income:'0',incomeCurrencyShortTitle:'RUB',
  createdDate:'2026-11-21 13:27:01',changedDate:'2026-11-21 13:42:30',qrCode:''}];
const zr=K.lgCompute({rows:z,at:'2026-11-21',bucket:'none'});
ok('ZenMoney: outcome is an expense, income account is mapped',zr.cols.tx.out==='outcome' && zr.cols.tx.outAccount==='outcomeAccountName' &&
  zr.cols.tx.name==='payee' && zr.rowsOut.length===1 && near(zr.rowsOut[0].amount,-1359) && zr.rowsOut[0].account==='Платинум');
ok('ZenMoney: balance is negative',near(zr.balance,-1359));

/* ---------- повторения ---------- */
const rules=[
  {id:'r1',name:'Кредит',start:'2026-01-31',period:'month',every:1,count:3,amount:105,last:110,type:'expense',account:'A',category:'credit'},
  {id:'r2',name:'ЗП',start:'2026-01-01',period:'week',every:1,weekday:'1',amount:1000,type:'income',account:'A',end:'2026-01-31'},
  {id:'r3',name:'Аренда',start:'2026-01-01',period:'month',every:1,monthday:'-1',amount:500,type:'expense',account:'A',end:'2026-03-31'},
  {id:'r4',name:'Подписка',start:'2026-01-01',period:'day',every:1,amount:10,type:'expense',account:'A',count:3,skip:'2026-01-02'}
];
r=K.lgCompute({rules,at:'2026-03-31',bucket:'month',horizon:0});
const r1=r.rowsOut.filter(e=>e.rule==='r1').map(e=>e.amount);
ok('month-end: 31 → 28/31, last amount wins',JSON.stringify(r1)==='[-105,-105,-110]',JSON.stringify(r1));
ok('weekly on Monday from a Thursday start',r.rowsOut.filter(e=>e.rule==='r2').map(e=>e.date).join(',')==='2026-01-05,2026-01-12,2026-01-19,2026-01-26');
ok('monthday -1 is the last day',r.rowsOut.filter(e=>e.rule==='r3').map(e=>e.date).join(',')==='2026-01-31,2026-02-28,2026-03-31');
ok('skip does not consume the occurrence',r.rowsOut.filter(e=>e.rule==='r4').map(e=>e.date).join(',')==='2026-01-01,2026-01-03,2026-01-04');
ok('total balance of the plan',near(r.balance,2150),String(r.balance));
ok('series is monthly and ends at the date',r.series.length===3 && r.series[2].date==='2026-03-31' && near(r.series[2].balance,2150));
ok('no next after the last payment',r.next.length===0);

ok('final without count/end is ignored',K.lgCompute({rules:[{id:'n',start:'2026-01-31',period:'month',amount:105,last:110,type:'expense',account:'A'}],at:'2026-03-31',horizon:0,bucket:'none'}).rowsOut.map(e=>e.amount).join(',')==='-105,-105,-105');

/* ---------- явный график сумм ---------- */
const a=K.lgCompute({rules:[{id:'a',start:'2026-01-31',period:'month',amounts:'105, 105, 110',type:'expense',account:'A'}],at:'2026-12-31',horizon:0,bucket:'none'});
ok('amounts list: three payments, stop after the list',a.rowsOut.length===3 && JSON.stringify(a.rowsOut.map(e=>e.amount))==='[-105,-105,-110]');

/* ---------- перевод по правилу и перенос через месяц ---------- */
const tr=K.lgCompute({rules:[{id:'t',start:'2026-01-01',period:'month',amount:100,account:'A',to:'B'}],at:'2026-01-31',horizon:0,bucket:'month'});
ok('rule transfer: two legs on two accounts',tr.rowsOut.length===2 && near(tr.balance,0) && near(tr.accounts.find(x=>x.account==='A').balance,-100) && near(tr.accounts.find(x=>x.account==='B').balance,100));

/* ---------- предупреждения ---------- */
const w1=K.lgCompute({rows:[{foo:1}]}).warnings, w2=K.lgCompute({}).warnings;
ok('warnings: no date / no amount / no data',w1.some(x=>x.includes('date')) && w1.some(x=>x.includes('amount')) && w2.some(x=>x.includes('no transactions')));
ok('warnings: no rules',K.lgCompute({rows:[{date:'2026-01-01',amount:1,account:'A'}]}).warnings.some(x=>x.includes('recurring')));

/* ---------- ручная карта колонок ---------- */
const m=K.lgCompute({rows:[{when:'01.02.2026',value:'-10',wallet:'W'}],txMap:'date=when\namount=value\naccount=wallet',at:'2026-02-01',bucket:'none'});
ok('explicit column map',m.rowsOut.length===1 && near(m.balance,-10) && m.rowsOut[0].account==='W');
ok('map can disable auto (amount=none)',K.lgCompute({rows:[{date:'2026-01-01',amount:5,income:1,incomeAccountName:'I'}],txMap:'amount=none',at:'2026-01-01',bucket:'none'}).rowsOut.length===1);

console.log(bad ? bad+' FAILED' : 'all ok');
process.exit(bad ? 1 : 0);
