"use strict";
/* ============================ Site Plan ============================
   План участка / постройки по замерам: рулетка, GPS, компас, клинометр — всё складывается по весу (уравнивание МНК), с высотами (3D).
   Измерения — текстом, по строке на замер (синтаксис в siteplan-kernels.js и в README). GPS-замеры можно брать с входа rec (name, lat, lon, acc)
   и кнопкой «＋ GPS fix» из My Position. Результат: площадь, периметр, уклон контура, невязки (грубые ошибки подсвечены), точки с погрешностями;
   на карту — точки и контуры (если план привязан к земле: две GPS-точки или GPS + азимут), файлы DXF / SVG / GeoJSON / CSV. Ядро — siteplan-kernels.js. */

const SP_DEF='# Участок: стороны рулеткой (м), диагональ для жёсткости, GPS в одном углу и азимут первой стороны\nA-B 20.00\nB-C 12.00\nC-D 20.00\nD-A 12.00\nA-C 23.32\nA gps 55.0302 82.9204 ±4\nA-B az 90\npoly A B C D';
const sitepDl=(name,text,mime)=>{ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([text],{type:mime||'text/plain'})); a.download=name; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),10000); };
const spName=s=>String(s??'').trim().replace(/[\s-]+/g,'_');

function spText(n){                                                       // текст замеров + GPS-замеры, пришедшие записями
  let t=String(n.p.plan||'');
  for(const l of n.fixLines.values()) t+='\n'+l;
  return t;
}
function spOpts(n){
  const p=n.p, g=typeof Horizon!=='undefined' && Horizon.hAt ? Horizon.hAt : null;
  return {sd:+p.sd, sa:+p.sa, sg:+p.sg, eye:+p.eye, ground:p.ground && g ? g : null, sground:+p.sgr};
}
function spRecords(R){
  const rec=[], poly=[], t=new Date().toISOString();
  for(const p of R.pts) rec.push({id:'sp:'+p.name,t,kind:'plan point',label:p.name,x:+p.x.toFixed(3),y:+p.y.toFixed(3),z:+p.z.toFixed(2),
    sigma_m:isFinite(p.sx) ? +Math.hypot(p.sx,p.sy).toFixed(3) : '',...(R.georef ? {lat:+p.lat.toFixed(8),lon:+p.lon.toFixed(8),icon:'dot'} : {})});
  R.polys.forEach((pl,i)=>{
    if(!R.georef) return;
    const q=pl.names.map(nm=>R.pts.find(p=>p.name===nm)), path=q.map(p=>[+p.lat.toFixed(8),+p.lon.toFixed(8)]); path.push(path[0]);
    poly.push({id:'sp:poly:'+i,label:pl.area.toFixed(1)+' m²',lat:path[0][0],lon:path[0][1],icon:'dot',color:'#4fc3f7',path,area_m2:+pl.area.toFixed(2),perimeter_m:+pl.perimeter.toFixed(2),slope_deg:+pl.slope.toFixed(1)});
  });
  return {rec,poly};
}
function spRun(n,I){
  const R=spSolve(spText(n),spOpts(n));
  n.res=R; n.emit=spRecords(R); n.err=R.errors;
}

function spAddGps(n){
  const lat=n.inLat ?? GeoMe.lat, lon=n.inLon ?? GeoMe.lon;
  if(lat==null || lon==null){ n.msg='no position — wire My Position (lat / lon / acc) or set it there'; return; }
  const nm=spName(n.p.pname)||'P'+((n.res?.n||0)+1), acc=n.inAcc>0 ? n.inAcc : +n.p.sg, alt=n.inAlt;
  const line=nm+' gps '+(+lat).toFixed(7)+' '+(+lon).toFixed(7)+' ±'+(+acc).toFixed(1)+(isFinite(alt) && alt!==null ? ' alt '+(+alt).toFixed(1) : '');
  const cur=String(n.p.plan||'').replace(/\s+$/,'');
  const v=cur+(cur ? '\n' : '')+line; if(n.set?.plan) n.set.plan(v); else n.p.plan=v;
  n.key=''; n.msg='added: '+line;
}
function spExport(n,kind){
  const R=n.res; if(!R || !R.pts.length){ n.msg='nothing to export yet'; return; }
  if(kind==='dxf') sitepDl('siteplan.dxf',spDXF(R),'application/dxf');
  else if(kind==='svg') sitepDl('siteplan.svg',spSVG(R),'image/svg+xml');
  else if(kind==='csv') sitepDl('siteplan.csv',spCSV(R),'text/csv');
  else { const j=spGeoJSON(R); if(!j){ n.msg='GeoJSON needs a georeferenced plan: two GPS points, or one GPS point plus an azimuth («A-B az 90»)'; return; } sitepDl('siteplan.geojson',j,'application/geo+json'); }
}

def({ id:'siteplan', title:'Site Plan', cat:'Geo', kw:'plan site survey land plot measure tape gps clinometer height building outdoor indoor area perimeter slope dxf 3d construction fence foundation',
  // lat / lon / acc / alt — позиция (My Position) для кнопки «＋ GPS fix»; rec — GPS-замеры записями (name, lat, lon, acc, alt): складываются в план как «name gps …»;
  // area — площадь первого контура, м²; perim — его периметр, м; slope — уклон, °; rms — невязки в σ (≈1 — замеры согласованы); n — точек; rec — точки, poly — контуры для карты
  ins:[{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'acc',t:'num'},{n:'alt',t:'num'},{n:'rec',t:'rec'}],
  outs:[{n:'area',t:'num'},{n:'perim',t:'num'},{n:'slope',t:'num'},{n:'rms',t:'num'},{n:'n',t:'num'},{n:'rec',t:'rec'},{n:'poly',t:'rec'}],
  w:460, view:{h:380}, resize:true, readout:true,
  params:[{n:'plan',t:'code',plain:true,d:SP_DEF,label:'measurements, one per line: A-B 12.4 · A-B h 12.4 · A-B dz 1.2 · A-B az 45 · A-B-C 90 · A-B tilt 25 15 eye 1.6 · A z 120 · A gps lat lon ±3 · A at x y · poly A B C D (± — error, m or °)',fn:n=>{ n.key=''; }},
          {n:'view',t:'select',opts:['plan','3D'],d:'plan',label:'view'},
          {n:'az',t:'range',min:-180,max:180,step:5,d:-30,label:'3D: turn, °'},
          {n:'el',t:'range',min:5,max:90,step:5,d:35,label:'3D: elevation, °'},
          {n:'zex',t:'range',min:1,max:10,step:.5,d:2,label:'3D: height exaggeration ×'},
          {n:'sd',t:'range',min:.001,max:.5,step:.001,d:.03,label:'default tape error, m (one line: «± 0.1»)'},
          {n:'sa',t:'range',min:.2,max:10,step:.1,d:2,label:'default compass / angle / clinometer error, °'},
          {n:'sg',t:'range',min:.5,max:30,step:.5,d:5,label:'default GPS error, m (phone ≈ 3–5, dual-frequency 1–2, RTK 0.02)'},
          {n:'eye',t:'range',min:0,max:2.2,step:.05,d:0,label:'clinometer: eye height above the point, m (a line: «eye 1.6»)'},
          {n:'ground',t:'check',d:false,label:'GPS points take height from the Horizon terrain (weak, ±«terrain error»)'},
          {n:'sgr',t:'range',min:1,max:30,step:1,d:5,label:'terrain height error, m',adv:true},
          {n:'pname',t:'text',d:'',label:'name for «＋ GPS fix» (empty — P1, P2…)'},
          {n:'addgps',t:'button',label:'＋ GPS fix (My Position → the list)',fn:n=>spAddGps(n)},
          {n:'dxf',t:'button',label:'⬇ DXF (3D)',fn:n=>spExport(n,'dxf')},
          {n:'svg',t:'button',label:'⬇ SVG (dimensioned plan)',fn:n=>spExport(n,'svg')},
          {n:'gj',t:'button',label:'⬇ GeoJSON (georeferenced plans)',fn:n=>spExport(n,'gj')},
          {n:'csv',t:'button',label:'⬇ CSV (points ± error)',fn:n=>spExport(n,'csv')},
          {n:'clr',t:'button',label:'Forget GPS fixes from rec',fn:n=>{ n.fixLines.clear(); n.key=''; }}],
  init:n=>{ n.res=null; n.emit=null; n.key=''; n.err=[]; n.msg=''; n.fixLines=new Map(); n.inLat=null; n.inLon=null; n.inAcc=null; n.inAlt=null; },
  process(n,I){
    const p=n.p;
    n.inLat=recNum(I.lat); n.inLon=recNum(I.lon); n.inAcc=recNum(I.acc); n.inAlt=recNum(I.alt);
    for(const r of recList(I.rec)){
      const la=recNum(r?.lat), lo=recNum(r?.lon), nm=spName(r?.name ?? r?.label ?? '');
      if(la==null || lo==null || !nm) continue;
      const acc=recNum(r.acc ?? r.accuracy), alt=recNum(r.alt ?? r.altitude), key=nm+'|'+la+'|'+lo;
      if(n.fixLines.has(key)) continue;
      if(n.fixLines.size>=500) n.fixLines.delete(n.fixLines.keys().next().value);
      n.fixLines.set(key,nm+' gps '+la+' '+lo+(acc>0 ? ' ±'+acc : '')+(alt!=null ? ' alt '+alt : '')); n.key='';
    }
    const key=[p.plan,p.sd,p.sa,p.sg,p.eye,p.ground,p.sgr,n.fixLines.size,typeof Horizon!=='undefined' ? Horizon.ver : 0].join('|');
    let e=null;
    if(key!==n.key){ n.key=key; try{ spRun(n); }catch(err){ n.res=null; n.msg='plan: '+err.message; } e=n.emit; n.emit=null; }
    const R=n.res, pl=R?.polys[0];
    return {area:pl ? pl.area : null, perim:pl ? pl.perimeter : null, slope:pl ? pl.slope : null, rms:R && R.dof>0 ? R.rms : null, n:R ? R.n : null,
      rec:e ? e.rec : null, poly:e ? e.poly : null};
  },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, R=n.res, p=n.p, L=[], pad=26;
    cx.fillStyle=themeColor('--screen')||'#0a0d0e'; cx.fillRect(0,0,W,H);
    const fg=themeColor('--scr-txt')||'#9fb0b6';
    if(n.msg) L.push(n.msg);
    for(const e of n.err.slice(0,4)) L.push('line '+e.line+': '+e.msg+' — «'+e.text+'»');
    if(R && R.pts.length){
      const d3=p.view==='3D', pts=R.pts, A=(+p.az)*Math.PI/180, E=(+p.el)*Math.PI/180, zx=+p.zex;
      const pr=q=>{ if(!d3) return [q.x,q.y]; const xr=q.x*Math.cos(A)+q.y*Math.sin(A), yr=-q.x*Math.sin(A)+q.y*Math.cos(A); return [xr,q.z*zx*Math.cos(E)+yr*Math.sin(E)]; };
      const xy=pts.map(pr), zmin=Math.min(...pts.map(q=>q.z));
      let x0=1e99,x1=-1e99,y0=1e99,y1=-1e99; for(const [x,y] of xy){ x0=Math.min(x0,x); x1=Math.max(x1,x); y0=Math.min(y0,y); y1=Math.max(y1,y); }
      const sc=Math.min((W-2*pad)/Math.max(x1-x0,1e-6),(H-2*pad)/Math.max(y1-y0,1e-6)), ox=(W-(x1-x0)*sc)/2, oy=(H+(y1-y0)*sc)/2;
      const S=i=>[ox+(xy[i][0]-x0)*sc, oy-(xy[i][1]-y0)*sc];
      const bad=new Set(); for(const r of R.res) if(r.out && r.b!=='') bad.add([r.a,r.b].sort().join('|'));
      const idx=nm=>pts.findIndex(q=>q.name===nm);
      cx.font='10px monospace'; cx.textBaseline='alphabetic';
      for(const pl of R.polys){
        cx.beginPath(); pl.names.forEach((nm,k)=>{ const s=S(idx(nm)); if(k) cx.lineTo(s[0],s[1]); else cx.moveTo(s[0],s[1]); }); cx.closePath();
        cx.fillStyle='rgba(79,195,247,.18)'; cx.fill(); cx.strokeStyle='#4fc3f7'; cx.lineWidth=2; cx.stroke();
        let mx=0,my=0; pl.names.forEach(nm=>{ const s=S(idx(nm)); mx+=s[0]/pl.names.length; my+=s[1]/pl.names.length; });
        cx.fillStyle=fg; cx.textAlign='center'; cx.fillText(pl.area.toFixed(1)+' m²',mx,my);
      }
      for(const [a,b] of R.edges){
        const sa=S(a), sb=S(b), isBad=bad.has([pts[a].name,pts[b].name].sort().join('|'));
        cx.strokeStyle=isBad ? '#ff5c5c' : 'rgba(150,170,180,.7)'; cx.lineWidth=isBad ? 2 : 1; cx.setLineDash(isBad ? [] : [3,3]);
        cx.beginPath(); cx.moveTo(sa[0],sa[1]); cx.lineTo(sb[0],sb[1]); cx.stroke(); cx.setLineDash([]);
        if(!d3){ const d=Math.hypot(pts[b].x-pts[a].x,pts[b].y-pts[a].y,pts[b].z-pts[a].z); cx.fillStyle=isBad ? '#ff9a9a' : '#6c7a80'; cx.textAlign='center'; cx.fillText(d.toFixed(2),(sa[0]+sb[0])/2,(sa[1]+sb[1])/2-3); }
      }
      pts.forEach((q,i)=>{
        const s=S(i);
        if(d3 && q.z>zmin+1e-6){ const f=pr({x:q.x,y:q.y,z:zmin}), fy=oy-(f[1]-y0)*sc; cx.strokeStyle='rgba(150,170,180,.35)'; cx.beginPath(); cx.moveTo(s[0],s[1]); cx.lineTo(ox+(f[0]-x0)*sc,fy); cx.stroke(); }
        cx.fillStyle=q.weak ? '#ffb74d' : '#7dff9a'; cx.strokeStyle='#000'; cx.lineWidth=1.5; cx.beginPath(); cx.arc(s[0],s[1],4,0,7); cx.stroke(); cx.fill();
        cx.fillStyle=fg; cx.textAlign='left'; cx.fillText(q.name+(Math.abs(q.z)>.005 ? ' ↑'+q.z.toFixed(1) : ''),s[0]+7,s[1]-6);
      });
      // стрелка севера (план привязан по азимуту / GPS)
      if(!d3 && R.georef){ cx.strokeStyle=fg; cx.fillStyle=fg; cx.beginPath(); cx.moveTo(W-18,pad+14); cx.lineTo(W-18,pad-8); cx.stroke(); cx.textAlign='center'; cx.fillText('N',W-18,pad-12); }
      const worst=R.res.filter(r=>r.out).sort((a,b)=>b.nmax-a.nmax).slice(0,3);
      L.push(R.n+' point'+(R.n===1 ? '' : 's')+' · '+R.res.length+' measurement'+(R.res.length===1 ? '' : 's')+(R.dof>0 ? ' · redundancy '+R.dof+' · residuals '+R.rms.toFixed(2)+'σ'+(R.rms>2 ? ' — inconsistent' : R.rms<1.5 ? ' — consistent' : '') : ' · no redundancy: nothing to cross-check (add a diagonal or a second measurement)'));
      for(const w of worst) L.push('⚠ line '+w.li+' '+w.a+(w.b ? '-'+w.b : '')+' '+w.k+': off by '+w.r.map(v=>v.toFixed(3)).join(', ')+' ('+w.nmax.toFixed(1)+'σ) — check it');
      for(const pl of R.polys) L.push('contour '+pl.names.join('-')+': plan '+pl.area.toFixed(2)+' m² · surface '+pl.surf.toFixed(2)+' m² · perimeter '+pl.perimeter.toFixed(2)+' m'+(pl.slope>.05 ? ' · slope '+pl.slope.toFixed(1)+'° ('+pl.slopePct.toFixed(0)+'%)' : ''));
      const wk=pts.filter(q=>q.weak).map(q=>q.name); if(wk.length) L.push('poorly determined (amber): '+wk.join(', ')+' — measure more distances to them');
      const ok=pts.filter(q=>!q.weak && isFinite(q.sx)); if(ok.length){ const m=Math.max(...ok.map(q=>Math.hypot(q.sx,q.sy))); L.push('position error up to ±'+(m<1 ? (m*100).toFixed(1)+' cm' : m.toFixed(1)+' m')+(R.georef ? ' · georeferenced' : ' · local coordinates (for the map: two GPS points or GPS + azimuth)')); }
    } else if(!n.err.length) L.push('no measurements — write them in «measurements» (A-B 12.4 …)');
    n.el.querySelector('.readout').textContent=L.join('\n');
  }});
