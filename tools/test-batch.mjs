// Batch Check: разборы (код, текст, срок домена, HLS, баланс), проверки по строкам на поддельном мосте, очередь (modules/batch-kernels.js).
// Проверка: node tools/test-batch.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const rd=p=>fs.readFileSync(path.join(root,p),'utf8');
const ctx=vm.createContext({Math,Object,Array,Set,Map,Number,String,JSON,RegExp,Date,Promise,isFinite,isNaN,parseFloat,parseInt,Uint8Array,TextEncoder,TextDecoder,URL,setTimeout,clearTimeout,btoa,Error,AbortController});
vm.runInContext(rd('modules/netsock-kernels.js')+rd('modules/http-kernels.js')+rd('modules/batch-kernels.js')+
  ';globalThis.K={bchCodeOk,bchHas,bchDate,bchRdap,bchWhois,bchHls,bchTs,bchBalance,bchCheck,bchRunAll,NsConn,nsEnc,bchKindOf};',ctx);
const K=ctx.K, J=x=>JSON.stringify(x);
let bad=0; const ok=(c,m)=>{ if(!c){ bad++; console.error('FAIL: '+m); } };
const eq=(a,b,m)=>ok(J(a)===J(b),m+' (получено '+J(a)+', ждали '+J(b)+')');

// --- чистые разборы
ok(K.bchCodeOk(200,'200') && !K.bchCodeOk(301,'200'),'код 200');
ok(K.bchCodeOk(204,'') && K.bchCodeOk(204,'2xx') && !K.bchCodeOk(404,''),'по умолчанию любой 2xx');
ok(K.bchCodeOk(301,'200,301') && K.bchCodeOk(399,'<400') && !K.bchCodeOk(400,'<400'),'список и сравнение');
ok(K.bchHas('<h1>Hello World</h1>','hello') && !K.bchHas('abc','xyz') && K.bchHas('a1b','/a\\db/'),'текст: слово без регистра и /регулярка/');
eq(new Date(K.bchDate('2026-09-01T10:00:00Z')).toISOString().slice(0,10),'2026-09-01','дата ISO');
eq(new Date(K.bchDate('2026.09.01')).toISOString().slice(0,10),'2026-09-01','дата paid-till (.ru)');
eq(new Date(K.bchDate('15-Sep-2026')).toISOString().slice(0,10),'2026-09-15','дата 15-Sep-2026');
const rd1=K.bchRdap({events:[{eventAction:'registration',eventDate:'2020-01-01T00:00:00Z'},{eventAction:'expiration',eventDate:'2027-03-04T00:00:00Z'}],entities:[{roles:['registrar'],vcardArray:['vcard',[['fn',{},'text','Reg Ltd']]]}]});
eq([new Date(rd1.exp).toISOString().slice(0,10),rd1.reg],['2027-03-04','Reg Ltd'],'RDAP: срок и регистратор');
const wh=K.bchWhois('domain:        EXAMPLE.RU\nregistrar:     RU-CENTER-RU\npaid-till:     2026-11-20T21:00:00Z\n');
eq([new Date(wh.exp).toISOString().slice(0,10),wh.reg],['2026-11-20','RU-CENTER-RU'],'whois: paid-till');
eq(new Date(K.bchWhois('Registry Expiry Date: 2028-01-02T00:00:00Z').exp).toISOString().slice(0,10),'2028-01-02','whois: Registry Expiry Date');
const hm=K.bchHls('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720\nhi.m3u8\n','http://h/x/index.m3u8');
eq([hm.master,hm.variants.length,hm.variants[1].url,hm.variants[1].kbps],[true,2,'http://h/x/hi.m3u8',2400],'HLS мастер');
const hs=K.bchHls('#EXTM3U\n#EXTINF:4,\ns1.ts\n#EXTINF:4,\ns2.ts\n','http://h/x/hi.m3u8');
eq([hs.master,hs.segments,hs.live],[false,['http://h/x/s1.ts','http://h/x/s2.ts'],true],'HLS медиа-плейлист, live');
const ts=new Uint8Array(188*4); for(let i=0;i<4;i++) ts[i*188]=0x47;
ok(K.bchTs(ts) && !K.bchTs(new Uint8Array(1000)),'MPEG-TS по синхробайтам');
eq(K.bchBalance('Баланс: 123,45 р. Тариф X'),123.45,'баланс: «Баланс: 123,45 р.»');
eq(K.bchBalance('Ваш баланс 1 250.5 руб'),1250.5,'баланс с пробелом-разрядом');
eq(K.bchBalance('На счету -12.00 RUB'),-12,'отрицательный');
eq(K.bchBalance('You have 7.30 USD left'),7.3,'число с валютой');
eq(K.bchBalance('Остаток 5 GB, баланс 300 р','(\\d+)\\s*GB'),5,'своя регулярка');
ok(isNaN(K.bchBalance('нет данных')),'нет числа — NaN');

// --- поддельный мост
const sites=new Map();                                  // 'host:port/path' → {status,headers,body|Uint8Array}
const log=[];
function mkNs(){
  const ns={xhooks:new Set(),calls:[],
    async call(cmd,args){
      ns.calls.push([cmd,args]);
      const r=ns.reply[cmd]; if(!r) throw Object.assign(new Error('no '+cmd),{reply:{err:'x'}});
      const v=typeof r==='function' ? r(args) : r; if(v instanceof Error) throw Object.assign(v,{reply:{err:v.code||'x'}});
      return v;
    },
    async connect(host,port,timeout,tls){
      log.push(`${tls ? 'tls' : 'tcp'}://${host}:${port}`);
      if(port===9) throw new Error('refused');
      const c=new K.NsConn({call:async()=>({}),conns:new Map()},1,host+':'+port);
      c.write=async b=>{
        const req=typeof b==='string' ? b : new TextDecoder().decode(b), path=/^GET (\S+)/.exec(req)?.[1]||'/';
        if(port===43){ const w=ns.whois[host]; c._push(K.nsEnc(typeof w==='function' ? w(req.trim()) : w||'')); c._closed(); return; }
        const s=sites.get(host+':'+port+path); if(!s){ c._push(K.nsEnc('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n')); c._closed(); return; }
        const body=typeof s.body==='string' ? K.nsEnc(s.body) : s.body||new Uint8Array(0);
        const h=Object.entries({'content-length':String(body.length),...(s.headers||{})}).map(([k,v])=>k+': '+v).join('\r\n');
        const head=K.nsEnc(`HTTP/1.1 ${s.status||200} X\r\n${h}\r\n\r\n`);
        const all=new Uint8Array(head.length+body.length); all.set(head); all.set(body,head.length); c._push(all); c._closed();
      };
      return c;
    },
    reply:{},whois:{}};
  return ns;
}
const ns=mkNs();
const env={ns:async()=>ns,now:()=>Date.now(),sleep:async()=>{},fetch:null,sel:null};
const O={kind:'ping',keyCol:'id',timeout:2000,expect:'',contains:'',selector:'',port:80,count:2,via:'bridge',warnDays:30,deliveryWait:1,ussdWait:1,conc:3,text:''};

// ping
ns.reply.ping=a=>a.host==='1.1.1.1' ? {got:2,sent:2,avg:12.34} : {got:0,sent:2,avg:0};
let r=await K.bchCheck(env,{id:'a',host:'1.1.1.1'},O);
eq([r.id,r.kind,r.ok,r.status,r.ms,r.loss],['a','ping',1,'ok',12.3,0],'ping жив');
r=await K.bchCheck(env,{id:'b',host:'10.9.9.9'},O);
eq([r.ok,r.status,r.loss],[0,'fail',100],'ping мёртв — fail, не error');
r=await K.bchCheck(env,{host:'1.1.1.1'},O);
eq(r.id,'1.1.1.1','нет колонки ключа — ключ = цель');
// нет приложения
r=await K.bchCheck({...env,ns:async()=>{ throw new Error('no connection — is the DSP app running?'); }},{id:'c',host:'1.1.1.1'},O);
eq([r.ok,r.status,/DSP app/.test(r.detail)],[0,'error',true],'нет моста — error с понятным текстом');

// tcp
r=await K.bchCheck(env,{id:'t1',host:'example.org',kind:'tcp',port:'443'},O);
eq([r.ok,r.status,r.kind],[1,'ok','tcp'],'tcp: порт открыт (kind из колонки)');
r=await K.bchCheck(env,{id:'t2',host:'example.org:9',kind:'tcp'},O);
eq([r.ok,r.status],[0,'fail'],'tcp: отказ — fail');
r=await K.bchCheck(env,{id:'t3',host:'example.org',kind:'tcp'},{...O,port:0});
eq(r.status,'error','tcp без порта — error');

// http
sites.set('example.org:80/',{status:200,body:'<html><div id="promo">Sale</div> Hello</html>'});
sites.set('example.org:80/gone',{status:404,body:'nope'});
r=await K.bchCheck(env,{id:'h1',url:'http://example.org/',kind:'http',expect:'200',contains:'hello'},O);
eq([r.ok,r.code,r.found],[1,200,1],'http 200 и текст найден');
r=await K.bchCheck(env,{id:'h2',url:'http://example.org/',kind:'http',contains:'абракадабра'},O);
eq([r.ok,r.found,/not found/.test(r.detail)],[0,0,true],'http: текста нет — fail');
r=await K.bchCheck(env,{id:'h3',url:'http://example.org/gone',kind:'http',expect:'200'},O);
eq([r.ok,r.code,r.status],[0,404,'fail'],'http 404 — fail');
r=await K.bchCheck(env,{id:'h4',url:'example.org',kind:'http'},O);
eq(r.ok,1,'http без схемы — добавляется http://');
r=await K.bchCheck({...env,sel:(h,c)=>h.includes('id="promo"')},{id:'h5',url:'http://example.org/',kind:'http',selector:'#promo'},O);
eq([r.ok,r.block],[1,1],'http: css-блок найден');
r=await K.bchCheck({...env,sel:()=>false},{id:'h6',url:'http://example.org/',kind:'http',selector:'#nope'},O);
eq([r.ok,r.block],[0,0],'http: css-блока нет — fail');
sites.set('secure.test:443/',{status:200,body:'ok'});
r=await K.bchCheck(env,{id:'h7',url:'https://secure.test/',kind:'http'},O);
eq([r.ok,log.includes('tls://secure.test:443')],[1,true],'https идёт через tls:true приложения');
// браузерный fetch, если приложения нет
const noApp={...env,ns:async()=>{ throw new Error('no app'); },fetch:async()=>({status:200,url:'http://x/',text:async()=>'Hi there'})};
r=await K.bchCheck(noApp,{id:'h8',url:'http://x/',kind:'http',contains:'there'},{...O,via:'auto'});
eq([r.ok,/browser/.test(r.detail)],[1,true],'нет приложения — браузерный fetch (via auto)');

// iptv: HLS мастер → вариант → сегмент
sites.set('tv.test:80/m.m3u8',{headers:{'content-type':'application/vnd.apple.mpegurl'},body:'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720\nv.m3u8\n'});
sites.set('tv.test:80/v.m3u8',{headers:{'content-type':'application/x-mpegurl'},body:'#EXTM3U\n#EXTINF:4,\ns1.ts\n#EXTINF:4,\ns2.ts\n'});
sites.set('tv.test:80/s2.ts',{headers:{'content-type':'video/mp2t'},body:ts});
r=await K.bchCheck(env,{id:'i1',url:'http://tv.test/m.m3u8',kind:'iptv'},O);
eq([r.ok,r.stream,r.kbps,/720/.test(r.detail)],[1,'hls',1500,true],'iptv: HLS мастер → вариант → свежий сегмент');
sites.set('tv.test:80/s2.ts',{status:404,body:''});
r=await K.bchCheck(env,{id:'i2',url:'http://tv.test/m.m3u8',kind:'iptv'},O);
eq([r.ok,r.code],[0,404],'iptv: сегмент 404 — fail');
sites.set('tv.test:80/live',{headers:{'content-type':'video/mp2t'},body:new Uint8Array(188*30).map((_, i)=>i%188===0 ? 0x47 : 1)});
r=await K.bchCheck(env,{id:'i3',url:'http://tv.test/live',kind:'iptv'},O);
eq([r.ok,r.stream],[1,'mpegts'],'iptv: сырой TS-поток');
sites.set('tv.test:80/stall',{headers:{'content-type':'video/mp2t'},body:new Uint8Array(100)});
r=await K.bchCheck(env,{id:'i4',url:'http://tv.test/stall',kind:'iptv'},O);
eq(r.ok,0,'iptv: поток отдал меньше минимума — fail');
sites.set('tv.test:80/page',{headers:{'content-type':'text/html'},body:'<html>login</html>'});
r=await K.bchCheck(env,{id:'i5',url:'http://tv.test/page',kind:'iptv'},O);
eq([r.ok,/web page/.test(r.detail)],[0,true],'iptv: страница вместо потока — fail');
r=await K.bchCheck(env,{id:'i6',url:'rtmp://tv.test/x',kind:'iptv'},O);
eq(r.status,'error','iptv: rtmp не поддержан — error');

// domain: RDAP, затем whois
const inDays=n=>new Date(Date.now()+n*864e5).toISOString();
sites.set('rdap.org:443/domain/example.com',{body:JSON.stringify({events:[{eventAction:'expiration',eventDate:inDays(100)}],entities:[]})});
r=await K.bchCheck(env,{id:'d1',domain:'https://www.example.com/path',kind:'domain'},O);
eq([r.ok,r.days>=99&&r.days<=101,r.expires.length],[1,true,10],'domain: RDAP, срок 100 дней');
sites.set('rdap.org:443/domain/soon.com',{body:JSON.stringify({events:[{eventAction:'expiration',eventDate:inDays(5)}]})});
r=await K.bchCheck(env,{id:'d2',domain:'soon.com',kind:'domain'},O);
eq([r.ok,r.status],[0,'fail'],'domain: меньше 30 дней — fail');
r=await K.bchCheck(env,{id:'d2b',domain:'soon.com',kind:'domain',warn:'3'},O);
eq(r.ok,1,'domain: порог warn в колонке строки');
ns.whois['whois.iana.org']=q=>q==='ru' ? 'refer:        whois.tcinet.ru\n' : ''; ns.whois['whois.tcinet.ru']='registrar: RU-CENTER\npaid-till: '+inDays(200)+'\n';
r=await K.bchCheck(env,{id:'d3',domain:'site.ru',kind:'domain'},O);
eq([r.ok,/whois/.test(r.detail),r.registrar],[1,true,'RU-CENTER'],'domain: нет RDAP — whois (.ru paid-till)');
r=await K.bchCheck(env,{id:'d4',domain:'nothing.zz',kind:'domain'},O);
eq(r.ok,0,'domain: даты нигде нет — fail');

// sms: отправка и отчёт
const hookEmit=rec=>{ for(const h of [...ns.xhooks]) h(rec); };
ns.reply['sms.send']=a=>{ ns.sent=(ns.sent||[]).concat(a.to); setTimeout(()=>hookEmit({src:'sms',dir:'status',req:7,status:a.to==='+7222' ? 'failed' : 'delivered'}),5); return {req:7}; };
r=await K.bchCheck(env,{id:'s1',to:'+7 (111)',kind:'sms',text:'hi'},O);
eq([r.ok,r.delivery,ns.sent[0]],[1,'delivered','+7111'],'sms: доставлено, номер очищен');
r=await K.bchCheck(env,{id:'s2',to:'+7222',kind:'sms',text:'hi'},O);
eq([r.ok,r.delivery],[0,'failed'],'sms: отчёт «не доставлено»');
ns.reply['sms.send']=()=>({req:8});
r=await K.bchCheck(env,{id:'s3',to:'+7333',kind:'sms',text:'hi'},{...O,deliveryWait:0.05});
eq([r.ok,r.delivery],[1,'unknown'],'sms: отчёта нет — отправлено, доставка unknown (не ошибка)');
ns.reply['sms.send']=()=>({});
r=await K.bchCheck(env,{id:'s4',to:'+7444',kind:'sms',text:'hi'},O);
eq(/update the app/.test(r.delivery),true,'sms: старое приложение без req');
r=await K.bchCheck(env,{id:'s5',to:'+7555',kind:'sms'},O);
eq(r.status,'error','sms без текста — error');
let rate=0; ns.reply['sms.send']=()=>{ if(rate++<2) return Object.assign(new Error('limit'),{code:'rate'}); return {}; };
r=await K.bchCheck(env,{id:'s6',to:'+7666',kind:'sms',text:'x'},O);
eq([r.ok,rate],[1,3],'sms: лимит 5 в минуту — ждёт и повторяет');

// ussd: баланс, по SIM
ns.reply['ussd.send']=a=>{ setTimeout(()=>hookEmit({src:'ussd',code:a.code,ok:true,text:a.sim===1 ? 'Баланс: 55,5 р.' : 'Ваш баланс 120 руб'}),5); return {}; };
r=await K.bchCheck(env,{id:'u0',kind:'ussd',code:'*100#',sim:'0'},O);
eq([r.ok,r.balance],[1,120],'ussd: SIM 0');
r=await K.bchCheck(env,{id:'u1',kind:'ussd',code:'*100#',sim:'1'},O);
eq([r.ok,r.balance,ns.calls.at(-1)[1].sim],[1,55.5,1],'ussd: SIM 1, слот ушёл в команду');
ns.reply['ussd.send']=a=>{ setTimeout(()=>hookEmit({src:'ussd',code:a.code,ok:false,failure:'NETWORK_ERROR'}),5); return {}; };
r=await K.bchCheck(env,{id:'u2',kind:'ussd',code:'*100#'},O);
eq([r.ok,/NETWORK_ERROR/.test(r.detail)],[0,true],'ussd: сеть отказала — fail');
r=await K.bchCheck(env,{id:'u3',kind:'ussd',code:'*100'},O);
eq(r.status,'error','ussd: код без # — error');
ns.reply['ussd.send']=()=>({});
r=await K.bchCheck(env,{id:'u4',kind:'ussd',code:'*100#'},{...O,ussdWait:0.001});
eq([r.ok,/no answer/.test(r.detail)],[0,true],'ussd: нет ответа сети — fail по таймауту');
// запросы USSD идут по очереди (параллельные не мешают друг другу)
ns.reply['ussd.send']=a=>{ setTimeout(()=>hookEmit({src:'ussd',code:a.code,ok:true,text:'баланс '+(a.sim+1)*10}),5); return {}; };
const both=await Promise.all([0,1].map(s=>K.bchCheck(env,{id:'p'+s,kind:'ussd',code:'*100#',sim:String(s)},O)));
eq(both.map(x=>x.balance),[10,20],'ussd: две SIM параллельно — каждая получает свой ответ');

// очередь: смешанные строки, conc, ключи, прогресс
const rows=[{id:'1',host:'1.1.1.1'},{id:'2',host:'10.9.9.9'},{id:'3',host:'example.org',kind:'tcp',port:'80'},{id:'4',url:'http://example.org/',kind:'http'}];
const seen=[], prog=[];
const recs=await K.bchRunAll(env,rows,O,{onRec:(rec,row,i)=>seen.push(rec.id),onProgress:(d,t)=>prog.push(d+'/'+t)});
eq(recs.map(x=>x.id),['1','2','3','4'],'очередь: результаты по порядку строк');
eq(recs.map(x=>x.ok),[1,0,1,1],'очередь: ok по строкам');
eq(prog,['1/4','2/4','3/4','4/4'],'очередь: прогресс');
let stopAt=0;
const part=await K.bchRunAll(env,rows,{...O,conc:1},{onRec:()=>{ stopAt++; },stop:()=>stopAt>=2});
eq(part.filter(Boolean).length,2,'очередь: stop() останавливает на середине');

// Stop обрывает зависшие проверки сразу, а не ждёт их таймаутов
ns.reply.ping=()=>new Promise(()=>{});                               // мост молчит
let stopRes; const stopP=new Promise(r=>{ stopRes=r; });
const t0=Date.now(); setTimeout(()=>stopRes(null),30);
const hung=await K.bchRunAll(env,[{id:'x',host:'a'},{id:'y',host:'b'},{id:'z',host:'c'}],{...O,conc:2},{stopP,stop:()=>false});
ok(Date.now()-t0<2000 && hung.filter(Boolean).length===0,'Stop: зависшие проверки брошены сразу');
// приложение отказывает недоверенной странице — понятный текст
ns.reply.ping=()=>Object.assign(new Error('only the page of the DSP app may use it'),{code:'forbidden'});
r=await K.bchCheck(env,{id:'f',host:'1.1.1.1'},O);
ok(r.status==='error' && /Let any page use actions/.test(r.detail),'forbidden: подсказка про настройку приложения');

if(bad){ console.error(bad+' ошибок'); process.exit(1); }
console.log('ok: batch');
