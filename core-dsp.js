"use strict";
/* ============================ ЧИСТЫЙ DSP ============================
   Без DOM и без движка: грузится и страницей, и воркерами (importScripts). */
function pv(n,I,name){ const v=I[name]; return (typeof v==='number' && isFinite(v)) ? v : n.p[name]; }
function clamp(v,a,b){ return v<a?a:v>b?b:v; }
function popcnt32(v){ v-=(v>>>1)&0x55555555; v=(v&0x33333333)+((v>>>2)&0x33333333); return (((v+(v>>>4))&0x0F0F0F0F)*0x01010101)>>>24; }
function bitsLsb(bytes,n=bytes.length){ const b=[]; for(let i=0;i<n;i++) for(let j=0;j<8;j++) b.push((bytes[i]>>j)&1); return b; }   // байты → биты, младший первым
function bitsNum(b,o,len){ let v=0; for(let i=0;i<len;i++) v=v*2+b[o+i]; return v; }   // число из бит, старший первым
function bytesHex(a,o,n){ let s=''; for(let i=o||0;i<(n==null ? a.length : (o||0)+n);i++) s+=(a[i]<16?'0':'')+a[i].toString(16); return s.toUpperCase(); }
function bitsMsb(bytes){ const r=new Uint8Array(bytes.length*8); for(let i=0;i<bytes.length;i++) for(let k=0;k<8;k++) r[8*i+k]=(bytes[i]>>(7-k))&1; return r; }
function bytesFromBits(b){ const r=new Uint8Array(b.length>>3); for(let i=0;i<r.length;i++) r[i]=bitsNum(b,8*i,8); return r; }
const u8cat=(...a)=>{ let n=0; for(const x of a) n+=x.length; const r=new Uint8Array(n); let o=0; for(const x of a){ r.set(x,o); o+=x.length; } return r; };
// CRC-16 по байтам, старший бит первым (poly 0x1021…)
function crc16(b,from,len,poly,init,xorout){
  let r=init;
  for(let i=0;i<len;i++){ r^=b[from+i]<<8; for(let k=0;k<8;k++) r=(r&0x8000) ? ((r<<1)^poly)&0xFFFF : (r<<1)&0xFFFF; }
  return r^xorout;
}
// отражённый CRC-16, младший бит первым (poly в отражённом виде, напр. 0x8408)
function crc16r(b,from,len,poly,init,xorout){
  let r=init;
  for(let i=0;i<len;i++){ r^=b[from+i]; for(let k=0;k<8;k++) r=(r&1) ? (r>>>1)^poly : r>>>1; }
  return r^xorout;
}
// CRC ширины w по битам, старший первым, без итогового XOR
function crcBits(bits,len,w,poly,init){
  const top=1<<(w-1), all=(1<<w)-1; let c=init;
  for(let i=0;i<len;i++){ const fb=((c&top) ? 1 : 0)^(bits[i]&1); c=(c<<1)&all; if(fb) c^=poly; }
  return c;
}
function bitRev(v,w){ let r=0; for(let i=0;i<w;i++) r=(r<<1)|((v>>>i)&1); return r>>>0; }
function pow2ge(n){ let p=1; while(p<n) p<<=1; return p; }
function rms(a){ let s=0; for(let i=0;i<a.length;i++) s+=a[i]*a[i]; return Math.sqrt(s/a.length); }

// БПФ по основанию 2 на месте. Таблицы (перестановка бит, twiddle) кэшируются по длине; первые две стадии без умножений.
const FFT_PLAN=new Map();
function fftPlan(n){
  let p=FFT_PLAN.get(n);
  if(p) return p;
  const rev=new Uint32Array(n), c=new Float64Array(n>>1), s=new Float64Array(n>>1);
  for(let i=1,j=0;i<n;i++){ let bit=n>>1; for(;j&bit;bit>>=1) j^=bit; j^=bit; rev[i]=j; }
  for(let k=0;k<(n>>1);k++){ const a=-2*Math.PI*k/n; c[k]=Math.cos(a); s[k]=Math.sin(a); }
  p={rev,c,s}; FFT_PLAN.set(n,p); return p;
}
function fft(re,im){
  const n=re.length;
  if(n<2) return;
  const {rev,c,s}=fftPlan(n);
  for(let i=1;i<n;i++){ const j=rev[i];
    if(i<j){ let t=re[i];re[i]=re[j];re[j]=t; t=im[i];im[i]=im[j];im[j]=t; } }
  for(let i=0;i<n;i+=2){                              // длина 2: w = 1
    const ur=re[i], ui=im[i], vr=re[i+1], vi=im[i+1];
    re[i]=ur+vr; im[i]=ui+vi; re[i+1]=ur-vr; im[i+1]=ui-vi;
  }
  if(n>=4) for(let i=0;i<n;i+=4){                     // длина 4: w = 1, −j
    let ur=re[i], ui=im[i], vr=re[i+2], vi=im[i+2];
    re[i]=ur+vr; im[i]=ui+vi; re[i+2]=ur-vr; im[i+2]=ui-vi;
    ur=re[i+1]; ui=im[i+1]; vr=im[i+3]; vi=-re[i+3];   // (re+j·im)·(−j) = im − j·re
    re[i+1]=ur+vr; im[i+1]=ui+vi; re[i+3]=ur-vr; im[i+3]=ui-vi;
  }
  for(let len=8;len<=n;len<<=1){
    const h=len>>1, step=n/len;
    for(let i=0;i<n;i+=len){
      for(let k=0,t=0;k<h;k++,t+=step){
        const cr=c[t], ci=s[t], a=i+k, b=a+h;
        const vr=re[b]*cr-im[b]*ci, vi=re[b]*ci+im[b]*cr, ur=re[a], ui=im[a];
        re[a]=ur+vr; im[a]=ui+vi; re[b]=ur-vr; im[b]=ui-vi;
      }
    }
  }
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

// HackRF RX_SWEEP: поток блоков по 16384 байт — 7F 7F, частота нижнего края сегмента (u64 LE, Гц), 8187 отсчётов int8 IQ.
// Читаем потоком с самосинхронизацией: границы чтений не обязаны совпадать с границами блоков.
// st={buf,n,synced}; cb(freq, iq) получает вид на отсчёты блока, валидный только внутри вызова.
const HRF_SWEEP_BLOCK=16384;
function hackrfSweepSplit(st, bytes, fLo, fHi, cb){
  if(!st.buf || st.buf.length<st.n+bytes.length){
    const nb=new Uint8Array(Math.max(2*HRF_SWEEP_BLOCK, (st.n+bytes.length)*2));
    if(st.buf) nb.set(st.buf.subarray(0,st.n));
    st.buf=nb;
  }
  st.buf.set(bytes, st.n); st.n+=bytes.length;
  const b=st.buf, hdr=i=>{
    if(b[i]!==0x7F || b[i+1]!==0x7F) return -1;
    const dv=new DataView(b.buffer, i+2, 8), hi=dv.getUint32(4,true);
    if(hi) return -1;
    const f=dv.getUint32(0,true);
    return f%1e6===0 && f>=fLo-1e6 && f<=fHi ? f : -1;
  };
  let o=0;
  for(;;){
    if(!st.synced){
      while(o+10<=st.n && hdr(o)<0) o++;
      if(o+10>st.n) break;                       // заголовка нет — хвост меньше заголовка оставляем на склейку
      st.synced=true;
    }
    if(o+HRF_SWEEP_BLOCK>st.n) break;
    const f=hdr(o);
    if(f<0){ st.synced=false; o++; continue; }   // потеряли ритм — ищем заново
    cb(f, b.subarray(o+10, o+HRF_SWEEP_BLOCK));
    o+=HRF_SWEEP_BLOCK;
  }
  if(o>0){ b.copyWithin(0, o, st.n); st.n-=o; }
}

// cron: 5 полей «мин час день мес день-недели», как у crontab.
// Звезда, a, a-b, a-b/n, звезда/n, списки через запятую, имена mon…/jan…, 7 = воскресенье, @hourly @daily @weekly @monthly.
// День месяца и день недели, если заданы оба, срабатывают по «или» (как в Vixie cron).
const CRON_ALIAS={'@hourly':'0 * * * *','@daily':'0 0 * * *','@midnight':'0 0 * * *','@weekly':'0 0 * * 0','@monthly':'0 0 1 * *','@yearly':'0 0 1 1 *','@annually':'0 0 1 1 *'};
const CRON_NAMES={sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6,jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
function cronField(s,lo,hi,dow){
  const set=new Set(); let star=true;
  for(const part of s.toLowerCase().split(',')){
    const m=part.match(/^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/);
    if(!m) return null;
    const step=m[2]?+m[2]:1; if(step<1) return null;
    let a,b;
    if(m[1]==='*'){ a=lo; b=hi; if(!m[2]) { /* звезда без шага */ } else star=false; }
    else {
      star=false;
      const r=m[1].split('-').map(v=>v in CRON_NAMES ? CRON_NAMES[v] : /^\d+$/.test(v) ? +v : NaN);
      a=r[0]; b=r.length>1 ? r[1] : (m[2] ? hi : a);
      if(isNaN(a)||isNaN(b)) return null;
    }
    if(dow && a===7 && b===7) a=b=0;
    const top=dow ? 7 : hi;
    if(a<lo||b>top||a>b) return null;
    for(let v=a;v<=b;v+=step) set.add(dow&&v===7 ? 0 : v);
  }
  return {set, star};
}
function cronParse(expr){
  let s=String(expr||'').trim().toLowerCase();
  s=CRON_ALIAS[s]||s;
  const f=s.split(/\s+/);
  if(f.length!==5) return null;
  const mi=cronField(f[0],0,59), ho=cronField(f[1],0,23), dm=cronField(f[2],1,31), mo=cronField(f[3],1,12), dw=cronField(f[4],0,6,true);
  if(!mi||!ho||!dm||!mo||!dw) return null;
  return {min:mi.set, hour:ho.set, dom:dm.set, mon:mo.set, dow:dw.set, domStar:dm.star, dowStar:dw.star};
}
function cronDayOk(c,d){          // d — Date в «зонном» представлении (поля через getUTC*)
  if(!c.mon.has(d.getUTCMonth()+1)) return false;
  const a=c.dom.has(d.getUTCDate()), b=c.dow.has(d.getUTCDay());
  return c.domStar&&c.dowStar ? true : c.domStar ? b : c.dowStar ? a : a||b;
}
// ближайшее срабатывание строго после t (секунды Unix); off — сдвиг зоны, с. Минутная сетка; null — нет за 5 лет
function cronNext(c,t,off){
  let m=Math.floor((t+off)/60)+1;               // минута в зонном времени
  const end=m+5*366*1440;
  while(m<end){
    const d=new Date(m*60000);
    if(!cronDayOk(c,d)){ m=Math.floor(m/1440+1)*1440; continue; }       // весь день мимо — на полночь
    if(!c.hour.has(d.getUTCHours())){ m=Math.floor(m/60+1)*60; continue; }
    if(c.min.has(d.getUTCMinutes())) return m*60-off;
    m++;
  }
  return null;
}

// Линейная ось спектра с частотами в Гц: {f0, st} (бин i ↔ f0+st·i) или false, если ось неравномерная (вейвлет, октавы).
// Ось из Float32Array на ГГц-частотах квантована до 128 Гц (на 100 МГц — 8 Гц) — крупнее бина БПФ; поиск бина по такой оси
// даёт «ступеньки» при сильном зуме, поэтому у равномерной оси бин считается по краям, а не по элементам. Кэш — на объекте спектра.
function specAxis(s){
  const F=s.freqs, N=F.length, a=s._ax;
  if(a!==undefined && s._axF===F && s._axN===N && s._ax0===F[0] && s._ax1===F[N-1]) return a;
  let ax=false;
  if(N>2){
    const f0=F[0], st=(F[N-1]-F[0])/(N-1);
    if(st>0){
      const tol=Math.max(Math.abs(F[N-1])*1.3e-7, st*0.02), dk=Math.max(1,N>>8);   // float32: полшага = 6e-8 от значения
      ax={f0,st};
      for(let i=1;i<N-1;i+=dk) if(Math.abs(F[i]-(f0+st*i))>tol){ ax=false; break; }
    }
  }
  s._ax=ax; s._axF=F; s._axN=N; s._ax0=F[0]; s._ax1=F[N-1];
  return ax;
}
function specHz(s,i){
  if(!s) return 0;
  if(s.freqs){ const ax=specAxis(s); if(ax) return ax.f0+ax.st*clamp(i,0,s.freqs.length-1); const F=s.freqs, k=clamp(Math.round(i),0,F.length-1); return F[k]; }
  return i*s.sr/s.size;
}
function specBin(s,f){
  if(!s) return 0;
  if(!s.freqs) return f/(s.sr/s.size);
  const F=s.freqs, N=F.length, ax=specAxis(s);
  if(ax) return clamp((f-ax.f0)/ax.st,0,N-1);
  if(f<=F[0]) return 0;
  if(f>=F[N-1]) return N-1;
  let lo=0, hi=N-1;                                 // неравномерная ось — двоичный поиск
  while(hi-lo>1){ const m=(lo+hi)>>1; if(F[m]<=f) lo=m; else hi=m; }
  const d=(f-F[lo])/((F[hi]-F[lo])||1);
  return lo+d;
}

/* ---- антенна и гармоники ---- */
const C_LIGHT=299792458;
// длины в метрах: λ в свободном пространстве, λ/4, λ/2, 5/8λ; вибратор укорочен на vf (провод ~0.95)
function antennaDims(f,vf){
  vf=vf>0 ? vf : .95;
  const lam=f>0 ? C_LIGHT/f : 0;
  return {lambda:lam, quarter:lam/4*vf, half:lam/2*vf, five8:lam*5/8*vf, full:lam*vf};
}
// возможные основные частоты f/k (k=2…kmax): если сигнал на f — k-я гармоника чужого передатчика
function harmonicSources(f,kmax){
  const r=[]; if(!(f>0)) return r;
  for(let k=2;k<=(kmax|0||8);k++) r.push({k,f:f/k});
  return r;
}
// длина в метрах → "17.3 cm" / "2.51 m"
function fmtLen(m){
  if(!(m>0)) return '—';
  return m<1 ? (m*100).toFixed(m<.1?2:1)+' cm' : m.toFixed(m<10?2:1)+' m';
}
