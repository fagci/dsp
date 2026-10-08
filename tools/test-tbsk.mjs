// TBSK: node tools/test-tbsk.mjs
// Проверка по собственному модулятору (петля), шумом и сдвигом; сверки с оригинальным TBSKmodem нет.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,Float64Array,Uint8Array,BigInt,Number,Array,Object});
vm.runInContext(fs.readFileSync(path.join(root,'modules/tbsk-kernels.js'),'utf8')+';this.T={tbskTone,tbskBits,tbskModulate,tbskRxNew,tbskRxFeed,tbskPreambleSyms,tbskXorShift};',ctx);
const T=ctx.T;
let bad=0; const eq=(n,a,b)=>{ if(JSON.stringify(a)!==JSON.stringify(b)){ bad++; console.log('FAIL',n,JSON.stringify(a),'!=',JSON.stringify(b)); } else console.log('ok  ',n); };
const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };

let sd=12345; const rnd=()=>{ sd^=sd<<13; sd^=sd>>>17; sd^=sd<<5; return (sd>>>0)/4294967296; };
const gs=()=>Math.sqrt(-2*Math.log(Math.max(rnd(),1e-12)))*Math.cos(2*Math.PI*rnd());

const FS=48000, FC=4800, CY=10;
const tone=T.tbskTone(FS,FC,CY);
eq('tone length',tone.length,100);
ok('tone amplitude',Math.max(...tone)<=1 && Math.min(...tone)>=-1);
const xs=T.tbskXorShift(999,299); const a=[xs(),xs(),xs()];
ok('xorshift 31-bit',a.every(v=>v>=0 && v<=0x7fffffff),a.join(','));
eq('preamble length',T.tbskPreambleSyms(4).length,14);
eq('preamble bits',T.tbskPreambleSyms(4),[0,1,1,1,1,1,1,0,1,0,1,0,0,1]);

const enc=s=>[...new TextEncoder().encode(s)];
// сигнал: тишина, (шум), пакет, тишина → кадры
function run(sig,N,opt){
  const rx=T.tbskRxNew(N,opt), out=[];
  for(let i=0;i<sig.length;i+=512) T.tbskRxFeed(rx,sig.subarray(i,Math.min(sig.length,i+512)),Math.min(512,sig.length-i),out);
  return out;
}
function build(msgs,o){
  o=o||{}; const parts=[];
  const gap=new Float32Array(o.gap||2000);
  parts.push(new Float32Array(o.lead==null ? 777 : o.lead));
  for(const m of msgs){ parts.push(T.tbskModulate(tone,T.tbskBits(enc(m)),{amp:o.amp==null ? .5 : o.amp})); parts.push(gap); }
  let L=0; for(const p of parts) L+=p.length; const s=new Float32Array(L); let k=0; for(const p of parts){ s.set(p,k); k+=p.length; }
  const sg=o.noise||0; for(let i=0;i<L;i++) s[i]+=sg*gs();
  return s;
}
const txt=f=>new TextDecoder().decode(f.bytes);
{ const fr=run(build(['Hello, TBSK!']),tone.length); eq('clean: frames',fr.length,1); eq('clean: text',fr[0] && txt(fr[0]),'Hello, TBSK!'); ok('clean: quality',fr[0] && fr[0].quality>.9,fr[0] && fr[0].quality.toFixed(2)); }
{ const fr=run(build(['one','two','three']),tone.length); eq('three frames',fr.map(txt),['one','two','three']); }
{ const fr=run(build(['ÿ\u0000ª U']),tone.length); eq('binary/utf8',fr[0] && [...fr[0].bytes],enc('ÿ\u0000ª U')); }
for(const lead of [0,1,33,99,500]){ const fr=run(build(['offset'],{lead}),tone.length); eq('lead '+lead,fr.map(txt),['offset']); }
// шум: сигнал 0.5 (мощность 0.125 при тоне ~0.5) → SNR по мощности
for(const sg of [.2,.3,.45,.8]){
  let good=0, tr=20;
  for(let k=0;k<tr;k++){ const fr=run(build(['noise test 1234'],{noise:sg}),tone.length); if(fr.length>=1 && txt(fr[0])==='noise test 1234') good++; }
  const pw=tone.reduce((s,v)=>s+(.5*v)*(.5*v),0)/tone.length, snr=10*Math.log10(pw/(sg*sg));
  console.log('     noise σ='+sg+' SNR '+snr.toFixed(1)+' dB: '+good+'/'+tr);
  if(sg<=.3) ok('noise σ='+sg+' decodes',good>=tr-1,good+'/'+tr);
}
// только шум: ложных кадров нет
{ const s=new Float32Array(48000*20); for(let i=0;i<s.length;i++) s[i]=.3*gs(); const fr=run(s,tone.length); eq('noise only: no frames',fr.length,0); }
// только шум на коротком тоне (N = 20): шум r крупнее, ложного захвата быть не должно
{ const s=new Float32Array(48000*30); for(let i=0;i<s.length;i++) s[i]=.3*gs(); const fr=run(s,20); eq('noise only, N=20: no frames',fr.length,0); }
// тон без пакета (чистая несущая и речеподобные биения)
{ const s=new Float32Array(48000*5); for(let i=0;i<s.length;i++) s[i]=.5*Math.sin(2*Math.PI*FC*i/FS)+.2*Math.sin(2*Math.PI*1234*i/FS)*Math.sin(2*Math.PI*3*i/FS); const fr=run(s,tone.length); eq('carrier only: no frames',fr.length,0); }
// уход такта приёмника: ресемплинг передачи на ±0.05%
for(const ppm of [-500,500]){
  const s=build(['clock drift test, 40 bytes of payload ok.']), n=Math.floor(s.length/(1+ppm*1e-6)), r=new Float32Array(n);
  for(let i=0;i<n;i++){ const p=i*(1+ppm*1e-6), i0=Math.floor(p), f=p-i0; r[i]=s[i0]*(1-f)+(s[i0+1]||0)*f; }
  const fr=run(r,tone.length); eq('clock '+ppm+' ppm',fr.map(txt),['clock drift test, 40 bytes of payload ok.']);
}
// длина ограничена параметром
{ const fr=run(build(['abcdefgh']),tone.length,{maxBytes:3}); eq('max bytes',fr[0] && txt(fr[0]),'abc'); }
// другой тон/скорость
{ const t2=T.tbskTone(48000,2000,6), m=T.tbskModulate(t2,T.tbskBits(enc('slow')),{amp:.4}), s=new Float32Array(m.length+4000); s.set(m,1000);
  const fr=run(s,t2.length); eq('2 kHz × 6',fr.map(f=>new TextDecoder().decode(f.bytes)),['slow']); }
process.exit(bad ? 1 : 0);
