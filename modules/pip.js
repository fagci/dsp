"use strict";
/* ============================ Картинка в картинке для любого холста ============================
   Браузер (Chrome, Edge, Safari): холст → captureStream → скрытое <video> → requestPictureInPicture; видео-элемент тоже подходит.
   Приложение Android (WebView): у него нет PiP для видео, поэтому окно приложения целиком уходит в PiP, а страница на это время
   показывает только зеркало холста (DspApp.pip): кадры берутся из исходного холста каждый кадр анимации, то есть работает с любым.
   Вне поддержки кнопки нет. Ядро (пропорции) — pip-kernels.js. */

const pipToast=m=>{ try{ if(typeof showToast==='function') showToast(m); }catch(e){} };
let pipSt=null;            // {n, stop()} — текущая картинка в картинке

function pipSupported(){
  try{
    if(window.DspApp && typeof DspApp.pip==='function') return true;
    return !!(document.pictureInPictureEnabled && typeof HTMLCanvasElement!=='undefined' && HTMLCanvasElement.prototype.captureStream);
  }catch(e){ return false; }
}

function pipStop(){ const s=pipSt; pipSt=null; if(s) try{ s.stop(); }catch(e){} }

async function nodePip(n){
  const c=n && n.cv; if(!c) return;
  if(pipSt && pipSt.n===n){ pipStop(); return; }                // повторное нажатие — закрыть
  pipStop();
  if(window.DspApp && typeof DspApp.pip==='function') return pipApp(n,c);
  return pipVideo(n,c);
}

// браузер: холст → видео → системное окно PiP
async function pipVideo(n,c){
  const v=document.createElement('video');
  v.muted=true; v.playsInline=true; v.srcObject=c.captureStream(30);
  v.style.cssText='position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.appendChild(v);
  const stop=()=>{ try{ v.srcObject.getTracks().forEach(t=>t.stop()); }catch(e){} try{ if(document.pictureInPictureElement===v) document.exitPictureInPicture(); }catch(e){} v.remove(); };
  try{
    await v.play();
    await v.requestPictureInPicture();
    v.addEventListener('leavepictureinpicture',()=>{ if(pipSt && pipSt.n===n){ pipSt=null; stop(); } },{once:true});
    pipSt={n,stop};
  }catch(e){ stop(); pipToast('Picture in picture: '+(e.message||e.name)); }
}

// приложение: зеркало холста на весь экран + PiP окна приложения; выход из PiP не закрывает зеркало — оно закрывается своей кнопкой
function pipApp(n,c){
  const ov=document.createElement('div');
  ov.style.cssText='position:fixed;inset:0;z-index:99998;background:#000;display:flex;align-items:center;justify-content:center';
  const m=document.createElement('canvas');
  m.style.cssText='max-width:100%;max-height:100%;object-fit:contain';
  const x=document.createElement('button'); x.textContent='✕'; x.title='Close';
  x.style.cssText='position:absolute;right:8px;top:8px;font-size:18px;padding:4px 10px;opacity:.7';
  ov.append(m,x); document.body.appendChild(ov);
  let raf=0, alive=true;
  const g=m.getContext('2d');
  const frame=()=>{
    if(!alive) return;
    if(c.width && c.height){ if(m.width!==c.width || m.height!==c.height){ m.width=c.width; m.height=c.height; } g.drawImage(c,0,0); }
    raf=requestAnimationFrame(frame);
  };
  frame();
  const stop=()=>{ alive=false; cancelAnimationFrame(raf); ov.remove(); try{ DspApp.pipOff(); }catch(e){} window.dspPip=null; };
  x.onclick=()=>{ if(pipSt && pipSt.n===n) pipStop(); else stop(); };
  window.dspPip=()=>{};                                                       // приложение сообщает о входе / выходе из PiP; зеркало остаётся до закрытия
  pipSt={n,stop};
  const r=pipRatio(c.width,c.height);
  try{ if(!DspApp.pip(r[0],r[1])) pipToast('Picture in picture is not available on this phone'); }catch(e){ pipToast('Picture in picture: '+e.message); }
}
