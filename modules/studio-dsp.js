"use strict";
/* ============================ STUDIO: DSP ДЛЯ УЗЛОВ ГРАФА (без DOM и Web Audio) ============================
   Те же эффекты и ударные, что в студии, но как блочные процессоры на Float32Array: их используют самостоятельные узлы
   (Mixer, Drum Machine…) в обычном графе DSP — тактируются от clk, берут и отдают обычные сигналы.
   Эффект: stFxNew(type,sr) → {set(p,ctx), run(L,R,n)}; R=null — моно-дорожка. ctx: {bpm, beat} (beat — доля такта в начале блока). */

const stDb=db=>Math.pow(10,db/20);
const stLin2Db=x=>20*Math.log10(Math.max(x,1e-9));

/* ---------- бикварад (RBJ) ---------- */
function stBqCoef(type,f,q,gdb,sr){
  f=Math.min(Math.max(f,10),sr*.45); q=Math.max(q,.05);
  const w=2*Math.PI*f/sr, cs=Math.cos(w), sn=Math.sin(w), A=Math.pow(10,(gdb||0)/40), al=sn/(2*q);
  let b0,b1,b2,a0,a1,a2;
  switch(type){
    case 'lp': b0=(1-cs)/2; b1=1-cs; b2=b0; a0=1+al; a1=-2*cs; a2=1-al; break;
    case 'hp': b0=(1+cs)/2; b1=-(1+cs); b2=b0; a0=1+al; a1=-2*cs; a2=1-al; break;
    case 'bp': b0=al; b1=0; b2=-al; a0=1+al; a1=-2*cs; a2=1-al; break;
    case 'notch': b0=1; b1=-2*cs; b2=1; a0=1+al; a1=-2*cs; a2=1-al; break;
    case 'peak': b0=1+al*A; b1=-2*cs; b2=1-al*A; a0=1+al/A; a1=-2*cs; a2=1-al/A; break;
    case 'lowshelf':{ const s=2*Math.sqrt(A)*al;
      b0=A*((A+1)-(A-1)*cs+s); b1=2*A*((A-1)-(A+1)*cs); b2=A*((A+1)-(A-1)*cs-s); a0=(A+1)+(A-1)*cs+s; a1=-2*((A-1)+(A+1)*cs); a2=(A+1)+(A-1)*cs-s; break; }
    case 'highshelf':{ const s=2*Math.sqrt(A)*al;
      b0=A*((A+1)+(A-1)*cs+s); b1=-2*A*((A-1)+(A+1)*cs); b2=A*((A+1)+(A-1)*cs-s); a0=(A+1)-(A-1)*cs+s; a1=2*((A-1)-(A+1)*cs); a2=(A+1)-(A-1)*cs-s; break; }
    default: return {b0:1,b1:0,b2:0,a1:0,a2:0};
  }
  return {b0:b0/a0,b1:b1/a0,b2:b2/a0,a1:a1/a0,a2:a2/a0};
}
class StBq{
  constructor(){ this.c={b0:1,b1:0,b2:0,a1:0,a2:0}; this.x1=this.x2=this.y1=this.y2=0; }
  set(type,f,q,g,sr){ this.c=stBqCoef(type,f,q,g,sr); }
  run(b,n){
    const {b0,b1,b2,a1,a2}=this.c; let x1=this.x1,x2=this.x2,y1=this.y1,y2=this.y2;
    for(let i=0;i<n;i++){ const x=b[i], y=b0*x+b1*x1+b2*x2-a1*y1-a2*y2; x2=x1; x1=x; y2=y1; y1=y; b[i]=y; }
    this.x1=x1; this.x2=x2; this.y1=y1; this.y2=y2;
  }
}
const stOnePole=(f,sr)=>1-Math.exp(-2*Math.PI*Math.min(f,sr*.45)/sr);          // коэффициент однополюсного ФНЧ
// сухой / мокрый для вставочных эффектов на посыле: dry = min(1, 2(1-mix)), как в студии
const stDryOf=m=>Math.min(1,2*(1-m));

/* ---------- эффекты ---------- */
class StFxBase{
  constructor(sr){ this.sr=sr; this.p={}; this.ctx={bpm:120,beat:0}; }
  set(p,ctx){ this.p=p; if(ctx) this.ctx=ctx; this.update(); }
  update(){}
  chans(L,R){ return R?[L,R]:[L]; }
}
class StFxEq extends StFxBase{
  constructor(sr){ super(sr); this.f=[[new StBq,new StBq,new StBq],[new StBq,new StBq,new StBq]]; }
  update(){ const p=this.p, sr=this.sr; this.on=!!(p.lo||p.mid||p.hi);
    for(const c of this.f){ c[0].set('lowshelf',p.lf,.7,p.lo,sr); c[1].set('peak',p.mf,p.q,p.mid,sr); c[2].set('highshelf',p.hf,.7,p.hi,sr); } }
  run(L,R,n){ if(!this.on) return; [L,R].forEach((b,k)=>{ if(b) for(const f of this.f[k]) f.run(b,n); }); }
}
class StFxFilter extends StFxBase{
  constructor(sr){ super(sr); this.f=[new StBq,new StBq]; this.tmp=new Float32Array(8192); }
  update(){ for(const f of this.f) f.set(this.p.type,this.p.cut,Math.max(.3,this.p.res),0,this.sr); }
  run(L,R,n){
    const m=this.p.mix; [L,R].forEach((b,k)=>{ if(!b) return; if(m>=.999){ this.f[k].run(b,n); return; }
      const t=this.tmp; t.set(b.subarray(0,n)); this.f[k].run(t,n); for(let i=0;i<n;i++) b[i]+= (t[i]-b[i])*m; }); }
}
class StFxComp extends StFxBase{
  constructor(sr){ super(sr); this.env=0; }
  update(){ const p=this.p, sr=this.sr; this.ka=Math.exp(-1/(Math.max(p.att,.0005)*sr)); this.kr=Math.exp(-1/(Math.max(p.rel,.005)*sr)); this.mk=stDb(p.gain); }
  run(L,R,n){
    const p=this.p; let env=this.env;
    for(let i=0;i<n;i++){
      const a=Math.max(Math.abs(L[i]),R?Math.abs(R[i]):0), d=stLin2Db(a), over=d-p.thr;
      let gr=0; if(over>p.knee/2) gr=over*(1-1/p.ratio); else if(over>-p.knee/2) gr=Math.pow(over+p.knee/2,2)/(2*Math.max(p.knee,.001))*(1-1/p.ratio);
      env = gr>env ? this.ka*env+(1-this.ka)*gr : this.kr*env+(1-this.kr)*gr;
      const g=stDb(-env)*this.mk; L[i]*=g; if(R) R[i]*=g; }
    this.env=env; this.red=-env;
  }
}
class StFxDelay extends StFxBase{
  constructor(sr){ super(sr); this.size=Math.ceil(sr*4)+8; this.b=[new Float32Array(this.size),new Float32Array(this.size)]; this.w=0; this.lp=[0,0]; }
  run(L,R,n){
    const p=this.p, sr=this.sr, d=Math.min(this.size-4,Math.max(8,Math.round(ST_DIV[p.div]*60/this.ctx.bpm*sr))), a=stOnePole(p.tone,sr), dry=stDryOf(p.mix), mix=p.mix, fb=p.fb, S=this.size;
    const bl=this.b[0], br=this.b[1]; let w=this.w, l0=this.lp[0], l1=this.lp[1];
    for(let i=0;i<n;i++){
      const r=(w-d+S)%S, xl=L[i], xr=R?R[i]:xl;
      const dl=bl[r], dr=br[r];
      l0+=a*(dl-l0); l1+=a*(dr-l1);
      if(R && p.pp){ bl[w]=(xl+xr)*.5+l1*fb; br[w]=l0*fb; }           // пинг-понг: вход в левую линию, эхо перетекает вправо и обратно
      else{ bl[w]=xl+l0*fb; br[w]=xr+l1*fb; }
      const ol=R&&p.pp?dl*.8:dl, or=R&&p.pp?dr*.8:dr;
      L[i]=xl*dry+ol*mix; if(R) R[i]=xr*dry+or*mix;
      w=(w+1)%S; }
    this.w=w; this.lp[0]=l0; this.lp[1]=l1;
  }
}
// ревербератор Фривёрб: гребёнки + all-pass, время RT60 = size
class StFxReverb extends StFxBase{
  constructor(sr){ super(sr);
    const k=sr/44100, cl=[1116,1188,1277,1356,1422,1491,1557,1617].map(x=>Math.round(x*k)), al=[556,441,341,225].map(x=>Math.round(x*k)), sp=Math.round(23*k);
    this.combs=[0,1].map(ch=>cl.map(l=>({b:new Float32Array(l+(ch?sp:0)),i:0,s:0,fb:.8}))); this.aps=[0,1].map(ch=>al.map(l=>({b:new Float32Array(l+(ch?sp:0)),i:0})));
    this.pre=new Float32Array(Math.ceil(sr*.2)+4); this.pw=0; this.hp=[new StBq,new StBq]; }
  update(){ const p=this.p, sr=this.sr; this.damp=.05+.9*p.damp; for(const ch of this.combs) for(const c of ch) c.fb=Math.pow(10,-3*c.b.length/(sr*Math.max(.2,p.size)));
    this.pd=Math.round(p.pre*sr); for(const h of this.hp) h.set('hp',p.lc,.7,0,sr); }
  run(L,R,n){
    const p=this.p, dry=stDryOf(p.mix), wet=p.mix*.55, S=this.pre.length, lt=this.tmpL||(this.tmpL=new Float32Array(8192)), rt=this.tmpR||(this.tmpR=new Float32Array(8192));
    let pw=this.pw;
    for(let i=0;i<n;i++){
      const x=R?(L[i]+R[i])*.5:L[i]; this.pre[pw]=x; const xin=this.pre[(pw-this.pd+S)%S]*.03; pw=(pw+1)%S;
      for(let ch=0;ch<2;ch++){
        let o=0; for(const c of this.combs[ch]){ const y=c.b[c.i]; c.s=y*(1-this.damp)+c.s*this.damp; c.b[c.i]=xin+c.s*c.fb; if(++c.i>=c.b.length) c.i=0; o+=y; }
        for(const a of this.aps[ch]){ const y=a.b[a.i], z=o+y*.5; a.b[a.i]=z; o=y-z*.5; if(++a.i>=a.b.length) a.i=0; }
        (ch?rt:lt)[i]=o; }
    }
    this.pw=pw; this.hp[0].run(lt,n); this.hp[1].run(rt,n);
    for(let i=0;i<n;i++){ const xl=L[i]; L[i]=xl*dry+lt[i]*wet*14; if(R) R[i]=R[i]*dry+rt[i]*wet*14; }
  }
}
class StFxChorus extends StFxBase{
  constructor(sr){ super(sr); this.S=Math.ceil(sr*.06); this.b=[new Float32Array(this.S),new Float32Array(this.S)]; this.w=0; this.ph=0; }
  run(L,R,n){
    const p=this.p, sr=this.sr, S=this.S, dep=p.depth*.004*sr, inc=p.rate/sr, dry=1-p.mix*.5; let w=this.w, ph=this.ph;
    const rd=(b,pos)=>{ const i=Math.floor(pos), f=pos-i; return b[(i+S)%S]*(1-f)+b[(i+1+S)%S]*f; };
    for(let i=0;i<n;i++){
      const x=L[i], xr=R?R[i]:x; this.b[0][w]=x; this.b[1][w]=xr;
      const m1=Math.sin(2*Math.PI*ph), m2=-m1;
      const d1=.012*sr+m1*dep, d2=.020*sr+m2*dep, o1=rd(this.b[0],w-d1), o2=rd(this.b[1],w-d2);
      L[i]=x*dry+(R?o1:(o1+o2)*.7)*p.mix; if(R) R[i]=xr*dry+o2*p.mix;
      w=(w+1)%S; ph+=inc; if(ph>=1) ph-=1; }
    this.w=w; this.ph=ph;
  }
}
class StFxPhaser extends StFxBase{
  constructor(sr){ super(sr); this.z=[[0,0,0,0],[0,0,0,0]]; this.fb=[0,0]; this.ph=0; }
  run(L,R,n){
    const p=this.p, sr=this.sr, inc=p.rate/sr, dry=1-p.mix*.4; let ph=this.ph;
    for(let i=0;i<n;i++){
      const lfo=.5+.5*Math.sin(2*Math.PI*ph), f=300*Math.pow(2,lfo*3*p.depth+.5), t=Math.tan(Math.PI*Math.min(f,sr*.45)/sr), a=(t-1)/(t+1);
      [L,R].forEach((b,k)=>{ if(!b) return; let x=b[i]+this.fb[k]*p.fb; const z=this.z[k];
        for(let s=0;s<4;s++){ const y=a*x+z[s]; z[s]=x-a*y; x=y; }
        this.fb[k]=x; b[i]=b[i]*dry+x*p.mix; });
      ph+=inc; if(ph>=1) ph-=1; }
    this.ph=ph;
  }
}
class StFxDist extends StFxBase{
  constructor(sr){ super(sr); this.lp=[0,0]; this.key=''; }
  update(){ const p=this.p, k=p.type+Math.round(p.drive*40); if(k!==this.key){ this.key=k; this.curve=stDriveCurve(p.drive,p.type,1024); } this.a=stOnePole(p.tone,this.sr); }
  run(L,R,n){
    const p=this.p, c=this.curve, N=c.length-1, a=this.a, wet=p.mix, dry=1-p.mix;
    [L,R].forEach((b,k)=>{ if(!b) return; let lp=this.lp[k];
      for(let i=0;i<n;i++){ const x=b[i], u=Math.min(1,Math.max(-1,x*(1+p.drive*1.5)))*.5+.5, q=u*N, j=Math.floor(q), f=q-j, y=c[j]*(1-f)+c[Math.min(N,j+1)]*f;
        lp+=a*(y-lp); b[i]=x*dry+lp*p.out*wet; }
      this.lp[k]=lp; });
  }
}
class StFxCrush extends StFxBase{
  run(L,R,n){ const q=Math.pow(2,this.p.bits-1), m=this.p.mix; [L,R].forEach(b=>{ if(b) for(let i=0;i<n;i++){ const x=b[i]; b[i]=x+(Math.round(x*q)/q-x)*m; } }); }
}
class StFxPump extends StFxBase{
  run(L,R,n){
    const p=this.p, bps=this.ctx.bpm/60, div=ST_DIV[p.div], tau=Math.max(.01,p.rel*div/3), dbeat=bps/this.sr; let b=this.ctx.beat;
    for(let i=0;i<n;i++){ let ph=((b-p.off)%div+div)%div; const g=1-p.depth*Math.exp(-ph/tau); L[i]*=g; if(R) R[i]*=g; b+=dbeat; }
  }
}
class StFxGate extends StFxBase{
  run(L,R,n){
    const p=this.p, bps=this.ctx.bpm/60, div=ST_DIV[p.div==='1/16'?'1/16':p.div], dbeat=bps/this.sr, low=1-p.depth;
    const on=i=>p.pat==='even'||p.pat==='roll'?true:p.pat==='offbeat'?i%2===1:p.pat==='x.xx'?[0,2,3].includes(i%4):[0,1,3].includes(i%4);
    let b=this.ctx.beat, g=this.g==null?1:this.g; const k=Math.exp(-1/(.002*this.sr));
    for(let i=0;i<n;i++){ const si=Math.floor(b/div), fr=(b/div)-si, open=on(((si%16)+16)%16) && fr<(p.pat==='roll'?p.len*.5:p.len), tg=open?1:low;
      g=tg+(g-tg)*k; L[i]*=g; if(R) R[i]*=g; b+=dbeat; }
    this.g=g;
  }
}
class StFxWidth extends StFxBase{
  run(L,R,n){ if(!R) return; const w=this.p.width, pn=this.p.pan, gl=pn>0?1-pn:1, gr=pn<0?1+pn:1;
    for(let i=0;i<n;i++){ const m=(L[i]+R[i])*.5, s=(L[i]-R[i])*.5*w; L[i]=(m+s)*gl; R[i]=(m-s)*gr; } }
}
const ST_FX_DSP={eq:StFxEq,filter:StFxFilter,comp:StFxComp,delay:StFxDelay,reverb:StFxReverb,chorus:StFxChorus,phaser:StFxPhaser,dist:StFxDist,crush:StFxCrush,pump:StFxPump,gate:StFxGate,width:StFxWidth};
function stFxNew(type,sr){ const C=ST_FX_DSP[type]; return C?new C(sr):null; }

/* ---------- ударные и клипы: голоса в блоках ---------- */
// голос: {kind,p,v,t,ph:[],lp:[],seed,done}; рендер добавляет в буфер. Параметры — как у канала drum студии (pit, dec, tone, pun, drv, vol)
const stRnd=v=>{ v.seed=(v.seed*1664525+1013904223)>>>0; return v.seed/2147483648-1; };
function stJsDrumVoice(kind,p,vel,sr,seed){
  return {kind,p,v:Math.pow(vel/127,1.3)*p.vol,t:0,ph:[0,0,0,0,0,0,0],lp:[0,0],hp:0,seed:seed||12345,done:false,sr,k2:Math.pow(2,p.pit/12)};
}
const ST_METAL=[80,120,166.4,217.2,271.6,328.4];
function stJsDrumRender(v,out,n,off){
  if(v.done) return; const sr=v.sr, p=v.p, dec=p.dec, k2=v.k2; let t=v.t;
  const e=(tau)=>Math.exp(-t/(tau*sr));
  for(let i=0;i<n;i++,t++){
    let s=0;
    switch(v.kind){
      case 'kick':{ const fe=(42+p.tone*30)*k2, fs=fe*(2.5+p.pun*7), f=fe+(fs-fe)*Math.exp(-t/(.02*sr)); v.ph[0]+=f/sr; s=Math.sin(2*Math.PI*v.ph[0])*e(.11*dec);
        if(p.pun>.05 && t<.01*sr){ const x=stRnd(v); v.hp+=(x-v.hp)*.7; s+=(x-v.hp)*p.pun*.5*Math.exp(-t/(.004*sr)); }
        if(t>.9*dec*sr+.2*sr) v.done=true; break; }
      case 'snare':{ const f=(175+85*Math.exp(-t/(.05*sr)))*k2; v.ph[0]+=f/sr; const tone=Math.sin(2*Math.PI*v.ph[0])*(.9-p.tone*.5)*e(.05*dec);
        const x=stRnd(v); v.hp+=(x-v.hp)*.35; const ns=(x-v.hp)*(.5+p.tone*.6)*e(.075*dec*(.7+p.tone)); s=tone+ns; if(t>.7*dec*sr) v.done=true; break; }
      case 'clap':{ const x=stRnd(v); v.lp[0]+=(x-v.lp[0])*.25; const y=v.lp[0]-v.lp[1]*0; v.lp[1]+=(x-v.lp[1])*.02; const b=v.lp[0]-v.lp[1];
        const ms=t/sr*1000; let a=0; if(ms<33){ const k=Math.floor(ms/11), f=ms-k*11; a=Math.exp(-f/4); } else a=Math.exp(-(ms-34)/(70*dec));
        s=b*a*3; if(t>.6*dec*sr) v.done=true; break; }
      case 'chat': case 'ohat': case 'crash':{ const mul=v.kind==='crash'?1.3:1; let m=0;
        for(let q=0;q<6;q++){ v.ph[q]+=ST_METAL[q]*k2*mul/sr; if(v.ph[q]>=1) v.ph[q]-=1; m+=(v.ph[q]<.5?1:-1)*.17; }
        const x=m+stRnd(v)*(.3+p.tone*.4); v.hp+=(x-v.hp)*(v.kind==='crash'?.45:.62); s=(x-v.hp)*.75*e((v.kind==='chat'?.022:v.kind==='ohat'?.12:.55)*dec);
        if(t>(v.kind==='chat'?.022:v.kind==='ohat'?.12:.55)*dec*7*sr) v.done=true; break; }
      case 'tom':{ const f=105*k2*(1+1.1*Math.exp(-t/(.03*sr))); v.ph[0]+=f/sr; s=Math.sin(2*Math.PI*v.ph[0])*e(.13*dec); if(t>.9*dec*sr) v.done=true; break; }
      case 'rim':{ v.ph[0]+=1700*k2/sr; v.ph[1]+=480*k2/sr; s=(Math.sin(2*Math.PI*v.ph[0])*.7+(Math.abs((v.ph[1]%1)*4-2)-1)*.5)*e(.012*dec)+stRnd(v)*.3*e(.01); if(t>.2*dec*sr) v.done=true; break; }
      default:{ v.ph[0]+=540*k2/sr; v.ph[1]+=800*k2/sr; s=((v.ph[0]%1<.5?1:-1)+(v.ph[1]%1<.5?1:-1))*.35*e(.12*dec); v.lp[0]+=(s-v.lp[0])*.3; s=v.lp[0]*1.4; if(t>.9*dec*sr) v.done=true; }
    }
    if(p.drv>.01) s=Math.tanh(s*(1+p.drv*6))/Math.tanh(1+p.drv*6);
    out[off+i]+=s*v.v;
    if(v.done){ t++; break; }
  }
  v.t=t;
}
// клип (моно Float32Array) с изменением высоты; step — шаг чтения в сэмплах клипа на сэмпл вывода
function stJsClipVoice(data,srClip,sr,key,root,pit,vol,vel){
  return {data,pos:0,step:srClip/sr*Math.pow(2,((key-root)+pit)/12),v:Math.pow(vel/127,1.2)*vol,done:false};
}
function stJsClipRender(v,out,n,off){
  if(v.done) return; const d=v.data, N=d.length; let pos=v.pos;
  for(let i=0;i<n;i++){ const k=Math.floor(pos); if(k>=N-1){ v.done=true; break; } const f=pos-k; out[off+i]+=(d[k]*(1-f)+d[k+1]*f)*v.v; pos+=v.step; }
  v.pos=pos;
}
