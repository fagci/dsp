// Open-Meteo / самолёты онлайн / OSM-объекты / Ollama: node tools/test-netdata.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const defs={}, calls=[];
let routes={}, offline=false;
const enc=s=>new TextEncoder().encode(s);
const mkFetch=()=>async(u,o)=>{
  calls.push({url:String(u),body:o&&o.body});
  if(offline) throw new TypeError('Failed to fetch');
  if(o?.signal?.aborted) throw Object.assign(new Error('aborted'),{name:'AbortError'});
  const k=Object.keys(routes).find(k=>String(u).includes(k));
  if(!k) throw new TypeError('Failed to fetch');
  const v=routes[k];
  if(v.status && v.status>=400) return {ok:false,status:v.status,json:async()=>v.body||{},text:async()=>typeof v.body==='string' ? v.body : JSON.stringify(v.body||{})};
  const text=typeof v.body==='string' ? v.body : JSON.stringify(v.body);
  const chunks=v.chunks||[text]; let i=0;
  return {ok:true,status:200,json:async()=>JSON.parse(text),text:async()=>text,
    body:{getReader:()=>({read:async()=>o?.signal?.aborted ? Promise.reject(Object.assign(new Error('aborted'),{name:'AbortError'})) : i<chunks.length ? {done:false,value:enc(chunks[i++])} : {done:true}})}};
};
const store={};
const NET={app:false,proxy:'P/{url}',mode:'always',need:new Set(),needs(u){ try{ return this.need.has(new URL(u).host); }catch(e){ return false; } },url(u){ return 'PROXY/'+encodeURIComponent(u); }};
const ctx=vm.createContext({URL,URLSearchParams,String,Number,Math,Array,Object,Set,Map,Promise,JSON,Uint8Array,TextEncoder,TextDecoder,
  AbortController,TypeError,Error,Date,parseInt,parseFloat,isFinite,encodeURIComponent,performance,setTimeout,clearTimeout,
  fetch:(...a)=>ctx.__fetch(...a), __fetch:mkFetch(),
  localStorage:{getItem:k=>k in store ? store[k] : null,setItem:(k,v)=>{ store[k]=String(v); }},
  Net:NET, def:d=>{ defs[d.id]=d; },
  setMod:(n,k,v)=>{ n.p[k]=v; }, recNum:v=>typeof v==='number'&&isFinite(v)?v:null, recList:v=>Array.isArray(v)?v:v?[v]:[],
  GeoMe:{lat:null,lon:null}, phoneUrl:u=>u, NetSock:class{}, httpStream:(...a)=>ctx.__hs(...a), __hs:null});
const src=['netdata-kernels','netdata'].map(f=>fs.readFileSync(path.join(root,'modules/'+f+'.js'),'utf8')).join('\n');
vm.runInContext(src+';this.K={ndDist,ndBearing,ndAgo,ndHash,ndMeteoUrl,ndElevUrl,ndElev,ndMeteo,ndDew,ndCompass,ndMeteoLines,ndAcUrl,ndAdsbLol,ndOpenSky,ndOsmPair,ndOsmQuery,ndOsmRows,ndOllamaBase,ndNdjson,ndOllamaTags,ndOllamaMessages,ndOllamaBody,ndOllamaChunk,ND_APP};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const node=(id,p={})=>{ const d=defs[id]; const n={p:{...Object.fromEntries(d.params.filter(q=>q.d!==undefined).map(q=>[q.n,q.d])),...p},el:null}; d.init(n); return n; };
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const near=(a,b,e)=>Math.abs(a-b)<=e;

// --- общее
ok('distance Berlin–Potsdam ~26 km',near(K.ndDist(52.52,13.405,52.39,13.065),26.4,1));
ok('bearing north / east',near(K.ndBearing(0,0,1,0),0,.01) && near(K.ndBearing(0,0,0,1),90,.01));
ok('compass',K.ndCompass(0)==='N' && K.ndCompass(90)==='E' && K.ndCompass(350)==='N' && K.ndCompass(null)==='');
ok('ago',K.ndAgo(5e3)==='5 s' && K.ndAgo(120e3)==='2 min' && K.ndAgo(7200e3)==='2 h' && K.ndAgo(3*864e5)==='3 d' && K.ndAgo(-1)==='');
ok('hash stable and different',K.ndHash('a')===K.ndHash('a') && K.ndHash('a')!==K.ndHash('b'));

// --- Open-Meteo
const MET={latitude:52.52,longitude:13.4,elevation:38,current:{time:'2025-01-01T12:00',temperature_2m:3.4,relative_humidity_2m:80,apparent_temperature:0.9,
  pressure_msl:1012.6,surface_pressure:1008,wind_speed_10m:4.2,wind_direction_10m:225,wind_gusts_10m:9,cloud_cover:75,precipitation:0.2,weather_code:61,is_day:1}};
const m=K.ndMeteo(MET);
ok('meteo fields',m.temp===3.4 && m.hum===80 && m.press===1012.6 && m.wind===4.2 && m.dir===225 && m.cloud===75 && m.elev===38 && m.day===1);
ok('meteo WMO text',m.sky==='light rain' && K.ndMeteo({current:{weather_code:95}}).sky==='thunderstorm');
ok('meteo not an answer',K.ndMeteo({})===null && K.ndMeteo(null)===null && K.ndMeteo({current:5})===null);
ok('meteo missing values are null',K.ndMeteo({current:{time:'x'}}).temp===null);
ok('meteo url',K.ndMeteoUrl(52.52,13.4).includes('latitude=52.52&longitude=13.4&current=') && K.ndMeteoUrl(1,2).includes('wind_speed_unit=ms'));
ok('elevation answer',K.ndElev({elevation:[38]})===38 && K.ndElev({elevation:12.5})===12.5 && K.ndElev({})===null);
ok('dew point (20 °C, 50 %) ≈ 9.3',near(K.ndDew(20,50),9.3,.2) && K.ndDew(null,50)===null && K.ndDew(20,0)===null);
ok('meteo text lines',K.ndMeteoLines(m)[0].includes('3.4 °C') && K.ndMeteoLines(m)[1].includes('SW') && K.ndMeteoLines(null).length===0);

// --- adsb.lol и OpenSky
const ADSB={ac:[
  {hex:'3C6444',flight:'DLH4AB  ',r:'D-AIUA',t:'A320',alt_baro:36000,gs:450,track:90,lat:52.8,lon:13.5,squawk:'1234',baro_rate:64},
  {hex:'484ABC',flight:'',alt_baro:'ground',gs:5,lat:52.52,lon:13.45},
  {hex:'aaaaaa',alt_baro:8000},
  {flight:'NOHEX',lat:1,lon:1}]};
const a=K.ndAdsbLol(ADSB,52.52,13.4);
ok('adsb.lol: no position / no hex dropped, sorted by distance',a.length===2 && a[0].hex==='484abc' && a[1].hex==='3c6444');
ok('adsb.lol: callsign trimmed, altitude, ground',a[1].call==='DLH4AB' && a[1].alt===36000 && a[1].label==='DLH4AB' && a[0].ground===1 && a[0].alt===0 && a[0].label==='484ABC');
ok('adsb.lol: distance and bearing',a[1].dist>30 && a[1].dist<40 && a[1].brg>0 && a[1].brg<90);
ok('adsb.lol: row for the map',a[1].id==='ac:3c6444' && a[1].icon==='✈' && a[1].rot===90 && a[1].info.includes('A320') && a[1].info.includes('36000 ft'));
ok('adsb.lol: not an answer',K.ndAdsbLol({},0,0)===null && K.ndAdsbLol(null,0,0)===null);
const OS={states:[['abc123','SWR12  ','Switzerland',1,2,13.5,52.7,10000,false,200,180,-5,null,10100,'7000'],
  ['def456',null,'Germany',1,2,13.41,52.53,null,true,0,0,0,null,null,null],['bad',null,null,1,2,null,null]]};
const o=K.ndOpenSky(OS,52.52,13.4);
ok('opensky: units to feet / knots, null position dropped',o.length===2 && near(o[1].alt,32808,2) && near(o[1].speed,388.8,.5) && o[1].country==='Switzerland' && o[1].squawk==='7000');
ok('opensky: ground aircraft',o[0].hex==='def456' && o[0].ground===1 && o[0].alt===0);
ok('opensky: not an answer',K.ndOpenSky({},0,0)===null);
ok('opensky: empty list',K.ndOpenSky({states:null},0,0).length===0);
ok('url adsb.lol: radius in nautical miles, clamped',K.ndAcUrl('adsb.lol',52.5,13.4,100).endsWith('/v2/point/52.5/13.4/54') && K.ndAcUrl('adsb.lol',0,0,1000).endsWith('/250') && K.ndAcUrl('adsb.lol',0,0,0).endsWith('/1'));
ok('url opensky: bounding box around the point',/lamin=51\.\d+&lomin=1[12]\.\d+&lamax=53\.\d+&lomax=14\.\d+/.test(K.ndAcUrl('opensky',52.5,13.4,100)));

// --- Overpass
ok('osm pair: preset',K.ndOsmPair('radio masts','','').key==='man_made' && K.ndOsmPair('peaks','x','y').value==='peak');
ok('osm pair: custom',K.ndOsmPair('custom','power','tower').value==='tower' && K.ndOsmPair('custom','power','').value==='');
ok('osm pair: injection refused',K.ndOsmPair('custom','a"];out;//','x')===null && K.ndOsmPair('custom','power','a"b')===null && K.ndOsmPair('custom','','x')===null && K.ndOsmPair('custom','p','a\\b')===null);
const pr=K.ndOsmPair('radio masts');
const q=K.ndOsmQuery(52.52,13.4,15,pr,300);
ok('osm query',q.includes('["man_made"="mast"](around:15000,52.52,13.4)') && q.startsWith('[out:json]') && q.endsWith('out center 300;') && q.includes('way[') && q.includes('relation['));
ok('osm query without value',K.ndOsmQuery(0,0,1,{key:'power',value:''},5).includes('["power"](around'));
const OSM={elements:[{type:'node',id:1,lat:52.6,lon:13.4,tags:{name:'Mast A',height:'120',frequency:'145.6'}},
  {type:'way',id:2,center:{lat:52.53,lon:13.41},tags:{operator:'Telekom',ele:'80 m'}},{type:'node',id:3},{type:'relation',id:4,center:{lat:52.9,lon:13.4}}]};
const rows=K.ndOsmRows(OSM,pr,52.52,13.4);
ok('osm rows: way centre used, no coordinates dropped, sorted',rows.length===3 && rows[0].id==='osm:way2' && rows[2].id==='osm:relation4');
ok('osm rows: label fallback, numbers, link',rows[0].label==='Telekom' && rows[0].ele===80 && rows[1].height===120 && rows[1].freq==='145.6' && rows[1].url==='https://www.openstreetmap.org/node/1' && rows[2].label.includes('mast'));
ok('osm rows: not an answer',K.ndOsmRows({},pr,0,0)===null);

// --- Ollama
ok('base: defaults and normalisation',K.ndOllamaBase('')==='http://127.0.0.1:11434' && K.ndOllamaBase('192.168.1.5')==='http://192.168.1.5:11434'
  && K.ndOllamaBase('pc:11500/')==='http://pc:11500' && K.ndOllamaBase('https://h.example/api/chat')==='https://h.example' && K.ndOllamaBase('localhost:11434/api')==='http://localhost:11434');
const nd=K.ndNdjson('{"a":1}\n{"b":2}\n{"c"');
ok('ndjson: whole lines, tail waits',nd.lines.length===2 && nd.lines[1].b===2 && nd.rest==='{"c"');
ok('ndjson: bad line becomes an error, blank skipped',K.ndNdjson('\nxx\n').lines.length===1 && K.ndNdjson('\nxx\n').lines[0].error.startsWith('bad line'));
const tags=K.ndOllamaTags({models:[{name:'qwen2.5:7b',size:5e9,details:{parameter_size:'7B',quantization_level:'Q4_K_M'}},{model:'llama3.2:3b'},{}]});
ok('tags: sorted, empty dropped',tags.length===2 && tags[0].name==='llama3.2:3b' && tags[1].params==='7B' && tags[1].quant==='Q4_K_M');
ok('tags: not Ollama',K.ndOllamaTags({})===null);
const hist=[{role:'user',content:'1'},{role:'assistant',content:'a'},{role:'user',content:'2'},{role:'assistant',content:'b'}];
const ms=K.ndOllamaMessages(hist,'be brief','q3','LOG',1);
ok('messages: system, last exchange, context after the question',ms.length===4 && ms[0].role==='system' && ms[1].content==='2' && ms[3].content==='q3\n\n---\nLOG');
ok('messages: keep 0 — alone, no system',K.ndOllamaMessages(hist,'','q',null,0).length===1 && K.ndOllamaMessages(hist,'','q',null,0)[0].content==='q');
const bd=K.ndOllamaBody('m',ms,{temperature:.5,numCtx:4096,seed:0,keepAlive:'5m'});
ok('body: stream, options only when set',bd.stream===true && bd.options.temperature===.5 && bd.options.num_ctx===4096 && !('seed' in bd.options) && bd.keep_alive==='5m' && !('keep_alive' in K.ndOllamaBody('m',[],{})));
const c1=K.ndOllamaChunk({message:{content:'He'},done:false}), c2=K.ndOllamaChunk({done:true,eval_count:20,eval_duration:2e9,prompt_eval_count:7,total_duration:3e9});
ok('chunk: text and final statistics',c1.delta==='He' && !c1.done && c2.done && c2.stats.tps===10 && c2.stats.tokens===20 && c2.stats.promptTokens===7 && c2.stats.total===3);
ok('chunk: error',K.ndOllamaChunk({error:'model not found'}).err==='model not found');

// --- узлы
(async()=>{
  // Meteo: загрузка, офлайн с кэшем (stale)
  routes={'api.open-meteo.com/v1/forecast':{body:MET},'api.open-meteo.com/v1/elevation':{body:{elevation:[40]}}};
  let mt=node('meteo',{lat:52.52,lon:13.4});
  let r=defs.meteo.process(mt,{}); await wait(30); r=defs.meteo.process(mt,{});
  ok('meteo node: values and elevation',r.temp===3.4 && r.press===1012.6 && r.elev===40 && r.stale===0 && r.rec.lat===52.52 && r.text.includes('light rain'));
  ok('meteo node: dew point output',near(r.dew,K.ndDew(3.4,80),.1));
  const n0=calls.length; defs.meteo.process(mt,{}); await wait(10);
  ok('meteo node: no request until the interval ends',calls.length===n0);
  offline=true;
  mt=node('meteo',{lat:52.52,lon:13.4});
  defs.meteo.process(mt,{}); await wait(30); r=defs.meteo.process(mt,{});
  ok('meteo node: offline → last answer, marked stale',r.temp===3.4 && r.stale===1 && /^stale/.test(mt.msg),mt.msg);
  mt=node('meteo',{lat:11.11,lon:22.22});
  defs.meteo.process(mt,{}); await wait(30); r=defs.meteo.process(mt,{});
  ok('meteo node: offline and no cache → error in the status',r.temp===null && /^failed/.test(mt.msg),mt.msg);
  offline=false;
  mt=node('meteo',{lat:0,lon:0}); ctx.GeoMe.lat=50; ctx.GeoMe.lon=10;
  defs.meteo.process(mt,{}); ok('meteo node: centre from My Position',mt.lat===50 && mt.lon===10);
  defs.meteo.process(mt,{lat:1,lon:2}); ok('meteo node: wires win',mt.lat===1 && mt.lon===2);
  await wait(30);
  const mp=node('meteo',{lat:52.52,lon:13.4,proxy:true}); calls.length=0; defs.meteo.process(mp,{}); await wait(30);
  ok('meteo node: through the proxy',calls.length>0 && calls.every(c=>c.url.startsWith('PROXY/')));
  const mo=node('meteo',{lat:52.52,lon:13.4,auto:false}); calls.length=0; defs.meteo.process(mo,{}); await wait(10);
  ok('meteo node: auto off → no request',calls.length===0);
  defs.meteo.process(mo,{update:1}); await wait(30); ok('meteo node: update pulse asks',calls.length>0);
  ctx.GeoMe.lat=null; ctx.GeoMe.lon=null;

  // Aircraft
  routes={'api.adsb.lol':{body:ADSB}};
  let ac=node('airnet',{lat:52.52,lon:13.4,radius:100,refresh:15});
  defs.airnet.process(ac,{}); await wait(30); r=defs.airnet.process(ac,{});
  ok('aircraft node: rows without ground, nearest',r.count===1 && r.rows[0].hex==='3c6444' && r.nearest.includes('DLH4AB') && r.dist>30 && r.alt===36000);
  ac=node('airnet',{lat:52.52,lon:13.4,ground:true}); defs.airnet.process(ac,{}); await wait(30); r=defs.airnet.process(ac,{});
  ok('aircraft node: with ground',r.count===2 && r.rows[0].ground===1);
  defs.airnet.process(ac,{select:{id:'n:ac:3c6444'}}); ok('aircraft node: selection from the map',ac.sel?.hex==='3c6444');
  ac=node('airnet',{lat:52.52,lon:13.4,radius:5,ground:true}); defs.airnet.process(ac,{}); await wait(30); r=defs.airnet.process(ac,{});
  ok('aircraft node: outside the radius dropped',r.count===1 && r.rows[0].hex==='484abc');
  routes={'opensky-network.org':{body:OS}};
  ac=node('airnet',{lat:52.52,lon:13.4,source:'opensky',radius:100,ground:true}); defs.airnet.process(ac,{}); await wait(30); r=defs.airnet.process(ac,{});
  ok('aircraft node: OpenSky',r.count===2 && calls.at(-1).url.includes('lamin='));
  routes={'api.adsb.lol':{status:429}};
  ac=node('airnet',{lat:1,lon:1}); defs.airnet.process(ac,{}); await wait(30); defs.airnet.process(ac,{});
  ok('aircraft node: rate limit in the status',/429/.test(ac.msg),ac.msg);
  const ao=node('airnet',{lat:52.52,lon:13.4,refresh:0}); routes={'api.adsb.lol':{body:ADSB}}; calls.length=0; defs.airnet.process(ao,{}); await wait(10);
  ok('aircraft node: refresh 0 → by hand',calls.length===0);

  // OSM
  routes={'overpass-api.de':{body:OSM}};
  let os=node('osmobj',{lat:52.52,lon:13.4,kind:'radio masts',radius:30});
  defs.osmobj.process(os,{}); ok('osm node: nothing until search',os.rowsOut===null && calls.length>=0);
  calls.length=0; defs.osmobj.process(os,{search:1}); await wait(30); r=defs.osmobj.process(os,{search:0});
  ok('osm node: rows within the radius, nearest',r.count===2 && r.nearest.startsWith('Telekom') && calls.length===1 && decodeURIComponent(calls[0].url).includes('["man_made"="mast"]') && calls[0].body===undefined);
  os=node('osmobj',{lat:52.52,lon:13.4,kind:'custom',key:'a"];out',value:''}); defs.osmobj.process(os,{}); calls.length=0;
  defs.osmobj.process(os,{search:1}); await wait(10);
  ok('osm node: bad tag — no request',calls.length===0 && /not valid/.test(os.msg));
  routes={'overpass-api.de':{status:504},'overpass.kumi.systems':{body:OSM}};
  os=node('osmobj',{lat:52.52,lon:13.4}); defs.osmobj.process(os,{}); calls.length=0; defs.osmobj.process(os,{search:1}); await wait(40);
  ok('osm node: next mirror after an error',calls.length===2 && os.rowsOut.length===2);
  routes={'overpass-api.de':{body:{elements:[],remark:'runtime error: out of memory'}},'overpass.kumi.systems':{status:500},'overpass.private.coffee':{status:500}};
  os=node('osmobj',{lat:52.52,lon:13.4}); os.go=true; defs.osmobj.process(os,{}); defs.osmobj.process(os,{search:1}); await wait(40);
  ok('osm node: all mirrors failed → the last answer, marked stale',/^stale/.test(os.msg) && os.rowsOut.length===2,os.msg);
  os=node('osmobj',{lat:11,lon:22,radius:3}); defs.osmobj.process(os,{}); defs.osmobj.process(os,{search:1}); await wait(40);
  ok('osm node: all mirrors failed, no cache → status',/search failed/.test(os.msg),os.msg);

  // Прокси: «always» — только через него; «on error» — сначала напрямую, при отказе браузера через прокси и запоминание хоста; без прокси — напрямую
  routes={'PROXY/':{body:{models:[{name:'x'}]}},'11434/api/tags':{body:{models:[{name:'x'}]}}}; 
  let ox=node('ollama',{host:'http://lan-pc:11434',proxy:true}); calls.length=0; await defs.ollama.params.find(p=>p.n==='list').fn(ox);
  ok('proxy always + node ticked: the request goes through the proxy',calls.length===1 && calls[0].url.startsWith('PROXY/') && ox.models.length===1);
  ox=node('ollama',{host:'http://lan-pc:11434',proxy:false}); calls.length=0; await defs.ollama.params.find(p=>p.n==='list').fn(ox);
  ok('proxy always, node not ticked: directly',calls.length===1 && !calls[0].url.startsWith('PROXY/'));
  NET.mode='auto'; NET.need.clear();
  routes={'PROXY/':{body:{models:[{name:'viaproxy'}]}}};                              // напрямую — отказ браузера (нет маршрута), через прокси — ответ
  ox=node('ollama',{host:'http://lan-pc:11434'}); calls.length=0; await defs.ollama.params.find(p=>p.n==='list').fn(ox);
  ok('on error: direct first, then the proxy once',calls.length===2 && !calls[0].url.startsWith('PROXY/') && calls[1].url.startsWith('PROXY/') && ox.models[0].name==='viaproxy',JSON.stringify(calls.map(c=>c.url)));
  ok('on error: the host that needed the proxy is remembered',NET.need.has('lan-pc:11434'));
  calls.length=0; await defs.ollama.params.find(p=>p.n==='list').fn(ox);
  ok('on error: the next request goes straight through the proxy',calls.length===1 && calls[0].url.startsWith('PROXY/'));
  const chatOk=[{message:{content:'Hel'},done:false},{message:{content:'lo'},done:false},{done:true,eval_count:1,eval_duration:1e9}].map(x=>JSON.stringify(x)+'\n').join('');
  routes={'PROXY/':{body:'',chunks:[chatOk]}}; NET.need.clear(); calls.length=0;
  ox=node('ollama',{host:'http://lan-pc:11434',model:'m',prompt:'hi'}); await defs.ollama.params.find(p=>p.n==='ask').fn(ox);
  ok('on error: a POST chat is repeated through the proxy with the same body',calls.length===2 && calls[1].url.startsWith('PROXY/') && calls[1].body===calls[0].body && ox.last==='Hello',ox.msg);
  routes={}; NET.need.clear(); calls.length=0;
  ox=node('ollama',{host:'http://nowhere:11434'}); await defs.ollama.params.find(p=>p.n==='list').fn(ox);
  ok('on error: both ways fail → the original error',calls.length===2 && /models:/.test(ox.msg) && /Failed to fetch/.test(ox.msg),ox.msg);
  routes={'PROXY/':{status:405,body:'GET and HEAD only'}}; NET.need.clear();
  ox=node('ollama',{host:'http://lan-pc:11434',model:'m',prompt:'x'}); await defs.ollama.params.find(p=>p.n==='ask').fn(ox);
  ok('proxy refusal is readable in the status',/405/.test(ox.msg) && /GET and HEAD/.test(ox.msg),ox.msg);
  NET.mode='off'; NET.proxy='';
  routes={'11434/api/tags':{body:{models:[{name:'x'}]}}}; calls.length=0;
  ox=node('ollama',{host:'http://lan-pc:11434',proxy:true}); await defs.ollama.params.find(p=>p.n==='list').fn(ox);
  ok('proxy off: directly even when ticked',calls.length===1 && !calls[0].url.startsWith('PROXY/'));
  NET.mode='always'; NET.proxy='P/{url}'; NET.need.clear();

  // Приложение Android: POST идёт по сокету моста (httpStream), GET и HEAD — как обычно; без моста — сами
  const fakeStream=chunks=>({ok:true,status:200,statusText:'OK',headers:{},body:{getReader:()=>{ let i=0; return {read:async()=>i<chunks.length ? {done:false,value:enc(chunks[i++])} : {done:true},cancel(){},releaseLock(){}}; }},
    json:async()=>JSON.parse(chunks.join('')),text:async()=>chunks.join('')});
  NET.app=true; NET.proxy=''; NET.mode='always';
  let hs=[]; ctx.__hs=async(ns,url,o)=>{ hs.push({ns,url,o}); if(o.timeout<0) throw new Error('x'); return fakeStream(url.endsWith('/api/chat') ? [chatOk2] : [JSON.stringify({models:[{name:'viaapp'}]})]); };
  const chatOk2=[{message:{content:'Hel'},done:false},{message:{content:'lo'},done:false},{done:true,eval_count:1,eval_duration:1e9}].map(x=>JSON.stringify(x)+'\n').join('');
  const FAKE_NS={fake:1}; K.ND_APP.link=async()=>FAKE_NS; routes={}; calls.length=0;
  let oa=node('ollama',{host:'http://lan-pc:11434',model:'m',prompt:'hi'}); await defs.ollama.params.find(p=>p.n==='ask').fn(oa);
  ok('app: a POST chat goes through the bridge socket, the page fetch is not used',hs.length===1 && hs[0].ns===FAKE_NS && hs[0].url==='http://lan-pc:11434/api/chat' && hs[0].o.method==='POST' && calls.length===0 && oa.last==='Hello',oa.msg);
  ok('app: the body and headers go on, with a long wait for the first byte (model loading)',JSON.parse(hs[0].o.body).stream===true && hs[0].o.headers['Content-Type']==='application/json' && hs[0].o.timeout>=300000 && hs[0].o.signal);
  hs=[]; routes={'11434/api/tags':{body:{models:[{name:'direct'}]}}}; oa=node('ollama',{host:'http://lan-pc:11434'}); await defs.ollama.params.find(p=>p.n==='list').fn(oa);
  ok('app: GET goes directly (the app answers it with CORS headers itself)',hs.length===0 && oa.models[0].name==='direct');
  K.ND_APP.link=async()=>{ throw new Error('no bridge'); }; routes={'/api/chat':{body:'',chunks:[chatOk2]}}; hs=[]; calls.length=0;
  oa=node('ollama',{host:'http://lan-pc:11434',model:'m',prompt:'hi'}); await defs.ollama.params.find(p=>p.n==='ask').fn(oa);
  ok('app: no bridge → the page tries itself',hs.length===0 && calls.length===1 && oa.last==='Hello',oa.msg);
  K.ND_APP.link=async()=>FAKE_NS; ctx.__hs=async()=>{ throw Object.assign(new Error('ConnectException: failed to connect to /192.168.1.9:11434'),{connect:true}); };
  oa=node('ollama',{host:'http://192.168.1.9:11434',model:'m',prompt:'hi'}); await defs.ollama.params.find(p=>p.n==='ask').fn(oa);
  ok('app: the reason from the bridge is in the status, no CORS advice',/ConnectException/.test(oa.msg) && !/OLLAMA_ORIGINS/.test(oa.msg),oa.msg);
  NET.app=false; NET.proxy='P/{url}';

  // Chat: ответ уходит записью {from, text} (автор — модель), а не только текстом; повтор того же текста не теряется; вопросы в очереди
  NET.app=false; NET.proxy='P/{url}'; NET.mode='always';
  routes={'/api/chat':{body:'',chunks:[chatOk2]}}; calls.length=0;
  let oc=node('ollama',{model:'llama3.2:3b',host:'http://127.0.0.1:11434'});
  defs.ollama.process(oc,{prompt:'q1'}); const a1=defs.ollama.params.find(p=>p.n==='ask').fn(oc); const a2=defs.ollama.params.find(p=>p.n==='ask').fn(oc); const a3=defs.ollama.params.find(p=>p.n==='ask').fn(oc);
  ok('queue: questions asked while the model is busy wait for their turn',oc.queue.length===2 && calls.length===1);
  await a1; await wait(80);
  ok('queue: all three answered, in order, one at a time',calls.length===3 && oc.queue.length===0 && oc.hist.length===6,calls.length+' '+oc.hist.length);
  oc=node('ollama',{model:'llama3.2:3b',prompt:'x'}); defs.ollama.process(oc,{}); await defs.ollama.params.find(p=>p.n==='ask').fn(oc);
  const r1=defs.ollama.process(oc,{}), r2=defs.ollama.process(oc,{});
  ok('rec: one record per answer, on its tick only; the author is the model',r1.rec && r1.rec.from==='llama3.2:3b' && r1.rec.text==='Hello' && r1.rec.role==='assistant' && r2.rec===null);
  await defs.ollama.params.find(p=>p.n==='ask').fn(oc); const r3=defs.ollama.process(oc,{});
  ok('rec: the same text again is a new object (Chat compares objects, not texts)',r3.rec && r3.rec!==r1.rec && r3.rec.text==='Hello');
  oc=node('ollama',{model:'m',prompt:'p'}); defs.ollama.process(oc,{}); const sp=defs.ollama.params.find(p=>p.n==='ask').fn(oc); defs.ollama.params.find(p=>p.n==='ask').fn(oc); defs.ollama.params.find(p=>p.n==='stopb').fn(oc); await sp; await wait(30);
  ok('stop: the queue is dropped with the answer',oc.queue.length===0 && /stopped/.test(oc.msg),oc.msg);

  // Ollama
  routes={'/api/tags':{body:{models:[{name:'llama3.2:3b'},{name:'qwen2.5:7b'}]}}};
  let ol=node('ollama'); await defs.ollama.params.find(p=>p.n==='list').fn(ol);
  r=defs.ollama.process(ol,{});
  ok('ollama: models listed, first chosen',r.models==='llama3.2:3b\nqwen2.5:7b' && ol.p.model==='llama3.2:3b');
  const lines=[{message:{role:'assistant',content:'Hel'},done:false},{message:{role:'assistant',content:'lo'},done:false},{done:true,eval_count:30,eval_duration:3e9,total_duration:4e9}].map(x=>JSON.stringify(x)+'\n');
  const split=lines.join(''); // режем посреди строки — проверка склейки
  routes={'/api/chat':{body:'',chunks:[split.slice(0,20),split.slice(20,70),split.slice(70)]}};
  calls.length=0;
  ol=node('ollama',{model:'llama3.2:3b',prompt:'hi',sys:'brief',keep:2});
  defs.ollama.process(ol,{context:'LOG 1'}); await defs.ollama.params.find(p=>p.n==='ask').fn(ol);
  r=defs.ollama.process(ol,{});
  const sent=JSON.parse(calls[0].body);
  ok('ollama: request is /api/chat with a stream',calls[0].url==='http://127.0.0.1:11434/api/chat' && sent.stream===true && sent.model==='llama3.2:3b');
  ok('ollama: system + question with context',sent.messages.length===2 && ol.sys==='brief' || sent.messages[0].content==='brief');
  ok('ollama: answer assembled from chunks cut mid-line',r.text==='Hello' && r.last==='Hello' && r.new===1 && r.busy===0,JSON.stringify(r));
  ok('ollama: statistics',r.tps===10 && r.tokens===30);
  ok('ollama: dialogue grows, «new» is a pulse',ol.hist.length===2 && defs.ollama.process(ol,{}).new===0);
  await defs.ollama.params.find(p=>p.n==='ask').fn(ol);
  ok('ollama: history goes into the next question',JSON.parse(calls[1].body).messages.some(m=>m.role==='assistant' && m.content==='Hello'));
  defs.ollama.process(ol,{clear:1}); ok('ollama: clear',ol.hist.length===0 && ol.text==='');
  ol=node('ollama',{model:'m'}); defs.ollama.process(ol,{prompt:'a',send:1}); await wait(30);
  ok('ollama: «send» pulse asks',ol.last==='Hello' || /Hello/.test(ol.text));
  routes={'/api/chat':{status:404,body:{error:'model "zz" not found'}}};
  ol=node('ollama',{model:'zz',prompt:'x'}); await defs.ollama.params.find(p=>p.n==='ask').fn(ol);
  ok('ollama: server error text in the status',/404/.test(ol.msg) && /not found/.test(ol.msg),ol.msg);
  routes={'/api/chat':{body:'',chunks:[JSON.stringify({error:'out of memory'})+'\n']}};
  ol=node('ollama',{model:'m',prompt:'x'}); await defs.ollama.params.find(p=>p.n==='ask').fn(ol);
  ok('ollama: error inside the stream',/out of memory/.test(ol.msg) && ol.hist.length===0,ol.msg);
  offline=true;
  ol=node('ollama',{model:'m',prompt:'x'}); await defs.ollama.params.find(p=>p.n==='ask').fn(ol);
  ok('ollama: unreachable → hint about OLLAMA_ORIGINS',/OLLAMA_ORIGINS/.test(ol.msg),ol.msg);
  offline=false;
  ol=node('ollama',{model:'',prompt:'x'}); await defs.ollama.params.find(p=>p.n==='ask').fn(ol); ok('ollama: no model',/model/.test(ol.msg));
  ol=node('ollama',{model:'m',prompt:''}); await defs.ollama.params.find(p=>p.n==='ask').fn(ol); ok('ollama: empty question',/empty/.test(ol.msg));
  routes={'/api/chat':{body:'',chunks:[split]}}; calls.length=0;
  ol=node('ollama',{model:'m',auto:true}); defs.ollama.process(ol,{prompt:'one'}); await wait(30); defs.ollama.process(ol,{prompt:'one'}); await wait(10);
  ok('ollama: auto asks once per change',calls.length===1);
  defs.ollama.process(ol,{prompt:'two'}); await wait(30); ok('ollama: …and again on a new text',calls.length===2);
  console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
})();
