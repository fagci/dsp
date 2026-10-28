// Rec Queue: node tools/test-flow.mjs
import fs from 'node:fs';
import vm from 'node:vm';
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const ctx=vm.createContext({RegExp,Error,Math,Number,String,Object,Array,JSON,Set,Infinity});
vm.runInContext(fs.readFileSync(new URL('../modules/flow-kernels.js',import.meta.url),'utf8')+';this.K={rqNew,rqPush,rqStep,ruleApply,casesNum,casesParse,casesSource,casesStep}',ctx);
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

// шаблон команды Rule
ok('ruleApply: plain values pass through, $field substitutes',JSON.stringify(K.ruleApply({cmd:'vibrate',ms:'$dur',name:'x'},{dur:500}))===JSON.stringify({cmd:'vibrate',ms:500,name:'x'}));
ok('ruleApply: missing field or no record keeps the literal string',JSON.stringify(K.ruleApply({a:'$missing'},{b:1}))===JSON.stringify({a:'$missing'}) && JSON.stringify(K.ruleApply({a:'$x'},null))===JSON.stringify({a:'$x'}));
ok('ruleApply: bare "$" is not touched',K.ruleApply({a:'$'},{'':1}).a==='$');

// Cases
ok('casesNum: suffixes and plain',K.casesNum('433.92M')===433.92e6 && K.casesNum('145.5 MHz')===145.5e6 && K.casesNum('2k')===2000 && K.casesNum('1e3')===1000 && K.casesNum('-3')===-3);
ok('casesNum: expression is not a number',K.casesNum('a*2')===null && K.casesNum('')===null);
{ const p=K.casesParse('# c\nhome: a==1 => 145.5M\naway: a==0 => 433.92M => {"cmd":"vibrate"}\nr.x ? 1 : 2 => a*2\nelse: true');
  ok('casesParse: names, values, commands',p.rows.length===4 && p.rows[0].name==='home' && p.rows[0].val===145.5e6 && p.rows[1].cmd.cmd==='vibrate' && !p.errors.length);
  ok('casesParse: ternary is not a name, expression value',p.rows[2].name==='case 3' && p.rows[2].cond==='r.x ? 1 : 2' && p.rows[2].valExpr==='a*2');
  ok('casesParse: no value',p.rows[3].name==='else' && p.rows[3].val===null && p.rows[3].cond==='true');
  ok('casesParse: bad command JSON is reported with the line',K.casesParse('a => 1 => {oops}').errors[0].startsWith('line 1: command JSON'));
  ok('casesSource: one pair per row',K.casesSource(p.rows).split('],[').length===4); }
{ const st={cur:-1,cand:-1,since:0};
  ok('casesStep: first state is taken at once',K.casesStep(st,1,0,5)===true && st.cur===1);
  ok('casesStep: no match holds the state',K.casesStep(st,-1,10,5)===false && st.cur===1);
  ok('casesStep: settle delays a switch',K.casesStep(st,0,100,5)===false && K.casesStep(st,0,3000,5)===false && st.cur===1);
  ok('casesStep: settle passes',K.casesStep(st,0,5200,5)===true && st.cur===0);
  K.casesStep(st,1,6000,5); K.casesStep(st,0,7000,5);
  ok('casesStep: flapping back resets the timer',K.casesStep(st,0,12100,5)===false && st.cur===0); }
 console.log(bad?bad+' FAILED':'all ok'); process.exit(bad?1:0);
