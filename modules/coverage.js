"use strict";
/* ============================ Coverage Map ============================
   Предварительный расчёт покрытия: уровень сигнала передатчиков из списков Table на сетке вокруг точки над картой высот Horizon —
   свободное пространство, дифракция по Дейгауту, двухлучевая интерференция с землёй, диаграмма направленности. Мёртвые зоны (ниже порога
   чувствительности), контуры для карты, сравнение с замерами из Table (невязки, смещение для подстройки модели). Ядро — coverage-kernels.js. */

const CV_STOPS=[[0,[20,10,50]],[.25,[90,25,110]],[.5,[180,55,110]],[.75,[245,140,60]],[1,[252,240,170]]];
function cvColor(t){
  t=Math.max(0,Math.min(1,t));
  for(let i=1;i<CV_STOPS.length;i++) if(t<=CV_STOPS[i][0]){
    const a=CV_STOPS[i-1], b=CV_STOPS[i], k=(t-a[0])/(b[0]-a[0]);
    return a[1].map((v,q)=>Math.round(v+(b[1][q]-v)*k));
  }
  return CV_STOPS[CV_STOPS.length-1][1];
}
const cvHz=v=>{ if(typeof v==='number') return isFinite(v) ? v : null; const x=typeof parseHzCell==='function' ? parseHzCell(String(v??'')) : NaN; return isFinite(x) ? x : recNum(v); };
const cvLists=t=>String(t||'').split(',').map(s=>s.trim()).filter(Boolean);
const cvTick=()=>new Promise(r=>setTimeout(r,0));

async function covTx(n){
  const p=n.p, rows=[];
  for(const l of cvLists(p.tx)) rows.push(...(await gsRead(l).catch(()=>[])));
  rows.push(...n.recTx.values());
  const words=String(p.filter||'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean), out=[];
  for(const r of rows){
    const lat=recNum(r.lat), lon=recNum(r.lon), erp=recNum(r.erp_w ?? r.erp), f=cvHz(r.freq) ?? +p.freq;
    if(lat==null || lon==null || !(erp>0)) continue;
    const name=String(r.name ?? r.label ?? r.id ?? 'TX'), key=(name+' '+f).toLowerCase();
    if(words.length && !words.some(w=>key.includes(w))) continue;
    out.push({name,lat,lon,h:recNum(r.h) ?? 30,f,erp,az:recNum(r.azimuth),bw:recNum(r.beamwidth)});
  }
  return out;
}
async function covMeas(n){
  const out=[];
  for(const l of cvLists(n.p.meas)) for(const r of (await gsRead(l).catch(()=>[]))){
    const lat=recNum(r.lat), lon=recNum(r.lon), s=recNum(r.rssi ?? r.level);
    if(lat==null || lon==null || s==null) continue;
    out.push({name:String(r.name ?? r.label ?? ''),lat,lon,h:recNum(r.h),rssi:s,tx:String(r.tx ?? ''),f:cvHz(r.freq),list:l});
  }
  return out;
}

// картинка по ячейкам (север — вверх); пустые ячейки без расчёта — прозрачные только для карты
function covImage(R,mode,thr,clear){
  const {g,best,cnt,txs}=R, c=document.createElement('canvas'); c.width=g.nx; c.height=g.ny;
  const x=c.getContext('2d'), im=x.createImageData(g.nx,g.ny), mx=Math.max(1,txs.length);
  for(let j=0;j<g.ny;j++) for(let i=0;i<g.nx;i++){
    const v=best[j*g.nx+i], o=((g.ny-1-j)*g.nx+i)*4;
    let col, a=255;
    if(!isFinite(v)){ col=[12,16,18]; if(clear) a=0; }
    else if(mode) col=v<thr ? [18,36,64] : cvColor((v-thr)/60*.9+.1);
    else { const q=cnt[j*g.nx+i]; col=q===0 ? [18,36,64] : cvColor(q/mx*.9+.1); }
    im.data[o]=col[0]; im.data[o+1]=col[1]; im.data[o+2]=col[2]; im.data[o+3]=a;
  }
  x.putImageData(im,0,0); return c;
}
// растровый слой для карты: картинка и границы по широте / долготе (Map рисует строки по своей проекции)
function covRaster(n){
  const R=n.res, g=R.g, nw=R.F.inv(g.x0,g.y0+g.ny*g.cell), se=R.F.inv(g.x0+g.nx*g.cell,g.y0);
  return {id:'cov:raster',kind:'raster',label:'coverage',canvas:covImage(R,n.p.show==='strongest signal',R.thr,true),north:nw[0],west:nw[1],south:se[0],east:se[1],opacity:+n.p.rastAlpha};
}
async function covRun(n,key,cfg){
  const p=n.p, tok=n.tok={}, t0=performance.now(), stop=()=>n.tok!==tok;
  const fail=m=>{ if(!stop()){ n.msg=m; n.job=false; n.res=null; n.done=key; } };
  try{
    const txs=await covTx(n); if(stop()) return;
    if(!txs.length) return fail('no transmitters — a Table list in «transmitters» (name, lat, lon, h, freq, erp_w) or records on rec');
    const hAt=Horizon.hAt, F=ppFrame(cfg.lat,cfg.lon), T=hAt ? (x,y)=>{ const q=F.inv(x,y); return hAt(q[0],q[1]); } : ()=>+p.ground;
    const Rm=+p.radius*1000, g=cvGrid(Rm,+p.cell>0 ? +p.cell : Math.max(100,Math.min(500,2*Rm/120))), N=g.nx*g.ny;
    const best=new Float32Array(N).fill(NaN), who=new Int16Array(N).fill(-1), cnt=new Uint8Array(N), rxh=+p.rxh, rxg=+p.rxgain, thr=+p.min, k=+p.k||1.33;
    const base={k,step:100,gref:T(0,0)===T(0,0) ? T(0,0) : 0,twoRay:!!p.tworay,clutter:+p.clutter};
    let done=0, total=txs.length*N, last=performance.now();
    for(let q=0;q<txs.length;q++){
      const t=txs[q], a=F.fwd(t.lat,t.lon), gT=T(a[0],a[1]), o={...base,f:t.f,gref:gT===gT ? gT : base.gref};
      const A=[a[0],a[1],(gT===gT ? gT : o.gref)+t.h];
      for(let j=0;j<g.ny;j++){
        const y=g.cy(j);
        for(let i=0;i<g.nx;i++){
          const x=g.cx(i), c=j*g.nx+i, gR=T(x,y);
          if(gR!==gR){ continue; }
          const r=cvPathLoss(T,A,[x,y,gR+rxh],o), az=Math.atan2(x-a[0],y-a[1])/CV_D, pw=cvRx(t.erp,cvTxGain((az+360)%360,t.az,t.bw),r.loss,rxg);
          if(pw>=thr && cnt[c]<255) cnt[c]++;
          if(!(pw<=best[c])){ best[c]=pw; who[c]=q; }                       // NaN: первое значение
        }
        done+=g.nx;
        if(performance.now()-last>30){ n.msg='computing '+Math.round(100*done/total)+'% ('+(q+1)+'/'+txs.length+' '+txs[q].name+')'; last=performance.now(); await cvTick(); if(stop()) return; }
      }
    }
    // замеры: расчёт прямо в точке от «своего» передатчика (колонка tx) или от сильнейшего
    const meas=await covMeas(n), res=[];
    for(const m of meas){
      const a=F.fwd(m.lat,m.lon), gR=T(a[0],a[1]); if(gR!==gR) continue;
      let pred=-Infinity, by=null;
      const cand=txs.filter(t=>m.tx && t.name.toLowerCase()===m.tx.toLowerCase()), list=cand.length ? cand : txs;
      for(const t of list){
        const b=F.fwd(t.lat,t.lon), gT=T(b[0],b[1]), o={...base,f:m.f ?? t.f,gref:gT===gT ? gT : base.gref};
        const r=cvPathLoss(T,[b[0],b[1],(gT===gT ? gT : o.gref)+t.h],[a[0],a[1],gR+(m.h>0 ? m.h : rxh)],o);
        const az=(Math.atan2(a[0]-b[0],a[1]-b[1])/CV_D+360)%360, pw=cvRx(t.erp,cvTxGain(az,t.az,t.bw),r.loss,rxg);
        if(pw>pred){ pred=pw; by=t.name; }
      }
      res.push({...m,x:a[0],y:a[1],pred,by,res:m.rssi-pred});
    }
    if(stop()) return;
    n.res={g,F,best,who,cnt,txs,thr,res,lat:cfg.lat,lon:cfg.lon,t:Date.now(),stats:cvStats(best,g.cell,thr),rs:cvResid(res.map(r=>[r.rssi,r.pred])),ms:Math.round(performance.now()-t0)};
    n.msg=''; n.job=false; n.done=key; n.emit=covRecords(n); n.emit.raster=[covRaster(n)]; n.img=null;
  }catch(e){ fail('coverage: '+e.message); }
}
// записи: сводка, контур порога (path — на карту), замеры с невязкой
function covRecords(n){
  const R=n.res, p=n.p, t=new Date(R.t).toISOString(), rec=[], poly=[], g=R.g;
  const ll=pt=>{ const q=R.F.inv(g.x0+(pt[0]+.5)*g.cell,g.y0+(pt[1]+.5)*g.cell); return [+q[0].toFixed(5),+q[1].toFixed(5)]; };
  rec.push({id:'cov:summary',t,kind:'coverage',label:'dead '+Math.round(100*R.stats.dead)+'%',lat:R.lat,lon:R.lon,radius_km:+p.radius,min_dbm:R.thr,tx:R.txs.length,
    dead_pct:+(100*R.stats.dead).toFixed(1),dead_km2:+R.stats.dead_km2.toFixed(1),area_km2:+R.stats.area_km2.toFixed(0),mean_dbm:+R.stats.mean.toFixed(1),max_dbm:+R.stats.max.toFixed(1),
    bias_db:R.rs.n ? +R.rs.bias.toFixed(1) : '',rms_db:R.rs.n ? +R.rs.rms.toFixed(1) : '',meas:R.rs.n});
  cvContour(R.best,g.nx,g.ny,R.thr).forEach((l,i)=>{ if(l.length>3) poly.push({id:'cov:edge:'+i,label:'dead zone edge '+R.thr+' dBm',lat:ll(l[0])[0],lon:ll(l[0])[1],icon:'dot',color:'#ff5c5c',path:l.map(ll)}); });
  for(const m of R.res) rec.push({id:'cov:m:'+(m.name||m.lat+','+m.lon),t,kind:'residual',label:(m.res>=0 ? '+' : '')+m.res.toFixed(0)+' dB',name:m.name,lat:m.lat,lon:m.lon,tx:m.by,
    rssi:m.rssi,pred_dbm:+m.pred.toFixed(1),resid_db:+m.res.toFixed(1),color:m.res>=0 ? '#6fd0ff' : '#ff9a4d',icon:'dot'});
  return {rec,poly};
}
async function covSave(n){
  if(!n.res){ n.msg='nothing to save yet'; return; }
  const rows=n.res.res.map(m=>({name:m.name,t:new Date(n.res.t).toISOString(),lat:m.lat,lon:m.lon,tx:m.by,freq:m.f ?? '',rssi:m.rssi,pred_dbm:+m.pred.toFixed(1),resid_db:+m.res.toFixed(1),list:m.list}));
  if(!rows.length){ n.msg='no measurements (a Table list in «measurements» with lat, lon, rssi)'; return; }
  await tblPut(n.p.save||'analysis/coverage',Object.keys(rows[0]),rows);
  n.msg='saved '+rows.length+' residuals to «'+(n.p.save||'analysis/coverage')+'»';
}
function covApplyBias(n){
  const rs=n.res?.rs; if(!rs || !rs.n){ n.msg='no measurements to calibrate on'; return; }
  const c=Math.max(0,+((+n.p.clutter)-rs.bias).toFixed(1)); setMod(n,'clutter',c); n.msg='extra loss '+c.toFixed(1)+' dB (bias '+rs.bias.toFixed(1)+' dB'+(c===0 && rs.bias>0 ? ': the signal is stronger than predicted, loss cannot go below 0' : ' removed')+')';
}

def({ id:'coverage', title:'Coverage Map', cat:'Radio', kw:'coverage map dead zones signal strength transmitters fm tv broadcast propagation terrain diffraction prediction measurements compare',
  // lat / lon — центр расчёта (иначе My Position); rec — передатчики записями (name, lat, lon, h, freq, erp_w, azimuth, beamwidth), накапливаются по name;
  // dead — доля мёртвых ячеек, %; area — их площадь, км²; bias / rms — невязка с замерами (измерено − расчёт), дБ; n — замеров; rec — сводка, невязки;
  // poly — контур порога для карты
  ins:[{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'rec',t:'rec'}],
  outs:[{n:'dead',t:'num'},{n:'area',t:'num'},{n:'bias',t:'num'},{n:'rms',t:'num'},{n:'n',t:'num'},{n:'rec',t:'rec'},{n:'poly',t:'rec'},{n:'raster',t:'rec'}],
  w:440, view:{h:380}, resize:true, readout:true,
  params:[{n:'tx',t:'text',d:'',label:'transmitters: Table lists, comma-separated (name, lat, lon, h, freq, erp_w, azimuth, beamwidth)'},
          {n:'filter',t:'text',d:'',label:'only these (names or frequencies, comma-separated; empty — all)'},
          {n:'meas',t:'text',d:'',label:'field measurements: Table lists (lat, lon, rssi dBm, h, tx, freq) — compared with the calculation'},
          {n:'radius',t:'range',min:2,max:60,step:1,d:20,label:'radius, km (inside the Horizon radius)'},
          {n:'cell',t:'range',min:0,max:1000,step:10,d:0,label:'cell, m (0 — auto, up to ~120 cells across)'},
          {n:'min',t:'range',min:-130,max:-40,step:1,d:-95,label:'receiver sensitivity, dBm: below it is a dead zone'},
          {n:'rxh',t:'range',min:.5,max:30,step:.5,d:1.5,label:'receiving antenna height, m'},
          {n:'rxgain',t:'range',min:-10,max:15,step:.5,d:0,label:'receiving antenna gain, dBi'},
          {n:'freq',t:'num',d:100e6,label:'frequency, Hz, for transmitters without freq'},
          {n:'k',t:'range',min:1,max:2,step:.01,d:1.33,label:'refraction k (4/3 — standard)'},
          {n:'clutter',t:'range',min:0,max:40,step:.5,d:0,label:'extra loss (buildings, trees), dB — «Calibrate» sets it from the measurements'},
          {n:'tworay',t:'check',d:false,label:'two-ray ground interference on line of sight (lobes and nulls; needs antenna heights)'},
          {n:'show',t:'select',opts:['strongest signal','signals above threshold'],d:'strongest signal',label:'map shows'},
          {n:'rastAlpha',t:'range',min:.2,max:1,step:.05,d:.55,label:'raster opacity on the Map (output `raster`)',adv:true},
          {n:'save',t:'text',d:'analysis/coverage',label:'Table list for the residuals'},
          {n:'tosave',t:'button',label:'Save residuals to table',fn:n=>covSave(n)},
          {n:'cal',t:'button',label:'Calibrate: remove the bias',fn:n=>covApplyBias(n)},
          {n:'calc',t:'button',label:'Recalculate',fn:n=>{ n.key=''; n.due=0; }},
          {n:'clr',t:'button',label:'Forget transmitters from rec',fn:n=>{ n.recTx.clear(); n.key=''; }},
          {n:'ground',t:'num',d:0,label:'ground height without Horizon, m',adv:true}],
  init:n=>{ n.res=null; n.key=''; n.due=0; n.job=false; n.done=null; n.tok=null; n.emit=null; n.msg=''; n.recTx=new Map(); n.img=null; n.imgKey=''; },
  dispose:n=>{ n.tok=null; },
  process(n,I){
    const p=n.p, now=Date.now();
    for(const r of recList(I.rec)) if(r && recNum(r.lat)!=null && recNum(r.erp_w ?? r.erp)>0){ const id=String(r.name ?? r.label ?? r.id ?? n.recTx.size); const s=JSON.stringify(r); if(n.recTx.get(id)?._s!==s){ n.recTx.set(id,{...r,_s:s}); n.key=''; } }
    let lat=recNum(I.lat) ?? GeoMe.lat, lon=recNum(I.lon) ?? GeoMe.lon;
    if(lat==null || lon==null){ const f=[...n.recTx.values()][0]; if(f){ lat=recNum(f.lat); lon=recNum(f.lon); } }
    if(lat==null || lon==null) n.noPos=true;
    else {
      n.noPos=false;
      const key=[lat,lon,p.tx,p.filter,p.meas,p.radius,p.cell,p.min,p.rxh,p.rxgain,p.freq,p.k,p.clutter,p.tworay,p.ground,Horizon.ver,Horizon.hAt?1:0,ListDB.rev,n.recTx.size].join('|');
      if(key!==n.key){
        if(!n.due){ n.due=now+600; n.msg='…'; }
        if(now>=n.due){ n.due=0; n.key=key; n.job=true; covRun(n,key,{lat,lon}); }
      }
    }
    const R=n.res, e=n.emit; n.emit=null;
    return {dead:R ? 100*R.stats.dead : null, area:R ? R.stats.dead_km2 : null, bias:R && R.rs.n ? R.rs.bias : null, rms:R && R.rs.n ? R.rs.rms : null, n:R ? R.rs.n : null,
      rec:e ? e.rec : null, poly:e ? e.poly : null, raster:e ? e.raster : null};
  },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, R=n.res, p=n.p, L=[], pad=8, leg=26, S=Math.max(40,Math.min(W-2*pad,H-2*pad-leg));
    cx.fillStyle=themeColor('--screen')||'#0a0d0e'; cx.fillRect(0,0,W,H);
    if(n.msg) L.push(n.msg);
    if(n.noPos) L.push('no centre — add My Position, wire lat / lon or give transmitters');
    if(R){
      const {g,best,cnt,txs,thr}=R, ox=(W-S)/2, oy=pad, sc=S/(g.nx*g.cell), mode=p.show==='strongest signal';
      const key=R.t+'|'+p.show+'|'+thr;
      if(n.imgKey!==key || !n.img){                              // картинка по ячейкам: одна на расчёт
        n.img=covImage(R,mode,thr,false); n.imgKey=key;
      }
      cx.imageSmoothingEnabled=false; cx.drawImage(n.img,ox,oy,S,S);
      // контур порога
      cx.strokeStyle='rgba(255,92,92,.9)'; cx.lineWidth=1.2; cx.setLineDash([4,3]);
      for(const l of cvContour(best,g.nx,g.ny,thr)){ cx.beginPath(); l.forEach((q,i)=>{ const X=ox+(q[0]+.5)*g.cell*sc, Y=oy+S-(q[1]+.5)*g.cell*sc; if(i) cx.lineTo(X,Y); else cx.moveTo(X,Y); }); cx.stroke(); }
      cx.setLineDash([]);
      const pos=(x,y)=>[ox+(x-g.x0)*sc, oy+S-(y-g.y0)*sc];
      cx.font='10px monospace'; cx.textAlign='left'; cx.textBaseline='alphabetic';
      for(const t of txs){ const a=R.F.fwd(t.lat,t.lon), q=pos(a[0],a[1]); if(q[0]<ox-8 || q[0]>ox+S+8 || q[1]<oy-8 || q[1]>oy+S+8) continue;
        cx.fillStyle='#7dff9a'; cx.strokeStyle='#000'; cx.lineWidth=1.5; cx.beginPath(); cx.moveTo(q[0],q[1]-6); cx.lineTo(q[0]+5,q[1]+4); cx.lineTo(q[0]-5,q[1]+4); cx.closePath(); cx.stroke(); cx.fill();
        cx.strokeStyle='rgba(0,0,0,.7)'; cx.strokeText(t.name,q[0]+8,q[1]+3); cx.fillText(t.name,q[0]+8,q[1]+3); }
      for(const m of R.res){ const q=pos(m.x,m.y); if(q[0]<ox || q[0]>ox+S || q[1]<oy || q[1]>oy+S) continue;
        cx.fillStyle=m.res>=0 ? '#6fd0ff' : '#ff9a4d'; cx.strokeStyle='#fff'; cx.lineWidth=1.5; cx.beginPath(); cx.arc(q[0],q[1],3+Math.min(4,Math.abs(m.res)/6),0,7); cx.fill(); cx.stroke(); }
      cx.strokeStyle='#c8d2d6'; cx.lineWidth=1; cx.strokeRect(ox,oy,S,S);
      // шкала
      const ly=oy+S+10, lw=Math.min(S,220), lx=(W-lw)/2;
      for(let i=0;i<lw;i++){ const c=cvColor(i/lw); cx.fillStyle='rgb('+c.join(',')+')'; cx.fillRect(lx+i,ly,1,8); }
      cx.fillStyle='#6c7a80'; cx.textAlign='left'; cx.fillText(mode ? thr+' dBm' : '≥1',lx,ly+19); cx.textAlign='right'; cx.fillText(mode ? (thr+60)+' dBm' : txs.length+' of '+txs.length,lx+lw,ly+19);
      cx.textAlign='center'; cx.fillText(mode ? 'dark blue — dead zone (below the sensitivity)' : 'dark blue — nothing above the sensitivity',W/2,ly+19);
      const km=g.nx*g.cell/1000;
      L.push('centre '+R.lat.toFixed(4)+', '+R.lon.toFixed(4)+' · '+(km).toFixed(0)+' km square · cell '+Math.round(g.cell)+' m · '+txs.length+' transmitter'+(txs.length>1 ? 's' : '')+' · '+(R.ms/1000).toFixed(1)+' s'+(Horizon.hAt ? '' : ' · no Horizon: flat ground'));
      L.push('dead zones (below '+thr+' dBm): '+Math.round(100*R.stats.dead)+'% = '+R.stats.dead_km2.toFixed(0)+' km² of '+R.stats.area_km2.toFixed(0)+' · mean '+R.stats.mean.toFixed(0)+' dBm, max '+R.stats.max.toFixed(0)+' dBm');
      if(R.rs.n) L.push('measurements: '+R.rs.n+' · measured − calculated: bias '+(R.rs.bias>=0 ? '+' : '')+R.rs.bias.toFixed(1)+' dB, rms '+R.rs.rms.toFixed(1)+' dB — «Calibrate» takes the bias out');
    }
    n.el.querySelector('.readout').textContent=L.join('\n');
  }});
