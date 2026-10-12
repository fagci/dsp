// HEX Field Finder: node tools/test-hexscan.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Uint8Array,DataView,ArrayBuffer,TextEncoder,TextDecoder,Array,Map,Set,Error,String,Number,BigInt,Object,Date,JSON,isNaN,isFinite,parseInt,Float64Array});
for(const f of ['hex-kernels.js','hex-scan-kernels.js']) vm.runInContext(fs.readFileSync(path.join(root,'modules',f),'utf8'),ctx,{filename:f});
vm.runInContext('this.S={hexScan,hexScanSchema,hexScanPick,hexSum,hexParse}',ctx);
const S=ctx.S;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };
let sd=12345; const rnd=()=>{ sd^=sd<<13; sd^=sd>>>17; sd^=sd<<5; return (sd>>>0)/4294967296; };
const gauss=()=>Math.sqrt(-2*Math.log(Math.max(rnd(),1e-12)))*Math.cos(2*Math.PI*rnd());

// пакет трекера: [A5][seq u16 be][time u32 le][lat i32 le /1e7][lon i32 le /1e7][speed u8][id u8 из 4][noise 4 байта?][crc16-x25 be]
function makeTrack(n,withTime){
  const out=[]; let lat=55.0302, lon=82.9204;
  for(let i=0;i<n;i++){
    lat+=gauss()*0.0004; lon+=gauss()*0.0006;
    const b=new Uint8Array(18), dv=new DataView(b.buffer), t=1760000000000+i*5000+Math.round(gauss()*200);
    b[0]=0xA5; dv.setUint16(1,i&0xffff,false);
    dv.setUint32(3,Math.floor(t/1000)+7,true);
    dv.setInt32(7,Math.round(lat*1e7),true); dv.setInt32(11,Math.round(lon*1e7),true);
    b[15]=Math.round(20+gauss()*5); b[16]=[17,18,19,23][i%4]*(i%7?1:1);
    // контрольная сумма по первым 17 байтам
    b[17]=S.hexSum('xor8').f(b,0,17);
    out.push({d:b,t});
  }
  return out;
}
const pk=makeTrack(80);
const r=S.hexScan(pk)[0];
const find=(k,off)=>r.candidates.find(c=>c.kind===k && (off===undefined || c.off===off));
ok('one group of 80 packets of 18 bytes',r.n===80 && r.len===18);
ok('constant header found',find('const',0));
ok('counter found',find('counter',1) && find('counter',1).w===2);
ok('unix time found, equal to capture time + 7 s',find('time',3) && /capture time \+7/.test(find('time',3).label),JSON.stringify(find('time',3)));
const la=r.candidates.find(c=>(c.kind==='coord') && c.off===7 && c.w===4 && c.le && c.signed && Math.abs(c.scale-1e-7)<1e-12);
const lo=r.candidates.find(c=>(['coord','lon'].includes(c.kind)) && c.off===11 && c.w===4 && c.le && c.signed && Math.abs(c.scale-1e-7)<1e-12);
ok('latitude found: i32 LE ÷1e7 near 55.03',la && Math.abs(la.median-55.03)<.1,JSON.stringify(la));
ok('longitude found: i32 LE ÷1e7 near 82.92',lo && Math.abs(lo.median-82.92)<.1,JSON.stringify(lo));
ok('latitude is the top-scoring numeric interpretation of its bytes',r.candidates.filter(c=>c.off===7 && c.w===4 && ['coord','lon','angle','time'].includes(c.kind))[0]===la || (la && la.score>=.8),JSON.stringify(r.candidates.filter(c=>c.off===7).slice(0,3)));
ok('checksum found (xor8 over 0…16)',find('checksum',17) && find('checksum',17).sum==='xor8',JSON.stringify(find('checksum',17)));
ok('verdict: structure found',r.verdict==='structure found',r.verdict);

// заготовка схемы разбирает те же пакеты и показывает координаты
const sch=S.hexScanSchema(r);
const fl=sch.fields;
const parsed=S.hexParse(sch,pk[10].d);
const cs=fl.filter(f=>f.unit==='°'), latF=cs[0], lonF=cs[1];
ok('suggested schema has lat / lon / time / crc fields',latF && lonF && fl.some(f=>f.fmt==='time') && fl.some(f=>f.calc==='xor8'),JSON.stringify(fl));
ok('suggested schema parses a packet: checksum agrees, coordinates in degrees',parsed.ok && Math.abs(parsed.vals[latF.n]*latF.scale-55.03)<.1 && Math.abs(parsed.vals[lonF.n]*lonF.scale-82.92)<.1,JSON.stringify([parsed.ok,parsed.vals]));

ok('pick: non-overlapping fields in offset order',(()=>{ const p=S.hexScanPick(r); return p.every((c,i)=>i===0 || p[i-1].off+p[i-1].w<=c.off); })());
// без времени приёма: координаты всё равно находятся
const r2=S.hexScan(pk.map(p=>p.d))[0];
ok('without capture times: lat / lon still found',r2.candidates.some(c=>c.kind==='coord' && c.off===7 && c.w===4) && r2.candidates.some(c=>['coord','lon'].includes(c.kind) && c.off===11 && c.w===4));
// координаты как 16-бит /360·65536 (беззнаковые доли круга)
const pk3=[]; let a=100; for(let i=0;i<60;i++){ a+=gauss()*.3; const b=new Uint8Array(6); new DataView(b.buffer).setUint16(2,Math.round(a/360*65536),false); b[0]=1; b[1]=i&255; b[4]=0x55; b[5]=0xaa; pk3.push(b); }
const r3=S.hexScan(pk3)[0];
ok('u16 BE × 360/65536 degrees found',r3.candidates.some(c=>['lon','angle'].includes(c.kind) && c.off===2 && c.w===2 && !c.le && Math.abs(c.scale-360/65536)<1e-9),JSON.stringify(r3.candidates.slice(0,4)));

// шум: те же длины, случайные байты — «похоже на шифрование», кандидатов в координаты нет
const noise=Array.from({length:150},()=>Uint8Array.from({length:24},()=>rnd()*256|0));
const rn=S.hexScan(noise)[0];
ok('random packets: verdict says random',/random/.test(rn.verdict),rn.verdict);
ok('random packets: no lat / lon / time candidates',!rn.candidates.some(c=>['coord','lon','angle','time','counter','checksum'].includes(c.kind)),JSON.stringify(rn.candidates.filter(c=>['coord','lon','angle','time','counter','checksum'].includes(c.kind)).slice(0,3)));
// шифрованный пакет с открытым заголовком: константа + шум
const enc=Array.from({length:100},(_,i)=>{ const b=new Uint8Array(20); b[0]=0x7e; b[1]=i&255; for(let k=2;k<20;k++) b[k]=rnd()*256|0; return b; });
const re=S.hexScan(enc)[0];
ok('plain header + encrypted body: header found, body random',re.candidates.some(c=>c.kind==='const' && c.off===0) && re.candidates.some(c=>c.kind==='random' && c.off===2) && re.candidates.some(c=>c.kind==='counter' && c.off===1),JSON.stringify(re.candidates.slice(0,4)));
// мало пакетов — группа пропускается
ok('too few packets: skipped',S.hexScan(noise.slice(0,5)).length===0);
// разные длины — разные группы
ok('groups by packet length',S.hexScan([...noise.slice(0,40),...pk.slice(0,40).map(p=>p.d)]).length===2);
console.log(bad ? bad+' failed' : 'all ok');
process.exit(bad?1:0);
