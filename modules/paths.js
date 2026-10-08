"use strict";
/* ============================ Signal Paths ============================
   Пути сигнала между двумя точками над картой высот Horizon: прямой (видимость, первая зона Френеля, дифракция на главном
   препятствии, потери) и однократные отражения от рельефа (точка отражения, лишняя длина, задержка, уровень относительно прямого).
   Результат — записи-связи (прямой и пути с path3) для карты, Video Overlay и Table. Концы — провода lat / lon, lat2 / lon2 (My Position,
   строки Table) или запись rec с двумя концами; высоты антенн h / h2 над землёй. Ядро — paths-kernels.js. */

const PP_COL={direct:'#7dff9a',weak:'#ffd84a',blocked:'#ff5c5c',reflect:'#ff6bd6'};
const PPS=()=>({direct:themeColor('--scr-ok'),weak:themeColor('--scr-warn'),blocked:themeColor('--scr-bad'),reflect:PP_COL.reflect});   // цвета на экране узла — по теме

function pathsEnds(n,I){
  const p=n.p, r=n.rec;                                  // последняя запись rec с двумя концами
  const w=(a,b)=>recNum(a) ?? recNum(b);
  const lat=w(I.lat,r?.lat), lon=w(I.lon,r?.lon), lat2=w(I.lat2,r?.lat2), lon2=w(I.lon2,r?.lon2);
  if(lat==null || lon==null || lat2==null || lon2==null) return null;
  const f=recNum(r?.freq);
  return {lat,lon,lat2,lon2,h:recNum(r?.h) ?? +p.h, h2:recNum(r?.h2) ?? +p.h2, alt:recNum(r?.alt), alt2:recNum(r?.alt2),
          freq:f>0 ? f : +p.freq, name:String(p.name || r?.label || r?.name || r?.id || '')};
}
function pathsRun(n,E){
  const p=n.p, F=ppFrame(E.lat,E.lon), hAt=Horizon.hAt, k=+p.k||1.33, f=E.freq;
  const T=hAt ? (x,y)=>{ const q=F.inv(x,y); return hAt(q[0],q[1]); } : ()=>+p.ground;
  const a=F.fwd(E.lat,E.lon), b=F.fwd(E.lat2,E.lon2), gA=T(a[0],a[1]), gB=T(b[0],b[1]);
  if(gA!==gA || gB!==gB) return {err:'no terrain at an end of the path — both points must lie inside the radius of a Horizon node'};
  const A=[a[0],a[1],E.alt ?? gA+E.h], B=[b[0],b[1],E.alt2 ?? gB+E.h2];
  const direct=ppDirect(T,A,B,k,f);
  const refl=ppReflections(T,A,B,{k,f,step:+p.step,tolM:+p.tol,maxRatio:+p.ratio,maxn:Math.round(+p.maxn),reflDb:+p.refl,grid:40000});
  return {F,T,A,B,gA,gB,direct,refl,E,k,f,L:direct.L};
}
// записи-связи: прямой (цвет по виду связи) и отражённые (path3 через точку отражения)
function pathsRecords(R){
  const {F,A,B,direct,refl,E}=R, id='path:'+(E.name||E.lat.toFixed(4)+','+E.lon.toFixed(4)+'→'+E.lat2.toFixed(4)+','+E.lon2.toFixed(4)), t=Date.now();
  const km=direct.L/1000, kind=direct.los ? (direct.fres>=.6 ? 'direct' : 'weak') : 'blocked';
  const out=[{id:id+':direct', t, kind:'direct', label:(E.name ? E.name+' ' : '')+km.toFixed(km<10 ? 2 : 1)+' km '+Math.round(direct.loss)+' dB'+(direct.los ? '' : ' (no LOS)'),
    lat:E.lat, lon:E.lon, alt:+A[2].toFixed(1), lat2:E.lat2, lon2:E.lon2, alt2:+B[2].toFixed(1), color:PP_COL[kind], icon:'dot',
    loss_db:+direct.loss.toFixed(1), fspl_db:+direct.fspl.toFixed(1), diff_db:+direct.diff.toFixed(1), los:direct.los ? 1 : 0, fresnel:isFinite(direct.fres) ? +direct.fres.toFixed(2) : '',
    clear_m:+direct.clear.toFixed(1), dist_km:+km.toFixed(3), delay_ns:0, freq:E.freq}];
  refl.forEach((r,i)=>{
    const q=F.inv(r.P[0],r.P[1]), rel=r.loss-direct.loss, ns=r.excess/PP_C*1e9;
    out.push({id:id+':r'+(i+1), t, kind:'reflect', label:'refl '+(rel>=0 ? '+' : '')+Math.round(rel)+' dB  +'+Math.round(ns)+' ns',
      lat:+q[0].toFixed(6), lon:+q[1].toFixed(6), alt:+r.P[2].toFixed(1), color:PP_COL.reflect, icon:'dot',
      path3:[[E.lat,E.lon,+A[2].toFixed(1)],[+q[0].toFixed(6),+q[1].toFixed(6),+r.P[2].toFixed(1)],[E.lat2,E.lon2,+B[2].toFixed(1)]],
      loss_db:+r.loss.toFixed(1), rel_db:+rel.toFixed(1), delay_ns:+ns.toFixed(1), excess_m:+r.excess.toFixed(1), dist_km:+(r.len/1000).toFixed(3), miss_m:+r.miss.toFixed(1), freq:E.freq});
  });
  return out;
}
async function pathsSave(n){
  if(!n.res || n.res.err){ n.msg='nothing to save yet'; return; }
  const rows=pathsRecords(n.res).map(r=>({...r,path3:r.path3 ? JSON.stringify(r.path3) : ''})), cols=[...new Set(rows.flatMap(r=>Object.keys(r)))];
  await tblPut(n.p.save||'analysis/paths',cols,rows);
  n.msg='saved '+rows.length+' links to «'+(n.p.save||'analysis/paths')+'»';
}

def({ id:'paths', title:'Signal Paths', cat:'Radio', kw:'propagation path reflection multipath line of sight fresnel diffraction link two points radio terrain delay',
  // lat lon — первый конец, lat2 lon2 — второй (My Position, Table, любой источник); rec — запись с двумя концами (строка Table: lat lon h lat2 lon2 h2 freq);
  // h / h2 — высоты антенн над землёй, м (параметры, провод на них тоже работает). Концы должны лежать в радиусе узла Horizon
  ins:[{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'lat2',t:'num'},{n:'lon2',t:'num'},{n:'rec',t:'rec'}],
  // rec — связи: прямой путь и отражения; loss — потери прямого пути, дБ; los — прямая видимость; fres — запас по первой зоне Френеля (≥0.6 — норма);
  // n — отражённых путей; spread — максимальная лишняя задержка отражённых путей не слабее прямого на 20 дБ, нс
  outs:[{n:'rec',t:'rec'},{n:'loss',t:'num'},{n:'los',t:'num'},{n:'fres',t:'num'},{n:'dist',t:'num'},{n:'n',t:'num'},{n:'spread',t:'num'}],
  w:420, view:{h:300}, resize:true, readout:true,
  params:[{n:'freq',t:'num',d:100e6,label:'frequency, Hz (a record freq overrides)'},
          {n:'h',t:'num',d:10,label:'antenna height at the first end, m above ground'},
          {n:'h2',t:'num',d:10,label:'antenna height at the second end, m'},
          {n:'k',t:'range',min:1,max:2,step:.01,d:1.33,label:'refraction k (4/3 — standard)'},
          {n:'refl',t:'range',min:0,max:30,step:.5,d:8,label:'reflection loss, dB (rough terrain 8…15, water / smooth ground 2…6)'},
          {n:'maxn',t:'range',min:1,max:10,step:1,d:5,label:'reflected paths to keep'},
          {n:'ratio',t:'range',min:1.1,max:4,step:.1,d:2,label:'longest reflected path ÷ direct path'},
          {n:'tol',t:'range',min:5,max:200,step:5,d:30,label:'reflection tolerance, m (the reflected ray may miss the other end by this)'},
          {n:'step',t:'range',min:0,max:500,step:5,d:0,label:'search grid, m (0 — auto)',adv:true},
          {n:'name',t:'text',d:'',label:'name of the link (in the records)'},
          {n:'save',t:'text',d:'analysis/paths',label:'Table list for «Save to table»'},
          {n:'tosave',t:'button',label:'Save to table',fn:n=>pathsSave(n)},
          {n:'calc',t:'button',label:'Recalculate',fn:n=>{ n.key=''; n.due=0; }},
          {n:'ground',t:'num',d:0,label:'ground height without Horizon, m',adv:true}],
  init:n=>{ n.rec=null; n.sig=''; n.res=null; n.key=''; n.due=0; n.emit=null; n.msg=''; n.busy=false; },
  process(n,I){
    const now=Date.now();
    for(const r of recList(I.rec)) if(r && recNum(r.lat)!=null && recNum(r.lat2)!=null){      // запись с другими концами — пересчёт (Table повторяет одну и ту же)
      const sig=[r.lat,r.lon,r.h,r.lat2,r.lon2,r.h2,r.alt,r.alt2,r.freq,r.label,r.name,r.id].join('|');
      if(sig!==n.sig){ n.sig=sig; n.rec=r; }
    }
    const E=pathsEnds(n,I);
    if(!E){ n.msg='give the two ends: wires lat / lon and lat2 / lon2, or a record with both (a Table row)'; n.res=null; }
    else {
      const key=[E.lat,E.lon,E.lat2,E.lon2,E.h,E.h2,E.alt,E.alt2,E.freq,E.name,n.p.k,n.p.refl,n.p.maxn,n.p.ratio,n.p.tol,n.p.step,n.p.ground,Horizon.ver,Horizon.hAt?1:0].join('|');
      if(key!==n.key){
        if(!n.due){ n.due=now+400; n.msg='computing…'; }          // слайдер и перетаскивание точек не запускают расчёт на каждый шаг
        if(now>=n.due){
          n.due=0; n.key=key;
          try{
            const R=pathsRun(n,E); n.res=R;
            if(R.err) n.msg=R.err; else { n.msg=''; n.emit=pathsRecords(R); }
          }catch(e){ n.res=null; n.msg='paths: '+e.message; }
        }
      }
    }
    const R=n.res && !n.res.err ? n.res : null, e=n.emit; n.emit=null;
    let spread=null;
    if(R){ spread=0; for(const r of R.refl) if(r.loss-R.direct.loss<=20) spread=Math.max(spread,r.excess/PP_C*1e9); }
    return {rec:e, loss:R ? R.direct.loss : null, los:R ? (R.direct.los ? 1 : 0) : null, fres:R && isFinite(R.direct.fres) ? R.direct.fres : null,
      dist:R ? R.L/1000 : null, n:R ? R.refl.length : null, spread};
  },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, R=n.res && !n.res.err ? n.res : null, L=[];
    cx.fillStyle=themeColor('--screen')||'#0a0d0e'; cx.fillRect(0,0,W,H);
    if(n.msg) L.push(n.msg);
    if(R){
      const {A,B,T,direct,refl,E,k,f}=R, Lm=R.L, N=Math.min(240,Math.max(40,Math.round(W/2))), Re=PP_R*k, ux=(B[0]-A[0])/Lm, uy=(B[1]-A[1])/Lm, uz=(B[2]-A[2])/Lm;
      const hs=[], lam=PP_C/f; let lo=Infinity, hi=-Infinity;
      for(let i=0;i<=N;i++){                                   // рельеф вдоль прямой + кривизна Земли (как в расчёте)
        const t=i/N, h=T(A[0]+(B[0]-A[0])*t,A[1]+(B[1]-A[1])*t), z=h===h ? h+Lm*t*Lm*(1-t)/(2*Re) : NaN;
        hs.push(z); if(z===z){ lo=Math.min(lo,z); hi=Math.max(hi,z); }
      }
      lo=Math.min(lo,A[2],B[2]); hi=Math.max(hi,A[2],B[2]); for(const r of refl){ lo=Math.min(lo,r.P[2]); hi=Math.max(hi,r.P[2]); }
      const pad=26, span=Math.max(10,hi-lo), y0=lo-span*.05, y1=hi+span*.18, X=s=>pad+(W-2*pad)*s/Lm, Y=z=>H-pad-(H-2*pad)*(z-y0)/(y1-y0);
      cx.fillStyle='#2a2f2a'; cx.beginPath(); cx.moveTo(X(0),H-pad);
      for(let i=0;i<=N;i++) if(hs[i]===hs[i]) cx.lineTo(X(Lm*i/N),Y(hs[i]));
      cx.lineTo(X(Lm),H-pad); cx.closePath(); cx.fill(); cx.strokeStyle='#6c7a80'; cx.lineWidth=1; cx.stroke();
      // первая зона Френеля вокруг прямой
      cx.strokeStyle='rgba(125,255,154,.35)'; cx.lineWidth=1;
      for(const sg of [1,-1]){
        cx.beginPath();
        for(let i=0;i<=N;i++){ const t=i/N, z=A[2]+(B[2]-A[2])*t+sg*Math.sqrt(lam*Lm*t*(1-t)), x=X(Lm*t), y=Y(z); if(i) cx.lineTo(x,y); else cx.moveTo(x,y); }
        cx.stroke();
      }
      // прямой путь
      const kind=direct.los ? (direct.fres>=.6 ? 'direct' : 'weak') : 'blocked';
      cx.strokeStyle=PPS()[kind]; cx.lineWidth=2; cx.beginPath(); cx.moveTo(X(0),Y(A[2])); cx.lineTo(X(Lm),Y(B[2])); cx.stroke();
      if(direct.nuI>=0 && !direct.los){ const t=direct.nuI/direct.prof.n; cx.fillStyle=PPS().blocked; cx.beginPath(); cx.arc(X(Lm*t),Y(hs[Math.round(t*N)]),4,0,7); cx.fill(); }
      // отражённые: проекция на вертикальную плоскость через A и B (боковое смещение подписано)
      cx.lineWidth=1.2; cx.setLineDash([5,4]); cx.font='10px monospace'; cx.textAlign='left'; cx.textBaseline='alphabetic';
      refl.forEach((r,i)=>{
        const sx=(r.P[0]-A[0])*ux+(r.P[1]-A[1])*uy, off=(r.P[0]-A[0])*(-uy)+(r.P[1]-A[1])*ux, a=.9-.5*Math.min(1,Math.max(0,(r.loss-direct.loss)/25));
        cx.strokeStyle='rgba(255,107,214,'+a.toFixed(2)+')'; cx.beginPath(); cx.moveTo(X(0),Y(A[2])); cx.lineTo(X(sx),Y(r.P[2])); cx.lineTo(X(Lm),Y(B[2])); cx.stroke();
        cx.fillStyle='#ff6bd6'; cx.setLineDash([]); cx.beginPath(); cx.arc(X(sx),Y(r.P[2]),3,0,7); cx.fill(); cx.setLineDash([5,4]);
        cx.fillText((i+1)+(Math.abs(off)>5 ? ' ±'+Math.round(Math.abs(off))+' m' : ''),X(sx)+5,Y(r.P[2])-4);
      });
      cx.setLineDash([]);
      cx.fillStyle=themeColor('--scr-ok'); cx.fillRect(X(0)-2,Y(A[2])-2,4,4); cx.fillRect(X(Lm)-2,Y(B[2])-2,4,4);
      cx.fillStyle='#6c7a80'; cx.textAlign='center'; cx.fillText((Lm/1000).toFixed(2)+' km · ground '+Math.round(R.gA)+' → '+Math.round(R.gB)+' m'+(Horizon.hAt ? '' : ' · flat (no Horizon)'),W/2,H-7);
      L.push((E.name ? E.name+' · ' : '')+(Lm/1000).toFixed(2)+' km · '+(f/1e6).toFixed(3)+' MHz · antennas '+Math.round(A[2]-R.gA)+' / '+Math.round(B[2]-R.gB)+' m');
      L.push('direct: '+(direct.los ? 'line of sight' : 'BLOCKED ('+Math.round(-direct.clear)+' m)')+' · first Fresnel zone '+(isFinite(direct.fres) ? Math.round(direct.fres*100)+'% clear' : '—')+' · loss '+direct.loss.toFixed(1)+' dB (free space '+direct.fspl.toFixed(1)+(direct.diff ? ' + diffraction '+direct.diff.toFixed(1) : '')+')');
      refl.forEach((r,i)=>L.push('refl '+(i+1)+': '+(r.loss-direct.loss>=0 ? '+' : '')+(r.loss-direct.loss).toFixed(1)+' dB vs direct · +'+Math.round(r.excess)+' m = +'+Math.round(r.excess/PP_C*1e9)+' ns'));
      if(!refl.length) L.push('no reflections within tolerance — raise «tolerance» or «longest path»');
    }
    n.el.querySelector('.readout').textContent=L.join('\n');
  }});
