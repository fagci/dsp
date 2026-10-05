"use strict";
/* ============================ ЧИСТЫЙ DSP ============================
   Без DOM и без движка: грузится и страницей, и воркерами (importScripts). */
function pv(n,I,name){ const v=I[name]; return (typeof v==='number' && isFinite(v)) ? v : n.p[name]; }
function clamp(v,a,b){ return v<a?a:v>b?b:v; }
function popcnt32(v){ v-=(v>>>1)&0x55555555; v=(v&0x33333333)+((v>>>2)&0x33333333); return (((v+(v>>>4))&0x0F0F0F0F)*0x01010101)>>>24; }
function bitsLsb(bytes,n=bytes.length){ const b=[]; for(let i=0;i<n;i++) for(let j=0;j<8;j++) b.push((bytes[i]>>j)&1); return b; }   // байты → биты, младший первым
function bitsNum(b,o,len){ let v=0; for(let i=0;i<len;i++) v=v*2+b[o+i]; return v; }   // число из бит, старший первым
function bitRev(v,w){ let r=0; for(let i=0;i<w;i++) r=(r<<1)|((v>>>i)&1); return r>>>0; }
function pow2ge(n){ let p=1; while(p<n) p<<=1; return p; }
function rms(a){ let s=0; for(let i=0;i<a.length;i++) s+=a[i]*a[i]; return Math.sqrt(s/a.length); }

function fft(re,im){
  const n=re.length;
  for(let i=1,j=0;i<n;i++){ let bit=n>>1;
    for(;j&bit;bit>>=1) j^=bit; j^=bit;
    if(i<j){ let t=re[i];re[i]=re[j];re[j]=t; t=im[i];im[i]=im[j];im[j]=t; } }
  for(let len=2;len<=n;len<<=1){
    const ang=-2*Math.PI/len, wr=Math.cos(ang), wi=Math.sin(ang), h=len>>1;
    for(let i=0;i<n;i+=len){ let cr=1,ci=0;
      for(let k=0;k<h;k++){
        const ur=re[i+k], ui=im[i+k];
        const vr=re[i+k+h]*cr-im[i+k+h]*ci, vi=re[i+k+h]*ci+im[i+k+h]*cr;
        re[i+k]=ur+vr; im[i+k]=ui+vi; re[i+k+h]=ur-vr; im[i+k+h]=ui-vi;
        const t=cr*wr-ci*wi; ci=cr*wi+ci*wr; cr=t; } } }
}
// БПФ вещественного x[N] через комплексное длины N/2 — вдвое дешевле fft().
// zr/zi — рабочие буферы N/2; в outRe/outIm — бины 0..N/2-1.
const RFFT_TW=new Map();
function rfft(x,zr,zi,outRe,outIm){
  const N=x.length, M=N>>1;
  let t=RFFT_TW.get(N);
  if(!t){ t={c:new Float64Array(M), s:new Float64Array(M)};
    for(let k=0;k<M;k++){ const a=-2*Math.PI*k/N; t.c[k]=Math.cos(a); t.s[k]=Math.sin(a); }
    RFFT_TW.set(N,t); }
  for(let i=0;i<M;i++){ zr[i]=x[2*i]; zi[i]=x[2*i+1]; }
  fft(zr,zi);
  const c=t.c, s=t.s;
  outRe[0]=zr[0]+zi[0]; outIm[0]=0;
  for(let k=1;k<M;k++){
    const ar=zr[k], ai=zi[k], br=zr[M-k], bi=-zi[M-k];
    const er=(ar+br)/2, ei=(ai+bi)/2, or_=(ai-bi)/2, oi=(br-ar)/2;   // чётные/нечётные отсчёты
    outRe[k]=er+c[k]*or_-s[k]*oi; outIm[k]=ei+c[k]*oi+s[k]*or_;
  }
}
function window_(kind,N){
  const w=new Float32Array(N);
  for(let i=0;i<N;i++){ const x=i/(N-1);
    w[i] = kind==='hann'? 0.5-0.5*Math.cos(2*Math.PI*x)
         : kind==='hamming'? 0.54-0.46*Math.cos(2*Math.PI*x)
         : kind==='blackman'? 0.42-0.5*Math.cos(2*Math.PI*x)+0.08*Math.cos(4*Math.PI*x)
         : 1; }
  return w;
}
function biquadCoef(type,f,Q,sr){
  const w0=2*Math.PI*clamp(f,10,sr/2-100)/sr, c=Math.cos(w0), s=Math.sin(w0), al=s/(2*Math.max(.05,Q));
  let b0,b1,b2,a0,a1,a2;
  if(type==='lp'){ b0=(1-c)/2; b1=1-c; b2=b0; a0=1+al; a1=-2*c; a2=1-al; }
  else if(type==='hp'){ b0=(1+c)/2; b1=-(1+c); b2=b0; a0=1+al; a1=-2*c; a2=1-al; }
  else if(type==='bp'){ b0=al; b1=0; b2=-al; a0=1+al; a1=-2*c; a2=1-al; }
  else if(type==='ap'){ b0=1-al; b1=-2*c; b2=1+al; a0=1+al; a1=-2*c; a2=1-al; }   // фазовращатель — АЧХ ровная, меняется только фаза
  else { b0=1; b1=-2*c; b2=1; a0=1+al; a1=-2*c; a2=1-al; }            // notch
  return [b0/a0,b1/a0,b2/a0,a1/a0,a2/a0];
}


/* ---- поток 'iq' ----
   Провод 'iq' несёт не блок BLOCK на Eng.sr, а поток со своей частотой дискретизации:
   {sr, fc, chunks:[{re, im, t0, tag}]}, за такт — 0..N чанков любой длины.
   im=null — вещественный поток (например, звук демодулятора на частоте потока).
   fc — какой частоте соответствует 0 Гц потока (у вещественного 0).
   t0 — номер первого отсчёта чанка от начала потока; tag — 'gap' (пропуск) или 'retune'.
   Данные чанка живут один такт: кому нужно дольше — копирует. */
function iqStream(n,name,sr,fc){
  const m=n._iqs||(n._iqs={});
  const s=m[name]||(m[name]={sr:0,fc:0,chunks:[],t:0});
  s.sr=sr; s.fc=fc; s.chunks=[];
  return s;
}
function iqPush(s,re,im,tag){ s.chunks.push({re,im,t0:s.t,tag:tag||null}); s.t+=re.length; }
function iqIn(I,name){ const s=I[name]; return s&&s.chunks ? s : null; }

// Чанк из сырых отсчётов АЦП: u8 (смещение 127.5, как RTL-SDR) или s16. re/im считаются при
// первом обращении; в воркер острова уходит сам raw — в 4 (u8) или 2 (s16) раза меньше float.
function iqUnpack(raw,fmt){
  const n=raw.length>>1, re=new Float32Array(n), im=new Float32Array(n);
  if(fmt==='s16') for(let k=0;k<n;k++){ re[k]=raw[2*k]/32768; im[k]=raw[2*k+1]/32768; }
  else for(let k=0;k<n;k++){ re[k]=(raw[2*k]-127.5)/127.5; im[k]=(raw[2*k+1]-127.5)/127.5; }
  return [re,im];
}
class IqRawChunk{
  constructor(raw,fmt,t0,tag){ this.raw=raw; this.fmt=fmt; this.t0=t0; this.tag=tag; this._re=null; this._im=null; }
  get re(){ if(!this._re) [this._re,this._im]=iqUnpack(this.raw,this.fmt); return this._re; }
  get im(){ if(!this._re) [this._re,this._im]=iqUnpack(this.raw,this.fmt); return this._im; }
}
function iqPushRaw(s,raw,fmt,tag){ s.chunks.push(new IqRawChunk(raw,fmt,s.t,tag||null)); s.t+=raw.length>>1; }

// ФНЧ с окном Кайзера, β=5.65 (~60 дБ); число отводов — по ширине перехода (не больше maxN), нечётное
function besselI0(x){ let s=1, t=1; for(let k=1;k<30;k++){ t*=(x/(2*k))*(x/(2*k)); s+=t; if(t<1e-10*s) break; } return s; }
function kaiserLP(fs, pass, stop, maxN){
  const tw=Math.max(1, stop-pass), fc=(pass+stop)/2/fs;
  let N=Math.min(maxN||2047, Math.ceil(3.6*fs/tw)); N|=1;
  const M=(N-1)/2, beta=5.65, i0b=besselI0(beta), h=new Float32Array(N);
  let s=0;
  for(let k=0;k<N;k++){
    const x=k-M, r=M ? x/M : 0;
    const sinc=x===0 ? 2*fc : Math.sin(2*Math.PI*fc*x)/(Math.PI*x);
    h[k]=sinc*besselI0(beta*Math.sqrt(Math.max(0,1-r*r)))/i0b; s+=h[k];
  }
  for(let k=0;k<N;k++) h[k]/=s;
  return h;
}
// КИХ по отсчётам с историей: окно — история + чанк, выход той же длины, что вход
function firRun(h, hist, x){
  const N=h.length, H=N-1, K=x.length, b=new Float32Array(H+K), y=new Float32Array(K);
  b.set(hist); b.set(x,H);
  for(let i=0;i<K;i++){ let s=0; for(let t=0;t<N;t++) s+=h[t]*b[i+t]; y[i]=s; }
  hist.set(b.subarray(K));
  return y;
}
