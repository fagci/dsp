"use strict";
/* ============================ Байты и файлы: узлы ============================
   Порт bin — {d:Uint8Array, name, mime, id}. Файл → Bytes и Bytes → File стыкуют его с диском и файловым хранилищем,
   Bytes ↔ Text — с любым текстовым каналом, Bytes → Frames / Frames → Bytes (кадры с CRC, карусель) — с каналами,
   где байты теряются или приходят кусками: UART, BLE, MQTT, звук, радио. Ядро — bytes-kernels.js. */

let BIN_SEQ=0;
const binObj=(d,name,mime)=>({d,name:name||'',mime:mime||'',id:++BIN_SEQ});
const binSizeStr=b=>typeof fmSize==='function' ? fmSize(b) : b+' B';
const binPulse=n=>{ const v=n.pulse>0 ? 1 : 0; if(n.pulse>0) n.pulse--; return v; };
const binReadout=n=>{ const r=n.el.querySelector('.readout'); if(r && r.textContent!==n.text) r.textContent=n.text; };

/* ---------- File → Bytes ---------- */
def({ id:'binFile', title:'File → Bytes', cat:'Sources', kw:'file bytes binary upload send transfer data blob', readout:true,
  ins:[{n:'go',t:'num'}], outs:[{n:'bin',t:'bin'},{n:'size',t:'num'},{n:'name',t:'txt'},{n:'new',t:'num'}],
  params:[{n:'file',t:'file',accept:'*/*',fn:(n,f)=>{
            f.arrayBuffer().then(a=>{ n.bytes=new Uint8Array(a); n.fname=f.name; n.mime=f.type||'application/octet-stream';
              n.text=f.name+' · '+binSizeStr(f.size); if(n.p.auto) n.trig=true; }); }},
          {n:'auto',t:'check',d:true,label:'send when a file is chosen'},
          {n:'repeat',t:'range',min:0,max:3600,step:1,d:0,label:'repeat every, s (0 — only on go / Send)'},
          {n:'send',t:'button',label:'Send',fn:n=>{ n.trig=true; }}],
  init:n=>{ n.bytes=null; n.fname=''; n.mime=''; n.out=null; n.trig=false; n.prevGo=0; n.t=0; n.pulse=0; n.text='choose a file'; },
  process(n,I){
    const go=(I.go||0)>.5, rise=go && !n.prevGo; n.prevGo=go;
    if(n.p.repeat>0 && n.bytes){ n.t+=BLOCK/Eng.sr; if(n.t>=n.p.repeat){ n.t=0; n.trig=true; } }
    if((rise||n.trig) && n.bytes){ n.out=binObj(n.bytes,n.fname,n.mime); n.pulse=2; n.text=n.fname+' · '+binSizeStr(n.bytes.length)+' · sent'; }
    n.trig=false;
    return {bin:n.out, size:n.bytes ? n.bytes.length : 0, name:n.fname, new:binPulse(n)}; },
  draw:binReadout });

/* Bytes → File теперь входы bin / path узла Files (modules/filestore.js) */

/* ---------- Bytes ↔ Text ---------- */
def({ id:'binToTxt', title:'Bytes → Text', cat:'Data', kw:'bytes binary hex base64 text encode convert', readout:true,
  ins:[{n:'bin',t:'bin'}], outs:[{n:'text',t:'txt'},{n:'size',t:'num'},{n:'new',t:'num'}],
  params:[{n:'enc',t:'select',opts:BIN_ENC,d:'base64',label:'representation'}],
  init:n=>{ n.last=null; n.out=''; n.size=0; n.pulse=0; n.text='…'; },
  process(n,I){
    const o=I.bin;
    if(o && o.d && o!==n.last){ n.last=o; n.size=o.d.length; n.out=binToText(o.d,n.p.enc); n.pulse=2; n.text=n.size+' bytes\n'+n.out.slice(0,300); }
    return {text:n.out, size:n.size, new:binPulse(n)}; },
  draw:binReadout });
def({ id:'txtToBin', title:'Text → Bytes', cat:'Data', kw:'bytes binary hex base64 text decode convert', readout:true,
  ins:[{n:'text',t:'txt'}], outs:[{n:'bin',t:'bin'},{n:'size',t:'num'},{n:'new',t:'num'}],
  params:[{n:'enc',t:'select',opts:BIN_ENC,d:'base64',label:'representation of the text'},
          {n:'name',t:'text',d:'',label:'name to attach (optional)'}],
  init:n=>{ n.lastIn=undefined; n.out=null; n.pulse=0; n.text='…'; },
  process(n,I){
    if(typeof I.text==='string' && I.text!==n.lastIn){
      n.lastIn=I.text;
      if(I.text){
        try{ n.out=binObj(binFromText(I.text,n.p.enc),n.p.name.trim()); n.pulse=2; n.text=n.out.d.length+' bytes'; }
        catch(e){ n.text='not valid '+n.p.enc+': '+e.message; }
      }
    }
    return {bin:n.out, size:n.out ? n.out.d.length : 0, new:binPulse(n)}; },
  draw:binReadout });

/* ---------- Text: Wrap (prefix/suffix with arbitrary bytes) ---------- */
def({ id:'txtWrap', title:'Text: Wrap (prefix/suffix bytes)', cat:'Data', kw:'text bytes prefix suffix header trailer escape hex \\x terminator eol append insert', readout:true,
  ins:[{n:'text',t:'txt'},{n:'bin',t:'bin'}], outs:[{n:'bin',t:'bin'},{n:'text',t:'txt'},{n:'size',t:'num'},{n:'new',t:'num'}],
  params:[{n:'pre',t:'text',d:'',label:'prefix, JS escapes: \\x02 \\u0416 \\r \\n \\0 \\\\'},
          {n:'suf',t:'text',d:'\\r\\n',label:'suffix'},
          {n:'enc',t:'select',opts:['utf8','latin1'],d:'utf8',label:'text ↔ bytes'}],
  init:n=>{ n.key=null; n.out=null; n.str=''; n.pulse=0; n.text='…'; },
  process(n,I){
    const src=I.bin&&I.bin.d ? I.bin : null, txt=typeof I.text==='string' ? I.text : null;
    const key=src ? src.id+'|'+n.p.pre+'|'+n.p.suf+'|'+n.p.enc : txt!==null ? 't|'+txt+'|'+n.p.pre+'|'+n.p.suf+'|'+n.p.enc : null;
    if(key!==null && key!==n.key){
      n.key=key;
      try{
        const a=binFromEscaped(n.p.pre), b=binFromEscaped(n.p.suf);
        const body=src ? src.d : n.p.enc==='latin1' ? binFromText(txt,'latin1') : binFromText(txt,'utf8');
        const d=new Uint8Array(a.length+body.length+b.length);
        d.set(a); d.set(body,a.length); d.set(b,a.length+body.length);
        n.out=binObj(d,src?src.name:'',src?src.mime:''); n.str=binToText(d,n.p.enc); n.pulse=2;
        n.text=d.length+' bytes\n'+binToText(d.subarray(0,48),'hex');
      }catch(e){ n.text='error: '+e.message; }
    }
    return {bin:n.out, text:n.str, size:n.out ? n.out.d.length : 0, new:binPulse(n)}; },
  draw:binReadout });

/* ---------- Bytes → Frames ---------- */
def({ id:'binTx', title:'Bytes → Frames', cat:'Protocols', kw:'bytes file packetizer frames chunks crc carousel transfer serial ble mqtt', readout:true, tall:true,
  ins:[{n:'bin',t:'bin'},{n:'go',t:'num'}], outs:[{n:'bin',t:'bin'},{n:'text',t:'txt'},{n:'go',t:'num'},{n:'busy',t:'num'},{n:'progress',t:'num'}],
  params:[{n:'meta',t:'check',d:true,label:'send the name and type in the first frame (off — bytes only)'},
          {n:'pay',t:'range',min:1,max:1024,step:1,d:64,label:'payload per frame, bytes (BLE: 20 minus 15 header — or raise the BLE chunk)'},
          {n:'rate',t:'range',min:1,max:90,step:1,d:20,label:'frames per second (one frame per engine tick at most)'},
          {n:'enc',t:'select',opts:['base64','hex'],d:'base64',label:'text output (one frame per line)'},
          {n:'loop',t:'check',d:false,label:'carousel: repeat the whole transfer (one-way links, late listeners)'},
          {n:'gap',t:'range',min:0,max:30,step:.5,d:1,label:'pause between rounds, s'},
          {n:'send',t:'button',label:'Send again',fn:n=>{ n.trig=true; }},
          {n:'stop',t:'button',label:'Stop',fn:n=>{ n.q=[]; n.qi=0; n.text='stopped'; }}],
  init:n=>{ n.q=[]; n.qi=0; n.nextAt=0; n.src=null; n.lastIn=null; n.prevGo=0; n.trig=false; n.fo=null; n.ft=''; n.rounds=0; n.text='waiting for data'; },
  process(n,I){
    const P=n.p, now=performance.now(), go=(I.go||0)>.5, rise=go && !n.prevGo; n.prevGo=go;
    const start=()=>{
      try{ n.q=binPack(n.src.d,{pay:P.pay,name:P.meta ? n.src.name : '',mime:P.meta ? n.src.mime : ''}); n.qi=0; n.nextAt=0; n.rounds=0; }
      catch(e){ n.q=[]; n.text=String(e.message||e); } };
    if(I.bin && I.bin.d && I.bin!==n.lastIn){ n.lastIn=I.bin; n.src=I.bin; start(); }
    else if((n.trig||rise) && n.src) start();
    n.trig=false;
    let emitted=0;
    if(n.qi<n.q.length && now>=n.nextAt){
      const f=n.q[n.qi++];
      n.fo=binObj(f); n.ft=binToText(f,P.enc); emitted=1;
      n.nextAt=now+1000/Math.max(1,P.rate);
      if(n.qi>=n.q.length){
        n.rounds++;
        if(P.loop){ n.qi=0; n.nextAt=now+P.gap*1000; }
      }
    }
    const busy=n.qi<n.q.length;
    n.text=!n.q.length ? n.text : (busy || P.loop ? 'frame '+n.qi+'/'+n.q.length : 'done')+(P.loop ? ' · round '+(n.rounds+1) : '')+
      '\n'+(n.src?.name||'data')+' · '+(n.src ? binSizeStr(n.src.d.length) : '');
    return {bin:n.fo, text:n.ft, go:emitted, busy:busy||P.loop&&n.q.length ? 1 : 0, progress:n.q.length ? n.qi/n.q.length : 0}; },
  draw:binReadout });

/* ---------- Frames → Bytes ---------- */
def({ id:'binRx', title:'Frames → Bytes', cat:'Decoders', kw:'bytes file depacketizer frames chunks crc receive transfer serial ble mqtt', readout:true, tall:true,
  ins:[{n:'bin',t:'bin'},{n:'text',t:'txt'}], outs:[{n:'bin',t:'bin'},{n:'name',t:'txt'},{n:'progress',t:'num'},{n:'ok',t:'num'},{n:'rec',t:'rec'}],
  params:[{n:'timeout',t:'range',min:1,max:600,step:1,d:60,label:'forget an unfinished transfer after, s'}],
  init:n=>{ n.st=new BinStream(); n.asm=new BinAssembler(); n.lastBin=null; n.lastText=undefined; n.out=null; n.rec=null; n.pulse=0; n.lineBad=0;
    n.text='waiting for frames'; },
  process(n,I){
    const now=Date.now(); n.rec=null;
    const feed=p=>{ const r=n.asm.push(p,now);
      if(r){ n.out=binObj(r.data,r.name,r.mime); n.pulse=2;
        n.rec={t:now,src:'bytes',kind:'file',id:r.xid,name:r.name,mime:r.mime,bytes:r.data.length,crc:binCrc32(r.data).toString(16).padStart(8,'0')}; } };
    if(I.bin && I.bin.d && I.bin!==n.lastBin){ n.lastBin=I.bin; for(const p of n.st.push(I.bin.d)) feed(p); }
    if(typeof I.text==='string' && I.text!==n.lastText){
      n.lastText=I.text;
      for(const l of I.text.split(/\r?\n/)){
        if(!l.trim()) continue;
        let p=null; try{ p=binParse(binLineToFrame(l)); }catch(e){}
        if(p) feed(p); else n.lineBad++;
      }
    }
    n.asm.expire(now,n.p.timeout*1000);
    const bad=n.st.bad+n.lineBad, prog=n.asm.progress();
    n.text=n.asm.good+' frames ok · '+bad+' bad · '+n.asm.files+' files'+(n.asm.badFile ? ' · '+n.asm.badFile+' failed CRC' : '')+
      (prog>0 ? '\nreceiving '+Math.round(prog*100)+'%' : '')+(n.out ? '\nlast: '+(n.out.name||'data')+' · '+binSizeStr(n.out.d.length) : '');
    return {bin:n.out, name:n.out ? n.out.name : '', progress:prog, ok:binPulse(n), rec:n.rec}; },
  draw:binReadout });

/* ---------- Bytes → Image ---------- */
// bin → img: файл (JPEG/PNG/GIF/WebP/BMP/AVIF), поток JPEG (MJPEG, ESP32-CAM) или сырые пиксели
def({ id:'binImg', title:'Bytes → Image', cat:'Decoders', kw:'bytes image picture photo jpeg jpg png gif webp bmp avif mjpeg camera esp32-cam serial webserial raw rgb565 frame decode', readout:true, view:{h:120}, resize:true,
  ins:[{n:'bin',t:'bin'}], outs:[{n:'img',t:'img'},{n:'new',t:'num'},{n:'w',t:'num'},{n:'h',t:'num'},{n:'fps',t:'num'}],
  params:[{n:'mode',t:'select',opts:['file','stream','raw'],d:'file',label:'file — one picture per bin; stream — JPEG frames cut from a byte stream (MJPEG); raw — pixels without a header'},
          {n:'fmt',t:'select',opts:Object.keys(BIN_RAW_BPP),d:'rgb565',label:'raw: pixel format'},
          {n:'rw',t:'range',min:8,max:1280,step:1,d:160,label:'raw: width'},
          {n:'rh',t:'range',min:8,max:960,step:1,d:120,label:'raw: height'},
          {n:'maxw',t:'select',opts:['0','1280','960','640','320'],d:'0',label:'max width, px (0 — as is)'},
          {n:'clear',t:'button',label:'Reset',fn:n=>binImgReset(n)}],
  init(n){
    n.capCv=document.createElement('canvas'); n.capCx=n.capCv.getContext('2d',{willReadFrequently:true});
    binImgReset(n); n.text='no data'; },
  process(n,I){
    const o=I.bin;
    if(o && o.d && o!==n.last){
      n.last=o; n.bytes+=o.d.length; n.mode=n.p.mode;
      if(n.p.mode==='stream'){
        for(const f of n.spl.push(o.d)) binImgQueue(n,f);
      }else if(n.p.mode==='raw'){
        const bpp=BIN_RAW_BPP[n.p.fmt], fs=n.p.rw*n.p.rh*bpp;
        n.rawBuf=binCat(n.rawBuf,o.d);
        while(n.rawBuf.length>=fs){
          const px=binRawToRGBA(n.rawBuf,n.p.rw,n.p.rh,n.p.fmt);
          n.rawBuf=n.rawBuf.subarray(fs);
          n.capCv.width=n.p.rw; n.capCv.height=n.p.rh;
          binImgSet(n,new ImageData(px,n.p.rw,n.p.rh),n.capCx);
        }
      }else binImgQueue(n,o.d);
    }
    const now=performance.now();
    while(n.ts.length && now-n.ts[0]>1000) n.ts.shift();
    n.fps=n.ts.length;
    const a=n.img;
    n.text=(a ? a.w+'×'+a.h+' · '+(n.fmtName||'raw')+' · ' : '')+n.frames+' frames'+(n.fps ? ' · '+n.fps+' fps' : '')+' · '+binSizeStr(n.bytes)+
      (n.drop ? ' · '+n.drop+' skipped' : '')+(n.spl && n.spl.junk ? ' · '+binSizeStr(n.spl.junk)+' junk' : '')+(n.err ? '\n'+n.err : '');
    return {img:n.img, new:binPulse(n), w:n.img ? n.img.w : 0, h:n.img ? n.img.h : 0, fps:n.fps}; },
  drawKey:n=>n.text+'|'+n.img?.rev,
  draw(n,cv,cx){ binReadout(n); if(n.img) cx.drawImage(n.capCv,0,0,cv.width,cv.height); }});

function binImgReset(n){
  n.last=null; n.img=null; n.frames=0; n.bytes=0; n.drop=0; n.err=''; n.fps=0; n.ts=[]; n.pulse=0; n.fmtName='';
  n.spl=new BinJpegSplitter(); n.rawBuf=new Uint8Array(0); n.busy=false; n.pending=null; n.gen=(n.gen|0)+1;
}
function binImgSet(n,imageData,cx){
  const W=imageData.width, H=imageData.height;
  n.img={data:imageData,w:W,h:H,gray:false,rev:(n.img?.rev|0)+1};
  n.frames++; n.pulse=2; n.ts.push(performance.now());
  cx.putImageData(imageData,0,0);
}
// Декодер асинхронный: пока он занят, держим только последний кадр, остальные пропускаем
function binImgQueue(n,bytes){
  if(n.busy){ if(n.pending) n.drop++; n.pending=bytes; return; }
  n.busy=true;
  const gen=n.gen, fmt=binSniff(bytes);
  if(!fmt){ n.busy=false; n.err='not an image (no known signature)'; return; }
  createImageBitmap(new Blob([bytes],{type:BIN_IMG_MIME[fmt]})).then(bm=>{
    if(gen!==n.gen){ bm.close(); return; }
    const k=+n.p.maxw && bm.width>+n.p.maxw ? +n.p.maxw/bm.width : 1;
    const W=Math.max(1,Math.round(bm.width*k)), H=Math.max(1,Math.round(bm.height*k));
    n.capCv.width=W; n.capCv.height=H;
    n.capCx.drawImage(bm,0,0,W,H); bm.close();
    n.fmtName=fmt; n.err='';
    binImgSet(n,n.capCx.getImageData(0,0,W,H),n.capCx);
  }).catch(()=>{ if(gen===n.gen) n.err='could not decode the '+fmt; })
    .finally(()=>{ if(gen!==n.gen) return; n.busy=false; const p=n.pending; n.pending=null; if(p) binImgQueue(n,p); });
}
