// Universal Decoder, несколько каналов (вход sigs): два сигнала в одном окне → каждый свой канал. IQ-генератор (AIS, POCSAG, ISM433, ACARS) → IQK.udec в режимах auto / hint / manual.
// Проверка: node tools/test-udec-multi.mjs
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


const SR=1024000, BLK=1024, FC=161.9e6;
ev(`globalThis.GA={p:{sr:'${SR}',fc:${FC},mode:'AIS',off:-200000,lvl:-20,tone:1000,dev:5000,depth:.5,noise:-60,pocsag:'1200',ism:'OOK'}}; IQK.iqGen.init(GA);
    globalThis.GB={p:{sr:'${SR}',fc:${FC},mode:'POCSAG',off:150000,lvl:-20,tone:1000,dev:5000,depth:.5,noise:-120,pocsag:'1200',ism:'OOK'}}; IQK.iqGen.init(GB);
    globalThis.AD={p:{ka:0,kb:0}}; IQK.iqAdd.init(AD);`);
// окно со смесью: AIS на 161.700 МГц, POCSAG на 162.050 МГц
function run(sigs,udP,seconds,hint){
  ev(`globalThis.UM={p:Object.assign({mode:'auto',proto:'AIS',hold:6000,giveUp:8000,maxCh:4,chHold:8000},${JSON.stringify(udP||{})})}; IQK.udec.init(UM);`);
  const recs=[]; let last=null;
  const N=Math.round(seconds*SR/BLK);
  for(let i=0;i<N;i++){
    const o=ev(`(()=>{ const a=IQK.iqGen.process(GA,{},{block:${BLK},sr:${SR}}).iq, b=IQK.iqGen.process(GB,{},{block:${BLK},sr:${SR}}).iq;
      const m=IQK.iqAdd.process(AD,{a,b}).out; const o=IQK.udec.process(UM,{in:m,sigs:${JSON.stringify(sigs)},hint:${JSON.stringify(hint??null)}},{});
      return {rec:o.rec, count:o.count, rows:UM.ui.rows}; })()`);
    if(o.rec) for(const r of o.rec) recs.push(r);
    last=o;
  }
  return {recs, rows:last.rows, count:last.count};
}
const A={f:161.7e6,nbw:25e3,db:-30,sig:true,dec:'aisRx'}, B={f:162.05e6,nbw:25e3,db:-35,sig:true,dec:'pocsagRx'};
// с подсказками
let r=run([A,B],{},6);
ok(r.count===2 && r.rows.length===2,'два канала ('+r.count+')');
ok(r.recs.some(x=>x.proto==='AIS') && r.recs.some(x=>x.proto==='POCSAG'),'декодированы оба сигнала: '+[...new Set(r.recs.map(x=>x.proto))]);
ok(r.recs.filter(x=>x.proto==='AIS').every(x=>Math.abs(x.f-161.7e6)<1e3) && r.recs.filter(x=>x.proto==='POCSAG').every(x=>Math.abs(x.f-162.05e6)<1e3),'записи несут частоту своего канала');
ok(new Set(r.recs.map(x=>x.ch)).size===2,'у каналов разные номера ch');
ok(r.rows.every(x=>x.st==='hint'),'оба в режиме hint: '+r.rows.map(x=>x.st));
// без подсказок: по диапазону слушают несколько, остаётся заговоривший
r=run([{...A,dec:''},{...B,dec:''}],{},8);
ok(r.recs.some(x=>x.proto==='AIS') && r.recs.some(x=>x.proto==='POCSAG') && r.recs.every(x=>(x.proto==='AIS')===(Math.abs(x.f-161.7e6)<1e3)),'auto: каждый сигнал декодирован своим декодером, без перепутывания: '+[...new Set(r.recs.map(x=>x.proto+'@'+Math.round(x.f/1e3)))]);
// maxCh берёт сильнейшие
r=run([A,B,{f:161.95e6,nbw:25e3,db:-60,sig:true,dec:'ismRx'}],{maxCh:2},0.5);
ok(r.rows.length===2 && r.rows.every(x=>x.f!==161.95e6),'maxCh=2: остались два сильнейших ('+r.rows.map(x=>x.f)+')');
// канал сворачивается, когда сигнала нет дольше chHold
{ ev(`globalThis.UM2={p:{mode:'auto',proto:'AIS',hold:6000,giveUp:8000,maxCh:4,chHold:400}}; IQK.udec.init(UM2);`);
  const feed=sigs=>ev(`(()=>{ const a=IQK.iqGen.process(GA,{},{block:${BLK},sr:${SR}}).iq; const o=IQK.udec.process(UM2,{in:a,sigs:${JSON.stringify(sigs)}},{}); return UM2.ui.rows.length; })()`);
  for(let i=0;i<20;i++) feed([A]);
  ok(feed([A])===1,'канал создан');
  const t0=Date.now(); let n=1; while(n>0 && Date.now()-t0<5000) n=feed([]);
  ok(n===0,'канал свёрнут после chHold, когда сигнал пропал'); }
// канал не дублируется при дрожании частоты метки
{ ev(`globalThis.UM3={p:{mode:'auto',proto:'AIS',hold:6000,giveUp:8000,maxCh:4,chHold:8000}}; IQK.udec.init(UM3);`);
  let rows=0; for(let i=0;i<30;i++){ rows=ev(`(()=>{ const a=IQK.iqGen.process(GA,{},{block:${BLK},sr:${SR}}).iq; IQK.udec.process(UM3,{in:a,sigs:[{f:${161.7e6+(i%5)*300},nbw:25e3,db:-30,sig:true}]},{}); return UM3.ui.rows.length; })()`); }
  ok(rows===1,'дрожание частоты метки не плодит каналы ('+rows+')'); }
// режим одного канала (без sigs) не затронут
{ ev(`globalThis.US={p:{mode:'auto',proto:'AIS',hold:6000,giveUp:8000}}; IQK.udec.init(US);`);
  const o=ev(`(()=>{ const a=IQK.iqGen.process(GA,{},{block:${BLK},sr:${SR}}).iq; IQK.udec.process(US,{in:a},{}); return US.ui; })()`);
  ok(!o.multi && o.st==='search','без sigs — один канал, как раньше'); }
if(bad){ console.error(bad+' ошибок'); process.exit(1); }
console.log('udec multi ok');
