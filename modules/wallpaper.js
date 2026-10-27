"use strict";
/* ============================ Живые обои из любого холста (приложение Android) ============================
   Кнопка 🖼 рядом с ⧉ (в заголовке узла и в дашборде) — на спектре, водопаде, осциллографе, карте, любой картинке. Источник
   кадра — тот же pipSource(n), что у PiP (modules/pip.js): свой кадр у камеры / архива кадров, иначе холст узла целиком.
   Кадр сжимается в JPEG и уходит через JS-интерфейс приложения (DspApp.wallpaper) в LiveWallpaperService — тот рисует
   последний присланный кадр на рабочем столе / экране блокировки.

   Отрисовка узла (core-graph.js: frame()) и наш собственный захват кадра раньше держались на requestAnimationFrame —
   а rAF в точности останавливается, когда страница не видна (ушли на другой экран, экран погас): для PiP это не беда
   (страница и так на экране), а для обоев — это весь смысл и есть, фон должен жить именно когда страницы не видно.
   Поэтому пока страница скрыта, мы САМИ вызываем draw() нужного узла (minуя visible()/dashboard — проверено, что не ломает:
   draw() просто перекладывает уже посчитанное process()'ом состояние на холст) из wallpaperTick(), а её, в свою очередь,
   дёргает сам движок (Eng.tick, core-engine.js) на каждом аудио-такте — тот работает в фоне надёжно (то же самое, из-за
   чего «сенсоры работают с погашенным экраном», см. README): такты идут из AudioWorklet, а не из rAF. Пока страница видна,
   узел и так рисует обычный цикл — wallpaperTick() там только захватывает кадр, который уже на холсте. */

function wallpaperSupported(){ try{ return !!(window.DspApp && typeof DspApp.wallpaper==='function'); }catch(e){ return false; } }
let wpSt=null;              // {n, scratch:{cv,cx,busy}, lastDraw, stop()} — текущий источник живых обоев

const WP_MAXW=960, WP_Q=.8, WP_MIN_MS=220;             // ~900×900 на длинной стороне, JPEG 0.8, не чаще раза в 220 мс

function wallpaperStop(){ const s=wpSt; wpSt=null; if(s){ if(s.n) s.n._wallpaper=false; try{ s.stop(); }catch(e){} } }

// toDataURL — синхронно (в отличие от прежних toBlob+FileReader): кадр уходит сразу этим же вызовом, без лишнего круга
// по очереди задач, где колбэк могли придержать (в фоне именно это и раздувало промежутки между кадрами куда больше
// расчётных WP_MIN_MS — следующая попытка видела «прошлый кадр ещё кодируется» и откладывалась снова).
function wallpaperSend(n,scratch){
  try{
    const c=pipSource(n); if(!c) return;
    const w=c.width, h=c.height; if(!w || !h) return;
    const k=Math.min(1,WP_MAXW/Math.max(w,h));
    scratch.cv.width=Math.max(1,Math.round(w*k)); scratch.cv.height=Math.max(1,Math.round(h*k));
    scratch.cx.drawImage(c,0,0,scratch.cv.width,scratch.cv.height);
    const url=scratch.cv.toDataURL('image/jpeg',WP_Q);
    if(wpSt && wpSt.n===n) DspApp.wallpaper(url.split(',')[1]||'');
  }catch(e){} finally{ scratch.busy=false; }
}

// дёргается из Eng.tick (core-engine.js, см. комментарий выше) на каждый аудио-такт, и из собственного rAF, пока страница видна —
// throttle общий (lastDraw), так что какой из двух путей сейчас жив, тот и работает, без двойной отправки
function wallpaperTick(){
  if(!wpSt || wpSt.scratch.busy) return;                 // прошлый кадр ещё кодируется — ждём его, не трогая throttle ниже
  const now=performance.now();
  if(now-wpSt.lastDraw<WP_MIN_MS) return;
  wpSt.lastDraw=now;
  const n=wpSt.n;
  if(document.visibilityState!=='visible'){               // видна — её и так рисует обычный цикл (visible() знает про _wallpaper)
    const d=MOD[n.type];
    if(d && d.draw) try{ d.draw(n,n.cv,n.cx); }catch(e){}
  }
  wpSt.scratch.busy=true;
  wallpaperSend(n,wpSt.scratch);
}

function wallpaperToggle(n){
  const c=n && pipSource(n); if(!c) return;
  if(wpSt && wpSt.n===n){ wallpaperStop(); return; }
  wallpaperStop();
  n._wallpaper=true;
  const scratch={cv:document.createElement('canvas'),cx:null,busy:false}; scratch.cx=scratch.cv.getContext('2d');
  let raf=0, stopped=false;
  const rafTick=()=>{ if(stopped) return; raf=requestAnimationFrame(rafTick); wallpaperTick(); };
  raf=requestAnimationFrame(rafTick);
  wpSt={n, scratch, lastDraw:0, stop:()=>{ stopped=true; cancelAnimationFrame(raf); }};
}

// системный выбор «Задать живые обои» — один раз, отдельно от потока кадров (поток можно гнать и когда обои ещё не выбраны: приложение просто держит последний кадр про запас)
function wallpaperPick(){ try{ if(window.DspApp && typeof DspApp.wallpaperPick==='function') DspApp.wallpaperPick(); }catch(e){} }
