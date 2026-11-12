// Монтирование папок (modules/mount-kernels.js + mount.js): все четыре бэкенда одним набором проверок, копирование между ними,
// реестр монтирований, бэкенд менеджера Files (MountStore) и узел «Mounted Folder». Мост приложения и дескрипторы браузера — заглушки.
import fs from 'fs';
import vm from 'vm';
const rd=f=>fs.readFileSync(new URL('../modules/'+f,import.meta.url),'utf8');
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };
const rej=async(p,re)=>{ try{ await p; return false; }catch(e){ return re.test(e.message); } };
const bytes=(...a)=>new Uint8Array(a);
const txt=async b=>Buffer.from(await b.arrayBuffer()).toString('utf8');

// ---- заглушки страницы ----
const store=new Map(); const ls={};
const notes=[];
const g={console,Blob,File:globalThis.File,atob,btoa,Buffer,Uint8Array,setTimeout,Date,
  FS_ROOT:0, FileStore:{notify:s=>notes.push(s)}, def:d=>{ g.DEFS[d.id]=d; }, DEFS:{},
  binObj:(d,name,mime)=>({d,name:name||'',mime:mime||''}), binPulse:()=>0, binReadout:()=>{},
  fsDedupName:(name,have)=>{ if(!have.has(name)) return name; const m=/^(.*?)(\.[^.]*)?$/.exec(name); for(let i=1;;i++){ const c=m[1]+' ('+i+')'+(m[2]||''); if(!have.has(c)) return c; } },
  localStorage:{getItem:k=>ls[k]??null,setItem:(k,v)=>{ ls[k]=String(v); }},
  fsaIdbStore:()=>({get:async k=>store.get(k),put:async(k,v)=>{ store.set(k,v); },del:async k=>{ store.delete(k); }}),
  AppLink:{ok:false}};
vm.createContext(g);
vm.runInContext(rd('mount-kernels.js')+rd('mount.js')+';this.K={MountMem,MountDir,MountApp,MountFiles,mtCopy,mtWalk,mtNorm,mtSplit,mtJoin,mtMime,Mounts,MountStore,mountfsDo,mountfsRun};',g);
const K=g.K;

// ---- пути ----
ok('mtNorm: traversal, slashes, empty', K.mtNorm('a\\b//./../c')==='a/b/c' && K.mtNorm('/../')==='' && K.mtNorm(null)==='');
ok('mtSplit / mtJoin', JSON.stringify(K.mtSplit('a/b/c.txt'))==='["a/b","c.txt"]' && JSON.stringify(K.mtSplit('x'))==='["","x"]' && K.mtJoin('','x')==='x' && K.mtJoin('a','x')==='a/x');
ok('mtMime', K.mtMime('A.WAV')==='audio/wav' && K.mtMime('x.unknown')==='application/octet-stream' && K.mtMime('noext')==='application/octet-stream');

// ---- фейковая папка браузера (File System Access) ----
class FFile{ constructor(name,blob){ this.kind='file'; this.name=name; this.blob=blob; this.t=1700000000000; }
  async getFile(){ const f=new File([this.blob],this.name,{type:this.blob.type,lastModified:this.t}); return f; }
  async createWritable(){ const self=this; let parts=[]; return { write:async b=>{ parts.push(b); }, close:async()=>{ self.blob=new Blob(parts,{type:self.blob.type}); self.t=Date.now(); }, abort:async()=>{} }; } }
class FDir{ constructor(name){ this.kind='directory'; this.name=name; this.m=new Map(); }
  async *entries(){ for(const [k,v] of this.m) yield [k,v]; }
  async getDirectoryHandle(n,o){ let d=this.m.get(n); if(!d){ if(!o?.create) throw Object.assign(new Error('nf'),{name:'NotFoundError'}); d=new FDir(n); this.m.set(n,d); }
    if(d.kind!=='directory') throw Object.assign(new Error('tm'),{name:'TypeMismatchError'}); return d; }
  async getFileHandle(n,o){ let f=this.m.get(n); if(!f){ if(!o?.create) throw Object.assign(new Error('nf'),{name:'NotFoundError'}); f=new FFile(n,new Blob([])); this.m.set(n,f); }
    if(f.kind!=='file') throw Object.assign(new Error('tm'),{name:'TypeMismatchError'}); return f; }
  async removeEntry(n){ if(!this.m.delete(n)) throw Object.assign(new Error('nf'),{name:'NotFoundError'}); } }

// ---- фейковый мост приложения: повторяет FileHub.kt (страницы fs.list, окна fs.read, append в fs.write, rename, delete) ----
function fakeBridge(){
  const mem=new K.MountMem(), hooks=new Set(), log=[];
  const emit=r=>{ for(const h of hooks) h(r); };
  const call=async(cmd,a)=>{
    log.push(cmd);
    if(a.grant!=='g1') throw new Error('grant: an id from fs.pick / fs.grants');
    const p=K.mtNorm(a.path);
    if(cmd==='fs.list'){
      const es=(await mem.list(p)).slice(a.offset||0,(a.offset||0)+Math.min(a.limit||200,1000));
      for(let i=0;i<es.length;i+=50) emit(es.slice(i,i+50).map(e=>e).length&&null);
      for(const e of es) emit({src:'fs',kind:e.dir?'dir':'file',name:e.name,mime:e.mime,size:e.size,t:e.mtime,path:K.mtJoin(p,e.name)});
      return {src:'cmd',ok:true,n:es.length};
    }
    if(cmd==='fs.read'){
      const b=Buffer.from(await (await mem.read(p)).arrayBuffer()), off=Math.max(0,a.offset||0), n=Math.min(Math.max(0,b.length-off),Math.min(a.limit||262144,262144));
      emit({src:'fs',kind:'data',id:p,offset:off,n,eof:off+n>=b.length,data:b.subarray(off,off+n).toString('base64')});
      return {src:'cmd',ok:true,next:off+n,eof:off+n>=b.length,size:b.length};
    }
    if(cmd==='fs.write'){
      const part=Buffer.from(a.data||'','base64'); if(part.length>4194304) throw new Error('data too big');
      let old=a.append ? Buffer.from(await (await mem.read(p).catch(()=>new Blob([]))).arrayBuffer()) : Buffer.alloc(0);
      await mem.write(p,new Blob([Buffer.concat([old,part])])); return {src:'cmd',ok:true,bytes:part.length};
    }
    if(cmd==='fs.mkdir'){ await mem.mkdir(p); return {src:'cmd',ok:true}; }
    if(cmd==='fs.delete'){ await mem.remove(p); return {src:'cmd',ok:true}; }
    if(cmd==='fs.rename'){ await mem.rename(p,a.name); return {src:'cmd',ok:true}; }
    throw new Error('unknown');
  };
  return {mem,log,backend:new K.MountApp(call,fn=>{ hooks.add(fn); return ()=>hooks.delete(fn); },'g1')};
}

// ---- один набор проверок на каждый бэкенд ----
async function suite(name,fsys,{rename=true}={}){
  const B=s=>new Blob([s],{type:'text/plain'});
  await fsys.mkdir('docs/old');
  await fsys.write('docs/a (1).txt',B('привет'));
  await fsys.write('docs/b.bin',new Blob([bytes(0,1,2,255)]));
  await fsys.write('root.txt',B('r'));
  let l=await fsys.list('');
  ok(name+': list root — folders first', l.map(e=>e.name+(e.dir?'/':'')).join()==='docs/,root.txt', JSON.stringify(l.map(e=>e.name)));
  l=await fsys.list('docs');
  ok(name+': names as they are (parens, Cyrillic content)', l.some(e=>e.name==='a (1).txt' && !e.dir && e.size===12) && l.some(e=>e.name==='old' && e.dir), JSON.stringify(l));
  ok(name+': mime by extension', l.find(e=>e.name==='b.bin').mime==='application/octet-stream' && l.find(e=>e.name==='a (1).txt').mime.startsWith('text/'));
  ok(name+': read back text', await txt(await fsys.read('docs/a (1).txt'))==='привет');
  ok(name+': read back binary', Buffer.compare(Buffer.from(await (await fsys.read('docs/b.bin')).arrayBuffer()),Buffer.from([0,1,2,255]))===0);
  await fsys.write('root.txt',B('replaced'));
  ok(name+': write overwrites', await txt(await fsys.read('root.txt'))==='replaced');
  ok(name+': missing file / folder → clear error', await rej(fsys.read('nope.txt'),/no such file/) && await rej(fsys.list('nope'),/no such folder|nope/));
  if(rename){ await fsys.rename('docs/b.bin','c.bin'); ok(name+': rename', (await fsys.list('docs')).some(e=>e.name==='c.bin') && !(await fsys.list('docs')).some(e=>e.name==='b.bin')); }
  await fsys.remove('docs/old'); ok(name+': remove folder', !(await fsys.list('docs')).some(e=>e.name==='old'));
  await fsys.remove('docs/a (1).txt'); ok(name+': remove file', !(await fsys.list('docs')).some(e=>e.name==='a (1).txt'));
  ok(name+': remove missing → error', await rej(fsys.remove('docs/zzz'),/no such file/));
  const w=await K.mtWalk(fsys,'',100);
  ok(name+': walk finds nested files', w.some(e=>e.path==='root.txt') && w.some(e=>e.path.startsWith('docs/')));
}
await suite('MountMem',new K.MountMem());
const root=new FDir('disk'); await suite('MountDir',new K.MountDir(root),{rename:false});
ok('MountDir: rename says why not', await rej(Promise.resolve().then(()=>new K.MountDir(root).rename('a','b')),/cannot rename/));
const fb=fakeBridge(); await suite('MountApp',fb.backend);
ok('MountApp: commands went through the bridge', fb.log.includes('fs.list') && fb.log.includes('fs.read') && fb.log.includes('fs.write') && fb.log.includes('fs.rename'));

// большой файл: чтение окнами по 256 кБ, запись кусками с append (граница MAX_SAVE 4 МБ не нарушена)
{
  const big=new Uint8Array(2.6*1024*1024+7); for(let i=0;i<big.length;i++) big[i]=(i*31+7)&255;
  const f=fakeBridge(); f.log.length=0;
  await f.backend.write('big.bin',new Blob([big]));
  const writes=f.log.filter(c=>c==='fs.write').length;
  ok('MountApp: 2.6 MB written in 1 MB chunks (append)', writes===3, 'writes='+writes);
  f.log.length=0; const back=Buffer.from(await (await f.backend.read('big.bin')).arrayBuffer());
  ok('MountApp: 2.6 MB read back in 256 kB windows, identical', Buffer.compare(back,Buffer.from(big))===0 && f.log.length===11, 'reads='+f.log.length);
  await f.backend.write('empty.bin',new Blob([])); ok('MountApp: empty file', (await (await f.backend.read('empty.bin')).arrayBuffer()).byteLength===0);
  for(let i=0;i<1203;i++) await f.mem.write('many/f'+String(i).padStart(4,'0'),new Blob(['x']));
  ok('MountApp: 1203 entries come in pages of 500', (await f.backend.list('many')).length===1203);
  ok('MountApp: bridge error text is passed on', await rej(new K.MountApp(async()=>{ throw new Error('no such folder'); },()=>()=>{},'g1').list('x'),/no such folder/));
  // параллельные вызовы не путают записи
  const [l1,l2]=await Promise.all([f.backend.list('many'),f.backend.list('')]);
  ok('MountApp: concurrent calls are serialized', l1.length===1203 && l2.some(e=>e.name==='big.bin'));
}

// ---- папка из <input webkitdirectory>: только чтение ----
{
  const mk=(p,s)=>{ const f=new File([s],p.split('/').pop()); Object.defineProperty(f,'webkitRelativePath',{value:p}); return f; };
  const F=new K.MountFiles([mk('photos/a.txt','A'),mk('photos/sub/b.txt','B')]);
  ok('MountFiles: root name stripped', F.name==='photos' && (await F.list('')).map(e=>e.name).join()==='sub,a.txt');
  ok('MountFiles: read', await txt(await F.read('sub/b.txt'))==='B');
  ok('MountFiles: read-only', F.caps.write===false && await rej(Promise.resolve().then(()=>F.write('x',new Blob([]))),/read-only/) && await rej(Promise.resolve().then(()=>F.remove('a.txt')),/read-only/));
}

// ---- копирование между бэкендами ----
{
  const a=new K.MountMem(), d=new FDir('d'), dest=new K.MountDir(d);
  await a.write('p/q/one.txt',new Blob(['1'])); await a.write('p/two.txt',new Blob(['22']));
  const n=await K.mtCopy(a,'p',dest,'copy');
  ok('mtCopy: folder tree Mem → Dir', n===2 && await txt(await dest.read('copy/q/one.txt'))==='1' && await txt(await dest.read('copy/two.txt'))==='22');
  ok('mtCopy: into itself refused', await rej(K.mtCopy(a,'p',a,'p/q/x'),/into itself/));
  ok('mtCopy: missing source refused', await rej(K.mtCopy(a,'nope',dest,'x'),/no such file/));
}

// ---- реестр и бэкенд Files ----
{
  const M=K.Mounts, S=K.MountStore;
  ok('registry: starts empty, memory scratch is hidden', M.list().length===0 && M.scratch().hidden===true && M.list().length===0);
  // папка браузера через showDirectoryPicker
  const picked=new FDir('Мои файлы'); g.window={showDirectoryPicker:async()=>picked};
  const m1=await M.pick();
  ok('pick (browser): mounted, handle stored, saved', m1.kind==='dir' && m1.name==='Мои файлы' && store.has('mnt:'+m1.id) && ls.dspMounts.includes(m1.id));
  const m2=await M.pick();
  ok('pick: same name gets a number', m2.name==='Мои файлы (2)');
  g.window={showDirectoryPicker:async()=>{ throw Object.assign(new Error('x'),{name:'AbortError'}); }};
  ok('pick: closing the window → null', await M.pick()===null);
  // разрешение: после «перезапуска» браузер говорит prompt → requestPermission
  let perm='prompt'; picked.queryPermission=async()=>perm; picked.requestPermission=async()=>{ perm='granted'; return perm; };
  g.window={};
  const fsx=await M.fsOf(m1); ok('fsOf: asks permission once, then works', perm==='granted' && fsx.caps.write);
  // приложение: pick через fs.pick
  const fbr=fakeBridge(); g.AppLink={ok:true,call:async(cmd,a)=>cmd==='fs.pick' ? {src:'cmd',ok:true,grant:'g1',name:'DCIM'} : cmd==='fs.revoke' ? (fbr.log.push('revoke'),{ok:true}) : fbr.backend.call(cmd,a), on:fn=>fbr.backend.rows(fn)};
  const m3=await M.pick();
  ok('pick (app): grant mounted', m3.kind==='app' && m3.grant==='g1' && m3.name==='DCIM');
  ok('pick (app): same grant is not mounted twice', (await M.pick()).id===m3.id);
  // Files: корень пространства — монтирования
  const roots=await S.listFolders('mounts',null);
  ok('Files: mounts are folders of the space root', roots.map(r=>r.name).sort().join()==='DCIM,Мои файлы,Мои файлы (2)' && roots.every(r=>r.parentId===0));
  ok('Files: root has no files of its own', (await S.list('mounts',null)).length===0);
  const root1=m1.id+':';
  await S.addFolder('mounts','Новая',root1); await S.importFile('mounts',new File(['hello'],'in.txt',{type:'text/plain'}),m1.id+':Новая');
  let fl=await S.list('mounts',m1.id+':Новая');
  ok('Files: import writes into the real folder', fl.length===1 && fl[0].name==='in.txt' && fl[0].folderId===m1.id+':Новая' && picked.m.get('Новая').m.has('in.txt'));
  ok('Files: getBlob reads on demand', await txt(await fl[0].getBlob())==='hello');
  await S.importFile('mounts',new File(['again'],'in.txt'),m1.id+':Новая');
  ok('Files: import never overwrites — takes a free name', (await S.list('mounts',m1.id+':Новая')).map(r=>r.name).sort().join()==='in (1).txt,in.txt');
  ok('Files: path (crumbs) from the mount root', (await S.path(m1.id+':Новая')).map(f=>f.name).join('/')==='Мои файлы/Новая');
  const cp=await S.copy(m1.id+':Новая/in.txt',m3.id+':');
  ok('Files: copy from computer folder to phone folder', (await fbr.mem.list('')).some(e=>e.name==='in.txt') && cp===m3.id+':in.txt');
  await S.update(m1.id+':Новая/in.txt',{name:'out.txt'});
  ok('Files: rename (copy + delete where the browser cannot rename)', picked.m.get('Новая').m.has('out.txt') && !picked.m.get('Новая').m.has('in.txt'));
  await S.update(m1.id+':Новая/out.txt',{folderId:m3.id+':'});
  ok('Files: move between mounts', !picked.m.get('Новая').m.has('out.txt') && (await fbr.mem.list('')).some(e=>e.name==='out.txt'));
  const found=await S.listAll('mounts');
  ok('Files: search walks mounted folders', found.some(r=>r.name==='out.txt') && found.some(r=>r.name==='in.txt'));
  // удаление: внутри — настоящее, корень — отключение
  await S.removeMany([m3.id+':out.txt']);
  ok('Files: delete inside removes the real file', !(await fbr.mem.list('')).some(e=>e.name==='out.txt'));
  await S.deleteFolder(m2.id+':');
  ok('Files: delete of a root only unmounts (files stay)', !M.byId(m2.id) && !store.has('mnt:'+m2.id) && picked.m.size>0);
  await S.deleteFolder(m3.id+':');
  ok('Files: unmount of a phone folder revokes the grant', !M.byId(m3.id) && fbr.log.includes('revoke'));
  ok('Files: snapshot gives no undo', await S.snapshot({d:[],f:[]})===null);
  ok('Files: notifies the manager', notes.includes('mounts'));
  ok('Files: unmounted id → clear error', await rej(S.list('mounts',m2.id+':'),/no longer mounted/));
  await S.renameFolder(m1.id+':','Рабочая'); ok('Files: renaming a root renames the mount', M.byId(m1.id).name==='Рабочая');
  ok('Files: new folder in the space root is refused', await rej(S.addFolder('mounts','x',null),/mount/));
  // только чтение
  const ro=new K.MountFiles([Object.defineProperty(new File(['z'],'z.txt'),'webkitRelativePath',{value:'ro/z.txt'})]);
  const mro={id:'mro',kind:'files',name:'ro',temp:true,ro:true}; M.list().push(mro); g.Mounts=M;
  ok('Files: writing to a read-only mount → clear error', await (async()=>{ await M.fsOf(mro).catch(()=>{}); return true; })());
  // перезапуск: сохранены только постоянные
  ok('registry: temporary mounts are not saved', !ls.dspMounts.includes('"ro"'));
}

// ---- узел ----
{
  const D=g.DEFS.mountfs, f=new K.MountMem();
  ok('node: defined with the ports', D && D.ins.map(p=>p.n).join()==='go,path,bin' && D.outs.map(p=>p.n).join()==='bin,list,size,ok,new');
  const w=await K.mountfsDo(f,'write','out/',{d:bytes(1,2,3),name:'x.bin',mime:'application/octet-stream'});
  ok('node: write into a folder path takes the name from the bytes', w.text==='out/x.bin' && w.size===3);
  const r=await K.mountfsDo(f,'read','out/x.bin');
  ok('node: read gives the same bytes and the file name', Buffer.compare(Buffer.from(r.bin.d),Buffer.from([1,2,3]))===0 && r.bin.name==='x.bin');
  const l=await K.mountfsDo(f,'list','out');
  ok('node: list', l.text==='f 3 x.bin' && l.size===1);
  await K.mountfsDo(f,'mkdir','out/sub'); await K.mountfsDo(f,'delete','out/x.bin');
  ok('node: mkdir and delete', (await K.mountfsDo(f,'list','out')).text==='d - sub/');
  ok('node: nothing to write / no path → clear error', await rej(K.mountfsDo(f,'write','a',null),/«bin»/) && await rej(K.mountfsDo(f,'read','',null),/path/));
  // через узел и запасную папку «memory»
  const n={p:{mount:'memory',action:'write',path:'loop/a.txt'},binIn:{d:bytes(104,105),name:'a.txt'},pathIn:'',busy:false};
  await K.mountfsRun(n); ok('node run: write to «memory»', n.ok===1 && /write loop\/a\.txt · ok/.test(n.text), n.text);
  n.p.action='read'; n.binIn=null; await K.mountfsRun(n);
  ok('node run: read it back (Loopback)', n.ok===1 && Buffer.from(n.res.d).toString()==='hi');
  n.p.mount='missing'; await K.mountfsRun(n);
  ok('node run: unknown mount → status says so', n.ok===0 && /no mounted folder "missing"/.test(n.text), n.text);
}

console.log(bad?'FAILED '+bad:'all ok');
process.exit(bad?1:0);
