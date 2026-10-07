// Ядро аудио-вложений: node tools/test-audio.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({String,Number});
vm.runInContext(fs.readFileSync(path.join(root,'modules/audio-kernels.js'),'utf8')+';this.K={auIds,auJoin};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c)=>{ if(!c){ bad++; console.log('FAIL',n); } else console.log('ok  ',n); };
ok('ids: sm- prefix, spaces, commas',K.auIds('sm-12 sm-15, SM-3;x')+''==='12,15,3');
ok('ids: bare numbers (a cell turned into a number)',K.auIds(7)+''==='7' && K.auIds('7;8')+''==='7,8');
ok('ids: junk, zero, empty',K.auIds('').length===0 && K.auIds(null).length===0 && K.auIds('sm-0 foo ph-1').length===0);
ok('ids: duplicates dropped',K.auIds('sm-1 sm-1 1')+''==='1');
ok('join',K.auJoin([12,15])==='sm-12 sm-15');
ok('roundtrip',K.auJoin(K.auIds('15 sm-12'))==='sm-15 sm-12');
process.exit(bad?1:0);
