// DVB-T2 frames on worker threads: node tools/test-dvbt2-par.mjs <capture.cfile> <reference.ts> <workers> [bw MHz] [input rate]
// Measures the throughput of the job/result protocol with real parallelism (jobs wait for a free worker, nothing is dropped) and checks the stream.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const [cap,ref,nw='4',bw='8',rate='0']=process.argv.slice(2);
if(!cap||!ref){ console.log('usage: node tools/test-dvbt2-par.mjs <capture.cfile> <reference.ts> <workers> [bw MHz] [input rate]'); process.exit(0); }
const ctx=vm.createContext({Math,Uint8Array,Float32Array,Array,Error,Promise,Object,JSON,WebAssembly,TextDecoder,TextEncoder,DataView,console});
vm.runInContext(fs.readFileSync(path.join(root,'modules/leandvb-kernels.js'),'utf8')+';this.DvbOfdm=DvbOfdm;',ctx);
const d=await ctx.DvbOfdm.create(fs.readFileSync(path.join(root,'vendor/dvbofdm.wasm')));
const fsNom=+bw===7 ? 8e6 : +bw*8e6/7;
d.init({bw:+bw,plp:-1,fs:+rate||fsNom}); d.setParallel(true);
const pool=[]; let queue=[], inflight=0, done=0, jobs=0;
const outs=[];
function kick(){ for(const o of pool) if(!o.busy && queue.length){ const j=queue.shift(); o.busy=true; o.w.postMessage({seq:j.seq,d:j.d.buffer},[j.d.buffer]); } }
await Promise.all(Array.from({length:+nw},()=>new Promise(res=>{
  const w=new Worker(new URL('./par-worker.mjs',import.meta.url)), o={w,busy:false};
  w.on('message',m=>{ if(m.ready){ pool.push(o); res(); return; } o.busy=false; inflight--; done++; d.result(new Uint8Array(m.d)); const t=d.take(); if(t) outs.push(t); kick(); });
})));
const raw=fs.readFileSync(cap), f=new Float32Array(raw.buffer.slice(raw.byteOffset,raw.byteOffset+(raw.length&~7)));
const CH=131072, t0=Date.now(); let tFeed=0;
for(let i=0;i<f.length;i+=CH){
  const tf=performance.now(); d.feed(f.subarray(i,i+CH)); tFeed+=performance.now()-tf; const t=d.take(); if(t) outs.push(t);
  for(const j of d.takeJobs()){ queue.push(j); inflight++; jobs++; }
  kick();
  if(i%(CH*8)===0) await new Promise(r=>setImmediate(r));      // let results in
}
while(inflight>0) await new Promise(r=>setTimeout(r,5));
const sec=(Date.now()-t0)/1000;
for(const o of pool) o.w.terminate();
const ts=Buffer.concat(outs), a=fs.readFileSync(ref), P=188, nb=Math.floor(ts.length/P);
let first=-1; for(let i=0;i+2<nb;i++) if([0,1,2].every(k=>!(ts[(i+k)*P+1]===0x1f&&ts[(i+k)*P+2]===0xff))){ first=i; break; }
let bad=0, good=0, off=-1;
if(first>=0){ const k=a.indexOf(ts.subarray(first*P,(first+3)*P)); if(k>=0 && k%P===0) off=k/P-first; }
if(off>=0) for(let i=0;i<nb-1;i++){ const j=i+off; if((j+1)*P>a.length) break; if(ts.compare(a,j*P,(j+1)*P,i*P,(i+1)*P)===0) good++; else bad++; }
console.log(`receiver thread busy ${(tFeed/1000).toFixed(1)} s`);
console.log(`${nw} workers: ${(f.length/2/1e6).toFixed(1)} MS in ${sec.toFixed(1)} s (${(f.length/2/1e6/sec).toFixed(2)} MS/s), ${jobs} frames, ${nb} packets, ${good} identical, ${bad} different`);
process.exit(off>=0 && bad===0 && good>100 ? 0 : 1);
