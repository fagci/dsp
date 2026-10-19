// Ядро Satellite Autopilot (расписание пролётов, доплер): node tools/test-satplan.mjs
// Часть 1 — логика на выдуманных пролётах; часть 2 — настоящий SGP4 из vendor/satellite.min.js по TLE МКС.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const rd=f=>fs.readFileSync(path.join(root,f),'utf8');
const ctx=vm.createContext({console,Math,Date,Float32Array,Float64Array,Map,Set,Array,Object,String,Number,JSON,parseFloat,isFinite,Infinity});
vm.runInContext(rd('vendor/satellite.min.js')+'',ctx);
vm.runInContext('const D2R=Math.PI/180, GEO_R=6371.0088; const GeoMe={lat:null,lon:null}; function def(){} function geoGet(){} function geoPut(){} const Net={url:u=>u};',ctx);
vm.runInContext(rd('modules/sat.js'),ctx,{filename:'modules/sat.js'});
vm.runInContext(rd('modules/satplan-kernels.js')+';this.K={spHz,spParseTargets,spFromRows,spPasses,spPick,spNow,spDoppler,spFreq,spFmtDur,satState,satPasses,satRangeRate,satParseTle,SP_KNOWN};',ctx,{filename:'modules/satplan-kernels.js'});
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const J=x=>JSON.stringify(x);

// ---- разбор целей ----
ok('hz: 137.1 → MHz, 137100000 stays, "145.8 MHz", "437800 kHz", junk → 0',K.spHz(137.1)===137.1e6 && K.spHz(137100000)===137.1e6 && K.spHz('145.8 MHz')===145.8e6 && K.spHz('437800 kHz')===437.8e6 && K.spHz('x')===0);
const T=K.spParseTargets('NOAA 19;137.1;APT;15;5, METEOR-M2 3;;LRPT\n# comment\nISS');
ok('targets: fields, defaults, comment, newline and comma',T.length===3 && T[0].f0===137.1e6 && T[0].mode==='APT' && T[0].minEl===15 && T[0].prio===5 && T[1].f0===0 && T[1].minEl===null && T[2].sat==='ISS',J(T));
const R=K.spFromRows([{name:'NOAA 18',Freq:'137.9125M',Mode:'APT','min el':20,Priority:'3'},{sat:25544,enabled:'0'},{sat:'METEOR-M2 4',lo:137.9e6},{foo:1},{sat:' '}]);
ok('rows: aliases, skipped disabled and empty',R.length===2 && R[0].f0===137.9125e6 && R[0].minEl===20 && R[0].prio===3 && R[1].f0===137.9e6,J(R));
ok('freq: explicit > built-in table > SatNOGS > none',(()=>{ const tx=new Map([[99999,[{dl:435.5e6,mode:'FM'}]]]);
  const a=K.spFreq({f0:1e8,mode:'X'},33591,tx), b=K.spFreq({f0:0,mode:''},33591,tx), c=K.spFreq({f0:0,mode:''},99999,tx), d=K.spFreq({f0:0,mode:''},1,tx);
  return a.f0===1e8 && a.mode==='X' && b.f0===137.1e6 && b.mode==='APT' && c.f0===435.5e6 && c.mode==='FM' && d.f0===0; })());
ok('doppler: receding satellite lowers the frequency, 7 km/s at 137.1 MHz ≈ 3.2 kHz',K.spDoppler(137.1e6,7)===Math.round(137.1e6*(1-7/299792.458)) && Math.abs(K.spDoppler(137.1e6,7)-137.1e6+3200)<30 && K.spDoppler(0,5)===null);
ok('duration text',K.spFmtDur(45000)==='45s' && K.spFmtDur(125000)==='2m 05s' && K.spFmtDur(3725000)==='1h 02m');

// ---- выбор непересекающихся пролётов ----
const MIN=60000, t0=Date.UTC(2025,0,1,12,0,0);
const P=(sat,a,b,el,prio=0)=>({sat,norad:sat.length,aos:t0+a*MIN,los:t0+b*MIN,maxEl:el,prio});
const fake=[P('A',0,10,30),P('B',8,18,70),P('C',20,30,10),P('D',22,25,40,5),P('E',40,50,25),P('F',50.2,60,20)];
const plan=K.spPick(fake.map(p=>({...p})),30000,30000,20000);
const st=Object.fromEntries(plan.map(p=>[p.sat,p.status]));
ok('pick: the higher pass wins an overlap (B over A), lower priority loses to the higher one (D over C)',st.A==='skipped' && st.B==='planned' && st.C==='skipped' && st.D==='planned',J(st));
ok('pick: a skipped pass says who took its time',plan.find(p=>p.sat==='A').why==='B');
ok('pick: pre/post/gap windows count — E and F 12 s apart conflict, with no margins they do not',st.E==='planned' && st.F==='skipped' && K.spPick(fake.map(p=>({...p})),0,0,0).find(p=>p.sat==='F').status==='planned');
ok('pick: result is sorted by AOS',plan.every((p,i)=>i===0 || plan[i-1].aos<=p.aos));

// ---- состояние в момент времени ----
const pl=K.spPick([P('E',40,50,25),P('B',8,18,70),P('X',60,70,50)].map(p=>({...p})),30000,30000,0);
const at=m=>K.spNow(pl,t0+m*MIN,30000,30000);
ok('now: idle before the first window, next is B',at(0).phase==='idle' && at(0).cur===null && at(0).next.sat==='B');
ok('now: 20 s before AOS → pre, go window is open already',at(7.66).phase==='pre' && at(7.66).cur.sat==='B' && at(7.66).next.sat==='E');
ok('now: between AOS and LOS → pass; 20 s after LOS → post; 40 s after → idle',at(12).phase==='pass' && at(18.33).phase==='post' && at(18.7).phase==='idle');
ok('now: after the last pass → no next',at(80).next===null && at(80).cur===null);

// ---- настоящая орбита: МКС, TLE из README satellite.js ----
const TLE='ISS (ZARYA)\n1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992\n2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442\n';
const sats=K.satParseTle(TLE), iss=sats[0];
ok('tle: parsed, NORAD 25544',sats.length===1 && iss.norad===25544 && iss.name==='ISS (ZARYA)');
const D2R=Math.PI/180, obs={latitude:55.03*D2R,longitude:82.92*D2R,height:0.1};     // Новосибирск
const from=Date.UTC(2019,5,5,12,0,0);
const res=K.spPasses([{t:{sat:'ISS',minEl:10,mode:'NFM',prio:0},s:iss,f0:145.8e6}],{from,hours:24,obs,minEl:5},{passes:K.satPasses,rate:K.satRangeRate});
const ps=res.passes;
ok('sgp4: ISS gives 2–7 passes of at least 10° in a day',ps.length>=2 && ps.length<=7,ps.length);
ok('sgp4: every pass 2…13 min, max elevation ≥ 10°, AOS < peak < LOS',ps.every(p=>(p.los-p.aos)>=2*MIN && (p.los-p.aos)<=13*MIN && p.maxEl>=10 && p.tMax>=p.aos && p.tMax<=p.los));
ok('sgp4: elevation at AOS and LOS is at the threshold (±1°)',ps.every(p=>{ const a=K.satState(iss,new Date(p.aos),obs), b=K.satState(iss,new Date(p.los),obs); return Math.abs(a.el-10)<1 && Math.abs(b.el-10)<1; }),ps.map(p=>K.satState(iss,new Date(p.aos),obs).el.toFixed(2)).join());
ok('sgp4: the pass fields carry the target data (frequency, mode, name)',ps.every(p=>p.f0===145.8e6 && p.mode==='NFM' && p.sat==='ISS (ZARYA)' && p.norad===25544));
// доплер: сближение (до пика) — частота выше номинала, удаление (после) — ниже; модуль < 7,7 км/с · f/c
const p0=ps[0], rA=K.satRangeRate(iss,p0.aos+5000,obs), rL=K.satRangeRate(iss,p0.los-5000,obs);
const fa=K.spDoppler(145.8e6,rA), fl=K.spDoppler(145.8e6,rL);
ok('doppler on a real pass: above f0 at AOS (+2…4 kHz), below at LOS (−2…−4 kHz)',fa>145.8e6+2000 && fa<145.8e6+4000 && fl<145.8e6-2000 && fl>145.8e6-4000,fa-145.8e6+' / '+(fl-145.8e6));
const rM=K.satRangeRate(iss,p0.tMax,obs);
ok('doppler: near zero at the highest point (|Δf| < 1.5 kHz)',Math.abs(K.spDoppler(145.8e6,rM)-145.8e6)<1500,K.spDoppler(145.8e6,rM)-145.8e6);
// планирование двух целей одним приёмником
const iss2={...iss,name:'ISS2',norad:99999};
const two=K.spPasses([{t:{sat:'ISS',prio:0},s:iss,f0:145.8e6},{t:{sat:'ISS2',prio:9},s:iss2,f0:437.8e6}],{from,hours:24,obs,minEl:10},{passes:K.satPasses});
const picked=K.spPick(two.passes,30000,30000,20000);
ok('two targets on one orbit: only the high-priority copy is planned, the other is skipped',picked.filter(p=>p.status==='planned').every(p=>p.sat==='ISS2') && picked.filter(p=>p.status==='skipped').length===ps.filter(p=>p.maxEl>=10).length);
ok('no orbit for an unknown name is reported',K.spPasses([{t:{sat:'NOPE'},s:null,f0:0}],{from,hours:1,obs,minEl:0},{passes:K.satPasses}).noOrbit.join()==='NOPE');
console.log(bad?`${bad} failed`:'all ok');
process.exit(bad?1:0);
