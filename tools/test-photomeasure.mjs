// Ядро Photo Measure / Clinometer: node tools/test-photomeasure.mjs
// Известные решения: гомография по прямоугольнику, измерение на «снимке» с перспективой, клинометр на дереве, строки для Site Plan.
import vm from 'node:vm'; import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Array,String,Number,Object});
vm.runInContext(fs.readFileSync(path.join(root,'modules/photomeasure-kernels.js'),'utf8')+';this.K={PM_REFS,pmHomography,pmApply,pmQuadOk,pmRect,pmDist,pmArea,pmLines,pmSigma,clinoElev,clinoHeight,clinoDist,clinoLine};',ctx);
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
console.log(bad?('\n'+bad+' FAILED'):'\nall ok'); process.exit(bad?1:0);
