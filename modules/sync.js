"use strict";
/* ============================ Синхронизация устройств ============================
   Файловое хранилище (files / audio / images) и записи Table между устройствами с одним ключом. Ключ пары лежит в менеджере
   паролей аккаунта Google (Credential Management: navigator.credentials.store / get) — его подхватывает Chrome на других
   устройствах; запасные пути: ссылка с #sync=… и ввод вручную. По ключу выводятся комната и шифр сигнальных сообщений
   (rtcRoomKey / rtcSeal из webrtc.js) на MQTT-брокере по WebSocket; данные идут напрямую по WebRTC (канал sync), брокер
   видит только зашифрованные offer / answer. Слияние — ядро sync-kernels.js: побеждает более поздняя правка, удаления помнятся
   метками. Устройств может быть больше двух: каждое соединяется с каждым.
   Второй канал соединения (app) — данные графа между устройствами: узел Sync Data шлёт текст, записи, картинки и файлы (в том числе
   видео из Files) всем или выбранному устройству; файлы идут третьим каналом (file) через XferPort из xfer-kernels.js. */

const SY_LS='dsp.sync', SY_SPACES=['files','audio','images'], SY_CRED='dsp-sync';
const syDefaults={key:'',on:false,url:'wss://broker.emqx.io:8084/mqtt',ice:'stun:stun.l.google.com:19302',maxMB:100,name:''};
function syCfg(){ try{ return {...syDefaults,...JSON.parse(localStorage.getItem(SY_LS)||'{}')}; }catch(e){ return {...syDefaults}; } }
function sySave(c){ try{ localStorage.setItem(SY_LS,JSON.stringify(c)); }catch(e){} }
const syHidden=n=>n==='@patch' || n.startsWith('presets/');
function syMyName(){                                   // имя этого устройства: своё или случайное, но постоянное
  const c=syCfg(); if(c.name) return c.name;
  const n=String(navigator.userAgentData?.platform||navigator.platform||'device').replace(/\s+/g,'')+'-'+Math.random().toString(36).slice(2,6);
  sySave({...c,name:n}); return n;
}
const sySleep=ms=>new Promise(r=>setTimeout(r,ms));

// ---------- метки удаления ----------
let syTombQ=Promise.resolve();
function syTombSet(id,t){
  return syTombQ=syTombQ.then(async()=>{
    const m=(await FileStore.getMeta('syncTomb'))||{}; m[id]=t;
    const old=Date.now()-180*864e5; for(const k in m) if(m[k]<old) delete m[k];
    await FileStore.setMeta('syncTomb',m);
  }).catch(()=>{});
}
async function syncNoteDel(kind,rec){                  // зовут хранилища перед удалением записи
  if(!syCfg().key) return;
  if(kind==='f'){
    const path=(await FileStore.path(rec.folderId)).map(f=>f.name).join('/');
    return syTombSet('f:'+(rec.uid||syLegacyUid(rec.space,path,rec.name,rec.size||0)),Date.now());
  }
  if(kind==='t'){ if(!syHidden(rec.listName)) syTombSet('t:'+(rec.uid||syLegacyUid(rec.listName,rec.name,JSON.stringify(rec.fields))),Date.now()); return; }
  if(kind==='m' && !syHidden(rec.listName)) syTombSet('m:'+rec.listName,Date.now());
}

// ---------- хранилище для SySession ----------
async function syFolderPath(space,fid,byId){
  const a=[]; for(let f=byId.get(fid);f;f=byId.get(f.parentId)) a.unshift(f.name); return a;
}
async function syScan(){
  const man=new Map(), idx=new Map();
  for(const sp of SY_SPACES){
    const byId=new Map((await FileStore.allFolders(sp)).map(f=>[f.id,f]));
    for(const f of await FileStore.listAll(sp)){
      let uid=f.uid;
      if(!uid){ uid=syLegacyUid(sp,(await syFolderPath(sp,f.folderId,byId)).join('/'),f.name,f.size||0); await FileStore.stamp(f.id,{uid}); }
      const id='f:'+uid, m=f.modified||f.created||0;
      man.set(id,{m,d:0,s:f.size||0}); idx.set(id,{k:'f',lid:f.id,m,sp});
    }
  }
  for(const name of await ListDB.listNames()){
    if(syHidden(name)) continue;
    for(const it of await ListDB.list(name)){
      let uid=it.uid;
      if(!uid){ uid=syLegacyUid(it.listName,it.name,JSON.stringify(it.fields)); await ListDB.update(it.id,{uid,modified:it.modified||it.created||0}); it.uid=uid; }
      const id='t:'+uid, m=it.modified||it.created||0;
      man.set(id,{m,d:0,s:0}); idx.set(id,{k:'t',lid:it.id,m,it});
    }
    const meta=await ListDB.getMeta(name);
    if(meta){ const m=meta.modified||1; man.set('m:'+name,{m,d:0,s:0}); idx.set('m:'+name,{k:'m',m,name,meta}); }
  }
  const tomb=(await FileStore.getMeta('syncTomb'))||{};
  for(const id in tomb){ const cur=man.get(id); if(!cur) man.set(id,{m:0,d:tomb[id],s:0}); }     // живая запись сильнее метки
  return {man,idx};
}
async function syEnsureFolders(space,path){
  let parent=null;
  for(const name of path){
    const sub=(await FileStore.listFolders(space,parent)).find(f=>f.name===name);
    parent=sub ? sub.id : await FileStore.addFolder(space,name,parent);
  }
  return parent;
}
const syStore={
  idx:new Map(),
  async manifest(){ const r=await syScan(); this.idx=r.idx; return r.man; },
  async get(id){
    const x=this.idx.get(id); if(!x) return null;
    if(x.k==='f'){
      const r=await FileStore.get(x.lid); if(!r) return null;
      const path=(await FileStore.path(r.folderId)).map(f=>f.name);
      return {head:await bkEnc({k:'f',id,space:r.space,path,name:r.name,mime:r.mime,meta:r.meta,created:r.created,modified:r.modified}),blob:r.blob};
    }
    if(x.k==='t'){ const t=x.it; return {head:await bkEnc({k:'t',id,listName:t.listName,name:t.name,fields:t.fields,value:t.value,created:t.created,modified:x.m}),blob:null}; }
    return {head:await bkEnc({k:'m',id,listName:x.name,meta:x.meta,modified:x.m}),blob:null};
  },
  async apply(h0,blob){
    const h=bkDec(h0), x=this.idx.get(h.id);
    if(x && x.m>=h.modified) return;                   // за время обмена у нас уже не старее
    const uid=h.id.slice(2);
    if(h.k==='f'){
      const folderId=await syEnsureFolders(h.space,h.path);
      const rec={space:h.space,folderId,name:h.name,mime:h.mime,blob:blob ? blob.slice(0,blob.size,h.mime) : new Blob([],{type:h.mime}),meta:h.meta,created:h.created,modified:h.modified,uid};
      if(x) rec.id=x.lid;
      this.idx.set(h.id,{k:'f',lid:await FileStore.put(rec,{keepTime:true}),m:h.modified,sp:h.space});
    } else if(h.k==='t'){
      if(x) await ListDB.update(x.lid,{listName:h.listName,name:h.name,fields:h.fields,value:h.value,created:h.created,uid,modified:h.modified});
      else this.idx.set(h.id,{k:'t',lid:await ListDB.add(h.listName,h.name,h.fields,{uid,created:h.created,modified:h.modified}),m:h.modified});
    } else if(h.k==='m'){
      await ListDB.setMeta(h.listName,{...h.meta,modified:h.modified},true); this.idx.set(h.id,{k:'m',m:h.modified,name:h.listName,meta:h.meta});
    }
  },
  async del(id,t){
    const x=this.idx.get(id);
    if(x){
      if(x.k==='f') await FileStore.remove(x.lid); else if(x.k==='t') await ListDB.remove(x.lid); else await ListDB.delMeta(x.name);
      this.idx.delete(id);
    }
    await syTombSet(id,t);
  },
};

// ---------- соединение ----------
const SyLink={
  on:false, s:null, myId:'', nodes:new Set(), fmsg:'', hiT:null, chT:null, peers:new Map(), msg:'off', onStatus:null, unsub:null,
  say(t){ if(t!==undefined) this.msg=t; this.onStatus?.(this.text()); },
  text(){
    const open=[...this.peers.values()].filter(p=>p.open);
    if(!this.on) return this.msg;
    if(!open.length) return this.msg;
    let pend=0, got=0, del=0, err=0, skip=0;
    for(const p of open){ const s=p.sess?.stat; if(s){ pend+=s.pending; got+=s.got; del+=s.deleted; err+=s.errors; skip+=s.skipped; } }
    return open.length+' device'+(open.length>1 ? 's' : '')+' connected · '+(pend ? 'receiving, '+pend+' left' : 'in sync')
      +(got ? ' · received '+got : '')+(del ? ' · deleted '+del : '')+(skip ? ' · skipped '+skip+' too large' : '')+(err ? ' · errors '+err : '');
  },
  async start(){
    this.stop();
    const c=syCfg(), key=syKeyNorm(c.key);
    if(!key){ this.msg='no key'; this.say(); return; }
    if(!/^wss?:\/\//i.test(c.url)){ this.say('set the broker address (wss://…)'); return; }
    if(!crypto?.subtle || typeof RTCPeerConnection==='undefined' || typeof mqStart!=='function'){ this.say('needs a secure page (https) and WebRTC'); return; }
    this.on=true; this.myId=Math.random().toString(36).slice(2,10);
    const k=await rtcRoomKey('dsp-sync:'+key); if(!this.on) return;
    const s=this.s={ws:null,want:false,ok:false,timer:null,pingT:null,pid:0,cid:'',status:'',warn:'',k,p:{url:c.url,reconnect:true}};
    s.onConnect=()=>{ mqSend(s,mqSubscribe(mqNextId(s),[k.topic],0)); this.say('looking for other devices…'); this.hi(); };
    s.onMessage=(_,p)=>{ rtcOpenMsg(k,mqDec.decode(p.payload)).then(m=>{ if(m && this.s===s) this.sigIn(m); }); };
    this.say('connecting to the broker…');
    mqStart(s);
    this.hiT=setInterval(()=>this.hi(),5000);
    this.unsub=FileStore.onChange(()=>{                // и свои приёмы дают событие: лишний круг ничего не передаёт и заканчивается
      clearTimeout(this.chT); this.chT=setTimeout(()=>this.kick(),3000);
    });
  },
  stop(){
    this.on=false; clearInterval(this.hiT); clearTimeout(this.chT); this.hiT=null;
    this.unsub?.(); this.unsub=null;
    for(const p of [...this.peers.values()]) this.drop(p);
    if(this.s){ mqStop(this.s); this.s=null; }
    this.say('off');
  },
  async pub(o){ const s=this.s; if(s?.ok) mqSend(s,mqPublish(s.k.topic,await rtcSeal(s.k,o),{qos:0})); },
  hi(){ this.pub({t:'hi',from:this.myId}); },
  kick(){
    const open=[...this.peers.values()].filter(p=>p.open);
    if(open.some(p=>p.sess?.stat.pending>0)){ clearTimeout(this.chT); this.chT=setTimeout(()=>this.kick(),3000); return; }     // идёт приём — после него
    for(const p of open) p.sess?.start().catch(()=>{});
  },
  syncNow(){ this.kick(); },
  devices(){                                           // устройства с открытым каналом данных графа
    const l=[...this.peers.values()].filter(p=>p.ac?.readyState==='open' && p.name!==null);
    const lab=syLabels(l.map(p=>({id:p.id,name:p.name})));
    return l.map(p=>({id:p.id,label:lab.get(p.id),p}));
  },
  sendFile(ch,to,blob,name,mime){                      // файл выбранному устройству или всем; число устройств
    let n=0;
    for(const d of this.devices()) if((!to || d.label===to) && d.p.fx?.enqueue(blob,name,mime,{c:ch})) n++;
    return n;
  },
  fileIn(p,m,blob){
    const from=this.devices().find(d=>d.p===p)?.label||p.name||'';
    const nodes=[...this.nodes].filter(n=>n.p.channel===m.c); if(!nodes.length) return;
    fxSave(blob,m.name,m.mime).then(id=>{
      for(const n of nodes){ n.recvQ.push({id,from,name:m.name,mime:m.mime,blob}); n.fgot++; }
      this.fmsg='received '+m.name+' ('+fmSize(blob.size)+') from '+from; this.say();
    }).catch(e=>{ this.fmsg='could not save '+m.name+': '+e.message; this.say(); });
  },
  sendApp(ch,to,text){                                 // to пусто — всем; число отправленных
    let n=0;
    for(const d of this.devices()) if(!to || d.label===to){ try{ d.p.ac.send(JSON.stringify({t:'msg',c:ch,d:String(text).slice(0,65536)})); n++; }catch(e){} }
    return n;
  },
  appIn(p,data){
    let m; try{ m=JSON.parse(data); }catch(e){ return; }
    if(!m) return;
    if(m.t==='name'){ p.name=String(m.name||'').slice(0,40); this.say(); return; }
    if(m.t!=='msg' || typeof m.d!=='string') return;
    const from=this.devices().find(d=>d.p===p)?.label||p.name||'';
    for(const n of this.nodes) if(n.p.channel===m.c){ n.rx.push({from,d:m.d}); if(n.rx.length>200) n.rx.shift(); }
  },
  drop(p){
    if(this.peers.get(p.id)===p) this.peers.delete(p.id);
    p.open=false; clearTimeout(p.dead);
    try{ p.dc.onopen=p.dc.onclose=p.dc.onmessage=null; p.dc.close(); }catch(e){}
    try{ p.ac.onopen=p.ac.onclose=p.ac.onmessage=null; p.ac.close(); }catch(e){}
    try{ p.fx.close(); p.fc.onmessage=p.fc.onclose=null; p.fc.close(); }catch(e){}
    try{ p.pc.onconnectionstatechange=null; p.pc.close(); }catch(e){}
    if(this.on) this.say(this.peers.size ? undefined : 'looking for other devices…');
  },
  mkPeer(id,initiator){
    const c=syCfg(), ice=String(c.ice||'').split(/[\s,]+/).filter(Boolean).map(urls=>({urls}));
    const pc=new RTCPeerConnection({iceServers:ice}), dc=pc.createDataChannel('sync',{negotiated:true,id:0}); dc.binaryType='arraybuffer';
    const ac=pc.createDataChannel('app',{negotiated:true,id:1}), fc=pc.createDataChannel('file',{negotiated:true,id:2}); fc.binaryType='arraybuffer'; fc.bufferedAmountLowThreshold=1<<18;
    const p={id,pc,dc,ac,fc,fx:null,name:null,open:false,sess:null,initiator,dead:0};
    const sess=()=>p.sess||(p.sess=new SySession(syStore,x=>this.tx(p,x),{maxBytes:(+c.maxMB||100)*1048576,on:()=>this.say()}));
    dc.onopen=()=>{ p.open=true; clearTimeout(p.dead); this.say(); if(initiator) sess().start().catch(()=>{}); };
    dc.onmessage=e=>sess().onMessage(e.data);
    dc.onclose=()=>this.drop(p);
    p.fx=new XferPort(x=>this.tx(p,x,fc),{maxBytes:(+c.maxMB||100)*1048576,accept:m=>[...this.nodes].some(n=>n.p.channel===m.c),
      onFile:(m,b)=>this.fileIn(p,m,b),on:()=>{ this.fmsg=p.fx.stat.msg; this.say(); }});
    fc.onmessage=e=>p.fx.onMessage(e.data);
    ac.onopen=()=>{ try{ ac.send(JSON.stringify({t:'name',name:syMyName()})); }catch(e){} };
    ac.onmessage=e=>{ if(typeof e.data==='string') this.appIn(p,e.data); };
    pc.onconnectionstatechange=()=>{ if(pc.connectionState==='failed' || pc.connectionState==='closed') this.drop(p); };
    p.dead=setTimeout(()=>{ if(!p.open) this.drop(p); },30000);          // не соединились — следующий hi начнёт заново
    this.peers.set(id,p); return p;
  },
  async tx(p,x,ch=p.dc){
    while(ch.bufferedAmount>1<<20){ if(ch.readyState!=='open') throw new Error('closed'); await sySleep(30); }
    if(ch.readyState!=='open') throw new Error('closed');
    ch.send(x);
  },
  async gather(pc){
    if(pc.iceGatheringState!=='complete') await new Promise(res=>{
      const t=setTimeout(res,5000);
      pc.onicegatheringstatechange=()=>{ if(pc.iceGatheringState==='complete'){ clearTimeout(t); res(); } };
    });
    const d=pc.localDescription; return {type:d.type,sdp:d.sdp};
  },
  async sigIn(m){
    if(!m || m.from===this.myId || typeof m.from!=='string') return;
    const cur=this.peers.get(m.from);
    if(m.t==='hi'){
      if(cur && (cur.open || Date.now()-cur.t0<25000)) return;
      if(cur) this.drop(cur);
      if(this.myId<m.from){
        const p=this.mkPeer(m.from,true); p.t0=Date.now();
        await p.pc.setLocalDescription(await p.pc.createOffer());
        this.pub({t:'offer',from:this.myId,to:m.from,code:await this.gather(p.pc)});
      }
    } else if(m.t==='offer' && m.to===this.myId){
      if(cur) this.drop(cur);
      const p=this.mkPeer(m.from,false); p.t0=Date.now();
      await p.pc.setRemoteDescription(m.code);
      await p.pc.setLocalDescription(await p.pc.createAnswer());
      this.pub({t:'answer',from:this.myId,to:m.from,code:await this.gather(p.pc)});
    } else if(m.t==='answer' && m.to===this.myId && cur && cur.initiator && !cur.open && cur.pc.signalingState==='have-local-offer'){
      await cur.pc.setRemoteDescription(m.code);
    }
  },
};

// принятый файл → хранилище (audio / images / files), папка Received; id записи
async function fxSave(blob,name,mime){
  const sp=(mime||'').startsWith('audio/') ? 'audio' : (mime||'').startsWith('image/') ? 'images' : 'files';
  let folder=(await FileStore.listFolders(sp,null)).find(f=>f.name==='Received');
  const fid=folder ? folder.id : await FileStore.addFolder(sp,'Received',null);
  try{ return await FileStore.importFile(sp,blob,fid,name); }
  catch(e){ return await FileStore.put({space:'files',folderId:0,name,mime:blob.type,blob}); }   // не декодируется как звук — просто файл
}
function syImgBlob(im){                                // картинка графа (ImageData или серый буфер) → PNG
  return new Promise((res,rej)=>{
    const cv=document.createElement('canvas'); cv.width=im.w; cv.height=im.h; const cx=cv.getContext('2d');
    if(im.gray){ const id=cx.createImageData(im.w,im.h), d=id.data, b=im.buf; for(let k=0;k<b.length;k++){ const v=b[k]*255, j=k*4; d[j]=d[j+1]=d[j+2]=v; d[j+3]=255; } cx.putImageData(id,0,0); }
    else cx.putImageData(im.data,0,0);
    cv.toBlob(b=>b ? res(b) : rej(new Error('cannot encode the picture')),'image/png');
  });
}

// ---------- узел графа: данные между устройствами ----------
const syTo=(n,I)=>typeof I?.to==='string' && I.to ? I.to : n.p.device==='all devices' ? '' : n.p.device;
function syNodeText(n,text){ n.sent+=SyLink.sendApp(n.p.channel,syTo(n,n.lastI),text); }
function syNodeFile(n,blob,name,mime){
  const k=SyLink.sendFile(n.p.channel,syTo(n,n.lastI),blob,name,mime);
  SyLink.fmsg=k ? 'sending '+name+' ('+fmSize(blob.size)+') to '+k+' device'+(k>1 ? 's' : '') : 'no device to send '+name+' to'; SyLink.say();
}
def({ id:'syncdata', title:'Sync Data', cat:'Sources', kw:'sync devices send text between my devices phone laptop channel share',
  ins:[{n:'send',t:'txt'},{n:'to',t:'txt'},{n:'sendFile',t:'num'},{n:'img',t:'img'},{n:'rec',t:'rec'}],
  outs:[{n:'line',t:'txt'},{n:'go',t:'num'},{n:'from',t:'txt'},{n:'rec',t:'rec'},{n:'count',t:'num'},{n:'devices',t:'num'},{n:'file',t:'num'},{n:'got',t:'num'},{n:'img',t:'img'}],
  readout:true, tall:true,
  params:[
    {n:'channel',t:'text',d:'data',label:'channel name (receivers take only messages of the same name)'},
    {n:'imgGap',t:'range',min:.2,max:30,step:.1,d:2,label:'pictures from `img`: no more often than, s'},
    {n:'sendpick',t:'button',label:'Send file…',fn:n=>{ const inp=document.createElement('input'); inp.type='file'; inp.multiple=true; inp.hidden=true;
      inp.onchange=()=>{ const fs=[...inp.files]; inp.remove(); for(const f of fs) syNodeFile(n,f,f.name,f.type); }; inp.oncancel=()=>inp.remove(); document.body.append(inp); inp.click(); }},
    {n:'device',t:'select',opts:n=>{ const o=['all devices',...SyLink.devices().map(d=>d.label)]; if(n.p.device && !o.includes(n.p.device)) o.push(n.p.device); return o; },d:'all devices',label:'send to (devices that keep the sync on; set their names in Sync devices)'},
  ],
  init:n=>{ n.rx=[]; n.recvQ=[]; n.fgot=0; n.lastFile=-1; n.lastSendId=undefined; n.lastRev=-1; n.imgT=0; n.rimg=null; n.lastRec=null; n.lineQ=[]; n.recQ=[]; n.lastLine=''; n.lastFrom=''; n.count=0; n.msgs=0; n.sent=0; n.lastSend=undefined; SyLink.nodes.add(n); },
  dispose:n=>{ SyLink.nodes.delete(n); },
  process(n,I){
    SyLink.nodes.add(n); n.lastI=I;
    if(typeof I.send==='string' && I.send!==n.lastSend){
      n.lastSend=I.send;
      n.sent+=SyLink.sendApp(n.p.channel,syTo(n,I),I.send);
    }
    if(typeof I.sendFile==='number' && I.sendFile!==n.lastSendId){
      n.lastSendId=I.sendFile;
      if(I.sendFile>=0) FileStore.get(I.sendFile).then(r=>{ if(r?.blob) syNodeFile(n,r.blob,fmFileName(r),r.mime||r.blob.type); }).catch(()=>{});
    }
    if(I.img && I.img.rev!==n.lastRev && performance.now()-n.imgT>=n.p.imgGap*1000){
      n.lastRev=I.img.rev; n.imgT=performance.now();
      syImgBlob(I.img).then(b=>syNodeFile(n,b,'picture-'+Date.now()+'.png','image/png')).catch(()=>{});
    }
    if(Array.isArray(I.rec) && I.rec.length && I.rec!==n.lastRec){ n.lastRec=I.rec; syNodeText(n,JSON.stringify(I.rec)); }
    let got=0;
    if(n.recvQ.length){
      const f=n.recvQ.shift(); n.lastFile=f.id; n.lastFrom=f.from; got=1;
      if(f.mime?.startsWith('image/')) createImageBitmap(f.blob).then(bm=>{
        const c=document.createElement('canvas'); c.width=bm.width; c.height=bm.height; const cx=c.getContext('2d'); cx.drawImage(bm,0,0); bm.close?.();
        n.rimg={data:cx.getImageData(0,0,c.width,c.height),w:c.width,h:c.height,gray:false,rev:(n.rimg?.rev|0)+1}; }).catch(()=>{});
    }
    const it=n.rx.shift(); if(it){ n.lastFrom=it.from; netTextFeed(n,it.d); }
    let go=0;
    if(n.lineQ.length){ n.lastLine=n.lineQ.shift(); go=1; n.count++; }
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    return {line:n.lastLine, go, from:n.lastFrom, rec, count:n.count, devices:SyLink.devices().length, file:n.lastFile, got, img:n.rimg}; },
  drawKey:n=>SyLink.on+'|'+SyLink.devices().map(d=>d.label).join()+'|'+n.msgs+'|'+n.sent+'|'+n.lastFrom+'|'+SyLink.fmsg+'|'+n.fgot,
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const d=SyLink.devices();
    r.textContent=(!SyLink.on ? 'sync is off: open “Sync devices”, enter the key and tick “keep in sync”' : d.length ? 'devices: '+d.map(x=>x.label).join(', ') : 'no other device connected')
      +'\nme: '+syMyName()+' · sent '+n.sent+' · received '+n.msgs+(n.fgot ? ' · files '+n.fgot : '')+(SyLink.fmsg ? '\nfile: '+SyLink.fmsg : '')+(n.lastLine ? '\n'+(n.lastFrom ? n.lastFrom+': ' : '')+n.lastLine.slice(0,400) : ''); }
});

// ---------- ключ в аккаунте ----------
async function syCredSave(key){
  if(!window.PasswordCredential || !navigator.credentials?.store) throw new Error('this browser cannot store the key in the account password manager');
  await navigator.credentials.store(new PasswordCredential({id:SY_CRED,name:'DSP sync key',password:key}));
}
async function syCredGet(){
  if(!window.PasswordCredential || !navigator.credentials?.get) throw new Error('this browser cannot read the account password manager');
  const c=await navigator.credentials.get({password:true,mediation:'optional'});
  return c && c.id===SY_CRED ? c.password : null;
}

// ---------- окно ----------
function syDialog(){
  const ov=document.createElement('div');
  ov.style.cssText='position:fixed;inset:0;z-index:200;background:var(--scrim);display:flex;align-items:center;justify-content:center';
  const box=document.createElement('div');
  box.style.cssText='background:var(--panel);color:var(--txt);border:1px solid var(--line);border-radius:6px;padding:14px;width:min(520px,92vw);max-height:90vh;overflow:auto;font-size:12px;display:flex;flex-direction:column;gap:8px';
  ov.append(box); document.body.append(ov);
  const btn=(t,f,title)=>{ const b=document.createElement('button'); b.textContent=t; if(title) b.title=title;
    b.style.cssText='background:var(--panel2);color:var(--txt);border:1px solid var(--line);border-radius:4px;padding:6px 10px;font:inherit;cursor:pointer';
    b.onclick=async()=>{ try{ await f(); }catch(e){ note.textContent='Failed: '+(e.message||e); note.style.color='var(--err)'; } }; return b; };
  const inp=(v,ph)=>{ const i=document.createElement('input'); i.type='text'; i.value=v; i.placeholder=ph||''; i.autocomplete='off'; i.spellcheck=false;
    i.style.cssText='background:var(--panel2);color:var(--txt);border:1px solid var(--line);border-radius:4px;padding:5px 8px;font:inherit;min-width:0;flex:1'; return i; };
  const row=(...a)=>{ const r=document.createElement('div'); r.style.cssText='display:flex;gap:6px;align-items:center;flex-wrap:wrap'; r.append(...a); return r; };
  const dim=t=>{ const d=document.createElement('div'); d.style.color='var(--dim)'; d.textContent=t; return d; };
  const title=document.createElement('b'); title.style.fontSize='13px'; title.textContent='Sync devices';
  const status=document.createElement('div'); status.style.cssText='min-height:1.4em;white-space:pre-wrap';
  const note=document.createElement('div'); note.style.cssText='color:var(--dim);min-height:1.4em;white-space:pre-wrap';
  const nameIn=inp(syCfg().name||syMyName(),'name of this device');
  const keyIn=inp(syCfg().key,'key of the pair, XXXXX-XXXXX-…');
  const urlIn=inp(syCfg().url,'wss://broker…'), iceIn=inp(syCfg().ice,'stun:…'), mbIn=inp(String(syCfg().maxMB),'MB'); mbIn.style.maxWidth='70px'; mbIn.style.flex='0 0 70px';
  const onChk=document.createElement('input'); onChk.type='checkbox'; onChk.checked=syCfg().on;
  const save=()=>{
    const c=syCfg(), k=syKeyNorm(keyIn.value);
    if(keyIn.value.trim() && !k) throw new Error('the key is not valid (26 characters)');
    sySave({...c,name:nameIn.value.trim().slice(0,40),key:k||'',url:urlIn.value.trim(),ice:iceIn.value.trim(),maxMB:+mbIn.value||100,on:onChk.checked});
    keyIn.value=k||'';
  };
  const apply=()=>{ save(); const c=syCfg(); if(c.on && c.key) SyLink.start(); else SyLink.stop(); note.style.color='var(--dim)'; };
  onChk.onchange=()=>{ try{ apply(); }catch(e){ onChk.checked=false; note.textContent='Failed: '+e.message; note.style.color='var(--err)'; } };
  const mk=()=>{ keyIn.value=syKeyGen(); save(); note.textContent='New key made. Save it to your Google account (or copy the link) and enter it on the other device.'; };
  box.append(title,
    dim('Files (Files, Audio, Images) and Table records are kept the same on all devices that have this key: the newer edit wins, deletions are passed on. Data goes straight between the devices (WebRTC); the broker sees only encrypted connection offers.'),
    status,
    row(onChk,Object.assign(document.createElement('span'),{textContent:'keep in sync while the app is open'})),
    dim('Name of this device (shown in Sync Data to choose where to send)'), row(nameIn),
    dim('Key of the pair'),
    row(keyIn,btn('New key',mk,'Make a random key for a new pair of devices')),
    row(
      btn('Save to Google account',async()=>{ save(); const k=syCfg().key; if(!k) throw new Error('make or enter a key first'); await syCredSave(k); note.textContent='Saved to the password manager. On the other device press “Get from Google account”.'; },'Chrome keeps it with your saved passwords and syncs it between devices signed in to the same account'),
      btn('Get from Google account',async()=>{ const k=await syCredGet(); if(!k) throw new Error('no saved key found'); keyIn.value=k; apply(); note.textContent='Key received.'; }),
      btn('Copy link',async()=>{ save(); const k=syCfg().key; if(!k) throw new Error('make or enter a key first'); const u=location.origin+location.pathname+'#sync='+k; try{ await navigator.clipboard.writeText(u); note.textContent='Link copied: open it on the other device (for example “Send to your devices” in Chrome).'; }catch(e){ note.textContent=u; } },'The link contains the key; send it only to your own devices'),
      btn('Show QR',async()=>{ save(); const k=syCfg().key; if(!k) throw new Error('make or enter a key first'); await qrShow('Key of the pair',location.origin+location.pathname+'#sync='+k,'Scan it with “Scan QR” on the other device (or its camera app: the code is a link). Anyone who sees this code can join the pair.'); },'Show the key as a QR code for the other device'),
      btn('Scan QR',async()=>{ await qrScan('Scan the key of the pair',t=>{ const k=syKeyFromText(t); if(!k) return false; keyIn.value=k; onChk.checked=true; apply(); note.textContent='Key received from the QR code.'; }); },'Read the key from the QR code shown on the other device')),
    row(btn('Apply',()=>{ if(!onChk.checked) onChk.checked=true; apply(); note.textContent='Applied.'; }),btn('Sync now',()=>SyLink.syncNow()),btn('Forget key',()=>{ keyIn.value=''; onChk.checked=false; save(); SyLink.stop(); note.textContent='Key removed from this device.'; })),
    dim('Broker (MQTT over WebSocket, any public or own)'), row(urlIn),
    dim('STUN server (empty — same network only)  ·  largest file, MB'), row(iceIn,mbIn),
    note, row(btn('Close',()=>{ SyLink.onStatus=null; ov.remove(); })));
  SyLink.onStatus=t=>{ status.textContent='Status: '+t; };
  status.textContent='Status: '+SyLink.text();
}

(()=>{
  const b=document.getElementById('syncOpen'); if(b) b.onclick=syDialog;
  const c=syCfg(), hm=location.hash.match(/[#&]sync=([^&]*)/), hk=hm ? syKeyNorm(decodeURIComponent(hm[1])) : null;
  if(hk && hk!==c.key){                                 // открыли ссылку пары
    history.replaceState(null,'',location.pathname+location.search);
    if(confirm('Pair this device for sync with the link key? Files and Table records will be merged with the other devices.')){ sySave({...c,key:hk,on:true}); }
  }
  if(syCfg().on && syCfg().key) setTimeout(()=>SyLink.start(),2500);
})();
