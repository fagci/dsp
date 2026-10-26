// Ядро инструментов 2 (дальномер, шумомер, экспонометр, солнце / луна, случайное, охрана, металл): node tools/test-tools2.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Number,Array,String,Object,isFinite,JSON,Float32Array});
vm.runInContext(fs.readFileSync(path.join(root,'modules/tools2-kernels.js'),'utf8')+';this.K={tsRangeGround,tsRangeSize,tsAngle3,tsAWeight,tsResp,tsMeterNew,tsMeterPush,tsMeterReset,tsLeq,tsDb,tsEv,tsShutter,tsAperture,tsFmtShutter,tsSun,tsMoon,tsRandInt,tsRoll,tsPassword,tsPick,TS_SETS,tsGuardNew,tsGuardArm,tsGuardStep,tsGuardOff,tsMagNew,tsMagStep}',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(a,b,e=1e-6)=>Math.abs(a-b)<=e*Math.max(1,Math.abs(b));

// дальномер, угломер
ok('ground: 1.6 m eye, 9.09° down → 10 m',near(K.tsRangeGround(-Math.atan(.16)*180/Math.PI,1.6),10,1e-9));
ok('ground: not below horizon',K.tsRangeGround(0,1.6)===null && K.tsRangeGround(10,1.6)===null);
ok('size: 2 m tall object, 45° / 0° → 2 m',near(K.tsRangeSize(45,0,2),2,1e-9) && K.tsRangeSize(10,10,2)===null);
const an=K.tsAngle3(0,0,90,0);
ok('angle: 0° and 90° azimuth → 90°',near(an.angle,90,1e-9) && an.dAz===90 && an.dEl===0);
ok('angle: through north (350 → 10) is 20°',near(K.tsAngle3(350,0,10,0).angle,20,1e-9) && K.tsAngle3(350,0,10,0).dAz===20);
ok('angle: 3D, up vs forward',near(K.tsAngle3(0,0,0,60).angle,60,1e-9));

// шумомер
const sr=48000;
const sine=(f,n,a)=>{ const b=new Float32Array(n); for(let i=0;i<n;i++) b[i]=a*Math.sin(2*Math.PI*f*i/sr); return b; };
const meas=(f,w)=>{ const M=K.tsMeterNew(sr,w,.125); const b=sine(f,sr*2,1); let db=0; for(let i=0;i<b.length;i+=128) db=K.tsMeterPush(M,b.subarray(i,i+128)); return db; };
ok('Z weighting: full-scale sine = −3.01 dBFS',near(meas(1000,'Z'),-3.0103,2e-3),meas(1000,'Z'));
ok('A weighting: 1 kHz = 0 dB against Z',near(meas(1000,'A'),meas(1000,'Z'),2e-3));
const rel=f=>meas(f,'A')-meas(f,'Z');
ok('A curve: 100 Hz ≈ −19.1',Math.abs(rel(100)+19.1)<.5,rel(100));
ok('A curve: 50 Hz ≈ −30.2',Math.abs(rel(50)+30.2)<.8,rel(50));
ok('A curve: 4 kHz ≈ +1.0',Math.abs(rel(4000)-1)<.5,rel(4000));
ok('A curve: 10 kHz ≈ −2.5 (bilinear, 48 kHz)',Math.abs(rel(10000)+2.5)<1.5,rel(10000));
const M=K.tsMeterNew(sr,'Z',1), b=sine(1000,sr*4,.1);
for(let i=0;i<b.length;i+=128) K.tsMeterPush(M,b.subarray(i,i+128));
ok('Leq of a steady tone = its level (−23.0 dBFS)',near(K.tsLeq(M),-23.0103,2e-3),K.tsLeq(M));
ok('peak and max tracked, reset clears',near(M.peak,.1,1e-3) && M.max>-30 && (K.tsMeterReset(M),M.cnt===0 && M.max===-Infinity));
ok('silence → floor',K.tsDb(0)===-200);

// экспонометр
ok('EV: 81920 lux = EV 15',near(K.tsEv(81920),15,1e-9) && K.tsEv(0)===null);
ok('sunny 16: EV15, f/16, ISO100 → 1/128',near(K.tsShutter(15,16,100),1/128,1e-9));
ok('ISO 400 → 4× faster',near(K.tsShutter(15,16,400),1/512,1e-9));
ok('aperture back from time',near(K.tsAperture(15,1/128,100),16,1e-9));
ok('shutter text',K.tsFmtShutter(1/128)==='1/128' && K.tsFmtShutter(2)==='2.0 s' && K.tsFmtShutter(30)==='30 s' && K.tsFmtShutter(0)==='—');

// солнце
const ms=Date.UTC(2024,5,21,12,0,0);
const sn=K.tsSun(ms,51.4779,0), tm=ms2=>new Date(ms2).toISOString().slice(11,16);
ok('Greenwich 2024-06-21: sunrise ≈ 03:43 UTC, sunset ≈ 20:21',Math.abs(sn.rise-Date.UTC(2024,5,21,3,43))<3*60000 && Math.abs(sn.set-Date.UTC(2024,5,21,20,21))<3*60000,tm(sn.rise)+' '+tm(sn.set));
ok('Greenwich solstice: noon elevation ≈ 61.9°, azimuth ≈ 180°',Math.abs(sn.el-61.9)<.4 && Math.abs(sn.az-180)<3,sn.el+' '+sn.az);
ok('declination at the June solstice ≈ +23.44°',Math.abs(sn.dec-23.44)<.05,sn.dec);
const eq=K.tsSun(Date.UTC(2024,2,20,12,0,0),0,0);
ok('equinox, equator: 12 h day, rise ≈ 06:00',Math.abs(eq.dayLen-12.1)<.2 && Math.abs(eq.rise-Date.UTC(2024,2,20,6,0))<8*60000,eq.dayLen+' '+tm(eq.rise));
ok('Novosibirsk (UTC+7) sunrise in local morning',(()=>{ const s=K.tsSun(Date.UTC(2024,5,21,6,0),55.03,82.92); const h=((s.rise/3600000+7)%24); return h>4.4 && h<5.2; })());
ok('polar day / night',K.tsSun(Date.UTC(2024,5,21,12),80,0).polar==='day' && K.tsSun(Date.UTC(2024,11,21,12),80,0).polar==='night' && K.tsSun(Date.UTC(2024,5,21,12),80,0).rise===null);
ok('sun is below the horizon at midnight',K.tsSun(Date.UTC(2024,5,21,0,0),51.5,0).el<0);

// луна
const nm=K.tsMoon(Date.UTC(2024,0,11,11,57)), fm=K.tsMoon(Date.UTC(2024,0,25,17,54));
ok('new moon 2024-01-11: age ≈ 0 (±0.7 d), illumination ≈ 0',Math.min(nm.age,29.53-nm.age)<.7 && nm.illum<2,JSON.stringify(nm));
ok('full moon 2024-01-25: illumination ≈ 100 %, name',fm.illum>97 && fm.name==='full moon',JSON.stringify(fm));
ok('first quarter about a week after new',K.tsMoon(Date.UTC(2024,0,18,3,52)).name==='first quarter');
ok('days to the full moon after the new',Math.abs(nm.toFull-14.77)<1);

// случайное
let st=12345; const rng=()=>{ st=(Math.imul(st,1664525)+1013904223)>>>0; return st; };
const cnt=new Array(6).fill(0); for(let i=0;i<60000;i++) cnt[K.tsRandInt(rng,6)]++;
ok('randInt is uniform (±5 %)',cnt.every(c=>Math.abs(c-10000)<500),cnt.join());
ok('randInt rejects the biased tail',(()=>{ const seq=[4294967295,7]; let i=0; return K.tsRandInt(()=>seq[i++],6)===1; })());
const r=K.tsRoll(rng,'2d6+3');
ok('roll 2d6+3',r.rolls.length===2 && r.total===r.rolls[0]+r.rolls[1]+3 && r.rolls.every(x=>x>=1&&x<=6));
ok('roll d20 / bad',K.tsRoll(rng,'d20').rolls.length===1 && K.tsRoll(rng,'abc')===null && K.tsRoll(rng,'0d6')===null && K.tsRoll(rng,'1d1')===null);
const pw=K.tsPassword(rng,16,['lower','upper','digits','symbols']);
ok('password: length and every selected set present',pw.length===16 && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw) && /[!@#$%^&*\-_=+?]/.test(pw),pw);
ok('password: no look-alike characters, only digits when asked',!/[l1IO0]/.test(K.tsPassword(rng,128,['lower','upper','digits'])) && /^\d+$/.test(K.tsPassword(rng,12,['digits'])));
ok('password: no sets → empty, length clamped',K.tsPassword(rng,12,[])==='' && K.tsPassword(rng,1,['digits']).length===4 && K.tsPassword(rng,999,['digits']).length===128);
ok('pick from a list',['a','b','c'].includes(K.tsPick(rng,'a\n\n b \nc')) && K.tsPick(rng,'  \n')==='');

// охрана
const G=K.tsGuardNew(), o={delay:3,sens:.8,hold:.1};
K.tsGuardArm(G,0);
for(let t=0;t<=3.2;t+=.02) K.tsGuardStep(G,t,[0,0,9.8],o);
ok('guard: armed after the delay',G.state==='armed' && near(G.ref[2],9.8,1e-9),G.state);
for(let t=3.2;t<5;t+=.02) K.tsGuardStep(G,t,[.05*Math.sin(t*30),0,9.8],o);
ok('guard: small noise does not trigger',G.state==='armed');
for(let t=5;t<5.3;t+=.02) K.tsGuardStep(G,t,[2,0,9.8],o);
ok('guard: a real move triggers, latches',G.state==='alarm');
K.tsGuardStep(G,6,[0,0,9.8],o);
ok('guard: stays in alarm until disarmed',G.state==='alarm' && (K.tsGuardOff(G),G.state==='off'));
const G2=K.tsGuardNew(); K.tsGuardArm(G2,0);
for(let t=0;t<=3.2;t+=.02) K.tsGuardStep(G2,t,[0,0,9.8],o);
for(let t=3.2;t<3.25;t+=.02) K.tsGuardStep(G2,t,[3,0,9.8],{...o,hold:.2});
ok('guard: a short bump below the hold time is ignored',G2.state==='armed');

// металл
const MG=K.tsMagNew(); let tt=0;
for(;tt<10;tt+=.02) K.tsMagStep(MG,tt,48,3);
ok('magnet: steady field → delta 0',Math.abs(MG.delta)<1e-9);
for(let i=0;i<10;i++){ tt+=.02; K.tsMagStep(MG,tt,60,3); }
ok('magnet: a jump shows as a delta and fades as the base follows',MG.delta>11 && (()=>{ for(let i=0;i<1500;i++){ tt+=.02; K.tsMagStep(MG,tt,60,3); } return Math.abs(MG.delta)<.1; })());

if(bad){ console.log(bad,'failed'); process.exit(1); } else console.log('all ok');
