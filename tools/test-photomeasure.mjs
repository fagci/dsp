// Ядро Photo Measure / Clinometer: node tools/test-photomeasure.mjs
// Известные решения: гомография по прямоугольнику, измерение на «снимке» с перспективой, клинометр на дереве, строки для Site Plan.
import vm from 'node:vm'; import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Array,String,Number,Object});
vm.runInContext(fs.readFileSync(path.join(root,'modules/photomeasure-kernels.js'),'utf8')+';this.K={PM_REFS,pmHomography,pmApply,pmQuadOk,pmRect,pmDist,pmArea,pmLines,pmSigma,clinoElev,clinoHeight,clinoDist,clinoLine,pmScale2,pmWorld,pmLinesTrace,pmSigmaTrace,pmInv3,pmToWorld,pmUnderBounds,pmRectify};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b+' (±'+e+')');

// «камера»: плоскость → пиксели проективным преобразованием (известная матрица), потом обратно по 4 углам листа A4
const M=[900,120,300, -80,700,200, 0.0004,0.0002,1];
const proj=(u,v)=>{ const w=M[6]*u+M[7]*v+M[8]; return [(M[0]*u+M[1]*v+M[2])/w,(M[3]*u+M[4]*v+M[5])/w]; };
const sheet=[[.5,.9],[.797,.9],[.797,.69],[.5,.69]];             // лист A4 (297×210) где-то в плоскости, v вверх
const px=sheet.map(([u,v])=>proj(u,v));
const dst=K.pmRect(.297,.210);
const H=K.pmHomography(px,dst);
ok('homography found',!!H);
near('sheet corner → its own plane coordinates (TR)',K.pmApply(H,...px[1])[0],.297,1e-9);
// точка вне листа: два места на той же плоскости с известным расстоянием
const A=[.1,.1], B=[1.6,.8], pa=proj(...A), pb=proj(...B);
const a=K.pmApply(H,...pa), b=K.pmApply(H,...pb);
near('measured distance across the plane (true length of A–B, in the sheet frame)',K.pmDist(a,b),Math.hypot(1.5,.7),1e-6);
near('area of a 2×1 m rectangle',K.pmArea([[0,0],[2,0],[2,1],[0,1]]),2,1e-12);
ok('quad order: TL TR BR BL is accepted',K.pmQuadOk(px));
ok('quad order: crossed corners are rejected',!K.pmQuadOk([px[0],px[2],px[1],px[3]]));
ok('degenerate (3 collinear corners) is rejected, not NaN',K.pmHomography([[0,0],[1,1],[2,2],[3,3]],dst)===null);
near('A4 presets: 297×210',K.PM_REFS['A4 (297×210)'][0]*K.PM_REFS['A4 (297×210)'][1],.297*.210,1e-12);
// строки для Site Plan
const t=K.pmLines([[0,0],[3,0],[3,4]],['P1','P2','P3'],'ground',true).split('\n');
ok('ground: three pair distances with errors and a contour',t.length===4 && t[2].startsWith('P2-P3 4 ±') && t[3]==='poly P1 P2 P3',t.join('|'));
const w=K.pmLines([[0,0],[0,2.5]],['W1','W2'],'wall',false).split('\n');
ok('wall: horizontal and height difference',w[0].startsWith('W1-W2 h 0 ±') && w[1].startsWith('W1-W2 dz 2.5 ±'),w.join('|'));
// клинометр
near('camera horizontal: 0°',K.clinoElev(0,9.81,0,false),0,1e-9);
near('camera pointing up 30°: back toward the sky means a_z = −g sin30',K.clinoElev(0,9.81*Math.cos(Math.PI/6),-9.81*Math.sin(Math.PI/6),false),30,1e-9);
near('camera pointing down: negative',K.clinoElev(0,9.81*Math.cos(Math.PI/6),9.81*Math.sin(Math.PI/6),false),-30,1e-9);
near('flip changes the sign',K.clinoElev(0,9,-4,true),-K.clinoElev(0,9,-4,false),1e-12);
ok('no gravity (free fall) → NaN',Number.isNaN(K.clinoElev(0,.1,0)));
// дерево 12 м с 20 м: низ −4.5° (глаза на 1.57 м), верх по формуле
const eye=1.6, d=20, top=Math.atan((12-eye)/d)*180/Math.PI, base=-Math.atan(eye/d)*180/Math.PI;
const r=K.clinoHeight(d,top,base);
near('tree height from two sightings, eye height not needed',r.height,12,1e-9);
near('eye height recovered',r.eye,1.6,1e-9);
near('distance from the eye height and the base sighting',K.clinoDist(1.6,base),20,1e-9);
ok('site plan line',K.clinoLine('E','R',top,20,1.6)==='E-R tilt '+(+top.toFixed(2))+' 20 eye 1.6',K.clinoLine('E','R',top,20,1.6));
// подложка: масштаб по двум точкам, север
{ const Hs=K.pmScale2([100,400],[300,400],10);                 // 200 px = 10 m → 0.05 m/px
  const a=K.pmApply(Hs,100,400), b=K.pmApply(Hs,300,400), c=K.pmApply(Hs,100,200);
  near('scale2: the first point is the origin',Math.hypot(...a),0,1e-12); near('scale2: 200 px = 10 m',K.pmDist(a,b),10,1e-12);
  near('scale2: up on the image is +v (200 px up = 10 m)',c[1],10,1e-12); ok('scale2: degenerate input → null',K.pmScale2([1,1],[1,1],5)===null && K.pmScale2([0,0],[1,0],0)===null);
  const w0=K.pmWorld([0,10],0), w90=K.pmWorld([0,10],90);
  near('north up: the image-up vector points north',w0[1],10,1e-12);
  near('image up = east (up bearing 90): v goes east',w90[0],10,1e-9); near('…and u (image right) goes south',K.pmWorld([10,0],90)[1],-10,1e-9);
  const t=K.pmLinesTrace([[0,0],[30,0],[30,18]],['P1','P2','P3'],0,true).split('\n');
  ok('trace lines: at x y ± σ and a contour',t.length===4 && t[1].startsWith('P2 at 30 0 ±') && t[3]==='poly P1 P2 P3',t.join('|'));
  ok('trace error grows with the plan size',K.pmSigmaTrace([[0,0],[200,0]])>K.pmSigmaTrace([[0,0],[20,0]])); }
// подложка: ректификация
{ // «снимок» 100×100 px, пол 4×4 м: масштаб 25 px/м (подобие), клетки по метру: чётность (floor(x)+floor(y)) → белый/чёрный
  const sw=100, sh=100, src=new Uint8ClampedArray(sw*sh*4); for(let y=0;y<sh;y++) for(let x=0;x<sw;x++){ const wx=x/25, wy=(sh-y)/25, c=((Math.floor(wx)+Math.floor(wy))%2===0) ? 255 : 0, o=(y*sw+x)*4; src[o]=c; src[o+1]=c; src[o+2]=c; src[o+3]=255; }
  const H=K.pmScale2([0,sh],[sw,sh],4);                                  // нижний левый угол — начало, 100 px = 4 м
  const inv=K.pmInv3(H); near('inverse: H⁻¹·H = identity on a point',K.pmApply(inv,...K.pmApply(H,30,60))[0],30,1e-9);
  const b=K.pmUnderBounds(H,0,sw,sh); near('bounds: 4 × 4 m from the origin',b.x1-b.x0,4,1e-9); near('…its lower left corner is the origin',b.y0,0,1e-9);
  const R=K.pmRectify(src,sw,sh,H,0,b,25); ok('rectified size: 100×100 px at 25 px/m',R.w===100 && R.h===100 && Math.abs(R.res-25)<1e-9,JSON.stringify([R.w,R.h,R.res]));
  const px=(x,y)=>R.data[((Math.floor((R.y1-y)*R.res))*R.w+Math.floor((x-R.x0)*R.res))*4];                  // цвет в мировой точке
  ok('a world point (0.5, 0.5) is on a white cell, (1.5, 0.5) on a black one (the checkerboard comes through unchanged)',px(.5,.5)===255 && px(1.5,.5)===0 && px(1.5,1.5)===255);
  // поворот: «верх» картинки смотрит на восток (up=90) — клетки поворачиваются, площадь та же
  const b2=K.pmUnderBounds(H,90,sw,sh); near('rotated by 90°: still 4 × 4 m',b2.x1-b2.x0,4,1e-9);
  const R2=K.pmRectify(src,sw,sh,H,90,b2,25); const op=(x,y)=>R2.data[((Math.floor((R2.y1-y)*R2.res))*R2.w+Math.floor((x-R2.x0)*R2.res))*4+3];
  ok('rotated by 90°: the rectified square is fully covered (every pixel opaque), and the colours are the same checkerboard turned',(()=>{ let n=0; for(let i=3;i<R2.data.length;i+=4) if(R2.data[i]===255) n++; return n===R2.w*R2.h; })() && op((b2.x0+b2.x1)/2,(b2.y0+b2.y1)/2)===255);
  ok('a degenerate H gives no rectification',K.pmInv3([1,2,3,2,4,6,0,0,0])===null);
  ok('a huge area is refused (the horizon in the frame)',K.pmUnderBounds([1,0,0,0,1,0,0,.0001,1],0,2000,1500,80)===null); }
console.log(bad?('\n'+bad+' FAILED'):'\nall ok'); process.exit(bad?1:0);
