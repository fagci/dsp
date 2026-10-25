// VDL Mode 2: передатчик D8PSK (vdl2-kernels.js) → IQK.vdl2Rx; заголовок, Рид—Соломон со стираниями, AVLC, ACARS, ошибки символов.
// Проверка: node tools/test-vdl2.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const worker=fs.readFileSync(path.join(root,'iq-worker.js'),'utf8');
const files=[...worker.match(/importScripts\((.*)\);/)[1].matchAll(/'([^']+)'/g)].map(m=>m[1].replace(/\+Q$/,''));
const ctx=vm.createContext({console,Math,Float32Array,Float64Array,Uint8Array,Uint8ClampedArray,Uint16Array,Uint32Array,Int8Array,Int16Array,Int32Array,Map,Set,Date,JSON,Array,Object,String,Number,parseInt,parseFloat,isFinite,isNaN,Symbol,Promise,BigInt,TextDecoder,TextEncoder,performance,WebAssembly,ArrayBuffer,DataView,RegExp,Error});
ctx.self=ctx;
for(const f of files) vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});
const ev=s=>vm.runInContext(s,ctx);
let bad=0; const ok=(c,m)=>{ if(!c){ bad++; console.error('FAIL: '+m); } else console.log('ok  '+m); };
ok(ev('typeof IQK.vdl2Rx')==='object','IQK.vdl2Rx есть в воркере');

let seed=11; const rnd=()=>{ seed=(seed*1664525+1013904223)>>>0; return seed/4294967296; };
const gauss=()=>Math.sqrt(-2*Math.log(rnd()+1e-12))*Math.cos(2*Math.PI*rnd());
// сообщение k → символы пакета
ev(`globalThis.mk=function(k,flip){ const m=VDL2_SIM[k%VDL2_SIM.length];
  const pay=[0xff,0xff,0x01,...vdl2AcarsBytes(m.text,k)];
  const fr=vdl2BuildFrame({addr:m.to,type:m.to===0x1B4002 ? 4 : 1,status:0},{addr:m.from,type:m.from===0x1B4002 ? 4 : 1,status:0},k&7,(k+1)&7,pay);
  const sym=vdl2BuildBurst([fr]); for(const i of (flip||[])) sym[i]=(sym[i]+1)%8; return sym; }`);
const burst=(k,flip,sr,df,noise)=>{
  ctx.__s=ev(`mk(${k},${JSON.stringify(flip||[])})`); ctx.__sr=sr;
  const [re,im]=ev(`vdl2Modulate(__s,__sr,40,200)`);
  const w=2*Math.PI*(df||0)/sr;
  for(let i=0;i<re.length;i++){ const c=Math.cos(w*i), s=Math.sin(w*i), a=re[i], b=im[i];
    re[i]=a*c-b*s+noise*gauss(); im[i]=a*s+b*c+noise*gauss(); }
  return {re,im};
};
function decode(sig,sr,chunk=4096){
  ev(`globalThis.R={p:{}}; IQK.vdl2Rx.init(R);`);
  const recs=[];
  for(let i=0;i<sig.re.length;i+=chunk){
    const L=Math.min(chunk,sig.re.length-i);
    ctx.__c={sr,fc:136.975e6,chunks:[{re:sig.re.subarray(i,i+L),im:sig.im.subarray(i,i+L),t0:i}]};
    const o=ev('IQK.vdl2Rx.process(R,{in:__c},{})'); if(o.rec) for(const r of o.rec) recs.push(r);
  }
  return {recs, ui:ev('R.ui')};
}
// RS: стирания и ошибки
ev(`globalThis.rsT=function(){ const cw=new Uint8Array(255); for(let i=0;i<249;i++) cw[i]=(i*37+11)&255; VDL2_RS.encode(cw); const orig=cw.slice();
  const out=[]; const t=(name,mut,er)=>{ const c=orig.slice(); mut(c); const r=vdl2RsFix(c,er); out.push([name,r,c.every((v,i)=>v===orig[i])]); };
  t('чисто',c=>{},[]);
  t('3 ошибки',c=>{ c[5]^=0x55; c[100]^=1; c[250]^=9; },[]);
  t('4 стирания',c=>{ for(const i of [251,252,253,254]) c[i]=0; },[251,252,253,254]);
  t('4 стирания + 1 ошибка',c=>{ for(const i of [251,252,253,254]) c[i]=0; c[7]^=0x80; },[251,252,253,254]);
  t('2 стирания + 2 ошибки',c=>{ c[253]=1; c[254]=2; c[10]^=3; c[20]^=4; },[253,254]);
  t('4 ошибки (сверх предела)',c=>{ c[1]^=1; c[2]^=1; c[3]^=1; c[4]^=1; },[]);
  return out; }`);
{ const r=ctx.rsT ? ev('rsT()') : [];
  ok(r[0][1]===0 && r[1][1]===3 && r[1][2],'RS: три ошибки исправлены');
  ok(r[2][2] && r[2][1]>=0,'RS: 4 стирания восстановлены');
  ok(r[3][2] && r[3][1]>=0,'RS: 4 стирания + 1 ошибка');
  ok(r[4][2],'RS: 2 стирания + 2 ошибки');
  ok(r[5][1]===-1 || !r[5][2],'RS: 4 ошибки — отказ, а не ложное исправление ('+r[5][1]+')'); }

// заголовок: БЧХ по таблице синдромов исправляет одиночную ошибку
ev(`globalThis.hdrT=function(){ let bad=0; for(const len of [100,800,3000,12000]){ let h=(vdl2Rev(len,17)<<5)>>>0; for(let i=0;i<5;i++) if(vdl2Par(h&VDL2_H[i])) h|=1<<(4-i);
  for(let b=0;b<22;b++){ let w=(h^(1<<b))>>>0, syn=0; for(let i=0;i<5;i++) syn|=vdl2Par(w&VDL2_H[i])<<(4-i); w=(w^VDL2_SYND[syn])>>>0; if(w!==h) bad++; } } return bad; }`);
ok(ev('hdrT()')===0,'заголовок: одиночная ошибка в любом из 22 бит исправляется');

const SR=105000;
for(const [sr,df,noise,name] of [[105000,0,0,'105 кС/с, чисто'],[250000,0,.01,'250 кС/с, шум'],[96000,300,.02,'96 кС/с, расстройка +300 Гц'],[48000,-250,.02,'48 кС/с, расстройка −250 Гц']]){
  for(const k of [0,1,2]){
    const r=decode(burst(k,[],sr,df,noise),sr);
    const m=r.recs.find(x=>x.kind==='message');
    const want=ev(`VDL2_SIM[${k}].text`);
    ok(m && m.reg===want.reg.replace(/^\.+/,'') && m.label===want.label && m.txt.includes(want.body),name+': сообщение '+k+' — '+(m ? m.reg+' '+m.label+' «'+m.txt.slice(0,40)+'»' : 'не принято ('+JSON.stringify(r.ui&&r.ui.cnt)+')'));
    if(k===0 && m) ok(m.from==='4840D6' && m.to==='1B4002' && m.fromType==='Aircraft' && m.toType==='Ground station' && m.frame==='I' && m.flight==='KL1234',name+': адреса AVLC и рейс');
  }
}
// ошибки символов (соседняя фаза = один бит = один байт) → RS(255,249) исправляет до трёх байт на блок
{ for(const f of [[60],[60,130,200]]){
    const r=decode(burst(0,f,105000,0,.005),105000);
    ok(r.recs.some(x=>x.kind==='message' && x.txt.includes('#M1BPOS') && x.fixed>=f.length),'ошибки в символах '+f+': кадр восстановлен RS ('+(r.recs[0]?.fixed??0)+' байт)');
  }
  const r=decode(burst(0,[40,100,160,220,280],105000,0,.005),105000);
  ok(!r.recs.some(x=>x.kind==='message'),'пять ошибок сверх предела: кадр отвергнут, ложного сообщения нет (FEC ошибок '+(r.ui.cnt.badFec)+')'); }
// пачка: несколько пакетов подряд через генератор IQK.iqGen
ev(`globalThis.G={p:{sr:'250000',fc:136975000,mode:'VDL2',off:500,lvl:-10,tone:1000,dev:5000,depth:.5,noise:-45,pocsag:'1200',ism:'OOK'}}; IQK.iqGen.init(G);
    globalThis.R2={p:{}}; IQK.vdl2Rx.init(R2);`);
{ const regs=new Set(); let n=0;
  for(let i=0;i<250000*4/1024;i++){
    const o=ev(`(()=>{ const g=IQK.iqGen.process(G,{},{block:1024,sr:250000}); const o=IQK.vdl2Rx.process(R2,{in:g.iq},{}); return o.rec||[]; })()`);
    for(const r of o){ if(r.kind==='message'){ n++; regs.add(r.reg); } } }
  ok(n>=4 && regs.size===2,'IQ Generator VDL2 → вся цепочка: '+n+' сообщений, борта '+[...regs]); }
// ложные срабатывания: чистый шум не даёт кадров
{ const L=250000*3, re=new Float32Array(L), im=new Float32Array(L); for(let i=0;i<L;i++){ re[i]=.2*gauss(); im[i]=.2*gauss(); }
  const r=decode({re,im},250000);
  ok(r.recs.length===0,'шум: ни одного кадра ('+r.recs.length+', пакетов '+(r.ui?.bursts)+')'); }
if(bad){ console.error(bad+' ошибок'); process.exit(1); }
console.log('vdl2 ok');
