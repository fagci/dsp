"use strict";
/* ============================ Spectrum Baseline: ядро ============================
   Чистая логика без DOM: node tools/test-baseline.mjs.
   Эфир на сетке ячеек шириной res Гц. В каждой ячейке — «норма» в дБ: среднее и дисперсия (EMA по посещениям),
   доля посещений с сигналом (occ). Кадр сравнивается с нормой:
   - new: ячейки выше нормы на thr дБ и на z σ — кластеры соседних ячеек; шире wideBw — wideband (джаммер, подъём пола);
   - missing: ячейка, где сигнал был почти всегда (occ), а теперь на уровне шума.
   Аномалия медленно «впитывается» в норму (adapt/20), поэтому новая постоянная станция через время становится нормой. */

function blNew(){
  return {res:0, g0:0, cap:0, mu:null, v:null, cnt:null, occ:null, ev:[], frames:0, floor:null, t0:0};
}
function blEnsure(st,gLo,gHi){
  if(!st.mu){
    st.g0=gLo; st.cap=gHi-gLo+1;
    st.mu=new Float32Array(st.cap); st.v=new Float32Array(st.cap); st.cnt=new Uint16Array(st.cap); st.occ=new Float32Array(st.cap);
    return true;
  }
  const lo=Math.min(st.g0,gLo), hi=Math.max(st.g0+st.cap-1,gHi);
  if(lo===st.g0 && hi-st.g0+1===st.cap) return true;
  if(hi-lo+1>8e6) return false;                      // защита от случайного огромного диапазона
  const cap=hi-lo+1, o=st.g0-lo;
  const mu=new Float32Array(cap), v=new Float32Array(cap), cnt=new Uint16Array(cap), occ=new Float32Array(cap);
  mu.set(st.mu,o); v.set(st.v,o); cnt.set(st.cnt,o); occ.set(st.occ,o);
  st.g0=lo; st.cap=cap; st.mu=mu; st.v=v; st.cnt=cnt; st.occ=occ;
  return true;
}
function blMedian(a,n){                                // медиана по прореженной выборке (≤ 512 точек)
  const st=Math.max(1,Math.floor(n/512)), t=[];
  for(let i=0;i<n;i+=st) t.push(a[i]);
  t.sort((x,y)=>x-y);
  return t[t.length>>1];
}
// Один кадр спектра: N бинов, hz(i) — частота бина (возрастает), lv(i) — уровень, дБ.
// o: {res, learn, adapt, thr, z, sdMin, confirm, hold, wideBw, occMin, drop, gap, learnOnly, now}
// → {recs, active, learning, floor}
function blFrame(st,N,hz,lv,o){
  const now=o.now;
  if(!(o.res>0) || N<2) return {recs:[], active:st.ev.filter(e=>e.ok), learning:0, floor:st.floor};
  if(st.res!==o.res){ const keep=st.res===0; Object.assign(st,blNew(),{res:o.res,t0:now}); if(!keep) st.ev=[]; }
  if(!st.t0) st.t0=now;
  const res=st.res;
  // ячейки: максимум бинов, попавших в ячейку
  const cg=new Int32Array(N), cl=new Float32Array(N); let C=0, lastG=NaN;
  for(let i=0;i<N;i++){
    const g=Math.round(hz(i)/res), x=lv(i);
    if(!isFinite(x)) continue;
    if(g===lastG){ if(x>cl[C-1]) cl[C-1]=x; }
    else if(C===0 || g>cg[C-1]){ cg[C]=g; cl[C]=x; C++; lastG=g; }
  }
  if(!C) return {recs:[], active:st.ev.filter(e=>e.ok), learning:0, floor:st.floor};
  if(!blEnsure(st,cg[0],cg[C-1])) return {recs:[], active:[], learning:0, floor:st.floor};
  const floor=blMedian(cl,C); st.floor=floor; st.frames++;
  const al=1/Math.max(2,o.adapt), as=al/20, ao=Math.max(al,1/50), g0=st.g0;
  const an=new Uint8Array(C), ms=new Uint8Array(C), exv=new Float32Array(C); let learned=0;
  for(let k=0;k<C;k++){
    const j=cg[k]-g0, L=cl[k], n=st.cnt[j];
    if(n===0){ st.mu[j]=L; st.v[j]=0; st.occ[j]=L>floor+(o.occThr||8) ? 1 : 0; st.cnt[j]=1; continue; }
    const ex=L-st.mu[j]; exv[k]=ex;
    if(n<o.learn || o.learnOnly){                       // обучение: скользящее среднее, без отчётов
      const a=n<o.learn ? 1/(n+1) : al;
      st.mu[j]+=a*ex; st.v[j]+=a*(ex*ex*(n/(n+1))-st.v[j]);
      st.occ[j]+=a*((L>floor+(o.occThr||8) ? 1 : 0)-st.occ[j]);
      if(n<65535) st.cnt[j]=n+1; continue;
    }
    learned++;
    const sd=Math.max(Math.sqrt(st.v[j]),o.sdMin);
    const hit=ex>o.thr && ex>o.z*sd;
    if(hit) an[k]=1;
    else if(st.occ[j]>=o.occMin && L<floor+(o.occFloor||3) && ex<-o.drop) ms[k]=1;
    if(hit){ st.mu[j]+=as*ex; }
    else { st.mu[j]+=al*ex; st.v[j]+=al*(ex*ex-st.v[j]); }
    st.occ[j]+=ao*((L>floor+(o.occThr||8) ? 1 : 0)-st.occ[j]);
    if(st.cnt[j]<65535) st.cnt[j]++;
  }
  // кластеры соседних ячеек (допуск gap ячеек)
  const gap=o.gap==null ? 1 : o.gap, cl2=[];
  const scan=(flag,kind)=>{
    let a=-1, last=-1;
    const close=()=>{
      if(a<0) return;
      let pk=a;
      for(let k=a;k<=last;k++) if(flag[k] && (!flag[pk] || Math.abs(exv[k])>Math.abs(exv[pk]))) pk=k;
      const lo=cg[a]*res-res/2, hi=cg[last]*res+res/2;
      cl2.push({kind, lo, hi, f:cg[pk]*res, bw:hi-lo, peak:cl[pk], ex:Math.abs(exv[pk]), cells:last-a+1});
      a=-1;
    };
    for(let k=0;k<C;k++){
      if(flag[k]){ if(a>=0 && cg[k]-cg[last]-1>gap) close(); if(a<0) a=k; last=k; }
      else if(a>=0 && cg[k]-cg[last]-1>gap) close();
    }
    close();
  };
  scan(an,'new'); scan(ms,'missing');
  for(const c of cl2) if(c.kind==='new' && c.bw>=o.wideBw) c.kind='wideband';
  // трекинг событий между кадрами: совпадение по пересечению полосы с запасом
  const recs=[];
  for(const e of st.ev) e.seen=false;
  for(const c of cl2){
    const tol=Math.max(c.bw,3*res);
    let e=st.ev.find(x=>x.kind===c.kind && !x.seen && Math.abs(x.f-c.f)<=Math.max(tol,x.bw));
    if(!e){ e={kind:c.kind, t0:now, hits:0, ok:false, seen:false, peak:-Infinity, ex:0}; st.ev.push(e); }
    e.seen=true; e.last=now; e.hits++; e.f=c.f; e.lo=c.lo; e.hi=c.hi; e.bw=c.bw;
    if(c.kind==='missing' ? c.peak<e.peak || e.peak===-Infinity : c.peak>e.peak) e.peak=c.peak;
    e.ex=Math.max(e.ex,c.ex);
    if(!e.ok && e.hits>=o.confirm){
      e.ok=true; e.tOk=now;
      recs.push({t:Date.now(), src:'BASELINE', kind:e.kind, id:Math.round(e.f/Math.max(res,1))*Math.max(res,1)+'', freq:Math.round(e.f), bw:Math.round(e.bw),
        db:+e.peak.toFixed(1), excess:+e.ex.toFixed(1), floor:+floor.toFixed(1), status:'start'});
    }
  }
  for(let i=st.ev.length-1;i>=0;i--){
    const e=st.ev[i];
    if(e.seen) continue;
    if(now-e.last>o.hold){
      if(e.ok) recs.push({t:Date.now(), src:'BASELINE', kind:e.kind, id:Math.round(e.f/Math.max(res,1))*Math.max(res,1)+'', freq:Math.round(e.f), bw:Math.round(e.bw),
        db:+e.peak.toFixed(1), excess:+e.ex.toFixed(1), floor:+floor.toFixed(1), status:'end', dur:+((e.last-e.tOk)/1000).toFixed(1)});
      st.ev.splice(i,1);
    }
  }
  return {recs, active:st.ev.filter(e=>e.ok && e.seen), learning:learned/C, floor};
}
// Норма в точке f, дБ (null — ячейки нет или она ещё не обучена)
function blAt(st,f){
  if(!st.mu) return null;
  const j=Math.round(f/st.res)-st.g0;
  return j>=0 && j<st.cap && st.cnt[j] ? st.mu[j] : null;
}
function blB64(u8){ let s=''; for(let i=0;i<u8.length;i+=8192) s+=String.fromCharCode.apply(null,u8.subarray(i,i+8192)); return btoa(s); }
function blUnB64(s){ const b=atob(s), u=new Uint8Array(b.length); for(let i=0;i<b.length;i++) u[i]=b.charCodeAt(i); return u; }
// Сохранение: ячейки в Int16 (дБ·100), σ в Uint8 (·20 дБ), occ в Uint8, число посещений в Uint16 — ~7 байт на ячейку
function blSave(st){
  if(!st.mu) return null;
  const n=st.cap, mu=new Int16Array(n), sd=new Uint8Array(n), oc=new Uint8Array(n);
  for(let i=0;i<n;i++){ mu[i]=Math.max(-32768,Math.min(32767,Math.round(st.mu[i]*100))); sd[i]=Math.min(255,Math.round(Math.sqrt(st.v[i])*20)); oc[i]=Math.round(st.occ[i]*255); }
  const u8=a=>new Uint8Array(a.buffer,a.byteOffset,a.byteLength);
  return {v:1, res:st.res, g0:st.g0, cap:n, mu:blB64(u8(mu)), sd:blB64(sd), occ:blB64(oc), cnt:blB64(u8(st.cnt))};
}
function blLoad(st,d){
  if(!d || d.v!==1 || !(d.res>0) || !(d.cap>0) || d.cap>8e6) return false;
  const n=d.cap;
  let bm, sd, oc, bc;
  try{ bm=blUnB64(d.mu); sd=blUnB64(d.sd); oc=blUnB64(d.occ); bc=blUnB64(d.cnt); }catch(e){ return false; }
  if(bm.length!==2*n || bc.length!==2*n || sd.length!==n || oc.length!==n) return false;
  const mu=new Int16Array(bm.buffer), cn=new Uint16Array(bc.buffer);
  Object.assign(st,blNew(),{res:d.res, g0:d.g0, cap:n, t0:0});
  st.mu=new Float32Array(n); st.v=new Float32Array(n); st.occ=new Float32Array(n); st.cnt=cn;
  for(let i=0;i<n;i++){ st.mu[i]=mu[i]/100; const s=sd[i]/20; st.v[i]=s*s; st.occ[i]=oc[i]/255; }
  return true;
}
