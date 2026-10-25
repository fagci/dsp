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
ok(ev('typeof IQK.udec')==='object','IQK.udec есть в воркере');

// подсказки
ev(`globalThis.F=udecFind;`);
const F=ctx.F;
ok(F('aisRx')?.proto==='AIS' && F('POCSAG')?.id==='pocsagRx' && F('ism')?.id==='ismRx' && F(' ACARS ')?.id==='acarsRx','подсказка: id, имя протокола и вид каталога');
ok(F({decoder:'aisRx'})?.id==='aisRx' && F({kind:'pocsag'})?.id==='pocsagRx' && F(['x','ism'])?.id==='ismRx','подсказка: запись и массив');
ok(F('adsbDemod → adsbDecode')===null && F('')===null && F(null)===null && F(7)===null,'неизвестное — null');
// параметры по умолчанию реестра совпадают с описаниями модулей
const defs={aisRx:'ais.js',pocsagRx:'pocsag.js',ismRx:'ism.js',acarsRx:'acars.js',fskRx:'fsk4.js',mpt1327Rx:'mpt1327.js',tetraRx:'tetra.js',rs41Rx:'sonde.js'};
ev(`globalThis.REG=UDEC_REG;`);
for(const r of ctx.REG){
  const src=fs.readFileSync(path.join(root,'modules',defs[r.id]),'utf8');
  const blk=src.slice(src.indexOf("id:'"+r.id+"'"), src.indexOf('n=>{',src.indexOf("id:'"+r.id+"'")));
  for(const k in r.p){
    const m=blk.match(new RegExp("\\{n:'"+k+"',[^}]*?d:('[^']*'|[-\\d.]+|true|false)"));
    ok(!!m,r.id+': параметр '+k+' есть в описании модуля');
    if(m){ const d=m[1].startsWith("'") ? m[1].slice(1,-1) : m[1]==='true' ? true : m[1]==='false' ? false : +m[1];
      ok(d===r.p[k],r.id+'.'+k+': по умолчанию в модуле '+d+', в реестре '+r.p[k]); }
  }
}

// генератор → udec
const SR=1024000, BLK=1024;
function run(mode,genP,udP,hint,seconds,fc){
  ev(`globalThis.G={p:Object.assign({sr:'${SR}',fc:${fc??100e6},mode:'${mode}',off:0,lvl:-20,tone:1000,dev:5000,depth:.5,noise:-60,pocsag:'1200',ism:'OOK'},${JSON.stringify(genP)})}; IQK.iqGen.init(G);
         globalThis.U={p:Object.assign({mode:'auto',proto:'AIS',hold:6000},${JSON.stringify(udP||{})})}; IQK.udec.init(U);`);
  const recs=[], protos=new Set(), sts=new Set();
  const N=Math.round(seconds*SR/BLK);
  for(let i=0;i<N;i++){
    const o=ev(`(()=>{ const g=IQK.iqGen.process(G,{},{block:${BLK},sr:${SR}}); const o=IQK.udec.process(U,{in:g.iq,hint:${JSON.stringify(hint??null)}},{});
      return {rec:o.rec, proto:o.proto, locked:o.locked, st:U.ui.st}; })()`);
    if(o.rec) for(const r of o.rec) recs.push(r);
    if(o.proto) protos.add(o.proto); sts.add(o.st);
  }
  return {recs, protos:[...protos], sts:[...sts], last:ev('U.ui')};
}
// [режим генератора, частота (Гц), декодер, секунд, auto тоже?]; у частоты свой диапазон — слушает только пара декодеров
const cases=[['AIS',161.975e6,'aisRx',6,true],['POCSAG',466.075e6,'pocsagRx',6,true],['ISM433',433.92e6,'ismRx',6,true],['ACARS',131.55e6,'acarsRx',6,true],
  ['DMR',450e6,'fskRx',3,false],['TETRA',420e6,'tetraRx',4,false],['MPT1327',150e6,'mpt1327Rx',3,false],['RS41',403e6,'rs41Rx',3,false]];
for(const [mode,fc,dec,secs,auto] of cases){
  const kind=ctx.REG.find(r=>r.id===dec).kind;
  let r;
  if(auto){
    // auto: слушают декодеры диапазона частоты, остаётся тот, кто заговорил
    r=run(mode,{},{},null,secs,fc);
    ok(r.recs.length>0 && r.recs.every(x=>x.decoder===dec),mode+' auto: записи есть и все от '+dec+' (получено '+r.recs.length+', '+[...new Set(r.recs.map(x=>x.decoder))]+')');
    ok(r.last.st==='lock' && r.last.act.length===1,mode+' auto: захват, состояние '+r.last.st);
  }
  // hint: сразу один декодер
  r=run(mode,{},{},kind,secs,fc);
  ok(r.recs.length>0 && r.recs.every(x=>x.decoder===dec) && r.sts.length===1 && r.sts[0]==='hint' && r.last.act.length===1,mode+' hint: один декодер '+dec+', состояние hint');
}
// manual
{ const r=run('AIS',{},{mode:'manual',proto:'AIS'},null,4,161.975e6); ok(r.recs.length>0 && r.last.st==='manual','AIS manual'); }
// диапазон: у частоты 161.975 МГц декодеры только этого диапазона; частота вне всех диапазонов или неизвестна — слушают все
{ const r=run('AIS',{},{},null,0.05,161.975e6); ok(r.last.act.includes('AIS') && !r.last.act.includes('TETRA') && !r.last.act.includes('RS41'),'диапазон: 161.975 МГц → '+r.last.act);
  const r2=run('AIS',{},{},null,0.05,2.0e9); ok(r2.last.act.length===ctx.REG.length,'частота вне диапазонов → слушают все ('+r2.last.act.length+')');
  const r3=run('AIS',{},{},null,0.05,0); ok(r3.last.act.length===ctx.REG.length,'частота неизвестна → слушают все'); }
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
