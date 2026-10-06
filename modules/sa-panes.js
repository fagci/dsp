"use strict";
/* ======================= SA: MULTIBAND PANES ======================= */
// Режим layout=panes у 'sa': рядом несколько диапазонов (из входа bands, например отмеченные
// списки Table), у каждого свой спектр сверху и водопад снизу. Спектр приходит окнами
// (Band Scanner перестраивает приёмник, либо sweep сразу накрывает несколько панелей) —
// каждое окно раскладывается по панелям, куда попало; остальное держит прошлые данные.
// Состояние панели не зависит от размера канвы: RES столбцов × ROWS строк водопада.

const SAP_RES=256, SAP_ROWS=128, SAP_GAP=4, SAP_AXIS=14, SAP_TITLE=13;

// панели: непересекающиеся по смыслу диапазоны bands, отсортированные по lo
function saPaneDefs(n){
  const src=n.bandsData, key=(src?src.length:0)+'|'+n.p.panes+'|'+n.p.paneFrom;
  if(n._pnSrc===src && n._pnKey===key) return n._pnDefs;
  const list=(Array.isArray(src)?src:[]).filter(b=>b && !b.sig && isFinite(b.lo) && isFinite(b.hi) && b.hi>b.lo)
    .slice().sort((a,b)=>a.lo-b.lo);
  n._pnSrc=src; n._pnKey=key;
  n._pnDefs=list.slice(Math.max(0,n.p.paneFrom|0),Math.max(0,n.p.paneFrom|0)+Math.max(1,n.p.panes|0));
  n._pnTotal=list.length;
  return n._pnDefs;
}
// состояние панелей; сбрасывается при смене набора диапазонов
function saPaneState(n){
  const defs=saPaneDefs(n), sig=defs.map(b=>b.lo+'-'+b.hi).join(',');
  if(n._pn && n._pnSig===sig) return n._pn;
  n._pnSig=sig;
  n._pn=defs.map(b=>{
    const off=document.createElement('canvas'); off.width=SAP_RES; off.height=SAP_ROWS;
    return {lo:b.lo, hi:b.hi, label:b.label||'', color:b.color||'', lv:new Float32Array(SAP_RES).fill(NaN),
      pk:new Float32Array(SAP_RES).fill(NaN), t:0, off, ocx:off.getContext('2d'),
      img:new ImageData(SAP_RES,SAP_ROWS), dirty:false};
  });
  for(const p of n._pn) for(let i=3;i<p.img.data.length;i+=4) p.img.data[i]=255;
  return n._pn;
}
// новое окно спектра → панели
function saPanesIngest(n,sp){
  if(!sp || !sp.mag) return;
  if(sp===n._pnSp && sp.rev===n._pnRev) return;
  n._pnSp=sp; n._pnRev=sp.rev;
  const panes=saPaneState(n); if(!panes.length) return;
  const [sLo,sHi]=specSpan(sp), m=sp.mag, N=m.length, now=performance.now();
  if(N<2) return;
  const pal=paletteLut(n.p.palette), rng=(n.p.top-n.p.floor)||1;
  for(const p of panes){
    if(p.hi<sLo || p.lo>sHi) continue;
    const span=p.hi-p.lo; let touched=0;
    for(let x=0;x<SAP_RES;x++){
      const fa=p.lo+span*x/SAP_RES, fb=p.lo+span*(x+1)/SAP_RES;
      if(fb<sLo || fa>sHi) continue;
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
    // строка водопада: новая сверху, остальное сдвигается вниз
    const d=p.img.data, row=SAP_RES*4;
    d.copyWithin(row,0,row*(SAP_ROWS-1));
    for(let x=0,o=0;x<SAP_RES;x++,o+=4){
      const db=p.lv[x];
      if(db!==db){ d[o]=d[o+1]=d[o+2]=0; continue; }
      const hk=heatIdx((db-n.p.floor)/rng)*3;
      d[o]=pal[hk]; d[o+1]=pal[hk+1]; d[o+2]=pal[hk+2]; d[o+3]=255;
    }
    p.dirty=true;
  }
  n._pnRevDraw=(n._pnRevDraw|0)+1;
}
function saPanesLayout(n,W,H){
  const defs=n._pn||[], k=Math.max(1,defs.length), w=(W-SAP_GAP*(k-1))/k;
  const hs=Math.round(H*n.p.split);
  return {k, w, hs, plotTop:SAP_TITLE, plotH:Math.max(1,hs-SAP_AXIS-SAP_TITLE)};
}
function saPanesWire(n,cv){
  if(n._pnWired) return;
  n._pnWired=true;
  const hit=ev=>{
    const r=cv.getBoundingClientRect(), W=cv.width, H=cv.height;
    const x=(ev.clientX-r.left)/r.width*W, y=(ev.clientY-r.top)/r.height*H, L=saPanesLayout(n,W,H);
    const i=Math.floor(x/(L.w+SAP_GAP));
    if(i<0 || i>=L.k || x-i*(L.w+SAP_GAP)>L.w || !n._pn || !n._pn[i]) return null;
    return {i, fx:(x-i*(L.w+SAP_GAP))/L.w, y, inPlot:y<L.hs, H};
  };
  // в режиме panes одиночные жесты (зум, перетаскивание границы, маркеры) не нужны
  for(const t of ['pointerdown','wheel','dblclick']) cv.addEventListener(t,ev=>{
    if(n.p.layout!=='panes') return;
    ev.stopImmediatePropagation();
    if(t==='pointerdown'){
      const h=hit(ev); if(!h) return;
      n._steer=(n._pn[h.i].lo+n._pn[h.i].hi)/2; n._pnSel=h.i; n._pnRevDraw=(n._pnRevDraw|0)+1;
    }
  },true);
  cv.addEventListener('pointermove',ev=>{
    if(n.p.layout!=='panes') return;
    n._pnHover=hit(ev); n._pnRevDraw=(n._pnRevDraw|0)+1;
  });
  cv.addEventListener('pointerleave',()=>{ n._pnHover=null; n._pnRevDraw=(n._pnRevDraw|0)+1; });
}
function saPanesDraw(n,cv,cx){
  const W=cv.width, H=cv.height;
  saPanesWire(n,cv);
  n.pickT=null; n._wfVis=false; saWfPlace(n);            // GL-водопад одиночного режима прячем
  const panes=saPaneState(n), now=performance.now();
  const key=W+'|'+H+'|'+cv.pxGen+'|'+n._pnRevDraw+'|'+n._pnSig+'|'+n._pnSel+'|'+n.p.floor+'|'+n.p.top+'|'+n.p.split+'|'+n.p.peakHold+'|'+n.p.grid;
  if(key===n._pnDrawKey && now-(n._pnDrawT||0)<500) return;
  n._pnDrawKey=key; n._pnDrawT=now;
  cx.clearRect(0,0,W,H);
  const screen=themeColor('--screen')||'#0a0d0e', fg=themeColor('--fg')||'#c8d2d6', dim=themeColor('--dim')||'#6c7a80';
  const acc=themeColor('--acc')||'#4ec9b0', acc2=themeColor('--acc2')||'#ffb74d';
  cx.fillStyle=screen; cx.fillRect(0,0,W,H);
  if(!panes.length){
    cx.fillStyle=dim; cx.font='11px sans-serif'; cx.textAlign='center'; cx.textBaseline='middle';
    cx.fillText('panes: wire bands (Table / band plan) — one pane per range',W/2,H/2);
    cx.textAlign='left'; cx.textBaseline='alphabetic'; return;
  }
  const L=saPanesLayout(n,W,H), hw=H-L.hs, sp=n._pnSp, span=sp?specSpan(sp):null;
  const rng=(n.p.top-n.p.floor)||1;
  cx.font='10px sans-serif';
  panes.forEach((p,i)=>{
    const x0=Math.round(i*(L.w+SAP_GAP)), w=Math.round(L.w);
    // водопад
    if(p.dirty){ p.ocx.putImageData(p.img,0,0); p.dirty=false; }
    cx.imageSmoothingEnabled=true;
    cx.drawImage(p.off,0,0,SAP_RES,SAP_ROWS,x0,L.hs,w,hw);
    // сетка по уровню
    cx.strokeStyle='rgba(128,140,150,.18)'; cx.lineWidth=1;
    if(n.p.grid){
      cx.beginPath();
      for(let g=0;g<=4;g++){ const y=Math.round(L.plotTop+L.plotH*g/4)+.5; cx.moveTo(x0,y); cx.lineTo(x0+w,y); }
      for(let g=1;g<4;g++){ const x=Math.round(x0+w*g/4)+.5; cx.moveTo(x,L.plotTop); cx.lineTo(x,L.plotTop+L.plotH); }
      cx.stroke();
    }
    const yOf=db=>L.plotTop+L.plotH*(1-clamp((db-n.p.floor)/rng,0,1));
    const stale=p.t && now-p.t>4000;
    const trace=(arr,col,alpha,fill)=>{
      cx.globalAlpha=alpha; cx.strokeStyle=col; cx.fillStyle=col; cx.lineWidth=1;
      let pen=false, lastX=0;
      cx.beginPath();
      for(let X=0;X<w;X++){
        const v=arr[Math.min(SAP_RES-1,Math.floor(X/w*SAP_RES))];
        if(v!==v){ pen=false; continue; }
        const y=yOf(v);
        if(!pen){ cx.moveTo(x0+X,y); pen=true; } else cx.lineTo(x0+X,y);
        lastX=X;
      }
      cx.stroke();
      if(fill){
        cx.globalAlpha=alpha*.18;
        cx.lineTo(x0+lastX,L.plotTop+L.plotH); cx.lineTo(x0,L.plotTop+L.plotH); cx.closePath(); cx.fill();
      }
      cx.globalAlpha=1;
    };
    if(n.p.peakHold) trace(p.pk,acc2,stale?.35:.8,false);
    trace(p.lv,acc,stale?.4:1,true);
    // граница: активное окно приёмника в этой панели / выбранная
    const live=span && p.t && now-p.t<1200 && !(p.hi<span[0] || p.lo>span[1]);
    if(live || n._pnSel===i){
      cx.strokeStyle=live?acc:dim; cx.lineWidth=live?1.5:1;
      cx.strokeRect(x0+.5,.5,w-1,H-1);
    } else { cx.strokeStyle='rgba(128,140,150,.35)'; cx.lineWidth=1; cx.strokeRect(x0+.5,.5,w-1,H-1); }
    // подписи: имя диапазона, границы и середина оси
    cx.save(); cx.beginPath(); cx.rect(x0,0,w,H); cx.clip();
    cx.textBaseline='alphabetic';
    if(p.color){ cx.fillStyle=p.color; cx.fillRect(x0+2,2,6,6); }
    cx.fillStyle=fg; cx.textAlign='left';
    cx.fillText(p.label||fmtHz((p.lo+p.hi)/2,3),x0+(p.color?11:3),10);
    cx.fillStyle=dim;
    // подписи оси — сколько влезает: три, две крайних или только центр
    const tl=fmtHz(p.lo,3), tm=fmtHz((p.lo+p.hi)/2,3), th=fmtHz(p.hi,3), mw=s=>cx.measureText(s).width;
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
  });
  // курсор: частота и уровень под указателем
  const h=n._pnHover;
  if(h && panes[h.i]){
    const p=panes[h.i], x0=Math.round(h.i*(L.w+SAP_GAP)), w=Math.round(L.w), f=p.lo+(p.hi-p.lo)*h.fx;
    const v=p.lv[Math.min(SAP_RES-1,Math.floor(h.fx*SAP_RES))];
    const x=x0+h.fx*w;
    cx.strokeStyle='rgba(255,255,255,.5)'; cx.lineWidth=1; cx.beginPath(); cx.moveTo(x+.5,L.plotTop); cx.lineTo(x+.5,H); cx.stroke();
    const t=fmtHz(f,4)+'Hz'+(v===v ? ' · '+v.toFixed(1)+' dB' : ''); cx.font='10px sans-serif';
    const tw=cx.measureText(t).width+8, tx=clamp(x+6,x0,x0+w-tw);
    cx.fillStyle='rgba(10,13,14,.85)'; cx.fillRect(tx,L.plotTop+2,tw,13);
    cx.fillStyle=fg; cx.textAlign='left'; cx.fillText(t,tx+4,L.plotTop+12);
  }
  cx.textAlign='left';
  if(n._pnTotal>panes.length){
    cx.fillStyle=dim; cx.textAlign='right';
    cx.fillText('+'+(n._pnTotal-panes.length)+' more bands (panes / first band #)',W-3,H-3); cx.textAlign='left';
  }
}
