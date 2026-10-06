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
const SAP_HINT='wheel — zoom · drag — pan (zoomed) · double click — reset zoom · wheel on a title — next/previous bands\n'+
  'tap — marker · tap a title — retune the receiver · Shift+tap a ▼ signal — skip it (Shift+tap a ⊘ — return it)';

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
    const img=new ImageData(SAP_WRES,SAP_ROWS);
    for(let i=3;i<img.data.length;i+=4) img.data[i]=255;
    p={key, lo:b.lo, hi:b.hi, label:'', color:'', lv:new Float32Array(SAP_RES).fill(NaN), pk:new Float32Array(SAP_RES).fill(NaN),
      t:0, img, off:null, ocx:null, dirty:false, med:-120, det:null, zoom:null};
    store.set(key,p);
  }
  p.label=b.label||''; p.color=b.color||'';
  if(n.p.detect && !p.det){
    // детектор — обычный cfarFrame с узлом-заглушкой: диапазон панели, подтверждённые цели живут вне окна приёмника
    p.det={p:{auto:false,fmin:p.lo,fmax:p.hi,method:'OS',guard:4,train:32,thr:n.p.detThr,minW:2,confM:2,
      confN:3,top:10,hold:1500,idRes:'auto'}, keepOutside:30000, list:[], tracks:[], recs:[], skip:null, floorDb:null};
  } else if(!n.p.detect && p.det) p.det=null;
  return p;
}
// панели на экране
function saPaneState(n){
  const list=saPaneList(n), k=Math.max(1,n.p.panes|0), from=clamp(n.p.paneFrom|0,0,Math.max(0,list.length-1));
  return n._pn=list.slice(from,from+k).map(b=>saPaneGet(n,b));
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
    p.det.skip=n._skipR;
    p.det.tracks=p.det.tracks.filter(t=>!cfarSkipped(n._skipR,t.f,t.w));
    p.det.list=p.det.list.filter(t=>!cfarSkipped(n._skipR,t.f,t.w));
  }
  return n._skipR;
}
function saSkipSave(n){
  n.p.skipList=JSON.stringify(n._skipInt.map(x=>({f:Math.round(x.f),w:Math.round(x.w)})));
  saSkipSync(n); n._pnRevDraw=(n._pnRevDraw|0)+1;
}
function saSkipClear(n){ n._skipInt=[]; saSkipSave(n); }

/* ---------- накопление ---------- */
// новое окно спектра → диапазоны
function saPanesIngest(n,sp){
  if(!sp || !sp.mag) return;
  if(sp===n._pnSp && sp.rev===n._pnRev) return;
  n._pnSp=sp; n._pnRev=sp.rev;
  const list=saPaneList(n); if(!list.length) return;
  const m=sp.mag, N=m.length, now=performance.now();
  if(N<2) return;
  const [sLo,sHi]=specSpan(sp), cut=(sHi-sLo)*clamp(+n.p.edge||0,0,40)/100, uLo=sLo+cut, uHi=sHi-cut;
  // следование за сканером: окно ушло в диапазон вне экрана — перелистнуть на его страницу
  if(n.p.follow && !(n._pnManT && now-n._pnManT<10000)){
    const cw=(sLo+sHi)/2, idx=list.findIndex(b=>cw>=b.lo && cw<=b.hi), k=Math.max(1,n.p.panes|0), from=n.p.paneFrom|0;
    if(idx>=0 && (idx<from || idx>=from+k)) saSetFrom(n,Math.floor(idx/k)*k,false);
  }
  const skipR=saSkipSync(n);
  const pal=paletteLut(n.p.palette), rng=(n.p.top-n.p.floor)||1;
  for(const b of list){
    if(b.hi<uLo || b.lo>uHi) continue;
    const p=saPaneGet(n,b), span=p.hi-p.lo;
    const x0=Math.max(0,Math.floor((uLo-p.lo)/span*SAP_RES)), x1=Math.min(SAP_RES-1,Math.ceil((uHi-p.lo)/span*SAP_RES));
    let touched=0;
    for(let x=x0;x<=x1;x++){
      const fa=p.lo+span*x/SAP_RES, fb=p.lo+span*(x+1)/SAP_RES;
      if(fb<uLo || fa>uHi) continue;
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
      p.lv[x]=db; touched++;
      if(n.p.peakHold && !(p.pk[x]>=db)) p.pk[x]=db;
    }
    if(!touched) continue;
    p.t=now;
    // строка водопада: новая сверху, остальное сдвигается вниз; столбец водопада — максимум двух соседних
    const d=p.img.data, row=SAP_WRES*4, k=SAP_RES/SAP_WRES;
    d.copyWithin(row,0,row*(SAP_ROWS-1));
    for(let x=0,o=0;x<SAP_WRES;x++,o+=4){
      let db=NaN;
      for(let q=0;q<k;q++){ const v=p.lv[x*k+q]; if(v===v && !(db>=v)) db=v; }
      if(db!==db){ d[o]=d[o+1]=d[o+2]=0; continue; }
      const hk=heatIdx((db-n.p.floor)/rng)*3;
      d[o]=pal[hk]; d[o+1]=pal[hk+1]; d[o+2]=pal[hk+2]; d[o+3]=255;
    }
    p.dirty=true;
    // шумовая полка панели — медиана последних уровней (для SNR маркеров)
    const t=Float32Array.from(p.lv).filter(v=>v===v).sort();
    p.med=t.length ? t[t.length>>1] : -120;
    if(p.det){
      p.det.p.thr=n.p.detThr; p.det.skip=skipR;
      cfarFrame(p.det,sp);
      for(const r of p.det.recs.splice(0)){ r.band=p.label; (n._pnRecs||(n._pnRecs=[])).push(r); }
      if(n._pnRecs && n._pnRecs.length>1000) n._pnRecs.splice(0,n._pnRecs.length-1000);
    }
  }
  // цели в окне приёмника — для остановки сканера (count) и подстройки (detF)
  let cnt=0, best=null;
  for(const p of n._pnStore.values()) if(p.det) for(const t of p.det.list){
    if(t.f<sLo || t.f>sHi) continue;
    cnt++; if(!best || t.db>best.db) best=t;
  }
  n._pnCount=cnt; n._pnDetF=best ? best.f : null;
  n._pnRevDraw=(n._pnRevDraw|0)+1;
}
// выходы режима panes: маркеры берут уровень из накопленных данных панели, а не из текущего окна приёмника
function saPanesOut(n){
  const o={centerFreq:n._steer ?? null, count:n._pnCount|0, detF:n._pnDetF ?? null, rec:null};
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
  const pt=ev=>{ const r=cv.getBoundingClientRect(); return {x:(ev.clientX-r.left)/r.width*cv.width, y:(ev.clientY-r.top)/r.height*cv.height}; };
  const inB=(b,x,y)=>x>=b.x0 && x<=b.x1 && y>=b.y0 && y<=b.y1;
  const hit=ev=>{
    const {x,y}=pt(ev), W=cv.width, H=cv.height, L=saPanesLayout(n,W,H);
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
  const zoomBy=(h,k)=>{
    const p=h.p, span=h.v[1]-h.v[0], full=p.hi-p.lo, ns=clamp(span*k,full/SAP_RES*24,full);
    let a=h.f-(h.f-h.v[0])*(ns/span), b=a+ns;
    if(a<p.lo){ b+=p.lo-a; a=p.lo; } if(b>p.hi){ a-=b-p.hi; b=p.hi; }
    p.zoom=ns>=full*.999 ? null : [Math.max(p.lo,a),Math.min(p.hi,b)];
    saPanesBump(n);
  };
  const on=(t,fn,o)=>cv.addEventListener(t,ev=>{ if(n.p.layout!=='panes') return; ev.stopImmediatePropagation(); fn(ev); },o||true);
  on('wheel',ev=>{
    ev.preventDefault();
    const h=hit(ev); if(!h) return;
    if(h.y<SAP_TITLE){ saSetFrom(n,(n.p.paneFrom|0)+(ev.deltaY>0?1:-1),true); return; }
    if(ev.shiftKey){
      const span=h.v[1]-h.v[0], d=span*.15*(ev.deltaY>0?1:-1);
      if(h.p.zoom){ const a=clamp(h.v[0]+d,h.p.lo,h.p.hi-span); h.p.zoom=[a,a+span]; saPanesBump(n); }
    } else zoomBy(h,ev.deltaY<0?.8:1.25);
  },{capture:true,passive:false});
  on('dblclick',ev=>{ const h=hit(ev); if(h && h.y>=SAP_TITLE){ h.p.zoom=null; saPanesBump(n); } });
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
      else { if(n.set && n.set.follow) n.set.follow(!n.p.follow); else n.p.follow=!n.p.follow; saPanesBump(n); }
      return;
    }
    const h=hit(ev); if(!h) return;
    n._pnDrag={i:h.i, x, v:h.v.slice(), moved:false, id:ev.pointerId};
    try{ cv.setPointerCapture(ev.pointerId); }catch(e){}
  });
  on('pointermove',ev=>{
    const d=n._pnDrag;
    if(d){
      const {x}=pt(ev), p=n._pn[d.i], L=saPanesLayout(n,cv.width,cv.height);
      if(Math.abs(x-d.x)>3) d.moved=true;
      if(d.moved && p && p.zoom){                                 // панорама увеличенной панели
        const span=d.v[1]-d.v[0], a=clamp(d.v[0]-(x-d.x)/L.w*span,p.lo,p.hi-span);
        p.zoom=[a,a+span]; saPanesBump(n);
      }
      return;
    }
    n._pnHover=hit(ev); saPanesBump(n);
  });
  on('pointerup',ev=>{
    const d=n._pnDrag; n._pnDrag=null;
    if(!d || d.moved) return;
    const h=hit(ev); if(!h || h.i!==d.i) return;
    if(h.y<SAP_TITLE){ n._steer=(h.v[0]+h.v[1])/2; n._pnSel=h.i; }   // заголовок — перестроить приёмник на панель
    else {
      const {det,sk}=near(h);
      if(ev.shiftKey && (det||sk)){                                  // Shift+тап: цель — в список пропуска, ⊘ — обратно
        if(sk) n._skipInt.splice(n._skipInt.indexOf(sk),1);
        else n._skipInt.push({f:det.f, w:Math.max(det.w*1.5,5000)});
        saSkipSave(n); return;
      }
      n.mk[n.active-1]=det ? det.f : h.f;                           // обычный тап — активный маркер (на цель — точно на неё)
    }
    saPanesBump(n);
  });
  on('pointerleave',()=>{ n._pnHover=null; saPanesBump(n); },false);
  cv.title=SAP_HINT;
}

/* ---------- отрисовка ---------- */
function saPanesDraw(n,cv,cx){
  const W=cv.width, H=cv.height;
  saPanesWire(n,cv);
  n.pickT=null; n._wfVis=false; saWfPlace(n);            // GL-водопад одиночного режима прячем
  saSkipSync(n);
  const panes=saPaneState(n), list=n._pl||[], now=performance.now();
  const key=W+'|'+H+'|'+cv.pxGen+'|'+n._pnRevDraw+'|'+panes.map(p=>p.key+':'+p.zoom).join(',')+'|'+n._pnSel+'|'+n.p.floor+'|'+n.p.top+'|'+
    n.p.split+'|'+n.p.peakHold+'|'+n.p.grid+'|'+n.mk+'|'+n.active+'|'+n.p.detect+'|'+n.p.detThr+'|'+n.p.paneFrom+'|'+n.p.follow;
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
  const L=saPanesLayout(n,W,H), hw=H-L.hs, sp=n._pnSp, span=sp ? specSpan(sp) : null;
  const rng=(n.p.top-n.p.floor)||1;
  const yOf=db=>L.plotTop+L.plotH*(1-clamp((db-n.p.floor)/rng,0,1));
  cx.font='10px sans-serif';
  panes.forEach((p,i)=>{
    const x0=Math.round(i*(L.w+SAP_GAP)), w=Math.round(L.w), v=saPaneView(p), vs=v[1]-v[0], pspan=p.hi-p.lo;
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
      cx.globalAlpha=alpha; cx.strokeStyle=col; cx.fillStyle=col; cx.lineWidth=1;
      let pen=false, lastX=0, firstX=0;
      cx.beginPath();
      for(let px=0;px<w;px++){
        const val=sample(arr,v[0]+vs*px/w,v[0]+vs*(px+1)/w);
        if(val!==val){ pen=false; continue; }
        const y=yOf(val);
        if(!pen){ cx.moveTo(x0+px,y); pen=true; if(fill) firstX=px; } else cx.lineTo(x0+px,y);
        lastX=px;
      }
      cx.stroke();
      if(fill){
        cx.globalAlpha=alpha*.18;
        cx.lineTo(x0+lastX,L.plotTop+L.plotH); cx.lineTo(x0+firstX,L.plotTop+L.plotH); cx.closePath(); cx.fill();
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
    cx.fillText((p.label||fmtHz((p.lo+p.hi)/2,3))+(nd ? ' · '+nd+'▼' : '')+zm,x0+(p.color?11:3),10);
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
    if(i===0){ cx.textAlign='right'; cx.fillText(Math.round(n.p.top)+'',x0+w-3,L.plotTop+9); cx.fillText(Math.round(n.p.floor)+'',x0+w-3,L.plotTop+L.plotH-2); }
    cx.restore();
    // граница: активное окно приёмника в этой панели / выбранная
    const live=span && p.t && now-p.t<1200 && !(p.hi<span[0] || p.lo>span[1]);
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
  // листатель полос: ◀ 5–8 / 12 ▶ и следование за сканером
  if(list.length>panes.length){
    const from=clamp(n.p.paneFrom|0,0,list.length-1), t1='◀', t2=(from+1)+'–'+(from+panes.length)+' / '+list.length, t3='▶', t4=(n.p.follow?'● ':'○ ')+'follow';
    cx.font='10px sans-serif'; cx.textBaseline='middle'; cx.textAlign='left';
    const w1=14, w2=cx.measureText(t2).width+10, w3=14, w4=cx.measureText(t4).width+10, y1=H-16, y2=H-3;
    let x=W-4-(w1+w2+w3+w4);
    const btn=(txt,bw,act,col)=>{
      cx.fillStyle='rgba(10,13,14,.8)'; cx.fillRect(x,y1,bw,y2-y1);
      cx.fillStyle=col||fg; cx.fillText(txt,x+5,(y1+y2)/2+.5);
      if(act) n._pgBoxes.push({x0:x,y0:y1,x1:x+bw,y1:y2,act}); x+=bw;
    };
    btn(t1,w1,'prev'); btn(t2,w2,null,dim); btn(t3,w3,'next'); btn(t4,w4,'follow',n.p.follow?acc:dim);
    cx.textBaseline='alphabetic';
  }
  cx.textAlign='left';
}
