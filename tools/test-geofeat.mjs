// Ядро Geo Features: node tools/test-geofeat.mjs
// Ячейки, разбор ответа Overpass (синтетический), ближайшая полоса.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,isFinite,Set,parseInt,parseFloat,Number});
vm.runInContext(fs.readFileSync(path.join(root,'modules/geofeat-kernels.js'),'utf8')+
  ';this.K={gfKey,gfCells,gfQuery,gfParse,gfMerge,gfDistKm,gfBearing,gfNearestRunway,gfRemarkError,gfEmpty,gfOaParse,gfOaIndex,gfOaCell,gfPopKind,gfMergePlaces};',ctx);
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
// ответ «сервер занят»
const busyMsg='Error: runtime error: open64: 0 Success /osm3s_osm_base Dispatcher_Client::request_read_and_idx::timeout. The server is probably too busy to handle your request.';
ok('remark: busy server is an error',K.gfRemarkError({elements:[],remark:'runtime error: '+busyMsg})!=='' && K.gfRemarkError({elements:[],remark:busyMsg}).startsWith('runtime error'));
ok('remark: out of memory',K.gfRemarkError({remark:'runtime error: Query run out of memory using about 2048 MB'})!=='');
ok('remark: harmless note is not an error',K.gfRemarkError({remark:'something informational'})==='' && K.gfRemarkError({elements:[]})==='' && K.gfRemarkError(null)==='');
ok('empty: legacy empty cell',K.gfEmpty({ap:[],rw:[]}) && K.gfEmpty({pl:[]}) && K.gfEmpty(null));
ok('empty: cell with data',!K.gfEmpty({ap:[1],rw:[]}) && !K.gfEmpty({pl:[1]}));
// OurAirports
const apRows=[['id','ident','type','name','latitude_deg','longitude_deg','elevation_ft','continent','iso_country','iso_region','municipality','scheduled_service','gps_code','iata_code'],
  ['1','UNNT','large_airport','Tolmachevo','55.0126','82.6507','365','AS','RU','RU-NVS','Novosibirsk','yes','UNNT','OVB'],
  ['2','UNNN','small_airport','Novosibirsk North','55.1','82.9','300','AS','RU','','','no','',''],
  ['3','XX01','heliport','Roof','55.3','82.1','',    'AS','RU','','','no','',''],
  ['4','CLS1','closed','Closed','55','82','0','AS','RU','','','no','',''],
  ['5','BAD','small_airport','No coords','','','0','AS','RU','','','no','','']];
const rwRows=[['id','airport_ref','airport_ident','length_ft','width_ft','surface','lighted','closed','le_ident','le_latitude_deg','le_longitude_deg','le_elevation_ft','le_heading_degT','le_displaced_threshold_ft','he_ident','he_latitude_deg','he_longitude_deg','he_elevation_ft','he_heading_degT'],
  ['1','1','UNNT','11818','197','ASP','1','0','07','55.0100','82.6200','','70','','25','55.0150','82.6900','','250'],
  ['2','2','UNNN','3000','60','GRS','0','0','09','','','','90','','27','','','','270'],
  ['3','2','UNNN','3000','60','GRS','0','1','18','','','','180','','36','','','','0'],
  ['4','9','NOPE','5000','60','ASP','0','0','09','1','1','','90','','27','1','2','','270'],
  ['5','2','UNNN','50','','GRS','0','0','09','','','','90','','27','','','','270']];
const oa=K.gfOaParse(apRows,rwRows);
ok('oa: types kept, closed and coordinate-less dropped',oa.ap.length===3 && oa.ap.map(a=>a[0]).join()==='UNNT,UNNN,XX01',JSON.stringify(oa.ap.map(a=>a[0])));
ok('oa: icao, iata, elevation in metres',oa.ap[0][4]==='UNNT' && oa.ap[0][5]==='OVB' && oa.ap[0][6]===111,JSON.stringify(oa.ap[0]));
ok('oa: heliport kind and no elevation',oa.ap[2][7]==='heli' && oa.ap[2][6]===null);
ok('oa: runways — closed, unknown airport and tiny dropped',oa.rw.length===2,JSON.stringify(oa.rw.map(r=>r[7]+r[4])));
ok('oa: designator and width in metres',oa.rw[0][4]==='07/25' && oa.rw[0][5]===60,JSON.stringify(oa.rw[0]));
const r2=oa.rw[1];                                                                  // концов нет — по курсу 90° и длине 914 м
near('oa: derived runway is east-west',r2[0],r2[2],1e-6); near('oa: derived runway length',K.gfDistKm(r2[0],r2[1],r2[2],r2[3])*1000,914,3);
near('oa: derived runway is centred on the airport',(r2[1]+r2[3])/2,82.9,1e-6);
const idx=K.gfOaIndex(oa), c1=K.gfOaCell(idx,Math.floor(82.65/.5),Math.floor(55.01/.5));
ok('oa: cell has the airport and the runway as parsed objects',c1.ap.some(a=>a.icao==='UNNT') && c1.rw.some(r=>r.ref==='07/25' && r.pts.length===2),JSON.stringify(c1).slice(0,160));
ok('oa: same shape as the Overpass parse',c1.ap[0].id && c1.rw[0].id && 'width' in c1.rw[0] && 'kind' in c1.ap[0]);
ok('oa: empty cell',K.gfOaCell(idx,0,0).ap.length===0);
ok('oa: nearest runway works on it',K.gfNearestRunway(K.gfMerge('air',[c1]),55.01,82.65,30)?.ref==='07/25');
// встроенные населённые пункты
ok('pop kinds',K.gfPopKind(1e6)==='city' && K.gfPopKind(50000)==='town' && K.gfPopKind(1000)==='village' && K.gfPopKind(0)==='village');
const mp=K.gfMergePlaces([{name:'Alpha',lat:55,lon:83}],[{name:'Alpha',lat:55.01,lon:83.01},{name:'Alpha',lat:56,lon:83},{name:'Beta',lat:55,lon:83}]);
ok('merge places: same name nearby is a duplicate, far one or other name stays',mp.length===3 && mp.filter(q=>q.name==='Alpha').length===2,JSON.stringify(mp));
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad?1:0);
