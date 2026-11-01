"use strict";
/* ============================ ВВОД И ОТОБРАЖЕНИЕ ЧИСЕЛ / ЧАСТОТЫ ============================
   Number Pad (цифровая клавиатура: число или частота с GHz / MHz / kHz / Hz), Calculator (простой и инженерный, результат — на провод),
   Frequency Digits (разряды VFO: тап / свайп по цифре меняет её разряд), Number Readout (частота, SI, группы по три — в стиле LCD / VFD / LED).
   Всё рисуется на canvas и управляется pointer-событиями, поэтому работает и в плавающем окне поверх приложений
   (modules/floatwin.js пересылает туда касания) — системная клавиатура для этого не нужна. Клавиатура компьютера тоже работает:
   нажмите на узел и печатайте. Логика — в entry-kernels.js (tools/test-entry.mjs); помощники (indWire, indFont, indColor…) — из indicators.js. */

const EN_INK='#dfe8df', EN_DIM='#8a948a';                      // дисплеи всегда тёмные — цвета не из темы (в светлой теме --scr-hi тёмный)
const EN_UNITS=['Hz','kHz','MHz','GHz'], EN_U_MULT={Hz:1,kHz:1e3,MHz:1e6,GHz:1e9};
const enNum=v=>typeof v==='number' && isFinite(v) ? v : null;
// раскладка кнопок: keys = [{k, t (подпись), r, c, cs, kind}], rows × cols; top — высота дисплея сверху
function enLayout(W,H,top,rows,cols,keys){
  const g=Math.max(2,Math.min(W,H)*.02), kw=(W-g*(cols+1))/cols, kh=(H-top-g*(rows+1))/rows;
  return {g,top,rects:keys.map(q=>({q,x:g+q.c*(kw+g),y:top+g+q.r*(kh+g),w:kw*(q.cs||1)+g*((q.cs||1)-1),h:kh}))};
}
const enHit=(L,x,y)=>L.rects.find(r=>x>=r.x && x<=r.x+r.w && y>=r.y && y<=r.y+r.h);
function enDrawKeys(cx,L,n,col,font){
  const now=performance.now(), fl=n.fl;
  cx.textAlign='center'; cx.textBaseline='middle';
  for(const r of L.rects){
    const q=r.q, hot=fl && fl.k===q.k && now-fl.t<180, acc=q.kind==='go', op=q.kind==='op', fn=q.kind==='fn';
    cx.fillStyle=acc ? col : themeColor('--scr-panel');
    cx.globalAlpha=hot ? .55 : 1; cx.beginPath(); cx.roundRect(r.x,r.y,r.w,r.h,Math.min(8,r.h*.22)); cx.fill(); cx.globalAlpha=1;
    cx.strokeStyle=hot ? col : themeColor('--axis'); cx.lineWidth=hot ? 2 : 1; cx.stroke();
    cx.fillStyle=acc ? '#0b0d0e' : op ? col : fn ? themeColor('--axis') : themeColor('--scr-hi');
    indFont(cx,Math.min(r.h*.46,r.w*(q.t.length>2 ? .34 : .5),22)); cx.fillText(q.t,r.x+r.w/2,r.y+r.h/2+1);
  }
  cx.textAlign='start'; cx.textBaseline='alphabetic';
}
// подпись, уменьшенная до ширины w
function enFit(cx,s,w,px){
  indFont(cx,px); const m=cx.measureText(s).width; if(m>w) indFont(cx,Math.max(7,px*w/m));
}
// нажатие кнопки мыши / пальца и клавиша компьютера → одно действие; фокус на canvas, чтобы ловить клавиши
function enWire(n,cv,hit,press,keyOf){
  indWire(n,cv,{ down:(x,y)=>{ cv.focus && cv.focus({preventScroll:true}); const k=hit(x,y); if(k){ n.fl={k,t:performance.now()}; press(k); redraw(n); } } });
  if(n._kbcv!==cv){
    n._kbcv=cv; cv.tabIndex=0; cv.style.outline='none';
    cv.addEventListener('keydown',ev=>{
      if(ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const k=keyOf(ev); if(k){ ev.preventDefault(); ev.stopPropagation(); n.fl={k,t:performance.now()}; press(k); redraw(n); } });
  }
}

/* ---------- Number Pad ---------- */
const NP_KEYS=mode=>{
  const s=NP_SUFFIX[mode==='number' ? 'number' : 'frequency'], k=(t,r,c,kind,cs)=>({k:t,t,r,c,kind,cs});
  return [k('7',0,0),k('8',0,1),k('9',0,2),k(s[0],0,3,'op'),k('4',1,0),k('5',1,1),k('6',1,2),k(s[1],1,3,'op'),
          k('1',2,0),k('2',2,1),k('3',2,2),k(s[2],2,3,'op'),k('0',3,0),k('.',3,1),k('±',3,2,'fn'),k(s[3],3,3,'op'),
          k('C',4,0,'fn'),k('⌫',4,1,'fn'),k('ENT',4,2,'go',2)];
};
def({ id:'numpad', lazy:'proc', touch:true, title:'Number Pad', cat:'Indicators',
  kw:'keypad numeric entry type frequency digits keyboard input numbers enter calculator phone touch float',
  ins:[{n:'set',t:'num'}], outs:[{n:'out',t:'num'},{n:'live',t:'num'},{n:'enter',t:'num'}], view:{h:250}, w:230, resize:true,
  params:[{n:'mode',t:'select',opts:['frequency','number'],d:'frequency',label:'frequency — keys GHz / MHz / kHz / Hz (out in Hz); number — suffix keys M / k / m / µ'},
          {n:'unit',t:'select',opts:EN_UNITS,d:'MHz',label:'unit used by ENT (frequency mode)'},
          {n:'min',t:'num',d:0,label:'lowest value (clamp)'},{n:'max',t:'num',d:0,label:'highest value (clamp); 0 — no limit'},
          {n:'color',t:'text',d:'amber',label:'accent: '+IND_COLORS.join(', ')+' or #rrggbb'},
          {n:'state',t:'text',d:'',hidden:true}],
  init:n=>{ n.st=npNew(); const v=parseFloat(n.p.state); n.st.out=isFinite(v) ? v : null; n.lastSet=null; n.fl=null; },
  process(n,I){
    const p=n.p, st=n.st, v=enNum(I.set);
    if(v!==null && v!==n.lastSet){ n.lastSet=v; st.out=v; st.buf=''; n.p.state=String(v); }
    const pulse=st.pulse>0 ? 1 : 0; if(st.pulse>0) st.pulse--;
    const mult=p.mode==='number' ? 1 : EN_U_MULT[p.unit]||1, live=npValue(st.buf);
    return {out:st.out, live:live===null ? null : live*mult, enter:pulse}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, st=n.st, col=indColor(p.color), mode=p.mode==='number' ? 'number' : 'frequency';
    const keys=NP_KEYS(mode), top=Math.max(34,H*.2), L=enLayout(W,H,top,5,4,keys);
    enWire(n,cv,(x,y)=>{ const r=enHit(enLayout(cv.width,cv.height,Math.max(34,cv.height*.2),5,4,NP_KEYS(n.p.mode==='number' ? 'number' : 'frequency')),x,y); return r ? r.q.k : null; },
      k=>{ const was=n.st.out; npPress(n.st,k,{mode:n.p.mode==='number' ? 'number' : 'frequency',unit:n.p.unit,min:+n.p.min,max:+n.p.max>+n.p.min ? +n.p.max : undefined});
        if(n.st.out!==was || n.st.pulse) n.p.state=String(n.st.out); },
      ev=>keyName(ev));
    cx.clearRect(0,0,W,H);
    cx.fillStyle='#0b0f0c'; cx.strokeStyle=themeColor('--axis'); cx.lineWidth=1.5; cx.beginPath(); cx.roundRect(2,2,W-4,top-2,6); cx.fill(); cx.stroke();
    const typing=st.buf!=='';
    let txt, unit;
    if(typing){ txt=st.buf; unit=mode==='frequency' ? p.unit : ''; }
    else { const f=fmtNum(st.out,mode==='frequency' ? {mode:'frequency',digits:7} : {mode:'si',digits:6}); txt=f.text; unit=f.unit; }
    cx.textAlign='right'; cx.textBaseline='middle'; cx.fillStyle=typing ? col : EN_INK; cx.globalAlpha=typing || st.out!==null ? 1 : .4;
    const ux=W-10; if(unit){ indFont(cx,Math.min(14,top*.3)); cx.fillStyle=EN_DIM; cx.fillText(unit,ux,top*.58); }
    const uw=unit ? cx.measureText(unit).width+8 : 0;
    cx.fillStyle=typing ? col : EN_INK; enFit(cx,txt+(typing ? '▏' : ''),W-24-uw,Math.min(top*.6,30)); cx.fillText(txt+(typing ? '▏' : ''),ux-uw,top*.5);
    cx.globalAlpha=1; cx.textAlign='start'; cx.textBaseline='alphabetic';
    enDrawKeys(cx,L,n,col); }
});

/* ---------- Calculator ---------- */
const CALC_BASIC=()=>{ const k=(t,r,c,kind)=>({k:t,t,r,c,kind});
  return [k('C',0,0,'fn'),k('⌫',0,1,'fn'),k('%',0,2,'fn'),k('÷',0,3,'op'),k('7',1,0),k('8',1,1),k('9',1,2),k('×',1,3,'op'),
          k('4',2,0),k('5',2,1),k('6',2,2),k('−',2,3,'op'),k('1',3,0),k('2',3,1),k('3',3,2),k('+',3,3,'op'),
          k('±',4,0,'fn'),k('0',4,1),k('.',4,2),k('=',4,3,'go')]; };
const CALC_SCI=deg=>{ const k=(t,r,c,kind)=>({k:t,t,r,c,kind});
  return [k('(',0,0,'fn'),k(')',0,1,'fn'),k('√',0,2,'fn'),k('x²',0,3,'fn'),k('sin',1,0,'fn'),k('cos',1,1,'fn'),k('tan',1,2,'fn'),k('^',1,3,'op'),
          k('ln',2,0,'fn'),k('log',2,1,'fn'),k('π',2,2,'fn'),k('ANS',2,3,'fn'),k('A',3,0,'fn'),k('B',3,1,'fn'),k('M+',3,2,'fn'),k('M−',3,3,'fn'),
          k('MR',4,0,'fn'),k('MC',4,1,'fn'),k('e',4,2,'fn'),{k:'DEG',t:deg ? 'deg' : 'rad',r:4,c:3,kind:'fn'}]; };
const calcSci=p=>p.layout==='scientific' || p.sci===true;          // sci — прежнее имя параметра в старых патчах
const calcKeys=(sci,deg)=>{ const b=CALC_BASIC().map(q=>({...q,r:q.r+(sci ? 5 : 0)})); return sci ? CALC_SCI(deg).concat(b) : b; };
def({ id:'keycalc', lazy:'proc', touch:true, title:'Pocket Calculator', cat:'Indicators',
  kw:'calculator calc maths arithmetic compute scientific sin cos sqrt memory ans result number feed port float',
  ins:[{n:'a',t:'num'},{n:'b',t:'num'}], outs:[{n:'out',t:'num'},{n:'text',t:'txt'}], view:{h:300}, w:240, resize:true,
  params:[{n:'layout',t:'select',opts:['simple','scientific'],d:'simple',label:'simple — big keys for a floating window; scientific — sin cos ln √ ^ memory, A / B inputs (a tap on the display switches)'},
          {n:'live',t:'check',d:false,label:'send the running result to «out» before pressing ='},
          {n:'digits',t:'range',min:4,max:15,step:1,d:12,label:'significant digits'},
          {n:'color',t:'text',d:'amber',label:'accent: '+IND_COLORS.join(', ')+' or #rrggbb'},
          {n:'state',t:'text',d:'',hidden:true}],
  init:n=>{ n.cs=calcNew(); const a=String(n.p.state||'').split(','); const r=parseFloat(a[0]), m=parseFloat(a[1]);
    if(isFinite(r)){ n.cs.res=r; n.cs.ans=r; } if(isFinite(m)) n.cs.mem=m; n.cs.deg=a[2]!=='rad'; n.ext={}; n.fl=null; },
  process(n,I){
    const cs=n.cs; n.ext={A:enNum(I.a),B:enNum(I.b)};
    const pv=n.p.live ? calcPreview(cs,n.ext) : null;
    n.pv=calcPreview(cs,n.ext);
    const val=pv!==null ? pv : cs.res;
    return {out:val, text:cs.fresh ? ceFmt(cs.res,+n.p.digits) : cs.expr}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, cs=n.cs, col=indColor(p.color), sci=calcSci(p), rows=sci ? 10 : 5;
    const topK=cv2=>Math.max(48,cv2.height*(calcSci(n.p) ? .2 : .24)), top=topK(cv), L=enLayout(W,H,top,rows,4,calcKeys(sci,cs.deg));
    enWire(n,cv,(x,y)=>{ const sc=calcSci(n.p), t=Math.max(48,cv.height*(sc ? .2 : .24));
        if(y<t) return 'VIEW';                                           // тап по дисплею — простой / инженерный вид
        const r=enHit(enLayout(cv.width,cv.height,t,sc ? 10 : 5,4,calcKeys(sc,n.cs.deg)),x,y); return r ? r.q.k : null; },
      k=>{ if(k==='VIEW'){ n.p.layout=calcSci(n.p) ? 'simple' : 'scientific'; n.p.sci=false; if(n.set&&n.set.layout) n.set.layout(n.p.layout); return; }
        calcPress(n.cs,k,n.ext,+n.p.digits);
        n.p.state=(n.cs.res===null ? '' : n.cs.res)+','+n.cs.mem+','+(n.cs.deg ? 'deg' : 'rad'); },
      ev=>keyName(ev));
    cx.clearRect(0,0,W,H);
    cx.fillStyle='#0b0f0c'; cx.strokeStyle=themeColor('--axis'); cx.lineWidth=1.5; cx.beginPath(); cx.roundRect(2,2,W-4,top-2,6); cx.fill(); cx.stroke();
    cx.textAlign='right'; cx.textBaseline='middle';
    const ex=cs.expr || '', big=cs.err ? cs.err : cs.fresh ? ceFmt(cs.res,+p.digits) : n.pv!==null && ex ? ceFmt(n.pv,+p.digits) : (ex ? '' : (cs.res!==null ? ceFmt(cs.res,+p.digits) : '0'));
    cx.fillStyle=EN_DIM; enFit(cx,ex || ' ',W-20,Math.min(15,top*.26)); cx.fillText(ex.replace(/\*/g,'×'),W-10,top*.27);
    cx.fillStyle=cs.err ? themeColor('--err') : cs.fresh ? col : EN_INK; enFit(cx,big,W-20,Math.min(top*.5,32)); cx.fillText(big,W-10,top*.68);
    cx.textAlign='left'; indFont(cx,Math.min(10,top*.2)); cx.fillStyle=EN_DIM;
    cx.fillText((cs.mem ? 'M ' : '')+(sci ? (cs.deg ? 'DEG' : 'RAD') : ''),8,top*.2);
    cx.textAlign='start'; cx.textBaseline='alphabetic';
    enDrawKeys(cx,L,n,col); }
});

/* ---------- Frequency Digits (разряды VFO) ---------- */
def({ id:'freqdigits', lazy:'proc', touch:true, title:'Frequency Digits', cat:'Indicators',
  kw:'vfo frequency digits decade step tune up down tap swipe radio display entry hz mhz thumbwheel',
  ins:[{n:'in',t:'num'}], outs:[{n:'f',t:'num'}], view:{h:90}, w:340, resize:true,
  params:[{n:'digits',t:'range',min:4,max:12,step:1,d:9,label:'digits (9 → up to 999.999.999 Hz)'},
          {n:'min',t:'num',d:0,label:'lowest, Hz'},{n:'max',t:'num',d:0,label:'highest, Hz; 0 — as many as the digits allow'},
          {n:'sep',t:'select',opts:['.',' ',',','none'],d:'.',label:'group separator'},
          {n:'color',t:'text',d:'amber',label:'colour: '+IND_COLORS.join(', ')+' or #rrggbb'},
          {n:'state',t:'text',d:'',hidden:true}],
  init:n=>{ const v=parseFloat(n.p.state); n.f=isFinite(v) ? v : 14200000; n.lastIn=null; n.drag=null; n.fl=null; },
  process(n,I){
    const v=enNum(I.in); if(v!==null && v!==n.lastIn){ n.lastIn=v; if(!n.drag){ n.f=Math.round(v); n.p.state=String(n.f); } }
    return {f:n.f}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, N=Math.max(1,Math.round(+p.digits)||9), col=indColor(p.color), sep=p.sep==='none' ? '' : p.sep;
    const hi=+p.max>+p.min ? +p.max : Math.pow(10,N)-1, lo=Math.min(+p.min||0,hi);
    // геометрия: N цифр + разделители групп + суффикс Hz
    const groups=Math.ceil(N/3)-1, sw=sep ? .45 : .18, tw=N+groups*sw+2.4, cw=Math.min(W/tw,(H-6)*.62), fs=Math.min(cw*1.5,H*.7);
    const x0=(W-cw*tw)/2+cw*.1, cy=H*.52;
    // позиция цифры с учётом разделителей слева: считаем число разделителей до неё
    const posX=idx=>{ let sepsBefore=0; for(let q=1;q<=idx;q++) if((N-q)%3===2) sepsBefore++; return x0+(idx+.5)*cw+sepsBefore*sw*cw; };
    const kAt=x=>{ let best=-1,bd=1e9; for(let idx=0;idx<N;idx++){ const d=Math.abs(x-posX(idx)); if(d<bd){ bd=d; best=idx; } } return bd<=cw*.62 ? N-1-best : -1; };
    const stepF=(k,dir)=>{ n.f=fdStep(n.f,k,dir,lo,hi); n.p.state=String(n.f); };
    indWire(n,cv,{
      down:(x,y)=>{ const k=kAt(x); if(k<0) return; n.drag={k,y0:y,acc:0,moved:false,half:y<cv.height/2}; n.fl={k,t:performance.now()}; },
      move:(x,y)=>{ const d=n.drag; if(!d) return; const stp=Math.max(10,cv.height*.28), c=Math.trunc((d.y0-y)/stp);
        if(c!==d.acc){ d.moved=true; stepF(d.k,c-d.acc); d.acc=c; redraw(n); } },
      up:()=>{ const d=n.drag; n.drag=null; if(d && !d.moved){ stepF(d.k,d.half ? 1 : -1); } redraw(n); },
      wheel:(x,y,ev)=>{ const k=kAt(x); if(k<0) return; stepF(k,ev.deltaY<0 ? 1 : -1); redraw(n); }});
    cx.clearRect(0,0,W,H);
    cx.fillStyle='#0b0f0c'; cx.strokeStyle=themeColor('--axis'); cx.lineWidth=1.5; cx.beginPath(); cx.roundRect(1,1,W-2,H-2,Math.min(8,H*.12)); cx.fill(); cx.stroke();
    const ds=fdDigits(n.f,N); let lead=0; while(lead<N-1 && ds[lead]==='0') lead++;
    cx.textAlign='center'; cx.textBaseline='middle';
    const now=performance.now();
    for(let idx=0;idx<N;idx++){
      const x=posX(idx), k=N-1-idx, on=idx>=lead, hot=n.fl && n.fl.k===k && now-n.fl.t<220;
      indFont(cx,fs); cx.save();
      cx.fillStyle=col; cx.globalAlpha=on ? 1 : .16; if(on){ cx.shadowColor=col; cx.shadowBlur=hot ? 14 : 6; }
      cx.fillText(ds[idx],x,cy); cx.restore();
      if(hot){ cx.fillStyle=col; cx.globalAlpha=.14; cx.beginPath(); cx.roundRect(x-cw*.5,H*.1,cw,H*.8,4); cx.fill(); cx.globalAlpha=1; }
      if(idx<N-1 && (N-1-idx)%3===0 && sep){ cx.fillStyle=col; cx.globalAlpha=on ? .85 : .2; indFont(cx,fs*.8); cx.fillText(sep,x+cw*.5+sw*cw*.5,cy+fs*.12); cx.globalAlpha=1; }
    }
    // стрелки-подсказки над и под цифрами: верхняя половина — вверх, нижняя — вниз
    cx.strokeStyle=EN_DIM; cx.lineWidth=1; cx.globalAlpha=.55;
    for(let idx=0;idx<N;idx++){ const x=posX(idx), a=cw*.14;
      cx.beginPath(); cx.moveTo(x-a,H*.14); cx.lineTo(x,H*.07); cx.lineTo(x+a,H*.14); cx.moveTo(x-a,H*.86); cx.lineTo(x,H*.93); cx.lineTo(x+a,H*.86); cx.stroke(); }
    cx.globalAlpha=1; cx.fillStyle=EN_DIM; indFont(cx,fs*.4); cx.textAlign='left'; cx.fillText('Hz',posX(N-1)+cw*.62,cy+fs*.15);
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- Number Readout ---------- */
const NR_STYLES=['lcd','vfd','led','paper'];
def({ id:'numread', lazy:'proc', title:'Number Readout', cat:'Indicators',
  kw:'number display readout frequency lcd vfd led paper si engineering mhz khz units big text value show',
  ins:[{n:'in',t:'num'}], view:{h:90}, w:280, resize:true,
  params:[{n:'format',t:'select',opts:['frequency','si','plain','groups'],d:'frequency',label:'frequency — Hz / kHz / MHz / GHz by size; si — p … T prefix + unit; plain — fixed decimals; groups — 14.200.000'},
          {n:'style',t:'select',opts:NR_STYLES,d:'lcd'},
          {n:'digits',t:'range',min:2,max:9,step:1,d:6,label:'significant digits (frequency / si)'},
          {n:'decimals',t:'range',min:0,max:9,step:1,d:3,label:'decimals (plain)'},
          {n:'unit',t:'text',d:'',label:'unit (si / plain), e.g. V, Ω, dB'},
          {n:'label',t:'text',d:'',label:'caption in the corner'},
          {n:'sep',t:'select',opts:['.',' ',','],d:'.',label:'group separator (groups)'},
          {n:'color',t:'text',d:'',label:'colour override: '+IND_COLORS.join(', ')+' or #rrggbb'}],
  init:n=>{ n.v=null; },
  process(n,I){ n.v=enNum(I.in); return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, st=NR_STYLE[p.style] || NR_STYLE.lcd, col=p.color ? indColor(p.color) : st.ink;
    cx.clearRect(0,0,W,H);
    const g=cx.createLinearGradient(0,0,0,H); g.addColorStop(0,st.bg[0]); g.addColorStop(1,st.bg[1]);
    cx.fillStyle=g; cx.strokeStyle=themeColor('--axis'); cx.lineWidth=1.5; cx.beginPath(); cx.roundRect(1,1,W-2,H-2,Math.min(8,H*.12)); cx.fill(); cx.stroke();
    const f=fmtNum(n.v,{mode:p.format,digits:+p.digits,decimals:+p.decimals,unit:p.unit,sep:p.sep});
    const px=Math.min(H*.62,W*.2);
    cx.textBaseline='middle'; cx.textAlign='right';
    indFont(cx,px); let uw=0; if(f.unit){ indFont(cx,px*.4); uw=cx.measureText(f.unit).width+px*.25; }
    enFit(cx,f.text,W-20-uw,px); const fs=parseFloat(cx.font);
    const ghost=f.text.replace(/[0-9]/g,'8');
    if(st.ghost){ cx.fillStyle=col; cx.globalAlpha=st.ghost; cx.fillText(ghost,W-10-uw,H*.52); cx.globalAlpha=1; }
    cx.save(); cx.fillStyle=col; if(st.glow){ cx.shadowColor=col; cx.shadowBlur=st.glow*fs*.3; } cx.fillText(f.text,W-10-uw,H*.52); cx.restore();
    if(f.unit){ indFont(cx,Math.max(8,fs*.4)); cx.fillStyle=col; cx.globalAlpha=.85; cx.fillText(f.unit,W-10,H*.58); cx.globalAlpha=1; }
    if(p.label){ cx.textAlign='left'; cx.textBaseline='top'; indFont(cx,Math.min(11,H*.16)); cx.fillStyle=col; cx.globalAlpha=.7; cx.fillText(p.label,8,5); cx.globalAlpha=1; }
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});
const NR_STYLE={
  lcd:{bg:['#b7c79a','#a4b685'],ink:'#1d2a14',ghost:.09,glow:0},
  vfd:{bg:['#06100f','#0a1a18'],ink:'#5ff2e0',ghost:.06,glow:1},
  led:{bg:['#150606','#0c0303'],ink:'#ff3b2f',ghost:.1,glow:1.2},
  paper:{bg:['#ece6d2','#e2dbc2'],ink:'#2a2418',ghost:0,glow:0},
};
