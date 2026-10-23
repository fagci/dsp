// Row Player и перенос хода по строкам из Table: node tools/test-rowplayer.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const rd=f=>fs.readFileSync(path.join(root,f),'utf8');
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const tick=()=>new Promise(r=>setTimeout(r,5));

/* ---------- узел ---------- */
const defs={}, store={lists:{}};
const edges=[];
const ctx=vm.createContext({console,performance,setTimeout,
  matchMedia:()=>({matches:false}), BANDPLAN_PRESETS:{}, BLOCK:128, Eng:{sr:128*50},   // 50 блоков в секунду
  clamp:(v,a,b)=>v<a?a:v>b?b:v, def:d=>{ defs[d.id]=d; }, defGroups(){},
  Graph:{edges}, delEdge(){}, portsOf(){ return []; }, rebuildNode(){}, markTopoDirty(){},
  recFmt:v=>String(v), hostlistDedupFieldNames:a=>a, hostlistCoerce:v=>v, geoCsvParse:()=>[], csvCell:v=>v,
  ListDB:{rev:0}, geoDist:(a,b,c,d)=>Math.hypot(c-a,(d-b)*Math.cos(a*Math.PI/180))*111.2, geoBearing:()=>0, tblReadList:async(n,name)=>{ const t=store.lists[name]; if(!t) throw new Error('no list'); return {cols:t.cols.slice(),rows:t.rows.map(r=>({...r}))}; }});
const tb=rd('modules/table.js');
vm.runInContext(rd('modules/sequencer.js'),ctx);
vm.runInContext(tb.slice(tb.indexOf('const TBL_PATCH'),tb.indexOf('/* ---------- разбор файлов')),ctx);
vm.runInContext(rd('modules/rowplayer.js'),ctx);
const D=defs.rowplayer;
ok('node is registered',!!D && D.cat==='Sources');

const mk=(p={},cols=[])=>{
  const n={id:'n1',type:'rowplayer',p:{}};
  for(const q of D.params) if('d' in q) n.p[q.n]=q.d;
  Object.assign(n.p,p); if(cols.length) n.p.cols=cols;
  D.init(n); return n;
};
const run=(n,I,blocks)=>{ const out=[]; for(let i=0;i<blocks;i++){ const o=D.process(n,I); if(o.rec) out.push(...o.rec); } return out; };
const rows=[{name:'A',freq:100,dwell:1},{name:'B',freq:200,dwell:1},{name:'C',freq:300,dwell:1}];

// провод rows
let n=mk({advance:'rate',rate:5,loop:true,initial:true});
const o0=D.process(n,{});
ok('no source: nothing is played',o0.rec===null && o0.row===0);
let out=run(n,{rows},60);
ok('rows wire: first row at start, then in order at rows/s',out.slice(0,4).map(r=>r.name).join()==='A,B,C,A',out.map(r=>r.name).join());
ok('ports follow the columns of the rows',n.p.cols.join()==='name,freq,dwell' && D.outs(n).some(p=>p.n==='freq') && D.outs(n).some(p=>p.n==='done'));
const o1=D.process(n,{rows});
ok('column values go to their ports',o1.freq===n.cur.freq && o1.name===n.cur.name);
const fr=mk({advance:'rate',rate:0,initial:true});
run(fr,{rows:[{lo:100e6,hi:110e6,label:'x'}]},3);
const of=D.process(fr,{rows:[{lo:100e6,hi:110e6,label:'x'}]});
ok('lo / hi columns give mid and span',D.outs(fr).some(p=>p.n==='mid') && of.mid===105e6 && of.span===10e6,JSON.stringify(of));

// триггер
n=mk({advance:'rate',rate:0,initial:false,loop:false});
D.process(n,{rows});
const steps=[]; for(const v of [0,1,0,1,0,1,0,1,0]){ const o=D.process(n,{rows,trig:v}); if(o.rec) steps.push(o.rec[0].name); }
ok('trig edge steps to the next row; the end stops without loop',steps.join()==='B,C' && n.done,steps.join());

// набор дописывают на ходу: позиция остаётся
n=mk({advance:'rate',rate:0,initial:true});
D.process(n,{rows}); D.process(n,{rows,row:2});
const grown=[...rows,{name:'D',freq:400,dwell:1}];
D.process(n,{rows:grown});
ok('a longer set keeps the position',n.idx===1 && n.rows.length===4);
D.process(n,{rows:rows.slice(0,1)});
ok('a shorter set clamps and restarts',n.idx===0 && n.rows.length===1);

// ссылка на хранилище
store.lists['radio/air']={cols:['name','freq'],rows:[{name:'X',freq:1},{name:'Y',freq:2}]};
n=mk({list:'radio/air',advance:'rate',rate:10,loop:true,initial:true});
D.process(n,{}); await tick();
out=run(n,{},12);
ok('list by reference: rows are read from storage',n.rows.length===2 && out.length>=2 && out[0].name==='X',JSON.stringify(out));
ok('and the ports come from its columns',n.p.cols.join()==='name,freq');
store.lists['radio/air'].rows.push({name:'Z',freq:3});
ctx.ListDB.rev++; n.listAt=-1e9;
D.process(n,{}); await tick();
ok('storage edit is picked up',n.rows.length===3);
const before=n.readTok;
D.process(n,{}); D.process(n,{});
ok('no storage change — no reread',n.readTok===before);
store.lists['other']={cols:['name'],rows:[{name:'Q'}]};
D.process(n,{list:'other'}); await tick();
ok('list input overrides the field and starts over',n.rows.length===1 && n.idx===0 && n.listName==='other');
D.process(n,{rows});
ok('wire overrides the list',n.src===rows && n.rows.length===3);
D.process(n,{list:'nope'}); await tick();
ok('wire gone: back to the list; a missing list is an error text',n.src===null && /storage/.test(n.err),n.err);
n=mk({list:'@patch'});
D.process(n,{});
ok('a list inside a patch asks for the rows wire',/wire/.test(n.err));

// поля до чтения списка: порты из сохранённого p.cols
n=mk({list:'radio/air'},['name','freq']);
ok('saved columns give ports before the list is read',D.outs(n).some(p=>p.n==='freq'));

// время и путь
n=mk({advance:'time',tscale:1000,initial:false,loop:false});
const trk=[{time:'2026-01-01 00:00:00',v:1},{time:'2026-01-01 00:00:01',v:2},{time:'2026-01-01 00:00:03',v:3}];
out=run(n,{rows:trk},30);
ok('time column is found and rows come by their time',n.tt && out.map(r=>r.v).join()==='1,2,3',out.map(r=>r.v).join());
n=mk({advance:'distance',speed:3600,rate:0,initial:false,loop:false});
const pts=[{lat:55,lon:82.9},{lat:55.001,lon:82.9},{lat:55.002,lon:82.9}];
out=run(n,{rows:pts},400);
ok('lat / lon columns are found and the route is driven',n.geo && out.length>=2,out.length);

/* ---------- перенос из Table ---------- */
const cg=rd('core-graph.js');
const m0=cg.indexOf('const MIGRATE={'), m1=cg.indexOf('function deserialize');
const mctx=vm.createContext({console});
vm.runInContext(cg.slice(m0,m1)+';this.migrate=migrate;',mctx);
const mig=o=>JSON.parse(JSON.stringify(mctx.migrate(JSON.parse(JSON.stringify(o)))));
const old={nodes:[
  {id:'n1',type:'tclock',x:0,y:0,p:{}},
  {id:'n2',type:'table',x:40,y:200,w:260,h:300,p:{list:'@patch',advance:'dwell',loop:true,order:'shuffle',initial:false,textCol:'msg',cols:['freq','dwell','msg'],data:'freq,dwell,msg\n1,1,a'}},
  {id:'n3',type:'osc',x:0,y:0,p:{}},{id:'n4',type:'recLog',x:0,y:0,p:{}},{id:'n5',type:'geoMap',x:0,y:0,p:{}}],
 edges:[{from:'n1',fp:'trig',to:'n2',tp:'trig'},{from:'n2',fp:'freq',to:'n3',tp:'freq'},{from:'n2',fp:'rec',to:'n4',tp:'rec'},
   {from:'n2',fp:'done',to:'n4',tp:'x'},{from:'n2',fp:'rows',to:'n5',tp:'rows'},{from:'n2',fp:'bands',to:'n5',tp:'rows'}]};
const mg=mig(old), pl=mg.nodes.find(x=>x.type==='rowplayer'), tbn=mg.nodes.find(x=>x.id==='n2');
const E=(f,fp,t,tp)=>mg.edges.some(e=>e.from===f && e.fp===fp && e.to===t && e.tp===tp);
ok('a playing Table gets a Row Player',!!pl && pl.id==='n6' && pl.y>tbn.y+300);
ok('playback parameters move to the player and leave the table',pl.p.advance==='dwell' && pl.p.order==='shuffle' && pl.p.loop===true && pl.p.textCol==='msg' && pl.p.initial===false && pl.p.cols.join()==='freq,dwell,msg'
  && !('advance' in tbn.p) && !('loop' in tbn.p) && !('order' in tbn.p) && tbn.p.list==='@patch' && tbn.p.data.startsWith('freq'));
ok('trigger comes to the player',E('n1','trig','n6','trig'));
ok('fields, rec and play outputs go from the player',E('n6','freq','n3','freq') && E('n6','rec','n4','rec') && E('n6','done','n4','x'));
ok('rows stay on the table and feed the player',E('n2','rows','n5','rows') && E('n2','rows','n6','rows') && mg.edges.length===old.edges.length+1);
const again=mig(mg);
ok('migration is idempotent',again.nodes.length===mg.nodes.length && again.edges.length===mg.edges.length);
const plain={nodes:[{id:'n1',type:'table',x:0,y:0,p:{list:'a',initial:true,loop:true,latCol:'la'}},{id:'n2',type:'osc',x:0,y:0,p:{}}],edges:[{from:'n1',fp:'rec',to:'n2',tp:'x'},{from:'n1',fp:'row',to:'n2',tp:'y'}]};
const pm=mig(plain);
ok('a Table that only shows and selects stays alone',pm.nodes.length===2 && pm.edges.length===2 && !('loop' in pm.nodes[0].p) && pm.nodes[0].p.initial===true);
const byRate={nodes:[{id:'n1',type:'table',x:0,y:0,p:{list:'@patch',rate:2}},{id:'n2',type:'osc',x:0,y:0,p:{}}],edges:[{from:'n1',fp:'text',to:'n2',tp:'x'}]};
ok('rows/s > 0 counts as playing',mig(byRate).nodes.some(x=>x.type==='rowplayer'));
const linked={nodes:[{id:'n1',type:'table',x:0,y:0,p:{list:'a',advance:'time',cols:['Owner'],pref:{Owner:['phone']}}},{id:'n2',type:'osc',x:0,y:0,p:{}}],
  edges:[{from:'n1',fp:'Owner.phone',to:'n2',tp:'x'},{from:'n1',fp:'Owner',to:'n2',tp:'y'}]};
const lm=mig(linked);
ok('fields of linked records stay on the table',lm.edges.some(e=>e.from==='n1' && e.fp==='Owner.phone') && lm.edges.some(e=>e.from.startsWith('n') && e.from!=='n1' && e.fp==='Owner'));

console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad?1:0);
