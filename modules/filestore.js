"use strict";
/* ============================ Файловое хранилище и файловый менеджер ============================
   Одна база dsp-files: папки и файлы (Blob + имя + тип) по пространствам: audio — семплы (клипы Float32 в WAV, см. SampleDB),
   images — фото и картинки, files — всё остальное (в том числе принятое по сети). Старые базы dsp-samples и dsp-photos
   один раз переносятся сюда с теми же id (клипы и фото на них ссылаются из патчей и таблиц) и остаются как резерв.
   FileStore — данные; fmMount — общий интерфейс менеджера (хлебные крошки, папки, импорт, скачивание, перенос), его же берут узлы. */

const FS_SPACES=['audio','images','files'];
const FS_ROOT=0;                                       // корень снаружи — 0: null не попадает в индекс IndexedDB

const FileStore = (() => {
  let dbp=null;
  const reqP=r=>new Promise((res,rej)=>{ r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
  const doneP=tx=>new Promise((res,rej)=>{ tx.oncomplete=()=>res(); tx.onerror=tx.onabort=()=>rej(tx.error||new Error('transaction aborted')); });
  const listeners=new Set();
  const fire=space=>{ for(const f of listeners) try{ f(space); }catch(e){} };

  function open(){
    return dbp || (dbp=new Promise((res,rej)=>{
      const rq=indexedDB.open('dsp-files',1);
      rq.onupgradeneeded=()=>{
        const db=rq.result;
        db.createObjectStore('folders',{keyPath:'id',autoIncrement:true}).createIndex('sp_parent',['space','parentId']);
        db.createObjectStore('files',{keyPath:'id',autoIncrement:true}).createIndex('sp_folder',['space','folderId']);
        db.createObjectStore('meta');
      };
      rq.onsuccess=()=>res(rq.result);
      rq.onerror=()=>{ dbp=null; rej(rq.error); };
    }).then(async db=>{ await migrate(db,false); return db; }));
  }
  async function st(name,mode){ return (await open()).transaction(name,mode).objectStore(name); }

  // ---- перенос старых баз ----
  const openOld=name=>new Promise(res=>{
    if(typeof indexedDB==='undefined') return res(null);
    const rq=indexedDB.open(name);
    rq.onupgradeneeded=()=>rq.transaction.abort();
    rq.onsuccess=()=>res(rq.result); rq.onerror=()=>res(null); rq.onblocked=()=>res(null);
  });
  async function migrate(db,force){
    if(!force && await reqP(db.transaction('meta').objectStore('meta').get('legacy'))) return;
    const sm=await openOld('dsp-samples'), ph=await openOld('dsp-photos');
    const folders=sm && sm.objectStoreNames.contains('folders') ? await reqP(sm.transaction('folders').objectStore('folders').getAll()) : [];
    const clips=sm && sm.objectStoreNames.contains('clips') ? await reqP(sm.transaction('clips').objectStore('clips').getAll()) : [];
    const imgs=ph && ph.objectStoreNames.contains('img') ? await reqP(ph.transaction('img').objectStore('img').getAll()) : [];
    sm?.close(); ph?.close();
    const tx=db.transaction(['folders','files','meta'],'readwrite');
    const F=tx.objectStore('folders'), X=tx.objectStore('files');
    for(const f of folders) F.put({id:f.id,space:'audio',parentId:f.parentId||FS_ROOT,name:f.name,created:f.created||Date.now()});
    for(const c of clips){
      const {id,name,folderId,created,samples,sr,peaks,duration,...rest}=c;
      if(!samples) continue;
      X.put({id,space:'audio',folderId:folderId||FS_ROOT,name,mime:'audio/wav',blob:fsWavF32(samples,sr),size:samples.length*4+44,
        created:created||Date.now(),modified:created||Date.now(),meta:{fmt:'f32',sr,peaks,duration,...rest}});
    }
    for(const r of imgs){
      X.put({id:r.id,space:'images',folderId:FS_ROOT,name:r.name||r.id,mime:r.blob?.type||'image/jpeg',blob:r.blob,size:r.blob?.size||0,
        created:r.added||r.t||Date.now(),modified:r.added||r.t||Date.now(),meta:{w:r.w,h:r.h,t:r.t,exif:r.exif}});
    }
    tx.objectStore('meta').put(Date.now(),'legacy');
    await doneP(tx);
  }

  const key=v=>v==null ? FS_ROOT : v;
  return {
    reqP, doneP,
    onChange(f){ listeners.add(f); return ()=>listeners.delete(f); },
    async migrateLegacy(){ await migrate(await open(),true); fire(); },

    async addFolder(space,name,parentId=null){
      const id=await reqP((await st('folders','readwrite')).add({space,parentId:key(parentId),name,created:Date.now()}));
      fire(space); return id;
    },
    async renameFolder(id,name){
      const s=await st('folders','readwrite'), f=await reqP(s.get(id)); if(!f) return;
      f.name=name; await reqP(s.put(f)); fire(f.space);
    },
    async moveFolder(id,parentId){
      const s=await st('folders','readwrite'), f=await reqP(s.get(id)); if(!f) return;
      f.parentId=key(parentId); await reqP(s.put(f)); fire(f.space);
    },
    async deleteFolder(id){
      const f=await this.getFolder(id); if(!f) return;
      for(const sub of await this.listFolders(f.space,id)) await this.deleteFolder(sub.id);
      for(const x of await this.list(f.space,id)) await this.remove(x.id);
      await reqP((await st('folders','readwrite')).delete(id)); fire(f.space);
    },
    async listFolders(space,parentId=null){
      const a=await reqP((await st('folders','readonly')).index('sp_parent').getAll([space,key(parentId)]));
      return a.sort((x,y)=>x.name.localeCompare(y.name));
    },
    async allFolders(space){
      return reqP((await st('folders','readonly')).getAll()).then(a=>a.filter(f=>f.space===space));
    },
    async getFolder(id){ return id==null || id===FS_ROOT ? null : reqP((await st('folders','readonly')).get(id)); },
    async path(id){                                    // от корня до папки
      const out=[]; for(let f=await this.getFolder(id);f;f=await this.getFolder(f.parentId)) out.unshift(f);
      return out;
    },

    // rec: {space,folderId,name,mime,blob,meta[,id]}; без id номер выдаёт база
    async put(rec){
      const now=Date.now(), r={folderId:FS_ROOT,mime:rec.blob?.type||'application/octet-stream',meta:{},created:now,...rec};
      r.folderId=key(r.folderId); r.size=r.blob?.size||0; r.modified=now;
      if(r.id==null) delete r.id;
      const id=await reqP((await st('files','readwrite')).put(r)); fire(r.space); return id;
    },
    async get(id){ return reqP((await st('files','readonly')).get(id)); },
    async update(id,patch){
      const s=await st('files','readwrite'), r=await reqP(s.get(id)); if(!r) return;
      Object.assign(r,patch); if('folderId' in patch) r.folderId=key(r.folderId);
      if(patch.blob) r.size=patch.blob.size;
      r.modified=Date.now(); await reqP(s.put(r)); fire(r.space);
    },
    async remove(id){
      const r=await this.get(id); if(!r) return;
      await reqP((await st('files','readwrite')).delete(id)); fire(r.space);
    },
    async list(space,folderId=null){
      const a=await reqP((await st('files','readonly')).index('sp_folder').getAll([space,key(folderId)]));
      return a.sort((x,y)=>String(x.name).localeCompare(String(y.name)));
    },
    async usage(space){                                // {files, bytes}
      const a=await reqP((await st('files','readonly')).getAll());
      return a.filter(f=>f.space===space).reduce((u,f)=>({files:u.files+1,bytes:u.bytes+(f.size||0)}),{files:0,bytes:0});
    },
    // файл с диска / из сети в нужное пространство; audio — декодируется в клип (peaks, длительность), images — как есть
    async importFile(space,file,folderId=null,name){
      name=name||file.name||'file';
      if(space==='audio' && (file.type||'').startsWith('audio/') && typeof decodeAudioFile==='function' && typeof SampleDB!=='undefined'){
        const {samples,sr}=await decodeAudioFile(file);
        return SampleDB.addClip({name:name.replace(/\.[^.]+$/,''),folderId,sr,samples,peaks:SampleDB.computePeaks(samples),duration:samples.length/sr});
      }
      const meta={};
      if(space==='images'){ try{ const b=await createImageBitmap(file); meta.w=b.width; meta.h=b.height; b.close?.(); }catch(e){} }
      return this.put({space,folderId,name,mime:file.type||'application/octet-stream',blob:file,meta});
    },
  };
})();

// ---- WAV float32 mono: так лежат клипы библиотеки семплов ----
function fsWavF32(samples,sr){
  const n=samples.length, b=new ArrayBuffer(44+n*4), v=new DataView(b);
  const s=(o,t)=>{ for(let i=0;i<t.length;i++) v.setUint8(o+i,t.charCodeAt(i)); };
  s(0,'RIFF'); v.setUint32(4,36+n*4,true); s(8,'WAVEfmt '); v.setUint32(16,16,true); v.setUint16(20,3,true); v.setUint16(22,1,true);
  v.setUint32(24,sr,true); v.setUint32(28,sr*4,true); v.setUint16(32,4,true); v.setUint16(34,32,true); s(36,'data'); v.setUint32(40,n*4,true);
  new Float32Array(b,44,n).set(samples);
  return new Blob([b],{type:'audio/wav'});
}
async function fsWavDecode(blob){                      // только свой формат (44-байтный заголовок, float32 mono)
  const b=await blob.arrayBuffer(); return new Float32Array(b.slice(44));
}

/* ---- файловый менеджер ----
   fmMount(host,{space,onSelect(rec|null),onOpen(rec),openOnClick,onFolder(id|null),accept(rec)->bool,extra(rec,row),spaces:[...]})
   Возвращает {refresh(),setSpace(s),get space,get folder,get selected,destroy()}. */
const fmIcon=r=>{
  const m=r.mime||'';
  return m.startsWith('audio/') ? '♪' : m.startsWith('image/') ? '▣' : m.startsWith('video/') ? '▶' : m.startsWith('text/')||/json|xml/.test(m) ? '≡' : '·';
};
const fmSize=b=>b<1024 ? b+' B' : b<1048576 ? (b/1024).toFixed(1)+' KB' : (b/1048576).toFixed(1)+' MB';
const FM_EXT={'audio/wav':'wav','audio/mpeg':'mp3','audio/ogg':'ogg','image/jpeg':'jpg','image/png':'png','image/webp':'webp','text/plain':'txt','application/json':'json'};
function fmFileName(r){ const e=FM_EXT[r.mime]; return !e || /\.[A-Za-z0-9]{1,5}$/.test(r.name) ? r.name : r.name+'.'+e; }
function fmDownload(r){
  const a=document.createElement('a'), u=URL.createObjectURL(r.blob);
  a.href=u; a.download=fmFileName(r); document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(u),10000);
}
function fmPeaks(cv,peaks){
  const c=cv.getContext('2d'), w=cv.width, h=cv.height; c.clearRect(0,0,w,h);
  if(!peaks) return;
  c.fillStyle=getComputedStyle(cv).color||'#4ec9b0';
  const N=peaks.length/2;
  for(let x=0;x<w;x++){ const i=Math.min(N-1,Math.floor(x*N/w)), lo=peaks[i*2], hi=peaks[i*2+1];
    const y0=h/2-hi*h/2, y1=h/2-lo*h/2; c.fillRect(x,y0,1,Math.max(1,y1-y0)); }
}
// выбор папки из дерева пространства: Promise<id|null (корень)|undefined (отмена)>
async function fmPickFolder(space,excludeId){
  const all=await FileStore.allFolders(space), byParent=new Map();
  for(const f of all){ const a=byParent.get(f.parentId)||[]; a.push(f); byParent.set(f.parentId,a); }
  const rows=[{id:null,label:'/ (root)'}];
  const walk=(pid,pre)=>{ for(const f of (byParent.get(pid)||[]).sort((a,b)=>a.name.localeCompare(b.name))){
    if(f.id===excludeId) continue; rows.push({id:f.id,label:pre+f.name}); walk(f.id,pre+f.name+' / '); } };
  walk(FS_ROOT,'/ ');
  return new Promise(res=>{
    const ov=document.createElement('div'); ov.className='fm-ov';
    const box=document.createElement('div'); box.className='fm-pick';
    const t=document.createElement('b'); t.textContent='Move to…'; box.append(t);
    for(const r of rows){ const b=document.createElement('button'); b.textContent=r.label; b.onclick=()=>{ ov.remove(); res(r.id); }; box.append(b); }
    const c=document.createElement('button'); c.textContent='Cancel'; c.onclick=()=>{ ov.remove(); res(undefined); }; box.append(c);
    ov.onclick=e=>{ if(e.target===ov){ ov.remove(); res(undefined); } };
    ov.append(box); document.body.append(ov);
  });
}

function fmMount(host,o={}){
  const spaces=o.spaces||FS_SPACES;
  const S={space:o.space||spaces[0],folder:null,selected:null,urls:[],gen:0,dead:false};
  const root=document.createElement('div'); root.className='fm';
  const bar=document.createElement('div'); bar.className='fm-bar';
  const tabs=document.createElement('div'); tabs.className='fm-tabs';
  const crumbs=document.createElement('div'); crumbs.className='fm-crumbs';
  const list=document.createElement('div'); list.className='fm-list';
  const info=document.createElement('div'); info.className='fm-info';
  const mk=(t,title,fn)=>{ const b=document.createElement('button'); b.textContent=t; b.title=title; b.onclick=fn; return b; };
  const inp=document.createElement('input'); inp.type='file'; inp.multiple=true; inp.hidden=true;
  bar.append(
    mk('＋ folder','New folder',async()=>{ const n=prompt('Folder name:'); if(n) await FileStore.addFolder(S.space,n,S.folder); }),
    mk('⤒ import','Add files from this device',()=>inp.click()),
    inp);
  inp.onchange=async()=>{ const fs=[...inp.files]; inp.value=''; await addFiles(fs); };
  root.append(...(spaces.length>1 ? [tabs] : []),bar,crumbs,list,info);
  root.addEventListener('pointerdown',e=>e.stopPropagation());
  root.addEventListener('wheel',e=>e.stopPropagation());
  root.addEventListener('dragover',e=>{ e.preventDefault(); });
  root.addEventListener('drop',async e=>{ e.preventDefault(); if(e.dataTransfer.files?.length) await addFiles([...e.dataTransfer.files]); });
  host.append(root);

  async function addFiles(fs){
    for(const f of fs){
      try{ await FileStore.importFile(S.space,f,S.folder); }
      catch(e){ alert('Could not add '+f.name+': '+e.message); }
    }
  }
  function select(rec){ S.selected=rec; o.onSelect?.(rec); [...list.children].forEach(r=>r.classList.toggle('sel',!!rec && r._rec===rec.id)); }
  function drawTabs(){
    tabs.textContent='';
    for(const sp of spaces){ const b=document.createElement('button'); b.textContent=sp; b.className=sp===S.space ? 'on' : ''; b.onclick=()=>setSpace(sp); tabs.append(b); }
  }
  async function refresh(){
    const g=++S.gen;
    const [folders,files,path,use]=await Promise.all([FileStore.listFolders(S.space,S.folder),FileStore.list(S.space,S.folder),FileStore.path(S.folder),FileStore.usage(S.space)]);
    if(S.dead || g!==S.gen) return;
    o.onFolder?.(S.folder);
    for(const u of S.urls) URL.revokeObjectURL(u); S.urls=[];
    drawTabs();
    crumbs.textContent='';
    const seg=(t,id)=>{ const b=document.createElement('button'); b.textContent=t; b.onclick=()=>{ S.folder=id; select(null); refresh(); }; crumbs.append(b); };
    seg('/',null); for(const f of path){ crumbs.append(' › '); seg(f.name,f.id); }
    list.textContent='';
    for(const f of folders){
      const row=document.createElement('div'); row.className='fm-row fm-dir';
      const nm=document.createElement('span'); nm.className='fm-name'; nm.textContent='📁 '+f.name;
      row.append(nm,
        mk('✎','Rename',async e=>{ e.stopPropagation(); const n=prompt('New name:',f.name); if(n) await FileStore.renameFolder(f.id,n); }),
        mk('⇢','Move',async e=>{ e.stopPropagation(); const t=await fmPickFolder(S.space,f.id); if(t!==undefined && t!==f.id) await FileStore.moveFolder(f.id,t); }),
        mk('✕','Delete folder with contents',async e=>{ e.stopPropagation(); if(confirm('Delete folder "'+f.name+'" and everything in it?')) await FileStore.deleteFolder(f.id); }));
      row.onclick=()=>{ S.folder=f.id; select(null); refresh(); };
      row.ondragover=e=>{ e.preventDefault(); row.classList.add('over'); };
      row.ondragleave=()=>row.classList.remove('over');
      row.ondrop=async e=>{ e.preventDefault(); e.stopPropagation(); row.classList.remove('over'); if(fmDrag!=null) await FileStore.update(fmDrag,{folderId:f.id}); };
      list.append(row);
    }
    for(const r of files){
      if(o.accept && !o.accept(r)) continue;
      const row=document.createElement('div'); row.className='fm-row'; row._rec=r.id; row.draggable=true;
      row.classList.toggle('sel',S.selected?.id===r.id);
      const th=document.createElement('span'); th.className='fm-th';
      if(r.mime?.startsWith('image/') && r.blob){ const u=URL.createObjectURL(r.blob); S.urls.push(u); const im=document.createElement('img'); im.src=u; im.loading='lazy'; th.append(im); }
      else if(r.meta?.peaks){ const cv=document.createElement('canvas'); cv.width=36; cv.height=18; fmPeaks(cv,r.meta.peaks); th.append(cv); }
      else th.textContent=fmIcon(r);
      const nm=document.createElement('span'); nm.className='fm-name'; nm.textContent=r.name; nm.title=fmFileName(r);
      const sz=document.createElement('span'); sz.className='fm-size'; sz.textContent=r.meta?.duration!=null ? fmtDur(r.meta.duration) : fmSize(r.size||0);
      row.append(th,nm,sz);
      o.extra?.(r,row);
      row.append(
        mk('✎','Rename',async e=>{ e.stopPropagation(); const n=prompt('New name:',r.name); if(n) await FileStore.update(r.id,{name:n}); }),
        mk('⇢','Move',async e=>{ e.stopPropagation(); const t=await fmPickFolder(S.space); if(t!==undefined) await FileStore.update(r.id,{folderId:t}); }),
        mk('⤓','Download',e=>{ e.stopPropagation(); fmDownload(r); }),
        mk('✕','Delete',async e=>{ e.stopPropagation(); if(confirm('Delete "'+r.name+'"?')){ if(S.selected?.id===r.id) select(null); await FileStore.remove(r.id); } }));
      row.onclick=()=>{ select(r); if(o.openOnClick) o.onOpen?.(r); };
      row.ondblclick=()=>{ if(!o.openOnClick) o.onOpen?.(r); };
      row.ondragstart=e=>{ fmDrag=r.id; e.dataTransfer.setData('text/plain',r.name); };
      row.ondragend=()=>{ fmDrag=null; };
      list.append(row);
    }
    if(!list.children.length){ const e=document.createElement('div'); e.className='fm-empty'; e.textContent='empty — import files or drop them here'; list.append(e); }
    info.textContent=use.files+' file'+(use.files===1 ? '' : 's')+' · '+fmSize(use.bytes)+' in '+S.space;
  }
  function setSpace(sp){ if(!spaces.includes(sp)) return; S.space=sp; S.folder=null; select(null); refresh(); }
  const off=FileStore.onChange(sp=>{ if(!root.isConnected){ off(); S.dead=true; return; } if(!sp || sp===S.space) refresh(); });
  refresh();
  return { root, refresh, setSpace, get space(){ return S.space; }, get folder(){ return S.folder; }, get selected(){ return S.selected; },
    destroy(){ S.dead=true; off(); for(const u of S.urls) URL.revokeObjectURL(u); root.remove(); } };
}
let fmDrag=null;

/* ---- узел: файловый менеджер ---- */
def({ id:'files', title:'Files', cat:'Output', kw:'file manager storage samples images folder browser upload download', w:340, h:360, resize:true,
  ins:[], outs:[{n:'id',t:'num'},{n:'name',t:'txt'},{n:'size',t:'num'},{n:'send',t:'num'},{n:'bin',t:'bin'}],
  params:[{n:'sendBtn',t:'button',label:'Send selected → (pulse on `send`)',fn:n=>{ if(n.sel && typeof n.sel.id==='number') n.pend=n.sel.id; }},
    {n:'space',t:'select',opts:FS_SPACES,d:'files',label:'storage',fn:n=>{ n.fm?.setSpace(n.p.space); }}],
  init:n=>{ n.fm=null; n.sel=null; n.pend=-1; n.binOut=null; n.binKey=''; },
  dispose:n=>{ n.fm?.destroy(); n.fm=null; },
  process(n){ const send=n.pend; n.pend=-1;     // импульс: id на один блок, потом -1
    const r=n.sel, key=r && typeof r.id==='number' ? r.id+'|'+r.modified : '';
    if(key!==n.binKey){                           // байты выбранного файла подгружаются при смене выбора (до 64 МБ)
      n.binKey=key; n.binOut=null;
      if(r && r.blob && r.blob.size<=67108864) r.blob.arrayBuffer().then(a=>{ if(n.binKey===key) n.binOut=binObj(new Uint8Array(a),fmFileName(r),r.mime); });
    }
    return {id:r && typeof r.id==='number' ? r.id : -1, name:r?.name||'', size:r?.size||0, send, bin:n.binOut}; },
  draw(n){
    if(n.fm && n.mid.contains(n.fm.root)) return;
    n.fm?.destroy();
    n.fm=fmMount(n.mid,{space:n.p.space,onSelect:r=>{ n.sel=r; }});
  }
});
