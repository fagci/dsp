"use strict";
/* ============================ Голос и видео в пакетах ============================
   Voice → Packets / Packets → Voice и Video → Packets / Packets → Video превращают звук и картинку в сообщения провода bin и обратно.
   Везти их может любой канал, который умеет bin: Sync Data (между своими устройствами), MQTT, Packet Link, а через Bytes → Frames
   и модем — радио. Звук: Codec 2 (1,6 и 3,2 кбит/с — для радио), Opus (WebCodecs; конференция) или μ-law (работает везде).
   Формат единицы и jitter-буфер — media-kernels.js. */

const MV_CODECS=[
  {n:'Codec 2 1600 (radio, 1.6 kbit/s)',id:MD_CODEC.c2_1600,mode:1600,spf:320,fpp:3},
  {n:'Codec 2 3200 (3.2 kbit/s)',id:MD_CODEC.c2_3200,mode:3200,spf:160,fpp:3},
  {n:'Opus (WebCodecs, 6–32 kbit/s)',id:MD_CODEC.opus,spf:960,fpp:3},
  {n:'μ-law (64 kbit/s, any browser)',id:MD_CODEC.ulaw,spf:160,fpp:3},
];
const mvByName=s=>MV_CODECS.find(c=>c.n===s)||MV_CODECS[0];
const mvOpusOk=()=>typeof AudioEncoder!=='undefined' && typeof AudioDecoder!=='undefined' && typeof AudioData!=='undefined';
// единица → то, что уходит в провод: сообщение как есть или с обрамлением для байтового канала (Packet Link разбирает тем же frame)
const MV_WRAP={n:'wrap',t:'select',opts:MD_WRAPS,d:MD_WRAPS[0],label:'framing for a byte stream (serial radio modem, KISS TNC, BLE UART): the same as «frame» in Packet Link; none — one message per packet'};
const mvDb=pcm=>{ let e=0; for(let i=0;i<pcm.length;i++) e+=pcm[i]*pcm[i]; return 10*Math.log10(e/pcm.length/1073741824+1e-12); };   // int16 → dBFS

/* ---------- Voice → Packets ---------- */
def({ id:'voiceTx', title:'Voice → Packets', cat:'Protocols', kw:'voice audio packets codec2 opus ulaw encoder radio conference bin send microphone', readout:true,
  ins:[{n:'in',t:'sig'},{n:'ptt',t:'num'}], outs:[{n:'bin',t:'bin'},{n:'active',t:'num'},{n:'kbps',t:'num'},{n:'new',t:'num'}],
  params:[{n:'label',t:'text',d:'voice',label:'stream name (the receiving Packets → Voice takes the same)'},
          {n:'codec',t:'select',opts:MV_CODECS.map(c=>c.n),d:MV_CODECS[0].n,label:'codec'},
          {n:'kbps',t:'range',min:6,max:32,step:1,d:16,label:'Opus bit rate, kbit/s'},
          {n:'fpp',t:'range',min:1,max:8,step:1,d:3,label:'frames per packet (fewer — less delay, more header overhead)'},
          {n:'gate',t:'range',min:-80,max:-20,step:1,d:-80,label:'send only above, dBFS (−80 — always; the pauses of speech cost nothing)'},
          {n:'gain',t:'range',min:-30,max:30,step:1,d:0,label:'input gain, dB (0 dB: ±1 → ±24000)'}, MV_WRAP],
  init:n=>{ n.key=''; n.h=-1; n.rs=null; n.pcm=[]; n.frames=[]; n.seq=0; n.q=[]; n.out=null; n.pulse=0; n.hang=0; n.sent=0; n.bytes=0; n.bw=[]; n.enc=null; n.ts=0; n.text='…'; c2Load(); },
  dispose(n){ if(n.h>=0 && C2.ex) C2.ex.c2_free(n.h); try{ n.enc?.close(); }catch(e){} },
  process(n,I){
    const c=mvByName(n.p.codec), sr=Eng.sr, rate=MD_INFO[c.id].rate;
    const key=c.id+'|'+sr+'|'+n.p.kbps;
    if(key!==n.key){                                   // сменили кодек или частоту — начинаем заново
      if(n.h>=0 && C2.ex) C2.ex.c2_free(n.h);
      try{ n.enc?.close(); }catch(e){}
      n.key=key; n.h=-1; n.enc=null; n.rs=new MdResampler(sr,rate); n.pcm=[]; n.frames=[]; n.q=[]; n.err='';
      if(c.id===MD_CODEC.opus){
        if(!mvOpusOk()) n.err='Opus needs WebCodecs (Chrome / Edge / Safari); pick Codec 2 or μ-law';
        else try{
          n.enc=new AudioEncoder({output:ch=>{ const u=new Uint8Array(ch.byteLength); ch.copyTo(u); n.frames.push(u); }, error:e=>{ n.err='Opus: '+e.message; }});
          n.enc.configure({codec:'opus',sampleRate:rate,numberOfChannels:1,bitrate:n.p.kbps*1000,opus:{application:'voip',signal:'voice',frameDuration:20000,useinbandfec:false}});
        }catch(e){ n.err='Opus: '+e.message; }
      }
    }
    const on=I.ptt==null ? true : I.ptt>.5, x=I.in;
    if(!on){ n.rs=new MdResampler(sr,rate); n.pcm=[]; n.frames=[]; n.hang=0; n.text='idle · '+n.sent+' packets sent'; return {bin:n.out,active:0,kbps:0,new:0}; }
    if(c.id===MD_CODEC.c2_1600 || c.id===MD_CODEC.c2_3200){
      if(!C2.ex){ n.text=C2.err ? 'codec2.wasm: '+C2.err : 'loading codec2.wasm…'; return {bin:n.out,active:0,kbps:0,new:0}; }
      if(n.h<0) n.h=C2.ex.c2_new(c.mode);
    }
    if(n.err){ n.text=n.err; return {bin:n.out,active:0,kbps:0,new:0}; }
    // звук → int16 на частоте кодека
    if(x){
      const g=Math.pow(10,n.p.gain/20)*24000, y=n.rs.push(x);
      for(let i=0;i<y.length;i++) n.pcm.push(Math.max(-32768,Math.min(32767,Math.round(y[i]*g))));
    }
    const hangFrames=Math.ceil(300/MD_INFO[c.id].ms);
    while(n.pcm.length>=c.spf){
      const f=Int16Array.from(n.pcm.splice(0,c.spf));
      if(n.p.gate>-80){ if(mvDb(f)>=n.p.gate) n.hang=hangFrames; else if(n.hang>0) n.hang--; if(!n.hang) continue; }    // тишина: кадр не кодируем и не шлём
      if(c.id===MD_CODEC.opus){
        const a=new Float32Array(f.length); for(let i=0;i<f.length;i++) a[i]=f[i]/32768;
        try{ n.enc.encode(new AudioData({format:'f32',sampleRate:rate,numberOfFrames:a.length,numberOfChannels:1,timestamp:n.ts,data:a})); }catch(e){ n.err='Opus: '+e.message; }
        n.ts+=20000;
      } else if(c.id===MD_CODEC.ulaw){ n.frames.push(Uint8Array.from(f,mdUlawEnc)); }
      else { new Int16Array(C2.ex.memory.buffer,C2.ex.c2_pcm(),f.length).set(f); C2.ex.c2_encode(n.h); n.frames.push(new Uint8Array(C2.ex.memory.buffer.slice(C2.ex.c2_bits(),C2.ex.c2_bits()+8))); }
    }
    const per=Math.max(1,n.p.fpp|0), tag=mdTag(n.p.label);
    while(n.frames.length>=per){
      const u=mdWrap(n.p.wrap,mdPack(c.id,tag,n.seq=(n.seq+1)&0xFFFF,n.frames.splice(0,per)));
      if(u){ n.q.push(u); if(n.q.length>50) n.q.shift(); }
    }
    const now=performance.now();
    if(n.q.length){ const u=n.q.shift(); n.out=binObj(u,'voice-'+n.seq,'application/x-dsp-voice'); n.pulse=2; n.sent++; n.bw.push([now,u.length]); }
    while(n.bw.length && now-n.bw[0][0]>2000) n.bw.shift();
    const kbps=n.bw.reduce((s,v)=>s+v[1],0)*8/2000;
    n.text=c.n+' · '+n.sent+' packets · '+kbps.toFixed(1)+' kbit/s'+(n.q.length>5 ? ' · queue '+n.q.length : '');
    return {bin:n.out,active:n.bw.length ? 1 : 0,kbps,new:binPulse(n)}; },
  drawKey:n=>n.text,
  draw(n){ binReadout(n); }});

/* ---------- Packets → Voice ---------- */
def({ id:'voiceRx', title:'Packets → Voice', cat:'Decoders', kw:'voice audio packets codec2 opus ulaw decoder radio conference bin receive jitter', readout:true,
  ins:[{n:'bin',t:'bin'}], outs:[{n:'out',t:'sig'},{n:'active',t:'num'},{n:'lost',t:'num'},{n:'buf',t:'num'}],
  params:[{n:'label',t:'text',d:'voice',label:'stream name (empty — any)'},
          {n:'pre',t:'range',min:20,max:1000,step:10,d:120,label:'delay to smooth the link, ms (more — fewer gaps, more lag)'},
          {n:'gain',t:'range',min:0,max:4,step:.01,d:1,label:'gain'}],
  init:n=>{ n.last=null; n.cid=0; n.jit=null; n.rs=null; n.oq=new Float32Array(0); n.h=-1; n.dec=null; n.pend=[]; n.tsN=0; n.rxT=0; n.rxN=0; n.bad=0; n.err=''; n.codecName=''; n.text='waiting for packets'; c2Load(); },
  dispose(n){ if(n.h>=0 && C2.ex) C2.ex.c2_free(n.h); try{ n.dec?.close(); }catch(e){} },
  process(n,I){
    const o=buf(n,'out'), sr=Eng.sr, now=performance.now();
    const b=I.bin;
    if(b && b.d && b!==n.last){
      n.last=b; const m=mdUnpack(b.d);
      if(!m || m.codec===MD_CODEC.jpeg || (n.p.label && m.tag!==mdTag(n.p.label))){ if(!m) n.bad++; }
      else { n.rxT=now; n.rxN++; mvRxPacket(n,m,sr); }
    }
    if(n.jit){
      n.jit.pre=Math.round(MD_INFO[n.cid].rate*n.p.pre/1000);
      const per=Math.round(MD_INFO[n.cid].rate*.02);
      for(let k=0;k<12 && n.oq.length<BLOCK;k++){          // пока не набралось на блок: берём 20 мс из буфера, переводим в частоту движка
        const y=n.rs.push(n.jit.pull(per)), q=new Float32Array(n.oq.length+y.length); q.set(n.oq); q.set(y,n.oq.length); n.oq=q;
      }
    }
    o.fill(0);
    const take=Math.min(BLOCK,n.oq.length), g=n.p.gain/24000;
    for(let i=0;i<take;i++) o[i]=n.oq[i]*g;
    n.oq=n.oq.slice(take);
    const live=now-n.rxT<1500 && n.rxN>0, st=n.jit?.stat;
    n.text=n.err ? n.err : n.jit ? n.codecName+' · '+n.rxN+' packets'+(live ? '' : ' · stopped')+(n.bad ? ' · '+n.bad+' bad' : '')+'\nlost '+st.lost+' · late '+st.late+' · dropped '+st.dropped+' · buffer '+Math.round(n.jit.queued/MD_INFO[n.cid].rate*1000)+' ms' : n.text;
    return {out:o,active:live ? 1 : 0,lost:st ? st.lost : 0,buf:n.jit ? n.jit.queued/MD_INFO[n.cid].rate*1000 : 0}; },
  drawKey:n=>n.text,
  draw(n){ binReadout(n); }});

// пакет → декодированные кадры → jitter-буфер (Opus — асинхронно, через WebCodecs)
function mvRxPacket(n,m,sr){
  const info=MD_INFO[m.codec]; if(!info) return;
  if(m.codec!==n.cid){                                  // новый кодек у отправителя
    if(n.h>=0 && C2.ex){ C2.ex.c2_free(n.h); n.h=-1; }
    try{ n.dec?.close(); }catch(e){}
    n.dec=null; n.cid=m.codec; n.err=''; n.pend=[];
    n.jit=new MdJitter(info.rate,n.p.pre); n.rs=new MdResampler(info.rate,sr); n.oq=new Float32Array(0);
    n.codecName=(MV_CODECS.find(c=>c.id===m.codec)||{n:'codec '+m.codec}).n;
    if(m.codec===MD_CODEC.opus){
      if(!mvOpusOk()){ n.err='Opus needs WebCodecs (Chrome / Edge / Safari)'; return; }
      try{
        n.dec=new AudioDecoder({output:ad=>{
          const e=n.pend.shift(); if(!e){ ad.close(); return; }          // декодер отдаёт кадры по порядку (метки времени у него свои)
          const a=new Float32Array(ad.numberOfFrames); ad.copyTo(a,{planeIndex:0,format:'f32-planar'}); ad.close();
          e.pcm.push(a);
          if(e.pcm.length===e.nf && n.cid===MD_CODEC.opus){ const all=new Float32Array(e.pcm.reduce((s,v)=>s+v.length,0)); let p=0; for(const v of e.pcm){ all.set(v,p); p+=v.length; } for(let i=0;i<all.length;i++) all[i]*=32768; n.jit.push(e.seq,all); }
        },error:e=>{ n.err='Opus: '+e.message; }});
        n.dec.configure({codec:'opus',sampleRate:info.rate,numberOfChannels:1});
      }catch(e){ n.err='Opus: '+e.message; return; }
    }
  }
  if(m.codec===MD_CODEC.opus){
    if(!n.dec) return;
    const e={seq:m.seq,nf:m.nf,pcm:[]};
    for(const f of m.frames){ const ts=++n.tsN*20000; n.pend.push(e); try{ n.dec.decode(new EncodedAudioChunk({type:'key',timestamp:ts,data:f})); }catch(er){ n.err='Opus: '+er.message; return; } }
    return;
  }
  const parts=[];
  for(const f of m.frames){
    if(m.codec===MD_CODEC.ulaw){ if(f.length!==160){ n.bad++; return; } parts.push(Float32Array.from(f,mdUlawDec)); }
    else {
      if(!C2.ex) return;
      const mode=m.codec===MD_CODEC.c2_1600 ? 1600 : 3200;
      if(n.h<0) n.h=C2.ex.c2_new(mode);
      if(n.h<0) return;
      parts.push(Float32Array.from(c2Decode(n.h,f)));
    }
  }
  const all=new Float32Array(parts.reduce((s,v)=>s+v.length,0)); let p=0; for(const v of parts){ all.set(v,p); p+=v.length; }
  n.jit.push(m.seq,all);
}

/* ---------- Video → Packets ---------- */
def({ id:'videoTx', title:'Video → Packets', cat:'Protocols', kw:'video picture frame jpeg mjpeg packets conference radio slow scan bin send camera', readout:true,
  ins:[{n:'vid',t:'vid'},{n:'img',t:'img'}], outs:[{n:'bin',t:'bin'},{n:'active',t:'num'},{n:'kbps',t:'num'},{n:'new',t:'num'}],
  params:[{n:'label',t:'text',d:'video',label:'stream name (the receiving Packets → Video takes the same)'},
          {n:'fps',t:'select',opts:['0.1','0.2','0.5','1','2','5','10','15','25'],d:'10',label:'frames per second (at most)'},
          {n:'maxw',t:'select',opts:['64','96','128','160','240','320','480','640','960'],d:'320',label:'max width, px (radio: 96–160)'},
          {n:'q',t:'range',min:.2,max:.95,step:.05,d:.7,label:'JPEG quality wish (lowered by itself toward the target size)'},
          {n:'kb',t:'range',min:1,max:200,step:1,d:40,label:'target frame size, KB (radio: 1–3)'},
          {n:'gray',t:'check',d:false,label:'grayscale (a smaller frame)'}, MV_WRAP],
  init:n=>{ n.cv=null; n.t0=0; n.busy=false; n.seq=0; n.qNow=.7; n.q=[]; n.out=null; n.pulse=0; n.sent=0; n.bw=[]; n.src=''; n.text='waiting for a picture'; },
  process(n,I){
    const now=performance.now(), fps=+n.p.fps||10;
    let src=null, w=0, h=0;
    if(I.vid && I.vid.videoWidth){ src=I.vid; w=I.vid.videoWidth; h=I.vid.videoHeight; n.src='video'; }
    else if(I.img && I.img.data){ src=I.img; w=I.img.w; h=I.img.h; n.src='frame'; }
    if(src && !n.busy && now-n.t0>=1000/fps){
      n.t0=now; n.busy=true;
      const k=Math.min(1,(+n.p.maxw||320)/w), W=Math.max(8,Math.round(w*k)), H=Math.max(8,Math.round(h*k));
      if(!n.cv){ n.cv=document.createElement('canvas'); n.cx=n.cv.getContext('2d',{willReadFrequently:true}); n.tmp=document.createElement('canvas'); n.tx=n.tmp.getContext('2d'); }
      if(n.cv.width!==W || n.cv.height!==H){ n.cv.width=W; n.cv.height=H; }
      if(src===I.img){
        if(n.tmp.width!==w || n.tmp.height!==h){ n.tmp.width=w; n.tmp.height=h; }
        n.tx.putImageData(I.img.data,0,0); n.cx.drawImage(n.tmp,0,0,W,H);
      } else n.cx.drawImage(src,0,0,W,H);
      if(n.p.gray){ const id=n.cx.getImageData(0,0,W,H), d=id.data; for(let i=0;i<d.length;i+=4){ const y=(d[i]*77+d[i+1]*150+d[i+2]*29)>>8; d[i]=d[i+1]=d[i+2]=y; } n.cx.putImageData(id,0,0); }
      const qmax=+n.p.q||.7; if(n.qNow>qmax) n.qNow=qmax;
      n.cv.toBlob(async b=>{
        try{
          if(!b) return;
          const u=new Uint8Array(await b.arrayBuffer());
          n.qNow=mjAdapt(n.qNow,u.length,(+n.p.kb||40)*1024,qmax);
          const w=mdWrap(n.p.wrap,mdPack(MD_CODEC.jpeg,mdTag(n.p.label),n.seq=(n.seq+1)&0xFFFF,[u]));
          if(w){ n.q.push(w); if(n.q.length>4) n.q.shift(); } else n.big=u.length;
        }finally{ n.busy=false; }
      },'image/jpeg',n.qNow);
    }
    if(n.q.length){ const u=n.q.shift(); n.out=binObj(u,'frame-'+n.seq,'application/x-dsp-video'); n.pulse=2; n.sent++; n.bw.push([now,u.length]); n.last=u.length; }
    while(n.bw.length && now-n.bw[0][0]>4000) n.bw.shift();
    const kbps=n.bw.reduce((s,v)=>s+v[1],0)*8/4000;
    n.text=n.big && !n.last ? 'a frame of '+n.big+' bytes does not fit the framing; lower the size or take slip / kiss / cobs' : !src ? 'no picture on vid / img' : '«'+n.p.label+'» from '+n.src+' '+(n.cv?.width||0)+'×'+(n.cv?.height||0)+' · '+n.sent+' frames'+(n.last ? ' · '+(n.last/1024).toFixed(1)+' KB, q '+n.qNow.toFixed(2) : '')+' · '+kbps.toFixed(1)+' kbit/s';
    return {bin:n.out,active:src && n.bw.length ? 1 : 0,kbps,new:binPulse(n)}; },
  drawKey:n=>n.text,
  draw(n){ binReadout(n); }});

/* ---------- Packets → Video ---------- */
def({ id:'videoRx', title:'Packets → Video', cat:'Decoders', kw:'video picture frame jpeg mjpeg packets conference radio bin receive', readout:true,
  ins:[{n:'bin',t:'bin'}], outs:[{n:'img',t:'img'},{n:'active',t:'num'},{n:'fps',t:'num'}],
  params:[{n:'label',t:'text',d:'video',label:'stream name (empty — any)'},
          {n:'w',t:'select',opts:['96','160','320','480','640'],d:'320',label:'frame width for the img output'}],
  view:{h:120}, always:true,
  init(n){ n.cv=document.createElement('canvas'); n.cx=n.cv.getContext('2d',{willReadFrequently:true});
           n.last=null; n.seq=null; n.fb=null; n.dec=false; n.img=null; n.rxN=0; n.rxT=0; n.bad=0; n.shown=false; n.fpsT=performance.now(); n.fpsN=0; n.fpsV=0; n.text='waiting for the first frame'; },
  process(n,I){
    const now=performance.now(), b=I.bin;
    if(b && b.d && b!==n.last){
      n.last=b; const m=mdUnpack(b.d);
      if(!m){ n.bad++; }
      else if(m.codec===MD_CODEC.jpeg && (!n.p.label || m.tag===mdTag(n.p.label)) && mdSeqNewer(m.seq,n.seq)){
        n.seq=m.seq; n.fb=new Blob([m.frames[0]],{type:'image/jpeg'}); n.rxN++; n.rxT=now;
      }
    }
    if(n.fb && !n.dec){                                 // только последний кадр
      const bl=n.fb; n.fb=null; n.dec=true;
      createImageBitmap(bl).then(bm=>{
        const W=+n.p.w||320, H=Math.max(1,Math.round(W*bm.height/bm.width));
        if(n.cv.width!==W || n.cv.height!==H){ n.cv.width=W; n.cv.height=H; }
        n.cx.drawImage(bm,0,0,W,H); bm.close?.();
        n.img={data:n.cx.getImageData(0,0,W,H),w:W,h:H,gray:false,rev:(n.img?.rev|0)+1}; n.fpsN++; n.shown=true;
      }).catch(()=>{ n.bad++; }).finally(()=>{ n.dec=false; });
    }
    if(now-n.fpsT>=2000){ n.fpsV=n.fpsN*1000/(now-n.fpsT); n.fpsN=0; n.fpsT=now; }
    const live=n.shown && now-n.rxT<5000;
    n.text=live ? '«'+n.p.label+'» '+n.cv.width+'×'+n.cv.height+' · '+n.fpsV.toFixed(1)+' fps · '+n.rxN+' frames'+(n.bad ? ' · '+n.bad+' bad' : '') : n.rxN ? 'stream stopped' : 'waiting for «'+n.p.label+'»';
    return {img:n.img,active:live ? 1 : 0,fps:n.fpsV}; },
  drawKey:n=>n.text,
  draw(n,cv,cx){
    binReadout(n);
    if(cv && n.shown && n.cv.width) cx.drawImage(n.cv,0,0,cv.width,cv.height); }});
