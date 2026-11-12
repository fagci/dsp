// Sleep Timer: ядро затухания и логика узла (через заглушки движка): node tools/test-sleep.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(a,b,e=1e-6)=>Math.abs(a-b)<e;

// --- ядро ---
const kc=vm.createContext({Math,Number,String});
vm.runInContext(fs.readFileSync(path.join(root,'modules/sleep-kernels.js'),'utf8')+';this.K={slGain,slFmt,SLP_CURVES};',kc);
const K=kc.K;
ok('до начала затухания громкость 1',K.slGain(500,120,'quadratic')===1 && K.slGain(120,120,'cosine')===1);
ok('в конце — 0',K.slGain(0,120,'quadratic')===0 && K.slGain(-5,120,'linear')===0);
ok('quadratic: в середине затухания 0,25',near(K.slGain(60,120,'quadratic'),.25));
ok('cosine: в середине 0,5',near(K.slGain(60,120,'cosine'),.5));
ok('linear: в середине 0,5, на четверти 0,25',near(K.slGain(60,120,'linear'),.5) && near(K.slGain(30,120,'linear'),.25));
for(const c of K.SLP_CURVES){ let mono=true, prev=-1; for(let l=0;l<=130;l+=.5){ const g=K.slGain(l,120,c); if(g<prev-1e-12 || g<0 || g>1) mono=false; prev=g; } ok(`${c}: монотонно 0…1`,mono); }
ok('мусор на входе не даёт NaN',[K.slGain(NaN,10,'x'),K.slGain(5,NaN,'cosine'),K.slGain(undefined,undefined)].every(Number.isFinite));
ok('slFmt: 74 → 1:14, 3725 → 1:02:05, 0 → 0:00, 59.2 → 1:00',K.slFmt(74)==='1:14' && K.slFmt(3725)==='1:02:05' && K.slFmt(0)==='0:00' && K.slFmt(59.2)==='1:00');

// --- узел с заглушками движка ---
const mods={};
const stops=[]; let now=0;
const ctx=vm.createContext({Math,Number,String,Float32Array,Object,Array,isFinite,setTimeout:f=>f(),
  performance:{now:()=>now}, BLOCK:128,
  Eng:{sr:48000,running:true,paused:false,stop(){ stops.push('stop'); this.running=false; },toggle(){ stops.push('pause'); this.paused=true; }},
  def:d=>{ mods[d.id]=d; }, buf:(n,k)=>((n.b||(n.b={}))[k]||(n.b[k]=new Float32Array(128))), setMod:(n,k,v)=>{ n.p[k]=v; }, roText:(n,s)=>{ n.ro=s; }});
vm.runInContext(fs.readFileSync(path.join(root,'modules/sleep-kernels.js'),'utf8')+fs.readFileSync(path.join(root,'modules/sleep.js'),'utf8'),ctx);
const M=mods.sleeptimer;
const mk=(p={})=>{ ctx.Eng.running=true; ctx.Eng.paused=false; const n={p:{min:1,fade:20,curve:'quadratic',action:'stop sound',auto:true,...p}}; M.init(n); return n; };
const ones=new Float32Array(128).fill(1);
const run=(n,sec,I={L:ones,R:ones})=>{ let o; for(let i=0;i<Math.round(sec*48000/128);i++) o=M.process(n,I); return o; };

{ const n=mk(); stops.length=0;
  let o=run(n,.1); ok('auto: отсчёт идёт с первого блока',n.run && n.left<60 && n.left>59.8);
  ok('до затухания звук проходит без изменений',o.gain===1 && o.L.every(v=>v===1) && o.R.every(v=>v===1));
  o=run(n,39); ok('за 20 с до конца затухание ещё не началось (left ≈ 20,9)',o.gain===1,o.gain);
  const g=[]; for(let i=0;i<20;i++){ o=run(n,1); g.push(o.gain); }
  ok('в последние 20 с громкость монотонно падает',g.every((v,i)=>i===0||v<=g[i-1]+1e-9) && g[g.length-1]<.1,g.map(v=>v.toFixed(2)).join(' '));
  o=run(n,2); ok('после конца: тишина, done = 1',o.gain===0 && o.done===1 && o.L.every(v=>v===0));
  ok('действие «stop sound»: движок остановлен ровно один раз',stops.join()==='stop',stops.join()); }
{ const n=mk({action:'pause sound'}); stops.length=0; run(n,61);
  ok('действие «pause sound»: движок на паузе',stops.join()==='pause'); }
{ const n=mk({action:'nothing'}); stops.length=0; run(n,61); run(n,5);
  ok('действие «nothing»: движок не трогали, звук остаётся тихим',stops.length===0 && n.done && run(n,.1).gain===0);
  now+=10000; ok('«nothing» не сбрасывается сам',run(n,.1).gain===0); }
{ const n=mk(); stops.length=0; now=1000; run(n,61); now=1000+4000;     // движок остановили; пользователь нажал Play через 4 с
  const o=run(n,.1); ok('новый запуск после остановки: новая ночь, громкость 1, отсчёт заново',!n.done && n.run && o.gain===1 && n.left>59,JSON.stringify({done:n.done,left:n.left,g:o.gain})); }
{ const n=mk({auto:false}); run(n,5);
  ok('auto выключен: ждёт старта, звук идёт',!n.run && run(n,.1).gain===1);
  run(n,.1,{L:ones,R:ones,start:1}); ok('сигнал на входе start запускает отсчёт',n.run);
  const l1=n.left; run(n,1,{L:ones,R:ones,start:1}); ok('удержание сигнала не перезапускает (только фронт)',n.left<l1);
  run(n,1,{L:ones,R:ones,start:0}); run(n,.1,{L:ones,R:ones,start:1}); ok('новый фронт — отсчёт сначала',n.left>59.7); }
{ const n=mk({min:2,fade:30}); run(n,95);                                 // осталось 25 с — идёт затухание
  const before=run(n,.01).gain; M.params.find(x=>x.n==='extend').fn(n); const after=run(n,.1).gain;
  ok(`+10 min продлевает и возвращает громкость (${before.toFixed(2)} → ${after})`,before<1 && after===1 && n.left>600); }
{ const n=mk(); run(n,10); M.params.find(x=>x.n==='cancel').fn(n); const o=run(n,.01);
  ok('Cancel: отсчёт сброшен',!n.run && n.left===60 && o.gain>=0); }
{ const n=mk(); const o=run(n,.5,{}); ok('нет входа L/R — выход тишина, без NaN',o.L.every(v=>v===0) && o.R.every(v=>v===0)); }
{ const n=mk(); run(n,.1,{L:ones,R:ones,min:5}); ok('вход min меняет минуты',n.p.min===5); }
{ const n=mk({fade:20}); run(n,45); const o=run(n,.5), a=o.L[0], z=o.L[127];
  ok('внутри блока громкость меняется плавно (без ступенек)',Math.abs(a-z)<.05); }

console.log(bad?'FAILED':'all ok'); process.exit(bad?1:0);
