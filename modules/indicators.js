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
def({ id:'lamps', lazy:'proc', title:'Lamps', cat:'Indicators',
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
def({ id:'gauge', lazy:'proc', title:'Gauge', cat:'Indicators', ins:[{n:'in',t:'num'}],
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
def({ id:'ledbar', lazy:'proc', title:'LED Bar', cat:'Indicators', ins:[{n:'in',t:'num'}],
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
    const lit=n.v===null ? 0 : (n.sv-lo)/rng*N, pk=isFinite(n.pk) ? Math.min(N-1,Math.floor((n.pk-lo)/rng*N)) : -1;
    // картинка зависит только от числа зажжённых сегментов и пика — иначе канву зря не трогаем
    const key=[W,H,drawGen,N,lo,hi,p.warn,p.crit,p.dir,p.peak,Math.floor(lit-.5)+(n.v===null?'x':''),pk].join('|');
    if(n._lk===key && n._lcv===cv) return;
    n._lk=key; n._lcv=cv;
    cx.clearRect(0,0,W,H);
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
def({ id:'compass', lazy:'proc', title:'Compass', cat:'Indicators',
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
def({ id:'segdisp', lazy:'proc', title:'7-Segment Display', cat:'Indicators', ins:[{n:'in',t:'num'}],
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
    const w=Math.max(4,Math.min((H-10)*.5,cw*.68)), h=w*2, t=Math.max(1.5,h*.11), g=t*.7;   // цифра — не шире 68 % ячейки, иначе соседние слипаются
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
      if(ch && ch.dot){ cx.fillStyle=col; cx.beginPath(); cx.arc(x1+(cw-w)/2,y1,Math.min(t*.55,(cw-w)*.3),0,7); cx.fill(); }
    }
    if(u){ indFont(cx,Math.min(uw*.45,h*.3)); cx.fillStyle=col; cx.textBaseline='bottom'; cx.fillText(u,W-uw-1,y1); cx.textBaseline='alphabetic'; }
  }
});

/* ---------- Sky Plot (азимут / высота) ---------- */
const SKY_MAX=1500;
def({ id:'skyplot', lazy:'proc', title:'Sky Plot', cat:'Indicators',
  ins:[{n:'az',t:'num'},{n:'el',t:'num'},{n:'az2',t:'num'},{n:'el2',t:'num'}],
  view:{h:190}, resize:true,
  params:[{n:'trail',t:'range',min:0,max:300,step:1,d:30,label:'trail, s'},
          {n:'horizon',t:'num',d:0,label:'horizon (min elevation), °'}],
  init:n=>{ n.t=0; n.tr=[[],[]]; n.cur=[null,null]; },
  process(n,I){
    n.t+=indDt();
    [['az','el'],['az2','el2']].forEach(([a,e],k)=>{
      const az=indNum(I[a]), el=indNum(I[e]);
      n.cur[k]= az!==null && el!==null ? [az,el] : null;
      const tr=n.tr[k];
      if(n.cur[k] && (!tr.length || n.t-tr[tr.length-1][2]>.1)) tr.push([az,el,n.t]);
      while(tr.length && (n.t-tr[0][2]>n.p.trail || tr.length>SKY_MAX)) tr.shift();
    });
    return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, TXT=14, R=Math.max(10,Math.min(W/2,(H-TXT)/2)-4), X=W/2, Y=(H-TXT)/2;
    const hz=clamp(+n.p.horizon||0,0,80);
    const xy=(az,el,r=R)=>{ const q=r*(90-Math.max(el,hz))/(90-hz), a=az*Math.PI/180; return [X+Math.sin(a)*q,Y-Math.cos(a)*q]; };
    cx.clearRect(0,0,W,H);
    cx.strokeStyle=themeColor('--axis'); cx.lineWidth=1;
    for(const f of [1,2/3,1/3]){ cx.globalAlpha=f===1?1:.4; cx.beginPath(); cx.arc(X,Y,R*f,0,7); cx.stroke(); }
    cx.globalAlpha=.4;
    for(let a=0;a<360;a+=45){ const [x,y]=xy(a,90); const [x2,y2]=xy(a,hz); cx.beginPath(); cx.moveTo(x,y); cx.lineTo(x2,y2); cx.stroke(); }
    cx.globalAlpha=1; indFont(cx,R*.13); cx.textAlign='center'; cx.textBaseline='middle'; cx.fillStyle=themeColor('--axis');
    for(let a=0;a<360;a+=90){ const q=R-R*.1, r=a*Math.PI/180;
      cx.fillStyle=themeColor(a===0?'--err':'--axis'); cx.fillText(IND_CARDS[a/45],X+Math.sin(r)*q,Y-Math.cos(r)*q); }
    cx.fillStyle=themeColor('--axis'); cx.textAlign='left';
    for(const e of [30,60]) if(e>hz){ const [x,y]=xy(0,e); cx.fillText(e+'°',x+2,y-2); }
    [themeColor('--acc2'),themeColor('--acc')].forEach((col,k)=>{
      const tr=n.tr[k], cur=n.cur[k];
      for(let i=1;i<tr.length;i++){
        const [x1,y1]=xy(tr[i-1][0],tr[i-1][1]), [x2,y2]=xy(tr[i][0],tr[i][1]);
        cx.globalAlpha=.15+.6*clamp(1-(n.t-tr[i][2])/(n.p.trail||1),0,1);
        cx.strokeStyle=col; cx.lineWidth=1.5; cx.beginPath(); cx.moveTo(x1,y1); cx.lineTo(x2,y2); cx.stroke();
      }
      cx.globalAlpha=1;
      if(cur){
        const [x,y]=xy(cur[0],cur[1]), up=cur[1]>=hz, r=Math.max(3,R*.05);
        cx.beginPath(); cx.arc(x,y,r,0,7);
        if(up){ cx.fillStyle=col; cx.shadowColor=col; cx.shadowBlur=r*2; cx.fill(); cx.shadowBlur=0; }
        else { cx.strokeStyle=col; cx.lineWidth=1.5; cx.stroke(); }
      }
    });
    indFont(cx,TXT*.75); cx.textAlign='center'; cx.textBaseline='alphabetic'; cx.fillStyle=themeColor('--scr-hi');
    const f=c=>c ? Math.round(((c[0]%360)+360)%360)+'° / '+Math.round(c[1])+'°' : '—';
    cx.fillText('az / el  '+f(n.cur[0])+(n.cur[1] ? '   ·   '+f(n.cur[1]) : ''),X,H-3);
    cx.textAlign='start'; }
});

/* ---------- S-Meter ---------- */
// S1…S9 — по 6 дБ, выше S9 — дБ над S9; шкала: S0…S9 занимают 60 %, +60 дБ — остальные 40 %
const SM_FRAC=(db,s9)=>{ const d=db-s9; return d<=0 ? clamp(1+d/54,0,1)*.6 : .6+clamp(d/60,0,1)*.4; };
const SM_NAME=(db,s9)=>{ const d=db-s9;
  return d>=0 ? 'S9'+(d>=1 ? '+'+Math.round(d) : '') : db<s9-54 ? 'S0' : 'S'+Math.max(0,Math.round(9+d/6)); };
def({ id:'smeter', lazy:'proc', title:'S-Meter', cat:'Indicators', ins:[{n:'in',t:'num'}],
  outs:[{n:'s',t:'num'}], view:{h:58}, resize:true,
  params:[{n:'s9',t:'num',d:-73,label:'S9 level (dBm; −73 is the HF standard)'},
          {n:'unit',t:'text',d:'dBm'},
          {n:'attack',t:'range',min:0,max:1,step:.005,d:.03,label:'attack, s'},
          {n:'fall',t:'range',min:0,max:3,step:.01,d:.5,label:'fall, s'},
          {n:'peak',t:'check',d:true,label:'peak marker'}],
  init:n=>{ n.v=null; n.sv=-Infinity; n.pk=-Infinity; n.pt=0; },
  process(n,I){
    const p=n.p, v=indNum(I.in); n.v=v;
    if(v===null) return {s:null};
    const lo=p.s9-54;
    if(!isFinite(n.sv)) n.sv=v;
    n.sv=indSmooth(n.sv,v,v>n.sv ? +p.attack : +p.fall);
    indPeak(n,n.sv,60);
    // S-единицы числом: 9 = S9, дальше +дБ/6 (S9+60 = 19), чтобы провод «s» был линейным по шкале
    const d=n.sv-p.s9;
    return {s: n.sv<lo ? 0 : 9+d/6}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, s9=+p.s9, pad=14, bw=W-2*pad, bh=Math.max(6,H*.26), by=H-bh-18;
    cx.clearRect(0,0,W,H);
    const X=f=>pad+f*bw;
    cx.globalAlpha=.16; cx.fillStyle=themeColor('--t-blk'); cx.fillRect(X(0),by,bw*.6,bh);
    cx.fillStyle=themeColor('--err'); cx.fillRect(X(.6),by,bw*.4,bh); cx.globalAlpha=1;
    if(n.v!==null){
      const f=SM_FRAC(n.sv,s9);
      cx.fillStyle=themeColor('--acc2'); cx.fillRect(X(0),by,bw*Math.min(f,.6),bh);
      if(f>.6){ cx.fillStyle=themeColor('--err'); cx.fillRect(X(.6),by,bw*(f-.6),bh); }
      if(p.peak && isFinite(n.pk)){ cx.fillStyle=themeColor('--acc'); cx.fillRect(X(SM_FRAC(n.pk,s9))-1,by-2,2,bh+4); }
    }
    indFont(cx,Math.min(11,H*.18)); cx.textAlign='center'; cx.textBaseline='top';
    cx.strokeStyle=themeColor('--axis'); cx.fillStyle=themeColor('--axis'); cx.lineWidth=1;
    const tick=(f,label,long)=>{ cx.beginPath(); cx.moveTo(X(f)+.5,by+bh); cx.lineTo(X(f)+.5,by+bh+(long?4:2)); cx.stroke();
      if(label) cx.fillText(label,X(f),by+bh+4); };
    for(let s=1;s<=9;s++) tick(s/9*.6,s%2===1 ? 'S'+s : '',s%2===1);
    for(const o of [20,40,60]) tick(.6+o/60*.4,'+'+o,true);
    cx.textAlign='left'; cx.textBaseline='top'; indFont(cx,Math.min(13,H*.26)); cx.fillStyle=themeColor('--scr-hi');
    cx.fillText(n.v===null ? '—' : SM_NAME(n.sv,s9),6,2);
    cx.textAlign='right'; cx.fillStyle=themeColor('--axis');
    cx.fillText(n.v===null ? '' : indFmt(n.v)+' '+p.unit,W-6,2);
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- Text Ticker (бегущая строка / журнал строк) ---------- */
def({ id:'ticker', lazy:'proc', title:'Text Ticker', cat:'Indicators',
  ins:[{n:'text',t:'txt'},{n:'rec',t:'rec'}], view:{h:90}, resize:true,
  params:[{n:'mode',t:'select',opts:['lines','marquee'],d:'lines',label:'display'},
          {n:'max',t:'range',min:10,max:1000,step:10,d:200,label:'lines kept'},
          {n:'time',t:'check',d:false,label:'timestamps'},
          {n:'speed',t:'range',min:10,max:300,step:5,d:80,label:'marquee speed, px/s'},
          {n:'field',t:'text',d:'text',label:'record field to show (else all fields)'},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ n.rows=[]; n.pos=0; redraw(n); }}],
  init:n=>{ n.rows=[]; n.last=null; n.pos=0; n.pt=0; },
  process(n,I){
    const add=s=>{ s=String(s).trim(); if(s) n.rows.push({t:Date.now(),s}); };
    if(typeof I.text==='string' && I.text!==n.last){
      n.last=I.text; I.text.split(/[\r\n]+/).forEach(add); }
    for(const r of recList(I.rec)){
      const f=n.p.field && r[n.p.field]!=null ? r[n.p.field] : null;
      add(f!==null ? f : Object.entries(r).filter(([k,v])=>k!=='t' && v!==null && typeof v!=='object').map(([k,v])=>k+'='+(typeof v==='number' && !Number.isInteger(v) ? +v.toPrecision(5) : v)).join(' ')); }
    if(n.rows.length>n.p.max) n.rows.splice(0,n.rows.length-n.p.max);
    return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, fs=clamp(Math.round(H/6),10,13), lh=fs+3;
    cx.clearRect(0,0,W,H); indFont(cx,fs); cx.textBaseline='top';
    const stamp=r=>p.time ? new Date(r.t).toLocaleTimeString()+' ' : '';
    if(p.mode==='marquee'){
      const msg=n.rows.slice(-20).map(r=>stamp(r)+r.s).join('   ▪   ')+'   ▪   ', tw=cx.measureText(msg).width;
      const now=performance.now(), dt=n.pt ? Math.min(.1,(now-n.pt)/1000) : 0; n.pt=now;
      n.pos=(n.pos+p.speed*dt)%(tw+W);
      cx.fillStyle=themeColor('--acc2');
      if(!n.rows.length){ cx.fillStyle=themeColor('--axis'); cx.fillText('waiting for text',6,(H-fs)/2); }
      else cx.fillText(msg,W-n.pos,(H-fs)/2);
      n.pt=now; redraw(n);                            // бегущая строка анимируется каждый кадр
    } else {
      const rows=Math.max(1,Math.floor((H-4)/lh)), shown=n.rows.slice(-rows);
      shown.forEach((r,i)=>{
        cx.fillStyle=themeColor(i===shown.length-1 ? '--acc2' : '--axis');
        let s=stamp(r)+r.s; const maxc=Math.floor((W-8)/(fs*.6));
        if(s.length>maxc) s=s.slice(0,Math.max(1,maxc-1))+'…';
        cx.fillText(s,4,2+i*lh+(rows-shown.length)*lh);
      });
      if(!shown.length){ cx.fillStyle=themeColor('--axis'); cx.fillText('waiting for text',6,4); }
    }
    cx.textBaseline='alphabetic'; }
});

// клики по канве индикатора; обработчики вешаются один раз на канву (draw вызывается каждый кадр)
function indWire(n,cv,h){
  if(n._wcv===cv) return; n._wcv=cv;
  const pos=ev=>{ const r=cv.getBoundingClientRect();
    return [(ev.clientX-r.left)/r.width*cv.width, (ev.clientY-r.top)/r.height*cv.height]; };
  cv.style.cursor='pointer'; cv.style.touchAction='none';
  cv.addEventListener('pointerdown',ev=>{ ev.stopPropagation(); cv.setPointerCapture(ev.pointerId); h.down(...pos(ev)); });
  const up=ev=>{ h.up && h.up(...pos(ev)); };
  cv.addEventListener('pointerup',up); cv.addEventListener('pointercancel',()=>h.up && h.up(-1,-1));
}
const indRot=(cx,x,y,a,fn)=>{ cx.save(); cx.translate(x,y); cx.rotate(a); fn(); cx.restore(); };

/* ---------- Switch (тумблеры и кнопки) ---------- */
const SW_STYLES=['toggle','lever','rocker','button','push'];
function swResize(n){
  const valid=new Set(portsOf(n,'outs').map(p=>p.n));
  Graph.edges.filter(e=>e.from===n.id && !valid.has(e.fp)).forEach(delEdge);
  rebuildNode(n); markTopoDirty();
}
// сетка, в которой переключатели выходят крупнее всего
function swGrid(n,W,H){
  const N=+n.p.count||4; let best=null;
  for(let c=1;c<=N;c++){
    const r=Math.ceil(N/c), s=Math.min(W/c*.8,(H/r-14)*.9,64);
    if(!best || s>best.s) best={c,r,s};
  }
  return {...best, cw:W/best.c, ch:H/best.r};
}
const swSave=n=>{ n.p.state=Array.from({length:+n.p.count||4},(_,k)=>n.on[k]?1:0).join(''); };
def({ id:'switch', lazy:'proc', title:'Switch', cat:'Indicators', kw:'toggle button tumbler lever rocker push latch',
  outs:n=>Array.from({length:+n.p.count||4},(_,k)=>({n:'out'+(k+1),t:'num'})),
  view:{h:80}, resize:true,
  params:[{n:'count',t:'select',opts:IND_LAMP_COUNTS,d:'4',label:'switches',fn:swResize},
          {n:'style',t:'select',opts:SW_STYLES,d:'toggle',label:'style (button latches, push holds while pressed)'},
          {n:'labels',t:'text',d:'',label:'labels (comma separated)'},
          {n:'colors',t:'text',d:'green',label:'colors: '+IND_COLORS.join(', ')+' or #rrggbb, cycled'},
          {n:'state',t:'text',d:'',hidden:true}],
  init:n=>{ n.on=[]; n.an=[]; n.held=-1; String(n.p.state||'').split('').forEach((c,k)=>{ n.on[k]=c==='1'; }); },
  process(n,I){
    const N=+n.p.count||4, o={}, push=n.p.style==='push';
    for(let k=0;k<N;k++){
      const on=push ? n.held===k : !!n.on[k];
      o['out'+(k+1)]=on ? 1 : 0;
      n.an[k]=indSmooth(n.an[k]||0,on ? 1 : 0,.05);
    }
    return o; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, N=+p.count||4;
    indWire(n,cv,{
      down:(x,y)=>{ const g=swGrid(n,cv.width,cv.height), k=Math.floor(y/g.ch)*g.c+Math.floor(x/g.cw);
        if(k<0 || k>=(+n.p.count||4) || x<0) return;
        if(n.p.style==='push') n.held=k; else { n.on[k]=!n.on[k]; swSave(n); } },
      up:()=>{ n.held=-1; }});
    const g=swGrid(n,W,H), s=g.s, labels=String(p.labels||'').split(','), cols=String(p.colors||'').split(',');
    cx.clearRect(0,0,W,H);
    indFont(cx,Math.min(11,s*.22)); cx.textAlign='center'; cx.textBaseline='top';
    const dark=themeColor('--scr-panel'), rim=themeColor('--axis'), hi=themeColor('--scr-hi');
    for(let k=0;k<N;k++){
      const x=(k%g.c+.5)*g.cw, cy=Math.floor(k/g.c)*g.ch+(g.ch-14)/2+2, col=indColor(cols[k%cols.length]);
      const a=n.an[k]||0, w=s/2;
      cx.lineWidth=Math.max(1.5,s*.04); cx.strokeStyle=rim; cx.fillStyle=dark;
      if(p.style==='toggle'){
        const tw=s*1.1, th=s*.56, r=th/2;
        cx.beginPath(); cx.roundRect(x-tw/2,cy-r,tw,th,r); cx.fill();
        cx.globalAlpha=.25+.75*a; cx.fillStyle=col; cx.fill(); cx.globalAlpha=1; cx.stroke();
        const kx=x-tw/2+r+(tw-th)*a;
        cx.save(); cx.shadowColor='#000'; cx.shadowBlur=s*.08; cx.fillStyle=hi;
        cx.beginPath(); cx.arc(kx,cy,r*.8,0,7); cx.fill(); cx.restore();
      } else if(p.style==='lever'){
        const bw=s*.7, bh=s*.95;
        cx.beginPath(); cx.roundRect(x-bw/2,cy-bh/2,bw,bh,s*.1); cx.fill(); cx.stroke();
        cx.fillStyle=col; cx.globalAlpha=.25+.75*a;
        cx.beginPath(); cx.arc(x,cy-bh*.36,s*.05,0,7); cx.fill(); cx.globalAlpha=1;
        const tip=cy+(.5-a)*bh*.7;                      // вкл — рычаг вверх
        cx.strokeStyle=rim; cx.lineWidth=s*.16; cx.lineCap='round';
        cx.beginPath(); cx.moveTo(x,cy); cx.lineTo(x,tip); cx.stroke();
        cx.strokeStyle=hi; cx.lineWidth=s*.1; cx.beginPath(); cx.moveTo(x,cy); cx.lineTo(x,tip); cx.stroke();
        cx.fillStyle=hi; cx.beginPath(); cx.arc(x,tip,s*.12,0,7); cx.fill(); cx.lineCap='butt';
      } else if(p.style==='rocker'){
        const bw=s*.62, bh=s*.9;
        cx.beginPath(); cx.roundRect(x-bw/2,cy-bh/2,bw,bh,s*.08); cx.fill(); cx.stroke();
        cx.save(); cx.beginPath(); cx.roundRect(x-bw/2,cy-bh/2,bw,bh,s*.08); cx.clip();
        cx.fillStyle=col; cx.globalAlpha=.2+.8*a; cx.fillRect(x-bw/2,cy-bh/2,bw,bh*(.62-.24*a));       // верхняя половина: вкл
        cx.globalAlpha=1; cx.restore();
        indFont(cx,s*.24); cx.textBaseline='middle'; cx.fillStyle=themeColor('--scr-hi'); cx.globalAlpha=.4+.6*a;
        cx.fillText('I',x,cy-bh*.22); cx.globalAlpha=.9-.5*a; cx.fillText('O',x,cy+bh*.22); cx.globalAlpha=1;
        indFont(cx,Math.min(11,s*.22)); cx.textBaseline='top';
      } else {
        const sq=p.style==='push', rr=w*.62, press=a*s*.04;
        if(sq){ cx.beginPath(); cx.roundRect(x-w*.8,cy-w*.8,w*1.6,w*1.6,s*.12); cx.fill(); cx.stroke(); }
        else { cx.beginPath(); cx.arc(x,cy,w*.86,0,7); cx.fill(); cx.stroke(); }
        if(a>.01){ cx.save(); cx.globalAlpha=a; cx.strokeStyle=col; cx.shadowColor=col; cx.shadowBlur=s*.3;
          cx.lineWidth=s*.07; cx.beginPath(); if(sq) cx.roundRect(x-w*.8,cy-w*.8,w*1.6,w*1.6,s*.12); else cx.arc(x,cy,w*.86,0,7);
          cx.stroke(); cx.restore(); }
        cx.fillStyle=a>.5 ? col : rim; cx.globalAlpha=.35+.65*a;
        cx.beginPath(); if(sq) cx.roundRect(x-rr-.1*s+press,cy-rr-.1*s+press,(rr+.1*s)*2-press*2,(rr+.1*s)*2-press*2,s*.08); else cx.arc(x,cy+press,rr*(1-a*.05),0,7);
        cx.fill(); cx.globalAlpha=1;
      }
      cx.fillStyle=themeColor('--axis'); cx.textBaseline='top';
      cx.fillText((labels[k]||'').trim()||String(k+1),x,cy+s*.55+4);
    }
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- Attitude (авиагоризонт с шариком скольжения) ---------- */
// крен / тангаж в градусах; без них — из акселерометра x, y, z (устройство лежит экраном вверх)
def({ id:'attitude', lazy:'proc', title:'Attitude', cat:'Indicators', kw:'artificial horizon inclinometer roll pitch bank slip aircraft',
  ins:[{n:'roll',t:'num'},{n:'pitch',t:'num'},{n:'slip',t:'num'},{n:'x',t:'num'},{n:'y',t:'num'},{n:'z',t:'num'}],
  view:{h:190}, resize:true,
  params:[{n:'tau',t:'range',min:0,max:2,step:.01,d:.1,label:'damping, s'},
          {n:'view',t:'range',min:10,max:60,step:1,d:25,label:'pitch from centre to edge, °'},
          {n:'ball',t:'check',d:true,label:'slip ball (slip input −1…1)'}],
  init:n=>{ n.r=null; n.pt=null; n.sr=0; n.sp=0; n.sl=0; },
  process(n,I){
    let r=indNum(I.roll), p=indNum(I.pitch);
    const x=indNum(I.x), y=indNum(I.y), z=indNum(I.z);
    if(r===null && p===null && x!==null && y!==null && z!==null){
      r=Math.atan2(x,z)*180/Math.PI; p=Math.atan2(y,Math.hypot(x,z))*180/Math.PI;
    }
    n.r=r; n.pt=p;
    if(r!==null) n.sr+=indSmooth(0,((r-n.sr+540)%360+360)%360-180,+n.p.tau);
    if(p!==null) n.sp=indSmooth(n.sp,clamp(p,-90,90),+n.p.tau);
    n.sl=indSmooth(n.sl,clamp(indNum(I.slip)||0,-1,1),+n.p.tau);
    return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, TXT=14, BALL=n.p.ball ? 18 : 0, R=Math.max(10,Math.min(W/2,(H-TXT-BALL)/2)-4);
    const X=W/2, Y=R+4, ppd=R/Math.max(5,+n.p.view), roll=n.sr*Math.PI/180;
    cx.clearRect(0,0,W,H);
    cx.save(); cx.beginPath(); cx.arc(X,Y,R,0,7); cx.clip();
    cx.translate(X,Y); cx.rotate(-roll); cx.translate(0,n.sp*ppd);
    const B=R*4;
    cx.fillStyle='#2f6fae'; cx.fillRect(-B,-B,2*B,B);
    cx.fillStyle='#8a5a2a'; cx.fillRect(-B,0,2*B,B);
    cx.strokeStyle='#fff'; cx.fillStyle='#fff'; cx.lineWidth=Math.max(1.5,R*.02);
    cx.beginPath(); cx.moveTo(-B,0); cx.lineTo(B,0); cx.stroke();
    indFont(cx,R*.1); cx.textAlign='center'; cx.textBaseline='middle';
    for(let d=-90;d<=90;d+=5){
      if(!d) continue;
      const major=d%10===0, y=-d*ppd, hw=R*(major?.28:.14);
      if(Math.abs(y+n.sp*ppd)>R*1.1) continue;
      cx.beginPath(); cx.moveTo(-hw,y); cx.lineTo(hw,y); cx.stroke();
      if(major){ cx.fillText(Math.abs(d),-hw-R*.1,y); cx.fillText(Math.abs(d),hw+R*.1,y); }
    }
    cx.restore();
    // шкала крена: вращается с горизонтом, неподвижный указатель сверху
    cx.save(); cx.translate(X,Y); cx.rotate(-roll);
    cx.strokeStyle='#fff'; cx.lineWidth=Math.max(1,R*.02);
    for(const d of [-60,-45,-30,-20,-10,0,10,20,30,45,60]){
      const a=d*Math.PI/180, big=d%30===0, r1=R-2, r2=r1-R*(big?.1:.06);
      cx.beginPath(); cx.moveTo(Math.sin(a)*r1,-Math.cos(a)*r1); cx.lineTo(Math.sin(a)*r2,-Math.cos(a)*r2); cx.stroke();
    }
    cx.restore();
    cx.strokeStyle=themeColor('--axis'); cx.lineWidth=2; cx.beginPath(); cx.arc(X,Y,R,0,7); cx.stroke();
    cx.fillStyle=themeColor('--acc'); cx.beginPath();
    cx.moveTo(X,Y-R+R*.12); cx.lineTo(X-R*.05,Y-R+R*.2); cx.lineTo(X+R*.05,Y-R+R*.2); cx.fill();
    // силуэт самолёта
    cx.strokeStyle=themeColor('--acc'); cx.fillStyle=themeColor('--acc'); cx.lineWidth=Math.max(2,R*.045); cx.lineCap='round';
    cx.beginPath(); cx.moveTo(X-R*.6,Y); cx.lineTo(X-R*.22,Y); cx.lineTo(X-R*.22,Y+R*.08);
    cx.moveTo(X+R*.6,Y); cx.lineTo(X+R*.22,Y); cx.lineTo(X+R*.22,Y+R*.08); cx.stroke(); cx.lineCap='butt';
    cx.beginPath(); cx.arc(X,Y,R*.035,0,7); cx.fill();
    if(n.p.ball){                                   // шарик в изогнутой трубке
      const by=Y+R+11, bw=Math.min(R*.9,W/2-10);
      cx.fillStyle=themeColor('--scr-panel'); cx.strokeStyle=themeColor('--axis'); cx.lineWidth=1.5;
      cx.beginPath(); cx.roundRect(X-bw,by-7,bw*2,14,7); cx.fill(); cx.stroke();
      cx.strokeStyle=themeColor('--scr-hi'); cx.beginPath();
      for(const s of [-1,1]){ cx.moveTo(X+s*5,by-7); cx.lineTo(X+s*5,by+7); } cx.stroke();
      cx.fillStyle=themeColor(Math.abs(n.sl)>.5 ? '--err' : '--acc2'); cx.beginPath(); cx.arc(X+n.sl*(bw-8),by,5.5,0,7); cx.fill();
    }
    indFont(cx,TXT*.75); cx.textAlign='center'; cx.textBaseline='alphabetic'; cx.fillStyle=themeColor('--scr-hi');
    cx.fillText(n.r===null ? '—' : 'roll '+Math.round(n.sr)+'°  pitch '+Math.round(n.sp)+'°',X,H-3);
    cx.textAlign='start'; }
});

/* ---------- ADS-B Radar (PPI) ---------- */
const RD_STEPS=[10,25,50,100,150,200,300,450,600,1000];
const FPM_MS=.00508, KT_MS=.514444;
const rdAlt=a=>a.ground ? 'gnd' : a.alt!=null ? 'FL'+String(Math.round(a.alt/100)).padStart(3,'0') : '';
function rdCentre(n,I){
  const la=indNum(I.lat), lo=indNum(I.lon);
  if(la!==null && lo!==null) return {lat:la,lon:lo};
  if(n.p.lat || n.p.lon) return {lat:+n.p.lat,lon:+n.p.lon};
  return GeoMe.lat!=null ? {lat:GeoMe.lat,lon:GeoMe.lon} : null;
}
def({ id:'adsbradar', lazy:'proc', title:'ADS-B Radar', cat:'Indicators', kw:'aircraft planes adsb radar ppi traffic',
  ins:[{n:'rec',t:'rec'},{n:'lat',t:'num'},{n:'lon',t:'num'}],
  outs:[{n:'rec',t:'rec'},{n:'count',t:'num'},{n:'az',t:'num'},{n:'range',t:'num'},{n:'alt',t:'num'},
        {n:'gs',t:'num'},{n:'track',t:'num'},{n:'fpa',t:'num'},{n:'bank',t:'num'}],
  view:{h:300}, w:340, resize:true,
  params:[{n:'range',t:'select',opts:['auto',...RD_STEPS.map(String)],d:'auto',label:'range, km'},
          {n:'ttl',t:'range',min:10,max:300,step:5,d:60,label:'keep aircraft, s'},
          {n:'trail',t:'range',min:0,max:300,step:5,d:60,label:'trail, s'},
          {n:'labels',t:'check',d:true,label:'labels'},
          {n:'sweep',t:'check',d:true,label:'sweep'},
          {n:'lat',t:'num',d:0,label:'centre latitude (or inputs / My Position)',adv:true},
          {n:'lon',t:'num',d:0,label:'centre longitude',adv:true}],
  init:n=>{ n.ac=new Map(); n.sel=null; n.ctr=null; n.rng=50; n.geo=[]; },
  process(n,I){
    const now=performance.now(), p=n.p;
    n.ctr=rdCentre(n,I);
    for(const r of recList(I.rec)){
      if(!r || r.lat==null || r.lon==null) continue;
      const id=String(r.id ?? r.icao ?? ''); if(!id) continue;
      let a=n.ac.get(id);
      if(!a) n.ac.set(id,a={id,trail:[],bank:0,lt:null});
      const tr=r.heading ?? r.track;
      if(tr!=null && a.tr!=null && a.lt!=null && now-a.lt>=1000){      // координированный разворот: tan(крен)=v·ω/g
        const w=(((tr-a.tr+540)%360+360)%360-180)/((now-a.lt)/1000)*D2R, v=(r.speed ?? r.gs ?? 0)*KT_MS;
        a.bank+=(clamp(Math.atan(v*w/9.81)/D2R,-60,60)-a.bank)*.4; a.lt=now; a.tr=tr;
      } else if(a.lt===null || tr!=null && a.tr==null){ a.lt=now; a.tr=tr ?? null; }
      Object.assign(a,r,{seen:now});
      const last=a.trail[a.trail.length-1];
      if(!last || last[0]!==r.lat || last[1]!==r.lon) a.trail.push([r.lat,r.lon,now]);
    }
    let far=0;
    for(const [id,a] of n.ac){
      if(now-a.seen>p.ttl*1000){ n.ac.delete(id); if(n.sel===id) n.sel=null; continue; }
      while(a.trail.length && now-a.trail[0][2]>p.trail*1000) a.trail.shift();
      if(n.ctr){ a.d=geoDist(n.ctr.lat,n.ctr.lon,a.lat,a.lon); a.b=geoBearing(n.ctr.lat,n.ctr.lon,a.lat,a.lon); far=Math.max(far,a.d); }
    }
    if(p.range==='auto'){
      const want=RD_STEPS.find(s=>s>=far*1.05) || RD_STEPS[RD_STEPS.length-1];
      if(want>n.rng || far<n.rng*.55) n.rng=want;
    } else n.rng=+p.range;
    const s=n.sel && n.ac.get(n.sel), o={count:n.ac.size,rec:null};
    if(s){
      const gs=s.speed ?? s.gs, vr=s.vr;
      Object.assign(o,{rec:s, az:s.b ?? null, range:s.d!=null ? +s.d.toFixed(1) : null, alt:s.alt ?? null, gs:gs ?? null,
        track:s.heading ?? s.track ?? null, bank:+s.bank.toFixed(1),
        fpa:vr!=null && gs ? +(Math.atan(vr*FPM_MS/(gs*KT_MS))/D2R).toFixed(1) : null});
    }
    return o; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, TXT=14, R=Math.max(10,Math.min(W/2,(H-TXT)/2)-4), X=W/2, Y=(H-TXT)/2;
    indWire(n,cv,{down:(x,y)=>{
      let best=null, bd=Math.max(14,R*.08)**2;
      for(const a of n.geo){ const d=(a.x-x)**2+(a.y-y)**2; if(d<bd){ bd=d; best=a.id; } }
      n.sel=best; }});
    const now=performance.now(), rng=n.rng, ctr=n.ctr;
    cx.clearRect(0,0,W,H);
    cx.fillStyle=themeColor('--scr-panel'); cx.beginPath(); cx.arc(X,Y,R,0,7); cx.fill();
    cx.strokeStyle=themeColor('--axis'); cx.lineWidth=1;
    indFont(cx,Math.min(10,R*.09)); cx.textAlign='left'; cx.textBaseline='top'; cx.fillStyle=themeColor('--axis');
    for(let i=1;i<=4;i++){ cx.globalAlpha=i===4 ? 1 : .4; cx.beginPath(); cx.arc(X,Y,R*i/4,0,7); cx.stroke();
      cx.globalAlpha=1; cx.fillText(+(rng*i/4).toPrecision(3),X+2,Y-R*i/4+1); }
    cx.globalAlpha=.4; cx.beginPath(); cx.moveTo(X-R,Y); cx.lineTo(X+R,Y); cx.moveTo(X,Y-R); cx.lineTo(X,Y+R); cx.stroke(); cx.globalAlpha=1;
    cx.textAlign='center'; cx.textBaseline='middle'; cx.fillStyle=themeColor('--err'); cx.fillText('N',X-8,Y-R+8);
    if(n.p.sweep && ctr && typeof cx.createConicGradient==='function'){
      const a=(now/1000*72)%360*D2R-Math.PI/2, gr=cx.createConicGradient(a-Math.PI/3,X,Y), col=themeColor('--t-blk');
      gr.addColorStop(0,'rgba(0,0,0,0)'); gr.addColorStop(.1667,col); gr.addColorStop(.1668,'rgba(0,0,0,0)');
      cx.save(); cx.globalAlpha=.22; cx.fillStyle=gr; cx.beginPath(); cx.arc(X,Y,R,0,7); cx.fill(); cx.restore();
      redraw(n);
    }
    n.geo=[];
    if(!ctr){
      cx.fillStyle=themeColor('--axis'); indFont(cx,Math.min(12,R*.1));
      cx.fillText('no centre: set lat / lon or My Position',X,Y+R*.3);
    } else {
      const xy=(lat,lon)=>{ const d=geoDist(ctr.lat,ctr.lon,lat,lon)/rng*R, b=geoBearing(ctr.lat,ctr.lon,lat,lon)*D2R;
        return [X+Math.sin(b)*d,Y-Math.cos(b)*d]; };
      cx.save(); cx.beginPath(); cx.arc(X,Y,R,0,7); cx.clip();
      const fs=Math.min(10,R*.09), sz=Math.max(4,R*.045);
      for(const a of n.ac.values()){
        const col=a.color || themeColor('--acc'), [x,y]=xy(a.lat,a.lon), isel=a.id===n.sel;
        n.geo.push({id:a.id,x,y});
        if(a.trail.length>1){
          cx.strokeStyle=col; cx.lineWidth=1.2;
          for(let i=1;i<a.trail.length;i++){
            const [x1,y1]=xy(a.trail[i-1][0],a.trail[i-1][1]), [x2,y2]=xy(a.trail[i][0],a.trail[i][1]);
            cx.globalAlpha=.1+.6*clamp(1-(now-a.trail[i][2])/(n.p.trail*1000||1),0,1);
            cx.beginPath(); cx.moveTo(x1,y1); cx.lineTo(x2,y2); cx.stroke();
          }
          cx.globalAlpha=1;
        }
        const fade=clamp(1-(now-a.seen)/(n.p.ttl*1000)*.7,.3,1), hd=(a.heading ?? a.track);
        cx.globalAlpha=fade; cx.fillStyle=col;
        if(hd!=null) indRot(cx,x,y,hd*D2R,()=>{ cx.beginPath(); cx.moveTo(0,-sz*1.3); cx.lineTo(sz*.8,sz); cx.lineTo(0,sz*.45); cx.lineTo(-sz*.8,sz); cx.fill(); });
        else { cx.beginPath(); cx.arc(x,y,sz*.6,0,7); cx.fill(); }
        if(isel){ cx.strokeStyle=themeColor('--scr-hi'); cx.lineWidth=1.5; cx.beginPath(); cx.arc(x,y,sz*2,0,7); cx.stroke(); }
        if(n.p.labels || isel){
          indFont(cx,fs); cx.textAlign='left'; cx.textBaseline='top'; cx.fillStyle=themeColor('--scr-hi');
          cx.fillText(a.flight || a.label || a.id,x+sz*1.6,y-fs-1);
          cx.fillStyle=col; cx.fillText(rdAlt(a),x+sz*1.6,y);
        }
        cx.globalAlpha=1;
      }
      cx.restore();
      cx.fillStyle=themeColor('--acc2'); cx.beginPath(); cx.arc(X,Y,3,0,7); cx.fill();
    }
    indFont(cx,TXT*.75); cx.textAlign='center'; cx.textBaseline='alphabetic'; cx.fillStyle=themeColor('--scr-hi');
    const s=n.sel && n.ac.get(n.sel), gs=s && (s.speed ?? s.gs);
    cx.fillText(s ? [s.flight||s.id, rdAlt(s), gs!=null ? Math.round(gs)+' kt' : '', s.d!=null ? Math.round(s.d)+' km' : ''].filter(Boolean).join('  ·  ')
      : n.ac.size+' aircraft · '+rng+' km',X,H-3);
    cx.textAlign='start'; }
});

/* ---------- Pass (пролёт спутника: высота от времени) ---------- */
// aos / los — время начала и конца пролёта (мс), max — максимальная высота; el — текущая высота.
// Дуга пролёта — приближённо полусинусоида между aos и los
const fmtHMS=s=>{ s=Math.max(0,Math.round(s)); const h=Math.floor(s/3600), m=Math.floor(s%3600/60);
  return (h ? h+':'+String(m).padStart(2,'0') : m)+':'+String(s%60).padStart(2,'0'); };
def({ id:'passplot', lazy:'proc', title:'Pass', cat:'Indicators', kw:'satellite pass aos los elevation prediction',
  ins:[{n:'el',t:'num'},{n:'az',t:'num'},{n:'aos',t:'num'},{n:'los',t:'num'},{n:'max',t:'num'}],
  view:{h:130}, w:340, resize:true,
  params:[{n:'horizon',t:'num',d:0,label:'horizon, °'},
          {n:'trail',t:'range',min:0,max:3600,step:30,d:900,label:'history while visible, s'}],
  init:n=>{ n.h=[]; n.el=null; n.az=null; n.aos=null; n.los=null; n.mx=null; },
  process(n,I){
    const now=Date.now();
    n.el=indNum(I.el); n.az=indNum(I.az); n.aos=indNum(I.aos); n.los=indNum(I.los); n.mx=indNum(I.max);
    if(n.el!==null){
      if(!n.h.length || now-n.h[n.h.length-1][0]>=1000) n.h.push([now,n.el]);
      while(n.h.length && (now-n.h[0][0]>n.p.trail*1000 || n.h.length>4000)) n.h.shift();
    }
    return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, hz=+n.p.horizon||0, now=Date.now(), pl=26, pr=8, pt=18, pb=16, w=W-pl-pr, h=H-pt-pb;
    cx.clearRect(0,0,W,H);
    const have=n.aos!==null && n.los!==null && n.los>n.aos;
    const mx=Math.max(30,Math.ceil(((have && n.mx!==null ? n.mx : 0) || 30)/15)*15), up=n.el!==null && n.el>hz;
    const t0=have ? n.aos : now-60000, t1=have ? n.los : now+60000;
    const X=t=>pl+(t-t0)/(t1-t0)*w, Yy=e=>pt+h-clamp((e-hz)/(mx-hz),0,1)*h;
    indFont(cx,Math.min(10,H*.1)); cx.textBaseline='middle'; cx.textAlign='right';
    cx.strokeStyle=themeColor('--axis'); cx.fillStyle=themeColor('--axis'); cx.lineWidth=1;
    for(let e=Math.ceil(hz/15)*15;e<=mx;e+=15){ cx.globalAlpha=e===hz ? 1 : .3; cx.beginPath(); cx.moveTo(pl,Yy(e)); cx.lineTo(pl+w,Yy(e)); cx.stroke();
      cx.globalAlpha=1; cx.fillText(e+'°',pl-3,Yy(e)); }
    cx.beginPath(); cx.moveTo(pl,Yy(hz)); cx.lineTo(pl+w,Yy(hz)); cx.stroke();
    if(have){
      const mxe=n.mx ?? 30, f=t=>hz+(mxe-hz)*Math.sin(Math.PI*clamp((t-n.aos)/(n.los-n.aos),0,1));
      cx.beginPath(); cx.moveTo(X(n.aos),Yy(hz));
      for(let i=0;i<=40;i++){ const t=n.aos+(n.los-n.aos)*i/40; cx.lineTo(X(t),Yy(f(t))); }
      cx.globalAlpha=.18; cx.fillStyle=themeColor('--acc2'); cx.fill(); cx.globalAlpha=1;
      cx.strokeStyle=themeColor('--acc2'); cx.lineWidth=1.5; cx.stroke();
      if(now>=n.aos && now<=n.los){
        cx.strokeStyle=themeColor('--axis'); cx.setLineDash([3,3]); cx.beginPath(); cx.moveTo(X(now),pt); cx.lineTo(X(now),pt+h); cx.stroke(); cx.setLineDash([]);
        if(up){ cx.fillStyle=themeColor('--acc'); cx.shadowColor=themeColor('--acc'); cx.shadowBlur=8;
          cx.beginPath(); cx.arc(X(now),Yy(n.el),4,0,7); cx.fill(); cx.shadowBlur=0; }
      } else if(up){ cx.fillStyle=themeColor('--acc'); cx.beginPath(); cx.arc(clamp(X(now),pl,pl+w),Yy(n.el),4,0,7); cx.fill(); }
      cx.textAlign='center'; cx.textBaseline='top'; cx.fillStyle=themeColor('--axis');
      const hm=t=>new Date(t).toTimeString().slice(0,5);
      cx.textAlign='left'; cx.fillText(hm(n.aos),pl,pt+h+3); cx.textAlign='right'; cx.fillText(hm(n.los),pl+w,pt+h+3);
    } else if(n.h.length>1){                          // нет прогноза — рисуем, что было
      cx.strokeStyle=themeColor('--acc2'); cx.lineWidth=1.5; cx.beginPath();
      n.h.forEach(([t,e],i)=>{ const x=pl+clamp((t-(now-n.p.trail*1000))/(n.p.trail*1000),0,1)*w; i ? cx.lineTo(x,Yy(e)) : cx.moveTo(x,Yy(e)); });
      cx.stroke();
    }
    indFont(cx,Math.min(12,H*.12)); cx.textBaseline='top'; cx.textAlign='left'; cx.fillStyle=themeColor('--scr-hi');
    const status=!have ? 'no pass data' : now<n.aos ? 'AOS in '+fmtHMS((n.aos-now)/1000) : now<=n.los ? 'LOS in '+fmtHMS((n.los-now)/1000) : 'pass over';
    cx.fillText(status,pl,2);
    cx.textAlign='right'; cx.fillStyle=themeColor('--axis');
    cx.fillText((n.el!==null ? 'el '+Math.round(n.el)+'°' : '')+(n.az!==null ? '  az '+Math.round(n.az)+'°' : '')+(have && n.mx!==null ? '  max '+Math.round(n.mx)+'°' : ''),W-pr,2);
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});
