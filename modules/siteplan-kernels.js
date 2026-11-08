"use strict";
/* ============================ Site Plan: ядро ============================
   План участка / постройки по измерениям. Точки (x — восток, y — север, z — вверх, м) и измерения с погрешностями; решатель — уравнивание
   методом наименьших квадратов (Левенберг — Марквардт, веса 1/σ²): рулетка, GPS и компас не спорят, а складываются по весу.
   Текст измерений, по строке на каждое (имена точек — любые слова без пробелов и «-»; запятая в числах допустима; # — комментарий):
     A-B 12.40 [±0.02]        расстояние по линии (рулетка по склону)
     A-B h 12.40              расстояние по горизонтали
     A-B dz 1.20              B выше A на 1.20
     A-B az 45                азимут A→B (компас, ° от севера)
     A-B-C 90                 угол в точке B между BA и BC, °
     A-B tilt 25 15 [eye 1.6] клинометр: из A под углом 25° на B, горизонтальное расстояние 15 (высота = eye + 15·tg25°)
     A z 120.5                высота A, м
     A gps 55.03 82.92 [±3] [alt 120]   GPS-замер (несколько — усредняются по весу)
     A at 10 5                координаты A в локальной системе, м
     poly A B C D             контур — площадь и периметр
     room Hall … h 2.65 · poly … h 2.65 · height 2.7   высота потолка комнаты / по умолчанию для всех (уходит в высоту стен Plan Editor, объём)
     window A-B 1.20 1.40 [h 1.45] [sill 0.85]   окно в стене A-B: от угла A до ближнего края 1.20, ширина 1.40, высота, подоконник от пола (door — дверь, h 2.05, sill 0)
     mirror                   отразить план слева направо (по рулетке и углам план не отличить от зеркального; с компасом / GPS не нужно)
     wall Hall2-Hall3 Kor4-Kor1 0.37 [shift 0]   стык через стену: Kor4-Kor1 параллельно Hall2-Hall3 по ту сторону стены 0.37, Kor4 напротив Hall2 (shift — сдвиг вдоль), Kor1 — в сторону Hall3
     room Hall 4.48 3.74 4.46 3.74 [d 5.8]   комната обходом: стороны по порядку, углы Hall1…Hall4 по 90° («3.74/95» — свой угол, «/?» — не замерен), d — диагональ 1–3
   Ядро чистое, без DOM: node tools/test-siteplan.mjs */

const SP_D=Math.PI/180, SP_R=6371008.8;

function spFrame(lat0,lon0){
  const ky=SP_R*SP_D, kx=ky*Math.cos(lat0*SP_D);
  return {fwd:(la,lo)=>[(lo-lon0)*kx,(la-lat0)*ky], inv:(x,y)=>[lat0+y/ky,lon0+x/kx]};
}
const spWrap=a=>{ a=((a+180)%360+360)%360-180; return a; };

// клинометр: стоя на расстоянии d (по горизонтали), угол α вверх, высота глаза eye → превышение и его погрешность
function spTilt(d,alphaDeg,eye=0,sd=0.03,sa=1){
  const a=alphaDeg*SP_D, dz=eye+d*Math.tan(a);
  return {dz, s:Math.hypot(Math.tan(a)*sd, d/Math.cos(a)**2*sa*SP_D, 0.02)};
}

// ---------- разбор ----------
function spNum(t){ if(t==null) return NaN; const s=String(t).replace(/^[±~]|^\+-/,'').replace(/(\d),(\d)/,'$1.$2'); return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? +s : NaN; }
function spParse(text,o={}){
  const sd=o.sd>0 ? o.sd : 0.03, sa=o.sa>0 ? o.sa : 2, sg=o.sg>0 ? o.sg : 5, eye0=o.eye||0;
  const names=[], idx=new Map(), obs=[], polys=[], errors=[], opens=[]; let mirror=false, height=NaN;
  const pt=n=>{ if(!idx.has(n)){ idx.set(n,names.length); names.push(n); } return idx.get(n); };
  const one=(raw,li,depth=0)=>{
    const line=raw.trim(); if(!line) return;
    const T=line.replace(/(\d),(\d)/g,'$1.$2').replace(/(±|\+-|~)\s*/g,' ± ').split(/\s+/).filter(Boolean);
    const bad=m=>errors.push({line:li+1,text:line,msg:m});
    // «± σ» в любом месте: вынимаем
    let sig=null; for(let i=0;i<T.length;i++) if(T[i]==='±'){ sig=spNum(T[i+1]); T.splice(i,2); break; }
    if(sig!=null && !(sig>0)){ bad('bad ±'); return; }
    let eye=null; { const i=T.indexOf('eye'); if(i>=0){ eye=spNum(T[i+1]); T.splice(i,2); if(!isFinite(eye)){ bad('bad eye'); return; } } }
    let alt=null; { const i=T.indexOf('alt'); if(i>=0){ alt=spNum(T[i+1]); T.splice(i,2); if(!isFinite(alt)){ bad('bad alt'); return; } } }
    if(/^room$/i.test(T[0])){ if(depth) return bad('room inside room'); const L=spRoomLines(T.slice(1)); if(typeof L==='string') return bad(L); L.forEach(l=>one(l,li,1)); return; }
    if(/^mirror$/i.test(T[0])){ mirror=!mirror; return; }                                   // зеркало: длины и углы его не различают
    if(/^wall$/i.test(T[0])){                                                                // стык комнат через стену: «wall A-B C-D 0.37 [shift s]»
      const h1=(T[1]||'').split('-'), h2=(T[2]||'').split('-'), t=spNum(T[3]); let sh=0;
      { const i=T.indexOf('shift'); if(i>=0){ sh=spNum(T[i+1]); if(!isFinite(sh)) return bad('bad shift'); } }
      if(h1.length!==2 || h2.length!==2 || !(t>=0)) return bad('wall A-B C-D thickness [shift s] — C-D faces A-B across the wall, C opposite A');
      const a=pt(h1[0]), b=pt(h1[1]), c=pt(h2[0]), e=pt(h2[1]); if(a===b || c===e) return bad('same point');
      const s=sig??sd; obs.push({k:'wd',a,b,c,v:t,s,li},{k:'wd',a,b,c:e,v:t,s,li},{k:'wsh',a,b,c,v:sh,s,li,wall:{e}}); return; }
    if(/^(window|door)$/i.test(T[0])){                                                       // проём: «window A-B от_угла_A ширина [h высота] [sill подоконник]»
      const kind=T[0].toLowerCase(), hd=(T[1]||'').split('-'), from=spNum(T[2]), w=spNum(T[3]), o={kind,from,w,h:kind==='door' ? 2.05 : 1.2,sill:kind==='door' ? 0 : .9,li};
      if(hd.length!==2 || !(from>=0) || !(w>0)) return bad(kind+' A-B from width [h height] [sill height] — from: corner A to the near edge, m');
      for(let i=4;i<T.length;i+=2){ const k=T[i].toLowerCase(), v=spNum(T[i+1]); if((k!=='h' && k!=='sill') || !(v>=0) || (k==='h' && !(v>0))) return bad(kind+': unknown «'+T[i]+'» (h height, sill height)'); o[k]=v; }
      o.a=pt(hd[0]); o.b=pt(hd[1]); if(o.a===o.b) return bad('same point'); opens.push(o); return; }
    if(/^height$/i.test(T[0])){ const v=spNum(T[1]); if(!(v>0)) return bad('height needs a number, m'); height=v; return; }     // высота потолка по умолчанию для всех комнат
    if(/^poly$/i.test(T[0])){ let h=NaN; { const i=T.findIndex((t,k)=>k>0 && /^h$/i.test(t)); if(i>0){ h=spNum(T[i+1]); if(!(h>0)) return bad('poly … h needs a height, m'); T.splice(i,2); } }
      const ids=T.slice(1).map(pt); if(ids.length<3){ bad('poly needs 3+ points'); return; } polys.push({ids,h}); return; }
    const head=T[0].split('-'), kw=(T[1]||'').toLowerCase(), v=spNum(T[1]);
    if(head.length===1){                                                                    // одна точка
      const a=pt(head[0]);
      if(kw==='z'){ const z=spNum(T[2]); if(!isFinite(z)) return bad('z needs a number'); obs.push({k:'z',a,v:z,s:sig??0.1,li}); }
      else if(kw==='gps'){ const la=spNum(T[2]), lo=spNum(T[3]); if(!isFinite(la)||!isFinite(lo)||Math.abs(la)>90||Math.abs(lo)>180) return bad('gps needs lat lon');
        obs.push({k:'gps',a,lat:la,lon:lo,s:sig??sg,li}); if(alt!=null) obs.push({k:'z',a,v:alt,s:Math.max(3,(sig??sg)*2),li,fromGps:true}); }
      else if(kw==='at'){ const x=spNum(T[2]), y=spNum(T[3]); if(!isFinite(x)||!isFinite(y)) return bad('at needs x y'); obs.push({k:'at',a,x,y,s:sig??0.01,li}); }
      else bad('unknown: '+line);
      return;
    }
    if(head.length===2){                                                                    // отрезок
      const a=pt(head[0]), b=pt(head[1]); if(a===b) return bad('same point');
      if(isFinite(v)) obs.push({k:'d',a,b,v,s:sig??sd,li});
      else if(kw==='h'){ const d=spNum(T[2]); if(!isFinite(d)) return bad('h needs a number'); obs.push({k:'h',a,b,v:d,s:sig??sd,li}); }
      else if(kw==='dz'){ const d=spNum(T[2]); if(!isFinite(d)) return bad('dz needs a number'); obs.push({k:'dz',a,b,v:d,s:sig??sd,li}); }
      else if(kw==='az'){ const d=spNum(T[2]); if(!isFinite(d)) return bad('az needs a number'); obs.push({k:'az',a,b,v:d,s:sig??sa,li}); }
      else if(kw==='tilt'){ const al=spNum(T[2]), d=spNum(T[3]); if(!isFinite(al)||!isFinite(d)||!(d>0)) return bad('tilt needs angle and horizontal distance');
        const q=spTilt(d,al,eye??eye0,sd,sa); obs.push({k:'h',a,b,v:d,s:sig??sd,li},{k:'dz',a,b,v:q.dz,s:q.s,li}); }
      else bad('unknown: '+line);
      return;
    }
    if(head.length===3 && isFinite(v)){ obs.push({k:'ang',a:pt(head[0]),b:pt(head[1]),c:pt(head[2]),v,s:sig??sa,li}); return; }
    bad('unknown: '+line);
  };
  String(text||'').split('\n').forEach((raw0,li)=>raw0.replace(/#.*/,'').split(';').forEach(raw=>one(raw,li)));   // # — комментарий до конца строки; «;» — несколько замеров в строке
  { const seen=new Map(); for(const n of names){ const k=n.toLowerCase(); if(seen.has(k) && seen.get(k)!==n) errors.push({line:0,text:n,msg:'«'+seen.get(k)+'» and «'+n+'» are different points — names are case-sensitive'}); else seen.set(k,n); } }
  for(const pl of polys) if(!(pl.h>0) && height>0) pl.h=height;
  return {names,obs,polys,errors,mirror,opens};
}

// «room ИМЯ 4.48 3.74 4.46 3.74 [d 5.8] [d2 5.9]» — комната обходом по периметру: стороны по порядку, углы ИМЯ1, ИМЯ2… расставляются сами.
// Каждый угол — 90°, если не указан свой: «3.74/95» — угол 95° в конце этой стороны, «3.74/?» — угол не замерен (тогда нужна диагональ).
// d — диагональ ИМЯ1–ИМЯ3, d2 — ИМЯ2–ИМЯ4. → обычные строки (стороны, углы, диагонали, poly) или текст ошибки
function spRoomLines(T){
  if(!T.length || isFinite(spNum(T[0]))) return 'room NAME side side side … (e.g. room Hall 4.48 3.74 4.46 3.74)';
  const nm=T[0], S=[], A=[], D=[]; let H=NaN;
  for(let i=1;i<T.length;i++){
    const t=T[i].toLowerCase();
    if(t==='h'){ const v=spNum(T[++i]); if(!(v>0)) return 'room: h needs a ceiling height'; H=v; continue; }
    if(t==='d'||t==='d2'){ const v=spNum(T[++i]); if(!(v>0)) return 'room: '+t+' needs a length'; D.push([t,v]); continue; }
    const [a,b]=T[i].split('/'), v=spNum(a); if(!(v>0)) return 'room: bad side «'+T[i]+'»';
    const g=b===undefined ? 90 : b==='?' ? null : spNum(b); if(g!==null && !(g>0 && g<360)) return 'room: bad corner angle «'+T[i]+'»';
    S.push(v); A.push(g);
  }
  const n=S.length; if(n<3) return 'room needs 3+ sides';
  const P=i=>nm+(((i%n)+n)%n+1), L=[];
  for(let i=0;i<n;i++) L.push(P(i)+'-'+P(i+1)+' '+S[i]);
  for(let i=0;i<n;i++) if(A[i]!==null) L.push(P(i)+'-'+P(i+1)+'-'+P(i+2)+' '+A[i]);       // угол в конце стороны i
  for(const [t,v] of D){ if(n<4) return 'room: a diagonal needs 4+ sides'; L.push(t==='d' ? P(0)+'-'+P(2)+' '+v : P(1)+'-'+P(3)+' '+v); }
  L.push('poly '+[...Array(n).keys()].map(P).join(' ')+(H>0 ? ' h '+H : ''));
  return L;
}

// ---------- начальное приближение ----------
function spInit(P){
  const N=P.names.length, X=new Float64Array(3*N), placed=new Array(N).fill(false), obs=P.obs;
  // опорные точки: at / gps
  const frame=spGpsFrame(obs);
  for(const o of obs){
    if(o.k==='at'){ X[3*o.a]=o.x; X[3*o.a+1]=o.y; placed[o.a]=true; }
    else if(o.k==='gps' && frame){ const q=frame.fwd(o.lat,o.lon); X[3*o.a]=q[0]; X[3*o.a+1]=q[1]; placed[o.a]=true; }
  }
  const zk=new Array(N).fill(false);
  for(const o of obs) if(o.k==='z'){ X[3*o.a+2]=o.v; zk[o.a]=true; }
  const hd=(o,dzv)=>o.k==='h' ? o.v : Math.sqrt(Math.max(o.v*o.v-dzv*dzv,0));
  const dzOf=(a,b)=>{ for(const o of obs) if(o.k==='dz'){ if(o.a===a&&o.b===b) return o.v; if(o.a===b&&o.b===a) return -o.v; } return 0; };
  let seeds=0;
  // замеры дают фигуру с точностью до зеркала (D по двум расстояниям — по обе стороны диагонали AC); выбор стороны — по контурам «poly»:
  // кандидат, при котором контур не перекручен (стороны не пересекаются) и не вывернут (повороты в одну сторону), лучше
  const segX=(p1,p2,p3,p4)=>{ const d=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]), e=1e-9;
    const d1=d(p3,p4,p1), d2=d(p3,p4,p2), d3=d(p1,p2,p3), d4=d(p1,p2,p4); return ((d1>e&&d2<-e)||(d1<-e&&d2>e)) && ((d3>e&&d4<-e)||(d3<-e&&d4>e)); };
  const polyPen=(p,x,y)=>{
    let pen=0; const at=i=>i===p ? [x,y] : placed[i] ? [X[3*i],X[3*i+1]] : null;
    for(const pl of P.polys){
      const ids=pl.ids, m=ids.length; if(!ids.includes(p)) continue;
      const E=[]; for(let i=0;i<m;i++){ const a=at(ids[i]), b=at(ids[(i+1)%m]); if(a&&b) E.push([a,b,i]); }
      for(let i=0;i<E.length;i++) for(let j=i+1;j<E.length;j++){ const di=Math.abs(E[i][2]-E[j][2]); if(di===1||di===m-1) continue; if(segX(E[i][0],E[i][1],E[j][0],E[j][1])) pen+=10; }
      let pos=0, neg=0; for(let i=0;i<m;i++){ const a=at(ids[(i+m-1)%m]), b=at(ids[i]), c=at(ids[(i+1)%m]); if(!a||!b||!c) continue;
        const z=(b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]); if(z>1e-9) pos++; else if(z<-1e-9) neg++; }
      pen+=Math.min(pos,neg);
    }
    // комнаты не налезают друг на друга: точка внутри чужого контура или сторона, пересекающая его сторону
    for(const pl of P.polys){
      if(pl.ids.includes(p)) continue; const Q=pl.ids.map(at); if(Q.some(q=>!q)) continue;
      let ins=false; for(let i=0,j=Q.length-1;i<Q.length;j=i++) if((Q[i][1]>y)!==(Q[j][1]>y) && x<(Q[j][0]-Q[i][0])*(y-Q[i][1])/(Q[j][1]-Q[i][1])+Q[i][0]) ins=!ins;
      if(ins) pen+=10;
      for(const own of P.polys){ const m=own.ids.length; if(!own.ids.includes(p)) continue;      // взгляд вперёд: недостающие углы — достройкой параллелограмма, центр комнаты не должен попасть в чужую
        const V=own.ids.map(at); for(let it=0;it<2*m;it++) for(let i=0;i<m;i++){ if(V[i]) continue; const a1=V[(i+m-1)%m], a2=V[(i+m-2)%m], a3=V[(i+m-3)%m]; if(a1&&a2&&a3) V[i]=[a1[0]+a3[0]-a2[0],a1[1]+a3[1]-a2[1]]; }
        if(V.some(v=>!v)) continue; const gx=V.reduce((t,v)=>t+v[0],0)/m, gy=V.reduce((t,v)=>t+v[1],0)/m;
        let gin=false; for(let i=0,j=Q.length-1;i<Q.length;j=i++) if((Q[i][1]>gy)!==(Q[j][1]>gy) && gx<(Q[j][0]-Q[i][0])*(gy-Q[i][1])/(Q[j][1]-Q[i][1])+Q[i][0]) gin=!gin;
        if(gin) pen+=5; }
      for(const own of P.polys){ const m=own.ids.length, k=own.ids.indexOf(p); if(k<0) continue;
        for(const j of [own.ids[(k+1)%m],own.ids[(k+m-1)%m]]){ const o=at(j); if(!o || pl.ids.includes(j)) continue;
          for(let i=0;i<Q.length;i++) if(segX([x,y],o,Q[i],Q[(i+1)%Q.length])) pen+=5; } }
    }
    return pen;
  };
  const inPoly=p=>P.polys.some(pl=>pl.ids.includes(p));
  const pick=(p,C)=>{ let best=C[0], bp=Infinity; for(const c of C){ const v=polyPen(p,c[0],c[1])+(c[2]||0); if(v<bp-1e-9){ bp=v; best=c; } } return best; };
  const stepOnce=()=>{
    let moved=false;
    for(const o of obs){                                         // стена: C-D — параллельно A-B по ту сторону, C напротив A (+сдвиг), D в сторону B
      if(o.k!=='wsh' || !placed[o.a] || !placed[o.b] || (placed[o.c] && placed[o.wall.e])) continue;
      const ax=X[3*o.a], ay=X[3*o.a+1], L=Math.hypot(X[3*o.b]-ax,X[3*o.b+1]-ay)||1, ux=(X[3*o.b]-ax)/L, uy=(X[3*o.b+1]-ay)/L;
      const t=(obs.find(q=>q.k==='wd' && q.a===o.a && q.c===o.c)||{v:0}).v;
      let nx=-uy, ny=ux;                                          // наружу — от центра комнаты, где стоит A-B
      const room=P.polys.find(pl=>pl.ids.includes(o.a) && pl.ids.includes(o.b));
      if(room){ let cx=0, cy=0, k=0; for(const i of room.ids) if(placed[i]){ cx+=X[3*i]; cy+=X[3*i+1]; k++; } if(k>=3 && (cx/k-ax)*nx+(cy/k-ay)*ny>0){ nx=-nx; ny=-ny; } }
      const cX=ax+ux*o.v+nx*t, cY=ay+uy*o.v+ny*t, e=o.wall.e;
      let r=NaN; for(const q of obs) if((q.k==='d'||q.k==='h') && ((q.a===o.c&&q.b===e)||(q.a===e&&q.b===o.c))){ r=q.v; break; }
      if(!isFinite(r)) r=L;
      if(!placed[o.c]){ X[3*o.c]=cX; X[3*o.c+1]=cY; X[3*o.c+2]=X[3*o.a+2]; placed[o.c]=true; moved=true; }
      if(!placed[e]){ X[3*e]=X[3*o.c]+ux*r; X[3*e+1]=X[3*o.c+1]+uy*r; X[3*e+2]=X[3*o.c+2]; placed[e]=true; moved=true; }
    }
    for(let p=0;p<N;p++){
      if(placed[p]) continue;
      const nb=[];                                                  // {q, r, az}
      for(const o of obs){
        if(o.k!=='d' && o.k!=='h' && o.k!=='az') continue;
        let q=-1, fwd=true; if(o.a===p) { q=o.b; fwd=false; } else if(o.b===p) q=o.a; else continue;
        if(!placed[q]) continue;
        const e=nb.find(x=>x.q===q) || (nb.push({q,r:NaN,az:NaN}), nb[nb.length-1]);
        if(o.k==='az') e.az=fwd ? o.v : o.v+180;
        else e.r=hd(o,dzOf(q,p));
      }
      if(!nb.length) continue;
      const withR=nb.filter(e=>isFinite(e.r));
      let x,y;
      if(withR.length>=2){
        const A=withR[0], B=withR[1], ax=X[3*A.q], ay=X[3*A.q+1], bx=X[3*B.q], by=X[3*B.q+1], dx=bx-ax, dy=by-ay, L=Math.hypot(dx,dy)||1e-9;
        let s=(A.r*A.r-B.r*B.r+L*L)/(2*L), h2=A.r*A.r-s*s, h=h2>0 ? Math.sqrt(h2) : 0;
        x=ax+s*dx/L-h*dy/L; y=ay+s*dy/L+h*dx/L;
        const w=nb.find(e=>isFinite(e.az));                          // азимут с уже стоящей точки выбирает сторону (зеркало треугольника)
        const x2=ax+s*dx/L+h*dy/L, y2=ay+s*dy/L-h*dx/L;
        if(w){
          const gap=(px,py)=>Math.abs(spWrap(Math.atan2(px-X[3*w.q],py-X[3*w.q+1])/SP_D-w.az));
          if(gap(x2,y2)<gap(x,y)){ x=x2; y=y2; }
        } else if(h>0 && inPoly(p)) [x,y]=pick(p,[[x,y],[x2,y2]]);
      } else if(nb[0].az!==undefined && isFinite(nb[0].az) && isFinite(nb[0].r)){
        const e=nb[0], a=e.az*SP_D; x=X[3*e.q]+e.r*Math.sin(a); y=X[3*e.q+1]+e.r*Math.cos(a);
      } else if(withR.length===1){
        const e=withR[0], qx=X[3*e.q], qy=X[3*e.q+1], C=[];
        // угол q-…: «o-q-p v» с уже стоящей o — направление q→p = направление q→o, повёрнутое на ±v
        for(const o of obs){ if(o.k!=='ang' || o.b!==e.q) continue; const t=o.a===p ? o.c : o.c===p ? o.a : -1; if(t<0 || !placed[t]) continue;
          const a0=Math.atan2(X[3*t+1]-qy,X[3*t]-qx); for(const sg of [1,-1]){ const a=a0+sg*o.v*SP_D; C.push([qx+e.r*Math.cos(a),qy+e.r*Math.sin(a)]); } }
        if(!C.length && inPoly(p)){                                   // одно расстояние, но точка в контуре: перебор направлений, при равенстве — прямой угол в q (комнаты обычно прямоугольны)
          const nb=[]; for(const pl of P.polys){ const m=pl.ids.length; for(let i=0;i<m;i++) if(pl.ids[i]===e.q){ for(const j of [pl.ids[(i+1)%m],pl.ids[(i+m-1)%m]]) if(j!==p && placed[j]) nb.push(j); } }
          for(let k=0;k<72;k++){ const a=k*5*SP_D, cx=qx+e.r*Math.cos(a), cy=qy+e.r*Math.sin(a); let dev=0;
            for(const j of nb){ const ux=X[3*j]-qx, uy=X[3*j+1]-qy, cs=(ux*(cx-qx)+uy*(cy-qy))/(Math.hypot(ux,uy)*e.r||1); dev+=Math.abs(cs); }
            C.push([cx,cy,dev*0.5]); }
        }
        if(C.length) [x,y]=pick(p,C);
        else { const a=(placedCount()-1)*2.4; x=qx+e.r*Math.cos(a); y=qy+e.r*Math.sin(a); }
      } else continue;
      X[3*p]=x; X[3*p+1]=y; placed[p]=true; moved=true;
      if(!zk[p]){ for(const e of nb){ const dz=dzOf(e.q,p); if(dz){ X[3*p+2]=X[3*e.q+2]+dz; break; } else X[3*p+2]=X[3*e.q+2]; } }
    }
    return moved;
  };
  const placedCount=()=>placed.filter(Boolean).length;
  for(;;){
    while(stepOnce());
    const rest=placed.indexOf(false); if(rest<0) break;
    X[3*rest]=10*(++seeds); X[3*rest+1]=-10*seeds; placed[rest]=true;     // несвязная часть — отдельным островком
  }
  return {X,frame};
}
function spGpsFrame(obs){
  const g=obs.filter(o=>o.k==='gps'); if(!g.length) return null;
  let la=0,lo=0; for(const o of g){ la+=o.lat; lo+=o.lon; }
  return spFrame(la/g.length,lo/g.length);
}

// ---------- невязки ----------
function spResid(o,X,frame,gz){                       // → нормированная невязка (измерено − модель)/σ, но возвращаем (модель − измерено)/σ
  const ax=X[3*o.a], ay=X[3*o.a+1], az=X[3*o.a+2];
  switch(o.k){
    case 'd': { const bx=X[3*o.b], by=X[3*o.b+1], bz=X[3*o.b+2]; return [(Math.hypot(bx-ax,by-ay,bz-az)-o.v)/o.s]; }
    case 'h': { const bx=X[3*o.b], by=X[3*o.b+1]; return [(Math.hypot(bx-ax,by-ay)-o.v)/o.s]; }
    case 'dz': return [(X[3*o.b+2]-az-o.v)/o.s];
    case 'z': return [(az-o.v)/o.s];
    case 'at': return [(ax-o.x)/o.s,(ay-o.y)/o.s];
    case 'gps': { const q=frame.fwd(o.lat,o.lon); return [(ax-q[0])/o.s,(ay-q[1])/o.s]; }
    case 'az': { const bx=X[3*o.b], by=X[3*o.b+1]; return [spWrap(Math.atan2(bx-ax,by-ay)/SP_D-o.v)/o.s]; }
    case 'ang': { const b=o.b, ux=ax-X[3*b], uy=ay-X[3*b+1], uz=az-X[3*b+2], vx=X[3*o.c]-X[3*b], vy=X[3*o.c+1]-X[3*b+1], vz=X[3*o.c+2]-X[3*b+2];
      const c=(ux*vx+uy*vy+uz*vz)/(Math.hypot(ux,uy,uz)*Math.hypot(vx,vy,vz)||1e-12); return [(Math.acos(Math.max(-1,Math.min(1,c)))/SP_D-o.v)/o.s]; }
    case 'fix': return [(X[o.i]-o.v)/o.s];
    case 'wd': case 'wsh': { const bx=X[3*o.b]-ax, by=X[3*o.b+1]-ay, L=Math.hypot(bx,by)||1e-9, cx=X[3*o.c]-ax, cy=X[3*o.c+1]-ay;   // расстояние от C до прямой AB / сдвиг вдоль неё
      return [o.k==='wd' ? (Math.abs(bx*cy-by*cx)/L-o.v)/o.s : ((bx*cx+by*cy)/L-o.v)/o.s]; }
  }
  return [];
}
const spInvolved=o=>{ const r=[]; for(const k of ['a','b','c']) if(o[k]!==undefined) r.push(o[k]); return o.k==='fix' ? [Math.floor(o.i/3)] : r; };

// решение симметричной системы A·x=b (A — n×n, портится); Гаусс с выбором главного элемента
function spSolveLin(A,b,n){
  for(let i=0;i<n;i++){
    let m=i; for(let r=i+1;r<n;r++) if(Math.abs(A[r*n+i])>Math.abs(A[m*n+i])) m=r;
    if(Math.abs(A[m*n+i])<1e-300) return null;
    if(m!==i){ for(let c=0;c<n;c++){ const t=A[i*n+c]; A[i*n+c]=A[m*n+c]; A[m*n+c]=t; } const t=b[i]; b[i]=b[m]; b[m]=t; }
    for(let r=i+1;r<n;r++){ const f=A[r*n+i]/A[i*n+i]; if(!f) continue; for(let c=i;c<n;c++) A[r*n+c]-=f*A[i*n+c]; b[r]-=f*b[i]; }
  }
  const x=new Float64Array(n);
  for(let i=n-1;i>=0;i--){ let s=b[i]; for(let c=i+1;c<n;c++) s-=A[i*n+c]*x[c]; x[i]=s/A[i*n+i]; }
  return x;
}
function spInverse(A,n){                              // обратная матрица (Гаусс — Жордан)
  const M=new Float64Array(n*2*n), w=2*n;
  for(let i=0;i<n;i++){ for(let j=0;j<n;j++) M[i*w+j]=A[i*n+j]; M[i*w+n+i]=1; }
  for(let i=0;i<n;i++){
    let m=i; for(let r=i+1;r<n;r++) if(Math.abs(M[r*w+i])>Math.abs(M[m*w+i])) m=r;
    if(Math.abs(M[m*w+i])<1e-300) return null;
    if(m!==i) for(let c=0;c<w;c++){ const t=M[i*w+c]; M[i*w+c]=M[m*w+c]; M[m*w+c]=t; }
    const p=M[i*w+i]; for(let c=0;c<w;c++) M[i*w+c]/=p;
    for(let r=0;r<n;r++){ if(r===i) continue; const f=M[r*w+i]; if(!f) continue; for(let c=0;c<w;c++) M[r*w+c]-=f*M[i*w+c]; }
  }
  const R=new Float64Array(n*n); for(let i=0;i<n;i++) for(let j=0;j<n;j++) R[i*n+j]=M[i*w+n+j]; return R;
}

// ---------- решатель ----------
// opt: sd, sa, sg (σ по умолчанию: рулетка м, угол °, GPS м), eye, ground(lat,lon)→высота м (NaN — нет), sground — σ высоты рельефа
function spSolve(text,opt={}){
  const P=spParse(text,opt), N=P.names.length;
  const out={names:P.names,errors:P.errors,polys:[],pts:[],res:[],frame:null,georef:false,chi2:0,dof:0,rms:0,iters:0,n:N};
  if(!N) return out;
  const {X,frame}=spInit(P);
  out.frame=frame;
  let obs=P.obs.slice();
  // рельеф под GPS-точками (по желанию): слабое измерение высоты
  if(opt.ground && frame){
    const has=new Set(obs.filter(o=>o.k==='z').map(o=>o.a));
    for(const o of P.obs) if(o.k==='gps' && !has.has(o.a)){ const h=opt.ground(o.lat,o.lon); if(isFinite(h)){ obs.push({k:'z',a:o.a,v:h,s:opt.sground>0 ? opt.sground : 5,li:o.li,fromGround:true}); has.add(o.a); } }
  }
  const has3D=obs.some(o=>o.k==='z'||o.k==='dz');
  const anchors=new Set(obs.filter(o=>o.k==='gps'||o.k==='at').map(o=>o.a));
  const azCount=obs.filter(o=>o.k==='az').length;
  const zAnch=obs.some(o=>o.k==='z');
  // «калибровочные» псевдо-измерения: убирают свободу сдвига / поворота; когда измерений для этого достаточно — не добавляются
  const gauge=[];
  if(!anchors.size){ gauge.push({k:'fix',i:0,v:X[0],s:1e-4},{k:'fix',i:1,v:X[1],s:1e-4}); }
  if(anchors.size<2 && !azCount){ const q=[...Array(N).keys()].find(i=>i!==(anchors.size ? [...anchors][0] : 0)); if(q!==undefined) gauge.push({k:'fix',i:3*q+1,v:X[3*q+1],s:1e-4}); }
  if(!has3D){ for(let i=0;i<N;i++) gauge.push({k:'fix',i:3*i+2,v:0,s:1e-6}); }
  else if(!zAnch) gauge.push({k:'fix',i:2,v:X[2],s:1e-4});
  // высоты: точки, связанные цепочкой dz, образуют группу; группа без абсолютной высоты (z / GPS alt) — «как у соседа» ±1 м для одной её точки (рулетка без dz считается почти горизонтальной)
  const uf=[...Array(N).keys()], find=i=>uf[i]===i ? i : (uf[i]=find(uf[i]));
  for(const o of obs) if(o.k==='dz') uf[find(o.a)]=find(o.b);
  const zAnchored=new Set(obs.filter(o=>o.k==='z').map(o=>find(o.a))), zRep=new Set();
  for(let i=0;i<N;i++){ const r=find(i); if(has3D && !zAnchored.has(r) && !zRep.has(r)) zRep.add(r), zRep.add('p'+i); }
  // очень слабая привязка к начальному приближению
  const prior=[]; for(let i=0;i<3*N;i++) prior.push({k:'fix',i,v:X[i],s:i%3===2 && zRep.has('p'+(i-2)/3) ? 1 : 1e3});
  const all=obs.concat(gauge,prior), n3=3*N;
  const Hm=new Float64Array(n3*n3), g=new Float64Array(n3);
  const assemble=()=>{
    Hm.fill(0); g.fill(0); let chi=0;
    for(const o of all){
      const r0=spResid(o,X,frame), ids=spInvolved(o), cols=[]; for(const p of ids) cols.push(3*p,3*p+1,3*p+2);
      const Jc=[];                                                                  // колонки якобиана: по числу невязок
      for(const c of cols){
        const h=1e-6*Math.max(1,Math.abs(X[c])), s0=X[c];
        X[c]=s0+h; const rp=spResid(o,X,frame); X[c]=s0-h; const rm=spResid(o,X,frame); X[c]=s0;
        Jc.push(rp.map((v,i)=>(v-rm[i])/(2*h)));
      }
      for(let a=0;a<r0.length;a++){
        chi+=r0[a]*r0[a];
        for(let i=0;i<cols.length;i++){ const ji=Jc[i][a]; if(!ji) continue; g[cols[i]]+=ji*r0[a];
          for(let j=0;j<cols.length;j++) Hm[cols[i]*n3+cols[j]]+=ji*Jc[j][a]; }
      }
    }
    return chi;
  };
  let mu=1e-3, chi=assemble();
  for(let it=0;it<80;it++){
    out.iters=it+1;
    const A=Float64Array.from(Hm), b=Float64Array.from(g).map(v=>-v);
    for(let i=0;i<n3;i++) A[i*n3+i]+=mu*Math.max(Hm[i*n3+i],1e-12);
    const d=spSolveLin(A,b,n3); if(!d){ mu*=10; if(mu>1e12) break; continue; }
    const X0=Float64Array.from(X); for(let i=0;i<n3;i++) X[i]+=d[i];
    const save=[Float64Array.from(Hm),Float64Array.from(g)];
    const chi1=assemble();
    if(chi1<=chi){ const dn=Math.sqrt(d.reduce((s,v)=>s+v*v,0)), gain=chi-chi1; chi=chi1; mu=Math.max(mu/5,1e-12); if(dn<1e-9 || gain<1e-14*Math.max(1,chi)) break; }
    else { X.set(X0); Hm.set(save[0]); g.set(save[1]); mu*=8; if(mu>1e12) break; }
  }
  // итоговые невязки и ковариация
  const real=obs; let chiR=0, m=0;
  for(const o of real){
    const r=spResid(o,X,frame); m+=r.length; chiR+=r.reduce((s,v)=>s+v*v,0);
    out.res.push({li:o.li+1,k:o.k,a:P.names[o.a],b:o.b!==undefined ? P.names[o.b] : '',r:r.map(v=>v*o.s),n:r,nmax:Math.max(...r.map(Math.abs)),s:o.s,out:Math.max(...r.map(Math.abs))>3,v:o.v});
  }
  const nGauge=3*N - 0;                                                           // число неизвестных
  const fixed=gauge.length;
  out.dof=Math.max(0,m+fixed-nGauge);
  out.chi2=chiR;
  out.rms=m ? Math.sqrt(chiR/m) : 0;
  const Hn=Float64Array.from(Hm); for(let i=0;i<n3;i++) Hn[i*n3+i]+=1e-12;
  const Q=spInverse(Hn,n3), sc=out.dof>0 ? Math.max(1,Math.sqrt(chiR/out.dof)) : 1;
  for(let i=0;i<N;i++){
    const sx=Q?Math.sqrt(Math.max(Q[(3*i)*n3+3*i],0))*sc:NaN, sy=Q?Math.sqrt(Math.max(Q[(3*i+1)*n3+3*i+1],0))*sc:NaN, sz=Q?Math.sqrt(Math.max(Q[(3*i+2)*n3+3*i+2],0))*sc:NaN;
    out.pts.push({name:P.names[i],x:X[3*i],y:X[3*i+1],z:X[3*i+2],sx,sy,sz,weak:!(Math.hypot(sx,sy)<100)});
  }
  out.georef=!!frame && (anchors.size>=2 || (anchors.size>=1 && azCount>0) || anchors.size>=1 && obs.some(o=>o.k==='at'));
  if(out.georef) for(const p of out.pts){ const q=frame.inv(p.x,p.y); p.lat=q[0]; p.lon=q[1]; }
  // зеркало: рулетка и углы одинаковы у плана и его отражения — по ним не понять, по часовой или против обходили; «mirror» переворачивает план слева направо
  if(P.mirror){
    if(anchors.size>=2 || azCount>0) out.errors.push({line:0,text:'mirror',msg:'mirror is ignored: GPS / compass / «at» points already fix which side is which'});
    else if(N){ const x0=out.pts[0].x; for(const p of out.pts) p.x=2*x0-p.x; out.mirror=true; }
  }
  // контуры
  for(const pl of P.polys){ const q=spPoly(pl.ids.map(i=>out.pts[i])); if(pl.h>0){ q.h=pl.h; q.volume=q.area*pl.h; } out.polys.push(q); }
  // проёмы: по стене между соседними углами контура; не влезает в стену — ошибка
  out.opens=[];
  for(const o of P.opens||[]){
    const A=out.pts[o.a], B=out.pts[o.b], L=Math.hypot(B.x-A.x,B.y-A.y), nm=A.name+'-'+B.name;
    const side=P.polys.some(pl=>{ const m=pl.ids.length; return pl.ids.some((id,i)=>(id===o.a && pl.ids[(i+1)%m]===o.b) || (id===o.b && pl.ids[(i+1)%m]===o.a)); });
    if(!side){ out.errors.push({line:o.li+1,text:o.kind+' '+nm,msg:o.kind+': '+nm+' is not a side of a room (use neighbouring corners)'}); continue; }
    if(o.from+o.w>L+.05){ out.errors.push({line:o.li+1,text:o.kind+' '+nm,msg:o.kind+' '+nm+': '+o.from+' + '+o.w+' m is longer than the wall ('+L.toFixed(2)+' m)'}); continue; }
    out.opens.push({kind:o.kind,a:A.name,b:B.name,from:o.from,w:o.w,h:o.h,sill:o.sill,L});
  }
  out.ground=out.pts.length ? out.pts.map(p=>p.z) : [];
  out.edges=[]; { const seen=new Set(); for(const o of obs) if((o.k==='d'||o.k==='h'||o.k==='dz'||o.k==='az') && o.b!==undefined){ const key=Math.min(o.a,o.b)+'-'+Math.max(o.a,o.b); if(!seen.has(key)){ seen.add(key); out.edges.push([o.a,o.b]); } } }
  return out;
}

// площадь / периметр / уклон контура. area — в плане (проекция), surf — по поверхности (векторная площадь: верна для плоского контура)
function spPoly(pts){
  const n=pts.length; let a2=0, per=0, per3=0, nx=0, ny=0, nz=0;
  for(let i=0;i<n;i++){
    const p=pts[i], q=pts[(i+1)%n];
    a2+=p.x*q.y-q.x*p.y; per+=Math.hypot(q.x-p.x,q.y-p.y); per3+=Math.hypot(q.x-p.x,q.y-p.y,q.z-p.z);
    nx+=p.y*q.z-q.y*p.z; ny+=p.z*q.x-q.z*p.x; nz+=p.x*q.y-q.x*p.y;
  }
  const area=Math.abs(a2)/2, surf=Math.hypot(nx,ny,nz)/2;
  const slope=surf>0 ? Math.acos(Math.min(1,Math.abs(nz)/(2*surf)))/SP_D : 0;
  let cx=0, cy=0, cz=0; for(const p of pts){ cx+=p.x/n; cy+=p.y/n; cz+=p.z/n; }
  return {names:pts.map(p=>p.name),area,surf,perimeter:per,perimeter3d:per3,slope,slopePct:100*Math.tan(slope*SP_D),cx,cy,cz,ccw:a2>0};
}

// ---------- экспорт ----------
const spF=(v,d=3)=>String(+v.toFixed(d));
function spDXF(R){
  const L=['0','SECTION','2','HEADER','9','$ACADVER','1','AC1009','0','ENDSEC','0','SECTION','2','ENTITIES'];
  const lay=n=>{ L.push('8',n); };
  for(const p of R.pts){ L.push('0','POINT'); lay('POINTS'); L.push('10',spF(p.x),'20',spF(p.y),'30',spF(p.z));
    L.push('0','TEXT'); lay('NAMES'); L.push('10',spF(p.x+.1),'20',spF(p.y+.1),'30',spF(p.z),'40','0.3','1',p.name); }
  for(const [a,b] of R.edges){ const p=R.pts[a], q=R.pts[b]; L.push('0','LINE'); lay('EDGES'); L.push('10',spF(p.x),'20',spF(p.y),'30',spF(p.z),'11',spF(q.x),'21',spF(q.y),'31',spF(q.z)); }
  for(const pl of R.polys){
    L.push('0','POLYLINE'); lay('OUTLINES'); L.push('66','1','70','9');
    for(const nm of pl.names){ const p=R.pts.find(q=>q.name===nm); L.push('0','VERTEX'); lay('OUTLINES'); L.push('10',spF(p.x),'20',spF(p.y),'30',spF(p.z),'70','32'); }
    L.push('0','SEQEND'); lay('OUTLINES');
  }
  L.push('0','ENDSEC','0','EOF'); return L.join('\n')+'\n';
}
function spGeoJSON(R){
  if(!R.georef) return null;
  const f=[];
  for(const p of R.pts) f.push({type:'Feature',properties:{name:p.name,z:+p.z.toFixed(2),sigma_m:+Math.hypot(p.sx,p.sy).toFixed(3)},geometry:{type:'Point',coordinates:[+p.lon.toFixed(8),+p.lat.toFixed(8),+p.z.toFixed(2)]}});
  for(const pl of R.polys){ const ring=pl.names.map(nm=>{ const p=R.pts.find(q=>q.name===nm); return [+p.lon.toFixed(8),+p.lat.toFixed(8)]; }); ring.push(ring[0]);
    f.push({type:'Feature',properties:{area_m2:+pl.area.toFixed(2),perimeter_m:+pl.perimeter.toFixed(2),slope_deg:+pl.slope.toFixed(1)},geometry:{type:'Polygon',coordinates:[ring]}}); }
  return JSON.stringify({type:'FeatureCollection',features:f},null,1);
}
function spCSV(R){
  return 'name,x,y,z,sx,sy,sz'+(R.georef ? ',lat,lon' : '')+'\n'+R.pts.map(p=>[p.name,spF(p.x),spF(p.y),spF(p.z),spF(p.sx,4),spF(p.sy,4),spF(p.sz,4)].concat(R.georef ? [p.lat.toFixed(8),p.lon.toFixed(8)] : []).join(',')).join('\n')+'\n';
}
function spSVG(R,w=800,h=600){
  const pts=R.pts; if(!pts.length) return '';
  let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity; for(const p of pts){ x0=Math.min(x0,p.x); x1=Math.max(x1,p.x); y0=Math.min(y0,p.y); y1=Math.max(y1,p.y); }
  const pad=40, sc=Math.min((w-2*pad)/Math.max(x1-x0,1e-6),(h-2*pad)/Math.max(y1-y0,1e-6)), X=p=>pad+(p.x-x0)*sc, Y=p=>h-pad-(p.y-y0)*sc, esc=s=>String(s).replace(/[<&>]/g,c=>'&#'+c.charCodeAt(0)+';');
  const o=['<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'" font-family="sans-serif" font-size="12"><rect width="100%" height="100%" fill="#fff"/>'];
  for(const pl of R.polys) o.push('<polygon points="'+pl.names.map(nm=>{ const p=pts.find(q=>q.name===nm); return spF(X(p),1)+','+spF(Y(p),1); }).join(' ')+'" fill="#cfe8ff" stroke="#246" stroke-width="2"/>');
  for(const [a,b] of R.edges){ const p=pts[a], q=pts[b]; o.push('<line x1="'+spF(X(p),1)+'" y1="'+spF(Y(p),1)+'" x2="'+spF(X(q),1)+'" y2="'+spF(Y(q),1)+'" stroke="#246" stroke-width="1"/>');
    o.push('<text x="'+spF((X(p)+X(q))/2,1)+'" y="'+spF((Y(p)+Y(q))/2-3,1)+'" fill="#555" text-anchor="middle">'+spF(Math.hypot(q.x-p.x,q.y-p.y,q.z-p.z),2)+'</text>'); }
  for(const p of pts) o.push('<circle cx="'+spF(X(p),1)+'" cy="'+spF(Y(p),1)+'" r="3" fill="#c22"/><text x="'+spF(X(p)+6,1)+'" y="'+spF(Y(p)-6,1)+'">'+esc(p.name)+(Math.abs(p.z)>.005 ? ' ('+spF(p.z,2)+')' : '')+'</text>');
  for(const pl of R.polys) o.push('<text x="'+spF(pad+(pl.cx-x0)*sc,1)+'" y="'+spF(h-pad-(pl.cy-y0)*sc,1)+'" text-anchor="middle" font-weight="bold">'+spF(pl.area,1)+' m²</text>');
  o.push('</svg>'); return o.join('\n');
}

// ---------- сетка ----------
// «красивый» шаг сетки (1, 2, 5 × 10^k) не меньше want (м)
function spNice(want){
  if(!(want>0)) return 1;
  const e=Math.pow(10,Math.floor(Math.log10(want))), m=want/e;
  return (m<=1 ? 1 : m<=2 ? 2 : m<=5 ? 5 : 10)*e;
}
// система координат сетки: 'north' — оси плана (x — восток, y — север), начало в 0;
// 'structure' — начало в первой точке контура, ось u вдоль его первой стороны, v — влево от неё (как у чертежа конструкции)
function spGridFrame(R,mode){
  if(mode!=='structure' || R.pts.length<2) return {mode:'north',ox:0,oy:0,ux:1,uy:0,vx:0,vy:1};
  let a=R.pts[0], b=R.pts[1];
  if(R.polys.length){ const nm=R.polys[0].names; a=R.pts.find(p=>p.name===nm[0]); b=R.pts.find(p=>p.name===nm[1]); }
  const L=Math.hypot(b.x-a.x,b.y-a.y)||1, ux=(b.x-a.x)/L, uy=(b.y-a.y)/L;
  return {mode:'structure',ox:a.x,oy:a.y,ux,uy,vx:-uy,vy:ux};
}
const spToFrame=(f,x,y)=>[(x-f.ox)*f.ux+(y-f.oy)*f.uy,(x-f.ox)*f.vx+(y-f.oy)*f.vy];
const spFromFrame=(f,u,v)=>[f.ox+u*f.ux+v*f.vx,f.oy+u*f.uy+v*f.vy];
// линии сетки, покрывающие точки: {step,u:[…],v:[…],u0,u1,v0,v1} в системе сетки (поле — запас в шагах)
function spGridLines(R,f,want,pad=1){
  const step=spNice(want); let u0=1e99,u1=-1e99,v0=1e99,v1=-1e99;
  for(const p of R.pts){ const q=spToFrame(f,p.x,p.y); u0=Math.min(u0,q[0]); u1=Math.max(u1,q[0]); v0=Math.min(v0,q[1]); v1=Math.max(v1,q[1]); }
  if(!isFinite(u0)) return {step,u:[],v:[],u0:0,u1:0,v0:0,v1:0};
  u0=Math.floor(u0/step-pad)*step; u1=Math.ceil(u1/step+pad)*step; v0=Math.floor(v0/step-pad)*step; v1=Math.ceil(v1/step+pad)*step;
  const U=[],V=[]; for(let u=u0;u<=u1+1e-9 && U.length<200;u+=step) U.push(+u.toFixed(9)); for(let v=v0;v<=v1+1e-9 && V.length<200;v+=step) V.push(+v.toFixed(9));
  return {step,u:U,v:V,u0,u1,v0,v1};
}

// ---------- строки таблицы (Table) и записей (rec) → строки замеров ----------
// Колонки (регистр не важен): line | text — готовая строка; kind (d / h / dz / az / tilt / ang / poly) + a, b[, c] (или from, to) + value (или v, d, dist, length) [+ sigma | s | err];
// без kind: name + lat, lon [+ acc, alt] — GPS; name + x, y [+ z] — координаты; name + z — высота; a, b + value — расстояние.
function spRowToLine(r){
  if(!r || typeof r!=='object') return '';
  const R={}; for(const k of Object.keys(r)) R[String(k).trim().toLowerCase()]=r[k];
  const has=v=>v!==undefined && v!==null && String(v).trim()!=='';
  const g=(...ks)=>{ for(const k of ks) if(has(R[k])) return R[k]; return undefined; };
  const nm=v=>String(v).trim().replace(/[\s-]+/g,'_');
  const num=v=>{ if(!has(v)) return NaN; const x=Number(String(v).trim().replace(',','.')); return isFinite(x) ? x : NaN; };
  const f=v=>String(+v.toFixed(6)), sg=v=>isFinite(v) && v>0 ? ' ± '+f(v) : '';
  const raw=g('line','text','dsl'); if(typeof raw==='string' && raw.trim()) return raw.trim();
  const kind=String(g('kind','type','k')??'').trim().toLowerCase(), sig=num(g('sigma','s','err','error','±'));
  const a=g('a','from','p1','name','point'), b=g('b','to','p2'), c=g('c','p3'), val=num(g('value','v','d','dist','distance','len','length','m'));
  if(kind==='poly'){ const l=g('names','points','poly')??[a,b,c].filter(has).join(' '); const ids=String(l).split(/[\s,;]+/).filter(Boolean).map(nm); return ids.length>=3 ? 'poly '+ids.join(' ') : ''; }
  if(kind==='tilt'){ const ang=num(g('angle','value','v')), hd=num(g('hd','dist','distance','h')), eye=num(g('eye')); return has(a)&&has(b)&&isFinite(ang)&&hd>0 ? nm(a)+'-'+nm(b)+' tilt '+f(ang)+' '+f(hd)+(isFinite(eye) ? ' eye '+f(eye) : '')+sg(sig) : ''; }
  if(kind==='ang'||kind==='angle'){ return has(a)&&has(b)&&has(c)&&isFinite(val) ? nm(a)+'-'+nm(b)+'-'+nm(c)+' '+f(val)+sg(sig) : ''; }
  if(kind==='d'||kind==='h'||kind==='dz'||kind==='az'||(!kind && has(a) && has(b) && isFinite(val))){
    return has(a)&&has(b)&&isFinite(val) ? nm(a)+'-'+nm(b)+' '+(kind && kind!=='d' ? kind+' ' : '')+f(val)+sg(sig) : '';
  }
  if(kind && kind!=='gps' && kind!=='at' && kind!=='z') return '';
  const la=num(g('lat','latitude')), lo=num(g('lon','lng','longitude')), x=num(g('x','east')), y=num(g('y','north')), z=num(g('z','height','alt','altitude','h'));
  if(has(a) && isFinite(la) && isFinite(lo) && Math.abs(la)<=90 && Math.abs(lo)<=180){
    const acc=num(g('acc','accuracy','sigma','s')); return nm(a)+' gps '+f(la)+' '+f(lo)+sg(acc)+(isFinite(z) ? ' alt '+f(z) : '');
  }
  if(has(a) && isFinite(x) && isFinite(y)) return nm(a)+' at '+f(x)+' '+f(y)+sg(sig)+(isFinite(z) ? '\n'+nm(a)+' z '+f(z) : '');
  if(has(a) && isFinite(z) && !isFinite(x) && !isFinite(y)) return nm(a)+' z '+f(z)+sg(sig);
  return '';
}
const spRowsToText=rows=>(rows||[]).map(spRowToLine).filter(Boolean).join('\n');
