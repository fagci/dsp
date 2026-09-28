"use strict";
/* ============================ IQ: блоки на потоке 'iq' ============================ */
// Поток со своей частотой (см. iqStream в core-engine.js): приёмник собирается проводами —
// источник → сдвиг → децимация → демодулятор → IQ → Audio (мост в домен Eng.sr).
// Пока всё считается в главном потоке.

const IQ_SR_OPTS=['48000','96000','192000','240000','250000','256000','1024000','2048000','2400000'];

// комплексный или вещественный чанк → (re, im) по индексу; im=null — нули
function iqChunkIm(c){ return c.im || (c._z || (c._z=new Float32Array(c.re.length))); }

/* ---- IQ Generator ---- */
// Тестовый сигнал на заданном смещении от fc + шум. Тактируется движком: sr·BLOCK/Eng.sr отсчётов за такт.
def({ id:'iqGen', title:'IQ Generator', cat:'IQ',
  ins:[{n:'fc',t:'num'},{n:'off',t:'num'}], outs:[{n:'iq',t:'iq'}],
  readout:true,
  params:[{n:'sr',t:'select',opts:IQ_SR_OPTS,d:'1024000',label:'sample rate'},
          {n:'fc',t:'num',d:100000000,label:'center frequency, Hz'},
          {n:'mode',t:'select',opts:['carrier','AM','FM','USB','LSB','off'],d:'FM'},
          {n:'off',t:'num',d:100000,label:'signal offset from center, Hz'},
          {n:'lvl',t:'range',min:-100,max:0,step:1,d:-20,label:'signal level, dBFS'},
          {n:'tone',t:'range',min:50,max:10000,step:1,d:1000,log:true,label:'modulating tone, Hz'},
          {n:'dev',t:'range',min:100,max:100000,step:100,d:5000,log:true,label:'FM deviation, Hz'},
          {n:'depth',t:'range',min:0,max:1,step:.01,d:.5,label:'AM depth'},
          {n:'noise',t:'range',min:-120,max:0,step:1,d:-60,label:'noise, dBFS'},
          {n:'ppm',t:'range',min:-1000,max:1000,step:1,d:0,label:'clock error vs sound card, ppm',adv:true}],
  init:n=>{ n.acc=0; n.ph=0; n.mph=0; n.rng=0x9e3779b9; },
  process(n,I){
    const sr=+n.p.sr, fc=pv(n,I,'fc'), s=iqStream(n,'iq',sr,fc);
    n.acc+=sr*BLOCK/Eng.sr*(1+(n.p.ppm||0)*1e-6);
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
  },
  draw(n){ const r=n.el.querySelector('.readout');
    if(r) r.textContent=(+n.p.sr/1000)+' kS/s · '+n.p.mode+' @ '+((n.p.fc+n.p.off)/1e6).toFixed(4)+' MHz'; }});

/* ---- IQ Frequency Shift ---- */
// Переносит частоту freq (абсолютную) или fc+offset в 0 Гц: z·e^(−jωt). fc выхода = эта частота.
def({ id:'iqShift', title:'IQ Frequency Shift', cat:'IQ',
  ins:[{n:'in',t:'iq'},{n:'freq',t:'num'}], outs:[{n:'out',t:'iq'},{n:'offset',t:'num'}],
  readout:true,
  params:[{n:'offset',t:'num',d:0,label:'offset from input center, Hz'}],
  init:n=>{ n.cr=1; n.ci=0; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s) return {out:null};
    let off=n.p.offset;
    if(typeof I.freq==='number' && isFinite(I.freq)) off=I.freq-s.fc;
    n.curOff=off; n.curSr=s.sr;
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
  },
  draw(n){ const r=n.el.querySelector('.readout');
    if(r) r.textContent=n.curOff==null ? 'no input' : 'shift '+(-n.curOff/1000).toFixed(3)+' kHz'; }});

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
def({ id:'iqDecim', title:'IQ Decimator', cat:'IQ',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'iq'},{n:'sr',t:'num'}],
  readout:true,
  params:[{n:'M',t:'select',opts:['2','3','4','5','8','10','16','20','25','32','40','50','64'],d:'4',label:'decimation'},
          {n:'cut',t:'range',min:.1,max:.5,step:.01,d:.4,label:'cutoff, × output rate'},
          {n:'tpp',t:'select',opts:['8','16','32'],d:'16',label:'taps per output',adv:true}],
  init:n=>{ n.key=''; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s) return {out:null, sr:null};
    const M=+n.p.M, cplx=s.chunks.length ? !!s.chunks[0].im : n.cplx!==false;
    const key=M+'|'+n.p.cut+'|'+n.p.tpp+'|'+s.sr+'|'+cplx;
    if(key!==n.key){
      n.key=key; n.cplx=cplx; n.h=iqDecimTaps(M,+n.p.tpp,n.p.cut);
      const L=n.h.length;
      n.hr=new Float32Array(L-1); n.hi=new Float32Array(L-1); n.ph=0;   // история: последние L−1 входных
    }
    const h=n.h, L=h.length, H=L-1, srOut=s.sr/M;
    const o=iqStream(n,'out',srOut,s.fc);
    n.srOut=srOut; n.srIn=s.sr;
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
  },
  draw(n){ const r=n.el.querySelector('.readout');
    if(r) r.textContent=n.srOut ? (n.srIn/1000)+' → '+(n.srOut/1000)+' kS/s' : 'no input'; }});

/* ---- IQ Demodulator ---- */
// FM: приращение фазы; AM: огибающая, нормированная на среднее (глубина модуляции);
// USB/LSB: Weaver — сдвиг на ∓bw/2, ФНЧ bw/2 (Баттерворт 8-го порядка), обратный сдвиг, Re.
// Выход — вещественный поток на частоте входа.
def({ id:'iqDemod', title:'IQ Demodulator', cat:'IQ',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'iq'}],
  readout:true,
  params:[{n:'mode',t:'select',opts:['FM','AM','USB','LSB'],d:'FM'},
          {n:'dev',t:'range',min:500,max:100000,step:100,d:5000,log:true,label:'FM deviation, Hz'},
          {n:'deemph',t:'select',opts:['off','50 µs','75 µs'],d:'off',label:'FM de-emphasis'},
          {n:'bw',t:'range',min:500,max:5000,step:50,d:2700,label:'SSB bandwidth, Hz'},
          {n:'gain',t:'range',min:-20,max:40,step:1,d:0,label:'gain, dB'}],
  init:n=>{ n.key=''; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s) return {out:null};
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
    n.sr=sr;
    return {out:o};
  },
  draw(n){ const r=n.el.querySelector('.readout');
    if(r) r.textContent=n.sr ? n.p.mode+' at '+(n.sr/1000)+' kS/s' : 'no input'; }});

/* ---- IQ → Audio ---- */
// Мост в домен движка: кольцо + дробный ресемплер (кубический Эрмит) с частоты потока на Eng.sr.
// Часы источника (донгл, файл) и звуковой карты расходятся — шаг чтения подстраивается по
// запасу в кольце в пределах ±IQA_MAX_PPM. Недобор — тишина до восстановления запаса,
// перебор больше 3× — сброс до цели. Прореживать до ~звуковой частоты нужно до моста:
// сам он фильтра не имеет.
const IQA_MAX_PPM=2000;
def({ id:'iqAudio', title:'IQ → Audio', cat:'IQ',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'sig'},{n:'q',t:'sig'},{n:'fill',t:'num'}],
  readout:true,
  params:[{n:'lat',t:'range',min:20,max:500,step:5,d:100,label:'buffer, ms'},
          {n:'gain',t:'range',min:-40,max:20,step:1,d:0,label:'gain, dB'}],
  init:n=>{ n.sr=0; },
  process(n,I){
    const out=buf(n,'out'), oq=buf(n,'q');
    const s=iqIn(I,'in');
    if(!s || !s.sr){ out.fill(0); oq.fill(0); n.state='no input'; return {out, q:oq, fill:null}; }
    if(s.sr!==n.sr){                             // новая частота — новое кольцо (2 с)
      n.sr=s.sr; n.size=pow2ge(Math.max(s.sr*2, BLOCK*8));
      n.rr=new Float32Array(n.size); n.ri=new Float32Array(n.size);
      n.W=0; n.pos=0; n.rebuf=true; n.avg=0; n.ppm=0; n.drops=0; n.starves=0;
    }
    const mask=n.size-1, rr=n.rr, ri=n.ri;
    for(const c of s.chunks){
      const xr=c.re, xi=c.im, K=xr.length;
      let w=n.W;
      for(let i=0;i<K;i++,w++){ rr[w&mask]=xr[i]; ri[w&mask]=xi?xi[i]:0; }
      n.W=w;
    }
    const ratio=s.sr/Eng.sr, target=Math.max(s.sr*n.p.lat/1000, ratio*BLOCK*2);
    let fill=n.W-n.pos;
    if(fill>Math.min(target*3, n.size-ratio*BLOCK*2)){ n.pos=n.W-target; fill=target; n.avg=target; n.drops++; }
    const g=Math.pow(10,n.p.gain/20);
    if(n.rebuf){
      if(fill>=target){ n.rebuf=false; n.pos=n.W-target; fill=target; n.avg=target; }   // излишек пришедшего чанка — сразу в сброс
      else { out.fill(0); oq.fill(0); n.state='buffering'; return {out, q:oq, fill:1000*fill/s.sr}; }
    }
    n.avg+=0.02*(fill-n.avg);
    n.ppm=clamp(2e4*(n.avg-target)/target, -IQA_MAX_PPM, IQA_MAX_PPM);   // П-регулятор: +10% запаса → +2000 ppm
    const step=ratio*(1+n.ppm*1e-6);
    if(fill<step*BLOCK+3){ n.rebuf=true; n.starves++; out.fill(0); oq.fill(0); n.state='starved'; return {out, q:oq, fill:1000*fill/s.sr}; }
    let pos=n.pos;
    for(let i=0;i<BLOCK;i++,pos+=step){
      const k=Math.floor(pos), t=pos-k;
      const i0=(k-1)&mask, i1=k&mask, i2=(k+1)&mask, i3=(k+2)&mask;
      out[i]=g*herm(rr[i0],rr[i1],rr[i2],rr[i3],t);
      oq[i]=g*herm(ri[i0],ri[i1],ri[i2],ri[i3],t);
    }
    n.pos=pos;
    n.state=(s.sr/1000)+' → '+(Eng.sr/1000)+' kS/s · '+(1000*fill/s.sr).toFixed(0)+' ms · '+
      (n.ppm>=0?'+':'')+n.ppm.toFixed(0)+' ppm'+(s.sr>1.5*Eng.sr ? ' · decimate first!' : '');
    return {out, q:oq, fill:1000*fill/s.sr};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.state||''; }});
function herm(y0,y1,y2,y3,t){
  const c1=0.5*(y2-y0), c2=y0-2.5*y1+2*y2-0.5*y3, c3=0.5*(y3-y0)+1.5*(y1-y2);
  return ((c3*t+c2)*t+c1)*t+y1;
}

/* ---- IQ Spectrum ---- */
// Спектр потока по Уэлчу: кадры N с перекрытием 50%, среднее мощности до avg кадров за обновление.
// Комплексный поток — N бинов по центру fc (freqs абсолютные, как у USB SDR); вещественный — 0..sr/2.
// 0 дБ — тон полной шкалы.
def({ id:'iqSpec', title:'IQ Spectrum', cat:'IQ',
  ins:[{n:'in',t:'iq'}], outs:[{n:'spec',t:'spec'}],
  params:[{n:'size',t:'select',opts:['512','1024','2048','4096','8192','16384','32768','65536'],d:'4096'},
          {n:'win',t:'select',opts:['hann','hamming','blackman','rect'],d:'hann'},
          {n:'avg',t:'select',opts:['1','4','16','64'],d:'16',label:'max frames averaged'},
          {n:'upd',t:'range',min:20,max:1000,step:10,d:60,label:'update, ms of signal'}],
  init:n=>{ n.key=''; },
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
  }});
