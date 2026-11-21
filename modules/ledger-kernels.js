"use strict";
/* ============================ Ledger: движения, повторения, баланс ============================
   Чистое ядро для учёта чего угодно, что имеет дату и сумму: деньги, подписки, обслуживание,
   лекарства, платежи по кредиту. Строки Table — факты (операции), вторая таблица — правила
   повторений, третья — начальные остатки. Ядро ничего не знает про DOM и про то, что суммы
   денежные.

   lgParseDate(v) → номер дня (1970-01-01 = 0) | null;  lgISO(day) → 'ГГГГ-ММ-ДД'
   lgWhen('today' | '+3m' | '-1y' | '2026-12-31', base) — дата запроса
   lgCompute({rows, rules, base, txMap, rMap, bMap, at, from, to, bucket, ...}) →
     {ok, at, from, to, events, rowsOut, accounts, series, next, balance, count, warnings, cols}

   Правило повторения: start, period, every, weekday, monthday, end, count, amount, last,
   amounts, type, account, to, category, name, currency, skip.
     period: once | day | workday | week | month | quarter | year
     weekday: 1=Пн … 7=Вс, 0=Вс (cron-стиль), имена mon / пн …
     monthday: 1…31, -1=последний день, -2=предпоследний; 31 в коротком месяце = последний
     amounts: «105, 105, 110» — явный график; end/count могут его продолжить последней суммой
     last: сумма последнего платежа (при count или end)
     skip: даты через запятую, которые не надо создавать
   Операция: date, amount (со знаком) ИЛИ in/out, account, inAccount/outAccount, type,
     category, name, note, currency, id, transfer, rate, skip.
     type: income / expense (ставит знак), transfer + to (две ноги), пусто — знак как есть.
   Проверка: node tools/test-ledger.mjs */

const LG_MS=86400000;
const LG_TX_ROLES=['date','amount','in','out','account','inAccount','outAccount','type','category','name','note','currency','inCurrency','outCurrency','id','transfer','to','rate','skip'];
const LG_RULE_ROLES=['start','end','count','period','every','weekday','monthday','amount','last','amounts','type','account','to','category','name','currency','skip','id','note'];
const LG_BASE_ROLES=['account','amount','currency','date','id'];
const LG_TX_AUTO={
  date:['date','дата','dt','time','t','timestamp','createddate','changeddate','transactiondate','posted','bookingdate','operationdate'],
  amount:['amount','sum','value','total','сумма','стоимость'],
  in:['income','in','credit','deposit','приход','поступление','доход'],
  out:['outcome','out','expense','debit','withdrawal','расход','списание'],
  account:['account','accountname','wallet','счёт','счет','кошелёк'],
  inAccount:['incomeaccountname','incomeaccount','inaccount','accountin','счётпоступления','счетпоступления'],
  outAccount:['outcomeaccountname','outcomeaccount','outaccount','accountout','счётсписания','счетсписания'],
  type:['type','kind','direction','dir','тип','вид','направление'],
  category:['category','categoryname','cat','категория','раздел'],
  name:['name','payee','title','description','merchant','контрагент','название','назначение','описание'],
  note:['note','comment','memo','remark','комментарий','примечание'],
  currency:['currency','currencyshorttitle','currencycode','валюта'],
  inCurrency:['incomecurrencyshorttitle','incomecurrency','incurrency'],
  outCurrency:['outcomecurrencyshorttitle','outcomecurrency','outcurrency'],
  id:['id','key','uid','transactionid','operationid','guid'],
  transfer:['transfer','to','toaccount','targetaccount','куда','получатель','перевод'],
  to:['to','toaccount','target','transfer','куда','получатель','перевод'],
  rate:['rate','fx','fxrate','курс'],
  skip:['skip','_delete','deleted','deleted_at','удалён','удален','пропуск']
};
const LG_RULE_AUTO={
  start:['start','date','begin','начало','дата','старт','первый'],
  end:['end','until','finish','stop','по','конец','окончание','последний'],
  count:['count','times','n','payments','number','количество','платежей','раз','штук'],
  period:['period','recurrence','repeat','frequency','период','повтор','частота','цикл'],
  every:['every','interval','step','each','каждые','интервал','через'],
  weekday:['weekday','weekdays','dow','dayofweek','деньнедели','дни','день'],
  monthday:['monthday','dayofmonth','month_day','число','деньмесяца'],
  amount:['amount','sum','payment','value','сумма','платёж','платеж','взнос'],
  last:['last','lastamount','final','finalamount','последний','конечная','остаток'],
  amounts:['amounts','schedule','paymentschedule','суммы','график','графикплатежей'],
  type:['type','kind','dir','direction','тип','вид'],
  account:['account','accountname','wallet','счёт','счет','кошелёк'],
  to:['to','toaccount','target','targetaccount','куда','получатель'],
  category:['category','categoryname','cat','категория','раздел'],
  name:['name','title','payee','description','название','контрагент','описание'],
  currency:['currency','currencyshorttitle','currencycode','валюта'],
  skip:['skip','except','exclude','пропуск','исключить','кроме'],
  id:['id','key','uid','ruleid','guid'],
  note:['note','comment','memo','комментарий','примечание']
};
const LG_BASE_AUTO={
  account:['account','accountname','wallet','счёт','счет','кошелёк','id'],
  amount:['amount','balance','sum','value','сумма','остаток','баланс'],
  currency:['currency','currencyshorttitle','валюта'],
  date:['date','start','дата','начало'],
  id:['id','key','uid']
};

/* ---------- даты: номер дня, без часовых поясов ---------- */
function lgPad(n,w){ return String(n).padStart(w||2,'0'); }
// Гражданская дата ↔ номер дня (алгоритм Говарда Хиннанта, UTC, без Date)
function lgDays(y,m,d){
  y-=m<=2 ? 1 : 0;
  const era=Math.floor(y/400), yoe=y-era*400,
    doy=Math.floor((153*(m+(m>2 ? -3 : 9))+2)/5)+d-1,
    doe=yoe*365+Math.floor(yoe/4)-Math.floor(yoe/100)+doy;
  return era*146097+doe-719468;
}
function lgCivil(day){
  let z=Math.floor(day)+719468;
  const era=Math.floor(z/146097); z-=era*146097;
  const doe=z, yoe=Math.floor((doe-Math.floor(doe/1460)+Math.floor(doe/36524)-Math.floor(doe/146096))/365),
    y=yoe+era*400, doy=doe-(365*yoe+Math.floor(yoe/4)-Math.floor(yoe/100)),
    mp=Math.floor((5*doy+2)/153), d=doy-Math.floor((153*mp+2)/5)+1,
    m=mp+(mp<10 ? 3 : -9);
  return {y:y+(m<=2 ? 1 : 0),m,d};
}
function lgISO(day){
  if(day==null || !isFinite(day)) return '';
  const c=lgCivil(day); return (c.y<0 ? '-' : '')+lgPad(Math.abs(c.y),4)+'-'+lgPad(c.m)+'-'+lgPad(c.d);
}
function lgToday(){ return Math.floor(Date.now()/LG_MS); }
function lgMonthDays(y,m){ return lgDays(m===12 ? y+1 : y,m===12 ? 1 : m+1,1)-lgDays(y,m,1); }
function lgWeekday(day){ return ((Math.floor(day)+3)%7+7)%7; }              // 0=Пн … 6=Вс
function lgAddDays(day,n){ return Math.floor(day)+Math.floor(n); }
function lgAddMonths(day,n){
  const c=lgCivil(day); let m=c.m-1+Math.floor(n);
  const y=c.y+Math.floor(m/12); m=((m%12)+12)%12+1;
  return lgDays(y,m,Math.min(c.d,lgMonthDays(y,m)));
}
function lgParseDate(v){
  if(v==null || v==='') return null;
  if(v instanceof Date) return isNaN(v.getTime()) ? null : Math.floor(v.getTime()/LG_MS);
  if(typeof v==='number'){
    if(!isFinite(v)) return null;
    if(v>1e14) return Math.floor(v/1000/LG_MS);                          // мкс
    if(v>1e11) return Math.floor(v/LG_MS);                               // мс
    if(v>1e9) return Math.floor(v/86400);                                // секунды → дни
    return Math.floor(v);                                                // уже номер дня
  }
  let s=String(v).trim().replace(/\u2212/g,'-');
  if(!s) return null;
  s=s.replace(/[T ].*$/,'').replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');
  let m;
  if((m=/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(s))) return lgDateOk(+m[1],+m[2],+m[3]);
  if((m=/^(\d{1,2})[.](\d{1,2})[.](\d{4})$/.exec(s))) return lgDateOk(+m[3],+m[2],+m[1]);
  if((m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))){
    const a=+m[1], b=+m[2], y=+m[3];
    return a>12 ? lgDateOk(y,b,a) : b>12 ? lgDateOk(y,a,b) : lgDateOk(y,b,a);   // по умолчанию день/месяц
  }
  const t=Date.parse(s); if(isFinite(t)) return Math.floor(t/LG_MS);
  return null;
}
function lgDateOk(y,m,d){
  if(!(y>=1 && y<=9999) || !(m>=1 && m<=12) || !(d>=1 && d<=lgMonthDays(y,m))) return null;
  return lgDays(y,m,d);
}
function lgWhen(v,base){
  const b=base==null ? lgToday() : base;
  if(typeof v==='number') return isFinite(v) ? lgParseDate(v) : null;
  const s=String(v==null ? '' : v).trim().toLowerCase();
  if(!s) return null;
  if(s==='today' || s==='now' || s==='сегодня') return b;
  const m=/^([+-]?\d+)\s*(d|day|days|д|дн|дней|w|week|weeks|н|нед|неделя|m|month|months|мес|месяц|y|year|years|г|год|лет)$/.exec(s);
  if(m){
    const n=+m[1], u=m[2][0];
    if(u==='d' || u==='д') return lgAddDays(b,n);
    if(u==='w' || u==='н') return lgAddDays(b,n*7);
    if(u==='m' || u==='м') return lgAddMonths(b,n);
    if(u==='y' || u==='г' || u==='л') return lgAddMonths(b,n*12);
  }
  return lgParseDate(s);
}

/* ---------- числа, текст, списки ---------- */
function lgNum(v){
  if(typeof v==='number') return isFinite(v) ? v : null;
  if(typeof v!=='string') return null;
  let s=v.trim().replace(/\u2212/g,'-'); if(!s) return null;
  let neg=false;
  if(/^\(.*\)$/.test(s)){ neg=true; s=s.slice(1,-1); }
  s=s.replace(/[^\d.,+\-eE]/g,''); if(!s) return null;
  const c=s.includes(','), d=s.includes('.');
  if(c && d){
    if(s.lastIndexOf(',')>s.lastIndexOf('.')) s=s.replace(/\./g,'').replace(/,/g,'.');
    else s=s.replace(/,/g,'');
  } else if(c){
    if(/^\d{1,3}(,\d{3})+$/.test(s)) s=s.replace(/,/g,'');
    else s=s.replace(/,/g,'.');
  } else if(d && /^\d{1,3}(\.\d{3})+$/.test(s) && !/\.\d{1,2}$/.test(s)) s=s.replace(/\./g,'');
  const n=Number(s); if(!isFinite(n)) return null;
  return neg ? -Math.abs(n) : n;
}
const lgText=v=>v==null ? '' : typeof v==='string' ? v.trim() : String(v);
const lgBool=v=>v===true || v===1 || /^(1|true|yes|y|да|on|вкл)$/i.test(String(v==null ? '' : v).trim());
const lgRound=v=>{ if(!isFinite(v)) return 0; const r=Math.round((v+Number.EPSILON)*100)/100; return r===0 ? 0 : r; };
function lgMoney(v){
  if(v==null || !isFinite(v)) return '—';
  const neg=v<0, a=Math.abs(v), s=(Math.round(a*100)/100).toFixed(2).replace(/\.00$/,'').replace(/(\.\d)0$/,'$1'),
    p=s.split('.');
  return (neg?'-':'')+p[0].replace(/\B(?=(\d{3})+(?!\d))/g,' ')+(p[1] ? '.'+p[1] : '');
}
function lgMap(text){
  const o={};
  if(!text) return o;
  if(typeof text==='object'){ for(const k in text) o[String(k)]=String(text[k]); return o; }
  for(const raw of String(text).split(/[\r\n;,]+/)){
    const s=raw.trim(); if(!s || s[0]==='#' || s.startsWith('//')) continue;
    const i=s.indexOf('='); if(i<0) continue;
    const k=s.slice(0,i).trim(), v=s.slice(i+1).trim();
    if(k) o[k]=v;
  }
  return o;
}
function lgMapGet(map,k){
  if(!map) return '';
  if(map[k]!=null) return map[k];
  const lk=k.toLowerCase();
  for(const x in map) if(x.toLowerCase()===lk) return map[x];
  return '';
}
function lgCol(cols,want,auto){
  const low=new Map([...cols].map(c=>[String(c).toLowerCase(),c]));
  if(want){
    const w=String(want).trim();
    if(/^(none|off|-|—)$/i.test(w)) return null;
    return cols.includes(w) ? w : low.get(w.toLowerCase()) || null;
  }
  for(const a of auto||[]) if(low.has(a)) return low.get(a);
  return null;
}
function lgColsOf(rows){
  const cols=[], seen=new Set();
  for(let i=0;i<rows.length && i<500;i++){
    const r=rows[i]; if(!r || typeof r!=='object') continue;
    for(const k in r) if(!seen.has(k)){ seen.add(k); cols.push(k); }
  }
  return cols;
}
function lgRoles(cols,map,roles,auto){
  const o={};
  for(const k of roles) o[k]=lgCol(cols,lgMapGet(map,k),auto[k]);
  o.available=cols;
  return o;
}
const lgTxCols=(cols,map)=>lgRoles(cols,map,LG_TX_ROLES,LG_TX_AUTO);
const lgRuleCols=(cols,map)=>lgRoles(cols,map,LG_RULE_ROLES,LG_RULE_AUTO);
const lgBaseCols=(cols,map)=>lgRoles(cols,map,LG_BASE_ROLES,LG_BASE_AUTO);

function lgList(v){
  if(v==null || v==='') return [];
  if(Array.isArray(v)) return v;
  let s=String(v).trim();
  if(s[0]==='['){ try{ const a=JSON.parse(s); if(Array.isArray(a)) return a; }catch(e){} }
  return s.split(/[,;|\s]+/);
}
function lgAmounts(v){
  return lgList(v).map(lgNum).filter(x=>x!=null && isFinite(x));
}
function lgWeekdays(v){
  const names={mon:0,monday:0,пн:0,пон:0,tue:1,tuesday:1,вт:1,wed:2,wednesday:2,ср:2,thu:3,thursday:3,чт:3,fri:4,friday:4,пт:4,sat:5,saturday:5,сб:5,sun:6,sunday:6,вс:6,нд:6};
  const out=[];
  for(const raw of lgList(v)){
    const s=String(raw).trim().toLowerCase(); if(!s) continue;
    if(/^\d+$/.test(s)){
      const n=+s;
      if(n===0 || n===7) out.push(6);
      else if(n>=1 && n<=6) out.push(n-1);
    } else if(s in names) out.push(names[s]);
  }
  return [...new Set(out)].sort((a,b)=>a-b);
}
function lgMonthdays(v){
  const out=[];
  for(const raw of lgList(v)){
    const s=String(raw).trim().toLowerCase(); if(!s) continue;
    if(s==='last' || s==='последний' || s==='конец'){ out.push(-1); continue; }
    const n=lgNum(s); if(n!=null && Number.isInteger(n) && n!==0) out.push(n);
  }
  return [...new Set(out)].sort((a,b)=>a-b);
}
function lgSkip(v){
  const set=new Set();
  for(const raw of lgList(v)){ const d=lgParseDate(raw); if(d!=null) set.add(d); }
  return set.size ? set : null;
}
function lgPeriod(v){
  const s=String(v==null ? '' : v).trim().toLowerCase();
  if(/^(day|daily|день|дн|дни|ежедневно|каждый день|каждыйдень)$/.test(s)) return 'day';
  if(/^(week|weekly|неделя|нед|еженедельно|каждая неделя)$/.test(s)) return 'week';
  if(/^(month|monthly|месяц|мес|ежемесячно|каждый месяц)$/.test(s)) return 'month';
  if(/^(quarter|quarterly|квартал|ежеквартально)$/.test(s)) return 'month';
  if(/^(year|yearly|annual|год|ежегодно|каждый год)$/.test(s)) return 'year';
  if(/^(workday|workdays|рабочий|рабочие|будни|по будням)$/.test(s)) return 'workday';
  if(/^(once|one|single|разово|один раз|однократно)$/.test(s)) return 'once';
  return 'once';
}
function lgSigned(amount,type){
  const a=lgNum(amount);
  if(a==null) return 0;
  const t=String(type==null ? '' : type).trim().toLowerCase();
  if(/expense|расход|debit|out|списан|трат|payment|платёж|платеж/.test(t)) return -Math.abs(a);
  if(/income|доход|credit|in|поступ|приход|зарплат/.test(t)) return Math.abs(a);
  return a;
}

/* ---------- операции ---------- */
function lgTxEvents(rows,cols,opt){
  const ev=[], badDate=[], noAmt=[];
  const def=opt.defaultAccount || 'main';
  rows.forEach((row,i)=>{
    if(!row || typeof row!=='object') return;
    if(lgBool(row[cols.skip]) || lgBool(row._delete)) return;
    const day=cols.date ? lgParseDate(row[cols.date]) : null;
    if(day==null){ badDate.push(i+1); return; }
    const name=cols.name ? lgText(row[cols.name]) : '';
    const category=cols.category ? lgText(row[cols.category]) : '';
    const note=cols.note ? lgText(row[cols.note]) : '';
    const currency=cols.currency ? lgText(row[cols.currency]) : '';
    const baseId=(cols.id ? lgText(row[cols.id]) : '') || 'a'+(i+1);
    let rate=1;
    if(cols.rate){ const r=lgNum(row[cols.rate]); if(r!=null && r>0) rate=r; }
    let used=false;
    const add=(account,amount,leg,cur)=>{
      const acc=account || def;
      if(amount==null || !isFinite(amount) || amount===0) return;
      ev.push({day,date:lgISO(day),amount:lgRound(amount*rate),account:acc,currency:cur||currency,
        name,category,note,source:'actual',leg,id:baseId+':'+leg,row:i});
      used=true;
    };
    const inV=cols.in ? lgNum(row[cols.in]) : null;
    const outV=cols.out ? lgNum(row[cols.out]) : null;
    if((inV!=null && inV!==0) || (outV!=null && outV!==0)){
      const acc=cols.account ? lgText(row[cols.account]) : '';
      const inAcc=(cols.inAccount ? lgText(row[cols.inAccount]) : '') || acc || def;
      const outAcc=(cols.outAccount ? lgText(row[cols.outAccount]) : '') || acc || def;
      const inCur=(cols.inCurrency ? lgText(row[cols.inCurrency]) : '') || currency;
      const outCur=(cols.outCurrency ? lgText(row[cols.outCurrency]) : '') || currency;
      if(inV!=null && inV>0) add(inAcc,Math.abs(inV),'in',inCur);
      if(outV!=null && outV>0) add(outAcc,-Math.abs(outV),'out',outCur);
    }
    if(!used && cols.amount){
      const v=lgNum(row[cols.amount]);
      if(v!=null && v!==0){
        const to=(cols.to ? lgText(row[cols.to]) : '') || (cols.transfer ? lgText(row[cols.transfer]) : '');
        if(to){
          const a=Math.abs(v);
          add((cols.account ? lgText(row[cols.account]) : '') || def,-a,'out',currency);
          add(to,a,'to',currency);
        } else add((cols.account ? lgText(row[cols.account]) : '') || def,lgSigned(v,cols.type ? row[cols.type] : ''),'self',currency);
      } else noAmt.push(i+1);
    }
  });
  return {events:ev,badDate,noAmt};
}

/* ---------- правила и повторения ---------- */
function lgRule(row,cols,opt){
  if(!row || typeof row!=='object') return null;
  const start=cols.start ? lgParseDate(row[cols.start]) : null;
  if(start==null) return null;
  const amounts=lgAmounts(cols.amounts ? row[cols.amounts] : null);
  const periodText=cols.period ? row[cols.period] : '';
  let period=lgPeriod(periodText);
  if(!String(periodText==null ? '' : periodText).trim() && amounts.length>1) period='month';
  let every=lgNum(cols.every ? row[cols.every] : null);
  if(!(every>0)) every=1;
  if(/quarter|квартал/i.test(String(periodText==null ? '' : periodText))) every*=3;
  return {
    id:(cols.id ? lgText(row[cols.id]) : '') || 'r'+(opt.index+1),
    start, end:cols.end ? lgParseDate(row[cols.end]) : null,
    count:cols.count ? lgNum(row[cols.count]) : null,
    period, every,
    weekday:cols.weekday ? lgWeekdays(row[cols.weekday]) : null,
    monthday:cols.monthday ? lgMonthdays(row[cols.monthday]) : null,
    amount:amounts.length ? amounts[0] : (cols.amount ? lgNum(row[cols.amount]) : null),
    last:cols.last ? lgNum(row[cols.last]) : null,
    amounts,
    type:cols.type ? lgText(row[cols.type]) : '',
    account:(cols.account ? lgText(row[cols.account]) : '') || opt.defaultAccount,
    to:cols.to ? lgText(row[cols.to]) : '',
    category:cols.category ? lgText(row[cols.category]) : '',
    name:cols.name ? lgText(row[cols.name]) : '',
    note:cols.note ? lgText(row[cols.note]) : '',
    currency:(cols.currency ? lgText(row[cols.currency]) : '') || opt.currency || '',
    skip:cols.skip ? lgSkip(row[cols.skip]) : null
  };
}
function lgGen(rule,toDay,limit){
  const out=[], start=rule.start;
  if(start==null) return out;
  const end=rule.end, count=rule.count>0 ? Math.floor(rule.count) : 0,
    every=Math.max(1,Math.floor(rule.every||1)),
    amounts=Array.isArray(rule.amounts) && rule.amounts.length ? rule.amounts : null,
    cap=count || (amounts && end==null ? amounts.length : Infinity);
  let stop=end!=null ? end : toDay;
  if(stop>toDay) stop=toDay;
  if(start>stop) return out;
  const add=day=>{
    if(day<start || day>stop || (end!=null && day>end)) return true;
    if(rule.skip && rule.skip.has(day)) return true;
    if(out.length>=limit) return false;
    out.push(day);
    return !(cap!==Infinity && out.length>=cap);
  };
  const wds=rule.weekday;
  switch(rule.period){
    case 'once': add(start); break;
    case 'day':
      for(let d=start; d<=stop; d+=every){
        if(wds && wds.length && !wds.includes(lgWeekday(d))) continue;
        if(!add(d)) break;
      }
      break;
    case 'workday': {
      let k=0;
      for(let d=start; d<=stop; d++){
        if(lgWeekday(d)>4) continue;
        if((k++ % every)!==0) continue;
        if(!add(d)) break;
      }
      break;
    }
    case 'week': {
      const wd0=lgWeekday(start), base0=start-wd0;
      for(let base=base0; base<=stop; base+=7*every){
        const days=wds && wds.length ? wds.slice().sort((a,b)=>a-b) : [wd0];
        for(const wd of days){
          const d=base+wd;
          if(d<start) continue;
          if(d>stop) return lgGenAmounts(out,rule,amounts);
          if(!add(d)) return lgGenAmounts(out,rule,amounts);
        }
      }
      break;
    }
    case 'month': {
      let y=lgCivil(start).y, m=lgCivil(start).m;
      const startD=lgCivil(start).d;
      let guard=0;
      for(;;){
        if(lgDays(y,m,1)>stop) break;
        const last=lgMonthDays(y,m), specs=rule.monthday && rule.monthday.length ? rule.monthday : [startD], days=[];
        for(const s of specs){
          const d=s===-1 ? last : s<0 ? last+s+1 : Math.min(s,last);
          if(d>=1) days.push(d);
        }
        days.sort((a,b)=>a-b);
        for(const d of days){
          const day=lgDays(y,m,d);
          if(day<start) continue;
          if(day>stop) return lgGenAmounts(out,rule,amounts);
          if(!add(day)) return lgGenAmounts(out,rule,amounts);
        }
        m+=every; while(m>12){ m-=12; y++; }
        if(++guard>100000) break;
      }
      break;
    }
    case 'year': {
      const c=lgCivil(start), specs=rule.monthday && rule.monthday.length ? rule.monthday : [c.d];
      for(let y=c.y;; y+=every){
        if(y>9999) break;
        const last=lgMonthDays(y,c.m), days=specs.map(s=>s===-1 ? last : s<0 ? last+s+1 : Math.min(s,last)).filter(d=>d>=1).sort((a,b)=>a-b);
        for(const d of days){
          const day=lgDays(y,c.m,d);
          if(day<start) continue;
          if(day>stop) return lgGenAmounts(out,rule,amounts);
          if(!add(day)) return lgGenAmounts(out,rule,amounts);
        }
        if(lgDays(y+every,c.m,1)>stop) break;
      }
      break;
    }
    default: add(start);
  }
  return lgGenAmounts(out,rule,amounts);
}
function lgGenAmounts(days,rule,amounts){
  const n=days.length;
  return days.map((day,i)=>{
    let amount=rule.amount;
    if(amounts && amounts.length) amount=amounts[Math.min(i,amounts.length-1)];
    if(rule.last!=null && (rule.count>0 || rule.end!=null) && i===n-1) amount=rule.last;
    return {day,amount};
  });
}
function lgRuleEvents(rule,toDay,limit){
  const occ=lgGen(rule,toDay,limit), out=[];
  const base={source:'rule',rule:rule.id,name:rule.name,category:rule.category,note:rule.note,currency:rule.currency};
  for(const o of occ){
    const base2={...base,day:o.day,date:lgISO(o.day)};
    if(rule.to){
      const a=Math.abs(lgNum(o.amount)||0);
      if(a){
        out.push({...base2,amount:-a,account:rule.account,leg:'out',id:rule.id+':'+o.day+':out'});
        out.push({...base2,amount:a,account:rule.to,leg:'to',id:rule.id+':'+o.day+':to'});
      }
    } else {
      const a=lgSigned(o.amount,rule.type);
      if(a) out.push({...base2,amount:a,account:rule.account,leg:'self',id:rule.id+':'+o.day});
    }
  }
  return out;
}

/* ---------- баланс и ряд ---------- */
function lgBucketEnds(from,to,bucket){
  const a=[];
  if(bucket==='none') return [to];
  if(bucket==='day'){
    for(let d=from; d<=to && a.length<5000; d++) a.push(d);
    if(a.length && a[a.length-1]!==to) a.push(to);
    return a;
  }
  if(bucket==='week'){
    let d=from+(6-lgWeekday(from));
    for(; d<=to; d+=7){ a.push(d); if(a.length>=5000) break; }
    if(!a.length || a[a.length-1]!==to) a.push(to);
    return a;
  }
  if(bucket==='year'){
    for(let y=lgCivil(from).y;; y++){
      const end=lgDays(y,12,31);
      if(end>=to){ a.push(to); break; }
      if(end>=from) a.push(end);
      if(a.length>=5000) break;
    }
    return a;
  }
  // month
  let c=lgCivil(from);
  for(;;){
    const end=lgDays(c.y,c.m,lgMonthDays(c.y,c.m));
    if(end>=to){ a.push(to); break; }
    if(end>=from) a.push(end);
    if(a.length>=5000) break;
    const nx=lgAddMonths(lgDays(c.y,c.m,1),1); c=lgCivil(nx);
  }
  return a;
}
function lgCompute(o){
  o=o||{};
  const warnings=[], today=lgToday(), at0=lgWhen(o.at||'today',today), atDay=at0==null ? today : at0;
  const rows=Array.isArray(o.rows) ? o.rows : [], ruleRows=Array.isArray(o.rules) ? o.rules : [], baseRows=Array.isArray(o.base) ? o.base : [];
  const txCols=lgTxCols(lgColsOf(rows),lgMap(o.txMap)), ruleCols=lgRuleCols(lgColsOf(ruleRows),lgMap(o.rMap)), baseCols=lgBaseCols(lgColsOf(baseRows),lgMap(o.bMap));
  const defaultAccount=lgText(o.defaultAccount) || 'main', currency=lgText(o.currency), limit=Math.max(100,Math.floor(+o.limit||50000));
  const include=o.include || 'all', includeActual=include!=='rules', includeRules=include!=='actual';
  if(!rows.length && !ruleRows.length) warnings.push('no transactions or rules — wire a Table rows or import a CSV into one');
  if(rows.length && !txCols.date) warnings.push('no date column — set txmap date=<column>');
  if(rows.length && !txCols.amount && !txCols.in && !txCols.out) warnings.push('no amount / income / outcome column — set txmap amount=<column>');
  const actual=includeActual ? lgTxEvents(rows,txCols,{defaultAccount,currency}) : {events:[],badDate:[],noAmt:[]};
  if(actual.badDate.length) warnings.push(actual.badDate.length+' row(s) without a valid date');
  const rules=[];
  ruleRows.forEach((r,i)=>{
    const rule=lgRule(r,ruleCols,{defaultAccount,currency,index:i});
    if(rule) rules.push(rule); else warnings.push('rule '+(i+1)+': no start date');
  });
  const ruleStarts=rules.map(r=>r.start), ruleEnds=rules.map(r=>r.end).filter(d=>d!=null);
  let minActual=null, maxActual=null;
  for(const e of actual.events){ if(minActual==null || e.day<minActual) minActual=e.day; if(maxActual==null || e.day>maxActual) maxActual=e.day; }
  const hz=o.horizon==null || o.horizon==='' ? 24 : +o.horizon;
  const horizon=Math.max(0,Math.floor(isFinite(hz) ? hz : 24));
  let toDay=lgWhen(o.to,today);
  if(toDay==null){
    toDay=Math.max(atDay,maxActual==null?atDay:maxActual);
    for(const d of ruleEnds) if(d>toDay) toDay=d;
    if(rules.length){ const h=lgAddMonths(atDay,horizon); if(h>toDay) toDay=h; }
  }
  let fromDay=lgWhen(o.from,today);
  if(fromDay==null){
    fromDay=atDay;
    if(minActual!=null) fromDay=Math.min(fromDay,minActual);
    for(const d of ruleStarts) fromDay=Math.min(fromDay,d);
  }
  if(fromDay>toDay){ const t=fromDay; fromDay=toDay; toDay=t; }
  const expandTo=Math.max(toDay,atDay);
  const ruleEvents=[];
  if(includeRules) for(const rule of rules){
    if(ruleEvents.length>=limit) break;
    const part=lgRuleEvents(rule,expandTo,Math.max(1,limit-ruleEvents.length));
    if(ruleEvents.length+part.length>=limit && part.length) warnings.push('occurrence limit '+limit+' reached — raise «max occurrences»');
    for(const e of part) ruleEvents.push(e);
  }
  const events=actual.events.concat(ruleEvents).filter(e=>!currency || !e.currency || e.currency===currency);
  events.sort((a,b)=>a.day-b.day || (a.source==='actual'?0:1)-(b.source==='actual'?0:1) || (a.id<b.id?-1:a.id>b.id?1:0));
  const baseMap=new Map();
  for(const row of baseRows){
    if(!row || typeof row!=='object' || lgBool(row._delete)) continue;
    const acc=(baseCols.account ? lgText(row[baseCols.account]) : '') || defaultAccount;
    const amt=baseCols.amount ? lgNum(row[baseCols.amount]) : null;
    if(amt==null) continue;
    const cur=(baseCols.currency ? lgText(row[baseCols.currency]) : '') || currency;
    if(currency && cur && cur!==currency) continue;
    const e=baseMap.get(acc) || {account:acc,opening:0,currency:cur};
    e.opening+=amt; baseMap.set(acc,e);
  }
  const bal=new Map(), total0=[...baseMap.values()].reduce((a,b)=>a+b.opening,0);
  for(const [acc,b] of baseMap) bal.set(acc,b.opening);
  for(const e of events) if(!bal.has(e.account)) bal.set(e.account,0);
  let running=total0;
  for(const e of events){
    const v=(bal.get(e.account)||0)+e.amount; bal.set(e.account,v); running+=e.amount;
    e.balance=lgRound(v); e.total=lgRound(running);
    e.type=e.leg==='to' ? 'transfer' : e.amount<0 ? 'expense' : 'income';
  }
  const balAt=new Map([...baseMap].map(([k,v])=>[k,v.opening]));
  for(const e of events) if(!balAt.has(e.account)) balAt.set(e.account,0);
  let totalAt=total0;
  for(const e of events){ if(e.day>atDay) break; balAt.set(e.account,(balAt.get(e.account)||0)+e.amount); totalAt+=e.amount; }
  const accountNames=[...new Set([...balAt.keys(),...events.map(e=>e.account)])].sort((a,b)=>String(a).localeCompare(String(b)));
  const accCur=new Map();
  for(const e of events) if(e.currency && !accCur.has(e.account)) accCur.set(e.account,e.currency);
  const accounts=[];
  for(const acc of accountNames){
    const b=baseMap.get(acc) || {opening:0,currency:currency};
    let income=0, expense=0, count=0, last='';
    for(const e of events){ if(e.day>atDay) break; if(e.account!==acc) continue;
      if(e.amount>0) income+=e.amount; else expense-=e.amount; count++; last=e.date; }
    accounts.push({account:acc,opening:lgRound(b.opening),income:lgRound(income),expense:lgRound(expense),
      balance:lgRound(b.opening+income-expense),currency:b.currency||accCur.get(acc)||currency||'',count,last});
  }
  const balance=o.account ? (balAt.get(String(o.account))||0) : totalAt;
  const series=[], ends=lgBucketEnds(fromDay,toDay,o.bucket||'month');
  const sbal=new Map([...baseMap].map(([k,v])=>[k,v.opening]));
  let srun=total0, idx=0;
  const perAccount=!!o.perAccount;
  for(const end of ends){
    while(idx<events.length && events[idx].day<=end){
      const e=events[idx++]; srun+=e.amount; sbal.set(e.account,(sbal.get(e.account)||0)+e.amount);
    }
    series.push({t:end,date:lgISO(end),account:'*',balance:lgRound(srun),total:lgRound(srun),kind:'total'});
    if(perAccount) for(const acc of accountNames) series.push({t:end,date:lgISO(end),account:acc,balance:lgRound(sbal.get(acc)||0),total:lgRound(srun),kind:'account'});
  }
  const next=events.filter(e=>e.day>atDay).slice(0,Math.max(0,Math.floor(+o.next||8))).map(e=>({
    t:e.day,date:e.date,account:e.account,amount:e.amount,type:e.type,name:e.name,category:e.category,currency:e.currency,rule:e.rule||'',leg:e.leg}));
  const rowsOut=events.map(e=>({id:e.id,t:e.day,date:e.date,source:e.source,leg:e.leg,type:e.type,
    account:e.account,amount:e.amount,balance:e.balance,total:e.total,name:e.name,category:e.category,
    note:e.note,currency:e.currency,rule:e.rule||''}));
  if(!rules.length && rows.length) warnings.push('no recurring rules — add a rules Table for the plan');
  return {ok:true,at:lgISO(atDay),from:lgISO(fromDay),to:lgISO(toDay),atDay,fromDay,toDay,
    events,rowsOut,accounts,series,next,balance:lgRound(balance),count:events.length,warnings,
    cols:{tx:txCols,rules:ruleCols,base:baseCols}};
}
