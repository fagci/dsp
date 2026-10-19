// Ядро синхронизации: node tools/test-sync.mjs
// План слияния и обмен двух сессий через память.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,JSON,Map,Set,Promise,Blob,ArrayBuffer,Uint8Array,String,Array,Object,crypto,console,Infinity});
vm.runInContext(fs.readFileSync(path.join(root,'modules/sync-kernels.js'),'utf8')+';this.K={syHash,syLegacyUid,syUid,syKeyGen,syKeyNorm,syPlan,SySession,SY_CHUNK};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const M=o=>new Map(Object.entries(o).map(([k,v])=>[k,{m:0,d:0,s:0,...v}]));

// ключ
const k=K.syKeyGen();
ok('key format',/^([0-9A-Z]{5}-){5}[0-9A-Z]{1}$/.test(k),k);
ok('key normalisation',K.syKeyNorm(k.toLowerCase().replace(/-/g,' '))===k && K.syKeyNorm('short')===null);
ok('keys differ',K.syKeyGen()!==K.syKeyGen());
ok('legacy uid is stable and content-based',K.syLegacyUid('a','b')===K.syLegacyUid('a','b') && K.syLegacyUid('a','b')!==K.syLegacyUid('ab',''));

// план
let p=K.syPlan(M({a:{m:5}}),M({a:{m:9},b:{m:1}}));
ok('newer and missing are pulled',p.want.join()==='a,b' && !p.del.length);
p=K.syPlan(M({a:{m:9}}),M({a:{m:5}})); ok('older is not pulled',!p.want.length);
p=K.syPlan(M({a:{m:5}}),M({a:{m:5}})); ok('equal is not pulled',!p.want.length);
p=K.syPlan(M({a:{m:5}}),M({a:{d:8}})); ok('remote delete after our edit removes',p.del.length===1 && p.del[0][1]===8);
p=K.syPlan(M({a:{m:9}}),M({a:{d:8}})); ok('our later edit survives remote delete',!p.del.length && !p.want.length);
p=K.syPlan(M({a:{d:8}}),M({a:{m:5}})); ok('our delete beats older remote',!p.want.length);
p=K.syPlan(M({a:{d:8}}),M({a:{m:9}})); ok('remote edit after our delete comes back',p.want.join()==='a');
p=K.syPlan(M({}),M({a:{d:8}})); ok('remote tombstone of unknown record does nothing',!p.want.length && !p.del.length);
p=K.syPlan(M({}),M({a:{m:1,s:500},b:{m:1,s:5}}),100); ok('too large is skipped',p.want.join()==='b' && p.skipped===1);

// две стороны
function mkStore(init){
  const db=new Map(Object.entries(init).map(([id,v])=>[id,{m:0,d:0,s:0,body:null,...v}]));
  return {db,
    async manifest(){ return new Map([...db].map(([id,e])=>[id,{m:e.m,d:e.d,s:e.body?e.body.length:0}])); },
    async get(id){ const e=db.get(id); return e && !e.d ? {head:{id,m:e.m,data:e.data},blob:e.body ? new Blob([e.body]) : null} : null; },
    async apply(h,blob){ const c=db.get(h.id); if(c && !c.d && c.m>=h.m) return;
      db.set(h.id,{m:h.m,d:0,data:h.data,body:blob ? Buffer.from(await blob.arrayBuffer()) : null}); },
    async del(id,t){ db.set(id,{m:0,d:t,body:null}); }};
}
async function pair(a,b,{startA=true,startB=false}={}){
  const sa={}, sb={};
  const qa=[], qb=[];
  const A=sa.s=new K.SySession(a,x=>{ qb.push(x); return Promise.resolve(); });
  const B=sb.s=new K.SySession(b,x=>{ qa.push(x); return Promise.resolve(); });
  if(startA) await A.start(); if(startB) await B.start();
  for(let i=0;i<50 && (qa.length||qb.length);i++){
    while(qb.length) await B.onMessage(qb.shift());
    while(qa.length) await A.onMessage(qa.shift());
    await A.q; await B.q; await A.sq; await B.sq;
  }
  return [A,B];
}
const big=Buffer.alloc(100000).map((_,i)=>i*7);
const A=mkStore({'t:1':{m:10,data:'A1'},'t:2':{m:50,data:'A2 new'},'f:x':{m:5,body:big},'t:gone':{m:1,data:'old'}});
const B=mkStore({'t:2':{m:20,data:'B2 old'},'t:3':{m:7,data:'B3'},'t:gone':{m:1,data:'old'}});
let [sa,sb]=await pair(A,B);
ok('missing records arrive both ways',B.db.get('t:1')?.data==='A1' && A.db.get('t:3')?.data==='B3');
ok('newer edit wins',B.db.get('t:2').data==='A2 new' && A.db.get('t:2').data==='A2 new');
ok('a file arrives intact in chunks',Buffer.compare(B.db.get('f:x').body,big)===0 && big.length>K.SY_CHUNK);
ok('counters',sb.stat.got===3 && sa.stat.got===1 && sa.stat.pending===0 && sb.stat.pending===0,JSON.stringify([sa.stat,sb.stat]));

// удаление доходит и не воскресает
await A.del('t:gone',100);
[sa,sb]=await pair(A,B);
ok('delete propagates',B.db.get('t:gone').d===100 && !B.db.get('t:gone').data);
[sa,sb]=await pair(B,A,{startA:true});
ok('deleted record does not come back',A.db.get('t:gone').d===100);

// повторный обмен ничего не передаёт
[sa,sb]=await pair(A,B);
ok('second round moves nothing',sa.stat.got===0 && sb.stat.got===0);

// обе стороны начали одновременно
const C=mkStore({'t:c':{m:3,data:'C'}}), D=mkStore({'t:d':{m:4,data:'D'}});
[sa,sb]=await pair(C,D,{startA:true,startB:true});
ok('simultaneous start converges',C.db.has('t:d') && D.db.has('t:c'));
// большой манифест режется на части
const E=mkStore({}), F=mkStore({});
for(let i=0;i<4000;i++) E.db.set('t:'+i,{m:1,d:0,data:'v'+i,body:null});
[sa,sb]=await pair(E,F);
ok('4000 records in several manifest parts',F.db.size===4000 && F.db.get('t:3999').data==='v3999');

console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad?1:0);
