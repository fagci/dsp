// Ядро Signal Paths: node tools/test-paths.mjs
// Известные решения: потери в свободном пространстве, нож (ν = 0 → 6 дБ), зеркальные отражения от плоскости и ровной земли.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,Infinity,isFinite,Number});
vm.runInContext(fs.readFileSync(path.join(root,'modules/paths-kernels.js'),'utf8')+
  ';this.K={ppFrame,ppDist,ppFspl,ppKnife,ppProfile,ppNormal,ppMiss,ppAng,ppReflections,ppDirect};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b+' (±'+e+')');

// проекция
const F=K.ppFrame(55,82), q=F.fwd(55.01,82.02), r=F.inv(q[0],q[1]);
near('frame: round trip lat',r[0],55.01,1e-9); near('frame: round trip lon',r[1],82.02,1e-9); near('frame: 0.01° of latitude = 1112 m',q[1],1111.95,1);
// потери
near('FSPL: 1 km at 100 MHz',K.ppFspl(1000,100e6),72.4,.1); near('FSPL: +6 dB for double the distance',K.ppFspl(2000,1e8)-K.ppFspl(1000,1e8),6.02,.01);
near('knife edge: nu = 0 → 6 dB',K.ppKnife(0),6.03,.05); near('knife edge: nu = 1 → 13.9 dB',K.ppKnife(1),13.9,.1); ok('knife edge: a clear path → 0',K.ppKnife(-1)===0 && K.ppKnife(-3)===0);
ok('knife edge grows with the obstacle',K.ppKnife(2)>K.ppKnife(1) && K.ppKnife(1)>K.ppKnife(0));
// нормаль
const nn=K.ppNormal((x,y)=>Math.max(0,x),400,0,5);
near('normal of a 45° slope',nn[0],-Math.SQRT1_2,1e-6); near('normal of a 45° slope (z)',nn[2],Math.SQRT1_2,1e-6);
ok('normal without data → null',K.ppNormal((x,y)=>NaN,0,0,5)===null);
// промах отражения: ровная земля, середина — ноль; в стороне — больше; точка над обоими — вне
const flat=()=>0, A=[0,0,10], B=[4000,0,10];
near('miss at the midpoint of flat ground',K.ppMiss([2000,0,0],[0,0,1],A,B),0,1e-6);
near('miss grows away from the midpoint (500 m: the ray passes B 60 m too high)',K.ppMiss([500,0,0],[0,0,1],A,B),60,.1);
near('a 10 m sideways shift of the point = a 20 m miss at 4 km',K.ppMiss([2000,10,0],[0,0,1],A,B),20,1);
near('angle at the midpoint of flat ground is zero',K.ppAng([2000,0,0],[0,0,1],A,B),0,1e-6);
ok('angle is very sensitive at grazing rays: 10 m sideways = 45°',Math.abs(K.ppAng([2000,10,0],[0,0,1],A,B)-45)<1);
ok('miss: a point above the ends is not a reflection',K.ppMiss([2000,0,100],[0,0,1],A,B)===Infinity);

// прямой путь над ровной землёй: LOS, зона Френеля частично закрыта
const d0=K.ppDirect(flat,A,B,4/3,100e6);
ok('flat ground: line of sight, no diffraction',d0.los && d0.diff===0 && d0.clear>9 && d0.clear<10,JSON.stringify([d0.los,d0.diff,d0.clear]));
near('flat ground: loss = free space',d0.loss,K.ppFspl(4000.0005,100e6),.01);
near('flat ground: first Fresnel zone at the middle (r1 = 54.8 m)',d0.fres,(10-4e6/(2*6371008.8*4/3))/54.77,.01);
// холм посередине закрывает путь
const hill=(x,y)=>200*Math.exp(-((x-2000)**2+y*y)/(2*300*300));
const d1=K.ppDirect(hill,A,B,4/3,100e6);
ok('a hill in the middle: no line of sight, diffraction loss',!d1.los && d1.diff>10 && d1.loss>d1.fspl+10 && d1.clear<-150,JSON.stringify([d1.los,d1.diff,d1.clear]));
ok('a hill beside the path does not block',K.ppDirect((x,y)=>200*Math.exp(-((x-2000)**2+(y-3000)**2)/(2*300*300)),A,B,4/3,100e6).los);
// без кривизны / с ней: на 40 км над ровной землёй низкие антенны не видят друг друга
const far=K.ppDirect(flat,[0,0,5],[40000,0,5],4/3,100e6);
ok('40 km between 5 m antennas: the Earth is in the way',!far.los && far.diff>0,JSON.stringify([far.los,far.diff,far.clear]));

// отражение от ровной земли: одна точка в середине, длина по зеркалу
const R0=K.ppReflections(flat,A,B,{k:4/3,f:100e6,step:25,tolM:30,maxRatio:2,maxn:6,reflDb:8});
ok('flat ground: one ground reflection',R0.length===1,R0.length);
near('ground reflection: x = middle',R0[0].P[0],2000,25); near('ground reflection: y = axis',R0[0].P[1],0,30); near('ground reflection: z = ground',R0[0].P[2],0,1e-9);
near('ground reflection: path = mirror length',R0[0].len,Math.hypot(4000,20),.2); near('ground reflection: excess over the direct path',R0[0].excess,Math.hypot(4000,20)-4000,.2);
near('ground reflection: loss = free space + reflection',R0[0].loss,K.ppFspl(R0[0].len,100e6)+8,1e-9);
// отражение от склона 45°: точка по методу зеркала
const ramp=(x,y)=>Math.max(0,x), A2=[300,0,500], B2=[300,400,500];
const R1=K.ppReflections(ramp,A2,B2,{k:4/3,f:100e6,step:10,tolM:30,maxRatio:2,maxn:6,reflDb:8});
ok('a 45° slope: a reflection is found',R1.length>=1,R1.length);
const pr=R1.find(p=>Math.abs(p.P[0]-400)<25 && Math.abs(p.P[1]-200)<25);
ok('a 45° slope: the point is where the mirror image says (400, 200, 400)',!!pr,JSON.stringify(R1.map(p=>p.P.map(Math.round))));
if(pr){ near('slope reflection: z on the surface',pr.P[2],ramp(pr.P[0],pr.P[1]),1e-9); near('slope reflection: path length = distance to the mirror image',pr.len,Math.hypot(200,400,200),3); }
// препятствие на пути отражённого луча — отражение не засчитывается
const wall=(x,y)=>Math.max(0,x)+(Math.abs(y-100)<20 && x>300 ? 600 : 0);
const R2=K.ppReflections(wall,A2,B2,{k:4/3,f:100e6,step:10,tolM:30,maxRatio:2,maxn:6,reflDb:8});
ok('a wall across the reflected ray: the path is rejected',!R2.some(p=>Math.abs(p.P[0]-400)<25 && Math.abs(p.P[1]-200)<25),JSON.stringify(R2.map(p=>p.P.map(Math.round))));
// порядок: меньше потерь — раньше; не больше maxn
const R3=K.ppReflections((x,y)=>Math.max(0,x),A2,B2,{k:4/3,f:100e6,step:10,tolM:60,maxRatio:3,maxn:2,reflDb:8});
ok('results are sorted by loss and capped',R3.length<=2 && (R3.length<2 || R3[0].loss<=R3[1].loss));
ok('no terrain data → no paths and no crash',K.ppReflections(()=>NaN,A,B,{k:4/3,f:1e8,step:100,tolM:30,maxRatio:2,maxn:6,reflDb:8}).length===0);
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad?1:0);
