"use strict";
/* ============================ Видео по каналу синхронизации (MJPEG) ============================
   Sync Video Out шлёт кадры графа (вход vid — камера / видеофайл, или img) как JPEG по каналу video соединения синхронизации
   (без повторов: запоздавший кадр не задерживает новые; занятый канал — кадр пропускается). Sync Video In с той же меткой отдаёт
   принятые кадры в граф. Формат и подстройка качества — mjpeg-kernels.js. Нужны ключ и включённая синхронизация (Sync devices). */

const SyVideo={
  inn:new Set(),
  rx(p,data){                                          // кадр от устройства p
    const m=mjUnpack(data); if(!m) return;
    for(const n of this.inn) if(String(n.p.label||'video')===m.label && mjNewer(m.seq,n.seq)){
      n.seq=m.seq; n.fb=new Blob([m.jpeg],{type:'image/jpeg'}); n.fromP=p; n.rxN++; n.rxT=performance.now(); n.rxBytes+=m.jpeg.length;
    }
  },
  send(label,to,buf){                                  // сколько устройств получили кадр (занятые пропускаются)
    let k=0;
    for(const d of SyLink.devices()){
      const c=d.p.vc; if(to && d.label!==to) continue;
      if(!c || c.readyState!=='open' || c.bufferedAmount>262144) continue;
      try{ c.send(buf); k++; }catch(e){}
    }
    return k;
  },
};
const syvDevOpts=n=>{ const o=['all devices',...SyLink.devices().map(d=>d.label)]; if(n.p.device && !o.includes(n.p.device)) o.push(n.p.device); return o; };

def({ id:'syVideoOut', title:'Sync Video Out', cat:'Output', kw:'sync video send picture frame stream mjpeg jpeg camera devices phone',
  ins:[{n:'vid',t:'vid'},{n:'img',t:'img'}], outs:[{n:'active',t:'num'}], readout:true,
  params:[{n:'label',t:'text',d:'video',label:'stream name (the receiving Sync Video In takes the same)'},
          {n:'device',t:'select',opts:syvDevOpts,d:'all devices',label:'send to'},
          {n:'fps',t:'select',opts:['2','5','10','15','25'],d:'10',label:'frames per second (at most)'},
          {n:'maxw',t:'select',opts:['240','320','480','640','960'],d:'480',label:'max width, px'},
          {n:'q',t:'range',min:.3,max:.95,step:.05,d:.7,label:'JPEG quality wish (lowered by itself when the channel is slow)'},
          {n:'kb',t:'range',min:10,max:200,step:5,d:50,label:'target frame size, KB'}],
  init:n=>{ n.cv=null; n.t0=0; n.busy=false; n.seq=0; n.qNow=.7; n.sent=0; n.skipped=0; n.bytes=0; n.status='waiting for a picture'; n.src=''; },
  process(n,I){
    const now=performance.now(), fps=+n.p.fps||10;
    let src=null, w=0, h=0;
    if(I.vid && I.vid.videoWidth){ src=I.vid; w=I.vid.videoWidth; h=I.vid.videoHeight; n.src='video'; }
    else if(I.img && I.img.data){ src=I.img; w=I.img.w; h=I.img.h; n.src='frame'; }
    const devs=SyLink.devices();
    if(src && !n.busy && now-n.t0>=1000/fps && devs.length){
      n.t0=now; n.busy=true;
      const k=Math.min(1,(+n.p.maxw||480)/w), W=Math.max(2,Math.round(w*k)), H=Math.max(2,Math.round(h*k));
      if(!n.cv){ n.cv=document.createElement('canvas'); n.cx=n.cv.getContext('2d'); n.tmp=document.createElement('canvas'); n.tx=n.tmp.getContext('2d'); }
      if(n.cv.width!==W || n.cv.height!==H){ n.cv.width=W; n.cv.height=H; }
      if(src===I.img){
        if(n.tmp.width!==w || n.tmp.height!==h){ n.tmp.width=w; n.tmp.height=h; }
        n.tx.putImageData(I.img.data,0,0); n.cx.drawImage(n.tmp,0,0,W,H);
      } else n.cx.drawImage(src,0,0,W,H);
      const qmax=+n.p.q||.7, to=n.p.device==='all devices' ? '' : n.p.device;
      if(n.qNow>qmax) n.qNow=qmax;
      n.cv.toBlob(async b=>{
        try{
          if(!b) return;
          const u=new Uint8Array(await b.arrayBuffer());
          n.qNow=mjAdapt(n.qNow,u.length,(+n.p.kb||50)*1024,qmax);
          if(SyVideo.send(n.p.label,to,mjPack(n.p.label,n.seq=(n.seq+1)&0xFFFF,u))){ n.sent++; n.bytes+=u.length; n.lastBytes=u.length; } else n.skipped++;
        }finally{ n.busy=false; }
      },'image/jpeg',n.qNow);
    }
    n.status=!SyLink.on ? 'sync is off: open “Sync devices”, enter the key and tick “keep in sync”' : !devs.length ? 'no other device connected'
      : !src ? 'connected, no picture on vid / img' : '«'+n.p.label+'» from '+n.src+' '+(n.cv?.width||0)+'×'+(n.cv?.height||0)+' · sent '+n.sent+(n.skipped ? ' · skipped '+n.skipped : '')
        +(n.lastBytes ? ' · '+Math.round(n.lastBytes/1024)+' KB, q '+n.qNow.toFixed(2) : '');
    return {active:src && devs.length && n.sent ? 1 : 0}; },
  drawKey:n=>n.status,
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.status; }
});

def({ id:'syVideoIn', title:'Sync Video In', cat:'Sources', kw:'sync video receive picture frame stream mjpeg jpeg camera devices phone',
  ins:[], outs:[{n:'img',t:'img'},{n:'active',t:'num'},{n:'fps',t:'num'},{n:'from',t:'txt'}],
  params:[{n:'label',t:'text',d:'video',label:'stream name (the sender\'s Sync Video Out label)'},
          {n:'w',t:'select',opts:['160','320','480','640'],d:'320',label:'frame width for the img output'}],
  view:{h:120}, readout:true, always:true,
  init(n){ n.cv=document.createElement('canvas'); n.cx=n.cv.getContext('2d',{willReadFrequently:true});
           n.seq=null; n.fb=null; n.dec=false; n.img=null; n.rxN=0; n.rxT=0; n.rxBytes=0; n.fromP=null; n.from=''; n.fpsT=performance.now(); n.fpsN=0; n.fpsV=0; n.status='waiting for the first frame';
           SyVideo.inn.add(n); },
  dispose(n){ SyVideo.inn.delete(n); },
  process(n,I){
    SyVideo.inn.add(n);
    const now=performance.now();
    if(n.fb && !n.dec){                                // только последний кадр: пока декодируем, новые заменяют ожидающий
      const b=n.fb; n.fb=null; n.dec=true;
      createImageBitmap(b).then(bm=>{
        const W=+n.p.w||320, H=Math.max(1,Math.round(W*bm.height/bm.width));
        if(n.cv.width!==W || n.cv.height!==H){ n.cv.width=W; n.cv.height=H; }
        n.cx.drawImage(bm,0,0,W,H); bm.close?.();
        n.img={data:n.cx.getImageData(0,0,W,H),w:W,h:H,gray:false,rev:(n.img?.rev|0)+1}; n.fpsN++; n.shown=true;
        n.from=SyLink.devices().find(d=>d.p===n.fromP)?.label||n.fromP?.name||'';
      }).catch(()=>{}).finally(()=>{ n.dec=false; });
    }
    if(now-n.fpsT>=1000){ n.fpsV=n.fpsN*1000/(now-n.fpsT); n.fpsN=0; n.fpsT=now; }
    const live=n.shown && now-n.rxT<3000;
    n.status=!SyLink.on ? 'sync is off: open “Sync devices”, enter the key and tick “keep in sync”'
      : live ? '«'+n.p.label+'» from '+n.from+' '+n.cv.width+'×'+n.cv.height+' · '+n.fpsV.toFixed(1)+' fps · '+n.rxN+' frames, '+(n.rxBytes/1048576).toFixed(1)+' MB'
      : n.rxN ? 'stream «'+n.p.label+'» stopped' : 'waiting for the stream «'+n.p.label+'»';
    return {img:n.img, active:live ? 1 : 0, fps:n.fpsV, from:n.from}; },
  draw(n,cv,cx){
    if(n.ro) n.ro.textContent=n.status;
    if(cv && n.shown && n.cv.width) cx.drawImage(n.cv,0,0,cv.width,cv.height); }
});
