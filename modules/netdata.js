"use strict";
/* ============================ Open-Meteo · самолёты онлайн · OSM-объекты · Ollama ============================
   Meteo — погода и высота точки (Open-Meteo); Aircraft Nearby — самолёты вокруг точки (adsb.lol / OpenSky);
   OSM Objects — вышки, мачты, вершины и любые теги OpenStreetMap (Overpass); Ollama — локальная LLM по HTTP.
   Ключи не нужны. Нужен CORS на сервере (или прокси из настроек). Последний удачный ответ хранится в localStorage
   и показывается с пометкой «stale», если сети нет. Разбор ответов — netdata-kernels.js. */

const ND_OVERPASS=['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter','https://overpass.private.coffee/api/interpreter'];
// fetch с учётом Settings → CORS proxy (и режима прокси): прокси задан и узел его просит — через него (режим «always»); режим «on error» —
// сначала напрямую, при отказе браузера (CORS, mixed content: TypeError) один раз через прокси, и хост запоминается; нет прокси / «off» — напрямую.
// Повтор безопасен и для POST: TypeError значит, что ответа не было вовсе, а наши запросы (чат, поиск) ничего не меняют на сервере.
// Приложение Android: WebView не отдаёт тело POST на перехват (CorsProxy.kt отвечает за GET / HEAD / OPTIONS), поэтому POST идёт по сокету
// моста — HTTP по tcp.connect (http-kernels.js: httpStream): ответ потоком, CORS и mixed content не мешают, OLLAMA_ORIGINS не нужен.
const ND_APP={link:()=>AppLink.link()};                       // одно соединение с мостом на всю страницу (applink.js)
const ndIsPost=init=>{ const m=String(init?.method||'GET').toUpperCase(); return m!=='GET' && m!=='HEAD'; };
async function ndFetch(n,url,init){
  const px=Net.proxy;
  if(!px){
    if(Net.app && ndIsPost(init)){
      let ns=null; try{ ns=await ND_APP.link(); }catch(e){}                       // моста нет — пробуем сами, как раньше
      if(ns) return httpStream(ns,url,{method:init.method,headers:init.headers,body:init.body,signal:init.signal,timeout:600000});
    }
    return fetch(url,init);
  }
  const via=()=>fetch(Net.url(url,true),init);
  if(Net.needs(url)){ try{ return await via(); }catch(e){ if(e.name==='AbortError') throw e; } return fetch(url,init); }
  if(n.p.proxy && Net.mode==='always') return via();
  try{ return await fetch(url,init); }
  catch(e){
    if(!(e instanceof TypeError) || init?.signal?.aborted) throw e;
    let r; try{ r=await via(); }catch(x){ throw e; }                       // не вышло и через прокси — вернётся исходная ошибка
    if(r.ok){ try{ Net.need.add(new URL(url).host); }catch(x){} }
    return r;
  }
}
// почему сервер отказал: JSON {error} (Ollama), иначе первая строка текста (прокси моста отвечает text/plain)
async function ndWhy(r){ try{ const t=(await r.text()).trim(); try{ const j=JSON.parse(t); return j.error||j.message||t.slice(0,120); }catch(e){ return t.split('\n')[0].slice(0,120); } }catch(e){ return ''; } }
const ndAbort=n=>{ for(const k in n.acs||{}) try{ n.acs[k].abort(); }catch(e){} };
const ndPulse=(n,key,v)=>{ const on=(v||0)>.5, was=n[key]; n[key]=on; return on && !was; };
const ndErr=e=>e.name==='AbortError' ? '' : e.message+(e instanceof TypeError ? ' (no CORS headers on the server, blocked, or no network — try «through the CORS proxy»)' : '');

// последний удачный ответ: localStorage может быть недоступен — тогда просто без кэша
const ND_LS='dsp.nd.';
function ndSave(key,v){ try{ localStorage.setItem(ND_LS+key,JSON.stringify({t:Date.now(),v})); }catch(e){} }
function ndLoad(key){ try{ const s=localStorage.getItem(ND_LS+key); return s ? JSON.parse(s) : null; }catch(e){ return null; } }

// запрос с одним активным на ключ; при ошибке сети — кэш (stale), если он есть
async function ndGet(n,key,url,kind,opt){
  const {timeout=20,cache,...fo}=opt||{};
  (n.acs ||= {})[key]?.abort();
  const ac=n.acs[key]=new AbortController();
  const tm=setTimeout(()=>{ ac.timedOut=true; ac.abort(); },timeout*1000);
  try{
    const r=await ndFetch(n,url,{signal:ac.signal,...fo});
    if(!r.ok){ const w=r.status===429 ? '' : await ndWhy(r); throw new Error(r.status===429 ? 'HTTP 429 (rate limit — try later)' : 'HTTP '+r.status+(w ? ': '+w : '')); }
    const j=await (kind==='json' ? r.json() : r.text());
    if(cache) ndSave(cache,j);
    return {j,stale:0,at:Date.now()};
  }catch(e){
    if(ac.timedOut) e=new Error('timeout ('+timeout+' s) — server not responding');
    else if(e.name==='AbortError') throw e;
    const c=cache && ndLoad(cache);
    if(c) return {j:c.v,stale:1,at:c.t,err:e.message};
    throw e;
  }finally{ clearTimeout(tm); }
}
const ndStatus=(n,r)=>r.stale ? 'stale · '+ndAgo(Date.now()-r.at)+' old'+(r.err ? ' ('+r.err+')' : '') : '';
// центр: провода → параметры → My Position
function ndCentre(n,I){
  const wl=recNum(I.lat), wo=recNum(I.lon);
  if(wl!=null && wo!=null) return [wl,wo];
  if(+n.p.lat || +n.p.lon) return [+n.p.lat,+n.p.lon];
  if(GeoMe.lat!=null && GeoMe.lon!=null) return [GeoMe.lat,GeoMe.lon];
  return [null,null];
}
const ndShow=(n,t)=>{ const r=n.el && n.el.querySelector('.readout'); if(r && r.textContent!==t) r.textContent=t; };

/* ---------- Meteo ---------- */
async function mtLoad(n){
  if(n.busy || n.lat==null) return;
  n.busy=true; n.lastAt=performance.now(); n.lastLat=n.lat; n.lastLon=n.lon;
  try{
    const u=ndMeteoUrl(n.lat,n.lon);
    const r=await ndGet(n,'m',u,'json',{cache:'m'+ndHash(u)});
    const m=ndMeteo(r.j); if(!m) throw new Error('unexpected answer');
    if(n.p.elev){
      try{ const eu=ndElevUrl(n.lat,n.lon), er=await ndGet(n,'e',eu,'json',{cache:'e'+ndHash(eu)}); m.elev=ndElev(er.j) ?? m.elev; }catch(e){ if(e.name==='AbortError') throw e; }
    }
    n.m=m; n.msg=ndStatus(n,r); n.at=r.at; n.stale=r.stale;
  }catch(e){ const t=ndErr(e); if(t) n.msg='failed: '+t; }
  finally{ n.busy=false; n.rev=(n.rev||0)+1; }
}
def({ id:'meteo', title:'Weather & Elevation (Open-Meteo)', cat:'Sources', readout:true, tall:true, w:300,
  kw:'weather meteo temperature humidity pressure wind cloud rain forecast open-meteo elevation altitude height refraction dew point',
  // погода сейчас и высота над уровнем моря в точке; центр — провода lat / lon, параметры или My Position
  ins:[{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'update',t:'num'}],
  outs:[{n:'temp',t:'num'},{n:'hum',t:'num'},{n:'press',t:'num'},{n:'wind',t:'num'},{n:'dir',t:'num'},{n:'gust',t:'num'},
        {n:'cloud',t:'num'},{n:'precip',t:'num'},{n:'dew',t:'num'},{n:'elev',t:'num'},{n:'text',t:'txt'},{n:'rec',t:'rec'},{n:'stale',t:'num'}],
  params:[{n:'lat',t:'num',d:0,label:'latitude (0 and 0 — My Position or wires)'},
          {n:'lon',t:'num',d:0,label:'longitude'},
          {n:'refresh',t:'range',min:1,max:120,step:1,d:10,label:'refresh, min (the server updates every 15 min)'},
          {n:'auto',t:'check',d:true,label:'update by itself'},
          {n:'elev',t:'check',d:true,label:'also ask the elevation of the point'},
          {n:'go',t:'button',label:'⟳ Update now',fn:n=>{ n.want=true; }},
          {n:'proxy',t:'check',d:false,label:'always through the CORS proxy from Settings (without it — directly, the proxy only after a refusal in «on error» mode)'}],
  init:n=>{ n.m=null; n.msg=''; n.busy=false; n.lastAt=-1e9; n.want=false; n.lat=null; n.lon=null; n.lastLat=null; n.lastLon=null; n.up=false; n.at=0; n.stale=0; n.rev=0; },
  dispose:n=>ndAbort(n),
  drawKey:n=>n.msg+'|'+n.rev+'|'+n.busy,
  process(n,I){
    [n.lat,n.lon]=ndCentre(n,I);
    const moved=n.lat!=null && n.lastLat!=null && ndDist(n.lat,n.lon,n.lastLat,n.lastLon)>5;
    const due=n.p.auto && (moved || n.lastLat==null || performance.now()-n.lastAt>n.p.refresh*60000);
    if(ndPulse(n,'up',I.update)) n.want=true;
    if(n.lat!=null && !n.busy && (due || n.want)){ n.want=false; mtLoad(n); }
    const m=n.m||{};
    return {temp:m.temp??null,hum:m.hum??null,press:m.press??null,wind:m.wind??null,dir:m.dir??null,gust:m.gust??null,cloud:m.cloud??null,
      precip:m.precip??null,dew:n.m ? ndRound(ndDew(m.temp,m.hum),1) : null,elev:m.elev??null,
      text:n.m ? ndMeteoLines(n.m).join('\n') : null,rec:n.m ? {...m,dew:ndRound(ndDew(m.temp,m.hum),1),lat:n.lat,lon:n.lon,t:n.at} : null,stale:n.stale|0};
  },
  draw(n){
    const L=[];
    if(n.lat==null) L.push('no centre — add My Position, wire lat / lon or set them');
    else L.push('📍 '+ndRound(n.lat,3)+', '+ndRound(n.lon,3)+(n.busy ? ' · loading…' : ''));
    if(n.m){ L.push(...ndMeteoLines(n.m)); if(n.m.elev!=null) L.push('⛰ '+Math.round(n.m.elev)+' m above sea level'); const d=ndDew(n.m.temp,n.m.hum); if(d!=null) L.push('dew point '+ndRound(d,1)+' °C · '+n.m.time+' UTC'); }
    if(n.msg) L.push(n.msg);
    ndShow(n,L.join('\n'));
  }
});

/* ---------- Aircraft Nearby ---------- */
async function acLoad(n){
  if(n.busy || n.lat==null) return;
  n.busy=true; n.lastAt=performance.now();
  try{
    const u=ndAcUrl(n.p.source,n.lat,n.lon,+n.p.radius);
    const r=await ndGet(n,'a',u,'json',{cache:'a'+ndHash(u),timeout:25});
    let rows=ndAircraft(n.p.source,r.j,n.lat,n.lon); if(!rows) throw new Error('unexpected answer');
    if(!n.p.ground) rows=rows.filter(x=>!x.ground);
    rows=rows.filter(x=>x.dist==null || x.dist<=+n.p.radius).slice(0,+n.p.limit);
    n.rowsOut=rows; n.msg=ndStatus(n,r); n.at=r.at; n.stale=r.stale;
  }catch(e){ const t=ndErr(e); if(t) n.msg='failed: '+t; }
  finally{ n.busy=false; n.rev=(n.rev||0)+1; }
}
def({ id:'airnet', title:'Aircraft Nearby (adsb.lol · OpenSky)', cat:'Sources', readout:true, tall:true, w:320,
  kw:'aircraft airplane flight adsb ads-b adsb.lol opensky radar flightradar map callsign squawk online internet plane',
  // самолёты из открытых агрегаторов вокруг точки: на карту, ближайший — в текст; свои приёмом сравнивайте по hex
  ins:[{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'select',t:'rec'},{n:'update',t:'num'}],
  outs:[{n:'rows',t:'bands'},{n:'count',t:'num'},{n:'nearest',t:'txt'},{n:'dist',t:'num'},{n:'alt',t:'num'},{n:'sel',t:'rec'},{n:'stale',t:'num'}],
  params:[{n:'source',t:'select',opts:['adsb.lol','opensky'],d:'adsb.lol',label:'source (OpenSky: anonymous, ~400 requests a day)'},
          {n:'lat',t:'num',d:0,label:'centre latitude (0 and 0 — My Position or wires)'},
          {n:'lon',t:'num',d:0,label:'centre longitude'},
          {n:'radius',t:'range',min:5,max:400,step:5,d:100,label:'radius, km'},
          {n:'refresh',t:'range',min:5,max:300,step:5,d:15,label:'refresh, s (0 — by hand)'},
          {n:'ground',t:'check',d:false,label:'show aircraft on the ground'},
          {n:'go',t:'button',label:'⟳ Update now',fn:n=>{ n.want=true; }},
          {n:'proxy',t:'check',d:false,label:'always through the CORS proxy from Settings (without it — directly, the proxy only after a refusal in «on error» mode)'},
          {n:'limit',t:'range',min:20,max:1000,step:20,d:300,label:'max aircraft',adv:true}],
  init:n=>{ n.rowsOut=null; n.sel=null; n.msg=''; n.busy=false; n.lastAt=-1e9; n.want=false; n.lat=null; n.lon=null; n.up=false; n.at=0; n.stale=0; n.rev=0; n.lastSrc=n.p.source; },
  dispose:n=>ndAbort(n),
  drawKey:n=>n.msg+'|'+n.rev+'|'+n.busy+'|'+(n.sel?.id||''),
  process(n,I){
    [n.lat,n.lon]=ndCentre(n,I);
    for(const r of recList(I.select)){
      const id=String(r.id||'').replace(/^n:/,''); if(!id.startsWith('ac:')) continue;
      n.sel=(n.rowsOut||[]).find(x=>x.id===id)||n.sel;
    }
    if(n.p.source!==n.lastSrc){ n.lastSrc=n.p.source; n.rowsOut=null; n.lastAt=-1e9; }
    if(ndPulse(n,'up',I.update)) n.want=true;
    if(n.lat!=null && !n.busy && (n.want || +n.p.refresh>0 && performance.now()-n.lastAt>n.p.refresh*1000)){ n.want=false; acLoad(n); }
    const rows=n.rowsOut, a=rows&&rows[0];
    return {rows,count:rows ? rows.length : 0,nearest:a ? a.label+' · '+a.dist+' km '+ndCompass(a.brg)+' · '+a.info : null,
      dist:a?.dist??null,alt:a?.alt??null,sel:n.sel,stale:n.stale|0};
  },
  draw(n){
    const L=[];
    if(n.lat==null) L.push('no centre — add My Position, wire lat / lon or set them');
    else L.push('✈ '+(n.rowsOut ? n.rowsOut.length : 0)+' within '+n.p.radius+' km · '+n.p.source+(n.busy ? ' · loading…' : ''));
    if(n.msg) L.push(n.msg);
    for(const x of (n.rowsOut||[]).slice(0,6)) L.push(x.label.padEnd(8)+' '+String(x.dist).padStart(5)+' km '+ndCompass(x.brg).padEnd(3)+' '+x.info);
    if(n.sel) L.push('▶ '+n.sel.label+' '+n.sel.hex+(n.sel.reg ? ' '+n.sel.reg : '')+' · '+n.sel.info);
    ndShow(n,L.join('\n'));
  }
});

/* ---------- OSM Objects ---------- */
async function osSearch(n){
  if(n.lat==null){ n.msg='no centre — add My Position, wire lat / lon or set them'; return; }
  const pair=ndOsmPair(n.p.kind,n.p.key,n.p.value);
  if(!pair){ n.msg='the tag is not valid: key — letters, digits, «_ : . -»; value — no quotes or backslashes'; return; }
  n.msg='searching OpenStreetMap…'; n.busy=true;
  const data=encodeURIComponent(ndOsmQuery(n.lat,n.lon,+n.p.radius,pair,+n.p.limit));
  let err=''; const ck='o'+ndHash(data);
  const done=(r,j)=>{
    const rows=ndOsmRows(j,pair,n.lat,n.lon); if(!rows) throw new Error('unexpected answer');
    n.rowsOut=rows.filter(x=>x.dist==null || x.dist<=+n.p.radius); n.sel=null;
    n.msg=ndStatus(n,r) || (n.rowsOut.length ? '' : 'nothing with '+pair.key+(pair.value ? '='+pair.value : '')+' within '+n.p.radius+' km — raise the radius');
  };
  try{
    for(const base of ND_OVERPASS){                                                  // кэш — только когда не ответило ни одно зеркало
      n.msg='searching OpenStreetMap… ('+base.split('/')[2]+')';
      try{
        const r=await ndGet(n,'s',base+'?data='+data,'json',{timeout:35});            // GET ?data= — его пропускает и прокси моста
        if(r.j.remark && !(r.j.elements||[]).length) throw new Error('server busy: '+r.j.remark);
        ndSave(ck,r.j); done(r,r.j); return;
      }catch(e){ err=ndErr(e); if(!err) return; }
    }
    const c=ndLoad(ck);
    if(c){ try{ done({stale:1,at:c.t,err:err},c.v); return; }catch(e){} }
    n.msg='search failed: '+err;
  }finally{ n.busy=false; n.rev=(n.rev||0)+1; }
}
def({ id:'osmobj', title:'OSM Objects (Overpass)', cat:'Sources', readout:true, tall:true, w:320,
  kw:'openstreetmap osm overpass mast tower peak antenna repeater summit objects map query tag terrain site radio',
  // объекты OpenStreetMap с тегом вокруг точки: мачты, вышки, вершины или своя пара key=value
  ins:[{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'select',t:'rec'},{n:'search',t:'num'}],
  outs:[{n:'rows',t:'bands'},{n:'count',t:'num'},{n:'nearest',t:'txt'},{n:'dist',t:'num'},{n:'sel',t:'rec'}],
  params:[{n:'kind',t:'select',opts:Object.keys(ND_OSM_PRESETS),d:'radio masts',label:'what to look for'},
          {n:'key',t:'text',d:'',label:'custom: tag key (e.g. power)'},
          {n:'value',t:'text',d:'',label:'custom: tag value (e.g. tower; empty — any)'},
          {n:'lat',t:'num',d:0,label:'centre latitude (0 and 0 — My Position or wires)'},
          {n:'lon',t:'num',d:0,label:'centre longitude'},
          {n:'radius',t:'range',min:1,max:100,step:1,d:15,label:'radius, km'},
          {n:'go',t:'button',label:'🔍 Search',fn:n=>osSearch(n)},
          {n:'proxy',t:'check',d:false,label:'always through the CORS proxy from Settings (without it — directly, the proxy only after a refusal in «on error» mode)'},
          {n:'limit',t:'range',min:20,max:1000,step:20,d:300,label:'max objects',adv:true}],
  init:n=>{ n.rowsOut=null; n.sel=null; n.msg=''; n.busy=false; n.lat=null; n.lon=null; n.go=false; n.rev=0; },
  dispose:n=>ndAbort(n),
  drawKey:n=>n.msg+'|'+n.rev+'|'+n.busy+'|'+(n.sel?.id||''),
  process(n,I){
    [n.lat,n.lon]=ndCentre(n,I);
    for(const r of recList(I.select)){
      const id=String(r.id||'').replace(/^n:/,''); if(!id.startsWith('osm:')) continue;
      n.sel=(n.rowsOut||[]).find(x=>x.id===id)||n.sel;
    }
    if(ndPulse(n,'go',I.search) && !n.busy) osSearch(n);
    const rows=n.rowsOut, a=rows&&rows[0];
    return {rows,count:rows ? rows.length : 0,nearest:a ? a.label+' · '+a.dist+' km' : null,dist:a?.dist??null,sel:n.sel};
  },
  draw(n){
    const L=[];
    if(n.msg) L.push(n.msg);
    if(n.rowsOut) L.push(n.rowsOut.length+' objects');
    else if(!n.msg) L.push('press «Search» (centre: My Position, wires or lat / lon)');
    for(const x of (n.rowsOut||[]).slice(0,6)) L.push(String(x.dist).padStart(6)+' km  '+x.label+(x.height ? ' · '+x.height+' m' : '')+(x.ele ? ' · '+x.ele+' m a.s.l.' : '')+(x.freq ? ' · '+x.freq : ''));
    if(n.sel) L.push('▶ '+n.sel.label+'\n  '+n.sel.url);
    ndShow(n,L.join('\n'));
  }
});

/* ---------- Ollama ---------- */
// хост «app» — не сервер: llama.cpp внутри приложения Android (llm-app.js)
const olmApp=n=>/^(app|phone|dsp)(:\/\/)?$/i.test(String(n.p.host||'').trim());
async function olmModelsApp(n){
  n.msg='asking the phone…';
  try{
    if(typeof AppLink==='undefined' || !AppLink.ok) throw new Error('host «app» works only in the DSP app for Android');
    const loc=await llmAppModels();
    n.models=loc.map(m=>({name:m.name,size:m.size,params:Math.round(m.size/1048576)+' MB',quant:''}));
    const have=new Set(loc.map(m=>m.name));
    n.cat=Object.keys(LLM_CATALOG).filter(k=>!have.has(k+'.gguf')).map(k=>k+' (≈'+LLM_CATALOG[k].mb+' MB, '+LLM_CATALOG[k].note+')');
    n.msg='';
    if(!n.p.model) setMod(n,'model',loc.length ? loc[0].name : Object.keys(LLM_CATALOG)[0]);
  }catch(e){ n.msg='models: '+e.message; }
  n.rev=(n.rev||0)+1;
}
// замер скорости на этом телефоне: подбирает число потоков и запоминает лучшее в параметре threads
async function olmBench(n){
  if(!olmApp(n)){ n.msg='the benchmark works with the host «app» only'; n.rev++; return; }
  if(n.busy){ n.msg='wait for the answer to finish'; n.rev++; return; }
  const spec=llmSpec(n.p.model); if(!spec){ n.msg='choose a model first'; n.rev++; return; }
  n.busy=true; n.msg='benchmark: loading the model and trying thread counts…'; n.rev++;
  try{
    const r=await llmAppBench(spec,{gpu:!!n.p.appGpu,ctx:+n.p.numCtx||4096});
    setMod(n,'threads',r.best); n.msg='benchmark (best — '+r.best+' threads, now set; the fast cores: '+r.fast+'):\n'+llmBenchText(r);
  }catch(e){ n.msg='benchmark failed: '+e.message; }
  finally{ n.busy=false; n.rev++; }
}
async function olmModels(n){
  if(olmApp(n)) return olmModelsApp(n);
  const base=ndOllamaBase(n.p.host);
  n.msg='asking '+base+'…';
  try{
    const r=await ndGet(n,'t',base+'/api/tags','json',{timeout:10,cache:'t'+ndHash(base)});
    const list=ndOllamaTags(r.j); if(!list) throw new Error('this is not an Ollama server');
    n.models=list; n.msg=ndStatus(n,r) || (list.length ? '' : 'no models on the server — «ollama pull <name>»');
    if(!n.p.model && list.length) setMod(n,'model',list[0].name);
  }catch(e){ const t=ndErr(e); if(t) n.msg='models: '+t+olmHint(base); }
  n.rev=(n.rev||0)+1;
}
// почему не достучались: страница на https не может ходить на http-адрес в сети; Ollama отвечает только разрешённым Origin
const olmHint=base=>(typeof location!=='undefined' && location.protocol==='https:' && /^http:\/\/(?!127\.0\.0\.1|localhost)/.test(base) ? '\n  https page → http server: use 127.0.0.1 / localhost, a tunnel, or open the app over http' : '')
  +'\n  Ollama must allow this page: OLLAMA_ORIGINS=* (or the page address) and restart the server';
async function olmSend(n,prompt,ctx){
  prompt=String(prompt||'').trim(); if(!prompt){ n.msg='the prompt is empty'; n.rev++; return; }
  if(n.busy){ if(n.queue.length<5) n.queue.push([prompt,ctx]); else n.msg='the queue is full (5 questions)'; n.rev++; return; }     // вопрос не теряется: ответит следующим
  const model=String(n.p.model||'').trim();
  if(!model){ n.msg='choose a model («⟳ Models» or type a name)'; n.rev++; return; }
  const base=ndOllamaBase(n.p.host);
  const msgs=ndOllamaMessages(n.hist,n.sys,prompt,ctx,+n.p.keep);
  const body=ndOllamaBody(model,msgs,{temperature:+n.p.temp,numCtx:+n.p.numCtx,seed:+n.p.seed,keepAlive:n.p.keepAlive});
  (n.acs ||= {}).c?.abort();
  const ac=n.acs.c=new AbortController();
  n.busy=true; n.text=''; n.stats=null; n.msg='waiting for the model…'; n.t0=performance.now();
  let acc='';
  try{
    if(olmApp(n)){                                                       // llama.cpp в приложении: ответ по токенам через мост
      const spec=llmSpec(model); if(!spec) throw new Error('the model name is not valid: a key from the list, a .gguf file name or an address of a .gguf');
      if(typeof AppLink==='undefined' || !AppLink.ok) throw new Error('host «app» works only in the DSP app for Android');
      n.msg='';
      const r=await llmAppRun(spec,{gpu:!!n.p.appGpu,ctx:+n.p.numCtx||4096,messages:msgs,max:+n.p.maxTok||512,temp:+n.p.temp,seed:+n.p.seed,threads:+n.p.threads||0,signal:ac.signal},t=>{ acc+=t; n.text=acc; n.rev++; });
      n.stats={tokens:r.tokens,promptTokens:r.promptTokens,tps:r.tps,total:+((r.ms||0)/1000).toFixed(1),cached:r.cached|0};
    }else{
    const r=await ndFetch(n,base+'/api/chat',{method:'POST',signal:ac.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!r.ok){ const t=await ndWhy(r); throw new Error('HTTP '+r.status+(t ? ': '+t : '')); }
    const rd=r.body.getReader(), dec=new TextDecoder(); let buf='', fin=false;
    n.msg='';
    while(!fin){
      const {done,value}=await rd.read(); if(done) break;
      buf+=dec.decode(value,{stream:true});
      const p=ndNdjson(buf); buf=p.rest;
      for(const o of p.lines){
        const c=ndOllamaChunk(o);
        if(c.err) throw new Error(c.err);
        if(c.delta){ acc+=c.delta; n.text=acc; n.rev++; }
        if(c.done){ n.stats=c.stats; fin=true; }
      }
    }
    }
    n.hist.push({role:'user',content:prompt},{role:'assistant',content:acc});
    n.hist=n.hist.slice(-Math.max(2,(+n.p.keep|0)*2));
    n.last=acc; n.fresh=1; n.recOut={from:model,text:acc,role:'assistant',model,t:Date.now()};
  }catch(e){
    if(e.name==='AbortError'){ n.msg='stopped'; n.queue.length=0; if(acc){ n.last=acc; n.fresh=1; n.recOut={from:model,text:acc,role:'assistant',model,t:Date.now(),partial:1}; } }
    else n.msg='failed: '+ndErr(e)+(e instanceof TypeError && !olmApp(n) ? olmHint(base) : '');
  }finally{
    n.busy=false; n.rev=(n.rev||0)+1;
    const nx=n.queue.shift(); if(nx) olmSend(n,nx[0],nx[1]);
  }
}
def({ id:'ollama', title:'Ollama (local LLM)', cat:'Tools', readout:true, tall:true, w:340,
  kw:'ollama llm ai chat model language gpt llama qwen gemma mistral assistant ask question describe explain local',
  // чат с моделью на своём сервере Ollama (/api/chat, потоком); context — любой текст с проводов (запись, журнал, декодер)
  ins:[{n:'prompt',t:'txt'},{n:'system',t:'txt'},{n:'context',t:'txt'},{n:'send',t:'num'},{n:'stop',t:'num'},{n:'clear',t:'num'}],
  outs:[{n:'text',t:'txt'},{n:'last',t:'txt'},{n:'new',t:'num'},{n:'rec',t:'rec'},{n:'busy',t:'num'},{n:'tps',t:'num'},{n:'tokens',t:'num'},{n:'models',t:'txt'}],
  params:[{n:'host',t:'text',d:'http://127.0.0.1:11434',label:'Ollama server (host, host:port or URL) — or «app»: llama.cpp inside the DSP app for Android (GGUF models, GPU via OpenCL)'},
          {n:'model',t:'text',d:'',label:'model (name from «⟳ Models», e.g. llama3.2). Host «app»: a list key (qwen2.5-3b-instruct-q4_0), a .gguf file on the phone or an address of a .gguf — downloaded once'},
          {n:'appGpu',t:'check',d:true,label:'host «app»: use the GPU (OpenCL, Adreno 7xx / 8xx; fastest with Q4_0 models); off — CPU only. Switching CPU → GPU needs an app restart'},
          {n:'maxTok',t:'range',min:32,max:4096,step:32,d:512,label:'host «app»: longest answer, tokens'},
          {n:'threads',t:'num',d:0,min:0,max:16,step:1,label:'host «app»: threads (0 — the fast cores of the phone, found by the app; «⏱ Benchmark» picks the best on this phone)'},
          {n:'bench',t:'button',label:'⏱ Benchmark (host «app»)',fn:n=>olmBench(n)},
          {n:'list',t:'button',label:'⟳ Models',fn:n=>olmModels(n)},
          {n:'prompt',t:'text',d:'',label:'question (the wire «prompt» overrides it)'},
          {n:'sys',t:'text',d:'',label:'system prompt (the wire «system» overrides it)'},
          {n:'ask',t:'button',label:'▶ Ask',fn:n=>olmSend(n,n.inPrompt||n.p.prompt,n.inCtx)},
          {n:'stopb',t:'button',label:'■ Stop',fn:n=>n.acs?.c?.abort()},
          {n:'clr',t:'button',label:'Clear dialogue',fn:n=>{ n.queue.length=0; n.hist=[]; n.text=''; n.last=''; n.msg=''; n.rev++; }},
          {n:'auto',t:'check',d:false,label:'ask by itself when the «prompt» wire changes'},
          {n:'keep',t:'range',min:0,max:20,step:1,d:4,label:'exchanges kept in the dialogue (0 — every question alone)'},
          {n:'temp',t:'range',min:0,max:2,step:.1,d:.7,label:'temperature',adv:true},
          {n:'numCtx',t:'range',min:0,max:131072,step:1024,d:0,label:'context size, tokens (0 — the model default; host «app»: 4096). On the phone a longer dialogue loses its oldest messages',adv:true},
          {n:'seed',t:'num',d:0,min:0,step:1,label:'seed (0 — random)',adv:true},
          {n:'keepAlive',t:'text',d:'',label:'keep the model loaded (5m, 1h, 0 — unload at once)',adv:true},
          {n:'proxy',t:'check',d:false,label:'always through the CORS proxy from Settings (without it — directly, the proxy only after a refusal in «on error» mode)',adv:true}],
  init:n=>{ n.hist=[]; n.text=''; n.last=''; n.msg=''; n.busy=false; n.models=[]; n.stats=null; n.fresh=0; n.rev=0; n.sys='';
    n.queue=[]; n.cat=[]; n.recOut=null; n.inPrompt=''; n.inCtx=''; n.prevPrompt=null; n.s=false; n.st=false; n.cl=false; n.t0=0; },
  dispose:n=>{ ndAbort(n); },
  drawKey:n=>n.rev+'|'+n.msg+'|'+n.busy,
  process(n,I){
    const p=typeof I.prompt==='string' ? I.prompt : '';
    n.inCtx=typeof I.context==='string' ? I.context : '';
    n.sys=(typeof I.system==='string' && I.system) || n.p.sys || '';
    const prompt=p||n.p.prompt||'';
    n.inPrompt=prompt;
    if(ndPulse(n,'s',I.send)) olmSend(n,prompt,n.inCtx);
    else if(n.p.auto && p && p!==n.prevPrompt && !n.busy) olmSend(n,p,n.inCtx);
    n.prevPrompt=p||n.prevPrompt;
    if(ndPulse(n,'st',I.stop)) n.acs?.c?.abort();
    if(ndPulse(n,'cl',I.clear)){ n.queue.length=0; n.hist=[]; n.text=''; n.last=''; n.msg=''; n.rev++; }
    const fresh=n.fresh; n.fresh=0; const rec=fresh ? n.recOut : null;
    return {text:n.text,last:n.last||null,new:fresh,rec,busy:n.busy ? 1 : 0,tps:n.stats?.tps??null,tokens:n.stats?.tokens??null,
      models:n.models.length ? n.models.map(m=>m.name).join('\n') : null};
  },
  draw(n){
    const L=[];
    if(n.msg) L.push(n.msg);
    if(n.busy && !n.text && !n.msg) L.push('…');
    if(n.stats) L.push(n.stats.tokens+' tokens · '+(n.stats.tps ?? '?')+' tok/s · '+n.stats.total+' s'+(n.stats.cached ? ' · '+n.stats.cached+' prompt tokens from the cache' : ''));
    if(olmApp(n) && n.busy && !n.text && typeof LLMAP!=='undefined' && LLMAP.prog) L.push(LLMAP.prog+' (once — the model stays on the phone)');
    if(!n.text && !n.msg && n.models.length) L.push(n.models.length+' models: '+n.models.map(m=>m.name+(m.params ? ' ('+m.params+')' : '')).join(', '));
    if(!n.text && !n.msg && n.cat && n.cat.length) L.push('to download (type the key in «model»): '+n.cat.join('; '));
    else if(!n.text && !n.msg && !n.busy) L.push('type the model name (or press «⟳ Models»), write a question and press «▶ Ask»');
    if(n.text) L.push(n.text.length>3000 ? '…'+n.text.slice(-3000) : n.text);
    ndShow(n,L.join('\n'));
  }
});
