"use strict";
/* ======================= SA: ТРАССЫ, RBW, ДЕТЕКТОРЫ, ИЗМЕРЕНИЯ — ядро ======================= */
// Чистая логика без DOM: node tools/test-satrace.mjs. mag — амплитуды бинов (линейные), уровень = 20·lg(mag).

const SA_ENBW=1.5;                                   // эквивалентная шумовая полоса окна, бинов (hann); sp.enbw, если источник знает

// RBW шире родного: мощность суммируется по k бинам скользящим окном и делится на ENBW — несущая остаётся
// на месте, шум растёт на 10·lg(k), как у анализатора с настоящей RBW. Ниже родного значения не опускаем.
function saRbwMerge(mag,out,k,enbw,pre){
  const N=mag.length;
  if(!(k>1)){ out.set(mag); return out; }
  const S=pre&&pre.length===N+1 ? pre : new Float64Array(N+1);
  for(let i=0;i<N;i++) S[i+1]=S[i]+mag[i]*mag[i];
  const h=k>>1, e=enbw>0 ? enbw : SA_ENBW;
  for(let i=0;i<N;i++){
    const a=Math.max(0,i-h), b=Math.min(N,a+k), a2=Math.max(0,b-k);   // у краёв окно сдвигается, а не сжимается
    const p=Math.max(mag[i]*mag[i],(S[b]-S[a2])/e);
    out[i]=Math.sqrt(p);
  }
  return out;
}

// Детектор столбца: бины [b0,b1] (дробные) → одно значение. Меньше бина на столбец — интерполяция для всех режимов.
// auto = peak при нескольких бинах на столбец; peak / negpeak / sample / rms / average (по амплитуде).
function saDetect(arr,N,b0,b1,mode){
  const lo=b0<b1?b0:b1, hi=b0<b1?b1:b0;
  if(hi-lo>1){
    const i0=Math.max(0,Math.ceil(lo)), i1=Math.min(N-1,Math.floor(hi)), c=Math.min(N-1,Math.max(0,Math.round((lo+hi)*.5)));
    if(mode==='sample') return arr[c];
    if(mode==='negpeak'){ let mn=arr[c]; for(let i=i0;i<=i1;i++) if(arr[i]<mn) mn=arr[i]; return mn; }
    if(mode==='rms'||mode==='average'){
      const sq=mode==='rms'; let s=0,k=0;
      for(let i=i0;i<=i1;i++){ s+=sq?arr[i]*arr[i]:arr[i]; k++; }
      return k ? (sq ? Math.sqrt(s/k) : s/k) : arr[c];
    }
    let mx=arr[c]; for(let i=i0;i<=i1;i++) if(arr[i]>mx) mx=arr[i]; return mx;
  }
  const bf=(lo+hi)*.5, i0=bf|0, i1=Math.min(N-1,i0+1), t=bf-i0;
  return arr[i0]+(arr[i1]-arr[i0])*t;
}

// Трасса: tr={mode,arr,pw,cnt,key}. Режимы: off, live (arr не хранится — потребитель берёт base), average
// (мощность, скользящее среднее по avgN кадрам: сначала настоящее среднее, потом экспоненциальное),
// max hold, min hold, view (заморозка: берёт кадр один раз и больше не меняется).
// key — признак оси частот (sp.freqs): сменилась — накопленное сбрасывается.
function saTraceStep(tr,base,mode,avgN,key){
  const N=base.length;
  if(tr.mode!==mode){
    const keep=mode==='view' && tr.arr && tr.mode!=='live' && tr.arr.length===N;
    tr.mode=mode; if(!keep){ tr.arr=null; tr.pw=null; } tr.cnt=0;
  }
  if(mode==='off'||mode==='live'){ tr.arr=null; tr.pw=null; return null; }
  if(tr.arr && (tr.arr.length!==N || (tr.key!==key && mode!=='view'))){ tr.arr=null; tr.pw=null; tr.cnt=0; }
  tr.key=key;
  if(mode==='view'){ if(!tr.arr) tr.arr=Float32Array.from(base); return tr.arr; }
  if(!tr.arr){
    tr.arr=Float32Array.from(base); tr.cnt=1;
    if(mode==='average'){ tr.pw=new Float32Array(N); for(let i=0;i<N;i++) tr.pw[i]=base[i]*base[i]; }
    return tr.arr;
  }
  const a=tr.arr;
  if(mode==='max hold'){ for(let i=0;i<N;i++) if(base[i]>a[i]) a[i]=base[i]; }
  else if(mode==='min hold'){ for(let i=0;i<N;i++) if(base[i]<a[i]) a[i]=base[i]; }
  else {                                              // average
    const pw=tr.pw, w=1/Math.min(tr.cnt+1,Math.max(1,avgN|0));
    for(let i=0;i<N;i++){ const p=base[i]*base[i]; pw[i]+=(p-pw[i])*w; a[i]=Math.sqrt(pw[i]); }
    tr.cnt++;
  }
  return a;
}
const saTraceArr=(tr,base)=>tr.mode==='live' ? base : tr.mode==='off' ? null : tr.arr;

// ---- измерения (индексы бинов целые, i0..i1 включительно) ----
function saPwrSum(mag,i0,i1){ let s=0; for(let i=i0;i<=i1;i++) s+=mag[i]*mag[i]; return s; }
// мощность в полосе, дБ (в шкале спектра)
function saChanPower(mag,i0,i1,enbw){ return 10*Math.log10(saPwrSum(mag,i0,i1)/(enbw>0?enbw:SA_ENBW)+1e-24); }
// занятая полоса: границы, между которыми pct % мощности окна (хвосты по (100−pct)/2 % с каждой стороны)
function saObw(mag,i0,i1,pct){
  const tot=saPwrSum(mag,i0,i1); if(!(tot>0)) return null;
  const t=(1-pct/100)/2*tot; let s=0, lo=i0, hi=i1;
  for(let i=i0;i<=i1;i++){ s+=mag[i]*mag[i]; if(s>=t){ lo=i; break; } }
  s=0; for(let i=i1;i>=i0;i--){ s+=mag[i]*mag[i]; if(s>=t){ hi=i; break; } }
  return {lo,hi};
}
// полоса «x дБ вниз» от пика ip: ближайшие пересечения уровня с каждой стороны (дробные бины); open — не нашли в окне
function saXdbBw(mag,ip,i0,i1,x){
  const thr=mag[ip]*Math.pow(10,-x/20), r={lo:i0,hi:i1,openLo:true,openHi:true};
  for(let i=ip-1;i>=i0;i--) if(mag[i]<=thr){ r.lo=i+(thr-mag[i])/((mag[i+1]-mag[i])||1); r.openLo=false; break; }
  for(let i=ip+1;i<=i1;i++) if(mag[i]<=thr){ r.hi=i-(thr-mag[i])/((mag[i-1]-mag[i])||1); r.openHi=false; break; }
  return r;
}
// шумовая плотность, дБ/Гц (в шкале спектра): средняя мощность бина / (ширина бина · ENBW)
function saNoiseDensity(mag,i0,i1,binHz,enbw){
  const n=i1-i0+1; if(n<1) return null;
  return 10*Math.log10(saPwrSum(mag,i0,i1)/n/((binHz||1)*(enbw>0?enbw:SA_ENBW))+1e-24);
}
// ACPR: мощность соседних каналов относительно основного, дБ (dBc); каждый канал — пара [i0,i1]
function saAcpr(mag,main,low,up,enbw){
  const m=saChanPower(mag,main[0],main[1],enbw);
  return {low:saChanPower(mag,low[0],low[1],enbw)-m, up:saChanPower(mag,up[0],up[1],enbw)-m};
}

// ---- CSV: трассы и эталон ----
// cols — [{name,arr}] (линейные амплитуды), freqAt(i) → Гц; уровень пишется в дБ (+ off — калибровка), пустая трасса пропускается
function saTraceCsv(N,freqAt,cols,off){
  const c=cols.filter(x=>x.arr && x.arr.length===N);
  let t='freq_hz,'+c.map(x=>x.name).join(',')+'\n';
  for(let i=0;i<N;i++){
    let row=String(Math.round(freqAt(i)*100)/100);
    for(const x of c) row+=','+(Math.round((20*Math.log10(x.arr[i]+1e-12)+(off||0))*100)/100);
    t+=row+'\n';
  }
  return t;
}
// эталон из CSV/текста: первые два числовых столбца — частота (Гц) и уровень (дБ); заголовок и мусор пропускаются
function saRefParse(text){
  const f=[], d=[];
  for(const line of String(text||'').split(/\r?\n/)){
    const p=line.split(/[,;\t ]+/).map(Number);
    if(p.length>=2 && Number.isFinite(p[0]) && Number.isFinite(p[1])){ f.push(p[0]); d.push(p[1]); }
  }
  if(f.length<2) return null;
  const ix=f.map((_,i)=>i).sort((a,b)=>f[a]-f[b]);
  return {f:Float64Array.from(ix,i=>f[i]), db:Float32Array.from(ix,i=>d[i])};
}
// эталон → амплитуды бинов текущей оси (линейная интерполяция по дБ; вне покрытия — −200 дБ)
function saRefResample(ref,freqAt,N){
  const out=new Float32Array(N), F=ref.f, D=ref.db, M=F.length; let j=0;
  for(let i=0;i<N;i++){
    const f=freqAt(i);
    if(f<F[0]||f>F[M-1]){ out[i]=1e-10; continue; }
    while(j<M-2 && F[j+1]<f) j++;
    const t=(f-F[j])/((F[j+1]-F[j])||1);
    out[i]=Math.pow(10,(D[j]+(D[j+1]-D[j])*t)/20);
  }
  return out;
}
