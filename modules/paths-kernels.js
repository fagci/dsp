"use strict";
/* ============================ Ядро Signal Paths ============================
   Пути сигнала между двумя точками над рельефом: прямой (прямая видимость, зоны Френеля, дифракция на главном препятствии)
   и однократные зеркальные отражения от рельефа (поиск по сетке: отражённый луч попадает во второй конец с промахом не больше tolM).
   Рельеф — функция T(x, y) → высота, м (NaN — нет данных) в локальных метрах; точки — [x, y, z] (z над уровнем моря).
   Без DOM — проверяется tools/test-paths.mjs. */

const PP_R=6371008.8, PP_D=Math.PI/180, PP_C=299792458;

// локальная плоская проекция вокруг точки: x на восток, y на север, метры (до десятков км — с ошибкой в доли процента)
function ppFrame(lat0,lon0){
  const ky=PP_R*PP_D, kx=ky*Math.cos(lat0*PP_D);
  return {fwd:(la,lo)=>[(lo-lon0)*kx,(la-lat0)*ky], inv:(x,y)=>[lat0+y/ky,lon0+x/kx]};
}
const ppDist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
// потери в свободном пространстве, дБ
const ppFspl=(d,f)=>20*Math.log10(4*Math.PI*Math.max(1,d)*f/PP_C);
// потери на дифракции на ноже (Itu-R P.526, приближение), ν — параметр Френеля
const ppKnife=v=>v>-.78 ? 6.9+20*Math.log10(Math.sqrt((v-.1)*(v-.1)+1)+v-.1) : 0;

// профиль вдоль отрезка A→B: превышение линии над рельефом с поправкой на кривизну Земли (k — рефракция),
// радиус первой зоны Френеля, главное препятствие. skip — выборок у конца B не считать (для отражённых лучей, упирающихся в землю)
function ppProfile(T,A,B,k,f,n,skipEnd=0,skipStart=0){
  const L=ppDist(A,B), lam=PP_C/f, Re=PP_R*k, out={L,n,clear:new Float32Array(n+1),min:Infinity,minI:-1,fres:Infinity,nu:-Infinity,nuI:-1,los:true};
  for(let i=0;i<=n;i++){
    const t=i/n, x=A[0]+(B[0]-A[0])*t, y=A[1]+(B[1]-A[1])*t, z=A[2]+(B[2]-A[2])*t, d1=L*t, d2=L*(1-t);
    const h=T(x,y); out.clear[i]=NaN;
    if(h!==h || i<skipStart || i>n-skipEnd) continue;
    const bulge=d1*d2/(2*Re), c=z-h-bulge;               // запас над рельефом, м
    out.clear[i]=c;
    if(c<out.min){ out.min=c; out.minI=i; }
    if(d1>0 && d2>0){
      const r1=Math.sqrt(lam*d1*d2/L), fr=c/r1;
      if(fr<out.fres) out.fres=fr;
      const nu=-c*Math.sqrt(2*L/(lam*d1*d2));            // >0 — линия ниже препятствия
      if(nu>out.nu){ out.nu=nu; out.nuI=i; }
    }
  }
  out.los=out.min>=0;
  out.diff=out.nu>-.78 && !out.los ? ppKnife(out.nu) : 0;
  return out;
}
function ppNormal(T,x,y,e){
  const a=T(x+e,y), b=T(x-e,y), c=T(x,y+e), d=T(x,y-e);
  if(a!==a || b!==b || c!==c || d!==d) return null;
  const nx=-(a-b)/(2*e), ny=-(c-d)/(2*e), l=Math.hypot(nx,ny,1);
  return [nx/l,ny/l,1/l];
}
// промах зеркального отражения от точки P=[x,y,z] поверхности с нормалью n: на каком расстоянии (м) от B проходит луч A→P после отражения.
// Угол нормали для этого плох: на пологих лучах сдвиг на 10 м даёт десятки градусов. Infinity — A и B по разные стороны поверхности
function ppMiss(P,n,A,B){
  const a=[A[0]-P[0],A[1]-P[1],A[2]-P[2]], b=[B[0]-P[0],B[1]-P[1],B[2]-P[2]], la=Math.hypot(...a);
  if(!(la>0)) return Infinity;
  const da=a[0]*n[0]+a[1]*n[1]+a[2]*n[2], db=b[0]*n[0]+b[1]*n[1]+b[2]*n[2];
  if(da<=0 || db<=0) return Infinity;
  const r=[-a[0]/la+2*(da/la)*n[0], -a[1]/la+2*(da/la)*n[1], -a[2]/la+2*(da/la)*n[2]];   // направление отражённого луча из P
  const t=b[0]*r[0]+b[1]*r[1]+b[2]*r[2];
  if(t<=0) return Math.hypot(...b);
  return Math.hypot(b[0]-t*r[0],b[1]-t*r[1],b[2]-t*r[2]);
}
// угол (°) между нормалью и биссектрисой лучей к A и B — точная мера зеркальности внутри области допустимого промаха
function ppAng(P,n,A,B){
  const a=[A[0]-P[0],A[1]-P[1],A[2]-P[2]], b=[B[0]-P[0],B[1]-P[1],B[2]-P[2]], la=Math.hypot(...a), lb=Math.hypot(...b);
  if(!(la>0) || !(lb>0)) return Infinity;
  const s=[a[0]/la+b[0]/lb,a[1]/la+b[1]/lb,a[2]/la+b[2]/lb], ls=Math.hypot(...s);
  if(!(ls>0)) return Infinity;
  return Math.acos(Math.max(-1,Math.min(1,(s[0]*n[0]+s[1]*n[1]+s[2]*n[2])/ls)))/PP_D;
}
// уточнение точки отражения методом зеркального изображения: касательная плоскость в точке, A зеркалится в неё, отрезок «зеркало A → B»
// пересекает плоскость в следующей точке; повторять до сходимости (на гладком рельефе — несколько шагов, в том числе вдоль плато)
function ppRefine(T,A,B,x,y,e){
  for(let it=0;it<12;it++){
    const z=T(x,y); if(z!==z) return null;
    const n=ppNormal(T,x,y,e); if(!n) return null;
    const a=[A[0]-x,A[1]-y,A[2]-z], b=[B[0]-x,B[1]-y,B[2]-z], da=a[0]*n[0]+a[1]*n[1]+a[2]*n[2], db=b[0]*n[0]+b[1]*n[1]+b[2]*n[2];
    if(da<=0 || db<=0) return null;
    const m=[a[0]-2*da*n[0],a[1]-2*da*n[1],a[2]-2*da*n[2]], dm=-da, t=-dm/(db-dm);          // m — зеркальный A относительно P
    const qx=x+m[0]+(b[0]-m[0])*t, qy=y+m[1]+(b[1]-m[1])*t;
    const d=Math.hypot(qx-x,qy-y); x=qx; y=qy;
    if(d<.05) break;
  }
  return [x,y];
}
// однократные отражения: opt {k,f,step (шаг сетки, м; 0 — авто),tolM (допустимый промах, м; не меньше шага сетки),maxRatio (длина пути / длина прямой),maxn,reflDb,grid (макс. ячеек)}
function ppReflections(T,A,B,opt){
  const L=ppDist(A,B), ratio=opt.maxRatio||2, cx=(A[0]+B[0])/2, cy=(A[1]+B[1])/2, th=Math.atan2(B[1]-A[1],B[0]-A[0]);
  const a=ratio*L/2, b=Math.sqrt(Math.max(1,a*a-L*L/4)), wx=Math.hypot(a*Math.cos(th),b*Math.sin(th)), wy=Math.hypot(a*Math.sin(th),b*Math.cos(th));
  const maxCells=opt.grid||90000, step=Math.max(opt.step||0,Math.sqrt(4*wx*wy/maxCells));
  const NX=Math.max(3,Math.ceil(2*wx/step)), NY=Math.max(3,Math.ceil(2*wy/step)), x0=cx-wx, y0=cy-wy;
  const miss=new Float32Array(NX*NY).fill(Infinity), ang=new Float32Array(NX*NY).fill(Infinity), e=Math.max(1,step/2), tol=Math.max(opt.tolM||30,step);
  const sum=(x,y,z)=>Math.hypot(x-A[0],y-A[1],z-A[2])+Math.hypot(x-B[0],y-B[1],z-B[2]);
  for(let j=0;j<NY;j++) for(let i=0;i<NX;i++){
    const x=x0+(i+.5)*step, y=y0+(j+.5)*step, z=T(x,y);
    if(z!==z || sum(x,y,z)>ratio*L) continue;
    const n=ppNormal(T,x,y,e); if(!n) continue;
    const v=ppMiss([x,y,z],n,A,B);
    if(v<=tol){ miss[j*NX+i]=v; ang[j*NX+i]=ppAng([x,y,z],n,A,B); }
  }
  // связная область ячеек с допустимым промахом — одно отражение (на ровной земле это полоса вдоль пути); точка — с наименьшим углом
  const seen=new Uint8Array(NX*NY), out=[], regions=[];
  for(let c0=0;c0<NX*NY;c0++){
    if(seen[c0] || miss[c0]===Infinity) continue;
    let best=c0, stack=[c0], size=0; seen[c0]=1;
    while(stack.length){
      const c=stack.pop(); size++;
      if(ang[c]<ang[best]) best=c;
      const ci=c%NX, cj=(c/NX)|0;
      for(let dj=-1;dj<=1;dj++) for(let di=-1;di<=1;di++){
        const ii=ci+di, jj=cj+dj; if(ii<0||jj<0||ii>=NX||jj>=NY) continue;
        const q=jj*NX+ii; if(!seen[q] && miss[q]!==Infinity){ seen[q]=1; stack.push(q); }
      }
    }
    regions.push({best,size});
  }
  regions.sort((p,q)=>ang[p.best]-ang[q.best]);
  for(const g of regions.slice(0,60)){
    const c0=[x0+((g.best%NX)+.5)*step, y0+(((g.best/NX)|0)+.5)*step], r=ppRefine(T,A,B,c0[0],c0[1],Math.max(.5,step/8));
    if(!r) continue;
    const px=r[0], py=r[1];
    const z=T(px,py); if(z!==z) continue;
    const nn=ppNormal(T,px,py,Math.max(.5,step/8)); if(!nn) continue;
    const ms=ppMiss([px,py,z],nn,A,B); if(ms>tol) continue;
    const P=[px,py,z], P2=[px,py,z+.5], len=ppDist(A,P)+ppDist(P,B);
    // обе части пути должны идти над рельефом
    const nA=Math.max(8,Math.min(300,Math.round(ppDist(A,P)/Math.max(10,step/2)))), nB=Math.max(8,Math.min(300,Math.round(ppDist(P,B)/Math.max(10,step/2))));
    const pa=ppProfile(T,A,P2,opt.k,opt.f,nA,2), pb=ppProfile(T,P2,B,opt.k,opt.f,nB,0,2);
    if(pa.min<-1 || pb.min<-1) continue;
    out.push({P,len,excess:len-L,miss:ms,ang:ppAng(P,nn,A,B),loss:ppFspl(len,opt.f)+opt.reflDb,clear:Math.min(pa.min,pb.min),fresA:pa.fres,fresB:pb.fres,cells:g.size});
  }
  out.sort((p,q)=>p.loss-q.loss);
  return out.slice(0,opt.maxn||6);
}
// прямой путь: LOS, зоны Френеля, дифракция, потери
function ppDirect(T,A,B,k,f){
  const L=ppDist(A,B), n=Math.max(16,Math.min(600,Math.round(L/50))), pr=ppProfile(T,A,B,k,f,n);
  return {L,los:pr.los,clear:pr.min,fres:pr.fres,diff:pr.diff,nu:pr.nu,loss:ppFspl(L,f)+pr.diff,fspl:ppFspl(L,f),prof:pr};
}
