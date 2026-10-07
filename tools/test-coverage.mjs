// Ядро Coverage: node tools/test-coverage.mjs
// Известные решения: дальнее поле двухлучевой модели, нож (ν = 0 → 6 дБ), лепесток, контур круга.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,Uint8Array,Infinity,isFinite,Number,Map});
vm.runInContext(fs.readFileSync(path.join(root,'modules/paths-kernels.js'),'utf8')+fs.readFileSync(path.join(root,'modules/coverage-kernels.js'),'utf8')+
  ';this.K={cvDeygout,cvTwoRay,cvTxGain,cvPathLoss,cvGrid,cvContour,cvStats,cvResid,cvRx,ppDirect,ppFspl};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b+' (±'+e+')');

// двухлучевая модель
near('two-ray, far field: 40 log d law (30 m mast, 2 m antenna, 20 km, 100 MHz)',K.cvTwoRay(20000,30,2,1e8),-20*Math.log10(4*Math.PI*30*2/(3*20000)),.5);
near('two-ray: doubling the distance in the far field = +6 dB on top of free space (12 dB in all)',K.cvTwoRay(40000,30,2,1e8)-K.cvTwoRay(20000,30,2,1e8),6.02,.1);
ok('two-ray: a lobe maximum is +6 dB (negative loss), nulls are deep and capped at 60 dB',(()=>{ let lo=1e9, hi=-1e9; for(let d=20;d<3000;d+=.25){ const v=K.cvTwoRay(d,30,2,1e9); lo=Math.min(lo,v); hi=Math.max(hi,v); } return lo<-5.9 && lo>-6.05 && hi>30 && hi<=60; })());
ok('two-ray: higher antennas have more lobes',(()=>{ const nulls=h1=>{ let c=0, prev=K.cvTwoRay(20,h1,2,1e9); for(let d=20.2;d<3000;d+=.2){ const v=K.cvTwoRay(d,h1,2,1e9); if(prev<10 && v>=10) c++; prev=v; } return c; }; return nulls(60)>nulls(15) && nulls(15)>=5; })());
// направленность
near('pattern: on the axis',K.cvTxGain(90,90,60),0,1e-9); near('pattern: −3 dB at half the beamwidth',K.cvTxGain(120,90,60),-3,1e-9);
near('pattern: the back lobe is capped at −25 dB',K.cvTxGain(270,90,60),-25,1e-9); ok('pattern: no direction or beamwidth → omni',K.cvTxGain(10,NaN,60)===0 && K.cvTxGain(10,90,0)===0 && K.cvTxGain(10,90,360)===0);
near('pattern: wraps around north',K.cvTxGain(350,10,60),K.cvTxGain(30,10,60),1e-9);
// дифракция по Дейгауту
const d=Array.from({length:101},(_,i)=>i*100), lam=3, flat=new Float32Array(101).fill(0);
ok('Deygout: clear path → 0',K.cvDeygout(d,flat,100,100,lam)===0);
const one=new Float32Array(101).fill(0); one[50]=100;
near('Deygout: one edge exactly on the line → 6 dB',K.cvDeygout(d,one,100,100,lam),6.03,.1);
const high=new Float32Array(101).fill(0); high[50]=300;
ok('Deygout: a higher edge costs more',K.cvDeygout(d,high,100,100,lam)>K.cvDeygout(d,one,100,100,lam)+10);
const two=new Float32Array(101).fill(0); two[50]=300; two[25]=250;
ok('Deygout: a second obstacle adds to the loss',K.cvDeygout(d,two,100,100,lam)>K.cvDeygout(d,high,100,100,lam));
ok('Deygout: the obstacle below the line is ignored',K.cvDeygout(d,(()=>{ const a=new Float32Array(101).fill(0); a[50]=-50; return a; })(),100,100,lam)===0);
// путь: свободный и через хребет
const T0=()=>0, o={f:1e8,k:4/3,step:100,gref:0,twoRay:false,clutter:0};
const p0=K.cvPathLoss(T0,[0,0,30],[5000,0,2],o);
ok('open path: line of sight, loss = free space',p0.los && p0.diff===0 && Math.abs(p0.loss-K.ppFspl(Math.hypot(5000,28),1e8))<.01);
const ridge=(x,y)=>x>2400 && x<2600 ? 200 : 0, p1=K.cvPathLoss(ridge,[0,0,30],[5000,0,2],o);
ok('a ridge: no line of sight, diffraction loss added',!p1.los && p1.diff>10 && p1.loss>p1.fspl+10,JSON.stringify(p1));
near('one ridge: the same as the single knife edge of Signal Paths',p1.diff,K.ppDirect(ridge,[0,0,30],[5000,0,2],4/3,1e8).diff,2.5);
ok('clutter margin is added',Math.abs(K.cvPathLoss(T0,[0,0,30],[5000,0,2],{...o,clutter:7}).loss-p0.loss-7)<1e-9);
ok('two-ray changes the level only on line of sight',K.cvPathLoss(T0,[0,0,30],[5000,0,2],{...o,twoRay:true}).two!==0 && K.cvPathLoss(ridge,[0,0,30],[5000,0,2],{...o,twoRay:true}).two===0);
ok('a point at the transmitter does not break',K.cvPathLoss(T0,[0,0,30],[0,0,30],o).loss===0);
ok('missing terrain data is taken as the reference ground',isFinite(K.cvPathLoss(()=>NaN,[0,0,30],[5000,0,2],o).loss));
// сетка и контур
const g=K.cvGrid(20000,250); ok('grid: 160 × 160 cells of 250 m',g.nx===160 && g.ny===160 && Math.abs(g.cell-250)<1e-9 && g.cx(0)===-19875 && g.cy(159)===19875);
ok('grid: a coarse cell keeps the area',(()=>{ const q=K.cvGrid(10000,3000); return Math.abs(q.nx*q.cell-20000)<1e-6; })());
const N=60, v=new Float32Array(N*N); for(let j=0;j<N;j++) for(let i=0;i<N;i++) v[j*N+i]=Math.hypot(i-30,j-30);
const cl=K.cvContour(v,N,N,10.3);
ok('contour: one closed line',cl.length===1 && cl[0].length>40 && Math.hypot(cl[0][0][0]-cl[0][cl[0].length-1][0],cl[0][0][1]-cl[0][cl[0].length-1][1])<1e-6,cl.length+' lines');
ok('contour: every point at the radius',cl[0].every(p=>Math.abs(Math.hypot(p[0]-30,p[1]-30)-10.3)<.35));
ok('contour: nothing at a level outside the data',K.cvContour(v,N,N,500).length===0 && K.cvContour(v,N,N,-5).length===0);
ok('contour: NaN cells are skipped',(()=>{ const w=v.slice(); for(let i=0;i<500;i++) w[i]=NaN; return K.cvContour(w,N,N,10).length>=1; })());
// сводка и невязки
const st=K.cvStats(new Float32Array([-90,-100,-110,NaN,-80]),100,-95);
ok('stats: half the cells are dead',st.n===4 && st.dead===.5 && Math.abs(st.dead_km2-.02)<1e-12 && Math.abs(st.area_km2-.04)<1e-12 && st.max===-80);
const rs=K.cvResid([[-80,-85],[-70,-76],[-90,-90],[NaN,-5]]);
ok('residuals: bias and rms',rs.n===3 && Math.abs(rs.bias-11/3)<1e-9 && Math.abs(rs.rms-Math.sqrt((25+36+0)/3))<1e-9);
ok('residuals: nothing → NaN',K.cvResid([]).n===0 && Number.isNaN(K.cvResid([]).bias));
near('received level: 1 kW ERP at 100 dB loss, 2 dBi antenna',K.cvRx(1000,0,100,2),60+2.15-100+2,1e-9); near('received level: pattern −3 dB',K.cvRx(1,-3,100,0),30+2.15-3-100,1e-9);
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad?1:0);
