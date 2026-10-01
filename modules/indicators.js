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

/* ---------- Sky Plot (азимут / высота) ---------- */
const SKY_MAX=1500;
def({ id:'skyplot', lazy:'proc', title:'Sky Plot', cat:'Output',
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
def({ id:'smeter', lazy:'proc', title:'S-Meter', cat:'Output', ins:[{n:'in',t:'num'}],
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
def({ id:'ticker', lazy:'proc', title:'Text Ticker', cat:'Output',
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
