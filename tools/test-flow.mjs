// Rec Queue: node tools/test-flow.mjs
import fs from 'node:fs';
import vm from 'node:vm';
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const ctx=vm.createContext({RegExp,Error,Math,Number,String,Object,Array,JSON,Set,Infinity});
vm.runInContext(fs.readFileSync(new URL('../modules/flow-kernels.js',import.meta.url),'utf8')+';this.K={rqNew,rqPush,rqStep,ruleApply,casesNum,casesParse,casesSource,casesStep,cmdTpls,cmdFields,cmdNames,cmdFmtVal,cmdFill,wuNew,wuTest,wuStep,winNew,winStep}',ctx);
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
// Command Templates
{ ok('cmdTpls: one per line, comments out',JSON.stringify(K.cmdTpls('TUNE {f}\n\n  MODE {m} \n# note\n// note'))===JSON.stringify(['TUNE {f}','MODE {m}']));
  ok('cmdFields: names in order, no dups',JSON.stringify(K.cmdFields('TUNE {f} MODE {m} {f}'))===JSON.stringify(['f','m']));
  ok('cmdFields: bad names are not fields',K.cmdFields('A {x y} B {} C {ok_1}').join(',')==='ok_1');
  ok('cmdNames: union over templates',JSON.stringify(K.cmdNames(['TUNE {f}','MODE {m} {f}']))===JSON.stringify(['f','m']));
  ok('cmdFill: substitution',K.cmdFill('TUNE {f}',{f:145500000})==='TUNE 145500000');
  ok('cmdFill: float trimmed',K.cmdFill('SET {v}',{v:145.5})==='SET 145.5' && K.cmdFill('SET {v}',{v:1/3})==='SET 0.333333');
  ok('cmdFill: missing value keeps the placeholder',K.cmdFill('TUNE {f} MODE {m}',{f:1})==='TUNE 1 MODE {m}');
  ok('cmdFmtVal: non-finite is empty',K.cmdFmtVal(Infinity)==='' && K.cmdFmtVal(null)===''); }
// Wait Until: условие держится stable секунд подряд; сбой сбрасывает отсчёт; таймаут; повторный arm
{ const st=K.wuNew(), o={op:'<',a:0.5,b:1,stable:1,timeout:5};
  let r=K.wuStep(st,{arm:false,v:0},0,o); ok('wait: idle until armed',!r.done && !r.timeout && !st.on);
  r=K.wuStep(st,{arm:true,v:1},0,o); ok('wait: armed, condition false',!r.done && st.on);
  r=K.wuStep(st,{v:0},100,o); r=K.wuStep(st,{v:0},900,o); ok('wait: 0.8 s held is not enough',!r.done && Math.abs(st.held-0.8)<1e-9);
  r=K.wuStep(st,{v:1},1000,o); ok('wait: a glitch resets the count',!r.done && st.since===null);
  r=K.wuStep(st,{v:0},1100,o); r=K.wuStep(st,{v:0},2000,o); ok('wait: 0.9 s after the glitch is still not enough',!r.done);
  r=K.wuStep(st,{v:0},2100,o); ok('wait: held 1 s → done once, ok=1',r.done===true && st.ok===1 && !st.on && !K.wuStep(st,{v:0},2200,o).done);
  K.wuStep(st,{arm:true,v:1},3000,o); r=K.wuStep(st,{v:1},7900,o); ok('wait: not yet 5 s',!r.timeout);
  r=K.wuStep(st,{v:1},8000,o); ok('wait: timeout after 5 s, ok=0',r.timeout===true && st.ok===0 && !st.on);
  const z=K.wuNew(); K.wuStep(z,{arm:true,v:1},0,{...o,timeout:0}); ok('wait: timeout 0 — never gives up',!K.wuStep(z,{v:1},1e9,{...o,timeout:0}).timeout);
  const i=K.wuNew(); K.wuStep(i,{arm:true,v:5},0,{op:'in a…b',a:10,b:2,stable:0,timeout:0}); ok('wait: in a…b works with reversed bounds, stable 0 → at once',i.ok===1);
  ok('wait: no value never satisfies',!K.wuTest(null,'<',1) && !K.wuTest(NaN,'>',1));
  ok('wait: operators',K.wuTest(2,'>=',2) && K.wuTest(2,'==',2) && K.wuTest(3,'!=',2) && !K.wuTest(2,'<',2)); }
// Measure Window
{ const st=K.winNew(), o={mode:'time',window:2,samples:3};
  K.winStep(st,{arm:true,v:-50},0,o); K.winStep(st,{v:-40},500,o); K.winStep(st,{v:-60},1000,o);
  let r=K.winStep(st,{v:-50},1999,o); ok('window: still collecting before 2 s',!r.done && st.n===4);
  r=K.winStep(st,{v:-30},2000,o); ok('window: done at 2 s with avg / min / max / n',r.done && st.n===5 && Math.abs(st.avg-(-46))<1e-9 && st.min===-60 && st.max===-30 && st.ok===1);
  ok('window: done is a single pulse',!K.winStep(st,{v:-1},2100,o).done && st.n===5);
  const e=K.winNew(); K.winStep(e,{arm:true,v:null},0,o); r=K.winStep(e,{v:null},2000,o); ok('window: no samples → done with ok=0, avg null',r.done && e.ok===0 && e.avg===null && e.min===null);
  const m=K.winNew(), os={mode:'samples',window:99,samples:3};
  K.winStep(m,{arm:true,v:1},0,os); K.winStep(m,{v:2},1,os); r=K.winStep(m,{v:3},2,os); ok('window: mode samples — done after 3',r.done && m.avg===2); }

 console.log(bad?bad+' FAILED':'all ok'); process.exit(bad?1:0);