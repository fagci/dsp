"use strict";
/* ============================ MPEG-TS → видео ============================
   Порт bin с транспортным потоком (файл .ts, источник DVB) → демукс (ts-kernels.js) → WebCodecs VideoDecoder
   (H.264, HEVC) или vendor/mpeg2.wasm (MPEG-2: в браузере декодера нет, tools/mpeg2).
   Кадры выходят по PTS с буфером; vid — канва с картинкой (Video Overlay, Record Video, WebRTC Video Out). */

// MPEG-2: один wasm-модуль на узел, скомпилированный один раз
let TSV_M2=null;
function tsvM2Load(){
  if(!TSV_M2) TSV_M2=fetch('vendor/mpeg2.wasm').then(r=>{ if(!r.ok) throw new Error('vendor/mpeg2.wasm: HTTP '+r.status); return r.arrayBuffer(); })
    .then(b=>WebAssembly.compile(b));
  return TSV_M2.then(m=>WebAssembly.instantiate(m,{})).then(i=>i.exports);
}
const TSV_DAR={2:4/3, 3:16/9, 4:2.21};
const TSV_M2ERR={1:'4:2:2 / 4:4:4 is not supported',2:'MPEG-1 video is not supported',3:'dual prime prediction is not supported',4:'picture size is not supported',5:'out of memory'};

function tsvReset(n){
  try{ n.dec?.close(); }catch(e){}
  try{ n.m2?.m2_reset(); }catch(e){}
  try{ n.m2?.a2_reset(); }catch(e){}
  n.aq=[]; n.aEnd=null;
  n.dec=null; n.decCodec=''; n.needKey=true; n.lastTs=-1;
  for(const f of n.q||[]) try{ f.close(); }catch(e){}
  n.q=[]; n.base=null;
}
function tsvClose(n){ tsvReset(n); n.fileObj=null; }

async function tsvConfigure(n,codec,type){
  if(typeof VideoDecoder==='undefined'){ n.status='WebCodecs is not available in this browser'; return false; }
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

// MPEG-2: кадр потока → wasm → готовые RGBA-картинки в очередь показа
function tsvM2(n,f){
  const x=n.m2;
  if(!x){
    if(!n.m2p) n.m2p=tsvM2Load().then(e=>{ n.m2=e; },e=>{ n.status='MPEG-2 decoder: '+e.message; });
    return;
  }
  if(f.d.length>x.m2_cap()) return;
  new Uint8Array(x.memory.buffer,x.m2_in(),f.d.length).set(f.d);
  const nf=x.m2_decode(f.d.length,f.pts);
  n.m2err=x.m2_err(); n.m2bad=x.m2_bad();
  const w=x.m2_w(), h=x.m2_h();
  for(let i=0;i<nf;i++){
    const rgba=new Uint8ClampedArray(x.memory.buffer,x.m2_frame(i),w*h*4).slice();
    n.q.push({timestamp:Math.max(0,x.m2_pts(i))*1e6, rgba, w, h, dar:TSV_DAR[x.m2_aspect()]||w/h, close(){}});
    n.decoded++;
  }
}

/* ---- звук MP2: wasm → сегменты на частоте движка с метками времени медиа → чтение по часам видео ---- */
function tsvAudio(n,a){
  if(a.type!=='mp2') return;
  const x=n.m2;
  if(!x){ if(!n.m2p) n.m2p=tsvM2Load().then(e=>{ n.m2=e; },e=>{ n.status='decoder: '+e.message; }); return; }
  if(a.d.length>x.a2_cap()) return;
  new Uint8Array(x.memory.buffer,x.a2_in(),a.d.length).set(a.d);
  const cnt=x.a2_feed(a.d.length);
  if(!cnt) return;
  const rate=x.a2_rate(), pcm=new Float32Array(x.memory.buffer,x.a2_pcm(),cnt*2);
  n.aInfo=x.a2_kbps()+' kbit/s · '+rate+' Hz';
  const sr=Eng.sr, k=rate/sr, m=Math.floor((cnt-1)/k);
  const L=new Float32Array(m), R=new Float32Array(m);
  for(let i=0;i<m;i++){                                        // линейная интерполяция к частоте движка
    const p=i*k, j=p|0, f=p-j, j1=Math.min(j+1,cnt-1);
    L[i]=pcm[j*2]*(1-f)+pcm[j1*2]*f; R[i]=pcm[j*2+1]*(1-f)+pcm[j1*2+1]*f; }
  let t=a.pts;
  if(n.aEnd!=null && (t<0 || Math.abs(t-n.aEnd)<.1)) t=n.aEnd;  // PES подряд: без щелей и нахлёстов
  if(t<0) return;
  n.aEnd=t+m/sr;
  n.aq.push({t0:t, i:0, L, R});
  while(n.aq.length>200) n.aq.shift();
}
// m отсчётов звука для медиавремени target (секунды); рассинхрон больше 80 мс: пропуск или тишина
function tsvAudioRead(n,oL,oR,target,g){
  const sr=Eng.sr, B=oL.length;
  let o=0;
  while(o<B){
    const sg=n.aq[0];
    if(!sg) break;
    const d=sg.t0+sg.i/sr-target-o/sr;
    if(d>.08) break;
    if(d<-.08){ sg.i+=Math.ceil(-d*sr); if(sg.i>=sg.L.length) n.aq.shift(); continue; }
    const c=Math.min(B-o,sg.L.length-sg.i);
    for(let i=0;i<c;i++){ oL[o+i]=sg.L[sg.i+i]*g; oR[o+i]=sg.R[sg.i+i]*g; }
    sg.i+=c; o+=c;
    if(sg.i>=sg.L.length) n.aq.shift();
  }
}

function tsvFeed(n,bytes){
  const dm=n.dmx;
  dm.push(bytes);
  const fr=dm.takeVideo();
  for(const a of dm.takeAudio()) tsvAudio(n,a);
  for(const f of fr){
    const type=dm.cur?.vtype;
    if(!dm.vcodec || !type) continue;
    if(type==='mpeg2'){ tsvM2(n,f); continue; }
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
  const cap=q[0].rgba ? 24 : 40;
  if(n.base==null || q.length>cap){ n.ts0=q[0].timestamp; n.wall0=now+(+n.p.delay||0); n.base=1; while(q.length>cap) q.shift().close(); }
  let pick=-1;
  for(let i=0;i<q.length;i++){ if((q[i].timestamp-n.ts0)/1000<=now-n.wall0) pick=i; else break; }
  if(pick<0) return;
  for(let i=0;i<pick;i++) q[i].close();
  const f=q[pick]; q.splice(0,pick+1);
  if(f.rgba){
    const w=Math.round(f.h*f.dar)&~1, h=f.h;                    // пиксели не квадратные: ширина по формату кадра
    if(n.pic.width!==w || n.pic.height!==h){ n.pic.width=w; n.pic.height=h; }
    const tc=n.tmp||(n.tmp=document.createElement('canvas'));
    if(tc.width!==f.w || tc.height!==f.h){ tc.width=f.w; tc.height=f.h; n.tmpCx=tc.getContext('2d'); }
    n.tmpCx.putImageData(new ImageData(f.rgba,f.w,f.h),0,0);
    n.picCx.drawImage(tc,0,0,w,h);
  }else{
    const w=f.displayWidth, h=f.displayHeight;
    if(n.pic.width!==w || n.pic.height!==h){ n.pic.width=w; n.pic.height=h; }
    n.picCx.drawImage(f,0,0);
    f.close();
  }
  n.shown++; n.fpsN++; n.gotFrame=true;
}

function tsvPump(n){
  if(n.fileObj && !n.rd && n.q.length+(n.dec?.decodeQueueSize||0)<(n.dmx.cur?.vtype==='mpeg2' ? 8 : 24)){
    const f=n.fileObj, pos=n.pos, end=Math.min(f.size,pos+188*64);
    if(pos>=f.size){
      if(n.p.loop){ tsvReset(n); n.pos=0; n.dmx.buf=new Uint8Array(0); for(const s of n.dmx.pids.values()){ s.cc=-1; s.chunks=[]; } }
    }else{
      n.rd=true;
      f.slice(pos,end).arrayBuffer().then(a=>{ if(n.fileObj===f){ n.pos=end; tsvFeed(n,new Uint8Array(a)); } n.rd=false; },()=>{ n.rd=false; });
    }
  }
}

def({ id:'tsvid', title:'TS → Video', cat:'Decoders', kw:'mpeg ts transport stream dvb tv video h264 avc hevc webcodecs television broadcast', readout:true, always:true,
  ins:[{n:'bin',t:'bin'}], outs:[{n:'vid',t:'vid'},{n:'L',t:'sig'},{n:'R',t:'sig'},{n:'lock',t:'num'},{n:'fps',t:'num'}],
  params:[{n:'file',t:'file',accept:'.ts,.m2ts,.mts,video/mp2t',fn:(n,f)=>{
            tsvReset(n); n.dmx.reset(); n.fileObj=f; n.pos=0; n.status='file '+f.name; }},
          {n:'loop',t:'check',d:true,label:'loop the file'},
          {n:'program',t:'num',d:0,label:'program number (0 — first with video)'},
          {n:'delay',t:'range',min:0,max:2000,step:50,d:400,label:'buffer, ms (a live stream needs more)'},
          {n:'volume',t:'range',min:0,max:2,step:.01,d:1,label:'volume'},
          {n:'avsync',t:'range',min:-500,max:500,step:10,d:0,label:'audio delay, ms (positive — later)'},
          {n:'reset',t:'button',label:'Reset',fn:n=>{ tsvReset(n); n.dmx.reset(); n.pos=0; n.status='reset'; }}],
  view:{h:120},
  init(n){
    n.dmx=new TsDemux(); n.q=[]; n.fileObj=null; n.pos=0; n.rd=false; n.dec=null; n.decCodec=''; n.cfgBusy=false;
    n.needKey=true; n.lastTs=-1; n.base=null; n.last=null; n.status='waiting for a transport stream';
    n.aq=[]; n.aEnd=null; n.aInfo=''; n.decoded=0; n.m2=null; n.m2p=null; n.m2err=0; n.m2bad=0; n.shown=0; n.dropped=0; n.fpsN=0; n.fps=0; n.fpsT=performance.now(); n.gotFrame=false; n.prog=0;
    n.pic=document.createElement('canvas'); n.picCx=n.pic.getContext('2d');
    // у <video> есть videoWidth / videoHeight, их ждут потребители vid
    Object.defineProperty(n.pic,'videoWidth',{get(){ return this.width; }});
    Object.defineProperty(n.pic,'videoHeight',{get(){ return this.height; }});
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
    const oL=buf(n,'L'), oR=buf(n,'R'); oL.fill(0); oR.fill(0);
    if(n.base!=null && n.aq.length) tsvAudioRead(n,oL,oR,n.ts0/1e6+(now-n.wall0)/1000-(+n.p.avsync||0)/1000,+n.p.volume);
    return {vid:n.gotFrame && n.pic.width ? n.pic : null, L:oL, R:oR, lock:n.gotFrame ? 1 : 0, fps:n.fps}; },
  draw(n,cv,cx){
    const r=n.el.querySelector('.readout');
    if(r){
      const d=n.dmx, st=d.stat, pl=d.list();
      let t=n.status;
      if(n.m2err) t=TSV_M2ERR[n.m2err]||('MPEG-2 error '+n.m2err);
      if(pl.length) t='programs '+pl.map(p=>p.num+(p===d.cur ? '▶' : '')).join(' ')+' · '+(d.vcodec||'—')+(d.sps ? ' · '+d.sps.w+'×'+d.sps.h : '')+
        ' · '+n.fps.toFixed(1)+' fps'+(d.cur?.apid ? ' · audio '+d.cur.atype+(d.cur.atype==='mp2' ? (n.aInfo ? ' · '+n.aInfo : '') : ' (not decoded)') : '');
      if(st.cc||n.dropped||n.m2bad) t+='\ncontinuity errors '+st.cc+(n.dropped ? ' · dropped '+n.dropped : '')+(n.m2bad ? ' · bad slices '+n.m2bad : '');
      if(n.status && pl.length && !n.gotFrame) t+='\n'+n.status;
      if(r.textContent!==t) r.textContent=t;
    }
    if(!n.pic.width || !cv) return;
    cx.fillStyle='#000'; cx.fillRect(0,0,cv.width,cv.height);
    const k=Math.min(cv.width/n.pic.width,cv.height/n.pic.height), w=n.pic.width*k, h=n.pic.height*k;
    cx.drawImage(n.pic,(cv.width-w)/2,(cv.height-h)/2,w,h); }
});
