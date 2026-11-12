// modules/geotag-kernels.js: позиция по времени записи, интерполяция, устаревание, прореживание, разметка (без DOM)
import fs from 'fs';
import vm from 'vm';
const g={module:{exports:{}},Math,Number,Array,Object,isFinite,JSON}; vm.createContext(g);
vm.runInContext(fs.readFileSync(new URL('../modules/geotag-kernels.js',import.meta.url),'utf8'),g);
const K=g.module.exports; let bad=0;
const ok=(n,c,x='')=>{ console.log((c?'ok   ':'FAIL ')+n+(c?'':' '+x)); if(!c) bad++; };
const T0=1.7e12, near=(a,b,e=1e-9)=>Math.abs(a-b)<=e;

ok('время: мс, секунды, мусор',K.gtTime(1.7e12)===1.7e12 && K.gtTime(1.7e9)===1.7e12 && K.gtTime(12)===null && K.gtTime('1.7e12')===1.7e12 && K.gtTime('x')===null && K.gtTime(null)===null);
{ const f=K.gtFixOf({latitude:'55.5',lng:37.5,accuracy:8,alt:150,speed:1.4,t:1.7e9},5); ok('фикс из записи: разные имена полей, секунды → мс',f && f.lat===55.5 && f.lon===37.5 && f.acc===8 && f.t===1.7e12 && f.alt===150);
  ok('без координат / вне диапазона — null',K.gtFixOf({x:1},0)===null && K.gtFixOf({lat:91,lon:0},0)===null && K.gtFixOf({lat:0,lon:181},0)===null && K.gtFixOf(null,0)===null);
  ok('время записи нет — берётся «сейчас»',K.gtFixOf({lat:1,lon:2},777).t===777); }

const st=K.gtNew();
K.gtPush(st,{lat:55,lon:37,acc:5,t:T0}); K.gtPush(st,{lat:55.002,lon:37.004,acc:9,t:T0+10000});
let p=K.gtAt(st,T0+5000,5);
ok('середина между фиксами: линейно',p && p.how==='interp' && near(p.lat,55.001) && near(p.lon,37.002) && p.acc===9 && p.age===5);
p=K.gtAt(st,T0+2500,5); ok('четверть пути',near(p.lat,55.0005) && near(p.lon,37.001));
p=K.gtAt(st,T0+12000,5); ok('после последнего: последний, пока не старше maxAge',p.how==='last' && p.lat===55.002 && p.age===2);
ok('старше maxAge — позиции нет',K.gtAt(st,T0+20000,5)===null && K.gtAt(st,T0+20000,15)!==null);
p=K.gtAt(st,T0-3000,5); ok('до первого: первый, если свеж',p.how==='first' && p.lat===55 && K.gtAt(st,T0-9000,5)===null);
ok('пустой трек — null',K.gtAt(K.gtNew(),T0,5)===null);
// дыра между фиксами больше 2·maxAge: ближайший, если свеж
{ const s=K.gtNew(); K.gtPush(s,{lat:1,lon:1,t:T0}); K.gtPush(s,{lat:2,lon:2,t:T0+60000});
  ok('дыра: у края — ближайший, в середине — нет',K.gtAt(s,T0+2000,5).lat===1 && K.gtAt(s,T0+58000,5).lat===2 && K.gtAt(s,T0+30000,5)===null); }
// не по порядку
{ const s=K.gtNew(); K.gtPush(s,{lat:3,lon:3,t:T0+20000}); K.gtPush(s,{lat:1,lon:1,t:T0}); K.gtPush(s,{lat:2,lon:2,t:T0+10000});
  ok('фиксы не по порядку встают по времени',s.fix.map(f=>f.lat).join()==='1,2,3' && near(K.gtAt(s,T0+15000,15).lat,2.5)); }
{ const s=K.gtNew(); K.gtPush(s,{lat:1,lon:1,t:T0}); K.gtPush(s,{lat:9,lon:9,t:T0}); ok('тот же момент — заменяется',s.fix.length===1 && s.fix[0].lat===9); }
{ const s=K.gtNew(); ok('мусор не пишется',!K.gtPush(s,{lat:NaN,lon:1,t:1}) && !K.gtPush(s,null) && s.fix.length===0); }
{ const s=K.gtNew(); K.gtPush(s,{lat:1,lon:1,t:T0}); K.gtPush(s,{lat:2,lon:2,t:T0+1000*1000});
  ok('старые фиксы забываются (>15 мин)',s.fix.length===1 && s.fix[0].lat===2); }
// расстояние
ok('расстояние: градус широты ≈ 111,2 км, ноль',Math.abs(K.gtDist(0,0,1,0)-111195)<200 && K.gtDist(55,37,55,37)===0 && Math.abs(K.gtDist(55,37,55,37.001)-63.8)<1);
// прореживание
{ const s=K.gtNew(), o={step:10,dt:0}; const A={lat:55,lon:37}, B={lat:55.00003,lon:37}, C={lat:55.0002,lon:37};   // B ≈ 3 м, C ≈ 22 м
  ok('первая точка пускается',K.gtStep(s,A,T0,o)===true);
  ok('ближе step — нет, дальше — да',K.gtStep(s,B,T0+1000,o)===false && K.gtStep(s,C,T0+2000,o)===true);
  ok('пройденный путь копится по пропущенным точкам',Math.abs(s.dist-22.2)<.5,String(s.dist));
  const s2=K.gtNew(); ok('dt: чаще не пускает',K.gtStep(s2,A,T0,{step:0,dt:5}) && !K.gtStep(s2,C,T0+2000,{step:0,dt:5}) && K.gtStep(s2,C,T0+6000,{step:0,dt:5}));
  const s3=K.gtNew(); ok('без ограничений — каждую',K.gtStep(s3,A,T0,{}) && K.gtStep(s3,A,T0+1,{})); }
// разметка
{ const pos={lat:55.123456789,lon:37.5,acc:6.04,alt:150.26,speed:1.456,age:0.37,how:'interp'};
  const t=K.gtTag({rssi:-70,dev:'ab'},pos,{});
  ok('запись получает lat/lon/acc/alt/speed, gage, gfix; свои поля целы',t.lat===55.1234568 && t.lon===37.5 && t.acc===6 && t.alt===150.3 && t.speed===1.46 && t.gage===0.4 && t.gfix==='interp' && t.rssi===-70 && t.dev==='ab');
  const k=K.gtTag({lat:1,lon:2,acc:99},pos,{}); ok('свои координаты записи сохраняются',k.lat===1 && k.lon===2 && k.acc===99 && k.alt===150.3);
  const o=K.gtTag({lat:1,lon:2,acc:99},pos,{override:true}); ok('override перекрывает',o.lat===55.1234568 && o.acc===6);
  const none=K.gtTag({x:1},{lat:1,lon:2,acc:null,alt:null,speed:null,age:0,how:'last'},{}); ok('нет acc/alt/speed — полей нет',!('acc' in none) && !('alt' in none) && !('speed' in none)); }
console.log(bad?'FAILED':'all ok'); process.exit(bad?1:0);
