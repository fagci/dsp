// Разбор телеметрии: node tools/test-telemetry.mjs
// CRC — по контрольным значениям каталога CRC; кадры собраны по раскладке протоколов (см. telemetry-kernels.js), не сняты с реального борта.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Date,Math,Uint8Array,DataView,Object,isFinite});
vm.runInContext(fs.readFileSync(path.join(root,'modules/telemetry-kernels.js'),'utf8')+';this.T={tlmCrcX25,tlmCrc8,tlmStream,tlmPush,tlmApply,TLM_PARSERS};',ctx);
const T=ctx.T;
let bad=0; const eq=(n,a,b)=>{ if(JSON.stringify(a)!==JSON.stringify(b)){ bad++; console.log('FAIL',n,JSON.stringify(a),'!=',JSON.stringify(b)); } else console.log('ok  ',n); };
const near=(n,a,b,e=1e-3)=>{ if(Math.abs(a-b)>e){ bad++; console.log('FAIL',n,a,'≉',b); } else console.log('ok  ',n); };
const chk=new TextEncoder().encode('123456789');
eq('CRC-16/MCRF4XX check', T.tlmCrcX25(chk,0,9), 0x6F91);
eq('CRC-8/DVB-S2 check', T.tlmCrc8(chk,0,9), 0xBC);

const le32=v=>[v&255,(v>>8)&255,(v>>16)&255,(v>>>24)&255], le16=v=>[v&255,(v>>8)&255], be32=v=>le32(v).reverse(), be16=v=>le16(v).reverse();
const f32=v=>[...new Uint8Array(new Float32Array([v]).buffer)];
const EXTRA={0:50,1:124,24:24,30:39,33:104,74:20};
function mav2(id,p,seq=1){ const b=[p.length,0,0,seq,1,1,id&255,(id>>8)&255,(id>>16)&255,...p]; const c=T.tlmCrcX25(Uint8Array.from(b),0,b.length,EXTRA[id]); return Uint8Array.from([0xFD,...b,...le16(c)]); }
function mav1(id,p,seq=1){ const b=[p.length,seq,1,1,id,...p]; const c=T.tlmCrcX25(Uint8Array.from(b),0,b.length,EXTRA[id]); return Uint8Array.from([0xFE,...b,...le16(c)]); }
const crsf=(type,p)=>{ const b=Uint8Array.from([type,...p]); return Uint8Array.from([0xC8,b.length+1,...b,T.tlmCrc8(b,0,b.length)]); };
const msp1=(cmd,p)=>{ let x=p.length^cmd; for(const v of p) x^=v; return Uint8Array.from([0x24,0x4D,0x3E,p.length,cmd,...p,x]); };
const msp2=(cmd,p)=>{ const b=Uint8Array.from([0,...le16(cmd),...le16(p.length),...p]); return Uint8Array.from([0x24,0x58,0x3E,...b,T.tlmCrc8(b,0,b.length)]); };
const ltm=(t,p)=>{ let x=0; for(const v of p) x^=v; return Uint8Array.from([0x24,0x54,t.charCodeAt(0),...p,x]); };
const run=(frames,protos=Object.keys(T.TLM_PARSERS))=>{ const st=T.tlmStream(), s={}; let n=0; for(const f of frames) for(const m of T.tlmPush(st,f,protos)){ T.tlmApply(s,m); n++; } return {s,n,st}; };
const cat=(...a)=>{ const o=[]; for(const x of a) o.push(...x); return Uint8Array.from(o); };

// MAVLink v2: GLOBAL_POSITION_INT, ATTITUDE, SYS_STATUS, HEARTBEAT
const gpi=[...le32(1000),...le32(Math.round(55.0415e7)),...le32(Math.round(82.9346e7)),...le32(180000),...le32(60000),...le16(300),...le16(400),...le16(0),...le16(9000)];
let r=run([mav2(33,gpi)]);
near('mav lat',r.s.lat,55.0415); near('mav lon',r.s.lon,82.9346); near('mav alt',r.s.alt,180); near('mav rel alt',r.s.ralt,60); near('mav speed',r.s.speed,5); near('mav hdg',r.s.hdg,90);
r=run([mav2(30,[...le32(0),...f32(0.1),...f32(-0.2),...f32(-Math.PI/2)])]);
near('mav roll',r.s.roll,5.7296,1e-3); near('mav pitch',r.s.pitch,-11.459,1e-3); near('mav yaw 270',r.s.hdg,270,1e-3);
const sys=new Array(31).fill(0); sys.splice(14,2,...le16(11800)); sys.splice(16,2,...le16(1250)); sys[30]=76;
r=run([mav2(1,sys)]); near('mav volts',r.s.volts,11.8); near('mav amps',r.s.amps,12.5); eq('mav batt %',r.s.batt,76);
r=run([mav2(0,[...le32(4),2,3,0x81,4,3])]); eq('mav armed',r.s.armed,true);
// v2 режет нули в конце: ATTITUDE c нулевым yaw-rate хвостом
{ const p=[...le32(5),...f32(0.5),...f32(0),...f32(0),...f32(0),...f32(0),...f32(0)]; const cut=p.slice(0,8); r=run([mav2(30,cut)]); near('mav v2 zero-trim roll',r.s.roll,28.648,1e-2); }
r=run([mav1(24,[...new Array(8).fill(0),...le32(Math.round(10e7)),...le32(Math.round(20e7)),...le32(100000),...le16(0),...le16(0),...le16(500),...le16(0),3,9])]);
near('mav1 gps lat',r.s.lat,10); eq('mav1 sats',r.s.sats,9);
// CRSF
r=run([crsf(0x02,[...be32(Math.round(55.0415e7)),...be32(Math.round(82.9346e7)),...be16(540),...be16(9000),...be16(1120),12])]);
near('crsf lat',r.s.lat,55.0415); near('crsf speed',r.s.speed,15); near('crsf hdg',r.s.hdg,90); near('crsf alt',r.s.alt,120); eq('crsf sats',r.s.sats,12);
r=run([crsf(0x08,[...be16(168),...be16(155),0,3,232,64])]); near('crsf volts',r.s.volts,16.8); near('crsf amps',r.s.amps,15.5); eq('crsf batt',r.s.batt,64);
r=run([crsf(0x1E,[...be16(Math.round(0.1e4)),...be16(Math.round(-0.2e4)),...be16(Math.round(1.5708e4))])]); near('crsf pitch',r.s.pitch,5.7296,2e-2); near('crsf roll',r.s.roll,-11.459,2e-2); near('crsf yaw',r.s.hdg,90,1e-2);
r=run([crsf(0x14,[70,80,98,(-3)&255,0,2,3,75,97,5])]); eq('crsf link',[r.s.rssi,r.s.lq,r.s.snr],[-70,98,-3]);
r=run([crsf(0x21,[...new TextEncoder().encode('ACRO'),0])]); eq('crsf mode',r.s.mode,'ACRO');
// MSP v1 / v2
r=run([msp1(108,[...le16(105),...le16(-230),...le16(359)])]); near('msp roll',r.s.roll,10.5); near('msp pitch',r.s.pitch,-23); near('msp yaw',r.s.hdg,359);
r=run([msp2(106,[1,11,...le32(Math.round(55.0415e7)),...le32(Math.round(82.9346e7)),...le16(150),...le16(1200),...le16(900)])]); near('msp2 lat',r.s.lat,55.0415); eq('msp2 sats',r.s.sats,11); near('msp2 speed',r.s.speed,12);
r=run([msp1(110,[168,0,0,...le16(512),...le16(1530)])]); near('msp volts',r.s.volts,16.8); near('msp amps',r.s.amps,15.3);
// LTM
r=run([ltm('G',[...le32(Math.round(55.0415e7)),...le32(Math.round(82.9346e7)),20,...le32(12000),(9<<2)|3])]); near('ltm lat',r.s.lat,55.0415); near('ltm alt',r.s.alt,120); eq('ltm sats',r.s.sats,9);
r=run([ltm('A',[...le16(7),...le16(-12),...le16(180)])]); eq('ltm att',[r.s.pitch,r.s.roll,r.s.hdg],[7,-12,180]);
// поток: кадры вперемешку, мусор между ними, разрезанные на куски, все протоколы сразу
{ const all=cat([1,2,3,0xFD,0x55],mav2(33,gpi),[0xC8,0xC8,9],crsf(0x08,[...be16(168),...be16(155),0,3,232,64]),msp1(108,[...le16(5),...le16(5),...le16(5)]),[0x24,0x24],ltm('A',[...le16(1),...le16(2),...le16(3)]),new Array(300).fill(0));   // случайный 0xFD ждёт «кадр» до 280 байт: хвост нужен, чтобы он разрешился
  const st=T.tlmStream(), s={}, protos=Object.keys(T.TLM_PARSERS); let n=0;
  for(let i=0;i<all.length;i+=5) for(const m of T.tlmPush(st,all.subarray(i,i+5),protos)){ T.tlmApply(s,m); n++; }
  eq('mixed stream: frames',n,4); eq('mixed stream: counts',Object.entries(st.count).sort().join(),'CRSF,1,LTM,1,MAVLink,1,MSP,1'); }
// испорченная контрольная сумма и шум не дают кадров
{ const f=mav2(33,gpi); f[f.length-1]^=1; const g=crsf(0x08,[...be16(168),...be16(155),0,3,232,64]); g[g.length-1]^=1;
  eq('bad checksum rejected',run([f,g]).n,0);
  let x=1234567, noise=new Uint8Array(20000); for(let i=0;i<noise.length;i++){ x^=x<<13; x^=x>>>17; x^=x<<5; noise[i]=x&255; }
  eq('random noise: no frames',run([noise]).n,0); }
process.exit(bad?1:0);
