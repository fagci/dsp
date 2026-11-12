// Ядро пробника провода: node tools/test-wireprobe.mjs
import vm from 'node:vm'; import fs from 'node:fs';
const ctx=vm.createContext({Math,isFinite,Number,Object,Array,String,JSON,ArrayBuffer,Float32Array,Uint8Array,DataView});
vm.runInContext(fs.readFileSync(new URL('../modules/wireprobe-kernels.js',import.meta.url),'utf8')+';this.K={wpFmt,wpRate,wpRateText,wpAgeText};',ctx);
const K=ctx.K; let bad=0; const ok=(n,c,i='')=>{ if(!c){ bad++; console.log('FAIL',n,i); } else console.log('ok  ',n); };
ok('null',K.wpFmt(null)==='—'&&K.wpFmt(undefined)==='—');
ok('число',K.wpFmt(0.5)==='0.5'&&K.wpFmt(123456)==='1.23e+5'&&K.wpFmt(0.00001)==='1.00e-5'&&K.wpFmt(NaN)==='NaN',K.wpFmt(123456));
ok('строка обрезается',K.wpFmt('a'.repeat(60)).length===48+3);
const f=K.wpFmt(new Float32Array([1,-3,2,NaN]));
ok('Float32: размах без NaN',f.startsWith('Float32[4] -3 … 2'),f);
ok('пустой массив',K.wpFmt([])==='list[0]'&&K.wpFmt([1,2,3])==='list[3] 1 … 3');
ok('записи',K.wpFmt([{a:1},{a:2}])==='list[2] of records');
const o=K.wpFmt({freq:100e6,name:'x',iq:new Float32Array(4),a:1,b:2,c:3});
ok('объект: ключи, массивы с длиной, хвост',o.includes('iq[4]')&&o.includes('name="x"')&&o.endsWith(', …+1}'),o);
ok('частота',K.wpRate(10,2000)===5&&K.wpRate(1,0)===0);
ok('текст частоты',K.wpRateText(187.3)==='187/s'&&K.wpRateText(5.25)==='5.3/s'&&K.wpRateText(0.25)==='0.25/s'&&K.wpRateText(0)==='0/s');
ok('возраст',K.wpAgeText(10,true)==='now'&&K.wpAgeText(300,true)==='300 ms ago'&&K.wpAgeText(2500,true)==='2.5 s ago'&&K.wpAgeText(5,false)==='stopped');
process.exit(bad?1:0);
