"use strict";
/* ============================ Batch Check ============================
   Список → проверка каждой строки → результат в ту же строку. Строка таблицы сама говорит, что с ней делать (колонка kind) и с кем
   (host / url / domain / to …): ping, tcp-порт, страница сайта (код, текст, css-блок), поток IPTV, срок регистрации домена,
   SMS с отчётом о доставке, баланс SIM по USSD. Записи {<ключ>, ok, status, ms, detail, …} идут на rec — в Table с тем же ключом (upsert),
   так результат ложится в строку, из которой взят адрес. Сетевое — через приложение DSP на Android (ping, сокеты, https, SMS, USSD);
   страницы без приложения читаются fetch браузера (если сайт разрешает CORS). Логика — batch-kernels.js (node tools/test-batch.mjs). */

function bchSelEnv(html,css){
  try{ return !!new DOMParser().parseFromString(html,'text/html').querySelector(css); }catch(e){ return null; }
}
function bchEnv(n){
  return {ns:()=>nsvLink(n),now:()=>Date.now(),sleep:ms=>new Promise(r=>setTimeout(r,ms)),sel:bchSelEnv,
    fetch:typeof fetch==='function' ? (u,o)=>fetch(u,o) : null};
}
async function bchLoad(n){                                   // строки: провод rows, иначе список из хранилища
  if(Array.isArray(n.rowsIn) && n.rowsIn.length) return n.rowsIn.map(r=>({...r}));
  const name=tblCanon(String(n.listIn||n.p.list||'').trim());
  if(!name) return [];
  if(tblKind(name)==='patch') throw new Error('a list inside a patch is not in storage: wire its rows');
  return (await tblReadList(n,name)).rows.map(r=>({...r}));
}
function bchStop(n){ n.bcStop=true; if(n.bcBusy) n.status='stopping…'; }
async function bchRun(n){
  if(n.bcBusy){ n.status='busy — wait for the previous run or press Stop'; return; }
  n.bcBusy=true; n.bcStop=false; n.bcOk=0; n.bcBad=0; n.bcDone=0; n.status='reading the list…';
  try{
    const rows=await bchLoad(n);
    if(!rows.length){ n.status='no rows: wire «rows» from a Table or set «list»'; return; }
    n.bcTotal=rows.length; n.bcRows=rows; n.bcOutRows=rows.slice(); n.bcLast=[];
    n.status='checking 0/'+rows.length+'…';
    const p=n.p, o={kind:p.kind,keyCol:p.key||'id',targetCol:p.target,conc:p.conc,timeout:p.timeout,via:p.via,port:p.port,count:p.count,expect:p.expect,
      contains:p.contains,selector:p.selector,minBytes:p.minBytes,warnDays:p.warnDays,text:p.text,deliveryWait:p.deliveryWait,code:p.code,sim:p.sim,
      ussdWait:p.ussdWait,balanceRe:p.balanceRe};
    await bchRunAll(bchEnv(n),rows,o,{
      stop:()=>n.bcStop || n.disposed,
      onRec:(rec,row,i)=>{
        nsvPush(n,rec);
        n.bcOutRows[i]={...row,...rec}; n.bcOutRows=n.bcOutRows.slice();
        if(rec.ok) n.bcOk++; else n.bcBad++;
        n.bcLast.push(rec); if(n.bcLast.length>12) n.bcLast.shift();
      },
      onProgress:(d,t)=>{ n.bcDone=d; n.status=(n.bcStop ? 'stopping… ' : 'checking ')+d+'/'+t+' · ok '+n.bcOk+' · bad '+n.bcBad; }});
    n.status=(n.bcStop ? 'stopped ' : 'done ')+n.bcDone+'/'+rows.length+' · ok '+n.bcOk+' · bad '+n.bcBad;
    n.pulse=2;
  }catch(e){ n.status='error: '+(e.message||e); }
  n.bcBusy=false; n.bcAt=Date.now();
}
def({ id:'batch', title:'Batch Check (list → results in the same table)', cat:'Sources',
  kw:'batch check list table ping tcp http status code page block text iptv stream m3u8 hls domain whois rdap expiry expire sms deliver delivery ussd balance sim monitor uptime availability bulk each rows contacts',
  ins:[{n:'rows',t:'bands'},{n:'go',t:'num'},{n:'list',t:'txt'}],
  outs:[{n:'rec',t:'rec'},{n:'rows',t:'bands'},{n:'text',t:'txt'},{n:'ok',t:'num'},{n:'bad',t:'num'},{n:'progress',t:'num'},{n:'busy',t:'num'},{n:'new',t:'num'}],
  readout:true, tall:true, w:280,
  groups:[{n:'Source'},{n:'Check'},{n:'Ping / TCP',open:false},{n:'HTTP page',open:false},{n:'IPTV',open:false},{n:'Domain',open:false},{n:'SMS',open:false},{n:'USSD / balance',open:false}],
  params:[
    {n:'url',t:'text',d:NSV_URL,dev:true,label:'bridge of the DSP app — an address, or @name from Settings → Devices'},
    {n:'list',t:'text',d:'',label:'list (storage) — the rows to check (the «rows» wire or the «list» input overrides)',g:'Source'},
    {n:'key',t:'text',d:'id',label:'key column — put the same one in the Table (upsert) so a result lands in its row',g:'Source'},
    {n:'target',t:'text',d:'',label:'column with the address (empty — the first of target, host, ip, url, stream, domain, to, number, phone)',g:'Source'},
    {n:'kind',t:'select',opts:BCH_KINDS,d:'ping',label:'what to check (a «kind» column in a row overrides it)',g:'Check'},
    {n:'via',t:'select',opts:['auto','bridge','browser'],d:'auto',label:'http / iptv / domain: through the app (any site, https), or the browser fetch (CORS), auto — the app if it is running',g:'Check'},
    {n:'conc',t:'range',min:1,max:32,step:1,d:4,label:'at the same time (SMS and USSD always go one by one)',g:'Check'},
    {n:'timeout',t:'range',min:1000,max:60000,step:500,d:8000,label:'wait for one check, ms',g:'Check'},
    {n:'every',t:'range',min:0,max:86400,step:10,d:0,label:'repeat every N s after the run ends (0 — only on Run / go)',g:'Check'},
    {n:'auto',t:'check',d:false,label:'run once when the patch starts',g:'Check'},
    {n:'count',t:'range',min:1,max:10,step:1,d:2,label:'ping: packets (a «count» column overrides)',g:'Ping / TCP'},
    {n:'port',t:'range',min:0,max:65535,step:1,d:80,label:'tcp: port (a «port» column or host:port overrides)',g:'Ping / TCP'},
    {n:'expect',t:'text',d:'2xx',label:'expected code: 200, 2xx, 200,301, <400 (an «expect» column overrides)',g:'HTTP page'},
    {n:'contains',t:'text',d:'',label:'the page must contain this text, or /regex/i (a «contains» column overrides)',g:'HTTP page'},
    {n:'selector',t:'text',d:'',label:'the page must have this css block, e.g. #promo (browser parsing; a «selector» column overrides)',g:'HTTP page'},
    {n:'minBytes',t:'range',min:188,max:65536,step:188,d:2048,label:'a raw stream must give at least this many bytes (a «minbytes» column overrides)',g:'IPTV'},
    {n:'warnDays',t:'range',min:0,max:365,step:1,d:30,label:'bad when the domain expires in fewer days (a «warn» column overrides)',g:'Domain'},
    {n:'text',t:'text',d:'',label:'message (a «text» column overrides); to — the number column (to / number / phone)',g:'SMS'},
    {n:'deliveryWait',t:'range',min:0,max:600,step:5,d:60,label:'wait for the delivery report, s (0 — do not wait; carriers may send none)',g:'SMS'},
    {n:'code',t:'text',d:'*100#',label:'USSD code (a «code» column overrides)',g:'USSD / balance'},
    {n:'sim',t:'text',d:'',label:'SIM slot from 0 (empty — default; a «sim» column overrides)',g:'USSD / balance'},
    {n:'ussdWait',t:'range',min:5,max:120,step:5,d:40,label:'wait for the network answer, s',g:'USSD / balance'},
    {n:'balanceRe',t:'text',d:'',label:'regex whose group 1 is the balance (empty — find the number near «баланс / balance / остаток»)',g:'USSD / balance'},
    {n:'run',t:'button',label:'Run',fn:n=>bchRun(n)},
    {n:'stop',t:'button',label:'Stop',fn:n=>bchStop(n)}],
  init:n=>{ n.nsP=null; n.ns=null; n.ws=null; n.recQ=[]; n.warn=''; n.status='idle'; n.pulse=0; n.prevGo=0; n.rowsIn=null; n.listIn='';
    n.bcBusy=false; n.bcStop=false; n.bcOk=0; n.bcBad=0; n.bcDone=0; n.bcTotal=0; n.bcRows=[]; n.bcOutRows=null; n.bcLast=[]; n.bcAt=0; n.bcStarted=false; },
  dispose:n=>{ n.disposed=true; nsvDrop(n); },
  process(n,I){
    n.rowsIn=Array.isArray(I.rows) ? I.rows : null; n.listIn=typeof I.list==='string' ? I.list : '';
    const go=(I.go||0)>.5; if(go && !n.prevGo) bchRun(n); n.prevGo=go;
    if(!n.bcStarted){ n.bcStarted=true; if(n.p.auto) setTimeout(()=>{ if(!n.disposed) bchRun(n); },1500); }
    else if(+n.p.every>0 && !n.bcBusy && n.bcAt && Date.now()-n.bcAt>=n.p.every*1000) bchRun(n);
    const pl=n.pulse>0 ? 1 : 0; if(n.pulse>0) n.pulse--;
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    return {rec,rows:n.bcOutRows,text:n.bcLast.length ? n.bcLast.map(r=>(r.status==='ok' ? '✓ ' : r.status==='fail' ? '✗ ' : '⚠ ')+r.id+' '+r.detail).join('\n') : null,
      ok:n.bcOk,bad:n.bcBad,progress:n.bcTotal ? n.bcDone/n.bcTotal : 0,busy:n.bcBusy ? 1 : 0,new:pl};
  },
  draw(n){
    const r=n.el.querySelector('.readout'); if(!r) return;
    const t=(n.warn&&!n.ns ? '⚠ '+n.warn+'\n' : '')+n.status+(n.bcLast.length ? '\n'+n.bcLast.slice(-8).map(x=>(x.status==='ok' ? '✓ ' : x.status==='fail' ? '✗ ' : '⚠ ')+String(x.id).slice(0,22)+' · '+String(x.detail).slice(0,60)).join('\n') : '');
    if(r.textContent!==t) r.textContent=t;
  }
});
