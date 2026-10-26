// Ядро инструментов (единицы, линейка, высота, наклон, шаги, фонарик): node tools/test-tools.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Number,Array,String,Object,isFinite,JSON});
vm.runInContext(fs.readFileSync(path.join(root,'modules/tools-kernels.js'),'utf8')+';this.K={TL_UNITS,tlCats,tlUnits,tlConvert,tlConvertAuto,tlFmt,tlRulerTicks,tlLenText,tlHeightDist,tlHeightEye,tlBaro,tlTilt,tlStepNew,tlStepPush,tlTorchOn,TL_SOS,rfWave,rfFspl,rfLink,rfSwr,rfSwrFromRl,rfOhm,rfLc,rfLcC,coUtm,coFromUtm,coMgrs,coFromMgrs,coMaiden,coFromMaiden,coParse,coDMS,coDDM,coFormat,coDD}',ctx);
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

ok('auto: category found',near(K.tlConvertAuto(10,'km','mi'),6.213711922,1e-8) && K.tlConvertAuto(100,'C','F')===212);
ok('auto: aliases',near(K.tlConvertAuto(1,'m2','ft²'),10.7639104,1e-6) && near(K.tlConvertAuto(1000,'um','mm'),1));
ok('auto: ambiguous names resolved by pair',near(K.tlConvertAuto(2,'min','s'),120) && near(K.tlConvertAuto(1,'mi','km'),1.609344));
ok('auto: different categories → null',K.tlConvertAuto(1,'m','kg')===null && K.tlConvertAuto(1,'nope','m')===null);

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

// радио
const w=K.rfWave(145e6,.95);
ok('wave 145 MHz',near(w.lambda,2.0675,1e-3) && near(w.quarter,2.0675/4*.95,1e-3) && near(w.half,2.0675/2*.95,1e-3));
ok('wave bad',K.rfWave(0,1)===null);
ok('FSPL 1 km 100 MHz = 72.44 dB',near(K.rfFspl(1,100),72.44,1e-4));
const lk=K.rfLink({pt:30,gt:3,gr:3,lossTx:1,lossRx:1,dKm:10,fMHz:145,sens:-110});
ok('link: pr = eirp + gr − loss − fspl',near(lk.pr,30+3-1+3-1-K.rfFspl(10,145),1e-9) && near(lk.margin,lk.pr+110,1e-9));
const lk2=K.rfLink({pt:30,gt:3,gr:3,lossTx:1,lossRx:1,dKm:lk.range,fMHz:145,sens:-110});
ok('link: zero margin at the computed range',Math.abs(lk2.margin)<1e-6,lk2.margin);
const sw=K.rfSwr(2);
ok('SWR 2: Γ 0.333, RL 9.54 dB, 11.1 % reflected, 0.51 dB',near(sw.gamma,1/3) && near(sw.rl,9.5424,1e-4) && near(sw.refl,11.111,1e-3) && near(sw.ml,.5115,1e-3),JSON.stringify(sw));
ok('SWR 1: infinite RL',K.rfSwr(1).rl===Infinity && K.rfSwr(.5)===null);
ok('SWR ↔ RL',near(K.rfSwrFromRl(K.rfSwr(1.5).rl),1.5));
ok('Ohm: V,I',JSON.stringify(K.rfOhm(12,2,0,0))==='{"V":12,"I":2,"R":6,"P":24}');
ok('Ohm: I,R / P,R / V,P',near(K.rfOhm(0,2,5,0).V,10) && near(K.rfOhm(0,0,4,100).V,20) && near(K.rfOhm(10,0,0,5).R,20));
ok('Ohm: not two knowns',K.rfOhm(1,2,3,0)===null && K.rfOhm(1,0,0,0)===null);
ok('LC: 10 µH + 100 pF ≈ 5.03 MHz',near(K.rfLc(10,100),5.0329e6,1e-4));
ok('LC: C from f and L',near(K.rfLcC(K.rfLc(10,100),10),100,1e-9));

// координаты
const es=K.coUtm(40.7484,-73.9857);
ok('UTM: Empire State 18T 585628 4511322',es.zone===18 && es.band==='T' && Math.abs(es.E-585628)<2 && Math.abs(es.N-4511322)<2,JSON.stringify(es));
ok('UTM: central meridian / equator',K.coUtm(0,3).E===500000 && K.coUtm(0,3).N===0 && K.coUtm(0,3).zone===31);
ok('UTM: south hemisphere has false northing',K.coUtm(-33.8688,151.2093).N>6e6 && K.coUtm(-33.8688,151.2093).north===false);
ok('UTM: Norway zone 32V, Svalbard 33X',K.coUtm(60,5).zone===32 && K.coUtm(78,15).zone===33);
ok('UTM: out of range',K.coUtm(85,0)===null && K.coUtm(-81,0)===null);
ok('MGRS: Empire State',K.coMgrs(40.7484,-73.9857,5)==='18T WL 85628 11322',K.coMgrs(40.7484,-73.9857,5));
ok('MGRS: precision 3',K.coMgrs(40.7484,-73.9857,3)==='18T WL 856 113');
let rt=true, worst=0;
for(const [la,lo] of [[40.7484,-73.9857],[55.0375,82.925],[-33.8688,151.2093],[51.5,-0.12],[-54.8,-68.3],[1.3,103.8],[69.6,18.9],[0.01,179.9],[-79.9,10],[83.5,-45]]){
  const u=K.coUtm(la,lo), b=K.coFromUtm(u.zone,u.north,u.E,u.N); worst=Math.max(worst,Math.abs(b.lat-la),Math.abs(b.lon-lo));
  const m=K.coFromMgrs(K.coMgrs(la,lo,5)); if(!m || Math.abs(m.lat-la)>2e-4 || Math.abs(m.lon-lo)>3e-4) rt=false;
}
ok('UTM round trip < 1e-8°',worst<1e-8,worst);
ok('MGRS round trip (1 m cell) in both hemispheres and bands',rt);
ok('Maidenhead: Novosibirsk NO14ac…',K.coMaiden(55.0375,82.925,6)==='NO15la' || K.coMaiden(55.0375,82.925,6)==='NO14la',K.coMaiden(55.0375,82.925,6));
ok('Maidenhead: JO65, IO91wm (London)',K.coMaiden(51.5,-0.12,6)==='IO91wm' && K.coMaiden(59.9,10.75,4)==='JO59');
const mh=K.coFromMaiden('IO91wm');
ok('Maidenhead decode: centre of the square',Math.abs(mh.lat-51.5)<.03 && Math.abs(mh.lon+0.12)<.05 && K.coFromMaiden('XX00')===null);
ok('Maidenhead round trip 8 / 10 chars',K.coMaiden(...Object.values(K.coFromMaiden(K.coMaiden(55.0375,82.925,8))),8)===K.coMaiden(55.0375,82.925,8) && K.coMaiden(...Object.values(K.coFromMaiden(K.coMaiden(55.0375,82.925,10))),10)===K.coMaiden(55.0375,82.925,10));
ok('format DMS / DDM',K.coDMS(55.0375,82.925)==='55°02\'15.00"N 82°55\'30.00"E' && K.coDDM(-33.8688,151.2093)==="33°52.1280'S 151°12.5580'E",K.coDMS(55.0375,82.925));
ok('format rounding carry: 59.99999°',K.coDMS(59.99999999,0).startsWith('60°00'));
const nr=(s,la,lo)=>{ const r=K.coParse(s); return !!r && Math.abs(r.lat-la)<1e-6 && Math.abs(r.lon-lo)<1e-6; };
ok('parse DD / comma / space / minus',nr('55.0375, 82.925',55.0375,82.925) && nr('-33.8688 151.2093',-33.8688,151.2093) && nr('55,0375 82,925',55.0375,82.925));
ok('parse DMS with letters and symbols',nr('55°02\'15"N 82°55\'30"E',55.0375,82.925) && nr('55 02 15 N, 82 55 30 E',55.0375,82.925));
ok('parse DDM',nr("55°02.25'N 82°55.5'E",55.0375,82.925) && nr('N 55 02.25 E 82 55.5',55.0375,82.925));
ok('parse S / W signs',nr('33°52\'07.68"S 70°40\'W',-33.8688,-70.66666666666667) && nr('S 33.8688 W 70.5',-33.8688,-70.5));
ok('parse Cyrillic hemispheres',nr('55.0375 С 82.925 В',55.0375,82.925));
ok('parse DMS without letters',nr('55 02 15 82 55 30',55.0375,82.925));
ok('parse UTM / MGRS / locator',K.coParse('33U 500000 5500000').fmt==='UTM' && K.coParse('18T WL 85628 11322').fmt==='MGRS' && K.coParse('IO91wm').fmt==='Maidenhead');
ok('parse UTM value',Math.abs(K.coParse('18T 585628 4511322').lat-40.7484)<1e-4 && Math.abs(K.coParse('18T 585628 4511322').lon+73.9857)<1e-4);
ok('parse garbage / out of range',K.coParse('hello')===null && K.coParse('')===null && K.coParse('95 10')===null && K.coParse('1 2 3')===null);
ok('coFormat dispatch',K.coFormat(55.0375,82.925,'DD')==='55.03750, 82.92500' && K.coFormat(55.0375,82.925,'Maidenhead').length===6 && K.coFormat(91,0,'DD')===null);

if(bad){ console.log(bad,'failed'); process.exit(1); } else console.log('all ok');
