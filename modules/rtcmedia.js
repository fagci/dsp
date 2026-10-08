"use strict";
/* ============================ WebRTC: звук и видео графа ============================
   Узлы Audio Out / Video Out отправляют сигнал графа дорожкой в соединение узла WebRTC Data, Audio In / Video In отдают принятую дорожку
   в граф. Связь с соединением — провод rtc (WebRTC Data → link). Дорожка называется (параметр label): приёмный узел берёт дорожку с
   тем же именем; микрофон, камера и экран самого WebRTC Data называются mic, camera и screen. Несколько узлов — несколько дорожек. */

const rtcLinked=v=>{ const r=v && v.node; return r && Graph.map[r.id]===r && r.type==='rtcdata' ? r : null; };
function rtcPick(rn,kind,label){                       // принятая живая дорожка нужного вида и имени
  if(!rn || !rn.remote) return null;
  for(const t of rn.remote.getTracks())
    if(t.kind===kind && t.readyState==='live' && rn.rlabel?.[t.id]===label) return t;
  return null;
}
// кольцо отсчётов между блоками графа и аудиопотоком браузера
function rgNew(n){ return {b:new Float32Array(n),r:0,w:0,fill:0}; }
function rgPush(g,x,k=1,keep=0){
  const n=g.b.length;
  for(let i=0;i<x.length;i++){ g.b[g.w]=x[i]*k; g.w=(g.w+1)%n; }
  g.fill+=x.length;
  const over=g.fill-(keep||n);                       // держим задержку короткой: лишнее старое выбрасываем
  if(over>0){ g.r=(g.r+over)%n; g.fill-=over; }
}
function rgPull(g,out,len){
  const n=g.b.length;
  for(let i=0;i<len;i++){
    if(g.fill>0){ out[i]=g.b[g.r]; g.r=(g.r+1)%n; g.fill--; } else out[i]=0;
  }
}
function rtcAudioDrop(n){
  try{ n.sp?.disconnect(); n.src?.disconnect(); n.sil?.disconnect(); }catch(e){}
  if(n.sp) n.sp.onaudioprocess=null;
  if(n.aEl){ n.aEl.pause(); n.aEl.srcObject=null; }
  n.sp=n.src=n.sil=n.aEl=n.msd=n.track=n.stream=n.ring=n.ctx=null;
}

/* ---- Audio Out ---- */
def({ id:'rtcAudioOut', title:'WebRTC Audio Out', cat:'Output', kw:'webrtc audio send voice call stream network',
  ins:[{n:'in',t:'sig'},{n:'rtc',t:'rtc'}], outs:[{n:'active',t:'num'}], readout:true,
  params:[{n:'label',t:'text',d:'voice',label:'track name (the receiving Audio In takes the same)'},
          {n:'gain',t:'range',min:0,max:4,step:.01,d:1},
          {n:'mute',t:'check',d:false}],
  init:n=>{ n.rn=null; n.lbl=null; n.status='not linked'; n.sent=0; },
  dispose:n=>{ if(n.rn) rtcExtDel(n.rn,'a'+n.id); rtcAudioDrop(n); },
  process(n,I){
    const rn=rtcLinked(I.rtc), ctx=Eng.ctx;
    if(n.ctx && n.ctx!==ctx){ if(n.rn) rtcExtDel(n.rn,'a'+n.id); rtcAudioDrop(n); n.lbl=null; }
    if(!n.sp && ctx){
      n.ctx=ctx; n.ring=rgNew(Math.ceil(ctx.sampleRate));
      n.msd=ctx.createMediaStreamDestination(); n.stream=n.msd.stream; n.track=n.stream.getAudioTracks()[0];
      n.sp=ctx.createScriptProcessor(2048,1,1);
      n.sp.onaudioprocess=e=>{ rgPull(n.ring,e.outputBuffer.getChannelData(0),e.outputBuffer.length); };
      n.sp.connect(n.msd);
    }
    if(rn!==n.rn){ if(n.rn) rtcExtDel(n.rn,'a'+n.id); n.rn=rn; n.lbl=null; }
    if(rn && n.track && n.lbl!==n.p.label){ n.lbl=n.p.label; rtcExtSet(rn,'a'+n.id,n.track,n.stream,String(n.p.label||'voice')); }
    const x=I.in;
    if(n.ring && x){ rgPush(n.ring,x,n.p.mute ? 0 : n.p.gain,Math.round(n.ctx.sampleRate*.25)); n.sent+=x.length; }
    n.status=!rn ? 'not linked (wire WebRTC Data → link to rtc)' : !rn.open ? 'linked, waiting for the connection' : x ? 'sending «'+n.p.label+'»' : 'linked, no signal on in';
    return {active:rn && rn.open && x ? 1 : 0};
  },
  draw(n){ if(n.ro) n.ro.textContent=n.status; }
});

/* ---- Audio In ---- */
def({ id:'rtcAudioIn', title:'WebRTC Audio In', cat:'Sources', kw:'webrtc audio receive voice call stream network',
  ins:[{n:'rtc',t:'rtc'}], outs:[{n:'out',t:'sig'},{n:'active',t:'num'}], readout:true,
  params:[{n:'label',t:'text',d:'voice',label:'track name (the sender\'s Audio Out label; mic — the other side\'s microphone)'},
          {n:'gain',t:'range',min:0,max:4,step:.01,d:1}],
  init:n=>{ n.status='not linked'; },
  dispose:n=>rtcAudioDrop(n),
  process(n,I){
    const rn=rtcLinked(I.rtc), ctx=Eng.ctx;
    const tr=rtcPick(rn,'audio',String(n.p.label||'voice'));
    if(n.ctx && n.ctx!==ctx) rtcAudioDrop(n);
    if(tr!==n.track || (tr && !n.sp)){
      rtcAudioDrop(n);
      if(tr && ctx){
        n.track=tr; n.ctx=ctx; n.ring=rgNew(Math.ceil(ctx.sampleRate));
        n.stream=new MediaStream([tr]);
        n.aEl=new Audio(); n.aEl.srcObject=n.stream; n.aEl.muted=true; n.aEl.play().catch(()=>{});   // без элемента Chrome не отдаёт звук WebRTC в WebAudio
        n.src=ctx.createMediaStreamSource(n.stream); n.sp=ctx.createScriptProcessor(2048,1,1);
        n.sp.onaudioprocess=e=>{ rgPush(n.ring,e.inputBuffer.getChannelData(0),1,Math.round(ctx.sampleRate*.4)); };
        n.sil=ctx.createGain(); n.sil.gain.value=0;
        n.src.connect(n.sp); n.sp.connect(n.sil); n.sil.connect(ctx.destination);
      }
    }
    const o=buf(n,'o');
    if(n.ring) rgPull(n.ring,o,o.length); else o.fill(0);
    const g=n.p.gain; if(g!==1) for(let i=0;i<o.length;i++) o[i]*=g;
    n.status=!rn ? 'not linked (wire WebRTC Data → link to rtc)' : n.track ? 'receiving «'+n.p.label+'»' : 'no track «'+n.p.label+'» yet';
    return {out:o, active:n.track && !n.track.muted ? 1 : 0};
  },
  draw(n){ if(n.ro) n.ro.textContent=n.status; }
});

/* ---- Video Out ---- */
def({ id:'rtcVideoOut', title:'WebRTC Video Out', cat:'Output', kw:'webrtc video send picture frame stream network camera',
  ins:[{n:'vid',t:'vid'},{n:'img',t:'img'},{n:'rtc',t:'rtc'}], outs:[{n:'active',t:'num'}], readout:true,
  params:[{n:'label',t:'text',d:'video',label:'track name (the receiving Video In takes the same)'},
          {n:'fps',t:'select',opts:['5','10','15','30'],d:'15',label:'frames per second'},
          {n:'maxw',t:'select',opts:['320','480','640','960'],d:'640',label:'max width, px'}],
  init:n=>{ n.rn=null; n.lbl=null; n.oc=null; n.t0=0; n.status='not linked'; n.src=''; },
  dispose:n=>{ if(n.rn) rtcExtDel(n.rn,'v'+n.id); n.track?.stop(); n.oc=n.track=n.stream=null; },
  process(n,I){
    const rn=rtcLinked(I.rtc), fps=+n.p.fps||15, now=performance.now();
    if(!n.oc){ n.oc=document.createElement('canvas'); n.oc.width=320; n.oc.height=240; n.occ=n.oc.getContext('2d');
      n.tmp=document.createElement('canvas'); n.tx=n.tmp.getContext('2d');
      n.stream=n.oc.captureStream(fps); n.track=n.stream.getVideoTracks()[0]; n.fpsSet=fps; }
    if(rn!==n.rn){ if(n.rn) rtcExtDel(n.rn,'v'+n.id); n.rn=rn; n.lbl=null; }
    if(rn && n.lbl!==n.p.label){ n.lbl=n.p.label; rtcExtSet(rn,'v'+n.id,n.track,n.stream,String(n.p.label||'video')); }
    let srcW=0, srcH=0, src=null;
    const v=I.vid, im=I.img;
    if(v && v.videoWidth){ src=v; srcW=v.videoWidth; srcH=v.videoHeight; n.src='video'; }
    else if(im && im.data){ src=im; srcW=im.w; srcH=im.h; n.src='frame'; }
    if(src && now-n.t0>=1000/fps){
      n.t0=now;
      const k=Math.min(1,(+n.p.maxw||640)/srcW), W=Math.max(2,Math.round(srcW*k)&~1), H=Math.max(2,Math.round(srcH*k)&~1);
      if(n.oc.width!==W || n.oc.height!==H){ n.oc.width=W; n.oc.height=H; }
      if(src===im){
        if(n.tmp.width!==srcW || n.tmp.height!==srcH){ n.tmp.width=srcW; n.tmp.height=srcH; }
        n.tx.putImageData(im.data,0,0); n.occ.drawImage(n.tmp,0,0,W,H);
      } else n.occ.drawImage(v,0,0,W,H);
    }
    n.status=!rn ? 'not linked (wire WebRTC Data → link to rtc)' : !rn.open ? 'linked, waiting for the connection'
      : src ? 'sending «'+n.p.label+'» from '+n.src+' '+n.oc.width+'×'+n.oc.height : 'linked, no picture on vid / img';
    return {active:rn && rn.open && src ? 1 : 0};
  },
  draw(n){ if(n.ro) n.ro.textContent=n.status; }
});

/* ---- Video In ---- */
def({ id:'rtcVideoIn', title:'WebRTC Video In', cat:'Sources', kw:'webrtc video receive picture frame stream network camera',
  ins:[{n:'rtc',t:'rtc'}], outs:[{n:'img',t:'img'},{n:'vid',t:'vid'},{n:'active',t:'num'}],
  params:[{n:'label',t:'text',d:'video',label:'track name (the sender\'s Video Out label; camera / screen — the other side\'s own)'},
          {n:'w',t:'select',opts:['80','160','320'],d:'160',label:'frame width for the img output'}],
  view:{h:100}, readout:true, always:true,
  init(n){ n.video=document.createElement('video'); n.video.playsInline=true; n.video.muted=true;
           n.capCv=document.createElement('canvas'); n.capCx=n.capCv.getContext('2d',{willReadFrequently:true});
           n.track=null; n.t0=0; n.img=null; n.status='not linked'; },
  dispose(n){ n.video.pause(); n.video.srcObject=null; },
  process(n,I){
    const rn=rtcLinked(I.rtc), tr=rtcPick(rn,'video',String(n.p.label||'video'));
    if(tr!==n.track){
      n.track=tr; n.img=null;
      n.video.srcObject=tr ? new MediaStream([tr]) : null;
      if(tr) n.video.play().catch(()=>{});
    }
    const v=n.video, now=performance.now();
    if(tr && v.videoWidth && now-n.t0>=66){
      n.t0=now;
      const W=+n.p.w, H=Math.round(W*(v.videoHeight/v.videoWidth||3/4));
      if(n.capCv.width!==W || n.capCv.height!==H){ n.capCv.width=W; n.capCv.height=H; }
      n.capCx.drawImage(v,0,0,W,H);
      n.img={data:n.capCx.getImageData(0,0,W,H),w:W,h:H,gray:false,rev:(n.img?.rev|0)+1};
    }
    n.status=!rn ? 'not linked (wire WebRTC Data → link to rtc)' : tr ? (v.videoWidth ? 'receiving «'+n.p.label+'» '+v.videoWidth+'×'+v.videoHeight : 'waiting for the first frame') : 'no track «'+n.p.label+'» yet';
    return {img:n.img, vid:v.videoWidth ? v : null, active:tr && v.videoWidth ? 1 : 0};
  },
  draw(n,cv,cx){
    if(n.ro) n.ro.textContent=n.status;
    if(cv && n.video.videoWidth) cx.drawImage(n.video,0,0,cv.width,cv.height); }
});
