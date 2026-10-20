"use strict";
/* ============================ Файловое хранилище и файловый менеджер ============================
   Одна база dsp-files: папки и файлы (Blob + имя + тип) по пространствам: audio — семплы (клипы Float32 в WAV, см. SampleDB),
   images — фото и картинки, files — всё остальное (в том числе принятое по сети). Старые базы dsp-samples и dsp-photos
   один раз переносятся сюда с теми же id (клипы и фото на них ссылаются из патчей и таблиц) и остаются как резерв.
   FileStore — данные; fmMount — общий интерфейс менеджера (хлебные крошки, папки, импорт, скачивание, перенос), его же берут узлы. */

const FS_SPACES=['audio','images','files'];
const FM_SPACES=['files','audio','images','tables'];    // первый — корень, остальные лежат в нём системными папками; tables — списки Table (ListDB), см. TableStore
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
    notify:fire,
    notifyLater(space){                                // сбивает частые правки (поток записей в Table) в одно обновление
      clearTimeout(this._nt); this._nt=setTimeout(()=>fire(space),400);
    },
    async getMeta(k){ return reqP((await st('meta','readonly')).get(k)); },
    async setMeta(k,v){ await reqP((await st('meta','readwrite')).put(v,k)); },
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
    // opts.keepTime — оставить rec.modified (приём из синхронизации); uid — метка записи для синхронизации устройств
    async put(rec,opts){
      const now=Date.now(), r={folderId:FS_ROOT,mime:rec.blob?.type||'application/octet-stream',meta:{},created:now,uid:syUid(),...rec};
      r.folderId=key(r.folderId); r.size=r.blob?.size||0; r.modified=opts?.keepTime ? rec.modified : now;
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
    async stamp(id,patch){                              // служебная правка без смены времени и без уведомлений
      const s=await st('files','readwrite'), r=await reqP(s.get(id)); if(r){ Object.assign(r,patch); await reqP(s.put(r)); }
    },
    async remove(id){
      const r=await this.get(id); if(!r) return;
      await syncNoteDel('f',r);
      await reqP((await st('files','readwrite')).delete(id)); fire(r.space);
    },
    async list(space,folderId=null){
      const a=await reqP((await st('files','readonly')).index('sp_folder').getAll([space,key(folderId)]));
      return a.sort((x,y)=>String(x.name).localeCompare(String(y.name)));
    },
    async listAll(space){ return (await reqP((await st('files','readonly')).getAll())).filter(f=>f.space===space); },
    async copy(id,folderId=null){                      // копия файла; в той же папке — с пометкой в имени
      const r=await this.get(id); if(!r) return;
      const {id:_,uid:__,...rest}=r, same=key(folderId)===r.folderId;
      return this.put({...rest,folderId,name:same ? r.name+' copy' : r.name,created:Date.now()});
    },
    async copyFolder(id,parentId=null){                // папка со всем содержимым; возвращает id копии
      const f=await this.getFolder(id); if(!f) return;
      const same=key(parentId)===f.parentId, nid=await this.addFolder(f.space,same ? f.name+' copy' : f.name,parentId);
      for(const sub of await this.listFolders(f.space,id)) await this.copyFolder(sub.id,nid);
      for(const x of await this.list(f.space,id)) await this.copy(x.id,nid);
      return nid;
    },
    // снимок для отмены удаления: папки (с содержимым) и файлы как есть; возвращает функцию возврата
    async snapshot({d=[],f=[]}){
      const dirs=[], files=new Map();
      const walk=async id=>{ const fo=await this.getFolder(id); if(!fo) return; dirs.push(fo);
        for(const sub of await this.listFolders(fo.space,id)) await walk(sub.id);
        for(const x of await this.list(fo.space,id)) files.set(x.id,x); };
      for(const id of d) await walk(id);
      for(const id of f){ const r=await this.get(id); if(r) files.set(id,r); }
      const space=(dirs[0]||[...files.values()][0])?.space;
      return async()=>{
        const db=await open(), tx=db.transaction(['folders','files'],'readwrite');
        for(const x of dirs) tx.objectStore('folders').put(x);
        for(const x of files.values()) tx.objectStore('files').put({...x,modified:Date.now()});    // позже метки удаления: синхронизация не удалит снова
        await doneP(tx); fire(space);
      };
    },
    async usage(space){                                // {files, bytes}
      return (await this.listAll(space)).reduce((u,f)=>({files:u.files+1,bytes:u.bytes+(f.size||0)}),{files:0,bytes:0});
    },
    async quota(){                                     // {usage, quota, free, persisted} браузера; null, если оценки нет
      if(!navigator.storage?.estimate) return null;
      try{
        const e=await navigator.storage.estimate(), quota=e.quota||0, usage=e.usage||0;
        return {usage,quota,free:Math.max(0,quota-usage),persisted:navigator.storage.persisted ? await navigator.storage.persisted() : false};
      }catch(err){ return null; }
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

/* ---- таблицы Table как пространство 'tables' ----
   Списки лежат в ListDB под именем «папка/имя»; папки — префиксы имён (пустые держим в meta). id списка и папки — строка-путь,
   корень — null/0. Интерфейс тот же, что у FileStore, поэтому менеджер работает с обоими одинаково. */
const TableStore = (() => {
  const FKEY='tblFolders';
  const fid=v=>v==null || v===FS_ROOT ? '' : v;
  const dirOf=n=>n.includes('/') ? n.slice(0,n.lastIndexOf('/')) : '';
  const leafOf=n=>n.slice(n.lastIndexOf('/')+1);
  const join=(d,n)=>d ? d+'/'+n : n;
  const hidden=n=>n==='@patch' || n.startsWith('presets/');
  let cache=null;
  async function sum(){
    if(!cache || cache.rev!==ListDB.rev){ const m=await ListDB.summary(); for(const k of [...m.keys()]) if(hidden(k)) m.delete(k); cache={rev:ListDB.rev,m}; }
    return cache.m;
  }
  const saved=async()=>(await FileStore.getMeta(FKEY))||[];
  const setSaved=async a=>{ await FileStore.setMeta(FKEY,[...new Set(a)].sort()); FileStore.notify('tables'); };
  const rec=(name,e)=>({id:name,space:'tables',name:leafOf(name),folderId:dirOf(name)||FS_ROOT,mime:'text/csv',size:e.bytes,
    created:e.created,modified:e.modified,meta:{rows:e.rows},getBlob:async()=>(await tblListFile(name)).blob});
  const okName=n=>{ if(!n || /[\/\\]/.test(n) || n.startsWith('@')) throw new Error('bad name: '+n); };
  async function allDirs(){
    const set=new Set(await saved());
    for(const n of (await sum()).keys()) for(let d=dirOf(n);d;d=dirOf(d)) set.add(d);
    for(const d of [...set]) for(let p=dirOf(d);p;p=dirOf(p)) set.add(p);
    return [...set].filter(d=>d!=='presets' && !d.startsWith('presets/'));
  }
  async function uniq(name){
    const have=new Set(await ListDB.listNames()); if(!have.has(name)) return name;
    for(let i=1;;i++){ const c=name+(i===1 ? ' copy' : ' copy '+i); if(!have.has(c)) return c; }
  }
  async function free(name){ if((await ListDB.listNames()).includes(name)) throw new Error('"'+name+'" already exists'); }
  async function renamePrefix(from,to){
    if(from===to) return;
    if(to.startsWith(from+'/')) throw new Error('cannot move a folder into itself');
    const names=[...(await sum()).keys()].filter(n=>n.startsWith(from+'/'));
    for(const n of names) await free(to+n.slice(from.length));
    for(const n of names){ await ListDB.renameList(n,to+n.slice(from.length)); await tcRenameTarget(n,to+n.slice(from.length)); }
    await setSaved((await saved()).map(d=>d===from ? to : d.startsWith(from+'/') ? to+d.slice(from.length) : d));
  }
  const folderRec=d=>({id:d,space:'tables',name:leafOf(d),parentId:dirOf(d)||FS_ROOT,created:0});
  return {
    async allFolders(){ return (await allDirs()).map(folderRec); },
    async listFolders(space,parentId=null){
      const p=fid(parentId);
      return (await allDirs()).filter(d=>dirOf(d)===p).map(folderRec).sort((x,y)=>x.name.localeCompare(y.name));
    },
    async getFolder(id){ return id==null || id===FS_ROOT ? null : folderRec(id); },
    async path(id){ const out=[]; for(let d=fid(id);d;d=dirOf(d)) out.unshift(folderRec(d)); return out; },
    async list(space,folderId=null){
      const p=fid(folderId);
      return [...(await sum())].filter(([n])=>dirOf(n)===p).map(([n,e])=>rec(n,e)).sort((x,y)=>x.name.localeCompare(y.name));
    },
    async listAll(){ return [...(await sum())].map(([n,e])=>rec(n,e)); },
    async get(id){ const e=(await sum()).get(id); return e ? rec(id,e) : undefined; },
    async usage(){ const m=await sum(); let bytes=0; for(const e of m.values()) bytes+=e.bytes; return {files:m.size,bytes}; },
    async addFolder(space,name,parentId=null){
      okName(name); if(!parentId && name==='presets') throw new Error('"presets" is reserved');
      const d=join(fid(parentId),name); await setSaved([...await saved(),d]); return d;
    },
    async renameFolder(id,name){ okName(name); await renamePrefix(id,join(dirOf(id),name)); },
    async moveFolder(id,parentId){ await renamePrefix(id,join(fid(parentId),leafOf(id))); },
    async deleteFolder(id){
      for(const n of (await sum()).keys()) if(n.startsWith(id+'/')) await ListDB.deleteList(n);
      await setSaved((await saved()).filter(d=>d!==id && !d.startsWith(id+'/')));
    },
    async update(id,patch){
      const name='name' in patch ? patch.name : leafOf(id); okName(name);
      const to=join('folderId' in patch ? fid(patch.folderId) : dirOf(id),name);
      if(to===id) return;
      if(to.startsWith('presets/')) throw new Error('"presets/" is reserved for built-in lists');
      await free(to); await ListDB.renameList(id,to); await tcRenameTarget(id,to);
    },
    async remove(id){ await ListDB.deleteList(id); },
    async copy(id,folderId=null){
      const {cols,rows}=await tblReadList(null,id), to=await uniq(join(fid(folderId),leafOf(id))), m=await ListDB.getMeta(id);
      await tblPut(to,cols,rows,{...(m?.types ? {types:m.types} : {}),...(m?.card ? {card:m.card} : {})}); return to;
    },
    async copyFolder(id,parentId=null){
      const base=join(fid(parentId),leafOf(id)), dirs=new Set(await allDirs());
      let to=base;
      for(let i=1;dirs.has(to);i++) to=base+(i===1 ? ' copy' : ' copy '+i);
      await setSaved([...await saved(),to]);
      for(const [n] of await sum()) if(n.startsWith(id+'/')) await this.copy(n,dirOf(to+n.slice(id.length)));
      return to;
    },
    async importFile(space,file,folderId=null){
      const p=fid(folderId); return tblImportFile(file,p ? p+'/' : '');
    },
    async snapshot({d=[],f=[]}){
      const names=new Set(f), dirs=new Set((await allDirs()).filter(x=>d.some(y=>x===y || x.startsWith(y+'/'))));
      for(const x of d) dirs.add(x);
      for(const n of (await sum()).keys()) if(d.some(y=>n.startsWith(y+'/'))) names.add(n);
      const lists=[];
      for(const n of names){ const {cols,rows}=await tblReadList(null,n), m=await ListDB.getMeta(n);
        lists.push({n,cols,rows,extra:{...(m?.types ? {types:m.types} : {}),...(m?.card ? {card:m.card} : {})}}); }
      return async()=>{
        if(dirs.size) await setSaved([...await saved(),...dirs]);
        for(const l of lists) await tblPut(l.n,l.cols,l.rows,l.extra);
        FileStore.notify('tables');
      };
    },
  };
})();

/* ---- файловый менеджер ----
   fmMount(host,{space,onSelect(rec|null),onOpen(rec),openOnClick,onFolder(id|null),accept(rec)->bool,extra(rec,row),spaces:[...]})
   Возвращает {refresh(),setSpace(s),get space,get folder,get selected,picked()->Promise<rec[]>,destroy()}.
   Первое из spaces — корень («/»), остальные в нём системные папки; свои папки создаются где угодно. Действия — одна панель над
   отмеченным (клик — одна строка, Ctrl / Shift / ☑ — несколько): переименовать, перенести, копировать, скачать, удалить.
   Поиск по имени (в текущем хранилище), сортировка. */
const fmBE=sp=>sp==='tables' ? TableStore : FileStore;
const fmIcon=r=>{
  const m=r.mime||'';
  return r.space==='tables' ? '▦' : m.startsWith('audio/') ? '♪' : m.startsWith('image/') ? '▣' : m.startsWith('video/') ? '▶' : m.startsWith('text/')||/json|xml/.test(m) ? '≡' : '·';
};
const fmSize=b=>b<1024 ? b+' B' : b<1048576 ? (b/1024).toFixed(1)+' KB' : (b/1048576).toFixed(1)+' MB';
const FM_EXT={'audio/wav':'wav','audio/mpeg':'mp3','audio/ogg':'ogg','image/jpeg':'jpg','image/png':'png','image/webp':'webp','text/plain':'txt','application/json':'json','text/csv':'csv'};
const FM_HAS_EXT=/\.(wav|mp3|ogg|oga|opus|flac|m4a|aac|webm|mp4|mov|jpe?g|png|webp|gif|txt|json|csv|bin)$/i;   // «rec 21.39.46» — не расширение
function fmFileName(r){ const e=FM_EXT[r.mime]; return !e || FM_HAS_EXT.test(r.name) ? r.name : r.name+'.'+e; }
const fmBlob=async r=>r.getBlob ? r.getBlob() : r.blob;
async function fmDownload(r){
  const a=document.createElement('a'), u=URL.createObjectURL(await fmBlob(r));
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
// выбор папки из дерева пространства: Promise<id|null (корень)|undefined (отмена)>; exclude — id папок, их поддеревья не предлагаются
async function fmPickFolder(space,exclude,title){
  const ex=new Set(exclude==null ? [] : Array.isArray(exclude) ? exclude : [exclude]);
  const all=await fmBE(space).allFolders(space), byParent=new Map();
  for(const f of all){ const a=byParent.get(f.parentId)||[]; a.push(f); byParent.set(f.parentId,a); }
  const rows=[{id:null,label:space==='files' ? '/ (root)' : '/ '+space}];
  const walk=(pid,pre)=>{ for(const f of (byParent.get(pid)||[]).sort((a,b)=>a.name.localeCompare(b.name))){
    if(ex.has(f.id)) continue; rows.push({id:f.id,label:pre+f.name}); walk(f.id,pre+f.name+' / '); } };
  walk(FS_ROOT,'/ ');
  return new Promise(res=>{
    const ov=document.createElement('div'); ov.className='fm-ov';
    const box=document.createElement('div'); box.className='fm-pick';
    const t=document.createElement('b'); t.textContent=title||'Move to…'; box.append(t);
    for(const r of rows){ const b=document.createElement('button'); b.textContent=r.label; b.onclick=()=>{ ov.remove(); res(r.id); }; box.append(b); }
    const c=document.createElement('button'); c.textContent='Cancel'; c.onclick=()=>{ ov.remove(); res(undefined); }; box.append(c);
    ov.onclick=e=>{ if(e.target===ov){ ov.remove(); res(undefined); } };
    ov.append(box); document.body.append(ov);
  });
}

// короткое сообщение внизу host с отменой; host должен быть position:relative
function dspToast(host,text,undo){
  const t=document.createElement('div'); t.className='dsp-toast'; t.append(text+' ');
  const kill=()=>{ clearTimeout(tm); t.remove(); }, tm=setTimeout(kill,7000);
  if(undo){ const b=document.createElement('button'); b.textContent='Undo'; b.onclick=async()=>{ kill(); try{ await undo(); }catch(e){ alert(e.message||String(e)); } }; t.append(b); }
  host.querySelectorAll(':scope > .dsp-toast').forEach(x=>x.remove());
  host.append(t);
}

const FM_SORT={name:(a,b)=>String(a.name).localeCompare(String(b.name),undefined,{numeric:true}),
  size:(a,b)=>(a.size||0)-(b.size||0), date:(a,b)=>(a.modified||0)-(b.modified||0),
  type:(a,b)=>String(a.mime).localeCompare(String(b.mime))||FM_SORT.name(a,b)};

function fmMount(host,o={}){
  const spaces=o.spaces||FM_SPACES, home=spaces[0];
  const S={space:o.space||home,folder:null,selected:null,urls:[],pu:[],gen:0,pg:0,dead:false,sort:'name',desc:false,q:'',multi:false,marks:new Set(),anchor:null,persisted:false};
  const root=document.createElement('div'); root.className='fm';
  const bar=document.createElement('div'); bar.className='fm-bar';
  const find=document.createElement('div'); find.className='fm-bar';
  const crumbs=document.createElement('div'); crumbs.className='fm-crumbs';
  const bulk=document.createElement('div'); bulk.className='fm-bar';
  const list=document.createElement('div'); list.className='fm-list';
  const info=document.createElement('div'); info.className='fm-info';
  const disk=document.createElement('div'); disk.className='fm-disk';
  const meter=document.createElement('div'); meter.className='fm-meter'; const fill=document.createElement('i'); meter.append(fill);
  const diskTx=document.createElement('span'); disk.append(meter,diskTx);
  const mk=(t,title,fn)=>{ const b=document.createElement('button'); b.textContent=t; b.title=title; b.onclick=fn; return b; };
  const guard=fn=>async(...a)=>{ try{ return await fn(...a); }catch(e){ if(e.message!=='') alert(e.message||String(e)); } };
  const B=()=>fmBE(S.space);
  const idOf=v=>S.space==='tables' ? v : +v;
  const inp=document.createElement('input'); inp.type='file'; inp.multiple=true; inp.hidden=true;
  const search=document.createElement('input'); search.type='search'; search.placeholder='search…'; search.className='fm-q';
  search.oninput=()=>{ S.q=search.value.trim().toLowerCase(); refresh(); };
  const sortSel=document.createElement('select'); sortSel.title='Sort by';
  for(const [k,d,t] of [['name',0,'name ↑'],['name',1,'name ↓'],['date',1,'newest'],['date',0,'oldest'],['size',1,'largest'],['size',0,'smallest'],['type',0,'type']]){
    const op=document.createElement('option'); op.value=k+':'+d; op.textContent=t; sortSel.append(op); }
  sortSel.onchange=()=>{ const [k,d]=sortSel.value.split(':'); S.sort=k; S.desc=d==='1'; refresh(); };
  find.append(search,sortSel);
  bar.append(
    mk('＋ folder','New folder here',guard(async()=>{ const n=prompt('Folder name:'); if(n) await B().addFolder(S.space,n,S.folder); })),
    mk('⤒ import','Add files from this device',()=>inp.click()),
    inp);
  o.toolbar?.(bar);
  inp.onchange=async()=>{ const fs=[...inp.files]; inp.value=''; await addFiles(fs); };
  const prev=document.createElement('div'); prev.className='fm-prev'; prev.hidden=true;
  root.append(bar,find,crumbs,bulk,list,...(o.preview ? [prev] : []),info,disk);
  root.addEventListener('pointerdown',e=>e.stopPropagation());
  root.addEventListener('wheel',e=>e.stopPropagation());
  root.addEventListener('dragover',e=>{ e.preventDefault(); });
  root.addEventListener('drop',async e=>{ e.preventDefault(); if(e.dataTransfer.files?.length) await addFiles([...e.dataTransfer.files]); });
  host.append(root);

  async function addFiles(fs){
    const q=await FileStore.quota();
    for(const f of fs){
      if(q && f.size>q.free){ alert('Not enough space for '+f.name+': needs '+fmSize(f.size)+', free '+fmSize(q.free)); continue; }
      try{ await B().importFile(S.space,f,S.folder); }
      catch(e){ alert('Could not add '+f.name+': '+e.message); }
    }
    if(!S.persisted){ S.persisted=true; try{ navigator.storage?.persist?.(); }catch(e){} }       // браузер не вытеснит хранилище
  }
  function go(space,folder){
    S.space=space; S.folder=folder; S.marks.clear(); S.anchor=null; search.value=S.q=''; select(null); refresh();
  }
  // отметки: 'f:id' — файл, 'd:id' — папка; клик отмечает одну строку, долгое нажатие / правая кнопка / Ctrl / Shift — режим выделения нескольких
  const paintMarks=()=>[...list.children].forEach(r=>{ r.classList.toggle('mark',S.marks.has(r._mk)); const c=r.querySelector('input'); if(c) c.checked=S.marks.has(r._mk); });
  function pickRow(k,e){
    const keys=[...list.children].map(r=>r._mk).filter(Boolean);
    if(e?.shiftKey && S.anchor && keys.includes(S.anchor)){
      const i=keys.indexOf(S.anchor), j=keys.indexOf(k);
      for(const x of keys.slice(Math.min(i,j),Math.max(i,j)+1)) S.marks.add(x);
    }else{ S.marks.has(k) ? S.marks.delete(k) : S.marks.add(k); S.anchor=k; }
    S.multi=S.marks.size>0; refreshSel(); drawBulk(); paintMarks();
  }
  // режим выделения виден флажками в строках
  function refreshSel(){ [...list.children].forEach(r=>{ const c=r.querySelector('input'); if(r._mk && !!c!==S.multi){ if(c) c.remove(); else addChk(r); } }); }
  function addChk(row){ const c=document.createElement('input'); c.type='checkbox'; c.checked=S.marks.has(row._mk); c.onclick=e=>{ e.stopPropagation(); pickRow(row._mk,e); }; row.prepend(c); }
  // долгое нажатие и правая кнопка отмечают строку (папку — без открытия)
  function arm(row,k,after){
    let tm=0, fired=false;
    const stop=()=>clearTimeout(tm);
    row.addEventListener('pointerdown',e=>{ if(e.button) return; fired=false; stop(); tm=setTimeout(()=>{ fired=true; pickRow(k); after?.(); },450); });
    for(const ev of ['pointerup','pointerleave','pointercancel']) row.addEventListener(ev,stop);
    row.addEventListener('contextmenu',e=>{ e.preventDefault(); pickRow(k); after?.(); });
    row.addEventListener('click',e=>{ if(fired){ fired=false; e.stopImmediatePropagation(); } },true);
  }
  const several=e=>S.multi || !!(e && (e.ctrlKey || e.metaKey || e.shiftKey));
  const picked=()=>{ const f=[],d=[]; for(const k of S.marks) (k[0]==='f' ? f : d).push(idOf(k.slice(2))); return {f,d}; };
  function drawBulk(){
    bulk.textContent='';
    const n=S.marks.size;
    bulk.hidden=!n;
    if(!n) return;
    const act=(t,title,ok,fn)=>{ const b=mk(t,title,guard(async()=>{ await fn(picked()); S.marks.clear(); S.multi=false; drawBulk(); refreshSel(); })); b.disabled=!ok(picked()); return b; };
    const lbl=document.createElement('span'); lbl.className='fm-info'; lbl.textContent=n+' selected';
    bulk.append(lbl,
      mk('all','Select everything shown',()=>{ for(const r of list.children) if(r._mk) S.marks.add(r._mk); S.multi=true; refreshSel(); drawBulk(); paintMarks(); }),
      mk('none','Clear selection',()=>{ S.marks.clear(); S.multi=false; refreshSel(); drawBulk(); paintMarks(); }));
    bulk.append(
      act('✎','Rename',s=>s.f.length+s.d.length===1,async s=>{
        if(s.d.length){ const f=await B().getFolder(s.d[0]), nm=prompt('New name:',f.name); if(nm) await B().renameFolder(f.id,nm); }
        else{ const r=await B().get(s.f[0]), nm=prompt('New name:',r.name); if(nm) await B().update(r.id,{name:nm}); } }),
      act('⇢','Move',()=>true,async s=>{ const t=await fmPickFolder(S.space,s.d,'Move to…'); if(t===undefined) throw new Error('');
        for(const d of s.d) await B().moveFolder(d,t); for(const f of s.f) await B().update(f,{folderId:t}); }),
      act('⧉','Copy',()=>true,async s=>{ const t=await fmPickFolder(S.space,null,'Copy to…'); if(t===undefined) throw new Error('');
        for(const d of s.d) await B().copyFolder(d,t); for(const f of s.f) await B().copy(f,t); }),
      act('⤓','Download files',s=>s.f.length>0,async s=>{ for(const f of s.f){ const r=await B().get(f); if(r) await fmDownload(r); } }),
      act('✕','Delete (can be undone)',()=>true,async s=>{
        const undo=await B().snapshot(s);
        for(const d of s.d) await B().deleteFolder(d); for(const f of s.f){ if(S.selected?.id===f) select(null); await B().remove(f); }
        dspToast(root,'Deleted '+(s.f.length+s.d.length)+' item(s).',undo); }));
  }
  function select(rec){ S.selected=rec; o.onSelect?.(rec); [...list.children].forEach(r=>r.classList.toggle('sel',!!rec && r._rec===rec.id)); showPrev(rec); }
  // превью выбранного файла: картинка, волна и длительность клипа, начало текста
  async function showPrev(rec){
    if(!o.preview) return;
    const g=++S.pg; prev.textContent=''; prev.hidden=!rec;
    for(const u of S.pu) URL.revokeObjectURL(u); S.pu=[];                  // свои адреса: список перерисовывается чаще, чем меняется выбор
    if(!rec) return;
    const m=rec.mime||'', url=()=>{ const u=URL.createObjectURL(rec.blob); S.pu.push(u); return u; };
    if(m.startsWith('image/') && rec.blob){ const im=document.createElement('img'); im.src=url(); prev.append(im); }
    else if(m.startsWith('video/') && rec.blob){ const v=document.createElement('video'); v.src=url(); v.controls=true; v.preload='metadata'; prev.append(v); }
    else if(m.startsWith('audio/') && rec.blob && !rec.meta?.peaks && !o.previewExtra){ const a=document.createElement('audio'); a.src=url(); a.controls=true; a.preload='metadata'; prev.append(a); }
    else if(rec.meta?.peaks){ const cv=document.createElement('canvas'); cv.width=200; cv.height=28; fmPeaks(cv,rec.meta.peaks); prev.append(cv,' ',fmtDur(rec.meta.duration||0)+' · '+(rec.meta.sr||'')+' Hz'); }
    else if(m.startsWith('text/') || /json|xml/.test(m) || rec.space==='tables'){
      const t=await (await fmBlob(rec)).slice(0,500).text(); if(g!==S.pg) return;
      const pre=document.createElement('pre'); pre.textContent=t; prev.append(pre);
    } else prev.append((m||'file')+' · '+fmSize(rec.size||0));
    o.previewExtra?.(rec,prev);
  }
  async function refresh(){
    const g=++S.gen, be=B(), srch=!!S.q;
    const [folders0,files0,path,use]=await Promise.all([
      srch ? be.allFolders(S.space) : be.listFolders(S.space,S.folder),
      srch ? be.listAll(S.space) : be.list(S.space,S.folder),
      be.path(S.folder),be.usage(S.space)]);
    if(S.dead || g!==S.gen) return;
    const sg=S.desc ? -1 : 1;
    const folders=folders0.filter(f=>!srch || f.name.toLowerCase().includes(S.q)).sort((a,b)=>FM_SORT.name(a,b)*(S.sort==='name' ? sg : 1));
    const files=files0.filter(r=>!srch || r.name.toLowerCase().includes(S.q)).sort((a,b)=>FM_SORT[S.sort](a,b)*sg);
    const dirs=srch ? new Map((await be.allFolders(S.space)).map(f=>[f.id,f])) : null;
    const where=id=>{ const p=[]; for(let f=dirs.get(id);f;f=dirs.get(f.parentId)) p.unshift(f.name); return '/'+p.join('/'); };
    o.onFolder?.(S.folder); o.onNav?.(S.space,S.folder);
    for(const u of S.urls) URL.revokeObjectURL(u); S.urls=[];
    // отметки живут только пока объект на месте
    const have=new Set([...folders0.map(f=>'d:'+f.id),...files0.map(r=>'f:'+r.id)]);
    for(const k of [...S.marks]) if(!have.has(k)) S.marks.delete(k);
    drawBulk();
    crumbs.textContent='';
    const seg=(t,sp,id)=>{ const b=document.createElement('button'); b.textContent=t; b.onclick=()=>go(sp,id); crumbs.append(b); };
    seg('/',home,null);
    if(S.space!==home){ crumbs.append(' › '); seg(S.space,S.space,null); }
    for(const f of path){ crumbs.append(' › '); seg(f.name,S.space,f.id); }
    list.textContent='';
    const chk=(row,k)=>{ row._mk=k; row.classList.toggle('mark',S.marks.has(k)); if(S.multi) addChk(row); arm(row,k); };
    // остальные хранилища — системные папки корня
    if(S.space===home && S.folder==null && !srch) for(const sp of spaces.slice(1)){
      const row=document.createElement('div'); row.className='fm-row fm-dir fm-sys';
      const nm=document.createElement('span'); nm.className='fm-name'; nm.textContent='🗂 '+sp; nm.title='System folder';
      row.append(nm); row.onclick=()=>go(sp,null); list.append(row);
    }
    for(const f of folders){
      const row=document.createElement('div'); row.className='fm-row fm-dir';
      const nm=document.createElement('span'); nm.className='fm-name'; nm.textContent='📁 '+f.name;
      if(srch) nm.title=where(f.parentId);
      row.append(nm);
      chk(row,'d:'+f.id);
      row.onclick=e=>{ if(several(e)) return pickRow('d:'+f.id,e); go(S.space,f.id); };
      row.ondragover=e=>{ e.preventDefault(); row.classList.add('over'); };
      row.ondragleave=()=>row.classList.remove('over');
      row.ondrop=async e=>{ e.preventDefault(); e.stopPropagation(); row.classList.remove('over'); if(fmDrag!=null) await guard(()=>be.update(fmDrag,{folderId:f.id}))(); };
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
      const nm=document.createElement('span'); nm.className='fm-name'; nm.textContent=r.name; nm.title=(srch ? where(r.folderId)+'/' : '')+fmFileName(r);
      const sz=document.createElement('span'); sz.className='fm-size';
      sz.textContent=r.meta?.duration!=null ? fmtDur(r.meta.duration) : r.space==='tables' ? r.meta.rows+' rows · '+fmSize(r.size||0) : fmSize(r.size||0);
      row.append(th,nm,sz);
      o.extra?.(r,row);
      chk(row,'f:'+r.id);
      row.onclick=e=>{
        const k='f:'+r.id;
        if(several(e)){ pickRow(k,e); return select(S.marks.has(k) ? r : null); }
        S.marks=new Set([k]); S.anchor=k; S.multi=false; refreshSel(); drawBulk(); paintMarks(); select(r);
        if(o.openOnClick) o.onOpen?.(r);
      };
      row.ondblclick=()=>{ if(!o.openOnClick) o.onOpen?.(r); };
      row.ondragstart=e=>{ fmDrag=r.id; e.dataTransfer.setData('text/plain',r.name); e.dataTransfer.setData('application/x-dsp-file',String(r.id)); };
      row.ondragend=()=>{ fmDrag=null; };
      list.append(row);
    }
    if(!list.children.length){ const e=document.createElement('div'); e.className='fm-empty'; e.textContent=srch ? 'nothing found' : 'empty — import files or drop them here'; list.append(e); }
    info.textContent=use.files+(S.space==='tables' ? ' table' : ' file')+(use.files===1 ? '' : 's')+' · '+fmSize(use.bytes)+' in '+S.space;
    drawDisk();
  }
  async function drawDisk(){
    const q=await FileStore.quota();
    if(S.dead) return;
    disk.hidden=!q || !q.quota;
    if(disk.hidden) return;
    const f=q.usage/q.quota;
    fill.style.width=Math.min(100,f*100).toFixed(1)+'%';
    meter.classList.toggle('warn',f>0.8);
    diskTx.textContent='free '+fmSize(q.free)+' of '+fmSize(q.quota)+' · used '+fmSize(q.usage)+(q.persisted ? ' · persistent' : '');
  }
  function setSpace(sp){ if(spaces.includes(sp)) go(sp,null); }
  const off=FileStore.onChange(sp=>{ if(!root.isConnected){ off(); S.dead=true; return; } if(!sp || sp===S.space) refresh(); });
  refresh();
  return { root, refresh, setSpace, toast:(t,u)=>dspToast(root,t,u), get space(){ return S.space; }, get folder(){ return S.folder; }, get selected(){ return S.selected; },
    async picked(){                                    // отмеченные файлы (записи) в порядке отметки
      const out=[]; for(const k of S.marks) if(k[0]==='f'){ const r=await B().get(idOf(k.slice(2))); if(r) out.push(r); }
      return out;
    },
    destroy(){ S.dead=true; off(); for(const u of [...S.urls,...S.pu]) URL.revokeObjectURL(u); root.remove(); } };
}
let fmDrag=null;

/* ---- узел: файловый менеджер ----
   Звук: выбранный клип из audio играет на выход `out` (▶, ползунок перемотки, входы clipId / play / seek), ✎ — редактор клипа.
   Запись (● rec или вход `rec`: ≥ 0.5 — идёт запись): звук с входа `in` (подключён и граф запущен) либо с микрофона, камера, экран
   или картинка графа (`vid` / `img`: TS → Video, декодеры, Camera …) — как Record Video, но сразу в хранилище.
   Формат звука — clip (редактируемый, в audio), wav16 или opus; видео — webm / mp4 (что умеет браузер).
   Приём: байты на входе `bin` (File → Bytes, Bytes → Frames …) сохраняются файлом. Куда: вход `path` —
   [хранилище/]папки/[имя.расширение], папки создаются; пусто — открытая папка (запись) или Received (приём).
   Узел заменил Sample Library и Bytes → File (старые патчи открываются как Files). */
const FS_REC_AUDIO=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4'];
const FS_REC_VIDEO=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4'];
const fsStamp=()=>{ const d=new Date(), z=k=>String(k).padStart(2,'0');       // без точек: «.46» принимали за расширение
  return d.getFullYear()+'-'+z(d.getMonth()+1)+'-'+z(d.getDate())+'_'+z(d.getHours())+'-'+z(d.getMinutes())+'-'+z(d.getSeconds()); };
const fsExt=m=>m.includes('mp4') ? 'mp4' : m.includes('ogg') ? 'ogg' : 'webm';
function fsWavI16(samples,sr){
  const n=samples.length, b=new ArrayBuffer(44+n*2), v=new DataView(b);
  const w=(o,t)=>{ for(let i=0;i<t.length;i++) v.setUint8(o+i,t.charCodeAt(i)); };
  w(0,'RIFF'); v.setUint32(4,36+n*2,true); w(8,'WAVEfmt '); v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
  v.setUint32(24,sr,true); v.setUint32(28,sr*2,true); v.setUint16(32,2,true); v.setUint16(34,16,true); w(36,'data'); v.setUint32(40,n*2,true);
  for(let i=0;i<n;i++) v.setInt16(44+i*2,Math.max(-1,Math.min(1,samples[i]))*32767,true);
  return new Blob([b],{type:'audio/wav'});
}
// куда класть: path = [хранилище/]папки/[имя.расширение]; force — хранилище задано видом файла (клип — только audio)
async function fsDest(n,path,space,force){
  const parts=String(path||'').split('/').map(x=>x.trim()).filter(Boolean);
  if(parts.length && FS_SPACES.includes(parts[0])){ const sp=parts.shift(); if(!force) space=sp; }
  const name=parts.length && /\.[A-Za-z0-9]{1,5}$/.test(parts[parts.length-1]) ? parts.pop() : '';
  let folderId=null;
  if(!path){ if(n.fm?.space===space) folderId=n.fm.folder; }
  else for(const f of parts){
    const have=(await FileStore.listFolders(space,folderId)).find(x=>x.name===f);
    folderId=have ? have.id : await FileStore.addFolder(space,f,folderId);
  }
  return {space,folderId,name};
}
async function fsSaveBlob(n,blob,name,space){                 // запись/приём → файл
  const d=await fsDest(n,n.pathIn,space);
  await FileStore.put({space:d.space,folderId:d.folderId,name:d.name||name,mime:blob.type||'application/octet-stream',blob,meta:{}});
  n.okP=2;
}
async function fsReceive(n,o){
  const blob=new Blob([o.d],{type:o.mime||'application/octet-stream'}), name=o.name||'data.bin';
  const space=(o.mime||'').startsWith('image/') ? 'images' : 'files';
  const d=await fsDest(n,n.pathIn||'Received',space), nm=d.name||name;
  await FileStore.importFile(d.space,new File([blob],nm,{type:blob.type}),d.folderId,nm);
  if(n.p.download) fmDownload({name:nm,mime:blob.type,blob});
  n.okP=2;
}
async function fsArm(n,id,autoplay){                                   // клип библиотеки или любой звуковой файл (декодируется)
  const r=await FileStore.get(id); if(!r) return;
  let samples,sr;
  if(r.meta?.sr){ const clip=await SampleDB.getClip(id); if(!clip) return; ({samples,sr}=clip); }
  else{
    try{ ({samples,sr}=await decodeAudioFile(new File([r.blob],r.name,{type:r.mime}))); }
    catch(e){ alert('Cannot decode '+r.name+': '+e.message); return; }
  }
  n.data=samples; n.dataSr=sr; n.pos=0; n.armed=id; if(autoplay) n.play=true;
  n.fm?.refresh();
}
async function fsRecToggle(n){
  if(n.rec) return fsRecStop(n);
  if(n.recBusy) return;
  n.recBusy=true;
  try{
    const src=n.p.recSrc, fmt=n.p.recFmt;
    if(src==='video in'){                                                     // кадры графа → канва → MediaRecorder
      const mime=typeof vrecMime==='function' ? vrecMime('auto') : null;
      if(!mime){ alert('No video encoder in this browser'); return; }
      if(!vrecDraw(n.vr)){ alert('No picture on the vid / img input'); return; }
      const mr=new MediaRecorder(n.vr.cv.captureStream(25),{mimeType:mime,videoBitsPerSecond:4000000}), chunks=[];
      const rec=n.rec={kind:'mr',src:'video',mr,chunks,t0:performance.now(),timer:setInterval(()=>vrecDraw(n.vr),40)};   // кадры идут и когда источник стоит
      mr.ondataavailable=e=>{ if(e.data.size) chunks.push(e.data); };
      mr.onstop=async()=>{
        clearInterval(rec.timer);
        if(!chunks.length) return;
        const blob=new Blob(chunks,{type:mime});
        try{ await fsSaveBlob(n,blob,'video '+fsStamp()+'.'+fsExt(mime),'files'); }catch(e){ alert('Could not save: '+e.message); }
      };
      mr.start(1000);
    }
    else if(src==='audio' && n.inWired && Eng.running) n.rec={kind:'pcm',src:'graph',chunks:[],sr:Eng.sr,t0:performance.now()};
    else if(src==='audio' && fmt!=='opus'){
      const ctx=new (window.AudioContext||window.webkitAudioContext)();      // до await — иначе iOS не запустит контекст вне жеста
      ctx.resume();
      let st;
      try{ st=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}}); }
      catch(e){ ctx.close(); alert('Microphone unavailable: '+e.message); return; }
      const sc=ctx.createMediaStreamSource(st), sp=ctx.createScriptProcessor(4096,1,1);
      const rec=n.rec={kind:'pcm',src:'mic',chunks:[],sr:ctx.sampleRate,t0:performance.now(),ctx,st,sp};
      sp.onaudioprocess=e=>{ if(n.rec===rec) rec.chunks.push(e.inputBuffer.getChannelData(0).slice()); };
      sc.connect(sp); sp.connect(ctx.destination);
    } else{                                                                   // MediaRecorder: opus с микрофона, камера, экран
      if(typeof MediaRecorder==='undefined'){ alert('MediaRecorder is unavailable in this browser'); return; }
      let st;
      try{
        st=src==='audio' ? await navigator.mediaDevices.getUserMedia({audio:true})
          : src==='screen' ? await navigator.mediaDevices.getDisplayMedia({video:true,audio:true})
          : await navigator.mediaDevices.getUserMedia({video:true,audio:true}).catch(()=>navigator.mediaDevices.getUserMedia({video:true}));
      }catch(e){ alert((src==='audio' ? 'Microphone' : src==='screen' ? 'Screen' : 'Camera')+' unavailable: '+e.message); return; }
      const mime=(src==='audio' ? FS_REC_AUDIO : FS_REC_VIDEO).find(t=>MediaRecorder.isTypeSupported(t))||'';
      const mr=new MediaRecorder(st,mime ? {mimeType:mime} : undefined), chunks=[];
      const rec=n.rec={kind:'mr',src,mr,st,chunks,t0:performance.now()};
      mr.ondataavailable=e=>{ if(e.data.size) chunks.push(e.data); };
      mr.onstop=async()=>{
        st.getTracks().forEach(t=>t.stop());
        if(!chunks.length) return;
        const blob=new Blob(chunks,{type:mr.mimeType||mime});
        try{ await fsSaveBlob(n,blob,(src==='audio' ? 'rec ' : src+' ')+fsStamp()+'.'+fsExt(blob.type),'files'); }catch(e){ alert('Could not save: '+e.message); }
      };
      st.getTracks().forEach(t=>t.addEventListener('ended',()=>{ if(n.rec===rec) fsRecStop(n); }));
      mr.start(1000);
    }
    n.recTimer=setInterval(()=>fsRecUI(n),250); fsRecUI(n);
  } finally{ n.recBusy=false; }
}
async function fsRecStop(n){
  const rec=n.rec; if(!rec) return; n.rec=null;
  clearInterval(n.recTimer); fsRecUI(n);
  if(rec.kind==='mr'){ if(rec.mr.state!=='inactive') rec.mr.stop(); return; }
  if(rec.src==='mic'){ rec.sp.disconnect(); rec.st.getTracks().forEach(t=>t.stop()); rec.ctx.close(); }
  const len=rec.chunks.reduce((a,c)=>a+c.length,0);
  if(!len){ alert(rec.src==='graph' ? 'Nothing recorded — is the graph running?' : 'Nothing recorded'); return; }
  const samples=new Float32Array(len); let o=0; for(const c of rec.chunks){ samples.set(c,o); o+=c.length; }
  try{
    if(n.p.recFmt==='clip'){
      const d=await fsDest(n,n.pathIn,'audio',true);
      await SampleDB.addClip({name:d.name.replace(/\.[^.]+$/,'')||'rec '+fsStamp(),folderId:d.folderId,sr:rec.sr,samples,
        peaks:SampleDB.computePeaks(samples),duration:len/rec.sr});
      n.okP=2;
    } else await fsSaveBlob(n,fsWavI16(samples,rec.sr),'rec '+fsStamp()+'.wav','files');       // wav16; opus из графа не кодируется — тоже wav16
  }catch(e){ alert('Could not save: '+e.message); }
}
function fsRecUI(n){
  const b=n.recBtn; if(!b) return;
  b.textContent=n.rec ? '■ '+fmtDur((performance.now()-n.rec.t0)/1000)+' '+(n.rec.src==='graph' ? 'in' : n.rec.src) : '● rec';
  b.classList.toggle('on',!!n.rec);
}

def({ id:'files', title:'Files', cat:'Output', kw:'file manager storage samples sample library clips audio video record trigger receive save bytes images folder browser upload download', w:340, h:440, resize:true,
  ins:[{n:'clipId',t:'num'},{n:'play',t:'num'},{n:'seek',t:'num'},{n:'in',t:'sig'},{n:'rec',t:'num'},{n:'bin',t:'bin'},{n:'path',t:'txt'},{n:'vid',t:'vid'},{n:'img',t:'img'}],
  outs:[{n:'id',t:'num'},{n:'name',t:'txt'},{n:'size',t:'num'},{n:'send',t:'num'},{n:'bin',t:'bin'},{n:'out',t:'sig'},{n:'clipId',t:'num'},{n:'pos',t:'num'},{n:'ok',t:'num'},{n:'vid',t:'vid'}],
  params:[{n:'meta',t:'check',d:true,label:'bin: attach name and type (off — bare bytes)'},
    {n:'loop',t:'check',d:true,label:'loop the played clip'},
    {n:'recSrc',t:'select',opts:['audio','camera','screen','video in'],d:'audio',label:'record from (audio: `in` port when wired, else microphone; video in: the `vid` / `img` port)'},
    {n:'recFmt',t:'select',opts:['clip','wav16','opus'],d:'clip',label:'audio format: clip (editable, in audio) · wav16 · opus (microphone)'},
    {n:'download',t:'check',d:false,label:'also download received files'},
    {n:'sendBtn',t:'button',label:'Send selected → (pulse on `send`, bytes on `bin`; several — one per block)',fn:n=>{
      n.fm?.picked().then(a=>{ n.queue.push(...a); }); }}],
  init:n=>{ n.fm=null; n.sel=null; n.vidEl=null; n.queue=[]; n.busy=false; n.ready=-1; n.binOut=null;
    n.data=null; n.dataSr=0; n.pos=0; n.play=false; n.playGate=false; n.armed=null; n.rec=null; n.recGate=false; n.inWired=false;
    n.lastBin=null; n.pathIn=''; n.okP=0; n.seekIn=null; n.vr={I:{},p:{maxw:0}}; },
  dispose:n=>{ if(n.rec) fsRecStop(n); clearInterval(n.rec?.timer); n.editor?.close?.(); n.fm?.destroy(); n.fm=null; },
  process(n,I){ const send=n.ready; n.ready=-1;                                // импульс: id на один блок, потом -1
    n.inWired=I.in!=null;
    n.vr.I={vid:I.vid,img:I.img};
    if(typeof I.path==='string') n.pathIn=I.path.trim();
    if(n.rec?.src==='graph' && I.in) n.rec.chunks.push(Float32Array.from(I.in));
    if(typeof I.rec==='number'){                                                // внешний триггер записи: уровень
      const g=I.rec>=0.5;
      if(g && !n.recGate && !n.rec) fsRecToggle(n); else if(!g && n.recGate && n.rec) fsRecStop(n);
      n.recGate=g;
    }
    if(I.bin && I.bin.d && I.bin!==n.lastBin){ n.lastBin=I.bin; fsReceive(n,I.bin).catch(e=>console.warn('Files: receive',e)); }
    if(typeof I.clipId==='number' && I.clipId>=0 && I.clipId!==n.armed) fsArm(n,I.clipId,false);
    if(typeof I.play==='number'){ const g=I.play>0.5; if(g && !n.playGate){ n.pos=0; n.play=true; } n.playGate=g; }
    if(typeof I.seek==='number' && I.seek!==n.seekIn){ n.seekIn=I.seek; if(n.data) n.pos=Math.min(1,Math.max(0,I.seek))*(n.data.length-1); }
    const r=n.sel;
    if(!n.busy && n.queue.length){                // байты уходят только по кнопке; пульс send идёт вместе с ними, а не раньше
      const q=n.queue.shift(); n.busy=true;
      fmBlob(q).then(b=>b.arrayBuffer()).then(a=>{ n.binOut=n.p.meta ? binObj(new Uint8Array(a),fmFileName(q),q.mime) : binObj(new Uint8Array(a));
        n.ready=typeof q.id==='number' ? q.id : 0; n.busy=false; },()=>{ n.busy=false; });
    }
    const o=buf(n,'out'), d=n.data;
    if(d && n.play){
      const rate=(n.dataSr||Eng.sr)/Eng.sr;
      for(let i=0;i<BLOCK;i++){
        if(n.pos>=d.length-1){ if(n.p.loop) n.pos=0; else{ n.play=false; o[i]=0; continue; } }
        const i0=n.pos|0, fr=n.pos-i0; o[i]=d[i0]*(1-fr)+d[i0+1]*fr; n.pos+=rate;
      }
    } else o.fill(0);
    const ok=n.okP>0 ? 1 : 0; if(n.okP>0) n.okP--;
    return {id:r && typeof r.id==='number' ? r.id : -1, name:r?.name||'', size:r?.size||0, send, bin:n.binOut,
      out:o, clipId:n.armed??-1, pos:d ? n.pos/d.length : 0, ok, vid:n.vidEl?.isConnected ? n.vidEl : null}; },
  draw(n){
    if(n.playBtn?.isConnected){
      const here=n.armed===n.playId && n.data;
      n.playBtn.textContent=here && n.play ? '⏸' : '▶';
      if(!n.seeking) n.seekEl.value=here ? Math.round(n.pos/n.data.length*1000) : 0;
      n.timeEl.textContent=fmtDur(here ? n.pos/n.dataSr : 0)+' / '+fmtDur(here ? n.data.length/n.dataSr : n.playDur||0);
    }
    if(n.fm && n.mid.contains(n.fm.root)) return;
    n.fm?.destroy();
    n.fm=fmMount(n.mid,{preview:true,onSelect:r=>{ n.sel=r; n.vidEl=null; },
      toolbar:bar=>{ n.recBtn=document.createElement('button'); n.recBtn.title='Record (settings: record from / audio format); into the open folder or the path input';
        n.recBtn.onclick=()=>fsRecToggle(n); bar.append(n.recBtn); fsRecUI(n); },
      previewExtra:(r,box)=>{
        n.vidEl=box.querySelector('video');                                   // выход vid: тот же ролик, что в превью
        if(!r.mime?.startsWith('audio/') || !r.blob) return;
        const b=(t,title,f)=>{ const e=document.createElement('button'); e.textContent=t; e.title=title; e.onclick=f; box.append(e); return e; };
        n.playId=r.id; n.playDur=r.meta?.duration||0;
        n.playBtn=b('▶','Play on the `out` port',async()=>{
          if(n.armed===r.id) n.play=!n.play; else await fsArm(n,r.id,true); });
        const rg=n.seekEl=document.createElement('input'); rg.type='range'; rg.min=0; rg.max=1000; rg.value=0; rg.className='fm-seek'; rg.title='Seek';
        rg.oninput=async()=>{ n.seeking=true; if(n.armed!==r.id) await fsArm(n,r.id,false); if(n.data) n.pos=rg.value/1000*(n.data.length-1); };
        rg.onchange=()=>{ n.seeking=false; };
        n.timeEl=document.createElement('span'); box.append(rg,n.timeEl);
        if(r.meta?.sr) b('✎','Edit the clip',async()=>{
          if(n.editor) return;
          const clip=await SampleDB.getClip(r.id); if(!clip) return;
          n.editor=aedOpen(clip,{onSaved:async sid=>{ if(n.armed===sid) await fsArm(n,sid,false); },onClose:()=>{ n.editor=null; }});
        });
      }});
  }
});
