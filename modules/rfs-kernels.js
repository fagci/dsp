"use strict";
/* Удалённые файловые системы под общий интерфейс vfs (stat / list / read / write / mkdir / remove / rename) — как VfsMem и VfsFiles:
   ftp://, smb://, tftp://, http(s)://. Серверы приложения (HTTP, FTP, TFTP) отдают через такой vfs не папку в Files, а чужую шару —
   это и есть мост: FTP-сервер над SMB-папкой, TFTP-сервер над FTP камеры, HTTP над NAS. rfsCopy копирует файл или дерево между любыми двумя.
   Нужны netsock-kernels.js, http-kernels.js, ftp-kernels.js, netmisc-kernels.js (TFTP), smb-kernels.js. Без DOM — tools/test-rfs.mjs. */

/* ---------- адрес ---------- */
// ftp://user:pass@host[:port]/path · smb://[DOMAIN;]user:pass@host[:port]/SHARE/path · tftp://host[:port]/path · http(s)://[user:pass@]host[:port]/path
function rfsParseUrl(s){
  const m=/^([a-z][a-z0-9+.-]*):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?(\[[^\]]+\]|[^:/?#]+)?(?::(\d+))?([^?#]*)(\?[^#]*)?/i.exec(String(s||'').trim());
  if(!m) throw new Error('expected scheme://host/path, e.g. smb://nas/share/dir');
  const dd=x=>{ try{ return decodeURIComponent(x); }catch(e){ return x; } };
  const scheme=m[1].toLowerCase();
  if(!['ftp','smb','tftp','http','https','files'].includes(scheme)) throw new Error('unknown scheme «'+scheme+'»: ftp, smb, tftp, http, https or files');
  const segs=(m[6]||'').split('/').filter(Boolean).map(dd);
  const u={scheme,user:m[2]!=null ? dd(m[2]) : '',pass:m[3]!=null ? dd(m[3]) : '',host:(m[4]||'').replace(/^\[|\]$/g,''),port:+m[5]||0,domain:'',share:'',segs,path:'/'+segs.join('/'),raw:String(s).trim()};
  if(scheme==='files'){ u.path='/'+[m[4]||'',...segs].filter(Boolean).join('/'); return u; }       // files://Share/sub — папка в Files
  if(!u.host) throw new Error('no host in the address');
  const dm=/^(.*)[;\\](.*)$/.exec(u.user); if(dm){ u.domain=dm[1]; u.user=dm[2]; }
  if(scheme==='smb'){ u.share=segs[0]||''; u.path='/'+segs.slice(1).join('/'); }
  if(scheme==='http' || scheme==='https') u.path=(m[6]||'/')||'/';
  return u;
}
const rfsJoin=(a,b)=>vfsNorm((a||'/')+'/'+(b||''));
const rfsIsDead=e=>/closed|not connected|did not answer|reset|broken pipe|timeout|421|no answer|socket|bridge/i.test(String(e&&e.message||e));
const rfsIsNotFound=e=>/not found|no such|550|path|does not exist|404/i.test(String(e&&e.message||e));
function rfsFtpDate(s){                                       // «Jan  1 12:00» / «Feb 10 2020» / DOS «01-02-23 10:30AM» → мс UTC, 0 если не вышло
  if(!s) return 0;
  const MON=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  let m=/^(\w{3})\s+(\d+)\s+(\d{1,2}):(\d\d)$/.exec(s);
  if(m){ const mo=MON.indexOf(m[1].toLowerCase()); if(mo<0) return 0; const now=new Date(); let y=now.getUTCFullYear(); let t=Date.UTC(y,mo,+m[2],+m[3],+m[4]); if(t>now.getTime()+864e5) t=Date.UTC(y-1,mo,+m[2],+m[3],+m[4]); return t; }
  m=/^(\w{3})\s+(\d+)\s+(\d{4})$/.exec(s);
  if(m){ const mo=MON.indexOf(m[1].toLowerCase()); return mo<0 ? 0 : Date.UTC(+m[3],mo,+m[2]); }
  m=/^(\d\d)-(\d\d)-(\d\d)\s+(\d\d):(\d\d)([AP])M$/.exec(s);
  if(m){ let h=+m[4]%12+(m[6]==='P' ? 12 : 0); return Date.UTC(+m[3]>69 ? 1900+ +m[3] : 2000+ +m[3],+m[1]-1,+m[2],h,+m[5]); }
  return 0;
}

/* ---------- бэкенды: один протокол — один маленький класс ---------- */
class RfsFtp{
  constructor(ns,u){ this.ns=ns; this.u=u; this.c=null; this.ls=new Map(); this.ranged=false; }
  async connect(){ const c=new FtpClient(this.ns); await c.connect(this.u.host,this.u.port||21,this.u.user||'anonymous',this.u.pass||'dsp@'); this.c=c; }
  async close(){ const c=this.c; this.c=null; if(c) await c.quit().catch(()=>{}); }
  _drop(){ this.ls.clear(); }
  async list(p){
    const hit=this.ls.get(p); if(hit && Date.now()-hit.t<1500) return hit.v;
    const v=(await this.c.list(p==='/' ? '' : p)).map(f=>({name:f.name,dir:f.dir,size:f.size||0,mtime:rfsFtpDate(f.date)}));
    this.ls.set(p,{t:Date.now(),v}); return v;
  }
  async stat(p){
    if(p==='/') return {name:'',dir:true,size:0,mtime:0};
    const [dir,name]=vfsSplit(p); let l; try{ l=await this.list(dir); }catch(e){ if(rfsIsNotFound(e)) return null; throw e; }
    return l.find(f=>f.name===name)||null;
  }
  async read(p){ return this.c.get(p); }
  async write(p,b){ this._drop(); await this.c.put(p,b); }
  async mkdir(p){ this._drop(); let cur=''; for(const s of p.split('/').filter(Boolean)){ cur+='/'+s; try{ await this.c.mkd(cur); }catch(e){ if(!/550|exist/i.test(e.message)) throw e; } } }
  async rmfile(p){ this._drop(); await this.c.del(p); }
  async rmdir(p){ this._drop(); await this.c.rmd(p); }
  async rename(a,b){ this._drop(); await this.c.rename(a,b); }
}
class RfsSmb{
  constructor(ns,u,opt){ this.ns=ns; this.u=u; this.opt=opt||{}; this.c=null; this.ranged=true; }
  async connect(){
    if(!this.u.share) throw new Error('smb address needs a share: smb://host/SHARE/path');
    const c=new SmbClient(this.ns,{user:this.u.user,pass:this.u.pass,domain:this.u.domain,rnd:this.opt.rnd,sign:this.opt.sign}); await c.connect(this.u.host,this.u.port||445,this.u.share); this.c=c;
  }
  async close(){ const c=this.c; this.c=null; if(c) await c.close(); }
  stat(p){ return this.c.stat(p); }
  list(p){ return this.c.list(p); }
  read(p,a,b){ return this.c.read(p,a,b); }
  write(p,b){ return this.c.write(p,b); }
  mkdir(p){ return this.c.mkdir(p); }
  rmfile(p){ return this.c.remove(p); }
  rmdir(p){ return this.c.remove(p); }
  rename(a,b){ return this.c.rename(a,b); }
}
class RfsTftp{                                                // у TFTP нет ни списка, ни папок, ни удаления: читать и писать файл по имени
  constructor(ns,u){ this.ns=ns; this.u=u; this.ranged=false; this.hit=null; }
  async connect(){}
  async close(){}
  async _get(p){
    if(this.hit && this.hit.p===p && Date.now()-this.hit.t<5000) return this.hit.d;
    let d;
    try{ d=await tftpGet(this.ns,this.u.host,this.u.port||69,p.replace(/^\//,''),{blksize:1428,windowsize:4,timeout:2000}); }
    catch(e){ if(/option|illegal/i.test(e.message)) d=await tftpGet(this.ns,this.u.host,this.u.port||69,p.replace(/^\//,''),{timeout:2000}); else throw e; }
    this.hit={p,d,t:Date.now()}; return d;
  }
  async stat(p){
    if(p==='/') return {name:'',dir:true,size:0,mtime:0};
    try{ const d=await this._get(p); return {name:vfsSplit(p)[1],dir:false,size:d.length,mtime:0}; }
    catch(e){ if(/not found|no such|access violation/i.test(e.message)) return null; throw e; }
  }
  async list(){ return []; }
  read(p){ return this._get(p); }
  async write(p,b){ this.hit=null; await tftpPut(this.ns,this.u.host,this.u.port||69,p.replace(/^\//,''),b,{blksize:1428,timeout:2000}); }
  async mkdir(){ throw new Error('TFTP has no folders'); }
  async rmfile(){ throw new Error('TFTP cannot delete files'); }
  async rmdir(){ throw new Error('TFTP has no folders'); }
  async rename(){ throw new Error('TFTP cannot rename files'); }
}
class RfsHttp{                                                // GET / HEAD / PUT / DELETE; список — ?json нашего сервера или ссылки в HTML-индексе (Apache, nginx, python -m http.server)
  constructor(ns,u){ this.ns=ns; this.u=u; this.ranged=false; }
  async connect(){}
  async close(){}
  _url(p,dir){
    const base=this.u.scheme+'://'+(this.u.user ? encodeURIComponent(this.u.user)+(this.u.pass ? ':'+encodeURIComponent(this.u.pass) : '')+'@' : '')+this.u.host+(this.u.port ? ':'+this.u.port : '');
    return base+p.split('/').map(encodeURIComponent).join('/')+(dir && p!=='/' ? '/' : '');
  }
  async _f(method,p,o={}){ return httpFetch(this.ns,this._url(p,o.dir)+(o.q||''),{method,body:o.body,headers:o.headers,redirects:0,timeout:30000}); }
  async stat(p){
    if(p==='/') return {name:'',dir:true,size:0,mtime:0};
    const r=await this._f('HEAD',p);
    if(r.status===404) return null;
    if((r.status===301 || r.status===302 || r.status===307) && /\/$/.test(r.headers.location||'')) return {name:vfsSplit(p)[1],dir:true,size:0,mtime:0};
    if(r.status>=400) throw new Error('http '+r.status+' '+r.statusText);
    return {name:vfsSplit(p)[1],dir:false,size:+r.headers['content-length']||0,mtime:Date.parse(r.headers['last-modified']||'')||0};
  }
  async list(p){
    const r=await this._f('GET',p,{dir:true,q:'?json'});
    if(r.status>=400) throw new Error('http '+r.status+' '+r.statusText);
    if(/json/i.test(r.headers['content-type']||'')){ try{ const j=JSON.parse(nsDec(r.body)); if(Array.isArray(j)) return j.map(f=>({name:String(f.name),dir:!!f.dir,size:+f.size||0,mtime:+f.mtime||0})); }catch(e){} }
    const out=[], seen=new Set(); const re=/href\s*=\s*["']([^"'#?]+)["']/gi; let m;
    const html=nsDec(r.body);
    while((m=re.exec(html))){
      let h=m[1]; if(/^[a-z][a-z0-9+.-]*:|^\/\//i.test(h) || h==='../' || h==='./' || h==='/') continue;
      const dir=h.endsWith('/'); let nm; try{ nm=decodeURIComponent(h.replace(/\/$/,'').split('/').pop()); }catch(e){ continue; }
      if(!nm || nm==='..' || seen.has(nm) || h.startsWith('/')) continue; seen.add(nm); out.push({name:nm,dir,size:0,mtime:0});
    }
    return out;
  }
  async read(p){ const r=await this._f('GET',p); if(r.status>=400) throw new Error('http '+r.status+' '+(r.status===404 ? 'not found' : r.statusText)); return r.body; }
  async write(p,b){ const r=await this._f('PUT',p,{body:b,headers:{'content-type':httpMime(p)}}); if(r.status>=400) throw new Error('http '+r.status+' '+r.statusText); }
  async mkdir(p){ const r=await this._f('PUT',p,{dir:true,body:new Uint8Array(0)}); if(r.status>=400) throw new Error('http '+r.status+' '+r.statusText); }
  async rmfile(p){ const r=await this._f('DELETE',p); if(r.status>=400) throw new Error('http '+r.status+' '+r.statusText); }
  async rmdir(p){ return this.rmfile(p); }
  async rename(){ throw new Error('HTTP cannot rename files'); }
}

/* ---------- vfs над бэкендом ---------- */
class VfsRemote{
  // u — адрес (строка или разобранный); opt: rnd, sign (для SMB), onState(text)
  constructor(ns,u,opt={}){ this.ns=ns; this.u=typeof u==='string' ? rfsParseUrl(u) : u; this.opt=opt; this.be=null; this.q=Promise.resolve(); this.cache=null; this.stats={calls:0,reconnects:0};
    if(!['ftp','smb','tftp','http','https'].includes(this.u.scheme)) throw new Error('VfsRemote: ftp, smb, tftp, http or https expected');
    this.label=this.u.scheme+'://'+this.u.host+(this.u.scheme==='smb' ? '/'+this.u.share : ''); }
  _mk(){
    switch(this.u.scheme){
      case 'ftp': return new RfsFtp(this.ns,this.u);
      case 'smb': return new RfsSmb(this.ns,this.u,this.opt);
      case 'tftp': return new RfsTftp(this.ns,this.u);
      default: return new RfsHttp(this.ns,this.u);
    }
  }
  _rp(p){ return rfsJoin(this.u.path,p); }                    // путь в корне источника → путь для протокола
  // по одному вызову за раз; оборванное соединение открывается заново, вызов повторяется один раз
  _do(fn){
    const run=this.q.then(async()=>{
      for(let tries=0;;tries++){
        if(!this.be){ const be=this._mk(); await be.connect(); this.be=be; this.opt.onState?.('connected to '+this.label); }
        try{ this.stats.calls++; return await fn(this.be); }
        catch(e){ if(tries===0 && rfsIsDead(e)){ try{ await this.be.close(); }catch(x){} this.be=null; this.stats.reconnects++; continue; } throw e; }
      }
    });
    this.q=run.then(()=>{},()=>{}); return run;
  }
  async close(){ await this.q; const b=this.be; this.be=null; this.cache=null; if(b) await b.close().catch(()=>{}); }
  async stat(p){ p=vfsNorm(p); const r=await this._do(be=>be.stat(this._rp(p))); if(!r) return null; return {...r,name:r.name||vfsSplit(p)[1],mime:r.dir ? undefined : httpMime(p)}; }
  async list(p){ p=vfsNorm(p); const r=await this._do(be=>be.list(this._rp(p))); return r.slice().sort((a,b)=>(b.dir-a.dir)||a.name.localeCompare(b.name)); }
  async read(p,a=0,b){
    p=vfsNorm(p);
    return this._do(async be=>{
      if(be.ranged) return be.read(this._rp(p),a,b);
      let d; const c=this.cache;
      if(c && c.p===p && Date.now()-c.t<30000) d=c.d; else { d=await be.read(this._rp(p)); this.cache=d.length<=(64<<20) ? {p,d,t:Date.now()} : null; }
      return b==null ? d.subarray(a) : d.subarray(a,b);
    });
  }
  async write(p,bytes){
    p=vfsNorm(p); this.cache=null; if(typeof bytes==='string') bytes=nsEnc(bytes);
    return this._do(async be=>{
      try{ await be.write(this._rp(p),bytes); }
      catch(e){                                               // родительских папок нет — создаём, как VfsMem (сервера отвечают по-разному: not found, access denied…)
        const par=vfsSplit(p)[0];
        if(rfsIsDead(e) || par==='/' || await be.stat(this._rp(par)).catch(()=>true)) throw e;
        try{ await be.mkdir(this._rp(par)); }catch(x){ throw e; }
        await be.write(this._rp(p),bytes);
      }
    });
  }
  mkdir(p){ p=vfsNorm(p); return this._do(be=>be.mkdir(this._rp(p))); }
  async remove(p){
    p=vfsNorm(p); this.cache=null; if(p==='/') return false;
    const st=await this.stat(p); if(!st) return false;
    const rec=async(q,dir)=>{ if(dir){ for(const f of await this.list(q)) await rec(vfsNorm(q+'/'+f.name),f.dir); await this._do(be=>be.rmdir(this._rp(q))); } else await this._do(be=>be.rmfile(this._rp(q))); };
    await rec(p,st.dir); return true;
  }
  rename(a,b){ this.cache=null; a=vfsNorm(a); b=vfsNorm(b); return this._do(be=>be.rename(this._rp(a),this._rp(b))); }
}

// Открыть источник по адресу. files://папка — через opt.local(путь) (в приложении это VfsFiles); остальное — VfsRemote.
function rfsOpen(ns,url,opt={}){
  const u=typeof url==='string' ? rfsParseUrl(url) : url;
  if(u.scheme==='files'){ if(!opt.local) throw new Error('files:// is available in the app only'); return opt.local(u.path); }
  return new VfsRemote(ns,u,opt);
}

// Адрес источника копирования: папка → {vfs, path:'/'}; файл → vfs открывается на папку выше, path:'/имя'. Нет такого — ошибка.
async function rfsOpenTree(ns,url,opt={}){
  const u=rfsParseUrl(url), segs=u.path.split('/').filter(Boolean);
  const asFile=async()=>{                                       // vfs на папке выше и имя файла в ней; не файл — null
    if(!segs.length) return null;
    const dirs=segs.slice(0,-1); let name=segs[segs.length-1]; if(u.scheme==='http' || u.scheme==='https'){ try{ name=decodeURIComponent(name); }catch(e){} }   // у http путь хранится как есть, у остальных уже разобран
    const v2=rfsOpen(ns,{...u,path:'/'+dirs.join('/')},opt), st2=await v2.stat('/'+name).catch(()=>null);
    if(st2 && !st2.dir) return {vfs:v2,path:'/'+name,u};
    if(v2.close) await v2.close().catch(()=>{});
    return null;
  };
  // папка Files, которой нет, выглядит как пустой корень — поэтому для files:// сначала смотрим, не файл ли это
  if(u.scheme==='files'){ const f=await asFile(); if(f) return f; }
  const v=rfsOpen(ns,u,opt), st=await v.stat('/').catch(()=>null);
  if(st && st.dir) return {vfs:v,path:'/',u};
  if(v.close) await v.close().catch(()=>{});
  const f=u.scheme==='files' ? null : await asFile();
  if(!f) throw new Error('not found: '+u.raw);
  return f;
}

/* ---------- копирование ---------- */
// Копирует файл или дерево from[srcPath] → to[dstPath]. o: overwrite (по умолчанию да), maxBytes (на файл, 512 МБ), onFile(rec), onProgress(done,total), stop() → true прервать.
// Результат {files,bytes,skipped,errors:[…]}; одна неудача не останавливает остальные.
async function rfsCopy(from,srcPath,to,dstPath,o={}){
  const res={files:0,bytes:0,skipped:0,errors:[]}, max=o.maxBytes||(512<<20), over=o.overwrite!==false;
  const st=await from.stat(srcPath); if(!st) throw new Error('source not found: '+srcPath);
  const items=[];
  const walk=async(sp,dp,dir,size)=>{
    if(!dir){ items.push({sp,dp,size}); return; }
    for(const f of await from.list(sp)) await walk(vfsNorm(sp+'/'+f.name),vfsNorm(dp+'/'+f.name),f.dir,f.size);
  };
  if(st.dir){ await to.mkdir(dstPath).catch(()=>{}); await walk(vfsNorm(srcPath),vfsNorm(dstPath),true); }
  else { const dstSt=await to.stat(dstPath).catch(()=>null); await walk(vfsNorm(srcPath),dstSt && dstSt.dir ? vfsNorm(dstPath+'/'+vfsSplit(srcPath)[1]) : vfsNorm(dstPath),false,st.size); }
  const total=items.reduce((a,x)=>a+(x.size||0),0); let done=0;
  for(const it of items){
    if(o.stop?.()){ res.errors.push('stopped'); break; }
    try{
      if(it.size>max) throw new Error('too big ('+it.size+' bytes, the limit is '+max+')');
      if(!over && await to.stat(it.dp).catch(()=>null)){ res.skipped++; o.onFile?.({ev:'skip',path:it.sp,to:it.dp,bytes:it.size}); continue; }
      const d=await from.read(it.sp); await to.write(it.dp,d);
      res.files++; res.bytes+=d.length; done+=it.size||d.length; o.onFile?.({ev:'copy',path:it.sp,to:it.dp,bytes:d.length}); o.onProgress?.(done,total);
    }catch(e){ res.errors.push(it.sp+': '+(e.message||e)); o.onFile?.({ev:'error',path:it.sp,to:it.dp,msg:String(e.message||e)}); }
  }
  return res;
}
