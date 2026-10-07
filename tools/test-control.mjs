// Ядро управления: node tools/test-control.mjs
// Джойстик: клавиши → оси → кадры; мост nRF24: строки команд и ответов (мост проверяется только этим разбором, без железа).
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,Float64Array,Uint8Array,TextEncoder,TextDecoder,Array,String,Number,isFinite});
vm.runInContext(fs.readFileSync(path.join(root,'modules/control-kernels.js'),'utf8')+
  ';this.K={joyTarget,joyStep,joyShape,joyBits,joyHexFrame,joyFormat,nrfHex,nrfTextToHex,nrfHexToText,nrfCfgLine,nrfParseLine,nrfScanSpec};',ctx);
const K=ctx.K;
let bad=0; const eq=(n,a,b)=>{ if(JSON.stringify(a)!==JSON.stringify(b)){ bad++; console.log('FAIL',n,JSON.stringify(a),'!=',JSON.stringify(b)); } else console.log('ok  ',n); };
const near=(n,a,b,e=1e-6)=>{ if(Math.abs(a-b)>e){ bad++; console.log('FAIL',n,a,'≉',b); } else console.log('ok  ',n); };

// клавиши
let t=K.joyTarget(new Set(['KeyW','KeyD','ArrowLeft','Space','KeyF']));
eq('target axes',[t.x1,t.y1,t.x2,t.y2],[1,1,-1,0]); eq('target buttons',t.b,[1,0,0,0,0,0,0,1]);
t=K.joyTarget(new Set(['KeyA','KeyD','KeyW','KeyS'])); eq('opposite keys cancel',[t.x1,t.y1],[0,0]);
eq('unknown key ignored',K.joyTarget(new Set(['KeyP'])).x1,0);
// сглаживание
near('ramp up',K.joyStep(0,1,.1,.5),.2); near('ramp reaches target',K.joyStep(.9,1,.1,.5),1); near('ramp down',K.joyStep(1,-1,.1,.5),.8); near('no ramp',K.joyStep(0,1,.1,0),1);
// мёртвая зона и экспонента
near('dead zone',K.joyShape(.05,.1,0),0); near('full stays full',K.joyShape(1,.1,0.5),1); near('linear mid',K.joyShape(.55,.1,0),.5);
near('expo softens',K.joyShape(.55,.1,1),.125); near('sign kept',K.joyShape(-1,.1,0),-1);
// кадр
eq('bits',K.joyBits([1,0,1,0,0,0,0,1]),0x85);
eq('hex frame',K.joyHexFrame(1,-1,0,0.5,0b101),'A57F81004005'+'XX'.replace('XX',(0xA5^0x7F^0x81^0x00^0x40^0x05).toString(16).toUpperCase().padStart(2,'0')));
const v={x1:1,y1:-.5,x2:0,y2:.25,b:[1,0,0,0,0,0,0,0]};
eq('format floats',K.joyFormat('J {x1} {y1} {x2} {y2} {bits}',v,0,0),'J 1.00 -0.50 0.00 0.25 1');
eq('format ints and rc',K.joyFormat('{X1},{Y1};{r1},{r2},{r3},{r4}',v,0,0),'100,-50;2000,1250,1500,1625');
eq('format counter and decimals',K.joyFormat('{n}:{x1:3}:{b1}{b2}',v,7,0),'7:1.000:10');
eq('unknown placeholder kept',K.joyFormat('{zz}',v,0,0),'{zz}');

// nRF24
eq('hex clean',K.nrfHex('de ad-BE:ef'),'DEADBEEF'); eq('hex 0x',K.nrfHex('0xDE,0xAD'),'DEAD'); eq('hex odd',K.nrfHex('ABC'),null); eq('hex bad',K.nrfHex('xyz1'),null); eq('hex empty',K.nrfHex(''),null);
eq('text to hex',K.nrfTextToHex('Hi'),'4869'); eq('hex to text',K.nrfHexToText('48690A'),'Hi\n'); eq('hex to text: control chars masked',K.nrfHexToText('480048'),'H·H');
eq('cfg default',K.nrfCfgLine({ch:76,rate:'1M',addr:'E7E7E7E7E7',pay:8,pwr:3,crc:2,ack:true,retry:5}),'CFG ch=76 rate=1M addr=E7E7E7E7E7 pay=8 pwr=3 crc=2 ack=1 retry=5');
eq('cfg clamps',K.nrfCfgLine({ch:300,rate:'9M',addr:'12',pay:99,pwr:9,crc:7,ack:false,retry:99}),'CFG ch=125 rate=1M addr=E7E7E7E7E7 pay=32 pwr=3 crc=2 ack=0 retry=15');
eq('cfg 3-byte address',K.nrfCfgLine({ch:1,rate:'2M',addr:'A1 B2 C3',pay:0,pwr:0,crc:0,ack:0,retry:0}),'CFG ch=1 rate=2M addr=A1B2C3 pay=0 pwr=0 crc=0 ack=0 retry=0');
eq('parse rx',K.nrfParseLine('RX 76 deadbeef'),{k:'rx',ch:76,hex:'DEADBEEF'}); eq('parse rx odd rejected',K.nrfParseLine('RX 76 abc'),null);
eq('parse txok',K.nrfParseLine('TXOK'),{k:'txok'}); eq('parse txfail',K.nrfParseLine('txfail\r'),{k:'txfail'});
eq('parse err',K.nrfParseLine('ERR bad channel'),{k:'err',msg:'bad channel'}); eq('parse pong',K.nrfParseLine('PONG nrf24-bridge 1 chip=1'),{k:'pong',info:'nrf24-bridge 1 chip=1'});
eq('parse garbage',K.nrfParseLine('hello'),null); eq('parse empty',K.nrfParseLine('  '),null);
const sc=Array.from({length:126},(_,i)=>i===40?10:i===41?5:0);
eq('parse scan',K.nrfParseLine('SCAN '+sc.join(',')).counts.length,126); eq('parse scan short rejected',K.nrfParseLine('SCAN 1,2,3'),null);
const sp=K.nrfScanSpec(sc,10,3);
near('scan: busy channel',20*Math.log10(sp.mag[40]),-40,1e-3); near('scan: idle channel',20*Math.log10(sp.mag[0]),-100,1e-3); near('scan: half',20*Math.log10(sp.mag[41]),-70,1e-3);
eq('scan freqs',[sp.freqs[0],sp.freqs[125],sp.size,sp.rev],[2400e6,2525e6,126,3]);
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad?1:0);
