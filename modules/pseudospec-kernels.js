"use strict";
/* ============== Pseudo-Spectrum: шум каждого бина = 0 дБ, канал открывает модуляция (ядро) ==============
   CFAR (узел 'cfar') сравнивает бин с соседями ОДНОГО кадра. Здесь пол — свой у каждого бина и во времени:
   медленное среднее по кадрам, в которое не попадают бины, ушедшие выше порога (сигнал пол не тянет).
   Псевдоспектр = уровень − пол: каждый канал виден как «на сколько над собственным шумом», неровности приёмника
   (горб, спуры, перекос АЧХ) вычтены. Канал «открывается» только при модуляции:
     · несущая без модуляции — узкая линия (≤ carBins бинов на уровне −bwDb от пика) со стабильным уровнем,
       её бин почти не дрожит между кадрами (у несущей с отношением s дрожь |Δ| ≈ 6,9/√s дБ, шум сам по себе дрожит
       сильнее) — открытие по отношению измеренной дрожи к ожидаемой у несущей (modK) или по ширине;
     · короткий широкополосный всплеск не переживает подтверждение M из N кадров.
   Открытые каналы получают слоты 1…K и держат их, пока открыты: слот → частота и «идёт запись» для
   IQ Channelizer + IQ Recorder (одновременная запись всех сигналов окна). Чистая логика без DOM.
   Проверка: node tools/test-pseudospec.mjs */

const PS_POP=(()=>{ const t=new Uint8Array(256); for(let i=0;i<256;i++){ let c=0; for(let x=i;x;x&=x-1) c++; t[i]=c; } return t; })();

function psNew(){ return {N:0, fl:null, prev:null, dev:null, hits:null, frames:0, tracks:[], nextId:1, lost:0}; }

// медиана блоками по B бинов, между центрами блоков — линейно: стартовая оценка пола (сигналы кадра её почти не тянут)
function psBlockMed(v,N,B){
  const nb=Math.max(1,Math.ceil(N/B)), m=new Float32Array(nb), tmp=new Float32Array(B);
  for(let b=0;b<nb;b++){
    const lo=b*B, hi=Math.min(N,lo+B), k=hi-lo;
    for(let j=0;j<k;j++) tmp[j]=v[lo+j];
    const s=tmp.subarray(0,k).sort(); m[b]=s[k>>1];
  }
  const out=new Float32Array(N);
  for(let i=0;i<N;i++){
    const x=(i+.5)/B-.5, b0=Math.max(0,Math.min(nb-1,Math.floor(x))), b1=Math.min(nb-1,b0+1), t=Math.max(0,Math.min(1,x-b0));
    out[i]=m[b0]*(1-t)+m[b1]*t;
  }
  return out;
}

// Один кадр. v — уровни бинов, дБ; hz(i) — частота бина; o:
//   thr порог над полом, дБ · gate выше этого бин пол не тянет (дБ) · tau постоянная пола, кадров · learn кадров обучения
//   confM из confN кадров · minW мин. ширина, бинов · gap склейка щелей, бинов · bwDb ширина канала: дБ ниже пика
//   carBins: уже этого (на bwDb ниже пика) — линия несущей · modK: дрожь/ожидаемая у несущей (0 — без проверки по дрожи)
//   settle: кадров жизни дорожки до проверки по дрожи
//   hold: закрыть через, мс · maxBw: шире — не канал, Гц (0 — без ограничения) · edge: обрезка краёв, % · now, мс
// → {exc (Float32Array: псевдоспектр, дБ), chans, tracks, recs}
function psFrame(st,v,hz,o){
  const N=v.length, now=o.now||0;
  if(st.N!==N || !st.fl){
    st.N=N; st.fl=psBlockMed(v,N,64); st.prev=Float32Array.from(v); st.dev=new Float32Array(N);
    st.hits=new Uint8Array(N); st.low=new Uint8Array(N); st.frames=0; st.tracks=[];
  }
  const fl=st.fl, low=st.low, dev=st.dev, prev=st.prev, hits=st.hits, exc=new Float32Array(N);
  const thr=o.thr, gate=o.gate>0 ? o.gate : Math.max(6,thr*.8), up=1/Math.max(2,o.tau||200);
  const confN=Math.min(8,Math.max(1,o.confN|0)), confM=Math.min(confN,Math.max(1,o.confM|0)), mask=(1<<confN)-1;
  const learning=st.frames<(o.learn|0);
  for(let i=0;i<N;i++){
    const x=v[i], d=x-fl[i];
    exc[i]=d;
    hits[i]=((hits[i]<<1)|(d>=thr && !learning ? 1 : 0))&mask;
    const dd=Math.min(8,Math.abs(x-prev[i])); dev[i]+=.2*(dd-dev[i]); prev[i]=x;
    // пол: в шуме — среднее с постоянной tau; над gate — почти замороженный (сигнал не должен его поднять, но
    // постоянная станция за долгое время впитывается); вниз при устойчивом провале — быстро (пол, раздутый ушедшим сигналом)
    // (глубокие замирания шума бывают и в шуме — быстрый спуск только при устойчивом провале ≥ 4 кадров подряд)
    low[i]=d<-8 ? Math.min(255,low[i]+1) : 0;
    let r;
    if(low[i]>=4) r=.3;
    else if(d<gate) r=learning ? Math.max(up,1/(st.frames+2)) : up;
    else r=up*.03;
    fl[i]+=r*d;
  }
  st.frames++;

  // группы подтверждённых бинов
  const i0=Math.max(0,Math.floor(N*(o.edge||0)/100)), i1=N-i0, binHz=Math.abs(hz(Math.min(N-1,1))-hz(0))||1;
  const gap=Math.max(0,o.gap|0), minW=Math.max(1,o.minW|0), groups=[];
  let a=-1, last=-1;
  const close=()=>{ if(a>=0 && last-a+1>=minW) groups.push([a,last]); a=-1; };
  for(let i=i0;i<i1;i++){
    if(PS_POP[hits[i]]>=confM){ if(a>=0 && i-last-1>gap) close(); if(a<0) a=i; last=i; }
  }
  close();
  const chans=[];
  for(const [ga,gb] of groups){
    let p=ga; for(let i=ga;i<=gb;i++) if(exc[i]>exc[p]) p=i;
    const pk=exc[p], cut=pk-(o.bwDb>0 ? o.bwDb : 20);
    let l=p, h=p; while(l>ga && exc[l-1]>=cut) l--; while(h<gb && exc[h+1]>=cut) h++;
    const wBins=h-l+1;
    let sw=0, sf=0; for(let i=l;i<=h;i++){ const w=Math.pow(10,exc[i]/10); sw+=w; sf+=w*hz(i); }
    const bw=(h-l+1)*binHz, f=sf/sw, ga2=Math.max(ga,0);
    if(o.maxBw>0 && bw>o.maxBw) continue;                          // широкополосный: не канал (помеха, поднятый пол)
    // дрожь: у несущей с отношением s она ≈ 6,9/√s дБ. Берём медиану отношений «измерено / ожидаемо у несущей» по бинам
    // канала на уровне bwDb от пика (у каждого бина своё s) — медиана не даёт одному шумному бину открыть канал
    const rs=[]; for(let i=l;i<=h;i++) rs.push(dev[i]/Math.max(6.9/Math.sqrt(Math.max(Math.pow(10,exc[i]/10),1)),.05));
    rs.sort((x,y)=>x-y); const ratio=rs[rs.length>>1];
    const wide=wBins>(o.carBins>0 ? o.carBins : 4), mod=o.modK>0 ? ratio>=o.modK : false;
    chans.push({lo:hz(ga2)-binHz/2, hi:hz(gb)+binHz/2, f, bw, pk, bins:wBins, ratio, mod, wide, p, l, h, abs:v[p]});
  }

  // привязка к дорожкам, жизненный цикл (открыт / закрыт), записи
  const recs=[], tr=st.tracks, seen=new Set();
  for(const c of chans){
    let t=null, best=Infinity;
    for(const x of tr){ const dz=Math.abs(x.f-c.f); if(dz<=Math.max(x.bw,c.bw)/2+binHz && dz<best){ best=dz; t=x; } }
    if(!t){ t={id:st.nextId++, f:c.f, t0:now, open:false, slot:0, modAt:-1e18, lastMod:false}; tr.push(t); for(let i=Math.max(0,c.l-2);i<=Math.min(N-1,c.h+2);i++) dev[i]=0; }   // дрожь от скачка включения — не в счёт
    seen.add(t);
    t.n=t.lf===st.frames-1 ? (t.n|0)+1 : 1; t.lf=st.frames;                // кадров подряд на месте
    t.f=t.f*.5+c.f*.5; t.lo=c.lo; t.hi=c.hi; t.bw=c.bw; t.pk=c.pk; t.abs=c.abs; t.ratio=t.n>1 && t.born ? t.ratio+.25*(c.ratio-t.ratio) : (t.born=1, 1); t.seenAt=now;     // сглаженное отношение дрожи
    // открытие — только у «осевшей» дорожки (settle кадров подряд): скачок включения несущей выглядит дрожью, а случайные
    // сцепки шумовых бинов за пару кадров широкой линией не станут
    const modOk=t.n>=(o.settle>0 ? o.settle : 8) && (c.wide || (o.modK>0 && t.ratio>=o.modK));
    t.lastMod=modOk;
    if(modOk) t.modAt=now;
    if(!t.open && modOk){ t.open=true; t.openAt=now; recs.push({t:now, kind:'open', id:t.id, f:t.f, bw:t.bw, exc:t.pk}); }
  }
  for(let k=tr.length-1;k>=0;k--){
    const t=tr[k];
    // открыт: держим, пока есть модуляция (модуляции нет дольше hold — закрываем, даже если несущая осталась)
    if(t.open && now-t.modAt>o.hold){
      t.open=false; recs.push({t:now, kind:'close', id:t.id, f:t.f, bw:t.bw, exc:t.pk, dur:(now-t.openAt)/1000}); t.closeAt=now;
    }
    if(!t.open && !seen.has(t) && now-(t.seenAt||0)>Math.max(500,o.hold)) tr.splice(k,1);
  }
  return {exc, chans, tracks:tr, recs};
}

// Слоты 1…K: открытый канал получает свободный слот и держит его до закрытия. → {f:[K], go:[K], lost}
function psSlots(tracks,K){
  const taken=new Array(K+1).fill(null);
  for(const t of tracks){ if(t.slot && (!t.open || t.slot>K)) t.slot=0; if(t.slot) taken[t.slot]=t; }
  let lost=0;
  for(const t of tracks.slice().sort((a,b)=>(a.openAt||0)-(b.openAt||0))){
    if(!t.open || t.slot) continue;
    let s=1; while(s<=K && taken[s]) s++;
    if(s<=K){ t.slot=s; taken[s]=t; } else lost++;
  }
  const f=[], go=[];
  for(let s=1;s<=K;s++){ const t=taken[s]; f.push(t ? t.f : null); go.push(t && t.open ? 1 : 0); }
  return {f, go, lost};
}
