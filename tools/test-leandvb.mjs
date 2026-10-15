// DVB-S из IQ (modules/leandvb-kernels.js + vendor/leandvb.wasm): node tools/test-leandvb.mjs <каталог leansdr>
// Передатчик leandvbtx и генератор пакетов leantsgen собираются из исходников LeanSDR (нужен g++), сигнал идёт через wasm.
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const src=process.argv[2] && fs.existsSync(path.join(process.argv[2],'src/apps/leandvbtx.cc')) ? path.resolve(process.argv[2]) : null;
if(!src){ console.log('skip: pass the LeanSDR checkout (git clone https://github.com/pabr/leansdr)'); process.exit(0); }
const ctx=vm.createContext({Math,Uint8Array,Float32Array,Array,Error,Promise,Object,JSON,WebAssembly,TextDecoder,TextEncoder,DataView,console});
vm.runInContext(fs.readFileSync(path.join(root,'modules/leandvb-kernels.js'),'utf8')+fs.readFileSync(path.join(root,'modules/ts-kernels.js'),'utf8')+';this.LeanDvb=LeanDvb; this.TsDemux=TsDemux;',ctx);
const wasm=fs.readFileSync(path.join(root,'vendor/leandvb.wasm'));
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ldvb-'));
for(const a of ['leandvbtx','leantsgen','leanchansim']) execFileSync('g++',['-O2','-w','-I'+path.join(src,'src'),'-DVERSION="t"',path.join(src,'src/apps',a+'.cc'),'-o',path.join(tmp,a)]);
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };
const sh=c=>execFileSync('sh',['-c',c],{maxBuffer:1<<30});

// пакеты leantsgen: sync 0x47, байт 1..3 — номер пакета; ищем подряд идущие
function check(ts,sent){
  let good=0, prev=-1, jumps=0;
  for(let o=0;o+188<=ts.length;o+=188){
    if(ts[o]!==0x47) continue;
    const t=(ts[o+1]<<16)|(ts[o+2]<<8)|ts[o+3];
    let okp=true; for(let i=4;i+3<188;i+=4) if(ts[o+i]!==(i&255)||((ts[o+i+1]<<16)|(ts[o+i+2]<<8)|ts[o+i+3])!==t) okp=false;
    if(!okp) continue; good++; if(prev>=0 && t!==prev+1) jumps++; prev=t;
  }
  return {good,jumps,sent};
}
async function run(name,{std='DVB-S',cstln='QPSK',cr='1/2',snr=null,sr=1e6,fs=2e6,pk=3000,min=.9}){
  const awgn=snr==null ? '' : `| ${tmp}/leanchansim --awgn ${15-snr} --deterministic`;
  const iq=sh(`${tmp}/leantsgen -c ${pk} | ${tmp}/leandvbtx --const ${cstln} --cr ${cr} -f ${fs/sr} --power 15 --agc ${awgn}`);
  const f=new Float32Array(iq.buffer.slice(iq.byteOffset,iq.byteOffset+(iq.length&~7)));
  const d=await ctx.LeanDvb.create(wasm); d.init({std,cstln,cr,sr,fs});
  for(let i=0;i<f.length;i+=1<<16) d.feed(f.subarray(i,i+(1<<16)));
  const ts=d.take()||new Uint8Array(0), r=check(ts,pk);
  ok(name,r.good>=pk*min && r.jumps<=Math.max(2,pk*.01),`${r.good}/${pk} packets, ${r.jumps} gaps, MER ${d.st.mer}, lock ${d.st.lock}, dropped in ${d.lostIn}`);
}
await run('DVB-S QPSK 1/2',{});
await run('DVB-S QPSK 3/4',{cr:'3/4'});
await run('DVB-S QPSK 7/8',{cr:'7/8'});
await run('DVB-S QPSK 1/2, 3 samples/symbol',{fs:3e6});
await run('DVB-S QPSK 2/3, noise',{cr:'2/3',snr:14,pk:6000});
// настоящий поток: ffmpeg (MPEG-2 + MP2) → DVB-S → wasm → демукс «TS → Video»: программа, видео и звук находятся, потерь счётчика непрерывности нет
try{ execFileSync('ffmpeg',['-version'],{stdio:'ignore'}); }catch(e){ console.log('skip real stream (no ffmpeg)'); }
if(fs.existsSync(path.join(tmp,'leandvbtx')) && (()=>{ try{ execFileSync('ffmpeg',['-version'],{stdio:'ignore'}); return true; }catch(e){ return false; } })()){
  sh(`ffmpeg -v error -y -f lavfi -i testsrc=size=320x240:rate=25 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 6 -c:v mpeg2video -b:v 600k -c:a mp2 -b:a 64k -f mpegts ${tmp}/v.ts`);
  const iq=sh(`${tmp}/leandvbtx --const QPSK --cr 3/4 -f 2 --power 15 --agc --fill < ${tmp}/v.ts`);
  const f=new Float32Array(iq.buffer.slice(iq.byteOffset,iq.byteOffset+(iq.length&~7)));
  const d=await ctx.LeanDvb.create(wasm); d.init({sr:1e6,fs:2e6,cr:'3/4'});
  for(let i=0;i<f.length;i+=1<<16) d.feed(f.subarray(i,i+(1<<16)));
  const ts=d.take()||new Uint8Array(0), dm=new ctx.TsDemux(); dm.push(ts);
  const pl=dm.list();
  ok('real stream: program with video and audio',pl.length>=1 && !!dm.vcodec && !!(dm.cur&&dm.cur.apid),`programs ${pl.length}, video ${dm.vcodec}, frames ${dm.stat.frames}, lost ${dm.stat.cc}`);
  ok('real stream: video frames, no lost packets',dm.stat.frames>100 && dm.stat.cc<=2,`frames ${dm.stat.frames}, cc ${dm.stat.cc}`);
}
fs.rmSync(tmp,{recursive:true,force:true});
console.log(bad ? bad+' failed' : 'all ok'); process.exit(bad?1:0);
