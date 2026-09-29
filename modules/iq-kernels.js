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
    const kf=2*Math.PI*n.p.dev/sr, kw=2*Math.PI*75000/sr, depth=n.p.depth;
    let ph=n.ph, mph=n.mph, x=n.rng;
    const rnd=()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return (x>>>0)/4294967296; };
    const env=mode==='ADS-B' ? iqGenAdsb(n,sr,N) : null;
    const bb=mode==='LRPT' ? lrptGenerate(n,sr,N,n.p.lrpt||'OQPSK') : null;
    for(let i=0;i<N;i++){
      const m=Math.sin(mph); mph+=wm;
      let amp=a, p=ph;
      if(mode==='AM') amp=a*(1+depth*m)/(1+depth);
      else if(mode==='FM') ph+=kf*m;
      else if(mode==='WFM stereo') ph+=kw*iqGenMpx(n,m,sr);
      else if(mode==='USB') p=ph+mph;
      else if(mode==='LSB') p=ph-mph;
      else if(mode==='off') amp=0;
      else if(env) amp=a*env[i];
      ph+=w;
      if(bb){ const c=Math.cos(p), sn=Math.sin(p), br=bb[0][i], bi=bb[1][i];
        re[i]=a*(br*c-bi*sn); im[i]=a*(br*sn+bi*c); }
      else { re[i]=amp*Math.cos(p); im[i]=amp*Math.sin(p); }
      if(nz>0){   // Бокс–Мюллер
        const u=Math.max(rnd(),1e-12), v=rnd(), r=nz*Math.sqrt(-2*Math.log(u));
        re[i]+=r*Math.cos(2*Math.PI*v); im[i]+=r*Math.sin(2*Math.PI*v);
      }
    }
    n.ph=ph%(2*Math.PI); n.mph=mph%(2*Math.PI); n.rng=x;
    iqPush(s,re,im);
    return {iq:s};
  }};

// MPX стерео-ЧМ: тон только в левом канале (правый — тишина, для проверки разделения),
// пилот sin 19 кГц, L−R на sin 38 кГц, RDS на 57 кГц: группы 0A с названием станции (ps)
function iqGenMpx(n,m,sr){
  if(!n.mpx || n.mpx.sr!==sr || n.mpx.ps!==n.p.ps){
    const bits=[], ps=(String(n.p.ps||'')+'        ').slice(0,8);
    const crc=d=>{ let r=d<<10; for(let i=25;i>=10;i--) if(r&(1<<i)) r^=0x5B9<<(i-10); return r&0x3FF; };
    const block=(d,off)=>{ const w=(d<<10)|(crc(d)^off); for(let i=25;i>=0;i--) bits.push((w>>>i)&1); };
    for(let seg=0;seg<4;seg++){
      block(0x1234,RDS_OFF[0]); block((1<<3)|seg,RDS_OFF[1]); block(0xE0CD,RDS_OFF[2]);
      block((ps.charCodeAt(2*seg)<<8)|ps.charCodeAt(2*seg+1),RDS_OFF[3]);
    }
    n.mpx={sr, ps:n.p.ps, bits, t:0, bit:0, e:0, pil:0};
  }
  const x=n.mpx, spb=sr/1187.5;
  const pw=2*Math.PI*19000/sr; x.pil+=pw; if(x.pil>2*Math.PI) x.pil-=2*Math.PI;
  if(++x.t>=spb){ x.t-=spb; x.bit=(x.bit+1)%x.bits.length; x.e^=x.bits[x.bit]; }   // дифференциальное кодирование
  const sym=(x.t<spb/2 ? 1 : -1)*(x.e ? 1 : -1);                                    // бифазный символ
  const L=m, R=0;
  return 0.45*(L+R)+0.45*(L-R)*Math.sin(2*x.pil)+0.09*Math.sin(x.pil)+0.04*sym*Math.sin(3*x.pil);
}

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
// Вход — канал, уже отфильтрованный и прореженный (сдвиг → децимация). Выход 'out' — звук
// вещественным потоком, 'stereo' — комплексным: re — левый, im — правый (WFM, SAM ISB; иначе моно).
// FM: приращение фазы / девиация. WFM: 75 кГц, ФАПЧ по пилоту 19 кГц, L−R с 38 кГц, RDS с 57 кГц,
//   де-эмфазис; звук ФНЧ 15 кГц с прореживанием до ≥40 кС/с (вход — не ниже ~150 кС/с).
// AM: огибающая, с АРУ — глубина модуляции относительно несущей. SAM: ФАПЧ на несущую (широкая
//   на захват, узкая в захвате), когерентный детектор; боковая — обе, верхняя, нижняя или ISB.
// USB/LSB: Weaver — сдвиг на ∓bw/2, ФНЧ bw/2 (Баттерворт 8-го порядка), обратный сдвиг, Re; АРУ по пику.
const SAM_SB={both:0, USB:1, LSB:-1, ISB:2};
const RDS_OFF=[0x0FC,0x198,0x168,0x1B4], RDS_OFFC2=0x350;           // A B C D, C'
function rdsSyn(w){ let r=0; for(let i=25;i>=0;i--){ r=(r<<1)|((w>>>i)&1); if(r&0x400) r^=0x5B9; } return r&0x3FF; }
function rdsChar(c){ return c>=0x20 && c<0x7f ? String.fromCharCode(c) : c===0x0d ? '\r' : ' '; }
// приёмник RDS: отсчёты бейзбенда на fs → фаза BPSK → бифазный согласованный фильтр → такт →
// дифференциальное декодирование → блоки с синдромами → группы 0A/0B (PS) и 2A/2B (RT)
function rdsNew(fs){
  const H=Math.max(2,Math.round(fs/2375));
  return {Tb:fs/1187.5, H, Y:new Float32Array(2*H), Yi:0, n:0, M:new Float32Array(3), next:fs/1187.5,
    cII:0, cQQ:0, cIQ:0, prev:0, reg:0, sync:false, lastHit:-1, lastOff:-1, bitN:0,
    exp:0, blk:[0,0,0,0], ok:[false,false,false,false], err:[], pi:-1, pty:0,
    ps:new Array(8).fill(' '), rt:new Array(64).fill(' '), ab:-1};
}
function rdsGroup(r){
  const [a,b,c,d]=r.blk;
  if(r.ok[0]) r.pi=a;
  if(!r.ok[1]) return;
  const type=b>>>12, ver=(b>>>11)&1;
  r.pty=(b>>>5)&0x1f;
  if(type===0 && r.ok[3]){ const i=(b&3)*2; r.ps[i]=rdsChar(d>>>8); r.ps[i+1]=rdsChar(d&0xff); }
  else if(type===2){
    const ab=(b>>>4)&1;
    if(ab!==r.ab){ r.ab=ab; r.rt.fill(' '); }
    const addr=b&0xf;
    if(ver===0 && r.ok[2] && r.ok[3]){ const t=[c>>>8,c&0xff,d>>>8,d&0xff]; for(let k=0;k<4;k++) r.rt[addr*4+k]=rdsChar(t[k]); }
    else if(ver===1 && r.ok[3]){ r.rt[addr*2]=rdsChar(d>>>8); r.rt[addr*2+1]=rdsChar(d&0xff); }
  }
}
function rdsBit(r,bit){
  r.reg=((r.reg<<1)|bit)&0x3FFFFFF; r.bitN++;
  if(!r.sync){
    const sy=rdsSyn(r.reg);
    let off=RDS_OFF.indexOf(sy); if(off<0 && sy===RDS_OFFC2) off=2;
    if(off<0) return;
    if(r.lastHit>=0){                                // два блока подряд на своих местах — синхронизация
      const dist=r.bitN-r.lastHit, steps=((off-r.lastOff)+4)%4||4;
      if(dist===steps*26){ r.sync=true; r.exp=(off+1)%4; r.bitN=0; r.err=[];
        r.blk[off]=(r.reg>>>10)&0xffff; r.ok.fill(false); r.ok[off]=true; r.lastHit=-1; return; }
    }
    r.lastHit=r.bitN; r.lastOff=off; return;
  }
  if(r.bitN<26) return;
  r.bitN=0;
  const sy=rdsSyn(r.reg), ok=sy===RDS_OFF[r.exp] || (r.exp===2 && sy===RDS_OFFC2);
  r.blk[r.exp]=(r.reg>>>10)&0xffff; r.ok[r.exp]=ok;
  r.err.push(ok?0:1); if(r.err.length>50) r.err.shift();
  if(r.exp===3){ rdsGroup(r); r.ok.fill(false); }
  r.exp=(r.exp+1)%4;
  if(r.err.length>=10 && r.err.reduce((x,y)=>x+y,0)>r.err.length*0.4){ r.sync=false; r.lastHit=-1; }
}
function rdsSample(r,ri,rq){
  const a=0.002;
  r.cII+=(ri*ri-r.cII)*a; r.cQQ+=(rq*rq-r.cQQ)*a; r.cIQ+=(ri*rq-r.cIQ)*a;
  const th=0.5*Math.atan2(2*r.cIQ, r.cII-r.cQQ), y=ri*Math.cos(th)+rq*Math.sin(th), L=2*r.H;
  r.Y[r.Yi]=y; r.Yi=(r.Yi+1)%L;
  let m=0; for(let k=0;k<L;k++){ const v=r.Y[(r.Yi+k)%L]; m+=k<r.H ? v : -v; }   // первая половина бита минус вторая
  r.M[r.n%3]=m; r.n++;
  if(r.n<r.next+1) return;
  const mc=r.M[(r.n-2)%3], me=r.M[(r.n-3+3)%3], ml=r.M[(r.n-1)%3];
  const err=(Math.abs(ml)-Math.abs(me))/(Math.abs(mc)+1e-12);   // ранний/поздний — подстройка такта
  r.next+=r.Tb+Math.max(-0.5,Math.min(0.5,0.25*err));
  const bit=mc>0?1:0; rdsBit(r, bit^r.prev); r.prev=bit;
}
IQK.iqDemod={
  init(n){ n.key=''; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {out:null, stereo:null}; }
    const sr=s.sr, mode=n.p.mode, g=Math.pow(10,n.p.gain/20), agc=n.p.agc!==false;
    const key=[mode,sr,n.p.bw,n.p.deemph,n.p.samSb].join('|');
    if(key!==n.key) iqDemodSetup(n,sr,mode);
    const ar=n.ar, o=iqStream(n,'out',ar,0), os=iqStream(n,'stereo',ar,0);
    const kf=sr/(2*Math.PI*(mode==='WFM' ? 75000 : n.p.dev));
    for(const c of s.chunks){
      const xr=c.re, xi=iqChunkIm(c), K=xr.length;
      const maxOut=mode==='WFM' ? Math.ceil((K+n.wCnt)/n.wD)+1 : K;
      const yl=new Float32Array(maxOut), yr=new Float32Array(maxOut);
      let w=0;
      for(let i=0;i<K;i++){
        const ci=xr[i], cq=xi[i];
        let v, vr=null;
        if(mode==='FM' || mode==='WFM'){
          v=Math.atan2(cq*n.pr-ci*n.pi, ci*n.pr+cq*n.pi)*kf;      // arg(z·conj(z_prev))
          n.pr=ci; n.pi=cq;
          if(mode==='WFM'){
            const lr=iqWfmStep(n,v);                                 // L−R по ФАПЧ пилота; RDS
            n.bM[n.bPos]=v; n.bS[n.bPos]=lr; n.bM[n.bPos+n.hN]=v; n.bS[n.bPos+n.hN]=lr;
            if(++n.bPos===n.hN) n.bPos=0;
            if(--n.wCnt>0) continue;
            n.wCnt=n.wD;
            let m=0, sd=0; const h=n.hA, b=n.bPos;
            for(let t=0;t<n.hN;t++){ m+=h[t]*n.bM[b+t]; sd+=h[t]*n.bS[b+t]; }
            const want=(n.p.stereo!==false && n.plLock>0.3 && n.plAmp>0.01) ? 1 : 0;
            n.stG+=(want-n.stG)*0.002;                                // стерео — плавно и только в захвате
            sd*=n.stG;
            v=m+sd; vr=m-sd;
          }
        } else if(mode==='AM'){
          const env=Math.sqrt(ci*ci+cq*cq);
          n.avg+=n.aAvg*(env-n.avg);
          v=agc ? (n.avg>1e-12 ? env/n.avg-1 : 0) : (env-n.avg)*3;
        } else if(mode==='SAM'){
          [v,vr]=iqSamStep(n,ci,cq,agc);
        } else {                                                      // USB/LSB, Weaver
          const wr=n.wr, wi=n.wi, a=ci*wr-cq*wi, b=ci*wi+cq*wr;
          let fa=a, fb=b;
          for(let k=0;k<4;k++){ fa=iqBq(n.z,4*k,n.bq[k],fa); fb=iqBq(n.z,16+4*k,n.bq[k],fb); }
          v=2*(fa*wr+fb*wi);
          const t=wr*n.cw-wi*n.sw; n.wi=wr*n.sw+wi*n.cw; n.wr=t;
          if((i&1023)===1023){ const m=1/Math.hypot(n.wr,n.wi); n.wr*=m; n.wi*=m; }
        }
        // DC-блок, де-эмфазис, АРУ SSB
        n.dcL+=n.hp*(v-n.dcL); v-=n.dcL;
        if(vr!=null){ n.dcR+=n.hp*(vr-n.dcR); vr-=n.dcR; }
        if(n.de){ n.deL+=n.de*(v-n.deL); v=n.deL; if(vr!=null){ n.deR+=n.de*(vr-n.deR); vr=n.deR; } }
        if((mode==='USB' || mode==='LSB') && agc) v=iqAgcStep(n,v);
        yl[w]=g*v; yr[w]=g*(vr==null ? v : vr); w++;
      }
      if(mode!=='WFM' || w===yl.length){ iqPush(o,yl,null,c.tag); iqPush(os,yl,yr,c.tag); }
      else if(w){ const l=yl.slice(0,w); iqPush(o,l,null,c.tag); iqPush(os,l,yr.slice(0,w),c.tag); }
    }
    const res={out:o, stereo:os};
    if(mode==='WFM'){
      const r=n.rds, ps=r.ps.join('').trim(), rt=r.rt.join('').split('\r')[0].trim();
      res.ps=ps || null; res.rt=rt || null; res.pilot=n.plLock>0.3 && n.plAmp>0.01 ? 1 : 0;
      n.ui={sr, ar, stereo:n.stG>0.5, ps, rt, sync:r.sync, pi:r.pi};
    } else if(mode==='SAM'){ res.lock=n.samLock>0.6 ? 1 : 0; n.ui={sr, ar, lock:n.samLock>0.6, hz:n.samW*sr/(2*Math.PI)}; }
    else n.ui={sr, ar};
    return res;
  }};
function iqBq(z,o,q,x){ const v=q[0]*x+q[1]*z[o]+q[2]*z[o+1]-q[3]*z[o+2]-q[4]*z[o+3];
  z[o+1]=z[o]; z[o]=x; z[o+3]=z[o+2]; z[o+2]=v; return v; }
function iqDemodSetup(n,sr,mode){
  n.key=[mode,sr,n.p.bw,n.p.deemph,n.p.samSb].join('|');
  n.pr=0; n.pi=0; n.avg=0; n.aAvg=1-Math.exp(-1/(sr*0.2));
  n.ar=sr; n.dcL=0; n.dcR=0; n.deL=0; n.deR=0;
  if(mode==='WFM'){
    n.wD=Math.max(1,Math.floor(sr/40000)); n.ar=sr/n.wD; n.wCnt=n.wD;
    n.hA=kaiserLP(sr, 15000, Math.min(18500, n.ar/2), 1023); n.hN=n.hA.length;
    n.bM=new Float32Array(2*n.hN); n.bS=new Float32Array(2*n.hN); n.bPos=0;
    const w0=2*Math.PI*19000/sr, Q=12, al=Math.sin(w0)/(2*Q), a0=1+al;
    n.pb=[al/a0, -2*Math.cos(w0)/a0, (1-al)/a0]; n.pbX1=n.pbX2=n.pbY1=n.pbY2=0;
    n.plW0c=Math.cos(w0); n.plW0s=Math.sin(w0); n.plRe=1; n.plIm=0; n.plInt=0;
    const wn=2*Math.PI*15/sr; n.plKp=2*0.707*wn/0.5; n.plKi=wn*wn/0.5;   // полоса ФАПЧ ~15 Гц
    n.plAmp=0.05; n.plAmpA=Math.exp(-1/(0.05*sr)); n.plLock=0; n.plLockA=Math.exp(-1/(0.2*sr)); n.stG=0;
    const rD=Math.max(1,Math.round(sr/12000));
    n.rH=kaiserLP(sr, 2400, 4500, 1023); n.rN=n.rH.length; n.rD=rD; n.rCnt=rD;
    n.rI=new Float32Array(2*n.rN); n.rQ=new Float32Array(2*n.rN); n.rPos=0;
    n.rds=rdsNew(sr/rD);
  }
  if(mode==='SAM'){
    n.samSb=SAM_SB[n.p.samSb]||0;
    if(n.samSb) iqSidebandSetup(n,sr,Math.max(1000,n.p.bw/2));
    const kk=bn=>{ const wn=2*Math.PI*bn/0.53/sr; return [2*0.707*wn, wn*wn]; };
    [n.samKpW,n.samKiW]=kk(100); [n.samKpN,n.samKiN]=kk(20);         // ~100 Гц на захват, ~20 Гц в захвате
    n.samWmax=2*Math.PI*Math.min(5000,sr/4)/sr; n.samFA=Math.exp(-2*Math.PI*400/sr);
    n.samLockA=Math.exp(-1/(0.15*sr)); n.samCarA=Math.exp(-1/(0.5*sr));
    n.samPh=0; n.samW=0; n.samLock=0; n.samWide=true; n.samCar=0.01;
    n.samFi=n.samFq=n.samF2i=n.samF2q=0; n.samDc=0; n.samDcR=0; n.samDcA=1-Math.exp(-1/(0.2*sr));
  }
  if(mode==='USB' || mode==='LSB'){
    n.bq=[0.5097956,0.6013449,0.8999762,2.5629154].map(Q=>biquadCoef('lp',n.p.bw/2,Q,sr));
    n.z=new Float64Array(32);
    const w=(mode==='USB' ? -1 : 1)*Math.PI*n.p.bw/sr; n.cw=Math.cos(w); n.sw=Math.sin(w); n.wr=1; n.wi=0;
    n.agcPk=0.3/1000; n.agcHold=0; n.agcHoldN=Math.round(0.3*sr); n.agcRel=Math.exp(-1/(0.4*sr));
  }
  n.hp=1-Math.exp(-2*Math.PI*20/n.ar);                               // DC-блок 20 Гц
  const tau=mode==='WFM' || mode==='FM' ? {'50 µs':50e-6,'75 µs':75e-6}[n.p.deemph] : 0;
  n.de=tau ? 1-Math.exp(-1/(tau*n.ar)) : 0;
}
// шаг WFM на частоте входа: ФАПЧ по пилоту (биквад 19 кГц → нормировка → фазовый детектор → ПИ),
// L−R = MPX·2·sin2φ; RDS — MPX·e^(j3φ) → ФНЧ с прореживанием → приёмник RDS
function iqWfmStep(n,v){
  const [b0,a1,a2]=n.pb, pb=b0*v-b0*n.pbX2-a1*n.pbY1-a2*n.pbY2;
  n.pbX2=n.pbX1; n.pbX1=v; n.pbY2=n.pbY1; n.pbY1=pb;
  n.plAmp=n.plAmp*n.plAmpA+(pb<0?-pb:pb)*(1-n.plAmpA);
  const pn=pb/(n.plAmp*1.5708+1e-9), e=pn*n.plRe;
  n.plLock=n.plLock*n.plLockA+pn*n.plIm*(1-n.plLockA);
  const re=n.plRe, im=n.plIm, c2=re*re-im*im, s2=2*re*im, c3=c2*re-s2*im, s3=s2*re+c2*im;
  n.plInt+=n.plKi*e;
  const d=n.plKp*e+n.plInt;
  let nr=re*n.plW0c-im*n.plW0s, ni=re*n.plW0s+im*n.plW0c;
  const dr=1-d*d*0.5, tr=nr*dr-ni*d; ni=nr*d+ni*dr; nr=tr;
  const nn=1.5-0.5*(nr*nr+ni*ni); n.plRe=nr*nn; n.plIm=ni*nn;
  const ri=v*c3, rq=v*s3, N=n.rN;
  n.rI[n.rPos]=ri; n.rI[n.rPos+N]=ri; n.rQ[n.rPos]=rq; n.rQ[n.rPos+N]=rq;
  if(++n.rPos===N) n.rPos=0;
  if(--n.rCnt<=0){
    n.rCnt=n.rD;
    let si=0, sq=0; const h=n.rH, p=n.rPos;
    for(let t=0;t<N;t++){ si+=h[t]*n.rI[p+t]; sq+=h[t]*n.rQ[p+t]; }
    rdsSample(n.rds,si,sq);
  }
  return v*2*s2;
}
// комплексный полосовой одной боковой: ФНЧ half (переход 300 Гц у нуля), сдвинутый на +half
function iqSidebandSetup(n,sr,half){
  const lp=kaiserLP(sr, half-150, half+150, 2047), N=lp.length, M=(N-1)/2, f0=half/sr;
  n.sbN=N; n.sbHr=new Float32Array(N); n.sbHi=new Float32Array(N);
  for(let k=0;k<N;k++){ const t=M-k; n.sbHr[k]=lp[k]*Math.cos(2*Math.PI*f0*t); n.sbHi[k]=lp[k]*Math.sin(2*Math.PI*f0*t); }
  n.sbI=new Float32Array(2*N); n.sbQ=new Float32Array(2*N); n.sbPos=0;
}
// шаг SAM: перенос на несущую, ФАПЧ (детектор atan2 — от амплитуды не зависит), затем детектор
// одной/обеих боковых; АРУ — по несущей с τ 0.5 с. Возвращает [основной, правый для ISB]
function iqSamStep(n,ci,cq,agc){
  const pc=Math.cos(n.samPh), ps=Math.sin(n.samPh);
  const zi=ci*pc+cq*ps, zq=cq*pc-ci*ps, fa=n.samFA, fb=1-fa;
  n.samFi=n.samFi*fa+zi*fb; n.samFq=n.samFq*fa+zq*fb; n.samF2i=n.samF2i*fa+n.samFi*fb; n.samF2q=n.samF2q*fa+n.samFq*fb;
  const di=n.samWide ? n.samFi : n.samF2i, dq=n.samWide ? n.samFq : n.samF2q;
  const e=Math.atan2(dq,di), mag=Math.sqrt(di*di+dq*dq);
  n.samLock=n.samLock*n.samLockA+(mag>0 ? di/mag : 0)*(1-n.samLockA);
  if(n.samWide && n.samLock>0.7) n.samWide=false; else if(!n.samWide && n.samLock<0.4) n.samWide=true;
  n.samW+=(n.samWide ? n.samKiW : n.samKiN)*e;
  n.samW=Math.max(-n.samWmax, Math.min(n.samWmax, n.samW));
  n.samPh+=n.samW+(n.samWide ? n.samKpW : n.samKpN)*e;
  if(n.samPh>Math.PI) n.samPh-=2*Math.PI; else if(n.samPh<-Math.PI) n.samPh+=2*Math.PI;
  let x=zi, xr=null;
  if(n.samSb){
    const N=n.sbN; n.sbI[n.sbPos]=zi; n.sbI[n.sbPos+N]=zi; n.sbQ[n.sbPos]=zq; n.sbQ[n.sbPos+N]=zq;
    if(++n.sbPos===N) n.sbPos=0;
    let a=0, b=0; const p=n.sbPos;
    for(let t=0;t<N;t++){ a+=n.sbHr[t]*n.sbI[p+t]; b+=n.sbHi[t]*n.sbQ[p+t]; }
    x=n.samSb===-1 ? 2*(a+b) : 2*(a-b);                               // Re одной боковой ×2: верхняя a−b, нижняя a+b
    if(n.samSb===2) xr=2*(a+b);
  }
  n.samCar=n.samCar*n.samCarA+(zi>0 ? zi : 0)*(1-n.samCarA);
  n.samDc+=n.samDcA*(x-n.samDc);
  const k=agc ? 1/Math.max(n.samCar,1e-5) : 3;
  let v=(x-n.samDc)*k, vr=null;
  if(xr!=null){ n.samDcR+=n.samDcA*(xr-n.samDcR); vr=(xr-n.samDcR)*k; }
  return [v,vr];
}
// АРУ по пику: мгновенная атака, удержание 0.3 с, спад τ 0.4 с; усиление не больше 1000
function iqAgcStep(n,v){
  const a=v<0 ? -v : v;
  if(a>=n.agcPk){ n.agcPk=a; n.agcHold=n.agcHoldN; }
  else if(n.agcHold>0) n.agcHold--;
  else n.agcPk=Math.max(0.3/1000, n.agcPk*n.agcRel);
  return v*0.3/n.agcPk;
}

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

/* ---- IQ Add ---- */
// Сумма двух потоков одной частоты: отсчёты выравниваются по счёту (кто впереди — ждёт в очереди).
// fc выхода — от входа a; разные sr — ошибка в ui, на выход идёт только a.
IQK.iqAdd={
  init(n){ n.qa=[]; n.qb=[]; n.na=0; n.nb=0; },
  process(n,I){
    const a=iqIn(I,'a'), b=iqIn(I,'b');
    if(!a && !b){ n.ui=null; return {out:null}; }
    const s0=a||b, o=iqStream(n,'out',s0.sr,s0.fc);
    const ka=Math.pow(10,n.p.ka/20), kb=Math.pow(10,n.p.kb/20);
    if(!a || !b || a.sr!==b.sr){
      n.ui={err:a && b ? 'sample rates differ' : null, sr:s0.sr};
      const k=a ? ka : kb;
      for(const c of s0.chunks){ const L=c.re.length, im=iqChunkIm(c), yr=new Float32Array(L), yi=new Float32Array(L);
        for(let i=0;i<L;i++){ yr[i]=k*c.re[i]; yi[i]=k*im[i]; } iqPush(o,yr,yi,c.tag); }
      n.qa=[]; n.qb=[]; n.na=0; n.nb=0;
      return {out:o};
    }
    n.ui={sr:a.sr};
    for(const c of a.chunks){ n.qa.push([c.re, iqChunkIm(c)]); n.na+=c.re.length; }
    for(const c of b.chunks){ n.qb.push([c.re, iqChunkIm(c)]); n.nb+=c.re.length; }
    const L=Math.min(n.na,n.nb);
    if(L>0){
      const yr=new Float32Array(L), yi=new Float32Array(L);
      const take=(q,k)=>{ let i=0;
        while(i<L){ const [r,m]=q[0], c=Math.min(r.length, L-i);
          for(let j=0;j<c;j++){ yr[i+j]+=k*r[j]; yi[i+j]+=k*m[j]; }
          i+=c;
          if(c===r.length) q.shift(); else q[0]=[r.subarray(c), m.subarray(c)];
        } };
      take(n.qa,ka); take(n.qb,kb); n.na-=L; n.nb-=L;
      iqPush(o,yr,yi);
    }
    // вход отстал больше чем на секунду — сброс очередей, чтобы не копить без конца
    if(Math.max(n.na,n.nb)>a.sr){ n.qa=[]; n.qb=[]; n.na=0; n.nb=0; }
    return {out:o};
  }};

/* ---- IQ Channelizer ---- */
// Полифазный банк фильтров (WOLA): N каналов с шагом sr/N, выход каждого канала — sr/D,
// D=N (ov=1, критическая выборка) или N/2 (ov=2 — без наложения на краях канала).
// Кадр: свёртка последних L=N·P отсчётов с прототипом ФНЧ, свёртка в N бинов, одно БПФ на все
// каналы; канал c = z[c]·e^(−j2πcn/N) — сигнал на fc + c·sr/N, перенесённый в 0.
// Выходы: K слотов — выбранные каналы (вручную по частотам или самые сильные), спектр мощности
// каналов, число занятых слотов. Коэффициент передачи на центре канала — 1.
function iqChanProto(N,P,ov){
  const L=N*P, h=new Float32Array(L), mid=(L-1)/2;
  const fcN=(ov===2 ? 0.5+2.75/P : 0.5)/N;          // срез: ov=2 — полоса до края канала ровная
  let sum=0;
  for(let i=0;i<L;i++){
    const x=i-mid, sinc=x===0 ? 2*fcN : Math.sin(2*Math.PI*fcN*x)/(Math.PI*x);
    const w=0.42-0.5*Math.cos(2*Math.PI*i/(L-1))+0.08*Math.cos(4*Math.PI*i/(L-1));
    h[i]=sinc*w; sum+=h[i];
  }
  for(let i=0;i<L;i++) h[i]/=sum;
  return h;
}
function iqChanOff(c,N,sr){ return (c<N/2 ? c : c-N)*sr/N; }
IQK.iqChan={
  init(n){ n.key=''; },
  process(n,I){
    const s=iqIn(I,'in'), K=+n.p.K;
    const res={};
    if(!s || !s.sr){ n.ui=null; for(let k=1;k<=K;k++) res['ch'+k]=null; return res; }
    const N=+n.p.N, P=+n.p.P, ov=+n.p.ov, D=N/ov, sr=s.sr;
    const key=N+'|'+P+'|'+ov+'|'+sr;
    if(key!==n.key){
      n.key=key; n.h=iqChanProto(N,P,ov); n.H=N*P-1;
      n.hr=new Float32Array(n.H); n.hi=new Float32Array(n.H);
      n.ph=D-1;                                       // индекс (в чанке) новейшего отсчёта следующего кадра
      n.nAbs=0;                                       // номер первого отсчёта следующего чанка
      n.ur=new Float32Array(N); n.ui_=new Float32Array(N);
      n.pw=new Float64Array(N); n.frames=0; n.last=0; n.t=0;
      n.slots=[]; n.sp=null;
    }
    const srOut=sr/D, chW=sr/N;
    // слоты: канал и когда его в последний раз видели над порогом
    while(n.slots.length<K) n.slots.push({c:null, seen:0});
    n.slots.length=K;
    if(n.p.sel==='manual'){
      const list=String(n.p.freqs||'').split(/[,;\s]+/).filter(Boolean).map(v=>+v*1e6);
      for(let k=0;k<K;k++){
        const w=I['f'+(k+1)], f=typeof w==='number' && isFinite(w) ? w : list[k];
        let c=null;
        if(isFinite(f) && Math.abs(f-s.fc)<sr/2) c=((Math.round((f-s.fc)/chW)%N)+N)%N;
        n.slots[k].c=c;
      }
    }
    const outs=n.slots.map((sl,k)=>{
      const fc=sl.c==null ? s.fc : s.fc+iqChanOff(sl.c,N,sr);
      return iqStream(n,'ch'+(k+1),srOut,fc);
    });
    // смена канала у слота — метка retune на первом чанке
    const tags=n.slots.map(sl=>{ const t=sl.c!==sl.prev ? 'retune' : null; sl.prev=sl.c; return t; });
    const h=n.h, H=n.H, ur=n.ur, ui=n.ui_, pw=n.pw;
    for(const c of s.chunks){
      const xr=c.re, xi=iqChunkIm(c), Kc=xr.length;
      const br=new Float32Array(H+Kc); br.set(n.hr); br.set(xr,H);
      const bi=new Float32Array(H+Kc); bi.set(n.hi); bi.set(xi,H);
      const cnt=n.ph<Kc ? Math.floor((Kc-1-n.ph)/D)+1 : 0;
      const yr=n.slots.map(sl=>sl.c==null ? null : new Float32Array(cnt));
      const yi=n.slots.map(sl=>sl.c==null ? null : new Float32Array(cnt));
      let j=n.ph;
      for(let f=0;f<cnt;f++,j+=D){
        const b=H+j;                                  // br[b] — новейший отсчёт кадра
        ur.fill(0); ui.fill(0);
        for(let p=0;p<P;p++){                         // по ветвям: чтение подряд, а не с шагом N
          const hp=p*N, base=b-hp;
          for(let k=0;k<N;k++){ const g=h[hp+k]; ur[k]+=g*br[base-k]; ui[k]+=g*bi[base-k]; }
        }
        fft(ui,ur);                                   // обратное БПФ через перестановку re/im: результат re→ur, im→ui
        for(let k=0;k<N;k++) pw[k]+=ur[k]*ur[k]+ui[k]*ui[k];
        n.frames++;
        const r=(n.nAbs+j)%N;                         // фаза e^(−j2πcn/N) по номеру новейшего отсчёта
        for(let q=0;q<K;q++){
          const cc=n.slots[q].c; if(cc==null) continue;
          const a=-2*Math.PI*((cc*r)%N)/N, wr=Math.cos(a), wi=Math.sin(a);
          yr[q][f]=ur[cc]*wr-ui[cc]*wi; yi[q][f]=ur[cc]*wi+ui[cc]*wr;
        }
      }
      n.ph=j-Kc; n.nAbs+=Kc;
      n.hr.set(br.subarray(Kc)); n.hi.set(bi.subarray(Kc));
      for(let q=0;q<K;q++) if(yr[q] && cnt){ iqPush(outs[q],yr[q],yi[q],tags[q]||c.tag); tags[q]=null; }
    }
    n.t+=s.chunks.reduce((a,c)=>a+c.re.length,0);
    // спектр каналов и выбор самых сильных — раз в upd мс сигнала
    if(n.frames && n.t-n.last>=sr*n.p.upd/1000){
      n.last=n.t;
      const pc=new Float64Array(N);
      for(let k=0;k<N;k++){ pc[k]=pw[k]/n.frames; pw[k]=0; }
      n.frames=0;
      const sorted=Float64Array.from(pc).sort(), noise=sorted[N>>1]||1e-30;
      n.noise=noise;
      if(n.p.sel!=='manual') iqChanPick(n,pc,noise,N,sr);
      const mag=new Float32Array(N), freqs=new Float32Array(N), half=N>>1;
      for(let i=0;i<N;i++){ const k=(i+half)%N; mag[i]=Math.sqrt(pc[k]); freqs[i]=s.fc+iqChanOff(k,N,sr); }
      n.sp={mag, sr, size:N, freqs, rev:(n.rev=(n.rev|0)+1)};
    }
    n.ui={N, chW, srOut, slots:n.slots.map(sl=>sl.c==null ? null : s.fc+iqChanOff(sl.c,N,sr))};
    for(let k=0;k<K;k++) res['ch'+(k+1)]=outs[k];
    res.spec=n.sp; res.active=n.slots.filter(sl=>sl.c!=null).length;
    return res;
  }};
// Слоты держат свои каналы, пока те над порогом −3 дБ (или ещё hold секунд); свободные слоты
// занимают самые сильные локальные максимумы над шумом (медиана мощностей каналов) + thr дБ.
function iqChanPick(n,pc,noise,N,sr){
  const now=n.t/sr, on=noise*Math.pow(10,n.p.thr/10), keep=noise*Math.pow(10,(n.p.thr-3)/10);
  const skip=c=>n.p.skipDc && c===0;
  for(const sl of n.slots){
    if(sl.c==null) continue;
    if(pc[sl.c]>keep && !skip(sl.c)) sl.seen=now;
    else if(now-sl.seen>n.p.hold) sl.c=null;
  }
  const taken=new Set(n.slots.filter(sl=>sl.c!=null).map(sl=>sl.c));
  const near=c=>taken.has(c) || taken.has((c+1)%N) || taken.has((c+N-1)%N);
  const cand=[];
  for(let c=0;c<N;c++){
    if(pc[c]<=on || skip(c) || near(c)) continue;
    if(pc[c]<pc[(c+1)%N] || pc[c]<pc[(c+N-1)%N]) continue;   // только вершины: широкий сигнал — один слот
    cand.push(c);
  }
  cand.sort((a,b)=>pc[b]-pc[a]);
  for(const sl of n.slots){
    if(sl.c!=null) continue;
    const c=cand.find(c=>!near(c));
    if(c==null) break;
    sl.c=c; sl.seen=now; taken.add(c);
  }
}

/* ---- IQ DC Block ---- */
// Постоянная составляющая I/Q (выброс гетеродина zero-IF) — ФВЧ первого порядка, срез fc Гц
IQK.iqDc={
  init(n){ n.mi=0; n.mq=0; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {out:null}; }
    const o=iqStream(n,'out',s.sr,s.fc), a=1-Math.exp(-2*Math.PI*n.p.fc/s.sr);
    let mi=n.mi, mq=n.mq;
    for(const c of s.chunks){
      const xr=c.re, xi=iqChunkIm(c), K=xr.length, yr=new Float32Array(K), yi=new Float32Array(K);
      for(let i=0;i<K;i++){ mi+=a*(xr[i]-mi); mq+=a*(xi[i]-mq); yr[i]=xr[i]-mi; yi[i]=xi[i]-mq; }
      iqPush(o,yr,yi,c.tag);
    }
    n.mi=mi; n.mq=mq; n.ui={dc:Math.hypot(mi,mq)};
    return {out:o};
  }};

/* ---- IQ Noise Blanker ---- */
// Короткие импульсы (зажигание, импульсные БП) — на широкой полосе, до канального фильтра, где импульс
// ещё короткий: мощность отсчёта выше порога × средней — отсчёты обнуляются (с задержкой ~10 мкс,
// чтобы попал и фронт, и ~20 мкс после). Импульсы в среднюю мощность идут только по порогу.
const NB_K={low:36, mid:20, high:9};
IQK.iqNb={
  init(n){ n.key=''; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {out:null}; }
    const sr=s.sr, K0=NB_K[n.p.level]||0, o=iqStream(n,'out',sr,s.fc);
    if(n.key!==sr){
      n.key=sr; n.d=Math.max(2,Math.round(sr*10e-6)); n.post=Math.round(sr*20e-6);
      n.dI=new Float32Array(n.d); n.dQ=new Float32Array(n.d); n.pos=0; n.cnt=0; n.avg=0; n.a=1-Math.exp(-1/(0.01*sr));
      n.blanked=0; n.total=0;
    }
    for(const c of s.chunks){
      const xr=c.re, xi=iqChunkIm(c), L=xr.length, yr=new Float32Array(L), yi=new Float32Array(L);
      for(let i=0;i<L;i++){
        const p=xr[i]*xr[i]+xi[i]*xi[i], th=K0*n.avg;
        if(n.avg<1e-12) n.avg=p;
        else if(K0 && p>th) n.cnt=n.d+n.post;
        n.avg+=((K0 && p>th ? th : p)-n.avg)*n.a;
        const di=n.dI[n.pos], dq=n.dQ[n.pos]; n.dI[n.pos]=xr[i]; n.dQ[n.pos]=xi[i];
        if(++n.pos===n.d) n.pos=0;
        if(n.cnt>0){ n.cnt--; n.blanked++; } else { yr[i]=di; yi[i]=dq; }
      }
      n.total+=L;
      iqPush(o,yr,yi,c.tag);
    }
    n.ui={pct:n.total ? 100*n.blanked/n.total : 0};
    if(n.total>s.sr){ n.blanked*=0.5; n.total*=0.5; }                  // доля за последние ~секунды
    return {out:o};
  }};

/* ---- IQ Squelch ---- */
// Уровень канала (RSSI, dBFS: 0 — тон полной шкалы) по окнам 10 мс, шумовой пол — следящий минимум
// (вниз сразу, вверх 0.5 дБ/с), SNR — над ним. Открыт при уровне ≥ порога, закрывается ниже
// порога − 3 дБ спустя hang мс; открытие/закрытие — плавное (5 мс). Закрытый — нули, не пустота:
// мост в звук держит запас.
IQK.iqSquelch={
  init(n){ n.sr=0; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {out:null, rssi:null, snr:null, open:null}; }
    const sr=s.sr, o=iqStream(n,'out',sr,s.fc);
    if(sr!==n.sr){ n.sr=sr; n.win=Math.max(1,Math.round(sr*0.01)); n.acc=0; n.cnt=0; n.rssi=null; n.nf=null;
      n.open=n.p.mode==='off'; n.t=0; n.lastOk=0; n.g=n.open?1:0; n.gA=1/(sr*0.005); }
    const mode=n.p.mode, thr=+n.p.thr, hang=n.p.hang/1000;
    for(const c of s.chunks){
      const xr=c.re, xi=c.im, K=xr.length, yr=new Float32Array(K), yi=xi ? new Float32Array(K) : null;
      for(let i=0;i<K;i++){
        const a=xr[i], b=xi ? xi[i] : 0;
        n.acc+=a*a+b*b;
        if(++n.cnt>=n.win){
          const db=10*Math.log10(n.acc/n.cnt+1e-20)+(xi ? 0 : 3);   // вещественный: мощность тона 0.5
          n.acc=0; n.cnt=0; n.t+=n.win/sr;
          n.rssi=n.rssi==null ? db : n.rssi*0.7+db*0.3;
          n.nf=n.nf==null ? db : Math.min(db, n.nf+0.5*n.win/sr);
          const v=mode==='level' ? n.rssi : n.rssi-n.nf;
          if(mode==='off') n.open=true;
          else if(v>=thr || n.open && v>=thr-3){ n.open=true; n.lastOk=n.t; }
          else if(n.t-n.lastOk>hang) n.open=false;
        }
        const want=n.open ? 1 : 0;
        n.g+=Math.max(-n.gA, Math.min(n.gA, want-n.g));
        yr[i]=a*n.g; if(yi) yi[i]=b*n.g;
      }
      iqPush(o,yr,yi,c.tag);
    }
    const snr=n.rssi==null ? null : n.rssi-n.nf;
    n.ui={rssi:n.rssi, snr, open:n.open};
    return {out:o, rssi:n.rssi, snr, open:n.open ? 1 : 0};
  }};

/* ---- Mode S / ADS-B: общее для демодулятора, декодера и генератора ---- */
// CRC-24 Mode S (полином 0xFFF409); остаток = CRC(данные) ^ последние 3 байта
const MODES_CRC_T=(()=>{ const t=new Uint32Array(256);
  for(let i=0;i<256;i++){ let c=i<<16; for(let k=0;k<8;k++) c=c&0x800000 ? (c<<1)^0xFFF409 : c<<1; t[i]=c&0xFFFFFF; }
  return t; })();
function modesCrc(b,n){ let c=0; for(let i=0;i<n;i++) c=((c<<8)^MODES_CRC_T[((c>>>16)^b[i])&0xff])&0xFFFFFF; return c; }
function modesResidual(b,nb){ return modesCrc(b,nb-3)^((b[nb-3]<<16)|(b[nb-2]<<8)|b[nb-1]); }
function modesLen(df){ return df>=16 && df!==23 ? 112 : 56; }
// синдромы одиночных ошибок в 112-битном кадре (биты 5..111: DF не трогаем): синдром → бит и бит → синдром
let MODES_FIX1=null, MODES_SYN=null;
function modesFix1(){
  if(MODES_FIX1) return MODES_FIX1;
  MODES_FIX1=new Map(); MODES_SYN=new Int32Array(112);
  const b=new Uint8Array(14);
  for(let i=5;i<112;i++){ b.fill(0); b[i>>3]=0x80>>(i&7); const r=modesResidual(b,14); MODES_FIX1.set(r,i); MODES_SYN[i]=r; }
  return MODES_FIX1;
}
function modesHex(b,nb){ let s=''; for(let i=0;i<nb;i++) s+=(b[i]<16?'0':'')+b[i].toString(16); return s.toUpperCase(); }
// CPR: число долготных зон на широте lat
function cprNL(lat){
  lat=Math.abs(lat);
  if(lat<1e-9) return 59; if(lat>87) return 1; if(lat===87) return 2;
  const c=Math.cos(Math.PI*lat/180);
  return Math.floor(2*Math.PI/Math.acos(1-(1-Math.cos(Math.PI/30))/(c*c)));
}
function cprMod(a,b){ const r=a%b; return r<0 ? r+b : r; }
function cprEncode(lat,lon,odd){
  const dlat=360/(odd?59:60), yz=Math.floor(131072*cprMod(lat,dlat)/dlat+0.5);
  const rlat=dlat*(yz/131072+Math.floor(lat/dlat)), dlon=360/Math.max(cprNL(rlat)-odd,1);
  const xz=Math.floor(131072*cprMod(lon,dlon)/dlon+0.5);
  return [yz&0x1FFFF, xz&0x1FFFF];
}

/* ---- ADS-B Demodulator ---- */
// Модуль IQ → поиск преамбулы (импульсы 0, 1, 3.5, 4.5 мкс) → PPM-биты по 1 мкс → CRC-24.
// Интегралы по дробным окнам через префиксные суммы: подходит любая частота от 2 МС/с (2.4 — лучше).
// Фаза уточняется перебором сдвигов в полбита. DF11/17/18 — по CRC (1 бит исправляется),
// DF0/4/5/16/20/21 — адрес в CRC, принимается, если борт недавно слышен в DF11/17/18.
const ADSB_ADDR_TTL=60000;
IQK.adsbDemod={
  init(n){ n.sr=0; n.frames=0; n.fixed=0; n.bad=0; n.cand=0; n.rate=0; n.rT=0; n.rN=0; n.known=new Map(); n.bits=new Uint8Array(112); n.conf=new Float32Array(112); n.b=new Uint8Array(14); },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {rec:null, rate:null}; }
    const sr=s.sr, u=sr/1e6;
    if(sr!==n.sr){ n.sr=sr; n.span=Math.ceil(121*u)+4; n.hist=new Float32Array(0); n.skip=0; n.t=0; }
    let K=0; for(const c of s.chunks) K+=c.re.length;
    const H=n.hist.length, N=H+K, m=new Float32Array(N);
    m.set(n.hist);
    let w=H;
    for(const c of s.chunks){ const xr=c.re, xi=iqChunkIm(c); for(let i=0;i<xr.length;i++,w++) m[w]=Math.sqrt(xr[i]*xr[i]+xi[i]*xi[i]); }
    const P=new Float64Array(N+1);
    for(let i=0;i<N;i++) P[i+1]=P[i]+m[i];
    const G=x=>{ const k=x|0; return P[k]+(x-k)*m[k]; };
    const S=(a,b)=>G(b)-G(a);
    const h=u/2, thr=Math.pow(10,n.p.thr/20), recs=[], now=Date.now();
    const end=N-n.span, bits=n.bits, b=n.b;
    const pre=x=>{                                   // средний импульс и среднее затишье, на полбита
      const p1=S(x,x+h), p2=S(x+u,x+u+h), p3=S(x+3.5*u,x+4*u), p4=S(x+4.5*u,x+5*u);
      const q=S(x+h,x+u)+S(x+u+h,x+3.5*u)+S(x+4*u,x+4.5*u)+S(x+5*u,x+8*u);
      return [Math.min(p1,p2,p3,p4), (p1+p2+p3+p4)/4, q/12];
    };
    let x=n.skip;
    while(x<end){
      const [pmin,hi,lo]=pre(x);
      if(!(hi>thr*lo && pmin>lo && pmin>1e-6*h)){ x+=1; continue; }
      n.cand++;
      let got=null;
      const ph=[0,-.25,.25,-.5,.5].map(d=>x+d*h).filter(v=>v>=0 && v<end).map(v=>[v,pre(v)]).sort((a,c)=>(c[1][1]-c[1][2])-(a[1][1]-a[1][2]));
      for(const [x0] of ph){
        got=adsbBits(n,S,x0,u,h,bits,b,now);
        if(got) break;
      }
      if(got){
        const [len,r]=got;
        r.rssi=+(20*Math.log10(hi/h+1e-12)).toFixed(1);
        recs.push(r); n.frames++; n.rN++;
        x+=(8+len)*u;
      } else { n.bad++; x+=1; }
    }
    n.skip=x-Math.max(end,0);
    n.hist=m.slice(Math.max(0,N-n.span));
    n.t+=K/sr; n.rT+=K/sr;
    if(n.rT>=1){ n.rate=n.rN/n.rT; n.rN=0; n.rT=0;
      for(const [a,t] of n.known) if(now-t>ADSB_ADDR_TTL) n.known.delete(a); }
    n.ui={sr, frames:n.frames, fixed:n.fixed, rate:n.rate, cand:n.cand, known:n.known.size};
    return {rec:recs.length ? recs : null, rate:n.rate};
  }};
// биты кадра с позиции x0 → [длина, запись] или null, если CRC не сошлась
const ADSB_WEAK=12;
function adsbBits(n,S,x0,u,h,bits,b,now){
  const d=x0+8*u, conf=n.conf;
  let len=5;
  for(let j=0;j<len;j++){
    const a=d+j*u, p=S(a,a+h), q=S(a+h,a+u);
    bits[j]=p>q ? 1 : 0; conf[j]=Math.abs(p-q)/(p+q+1e-12);
    if(j===4) len=modesLen((bits[0]<<4)|(bits[1]<<3)|(bits[2]<<2)|(bits[3]<<1)|bits[4]);
  }
  const df=(bits[0]<<4)|(bits[1]<<3)|(bits[2]<<2)|(bits[3]<<1)|bits[4], nb=len/8;
  b.fill(0);
  for(let j=0;j<len;j++) if(bits[j]) b[j>>3]|=0x80>>(j&7);
  let res=modesResidual(b,nb), fix=0, icao;
  if(df===17 || df===18){
    if(res && n.p.fix!=='off'){
      const i=modesFix1().get(res);
      if(i!=null){ b[i>>3]^=0x80>>(i&7); res=0; fix=1; }
      else if(n.p.fix==='2 weak bits'){                // пары среди наименее уверенных битов
        const w=[]; for(let j=5;j<112;j++) w.push(j);
        w.sort((x,y)=>conf[x]-conf[y]); w.length=ADSB_WEAK;
        for(let a=0;a<ADSB_WEAK && res;a++) for(let c=a+1;c<ADSB_WEAK;c++) if((MODES_SYN[w[a]]^MODES_SYN[w[c]])===res){
          for(const k of [w[a],w[c]]) b[k>>3]^=0x80>>(k&7); res=0; fix=2; break; }
      }
    }
    if(res) return null;
    icao=(b[1]<<16)|(b[2]<<8)|b[3];
    if(df===17 || (b[0]&7)===0) n.known.set(icao,now);
  } else if(df===11){
    if(res&~0x7F) return null;
    icao=(b[1]<<16)|(b[2]<<8)|b[3];
    if(res===0) n.known.set(icao,now);               // с IID — только уже известные: меньше призраков
    else if(!n.known.has(icao)) return null;
  } else if(df===0 || df===4 || df===5 || df===16 || df===20 || df===21){
    if(!n.known.has(res)) return null;
    icao=res;
  } else return null;
  if(fix) n.fixed++;
  const r={t:now, raw:modesHex(b,nb), df, icao:icao.toString(16).toUpperCase().padStart(6,'0')};
  if(fix) r.fix=fix;
  return [len,r];
}

/* ---- генератор: ADS-B (DF17) от нескольких бортов на кругах ---- */
const ADSB_SIM=[                                   // alt — футы, per — период круга, с (знак — направление)
  {icao:0x4B1805, call:'SWR123', lat:55.01, lon:82.65, r:30, per:1220, alt:11000},
  {icao:0x155A2F, call:'SBI2512', lat:55.30, lon:83.25, r:18, per:-1000, alt:4500},
  {icao:0x3C6444, call:'DLH7AB', lat:54.70, lon:82.10, r:45, per:1220, alt:36000},
];
const ADSB_CS='#ABCDEFGHIJKLMNOPQRSTUVWXYZ##### ###############0123456789######';
function adsbSimPos(a,t){
  const w=2*Math.PI/a.per, ang=w*t, k=a.r/111.2;
  const lat=a.lat+k*Math.sin(ang), lon=a.lon+k*Math.cos(ang)/Math.cos(a.lat*Math.PI/180);
  const kt=Math.abs(w)*a.r*1000/0.5144;                       // скорость по кругу, узлы
  const ve=-Math.sin(ang)*Math.sign(w)*kt, vn=Math.cos(ang)*Math.sign(w)*kt;
  return {lat, lon, ve, vn};
}
// поля [значение, бит] → 14 байт DF17 с CRC
function adsbFrame(icao,me){
  const f=[[17,5],[5,3],[icao,24],...me], b=new Uint8Array(14);
  let p=0;
  for(const [v,nb] of f) for(let i=nb-1;i>=0;i--,p++) if(Math.floor(v/2**i)%2) b[p>>3]|=0x80>>(p&7);
  const c=modesCrc(b,11); b[11]=c>>>16; b[12]=(c>>>8)&0xff; b[13]=c&0xff;
  return b;
}
function adsbSimMsg(a,kind,t){
  const s=adsbSimPos(a,t);
  if(kind==='id'){
    const cs=(a.call+'        ').slice(0,8);
    return adsbFrame(a.icao,[[4,5],[3,3],...[...cs].map(ch=>[Math.max(0,ADSB_CS.indexOf(ch)),6])]);
  }
  if(kind==='v'){
    const e=Math.round(Math.abs(s.ve))+1, nn=Math.round(Math.abs(s.vn))+1;
    return adsbFrame(a.icao,[[19,5],[1,3],[0,5],[s.ve<0?1:0,1],[Math.min(e,1023),10],[s.vn<0?1:0,1],[Math.min(nn,1023),10],
      [0,1],[0,1],[1,9],[0,2],[0,1],[0,7]]);
  }
  const odd=kind==='po' ? 1 : 0, [yz,xz]=cprEncode(s.lat,s.lon,odd), q=Math.round((a.alt+1000)/25);
  return adsbFrame(a.icao,[[11,5],[0,2],[0,1],[((q&0x7F0)<<1)|0x10|(q&0xF),12],[0,1],[odd,1],[yz,17],[xz,17]]);
}
// огибающая кадра на частоте sr: доля отсчёта под импульсами
function adsbEnv(b,sr){
  const on=[[0,.5],[1,1.5],[3.5,4],[4.5,5]];
  for(let j=0;j<112;j++){ const v=(b[j>>3]>>(7-(j&7)))&1, t=8+j+(v?0:.5); on.push([t,t+.5]); }
  const L=Math.ceil(120*sr/1e6)+1, e=new Float32Array(L), dt=1e6/sr;
  for(const [a,c] of on){
    const k0=Math.floor(a/dt), k1=Math.min(L-1,Math.floor(c/dt));
    for(let k=k0;k<=k1;k++) e[k]+=Math.max(0,Math.min(c,(k+1)*dt)-Math.max(a,k*dt))/dt;
  }
  return e;
}
const ADSB_SEQ=['pe','po','v','pe','po','id'];
function iqGenAdsb(n,sr,N){
  let g=n.adsb;
  if(!g || g.sr!==sr){ g=n.adsb={sr, t:0, k:0, env:null, pos:0, next:0}; }
  const out=new Float32Array(N);
  for(let i=0;i<N;i++,g.t++){
    if(!g.env && g.t>=g.next){
      const a=ADSB_SIM[g.k%ADSB_SIM.length], kind=ADSB_SEQ[Math.floor(g.k/ADSB_SIM.length)%ADSB_SEQ.length];
      g.env=adsbEnv(adsbSimMsg(a,kind,g.t/sr),sr); g.pos=0; g.k++;
      g.next=g.t+Math.round(sr*(0.04+0.03*((g.k*7919)%13)/13));
    }
    if(g.env){ out[i]=g.env[g.pos++]; if(g.pos>=g.env.length) g.env=null; }
  }
  return out;
}
