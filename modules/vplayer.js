"use strict";
/* ============================ VIDEO PLAYER ============================
   Видеоплеер для списка источников (Table: name, url): файл (mp4 / webm / ogg) или HLS (.m3u8: в Safari сам, в остальных —
   vendor/hls.min.js, грузится при первом HLS). Перемотка (ползунок, ±10 с, клавиши ← →, вход seek), скорость, следующий /
   предыдущий источник. Серии: колонки series / season / episode (или S01E02, «3 серия» в названии) — список упорядочен и
   сгруппирован по сезонам, в конце серии играет следующая, ↻ продолжает с места, где остановились; метки ✓ / ▸N %. Позиция запоминается по адресу (localStorage dsp-vpos, последние 300) и при открытии того же адреса
   плеер продолжает с неё; запись {url,name,pos,dur,pct,done,t} уходит на rec — в Table с ключом url получается «история».
   Нативный плеер приложения Android (ExoPlayer, NativePlayer.kt): mkv / avi / ts, AC3 / DTS, udp:// и rtp:// multicast провайдера, rtsp://
   — на весь экран поверх страницы, состояние и позиция приходят в window.dspPlayer; страница управляет им теми же кнопками.
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

// записать позицию (в хранилище и в очередь rec); force — даже если почти не сдвинулась
function vpSave(n,force){
  const v=n.v, url=n.url; if(!v || !url) return;
  const pos=v.currentTime, dur=isFinite(v.duration) ? v.duration : 0;
  if(!(pos>0) || (!force && Math.abs(pos-n.savedPos)<1)) return;
  const m=vpLoadMap(), e=vpPut(m,url,pos,dur,n.name,Date.now(),300);
  if(!e) return;
  try{ LS.set(VP_KEY,JSON.stringify(m)); }catch(x){}
  n.savedPos=pos; n.bump++; n.recQ.push(vpRec(url,n.name,e,n.meta));
  if(n.recQ.length>200) n.recQ.splice(0,n.recQ.length-200);
}
function vpDestroy(n){
  vpSave(n,true);
  if(n.hls){ try{ n.hls.destroy(); }catch(e){} n.hls=null; }
  if(n.v){ try{ n.v.pause(); n.v.removeAttribute('src'); n.v.load(); }catch(e){} }
  n.gen=(n.gen||0)+1;
}
// открыть адрес; start — секунда (undefined — взять сохранённую)
async function vpOpen(n,url,name,start,meta){
  url=String(url||'').trim();
  if(!url){ return; }
  if(!VP_URL_RE.test(url)){ vpStatus(n,'URL must start with http:// or https:// (udp:// rtp:// rtsp:// — in the DSP app)'); return; }
  if(vpIsIaPage(url)){ vpOpenItem(n,vpIaId(url)); return; }          // страница archive.org/details/… — не видео: берём файлы предмета
  vpDestroy(n);
  const g=n.gen;
  n.tainted=false; n.retry=0; n.started=false; n.native=false; n.engineClosed=false;
  n.alts=String(meta && meta.alt || '').split(/\s+/).filter(Boolean); n.altI=-1;
  n.url=url; n.name=name || url; n.meta=meta||null; n.savedPos=-9; n.ended=false; n.pend=0;
  n.warn= typeof netInsecure==='function' && /^http:/i.test(url) && netInsecure(url) ? NET_INSECURE_MSG : '';
  const from= start!=null ? +start : vpResume(vpLoadMap()[url]);
  const v=n.v, kind=vpKind(url);
  // нативный плеер: по выбору «engine», или сам для того, что браузер не играет (udp / rtp / rtsp, mkv / ts / avi)
  const eng=String(n.p.engine||'auto');
  if(eng.startsWith('native') || (eng==='auto' && kind==='native')){
    if(vpNativeCan()){ vpOpenNative(n,url,from); return; }
    if(/^(udp|rtp|rtsp):/i.test(url)){ vpStatus(n,'udp:// rtp:// rtsp:// addresses (multicast IPTV) are played by the DSP app for Android — a browser cannot open them'); return; }
  }
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
      const h=n.hls=new Hls({startPosition:from>0 ? from : -1});
      h.on(Hls.Events.ERROR,(ev,d)=>{ if(g===n.gen && d.fatal) vpStatus(n,'HLS error: '+d.type+(d.details ? ' / '+d.details : '')+(d.type==='networkError' ? ' (CORS or the address is unreachable)' : '')); });
      h.on(Hls.Events.MANIFEST_PARSED,(ev,d)=>{ n.levels=d.levels.map(l=>l.height ? l.height+'p' : Math.round(l.bitrate/1000)+'k'); n.dirty=true; });
      h.loadSource(url); h.attachMedia(v);
    }else if(kind==='dash') throw new Error('DASH (.mpd) is not supported — use HLS or a file');
    else{ n.levels=null; v.src=url; }
    vpMedia(n);
    if(n.p.autoplay) await v.play();
  }catch(e){
    if(g===n.gen && e.name!=='NotSupportedError' && e.name!=='AbortError') vpStatus(n,e.name==='NotAllowedError' ? 'press ▶ to play (the browser blocks autoplay)' : 'error: '+e.message);
  }
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
  const code=v.error && v.error.code, pos=n.started ? (v.currentTime||n.lastPos||0) : n.from, at=n.started ? ' at '+vpFmt(pos) : '';
  if(n.started && n.retry<2){
    n.retry++; vpStatus(n,'playback error'+at+' ('+vpMediaErr(code)+') — retrying '+n.retry+'/2…');
    vpSetSrc(n,v.currentSrc||n.url,pos); return;
  }
  if(vpAlt(n,pos)) return;
  if(vpNativeCan() && String(n.p.engine||'auto')!=='browser'){ vpStatus(n,'the browser cannot play this ('+vpMediaErr(code)+') — opening the native player of the app…'); vpOpenNative(n,n.url,pos); return; }
  vpStatus(n,'error'+at+': '+vpMediaErr(code)+(v.error && v.error.message ? ' — '+v.error.message : '')+'\n'+n.url); }

/* ---------- нативный плеер приложения Android (DspApp.player*) ---------- */
let vpNativeNode=null, vpCan=null;
function vpNativeCan(){
  if(vpCan==null){ try{ vpCan=!!(window.DspApp && typeof DspApp.playerCan==='function' && DspApp.playerCan()); }catch(e){ vpCan=false; } }
  return vpCan; }
function vpOpenNative(n,url,from){
  vpDestroy(n); n.url=url; n.native=true; n.started=false; vpNativeNode=n;
  n.nat={pos:(from||0)*1000,dur:0,playing:false,live:false}; n.natSave=0;
  let ok=false; try{ ok=DspApp.playerOpen(JSON.stringify({url,pos:Math.round((from||0)*1000),autoplay:true,speed:+n.p.speed||1,title:n.name||''})); }catch(e){}
  if(!ok){ n.native=false; vpStatus(n,'the native player did not start'); return; }
  vpStatus(n,'playing in the native player (full screen) — ✕ or Back closes it; the controls here drive it too');
}
function vpNativeCmd(a,v){ try{ DspApp.playerCmd(JSON.stringify({a,v})); }catch(e){} }
// состояние от NativePlayer.kt: {t:'state', pos, dur (мс), playing, ended, live, err, closed, title}
window.dspPlayer=function(st){
  const n=vpNativeNode; if(!n || !n.native || !st) return;
  const nat=n.nat;
  if(st.pos!=null) nat.pos=+st.pos; if(st.dur!=null) nat.dur=+st.dur; nat.playing=!!st.playing; nat.live=!!st.live;
  const now=performance.now();
  if(nat.pos>0 && (st.closed || now-n.natSave>VP_SAVE_MS || st.ended)){
    n.natSave=now;
    const m=vpLoadMap(), e=vpPut(m,n.url,nat.pos/1000,nat.dur/1000,n.name,Date.now(),300);
    if(e){ try{ LS.set(VP_KEY,JSON.stringify(m)); }catch(x){} n.bump++; n.recQ.push(vpRec(n.url,n.name,e,n.meta)); }
  }
  if(st.err){ vpStatus(n,'native player: '+st.err); }
  if(st.ended){ n.endPulse=1; vpNativeCmd('close'); if(n.p.advance && n.idx>=0 && n.idx+1<n.list.length) vpPick(n,n.idx+1,0); return; }
  if(st.closed){ n.native=false; n.engineClosed=true; if(!st.err) vpStatus(n,'the native player is closed — ▶ opens it again from the saved position'); }
  n.dirty=true;
};
// Media Session: кнопки перемотки / дорожек в системном окне PiP, на экране блокировки и в наушниках
function vpMedia(n){
  if(!('mediaSession' in navigator)) return;
  try{
    const ms=navigator.mediaSession;
    ms.metadata=new MediaMetadata({title:n.name||'',artist:n.meta && n.meta.series || '',album:n.meta && n.meta.series ? vpGroup(n.meta) : ''});
    const h=(a,f)=>{ try{ ms.setActionHandler(a,f); }catch(e){} };
    h('play',()=>n.v.play()); h('pause',()=>n.v.pause());
    h('seekbackward',d=>vpSeekBy(n,-((d && d.seekOffset)||10))); h('seekforward',d=>vpSeekBy(n,(d && d.seekOffset)||10));
    h('seekto',d=>{ if(d && d.seekTime!=null) n.v.currentTime=d.seekTime; });
    h('previoustrack',n.list.length>1 ? ()=>vpStep(n,-1) : null); h('nexttrack',n.list.length>1 ? ()=>vpStep(n,1) : null);
  }catch(e){}
}
function vpMediaPos(n){
  try{ const v=n.v; if('mediaSession' in navigator && isFinite(v.duration) && v.duration>0) navigator.mediaSession.setPositionState({duration:v.duration,position:Math.min(v.currentTime,v.duration),playbackRate:v.playbackRate||1}); }catch(e){}
}
// текущий кадр на холсте — для плавающего окна и PiP приложения Android (там нет окна PiP у <video>); чужой сервер без CORS холст «пачкает» — тогда кадра нет
function vpFrame(n){
  const v=n.v, c=n.fcv || (n.fcv=document.createElement('canvas'));
  if(v && v.videoWidth && !n.native && !n.tainted) vpDrawFrame(n,c);
  if(!v || !v.videoWidth || n.native || n.tainted){                       // картинки нет — не пустое окно, а понятная заметка
    c.width=640; c.height=360; const x=c.getContext('2d');
    x.fillStyle='#000'; x.fillRect(0,0,640,360); x.fillStyle='#fff'; x.textAlign='center';
    x.font='bold 26px sans-serif'; x.fillText((n.name||'Video Player').slice(0,40),320,140);
    x.font='20px monospace'; const t=n.native && n.nat ? n.nat.pos/1000 : v && v.currentTime || 0, d=n.native && n.nat ? n.nat.dur/1000 : v && isFinite(v.duration) ? v.duration : 0;
    x.fillText(vpFmt(t)+(d>0 ? ' / '+vpFmt(d) : ''),320,185);
    x.font='15px sans-serif'; x.fillStyle='#bbb';
    const msg=n.native ? ['playing in the native player (full screen)'] : n.tainted ? ['no picture: the server does not allow frame capture (CORS).','Tick «allow picture capture» in the player settings,','use ⤢ fullscreen, ⧉ picture in picture or the native player.'] : ['no picture yet'];
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
  if(n.native){ vpNativeCmd('toggle'); return; }
  if(n.url && !n.v.getAttribute('src') && !n.hls && vpNativeCan() && n.engineClosed){ n.engineClosed=false; vpOpenNative(n,n.url,vpResume(vpLoadMap()[n.url])); return; }   // нативный плеер закрыт — снова с сохранённой позиции
  const v=n.v; if(v.paused || v.ended) v.play().catch(()=>{}); else v.pause(); }
function vpSeekBy(n,d){
  if(n.native){ vpNativeCmd('seekBy',d*1000); return; }
  const v=n.v; if(!v.src && !n.hls) return;
  const dur=isFinite(v.duration) ? v.duration : 0;
  let t=vpSeek(v.currentTime||0,d,dur);
  const sk=v.seekable;                                                   // сервер без Range: перемотать можно только в уже загруженное
  if(v.readyState>=1 && sk && sk.length && dur>0 && t>sk.end(sk.length-1)+1 && sk.end(sk.length-1)<dur-1){
    t=sk.end(sk.length-1); vpStatus(n,'the server does not support seeking (no Range): only the loaded part is available'); }
  v.currentTime=t; }
function vpSeekTo(n,frac){
  if(n.native){ if(n.nat && n.nat.dur>0) vpNativeCmd('seek',frac*n.nat.dur); return; }
  const v=n.v, d=v.duration; if(isFinite(d)){ v.currentTime=frac*d; vpSave(n,true); } }
function vpFull(n){ nodeFullscreen(n); }                     // общий для узлов: Fullscreen API на весь блок плеера с панелью управления

function vpMount(n){
  const root=vpEl('div','vp'); root.tabIndex=0;
  const stage=vpEl('div','vp-stage'), v=n.v;
  v.playsInline=true; v.preload='metadata'; v.controls=false;
  const msg=vpEl('div','vp-msg'); stage.append(v,msg);
  const bar=vpEl('div','vp-bar');
  const mk=(txt,title,fn)=>{ const b=vpEl('button','vp-b',txt); b.title=title; b.onclick=fn; return b; };
  const bPrev=mk('⏮','previous source',()=>vpStep(n,-1)), bBack=mk('−10','back 10 s',()=>vpSeekBy(n,-10));
  const bPlay=mk('▶','play / pause (Space)',()=>vpToggle(n));
  const bCont=mk('↻','continue watching: the last started source from its position',()=>vpResumeList(n));
  const bFwd=mk('+10','forward 10 s',()=>vpSeekBy(n,10)), bNext=mk('⏭','next source',()=>vpStep(n,1)), bFull=mk('⤢','fullscreen (F, double-click the picture)',()=>vpFull(n));
  const bNat=mk('📺','open this source in the native player of the app (mkv / ts / avi, AC3, hardware decoding)',()=>{ if(n.url) vpOpenNative(n,n.url,n.native ? (n.nat.pos/1000) : (n.v.currentTime||vpResume(vpLoadMap()[n.url]))); });
  bNat.hidden=!vpNativeCan();
  const seek=vpEl('input','vp-seek'); seek.type='range'; seek.min=0; seek.max=1000; seek.value=0;
  const time=vpEl('span','vp-time','0:00 / 0:00');
  const speed=vpEl('select','vp-speed');
  for(const s of [.5,.75,1,1.25,1.5,2]){ const o=vpEl('option',null,s+'×'); o.value=s; speed.append(o); }
  speed.value=String(+n.p.speed||1);
  const src=vpEl('select','vp-src'); src.title='source';
  const q=vpEl('select','vp-q'); q.title='quality'; q.hidden=true;
  bar.append(bCont,bPrev,bBack,bPlay,bFwd,bNext,seek,time,speed,q,bNat,bFull);
  root.append(stage,bar,src);
  let drag=false;
  seek.addEventListener('input',()=>{ drag=true; const d=n.native ? n.nat.dur/1000 : v.duration; if(isFinite(d) && d>0) time.textContent=vpFmt(seek.value/1000*d)+' / '+vpFmt(d); });
  seek.addEventListener('change',()=>{ drag=false; vpSeekTo(n,seek.value/1000); });
  speed.onchange=()=>{ v.playbackRate=+speed.value; if(n.native) vpNativeCmd('speed',+speed.value); setMod(n,'speed',+speed.value); };
  src.onchange=()=>vpPick(n,+src.value);
  q.onchange=()=>{ if(n.hls) n.hls.currentLevel=+q.value; };
  // клик — пауза (с задержкой: двойной клик — на весь экран, а не два переключения); события дальше узла не идут, иначе двойной клик сворачивает модуль
  let clickT=0;
  stage.addEventListener('click',e=>{ e.stopPropagation(); clearTimeout(clickT); clickT=setTimeout(()=>vpToggle(n),260); });
  stage.addEventListener('dblclick',e=>{ e.stopPropagation(); e.preventDefault(); clearTimeout(clickT); vpFull(n); });
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
    if(v.currentTime>0) n.lastPos=v.currentTime;
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
  n.ui={root,stage,msg,bPlay,seek,time,speed,src,q,drag:()=>drag,listKey:'',lvKey:''};
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
  const lk=(n.levels||[]).join();
  if(lk!==u.lvKey){
    u.lvKey=lk; u.q.textContent='';
    if(n.levels && n.levels.length>1){ const a=vpEl('option',null,'auto'); a.value=-1; u.q.append(a); n.levels.forEach((l,i)=>{ const o=vpEl('option',null,l); o.value=i; u.q.append(o); }); }
    u.q.hidden=!(n.levels && n.levels.length>1); }
  const nat=n.native && n.nat;
  const d=nat ? nat.dur/1000 : isFinite(v.duration) ? v.duration : 0, t=nat ? nat.pos/1000 : v.currentTime||0;
  if(!u.drag()){
    u.seek.value=d>0 ? Math.round(t/d*1000) : 0;
    u.time.textContent=vpFmt(t)+' / '+(d>0 ? vpFmt(d) : (n.url ? 'live' : '0:00')); }
  const pl=n.url && (nat ? nat.playing : !v.paused && !v.ended) ? '⏸' : '▶';
  if(u.bPlay.textContent!==pl) u.bPlay.textContent=pl;
  const m=(n.status||'')+(n.warn ? (n.status ? '\n' : '')+n.warn : '');
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
    {n:'engine',t:'select',opts:['auto','browser','native (app)'],d:'auto',label:'who plays: auto — the browser, and in the DSP app the native player for udp:// rtp:// rtsp:// and mkv / ts / avi (also when the browser cannot play a file); native — always the native player of the app (hardware decoders, AC3 / DTS)'},
    {n:'capture',t:'check',d:false,label:'allow picture capture for the floating window / PiP of the app (the server must send CORS headers — otherwise the video will not play); without it the window shows a note instead of the picture'},
    {n:'autoplay',t:'check',d:true,label:'start playing at once (the browser may require a click first)'},
    {n:'advance',t:'check',d:true,label:'at the end go on to the next source of the list'},
    {n:'contb',t:'button',label:'Continue watching',fn:n=>vpResumeList(n)},
    {n:'forget',t:'button',label:'Forget saved positions',fn:n=>{ LS.set(VP_KEY,'{}'); n.bump++; vpStatus(n,'saved positions cleared'); }}],
  init(n){ n.v=document.createElement('video'); n.list=[]; n.idx=-1; n.url=''; n.name=''; n.status=''; n.warn=''; n.levels=null; n.hls=null; n.gen=0;
    n.recQ=[]; n.lastPos=0; n.started=false; n.retry=0; n.tainted=false; n.native=false; n.nat=null; n.natSave=0; n.engineClosed=false; n.msAt=0; n.alts=[]; n.altI=-1; n.from=0; n.fcv=null; n.bump=0; n.meta=null; n.savedPos=-9; n.saveAt=0; n.ended=false; n.endPulse=0; n.inUrl=''; n.inCh=''; n.inSeek=null; n.nxPrev=false; n.rowsKey=''; n.ui=null; n.dirty=true; },
  dispose(n){ if(n.hidePage) window.removeEventListener('pagehide',n.hidePage); vpDestroy(n); },
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
    if(I.seek!=null && I.seek!==n.inSeek && isFinite(+I.seek)){ n.inSeek=I.seek; if(n.url) n.v.currentTime=Math.max(0,+I.seek); }
    const nx=(I.next||0)>.5; if(nx && !n.nxPrev) vpStep(n,1); n.nxPrev=nx;
    const v=n.v, nat=n.native && n.nat, d=nat ? nat.dur/1000 : isFinite(v.duration) ? v.duration : 0, t=nat ? nat.pos/1000 : v.currentTime||0;
    const rec=n.recQ.length ? n.recQ.splice(0) : null, end=n.endPulse; n.endPulse=0;
    return {vid:v.videoWidth ? v : null, rec, name:n.name, time:t, dur:d, pct:d>0 ? t/d*100 : 0, playing:n.url && (nat ? nat.playing : !v.paused && !v.ended) ? 1 : 0, end}; },
  draw(n){
    if(!n.ui || !n.ui.root.isConnected){ if(n.ui) n.ui.root.remove(); vpMount(n); }
    vpDraw(n); }
});
