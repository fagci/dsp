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

// ---- Физическая величина по эталону ----
// Метеодатчик, 9 байт: [0xA5][id][seq][флаги: бит 4 — батарея][temp 12 бит с бита 20 = (T+40)·10][влажность u8][давление u16 LE, 0.1 гПа][xor8]
function makeSensor(n,o={}){
  const out=[]; let T=15, H=50, P=1005;
  for(let i=0;i<n;i++){
    T+=gauss()*.4+Math.sin(i/9)*.15; H=Math.max(10,Math.min(95,H+gauss()*1.2)); P=1005+25*Math.sin(i/11)+gauss()*.3;
    const b=new Uint8Array(9);
    b[0]=0xA5; b[1]=0x3C; b[2]=i&255; b[3]=(i%23===0 ? 0x10 : 0);
    const rt=Math.round((T+40)*10);                                  // 12 бит: байт 4 (старшие 8) и верхняя половина байта 5
    b[3]|=0; b[4]=(rt>>4)&255; b[5]=((rt&15)<<4)|(o.nib||0);
    b[6]=Math.round(H); const pp=Math.round(P*10); b[7]=pp&255; b[8]=pp>>8;
    out.push({d:b,t:1.76e12+i*30000,ref:o.ref==='H' ? H : o.ref==='P' ? P : T+gauss()*.05,T,H,P});
  }
  return out;
}
const sens=makeSensor(120);
const rq=S.hexScan(sens,{refName:'temperature',refUnit:'°C'})[0];
const qt=rq.candidates.filter(c=>c.kind==='quantity');
const t1=qt[0];
ok('reference: temperature found at the 12-bit window starting at bit 32',t1 && t1.b0===32 && t1.wb===12,JSON.stringify(t1));
ok('reference: scale snapped to 0.1, offset −40 ± 0.05, r > 0.999',t1 && t1.scale===.1 && Math.abs(t1.bias+40)<.05 && t1.r>.999,JSON.stringify(t1));
ok('reference: the label reads like a formula with the unit',t1 && /temperature ≈ 0\.1·x − 40/.test(t1.label) && /°C/.test(t1.label),t1&&t1.label);
// эталон — влажность: находит байт 6, масштаб 1, смещение 0
const rh=S.hexScan(makeSensor(120,{ref:'H'}))[0].candidates.find(c=>c.kind==='quantity');
ok('reference: humidity is the byte at 6 (scale 1, offset 0)',rh && rh.b0===48 && rh.wb===8 && rh.scale===1 && Math.abs(rh.bias)<.3,JSON.stringify(rh));
// эталон — давление: 16 бит little-endian, 0.1 гПа
const rp=S.hexScan(makeSensor(120,{ref:'P'}))[0].candidates.find(c=>c.kind==='quantity');
ok('reference: pressure is a LE u16 at 7, scale 0.1',rp && rp.b0===56 && rp.wb===16 && rp.le===true && rp.scale===.1 && Math.abs(rp.bias)<.2,JSON.stringify(rp));
// схема: те же пакеты читаются, значение = x·scale + bias совпадает с температурой
const sch2=S.hexScanSchema(rq,.6), tf=sch2.fields.find(f=>f.bias!==undefined);
const pr=S.hexParse(sch2,sens[40].d);
ok('reference: schema has a bits field with scale / bias / unit',tf && tf.t==='bits' && tf.w===12 && tf.scale===.1 && tf.bias===-40 && tf.unit==='°C',JSON.stringify(sch2.fields));
ok('reference: schema parses a packet to the right temperature (±0.2)',pr.ok!==false && tf && Math.abs(pr.vals[tf.n]*tf.scale+tf.bias-sens[40].T)<.2,JSON.stringify([pr.vals[tf&&tf.n],sens[40].T]));
// BCD-термометр: три цифры «234» = 23.4
const bcdPk=Array.from({length:80},(_,i)=>{ const T=20+4*Math.sin(i/7)+gauss()*.05, v=Math.round(T*10), b=new Uint8Array(5); b[0]=0x55; b[1]=((v/100|0)<<4)|((v/10|0)%10); b[2]=((v%10)<<4)|0x0; b[3]=i&255; b[4]=0xEE; return {d:b,t:i*1000,ref:T}; });
const rb=S.hexScan(bcdPk)[0].candidates.find(c=>c.kind==='quantity');
ok('reference: BCD digits (3 nibbles from byte 1) → 0.1 per step',rb && rb.bcd && rb.b0===8 && rb.wb===12 && rb.scale===.1,JSON.stringify(rb));
// счётчик не принимается за величину, даже когда эталон — плавная рампа
const ramp=Array.from({length:60},(_,i)=>{ const b=new Uint8Array(4); b[0]=1; b[1]=i; b[2]=(rnd()*256)|0; b[3]=(rnd()*256)|0; return {d:b,t:i*1000,ref:i*.5}; });
ok('reference: a counter is not a quantity (the ref is a ramp)',!S.hexScan(ramp)[0].candidates.some(c=>c.kind==='quantity' && c.off===1));
// постоянный эталон — совет изменить, ничего не придумывается
const flat=S.hexScan(sens.map(p=>({...p,ref:20})))[0].candidates;
ok('reference: constant reference → hint, no quantity',flat.some(c=>c.kind==='refinfo') && !flat.some(c=>c.kind==='quantity'));
// случайные байты при плавном эталоне: ложных величин нет
const nz=Array.from({length:120},(_,i)=>({d:Uint8Array.from({length:12},()=>rnd()*256|0),t:i*1000,ref:20+5*Math.sin(i/10)}));
ok('reference: random packets give no quantity',!S.hexScan(nz)[0].candidates.some(c=>c.kind==='quantity'));
// без эталона поведение прежнее
ok('without a reference: no quantity candidates',!S.hexScan(sens.map(p=>p.d))[0].candidates.some(c=>c.kind==='quantity'||c.kind==='refinfo'));

console.log(bad ? bad+' failed' : 'all ok');
process.exit(bad?1:0);
