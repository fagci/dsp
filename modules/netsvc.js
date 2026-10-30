"use strict";
/* ============================ Сетевые службы (приложение DSP) ============================
   HTTP Server, FTP Server, HTTP Client, FTP Client. Сокеты — в приложении (tcp.listen / tcp.connect), протоколы — здесь:
   netsock-kernels.js (промисы над командами моста), http-kernels.js, ftp-kernels.js; проверяются в tools/test-http.mjs / test-ftp.mjs.
   Файлы сервера — папка в Files (по умолчанию «Share») плюс файлы, поданные на вход bin. Нужен доверенный клиент, как у Network (DSP app). */

const NSV_URL='ws://127.0.0.1:8765';

/* ---------- связь с мостом ---------- */
function nsvLink(n){                                  // → Promise<NetSock>; одно соединение на узел
  if(n.nsP) return n.nsP;
  n.nsP=new Promise((res,rej)=>{
    let key=''; try{ key=(window.DspApp && DspApp.appKey && DspApp.appKey()) || ''; }catch(e){}
    const url=phoneUrl(n.p.url,key);
    if(!url){ n.nsP=null; return rej(new Error((typeof gwErr==='function' && gwErr(n.p.url))||'URL must start with ws:// or wss://')); }
    n.warn=netInsecure(url) ? NET_INSECURE_MSG : '';
    let ws; try{ ws=new WebSocket(url); }catch(e){ n.nsP=null; return rej(e); }
    const ns=new NetSock(m=>{ if(ws.readyState!==1) throw new Error('bridge is not connected'); ws.send(JSON.stringify(m)); });
    ws.onopen=()=>{ ws.send(JSON.stringify({sub:['net']})); n.ws=ws; n.ns=ns; res(ns); };
    ws.onerror=()=>{ if(!n.ns){ n.nsP=null; rej(new Error('no connection — is the DSP app running?')); } };
    ws.onclose=()=>{ const was=n.ns===ns; n.ns=null; n.ws=null; n.nsP=null; if(was) nsvDown(n); };
    ws.onmessage=e=>{
      if(typeof e.data!=='string') return;
      let j; try{ j=JSON.parse(e.data); }catch(x){ return; }
      for(const r of Array.isArray(j) ? j : [j]) ns.feed(r);
    };
  });
  return n.nsP;
}
function nsvDrop(n){
  const ws=n.ws; n.nsP=null; n.ns=null; n.ws=null;
  if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
}
function nsvDown(n){ n.srv=null; n.status='bridge closed'; n.running=false; }

/* ---------- файлы сервера: папка в Files ---------- */
class VfsFiles{
  constructor(root,mem){ this.root=String(root||'').split('/').filter(Boolean); this.mem=mem||new Map(); }     // mem: имя → {d,mime,t} — файлы с входа bin
  async _walk(parts,create){
    let id=FS_ROOT;
    for(const nm of this.root.concat(parts)){
      const f=(await FileStore.listFolders('files',id)).find(x=>x.name===nm);
      if(f) id=f.id; else if(create) id=await FileStore.addFolder('files',nm,id); else return null;
    }
    return id;
  }
  async _find(p){                                    // → {dir:id}|{file:rec}|null
    p=vfsNorm(p); const parts=p.split('/').filter(Boolean), last=parts.pop();
    const id=await this._walk(parts,false); if(id==null) return null;
    if(last==null) return {dir:id};
    const d=(await FileStore.listFolders('files',id)).find(x=>x.name===last); if(d) return {dir:d.id,rec:d};
    const f=(await FileStore.list('files',id)).find(x=>x.name===last); return f ? {file:f} : null;
  }
  async stat(p){
    p=vfsNorm(p); const m=this.mem.get(p.slice(1));
    if(m && p.lastIndexOf('/')===0) return {name:p.slice(1),dir:false,size:m.d.length,mtime:m.t,mime:m.mime};
    const r=await this._find(p); if(!r) return p==='/' ? {name:'',dir:true,size:0,mtime:0} : null;
    if(r.file) return {name:r.file.name,dir:false,size:r.file.size||0,mtime:r.file.modified||0,mime:r.file.mime};
    return {name:vfsSplit(p)[1],dir:true,size:0,mtime:r.rec?.created||0};
  }
  async list(p){
    p=vfsNorm(p); const r=await this._find(p), out=[];
    if(r && r.dir!=null){
      for(const f of await FileStore.listFolders('files',r.dir)) out.push({name:f.name,dir:true,size:0,mtime:f.created||0});
      for(const f of await FileStore.list('files',r.dir)) out.push({name:f.name,dir:false,size:f.size||0,mtime:f.modified||0,mime:f.mime});
    }
    if(p==='/') for(const [k,m] of this.mem) if(!out.some(o=>o.name===k)) out.push({name:k,dir:false,size:m.d.length,mtime:m.t,mime:m.mime});
    return out;
  }
  async read(p,a=0,b){
    p=vfsNorm(p); const m=this.mem.get(p.slice(1)), r=m ? null : await this._find(p);
    let d;
    if(m) d=m.d; else { if(!r || !r.file) throw new Error('not found'); d=new Uint8Array(await (await FileStore.get(r.file.id)).blob.arrayBuffer()); }
    return b==null ? d.subarray(a) : d.subarray(a,b);
  }
  async write(p,bytes,mime){
    p=vfsNorm(p); const [dir,name]=vfsSplit(p), id=await this._walk(dir.split('/').filter(Boolean),true);
    const blob=new Blob([bytes],{type:mime||httpMime(name)}), old=(await FileStore.list('files',id)).find(x=>x.name===name);
    if(old) await FileStore.update(old.id,{blob,mime:blob.type});
    else await FileStore.put({space:'files',folderId:id,name,mime:blob.type,blob});
  }
  async mkdir(p){ await this._walk(vfsNorm(p).split('/').filter(Boolean),true); }
  async remove(p){
    p=vfsNorm(p); if(p.lastIndexOf('/')===0 && this.mem.delete(p.slice(1))) return true;
    const r=await this._find(p); if(!r || p==='/') return false;
    if(r.file) await FileStore.remove(r.file.id); else await FileStore.deleteFolder(r.dir);
    return true;
  }
  async rename(a,b){
    const r=await this._find(a); if(!r || !r.file) throw new Error('not found');
    const [dir,name]=vfsSplit(b), id=await this._walk(dir.split('/').filter(Boolean),true);
    await FileStore.update(r.file.id,{name,folderId:id});
  }
}

const nsvBin=(d,name,mime)=>({d,name:name||'',mime:mime||'',id:++BIN_SEQ});
const nsvStr=b=>{ try{ return new TextDecoder('utf-8',{fatal:false}).decode(b); }catch(e){ return ''; } };
const nsvUrls=(info,scheme,port)=>{ const ips=(info && info.ips && info.ips.length) ? info.ips : ['127.0.0.1']; return ips.map(ip=>scheme+'://'+ip+':'+port); };
function nsvPush(n,r){ n.recQ.push({t:Date.now(),...r}); if(n.recQ.length>5000) n.recQ.splice(0,n.recQ.length-5000); }
function nsvDrawSrv(n){
  const r=n.el.querySelector('.readout'); if(!r) return;
  let t=(n.warn&&!n.running ? '⚠ '+n.warn+'\n' : '')+n.status;
  if(n.urls) t+='\n'+n.urls.join('\n');
  if(n.stat) t+='\n'+n.stat;
  if(r.textContent!==t) r.textContent=t;
}
function nsvServerOutputs(n){                       // выходы-события: последняя загрузка и счётчики → в порты
  const up=n.upQ.shift();
  if(up){ n.lastUp=nsvBin(up.bytes,up.name,up.mime); n.upText=nsvStr(up.bytes.length<=65536 ? up.bytes : up.bytes.subarray(0,65536)); n.upName=up.path; n.pulse=2; }
  const pl=n.pulse>0 ? 1 : 0; if(n.pulse>0) n.pulse--;
  const rec=n.recQ.length ? n.recQ.splice(0) : null;
  return {rec, bin:n.lastUp||null, name:n.upName||'', text:n.upText??null, url:n.urls ? n.urls[0] : '', count:n.count|0, new:pl, on:n.running ? 1 : 0};
}
const NSV_SRV_OUTS=[{n:'rec',t:'rec'},{n:'bin',t:'bin'},{n:'name',t:'txt'},{n:'text',t:'txt'},{n:'url',t:'txt'},{n:'count',t:'num'},{n:'new',t:'num'},{n:'on',t:'num'}];

/* ---------- HTTP Server ---------- */
async function httpsrvStart(n){
  if(n.running || n.starting) return;
  n.starting=true; n.status='connecting…';
  try{
    const ns=await nsvLink(n);
    const info=await ns.call('net.info').catch(()=>null);
    n.vfs=new VfsFiles(n.p.folder,n.mem);
    const files=httpFileHandler(n.vfs,{write:!!n.p.write,index:String(n.p.index||'').trim()||null,
      onUpload:(path,bytes,mime)=>{ n.upQ.push({path,name:vfsSplit(path)[1],bytes,mime}); nsvPush(n,{src:'http',ev:'upload',path,bytes:bytes.length,mime}); }});
    const graphH=req=>new Promise(res=>{
      const id=++n.rid, body=req.body, q={id,req,res,timer:setTimeout(()=>{ n.pend.delete(id); res({status:504,text:'no answer from the graph'}); },+n.p.wait||10000)};
      n.pend.set(id,q);
      nsvPush(n,{src:'http',ev:'request',id,method:req.method,path:req.path,query:req.query,headers:req.headers,peer:req.peer,bytes:body.length,text:body.length<=65536 ? nsvStr(body) : ''});
      if(body.length){ n.upQ.push({path:req.path,name:vfsSplit(req.path)[1]||'body',bytes:body,mime:req.headers['content-type']||''}); }
      n.count++;
    });
    const mode=n.p.mode;
    const handler=mode==='graph' ? graphH : mode==='files, then graph' ? async req=>{ const r=await files(req); return r.status===404 || r.status===403 || r.status===405 ? graphH(req) : r; } : files;
    const auth=n.p.user ? n.p.user+':'+(n.p.pass||'') : '';
    n.srv=new HttpServer(ns,handler,{auth,cors:!!n.p.cors,maxBody:(+n.p.maxMb||64)<<20});
    n.srv.onLog=r=>{ if(mode!=='graph' || r.status!==504) nsvPush(n,{src:'http',ev:'response',...r}); if(mode==='files') n.count++; };
    const port=await n.srv.start(+n.p.port||8080,!!n.p.lan);
    n.running=true; n.urls=nsvUrls(info,'http',port); n.status='listening on port '+port;
  }catch(e){ n.status='error: '+(e.message||e); n.running=false; try{ await n.srv?.stop(); }catch(x){} n.srv=null; }
  n.starting=false;
}
async function httpsrvStop(n){
  n.running=false; n.urls=null;
  for(const q of n.pend.values()){ clearTimeout(q.timer); q.res({status:503,text:'stopped'}); } n.pend.clear();
  try{ await n.srv?.stop(); }catch(e){} n.srv=null; n.status='stopped';
}
def({ id:'httpsrv', title:'HTTP Server (DSP app)', cat:'Sources', kw:'http web server share files folder upload download api rest webhook phone lan hotspot browser',
  ins:[{n:'bin',t:'bin'},{n:'reply',t:'rec'},{n:'text',t:'txt'},{n:'start',t:'num'}], outs:NSV_SRV_OUTS, readout:true, tall:true,
  params:[
    {n:'url',t:'text',d:NSV_URL,label:'bridge of the DSP app'},
    {n:'port',t:'range',min:1024,max:65535,step:1,d:8080,label:'port (an app cannot take the ones below 1024)'},
    {n:'lan',t:'check',d:true,label:'reachable from other devices on the network (off — only this phone)'},
    {n:'mode',t:'select',opts:['files','graph','files, then graph'],d:'files',label:'who answers: the folder, the graph (requests go to «rec», answers come to «reply»), or the folder first'},
    {n:'folder',t:'text',d:'Share',label:'folder in Files (empty — the whole Files; a/b — nested; created when missing)'},
    {n:'write',t:'check',d:false,label:'allow upload (PUT / POST / form on the page) and delete'},
    {n:'index',t:'text',d:'',label:'file shown at / instead of the list (e.g. index.html)',adv:true},
    {n:'user',t:'text',d:'',label:'login (empty — open)',adv:true},
    {n:'pass',t:'text',d:'',label:'password',adv:true},
    {n:'cors',t:'check',d:false,label:'allow other sites to read answers (CORS)',adv:true},
    {n:'maxMb',t:'range',min:1,max:512,step:1,d:64,label:'largest upload, MB',adv:true},
    {n:'wait',t:'range',min:500,max:60000,step:500,d:10000,label:'graph mode: wait for «reply», ms',adv:true},
    {n:'auto',t:'check',d:false,label:'start together with the patch',adv:true},
    {n:'startBtn',t:'button',label:'Start',fn:n=>httpsrvStart(n)},
    {n:'stopBtn',t:'button',label:'Stop',fn:n=>httpsrvStop(n)}],
  init:n=>{ n.nsP=null; n.ns=null; n.ws=null; n.srv=null; n.vfs=null; n.running=false; n.starting=false; n.status='stopped'; n.urls=null; n.warn='';
            n.recQ=[]; n.upQ=[]; n.mem=new Map(); n.pend=new Map(); n.rid=0; n.count=0; n.pulse=0; n.lastUp=null; n.upText=null; n.upName=''; n.prevStart=0; n.lastBin=null; n.autoDone=false; n.lastReply=null; n.lastText=null; },
  dispose:n=>{ httpsrvStop(n); nsvDrop(n); },
  process(n,I){
    const st=(I.start||0)>.5; if(st && !n.prevStart) httpsrvStart(n); n.prevStart=st;
    if(n.p.auto && !n.autoDone){ n.autoDone=true; httpsrvStart(n); }
    if(I.bin && I.bin!==n.lastBin){                                  // поданный файл появляется в корне сервера
      n.lastBin=I.bin; const b=I.bin, nm=String(b.name||('file-'+b.id)).replace(/[\\/]/g,'_');
      n.mem.set(nm,{d:b.d,mime:b.mime||httpMime(nm),t:Date.now()}); if(n.mem.size>50) n.mem.delete(n.mem.keys().next().value);
      nsvPush(n,{src:'http',ev:'publish',name:nm,bytes:b.d.length});
    }
    // ответы графа: rec {id?, status, text | json, type, headers}; без id — на самый старый ждущий запрос
    const rl=I.reply!==n.lastReply ? recList(I.reply) : []; n.lastReply=I.reply;
    for(const r of rl){
      if(!r) continue;
      const id=r.id!=null ? +r.id : n.pend.keys().next().value, q=n.pend.get(id); if(!q) continue;
      n.pend.delete(id); clearTimeout(q.timer);
      const res={status:+r.status||200,headers:{...(r.type ? {'content-type':String(r.type)} : {}),...(r.headers&&typeof r.headers==='object' ? r.headers : {})}};
      if(r.json!==undefined) res.json=r.json; else if(r.text!=null) res.text=String(r.text); else if(r.hex) res.body=nsBytes(String(r.hex)); else res.text='';
      q.res(res);
    }
    if(typeof I.text==='string' && I.text!==n.lastText){ n.lastText=I.text; if(n.pend.size){ const [id,q]=n.pend.entries().next().value; n.pend.delete(id); clearTimeout(q.timer); q.res({text:I.text}); } }
    n.stat=n.srv ? 'requests '+n.srv.stats.requests+' · sent '+fmSize(n.srv.stats.tx)+' · received '+fmSize(n.srv.stats.rx)+(n.pend.size ? ' · waiting for the graph: '+n.pend.size : '')+(n.mem.size ? ' · from wire: '+n.mem.size : '') : '';
    return nsvServerOutputs(n); },
  draw:nsvDrawSrv });

/* ---------- FTP Server ---------- */
async function ftpsrvStart(n){
  if(n.running || n.starting) return;
  n.starting=true; n.status='connecting…';
  try{
    const ns=await nsvLink(n);
    const info=await ns.call('net.info').catch(()=>null);
    n.vfs=new VfsFiles(n.p.folder,n.mem);
    const host=(info && info.ips && info.ips[0]) || '127.0.0.1';
    n.srv=new FtpServer(ns,n.vfs,{user:String(n.p.user||''),pass:String(n.p.pass||''),write:!!n.p.write,host,pasvPort:(+n.p.port||2121)+1,
      onLog:r=>{ nsvPush(n,{src:'ftp',ev:r.ev,path:r.path,bytes:r.bytes,peer:r.peer}); n.count++; },
      onUpload:(path,bytes)=>{ n.upQ.push({path,name:vfsSplit(path)[1],bytes,mime:httpMime(path)}); }});
    const r=await n.srv.start(+n.p.port||2121,!!n.p.lan);
    n.running=true; n.urls=nsvUrls(info,'ftp',r.port).map(u=>u+(n.p.user ? '' : '')); n.status='listening on port '+r.port+' (data: '+r.dataPort+')';
  }catch(e){ n.status='error: '+(e.message||e); n.running=false; try{ await n.srv?.stop(); }catch(x){} n.srv=null; }
  n.starting=false;
}
async function ftpsrvStop(n){ n.running=false; n.urls=null; try{ await n.srv?.stop(); }catch(e){} n.srv=null; n.status='stopped'; }
def({ id:'ftpsrv', title:'FTP Server (DSP app)', cat:'Sources', kw:'ftp server share files folder upload download phone lan hotspot transfer',
  ins:[{n:'bin',t:'bin'},{n:'start',t:'num'}], outs:NSV_SRV_OUTS, readout:true, tall:true,
  params:[
    {n:'url',t:'text',d:NSV_URL,label:'bridge of the DSP app'},
    {n:'port',t:'range',min:1024,max:65534,step:1,d:2121,label:'control port (the next one is for data; below 1024 an app cannot listen)'},
    {n:'lan',t:'check',d:true,label:'reachable from other devices on the network'},
    {n:'folder',t:'text',d:'Share',label:'folder in Files (empty — the whole Files)'},
    {n:'write',t:'check',d:false,label:'allow upload, delete, rename, new folders'},
    {n:'user',t:'text',d:'',label:'login (empty — anonymous)'},
    {n:'pass',t:'text',d:'',label:'password'},
    {n:'startBtn',t:'button',label:'Start',fn:n=>ftpsrvStart(n)},
    {n:'stopBtn',t:'button',label:'Stop',fn:n=>ftpsrvStop(n)}],
  init:n=>{ n.nsP=null; n.ns=null; n.ws=null; n.srv=null; n.vfs=null; n.running=false; n.starting=false; n.status='stopped'; n.urls=null; n.warn='';
            n.recQ=[]; n.upQ=[]; n.mem=new Map(); n.count=0; n.pulse=0; n.lastUp=null; n.upText=null; n.upName=''; n.prevStart=0; n.lastBin=null; },
  dispose:n=>{ ftpsrvStop(n); nsvDrop(n); },
  process(n,I){
    const st=(I.start||0)>.5; if(st && !n.prevStart) ftpsrvStart(n); n.prevStart=st;
    if(I.bin && I.bin!==n.lastBin){ n.lastBin=I.bin; const b=I.bin, nm=String(b.name||('file-'+b.id)).replace(/[\\/]/g,'_'); n.mem.set(nm,{d:b.d,mime:b.mime||httpMime(nm),t:Date.now()}); nsvPush(n,{src:'ftp',ev:'publish',name:nm,bytes:b.d.length}); }
    n.stat=n.srv ? 'sessions '+n.srv.stats.sessions+' · files '+n.srv.stats.files+' · sent '+fmSize(n.srv.stats.tx)+' · received '+fmSize(n.srv.stats.rx) : '';
    return nsvServerOutputs(n); },
  draw:nsvDrawSrv });

/* ---------- клиенты ---------- */
async function nsvClientRun(n,job){                // одна операция за раз; результат — в очередь выходов
  if(n.busy){ n.status='busy — wait for the previous one'; return; }
  n.busy=true; n.status='working…'; n.progress=0;
  try{
    const ns=await nsvLink(n);
    const r=await job(ns);
    n.ok=1; n.status=r?.status||'done';
    if(r?.bin) n.outBin=r.bin;
    if(r?.text!==undefined) n.outText=r.text;
    if(r?.rows) for(const row of r.rows) nsvPush(n,row);
    if(r?.code!=null) n.code=r.code;
    n.pulse=2;
  }catch(e){ n.ok=0; n.status='error: '+(e.message||e); nsvPush(n,{src:n.cliSrc,ev:'error',msg:String(e.message||e)}); n.pulse=2; }
  n.busy=false;
}
function nsvClientOut(n){
  const pl=n.pulse>0 ? 1 : 0; if(n.pulse>0) n.pulse--;
  const rec=n.recQ.length ? n.recQ.splice(0) : null;
  return {rec,bin:n.outBin||null,text:n.outText??null,status:n.code|0,ok:n.ok,new:pl,busy:n.busy ? 1 : 0};
}
function nsvClientDraw(n){ const r=n.el.querySelector('.readout'); if(!r) return; const t=(n.warn&&!n.ns ? '⚠ '+n.warn+'\n' : '')+n.status; if(r.textContent!==t) r.textContent=t; }
const NSV_CLI_OUTS=[{n:'rec',t:'rec'},{n:'bin',t:'bin'},{n:'text',t:'txt'},{n:'status',t:'num'},{n:'ok',t:'num'},{n:'new',t:'num'},{n:'busy',t:'num'}];
const nsvName=u=>{ try{ return decodeURIComponent(String(u).split('?')[0].split('/').filter(Boolean).pop()||''); }catch(e){ return ''; } };

function httpcliRun(n){
  const url=String(n.urlIn||n.p.target||'').trim();
  if(!url){ n.status='set the address (http://host:port/path)'; return; }
  nsvClientRun(n,async ns=>{
    const method=n.p.method, headers={};
    for(const part of String(n.p.headers||'').split(/[;\n]+/)){ const i=part.indexOf(':'); if(i>0) headers[part.slice(0,i).trim()]=part.slice(i+1).trim(); }
    let body;
    if(method==='POST' || method==='PUT'){
      if(n.binIn){ body=n.binIn.d; if(!headers['Content-Type']) headers['Content-Type']=n.binIn.mime||'application/octet-stream'; }
      else { body=String(n.textIn!=null && n.textIn!=='' ? n.textIn : n.p.body||''); if(!headers['Content-Type']) headers['Content-Type']=n.p.ctype||'text/plain'; }
    }
    const t0=performance.now(), r=await httpFetch(ns,url,{method,headers,body,timeout:+n.p.timeout||30000,redirects:n.p.follow ? 5 : 0});
    const ms=Math.round(performance.now()-t0), ct=r.headers['content-type']||'', name=nsvName(r.url)||'response';
    const isText=/^text\/|json|xml|javascript|csv/.test(ct) || !ct;
    return {status:r.status+' '+r.statusText+' · '+fmSize(r.body.length)+' · '+ms+' ms',code:r.status,
      bin:nsvBin(r.body,name,ct.split(';')[0]),text:isText ? nsvStr(r.body) : null,
      rows:[{src:'http',ev:'response',url:r.url,status:r.status,type:ct,bytes:r.body.length,ms,headers:r.headers}]};
  });
}
def({ id:'httpcli', title:'HTTP Client (DSP app)', cat:'Sources', kw:'http get post put request fetch download api rest lan device camera printer',
  ins:[{n:'go',t:'num'},{n:'url',t:'txt'},{n:'text',t:'txt'},{n:'bin',t:'bin'}], outs:NSV_CLI_OUTS, readout:true,
  params:[
    {n:'url',t:'text',d:NSV_URL,label:'bridge of the DSP app'},
    {n:'target',t:'text',d:'http://192.168.0.1/',label:'address http://host[:port]/path (the «url» input overrides; for https use the page itself — fetch)'},
    {n:'method',t:'select',opts:['GET','POST','PUT','HEAD','DELETE'],d:'GET'},
    {n:'body',t:'text',d:'',label:'POST / PUT body text (the «text» input or a file on «bin» overrides)'},
    {n:'ctype',t:'text',d:'text/plain',label:'body type',adv:true},
    {n:'headers',t:'text',d:'',label:'headers (Name: value; Name: value)',adv:true},
    {n:'follow',t:'check',d:true,label:'follow redirects',adv:true},
    {n:'timeout',t:'range',min:1000,max:300000,step:1000,d:30000,label:'wait for the answer, ms',adv:true},
    {n:'run',t:'button',label:'Send',fn:n=>httpcliRun(n)}],
  init:n=>{ n.nsP=null; n.ns=null; n.ws=null; n.recQ=[]; n.busy=false; n.status='idle'; n.ok=0; n.code=0; n.pulse=0; n.outBin=null; n.outText=null; n.prevGo=0; n.urlIn=''; n.textIn=''; n.binIn=null; n.cliSrc='http'; n.warn=''; },
  dispose:n=>nsvDrop(n),
  process(n,I){
    n.urlIn=typeof I.url==='string' ? I.url : ''; n.textIn=typeof I.text==='string' ? I.text : ''; n.binIn=I.bin||null;
    const go=(I.go||0)>.5; if(go && !n.prevGo) httpcliRun(n); n.prevGo=go;
    return nsvClientOut(n); },
  draw:nsvClientDraw });

const FTPCLI_ACTIONS=['list','download','upload','delete','mkdir','rmdir','rename','size'];
function ftpcliRun(n){
  const host=String(n.hostIn||n.p.host||'').trim(), path=String(n.pathIn||n.p.path||'').trim();
  if(!host){ n.status='set the host'; return; }
  nsvClientRun(n,async ns=>{
    const c=new FtpClient(ns);
    try{
      await c.connect(host,+n.p.port||21,n.p.user||'anonymous',n.p.pass||'dsp@');
      switch(n.p.action){
        case 'list': { const rows=(await c.list(path)).map(f=>({src:'ftp',ev:'entry',name:f.name,dir:f.dir,size:f.size,date:f.date||'',path:(path.replace(/\/$/,'')+'/'+f.name)})); return {status:rows.length+' entries',rows,text:rows.map(r=>(r.dir ? 'd ' : '- ')+r.name).join('\n'),code:rows.length}; }
        case 'download': { if(!path) throw new Error('set the file path'); const b=await c.get(path); return {status:'downloaded '+fmSize(b.length),bin:nsvBin(b,nsvName(path),httpMime(path)),code:b.length,rows:[{src:'ftp',ev:'download',path,bytes:b.length}]}; }
        case 'upload': {
          if(!n.binIn && !(n.textIn||n.p.body)) throw new Error('nothing to upload: wire a file to «bin» or a text to «text»');
          const bytes=n.binIn ? n.binIn.d : nsEnc(String(n.textIn||n.p.body)), dst=path || (n.binIn?.name||'dsp.txt');
          await c.put(dst,bytes); return {status:'uploaded '+fmSize(bytes.length)+' → '+dst,code:bytes.length,rows:[{src:'ftp',ev:'upload',path:dst,bytes:bytes.length}]};
        }
        case 'delete': await c.del(path); return {status:'deleted '+path,rows:[{src:'ftp',ev:'delete',path}]};
        case 'mkdir': await c.mkd(path); return {status:'created '+path,rows:[{src:'ftp',ev:'mkdir',path}]};
        case 'rmdir': await c.rmd(path); return {status:'removed '+path,rows:[{src:'ftp',ev:'rmdir',path}]};
        case 'rename': { const to=String(n.p.to||'').trim(); if(!to) throw new Error('set «to»'); await c.rename(path,to); return {status:path+' → '+to,rows:[{src:'ftp',ev:'rename',path,to}]}; }
        case 'size': { const s=await c.size(path); return {status:path+': '+fmSize(s),code:s,text:String(s)}; }
      }
      throw new Error('unknown action');
    } finally { await c.quit(); }
  });
}
def({ id:'ftpcli', title:'FTP Client (DSP app)', cat:'Sources', kw:'ftp client list download upload delete camera router nas file transfer',
  ins:[{n:'go',t:'num'},{n:'host',t:'txt'},{n:'path',t:'txt'},{n:'text',t:'txt'},{n:'bin',t:'bin'}], outs:NSV_CLI_OUTS, readout:true,
  params:[
    {n:'url',t:'text',d:NSV_URL,label:'bridge of the DSP app'},
    {n:'host',t:'text',d:'',label:'FTP server address (the «host» input overrides)'},
    {n:'port',t:'range',min:1,max:65535,step:1,d:21},
    {n:'user',t:'text',d:'anonymous'},
    {n:'pass',t:'text',d:'dsp@'},
    {n:'action',t:'select',opts:FTPCLI_ACTIONS,d:'list',label:'action (Run, or a rising edge on go)'},
    {n:'path',t:'text',d:'/',label:'path on the server (the «path» input overrides)'},
    {n:'to',t:'text',d:'',label:'rename: new path'},
    {n:'body',t:'text',d:'',label:'upload: text to send when nothing is wired',adv:true},
    {n:'run',t:'button',label:'Run',fn:n=>ftpcliRun(n)}],
  init:n=>{ n.nsP=null; n.ns=null; n.ws=null; n.recQ=[]; n.busy=false; n.status='idle'; n.ok=0; n.code=0; n.pulse=0; n.outBin=null; n.outText=null; n.prevGo=0; n.hostIn=''; n.pathIn=''; n.textIn=''; n.binIn=null; n.cliSrc='ftp'; n.warn=''; },
  dispose:n=>nsvDrop(n),
  process(n,I){
    n.hostIn=typeof I.host==='string' ? I.host : ''; n.pathIn=typeof I.path==='string' ? I.path : ''; n.textIn=typeof I.text==='string' ? I.text : ''; n.binIn=I.bin||null;
    const go=(I.go||0)>.5; if(go && !n.prevGo) ftpcliRun(n); n.prevGo=go;
    return nsvClientOut(n); },
  draw:nsvClientDraw });

/* ============================ Сканер сети и поиск устройств ============================
   Network Scanner: узлы подсети, порты TCP / UDP, таблица ARP; Device Discovery: SSDP / UPnP и mDNS. Ядра — netscan-kernels.js, netdisc-kernels.js. */

const nsvRecId=r=>r.src==='scan' ? (r.kind==='port' ? r.ip+':'+r.port+'/'+r.proto : r.ip) : r.src==='disc' ? r.via+':'+(r.usn||r.location||((r.name||'')+'|'+(r.type||'')+'|'+(r.ip||''))) : '';
function nsvJobStart(n,run){
  if(n.job){ n.status='already running — Stop first'; return; }
  n.job={stop:false}; const job=n.job; n.progress=0; n.found=0; n.status='connecting…'; n.done=0;
  (async()=>{
    try{
      const ns=await nsvLink(n);
      const info=await ns.call('net.info').catch(()=>null);
      n.status='scanning…';
      const r=await run(ns,info,job);
      n.status=(job.stop ? 'stopped · ' : 'done · ')+r;
    }catch(e){ n.status='error: '+(e.message||e); }
    n.job=null; n.progress=1; n.done=2;
  })();
}
function nsvRecOut(n){
  const rec=n.recQ.length ? n.recQ.splice(0) : null, d=n.done>0 ? 1 : 0; if(n.done>0) n.done--;
  return {rec,count:n.found|0,progress:n.progress||0,busy:n.job ? 1 : 0,done:d};
}
function nsvEmit(n){ return r=>{ r.id=nsvRecId(r); n.found++; nsvPush(n,r); }; }

const NSCAN_MODES=['hosts (who is on the network)','ports TCP','ports UDP','ARP table (root)'];
function netscanRun(n){
  const mode=NSCAN_MODES.indexOf(n.p.mode)<0 ? 0 : NSCAN_MODES.indexOf(n.p.mode);
  nsvJobStart(n,async(ns,info,job)=>{
    const target=String(n.hostIn||(mode===0 ? n.p.cidr : n.p.host)||'').trim() || (mode===0 ? scanLocalCidr(info&&info.ips) : (info&&info.gateway)||'');
    if(!target && mode!==3) throw new Error(mode===0 ? 'no private network found: set a network like 192.168.1.0/24' : 'set the host (or a range / network)');
    n.status='scanning '+(target||'ARP')+'…';
    const r=await scanRun(ns,{mode:['hosts','ports','udp','arp'][mode],cidr:target,host:target,ports:mode===0 ? n.p.probe : n.p.ports,ping:!!n.p.ping,arp:!!n.p.arp,concurrency:+n.p.conc||24,
      timeout:+n.p.timeout||undefined,banner:!!n.p.banner,showClosed:!!n.p.closed,showFiltered:!!n.p.filtered,stop:()=>job.stop,onRec:nsvEmit(n),
      onProgress:(d,t)=>{ n.progress=d/t; n.status='scanning '+target+' · '+d+' / '+t+' · found '+n.found; }});
    return (r.hosts!=null ? r.hosts+' host(s)' : r.open+' open port(s)')+' in '+(r.ms/1000).toFixed(1)+' s';
  });
}
def({ id:'netscan', title:'Network Scanner (DSP app)', cat:'Sources', kw:'scan network lan hosts ports tcp udp arp ping nmap discover ip find device portscan banner subnet',
  ins:[{n:'go',t:'num'},{n:'host',t:'txt'}], outs:[{n:'rec',t:'rec'},{n:'count',t:'num'},{n:'progress',t:'num'},{n:'busy',t:'num'},{n:'done',t:'num'}], readout:true, tall:true,
  params:[
    {n:'url',t:'text',d:NSV_URL,label:'bridge of the DSP app'},
    {n:'mode',t:'select',opts:NSCAN_MODES,d:NSCAN_MODES[0],label:'what to scan (Run, or a rising edge on go)'},
    {n:'cidr',t:'text',d:'',label:'hosts: network 192.168.1.0/24, a range 10.0.0.5-60 or a list (empty — the phone\'s own /24)'},
    {n:'host',t:'text',d:'',label:'ports: host, range or network (empty — the gateway); the «host» input overrides both'},
    {n:'ports',t:'text',d:'top',label:'ports: 22,80,8000-8100, top (45 common), all (65535 — slow)'},
    {n:'ping',t:'check',d:true,label:'hosts: ICMP ping first (a real ping; some devices do not answer it)'},
    {n:'probe',t:'text',d:'80,443,22,445,62078',label:'hosts: then TCP ports to knock on — open or «refused» means the host is up (empty — only ping)'},
    {n:'arp',t:'check',d:true,label:'hosts: add MAC addresses from the ARP table afterwards (the app needs «Allow root features»)'},
    {n:'banner',t:'check',d:true,label:'TCP ports: read the banner / Server header'},
    {n:'closed',t:'check',d:false,label:'TCP ports: report closed ones too',adv:true},
    {n:'filtered',t:'check',d:false,label:'UDP ports: report silent ones («open|filtered»)',adv:true},
    {n:'conc',t:'range',min:1,max:28,step:1,d:24,label:'parallel connections (the app allows 32 sockets)',adv:true},
    {n:'timeout',t:'range',min:100,max:5000,step:50,d:500,label:'wait for a connection, ms',adv:true},
    {n:'run',t:'button',label:'Run',fn:n=>netscanRun(n)},
    {n:'stopBtn',t:'button',label:'Stop',fn:n=>{ if(n.job) n.job.stop=true; }}],
  init:n=>{ n.nsP=null; n.ns=null; n.ws=null; n.recQ=[]; n.job=null; n.status='idle'; n.found=0; n.progress=0; n.done=0; n.prevGo=0; n.hostIn=''; n.warn=''; },
  dispose:n=>{ if(n.job) n.job.stop=true; nsvDrop(n); },
  process(n,I){
    n.hostIn=typeof I.host==='string' ? I.host : '';
    const go=(I.go||0)>.5; if(go && !n.prevGo) netscanRun(n); n.prevGo=go;
    return nsvRecOut(n); },
  draw:nsvClientDraw });

function netdiscRun(n){
  nsvJobStart(n,async(ns,info,job)=>{
    const types=n.p.mdns ? String(n.p.types||'').split(/[\s,;]+/).filter(Boolean) : [];
    const r=await discRun(ns,{ssdp:!!n.p.ssdp,st:n.p.st||'ssdp:all',wait:+n.p.wait||4000,desc:!!n.p.desc,mdns:types,mdnsWait:+n.p.mdnsWait||2500,stop:()=>job.stop,onRec:nsvEmit(n)});
    return r.found+' device(s) in '+(r.ms/1000).toFixed(1)+' s';
  });
}
def({ id:'netdisc', title:'Device Discovery (SSDP · mDNS)', cat:'Sources', kw:'discover devices ssdp upnp dlna mdns bonjour zeroconf airplay chromecast cast printer ipp media renderer server tv speaker smart home',
  ins:[{n:'go',t:'num'}], outs:[{n:'rec',t:'rec'},{n:'count',t:'num'},{n:'progress',t:'num'},{n:'busy',t:'num'},{n:'done',t:'num'}], readout:true, tall:true,
  params:[
    {n:'url',t:'text',d:NSV_URL,label:'bridge of the DSP app'},
    {n:'ssdp',t:'check',d:true,label:'SSDP / UPnP: media servers and players (DLNA), routers, TVs, printers'},
    {n:'st',t:'text',d:'ssdp:all',label:'SSDP search target (ssdp:all, upnp:rootdevice, urn:schemas-upnp-org:device:MediaRenderer:1…)'},
    {n:'wait',t:'range',min:1000,max:20000,step:500,d:4000,label:'SSDP: listen for answers, ms'},
    {n:'desc',t:'check',d:true,label:'SSDP: fetch the device description (name, maker, model, services)'},
    {n:'mdns',t:'check',d:true,label:'mDNS / DNS-SD: AirPlay, Chromecast, printers (IPP), SMB, SSH… (one type at a time — Android allows only one search)'},
    {n:'types',t:'text',d:DISC_MDNS.join(', '),label:'mDNS service types'},
    {n:'mdnsWait',t:'range',min:500,max:15000,step:500,d:2500,label:'mDNS: time per type, ms'},
    {n:'run',t:'button',label:'Run',fn:n=>netdiscRun(n)},
    {n:'stopBtn',t:'button',label:'Stop',fn:n=>{ if(n.job) n.job.stop=true; }}],
  init:n=>{ n.nsP=null; n.ns=null; n.ws=null; n.recQ=[]; n.job=null; n.status='idle'; n.found=0; n.progress=0; n.done=0; n.prevGo=0; n.warn=''; },
  dispose:n=>{ if(n.job) n.job.stop=true; nsvDrop(n); },
  process(n,I){
    const go=(I.go||0)>.5; if(go && !n.prevGo) netdiscRun(n); n.prevGo=go;
    return nsvRecOut(n); },
  draw:nsvClientDraw });
