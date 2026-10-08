"use strict";
/* ============================ WebRTC Data ============================
   Прямой канал между двумя браузерами (RTCDataChannel) без сервера: код соединения (offer / answer) передаётся вручную —
   через мессенджер или буфер обмена. Один узел делает Offer, второй принимает его (Accept offer) и отдаёт Answer,
   первый применяет Answer. Дальше текст идёт как у Text over Network (строки в line, JSON — в rec). В одной сети STUN не
   нужен; через интернет — укажите STUN-сервер. Разбор сообщений — netTextFeed (sources.js).
   Каналов два: dsp — текст (чат, игры), file — файлы кусками с контролем буфера (текст при передаче не стоит). Принятый файл
   кладётся в файловое хранилище (filestore.js), папка Received; отправить можно файл с устройства или по id хранилища. */

function rtcClose(n){
  n.gen=(n.gen|0)+1;
  const dc=n.dc, fc=n.fc, pc=n.pc; n.dc=n.fc=n.pc=null; n.open=false; n.fopen=false; n.rx=null; n.txQ=[]; n.tx=null;
  for(const c of [dc,fc]) if(c){ c.onopen=c.onclose=c.onmessage=null; try{ c.close(); }catch(e){} }
  if(pc){ pc.onconnectionstatechange=pc.ondatachannel=null; try{ pc.close(); }catch(e){} }
  n.status='closed';
}
const rtcEnc=d=>btoa(unescape(encodeURIComponent(JSON.stringify({type:d.type,sdp:d.sdp}))));
const rtcDec=s=>JSON.parse(decodeURIComponent(escape(atob(String(s).replace(/\s+/g,'')))));
function rtcMake(n){
  rtcClose(n);
  if(typeof RTCPeerConnection==='undefined'){ n.status='WebRTC is not supported by this browser'; return null; }
  const ice=String(n.p.ice||'').split(/[\s,]+/).filter(Boolean).map(urls=>({urls}));
  const pc=new RTCPeerConnection({iceServers:ice}), gen=n.gen;
  n.pc=pc;
  pc.onconnectionstatechange=()=>{
    if(n.gen!==gen) return;
    if(pc.connectionState==='failed' || pc.connectionState==='closed'){ n.open=n.fopen=false; n.neg=0; n.status='connection '+pc.connectionState; }
    else if(!n.open) n.status='connection: '+pc.connectionState;
  };
  return pc;
}
function rtcAttach(n,dc){
  if(dc.label==='file') return rtcAttachFile(n,dc);
  const gen=n.gen; n.dc=dc;
  dc.onopen=()=>{ if(n.gen===gen){ n.open=true; n.status='connected'; n.code=''; } };
  dc.onclose=()=>{ if(n.gen===gen){ n.open=false; n.neg=0; n.status='channel closed'; } };
  dc.onmessage=e=>{ if(typeof e.data==='string') netTextFeed(n,e.data); };
}

/* ---- файлы ----
   Сообщения канала file: строка JSON {t:'file',xid,name,mime,size} → куски ArrayBuffer → {t:'end',xid}; {t:'cancel',xid} с любой стороны. */
const RTC_CHUNK=16384, RTC_HIGH=1<<20;
function rtcAttachFile(n,fc){
  const gen=n.gen; n.fc=fc; fc.binaryType='arraybuffer'; fc.bufferedAmountLowThreshold=RTC_HIGH/4;
  fc.onopen=()=>{ if(n.gen===gen){ n.fopen=true; rtcPump(n); } };
  fc.onclose=()=>{ if(n.gen===gen){ n.fopen=false; n.rx=null; } };
  fc.onmessage=e=>{ if(n.gen===gen) rtcFileMsg(n,e.data); };
}
function rtcFileMsg(n,d){
  if(typeof d!=='string'){                              // кусок текущего приёма
    const r=n.rx; if(!r || r.skip) return;
    r.parts.push(d); r.got+=d.byteLength; n.prog=r.size ? r.got/r.size : 0; n.msgs++; return;
  }
  let m; try{ m=JSON.parse(d); }catch(e){ return; }
  if(m.t==='file'){
    const max=(+n.p.maxMB||200)*1048576;
    if(m.size>max){ n.fstat='refused '+m.name+' (over '+n.p.maxMB+' MB)'; n.fc?.send(JSON.stringify({t:'cancel',xid:m.xid})); n.rx={xid:m.xid,skip:true,parts:[],got:0,size:0}; return; }
    n.rx={xid:m.xid,name:m.name,mime:m.mime,size:m.size,parts:[],got:0}; n.prog=0; n.fstat='receiving '+m.name+'…';
  } else if(m.t==='end' && n.rx && n.rx.xid===m.xid){
    const r=n.rx; n.rx=null;
    if(!r.skip) n.storeP=(n.storeP||Promise.resolve()).then(()=>rtcStore(n,r));   // по очереди: иначе две папки Received
  } else if(m.t==='cancel'){
    if(n.tx && n.tx.xid===m.xid){ n.tx.cancel=true; n.fstat='declined by the other side: '+n.tx.name; }
    if(n.rx && n.rx.xid===m.xid){ n.rx=null; n.fstat='transfer cancelled'; }
  }
}
async function rtcStore(n,r){
  const blob=new Blob(r.parts,{type:r.mime||'application/octet-stream'});
  const sp=(r.mime||'').startsWith('audio/') ? 'audio' : (r.mime||'').startsWith('image/') ? 'images' : 'files';
  try{
    let folder=(await FileStore.listFolders(sp,null)).find(f=>f.name==='Received');
    const fid=folder ? folder.id : await FileStore.addFolder(sp,'Received',null);
    let id;
    try{ id=await FileStore.importFile(sp,blob,fid,r.name); }
    catch(e){ id=await FileStore.put({space:'files',folderId:0,name:r.name,mime:blob.type,blob}); }   // не декодируется как звук — просто файл
    n.recvQ.push({id,name:r.name}); n.fstat='received '+r.name+' ('+fmSize(blob.size)+')';
  }catch(e){ n.fstat='could not save '+r.name+': '+e.message; }
  n.prog=0;
}
function rtcSendFile(n,blob,name){
  if(!n.fopen){ n.fstat='no file channel (connect first; both sides need this version)'; return false; }
  n.txQ.push({xid:Math.random().toString(36).slice(2,10),blob,name,mime:blob.type||'application/octet-stream'});
  rtcPump(n); return true;
}
async function rtcPump(n){
  if(n.tx || !n.txQ.length || !n.fc || n.fc.readyState!=='open') return;
  const t=n.tx=n.txQ.shift(), fc=n.fc, gen=n.gen;
  try{
    fc.send(JSON.stringify({t:'file',xid:t.xid,name:t.name,mime:t.mime,size:t.blob.size}));
    for(let off=0;off<t.blob.size && !t.cancel;off+=RTC_CHUNK){
      if(n.gen!==gen || fc.readyState!=='open') throw new Error('channel closed');
      if(fc.bufferedAmount>RTC_HIGH) await new Promise(res=>{ fc.onbufferedamountlow=()=>{ fc.onbufferedamountlow=null; res(); }; });
      fc.send(await t.blob.slice(off,off+RTC_CHUNK).arrayBuffer());
      n.prog=Math.min(1,(off+RTC_CHUNK)/t.blob.size); n.fstat='sending '+t.name+' '+Math.round(n.prog*100)+'%';
    }
    if(!t.cancel){ fc.send(JSON.stringify({t:'end',xid:t.xid})); n.fstat='sent '+t.name+' ('+fmSize(t.blob.size)+')'; }
  }catch(e){ n.fstat='send failed: '+e.message; }
  n.prog=0; if(n.tx===t) n.tx=null; rtcPump(n);
}
async function rtcSendId(n,id){
  const r=await FileStore.get(id).catch(()=>null);
  if(!r || !r.blob){ n.fstat='no file with id '+id; return; }
  rtcSendFile(n,r.blob,fmFileName(r));
}
function rtcPickSend(n){
  const inp=document.createElement('input'); inp.type='file'; inp.multiple=true; inp.hidden=true;
  inp.onchange=()=>{ const fs=[...inp.files]; inp.remove(); for(const f of fs) rtcSendFile(n,f,f.name); };
  inp.oncancel=()=>inp.remove(); document.body.append(inp); inp.click();
}
async function rtcGather(n,pc){                       // без trickle: код целиком после сбора кандидатов
  if(pc.iceGatheringState!=='complete') await new Promise(res=>{
    const t=setTimeout(res,5000);
    pc.onicegatheringstatechange=()=>{ if(pc.iceGatheringState==='complete'){ clearTimeout(t); res(); } };
  });
  return rtcEnc(pc.localDescription);
}
async function rtcShow(n,kind,code){
  n.code=code; let copied=false;
  if(n.auto){ n.status=kind+' ready (signalling)'; return; }       // автоподключение: код уходит через брокер, буфер не трогаем
  try{ await navigator.clipboard.writeText(code); copied=true; }catch(e){}
  n.status=kind+' ready'+(copied ? ' — copied to the clipboard' : ' — copy it from below')+
    (kind==='offer' ? ', send it to the other side and paste its answer into «remote code»' : ', send it back');
}
async function rtcOffer(n){
  const pc=rtcMake(n); if(!pc) return;
  const gen=n.gen; n.status='creating offer…';
  try{
    rtcAttach(n,pc.createDataChannel('dsp'));
    rtcAttach(n,pc.createDataChannel('file'));
    await pc.setLocalDescription(await pc.createOffer());
    const code=await rtcGather(n,pc); if(n.gen===gen) await rtcShow(n,'offer',code);
  }catch(e){ if(n.gen===gen) n.status='error: '+e.message; }
}
async function rtcAnswer(n,code=n.p.remote){
  let d; try{ d=rtcDec(code); }catch(e){ n.status='remote code is not valid'; return; }
  if(d.type!=='offer'){ n.status='remote code is not an offer'; return; }
  const pc=rtcMake(n); if(!pc) return;
  const gen=n.gen; n.status='creating answer…';
  pc.ondatachannel=e=>rtcAttach(n,e.channel);
  try{
    await pc.setRemoteDescription(d);
    await pc.setLocalDescription(await pc.createAnswer());
    const code=await rtcGather(n,pc); if(n.gen===gen) await rtcShow(n,'answer',code);
  }catch(e){ if(n.gen===gen) n.status='error: '+e.message; }
}
async function rtcApply(n,code=n.p.remote){
  if(!n.pc){ n.status='create an offer first'; return; }
  let d; try{ d=rtcDec(code); }catch(e){ n.status='remote code is not valid'; return; }
  if(d.type!=='answer'){ n.status='remote code is not an answer'; return; }
  try{ await n.pc.setRemoteDescription(d); n.status='connecting…'; }catch(e){ n.status='error: '+e.message; }
}

/* ---- автоподключение: сигналинг через MQTT ----
   Оба узла заходят в одну комнату (параметр room) на брокере: тема — из хеша комнаты, сообщения зашифрованы AES-GCM ключом из названия
   комнаты (брокер видит только шифр, чужой без названия предложение не подсунет). Пока канала нет, узел раз в 4 с шлёт hi; тот, у
   кого id меньше, делает offer, другой отвечает answer. Оборвалась связь — те же hi, и соединение поднимается заново само. */
const rtcEnc8=new TextEncoder();
const rtcB64=u=>btoa(String.fromCharCode(...u)), rtcUnB64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const rtcKeys=new Map();
function rtcRoomKey(room){
  if(!rtcKeys.has(room)) rtcKeys.set(room,(async()=>{
    const raw=await crypto.subtle.importKey('raw',rtcEnc8.encode(room),'PBKDF2',false,['deriveBits']);
    const bits=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',salt:rtcEnc8.encode('dsp-rtc-v1'),iterations:100000,hash:'SHA-256'},raw,384));
    return {key:await crypto.subtle.importKey('raw',bits.slice(0,32),'AES-GCM',false,['encrypt','decrypt']),
            topic:'dsp/rtc/'+[...bits.slice(32)].map(b=>b.toString(16).padStart(2,'0')).join('')};
  })());
  return rtcKeys.get(room);
}
async function rtcSeal(k,obj){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},k.key,rtcEnc8.encode(JSON.stringify(obj))));
  const o=new Uint8Array(12+ct.length); o.set(iv); o.set(ct,12); return rtcB64(o);
}
async function rtcOpenMsg(k,text){
  try{ const b=rtcUnB64(text); return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:b.slice(0,12)},k.key,b.slice(12)))); }
  catch(e){ return null; }
}
async function rtcSigPub(n,obj){
  const s=n.sig; if(!s || !s.ok || !s.k) return;
  mqSend(s,mqPublish(s.k.topic,await rtcSeal(s.k,obj),{qos:0}));
}
function rtcAutoStop(n){
  if(n.hiT){ clearInterval(n.hiT); n.hiT=null; }
  if(n.sig){ mqStop(n.sig); n.sig=null; }
  n.sigOn=false; n.neg=0; n.auto=false;
}
async function rtcAutoStart(n){
  rtcAutoStop(n); n.sigOn=true;                        // сразу: process зовёт каждый блок
  const room=String(n.p.room||'').trim(), url=String(n.p.sigurl||'').trim();
  if(!room || !url){ n.status='signalling: set the broker URL and the room'; return; }
  if(!crypto?.subtle){ n.status='signalling needs a secure page (https)'; return; }
  n.auto=true; n.myId=Math.random().toString(36).slice(2,10); n.peerId=null; n.neg=0;
  const k=await rtcRoomKey(room); if(!n.sigOn || n.sig) return;
  const s=n.sig={ws:null,want:false,ok:false,timer:null,pingT:null,pid:0,cid:'',status:'',warn:'',k,
    p:{url,user:n.p.sigUser,pass:n.p.sigPass,client:'',reconnect:true}};
  s.onConnect=()=>{ mqSend(s,mqSubscribe(mqNextId(s),[k.topic],0)); rtcHi(n); };
  s.onMessage=(_,p)=>{ rtcOpenMsg(k,mqDec.decode(p.payload)).then(m=>{ if(m && n.sig===s) rtcSigIn(n,m); }); };
  mqStart(s);
  n.hiT=setInterval(()=>rtcHi(n),4000);
}
function rtcHi(n){ if(n.sig?.ok && !n.open) rtcSigPub(n,{t:'hi',from:n.myId}); }
async function rtcSigIn(n,m){
  if(!m || m.from===n.myId || typeof m.from!=='string') return;
  const stale=n.neg && Date.now()-n.neg>25000;
  if(m.t==='hi'){
    if(n.open && m.from===n.peerId) return;
    if(n.open && m.from!==n.peerId){ /* партнёр перезапустился — старый канал мёртв на той стороне */ }
    else if(n.neg && !stale) return;
    if(n.myId<m.from){                                  // мой offer
      n.neg=Date.now(); n.peerId=m.from; n.auto=true;
      await rtcOffer(n);
      if(n.code && n.neg) rtcSigPub(n,{t:'offer',from:n.myId,to:m.from,code:n.code});
    }
  } else if(m.t==='offer' && m.to===n.myId){
    if(n.open && m.from===n.peerId) return;
    n.neg=Date.now(); n.peerId=m.from; n.auto=true;
    await rtcAnswer(n,m.code);
    if(n.code) rtcSigPub(n,{t:'answer',from:n.myId,to:m.from,code:n.code});
  } else if(m.t==='answer' && m.to===n.myId && m.from===n.peerId && n.pc && !n.open){
    await rtcApply(n,m.code);
  }
}

def({ id:'rtcdata', title:'WebRTC Data', cat:'Sources', kw:'webrtc peer data channel p2p datachannel browser direct',
  ins:[{n:'send',t:'txt'},{n:'sendFile',t:'num'}],
  outs:[{n:'line',t:'txt'},{n:'go',t:'num'},{n:'rec',t:'rec'},{n:'count',t:'num'},{n:'file',t:'num'},{n:'got',t:'num'},{n:'progress',t:'num'},{n:'open',t:'num'}],
  readout:true, tall:true,
  params:[
    {n:'ice',t:'text',d:'',label:'STUN (stun:stun.l.google.com:19302), empty — same network only'},
    {n:'offer',t:'button',label:'1. Create offer',fn:n=>{ n.auto=false; rtcOffer(n); }},
    {n:'remote',t:'text',d:'',label:'remote code (paste the other side\'s offer / answer)'},
    {n:'accept',t:'button',label:'2. Accept offer → answer',fn:n=>{ n.auto=false; rtcAnswer(n); }},
    {n:'apply',t:'button',label:'3. Apply answer',fn:n=>rtcApply(n)},
    {n:'close',t:'button',label:'Close',fn:n=>rtcClose(n)},
    {n:'sigurl',t:'text',d:'',fn:n=>rtcAutoStop(n),label:'auto-connect: MQTT broker WebSocket (wss://…) — exchanges the codes for you'},
    {n:'room',t:'text',d:'',fn:n=>rtcAutoStop(n),label:'auto-connect: room (a long secret name, the same on both sides; it encrypts the signalling)'},
    {n:'sigUser',t:'text',d:'',fn:n=>rtcAutoStop(n),label:'broker user (optional)'},
    {n:'sigPass',t:'text',d:'',fn:n=>rtcAutoStop(n),label:'broker password (saved with the patch!)'},
    {n:'auto',t:'check',d:false,label:'auto-connect and reconnect'},
    {n:'sendpick',t:'button',label:'Send file…',fn:n=>rtcPickSend(n)},
    {n:'maxMB',t:'num',d:200,label:'refuse incoming files over, MB'},
  ],
  init:n=>{ n.pc=n.dc=null; n.open=false; n.gen=0; n.code=''; n.lineQ=[]; n.recQ=[]; n.lastLine=''; n.fc=null; n.fopen=false; n.rx=null; n.tx=null; n.txQ=[]; n.recvQ=[]; n.lastFile=-1; n.prog=0; n.fstat=''; n.lastSendId=undefined; n.sig=null; n.sigOn=false; n.hiT=null; n.neg=0; n.myId=''; n.peerId=null; n.auto=false; n.msgs=0; n.count=0;
            n.lastSend=undefined; n.status=typeof RTCPeerConnection==='undefined' ? 'WebRTC is not supported by this browser' : 'not connected'; },
  dispose:n=>{ rtcAutoStop(n); rtcClose(n); },
  process(n,I){
    if(n.p.auto && !n.sigOn) rtcAutoStart(n); else if(!n.p.auto && n.sigOn) rtcAutoStop(n);
    if(typeof I.send==='string' && I.send!==n.lastSend){
      n.lastSend=I.send;
      if(n.dc && n.dc.readyState==='open') n.dc.send(I.send);
    }
    if(typeof I.sendFile==='number' && I.sendFile!==n.lastSendId){ n.lastSendId=I.sendFile; if(I.sendFile>=0) rtcSendId(n,I.sendFile); }
    let got=0;
    if(n.recvQ.length){ n.lastFile=n.recvQ.shift().id; got=1; }
    let go=0;
    if(n.lineQ.length){ n.lastLine=n.lineQ.shift(); go=1; n.count++; }
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    return {line:n.lastLine, go, rec, count:n.count, file:typeof n.lastFile==='number' ? n.lastFile : -1, got, progress:n.prog, open:n.open ? 1 : 0}; },
  drawKey:n=>n.status+'|'+n.msgs+'|'+n.lineQ.length+'|'+n.fstat,
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    r.textContent=n.status+(n.msgs ? ' · messages '+n.msgs : '')+(n.fstat ? '\nfile: '+n.fstat : '')+(n.code ? '\n'+n.code : '')+(n.lastLine ? '\n'+n.lastLine.slice(0,400) : ''); }
});
