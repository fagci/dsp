"use strict";
/* ============================ SMB Client, File Copy (приложение DSP) ============================
   SMB Client — общая папка Windows / Samba / NAS: список, скачать, залить, удалить, переименовать (modules/smb-kernels.js, SMB 2.x, NTLMv2).
   File Copy — копирование файла или папки между любыми двумя местами: папка в Files (files://Share/sub), ftp://, smb://, tftp://, http(s)://;
   так же строится мост «ftp ⇄ smb» разовой передачей. Постоянный мост (сервер над чужой шарой) — поле source у HTTP / FTP / TFTP Server.
   Сокеты и обвязка узла — из netsvc.js (nsvLink, nsvClientRun…), протоколы — rfs-kernels.js; проверяется в tools/test-smb.mjs / test-rfs.mjs. */

const SMBCLI_ACTIONS=['list','download','upload','delete','mkdir','rmdir','rename','size'];
function smbcliRun(n){
  const host=String(n.hostIn||n.p.host||'').trim(), path=String(n.pathIn||n.p.path||'').trim();
  if(!host){ n.status='set the host'; return; }
  if(!String(n.p.share||'').trim()){ n.status='set the share name'; return; }
  nsvClientRun(n,async ns=>{
    const c=new SmbClient(ns,{user:String(n.p.user||''),pass:String(n.p.pass||''),domain:String(n.p.domain||'')});
    try{
      await c.connect(host,+n.p.port||445,n.p.share);
      switch(n.p.action){
        case 'list': { const base=path.replace(/\/+$/,''); const rows=(await c.list(path)).map(f=>({src:'smb',ev:'entry',name:f.name,dir:f.dir,size:f.size,mtime:f.mtime,path:base+'/'+f.name})); return {status:rows.length+' entries',rows,text:rows.map(r=>(r.dir ? 'd ' : '- ')+r.name).join('\n'),code:rows.length}; }
        case 'download': { if(!path) throw new Error('set the file path'); const b=await c.read(path); return {status:'downloaded '+fmSize(b.length),bin:nsvBin(b,nsvName(path),httpMime(path)),code:b.length,rows:[{src:'smb',ev:'download',path,bytes:b.length}]}; }
        case 'upload': {
          if(!n.binIn && !(n.textIn||n.p.body)) throw new Error('nothing to upload: wire a file to «bin» or a text to «text»');
          const bytes=n.binIn ? n.binIn.d : nsEnc(String(n.textIn||n.p.body)), dst=path || (n.binIn?.name||'dsp.txt');
          const dir=vfsSplit(dst)[0]; if(dir!=='/') await c.mkdir(dir);
          await c.write(dst,bytes); return {status:'uploaded '+fmSize(bytes.length)+' → '+dst,code:bytes.length,rows:[{src:'smb',ev:'upload',path:dst,bytes:bytes.length}]};
        }
        case 'delete': { await c.remove(path); return {status:'deleted '+path,rows:[{src:'smb',ev:'delete',path}]}; }
        case 'mkdir': { await c.mkdir(path); return {status:'created '+path,rows:[{src:'smb',ev:'mkdir',path}]}; }
        case 'rmdir': { await c.remove(path); return {status:'removed '+path,rows:[{src:'smb',ev:'rmdir',path}]}; }
        case 'rename': { const to=String(n.p.to||'').trim(); if(!to) throw new Error('set «to»'); await c.rename(path,to); return {status:path+' → '+to,rows:[{src:'smb',ev:'rename',path,to}]}; }
        case 'size': { const st=await c.stat(path); if(!st) throw new Error('not found: '+path); return {status:path+': '+fmSize(st.size),code:st.size,text:String(st.size)}; }
      }
      throw new Error('unknown action');
    } finally { await c.close(); }
  });
}
def({ id:'smbcli', title:'SMB Client (DSP app)', cat:'Sources', kw:'smb cifs samba windows share network folder nas client list download upload delete rename file transfer ntlm',
  ins:[{n:'go',t:'num'},{n:'host',t:'txt'},{n:'path',t:'txt'},{n:'text',t:'txt'},{n:'bin',t:'bin'}], outs:NSV_CLI_OUTS, readout:true,
  params:[
    {n:'url',t:'text',d:NSV_URL,label:'bridge of the DSP app'},
    {n:'host',t:'text',d:'',label:'server address (the «host» input overrides)'},
    {n:'port',t:'range',min:1,max:65535,step:1,d:445},
    {n:'share',t:'text',d:'',label:'share name (the folder the server publishes: Users, Public, Media…)'},
    {n:'user',t:'text',d:'',label:'user (empty — anonymous / guest)'},
    {n:'pass',t:'text',d:''},
    {n:'domain',t:'text',d:'',label:'domain or workgroup (usually empty)',adv:true},
    {n:'action',t:'select',opts:SMBCLI_ACTIONS,d:'list',label:'action (Run, or a rising edge on go)'},
    {n:'path',t:'text',d:'/',label:'path inside the share (the «path» input overrides)'},
    {n:'to',t:'text',d:'',label:'rename: new path'},
    {n:'body',t:'text',d:'',label:'upload: text to send when nothing is wired',adv:true},
    {n:'run',t:'button',label:'Run',fn:n=>smbcliRun(n)}],
  init:n=>{ n.nsP=null; n.ns=null; n.ws=null; n.recQ=[]; n.busy=false; n.status='idle'; n.ok=0; n.code=0; n.pulse=0; n.outBin=null; n.outText=null; n.prevGo=0; n.hostIn=''; n.pathIn=''; n.textIn=''; n.binIn=null; n.cliSrc='smb'; n.warn=''; },
  dispose:n=>nsvDrop(n),
  process(n,I){
    n.hostIn=typeof I.host==='string' ? I.host : ''; n.pathIn=typeof I.path==='string' ? I.path : ''; n.textIn=typeof I.text==='string' ? I.text : ''; n.binIn=I.bin||null;
    const go=(I.go||0)>.5; if(go && !n.prevGo) smbcliRun(n); n.prevGo=go;
    return nsvClientOut(n); },
  draw:nsvClientDraw });

/* ---------- File Copy ---------- */
function fcopyRun(n){
  const from=String(n.fromIn||n.p.from||'').trim(), to=String(n.toIn||n.p.to||'').trim();
  if(!from || !to){ n.status='set «from» and «to» (files://Share/dir · ftp://user:pass@host/dir · smb://user:pass@host/SHARE/dir · tftp://host/file · http://host/dir)'; return; }
  n.stopReq=false; n.progress=0; n.count=0;
  nsvClientRun(n,async ns=>{
    const opt={local:p=>new VfsFiles(p,new Map())};
    let src=null, dst=null;
    try{
      src=await rfsOpenTree(ns,from,opt);
      dst=rfsOpen(ns,to,opt);
      if(/\/$/.test(to)) await dst.mkdir('/');                              // «…/dir/» — это папка: создаём
      const rows=[]; let last=0;
      const r=await rfsCopy(src.vfs,src.path,dst,'/',{overwrite:!!n.p.overwrite,maxBytes:(+n.p.maxMb||512)<<20,stop:()=>n.stopReq,
        onFile:x=>{ const row={src:'copy',ev:x.ev,path:x.path,to:x.to,bytes:x.bytes,msg:x.msg}; rows.push(row); nsvPush(n,row); n.count=(n.count|0)+(x.ev==='copy' ? 1 : 0); n.status='copying · '+n.count+' files · '+nsvName(x.path); },
        onProgress:(d,t)=>{ n.progress=t ? d/t : 0; }});
      if(n.p.move && !r.errors.length && !n.stopReq) await src.vfs.remove(src.path);
      const msg=r.files+' file(s), '+fmSize(r.bytes)+(r.skipped ? ' · skipped '+r.skipped : '')+(r.errors.length ? ' · errors: '+r.errors.length+' (first: '+r.errors[0]+')' : '')+(n.p.move && !r.errors.length ? ' · source removed' : '');
      n.progress=1;
      return {status:msg,code:r.files,text:msg,ok:r.errors.length ? 0 : 1};
    } finally { for(const x of [src&&src.vfs,dst]) if(x&&x.close) await x.close().catch(()=>{}); }
  });
}
def({ id:'filecopy', title:'File Copy / Bridge (DSP app)', cat:'Sources', kw:'file copy sync transfer move bridge ftp smb tftp http folder mirror backup nas share router camera push pull',
  ins:[{n:'go',t:'num'},{n:'from',t:'txt'},{n:'to',t:'txt'}], outs:[...NSV_CLI_OUTS,{n:'progress',t:'num'}], readout:true,
  params:[
    {n:'url',t:'text',d:NSV_URL,label:'bridge of the DSP app'},
    {n:'from',t:'text',d:'smb://user:password@nas/Share/folder',label:'copy from: files://Share/dir (a folder in Files) · ftp://user:pass@host/dir · smb://[DOMAIN;]user:pass@host/SHARE/dir · tftp://host/file · http://host/dir (the «from» input overrides)'},
    {n:'to',t:'text',d:'ftp://user:password@192.168.0.1/backup/',label:'copy to: the same kinds of address; a trailing / means a folder (the «to» input overrides)'},
    {n:'overwrite',t:'check',d:true,label:'overwrite files that exist at the destination'},
    {n:'move',t:'check',d:false,label:'move: delete the source after a copy without errors',adv:true},
    {n:'maxMb',t:'range',min:1,max:2048,step:1,d:512,label:'largest file, MB (a file is held in memory while it is copied)',adv:true},
    {n:'run',t:'button',label:'Copy',fn:n=>fcopyRun(n)},
    {n:'stopBtn',t:'button',label:'Stop',fn:n=>{ n.stopReq=true; }}],
  init:n=>{ n.nsP=null; n.ns=null; n.ws=null; n.recQ=[]; n.busy=false; n.status='idle'; n.ok=0; n.code=0; n.pulse=0; n.outBin=null; n.outText=null; n.prevGo=0; n.fromIn=''; n.toIn=''; n.cliSrc='copy'; n.warn=''; n.progress=0; n.stopReq=false; n.count=0; },
  dispose:n=>{ n.stopReq=true; nsvDrop(n); },
  process(n,I){
    n.fromIn=typeof I.from==='string' ? I.from : ''; n.toIn=typeof I.to==='string' ? I.to : '';
    const go=(I.go||0)>.5; if(go && !n.prevGo) fcopyRun(n); n.prevGo=go;
    return {...nsvClientOut(n),progress:n.progress||0}; },
  draw:nsvClientDraw });
