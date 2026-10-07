"use strict";
/* ============================ Ядро Coverage ============================
   Предварительный расчёт покрытия: потери на трассе передатчик → точка (свободное пространство, дифракция на препятствиях
   по Дейгауту, интерференция прямого луча и отражения от земли), диаграмма направленности, сетка, контуры уровня, невязки с замерами.
   Без DOM — проверяется tools/test-coverage.mjs. Берёт ppFrame / ppKnife / ppFspl из paths-kernels.js. */

const CV_R=6371008.8, CV_D=Math.PI/180, CV_C=299792458;

// дифракция по Дейгауту: d — расстояния выборок от передатчика, hT — высоты препятствий (рельеф + кривизна), линия из (0,z0) в (L,z1);
// главное препятствие по параметру Френеля ν, затем рекурсивно по обе стороны от него (до depth уровней)
function cvDeygout(d,hT,z0,z1,lam,depth=3){
  const n=d.length, L=d[n-1]>0 ? d[n-1] : 0;
  const rec=(i0,i1,za,zb,xa,xb,dep)=>{
    if(dep<=0 || i1-i0<2) return 0;
    let best=-Infinity, bi=-1; const D=xb-xa;
    for(let i=i0+1;i<i1;i++){
      const s=d[i]-xa, r=xb-d[i]; if(s<=0 || r<=0) continue;
      const z=za+(zb-za)*s/D, nu=(hT[i]-z)*Math.sqrt(2*D/(lam*s*r));
      if(nu>best){ best=nu; bi=i; }
    }
    if(bi<0 || best<=-.78) return 0;
    return ppKnife(best)+rec(i0,bi,za,hT[bi],xa,d[bi],dep-1)+rec(bi,i1,hT[bi],zb,d[bi],xb,dep-1);
  };
  return rec(0,n-1,z0,z1,d[0],d[n-1],depth);
}
// интерференция прямого луча и отражения от плоской земли (Γ = −1 на пологих лучах): добавка к потерям свободного пространства, дБ
// (отрицательная — усиление до +6, положительная — провал; ограничена 60 дБ: в дальнем поле провал в десятки дБ — норма); d — горизонтальная дальность, h1 / h2 — высоты антенн над землёй
function cvTwoRay(d,h1,h2,f){
  const lam=CV_C/f, a=Math.hypot(d,h1-h2), b=Math.hypot(d,h1+h2), s=Math.sin(Math.PI*(b-a)/lam);
  return -Math.max(-60,10*Math.log10(Math.max(1e-6,4*s*s)));
}
// усиление направленной антенны в направлении az относительно максимума, дБ (≤ 0): гауссов лепесток шириной bw по уровню −3 дБ, не глубже −25 дБ
function cvTxGain(az,txAz,bw){
  if(!isFinite(az) || !isFinite(txAz) || !(bw>0) || bw>=360) return 0;
  const dz=((az-txAz+540)%360+360)%360-180;
  return -Math.min(25,12*(dz/bw)*(dz/bw));
}
// потери на трассе (дБ) от передатчика tx=[x,y,z] до точки rx=[x,y,z] над рельефом T(x,y); gT / gR — рельеф у концов (для двухлучевой модели)
function cvPathLoss(T,tx,rx,o){
  const L=Math.hypot(rx[0]-tx[0],rx[1]-tx[1],rx[2]-tx[2]), Lh=Math.hypot(rx[0]-tx[0],rx[1]-tx[1]);
  if(L<1) return {loss:0,los:true,diff:0,fspl:0,two:0};
  const lam=CV_C/o.f, n=Math.max(8,Math.min(160,Math.round(Lh/o.step))), Re=CV_R*o.k, d=new Float32Array(n+1), hT=new Float32Array(n+1);
  let los=true;
  for(let i=0;i<=n;i++){
    const t=i/n, x=tx[0]+(rx[0]-tx[0])*t, y=tx[1]+(rx[1]-tx[1])*t, h=T(x,y), s=Lh*t;
    d[i]=Lh*t; hT[i]=(h===h ? h : o.gref)+s*(Lh-s)/(2*Re);
    if(i>0 && i<n && hT[i]>tx[2]+(rx[2]-tx[2])*t) los=false;
  }
  const diff=los ? 0 : Math.min(o.maxDiff||60,cvDeygout(d,hT,tx[2],rx[2],lam)), fspl=ppFspl(L,o.f);
  const two=o.twoRay && los ? cvTwoRay(Lh,tx[2]-hT[0],rx[2]-hT[n],o.f) : 0;                   // высоты антенн над землёй у концов
  return {loss:fspl+diff+two+(o.clutter||0),los,diff,fspl,two};
}
// сетка вокруг центра: nx × ny ячеек со стороной cell, центры в локальных метрах (x на восток, y на север)
function cvGrid(Rm,cell){
  const n=Math.max(2,Math.round(2*Rm/cell)), c=2*Rm/n;
  return {nx:n,ny:n,cell:c,x0:-Rm,y0:-Rm,cx:i=>-Rm+(i+.5)*c,cy:j=>-Rm+(j+.5)*c};
}
// контур уровня level на сетке значений v (nx × ny, строка j — к северу): отрезки в долях ячейки → ломаные
function cvContour(v,nx,ny,level){
  const seg=[], at=(i,j)=>v[j*nx+i];
  const lerp=(a,b)=>{ const d=b-a; return Math.abs(d)<1e-9 ? .5 : (level-a)/d; };
  for(let j=0;j<ny-1;j++) for(let i=0;i<nx-1;i++){
    const a=at(i,j), b=at(i+1,j), c=at(i+1,j+1), d=at(i,j+1);
    if(!(isFinite(a)&&isFinite(b)&&isFinite(c)&&isFinite(d))) continue;
    const idx=(a>=level?1:0)|(b>=level?2:0)|(c>=level?4:0)|(d>=level?8:0);
    if(idx===0 || idx===15) continue;
    const P={t:[i+lerp(a,b),j], r:[i+1,j+lerp(b,c)], b:[i+lerp(d,c),j+1], l:[i,j+lerp(a,d)]};
    const table={1:['l','t'],2:['t','r'],3:['l','r'],4:['r','b'],5:['l','t','r','b'],6:['t','b'],7:['l','b'],8:['b','l'],9:['t','b'],10:['t','l','b','r'],11:['r','b'],12:['l','r'],13:['t','r'],14:['l','t']};
    const e=table[idx]; for(let q=0;q<e.length;q+=2) seg.push([P[e[q]],P[e[q+1]]]);
  }
  // сшивка в ломаные по совпадающим концам
  const key=p=>p[0].toFixed(3)+','+p[1].toFixed(3), ends=new Map();
  seg.forEach((s,k)=>{ for(const p of s){ const q=key(p); (ends.get(q)||ends.set(q,[]).get(q)).push(k); } });
  const used=new Uint8Array(seg.length), lines=[];
  for(let k=0;k<seg.length;k++){
    if(used[k]) continue; used[k]=1;
    const line=[seg[k][0],seg[k][1]];
    for(const dir of [1,0]){
      for(;;){
        const tip=dir ? line[line.length-1] : line[0], nxt=(ends.get(key(tip))||[]).find(q=>!used[q]);
        if(nxt===undefined) break;
        used[nxt]=1; const s=seg[nxt], p=key(s[0])===key(tip) ? s[1] : s[0];
        if(dir) line.push(p); else line.unshift(p);
      }
    }
    lines.push(line);
  }
  return lines;
}
// сводка по сетке уровней (dBm; NaN — нет расчёта): доля и площадь «мёртвых» ячеек ниже порога
function cvStats(v,cell,minDbm){
  let n=0, dead=0, sum=0, mx=-Infinity;
  for(let i=0;i<v.length;i++){ const x=v[i]; if(!isFinite(x)) continue; n++; sum+=x; if(x>mx) mx=x; if(x<minDbm) dead++; }
  return {n, dead:n ? dead/n : 0, area_km2:n*cell*cell/1e6, dead_km2:dead*cell*cell/1e6, mean:n ? sum/n : NaN, max:mx};
}
// невязки замеров с расчётом: пары [измерено, расчётное] (дБм) → среднее (смещение), СКО, число
function cvResid(pairs){
  const r=pairs.filter(p=>isFinite(p[0]) && isFinite(p[1])).map(p=>p[0]-p[1]), n=r.length;
  if(!n) return {n:0,bias:NaN,rms:NaN,sd:NaN};
  const bias=r.reduce((a,b)=>a+b,0)/n, rms=Math.sqrt(r.reduce((a,b)=>a+b*b,0)/n), sd=Math.sqrt(r.reduce((a,b)=>a+(b-bias)*(b-bias),0)/n);
  return {n,bias,rms,sd};
}
// уровень в точке: ERP (Вт) → дБм у приёмника: EIRP = ERP + 2.15 дБ (диполь → изотроп), потери, усиление приёмной антенны
const cvRx=(erpW,gainRel,loss,rxGain)=>10*Math.log10(Math.max(1e-12,erpW)*1000)+2.15+gainRel-loss+rxGain;
