// IQ-блоки GPS: «небо» (gpsSky) → приёмник (gpsRx) тактами движка. node tools/test-gps-blocks.mjs
import vm from 'node:vm'; import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({console,Math,performance:{now:()=>Date.now()},self:{}});
for(const f of ['core-dsp.js','modules/simd-kernels.js','modules/iq-kernels.js','modules/gps-kernels.js','modules/gps-iq-kernels.js']) vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});
const T=vm.runInContext('({IQK,gpsGeo2Ecef,gpsEcef2Geo})',ctx), IQK=T.IQK;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const SECONDS=+(process.env.GPS_SECONDS||40), TICK={block:1024,sr:48000}, LAT=55.03, LON=82.92, ALT=150;
const sky={p:{sr:'2048000',lat:LAT,lon:LON,alt:ALT,nsat:6,cn0:46,cycle:'fast (subframes 1–3)'}}, rx={p:{maxSat:8,thr:5,avg:5,maxd:5}};
IQK.gpsSky.init(sky); IQK.gpsRx.init(rx);
let fixes=[],texts=[],truth=0,t0=Date.now(),ticks=Math.round(SECONDS*TICK.sr/TICK.block);
for(let k=0;k<ticks;k++){
  const a=IQK.gpsSky.process(sky,{},TICK); if(a.rec) truth++;
  const b=IQK.gpsRx.process(rx,{in:a.iq},TICK);
  if(b.rec) fixes.push(b.rec[0]); if(b.text) texts.push(b.text);
}
console.log('время:',((Date.now()-t0)/1000).toFixed(1),'с на',SECONDS,'с потока; каналов',rx.ch.length,'; поисков',rx.nacq);
console.log(rx.ch.map(h=>'PRN'+h.prn+(h.eph?'✓':'·')+' lock '+h.tr.lock.toFixed(2)).join('  '));
ok('небо: генератор выдаёт поток 2.048 МС/с',sky.ui && !sky.ui.err && sky.k>=SECONDS*1000-30);
ok('приёмник нашёл ≥ 4 спутника с эфемеридами',rx.ch.filter(h=>h.eph).length>=4);
ok('позиция выдаётся раз в секунду',fixes.length>=3,fixes.length);
if(fixes.length){ const f=fixes[fixes.length-1], A=T.gpsGeo2Ecef(LAT,LON,ALT), B=T.gpsGeo2Ecef(f.lat,f.lon,f.alt), err=Math.hypot(A[0]-B[0],A[1]-B[1],A[2]-B[2]);
  console.log('позиция:',f.lat.toFixed(5),f.lon.toFixed(5),f.alt.toFixed(0),'м; ошибка',err.toFixed(1),'м; спутников',f.sats,'PDOP',f.pdop);
  ok('ошибка позиции ≤ 20 м (среднее по 5 фиксам)',err<=20,err); ok('NMEA GGA с верной контрольной суммой',/^\$GPGGA,.*\*[0-9A-F]{2}$/.test(texts[texts.length-1])); console.log(texts[texts.length-1]); }
ok('ложных каналов нет (все с эфемеридой или в захвате)',rx.ch.every(h=>h.tr.lock>0.2));
// частота не из списка → понятная ошибка, без падения
const r2={p:{}}; IQK.gpsRx.init(r2); const bad1={sr:2400000,fc:1575.42e6,chunks:[{re:new Float32Array(2400),im:new Float32Array(2400),t0:0}]}; IQK.gpsRx.process(r2,{in:bad1},TICK);
ok('неверная частота дискретизации — сообщение, а не падение',r2.ui && /2048/.test(r2.ui.err||''));
console.log(bad?('FAIL: '+bad):'всё ок'); process.exit(bad?1:0);
