"use strict";
/* ============================ TBSK (Trait Block Shift Keying): ядро ============================
   Модуляция nyatla/TBSKmodem: бит — один «тон» (несущая с ПСП-сдвигами фазы, расширенный спектр) или он же с обратным знаком.
   Кодирование дифференциальное: бит 1 — знак тона как у предыдущего символа, бит 0 — обратный. Приём — задержанное детектирование:
   корреляция символа с предыдущим (+1 → 1, −1 → 0), без FFT, несущая и фаза не нужны.
   Тон (XPskSin): фаза s0 = δ/2, шаг δ + k·2π/8, k = ±1 из младшего бита XorShift31(999, пропуск 299); отсчёт sin(s), δ = 2π·fc/fs.
   Преамбула — символы [0,1] + [1]×(c+1) + [0,1,…]×c + [x,x,y] (c = 4 → 14 символов): площадка с r = +1, потом r = −1.
   Стоп-символ — тон с чередованием знака отсчётов (ортогонален тону, r ≈ 0). Знаки и порядок взяты из Python-порта; эфир с оригиналом не сверялся.
   Алгоритм и константы — из TBSKmodem (MIT, Copyright (C) 2022 Ryo Iizuka, nyatla.jp, https://github.com/nyatla/TBSKmodem); код написан заново.
   Патент WO-A-2010/016589 (права могут принадлежать YAMAHA) — см. раздел README «TBSK». */

const TBSK_PRE_CYCLE=4, TBSK_DIV=8;

// XorShift31 как в Python-порте: сдвиги без обрезки до 32 бит, маска 31 бит только в конце
function tbskXorShift(seed,skip){
  let y=BigInt(seed); const M=0x7fffffffn;
  const next=()=>{ y=y^(y<<13n); y=y^(y>>17n); y=y^(y<<5n); y&=M; return Number(y); };
  for(let i=0;i<skip;i++) next();
  return next;
}

// тон длиной round(cycle·fs/fc) отсчётов
function tbskTone(fs,fc,cycle){
  const N=Math.max(8,Math.round(cycle*fs/fc)), d=2*Math.PI*fc/fs, rnd=tbskXorShift(999,299), t=new Float32Array(N);
  let s=d*.5;
  for(let i=0;i<N;i++){ t[i]=Math.sin(s); s+=d+((rnd()&1) ? 1 : -1)*(2*Math.PI/TBSK_DIV); }
  return t;
}

// символы преамбулы (знаки без дифференцирования)
function tbskPreambleSyms(c){
  const a=[0,1]; for(let i=0;i<c+1;i++) a.push(1);
  const alt=[]; for(let i=0;i<c;i++) alt.push(i%2);
  const l=alt[c-1], x=(1+l)%2;
  return a.concat(alt,[x,x,l]);
}

// байты → биты (старший вперёд)
function tbskBits(bytes){ const b=[]; for(const v of bytes) for(let k=7;k>=0;k--) b.push((v>>k)&1); return b; }

// биты → отсчёты: преамбула, данные (дифференциально от последнего символа преамбулы), стоп-символ
function tbskModulate(tone,bits,opt){
  opt=opt||{};
  const N=tone.length, pre=tbskPreambleSyms(opt.preCycle||TBSK_PRE_CYCLE), amp=opt.amp==null ? 1 : opt.amp;
  const syms=pre.slice(); let last=pre[pre.length-1];
  for(const b of bits){ if(!b) last^=1; syms.push(last); }
  const stop=opt.stop!==false, out=new Float32Array((syms.length+(stop ? 1 : 0))*N);
  for(let k=0;k<syms.length;k++){ const s=syms[k] ? amp : -amp; for(let i=0;i<N;i++) out[k*N+i]=tone[i]*s; }
  if(stop) for(let i=0;i<N;i++) out[syms.length*N+i]=(i&1 ? -.5 : .5)*amp*tone[i];
  return out;
}

/* ---- приёмник ----
   r(t) — коэффициент корреляции последних N отсчётов с предыдущими N (скользящие суммы). Поиск преамбулы — свёртка r с ожидаемыми
   знаками в моменты границ символов; пик выше порога — захват, граница символа известна. Дальше решение в каждой границе
   (r > 0 → 1), подстройка такта по соседним |r|, конец — когда |r| < th. */
function tbskRxNew(N,o){
  o=o||{};
  const pre=tbskPreambleSyms(o.preCycle||TBSK_PRE_CYCLE), M=pre.length, e=[];
  for(let k=1;k<M;k++) e.push(pre[k]===pre[k-1] ? 1 : -1);
  const L=(M+3)*N;
  return {N, M, e, th:o.th==null ? .2 : o.th, det:o.det==null ? .4 : o.det, maxBits:o.maxBytes>0 ? o.maxBytes*8 : 1<<20,
    x:new Float64Array(3*N), xi:0, c:0, e1:0, e2:0, since:0, r:new Float32Array(L), L, t:0,
    mode:0, best:-1, bestT:0, te:0, shift:0, bits:[], q:0, lowRun:0, t0:0};
}
function tbskRxFeed(s,inp,len,out){
  const N=s.N, X=s.x, X3=3*N;
  for(let i=0;i<len;i++){
    const v=inp[i], j=s.xi, p=X[(j+2*N)%X3], q=X[(j+N)%X3];                    // x[t-N], x[t-2N]; X[j] — x[t-3N], уходит
    X[j]=v; s.xi=(j+1)%X3;
    s.c+=v*p-p*q; s.e1+=v*v-p*p; s.e2+=p*p-q*q;
    if(++s.since>=N*64){                                                       // дрейф накопленных сумм
      s.since=0; let c=0, e1=0, e2=0;
      for(let k=0;k<N;k++){ const u=X[(s.xi-1-k+X3)%X3], w=X[(s.xi-1-N-k+X3)%X3]; c+=u*w; e1+=u*u; e2+=w*w; }
      s.c=c; s.e1=e1; s.e2=e2;
    }
    const fl=N*1e-8;
    const r=(s.e1>fl && s.e2>fl) ? Math.max(-1,Math.min(1,s.c/Math.sqrt(s.e1*s.e2))) : 0;
    const t=s.t++; s.r[t%s.L]=r;
    if(t<3*N) continue;
    if(s.mode===0) tbskSearch(s,t);
    else tbskTrack(s,t,out);
  }
}
const tbskR=(s,t)=>s.r[((t%s.L)+s.L)%s.L];
function tbskSearch(s,t){
  const N=s.N, M=s.M;
  if(t<M*N) return;
  let sc=0; for(let k=1;k<M;k++) sc+=s.e[k-1]*tbskR(s,t-(M-1-k)*N);
  sc/=(M-1);
  if(sc>s.det && sc>s.best){ s.best=sc; s.bestT=t; }
  if(s.best>0 && t-s.bestT>N/2){
    s.mode=1; s.te=s.bestT+N; s.shift=0; s.bits=[]; s.q=0; s.lowRun=0; s.t0=s.bestT-M*N; s.best=-1;
  }
}
function tbskTrack(s,t,out){
  while(s.mode===1 && t>=s.te+1){
    const r=tbskR(s,s.te), ra=Math.abs(tbskR(s,s.te-1)), rb=Math.abs(tbskR(s,s.te+1));
    if(Math.abs(r)<s.th || s.bits.length>=s.maxBits){ tbskEnd(s,out); return; }
    s.bits.push(r>0 ? 1 : 0); s.q+=Math.abs(r);
    if(ra>rb) s.shift--; else if(rb>ra) s.shift++;
    let adv=s.N;
    if(Math.abs(s.shift)>10){ adv+=s.shift>0 ? 1 : -1; s.shift=0; }
    s.te+=adv;
  }
}
function tbskEnd(s,out){
  const nb=s.bits.length, n=nb>>3, by=new Uint8Array(n);
  for(let i=0;i<n;i++){ let v=0; for(let k=0;k<8;k++) v=(v<<1)|s.bits[i*8+k]; by[i]=v; }
  if(nb) out.push({bits:nb, bytes:by, quality:s.q/nb, t0:s.t0});
  s.mode=0; s.best=-1; s.bits=[];
}
