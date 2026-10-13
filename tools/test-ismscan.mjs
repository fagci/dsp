// Широкополосный сканер ISM: записи rtl_433_tests (250 кС/с, 433,92 МГц) переносятся на разные смещения внутри полосы 2 МС/с
// и подаются в IQK.ismScan одним потоком. Проверка: node tools/test-ismscan.mjs <путь к rtl_433_tests/tests> [-v]
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2), verbose=args.includes('-v'), dir=args.find(a=>!a.startsWith('-'));
if(!dir){ console.error('usage: node tools/test-ismscan.mjs <rtl_433_tests/tests> [-v]'); process.exit(2); }
const worker=fs.readFileSync(path.join(root,'iq-worker.js'),'utf8');
const files=[...worker.match(/importScripts\((.*)\);/)[1].matchAll(/'([^']+)'/g)].map(m=>m[1].replace(/\+Q$/,''));
const ctx=vm.createContext({console,Math,Float32Array,Float64Array,Uint8Array,Uint16Array,Uint32Array,Int8Array,Int16Array,Int32Array,Map,Set,Date,JSON,Array,Object,String,Number,parseInt,parseFloat,isFinite,isNaN,Symbol,Promise,BigInt,DataView,WebAssembly,TextDecoder,atob,RegExp,Error,performance});
ctx.self=ctx;
for(const f of files) vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});
const ev=s=>vm.runInContext(s,ctx);
ev(`ISM_RT.mod=null; globalThis.__setRt=m=>{ ISM_RT.mod=m; };`);
if(process.env.DUMP) ev(`globalThis.DUMP=[]; { const o=ismRecFromPulses; ismRecFromPulses=function(u,m){ DUMP.push(u); return o(u,m); }; }`);
ctx.__setRt(new WebAssembly.Module(fs.readFileSync(path.join(root,'vendor/rtl433.wasm'))));

const BASE=!!process.env.BASE, SR=BASE ? 250000 : 2000000, L=BASE ? 1 : 8;                                    // 250 кС/с × 8
const cases=[
  ['nexus/01/gfile001', -700e3], ['nexus/03/g027_433.92M_250k',-300e3], ['Fineoffset-WH2/01/g001_433.92M_250k',250e3],
  ['acurite/Acurite_5-n-1/g001_433.92M_250k',650e3], ['Esperanza-EWS/g001_433.92M_250k',-100e3]];
function find(base){
  const g=[...fs.readdirSync(dir,{recursive:true})].filter(f=>f.includes(base.split('/')[0]) && /\.cu8$/.test(f));
  return g;
}
// кандидаты: первые подходящие файлы с JSON
const picks=[];
const NP=+process.env.SINGLE||6, offs=Array.from({length:NP},(_,i)=>(i%7-3)*210e3+35e3);
const all=fs.readdirSync(dir,{recursive:true}).filter(f=>/_433\.92M_250k\.cu8$/.test(f)).sort();
const skip=/Oil|Schrader|Interlogix|Lightwave|Jansite|Brennen|Waveman|Honeywell|Steelmate/;     // многострочные и редкие — для проверки полосы не нужны
for(const f of all){
  if(picks.length>=offs.length) break;
  const j=path.join(dir,f.replace(/\.cu8$/,'.json')); if(!fs.existsSync(j)) continue;
  const exp=fs.readFileSync(j,'utf8').split('\n').filter(l=>l.startsWith('{')).map(l=>{ try{ return JSON.parse(l); }catch(e){ return null; } }).filter(Boolean);
  const m=exp[0] && exp[0].model;
  const hasProto=(()=>{ for(let d=path.dirname(path.join(dir,f));d.length>=dir.length;d=path.dirname(d)) if(fs.existsSync(path.join(d,'protocol'))) return true; return false; })();
  if(m && !hasProto && !skip.test(m) && fs.statSync(path.join(dir,f)).size<400000 && !picks.some(p=>p.model===m)) picks.push({f,model:m,exp,off:offs[picks.length]});
}
if(process.env.ONLY){ const k=picks.filter(p=>p.model===process.env.ONLY); picks.length=0; picks.push(...k); }
// интерполяция ×L с фильтром и перенос на смещение
const taps=new Float32Array(8*L*2+1);
for(let i=0;i<taps.length;i++){ const x=(i-(taps.length-1)/2)/L, w=.54+.46*Math.cos(Math.PI*(i-(taps.length-1)/2)/((taps.length-1)/2)); taps[i]=(x===0 ? 1 : Math.sin(Math.PI*x)/(Math.PI*x))*w; }
function run(picks){
const segs=[]; let maxLen=0;
for(const p of picks){
  const b=fs.readFileSync(path.join(dir,p.f)), n=b.length>>1, N=n*L;
  const re=new Float32Array(N), im=new Float32Array(N);
  for(let i=0;i<n;i++){ re[i*L]=(b[2*i]-128)/128; im[i*L]=(b[2*i+1]-128)/128; }
  const fr=new Float32Array(N), fi=new Float32Array(N), h=taps.length>>1;
  for(let i=0;i<N;i++){ let a=0,c=0; const k0=Math.max(0,i-h), k1=Math.min(N-1,i+h);
    for(let k=k0;k<=k1;k++){ const g=taps[k-i+h]; a+=re[k]*g; c+=im[k]*g; } fr[i]=a; fi[i]=c; }
  const w=BASE ? 0 : 2*Math.PI*p.off/SR;
  for(let i=0;i<N;i++){ const c=Math.cos(w*i), s=Math.sin(w*i), a=fr[i], d=fi[i]; fr[i]=a*c-d*s; fi[i]=a*s+d*c; }
  p.iq=[fr,fi]; p.len=N; maxLen=Math.max(maxLen,N);
}
// сумма всех (одновременно) + шум
const SCALE=+process.env.SCALE||(process.env.SINGLE ? 1 : .5), NOISE=+process.env.NOISE||.002;
const PAD=Math.round(.5*SR);                          // сначала тишина: пока усиление не установилось, сигналов нет
maxLen+=PAD;
const R=new Float32Array(maxLen), Im=new Float32Array(maxLen);
for(const p of picks) for(let i=0;i<p.len;i++){ R[PAD+i]+=p.iq[0][i]*SCALE; Im[PAD+i]+=p.iq[1][i]*SCALE; }
let x=12345; const rnd=()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return (x>>>0)/4294967296; };
for(let i=0;i<maxLen;i++){ R[i]+=(rnd()-.5)*NOISE; Im[i]+=(rnd()-.5)*NOISE; }
// гонка: узел и поток
const n={id:'t',type:'ismScan',p:{N:'auto',plan:process.env.PLAN||'4',gain:process.env.GAIN||'auto',dc:process.env.DC||'subtract',devs:'default',only:'',snr:+(process.env.SNR||20),minp:+(process.env.MINP||8),raw:!!process.env.RAW,minBits:16,dedup:0,sel:''},out:{}};
const K=ev('IQK.ismScan'); K.init(n);
const B=16384, recs=[]; let t0=Date.now();
for(let i=0;i<maxLen;i+=B){
  const e=Math.min(maxLen,i+B), s={sr:SR, fc:433.92e6, t:i, chunks:[{re:R.slice(i,e), im:Im.slice(i,e), t0:i}]};
  const o=K.process(n,{in:s},{block:B,sr:SR});
  if(o.rec) recs.push(...o.rec);
}
if(!process.env.SINGLE) console.log(`scanned ${(maxLen/SR).toFixed(1)} s of ${SR/1e6} MS/s in ${((Date.now()-t0)/1000).toFixed(1)} s, N=${n.N}, ${n.srOut} S/s per channel, gain ${(20*Math.log10(n.gain)).toFixed(0)} dB`);
let bad=0;
for(const p of picks){
  const got=recs.filter(r=>r.proto===p.model);
  const key=new Set(got.map(r=>r.id));
  const okFields=p.exp.filter(e=>got.some(g=>Object.entries(e).every(([k,v])=>['time','mod','freq','rssi','snr','noise','protocol','model'].includes(k) || (k==='id' ? g.dev===v : (typeof v==='number' ? Math.abs(g[k]-v)<1e-3 : g[k]===v)))));
  const ok=okFields.length>0;
  if(!ok) bad++;
  console.log((ok?'ok   ':'FAIL ')+p.f+' '+p.model.padEnd(24)+' offset '+(p.off/1e3)+' kHz: '+okFields.length+'/'+p.exp.length+' events, '+got.length+' records at '+[...new Set(got.map(r=>(r.freq/1e6).toFixed(3)))].join(','));
}
if(process.env.DUMP) for(const u of ctx.DUMP.slice(0,3)) console.log('PKT',u.mod,u.sr,u.p.length/2,u.p.slice(0,36).join(','));
if(process.env.SHOW) for(const r of recs.slice(0,12)) console.log(r.freq,r.mod,r.text,r.rssi,r.snr);
if(process.env.SHOW && n.sp) console.log('ch dB:',Array.from(n.sp.mag).map((v,i)=>((n.sp.freqs[i]-433.92e6)/1e3).toFixed(0)+':'+(20*Math.log10(v+1e-12)).toFixed(0)).join(' '));
console.log('other models:',[...new Set(recs.filter(r=>!picks.some(p=>p.model===r.proto)).map(r=>r.proto))].join(', ')||'-');
console.log(bad ? 'FAILED' : 'all ok');
return bad;
}
if(process.env.SINGLE){ let fails=0; for(const p of picks){ if(run([p])) fails++; } console.log('single: failed '+fails+'/'+picks.length); process.exit(fails?1:0); }
process.exit(run(picks) ? 1 : 0);
