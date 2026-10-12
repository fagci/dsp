// Записи декодеров с hex / hexSchema против схем HEX Structure: node tools/test-hexdec.mjs
// Те же ядра, что у iq-worker.js (изолированный vm), плюс модули hex-*.js.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const worker=fs.readFileSync(path.join(root,'iq-worker.js'),'utf8');
const files=[...worker.match(/importScripts\((.*)\);/)[1].matchAll(/'([^']+)'/g)].map(m=>m[1].replace(/\+Q$/,''));
const ctx=vm.createContext({console,Math,Float32Array,Float64Array,Uint8Array,Uint16Array,Uint32Array,Int8Array,Int16Array,Int32Array,Map,Set,Date,JSON,Array,Object,String,Number,parseInt,parseFloat,isFinite,isNaN,Symbol,Promise,BigInt,DataView,WebAssembly,atob,ArrayBuffer,TextEncoder,TextDecoder,Error});
ctx.self=ctx;
for(const f of files) vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});
for(const f of ['hex-kernels.js','hex-formats.js']) vm.runInContext(fs.readFileSync(path.join(root,'modules',f),'utf8'),ctx,{filename:f});
const ev=s=>vm.runInContext(s,ctx);
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };

// ACARS: блок, как его собирает генератор ядра (чётность, BCS), через done() декодера
{
  const r=ev(`(()=>{
    const m={mode:'2',reg:'.D-AIBA',ack:0x15,label:'H1',blk:'3',flight:'LH1234',body:'#M1BPOS N55123E037456,FL350'};
    const c=[m.mode.charCodeAt(0)]; for(const ch of m.reg) c.push(ch.charCodeAt(0));
    c.push(m.ack,m.label.charCodeAt(0),m.label.charCodeAt(1),m.blk.charCodeAt(0));
    const txt='M07A'+m.flight+m.body; c.push(2); for(const ch of txt) c.push(ch.charCodeAt(0)); c.push(3);
    const by=c.map(vacPar), crc=vacCrc(by,by.length); by.push(crc&0xFF,crc>>8);
    const n={p:{fix:false},seen:[],sps:10,frames:0,fixed:0,bad:0,recent:[],pk:.5,badTe:-1e9}, recs=[];
    IQK.acarsRx.done(n,{by,pe:[],ip:0},100,recs);
    return recs;
  })()`);
  const rec=r[0];
  ok('acars record emitted',r.length===1 && rec.hexSchema==='acars' && typeof rec.hex==='string',JSON.stringify(rec));
  const p=ev(`hexParse(${JSON.stringify(rec.hexSchema)},hexFromHex(${JSON.stringify(rec.hex)}))`);
  const v=p.vals;
  ok('acars block parsed',v.mode==='2' && v.reg==='.D-AIBA' && v.label==='H1' && v.blk===51 && v.msgno==='M07A' && v.flight==='LH1234' && v.text==='#M1BPOS N55123E037456,FL350' && v.end===3,JSON.stringify(v));
  ok('acars matches decoder fields',rec.reg==='D-AIBA' && rec.flight==='LH1234' && rec.label==='H1');
}

// BLE: событие рекламы → AD → схема (iBeacon, Eddystone-URL, имя, TX power)
{
  vm.runInContext(fs.readFileSync(path.join(root,'modules/ble-kernels.js'),'utf8'),ctx,{filename:'ble-kernels.js'});
  const ib=new Uint8Array([2,0x15,0xB9,0x40,0x7F,0x30,0xF5,0xF8,0x46,0x6E,0xAF,0xF9,0x25,0x55,0x6B,0x57,0xFE,0x6D,0,1,0,2,0xC5]);
  ctx.ib=ib; ctx.ev1={name:'Tag',txPower:-12,manufacturerData:new Map([[0x4C,new DataView(ib.buffer)]]),serviceData:new Map([['0000feaa-0000-1000-8000-00805f9b34fb',new DataView(new Uint8Array([0x10,0xEB,0x02,0x67,0x6F,0x6F,0x67,0x6C,0x65,0x07]).buffer)]])};
  const hexs=ev('hexToHex(bleAdBytes(ev1))');
  const p=ev(`hexParse('ble-adv',hexFromHex('${hexs}'))`), v=p.vals;
  ok('ble adv parsed',p.ok && v['ad[0].data.name']==='Tag' && v['ad[1].data.tx']===-12,JSON.stringify(v));
  ok('ibeacon',v['ad[2].data.company']===76 && v['ad[2].data.major']===1 && v['ad[2].data.minor']===2 && v['ad[2].data.tx']===-59 && v['ad[2].data.uuid']==='b9407f30f5f8466eaff925556b57fe6d',JSON.stringify(v));
  ok('eddystone url',v['ad[3].data.uuid']===0xFEAA && v['ad[3].data.etype']===16 && v['ad[3].data.etx']===-21 && v['ad[3].data.scheme']===2 && v['ad[3].data.url']==='google\x07',JSON.stringify(v));
  // эталонная реклама iBeacon целиком: flags + manufacturer (из спецификации Apple), сырой пакет
  const raw=ev("hexParse('ble-adv',hexFromHex('020106 1aff4c000215b9407f30f5f8466eaff925556b57fe6d00010002c5'))");
  ok('ibeacon raw advertisement',raw.ok && raw.vals['ad[0].data.flags']===6 && raw.vals['ad[1].data.major']===1,JSON.stringify(raw.vals));
}

// GSM: L2-сообщения SI3 / SI4 / SI1 — схема против разбора gsmParseSI самого декодера
{
  ctx.def=()=>{}; ctx.defIQ=()=>{};
  vm.runInContext(fs.readFileSync(path.join(root,'modules/gsm.js'),'utf8'),ctx,{filename:'gsm.js'});
  const si3=[0x59,0x06,0x1b, 0x12,0x34, 0x52,0xf0,0x10, 0x01,0xf4, 0x01,0x02,0x03, 0x45, 0x2a,0x3b, 0x04,0x05,0x06, 0x2b,0x2b,0x2b,0x2b];
  const si4=[0x31,0x06,0x1c, 0x25,0xf0,0x11, 0x00,0x7b, 0x2a,0x3b, 0x04,0x05,0x06, 0x2b,0x2b,0x2b,0x2b,0x2b,0x2b,0x2b,0x2b,0x2b,0x2b];
  ctx.si3=si3; ctx.si4=si4;
  const d3=ev('gsmParseSI(si3)'), p3=ev(`hexParse('gsm-l2',Uint8Array.from(si3))`);
  ok('gsm si3 matches the decoder',d3.type==='SI3' && p3.vals.ci===d3.ci && p3.vals.lac===d3.lac && p3.vals.plmn===ev('gsmMccMncStr(gsmParseSI(si3))') && p3.vals.mt===0x1b,JSON.stringify([d3.ci,d3.lac,ev('gsmMccMncStr(gsmParseSI(si3))'),p3.vals]));
  const d4=ev('gsmParseSI(si4)'), p4=ev(`hexParse('gsm-l2',Uint8Array.from(si4))`);
  ok('gsm si4 matches the decoder',d4.type==='SI4' && p4.vals.lac===d4.lac && p4.vals.plmn===ev('gsmMccMncStr(gsmParseSI(si4))'),JSON.stringify([d4.lac,ev('gsmMccMncStr(gsmParseSI(si4))'),p4.vals]));
  ctx.b3=ev(`hexBuild('gsm-l2',{li:22,m:0,el:1,skip:0,pd:6,mt:27,ci:4660,plmn:'250-01',lac:500}).bytes`);
  const rt=ev('hexParse("gsm-l2",b3)');
  ok('plmn build round trip',rt.vals.plmn==='250-01' && rt.vals.ci===4660 && rt.vals.lac===500 && ev('gsmParseSI(b3)').mcc===250,JSON.stringify(rt.vals));
}

// M17: LSF от генератора ядра → схема; позывные основания 40 и CRC-16 против m17Crc / m17CallDec
{
  const meta=new Uint8Array(14);
  ctx.lsfb=ev("(()=>{ const m=new Uint8Array(14); m.set(m17CallEnc('SP5WWP'),0); m.set(m17CallEnc('M17-M17 C'),6); return m17MakeLsf('SP5WWP','W2FBI',0x0005|(3<<7)|(2<<5),m); })()");
  const p=ev('hexParse("m17-lsf",lsfb)'), v=p.vals;
  ok('m17 lsf parsed',v.src==='SP5WWP' && v.dst==='W2FBI' && v.can===3 && v.dtype===2 && v.stream===1 && v.sub===2 && p.ok,JSON.stringify(v));
  ok('m17 crc agrees with the decoder',ev('m17Crc(lsfb,30)')===0 && p.fields.find(f=>f.n==='crc').calcOk===true);
  const bc=ev(`hexBuild('m17-lsf',{dst:'BROADCAST',src:'SP5WWP',can:3,dtype:2,stream:1,sub:2,enc:0,meta:'00'})`);
  ctx.bcb=bc.bytes; 
  ok('m17 build: broadcast, crc',ev('m17Crc(bcb,30)')===0 && ev('m17CallDec(bcb.subarray(0,6))')==='BROADCAST' && ev('m17CallDec(bcb.subarray(6,12))')==='SP5WWP',ev('bytesHex(bcb)'));
  const pk=ev('hexParse("m17-pkt",hexFromHex("0548454c4c4f"))');
  ok('m17 packet: SMS',pk.vals.proto===5 && pk.vals.data==='48454c4c4f');
}
console.log(bad ? bad+' failed' : 'all ok');
process.exit(bad?1:0);
