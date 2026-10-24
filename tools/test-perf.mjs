// core-perf.js: Dev/Perf/Idle/Badge/Locks с откатом на отсутствующие API (без DOM)
import fs from 'fs';
import vm from 'vm';
const src=fs.readFileSync(new URL('../core-perf.js',import.meta.url),'utf8');
let bad=0;
const check=(n,ok)=>{ console.log((ok?'ok   ':'FAIL ')+n); if(!ok) bad++; };
const load=nav=>{ const g={navigator:nav,performance:{now:()=>Date.now(),measure(){}},setTimeout,Promise,console}; g.self=g; vm.createContext(g); vm.runInContext(src,g); return g; };

let g=load({hardwareConcurrency:2,deviceMemory:1});
check('слабое устройство распознано',g.Dev.low && g.Dev.quality===0.5 && g.Dev.workers===1);
g=load({hardwareConcurrency:16,deviceMemory:8});
check('сильное устройство',!g.Dev.low && g.Dev.workers===8);
check('Perf.time возвращает значение и копит метки',g.Perf.time('x',()=>42)===42 && g.Perf.marks.x.n===1);
try{ g.Perf.time('y',()=>{ throw new Error('e'); }); }catch(e){}
check('Perf.time считает и при исключении',g.Perf.marks.y.n===1);
check('Perf.report — строка с меткой',/x: 1×/.test(g.Perf.report()));
check('Idle.run без scheduler/rIC выполняется',await g.Idle.run(()=>7)===7);
check('Idle.yield без scheduler.yield',(await g.Idle.yield(),true));
check('Locks.run без API выполняет fn',await g.Locks.run('a',()=>5)===5);
check('Locks.tryRun без API выполняет fn',await g.Locks.tryRun('a',()=>6)===6);
let got=null;
g=load({locks:{request:(n,o,f)=>{ got={n,o}; return Promise.resolve(f(o.ifAvailable?null:{})); }}});
check('tryRun: занята — fn не вызывается',await g.Locks.tryRun('s',()=>1)===null && got.n==='dsp:s' && got.o.ifAvailable===true);
check('run: берёт блокировку',await g.Locks.run('s',l=>!!l)===true);
let b=[]; g=load({setAppBadge:()=>{ b.push('set'); return Promise.resolve(); },clearAppBadge:()=>{ b.push('clr'); return Promise.resolve(); }});
g.Badge.set(true); g.Badge.set(false);
check('Badge: set/clear',b.join()==='set,clr');
g=load({}); g.Badge.set(true); check('Badge без API не падает',true);
console.log(bad?'FAILED':'all ok'); process.exit(bad?1:0);
