// Universal Decoder: IQ-генератор (AIS, POCSAG, ISM433, ACARS) → IQK.udec в режимах auto / hint / manual.
// Проверка: node tools/test-udec.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const worker=fs.readFileSync(path.join(root,'iq-worker.js'),'utf8');
const files=[...worker.match(/importScripts\((.*)\);/)[1].matchAll(/'([^']+)'/g)].map(m=>m[1].replace(/\+Q$/,''));
const ctx=vm.createContext({console,Math,Float32Array,Float64Array,Uint8Array,Uint16Array,Uint32Array,Int8Array,Int16Array,Int32Array,Map,Set,Date,JSON,Array,Object,String,Number,parseInt,parseFloat,isFinite,isNaN,Symbol,Promise,BigInt,DataView,WebAssembly,TextDecoder,atob,RegExp,Error,performance});
ctx.self=ctx;
for(const f of files) vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});
let bad=0; const ok=(c,m)=>{ if(!c){ bad++; console.error('FAIL: '+m); } };
const ev=s=>vm.runInContext(s,ctx);
// rtl_433 (wasm) для ISM Scanner: в приложении воркер грузит его сам
ev(`globalThis.__setRt=m=>{ ISM_RT.mod=m; };`); ctx.__setRt(new WebAssembly.Module(fs.readFileSync(path.join(root,'vendor/rtl433.wasm'))));
ok(ev('typeof IQK.udec')==='object','IQK.udec есть в воркере');

// подсказки
ev(`globalThis.F=udecFind;`);
const F=ctx.F;
ok(F('aisRx')?.proto==='AIS' && F('POCSAG')?.id==='pocsagRx' && F('ism')?.id==='ismRx' && F(' ACARS ')?.id==='acarsRx','подсказка: id, имя протокола и вид каталога');
ok(F({decoder:'aisRx'})?.id==='aisRx' && F({kind:'pocsag'})?.id==='pocsagRx' && F(['x','ism'])?.id==='ismRx','подсказка: запись и массив');
ok(F('adsbDemod → adsbDecode')===null && F('')===null && F(null)===null && F(7)===null,'неизвестное — null');
// параметры по умолчанию реестра совпадают с описаниями модулей
const defs={aisRx:'ais.js',pocsagRx:'pocsag.js',ismRx:'ism.js',acarsRx:'acars.js',fskRx:'fsk4.js',mpt1327Rx:'mpt1327.js',tetraRx:'tetra.js',rs41Rx:'sonde.js',adsbDemod:'adsb.js',loraRx:'lora.js',tvDecode:'video.js',ismScan:'ism.js'};
ev(`globalThis.REG=UDEC_REG;`);
for(const r of ctx.REG){
  if(!r.id) continue;                                 // маршрут без декодера (DVB)
  const src=fs.readFileSync(path.join(root,'modules',defs[r.id]),'utf8');
  const blk=src.slice(src.indexOf("id:'"+r.id+"'"), src.indexOf('n=>{',src.indexOf("id:'"+r.id+"'")));
  for(const k in r.p){
    const m=blk.match(new RegExp("\\{n:'"+k+"',[^}]*?d:('[^']*'|[-\\d.]+|true|false)"));
    ok(!!m,r.id+': параметр '+k+' есть в описании модуля');
    if(m && !r.variant){ const d=m[1].startsWith("'") ? m[1].slice(1,-1) : m[1]==='true' ? true : m[1]==='false' ? false : +m[1];
      ok(d===r.p[k],r.id+'.'+k+': по умолчанию в модуле '+d+', в реестре '+r.p[k]); }
  }
}

// выбор декодеров по частоте и ширине потока (быстро, без прогона сигнала)
{ const act=(fc,sr)=>{ ev(`globalThis.UQ={p:{mode:'auto',proto:'AIS',hold:6000}}; IQK.udec.init(UQ);`);
    ctx.__s={sr,fc,chunks:[{re:new Float32Array(256),im:new Float32Array(256),t0:0}]};
    ev(`IQK.udec.process(UQ,{in:__s},{})`); return ev('UQ.ui.act'); };
  const fit=sr=>ctx.REG.filter(r=>!r.route && (!r.minSr || sr>=r.minSr)).length;
  ok(!act(1090e6,256000).includes('ADS-B') && act(1090e6,256000).length===fit(256000),'1090 МГц при 256 кС/с: ADS-B не слушает, слушают все подходящие по полосе');
  ok(act(1090e6,2.4e6).join()==='ADS-B','1090 МГц при 2.4 МС/с: только ADS-B');
  ok(act(868.1e6,1024000).includes('LoRaWAN') && act(868.1e6,1024000).includes('Meshtastic') && act(868.1e6,1024000).includes('ISM (wideband)'),'868.1 МГц: широкий ISM и обе настройки LoRa');
  ok(act(433.92e6,2400000).includes('ISM (wideband)') && !act(433.92e6,2400000).includes('ISM'),'окно 2.4 МС/с: только широкий ISM (rtl_433 по каналам)');
  ok(act(433.92e6,250000).includes('ISM') && !act(433.92e6,250000).includes('ISM (wideband)'),'узкий канал 250 кС/с: узкий ISM 433 Decoder');
  ok(act(868.1e6,125000).includes('LoRaWAN') && !act(868.1e6,125000).includes('Meshtastic'),'868.1 МГц при 125 кС/с: Meshtastic (250 кГц) не слушает'); }

// генератор → udec
const SR=1024000, BLK=1024;
function run(mode,genP,udP,hint,seconds,fc,sr=SR){
  ev(`globalThis.G={p:Object.assign({sr:'${sr}',fc:${fc??100e6},mode:'${mode}',off:0,lvl:-20,tone:1000,dev:5000,depth:.5,noise:-60,pocsag:'1200',ism:'OOK'},${JSON.stringify(genP)})}; IQK.iqGen.init(G);
         globalThis.U={p:Object.assign({mode:'auto',proto:'AIS',hold:6000},${JSON.stringify(udP||{})})}; IQK.udec.init(U);`);
  const recs=[], protos=new Set(), sts=new Set();
  const N=Math.round(seconds*sr/BLK);
  for(let i=0;i<N;i++){
    const o=ev(`(()=>{ const g=IQK.iqGen.process(G,{},{block:${BLK},sr:${sr}}); const o=IQK.udec.process(U,{in:g.iq,hint:${JSON.stringify(hint??null)}},{});
      return {rec:o.rec, proto:o.proto, locked:o.locked, st:U.ui.st}; })()`);
    if(o.rec) for(const r of o.rec) recs.push(r);
    if(o.proto) protos.add(o.proto); sts.add(o.st);
  }
  return {recs, protos:[...protos], sts:[...sts], last:ev('U.ui')};
}
// [режим генератора, частота (Гц), декодер, секунд, auto тоже?]; у частоты свой диапазон — слушает только пара декодеров
const cases=[['AIS',161.975e6,'aisRx',6,true],['POCSAG',466.075e6,'pocsagRx',6,true],['ISM433',433.92e6,'ismScan',6,true],['ISM433',433.92e6,'ismRx',6,false,256000],['ACARS',131.55e6,'acarsRx',6,true],
  ['ADS-B',1090e6,'adsbDemod',4,true,2.4e6],['DMR',450e6,'fskRx',3,false],['TETRA',420e6,'tetraRx',4,false],['MPT1327',150e6,'mpt1327Rx',3,false],['RS41',403e6,'rs41Rx',3,false]];
for(const [mode,fc,dec,secs,auto,sr] of cases){
  const kind=ctx.REG.find(r=>r.id===dec).kind;
  let r;
  if(auto){
    // auto: слушают декодеры диапазона частоты, остаётся тот, кто заговорил
    r=run(mode,{},{},null,secs,fc,sr);
    ok(r.recs.length>0 && r.recs.every(x=>x.decoder===dec),mode+' auto: записи есть и все от '+dec+' (получено '+r.recs.length+', '+[...new Set(r.recs.map(x=>x.decoder))]+')');
    ok(r.last.st==='lock' && r.last.act.length===1,mode+' auto: захват, состояние '+r.last.st);
  }
  // hint: сразу один декодер
  r=run(mode,{},{},kind,secs,fc,sr);
  ok(r.recs.length>0 && r.recs.every(x=>x.decoder===dec) && r.sts.length===1 && r.sts[0]==='hint' && r.last.act.length===1,mode+' hint: один декодер '+dec+', состояние hint');
}
// ADS-B: на выходе записи самолётов (после таблицы бортов), а не сырые кадры; при потоке ниже 1.9 МС/с демодулятор не слушает
{ const r=run('ADS-B',{},{},'adsb',6,1090e6,2.4e6);
  ok(r.recs.length>0 && r.recs.every(x=>x.proto==='ADS-B' && x.icao && isFinite(x.lat) && isFinite(x.lon)),'ADS-B: записи с позицией и icao ('+r.recs.length+')');
  ok(/aircraft \d+/.test(r.last.info||''),'ADS-B: строка таблицы бортов в ui ('+r.last.info+')');
  const r2=run('AIS',{},{},null,0.05,1090e6,256000); ok(!r2.last.act.includes('ADS-B'),'ADS-B не слушает поток 256 кС/с: '+r2.last.act); }
// LoRa: кадр через синтезатор → udec (auto, в диапазоне 863–870 МГц слушают обе настройки LoRa, декодирует та, чьи SF / ширина / слово синхронизации совпали)
function loraFrame(sf,bw,sync,fs,text){
  return ev(`(()=>{ const ldro=loraLdro('auto',${sf},${bw}); const syms=loraEncode(loraBytes(${JSON.stringify(text)}),{sf:${sf},cr:1,crc:true,ih:false,ldro});
    const f=loraSynth(syms,{sf:${sf},bw:${bw},pre:8,sync:${sync},cfo:0,ppm:0,amp:.5},${fs},Math.round(3000*${fs}/${bw})); return {re:f.re, im:f.im}; })()`);
}
function runLora(sf,bw,sync,fs,fc,text){
  const f=loraFrame(sf,bw,sync,fs,text), N=f.re.length;
  ev(`globalThis.UL={p:{mode:'auto',proto:'AIS',hold:6000,giveUp:8000}}; IQK.udec.init(UL);`);
  const got=[];
  for(let i=0;i<N;i+=4096){ const L=Math.min(4096,N-i); ctx.__c={sr:fs,fc,chunks:[{re:f.re.slice(i,i+L),im:f.im.slice(i,i+L),t0:i}]};
    const o=ev(`IQK.udec.process(UL,{in:__c},{block:4096,sr:${fs}})`); if(o.rec) for(const r of o.rec) got.push(r); }
  return got;
}
{ let g=runLora(7,125000,0x34,256000,868.1e6,'hello lorawan');
  ok(g.length>0 && g.every(r=>r.proto==='LoRaWAN' && /hello lorawan/.test(r.text||'')),'LoRaWAN SF7/125/0x34: кадр принят настройкой LoRaWAN ('+g.map(r=>r.proto+':'+r.text)+')');
  g=runLora(11,250000,0x2B,512000,869.525e6,'hello mesh');
  ok(g.length>0 && g.every(r=>r.proto==='Meshtastic' && /hello mesh/.test(r.text||'')),'SF11/250/0x2B: кадр принят настройкой Meshtastic ('+g.map(r=>r.proto+':'+r.text)+')'); }
ok(F('lorawan')?.proto==='LoRaWAN' && F('lora')?.proto==='Meshtastic' && F('meshAir')?.proto==='Meshtastic' && F('adsb')?.id==='adsbDemod','подсказки: lorawan, lora, meshAir, adsb');
// manual
{ const r=run('AIS',{},{mode:'manual',proto:'AIS'},null,4,161.975e6); ok(r.recs.length>0 && r.last.st==='manual','AIS manual'); }
// диапазон: у частоты 161.975 МГц декодеры только этого диапазона; частота вне всех диапазонов или неизвестна — слушают все
{ const r=run('AIS',{},{},null,0.05,161.975e6); ok(r.last.act.includes('AIS') && !r.last.act.includes('TETRA') && !r.last.act.includes('RS41'),'диапазон: 161.975 МГц → '+r.last.act);
  const r2=run('AIS',{},{},null,0.05,2.0e9); const fitN=sr=>ctx.REG.filter(r=>!r.route && (!r.minSr || sr>=r.minSr)).length;
  ok(r2.last.act.length===fitN(SR),'частота вне диапазонов → слушают все, кому хватает полосы потока ('+r2.last.act.length+' из '+ctx.REG.length+')');
  const r3=run('AIS',{},{},null,0.05,0); ok(r3.last.act.length===fitN(SR),'частота неизвестна → слушают все, кому хватает полосы потока ('+r3.last.act.length+')'); }
// без диапазона (fc=0) всё равно находит нужный: слушают все, остаётся AIS
{ const r=run('AIS',{},{},null,3,0); ok(r.recs.length>0 && r.recs.every(x=>x.decoder==='aisRx') && r.last.st==='lock','fc неизвестна: поиск среди всех находит AIS, состояние '+r.last.st); }
// чужой протокол в manual не декодирует
{ const r=run('AIS',{},{mode:'manual',proto:'ACARS'},null,4,161.975e6);
  ok(r.recs.length===0,'AIS в manual ACARS: чужой сигнал не декодируется ('+r.recs.length+')'); }
// ложная подсказка: сигнал AIS, подсказка acars — через giveUp узел слушает всех и находит AIS
{ const r=run('AIS',{},{giveUp:2000},'acars',8,161.975e6);
  ok(r.recs.length>0 && r.recs.every(x=>x.proto==='AIS') && r.last.st==='lock','ложная подсказка: откат к поиску и захват AIS, состояние '+r.last.st); }
// после тишины — обратно в поиск
{
  ev(`globalThis.U2={p:{mode:'auto',proto:'AIS',hold:1500}}; IQK.udec.init(U2);`);
  // имитируем захват и тишину
  ev(`U2.lock=UDEC_REG[0]; U2.lastRec=Date.now()-5000;`);
  const st=ev(`IQK.udec.process(U2,{in:null},{}); U2.ui.st`);
  ok(st==='search','после тишины hold — снова поиск, получено '+st);
}
if(bad){ console.error(bad+' ошибок'); process.exit(1); }
console.log('udec ok');
