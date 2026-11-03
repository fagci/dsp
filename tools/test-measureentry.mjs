// Ядро Measure Entry и строки таблицы → замеры: node tools/test-measureentry.mjs
import vm from 'node:vm'; import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Array,String,Number,Object,Set,Map,Float64Array,Float32Array,JSON,isFinite,Infinity});
vm.runInContext(['siteplan-kernels.js','measureentry-kernels.js'].map(f=>fs.readFileSync(path.join(root,'modules',f),'utf8')).join('\n')+';this.K={meEval,meNext,meLine,meChainPoly,ME_KINDS,spRowToLine,spRowsToText,spSolve};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b+' (±'+e+')');
// калькулятор
near('1+2*3',K.meEval('1+2*3'),7,0); near('(1+2)*3',K.meEval('(1+2)*3'),9,0); near('decimal comma 12,5+0,5',K.meEval('12,5+0,5'),13,1e-12);
near('2^3^2 is right-assoc',K.meEval('2^3^2'),512,0); near('unary minus -3+5',K.meEval('-3+5'),2,0); near('sqrt(3^2+4^2)',K.meEval('sqrt(3^2+4^2)'),5,1e-12);
near('hypot(3;4)',K.meEval('hypot(3;4)'),5,1e-12); near('tan(45)',K.meEval('tan(45)'),1,1e-12); near('× ÷ signs',K.meEval('6×7÷2'),21,0);
near('12.4+3.6*2 (tape sections)',K.meEval('12.4+3.6*2'),19.6,1e-12);
ok('garbage → NaN',Number.isNaN(K.meEval('1+')) && Number.isNaN(K.meEval('alert(1)')) && Number.isNaN(K.meEval('')) && Number.isNaN(K.meEval('1/0')) && Number.isNaN(K.meEval('2 3')));
// имена
ok('names: A→B, Z→A1, A1→B1, house→house2, P3→P4',[K.meNext('A'),K.meNext('Z'),K.meNext('A1'),K.meNext('house'),K.meNext('P3')].join()==='B,A1,B1,house2,P4' || [K.meNext('A'),K.meNext('Z'),K.meNext('A1'),K.meNext('house'),K.meNext('P3')].join());
// строки
const side='side (tape along the ground)';
ok('side',K.meLine(side,{a:'A',b:'B',value:12.4})==='A-B 12.4');
ok('side with sigma',K.meLine(side,{a:'A',b:'B',value:12.4,sigma:.02})==='A-B 12.4 ± 0.02');
ok('horizontal / dz / az',K.meLine('horizontal distance (level, plumb)',{a:'A',b:'B',value:5})==='A-B h 5' && K.meLine('height difference (B above A)',{a:'A',b:'B',value:-1.2})==='A-B dz -1.2' && K.meLine('compass bearing A→B',{a:'A',b:'B',value:90})==='A-B az 90');
ok('angle at B',K.meLine('angle at B (A-B-C)',{a:'A',b:'B',c:'C',value:90})==='A-B-C 90');
ok('tilt with eye',K.meLine('clinometer: angle up, horizontal distance, eye',{a:'E',b:'R',value:31,hd:9.5,eye:1.6})==='E-R tilt 31 9.5 eye 1.6');
ok('z',K.meLine('height of point A',{a:'A',value:100})==='A z 100');
ok('missing data → empty',K.meLine(side,{a:'A',b:'A',value:1})==='' && K.meLine(side,{a:'A',b:'B',value:NaN})==='' && K.meLine('nope',{a:'A',b:'B',value:1})==='');
ok('chain poly',K.meChainPoly('A-B 5\nB-C 7\nC-D 5 # x\nD-A 7\nA-C 8.6')==='poly A B C D' ,K.meChainPoly('A-B 5\nB-C 7\nC-D 5\nD-A 7\nA-C 8.6'));
// строки таблицы
const L=K.spRowToLine;
ok('row: ready line',L({line:'A-B 5'})==='A-B 5');
ok('row: kind d / dz with sigma',L({kind:'d',a:'A',b:'B',value:'12,5',sigma:.02})==='A-B 12.5 ± 0.02' && L({kind:'dz',from:'A',to:'B',v:1.2})==='A-B dz 1.2');
ok('row: GPS point',L({name:'A',lat:55.03,lon:82.92,acc:4,alt:120})==='A gps 55.03 82.92 ± 4 alt 120',L({name:'A',lat:55.03,lon:82.92,acc:4,alt:120}));
ok('row: x y z point',L({name:'B',x:10,y:5,z:2})==='B at 10 5\nB z 2');
ok('row: height only',L({name:'C',z:100})==='C z 100');
ok('row: tilt',L({kind:'tilt',a:'E',b:'R',angle:31,dist:9.5,eye:1.6})==='E-R tilt 31 9.5 eye 1.6');
ok('row: angle',L({kind:'ang',a:'A',b:'B',c:'C',value:90})==='A-B-C 90');
ok('row: a b value without kind is a distance',L({a:'A',b:'B',value:7})==='A-B 7');
ok('row: poly',L({kind:'poly',names:'A B C D'})==='poly A B C D');
ok('row: bad / empty rows give nothing',L({})==='' && L({name:'A'})==='' && L({kind:'d',a:'A',b:'B'})==='' && L(null)==='' && L({name:'A',lat:999,lon:0})==='');
ok('row: capitalised column names and spaces in names',L({Name:'My point',Lat:'55',Lon:'83'})==='My_point gps 55 83');
// из таблицы — в решатель
const rows=[{kind:'d',a:'A',b:'B',value:10},{kind:'d',a:'B',b:'C',value:5},{kind:'d',a:'C',b:'D',value:10},{kind:'d',a:'D',b:'A',value:5},{kind:'d',a:'A',b:'C',value:11.1803},{kind:'poly',names:'A B C D'}];
const R=K.spSolve(K.spRowsToText(rows));
near('table → solver: area of the rectangle',R.polys[0].area,50,.02);
console.log(bad?('\n'+bad+' FAILED'):'\nall ok'); process.exit(bad?1:0);
