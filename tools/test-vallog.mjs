// Value Log и перенос лога a–d из Table: node tools/test-vallog.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const rd=f=>fs.readFileSync(path.join(root,f),'utf8');
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };

const defs={};
const ctx=vm.createContext({console,BLOCK:128,Eng:{sr:128*50},def:d=>{ defs[d.id]=d; },recFmt:v=>String(v)});
vm.runInContext(rd('modules/vallog.js'),ctx);
const D=defs.vallog;
const mk=p=>{ const n={p:{}}; for(const q of D.params) if('d' in q) n.p[q.n]=q.d; Object.assign(n.p,p); D.init(n); return n; };
const run=(n,I,blocks)=>{ const out=[]; for(let i=0;i<blocks;i++){ const o=D.process(n,I); if(o.rec) out.push(...o.rec); } return out; };

let n=mk({period:1,names:'lvl,crest'});
let out=run(n,{a:-20,b:3.5},125);
ok('a row per period with a timestamp and the names',out.length===2 && out[0].lvl===-20 && out[0].crest===3.5 && typeof out[0].t==='number',JSON.stringify(out));
ok('unwired inputs are not written',!('c' in out[0]) && !('d' in out[0]));
ok('nothing wired — no row',run(mk({period:1}),{},120).length===0);
ok('a name that is missing falls back to the input letter',run(mk({period:1,names:'x'}),{a:1,b:2},60)[0].b===2);
n=mk({period:0});
ok('period 0: silent until trig or the button',run(n,{a:1},200).length===0);
const tr=[]; for(const v of [0,1,1,0,1]){ const o=D.process(n,{a:5,trig:v}); if(o.rec) tr.push(o.rec[0].a); }
ok('a trig edge writes one row',tr.length===2);
n.go=true;
ok('the button writes one row',D.process(n,{a:7}).rec[0].a===7 && n.go===false);
ok('count counts the rows',n.count===3);

// перенос из Table
const cg=rd('core-graph.js');
const mctx=vm.createContext({console});
vm.runInContext(cg.slice(cg.indexOf('const MIGRATE={'),cg.indexOf('function deserialize'))+';this.migrate=migrate;',mctx);
const mig=o=>JSON.parse(JSON.stringify(mctx.migrate(JSON.parse(JSON.stringify(o)))));
const old={nodes:[{id:'n1',type:'table',x:600,y:40,p:{list:'logs/x',log:true,period:2,names:'p,q,r,s',capture:0}},{id:'n2',type:'osc',x:0,y:0,p:{}},{id:'n3',type:'osc',x:0,y:0,p:{}}],
  edges:[{from:'n2',fp:'out',to:'n1',tp:'a'},{from:'n3',fp:'out',to:'n1',tp:'d'},{from:'n2',fp:'out',to:'n1',tp:'rec'}]};
const m=mig(old), vl=m.nodes.find(x=>x.type==='vallog'), t=m.nodes.find(x=>x.id==='n1');
const E=(f,fp,to,tp)=>m.edges.some(e=>e.from===f && e.fp===fp && e.to===to && e.tp===tp);
ok('a Table with log gets a Value Log',!!vl && vl.p.period===2 && vl.p.names==='p,q,r,s');
ok('the log parameters leave the table',!('log' in t.p) && !('period' in t.p) && !('names' in t.p) && t.p.list==='logs/x');
ok('a–d move to the logger, rec of the logger goes to the table',E('n2','out',vl.id,'a') && E('n3','out',vl.id,'d') && E(vl.id,'rec','n1','rec') && E('n2','out','n1','rec'));
ok('migration is idempotent',mig(m).nodes.length===m.nodes.length && mig(m).edges.length===m.edges.length);
const plain=mig({nodes:[{id:'n1',type:'table',x:0,y:0,p:{list:'a',period:5,names:'z'}}],edges:[]});
ok('a table without log gets nothing, stale keys are dropped',plain.nodes.length===1 && !('period' in plain.nodes[0].p));
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad?1:0);
