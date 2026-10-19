"use strict";
/* ============================ Signal Analyzer: ядра ============================
   Захват → демодуляция (ASK / FSK / PSK) → шум и центр → длительность бита → нарезка символов → декодирование линейного кода →
   синхрослово, выравнивание, поля. Без DOM и движка; тест — tools/test-siglab.mjs. */

const SL_PI2=2*Math.PI;

/* ---------- базовое ---------- */
function slMag(re,im){
  const N=re.length, o=new Float32Array(N);
  if(im) for(let i=0;i<N;i++) o[i]=Math.sqrt(re[i]*re[i]+im[i]*im[i]);
  else for(let i=0;i<N;i++) o[i]=Math.abs(re[i]);
  return o;
}
// скользящее среднее, окно w (центрированное); [A,B) — только этот участок (у краёв окно усекается)
function slSmooth(x,w,out,A,B){
  const N=x.length; out=out||new Float32Array(N);
  A=A||0; B=B==null ? N : B;
  w=Math.max(1,w|0);
  if(w<=1){ if(out!==x) for(let i=A;i<B;i++) out[i]=x[i]; return out; }
  const hl=w>>1, hr=w-1-hl;
  let s=0, lo=A, hi=Math.min(B-1,A+hr);
  for(let i=A;i<=hi;i++) s+=x[i];
  for(let i=A;i<B;i++){
    out[i]=s/(hi-lo+1);
    if(i+1+hr<B){ s+=x[i+1+hr]; hi=i+1+hr; }
    if(i-hl>=A){ s-=x[i-hl]; lo=i-hl+1; }
  }
  return out;
}
// мгновенная частота, Гц; где mag ≤ thr — не считается (0)
function slFreq(re,im,sr,mag,thr){
  const N=re.length, o=new Float32Array(N), k=sr/SL_PI2;
  if(!im) return o;
  for(let i=1;i<N;i++){
    if(mag && !(mag[i]>thr)) continue;
    const cr=im[i]*re[i-1]-re[i]*im[i-1], dt=re[i]*re[i-1]+im[i]*im[i-1];
    o[i]=Math.atan2(cr,dt)*k;
  }
  if(N>1) o[0]=o[1];
  return o;
}
// не более max отсчётов из списка участков: с начала
function slBudget(segs,max){
  const o=[]; let t=0;
  for(const [a,b] of segs){
    if(t>=max) break;
    const e=Math.min(b,a+(max-t));
    o.push([a,e]); t+=e-a;
  }
  return o;
}

// минимум и максимум блоков по B отсчётов: для отрисовки больших захватов
function slPyramid(x,B){
  const N=x.length, M=Math.ceil(N/B), o=new Float32Array(2*M);
  for(let m=0;m<M;m++){
    let a=x[m*B], b=a;
    const e=Math.min(N,(m+1)*B);
    for(let i=m*B+1;i<e;i++){ const v=x[i]; if(v<a) a=v; else if(v>b) b=v; }
    o[2*m]=a; o[2*m+1]=b;
  }
  return o;
}
// выборка не более max значений из диапазона [a,b)
function slSample(x,a,b,max){
  const st=Math.max(1,Math.floor((b-a)/max)), o=new Float32Array(Math.max(0,Math.ceil((b-a)/st)));
  let k=0;
  for(let i=a;i<b;i+=st) o[k++]=x[i];
  return k<o.length ? o.subarray(0,k) : o;
}
// выборка из нескольких участков одним массивом
function slPool(x,segs,max){
  let tot=0; for(const [a,b] of segs) tot+=b-a;
  const parts=segs.map(([a,b])=>slSample(x,a,b,Math.max(16,Math.round(max*(b-a)/Math.max(tot,1)))));
  let n=0; for(const q of parts) n+=q.length;
  const o=new Float32Array(n); let k=0;
  for(const q of parts){ o.set(q,k); k+=q.length; }
  return o;
}

// комплексное БПФ на месте, n — степень двойки; inv — обратное (без деления)
function slFft(re,im,inv){
  const n=re.length;
  for(let i=1,j=0;i<n;i++){
    let bit=n>>1;
    for(;j&bit;bit>>=1) j^=bit;
    j^=bit;
    if(i<j){ let t=re[i]; re[i]=re[j]; re[j]=t; t=im[i]; im[i]=im[j]; im[j]=t; }
  }
  for(let len=2;len<=n;len<<=1){
    const a=(inv ? 2 : -2)*Math.PI/len, wr=Math.cos(a), wi=Math.sin(a), h=len>>1;
    for(let i=0;i<n;i+=len){
      let cr=1, ci=0;
      for(let k=0;k<h;k++){
        const u=i+k, v=u+h, xr=re[v]*cr-im[v]*ci, xi=re[v]*ci+im[v]*cr;
        re[v]=re[u]-xr; im[v]=im[u]-xi; re[u]+=xr; im[u]+=xi;
        const t=cr*wr-ci*wi; ci=cr*wi+ci*wr; cr=t;
      }
    }
  }
}
// вещественный сигнал → аналитический: блоки по 16384 с перекрытием, края блоков отбрасываются
function slAnalytic(x){
  const N=x.length, B=16384, O=1024, H=B-2*O, im=new Float32Array(N), re=Float32Array.from(x);
  const br=new Float64Array(B), bi=new Float64Array(B);
  for(let s=0;s<N;s+=H){
    const o=s-O;
    for(let i=0;i<B;i++){ const j=o+i; br[i]=j>=0 && j<N ? x[j] : 0; bi[i]=0; }
    slFft(br,bi,false);
    for(let i=1;i<B/2;i++){ br[i]*=2; bi[i]*=2; }
    for(let i=B/2+1;i<B;i++){ br[i]=0; bi[i]=0; }
    slFft(br,bi,true);
    for(let i=O;i<O+H && s+i-O<N;i++) im[s+i-O]=bi[i]/B;
  }
  return {re,im};
}

/* ---------- Оцу ---------- */
function slOtsu(v,bins){
  bins=bins||128;
  const n=v.length;
  if(n<2) return {thr:n?v[0]:0,eta:0,m0:0,m1:0,w0:1,sw:0,lo:0,hi:0};
  let mn=Infinity, mx=-Infinity;
  for(let i=0;i<n;i++){ const x=v[i]; if(x<mn) mn=x; if(x>mx) mx=x; }
  if(!(mx>mn)) return {thr:mn,eta:0,m0:mn,m1:mn,w0:1,sw:0,lo:mn,hi:mx};
  const h=new Float64Array(bins), k=(bins-1)/(mx-mn);
  for(let i=0;i<n;i++) h[Math.floor((v[i]-mn)*k)]++;
  let mu=0; for(let b=0;b<bins;b++) mu+=b*h[b];
  mu/=n;
  let tv=0; for(let b=0;b<bins;b++) tv+=h[b]*(b-mu)*(b-mu);
  tv/=n;
  let best=-1, bt=0, c0=0, s0=0;
  for(let t=0;t<bins-1;t++){
    c0+=h[t]; s0+=t*h[t];
    const c1=n-c0;
    if(c0<1 || c1<1) continue;
    const m0=s0/c0, m1=(mu*n-s0)/c1, sb=c0*c1/(n*n)*(m1-m0)*(m1-m0);
    if(sb>best){ best=sb; bt=t; }
  }
  let c=0, s=0, q=0;
  for(let b=0;b<=bt;b++){ c+=h[b]; s+=b*h[b]; }
  const m0b=c ? s/c : 0, c1=n-c, m1b=c1 ? (mu*n-s)/c1 : 0;
  for(let b=0;b<bins;b++){ const m=b<=bt ? m0b : m1b; q+=h[b]*(b-m)*(b-m); }
  const unit=1/k;
  return {thr:mn+(bt+1)*unit, eta:tv>0 ? best/tv : 0, m0:mn+(m0b+.5)*unit, m1:mn+(m1b+.5)*unit, w0:c/n, sw:Math.sqrt(q/n)*unit, lo:mn, hi:mx};
}

/* ---------- шум: порог между шумовой полкой и сигналом ---------- */
function slNoise(mag){
  const v=slSample(mag,0,mag.length,40000);
  let mx=0; for(let i=0;i<v.length;i++) if(v[i]>mx) mx=v[i];
  if(!(mx>1e-9)) return {noise:Infinity,lo:0,hi:0,gated:false,eta:0};
  const top=v.slice().sort()[Math.floor(v.length*.995)]||mx;
  for(let i=0;i<v.length;i++) if(v[i]>top) v[i]=top;
  const o=slOtsu(v,200);
  const gated=o.eta>.45 && o.w0>.02 && o.w0<.995 && o.m1>2.5*Math.max(o.m0,1e-9*mx);
  return {noise:gated ? o.m0+.35*(o.m1-o.m0) : 0, lo:o.m0, hi:o.m1, gated, eta:o.eta};
}

/* ---------- сообщения: участки выше шума ---------- */
function slSegments(mag,noise,gap,minLen){
  const N=mag.length, out=[];
  if(!(noise>0)) return noise===Infinity ? [] : N>=minLen ? [[0,N]] : [];
  let a=-1, last=-1;
  for(let i=0;i<N;i++){
    if(mag[i]>noise){
      if(a<0) a=i;
      else if(i-last>gap+1){ if(last+1-a>=minLen) out.push([a,last+1]); a=i; }
      last=i;
    }
  }
  if(a>=0 && last+1-a>=minLen) out.push([a,last+1]);
  return out;
}

/* ---------- модуляция PSK: несущая и фаза по M-й степени, на сообщение ---------- */
function slPsk(re,im,a,b,M,out){
  const n=b-a;
  if(n<8 || !im){ for(let i=a;i<b;i++) out[i]=0; return; }
  const pr=new Float64Array(n), pi=new Float64Array(n);
  for(let i=0;i<n;i++){
    let xr=re[a+i], xi=im[a+i];
    const m=Math.hypot(xr,xi)||1; xr/=m; xi/=m;
    let yr=xr, yi=xi;
    for(let k=1;k<M;k++){ const t=yr*xr-yi*xi; yi=yr*xi+yi*xr; yr=t; }
    pr[i]=yr; pi[i]=yi;
  }
  let sr=0, si=0;
  for(let i=1;i<n;i++){ sr+=pr[i]*pr[i-1]+pi[i]*pi[i-1]; si+=pi[i]*pr[i-1]-pr[i]*pi[i-1]; }
  const w=Math.atan2(si,sr)/M;                       // отсчёты → рад/отсчёт
  let ar=0, ai=0;
  for(let i=0;i<n;i++){ const c=Math.cos(-w*M*i), s=Math.sin(-w*M*i); ar+=pr[i]*c-pi[i]*s; ai+=pr[i]*s+pi[i]*c; }
  const psi=Math.atan2(ai,ar)/M + (M===4 ? Math.PI/4 : 0);
  for(let i=0;i<n;i++){
    const ph=Math.atan2(im[a+i],re[a+i])-w*i-psi;
    out[a+i]=M===2 ? Math.cos(ph) : Math.atan2(Math.sin(ph),Math.cos(ph))/Math.PI;
  }
}

/* ---------- серии выше/ниже порога ---------- */
// runs — длины серий внутри [a,b) (первая неполная отбрасывается),
// ints — расстояния между фронтами одного знака: кратны символу и не зависят от порога
function slRuns(d,a,b,thr,hy,runs,ints){
  let s=d[a]>thr, st=a, first=true, lr=-1, lf=-1;
  for(let i=a+1;i<b;i++){
    const v=d[i];
    if((!s && v>thr+hy) || (s && v<thr-hy)){
      if(!first) runs.push(i-st);
      first=false; st=i; s=!s;
      if(ints){
        if(s){ if(lr>=0) ints.push(i-lr); lr=i; }
        else { if(lf>=0) ints.push(i-lf); lf=i; }
      }
    }
  }
  return runs;
}

/* ---------- длительность бита ---------- */
// пики гистограммы длин в логарифмическом масштабе
function slPeaks(R,minT){
  const q=Math.log(1.06), nb=Math.ceil(Math.log(R[R.length-1]/minT)/q)+3, h=new Float64Array(nb);
  for(const r of R) h[Math.floor(Math.log(r/minT)/q)+1]++;
  const sm=new Float64Array(nb);
  for(let i=0;i<nb;i++) sm[i]=(h[i-1]||0)+2*h[i]+(h[i+1]||0);
  const need=Math.max(2,R.length*.03)*4, peaks=[];
  for(let i=1;i<nb-1;i++) if(sm[i]>=need && sm[i]>=sm[i-1] && sm[i]>sm[i+1]){
    const lo=minT*Math.exp((i-1)*q), hi=minT*Math.exp((i+2)*q);
    let s=0, c=0; for(const r of R) if(r>=lo/1.04 && r<=hi*1.04){ s+=r; c++; }
    if(c) peaks.push({t:s/c,n:c});
  }
  return peaks;
}
const slFit=(R,T,tol0)=>{
  let ok=0;
  for(const r of R){ const k=Math.max(1,Math.round(r/T)), e=Math.abs(r-k*T)/T; if(e<=tol0+.015*Math.min(k,8)) ok++; }
  return R.length ? ok/R.length : 0;
};
function slBitLen(runs,ints,minT,jit){
  jit=jit||0;
  const A=Float64Array.from(runs.filter(r=>r>=minT)).sort();
  let B=Float64Array.from((ints||[]).filter(r=>r>=minT)).sort();
  if(A.length<4) return null;
  const pA=slPeaks(A,minT);
  if(!pA.length) return null;
  const pmin=Math.min(...pA.map(p=>p.t));
  const thin=x=>{ if(x.length<=1500) return x; const st=x.length/1500, o=[]; for(let i=0;i<1500;i++) o.push(x[Math.floor(i*st)]); return o; };
  const AA=thin(Array.from(A).filter(r=>r<=24*pmin));
  B=thin(Array.from(B).filter(r=>r<=48*pmin));
  const useB=B.length>=4, pB=useB ? slPeaks(B,minT) : [];
  const cand=[];
  for(const p of pA) for(let k=1;k<=4;k++) if(p.t/k>=minT) cand.push(p.t/k);
  for(const p of pB) for(let k=1;k<=6;k++) if(p.t/k>=minT) cand.push(p.t/k);
  if(AA.length<4) return null;
  cand.sort((x,y)=>x-y);
  for(let i=cand.length-1;i>0;i--) if(cand[i]<cand[i-1]*1.03) cand.splice(i,1);
  let bA=0, bB=0;
  const sc=cand.map(T=>{ const fa=slFit(AA,T,.38+jit), fb=useB ? slFit(B,T,.2+jit) : 1; if(fa>bA) bA=fa; if(fb>bB) bB=fb; return {T,fa,fb}; });
  const okc=sc.filter(c=>c.fa>=Math.max(.6,bA-.1) && c.fb>=Math.max(.75,bB-.06));
  if(!okc.length) return null;
  let T=Math.max(...okc.map(c=>c.T));
  const RR=useB ? B : AA;
  for(let it=0;it<4;it++){
    let a=0, b=0;
    for(const r of RR){ const k=Math.max(1,Math.round(r/T)), e=Math.abs(r-k*T)/T; if(e<=.35+jit){ a+=r*k; b+=k*k; } }
    if(b) T=a/b;
  }
  return {T, conf:useB ? Math.min(slFit(B,T,.2+jit),1) : slFit(AA,T,.2+jit), peaks:pA};
}

/* ---------- нарезка символов ---------- */
// d — демодулированный сигнал, [a,b) — сообщение, T — длина символа в отсчётах, thr — порог для фронтов
function slSlice(d,a,b,T,thr,hy,step){
  const E=[];
  let s=d[a]>thr;
  if(step>0) E.push(...slSlopeEdges(d,a,b,T,step));
  else for(let i=a+1;i<b;i++){
    const v=d[i];
    if((!s && v>thr+hy) || (s && v<thr-hy)){
      let j=i;
      if(!s) while(j>a+1 && d[j-1]>thr) j--; else while(j>a+1 && d[j-1]<thr) j--;
      const p=d[j-1], q=d[j];
      E.push(j-1+(q!==p ? (thr-p)/(q-p) : 0));
      s=!s;
    }
  }
  // начальная фаза решётки — круговое среднее фронтов
  let cs=0, sn=0;
  for(let i=0;i<Math.min(E.length,64);i++){ const f=((E[i]-a)/T)*SL_PI2; cs+=Math.cos(f); sn+=Math.sin(f); }
  const phi=E.length ? Math.atan2(sn,cs)/SL_PI2 : 0;
  let bd=a+phi*T;
  if(bd<a-.5*T) bd+=T;
  const bnd=[], vals=[];
  let ei=0;
  while(bd+.35*T<=b){
    while(ei<E.length && E[ei]<bd-.3*T) ei++;
    if(ei<E.length && E[ei]<=bd+.3*T){ bd+=(bnd.length<8 ? .5 : .15)*(E[ei]-bd); ei++; }
    bnd.push(bd);
    let i0=Math.ceil(bd+.3*T), i1=Math.floor(bd+.7*T);
    i0=Math.max(a,Math.min(i0,b-1)); i1=Math.max(i0,Math.min(i1,b-1));
    let sm=0; for(let i=i0;i<=i1;i++) sm+=d[i];
    vals.push(sm/(i1-i0+1));
    bd+=T;
  }
  bnd.push(bd);
  return {bnd:Float64Array.from(bnd), vals:Float32Array.from(vals), edges:E};
}

// период по фронтам: каждому присваивается целое число символов от первого, наклон прямой — период
function slLatticeT(lists,T){
  const chains=[];
  const add=E=>{
    if(E.length<4) return;
    const K=[0];
    for(let j=1;j<E.length;j++) K.push(K[j-1]+Math.max(1,Math.round((E[j]-E[j-1])/T)));
    chains.push({E,K});
  };
  for(const E0 of lists){
    let cur=[];
    for(const e of E0){
      if(cur.length){
        const d=e-cur[cur.length-1];
        if(d<.6*T) continue;                       // всплески внутри символа не в счёт
        if(d>6*T){ add(cur); cur=[]; }            // слишком длинная серия: число символов не определить
      }
      cur.push(e);
    }
    add(cur);
  }
  const fit=keep=>{
    let sxy=0, sxx=0, n=0;
    for(const c of chains){
      const idx=[]; for(let j=0;j<c.E.length;j++) if(!keep || keep(c,j)) idx.push(j);
      if(idx.length<3) continue;
      let mk=0, me=0; for(const j of idx){ mk+=c.K[j]; me+=c.E[j]; }
      mk/=idx.length; me/=idx.length;
      for(const j of idx){ sxy+=(c.K[j]-mk)*(c.E[j]-me); sxx+=(c.K[j]-mk)*(c.K[j]-mk); }
      n+=idx.length;
    }
    return n>=8 && sxx>0 ? sxy/sxx : 0;
  };
  let t=fit(null);
  for(let it=0;it<2 && t;it++){                      // выбросы (лишние фронты) отбрасываются по невязке
    for(const c of chains){
      let mk=0, me=0; for(let j=0;j<c.E.length;j++){ mk+=c.K[j]; me+=c.E[j]; }
      mk/=c.E.length; me/=c.E.length;
      c.r=c.E.map((e,j)=>e-(me+(c.K[j]-mk)*t));
    }
    const t2=fit((c,j)=>Math.abs(c.r[j])<.25*T);
    if(!t2) break;
    t=t2;
  }
  return t;
}

// фронты многоуровневого сигнала: максимумы крутизны (переходы между любыми уровнями), step — минимальный шаг между уровнями
function slSlopeEdges(d,a,b,T,step){
  const h=Math.max(1,Math.round(T/3)), lim=.5*step, E=[], W=Math.max(2,Math.round(T*1.5));
  const g=i=>Math.abs(d[i+h]-d[i-h]);
  let i=a+h;
  while(i<b-h){
    if(g(i)<lim){ i++; continue; }
    let j=i, bv=0;
    while(j<b-h && g(j)>=lim && j-i<W){ const v=g(j); if(v>bv) bv=v; j++; }
    let s=0, c=0;
    for(let k=i;k<j;k++) if(g(k)>=.85*bv){ s+=k; c++; }
    const e=s/c, n=E.length;
    if(n && e-E[n-1]<.5*T) E[n-1]=(E[n-1]+e)/2; else E.push(e);       // широкий переход режется на куски — склеиваем
    i=j+1;
  }
  return E;
}

// k-средних по одной оси: L центров, порог — середины
function slLevels(v,L){
  const s=Float32Array.from(v).sort(), n=s.length;
  if(n<L) return null;
  let c=[]; for(let k=0;k<L;k++) c.push(s[Math.min(n-1,Math.floor(n*(k+.5)/L))]);
  for(let it=0;it<30;it++){
    const sum=new Float64Array(L), cnt=new Float64Array(L);
    for(const x of s){ let k=0; while(k<L-1 && x>(c[k]+c[k+1])/2) k++; sum[k]+=x; cnt[k]++; }
    let ch=0;
    for(let k=0;k<L;k++) if(cnt[k]){ const m=sum[k]/cnt[k]; ch+=Math.abs(m-c[k]); c[k]=m; }
    if(ch<1e-9*(s[n-1]-s[0]+1e-30)) break;
  }
  c.sort((x,y)=>x-y);
  return {centers:c, thr:c.slice(1).map((x,k)=>(x+c[k])/2)};
}

/* ---------- символы → биты, линейные коды ---------- */
const SL_GRAY=[0,1,3,2,6,7,5,4];
function slSymBits(sym,L,gray){
  if(L<=2) return Uint8Array.from(sym);
  const bps=Math.round(Math.log2(L)), o=new Uint8Array(sym.length*bps);
  for(let i=0;i<sym.length;i++){
    const v=gray ? SL_GRAY[sym[i]]??sym[i] : sym[i];
    for(let k=0;k<bps;k++) o[i*bps+k]=(v>>(bps-1-k))&1;
  }
  return o;
}
const SL_CODES=['NRZ','NRZ-M (change = 1)','NRZ-S (change = 0)','Manchester (01 = 1)','Manchester (10 = 1)','Differential Manchester'];
// → {bits, src:{start,step}, err}: бит k получен из сырых бит src.start + k·src.step
function slDecode(raw,code,inv){
  const N=raw.length, b=inv ? raw.map(x=>x^1) : raw;
  const c=SL_CODES.indexOf(code);
  if(c<=0) return {bits:b,src:{start:0,step:1},err:0};
  if(c===1 || c===2){
    const o=new Uint8Array(Math.max(0,N-1));
    for(let i=1;i<N;i++){ const ch=b[i]^b[i-1]; o[i-1]=c===1 ? ch : ch^1; }
    return {bits:o,src:{start:1,step:1},err:0};
  }
  let best=null;
  for(let ph=0;ph<2;ph++){
    const M=(N-ph)>>1, o=new Uint8Array(M);
    let err=0, prev=-1;
    for(let k=0;k<M;k++){
      const x=b[ph+2*k], y=b[ph+2*k+1];
      if(c===3 || c===4){
        if(x===y){ err++; o[k]=y; }
        else o[k]=c===3 ? y : x;
      } else {
        if(x===y) err++;
        o[k]=prev<0 ? 0 : (x!==prev ? 0 : 1);
        prev=y;
      }
    }
    if(!best || err<best.err) best={bits:o,src:{start:ph,step:2},err};
  }
  return best;
}

// Манчестер по сырым битам: серии не длиннее двух и пары 01 / 10 в одной фазе почти везде
function slDetectCode(raws){
  let ok=0, tot=0;
  for(const b of raws){
    if(b.length<48) continue;
    tot++;
    let best=1;
    for(let ph=0;ph<2;ph++){
      let bad=0, pairs=0;
      for(let i=ph;i+1<b.length;i+=2){ pairs++; if(b[i]===b[i+1]) bad++; }
      best=Math.min(best,bad/Math.max(pairs,1));
    }
    let run=1, mx=1;
    for(let i=1;i<b.length;i++){ if(b[i]===b[i-1]){ run++; if(run>mx) mx=run; } else run=1; }
    if(best<.03 && mx<=2) ok++;
  }
  return tot>=1 && ok>=Math.ceil(tot*.7) ? SL_CODES[3] : SL_CODES[0];
}

/* ---------- форматы ---------- */
function slHexByte(bits,i,lsb){
  let v=0;
  for(let k=0;k<8;k++){ const x=i+k<bits.length ? bits[i+k] : 0; v=lsb ? v|(x<<k) : (v<<1)|x; }
  return v;
}
const slBytes=(bits,from,to,lsb)=>{
  const o=[]; for(let i=from;i<to;i+=8) o.push(slHexByte(bits,i,lsb));
  return o;
};
const slBin=(bits,from,to)=>{ let s=''; for(let i=from;i<to;i++) s+=bits[i]; return s; };
const slHex=(bits,from,to,lsb)=>slBytes(bits,from,to,lsb).map(v=>(v<16?'0':'')+v.toString(16)).join('').toUpperCase();
const slAscii=(bits,from,to,lsb)=>slBytes(bits,from,to,lsb).map(v=>v>=32&&v<127 ? String.fromCharCode(v) : '.').join('');
// значение поля: до 32 бит — число, дальше строка hex
function slField(bits,from,len,lsb){
  const to=Math.min(bits.length,from+len);
  if(to<=from) return null;
  if(to-from>32) return slHex(bits,from,to,lsb);
  let v=0;
  if(lsb) for(let i=to-1;i>=from;i--) v=v*2+bits[i];
  else for(let i=from;i<to;i++) v=v*2+bits[i];
  return v;
}

/* ---------- синхрослово, выравнивание ---------- */
// преамбула — чередующиеся биты в начале; синхрослово — общее начало сообщений после неё
function slSyncGuess(list,opt){
  opt=opt||{};
  const M=list.filter(b=>b.length>=16);
  if(M.length<2) return null;
  const pre=M.map(b=>{ let k=1; while(k<b.length && b[k]!==b[k-1]) k++; return k>=8 ? k : 0; });
  const need=Math.max(2,Math.ceil(M.length*.7)), maxL=opt.maxLen||48, minL=opt.minLen||8;
  for(let L=maxL;L>=minL;L--){
    const cnt=new Map();
    M.forEach((b,i)=>{
      if(pre[i]+L>b.length) return;
      let s=''; for(let k=0;k<L;k++) s+=b[pre[i]+k];
      cnt.set(s,(cnt.get(s)||0)+1);
    });
    let top=null; for(const [s,c] of cnt) if(!top || c>top.c) top={s,c};
    if(top && top.c>=need){
      let w=Uint8Array.from(top.s,ch=>+ch), len=L;
      const pl=pre.filter(x=>x).sort((x,y)=>x-y), rs=pl.map(x=>x%8);
      let pm=pl.length ? pl[pl.length>>1] : 0;
      // слово могло начаться с чередующихся бит и «уйти» в преамбулу: если преамбулы кончаются не на границе байта, вернуть их слову
      if(rs.length && rs[0]>0 && rs.every(x=>x===rs[0])){
        const r=rs[0], ext=new Uint8Array(r);
        for(let j=r-1;j>=0;j--) ext[j]=(r-1-j)%2===0 ? w[0] : 1-w[0];
        const w2=new Uint8Array(r+w.length); w2.set(ext); w2.set(w,r);
        w=w2; len+=r; pm-=r;
      }
      return {word:w, len, hex:slHex(w,0,len), pre:pm, count:top.c};
    }
  }
  const pl=pre.filter(x=>x).sort((x,y)=>x-y);
  return pl.length>=Math.ceil(M.length*.7) ? {word:new Uint8Array(0),len:0,hex:'',pre:pl[pl.length>>1],count:pl.length} : null;
}
// смещение начала слова в каждом сообщении (по первым max битам), допуск tol ошибок
function slAlign(list,word,tol,max){
  const W=word.length;
  return list.map(b=>{
    if(!W) return {off:0,hit:false};
    let best=-1, be=W+1;
    const lim=Math.min(b.length-W,max||192);
    for(let o=0;o<=lim;o++){
      let e=0; for(let k=0;k<W && e<=tol;k++) if(b[o+k]!==word[k]) e++;
      if(e<be){ be=e; best=o; if(!e) break; }
    }
    return be<=tol ? {off:best,hit:true,err:be} : {off:0,hit:false};
  });
}

/* ---------- определение модуляции ---------- */
// FSK — частота «сильных» отсчётов двугорбая; PSK — несущая внутри включений не когерентна (фаза прыгает); иначе ASK
function slDetectMod(re,im,sr,cache){
  if(!im) return 'ASK';
  const N=re.length, c=cache||{};
  if(!c.mag0) c.mag0=slMag(re,im);
  if(!c.smag) c.smag=slSmooth(c.mag0,3);
  const sm=c.smag, nz=c.nz||(c.nz=slNoise(sm));
  const lvl=nz.gated ? nz.lo+.6*(nz.hi-nz.lo) : .6*(nz.hi||0);
  let cnt=0; for(let i=2;i<N-1;i++) if(sm[i]>lvl) cnt++;
  if(cnt<64) return 'ASK';
  const st=Math.max(1,Math.floor(cnt/40000)), f=new Float32Array(Math.ceil(cnt/st)+1), k=sr/SL_PI2;
  const fi=i=>Math.atan2(im[i]*re[i-1]-re[i]*im[i-1],re[i]*re[i-1]+im[i]*im[i-1]);
  let nf=0;
  for(let i=2,j=0;i<N-1;i++) if(sm[i]>lvl){ if(j%st===0) f[nf++]=(fi(i-1)+fi(i)+fi(i+1))/3*k; j++; }
  const fsm=f.subarray(0,nf);
  let mu=0; for(let i=0;i<nf;i++) mu+=fsm[i]; mu/=nf;
  let m2=0, m4=0; for(let i=0;i<nf;i++){ const d=fsm[i]-mu, d2=d*d; m2+=d2; m4+=d2*d2; }
  m2/=nf; m4/=nf;
  const kurt=m2>0 ? m4/(m2*m2) : 3, o=slOtsu(fsm,128), sep=o.sw>0 ? (o.m1-o.m0)/o.sw : 0;
  if(Math.min(o.w0,1-o.w0)>=.08 && ((sep>=3 && kurt<2.8) || kurt<2)) return 'FSK';
  // когерентность несущей по включённым участкам: чистая несущая (OOK) ≈ 1, фазовая манипуляция — заметно меньше
  let num=0, den=0, i=0;
  while(i<N){
    if(!(sm[i]>lvl)){ i++; continue; }
    let j=i; while(j<N && sm[j]>lvl*.9) j++;
    if(j-i>=32){
      let sr_=0, si_=0;
      for(let k=i+1;k<j;k++){ sr_+=re[k]*re[k-1]+im[k]*im[k-1]; si_+=im[k]*re[k-1]-re[k]*im[k-1]; }
      const w=Math.atan2(si_,sr_);
      let cr=0, ci=0, am=0, pr=1, pi_=0;
      const dc=Math.cos(-w), ds=Math.sin(-w);
      for(let k=i;k<j;k++){
        cr+=re[k]*pr-im[k]*pi_; ci+=re[k]*pi_+im[k]*pr; am+=Math.sqrt(re[k]*re[k]+im[k]*im[k]);
        const t=pr*dc-pi_*ds; pi_=pr*ds+pi_*dc; pr=t;
      }
      num+=Math.hypot(cr,ci); den+=am;
    }
    i=j;
  }
  return den>0 && num/den<.6 ? 'PSK' : 'ASK';
}

// порог паузы между сообщениями: самый большой скачок между внутренними провалами и паузами, иначе 12 символов
function slAutoGap(mag,noise,T){
  const sg=slSegments(mag,noise,0,1);
  if(sg.length<3) return 12*T;
  const g=[]; for(let i=1;i<sg.length;i++) g.push(sg[i][0]-sg[i-1][1]);
  g.sort((x,y)=>x-y);
  let best=0, bt=12*T;
  for(let i=0;i+1<g.length;i++){
    const lo=Math.max(g[i],T), hi=g[i+1];
    if(hi>=6*T && hi/lo>=3 && hi/lo>best){ best=hi/lo; bt=Math.sqrt(lo*hi); }
  }
  return bt;
}

/* ---------- непрерывный поток: разрезать по синхрословам ---------- */
// самое регулярно повторяющееся слово из L бит: не короткого периода, повторы на одном расстоянии
function slFindRepeat(b,L){
  const n=b.length;
  if(n<L*6) return null;
  const pos=new Map();
  let v=0;
  for(let i=0;i<n;i++){
    v=((v<<1)|b[i])>>>0;
    if(i>=L-1){ const o=i-L+1; const l=pos.get(v); if(l) l.push(o); else pos.set(v,[o]); }
  }
  let best=null;
  for(const [w,list] of pos){
    if(list.length<3) continue;
    let ones=0; for(let k=0;k<L;k++) ones+=(w>>>k)&1;
    if(ones<L*.25 || ones>L*.75) continue;
    let per=false;
    for(const p of [1,2,3,4,8]) if(((w^(w>>>p))&(L===32 ? 0xFFFFFFFF>>>p : ((1<<(L-p))-1)))===0) per=true;
    if(per) continue;
    const q=[list[0]];
    for(const o of list) if(o>=q[q.length-1]+L) q.push(o);
    if(q.length<3) continue;
    const d=[]; for(let i=1;i<q.length;i++) d.push(q[i]-q[i-1]);
    const med=d.slice().sort((x,y)=>x-y)[d.length>>1];
    const reg=d.filter(x=>Math.abs(x-med)<=Math.max(2,med*.02)).length/d.length;
    if(reg<.6) continue;
    const score=q.length*reg;
    if(!best || score>best.score) best={score,w,q,period:med};
  }
  if(!best) return null;
  const word=new Uint8Array(L); for(let k=0;k<L;k++) word[k]=(best.w>>>(L-1-k))&1;
  return {word,pos:best.q,period:best.period};
}
// сообщение → кадры, начинающиеся (с преамбулой) на каждом вхождении слова
function slSplitMsg(m,word,tol,ctx){
  const b=m.bits, W=word.length, hits=[];
  for(let o=0;o+W<=b.length;o++){
    let e=0; for(let k=0;k<W && e<=tol;k++) if(b[o+k]!==word[k]) e++;
    if(e<=tol){ hits.push(o); o+=W-1; }
  }
  if(hits.length<2) return [m];
  const cuts=hits.map(h=>{ let k=h; while(k>0 && h-k<64 && b[k-1]!==b[k]) k--; return h-Math.floor((h-k)/8)*8; });      // преамбула — целые байты
  cuts[0]=0;
  for(let i=1;i<cuts.length;i++) if(cuts[i]<=cuts[i-1]) cuts[i]=hits[i];
  const bps=ctx.L>2 ? 2 : 1, out=[];
  for(let i=0;i<cuts.length;i++){
    const e=i+1<cuts.length ? cuts[i+1] : b.length;
    let s0=Math.floor((m.src.start+cuts[i]*m.src.step)/bps), s1=i+1<cuts.length ? Math.floor((m.src.start+e*m.src.step)/bps) : m.n;
    s0=Math.max(0,s0); s1=Math.min(m.n,s1);
    if(s1-s0<ctx.minB) continue;
    const sym=m.sym.slice(s0,s1), raw=slSymBits(sym,ctx.L,ctx.gray), dec=slDecode(raw,ctx.code,ctx.inv);
    const bnd=m.bnd.slice(s0,s1+1), a=Math.round(bnd[0]), bb=Math.round(bnd[bnd.length-1]);
    out.push({...m,a,b:bb,t:a/ctx.sr,dur:(bb-a)/ctx.sr,n:s1-s0,sym,vals:m.vals.slice(s0,s1),bnd,raw,bits:dec.bits,src:dec.src,err:dec.err});
  }
  return out.length ? out : [m];
}

/* ---------- полный разбор ---------- */
/* cfg: mod ('auto'|'ASK'|'FSK'|'PSK'), levels 2|4, gray, code, inv, pause (бит), minBits,
        noise, center, baud (0 — искать) — ручные значения; auto — искать шум и центр сами */
function slAnalyze(re,im,sr,cfg){
  const N=re.length;
  const R={sr,N,mod:'ASK',noise:0,center:0,T:0,baud:0,conf:0,msgs:[],mag:null,dem:null,segs:[],sync:null,gated:false,lo:0,hi:0,err:''};
  if(N<64){ R.err='too few samples'; return R; }
  const L=cfg.levels===4 ? 4 : 2, auto=cfg.auto!==false;
  if(!im && cfg.mod!=='ASK' && cfg.mod!=='raw'){ const z=slAnalytic(re); re=z.re; im=z.im; }      // звук (AFSK, фазовая манипуляция): аналитический сигнал
  const cache={};
  const mod=cfg.mod==='auto' || !cfg.mod ? slDetectMod(re,im,sr,cache) : cfg.mod;
  R.mod=mod;
  if(!im && mod!=='ASK' && mod!=='raw'){ R.err=mod+' needs an iq input'; }
  const mag0=cache.mag0||slMag(re,im), ew=mod==='raw' ? Math.max(3,Math.round(sr*.0008)) : 3, smag=mod==='raw' ? slSmooth(mag0,ew) : cache.smag||slSmooth(mag0,3);
  if(mod==='raw') cache.nz=null;
  const nz=cache.nz||slNoise(smag);
  const noise=auto || !(cfg.noise>0) ? nz.noise : cfg.noise;
  R.noise=noise; R.gated=nz.gated; R.lo=nz.lo; R.hi=nz.hi;
  let dem=null;
  const fraw=mod==='FSK' && im ? slFreq(re,im,sr,smag,noise>0 && isFinite(noise) ? .5*noise : 0) : null;
  const M=L===4 ? 4 : 2;
  const makeDem=(segs,w)=>{
    if(mod==='ASK') return slSmooth(mag0,w);
    if(mod==='raw') return slSmooth(re,w);
    if(mod==='FSK') return slSmooth(fraw||new Float32Array(N),w);
    const d=new Float32Array(N);
    for(const [a,b] of segs) slPsk(re,im,a,b,M,d);
    return w>1 ? slSmooth(d,w) : d;
  };
  // 1. предварительные сообщения и бит: окно сглаживания растёт, пока оценка не перестанет быть шумовой
  let T=cfg.baud>0 ? sr/cfg.baud : 0;
  let scratch=null;
  const estimate=(raw,segs0,w)=>{
    const d=scratch||(scratch=new Float32Array(N));
    for(const [a,b] of segs0) slSmooth(raw,w,d,a,b);
    const pool=slPool(d,segs0,20000), o=slOtsu(pool,128);
    let c=o.thr;
    if(!auto && cfg.center!=null && cfg.center!==0) c=cfg.center;
    const hy=.06*Math.max(o.m1-o.m0,1e-12), runs=[], ints=[];
    for(const [a,b] of segs0) if(b-a>8) slRuns(d,a,b,c,hy,runs,ints);
    let bl=slBitLen(runs,ints,2,0);
    if((!bl || bl.conf<.8) && L>2 && mod!=='PSK') bl=slBitLen(runs,ints,2,.12)||bl;     // уровни рядом: фронты плывут
    return {bl,center:c};
  };
  // длительность символа по участкам сигнала raw: окно сглаживания растёт, пока оценка не перестанет быть шумовой
  const findT=(raw,segs0)=>{
    let tot=0; for(const [a,b] of segs0) tot=Math.max(tot,b-a);
    let best=null, fall=null;
    for(const w of [3,8,20,50,120,300,800]){
      if(w*6>tot || (best && w>.8*best.bl.T)) break;
      const e=estimate(raw,segs0,w);
      if(!e.bl) continue;
      if(e.bl.T>=2*w && (!fall || e.bl.conf>fall.bl.conf+.05)) fall=e;
      if(e.bl.T>=2.5*w && e.bl.conf>=.8 && (!best || e.bl.T>best.bl.T)) best=e;
    }
    if(!best) best=fall;
    if(!best) return null;
    let Tm=best.bl.T, conf=best.bl.conf;
    const e2=estimate(raw,segs0,Math.max(1,Math.round(Tm/4)));      // повторный проход с окном по символу
    if(e2.bl && Math.abs(e2.bl.T/Tm-1)<.3 && e2.bl.conf>=conf-.05){ Tm=e2.bl.T; conf=e2.bl.conf; }
    return {T:Tm,conf,center:best.center};
  };
  if(!T){
    const segs0=slBudget(mod==='ASK' ? (nz.gated || noise>0 ? slSegments(smag,noise,Math.round(sr*.0005)+8,16) : [[0,N]]) : slSegments(smag,noise,8,16),300000);
    let raw;
    if(mod==='ASK') raw=mag0;
    else if(mod==='raw') raw=re;
    else if(mod==='FSK') raw=fraw||new Float32Array(N);
    else { raw=new Float32Array(N); for(const [a,b] of segs0) slPsk(re,im,a,b,M,raw); }
    const f=findT(raw,segs0);
    if(!f){ R.err='no bit length found'; R.mag=smag; R.dem=slSmooth(raw,3); R.center=0; R.segs=segs0; return R; }
    T=f.T; R.conf=f.conf;
  } else R.conf=1;
  R.T=T; R.baud=sr/T;
  // 2. окончательные сообщения
  const w=Math.max(1,Math.round(T/4));
  const magW=slSmooth(mag0,mod==='raw' ? Math.max(w,ew) : w);
  const gap=Math.round(cfg.pause>0 ? cfg.pause*T : slAutoGap(magW,noise,T)), minLen=Math.max(2,cfg.minBits||8)*T;
  R.gap=gap/T;
  const segs=slSegments(magW,noise,gap,minLen);
  dem=makeDem(segs,w);
  R.mag=magW; R.dem=dem; R.segs=segs;
  // 3. уровни: общие пороги для L>2
  let thrs=null;
  const pool=slPool(dem,segs,30000);
  if(L>2 && pool.length){
    const lv=slLevels(pool,L);
    if(lv){ thrs=lv.thr; R.centers=lv.centers; }
  }
  const g=slOtsu(pool,128);
  const gc=!auto && cfg.center!=null && cfg.center!==0 ? cfg.center : (L>2 && thrs ? thrs[L/2-1] : g.thr);
  R.center=gc; R.thrs=thrs;
  const span=Math.max(g.m1-g.m0,1e-12);
  // 4. нарезка; период символа уточняется по границам, найденным петлёй фазы
  const gray=!!cfg.gray, inv=!!cfg.inv, minB=Math.max(2,cfg.minBits||8);
  let code=cfg.code||'auto';
  let stepMin=0;
  if(L>2 && mod!=='PSK' && R.centers){ stepMin=Infinity; for(let k=1;k<R.centers.length;k++) stepMin=Math.min(stepMin,R.centers[k]-R.centers[k-1]); }
  // сообщения других протоколов (свой символ): свой период, если он надёжно найден и заметно отличается от общего
  let Ts=null;
  if(cfg.perMsg!==false && !(cfg.baud>0) && segs.length>1){
    const praw=mod==='PSK' ? new Float32Array(N) : null;
    Ts=segs.map(([a,b])=>{
      let raw;
      if(mod==='ASK') raw=mag0;
      else if(mod==='raw') raw=re;
      else if(mod==='FSK') raw=fraw||new Float32Array(N);
      else { slPsk(re,im,a,b,M,praw); raw=praw; }
      const f=findT(raw,[[a,b]]);
      if(!f || f.conf<.8 || Math.abs(f.T/T-1)<=.1) return 0;
      slSmooth(raw,Math.max(1,Math.round(f.T/4)),dem,a,b);
      return f.T;
    });
    if(!Ts.some(x=>x)) Ts=null;
  }
  const cut=Tc=>{
    const out=[];
    for(const [si,[a,b]] of segs.entries()){
      const Tm=Ts && Ts[si] ? Ts[si] : Tc;
      let thr=gc;
      if(L===2 && auto){
        const lo=slOtsu(slSample(dem,a,b,20000),128);
        if(lo.eta>.5 && lo.m1-lo.m0>.5*span) thr=lo.thr;
      }
      let sl=slSlice(dem,a,b,Tm,thr,.06*span,stepMin), Tu=Tm;
      if(Ts && Ts[si]){ const T2=slLatticeT([sl.edges],Tm); if(T2 && Math.abs(T2/Tm-1)<.15 && Math.abs(T2/Tm-1)>.0005){ Tu=T2; sl=slSlice(dem,a,b,Tu,thr,.06*span,stepMin); } }
      if(sl.vals.length<minB) continue;
      out.push({a,b,thr,sl,T:Tu});
    }
    return out;
  };
  let cuts=cut(T);
  if(!(cfg.baud>0) && !Ts) for(let it=0;it<5 && cuts.length;it++){
    const T2=slLatticeT(cuts.map(c=>c.sl.edges),T);
    if(!T2) break;
    const dT=Math.abs(T2/T-1);
    if(dT<.0005 || dT>.15) break;
    T=T2; R.T=T; R.baud=sr/T; cuts=cut(T);
  }
  if(L>2 && cuts.length){                          // пороги уточняются по значениям в центрах символов: на переходах уровни «сползают»
    const pv=[]; for(const c of cuts) for(const v of c.sl.vals) pv.push(v);
    const lv=slLevels(pv,L);
    if(lv){ thrs=lv.thr; R.thrs=thrs; R.centers=lv.centers; R.center=thrs[L/2-1]; }
  }
  const prep=cuts.map(({a,b,thr,sl,T:Tm})=>{
    const n=sl.vals.length, sym=new Uint8Array(n);
    for(let i=0;i<n;i++){
      const v=sl.vals[i];
      if(L===2) sym[i]=v>thr ? 1 : 0;
      else { let k=0; while(k<L-1 && thrs && v>thrs[k]) k++; sym[i]=k; }
    }
    return {a,b,thr,sl,Tm,n,sym,raw:slSymBits(sym,L,gray)};
  });
  if(code==='auto') code=L===2 ? slDetectCode(prep.map(m=>m.raw)) : 'NRZ';
  for(const {a,b,thr,sl,Tm,n,sym,raw} of prep){
    const dec=slDecode(raw,code,inv);
    R.msgs.push({a,b,T:Tm,t:a/sr,dur:(b-a)/sr,n,sym,vals:sl.vals,bnd:sl.bnd,raw,bits:dec.bits,src:dec.src,err:dec.err,thr});
  }
  R.L=L; R.bps=L===4 ? 2 : 1; R.code=code;
  // непрерывные передачи и повторы внутри пачки: кадры по синхрословам
  const sp=String(cfg.split||'').trim();
  if(sp && R.msgs.length){
    const ctx={L,gray,code,inv,minB,sr},hex=sp.toLowerCase()==='auto' ? null : sp.replace(/[^0-9a-fA-F]/g,''), out=[];
    let hw=null;
    if(hex){ hw=new Uint8Array(hex.length*4); for(let i=0;i<hex.length;i++){ const v=parseInt(hex[i],16); for(let k=0;k<4;k++) hw[i*4+k]=(v>>(3-k))&1; } }
    for(const m of R.msgs){
      let word=hw;
      if(!word && m.bits.length>=256){ const f=slFindRepeat(m.bits,32); word=f ? f.word : null; }
      out.push(...(word ? slSplitMsg(m,word,word.length>=16 ? 1 : 0,ctx) : [m]));
    }
    R.msgs=out;
  }
  R.sync=slSyncGuess(R.msgs.map(m=>m.bits));
  return R;
}

// разбор + всё, что нужно для рисования (пирамиды min/max, пределы); так же считает воркер
function slAnalyzeFull(re,im,sr,cfg){
  const t0=Date.now();
  const R=slAnalyze(re,im,sr,cfg);
  R.N=re.length;
  if(R.mag){
    const v=slSample(R.mag,0,R.mag.length,20000).sort();
    R.magTop=Math.max(v[Math.floor(v.length*.995)]||0,R.noise>0 && isFinite(R.noise) ? R.noise*1.5 : 0,1e-9)*1.15;
    R.pyrM=slPyramid(R.mag,64);
    if(R.mod!=='ASK' && R.dem && R.dem!==R.mag) R.pyrD=slPyramid(R.dem,64);
  }
  if(R.dem && R.segs.length && R.mod!=='ASK'){
    const v=slPool(R.dem,R.segs,20000).sort(), lo=v[Math.floor(v.length*.01)], hi=v[Math.floor(v.length*.99)], pad=(hi-lo)*.12+1e-12;
    R.demLo=lo-pad; R.demHi=hi+pad;
  }
  R.cost=Date.now()-t0;
  return R;
}

// столбцы выровненных сообщений: одинаковы ли биты во всех (подсветка отличий)
function slColumns(list,offs){
  const P=Math.max(0,...offs), len=Math.max(0,...list.map((b,i)=>b.length-offs[i]));
  const same=new Uint8Array(P+len);
  for(let c=0;c<P+len;c++){
    let v=-1, ok=1, cnt=0;
    for(let i=0;i<list.length;i++){
      const k=c-P+offs[i];
      if(k<0 || k>=list[i].length) continue;
      cnt++;
      if(v<0) v=list[i][k]; else if(list[i][k]!==v){ ok=0; break; }
    }
    same[c]=ok && cnt>1 ? 1 : 0;
  }
  return {P,same};
}
