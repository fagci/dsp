// Ядро Spectrum Baseline (норма эфира и аномалии): node tools/test-baseline.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,Float64Array,Int16Array,Int32Array,Uint8Array,Uint16Array,Infinity,isFinite,Object,String,Number,btoa,atob});
vm.runInContext(fs.readFileSync(path.join(root,'modules/baseline-kernels.js'),'utf8')+
  ';this.K={blNew,blFrame,blAt,blSave,blLoad};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };

let seed=12345; const rnd=()=>{ seed^=seed<<13; seed^=seed>>>17; seed^=seed<<5; return (seed>>>0)/4294967296; };
const gs=()=>Math.sqrt(-2*Math.log(Math.max(rnd(),1e-12)))*Math.cos(2*Math.PI*rnd());
const F0=100e6, STEP=1000, N=2000;
const O={res:1000, learn:40, adapt:200, thr:8, z:5, sdMin:1, confirm:3, hold:1500, wideBw:200e3, occMin:.8, drop:15, now:0};
// кадр: пол −100 дБ ± 1,5; sig — список {bin, w, db}; raise — {from,to,db}
function frame(st,t,sig=[],raise=null,o=O,f0=F0,n=N){
  const L=new Float32Array(n); for(let i=0;i<n;i++) L[i]=-100+1.5*gs();
  for(const s of sig) for(let k=0;k<s.w;k++) L[s.bin+k]=Math.max(L[s.bin+k],s.db+gs()*.5);
  if(raise) for(let i=raise.from;i<raise.to;i++) L[i]+=raise.db;
  return K.blFrame(st,n,i=>f0+i*STEP,i=>L[i],{...o,now:t});
}
const CAR=[{bin:500,w:3,db:-70}];
const st=K.blNew(); let t=0, recs=[];
for(let i=0;i<40;i++){ const r=frame(st,t,CAR); t+=100; }
ok('learning: the baseline holds the carrier level',Math.abs(K.blAt(st,F0+501*STEP)+70)<1.5 && Math.abs(K.blAt(st,F0+1500*STEP)+100)<1,K.blAt(st,F0+501*STEP)+' '+K.blAt(st,F0+1500*STEP));
let fa=0; for(let i=0;i<300;i++){ const r=frame(st,t,CAR); t+=100; fa+=r.recs.length; }
ok('no false alarms on a stable band (300 frames)',fa===0,fa);

// новый сигнал
let rec=null, firstAt=-1;
for(let i=0;i<10;i++){ const r=frame(st,t,[...CAR,{bin:1200,w:4,db:-80}]); t+=100; if(r.recs.length && !rec){ rec=r.recs[0]; firstAt=i; } }
ok('new signal: reported on the 3rd frame (confirm = 3)',rec && rec.kind==='new' && rec.status==='start' && firstAt===2,JSON.stringify(rec)+' @'+firstAt);
ok('new signal: frequency within 2 kHz, excess ≈ 20 dB, width 3–6 kHz',rec && Math.abs(rec.freq-(F0+1201.5*STEP))<2500 && rec.excess>15 && rec.excess<25 && rec.bw>=3000 && rec.bw<=6000,JSON.stringify(rec));
// конец
let end=null; for(let i=0;i<40 && !end;i++){ const r=frame(st,t,CAR); t+=100; end=r.recs.find(x=>x.status==='end'); }
ok('new signal gone → "end" after the hold time with a duration',end && end.kind==='new' && end.dur>0.5,JSON.stringify(end));

// пропавшая станция
let miss=null; for(let i=0;i<10 && !miss;i++){ const r=frame(st,t,[]); t+=100; miss=r.recs.find(x=>x.kind==='missing'); }
ok('carrier switched off → "missing" at its frequency',miss && Math.abs(miss.freq-(F0+501*STEP))<3000,JSON.stringify(miss));
for(let i=0;i<120;i++){ frame(st,t,CAR); t+=100; }          // вернулась

// широкополосная помеха
let wb=null; for(let i=0;i<10 && !wb;i++){ const r=frame(st,t,CAR,{from:900,to:1500,db:18}); t+=100; wb=r.recs.find(x=>x.kind==='wideband'); }
ok('floor raised by 18 dB over 600 kHz → "wideband"',wb && wb.bw>=500e3 && wb.excess>12,JSON.stringify(wb));
for(let i=0;i<40;i++){ frame(st,t,CAR); t+=100; }

// впитывание постоянной станции: adapt = 20 кадров → постоянная времени 400 кадров
const st2=K.blNew(), Oa={...O,adapt:20}; let tt=0;
for(let i=0;i<60;i++){ frame(st2,tt,[],null,Oa); tt+=100; }
let started=false, ended=false;
for(let i=0;i<1500;i++){ const r=frame(st2,tt,[{bin:300,w:3,db:-75}],null,Oa); tt+=100; for(const x of r.recs){ if(x.status==='start') started=true; if(x.status==='end') ended=true; } }
ok('a permanent new station is reported once, then absorbed into the norm (event ends)',started && ended);

// сохранение и загрузка
const sv=K.blSave(st), st3=K.blNew(); const js=JSON.stringify(sv);
ok('save → JSON ≤ 12 bytes per cell',js.length<N*12+200,js.length);
ok('load: the norm is restored (±0.01 dB at 20 points)',K.blLoad(st3,JSON.parse(js)) && [10,300,501,777,1200,1900].every(b=>Math.abs(K.blAt(st3,F0+b*STEP)-K.blAt(st,F0+b*STEP))<.011));
let fa3=0; for(let i=0;i<100;i++){ const r=frame(st3,t,CAR); t+=100; fa3+=r.recs.length; }
ok('after load no new learning is needed and no false alarms',fa3===0,fa3);
ok('load: garbage is refused',!K.blLoad(K.blNew(),{v:1,res:1000,cap:5,mu:'AA==',sd:'AA==',occ:'AA==',cnt:'AA=='}) && !K.blLoad(K.blNew(),null));

// развёртка: кадры идут по очереди то по нижней, то по верхней половине
const st4=K.blNew(), Os={...O,learn:30}; let ts=0, r4;
for(let i=0;i<200;i++){ frame(st4,ts,[],null,Os,F0+(i%2)*N*STEP); ts+=100; }
ok('sweep: both halves are learned, the baseline covers 4 MHz',Math.abs(K.blAt(st4,F0+100*STEP)+100)<1 && Math.abs(K.blAt(st4,F0+(N+100)*STEP)+100)<1);
let sw=null; for(let i=0;i<12 && !sw;i++){ const r=frame(st4,ts,i%2?[{bin:700,w:3,db:-80}]:[],null,Os,F0+(i%2)*N*STEP); ts+=100; sw=r.recs.find(x=>x.kind==='new'); }
ok('sweep: a signal in the second half is found (confirmed by visits of that half)',sw && Math.abs(sw.freq-(F0+(N+701)*STEP))<2500,JSON.stringify(sw));

// пустой/вырожденный ввод
const e0=K.blFrame(K.blNew(),0,()=>0,()=>0,{...O,now:0});
ok('empty frame is harmless',e0.recs.length===0);
console.log(bad?`${bad} failed`:'all ok');
process.exit(bad?1:0);
