"use strict";
/* ============================ Podcasts / Webcams / Free Music: источники из сети ============================
   Podcasts — поиск в iTunes и RSS-лента → выпуски; Webcams — камеры из OpenStreetMap (Overpass);
   Free Music — Openverse и Internet Archive, без ключей. Список → выбор → url для Audio Stream / Playlist.
   Нужен CORS на сервере (или прокси из настроек); разбор ответов — online-kernels.js. */

const olNet=(n,u)=>n.p.proxy ? Net.url(u) : u;
// один запрос на ключ: новый отменяет прежний
async function olGet(n,key,url,kind,opt){
  const {timeout=20,...fo}=opt||{};
  (n.acs ||= {})[key]?.abort();
  const ac=n.acs[key]=new AbortController();
  const tm=setTimeout(()=>{ ac.timedOut=true; ac.abort(); },timeout*1000);
  try{
    const r=await fetch(url,{signal:ac.signal,...fo});
    if(!r.ok) throw new Error(r.status===429 ? 'HTTP 429 (rate limit — try later)' : 'HTTP '+r.status);
    return await (kind==='json' ? r.json() : r.text());
  }catch(e){
    if(ac.timedOut) throw new Error('timeout ('+timeout+' s) — server not responding, try again or use the CORS proxy');
    throw e;
  }finally{ clearTimeout(tm); }
}
const olErr=e=>e.name==='AbortError' ? '' : e.message+(e instanceof TypeError ? ' (no CORS headers on the server, or blocked — try «through the CORS proxy»)' : '');
const olAbort=n=>{ for(const k in n.acs||{}) try{ n.acs[k].abort(); }catch(e){} };
const olPulse=(n,key,v)=>{ const on=(v||0)>.5, was=n[key]; n[key]=on; return on && !was; };

/* ---------------------------------- Podcasts ---------------------------------- */
async function pcSearch(n){
  const q=n.p.query.trim();
  if(!q){ n.msg='enter what to search for'; return; }
  n.msg='searching…';
  try{
    const u='https://itunes.apple.com/search?'+new URLSearchParams({media:'podcast', entity:'podcast', term:q,
      limit:String(n.p.limit|0), country:(n.p.cc.trim()||'US').toUpperCase()});
    n.shows=olItunes(await olGet(n,'s',olNet(n,u),'json')); n.msg=n.shows.length ? '' : 'nothing found';
  }catch(e){ n.msg='search failed: '+olErr(e); }
}
async function pcLoad(n,feed){
  feed=String(feed||'').trim();
  if(!/^https?:\/\//i.test(feed)){ n.msg='feed URL must start with http:// or https://'; return; }
  n.msg='loading feed…'; n.feed=feed;
  try{
    const f=olFeed(await olGet(n,'f',olNet(n,feed),'text'));
    if(!f) throw new Error('not a podcast feed (RSS)');
    const show=f.title||feed;
    n.title=show; n.eps=f.items.slice(0,n.p.keep|0).map(e=>({...e,show}));
    n.cur=0; n.msg=n.eps.length ? '' : 'the feed has no episodes with audio';
  }catch(e){ n.msg='feed failed: '+olErr(e); }
}
function pcPlay(n,i){
  if(!n.eps.length || i<1 || i>n.eps.length) return;
  n.cur=i; n.pcPrev=i; setMod(n,'episode',i);
}

def({ id:'podcasts', title:'Podcasts', cat:'Sources', readout:true, tall:true, w:340,
  kw:'podcast rss feed episode itunes apple show audio listen',
  // rows — найденные подкасты (url — адрес ленты), episodes — выпуски выбранного (url — аудиофайл), url — текущий выпуск → Audio Stream
  ins:[{n:'feed',t:'txt'},{n:'episode',t:'val'},{n:'next',t:'num'}],
  outs:[{n:'rows',t:'bands'},{n:'episodes',t:'bands'},{n:'url',t:'txt'},{n:'name',t:'txt'},{n:'count',t:'num'}],
  params:[{n:'query',t:'text',d:'',label:'search (title, author, topic)'},
          {n:'cc',t:'text',d:'US',label:'store country (US, DE, RU, …)'},
          {n:'limit',t:'range',min:5,max:200,step:5,d:50,label:'max podcasts'},
          {n:'search',t:'button',label:'🔍 Search',fn:n=>pcSearch(n)},
          {n:'show',t:'text',d:'',label:'podcast (name from the search, or a feed URL)'},
          {n:'episode',t:'num',d:0,min:0,step:1,label:'episode number in the list (0 — none, 1 — newest)'},
          {n:'prev',t:'button',label:'◀ Newer',fn:n=>pcPlay(n,(n.cur||2)-1)},
          {n:'nextb',t:'button',label:'Older ▶',fn:n=>pcPlay(n,(n.cur||0)+1)},
          {n:'proxy',t:'check',d:false,label:'feed and audio through the CORS proxy from Settings'},
          {n:'keep',t:'range',min:10,max:1000,step:10,d:200,label:'episodes kept from a feed',adv:true}],
  init:n=>{ n.shows=[]; n.eps=[]; n.cur=0; n.pcPrev=0; n.msg=''; n.feed=''; n.title=''; n.inFeed=''; n.inEp=''; n.nx=false; n.lastShow=n.p.show; },
  dispose:n=>olAbort(n),
  process(n,I){
    if(typeof I.feed==='string' && I.feed && I.feed!==n.inFeed){ n.inFeed=I.feed; setMod(n,'show',I.feed); n.lastShow=I.feed; pcLoad(n,I.feed); }
    if(n.p.show!==n.lastShow){                       // руками: адрес ленты или имя из найденных
      n.lastShow=n.p.show;
      const s=n.p.show.trim();
      if(/^https?:\/\//i.test(s)) pcLoad(n,s);
      else{ const i=olFind(n.shows,s); if(i) pcLoad(n,n.shows[i-1].url); else if(s) n.msg='no podcast «'+s+'» in the search results'; }
    }
    const ev=I.episode, ek=ev==null || ev==='' || ev===0 ? '' : String(ev);
    if(ek && ek!==n.inEp){ n.inEp=ek; const i=olFind(n.eps,ev); if(i) pcPlay(n,i); else n.msg='no episode «'+ek+'»'; }
    else if(!ek) n.inEp='';
    if(olPulse(n,'nx',I.next)) pcPlay(n,(n.cur||0)+1);
    const pe=+n.p.episode|0;
    if(pe>0 && pe!==n.pcPrev) pcPlay(n,pe);
    const e=n.eps[n.cur-1];
    return {rows:n.shows.length ? n.shows : null, episodes:n.eps.length ? n.eps : null,
      url:e ? olNet(n,e.url) : null, name:e ? e.label : null, count:n.eps.length};
  },
  draw(n){
    const r=n.el.querySelector('.readout'); if(!r) return;
    const e=n.eps[n.cur-1], L=[];
    if(n.msg) L.push(n.msg);
    L.push(n.shows.length ? n.shows.length+' podcasts found' : 'search, or give a feed URL in «podcast» (iTunes Search)');
    if(n.title) L.push(n.title+' · '+n.eps.length+' episodes');
    if(e) L.push('▶ '+e.label+'\n  '+[e.date,olFmtDur(e.dur)].filter(Boolean).join(' · ')+'\n  '+e.url);
    const t=L.join('\n'); if(r.textContent!==t) r.textContent=t; }
});

/* ---------------------------------- Webcams ---------------------------------- */
const OL_OVERPASS=['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter','https://overpass.private.coffee/api/interpreter'];
async function wcSearch(n){
  const lat=n.lat, lon=n.lon;
  if(lat==null || lon==null){ n.msg='no centre — add My Position, wire lat / lon or set them'; return; }
  n.msg='searching OpenStreetMap…';
  const body='data='+encodeURIComponent(olWebcamQuery(lat,lon,+n.p.radius,+n.p.limit));
  let err='';
  for(const base of OL_OVERPASS){
    n.msg='searching OpenStreetMap… ('+base.split('/')[2]+')';
    try{
      const j=await olGet(n,'s',olNet(n,base),'json',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,timeout:35});
      if(j.remark && !(j.elements||[]).length) throw new Error('server busy: '+j.remark);
      n.cams=olWebcams(j); n.msg=n.cams.length ? '' : 'no webcams in OpenStreetMap within '+n.p.radius+' km — raise the radius';
      n.rowsOut=n.cams.map(c=>({...c,icon:'📷',color:'#7fd0ff',size:7})); n.sel=null; n.img=null;
      return;
    }catch(e){ err=olErr(e); if(!err) return; }
  }
  n.msg='search failed: '+err;
}
function wcSelect(n,c){
  if(n.sel===c) return;
  n.sel=c; n.img=null; n.shotMsg='';
  n.rowsOut=n.cams.map(x=>({...x,icon:'📷',color:x===c ? '#ffd84a' : '#7fd0ff',size:x===c ? 10 : 7}));
  if(c.kind==='image' || c.kind==='mjpeg') wcShot(n,true);
  else n.shotMsg=c.kind==='hls' ? 'HLS stream — wire «url» to IPTV' : 'a web page, not a picture — press «Open page»';
}
async function wcShot(n,force){
  const c=n.sel; if(!c || (n.busy && !force)) return;
  const my=n.shotId=(n.shotId|0)+1;
  n.busy=true; n.lastAt=performance.now();
  try{
    (n.acs ||= {}).i?.abort();
    const ac=n.acs.i=new AbortController();
    const r=await fetch(olNet(n,c.url),{signal:ac.signal,cache:'no-store'});
    if(!r.ok) throw new Error('HTTP '+r.status);
    let blob;
    if(c.kind==='mjpeg'){
      const rd=r.body.getReader(); let buf=new Uint8Array(0), fr=null;
      while(!fr && buf.length<4e6){
        const x=await rd.read(); if(x.done) break;
        const b=new Uint8Array(buf.length+x.value.length); b.set(buf); b.set(x.value,buf.length); buf=b;
        fr=olJpegFrame(buf);
      }
      ac.abort();
      if(!fr) throw new Error('no JPEG frame in the stream');
      blob=new Blob([fr],{type:'image/jpeg'});
    }else blob=await r.blob();
    const bmp=await createImageBitmap(blob);
    if(n.sel!==c) return;
    const W=+n.p.w, H=Math.round(W*bmp.height/bmp.width);
    if(n.capCv.width!==W || n.capCv.height!==H){ n.capCv.width=W; n.capCv.height=H; }
    n.capCx.drawImage(bmp,0,0,W,H); bmp.close?.();
    n.img={data:n.capCx.getImageData(0,0,W,H),w:W,h:H,gray:false,rev:(n.img?.rev|0)+1};
    n.shotMsg='updated '+new Date().toLocaleTimeString();
  }catch(e){ if(e.name!=='AbortError' && n.sel===c) n.shotMsg='picture failed: '+olErr(e); }
  finally{ if(n.shotId===my) n.busy=false; }
}

def({ id:'webcams', title:'Webcams', cat:'Sources', readout:true, tall:true, w:340, resize:true, view:{h:140},
  kw:'webcam camera web cam live view snapshot mjpeg openstreetmap osm overpass map picture',
  // камеры из OpenStreetMap (contact:webcam) вокруг точки; rows — на карту, img — снимок выбранной, url — поток (HLS / MJPEG) для IPTV
  ins:[{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'select',t:'rec'},{n:'url',t:'txt'}],
  outs:[{n:'rows',t:'bands'},{n:'img',t:'img'},{n:'url',t:'txt'},{n:'name',t:'txt'},{n:'count',t:'num'}],
  params:[{n:'lat',t:'num',d:0,label:'centre latitude (0 and 0 — My Position or wires)'},
          {n:'lon',t:'num',d:0,label:'centre longitude'},
          {n:'radius',t:'range',min:1,max:100,step:1,d:25,label:'radius, km'},
          {n:'search',t:'button',label:'🔍 Find webcams',fn:n=>wcSearch(n)},
          {n:'camera',t:'text',d:'',label:'camera (name, or click on the map), or a picture URL'},
          {n:'refresh',t:'range',min:0,max:300,step:5,d:30,label:'picture refresh, s (0 — once)'},
          {n:'shot',t:'button',label:'Refresh now',fn:n=>wcShot(n)},
          {n:'open',t:'button',label:'Open page',fn:n=>{ if(n.sel) window.open(n.sel.url,'_blank','noopener'); }},
          {n:'w',t:'select',opts:['160','320','640','960'],d:'320',label:'picture width'},
          {n:'proxy',t:'check',d:false,label:'through the CORS proxy from Settings'},
          {n:'limit',t:'range',min:50,max:1000,step:50,d:300,label:'max cameras',adv:true}],
  init:n=>{ n.cams=[]; n.rowsOut=null; n.sel=null; n.img=null; n.msg=''; n.shotMsg=''; n.busy=false; n.lastAt=0; n.lat=null; n.lon=null;
    n.capCv=document.createElement('canvas'); n.capCx=n.capCv.getContext('2d',{willReadFrequently:true});
    n.lastCam=n.p.camera; n.inUrl=''; },
  dispose:n=>olAbort(n),
  drawKey:n=>n.msg+'|'+n.shotMsg+'|'+n.img?.rev+'|'+n.cams.length+'|'+(n.sel?.id||''),
  process(n,I){
    const wl=recNum(I.lat), wo=recNum(I.lon);
    if(wl!=null && wo!=null){ n.lat=wl; n.lon=wo; }
    else if(+n.p.lat || +n.p.lon){ n.lat=+n.p.lat; n.lon=+n.p.lon; }
    else{ n.lat=GeoMe.lat; n.lon=GeoMe.lon; }
    for(const r of recList(I.select)){
      const id=String(r.id||'').replace(/^n:/,''); if(!id.startsWith('cam:')) continue;
      const c=n.cams.find(x=>x.id===id); if(c){ wcSelect(n,c); n.lastCam=n.p.camera; }
    }
    const direct=u=>{ if(!/^https?:\/\//i.test(u)) return false;
      const c={id:'cam:url',label:u.replace(/^https?:\/\//,'').slice(0,40),url:u,kind:olCamKind(u)}; n.cams=[c]; n.rowsOut=null; wcSelect(n,c); return true; };
    if(typeof I.url==='string' && I.url && I.url!==n.inUrl){ n.inUrl=I.url; setMod(n,'camera',I.url); n.lastCam=I.url; direct(I.url); }
    if(n.p.camera!==n.lastCam){
      n.lastCam=n.p.camera;
      const s=n.p.camera.trim();
      if(!direct(s)){ const i=olFind(n.cams,s); if(i) wcSelect(n,n.cams[i-1]); }
    }
    if(n.sel && (n.sel.kind==='image' || n.sel.kind==='mjpeg') && +n.p.refresh>0 && !n.busy && performance.now()-n.lastAt>n.p.refresh*1000) wcShot(n);
    const live=n.sel && n.sel.kind!=='page';
    return {rows:n.rowsOut, img:n.img, url:live ? olNet(n,n.sel.url) : null, name:n.sel?.label||null, count:n.cams.length};
  },
  draw(n,cv,cx){
    const r=n.el.querySelector('.readout');
    if(r){
      const L=[];
      if(n.msg) L.push(n.msg);
      if(n.cams.length) L.push(n.cams.length+' cameras');
      else if(!n.msg) L.push('press «Find webcams» (centre: My Position, wires or lat / lon)');
      if(n.sel) L.push('📷 '+n.sel.label+' · '+n.sel.kind+(n.shotMsg ? ' · '+n.shotMsg : '')+'\n  '+n.sel.url);
      const t=L.join('\n'); if(r.textContent!==t) r.textContent=t;
    }
    if(n.img) cx.drawImage(n.capCv,0,0,cv.width,cv.height); }
});

/* ---------------------------------- Free Music ---------------------------------- */
async function fmSearch(n,page){
  const q=n.p.query.trim();
  if(!q){ n.msg='enter what to search for'; return; }
  n.msg='searching…'; n.page=page;
  try{
    if(n.p.source==='Openverse'){
      const u='https://api.openverse.org/v1/audio/?'+new URLSearchParams({q, page_size:String(Math.min(20,n.p.limit|0)), page:String(page)});
      n.items=olOpenverse(await olGet(n,'s',olNet(n,u),'json')); n.tracks=n.items; n.cur=0; n.album='';
    }else{
      const x=n.p.extra.trim();
      const u='https://archive.org/advancedsearch.php?'+new URLSearchParams({q:'('+q+') AND mediatype:audio'+(x ? ' AND ('+x+')' : ''),
        rows:String(n.p.limit|0), page:String(page), output:'json'})+'&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=downloads&sort[]=downloads+desc';
      n.items=olArchiveItems(await olGet(n,'s',olNet(n,u),'json')); n.tracks=[]; n.cur=0; n.album='';
    }
    n.msg=n.items.length ? '' : 'nothing found';
  }catch(e){ if(e.name!=='AbortError') n.msg='search failed: '+olErr(e); }
}
async function fmItem(n,it){
  n.msg='loading «'+it.label+'»…'; n.album=it.label;
  try{
    n.tracks=olArchiveFiles(await olGet(n,'m',olNet(n,'https://archive.org/metadata/'+encodeURIComponent(it.ident)),'json'),it.ident);
    n.cur=0; n.msg=n.tracks.length ? '' : 'no mp3 / ogg / flac files in this item';
  }catch(e){ n.msg='item failed: '+olErr(e); }
}
function fmPlay(n,i){
  if(!n.tracks.length || i<1 || i>n.tracks.length) return;
  n.cur=i; n.fmPrev=i; setMod(n,'track',i);
}

def({ id:'freeMusic', title:'Free Music', cat:'Music', readout:true, tall:true, w:340,
  kw:'free music openverse internet archive archive.org creative commons cc jamendo freesound fma netlabel tracks songs search download stream',
  // Openverse (CC-музыка и звуки) или Internet Archive; rows — найденное, tracks — дорожки (url — файл) → Playlist, url — текущая → Audio Stream
  ins:[{n:'track',t:'val'},{n:'next',t:'num'}],
  outs:[{n:'rows',t:'bands'},{n:'tracks',t:'bands'},{n:'url',t:'txt'},{n:'name',t:'txt'},{n:'count',t:'num'}],
  params:[{n:'source',t:'select',opts:['Openverse','Internet Archive'],d:'Openverse',label:'source',
           tip:'Openverse — tracks under Creative Commons licences (Jamendo, Free Music Archive, Freesound, Wikimedia…), one file per result. Internet Archive — albums and recordings: pick one with «album», its audio files become the tracks'},
          {n:'query',t:'text',d:'',label:'search (title, artist, genre)'},
          {n:'limit',t:'range',min:5,max:50,step:5,d:20,label:'results per page (Openverse: 20 at most)'},
          {n:'search',t:'button',label:'🔍 Search',fn:n=>fmSearch(n,1)},
          {n:'more',t:'button',label:'Next page ▶',fn:n=>fmSearch(n,(n.page||1)+1)},
          {n:'album',t:'text',d:'',label:'album (Internet Archive: name, or identifier)'},
          {n:'track',t:'num',d:0,min:0,step:1,label:'track number in the list (0 — none)'},
          {n:'prev',t:'button',label:'◀ Previous',fn:n=>fmPlay(n,(n.cur||2)-1)},
          {n:'nextb',t:'button',label:'Next ▶',fn:n=>fmPlay(n,(n.cur||0)+1)},
          {n:'proxy',t:'check',d:false,label:'search and audio through the CORS proxy from Settings'},
          {n:'extra',t:'text',d:'collection:(opensource_audio OR netlabels)',label:'Internet Archive: extra search terms (Lucene)',adv:true}],
  init:n=>{ n.items=[]; n.tracks=[]; n.cur=0; n.fmPrev=0; n.page=1; n.msg=''; n.album=''; n.inTr=''; n.nx=false; n.lastAlbum=n.p.album; },
  dispose:n=>olAbort(n),
  process(n,I){
    if(n.p.album!==n.lastAlbum){
      n.lastAlbum=n.p.album;
      const i=olFind(n.items,n.p.album);
      if(n.p.source==='Internet Archive'){ if(i) fmItem(n,n.items[i-1]); else if(n.p.album.trim()) n.msg='no album «'+n.p.album+'» in the results'; }
    }
    const tv=I.track, tk=tv==null || tv==='' || tv===0 ? '' : String(tv);
    if(tk && tk!==n.inTr){ n.inTr=tk; const i=olFind(n.tracks,tv); if(i) fmPlay(n,i); else n.msg='no track «'+tk+'»'; }
    else if(!tk) n.inTr='';
    if(olPulse(n,'nx',I.next)) fmPlay(n,(n.cur||0)+1);
    const pt=+n.p.track|0;
    if(pt>0 && pt!==n.fmPrev) fmPlay(n,pt);
    const t=n.tracks[n.cur-1];
    return {rows:n.items.length ? n.items : null, tracks:n.tracks.length ? n.tracks : null,
      url:t ? olNet(n,t.url) : null, name:t ? (t.artist ? t.artist+' — ' : '')+t.label : null, count:n.tracks.length};
  },
  draw(n){
    const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.tracks[n.cur-1], L=[];
    if(n.msg) L.push(n.msg);
    if(n.items.length) L.push(n.items.length+' found · page '+n.page+(n.p.source==='Internet Archive' ? ' — pick an album' : ''));
    else if(!n.msg) L.push('type a query and press Search ('+n.p.source+')');
    if(n.album) L.push(n.album+' · '+n.tracks.length+' tracks');
    if(t) L.push('▶ '+(t.artist ? t.artist+' — ' : '')+t.label+'\n  '+[olFmtDur(t.dur),t.license,t.source,t.genre].filter(Boolean).join(' · ')+'\n  '+t.url);
    const s=L.join('\n'); if(r.textContent!==s) r.textContent=s; }
});
