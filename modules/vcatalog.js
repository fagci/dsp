"use strict";
/* ============================ VIDEO SOURCES (каталог) ============================
   Собирает списки источников для Video Player: Internet Archive (поиск по фильмам, мультфильмам, старому ТВ — открытые архивные
   видео; предмет с несколькими файлами раскладывается на серии), Wikimedia Commons, PeerTube (SepiaSearch), каналы iptv-org (M3U по стране, HLS), любой M3U по адресу и
   встроенные примеры. Выходы rows (что смотреть: результаты поиска, каналы) и list (что играть — на rows плеера, в Table).
   Последний удачный ответ запоминается (localStorage dsp-vcat) и при сбое сети показывается с пометкой «устарело».
   Ядро — modules/vplayer-kernels.js. */

const VCAT_KEY='dsp-vcat', VCAT_MAX=500;
function vcatCache(key,rows){
  let m={}; try{ m=JSON.parse(LS.get(VCAT_KEY)||'{}')||{}; }catch(e){}
  if(rows){
    m[key]={t:Date.now(),rows:rows.slice(0,VCAT_MAX)};
    const ks=Object.keys(m).sort((a,b)=>m[b].t-m[a].t); for(const k of ks.slice(12)) delete m[k];
    try{ LS.set(VCAT_KEY,JSON.stringify(m)); }catch(e){}
    return rows;
  }
  return m[key] || null;
}
function vcatStatus(n,s){ n.status=s; }
async function vcatGet(n,url,as){
  const r=await fetch(n.p.proxy && typeof Net!=='undefined' ? Net.url(url) : url,{signal:n.abort.signal});
  if(!r.ok) throw new Error('HTTP '+r.status);
  return as==='json' ? r.json() : r.text();
}
// запрос с запасным ответом из кэша
async function vcatLoad(n,key,fetcher){
  try{ const rows=vcatCache(key,await fetcher()); n.stale=false; return rows; }
  catch(e){
    if(e.name==='AbortError') throw e;
    const c=vcatCache(key);
    if(c){ n.stale=true; vcatStatus(n,'network error ('+e.message+(e instanceof TypeError ? ': no CORS or no network' : '')+') — the last answer, '+new Date(c.t).toLocaleString()+' (stale)'); return c.rows; }
    throw e;
  }
}
async function vcatGo(n){
  try{ n.abort?.abort(); }catch(e){}
  const ac=n.abort=new AbortController(), g=n.gen=(n.gen||0)+1, p=n.p;
  vcatStatus(n,'loading…'); n.busy=1; n.stale=false;
  try{
    let rows, list=null;
    if(p.provider==='Samples'){ rows=VP_SAMPLES.map((c,i)=>({n:i+1,...c})); }
    else if(p.provider==='Wikimedia Commons'){
      const q=vpWmSearchUrl(p.query,+p.max);
      rows=await vcatLoad(n,'wm|'+q,async()=>vpWmItems(await vcatGet(n,q,'json')).map((c,i)=>({n:i+1,...c})));
    }
    else if(p.provider==='PeerTube (SepiaSearch)'){
      const q=vpPtSearchUrl(p.query,+p.max);
      rows=await vcatLoad(n,'pt|'+q,async()=>vpPtItems(await vcatGet(n,q,'json')));
      if(g!==n.gen) return;
      if(!rows.length) vcatStatus(n,'nothing found');
      else if(!n.stale) vcatStatus(n,rows.length+' videos — wire a Table «id» column to «item» (or type host/uuid) to get the playable address');
      list=n.list&&n.itemId ? n.list : [];
    }
    else if(p.provider==='Internet Archive'){
      const q=vpIaSearchUrl(p.query,p.kind,+p.max);
      rows=await vcatLoad(n,'ia|'+q,async()=>vpIaItems(await vcatGet(n,q,'json')));
      if(g!==n.gen) return;
      if(!rows.length) vcatStatus(n,'nothing found');
      else if(!n.stale) vcatStatus(n,rows.length+' items — wire a Table «id» column to «item» (or type an id / archive.org link) to get its files and episodes');
      list=n.list&&n.itemId ? n.list : [];
    }else{
      const url= p.provider==='IPTV channels (iptv-org)' ? vpIptvUrl(p.country) : String(p.url||'').trim();
      if(!/^https?:\/\//i.test(url)) throw new Error('enter the address of an M3U list');
      rows=await vcatLoad(n,'m3u|'+url,async()=>{
        const pl=iptvParse(await vcatGet(n,url,'text'),url);
        if(pl.kind!=='channels') throw new Error('not an M3U channel list');
        return pl.items.map((c,i)=>({n:i+1,name:c.name,url:c.url,group:c.group||'',id:c.id||'',logo:c.logo||''})); });
    }
    if(g!==n.gen) return;
    if(p.provider!=='Internet Archive' && p.provider!=='PeerTube (SepiaSearch)'){ rows=vpFilter(rows,p.filter); list=rows; if(!n.stale) vcatStatus(n,rows.length+' sources'); }
    n.rowsOut=rows; n.listOut=list||[]; n.dirty=true;
  }catch(e){ if(e.name!=='AbortError' && g===n.gen) vcatStatus(n,'error: '+e.message); }
  finally{ if(g===n.gen) n.busy=0; }
}
// файлы предмета Internet Archive (id или ссылка) либо видео PeerTube (host/uuid) → list
async function vcatItem(n,v){
  const pt=vpPtId(v), id=pt ? pt.host+'/'+pt.uuid : vpIaId(v);
  if(!id){ vcatStatus(n,'not an Internet Archive id / link or a PeerTube host/uuid'); return; }
  try{ n.abort?.abort(); }catch(e){}
  const ac=n.abort=new AbortController(), g=n.gen=(n.gen||0)+1;
  n.itemId=id; vcatStatus(n,'loading '+id+'…'); n.busy=1; n.stale=false;
  try{
    const list=await vcatLoad(n,'item|'+id,async()=> pt
      ? vpPtFiles(await vcatGet(n,'https://'+pt.host+'/api/v1/videos/'+encodeURIComponent(pt.uuid),'json'),pt.host,pt.uuid)
      : vpIaFiles(await vcatGet(n,'https://archive.org/metadata/'+encodeURIComponent(id),'json'),id));
    if(g!==n.gen) return;
    n.list=list; n.listOut=vpFilter(list,n.p.filter); n.dirty=true;
    if(!n.stale) vcatStatus(n,list.length ? id+': '+list.length+' video'+(list.length>1 ? ' files (episodes)' : '') : id+': no playable video files (the item may be restricted)');
  }catch(e){ if(e.name!=='AbortError' && g===n.gen) vcatStatus(n,'error: '+e.message); }
  finally{ if(g===n.gen) n.busy=0; }
}

def({ id:'vcatalog', title:'Video Sources', cat:'Sources', readout:true, always:true, resize:true, w:340,
  kw:'video sources catalog search internet archive movies films cartoons series episodes tv iptv m3u channels playlist samples find watch',
  ins:[{n:'query',t:'txt'},{n:'item',t:'txt'},{n:'go',t:'num'}],
  outs:[{n:'rows',t:'bands'},{n:'list',t:'bands'},{n:'count',t:'num'},{n:'busy',t:'num'}],
  params:[
    {n:'provider',t:'select',opts:['Internet Archive','Wikimedia Commons','PeerTube (SepiaSearch)','IPTV channels (iptv-org)','M3U list (URL)','Samples'],d:'Samples',label:'where to take sources from'},
    {n:'query',t:'text',d:'',label:'search words (Internet Archive, Wikimedia Commons, PeerTube); Internet Archive with empty — the most watched'},
    {n:'kind',t:'select',opts:Object.keys(VP_IA_KINDS),d:'any video',label:'Internet Archive: collection'},
    {n:'max',t:'range',min:10,max:200,step:10,d:50,label:'how many results'},
    {n:'item',t:'text',d:'',label:'one item: Internet Archive id or archive.org link, or PeerTube host/uuid — its files (episodes) go to «list»'},
    {n:'country',t:'text',d:'ru',label:'iptv-org: country (ru, us, de …), language (rus, eng …) or category (movies, kids, animation, series, news …)'},
    {n:'url',t:'text',d:'',label:'M3U list: address'},
    {n:'filter',t:'text',d:'',label:'filter: words in the name or group, «-word» drops a source'},
    {n:'proxy',t:'check',d:false,label:'through the CORS proxy from Settings'},
    {n:'goB',t:'button',label:'Load',fn:n=>vcatGo(n)},
    {n:'itemB',t:'button',label:'Load the item',fn:n=>vcatItem(n,n.p.item)}],
  init(n){ n.rowsOut=[]; n.listOut=[]; n.list=[]; n.itemId=''; n.status='press Load'; n.busy=0; n.stale=false; n.gen=0; n.abort=null; n.inQ=''; n.inItem=''; n.goPrev=false; n.first=true; n.dirty=true; },
  dispose(n){ try{ n.abort?.abort(); }catch(e){} },
  process(n,I){
    if(n.first){ n.first=false; if(n.p.provider==='Samples') vcatGo(n); }
    if(typeof I.query==='string' && I.query!==n.inQ){ n.inQ=I.query; setMod(n,'query',I.query); if(n.p.provider==='Internet Archive') vcatGo(n); }
    if(typeof I.item==='string' && I.item && I.item!==n.inItem){ n.inItem=I.item; setMod(n,'item',I.item); vcatItem(n,I.item); }
    const go=(I.go||0)>.5; if(go && !n.goPrev) vcatGo(n); n.goPrev=go;
    return {rows:n.rowsOut, list:n.listOut, count:n.listOut.length, busy:n.busy}; },
  draw(n){
    const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+(n.stale ? ' ⚠' : ''); if(r.textContent!==t) r.textContent=t; }
});
