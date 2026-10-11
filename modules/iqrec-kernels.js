"use strict";
/* ============ IQ: аннотации, запись куска полосы, триггер записи (без DOM) ============ */
// Время — в отсчётах источника ("таймлайн"): у файла это позиция в нём, у живого источника — счётчик отсчётов.
// Аннотация: {a0, a1, lo, hi, label, mark}; a0..a1 — отсчёты, lo..hi — Гц.

// аннотации в формате SigMF для записи, начавшейся на таймлайне t0 (длиной total отсчётов источника, прореживание D)
function iqaSigmf(list, t0, total, D, rate){
  const out=[];
  for(const a of list){
    if(a.a1<t0 || a.a0>t0+total) continue;
    const s=Math.max(0, Math.round((a.a0-t0)/D)), e=Math.min(Math.round(total/D), Math.round((a.a1-t0)/D));
    const o={'core:sample_start':s, 'core:sample_count':Math.max(1,e-s), 'core:label':a.label||''};
    if(isFinite(a.lo)){ o['core:freq_lower_edge']=Math.round(a.lo); o['core:freq_upper_edge']=Math.round(a.hi); }
    if(a.ts) o['core:comment']=new Date(a.ts).toISOString();
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
      label:x['core:label']||x['core:description']||''});
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
