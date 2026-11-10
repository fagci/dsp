"use strict";
/* ============================ Image on Map: ядро ============================
   Привязка снимка (дрон, ортофото, скриншот, фото с высоты) к земле по опорным точкам: пиксель (u, v; v вниз) ↔ метры (X восток, Y север).
   Две точки — подобие (поворот, один масштаб, сдвиг), три и больше — аффинное (ещё и разные масштабы по осям, перекос); невязки — в метрах.
   Результат: матрица M = [a b tx; d e ty] (u, v → X, Y), перепроекция на север-вверх по широте / долготе для карты (giWarp) и гомография для подложки Plan Editor.
   Без DOM: node tools/test-geoimage.mjs */

const GI_M=6371008.8*Math.PI/180;                                 // метров на градус дуги (сфера, как в Site Plan)
function giFrame(lat0,lon0){
  const k=Math.cos(lat0*Math.PI/180);
  return {lat0,lon0,fwd:(lat,lon)=>[(lon-lon0)*k*GI_M,(lat-lat0)*GI_M], inv:(x,y)=>[lat0+y/GI_M,lon0+x/(k*GI_M)]};
}
// «u v ИМЯ» — пиксель и имя известной точки (приходит записью: name, x, y, lat, lon); «u v lat lon» — пиксель и координаты прямо
function giParse(text){
  const pts=[], errors=[];
  String(text||'').split('\n').forEach((raw,li)=>{
    const t=raw.replace(/#.*/,'').trim(); if(!t) return;
    const T=t.replace(/(\d),(\d)/g,'$1.$2').split(/[\s;]+/).filter(Boolean), u=+T[0], v=+T[1];
    if(T.length<3 || !isFinite(u) || !isFinite(v)){ errors.push({line:li+1,text:t,msg:'a point is «u v NAME» or «u v lat lon» (u, v — the pixel, v counts down)'}); return; }
    if(T.length===3){ pts.push({u,v,name:T[2]}); return; }
    const lat=+T[2], lon=+T[3]; if(T.length!==4 || !isFinite(lat) || !isFinite(lon) || Math.abs(lat)>90 || Math.abs(lon)>180){ errors.push({line:li+1,text:t,msg:'«u v lat lon»: two numbers after the pixel'}); return; }
    pts.push({u,v,lat,lon});
  });
  return {pts,errors};
}
function giSolve(A,b){                                              // Гаусс с выбором главного, n×n
  const n=b.length, M=A.map((r,i)=>r.concat([b[i]]));
  for(let i=0;i<n;i++){
    let p=i; for(let r=i+1;r<n;r++) if(Math.abs(M[r][i])>Math.abs(M[p][i])) p=r;
    if(Math.abs(M[p][i])<1e-12) return null; [M[i],M[p]]=[M[p],M[i]];
    for(let r=i+1;r<n;r++){ const f=M[r][i]/M[i][i]; for(let c=i;c<=n;c++) M[r][c]-=f*M[i][c]; }
  }
  const x=new Array(n); for(let i=n-1;i>=0;i--){ let s=M[i][n]; for(let c=i+1;c<n;c++) s-=M[i][c]*x[c]; x[i]=s/M[i][i]; }
  return x;
}
const giNormal=(rows,rhs,k)=>{ const A=Array.from({length:k},()=>new Array(k).fill(0)), b=new Array(k).fill(0);
  rows.forEach((r,i)=>{ for(let p=0;p<k;p++){ b[p]+=r[p]*rhs[i]; for(let q=0;q<k;q++) A[p][q]+=r[p]*r[q]; } }); return giSolve(A,b); };
// pairs: [{u,v,X,Y}] → {M:[a,b,tx,d,e,ty], rms, resid, mpp, rot, similar, n, inv(X,Y)→[u,v], fwd(u,v)→[X,Y]}; null — мало точек или все на одной линии / в одной точке
function giFit(pairs,mode='auto'){
  const n=pairs.length; if(n<2) return null;
  let M=null, similar=true;
  if(mode!=='similar' && n>=3){                                    // аффинное: X = a u + b v + tx, Y = d u + e v + ty — две независимые задачи
    const rows=pairs.map(p=>[p.u,p.v,1]), sx=giNormal(rows,pairs.map(p=>p.X),3), sy=giNormal(rows,pairs.map(p=>p.Y),3);
    if(sx && sy){ M=[sx[0],sx[1],sx[2],sy[0],sy[1],sy[2]]; similar=false; }
  }
  if(!M){                                                          // подобие: X = c u + d v + tx, Y = d u − c v + ty (v вниз, север вверх)
    const rows=[], rhs=[]; for(const p of pairs){ rows.push([p.u,p.v,1,0]); rhs.push(p.X); rows.push([-p.v,p.u,0,1]); rhs.push(p.Y); }
    const s=giNormal(rows,rhs,4); if(!s) return null;
    M=[s[0],s[1],s[2],s[1],-s[0],s[3]]; similar=true;
  }
  const det=M[0]*M[4]-M[1]*M[3]; if(!(Math.abs(det)>1e-18)) return null;
  const fwd=(u,v)=>[M[0]*u+M[1]*v+M[2],M[3]*u+M[4]*v+M[5]];
  const inv=(X,Y)=>{ const x=X-M[2], y=Y-M[5]; return [(M[4]*x-M[1]*y)/det,(-M[3]*x+M[0]*y)/det]; };
  const resid=pairs.map(p=>{ const q=fwd(p.u,p.v); return Math.hypot(q[0]-p.X,q[1]-p.Y); });
  const rms=Math.sqrt(resid.reduce((t,r)=>t+r*r,0)/n);
  return {M,rms,resid,mpp:Math.sqrt(Math.abs(det)),rot:Math.atan2(M[3],M[0])*180/Math.PI,similar,n,fwd,inv};
}
// перепроекция снимка на сетку север-вверх по широте / долготе (для растрового слоя карты); src — RGBA sw×sh (уменьшенная копия снимка w×h);
// T — результат giFit в метрах рамки F (giFrame); maxSide — предел размера результата по большей стороне
function giWarp(src,sw,sh,w,h,T,F,maxSide=2048){
  const C=[[0,0],[w,0],[w,h],[0,h]].map(q=>{ const m=T.fwd(q[0],q[1]), g=F.inv(m[0],m[1]); return g; });
  const north=Math.max(...C.map(c=>c[0])), south=Math.min(...C.map(c=>c[0])), east=Math.max(...C.map(c=>c[1])), west=Math.min(...C.map(c=>c[1]));
  const k=Math.cos(F.lat0*Math.PI/180), spanY=(north-south)*GI_M, spanX=(east-west)*GI_M*k; if(!(spanX>0 && spanY>0)) return null;
  const px=Math.max(T.mpp*w/sw,spanX/maxSide,spanY/maxSide,.01);       // метров на пиксель результата: не мельче исходного и в пределах maxSide
  const ow=Math.max(1,Math.ceil(spanX/px)), oh=Math.max(1,Math.ceil(spanY/px)), out=new Uint8ClampedArray(ow*oh*4), kx=sw/w, ky=sh/h;
  for(let j=0;j<oh;j++){
    const lat=north-(j+.5)/oh*(north-south);
    for(let i=0;i<ow;i++){
      const lon=west+(i+.5)/ow*(east-west), m=F.fwd(lat,lon), q=T.inv(m[0],m[1]), fx=q[0]*kx-.5, fy=q[1]*ky-.5;
      if(!(fx>=-.5 && fy>=-.5 && fx<=sw-.5 && fy<=sh-.5)) continue;
      const x0=Math.max(0,Math.min(sw-2,Math.floor(fx))), y0=Math.max(0,Math.min(sh-2,Math.floor(fy))), tx=Math.max(0,Math.min(1,fx-x0)), ty=Math.max(0,Math.min(1,fy-y0)), o=(j*ow+i)*4;
      if(sw<2 || sh<2){ const s=(Math.min(sh-1,Math.max(0,Math.round(fy)))*sw+Math.min(sw-1,Math.max(0,Math.round(fx))))*4; for(let c=0;c<4;c++) out[o+c]=src[s+c]; continue; }
      for(let c=0;c<4;c++){ const a=src[(y0*sw+x0)*4+c], b=src[(y0*sw+x0+1)*4+c], d=src[((y0+1)*sw+x0)*4+c], e=src[((y0+1)*sw+x0+1)*4+c];
        out[o+c]=(a*(1-tx)+b*tx)*(1-ty)+(d*(1-tx)+e*tx)*ty; }
    }
  }
  return {data:out,w:ow,h:oh,north,south,east,west,mpp:px};
}
