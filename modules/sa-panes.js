"use strict";
/* ======================= SA: MULTIBAND PANES ======================= */
// Режим layout=panes у 'sa': рядом несколько диапазонов (из входа bands, например отмеченные
// списки Table), у каждого свой спектр сверху и водопад снизу. Спектр приходит окнами
// (Band Scanner перестраивает приёмник, либо sweep сразу накрывает несколько панелей) —
// каждое окно раскладывается по ВСЕМ диапазонам списка, куда попало; остальное держит прошлые данные.
// Панелей на экране panes штук, остальные диапазоны копят данные и листаются (колесо на заголовке,
// стрелки внизу, либо сами следуют за сканером — follow).
// Состояние диапазона не зависит от размера канвы: SAP_RES столбцов спектра, SAP_WRES × SAP_ROWS водопада.
// Края окна приёмника проседают (фильтр) — edge, % окна с каждой стороны, отбрасывается: без этого в
// широком диапазоне видны периодические «горбы» по шагу окна.

const SAP_RES=2048, SAP_WRES=1024, SAP_ROWS=96, SAP_GAP=4, SAP_AXIS=14, SAP_TITLE=13, SAP_MAXB=128;
// история водопада — 1 байт на пиксель (0 — пусто); картинка RGBA живёт только у панелей на экране
const SAP_DB0=-160, SAP_DBS=.75;
const sapCode=db=>db!==db ? 0 : Math.max(1,Math.min(255,Math.round((db-SAP_DB0)/SAP_DBS)+1));
const SAP_HINT='wheel / pinch — zoom · drag — pan (zoomed) · vertical drag, Ctrl+wheel, vertical pinch — dB range of a pane · double click / double tap — reset view · wheel on a title or swipe it — next/previous bands\n'+
  'tap — marker · tap a title — retune the receiver · Shift+tap / long press / «⊘ skip» button + tap on a ▼ signal — skip it (the same on a ⊘ — return it)';

// все диапазоны списка по возрастанию lo
function saPaneList(n){
  const src=n.bandsData, len=src ? src.length : 0;
  if(n._plSrc===src && n._plLen===len) return n._pl;
  n._plSrc=src; n._plLen=len;
  n._pl=(Array.isArray(src) ? src : []).filter(b=>b && !b.sig && isFinite(b.lo) && isFinite(b.hi) && b.hi>b.lo)
    .slice().sort((a,b)=>a.lo-b.lo).slice(0,SAP_MAXB);
  if(n._pnStore) for(const k of [...n._pnStore.keys()]) if(!n._pl.some(b=>b.lo+'-'+b.hi===k)) n._pnStore.delete(k);
  return n._pl;
}
// состояние диапазона (создаётся при первом обращении, живёт, пока диапазон в списке)
function saPaneGet(n,b){
  const store=n._pnStore||(n._pnStore=new Map()), key=b.lo+'-'+b.hi;
  let p=store.get(key);
  if(!p){
    p={key, lo:b.lo, hi:b.hi, label:'', color:'', lv:new Float32Array(SAP_RES).fill(NaN), pk:new Float32Array(SAP_RES).fill(NaN),
      wdb:new Uint8Array(SAP_WRES*SAP_ROWS), db:null,
      t:0, img:null, off:null, ocx:null, dirty:false, med:-120, det:null, zoom:null,
      // строка водопада достраивается полосками за проход диапазона; сдвиг — только когда она закончена (rowLv — уровни текущей строки)
      rowLv:new Float32Array(SAP_RES).fill(NaN), rowN:0, rowFull:false, rowOpen:false, rowT0:0, lastC:null, curWin:null};
    try{ const o=JSON.parse(n.p.paneDb||'{}'); if(Array.isArray(o[key])) p.db=o[key]; }catch(e){}
    store.set(key,p);
  }
  p.label=b.label||''; p.color=b.color||''; p.step=b.step||0;
  if(n.p.detect && !p.det){
    // фасад: list/floorDb — сводка; у каждого источника спектра (приёмника) свой cfarFrame — кадры разных приёмников не сбивают
    // подтверждение цели друг другу; цели вне окна приёмника живут дольше (keepOutside)
    p.det={list:[], floorDb:null, srcs:[]};
  } else if(!n.p.detect && p.det) p.det=null;
  return p;
}
// детектор приёмника src в диапазоне p (заглушка узла для cfarFrame)
function saDetSrc(n,p,src){
  return p.det.srcs[src]||(p.det.srcs[src]={p:{auto:false,fmin:p.lo,fmax:p.hi,method:'OS',guard:4,train:32,thr:n.p.detThr,minW:2,confM:2,
    confN:3,top:10,hold:1500,idRes:'auto'}, keepOutside:30000, list:[], tracks:[], recs:[], skip:null, floorDb:null});
}
// сводный список целей панели: от всех приёмников, без повторов одной и той же частоты
function saDetMerge(p){
  const L=[];
  for(const d of p.det.srcs) if(d) for(const t of d.list) L.push(t);
  L.sort((a,b)=>b.db-a.db);
  const out=[];
  for(const t of L) if(!out.some(o=>Math.abs(o.f-t.f)<=Math.max(5000,o.w,t.w))) out.push(t);
  p.det.list=out.slice(0,10);
}
// панели на экране
function saPaneState(n){
  const list=saPaneList(n), k=Math.max(1,n.p.panes|0), from=clamp(n.p.paneFrom|0,0,Math.max(0,list.length-1));
  const shown=list.slice(from,from+k).map(b=>saPaneGet(n,b));
  for(const p of shown) if(!p.img) saPaneFill(n,p);
  for(const p of (n._pnStore||new Map()).values()) if(p.img && !shown.includes(p)){ p.img=null; p.off=null; p.ocx=null; p.dirty=false; }
  return n._pn=shown;
}
const saPaneView=p=>p.zoom || [p.lo,p.hi];
function saSetFrom(n,v,manual){
  const list=saPaneList(n), k=Math.max(1,n.p.panes|0);
  v=clamp(v,0,Math.max(0,list.length-k));
  if(v===(n.p.paneFrom|0)) return;
  if(manual) n._pnManT=performance.now();
  if(n.set && n.set.paneFrom) n.set.paneFrom(v); else n.p.paneFrom=v;
  n._pnRevDraw=(n._pnRevDraw|0)+1;
}

/* ---------- список пропуска ---------- */
// свой список (p.skipList: [{f,w}]) + вход skip (диапазоны Table); общий вид — диапазоны {lo,hi} для cfarFrame
function saSkipSync(n){
  if(n._skSrc!==n.p.skipList){
    n._skSrc=n.p.skipList;
    try{ const a=JSON.parse(n.p.skipList||'[]'); n._skipInt=Array.isArray(a) ? a.filter(x=>x && isFinite(x.f) && isFinite(x.w)) : []; }
    catch(e){ n._skipInt=[]; }
    n._skKey=null;
  }
  const ext=n._skipExt||[], key=n._skSrc+'|'+ext.length;
  if(n._skKey===key) return n._skipR;
  n._skKey=key;
  n._skipR=[...ext, ...n._skipInt.map(x=>({lo:x.f-x.w/2, hi:x.f+x.w/2}))];
  for(const p of (n._pnStore ? n._pnStore.values() : [])) if(p.det){
    for(const d of p.det.srcs) if(d){
      d.skip=n._skipR;
      d.tracks=d.tracks.filter(t=>!cfarSkipped(n._skipR,t.f,t.w));
      d.list=d.list.filter(t=>!cfarSkipped(n._skipR,t.f,t.w));
    }
    saDetMerge(p);
  }
  return n._skipR;
}
function saSkipSave(n){
  n.p.skipList=JSON.stringify(n._skipInt.map(x=>({f:Math.round(x.f),w:Math.round(x.w)})));
  saSkipSync(n); n._pnRevDraw=(n._pnRevDraw|0)+1;
}
// диапазон дБ панели: свой (жесты) или общий floor/top
const saPaneRange=(n,p)=>p.db||[n.p.floor,n.p.top];
function saDbSave(n){
  const o={}; if(n._pnStore) for(const p of n._pnStore.values()) if(p.db) o[p.key]=p.db.map(x=>Math.round(x*10)/10);
  n.p.paneDb=Object.keys(o).length ? JSON.stringify(o) : '';
}
// картинка водопада из истории уровней
function saPaneFill(n,p){
  const pal=paletteLut(n.p.palette), [fl,tp]=saPaneRange(n,p), rng=(tp-fl)||1;
  if(!p.img) p.img=new ImageData(SAP_WRES,SAP_ROWS);
  const d=p.img.data;
  for(let i=0,o=0;i<p.wdb.length;i++,o+=4){
    const c=p.wdb[i]; d[o+3]=255;
    if(!c){ d[o]=d[o+1]=d[o+2]=0; continue; }
    const hk=heatIdx((SAP_DB0+(c-1)*SAP_DBS-fl)/rng)*3; d[o]=pal[hk]; d[o+1]=pal[hk+1]; d[o+2]=pal[hk+2];
  }
  p.dirty=true;
}
// водопад перекрашивается из истории уровней (панели вне экрана — при показе)
function saPaneRepaint(n,p){
  if(!p.img) return;
  saPaneFill(n,p); saPanesBump(n);
}
// подогнать диапазон каждой панели под её данные: от шума −8 дБ до максимума +8 дБ
function saDbAuto(n){
  for(const p of (n._pnStore||new Map()).values()){
    const t=Float32Array.from(p.lv).filter(v=>v===v).sort();
    if(t.length<8) continue;
    const lo=t[Math.floor(t.length*.05)]-8, hi=Math.max(t[t.length-1]+8,lo+30);
    p.db=[Math.floor(lo),Math.ceil(hi)]; saPaneRepaint(n,p);
  }
  saDbSave(n);
}
function saPeakClear(n){
  if(n._pnStore) for(const p of n._pnStore.values()) p.pk.fill(NaN);
  n._pnRevDraw=(n._pnRevDraw|0)+1;
}
function saSkipClear(n){ n._skipInt=[]; saSkipSave(n); }

/* ---------- накопление ---------- */
// новое окно спектра → диапазоны
// src — номер входа спектра (0 — spec, 1–3 — spec2…spec4): несколько приёмников сканируют вместе
function saPanesIngest(n,sp,src=0){
  if(!sp || !sp.mag) return;
  const st=(n._pnSrc||(n._pnSrc=[]))[src]||(n._pnSrc[src]={});
  if(sp===st.sp && sp.rev===st.rev) return;
  st.sp=sp; st.rev=sp.rev;
  const list=saPaneList(n); if(!list.length) return;
  const N=sp.mag.length, now=performance.now();
  if(N<2) return;
  const [sLo,sHi]=specSpan(sp);
  // первый кадр после смены окна может нести недосевшую частоту — не пишем (после быстрой перестройки давал повторяющийся узор)
  const cKey=Math.round((sLo+sHi)/2e3);
  if(st.cKey!==undefined && st.cKey!==cKey){ st.cKey=cKey; return; }
  st.cKey=cKey;
  const cut=(sHi-sLo)*clamp(+n.p.edge||0,0,40)/100, uLo=sLo+cut, uHi=sHi-cut;
  // пик на центре окна приёмника (утечка гетеродина / DC) есть в каждом окне и выглядит как сигнал: центральные бины заменяем
  // интерполяцией соседних (только для окон одного приёмника — у широкой развёртки середина спектра не особая)
  let m=sp.mag, sc=sp;
  const dcHz=Math.max(0,+n.p.dcCut||0)*1000;
  if(dcHz>0 && sp.freqs && sHi-sLo<=12e6){
    const ci=N>>1, binHz=Math.abs(specHz(sp,ci)-specHz(sp,ci-1))||1, w=Math.max(3,Math.ceil(dcHz/binHz)), wMax=Math.max(w,Math.ceil(dcHz*5/binHz));
    // юбка пика несимметрична и шире заданного: вырез расширяется в каждую сторону, пока уровень выше шума (медиана +3 дБ)
    const thr=Float32Array.from(sp.mag).sort()[N>>1]*1.41;
    let a=Math.max(0,ci-w-1), b=Math.min(N-1,ci+w+1);
    while(a>0 && ci-a<wMax && sp.mag[a]>thr) a--;
    while(b<N-1 && b-ci<wMax && sp.mag[b]>thr) b++;
    if(b-a>2){ m=Float32Array.from(sp.mag); for(let i=a+1;i<b;i++) m[i]=sp.mag[a]+(sp.mag[b]-sp.mag[a])*(i-a)/(b-a); sc={...sp, mag:m}; }
  }
  // следование за сканером: окно ушло в диапазон вне экрана — перелистнуть на его страницу
  if(src===0 && n.p.follow && !(n._pnManT && now-n._pnManT<10000)){
    const cw=(sLo+sHi)/2, idx=list.findIndex(b=>cw>=b.lo && cw<=b.hi), k=Math.max(1,n.p.panes|0), from=n.p.paneFrom|0;
    if(idx>=0 && (idx<from || idx>=from+k)) saSetFrom(n,Math.floor(idx/k)*k,false);
  }
  const skipR=saSkipSync(n);
  const pal=paletteLut(n.p.palette);
  for(const b of list){
    if(b.hi<sLo || b.lo>sHi) continue;
    const p=saPaneGet(n,b), span=p.hi-p.lo, [pfl,ptp]=saPaneRange(n,p), rng=(ptp-pfl)||1;
    const x0=Math.max(0,Math.floor((sLo-p.lo)/span*SAP_RES)), x1=Math.min(SAP_RES-1,Math.ceil((sHi-p.lo)/span*SAP_RES));
    let touched=0;
    const wcol=n._wcol||(n._wcol=new Int32Array(SAP_RES));
    for(let x=x0;x<=x1;x++){
      const fa=p.lo+span*x/SAP_RES, fb=p.lo+span*(x+1)/SAP_RES;
      if(fb<sLo || fa>sHi) continue;
      // середина окна пишется всегда, проседающий край — только в ещё пустой столбец (дыр нет, горбов нет там, где окна перекрыты)
      if((fb<uLo || fa>uHi) && p.lv[x]===p.lv[x]) continue;
      let b0=clamp(specBin(sp,fa),0,N-1), b1=clamp(specBin(sp,fb),0,N-1);
      if(b0>b1){ const t=b0; b0=b1; b1=t; }
      let v;
      if(b1-b0>1){
        v=m[Math.round((b0+b1)*.5)];
        for(let i=Math.ceil(b0), e=Math.floor(b1); i<=e; i++) if(m[i]>v) v=m[i];
      } else {
        const bf=(b0+b1)*.5, i0=bf|0, i1=Math.min(N-1,i0+1);
        v=m[i0]+(m[i1]-m[i0])*(bf-i0);
      }
      const db=20*Math.log10(v+1e-12);
      p.lv[x]=db; wcol[touched++]=x;
      if(n.p.peakHold && !(p.pk[x]>=db)) p.pk[x]=db;
    }
    if(!touched) continue;
    const gap=p.t ? now-p.t : 1e9, c=(sLo+sHi)/2;
    p.t=now;
    // строка водопада: полоска окна добавляется в текущую строку; новая строка (сдвиг вниз) — когда прежняя закончена и начался
    // новый заход (пауза в данных, другое окно, прошёл rowMs — стоим на месте), либо сканер пошёл заново (центр окна вернулся назад)
    const d=p.img?p.img.data:null, row=SAP_WRES*4, k=SAP_RES/SAP_WRES, rowMs=Math.max(100,+n.p.rowMs||400);
    const wrap=!n._pnMulti && p.lastC!=null && c<p.lastC-1e3;    // при нескольких приёмниках окна приходят не по порядку
    // диапазон шире окна: строка достраивается за проход, сдвиг — только когда сканер вернулся в начало (центр окна пошёл назад);
    // диапазон в одно окно: строка готова сразу — новая на каждый заход (пауза в данных) и раз в rowMs, пока стоим на месте
    const single=(p.hi-p.lo)<=(uHi-uLo)+1e3;
    // несколько приёмников: строка готова, а окно снова заходит в уже записанные столбцы (и это не хвост диапазона) — новый проход
    let multiNew=false;
    if(n._pnMulti && !single && p.rowFull){
      let already=0; for(let i=0;i<touched;i++){ const v=p.rowLv[wcol[i]]; if(v===v) already++; }
      multiNew=already>=.5*touched && touched>=.3*Math.min(SAP_RES,(uHi-uLo)/span*SAP_RES);
    }
    if(!p.rowOpen || wrap || multiNew || (single && p.rowFull && (gap>250 || now-p.rowT0>=rowMs))){
      if(d) d.copyWithin(row,0,row*(SAP_ROWS-1)); p.wdb.copyWithin(SAP_WRES,0,SAP_WRES*(SAP_ROWS-1));
      p.rowLv.fill(NaN); p.rowN=0; p.rowFull=false; p.rowOpen=true; p.rowT0=now;
    }
    for(let i=0;i<touched;i++){ const x=wcol[i]; if(!(p.rowLv[x]===p.rowLv[x])) p.rowN++; p.rowLv[x]=p.lv[x]; }
    if(p.rowN>=.97*SAP_RES) p.rowFull=true;
    p.lastC=c; p.curWin=c;
    for(let x=0,o=0;x<SAP_WRES;x++,o+=4){                 // верхняя строка — из rowLv (ещё не пройденное — чёрное); столбец водопада — максимум соседних
      let db=NaN;
      for(let q=0;q<k;q++){ const v=p.rowLv[x*k+q]; if(v===v && !(db>=v)) db=v; }
      p.wdb[x]=sapCode(db);
      if(!d) continue;
      if(db!==db){ d[o]=d[o+1]=d[o+2]=0; d[o+3]=255; continue; }
      const hk=heatIdx((db-pfl)/rng)*3;
      d[o]=pal[hk]; d[o+1]=pal[hk+1]; d[o+2]=pal[hk+2]; d[o+3]=255;
    }
    if(d) p.dirty=true;
    // шумовая полка панели — медиана последних уровней (для SNR маркеров)
    const t=Float32Array.from(p.lv).filter(v=>v===v).sort();
    p.med=t.length ? t[t.length>>1] : -120;
    if(p.det){
      const ds=saDetSrc(n,p,src);
      ds.p.thr=n.p.detThr; ds.skip=skipR;
      cfarFrame(ds,sc);
      p.det.floorDb=ds.floorDb;
      saDetMerge(p);
      for(const r of ds.recs.splice(0)){ r.band=p.label; (n._pnRecs||(n._pnRecs=[])).push(r); }
      if(n._pnRecs && n._pnRecs.length>1000) n._pnRecs.splice(0,n._pnRecs.length-1000);
    }
  }
  // цели в окне приёмника — для остановки сканера (count) и подстройки (detF)
  // (по каждому приёмнику отдельно: у каждого свой Band Scanner и своя частота)
  let cnt=0, best=null;
  for(const p of n._pnStore.values()) if(p.det){
    const ds=p.det.srcs[src]; if(!ds) continue;
    for(const t of ds.list){
      if(t.f<sLo || t.f>sHi) continue;
      cnt++; if(!best || t.db>best.db) best=t;
    }
  }
  (n._pnCnt||(n._pnCnt=[]))[src]=cnt; (n._pnDetFs||(n._pnDetFs=[]))[src]=best ? best.f : null;
  n._pnRevDraw=(n._pnRevDraw|0)+1;
}
// выходы режима panes: маркеры берут уровень из накопленных данных панели, а не из текущего окна приёмника
function saPanesOut(n){
  // маркер как «стоп»: holdF — частота первого поставленного маркера (если включено park); сканер встаёт на неё и стоит до снятия
  const mkHold=n.p.holdMarker ? n.mk.find(f=>f!=null) : null;
  const hk=n.p.holdMarker ? n.mk.findIndex(f=>f!=null) : -1;
  if(n._pnHoldF!==mkHold || n._pnHoldK!==hk){ n._pnHoldF=mkHold ?? null; n._pnHoldK=hk; saPanesBump(n); }   // для плашки «сканер припаркован»
  const o={centerFreq:n._steer ?? null, holdF:mkHold ?? null, rec:null};
  for(let k=0;k<4;k++){                                  // count/detF — приёмник 1; count2/detF2 … — приёмники 2–4
    const q=k?k+1:'';
    o['count'+q]=n.p.scanStop==='marker only' ? 0 : ((n._pnCnt&&n._pnCnt[k])|0);
    o['detF'+q]=(k===0 ? mkHold : null) ?? (n._pnDetFs&&n._pnDetFs[k]) ?? null;
  }
  if(n._pnRecs && n._pnRecs.length) o.rec=n._pnRecs.splice(0);
  const all=n._pnStore ? [...n._pnStore.values()] : [];
  for(let k=0;k<4;k++){
    const f=n.mk[k], q=k+1; o['f'+q]=f; o['fr'+q]=null;
    const p=f==null ? null : all.find(x=>f>=x.lo && f<=x.hi);
    if(!p){ o['db'+q]=null; o['snr'+q]=null; n.db[k]=-120; n.snr[k]=0; continue; }
    const span=p.hi-p.lo, c=clamp(Math.floor((f-p.lo)/span*SAP_RES),0,SAP_RES-1), r=Math.max(1,Math.round(n.p.tol/(span/SAP_RES)));
    let mx=-Infinity;
    for(let i=Math.max(0,c-r);i<=Math.min(SAP_RES-1,c+r);i++) if(p.lv[i]>mx) mx=p.lv[i];
    if(mx===-Infinity){ o['db'+q]=null; o['snr'+q]=null; n.db[k]=-120; n.snr[k]=0; continue; }
    n.db[k]=mx; n.snr[k]=mx-p.med; o['db'+q]=mx; o['snr'+q]=mx-p.med;
  }
  return o;
}

/* ---------- разметка и жесты ---------- */
function saPanesLayout(n,W,H){
  const k=Math.max(1,(n._pn||[]).length), w=(W-SAP_GAP*(k-1))/k;
  const hs=Math.round(H*n.p.split);
  return {k, w, hs, plotTop:SAP_TITLE, plotH:Math.max(1,hs-SAP_AXIS-SAP_TITLE)};
}
const saPanesBump=n=>{ n._pnRevDraw=(n._pnRevDraw|0)+1; };
function saPanesWire(n,cv){
  if(n._pnWired) return;
  n._pnWired=true;
  cv.classList.add('ownpinch');                           // двухпальцевый жест не отдавать зуму холста графа
  const pt=ev=>{ const r=cv.getBoundingClientRect(); return {x:(ev.clientX-r.left)/r.width*cv.width, y:(ev.clientY-r.top)/r.height*cv.height}; };
  const inB=(b,x,y)=>x>=b.x0 && x<=b.x1 && y>=b.y0 && y<=b.y1;
  const hit=ev=>{ const {x,y}=pt(ev); return hitXY(x,y); };
  const hitXY=(x,y)=>{
    const W=cv.width, H=cv.height, L=saPanesLayout(n,W,H);
    const i=Math.floor(x/(L.w+SAP_GAP));
    if(i<0 || i>=L.k || x-i*(L.w+SAP_GAP)>L.w || !n._pn || !n._pn[i]) return null;
    const p=n._pn[i], v=saPaneView(p), fx=(x-i*(L.w+SAP_GAP))/L.w;
    return {i, p, v, fx, f:v[0]+(v[1]-v[0])*fx, x, y, L, x0:i*(L.w+SAP_GAP)};
  };
  // ближайшая цель детектора / запись списка пропуска у точки клика (в пределах 8 px по x)
  const near=(h)=>{
    const px=(f)=>h.x0+(f-h.v[0])/(h.v[1]-h.v[0])*h.L.w;
    let det=null, sk=null, dd=8, ds=8;
    if(h.p.det) for(const t of h.p.det.list){ const d=Math.abs(px(t.f)-h.x); if(d<dd){ dd=d; det=t; } }
    for(const s of n._skipInt||[]){ if(s.f<h.p.lo || s.f>h.p.hi) continue; const d=Math.abs(px(s.f)-h.x); if(d<ds){ ds=d; sk=s; } }
    return {det, sk};
  };
  // ширина пропуска — не меньше канала диапазона (шаг сетки, иначе 12.5 кГц): несущая гуляет, узкий пропуск её теряет
  const skipToggle=({det,sk},p)=>{
    if(sk) n._skipInt.splice(n._skipInt.indexOf(sk),1);
    else if(det) n._skipInt.push({f:det.f, w:Math.max(det.w*1.5, p && p.step>=1000 ? p.step : 12500)});
    saSkipSave(n);
  };
  const zoomBy=(h,k)=>{
    const p=h.p, span=h.v[1]-h.v[0], full=p.hi-p.lo, ns=clamp(span*k,full/SAP_RES*24,full);
    let a=h.f-(h.f-h.v[0])*(ns/span), b=a+ns;
    if(a<p.lo){ b+=p.lo-a; a=p.lo; } if(b>p.hi){ a-=b-p.hi; b=p.hi; }
    p.zoom=ns>=full*.999 ? null : [Math.max(p.lo,a),Math.min(p.hi,b)];
    saPanesBump(n);
  };
  const on=(t,fn,o)=>cv.addEventListener(t,ev=>{ if(n.p.layout!=='panes') return; ev.stopImmediatePropagation(); fn(ev); },o||true);
  // дБ-диапазон панели: свой (p.db) или общий; смена перекрашивает водопад
  const setDb=(p,fl,tp)=>{
    tp=clamp(tp,-200,60); fl=clamp(fl,-220,tp-10);
    p.db=[fl,tp]; saPaneRepaint(n,p);
  };
  const resetView=h=>{ h.p.zoom=null; if(h.p.db){ h.p.db=null; saPaneRepaint(n,h.p); saDbSave(n); } saPanesBump(n); };
  const scaleDb=(h,k)=>{
    const [fl,tp]=saPaneRange(n,h.p), span=clamp((tp-fl)*k,10,200), at=tp-(h.y-h.L.plotTop)/h.L.plotH*(tp-fl);   // вокруг уровня под курсором
    const nt=at+(h.y-h.L.plotTop)/h.L.plotH*span; setDb(h.p,nt-span,nt); saDbSave(n);
  };
  on('wheel',ev=>{
    ev.preventDefault();
    const h=hit(ev); if(!h) return;
    if(h.y<SAP_TITLE){ saSetFrom(n,(n.p.paneFrom|0)+(ev.deltaY>0?1:-1),true); return; }
    if(ev.ctrlKey){ scaleDb(h,ev.deltaY<0?.96:1.04); return; }
    if(ev.shiftKey){
      const span=h.v[1]-h.v[0], d=span*.15*(ev.deltaY>0?1:-1);
      if(h.p.zoom){ const a=clamp(h.v[0]+d,h.p.lo,h.p.hi-span); h.p.zoom=[a,a+span]; saPanesBump(n); }
    } else zoomBy(h,ev.deltaY<0?.96:1.04);
  },{capture:true,passive:false});
  const dbl=h=>{
    const u=n._pnMkUndo; if(u && performance.now()-u.t<600){ n.mk[u.k]=u.prev; n._pnMkUndo=null; }   // тапы двойного клика не должны ставить маркер
    resetView(h);
  };
  on('dblclick',ev=>{ const h=hit(ev); if(h && h.y>=SAP_TITLE) dbl(h); });
  const ptrs=n._pnPtrs||(n._pnPtrs=new Map());
  on('pointerdown',ev=>{
    const {x,y}=pt(ev);
    n._pnDrag=null;
    for(const b of n._tabBoxes||[]){                    // вкладки маркеров 1–4: × — снять, вкладка — выбрать
      if(b.cl && inB(b.cl,x,y)){ n.mk[b.idx]=null; saPanesBump(n); return; }
      if(inB(b,x,y)){ n.active=b.idx+1; saPanesBump(n); return; }
    }
    for(const b of n._pgBoxes||[]) if(inB(b,x,y)){                 // листатель полос
      const k=Math.max(1,n.p.panes|0);
      if(b.act==='prev') saSetFrom(n,(n.p.paneFrom|0)-k,true);
      else if(b.act==='next') saSetFrom(n,(n.p.paneFrom|0)+k,true);
      else if(b.act==='skipmode'){ n._pnSkipMode=!n._pnSkipMode; saPanesBump(n); }
      else if(b.act==='park'){ if(n.set && n.set.holdMarker) n.set.holdMarker(!n.p.holdMarker); else n.p.holdMarker=!n.p.holdMarker; saPanesBump(n); }
      else if(b.act==='pkclr'){ saPeakClear(n); saPanesBump(n); }
      else if(b.act==='dbauto') saDbAuto(n);
      else if(b.act==='resume'){ for(let k=0;k<4;k++) n.mk[k]=null; saPanesBump(n); }                    // снять маркеры — сканер продолжает
      else { if(n.set && n.set.follow) n.set.follow(!n.p.follow); else n.p.follow=!n.p.follow; saPanesBump(n); }
      return;
    }
    const h=hit(ev); if(!h) return;
    ptrs.set(ev.pointerId,{x,y});
    try{ cv.setPointerCapture(ev.pointerId); }catch(e){}
    clearTimeout(n._pnLP);
    if(ptrs.size===2){                                   // щипок двумя пальцами: ширина — зум по частоте, высота — дБ-диапазон, сдвиг — панорама
      const [a,b]=[...ptrs.values()], mx=(a.x+b.x)/2, my=(a.y+b.y)/2;
      const hh=hitXY(mx,my);
      n._pnDrag=null;
      if(hh){ const [fl,tp]=saPaneRange(n,hh.p);
        n._pnPinch={i:hh.i, dx:Math.max(1,Math.abs(a.x-b.x)), dy:Math.max(1,Math.abs(a.y-b.y)), mx, my, v:hh.v.slice(), f:hh.f, fl, tp, L:hh.L, x0:hh.x0}; }
      return;
    }
    if(ptrs.size>2) return;
    const d=n._pnDrag={i:h.i, x, y, v:h.v.slice(), moved:false, axis:null, id:ev.pointerId, done:false, title:h.y<SAP_TITLE, db:saPaneRange(n,h.p).slice()};
    // долгое нажатие на ▼ / ⊘ — пропуск (где нет Shift: телефон)
    if(h.y>=SAP_TITLE){
      const t=near(h);
      if(t.det||t.sk) n._pnLP=setTimeout(()=>{ if(n._pnDrag===d && !d.moved){ d.done=true; skipToggle(t,h.p); } },550);
    }
  });
  on('pointermove',ev=>{
    const {x,y}=pt(ev), q=ptrs.get(ev.pointerId); if(q){ q.x=x; q.y=y; }
    const pc=n._pnPinch;
    if(pc && ptrs.size>=2){
      const [a,b]=[...ptrs.values()], p=n._pn[pc.i]; if(!p) return;
      const mx=(a.x+b.x)/2, my=(a.y+b.y)/2, L=pc.L;
      if(pc.dx>24){                                     // частота: масштаб по расстоянию по x, точка под центром щипка остаётся под ним
        const span0=pc.v[1]-pc.v[0], full=p.hi-p.lo, ns=clamp(span0*pc.dx/Math.max(1,Math.abs(a.x-b.x)),full/SAP_RES*24,full);
        let lo=pc.f-(mx-pc.x0)/L.w*ns, hi=lo+ns;
        if(lo<p.lo){ hi+=p.lo-lo; lo=p.lo; } if(hi>p.hi){ lo-=hi-p.hi; hi=p.hi; }
        p.zoom=ns>=full*.999 ? null : [Math.max(p.lo,lo),Math.min(p.hi,hi)];
      }
      if(pc.dy>24){                                     // уровень: то же по y
        const span0=pc.tp-pc.fl, ns=clamp(span0*pc.dy/Math.max(1,Math.abs(a.y-b.y)),10,200);
        const at=pc.tp-(pc.my-L.plotTop)/L.plotH*span0, nt=at+(my-L.plotTop)/L.plotH*ns;
        setDb(p,nt-ns,nt);
      }
      saPanesBump(n); return;
    }
    const d=n._pnDrag;
    if(d){
      const p=n._pn[d.i], L=saPanesLayout(n,cv.width,cv.height), dx=x-d.x, dy=y-d.y;
      if(Math.abs(dx)>3 || Math.abs(dy)>3){ d.moved=true; clearTimeout(n._pnLP); }
      if(!d.axis && (Math.abs(dx)>6 || Math.abs(dy)>6)) d.axis=Math.abs(dx)>=Math.abs(dy)?'x':'y';
      if(!p || d.title) return;
      if(d.axis==='x' && p.zoom){                       // панорама увеличенной панели
        const span=d.v[1]-d.v[0], a=clamp(d.v[0]-dx/L.w*span,p.lo,p.hi-span);
        p.zoom=[a,a+span]; saPanesBump(n);
      } else if(d.axis==='y'){                          // вертикальное перетаскивание сдвигает дБ-диапазон панели
        const k=(d.db[1]-d.db[0])/L.plotH;
        setDb(p,d.db[0]+dy*k,d.db[1]+dy*k);
      }
      return;
    }
    n._pnHover=hit(ev); saPanesBump(n);
  });
  on('pointerup',ev=>{
    ptrs.delete(ev.pointerId);
    if(n._pnPinch){ if(ptrs.size<2){ n._pnPinch=null; saDbSave(n); n._pnDrag=null; } return; }
    const d=n._pnDrag; n._pnDrag=null; clearTimeout(n._pnLP);
    if(!d) return;
    if(d.axis==='y' && !d.title) saDbSave(n);
    if(d.title && d.moved){                              // смахивание по заголовку — листание страниц
      const {x}=pt(ev), k=Math.max(1,n.p.panes|0);
      if(Math.abs(x-d.x)>40) saSetFrom(n,(n.p.paneFrom|0)+(x<d.x?k:-k),true);
      return;
    }
    if(d.moved || d.done) return;
    const h=hit(ev); if(!h || h.i!==d.i) return;
    if(h.y<SAP_TITLE){ n._steer=(h.v[0]+h.v[1])/2; n._pnSel=h.i; }   // заголовок — перестроить приёмник на панель
    else {
      const {det,sk}=near(h);
      if((ev.shiftKey || n._pnSkipMode) && (det||sk)){              // Shift+тап или режим ⊘: цель — в список пропуска, ⊘ — обратно
        skipToggle({det,sk},h.p); return;
      }
      // двойной клик / двойной тап (сброс вида) — это два тапа: запоминаем маркер до первого и вернём его
      const u=n._pnMkUndo, tnow=performance.now();
      if(u && tnow-u.t<500 && u.k===n.active-1) u.t=tnow; else n._pnMkUndo={k:n.active-1, prev:n.mk[n.active-1], t:tnow};
      const lt=n._pnTap;
      if(ev.pointerType==='touch' && lt && lt.i===h.i && tnow-lt.t<350 && Math.abs(lt.x-h.x)<20){ n._pnTap=null; dbl(h); return; }   // на телефоне dblclick не приходит
      n._pnTap={i:h.i, x:h.x, t:tnow};
      n.mk[n.active-1]=det ? det.f : h.f;                           // обычный тап — активный маркер (на цель — точно на неё)
    }
    saPanesBump(n);
  });
  on('pointercancel',ev=>{ ptrs.delete(ev.pointerId); n._pnPinch=null; n._pnDrag=null; clearTimeout(n._pnLP); },false);
  on('pointerleave',()=>{ n._pnHover=null; saPanesBump(n); },false);
  cv.title=SAP_HINT;
}

/* ---------- отрисовка ---------- */
function saPanesDraw(n,cv,cx){
  const W=cv.width, H=cv.height;
  saPanesWire(n,cv);
  cv.style.touchAction='none';
  const rk=n.p.floor+'|'+n.p.top+'|'+n.p.palette;                // общий диапазон/палитра сменились — перекрасить водопады
  if(n._pnRk!==rk){ if(n._pnRk!==undefined) for(const p of (n._pnStore||new Map()).values()) saPaneRepaint(n,p); n._pnRk=rk; }
  n.pickT=null; n._wfVis=false; saWfPlace(n);            // GL-водопад одиночного режима прячем
  saSkipSync(n);
  const panes=saPaneState(n), list=n._pl||[], now=performance.now();
  const key=W+'|'+H+'|'+cv.pxGen+'|'+n._pnRevDraw+'|'+panes.map(p=>p.key+':'+p.zoom).join(',')+'|'+n._pnSel+'|'+n.p.floor+'|'+n.p.top+'|'+panes.map(p=>p.db).join(';')+'|'+
    n.p.split+'|'+n.p.peakHold+'|'+n.p.grid+'|'+n.mk+'|'+n.active+'|'+n.p.detect+'|'+n.p.detThr+'|'+n.p.paneFrom+'|'+n.p.follow+'|'+n._pnSkipMode+'|'+n.p.holdMarker+'|'+n._pnHoldF;
  if(key===n._pnDrawKey && now-(n._pnDrawT||0)<500) return;
  n._pnDrawKey=key; n._pnDrawT=now;
  cx.clearRect(0,0,W,H);
  const screen=themeColor('--screen')||'#0a0d0e', fg=themeColor('--fg')||'#c8d2d6', dim=themeColor('--dim')||'#6c7a80';
  const acc=themeColor('--acc')||'#4ec9b0', acc2=themeColor('--acc2')||'#ffb74d';
  cx.fillStyle=screen; cx.fillRect(0,0,W,H);
  n._pgBoxes=[];
  if(!panes.length){
    cx.fillStyle=dim; cx.font='11px sans-serif'; cx.textAlign='center'; cx.textBaseline='middle';
    cx.fillText('panes: wire bands (Table / band plan) — one pane per range',W/2,H/2);
    cx.textAlign='left'; cx.textBaseline='alphabetic'; return;
  }
  const L=saPanesLayout(n,W,H), hw=H-L.hs, wins=(n._pnSrc||[]).filter(x=>x&&x.sp).map(x=>specSpan(x.sp));
  let yOf=null;
  cx.font='10px sans-serif';
  panes.forEach((p,i)=>{
    const x0=Math.round(i*(L.w+SAP_GAP)), w=Math.round(L.w), v=saPaneView(p), vs=v[1]-v[0], pspan=p.hi-p.lo;
    const [pfl,ptp]=saPaneRange(n,p), prng=(ptp-pfl)||1;
    yOf=db=>L.plotTop+L.plotH*(1-clamp((db-pfl)/prng,0,1));
    const X=f=>x0+(f-v[0])/vs*w;
    // водопад (для увеличения — вырезка из накопленной картинки)
    if(p.dirty){
      if(!p.off){ p.off=document.createElement('canvas'); p.off.width=SAP_WRES; p.off.height=SAP_ROWS; p.ocx=p.off.getContext('2d'); }
      p.ocx.putImageData(p.img,0,0); p.dirty=false;
    } else if(!p.off){ p.off=document.createElement('canvas'); p.off.width=SAP_WRES; p.off.height=SAP_ROWS; p.ocx=p.off.getContext('2d'); p.ocx.putImageData(p.img,0,0); }
    cx.imageSmoothingEnabled=true;
    cx.drawImage(p.off,(v[0]-p.lo)/pspan*SAP_WRES,0,vs/pspan*SAP_WRES,SAP_ROWS,x0,L.hs,w,hw);
    // сетка
    if(n.p.grid){
      cx.strokeStyle='rgba(128,140,150,.18)'; cx.lineWidth=1; cx.beginPath();
      for(let g=0;g<=4;g++){ const y=Math.round(L.plotTop+L.plotH*g/4)+.5; cx.moveTo(x0,y); cx.lineTo(x0+w,y); }
      for(let g=1;g<4;g++){ const x=Math.round(x0+w*g/4)+.5; cx.moveTo(x,L.plotTop); cx.lineTo(x,L.plotTop+L.plotH); }
      cx.stroke();
    }
    const stale=p.t && now-p.t>4000;
    // уровень на столбец экрана: максимум по накопленным столбцам, при сильном увеличении — интерполяция
    const sample=(arr,fa,fb)=>{
      const ia=(fa-p.lo)/pspan*SAP_RES, ib=(fb-p.lo)/pspan*SAP_RES;
      const i0=Math.max(0,Math.floor(ia)), i1=Math.min(SAP_RES-1,Math.floor(ib));
      if(i1>i0){ let m=NaN; for(let q=i0;q<=i1;q++){ const a=arr[q]; if(a===a && !(m>=a)) m=a; } return m; }
      const c=(ia+ib)/2-.5, j=Math.floor(c), fr=c-j, a=arr[clamp(j,0,SAP_RES-1)], b=arr[clamp(j+1,0,SAP_RES-1)];
      return a===a && b===b ? a+(b-a)*fr : a===a ? a : b;
    };
    const trace=(arr,col,alpha,fill)=>{
      const bot=L.plotTop+L.plotH, segs=[];
      let cur=null;
      for(let px=0;px<w;px++){
        const val=sample(arr,v[0]+vs*px/w,v[0]+vs*(px+1)/w);
        if(val!==val){ cur=null; continue; }
        if(!cur) segs.push(cur=[]);
        cur.push(x0+px,yOf(val));
      }
      cx.strokeStyle=col; cx.fillStyle=col; cx.lineWidth=1;
      for(const s of segs){
        cx.globalAlpha=alpha; cx.beginPath(); cx.moveTo(s[0],s[1]);
        for(let i=2;i<s.length;i+=2) cx.lineTo(s[i],s[i+1]);
        cx.stroke();
        if(fill){
          cx.globalAlpha=alpha*.18;
          cx.lineTo(s[s.length-2],bot); cx.lineTo(s[0],bot); cx.closePath(); cx.fill();
        }
      }
      cx.globalAlpha=1;
    };
    if(n.p.peakHold) trace(p.pk,acc2,stale?.35:.8,false);
    trace(p.lv,acc,stale?.4:1,true);
    cx.save(); cx.beginPath(); cx.rect(x0,0,w,H); cx.clip();
    // порог детектора: полка шума + threshold
    if(p.det && p.det.floorDb!=null && p.t){
      const y=yOf(p.det.floorDb+n.p.detThr);
      cx.setLineDash([3,3]); cx.strokeStyle=acc2; cx.globalAlpha=stale?.25:.55; cx.beginPath(); cx.moveTo(x0,y+.5); cx.lineTo(x0+w,y+.5); cx.stroke();
      cx.setLineDash([]); cx.globalAlpha=1;
    }
    // пропущенные сигналы (⊘): полоса и отметка
    for(const s of n._skipInt||[]){
      if(s.f+s.w/2<v[0] || s.f-s.w/2>v[1] || s.f<p.lo || s.f>p.hi) continue;
      const xa=X(s.f-s.w/2), xb=X(s.f+s.w/2), xc=X(s.f);
      cx.fillStyle='rgba(160,160,160,.18)'; cx.fillRect(xa,L.plotTop,Math.max(2,xb-xa),L.plotH);
      cx.fillStyle=dim; cx.textAlign='center'; cx.fillText('⊘',xc,L.plotTop+L.plotH-3);
    }
    // найденные сигналы (CFAR): треугольник у пика; подписаны сильнейшие
    if(p.det){
      p.det.list.forEach((t,ti)=>{
        if(t.f<v[0] || t.f>v[1]) return;
        const x=X(t.f), y=yOf(t.db), old=now-t.t>2500;
        cx.globalAlpha=old?.4:1; cx.fillStyle=acc2;
        cx.beginPath(); cx.moveTo(x,y-2); cx.lineTo(x-3.5,y-9); cx.lineTo(x+3.5,y-9); cx.closePath(); cx.fill();
        if(ti<3){
          const lab=fmtHz(t.f,3), tw=cx.measureText(lab).width;
          cx.fillStyle=fg; cx.textAlign='center'; cx.fillText(lab,clamp(x,x0+tw/2+2,x0+w-tw/2-2),Math.max(L.plotTop+9,y-12));
        }
        cx.globalAlpha=1;
      });
    }
    // маркеры 1–4 этой панели
    for(let k=0;k<4;k++){
      const f=n.mk[k]; if(f==null || f<v[0] || f>v[1]) continue;
      const x=Math.round(X(f)), act=n.active-1===k;
      cx.strokeStyle=MK_COL(k); cx.lineWidth=act?1.5:1;
      cx.beginPath(); cx.moveTo(x+.5,L.plotTop); cx.lineTo(x+.5,H); cx.stroke();
      const c=clamp(Math.floor((f-p.lo)/pspan*SAP_RES),0,SAP_RES-1), lv=p.lv[c];
      const t=(k+1)+': '+fmtHz(f,3).replace(/[kMG]$/,'')+(lv===lv ? ' '+lv.toFixed(0)+' / '+Math.max(0,lv-p.med).toFixed(0) : '');
      const tw=cx.measureText(t).width, tx=clamp(x-tw/2,x0+2,x0+w-tw-2), ty=L.plotTop+L.plotH-14-k*13;
      cx.fillStyle=MK_COL(k); cx.globalAlpha=act?.95:.75; cx.fillRect(tx-3,ty,tw+6,12);
      cx.globalAlpha=1; cx.fillStyle=contrastText(MK_COL(k)); cx.textAlign='left'; cx.fillText(t,tx,ty+9);
    }
    // подписи: имя диапазона (число целей, увеличение), границы и середина оси
    cx.textBaseline='alphabetic';
    if(p.color){ cx.fillStyle=p.color; cx.fillRect(x0+2,2,6,6); }
    cx.fillStyle=fg; cx.textAlign='left';
    const nd=p.det ? p.det.list.length : 0, zm=p.zoom ? ' ×'+(pspan/vs).toFixed(pspan/vs<10?1:0) : '';
    // возраст данных — видно, как часто сканер заходит в диапазон (не обновлялся дольше 3 с)
    const age=!p.t ? ' · no data' : now-p.t>3000 ? ' · '+Math.round((now-p.t)/1000)+'s ago' : '';
    cx.fillText((p.label||fmtHz((p.lo+p.hi)/2,3))+(nd ? ' · '+nd+'▼' : '')+zm+age,x0+(p.color?11:3),10);
    cx.fillStyle=dim;
    const tl=fmtHz(v[0],3), tm=fmtHz((v[0]+v[1])/2,3), th=fmtHz(v[1],3), mw=s=>cx.measureText(s).width;
    if(mw(tl)+mw(tm)+mw(th)+30<w){
      cx.textAlign='left'; cx.fillText(tl,x0+3,L.hs-3);
      cx.textAlign='center'; cx.fillText(tm,x0+w/2,L.hs-3);
      cx.textAlign='right'; cx.fillText(th,x0+w-3,L.hs-3);
    } else if(mw(tl)+mw(th)+14<w){
      cx.textAlign='left'; cx.fillText(tl,x0+3,L.hs-3);
      cx.textAlign='right'; cx.fillText(th,x0+w-3,L.hs-3);
    } else { cx.textAlign='center'; cx.fillText(tm,x0+w/2,L.hs-3); }
    if(i===0 || p.db){ cx.textAlign='right'; cx.fillText(Math.round(ptp)+'',x0+w-3,L.plotTop+9); cx.fillText(Math.round(pfl)+'',x0+w-3,L.plotTop+L.plotH-2); }
    cx.restore();
    // граница: активное окно приёмника в этой панели / выбранная
    const live=p.t && now-p.t<1200 && wins.some(w=>!(p.hi<w[0] || p.lo>w[1]));   // окно любого приёмника сейчас в этой панели
    cx.lineWidth=live?1.5:1;
    cx.strokeStyle=live ? acc : n._pnSel===i ? dim : 'rgba(128,140,150,.35)';
    cx.strokeRect(x0+.5,.5,w-1,H-1);
  });
  // курсор: частота и уровень под указателем
  saMarkerTabs(n,cx,W);
  const h=n._pnHover;
  if(h && panes[h.i]){
    const p=panes[h.i], v=saPaneView(p), x0=Math.round(h.i*(L.w+SAP_GAP)), w=Math.round(L.w), f=v[0]+(v[1]-v[0])*h.fx;
    const val=p.lv[clamp(Math.floor((f-p.lo)/(p.hi-p.lo)*SAP_RES),0,SAP_RES-1)];
    const x=x0+h.fx*w;
    cx.strokeStyle='rgba(255,255,255,.5)'; cx.lineWidth=1; cx.beginPath(); cx.moveTo(x+.5,L.plotTop); cx.lineTo(x+.5,H); cx.stroke();
    const t=fmtHz(f,4)+'Hz'+(val===val ? ' · '+val.toFixed(1)+' dB' : ''); cx.font='10px sans-serif';
    const tw=cx.measureText(t).width+8, tx=clamp(x+6,x0,x0+w-tw);
    cx.fillStyle='rgba(10,13,14,.85)'; cx.fillRect(tx,L.plotTop+2,tw,13);
    cx.fillStyle=fg; cx.textAlign='left'; cx.fillText(t,tx+4,L.plotTop+12);
  }
  // сканер припаркован на маркере — это нужно видеть: иначе кажется, что он завис
  if(n._pnHoldF!=null){
    const t='⏸ scan parked on marker '+(n._pnHoldK+1)+' · '+fmtHz(n._pnHoldF,4)+'Hz — clear the marker (×) or ▶ resume';
    cx.font='11px sans-serif'; cx.textAlign='left'; cx.textBaseline='middle';
    const tw=cx.measureText(t).width+14, tx=Math.max(4,(W-tw)/2);
    cx.fillStyle='rgba(10,13,14,.88)'; cx.fillRect(tx,L.plotTop+4,tw,18);
    cx.strokeStyle=acc2; cx.lineWidth=1; cx.strokeRect(tx+.5,L.plotTop+4.5,tw-1,17);
    cx.fillStyle=acc2; cx.fillText(t,tx+7,L.plotTop+13.5);
    cx.textBaseline='alphabetic';
  }
  // нижний ряд: кнопка режима пропуска (⊘ skip) и листатель полос ◀ 5–8 / 12 ▶ со следованием за сканером
  {
    const paged=list.length>panes.length, from=clamp(n.p.paneFrom|0,0,Math.max(0,list.length-1));
    const items=[];
    if(n._pnHoldF!=null) items.push({t:'▶ resume', act:'resume', col:acc2});
    items.push({t:(n.p.holdMarker?'● ':'○ ')+'⏸ park', act:'park', col:n.p.holdMarker?acc2:dim});
    if(n.p.peakHold) items.push({t:'⌫ peak', act:'pkclr', col:dim});
    items.push({t:'⇕ dB', act:'dbauto', col:dim});
    if(n.p.detect) items.push({t:(n._pnSkipMode?'● ':'○ ')+'⊘ skip', act:'skipmode', col:n._pnSkipMode?acc2:dim});
    if(paged) items.push({t:'◀',act:'prev'},{t:(from+1)+'–'+(from+panes.length)+' / '+list.length,col:dim},{t:'▶',act:'next'},
      {t:(n.p.follow?'● ':'○ ')+'follow',act:'follow',col:n.p.follow?acc:dim});
    cx.font='10px sans-serif'; cx.textBaseline='middle'; cx.textAlign='left';
    const y1=H-17, y2=H-3, ws=items.map(it=>cx.measureText(it.t).width+(it.t.length<2 ? 12 : 10));
    let x=W-4-ws.reduce((a,v)=>a+v,0);
    items.forEach((it,k)=>{
      cx.fillStyle='rgba(10,13,14,.8)'; cx.fillRect(x,y1,ws[k],y2-y1);
      cx.fillStyle=it.col||fg; cx.fillText(it.t,x+5,(y1+y2)/2+.5);
      if(it.act) n._pgBoxes.push({x0:x,y0:y1,x1:x+ws[k],y1:y2,act:it.act});
      x+=ws[k];
    });
    cx.textBaseline='alphabetic';
  }
  cx.textAlign='left';
}
