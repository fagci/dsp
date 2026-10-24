"use strict";
/* ============================ Эхокомпенсатор (AEC): частотный адаптивный фильтр с разбиением на блоки ============================
   PBFDAF (overlap-save): опорный сигнал ref (динамик, дальний конец или второй микрофон у источника помех) проходит через оценку тракта
   «ref → микрофон» длиной M блоков по P отсчётов; оценка эха вычитается из микрофона. Шаг адаптации нормируется на мощность опоры,
   при двойной речи (в ошибке громкий ближний голос) снижается; остаточное эхо дополнительно давит мягкий шумоподавитель по соотношению
   мощностей ошибки и оценки эха. Без опоры (один микрофон) опорой служит сам микрофон, задержанный на minDelay: фильтр предсказывает
   только то, что повторилось позже этой задержки, то есть эхо и реверберацию; собственный голос короче задержки остаётся.
   Нужен fft() из core-dsp.js. Чистая логика без DOM, проверяется tools/test-aec.mjs. */

function aecIfft(re,im){
  const n=re.length;
  for(let i=0;i<n;i++) im[i]=-im[i];
  fft(re,im);
  const s=1/n;
  for(let i=0;i<n;i++){ re[i]*=s; im[i]=-im[i]*s; }
}

// P — длина блока (степень двойки), M — число блоков фильтра (длина = M·P отсчётов)
function aecCore(P,M,opts2){
  opts2=opts2||{};
  const N=2*P, H=P+1;
  const Wr=[], Wi=[], Xr=[], Xi=[];
  for(let m=0;m<M;m++){ Wr.push(new Float64Array(H)); Wi.push(new Float64Array(H)); Xr.push(new Float64Array(H)); Xi.push(new Float64Array(H)); }
  const xb=new Float64Array(N), re=new Float64Array(N), im=new Float64Array(N), Er=new Float64Array(H), Ei=new Float64Array(H);
  const Yr=new Float64Array(H), Yi=new Float64Array(H), S=new Float64Array(H), Sh=new Float64Array(H);   // Sh — мощность опоры с удержанием: в паузах опоры нормировка не должна падать до нуля, иначе шаг взрывается
  let t=0, cc=0, act=0;                       // act — сколько блоков опора была активна: первые ~2 с адаптируемся без защиты от двойной речи
  const o={P,M,
    get t(){ return t; },
    reset(){ Sh.fill(0); for(let m=0;m<M;m++){ Wr[m].fill(0); Wi[m].fill(0); Xr[m].fill(0); Xi[m].fill(0); } xb.fill(0); t=0; cc=0; act=0; },
    // d — микрофон (P отсчётов), x — опора (P); mu — шаг (0…1), dtd — защита от двойной речи (0…1), freeze — не адаптироваться
    // → {e (ошибка = микрофон − эхо), y (оценка эха)}
    block(d,x,mu,dtd,freeze){
      xb.copyWithin(0,P,N); for(let i=0;i<P;i++) xb[P+i]=x[i];
      const slot=t%M;
      for(let i=0;i<N;i++){ re[i]=xb[i]; im[i]=0; }
      fft(re,im);
      for(let k=0;k<H;k++){ Xr[slot][k]=re[k]; Xi[slot][k]=im[k]; }
      Yr.fill(0); Yi.fill(0); S.fill(0);
      for(let m=0;m<M;m++){
        const j=((t-m)%M+M)%M, xr=Xr[j], xi=Xi[j], wr=Wr[m], wi=Wi[m];
        for(let k=0;k<H;k++){
          Yr[k]+=wr[k]*xr[k]-wi[k]*xi[k]; Yi[k]+=wr[k]*xi[k]+wi[k]*xr[k];
          S[k]+=xr[k]*xr[k]+xi[k]*xi[k];
        }
      }
      for(let k=0;k<H;k++){ re[k]=Yr[k]; im[k]=Yi[k]; }
      for(let k=1;k<P;k++){ re[N-k]=Yr[k]; im[N-k]=-Yi[k]; }
      aecIfft(re,im);
      const y=new Float32Array(P), e=new Float32Array(P);
      let Pd=0, Pe=0, Py=0;
      for(let i=0;i<P;i++){ y[i]=re[P+i]; e[i]=d[i]-y[i]; Pd+=d[i]*d[i]; Pe+=e[i]*e[i]; Py+=y[i]*y[i]; }
      if(!freeze){
        re.fill(0); im.fill(0); for(let i=0;i<P;i++) re[P+i]=e[i];
        fft(re,im);
        for(let k=0;k<H;k++){ Er[k]=re[k]; Ei[k]=im[k]; }
        // шаг падает, когда ошибка не намного тише оценки эха (после сходимости ошибка в разы тише; громкая ошибка — ближний голос), но не до нуля: на старте оценка эха ещё нулевая
        let Px=0; for(let i=0;i<P;i++) Px+=x[i]*x[i];
        if(Px>1e-6*P) act++;
        const f=act<(opts2.warm||125) ? 1 : Math.min(1,Math.max(.05,Py/(Pe*8+1e-12))), mu2=mu*(1-dtd+dtd*f);
        const dl=1e-7*N;
        for(let k=0;k<H;k++) Sh[k]=Math.max(S[k],Sh[k]*.98);
        for(let m=0;m<M;m++){
          const j=((t-m)%M+M)%M, xr=Xr[j], xi=Xi[j], wr=Wr[m], wi=Wi[m];
          for(let k=0;k<H;k++){
            const g=mu2/(Sh[k]+dl);
            wr[k]+=g*(xr[k]*Er[k]+xi[k]*Ei[k]); wi[k]+=g*(xr[k]*Ei[k]-xi[k]*Er[k]);
          }
        }
        // ограничение (импульсная характеристика не длиннее блока) — по два блока за такт по кругу
        for(let q=0;q<2;q++){
          const m=cc%M; cc++;
          const wr=Wr[m], wi=Wi[m];
          for(let k=0;k<H;k++){ re[k]=wr[k]; im[k]=wi[k]; }
          for(let k=1;k<P;k++){ re[N-k]=wr[k]; im[N-k]=-wi[k]; }
          aecIfft(re,im);
          for(let i=P;i<N;i++){ re[i]=0; } for(let i=0;i<N;i++) im[i]=0;
          fft(re,im);
          for(let k=0;k<H;k++){ wr[k]=re[k]; wi[k]=im[k]; }
        }
      }
      t++;
      return {e,y,Pd,Pe,Py};
    },
    // самая сильная задержка фильтра, отсчёты (по энергии блоков, внутри блока — по пику импульсной характеристики)
    peak(){
      let bm=0, be=-1;
      for(let m=0;m<M;m++){ let s=0; for(let k=0;k<H;k++) s+=Wr[m][k]*Wr[m][k]+Wi[m][k]*Wi[m][k]; if(s>be){ be=s; bm=m; } }
      if(be<=0) return -1;
      for(let k=0;k<H;k++){ re[k]=Wr[bm][k]; im[k]=Wi[bm][k]; }
      for(let k=1;k<P;k++){ re[N-k]=Wr[bm][k]; im[N-k]=-Wi[bm][k]; }
      aecIfft(re,im);
      let bi=0, bv=0; for(let i=0;i<P;i++) if(Math.abs(re[i])>bv){ bv=Math.abs(re[i]); bi=i; }
      return bm*P+bi;
    }};
  return o;
}

// Поток: блоки любой длины на входе и выходе; задержка — один блок P. x == null — режим одного микрофона (опора — микрофон, задержанный на minDelay).
// opts: {sr, P, ms (длина фильтра), mu, dtd, suppress (0…1, остаточное эхо), delay (мс, сдвиг опоры), minDelay (мс, один микрофон)}
function aecStream(opts){
  const P=opts.P||256, M=Math.max(1,Math.ceil(opts.ms*opts.sr/1000/P)), core=aecCore(P,M,{warm:Math.round(2*opts.sr/P)});
  const dq=new Float32Array(P*4), xq=new Float32Array(P*4); let nd=0;
  let outq=new Float32Array(P*8), no=P;                   // запас в один блок = задержка
  const maxDel=Math.ceil(Math.max(opts.delay||0,opts.minDelay||0,1)*opts.sr/1000)+P*2;
  const hist=new Float32Array(maxDel+P*8); let hw=0;       // история опоры для сдвига и однопорного режима
  const s={core, P, M, mu:opts.mu??.5, dtd:opts.dtd??.8, suppress:opts.suppress??.5, delay:opts.delay||0, minDelay:opts.minDelay||0, freeze:false,
    Pe:0, Py:0, Pd:0, gain:1, erle:0, solo:false,
    get latency(){ return P/opts.sr; },
    push(d,x){
      s.solo=!x;
      const n=d.length, out=new Float32Array(n);
      let i=0;
      while(i<n){
        const take=Math.min(P-nd,n-i);
        for(let k=0;k<take;k++){
          dq[nd+k]=d[i+k];
          const ref=x ? x[i+k] : d[i+k];
          hist[hw]=ref; hw=(hw+1)%hist.length;
        }
        // опора для блока: значения на (задержка) отсчётов раньше записанных
        nd+=take; i+=take;
        if(nd===P){
          const lag=Math.round((x ? s.delay : s.minDelay)*opts.sr/1000);
          const xr=new Float32Array(P);
          for(let k=0;k<P;k++){ const idx=((hw-P+k-lag)%hist.length+hist.length)%hist.length; xr[k]=hist[idx]; }
          const r=core.block(dq.subarray(0,P),xr,s.mu,x ? s.dtd : Math.min(s.dtd,.3),s.freeze);
          s.Pd=s.Pd*.9+r.Pd*.1; s.Pe=s.Pe*.9+r.Pe*.1; s.Py=s.Py*.9+r.Py*.1;
          s.erle=10*Math.log10((s.Pd+1e-12)/(s.Pe+1e-12));
          // остаточное эхо: ошибка заметно тише оценки эха — режем; ближний голос делает ошибку громкой, и подавление отпускается
          const sup=x ? s.suppress : 0;                    // один микрофон: «оценка эха» неотличима от предсказуемой части самого сигнала, давить остаток нельзя
          const gt=Math.sqrt(Math.max(.05,Math.min(1,(r.Pe+1e-12)/(r.Pe+sup*r.Py+1e-12)))), prev=s.gain;
          s.gain=gt>prev ? prev+(gt-prev)*.5 : prev+(gt-prev)*.2;
          if(no+P>outq.length){ const b=new Float32Array(outq.length*2); b.set(outq.subarray(0,no)); outq=b; }
          const e=r.e, g0=prev, g1=s.gain;
          for(let k=0;k<P;k++) outq[no+k]=e[k]*(g0+(g1-g0)*(k+1)/P);
          no+=P; nd=0;
        }
      }
      const k=Math.min(no,n); out.set(outq.subarray(0,k)); outq.copyWithin(0,k,no); no-=k;
      return out;
    },
    reset(){ core.reset(); nd=0; s.Pe=s.Py=s.Pd=0; s.gain=1; }};
  return s;
}
