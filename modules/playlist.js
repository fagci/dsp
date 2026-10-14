"use strict";
/* ============================ PLAYLIST ============================
   Отдельный узел-плейлист: список дорожек, который хранится в патче, и общий набор помощников (иконки, импорт, выбор из библиотеки)
   для плееров. Дорожка — файл общего файлового хранилища (FileStore: тот же, что в Files и Sample Library; файлы с диска
   кладутся в папку Music пространства files) либо URL (поток, интернет-радио).
   Узел сам ничего не играет: на выходах текущая дорожка (fs / url / name) и импульс go — «запусти её» (1) или «загрузи» (0.5),
   плюс следующая дорожка (nfs / nurl) для предзагрузки. Плеер отвечает импульсами next / prev / end / req и сигналом playing.
   Наполнение: файлы с диска, перетаскивание (в том числе из Files), библиотека, провода (add ← Files send, url + name и rows
   ← Internet Radio). Порядок и повтор (shuffle / repeat) — ядро modules/player-kernels.js. */

const WA_EXT=/\.(mp3|ogg|oga|opus|wav|flac|m4a|aac|weba|webm)$/i;
const WA_MIME={mp3:'audio/mpeg',ogg:'audio/ogg',oga:'audio/ogg',opus:'audio/ogg',wav:'audio/wav',flac:'audio/flac',m4a:'audio/mp4',aac:'audio/aac',weba:'audio/webm',webm:'audio/webm'};
const WA_ICO={
  prev:'<path d="M7 6v12"/><path d="M19 6l-9 6 9 6z"/>', next:'<path d="M17 6v12"/><path d="M5 6l9 6-9 6z"/>',
  play:'<path d="M7 5l12 7-12 7z"/>', pause:'<path d="M8 5v14M16 5v14"/>', stop:'<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  eject:'<path d="M12 5l7 9H5z"/><path d="M5 19h14"/>',
  shuf:'<path d="M3 7h3c5 0 5 10 10 10h4"/><path d="M3 17h3c1.7 0 2.9-1 3.8-2.3M14 9.3C14.9 8 16.2 7 18 7h2"/><path d="M17 4l3 3-3 3M17 14l3 3-3 3"/>',
  rep:'<path d="M17 3l3 3-3 3"/><path d="M4 11V9a3 3 0 013-3h13"/><path d="M7 21l-3-3 3-3"/><path d="M20 13v2a3 3 0 01-3 3H4"/>',
  rep1:'<path d="M17 3l3 3-3 3"/><path d="M4 11V9a3 3 0 013-3h13"/><path d="M7 21l-3-3 3-3"/><path d="M20 13v2a3 3 0 01-3 3H4"/><path d="M11 10l1.5-1v6"/>',
  vol:'<path d="M4 10v4h4l5 4V6l-5 4z"/><path d="M16.5 9a4 4 0 010 6"/>',
  bal:'<path d="M12 4v16M6 20h12M5 7h14"/><path d="M7 7l-3 6h6zM17 7l-3 6h6z"/>',
  lib:'<path d="M3 7a1 1 0 011-1h5l2 2h8a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1z"/>',
  url:'<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  radio:'<circle cx="12" cy="12" r="2"/><path d="M7.8 7.8a6 6 0 000 8.4M16.2 7.8a6 6 0 010 8.4M4.9 4.9a10 10 0 000 14.2M19.1 4.9a10 10 0 010 14.2"/>',
  clr:'<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  file:'<path d="M12 5v14M5 12h14"/>'};
const waSvg=k=>'<svg class="i" viewBox="0 0 24 24" aria-hidden="true">'+WA_ICO[k]+'</svg>';
const waEl=(tag,cls,text)=>{ const e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e; };
const waSet=(el,t)=>{ if(el.textContent!==t) el.textContent=t; };
const waIsAudio=r=>(r.mime||r.type||'').startsWith('audio/') || WA_EXT.test(r.name||'');
const waTitle=t=>!t ? '' : t.url ? (t.name||t.url) : wpName(t.tag,t.name);

// длительность файла без декодирования: метаданные через <audio>
function waProbe(blob){
  return new Promise(res=>{
    const a=new Audio(), u=URL.createObjectURL(blob), done=v=>{ URL.revokeObjectURL(u); a.src=''; res(v); };
    a.preload='metadata'; a.onloadedmetadata=()=>done(isFinite(a.duration)?a.duration:0); a.onerror=()=>done(0);
    setTimeout(()=>done(0),5000); a.src=u; });
}
// имя, теги, размер и длительность записи хранилища; ошибка — файла там нет
async function waMeta(t){
  if(t.fs==null) return;
  try{
    const r=await FileStore.get(t.fs);
    if(!r){ t.err='missing in the library'; return; }
    t.name=r.name; t.err=''; t.size=r.size||0;
    if(r.meta?.tag) t.tag=r.meta.tag;
    else if(r.blob && r.mime!=='audio/wav' && r.size>128){
      const head=new Uint8Array(await r.blob.slice(0,524288).arrayBuffer());
      let tag=wpId3(head);
      if(!tag.title) tag=wpId3(new Uint8Array(await r.blob.slice(r.blob.size-128).arrayBuffer()));
      t.tag=tag; }
    t.dur=r.meta?.duration || (r.blob ? await waProbe(r.blob) : 0);
  }catch(e){}
}
async function waMusicFolder(space){
  const f=(await FileStore.listFolders(space,null)).find(x=>x.name==='Music');
  return f ? f.id : FileStore.addFolder(space,'Music',null);
}
// файлы с диска → хранилище (files/Music как есть, либо audio — моно-клипы библиотеки семплов); → массив id
async function waImportFiles(files,store){
  const ids=[];
  for(const f of files){
    if(!waIsAudio(f)) continue;
    try{
      if(store==='audio'){ ids.push(await FileStore.importFile('audio',f,await waMusicFolder('audio'))); continue; }
      const ext=(f.name.match(/\.(\w+)$/)||[])[1]?.toLowerCase();
      let tag=null;
      try{ tag=wpId3(new Uint8Array(await f.slice(0,524288).arrayBuffer()));
        if(!tag.title && f.size>=128) tag=wpId3(new Uint8Array(await f.slice(f.size-128).arrayBuffer())); }catch(e){}
      ids.push(await FileStore.put({space:'files',folderId:await waMusicFolder('files'),name:f.name,
        mime:f.type||WA_MIME[ext]||'audio/mpeg',blob:f,meta:{tag}}));
    }catch(e){ alert('Could not add '+f.name+': '+e.message); }
  }
  return ids;
}
// выбор в файловом менеджере: onPick(ids) — выбранный файл, двойной клик или вся папка
function waPickFiles(onPick){
  const ov=waEl('div','fm-ov'), box=waEl('div','wa-pick');
  const host=waEl('div','wa-pick-fm'), bar=waEl('div','wa-row');
  const mk=(t,fn)=>{ const b=waEl('button','',t); b.onclick=fn; bar.append(b); return b; };
  let fm=null;
  const close=()=>ov.remove();
  mk('＋ selected',()=>{ const r=fm.selected; if(r && waIsAudio(r)) onPick([r.id]); });
  mk('＋ all in this folder',async()=>{ onPick((await FileStore.list(fm.space,fm.folder)).filter(waIsAudio).map(r=>r.id)); });
  mk('close',close);
  box.append(host,bar); ov.append(box); document.body.append(ov);
  ov.onclick=e=>{ if(e.target===ov) close(); };
  fm=fmMount(host,{spaces:['files','audio'],space:'files',accept:waIsAudio,onOpen:r=>onPick([r.id])});
}

/* ---------- узел ---------- */
const plKey=t=>!t ? '' : t.url ? 'u:'+t.url : 'f:'+t.fs;
function plSave(n){
  n.p.list=JSON.stringify(n.list.map(t=>t.url ? {url:t.url,name:t.name||''} : {fs:t.fs,name:t.name||''}));
  n.p.cur=n.cur; }
function plOrder(n){ n.order=wpOrder(n.list.length,n.p.shuffle,n.cur); }
function plLoad(n){
  let a=[]; try{ a=JSON.parse(n.p.list||'[]'); }catch(e){}
  n.list=a.filter(x=>x&&(x.url||x.fs!=null)).map(x=>({fs:x.url?null:x.fs, url:x.url||'', name:x.name||'', tag:null, dur:0, size:0, err:''}));
  n.cur=n.list.length ? Math.min(Math.max(+n.p.cur|0,0),n.list.length-1) : -1;
  plOrder(n);
  for(const t of n.list) waMeta(t).then(()=>{ n.dirty=true; });
}
function plPush(n,t){
  n.list.push(t); waMeta(t).then(()=>{ n.dirty=true; });
  if(n.cur<0) n.cur=0;
  plOrder(n); plSave(n); n.dirty=true;
  return n.list.length-1;
}
const plAddIds=(n,ids)=>{ for(const id of ids) if(typeof id==='number' && id>=0) plPush(n,{fs:id,url:'',name:'',tag:null,dur:0,size:0,err:''}); };
// go: 1 — сразу играть, .5 — только выбрать, 0 — тихо (без импульса)
function plSelect(n,i,go){
  if(i<0||i>=n.list.length) return;
  n.cur=i; n.goV=go; n.dirty=true; plSave(n); }
function plAddUrl(n,url,name,play){
  url=String(url||'').trim(); if(!url) return;
  let i=n.list.findIndex(t=>t.url===url);
  if(i<0) i=plPush(n,{fs:null,url,name:String(name||'').trim(),tag:null,dur:0,size:0,err:''});
  if(play) plSelect(n,i,1);
}
function plRows(n){
  let k=0;
  for(const r of n.rowsIn||[]){ if(r && typeof r.url==='string' && r.url){ plAddUrl(n,r.url,r.label||r.name||'',false); k++; } }
  if(!k && !Eng.running) alert('The graph is not running: press ▶ Run — wires carry data only while it runs');
  else if(!k) alert(n.rowsIn ? 'The rows wire carries '+n.rowsIn.length+' rows, none has a url field' :
    'Nothing has arrived on the rows wire yet (wire Internet Radio → stations and press Search; the graph must be running)');
}
function plStep(n,dir,auto){ return wpStep(n.order,n.cur,dir,n.p.repeat,auto); }
function plClear(n){ n.list=[]; n.cur=-1; plOrder(n); plSave(n); n.dirty=true; }
function plRemove(n,i){
  n.list.splice(i,1);
  if(i<n.cur) n.cur--; else if(i===n.cur) n.cur=Math.min(i,n.list.length-1);
  plOrder(n); plSave(n); n.dirty=true; }
function plMove(n,from,to){
  if(from===to||from<0||to<0||from>=n.list.length||to>=n.list.length) return;
  const cur=n.list[n.cur], [t]=n.list.splice(from,1); n.list.splice(to,0,t);
  n.cur=n.list.indexOf(cur); plOrder(n); plSave(n); n.dirty=true; }

function plMount(n){
  const root=waEl('div','pl'); root.tabIndex=0;
  const B=(a,t)=>'<button data-a="'+a+'" title="'+t+'">'+waSvg(a)+'</button>';
  const T=(a,t,l)=>'<button data-a="'+a+'" title="'+t+'">'+waSvg(a)+'<span>'+l+'</span></button>';
  root.innerHTML=
   '<div class="wa-row pl-head">'+B('shuf','shuffle')+B('rep','repeat: off / all / one')+'<span class="wa-cnt" data-f="cnt"></span></div>'+
   '<div class="wa-pl" data-f="pl"></div>'+
   '<div class="wa-row wa-foot">'+T('file','add files from this device (kept in the library)','files')+T('lib','pick from the file manager (Files / Sample Library)','library')+T('url','stream or file URL','URL')+
     T('radio','add stations from the rows wire (url field)','stations')+T('clr','clear the playlist','clear')+
     '<select data-f="store" title="files from disk go to: the Music folder of Files (as is) or the Sample Library (mono clips)"><option value="files">→ Files</option><option value="audio">→ Samples</option></select></div>';
  const f={}; for(const e of root.querySelectorAll('[data-f]')) f[e.dataset.f]=e;
  const inp=waEl('input'); inp.type='file'; inp.multiple=true; inp.accept='audio/*'; inp.hidden=true; root.append(inp);
  const add=async fs=>plAddIds(n,await waImportFiles(fs,n.p.store));
  const act={
    shuf:()=>{ n.p.shuffle=!n.p.shuffle; plOrder(n); n.dirty=true; },
    rep:()=>{ const o=['off','all','one']; n.p.repeat=o[(o.indexOf(n.p.repeat)+1)%3]; n.dirty=true; },
    file:()=>inp.click(), lib:()=>waPickFiles(ids=>plAddIds(n,ids)), radio:()=>plRows(n), clr:()=>plClear(n),
    url:()=>{ const u=prompt('Audio URL: a stream or a file (the server must send CORS headers)'); if(u&&u.trim()) plAddUrl(n,u,'',false); }};
  root.addEventListener('click',e=>{
    const b=e.target.closest('button[data-a]'); if(b){ act[b.dataset.a](); return; }
    const it=e.target.closest('.wa-it'); if(!it) return;
    const i=+it.dataset.i;
    if(e.target.closest('.x')) plRemove(n,i); else plSelect(n,i,1); });
  inp.addEventListener('change',()=>{ add([...inp.files]); inp.value=''; });
  f.store.addEventListener('change',()=>{ n.p.store=f.store.value; });
  root.addEventListener('keydown',e=>{ e.stopPropagation(); });
  root.addEventListener('pointerdown',e=>e.stopPropagation());
  root.addEventListener('wheel',e=>e.stopPropagation());
  let from=-1;
  f.pl.addEventListener('dragstart',e=>{ const it=e.target.closest('.wa-it'); from=it?+it.dataset.i:-1; });
  root.addEventListener('dragover',e=>{ e.preventDefault(); });
  root.addEventListener('drop',e=>{
    e.preventDefault();
    const dt=e.dataTransfer, id=dt?.getData('application/x-dsp-file');          // файл из Files / Sample Library
    if(from>=0){ const it=e.target.closest('.wa-it'); plMove(n,from,it?+it.dataset.i:n.list.length-1); from=-1; return; }
    if(id){ plAddIds(n,[+id]); return; }
    if(dt?.files?.length) add([...dt.files]); });
  n.mid.append(root);
  n.ui={root,f,btn:{},key:''};
  for(const b of root.querySelectorAll('button[data-a]')) n.ui.btn[b.dataset.a]=b;
  n.dirty=true;
}
function plRender(n){
  const {f,btn}=n.ui;
  btn.shuf.classList.toggle('on',!!n.p.shuffle);
  const rp=n.p.repeat; btn.rep.classList.toggle('on',rp!=='off');
  if(btn.rep._r!==rp){ btn.rep._r=rp; btn.rep.innerHTML=waSvg(rp==='one'?'rep1':'rep'); btn.rep.title='repeat: '+rp; }
  if(f.store.value!==n.p.store) f.store.value=n.p.store;
  waSet(f.cnt,n.list.length+' · '+wpTime(n.list.reduce((a,t)=>a+(t.dur||0),0)));
  const key=n.cur+'|'+n.list.map(t=>plKey(t)+(t.dur|0)+(t.err?'!':'')+(t.tag?.title||'')+t.name).join(',');
  if(key===n.ui.key) return;
  n.ui.key=key; n.dirty=false;
  const keep=f.pl.scrollTop; f.pl.textContent='';
  n.list.forEach((t,i)=>{
    const it=waEl('div','wa-it'+(i===n.cur?' cur':'')+(t.err?' bad':'')); it.dataset.i=i; it.draggable=true;
    if(t.err) it.title=t.err;
    it.append(waEl('span','n',(i+1)+'.'),waEl('span','t',(t.url?'📻 ':'')+waTitle(t)),waEl('span','d',t.dur?wpTime(t.dur):''),waEl('button','x','×'));
    f.pl.append(it); });
  f.pl.scrollTop=keep;
  f.pl.querySelector('.cur')?.scrollIntoView({block:'nearest'});
}

def({ id:'playlist', title:'Playlist', cat:'Music', resize:true, w:340, h:300, readout:false,
  kw:'playlist tracks queue winamp music files library radio stations shuffle repeat next previous',
  ins:[{n:'next',t:'num'},{n:'prev',t:'num'},{n:'end',t:'num'},{n:'req',t:'num'},{n:'playing',t:'num'},
       {n:'add',t:'num'},{n:'url',t:'txt'},{n:'name',t:'txt'},{n:'rows',t:'bands'},{n:'set',t:'txt'}],
  outs:[{n:'fs',t:'num'},{n:'url',t:'txt'},{n:'name',t:'txt'},{n:'go',t:'num'},
        {n:'nfs',t:'num'},{n:'nurl',t:'txt'},{n:'index',t:'num'},{n:'count',t:'num'}],
  params:[{n:'shuffle',t:'check',d:false,label:'shuffle',hidden:true,fn:n=>{ plOrder(n); n.dirty=true; }},
          {n:'repeat',t:'select',opts:['off','all','one'],d:'off',label:'repeat',hidden:true,fn:n=>{ n.dirty=true; }},
          {n:'store',t:'select',opts:['files','audio'],d:'files',label:'files from disk go to: files (Music folder, as is) / audio (Sample Library clips, mono)',hidden:true},
          {n:'wirePlay',t:'check',d:true,label:'play a station that arrives on the url wire',hidden:true},
          {n:'list',t:'text',d:'[]',hidden:true},
          {n:'cur',t:'range',min:-1,max:100000,step:1,d:-1,hidden:true}],
  init:n=>{ n.list=[]; n.order=[]; n.cur=-1; n.goV=0; n.dirty=true; n.ui=null; n.edge={}; n.lastUrl=''; n.lastSet=''; n.addPrev=-1; n.rowsIn=null; n.playing=false;
    plLoad(n); },
  dispose:n=>{ n.list=[]; },
  process(n,I){
    if(typeof I.set==='string' && I.set && I.set!==n.lastSet){                           // Media Library: заменить список
      n.lastSet=I.set;
      const a=mlParse(I.set);
      n.list=a.map(x=>({fs:x.url?null:x.fs,url:x.url||'',name:x.name,tag:null,dur:0,size:0,err:''}));
      n.cur=n.list.length?0:-1; plOrder(n); plSave(n); n.dirty=true;
      for(const t of n.list) waMeta(t).then(()=>{ n.dirty=true; });
      if(n.cur>=0) n.goV=.5; }
    const pulse=(k,fn)=>{ const v=typeof I[k]==='number' && I[k]>=.5; if(v && !n.edge[k]) fn(); n.edge[k]=v; };
    n.playing=typeof I.playing==='number' && I.playing>=.5;
    const go=n.playing?1:.5;
    pulse('next',()=>{ const j=plStep(n,1,false); if(j>=0) plSelect(n,j,go); });
    pulse('prev',()=>{ const j=plStep(n,-1,false); if(j>=0) plSelect(n,j,go); });
    pulse('end',()=>{ const j=plStep(n,1,true); if(j>=0) plSelect(n,j,1); });          // трек доигран: плеер уже мог перейти на следующий сам
    pulse('req',()=>{ if(n.cur<0 && n.list.length) n.cur=0; if(n.cur>=0) plSelect(n,n.cur,1); });
    if(typeof I.add==='number'){ if(I.add>=0 && I.add!==n.addPrev) plAddIds(n,[I.add]); n.addPrev=I.add; }   // Files → send
    if(typeof I.url==='string' && I.url && I.url!==n.lastUrl){ n.lastUrl=I.url; plAddUrl(n,I.url,typeof I.name==='string'?I.name:'',n.p.wirePlay); }
    n.rowsIn=Array.isArray(I.rows) ? I.rows : n.rowsIn;
    const t=n.list[n.cur], nx=n.list[plStep(n,1,true)];
    const g=n.goV; n.goV=0;
    return {fs:t&&!t.url?t.fs:-1, url:t?.url||'', name:waTitle(t), go:g,
            nfs:nx&&!nx.url?nx.fs:-1, nurl:nx?.url||'', index:n.cur+1, count:n.list.length}; },
  draw(n){
    if(!n.ui || !n.ui.root.isConnected) plMount(n);
    plRender(n); }
});
