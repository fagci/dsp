/* Возможности телефона: экран не гаснет при работе, звук в фоне с кнопками на экране блокировки,
   жест «назад» закрывает открытое, файлы из других приложений (Поделиться / Открыть в…) и «поделиться» наружу. */

// ---- экран не гаснет, пока граф запущен ----
const Awake={lock:null, want:false,
  enabled:()=>LS.get('dsp-awake')!=='0',
  async set(on){
    this.want=on;
    if(!('wakeLock' in navigator)) return;
    try{
      if(on && this.enabled() && !this.lock && document.visibilityState==='visible'){
        this.lock=await navigator.wakeLock.request('screen');
        this.lock.addEventListener('release',()=>{ this.lock=null; });
      } else if((!on || !this.enabled()) && this.lock){ await this.lock.release(); this.lock=null; }
    }catch(e){}
  }};
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible' && Awake.want) Awake.set(true); });

// ---- звук в фоне: беззвучный <audio> из графа даёт браузеру «медиа» — вкладку не усыпляют, на экране блокировки пауза / стоп ----
const BgAudio={ctx:null, el:null,
  set(on){
    const ms=navigator.mediaSession;
    if(!on){ try{ this.el?.pause(); }catch(e){} if(ms) ms.playbackState='paused'; return; }
    const ctx=Eng.ctx; if(!ctx || !ctx.createMediaStreamDestination) return;
    if(this.ctx!==ctx){
      try{ this.el?.pause(); }catch(e){}
      this.ctx=ctx; this.el=new Audio(); this.el.srcObject=ctx.createMediaStreamDestination().stream;
    }
    this.el.play().catch(()=>{});
    if(ms){
      try{ ms.metadata=new MediaMetadata({title:(typeof currentPatchName==='string' && currentPatchName) || 'DSP', artist:'DSP workbench'}); }catch(e){}
      ms.playbackState='playing';
      const toggle=()=>{ Eng.toggle?.(); };
      for(const a of ['play','pause','stop']) try{ ms.setActionHandler(a,toggle); }catch(e){}
    }
  }};
// вызывается при каждом запуске / паузе / остановке движка
function mobileOnRun(){
  const on=!!(Eng.running && !Eng.paused);
  Awake.set(on); BgAudio.set(on);
}

// ---- жест «назад»: открытое (шторка, развёрнутый тайл, настройки, выбор модуля) закрывается, а не уводит из приложения ----
const Back={stack:[], skip:0,
  push(close){ if(this.stack.includes(close)) return; this.stack.push(close); try{ history.pushState({dspBack:this.stack.length},''); }catch(e){} },
  drop(close){                                       // закрыто кнопкой на экране — убрать и запись истории
    const i=this.stack.indexOf(close); if(i<0) return;
    this.stack.splice(i,1); this.skip++; try{ history.back(); }catch(e){ this.skip--; } }};
addEventListener('popstate',()=>{
  if(Back.skip){ Back.skip--; return; }
  const c=Back.stack.pop(); if(c) c();
});

// ---- файлы снаружи: «Поделиться → DSP» и «Открыть в…» ----
// патч (JSON с nodes и edges) — загрузить; остальное (CSV, TSV, TXT, GPX, KML, GeoJSON, списки) — в Table
async function intakeFiles(files){
  files=[...files]; if(!files.length) return;
  let patch=null;
  const rest=[];
  for(const f of files){
    if(!patch && /\.json$/i.test(f.name)){
      try{ const o=JSON.parse((await f.text()).replace(/^﻿/,'')); if(o && Array.isArray(o.nodes) && Array.isArray(o.edges)){ patch=o; continue; } }catch(e){}
    }
    rest.push(f);
  }
  if(patch){ try{ stashIfDirty(); deserialize(patch); fitViewWhenReady(); graphDirty=false; showToast('patch loaded'); }catch(e){ alert('Could not read the patch: '+e.message); } }
  if(rest.length){
    let n=Graph.nodes.find(x=>x.type==='table') || addNodeUI('table',40,40);
    await tblImport(n,rest);
    showToast('imported: '+rest.map(f=>f.name).join(', '));
  }
}
// из сервис-воркера (share_target): файлы лежат в кэше dsp-share
async function takeSharedFiles(){
  if(!/[?&]share=done\b/.test(location.search) || !('caches' in window)) return;
  try{
    const c=await caches.open('dsp-share'), keys=await c.keys(), files=[];
    for(const k of keys){
      const r=await c.match(k); if(!r) continue;
      files.push(new File([await r.blob()],decodeURIComponent(r.headers.get('X-Name')||'shared'),{type:r.headers.get('Content-Type')||''}));
      await c.delete(k);
    }
    history.replaceState(null,'',location.pathname);
    await intakeFiles(files);
  }catch(e){ console.warn('share target:',e); }
}

// ---- поделиться наружу: системное меню «Поделиться», а там, где его нет, — обычное скачивание ----
async function shareFile(blob,name){
  const f=new File([blob],name,{type:blob.type});
  try{
    if(navigator.canShare && navigator.canShare({files:[f]})){ await navigator.share({files:[f],title:name}); return true; }
  }catch(e){ if(e.name==='AbortError') return true; }
  dl(blob,name); return false;
}

function mobileBoot(){
  takeSharedFiles();
  if('launchQueue' in window) launchQueue.setConsumer(async p=>{
    if(!p.files || !p.files.length) return;
    intakeFiles(await Promise.all(p.files.map(h=>h.getFile())));
  });
}
