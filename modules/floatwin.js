"use strict";
/* ============================ Окна поверх других приложений (приложение Android) ============================
   Кнопка 🗔 рядом с 🖼 (в заголовке узла и в дашборде): кадр холста узла уходит в плавающее окно поверх всех приложений
   (DspApp.floatFrame → FloatWin.kt, окно двигается пальцем, ◢ меняет ширину, × закрывает). Окон может быть несколько — по одному на узел:
   так собирается «панель наблюдения» — Text Panel с цветным текстом и графиками, Gauge, Tank, спектр, карта, любой холст.
   Кадры берутся как для живых обоев (modules/wallpaper.js): тот же pipSource(n), тот же приём — пока страница скрыта, мы сами
   вызываем draw() узла из такта движка (Eng.tick), потому что requestAnimationFrame в фоне стоит. Кроме того, окно на телефоне само
   просит страницу снять кадр (FloatWin.pump → floatTick) — таймеры скрытой страницы Android душит, а вызов из нативного кода нет. Нужно разрешение
   «Показ поверх других окон» — при первом нажатии откроется системный экран. */

function floatSupported(){ try{ return !!(window.DspApp && typeof DspApp.floatShow==='function'); }catch(e){ return false; } }

const FL_MAXW=640, FL_MIN_MS=120;                      // ~8 кадров/с; нативный толкатель (FloatWin.pump) дёргает floatTick каждые ~150 мс, даже когда страница в фоне
const flSt=new Map();                 // id узла → {n, scratch:{cv,cx,busy}, lastDraw}
let flRaf=0;

function floatOff(id){
  const s=flSt.get(id); if(!s) return;
  s.n._float=false; flSt.delete(id);
  try{ DspApp.floatClose(id); }catch(e){}
}
// окно закрыли крестиком на самом телефоне
function floatClosed(id){ id=String(id); const s=flSt.get(id); if(s){ s.n._float=false; flSt.delete(id); } }

// webp сохраняет прозрачность и в несколько раз легче png; если WebView его не умеет, toDataURL отдаёт png
function floatSend(s){
  try{
    const n=s.n, c=pipSource(n); if(!c) return;
    const w=c.width, h=c.height; if(!w || !h) return;
    const k=Math.min(1,FL_MAXW/Math.max(w,h)), cv=s.scratch.cv;
    cv.width=Math.max(1,Math.round(w*k)); cv.height=Math.max(1,Math.round(h*k));
    s.scratch.cx.clearRect(0,0,cv.width,cv.height);
    s.scratch.cx.drawImage(c,0,0,cv.width,cv.height);
    const url=cv.toDataURL('image/webp',.85);
    if(flSt.get(String(n.id))===s) DspApp.floatFrame(String(n.id),url.split(',')[1]||'');
  }catch(e){} finally{ s.scratch.busy=false; }
}

// дёргается из Eng.tick (core-engine.js) на каждый аудио-такт и из собственного rAF, пока страница видна
function floatTick(){
  if(!flSt.size) return;
  const now=performance.now();
  for(const [id,s] of flSt){
    if(Graph.map[s.n.id]!==s.n){ floatOff(id); continue; }               // узел удалили
    if(s.scratch.busy || now-s.lastDraw<FL_MIN_MS) continue;
    s.lastDraw=now;
    if(document.visibilityState!=='visible'){
      const d=MOD[s.n.type];
      if(d && d.draw) try{ d.draw(s.n,s.n.cv,s.n.cx); }catch(e){}
    }
    s.scratch.busy=true; floatSend(s);
  }
}
function floatLoop(){
  if(flRaf || !flSt.size) return;
  const f=()=>{ if(!flSt.size){ flRaf=0; return; } flRaf=requestAnimationFrame(f); floatTick(); };
  flRaf=requestAnimationFrame(f);
}

function floatToggle(n){
  // Video Player в приложении: окно поверх с нативным плеером (ExoPlayer), а не кадры холста — так играет и поток без CORS
  if(n && MOD[n.type].vidEl && typeof vpFloat==='function' && typeof vpNativeCan==='function' && vpNativeCan()){ vpFloat(n); return; }
  if(!n || !pipSource(n)) return;
  const id=String(n.id);
  if(flSt.has(id)){ floatOff(id); return; }
  let ok=false;
  try{ ok=DspApp.floatCan() && DspApp.floatShow(id,JSON.stringify({opacity:.92,touch:floatWantsTouch(n)})); }catch(e){}
  if(!ok){ try{ DspApp.floatPerm(); }catch(e){} return; }                // разрешения нет — системный экран; после него нажать ещё раз
  const scratch={cv:document.createElement('canvas'),cx:null,busy:false}; scratch.cx=scratch.cv.getContext('2d');
  n._float=true; flSt.set(id,{n,scratch,lastDraw:0}); floatLoop();
}

// Узел принимает касания в плавающем окне, если у его холста есть свои обработчики: indWire (ручки, кнопки, шкалы), ownpinch
// (спектроанализатор, карта: свои щипок и сдвиг), touch-action:none, клавиатура — или модуль сам помечен touch:true.
function floatWantsTouch(n){
  const cv=n.cv, d=MOD[n.type]; if(!cv) return false;
  return !!(d && d.touch) || n._wcv===cv || n._kbcv===cv || cv.classList.contains('ownpinch') || cv.style.touchAction==='none';
}
// Касания окна (FloatWin.kt, режим touch) → pointer-события на canvas узла, в том числе несколькими пальцами.
// act: 0 вниз, 1 движение, 2 вверх; x, y — доли размера окна; pid — номер пальца. Настоящего pointerId у такого события нет, поэтому
// захват указателя (setPointerCapture / hasPointerCapture) на время касания подменён заглушкой — обработчики узлов считают его захваченным.
// Холсты со своим щипком (класс ownpinch: спектр, карта) получают пальцы как pointer-события; остальным два пальца превращаются в
// колесо (колесо мыши у них — масштаб), второй палец им не отдаётся. Системная клавиатура поверх чужих приложений недоступна
// (окно не берёт фокус), для ввода есть экранные Number Pad / Calculator.
function floatTouch(id,act,x,y,pid){
  const s=flSt.get(String(id)); if(!s) return;
  const n=s.n, cv=n.cv; if(!cv) return;
  const r=cv.getBoundingClientRect(); if(!r.width || !r.height) return;
  pid=pid|0; const tp=s.tp || (s.tp=new Map());
  const cX=r.left+x*r.width, cY=r.top+y*r.height, own=cv.classList.contains('ownpinch') || !!n._wcv || !!n._kbcv;
  const ev=(type,p,down)=>new PointerEvent(type,{pointerId:4242+p,pointerType:'touch',isPrimary:p===s.prim,bubbles:true,cancelable:true,
    clientX:cX,clientY:cY,button:0,buttons:down ? 1 : 0,pressure:down ? .5 : 0,width:1,height:1});
  const pinch=()=>{ const [a,b]=[...tp.values()]; return {d:Math.hypot(a.x-b.x,a.y-b.y),mx:(a.x+b.x)/2,my:(a.y+b.y)/2}; };
  if(act===0){
    if(!tp.size){
      cv.setPointerCapture=()=>{}; cv.hasPointerCapture=()=>true; cv.releasePointerCapture=()=>{}; s.prim=pid; s.moved=false; s.t0=[x,y];
    }
    tp.set(pid,{x:cX,y:cY});
    if(tp.size===2 && !own) s.pz=pinch().d;
    if(pid===s.prim || own) cv.dispatchEvent(ev('pointerdown',pid,true));
  } else if(tp.has(pid)){
    if(act===1){
      tp.set(pid,{x:cX,y:cY});
      if(s.t0 && Math.hypot((x-s.t0[0])*r.width,(y-s.t0[1])*r.height)>6) s.moved=true;
      if(tp.size>=2 && !own){
        const q=pinch(); if(s.pz && Math.abs(q.d-s.pz)>1){
          cv.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:q.mx,clientY:q.my,deltaY:(s.pz-q.d)*1.5,deltaMode:0})); s.pz=q.d; s.moved=true; }
      } else if(pid===s.prim || own) cv.dispatchEvent(ev('pointermove',pid,true));
    } else {
      if(pid===s.prim || own) cv.dispatchEvent(ev('pointerup',pid,false));
      const wasMoved=s.moved; tp.delete(pid);
      if(!tp.size){
        if(!wasMoved) cv.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:cX,clientY:cY}));
        delete cv.setPointerCapture; delete cv.hasPointerCapture; delete cv.releasePointerCapture; s.t0=null; s.pz=0;
      } else if(pid===s.prim && !own){ s.prim=[...tp.keys()][0]; }
    }
  }
  s.lastDraw=0;                                     // кадр с результатом жеста — без ожидания
}
