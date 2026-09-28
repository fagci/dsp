"use strict";
/* ============================ IQ: ядра блоков ============================
   Чистый DSP без DOM и без движка: этот же файл грузит воркер острова (iq-worker.js).
   Ядро: init(st) и process(st, I, ctx) → выходы. st — состояние узла (с st.p — параметры),
   ctx = {block, sr} — размер блока и частота движка. Для отображения ядро кладёт
   данные в st.ui — из воркера они приезжают вместе с результатами. */
const IQK={};

// вещественный чанк → нулевая мнимая часть
function iqChunkIm(c){ return c.im || (c._z || (c._z=new Float32Array(c.re.length))); }

/* ---- IQ Generator ---- */
// Тестовый сигнал на смещении от fc + шум. Тактируется движком: sr·block/ctx.sr отсчётов за такт.
IQK.iqGen={
  init(n){ n.acc=0; n.ph=0; n.mph=0; n.rng=0x9e3779b9; },
  process(n,I,ctx){
    const sr=+n.p.sr, fc=pv(n,I,'fc'), s=iqStream(n,'iq',sr,fc);
    n.acc+=sr*ctx.block/ctx.sr*(1+(n.p.ppm||0)*1e-6);
    const N=Math.floor(n.acc); n.acc-=N;
    if(N<=0) return {iq:s};
    const re=new Float32Array(N), im=new Float32Array(N);
    const a=Math.pow(10,n.p.lvl/20), nz=Math.pow(10,n.p.noise/20)/Math.SQRT2;
    const w=2*Math.PI*pv(n,I,'off')/sr, wm=2*Math.PI*n.p.tone/sr, mode=n.p.mode;
    const kf=2*Math.PI*n.p.dev/sr, depth=n.p.depth;
    let ph=n.ph, mph=n.mph, x=n.rng;
    const rnd=()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return (x>>>0)/4294967296; };
    for(let i=0;i<N;i++){
      const m=Math.sin(mph); mph+=wm;
      let amp=a, p=ph;
      if(mode==='AM') amp=a*(1+depth*m)/(1+depth);
      else if(mode==='FM') ph+=kf*m;
      else if(mode==='USB') p=ph+mph;
      else if(mode==='LSB') p=ph-mph;
      else if(mode==='off') amp=0;
      ph+=w;
      re[i]=amp*Math.cos(p); im[i]=amp*Math.sin(p);
      if(nz>0){   // Бокс–Мюллер
        const u=Math.max(rnd(),1e-12), v=rnd(), r=nz*Math.sqrt(-2*Math.log(u));
        re[i]+=r*Math.cos(2*Math.PI*v); im[i]+=r*Math.sin(2*Math.PI*v);
      }
    }
    n.ph=ph%(2*Math.PI); n.mph=mph%(2*Math.PI); n.rng=x;
    iqPush(s,re,im);
    return {iq:s};
  }};

/* ---- IQ Frequency Shift ---- */
// Переносит частоту freq (абсолютную) или fc+offset в 0 Гц: z·e^(−jωt). fc выхода = эта частота.
IQK.iqShift={
  init(n){ n.cr=1; n.ci=0; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {out:null}; }
    let off=n.p.offset;
    if(typeof I.freq==='number' && isFinite(I.freq)) off=I.freq-s.fc;
    n.ui={off};
    const o=iqStream(n,'out',s.sr,s.fc+off);
    const w=-2*Math.PI*off/s.sr, wr=Math.cos(w), wi=Math.sin(w);
    let cr=n.cr, ci=n.ci;
    for(const c of s.chunks){
      const xr=c.re, xi=c.im, L=xr.length, yr=new Float32Array(L), yi=new Float32Array(L);
      for(let i=0;i<L;i++){
        const a=xr[i], b=xi?xi[i]:0;
        yr[i]=a*cr-b*ci; yi[i]=a*ci+b*cr;
        const t=cr*wr-ci*wi; ci=cr*wi+ci*wr; cr=t;
        if((i&1023)===1023){ const g=1/Math.sqrt(cr*cr+ci*ci); cr*=g; ci*=g; }   // накопленная ошибка модуля
      }
      iqPush(o,yr,yi,c.tag);
    }
    const g=1/Math.sqrt(cr*cr+ci*ci); n.cr=cr*g; n.ci=ci*g;
    return {out:o, offset:off};
  }};

/* ---- IQ Decimator ---- */
// КИХ-ФНЧ (оконный sinc, Блэкман) + прореживание в M раз; считаются только выходные отсчёты.
// Срез — доля выходной частоты (0.4 → полоса ±0.4·sr/M для комплексного потока).
function iqDecimTaps(M,tpp,cut){
  const L=M*tpp+1, h=new Float32Array(L), fcN=cut/M, mid=(L-1)/2;
  let sum=0;
  for(let i=0;i<L;i++){
    const x=i-mid, sinc=x===0 ? 2*fcN : Math.sin(2*Math.PI*fcN*x)/(Math.PI*x);
    const w=0.42-0.5*Math.cos(2*Math.PI*i/(L-1))+0.08*Math.cos(4*Math.PI*i/(L-1));
    h[i]=sinc*w; sum+=h[i];
  }
  for(let i=0;i<L;i++) h[i]/=sum;
  return h;
}
IQK.iqDecim={
  init(n){ n.key=''; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {out:null, sr:null}; }
    const M=+n.p.M, cplx=s.chunks.length ? !!s.chunks[0].im : n.cplx!==false;
    const key=M+'|'+n.p.cut+'|'+n.p.tpp+'|'+s.sr+'|'+cplx;
    if(key!==n.key){
      n.key=key; n.cplx=cplx; n.h=iqDecimTaps(M,+n.p.tpp,n.p.cut);
      const L=n.h.length;
      n.hr=new Float32Array(L-1); n.hi=new Float32Array(L-1); n.ph=0;   // история: последние L−1 входных
    }
    const h=n.h, L=h.length, H=L-1, srOut=s.sr/M;
    const o=iqStream(n,'out',srOut,s.fc);
    n.ui={srIn:s.sr, srOut};
    for(const c of s.chunks){
      const xr=c.re, xi=c.im, K=xr.length;
      // окно = история + чанк; выход в позиции p (индекс последнего отсчёта окна фильтра)
      const br=new Float32Array(H+K); br.set(n.hr); br.set(xr,H);
      let bi=null;
      if(cplx){ bi=new Float32Array(H+K); bi.set(n.hi); if(xi) bi.set(xi,H); }
      const cnt=n.ph<K ? Math.floor((K-1-n.ph)/M)+1 : 0;
      const yr=new Float32Array(cnt), yi=cplx ? new Float32Array(cnt) : null;
      let p=n.ph;
      for(let k=0;k<cnt;k++,p+=M){
        let ar=0, ai=0; const b0=p;               // br[b0..b0+H] — окно, кончающееся входным p
        if(cplx) for(let j=0;j<L;j++){ const g=h[j]; ar+=g*br[b0+j]; ai+=g*bi[b0+j]; }
        else for(let j=0;j<L;j++) ar+=h[j]*br[b0+j];
        yr[k]=ar; if(cplx) yi[k]=ai;
      }
      n.ph=p-K;
      n.hr.set(br.subarray(K)); if(cplx) n.hi.set(bi.subarray(K));
      if(cnt) iqPush(o,yr,yi,c.tag);
    }
    return {out:o, sr:srOut};
  }};

/* ---- IQ Demodulator ---- */
// FM: приращение фазы; AM: огибающая, нормированная на среднее (глубина модуляции);
// USB/LSB: Weaver — сдвиг на ∓bw/2, ФНЧ bw/2 (Баттерворт 8-го порядка), обратный сдвиг, Re.
// Выход — вещественный поток на частоте входа.
IQK.iqDemod={
  init(n){ n.key=''; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {out:null}; }
    const sr=s.sr, mode=n.p.mode, g=Math.pow(10,n.p.gain/20);
    const key=mode+'|'+sr+'|'+n.p.bw+'|'+n.p.deemph;
    if(key!==n.key){
      n.key=key; n.pr=0; n.pi=0; n.de=0; n.avg=0; n.wr=1; n.wi=0;
      n.bq=[0.5097956,0.6013449,0.8999762,2.5629154].map(Q=>biquadCoef('lp',n.p.bw/2,Q,sr));
      n.z=new Float64Array(32);   // 2 канала × 4 каскада × (x1,x2,y1,y2)
    }
    const o=iqStream(n,'out',sr,0);
    const kf=sr/(2*Math.PI*n.p.dev);
    const tau=n.p.deemph==='50 µs' ? 50e-6 : n.p.deemph==='75 µs' ? 75e-6 : 0;
    const ade=tau ? 1-Math.exp(-1/(sr*tau)) : 1;
    const aAvg=1-Math.exp(-1/(sr*0.2));
    for(const c of s.chunks){
      const xr=c.re, xi=iqChunkIm(c), K=xr.length, y=new Float32Array(K);
      if(mode==='FM'){
        let pr=n.pr, pi=n.pi, de=n.de;
        for(let i=0;i<K;i++){
          const a=xr[i], b=xi[i];
          const d=Math.atan2(b*pr-a*pi, a*pr+b*pi);    // arg(z·conj(z_prev))
          pr=a; pi=b;
          de+=ade*(d*kf-de); y[i]=g*de;
        }
        n.pr=pr; n.pi=pi; n.de=de;
      } else if(mode==='AM'){
        let avg=n.avg;
        for(let i=0;i<K;i++){
          const m=Math.sqrt(xr[i]*xr[i]+xi[i]*xi[i]);
          avg+=aAvg*(m-avg);
          y[i]=avg>1e-12 ? g*(m/avg-1) : 0;
        }
        n.avg=avg;
      } else {
        const sgn=mode==='USB' ? -1 : 1, w=sgn*Math.PI*n.p.bw/sr, cw=Math.cos(w), sw=Math.sin(w);
        const z=n.z, bq=n.bq;
        let wr=n.wr, wi=n.wi;
        const lp=(x,o,q)=>{ const [b0,b1,b2,a1,a2]=q; const v=b0*x+b1*z[o]+b2*z[o+1]-a1*z[o+2]-a2*z[o+3];
          z[o+1]=z[o]; z[o]=x; z[o+3]=z[o+2]; z[o+2]=v; return v; };
        for(let i=0;i<K;i++){
          const a=xr[i]*wr-xi[i]*wi, b=xr[i]*wi+xi[i]*wr;             // сдвиг на ∓bw/2
          let fa=a, fb=b;
          for(let k=0;k<4;k++){ fa=lp(fa,4*k,bq[k]); fb=lp(fb,16+4*k,bq[k]); }
          y[i]=g*2*(fa*wr+fb*wi);                                       // Re{f·e^(±jωt)}: обратный сдвиг
          const t=wr*cw-wi*sw; wi=wr*sw+wi*cw; wr=t;
        }
        const m=1/Math.sqrt(wr*wr+wi*wi); n.wr=wr*m; n.wi=wi*m;
      }
      iqPush(o,y,null,c.tag);
    }
    n.ui={sr};
    return {out:o};
  }};

/* ---- IQ Spectrum ---- */
// Спектр потока по Уэлчу: кадры N с перекрытием 50%, среднее мощности до avg кадров за обновление.
// Комплексный поток — N бинов по центру fc (freqs абсолютные, как у USB SDR); вещественный — 0..sr/2.
// 0 дБ — тон полной шкалы.
IQK.iqSpec={
  init(n){ n.key=''; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s || !s.sr) return {spec:n.sp||null};
    const N=+n.p.size, A=+n.p.avg, cplx=s.chunks.length ? !!s.chunks[0].im : n.cplx!==false;
    const cap=N+(A-1)*(N>>1);
    const key=N+'|'+A+'|'+n.p.win+'|'+s.sr+'|'+cplx;
    if(key!==n.key){
      n.key=key; n.cplx=cplx; n.size=pow2ge(cap);
      n.rr=new Float32Array(n.size); n.ri=new Float32Array(n.size); n.W=0; n.last=0;
      n.w=window_(n.p.win,N); let sum=0; for(let i=0;i<N;i++) sum+=n.w[i]; n.wsum=sum;
      n.re=new Float32Array(N); n.im=new Float32Array(N); n.pw=new Float64Array(N);
      n.sp=null;
    }
    const mask=n.size-1;
    for(const c of s.chunks){
      const xr=c.re, xi=c.im, K=xr.length; let w=n.W;
      for(let i=0;i<K;i++,w++){ n.rr[w&mask]=xr[i]; n.ri[w&mask]=xi?xi[i]:0; }
      n.W=w;
    }
    if(n.W<N || n.W-n.last<s.sr*n.p.upd/1000) return {spec:n.sp};
    const fresh=Math.min(n.W-n.last, cap, n.W); n.last=n.W;
    const hop=N>>1, K=Math.max(1, Math.floor((Math.max(fresh,N)-N)/hop)+1);
    const re=n.re, im=n.im, pw=n.pw, w=n.w; pw.fill(0);
    for(let k=0;k<K;k++){
      const o=n.W-N-(K-1-k)*hop;
      for(let i=0;i<N;i++){ const j=(o+i)&mask; re[i]=n.rr[j]*w[i]; im[i]=n.ri[j]*w[i]; }
      fft(re,im);
      for(let i=0;i<N;i++) pw[i]+=re[i]*re[i]+im[i]*im[i];
    }
    const sc=1/(K*n.wsum*n.wsum), half=N>>1;
    let mag, freqs=null;
    if(cplx){
      mag=new Float32Array(N); freqs=new Float32Array(N);
      const bin=s.sr/N;
      for(let i=0;i<N;i++){ mag[i]=Math.sqrt(pw[(i+half)%N]*sc); freqs[i]=s.fc+(i-half)*bin; }
    } else {
      mag=new Float32Array(half);
      mag[0]=Math.sqrt(pw[0]*sc);
      for(let i=1;i<half;i++) mag[i]=2*Math.sqrt(pw[i]*sc);
    }
    // новый объект на каждый расчёт: потребитель может держать прошлый
    n.sp={mag, sr:s.sr, size:N, freqs, rev:(n.rev=(n.rev|0)+1)};
    return {spec:n.sp};
  }};
