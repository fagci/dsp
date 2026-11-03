"use strict";
/* ============================ Photo Measure / Clinometer: ядро ============================
   Замеры по снимку: известный прямоугольник (лист A4, карта, свой размер) на плоскости задаёт гомографию «пиксели → метры»,
   дальше любые точки на той же плоскости измеряются кликами (пол, земля, стена, фасад — вид сбоку). Точность ≈ 1–2 % от размера эталона
   (искажение объектива не учитывается; эталон — не меньше ~1/10 кадра и в той же плоскости, что измеряемое).
   Клинометр: угол места оси камеры по акселерометру; высота = d·(tg α_верх − tg α_низ) с расстояния d без знания высоты глаза.
   Выход — строки для Site Plan. Ядро чистое, без DOM: node tools/test-photomeasure.mjs */

// эталоны, м (ширина × высота; клики по углам: верхний левый, верхний правый, нижний правый, нижний левый)
const PM_REFS={'A4 (297×210)':[.297,.210],'A4 portrait':[.210,.297],'A5 (210×148)':[.210,.148],'Letter (279×216)':[.2794,.2159],
  'Card (85.6×54)':[.0856,.05398],'Euro pallet (1.2×0.8 m)':[1.2,.8],'Brick 250×120':[.25,.12],'custom':null};

// решение A·x=b (Гаусс с выбором главного элемента); null — вырожденная система
function pmSolve(A,b,n){
  for(let i=0;i<n;i++){
    let m=i; for(let r=i+1;r<n;r++) if(Math.abs(A[r][i])>Math.abs(A[m][i])) m=r;
    if(Math.abs(A[m][i])<1e-12) return null;
    [A[i],A[m]]=[A[m],A[i]]; [b[i],b[m]]=[b[m],b[i]];
    for(let r=i+1;r<n;r++){ const f=A[r][i]/A[i][i]; for(let c=i;c<n;c++) A[r][c]-=f*A[i][c]; b[r]-=f*b[i]; }
  }
  const x=new Array(n).fill(0);
  for(let i=n-1;i>=0;i--){ let s=b[i]; for(let c=i+1;c<n;c++) s-=A[i][c]*x[c]; x[i]=s/A[i][i]; }
  return x;
}
// гомография H (3×3, h33=1) по четырём парам src→dst; src — пиксели, dst — метры на плоскости
function pmHomography(src,dst){
  const A=[], b=[];
  for(let i=0;i<4;i++){
    const [x,y]=src[i], [u,v]=dst[i];
    A.push([x,y,1,0,0,0,-u*x,-u*y]); b.push(u);
    A.push([0,0,0,x,y,1,-v*x,-v*y]); b.push(v);
  }
  const h=pmSolve(A,b,8); if(!h) return null;
  return [h[0],h[1],h[2],h[3],h[4],h[5],h[6],h[7],1];
}
function pmApply(H,x,y){ const w=H[6]*x+H[7]*y+H[8]; return [(H[0]*x+H[1]*y+H[2])/w,(H[3]*x+H[4]*y+H[5])/w]; }
// выпуклый четырёхугольник нужной ориентации: иначе гомография вывернута (клики не по порядку)
function pmQuadOk(q){
  let s=0; for(let i=0;i<4;i++){ const a=q[i], b=q[(i+1)%4], c=q[(i+2)%4]; const z=(b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]); if(i===0) s=Math.sign(z); else if(Math.sign(z)!==s || z===0) return false; }
  return true;
}
// прямоугольник по W×H: углы TL, TR, BR, BL в плоскости (u вправо, v вверх)
const pmRect=(w,h)=>[[0,h],[w,h],[w,0],[0,0]];
// погрешность расстояния, м: 1,5 % + 1 см (± клик на ~2 px при эталоне в 1/10 кадра)
const pmSigma=d=>Math.hypot(.015*d,.01);
function pmDist(a,b){ return Math.hypot(a[0]-b[0],a[1]-b[1]); }
// площадь многоугольника (формула шнурования), м²
function pmArea(P){ let s=0; for(let i=0;i<P.length;i++){ const a=P[i], b=P[(i+1)%P.length]; s+=a[0]*b[1]-b[0]*a[1]; } return Math.abs(s)/2; }
// строки для Site Plan по точкам в плоскости. mode 'ground' — расстояния между всеми парами; 'wall' — по каждой паре горизонталь и превышение
// (v вверх: верхний край эталона над нижним). names — имена точек; sigma — погрешность на длину; poly — добавить контур по порядку
function pmLines(P,names,mode,poly){
  const o=[], f=v=>String(+v.toFixed(3));
  for(let i=0;i<P.length;i++) for(let j=i+1;j<P.length;j++){
    const d=pmDist(P[i],P[j]), s=pmSigma(d), a=names[i], b=names[j];
    if(mode==='wall'){ o.push(a+'-'+b+' h '+f(Math.abs(P[j][0]-P[i][0]))+' ± '+f(s)); o.push(a+'-'+b+' dz '+f(P[j][1]-P[i][1])+' ± '+f(s)); }
    else o.push(a+'-'+b+' '+f(d)+' ± '+f(s));
  }
  if(poly && P.length>=3) o.push('poly '+names.join(' '));
  return o.join('\n');
}

// ---------- клинометр ----------
// угол места оси камеры (задняя камера смотрит вдоль −z устройства), ° — по вектору силы тяжести (акселерометр с гравитацией, Android: плашмя экраном вверх +g по z).
// flip — знак (iOS отдаёт обратный)
function clinoElev(ax,ay,az,flip){
  const g=Math.hypot(ax,ay,az); if(!(g>3)) return NaN;
  const s=Math.max(-1,Math.min(1,(flip ? az : -az)/g)); return Math.asin(s)*180/Math.PI;
}
// высота по двум прицеливаниям с расстояния d (по горизонтали): низ и верх объекта; eye — высота камеры из тех же данных
function clinoHeight(d,topDeg,baseDeg){
  const R=Math.PI/180, eye=-d*Math.tan(baseDeg*R), h=d*(Math.tan(topDeg*R)-Math.tan(baseDeg*R));
  return {height:h,eye};
}
// расстояние до основания по высоте глаза (прицел вниз на основание): d = eye / tg|α|
function clinoDist(eye,baseDeg){ const t=Math.tan(-baseDeg*Math.PI/180); return t>0 ? eye/t : NaN; }
// строка для Site Plan: из точки from в точку to
function clinoLine(from,to,topDeg,d,eye){ return from+'-'+to+' tilt '+(+topDeg.toFixed(2))+' '+(+d.toFixed(3))+' eye '+(+eye.toFixed(3)); }

// ---------- подложка (скан плана, снимок карты): масштаб по двум точкам ----------
// подобие «пиксели → метры»: s = dist / |p1p2|, начало — первая точка, v вверх (картинка перевёрнута по y), как у гомографии выше
function pmScale2(p1,p2,dist){
  const L=Math.hypot(p2[0]-p1[0],p2[1]-p1[1]); if(!(L>0) || !(dist>0)) return null;
  const s=dist/L; return [s,0,-s*p1[0], 0,-s,s*p1[1], 0,0,1];
}
// поворот из «картинка вверх» в стороны света: up — азимут направления «вверх по картинке», ° (0 — вверх на север). u вправо по картинке, v вверх → восток, север
function pmWorld(p,upDeg){ const b=upDeg*Math.PI/180; return [p[0]*Math.cos(b)+p[1]*Math.sin(b), -p[0]*Math.sin(b)+p[1]*Math.cos(b)]; }
// погрешность координат обводки, м: 0,5 % размера плана + 2 см (клик ≈ 1–2 px при масштабе в полкадра)
function pmSigmaTrace(P){
  let x0=1e99,x1=-1e99,y0=1e99,y1=-1e99; for(const q of P){ x0=Math.min(x0,q[0]); x1=Math.max(x1,q[0]); y0=Math.min(y0,q[1]); y1=Math.max(y1,q[1]); }
  return Math.hypot(.005*Math.hypot(x1-x0,y1-y0),.02);
}
// строки «P1 at x y ± σ» (x — восток, y — север) + poly
function pmLinesTrace(P,names,upDeg,poly){
  const f=v=>String(+v.toFixed(3)), s=pmSigmaTrace(P), o=[];
  P.forEach((q,i)=>{ const w=pmWorld(q,upDeg); o.push(names[i]+' at '+f(w[0])+' '+f(w[1])+' ± '+f(s)); });
  if(poly && P.length>=3) o.push('poly '+names.join(' '));
  return o.join('\n');
}

// ---------- подложка под Plan Editor: снимок → метры (ректификация) ----------
// Отображение пикселей снимка в мир: плоскость эталона (гомография H или масштаб скана), для скана — ещё поворот к сторонам света (up — азимут «верха» картинки)
function pmInv3(H){
  const [a,b,c,d,e,f,g,h,i]=H, A=e*i-f*h, B=-(d*i-f*g), C=d*h-e*g, det=a*A+b*B+c*C; if(Math.abs(det)<1e-18) return null;
  return [A/det,-(b*i-c*h)/det,(b*f-c*e)/det, B/det,(a*i-c*g)/det,-(a*f-c*d)/det, C/det,-(a*h-b*g)/det,(a*e-b*d)/det];
}
function pmToWorld(H,up,x,y){ const p=pmApply(H,x,y); return up ? pmWorld(p,up) : p; }
// рамка снимка в мире (по четырём углам и серединам сторон, чтобы поймать перспективу); null — вырожденный случай; span — предел размера, м
function pmUnderBounds(H,up,w,h,span=80){
  const pts=[[0,0],[w,0],[w,h],[0,h],[w/2,0],[w,h/2],[w/2,h],[0,h/2]].map(q=>pmToWorld(H,up,q[0],q[1]));
  if(pts.some(q=>!isFinite(q[0])||!isFinite(q[1]))) return null;
  let x0=1e99,x1=-1e99,y0=1e99,y1=-1e99; for(const q of pts){ x0=Math.min(x0,q[0]); x1=Math.max(x1,q[0]); y0=Math.min(y0,q[1]); y1=Math.max(y1,q[1]); }
  if(x1-x0>span||y1-y0>span||!(x1>x0)||!(y1>y0)) return null; return {x0,x1,y0,y1};
}
// ректификация: src — RGBA (Uint8ClampedArray, sw×sh); результат — RGBA ширины w, строка 0 — север; res — пикселей на метр (не больше maxPx по большей стороне)
function pmRectify(src,sw,sh,H,up,b,res,maxPx=1600){
  const inv=pmInv3(H); if(!inv) return null;
  const span=Math.max(b.x1-b.x0,b.y1-b.y0), r=Math.min(res,maxPx/span), w=Math.max(1,Math.ceil((b.x1-b.x0)*r)), h=Math.max(1,Math.ceil((b.y1-b.y0)*r)), out=new Uint8ClampedArray(w*h*4);
  for(let j=0;j<h;j++){
    const wy=b.y1-(j+.5)/r;
    for(let i=0;i<w;i++){
      const wx=b.x0+(i+.5)/r, p=up ? pmWorld([wx,wy],-up) : [wx,wy], den=inv[6]*p[0]+inv[7]*p[1]+inv[8]; if(Math.abs(den)<1e-12) continue;
      const px=(inv[0]*p[0]+inv[1]*p[1]+inv[2])/den, py=(inv[3]*p[0]+inv[4]*p[1]+inv[5])/den, ix=Math.floor(px), iy=Math.floor(py);
      if(ix<0||iy<0||ix>=sw||iy>=sh) continue;
      const o=(j*w+i)*4, s=(iy*sw+ix)*4; out[o]=src[s]; out[o+1]=src[s+1]; out[o+2]=src[s+2]; out[o+3]=src[s+3];
    }
  }
  return {data:out,w,h,res:r,x0:b.x0,y1:b.y1};
}
