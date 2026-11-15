// Ядро детектора по полу бина (пол по бину, открытие по модуляции, слоты): node tools/test-bindet.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,Uint8Array,Infinity,isFinite,Set,Array});
vm.runInContext(fs.readFileSync(path.join(root,'modules/bindet-kernels.js'),'utf8')+';this.K={bdNew,bdFrame,bdSlots};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
let seed=777; const rnd=()=>{ seed^=seed<<13; seed^=seed>>>17; seed^=seed<<5; return (seed>>>0)/4294967296; };
const gs=()=>Math.sqrt(-2*Math.log(Math.max(rnd(),1e-12)))*Math.cos(2*Math.PI*rnd());
const N=2048, F0=100e6, BIN=1000, hz=i=>F0+i*BIN;
// кадр в дБ: комплексный гауссов шум на бин + «сигналы» (линейные амплитуды по бинам: amp(i,t)); неровный пол приёмника: горб
const hump=i=>6*Math.exp(-Math.pow((i-N/2)/300,2));
function frame(sigs,t){
  const L=new Float32Array(N);
  for(let i=0;i<N;i++){
    let re=gs()*Math.SQRT1_2, im=gs()*Math.SQRT1_2;               // шум: мощность 1 → 0 дБ
    for(const s of sigs){ const a=s.amp(i,t); if(a){ re+=a*Math.cos(s.ph(t)); im+=a*Math.sin(s.ph(t)); } }
    L[i]=10*Math.log10(re*re+im*im)+hump(i);
  }
  return L;
}
const dB=x=>Math.pow(10,x/20);
const carrier={amp:i=>i===500?dB(30):i===499||i===501?dB(24):0, ph:()=>0};                    // несущая: 3 бина, постоянный уровень
const speech={amp:(i,t)=>{ const w=Math.abs(i-1200); return w<=6 ? dB(26)*(.3+.7*Math.abs(Math.sin(t*.9+w)))*(Math.sin(t*.37)>-.6?1:.05) : 0; }, ph:t=>t*2.1};  // широкий, амплитуда пляшет
const spike={amp:(i,t)=>t>=40&&t<41&&i>=1500&&i<1700?dB(25):0, ph:()=>0};                    // широкополосный всплеск на один кадр
const O={thr:10,gate:8,tau:100,learn:30,confM:2,confN:4,minW:2,gap:2,bwDb:20,carBins:4,modK:3,settle:8,hold:600,maxBw:0,edge:0};
const st=K.bdNew(); let t=0, last=null; const recs=[];
for(t=0;t<30;t++){ last=K.bdFrame(st,frame([],t),hz,{...O,now:t*80}); }
// 1) шум = 0 дБ, горб вычтен
let m=0, sd=0, cnt=0; for(let i=100;i<N-100;i++){ m+=last.exc[i]; cnt++; } m/=cnt;
ok('шум после обучения ≈ 0 дБ (среднее в дБ ≈ −2,5…+1)',Math.abs(m)<3,m.toFixed(2));
const hm=(()=>{ let a=0,b=0; for(let i=N/2-20;i<N/2+20;i++) a+=last.exc[i]; for(let i=200;i<240;i++) b+=last.exc[i]; return (a-b)/40; })();
ok('горб приёмника (6 дБ) вычтен: пол у горба ≈ пол у края',Math.abs(hm)<2.5,hm.toFixed(2));
ok('чистый шум — ни одного канала',last.chans.length===0,String(last.chans.length));
// 2) несущая + речь + всплеск
let opened=new Set(), carrierOpen=false, spikeSeen=false;
for(t=30;t<160;t++){
  const r=K.bdFrame(st,frame([carrier,speech,spike],t),hz,{...O,now:t*80});
  for(const x of r.recs){ recs.push(x); if(x.kind==='open'){ if(Math.abs(x.f-hz(500))<3000) carrierOpen=true; if(x.f>hz(1500)&&x.f<hz(1700)) spikeSeen=true; opened.add(Math.round((x.f-F0)/1000)); } }
  last=r;
}
const speechOpen=[...opened].some(b=>Math.abs(b-1200)<=8);
ok('речь (широкая, амплитуда пляшет) открылась',speechOpen,[...opened].join());
ok('несущая без модуляции не открылась',!carrierOpen,JSON.stringify(recs.filter(x=>Math.abs(x.f-hz(500))<3000)));
ok('широкополосный всплеск в один кадр отсеян (M из N)',!spikeSeen);
// несущая видна как канал, но закрыта
const car=last.tracks.find(x=>Math.abs(x.f-hz(500))<3000);
ok('несущая числится дорожкой (закрытой)',!!car && !car.open,car?('ratio '+car.ratio.toFixed(2)):'нет');
// 3) закрытие по hold после ухода сигнала
for(t=160;t<190;t++){ const r=K.bdFrame(st,frame([carrier],t),hz,{...O,now:t*80}); for(const x of r.recs) recs.push(x); last=r; }
const cl=recs.find(x=>x.kind==='close');
ok('после ухода речи канал закрылся, есть длительность',!!cl && cl.dur>0,JSON.stringify(cl));
// 4) постоянная новая станция впитывается полом (не вечный «открыт» от поднявшегося пола) — и пол вниз при уходе
// 5) слоты: открытые держат номер, закрытые освобождают, переполнение считается
const tr=[{open:true,openAt:1,f:1e6,slot:0},{open:true,openAt:2,f:2e6,slot:0},{open:true,openAt:3,f:3e6,slot:0}];
let s=K.bdSlots(tr,2);
ok('слоты: два из трёх, один потерян',s.go[0]===1&&s.go[1]===1&&s.lost===1&&s.f[0]===1e6&&s.f[1]===2e6,JSON.stringify(s));
tr[0].open=false; s=K.bdSlots(tr,2);
ok('слот освободился и отдан третьему; второй держит свой',s.f[0]===3e6&&s.f[1]===2e6&&s.lost===0,JSON.stringify(s));
// 6) устойчивость: смена размера кадра
const r2=K.bdFrame(st,new Float32Array(512),i=>i,{...O,now:1e6});
ok('смена размера спектра сбрасывает состояние без ошибок',r2.exc.length===512);
console.log(bad?'\nFAILED: '+bad:'\nall ok'); process.exit(bad?1:0);
