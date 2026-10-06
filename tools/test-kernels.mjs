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

// PSK/QAM: символы → непрерывный RRC (формула) с дробной задержкой tau (в символах), уход несущей cfo (доля частоты символов), шум; → IQK.pskRx
ev(`function rrcAt(x,a){ if(Math.abs(x)<1e-9) return 1-a+4*a/Math.PI;
  if(Math.abs(Math.abs(x)-1/(4*a))<1e-9) return a/Math.SQRT2*((1+2/Math.PI)*Math.sin(Math.PI/(4*a))+(1-2/Math.PI)*Math.cos(Math.PI/(4*a)));
  return (Math.sin(Math.PI*x*(1-a))+4*a*x*Math.cos(Math.PI*x*(1+a)))/(Math.PI*x*(1-Math.pow(4*a*x,2))); }
function pskRun(o){ const {mod,nSym=6000,sps=4,baud=50000,tau=0.37,cfo=0,snr=99,alpha=.35,seed=5}=o, C=PSKRX[mod], sr=baud*sps;
  let x=seed*2654435761>>>0; const rnd=()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return (x>>>0)/4294967296; };
  const gs=()=>Math.sqrt(-2*Math.log(Math.max(rnd(),1e-12)))*Math.cos(2*Math.PI*rnd());
  const sy=Array.from({length:nSym},()=>C.pts[Math.floor(rnd()*C.pts.length)]), L=nSym*sps;
  const re=new Float32Array(L), im=new Float32Array(L), span=10;
  for(let k=0;k<nSym;k++) for(let j=-span*sps;j<=span*sps;j++){ const i=k*sps+j+Math.round(sps*2); if(i<0||i>=L) continue; const g=rrcAt((j-tau*sps+Math.round(sps*2)-Math.round(sps*2))/sps,alpha); re[i]+=sy[k][0]*g; im[i]+=sy[k][1]*g; }
  let pw=0; for(let i=0;i<L;i++) pw+=re[i]*re[i]+im[i]*im[i]; pw/=L; const sc=1/Math.sqrt(pw), sg=Math.sqrt(Math.pow(10,-snr/10)/2);
  for(let i=0;i<L;i++){ const ph=2*Math.PI*cfo*i/sps, c=Math.cos(ph), s=Math.sin(ph), a=re[i]*sc, b=im[i]*sc; re[i]=a*c-b*s+sg*gs(); im[i]=a*s+b*c+sg*gs(); }
  const n={p:{mod,baud,alpha,tbw:.01,cbw:.02,win:2000}}; IQK.pskRx.init(n); let out;
  for(let i=0;i<L;i+=4096){ const K=Math.min(4096,L-i); out=IQK.pskRx.process(n,{in:{sr,fc:0,chunks:[{re:re.slice(i,i+K),im:im.slice(i,i+K),t0:i}]}},{block:K,sr}); }
  return {evm:out.evm, mer:out.mer, foff:out.foff, lock:out.lock, n:n.cnt}; }`);

const MSG='Array.from("123456789",c=>c.charCodeAt(0))';
const bitsMsb=`${MSG}.flatMap(v=>Array.from({length:8},(_,k)=>(v>>(7-k))&1))`;
const bitsLsb=`${MSG}.flatMap(v=>Array.from({length:8},(_,k)=>(v>>k)&1))`;
const PAT='Array.from({length:30},(_,i)=>(i*37+11)&255)';
const PATB=`(${PAT}).flatMap(v=>Array.from({length:8},(_,k)=>(v>>(7-k))&1))`;
const hex=v=>Array.isArray(v) ? v.join(',') : '0x'+(v>>>0).toString(16).toUpperCase();


// прогон ядра измерителя на синтетическом потоке 250 кS/s, 2 с
ev(`function iqMeterRun(id,p,gen){ const n={p}, sr=250000, K=4096; IQK[id].init(n); let out, t=0;
  for(let b=0;b<2*sr/K;b++){ const re=new Float32Array(K), im=new Float32Array(K);
    for(let i=0;i<K;i++){ const v=gen(t++/sr); re[i]=v[0]; im[i]=v[1]; }
    out=IQK[id].process(n,{in:{sr,fc:0,chunks:[{re,im,t0:0}]}},{block:K,sr}); }
  return out; }`);


// LoRa: кадр через синтезатор, шум и канал → IQK.loraRx; возвращает текст принятых кадров
ev(`function loraRunText(o){
  const {sf,bw,sr,cr=1,cfo=0,ppm=0,snr=40,text}=o, ldro=loraLdro('auto',sf,bw);
  const syms=loraEncode(loraBytes(text),{sf,cr,crc:true,ih:false,ldro});
  const f=loraSynth(syms,{sf,bw,pre:8,sync:0x34,cfo,ppm,amp:1},sr,Math.round(3000*sr/bw)), N=f.re.length;
  let x=12345; const rnd=()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return (x>>>0)/4294967296; };
  const sg=Math.pow(10,-snr/20)/Math.SQRT2*Math.sqrt(sr/bw);
  for(let i=0;i<N;i++){ f.re[i]+=sg*Math.sqrt(-2*Math.log(Math.max(rnd(),1e-12)))*Math.cos(2*Math.PI*rnd()); f.im[i]+=sg*Math.sqrt(-2*Math.log(Math.max(rnd(),1e-12)))*Math.cos(2*Math.PI*rnd()); }
  const n={p:{sf:String(sf),bw:String(bw),thr:9,sync:'any',hdr:'explicit',len:16,cr:'4/5',crc:true,ldro:'auto',bad:true,invert:false}}; IQK.loraRx.init(n);
  const got=[];
  for(let i=0;i<N;i+=4096){ const L=Math.min(4096,N-i);
    const r=IQK.loraRx.process(n,{in:{sr,fc:0,chunks:[{re:f.re.slice(i,i+L),im:f.im.slice(i,i+L),t0:i}]}},{block:4096,sr});
    if(r.rec) for(const q of r.rec) got.push(q.text+(q.crcOk===false ? ' [CRC]' : '')+' cfo='+(Math.round(q.cfo/100)*100)); }
  return got.join('|');
}`);

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

  // LoRa: белая последовательность, проверка заголовка, кодер ↔ декодер, приём из синтезированного IQ
  ['LoRa loraWhite','Array.from(loraWhite(8)).map(v=>v.toString(16)).join()','ff,fe,fc,f8,f0,e1,c2,85','снимок'],
  ['LoRa loraWhite период 255','(()=>{ const w=loraWhite(300); return w[255]===w[0] && w[254]!==w[0]; })()',true],
  ['LoRa loraCrc','loraCrc(Uint8Array.from("123456789",c=>c.charCodeAt(0)))','0xBEEF','снимок'],
  ['LoRa loraHdrChk','loraHdrChk(1,5,3)',17,'снимок'],
  ['LoRa Хэмминг: мин. расстояние 4/7 и 4/8','[3,4].map(cr=>{ let m=99; for(let a=0;a<16;a++) for(let b=a+1;b<16;b++) m=Math.min(m,popcnt32(LORA_CW[cr][a]^LORA_CW[cr][b])); return m; }).join()','3,4'],
  ['LoRa Хэмминг: исправление одного бита (4/8)','(()=>{ let ok=0; for(let v=0;v<16;v++) for(let b=0;b<8;b++){ const r=loraHamDec(LORA_CW[4][v]^(1<<b),4); if(r.nib===v && r.err===1) ok++; } return ok; })()',128],
  ['LoRa кодер → декодер, SF7…12, CR 1…4','(()=>{ let bad=0; for(const sf of [7,8,9,10,11,12]) for(const cr of [1,2,3,4]) for(const ih of [false,true]){ const ldro=sf>=11, b=Uint8Array.from({length:23},(_,i)=>i*29+7&255), o={sf,cr,crc:true,ih,ldro}, s=loraEncode(b,o), d=loraDecode(s,{...o,len:23}); if(!(s.length===loraSymCount(23,o) && d.ok && d.crcOk && d.payload.every((v,i)=>v===b[i]))) bad++; } return bad; })()',0],
  ['LoRa кодер: одна ошибка символа на ±1 бин исправляется при 4/7','(()=>{ const b=loraBytes("LoRa test"), o={sf:9,cr:3,crc:true,ih:false,ldro:false}, s=loraEncode(b,o); s[12]=(s[12]+1)&511; const d=loraDecode(s,{...o}); return d.ok && d.crcOk && d.fixed>0; })()',true],
  ['LoRa приём: SF7, BW 125 кГц, 250 кS/с','loraRunText({sf:7,bw:125000,sr:250000,text:"Hello LoRa"})','Hello LoRa cfo=0','снимок'],
  ['LoRa приём: SF9, CFO +5 кГц, уход 20 ppm, 1,024 МS/с','loraRunText({sf:9,bw:125000,sr:1024000,cfo:5000,ppm:20,text:"drift and offset"})','drift and offset cfo=5000','снимок'],
  ['LoRa приём: SF12, SNR −10 дБ, CR 4/8','loraRunText({sf:12,bw:125000,sr:250000,cr:4,snr:-10,text:"SF12"})','SF12 cfo=0','снимок'],

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

  // измерители: известный сигнал → известные цифры (округление до значащих)
  ['Modulation Meter: FM ±5 кГц, тон 1 кГц, смещение 2 кГц',`(()=>{ const r=iqMeterRun('modMeter',{bw:15000,win:250},t=>{ const p=2*Math.PI*2000*t+5*Math.sin(2*Math.PI*1000*t); return [.5*Math.cos(p),.5*Math.sin(p)]; });
    return [Math.round(r.dev/50)*50, Math.round(r.offset), Math.round(r.fm/10)*10, Math.round(r.idx), Math.round(r.am)].join(); })()`,'5000,2000,1000,5,0'],
  ['Modulation Meter: AM 60%, тон 1 кГц',`(()=>{ const r=iqMeterRun('modMeter',{bw:15000,win:250},t=>{ const e=.5*(1+.6*Math.sin(2*Math.PI*1000*t)); return [e,0*e]; });
    return [Math.round(r.am), Math.round(r.dev)].join(); })()`,'60,0'],
  ['IQ Quality: Q +0.5 дБ, фаза 2°, DC 0.01 по I',`(()=>{ const g=Math.pow(10,.5/20), ph=2*Math.PI/180;
    const r=iqMeterRun('iqQuality',{win:500},t=>{ const I=.3*Math.cos(2*Math.PI*20000*t), Q=.3*Math.sin(2*Math.PI*20000*t); return [I+.01, g*(Q*Math.cos(ph)+I*Math.sin(ph))]; });
    return [r.dc.toFixed(1), r.gain.toFixed(2), r.phase.toFixed(2), r.irr.toFixed(1)].join(); })()`,'-40.0,0.50,2.00,29.5'],
  ['Signal Meter: тон 12345,678 Гц, шум −63 дБFS, точность ≤ 0,5 Гц',`(()=>{ let x=7; const rnd=()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return (x>>>0)/4294967296; };
    const nz=()=>Math.sqrt(-2*Math.log(Math.max(rnd(),1e-12)))*Math.cos(2*Math.PI*rnd());
    const r=iqMeterRun('sigMeter',{size:'4096',avg:16,thr:6,pct:99,xdb:26,fine:true,win:'500',skipDc:true},t=>{ const p=2*Math.PI*12345.678*t; return [.1*Math.cos(p)+.0005*nz(), .1*Math.sin(p)+.0005*nz()]; });
    return [Math.abs(r.offset-12345.678)<0.5, r.snr>65 && r.snr<80].join(); })()`,'true,true'],
  ['Signal Meter: OBW 99% шумоподобной полосы 20 кГц (ФНЧ-шум), SNR 20 дБ',`(()=>{ let x=11; const rnd=()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return (x>>>0)/4294967296; };
    const nz=()=>Math.sqrt(-2*Math.log(Math.max(rnd(),1e-12)))*Math.cos(2*Math.PI*rnd());
    const h=kaiserLP(250000,9000,11000,401), M=h.length, bi=new Float32Array(M), bq=new Float32Array(M); let w=0;
    const r=iqMeterRun('sigMeter',{size:'4096',avg:16,thr:6,pct:99,xdb:26,fine:false,win:'500',skipDc:true},t=>{
      bi[w]=nz(); bq[w]=nz(); w=(w+1)%M; let a=0,b=0; for(let k=0;k<M;k++){ const i=(w-1-k+M)%M; a+=h[k]*bi[i]; b+=h[k]*bq[i]; }
      const ph=2*Math.PI*40000*t, c=Math.cos(ph), s=Math.sin(ph); return [(a*c-b*s)*0.02+.0007*nz(), (a*s+b*c)*0.02+.0007*nz()]; });
    return [r.obw>17000 && r.obw<23000, Math.abs(r.offset-40000)<500].join(); })()`,'true,true'],
  ['Signal Database: 4800 Bd, ±1.9 кГц, 12.5 кГц, 450 МГц → все 4800-Bd 4FSK с равным баллом',`sdbMatch({bw:11000,baud:4800,dev:1944,freq:450e6},8).filter(x=>x.score===1).map(x=>x.n).sort().join()`,'DMR,NXDN 4800,P25 Phase 1,Yaesu System Fusion'],
  ['Signal Database: 125 кГц, 868 МГц → LoRa',`sdbMatch({bw:125000,freq:868.1e6},1)[0].n`,'LoRa 125 кГц'],
  ['Signal Database: 1090 МГц, 2 МГц → ADS-B',`sdbMatch({bw:2e6,freq:1090e6},1)[0].n`,'ADS-B / Mode S'],
  ['Signal Database: 180 кГц, ±75 кГц, 100 МГц → WFM',`sdbMatch({bw:180e3,dev:75e3,freq:100e6},1)[0].n`,'Радиовещание WFM'],
  ['Signal Database: без данных — пусто',`sdbMatch({bw:0,dev:0,baud:0,freq:0}).length`,0],
  // cron: срабатывания по crontab-правилам, время в UTC
  ['cron: */15 — следующая после 10:07',`(()=>{ const c=cronParse('*/15 * * * *'); return new Date(cronNext(c,Date.UTC(2026,0,5,10,7)/1000,0)*1000).toISOString(); })()`,'2026-01-05T10:15:00.000Z'],
  ['cron: 30 8 * * 1-5 — пятница вечером → понедельник',`(()=>{ const c=cronParse('30 8 * * 1-5'); return new Date(cronNext(c,Date.UTC(2026,0,9,18,0)/1000,0)*1000).toISOString(); })()`,'2026-01-12T08:30:00.000Z'],
  ['cron: 0 0 1 */3 * — по кварталам',`(()=>{ const c=cronParse('0 0 1 */3 *'); return new Date(cronNext(c,Date.UTC(2026,1,5)/1000,0)*1000).toISOString(); })()`,'2026-04-01T00:00:00.000Z'],
  ['cron: 0 12 13 * fri — день месяца ИЛИ день недели',`(()=>{ const c=cronParse('0 12 13 * fri'); let t=Date.UTC(2026,0,1)/1000, o=[]; for(let i=0;i<3;i++){ t=cronNext(c,t,0); o.push(new Date(t*1000).toISOString().slice(5,10)); } return o.join(); })()`,'01-02,01-09,01-13'],
  ['cron: имена и 7 = воскресенье, список',`(()=>{ const c=cronParse('0 6 * jan,jul sun,7'); return [c.dow.size, c.dow.has(0), c.mon.size].join(); })()`,'1,true,2'],
  ['cron: @hourly',`new Date(cronNext(cronParse('@hourly'),Date.UTC(2026,5,1,5,59,59)/1000,0)*1000).toISOString()`,'2026-06-01T06:00:00.000Z'],
  ['cron: сдвиг зоны +3 ч (0 9 * * * по местному = 06:00 UTC)',`new Date(cronNext(cronParse('0 9 * * *'),Date.UTC(2026,5,1,0,0)/1000,10800)*1000).toISOString()`,'2026-06-01T06:00:00.000Z'],
  ['cron: ошибки разбора',`['* * * *','61 * * * *','* * 32 * *','a b c d e','*/0 * * * *','5-2 * * * *'].map(e=>cronParse(e)===null).join()`,'true,true,true,true,true,true'],
  ['cron: 30 февраля не бывает',`cronNext(cronParse('0 0 30 2 *'),Date.UTC(2026,0,1)/1000,0)`,null],
  // PSK/QAM Receiver: шум задан отношением сигнал/шум на отсчёт; после согласованного фильтра символьное SNR выше на 10·lg(sps)
  ['PSK Rx: QPSK без шума, уход несущей +1% Rb, дробный строб → захват, уход ±2 Гц, EVM < 1,5%',`(()=>{ const r=pskRun({mod:'QPSK',cfo:.01}); return [r.lock, Math.abs(r.foff-500)<2, r.evm<1.5].join(); })()`,'1,true,true'],
  ['PSK Rx: BPSK, 8PSK без шума → EVM < 1,5%',`['BPSK','8PSK'].map(m=>{ const r=pskRun({mod:m,tau:.8,cfo:-.005}); return r.lock && r.evm<1.5 && Math.abs(r.foff+250)<2; }).join()`,'true,true'],
  ['PSK Rx: QPSK, SNR 10 дБ на отсчёт (sps 4 → символьное 16 дБ) → EVM 15,8% ± 1',`Math.abs(pskRun({mod:'QPSK',snr:10}).evm-15.8)<1`,true],
  ['PSK Rx: QPSK, SNR 20 дБ → EVM 5,0% ± 0,5',`Math.abs(pskRun({mod:'QPSK',snr:20}).evm-5)<.5`,true],
  ['PSK Rx: 16QAM, уход −1%, SNR 25 дБ → захват, ±3 Гц, EVM 2,8…4%',`(()=>{ const r=pskRun({mod:'16QAM',snr:25,cfo:-.01,tau:.8}); return [r.lock, Math.abs(r.foff+500)<3, r.evm>2.8 && r.evm<4].join(); })()`,'1,true,true'],
  ['PSK Rx: меньше 2 отсчётов на символ → отказ',`(()=>{ const n={p:{mod:'QPSK',baud:100000,alpha:.35,tbw:.01,cbw:.02,win:2000}}; IQK.pskRx.init(n); const r=IQK.pskRx.process(n,{in:{sr:150000,fc:0,chunks:[{re:new Float32Array(64),im:new Float32Array(64),t0:0}]}},{block:64,sr:150000}); return r.evm===null && !!n.ui.err; })()`,true],
  // Channel Activity: кадры каждые 2 с; NFM виден в 8 кадрах из 10 (с дрожанием частоты), DMR в 4, FT8 в 5. Время кадра засчитывается видимому каналу, первое появление — нет: 7, 3, 4 интервала из 10
  ['Channel Activity: каналы, занятость и группы',`(()=>{ const st=chanNew(0), L=(f,bw,lab)=>({sig:true,lo:f-bw/2,hi:f+bw/2,f,label:lab,db:-40});
    for(let k=1;k<=10;k++){ const fr=[]; if(k<=8) fr.push(L(100.1e6+(k%3-1)*800,12e3,'NFM')); if(k>8) fr.push(L(100.5e6,12e3,'DMR')); if(k===3||k===4) fr.push(L(100.5e6,12e3,'DMR')); if(k%2) fr.push(L(7.074e6,50,'FT8')); chanUpdate(st,fr,k*2000,{}); }
    const R=chanRows(st,20000); return [R.length, R.map(r=>r.label).join('/'), R.map(r=>Math.round(r.occ/5)*5).join('/'), R.map(r=>r.group.split(' ')[0]).join('/')].join(' | '); })()`,'3 | NFM/FT8/DMR | 70/40/30 | voice/narrow/voice'],
  ['Channel Activity: повторный кадр не считается',`(()=>{ const st=chanNew(0), fr=[{sig:true,lo:1e6,hi:1.01e6,f:1.005e6,label:'X',db:0}]; const a=chanUpdate(st,fr,1000,{}), b=chanUpdate(st,fr,2000,{}); return [a,b,st.ch[0].hits].join(); })()`,'true,false,1'],
  ['Channel Activity: боковые линии ЧМ через 1 кГц сливаются в один канал (join 2,5 кГц), удалённый — нет',`(()=>{ const st=chanNew(0), L=(f,bw,lab)=>({sig:true,lo:f-bw/2,hi:f+bw/2,f,label:lab,db:-30});
    for(let k=1;k<=6;k++){ const fr=[]; for(let i=-3;i<=3;i++) fr.push(L(99.8e6+i*1000,400,i===0?'FM':'tone')); fr.push(L(100.5e6,12e3,'NFM')); chanUpdate(st,fr,k*1000,{tol:600}); }
    const A=chanRows(st,6000,0), B=chanRows(st,6000,2500); const m=B.find(r=>Math.abs(r.f-99.8e6)<1000); return [A.length, B.length, Math.round(m.bw), Math.round(m.f)].join(); })()`,'8,2,6400,99800000'],
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
