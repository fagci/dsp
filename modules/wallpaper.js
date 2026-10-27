"use strict";
/* ============================ Живые обои из любого холста (приложение Android) ============================
   Кнопка 🖼 рядом с ⧉ (в заголовке узла и в дашборде) — на спектре, водопаде, осциллографе, карте, любой картинке. Источник
   кадра — тот же pipSource(n), что у PiP (modules/pip.js): свой кадр у камеры / архива кадров, иначе холст узла целиком.
   Кадр сжимается в небольшой JPEG (пара сотен точек по длинной стороне хватает для фона экрана) и уходит через JS-интерфейс
   приложения (DspApp.wallpaper) в LiveWallpaperService — тот рисует последний присланный кадр на рабочем столе / экране
   блокировки. «Живым» фон остаётся, пока это окно на экране или в плавающем PiP: WebView (как и браузер) не рисует невидимую
   страницу, так что без этого кадры просто перестанут приходить — фон застынет на последнем, а не сломается. Браузер этого
   не умеет вовсе (нет такого API ни у Chrome, ни у других) — кнопка скрыта везде, кроме приложения. */

function wallpaperSupported(){ try{ return !!(window.DspApp && typeof DspApp.wallpaper==='function'); }catch(e){ return false; } }
let wpSt=null;              // {n, stop()} — текущий источник живых обоев

function wallpaperStop(){ const s=wpSt; wpSt=null; if(s){ if(s.n) s.n._wallpaper=false; try{ s.stop(); }catch(e){} } }

function wallpaperToggle(n){
  const c=n && pipSource(n); if(!c) return;
  if(wpSt && wpSt.n===n){ wallpaperStop(); return; }
  wallpaperStop();
  n._wallpaper=true;
  const cv=document.createElement('canvas'), cx=cv.getContext('2d',{willReadFrequently:false});
  let raf=0, last=0, stopped=false, busy=false;
  const tick=t=>{
    if(stopped) return;
    raf=requestAnimationFrame(tick);
    if(busy || t-last<160) return;                       // ~6 кадров/с — для фона достаточно, экономит батарею и JS-мост
    const w=c.width, h=c.height; if(!w || !h) return;
    last=t; busy=true;
    const k=Math.min(1,480/Math.max(w,h));                // небольшое разрешение — декодирует и масштабирует само приложение
    cv.width=Math.max(1,Math.round(w*k)); cv.height=Math.max(1,Math.round(h*k));
    cx.drawImage(c,0,0,cv.width,cv.height);
    cv.toBlob(b=>{
      busy=false;
      if(stopped || !b) return;
      const r=new FileReader();
      r.onload=()=>{ if(!stopped) try{ DspApp.wallpaper(String(r.result).split(',')[1]||''); }catch(e){} };
      r.readAsDataURL(b);
    },'image/jpeg',0.6);
  };
  raf=requestAnimationFrame(tick);
  wpSt={n, stop:()=>{ stopped=true; cancelAnimationFrame(raf); }};
}

// системный выбор «Задать живые обои» — один раз, отдельно от потока кадров (поток можно гнать и когда обои ещё не выбраны: приложение просто держит последний кадр про запас)
function wallpaperPick(){ try{ if(window.DspApp && typeof DspApp.wallpaperPick==='function') DspApp.wallpaperPick(); }catch(e){} }
