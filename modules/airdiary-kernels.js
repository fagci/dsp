"use strict";
/* ============================ Air Diary: ядро ============================
   Дневник эфира без DOM (node tools/test-airdiary.mjs): из кадров спектра копит, КОГДА и НА КАКИХ частотах эфир был занят, и находит
   повторяющиеся передатчики.
   · Ячейки — сетка по частоте шириной res Гц (как у Spectrum Baseline). Ячейка занята в кадре, если выше пола (медианы кадра) на thr дБ.
   · Слот — отрезок времени slotMin минут; в слоте на каждую занятую ячейку: сколько кадров она была занята, сумма и максимум уровня.
     Знаменатель — сколько кадров слот вообще смотрел на ячейку (cov: диапазоны кадров), поэтому смена частоты SDR не портит доли.
   · Тепловая карта — «час суток × частота» (занятость, доля кадров) или «день × частота»; хранится days суток, старое забывается.
   · Дорожки (tracks) — отдельные передатчики: кластер занятых ячеек, пережитый confirm кадров подряд, — всплеск (burst) до паузы hold мс.
     По всплескам: период (медиана интервалов), регулярность (доля интервалов, кратных периоду в допуске), скважность — «маяк»/«периодический»;
     сплошная несущая — «continuous»; тот же час суток в разные дни — «daily». */

const AD_KINDS=['beacon','periodic','continuous','daily'];

function adNew(){ return {v:1, res:0, slotMin:60, slots:new Map(), tracks:[], bursts:[], frames:0, t0:0, floor:null, seq:0}; }
const adSlotMs=st=>Math.max(1,st.slotMin||60)*60000;
const adSlotOf=(st,t)=>Math.floor(t/adSlotMs(st));
function adMedian(a,n){ const s=Math.max(1,Math.floor(n/512)), t=[]; for(let i=0;i<n;i+=s) t.push(a[i]); t.sort((x,y)=>x-y); return t[t.length>>1]; }
function adSlot(st,idx){ let s=st.slots.get(idx); if(!s){ s={n:0, cov:new Map(), c:new Map()}; st.slots.set(idx,s); } return s; }
function adPrune(st,now,days){
  const keep=adSlotOf(st,now)-Math.ceil(Math.max(1,days)*86400000/adSlotMs(st));
  for(const k of st.slots.keys()) if(k<keep) st.slots.delete(k);
  const tmin=now-Math.max(1,days)*86400000, tmin2=Math.max(1,days)*86400000;
  st.bursts=st.bursts.filter(b=>b.t+b.dur>=tmin);
  for(const tr of st.tracks){ tr.bursts=tr.bursts.filter(b=>b.t+b.dur>=tmin); for(const d of Object.keys(tr.hrs)) if(+d<Math.floor(tmin/86400000)) delete tr.hrs[d]; }
  st.tracks=st.tracks.filter(tr=>tr.bursts.length || tr.active || now-tr.last<tmin2);
}

// ---- дневные часы дорожки: день (номер суток по местному времени) → маска часов ----
const adDayNo=t=>{ const d=new Date(t); return Math.floor(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())/86400000); };
function adMarkHours(tr,t0,t1){
  for(let t=t0, guard=0; guard<30; guard++){
    const d=new Date(t), day=adDayNo(t), h=d.getHours();
    tr.hrs[day]=(tr.hrs[day]|0)|(1<<h);
    const nx=new Date(d.getFullYear(),d.getMonth(),d.getDate(),h+1).getTime();
    if(nx>t1) break; t=nx;
  }
}

// ---- периодичность по всплескам ----
// → {period (с), regular (0…1), duty (0…1), n} или null, если мало данных
function adPeriod(bursts,tol){
  const b=bursts.slice(-200); if(b.length<3) return null;
  const d=[]; for(let i=1;i<b.length;i++) d.push(b[i].t-b[i-1].t);
  const sorted=d.slice().sort((x,y)=>x-y), per=sorted[sorted.length>>1]; if(!(per>0)) return null;
  const tl=Math.max(.02,+tol||.1); let ok=0;
  for(const x of d){ const k=Math.round(x/per); if(k>=1 && k<=6 && Math.abs(x-k*per)<=tl*per*Math.max(1,Math.sqrt(k))) ok++; }
  let on=0; for(const x of b) on+=x.dur;
  const span=b[b.length-1].t+b[b.length-1].dur-b[0].t;
  return {period:per/1000, regular:ok/d.length, duty:span>0 ? Math.min(1,on/span) : 0, n:b.length};
}
// «каждый день в этот час»: {hour, days, of} или null
function adDaily(tr,minDays,share){
  const days=Object.keys(tr.hrs).map(Number); if(days.length<(minDays||3)) return null;
  const cnt=new Array(24).fill(0);
  for(const d of days) for(let h=0;h<24;h++) if(tr.hrs[d]&(1<<h)) cnt[h]++;
  let bh=0; for(let h=1;h<24;h++) if(cnt[h]>cnt[bh]) bh=h;
  if(cnt[bh]>=(minDays||3) && cnt[bh]>=(share||.6)*days.length) return {hour:bh, days:cnt[bh], of:days.length};
  return null;
}

// Решение о дорожке: какие виды у неё подтверждены; возвращает новые отчёты
function adJudge(st,tr,o,now){
  const out=[], pr=adPeriod(tr.bursts,o.tol);
  const mk=(kind,extra,status)=>({t:now, src:'AIRDIARY', kind, id:tr.id, freq:Math.round(tr.f), bw:Math.round(tr.bw), db:+tr.pk.toFixed(1), count:tr.bursts.length, status,
    first:tr.t0, last:tr.last, ...extra});
  if(pr && tr.bursts.length>=o.minBursts && pr.regular>=o.regular){
    const kind=pr.duty<.1 ? 'beacon' : 'periodic', key={period:+pr.period.toFixed(pr.period<10 ? 2 : 1), duty:+(pr.duty*100).toFixed(1), regular:+(pr.regular*100).toFixed(0)};
    const had=tr.kinds[kind];
    if(!had || Math.abs(pr.period-had.period)/had.period>.15 || tr.bursts.length>=had.n*2){
      delete tr.kinds.beacon; delete tr.kinds.periodic;
      tr.kinds[kind]={period:pr.period, n:tr.bursts.length}; out.push(mk(kind,key,had ? 'update' : 'new'));
    }
  }
  const dl=adDaily(tr,o.minDays,.6);
  if(dl && !tr.kinds.daily){ tr.kinds.daily={hour:dl.hour}; out.push(mk('daily',{hour:dl.hour, days:dl.days, of:dl.of},'new')); }
  return out;
}

// Один кадр спектра: N бинов, hz(i) — частота (возрастает), lv(i) — дБ.
// o: {res, slotMin, thr, confirm, hold, gap, now, contMs, minBursts, regular, tol, minDays, maxTracks, maxCells}
// → {recs, active (дорожки, занятые сейчас), floor, occ (доля занятых ячеек кадра)}
function adFrame(st,N,hz,lv,o){
  const now=o.now;
  if(!(o.res>0) || N<2) return {recs:[], active:[], floor:st.floor, occ:0};
  if(st.res && st.res!==o.res){ st.slots=new Map(); st.tracks=[]; st.bursts=[]; }     // сетка сменилась — старые данные в другой мере
  st.res=o.res; st.slotMin=o.slotMin||st.slotMin||60; if(!st.t0) st.t0=now;
  const res=o.res, cg=new Int32Array(N), cl=new Float32Array(N); let C=0, lastG=NaN;
  for(let i=0;i<N;i++){
    const g=Math.round(hz(i)/res), x=lv(i); if(!isFinite(x)) continue;
    if(g===lastG){ if(x>cl[C-1]) cl[C-1]=x; }
    else if(C===0 || g>cg[C-1]){ cg[C]=g; cl[C]=x; C++; lastG=g; }
  }
  if(!C) return {recs:[], active:[], floor:st.floor, occ:0};
  const floor=adMedian(cl,C); st.floor=floor; st.frames++;
  const thr=floor+o.thr, slot=adSlot(st,adSlotOf(st,now)), maxCells=o.maxCells||20000;
  slot.n++; const ck=cg[0]+':'+cg[C-1], cv=slot.cov.get(ck); if(cv) cv.n++; else slot.cov.set(ck,{a:cg[0],b:cg[C-1],n:1});
  const hit=new Uint8Array(C); let nh=0;
  for(let k=0;k<C;k++) if(cl[k]>thr){
    hit[k]=1; nh++;
    let c=slot.c.get(cg[k]);
    if(!c){ if(slot.c.size>=maxCells) continue; c=[0,0,-200]; slot.c.set(cg[k],c); }
    c[0]++; c[1]+=cl[k]; if(cl[k]>c[2]) c[2]=cl[k];
  }
  // кластеры занятых ячеек (допуск gap пустых ячеек)
  const gap=o.gap==null ? 1 : o.gap, sig=[]; let a=-1, last=-1;
  const close=()=>{ if(a<0) return; let pk=a; for(let k=a;k<=last;k++) if(cl[k]>cl[pk]) pk=k;
    sig.push({f:cg[pk]*res, lo:cg[a]*res-res/2, hi:cg[last]*res+res/2, pk:cl[pk]}); a=-1; };
  for(let k=0;k<C;k++){
    if(hit[k]){ if(a>=0 && cg[k]-cg[last]-1>gap) close(); if(a<0) a=k; last=k; }
    else if(a>=0 && cg[k]-cg[last]-1>gap) close();
  }
  close();
  // дорожки
  for(const tr of st.tracks) tr.seen=false;
  for(const s of sig){
    let tr=null, bd=Infinity;
    for(const t of st.tracks){ const d=Math.abs(t.f-s.f); if(!t.seen && d<=Math.max(2*res,(t.bw+(s.hi-s.lo))/2) && d<bd){ tr=t; bd=d; } }
    if(!tr){
      if(st.tracks.length>=(o.maxTracks||400)){ let w=0; for(let i=1;i<st.tracks.length;i++) if(st.tracks[i].last<st.tracks[w].last) w=i; if(st.tracks[w].active){ continue; } st.tracks.splice(w,1); }
      tr={id:Math.round(s.f/res)*res+'', f:s.f, lo:s.lo, hi:s.hi, bw:s.hi-s.lo, pk:s.pk, t0:now, last:now, run:0, active:false, since:0, bursts:[], hrs:{}, kinds:{}, seen:false, cont:false, db:s.pk};
      st.tracks.push(tr);
    }
    tr.seen=true; tr.last=now; tr.run++;
    tr.f+= (s.f-tr.f)*.05; tr.lo=Math.min(tr.lo+res*.02,s.lo); tr.hi=Math.max(tr.hi-res*.02,s.hi); tr.bw=tr.hi-tr.lo;
    tr.db=s.pk; if(!tr.active || s.pk>tr.pk) tr.pk=s.pk;
    if(!tr.active && tr.run>=o.confirm){ tr.active=true; tr.since=now; tr.cont=false; }
  }
  const recs=[], active=[];
  for(const tr of st.tracks){
    if(!tr.seen){ tr.run=0;
      if(tr.active && now-tr.last>o.hold){                          // всплеск кончился
        tr.active=false; const dur=Math.max(1,tr.last-tr.since), b={t:tr.since, dur, db:+tr.pk.toFixed(1)};
        tr.bursts.push(b); if(tr.bursts.length>200) tr.bursts.shift();
        st.bursts.push({t:b.t, dur, freq:Math.round(tr.f), bw:Math.round(tr.bw), rssi:b.db, id:tr.id}); if(st.bursts.length>20000) st.bursts.shift();
        adMarkHours(tr,b.t,b.t+dur);
        for(const r of adJudge(st,tr,o,now)) recs.push(r);
      }
    }
    if(tr.active){
      active.push(tr);
      if(!tr.cont && now-tr.since>=o.contMs){                       // не гаснет — несущая
        tr.cont=true; adMarkHours(tr,tr.since,now);
        if(!tr.kinds.continuous){ tr.kinds.continuous={}; recs.push({t:now, src:'AIRDIARY', kind:'continuous', id:tr.id, freq:Math.round(tr.f), bw:Math.round(tr.bw), db:+tr.pk.toFixed(1), count:tr.bursts.length, status:'new', first:tr.t0, last:now, duty:100}); }
      }
    }
  }
  return {recs, active, floor, occ:nh/C};
}

/* ---- тепловая карта ----
   o: {mode:'hour'|'day', days, now, cols (макс. колонок), f0, f1 (Гц, необязательно)}
   → {res, f0, f1, cols, rows:[{label, occ:Float32Array(cols), db:Float32Array(cols), frames}], gLo, step} — step ячеек на колонку */
function adHeat(st,o){
  const now=o.now, days=Math.max(1,o.days||7), res=st.res; if(!res || !st.slots.size) return null;
  const minSlot=adSlotOf(st,now)-Math.ceil(days*86400000/adSlotMs(st));
  let gLo=Infinity, gHi=-Infinity;
  for(const [k,s] of st.slots){ if(k<minSlot) continue; for(const c of s.cov.values()){ if(c.a<gLo) gLo=c.a; if(c.b>gHi) gHi=c.b; } }
  if(o.f0!=null) gLo=Math.max(gLo,Math.floor(o.f0/res)); if(o.f1!=null) gHi=Math.min(gHi,Math.ceil(o.f1/res));
  if(!isFinite(gLo) || gHi<gLo) return null;
  const nCell=gHi-gLo+1, cols=Math.min(o.cols||600,nCell), step=nCell/cols;
  const groups=new Map();                                         // ключ строки → {label, hits, vis, sum, mx}
  const grp=(key,label)=>{ let g=groups.get(key); if(!g){ g={label, key, hits:new Float64Array(nCell), vis:new Float64Array(nCell), sum:new Float64Array(nCell), frames:0}; groups.set(key,g); } return g; };
  for(const [k,s] of st.slots){
    if(k<minSlot) continue;
    const d=new Date(k*adSlotMs(st)), h=d.getHours();
    const g= o.mode==='day' ? grp(adDayNo(d.getTime()), d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')) : grp(h, String(h).padStart(2,'0')+':00');
    g.frames+=s.n;
    for(const c of s.cov.values()){ const a=Math.max(c.a,gLo), b=Math.min(c.b,gHi); for(let x=a;x<=b;x++) g.vis[x-gLo]+=c.n; }
    for(const [x,c] of s.c){ if(x<gLo || x>gHi) continue; g.hits[x-gLo]+=c[0]; g.sum[x-gLo]+=c[1]; }
  }
  let keys=[...groups.keys()].sort((a,b)=>a-b);
  if(o.mode!=='day'){ for(let h=0;h<24;h++) if(!groups.has(h)) grp(h,String(h).padStart(2,'0')+':00'); keys=[...Array(24).keys()]; }
  const rows=keys.map(key=>{
    const g=groups.get(key), occ=new Float32Array(cols), db=new Float32Array(cols).fill(NaN);
    for(let c=0;c<cols;c++){
      const x0=Math.floor(c*step), x1=Math.max(x0+1,Math.floor((c+1)*step)); let best=0, bdb=NaN;
      for(let x=x0;x<x1&&x<nCell;x++){ const v=g.vis[x]>0 ? g.hits[x]/g.vis[x] : 0; if(v>best){ best=v; bdb=g.hits[x]>0 ? g.sum[x]/g.hits[x] : NaN; } }
      occ[c]=best; db[c]=bdb;
    }
    return {label:g.label, key, occ, db, frames:g.frames};
  });
  return {res, gLo, step, cols, f0:gLo*res, f1:(gHi+1)*res, rows};
}
// строки для Table: только непустые ячейки карты
function adHeatRows(h,minOcc){
  if(!h) return []; const out=[], mo=minOcc==null ? .005 : minOcc;
  for(const r of h.rows) for(let c=0;c<h.cols;c++) if(r.occ[c]>=mo)
    out.push({when:r.label, freq:Math.round(h.f0+(c+.5)*h.step*h.res), occ:+(r.occ[c]*100).toFixed(1), db:isFinite(r.db[c]) ? +r.db[c].toFixed(1) : null});
  return out;
}
// отчёт о дорожках для Table
function adTrackRows(st){
  return st.tracks.filter(t=>t.bursts.length||t.cont).map(tr=>{
    const pr=adPeriod(tr.bursts,.1), dl=adDaily(tr,3,.6), k=Object.keys(tr.kinds).filter(x=>tr.kinds[x]);
    return {id:tr.id, freq:Math.round(tr.f), bw:Math.round(tr.bw), kind:k.join('+')||'sporadic', period:pr ? +pr.period.toFixed(pr.period<10 ? 2 : 1) : null,
      regular:pr ? Math.round(pr.regular*100) : null, duty:pr ? +(pr.duty*100).toFixed(1) : (tr.cont ? 100 : null), count:tr.bursts.length, db:+tr.pk.toFixed(1),
      hour:dl ? dl.hour : null, first:tr.first||tr.t0, last:tr.last, active:tr.active?1:0};
  }).sort((a,b)=>(b.kind!=='sporadic')-(a.kind!=='sporadic') || b.count-a.count);
}

/* ---- хранение ---- */
function adSave(st){
  return {v:1, res:st.res, slotMin:st.slotMin, t0:st.t0, frames:st.frames,
    slots:[...st.slots].map(([k,s])=>[k,s.n,[...s.cov.values()].map(c=>[c.a,c.b,c.n]),[...s.c].map(([g,c])=>[g,c[0],c[1],c[2]])]),
    tracks:st.tracks.map(t=>({id:t.id,f:t.f,lo:t.lo,hi:t.hi,bw:t.bw,pk:t.pk,t0:t.t0,last:t.last,bursts:t.bursts,hrs:t.hrs,kinds:t.kinds,cont:t.cont})),
    bursts:st.bursts.slice(-5000)};
}
function adLoad(st,d){
  if(!d || d.v!==1 || !Array.isArray(d.slots)) return false;
  Object.assign(st,adNew()); st.res=d.res||0; st.slotMin=d.slotMin||60; st.t0=d.t0||0; st.frames=d.frames||0;
  for(const [k,n,cov,cells] of d.slots){ const s={n, cov:new Map(), c:new Map()}; for(const [a,b,m] of cov) s.cov.set(a+':'+b,{a,b,n:m}); for(const [g,h,sm,mx] of cells) s.c.set(g,[h,sm,mx]); st.slots.set(k,s); }
  st.tracks=(d.tracks||[]).map(t=>({...t,run:0,active:false,since:0,seen:false,db:t.pk,kinds:t.kinds||{},hrs:t.hrs||{},bursts:t.bursts||[]}));
  st.bursts=d.bursts||[];
  return true;
}

if(typeof module!=='undefined') module.exports={AD_KINDS,adNew,adFrame,adHeat,adHeatRows,adTrackRows,adPeriod,adDaily,adSave,adLoad,adPrune,adSlotOf,adMarkHours,adDayNo};
