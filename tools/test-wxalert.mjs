// Оповещения NWS / CAP, фильтр SAME, APRS-бюллетени и объекты (собрали → разобрали): node tools/test-wxalert.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Date,Set,Map,Number,String,JSON,isFinite,Array,Object,RegExp});
const src=fs.readFileSync(path.join(root,'modules/wxalert-kernels.js'),'utf8');
vm.runInContext(src+';this.K={wxFipsList,wxFipsMatch,wxEventMatch,wxMatch,wxNwsUrl,wxParseNws,wxBuildNws,wxParseCap,wxBuildCap,wxParseAny,wxDiff,wxAprsBulletin,wxAprsObject,wxAprsParse,wxAprsLat,wxAprsLon,wxShort};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,i='')=>{ if(!c){ bad++; console.log('FAIL',n,i); } else console.log('ok  ',n); };
const eq=(n,a,b)=>ok(n,JSON.stringify(a)===JSON.stringify(b),JSON.stringify(a)+' != '+JSON.stringify(b));

// фильтр FIPS
ok('state OK matches Oklahoma county 040109',K.wxFipsMatch(['040109'],'OK'));
ok('state OK does not match Texas 048453',!K.wxFipsMatch(['048453'],'OK'));
ok('5-digit SSCCC and 6-digit PSSCCC',K.wxFipsMatch(['040109'],'40109') && K.wxFipsMatch(['040109'],'040109') && !K.wxFipsMatch(['040109'],'40017'));
ok('part of a county: filter 140109 does not match 240109',!K.wxFipsMatch(['240109'],'140109') && K.wxFipsMatch(['040109'],'140109'));
ok('a whole-state alert (040000) matches any county of the state',K.wxFipsMatch(['040000'],'40109'));
ok('empty filter passes everything',K.wxFipsMatch(['048453'],''));
ok('several areas: one is enough','040017 048453'.split(' ').length===2 && K.wxFipsMatch('040017 048453','OK'));
// события
ok('event list',K.wxEventMatch('TOR','TOR SVR') && !K.wxEventMatch('FFW','TOR SVR'));
ok('wildcard *W = all warnings',K.wxEventMatch('FFW','*W') && !K.wxEventMatch('TOA','*W'));
ok('exclusion keeps the rest, tests dropped',K.wxEventMatch('TOR','!RWT !RMT') && !K.wxEventMatch('RWT','!RWT !RMT'));
ok('exclusion beats inclusion',!K.wxEventMatch('TOR','*W !TOR'));

// NWS: собрали → разобрали
const t0=Date.UTC(2026,4,20,17,0), t1=Date.UTC(2026,4,20,18,30);
const A=[{src:'NWS',kind:'header',id:'urn:oid:1',event:'TOR',eventName:'Tornado Warning',locations:'040109 040017',area:'Oklahoma, OK; Canadian, OK',severity:'Extreme',urgency:'Immediate',certainty:'Observed',headline:'Tornado Warning issued',description:'Take cover & <stay> inside.',instruction:'Move to a shelter.',sender:'NWS Norman OK',sent:t0,expires:t1,lat:35.4,lon:-97.5},
         {src:'NWS',kind:'header',id:'urn:oid:2',event:'SVR',eventName:'Severe Thunderstorm Warning',locations:'048453',area:'Travis, TX',severity:'Severe',urgency:'Expected',certainty:'Likely',headline:'',description:'',instruction:'',sender:'NWS Austin',sent:t0,expires:t1,lat:null,lon:null}];
const g=K.wxBuildNws(A), B=K.wxParseNws(g);
ok('NWS: count and fields',B.length===2 && B[0].event==='TOR' && B[0].eventName==='Tornado Warning' && B[0].locations==='040109 040017' && B[0].states==='OK' && B[1].states==='TX',JSON.stringify(B[0]));
ok('NWS: times and area',B[0].sent===t0 && B[0].expires===t1 && B[0].area===A[0].area && B[0].severity==='Extreme');
ok('NWS: polygon → centre, no polygon → null',Math.abs(B[0].lat-35.4)<.01 && Math.abs(B[0].lon+97.5)<.01 && B[1].lat==null);
ok('NWS: event code from the name when eventCode is missing',K.wxParseNws({features:[{properties:{event:'Flash Flood Warning',geocode:{SAME:['040109']}}}]})[0].event==='FFW');
ok('NWS: garbage → null',K.wxParseNws({})===null && K.wxParseAny('xyz')===null);
eq('NWS url: state / zone / point',[K.wxNwsUrl({area:'ok'}),K.wxNwsUrl({area:'OKZ025'}),K.wxNwsUrl({lat:35.4,lon:-97.5})],
  ['https://api.weather.gov/alerts/active?area=OK','https://api.weather.gov/alerts/active?zone=OKZ025','https://api.weather.gov/alerts/active?point=35.4000,-97.5000']);
// CAP: собрали → разобрали (в том числе экранирование)
const x=K.wxBuildCap(A), C=K.wxParseCap(x);
ok('CAP: count and fields',C.length===2 && C[0].event==='TOR' && C[0].locations==='040109 040017' && C[0].id==='urn:oid:1' && C[0].sent===t0 && C[0].expires===t1,JSON.stringify(C[0]));
ok('CAP: text with & < > survives',C[0].description==='Take cover & <stay> inside.' && C[0].area==='Oklahoma, OK; Canadian, OK');
ok('CAP: polygon centre (lat,lon order)',Math.abs(C[0].lat-35.4)<.01 && Math.abs(C[0].lon+97.5)<.01 && C[1].lat==null);
ok('Atom entry with cap: fields',(()=>{ const a='<feed><entry><id>x1</id><cap:event>Tornado Warning</cap:event><cap:effective>2026-05-20T17:00:00+00:00</cap:effective><cap:expires>2026-05-20T18:30:00+00:00</cap:expires><cap:geocode><valueName>SAME</valueName><value>040109 040017</value></cap:geocode><cap:areaDesc>Oklahoma</cap:areaDesc></entry></feed>'; const r=K.wxParseCap(a); return r.length===1 && r[0].event==='TOR' && r[0].locations==='040109 040017' && r[0].id==='x1'; })());
ok('CAP: cancel message type',K.wxParseCap(K.wxBuildCap([{...A[0],kind:'cancel'}]))[0].kind==='cancel');
ok('parseAny picks the format',K.wxParseAny(x).length===2 && K.wxParseAny(JSON.stringify(g)).length===2);
// новые
{ const seen=new Set(); const f1=K.wxDiff(B,seen), f2=K.wxDiff(B,seen), f3=K.wxDiff([B[0]],seen), f4=K.wxDiff(B,seen);
  eq('diff: first all, then none, a returned one is new again',[f1.length,f2.length,f3.length,f4.length],[2,0,0,1]); }

// APRS: собрали → разобрали
const bl=K.wxAprsBulletin(B[0],{id:'bln3wx'});
ok('bulletin: addressee of 9 and text ≤ 67',/^:BLN3WX   :/.test(bl) && bl.length<=11+67,bl);
ok('bulletin parses back',K.wxAprsParse(bl).kind==='bulletin' && K.wxAprsParse(bl).id==='BLN3WX' && /^Tornado Warning/.test(K.wxAprsParse(bl).text) && /til 1830Z/.test(bl),bl);
ok('long text is cut to 67',K.wxAprsBulletin({...B[0],area:'x'.repeat(200)}).length===11+67);
const ob=K.wxAprsObject(B[0],{});
const po=K.wxAprsParse(ob);
ok('object has fixed layout and parses back',po && po.kind==='object' && Math.abs(po.lat-35.4)<.001 && Math.abs(po.lon+97.5)<.001 && po.event==='TOR' && po.sym==='\\!',ob);
ok('object name padded to 9, live marker',/^;TOR1830Z \*\d{6}z/.test(ob),ob);
ok('cancel → killed object',/^;TOR1830Z _/.test(K.wxAprsObject({...B[0],kind:'cancel'},{})));
ok('no coordinates → no object, fallback position works',K.wxAprsObject(B[1],{})===null && K.wxAprsParse(K.wxAprsObject(B[1],{lat:30.3,lon:-97.7})).lat===30.3);
eq('lat/lon format',[K.wxAprsLat(35.4),K.wxAprsLat(-0.5),K.wxAprsLon(-97.5),K.wxAprsLon(7.25)],['3524.00N','0030.00S','09730.00W','00715.00E']);
// SAME-запись (без координат и expires): время конца = t + purge
{ const s={src:'SAME',kind:'header',event:'TOR',eventName:'Tornado Warning',locations:'040109 040017',states:'OK',purge:30,t:t0};
  ok('SAME record → bulletin with the end time',/Tornado Warning 040109 040017 til 1730Z/.test(K.wxAprsBulletin(s)),K.wxAprsBulletin(s)); }
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
