// Окно 'sa' ведёт диапазон развёртки USB SDR: перенос данных, буферы, порядок шагов, троттлинг: node tools/test-sweepview.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const src=fs.readFileSync(path.join(root,'modules/sources.js'),'utf8');
// функция/константа верхнего уровня — от начала до парной скобки
function grab(name){
  const i=src.search(new RegExp('^(async )?function '+name+'\\(','m')); if(i<0) throw new Error('нет '+name);
  let d=0, j=src.indexOf('{',src.indexOf(')',i));
  for(let k=j;k<src.length;k++){ const c=src[k]; if(c==='{') d++; else if(c==='}' && --d===0) return src.slice(i,k+1); }
  throw new Error('скобки '+name);
}
const consts=src.match(/^const SDR_SWEEP_MAX_BINS=[^\n]*\n/m)[0]+src.match(/^const SDR_SWEEP_APPLY_MS=[^\n]*\n/m)[0]+src.match(/^const SDR_HW_RATE=[^\n]*\n/m)[0];
let now=1000;
const ctx=vm.createContext({Math,Number,Float32Array,Float64Array,Uint8Array,Array,Infinity,Error,
  performance:{now:()=>now}, Graph:{order:1,edges:[]}, clamp:(v,a,b)=>Math.min(b,Math.max(a,v)), window_:(k,N)=>new Float32Array(N).fill(1), sdrConv:()=>0});
vm.runInContext(consts+['sdrSweepPlan','sdrSweepNextHop','sdrTuneRange','sdrSweepView','sdrSweepMaxSpan','sdrSweepWant','sdrSweepApplyWant'].map(grab).join('\n')+
  ';this.K={sdrSweepPlan,sdrSweepNextHop,sdrTuneRange,sdrSweepView,sdrSweepWant,sdrSweepApplyWant};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const mkNode=(over={})=>{
  const n={p:{swLo:88,swHi:108,swFft:'1024',swUse:.8,swOvl:20,swHw:false,sweep:true}, sourceRate:2.4e6, dev:{kind:'rtl',tunerName:'R820T'}, sw:null, set:{}};
  n.set.swLo=v=>{ n.p.swLo=v; }; n.set.swHi=v=>{ n.p.swHi=v; };
  Object.assign(n.p,over); return n;
};

// 1. план и перенос данных при сдвиге
{
  const n=mkNode(), a=K.sdrSweepPlan(n,false);
  for(let j=0;j<a.spec.size;j++){ a.spec.mag[j]=a.spec.freqs[j]/1e9; a.peak.mag[j]=1+a.spec.freqs[j]/1e9; }
  a.spec.rev=7; a.peak.rev=7;
  const oldMag=a.spec.mag, snap=Float32Array.from(oldMag);
  n.p.swLo=98; n.p.swHi=118;
  const b=K.sdrSweepPlan(n,false);
  ok('новый план — другой объект', b!==a && b.lo===98e6);
  ok('буфер чередуется: старая панорама не тронута', b.spec.mag.buffer!==oldMag.buffer && oldMag.every((v,i)=>v===snap[i]));
  let maxErr=0, cmp=0;
  for(let j=0;j<b.spec.size;j++){ const f=b.spec.freqs[j]; if(f<=108e6-3*b.binHz){ maxErr=Math.max(maxErr,Math.abs(b.spec.mag[j]-f/1e9)); cmp++; } }
  ok('перекрытие перенесено по частоте', cmp>3000 && maxErr<=a.binHz/1e9,maxErr);
  ok('пик перенесён', Math.abs(b.peak.mag[10]-(1+b.spec.freqs[10]/1e9))<=a.binHz/1e9);
  ok('rev не сброшен (смена диапазона — не строка водопада)', b.spec.rev===7 && b.peak.rev===7);
  ok('новый край пуст', b.spec.mag[b.spec.size-1]===0);
  ok('шаги правого края — fresh, левого — нет', b.fresh && b.fresh[b.hops-1]===1 && b.fresh[0]===0);
  ok('проход начинается с первого fresh-шага', b.k===b.fresh.indexOf(1) && b.k>0, b.k);
  ok('оси согласованы', b.spec.freqs.length===b.spec.mag.length && b.spec.size===b.spec.mag.length && b.peak.mag.length===b.spec.size);
  ok('описание панорамы у спектра: границы тюнера и потолок ширины', b.spec.sweepView && b.spec.sweepView.min>0 && b.spec.sweepView.maxSpan>0);
  ok('без провода wired=false (окно к панораме привязано)', b.spec.sweepView.wired===false);
  n.id=5; ctx.Graph.edges.push({from:9,fp:'viewLo',to:5,tp:'swLo'}); ctx.Graph.order++;
  ok('провод viewLo→swLo включает wired', K.sdrSweepView(n).wired===true);
  ctx.Graph.edges.length=0; ctx.Graph.order++;
  ok('провод убрали — wired снова false', K.sdrSweepView(n).wired===false);
  // третий план — ёмкость первого буфера переиспользуется (без новой аллокации)
  const buf0=a.spec.mag.buffer;
  n.p.swLo=100; n.p.swHi=120;
  const c=K.sdrSweepPlan(n,false);
  ok('буфер переиспользуется при той же ширине', c.spec.mag.buffer===buf0);
  // тот же ключ — тот же план
  ok('тот же диапазон — тот же план', K.sdrSweepPlan(n,false)===c);
}
// 2. порядок шагов: сначала fresh, потом круг
{
  const sw={hops:6, k:4, fresh:Uint8Array.from([1,0,0,0,0,1]), hdone:new Uint8Array(6)};
  const seq=[]; sw.k=5; seq.push(sw.k); sw.hdone[5]=1;
  for(let i=0;i<5;i++){ sw.k=K.sdrSweepNextHop(sw); seq.push(sw.k); sw.hdone[sw.k]=1; }
  ok('fresh-шаги идут первыми, затем обычный круг', seq.join()==='5,0,1,2,3,4', seq.join());
  ok('fresh снят после обхода', sw.fresh===null);
}
// 3. запрос диапазона: границы тюнера, минимальная ширина, потолок по бинам
{
  const n=mkNode(); K.sdrSweepWant(n,100e6,100.5e6);
  const w=n._swWant, span=w[1]-w[0];
  ok('узкое окно → шаг не уже одного шага развёртки', span>=1.9e6 && span<=2.5e6, span);
  ok('центр сохранён', Math.abs((w[0]+w[1])/2-100.25e6)<1);
  K.sdrSweepWant(n,5e6,60e6); ok('ниже диапазона тюнера — сдвиг внутрь', n._swWant[0]>=24e6 && Math.abs(n._swWant[1]-n._swWant[0]-55e6)<1,n._swWant);
  K.sdrSweepWant(n,0,5e9); ok('шире тюнера — весь диапазон тюнера', n._swWant[0]===24e6 && n._swWant[1]===1766e6, n._swWant);
  const m=mkNode({swFft:'8192'}); K.sdrSweepWant(m,0,5e9);
  const bins=(m._swWant[1]-m._swWant[0])/(2.4e6/8192);
  ok('потолок по числу бинов (sweep не выключится ошибкой)', bins<=4e6, bins);
  const full=K.sdrSweepPlan(mkNode(),false); ok('весь RTL при FFT 1024 собирается', !!K.sdrSweepPlan((()=>{const q=mkNode({swLo:24,swHi:1766}); return q;})(),false));
  const hk=mkNode(); hk.dev={kind:'hackrf',tunerName:'HackRF'}; K.sdrSweepWant(hk,0,9e9);
  ok('HackRF: 1…6000 МГц', hk._swWant[0]===1e6 && hk._swWant[1]===6000e6, hk._swWant);
}
// 4. применение: не чаще раза в 120 мс, последнее значение не теряется
{
  const n=mkNode(); now=5000;
  n._swWant=[100e6,110e6]; K.sdrSweepApplyWant(n);
  ok('первый запрос применён сразу', n.p.swLo===100 && n.p.swHi===110 && !n._swWant);
  n._swWant=[101e6,111e6]; now+=50; K.sdrSweepApplyWant(n);
  ok('в окне троттлинга — ждёт', n.p.swLo===100 && n._swWant);
  n._swWant=[102e6,112e6]; now+=100; K.sdrSweepApplyWant(n);
  ok('потом применено последнее значение', n.p.swLo===102 && n.p.swHi===112 && !n._swWant);
}
console.log(bad?`\n${bad} FAIL`:'\nвсё ок'); process.exit(bad?1:0);
