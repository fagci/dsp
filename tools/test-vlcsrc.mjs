// VLC Source (ядро): node tools/test-vlcsrc.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Uint8Array,Float32Array,parseInt,String});
vm.runInContext(fs.readFileSync(path.join(root,'modules/vlcsrc-kernels.js'),'utf8')+';this.T={vlsPort,vlsBytes,vlsNew,vlsFeed,vlsRate,vlsSec};',ctx);
const T=ctx.T;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };
const hex=a=>a.map(v=>(v&255).toString(16).padStart(2,'0')+((v>>8)&255).toString(16).padStart(2,'0')).join('');   // int16 LE
ok('port range',T.vlsPort(()=>0)===40000 && T.vlsPort(()=>.9999999)<=59999 && T.vlsPort(()=>1)<=59999 && T.vlsPort(()=>.5)===50000);
ok('bytes',T.vlsBytes('00ff10').join()==='0,255,16' && T.vlsBytes('0')===null && T.vlsBytes('zz')===null && T.vlsBytes(5)===null && T.vlsBytes('').length===0);
const st=T.vlsNew(2);
const f1=T.vlsFeed(st,hex([0,32767,-32768,16384]));
ok('stereo: two frames, sign and scale',f1.length===4 && f1[0]===0 && Math.abs(f1[1]-32767/32768)<1e-9 && f1[2]===-1 && f1[3]===.5 && st.frames===2);
const st2=T.vlsNew(2);
const all=hex([100,-100,200,-200,300,-300]);
const a=T.vlsFeed(st2,all.slice(0,6)), b=T.vlsFeed(st2,all.slice(6,10)), c=T.vlsFeed(st2,all.slice(10));
ok('stereo: split inside a frame — the tail goes on',a.length===0 && st2.frames===3 && (b.length+c.length)===6 && b.length===2 && Math.round(b[0]*32768)===100 && Math.round(c[0]*32768)===200 && Math.round(c[3]*32768)===-300,[a.length,b.length,c.length,st2.frames].join());
const st3=T.vlsNew(1);
const m=T.vlsFeed(st3,hex([1000,-1000,2000]));
ok('mono: one value per frame',m.length===3 && Math.round(m[1]*32768)===-1000 && st3.frames===3);
ok('bad hex: null, state kept',T.vlsFeed(st3,'xyz')===null && T.vlsFeed(st3,'abc')===null && st3.frames===3);
ok('channels: only 1 or 2',T.vlsNew(1).ch===1 && T.vlsNew(2).ch===2 && T.vlsNew(5).ch===2 && T.vlsNew(0).ch===2);
ok('rate: graph or fixed',T.vlsRate('graph',44100)===44100 && T.vlsRate('graph',0)===48000 && T.vlsRate('22050',48000)===22050 && T.vlsRate('graph',44099.6)===44100);
ok('sec',T.vlsSec(1500)===1.5 && T.vlsSec(-1)===0 && T.vlsSec(undefined)===0);
if(bad){ console.log(bad+' failed'); process.exit(1); }
console.log('all ok');
