// DSP узлов Studio в графе: node tools/test-studio-dsp.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,Array,Object,Number,String,Map,JSON,Infinity});
for(const f of ['studio-kernels','studio-dsp']) vm.runInContext(fs.readFileSync(path.join(root,'modules/'+f+'.js'),'utf8'),ctx);
vm.runInContext('this.K={stFxNew,ST_FX,stFillP,stBqCoef,StBq,stJsDrumVoice,stJsDrumRender,stJsClipVoice,stJsClipRender,ST_DRUM_KINDS,ST_KITS,stDefs};',ctx);
const K=ctx.K; const SR=44100, N=512;
let bad=0; const ok=(n,c)=>{ if(!c){ bad++; console.log('FAIL',n); } else console.log('ok  ',n); };
const rms=(b,a=0,e=b.length)=>{ let s=0; for(let i=a;i<e;i++) s+=b[i]*b[i]; return Math.sqrt(s/Math.max(1,e-a)); };
const finite=b=>b.every(Number.isFinite);
const sine=(f,len,a=.5)=>{ const b=new Float32Array(len); for(let i=0;i<len;i++) b[i]=a*Math.sin(2*Math.PI*f*i/SR); return b; };
const noise=(len,a=.3)=>{ let s=7; const b=new Float32Array(len); for(let i=0;i<len;i++){ s=(s*1664525+1013904223)>>>0; b[i]=(s/2147483648-1)*a; } return b; };
// гнать буфер блоками через эффект; R=null — моно
function run(type,p,L,R,ctxo){
  const fx=K.stFxNew(type,SR); fx.set(K.stFillP(K.ST_FX[type].p,p),ctxo||{bpm:120,beat:0});
  for(let i=0;i<L.length;i+=N){ const n=Math.min(N,L.length-i), l=L.subarray(i,i+n), r=R?R.subarray(i,i+n):null; if(ctxo) ctxo.beat=(ctxo.beat||0)+n*ctxo.bpm/60/SR; fx.run(l,r,n); }
  return fx;
}
// фильтр
{ const lo=sine(200,SR), hi=sine(8000,SR); run('filter',{type:'lp',cut:1000,res:.7},lo,null); run('filter',{type:'lp',cut:1000,res:.7},hi,null);
  ok('lowpass passes 200 Hz',rms(lo,SR/2)>.3); ok('lowpass kills 8 kHz',rms(hi,SR/2)<.02); }
// eq
{ const a=sine(60,SR), b=sine(60,SR); run('eq',{lo:12,lf:120},a,null);
  const g=rms(a,SR/2)/rms(b,SR/2); ok('eq +12 dB lows ≈ ×4 ('+g.toFixed(2)+')',g>3.3&&g<4.7); }
// компрессор
{ const a=sine(440,SR,.9); run('comp',{thr:-20,ratio:8,att:.001,rel:.05,gain:0},a,null); ok('comp squashes a loud sine',rms(a,SR/2)<.35); }
// delay: эхо через 1/4 при 120 bpm = 22050 сэмплов
{ const a=new Float32Array(SR); a[0]=1; run('delay',{div:'1/4',fb:0,tone:16000,pp:0,mix:.5},a,null,{bpm:120,beat:0});
  let k=1; for(let i=100;i<SR;i++) if(Math.abs(a[i])>Math.abs(a[k])||k===1&&Math.abs(a[i])>.1) k=Math.abs(a[i])>Math.abs(a[k])?i:k;
  ok('delay echo at 1/4 note ('+k+')',Math.abs(k-22050)<40 && a[0]>.9); }
// реверб: хвост затухает, уровень разумный, нет NaN
{ const a=noise(SR*3), b=a.slice(); const dry=rms(b); run('reverb',{size:2,mix:1,damp:.5,pre:.01,lc:120},a,null);
  ok('reverb finite',finite(a)); ok('reverb wet level sane ('+(rms(a,SR,SR*2)/dry).toFixed(2)+')',rms(a,SR,SR*2)/dry>.3&&rms(a,SR,SR*2)/dry<2.5);
  const imp=new Float32Array(SR*4), r=new Float32Array(SR*4); imp[0]=1; r[0]=1; run('reverb',{size:1.5,mix:1,damp:.5,pre:0,lc:60},imp,r);
  ok('reverb tail decays',rms(imp,SR*2,SR*2+4000)<rms(imp,2000,6000)*.2 && rms(imp,SR*3,SR*4)>=0); }
// остальные: конечные значения, ненулевой выход
for(const t of ['chorus','phaser','dist','crush','pump','gate','width']){
  const L=noise(SR,.3), R=noise(SR,.3), c={bpm:120,beat:0}; run(t,{},L,R,c); ok(t+': finite and alive',finite(L)&&finite(R)&&rms(L)>.001); }
// pump: в долю громкость падает на depth
{ const a=new Float32Array(SR).fill(.5), c={bpm:120,beat:0}; run('pump',{div:'1/4',depth:.8,rel:.5,off:0},a,null,c); ok('pump ducks on the beat',a[5]<.2&&a[Math.floor(SR*.45)]>.35); }
// ударные
for(const kind of K.ST_DRUM_KINDS){
  const p=Object.assign(K.stDefs(vm.runInContext('ST_DRUM',ctx)),{kind}), v=K.stJsDrumVoice(kind,p,110,SR,1), out=new Float32Array(SR*5);
  for(let o=0;o<out.length&&!v.done;o+=N) K.stJsDrumRender(v,out,Math.min(N,out.length-o),o);
  let pk=0; for(const x of out) pk=Math.max(pk,Math.abs(x));
  ok('drum '+kind+': sounds, finite, ends ('+pk.toFixed(2)+')',finite(out)&&pk>.05&&pk<1.6&&v.done&&rms(out,SR*4)<.01); }
// клип
{ const d=sine(440,4410), v=K.stJsClipVoice(d,SR,SR,60,60,0,1,100), out=new Float32Array(8192); for(let o=0;o<out.length&&!v.done;o+=N) K.stJsClipRender(v,out,N,o);
  ok('clip plays and ends',v.done&&rms(out,0,4000)>.2&&rms(out,5000,8000)<1e-6); }
process.exit(bad?1:0);
