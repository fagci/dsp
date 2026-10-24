// modules/fsaccess.js: выбор файла на диске, дескрипторы в хранилище, разрешения (без браузера, хранилище и picker — заглушки)
import fs from 'fs';
import vm from 'vm';
const src=fs.readFileSync(new URL('../modules/fsaccess.js',import.meta.url),'utf8');
const g={console}; vm.createContext(g); vm.runInContext(src+';this.makeFSA=makeFSA;',g);
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };
const mkStore=()=>{ const m=new Map(); return {m,get:async k=>m.get(k),put:async(k,v)=>{ m.set(k,v); },del:async k=>{ m.delete(k); }}; };
const handle=(name,perm='granted',after='granted')=>({name,calls:[],
  async queryPermission(){ return perm; }, async requestPermission(){ this.calls.push('req'); perm=after; return perm; },
  async getFile(){ if(this.gone) throw new Error('NotFoundError'); return {name}; }});

let F=g.makeFSA({store:mkStore(),picker:null});
ok('без picker: supported=false',F.supported===false);
let e=null; try{ await F.pick(); }catch(x){ e=x; } ok('без picker: pick бросает',!!e);

let st=mkStore(), h1=handle('a.sigmf-meta'), h2=handle('a.sigmf-data');
F=g.makeFSA({store:st,picker:async o=>{ F.last=o; return [h1,h2]; }});
let r=await F.pick({multiple:true});
ok('pick: ключ и имена',/^h/.test(r.key) && r.names.join()==='a.sigmf-meta,a.sigmf-data' && F.last.multiple===true);
ok('pick: дескрипторы в хранилище',st.m.get(r.key).length===2);
let f=await F.files(r.key,false);
ok('files: разрешение есть — файлы без запроса',f.files.length===2 && h1.calls.length===0);

F=g.makeFSA({store:st,picker:async()=>{ const e=new Error('x'); e.name='AbortError'; throw e; }});
ok('pick: отмена → null',await F.pick()===null);
F=g.makeFSA({store:st,picker:async()=>[]}); ok('pick: пусто → null',await F.pick()===null);

// нужен запрос: автозагрузка (prompt=false) не просит, клик (true) просит
const h3=handle('x.cu8','prompt','granted'); st=mkStore(); await st.put('k',[h3]);
F=g.makeFSA({store:st,picker:async()=>[]});
f=await F.files('k',false); ok('prompt=false: need, запрос не вызван',f.need===true && f.names[0]==='x.cu8' && h3.calls.length===0);
f=await F.files('k',true); ok('prompt=true: запрос и файл',h3.calls.length===1 && f.files[0].name==='x.cu8');
const h4=handle('y.cu8','prompt','denied'); await st.put('d',[h4]);
f=await F.files('d',true); ok('отказ пользователя → need',f.need===true);
ok('нет ключа → gone',(await F.files('nope',true)).gone===true);
const h5=handle('z.cu8'); h5.gone=true; await st.put('z',[h5]);
f=await F.files('z',false); ok('файл удалён → gone с причиной',f.gone===true && /NotFound/.test(f.error));
await F.forget('z'); ok('forget',!st.m.has('z'));
console.log(bad?'FAILED':'all ok'); process.exit(bad?1:0);
