// Имя дубликата файла: расширение остаётся в конце («a.csv» → «a (1).csv»)
import fs from 'fs'; import vm from 'vm';
const src=fs.readFileSync(new URL('../modules/filestore.js',import.meta.url),'utf8');
const a=src.indexOf('function fsDedupName'), b=src.indexOf('const fsStamp');
const ctx={}; vm.createContext(ctx); vm.runInContext(src.slice(a,b)+';this.F=fsDedupName;',ctx);
const F=ctx.F; let bad=0; const ok=(n,c)=>{ console.log((c?'ok  ':'FAIL ')+n); if(!c) bad++; };
ok('free name stays',F('a.csv',new Set())==='a.csv');
ok('ext kept',F('rssi-by-device.csv',new Set(['rssi-by-device.csv']))==='rssi-by-device (1).csv');
ok('next number',F('a.csv',new Set(['a.csv','a (1).csv']))==='a (2).csv');
ok('copy of copy does not nest',F('a (1).csv',new Set(['a.csv','a (1).csv']))==='a (2).csv');
ok('no ext',F('field/list',new Set(['field/list']))==='field/list (1)');
ok('folder with dot',F('v1.2',new Set(['v1.2']),true)==='v1.2 (1)');
ok('double ext',F('x.tar.gz',new Set(['x.tar.gz']))==='x.tar (1).gz');
process.exit(bad?1:0);
