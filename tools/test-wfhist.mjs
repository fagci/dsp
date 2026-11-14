// Перерисовка водопада из истории по частям (saHistJob): по частям == целиком, поздние строки дорисовываются со сдвигом
import fs from 'node:fs'; import vm from 'node:vm';
const src=fs.readFileSync(new URL('../modules/analysis.js',import.meta.url),'utf8');
const a=src.indexOf('function saHistJob('), b=src.indexOf('// перерисованная история целиком в GL-кольцо');
let fail=0; const ok=(c,m)=>{ console.log((c?'ok   ':'FAIL ')+m); if(!c) fail++; };
const ctx={performance, console, Math, Float64Array, Uint8Array, Int16Array, Uint8ClampedArray, Uint32Array, Infinity,
  SA_H_DB0:-160, SA_H_STEP:.75, clamp:(v,l,h)=>v<l?l:v>h?h:v,
  saFreq:(n,t)=>1e6+t*1e6, saWfWin:()=>[0,255], paletteLut:()=>Uint8Array.from({length:3*256},(_, i)=>i%256), heatIdx:v=>Math.max(0,Math.min(255,Math.round(v*255))), saChanCols:()=>null};
vm.createContext(ctx); vm.runInContext(src.slice(a,b)+';globalThis.saHistJob=saHistJob;globalThis.saHistRender=saHistRender;',ctx);
const Wp=64, H=20; let id=0;
const mkRow=()=>{ const q=new Uint8Array(256); for(let i=0;i<256;i++) q[i]=(i*7+id*13)&255; return {lo:1e6,bin:1e6/256,lv:[q],id:++id}; };
for(const top of [true,false]){
  const n={hist:{rows:[],bytes:0},p:{palette:0}};
  for(let i=0;i<30;i++) n.hist.rows.push(mkRow());
  const J=ctx.saHistJob(n,Wp,H,top); let steps=0;
  while(!J.step(0)){ steps++; if(steps===1){ n.hist.rows.push(mkRow(),mkRow()); } if(steps>1000) break; }
  ok(steps>1,'top='+top+': собрано по частям ('+steps+' шагов)');
  const full=ctx.saHistRender(n,Wp,H,top);
  ok(Buffer.compare(Buffer.from(J.buf.buffer),Buffer.from(full.buffer))===0,'top='+top+': по частям с поздними строками == целиком');
}
process.exit(fail?1:0);
