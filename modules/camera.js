"use strict";
/* ============================ IP Camera (HTTP) и Camera Archive ============================
   IP Camera: адрес из Table (url / rows + номер камеры) → MJPEG-поток или JPEG, который опрашивается раз в N секунд → img для Frame и др.
   HLS уходит на url (→ IPTV), RTSP в браузере невозможен. Нужен CORS на камере или прокси из настроек.
   Camera Archive: кадры img пишутся в хранилище (images / Cameras / <камера>) по времени или по движению; просмотр по шкале времени. */

const camFs=n=>document.fullscreenElement===n.cv || !!n.cv?.classList.contains('fs-fb');
const camSleep=(n,ms)=>new Promise(r=>{ n.timer=setTimeout(r,ms); });
function camPaintTo(cx,src,w,h,W,H,msg){
  if(src){ const k=Math.min(W/w,H/h), dw=w*k, dh=h*k; cx.imageSmoothingEnabled=true; cx.drawImage(src,(W-dw)/2,(H-dh)/2,dw,dh); }
  if(msg){ cx.fillStyle='#fff9'; cx.font=Math.max(11,Math.round(H/22))+'px sans-serif'; cx.textAlign='center'; cx.fillText(msg,W/2,H/2); cx.textAlign='left'; }
}
const camFsKey=n=>n.cv && camFs(n) ? 'fs'+n.cv.width+'x'+n.cv.height : '';
// байты или Blob картинки → ImageData не шире maxw (через общий холст узла)
async function camDecode(n,data,maxw){
  const bm=await createImageBitmap(data instanceof Blob ? data : new Blob([data],{type:'image/jpeg'}));
  const k=maxw>0 && bm.width>maxw ? maxw/bm.width : 1;
  const W=Math.max(1,Math.round(bm.width*k)), H=Math.max(1,Math.round(bm.height*k));
  if(n.capCv.width!==W || n.capCv.height!==H){ n.capCv.width=W; n.capCv.height=H; }
  n.capCx.drawImage(bm,0,0,W,H); bm.close?.();
  return n.capCx.getImageData(0,0,W,H);
}

/* ---------------------------------- IP Camera ---------------------------------- */
function icLog(n,s){ n.status=s; n.dirty=true; }
function icStop(n){
  n.want=false; n.gen=(n.gen|0)+1;
  try{ n.abort?.abort(); }catch(e){}
  n.abort=null; clearTimeout(n.timer);
}
function icShow(n,data,gen){
  if(gen!==n.gen) return;
  if(n.busy){ if(n.pending) n.drop++; n.pending=data; return; }
  n.busy=true;
  camDecode(n,data,+n.p.maxw).then(id=>{
    if(gen!==n.gen) return;
    n.img={data:id,w:id.width,h:id.height,gray:false,rev:(n.img?.rev|0)+1};
    n.frames++; n.ts.push(performance.now()); n.lastAt=performance.now(); n.pulse=2; n.err='';
  }).catch(()=>{ if(gen===n.gen) n.err='could not decode the picture'; })
    .finally(()=>{ n.busy=false; const p=n.pending; n.pending=null; if(p && gen===n.gen) icShow(n,p,gen); });
}
async function icOpen(n,raw,name){
  icStop(n);
  const a=camSplitAuth(raw), url=a.url;
  n.want=true; n.url=raw; n.camName=name||n.camName||'';
  n.img=null; n.frames=0; n.drop=0; n.err=''; n.ts=[]; n.pending=null; n.busy=false; n.hlsUrl=null; n.live=false;
  n.spl=new BinJpegSplitter(); n.lastAt=0;
  const g=n.gen, ac=n.abort=new AbortController();
  let kind=n.p.mode==='auto' ? camKind(url) : n.p.mode;
  if(!/^https?:\/\//i.test(url)){
    icLog(n,kind==='rtsp' || /^(rtsp|rtmp|udp|rtp)/i.test(url) ? 'RTSP / RTMP / UDP cannot be opened in a browser — use the camera\'s HTTP (MJPEG / snapshot / HLS) address, or a gateway such as go2rtc' : 'URL must start with http:// or https://');
    n.want=false; return;
  }
  if(kind==='hls'){ n.hlsUrl=n.p.proxy ? Net.url(url) : url; icLog(n,'HLS — wire «url» to IPTV'); return; }
  if(kind==='page'){ icLog(n,'this is a web page, not a picture — open it in a tab'); n.want=false; return; }
  n.warn= typeof netInsecure==='function' && netInsecure(url) && !n.p.proxy ? NET_INSECURE_MSG : '';
  const fetchIt=async()=>{
    const r=await fetch(n.p.proxy ? Net.url(url) : url,{cache:'no-store',signal:ac.signal,headers:a.auth ? {Authorization:a.auth} : undefined});
    if(!r.ok) throw new Error(r.status===401 ? 'HTTP 401 (user:password@ in the address)' : 'HTTP '+r.status);
    return r;
  };
  try{
    icLog(n,'connecting…');
    let r=await fetchIt();
    if(kind==='auto'){
      kind=camKindByType(r.headers.get('content-type')) || 'snapshot';
      if(kind==='hls'){ ac.abort(); n.hlsUrl=n.p.proxy ? Net.url(url) : url; icLog(n,'HLS — wire «url» to IPTV'); return; }
      if(kind==='page'){ ac.abort(); icLog(n,'this is a web page, not a picture'); n.want=false; return; }
    }
    n.kind=kind;
    if(kind==='mjpeg'){
      icLog(n,'MJPEG stream'); n.live=true;
      const rd=r.body.getReader();
      for(;;){
        if(g!==n.gen) return;
        const wd=setTimeout(()=>ac.abort(),15000);                 // поток замолчал — переоткрыть
        const x=await rd.read(); clearTimeout(wd);
        if(x.done) break;
        const fr=n.spl.push(x.value);
        if(fr.length) icShow(n,fr[fr.length-1],g);                // из пачки — только свежий кадр
      }
      icLog(n,'stream ended');
    }else{
      n.live=true;
      for(;;){
        icLog(n,'snapshot every '+n.p.refresh+' s');
        icShow(n,await r.blob(),g);
        const wait=Math.max(.2,+n.p.refresh)*1000;
        await camSleep(n,wait);
        if(g!==n.gen) return;
        r=await fetchIt();
      }
    }
  }catch(e){
    if(g!==n.gen) return;
    n.live=false;
    icLog(n,'error: '+e.message+(e instanceof TypeError ? ' (no CORS headers on the camera, or blocked — try «through the CORS proxy»)' : ''));
  }
  if(g===n.gen && n.want && n.p.reconnect){ n.live=false; n.timer=setTimeout(()=>{ if(g===n.gen) icOpen(n,raw,n.camName); },3000); }
}

def({ id:'ipcam', lazy:true, title:'IP Camera', cat:'Sources', fs:true, readout:true, resize:true, view:{h:150}, w:340,
  kw:'ip camera cctv webcam mjpeg jpeg snapshot stream http surveillance video url table nvr',
  // url — адрес (из Table); rows + cam — список камер и номер / имя; rec — строка Table. img → Frame, Camera Archive; url (HLS) → IPTV
  ins:[{n:'url',t:'txt'},{n:'rec',t:'rec'},{n:'rows',t:'bands'},{n:'cam',t:'val'},{n:'next',t:'num'}],
  outs:[{n:'img',t:'img'},{n:'url',t:'txt'},{n:'name',t:'txt'},{n:'new',t:'num'},{n:'fps',t:'num'},{n:'live',t:'num'}],
  params:[{n:'url',t:'text',d:'',label:'URL: MJPEG stream, JPEG snapshot or HLS (user:password@host works)'},
          {n:'cam',t:'text',d:'',label:'camera in the list on «rows»: number, name or id'},
          {n:'play',t:'button',label:'Play',fn:n=>icOpen(n,n.p.url,n.camName)},
          {n:'stop',t:'button',label:'Stop',fn:n=>{ icStop(n); n.live=false; icLog(n,'stopped'); }},
          {n:'mode',t:'select',opts:['auto','mjpeg','snapshot'],d:'auto',label:'kind (auto: by the address and the server\'s answer)'},
          {n:'refresh',t:'range',min:.2,max:300,step:.1,d:2,label:'snapshot: refresh every, s'},
          {n:'maxw',t:'select',opts:['0','320','640','960','1280','1920'],d:'960',label:'max width, px (0 — as the camera)'},
          {n:'reconnect',t:'check',d:true,label:'reconnect a dropped stream'},
          {n:'proxy',t:'check',d:false,label:'through the CORS proxy from Settings'}],
  init(n){
    n.capCv=document.createElement('canvas'); n.capCx=n.capCv.getContext('2d',{willReadFrequently:true});
    n.status='enter a URL (or a Table row) and press Play'; n.warn=''; n.img=null; n.camName=''; n.live=false; n.hlsUrl=null;
    n.frames=0; n.drop=0; n.err=''; n.ts=[]; n.fps=0; n.pulse=0; n.gen=0; n.want=false; n.kind=''; n.key=''; n.nxPrev=false; n.lastAt=0; n.rows=null;
  },
  dispose:n=>{ icStop(n); },
  process(n,I){
    const open=(u,nm,key)=>{ if(key===n.key) return; n.key=key; setMod(n,'url',u); icOpen(n,u,nm); };
    if(Array.isArray(I.rows)) n.rows=I.rows;
    const rec=recList(I.rec).find(r=>r?.url);
    const v= I.cam!=null && I.cam!=='' ? I.cam : n.p.cam;
    if(typeof I.url==='string' && /^https?:\/\//i.test(I.url)) open(I.url,n.camName,'u:'+I.url);
    else if(rec) open(rec.url,rec.name||rec.label||'','r:'+rec.url);
    else if(n.rows){
      const c=camPick(n.rows,v);
      if(c) open(c.url,c.name||c.label||c.id||'','c:'+c.url);
    }
    const nx=(I.next||0)>.5;
    if(nx && !n.nxPrev && n.rows?.length){
      const L=n.rows.filter(r=>r?.url), i=Math.max(0,L.findIndex(r=>r.url===n.key.slice(2)));
      const c=L[(i+1)%L.length]; if(c){ setMod(n,'cam',String(L.indexOf(c)+1)); open(c.url,c.name||c.label||'','c:'+c.url); }
    }
    n.nxPrev=nx;
    const now=performance.now();
    while(n.ts.length && now-n.ts[0]>1000) n.ts.shift();
    n.fps=n.ts.length;
    if(n.pulse>0) n.pulse--;
    return {img:n.img, url:n.hlsUrl, name:n.camName, new:n.pulse>0 ? 1 : 0, fps:n.fps, live:n.live && n.img && now-n.lastAt<(n.kind==='snapshot' ? Math.max(5000,n.p.refresh*3000) : 8000) ? 1 : 0}; },
  drawKey:n=>n.status+'|'+n.err+'|'+n.img?.rev+'|'+n.fps+'|'+camFsKey(n),
  draw(n,cv,cx){
    const r=n.el.querySelector('.readout');
    if(r){
      const t=(n.camName ? n.camName+'\n' : '')+n.status+(n.img ? ' · '+n.img.w+'×'+n.img.h+(n.kind==='mjpeg' ? ' · '+n.fps+' fps' : '') : '')+
        (n.drop ? ' · '+n.drop+' skipped' : '')+(n.err ? '\n'+n.err : '')+(n.warn ? '\n'+n.warn : '');
      if(r.textContent!==t) r.textContent=t;
    }
    cx.fillStyle='#000'; cx.fillRect(0,0,cv.width,cv.height);
    camPaintTo(cx,n.img ? n.capCv : null,n.img?.w,n.img?.h,cv.width,cv.height,n.img ? '' : n.want ? 'no picture yet' : ''); }
});

/* ---------------------------------- Camera Archive ---------------------------------- */
const CA_ROOT='Cameras';
async function caFolder(n){
  const cam=camFolder(n.p.cam.trim() || n.nameIn || 'camera');
  if(n.folderCam===cam && n.folderId!=null) return n.folderId;
  const d=await fsDest(n,CA_ROOT+'/'+cam,'images',true);
  n.folderCam=cam; n.folderId=d.folderId; n.idx=null; n.idxAt=0;
  return n.folderId;
}
async function caIndex(n,force){
  if(n.idxBusy || (!force && n.idx && performance.now()-n.idxAt<5000)) return;
  n.idxBusy=true;
  try{
    const fid=await caFolder(n), L=await FileStore.list('images',fid);
    n.idx=L.map(f=>({id:f.id,t:f.meta?.t||f.created,size:f.size})).sort((a,b)=>a.t-b.t);
    n.idxAt=performance.now(); n.dens=null;
    n.bytes=n.idx.reduce((s,f)=>s+(f.size||0),0);
  }catch(e){ n.err='archive: '+e.message; }
  n.idxBusy=false;
}
async function caSave(n){
  const id=n.cur, now=Date.now();
  n.saving=true;
  try{
    if(n.cap.width!==id.width || n.cap.height!==id.height){ n.cap.width=id.width; n.cap.height=id.height; }
    n.capX.putImageData(id,0,0);
    const blob=await new Promise(r=>n.cap.toBlob(r,'image/jpeg',+n.p.quality));
    if(!blob) throw new Error('could not encode');
    const fid=await caFolder(n);
    const fid2=await FileStore.put({space:'images',folderId:fid,name:camStamp(now)+'.jpg',mime:'image/jpeg',blob,meta:{w:id.width,h:id.height,t:now,cam:n.folderCam}});
    (n.idx ||= []).push({id:fid2,t:now,size:blob.size}); n.bytes=(n.bytes||0)+blob.size; n.dens=null;
    n.saved=(n.saved|0)+1; n.savePulse=2; n.err='';
    if(n.saved%20===1) caPrune(n);
  }catch(e){ n.err='save failed: '+e.message; }
  n.saving=false;
}
async function caPrune(n){
  if(!n.idx) return;
  const del=camPrune(n.idx,Date.now(),+n.p.days,+n.p.max);
  if(!del.length) return;
  const gone=new Set(del.map(f=>f.id));
  for(const f of del) await FileStore.remove(f.id).catch(()=>{});
  n.idx=n.idx.filter(f=>!gone.has(f.id)); n.dens=null;
}
async function caLoad(n,i){
  const f=n.idx?.[i]; if(!f) return;
  n.want=i; if(n.loading) return;
  n.loading=true;
  try{
    for(;;){
      const k=n.want, g=n.idx?.[k]; if(!g) break;
      const rec=await FileStore.get(g.id);
      if(rec?.blob){ const id=await camDecode(n,rec.blob,+n.p.maxw); n.shown={data:id,w:id.width,h:id.height,gray:false,rev:(n.shown?.rev|0)+1}; n.shownAt=k; n.shownT=g.t; }
      if(n.want===k) break;
    }
  }catch(e){ n.err='open: '+e.message; }
  n.loading=false;
}
function caSeek(n,i){
  if(!n.idx?.length) return;
  n.pos=Math.max(0,Math.min(n.idx.length-1,Math.round(i)));
  n.fracSet=n.pos/Math.max(1,n.idx.length-1);
}
const caFmt=t=>t ? new Date(t).toLocaleString() : '—';

def({ id:'camarch', lazy:true, title:'Camera Archive', cat:'Video', fs:true, readout:true, resize:true, view:{h:170}, w:360,
  kw:'camera archive nvr record recording cctv timeline playback surveillance motion frames history',
  // record: img → хранилище (images / Cameras / камера); play: просмотр по шкале времени, img — показанный кадр
  ins:[{n:'img',t:'img'},{n:'name',t:'txt'},{n:'rec',t:'num'},{n:'seek',t:'num'},{n:'play',t:'num'},{n:'step',t:'num'}],
  outs:[{n:'img',t:'img'},{n:'t',t:'num'},{n:'time',t:'txt'},{n:'count',t:'num'},{n:'saved',t:'num'},{n:'on',t:'num'}],
  params:[{n:'mode',t:'select',opts:['record','playback'],d:'record',label:'record frames from img / view the archive'},
          {n:'cam',t:'text',d:'',label:'camera name = folder in Files (empty — name input)'},
          {n:'interval',t:'range',min:1,max:3600,step:1,d:10,label:'record: a frame every, s'},
          {n:'motion',t:'range',min:0,max:.2,step:.005,d:0,label:'record: also on motion above (0 — off)'},
          {n:'quality',t:'range',min:.3,max:1,step:.05,d:.8,label:'JPEG quality'},
          {n:'days',t:'range',min:0,max:365,step:1,d:7,label:'keep days (0 — no limit)'},
          {n:'max',t:'range',min:0,max:100000,step:100,d:5000,label:'keep at most frames (0 — no limit)'},
          {n:'maxw',t:'select',opts:['0','640','960','1280','1920'],d:'1280',label:'max width, px (0 — as is)'},
          {n:'go',t:'button',label:'Play / pause',fn:n=>{ n.playing=!n.playing; if(n.playing && n.pos>=(n.idx?.length||1)-1) n.pos=0; }},
          {n:'prev',t:'button',label:'◀ Frame',fn:n=>caSeek(n,n.pos-1)},
          {n:'nextb',t:'button',label:'Frame ▶',fn:n=>caSeek(n,n.pos+1)},
          {n:'pos',t:'range',min:0,max:1,step:.001,d:1,label:'position in the archive'},
          {n:'speed',t:'range',min:.5,max:60,step:.5,d:5,label:'playback: frames per second'},
          {n:'loop',t:'check',d:false,label:'loop'},
          {n:'refresh',t:'button',label:'Reload index',fn:n=>caIndex(n,true)},
          {n:'save',t:'button',label:'Download this frame',fn:async n=>{
            const f=n.idx?.[n.shownAt]; if(!f) return; const r=await FileStore.get(f.id); if(r) fmDownload(r); }},
          {n:'clear',t:'button',label:'Delete this camera\'s archive',fn:async n=>{
            if(!n.idx?.length || !confirm('Delete '+n.idx.length+' frames of «'+n.folderCam+'»?')) return;
            for(const f of n.idx) await FileStore.remove(f.id).catch(()=>{}); n.idx=[]; n.shown=null; n.dens=null; n.bytes=0; }}],
  init(n){
    n.capCv=document.createElement('canvas'); n.capCx=n.capCv.getContext('2d',{willReadFrequently:true});
    n.cap=document.createElement('canvas'); n.capX=n.cap.getContext('2d');
    n.cur=null; n.curRev=-1; n.lastSave=null; n.prevThumb=null; n.saved=0; n.savePulse=0; n.err=''; n.idx=null; n.idxAt=0; n.bytes=0;
    n.shown=null; n.shownAt=-1; n.shownT=0; n.pos=0; n.playing=false; n.playT=0; n.want=-1; n.nameIn=''; n.fracSet=null;
    n.stepPrev=false; n.hooked=false; n.dens=null;
  },
  process(n,I){
    if(typeof I.name==='string' && I.name && I.name!==n.nameIn){ n.nameIn=I.name; n.folderCam=''; n.folderId=null; n.idx=null; }
    const play=n.p.mode==='playback';
    if(!play){
      if(I.img && I.img.rev!==n.curRev){
        n.curRev=I.img.rev; n.cur=I.img.data;
      }
      const on= typeof I.rec==='number' ? I.rec>.5 : true;
      const now=Date.now();
      if(on && n.cur && !n.saving && n.curRev!==n.savedRev){
        let diff=0;
        if(+n.p.motion>0){ const th=camThumb(n.cur); diff=camDiff(n.prevThumb,th); n.prevThumb=th; }
        if(camShouldSave({now:now/1000,last:n.lastSave==null ? null : n.lastSave/1000,interval:+n.p.interval,motion:+n.p.motion,diff})){
          n.lastSave=now; n.savedRev=n.curRev; caSave(n);
        }
      }
      if(!n.idx) caIndex(n);
      if(n.savePulse>0) n.savePulse--;
      return {img:I.img||null, t:n.lastSave||0, time:caFmt(n.lastSave), count:n.idx?.length||0, saved:n.savePulse>0 ? 1 : 0, on:on && n.cur ? 1 : 0};
    }
    caIndex(n);
    const N=n.idx?.length||0;
    if(typeof I.seek==='number' && I.seek!==n.seekIn && N){ n.seekIn=I.seek; caSeek(n,Math.max(0,Math.min(1,I.seek))*(N-1)); }
    const st=(I.step||0)>.5; if(st && !n.stepPrev) caSeek(n,n.pos+1); n.stepPrev=st;
    if(typeof I.play==='number') n.playing=I.play>.5;
    const now=performance.now();
    if(n.fracSet!=null){ setMod(n,'pos',n.fracSet); n.fracSet=null; n.lastPos=n.p.pos; }
    else if(N && n.p.pos!==n.lastPos){ n.lastPos=n.p.pos; n.pos=Math.round(n.p.pos*(N-1)); }   // ползунок
    if(n.playing && N && now-n.playT>=1000/Math.max(.5,+n.p.speed)){
      n.playT=now;
      if(n.pos>=N-1){ if(n.p.loop) n.pos=0; else n.playing=false; }
      else n.pos++;
      n.fracSet=n.pos/Math.max(1,N-1);
    }
    if(N && n.pos>=N) n.pos=N-1;
    if(N && n.pos!==n.shownAt && n.want!==n.pos) caLoad(n,n.pos);
    return {img:n.shown, t:n.shownT||0, time:caFmt(n.shownT), count:N, saved:0, on:n.playing ? 1 : 0}; },
  drawKey:n=>n.p.mode+'|'+n.err+'|'+n.shown?.rev+'|'+n.pos+'|'+n.idx?.length+'|'+n.saved+'|'+n.playing+'|'+Math.floor(Date.now()/1000)+'|'+camFsKey(n),
  draw(n,cv,cx){
    const play=n.p.mode==='playback', N=n.idx?.length||0;
    const r=n.el.querySelector('.readout');
    if(r){
      const sz=n.bytes>1048576 ? (n.bytes/1048576).toFixed(1)+' MB' : Math.round((n.bytes||0)/1024)+' kB';
      const t=(n.folderCam || 'no camera name')+' · '+N+' frames · '+sz+
        (play ? (N ? '\n'+caFmt(n.shownT)+' · '+(n.pos+1)+'/'+N+(n.playing ? ' ▶' : '') : '\narchive is empty')
              : '\n'+(n.cur ? (n.saving ? 'saving…' : 'recording every '+n.p.interval+' s'+(+n.p.motion>0 ? ' + motion' : '')+' · saved '+n.saved) : 'wire img from IP Camera'))+
        (n.err ? '\n'+n.err : '');
      if(r.textContent!==t) r.textContent=t;
    }
    const strip=play && N>1 ? Math.max(14,Math.round(cv.height*.09)) : 0, H=cv.height-strip;
    cx.fillStyle='#000'; cx.fillRect(0,0,cv.width,cv.height);
    const src= play ? n.shown : n.cur ? {data:n.cur,w:n.cur.width,h:n.cur.height} : null;
    if(src){
      if(play){ camPaintTo(cx,n.capCv,src.w,src.h,cv.width,H); }
      else{ if(n.cap.width!==src.w || n.cap.height!==src.h){ n.cap.width=src.w; n.cap.height=src.h; } n.capX.putImageData(src.data,0,0); camPaintTo(cx,n.cap,src.w,src.h,cv.width,H); }
    }
    if(strip){                                                // шкала времени: плотность кадров и положение
      const t0=n.idx[0].t, t1=n.idx[N-1].t, W=cv.width, y=H;
      n.dens ||= camDensity(n.idx,t0,t1,Math.min(W,240));
      const D=n.dens, mx=Math.max(1,...D);
      cx.fillStyle='#223'; cx.fillRect(0,y,W,strip);
      cx.fillStyle='#4aa8ff';
      for(let k=0;k<D.length;k++) if(D[k]){ const h=Math.max(2,strip*.85*D[k]/mx); cx.fillRect(k*W/D.length,y+strip-h,Math.max(1,W/D.length-.5),h); }
      const cxp=N>1 ? n.pos/(N-1)*W : 0; cx.fillStyle='#ffd84a'; cx.fillRect(Math.round(cxp)-1,y,2,strip);
      cx.fillStyle='#fffc'; cx.font=Math.max(9,strip*.6)+'px sans-serif';
      cx.textAlign='left'; cx.fillText(new Date(t0).toLocaleDateString(),3,y+strip*.75);
      cx.textAlign='right'; cx.fillText(new Date(t1).toLocaleDateString(),W-3,y+strip*.75); cx.textAlign='left';
      if(!n.hooked && n.cv){                                  // щелчок по шкале — перемотка, ←/→ — кадр (в том числе во весь экран)
        n.hooked=true;
        n.cv.addEventListener('pointerup',ev=>{
          if(n.p.mode!=='playback' || !n.idx?.length) return;
          const b=n.cv.getBoundingClientRect(), s=Math.max(14,Math.round(b.height*.09));
          if(ev.clientY<b.bottom-s) return;
          caSeek(n,(ev.clientX-b.left)/b.width*(n.idx.length-1)); n._dirty=true; });
        document.addEventListener('keydown',ev=>{
          if(!camFs(n) || n.p.mode!=='playback') return;
          if(ev.key==='ArrowRight') caSeek(n,n.pos+1); else if(ev.key==='ArrowLeft') caSeek(n,n.pos-1);
          else if(ev.key===' '){ n.playing=!n.playing; ev.preventDefault(); } });
      }
    }
    if(play && !N) camPaintTo(cx,null,0,0,cv.width,cv.height,'archive is empty');
    else if(!play && !n.cur) camPaintTo(cx,null,0,0,cv.width,cv.height,'no picture');
  }
});
