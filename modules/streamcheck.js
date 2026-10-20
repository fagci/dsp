"use strict";
/* ============================ Stream Check: проверка потоков из списка ============================
   rows (url в каждой записи, например из IPTV) → HTTP(S)-запрос в несколько потоков → живые на rows, остальные на dead.
   Нужен CORS на сервере (или прокси из настроек); без него режим auto различает только «отвечает / не отвечает». */

const scNow=()=>Date.now();

function scStop(n){
  n.job=(n.job||0)+1;
  for(const ac of n.acs) try{ ac.abort(); }catch(e){}
  n.acs.clear();
}
// читает тело не дальше lim байт; плейлист (#…) читается целиком до 64 КБ
async function scGet(n,url,ac,mode,lim){
  const r=await fetch(n.p.proxy ? Net.url(url) : url,{cache:'no-store',signal:ac.signal,...(mode==='no-cors' ? {mode:'no-cors'} : {})});
  if(r.type==='opaque') { try{ ac.abort(); }catch(e){} return {opaque:true}; }
  const rd=r.body ? r.body.getReader() : null, parts=[]; let len=0, max=lim;
  if(rd) for(;;){
    const x=await rd.read();
    if(x.done) break;
    if(!len && x.value[0]===0x23) max=65536;
    parts.push(x.value); len+=x.value.length;
    if(len>=max) break;
  }
  try{ ac.abort(); }catch(e){}
  const b=new Uint8Array(len); let o=0; for(const p of parts){ b.set(p,o); o+=p.length; }
  return {status:r.status, ct:r.headers.get('content-type')||'', body:b, url:r.url||url};
}
async function scProbe(n,url){
  const t0=scNow(), ac=new AbortController();
  n.acs.add(ac);
  let late=false;
  const tm=setTimeout(()=>{ late=true; try{ ac.abort(); }catch(e){} },Math.max(1,+n.p.timeout)*1000);
  const lim=Math.max(377,+n.p.bytes|0), mode=n.p.mode;
  const fin=(ok,kind,why)=>({ok,kind,why,ms:scNow()-t0});
  try{
    let r;
    try{ r=await scGet(n,url,ac,mode==='reachable' ? 'no-cors' : 'cors',lim); }
    catch(e){
      if(mode!=='auto' || late || !(e instanceof TypeError)) throw e;
      const ac2=new AbortController(); n.acs.add(ac2); ac.signal.addEventListener('abort',()=>ac2.abort());
      try{ await scGet(n,url,ac2,'no-cors',lim); return fin(true,'reachable','content not checked (no CORS)'); }
      finally{ n.acs.delete(ac2); }
    }
    if(r.opaque) return fin(true,'reachable','content not checked (no CORS)');
    let c=scClassify(r.status,r.ct,r.body);
    if(c.ok && c.kind==='playlist' && n.p.deep){
      let text=new TextDecoder().decode(r.body), base=r.url, d;
      for(let depth=0;depth<2 && (d=scDeepUrl(text,base)) && d.url && d.playlist;depth++){
        const a=new AbortController(); n.acs.add(a); ac.signal.addEventListener('abort',()=>a.abort());
        try{ const q=await scGet(n,d.url,a,'cors',lim); if(q.status>=400) return fin(false,'','variant: HTTP '+q.status); text=new TextDecoder().decode(q.body); base=q.url; }
        finally{ n.acs.delete(a); }
      }
      d=scDeepUrl(text,base);
      if(d?.fail) return fin(false,'',d.fail);
      if(d?.url){
        const a=new AbortController(); n.acs.add(a); ac.signal.addEventListener('abort',()=>a.abort());
        try{
          const q=await scGet(n,d.url,a,'cors',lim);
          const s=scClassify(q.status,q.ct,q.body);
          if(!s.ok) return fin(false,'','segment: '+s.why);
          c={ok:true,kind:'HLS',why:''};
        }finally{ n.acs.delete(a); }
      }else c={ok:true,kind:'HLS',why:''};
    }
    return fin(c.ok,c.kind,c.why);
  }catch(e){
    return fin(false,'',late ? 'timeout' : e instanceof TypeError ? 'unreachable, or no CORS / mixed content' : e.message);
  }finally{ clearTimeout(tm); n.acs.delete(ac); }
}

async function scRun(n,rows){
  scStop(n);
  const job=n.job, urls=[...new Set(rows.map(r=>String(r?.url||'')).filter(u=>/^https?:\/\//i.test(u)))].filter(u=>!n.res.has(u));
  n.running=true; n.dirtyOut=true;
  await scPool(urls,()=>+n.p.threads,async u=>{
    const x=await scProbe(n,u);
    if(n.job!==job) return;
    n.res.set(u,x); n.dirtyOut=true;
  },()=>n.job!==job);
  if(n.job===job){ n.running=false; n.dirtyOut=true; n.lastEmit=0; }
}
function scBuild(n){
  const alive=[], dead=[]; let left=0;
  for(const r of n.rows||[]){
    const x=n.res.get(String(r?.url||''));
    if(!x){ if(/^https?:\/\//i.test(String(r?.url||''))) left++; else dead.push({...r,alive:0,check:'',why:'no http(s) url'}); continue; }
    (x.ok ? alive : dead).push({...r,alive:x.ok ? 1 : 0,check:x.kind,why:x.why,ms:x.ms});
  }
  n.outAlive=alive; n.outDead=dead; n.left=left;
}

def({ id:'streamCheck', title:'Stream Check', cat:'Data', readout:true, w:300,
  kw:'iptv stream check filter alive dead working http https probe test playlist m3u hls ts channels threads parallel validate',
  // rows — список с полем url (например IPTV); rows — живые (поля alive, check, ms), dead — остальные (why)
  ins:[{n:'rows',t:'bands'}],
  outs:[{n:'rows',t:'bands'},{n:'dead',t:'bands'},{n:'ok',t:'num'},{n:'bad',t:'num'},{n:'left',t:'num'}],
  params:[{n:'threads',t:'range',min:1,max:64,step:1,d:16,label:'parallel checks'},
          {n:'timeout',t:'range',min:1,max:30,step:1,d:6,label:'timeout per stream, s'},
          {n:'mode',t:'select',opts:['auto','content','reachable'],d:'auto',label:'check',
           tip:'content — reads the first bytes (needs CORS on the server): HTTP status, MPEG-TS sync byte, playlist. reachable — only whether the server answers (works without CORS). auto — content, and where the browser forbids reading, reachable'},
          {n:'deep',t:'check',d:false,label:'HLS: also fetch a segment of the playlist'},
          {n:'proxy',t:'check',d:false,label:'through the CORS proxy from Settings'},
          {n:'bytes',t:'num',d:1024,min:377,step:1,label:'bytes read from a stream',adv:true},
          {n:'again',t:'button',label:'Check again',fn:n=>{ n.res.clear(); n.key=''; n.ref=null; }},
          {n:'stop',t:'button',label:'Stop',fn:n=>{ scStop(n); n.running=false; n.dirtyOut=true; }}],
  init:n=>{ n.res=new Map(); n.acs=new Set(); n.job=0; n.key=''; n.ref=null; n.rows=null; n.running=false; n.dirtyOut=false; n.lastEmit=0;
            n.outAlive=null; n.outDead=null; n.left=0; },
  dispose:n=>{ scStop(n); },
  process(n,I){
    const rows=Array.isArray(I.rows) ? I.rows : null;
    if(rows!==n.ref){
      n.ref=rows;
      const key=rows ? rows.map(r=>r?.url||'').join('\n') : '';
      if(key!==n.key){
        n.key=key; n.rows=rows;
        if(rows && rows.length) scRun(n,rows); else { scStop(n); n.running=false; n.outAlive=null; n.outDead=null; n.left=0; n.dirtyOut=true; }
      }else n.rows=rows;
    }
    if(n.dirtyOut && (!n.running || scNow()-n.lastEmit>700)){      // Table пересобирает список целиком — часто не отдаём
      n.dirtyOut=false; n.lastEmit=scNow(); scBuild(n);
    }
    return {rows:n.outAlive, dead:n.outDead, ok:n.outAlive?.length||0, bad:n.outDead?.length||0, left:n.left};
  },
  draw(n){
    const r=n.el.querySelector('.readout'); if(!r) return;
    const tot=n.rows?.length||0, ok=n.outAlive?.length||0, bad=n.outDead?.length||0;
    const t=!tot ? 'wire rows with a url column (IPTV rows)' :
      (n.running ? 'checking… ' : 'done · ')+(n.res.size)+' checked · alive '+ok+' · dead '+bad+(n.left ? ' · left '+n.left : '')+(n.running ? ' · '+n.p.threads+' threads' : '');
    if(r.textContent!==t) r.textContent=t; }
});
