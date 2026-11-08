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
  if(n.tblText) t+='\n'+n.tblText;                                         // списки Table
  if(n.extLines) t+='\n'+n.extLines;                                      // вход lines: Photo Measure, Clinometer
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
  (R.opens||[]).forEach((o,i)=>rec.push({id:'sp:'+o.kind+':'+o.a+'-'+o.b+':'+o.from,t,kind:'plan opening',type:o.kind,a:o.a,b:o.b,from:o.from,w:o.w,h:o.h,sill:o.sill}));   // для Plan Editor
  R.polys.forEach((pl,i)=>{
    rec.push({id:'sp:room:'+i,t,kind:'plan poly',names:pl.names.slice(),area_m2:+pl.area.toFixed(2),...(pl.h>0 ? {h:pl.h,volume_m3:+pl.volume.toFixed(2)} : {})});     // для Plan Editor: стены по сторонам контура и комната
    if(!R.georef) return;
    const q=pl.names.map(nm=>R.pts.find(p=>p.name===nm)), path=q.map(p=>[+p.lat.toFixed(8),+p.lon.toFixed(8)]); path.push(path[0]);
    poly.push({id:'sp:poly:'+i,label:pl.area.toFixed(1)+' m²',lat:path[0][0],lon:path[0][1],icon:'dot',color:'#4fc3f7',path,area_m2:+pl.area.toFixed(2),perimeter_m:+pl.perimeter.toFixed(2),slope_deg:+pl.slope.toFixed(1)});
  });
  return {rec,poly};
}
function spRun(n,I){
  const R=spSolve(spText(n),spOpts(n));
  n.res=R; n.emit=spRecords(R); n.err=R.errors; redraw(n);
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

// масштаб вокруг точки (fx, fy) в пикселях холста: вид — сдвиг от центра, поэтому pan' = (1−k)(f−C) + k·pan
function spZoomAt(n,cv,k,fx,fy){
  const z=Math.max(.2,Math.min(40,n.zoom*k)); k=z/n.zoom; n.zoom=z;
  n.panX=(1-k)*(fx-cv.width/2)+k*n.panX; n.panY=(1-k)*(fy-cv.height/2)+k*n.panY;
}
// жесты на холсте: один палец / левая кнопка — поворот (3D) или сдвиг (план), два пальца / колесо — масштаб, правая кнопка / shift — сдвиг, двойной клик — сбросить вид
function spGesture(n,cv){
  if(n._gcv===cv) return; n._gcv=cv;
  const P=new Map(), clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  cv.style.touchAction='none'; cv.style.cursor='grab';
  const pos=ev=>{ const r=cv.getBoundingClientRect(); return [(ev.clientX-r.left)/r.width*cv.width,(ev.clientY-r.top)/r.height*cv.height]; };
  cv.addEventListener('contextmenu',ev=>ev.preventDefault());
  cv.addEventListener('pointerdown',ev=>{ ev.stopPropagation(); cv.setPointerCapture(ev.pointerId); P.set(ev.pointerId,{p:pos(ev),b:ev.button}); });
  const end=ev=>{ P.delete(ev.pointerId); };
  cv.addEventListener('pointerup',end); cv.addEventListener('pointercancel',end);
  cv.addEventListener('pointermove',ev=>{
    const q=P.get(ev.pointerId); if(!q) return; const np=pos(ev), dx=np[0]-q.p[0], dy=np[1]-q.p[1];
    if(P.size===1){
      if(n.p.view!=='3D' || q.b===1 || q.b===2 || ev.shiftKey){ n.panX+=dx; n.panY+=dy; }
      else {
        const az=+(((+n.p.az-dx*.4+180)%360+360)%360-180).toFixed(1), el=+clamp(+n.p.el+dy*.4,0,90).toFixed(1);
        if(n.slowSync){ setMod(n,'az',az); setMod(n,'el',el); }
        else { n.p.az=az; n.p.el=el; if(!n.syncT) n.syncT=setTimeout(()=>{ n.syncT=0; setMod(n,'az',n.p.az); setMod(n,'el',n.p.el); },150); }   // ползунки догоняют раз в 150 мс, а не на каждый пиксель
      }
    } else if(P.size===2){
      const o=[...P.entries()].find(([id])=>id!==ev.pointerId)[1].p, d0=Math.hypot(q.p[0]-o[0],q.p[1]-o[1]), d1=Math.hypot(np[0]-o[0],np[1]-o[1]);
      if(d0>0) spZoomAt(n,cv,d1/d0,(q.p[0]+o[0])/2,(q.p[1]+o[1])/2);                // масштаб вокруг точки между пальцами
      n.panX+=dx/2; n.panY+=dy/2;
    }
    q.p=np; redraw(n);
  });
  cv.addEventListener('wheel',ev=>{ ev.preventDefault(); ev.stopPropagation(); const q=pos(ev); spZoomAt(n,cv,Math.exp(-ev.deltaY*(ev.ctrlKey ? .01 : .0015)),q[0],q[1]); redraw(n); },{passive:false});
  cv.addEventListener('dblclick',ev=>{ ev.stopPropagation(); n.zoom=1; n.panX=0; n.panY=0; redraw(n); });
}

async function spLoadTables(n,tk){                                        // замеры из списков Table (колонки — в spRowToLine)
  const lists=String(n.p.table||'').split(',').map(x=>x.trim()).filter(Boolean), rows=[];
  for(const l of lists) rows.push(...(await gsRead(l).catch(()=>[])));
  if(n.tblKey!==tk) return;
  const text=spRowsToText(rows); if(text!==n.tblText){ n.tblText=text; n.key=''; }
}
async function spSaveTable(n){
  const R=n.res; if(!R || !R.pts.length){ n.msg='nothing to save yet'; return; }
  const t=new Date().toISOString(), rows=R.pts.map(p=>({name:p.name,t,x:+p.x.toFixed(3),y:+p.y.toFixed(3),z:+p.z.toFixed(2),sx:isFinite(p.sx) ? +p.sx.toFixed(4) : '',sy:isFinite(p.sy) ? +p.sy.toFixed(4) : '',sz:isFinite(p.sz) ? +p.sz.toFixed(4) : '',...(R.georef ? {lat:+p.lat.toFixed(8),lon:+p.lon.toFixed(8)} : {})}));
  const list=n.p.save||'analysis/siteplan'; await tblPut(list,Object.keys(rows[0]),rows); n.msg='saved '+rows.length+' points to «'+list+'» (name, x, y, z, sx, sy, sz'+(R.georef ? ', lat, lon' : '')+')'; redraw(n);
}

def({ id:'siteplan', title:'Site Plan', cat:'Geo', touch:true, lazy:true, kw:'plan site survey land plot measure tape gps clinometer height building outdoor indoor area perimeter slope dxf 3d construction fence foundation',
  // rec — записи: строки замеров (kind, a, b, value, sigma — от Measure Entry или Table), GPS-замеры (name, lat, lon, acc, alt), точки (name, x, y, z); lines — замеры текстом с других модулей (Photo Measure, Clinometer), дописываются к списку; lat / lon / acc / alt — позиция (My Position) для кнопки «＋ GPS fix»; rec — GPS-замеры записями (name, lat, lon, acc, alt): складываются в план как «name gps …»;
  // area — площадь первого контура, м²; perim — его периметр, м; slope — уклон, °; rms — невязки в σ (≈1 — замеры согласованы); n — точек; rec — точки, poly — контуры для карты
  ins:[{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'acc',t:'num'},{n:'alt',t:'num'},{n:'rec',t:'rec'},{n:'lines',t:'txt'}],
  outs:[{n:'area',t:'num'},{n:'perim',t:'num'},{n:'slope',t:'num'},{n:'rms',t:'num'},{n:'n',t:'num'},{n:'rec',t:'rec'},{n:'poly',t:'rec'}],
  w:460, view:{h:380}, resize:true, readout:true,
  params:[{n:'plan',t:'code',plain:true,d:SP_DEF,label:'measurements, one per line: A-B 12.4 · A-B h 12.4 · A-B dz 1.2 · A-B az 45 · A-B-C 90 · A-B tilt 25 15 eye 1.6 · A z 120 · A gps lat lon ±3 · A at x y · poly A B C D · room Hall 4.48 3.74 4.46 3.74 (corners Hall1…, 90° unless «side/angle», «side/?» — not measured; d — diagonal 1-3) · wall Hall2-Hall3 Kit1-Kit4 0.4 [shift s] (rooms across a wall) · room … h 2.65 / height 2.7 (ceiling) · window zal1-zal2 1.20 1.40 h 1.45 sill 0.85 / door … (from corner, width) · mirror (flip left ↔ right) (± — error, m or °)',fn:n=>{ n.key=''; }},
          {n:'table',t:'text',d:'',label:'Table lists with measurements, comma-separated. Columns: kind (d h dz az tilt ang poly) + a, b, c + value [+ sigma]; or name + lat, lon [+ acc, alt]; or name + x, y [+ z]; or a ready «line»',fn:n=>{ n.tblKey=''; }},
          {n:'view',t:'select',opts:['plan','3D'],d:'plan',label:'view'},
          {n:'grid',t:'select',opts:['north','structure','off'],d:'north',label:'grid: north (E / N axes of the plan) · structure (along the first side of the contour, from its first point) · off'},
          {n:'coords',t:'check',d:false,label:'label points with their grid coordinates'},
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
          {n:'save',t:'text',d:'analysis/siteplan',label:'Table list for the points'},
          {n:'tosave',t:'button',label:'⬇ Points to the Table list (name, x, y, z, ± error, lat, lon)',fn:n=>spSaveTable(n)},
          {n:'dxf',t:'button',label:'⬇ DXF (3D)',fn:n=>spExport(n,'dxf')},
          {n:'svg',t:'button',label:'⬇ SVG (dimensioned plan)',fn:n=>spExport(n,'svg')},
          {n:'gj',t:'button',label:'⬇ GeoJSON (georeferenced plans)',fn:n=>spExport(n,'gj')},
          {n:'csv',t:'button',label:'⬇ CSV (points ± error)',fn:n=>spExport(n,'csv')},
          {n:'clr',t:'button',label:'Forget GPS fixes from rec',fn:n=>{ n.fixLines.clear(); n.key=''; }}],
  init:n=>{ n.res=null; n.emit=null; n.key=''; n.err=[]; n.msg=''; n.fixLines=new Map(); n.extLines=''; n.tblText=''; n.tblKey=''; n.inLat=null; n.inLon=null; n.inAcc=null; n.inAlt=null; n.zoom=1; n.panX=0; n.panY=0; },
  process(n,I){
    const p=n.p;
    const ext=typeof I.lines==='string' ? I.lines : ''; if(ext!==n.extLines){ n.extLines=ext; n.key=''; }
    n.inLat=recNum(I.lat); n.inLon=recNum(I.lon); n.inAcc=recNum(I.acc); n.inAlt=recNum(I.alt);
    for(const r of recList(I.rec)){                                         // записи: строки замеров (kind a b value…), GPS (name lat lon acc alt), точки (name x y z)
      const line=spRowToLine(r); if(!line || n.fixLines.has(line)) continue;
      if(n.fixLines.size>=500) n.fixLines.delete(n.fixLines.keys().next().value);
      n.fixLines.set(line,line); n.key='';
    }
    const tk=p.table+'|'+(typeof ListDB!=='undefined' ? ListDB.rev : 0);
    if(tk!==n.tblKey){ n.tblKey=tk; spLoadTables(n,tk); }
    const key=[p.plan,p.sd,p.sa,p.sg,p.eye,p.ground,p.sgr,n.fixLines.size,n.tblText.length,typeof Horizon!=='undefined' ? Horizon.ver : 0].join('|');
    let e=null;
    if(key!==n.key){ n.key=key; try{ spRun(n); }catch(err){ n.res=null; n.msg='plan: '+err.message; } e=n.emit; n.emit=null; }
    const R=n.res, pl=R?.polys[0];
    return {area:pl ? pl.area : null, perim:pl ? pl.perimeter : null, slope:pl ? pl.slope : null, rms:R && R.dof>0 ? R.rms : null, n:R ? R.n : null,
      rec:e ? e.rec : null, poly:e ? e.poly : null};
  },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, R=n.res, p=n.p, L=[], pad=26, d3=p.view==='3D';
    cx.fillStyle=themeColor('--screen')||'#0a0d0e'; cx.fillRect(0,0,W,H);
    const fg=themeColor('--scr-txt')||'#9fb0b6';
    spGesture(n,cv);
    if(n.msg) L.push(n.msg);
    for(const e of n.err.slice(0,4)) L.push('line '+e.line+': '+e.msg+' — «'+e.text+'»');
    if(R && R.pts.length){
      const pts=R.pts, A=(+p.az)*Math.PI/180, E=(+p.el)*Math.PI/180, zx=+p.zex;
      const F=spGridFrame(R,p.grid==='structure' ? 'structure' : 'north'), unit=R.georef || F.mode==='structure' ? ['E','N'] : ['x','y'];
      const pr=q=>{ if(!d3) return F.mode==='structure' ? spToFrame(F,q.x,q.y) : [q.x,q.y]; const xr=q.x*Math.cos(A)+q.y*Math.sin(A), yr=-q.x*Math.sin(A)+q.y*Math.cos(A); return [xr,q.z*zx*Math.cos(E)+yr*Math.sin(E)]; };
      const xy=pts.map(pr), zmin=Math.min(...pts.map(q=>q.z));
      let x0=1e99,x1=-1e99,y0=1e99,y1=-1e99; for(const [x,y] of xy){ x0=Math.min(x0,x); x1=Math.max(x1,x); y0=Math.min(y0,y); y1=Math.max(y1,y); }
      const fit=Math.min((W-2*pad)/Math.max(x1-x0,1e-6),(H-2*pad)/Math.max(y1-y0,1e-6)), sc=fit*n.zoom;
      const ox=(W-(x1-x0)*sc)/2+n.panX, oy=(H+(y1-y0)*sc)/2+n.panY;
      const T=(px,py)=>[ox+(px-x0)*sc, oy-(py-y0)*sc], S=i=>T(xy[i][0],xy[i][1]);
      const bad=new Set(); for(const r of R.res) if(r.out && r.b!=='') bad.add([r.a,r.b].sort().join('|'));
      const idx=nm=>pts.findIndex(q=>q.name===nm);
      cx.font='10px monospace'; cx.textBaseline='alphabetic';
      // сетка с координатами: по северу (оси плана) или относительно конструкции (первая сторона контура)
      let gridStep=0;
      if(p.grid!=='off'){
        const G=spGridLines(R,F,60/sc,1); gridStep=G.step;
        const gp=(u,v)=>{ const w=spFromFrame(F,u,v), q=pr({x:w[0],y:w[1],z:d3 ? zmin : 0}); return T(q[0],q[1]); };
        cx.lineWidth=1; cx.strokeStyle='rgba(150,170,180,.22)'; cx.beginPath();
        for(const u of G.u){ const a=gp(u,G.v0), b=gp(u,G.v1); cx.moveTo(a[0],a[1]); cx.lineTo(b[0],b[1]); }
        for(const v of G.v){ const a=gp(G.u0,v), b=gp(G.u1,v); cx.moveTo(a[0],a[1]); cx.lineTo(b[0],b[1]); }
        cx.stroke();
        cx.fillStyle='rgba(150,170,180,.85)'; cx.textAlign='center';
        const lab=v=>Math.abs(v)<1e-9 ? '0' : (+v.toFixed(3))+'';
        // подписи: в плане оси горизонтальны — числа у нижнего и левого края кадра; в 3D — у концов линий, прижатые к кадру
        const cl=(a,x0,x1,y0,y1)=>[Math.max(x0,Math.min(x1,a[0])),Math.max(y0,Math.min(y1,a[1]))];
        for(const u of G.u){ const a=gp(u,G.v0); if(a[0]<8||a[0]>W-8) continue; const c=d3 ? cl(a,8,W-8,12,H-6) : [a[0],H-5]; cx.textAlign='center'; cx.fillText(lab(u),c[0],c[1]); }
        for(const v of G.v){ const a=gp(G.u0,v); if(a[1]<12||a[1]>H-12) continue; const c=d3 ? cl(a,8,W-8,12,H-6) : [4,a[1]+3]; cx.textAlign=d3 ? 'right' : 'left'; cx.fillText(lab(v),c[0],c[1]); }
        // оси: u — по востоку / вдоль конструкции, v — по северу / поперёк; стрелка на конце
        const o=gp(0,0), au=gp(G.step*2,0), av=gp(0,G.step*2);
        cx.strokeStyle='rgba(255,183,77,.8)'; cx.fillStyle='rgba(255,183,77,.95)'; cx.lineWidth=1.5; cx.beginPath(); cx.moveTo(o[0],o[1]); cx.lineTo(au[0],au[1]); cx.moveTo(o[0],o[1]); cx.lineTo(av[0],av[1]); cx.stroke();
        cx.textAlign='left'; cx.fillText(unit[0],au[0]+3,au[1]+3); cx.fillText(unit[1],av[0]+3,av[1]-3);
      }
      for(const pl of R.polys){
        cx.beginPath(); pl.names.forEach((nm,k)=>{ const s=S(idx(nm)); if(k) cx.lineTo(s[0],s[1]); else cx.moveTo(s[0],s[1]); }); cx.closePath();
        cx.fillStyle='rgba(79,195,247,.18)'; cx.fill(); cx.strokeStyle='#4fc3f7'; cx.lineWidth=2; cx.stroke();
        let mx=0,my=0; pl.names.forEach(nm=>{ const s=S(idx(nm)); mx+=s[0]/pl.names.length; my+=s[1]/pl.names.length; });
        cx.fillStyle=fg; cx.textAlign='center'; cx.fillText(pl.area.toFixed(1)+' m²',mx,my);
      }
      for(const o of R.opens||[]){                                     // проёмы: окно — голубым, дверь — коричневым, поверх стены
        const sa=S(idx(o.a)), sb=S(idx(o.b)), f0=o.from/o.L, f1=(o.from+o.w)/o.L;
        cx.strokeStyle=o.kind==='door' ? '#c9a06a' : '#6fd0ff'; cx.lineWidth=5; cx.beginPath(); cx.moveTo(sa[0]+(sb[0]-sa[0])*f0,sa[1]+(sb[1]-sa[1])*f0); cx.lineTo(sa[0]+(sb[0]-sa[0])*f1,sa[1]+(sb[1]-sa[1])*f1); cx.stroke();
      }
      for(const [a,b] of R.edges){
        const sa=S(a), sb=S(b), isBad=bad.has([pts[a].name,pts[b].name].sort().join('|'));
        cx.strokeStyle=isBad ? '#ff5c5c' : 'rgba(150,170,180,.7)'; cx.lineWidth=isBad ? 2 : 1; cx.setLineDash(isBad ? [] : [3,3]);
        cx.beginPath(); cx.moveTo(sa[0],sa[1]); cx.lineTo(sb[0],sb[1]); cx.stroke(); cx.setLineDash([]);
        if(!d3){ const d=Math.hypot(pts[b].x-pts[a].x,pts[b].y-pts[a].y,pts[b].z-pts[a].z); cx.fillStyle=isBad ? '#ff9a9a' : '#6c7a80'; cx.textAlign='center'; cx.fillText(d.toFixed(2),(sa[0]+sb[0])/2,(sa[1]+sb[1])/2-3); }
      }
      pts.forEach((q,i)=>{
        const s=S(i);
        if(d3 && q.z>zmin+1e-6){ const f=T(...pr({x:q.x,y:q.y,z:zmin})); cx.strokeStyle='rgba(150,170,180,.35)'; cx.beginPath(); cx.moveTo(s[0],s[1]); cx.lineTo(f[0],f[1]); cx.stroke(); }
        cx.fillStyle=q.weak ? '#ffb74d' : '#7dff9a'; cx.strokeStyle='#000'; cx.lineWidth=1.5; cx.beginPath(); cx.arc(s[0],s[1],4,0,7); cx.stroke(); cx.fill();
        let t=q.name+(Math.abs(q.z)>.005 ? ' ↑'+q.z.toFixed(1) : '');
        if(p.coords){ const c=spToFrame(F,q.x,q.y); t=q.name+' ('+c[0].toFixed(2)+', '+c[1].toFixed(2)+(Math.abs(q.z)>.005 ? ', ↑'+q.z.toFixed(2) : '')+')'; }
        cx.fillStyle=fg; cx.textAlign='left'; cx.fillText(t,s[0]+7,s[1]-6);
      });
      // стрелка севера в углу — в плане и в 3D (по повороту); только если план привязан к сторонам света
      if(R.georef){ const c=[W-22,pad+8], v=d3 ? [Math.sin(A),-Math.cos(A)*Math.sin(E)] : F.mode==='structure' ? [F.uy,-F.vy] : [0,-1], l=Math.hypot(v[0],v[1])||1;
        cx.strokeStyle=fg; cx.fillStyle=fg; cx.lineWidth=1.5; cx.beginPath(); cx.moveTo(c[0]-v[0]/l*14,c[1]-v[1]/l*14); cx.lineTo(c[0]+v[0]/l*14,c[1]+v[1]/l*14); cx.stroke();
        cx.textAlign='center'; cx.fillText('N',c[0]+v[0]/l*23,c[1]+v[1]/l*23+3); }
      const worst=R.res.filter(r=>r.out).sort((a,b)=>b.nmax-a.nmax).slice(0,3);
      L.push(R.n+' point'+(R.n===1 ? '' : 's')+' · '+R.res.length+' measurement'+(R.res.length===1 ? '' : 's')+(R.dof>0 ? ' · redundancy '+R.dof+' · residuals '+R.rms.toFixed(2)+'σ'+(R.rms>2 ? ' — inconsistent' : R.rms<1.5 ? ' — consistent' : '') : ' · no redundancy: nothing to cross-check (add a diagonal or a second measurement)'));
      if(gridStep) L.push('grid '+gridStep+' m · '+(F.mode==='structure' ? 'axes along the first side of the contour, origin at its first point' : R.georef ? 'north-aligned (E, N from the local origin)' : 'plan axes x, y from the origin (no north: the plan is not georeferenced)'));
      for(const w of worst) L.push('⚠ line '+w.li+' '+w.a+(w.b ? '-'+w.b : '')+' '+w.k+': off by '+w.r.map(v=>v.toFixed(3)).join(', ')+' ('+w.nmax.toFixed(1)+'σ) — check it');
      for(const o of R.opens||[]) L.push(o.kind+' '+o.a+'-'+o.b+': '+o.from.toFixed(2)+'…'+(o.from+o.w).toFixed(2)+' m of '+o.L.toFixed(2)+' · '+o.w+'×'+o.h+' m'+(o.sill>0 ? ' · sill '+o.sill+' m' : ''));
      if(R.mirror) L.push('mirrored left ↔ right («mirror» line)');
      else if(R.polys.length && !R.georef) L.push('kitchen on the wrong side? a tape and angles cannot tell a plan from its mirror image — add a line «mirror»');
      for(const pl of R.polys) L.push('contour '+pl.names.join('-')+': plan '+pl.area.toFixed(2)+' m²'+(pl.h>0 ? ' · ceiling '+pl.h+' m · volume '+pl.volume.toFixed(1)+' m³' : '')+' · surface '+pl.surf.toFixed(2)+' m² · perimeter '+pl.perimeter.toFixed(2)+' m'+(pl.slope>.05 ? ' · slope '+pl.slope.toFixed(1)+'° ('+pl.slopePct.toFixed(0)+'%)' : ''));
      const wk=pts.filter(q=>q.weak).map(q=>q.name);
      if(wk.length){ const hint=[], has=new Set(R.edges.map(([a,b])=>R.names[a]+'-'+R.names[b]).concat(R.edges.map(([a,b])=>R.names[b]+'-'+R.names[a])));
        for(const w of wk) for(const pl of R.polys){ const m=pl.names.length, i=pl.names.indexOf(w); if(i<0) continue; const pv=pl.names[(i+m-1)%m], nx=pl.names[(i+1)%m];
          for(const q of [nx,pv]) if(!has.has(w+'-'+q)){ hint.push(w+'-'+q+' (length)'); break; } hint.push(pv+'-'+w+'-'+nx+' (angle)'); break; }
        L.push('poorly determined (amber): '+wk.join(', ')+' — '+(hint.length ? 'add e.g. '+[...new Set(hint)].join(' or ') : 'measure more distances to them')); }
      const ok=pts.filter(q=>!q.weak && isFinite(q.sx)); if(ok.length){ const m=Math.max(...ok.map(q=>Math.hypot(q.sx,q.sy))); L.push('position error up to ±'+(m<1 ? (m*100).toFixed(1)+' cm' : m.toFixed(1)+' m')+(R.georef ? ' · georeferenced' : ' · local coordinates (for the map: two GPS points or GPS + azimuth)')); }
      L.push(d3 ? 'drag — turn · two fingers / wheel — zoom · right drag or shift+drag — move · double click — reset view' : 'drag — move · two fingers / wheel — zoom · double click — reset view');
    } else if(!n.err.length) L.push('no measurements — write them in «measurements» (A-B 12.4 …)');
    n.el.querySelector('.readout').textContent=L.join('\n');
  }});
