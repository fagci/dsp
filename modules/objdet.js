"use strict";
/* ============================ Object Detect ============================
   Распознавание объектов на фото и видео: COCO-SSD (80 классов) на TensorFlow.js. Скрипты и модель (~7 МБ) грузятся при первом
   запуске узла (jsDelivr + storage.googleapis.com); для работы без сети положите их в vendor/ и укажите пути в libs / model.
   Вход: vid (живое видео — камера, видеофайл) или img (фото, кадры IP-камеры). Ядро (IoU, трекинг, подписи) — objdet-kernels.js,
   проверяется tools/test-objdet.mjs. */

const OD_LIBS=['https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js',
               'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js'];
const odScripts={}, odModels={};
function odScript(src){
  return odScripts[src] || (odScripts[src]=new Promise((res,rej)=>{
    const s=document.createElement('script'); s.src=src;
    s.onload=()=>res(); s.onerror=()=>{ delete odScripts[src]; rej(new Error('failed to load '+src)); };
    document.head.append(s);
  }));
}
async function odLoad(libs,base,modelUrl){
  const urls=String(libs||'').trim().split(/\s+/).filter(Boolean);
  for(const u of (urls.length ? urls : OD_LIBS)) await odScript(u);
  if(!window.cocoSsd) throw new Error('coco-ssd is missing in the loaded scripts');
  const k=base+'|'+modelUrl;
  return odModels[k] || (odModels[k]=cocoSsd.load(modelUrl ? {modelUrl} : {base}).catch(e=>{ delete odModels[k]; throw e; }));
}

function odPaint(n,dets){                           // рамки поверх кадра в n.cv
  const cx=n.cx, W=n.cv.width, H=n.cv.height, fs=Math.max(10,Math.round(H/28));
  cx.lineWidth=Math.max(2,Math.round(H/160)); cx.font='bold '+fs+'px sans-serif'; cx.textBaseline='top';
  for(const d of dets){
    const c=odColor(d.label), x=d.x*W, y=d.y*H, t=(d.id!=null ? '#'+d.id+' ' : '')+d.label+' '+Math.round(d.score*100)+'%';
    cx.strokeStyle=c; cx.strokeRect(x,y,d.w*W,d.h*H);
    const tw=cx.measureText(t).width+6, ty=y-fs-3>=0 ? y-fs-3 : y;
    cx.fillStyle=c; cx.fillRect(x,ty,tw,fs+3);
    cx.fillStyle='#000'; cx.fillText(t,x+3,ty+1);
  }
}
// кадр → n.cv (не шире maxw), сеть, рамки; результат в n.oimg, события в n.q
async function odRun(n,src){
  const gen=n.gen;
  const model=await odLoad(n.p.libs,n.p.base,n.p.model);
  if(gen!==n.gen) return;
  const sw=src.videoWidth||src.w, sh=src.videoHeight||src.h, mw=+n.p.maxw;
  const k=mw>0 && sw>mw ? mw/sw : 1, W=Math.max(1,Math.round(sw*k)), H=Math.max(1,Math.round(sh*k));
  if(n.cv.width!==W || n.cv.height!==H){ n.cv.width=W; n.cv.height=H; }
  if(src.data) n.cx.putImageData(src.data,0,0); else n.cx.drawImage(src,0,0,W,H);
  const t0=performance.now();
  const preds=await model.detect(n.cv,30,+n.p.score);
  if(gen!==n.gen) return;
  const ms=performance.now()-t0, t=performance.now()/1000;
  const dets=odFilter(odNorm(preds,W,H),odClasses(n.p.classes));
  let born=0;
  if(n.p.track) born=odTrack(n.tr,dets,t,{maxAge:+n.p.age});
  if(n.p.boxes) odPaint(n,dets);
  n.dets=dets; n.text=odText(dets); n.go=n.p.track ? born>0 : dets.length>0;
  n.oimg={data:n.cx.getImageData(0,0,W,H),w:W,h:H,gray:false,rev:(n.oimg?.rev|0)+1};
  const ts=Date.now(), newIds=new Set();
  if(n.p.track) for(const d of dets) if(d.age===0) newIds.add(d);
  for(const d of dets){
    if(n.p.track && !newIds.has(d)) continue;      // с трекингом событие — появление объекта
    const r={t:ts,src:'objdet',label:d.label,score:+d.score.toFixed(3),x:+d.x.toFixed(4),y:+d.y.toFixed(4),w:+d.w.toFixed(4),h:+d.h.toFixed(4)};
    if(d.id!=null) r.id=d.id;
    n.q.push(r);
  }
  n.status=(odSummary(dets)||'nothing found')+' · '+ms.toFixed(0)+' ms · '+(window.tf?.getBackend?.()||'');
  n.rev++; redraw(n);
}

def({ id:'objdet', lazy:'manual', title:'Object Detect', cat:'Video', resize:true, readout:true, view:{h:150}, w:340,
  kw:'object detection recognition camera photo video yolo coco ssd tensorflow person car dog cat ai neural tracking',
  // vid — живое видео (Camera, Video), img — фото или кадры; img на выходе — кадр с рамками; rec — найденное, go — импульс
  ins:[{n:'vid',t:'vid'},{n:'img',t:'img'}],
  outs:[{n:'img',t:'img'},{n:'text',t:'txt'},{n:'go',t:'num'},{n:'rec',t:'rec'},{n:'count',t:'num'},{n:'total',t:'num'}],
  params:[{n:'score',t:'range',min:.1,max:.95,step:.05,d:.5,label:'min confidence'},
          {n:'classes',t:'text',d:'',label:'only these classes, e.g. person, car (empty — all 80)'},
          {n:'period',t:'range',min:.05,max:5,step:.05,d:.3,label:'video: detect every, s'},
          {n:'track',t:'check',d:false,label:'tracking: id per object; rec/go only for new ones'},
          {n:'age',t:'range',min:.2,max:10,step:.1,d:1.5,label:'tracking: keep a lost object, s'},
          {n:'boxes',t:'check',d:true,label:'draw boxes on the output picture'},
          {n:'maxw',t:'select',opts:['320','480','640','960'],d:'640',label:'max width, px (smaller — faster)'},
          {n:'base',t:'select',opts:['lite_mobilenet_v2','mobilenet_v2'],d:'lite_mobilenet_v2',label:'model (v2 — more exact, slower)',adv:true},
          {n:'libs',t:'text',d:'',label:'script URLs, space-separated (empty — jsDelivr: TF.js, COCO-SSD)',adv:true},
          {n:'model',t:'text',d:'',label:'model.json URL (empty — Google storage by model)',adv:true}],
  init(n){
    n.cv=document.createElement('canvas'); n.cx=n.cv.getContext('2d',{willReadFrequently:true});
    n.busy=false; n.gen=0; n.lastT=0; n.lastKey=''; n.lastCfg=''; n.retryAt=0; n.rev=0;
    n.tr=odNewTracker(); n.q=[]; n.dets=[]; n.text=''; n.go=false; n.oimg=null; n.status='waiting for a picture or video'; },
  dispose:n=>{ n.gen++; },
  process(n,I){
    const v=I.vid && I.vid.videoWidth && I.vid.readyState>=2 ? I.vid : null;
    const im=!v && I.img && !I.img.gray ? I.img : null, src=v||im, now=performance.now();
    if(src && !n.busy && now>=n.retryAt){
      const cfg=[n.p.score,n.p.classes,n.p.track,n.p.base,n.p.libs,n.p.model,n.p.boxes,n.p.maxw].join('|');
      const key=v ? 'v'+v.currentTime : 'i'+im.rev;            // фото — один раз на кадр и на смену настроек
      const due= v ? key!==n.lastKey && now-n.lastT>=n.p.period*1000 : key!==n.lastKey;
      if(due || cfg!==n.lastCfg){
        if(cfg!==n.lastCfg) n.tr=odNewTracker();
        n.lastT=now; n.lastKey=key; n.lastCfg=cfg; n.busy=true;
        if(!window.cocoSsd) n.status='loading TF.js and the model (about 7 MB)…';
        const gen=n.gen;
        odRun(n,src).catch(e=>{ if(gen!==n.gen) return;
            n.status='error: '+(e.message||e); n.retryAt=performance.now()+5000; n.lastCfg=''; redraw(n); })
          .finally(()=>{ if(gen===n.gen) n.busy=false; });
      }
    }
    const rec=n.q.length ? n.q.splice(0) : null, go=n.go ? 1 : 0; n.go=false;
    return {img:n.oimg, text:n.text, go, rec, count:n.dets.length, total:n.tr.total}; },
  drawKey:n=>n.status+'|'+n.rev,
  draw(n,cv,cx){
    const r=n.el.querySelector('.readout'); if(r) r.textContent=n.status;
    if(n.oimg) camPaintTo(cx,n.cv,n.cv.width,n.cv.height,cv.width,cv.height); }});
