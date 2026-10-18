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
    async listAll(space){ return (await reqP((await st('files','readonly')).getAll())).filter(f=>f.space===space); },
    async copy(id,folderId=null){                      // копия файла; в той же папке — с пометкой в имени
      const r=await this.get(id); if(!r) return;
      const {id:_,...rest}=r, same=key(folderId)===r.folderId;
      return this.put({...rest,folderId,name:same ? r.name+' copy' : r.name,created:Date.now()});
    },
    async copyFolder(id,parentId=null){                // папка со всем содержимым; возвращает id копии
      const f=await this.getFolder(id); if(!f) return;
      const same=key(parentId)===f.parentId, nid=await this.addFolder(f.space,same ? f.name+' copy' : f.name,parentId);
      for(const sub of await this.listFolders(f.space,id)) await this.copyFolder(sub.id,nid);
      for(const x of await this.list(f.space,id)) await this.copy(x.id,nid);
      return nid;
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
function fmFileName(r){ const e=FM_EXT[r.mime]; return !e || /\.[A-Za-z0-9]{1,5}$/.test(r.name) ? r.name : r.name+'.'+e; }
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

const FM_SORT={name:(a,b)=>String(a.name).localeCompare(String(b.name),undefined,{numeric:true}),
  size:(a,b)=>(a.size||0)-(b.size||0), date:(a,b)=>(a.modified||0)-(b.modified||0),
  type:(a,b)=>String(a.mime).localeCompare(String(b.mime))||FM_SORT.name(a,b)};

function fmMount(host,o={}){
  const spaces=o.spaces||FM_SPACES, home=spaces[0];
  const S={space:o.space||home,folder:null,selected:null,urls:[],gen:0,dead:false,sort:'name',desc:false,q:'',multi:false,marks:new Set(),anchor:null};
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
  for(const k of Object.keys(FM_SORT)){ const op=document.createElement('option'); op.value=op.textContent=k; sortSel.append(op); }
  sortSel.onchange=()=>{ S.sort=sortSel.value; refresh(); };
  const dirBtn=mk('↑','Ascending / descending',()=>{ S.desc=!S.desc; dirBtn.textContent=S.desc ? '↓' : '↑'; refresh(); });
  const selBtn=mk('☑','Select several (or Ctrl / Shift + click)',()=>{ S.multi=!S.multi; selBtn.classList.toggle('on',S.multi); refresh(); });
  find.append(search,sortSel,dirBtn,selBtn);
  bar.append(
    mk('＋ folder','New folder here',guard(async()=>{ const n=prompt('Folder name:'); if(n) await B().addFolder(S.space,n,S.folder); })),
    mk('⤒ import','Add files from this device',()=>inp.click()),
    inp);
  inp.onchange=async()=>{ const fs=[...inp.files]; inp.value=''; await addFiles(fs); };
  root.append(bar,find,crumbs,bulk,list,info,disk);
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
  }
  function go(space,folder){
    S.space=space; S.folder=folder; S.marks.clear(); S.anchor=null; search.value=S.q=''; select(null); refresh();
  }
  // отметки: 'f:id' — файл, 'd:id' — папка; один клик отмечает одну строку, Ctrl / Shift / режим ☑ — несколько
  const paintMarks=()=>[...list.children].forEach(r=>{ r.classList.toggle('mark',S.marks.has(r._mk)); const c=r.querySelector('input'); if(c) c.checked=S.marks.has(r._mk); });
  function pickRow(k,e){
    const keys=[...list.children].map(r=>r._mk).filter(Boolean);
    if(e?.shiftKey && S.anchor && keys.includes(S.anchor)){
      const i=keys.indexOf(S.anchor), j=keys.indexOf(k);
      for(const x of keys.slice(Math.min(i,j),Math.max(i,j)+1)) S.marks.add(x);
    }else{ S.marks.has(k) ? S.marks.delete(k) : S.marks.add(k); S.anchor=k; }
    drawBulk(); paintMarks();
  }
  const several=e=>S.multi || !!(e && (e.ctrlKey || e.metaKey || e.shiftKey));
  const picked=()=>{ const f=[],d=[]; for(const k of S.marks) (k[0]==='f' ? f : d).push(idOf(k.slice(2))); return {f,d}; };
  function drawBulk(){
    bulk.textContent='';
    const n=S.marks.size;
    const act=(t,title,ok,fn)=>{ const b=mk(t,title,guard(async()=>{ await fn(picked()); S.marks.clear(); drawBulk(); })); b.disabled=!n || !ok(picked()); return b; };
    const lbl=document.createElement('span'); lbl.className='fm-info'; lbl.textContent=n ? n+' selected' : 'nothing selected';
    bulk.append(lbl);
    if(S.multi) bulk.append(
      mk('all','Select everything shown',()=>{ for(const r of list.children) if(r._mk) S.marks.add(r._mk); drawBulk(); paintMarks(); }),
      mk('none','Clear selection',()=>{ S.marks.clear(); drawBulk(); paintMarks(); }));
    bulk.append(
      act('✎','Rename',s=>s.f.length+s.d.length===1,async s=>{
        if(s.d.length){ const f=await B().getFolder(s.d[0]), nm=prompt('New name:',f.name); if(nm) await B().renameFolder(f.id,nm); }
        else{ const r=await B().get(s.f[0]), nm=prompt('New name:',r.name); if(nm) await B().update(r.id,{name:nm}); } }),
      act('⇢','Move',()=>true,async s=>{ const t=await fmPickFolder(S.space,s.d,'Move to…'); if(t===undefined) throw new Error('');
        for(const d of s.d) await B().moveFolder(d,t); for(const f of s.f) await B().update(f,{folderId:t}); }),
      act('⧉','Copy',()=>true,async s=>{ const t=await fmPickFolder(S.space,null,'Copy to…'); if(t===undefined) throw new Error('');
        for(const d of s.d) await B().copyFolder(d,t); for(const f of s.f) await B().copy(f,t); }),
      act('⤓','Download files',s=>s.f.length>0,async s=>{ for(const f of s.f){ const r=await B().get(f); if(r) await fmDownload(r); } }),
      act('✕','Delete',()=>true,async s=>{ if(!confirm('Delete '+(s.f.length+s.d.length)+' selected item(s)?')) throw new Error('');
        for(const d of s.d) await B().deleteFolder(d); for(const f of s.f){ if(S.selected?.id===f) select(null); await B().remove(f); } }));
  }
  function select(rec){ S.selected=rec; o.onSelect?.(rec); [...list.children].forEach(r=>r.classList.toggle('sel',!!rec && r._rec===rec.id)); }
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
    o.onFolder?.(S.folder);
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
    const chk=(row,k)=>{ row._mk=k; row.classList.toggle('mark',S.marks.has(k));
      if(!S.multi) return; const c=document.createElement('input'); c.type='checkbox'; c.checked=S.marks.has(k);
      c.onclick=e=>{ e.stopPropagation(); pickRow(k,e); }; row.prepend(c); };
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
        S.marks=new Set([k]); S.anchor=k; drawBulk(); paintMarks(); select(r);
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
    persistBtn.hidden=q.persisted || !navigator.storage?.persist;
  }
  const persistBtn=mk('⚑ keep','Ask the browser not to evict this storage when space runs low',async()=>{
    try{ await navigator.storage.persist(); }catch(e){}
    drawDisk();
  });
  bar.append(persistBtn);
  function setSpace(sp){ if(spaces.includes(sp)) go(sp,null); }
  const off=FileStore.onChange(sp=>{ if(!root.isConnected){ off(); S.dead=true; return; } if(!sp || sp===S.space) refresh(); });
  refresh();
  return { root, refresh, setSpace, get space(){ return S.space; }, get folder(){ return S.folder; }, get selected(){ return S.selected; },
    async picked(){                                    // отмеченные файлы (записи) в порядке отметки
      const out=[]; for(const k of S.marks) if(k[0]==='f'){ const r=await B().get(idOf(k.slice(2))); if(r) out.push(r); }
      return out;
    },
    destroy(){ S.dead=true; off(); for(const u of S.urls) URL.revokeObjectURL(u); root.remove(); } };
}
let fmDrag=null;

/* ---- узел: файловый менеджер ---- */
def({ id:'files', title:'Files', cat:'Output', kw:'file manager storage samples images folder browser upload download', w:340, h:360, resize:true,
  ins:[], outs:[{n:'id',t:'num'},{n:'name',t:'txt'},{n:'size',t:'num'},{n:'send',t:'num'},{n:'bin',t:'bin'}],
  params:[{n:'meta',t:'check',d:true,label:'bin: attach name and type (off — bare bytes)'},
    {n:'sendBtn',t:'button',label:'Send selected → (pulse on `send`, bytes on `bin`; several — one per block)',fn:n=>{
      n.fm?.picked().then(a=>{ n.queue.push(...a); }); }}],
  init:n=>{ n.fm=null; n.sel=null; n.queue=[]; n.busy=false; n.ready=-1; n.binOut=null; },
  dispose:n=>{ n.fm?.destroy(); n.fm=null; },
  process(n){ const send=n.ready; n.ready=-1;                                  // импульс: id на один блок, потом -1
    const r=n.sel;
    if(!n.busy && n.queue.length){                // байты уходят только по кнопке; пульс send идёт вместе с ними, а не раньше
      const q=n.queue.shift(); n.busy=true;
      fmBlob(q).then(b=>b.arrayBuffer()).then(a=>{ n.binOut=n.p.meta ? binObj(new Uint8Array(a),fmFileName(q),q.mime) : binObj(new Uint8Array(a));
        n.ready=typeof q.id==='number' ? q.id : 0; n.busy=false; },()=>{ n.busy=false; });
    }
    return {id:r && typeof r.id==='number' ? r.id : -1, name:r?.name||'', size:r?.size||0, send, bin:n.binOut}; },
  draw(n){
    if(n.fm && n.mid.contains(n.fm.root)) return;
    n.fm?.destroy();
    n.fm=fmMount(n.mid,{onSelect:r=>{ n.sel=r; }});
  }
});
