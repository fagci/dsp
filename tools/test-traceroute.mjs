// Traceroute / MTR: статистика по узлам, таблица, записи для графа и правила Rec → Entities (modules/traceroute-kernels.js, шаблон в geo.js).
// Проверка: node tools/test-traceroute.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const rd=p=>fs.readFileSync(path.join(root,p),'utf8');
const geo=rd('modules/geo.js');
const fmt=geo.slice(geo.indexOf('function recFmt'),geo.indexOf('\n}\n',geo.indexOf('function recFmt'))+3);
const ent=geo.slice(geo.indexOf('function entSplit'),geo.indexOf('\n}\n',geo.indexOf('function entApply'))+3);
const tpl=geo.slice(geo.indexOf('const ENT_TEMPLATES={'),geo.indexOf('\n};\n',geo.indexOf('const ENT_TEMPLATES={'))+4);
const ctx=vm.createContext({Math,Object,Array,Set,Map,Number,String,JSON,RegExp,isFinite,Uint8Array});
vm.runInContext(rd('modules/traceroute-kernels.js')+fmt+ent+tpl+';globalThis.K={trcNew,trcAdd,trcRows,trcText,trcHopRec,trcCtx,entParse,entApply,ENT_TEMPLATES};',ctx);
const K=ctx.K, J=x=>JSON.stringify(x);
let bad=0; const ok=(c,m)=>{ if(!c){ bad++; console.error('FAIL: '+m); } };
const eq=(a,b,m)=>ok(J(a)===J(b),m+' (получено '+J(a)+', ждали '+J(b)+')');

// статистика: два раунда, узел 2 один раз молчит
const st=K.trcNew(); st.rounds=2;
const R=[{hop:1,ip:'192.168.1.1',ms:1.2,ok:1},{hop:2,ip:'10.0.0.1',ms:8,ok:1},{hop:3,ip:'8.8.8.8',ms:14,ok:1,final:1},
         {hop:1,ip:'192.168.1.1',ms:1.8,ok:1},{hop:2,ok:0},{hop:3,ip:'8.8.8.8',ms:16,ok:1,final:1}];
for(const r of R) K.trcAdd(st,r);
const rows=K.trcRows(st,'8.8.8.8');
eq(rows.map(r=>r.hop),[1,2,3],'узлы по порядку');
eq([rows[0].sent,rows[0].recv,rows[0].loss],[2,2,0],'узел 1: нет потерь');
eq([rows[1].sent,rows[1].recv,rows[1].loss],[2,1,50],'узел 2: одна потеря из двух — 50%');
eq([rows[0].last,rows[0].avg,rows[0].best,rows[0].worst],[1.8,1.5,1.2,1.8],'узел 1: last / avg / best / worst');
eq(rows[2].id,'8.8.8.8#3','ключ строки — адрес # номер узла (upsert в Table)');
ok(st.reached,'цель достигнута');
// смена маршрутизатора на узле — видна в строке
const s2=K.trcNew(); K.trcAdd(s2,{hop:1,ip:'1.1.1.1',ms:1,ok:1}); K.trcAdd(s2,{hop:1,ip:'2.2.2.2',ms:2,ok:1});
eq(K.trcRows(s2,'h')[0].changed,'1.1.1.1 2.2.2.2','на узле отвечали разные адреса — путь менялся');
// пустая статистика и мусор
eq(K.trcRows(K.trcNew(),'h'),[],'пусто'); K.trcAdd(s2,{hop:0}); K.trcAdd(s2,{}); eq(K.trcRows(s2,'h').length,1,'мусорные пробы игнорируются');
const txt=K.trcText(st,'8.8.8.8');
ok(txt.includes('traceroute to 8.8.8.8 · 2 rounds') && txt.includes('10.0.0.1') && /\n2\s+10\.0\.0\.1\s+50/.test(txt),'таблица: заголовок, адреса, потери');
ok(K.trcText(K.trcNew(),'x').includes('did not answer'),'цель не ответила — сказано');

// записи для графа
const ctx1=K.trcCtx(), a=K.trcHopRec(ctx1,'h',{hop:1,ip:'192.168.1.1',ms:1,ok:1},1), b=K.trcHopRec(ctx1,'h',{hop:2,ok:0},1), c=K.trcHopRec(ctx1,'h',{hop:3,ip:'8.8.8.8',ms:9,ok:1,final:1},1);
eq([a.prev,a.gap],['Phone',0],'первый узел идёт от Phone'); ok(b.ip===undefined && b.ok===0,'молчащий узел без адреса');
eq([c.prev,c.gap,c.final],['192.168.1.1',1,1],'после молчащего узла связь идёт от последнего ответившего, gap=1');
eq(K.trcHopRec(K.trcCtx(),'h',{hop:1,ip:'1.1.1.1',ok:'1',final:'0'},1).final,0,'числа в строках (из JSON моста) понимаются');

// правила Rec → Entities
const cfg=K.entParse(K.ENT_TEMPLATES['Traceroute (path to a host)']);
ok(!cfg.errs.length,'шаблон разбирается без ошибок: '+cfg.errs.join('; '));
const apply=r=>{ const o=[]; for(const rule of cfg.rules) o.push(...K.entApply(rule,r)); return o; };
const out=apply(a), byId=Object.fromEntries(out.filter(x=>!x.from).map(x=>[x.id,x]));
ok(byId.Phone && byId['192.168.1.1'],'узлы Phone и первый узел пути');
const edge=out.find(x=>x.from); eq([edge.from,edge.to,edge.label,edge.arrows],['Phone','192.168.1.1','1 ms','to'],'связь Phone → узел со временем и стрелкой');
const fin=apply(c), tgt=fin.find(x=>x.id==='8.8.8.8' && x.type==='target');
ok(tgt && tgt.shape==='diamond','цель — отдельный вид узла'); eq(fin.find(x=>x.from).from,'192.168.1.1','связь к цели от последнего ответившего узла');
eq(apply(b),[],'молчащий узел узлов не создаёт');

if(bad){ console.error(bad+' failed'); process.exit(1); }
console.log('traceroute ok');
