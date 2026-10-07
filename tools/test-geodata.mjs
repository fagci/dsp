// Ядро Geo Data: node tools/test-geodata.mjs
// Высота точки, Overpass → строки, OpenCelliD, GeoJSON / KML / GPX → слои.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,isFinite,Set,parseFloat,Number,String,JSON,Array,Date,Float64Array,Uint8ClampedArray,Error,Object});
vm.runInContext(fs.readFileSync(path.join(root,'modules/geodata-kernels.js'),'utf8')+
  ';this.K={gdTerrarium,gdApplyGround,gdReliefColor,gdQuery,gdBboxAround,gdBboxKm2,gdHeight,gdParseOverpass,gdParseGeneric,gdDemShade,gdCellUrl,gdCellRow,gdCellFromCsv,gdCellFilter,gdParseVector,gdVecPrep,GD_COLS,GD_KINDS};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };

ok('terrarium sea level',K.gdTerrarium(128,0,0)===0);
ok('terrarium 150.5 m',K.gdTerrarium(128,150,128)===150.5);
let r=K.gdApplyGround({lat:1,lon:2,h:30},100);
ok('h → alt',r.ground===100 && r.alt===130,JSON.stringify(r));
r=K.gdApplyGround({lat:1,lon:2,alt:112},100);
ok('alt → h',r.h===12 && r.alt===112,JSON.stringify(r));
r=K.gdApplyGround({alt:500,h:10},100);
ok('alt and h both set: alt kept',r.alt===500 && r.h===10);
ok('force recomputes alt',K.gdApplyGround({alt:500,h:10},100,true).alt===110);
ok('NaN ground: record unchanged',K.gdApplyGround({h:3},NaN).ground===undefined);
ok('relief: colours differ by height',K.gdReliefColor(0).join()!==K.gdReliefColor(3000).join());
ok('relief: NaN is black',K.gdReliefColor(NaN).join()==='0,0,0');

const bb=K.gdBboxAround(55,83,10);
ok('bbox around',bb[0]<55 && bb[2]>55 && bb[1]<83 && bb[3]>83);
ok('bbox km2 ≈ 400',Math.abs(K.gdBboxKm2(bb)-400)<20,K.gdBboxKm2(bb));
const q=K.gdQuery('towers',[55,83,55.1,83.1]);
ok('query towers',q.includes('(55,83,55.1,83.1)') && q.includes('mobile_phone') && q.startsWith('[out:json]'),q);
ok('query custom bbox',K.gdQuery('custom',[1,2,3,4],'node["a"]{{bbox}};out;').includes('(1,2,3,4)'));
ok('query unknown throws',(()=>{ try{ K.gdQuery('x',[0,0,1,1]); return false; }catch(e){ return true; } })());
ok('height',K.gdHeight('45')===45 && K.gdHeight('150 ft')===45.7 && K.gdHeight('x')==='' && K.gdHeight('12 m')===12);

const rows=K.gdParseOverpass('towers',{elements:[
  {type:'node',id:1,lat:55,lon:83,tags:{man_made:'mast','tower:type':'communication','communication:mobile_phone':'yes','communication:lte':'yes',operator:'MTS',height:'60'}},
  {type:'way',id:2,center:{lat:55.1,lon:83.1},tags:{man_made:'tower','communication:television':'yes',name:'TV tower'}},
  {type:'node',id:1,lat:55,lon:83,tags:{}},
  {type:'node',id:3,tags:{}}]});
ok('overpass: two unique rows',rows.length===2,rows.length);
ok('overpass: cell tower fields',rows[0].id==='osm:n1' && rows[0].kind==='cell' && rows[0].radio==='LTE' && rows[0].h===60 && rows[0].operator==='MTS',JSON.stringify(rows[0]));
ok('overpass: broadcast tower',rows[1].radio==='TV' && rows[1].kind!=='cell' && rows[1].name==='TV tower');
ok('overpass: columns exist',Object.keys(rows[0]).every(k=>K.GD_COLS.towers.includes(k)),Object.keys(rows[0]).join());
const pk=K.gdParseOverpass('peaks',{elements:[{type:'node',id:9,lat:1,lon:2,tags:{name:'Mt',ele:'1234'}}]});
ok('peaks',pk[0].ele===1234 && pk[0].name==='Mt');

const gen=K.gdParseGeneric({elements:[{type:'node',id:1,lat:1,lon:2,tags:{name:'A',amenity:'x',a:'1'}},{type:'node',id:2,lat:3,lon:4,tags:{amenity:'y'}},{type:'node',id:3,tags:{}}]});
ok('generic: tags become columns, most frequent first',gen.rows.length===2 && gen.cols[4]==='amenity' && gen.rows[1].amenity==='y' && gen.rows[1].a==='',JSON.stringify(gen));
ok('cell url with offset',K.gdCellUrl('k',[1,2,3,4],50,100).endsWith('&limit=50&offset=100'));
const flat=new Float32Array(65536).fill(100), slope=new Float32Array(65536); for(let i=0;i<65536;i++) slope[i]=(255-(i&255))*20;
const s0=K.gdDemShade(flat,100,'shade'), s1=K.gdDemShade(slope,100,'shade'), c0=K.gdDemShade(flat,100,'color');
ok('shade: flat ground is transparent-ish',s0[3]<=3,s0[3]);
ok('shade: a slope facing away from the light is darker',s1[(128*256+128)*4+3]>40 && s1[(128*256+128)*4]===0);
ok('color: opaque',c0[3]===255 && c0.length===262144);
const c=K.gdCellRow({radio:'LTE',mcc:250,net:1,area:1234,cell:5678,lon:83.1,lat:55.2,range:1500,samples:12,updated:1700000000});
ok('cell row',c.id==='cell:250:1:1234:5678' && c.radio==='LTE' && c.radius===1500 && c.updated==='2023-11-14' && c.src==='opencellid',JSON.stringify(c));
ok('cell: no coords → null',K.gdCellRow({radio:'GSM'})===null);
ok('cell url',K.gdCellUrl('k y',[1,2,3,4],50)==='https://opencellid.org/cell/getInArea?key=k%20y&BBOX=1,2,3,4&format=json&limit=50');
const f=K.gdCellFilter({bbox:[55,83,56,84],mcc:'250'});
const csv='radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,created,updated,averageSignal';
ok('dump: header skipped',f(csv)===null);
ok('dump: inside box',f('GSM,250,2,10,20,0,83.5,55.5,800,3,1,1,1700000000,0')?.cid==='20');
ok('dump: outside box',f('GSM,250,2,10,20,0,10,55.5,800,3,1,1,1,0')===null);
ok('dump: other MCC',f('GSM,262,2,10,20,0,83.5,55.5,800,3,1,1,1,0')===null);

const gj=K.gdParseVector(JSON.stringify({type:'FeatureCollection',features:[
  {type:'Feature',properties:{name:'A',stroke:'#f00'},geometry:{type:'LineString',coordinates:[[0,0],[1,1],[2,0]]}},
  {type:'Feature',properties:{name:'P'},geometry:{type:'Polygon',coordinates:[[[0,0],[4,0],[4,4],[0,4],[0,0]],[[1,1],[2,1],[2,2],[1,1]]]}},
  {type:'Feature',properties:{name:'Pt'},geometry:{type:'MultiPoint',coordinates:[[10,20],[11,21]]}}]}),'t');
ok('geojson: 4 features',gj.feats.length===4,gj.feats.length);
const prep=K.gdVecPrep(gj,0);
ok('prep: line + polygon with a hole + points',prep.lines.length===1 && prep.polys.length===1 && prep.polys[0].rings.length===2 && prep.points.length===2,JSON.stringify([prep.lines.length,prep.polys.length,prep.points.length]));
ok('prep: line colour from properties',prep.lines[0].col==='#f00');
ok('prep: bbox in world fractions',prep.lines[0].bb[0]===0.5 && prep.lines[0].bb[2]>0.5);
ok('prep: point record',prep.points[0].lat===20 && prep.points[0].lon===10 && prep.points[0].id==='v:t:0');
ok('prep: vertex cap',K.gdVecPrep(gj,0,5).polys.length===0);

const kml=`<?xml version="1.0"?><kml><Document>
<Placemark><name>Home &amp; garden</name><Point><coordinates>83.1,55.2,150</coordinates></Point></Placemark>
<Placemark><name>Road</name><LineString><coordinates>1,1,0 2,2,0 3,1,0</coordinates></LineString></Placemark>
<Placemark><name>Area</name><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 5,0 5,5 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Document></kml>`;
const k=K.gdParseVector(kml,'k');
ok('kml: point, line, polygon',k.feats.map(x=>x.g).join()==='Point,Line,Poly',k.feats.map(x=>x.g).join());
ok('kml: entities decoded, altitude kept',k.feats[0].p.name==='Home & garden' && k.feats[0].c[2]===150);
ok('kml: polygon not read as a line',k.feats.filter(x=>x.g==='Line').length===1);

const gpx=`<gpx><wpt lat="55.5" lon="83.5"><ele>120</ele><name>W1</name></wpt>
<trk><name>T</name><trkseg><trkpt lat="1" lon="2"></trkpt><trkpt lat="1.1" lon="2.1"></trkpt></trkseg></trk></gpx>`;
const g=K.gdParseVector(gpx,'g');
ok('gpx: waypoint and track',g.feats.length===2 && g.feats[0].g==='Point' && g.feats[0].c[2]===120 && g.feats[1].g==='Line' && g.feats[1].c.length===2);
ok('unknown format throws',(()=>{ try{ K.gdParseVector('hello'); return false; }catch(e){ return true; } })());
ok('empty collection throws',(()=>{ try{ K.gdParseVector('{"type":"FeatureCollection","features":[]}'); return false; }catch(e){ return true; } })());
console.log(bad ? bad+' FAILED' : 'all passed');
process.exit(bad?1:0);
