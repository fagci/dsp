"use strict";
/* ============================ Timeline ============================
   Строки Table (вход rows) как интервалы на оси времени. Дорожки — по колонке (частота, абонент, тип пакета, track…),
   цвет — по другой колонке, высота полоски — по rssi, фильтр, склейка пакетов в выходы в эфир, период / длительность /
   скважность / джиттер по дорожке или по выделенному отрезку, задержки ответа от опорных событий, связь по признаку.
   Воспроизведение: плейхед идёт по оси, начавшиеся события уходят на rec, звук из колонки file (Files) — по желанию.
   Хранилище — Table: сюда строки только приходят, наружу уходят выбранные строки (rows) и итоги по дорожкам (stats).
   Ядро — timeline-kernels.js, проверка: node tools/test-timeline.mjs */

const TL_COLORS=['#4da3ff','#ff9f4a','#5fd38d','#e46bd0','#f2d24b','#8e8cf5','#4fd0d0','#f26b6b'];
const TL_RND=v=>v==null ? null : Math.round(v*1e6)/1e6;

/* ---------- модель ---------- */
function tlBuild(n,rows,extra){
  const p=n.p, m=tlEvents(rows,{t:p.tcol,dur:p.dcol,unit:p.unit,rssi:p.rssi,file:p.file});
  if(!m.ok) return {ok:false,err:m.err};
  const f=tlFilter([p.filter,extra].filter(Boolean).join(' '));
  const ev=f ? m.ev.filter(f) : m.ev;
  if(!ev.length) return {ok:false,err:'no events match the filter',m};
  const by=String(p.by||'').trim().toLowerCase()==='none' ? '' : String(p.by||'').trim() ||
    TL_LANE.map(c=>m.cols.all.find(x=>x.toLowerCase()===c)).find(Boolean) || '';
  const gap=Math.max(0,+p.gap||0)*1e-3, lanes=tlLanes(ev,by).map(l=>{
    const tx=tlMerge(l.ev,gap); let maxd=0; for(const e of tx) if(e.t1-e.t0>maxd) maxd=e.t1-e.t0;
    return {name:l.name,ev:l.ev,tx,maxd};
  });
  const rc=m.cols.rssi; let rlo=Infinity, rhi=-Infinity;
  if(rc) for(const e of ev){ const v=tlNum(e.row[rc]); if(v!==null){ if(v<rlo) rlo=v; if(v>rhi) rhi=v; } }
  const refF=tlFilter(p.ref), refEv=refF ? ev.filter(refF) : null;
  if(refEv) for(const l of lanes) l.isRef=l.ev.every(refF);
  let tmax=0; for(const l of lanes) for(const e of l.tx) if(e.t1>tmax) tmax=e.t1;
  return {ok:true, m, ev, lanes, by, gap, tmax, rlo, rhi:rhi>rlo ? rhi : rlo+1, refEv, gen:(n._gen=(n._gen||0)+1), nraw:rows.length};
}
const tlKey=n=>[n.p.tcol,n.p.dcol,n.p.unit,n.p.rssi,n.p.file,n.p.filter,n.p.by,n.p.gap,n.p.ref].join('\0');

// события выбранных дорожек в отрезке (если он есть)
function tlScope(n){
  const T=n.tl; if(!T || !T.ok) return [];
  const r=n.range, out=[];
  T.lanes.forEach(l=>{
    if(n.solo!=null && l.name!==n.solo) return;
    out.push(r ? {l,tx:l.tx.filter(e=>e.t0>=r.a && e.t0<=r.b)} : {l,tx:l.tx});
  });
  return out;
}
function tlCompute(n){                                           // итоги по дорожкам и выходные ряды — один раз на смену модели / отрезка / дорожки
  const T=n.tl, key=T && T.ok ? T.gen+'|'+n.solo+'|'+(n.range ? n.range.a+'~'+n.range.b : '')+'|'+n.p.tol+'|'+n.p.lagmax : '';
  if(n._ck===key) return; n._ck=key;
  if(!key){ n.stats=[]; n.outRows=null; n.sum=null; return; }
  const sc=tlScope(n), rc=T.m.cols.rssi, tol=(+n.p.tol||10)/100, lagmax=(+n.p.lagmax||0)*1e-3;
  const stats=[], all=[];
  for(const {l,tx} of sc){
    const s=tlStats(tx,{tol,rssi:rc});
    if(T.refEv && !l.isRef){ const g=tlLag(T.refEv,tx,lagmax); s.lag=g.med; s.lag_std=g.std; s.lag_n=g.n; }
    stats.push(Object.assign({lane:l.name},...Object.keys(s).map(k=>({[k]:TL_RND(s[k])}))));
    for(const e of tx) for(const q of e.parts||[e]) all.push(q);
  }
  all.sort((a,b)=>a.t0-b.t0);
  n.stats=stats; n.outRows=all.map(e=>e.row);
  const flat=sc.flatMap(x=>x.tx).sort((a,b)=>a.t0-b.t0);
  n.sum=sc.length===1 ? stats[0] : tlStats(flat,{tol,rssi:rc});
  n.sumLanes=sc.length;
}

/* ---------- файлы из Files ---------- */
async function tlFindFile(ref){
  if(typeof FileStore==='undefined') return null;
  const id=tlNum(ref);
  if(id!==null){ const r=await FileStore.get(id); if(r) return r; }
  const name=String(ref).toLowerCase();
  for(const sp of FS_SPACES){ const hit=(await FileStore.listAll(sp)).find(f=>String(f.name).toLowerCase()===name); if(hit) return hit; }
  return null;
}
async function tlPlayFile(n,row,dur){
  const fc=n.tl && n.tl.m.cols.file, ref=fc ? row[fc] : null;
  if(ref==null || ref==='') return;
  const rec=await tlFindFile(ref);
  if(!rec || !rec.blob || !/^(audio|video)\//.test(rec.blob.type||rec.mime||'')) return;
  const url=URL.createObjectURL(rec.blob), a=new Audio(url), off=tlNum(row.off ?? row.offset);
  (n.auds||(n.auds=new Set())).add(a);
  const done=()=>{ n.auds.delete(a); URL.revokeObjectURL(url); };
  a.onended=a.onerror=done;
  if(off) a.currentTime=off;
  if(n.p.trim && dur>.01) setTimeout(()=>{ a.pause(); done(); },dur*1000);
  a.play().catch(done);
}
const tlStopAudio=n=>{ if(n.auds) for(const a of n.auds) a.pause(); n.auds=null; };

/* ---------- вид ---------- */
function tlFit(n){
  const T=n.tl; if(!T || !T.ok) return;
  const pad=Math.max(T.tmax*.02,1e-4); n.v0=-pad; n.v1=T.tmax+pad; redraw(n);
}
function tlGeo(n,cv){
  const W=cv.width, H=cv.height, T=n.tl, nl=T && T.ok ? T.lanes.length : 1;
  const fs=Math.max(9,Math.min(12,Math.round(H/20))), LAB=Math.min(Math.round(W*.28),36+fs*8), AX=fs+8, pw=Math.max(10,W-LAB-4);
  const lh=Math.max(12,Math.min(60,+n.p.lh||22)), rh=nl*lh<H-AX ? Math.min(60,Math.floor((H-AX)/nl)) : lh;
  const nvis=Math.max(1,Math.floor((H-AX)/rh));
  n.ly=clamp(n.ly|0,0,Math.max(0,nl-nvis));
  return {W,H,fs,LAB,AX,pw,rh,nvis,nl};
}
const tlX=(n,g,t)=>g.LAB+(t-n.v0)/(n.v1-n.v0)*g.pw;
const tlT=(n,g,x)=>n.v0+(x-g.LAB)/g.pw*(n.v1-n.v0);
function tlColor(n,e,li){
  const c=String(n.p.color||'').trim();
  if(!c) return TL_COLORS[li%TL_COLORS.length];
  const v=String(e.row[c]??''), cm=n.cmap||(n.cmap=new Map());
  if(!cm.has(v)) cm.set(v,cm.size);
  return TL_COLORS[cm.get(v)%TL_COLORS.length];
}
function tlHit(n,g,x,y){                                         // событие под точкой (допуск 4 px по времени)
  const T=n.tl; if(!T || !T.ok || y<g.AX) return null;
  const li=n.ly+Math.floor((y-g.AX)/g.rh), l=T.lanes[li]; if(!l) return {li,e:null};
  const tol=4/g.pw*(n.v1-n.v0), t=tlT(n,g,x);
  let best=null, bd=Infinity;
  for(let i=Math.max(0,tlBound(l.tx,t-tol-l.maxd)-1);i<l.tx.length && l.tx[i].t0<=t+tol;i++){
    const e=l.tx[i]; if(e.t1<t-tol) continue;
    const d=t<e.t0 ? e.t0-t : t>e.t1 ? t-e.t1 : 0;
    if(d<bd){ bd=d; best=e; }
  }
  return {li,e:best};
}
function tlPick(n){                                              // выбранное событие после пересборки модели
  const T=n.tl, k=n.pick; if(!k || !T || !T.ok) return null;
  const l=T.lanes.find(x=>x.name===k.lane); if(!l) return null;
  const e=l.tx.find(x=>x.i===k.i || (x.parts && x.parts.some(q=>q.i===k.i)));
  return e ? {l,e} : null;
}

function tlDraw(n,cv,cx){
  tlWire(n,cv);
  const T=n.tl, g=tlGeo(n,cv), {W,H,fs,LAB,AX,pw,rh}=g;
  cx.clearRect(0,0,W,H);
  cx.font=fs+'px monospace'; cx.textBaseline='middle';
  if(!T || !T.ok){ cx.fillStyle=themeColor('--axis'); cx.fillText(T ? T.err : 'wire a Table «rows» output',8,16); return; }
  if(n.v0==null) tlFit(n);
  const v0=n.v0, v1=n.v1, span=v1-v0, axis=themeColor('--axis'), grid=themeColor('--grid'), txt=themeColor('--txt');
  // линейка
  const step=tlStep(span,Math.max(2,pw/70));
  cx.strokeStyle=grid; cx.fillStyle=axis; cx.lineWidth=1; cx.textAlign='center';
  for(let t=Math.ceil(v0/step)*step;t<=v1;t+=step){
    const x=Math.round(tlX(n,g,t))+.5;
    cx.beginPath(); cx.moveTo(x,AX-4); cx.lineTo(x,H); cx.stroke();
    cx.fillText(tlFmt(Math.abs(t)<step*1e-6 ? 0 : t,step),Math.max(LAB+14,Math.min(W-14,x)),AX/2-1);
  }
  const pk=tlPick(n), link=String(n.p.link||'').trim().split(',').map(s=>s.trim()).filter(Boolean);
  const lk=pk && link.length ? link.map(c=>pk.e.row[c]).join('\0') : null;
  const rc=T.m.cols.rssi, rspan=T.rhi-T.rlo, hbar=n.p.rssiH && rc;
  const scope=new Set(n.solo!=null ? [n.solo] : T.lanes.map(l=>l.name));
  for(let k=0;k<g.nvis;k++){
    const li=n.ly+k, l=T.lanes[li]; if(!l) break;
    const y0=AX+k*rh, inner=rh-4;
    cx.strokeStyle=grid; cx.beginPath(); cx.moveTo(0,y0+rh-.5); cx.lineTo(W,y0+rh-.5); cx.stroke();
    cx.textAlign='left'; cx.fillStyle=scope.has(l.name) ? txt : axis;
    cx.fillText(String(l.name).slice(0,Math.floor((LAB-8)/(fs*.6))),4,y0+rh/2);
    cx.save(); cx.beginPath(); cx.rect(LAB,y0,pw+4,rh); cx.clip();
    const tx=l.tx; let drawn=0;
    for(let i=Math.max(0,tlBound(tx,v0-l.maxd)-1);i<tx.length && tx[i].t0<=v1 && drawn<20000;i++){
      const e=tx[i]; if(e.t1<v0) continue;
      drawn++;
      const x=tlX(n,g,e.t0), w=Math.max(1,tlX(n,g,e.t1)-x);
      let h=inner;
      if(hbar){ const v=tlNum(e.row[rc]); if(v!==null) h=Math.max(3,inner*(.25+.75*clamp((v-T.rlo)/rspan,0,1))); }
      cx.fillStyle=tlColor(n,e,li);
      cx.globalAlpha=scope.has(l.name) ? 1 : .35;
      cx.fillRect(x,y0+2+inner-h,w,h);
      if(lk!==null && link.map(c=>e.row[c]).join('\0')===lk){
        cx.globalAlpha=1; cx.strokeStyle=txt; cx.strokeRect(x-.5,y0+1.5,w+1,rh-3); }
    }
    cx.globalAlpha=1; cx.restore();
  }
  if(pk){                                                        // выбранное — рамкой на своей дорожке
    const li=T.lanes.indexOf(pk.l), k=li-n.ly;
    if(k>=0 && k<g.nvis){ const x=tlX(n,g,pk.e.t0), w=Math.max(1,tlX(n,g,pk.e.t1)-x), y0=AX+k*rh;
      cx.strokeStyle='#fff'; cx.lineWidth=1.5; cx.strokeRect(x-1,y0+1,w+2,rh-2); cx.lineWidth=1; }
  }
  if(n.range){                                                   // отрезок измерения
    const a=tlX(n,g,n.range.a), b=tlX(n,g,n.range.b);
    cx.fillStyle='rgba(120,160,255,.16)'; cx.fillRect(a,AX,b-a,H-AX);
    cx.strokeStyle='rgba(120,160,255,.9)'; cx.beginPath(); cx.moveTo(Math.round(a)+.5,AX); cx.lineTo(Math.round(a)+.5,H); cx.moveTo(Math.round(b)+.5,AX); cx.lineTo(Math.round(b)+.5,H); cx.stroke();
    cx.fillStyle=txt; cx.textAlign='left'; cx.fillText('Δ '+tlDur(n.range.b-n.range.a),Math.min(W-80,Math.max(LAB,a)+4),AX+fs);
  }
  if(n.ph!=null){
    const x=Math.round(tlX(n,g,n.ph))+.5;
    if(x>=LAB && x<=W){ cx.strokeStyle='#ff5c5c'; cx.lineWidth=1.5; cx.beginPath(); cx.moveTo(x,0); cx.lineTo(x,H); cx.stroke(); cx.lineWidth=1; }
  }
  if(g.nl>g.nvis){ cx.fillStyle=axis; cx.textAlign='right'; cx.fillText((n.ly+1)+'–'+(n.ly+g.nvis)+' / '+g.nl,W-4,AX+fs); }
  cx.textAlign='left'; cx.textBaseline='alphabetic';
}

function tlWire(n,cv){                                           // перетаскивание, выделение, колесо
  if(n._wcv===cv) return; n._wcv=cv;
  let drag=null;
  const pos=ev=>{ const r=cv.getBoundingClientRect(); return {x:(ev.clientX-r.left)*cv.width/r.width, y:(ev.clientY-r.top)*cv.height/r.height}; };
  cv.addEventListener('pointerdown',ev=>{
    ev.stopPropagation(); cv.setPointerCapture(ev.pointerId);
    const g=tlGeo(n,cv), q=pos(ev); if(!n.tl || !n.tl.ok) return;
    if(n.p.follow) setMod(n,'follow',false);
    const kind=q.x<g.LAB ? 'label' : q.y<g.AX ? 'seek' : ev.shiftKey ? 'range' : 'pan';
    drag={kind,x:q.x,y:q.y,v0:n.v0,v1:n.v1,t:tlT(n,g,q.x),moved:false};
    if(kind==='seek'){ n.ph=drag.t; n.pprev=n.ph; redraw(n); }
    if(kind==='pan') cv.style.cursor='grabbing';
  });
  cv.addEventListener('pointermove',ev=>{
    if(!drag) return;
    const g=tlGeo(n,cv), q=pos(ev), dx=q.x-drag.x;
    if(Math.abs(dx)+Math.abs(q.y-drag.y)>3) drag.moved=true;
    if(drag.kind==='pan'){ const dt=dx/g.pw*(drag.v1-drag.v0); n.v0=drag.v0-dt; n.v1=drag.v1-dt; }
    else if(drag.kind==='seek'){ n.ph=Math.max(0,tlT(n,g,q.x)); n.pprev=n.ph; }
    else if(drag.kind==='range' && drag.moved){ const t=tlT(n,g,q.x); n.range={a:Math.min(drag.t,t),b:Math.max(drag.t,t)}; }
    redraw(n);
  });
  const end=ev=>{
    if(!drag) return; const d=drag; drag=null; cv.style.cursor='';
    if(d.moved) { n._ck=''; return; }
    const g=tlGeo(n,cv), q=pos(ev);
    if(d.kind==='label'){                                         // клик по имени — только эта дорожка в измерениях и выходах
      const l=n.tl.lanes[n.ly+Math.floor((q.y-g.AX)/g.rh)];
      n.solo=l && n.solo!==l.name ? l.name : null; n._ck='';
    } else if(d.kind==='pan'){
      const h=tlHit(n,g,q.x,q.y);
      n.pick=h && h.e ? {lane:n.tl.lanes[h.li].name,i:h.e.i} : null;
      if(n.range && !n.pick) n.range=null;
      n._ck='';
    }
    redraw(n);
  };
  cv.addEventListener('pointerup',end); cv.addEventListener('pointercancel',()=>{ drag=null; cv.style.cursor=''; });
  cv.addEventListener('dblclick',ev=>{
    ev.stopPropagation(); if(!n.tl || !n.tl.ok) return;
    const g=tlGeo(n,cv), q=pos(ev), h=tlHit(n,g,q.x,q.y);
    if(h && h.e){ n.ph=h.e.t0; n.pprev=n.ph-1e-9; n.playing=true; }   // двойной клик по событию — играть с него
    else{ n.range=null; n.pick=null; n._ck=''; tlFit(n); }
    redraw(n);
  });
  cv.addEventListener('wheel',ev=>{
    ev.preventDefault(); ev.stopPropagation();
    const now=performance.now(); if(n._wt && now-n._wt<40) return; n._wt=now;
    if(!n.tl || !n.tl.ok) return;
    const g=tlGeo(n,cv), dy=ev.deltaY||ev.deltaX; if(!dy) return;
    if(ev.shiftKey){ n.ly+=dy>0 ? 1 : -1; redraw(n); return; }
    if(n.p.follow) setMod(n,'follow',false);
    const f=dy<0 ? 1/1.25 : 1.25, q=pos(ev), tc=tlT(n,g,q.x), span=Math.min(Math.max((n.v1-n.v0)*f,1e-6),Math.max(n.tl.tmax*20,1));
    const k=(tc-n.v0)/(n.v1-n.v0); n.v0=tc-k*span; n.v1=n.v0+span; redraw(n);
  },{passive:false});
}

/* ---------- узел ---------- */
def({ id:'timeline', lazy:'manual', title:'Timeline', cat:'Analysis',
  kw:'timeline intervals period duration duty cycle jitter airtime transmissions packets subscribers rssi lanes tracks clips arrange schedule replay playback files table rows repeat beacon lag delay gantt',
  ins:[{n:'rows',t:'bands'},{n:'filter',t:'txt'},{n:'at',t:'num'}],
  outs:[{n:'rows',t:'bands'},{n:'stats',t:'bands'},{n:'rec',t:'rec'},{n:'file',t:'txt'},{n:'on',t:'num'},{n:'t',t:'num'},
        {n:'count',t:'num'},{n:'period',t:'num'},{n:'dur',t:'num'},{n:'duty',t:'num'},{n:'hit',t:'num'}],
  view:{h:240}, resize:true, readout:true, w:560,
  params:[
    {n:'by',t:'text',d:'',label:'lanes by column(s)',tip:'one lane per distinct value: freq, src, kind… several columns separated by commas make a combined lane (freq,src). Empty — the first of track / lane / freq / chan / src / kind; «none» — one lane'},
    {n:'color',t:'text',d:'',label:'colour by column',tip:'packet kind, subscriber… ; empty — by lane'},
    {n:'filter',t:'text',d:'',label:'filter',tip:'terms separated by space: kind=req,ack  src=A*  rssi>-70  freq!=433.92  name~regex  word (in any column). All terms must match. The filter input adds to it'},
    {n:'gap',t:'num',min:0,d:0,label:'merge packets closer than, ms',tip:'packets of one lane that follow with a gap up to this are merged into one transmission: the period, duration and duty are measured on transmissions'},
    {n:'link',t:'text',d:'',label:'link by column(s)',tip:'select an event: all events with the same value of this column (a subscriber, an address) are outlined on every lane'},
    {n:'ref',t:'text',d:'',label:'reference events (lag)',tip:'a filter, e.g. kind=req: for every other lane the stats get lag — the time from a reference event to the next event of the lane (a reply to a request), its spread and count'},
    {n:'lagmax',t:'num',min:0,d:1000,label:'max lag, ms',adv:true},
    {n:'tol',t:'range',min:1,max:50,step:1,d:10,label:'period tolerance, %',tip:'an interval counts as a repeat when it is a whole multiple of the period within this tolerance (stats: ok = share of such intervals, miss = skipped repeats)'},
    {n:'rssiH',t:'check',d:false,label:'bar height = rssi',tip:'a stronger packet draws a taller bar (needs an rssi / level / power column)'},
    {n:'follow',t:'check',d:false,label:'follow the end',tip:'keep the right edge of the view on the newest event (a Table collecting live packets); any drag or zoom stops it'},
    {n:'lh',t:'range',min:12,max:60,step:1,d:22,label:'lane height',adv:true},
    {n:'tcol',t:'text',d:'',label:'time column (auto)',tip:'t, time, ts, timestamp, start …',adv:true},
    {n:'dcol',t:'text',d:'',label:'duration column (auto)',tip:'dur, duration, len, airtime … ; without it the end column (end / t1 / stop) is used, else the event is a point',adv:true},
    {n:'unit',t:'select',opts:['auto','s','ms','us'],d:'auto',label:'time unit of t and dur',tip:'auto: epoch milliseconds / microseconds are recognised by size, small numbers are seconds',adv:true},
    {n:'rssi',t:'text',d:'',label:'rssi column (auto)',adv:true},
    {n:'file',t:'text',d:'',label:'file column (auto)',tip:'file, fileId, clip, ref: a Files id or name to replay when the playhead reaches the event. Optional column off — start offset, s',adv:true},
    {n:'play',t:'button',label:'Play / Pause',fn:n=>{ n.playing=!n.playing; if(n.playing && n.ph==null) n.ph=n.range ? n.range.a : 0; if(n.playing) n.pprev=n.ph-1e-9; else tlStopAudio(n); redraw(n); }},
    {n:'stop',t:'button',label:'Stop',fn:n=>{ n.playing=false; n.ph=null; tlStopAudio(n); redraw(n); }},
    {n:'speed',t:'range',min:.1,max:64,step:.1,d:1,log:true,label:'play speed'},
    {n:'loop',t:'check',d:false,label:'loop (within the selection, if there is one)'},
    {n:'audible',t:'check',d:false,label:'play audio files of events',tip:'at the start of an event whose file column points to an audio or video file in Files the file is played; other files (IQ) are only reported on the rec / file outputs'},
    {n:'trim',t:'check',d:true,label:'cut the file at the event length',adv:true},
    {n:'fit',t:'button',label:'Fit all',fn:n=>{ n.range=null; n.pick=null; n._ck=''; tlFit(n); }},
    {n:'clr',t:'button',label:'Clear selection',fn:n=>{ n.range=null; n.pick=null; n.solo=null; n._ck=''; redraw(n); }}],
  init:n=>{ n.tl=null; n.tk=''; n.lastRows=null; n.lastLen=-1; n.lastT=0; n.lastF=null; n.v0=null; n.v1=null; n.ly=0;
    n.range=null; n.pick=null; n.solo=null; n.ph=null; n.pprev=null; n.playing=false; n.stats=[]; n.outRows=null; n.sum=null; n._ck=''; n.cmap=null; },
  dispose:n=>{ tlStopAudio(n); },
  process(n,I){
    const p=n.p, rows=Array.isArray(I.rows) ? I.rows : null, now=performance.now(), ext=typeof I.filter==='string' ? I.filter : '';
    if(!rows){ if(n.tl){ n.tl=null; n._ck=''; redraw(n); } return {rows:null,stats:null,count:0,on:0}; }
    const key=tlKey(n);
    if(rows!==n.lastRows || rows.length!==n.lastLen || key!==n.tk || ext!==n.lastF || now-n.lastT>2000){
      const grown=rows.length>n.lastLen;
      n.lastRows=rows; n.lastLen=rows.length; n.lastT=now; n.tk=key; n.lastF=ext;
      n.tl=tlBuild(n,rows,ext); n._ck='';
      if(n.tl.ok && grown && p.follow){ const w=n.v1!=null ? n.v1-n.v0 : n.tl.tmax; n.v1=n.tl.tmax+w*.02; n.v0=n.v1-w; }
      redraw(n);
    }
    const T=n.tl;
    if(!T || !T.ok) return {rows:null,stats:null,count:0,on:0};
    tlCompute(n);
    // воспроизведение
    let recs=null, file=null;
    const at=typeof I.at==='number' && isFinite(I.at) ? I.at : null;
    if(at!==null){ n.ph=Math.max(0,at); }
    else if(n.playing){
      const dt=BLOCK/Eng.sr*(+p.speed||1), lo=n.range ? n.range.a : 0, hi=n.range ? n.range.b : T.tmax;
      let a=n.pprev==null ? (n.ph ?? 0) : n.pprev, b=(n.ph ?? 0)+dt;
      if(b>hi){ if(p.loop){ b=lo; a=lo-1e-9; } else{ b=hi; n.playing=false; } }
      n.ph=b; n.pprev=b; n._cr=[a,b];
    }
    if(n.ph!=null){
      const cr=at!==null ? [n.pprev ?? n.ph, n.ph] : n._cr;
      if(cr && cr[1]>cr[0]){
        const hit=[]; for(const {l,tx} of tlScope({tl:T,solo:n.solo,range:null})) for(const e of tlCrossed(tx,cr[0],cr[1])) hit.push(e);
        if(hit.length){ hit.sort((x,y)=>x.t0-y.t0); recs=hit.map(e=>Object.assign({},e.row,{_t:TL_RND(e.t0),_dur:TL_RND(e.t1-e.t0)}));
          const fc=T.m.cols.file; if(fc){ for(const e of hit){ const f=e.row[fc]; if(f!=null && f!==''){ file=String(f); if(p.audible) tlPlayFile(n,e.row,e.t1-e.t0); } } } }
      }
      n._cr=null; n.pprev=n.ph;
      if(n.playing || at!==null) redraw(n);
    }
    let on=0;
    if(n.ph!=null) for(const l of T.lanes) on+=tlActive(l.tx,n.ph).length;
    const s=n.sum;
    return {rows:n.outRows, stats:n.stats, rec:recs, file, on, t:n.ph==null ? 0 : n.ph,
      count:s ? s.n : 0, period:s && s.period || 0, dur:s && s.dur || 0, duty:s && s.duty || 0, hit:recs ? 1 : 0};
  },
  draw(n,cv,cx){
    tlDraw(n,cv,cx);
    const el=n.el.querySelector('.readout'); if(!el) return;
    el.style.whiteSpace='pre-wrap';
    const T=n.tl; let s;
    if(!T) s='no rows';
    else if(!T.ok) s=T.err;
    else{
      tlCompute(n);
      const m=T.m, u=n.sum, ln=[];
      ln.push(T.ev.length+' events · '+T.lanes.length+' lanes by '+(T.by||'—')+' · '+tlDur(T.tmax)+(T.m.unit!=='s' ? ' ('+m.unit+')' : '')
        +(n.solo!=null ? ' · lane «'+n.solo+'»' : '')+(n.range ? ' · selection '+tlDur(n.range.b-n.range.a) : ''));
      const pc=v=>v==null ? '—' : Math.round(v*1000)/10+'%', one=x=>tlDur(x.period)+(x.jitter!=null ? ' ±'+pc(x.jitter) : '')+' · dur '+tlDur(x.dur)+' · duty '+pc(x.duty)
        +(x.ok!=null ? ' · ok '+pc(x.ok)+(x.miss ? ' (skipped '+x.miss+')' : '') : '')+(x.rssi!=null ? ' · '+Math.round(x.rssi)+' dBm' : '');
      if(n.sumLanes>1 && n.stats.length>1){
        for(const x of n.stats.slice(0,4)) ln.push('«'+x.lane+'» '+x.n+' tx · period '+one(x));
        if(n.stats.length>4) ln.push('… +'+(n.stats.length-4)+' lanes (stats output)');
      } else if(u && u.n)
        ln.push('tx '+u.n+(T.gap ? ' (merged ≤ '+n.p.gap+' ms)' : '')+' · period '+one(u));
      const pk=tlPick(n);
      if(pk){
        const e=pk.e, i=pk.l.tx.indexOf(e), prev=i>0 ? pk.l.tx[i-1] : null;
        ln.push('«'+pk.l.name+'» @'+tlDur(e.t0)+' · dur '+tlDur(e.t1-e.t0)+(e.n>1 ? ' · '+e.n+' packets' : '')
          +(prev ? ' · from the previous start '+tlDur(e.t0-prev.t0)+', pause '+tlDur(e.t0-prev.t1) : '')
          +'\n'+Object.entries(e.row).filter(([k,v])=>v!=='' && v!=null).slice(0,10).map(([k,v])=>k+'='+(typeof v==='object' ? JSON.stringify(v) : v)).join(' '));
      } else if(n.sum && n.stats && n.stats.length>1 && n.stats.some(x=>x.lag!=null))
        ln.push('lag from «'+n.p.ref+'»: '+n.stats.filter(x=>x.lag!=null).slice(0,4).map(x=>x.lane+' '+tlDur(x.lag)+(x.lag_std!=null ? ' ±'+tlDur(x.lag_std) : '')).join(' · '));
      if(n.p.ref && !T.refEv.length) ln.push('no reference events match «'+n.p.ref+'»');
      s=ln.join('\n');
    }
    if(el.textContent!==s) el.textContent=s;
  }});
