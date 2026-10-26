// Ядро инструментов (единицы, линейка, высота, наклон, шаги, фонарик): node tools/test-tools.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Number,Array,String,Object,isFinite,JSON});
vm.runInContext(fs.readFileSync(path.join(root,'modules/tools-kernels.js'),'utf8')+';this.K={TL_UNITS,tlCats,tlUnits,tlConvert,tlFmt,tlRulerTicks,tlLenText,tlHeightDist,tlHeightEye,tlBaro,tlTilt,tlStepNew,tlStepPush,tlTorchOn,TL_SOS}',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(a,b,e=1e-6)=>Math.abs(a-b)<=e*Math.max(1,Math.abs(b));

// единицы
ok('km→mi',near(K.tlConvert('length','km','mi',10),6.213711922,1e-8));
ok('in→mm',near(K.tlConvert('length','in','mm',1),25.4));
ok('°C→°F',near(K.tlConvert('temperature','°C','°F',100),212));
ok('°F→K',near(K.tlConvert('temperature','°F','K',32),273.15));
ok('K→°C',near(K.tlConvert('temperature','K','°C',0),-273.15));
ok('dBm→mW',near(K.tlConvert('power','dBm','mW',30),1000));
ok('W→dBm',near(K.tlConvert('power','W','dBm',1),30));
ok('dBW→dBm',near(K.tlConvert('power','dBW','dBm',0),30));
ok('kn→km/h',near(K.tlConvert('speed','kn','km/h',1),1.852));
ok('KiB→B',K.tlConvert('data','KiB','B',1)===1024);
ok('bit→B',K.tlConvert('data','bit','B',8)===1);
ok('atm→hPa',near(K.tlConvert('pressure','atm','hPa',1),1013.25));
ok('rpm→Hz',near(K.tlConvert('frequency','rpm','Hz',60),1));
ok('unknown unit',K.tlConvert('length','m','kg',1)===null);
ok('NaN in',K.tlConvert('length','m','km',NaN)===null);
ok('round trip all',K.tlCats().every(c=>{ const u=K.tlUnits(c); return u.every(a=>u.every(b=>near(K.tlConvert(c,b,a,K.tlConvert(c,a,b,5)),5,1e-9))); }));
ok('fmt',K.tlFmt(1/3)==='0.3333333' && K.tlFmt(0)==='0' && K.tlFmt(null)==='—' && K.tlFmt(1.5e12).includes('e'),K.tlFmt(1.5e12));

// линейка
const tm=K.tlRulerTicks(100,false);
ok('mm ticks count',tm.length===101);
ok('mm levels',tm[0].level===2 && tm[5].level===1 && tm[3].level===0 && tm[10].label==='1');
const ti=K.tlRulerTicks(50.8,true);
ok('in ticks: 2 in = 33 ticks',ti.length===33,ti.length);
ok('in ticks: 1 in at 25.4 mm labelled',near(ti[16].pos,25.4) && ti[16].label==='1' && ti[16].level===2);
ok('len text',K.tlLenText(25.4)==='25.4 mm · 1 in',K.tlLenText(25.4));

// высота
ok('dist: 45° top, base 0 → d',near(K.tlHeightDist(45,0,10),10));
ok('dist: base below',near(K.tlHeightDist(30,-10,20),20*(Math.tan(30*Math.PI/180)+Math.tan(10*Math.PI/180))));
const he=K.tlHeightEye(45,-Math.atan(1.6/10)*180/Math.PI,1.6);
ok('eye: distance 10 m, top 45° → 11.6 m',near(he.d,10,1e-9) && near(he.h,11.6,1e-9),JSON.stringify(he));
ok('eye: base not below horizon',K.tlHeightEye(30,0,1.6)===null);
ok('baro: same pressure → 0',K.tlBaro(1013,1013)===0);
ok('baro: ~12 hPa drop ≈ +100 m',Math.abs(K.tlBaro(1001,1013)-100)<3,K.tlBaro(1001,1013));
ok('baro bad',K.tlBaro(0,1013)===null);

// наклон
let t=K.tlTilt(0,0,9.81,'flat',1);
ok('flat level',near(t.slope,0,1e-6) && Math.abs(t.x)<1e-9 && t.pct===0);
const a10=10*Math.PI/180; t=K.tlTilt(0,9.81*Math.sin(a10),9.81*Math.cos(a10),'flat',1);
ok('flat 10°',near(t.slope,10,1e-9) && near(t.y,10,1e-9) && near(t.pct,Math.tan(a10)*100,1e-9) && near(t.dir,0,1e-6),JSON.stringify(t));
t=K.tlTilt(9.81*Math.sin(a10),0,9.81*Math.cos(a10),'flat',1);
ok('flat roll 10° → dir 90',near(t.slope,10,1e-9) && near(t.dir,90,1e-9));
t=K.tlTilt(0,0,-9.81,'flat',-1);
ok('iOS sign flat level',near(t.slope,0,1e-6));
t=K.tlTilt(0,9.81,0,'upright',1);
ok('upright plumb',near(t.slope,0,1e-6));
t=K.tlTilt(9.81*Math.sin(a10),9.81*Math.cos(a10),0,'upright',1);
ok('upright lean 10°',near(t.slope,10,1e-9) && near(t.x,10,1e-9));
t=K.tlTilt(0,9.81,0,'flat',1);
ok('flat on edge → 90°, pct inf',near(t.slope,90,1e-9) && t.pct===Infinity);
ok('zero vector',K.tlTilt(0,0,0,'flat',1)===null);

// шаги: ходьба 2 Гц, вертикальная амплитуда 3 м/с² поверх g, 50 Гц отсчёты
function walk(hz,amp,sec,noise){
  const S=K.tlStepNew(); let seed=1; const rnd=()=>{ seed=(seed*1664525+1013904223)>>>0; return seed/4294967296-.5; };
  for(let i=0;i<sec*50;i++){ const tt=i/50; K.tlStepPush(S,tt,9.81+amp*Math.sin(2*Math.PI*hz*tt)+(noise||0)*rnd()); }
  return S;
}
let S=walk(2,3,30,.3);
ok('walk 2 Hz 30 s ≈ 60 steps',Math.abs(S.count-60)<=3,S.count);
ok('cadence ≈ 120 spm',Math.abs(S.spm-120)<8,S.spm);
S=walk(1.6,2.5,20,.3);
ok('walk 1.6 Hz 20 s ≈ 32 steps',Math.abs(S.count-32)<=3,S.count);
S=walk(0,0,30,.4);
ok('standing with noise → 0',S.count===0,S.count);
S=walk(2,3,2,0);
ok('2 s of walking: not counted yet (confirm)',S.count>=0 && S.count<=4,S.count);
S=walk(5,3,20,0);
ok('5 Hz shaking too fast for steps (minGap)',S.count<=60,S.count);

// фонарик
ok('torch steady',K.tlTorchOn('steady',0,123.4)===true);
ok('torch strobe 2 Hz',K.tlTorchOn('strobe',2,.1)===true && K.tlTorchOn('strobe',2,.3)===false && K.tlTorchOn('strobe',2,.55)===true);
ok('SOS length 42 units',K.TL_SOS.length===('10101'+'000'+'111011101110111'+'000'+'10101'+'0000000').length);
ok('SOS first dot on, gap off',K.tlTorchOn('SOS',0,.05)===true && K.tlTorchOn('SOS',0,.25)===false && K.tlTorchOn('SOS',0,.45)===true);

if(bad){ console.log(bad,'failed'); process.exit(1); } else console.log('all ok');
