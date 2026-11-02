"use strict";
/* ============================ VIDEO PLAYER ============================
   Видеоплеер для списка источников (Table: name, url): файл (mp4 / webm / ogg) или HLS (.m3u8: в Safari сам, в остальных —
   vendor/hls.min.js, грузится при первом HLS). Перемотка (ползунок, ±10 с, клавиши ← →, вход seek), скорость, следующий /
   предыдущий источник. Серии: колонки series / season / episode (или S01E02, «3 серия» в названии) — список упорядочен и
   сгруппирован по сезонам, в конце серии играет следующая, ↻ продолжает с места, где остановились; метки ✓ / ▸N %. Позиция запоминается по адресу (localStorage dsp-vpos, последние 300) и при открытии того же адреса
   плеер продолжает с неё; запись {url,name,pos,dur,pct,done,t} уходит на rec — в Table с ключом url получается «история».
   В приложении Android libVLC (VlcHub.kt) только открывает адрес — mkv / avi / ts, AC3 / DTS, udp:// и rtp:// multicast провайдера, rtsp://,
   smb:// ftp:// sftp:// nfs:// upnp:// rtmp:// — и отдаёт его как HLS на loopback; играет тот же <video> (vpOpenStream, команды моста vlc.stream.*).
   Ядро — modules/vplayer-kernels.js. */

const VP_KEY='dsp-vpos', VP_SAVE_MS=5000;
function vpLoadMap(){ try{ const m=JSON.parse(LS.get(VP_KEY)||'{}'); return m && typeof m==='object' ? m : {}; }catch(e){ return {}; } }
const vpEl=(tag,cls,text)=>{ const e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e; };
let vpHlsLoading=null;
function vpLoadHls(){
  if(window.Hls) return Promise.resolve(window.Hls);
  return vpHlsLoading || (vpHlsLoading=new Promise((res,rej)=>{
    const s=document.createElement('script'); s.src='vendor/hls.min.js?v=1.5.17';
    s.onload=()=>res(window.Hls); s.onerror=()=>{ vpHlsLoading=null; rej(new Error('failed to load vendor/hls.min.js')); };
    document.head.append(s); }));
}
function vpStatus(n,s){ n.status=s; n.dirty=true; }

// позиция и длительность источника: у потока libVLC лента HLS начинается с секунды старта (n.sbase), длительность известна от libVLC
const vpT=n=>(n.v.currentTime||0)+(n.sid ? n.sbase : 0);
const vpD=n=>n.sid && n.sdur>0 ? n.sdur : (isFinite(n.v.duration) ? n.v.duration : 0);
// записать позицию (в хранилище и в очередь rec); force — даже если почти не сдвинулась
function vpSave(n,force){
  const v=n.v, url=n.url; if(!v || !url) return;
  const pos=vpT(n), dur=vpD(n);
  if(!(pos>0) || (!force && Math.abs(pos-n.savedPos)<1)) return;
  const m=vpLoadMap(), e=vpPut(m,url,pos,dur,n.name,Date.now(),300);
  if(!e) return;
  try{ LS.set(VP_KEY,JSON.stringify(m)); }catch(x){}
  n.savedPos=pos; n.bump++; n.recQ.push(vpRec(url,n.name,e,n.meta));
  if(n.recQ.length>200) n.recQ.splice(0,n.recQ.length-200);
}
function vpDestroy(n){
  vpSave(n,true);
  vpStreamDrop(n);
  if(n.hls){ try{ n.hls.destroy(); }catch(e){} n.hls=null; }
  if(n.v){ try{ n.v.pause(); n.v.removeAttribute('src'); n.v.load(); }catch(e){} }
  n.gen=(n.gen||0)+1;
}
// открыть адрес; start — секунда (undefined — взять сохранённую)
async function vpOpen(n,url,name,start,meta){
  url=String(url||'').trim();
  if(!url){ return; }
  if(!VP_URL_RE.test(url)){ vpStatus(n,'URL must start with http:// or https:// (udp:// rtp:// rtsp:// magnet: — in the DSP app)'); return; }
  if(vpIsIaPage(url)){ vpOpenItem(n,vpIaId(url)); return; }          // страница archive.org/details/… — не видео: берём файлы предмета
  vpDestroy(n);
  const g=n.gen;
  n.tainted=false; n.retry=0; n.tretry=0; n.started=false; n.torrentTried=false; n.sAudio=-1; n.sSub=-1; n.sTried=false; n.stracks=null;
  n.alts=String(meta && meta.alt || '').split(/\s+/).filter(Boolean); n.altI=-1;
  n.url=url; n.playUrl=url; n.torrent=null; n.tline=''; n.name=name || url; n.meta=meta||null; n.savedPos=-9; n.ended=false; n.pend=0;
  n.warn= typeof netInsecure==='function' && /^http:/i.test(url) && netInsecure(url) ? NET_INSECURE_MSG : '';
  const from= start!=null ? +start : vpResume(vpLoadMap()[url]);
  if(vpKind(url)==='torrent'){ vpOpenTorrent(n,url,from,g); return; }
  vpStart(n,url,from,g);
}
// играть адрес playUrl (для торрента — локальный адрес файла из приложения) с позиции from; n.url остаётся «ключом» источника (позиции, история)
async function vpStart(n,playUrl,from,g,viaStream){
  const v=n.v, kind=vpKind(playUrl);
  // в приложении libVLC превращает адрес, который браузер не знает (smb / ftp / sftp / nfs / upnp / rtmp, udp / rtp / rtsp, mkv / ts / avi), в HLS для этого <video>
  const eng=String(n.p.engine||'auto');
  if(!viaStream && vpStreamWanted(eng,kind,vpInApp())){ vpOpenStream(n,playUrl,from,g); return; }
  if(!viaStream && (kind==='vlc' || kind==='native')){
    vpStatus(n,(kind==='vlc' ? 'smb:// ftp:// sftp:// nfs:// upnp:// rtmp:// addresses are opened by libVLC of the DSP app for Android' : 'udp:// rtp:// rtsp:// addresses (multicast IPTV), mkv / ts / avi are opened by libVLC of the DSP app for Android')+' — a browser cannot open them'); return; }
  v.playbackRate=+n.p.speed||1;
  if(n.p.capture) v.crossOrigin='anonymous'; else v.removeAttribute('crossorigin');
  vpStatus(n,'loading…');
  n.from=from;
  const seekStart=()=>{ if(g===n.gen){ n.started=true; if(from>0){ try{ v.currentTime=from; }catch(e){} } } };
  v.addEventListener('loadedmetadata',seekStart,{once:true});
  try{
    if(kind==='hls' && !v.canPlayType('application/vnd.apple.mpegurl')){
      const Hls=await vpLoadHls(); if(g!==n.gen) return;
      if(!Hls.isSupported()) throw new Error('HLS is not supported by this browser');
      const h=n.hls=new Hls({startPosition:viaStream ? 0 : from>0 ? from : -1});
      h.on(Hls.Events.ERROR,(ev,d)=>{ if(g===n.gen && d.fatal) vpStatus(n,'HLS error: '+d.type+(d.details ? ' / '+d.details : '')+(d.type==='networkError' ? ' (CORS or the address is unreachable)' : '')); });
      h.on(Hls.Events.MANIFEST_PARSED,(ev,d)=>{ n.levels=d.levels.map(l=>l.height ? l.height+'p' : Math.round(l.bitrate/1000)+'k'); n.dirty=true; });
      h.loadSource(playUrl); h.attachMedia(v);
    }else if(kind==='dash') throw new Error('DASH (.mpd) is not supported — use HLS or a file');
    else{ n.levels=null; v.src=playUrl; }
    vpMedia(n);
    if(n.p.autoplay) await v.play();
  }catch(e){
    if(g===n.gen && e.name!=='NotSupportedError' && e.name!=='AbortError') vpStatus(n,e.name==='NotAllowedError' ? 'press ▶ to play (the browser blocks autoplay)' : 'error: '+e.message);
  }
}
/* ---------- поток libVLC: адрес → HLS на loopback (vlc.stream.open) → обычный <video> ---------- */
function vpStreamClose(n,sid){ if(sid && n.bgP) n.bgP.then(ns=>ns.call('vlc.stream.close',{sid},3000)).catch(()=>{}); }
function vpStreamDrop(n){ const s=n.sid; n.sid=0; n.sbase=0; n.sdur=0; if(s) vpStreamClose(n,s); }
// from — секунда источника; g — поколение (vpDestroy меняет его, и запоздалый ответ моста отбрасывается)
async function vpOpenStream(n,srcUrl,from,g){
  vpStatus(n,'libVLC: opening the address…');
  try{
    const ns=await vpBridge(n); if(g!==n.gen) return;
    vpStreamDrop(n);
    const r=await ns.call('vlc.stream.open',vpStreamReq(srcUrl,n.p,{start:from,audio:n.sAudio,sub:n.sSub}),45000);
    if(g!==n.gen){ vpStreamClose(n,+r.sid); return; }
    n.sid=+r.sid; n.sbase=from>0 ? from : 0; n.sdur=(+r.dur||0)/1000; n.stracks=vpTracks(r.tracks); n.splan=String(r.plan||''); n.ui && (n.ui.trKey='x'); n.dirty=true;
    vpStatus(n,'libVLC stream · '+n.splan);
    vpStart(n,String(r.url),0,g,true);
  }catch(e){
    if(g!==n.gen) return;
    vpStatus(n,'libVLC stream: '+e.message);
  }
}
// событие libVLC из моста: {src:'vlc', ev:'stream', sid, state, msg}
function vpStreamEvent(n,r){
  if(r.ev!=='stream' || r.sid!==n.sid) return;
  if(r.state==='error'){ vpStatus(n,'libVLC: '+(r.msg||'cannot repack this address')); }
  else if(r.state==='ended' && n.v.paused===false){ /* конец решает сам <video> по концу ленты */ }
}
// другая дорожка звука / субтитров: поток открывается заново с текущей секунды
function vpStreamReopen(n,at){
  if(!n.sid) return;
  const t= at!=null ? at : vpT(n), src=n.url;
  n.sbase=t;                                                            // пока поток переоткрывается, позиция (и её сохранение) остаётся на t
  if(n.hls){ try{ n.hls.destroy(); }catch(e){} n.hls=null; }
  try{ n.v.pause(); n.v.removeAttribute('src'); n.v.load(); }catch(e){}
  const g=++n.gen; n.started=false; n.ended=false;
  vpOpenStream(n,n.playUrl||src,t,g);
}
// перейти на секунду t источника: у потока — внутри записанного окна обычным seek, иначе поток начинается заново с t
function vpGoto(n,t){
  const v=n.v;
  if(!n.sid){ try{ v.currentTime=t; }catch(e){} return; }
  const sk=v.seekable, end=sk && sk.length ? sk.end(sk.length-1) : 0, p=vpStreamSeekPlan(t,n.sbase,end);
  if(p.reopen) vpStreamReopen(n,t); else v.currentTime=p.rel;
}
/* ---------- торренты: через мост приложения (torrent.*), файл стримится по HTTP с Range и играет как обычный ---------- */
const VP_BRIDGE='ws://127.0.0.1:8765';
// → Promise<NetSock>; одно соединение на узел; служба приложения могла только что подняться — одна повторная попытка через 1.5 с
function vpBridge(n){
  return vpBridge1(n).catch(e=>new Promise(r=>setTimeout(r,1500)).then(()=>vpBridge1(n)));
}
function vpBridge1(n){
  if(n.bgP) return n.bgP;
  return n.bgP=new Promise((res,rej)=>{
    let key=''; try{ key=(window.DspApp && DspApp.appKey && DspApp.appKey()) || ''; }catch(e){}
    const url=typeof phoneUrl==='function' ? phoneUrl(String(n.p.bridge||VP_BRIDGE).trim(),key) : '';
    if(!url){ n.bgP=null; return rej(new Error('the bridge address must start with ws:// or be a device name (@name)')); }
    let ws; try{ ws=new WebSocket(url); }catch(e){ n.bgP=null; return rej(e); }
    const ns=new NetSock(m=>{ if(ws.readyState!==1) throw new Error('the bridge is not connected'); ws.send(JSON.stringify(m)); });
    ws.onopen=()=>{ n.bgWs=ws; res(ns); };
    ws.onerror=()=>{ if(!n.bgWs){ n.bgP=null; rej(new Error('no connection to the bridge ('+url.replace(/\?.*$/,'')+') — torrents work through the DSP app for Android (is it running?)')); } };
    ws.onclose=()=>{ n.bgP=null; n.bgWs=null; };
    ws.onmessage=e=>{ if(typeof e.data!=='string') return; let j; try{ j=JSON.parse(e.data); }catch(x){ return; } for(const r of Array.isArray(j) ? j : [j]){ if(r && r.src==='vlc') vpStreamEvent(n,r); else ns.feed(r); } };
  });
}
function vpBridgeDrop(n){ const ws=n.bgWs; n.bgP=null; n.bgWs=null; if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} } }
// probe — адрес http(s) не оканчивался на .torrent, но плеер не смог его проиграть: пробуем как торрент; если и это нет — говорим о обоих
async function vpOpenTorrent(n,url,from,g,probe){
  const ref=vpTorrentRef(url);
  vpStatus(n,'torrent: connecting to the app…');
  let wait=0;
  try{
    const ns=await vpBridge(n); if(g!==n.gen) return;
    let r=n.tinfo && n.tinfo[ref.base];
    if(!r){
      const t0=performance.now(), hash=vpMagnetHash(ref.base);
      vpStatus(n,'torrent: looking for the metadata (peers, DHT)…');
      // метаданные могут искаться минуту и больше: пока torrent.add ждёт, раз в 2 с спрашиваем, что видит сессия (узлы DHT, пиры)
      if(hash) wait=setInterval(()=>{ ns.call('torrent.status',{hash},6000).then(st=>{ if(g===n.gen && !n.torrent) vpStatus(n,vpTorrentSearchLine(st,(performance.now()-t0)/1000)); }).catch(()=>{}); },2000);
      r=await ns.call('torrent.add',{src:ref.base,timeout:90},130000); clearInterval(wait); wait=0; if(g!==n.gen) return;
      if(typeof r.files==='string') r.files=JSON.parse(r.files);
      (n.tinfo || (n.tinfo={}))[ref.base]=r;
    }
    vpTorrentGo(n,url,ref,r,from,g,ns);
  }catch(e){
    if(wait) clearInterval(wait);
    if(g===n.gen) vpStatus(n,probe ? 'error: '+probe+'\nit is not a torrent either: '+e.message : 'torrent: '+e.message);
  }
}
// метаданные есть (r — ответ torrent.add): список файлов или один файл → адрес стрима → играть
async function vpTorrentGo(n,url,ref,r,from,g,ns){
  try{
    const rows=vpTorrentRows(url,r);
    if(!rows.length){ vpStatus(n,'torrent «'+(r.name||ref.base.slice(0,40))+'»: no video files in it'); return; }
    let idx=ref.file;
    if(idx==null){
      if(rows.length>1){                                           // раздача из нескольких видео — серии: список, играет продолжение или первая
        n.list=vpSources(rows); n.rowsKey='tor:'+ref.base; n.idx=-1; n.dirty=true; n.bump++;
        vpStatus(n,r.name+': '+n.list.length+' videos'); vpResumeList(n); return; }
      idx=+rows[0].url.split('#file=')[1];
    }
    const sr=await ns.call('torrent.stream',{tid:r.tid,file:idx},20000); if(g!==n.gen) return;
    n.torrent={tid:r.tid,file:idx}; n.playUrl=sr.url; n.tline='torrent: starting…'; n.tpoll=0;
    vpStatus(n,'torrent: waiting for the first pieces…');
    vpStart(n,sr.url,from,g);
  }catch(e){ if(g===n.gen) vpStatus(n,'torrent: '+e.message); }
}
// файл .torrent с телефона / компьютера (трекеры с входом, как rutracker, не отдают его по ссылке): байты → мост → тот же путь, что у magnet
async function vpOpenTorrentFile(n,f){
  vpDestroy(n); const g=n.gen; n.url=''; n.torrent=null; n.tline='';
  vpStatus(n,'torrent: reading '+f.name+'…');
  try{
    const buf=new Uint8Array(await f.arrayBuffer());
    let bin=''; for(let i=0;i<buf.length;i+=0x8000) bin+=String.fromCharCode.apply(null,buf.subarray(i,i+0x8000));
    const ns=await vpBridge(n); if(g!==n.gen) return;
    vpStatus(n,'torrent: adding '+f.name+'…');
    const r=await ns.call('torrent.add',{b64:btoa(bin)},60000); if(g!==n.gen) return;
    if(typeof r.files==='string') r.files=JSON.parse(r.files);
    const url='magnet:?xt=urn:btih:'+r.tid+'&dn='+encodeURIComponent(r.name||f.name);        // ключ источника для позиций и истории
    (n.tinfo || (n.tinfo={}))[url]=r;
    n.name=r.name||f.name; n.url=url; n.playUrl=url; n.meta=null; n.savedPos=-9; n.ended=false;
    vpTorrentGo(n,url,vpTorrentRef(url),r,vpResume(vpLoadMap()[url]),g,ns);
  }catch(e){ if(g===n.gen) vpStatus(n,'torrent: '+e.message); }
}
// состояние раздачи — раз в 2 с, пока играет торрент
function vpTorrentPoll(n){
  const now=performance.now(); if(!n.torrent || n.tbusy || now-n.tpoll<2000) return;
  n.tpoll=now; n.tbusy=true;
  vpBridge(n).then(ns=>ns.call('torrent.status',{tid:n.torrent.tid},8000)).then(st=>{ if(n.torrent){ n.tline=vpTorrentLine(st); n.dirty=true; } }).catch(()=>{}).finally(()=>{ n.tbusy=false; });
}
// страница предмета Internet Archive → список файлов (серии) в плеере; продолжить с места или первый
async function vpOpenItem(n,id){
  if(!id){ vpStatus(n,'not an Internet Archive link'); return; }
  vpDestroy(n); const g=n.gen; n.url=''; vpStatus(n,'loading '+id+'…');
  try{
    const r=await fetch('https://archive.org/metadata/'+encodeURIComponent(id)); if(!r.ok) throw new Error('HTTP '+r.status);
    const files=vpIaFiles(await r.json(),id); if(g!==n.gen) return;
    if(!files.length){ vpStatus(n,id+': no video files (mp4 / webm / ogv) — the item may be restricted or hold other formats'); return; }
    n.list=vpSources(files); n.rowsKey='ia:'+id; n.idx=-1; n.dirty=true; n.bump++;
    vpStatus(n,id+': '+n.list.length+' video'+(n.list.length>1 ? 's' : ''));
    vpResumeList(n);
  }catch(e){ if(g===n.gen) vpStatus(n,'error: '+e.message+(e instanceof TypeError ? ' (no network, or archive.org blocked the request)' : '')); }
}
// новый src того же видео с позиции from (запасной формат или повтор после сбоя)
function vpSetSrc(n,src,from){
  const v=n.v, g=n.gen; n.from=from; n.started=false; n.levels=null;
  v.addEventListener('loadedmetadata',()=>{ if(g===n.gen){ n.started=true; if(from>0){ try{ v.currentTime=from; }catch(e){} } } },{once:true});
  v.src=src; v.play().catch(()=>{});
}
// запасной формат того же видео, если этот не играется (from — позиция, с которой продолжить)
function vpAlt(n,from){
  if(n.altI+1>=n.alts.length) return false;
  const u=n.alts[++n.altI];
  vpStatus(n,'this format does not play — trying another ('+(n.altI+1)+'/'+n.alts.length+')…');
  vpSetSrc(n,u,from==null ? n.from : from);
  return true;
}
// ошибка <video>: сбой уже начатого воспроизведения (перемотка, обрыв сети) — до двух повторов с той же позиции, потом другой формат,
// потом нативный плеер приложения; в сообщении — код ошибки и позиция
function vpOnError(n){
  const v=n.v; if(!v.getAttribute('src') || n.hls) return;
  const code=v.error && v.error.code, pos=n.started ? (vpT(n)||n.lastPos||0) : n.from, at=n.started ? ' at '+vpFmt(pos) : '';
  if(n.started && n.retry<2){
    n.retry++; vpStatus(n,'playback error'+at+' ('+vpMediaErr(code)+') — retrying '+n.retry+'/2…');
    vpSetSrc(n,v.currentSrc||n.url,pos); return;
  }
  // локальный адрес файла торрента ответил 503 / оборвался — первые куски ещё не пришли (нет пиров): ждём и повторяем, а не объявляем «формат не поддержан»
  if(n.torrent && !n.started){
    if((n.tretry||0)<30){
      n.tretry=(n.tretry||0)+1; const g=n.gen;
      vpStatus(n,'torrent: waiting for the first pieces from the peers… attempt '+n.tretry+'/30');
      setTimeout(()=>{ if(g===n.gen && n.torrent) vpSetSrc(n,n.playUrl,n.from); },3000); return; }
    vpStatus(n,'torrent: no data came in 90 s — no peers or they send nothing\n'+(n.tline||'')); return;
  }
  if(vpAlt(n,pos)) return;
  // адрес вида https://трекер/dl.php?t=123 не похож на .torrent, но может им быть: пробуем один раз (приложение само скачает и разберёт)
  if(!n.torrentTried && !n.started && !n.torrent && /^https?:/i.test(n.url) && vpInApp()){
    n.torrentTried=true; const msg=vpMediaErr(code)+(code ? '' : '');
    vpStatus(n,'the browser cannot play this ('+vpMediaErr(code)+') — trying it as a torrent…');
    vpOpenTorrent(n,n.url,pos,n.gen,'the address does not give a video ('+vpMediaErr(code)+')'); return; }
  if(vpInApp() && !n.sid && !n.sTried && String(n.p.engine||'auto')!=='browser'){ n.sTried=true; vpStatus(n,'the browser cannot play this ('+vpMediaErr(code)+') — trying libVLC of the app…'); vpOpenStream(n,n.playUrl||n.url,pos,n.gen); return; }
  vpStatus(n,'error'+at+': '+vpMediaErr(code)+(v.error && v.error.message ? ' — '+v.error.message : '')+'\n'+n.url); }

// страница в приложении Android (мост и libVLC есть)
const vpInApp=()=>{ try{ return !!(window.DspApp && typeof DspApp.appKey==='function'); }catch(e){ return false; } };
// Media Session: кнопки перемотки / дорожек в системном окне PiP, на экране блокировки и в наушниках
function vpMedia(n){
  if(!('mediaSession' in navigator)) return;
  try{
    const ms=navigator.mediaSession;
    ms.metadata=new MediaMetadata({title:n.name||'',artist:n.meta && n.meta.series || '',album:n.meta && n.meta.series ? vpGroup(n.meta) : ''});
    const h=(a,f)=>{ try{ ms.setActionHandler(a,f); }catch(e){} };
    h('play',()=>n.v.play()); h('pause',()=>n.v.pause());
    h('seekbackward',d=>vpSeekBy(n,-((d && d.seekOffset)||10))); h('seekforward',d=>vpSeekBy(n,(d && d.seekOffset)||10));
    h('seekto',d=>{ if(d && d.seekTime!=null) vpGoto(n,d.seekTime); });
    h('previoustrack',n.list.length>1 ? ()=>vpStep(n,-1) : null); h('nexttrack',n.list.length>1 ? ()=>vpStep(n,1) : null);
  }catch(e){}
}
function vpMediaPos(n){
  try{ const v=n.v, d=vpD(n); if('mediaSession' in navigator && d>0) navigator.mediaSession.setPositionState({duration:d,position:Math.min(vpT(n),d),playbackRate:v.playbackRate||1}); }catch(e){}
}
// текущий кадр на холсте — для плавающего окна и PiP приложения Android (там нет окна PiP у <video>); чужой сервер без CORS холст «пачкает» — тогда кадра нет
function vpFrame(n){
  const v=n.v, c=n.fcv || (n.fcv=document.createElement('canvas'));
  if(v && v.videoWidth && !n.tainted) vpDrawFrame(n,c);
  if(!v || !v.videoWidth || n.tainted){                       // картинки нет — не пустое окно, а понятная заметка
    c.width=640; c.height=360; const x=c.getContext('2d');
    x.fillStyle='#000'; x.fillRect(0,0,640,360); x.fillStyle='#fff'; x.textAlign='center';
    x.font='bold 26px sans-serif'; x.fillText((n.name||'Video Player').slice(0,40),320,140);
    x.font='20px monospace'; const t=v && vpT(n) || 0, d=v ? vpD(n) : 0;
    x.fillText(vpFmt(t)+(d>0 ? ' / '+vpFmt(d) : ''),320,185);
    x.font='15px sans-serif'; x.fillStyle='#bbb';
    const msg=n.tainted ? ['no picture: the server does not allow frame capture (CORS).','Tick «allow picture capture» in the player settings,','use ⤢ fullscreen or ⧉ picture in picture.'] : ['no picture yet'];
    msg.forEach((l,i)=>x.fillText(l,320,225+i*22));
  }
  return c;
}
function vpDrawFrame(n,c){
  const v=n.v;
  const k=Math.min(1,960/Math.max(v.videoWidth,v.videoHeight)), w=Math.max(1,Math.round(v.videoWidth*k)), h=Math.max(1,Math.round(v.videoHeight*k));
  if(c.width!==w || c.height!==h){ c.width=w; c.height=h; }
  const x=c.getContext('2d'); x.drawImage(v,0,0,w,h);
  try{ x.getImageData(0,0,1,1); }catch(e){ n.tainted=true; }            // чужое видео без CORS «пачкает» холст: toDataURL / captureStream не отдадут кадр
}
function vpStep(n,d){
  const L=n.list; if(!L.length) return;
  const i=(((n.idx<0 ? 0 : n.idx)+d)%L.length+L.length)%L.length;
  vpPick(n,i);
}
function vpPick(n,i,start){
  const c=n.list[i]; if(!c) return;
  n.idx=i; n.dirty=true; vpOpen(n,c.url,c.name,start,c);
}
// продолжить: последний начатый источник списка с его позиции; досмотренный — следующая серия
function vpResumeList(n){
  const r=vpContinue(n.list,vpLoadMap());
  if(r) vpPick(n,r.i,r.pos); else if(n.list.length) vpPick(n,0); }
function vpToggle(n){
  const v=n.v; if(v.paused || v.ended) v.play().catch(()=>{}); else v.pause(); }
function vpSeekBy(n,d){
  const v=n.v; if(!v.src && !n.hls) return;
  const dur=vpD(n);
  let t=vpSeek(vpT(n),d,dur);
  if(n.sid){ vpGoto(n,t); return; }
  const sk=v.seekable;                                                   // сервер без Range: перемотать можно только в уже загруженное
  if(v.readyState>=1 && sk && sk.length && dur>0 && t>sk.end(sk.length-1)+1 && sk.end(sk.length-1)<dur-1){
    t=sk.end(sk.length-1); vpStatus(n,'the server does not support seeking (no Range): only the loaded part is available'); }
  v.currentTime=t; }
function vpSeekTo(n,frac){
  const v=n.v, d=vpD(n); if(d>0){ vpGoto(n,frac*d); vpSave(n,true); } }
function vpFull(n){ nodeFullscreen(n); }                     // общий для узлов: Fullscreen API на весь блок плеера с панелью управления

function vpMount(n){
  const root=vpEl('div','vp'); root.tabIndex=0;
  const stage=vpEl('div','vp-stage'), v=n.v;
  v.playsInline=true; v.preload='metadata'; v.controls=false;
  const msg=vpEl('div','vp-msg'), tap=vpEl('div','vp-tap'); stage.append(v,msg,tap);
  const bar=vpEl('div','vp-bar');
  const mk=(txt,title,fn)=>{ const b=vpEl('button','vp-b',txt); b.title=title; b.onclick=fn; return b; };
  const bPrev=mk('⏮','previous source',()=>vpStep(n,-1));
  const bPlay=mk('▶','play / pause (Space)',()=>vpToggle(n));
  const bCont=mk('↻','continue watching: the last started source from its position',()=>vpResumeList(n));
  const bNext=mk('⏭','next source',()=>vpStep(n,1)), bFull=mk('⤢','fullscreen (F, double tap the middle of the picture)',()=>vpFull(n));
  const seek=vpEl('input','vp-seek'); seek.type='range'; seek.min=0; seek.max=1000; seek.value=0;
  const time=vpEl('span','vp-time','0:00 / 0:00');
  const speed=vpEl('select','vp-speed');
  for(const s of [.5,.75,1,1.25,1.5,2]){ const o=vpEl('option',null,s+'×'); o.value=s; speed.append(o); }
  speed.value=String(+n.p.speed||1);
  const src=vpEl('select','vp-src'); src.title='source';
  const q=vpEl('select','vp-q'); q.title='quality'; q.hidden=true;
  const aud=vpEl('select','vp-aud'), sub=vpEl('select','vp-sub'); aud.title='audio track (libVLC)'; sub.title='subtitles (libVLC)'; aud.hidden=sub.hidden=true;
  bar.append(bCont,bPrev,bPlay,bNext,seek,time,speed,q,aud,sub,bFull);
  root.append(stage,bar,src);
  let drag=false;
  seek.addEventListener('input',()=>{ drag=true; const d=vpD(n); if(d>0) time.textContent=vpFmt(seek.value/1000*d)+' / '+vpFmt(d); });
  seek.addEventListener('change',()=>{ drag=false; vpSeekTo(n,seek.value/1000); });
  speed.onchange=()=>{ v.playbackRate=+speed.value; setMod(n,'speed',+speed.value); };
  src.onchange=()=>vpPick(n,+src.value);
  q.onchange=()=>{ if(n.hls) n.hls.currentLevel=+q.value; };
  aud.onchange=()=>{ n.sAudio=+aud.value; vpStreamReopen(n); };
  sub.onchange=()=>{ n.sSub=+sub.value; vpStreamReopen(n); };
  // клик — пауза (с задержкой: двойной клик — на весь экран, а не два переключения); события дальше узла не идут, иначе двойной клик сворачивает модуль
  let clickT=0;
  stage.addEventListener('click',e=>{ e.stopPropagation(); clearTimeout(clickT); clickT=setTimeout(()=>vpToggle(n),260); });
  // двойной тап: по левой трети −10 с, по правой +10 с (повторные тапы складываются), по середине — на весь экран
  let tapT=0, tapSum=0, tapSide='';
  stage.addEventListener('dblclick',e=>{
    e.stopPropagation(); e.preventDefault(); clearTimeout(clickT);
    const r=stage.getBoundingClientRect(), z=vpTapZone(e.clientX-r.left,r.width);
    if(z==='full'){ vpFull(n); return; }
    vpSeekBy(n,z==='back' ? -10 : 10);
    tapSum= tapSide===z ? tapSum+10 : 10; tapSide=z;
    tap.textContent=(z==='back' ? '⏪ −' : '+')+tapSum+' s'+(z==='back' ? '' : ' ⏩'); tap.className='vp-tap on '+z;
    clearTimeout(tapT); tapT=setTimeout(()=>{ tap.className='vp-tap'; tapSum=0; tapSide=''; },700); });
  for(const ev of ['pointerdown','wheel','keydown','dblclick']) root.addEventListener(ev,e=>e.stopPropagation());
  root.addEventListener('keydown',e=>{
    if(e.target.tagName==='SELECT') return;
    const k=e.key;
    if(k===' '){ vpToggle(n); e.preventDefault(); }
    else if(k==='ArrowLeft'){ vpSeekBy(n,e.shiftKey ? -30 : -10); e.preventDefault(); }
    else if(k==='ArrowRight'){ vpSeekBy(n,e.shiftKey ? 30 : 10); e.preventDefault(); }
    else if(k==='f'||k==='F') vpFull(n);
    else if(k==='PageUp') vpStep(n,-1); else if(k==='PageDown') vpStep(n,1); });
  v.addEventListener('timeupdate',()=>{
    const now=performance.now();
    if(vpT(n)>0) n.lastPos=vpT(n);
    if(now-n.saveAt>VP_SAVE_MS && !v.paused){ n.saveAt=now; vpSave(n,false); }
    if(now-n.msAt>1000){ n.msAt=now; vpMediaPos(n); } });
  v.addEventListener('pause',()=>vpSave(n,true));
  v.addEventListener('seeked',()=>{ if(!drag) vpSave(n,true); });
  v.addEventListener('ended',()=>{ vpSave(n,true); n.ended=true; n.endPulse=1; if(n.p.advance && n.idx>=0 && n.idx+1<n.list.length) vpPick(n,n.idx+1,0); });
  v.addEventListener('error',()=>vpOnError(n));
  v.addEventListener('playing',()=>{ vpStatus(n,''); vpMedia(n); });
  v.addEventListener('waiting',()=>{ n.dirty=true; });
  n.hidePage=()=>vpSave(n,true);
  window.addEventListener('pagehide',n.hidePage);
  n.mid.append(root);
  n.ui={root,stage,msg,bPlay,seek,time,speed,src,q,aud,sub,drag:()=>drag,listKey:'',lvKey:'',trKey:''};
  applySize(n);
}
function vpDraw(n){
  const u=n.ui, v=n.v;
  const key=n.list.map(c=>c.url+c.name).join('\n')+'|'+n.idx+'|'+n.bump;
  if(key!==u.listKey){
    u.listKey=key; u.src.textContent='';
    const marks=vpLoadMap(); let grp=null, gname=null;
    n.list.forEach((c,i)=>{
      const g=vpGroup(c);
      if(g!==gname){ gname=g; if(g){ grp=vpEl('optgroup'); grp.label=g; u.src.append(grp); } else grp=null; }
      const o=vpEl('option',null,(g ? '' : (i+1)+'. ')+vpMark(marks[c.url])+vpLabel(c)); o.value=i; (grp||u.src).append(o); });
    if(!n.list.length){ const o=vpEl('option',null,'no sources — wire a Table (name, url) to «rows»'); o.value=-1; u.src.append(o); }
    u.src.value=n.idx<0 ? (n.list.length ? '0' : '-1') : String(n.idx);
    u.src.hidden=n.list.length<2 && !!n.list.length; }
  const tk=n.sid && n.stracks ? n.sid+'|'+n.sAudio+'|'+n.sSub : '';
  if(tk!==u.trKey){
    u.trKey=tk; const tr=n.sid && n.stracks;
    const fill=(sel,list,none,cur)=>{ sel.textContent=''; if(none!=null){ const o=vpEl('option',null,none); o.value=-1; sel.append(o); } list.forEach((t,k)=>{ const o=vpEl('option',null,vpTrackLabel(t,k)); o.value=t.i; sel.append(o); }); sel.value=String(cur); };
    u.aud.hidden=!(tr && tr.audio.length>1); u.sub.hidden=!(tr && tr.sub.length);
    if(tr){ fill(u.aud,tr.audio,null,n.sAudio>=0 ? n.sAudio : (tr.audio[0] ? tr.audio[0].i : 0)); fill(u.sub,tr.sub,'no subtitles',n.sSub); } }
  const lk=(n.levels||[]).join();
  if(lk!==u.lvKey){
    u.lvKey=lk; u.q.textContent='';
    if(n.levels && n.levels.length>1){ const a=vpEl('option',null,'auto'); a.value=-1; u.q.append(a); n.levels.forEach((l,i)=>{ const o=vpEl('option',null,l); o.value=i; u.q.append(o); }); }
    u.q.hidden=!(n.levels && n.levels.length>1); }
  const d=vpD(n), t=vpT(n);
  if(!u.drag()){
    u.seek.value=d>0 ? Math.round(t/d*1000) : 0;
    u.time.textContent=vpFmt(t)+' / '+(d>0 ? vpFmt(d) : (n.url ? 'live' : '0:00')); }
  const pl=n.url && (!v.paused && !v.ended) ? '⏸' : '▶';
  if(u.bPlay.textContent!==pl) u.bPlay.textContent=pl;
  const m=[n.status,n.torrent ? n.tline : '',n.warn].filter(Boolean).join('\n');
  if(u.msg.textContent!==m) u.msg.textContent=m;
  u.msg.hidden=!m;
}

def({ id:'vplayer', title:'Video Player', cat:'Sources', vidEl:true, resize:true, w:420, h:340, readout:false, always:true,
  kw:'video player movie film hls m3u8 mp4 webm sources list table seek rewind resume position continue watching history stream online',
  ins:[{n:'url',t:'txt'},{n:'rows',t:'bands'},{n:'channel',t:'val'},{n:'seek',t:'val'},{n:'next',t:'num'}],
  outs:[{n:'vid',t:'vid'},{n:'rec',t:'rec'},{n:'name',t:'txt'},{n:'time',t:'num'},{n:'dur',t:'num'},{n:'pct',t:'num'},{n:'playing',t:'num'},{n:'end',t:'num'}],
  params:[
    {n:'url',t:'text',d:'',label:'URL: a video file (mp4 / webm) or an HLS playlist (.m3u8); a list of sources comes on «rows»'},
    {n:'playb',t:'button',label:'Play',fn:n=>{ if(n.p.url) vpOpen(n,n.p.url,''); }},
    {n:'speed',t:'range',min:.25,max:3,step:.25,d:1,label:'speed'},
    {n:'engine',t:'select',opts:['auto','browser','vlc stream'],d:'auto',label:'who plays (always this player’s own <video>): auto — the browser, and in the DSP app libVLC repacks into a stream what the browser cannot open (smb:// ftp:// sftp:// nfs:// upnp:// rtmp:// udp:// rtp:// rtsp://, mkv / ts / avi) and what it failed to play; browser — never libVLC; vlc stream — any address through libVLC'},
    {n:'smode',t:'select',opts:['auto','remux','transcode'],d:'auto',label:'libVLC stream: auto — H.264 and AAC / MP3 pass as they are (cheap), the rest (DivX, MPEG-2, VP9, AC3, DTS…) is re-encoded to H.264 / AAC; remux — never re-encode; transcode — always'},
    {n:'skbps',t:'range',min:500,max:12000,step:100,d:2500,label:'libVLC stream: video bitrate when re-encoding, kbit/s'},
    {n:'swidth',t:'select',opts:['0','480','640','854','1280','1920'],d:'0',label:'libVLC stream: width when re-encoding, px (0 — as in the source)'},
    {n:'sdeint',t:'check',d:false,label:'libVLC stream: deinterlace (re-encodes the video)'},
    {n:'sburn',t:'check',d:true,label:'libVLC stream: burn the chosen subtitles into the picture (re-encodes the video)'},
    {n:'sadelay',t:'range',min:-2000,max:2000,step:50,d:0,label:'libVLC stream: audio delay, ms (applies on the next open / seek / track change)'},
    {n:'scaching',t:'range',min:100,max:5000,step:100,d:1000,label:'libVLC stream: network cache, ms'},
    {n:'bridge',t:'text',d:VP_BRIDGE,label:'torrents (magnet: links, .torrent files): bridge of the DSP app — ws://127.0.0.1:8765 or a device name (@phone); the app downloads the file as you watch'},
    {n:'tfile',t:'file',accept:'.torrent,application/x-bittorrent',label:'open a .torrent file (trackers with a login do not give it by a link)',fn:(n,f)=>vpOpenTorrentFile(n,f)},
    {n:'capture',t:'check',d:false,label:'allow picture capture for the floating window / PiP of the app (the server must send CORS headers — otherwise the video will not play); without it the window shows a note instead of the picture'},
    {n:'autoplay',t:'check',d:true,label:'start playing at once (the browser may require a click first)'},
    {n:'advance',t:'check',d:true,label:'at the end go on to the next source of the list'},
    {n:'contb',t:'button',label:'Continue watching',fn:n=>vpResumeList(n)},
    {n:'forget',t:'button',label:'Forget saved positions',fn:n=>{ LS.set(VP_KEY,'{}'); n.bump++; vpStatus(n,'saved positions cleared'); }}],
  init(n){ n.v=document.createElement('video'); n.list=[]; n.idx=-1; n.url=''; n.name=''; n.status=''; n.warn=''; n.levels=null; n.hls=null; n.gen=0;
    n.recQ=[]; n.tretry=0; n.torrentTried=false; n.playUrl=''; n.torrent=null; n.tline=''; n.tpoll=0; n.tbusy=false; n.tinfo=null; n.bgP=null; n.bgWs=null; n.lastPos=0; n.started=false; n.retry=0; n.tainted=false; n.msAt=0; n.alts=[]; n.altI=-1; n.from=0; n.fcv=null; n.bump=0; n.meta=null; n.savedPos=-9; n.saveAt=0; n.ended=false; n.endPulse=0; n.inUrl=''; n.inCh=''; n.inSeek=null; n.nxPrev=false; n.rowsKey=''; n.ui=null; n.dirty=true; n.sid=0; n.sbase=0; n.sdur=0; n.sAudio=-1; n.sSub=-1; n.stracks=null; n.splan=''; n.sTried=false; },
  dispose(n){ if(n.hidePage) window.removeEventListener('pagehide',n.hidePage); vpDestroy(n); vpBridgeDrop(n); },
  process(n,I){
    if(Array.isArray(I.rows)){
      const L=vpSources(I.rows), k=L.length+'|'+L.map(c=>c.url).join('\n');
      if(k!==n.rowsKey){ n.rowsKey=k; const cur=n.url ? L.findIndex(c=>c.url===n.url) : -1; n.list=L; n.idx=cur; n.dirty=true; } }
    if(typeof I.url==='string' && I.url && I.url!==n.inUrl){ n.inUrl=I.url; setMod(n,'url',I.url); n.idx=n.list.findIndex(c=>c.url===I.url); vpOpen(n,I.url,n.idx>=0 ? n.list[n.idx].name : '',undefined,n.idx>=0 ? n.list[n.idx] : null); }
    const cv=I.channel, ck= cv==null || cv==='' ? '' : String(cv);
    if(ck && ck!==n.inCh){
      n.inCh=ck;
      if(/^https?:\/\//i.test(ck)){ setMod(n,'url',ck); vpOpen(n,ck,''); }
      else{ const i=vpFind(n.list,cv); if(i>=0) vpPick(n,i); else vpStatus(n,'no source «'+ck+'» in the list'); }
    }else if(!ck) n.inCh='';
    if(I.seek!=null && I.seek!==n.inSeek && isFinite(+I.seek)){ n.inSeek=I.seek; if(n.url) vpGoto(n,Math.max(0,+I.seek)); }
    const nx=(I.next||0)>.5; if(nx && !n.nxPrev) vpStep(n,1); n.nxPrev=nx;
    const v=n.v, d=vpD(n), t=vpT(n);
    vpTorrentPoll(n);
    const rec=n.recQ.length ? n.recQ.splice(0) : null, end=n.endPulse; n.endPulse=0;
    return {vid:v.videoWidth ? v : null, rec, name:n.name, time:t, dur:d, pct:d>0 ? t/d*100 : 0, playing:n.url && (!v.paused && !v.ended) ? 1 : 0, end}; },
  draw(n){
    if(!n.ui || !n.ui.root.isConnected){ if(n.ui) n.ui.root.remove(); vpMount(n); }
    vpDraw(n); }
});
