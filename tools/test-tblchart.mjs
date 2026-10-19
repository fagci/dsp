// Table Chart: модель графика из строк Table (modules/tblchart-kernels.js)
import fs from 'fs'; import path from 'path'; import vm from 'vm';
const root=new URL('../',import.meta.url).pathname;
const ctx={}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root,'modules/tblchart-kernels.js'),'utf8')+';this.tcModel=tcModel;',ctx);
const {tcModel}=ctx; let bad=0;
const ok=(n,c)=>{ console.log((c?'ok   ':'FAIL ')+n); if(!c) bad++; };

const stat=[6,1,11].map((c,i)=>({id:'ch'+c,chan:c,rssi_max:-40-i*10,busy:12.5*(i+1),count:3}));
let m=tcModel(stat,{});
ok('channel table → bars, x sorted numerically',m.ok && m.kind==='bar' && m.xs.join()==='1,6,11' && m.yNames[0]==='rssi_max' && m.series[0].v.join()==='-50,-40,-60');
ok('bar range from the data (negative dBm)',m.lo===-60 && m.hi===-40);
m=tcModel(stat,{y:'busy'});
ok('busy bars start at zero',m.kind==='bar' && m.lo===0 && m.hi===37.5);
m=tcModel(stat,{y:'busy,rssi_max'});
ok('several y columns → several series',m.series.length===2 && m.series[1].name==='rssi_max');

const peak=new Map();
tcModel([{chan:1,rssi_max:-60}],{hold:true,peak});
m=tcModel([{chan:1,rssi_max:-80}],{hold:true,peak});
ok('peak hold keeps the maximum',m.series[0].pk[0]===-60 && m.series[0].v[0]===-80);

const csi=[{src:'aa',chan:6,csi:'1,2,3,4'},{src:'bb',chan:6,csi:'4,3,2,1'},{src:'aa',chan:6,csi:'2,2,2,2'}];
m=tcModel(csi,{});
ok('vector cell → line over the index',m.ok && m.vector && m.kind==='line' && m.xs.length===4 && m.series.length===1 && m.series[0].v.join()==='2,2,2,2');
m=tcModel(csi,{last:3});
ok('last N rows overlaid, newest has age 1',m.series.length===3 && m.series[2].age===1 && m.series[0].age<1);
m=tcModel(csi,{by:'src'});
ok('vector by column → last row per value',m.series.length===2 && m.series.map(s=>s.name).join()==='bb,aa' || m.series.map(s=>s.name).join()==='aa,bb');
m=tcModel(csi,{kind:'heat',last:3});
ok('heat → matrix of rows',m.kind==='heat' && m.rows.length===3 && m.rows[0].length===4);
m=tcModel([{csi:[1,2,3]}],{});
ok('array cell is a vector too',m.ok && m.vector && m.xs.length===3);

const ts=Array.from({length:100},(_,i)=>({t:1.7e12+i*1000,rssi:-50-(i%7),src:i%2?'a':'b'}));
m=tcModel(ts,{});
ok('time x with many rows → line',m.kind==='line' && m.xs.length===100);
m=tcModel(ts,{by:'src',y:'rssi'});
ok('series by column align on one x axis with gaps',m.series.length===2 && m.series[0].v.filter(v=>v===null).length===50);

ok('errors are texts, not exceptions',tcModel([],{}).err==='no rows' && tcModel([{a:'x'}],{}).err.length>0 && tcModel([{chan:1,rssi:1}],{y:'nope'}).err.includes('nope'));
if(bad){ console.log(bad+' failed'); process.exit(1); } console.log('all ok');
