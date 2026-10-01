"use strict";
/* ============================ INDICATORS ============================ */
// Визуальные индикаторы на числовых проводах: Lamps, Gauge, LED Bar, Compass, 7-Segment.
// Все рисуются на canvas узла (работают и в дашборде), пересчёт — каждый блок (lazy:'proc').

const IND_COL={green:'--t-blk',amber:'--acc',red:'--err',blue:'--t-img',teal:'--acc2',violet:'--t-spec',pink:'--t-trk'};
const IND_COLORS=Object.keys(IND_COL);
const indColor=s=>{ s=String(s||'').trim().toLowerCase();
  return IND_COL[s] ? themeColor(IND_COL[s]) : /^#[0-9a-f]{3,8}$/.test(s) ? s : themeColor(IND_COL.green); };
const indNum=v=>typeof v==='number' && isFinite(v) ? v : null;
const indDt=()=>BLOCK/Eng.sr;
// экспоненциальное сглаживание с постоянной tau (с); tau=0 — без сглаживания
const indSmooth=(cur,v,tau)=>tau>0 ? cur+(v-cur)*(1-Math.exp(-indDt()/tau)) : v;
const indFmt=v=>Math.abs(v)>=1e5 || (v!==0 && Math.abs(v)<1e-3) ? v.toExponential(1) : String(+v.toPrecision(4));
const indFont=(cx,px)=>{ cx.font=Math.max(7,Math.round(px))+'px monospace'; };
// пик с задержкой: держим hold секунд, затем падаем со скоростью rate (доля диапазона в секунду)
function indPeak(n,v,range){
  if(v>=n.pk){ n.pk=v; n.pt=1.5; }
  else if((n.pt-=indDt())<0) n.pk=Math.max(v,n.pk-range*.3*indDt());
}
const indZone=(p,v)=>v>=p.crit ? '--err' : v>=p.warn ? '--acc' : '--t-blk';

/* ---------- Lamps ---------- */
const IND_LAMP_COUNTS=['1','2','3','4','5','6','7','8','10','12','16'];
function lampResize(n){
  const valid=new Set(portsOf(n,'ins').map(p=>p.n));
  Graph.edges.filter(e=>e.to===n.id && !valid.has(e.tp)).forEach(delEdge);
  rebuildNode(n); markTopoDirty();
}
def({ id:'lamps', lazy:'proc', title:'Lamps', cat:'Output',
  ins:n=>Array.from({length:+n.p.count||4},(_,k)=>({n:'in'+(k+1),t:'num'})),
  view:{h:64}, resize:true,
  params:[{n:'count',t:'select',opts:IND_LAMP_COUNTS,d:'4',label:'lamps',fn:lampResize},
          {n:'mode',t:'select',opts:['threshold','brightness'],d:'threshold',label:'mode'},
          {n:'thr',t:'num',d:.5,label:'threshold / full scale'},
          {n:'hold',t:'range',min:0,max:5,step:.01,d:.25,label:'hold / fade, s'},
          {n:'blink',t:'check',d:false,label:'blink while on'},
          {n:'labels',t:'text',d:'',label:'labels (comma separated)'},
          {n:'colors',t:'text',d:'green',label:'colors: '+IND_COLORS.join(', ')+' or #rrggbb, cycled'}],
  init:n=>{ n.lv=[]; n.on=[]; },
  process(n,I){
    const p=n.p, N=+p.count||4, dt=indDt(), fade=+p.hold;
    for(let k=0;k<N;k++){
      const v=indNum(I['in'+(k+1)]);
      const t=v===null ? 0 : p.mode==='brightness' ? clamp(v/(p.thr||1),0,1) : v>=p.thr ? 1 : 0;
      const cur=n.lv[k]||0;
      n.lv[k]= t>=cur ? t : fade>0 ? Math.max(t,cur-dt/fade) : t;
      n.on[k]=t>0;
    }
    n.lv.length=n.on.length=N;
    return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, N=n.lv.length||+n.p.count||4;
    const labels=String(n.p.labels||'').split(','), cols=String(n.p.colors||'').split(',');
    cx.clearRect(0,0,W,H);
    let best=null;                                  // сетка, в которой лампы выходят крупнее всего
    for(let c=1;c<=N;c++){
      const r=Math.ceil(N/c), d=Math.min(W/c*.7,H/r-13,56);
      if(!best || d>best.d) best={c,r,d};
    }
    const {c:C,r:R,d}=best, cw=W/C, ch=H/R, rad=Math.max(3,d/2);
    const blinkOff=n.p.blink && Math.floor(performance.now()/250)%2;
    indFont(cx,Math.min(11,rad*.8)); cx.textAlign='center'; cx.textBaseline='top';
    for(let k=0;k<N;k++){
      const x=(k%C+.5)*cw, y=Math.floor(k/C)*ch+rad+2;
      const col=indColor(cols[k%cols.length]);
      const lit=(n.lv[k]||0)*(blinkOff && n.on[k] ? .2 : 1);
      cx.globalAlpha=.16; cx.fillStyle=col; cx.beginPath(); cx.arc(x,y,rad,0,7); cx.fill();
      cx.globalAlpha=1; cx.strokeStyle=themeColor('--axis'); cx.lineWidth=1.5; cx.stroke();
      if(lit>.01){
        cx.save(); cx.globalAlpha=lit; cx.fillStyle=col; cx.shadowColor=col; cx.shadowBlur=rad*1.2;
        cx.beginPath(); cx.arc(x,y,rad*.88,0,7); cx.fill(); cx.restore();
        cx.globalAlpha=.35*lit; cx.fillStyle='#fff';
        cx.beginPath(); cx.ellipse(x-rad*.25,y-rad*.3,rad*.3,rad*.18,-.6,0,7); cx.fill(); cx.globalAlpha=1;
      }
      cx.fillStyle=themeColor('--axis');
      cx.fillText((labels[k]||'').trim()||String(k+1),x,y+rad+3);
    }
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- Gauge (стрелочный прибор) ---------- */
def({ id:'gauge', lazy:'proc', title:'Gauge', cat:'Output', ins:[{n:'in',t:'num'}],
  view:{h:150}, resize:true,
  params:[{n:'min',t:'num',d:0},{n:'max',t:'num',d:1},
          {n:'zones',t:'check',d:true,label:'colour zones'},
          {n:'warn',t:'num',d:.7,label:'amber from'},
          {n:'crit',t:'num',d:.9,label:'red from'},
          {n:'unit',t:'text',d:''},
          {n:'tau',t:'range',min:0,max:3,step:.01,d:.15,label:'needle damping, s'},
          {n:'peak',t:'check',d:true,label:'peak marker'}],
  init:n=>{ n.v=null; n.sv=0; n.pk=-Infinity; n.pt=0; },
  process(n,I){
    const p=n.p, v=indNum(I.in); n.v=v;
    if(v===null) return {};
    const lo=Math.min(p.min,p.max), hi=Math.max(p.min,p.max), x=clamp(v,lo,hi);
    n.sv=indSmooth(n.sv,x,+p.tau);
    indPeak(n,n.sv,hi-lo||1);
    return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, pad=8;
    const lo=Math.min(p.min,p.max), hi=Math.max(p.min,p.max), rng=hi-lo||1;
    const R=Math.max(10,Math.min((W-2*pad)/1.8,(H-2*pad)/1.75)), X=W/2, Y=(H-1.75*R)/2+R;
    const A0=Math.PI*5/6, SW=Math.PI*4/3, ang=v=>A0+SW*clamp((v-lo)/rng,0,1);
    cx.clearRect(0,0,W,H); cx.lineCap='butt';
    const arc=(a,b,r,w,col,al=1)=>{ cx.globalAlpha=al; cx.strokeStyle=col; cx.lineWidth=w;
      cx.beginPath(); cx.arc(X,Y,r,a,b); cx.stroke(); cx.globalAlpha=1; };
    const tw=R*.09;
    arc(A0,A0+SW,R-tw/2,tw,themeColor('--axis'),.35);
    if(p.zones){
      const w=Math.min(Math.max(p.warn,lo),hi), c=Math.min(Math.max(p.crit,w),hi);
      arc(ang(lo),ang(w),R-tw/2,tw,themeColor('--t-blk'));
      if(c>w) arc(ang(w),ang(c),R-tw/2,tw,themeColor('--acc'));
      if(hi>c) arc(ang(c),ang(hi),R-tw/2,tw,themeColor('--err'));
    } else arc(A0,ang(n.sv),R-tw/2,tw,themeColor('--acc2'));
    cx.strokeStyle=themeColor('--scr-hi'); indFont(cx,R*.13);
    cx.fillStyle=themeColor('--axis'); cx.textAlign='center'; cx.textBaseline='middle';
    for(let i=0;i<=20;i++){
      const a=A0+SW*i/20, major=i%4===0, r1=R-tw-2, r2=r1-(major?R*.1:R*.05);
      cx.lineWidth=major?1.5:1; cx.globalAlpha=major?.9:.5;
      cx.beginPath(); cx.moveTo(X+Math.cos(a)*r1,Y+Math.sin(a)*r1); cx.lineTo(X+Math.cos(a)*r2,Y+Math.sin(a)*r2); cx.stroke();
      cx.globalAlpha=1;
      if(major){ const r3=r2-R*.12; cx.fillText(indFmt(lo+rng*i/20),X+Math.cos(a)*r3,Y+Math.sin(a)*r3); }
    }
    if(p.peak && isFinite(n.pk)){
      const a=ang(n.pk), r1=R-tw-2;
      cx.fillStyle=themeColor('--acc'); cx.beginPath();
      cx.moveTo(X+Math.cos(a)*r1,Y+Math.sin(a)*r1);
      cx.lineTo(X+Math.cos(a-.05)*(r1-R*.09),Y+Math.sin(a-.05)*(r1-R*.09));
      cx.lineTo(X+Math.cos(a+.05)*(r1-R*.09),Y+Math.sin(a+.05)*(r1-R*.09)); cx.fill();
    }
    if(n.v!==null){
      const a=ang(n.sv), L=R-tw-R*.06;
      cx.strokeStyle=themeColor('--err'); cx.lineWidth=Math.max(1.5,R*.025);
      cx.beginPath(); cx.moveTo(X-Math.cos(a)*R*.12,Y-Math.sin(a)*R*.12); cx.lineTo(X+Math.cos(a)*L,Y+Math.sin(a)*L); cx.stroke();
    }
    cx.fillStyle=themeColor('--scr-hi'); cx.beginPath(); cx.arc(X,Y,R*.07,0,7); cx.fill();
    indFont(cx,R*.17); cx.fillStyle=themeColor('--scr-hi');
    cx.fillText((n.v===null ? '—' : indFmt(n.v))+(p.unit?' '+p.unit:''),X,Y+R*.6);
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- LED Bar (светодиодная шкала с пиком) ---------- */
def({ id:'ledbar', lazy:'proc', title:'LED Bar', cat:'Output', ins:[{n:'in',t:'num'}],
  view:{h:34}, resize:true,
  params:[{n:'min',t:'num',d:-60},{n:'max',t:'num',d:0},
          {n:'segs',t:'range',min:5,max:60,step:1,d:24,label:'segments'},
          {n:'warn',t:'num',d:-12,label:'amber from'},
          {n:'crit',t:'num',d:-3,label:'red from'},
          {n:'fall',t:'range',min:0,max:3,step:.01,d:.3,label:'fall time, s'},
          {n:'peak',t:'check',d:true,label:'peak marker'},
          {n:'dir',t:'select',opts:['auto','horizontal','vertical'],d:'auto',label:'direction'}],
  init:n=>{ n.v=null; n.sv=-Infinity; n.pk=-Infinity; n.pt=0; },
  process(n,I){
    const p=n.p, v=indNum(I.in); n.v=v;
    const lo=Math.min(p.min,p.max), hi=Math.max(p.min,p.max);
    if(v===null){ n.sv=lo; return {}; }
    const x=clamp(v,lo,hi);
    n.sv=x>n.sv || !isFinite(n.sv) ? x : indSmooth(n.sv,x,+p.fall);   // атака мгновенная, спад плавный
    indPeak(n,n.sv,hi-lo||1);
    return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, N=Math.round(p.segs);
    const lo=Math.min(p.min,p.max), hi=Math.max(p.min,p.max), rng=hi-lo||1;
    const vert=p.dir==='vertical' || (p.dir==='auto' && H>W);
    const len=vert?H:W, th=vert?W:H, gap=Math.max(1,len/N*.15), sl=(len-gap*(N-1))/N;
    cx.clearRect(0,0,W,H);
    const lit=n.v===null ? 0 : (n.sv-lo)/rng*N, pk=isFinite(n.pk) ? Math.min(N-1,Math.floor((n.pk-lo)/rng*N)) : -1;
    for(let i=0;i<N;i++){
      const col=themeColor(indZone(p,lo+rng*(i+.5)/N)), pos=i*(sl+gap);
      const on=i+.5<=lit || (p.peak && i===pk && n.v!==null);
      cx.globalAlpha=on ? 1 : .16; cx.fillStyle=col;
      if(vert) cx.fillRect(0,H-pos-sl,th,sl); else cx.fillRect(pos,0,sl,th);
    }
    cx.globalAlpha=1; }
});

/* ---------- Compass (азимут) ---------- */
const IND_CARDS=['N','NE','E','SE','S','SW','W','NW'];
def({ id:'compass', lazy:'proc', title:'Compass', cat:'Output',
  ins:[{n:'az',t:'num'},{n:'az2',t:'num'}],
  view:{h:150}, resize:true,
  params:[{n:'tau',t:'range',min:0,max:3,step:.01,d:.2,label:'needle damping, s'},
          {n:'rel',t:'check',d:false,label:'rotate the dial to the heading (az2)'}],
  init:n=>{ n.a=null; n.sa=0; n.b=null; n.sb=0; },
  process(n,I){
    const turn=(cur,v)=>cur+indSmooth(0,((v-cur+540)%360+360)%360-180,+n.p.tau);   // кратчайший путь
    const a=indNum(I.az), b=indNum(I.az2); n.a=a; n.b=b;
    if(a!==null) n.sa=turn(n.sa,a);
    if(b!==null) n.sb=turn(n.sb,b);
    return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, TXT=16, R=Math.max(10,Math.min(W/2,(H-TXT)/2)-4), X=W/2, Y=(H-TXT)/2;
    const rot=n.p.rel && n.b!==null ? n.sb : 0, rad=d=>(d-rot-90)*Math.PI/180;
    const pt=(d,r)=>[X+Math.cos(rad(d))*r,Y+Math.sin(rad(d))*r];
    cx.clearRect(0,0,W,H);
    cx.strokeStyle=themeColor('--axis'); cx.lineWidth=1.5; cx.beginPath(); cx.arc(X,Y,R,0,7); cx.stroke();
    indFont(cx,R*.17); cx.textAlign='center'; cx.textBaseline='middle';
    for(let d=0;d<360;d+=10){
      const major=d%90===0, mid=d%30===0, r2=R-R*(major?.14:mid?.1:.05), [x1,y1]=pt(d,R), [x2,y2]=pt(d,r2);
      cx.strokeStyle=themeColor(major?'--scr-hi':'--axis'); cx.lineWidth=major?2:1;
      cx.beginPath(); cx.moveTo(x1,y1); cx.lineTo(x2,y2); cx.stroke();
      if(major){ const [tx,ty]=pt(d,R*.68); cx.fillStyle=themeColor(d===0?'--err':'--scr-hi'); cx.fillText(IND_CARDS[d/45],tx,ty); }
    }
    if(n.b!==null && !n.p.rel){                       // вторая метка — ромб на ободе
      const [x,y]=pt(n.sb,R*.86); cx.fillStyle=themeColor('--acc2'); cx.beginPath();
      cx.moveTo(x,y-R*.07); cx.lineTo(x+R*.05,y); cx.lineTo(x,y+R*.07); cx.lineTo(x-R*.05,y); cx.fill();
    }
    if(n.a!==null){
      const d=n.sa, [tx,ty]=pt(d,R*.8), [lx,ly]=pt(d+90,R*.07), [rx,ry]=pt(d-90,R*.07), [bx,by]=pt(d+180,R*.3);
      cx.fillStyle=themeColor('--err'); cx.beginPath(); cx.moveTo(tx,ty); cx.lineTo(lx,ly); cx.lineTo(rx,ry); cx.fill();
      cx.fillStyle=themeColor('--axis'); cx.beginPath(); cx.moveTo(bx,by); cx.lineTo(lx,ly); cx.lineTo(rx,ry); cx.fill();
    }
    cx.fillStyle=themeColor('--scr-hi'); cx.beginPath(); cx.arc(X,Y,R*.05,0,7); cx.fill();
    indFont(cx,TXT*.75); cx.textBaseline='alphabetic';
    const deg=v=>v===null ? '—' : Math.round(((v%360)+360)%360)+'° '+IND_CARDS[Math.round((((v%360)+360)%360)/45)%8];
    cx.fillText(deg(n.a)+(n.b!==null ? '  ·  '+deg(n.b) : ''),X,H-3);
    cx.textAlign='start'; }
});

/* ---------- 7-Segment Display ---------- */
const SEG7={'0':0x3f,'1':0x06,'2':0x5b,'3':0x4f,'4':0x66,'5':0x6d,'6':0x7d,'7':0x07,'8':0x7f,'9':0x6f,'-':0x40,' ':0,'E':0x79};
function segFormat(v,p){
  if(v===null) return {s:'-'.repeat(+p.digits),u:''};
  let u='', x=v;
  if(p.fmt==='frequency'){
    const a=Math.abs(v);
    [u,x]=a>=1e9 ? ['GHz',v/1e9] : a>=1e6 ? ['MHz',v/1e6] : a>=1e3 ? ['kHz',v/1e3] : ['Hz',v];
  }
  let s=x.toFixed(+p.decimals);
  if(p.zeros) s=s.replace(/^(-?)(\d+)/,(m,sg,d)=>sg+d.padStart(+p.digits-sg.length-(+p.decimals?+p.decimals:0),'0'));
  return {s,u};
}
def({ id:'segdisp', lazy:'proc', title:'7-Segment Display', cat:'Output', ins:[{n:'in',t:'num'}],
  view:{h:64}, resize:true,
  params:[{n:'digits',t:'range',min:1,max:12,step:1,d:8},
          {n:'decimals',t:'range',min:0,max:6,step:1,d:0},
          {n:'fmt',t:'select',opts:['number','frequency'],d:'number',label:'format (frequency: Hz → kHz / MHz / GHz)'},
          {n:'zeros',t:'check',d:false,label:'leading zeros'},
          {n:'ghost',t:'check',d:true,label:'show unlit segments'},
          {n:'color',t:'text',d:'amber',label:'color: '+IND_COLORS.join(', ')+' or #rrggbb'}],
  init:n=>{ n.v=null; },
  process(n,I){ n.v=indNum(I.in); return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, D=Math.round(p.digits), {s,u}=segFormat(n.v,p);
    const uw=u ? Math.min(W*.2,H*.9) : 0, cw=(W-uw-8)/D;
    const h=Math.max(8,Math.min(H-10,cw*1.9)), w=h*.5, t=Math.max(1.5,h*.11), g=t*.7;
    const col=indColor(p.color), y0=(H-h)/2, ym=y0+h/2, y1=y0+h;
    cx.clearRect(0,0,W,H);
    const cells=[];                                  // цифры справа налево; '.' достаётся предыдущей цифре
    for(let i=s.length-1;i>=0;i--){
      if(s[i]==='.'){ continue; }
      cells.unshift({c:s[i],dot:s[i+1]==='.'});
    }
    const over=cells.length>D, shown=over ? Array.from({length:D},()=>({c:'-',dot:false})) : cells;
    const hs=(x1,x2,y)=>{ cx.moveTo(x1,y); cx.lineTo(x1+t/2,y-t/2); cx.lineTo(x2-t/2,y-t/2); cx.lineTo(x2,y); cx.lineTo(x2-t/2,y+t/2); cx.lineTo(x1+t/2,y+t/2); cx.closePath(); };
    const vs=(y1_,y2,x)=>{ cx.moveTo(x,y1_); cx.lineTo(x+t/2,y1_+t/2); cx.lineTo(x+t/2,y2-t/2); cx.lineTo(x,y2); cx.lineTo(x-t/2,y2-t/2); cx.lineTo(x-t/2,y1_+t/2); cx.closePath(); };
    const left=W-uw-4-D*cw;
    for(let i=0;i<D;i++){
      const ch=shown[i-(D-shown.length)], x0=left+i*cw+(cw-w)/2, x1=x0+w;
      const m=ch ? (SEG7[ch.c]??0) : 0;
      const segs=[()=>hs(x0+g,x1-g,y0),()=>vs(y0+g,ym-g/2,x1),()=>vs(ym+g/2,y1-g,x1),
                  ()=>hs(x0+g,x1-g,y1),()=>vs(ym+g/2,y1-g,x0),()=>vs(y0+g,ym-g/2,x0),()=>hs(x0+g,x1-g,ym)];
      for(let k=0;k<7;k++){
        const on=m>>k&1;
        if(!on && !p.ghost) continue;
        cx.save(); cx.fillStyle=col; cx.globalAlpha=on?1:.1;
        if(on){ cx.shadowColor=col; cx.shadowBlur=t*1.5; }
        cx.beginPath(); segs[k](); cx.fill(); cx.restore();
      }
      if(ch && ch.dot){ cx.fillStyle=col; cx.beginPath(); cx.arc(x1+t*1.2,y1,t*.55,0,7); cx.fill(); }
    }
    if(u){ indFont(cx,Math.min(uw*.45,h*.3)); cx.fillStyle=col; cx.textBaseline='bottom'; cx.fillText(u,W-uw-1,y1); cx.textBaseline='alphabetic'; }
  }
});
