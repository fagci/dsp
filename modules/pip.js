"use strict";
/* ============================ Картинка в картинке для любого холста ============================
   Браузер (Chrome, Edge, Safari): холст → captureStream → скрытое <video> → requestPictureInPicture; видео-элемент тоже подходит.
   Приложение Android (WebView): у него нет PiP для видео, поэтому окно приложения целиком уходит в PiP, а страница на это время
   показывает только зеркало холста (DspApp.pip): кадры берутся из исходного холста каждый кадр анимации, то есть работает с любым.
   Вне поддержки кнопки нет. Ядро (пропорции) — pip-kernels.js. */

const pipToast=m=>{ try{ if(typeof showToast==='function') showToast(m); }catch(e){} };
// что зеркалить: у узлов-картинок (камера, кадр) — сам кадр, а не холст узла со всеми полями и подписями вокруг него
const PIP_SRC={ipcam:n=>n.img && n.capCv, camarch:n=>n.capCv, imgview:n=>n.tmp, vplayer:n=>typeof vpFrame==='function' && vpFrame(n)};
function pipSource(n){
  try{ const f=PIP_SRC[n.type], s=f && f(n); if(s && s.width && s.height) return s; }catch(e){}
  return n.cv;
}
let pipSt=null;            // {n, stop()} — текущая картинка в картинке

function pipSupported(){
  try{
    if(window.DspApp && typeof DspApp.pip==='function') return true;
    return !!(document.pictureInPictureEnabled && typeof HTMLCanvasElement!=='undefined' && HTMLCanvasElement.prototype.captureStream);
  }catch(e){ return false; }
}

function pipStop(){ const s=pipSt; pipSt=null; if(s){ if(s.n) s.n._pip=false; try{ s.stop(); }catch(e){} } }

async function nodePip(n){
  // <video> узла (Video Player): системное окно PiP самого элемента — со звуком и кнопками Media Session (перемотка, дорожки);
  // в приложении Android и где у элемента нет PiP — кадры через холст, как у остальных
  if(n && MOD[n.type].vidEl && n.v && n.v.requestPictureInPicture && !(window.DspApp && typeof DspApp.pip==='function')){
    if(document.pictureInPictureElement===n.v){ try{ await document.exitPictureInPicture(); }catch(e){} return; }
    pipStop();
    try{ await n.v.requestPictureInPicture(); }
    catch(e){ if(typeof vpStatus==='function') vpStatus(n,'picture in picture: '+(e.message||e.name)+(n.v.readyState<1 ? ' (start the video first)' : '')); return; }
    pipSt={n,stop:()=>{ try{ if(document.pictureInPictureElement) document.exitPictureInPicture(); }catch(e){} }};
    n.v.addEventListener('leavepictureinpicture',()=>{ if(pipSt && pipSt.n===n) pipSt=null; },{once:true});
    return;
  }
  const c=n && pipSource(n); if(!c) return;
  if(pipSt && pipSt.n===n){ pipStop(); return; }                // повторное нажатие — закрыть
  pipStop();
  n._pip=true;                                                  // узел рисуется, даже когда в маленьком окне он за краем видимой области
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
  }catch(e){ n._pip=false; stop(); pipToast('Picture in picture: '+(e.message||e.name)); }
}

// приложение: зеркало холста на весь экран + PiP окна приложения; выход из PiP не закрывает зеркало — оно закрывается своей кнопкой.
// Размер зеркала считается явно по окну (pipFit): окно PiP меняет размер уже после входа, а CSS «contain» у холста в разных WebView ведёт себя по-разному.
function pipApp(n,c0){
  const app=document.getElementById('app');
  const ov=document.createElement('div');
  ov.style.cssText='position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:99998;background:#000;overflow:hidden';
  const m=document.createElement('canvas');
  m.style.cssText='position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:block';
  // свой крест нужен только на весь экран: в окне PiP есть системный, а наш закрывал бы картинку
  const x=document.createElement('button'); x.textContent='✕'; x.title='Close';
  x.style.cssText='position:absolute;right:8px;top:8px;font-size:18px;padding:4px 10px;opacity:.7';
  ov.append(m,x); document.body.appendChild(ov);
  if(app) app.style.visibility='hidden';                        // остальная страница под зеркалом не нужна и не просвечивает
  let raf=0, alive=true;
  const g=m.getContext('2d');
  const frame=()=>{
    if(!alive) return;
    const c=pipSource(n);                                       // источник может смениться (кадр камеры появляется позже узла)
    if(c && c.width && c.height){
      if(m.width!==c.width || m.height!==c.height){ m.width=c.width; m.height=c.height; }
      g.drawImage(c,0,0);
      // размер окна — по видимой области: окно PiP уменьшается уже после входа, а 100vw / 100vh в WebView догоняют не сразу
      const vv=window.visualViewport;
      const W=Math.min(ov.clientWidth||1e9, vv ? vv.width : 1e9, innerWidth), H=Math.min(ov.clientHeight||1e9, vv ? vv.height : 1e9, innerHeight);
      const f=pipFit(c.width,c.height,W,H);
      if(m._fw!==f[0] || m._fh!==f[1]){ m._fw=f[0]; m._fh=f[1]; m.style.width=f[0]+'px'; m.style.height=f[1]+'px'; }
    }
    raf=requestAnimationFrame(frame);
  };
  frame();
  const stop=()=>{ alive=false; cancelAnimationFrame(raf); ov.remove(); if(app) app.style.visibility=''; try{ DspApp.pipOff(); }catch(e){} window.dspPip=null; };
  x.onclick=()=>{ if(pipSt && pipSt.n===n) pipStop(); else stop(); };
  window.dspPip=on=>{ x.style.display=on ? 'none' : ''; };      // приложение сообщает о входе / выходе из PiP; зеркало остаётся до закрытия
  pipSt={n,stop};
  const r=pipRatio(c0.width,c0.height);
  try{
    if(DspApp.pip(r[0],r[1])) x.style.display='none';
    else{ pipToast('Picture in picture is not available on this phone'); pipStop(); }
  }catch(e){ pipToast('Picture in picture: '+e.message); pipStop(); }
}
