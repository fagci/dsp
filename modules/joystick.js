"use strict";
/* ============================ Joystick (экран + клавиатура) ============================
   Два стика и 8 кнопок: мышью / пальцами и с клавиатуры (WASD — левый стик, стрелки — правый, Пробел, Enter, Z X Q E R F — кнопки).
   Выходы — числа, запись и готовый кадр текстом по шаблону: на Serial Out, BLE UART, MQTT Out, Text over Network, nRF24.
   Esc — аварийная остановка (всё в ноль, пока не нажато Resume). Ядро — control-kernels.js. */

const JOY_AXES=['x1','y1','x2','y2'], JOY_BN=[1,2,3,4,5,6,7,8];
const JOY_HINT=['␣','↵','Z','X','Q','E','R','F'];

function joyLayout(W,H){
  const R=Math.max(20,Math.min(W*.2,(H-76)*.4)), cy=Math.max(R+24,(H-20)/2+6);
  return {R, cy, lx:W*.25, rx:W*.75, by:H-14, br:Math.min(11,W/22), bx:i=>W*(.1+.8*i/7)};
}
function joyKeyHandler(n,down){
  return ev=>{
    if(n.p.kbd==='when focused' && !n.jfocus) return;
    const a=document.activeElement, tag=a?.tagName;
    if(a && a!==n.jcv && (tag==='INPUT' || tag==='TEXTAREA' || tag==='SELECT' || a.isContentEditable)) return;
    if(ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if(ev.code==='Escape'){ if(down){ n.jstop=true; n.jkeys.clear(); } return; }
    if(!JOY_KEYS[ev.code]) return;
    ev.preventDefault();
    if(down) n.jkeys.add(ev.code); else n.jkeys.delete(ev.code);
  };
}
function joyWire(n,cv){
  if(n._wired===cv) return; n._wired=cv; n.jcv=cv;
  cv.tabIndex=0; cv.style.touchAction='none'; cv.style.outline='none'; cv.classList.add('ownpinch');
  const pos=ev=>{ const r=cv.getBoundingClientRect(), k=cv.width/r.width; return [(ev.clientX-r.left)*k,(ev.clientY-r.top)*k]; };
  const apply=(ev,s)=>{ const L=joyLayout(cv.width,cv.height), [x,y]=pos(ev), cx=s.side==='l' ? L.lx : L.rx;
    s.v=[Math.max(-1,Math.min(1,(x-cx)/L.R)), Math.max(-1,Math.min(1,-(y-L.cy)/L.R))]; };
  cv.addEventListener('pointerdown',ev=>{
    ev.stopPropagation(); cv.focus(); n.jfocus=true; cv.setPointerCapture(ev.pointerId);
    const L=joyLayout(cv.width,cv.height), [x,y]=pos(ev);
    for(let i=0;i<8;i++) if(Math.hypot(x-L.bx(i),y-L.by)<=L.br+4){ n.jptr.set(ev.pointerId,{btn:i}); return; }
    const side=x<cv.width/2 ? 'l' : 'r';
    for(const s of n.jptr.values()) if(s.side===side) return;          // у стика уже есть палец
    const s={side,v:[0,0]}; apply(ev,s); n.jptr.set(ev.pointerId,s);
  });
  cv.addEventListener('pointermove',ev=>{ const s=n.jptr.get(ev.pointerId); if(s && s.side) apply(ev,s); });
  const up=ev=>{ n.jptr.delete(ev.pointerId); };
  cv.addEventListener('pointerup',up); cv.addEventListener('pointercancel',up);
  cv.addEventListener('focus',()=>{ n.jfocus=true; });
  cv.addEventListener('blur',()=>{ n.jfocus=false; n.jkeys.clear(); });
}

def({ id:'joystick', title:'Joystick (screen + keyboard)', cat:'Sources', always:true,
  kw:'joystick stick keyboard wasd arrows control remote rc drone robot rover virtual gamepad pad throttle',
  // ex1…ey2 — внешние оси (например, с Gamepad): подключённый провод заменяет экранный и клавиатурный ввод этой оси
  ins:[{n:'ex1',t:'num'},{n:'ey1',t:'num'},{n:'ex2',t:'num'},{n:'ey2',t:'num'}],
  outs:[{n:'x1',t:'num'},{n:'y1',t:'num'},{n:'x2',t:'num'},{n:'y2',t:'num'},
        ...JOY_BN.map(i=>({n:'b'+i,t:'num'})), {n:'text',t:'txt'},{n:'rec',t:'rec'},{n:'on',t:'num'}],
  w:380, view:{h:210}, resize:true,
  params:[{n:'kbd',t:'select',opts:['when focused','always'],d:'when focused',label:'keyboard: only while the pad is focused (click it), or always (not while typing in a field)'},
          {n:'ramp',t:'range',min:0,max:1,step:.01,d:.15,label:'keyboard ramp, s to full deflection (0 — instant)',adv:true},
          {n:'dead',t:'range',min:0,max:.5,step:.01,d:.05,label:'dead zone',adv:true},
          {n:'expo',t:'range',min:0,max:1,step:.01,d:0,label:'expo (softer near the centre)',adv:true},
          {n:'hold',t:'select',opts:['none','left Y','right Y'],d:'none',label:'stick Y that keeps its value (throttle): keys move it, the stick does not spring back'},
          {n:'tpl',t:'text',d:'J {x1} {y1} {x2} {y2} {bits}',label:'frame: {x1} {y1} {x2} {y2} −1…1 · {X1}… −100…100 · {r1}…{r4} 1000…2000 µs · {b1}…{b8} {bits} · {hex} 7-byte frame · {n} counter · {t} ms'},
          {n:'rate',t:'range',min:0,max:50,step:1,d:10,label:'frames per second while active (0 — only when something changes)'},
          {n:'keep',t:'check',d:false,label:'keep-alive: send frames while idle too'},
          {n:'id',t:'text',d:'joy',label:'record id',adv:true},
          {n:'resume',t:'button',label:'Resume after Esc',fn:n=>{ n.jstop=false; }},
          {n:'stopb',t:'button',label:'Emergency stop',fn:n=>{ n.jstop=true; n.jkeys.clear(); }}],
  init:n=>{ n.jkeys=new Set(); n.jptr=new Map(); n.jpos={x1:0,y1:0,x2:0,y2:0}; n.jout={x1:0,y1:0,x2:0,y2:0,b:[0,0,0,0,0,0,0,0]};
            n.jt=0; n.jframe=''; n.jframeN=0; n.jnext=0; n.jlast=''; n.jidle=true; n.jrec=null; n.jstop=false; n.jfocus=false; n.jcv=null; n.jsent=0;
            n.onDown=joyKeyHandler(n,true); n.onUp=joyKeyHandler(n,false);
            window.addEventListener('keydown',n.onDown); window.addEventListener('keyup',n.onUp); },
  dispose:n=>{ window.removeEventListener('keydown',n.onDown); window.removeEventListener('keyup',n.onUp); },
  process(n,I){
    const now=performance.now(), dt=n.jt ? Math.min(.1,(now-n.jt)/1000) : 0; n.jt=now;
    const p=n.p, tg=joyTarget(n.jkeys), holdAx=p.hold==='left Y' ? 'y1' : p.hold==='right Y' ? 'y2' : null;
    const ex={x1:recNum(I.ex1),y1:recNum(I.ey1),x2:recNum(I.ex2),y2:recNum(I.ey2)};
    const pv={x1:null,y1:null,x2:null,y2:null}, pb=[0,0,0,0,0,0,0,0];
    for(const s of n.jptr.values()){
      if(s.btn!=null) pb[s.btn]=1;
      else if(s.side==='l'){ pv.x1=s.v[0]; pv.y1=s.v[1]; } else { pv.x2=s.v[0]; pv.y2=s.v[1]; }
    }
    for(const a of JOY_AXES){
      if(ex[a]!=null) n.jpos[a]=Math.max(-1,Math.min(1,ex[a]));
      else if(pv[a]!=null) n.jpos[a]=pv[a];
      else if(a===holdAx) n.jpos[a]=Math.max(-1,Math.min(1,n.jpos[a]+tg[a]*dt/2));               // газ: ключи двигают, значение держится
      else n.jpos[a]=joyStep(n.jpos[a],tg[a],dt,+p.ramp);
    }
    const o=n.jout, prev=JSON.stringify(o);
    for(const a of JOY_AXES) o[a]=n.jstop ? 0 : joyShape(n.jpos[a],+p.dead,+p.expo);
    for(let i=0;i<8;i++) o.b[i]=n.jstop ? 0 : (tg.b[i]||pb[i] ? 1 : 0);
    const active=JOY_AXES.some(a=>o[a]!==0) || o.b.some(Boolean), changed=JSON.stringify(o)!==prev;
    // кадр: по таймеру, пока что-то нажато (или keep-alive); при отпускании — ещё один нулевой кадр
    const rate=+p.rate, period=rate>0 ? 1000/rate : 0;
    let emit=false;
    if(active || p.keep){ if(period ? now>=n.jnext : changed){ emit=true; n.jidle=false; } }
    else if(!n.jidle){ emit=true; n.jidle=true; }
    if(emit){
      n.jnext=now+period; n.jframeN++;
      n.jframe=joyFormat(p.tpl,o,n.jframeN,Date.now()); n.jsent++;
      n.jrec={t:Date.now(), id:p.id||'joy', label:'joystick', x1:o.x1, y1:o.y1, x2:o.x2, y2:o.y2, bits:joyBits(o.b), ...(n.jstop ? {stopped:true} : {})};
    }
    const res={x1:o.x1,y1:o.y1,x2:o.x2,y2:o.y2,text:n.jframe||null,rec:n.jrec,on:active ? 1 : 0};
    n.jrec=null;
    for(let i=0;i<8;i++) res['b'+(i+1)]=o.b[i];
    return res;
  },
  draw(n,cv,cx){
    joyWire(n,cv);
    const W=cv.width, H=cv.height, L=joyLayout(W,H), o=n.jout, col=themeColor('--acc')||'#7dff9a', dim=themeColor('--dim')||'#6c7a80';
    cx.fillStyle=themeColor('--screen')||'#0a0d0e'; cx.fillRect(0,0,W,H);
    cx.lineWidth=n.jfocus ? 2 : 1; cx.strokeStyle=n.jfocus ? col : (themeColor('--axis')||'#2a3a40'); cx.strokeRect(.5,.5,W-1,H-1);
    const stick=(x0,key,hx,hy,name,hint)=>{
      cx.lineWidth=1; cx.strokeStyle=dim; cx.beginPath(); cx.arc(x0,L.cy,L.R,0,7); cx.stroke();
      cx.globalAlpha=.4; cx.beginPath(); cx.moveTo(x0-L.R,L.cy); cx.lineTo(x0+L.R,L.cy); cx.moveTo(x0,L.cy-L.R); cx.lineTo(x0,L.cy+L.R); cx.stroke(); cx.globalAlpha=1;
      const dx=n.jpos[hx]*L.R, dy=-n.jpos[hy]*L.R;
      cx.strokeStyle=col; cx.beginPath(); cx.moveTo(x0,L.cy); cx.lineTo(x0+dx,L.cy+dy); cx.stroke();
      cx.fillStyle=n.jstop ? '#c23b3b' : col; cx.globalAlpha=.85; cx.beginPath(); cx.arc(x0+dx,L.cy+dy,Math.max(7,L.R*.22),0,7); cx.fill(); cx.globalAlpha=1;
      cx.fillStyle=dim; cx.font='10px monospace'; cx.textAlign='center'; cx.textBaseline='alphabetic';
      cx.fillText(name+'  '+hint,x0,L.cy+L.R+12);
      cx.fillText(o[hx].toFixed(2)+' / '+o[hy].toFixed(2),x0,L.cy-L.R-4);
    };
    stick(L.lx,'l','x1','y1','L','W A S D'); stick(L.rx,'r','x2','y2','R','↑ ← ↓ →');
    for(let i=0;i<8;i++){
      const x=L.bx(i), on=o.b[i];
      cx.beginPath(); cx.arc(x,L.by,L.br,0,7);
      if(on){ cx.fillStyle=col; cx.fill(); } else { cx.strokeStyle=dim; cx.lineWidth=1; cx.stroke(); }
      cx.fillStyle=on ? '#000' : dim; cx.font='10px monospace'; cx.textAlign='center'; cx.textBaseline='middle'; cx.fillText(JOY_HINT[i],x,L.by);
    }
    cx.textAlign='left'; cx.textBaseline='top'; cx.font='10px monospace';
    if(n.jstop){ cx.fillStyle='#ff6b6b'; cx.fillText('STOPPED (Esc) — press Resume',6,4); }
    else { cx.fillStyle=dim; cx.fillText(n.jfocus ? 'keyboard on' : (n.p.kbd==='always' ? 'keyboard always on' : 'click the pad for the keyboard'),6,4); }
    if(n.jframe){ cx.textAlign='right'; cx.fillStyle=dim; cx.fillText(n.jframe.slice(0,40)+' · '+n.jsent,W-6,4); }
  }});
