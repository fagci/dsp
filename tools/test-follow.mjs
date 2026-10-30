// Follow Detector: node tools/test-follow.mjs
import fs from 'node:fs';
import vm from 'node:vm';
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const ctx=vm.createContext({Math,Number,String,Object,Array,JSON,Map,Set,isFinite,Infinity});
const rd=f=>fs.readFileSync(new URL('../modules/'+f,import.meta.url),'utf8');
vm.runInContext(rd('geofence-kernels.js')+rd('follow-kernels.js')+';this.K={flNew,flSee,flPrune,flRows,flPoints};',ctx);
const K=ctx.K, cfg={places:3,mins:5,sep:150,dist:300};
const st=K.flNew(); let newly=0;
const see=(id,lat,t)=>{ const r=K.flSee(st,{id,lat,lon:37.6,t},cfg); if(r?.newly) newly++; return r; };
// устройство дома: одно место — не подозрительно, сколько бы раз ни видели
for(let t=0;t<600;t+=10) see('home',55.75,t);
ok('stays in one place → not following',!st.dev.get('home').sus && st.dev.get('home').places.length===1);
// едет с нами: ~0.002° ≈ 222 м шаг, 4 места за 6 минут
see('car',55.750,0); see('car',55.752,120); see('car',55.754,240);
ok('3 places but under 5 minutes → not yet',!st.dev.get('car').sus);
see('car',55.756,360);
ok('4 places over 6 min and 670 m → following, alert once',st.dev.get('car').sus && newly===1);
see('car',55.758,400); ok('no repeat alert',newly===1);
// быстро, но недалеко
see('near',55.7500,0); see('near',55.7501,400); see('near',55.7502,800);
ok('moved only a few metres → not following',!st.dev.get('near').sus);
ok('bad input is ignored',K.flSee(st,{id:'x',lat:NaN,lon:1,t:1},cfg)===null && K.flSee(st,{id:'',lat:1,lon:1,t:1},cfg)===null);
const rows=K.flRows(st,500);
ok('rows: following first',rows[0].id==='car' && rows[0].status==='FOLLOWING');
const pts=K.flPoints(st);
ok('map points: places of multi-place devices, last is a triangle',pts.filter(p=>p.id.startsWith('car#')).length===5 && pts.find(p=>p.id==='car#4').shape==='triangle' && !pts.some(p=>p.id.startsWith('home')));
K.flPrune(st,10000,30);
ok('prune forgets old devices',st.dev.size===0);
if(bad){ console.log(bad,'failed'); process.exit(1); } else console.log('all ok');
