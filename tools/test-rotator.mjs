// Ядро поворотника: node tools/test-rotator.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Number,Array,String,Object,parseFloat,JSON});
vm.runInContext(fs.readFileSync(path.join(root,'modules/rotator-kernels.js'),'utf8')+';this.K={rtNorm,rtDelta,rtPick,rtClampEl,RT_PROTO,rtScanPlan,rtScanInit,rtScanAdd,rtScanBest,rtSim,rtDial,rtDialPoint,rtDialXY,rtSimBeam};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(a,b,e=1e-6)=>Math.abs(a-b)<e, J=x=>JSON.stringify(x);

ok('norm',K.rtNorm(-10)===350 && K.rtNorm(370)===10 && K.rtNorm(360)===0);
ok('delta shortest',K.rtDelta(350,10)===20 && K.rtDelta(10,350)===-20 && Math.abs(K.rtDelta(0,180))===180);
// пределы
ok('pick 0..360: 350 from 10 → 350 (no overlap)',K.rtPick(350,10,0,360)===350);
ok('pick 0..450: 10 from 400 → 370 (via overlap)',K.rtPick(10,400,0,450)===370,K.rtPick(10,400,0,450));
ok('pick 0..450: 10 from 20 → 10',K.rtPick(10,20,0,450)===10);
ok('pick 0..450: 100 from 440 → 460? no, 100',K.rtPick(100,440,0,450)===100);
ok('pick −180..180: 190 → −170',K.rtPick(190,0,-180,180)===-170,K.rtPick(190,0,-180,180));
ok('pick limited 90..270: 10 → nearest edge 90',K.rtPick(10,180,90,270)===90);
ok('pick limited 90..270: 300 → 270',K.rtPick(300,180,90,270)===270);
ok('el clamp',K.rtClampEl(95,0,90)===90 && K.rtClampEl(-3,0,90)===0);

// протоколы
const R=K.RT_PROTO;
ok('rotctld set',R.rotctld.set(123.456,45)==='P 123.46 45.00\n',R.rotctld.set(123.456,45));
ok('rotctld parse',J(R.rotctld.parse(['123.40','10.00']))==='{"az":123.4,"el":10}');
ok('rotctld parse garbage',R.rotctld.parse(['foo'])===null);
ok('gs232 set az+el',R['GS-232'].set(5.4,7.6,true)==='W005 008\r',R['GS-232'].set(5.4,7.6,true));
ok('gs232 set az only',R['GS-232'].set(359.6,0,false)==='M360\r');
ok('gs232 parse B',J(R['GS-232'].parse(['+0123+0045']))==='{"az":123,"el":45}');
ok('gs232 parse AZ=',J(R['GS-232'].parse(['AZ=123 EL=045']))==='{"az":123,"el":45}');
ok('gs232 parse A (az only)',J(R['GS-232'].parse(['+0270']))==='{"az":270,"el":0}',J(R['GS-232'].parse(['+0270'])));
ok('easycomm set',R['EasyComm II'].set(12.34,5)==='AZ12.3 EL5.0\n');
ok('easycomm parse',J(R['EasyComm II'].parse(['AZ123.4 EL45.6']))==='{"az":123.4,"el":45.6}');

// скан
ok('plan full circle',J(K.rtScanPlan(0,360,90))==='[0,90,180,270]',J(K.rtScanPlan(0,360,90)));
ok('plan wraps north',J(K.rtScanPlan(300,120,60))==='[300,0,60]',J(K.rtScanPlan(300,120,60)));
ok('plan step ≥1',K.rtScanPlan(0,10,0).length===11);
const bins=K.rtScanInit([0,10,20,30,40]);
[[0,-30],[10,-20],[20,-10],[30,-14],[40,-40]].forEach(([i,l],k)=>{ K.rtScanAdd(bins[k],l); K.rtScanAdd(bins[k],l+2); });
const b=K.rtScanBest(bins);
ok('best bin',b.az===20 && near(b.lvl,-9),J(b));
const bc=K.rtScanBest(bins,true);
ok('centroid between 20 and 30, nearer 20',bc.az>20 && bc.az<25,J(bc));
K.rtScanAdd(bins[0],NaN); ok('NaN ignored',bins[0].n===2);
ok('best of empty is null',K.rtScanBest(K.rtScanInit([0,10]))===null);
// центроид через 0°
const wb=K.rtScanInit([350,0,10]); wb.forEach(x=>K.rtScanAdd(x,-10));
ok('centroid wraps through north',(()=>{ const c=K.rtScanBest(wb,true); return Math.abs(K.rtDelta(0,c.az))<1e-6 || c.az===350; })());

// виртуальный поворотник
const sim=K.rtSim({rate:10});
ok('sim reports',sim.respond('p\n')==='0.00\n0.00\n');
ok('sim set',sim.respond('P 90.0 30.0\n')==='RPRT 0\n' && sim.moving());
sim.step(2); ok('sim slews at rate',near(sim.az,20) && near(sim.el,20),sim.az);
sim.step(10); ok('sim arrives',near(sim.az,90) && near(sim.el,30) && !sim.moving());
sim.respond('P 0 0\n'); sim.step(1); sim.respond('S\n'); sim.step(5); ok('sim stop',near(sim.az,80),sim.az);
ok('sim park',(sim.respond('K\n'),sim.tAz===0));
ok('sim bad',sim.respond('P x y\n')==='RPRT -1\n' && sim.respond('Z\n')==='RPRT -11\n');

// компас
const d=K.rtDial(200,200);
ok('dial centre',d.cx===100 && d.cy===100 && d.r>0);
const n=K.rtDialPoint(d,100,100-d.r); ok('north rim → az 0 el 0',near(n.az,0,1e-9) && near(n.el,0,1e-9),J(n));
const e=K.rtDialPoint(d,100+d.r/2,100); ok('east half-radius → az 90 el 45',near(e.az,90,1e-9) && near(e.el,45,1e-9),J(e));
const c0=K.rtDialPoint(d,100,100); ok('centre → el 90',near(c0.el,90));
const out=K.rtDialPoint(d,1000,100); ok('far outside → el 0',out.el===0 && near(out.az,90,1e-9));
const xy=K.rtDialXY(d,180,45,true); const back=K.rtDialPoint(d,xy.x,xy.y); ok('xy roundtrip',near(back.az,180,1e-6) && near(back.el,45,1e-6),J(back));
ok('xy rim when el unused',near(K.rtDialXY(d,90,45,false).x,100+d.r));
// маяк в симуляторе
ok('beam peak 22 dB at the beacon',near(K.rtSimBeam(217,217,22,0,.5),22),K.rtSimBeam(217,217,22,0,.5));
ok('beam falls off the side',K.rtSimBeam(217+44,217,22,0,.5)<K.rtSimBeam(217+22,217,22,0,.5) && K.rtSimBeam(37,217,22,0,.5)<-5.9);
ok('beam wraps through north',near(K.rtSimBeam(350,10,22,0,.5),K.rtSimBeam(10,350,22,0,.5)));
ok('beam noise is bounded',Math.abs(K.rtSimBeam(0,0,22,1,0)-K.rtSimBeam(0,0,22,1,1))<=1+1e-9);
console.log(bad?bad+' FAILED':'all passed'); process.exit(bad?1:0);
