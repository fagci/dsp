// Каталог сигналов (modules/sigcat-kernels.js): частоты, режимы, полосы, ветки и id декодеров — без DOM.
// Проверка: node tools/test-sigcat.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const rd=f=>fs.readFileSync(path.join(root,f),'utf8');
const ctx=vm.createContext({Math,Object,Array,Set,Number,String,JSON});
vm.runInContext(rd('modules/sigcat-kernels.js')+';globalThis.SIGCAT=SIGCAT; globalThis.sigcatRows=sigcatRows; globalThis.SIGCAT_BRANCH=SIGCAT_BRANCH;',ctx);
const {SIGCAT,sigcatRows,SIGCAT_BRANCH}=ctx;
let bad=0; const ok=(c,m)=>{ if(!c){ bad++; console.error('FAIL: '+m); } };

const modsSrc=fs.readdirSync(path.join(root,'modules')).filter(f=>f.endsWith('.js')).map(f=>rd('modules/'+f)).join('\n');
const demods=new Set(['IQ','WFM','NFM','AM','SAM','USB','LSB']);
const srOpts=new Set([...rd('modules/sources.js').match(/const RTL_SR_OPTS=\[([^\]]+)\]/)[1].split(',').map(Number)]);
const names=new Set();
for(const e of SIGCAT){
  ok(!names.has(e.name),'дубль имени '+e.name); names.add(e.name);
  ok(Number.isFinite(e.f) && e.f>0,e.name+': частота');
  ok(demods.has(e.demod),e.name+': demod '+e.demod);
  ok(srOpts.has(e.sr),e.name+': sr '+e.sr+' не из списка USB SDR');
  ok(e.bw>0 && e.bw<=e.sr,e.name+': bw должна быть в пределах sr');
  ok(Number.isInteger(e.branch) && e.branch>=0 && e.branch<=4,e.name+': ветка 0…4');
  ok(e.note && e.kind,e.name+': нет заметки/типа');
  for(const d of e.decoder.split('→').map(s=>s.trim()))
    ok(modsSrc.includes("id:'"+d+"'"),e.name+': нет блока '+d);
}
// одна ветка — один декодер: иначе Decoder Switch перепутает типы
const byBranch={};
for(const e of SIGCAT) if(e.branch) (byBranch[e.branch]??=new Set()).add(e.decoder);
for(const b in byBranch) ok(byBranch[b].size===1,'ветка '+b+' ведёт на разные декодеры: '+[...byBranch[b]]);
ok(Object.keys(SIGCAT_BRANCH).length===4,'веток демо — 4');

const rows=sigcatRows();
ok(rows.length===SIGCAT.length && rows.every(r=>r.length===8 && r[0]===r[1] && r[7].demod && r[7].bw && r[7].sr),'строки band plan: lo=hi, ext с demod/bw/sr');
// table.js: ext → колонки
const tsrc=rd('modules/table.js'), m=tsrc.match(/function tblPresetRows\(name\)\{[\s\S]*?\n\}/);
ok(!!m,'tblPresetRows найден');
const tctx=vm.createContext({BANDPLAN_PRESETS:{x:rows,y:[[1,2,'a',0,'','n','k']]}});
vm.runInContext(rd('modules/bandmode-kernels.js')+m[0]+';globalThis.f=tblPresetRows;',tctx);   // правила demod / bw для планов без своих колонок
const t=tctx.f('x');
ok(['demod','bw','sr','branch','decoder'].every(k=>t.cols.includes(k)),'колонки ext в таблице: '+t.cols);
ok(t.rows[0].demod==='IQ' && t.rows[0].lo===t.rows[0].hi,'значения строк');
ok(!tctx.f('y').cols.includes('demod'),'старые band plan без ext не меняются');
// связь с Signal Database: sigDb.process предлагает запись каталога
const sctx=vm.createContext({Math,Object,Array,Set,Number,String,JSON,IQK:{},pv:(n,I,k)=>+I[k]||0});
vm.runInContext(rd('modules/sigcat-kernels.js')+rd('modules/sigdb-kernels.js')+';globalThis.SIGCAT_OF=SIGCAT_OF; globalThis.sigcatPick=sigcatPick; globalThis.SDB=SDB;',sctx);
for(const k in sctx.SIGCAT_OF){
  ok(sctx.SDB.some(e=>e[0]===k),'SIGCAT_OF: нет записи sigDb «'+k+'»');
  ok(sctx.sigcatPick(sctx.SIGCAT_OF[k],0),'SIGCAT_OF: в каталоге нет вида '+sctx.SIGCAT_OF[k]);
}
ok(sctx.sigcatPick('ais',162.03e6).name==='AIS B','ближайший канал AIS к 162.03 МГц');
ok(sctx.sigcatPick('ism',868.0e6).name==='ISM 868.3','ближайший канал ISM к 868 МГц');
ok(sctx.sigcatPick('nope',0)===null,'нет такого вида');
const n={p:{top:5,min:0}}; sctx.IQK.sigDb.init(n);
const o=sctx.IQK.sigDb.process(n,{bw:16e3,baud:9600,dev:2400,freq:161.975e6});
ok(o.name==='AIS' && o.decoder==='aisRx' && o.tune===161.975e6 && o.sr===1.024e6 && o.branch===2,'sigDb: AIS → aisRx @ 161.975 · '+JSON.stringify(o));
ok(/→ aisRx/.test(o.text),'sigDb: подсказка в тексте');
const o2=sctx.IQK.sigDb.process(n,{bw:2.5e6,baud:1e6,freq:1090e6});
ok(o2.decoder==='adsbDemod → adsbDecode' && o2.branch===1,'sigDb: ADS-B → декодер ветки 1 · '+o2.decoder);
const o3=sctx.IQK.sigDb.process(n,{bw:3e3,freq:7e6});
ok(o3.decoder==='' && o3.tune===null,'sigDb: нет записи каталога — пусто');
if(bad){ console.error(bad+' ошибок'); process.exit(1); }
console.log('sigcat ok: '+SIGCAT.length+' сигналов');
