// Шаблоны колонок Table: node tools/test-tabletemplates.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root,'modules/table-templates.js'),'utf8')+';this.K={TBL_TEMPLATES,tblTemplateCols};',ctx);
const K=ctx.K;
// порты, которые Table занимает сам (колонка с таким именем получает «_»): из исходников
const seq=fs.readFileSync(path.join(root,'modules/sequencer.js'),'utf8'), tbl=fs.readFileSync(path.join(root,'modules/table.js'),'utf8');
const fixed=new Set([...seq.match(/const SEQ_FIXED=new Set\(\[([^\]]*)\]/s)[1].matchAll(/'([^']+)'/g)].map(m=>m[1]).concat(['bands','rows','mid','span']));
const tolerated=new Set(['t','speed']);                     // t — время записи, speed — скорость секвенсора: так и задумано
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const T=K.TBL_TEMPLATES;
ok('there are templates for the typical tasks',['points','measure','freqs','bands','tx','rx','links','antennas','antest','siglog','track','photos'].every(id=>T.some(t=>t.id===id)));
ok('ids and titles are unique',new Set(T.map(t=>t.id)).size===T.length && new Set(T.map(t=>t.title)).size===T.length);
ok('every template has a folder, a description and columns',T.every(t=>t.dir && /^[a-z]+$/.test(t.dir) && t.desc.length>20 && t.cols.length>=5));
ok('columns of a template are unique and plain words',T.every(t=>new Set(t.cols).size===t.cols.length && t.cols.every(c=>/^[a-z][a-z0-9_]*$/.test(c))));
ok('no column takes a port of the Table by accident',T.every(t=>t.cols.every(c=>!fixed.has(c) || tolerated.has(c))),T.flatMap(t=>t.cols.filter(c=>fixed.has(c) && !tolerated.has(c)).map(c=>t.id+':'+c)).join());
ok('every template has a name or an id to show in the list',T.every(t=>t.cols.includes('name') || t.cols.includes('id') || t.id==='siglog'));
// согласованность с остальными узлами
const has=(id,cols)=>cols.every(c=>T.find(t=>t.id===id).cols.includes(c));
ok('points: what the map and the overlay read',has('points',['name','lat','lon','h','alt','color']));
ok('measure: what Mark Point writes',has('measure',['name','t','session','tx','lat','lon','alt','h','freq','rssi','azimuth','rx_ant','rx_gain','note','photo']));
ok('band plan: what the spectrum and the scanner read',has('bands',['lo','hi','step','demod','color']));
ok('frequency list: freq and demod',has('freqs',['freq','demod']));
ok('transmitters: a mast height and power for the coverage calculation',has('tx',['lat','lon','h','freq','erp_w']));
ok('links: both ends and the link fields',has('links',['lat','lon','h','lat2','lon2','h2','freq','kind','color','label']));
ok('track: what the sequencer needs',has('track',['id','lat','lon']));
// добавление колонок
ok('apply: only the missing columns, in order, nothing removed',JSON.stringify(K.tblTemplateCols(['name','lat','foo'],T.find(t=>t.id==='points')))===JSON.stringify(['name','lat','foo','lon','alt','h','icon','color','note']));
ok('apply to an empty list gives the template',JSON.stringify(K.tblTemplateCols([],T[0]))===JSON.stringify(T[0].cols));
ok('apply twice changes nothing',JSON.stringify(K.tblTemplateCols(K.tblTemplateCols(['x'],T[1]),T[1]))===JSON.stringify(K.tblTemplateCols(['x'],T[1])));
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad?1:0);
