// Image on Map, ядро: node tools/test-geoimage.mjs
// Известные решения: подобие по двум точкам (поворот, масштаб), аффинное по трём и больше, невязки, разбор точек, перепроекция
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float64Array,Uint8ClampedArray,Array,Object,Number,String,isFinite});
vm.runInContext(fs.readFileSync(path.join(root,'modules/geoimage-kernels.js'),'utf8')+';this.K={giFit,giParse,giWarp,giFrame}',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b+' (±'+e+')');

// 1. снимок север-вверх, 0,5 м на пиксель: две точки по диагонали
{ const T=K.giFit([{u:0,v:0,X:100,Y:200},{u:100,v:200,X:150,Y:100}]);
  ok('similarity from 2 points',T && T.similar && T.n===2);
  near('scale 0.5 m/px',T.mpp,.5,1e-9); near('rotation 0°',T.rot,0,1e-9); near('rms 0',T.rms,0,1e-9);
  const q=T.fwd(50,100); near('centre X',q[0],125,1e-9); near('centre Y',q[1],150,1e-9);
  const b=T.inv(125,150); near('inverse u',b[0],50,1e-9); near('inverse v',b[1],100,1e-9); }
// 2. повёрнутый снимок: верх картинки смотрит на восток (поворот 90° по часовой): u → юг, v → запад
{ const th=Math.PI/2, c=Math.cos(th)*2, d=Math.sin(th)*2;              // 2 м на пиксель
  const f=(u,v)=>[c*u+d*v+10,d*u-c*v+20];
  const P=[[0,0],[30,0],[0,40]].map(([u,v])=>{ const q=f(u,v); return {u,v,X:q[0],Y:q[1]}; });
  const T2=K.giFit(P.slice(0,2)); near('2 points: scale 2 m/px',T2.mpp,2,1e-9); near('2 points: rotation 90°',Math.abs(T2.rot),90,1e-9);
  const T3=K.giFit(P); ok('3 points → affine',T3 && !T3.similar); near('affine rms 0',T3.rms,0,1e-9);
  const r=T3.fwd(10,10), e=f(10,10); near('affine reproduces a free point',Math.hypot(r[0]-e[0],r[1]-e[1]),0,1e-9); }
// 3. невязки: четыре точки, одна сдвинута на 1 м
{ const P=[[0,0,0,0],[100,0,100,0],[100,100,100,-100],[0,100,0,-101]].map(([u,v,X,Y])=>({u,v,X,Y}));
  const T=K.giFit(P,'similar'); ok('similarity with 4 points',T && T.similar && T.n===4);
  ok('rms shows the outlier (≈0.35…0.6 m)',T.rms>.2 && T.rms<.8,T.rms); ok('residuals are per point',T.resid.length===4); }
// 4. одна точка и совпадающие точки — нельзя
ok('one point is not enough',K.giFit([{u:0,v:0,X:0,Y:0}])===null);
ok('two equal pixels → no fit',K.giFit([{u:5,v:5,X:0,Y:0},{u:5,v:5,X:10,Y:10}])===null);
// 5. разбор строк
{ const R=K.giParse('# comment\n120 340 A\n800,5 90,5 B\n10 20 50.27 85.59\nbad line\n1 2 3 4 5');
  ok('parse: name, decimal comma, lat lon',R.pts.length===3 && R.pts[0].name==='A' && R.pts[1].u===800.5 && R.pts[1].v===90.5 && R.pts[1].name==='B' && R.pts[2].lat===50.27,JSON.stringify(R.pts));
  ok('parse: two bad lines reported',R.errors.length===2 && R.errors[0].line===5,JSON.stringify(R.errors)); }
// 6. перепроекция: снимок 4×2, красный левый / синий правый пиксели, север-вверх, 10 м на пиксель
{ const F=K.giFrame(50,85), sw=4, sh=2, d=new Uint8ClampedArray(sw*sh*4);
  for(let y=0;y<sh;y++) for(let x=0;x<sw;x++){ const o=(y*sw+x)*4; d[o]=x<2 ? 255 : 0; d[o+2]=x<2 ? 0 : 255; d[o+3]=255; }
  const a=F.inv(0,0), b=F.inv(40,0), T=K.giFit([{u:0,v:2,X:0,Y:0},{u:4,v:2,X:40,Y:0}]);
  const W=K.giWarp(d,sw,sh,sw,sh,T,F,64);
  ok('warp: bounds from the image corners',W && W.north>W.south && W.east>W.west,JSON.stringify(W && [W.north,W.south,W.east,W.west]));
  near('warp: width in metres ≈ 40',(W.east-W.west)*Math.cos(50*Math.PI/180)*111194.9,40,.05); near('warp: height in metres ≈ 20',(W.north-W.south)*111194.9,20,.05);
  const mid=(Math.floor(W.h/2)*W.w);
  ok('warp: left pixels red, right blue',W.data[(mid+1)*4]>200 && W.data[(mid+W.w-2)*4+2]>200,[W.data[(mid+1)*4],W.data[(mid+W.w-2)*4+2]].join());
  ok('warp: all opaque inside',W.data[(mid+3)*4+3]===255);
  void a; void b; }
// 7. снимок повёрнут на 45° — углы результата пустые (прозрачные)
{ const F=K.giFrame(50,85), sw=8, sh=8, d=new Uint8ClampedArray(sw*sh*4).fill(255);
  const s=Math.SQRT1_2, T=K.giFit([{u:0,v:0,X:0,Y:0},{u:8,v:0,X:8*s,Y:8*s}]);
  const W=K.giWarp(d,sw,sh,sw,sh,T,F,64); ok('rotated image: the corner of the grid is transparent, the centre opaque',W.data[3]===0 && W.data[(Math.floor(W.h/2)*W.w+Math.floor(W.w/2))*4+3]===255); }
console.log(bad?('\n'+bad+' FAILED'):'\nall ok'); process.exit(bad?1:0);
