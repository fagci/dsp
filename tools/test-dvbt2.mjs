// DVB-T2 из IQ (modules/leandvb-kernels.js DvbOfdm + vendor/dvbofdm.wasm): node tools/test-dvbt2.mjs <capture.cfile> <reference.ts> [bw MHz] [input rate]
// Capture: complex float32 at the channel rate (8 MHz channel: 9142857 S/s), e.g. made with tools/dvbofdm/t2gen.py from GNU Radio's transmitter.
// The recovered transport stream must be a bit exact continuation of the reference.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const [cap,ref,bw='8',rate='0']=process.argv.slice(2);
if(!cap||!ref||!fs.existsSync(cap)){ console.log('usage: node tools/test-dvbt2.mjs <capture.cfile> <reference.ts> [bw MHz] [input rate]'); process.exit(0); }
const ctx=vm.createContext({Math,Uint8Array,Float32Array,Array,Error,Promise,Object,JSON,WebAssembly,TextDecoder,TextEncoder,DataView,console});
vm.runInContext(fs.readFileSync(path.join(root,'modules/leandvb-kernels.js'),'utf8')+';this.DvbOfdm=DvbOfdm;',ctx);
const d=await ctx.DvbOfdm.create(fs.readFileSync(path.join(root,'vendor/dvbofdm.wasm')));
const fsNom=+bw===7 ? 8e6 : +bw*8e6/7;
d.init({bw:+bw,plp:-1,fs:+rate||fsNom});
const raw=fs.readFileSync(cap), f=new Float32Array(raw.buffer.slice(raw.byteOffset,raw.byteOffset+(raw.length&~7)));
const t0=Date.now(), outs=[];
const CH=+(process.env.CH||131072); for(let i=0;i<f.length;i+=CH){ d.feed(f.subarray(i,i+CH)); const t=d.take(); if(t) outs.push(t); }
const sec=(Date.now()-t0)/1000;
const ts=Buffer.concat(outs), a=fs.readFileSync(ref), P=188;
const nb=Math.floor(ts.length/P);
let first=-1; for(let i=0;i+2<nb;i++) if([0,1,2].every(k=>!(ts[(i+k)*P+1]===0x1f&&ts[(i+k)*P+2]===0xff))){ first=i; break; }
let bad=0, good=0, off=-1;
if(first>=0){ const k=a.indexOf(ts.subarray(first*P,(first+3)*P)); if(k>=0 && k%P===0) off=k/P-first; }
if(off>=0) for(let i=0;i<nb-1;i++){ const j=i+off; if((j+1)*P>a.length) break; if(ts.compare(a,j*P,(j+1)*P,i*P,(i+1)*P)===0) good++; else bad++; }
console.log(d.st.info);
console.log(`${(f.length/2/1e6).toFixed(1)} MS in ${sec.toFixed(1)} s (${(f.length/2/1e6/sec).toFixed(2)} MS/s), ${nb} packets, ${good} identical, ${bad} different`);
const okAll=off>=0 && bad===0 && good>100;
console.log(okAll ? 'ok  T2 stream is bit exact' : 'FAIL');
process.exit(okAll?0:1);
