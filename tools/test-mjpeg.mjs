// MJPEG по каналу данных: node tools/test-mjpeg.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,JSON,Uint8Array,ArrayBuffer,String,TextEncoder,TextDecoder});
vm.runInContext(fs.readFileSync(path.join(root,'modules/mjpeg-kernels.js'),'utf8')+';this.K={mjPack,mjUnpack,mjNewer,mjAdapt};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const jpeg=new Uint8Array(5000).map((_,i)=>(i*7+3)&255);

let m=K.mjUnpack(K.mjPack('video',513,jpeg));
ok('label, number and bytes survive',m.label==='video' && m.seq===513 && m.jpeg.length===5000 && m.jpeg.every((v,i)=>v===jpeg[i]));
m=K.mjUnpack(K.mjPack('камера 1',65535,jpeg)); ok('unicode label, largest number',m.label==='камера 1' && m.seq===65535);
m=K.mjUnpack(K.mjPack('x'.repeat(200),1,jpeg)); ok('long label is cut',m.label.length===60 && m.seq===1 && m.jpeg.length===5000);
ok('empty label becomes the default',K.mjUnpack(K.mjPack('',0,jpeg)).label==='video');
ok('garbage is not a frame',K.mjUnpack(new Uint8Array([1,2,3]))===null && K.mjUnpack(new Uint8Array([0xF1,50,1,2,3,4]))===null && K.mjUnpack(new ArrayBuffer(0))===null);

ok('newer by number',K.mjNewer(5,4) && !K.mjNewer(4,5) && !K.mjNewer(5,5));
ok('number wraps around',K.mjNewer(2,65534) && !K.mjNewer(65534,2));
ok('first frame is newer than nothing',K.mjNewer(0,null));

ok('big frame lowers the quality',K.mjAdapt(.7,80000,40000,.8)<.7);
ok('much bigger lowers it faster',K.mjAdapt(.7,100000,40000,.8)<K.mjAdapt(.7,45000,40000,.8));
ok('small frame raises the quality up to the wish',K.mjAdapt(.7,10000,40000,.8)>.7 && K.mjAdapt(.79,10000,40000,.8)<=.8);
ok('quality never below 0.3',K.mjAdapt(.3,999999,40000,.8)===.3);
ok('frame near the target keeps the quality',K.mjAdapt(.6,35000,40000,.8)===.6);
console.log(bad?'FAILED':'all ok'); process.exit(bad?1:0);
