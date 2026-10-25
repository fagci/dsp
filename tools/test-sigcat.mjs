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
vm.runInContext(m[0]+';globalThis.f=tblPresetRows;',tctx);
const t=tctx.f('x');
ok(['demod','bw','sr','branch','decoder'].every(k=>t.cols.includes(k)),'колонки ext в таблице: '+t.cols);
ok(t.rows[0].demod==='IQ' && t.rows[0].lo===t.rows[0].hi,'значения строк');
ok(!tctx.f('y').cols.includes('demod'),'старые band plan без ext не меняются');
if(bad){ console.error(bad+' ошибок'); process.exit(1); }
console.log('sigcat ok: '+SIGCAT.length+' сигналов');
