"use strict";
/* ============================ getDisplayMedia в приложении Android ============================
   WebView приложения не умеет getDisplayMedia (захват экрана / окна / вкладки), поэтому узлы Screen (video), запись экрана в Files, показ экрана
   в WebRTC и захват вкладки писали «not supported». Здесь он подменяется: служба приложения снимает экран сама (MediaProjection → ImageReader,
   команда моста screenrec.stream), присылает JPEG-кадры записями {src:'screen', w, h, jpg}, а страница рисует их на canvas и отдаёт captureStream().
   Системное согласие на запись экрана спрашивается на каждый запуск; в браузере (нет DspApp) ничего не меняется.
   Кадры идут по WebSocket моста: ≈8 к/с до 1280 px — для замера цвета, наблюдения и записи, не для видео. Звук не передаётся.
   Проверка разбора параметров — tools/test-displaymedia.mjs. */

// ограничения getDisplayMedia → параметры потока: кадров в секунду (1…15) и длинная сторона (320…1920 px)
function dmOptions(opts){
  const v=opts && typeof opts==='object' ? opts.video : null;
  let fps=8, maxSide=1280;
  if(v && typeof v==='object'){
    const num=x=>typeof x==='number' ? x : x && typeof x==='object' ? (x.ideal ?? x.max ?? x.exact) : undefined;
    const f=+num(v.frameRate); if(f>0) fps=Math.min(15,Math.max(1,Math.round(f)));
    const m=Math.max(+num(v.width)||0,+num(v.height)||0); if(m>0) maxSide=Math.min(1920,Math.max(320,Math.round(m)));
  }
  return {fps,maxSide};
}

function dmAppStream(opts){
  const o=dmOptions(opts);
  return new Promise((resolve,reject)=>{
    let key='', raw=''; try{ key=DspApp.appKey()||''; raw=String(DspApp.usbUrl()||''); }catch(e){}
    const tok=(/[?&]token=([^&]*)/.exec(raw)||[])[1];
    let url=typeof phoneUrl==='function' ? phoneUrl(raw.replace(/\/usb\?.*$/,'')||'ws://127.0.0.1:8765',key) : '';
    if(!url) return reject(new DOMException('no address of the DSP app bridge','NotSupportedError'));
    if(tok) url+=(url.includes('?') ? '&' : '?')+'token='+tok;
    const cv=document.createElement('canvas'), g=cv.getContext('2d'); cv.width=2; cv.height=2; g.fillStyle='#000'; g.fillRect(0,0,2,2);
    const stream=cv.captureStream(o.fps), track=stream.getVideoTracks()[0];
    let ws, done=false, started=false, busy=false, next=null;
    const ended=()=>{ try{ track.dispatchEvent(new Event('ended')); }catch(e){} };
    const finish=()=>{ if(done) return; done=true; try{ ws.send(JSON.stringify({cmd:'screenrec.stop',id:99})); }catch(e){} try{ ws.close(); }catch(e){} if(started) ended(); };
    const stopTrack=track.stop.bind(track); track.stop=()=>{ finish(); stopTrack(); };
    const timer=setTimeout(()=>{ finish(); reject(new DOMException('the screen recording was not allowed in time','NotAllowedError')); },120000);
    const pump=async()=>{
      if(busy || !next) return; busy=true; const r=next; next=null;
      try{
        const bmp=await createImageBitmap(await (await fetch('data:image/jpeg;base64,'+r.jpg)).blob());
        if(cv.width!==bmp.width || cv.height!==bmp.height){ cv.width=bmp.width; cv.height=bmp.height; }
        g.drawImage(bmp,0,0); if(bmp.close) bmp.close();
      }catch(e){}
      busy=false; if(next) pump();                       // пока рисовали, пришёл новее — старые кадры не копим
    };
    try{ ws=new WebSocket(url); }catch(e){ clearTimeout(timer); return reject(new DOMException(String(e.message||e),'NotSupportedError')); }
    ws.onopen=()=>{ ws.send(JSON.stringify({sub:['screen','sys']})); ws.send(JSON.stringify({cmd:'screenrec.stream',id:1,fps:o.fps,maxSide:o.maxSide})); };
    ws.onerror=()=>{ if(started) return; clearTimeout(timer); done=true; reject(new DOMException('the DSP app bridge is not available','NotSupportedError')); };
    ws.onclose=()=>{ clearTimeout(timer); if(done) return; done=true; if(started) ended(); else reject(new DOMException('the bridge closed','NotSupportedError')); };
    ws.onmessage=e=>{
      if(typeof e.data!=='string') return;
      let j; try{ j=JSON.parse(e.data); }catch(x){ return; }
      for(const r of Array.isArray(j) ? j : [j]){
        if(!r || typeof r!=='object') continue;
        if(r.src==='cmd' && r.cmd==='screenrec.stream'){
          clearTimeout(timer);
          if(r.ok){ started=true; resolve(stream); }
          else { done=true; try{ ws.close(); }catch(x){} reject(new DOMException(r.msg||'the screen recording was refused', r.err==='cancelled' ? 'NotAllowedError' : 'NotReadableError')); }
        } else if(r.src==='screen' && r.jpg){ next=r; pump(); }
        else if(r.src==='sys' && /^screenrec\.stop/.test(r.ev||'')) finish();      // остановили в уведомлении или система отозвала запись
      }
    };
  });
}

(function(){
  if(typeof DspApp==='undefined' || typeof DspApp.appKey!=='function') return;      // не приложение — настоящий getDisplayMedia браузера
  const md=navigator.mediaDevices;
  if(!md || typeof md.getDisplayMedia==='function') return;
  md.getDisplayMedia=opts=>dmAppStream(opts);
})();
