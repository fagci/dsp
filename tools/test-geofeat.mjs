// Ядро Geo Features: node tools/test-geofeat.mjs
// Ячейки, разбор ответа Overpass (синтетический), ближайшая полоса.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,isFinite,Set,parseInt,parseFloat,Number});
vm.runInContext(fs.readFileSync(path.join(root,'modules/geofeat-kernels.js'),'utf8')+
  ';this.K={gfKey,gfCells,gfQuery,gfParse,gfMerge,gfDistKm,gfBearing,gfNearestRunway};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b+' (±'+e+')');

// ячейки
const cs=K.gfCells(55.01,82.65,10);
ok('cells: contain the centre',cs.some(([x,y])=>x===Math.floor(82.65/.5) && y===Math.floor(55.01/.5)),JSON.stringify(cs));
ok('cells: small radius is one or two cells',cs.length>=1 && cs.length<=4,cs.length);
ok('cells: bigger radius → more cells',K.gfCells(55,82,100).length>cs.length);
ok('cells: negative coordinates floor correctly',K.gfCells(-33.9,-70.7,5).some(([x,y])=>x===-142 && y===-68));
ok('key',K.gfKey('air',3,-4)==='gf:air:3:-4');
const q=K.gfQuery('air',165,110);
ok('query bbox',q.includes('(55,82.5,55.5,83)') && q.includes('runway') && q.includes('aerodrome'),q);
ok('query pop',K.gfQuery('pop',0,0).includes('place'));

// разбор
const json={elements:[
  {type:'way',id:1,center:{lat:55.0,lon:82.65},tags:{aeroway:'aerodrome',name:'Tolmachevo',icao:'UNNT',iata:'OVB',ele:'111'}},
  {type:'way',id:2,tags:{aeroway:'runway',ref:'07/25',width:'60',surface:'asphalt'},geometry:[{lat:55.0,lon:82.6},{lat:55.0,lon:82.7}]},
  {type:'way',id:3,tags:{aeroway:'runway',ref:'x'},geometry:[{lat:1,lon:1},{lat:2,lon:2},{lat:1,lon:1}]},
  {type:'node',id:4,lat:55.1,lon:82.8,tags:{aeroway:'helipad'}},
  {type:'node',id:5,lat:55.2,lon:82.9,tags:{aeroway:'aerodrome',disused:'yes',name:'Old'}},
  {type:'way',id:6,tags:{aeroway:'runway'},geometry:[{lat:1,lon:1}]},
]};
const a=K.gfParse('air',json);
ok('air: aerodrome and helipad kept, disused dropped',a.ap.length===2 && a.ap[0].icao==='UNNT' && a.ap[1].kind==='heli',JSON.stringify(a.ap));
near('air: elevation parsed',a.ap[0].ele,111,0);
ok('air: one runway (closed outline and 1-point way dropped)',a.rw.length===1 && a.rw[0].ref==='07/25' && a.rw[0].width===60,JSON.stringify(a.rw));
const pj={elements:[
  {type:'node',id:10,lat:55,lon:83,tags:{place:'city',name:'Novosibirsk',population:'1600000'}},
  {type:'node',id:11,lat:55.1,lon:83.1,tags:{place:'village',name:'Ivanovka'}},
  {type:'node',id:12,lat:55.2,lon:83.2,tags:{place:'hamlet',name:'Small'}},
  {type:'node',id:13,lat:55.3,lon:83.3,tags:{place:'town'}},
]};
const p=K.gfParse('pop',pj);
ok('pop: city and village, hamlet and nameless dropped',p.pl.length===2 && p.pl[0].pop===1600000 && p.pl[1].pop===0,JSON.stringify(p.pl));
ok('parse: empty / null answer',K.gfParse('air',null).ap.length===0 && K.gfParse('pop',{}).pl.length===0);

// слияние
const m=K.gfMerge('air',[a,a,null,{ap:[],rw:[{id:'w9',pts:[[0,0],[0,1]]}]}]);
ok('merge: duplicates across cells removed',m.ap.length===2 && m.rw.length===2,JSON.stringify(m));
ok('merge pop',K.gfMerge('pop',[p,p]).pl.length===2);

// геометрия
near('distance 1° lat',K.gfDistKm(0,0,1,0),111.19,.01);
near('bearing north',K.gfBearing(55,82,56,82),0,1e-6); near('bearing east',K.gfBearing(55,82,55,83),90,.05);
near('bearing west',K.gfBearing(55,82,55,81),270,.05); near('bearing south',K.gfBearing(55,82,54,82),180,1e-6);

// ближайшая полоса
const data={ap:a.ap,rw:[...a.rw,{id:'far',pts:[[56,82],[56,82.1]],ref:'far'}]};
const r=K.gfNearestRunway(data,55.01,82.65,30);
ok('nearest runway',r && r.ref==='07/25' && r.name==='Tolmachevo',JSON.stringify(r));
near('runway heading east',r.hdg,90,.1); near('runway length',r.len,6380,60); near('runway start',r.lon,82.6,1e-9);
ok('none within range',K.gfNearestRunway(data,50,60,30)===null);
ok('empty data',K.gfNearestRunway({},55,82,30)===null);
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad?1:0);
