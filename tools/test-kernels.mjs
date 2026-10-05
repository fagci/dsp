// Проверка ядер на фиксированных входах: node tools/test-kernels.mjs
// Грузит те же файлы, что iq-worker.js, в изолированный контекст vm (без DOM).
// «стандарт» — контрольное значение CRC на строке "123456789" из каталога CRC;
// «снимок» — результат, зафиксированный по текущему коду (ловит случайные изменения, не доказывает правильность).
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const worker=fs.readFileSync(path.join(root,'iq-worker.js'),'utf8');
const files=[...worker.match(/importScripts\((.*)\);/)[1].matchAll(/'([^']+)'/g)].map(m=>m[1].replace(/\+Q$/,''));

const ctx=vm.createContext({console,Math,Float32Array,Float64Array,Uint8Array,Uint16Array,Uint32Array,Int8Array,Int16Array,Int32Array,Map,Set,Date,JSON,Array,Object,String,Number,parseInt,parseFloat,isFinite,isNaN,Symbol,Promise,BigInt,DataView});
ctx.self=ctx;
for(const f of files) vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});
const ev=s=>vm.runInContext(s,ctx);

const MSG='Array.from("123456789",c=>c.charCodeAt(0))';
const bitsMsb=`${MSG}.flatMap(v=>Array.from({length:8},(_,k)=>(v>>(7-k))&1))`;
const bitsLsb=`${MSG}.flatMap(v=>Array.from({length:8},(_,k)=>(v>>k)&1))`;
const PAT='Array.from({length:30},(_,i)=>(i*37+11)&255)';
const PATB=`(${PAT}).flatMap(v=>Array.from({length:8},(_,k)=>(v>>(7-k))&1))`;
const hex=v=>Array.isArray(v) ? v.join(',') : '0x'+(v>>>0).toString(16).toUpperCase();

const cases=[
  // [название, выражение, ожидаемое, происхождение]
  ['popcnt32(0)','popcnt32(0)',0],
  ['popcnt32(0xFFFFFFFF)','popcnt32(0xFFFFFFFF)',32],
  ['popcnt32(0x80000001)','popcnt32(0x80000001)',2],
  ['bitsLsb','bitsLsb([0x2A,1]).join("")','0101010010000000'],
  ['bitsLsb(n)','bitsLsb([5,6,7],2).length',16],
  ['bitsMsb','Array.from(bitsMsb([0xA5])).join("")','10100101'],
  ['bitsNum','bitsNum([1,0,1,1],0,4)',11],
  ['bitsNum смещение','bitsNum([0,1,1],1,2)',3],
  ['bitsNum 24 бита','bitsNum(new Uint8Array(24).fill(1),0,24)',16777215],
  ['bitRev','bitRev(0xB3,8)',0xCD],
  ['bitRev 16','bitRev(1,16)',0x8000],
  ['bytesHex','bytesHex([1,171,255])','01ABFF'],
  ['bytesFromBits','Array.from(bytesFromBits(bitsMsb([0x12,0x34]))).join()','18,52'],
  ['u8cat','Array.from(u8cat(Uint8Array.of(1),Uint8Array.of(2,3))).join()','1,2,3'],

  ['CRC-16/XMODEM^FFFF dmrCrc16',`dmrCrc16(${MSG},9)`,'0xCE3C','стандарт'],
  ['CRC-16/M17 m17Crc',`m17Crc(${MSG},9)`,'0x772B','стандарт'],
  ['CRC-32/CKSUM p25Crc32',`p25Crc32(${MSG},9)`,'0x765E7680','стандарт'],
  ['CRC-16/KERMIT vacCrc',`vacCrc(${MSG},9)`,'0x2189','стандарт'],
  ['CRC-16/X-25 dstarCrc',`dstarCrc(${MSG},9)`,'0x906E','стандарт'],
  ['CRC-16/CCITT-FALSE tetraCrc',`tetraCrc(${bitsMsb},72)`,'0x29B1','стандарт'],
  ['CRC-16/MCRF4XX aisCrcBits',`aisCrcBits(${bitsLsb},72)`,'0x6F91','стандарт'],
  ['CRC-16/CCITT-FALSE rs41Crc',`rs41Crc(${MSG},0,9)`,'0x29B1','стандарт'],
  ['CRC-16/CCITT-FALSE nxdnCrc',`nxdnCrc(${bitsMsb},72,16,0x1021)`,'0x29B1','стандарт'],
  ['modesCrc (CRC-24 Mode S)',`modesCrc(${MSG},9)`,'0x54268','снимок'],
  ['dmrCrc32',`dmrCrc32(${MSG},9)`,'0x1437AC95','снимок'],
  ['dmrCrc9',`dmrCrc9(${bitsMsb})`,'0xE3','снимок'],
  ['dpmrCrc7',`dpmrCrc7(${bitsMsb},72)`,'0x75','снимок'],
  ['dpmrCrc8',`dpmrCrc8(Uint8Array.from(${bitsMsb}),72)`,'1,1,1,1,0,1,0,0','снимок'],
  ['mptCrcBits',`mptCrcBits(i=>(${bitsMsb})[i],72)`,'0x2566','снимок'],
  ['nxdnCrcCac',`nxdnCrcCac(${bitsMsb},72)`,'0xED6E','снимок'],
  ['stdcCrc',`stdcCrc(${MSG},0,9)`,'0,148','снимок'],

  // второй вход (30 байт) и другие ширины nxdnCrc
  ['dmrCrc16 (30 байт)',`dmrCrc16(${PAT},30)`,51428,'снимок'],
  ['m17Crc (30 байт)',`m17Crc(${PAT},30)`,20887,'снимок'],
  ['rs41Crc со смещением',`rs41Crc(${PAT},3,20)`,31096,'снимок'],
  ['vacCrc (30 байт)',`vacCrc(${PAT},30)`,33013,'снимок'],
  ['dstarCrc (30 байт)',`dstarCrc(${PAT},30)`,56670,'снимок'],
  ['tetraCrc 100 бит',`tetraCrc(${PATB},100)`,2300,'снимок'],
  ['tetraCrc 240 бит',`tetraCrc(${PATB},240)`,7518,'снимок'],
  ['nxdnCrc6',`nxdnCrc6(${PATB},50)`,40,'снимок'],
  ['nxdnCrc12',`nxdnCrc12(${PATB},100)`,1562,'снимок'],
  ['nxdnCrc15',`nxdnCrc15(${PATB},120)`,12026,'снимок'],
  ['nxdnCrc16 (200 бит)',`nxdnCrc(${PATB},200,16,0x1021)`,51987,'снимок'],

  // кодер → исправление ошибок: два сбитых бита в слове POCSAG восстанавливаются
  ['POCSAG encode→fix 2 ошибки','(()=>{ const w=pocEncode(0x12345), r=pocFix((w^(1<<3)^(1<<20))>>>0,2); return r && r[0]===w>>>0 && r[1]===2; })()',true],
  // развёртка HackRF: поток из блоков, режется на чтения произвольной длины, перед ним мусор с ложным 7F 7F
  ['hackrfSweepSplit: частоты и синхронизация',`(()=>{
    const blk=f=>{ const b=new Uint8Array(HRF_SWEEP_BLOCK); b[0]=b[1]=0x7F; new DataView(b.buffer).setUint32(2,f,true); b[10]=f/1e6&255; return b; };
    const fs=[100e6,105e6,110e6,100e6], parts=[Uint8Array.of(1,2,0x7F,0x7F,9,9,9), ...fs.map(blk)];
    const all=new Uint8Array(parts.reduce((a,p)=>a+p.length,0)); let o=0; for(const p of parts){ all.set(p,o); o+=p.length; }
    const st={buf:null,n:0,synced:false}, got=[];
    for(let i=0;i<all.length;i+=5000) hackrfSweepSplit(st, all.subarray(i,i+5000), 100e6, 115e6, (f,iq)=>got.push(f/1e6+':'+iq.length+':'+iq[0]));
    return got.join();
  })()`,'100:16374:100,105:16374:105,110:16374:110,100:16374:100'],
  ['hackrfSweepSplit: частота вне диапазона не синхронизирует',`(()=>{
    const b=new Uint8Array(HRF_SWEEP_BLOCK); b[0]=b[1]=0x7F; new DataView(b.buffer).setUint32(2,500e6,true);
    let c=0; hackrfSweepSplit({buf:null,n:0,synced:false}, b, 100e6, 115e6, ()=>c++); return c;
  })()`,0],
];

let bad=0;
for(const [name,expr,want,kind] of cases){
  let got;
  try{ got=ev(expr); }catch(e){ got='ОШИБКА: '+e.message; }
  const g=typeof want==='string' && want.startsWith('0x') ? hex(got) : got;
  const ok=g===want || String(g)===String(want);
  if(!ok){ bad++; console.log(`FAIL ${name}: ${g}, ожидалось ${want}`); }
}
console.log(bad ? `${bad} из ${cases.length} не прошли` : `OK: ${cases.length} проверок`);
process.exit(bad ? 1 : 0);
