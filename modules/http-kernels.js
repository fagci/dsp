"use strict";
/* HTTP/1.1 поверх сокетов приложения (netsock-kernels.js): сервер (файлы, загрузка, ответы из графа) и клиент.
   Без TLS — для локальной сети; https из страницы идёт через fetch. Без DOM — tools/test-http.mjs. */

const HTTP_STATUS={100:'Continue',200:'OK',201:'Created',204:'No Content',206:'Partial Content',301:'Moved Permanently',302:'Found',304:'Not Modified',
  400:'Bad Request',401:'Unauthorized',403:'Forbidden',404:'Not Found',405:'Method Not Allowed',408:'Request Timeout',409:'Conflict',411:'Length Required',
  413:'Payload Too Large',416:'Range Not Satisfiable',500:'Internal Server Error',501:'Not Implemented',503:'Service Unavailable'};
const HTTP_MIME={html:'text/html; charset=utf-8',htm:'text/html; charset=utf-8',txt:'text/plain; charset=utf-8',css:'text/css',js:'text/javascript',json:'application/json',
  xml:'application/xml',csv:'text/csv; charset=utf-8',md:'text/markdown; charset=utf-8',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',svg:'image/svg+xml',
  webp:'image/webp',ico:'image/x-icon',mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',flac:'audio/flac',m4a:'audio/mp4',aac:'audio/aac',mp4:'video/mp4',webm:'video/webm',
  mkv:'video/x-matroska',ts:'video/mp2t',m3u8:'application/vnd.apple.mpegurl',pdf:'application/pdf',zip:'application/zip',gz:'application/gzip',wasm:'application/wasm',
  bin:'application/octet-stream',iq:'application/octet-stream',cu8:'application/octet-stream',cs16:'application/octet-stream',cf32:'application/octet-stream'};
const httpMime=name=>HTTP_MIME[String(name).split('.').pop().toLowerCase()]||'application/octet-stream';
const httpEsc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// «a/./b//../c» → «/a/c»; выше корня не выйти
function vfsNorm(p){
  const o=[]; for(const s of String(p||'').split('/')){ if(!s || s==='.') continue; if(s==='..') o.pop(); else o.push(s); }
  return '/'+o.join('/');
}
const vfsSplit=p=>{ p=vfsNorm(p); const i=p.lastIndexOf('/'); return [p.slice(0,i)||'/',p.slice(i+1)]; };

/* Файловая система в памяти — для тестов и как общий «ящик» узла. Тот же набор методов у обёртки над Files. */
class VfsMem{
  constructor(){ this.f=new Map(); this.d=new Set(['/']); }
  async stat(p){ p=vfsNorm(p); if(this.d.has(p)) return {name:vfsSplit(p)[1],dir:true,size:0,mtime:0}; const f=this.f.get(p); return f ? {name:vfsSplit(p)[1],dir:false,size:f.d.length,mtime:f.t,mime:f.mime} : null; }
  async list(p){
    p=vfsNorm(p); const pre=p==='/' ? '/' : p+'/', out=[];
    for(const d of this.d) if(d!=='/' && d.startsWith(pre) && !d.slice(pre.length).includes('/')) out.push({name:d.slice(pre.length),dir:true,size:0,mtime:0});
    for(const [k,f] of this.f) if(k.startsWith(pre) && !k.slice(pre.length).includes('/')) out.push({name:k.slice(pre.length),dir:false,size:f.d.length,mtime:f.t,mime:f.mime});
    return out.sort((a,b)=>(b.dir-a.dir)||a.name.localeCompare(b.name));
  }
  async read(p,a=0,b){ const f=this.f.get(vfsNorm(p)); if(!f) throw new Error('not found'); return b==null ? f.d.subarray(a) : f.d.subarray(a,b); }
  async write(p,bytes,mime){ p=vfsNorm(p); const [dir]=vfsSplit(p); if(!this.d.has(dir)) await this.mkdir(dir); this.f.set(p,{d:bytes,t:Date.now(),mime:mime||httpMime(p)}); }
  async mkdir(p){ p=vfsNorm(p); let c=''; for(const s of p.split('/').filter(Boolean)){ c+='/'+s; this.d.add(c); } }
  async remove(p){ p=vfsNorm(p); if(this.f.delete(p)) return true; if(!this.d.has(p) || p==='/') return false; for(const k of [...this.f.keys()]) if(k.startsWith(p+'/')) this.f.delete(k); for(const k of [...this.d]) if(k===p || k.startsWith(p+'/')) this.d.delete(k); return true; }
  async rename(a,b){ a=vfsNorm(a); b=vfsNorm(b); const f=this.f.get(a); if(!f) throw new Error('not found'); this.f.delete(a); await this.write(b,f.d,f.mime); }
}

/* ---------- разбор запроса / ответа ---------- */
function httpParseHeaders(lines){
  const h={};
  for(const l of lines){ const i=l.indexOf(':'); if(i<1) continue; const k=l.slice(0,i).trim().toLowerCase(), v=l.slice(i+1).trim(); h[k]=k in h ? h[k]+', '+v : v; }
  return h;
}
function httpParseRequestHead(text){
  const lines=text.split(/\r?\n/), m=/^([A-Za-z]+) (\S+) HTTP\/(\d)\.(\d)$/.exec(lines[0]||'');
  if(!m) return null;
  const [pathRaw,...q]=m[2].split('?'), query={};
  if(q.length) for(const kv of q.join('?').split('&')){ if(!kv) continue; const i=kv.indexOf('='); const dd=s=>{ try{ return decodeURIComponent(s.replace(/\+/g,' ')); }catch(e){ return s; } }; query[dd(i<0 ? kv : kv.slice(0,i))]=i<0 ? '' : dd(kv.slice(i+1)); }
  let path; try{ path=decodeURIComponent(pathRaw); }catch(e){ return null; }
  return {method:m[1].toUpperCase(),target:m[2],path:vfsNorm(path)+(path.length>1 && path.endsWith('/') ? '/' : ''),query,version:m[3]+'.'+m[4],headers:httpParseHeaders(lines.slice(1))};
}
async function httpReadBody(conn,h,o={}){
  const max=o.maxBody||(256<<20);
  if(/chunked/i.test(h['transfer-encoding']||'')){
    const parts=[]; let tot=0;
    for(;;){
      const sz=await conn.readLine(o.timeout); if(sz==null) throw new Error('closed');
      const n=parseInt(sz.split(';')[0],16); if(!(n>=0)) throw new Error('bad chunk');
      if(n===0){ for(;;){ const t=await conn.readLine(o.timeout); if(!t) break; } break; }
      tot+=n; if(tot>max) throw Object.assign(new Error('too big'),{status:413});
      parts.push(await conn.read(n,o.timeout)); await conn.read(2,o.timeout);
    }
    return nsCat(parts);
  }
  const n=parseInt(h['content-length']||'0',10);
  if(!(n>=0)) throw new Error('bad length');
  if(n>max) throw Object.assign(new Error('too big'),{status:413});
  if(!n) return new Uint8Array(0);
  const b=await conn.read(n,o.timeout); if(b.length<n) throw new Error('closed');
  return b;
}
async function httpReadRequest(conn,o={}){
  const raw=await conn.readUntil('\r\n\r\n',o.timeout,65536);
  if(!raw) return null;
  const text=nsDec(raw);
  if(!text.endsWith('\r\n\r\n')) return null;
  const req=httpParseRequestHead(text.trimEnd());
  if(!req) throw Object.assign(new Error('bad request'),{status:400});
  if(/100-continue/i.test(req.headers.expect||'')) await conn.write('HTTP/1.1 100 Continue\r\n\r\n');
  req.body=await httpReadBody(conn,req.headers,o);
  return req;
}

// multipart/form-data → [{name, filename, type, data}]
function httpMultipart(body,boundary){
  const b=nsEnc('--'+boundary), out=[];
  let i=nsFind(body,b); if(i<0) return out;
  for(;;){
    i+=b.length;
    if(body[i]===45 && body[i+1]===45) break;                          // «--» закрывающая
    if(body[i]===13) i+=2;
    const he=nsFind(body,nsEnc('\r\n\r\n'),i); if(he<0) break;
    const head=nsDec(body.subarray(i,he)), start=he+4;
    const next=nsFind(body,nsEnc('\r\n--'+boundary),start); if(next<0) break;
    const h=httpParseHeaders(head.split(/\r?\n/)), cd=h['content-disposition']||'';
    const nm=/name="([^"]*)"/.exec(cd), fn=/filename="([^"]*)"/.exec(cd);
    out.push({name:nm?nm[1]:'',filename:fn?fn[1]:null,type:h['content-type']||'',data:body.subarray(start,next)});
    i=next+2;
  }
  return out;
}

/* ---------- ответ ---------- */
function httpRespBytes(res,req){
  let body=res.body;
  if(res.text!=null) body=nsEnc(String(res.text));
  else if(res.json!==undefined) body=nsEnc(JSON.stringify(res.json));
  else if(typeof body==='string') body=nsEnc(body);
  if(!body) body=new Uint8Array(0);
  let status=res.status||200; const h={};
  for(const k in (res.headers||{})) h[k.toLowerCase()]=res.headers[k];
  if(res.text!=null && !h['content-type']) h['content-type']='text/plain; charset=utf-8';
  if(res.json!==undefined && !h['content-type']) h['content-type']='application/json';
  // Range: только для 200 на GET с готовым телом
  const rg=req && req.method==='GET' && status===200 ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range||'') : null;
  if(rg){
    const L=body.length; let a=rg[1]==='' ? L-parseInt(rg[2]||'0',10) : parseInt(rg[1],10), e=rg[1]==='' || rg[2]==='' ? L-1 : Math.min(parseInt(rg[2],10),L-1);
    if(!(a>=0) || a>e || a>=L){ status=416; h['content-range']='bytes */'+L; body=new Uint8Array(0); }
    else { status=206; h['content-range']='bytes '+a+'-'+e+'/'+L; body=body.subarray(a,e+1); }
  }
  const head=req && req.method==='HEAD';
  h['content-length']=String(body.length);
  if(!h.date) h.date=new Date().toUTCString();
  if(!h.server) h.server='DSP';
  if(res.range) h['accept-ranges']='bytes';
  const lines=['HTTP/1.1 '+status+' '+(HTTP_STATUS[status]||'OK')];
  for(const k in h) lines.push(k.replace(/(^|-)([a-z])/g,(_,a,c)=>a+c.toUpperCase())+': '+h[k]);
  const hb=nsEnc(lines.join('\r\n')+'\r\n\r\n');
  return head ? hb : nsCat([hb,body]);
}

/* ---------- сервер ---------- */
class HttpServer{
  // handler(req) → {status, headers, body|text|json} | null (404). opt: auth «user:pass», maxBody, idle (мс), cors
  constructor(ns,handler,opt={}){ this.ns=ns; this.handler=handler; this.opt=opt; this.srv=null; this.active=new Set(); this.stats={requests:0,tx:0,rx:0}; this.onLog=null; }
  async start(port,lan=true){ this.srv=await this.ns.listen(port,c=>this._serve(c),lan); return this.srv.port; }
  async stop(){ if(this.srv) await this.srv.close(); this.srv=null; for(const c of [...this.active]) await c.close(); this.active.clear(); }
  async _serve(c){
    this.active.add(c);
    try{
      for(;;){
        let req;
        try{ req=await httpReadRequest(c,{timeout:this.opt.idle||30000,maxBody:this.opt.maxBody}); }
        catch(e){
          if(e.message==='timeout' || e.message==='closed') break;
          await c.write(httpRespBytes({status:e.status||400,text:e.message,headers:{connection:'close'}})); break;
        }
        if(!req) break;
        req.peer=c.peer; this.stats.requests++; this.stats.rx+=req.body.length;
        let res;
        try{
          if(this.opt.auth && !this._authOk(req)) res={status:401,headers:{'www-authenticate':'Basic realm="DSP"'},text:'login required'};
          else if(req.method==='OPTIONS') res={status:204,headers:{allow:'GET, HEAD, POST, PUT, DELETE, OPTIONS'}};
          else res=await this.handler(req)||{status:404,text:'not found'};
        }catch(e){ res={status:e.status||500,text:String(e.message||e)}; }
        if(this.opt.cors){ res.headers={...res.headers,'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET, HEAD, POST, PUT, DELETE, OPTIONS'}; }
        const close=/close/i.test(req.headers.connection||'') || (req.version==='1.0' && !/keep-alive/i.test(req.headers.connection||''));
        if(close) res.headers={...res.headers,connection:'close'};
        const out=httpRespBytes(res,req);
        this.stats.tx+=out.length;
        this.onLog?.({method:req.method,path:req.path,status:res.status||200,bytes:out.length,peer:c.peer});
        await c.write(out);
        if(close) break;
      }
    }catch(e){ /* обрыв */ }
    this.active.delete(c); c.close();
  }
  _authOk(req){
    const m=/^Basic (.+)$/i.exec(req.headers.authorization||''); if(!m) return false;
    try{ return atob(m[1])===this.opt.auth; }catch(e){ return false; }
  }
}

/* Обработчик «папка по HTTP»: GET / HEAD (с Range), страница-список с формой загрузки, PUT / POST (multipart или тело) / DELETE.
   vfs — VfsMem или обёртка над Files. opt: write (разрешить запись), onUpload(path,bytes,mime), index (имя файла по умолчанию). */
function httpFileHandler(vfs,opt={}){
  return async req=>{
    const p=req.path, st=await vfs.stat(p.replace(/\/$/,'')||'/');
    if(req.method==='GET' || req.method==='HEAD'){
      if(!st) return {status:404,text:'not found: '+p};
      if(st.dir){
        if(opt.index){ const ix=(p==='/' ? '' : p.replace(/\/$/,''))+'/'+opt.index; if(await vfs.stat(ix)) return {body:await vfs.read(ix),headers:{'content-type':httpMime(opt.index)},range:true}; }
        const list=await vfs.list(p);
        if(req.query.json!==undefined) return {json:list.map(f=>({name:f.name,dir:f.dir,size:f.size,mtime:f.mtime}))};
        return {text:httpIndexPage(p,list,!!opt.write),headers:{'content-type':'text/html; charset=utf-8'}};
      }
      return {body:await vfs.read(p),headers:{'content-type':st.mime||httpMime(p),'content-disposition':req.query.dl!==undefined ? 'attachment' : 'inline'},range:true};
    }
    if(!opt.write) return {status:403,text:'read only'};
    if(req.method==='PUT'){
      if(st && st.dir) return {status:409,text:'is a directory'};
      await vfs.write(p,req.body,req.headers['content-type']); opt.onUpload?.(p,req.body,req.headers['content-type']);
      return {status:st ? 204 : 201,text:st ? undefined : 'created'};
    }
    if(req.method==='POST'){
      const ct=req.headers['content-type']||'', m=/multipart\/form-data;.*boundary=("?)([^";]+)\1/i.exec(ct);
      const dir=st && st.dir ? p.replace(/\/$/,'') : vfsSplit(p)[0], saved=[];
      if(m){
        for(const part of httpMultipart(req.body,m[2])){
          if(!part.filename) continue;
          const name=part.filename.replace(/[\\/]/g,'_'), path=vfsNorm(dir+'/'+name);
          await vfs.write(path,part.data,part.type||httpMime(name)); saved.push(path); opt.onUpload?.(path,part.data,part.type);
        }
      } else if(st && !st.dir){ await vfs.write(p,req.body,ct); saved.push(p); opt.onUpload?.(p,req.body,ct); }
      else if(!st || st.dir){ const name=req.query.name||('upload-'+Date.now()); const path=vfsNorm(dir+'/'+name); await vfs.write(path,req.body,ct); saved.push(path); opt.onUpload?.(path,req.body,ct); }
      if(req.headers.accept && /text\/html/.test(req.headers.accept)) return {status:303,headers:{location:dir||'/'},text:'saved '+saved.join(', ')};
      return {status:201,json:{saved}};
    }
    if(req.method==='DELETE'){
      if(!st) return {status:404,text:'not found'};
      await vfs.remove(p); return {status:204};
    }
    return {status:405,text:'method not allowed'};
  };
}
function httpIndexPage(path,list,upload){
  const base=path.endsWith('/') ? path : path+'/', up=path==='/' ? '' : '<li><a href="'+encodeURI(vfsSplit(path)[0])+'">..</a></li>';
  const rows=list.map(f=>'<li><a href="'+encodeURI(base+f.name)+(f.dir ? '/' : '')+'">'+httpEsc(f.name)+(f.dir ? '/' : '')+'</a>'+(f.dir ? '' : ' <small>'+f.size+' B</small>')+'</li>').join('');
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+httpEsc(path)+'</title>'
    +'<style>body{font:16px system-ui;margin:1rem auto;max-width:42rem;padding:0 1rem}li{margin:.4rem 0}small{color:#888}</style>'
    +'<h2>'+httpEsc(path)+'</h2><ul>'+up+rows+'</ul>'
    +(upload ? '<hr><form method="post" enctype="multipart/form-data" action="'+encodeURI(base)+'"><input type="file" name="file" multiple> <button>Upload</button></form>' : '');
}

/* ---------- клиент ---------- */
function httpParseUrl(u){
  const m=/^http:\/\/(?:([^@/]*)@)?([^/:?#]+)(?::(\d+))?([^#]*)$/i.exec(String(u).trim());
  if(!m) return null;
  return {auth:m[1]||'',host:m[2],port:+m[3]||80,path:m[4]||'/'};
}
async function httpFetch(ns,url,o={}){
  let cur=url;
  for(let hop=0;hop<=(o.redirects??5);hop++){
    const u=httpParseUrl(cur); if(!u) throw new Error('http://host[:port]/path expected');
    const method=(o.method||'GET').toUpperCase();
    const body=typeof o.body==='string' ? nsEnc(o.body) : o.body;
    const h={host:u.host+(u.port!==80 ? ':'+u.port : ''),connection:'close','user-agent':'DSP',accept:'*/*'};
    for(const k in (o.headers||{})) h[k.toLowerCase()]=o.headers[k];
    if(u.auth && !h.authorization) h.authorization='Basic '+btoa(u.auth);
    if(body){ h['content-length']=String(body.length); }
    else if(method==='POST' || method==='PUT') h['content-length']='0';
    const head=method+' '+u.path+' HTTP/1.1\r\n'+Object.keys(h).map(k=>k+': '+h[k]).join('\r\n')+'\r\n\r\n';
    const c=await ns.connect(u.host,u.port,o.connectTimeout||5000);
    try{
      await c.write(body ? nsCat([nsEnc(head),body]) : head);
      const ms=o.timeout||30000;
      const raw=await c.readUntil('\r\n\r\n',ms,65536); if(!raw) throw new Error('no answer');
      const lines=nsDec(raw).trimEnd().split(/\r?\n/), m=/^HTTP\/\d\.\d (\d{3})\s*(.*)$/.exec(lines[0]);
      if(!m) throw new Error('not an HTTP answer');
      const status=+m[1], headers=httpParseHeaders(lines.slice(1));
      if((status===301 || status===302 || status===303 || status===307 || status===308) && headers.location && o.redirects!==0){
        cur=/^https?:/i.test(headers.location) ? headers.location : 'http://'+u.host+(u.port!==80 ? ':'+u.port : '')+(headers.location[0]==='/' ? '' : '/')+headers.location;
        if(!/^http:/i.test(cur)) throw new Error('redirect to '+cur+' (https is not supported here)');
        if(status===303){ o={...o,method:'GET',body:undefined}; }
        continue;
      }
      let data;
      if(method==='HEAD' || status===204 || status===304 || status<200) data=new Uint8Array(0);
      else if(/chunked/i.test(headers['transfer-encoding']||'')) data=await httpReadBody(c,headers,{timeout:ms,maxBody:o.maxBody});
      else if(headers['content-length']!=null){
        const n=parseInt(headers['content-length'],10); if(n>(o.maxBody||(256<<20))) throw new Error('too big');
        data=await c.read(n,ms); if(data.length<n) throw new Error('closed before the end');
      } else data=await c.readAll(ms,o.maxBody||(256<<20));
      return {status,statusText:m[2],headers,body:data,text:()=>nsDec(data),url:cur};
    } finally { await c.close(); }
  }
  throw new Error('too many redirects');
}
