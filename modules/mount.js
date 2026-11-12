"use strict";
/* ============================ Монтирование папок в Files ============================
   «⛓ mount» в менеджере Files подключает настоящую папку — файлы остаются на месте, без копирования в IndexedDB и без её квоты:
     • приложение Android — системное окно выбора папки (SAF, fs.pick моста), доступ запоминается (fs.* — см. FileHub.kt);
     • браузер с File System Access (Chrome, Edge, Opera…) — showDirectoryPicker, запись на месте; после перезапуска браузер
       просит разрешение заново — одним щелчком по папке;
     • Firefox / Safari — выбор папки <input webkitdirectory>: только чтение и только до закрытия страницы.
   В менеджере монтирования — системная папка «mounts»: каждая папка — корень внутри неё. Удаление корня только отключает папку
   (файлы не трогает); удаление внутри — настоящее, без отмены. Бэкенды и копирование — mount-kernels.js.
   Узел «Mounted Folder» читает / пишет / перечисляет файлы смонтированной папки из графа; имя «memory» — запасная папка в памяти. */

const Mounts=(() => {
  const KEY='dspMounts', live=new Map();
  let list=null;
  const load=()=>{ if(!list){ try{ list=JSON.parse(localStorage.getItem(KEY)||'[]').filter(m=>m && m.id && m.kind && m.name); }catch(e){ list=[]; } } return list; };
  const save=()=>{ try{ localStorage.setItem(KEY,JSON.stringify(load().filter(m=>!m.temp))); }catch(e){} };
  const idb=()=>typeof fsaIdbStore==='function' ? (Mounts._st||(Mounts._st=fsaIdbStore())) : null;
  const uniq=n=>{ let s=n||'folder', k=1; const have=new Set(load().map(m=>m.name)); while(have.has(s)) s=(n||'folder')+' ('+(++k)+')'; return s; };
  const newId=()=>'m'+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
  const note=()=>{ try{ FileStore.notify('mounts'); }catch(e){} };
  function add(m){ load().push(m); save(); note(); return m; }
  const api={
    list:()=>load().slice(),
    byId:id=>load().find(m=>m.id===id),
    byName(n){ return load().find(m=>m.name===n); },
    app:()=>typeof AppLink!=='undefined' && AppLink.ok,
    web:()=>typeof window!=='undefined' && typeof window.showDirectoryPicker==='function',
    // выбор и подключение папки; null — окно закрыли
    async pick(){
      if(api.app()){
        const r=await AppLink.call('fs.pick',{},300000);
        if(!r.grant) return null;
        const have=load().find(m=>m.kind==='app' && m.grant===r.grant);
        return have || add({id:newId(),kind:'app',name:uniq(r.name||'phone folder'),grant:r.grant});
      }
      if(api.web()){
        let h; try{ h=await window.showDirectoryPicker({id:'dsp-mount',mode:'readwrite'}); }catch(e){ if(e && e.name==='AbortError') return null; throw e; }
        const id=newId(); let temp=false;
        const st=idb();
        try{ if(!st) throw 0; await st.put('mnt:'+id,h); }catch(e){ temp=true; }       // нет хранилища (приватный режим) — на время сессии
        const m=add({id,kind:'dir',name:uniq(h.name),...(temp ? {temp:true} : {})});
        if(temp) live.set(id,new MountDir(h));
        return m;
      }
      return api.pickFiles();
    },
    // запасной путь без API папок: только чтение, до закрытия страницы
    pickFiles(){
      return new Promise((res,rej)=>{
        const inp=document.createElement('input'); inp.type='file'; inp.multiple=true; inp.setAttribute('webkitdirectory',''); inp.hidden=true;
        let done=false;
        inp.onchange=()=>{
          done=true; const fl=[...inp.files]; inp.remove();
          if(!fl.length) return res(null);
          const fs=new MountFiles(fl), m=add({id:newId(),kind:'files',name:uniq(fs.name||'folder'),temp:true,ro:true});
          live.set(m.id,fs); res(m);
        };
        inp.addEventListener('cancel',()=>{ if(!done){ inp.remove(); res(null); } });
        document.body.append(inp); inp.click();
      });
    },
    // бэкенд папки; для папки браузера после перезапуска нужен щелчок (разрешение спрашивается из жеста)
    async fsOf(m){
      if(typeof m==='string') m=api.byId(m) || (m==='memory' ? api.scratch() : null);
      if(!m) throw new Error('no such mounted folder');
      if(live.has(m.id)) return live.get(m.id);
      let fs;
      if(m.kind==='app'){
        if(!api.app()) throw new Error('"'+m.name+'" is a phone folder: open the page in the DSP app');
        fs=new MountApp((cmd,args)=>AppLink.call(cmd,args,120000),fn=>AppLink.on(fn),m.grant);
      }else if(m.kind==='dir'){
        const st=idb(), h=st ? await st.get('mnt:'+m.id) : null;
        if(!h) throw new Error('"'+m.name+'" is no longer available: mount it again');
        let p=h.queryPermission ? await h.queryPermission({mode:'readwrite'}) : 'granted';
        if(p!=='granted' && h.requestPermission){
          try{ p=await h.requestPermission({mode:'readwrite'}); }
          catch(e){ throw new Error('Click the folder "'+m.name+'" to allow access'); }
        }
        if(p!=='granted') throw new Error('Access to "'+m.name+'" was not allowed');
        fs=new MountDir(h);
      }else throw new Error('"'+m.name+'" was closed with the page: mount it again');
      live.set(m.id,fs); return fs;
    },
    scratch(){ if(!api._mem){ api._mem={id:'memory',kind:'mem',name:'memory',temp:true,hidden:true}; live.set('memory',new MountMem()); } return api._mem; },
    rename(id,name){ const m=api.byId(id); if(!m) return; m.name=name===m.name ? name : uniq(name); save(); note(); },
    async unmount(id){
      const m=api.byId(id); if(!m) return;
      list=load().filter(x=>x.id!==id); live.delete(id); save();
      try{ if(m.kind==='dir') await idb()?.del('mnt:'+id); }catch(e){}
      try{ if(m.kind==='app' && api.app() && !load().some(x=>x.grant===m.grant)) await AppLink.call('fs.revoke',{grant:m.grant}); }catch(e){}
      note();
    },
    // «имя/путь/внутри» → {m,fs,path}: для узлов и программ
    async resolve(spec){
      const s=mtNorm(spec), i=s.indexOf('/'), name=i<0 ? s : s.slice(0,i);
      const m=api.byName(name) || (name==='memory' ? api.scratch() : null);
      if(!m) throw new Error('no mounted folder "'+name+'"');
      return {m,fs:await api.fsOf(m),path:i<0 ? '' : s.slice(i+1)};
    },
  };
  return api;
})();

/* ---- бэкенд менеджера Files (пространство «mounts»): тот же набор методов, что у FileStore ----
   id папки и файла — «идентификатор монтирования:путь»; корни монтирований лежат в корне пространства. */
const MountStore=(() => {
  const SP='mounts', MAXW=5000;
  const split=id=>{ id=String(id); const i=id.indexOf(':'); return [id.slice(0,i),mtNorm(id.slice(i+1))]; };
  const idOf=(m,p)=>m.id+':'+p;
  const dirRec=(m,p)=>({id:idOf(m,p),space:SP,name:p ? mtSplit(p)[1] : m.name,parentId:p ? idOf(m,mtSplit(p)[0]) : FS_ROOT,created:0,meta:{mount:m.name,kind:m.kind}});
  let cache=new Map();
  const bust=()=>{ cache=new Map(); try{ FileStore.notify(SP); }catch(e){} };
  async function ls(m,p){
    const k=m.id+':'+p, c=cache.get(k);
    if(c && Date.now()-c.t<1500) return c.p;
    const pr=Mounts.fsOf(m).then(f=>f.list(p)); cache.set(k,{t:Date.now(),p:pr});
    pr.catch(()=>cache.delete(k)); return pr;
  }
  const fileRec=(m,p,e)=>({id:idOf(m,p),space:SP,name:e.name,folderId:idOf(m,mtSplit(p)[0]),mime:e.mime||mtMime(e.name),size:e.size>0?e.size:0,
    created:e.mtime||0,modified:e.mtime||0,meta:{mount:m.name},getBlob:async()=>(await Mounts.fsOf(m)).read(p)});
  const need=id=>{ const [mid,p]=split(id), m=Mounts.byId(mid); if(!m) throw new Error('this folder is no longer mounted'); return [m,p]; };
  const canWrite=async m=>{ const f=await Mounts.fsOf(m); if(!f.caps.write) throw new Error('"'+m.name+'" is read-only'); return f; };
  async function walk(){                                           // для поиска: все папки и файлы, не больше MAXW записей
    const dirs=[], files=[];
    for(const m of Mounts.list()){
      let es; try{ es=await mtWalk(await Mounts.fsOf(m),'',MAXW); }catch(e){ continue; }
      for(const e of es) (e.dir ? dirs.push(dirRec(m,e.path)) : files.push(fileRec(m,e.path,e)));
    }
    return {dirs,files};
  }
  async function freeName(m,dir,name){
    const have=new Set((await (await Mounts.fsOf(m)).list(dir).catch(()=>[])).map(e=>e.name));
    return typeof fsDedupName==='function' ? fsDedupName(name,have) : name;
  }
  return {
    async listFolders(space,parentId=null){
      if(parentId==null || parentId===FS_ROOT) return Mounts.list().filter(m=>!m.hidden).map(m=>dirRec(m,'')).sort((a,b)=>a.name.localeCompare(b.name));
      const [m,p]=need(parentId); return (await ls(m,p)).filter(e=>e.dir).map(e=>dirRec(m,mtJoin(p,e.name)));
    },
    async list(space,folderId=null){
      if(folderId==null || folderId===FS_ROOT) return [];
      const [m,p]=need(folderId); return (await ls(m,p)).filter(e=>!e.dir).map(e=>fileRec(m,mtJoin(p,e.name),e));
    },
    async allFolders(){ return (await walk()).dirs.concat(Mounts.list().filter(m=>!m.hidden).map(m=>dirRec(m,''))); },
    async listAll(){ return (await walk()).files; },
    async getFolder(id){ if(id==null || id===FS_ROOT) return null; const [m,p]=need(id); return dirRec(m,p); },
    async path(id){
      if(id==null || id===FS_ROOT) return [];
      const [m,p]=need(id), out=[dirRec(m,'')]; let acc='';
      for(const s of p.split('/').filter(Boolean)){ acc=mtJoin(acc,s); out.push(dirRec(m,acc)); }
      return out;
    },
    async get(id){
      const [m,p]=need(id), [d,n]=mtSplit(p), e=(await ls(m,d)).find(x=>x.name===n && !x.dir);
      return e ? fileRec(m,p,e) : undefined;
    },
    async usage(){ return {files:0,bytes:0}; },                    // считать чужую папку целиком — долго: менеджер показывает только число видимых
    async addFolder(space,name,parentId=null){
      if(parentId==null || parentId===FS_ROOT) throw new Error('Use "⛓ mount" to add a folder here');
      const [m,p]=need(parentId); await (await canWrite(m)).mkdir(mtJoin(p,name)); bust(); return idOf(m,mtJoin(p,name));
    },
    async renameFolder(id,name){
      const [m,p]=need(id);
      if(!p){ Mounts.rename(m.id,name); return; }                // корень: меняется только название монтирования
      await (await canWrite(m)).rename(p,name); bust();
    },
    async moveFolder(id,parentId){
      const [m,p]=need(id), [tm,tp]=need(parentId), to=mtJoin(tp,mtSplit(p)[1]);
      if(!p) throw new Error('a mounted folder itself cannot be moved');
      await mtCopy(await Mounts.fsOf(m),p,await canWrite(tm),to); await (await canWrite(m)).remove(p); bust();
    },
    async deleteFolder(id){
      const [m,p]=need(id);
      if(!p) return Mounts.unmount(m.id);                        // корень — только отключить
      await (await canWrite(m)).remove(p); bust();
    },
    async update(id,patch){
      const [m,p]=need(id), [d,n]=mtSplit(p);
      let to=p;
      if('name' in patch) to=mtJoin(d,patch.name);
      if('folderId' in patch){ const [tm,tp]=need(patch.folderId); if(tm.id!==m.id){ await mtCopy(await Mounts.fsOf(m),p,await canWrite(tm),mtJoin(tp,mtSplit(to)[1])); await (await canWrite(m)).remove(p); bust(); return; } to=mtJoin(tp,mtSplit(to)[1]); }
      if(to===p) return;
      const f=await canWrite(m);
      if(mtSplit(to)[0]===d && f.caps.rename) await f.rename(p,mtSplit(to)[1]);
      else{ await mtCopy(f,p,f,to); await f.remove(p); }
      bust();
    },
    async remove(id){ const [m,p]=need(id); await (await canWrite(m)).remove(p); bust(); },
    async removeMany(ids){ for(const id of ids){ const [m,p]=need(id); await (await canWrite(m)).remove(p); } bust(); },
    async copy(id,folderId=null){
      const [m,p]=need(id), [tm,tp]=folderId==null || folderId===FS_ROOT ? [m,mtSplit(p)[0]] : need(folderId);
      const dst=await canWrite(tm), nm=await freeName(tm,tp,mtSplit(p)[1]), to=mtJoin(tp,nm);
      await mtCopy(await Mounts.fsOf(m),p,dst,to); bust(); return idOf(tm,to);
    },
    async copyFolder(id,parentId=null){ return this.copy(id,parentId); },
    // удаление в смонтированной папке настоящее — вернуть нечем (менеджер спрашивает подтверждение и «Undo» не рисует)
    async snapshot(){ return null; },
    async importFile(space,file,folderId=null,name){
      if(folderId==null || folderId===FS_ROOT) throw new Error('Open a mounted folder first (or use "⛓ mount")');
      const [m,p]=need(folderId), f=await canWrite(m), nm=await freeName(m,p,name||file.name||'file');
      await f.write(mtJoin(p,nm),file); bust(); return idOf(m,mtJoin(p,nm));
    },
  };
})();

/* ---- узел: файлы смонтированной папки из графа ---- */
const MOUNTFS_ACTIONS=['read','write','list','mkdir','delete'];
// одно действие; возвращает {bin,text,size} — чистая обёртка над бэкендом, её же гоняет тест
async function mountfsDo(fs,action,path,bin){
  const dirLike=/[\\/]\s*$/.test(String(path||''));           // «папка/» — файл положить внутрь под именем из bin
  path=mtNorm(path);
  if(action==='list'){
    const es=await fs.list(path);
    return {text:es.map(e=>(e.dir ? 'd ' : 'f ')+(e.dir ? '-' : e.size)+' '+e.name+(e.dir ? '/' : '')).join('\n'),size:es.length};
  }
  if(action==='read'){ if(!path) throw new Error('path?'); const b=await fs.read(path); return {bin:binObj(new Uint8Array(await b.arrayBuffer()),mtSplit(path)[1],b.type||mtMime(path)),size:b.size}; }
  if(action==='write'){
    if(!bin || !bin.d) throw new Error('nothing on «bin»');
    const p=path && !dirLike ? path : mtJoin(path,bin.name||'file');
    await fs.write(p,new Blob([bin.d],{type:bin.mime||mtMime(p)})); return {text:p,size:bin.d.length};
  }
  if(action==='mkdir'){ if(!path) throw new Error('path?'); await fs.mkdir(path); return {text:path,size:0}; }
  if(action==='delete'){ if(!path) throw new Error('path?'); await fs.remove(path); return {text:path,size:0}; }
  throw new Error('unknown action');
}
async function mountfsRun(n){
  if(n.busy) return;
  n.busy=true; n.text='…';
  try{
    const path=n.pathIn || n.p.path, spec=String(n.p.mount||'').trim();
    const m=spec ? Mounts.byName(spec) || (spec==='memory' ? Mounts.scratch() : null) : Mounts.list()[0];
    if(!m) throw new Error(spec ? 'no mounted folder "'+spec+'" (⛓ mount in Files)' : 'nothing is mounted (⛓ mount in Files)');
    const r=await mountfsDo(await Mounts.fsOf(m),n.p.action,path,n.binIn);
    if(r.bin) n.res=r.bin; if(r.text!=null) n.list=r.text;
    n.size=r.size||0; n.ok=1; n.pulse=2; n.text=n.p.action+' '+(mtNorm(path)||'/')+' · ok'+(r.size!=null && n.p.action!=='mkdir' && n.p.action!=='delete' ? ' · '+r.size : '');
  }catch(e){ n.ok=0; n.text=String(e.message||e).slice(0,160); }
  n.busy=false;
}
def({ id:'mountfs', title:'Mounted Folder (read / write / list)', cat:'Sources', readout:true,
  kw:'mount mounted folder directory files disk read write list save delete sd card phone storage saf file system access папка диск смонтированная',
  ins:[{n:'go',t:'num'},{n:'path',t:'txt'},{n:'bin',t:'bin'}], outs:[{n:'bin',t:'bin'},{n:'list',t:'txt'},{n:'size',t:'num'},{n:'ok',t:'num'},{n:'new',t:'num'}],
  params:[
    {n:'mount',t:'text',d:'',label:'mounted folder (name as in Files → mounts; empty — the first; «memory» — a scratch folder in memory)'},
    {n:'action',t:'select',opts:MOUNTFS_ACTIONS,d:'read',label:'action (Run, or a rising edge on go)'},
    {n:'path',t:'text',d:'',label:'path inside the folder (the «path» input overrides; write: a folder path ending in / takes the file name from «bin»)'},
    {n:'run',t:'button',label:'Run',fn:n=>mountfsRun(n)}],
  init:n=>{ n.busy=false; n.prevGo=0; n.res=null; n.list=''; n.size=0; n.ok=0; n.pulse=0; n.text='mount a folder in Files (⛓ mount)'; n.pathIn=''; n.binIn=null; },
  process(n,I){
    n.pathIn=typeof I.path==='string' ? I.path : ''; n.binIn=I.bin||null;
    const go=(I.go||0)>.5; if(go && !n.prevGo) mountfsRun(n); n.prevGo=go;
    return {bin:n.res,list:n.list,size:n.size,ok:n.ok,new:binPulse(n)}; },
  draw:binReadout });
