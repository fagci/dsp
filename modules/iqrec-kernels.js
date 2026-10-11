"use strict";
/* ============ IQ: аннотации, запись куска полосы, триггер записи (без DOM) ============ */
// Время — в отсчётах источника ("таймлайн"): у файла это позиция в нём, у живого источника — счётчик отсчётов.
// Аннотация: {a0, a1, lo, hi, label, auto, peak}; a0..a1 — отсчёты, lo..hi — Гц.

const IQA_MAX=800;                                    // аннотаций в списке; старые закрытые выбрасываются

function iqaFmtHz(f){
  const a=Math.abs(f);
  return a>=1e9 ? (f/1e9).toFixed(4).replace(/\.?0+$/,'')+'G' : a>=1e6 ? (f/1e6).toFixed(4).replace(/\.?0+$/,'')+'M'
    : a>=1e3 ? (f/1e3).toFixed(2).replace(/\.?0+$/,'')+'k' : String(Math.round(f));
}

// Сигналы в кадре спектра: бины выше шумового пола на thrDb, соседние склеиваются.
// freqs — Гц по бинам (возрастают), mag — амплитуда. Шум — медиана мощности по прореженной выборке
// (редкие сигналы её не сдвигают). skip: [{lo,hi}] — зоны, которые не берём (пик нуля приёмника).
function iqaDetect(freqs, mag, thrDb, skip){
  const N=mag.length; if(N<8) return [];
  const step=Math.max(1, N>>12), s=[];
  for(let i=0;i<N;i+=step) s.push(20*Math.log10(mag[i]+1e-12));
  s.sort((a,b)=>a-b);
  const floor=s[s.length>>1], thr=floor+thrDb, bin=(freqs[N-1]-freqs[0])/(N-1), out=[];
  let i=0;
  while(i<N){
    if(20*Math.log10(mag[i]+1e-12)<thr){ i++; continue; }
    let j=i, gap=0, pk=-1e9, last=i, hits=0;
    for(; j<N && gap<=2; j++){
      const v=20*Math.log10(mag[j]+1e-12);
      if(v>=thr){ gap=0; last=j; hits++; if(v>pk) pk=v; } else gap++;
    }
    const lo=freqs[i]-bin/2, hi=freqs[last]+bin/2;
    i=last+1;
    if(hits<2 && pk<thr+6) continue;                   // одиночный выброс шума
    if(skip && skip.some(z=>(lo+hi)/2>=z.lo && (lo+hi)/2<=z.hi)) continue;
    out.push({lo, hi, db:pk, snr:pk-floor});
  }
  return out;
}

const iqaOverlap=(a,b)=>Math.min(a.hi,b.hi)-Math.max(a.lo,b.lo);
const IQA_CONFIRM=3;                                  // кадров подряд, чтобы новый сигнал стал аннотацией
function iqaNew(){ return {list:[], act:[], cand:[], last:-1}; }

// Трекер: кадр на таймлайне t (окно win отсчётов) → открытые/продлённые/закрытые аннотации.
// hang — сколько отсчётов сигнал может отсутствовать до закрытия. Возвращает список только что открытых.
function iqaTrack(st, dets, t, win, hang, tag){
  if(st.last>=0 && t<st.last){ st.act=[]; st.cand=[]; }  // перемотка назад/зацикливание файла
  st.last=t;
  const opened=[], used=new Set(), cand=[];
  for(const d of dets){
    const w=d.hi-d.lo, tol=Math.max(w*.25, 1);
    let m=null;
    for(const a of st.act) if(!used.has(a) && iqaOverlap(a,d)>-tol && iqaOverlap(a,d)>=Math.min(w,a.hi-a.lo)*.3-tol) { m=a; break; }
    if(m){ used.add(m); m.a1=t; m.lo=Math.min(m.lo,d.lo); m.hi=Math.max(m.hi,d.hi); if(d.db>m.peak) m.peak=d.db; m.label=iqaLabel(m,tag); continue; }
    // уже размечено (например, из файла) — второй раз не создаём
    let cov=false;
    for(let k=st.list.length-1, c=0; k>=0 && c<IQA_MAX; k--, c++){
      const a=st.list[k];
      if(t>=a.a0-win && t<=a.a1+win && iqaOverlap(a,d)>0.3*Math.min(w,a.hi-a.lo)){ cov=true; break; }
    }
    if(cov) continue;
    // новый сигнал подтверждается несколькими кадрами подряд — случайные выбросы шума не размечаем
    const pc=st.cand.find(c=>iqaOverlap(c,d)>0.3*Math.min(w,c.hi-c.lo)), c={a0:pc ? pc.a0 : Math.max(0,t-win), lo:d.lo, hi:d.hi, db:d.db, cnt:(pc?.cnt||0)+1};
    if(c.cnt<IQA_CONFIRM){ cand.push(c); continue; }
    const a={a0:c.a0, a1:t, lo:d.lo, hi:d.hi, peak:d.db, auto:true, label:''};
    a.label=iqaLabel(a,tag);
    st.list.push(a); st.act.push(a); used.add(a); opened.push(a);
    if(st.list.length>IQA_MAX){ const i=st.list.findIndex(x=>!st.act.includes(x)); if(i>=0) st.list.splice(i,1); }
  }
  st.act=st.act.filter(a=>t-a.a1<=hang);
  st.cand=cand;
  return opened;
}
const iqaLabel=(a,tag)=>(tag?tag+' ':'')+iqaFmtHz((a.lo+a.hi)/2)+'Hz';
// сигнал, пересекающий полосу [lo,hi], ещё открыт
const iqaActiveIn=(st,lo,hi)=>st.act.some(a=>iqaOverlap(a,{lo,hi})>0);

// аннотации в формате SigMF для записи, начавшейся на таймлайне t0 (длиной total отсчётов источника, прореживание D)
function iqaSigmf(list, t0, total, D, rate){
  const out=[];
  for(const a of list){
    if(a.a1<t0 || a.a0>t0+total) continue;
    const s=Math.max(0, Math.round((a.a0-t0)/D)), e=Math.min(Math.round(total/D), Math.round((a.a1-t0)/D));
    const o={'core:sample_start':s, 'core:sample_count':Math.max(1,e-s), 'core:label':a.label||''};
    if(isFinite(a.lo)){ o['core:freq_lower_edge']=Math.round(a.lo); o['core:freq_upper_edge']=Math.round(a.hi); }
    if(a.auto) o['core:comment']='auto';
    out.push(o);
  }
  return out;
}
// обратно: аннотации SigMF → список; fc/rate — запас, если границ по частоте нет
function iqaFromSigmf(arr, fc, rate){
  const out=[];
  for(const x of arr||[]){
    const a0=+x['core:sample_start']||0, c=+x['core:sample_count']||0;
    const lo=x['core:freq_lower_edge'], hi=x['core:freq_upper_edge'];
    out.push({a0, a1:a0+Math.max(0,c), lo:lo!=null ? +lo : (fc||0)-(rate||0)/2, hi:hi!=null ? +hi : (fc||0)+(rate||0)/2,
      label:x['core:label']||x['core:description']||'', auto:x['core:comment']==='auto', peak:-1e9});
  }
  return out.sort((p,q)=>p.a0-q.a0);
}

// ---- запись куска полосы: сдвиг + ФНЧ + прореживание на D ----
// sr — частота источника, off — смещение центра записи от центра приёма (Гц), D — прореживание, bw — полоса записи.
// push(raw, fmt) принимает u8/s16-чередование IQ, возвращает Int16Array (чередование) на частоте sr/D.
function iqaDdc(sr, off, D, bw){
  const fs=sr/D, M=Math.min(16*D+1, 2049)|1, h=new Float32Array(M), c=(M-1)/2;
  // срез на 0.5 выходной частоты (переходная до 0.6): алиасы не попадают в полосу до 0.4·fs
  const fcut=0.5/D;
  let sum=0;
  for(let i=0;i<M;i++){
    const x=i-c, s=x===0 ? 2*fcut : Math.sin(2*Math.PI*fcut*x)/(Math.PI*x);
    h[i]=s*(0.54-0.46*Math.cos(2*Math.PI*i/(M-1))); sum+=h[i];
  }
  for(let i=0;i<M;i++) h[i]/=sum;
  const w=-2*Math.PI*off/sr;
  let ph=0;
  let hI=new Float32Array(0), hQ=new Float32Array(0);  // с начала следующего окна (после смешивания)
  return {rate:Math.round(fs), D, taps:M,
    setOffset(o){ off=o; this.w=-2*Math.PI*o/sr; },
    w,
    push(raw, fmt){
      const K=raw.length>>1, L=hI.length, I=new Float32Array(L+K), Q=new Float32Array(L+K);
      I.set(hI); Q.set(hQ);
      const cr=Math.cos(this.w), ci=Math.sin(this.w);
      let pr=Math.cos(ph), pi=Math.sin(ph);
      const u8=fmt==='u8';
      for(let k=0;k<K;k++){
        const a=u8 ? (raw[2*k]-127.5)/127.5 : raw[2*k]/32768, b=u8 ? (raw[2*k+1]-127.5)/127.5 : raw[2*k+1]/32768;
        I[L+k]=a*pr-b*pi; Q[L+k]=a*pi+b*pr;
        const nr=pr*cr-pi*ci; pi=pr*ci+pi*cr; pr=nr;
        if((k&1023)===1023){ const m=1/Math.hypot(pr,pi); pr*=m; pi*=m; }
      }
      ph=Math.atan2(pi,pr);
      const out=[];
      let p=0;                                         // начало окна в I/Q
      for(; p+M<=L+K; p+=D){
        let sr_=0, si_=0;
        for(let j=0;j<M;j++){ sr_+=I[p+j]*h[j]; si_+=Q[p+j]*h[j]; }
        out.push(sr_, si_);
      }
      hI=I.slice(p); hQ=Q.slice(p);                    // p <= L+K, т.к. M >= D
      const r=new Int16Array(out.length);
      for(let i=0;i<out.length;i++){ const v=Math.round(out[i]*32767); r[i]=v>32767?32767:v<-32768?-32768:v; }
      return r;
    }};
}

// ---- триггер записи ----
// Вызывается раз в такт: open — условие запуска (шумоподавитель открыт / сигнал в полосе канала),
// closed — условие остановки (шумоподавитель закрыт или сигнал пропал). Возвращает 'start' | 'stop' | null.
// Остановка — только когда источник условия остановки успел побывать "открытым" (armAtStart при старте
// или o.armed позже) либо прошло waitMs: закрытый в момент старта шумоподавитель не обрывает запись.
function iqaTrig(st, open, closed, now, o){
  if(!st.on){
    if(open){ st.on=true; st.t0=now; st.seen=!!o.armAtStart; return 'start'; }
    return null;
  }
  if(o.armed) st.seen=true;
  if(now-st.t0>o.maxMs){ st.on=false; return 'stop'; }
  if(closed && (st.seen || now-st.t0>o.waitMs)){ st.on=false; return 'stop'; }
  return null;
}
