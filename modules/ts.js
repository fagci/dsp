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
  n.aq=[]; n.aEnd=null; n.inq=[]; n.inqLen=0; n.rate0=0; n.lastShow=0; n.gapN=0; n.gapMax=0; n.under=false; n.keyWait=0; n.m2bad=0; n.m2err=0; n.aLateN=0; n.aDry=0; n.aDryT=0; n.gapWhy=''; n.vd=[]; n.vdelay=0; n.dmx?.pidN.clear();
  try{ n.ad?.close(); }catch(e){}
  n.ad=null; n.adKey='';
  n.dec=null; n.decCodec=''; n.needKey=true; n.lastTs=-1;
  for(const f of n.q||[]) try{ f.close(); }catch(e){}
  n.q=[]; n.base=null;
}
function tsvClose(n){ tsvReset(n); n.fileObj=null; }

// режимы декодера H.264 по кругу после ошибок: аппаратный / программный с любым I-кадром, затем те же только с IDR
const TSV_MODES=[{sw:false,idr:false},{sw:true,idr:false},{sw:false,idr:true},{sw:true,idr:true}];
function tsvMode(n){ return TSV_MODES[(n.mode||0)%4]; }
function tsvNextMode(n,why){
  const ok=n.decoded>(n.decodedAt||0);                          // режим уже давал кадры: ошибка от потерь, режим не меняем
  if(ok){ try{ localStorage.tsvMode=n.mode||0; }catch(e){} }
  else n.mode=((n.mode||0)+1)%4;
  n.modeAt=performance.now(); n.needKey=true;
  try{ n.dec?.close(); }catch(e){}
  n.dec=null; n.decCodec='';
  const m=tsvMode(n);
  n.notes.push(why+(ok ? ' (mode kept) → ' : ' → ')+(m.sw ? 'software' : 'hardware')+' decoder, '+(m.idr ? 'IDR only' : 'any I frame')); if(n.notes.length>4) n.notes.shift();
}
async function tsvConfigure(n,codec,type){
  if(typeof VideoDecoder==='undefined'){ n.status='WebCodecs is not available in this browser'; return false; }
  const sp=n.dmx.sps, big=!!(sp && type==='avc' && sp.mbs>tsAvcMaxFs(sp.level));   // кадр больше предела уровня: аппаратный декодер откажет
  if(big && !n.bigNote){ n.bigNote=true; n.notes.push('frame '+sp.w+'×'+sp.h+' exceeds level '+(sp.level/10)+' limit → software decoder'); if(n.notes.length>4) n.notes.shift(); }
  const sw=tsvMode(n).sw || big;
  let cfg={codec, optimizeForLatency:true};
  if(sw) cfg.hardwareAcceleration='prefer-software';
  if(type==='hevc') cfg.hevc={format:'annexb'};
  if(type==='avc') cfg.avc={format:'annexb'};                  // кадры идут с начальными кодами, без описания AVCC
  let sup=null;
  try{ sup=await VideoDecoder.isConfigSupported(cfg); }catch(e){}
  if(!sup?.supported && type==='avc'){                          // старые версии браузера: Annex B подразумевался без описания
    cfg={codec, optimizeForLatency:true}; if(sw) cfg.hardwareAcceleration='prefer-software';
    try{ sup=await VideoDecoder.isConfigSupported(cfg); }catch(e){}
  }
  if(!sup?.supported){ n.status='codec '+codec+' is not supported by the browser'; return false; }
  try{ n.dec?.close(); }catch(e){}
  const dec=new VideoDecoder({
    output:f=>{ if(n.dec!==dec){ f.close(); return; } n.q.push(f); if(++n.decoded===(n.decodedAt||0)+1){ try{ localStorage.tsvMode=n.mode||0; }catch(e){} } },
    error:e=>{
      if(n.dec!==dec) return;                                   // ошибки уже заменённого декодера не в счёт
      const k=n.lastKey;
      n.status='decoder: '+e.message+(k ? ' (entry point '+(k.idr ? 'IDR' : 'I slice')+', '+k.size+' bytes, NAL types '+k.nals.join(',')+')' : '');
      if(k) console.log('TS → Video decoder error:',e.message,'\nSPS',JSON.stringify(n.dmx.sps),'\nentry point',k.idr ? 'IDR' : 'I slice',k.size,'bytes'+(k.pes ? ' (PES length declared/actual '+k.pes+')' : '')+', NAL types',k.nals.join(','),'\ncodec',codec,'mode',JSON.stringify(tsvMode(n)),'\nstart',k.hex);
      n.errN=(n.errN||0)+1; tsvNextMode(n,'decoder error'+(n.lossAt!=null ? ' ('+((n.fed||0)-n.lossAt)+' frames after the last loss)' : ''));
    }});
  dec.configure(cfg);
  n.dec=dec; n.decCodec=codec; n.needKey=true; n.modeAt=performance.now(); n.decodedAt=n.decoded;
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
/* ---- звук AAC (ADTS): WebCodecs AudioDecoder → тот же путь сегментов ---- */
function tsvAacOut(n,ad,data){
  if(n.ad!==ad){ data.close(); return; }
  const cnt=data.numberOfFrames, rate=data.sampleRate, nc=Math.min(2,data.numberOfChannels);
  const pl=[]; for(let c=0;c<nc;c++){ const f=new Float32Array(cnt); data.copyTo(f,{planeIndex:c,format:'f32-planar'}); pl.push(f); }
  const t0=data.timestamp/1e6; data.close();
  if(cnt<2) return;
  const sr=Eng.sr, k=rate/sr, m=Math.floor((cnt-1)/k);
  const L=new Float32Array(m), R=new Float32Array(m), A=pl[0], B=pl[nc-1];
  for(let i=0;i<m;i++){ const p=i*k, j=p|0, f=p-j, j1=Math.min(j+1,cnt-1); L[i]=A[j]*(1-f)+A[j1]*f; R[i]=B[j]*(1-f)+B[j1]*f; }
  let t=t0;
  if(n.aEnd!=null && Math.abs(t-n.aEnd)<.1) t=n.aEnd;
  n.aEnd=t+m/sr;
  n.aq.push({t0:t, i:0, L, R});
  while(n.aq.length>200) n.aq.shift();
}
function tsvAac(n,a){
  if(typeof AudioDecoder==='undefined'){ n.aInfo='AudioDecoder is not available in this browser'; return; }
  const fr=tsAdtsSplit(a.d);
  for(const f of fr){
    const key=f.sr+'/'+f.ch;
    if(!n.ad || n.adKey!==key){
      try{ n.ad?.close(); }catch(e){}
      const ad=new AudioDecoder({output:d=>tsvAacOut(n,ad,d), error:e=>{ if(n.ad===ad){ n.aInfo='AAC: '+e.message; n.ad=null; } }});
      try{ ad.configure({codec:'mp4a.40.2', sampleRate:f.sr, numberOfChannels:f.ch, description:f.asc}); }
      catch(e){ n.aInfo='AAC: '+e.message; return; }
      n.ad=ad; n.adKey=key; n.aEnd=null;
    }
    if(a.pts<0 || n.ad.decodeQueueSize>60) continue;
    n.aInfo='AAC · '+f.sr+' Hz · '+f.ch+' ch';
    try{ n.ad.decode(new EncodedAudioChunk({type:'key', timestamp:Math.round((a.pts+f.dt)*1e6), data:f.d})); }catch(e){ n.aInfo='AAC: '+e.message; n.ad=null; return; }
  }
}
function tsvAudio(n,a){
  if(a.type==='aac'){ tsvAac(n,a); return; }
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
  let o=0, wait=false, skip=0, late=0;
  while(o<B){
    const sg=n.aq[0];
    if(!sg) break;
    const d=sg.t0+sg.i/sr-target-o/sr;
    n.aOff=d;
    if(d>.08){ wait=true; break; }
    if(d<-.08){ late=Math.max(late,-d); n.aHeadD=d; const k=Math.ceil(-d*sr); skip+=k; sg.i+=k; if(sg.i>=sg.L.length) n.aq.shift(); continue; }
    const c=Math.min(B-o,sg.L.length-sg.i);
    for(let i=0;i<c;i++){ oL[o+i]=sg.L[sg.i+i]*g; oR[o+i]=sg.R[sg.i+i]*g; }
    sg.i+=c; o+=c; n.aPlayed=(n.aPlayed||0)+c;
    if(sg.i>=sg.L.length) n.aq.shift();
  }
  // звук приходит позже своего кадра (в мультиплексе видео опережает звук): держать закодированное видео перед декодером, чтобы звук шёл впереди; сдвигать звук нельзя — губы разойдутся
  if(late>.15 && late<2.5 && (n.vdelay||0)<3){ if(++n.aLateN>sr/B*.3){ n.vdelay=Math.min(3,(n.vdelay||0)+late); n.aLateN=0; } }
  else if(o>0) n.aLateN=0;                                       // пустая очередь звука счётчик не сбрасывает: звук идёт порциями
  // очередь звука пересохла посреди воспроизведения: звук идёт впритык, дать ему запас задержкой видео
  if(!wait && !skip && o<B && (n.aPlayed||0)>sr*2){
    const t=performance.now();
    if(t-(n.aDryT||0)>2000){ n.aDryT=t; n.aDry=0; }
    if(++n.aDry>=3 && (n.vdelay||0)<2.5){ n.vdelay=Math.min(2.5,(n.vdelay||0)+.2); n.aDry=0; n.aDryT=t; }
  }
  // звук стабильно не совпадает с часами видео (другая отметка времени, разрыв): сдвинуть его, а не молчать
  if(wait || skip>B/2){ n.aBad=(n.aBad||0)+1; if(n.aBad>sr/B*1.5){ const sg=n.aq[0], dd=sg ? sg.t0+sg.i/sr-target : n.aHeadD||0;   // очередь могла опустеть: берём смещение последнего пропущенного сегмента
      if(Math.abs(dd)>2.5){ n.aSh=(n.aSh||0)+dd; n.aResync=(n.aResync||0)+1; n.vdelay=0; }   // меньшее смещение — не рассинхрон часов: опоздание закрывает задержка видео, а сдвиг звука сломал бы синхронизацию по PTS
      n.aBad=0; n.aHeadD=0; } }
  else if(o>=B) n.aBad=0;
}

function tsvFeed(n,bytes){
  const dm=n.dmx;
  dm.push(bytes);
  const fr=dm.takeVideo();
  for(const a of dm.takeAudio()) tsvAudio(n,a);
  for(const t of dm.takeTtx()) n.tt.feed(t);
  if(dm.lostVideo){ dm.lostVideo=false; n.lossAt=n.fed||0; if(n.p.strict && dm.cur?.vtype!=='mpeg2') n.needKey=true; }
  for(const f of fr){
    n.fed=(n.fed||0)+1;
    const type=dm.cur?.vtype;
    if(!dm.vcodec || !type) continue;
    if(type==='mpeg2'){ tsvM2(n,f); continue; }
    n.vd.push(f);
  }
  tsvVdRelease(n);
}
// закодированные кадры ждут перед декодером на n.vdelay секунд: звук, идущий в мультиплексе позади видео, успевает к своему времени
function tsvVdRelease(n){
  const d=n.vdelay||0;
  while(n.vd.length){
    const a=n.vd[0], b=n.vd[n.vd.length-1];
    if(d>0 && a.pts>=0 && b.pts>=a.pts && b.pts-a.pts<d && n.vd.length<d*60) break;   // разрыв PTS (b<a): не держать
    if(!tsvDecodeFrame(n,a)) break;
    n.vd.shift();
  }
}
// false — кадр не взят (ждём настройки декодера)
function tsvDecodeFrame(n,f){
  const dm=n.dmx, type=dm.cur?.vtype;
  if(!dm.vcodec || !type) return true;
  const entry= tsvMode(n).idr ? f.idr : f.key;                // подходит ли кадр как точка входа в нынешнем режиме
  if(n.needKey && tsvMode(n).idr){ if(++n.keyWait>300 && performance.now()-n.modeAt>15000){ tsvNextMode(n,'no IDR frame in 15 s'); return true; } }
  else n.keyWait=0;
  if(!n.dec || n.decCodec!==dm.vcodec){
    if(n.cfgBusy) return false;
    if(!entry) return true;
    n.cfgBusy=true;
    tsvConfigure(n,dm.vcodec,type).then(()=>{ n.cfgBusy=false; });
    return true;                                             // этот кадр пропускаем, ждём следующий ключевой
  }
  if(n.needKey && !entry) return true;
  if(n.dec.decodeQueueSize>40){ n.needKey=true; n.dropped++; return true; }
  if(n.needKey && f.key) n.lastKey={idr:f.idr, pes:f.pes, size:f.d.length, nals:f.nals||[], hex:Array.from(f.d.subarray(0,64),v=>v.toString(16).padStart(2,'0')).join(' ')};
  n.needKey=false;
  let ts=f.pts>=0 ? Math.round(f.pts*1e6) : (n.lastTs>=0 ? n.lastTs+40000 : 0);
  n.lastTs=ts;
  try{ n.dec.decode(new EncodedVideoChunk({type:f.key ? 'key' : 'delta', timestamp:ts, data:f.d})); }
  catch(e){ n.status='decode: '+e.message; tsvNextMode(n,'decode() failed'); }
  return true;
}

// Выдать кадр, которому пора: остальные просроченные закрываются
function tsvPresent(n){
  const q=n.q, now=performance.now();
  if(!q.length){
    if(n.base!=null && n.lastShow && now-n.lastShow>150 && !n.under){
      n.under=true;
      n.whyEmpty='input '+(n.inqLen/1e6).toFixed(1)+' MB, decoder queue '+(n.dec ? n.dec.decodeQueueSize : 'none')+', held '+n.vd.length+' frames'+(n.needKey ? ', waiting for an entry point' : '');
    }
    return;
  }
  const cap=q[0].rgba ? 24 : 40;
  if(n.under){                                                  // очередь опустела: накопить кадры и взять часы заново, не догонять просроченные
    if((q[q.length-1].timestamp-q[0].timestamp)<3e5 && q.length<12 && now-n.lastShow<2000) return;
    n.under=false; n.base=null;
  }
  else if(n.base!=null && (q[0].timestamp-n.ts0)/1000-(now-n.wall0)>1500+(+n.p.delay||0)) n.base=null;  // скачок PTS вперёд
  if(n.base==null || q.length>cap){ n.ts0=q[0].timestamp; n.wall0=now+(+n.p.delay||0); n.base=1; n.aSh=0; while(q.length>cap) q.shift().close(); }
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
  if(n.lastShow){ const g=now-n.lastShow; if(g>120){ n.gapN=(n.gapN||0)+1; if(g>(n.gapMax||0)){ n.gapMax=g; n.gapWhy=n.whyEmpty||''; } } }
  n.lastShow=now;
  n.shown++; n.fpsN++; n.gotFrame=true;
}

// Вход bin приходит порциями (сегмент HLS — несколько секунд сразу): отдаём демуксу по куску, пока есть место в очередях кадров и звука
function tsvRoom(n){
  if(n.q.length+(n.dec?.decodeQueueSize||0)>=(n.dmx.cur?.vtype==='mpeg2' ? 8 : 24)) return false;
  let a=0; for(const g of n.aq) a+=g.L.length-g.i;
  if(a<Eng.sr*3) return true;
  if(Math.abs(n.aOff||0)>10){ n.aq=[]; n.aEnd=null; n.aOff=0; return true; }   // звук далеко от часов видео и не играет: выбросить, не держать подачу видео
  return false;
}
function tsvPumpIn(n){
  const t0=performance.now();                                    // живой поток DVB ~4.5 МБ/с: кусок за вызов не успевает, кормим по бюджету времени
  for(let k=0;k<64 && n.inq.length && performance.now()-t0<4 && tsvRoom(n);k++){
    const c=n.inq[0], take=Math.min(c.length,188*128);
    tsvFeed(n,c.subarray(0,take)); n.inqLen-=take;
    if(take>=c.length) n.inq.shift(); else n.inq[0]=c.subarray(take);
  }
  if(n.inqLen>24e6){                                              // потребитель отстал совсем: старое выбросить, ждать ключевой кадр
    while(n.inqLen>8e6 && n.inq.length>1) n.inqLen-=n.inq.shift().length;
    n.needKey=true; n.dropped++;
  }
}

// Каналы потока (SDT + PMT + NIT + EIT) → строки для узла Table
const TSV_RUN=['','not running','starts soon','paused','running','off air'];
function tsvChannels(n){
  const d=n.dmx, now=performance.now();
  if(!n.rate0) n.rate0=now;
  const sec=Math.max((now-n.rate0)/1000,1);
  const rows=[], ids=new Set([...d.programs.keys(),...d.svc.keys()]);
  for(const sid of [...ids].sort((a,b)=>a-b)){
    const pr=d.programs.get(sid), sv=d.svc.get(sid);
    if(!pr && !sv) continue;
    const ev=d.events.get(sid), cur=ev ? [...ev.values()] : [];
    const nowE=cur.find(e=>e.pf==='now'), nextE=cur.find(e=>e.pf==='next');
    let bits=0; if(pr) for(const e of pr.es||[]) bits+=(d.pidN.get(e.pid)||0)*188*8;
    const vid=pr?.es?.find(e=>e.pid===pr.vpid);
    const aud=(pr?.es||[]).filter(e=>/MP2|AAC|AC-3|DTS/.test(e.name)).map(e=>e.name+(e.lang ? ' '+e.lang : ''));
    const sub=(pr?.es||[]).filter(e=>e.name==='subtitles' || e.name==='teletext').map(e=>e.name+(e.lang ? ' '+e.lang : ''));
    rows.push({
      lcn:d.net.lcn.get(sid)||'', program:sid, name:sv?.name||'', type:sv ? (TS_SVC_TYPES[sv.type]||('type '+sv.type)) : (vid ? 'TV' : 'Radio'),
      scrambled:sv?.ca ? 'yes' : '', video:vid ? vid.name+(pr===d.cur && d.sps ? ' '+d.sps.w+'×'+d.sps.h : '') : '', audio:aud.join(', '),
      extra:sub.join(', '), mbit:+(bits/sec/1e6).toFixed(1), now:nowE?.name||'', until:nowE ? tsvEvEnd(nowE) : '', next:nextE?.name||'',
      provider:sv?.provider||'', playing:pr && pr===d.cur ? '▶' : '', id:'c'+sid });
  }
  rows.sort((a,b)=>(+a.lcn||9999)-(+b.lcn||9999) || a.program-b.program);
  // телепрограмма: события всех служб
  const evs=[];
  for(const [sid,m] of d.events){
    const sv=d.svc.get(sid);
    for(const e of m.values()) if(e.name) evs.push({lcn:d.net.lcn.get(sid)||'', program:sid, channel:sv?.name||'', start:tsvLocal(e.ms), min:e.min, title:e.name, text:e.text, state:e.pf||(TSV_RUN[e.run]||''), id:'e'+sid+'/'+e.id, ms:e.ms});
  }
  evs.sort((a,b)=>a.program-b.program || a.ms-b.ms);
  for(const e of evs) delete e.ms;
  // одна таблица: канал, под ним его передачи. Строки заменяются только при смене содержимого (битрейт не в счёт), иначе таблица мигает
  const all=[];
  const by=new Map(); for(const e of evs){ if(!by.has(e.program)) by.set(e.program,[]); by.get(e.program).push(e); }
  for(const r of rows){ all.push({id:r.id,kind:'channel',...r}); for(const e of by.get(r.program)||[]) all.push({id:e.id,kind:'event',...e}); }
  for(const [sid,l] of by) if(!rows.some(r=>r.program===sid)) for(const e of l) all.push({id:e.id,kind:'event',...e});
  const pub=(key,list,min)=>{
    const j=JSON.stringify(list,(k,v)=>k==='mbit' ? undefined : v);
    const mb=list.map(r=>r.mbit).join();
    if(j!==n[key+'J'] || (mb!==n[key+'M'] && now-(n[key+'T']||0)>20000)){
      if(now-(n[key+'T']||0)<min && n[key+'J']) return;
      n[key+'J']=j; n[key+'M']=mb; n[key+'T']=now; n[key+'R']=list;
    }
  };
  // мультиплексы сети (NIT) → строки для плана диапазонов (кГц)
  const mux=d.net.freqs.slice().sort((a,b)=>a.mhz-b.mhz).map(f=>({id:'m'+f.mhz.toFixed(2), name:(f.t2 ? 'DVB-T2' : 'DVB-T')+' mux '+f.mhz.toFixed(2)+' MHz', lo:Math.round((f.mhz-4)*1000), hi:Math.round((f.mhz+4)*1000), step:0, color:'', kind:'TV', note:'from the NIT of '+(d.net.name||'the stream')+(f.tsid ? ', TS '+f.tsid : '')}));
  pub('mux',mux,5000);
  pub('chan',rows,5000); pub('epg',evs,10000); pub('all',all,10000);
  // сеть и время
  const L=[];
  if(d.net.name) L.push('network '+d.net.name+(d.net.id ? ' ('+d.net.id+')' : ''));
  if(d.utc) L.push('time '+d.utc.str+' UTC'+(d.offMin!=null ? ' (local '+(d.offMin>=0 ? '+' : '')+d.offMin/60+' h)' : ''));
  if(d.net.freqs.length) L.push('muxes in NIT: '+d.net.freqs.map(f=>f.mhz.toFixed(2)+' MHz').join(', '));
  L.push('services '+rows.length+(d.sdtDone ? '' : ' (names not received yet)'));
  n.infoTxt=L.join('\n');
}
function tsvLocal(ms){
  const d=new Date(ms), p=v=>(v<10 ? '0' : '')+v;
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes());
}
function tsvEvEnd(e){ return tsvLocal(e.ms+e.min*60000).slice(11); }

// Телетекст: страница → картинка 40×25 клеток и текст
const TTX_COL=['#000','#f22','#2e2','#ee2','#35f','#e3e','#2ee','#fff'];
function tsvTtxCyr(n){
  const m=n.p.ttxcs;
  if(m==='cyrillic') return true;
  if(m==='latin') return false;
  const es=n.dmx.cur?.es?.find(e=>e.pid===n.dmx.cur.tpid);
  return /^(rus|ukr|bul|bgr|bel|srp|scc|mkd|mac)$/.test(es?.lang||'');
}
function tsvTtxStep(n,d){
  const l=n.tt.list(); if(!l.length) return;
  let c=+n.p.ttxpage||100, i=d>0 ? l.findIndex(x=>x>c) : l.length-1-[...l].reverse().findIndex(x=>x<c);
  if(d>0 && i<0) i=0;
  if(d<0 && (i<0 || i>=l.length || l[i]>=c)) i=l.length-1;
  setMod(n,'ttxpage',l[i]);
}
function tsvTtx(n){
  const pg=+n.p.ttxpage||100, cyr=tsvTtxCyr(n), key=pg+'/'+cyr;
  if(n.tt.rev===n.ttRev && key===n.ttKey) return;
  n.ttRev=n.tt.rev; n.ttKey=key;
  const g=n.tt.render(pg,cyr), cx=n.tpicCx, cw=12, ch=20;
  cx.fillStyle='#000'; cx.fillRect(0,0,480,500);
  n.ttHas=!!g;
  if(!g){
    cx.fillStyle='#888'; cx.font='16px monospace'; cx.textAlign='left'; cx.textBaseline='top';
    cx.fillText(n.tt.list().length ? 'page '+pg+' not received yet' : 'waiting for teletext…',12,12);
    n.ttText=''; return;
  }
  cx.textAlign='center'; cx.textBaseline='middle';
  for(let r=0;r<25;r++) for(let k=0;k<40;k++){
    const c=g[r][k]; if(c.lower) continue;
    const x=k*cw, y=r*ch, hh=c.h ? ch*2 : ch;
    cx.fillStyle=TTX_COL[c.bg]; cx.fillRect(x,y,cw,hh);
    if(c.m){
      cx.fillStyle=TTX_COL[c.fg];
      const sw=cw/2, sh=hh/3, ins=c.m===2 ? 1 : 0;
      for(let b=0;b<6;b++) if(c.c&(1<<b)) cx.fillRect(x+(b&1)*sw+ins,y+(b>>1)*sh+ins,sw-ins,sh-ins);
    }else if(c.c>0x20){
      cx.fillStyle=TTX_COL[c.fg]; cx.font='bold 17px monospace';
      if(c.h){ cx.save(); cx.translate(x+cw/2,y+ch); cx.scale(1,2); cx.fillText(String.fromCharCode(c.c),0,0); cx.restore(); }
      else cx.fillText(String.fromCharCode(c.c),x+cw/2,y+ch/2+1);
    }
  }
  n.ttText=n.tt.text(pg,cyr);
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
  ins:[{n:'bin',t:'bin'},{n:'prog',t:'val'},{n:'page',t:'num'}], outs:[{n:'vid',t:'vid'},{n:'L',t:'sig'},{n:'R',t:'sig'},{n:'lock',t:'num'},{n:'fps',t:'num'},{n:'ttx',t:'vid'},{n:'ttxt',t:'txt'},{n:'mux',t:'bands'},{n:'all',t:'bands'},{n:'chan',t:'bands'},{n:'epg',t:'bands'},{n:'info',t:'txt'}],
  params:[{n:'file',t:'file',accept:'.ts,.m2ts,.mts,video/mp2t',fn:(n,f)=>{
            tsvReset(n); n.dmx.reset(); n.fileObj=f; n.pos=0; n.status='file '+f.name; }},
          {n:'loop',t:'check',d:true,label:'loop the file'},
          {n:'program',t:'num',d:0,label:'program number (0 — first with video)'},
          {n:'delay',t:'range',min:0,max:2000,step:50,d:400,label:'buffer, ms (a live stream needs more)'},
          {n:'strict',t:'check',d:false,label:'after lost packets wait for the next entry point (no artifacts, but freezes)'},
          {n:'show',t:'select',opts:['video','teletext'],d:'video',label:'node window shows'},
          {n:'ttxpage',t:'num',d:100,min:100,max:899,step:1,label:'teletext page (100–899)'},
          {n:'ttxprev',t:'button',label:'◀ Teletext page',fn:n=>tsvTtxStep(n,-1)},
          {n:'ttxnext',t:'button',label:'Teletext page ▶',fn:n=>tsvTtxStep(n,1)},
          {n:'ttxcs',t:'select',opts:['auto','latin','cyrillic'],d:'auto',label:'teletext characters (auto: by the language of the stream)'},
          {n:'volume',t:'range',min:0,max:2,step:.01,d:1,label:'volume'},
          {n:'avsync',t:'range',min:-500,max:500,step:10,d:0,label:'audio delay, ms (positive — later)'},
          {n:'reset',t:'button',label:'Reset',fn:n=>{ tsvReset(n); n.dmx.reset(); n.pos=0; n.status='reset'; }}],
  view:{h:220}, resize:true, w:380,
  init(n){
    n.dmx=new TsDemux(); n.inq=[]; n.inqLen=0; n.q=[]; n.fileObj=null; n.pos=0; n.rd=false; n.dec=null; n.decCodec=''; n.cfgBusy=false;
    n.needKey=true; n.lastTs=-1; n.base=null; n.last=null; n.status='waiting for a transport stream'; n.notes=[]; n.mode=(()=>{ try{ return (+localStorage.tsvMode||0)%4; }catch(e){ return 0; } })(); n.modeAt=performance.now(); n.errN=0;
    n.aq=[]; n.aEnd=null; n.vd=[]; n.vdelay=0; n.aLateN=0; n.aInfo=''; n.decoded=0; n.m2=null; n.m2p=null; n.m2err=0; n.m2bad=0; n.shown=0; n.dropped=0; n.fpsN=0; n.fps=0; n.fpsT=performance.now(); n.tkN=0; n.tkMax=0; n.tkShow=0; n.gotFrame=false; n.prog=0;
    n.pic=document.createElement('canvas'); n.picCx=n.pic.getContext('2d');
    n.tt=new TsTeletext(); n.tpic=document.createElement('canvas'); n.tpic.width=480; n.tpic.height=500; n.tpicCx=n.tpic.getContext('2d'); n.ttRev=-1; n.ttKey=''; n.ttHas=false; n.ttText='';
    Object.defineProperty(n.tpic,'videoWidth',{get(){ return this.width; }});
    Object.defineProperty(n.tpic,'videoHeight',{get(){ return this.height; }});
    // у <video> есть videoWidth / videoHeight, их ждут потребители vid
    Object.defineProperty(n.pic,'videoWidth',{get(){ return this.width; }});
    Object.defineProperty(n.pic,'videoHeight',{get(){ return this.height; }});
  },
  dispose:n=>{ tsvClose(n); },
  process(n,I){
    const t00=performance.now();
    const o=I.bin;
    if(o && o.d && o!==n.last){
      if(o.stream!==undefined && o.stream!==n.srcStream){         // источник открыл другой поток (смена канала): начать с чистого состояния, как по кнопке Reset
        n.srcStream=o.stream; tsvReset(n); n.tt.reset(); n.ttRev=-1; n.dmx.reset(); n.dmx.select(+n.p.program|0); n.pos=0;
      }
      n.last=o; n.inq.push(o.d); n.inqLen+=o.d.length;
    }
    tsvPumpIn(n);
    if(I.prog!==undefined && I.prog!==n._inProg){                   // номер программы, её название или строка таблицы
      n._inProg=I.prog;
      let v=typeof I.prog==='number' ? I.prog : /^\s*\d+\s*$/.test(String(I.prog)) ? +I.prog : 0;
      if(!v && typeof I.prog==='string' && I.prog){ const q=I.prog.toLowerCase(); for(const x of n.dmx.svc.values()) if(x.name.toLowerCase().includes(q)){ v=x.sid; break; } }
      if(v>0) setMod(n,'program',Math.round(v));
    }
    if(typeof I.page==='number' && I.page>=100 && I.page!==n._inPage){ n._inPage=I.page; setMod(n,'ttxpage',Math.round(I.page)); }
    const pr=+n.p.program|0;
    if(pr!==n.prog){ n.prog=pr; tsvReset(n); n.tt.reset(); n.ttRev=-1; n.dmx.select(pr); n.dmx.vcodec=''; n.dmx.sps=null; }
    tsvPump(n);
    tsvPresent(n);
    if(performance.now()-(n.ttT||0)>250){ n.ttT=performance.now(); tsvTtx(n); }
    if(performance.now()-(n.chanT||0)>1500){ n.chanT=performance.now(); tsvChannels(n); }
    const now=performance.now();
    if(now-n.fpsT>=1000){ n.fps=n.fpsN*1000/(now-n.fpsT); n.fpsN=0; const cc=n.dmx.stat.cc+n.dmx.stat.tei; n.ccRate=(cc-(n.ccPrev||0))*1000/(now-n.fpsT); n.ccPrev=cc; n.fpsT=now; if(++n.tkN>=5){ n.tkN=0; n.tkShow=n.tkMax||0; n.tkMax=0; } if(n.fps===0) n.gotFrame=false; }
    const tk=performance.now()-t00; if(tk>(n.tkMax||0)) n.tkMax=tk;
    const oL=buf(n,'L'), oR=buf(n,'R'); oL.fill(0); oR.fill(0);
    if(n.base==null && n.aq.length){                              // видео нет: часы по звуку, чтобы он шёл без картинки
      n.aNoV=(n.aNoV||0)+1;
      if(n.aNoV>60){ n.ts0=n.aq[0].t0*1e6; n.wall0=now+(+n.p.delay||0); n.base=1; n.aSh=0; n.aNoV=0; }
    }
    if(n.base!=null && n.aq.length) tsvAudioRead(n,oL,oR,n.ts0/1e6+(now-n.wall0)/1000-(+n.p.avsync||0)/1000+(n.aSh||0),+n.p.volume);
    return {vid:n.gotFrame && n.pic.width ? n.pic : null, L:oL, R:oR, lock:n.gotFrame ? 1 : 0, fps:n.fps, ttx:n.ttHas ? n.tpic : null, ttxt:n.ttText||'', mux:n.muxR||null, chan:n.chanR||null, epg:n.epgR||null, all:n.allR||null, info:n.infoTxt||''}; },
  draw(n,cv,cx){
    const r=n.el.querySelector('.readout');
    if(r){
      const d=n.dmx, st=d.stat, pl=d.list();
      let t=n.status;
      if(n.m2err) t=TSV_M2ERR[n.m2err]||('MPEG-2 error '+n.m2err);
      if(pl.length) t='programs '+pl.map(p=>p.num+(p===d.cur ? '▶' : '')).join(' ')+' · '+(d.vcodec||'—')+(d.sps ? ' · '+d.sps.w+'×'+d.sps.h : '')+
        ' · '+n.fps.toFixed(1)+' fps'+(d.cur?.apid ? ' · audio '+d.cur.atype+(d.cur.atype==='mp2' || d.cur.atype==='aac' ? (n.aInfo ? ' · '+n.aInfo : '') : ' (not decoded)') : '');
      if(st.cc||st.tei||st.scr||n.dropped||n.m2bad) t+='\nlost packets '+st.cc+(st.scr ? ' · scrambled packets '+st.scr+' (encrypted, dropped)' : '')+' (now '+Math.round(n.ccRate||0)+'/s) · transport errors '+st.tei+(st.sync ? ' · stream breaks '+st.sync+(()=>{ const e=Object.entries(st.gaps).sort((x,y)=>y[1]-x[1])[0]; return e ? ' (usually '+e[0]+' extra bytes ×'+e[1]+')' : ''; })() : '')+(n.dropped ? ' · dropped frames '+n.dropped : '')+(n.m2bad ? ' · bad slices '+n.m2bad : '');
      if(pl.length) t+='\nvideo frames '+st.frames+' (entry points '+st.keys+') · decoded '+n.decoded+' · shown '+n.shown+(n.inqLen>0 ? ' · input queue '+(n.inqLen/1e6).toFixed(1)+' MB' : '')+(n.dec ? ' · decoder queue '+n.dec.decodeQueueSize : n.decCodec ? '' : ' · decoder not started')+(n.needKey ? ' · waiting for an entry point' : '')+' · '+(tsvMode(n).sw || n.bigNote ? 'software' : 'hardware')+' decoder, '+(tsvMode(n).idr ? 'IDR only' : 'any I frame')+' (IDR frames in the stream '+st.idr+')'+(n.gapN ? '\npicture pauses >120 ms: '+n.gapN+' (longest '+Math.round(n.gapMax)+' ms'+(n.gapWhy ? ': '+n.gapWhy : '')+') · buffer '+n.q.length+' frames' : '')+(n.tkShow>20 ? '\nslowest node tick in 5 s: '+Math.round(n.tkShow)+' ms' : '')+(n.notes.length ? '\n'+n.notes.join('\n') : '');
      if(pl.length && d.cur?.apid) t+='\naudio PES '+(st.apes||0)+' · queued '+(n.aq.reduce((a,g)=>a+(g.L.length-g.i),0)/Eng.sr).toFixed(2)+' s · played '+((n.aPlayed||0)/Eng.sr).toFixed(1)+' s · offset to video '+Math.round((n.aOff||0)*1000)+' ms · resyncs '+(n.aResync||0)+(n.vdelay ? ' · video held '+Math.round(n.vdelay*1000)+' ms' : '')+(n.base==null ? ' · no video clock' : '');
      if(pl.length && n.infoTxt) t+='\n'+n.infoTxt;
      if(n.tt.list().length) t+='\nteletext: '+n.tt.list().length+' pages ('+n.tt.list().slice(0,12).join(' ')+(n.tt.list().length>12 ? ' …' : '')+'), shown '+(+n.p.ttxpage||100);
      if(n.status && pl.length && !n.gotFrame) t+='\n'+n.status;
      if(r.textContent!==t) r.textContent=t;
    }
    const pic= n.p.show==='teletext' ? n.tpic : n.pic;
    if(!pic.width || !cv) return;
    cx.fillStyle='#000'; cx.fillRect(0,0,cv.width,cv.height);
    const k=Math.min(cv.width/pic.width,cv.height/pic.height), w=pic.width*k, h=pic.height*k;
    cx.drawImage(pic,(cv.width-w)/2,(cv.height-h)/2,w,h); }
});
