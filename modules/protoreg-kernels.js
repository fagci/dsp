"use strict";
/* ============================ Реестр протоколов: кто умеет разбирать и кто собирать ============================
   Одна запись на протокол: какие функции ядра разбирают (dec) и собирают (enc), где лежит ядро и как проверено.
   Статус:
     pair — есть адаптер «поля ⇄ байты»: PROTO_REG прогоняет круг «собрали → разобрали → поля совпали» (protoRoundtrip);
     both — функции есть с обеих сторон, адаптера пока нет (круг не гоняется);
     gen  — есть разбор и только генератор тестового сигнала (симуляция, не сборка из полей);
     dec  — только разбор;   enc — только сборка (разбор лежит в модуле / другом ядре, см. note).
   Правило репозитория: «Декодер и кодер — зеркальные» (CLAUDE.md) — статусы dec / enc / gen / both видно здесь, их нужно добивать до pair.
   Ядро без DOM; адаптеры берут функции протоколов лениво (в момент вызова), поэтому порядок загрузки не важен.
   Проверка: node tools/test-protoreg.mjs */

const PROTO_REG=new Map();
function protoReg(d){ PROTO_REG.set(d.id,d); return d; }
// c — категория; k — файл ядра; dec/enc — имена функций; gen — имя генератора; n — заметка
const PR=(id,title,c,k,dec,enc,gen,n)=>protoReg({id,title,cat:c,kernel:k,dec:dec||[],enc:enc||[],gen:gen||[],note:n||'',adapter:null});

/* ---- радио: цифровая речь и транкинг ---- */
PR('dmr','DMR','Digital voice','dmr-kernels.js',['dmrBptcDec','dmrT34Dec','dmrEmbDecode'],['dmrFrame','dmrBptcEnc','dmrEncLc','dmrGenerate']);
PR('dpmr','dPMR','Digital voice','dpmr-kernels.js',['dpmrHamDec'],['dpmrHeaderFrame','dpmrCchEncode','dpmrPacketScript'],[],'разбор только Хэмминга; разбор заголовка/пакета в приёмнике');
PR('dstar','D-STAR','Digital voice','dstar-kernels.js',['dstarHeaderDecode','dstarConvDec'],['dstarHeaderEncode','dstarConvEnc']);
PR('m17','M17','Digital voice','m17-kernels.js',['m17Dec','m17CallDec'],['m17Enc','m17EncLsf','m17EncStream','m17EncPacket']);
PR('nxdn','NXDN','Digital voice','nxdn-kernels.js',['nxdnChDecode','nxdnConvDec'],['nxdnChEncode','nxdnFrame']);
PR('p25','P25','Digital voice','p25-kernels.js',['p25HduDecode','p25TdulcDecode','p25Tr12Dec'],['p25Frame','p25TsduFrame','p25Tr12Enc']);
PR('ysf','YSF (System Fusion)','Digital voice','ysf-kernels.js',['ysfFichDecode','ysfDchDecode'],['ysfFichEncode','ysfDchEncode','ysfFrame']);
PR('tetra','TETRA','Digital voice','tetra-kernels.js',['tetraBlkDec','tetraRmDec'],['tetraBlkEnc','tetraGenSds','tetraGenerate']);
PR('mpt1327','MPT 1327','Digital voice','mpt1327-kernels.js',[],['mptEncode','mptGenerate'],[],'разбор — в модуле mpt1327Rx (mpt1327.js), в ядре только mptCheck');
PR('fsk4','4FSK (общий слой)','Digital voice','fsk4-kernels.js',[],['fsk4Generate','fsk4Unpack']);
/* ---- авиация и космос ---- */
PR('adsb','ADS-B / Mode S','Aircraft','adsb-kernels.js',['adsbParse'],['adsbBuild']);
PR('acars','ACARS','Aircraft','acars-kernels.js',['vacParse'],[],['vacGenerate'],'генератор — симуляция, не сборка из полей');
PR('vdl2','VDL Mode 2','Aircraft','vdl2-kernels.js',[],['vdl2BuildFrame','vdl2Generate'],[],'разбор — в vdl2.js / udec-kernels.js');
PR('stdc','Inmarsat STD-C','Aircraft','inmarsat-kernels.js',['stdcParse','stdcDecodeFrame'],['stdcEncodeFrame','stdcGenerate']);
PR('odid','Remote ID (ASTM F3411)','Aircraft','odid-kernels.js',['odidParse'],['odidBuild','odidPack']);
PR('rs41','Radiosonde RS41','Aircraft','sonde-kernels.js',['rs41Parse'],['rs41EccEncode'],['rs41Generate'],'сборка кадра по полям — через rs41Generate/rs41SimFrame, зеркальной пары нет');
PR('ccsds','CCSDS / LRPT (RS, Витерби)','Aircraft','ccsds-kernels.js',['rsDecode','rsDecodeInterleaved'],['rsEncode','rsEncodeInterleaved','ccEncode','lrptGenerate']);
PR('ais','AIS','Maritime','ais-kernels.js',['aisParse'],['aisBuild','aisGenerate']);
/* ---- пейджинг, датчики, время ---- */
PR('pocsag','POCSAG','Paging & sensors','pocsag-kernels.js',[],['pocEncode','pocGenerate','pocTxBits'],[],'разбор — в модуле pocsagRx (pocsag.js)');
PR('ism','ISM 433/868 (rtl_433)','Paging & sensors','ism-kernels.js',['ismDecode'],[],['ismGenerate']);
PR('rds','RDS / RBDS','Paging & sensors','rds-kernels.js',['rdsParserMake'],['rdsBuild','rdsBuildGroup']);
PR('dcf77','DCF77','Time','timecode-kernels.js',['dcfDecode'],['dcfEncode']);
PR('wwvb','WWVB','Time','timecode-kernels.js',['wwvbDecode'],['wwvbEncode']);
PR('gsm','GSM (BCCH/SCH)','Cellular','gsm-kernels.js',['gsmParseCell'],['gsmBcchEncode'],['gsmGenerate'],'разбор L2 — hex-gsm.js; сборки L2 из полей нет');
PR('sms','SMS PDU','Cellular','smspdu-kernels.js',['smsParse'],['smsBuild']);
PR('lora','LoRa (PHY)','Mesh & LPWAN','lora-kernels.js',['loraDecode'],['loraEncode']);
PR('meshtastic','Meshtastic','Mesh & LPWAN','meshtastic-kernels.js',['mshAirDecode'],['mshPacket','mshTextPacket']);
PR('meshcore','MeshCore','Mesh & LPWAN','meshcore-kernels.js',['mcDecode'],['mcPacket']);
PR('bitchat','Bitchat','Mesh & LPWAN','bitchat-kernels.js',['bcDecode'],['bcEncode']);
PR('rns','Reticulum','Mesh & LPWAN','rns-kernels.js',['rnUnpack','rnAnnounceParse'],['rnPack'],[],'анонс разбирается, но не собирается (rnAnnounceParse)');
PR('js8','JS8','HF','js8-kernels.js',['js8Decode'],['js8Encode']);
PR('uvk5','UV-K5 (прошивка)','Radios','uvk5-kernels.js',[],['k5Pack'],[],'разбор — K5Rx в другом месте');
PR('v22bis','V.22bis','HF','v22bis-kernels.js',['v22RxNew'],[],[],'передатчик — в модуле модема');
PR('nwr','NWR / SAME','Weather','nwr-kernels.js',[],['nwrTx'],[],'декодер SAME — в same.js (sameRx)');
PR('ir','IR (NEC, RC5…)','Infrared','ir-kernels.js',['irDecode','irParse'],['irEncode','irEncodeText']);
/* ---- сети и прикладные ---- */
PR('ax25','AX.25 / APRS','Network','ax25link-kernels.js',['axParse'],['axBuild']);
PR('winlink','Winlink (FS / сообщения)','Network','winlink-kernels.js',['wlMsgParse','wlUnpack'],['wlMsgBuild','wlPack']);
PR('lzhuf','LZHUF','Network','lzhuf-kernels.js',['lzDecode'],['lzEncode']);
PR('dns','DNS','Network','dnsq-kernels.js',['dnsParse'],['dnsBuild','dnsQuery']);
PR('ntp','NTP','Network','netmisc-kernels.js',['ntpParse'],['ntpBuild','ntpRequest']);
PR('tftp','TFTP','Network','netmisc-kernels.js',['tftpParse'],['tftpBuild','tftpReq']);
PR('syslog','Syslog','Network','netmisc-kernels.js',['syslogParse'],['syslogBuild']);
PR('mqtt','MQTT','Network','mqtt-kernels.js',['mqPacket'],['mqConnect','mqPublish','mqSubscribe'],[],'mqPacket разбирает, сборка — отдельные функции без общего адаптера');
PR('mjpeg','MJPEG-поток','Network','mjpeg-kernels.js',['mjUnpack'],['mjPack']);
PR('http','HTTP (заголовки)','Network','http-kernels.js',['httpParseHeaders','httpParseRequestHead'],[],[],'клиент собирает запросы в модулях, зеркальной сборки нет');
PR('ftp','FTP (листинг)','Network','ftp-kernels.js',['ftpParseList'],[]);
PR('ble','BLE GATT (значение)','Network','ble-kernels.js',['bleDecode'],['bleEncode']);
PR('rt880','RT-880 (прошивка)','Radios','rt880-kernels.js',['rtParseHex'],[]);

/* ---- адаптеры «поля ⇄ байты»: sample() — образец; build(поля) → байты; parse(байты, образец) → поля; tol — допуск чисел ---- */
const protoHexOf=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const protoBytesOf=s=>{ const h=String(s).replace(/[^0-9a-f]/gi,''); const b=new Uint8Array(h.length>>1); for(let i=0;i<b.length;i++) b[i]=parseInt(h.substr(i*2,2),16); return b; };
const protoBitsToBytes=bits=>{ const b=new Uint8Array(bits.length+7>>3); bits.forEach((v,i)=>{ if(v) b[i>>3]|=0x80>>(i&7); }); return b; };
const protoBytesToBits=b=>{ const o=[]; for(const x of b) for(let i=7;i>=0;i--) o.push((x>>i)&1); return o; };

function protoAdapter(id,a){ const d=PROTO_REG.get(id); if(!d) throw new Error('unknown protocol '+id); d.adapter=a; return d; }

protoAdapter('odid',{
  sample:()=>[{kind:'basic',idType:1,uaType:2,id:'1581F4YRW6C4N0000000'},
    {kind:'location',status:2,heightRef:'ground',dir:225,speed:10,vspeed:-1,lat:55.7558,lon:37.6173,altBaro:150,altGeo:200,height:50,ts:1234.5},
    {kind:'system',opLocType:1,opLat:55.75,opLon:37.6,areaRadius:50,areaCeil:300,category:1,class:2,opAlt:120},
    {kind:'operator',opIdType:0,id:'RUS-OP-12345'},{kind:'selfid',descType:0,text:'Race heat 3'}],
  build:f=>odidPack(f), parse:b=>odidParse(b), tol:1e-4});
protoAdapter('ntp',{
  sample:()=>({stratum:2,version:4,mode:4,refid:'10.1.2.3',poll:6,precision:-20,tx:1700000000121}),
  build:f=>ntpBuild({...f,rx:f.tx}), parse:b=>{ const r=ntpParse(b,0,0); r.tx=r.server; return r; }, tol:0.01});
protoAdapter('tftp',{
  sample:()=>({op:1,file:'fw.bin',mode:'octet',opts:{blksize:'1024',tsize:'0'}}),
  build:f=>tftpBuild(f), parse:b=>tftpParse(b)});
protoAdapter('dns',{
  sample:()=>({id:4660,qr:true,aa:true,rd:true,ra:true,rcode:0,questions:[{name:'example.org',type:'A'}],
    answers:[{name:'example.org',type:'A',ttl:300,data:'93.184.216.34'},{name:'example.org',type:'AAAA',ttl:60,data:'2001:db8::1'},
      {name:'example.org',type:'MX',ttl:60,data:{pref:10,host:'mail.example.org'}},{name:'example.org',type:'TXT',ttl:60,data:'v=spf1 -all'}]}),
  build:f=>dnsBuild(f), parse:b=>dnsParse(b)});
protoAdapter('ble',{
  sample:()=>({fmt:'temperature (°C)',value:36.6}),
  build:f=>bleEncode(f.value,f.fmt), parse:(b,s)=>({fmt:s.fmt,value:bleDecode(new DataView(b.buffer,b.byteOffset,b.byteLength),s.fmt).value}), tol:0.006});
protoAdapter('rds',{
  sample:()=>({pi:57796,pty:10,tp:1,ta:1,ms:1,di:[0,1,0,1],ps:'RADIO 1 ',rt:'Now playing: Test Tone',af:[98400,101700,105500]}),
  build:f=>protoBitsToBytes(rdsBuild(f).concat(rdsBuild(f))),                  // дважды: приёмнику нужно 2 блока подряд для синхронизации
  parse:b=>{ const p=rdsParserMake(); for(const x of protoBytesToBits(b)) p.bit(x); return p.snap(); }});
protoAdapter('adsb',{
  sample:()=>({icao:'4840D6',flight:'KLM1023',cat:'A3'}),
  build:f=>adsbBuild(f), parse:b=>adsbParse(b)});
protoAdapter('syslog',{
  sample:()=>({facility:'daemon',severity:'warning',host:'router',app:'dsp',pid:'42',msg:'link up',format:'3164'}),
  build:f=>new TextEncoder().encode(syslogBuild(f)), parse:b=>syslogParse(new TextDecoder().decode(b))});
protoAdapter('sms',{
  sample:()=>({type:'submit',to:'+79991234567',text:'Hello world'}),
  build:f=>protoBytesOf(smsBuild(f).parts[0].hex), parse:b=>{ const r=smsParse(b); r.type=r.mti; return r; }});

protoAdapter('dcf77',{
  sample:()=>({min:30,hour:12,day:15,month:6,year:2024,dst:true}),                              // местное берлинское время
  build:f=>protoBitsToBytes(dcfEncode(Date.UTC(f.year,f.month-1,f.day,f.hour-(f.dst ? 2 : 1),f.min)).map(Number)),
  parse:b=>dcfDecode(protoBytesToBits(b).slice(0,59).map(String))});
protoAdapter('lzhuf',{
  sample:()=>({text:'hello hello hello, hello winlink'}),
  build:f=>lzEncode(new TextEncoder().encode(f.text)), parse:b=>({text:new TextDecoder().decode(lzDecode(b))})});

/* ---- сравнение: все поля образца должны найтись в разборе (лишние поля разбора — нормально) ---- */
function protoDiff(a,b,tol,path,out){
  out=out||[]; path=path||'';
  if(a===null || a===undefined){ if(b!=null) out.push(path+': '+JSON.stringify(a)+' → '+JSON.stringify(b)); return out; }
  if(typeof a==='number'){
    if(typeof b!=='number' || !(Math.abs(a-b)<=(tol||0))) out.push(path+': '+a+' → '+b); return out; }
  if(Array.isArray(a)){
    if(!Array.isArray(b)) out.push(path+': not a list'); else a.forEach((x,i)=>protoDiff(x,b[i],tol,path+'['+i+']',out));
    return out; }
  if(typeof a==='object'){
    if(b==null || typeof b!=='object') out.push(path+': missing'); else for(const k in a) protoDiff(a[k],b[k],tol,path?path+'.'+k:k,out);
    return out; }
  if(a!==b) out.push(path+': '+JSON.stringify(a)+' → '+JSON.stringify(b));
  return out;
}
// поля → байты → поля; {ok, hex, back, diff:[…], error}
function protoRoundtrip(id,fields){
  const d=PROTO_REG.get(id); if(!d || !d.adapter) return {ok:false,error:'no codec adapter for '+id};
  try{
    const a=d.adapter, f=fields==null ? a.sample() : fields, bytes=a.build(f), back=a.parse(bytes,f), diff=protoDiff(f,back,a.tol);
    return {ok:diff.length===0, hex:protoHexOf(bytes), bytes, fields:f, back, diff};
  }catch(e){ return {ok:false,error:String(e && e.message || e)}; }
}
function protoStatus(d){
  if(d.adapter) return 'pair';
  if(d.dec.length && d.enc.length) return 'both';
  if(d.dec.length && d.gen.length) return 'gen';
  if(d.dec.length) return 'dec';
  if(d.enc.length) return 'enc';
  return 'none';
}
const PROTO_STATUS_TXT={pair:'✓ pair (round trip checked)',both:'~ both sides, no round-trip check',gen:'△ decoder + test generator only',dec:'✗ decoder only',enc:'✗ encoder only',none:'—'};
const protoList=()=>[...PROTO_REG.values()];
// сводка для текста/таблицы
function protoSummary(){
  const rows=protoList().map(d=>({id:d.id,title:d.title,cat:d.cat,status:protoStatus(d),kernel:d.kernel,dec:d.dec.join(' '),enc:d.enc.join(' '),gen:d.gen.join(' '),note:d.note}));
  const cnt={}; for(const r of rows) cnt[r.status]=(cnt[r.status]||0)+1;
  return {rows,cnt};
}
