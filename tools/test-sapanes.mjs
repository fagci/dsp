// Ядро панелей Multiband (Spectrum Analyzer, layout=panes): node tools/test-sapanes.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,Float64Array,Object,String,Number});
vm.runInContext(fs.readFileSync(path.join(root,'modules/sa-panes-kernels.js'),'utf8')+
  ';this.K={sapResFor,sapFloor,sapEma,sapOld,sapPeaks,sapCsv};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };

ok('res: unknown step → 2048',K.sapResFor(70e6,0)===2048);
ok('res: narrow band with a 25 kHz step → 1024',K.sapResFor(2e6,25e3)===1024);
ok('res: 70 MHz / 25 kHz → 4096 (cap)',K.sapResFor(70e6,25e3)===4096);
ok('res: 70 MHz / 5 MHz-step → floor 1024',K.sapResFor(70e6,5e6)===1024);
ok('res: 20 MHz / 12.5 kHz → 4096',K.sapResFor(20e6,12.5e3)===4096,K.sapResFor(20e6,12.5e3));
ok('res: 10 MHz / 12.5 kHz → 2048',K.sapResFor(10e6,12.5e3)===2048,K.sapResFor(10e6,12.5e3));

// полка: 60% столбцов заняты сигналами — медиана завышена, 20%-квантиль нет
const lv=new Float32Array(1000).fill(NaN);
for(let i=0;i<1000;i++) lv[i]= (i%10<6 ? -50 : -100)+(i%7)*.1;
const med=(()=>{ const t=Float32Array.from(lv).sort(); return t[500]; })();
const fl=K.sapFloor(lv);
ok('floor: ignores signals (60% occupied), median does not',fl<-99 && med>-60,fl+' '+med);
ok('floor: too few points → NaN',Number.isNaN(K.sapFloor(new Float32Array(100).fill(NaN))));
const gaps=new Float32Array(100).fill(NaN); gaps[3]=-90;
ok('floor: NaN gaps are skipped',Number.isNaN(K.sapFloor(gaps)));

ok('ema: first value is taken as is',K.sapEma(NaN,-80,.8)===-80);
ok('ema: a=0 — no averaging',K.sapEma(-100,-60,0)===-60);
ok('ema: a=.75',Math.abs(K.sapEma(-100,-60,.75)-(-90))<1e-9);
let v=NaN; for(let i=0;i<60;i++) v=K.sapEma(v,i%2?-70:-90,.9);
ok('ema: noise is smoothed',Math.abs(v+80)<3,v);

ok('old: off when sec=0',!K.sapOld(1,1e6,0));
ok('old: no data is not old',!K.sapOld(0,1e6,10));
ok('old: 5 s of 10 — fresh, 20 s — old',!K.sapOld(1000,6000,10) && K.sapOld(1000,21000,10));

const pk=new Float32Array(200).fill(-100); pk[50]=-60; pk[52]=-70; pk[120]=-80; pk[121]=-80; pk[190]=-98;
const ps=K.sapPeaks(pk,null,100e6,101e6,-100,6,4);
ok('peaks: strongest first, neighbours merged, weak ones dropped',ps.length===2 && ps[0].db===-60 && ps[1].db===-80,JSON.stringify(ps));
ok('peaks: frequency of the column',Math.abs(ps[0].f-(100e6+1e6*50.5/200))<1,ps[0].f);
ok('peaks: plateau gives one peak',K.sapPeaks(pk,null,0,1,-100,6,4).filter(p=>p.db===-80).length===1);
ok('peaks: limit',K.sapPeaks(pk,null,0,1,-100,6,4,1).length===1);

const csv=K.sapCsv([{band:'VHF, air',f:118.5e6,db:-61.234,snr:38.8,age:3.2},{band:'UHF',f:446e6,db:-80,snr:20,age:null}]);
ok('csv: header, quoted comma, empty age',csv==='band,freq_hz,level_db,snr_db,age_s\n"VHF, air",118500000,-61.2,38.8,3\nUHF,446000000,-80.0,20.0,\n',JSON.stringify(csv));

console.log(bad ? bad+' failed' : 'all ok'); process.exit(bad?1:0);
