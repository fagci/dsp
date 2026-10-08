// Ядро секундомера: node tools/test-stopwatch.mjs
// Фронты с точностью до доли отсчёта, статистика замеров, формат времени; сам узел — на заглушке движка.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,Array,Number,isFinite});
vm.runInContext(fs.readFileSync(path.join(root,'modules/stopwatch-kernels.js'),'utf8')+
  ';this.K={swEdges,swStat,swAdd,swSd,swFmt};',ctx);
const K=ctx.K;
let bad=0; const eq=(n,a,b)=>{ if(JSON.stringify(a)!==JSON.stringify(b)){ bad++; console.log('FAIL',n,JSON.stringify(a),'!=',JSON.stringify(b)); } else console.log('ok  ',n); };
const near=(n,a,b,e=1e-6)=>{ if(!(Math.abs(a-b)<=e)){ bad++; console.log('FAIL',n,a,'≉',b); } else console.log('ok  ',n); };

// фронт в сигнале: линейная интерполяция пересечения порога
let st={}, x=new Float32Array(8); x[5]=1; x[6]=1; x[7]=1;
let e=K.swEdges(st,x,.5,.05);
eq('one edge',e.length,1); near('edge between 4 and 5',e[0],4.5);
x=new Float32Array(8).fill(1); e=K.swEdges(st,x,.5,.05); eq('level stays high: no edge',e,[]);
x=new Float32Array(8); x[0]=0; e=K.swEdges(st,x,.5,.05); eq('falling edge: none',e,[]);
x=new Float32Array(8); x[3]=.25; x[4]=.75; e=K.swEdges(st,x,.5,.05); near('quarter-sample interpolation',e[0],3.5);
// стык блоков: последний отсчёт предыдущего блока
st={}; K.swEdges(st,new Float32Array([0,0,0,0]),.5,.05);
e=K.swEdges(st,new Float32Array([1,1,1,1]),.5,.05); near('edge across block boundary',e[0],-0.5);
// гистерезис: шум около порога — один фронт
st={}; e=K.swEdges(st,new Float32Array([0,.52,.48,.53,.47,.9]),.5,.05); eq('hysteresis: single edge',e.length,1); near('edge at the real crossing',e[0],4+(.5-.47)/(.9-.47),1e-6);
// число: первое значение — база, не фронт; импульс 0→1 — фронт в начале блока
st={}; eq('first number is baseline',K.swEdges(st,1,.5,.05),[]);
eq('number 1→0 no edge',K.swEdges(st,0,.5,.05),[]); eq('number 0→1 edge at 0',K.swEdges(st,1,.5,.05),[0]);
eq('number stays high',K.swEdges(st,1,.5,.05),[]);
// два фронта в одном блоке
st={}; e=K.swEdges(st,new Float32Array([0,1,1,0,0,1]),.5,.05); eq('two edges',e.length,2);
// статистика
let s=K.swStat(); for(const v of [2,4,4,4,5,5,7,9]) K.swAdd(s,v);
eq('n',s.n,8); near('mean',s.mean,5); near('sd (sample)',K.swSd(s),Math.sqrt(32/7)); eq('min/max',[s.min,s.max],[2,9]);
eq('sd of one',K.swSd(K.swAdd(K.swStat(),3)),0);
// формат
eq('µs',K.swFmt(.1234),'123.4 µs'); eq('ms',K.swFmt(12.3456),'12.346 ms'); eq('s',K.swFmt(2500),'2.500 s'); eq('min',K.swFmt(125000),'2 min 5.000 s'); eq('nan',K.swFmt(NaN),'—');

// узел на заглушке движка: sample-часы, сигнал start/stop
const BLOCKN=64, SR=48000;
const defs={}, ctx2=vm.createContext({Math,Float32Array,Array,Number,isFinite,Object,String,performance:{now:()=>0,timeOrigin:1.7e12},
  def:d=>{ defs[d.id]=d; }, BLOCK:BLOCKN, Eng:{sr:SR}, cronParse(){}, cronNext(){}, buf(){}, setMod(){}, clamp(){}});
vm.runInContext(fs.readFileSync(path.join(root,'modules/stopwatch-kernels.js'),'utf8'),ctx2);
vm.runInContext(fs.readFileSync(path.join(root,'modules/sequencer.js'),'utf8').replace(/^const /gm,'var '),ctx2);
const D=defs.stopwatch, n={p:{clock:'samples',mode:'start/stop',again:'ignore',thr:.5}}; D.init(n);
const pulse=(at)=>{ const a=new Float32Array(BLOCKN); a[at]=1; a[at+1]=1; return a; };
let o=D.process(n,{start:pulse(10),stop:null,reset:null}); eq('running after start',o.run,1);
D.process(n,{start:new Float32Array(BLOCKN),stop:null,reset:null});
o=D.process(n,{start:null,stop:pulse(30),reset:null});
// start между отсчётами 9 и 10 → 9.5 (порог .5 при шаге 0→1), stop: блок 2, отсчёт 29.5 → 2*64+29.5-9.5 = 148 отсчётов
near('measured ms (sample clock)',o.ms,148/SR*1000,1e-9); eq('rec emitted once',o.rec.length,1);
near('rec ms matches',o.rec[0].ms,148/SR*1000,1e-9); eq('rec fields',Object.keys(o.rec[0]),['n','start','end','ms','clock']);
near('rec end-start',o.rec[0].end-o.rec[0].start,o.rec[0].ms,1e-9); eq('done pulse',o.done,1);
o=D.process(n,{start:null,stop:null,reset:null}); eq('done pulse lasts one block',[o.done,o.rec],[0,null]);
// число-импульсы + режим toggle
const m={p:{clock:'samples',mode:'toggle',again:'ignore',thr:.5}}; D.init(m);
D.process(m,{start:0}); D.process(m,{start:1}); D.process(m,{start:0}); D.process(m,{start:0}); D.process(m,{start:0});
o=D.process(m,{start:1}); near('toggle: 4 blocks',o.ms,4*BLOCKN/SR*1000,1e-9); eq('toggle stopped',o.run,0);
// текстовые события: новое значение — событие, то же самое — нет
const t={p:{clock:'samples',mode:'start/stop',again:'ignore',thr:.5}}; D.init(t);
D.process(t,{start:'go',stop:null}); D.process(t,{start:'go',stop:null}); eq('same text: still running',t.run,true);
D.process(t,{start:null,stop:'ack'}); eq('text stop',t.run,false);
// reset
D.process(t,{reset:1}); D.process(t,{reset:0}); o=D.process(t,{reset:1}); eq('reset clears stats',o.n,0);
console.log(bad?`${bad} FAILED`:'all ok'); process.exit(bad?1:0);
