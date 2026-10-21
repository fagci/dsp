"use strict";
/* ============================ QR: генератор и чтение ============================
   Библиотеки грузятся при первом использовании: vendor/qrcode.min.js (генератор, MIT) и vendor/jsqr.min.js (чтение по пикселям,
   Apache-2.0). Читает сначала BarcodeDetector (быстрее; Chrome / Android), иначе jsQR. Узел QR Code делает картинку из текста;
   окна qrShow / qrScan используют окно синхронизации (ключ пары без набора вручную). */

const QR_LIBS={qr:['vendor/qrcode.min.js?v=1.4.4','qrcode'],scan:['vendor/jsqr.min.js?v=1.4.0','jsQR']};
const qrLoading={};
function qrLoad(k){
  const [src,g]=QR_LIBS[k];
  return qrLoading[k] || (qrLoading[k]=new Promise((res,rej)=>{
    if(window[g]) return res(window[g]);
    const s=document.createElement('script'); s.src=src;
    s.onload=()=>res(window[g]); s.onerror=()=>{ qrLoading[k]=null; rej(new Error('failed to load '+src)); };
    document.head.append(s);
  }));
}
// текст → матрица модулей (UTF-8); ecc L/M/Q/H
async function qrMake(text,ecc='M'){
  const q=await qrLoad('qr'); q.stringToBytes=q.stringToBytesFuncs['UTF-8'];
  const c=q(0,ecc); c.addData(String(text),'Byte'); c.make();
  const n=c.getModuleCount(), m=[];
  for(let y=0;y<n;y++){ const r=[]; for(let x=0;x<n;x++) r.push(c.isDark(y,x)); m.push(r); }
  return m;
}
async function qrImage(text,ecc,scale){               // → {w,h,data:ImageData}
  const r=qrRender(await qrMake(text,ecc),scale,4);
  return {w:r.w,h:r.h,data:new ImageData(r.data,r.w,r.h)};
}
// ImageData / холст / видео → текст QR или ''
let qrDet=null;
async function qrScanFrame(src){
  if(typeof BarcodeDetector!=='undefined'){
    try{ const r=await (qrDet||=new BarcodeDetector({formats:['qr_code']})).detect(src); if(r.length) return r[0].rawValue; return ''; }catch(e){}
  }
  let id=src;
  if(!(src instanceof ImageData)){
    const w=src.videoWidth||src.width, h=src.videoHeight||src.height; if(!w||!h) return '';
    const c=qrScanFrame.cv||=document.createElement('canvas'); c.width=w; c.height=h;
    const cx=c.getContext('2d',{willReadFrequently:true}); cx.drawImage(src,0,0,w,h); id=cx.getImageData(0,0,w,h);
  }
  const j=await qrLoad('scan'); const r=j(id.data,id.width,id.height,{inversionAttempts:'attemptBoth'});
  return r ? r.data : '';
}

/* ---- окна ---- */
function qrOverlay(title){
  const ov=document.createElement('div');
  ov.style.cssText='position:fixed;inset:0;z-index:210;background:var(--scrim);display:flex;align-items:center;justify-content:center';
  const box=document.createElement('div');
  box.style.cssText='background:var(--panel);color:var(--txt);border:1px solid var(--line);border-radius:6px;padding:14px;width:min(420px,92vw);max-height:92vh;overflow:auto;font-size:12px;display:flex;flex-direction:column;gap:8px;align-items:center';
  const h=document.createElement('b'); h.textContent=title; h.style.fontSize='13px';
  const note=document.createElement('div'); note.style.cssText='color:var(--dim);white-space:pre-wrap;text-align:center;min-height:1.4em;word-break:break-all';
  const close=document.createElement('button'); close.textContent='Close';
  close.style.cssText='background:var(--panel2);color:var(--txt);border:1px solid var(--line);border-radius:4px;padding:6px 10px;font:inherit;cursor:pointer';
  box.append(h); ov.append(box); document.body.append(ov);
  const done=[]; const end=()=>{ for(const f of done) try{ f(); }catch(e){} ov.remove(); };
  close.onclick=end; ov.onclick=e=>{ if(e.target===ov) end(); };
  return {box,note,close,end,onEnd:f=>done.push(f)};
}
async function qrShow(title,text,hint){
  const w=qrOverlay(title);
  const cv=document.createElement('canvas'); cv.style.cssText='width:min(340px,80vw);height:auto;image-rendering:pixelated;background:#fff';
  w.box.append(cv,w.note,w.close); w.note.textContent='Making…';
  try{
    const r=qrRender(await qrMake(text,'M'),8,4); cv.width=r.w; cv.height=r.h;
    cv.getContext('2d').putImageData(new ImageData(r.data,r.w,r.h),0,0);
    w.note.textContent=hint||'';
  }catch(e){ w.note.textContent='Failed: '+e.message; }
}
// камера → onText(текст) по первому найденному QR; false из onText — продолжать искать
async function qrScan(title,onText){
  const w=qrOverlay(title);
  const v=document.createElement('video'); v.muted=true; v.playsInline=true; v.style.cssText='width:min(380px,84vw);background:#000;border-radius:4px';
  w.box.append(v,w.note,w.close);
  let stream=null, stop=false; w.onEnd(()=>{ stop=true; stream?.getTracks().forEach(t=>t.stop()); });
  try{
    if(!navigator.mediaDevices?.getUserMedia) throw new Error('the camera needs a secure page (https)');
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});
    if(stop){ stream.getTracks().forEach(t=>t.stop()); return; }
    v.srcObject=stream; await v.play(); w.note.textContent='Point the camera at the QR code';
    while(!stop){
      let t=''; try{ t=await qrScanFrame(v); }catch(e){ w.note.textContent='Failed: '+e.message; return; }
      if(t && onText(t)!==false){ w.end(); return; }
      if(t) w.note.textContent='This QR is not what is needed, keep looking…';
      await new Promise(r=>setTimeout(r,200));
    }
  }catch(e){ w.note.textContent='Failed: '+(e.message||e); }
}

/* ---- узел QR Code: текст → картинка ---- */
def({ id:'qrgen', title:'QR Code', cat:'Video', kw:'qr code generator barcode image text link',
  ins:[{n:'text',t:'txt'}], outs:[{n:'img',t:'img'}], readout:true,
  params:[{n:'text',t:'text',d:'https://example.com',label:'text (the `text` input overrides it)'},
          {n:'ecc',t:'select',opts:['L','M','Q','H'],d:'M',label:'error correction (H — survives damage, bigger code)'},
          {n:'scale',t:'range',min:2,max:16,step:1,d:6,label:'pixels per module'}],
  init:n=>{ n.key=null; n.img=null; n.status='waiting'; n.busy=false; },
  process(n,I){
    const t=typeof I.text==='string' && I.text ? I.text : String(n.p.text||''), k=t+'|'+n.p.ecc+'|'+n.p.scale;
    if(k!==n.key && !n.busy){
      n.key=k; n.busy=true;
      qrImage(t,n.p.ecc,+n.p.scale).then(r=>{ n.img={data:r.data,w:r.w,h:r.h,gray:false,rev:(n.img?.rev|0)+1}; n.status=r.w+'×'+r.h+' px, '+t.length+' chars'; })
        .catch(e=>{ n.status=t ? 'cannot encode: '+e.message : 'empty text'; }).finally(()=>{ n.busy=false; });
    }
    return {img:n.img}; },
  drawKey:n=>n.status,
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.status; }
});
