"use strict";
/* ============================ Аналоговое видео: ядра блоков ============================
   Аналоговое ТВ и FPV: IQ → композитный видеосигнал → кадры.
   TV Demodulator: FM (FPV 5.8 ГГц, спутниковое ТВ) или AM с негативной модуляцией (эфирное ТВ) → вещественный поток,
   синхроимпульсы внизу. TV Decoder: строчная и кадровая синхронизация, PAL / NTSC (стандарт по числу строк
   в поле), цвет по вспышке (для PAL — с коммутацией V и усреднением соседних строк), картинка в 'img'.
   Генератор тестовой таблицы (для iqGen): tvGenerate. Без DOM: этот файл грузит и воркер острова. */

// Параметры стандартов, мкс. vs — начало первой строчной синхронизации в поле (в строках от начала поля),
// np — импульсов в каждой из трёх групп кадрового синхроимпульса, vb — строк гашения перед картинкой.
const TVS={
  PAL:{T:64, fld:312.5, fsc:4433618.75, sync:.3, span:.7, bmag:.15, vs:7.5, np:5, vb:17, rows:288,
       b0:5.6, bn:10, bc0:6.2, bcyc:6, wEq:2.35, a0:10.5, a1:62},
  NTSC:{T:1e6/15734.264, fld:262.5, fsc:3579545.45, sync:.286, span:.714, bmag:.143, vs:9.5, np:6, vb:12, rows:240,
       b0:5.3, bn:9, bc0:6.0, bcyc:5, wEq:2.3, a0:10.5, a1:62},
};
const TV_STD={auto:'PAL', PAL:'PAL', NTSC:'NTSC'};

/* ---- тестовая таблица ---- */
// Цветные полосы 80% сверху, серая шкала, рамка по краю; x, y — доли кадра. → [r,g,b] 0…1 (уже с гаммой)
function tvPat(x,y){
  if(x<.012 || x>.988 || y<.012 || y>.988) return [1,1,1];
  if(y<.72){ const k=Math.min(7,Math.floor(x*8)), b=[[1,1,1],[1,1,0],[0,1,1],[0,1,0],[1,0,1],[1,0,0],[0,0,1],[0,0,0]][k];
    return [b[0]*.8,b[1]*.8,b[2]*.8]; }
  if(y<.86){ const g=Math.min(1,x); return [g,g,g]; }
  return x<.5 ? [.12,.12,.12] : [.6,.45,.3];
}
const TVL_C=new Float32Array(8192), TVL_S=new Float32Array(8192);
for(let i=0;i<8192;i++){ TVL_C[i]=Math.cos(2*Math.PI*i/8192); TVL_S[i]=Math.sin(2*Math.PI*i/8192); }

// Зоны таблицы по вертикали: рамка, полосы, шкала серого, низ; в каждой — по строке из 1024 отсчётов (Y и цветоразности, до масштаба span)
function tvZones(){
  const zy=[.005,.4,.8,.93], Z=[];
  for(const y of zy){
    const Yv=new Float32Array(1024), Ub=new Float32Array(1024), Vr=new Float32Array(1024);
    for(let k=0;k<1024;k++){ const p=tvPat((k+.5)/1024,y), Y=.299*p[0]+.587*p[1]+.114*p[2];
      Yv[k]=Y; Ub[k]=.493*(p[2]-Y); Vr[k]=.877*(p[0]-Y); }
    Z.push({Yv,Ub,Vr});
  }
  return Z;
}
const TV_ZONES=tvZones();

// N отсчётов комплексной огибающей: FM (dev — размах девиации, Гц) или AM с негативной модуляцией. → [re, im]
function tvGenerate(n,sr,N){
  const st=TVS[n.p.tv==='NTSC' ? 'NTSC' : 'PAL'], pal=st===TVS.PAL, fm=n.p.tvm!=='AM', dev=+n.p.tvdev||8e6;
  const g=n.tvg||(n.tvg={uf:0, c:1, s:0, sw:1, ln:-1, ph:0});
  const re=new Float32Array(N), im=new Float32Array(N);
  const du=1e6/(sr*st.T), frame=2*st.fld, blank=st.sync, span=st.span;
  const dph=2*Math.PI*st.fsc/sr, cs=Math.cos(dph), sn=Math.sin(dph), a=st.bmag/Math.SQRT2, bmag=st.bmag;
  const bEnd=st.b0+st.bn*1e6/st.fsc, kf=dev/sr*8192, T=st.T, T2=T/2, brEnd=T2-4.7;
  const a0=st.a0, ka=1024/(st.a1-st.a0), vs=st.vs, np=st.np, wEq=st.wEq, rows=st.rows, vb=st.vb, fld=st.fld;
  let uf=g.uf, c=g.c, s=g.s, sw=g.sw, ln=g.ln, ph=g.ph, Z=TV_ZONES[0], vis=false;
  const psw=pal ? 1 : 0;
  for(let i=0;i<N;i++){
    uf+=du; if(uf>=frame) uf-=frame;
    const f=uf>=fld ? 1 : 0, u=uf-f*fld;
    let v;
    if(u<vs){                                                // кадровый синхроимпульс: 3 группы по np импульсов, шаг T/2
      const h=u*2, p=h|0, tau=(h-p)*T2;
      v=(p>=np && p<2*np ? tau<brEnd : tau<wEq) ? 0 : blank;
    } else {
      const uu=u-vs+1e-9, kk=uu|0, tau=(uu-kk-1e-9)*T;
      const id=f*1000+kk;
      if(id!==ln){
        sw=-sw; ln=id;
        const r=kk-vb, y=r>=0 && r<rows ? (2*r+f+.5)/(2*rows) : -1;
        vis=y>=0; if(vis) Z=TV_ZONES[y<.012 || y>.988 ? 0 : y<.72 ? 1 : y<.86 ? 2 : 3];
      }
      v=blank;
      if(tau<4.7) v=0;
      else if(tau>=st.b0 && tau<bEnd) v=blank+(pal ? -a*s+sw*a*c : -bmag*s);
      else if(vis && tau>=a0 && tau<st.a1){
        const q=((tau-a0)*ka)|0;
        v=blank+span*(Z.Yv[q]+Z.Ub[q]*s+(psw ? sw : 1)*Z.Vr[q]*c);
      }
    }
    const t=c*cs-s*sn; s=s*cs+c*sn; c=t;
    if(fm){
      ph+=kf*(v-.5); if(ph>=8192) ph-=8192; else if(ph<0) ph+=8192;
      const q=ph|0; re[i]=TVL_C[q]; im[i]=TVL_S[q];
    } else re[i]=1-.8*v;
  }
  const m=1/Math.hypot(c,s); g.uf=uf; g.c=c*m; g.s=s*m; g.sw=sw; g.ln=ln; g.ph=ph;
  return [re,im];
}

// atan2 с ошибкой ~1e-5 рад: дискриминатор на 10+ МС/с не может позволить Math.atan2
function tvAtan2(y,x){
  const ax=x<0?-x:x, ay=y<0?-y:y, mx=ax>ay?ax:ay, mn=ax>ay?ay:ax;
  if(mx===0) return 0;
  const q=mn/mx, s=q*q;
  let r=((-0.0464964749*s+0.15931422)*s-0.327622764)*s*q+q;
  if(ay>ax) r=1.57079637-r;
  if(x<0) r=3.14159274-r;
  return y<0 ? -r : r;
}

/* ---- TV Demodulator ---- */
IQK.tvDemod={
  init(n){ n.key=''; n.pr=1; n.pi=0; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {out:null}; }
    const sr=s.sr, mode=n.p.mode, fm=mode==='FM', bw=Math.min(+n.p.bw,.45*sr);
    const key=[sr,bw].join('|');
    if(key!==n.key){ n.key=key; n.bq=[.5411961,1.3065630].map(Q=>biquadCoef('lp',bw,Q,sr)); n.z=new Float64Array(8); }
    const o=iqStream(n,'out',sr,0), q0=n.bq[0], q1=n.bq[1], z=n.z;
    const kf=sr/(2*Math.PI*n.p.dev), sg=(n.p.inv ? -1 : 1)*(mode==='AM (positive)' ? 1 : -1);
    let pr=n.pr, pi=n.pi;
    for(const c of s.chunks){
      const xr=c.re, xi=iqChunkIm(c), K=xr.length, y=new Float32Array(K), gn=n.p.inv ? -1 : 1;
      for(let i=0;i<K;i++){
        const ci=xr[i], cq=xi[i];
        let v;
        if(fm){ v=gn*tvAtan2(cq*pr-ci*pi, ci*pr+cq*pi)*kf; pr=ci; pi=cq; }
        else v=sg*Math.sqrt(ci*ci+cq*cq);
        v=iqBq(z,0,q0,v); v=iqBq(z,4,q1,v);
        y[i]=v;
      }
      iqPush(o,y,null,c.tag);
    }
    n.pr=pr; n.pi=pi;
    n.ui={sr, bw};
    return {out:o};
  }};

/* ---- TV Decoder ---- */
IQK.tvDecode={
  init(n){ n.d=null; n.key=''; n.frame=null; n.imgT=0; n.img=null; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {img:n.img, lock:0, fps:0}; }
    const key=[s.sr,n.p.std,n.p.width,n.p.invert].join('|');
    if(key!==n.key) tvReset(n,s.sr,key);
    const d=n.d;
    for(const c of s.chunks){
      if(c.tag==='gap' || c.tag==='retune') tvSoft(d);
      const x=c.re;
      for(let o=0;o<x.length;o+=4096) tvFeed(n,x.subarray(o,Math.min(o+4096,x.length)));
    }
    if(d.ready && (typeof performance==='undefined' || performance.now()-n.imgT>40)){
      d.ready=false; n.imgT=typeof performance==='undefined' ? 0 : performance.now();
      const f=n.frame;
      n.img={w:f.w, h:f.h, data:new ImageData(new Uint8ClampedArray(f.px),f.w,f.h)};
    }
    n.ui={sr:s.sr, std:d.st===TVS.NTSC ? 'NTSC' : 'PAL', lock:d.lock, lines:d.fl, fps:d.fps, color:d.hasB, inv:d.pol<0,
      w:n.frame.w, h:n.frame.h, cOK:d.cOK, free:n.p.sync==='free'};
    return {img:n.img, lock:d.lock ? 1 : 0, fps:d.fps};
  }};

function tvAlloc(n,W){
  const st=n.d.st, H=2*st.rows;
  n.frame={w:W, h:H, px:new Uint8ClampedArray(W*H*4)};
  for(let i=3;i<n.frame.px.length;i+=4) n.frame.px[i]=255;
}
function tvSetStd(n,st){
  const d=n.d, W=+n.p.width;
  d.st=st; d.T=st.T*d.sr*1e-6; d.cOK=d.sr>=2.4*st.fsc;
  d.U=new Float32Array(W); d.V=new Float32Array(W); d.pU=new Float32Array(W); d.pV=new Float32Array(W); d.Y=new Float32Array(W);
  tvAlloc(n,W);
}
function tvReset(n,sr,key){
  n.key=key;
  const keep=Math.ceil(2.6*64e-6*sr), cap=keep+4096+64;
  n.d={sr, keep, cap, buf:new Float32Array(cap), base:0, len:0,
    lo:0, hi:0, low:false, px:0, tcF:0, tcR:0, fall:0, aA:1-Math.exp(-1/(.3e-6*sr)), aR:1-Math.exp(-1/(2e-3*sr)),
    pol:n.p.invert==='on' ? -1 : 1, unl:0, lock:false,
    tip:0, bl:0, sh:0, g:1, locked:false, good:0, lastHs:-1, lastP:0, vc:0, vs:false, lineNo:0, rowOK:false, par:0,
    ready:false, fl:0, fps:0, lastFld:0, cP:0, cN:0, hasB:false, fp:-1, fcnt:0, fm:undefined, fs:1, pvOK:false, psiOK:false, psi:0, pAng:0, pLine:-9, pF:0, miss:0,
    PS:new Float64Array(Math.ceil(68e-6*sr)+8), PC:new Float64Array(Math.ceil(68e-6*sr)+8),
    PX:new Float64Array(Math.ceil(68e-6*sr)+8), QS:new Float64Array(Math.ceil(68e-6*sr)+8), QC:new Float64Array(Math.ceil(68e-6*sr)+8),
    SA:new Float32Array(Math.ceil(68e-6*sr)+8), CA:new Float32Array(Math.ceil(68e-6*sr)+8)};
  tvSetStd(n,TVS[TV_STD[n.p.std]]);
}
// потеря потока: возвращаемся к поиску синхронизации, не трогая кадр
function tvSoft(d){ d.len=0; d.lastHs=-1; d.vc=0; d.vs=false; d.rowOK=false; d.good=0; d.locked=false; d.low=false; }

function tvFeed(n,x){
  const d=n.d, K=x.length;
  if(d.len+K>d.cap){ const k=Math.min(d.len,d.keep); d.buf.copyWithin(0,d.len-k,d.len); d.base+=d.len-k; d.len=k; }
  const b=d.buf, L0=d.len, pol=d.pol;
  for(let i=0;i<K;i++) b[L0+i]=pol*x[i];
  d.len+=K;
  if(n.p.sync==='free'){ tvFree(n); return; }
  if(d.fp>=0) d.fp=-1;
  let low=d.low, lo=d.lo, hi=d.hi, px=d.px, tcF=d.tcF, tcR=d.tcR;
  const aA=d.aA, aR=d.aR, a0=d.base+L0;
  let thr, hy;
  if(d.locked){ thr=(d.tip+d.bl)*.5; hy=(d.bl-d.tip)*.2; } else { thr=lo+.2*(hi-lo); hy=.05*(hi-lo); }
  for(let i=0;i<K;i++){
    const v=b[L0+i];
    lo+=(v-lo)*(v<lo ? aA : aR); hi+=(v-hi)*(v>hi ? aA : aR);
    if(px>=thr && v<thr) tcF=a0+i-1+(px-thr)/(px-v);
    else if(px<thr && v>=thr) tcR=a0+i-1+(thr-px)/(v-px);
    if(!low){ if(v<thr-hy){ low=true; d.fall=tcF; } }
    else if(v>thr+hy){ low=false; d.lo=lo; d.hi=hi; tvPulse(n,d.fall,tcR); }
    px=v;
  }
  d.low=low; d.lo=lo; d.hi=hi; d.px=px; d.tcF=tcF; d.tcR=tcR;
  // нет синхронизации — пробуем другую полярность
  d.lock=d.good>=8 && d.lastFld>0 && d.base+d.len-d.lastFld<.12*d.sr;       // строки идут и кадровые синхроимпульсы приходят
  if(d.lock) d.unl=0; else d.unl+=K;
  if(n.p.invert==='auto' && d.unl>.5*d.sr){
    d.pol=-d.pol; d.unl=0; d.len=0; d.lastHs=-1; d.lastFld=0; d.locked=false; d.good=0; d.sh=0; d.low=false;
    const t=d.lo; d.lo=-d.hi; d.hi=-t;
  }
}

// Свободный растр: без синхроимпульсов, строки идут с номинальным периодом (+ подстройка trim, ppm), яркость — по статистике
// строки. Для слабого сигнала и малой полосы: видно хотя бы намёки; когда trim совпал с частотой строк, картинка встаёт.
function tvFree(n){
  const d=n.d, st=d.st, us=d.sr*1e-6, end=d.base+d.len, need=68*us;
  d.lock=false; d.good=0; d.locked=false; d.lastHs=-1; d.vs=false; d.low=false; d.unl=0;
  const Tl=st.T*us*(1+(+n.p.trim||0)*1e-6);
  if(d.fp<d.base) d.fp=Math.max(d.base,end-4096);
  while(d.fp+need<=end){
    tvLineFree(n,d.fp,d.fcnt);
    d.fp+=Tl;
    if(++d.fcnt>=2*st.fld){ d.fcnt=0; d.ready=true; }
  }
}
function tvLineFree(n,f0,cnt){
  const d=n.d, st=d.st, us=d.sr*1e-6, buf=d.buf, i0=Math.floor(f0)-d.base, W=n.frame.w, Y=d.Y;
  const y=cnt-2*st.vb-(+n.p.vshift||0);
  if(y<0 || y>=n.frame.h || i0<0) return;
  const hs=+n.p.hshift||0, act0=st.a0+hs, dtp=(st.a1-st.a0)/W, stepS=dtp*us;
  let sp=f0+act0*us+.5*stepS-(d.base+i0), s1=0, s2=0;
  for(let p=0;p<W;p++,sp+=stepS){
    const ip=Math.floor(sp), f=sp-ip, v=buf[i0+ip]*(1-f)+buf[i0+ip+1]*f;
    Y[p]=v; s1+=v; s2+=v*v;
  }
  const m=s1/W, sd=Math.sqrt(Math.max(s2/W-m*m,1e-12));
  if(d.fm===undefined){ d.fm=m; d.fs=sd; } else { d.fm+=(m-d.fm)*.02; d.fs+=(sd-d.fs)*.02; }
  const ct=+n.p.contrast||1, k=ct*255/(5*d.fs), b=(.5+(+n.p.bright||0))*255-d.fm*k, px=n.frame.px;
  let o=y*W*4;
  for(let p=0;p<W;p++,o+=4) px[o]=px[o+1]=px[o+2]=Y[p]*k+b;
}

function tvPulse(n,f,r){
  const d=n.d, w=(r-f)*1e6/d.sr, T=d.T;
  if(w<1.2) return;
  if(w>=20 || w<3.4){                                       // кадровый синхроимпульс или уравнивающий
    const dt=f-d.lastP; d.lastP=f;
    d.vc=dt<.6*T ? d.vc+1 : 1;
    if(d.vc>=4 && !d.vs){ d.vs=true; tvEndField(n); }
    return;
  }
  if(w>8) return;
  d.lastP=f; d.vc=0;
  if(d.vs){ d.vs=false; d.lineNo=0; d.rowOK=true; d.pvOK=false; d.lastHs=f; return; }
  if(d.lastHs<0){ d.lastHs=f; return; }
  const dt=f-d.lastHs, k=Math.round(dt/T);
  if(k>=1 && k<=3 && Math.abs(dt-k*T)<.06*T*k){
    if(k===1) d.T+=.03*(dt-T);
    d.T=Math.min(Math.max(d.T,d.st.T*d.sr*1e-6*.97),d.st.T*d.sr*1e-6*1.03);
    for(let m=0;m<k;m++){ tvLine(n,d.lastHs+m*dt/k,d.lineNo); d.lineNo++; }
    d.good=Math.min(d.good+1,20);
    d.lastHs=f;
  } else if(dt<.6*T) return;                                 // помеха внутри строки
  else {
    d.good=Math.max(0,d.good-4);
    if(dt>3.5*T) d.rowOK=false;
    d.lastHs=f;
  }
  d.locked=d.good>=8;
}

// конец поля: число строк → PAL / NTSC; при полном кадре (два поля) — готовая картинка
function tvEndField(n){
  const d=n.d, a=d.lastP;
  d.fl=d.lineNo; d.rowOK=false;
  if(d.lastFld){ const fps=d.sr/(a-d.lastFld); if(fps>20 && fps<100) d.fps=d.fps ? d.fps+(fps-d.fps)*.2 : fps; }
  d.lastFld=a;
  if(n.p.std==='auto' && d.fl>240){
    const ntsc=d.fl<280 ? 1 : 0, pal=d.fl>=295 && d.fl<=325 ? 1 : 0;
    d.cN=ntsc ? d.cN+1 : 0; d.cP=pal ? d.cP+1 : 0;
    if(d.cN>=3 && d.st!==TVS.NTSC) tvSetStd(n,TVS.NTSC);
    else if(d.cP>=3 && d.st!==TVS.PAL) tvSetStd(n,TVS.PAL);
  }
  d.par^=1;
  if(d.par===0 || n.p.interlace==='bob') d.ready=true;
}

// Цвет: s = sin, c = cos опорной фазы (непрерывной по абсолютному номеру отсчёта). Амплитуды поднесущей S, C — в окне
// N ≈ 2 периода, из префиксных сумм x·s, x·c, x, s, c: 2·Σ(x−mean)·ref / N (постоянная составляющая не просачивается
// при нецелом числе отсчётов на период). Считаются по отсчётам, на пиксели — линейная интерполяция.
function tvLine(n,f0,lineNo){
  const d=n.d, st=d.st, sr=d.sr, us=sr*1e-6, buf=d.buf, base=d.base, len=d.len;
  const i0=Math.floor(f0)-base, Ln=Math.ceil(67.5*us)+4;
  if(i0<0 || i0+Ln+2>len) return;
  const avg=(t0,t1)=>{ const j0=Math.ceil(f0+t0*us)-base, j1=Math.floor(f0+t1*us)-base; let s=0;
    for(let j=j0;j<=j1;j++) s+=buf[j]; return s/(j1-j0+1); };
  const tip=avg(1,3.6), bl=avg(8.2,10);
  if(!(bl-tip>1e-6)) return;
  if(d.sh===0){ d.sh=bl-tip; d.tip=tip; d.bl=bl; }
  else { d.sh+=(bl-tip-d.sh)*.1; d.tip+=(tip-d.tip)*.2; d.bl+=(bl-d.bl)*.3; }
  const row=lineNo-st.vb-(+n.p.vshift||0);
  if(!d.rowOK || row<0 || row>=st.rows) return;
  const unit=d.sh/st.sync, W=n.frame.w, fr=n.frame, par=d.par, pal=st===TVS.PAL, bob=n.p.interlace==='bob';
  const hs=+n.p.hshift||0, act0=st.a0+hs, act1=st.a1+hs, dtp=(act1-act0)/W, stepS=dtp*us;
  const sp0=f0+act0*us+.5*stepS-(base+i0);                   // положение центра первого пикселя, в отсчётах от i0
  const Lc=sr/st.fsc, N=Math.max(2,Math.round(2*Lc)), wa=(N-1)>>1, wb=N-1-wa, off=(wb-wa)/2;
  const PS=d.PS, PC=d.PC, PX=d.PX, QS=d.QS, QC=d.QC, SA=d.SA, CA=d.CA;
  const phs=2*Math.PI*st.fsc/sr, t0=i0+base;                // опора — фаза по абсолютному номеру отсчёта
  let hasB=false, psi=0, sw=1;
  if(d.cOK){
    const a0=(phs*t0)%(2*Math.PI), cs=Math.cos(phs), sn=Math.sin(phs);
    let c=Math.cos(a0), s=Math.sin(a0);
    PS[0]=PC[0]=PX[0]=QS[0]=QC[0]=0;
    for(let j=0;j<Ln;j++){
      const v=buf[i0+j]-bl;
      PS[j+1]=PS[j]+v*s; PC[j+1]=PC[j]+v*c; PX[j+1]=PX[j]+v; QS[j+1]=QS[j]+s; QC[j+1]=QC[j]+c;
      const t=c*cs-s*sn; s=s*cs+c*sn; c=t;
    }
    // вспышка: целое число отсчётов, ближайшее к st.bcyc периодам
    const nb=Math.max(2,Math.round(st.bcyc*Lc)), jb=Math.round(f0+st.bc0*us-t0), jb2=jb+nb;
    const mb=(PX[jb2]-PX[jb])/nb;
    const bs=2*(PS[jb2]-PS[jb]-mb*(QS[jb2]-QS[jb]))/nb, bc=2*(PC[jb2]-PC[jb]-mb*(QC[jb2]-QC[jb]))/nb;
    const bm=Math.hypot(bs,bc)/unit;
    hasB=bm>.5*st.bmag && bm<3*st.bmag;
    if(hasB){
      const ang=Math.atan2(bc,bs), wrap=a=>{ a%=2*Math.PI; return a>Math.PI ? a-2*Math.PI : a<-Math.PI ? a+2*Math.PI : a; };
      if(pal){
        // вспышка качается ±45° от строки к строке: знак коммутации V — по ближайшей к прогнозу фазе;
        // прогноз берётся из пары соседних строк (разность углов ±90°)
        const p1=wrap(ang-.75*Math.PI), p2=wrap(ang-1.25*Math.PI);
        if(!d.psiOK && d.pLine===lineNo-1 && d.pF===par){
          const dA=wrap(ang-d.pAng);
          if(Math.abs(Math.abs(dA)-Math.PI/2)<.6){ d.psi=wrap(d.pAng-(dA>0 ? .75 : 1.25)*Math.PI); d.psiOK=true; d.miss=0; }
        }
        d.pAng=ang; d.pLine=lineNo; d.pF=par;
        if(d.psiOK){
          const e1=Math.abs(wrap(p1-d.psi)), e2=Math.abs(wrap(p2-d.psi));
          if(e1<=e2){ sw=1; psi=p1; } else { sw=-1; psi=p2; }
          if(Math.min(e1,e2)>1){ if(++d.miss>10) d.psiOK=false; } else d.miss=0;
          d.psi+=.3*wrap(psi-d.psi);
        } else hasB=false;                                   // пока чередование не установлено — без цвета
      } else psi=wrap(ang-Math.PI);
      if(hasB){ d.g+=(Math.min(Math.max(st.bmag/bm,.6),1.7)-d.g)*.05; }
    }
    if(hasB){
      const jl=Math.max(wa,Math.floor(sp0-off)-1), jh=Math.min(Ln-1-wb,Math.ceil(sp0+W*stepS-off)+1);
      for(let j=jl;j<=jh;j++){
        const lo=j-wa, hi=j+wb+1, m=(PX[hi]-PX[lo])/N;
        SA[j]=2*(PS[hi]-PS[lo]-m*(QS[hi]-QS[lo]))/N; CA[j]=2*(PC[hi]-PC[lo]-m*(QC[hi]-QC[lo]))/N;
      }
    }
  }
  d.hasB=hasB;
  const color=hasB && n.p.color!==false, cp=Math.cos(psi), sq=Math.sin(psi), g=d.g/unit;
  const U=d.U, V=d.V, Y=d.Y;
  const dph=2*Math.PI*st.fsc*dtp*1e-6, cs2=Math.cos(dph), sn2=Math.sin(dph);
  const ph0=(phs*(t0+sp0))%(2*Math.PI);
  let c=Math.cos(ph0), s=Math.sin(ph0), sp=sp0;
  const ky=1/(unit*st.span);
  for(let p=0;p<W;p++,sp+=stepS){
    const ip=Math.floor(sp), f=sp-ip;
    let yv=buf[i0+ip]*(1-f)+buf[i0+ip+1]*f-bl;
    if(hasB){
      const q=sp-off, iq=Math.floor(q), fq=q-iq;
      const S=SA[iq]+(SA[iq+1]-SA[iq])*fq, C=CA[iq]+(CA[iq+1]-CA[iq])*fq;
      const am=(S*S+C*C)*g*g, k=am/(am+1.6e-3);              // слабая «цветность» — утечка яркости, а не цвет
      yv-=k*(S*s+C*c);
      U[p]=k*(S*cp+C*sq)*g; V[p]=k*sw*(C*cp-S*sq)*g;
    }
    Y[p]=yv*ky;
    const t=c*cs2-s*sn2; s=s*cs2+c*sn2; c=t;
  }
  // PAL: среднее с предыдущей строкой поля гасит ошибки фазы
  if(hasB && pal && d.pvOK) for(let p=0;p<W;p++){ const u=U[p], v=V[p]; U[p]=.5*(u+d.pU[p]); V[p]=.5*(v+d.pV[p]); d.pU[p]=u; d.pV[p]=v; }
  else if(hasB){ d.pU.set(U); d.pV.set(V); }
  d.pvOK=hasB;
  const ct=+n.p.contrast||1, br=+n.p.bright||0, px=fr.px, kU=1/(st.span*.493), kV=1/(st.span*.877), k5=ct*255, b5=(.5-.5*ct+br)*255;
  for(let r=0;r<(bob ? 2 : 1);r++){
    let o=((bob ? 2*row+r : 2*row+par)*W)*4;
    for(let p=0;p<W;p++,o+=4){
      const yy=Y[p];
      if(color){
        const dv=V[p]*kV, du=U[p]*kU;
        px[o]=(yy+dv)*k5+b5; px[o+2]=(yy+du)*k5+b5;
        px[o+1]=(yy-(.299*dv+.114*du)/.587)*k5+b5;
      } else px[o]=px[o+1]=px[o+2]=yy*k5+b5;
    }
  }
}
