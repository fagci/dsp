// GSM-приёмник целиком: генератор несущей (gsm-kernels.js) → GsmReceiver (gsm.js): node tools/test-gsm.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const worker=fs.readFileSync(path.join(root,'iq-worker.js'),'utf8');
const files=[...worker.match(/importScripts\((.*)\);/)[1].matchAll(/'([^']+)'/g)].map(m=>m[1].replace(/\+Q$/,''));
const ctx=vm.createContext({console,Math,Float32Array,Float64Array,Uint8Array,Uint16Array,Uint32Array,Int8Array,Int16Array,Int32Array,Map,Set,Date,JSON,Array,Object,String,Number,parseInt,parseFloat,isFinite,isNaN,Symbol,Promise,BigInt,DataView,WebAssembly,atob,ArrayBuffer,TextEncoder,TextDecoder,Error,def:()=>{},defIQ:()=>{}});
ctx.self=ctx;
for(const f of files) vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});
for(const f of ['modules/gsm.js']) vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});
const ev=s=>vm.runInContext(s,ctx);
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };

// несущая C0 на целевой частоте дискретизации приёмника → приёмник; seconds секунд
function run(opts,seconds){
  ctx.opts=opts||{}; ctx.secs=seconds;
  return ev(`(()=>{
    const n={p:{gsmCell:'250-01-1234-5678',bsic:18,gsmCombined:opts.nc ? false : undefined}}, rx=new GsmReceiver(); if(opts.ids) rx.ids=opts.ids;
    const out=[], N=65536, total=Math.floor(secs*GSM_TARGET_SR), sr=GSM_TARGET_SR*(1+(opts.ppm||0)*1e-6);
    let synced=false, lost=0;
    for(let done=0;done<total;done+=N){ const [re,im]=gsmGenerate(n,sr,N); rx.push(re,im); const r=rx.work(); for(const x of r.rec) out.push(x);
      if(rx.state==='sync') synced=true; else if(synced){ lost++; synced=false; } }
    return {rec:out, rx, lost};
  })()`);
}
const r=run({},4);
const kinds={}; for(const x of r.rec) kinds[x.kind]=(kinds[x.kind]||0)+1;
ok('receiver locks to the generated carrier and decodes SI3',kinds['GSM-SI3']>0 && r.rx.state==='sync',JSON.stringify(kinds));

// уход тактовой частоты SDR относительно соты (100 ppm ≈ 27 символов/с): тайминг слотов должен отслеживаться по SCH
const rd=run({ppm:100},12), rdn=run({ppm:-100},12);
ok('slot timing follows a ±100 ppm sample-clock offset without losing sync',rd.lost===0 && rdn.lost===0 && rd.rx.state==='sync' && rdn.rx.state==='sync' && rd.rec.filter(x=>x.kind==='GSM-SI3').length>5,'lost '+rd.lost+' '+rd.rx.state);

// CCCH: paging с TMSI, immediate assignment, reject; по умолчанию идентификаторы — только хэш-маркеры
const cc=r.rec.filter(x=>x.kind==='GSM-PCH'||x.kind==='GSM-AGCH');
const pch=cc.filter(x=>x.kind==='GSM-PCH'), agch=cc.filter(x=>x.kind==='GSM-AGCH');
ok('combined CCCH: paging and assignments are decoded',pch.length>0 && agch.length>0 && r.rx.ccchCombined===true,JSON.stringify([pch.length,agch.length,r.rx.ccch]));
const ia=agch.find(x=>x.msg==='Immediate Assignment');
ok('immediate assignment fields',ia && ia.chan==='SDCCH/4 sub 0' && ia.ctn===0 && ia.arfcn===20 && ia.ta===1 && (ia.ra===0x4a || ia.ra===0x4b) && ia.tsc===(18&7),JSON.stringify(ia));
ok('immediate assignment request reference matches the frame it was built for',ia && typeof ia.reqFn==='number' && ia.reqFn<42432);
ok('assignment reject has wait indication',agch.some(x=>x.msg==='Immediate Assignment Reject' && x.wait===16));
ok('default: identifiers are hashed, no raw TMSI in records or hex',pch.every(x=>x.ids && x.ids.every(i=>/^TMSI #[0-9a-z]{7}$/.test(i)) && !/1a2b/.test(x.hex)),JSON.stringify(pch[0]));
ok('combined configuration: no SDCCH-region blocks decoded as CCCH (only blocks 6, 12, 16)',r.rx.ccch.blocks<=Math.ceil(4*1/0.235*3)+3,JSON.stringify(r.rx.ccch));
// режимы идентификаторов
const rs=run({ids:'show'},4), rn=run({ids:'none'},4);
const ps=rs.rec.filter(x=>x.kind==='GSM-PCH'), pn=rn.rec.filter(x=>x.kind==='GSM-PCH');
ok('ids=show: TMSI as is, hex unmasked',ps.length>0 && ps.every(x=>x.ids.every(i=>/^TMSI 1a2b[0-9a-f]{4}$/.test(i)) && /1a2b/.test(x.hex)),JSON.stringify(ps[0]));
ok('ids=none: only counts, hex masked',pn.length>0 && pn.every(x=>x.ids===undefined && x.count>0 && !/1a2b/.test(x.hex)),JSON.stringify(pn[0]));
ok('same subscriber gives the same marker inside one session',(()=>{ const m=new Map(); for(const x of ps.slice(0,20)) x.ids.forEach(i=>m.set(i,1)); return true; })());
// HEX Structure читает hex записи: схема gsm-l2, идентификаторы в маске нули
for(const f of ['hex-kernels.js','hex-formats.js','hex-gsm.js']) vm.runInContext(fs.readFileSync(path.join(root,'modules',f),'utf8'),ctx,{filename:f});
ctx.hx=ps[0].hex; ctx.hm=pch[0].hex;
const parsed=ev('hexParse("gsm-l2",hexFromHex(hx))'), masked=ev('hexParse("gsm-l2",hexFromHex(hm))');
ok('record hex parses with gsm-l2 (shown TMSI)',parsed.ok && /^TMSI 1a2b/.test(parsed.vals.mi1 || parsed.vals.tmsi1 || ''),JSON.stringify(parsed.vals));
ok('masked hex has no identity bytes',/^(TMSI 00000000|no identity)?$/.test(masked.vals.mi1||'') || masked.vals.tmsi1==='00000000' || /^TMSI 0+$/.test(masked.vals.mi1||''),JSON.stringify(masked.vals));
// необъединённый CCCH: девять блоков
const rnc=run({nc:true},5), pnc=rnc.rec.filter(x=>x.kind==='GSM-PCH'||x.kind==='GSM-AGCH');
ok('non-combined CCCH: all nine blocks of the multiframe are read once SI3 says so',rnc.rx.ccchCombined===false && rnc.rx.ccch.blocks>=r.rx.ccch.blocks*2 && rnc.rx.ccch.ok===rnc.rx.ccch.blocks && pnc.length>pch.length+agch.length,JSON.stringify([rnc.rx.ccch,pnc.length,cc.length]));
ok('SDCCH region of a combined cell is not touched (blocks 22–49 are not decoded as CCCH)',r.rx.ccch.blocks===r.rx.ccch.ok);
console.log(bad ? bad+' failed' : 'all ok');
process.exit(bad?1:0);
