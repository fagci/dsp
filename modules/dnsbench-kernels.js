"use strict";
/* Замер DNS-серверов по отклику: список серверов → по каждому запросы (кэшированные имена и случайные «свежие»), задержка по часам приложения
   (udp.request), потери, разброс, проверка подмены NXDOMAIN. Запрос и разбор — dnsq-kernels.js, сокеты — netsock-kernels.js.
   Без DOM — tools/test-dnsbench.mjs. */

const DNSB_NAMES=['google.com','cloudflare.com','wikipedia.org','amazon.com','github.com'];
const dnsbPct=(a,p)=>{ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y), i=(s.length-1)*p, lo=Math.floor(i), hi=Math.ceil(i); return s[lo]+(s[hi]-s[lo])*(i-lo); };
const dnsbAvg=a=>a.length ? a.reduce((x,y)=>x+y,0)/a.length : null;
const dnsbDev=a=>{ if(a.length<2) return null; const m=dnsbAvg(a); return Math.sqrt(a.reduce((x,y)=>x+(y-m)*(y-m),0)/(a.length-1)); };
const dnsbR=v=>v==null ? null : Math.round(v*100)/100;
const dnsbLabel=()=>'dsp-'+Math.random().toString(36).slice(2,10);

// строки Table или текста «имя=ip» / «ip» → [{name, ip, port}]
function dnsbServers(rows,text){
  const out=[], seen=new Set(), add=(ip,name,port)=>{ ip=String(ip||'').trim(); if(!/^[0-9a-f:.]+$/i.test(ip) || seen.has(ip+':'+(port||53))) return; seen.add(ip+':'+(port||53)); out.push({ip,name:String(name||ip).trim(),port:+port||53}); };
  for(const r of Array.isArray(rows) ? rows : []){
    if(!r || typeof r!=='object') continue;
    const k={}; for(const key in r) k[key.toLowerCase()]=r[key];
    add(k.server??k.ip??k.address??k.dns??k.host,k.name??k.label??k.title??k.provider,k.port);
  }
  for(const l of String(text||'').split(/[\n;,]+/)){ const m=/^\s*(?:([^=\s][^=]*?)\s*=\s*)?([0-9a-f:.]+?)(?::(\d+))?\s*$/i.exec(l); if(m && !/^\d+$/.test(m[2])) add(m[2],m[1],m[3]); }
  return out;
}

// один запрос: {ms, ok, rcode, answers} или {lost:true}
async function dnsbQuery(ns,s,name,timeout){
  const q=dnsQuery({name,type:'A'});
  try{
    const r=await ns.udpRequest(s.ip,s.port,q,timeout), d=dnsParse(r.bytes);
    return {ms:+r.ms,rcode:d.rcode,answers:d.an|0,bad:!!d.error || !d.qr};
  }catch(e){ return {lost:true}; }
}

/* o: names, rounds, mode ('cached' | 'fresh' | 'both'), domain (для «свежих»), timeout, gap (мс между запросами), onRec(rec), stop(), onProgress(done,total) */
async function dnsBench(ns,servers,o={}){
  const emit=o.onRec||(()=>{}), prog=o.onProgress||(()=>{}), stop=o.stop||(()=>false);
  const names=(o.names && o.names.length ? o.names : DNSB_NAMES), rounds=Math.max(1,Math.min(20,+o.rounds||3)), timeout=+o.timeout||1500, mode=o.mode||'both', domain=o.domain||'example.com', gap=+o.gap||0;
  const per=(mode!=='fresh' ? names.length*(rounds+1) : 0)+(mode!=='cached' ? rounds*2 : 0);
  let done=0; const total=servers.length*per, results=[];
  for(const s of servers){
    if(stop()) break;
    const cached=[], fresh=[]; let lost=0, bad=0, sent=0, hijack=0, nx=0;
    const note=r=>{ sent++; if(r.lost) lost++; else if(r.bad) bad++; };
    if(mode!=='fresh') for(const nm of names){
      if(stop()) break;
      await dnsbQuery(ns,s,nm,timeout); done++;                                      // прогрев кэша, в счёт не идёт
      for(let k=0;k<rounds && !stop();k++){
        const r=await dnsbQuery(ns,s,nm,timeout); done++; prog(done,total); note(r);
        if(!r.lost && !r.bad){ if(r.rcode===0 && r.answers>0) cached.push(r.ms); else bad++; }
        if(gap) await new Promise(x=>setTimeout(x,gap));
      }
    }
    if(mode!=='cached') for(let k=0;k<rounds*2 && !stop();k++){
      const r=await dnsbQuery(ns,s,dnsbLabel()+'.'+domain,timeout); done++; prog(done,total); note(r);
      if(!r.lost && !r.bad){ fresh.push(r.ms); if(r.rcode===3) nx++; else if(r.rcode===0 && r.answers>0) hijack++; }
      if(gap) await new Promise(x=>setTimeout(x,gap));
    }
    const all=cached.concat(fresh), score=mode==='fresh' ? dnsbAvg(fresh) : mode==='cached' ? dnsbAvg(cached) : (dnsbAvg(cached)??0)*.6+(dnsbAvg(fresh)??dnsbAvg(cached)??0)*.4;
    const rec={src:'dnsbench',id:s.ip+(s.port!==53 ? ':'+s.port : ''),name:s.name,server:s.ip,port:s.port,sent,ok:all.length,lost,bad,loss:sent ? dnsbR(lost/sent*100) : 0,
      cached_min:dnsbR(cached.length ? Math.min(...cached) : null),cached_avg:dnsbR(dnsbAvg(cached)),cached_med:dnsbR(dnsbPct(cached,.5)),cached_p95:dnsbR(dnsbPct(cached,.95)),
      fresh_avg:dnsbR(dnsbAvg(fresh)),fresh_med:dnsbR(dnsbPct(fresh,.5)),jitter:dnsbR(dnsbDev(all)),
      nxdomain:fresh.length ? (hijack ? 'replaced' : nx===fresh.length ? 'ok' : 'odd') : '',score:all.length ? dnsbR(score) : null,state:'done',t:Date.now()};
    results.push(rec); emit(rec);
  }
  const ranked=results.filter(r=>r.score!=null).sort((a,b)=>a.score-b.score);
  ranked.forEach((r,i)=>emit({src:'dnsbench',id:r.id,rank:i+1,state:'ranked',score:r.score,t:Date.now()}));
  return {tested:results.length,best:ranked[0]||null,ranked:ranked.length};
}
