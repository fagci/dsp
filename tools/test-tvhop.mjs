// TV Hopper на симуляции: node tools/test-tvhop.mjs
// «Приёмник» меняет частоту с задержкой в несколько тактов; на каналах 0 и 1 — тестовая таблица PAL (FM), на 2 — шум.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const worker=fs.readFileSync(path.join(root,'iq-worker.js'),'utf8');
const files=[...worker.match(/importScripts\((.*)\);/)[1].matchAll(/'([^']+)'/g)].map(m=>m[1].replace(/\+Q$/,''));
let T=0;
class ImageData{ constructor(d,w,h){ this.data=d; this.width=w; this.height=h; } }
const ctx=vm.createContext({console,Math,Float32Array,Float64Array,Uint8Array,Uint8ClampedArray,Uint16Array,Uint32Array,Int8Array,Int16Array,Int32Array,Map,Set,Date,JSON,Array,Object,String,Number,parseInt,parseFloat,isFinite,isNaN,Symbol,Promise,BigInt,DataView,WebAssembly,atob,ImageData,performance:{now:()=>T}});
ctx.self=ctx;
for(const f of files) vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});
const ev=s=>vm.runInContext(s,ctx);
ev(`var hop={p:{chs:'5658,5695,5732',dwell:120,probe:80,settle:300,stale:3,dev:8e6,bw:5e6,std:'auto',color:true,hold:0}}; IQK.tvHop.init(hop);
var __tk=0; var gens=[{p:{tv:'PAL',tvm:'FM',tvdev:8e6}},{p:{tv:'PAL',tvm:'FM',tvdev:8e6}}], rng=12345;
function rnd(){ rng^=rng<<13; rng^=rng>>>17; rng^=rng<<5; return (rng>>>0)/4294967296-.5; }
function sim(ticks,holdN){
  const sr=20e6, N=100000; let fc=0, pend=null, pendT=0, visits=[0,0,0], retune=false, trace=[];
  for(let t=0;t<ticks;t++){
    __T((__tk++)*5);
    const o=IQK.tvHop.process(hop,{in:__s,hold:holdN});
    // приёмник: частота из freq с задержкой 2 такта
    if(o.freq*1 && o.freq!==fc){ if(pend!==o.freq){ pend=o.freq; pendT=t; } if(t-pendT>=2){ fc=pend; retune=true; pend=null; } }
    const idx=[5658e6,5695e6,5732e6].indexOf(fc);
    let re,im;
    if(idx>=0 && idx<2){ [re,im]=tvGenerate(gens[idx],sr,N); }
    else { re=new Float32Array(N); im=new Float32Array(N); for(let i=0;i<N;i++){ re[i]=rnd(); im[i]=rnd(); } }
    if(idx>=0) visits[idx]++;
    __s={sr,fc,chunks:[{re,im,t0:0,tag:retune?'retune':null}]}; retune=false;
    trace.push(o.ch);
  }
  return {visits,trace};
}`);
ctx.__T=v=>{ T=v; }; ev('var __s=null');
const r=ev('sim(150,0)');
const mos=ev('hop.mos'), mw=ev('hop.mw'), mh=ev('hop.mh'), cols=ev('hop.cols');
const tileMean=j=>{ const col=j%cols, row=(j/cols)|0; let s=0,c=0,sd=0; const v=[];
  for(let y=0;y<288;y+=2) for(let x=0;x<384;x+=2){ const o=((row*288+y)*mw+col*384+x)*4; const g=(mos[o]+mos[o+1]+mos[o+2])/3; v.push(g); s+=g; c++; }
  const m=s/c; for(const g of v) sd+=(g-m)*(g-m); return {mean:m, sd:Math.sqrt(sd/c)}; };
let bad=0; const chk=(n,ok,info)=>{ console.log(ok?'ok  ':'FAIL',n,info??''); if(!ok) bad++; };
if(process.env.DUMP) fs.writeFileSync(process.env.DUMP,Buffer.from(mos.buffer.slice(mos.byteOffset,mos.byteOffset+mos.length)));
const t=[0,1,2].map(tileMean);
console.log('tiles',JSON.stringify(t.map(x=>({m:+x.mean.toFixed(1),sd:+x.sd.toFixed(1)}))),'visits',r.visits.join(','),'mosaic',mw+'×'+mh);
chk('channel 0 has a picture', t[0].sd>25);
chk('channel 1 has a picture', t[1].sd>25);
chk('noise channel stays black', t[2].sd<2 && t[2].mean<5);
const u=ev('hop.ui'); chk('lock count', ev('hop.ch.filter(c=>c.lock).length')>=1, JSON.stringify(u.chans.map(c=>c.lock)));
{ const tr=r.trace; let cyc=0; for(let i=1;i<tr.length;i++) if(tr[i]===0 && tr[i-1]!==0) cyc++; console.log('cycles',cyc,'→',(tr.length*5/Math.max(1,cyc)).toFixed(0),'ms per cycle (2 live + 1 empty channel, receiver lag 10 ms)'); }
chk('all channels visited', r.visits.every(v=>v>3), r.visits.join(','));
// hold: стоит на 2-м канале и отдаёт полный кадр
const h=ev('(function(){ const r=sim(50,2); return {trace:r.trace.slice(-10), sel:!!hop.sel, selW:hop.sel&&hop.sel.w}; })()');
chk('hold stays on channel 2', h.trace.every(x=>x===1), h.trace.join(''));
chk('hold gives a full frame', h.sel && h.selW===384, JSON.stringify(h));
process.exit(bad?1:0);
