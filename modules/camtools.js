"use strict";
/* ============================ Камера: Motion Detect, Pulse, Timelapse, Color / Spectrometer ============================
   Логика — в camtools-kernels.js (tools/test-camtools.mjs). Здесь узлы холста: кадры приходят на вход img (Camera, IP Camera, Video…),
   у Timelapse ещё и vid — полное разрешение живого видео. Браузерная часть проверена на искусственной картинке, не на настоящих камерах. */

// кадр img → ImageData-подобный объект (серый кадр gray:true хранит buf 0…1)
function ctData(im,n){
  if(!im) return null;
  if(!im.gray) return im.data;
  const w=im.w, h=im.h, c=n._gc;
  const o=c&&c.width===w&&c.height===h ? c : (n._gc={width:w,height:h,data:new Uint8ClampedArray(w*h*4)});
  for(let i=0,b=im.buf;i<b.length;i++){ const v=b[i]*255, j=i*4; o.data[j]=o.data[j+1]=o.data[j+2]=v; o.data[j+3]=255; }
  return o;
}
const ctNow=()=>performance.now()/1000;
const ctFmtT=s=>{ s=Math.max(0,Math.round(s)); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); };

/* ---------------------------------- Motion Detect ---------------------------------- */
const MV_SIZES={'32x24':[32,24],'64x48':[64,48],'128x96':[128,96]};
def({ id:'motion', lazy:'proc', title:'Motion Detect', cat:'Video', resize:true, readout:true, view:{h:110}, w:320,
  kw:'motion detector movement camera surveillance cctv alarm trigger security pir presence activity frame difference',
  // img → доля изменившихся пикселей; go — импульс в начале движения, on — уровень (с удержанием); img — карта изменений
  ins:[{n:'img',t:'img'},{n:'thr',t:'num'},{n:'reset',t:'num'}],
  outs:[{n:'motion',t:'num'},{n:'go',t:'num'},{n:'on',t:'num'},{n:'level',t:'num'},{n:'cx',t:'num'},{n:'cy',t:'num'},{n:'img',t:'img'},{n:'count',t:'num'}],
  params:[{n:'pix',t:'range',min:4,max:120,step:1,d:25,label:'pixel change that counts (0…255; lower — more sensitive)'},
          {n:'thr',t:'range',min:.1,max:50,step:.1,d:2,label:'alarm: % of the zone changed'},
          {n:'hold',t:'range',min:0,max:60,step:.5,d:2,label:'keep `on` after the motion stops, s'},
          {n:'mode',t:'select',opts:['previous frame','background'],d:'previous frame',label:'compare with (background: slow motion and left objects count too)'},
          {n:'rate',t:'range',min:.005,max:.5,step:.005,d:.05,label:'background: update speed'},
          {n:'size',t:'select',opts:Object.keys(MV_SIZES),d:'64x48',label:'analysis size (smaller — fewer false alarms from noise)'},
          {n:'zone',t:'check',d:false,label:'only a zone of the frame'},
          {n:'zx',t:'range',min:0,max:1,step:.01,d:.25,label:'zone: x'},{n:'zy',t:'range',min:0,max:1,step:.01,d:.25,label:'zone: y'},
          {n:'zw',t:'range',min:.05,max:1,step:.01,d:.5,label:'zone: width'},{n:'zh',t:'range',min:.05,max:1,step:.01,d:.5,label:'zone: height'},
          {n:'rst',t:'button',label:'Reset background and counter',fn:n=>{ n.mv={}; n.gate={}; n.count=0; n.hist=[]; }}],
  init(n){ n.mv={}; n.gate={}; n.count=0; n.hist=[]; n.rev=-1; n.res=null; n.pend=false; n.oimg=null; n.lastT=0; n.fps=0; n.prevFrame=null; },
  process(n,I){
    if(typeof I.thr==='number') setMod(n,'thr',I.thr);
    if(typeof I.reset==='number'){ const g=I.reset>=.5; if(g && !n.rg){ n.mv={}; n.gate={}; n.count=0; } n.rg=g; }
    const im=I.img;
    if(im && im.rev!==n.rev){
      n.rev=im.rev;
      const t=ctNow(), [w,h]=MV_SIZES[n.p.size]||[64,48];
      if(n.lastT){ const f=1/Math.max(1e-3,t-n.lastT); n.fps=n.fps?n.fps*.9+f*.1:f; }
      n.lastT=t;
      const z=n.p.zone ? [n.p.zx,n.p.zy,Math.min(n.p.zw,1-n.p.zx),Math.min(n.p.zh,1-n.p.zy)] : null;
      const g=mvGray(ctData(im,n),w,h,z);
      const r=mvStep(n.mv,g,{w,h,pix:n.p.pix,mode:n.p.mode==='background'?'avg':'prev',rate:n.p.rate});
      const q=mvGate(n.gate,r.motion*100,t,n.p.thr,n.p.hold);
      if(q.rise){ n.count++; n.pend=true; }
      n.res={...r,on:q.on,w,h,z,g};
      n.hist.push(r.motion*100); if(n.hist.length>160) n.hist.shift();
      // карта изменений: серый кадр, изменившиеся пиксели красные
      const id=new ImageData(w,h), d=id.data;
      for(let i=0;i<w*h;i++){ const j=i*4, v=r.mask[i]?255:g[i]*.45; d[j]=v; d[j+1]=r.mask[i]?40:v; d[j+2]=r.mask[i]?40:v; d[j+3]=255; }
      n.oimg={data:id,w,h,gray:false,rev:(n.oimg?.rev|0)+1};
    }
    const r=n.res, go=n.pend?1:0; n.pend=false;
    if(!r) return {motion:0,go:0,on:0,level:0,cx:.5,cy:.5,img:null,count:n.count};
    const zx=r.z?r.z[0]:0, zy=r.z?r.z[1]:0, zw=r.z?r.z[2]:1, zh=r.z?r.z[3]:1;
    return {motion:r.motion,go,on:r.on,level:r.level,cx:zx+r.cx*zw,cy:zy+r.cy*zh,img:n.oimg,count:n.count}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, r=n.res; cx.clearRect(0,0,W,H);
    const ro=n.el.querySelector('.readout');
    if(!r){ if(ro) ro.textContent='waiting for a picture on img'; return; }
    const ph=Math.round(H*.62), k=Math.min(W/r.w,ph/r.h), dw=r.w*k, dh=r.h*k, ox=(W-dw)/2;
    const c=n.pc||(n.pc=document.createElement('canvas'));
    if(c.width!==r.w||c.height!==r.h){ c.width=r.w; c.height=r.h; n.px=c.getContext('2d'); }
    n.px.putImageData(n.oimg.data,0,0);
    cx.imageSmoothingEnabled=false; cx.drawImage(c,ox,0,dw,dh);
    if(r.on){ cx.strokeStyle='#e44'; cx.lineWidth=3; cx.strokeRect(ox+1,1,dw-2,dh-2); }
    if(r.area){ cx.strokeStyle='#ff0'; cx.lineWidth=1; const mx=ox+r.cx*dw, my=r.cy*dh;
      cx.beginPath(); cx.moveTo(mx-6,my); cx.lineTo(mx+6,my); cx.moveTo(mx,my-6); cx.lineTo(mx,my+6); cx.stroke(); }
    // история доли изменений и порог
    const gy=ph+4, gh=H-gy-2, hs=n.hist, mx=Math.max(n.p.thr*2,...hs,1);
    cx.strokeStyle=themeColor('--axis'); cx.lineWidth=1; cx.strokeRect(.5,gy+.5,W-1,gh-1);
    const ty=gy+gh-n.p.thr/mx*gh; cx.setLineDash([3,3]); cx.beginPath(); cx.moveTo(0,ty); cx.lineTo(W,ty); cx.stroke(); cx.setLineDash([]);
    cx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--t-num'); cx.beginPath();
    hs.forEach((v,i)=>{ const x=i/160*W, y=gy+gh-v/mx*gh; i?cx.lineTo(x,y):cx.moveTo(x,y); }); cx.stroke();
    if(ro) ro.textContent=`${(r.motion*100).toFixed(1)}% changed · ${r.on?'MOTION':'quiet'} · ${n.count} events`+(n.fps?` · ${n.fps.toFixed(0)} fps`:''); }});

/* ---------------------------------- Pulse (оптический пульс) ---------------------------------- */
def({ id:'pulse', lazy:'proc', title:'Pulse (camera)', cat:'Video', resize:true, readout:true, view:{h:120}, w:330,
  kw:'pulse heart rate bpm ppg photoplethysmography finger flash torch camera hrv health remote rppg face',
  // палец на объективе со вспышкой (Camera → torch) или лицо в кадре: средний цвет зоны во времени → пульс.
  ins:[{n:'img',t:'img'}],
  outs:[{n:'bpm',t:'num'},{n:'conf',t:'num'},{n:'beat',t:'num'},{n:'hrv',t:'num'},{n:'finger',t:'num'},{n:'ok',t:'num'}],
  params:[{n:'chan',t:'select',opts:['auto','green','red','luma'],d:'auto',label:'colour channel (finger + torch: red or green; face: green)'},
          {n:'win',t:'range',min:6,max:30,step:1,d:12,label:'analysis window, s (longer — steadier, slower to react)'},
          {n:'lo',t:'range',min:30,max:100,step:1,d:42,label:'lowest pulse, bpm'},
          {n:'hi',t:'range',min:120,max:240,step:1,d:200,label:'highest pulse, bpm'},
          {n:'minc',t:'range',min:.1,max:.8,step:.05,d:.3,label:'trust above this confidence'},
          {n:'smooth',t:'range',min:0,max:.95,step:.05,d:.6,label:'bpm smoothing'},
          {n:'zone',t:'check',d:false,label:'only a zone of the frame (face: forehead / cheeks)'},
          {n:'zx',t:'range',min:0,max:1,step:.01,d:.3,label:'zone: x'},{n:'zy',t:'range',min:0,max:1,step:.01,d:.2,label:'zone: y'},
          {n:'zw',t:'range',min:.05,max:1,step:.01,d:.4,label:'zone: width'},{n:'zh',t:'range',min:.05,max:1,step:.01,d:.3,label:'zone: height'}],
  init(n){ n.ts=[]; n.R=[]; n.G=[]; n.B=[]; n.rev=-1; n.res=null; n.bpm=0; n.conf=0; n.ok=0; n.finger=0; n.beats=0; n.lastBeat=-1e9;
    n.lastAn=0; n.fps=0; n.mean=[0,0,0]; n.status='waiting for a picture on img'; },
  process(n,I){
    const im=I.img;
    if(im && im.rev!==n.rev){
      n.rev=im.rev;
      const t=im.t||ctNow();
      if(!n.ts.length || t>n.ts[n.ts.length-1]){
        const z=n.p.zone ? [n.p.zx,n.p.zy,Math.min(n.p.zw,1-n.p.zx),Math.min(n.p.zh,1-n.p.zy)] : [0,0,1,1];
        const [r,g,b]=colMean(ctData(im,n),z,2);
        n.ts.push(t); n.R.push(r); n.G.push(g); n.B.push(b); n.mean=[r,g,b];
        n.finger=ppgFinger(r,g,b)?1:0;
        const cut=t-n.p.win-2; let k=0; while(k<n.ts.length-2 && n.ts[k]<cut) k++;
        if(k){ n.ts.splice(0,k); n.R.splice(0,k); n.G.splice(0,k); n.B.splice(0,k); }
      }
    }
    const now=ctNow(), L=n.ts.length;
    if(L>5 && now-n.lastAn>=.5){
      n.lastAn=now;
      const span=n.ts[L-1]-n.ts[0]; n.fps=span>0 ? (L-1)/span : 0;
      if(n.ts[L-1]<now-2){ n.status='picture stopped'; n.ok=0; }
      else if(span<5){ n.status='collecting… '+Math.max(0,Math.ceil(5-span))+' s'; n.ok=0; }
      else if(n.fps<12){ n.status='only '+n.fps.toFixed(0)+' fps — too few frames for a pulse'; n.ok=0; }
      else{
        const ch=n.p.chan, all={green:{name:'green',v:n.G},red:{name:'red',v:n.R},
          luma:{name:'luma',v:n.R.map((r,i)=>.299*r+.587*n.G[i]+.114*n.B[i])}};
        const res=ppgAnalyze(n.ts,ch==='auto'?[all.green,all.red]:[all[ch]],{win:n.p.win,fmin:n.p.lo/60,fmax:n.p.hi/60});
        n.res=res;
        if(res){
          n.conf=res.conf; n.ok=res.conf>=n.p.minc ? 1 : 0;
          if(n.ok){ n.bpm=n.bpm ? n.bpm*n.p.smooth+res.bpm*(1-n.p.smooth) : res.bpm;
            const tEnd=n.ts[L-1];
            for(const b of res.beats) if(b>n.lastBeat+.3 && b<tEnd-.1){ n.lastBeat=b; n.beats++; n.pend=true; }
            n.status=''; }
          else n.status=n.finger ? 'weak pulse — hold still, press lightly' : 'no pulse found — cover the lens with a fingertip (torch on) or show a face';
        }
      }
    }
    const beat=n.pend?1:0; n.pend=false;
    return {bpm:n.ok?n.bpm:0,conf:n.conf,beat,hrv:n.ok&&n.res?n.res.rmssd:0,finger:n.finger,ok:n.ok}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height; cx.clearRect(0,0,W,H);
    const ro=n.el.querySelector('.readout'), r=n.res;
    cx.fillStyle=themeColor('--axis'); cx.font='bold '+Math.round(H*.22)+'px sans-serif'; cx.textBaseline='top';
    cx.fillText(n.ok ? Math.round(n.bpm)+' bpm' : '— bpm',4,2);
    cx.font='10px monospace'; cx.fillText(n.finger?'finger on the lens':'',4,Math.round(H*.26));
    if(r && r.wave){
      const w=r.wave, N=w.length, gy=Math.round(H*.34), gh=H-gy-3; let mx=1e-6; for(let i=0;i<N;i++) mx=Math.max(mx,Math.abs(w[i]));
      cx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--t-num'); cx.lineWidth=1.5; cx.beginPath();
      for(let i=0;i<N;i++){ const x=i/(N-1)*W, y=gy+gh/2-w[i]/mx*gh/2*.9; i?cx.lineTo(x,y):cx.moveTo(x,y); } cx.stroke();
      cx.fillStyle='#e44'; const t1=r.t0+(N-1)/r.fs;
      for(const b of r.beats){ const x=(b-r.t0)/(t1-r.t0)*W; cx.fillRect(x-2,gy+gh/2-w[Math.round((b-r.t0)*r.fs)]/mx*gh/2*.9-2,4,4); }
    }
    if(ro) ro.textContent=n.status||`conf ${n.conf.toFixed(2)} · ${r?r.chan:''} · HRV ${r?Math.round(r.rmssd):0} ms · ${n.fps.toFixed(0)} fps · ${n.beats} beats`; }});

/* ---------------------------------- Timelapse ---------------------------------- */
// кадры — JPEG-блобы в памяти; из них ролик (webm / mp4) или zip
def({ id:'timelapse', lazy:'proc', title:'Timelapse', cat:'Video', readout:true, view:{h:90}, w:320,
  kw:'timelapse time lapse intervalometer camera frames video sky clouds sunset plants zip deflicker',
  // vid (полное разрешение) или img; rec — запись по уровню, snap — лишний кадр по импульсу
  ins:[{n:'vid',t:'vid'},{n:'img',t:'img'},{n:'rec',t:'num'},{n:'snap',t:'num'},{n:'interval',t:'num'}],
  outs:[{n:'count',t:'num'},{n:'go',t:'num'},{n:'on',t:'num'},{n:'left',t:'num'},{n:'mb',t:'num'}],
  params:[{n:'interval',t:'range',min:.5,max:3600,step:.5,d:10,label:'a frame every, s'},
          {n:'max',t:'range',min:0,max:20000,step:100,d:3000,label:'stop after frames (0 — no limit; frames live in memory)'},
          {n:'maxw',t:'select',opts:['0','640','1280','1920'],d:'1280',label:'frame width, px (0 — as the source)'},
          {n:'q',t:'range',min:.5,max:1,step:.05,d:.85,label:'JPEG quality'},
          {n:'fps',t:'select',opts:['10','12','24','25','30','60'],d:'24',label:'video: frames per second'},
          {n:'defl',t:'check',d:false,label:'video: even out flicker in brightness (slow changes — sunset — stay)'},
          {n:'dwin',t:'range',min:1,max:20,step:1,d:4,label:'deflicker: frames either side'},
          {n:'kbps',t:'range',min:500,max:20000,step:100,d:6000,label:'video: bitrate, kbit/s'},
          {n:'tog',t:'button',label:'Start / stop',fn:n=>tlToggle(n)},
          {n:'snapnow',t:'button',label:'Snap a frame now',fn:n=>{ n.snapNow=true; }},
          {n:'render',t:'button',label:'Render video…',fn:n=>tlRender(n)},
          {n:'zip',t:'button',label:'Download frames (zip)',fn:n=>tlZip(n)},
          {n:'clear',t:'button',label:'Delete all frames',fn:n=>{ if(!n.frames.length || confirm('Delete '+n.frames.length+' frames?')) tlClear(n); }}],
  init(n){ n.frames=[]; n.bytes=0; n.on=false; n.last=null; n.busy=false; n.snapNow=false; n.gate=false; n.sg=false; n.pend=false;
    n.gcv=document.createElement('canvas'); n.gcx=n.gcv.getContext('2d',{willReadFrequently:true});
    n.sm=document.createElement('canvas'); n.sm.width=16; n.sm.height=12; n.smx=n.sm.getContext('2d',{willReadFrequently:true});
    n.prog=''; n.note=''; n.thumb=null; n.thumbT=0; n.t0=0; },
  dispose:n=>{ n.on=false; n.frames=[]; n.abort=true; },
  process(n,I){
    n.I=I;
    if(typeof I.interval==='number' && I.interval>0) setMod(n,'interval',I.interval);
    if(typeof I.rec==='number'){ const g=I.rec>=.5; if(g!==n.gate){ n.gate=g; if(g!==n.on) tlToggle(n); } }
    if(typeof I.snap==='number'){ const g=I.snap>=.5; if(g && !n.sg) n.snapNow=true; n.sg=g; }
    const now=ctNow();
    if(!n.busy && (n.snapNow || (n.on && tlDue({now,last:n.last,interval:n.p.interval,count:n.frames.length,max:n.p.max})))){
      const manual=n.snapNow; n.snapNow=false;
      if(tlGrab(n)){ n.busy=true; if(!manual) n.last=now; tlStore(n); }
      else if(manual) n.note='no picture on vid / img';
    }
    if(n.on && n.p.max>0 && n.frames.length>=n.p.max){ n.on=false; n.note='stopped: '+n.p.max+' frames'; }
    const go=n.pend?1:0; n.pend=false;
    const left=n.on ? Math.max(0,n.p.interval-(n.last==null?0:now-n.last)) : 0;
    return {count:n.frames.length,go,on:n.on?1:0,left,mb:n.bytes/1048576}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height; cx.clearRect(0,0,W,H);
    if(n.thumb){ const k=Math.min(W/n.thumb.width,H/n.thumb.height); cx.drawImage(n.thumb,(W-n.thumb.width*k)/2,(H-n.thumb.height*k)/2,n.thumb.width*k,n.thumb.height*k); }
    if(n.on){ cx.fillStyle='#e44'; cx.beginPath(); cx.arc(W-10,10,5,0,7); cx.fill(); }
    const ro=n.el.querySelector('.readout'); if(!ro) return;
    const fps=+n.p.fps, c=n.frames.length;
    ro.textContent=(n.prog||(n.on?'● recording':'stopped'))+` · ${c} frames · ${(n.bytes/1048576).toFixed(1)} MB`+(c?` · video ${ctFmtT(tlLength(c,fps))} at ${fps} fps`:'')
      +(n.on&&n.p.max>0?` · of ${n.p.max}`:'')+(n.note?'\n'+n.note:''); }});

function tlToggle(n){ n.on=!n.on; n.note=''; if(n.on){ n.last=null; if(!n.frames.length) n.t0=Date.now(); } }
function tlClear(n){ n.frames=[]; n.bytes=0; n.thumb=null; n.last=null; n.note=''; n.prog=''; }
// кадр источника → n.gcv; false, если кадра нет
function tlGrab(n){
  const I=n.I||{}, v=I.vid, im=I.img;
  let src=null, w=0, h=0;
  if(v && (v.videoWidth||v.width) && (v.readyState==null || v.readyState>=2)){ src=v; w=v.videoWidth||v.width; h=v.videoHeight||v.height; }
  else if(im && im.w){
    n.tc=n.tc||document.createElement('canvas');
    if(n.tc.width!==im.w||n.tc.height!==im.h){ n.tc.width=im.w; n.tc.height=im.h; n.tcx=n.tc.getContext('2d'); }
    n.tcx.putImageData(ctData(im,n),0,0); src=n.tc; w=im.w; h=im.h; }
  if(!src) return false;
  const mw=+n.p.maxw||0, k=mw && w>mw ? mw/w : 1, W=Math.max(2,Math.round(w*k)&~1), H=Math.max(2,Math.round(h*k)&~1);
  if(n.gcv.width!==W||n.gcv.height!==H){ n.gcv.width=W; n.gcv.height=H; }
  n.gcx.drawImage(src,0,0,W,H);
  n.smx.drawImage(n.gcv,0,0,16,12);                    // средняя яркость кадра — для выравнивания мерцания
  const d=n.smx.getImageData(0,0,16,12).data; let s=0; for(let i=0;i<d.length;i+=4) s+=d[i]*.299+d[i+1]*.587+d[i+2]*.114;
  n.curMean=s/(d.length/4)/255;
  return true;
}
function tlStore(n){
  const mean=n.curMean, t=Date.now();
  const th=document.createElement('canvas'); th.width=160; th.height=Math.max(1,Math.round(160*n.gcv.height/n.gcv.width));
  th.getContext('2d').drawImage(n.gcv,0,0,th.width,th.height);
  n.gcv.toBlob(b=>{
    n.busy=false;
    if(!b){ n.note='could not encode a frame'; return; }
    n.frames.push({b,mean,t}); n.bytes+=b.size; n.thumb=th; n.pend=true; n.note='';
  },'image/jpeg',+n.p.q);
}
async function tlRender(n){
  if(n.rendering) return;
  if(!n.frames.length){ n.note='no frames yet'; return; }
  const mime=vrecMime('auto'); if(!mime){ n.note='no video encoder in this browser'; return; }
  n.rendering=true; n.abort=false; n.note='';
  const fps=+n.p.fps, fr=n.frames.slice(), gains=n.p.defl ? tlGains(fr.map(f=>f.mean),n.p.dwin) : null;
  try{
    const first=await createImageBitmap(fr[0].b), W=first.width&~1, H=first.height&~1;
    const cv=document.createElement('canvas'); cv.width=W; cv.height=H; const cx=cv.getContext('2d');
    cx.drawImage(first,0,0); first.close();
    const chunks=[], rec=new MediaRecorder(cv.captureStream(fps),{mimeType:mime,videoBitsPerSecond:(+n.p.kbps||6000)*1000});
    rec.ondataavailable=e=>{ if(e.data.size) chunks.push(e.data); };
    const done=new Promise(r=>{ rec.onstop=r; });
    rec.start(1000);
    const canFilter='filter' in cx;
    for(let i=0;i<fr.length && !n.abort;i++){
      const bm=await createImageBitmap(fr[i].b);
      if(gains && canFilter) cx.filter='brightness('+gains[i].toFixed(3)+')';
      cx.drawImage(bm,0,0,W,H); bm.close(); cx.filter='none';
      n.prog='rendering '+(i+1)+'/'+fr.length;
      await new Promise(r=>setTimeout(r,1000/fps));
    }
    rec.stop(); await done;
    if(chunks.length){ dl(new Blob(chunks,{type:mime}),'timelapse-'+recStamp(n.t0||Date.now())+'.'+(mime.startsWith('video/mp4')?'mp4':'webm')); n.note='video saved'; }
  }catch(e){ n.note='render: '+(e.message||e); }
  n.prog=''; n.rendering=false;
}
async function tlZip(n){
  if(!n.frames.length){ n.note='no frames yet'; return; }
  const files=[];
  for(let i=0;i<n.frames.length;i++){
    files.push({name:'frame-'+String(i+1).padStart(5,'0')+'.jpg',data:new Uint8Array(await n.frames[i].b.arrayBuffer())});
    if(i%50===0){ n.prog='packing '+(i+1)+'/'+n.frames.length; await new Promise(r=>setTimeout(r)); }
  }
  dl(new Blob([zipStore(files)],{type:'application/zip'}),'timelapse-'+recStamp(n.t0||Date.now())+'.zip'); n.prog=''; n.note='zip saved';
}

/* ---------------------------------- Color / Spectrometer ---------------------------------- */
def({ id:'colorsp', lazy:'proc', title:'Color / Spectrometer', cat:'Video', resize:true, readout:true, view:{h:130}, w:340,
  kw:'color colour rgb hue cct kelvin white balance light spectrometer spectrum diffraction grating wavelength nm lamp led lines calibration',
  // color: средний цвет зоны (RGB, HSV, цветовая температура, имя). spectrum: полоса кадра за дифракционной решёткой → спектр по длинам волн
  ins:[{n:'img',t:'img'},{n:'dark',t:'num'}],
  outs:[{n:'r',t:'num'},{n:'g',t:'num'},{n:'b',t:'num'},{n:'hex',t:'txt'},{n:'name',t:'txt'},{n:'h',t:'num'},{n:'s',t:'num'},{n:'v',t:'num'},{n:'cct',t:'num'},
        {n:'nm',t:'num'},{n:'lines',t:'txt'},{n:'profile',t:'sig'}],
  params:[{n:'mode',t:'select',opts:['color','spectrum'],d:'color',label:'measure'},
          {n:'zx',t:'range',min:0,max:1,step:.01,d:.4,label:'color: zone x'},{n:'zy',t:'range',min:0,max:1,step:.01,d:.4,label:'color: zone y'},
          {n:'zw',t:'range',min:.02,max:1,step:.01,d:.2,label:'color: zone width'},{n:'zh',t:'range',min:.02,max:1,step:.01,d:.2,label:'color: zone height'},
          {n:'avg',t:'range',min:0,max:.95,step:.05,d:.5,label:'smoothing in time'},
          {n:'by',t:'range',min:0,max:1,step:.01,d:.5,label:'spectrum: strip position (y)'},
          {n:'bh',t:'range',min:.01,max:.5,step:.01,d:.1,label:'spectrum: strip height'},
          {n:'flip',t:'check',d:false,label:'spectrum: mirror left–right'},
          {n:'sm',t:'range',min:1,max:15,step:1,d:3,label:'spectrum: smoothing, px'},
          {n:'rel',t:'range',min:.05,max:.9,step:.05,d:.25,label:'spectrum: lines above this share of the maximum'},
          {n:'hold',t:'check',d:false,label:'spectrum: hold maximum'},
          {n:'x1',t:'range',min:0,max:1,step:.001,d:.25,label:'calibration: point 1, position in the strip'},
          {n:'nm1',t:'range',min:350,max:800,step:.5,d:436.6,label:'calibration: point 1, nm'},
          {n:'x2',t:'range',min:0,max:1,step:.001,d:.75,label:'calibration: point 2, position in the strip'},
          {n:'nm2',t:'range',min:350,max:800,step:.5,d:611.6,label:'calibration: point 2, nm'},
          {n:'fit',t:'button',label:'Calibrate on a fluorescent lamp (Hg 436 · 546 · Eu 611 nm)',fn:n=>csFit(n)},
          {n:'setdark',t:'button',label:'Take dark frame (lens covered)',fn:n=>{ n.darkReq=true; }},
          {n:'cleardark',t:'button',label:'Clear dark frame',fn:n=>{ n.dark=null; n.mx=null; }},
          {n:'clrhold',t:'button',label:'Clear held maximum',fn:n=>{ n.mx=null; }}],
  init(n){ n.col=null; n.sp=null; n.dark=null; n.mx=null; n.darkReq=false; n.darkG=false; n.peaks=[]; n.note=''; n.rev=-1; n.cur=null; n.lines=''; n.nm=0; },
  process(n,I){
    if(typeof I.dark==='number'){ const g=I.dark>=.5; if(g && !n.darkG) n.darkReq=true; n.darkG=g; }
    const im=I.img, p=n.p;
    if(im && im.rev!==n.rev){
      n.rev=im.rev; const id=ctData(im,n);
      if(p.mode==='color'){
        const c=colMean(id,[p.zx,p.zy,Math.min(p.zw,1-p.zx),Math.min(p.zh,1-p.zy)],2), a=p.avg;
        n.col=n.col&&a ? n.col.map((v,i)=>v*a+c[i]*(1-a)) : c;
      } else {
        const pr=specProfile(id,Math.max(0,p.by-p.bh/2),Math.min(1,p.by+p.bh/2));
        const fl=a=>p.flip ? Float32Array.from(a).reverse() : a;
        n.cur={v:fl(pr.v),r:fl(pr.r),g:fl(pr.g),b:fl(pr.b)};
        if(n.darkReq){ n.dark=Float32Array.from(n.cur.v); n.darkReq=false; n.mx=null; n.note='dark frame taken'; }
        const cl=specClean(n.cur.v,n.dark,p.sm);
        if(p.hold){ if(!n.mx||n.mx.length!==cl.length) n.mx=Float32Array.from(cl); else for(let i=0;i<cl.length;i++) if(cl[i]>n.mx[i]) n.mx[i]=cl[i]; } else n.mx=null;
        n.sp=cl; n.peaks=specPeaks(cl,p.rel,Math.max(3,p.sm*2));
        const cal=csCal(n), N=cl.length;
        n.lines=n.peaks.slice(0,8).sort((a,b)=>a.x-b.x).map(q=>specNm(q.x/(N-1),cal).toFixed(0)+' nm').join(' · ');
        n.nm=n.peaks.length ? specNm(n.peaks[0].x/(N-1),cal) : 0;
      }
    }
    const o=buf(n,'profile');
    if(n.p.mode==='spectrum' && n.sp){ const sp=n.sp, N=sp.length, mx=Math.max(1e-6,...sp);
      for(let i=0;i<BLOCK;i++){ const t=i/(BLOCK-1)*(N-1), i0=t|0, f=t-i0; o[i]=(sp[i0]*(1-f)+sp[Math.min(N-1,i0+1)]*f)/mx; } } else o.fill(0);
    const c=n.col||[0,0,0], hsv=colHSV(c[0],c[1],c[2]);
    return {r:c[0],g:c[1],b:c[2],hex:n.col?colHex(c[0],c[1],c[2]):'',name:n.col?colName(c[0],c[1],c[2]):'',h:hsv.h,s:hsv.s,v:hsv.v,
      cct:n.col?colCCT(c[0],c[1],c[2]):0,nm:n.nm,lines:n.lines,profile:o}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height; cx.clearRect(0,0,W,H);
    const ro=n.el.querySelector('.readout');
    if(n.p.mode==='color'){
      const c=n.col; if(!c){ if(ro) ro.textContent='waiting for a picture on img'; return; }
      cx.fillStyle=colHex(c[0],c[1],c[2]); cx.fillRect(0,0,W,H);
      const L=.299*c[0]+.587*c[1]+.114*c[2]; cx.fillStyle=L>.55?'#000':'#fff'; cx.font='bold '+Math.round(Math.min(H*.3,W*.12))+'px monospace'; cx.textBaseline='top';
      cx.fillText(colHex(c[0],c[1],c[2]),8,6); cx.font=Math.round(Math.min(H*.16,W*.06))+'px sans-serif';
      cx.fillText(colName(c[0],c[1],c[2])+' · '+colCCT(c[0],c[1],c[2])+' K',8,Math.round(H*.42));
      if(ro){ const h=colHSV(c[0],c[1],c[2]); ro.textContent=`R ${Math.round(c[0]*255)}  G ${Math.round(c[1]*255)}  B ${Math.round(c[2]*255)} · H ${Math.round(h.h)}° S ${Math.round(h.s*100)}% V ${Math.round(h.v*100)}%`; }
      return;
    }
    const sp=n.sp; if(!sp){ if(ro) ro.textContent='waiting for a picture on img'; return; }
    const cal=csCal(n), N=sp.length, top=14, bot=H-14, gh=bot-top;
    let mx=1e-6; for(let i=0;i<N;i++) mx=Math.max(mx,sp[i],n.mx?n.mx[i]:0);
    // шкала: цветная заливка под кривой по длине волны, подписи каждые 50 нм
    const nmA=specNm(0,cal), nmB=specNm(1,cal);
    for(let x=0;x<W;x++){ const i=Math.min(N-1,Math.round(x/(W-1)*(N-1))), nm=specNm(i/(N-1),cal), hh=sp[i]/mx*gh, [r,g,b]=wlRGB(nm);
      cx.fillStyle=`rgb(${r},${g},${b})`; cx.fillRect(x,bot-hh,1,hh); cx.fillStyle=`rgba(${r},${g},${b},.35)`; cx.fillRect(x,bot,1,6); }
    const stroke=(a,col)=>{ cx.strokeStyle=col; cx.beginPath(); for(let x=0;x<W;x++){ const i=Math.min(N-1,Math.round(x/(W-1)*(N-1))), y=bot-a[i]/mx*gh; x?cx.lineTo(x,y):cx.moveTo(x,y); } cx.stroke(); };
    cx.lineWidth=1; stroke(sp,themeColor('--axis'));
    if(n.mx){ cx.setLineDash([2,2]); stroke(n.mx,'#e44'); cx.setLineDash([]); }
    cx.fillStyle=themeColor('--axis'); cx.font='9px monospace'; cx.textBaseline='top';
    for(let nm=Math.ceil(Math.min(nmA,nmB)/50)*50; nm<=Math.max(nmA,nmB); nm+=50){ const x=specX(nm,cal)*(W-1); cx.fillRect(x,bot,1,4); cx.fillText(nm,x-8,bot+3); }
    cx.textBaseline='alphabetic';
    for(const q of n.peaks.slice(0,6)){ const x=q.x/(N-1)*(W-1), y=bot-q.v/mx*gh; cx.fillText(specNm(q.x/(N-1),cal).toFixed(0),Math.min(W-24,Math.max(0,x-9)),Math.max(10,y-3)); }
    if(ro) ro.textContent=(n.peaks.length ? (n.lines||'') : 'no lines — bring the light source to the strip')+(n.dark?' · dark frame on':'')+(n.note?' · '+n.note:''); }});

const csCal=n=>({x1:n.p.x1,nm1:n.p.nm1,x2:n.p.x2,nm2:n.p.nm2});
// калибровка по трём самым ярким линиям люминесцентной лампы (Hg 436,6 · 546,1 · Eu 611,6 нм): положение линий ↔ эталонные длины волн
function csFit(n){
  const sp=n.sp; if(!sp){ n.note='no spectrum yet'; return; }
  const m=specMatchRef(specPeaks(sp,.1,Math.max(3,n.p.sm*2)),SPEC_REF);
  if(!m){ n.note='need at least 2 lamp lines in the strip'; return; }
  const f=specFit(m.xs.map(x=>x/(sp.length-1)),m.nms);
  if(!f){ n.note='lines too close to calibrate'; return; }
  setMod(n,'x1',+f.x1.toFixed(3)); setMod(n,'nm1',+f.nm1.toFixed(1)); setMod(n,'x2',+f.x2.toFixed(3)); setMod(n,'nm2',+f.nm2.toFixed(1));
  n.note='calibrated, error '+f.rms.toFixed(1)+' nm'+(m.xs.length<3?' (2 lines — check)':'');
}
defGroups('motion',[
  {n:'Detection', p:'pix thr hold mode rate size'},
  {n:'Zone', p:'zone zx zy zw zh', open:false}]);
defGroups('pulse',[
  {n:'Measurement', p:'chan win minc smooth'},
  {n:'Range', p:'lo hi', open:false},
  {n:'Zone', p:'zone zx zy zw zh', open:false}]);
defGroups('timelapse',[
  {n:'Shooting', p:'interval max maxw q'},
  {n:'Video', p:'fps defl dwin kbps', open:false}]);
defGroups('colorsp',[
  {n:'Color', p:'zx zy zw zh avg'},
  {n:'Spectrum', p:'by bh flip sm rel hold setdark cleardark clrhold'},
  {n:'Calibration', p:'x1 nm1 x2 nm2 fit', open:false}]);

/* ---------------------------------- Screen (video) ---------------------------------- */
// getDisplayMedia: вкладка, окно или экран → vid / img и цвет выбранного пикселя вживую. EyeDropper (Chrome) — разовая пипетка: цвет под курсором один раз,
// живого цвета у неё нет, поэтому «живой» пиксель — из кадра захвата (кликните по превью).
function scrStop(n){
  n.gen=(n.gen|0)+1;
  n.stream?.getTracks().forEach(t=>t.stop()); n.stream=null;
  if(n.video) n.video.srcObject=null;
  n.live=false; n.img=null;
}
async function scrStart(n){
  if(n.busy) return;
  if(!navigator.mediaDevices?.getDisplayMedia){ n.status='screen capture is not supported here (needs https and a desktop browser)'; return; }
  scrStop(n); n.busy=true; n.status='choose a screen, window or tab…'; const gen=n.gen;
  try{
    const s=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:+n.p.fps}},audio:false});
    if(gen!==n.gen){ s.getTracks().forEach(t=>t.stop()); return; }
    n.stream=s; n.video.srcObject=s; n.video.play().catch(()=>{});
    n.live=true; n.status='';
    s.getVideoTracks()[0].addEventListener('ended',()=>{ if(n.stream===s){ n.status='sharing stopped by the browser'; scrStop(n); } });
    const cb=()=>{ if(gen!==n.gen) return; n.fresh=true; n.video.requestVideoFrameCallback(cb); };
    if(n.video.requestVideoFrameCallback) n.video.requestVideoFrameCallback(cb); else n.noRvfc=true;
  }catch(e){ n.status=e.name==='NotAllowedError' ? 'cancelled' : 'error: '+(e.message||e.name); }
  finally{ n.busy=false; }
}
async function scrPick(n){
  if(typeof EyeDropper==='undefined'){ n.status='EyeDropper is only in Chrome / Edge (desktop)'; return; }
  try{
    const r=await new EyeDropper().open(), c=colParseHex(r.sRGBHex); if(!c) return;
    n.pick=c; setMod(n,'src','eyedropper'); n.status='';
  }catch(e){ if(e.name!=='AbortError') n.status='eyedropper: '+(e.message||e.name); }
}
// клик / перетаскивание по превью выбирает пиксель
function scrWire(n,cv){
  if(n._wcv===cv) return; n._wcv=cv;
  let down=false;
  const set=ev=>{ const r=cv.getBoundingClientRect(), v=n.video; if(!v?.videoWidth) return;
    const f=scrFit(cv.width,cv.height,v.videoWidth,v.videoHeight), [fx,fy]=scrUnfit(f,(ev.clientX-r.left)/r.width*cv.width,(ev.clientY-r.top)/r.height*cv.height);
    setMod(n,'px',+fx.toFixed(4)); setMod(n,'py',+fy.toFixed(4)); if(n.p.src==='eyedropper') setMod(n,'src','screen pixel'); };
  cv.addEventListener('pointerdown',ev=>{ if(!n.live) return; ev.stopPropagation(); down=true; cv.setPointerCapture(ev.pointerId); set(ev); });
  cv.addEventListener('pointermove',ev=>{ if(down) set(ev); });
  cv.addEventListener('pointerup',()=>{ down=false; });
}
def({ id:'screen', title:'Screen (video)', cat:'Sources', resize:true, readout:true, always:true, view:{h:130}, w:340,
  kw:'screen capture share display window tab desktop video pixel color colour picker eyedropper sample monitor getdisplaymedia',
  // vid — живое видео экрана (Record Video, Files, Video Overlay…), img — уменьшенный кадр (Color / Spectrometer, Motion Detect, Object Detect…)
  ins:[{n:'x',t:'num'},{n:'y',t:'num'}],
  outs:[{n:'vid',t:'vid'},{n:'img',t:'img'},{n:'r',t:'num'},{n:'g',t:'num'},{n:'b',t:'num'},{n:'hex',t:'txt'},{n:'name',t:'txt'},{n:'fps',t:'num'}],
  params:[{n:'go',t:'button',label:'Share screen / window / tab',fn:n=>scrStart(n)},
          {n:'stop',t:'button',label:'Stop sharing',fn:n=>{ scrStop(n); n.status='stopped'; }},
          {n:'pick',t:'button',label:'Eyedropper: one pixel anywhere on the screen (once)',fn:n=>scrPick(n)},
          {n:'src',t:'select',opts:['screen pixel','eyedropper'],d:'screen pixel',label:'colour outputs from (screen pixel: live, from the shared picture)'},
          {n:'px',t:'range',min:0,max:1,step:.0001,d:.5,label:'pixel: x (click the preview)'},
          {n:'py',t:'range',min:0,max:1,step:.0001,d:.5,label:'pixel: y'},
          {n:'rad',t:'select',opts:['0','1','2','4','8'],d:'0',label:'average around the pixel, ± px (0 — exactly one)'},
          {n:'w',t:'select',opts:['160','320','640','960','1280'],d:'320',label:'img width, px'},
          {n:'fps',t:'select',opts:['5','10','15','30','60'],d:'15',label:'frames per second to read (img and pixel)'}],
  init(n){ n.video=document.createElement('video'); n.video.playsInline=true; n.video.muted=true;
    n.capCv=document.createElement('canvas'); n.capCx=n.capCv.getContext('2d',{willReadFrequently:true});
    n.pxCv=document.createElement('canvas'); n.pxCx=n.pxCv.getContext('2d',{willReadFrequently:true});
    n.stream=null; n.live=false; n.busy=false; n.fresh=false; n.img=null; n.col=[0,0,0]; n.pick=null; n.status='not shared'; n.lastRead=0; n.fpsN=0; n.fpsT=0; n.fps=0; n.gen=0; },
  dispose:n=>scrStop(n),
  process(n,I){
    if(typeof I.x==='number') setMod(n,'px',clamp(I.x,0,1));
    if(typeof I.y==='number') setMod(n,'py',clamp(I.y,0,1));
    const v=n.video, now=performance.now();
    if(n.live && v.videoWidth && now-n.lastRead>=1000/+n.p.fps-4 && (n.fresh || n.noRvfc)){
      n.fresh=false; n.lastRead=now; n.fpsN++;
      if(now-n.fpsT>=1000){ n.fps=n.fpsN*1000/(now-n.fpsT); n.fpsN=0; n.fpsT=now; }
      const vw=v.videoWidth, vh=v.videoHeight;
      try{
        const q=scrRect(n.p.px,n.p.py,vw,vh,+n.p.rad);          // пиксель(и) — в полном разрешении захвата, не из уменьшенного кадра
        if(n.pxCv.width!==q.w||n.pxCv.height!==q.h){ n.pxCv.width=q.w; n.pxCv.height=q.h; }
        n.pxCx.drawImage(v,q.x0,q.y0,q.w,q.h,0,0,q.w,q.h);
        n.col=colMean(n.pxCx.getImageData(0,0,q.w,q.h),[0,0,1,1],1);
        if(Graph.edges.some(e=>e.from===n.id&&e.fp==='img')){
          const W=+n.p.w, H=Math.max(1,Math.round(W*vh/vw));
          if(n.capCv.width!==W||n.capCv.height!==H){ n.capCv.width=W; n.capCv.height=H; }
          n.capCx.drawImage(v,0,0,W,H);
          n.img={data:n.capCx.getImageData(0,0,W,H),w:W,h:H,gray:false,rev:(n.img?.rev|0)+1,t:now/1000};
        } else n.img=null;
      }catch(e){ n.status='cannot read the picture: '+(e.message||e.name); }
    }
    const c=n.p.src==='eyedropper' && n.pick ? n.pick : n.col;
    return {vid:n.live?v:null,img:n.img,r:c[0],g:c[1],b:c[2],hex:colHex(c[0],c[1],c[2]),name:colName(c[0],c[1],c[2]),fps:n.fps}; },
  draw(n,cv,cx){
    scrWire(n,cv);
    const W=cv.width, H=cv.height, v=n.video, ro=n.el.querySelector('.readout'); cx.fillStyle='#000'; cx.fillRect(0,0,W,H);
    const c=n.p.src==='eyedropper' && n.pick ? n.pick : n.col, hex=colHex(c[0],c[1],c[2]);
    if(n.live && v.videoWidth){
      const f=scrFit(W,H,v.videoWidth,v.videoHeight); cx.drawImage(v,f.x,f.y,f.w,f.h);
      if(n.p.src!=='eyedropper'){
        const mx=f.x+n.p.px*f.w, my=f.y+n.p.py*f.h;
        cx.lineWidth=3; cx.strokeStyle='#000'; cx.beginPath(); cx.arc(mx,my,7,0,7); cx.stroke();
        cx.lineWidth=1.5; cx.strokeStyle='#fff'; cx.beginPath(); cx.arc(mx,my,7,0,7); cx.stroke(); }
    } else { cx.fillStyle='#fff8'; cx.font='11px sans-serif'; cx.textAlign='center'; cx.fillText(n.status||'press «Share screen»',W/2,H/2); cx.textAlign='left'; }
    cx.fillStyle=hex; cx.fillRect(W-34,4,30,30); cx.strokeStyle='#fff'; cx.lineWidth=1; cx.strokeRect(W-34.5,3.5,31,31);
    if(ro) ro.textContent=(n.live ? `${v.videoWidth}×${v.videoHeight} · ${n.fps.toFixed(0)} fps · ` : (n.status?n.status+' · ':''))+
      `${hex} ${colName(c[0],c[1],c[2])}`+(n.p.src==='eyedropper'?' (eyedropper)':n.live?` · pixel ${(n.p.px*100).toFixed(1)}% ${(n.p.py*100).toFixed(1)}%`:''); }});
defGroups('screen',[
  {n:'Pixel', p:'src px py rad pick'},
  {n:'Picture', p:'w fps', open:false}]);
