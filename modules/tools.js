"use strict";
/* ======================= ИНСТРУМЕНТЫ (для телефона) =======================
   Конвертер единиц, экранная линейка, высота, истинный север, уклономер / уровень / отвес, фонарик, шагомер.
   Датчики берутся с проводов (accel, orient, wssensor, termux…) — модули только считают и рисуют. Логика — в tools-kernels.js. */

const TLN=v=>typeof v==='number' && isFinite(v) ? v : null;
const tlDeg=v=>(Math.abs(v)<10 ? v.toFixed(1) : v.toFixed(0))+'°';
const tlIOS=()=>/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
const tlK=(tau)=>tau>0 ? 1-Math.exp(-(BLOCK/Eng.sr)/tau) : 1;
// вешается один раз на канву (draw вызывается каждый кадр)
function tlPointer(n,cv,h){
  if(n._wcv===cv) return; n._wcv=cv;
  const pos=ev=>{ const r=cv.getBoundingClientRect(); return [(ev.clientX-r.left)/r.width*cv.width,(ev.clientY-r.top)/r.height*cv.height]; };
  cv.style.touchAction='none'; cv.style.cursor='crosshair';
  let down=false;
  cv.addEventListener('pointerdown',ev=>{ ev.stopPropagation(); down=true; cv.setPointerCapture(ev.pointerId); h.down(...pos(ev)); });
  cv.addEventListener('pointermove',ev=>{ if(down) h.move(...pos(ev)); });
  cv.addEventListener('pointerup',()=>{ down=false; });
  cv.addEventListener('pointercancel',()=>{ down=false; });
}

/* ---- конвертер единиц ---- */
def({ id:'unitconv', lazy:'proc', title:'Unit Converter', cat:'Tools', readout:true, w:300,
  kw:'convert units length mass temperature speed pressure power dBm data bytes angle time frequency конвертер единицы измерения перевод',
  ins:[{n:'in',t:'num'}], outs:[{n:'out',t:'num'}],
  params:[{n:'cat',t:'select',opts:()=>tlCats(),d:'length',label:'quantity',
            fn:n=>{ const u=tlUnits(n.p.cat); setMod(n,'from',u[0]); setMod(n,'to',u[1]||u[0]); }},
          {n:'from',t:'select',opts:n=>tlUnits(n.p.cat),d:'m'},
          {n:'to',t:'select',opts:n=>tlUnits(n.p.cat),d:'ft'},
          {n:'value',t:'num',d:1,label:'value (used when the input pin is not wired)'},
          {n:'swap',t:'button',label:'⇄ swap',fn:n=>{ const a=n.p.from; setMod(n,'from',n.p.to); setMod(n,'to',a); }}],
  init:n=>{ n.v=null; n.r=null; n.f=''; n.t=''; },
  process(n,I){
    const U=tlUnits(n.p.cat), f=U.includes(n.p.from)?n.p.from:U[0], t=U.includes(n.p.to)?n.p.to:(U[1]||U[0]);
    const v=TLN(I.in)!==null ? I.in : +n.p.value;
    n.v=v; n.f=f; n.t=t; n.r=tlConvert(n.p.cat,f,t,v);
    return {out:n.r}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.r===null ? 'no value' : `${tlFmt(n.v)} ${n.f} = ${tlFmt(n.r)} ${n.t}`; }});

/* ---- экранная линейка ---- */
// CSS-пикселей в миллиметре: из диагонали экрана (диагональ в CSS-пикселях известна браузеру) или из ручной калибровки по карточке
const rlPx=n=>+n.p.diag>0 ? Math.hypot(screen.width,screen.height)/(+n.p.diag*25.4) : +n.p.scale;
function rlDraw(n,cv,cx){
  const W=cv.width, H=cv.height, px=rlPx(n), vert=n.p.orient==='vertical', L=vert?H:W, lenMm=L/px;
  const along=(mm,a)=>vert ? [a,mm*px] : [mm*px,a];            // точка по длине (мм) и поперёк (px от «своего» края)
  const line=(mm,a0,a1)=>{ const p=along(mm,a0), q=along(mm,a1); cx.moveTo(p[0],p[1]); cx.lineTo(q[0],q[1]); };
  cx.fillStyle=themeColor('--screen'); cx.fillRect(0,0,W,H);
  const across=vert?W:H, fs=Math.max(9,Math.min(14,across/9));
  indFont(cx,fs); cx.textBaseline='middle'; cx.textAlign='center';
  const side=(ticks,fromFar,len)=>{
    cx.beginPath(); cx.strokeStyle=themeColor('--scr-hi'); cx.lineWidth=1;
    for(const t of ticks){ const l=len(t)*px, a0=fromFar?across:0, a1=fromFar?across-l:l; line(t.pos,a0,a1); }
    cx.stroke();
    cx.fillStyle=themeColor('--scr-hi');
    for(const t of ticks) if(t.label){ const l=len(t)*px+fs*.8, p=along(t.pos,fromFar?across-l:l); cx.fillText(t.label,p[0],p[1]); }
  };
  side(tlRulerTicks(lenMm,false),false,t=>[2,3.5,5.5][t.level]);                            // мм / см — с «ближнего» края
  side(tlRulerTicks(lenMm,true),true,t=>t.len*2.4);                                          // дюймы — с дальнего
  if(n.p.card){                                                                                // карточка ISO 7810 — калибровка
    const cw=85.6*px, ch=53.98*px, o=across*.5-ch/2;
    cx.strokeStyle=themeColor('--acc2'); cx.lineWidth=1.5; cx.setLineDash([5,4]);
    if(vert) cx.strokeRect(o,12*px,ch,cw); else cx.strokeRect(12*px,o,cw,ch);
    cx.setLineDash([]); cx.fillStyle=themeColor('--acc2');
    cx.fillText('85.6 × 54 mm — match the scale to a bank card',W/2,vert?H/2:o+ch/2);
  }
  const m=[n.ma,n.mb].filter(v=>v!==null);
  for(const v of m){ cx.beginPath(); cx.strokeStyle=themeColor('--err'); cx.lineWidth=1.5; line(v,0,across); cx.stroke(); }
  if(n.ma!==null && n.mb!==null){
    cx.fillStyle=themeColor('--err'); indFont(cx,fs*1.3);
    const mid=along((n.ma+n.mb)/2,across*.5);
    cx.fillText(tlLenText(Math.abs(n.mb-n.ma)),vert?Math.min(W-60,Math.max(60,mid[0])):mid[0],vert?mid[1]:mid[1]);
  } else if(m.length===0 && !n.p.card){
    cx.fillStyle=themeColor('--axis'); indFont(cx,fs); cx.fillText('tap / drag to measure · double-tap ⤢ for fullscreen',W/2,H/2);
  }
}
def({ id:'ruler', lazy:true, title:'Screen Ruler', cat:'Tools', fs:true, resize:true, view:{h:150}, w:360, readout:true,
  kw:'ruler measure length mm inch cm screen линейка',
  params:[{n:'orient',t:'select',opts:['horizontal','vertical'],d:'horizontal'},
          {n:'scale',t:'range',min:2,max:10,step:.005,d:96/25.4,label:'scale, px per mm (96 dpi = 3.78): turn on «card» and match it to a real card'},
          {n:'card',t:'check',d:false,label:'card outline (for calibration)'},
          {n:'diag',t:'num',d:0,label:'screen diagonal, inches (0 — use the scale instead; the device reports its pixel size, you know its diagonal)'},
          {n:'clear',t:'button',label:'clear marks',fn:n=>{ n.ma=n.mb=null; n._dirty=true; }}],
  init:n=>{ n.ma=null; n.mb=null; },
  drawKey:n=>n.ma+'|'+n.mb,
  draw(n,cv,cx){
    tlPointer(n,cv,(()=>{
      const mm=(x,y)=>(n.p.orient==='vertical' ? y : x)/rlPx(n);
      let pick=null;
      return { down:(x,y)=>{ const v=mm(x,y);                // новая метка — в свободную, иначе двигаем ближнюю
          pick=n.ma===null ? 'a' : n.mb===null ? 'b' : Math.abs(v-n.ma)<=Math.abs(v-n.mb) ? 'a' : 'b';
          if(pick==='a') n.ma=v; else n.mb=v; n._dirty=true; },
        move:(x,y)=>{ const v=mm(x,y); if(pick==='a') n.ma=v; else n.mb=v; n._dirty=true; } };
    })());
    rlDraw(n,cv,cx);
    const r=n.el.querySelector('.readout');
    if(r) r.textContent=`${rlPx(n).toFixed(3)} px/mm`+(+n.p.diag>0?` (diagonal ${n.p.diag}″)`:''); }});

/* ---- высота ---- */
def({ id:'heightm', lazy:'proc', title:'Height Meter', cat:'Tools', readout:true, tall:true, w:320,
  kw:'height altitude tree building tower measure clinometer barometer pressure высота измеритель',
  ins:[{n:'el',t:'num'},{n:'p',t:'num'}], outs:[{n:'h',t:'num'},{n:'d',t:'num'}],
  params:[{n:'mode',t:'select',opts:['distance known','eye height','barometer'],d:'distance known',
            label:'distance known: you stand d metres from it · eye height: you stand anywhere, the distance comes from the angle to the base · barometer: pressure difference'},
          {n:'dist',t:'num',d:10,label:'distance to the object, m',if:n=>n.p.mode==='distance known'},
          {n:'eye',t:'num',d:1.6,label:'eye (phone) height above the ground, m',if:n=>n.p.mode==='eye height'},
          {n:'top',t:'button',label:'① Aim at the TOP → mark',if:n=>n.p.mode!=='barometer',fn:n=>{ if(n.cur!==null) n.top=n.cur; }},
          {n:'base',t:'button',label:'② Aim at the BASE → mark',if:n=>n.p.mode!=='barometer',fn:n=>{ if(n.cur!==null) n.base=n.cur; }},
          {n:'ref',t:'button',label:'Set reference here (barometer)',if:n=>n.p.mode==='barometer',fn:n=>{ if(n.pr!==null) n.p0=n.pr; }},
          {n:'clr',t:'button',label:'clear marks',fn:n=>{ n.top=n.base=null; n.p0=null; }}],
  init:n=>{ n.cur=null; n.pr=null; n.top=null; n.base=null; n.p0=null; n.h=null; n.d=null; n.note=''; },
  process(n,I){
    n.cur=TLN(I.el); n.pr=TLN(I.p); n.h=null; n.d=null; n.note='';
    const m=n.p.mode;
    if(m==='barometer'){
      if(n.pr===null) n.note='no pressure — wire a barometer (Termux / WebSocket sensor), hPa';
      else if(n.p0===null) n.note='press «Set reference here» at the bottom, then climb';
      else n.h=tlBaro(n.pr,n.p0);
    } else if(n.cur===null) n.note='no angle — wire Orientation → el (aim the back camera like a gun sight)';
    else if(n.top===null) n.note='aim at the top and press ①';
    else if(m==='distance known'){
      n.h=tlHeightDist(n.top,n.base===null ? 0 : n.base,+n.p.dist); n.d=+n.p.dist;
      if(n.base===null) n.note='base not marked — height above the eye level; mark the base for the full height';
    } else if(n.base===null) n.note='now aim at the base (the foot) and press ②';
    else { const r=tlHeightEye(n.top,n.base,+n.p.eye);
      if(r){ n.h=r.h; n.d=r.d; } else n.note='the base must be below the horizon (aim down, not at the horizon)'; }
    return {h:n.h,d:n.d}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const s=[];
    s.push(n.h!==null ? `height ${n.h.toFixed(2)} m  (${(n.h*3.28084).toFixed(1)} ft)` : 'height —');
    if(n.d!==null && n.p.mode==='eye height') s.push(`distance ${n.d.toFixed(1)} m`);
    if(n.p.mode!=='barometer') s.push(`now ${n.cur!==null ? tlDeg(n.cur) : '—'} · top ${n.top!==null ? tlDeg(n.top) : '—'} · base ${n.base!==null ? tlDeg(n.base) : '—'}`);
    else s.push(`p ${n.pr!==null ? n.pr.toFixed(1) : '—'} hPa · ref ${n.p0!==null ? n.p0.toFixed(1) : '—'}`);
    if(n.note) s.push(n.note);
    r.textContent=s.join('\n'); }});

/* ---- истинный север ---- */
def({ id:'declin', lazy:'proc', title:'True North (declination)', cat:'Tools', readout:true, w:280,
  kw:'declination magnetic true north compass heading склонение истинный север',
  ins:[{n:'az',t:'num'}], outs:[{n:'az',t:'num'}],
  params:[{n:'decl',t:'num',d:0,label:'magnetic declination, ° (east is +; look it up for your place, e.g. NOAA calculator)'}],
  init:n=>{ n.m=null; n.o=null; },
  process(n,I){
    n.m=TLN(I.az); n.o=n.m===null ? null : (((n.m+ +n.p.decl)%360)+360)%360;
    return {az:n.o}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.o===null ? 'no heading' : `magnetic ${n.m.toFixed(0)}° → true ${n.o.toFixed(0)}°`; }});

/* ---- уклономер / уровень / отвес ---- */
def({ id:'tilt', lazy:'proc', title:'Slope / Level / Plumb', cat:'Tools', fs:true, resize:true, view:{h:170}, w:340, readout:true,
  kw:'slope inclinometer clinometer gradient level bubble plumb tilt angle percent accelerometer уклон уровень отвес наклон',
  ins:[{n:'x',t:'num'},{n:'y',t:'num'},{n:'z',t:'num'}],
  outs:[{n:'slope',t:'num'},{n:'pct',t:'num'},{n:'x',t:'num'},{n:'y',t:'num'},{n:'level',t:'num'}],
  params:[{n:'view',t:'select',opts:['slope','bubble level','plumb'],d:'slope'},
          {n:'pose',t:'select',opts:['flat','upright'],d:'flat',label:'phone lies flat on the surface · stands upright against it'},
          {n:'tau',t:'range',min:0,max:1,step:.01,d:.15,label:'smoothing, s'},
          {n:'thr',t:'range',min:.1,max:3,step:.1,d:.5,label:'«level» threshold, °'},
          {n:'zero',t:'button',label:'Zero here (calibrate on a flat surface)',fn:n=>{
            if(!n.t0) return; setMod(n,'offX',+n.t0.x.toFixed(2)); setMod(n,'offY',+n.t0.y.toFixed(2)); }},
          {n:'offX',t:'num',d:0,label:'zero offset x, °',adv:true},
          {n:'offY',t:'num',d:0,label:'zero offset y, °',adv:true},
          {n:'flip',t:'select',opts:['auto','normal','inverted'],d:'auto',label:'sensor axes sign (iOS is inverted)',adv:true}],
  init:n=>{ n.sv=null; n.t=null; n.t0=null; },
  process(n,I){
    const a=[TLN(I.x),TLN(I.y),TLN(I.z)];
    if(a.includes(null)){ n.t=null; return {slope:null,pct:null,x:null,y:null,level:0}; }
    if(!n.sv) n.sv=a.slice(); else { const k=tlK(+n.p.tau); for(let i=0;i<3;i++) n.sv[i]+=(a[i]-n.sv[i])*k; }
    const sign=n.p.flip==='inverted' ? -1 : n.p.flip==='normal' ? 1 : (tlIOS() ? -1 : 1);
    const t0=tlTilt(n.sv[0],n.sv[1],n.sv[2],n.p.pose,sign);
    if(!t0){ n.t=null; return {slope:null,pct:null,x:null,y:null,level:0}; }
    n.t0=t0;
    const ox=+n.p.offX, oy=+n.p.offY;
    const t=Object.assign({},t0); t.x-=ox; t.y-=oy;
    if(ox || oy){ t.slope=Math.hypot(t.x,t.y); t.pct=Math.tan(t.slope*Math.PI/180)*100; }
    n.t=t;
    return {slope:t.slope,pct:isFinite(t.pct)?t.pct:null,x:t.x,y:t.y,level:t.slope<+n.p.thr?1:0}; },
  draw(n,cv,cx){
    const r=n.el.querySelector('.readout'), t=n.t, W=cv.width, H=cv.height;
    cx.fillStyle=themeColor('--screen'); cx.fillRect(0,0,W,H);
    if(!t){ indFont(cx,13); cx.fillStyle=themeColor('--axis'); cx.textAlign='center'; cx.textBaseline='middle';
      cx.fillText('wire accel → x y z (with gravity)',W/2,H/2); if(r) r.textContent=''; return; }
    const lvl=t.slope<+n.p.thr, ok=themeColor('--scr-ok'), hi=themeColor('--scr-hi'), ax=themeColor('--axis');
    const v=n.p.view; cx.textAlign='center'; cx.textBaseline='middle';
    if(v==='slope'){
      const R=Math.max(14,Math.min(H*.4,W*.22)), X=W-R-12, Y=H/2, f=Math.max(12,Math.min(H*.22,W*.1));
      cx.textAlign='left'; cx.fillStyle=lvl?ok:hi;
      indFont(cx,f*1.8); cx.fillText(t.slope.toFixed(1)+'°',12,H*.36);
      indFont(cx,f); cx.fillStyle=hi;
      cx.fillText(isFinite(t.pct) ? t.pct.toFixed(1)+' %' : '∞ %',12,H*.64);
      cx.fillStyle=ax; indFont(cx,f*.7);
      cx.fillText(t.pct>.05 && isFinite(t.pct) ? '1 : '+(100/t.pct).toFixed(1) : '',12,H*.84);
      cx.strokeStyle=ax; cx.lineWidth=1.5; cx.beginPath(); cx.arc(X,Y,R,0,7); cx.stroke();
      if(t.slope>.3){ const d=t.dir*Math.PI/180, px=X+Math.sin(d)*R*.8, py=Y-Math.cos(d)*R*.8;
        cx.strokeStyle=themeColor('--err'); cx.lineWidth=3; cx.beginPath(); cx.moveTo(X,Y); cx.lineTo(px,py); cx.stroke();
        cx.fillStyle=themeColor('--err'); cx.beginPath(); cx.arc(px,py,4,0,7); cx.fill(); }
      cx.textAlign='center'; cx.fillStyle=ax; indFont(cx,Math.max(8,R*.2)); cx.fillText('uphill',X,Y+R+9);
    } else if(v==='bubble level'){
      const R=Math.min(W,H)*.42, X=W/2, Y=H/2, M=10;
      cx.strokeStyle=ax; cx.lineWidth=1.5; cx.beginPath(); cx.arc(X,Y,R,0,7); cx.stroke();
      cx.lineWidth=1; cx.beginPath(); cx.arc(X,Y,R*.5,0,7); cx.moveTo(X-R,Y); cx.lineTo(X+R,Y); cx.moveTo(X,Y-R); cx.lineTo(X,Y+R); cx.stroke();
      let bx=t.x/M, by=-t.y/M; const bl=Math.hypot(bx,by); if(bl>1){ bx/=bl; by/=bl; }
      cx.fillStyle=lvl?ok:themeColor('--acc'); cx.beginPath(); cx.arc(X+bx*R*.88,Y+by*R*.88,R*.12,0,7); cx.fill();
      cx.fillStyle=hi; indFont(cx,Math.max(10,R*.17)); cx.textAlign='left'; cx.fillText(`x ${tlDeg(t.x)}`,8,12);
      cx.textAlign='right'; cx.fillText(`y ${tlDeg(t.y)}`,W-8,12);
    } else {
      const L=H-34, X=W/2, ang=t.x*Math.PI/180, bx=X-Math.sin(ang)*L, by=8+Math.cos(ang)*L;
      cx.strokeStyle=ax; cx.setLineDash([4,4]); cx.beginPath(); cx.moveTo(X,8); cx.lineTo(X,8+L); cx.stroke(); cx.setLineDash([]);
      cx.strokeStyle=lvl?ok:hi; cx.lineWidth=2; cx.beginPath(); cx.moveTo(X,8); cx.lineTo(bx,by); cx.stroke();
      cx.fillStyle=lvl?ok:themeColor('--acc'); cx.beginPath(); cx.arc(bx,by,9,0,7); cx.fill();
      cx.fillStyle=hi; indFont(cx,Math.max(11,Math.min(18,H*.12))); cx.textAlign='left'; cx.fillText(`lean ${tlDeg(t.x)}`,8,H-10);
      cx.textAlign='right'; cx.fillText(`fore/aft ${tlDeg(t.y)}`,W-8,H-10);
    }
    if(r) r.textContent=`slope ${t.slope.toFixed(1)}° · ${isFinite(t.pct) ? t.pct.toFixed(1) : '∞'} % · x ${t.x.toFixed(1)}° y ${t.y.toFixed(1)}°`; }});

/* ---- фонарик ---- */
async function tlTorchOpen(n){
  n.busy=true; n.err='';
  try{
    const st=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}});
    const tr=st.getVideoTracks()[0], caps=tr.getCapabilities ? tr.getCapabilities() : {};
    n.stream=st; n.track=tr; n.applied=false;
    if(!caps.torch){ n.err='this camera / browser has no torch (Chrome on Android only) — use mode «screen»'; }
  }catch(e){ n.err=e.name+': '+e.message; }
  n.busy=false;
}
function tlTorchClose(n){
  if(n.stream){ try{ n.stream.getTracks().forEach(t=>t.stop()); }catch(e){} }
  n.stream=null; n.track=null; n.applied=false; n.tried=false;
}
async function tlTorchApply(n,lit){
  n.abusy=true;
  try{ await n.track.applyConstraints({advanced:[{torch:lit}]}); n.applied=lit; n.err=''; }
  catch(e){ n.err='torch: '+e.message; n.applied=lit; }
  n.abusy=false;
}
def({ id:'torch', lazy:'proc', title:'Flashlight', cat:'Tools', fs:true, resize:true, view:{h:90}, w:300, readout:true,
  kw:'flashlight torch light flash led sos strobe фонарик',
  ins:[{n:'on',t:'num'}],
  params:[{n:'on',t:'check',d:false,label:'on'},
          {n:'mode',t:'select',opts:['camera flash','screen'],d:'camera flash',label:'camera flash: the phone LED (Chrome / Android, needs camera access) · screen: a white screen (double-tap for fullscreen)'},
          {n:'pattern',t:'select',opts:['steady','strobe','SOS'],d:'steady'},
          {n:'hz',t:'range',min:.5,max:8,step:.5,d:4,label:'strobe, Hz',if:n=>n.p.pattern==='strobe'}],
  init:n=>{ n.stream=null; n.track=null; n.busy=false; n.abusy=false; n.tried=false; n.lit=false; n.applied=false; n.err=''; },
  onStop:n=>tlTorchClose(n),
  dispose:n=>tlTorchClose(n),
  process(n,I){
    if(typeof I.on==='number') setMod(n,'on',I.on>=.5);
    const p=n.p, on=!!p.on;
    n.lit=on && tlTorchOn(p.pattern,+p.hz,performance.now()/1000);
    if(p.mode==='camera flash'){
      if(on && !n.track && !n.busy && !n.tried){ n.tried=true; tlTorchOpen(n); }
      if(!on){ n.tried=false; if(n.track) tlTorchClose(n); }
      if(n.track && !n.abusy && n.applied!==n.lit) tlTorchApply(n,n.lit);
    } else if(n.track) tlTorchClose(n);
    return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, scr=n.p.mode==='screen';
    cx.fillStyle=scr && n.lit ? '#fff' : themeColor('--screen'); cx.fillRect(0,0,W,H);
    if(!(scr && n.lit)){
      const R=Math.min(W,H)*.28;
      cx.fillStyle=n.lit ? '#ffd84a' : themeColor('--axis'); cx.beginPath(); cx.arc(W/2,H/2,R,0,7); cx.fill();
      if(n.lit){ cx.strokeStyle='#ffd84a'; cx.lineWidth=3; for(let i=0;i<12;i++){ const a=i*Math.PI/6;
        cx.beginPath(); cx.moveTo(W/2+Math.cos(a)*R*1.25,H/2+Math.sin(a)*R*1.25); cx.lineTo(W/2+Math.cos(a)*R*1.6,H/2+Math.sin(a)*R*1.6); cx.stroke(); } }
    }
    const r=n.el.querySelector('.readout');
    if(r) r.textContent=n.err || (n.p.on ? (n.p.mode==='screen' ? 'screen light' : n.track ? (n.lit?'LED on':'LED off') : 'opening the camera…') : 'off'); }});

/* ---- шагомер ---- */
def({ id:'steps', lazy:'proc', title:'Pedometer', cat:'Tools', readout:true, tall:true, w:300,
  kw:'pedometer steps walking step counter distance cadence шагомер шаги',
  ins:[{n:'x',t:'num'},{n:'y',t:'num'},{n:'z',t:'num'}],
  outs:[{n:'steps',t:'num'},{n:'spm',t:'num'},{n:'dist',t:'num'}],
  params:[{n:'stride',t:'range',min:.3,max:1.2,step:.01,d:.7,label:'stride length, m'},
          {n:'sens',t:'range',min:.3,max:3,step:.1,d:.8,label:'sensitivity: peak threshold, m/s² (lower — more sensitive)'},
          {n:'reset',t:'button',label:'Reset',fn:n=>{ n.S=tlStepNew(); }}],
  init:n=>{ n.S=tlStepNew(); n.has=false; },
  process(n,I){
    const x=TLN(I.x), y=TLN(I.y), z=TLN(I.z); n.has=x!==null && y!==null && z!==null;
    const S=n.S; S.minThr=+n.p.sens;
    if(n.has) tlStepPush(S,performance.now()/1000,Math.hypot(x,y,z));
    return {steps:S.count,spm:S.spm,dist:S.count*+n.p.stride}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const S=n.S;
    r.textContent=n.has ? `${S.count} steps\n${S.spm.toFixed(0)} steps/min · ${(S.count*+n.p.stride).toFixed(0)} m` : 'wire accel → x y z, start the graph (the screen stays on and a silent sound keeps the page alive)'; }});
