"use strict";
/* ============================ MPEG-TS → видео ============================
   Порт bin с транспортным потоком (файл .ts, источник DVB) → демукс (ts-kernels.js) → WebCodecs VideoDecoder.
   Кадры выходят по PTS с буфером; vid — канва с картинкой (Video Overlay, Record Video, WebRTC Video Out). */

function tsvReset(n){
  try{ n.dec?.close(); }catch(e){}
  n.dec=null; n.decCodec=''; n.needKey=true; n.lastTs=-1;
  for(const f of n.q||[]) try{ f.close(); }catch(e){}
  n.q=[]; n.base=null;
}
function tsvClose(n){ tsvReset(n); n.fileObj=null; }

async function tsvConfigure(n,codec,type){
  if(typeof VideoDecoder==='undefined'){ n.status='WebCodecs is not available in this browser'; return false; }
  if(type==='mpeg2'){ n.status='MPEG-2 video: the browser has no decoder'; return false; }
  const cfg={codec, optimizeForLatency:true};
  if(type==='hevc') cfg.hevc={format:'annexb'};
  let sup=null;
  try{ sup=await VideoDecoder.isConfigSupported(cfg); }catch(e){}
  if(!sup?.supported){ n.status='codec '+codec+' is not supported by the browser'; return false; }
  const dec=new VideoDecoder({
    output:f=>{ if(n.dec!==dec){ f.close(); return; } n.q.push(f); n.decoded++; },
    error:e=>{ n.status='decoder: '+e.message; if(n.dec===dec){ n.dec=null; n.needKey=true; } }});
  dec.configure(cfg);
  n.dec=dec; n.decCodec=codec; n.needKey=true;
  return true;
}

function tsvFeed(n,bytes){
  const dm=n.dmx;
  dm.push(bytes);
  const fr=dm.takeVideo();
  dm.takeAudio();                                              // звук пока не декодируется
  for(const f of fr){
    const type=dm.cur?.vtype;
    if(!dm.vcodec || !type) continue;
    if(!n.dec || n.decCodec!==dm.vcodec){
      if(n.cfgBusy) return;
      if(!f.key) continue;
      n.cfgBusy=true;
      tsvConfigure(n,dm.vcodec,type).then(()=>{ n.cfgBusy=false; });
      return;                                                  // этот кадр пропускаем, ждём следующий ключевой
    }
    if(n.needKey && !f.key) continue;
    if(n.dec.decodeQueueSize>40){ n.needKey=true; n.dropped++; continue; }
    n.needKey=false;
    let ts=f.pts>=0 ? Math.round(f.pts*1e6) : (n.lastTs>=0 ? n.lastTs+40000 : 0);
    n.lastTs=ts;
    try{ n.dec.decode(new EncodedVideoChunk({type:f.key ? 'key' : 'delta', timestamp:ts, data:f.d})); }
    catch(e){ n.status='decode: '+e.message; n.needKey=true; }
  }
}

// Выдать кадр, которому пора: остальные просроченные закрываются
function tsvPresent(n){
  const q=n.q, now=performance.now();
  if(!q.length) return;
  if(n.base==null || q.length>40){ n.ts0=q[0].timestamp; n.wall0=now+(+n.p.delay||0); n.base=1; while(q.length>40) q.shift().close(); }
  let pick=-1;
  for(let i=0;i<q.length;i++){ if((q[i].timestamp-n.ts0)/1000<=now-n.wall0) pick=i; else break; }
  if(pick<0) return;
  for(let i=0;i<pick;i++) q[i].close();
  const f=q[pick]; q.splice(0,pick+1);
  const w=f.displayWidth, h=f.displayHeight;
  if(n.out.width!==w || n.out.height!==h){ n.out.width=w; n.out.height=h; }
  n.outCx.drawImage(f,0,0);
  f.close();
  n.shown++; n.fpsN++; n.gotFrame=true;
}

function tsvPump(n){
  if(n.fileObj && !n.rd && n.q.length+(n.dec?.decodeQueueSize||0)<24){
    const f=n.fileObj, pos=n.pos, end=Math.min(f.size,pos+188*1024);
    if(pos>=f.size){
      if(n.p.loop){ n.pos=0; n.dmx.buf=new Uint8Array(0); for(const s of n.dmx.pids.values()){ s.cc=-1; s.chunks=[]; } n.base=null; n.needKey=true; }
    }else{
      n.rd=true;
      f.slice(pos,end).arrayBuffer().then(a=>{ if(n.fileObj===f){ n.pos=end; tsvFeed(n,new Uint8Array(a)); } n.rd=false; },()=>{ n.rd=false; });
    }
  }
}

def({ id:'tsvid', title:'TS → Video', cat:'Decoders', kw:'mpeg ts transport stream dvb tv video h264 avc hevc webcodecs television broadcast', readout:true, always:true,
  ins:[{n:'bin',t:'bin'}], outs:[{n:'vid',t:'vid'},{n:'lock',t:'num'},{n:'fps',t:'num'}],
  params:[{n:'file',t:'file',accept:'.ts,.m2ts,.mts,video/mp2t',fn:(n,f)=>{
            tsvReset(n); n.dmx.reset(); n.fileObj=f; n.pos=0; n.status='file '+f.name; }},
          {n:'loop',t:'check',d:true,label:'loop the file'},
          {n:'program',t:'num',d:0,label:'program number (0 — first with video)'},
          {n:'delay',t:'range',min:0,max:2000,step:50,d:400,label:'buffer, ms (a live stream needs more)'},
          {n:'reset',t:'button',label:'Reset',fn:n=>{ tsvReset(n); n.dmx.reset(); n.pos=0; n.status='reset'; }}],
  view:{h:120},
  init(n){
    n.dmx=new TsDemux(); n.q=[]; n.fileObj=null; n.pos=0; n.rd=false; n.dec=null; n.decCodec=''; n.cfgBusy=false;
    n.needKey=true; n.lastTs=-1; n.base=null; n.last=null; n.status='waiting for a transport stream';
    n.decoded=0; n.shown=0; n.dropped=0; n.fpsN=0; n.fps=0; n.fpsT=performance.now(); n.gotFrame=false; n.prog=0;
    n.out=document.createElement('canvas'); n.outCx=n.out.getContext('2d');
    // у <video> есть videoWidth / videoHeight, их ждут потребители vid
    Object.defineProperty(n.out,'videoWidth',{get(){ return this.width; }});
    Object.defineProperty(n.out,'videoHeight',{get(){ return this.height; }});
  },
  dispose:n=>{ tsvClose(n); },
  process(n,I){
    const o=I.bin;
    if(o && o.d && o!==n.last){ n.last=o; tsvFeed(n,o.d); }
    const pr=+n.p.program|0;
    if(pr!==n.prog){ n.prog=pr; tsvReset(n); n.dmx.select(pr); n.dmx.vcodec=''; n.dmx.sps=null; }
    tsvPump(n);
    tsvPresent(n);
    const now=performance.now();
    if(now-n.fpsT>=1000){ n.fps=n.fpsN*1000/(now-n.fpsT); n.fpsN=0; n.fpsT=now; if(n.fps===0) n.gotFrame=false; }
    return {vid:n.gotFrame && n.out.width ? n.out : null, lock:n.gotFrame ? 1 : 0, fps:n.fps}; },
  draw(n,cv,cx){
    const r=n.el.querySelector('.readout');
    if(r){
      const d=n.dmx, st=d.stat, pl=d.list();
      let t=n.status;
      if(pl.length) t='programs '+pl.map(p=>p.num+(p===d.cur ? '▶' : '')).join(' ')+' · '+(d.vcodec||'—')+(d.sps ? ' · '+d.sps.w+'×'+d.sps.h : '')+
        ' · '+n.fps.toFixed(1)+' fps'+(pl.find(p=>p===d.cur)?.apid ? ' · audio '+d.cur.atype+' (not decoded)' : '');
      if(st.cc||n.dropped) t+='\ncontinuity errors '+st.cc+(n.dropped ? ' · dropped '+n.dropped : '');
      if(n.status && pl.length && !n.gotFrame) t+='\n'+n.status;
      if(r.textContent!==t) r.textContent=t;
    }
    if(!n.out.width || !cv) return;
    cx.fillStyle='#000'; cx.fillRect(0,0,cv.width,cv.height);
    const k=Math.min(cv.width/n.out.width,cv.height/n.out.height), w=n.out.width*k, h=n.out.height*k;
    cx.drawImage(n.out,(cv.width-w)/2,(cv.height-h)/2,w,h); }
});
