// Rec Queue: node tools/test-flow.mjs
import fs from 'node:fs';
import vm from 'node:vm';
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const ctx=vm.createContext({Math,Number,String,Object,Array,JSON,Set,Infinity});
vm.runInContext(fs.readFileSync(new URL('../modules/flow-kernels.js',import.meta.url),'utf8')+';this.K={rqNew,rqPush,rqStep}',ctx);
const K=ctx.K;
let s=K.rqNew();
ok('push: key dedupe, max',K.rqPush(s,[{a:1},{a:2},{a:1},{b:3}],'a',10)===2 && s.q.length===2 && K.rqPush(s,[{a:3},{a:4}],'a',3)===1);
// await-режим: одна запись, пока нет ack
s=K.rqNew(); K.rqPush(s,[{n:1},{n:2},{n:3}],'',10);
const o={mode:'await',timeout:0};
let r=K.rqStep(s,{},0,o); ok('await: the first goes immediately',r.item.n===1);
r=K.rqStep(s,{},100,o); ok('await: nothing until ack',r.item===null);
r=K.rqStep(s,{ack:true},200,o); ok('await: ack releases the next',r.item.n===2);
r=K.rqStep(s,{ack:true},300,o); ok('await: third',r.item.n===3);
r=K.rqStep(s,{},350,o); ok('await: last one is still waiting for ack, not done',r.item===null && !r.done);
r=K.rqStep(s,{ack:true},400,o); ok('await: ack after the last → done once',r.done===true && K.rqStep(s,{},500,o).done===false);
// таймаут
s=K.rqNew(); K.rqPush(s,[{n:1},{n:2}],'',10);
const ot={mode:'await',timeout:2};
K.rqStep(s,{},0,ot); ok('timeout: waits',K.rqStep(s,{},1500,ot).item===null);
ok('timeout: moves on after 2 s without ack',K.rqStep(s,{},2100,ot).item.n===2);
// interval
s=K.rqNew(); K.rqPush(s,[{n:1},{n:2},{n:3}],'',10);
const oi={mode:'interval',interval:1};
ok('interval: first at once, next only after a second',K.rqStep(s,{},0,oi).item.n===1 && K.rqStep(s,{},500,oi).item===null && K.rqStep(s,{},1000,oi).item.n===2);
ok('interval: next forces the item',K.rqStep(s,{next:true},1100,oi).item.n===3);
ok('interval: done after the queue ran dry',K.rqStep(s,{},1200,oi).done===true);
// manual
s=K.rqNew(); K.rqPush(s,[{n:1},{n:2}],'',10);
const om={mode:'manual'};
ok('manual: only on next',K.rqStep(s,{},0,om).item===null && K.rqStep(s,{next:true},10,om).item.n===1 && K.rqStep(s,{},20,om).item===null && K.rqStep(s,{next:true},30,om).item.n===2);
// clear
s=K.rqNew(); K.rqPush(s,[{k:1},{k:2}],'k',10); K.rqStep(s,{clear:true},0,o);
ok('clear: empties and forgets the keys',s.q.length===0 && K.rqPush(s,[{k:1}],'k',10)===1);
console.log(bad?bad+' FAILED':'all ok'); process.exit(bad?1:0);
