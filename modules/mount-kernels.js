"use strict";
/* ============================ Монтирование папок: ядро (без DOM) ============================
   Папка с диска или телефона выглядит в Files одинаково, чем бы она ни была. Интерфейс бэкенда (пути — «a/b/c.txt», пусто — корень):
     list(path) → [{name,dir,size,mtime,mime}]   read(path) → Blob   write(path,blob)   mkdir(path)   remove(path)   rename(path,name)
     caps — {write:bool, rename:bool}: что умеет (список из папок браузера только читается).
   Бэкенды:
     MountDir(handle)  — File System Access API (Chrome / Edge / Opera и др.): настоящая папка компьютера, запись на месте;
     MountApp(call,rows,grant) — приложение Android: папка, выбранная в системном окне (SAF, команды fs.*) — call(cmd,args) → ответ,
                          rows(fn) → отписка: записи моста (списки и куски файлов приходят записями до ответа);
     MountFiles(files) — «папка» из <input webkitdirectory> (Firefox, Safari): только чтение, на время сессии;
     MountMem()        — память: запасная «папка» без разрешений (тесты, пресет, браузер без выбора папок).
   Ошибки бросают Error с понятным текстом. Чистая логика — здесь, привязка к странице и Files — в mount.js. */

const MT_MIME={txt:'text/plain',csv:'text/csv',json:'application/json',xml:'application/xml',html:'text/html',md:'text/markdown',log:'text/plain',
  wav:'audio/wav',mp3:'audio/mpeg',ogg:'audio/ogg',oga:'audio/ogg',opus:'audio/ogg',flac:'audio/flac',m4a:'audio/mp4',aac:'audio/aac',
  jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',bmp:'image/bmp',svg:'image/svg+xml',
  mp4:'video/mp4',webm:'video/webm',mkv:'video/x-matroska',mov:'video/quicktime',pdf:'application/pdf',zip:'application/zip'};
function mtMime(name){ const m=/\.([A-Za-z0-9]+)$/.exec(name||''); return (m && MT_MIME[m[1].toLowerCase()]) || 'application/octet-stream'; }
// «a\b//./../c» → «a/b/c»: выйти из папки нельзя
function mtNorm(p){ return String(p==null ? '' : p).split(/[\\/]+/).filter(s=>s && s!=='.' && s!=='..').join('/'); }
function mtSplit(p){ p=mtNorm(p); const i=p.lastIndexOf('/'); return i<0 ? ['',p] : [p.slice(0,i),p.slice(i+1)]; }
function mtJoin(d,n){ return d ? d+'/'+n : n; }
const mtSort=a=>a.sort((x,y)=>(x.dir===y.dir ? 0 : x.dir ? -1 : 1) || String(x.name).localeCompare(String(y.name),undefined,{numeric:true}));
const mtRO=()=>{ throw new Error('this folder is read-only (opened without write access)'); };

// ---- память ----
class MountMem{
  constructor(){ this.files=new Map(); this.dirs=new Set(); this.caps={write:true,rename:true}; }
  _ensure(p){ for(let d=mtSplit(p)[0];d;d=mtSplit(d)[0]) this.dirs.add(d); }
  async list(path){
    const p=mtNorm(path), out=new Map();
    if(p && !this.dirs.has(p) && ![...this.files.keys()].some(k=>k.startsWith(p+'/'))) throw new Error('no such folder: '+p);
    for(const [k,f] of this.files){ const [d,n]=mtSplit(k); if(d===p) out.set(n,{name:n,dir:false,size:f.blob.size,mtime:f.mtime,mime:f.blob.type||mtMime(n)}); }
    for(const d of this.dirs){ const [pd,n]=mtSplit(d); if(pd===p && !out.has(n)) out.set(n,{name:n,dir:true,size:-1,mtime:0,mime:''}); }
    return mtSort([...out.values()]);
  }
  async read(path){ const f=this.files.get(mtNorm(path)); if(!f) throw new Error('no such file: '+mtNorm(path)); return f.blob; }
  async write(path,blob){
    const p=mtNorm(path); if(!p) throw new Error('file name?'); if(this.dirs.has(p)) throw new Error('"'+p+'" is a folder');
    this._ensure(p); this.files.set(p,{blob:blob.type ? blob : new Blob([blob],{type:mtMime(p)}),mtime:Date.now()});
  }
  async mkdir(path){ const p=mtNorm(path); if(this.files.has(p)) throw new Error('"'+p+'" is a file'); if(p){ this.dirs.add(p); this._ensure(p); } }
  async remove(path){
    const p=mtNorm(path); if(!p) throw new Error('cannot delete the root');
    let hit=this.files.delete(p) | this.dirs.delete(p);
    for(const k of [...this.files.keys()]) if(k.startsWith(p+'/')){ this.files.delete(k); hit=1; }
    for(const d of [...this.dirs]) if(d.startsWith(p+'/')){ this.dirs.delete(d); hit=1; }
    if(!hit) throw new Error('no such file: '+p);
  }
  async rename(path,name){
    const p=mtNorm(path), [d]=mtSplit(p), to=mtJoin(d,mtNorm(name));
    if(!name || mtNorm(name)!==String(name)) throw new Error('bad name');
    if(this.files.has(to) || this.dirs.has(to)) throw new Error('"'+name+'" already exists');
    if(this.files.has(p)){ this.files.set(to,this.files.get(p)); this.files.delete(p); return; }
    if(!this.dirs.has(p)) throw new Error('no such file: '+p);
    for(const [k,f] of [...this.files]) if(k.startsWith(p+'/')){ this.files.delete(k); this.files.set(to+k.slice(p.length),f); }
    for(const x of [...this.dirs]) if(x===p || x.startsWith(p+'/')){ this.dirs.delete(x); this.dirs.add(to+x.slice(p.length)); }
  }
}

// ---- <input webkitdirectory>: только чтение ----
class MountFiles{
  constructor(files){
    this.caps={write:false,rename:false}; this.files=new Map(); this.dirs=new Set(); this.name='';
    for(const f of files){
      const rel=String(f.webkitRelativePath||f.name).split('/'); if(!this.name && rel.length>1) this.name=rel[0];
      const p=mtNorm(rel.length>1 ? rel.slice(1).join('/') : rel[0]); if(!p) continue;
      this.files.set(p,f); for(let d=mtSplit(p)[0];d;d=mtSplit(d)[0]) this.dirs.add(d);
    }
  }
  async list(path){
    const p=mtNorm(path), out=new Map();
    if(p && !this.dirs.has(p)) throw new Error('no such folder: '+p);
    for(const [k,f] of this.files){ const [d,n]=mtSplit(k); if(d===p) out.set(n,{name:n,dir:false,size:f.size,mtime:f.lastModified||0,mime:f.type||mtMime(n)}); }
    for(const d of this.dirs){ const [pd,n]=mtSplit(d); if(pd===p) out.set(n,{name:n,dir:true,size:-1,mtime:0,mime:''}); }
    return mtSort([...out.values()]);
  }
  async read(path){ const f=this.files.get(mtNorm(path)); if(!f) throw new Error('no such file: '+mtNorm(path)); return f; }
  write(){ mtRO(); } mkdir(){ mtRO(); } remove(){ mtRO(); } rename(){ mtRO(); }
}

// ---- File System Access (папка компьютера) ----
class MountDir{
  constructor(handle){ this.h=handle; this.caps={write:true,rename:false}; }
  async _dir(path,create){
    let d=this.h;
    for(const s of mtNorm(path).split('/').filter(Boolean)){
      try{ d=await d.getDirectoryHandle(s,{create:!!create}); }
      catch(e){ throw new Error(e && e.name==='TypeMismatchError' ? '"'+s+'" is a file' : 'no such folder: '+s); }
    }
    return d;
  }
  async list(path){
    const d=await this._dir(path,false), out=[], pend=[];
    for await(const [name,h] of d.entries()){
      if(h.kind==='directory') out.push({name,dir:true,size:-1,mtime:0,mime:''});
      else pend.push([name,h]);
    }
    for(let i=0;i<pend.length;i+=32){                                   // размер и дата — только из File: по 32 за раз
      await Promise.all(pend.slice(i,i+32).map(async([name,h])=>{
        try{ const f=await h.getFile(); out.push({name,dir:false,size:f.size,mtime:f.lastModified||0,mime:f.type||mtMime(name)}); }
        catch(e){ out.push({name,dir:false,size:0,mtime:0,mime:mtMime(name)}); }       // занят другой программой — в списке остаётся
      }));
    }
    return mtSort(out);
  }
  async _file(path,create){
    const [d,n]=mtSplit(path); if(!n) throw new Error('file name?');
    const dir=await this._dir(d,create);
    try{ return await dir.getFileHandle(n,{create:!!create}); }
    catch(e){ throw new Error(e && e.name==='TypeMismatchError' ? '"'+n+'" is a folder' : 'no such file: '+mtNorm(path)); }
  }
  async read(path){ return (await this._file(path,false)).getFile(); }
  async write(path,blob){
    const fh=await this._file(path,true), w=await fh.createWritable();
    try{ await w.write(blob); await w.close(); } catch(e){ try{ await w.abort(); }catch(x){} throw e; }
  }
  async mkdir(path){ await this._dir(path,true); }
  async remove(path){
    const [d,n]=mtSplit(path); if(!n) throw new Error('cannot delete the root');
    const dir=await this._dir(d,false);
    try{ await dir.removeEntry(n,{recursive:true}); } catch(e){ throw new Error(e && e.name==='NotFoundError' ? 'no such file: '+mtNorm(path) : e.message||String(e)); }
  }
  rename(){ throw new Error('the browser cannot rename in place: copy and delete instead'); }
}

// ---- приложение Android: SAF через мост (команды fs.*) ----
class MountApp{
  constructor(call,rows,grant){ this.call=call; this.rows=rows; this.grant=grant; this.caps={write:true,rename:true}; this.q=Promise.resolve(); }
  // записи моста не помечены номером команды, поэтому команды идут по одной
  _run(fn){ const r=this.q.then(fn,fn); this.q=r.catch(()=>{}); return r; }
  async _cmd(cmd,args,keep){
    const got=[], off=this.rows(r=>{ if(r && r.src==='fs' && keep(r)) got.push(r); });
    try{ const reply=await this.call(cmd,{grant:this.grant,...args}); return {got,reply}; }
    catch(e){ throw new Error(e && e.message || String(e)); }
    finally{ off(); }
  }
  list(path){
    return this._run(async()=>{
      const out=[], PAGE=500;
      for(let off=0;;off+=PAGE){
        const {got}=await this._cmd('fs.list',{path:mtNorm(path),limit:PAGE,offset:off},r=>r.kind==='dir'||r.kind==='file');
        for(const r of got) out.push({name:String(r.name),dir:r.kind==='dir',size:r.kind==='dir' ? -1 : +r.size>=0 ? +r.size : 0,mtime:+r.t||0,mime:r.kind==='dir' ? '' : r.mime||mtMime(r.name)});
        if(got.length<PAGE) break;
      }
      return mtSort(out);
    });
  }
  read(path,onProgress){
    return this._run(async()=>{
      const parts=[]; let off=0, size=-1;
      for(;;){
        const {got,reply}=await this._cmd('fs.read',{path:mtNorm(path),offset:off,limit:262144},r=>r.kind==='data');
        const r=got[got.length-1]; if(!r) throw new Error('no data from the phone');
        if(r.data){ const b=mtB64(r.data); if(b.length) parts.push(b); off+=b.length; }
        if(reply && +reply.size>=0) size=+reply.size;
        onProgress?.(off,size);
        if(r.eof || !(+r.n>0)) break;
      }
      return new Blob(parts,{type:mtMime(path)});
    });
  }
  write(path,blob){
    return this._run(async()=>{
      const CH=1<<20; let off=0;
      do{
        const part=new Uint8Array(await blob.slice(off,off+CH).arrayBuffer());
        await this._cmd('fs.write',{path:mtNorm(path),data:mtToB64(part),append:off>0,mime:blob.type||mtMime(path)},()=>false);
        off+=CH;
      }while(off<blob.size);
    });
  }
  mkdir(path){ return this._run(()=>this._cmd('fs.mkdir',{path:mtNorm(path)},()=>false)); }
  remove(path){ return this._run(()=>this._cmd('fs.delete',{path:mtNorm(path)},()=>false)); }
  rename(path,name){ return this._run(()=>this._cmd('fs.rename',{path:mtNorm(path),name},()=>false)); }
}
function mtB64(s){ const b=typeof atob==='function' ? atob(s) : Buffer.from(s,'base64').toString('binary'), u=new Uint8Array(b.length); for(let i=0;i<b.length;i++) u[i]=b.charCodeAt(i); return u; }
function mtToB64(u){
  if(typeof btoa!=='function') return Buffer.from(u).toString('base64');
  let s=''; for(let i=0;i<u.length;i+=0x8000) s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));
  return btoa(s);
}

// копия файла или папки между любыми двумя бэкендами (и внутри одного): возвращает число файлов
async function mtCopy(from,fp,to,tp){
  const st=(await from.list(mtSplit(fp)[0])).find(e=>e.name===mtSplit(fp)[1]);
  if(!st) throw new Error('no such file: '+fp);
  if(!st.dir){ await to.write(tp,await from.read(fp)); return 1; }
  if(from===to && (tp===fp || tp.startsWith(fp+'/'))) throw new Error('cannot copy a folder into itself');
  await to.mkdir(tp); let n=0;
  for(const e of await from.list(fp)) n+=await mtCopy(from,mtJoin(fp,e.name),to,mtJoin(tp,e.name));
  return n;
}
// обход вглубь (для поиска): не больше max записей и depth уровней
async function mtWalk(fs,path='',max=5000,depth=8){
  const out=[]; const q=[[mtNorm(path),0]];
  while(q.length && out.length<max){
    const [p,d]=q.shift(); let es; try{ es=await fs.list(p); }catch(e){ continue; }
    for(const e of es){ const full=mtJoin(p,e.name); out.push({...e,path:full}); if(e.dir && d<depth) q.push([full,d+1]); if(out.length>=max) break; }
  }
  return out;
}
