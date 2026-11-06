"use strict";
/* ============================ Batch Check — ядро ============================
   Пакетные проверки по строкам таблицы: у каждой строки своё «что проверить» (kind) и «кого» (host / url / номер), результат ложится
   в поля той же строки (ok, status, ms, detail + поля вида). Без DOM — проверяется в tools/test-batch.mjs.
   Виды: ping, tcp, http (код + текст + css-селектор), iptv (HLS-плейлист / сегмент / сырой поток), domain (срок регистрации: RDAP, затем whois),
         sms (отправка + отчёт о доставке), ussd (баланс SIM), node (обработчик — ваш граф: запись-задача на выход task, ответ-запись на вход result).
   env: {task(row,attempt,ms)→Promise<rec|null> (вид node), cond(r,t)→bool (условие успеха), ns():Promise<NetSock> (мост приложения; бросает, если нет), fetch (браузерный), now(), sel(html,css)→bool|null (DOM), sleep(ms)} */

const BCH_KINDS=['ping','tcp','http','iptv','domain','sms','ussd','node'];
const BCH_TARGET=['target','host','ip','url','stream','domain','to','number','phone','tel','addr'];
const bchSleep=ms=>new Promise(r=>setTimeout(r,ms));
const bchStr=v=>v==null ? '' : String(v).trim();
const bchPick=(row,cols)=>{ for(const c of cols){ const v=bchStr(row[c]); if(v) return v; } return ''; };
const bchKindOf=(row,def)=>{ const k=bchStr(row.kind||row.check).toLowerCase(); return BCH_KINDS.includes(k) ? k : def; };
// свой параметр строки (колонка) важнее общего параметра узла
const bchOpt=(row,name,def)=>{ const v=row[name]; return v!=null && bchStr(v)!=='' ? v : def; };

/* ---------- чистые разборы ---------- */
// ожидаемый код: «200», «2xx», «200,301», «<400»; пусто — любой 2xx
function bchCodeOk(code,expect){
  code=+code; const e=bchStr(expect)||'2xx';
  return e.split(/[,;\s]+/).filter(Boolean).some(t=>{
    let m;
    if((m=/^(\d)xx$/i.exec(t))) return Math.floor(code/100)===+m[1];
    if((m=/^([<>]=?)(\d+)$/.exec(t))) return m[1]==='<' ? code<+m[2] : m[1]==='<=' ? code<=+m[2] : m[1]==='>' ? code>+m[2] : code>=+m[2];
    return code===+t;
  });
}
// текст на странице: «слово» (без регистра) или /регулярка/флаги
function bchHas(text,pat){
  pat=bchStr(pat); if(!pat) return true;
  const m=/^\/(.+)\/([a-z]*)$/.exec(pat);
  if(m){ try{ return new RegExp(m[1],m[2]).test(text); }catch(e){ return false; } }
  return text.toLowerCase().includes(pat.toLowerCase());
}
const bchMon={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
function bchDate(s){                                    // 2026-09-01T00:00:00Z, 2026.09.01, 01-Sep-2026, 01.09.2026 → мс | NaN
  s=bchStr(s); let m;
  if((m=/^(\d{4})[.\/](\d{2})[.\/](\d{2})/.exec(s))) return Date.UTC(+m[1],+m[2]-1,+m[3]);
  if((m=/^(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s](\d{4})/.exec(s))) return Date.UTC(+m[3],bchMon[m[2].toLowerCase()],+m[1]);
  if((m=/^(\d{1,2})\.(\d{2})\.(\d{4})/.exec(s))) return Date.UTC(+m[3],+m[2]-1,+m[1]);
  const t=Date.parse(s); return isNaN(t) ? NaN : t;
}
const bchDays=(t,now)=>Math.ceil((t-now)/864e5);
const bchIso=t=>new Date(t).toISOString().slice(0,10);
// RDAP (JSON): событие expiration + регистратор
function bchRdap(j){
  let exp=NaN, reg='';
  for(const e of j?.events||[]) if(/expiration/i.test(e.eventAction||'')){ const t=bchDate(e.eventDate); if(!isNaN(t)) exp=t; }
  for(const en of j?.entities||[]) if((en.roles||[]).includes('registrar')){
    const f=(en.vcardArray?.[1]||[]).find(x=>x[0]==='fn'); if(f) reg=bchStr(f[3]);
  }
  return {exp,reg};
}
// whois (текст): paid-till / Registry Expiry Date / Expiry date …
function bchWhois(text){
  const m=/^[ \t]*(?:paid-till|registry expiry date|registrar registration expiration date|expir(?:y|ation) date|expires(?: on)?|renewal date|valid until)[ \t]*:[ \t]*(.+)$/im.exec(text);
  const r=/^[ \t]*(?:registrar|sponsoring registrar)[ \t]*:[ \t]*(.+)$/im.exec(text);
  return {exp:m ? bchDate(m[1]) : NaN, reg:r ? bchStr(r[1]) : ''};
}
// HLS: мастер-плейлист (варианты) или медиа-плейлист (сегменты)
function bchHls(text,base){
  const lines=text.split(/\r?\n/).map(x=>x.trim()), res=s=>{ try{ return new URL(s,base).href; }catch(e){ return s; } };
  const variants=[], segs=[];
  for(let i=0;i<lines.length;i++){
    if(lines[i].startsWith('#EXT-X-STREAM-INF')){
      const bw=/BANDWIDTH=(\d+)/.exec(lines[i]), rs=/RESOLUTION=(\d+x\d+)/.exec(lines[i]);
      const u=lines.slice(i+1).find(x=>x && !x.startsWith('#')); if(u) variants.push({url:res(u),kbps:bw ? Math.round(+bw[1]/1000) : 0,res:rs ? rs[1] : ''});
    } else if(lines[i] && !lines[i].startsWith('#')) segs.push(res(lines[i]));
  }
  return {master:variants.length>0,variants:variants.length ? variants : [],segments:variants.length ? [] : segs,live:!/#EXT-X-ENDLIST/.test(text)};
}
// MPEG-TS: синхробайт 0x47 каждые 188 байт
function bchTs(b){
  for(let s=0;s<Math.min(188,b.length);s++){ let n=0; for(let k=s;k<b.length;k+=188){ if(b[k]!==0x47){ n=-1; break; } n++; } if(n>=2) return true; }
  return false;
}
// баланс из ответа USSD: число рядом с «баланс / balance / остаток …», иначе первое число с валютой, иначе первое число
function bchBalance(text,re){
  text=bchStr(text);
  if(re){ try{ const m=new RegExp(re,'i').exec(text); if(m){ const v=parseFloat(String(m[1]??m[0]).replace(/\s/g,'').replace(',','.')); if(!isNaN(v)) return v; } }catch(e){} return NaN; }
  const num='(-?\\d[\\d\\s]*(?:[.,]\\d{1,2})?)';
  const tries=[new RegExp('(?:баланс|balance|остаток|на счету|saldo|solde|credit)\\D{0,25}?'+num,'i'),new RegExp(num+'\\s*(?:р\\b|руб|₽|rub|usd|\\$|€|eur|грн|uah|тг|kzt|byn|br\\b)','i'),new RegExp(num)];
  for(const r of tries){ const m=r.exec(text); if(m){ const v=parseFloat(m[1].replace(/\s/g,'').replace(',','.')); if(!isNaN(v)) return v; } }
  return NaN;
}

/* ---------- ожидание записи моста, не относящейся к сокетам (ussd / sms): NetSock.xhooks ---------- */
function bchWait(ns,pred,ms){
  ns.xhooks=ns.xhooks||new Set();
  return new Promise(res=>{
    const h=r=>{ let ok=false; try{ ok=pred(r); }catch(e){} if(ok){ ns.xhooks.delete(h); clearTimeout(t); res(r); } };
    const t=setTimeout(()=>{ ns.xhooks.delete(h); res(null); },ms);
    ns.xhooks.add(h);
  });
}

/* ---------- HTTP: мост приложения (http/https по tcp.connect) или fetch браузера ---------- */
async function bchGet(env,url,o={}){
  const t0=env.now(), ms=o.timeout||10000, via=o.via||'auto';
  let ns=null;
  if(via!=='browser'){ try{ ns=await env.ns(); }catch(e){ if(via==='bridge') throw e; } }
  if(ns){
    const r=await httpFetch(ns,url,{headers:o.headers||{},timeout:ms,maxBody:o.max||(2<<20),redirects:5});
    return {status:r.status,text:r.text(),bytes:r.body.length,ms:env.now()-t0,via:'app',url:r.url,headers:r.headers};
  }
  const f=env.fetch; if(!f) throw new Error('no network: neither the app nor fetch');
  const ac=typeof AbortController!=='undefined' ? new AbortController() : null, tm=ac ? setTimeout(()=>ac.abort(),ms) : 0;
  try{
    const r=await f(url,{headers:o.headers||{},signal:ac?.signal,redirect:'follow',cache:'no-store'});
    const text=await r.text();
    return {status:r.status,text,bytes:text.length,ms:env.now()-t0,via:'browser',url:r.url||url,headers:{}};
  }catch(e){
    throw new Error(/abort/i.test(e.message) ? 'timeout' : /fetch|network|cors/i.test(e.message) ? 'blocked by the browser (CORS) — use a bridge (phone app / Node bridge) with via «bridge», or set a CORS proxy in Settings' : e.message);
  } finally { clearTimeout(tm); }
}
// первые bytes байт ответа (поток IPTV бесконечный — целиком не читаем)
async function bchSniff(env,url,o={}){
  const bytes=o.bytes||4096, ms=o.timeout||10000, t0=env.now(), via=o.via||'auto';
  let ns=null;
  if(via!=='browser'){ try{ ns=await env.ns(); }catch(e){ if(via==='bridge') throw e; } }
  if(ns){
    let cur=url;
    for(let hop=0;hop<5;hop++){
      const u=httpParseUrl(cur); if(!u) throw new Error('unsupported address (http:// or https:// only): '+cur.slice(0,60));
      const c=await ns.connect(u.host,u.port,Math.min(ms,8000),u.tls);
      try{
        await c.write('GET '+u.path+' HTTP/1.1\r\nhost: '+u.host+(u.port!==(u.tls ? 443 : 80) ? ':'+u.port : '')+'\r\nconnection: close\r\nuser-agent: DSP\r\naccept: */*\r\n\r\n');
        const raw=await c.readUntil('\r\n\r\n',ms,65536); if(!raw) throw new Error('no answer');
        const lines=nsDec(raw).trimEnd().split(/\r?\n/), m=/^HTTP\/\d\.\d (\d{3})/.exec(lines[0]); if(!m) throw new Error('not an HTTP answer');
        const status=+m[1], headers=httpParseHeaders(lines.slice(1));
        if([301,302,303,307,308].includes(status) && headers.location){ cur=new URL(headers.location,cur).href; continue; }
        if(/chunked/i.test(headers['transfer-encoding']||'')) await c.readUntil('\r\n',ms).catch(()=>{});          // размер первого куска — не данные
        const parts=[]; let got=0;
        const end=env.now()+ms;
        while(got<bytes){
          let b; try{ b=await c.readAny(Math.max(200,end-env.now())); }catch(e){ break; }
          if(!b) break; parts.push(b); got+=b.length;
        }
        return {status,headers,data:nsCat(parts).subarray(0,bytes),ms:env.now()-t0,via:'app',url:cur};
      } finally { await c.close(); }
    }
    throw new Error('too many redirects');
  }
  const f=env.fetch; if(!f) throw new Error('no network: neither the app nor fetch');
  const ac=new AbortController(), tm=setTimeout(()=>ac.abort(),ms);
  try{
    const r=await f(url,{signal:ac.signal,redirect:'follow',cache:'no-store'});
    const parts=[]; let got=0;
    if(r.body?.getReader){
      const rd=r.body.getReader();
      while(got<bytes){ const x=await rd.read(); if(x.done) break; parts.push(x.value); got+=x.value.length; }
      try{ await rd.cancel(); }catch(e){}
    } else { const b=new Uint8Array(await r.arrayBuffer()); parts.push(b); }
    return {status:r.status,headers:{'content-type':r.headers?.get?.('content-type')||''},data:nsCat(parts).subarray(0,bytes),ms:env.now()-t0,via:'browser',url:r.url||url};
  }catch(e){
    throw new Error(/abort/i.test(e.message) ? 'timeout' : /fetch|network|cors/i.test(e.message) ? 'blocked by the browser (CORS) — use a bridge (phone app / Node bridge) with via «bridge», or set a CORS proxy in Settings' : e.message);
  } finally { clearTimeout(tm); ac.abort(); }
}

/* ---------- проверки: каждая → {ok, detail, ...поля} ---------- */
async function bchPing(env,row,o){
  const host=o.target, ns=await env.ns(), cnt=Math.max(1,Math.min(10,+bchOpt(row,'count',o.count)||2));
  const r=await ns.call('ping',{host,count:cnt,timeout:Math.max(1,Math.round((+o.timeout||5000)/1000))},(+o.timeout||5000)+cnt*2000+3000);
  const got=+r.got||0, sent=+r.sent||cnt;
  return {ok:got>0,ms:got>0 ? Math.round((+r.avg||0)*10)/10 : '',loss:Math.round(100*(1-got/sent)),detail:got>0 ? got+'/'+sent+' replies, avg '+(+r.avg||0).toFixed(1)+' ms' : 'no reply'};
}
async function bchTcp(env,row,o){
  let host=o.target, port=+bchOpt(row,'port',o.port)||0; const m=/^(.*):(\d{1,5})$/.exec(host);
  if(m && !host.includes('://') && !/:.*:/.test(host.replace(/^\[.*\]/,''))){ host=m[1]; port=+m[2]; }
  if(!port) throw new Error('set the port (a «port» column or host:port)');
  const ns=await env.ns(), t0=env.now();
  try{
    const c=await ns.connect(host,port,+o.timeout||5000); await c.close();
    return {ok:true,ms:env.now()-t0,detail:'port '+port+' is open'};
  }catch(e){
    if(['forbidden','unsupported','disabled','args','rate','permission'].includes(e.reply?.err)) throw e;      // не ответ хоста, а отказ самого моста
    return {ok:false,detail:/refus/i.test(e.message) ? 'port '+port+' refused (host is up)' : e.message};
  }
}
async function bchHttp(env,row,o){
  let url=o.target; if(!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url='http://'+url;
  const r=await bchGet(env,url,{timeout:o.timeout,via:o.via});
  const expect=bchOpt(row,'expect',o.expect), contains=bchStr(bchOpt(row,'contains',o.contains)), sel=bchStr(bchOpt(row,'selector',o.selector));
  const out={ok:bchCodeOk(r.status,expect),code:r.status,ms:r.ms,bytes:r.bytes,detail:'HTTP '+r.status+' · '+r.bytes+' B · '+r.ms+' ms ('+r.via+')'};
  if(contains){ out.found=bchHas(r.text,contains) ? 1 : 0; if(!out.found){ out.ok=false; out.detail+=' · text not found'; } }
  if(sel){
    const f=env.sel ? env.sel(r.text,sel) : null;
    if(f==null) out.detail+=' · selector is checked only in the browser';
    else { out.block=f ? 1 : 0; if(!f){ out.ok=false; out.detail+=' · block «'+sel+'» not found'; } }
  }
  return out;
}
async function bchIptv(env,row,o){
  const url=o.target, ms=+o.timeout||10000, minB=Math.max(188,+bchOpt(row,'minbytes',o.minBytes)||2048);
  if(!/^https?:\/\//i.test(url)) throw new Error('only http:// and https:// streams are checked (rtmp / udp / rtsp need the app)');
  let r=await bchSniff(env,url,{bytes:1<<16,timeout:ms,via:o.via});
  if(r.status<200 || r.status>=300) return {ok:false,code:r.status,ms:r.ms,detail:'HTTP '+r.status};
  const ct=String(r.headers['content-type']||'').toLowerCase(), head=nsDec(r.data.subarray(0,16));
  const out={ok:false,code:r.status,ms:r.ms,stream:'',kbps:'',detail:''};
  if(head.startsWith('#EXTM3U') || /mpegurl/.test(ct)){
    let pl=bchHls(nsDec(r.data),r.url), res='';
    if(pl.master){
      const v=pl.variants.slice().sort((a,b)=>b.kbps-a.kbps)[0]; res=(v.res||'')+(v.kbps ? ' '+v.kbps+' kbps' : ''); out.kbps=v.kbps||'';
      r=await bchSniff(env,v.url,{bytes:1<<16,timeout:ms,via:o.via});
      if(r.status<200 || r.status>=300) return {...out,ok:false,code:r.status,detail:'HLS: variant playlist HTTP '+r.status};
      pl=bchHls(nsDec(r.data),r.url);
    }
    out.stream='hls';
    if(!pl.segments.length) return {...out,ok:false,detail:'HLS: playlist has no segments'};
    const seg=await bchSniff(env,pl.segments[pl.segments.length-1],{bytes:4096,timeout:ms,via:o.via});     // самый свежий сегмент
    out.ms=seg.ms;
    if(seg.status<200 || seg.status>=300) return {...out,ok:false,code:seg.status,detail:'HLS: last segment HTTP '+seg.status};
    out.ok=seg.data.length>=188; out.detail='HLS'+(res ? ' '+res : '')+' · '+pl.segments.length+' segments'+(pl.live ? ' · live' : '')+' · last segment '+seg.data.length+' B in '+seg.ms+' ms';
    if(!out.ok) out.detail='HLS: last segment is empty';
    return out;
  }
  if(/text\/html/.test(ct) || /^\s*<(!doctype|html)/i.test(nsDec(r.data.subarray(0,64)))) return {...out,ok:false,detail:'got a web page, not a stream'};
  out.stream=bchTs(r.data) ? 'mpegts' : /mp4|matroska|webm|flv|ogg|audio|video|octet/.test(ct) ? (ct.split(';')[0].split('/')[1]||'raw') : 'raw';
  out.ok=r.data.length>=minB; out.detail=out.stream+' · '+r.data.length+' B in '+r.ms+' ms'+(out.ok ? '' : ' — fewer than '+minB+' (stalls)');
  return out;
}
async function bchWhoisText(ns,server,q,ms){
  const c=await ns.connect(server,43,Math.min(ms,8000));
  try{ await c.write(q+'\r\n'); const b=await c.readAll(ms,1<<20); return nsDec(b); } finally { await c.close(); }
}
async function bchDomain(env,row,o){
  const dom=o.target.replace(/^[a-z]+:\/\//i,'').replace(/[\/:?#].*$/,'').replace(/^www\./i,'').toLowerCase(), warn=+bchOpt(row,'warn',o.warnDays); const ms=+o.timeout||10000, now=env.now();
  let res={exp:NaN,reg:''}, src='';
  try{
    const r=await bchGet(env,'https://rdap.org/domain/'+encodeURIComponent(dom),{timeout:ms,via:o.via,headers:{accept:'application/rdap+json, application/json'}});
    if(r.status===200){ res=bchRdap(JSON.parse(r.text)); src='rdap'; }
  }catch(e){}
  if(isNaN(res.exp)){                                            // RDAP нет (.ru и др.) — whois по tcp/43 через приложение
    try{
      const ns=await env.ns(), tld=dom.split('.').pop();
      const ref=/^\s*(?:whois|refer):\s*(\S+)/im.exec(await bchWhoisText(ns,'whois.iana.org',tld,ms));
      const w=bchWhois(await bchWhoisText(ns,ref ? ref[1] : 'whois.iana.org',dom,ms));
      if(!isNaN(w.exp)){ res=w; src='whois'; }
    }catch(e){}
  }
  if(isNaN(res.exp)) return {ok:false,detail:'no expiry date found (RDAP / whois); the app is needed for whois'};
  const days=bchDays(res.exp,now);
  return {ok:days>=(isNaN(warn) ? 30 : warn),expires:bchIso(res.exp),days,registrar:res.reg,detail:'expires '+bchIso(res.exp)+' ('+days+' days) · '+src};
}
// SMS: ответ на sms.send приходит, когда ушли все части; отчёт о доставке — позже записью {src:'sms',dir:'status',req}
async function bchSms(env,row,o){
  const to=o.target.replace(/[^0-9+]/g,''), text=bchStr(bchOpt(row,'text',o.text)); if(!to) throw new Error('no phone number'); if(!text) throw new Error('no text (a «text» column or the node parameter)');
  const ns=await env.ns(), wait=Math.max(0,+o.deliveryWait||60)*1000; let rep=null, tries=0;
  for(;;){
    try{ rep=await ns.call('sms.send',{to,text},60000); break; }
    catch(e){
      if(e.reply?.err==='rate' && ++tries<=8){ await (env.sleep||bchSleep)(15000); continue; }       // приложение шлёт не больше 5 SMS в минуту
      throw new Error(e.reply?.err==='permission' ? 'allow SMS for the DSP app on the phone' : e.reply?.err==='forbidden' ? 'only the page of the DSP app may send SMS' : e.message);
    }
  }
  const out={ok:true,sent:1,delivery:'',detail:'sent'};
  if(!rep.req || !wait){ out.delivery=rep.req ? 'sent' : 'sent (no report: update the app)'; out.detail=out.delivery; return out; }
  const st=await bchWait(ns,r=>r.src==='sms' && r.dir==='status' && String(r.req)===String(rep.req),wait);
  if(!st){ out.delivery='unknown'; out.detail='sent · no delivery report in '+(wait/1000)+' s (the carrier may not send one)'; }
  else { out.delivery=st.status==='delivered' ? 'delivered' : 'failed'; out.ok=st.status==='delivered'; out.detail=out.delivery+(st.err ? ' · '+st.err : ''); }
  return out;
}
let bchUssdBusy=Promise.resolve();                                // USSD-сессия одна: запросы идут по очереди
function bchUssd(env,row,o){
  const run=async()=>{
    const code=bchStr(bchOpt(row,'code',o.target||o.code)), sim=bchStr(bchOpt(row,'sim',o.sim)); if(!/^[*#+0-9]+#$/.test(code)) throw new Error('USSD code like *100#');
    const ns=await env.ns(), ms=Math.max(5,+o.ussdWait||40)*1000;
    const args={code}; if(sim!=='' && +sim>=0) args.sim=+sim;
    const w=bchWait(ns,r=>r.src==='ussd' && r.code===code,ms);
    try{ await ns.call('ussd.send',args,15000); }
    catch(e){ w.catch(()=>{}); throw new Error(e.reply?.err==='permission' ? 'allow calls (CALL_PHONE) for the DSP app' : e.reply?.err==='rate' ? 'too many USSD requests (5 a minute)' : e.message); }
    const r=await w; if(!r) return {ok:false,detail:'no answer from the network in '+ms/1000+' s'};
    if(!r.ok) return {ok:false,detail:'USSD failed: '+(r.failure||'?')};
    const text=bchStr(r.text).replace(/\s+/g,' '), bal=bchBalance(text,bchStr(bchOpt(row,'balanceRe',o.balanceRe)));
    return {ok:true,balance:isNaN(bal) ? '' : bal,reply:text.slice(0,300),detail:isNaN(bal) ? text.slice(0,120) : 'balance '+bal};
  };
  const p=bchUssdBusy.then(run,run); bchUssdBusy=p.catch(()=>{}); return p;
}

/* node: задачу (строку) получает обработчик — любые модули на холсте: выход task → … → вход result. Ответ ждём ms; нет ответа — не ок.
   Успех: условие cond(r,t) (выражение над ответом r и задачей t), без условия — сам факт ответа, если в нём нет ok=0/false. */
const BCH_NODE_SKIP=new Set(['kind','status','ok','checked','attempts','attempt','count','first','last','ms','detail','t']);
async function bchNode(env,row,o){
  if(!env.task) throw new Error('this node has no handler wires (task / result)');
  const ms=Math.max(1,+bchOpt(row,'timeoutS',o.nodeTimeout)||30)*1000, t0=env.now();
  const r=await env.task(row,o.attempt||1,ms);
  if(r==null) return {ok:false,detail:'no answer in '+ms/1000+' s'};
  const falsy=v=>v===0 || v===false || v==='0' || /^(false|no|fail|error)$/i.test(String(v));
  const good=env.cond && bchStr(o.cond) ? !!(await env.cond(r,row)) : !(r.ok!=null && falsy(r.ok));
  const out={ok:good,ms:env.now()-t0};
  for(const k in r) if(!BCH_NODE_SKIP.has(k) && k!==bchStr(o.keyCol||'id') && r[k]!=='' && r[k]!=null) out[k]=r[k];
  out.detail=bchStr(r.detail??r.text)||(good ? 'answered in '+out.ms+' ms' : 'the answer did not meet the condition'+(bchStr(o.cond) ? ' ('+bchStr(o.cond)+')' : ''));
  return out;
}
const BCH_RUN={node:bchNode,ping:bchPing,tcp:bchTcp,http:bchHttp,iptv:bchIptv,domain:bchDomain,sms:bchSms,ussd:bchUssd};

/* Одна попытка → запись {<ключ>, kind, ok:1|0, status, ms, detail, checked, …поля вида}. Ошибка проверки — status «error», ok 0;
   fatal — повторять бессмысленно (нет разрешения, команда не поддержана, нет цели). */
async function bchOnce(env,row,o,kind,attempt){
  const t0=env.now(), rec={kind};
  const key=bchStr(o.keyCol)||'id', tgt=bchPick(row,o.targetCol ? [o.targetCol,...BCH_TARGET] : BCH_TARGET);
  rec[key]=bchStr(row[key])||tgt||(kind==='ussd' ? bchStr(row.code)+(bchStr(row.sim)!=='' ? '@sim'+bchStr(row.sim) : '') : '');
  if(!tgt && kind!=='ussd' && kind!=='node'){ return {...rec,ok:0,status:'error',fatal:1,detail:'no target (a «'+(o.targetCol||'target')+'» column)',checked:env.now()}; }
  try{
    const r=await BCH_RUN[kind](env,row,{...o,target:tgt,attempt});
    const {ok,detail,...rest}=r;
    return {...rec,...rest,ok:ok ? 1 : 0,status:ok ? 'ok' : 'fail',detail:detail||'',ms:rest.ms??(env.now()-t0),checked:env.now()};
  }catch(e){
    const hint=/only the page of the DSP app|not allowed for this page/i.test(e.message||'');
    const why=hint ? 'the app refuses this page: open DSP from the app, or tick «Let any page use actions» in the app settings' : String(e.message||e);
    const fatal=hint || ['forbidden','unsupported','disabled','args','permission'].includes(e.reply?.err);
    return {...rec,ok:0,status:'error',fatal:fatal ? 1 : 0,detail:why.slice(0,200),ms:'',checked:env.now()};
  }
}
// retries — сколько раз повторить после неудачи (SMS не повторяем: второе сообщение дойдёт дважды); пауза retryDelay с между попытками
async function bchCheck(env,row,o){
  const kind=bchKindOf(row,o.kind);
  const tries=kind==='sms' ? 1 : 1+Math.max(0,Math.min(10,Math.floor(+bchOpt(row,'retries',o.retries)||0)));
  const gap=Math.max(0,Math.min(600,+bchOpt(row,'retryDelay',o.retryDelay)||0))*1000;
  let rec, n=0;
  for(;;){
    n++; rec=await bchOnce(env,row,o,kind,n);
    if(rec.ok || rec.fatal || n>=tries) break;
    if(gap) await (env.sleep||bchSleep)(gap);
  }
  delete rec.fatal;
  if(tries>1 || kind==='node') rec.attempts=n;
  return rec;
}

/* Очередь: conc строк одновременно (SMS и USSD всегда по одной — у приложения лимит 5 в минуту); onRec(rec,row) по мере готовности. */
async function bchRunAll(env,rows,o,hooks={}){
  const list=rows.map((row,i)=>({row,i})), done=new Array(rows.length);
  let next=0, finished=0, chain=Promise.resolve(), nodeBusy=0; const nodeQ=[];
  const nodeLim=Math.max(1,Math.min(32,+o.nodeConc||1));
  const nodeSem=job=>new Promise((res,rej)=>{ const go=()=>{ nodeBusy++; job().then(res,rej).finally(()=>{ nodeBusy--; const x=nodeQ.shift(); if(x) x(); }); }; if(nodeBusy<nodeLim) go(); else nodeQ.push(go); });      // задач в обработчике одновременно — nodeConc (физический прибор один — 1)
  const one=async()=>{
    while(!hooks.stop?.() && next<list.length){
      const {row,i}=list[next++], kind=bchKindOf(row,o.kind);
      const job=()=>bchCheck(env,row,o);
      const run=kind==='sms' ? (chain=chain.then(job,job)) : kind==='node' ? nodeSem(job) : job();
      const rec=hooks.stopP ? await Promise.race([run,hooks.stopP]) : await run;     // Stop не ждёт зависшие проверки
      if(rec==null) break;
      done[i]=rec; finished++;
      hooks.onRec?.(rec,row,i); hooks.onProgress?.(finished,list.length);
    }
  };
  const w=Math.max(1,Math.min(32,+o.conc||4));
  await Promise.all(Array.from({length:Math.min(w,list.length)},one));
  return done;
}
