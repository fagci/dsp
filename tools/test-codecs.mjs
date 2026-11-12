// Круг «собрали → разобрали → поля совпали» для пар, добавленных по правилу «кодер = зеркало декодера»:
// ODID, NTP, TFTP, DNS, BLE (GATT), RDS, ADS-B. Тестовые кадры — вымышленные: node tools/test-codecs.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({console,Math,Array,Map,Set,String,Number,Date,Object,JSON,Uint8Array,Uint16Array,Uint32Array,Int32Array,DataView,ArrayBuffer,Float32Array,TextEncoder,TextDecoder,parseInt,isFinite});
const load=(...f)=>f.forEach(n=>vm.runInContext(fs.readFileSync(path.join(root,'modules',n),'utf8'),ctx,{filename:n}));
load('iq-kernels.js','adsb-kernels.js','odid-kernels.js','netsock-kernels.js','http-kernels.js','netmisc-kernels.js','dnsq-kernels.js','ble-kernels.js','rds-kernels.js');
const run=s=>vm.runInContext(s,ctx);
let bad=0; const eq=(n,a,b)=>{ const x=JSON.stringify(a), y=JSON.stringify(b); if(x!==y){ bad++; console.log('FAIL',n,x,'!=',y); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>{ if(!(Math.abs(a-b)<=e)){ bad++; console.log('FAIL',n,a,'≉',b); } else console.log('ok  ',n); };
const hex=b=>[...b].map(x=>x.toString(16).padStart(2,'0')).join('');

// --- ODID ---
{
  const msgs=[
    {kind:'basic',idType:1,uaType:2,id:'1581F4YRW6C4N0000000'},
    {kind:'location',status:2,heightRef:'ground',dir:225,speed:10,vspeed:-1,lat:55.7558,lon:37.6173,altBaro:150,altGeo:200,height:50,ts:1234.5},
    {kind:'location',status:1,heightRef:'takeoff',dir:null,speed:120,vspeed:2.5,lat:null,lon:null,altBaro:null,altGeo:null,height:null,ts:null},
    {kind:'system',opLocType:1,opLat:55.75,opLon:37.6,areaCount:3,areaRadius:50,areaCeil:300,areaFloor:0.5,category:1,class:2,opAlt:120,time:(1546300800+1000)*1000},
    {kind:'operator',opIdType:0,id:'RUS-OP-12345'},{kind:'selfid',descType:0,text:'Race heat 3'}];
  const g=m=>run('odidParse')(m)[0];
  const strip=(o,k)=>k.map(x=>o[x]);
  const a=g(run('odidBuild')(msgs[0])); eq('ODID basic',strip(a,['kind','idType','uaType','id']),['basic',1,2,'1581F4YRW6C4N0000000']);
  const l=g(run('odidBuild')(msgs[1])); eq('ODID location',[l.status,l.heightRef,l.dir,l.speed,l.vspeed,l.lat.toFixed(4),l.lon.toFixed(4),l.altBaro,l.altGeo,l.height,l.ts],[2,'ground',225,10,-1,'55.7558','37.6173',150,200,50,1234.5]);
  const u=g(run('odidBuild')(msgs[2])); eq('ODID unknowns',[u.dir,u.lat,u.altBaro,u.ts,u.speed],[null,null,null,null,120]);
  const pk=run('odidParse')(run('odidPack')(msgs)); eq('ODID pack kinds',pk.map(x=>x.kind),['basic','location','location','system','operator','selfid']);
  eq('ODID system',[pk[3].opLat.toFixed(2),pk[3].areaRadius,pk[3].areaCeil,pk[3].areaFloor,pk[3].category,pk[3].class,pk[3].time],['55.75',50,300,0.5,1,2,(1546300800+1000)*1000]);
  eq('ODID operator/selfid',[pk[4].id,pk[5].text],['RUS-OP-12345','Race heat 3']);
}
// --- NTP ---
{
  const t1=1_700_000_000_000, rx=t1+120.5, tx=t1+121, t4=t1+20;
  const r=run('ntpParse')(run('ntpBuild')({stratum:2,refid:'10.1.2.3',rx,tx,poll:6,precision:-20}),t1,t4);
  eq('NTP fields',[r.stratum,r.mode,r.version,r.refid,r.poll,r.precision],[2,4,4,'10.1.2.3',6,-20]);
  near('NTP server time',r.server,tx,0.01); near('NTP offset',r.offset,((rx-t1)+(tx-t4))/2,0.01); near('NTP delay',r.delay,(t4-t1)-(tx-rx),0.01);
  eq('NTP stratum-1 refid',run('ntpParse')(run('ntpBuild')({stratum:1,refid:'GPS',rx,tx}),t1,t4).refid,'GPS');
}
// --- TFTP ---
{
  const P=run('tftpParse'), B=run('tftpBuild');
  const rrq={op:1,file:'fw.bin',mode:'octet',opts:{blksize:'1024',tsize:'0'}};
  eq('TFTP RRQ',P(B(rrq)),rrq);
  eq('TFTP WRQ',P(B({op:2,file:'a/b.txt',mode:'netascii',opts:{}})),{op:2,file:'a/b.txt',mode:'netascii',opts:{}});
  const d=P(B({op:3,blk:513,data:new Uint8Array([1,2,3])})); eq('TFTP DATA',[d.op,d.blk,[...d.data]],[3,513,[1,2,3]]);
  eq('TFTP ACK',P(B({op:4,blk:7})).blk,7);
  eq('TFTP ERROR',P(B({op:5,code:1,msg:'File not found'})),{op:5,code:1,msg:'File not found'});
  eq('TFTP OACK',P(B({op:6,opts:{blksize:'512'}})).opts,{blksize:'512'});
}
// --- DNS ---
{
  const r={id:0x1234,qr:true,opcode:0,aa:true,tc:false,rd:true,ra:true,ad:false,rcode:0,
    questions:[{name:'example.org',type:'A'}],
    answers:[{name:'example.org',type:'A',class:1,ttl:300,data:'93.184.216.34'},{name:'example.org',type:'AAAA',class:1,ttl:60,data:'2001:db8::1'},
      {name:'example.org',type:'MX',class:1,ttl:60,data:{pref:10,host:'mail.example.org'}},{name:'example.org',type:'TXT',class:1,ttl:60,data:'v=spf1 -all'},
      {name:'_sip._tcp.example.org',type:'SRV',class:1,ttl:60,data:{prio:1,weight:5,port:5060,host:'sip.example.org'}},
      {name:'www.example.org',type:'CNAME',class:1,ttl:60,data:'example.org'}],
    authority:[{name:'example.org',type:'SOA',class:1,ttl:900,data:{mname:'ns1.example.org',rname:'admin.example.org',serial:2024010101,refresh:7200,retry:3600,expire:1209600,minimum:300}}],additional:[]};
  const p=run('dnsParse')(run('dnsBuild')(r));
  const pick=x=>({id:x.id,qr:x.qr,aa:x.aa,rd:x.rd,ra:x.ra,rcode:x.rcode,questions:x.questions,answers:x.answers,authority:x.authority});
  eq('DNS full response',pick(p),pick(r)); eq('DNS no error',p.error,undefined);
  const q=run('dnsParse')(run('dnsQuery')({name:'a.b',type:'MX',id:7}));
  eq('DNS query still parses',[q.id,q.questions[0].type],[7,'MX']);
}
// --- BLE (GATT) ---
{
  const dec=(b,f)=>run('bleDecode')(new DataView(Uint8Array.from(b).buffer),f).value, enc=(v,f)=>run('bleEncode')(v,f);
  for(const [f,v] of [['uint8',200],['int8',-5],['uint16 LE',51234],['int16 LE',-1234],['uint32 LE',4000000000],['int32 LE',-70000],['battery %',87],['heart rate (bpm)',72],['heart rate (bpm)',300]])
    eq('BLE '+f+' '+v,dec(enc(v,f),f),v);
  near('BLE float32',dec(enc(1.5,'float32 LE'),'float32 LE'),1.5,1e-6);
  near('BLE temperature',dec(enc(36.6,'temperature (°C)'),'temperature (°C)'),36.6,0.006); near('BLE temperature <0',dec(enc(-12.34,'temperature (°C)'),'temperature (°C)'),-12.34,0.006);
}
// --- RDS ---
{
  const o={pi:0xE1C4,pty:10,tp:1,ta:1,ms:1,di:[0,1,0,1],ps:'RADIO 1',rt:'Now playing: Test Tone',rtAB:0,af:[101700,98400,105500],ct:{ts:Date.UTC(2024,5,15,13,45),off:60}};
  const p=run('rdsParserMake')(); for(const bt of run('rdsBuild')(o).concat(run('rdsBuild')(o))) p.bit(bt);
  const s=p.snap();
  eq('RDS PI/PTY/TP/TA/MS',[s.pi,s.pty,s.tp,s.ta,s.ms],[0xE1C4,10,1,1,1]); eq('RDS DI',s.di,[0,1,0,1]);
  eq('RDS PS',s.ps,'RADIO 1 '); eq('RDS RT',s.rt,'Now playing: Test Tone');
  eq('RDS AF',s.af,[98400,101700,105500]); eq('RDS CT',s.ct,{ts:Date.UTC(2024,5,15,13,45),off:60}); eq('RDS no bad blocks',s.bad,0);
}
// --- ADS-B ---
{
  const P=run('adsbParse'), B=run('adsbBuild');
  const id=P(B({icao:'4840D6',flight:'KLM1023',cat:'A3'})); eq('ADSB ident',[id.df,id.icao,id.flight,id.cat,id.tc],[17,'4840D6','KLM1023','A3',4]);
  const e=run('adsbCpr')(52.2572,3.9194,0), o=run('adsbCpr')(52.2572,3.9194,1);
  const pe=P(B({icao:'4840D6',tc:11,alt:38000,cpr:e})), po=P(B({icao:'4840D6',tc:11,alt:38000,cpr:o}));
  eq('ADSB altitude',[pe.alt,po.alt],[38000,38000]); eq('ADSB cpr fractions',[pe.cpr,po.cpr].map(c=>[c.odd,c.lat,c.lon]),[e,o].map(c=>[c.odd,c.lat,c.lon]));
  const pos=run('cprGlobal')(pe.cpr,po.cpr,po.cpr); near('ADSB lat',pos.lat,52.2572,0.001); near('ADSB lon',pos.lon,3.9194,0.001);
  const v=P(B({icao:'4840D6',gs:450,track:90,vr:-640})); near('ADSB gs',v.gs,450,1); near('ADSB track',v.track,90,0.5); eq('ADSB vr',v.vr,-640);
  const v2=P(B({icao:'4840D6',gs:300,track:200,vr:1280})); near('ADSB gs 2',v2.gs,300,1.5); near('ADSB track 2',v2.track,200,0.8);
  const fr=B({icao:'4840D6',flight:'KLM1023'}); eq('ADSB CRC residual 0',run('modesResidual')(fr,14),0);
}
process.exit(bad?1:0);
