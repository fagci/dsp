// Ядро Noise Generator: node tools/test-noisegen.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Number,Array,Float32Array,Object});
vm.runInContext(fs.readFileSync(path.join(root,'modules/noisegen-kernels.js'),'utf8')+';this.K={nsgInit,nsgRender,NSG_KEYS,NSG_SCALES};',ctx);
const K=ctx.K, sr=48000;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };

function render(P,secs,{seed=7,block=4800}={}){
  const S=K.nsgInit(sr,seed), N=Math.round(sr*secs), L=new Float32Array(N), R=new Float32Array(N);
  for(let i=0;i<N;i+=block){ const m=Math.min(block,N-i); K.nsgRender(S,{vol:1,width:1,density:120,period:9,bpm:60,rate:12,carrier:200,beat:10,...P},L.subarray(i,i+m),R.subarray(i,i+m),m); }
  return {L,R,S};
}
const rms=x=>{ let s=0; for(const v of x) s+=v*v; return Math.sqrt(s/x.length); };
function fft(re,im){ const n=re.length; for(let i=1,j=0;i<n;i++){ let b=n>>1; for(;j&b;b>>=1) j^=b; j^=b; if(i<j){ [re[i],re[j]]=[re[j],re[i]]; [im[i],im[j]]=[im[j],im[i]]; } }
  for(let len=2;len<=n;len<<=1){ const a=-2*Math.PI/len; for(let i=0;i<n;i+=len) for(let k=0;k<len/2;k++){
    const wr=Math.cos(a*k), wi=Math.sin(a*k), ur=re[i+k], ui=im[i+k], xr=re[i+k+len/2], xi=im[i+k+len/2], vr=xr*wr-xi*wi, vi=xr*wi+xi*wr;
    re[i+k]=ur+vr; im[i+k]=ui+vi; re[i+k+len/2]=ur-vr; im[i+k+len/2]=ui-vi; } } }
// мощность в октавных полосах вокруг fc (дБ)
function octaves(x,fcs){
  const n=16384, acc=new Float64Array(n/2); let c=0;
  for(let o=sr;o+n<=x.length;o+=n){ const re=new Float64Array(n), im=new Float64Array(n);
    for(let i=0;i<n;i++) re[i]=x[o+i]*(.5-.5*Math.cos(2*Math.PI*i/n));
    fft(re,im); for(let i=0;i<n/2;i++) acc[i]+=re[i]*re[i]+im[i]*im[i]; c++; }
  return fcs.map(f=>{ let s=0; for(let i=0;i<n/2;i++){ const fr=i*sr/n; if(fr>=f/Math.SQRT2 && fr<f*Math.SQRT2) s+=acc[i]; } return 10*Math.log10(s/c+1e-30); });
}
const slope=(key)=>{ const {L}=render({[key]:1},8); const o=octaves(L,[250,500,1000,2000,4000]); return (o[4]-o[0])/4; };

// 1. цвета шумов: наклон мощности в октавной полосе (белый +3 дБ/окт за счёт роста ширины полосы)
const sl={}; for(const k of ['white','pink','brown','blue','violet']) sl[k]=slope(k);
const near=(a,b,e)=>Math.abs(a-b)<=e;
ok('white: +3 dB/oct в полосах',near(sl.white,3,.6),sl.white);
ok('pink: плоско по октавам',near(sl.pink,0,.6),sl.pink);
ok('brown: −3 dB/oct (−6 по плотности)',near(sl.brown,-3,.6),sl.brown);
ok('blue: +6 dB/oct (+3 по плотности)',near(sl.blue,6,.8),sl.blue);
ok('violet: +9 dB/oct (+6 по плотности)',near(sl.violet,9,1.2),sl.violet);
ok('наклоны упорядочены brown<pink<white<blue<violet',sl.brown<sl.pink && sl.pink<sl.white && sl.white<sl.blue && sl.blue<sl.violet);

// 2. равная громкость слоёв при уровне 1 (≈ −14 дБFS)
for(const k of ['white','pink','brown','blue','violet','rain','waves','wind','tone']){
  const {L}=render({[k]:1},k==='wind'||k==='waves'?20:6); const r=rms(L);
  ok(`${k}: RMS ${r.toFixed(3)} в 0,12…0,23`,r>.12 && r<.23,r); }

// 3. тишина, повторяемость, независимость от размера блока
ok('все уровни 0 → ровная тишина',(()=>{ const {L,R}=render({},1); return rms(L)===0 && rms(R)===0; })());
{ const a=render({pink:.5,rain:.4,chimes:.5,heart:.3,wind:.3,waves:.3,tone:.2},4), b=render({pink:.5,rain:.4,chimes:.5,heart:.3,wind:.3,waves:.3,tone:.2},4);
  ok('один seed → тот же сигнал',a.L.every((v,i)=>v===b.L[i]));
  const c=render({pink:.5,rain:.4,chimes:.5,heart:.3,wind:.3,waves:.3,tone:.2},4,{seed:8});
  ok('другой seed → другой сигнал',c.L.some((v,i)=>v!==a.L[i]));
  const d=render({pink:.5,rain:.4,chimes:.5,heart:.3,wind:.3,waves:.3,tone:.2},4,{block:128});
  ok('результат не зависит от размера блока',a.L.every((v,i)=>v===d.L[i]) && a.R.every((v,i)=>v===d.R[i]));
  ok('нет NaN / Infinity',a.L.every(Number.isFinite) && a.R.every(Number.isFinite)); }

// 4. всё на максимум: мягкий предел, не клиппинг
{ const P={}; for(const k of K.NSG_KEYS) P[k]=1; const {L,R}=render(P,6);
  ok('всё на 1 → |x|<1 (tanh)',L.every(v=>Math.abs(v)<1) && R.every(v=>Math.abs(v)<1));
  ok('всё на 1 → сигнал не мёртвый',rms(L)>.2); }

// 5. стерео: width 0 — моно, 1 — независимые уши
{ const m=render({pink:1,width:0},2), w=render({pink:1,width:1},2);
  ok('width 0: L = R',m.L.every((v,i)=>Math.abs(v-m.R[i])<1e-6));
  const corr=(a,b)=>{ let s=0,x=0,y=0; for(let i=0;i<a.length;i++){ s+=a[i]*b[i]; x+=a[i]*a[i]; y+=b[i]*b[i]; } return s/Math.sqrt(x*y); };
  ok('width 1: уши почти некоррелированы',Math.abs(corr(w.L,w.R))<.1,corr(w.L,w.R)); }

// 6. тон: binaural — частоты в ушах разные, monaural/isochronic — одинаковые
const zc=(x,t0,t1)=>{ let c=0; for(let i=Math.round(t0*sr)+1;i<Math.round(t1*sr);i++) if(x[i-1]<0 && x[i]>=0) c++; return c/(t1-t0); };
{ const {L,R}=render({tone:1,mode:'binaural',carrier:200,beat:10},3);
  ok('binaural: левое ухо carrier − beat/2 = 195 Гц',near(zc(L,.5,3),195,1),zc(L,.5,3));
  ok('binaural: правое ухо carrier + beat/2 = 205 Гц',near(zc(R,.5,3),205,1),zc(R,.5,3)); }
{ const {L,R}=render({tone:1,mode:'monaural',carrier:200,beat:10},2);
  ok('monaural: L = R',L.every((v,i)=>Math.abs(v-R[i])<1e-6));
  // огибающая биений: максимум каждые 0,1 с
  const win=Math.round(sr*.005), env=[]; for(let i=0;i+win<L.length;i+=win){ let m=0; for(let j=0;j<win;j++) m=Math.max(m,Math.abs(L[i+j])); env.push(m); }
  const lo=env.filter(v=>v<.05).length>5;
  ok('monaural: амплитуда биений проваливается в ноль',lo); }
{ const {L,R}=render({tone:1,mode:'isochronic',carrier:200,beat:5},3);
  ok('isochronic: L = R',L.every((v,i)=>Math.abs(v-R[i])<1e-6));
  const win=Math.round(sr*.01); let quiet=0, run=0, gaps=0;
  for(let i=sr;i+win<L.length;i+=win){ let m=0; for(let j=0;j<win;j++) m=Math.max(m,Math.abs(L[i+j])); if(m<.02){ run++; if(run===2) gaps++; } else run=0; }
  ok(`isochronic: тон пульсирует 5 раз в секунду (пауз за 2 с: ${gaps})`,gaps>=8 && gaps<=12,gaps); }
{ // смена beat плавная: нет скачка огибающей
  const S=K.nsgInit(sr,1), L=new Float32Array(4800), R=new Float32Array(4800); let worst=0, prev=0;
  for(let b=0;b<20;b++){ K.nsgRender(S,{vol:1,tone:1,mode:'binaural',carrier:b<10?200:300,beat:b<10?4:12},L,R,4800);
    for(let i=0;i<4800;i++){ worst=Math.max(worst,Math.abs(L[i]-prev)); prev=L[i]; } }
  ok('смена несущей — без щелчков (скачок < 0,1)',worst<.1,worst); }

// 7. пульсация подложки
{ const {L}=render({white:1,pulse:2,depth:1},3), win=Math.round(sr*.02); let mn=9, mx=0;
  for(let i=sr;i+win<L.length;i+=win){ const r=rms(L.subarray(i,i+win)); mn=Math.min(mn,r); mx=Math.max(mx,r); }
  ok(`pulse 2 Гц, depth 1: провал огибающей (${mn.toFixed(3)} … ${mx.toFixed(3)})`,mn<mx*.1 && mx>.1);
  const f=render({white:1,pulse:0},3); let a=9,b=0; for(let i=sr;i+win<f.L.length;i+=win){ const r=rms(f.L.subarray(i,i+win)); a=Math.min(a,r); b=Math.max(b,r); }
  ok('pulse 0: огибающая ровная',a>b*.6); }

// 8. сердце: 60 ударов в минуту → 60 «тук» в минуту; 120 → вдвое чаще
{ const beats=(bpm)=>{ const {L}=render({heart:1,bpm},10), win=Math.round(sr*.01); let n=0, armed=true;
    for(let i=0;i+win<L.length;i+=win){ let m=0; for(let j=0;j<win;j++) m=Math.max(m,Math.abs(L[i+j])); if(m>.15 && armed){ n++; armed=false; } else if(m<.02) armed=true; }
    return n; };
  const a=beats(60), b=beats(120);
  ok(`heart 60 bpm → ~10 ударов (или 20 «тук-тук») за 10 с (${a})`,a>=9 && a<=21,a);
  ok(`heart 120 bpm чаще, чем 60 (${b} > ${a})`,b>a); }

// 9. колокольчики: событие → звук, голоса ограничены, строй соблюдается
{ const {L,S}=render({chimes:1,rate:30,scale:'pentatonic',root:60},10);
  ok('chimes звучат',rms(L)>.01);
  ok('голосов не больше 10',S.voices.length<=10);
  const sil=render({chimes:1,rate:0},3); ok('chimes rate 0 → тишина',rms(sil.L)===0);
  // узкие полосы вокруг основных тонов (±3 Гц): ноты до-пентатоники слышны, фа и си — нет
  const x=render({chimes:1,rate:60,scale:'pentatonic',root:60},30).L, n=65536, acc=new Float64Array(n/2); let c=0;
  for(let o=sr;o+n<=x.length;o+=n){ const re=new Float64Array(n), im=new Float64Array(n); for(let i=0;i<n;i++) re[i]=x[o+i]*(.5-.5*Math.cos(2*Math.PI*i/n)); fft(re,im); for(let i=0;i<n/2;i++) acc[i]+=re[i]*re[i]+im[i]*im[i]; c++; }
  const band=f=>{ let m=0; for(let i=0;i<n/2;i++){ const fr=i*sr/n; if(Math.abs(fr-f)<3) m+=acc[i]; } return m/c; };
  const midi=m=>440*Math.pow(2,(m-69)/12), pc=(b,m)=>b(midi(m))+b(midi(m+12))+b(midi(m+24));      // сумма по трём октавам
  const inScale=[60,62,64,67,69].map(m=>pc(band,m)), outScale=[61,65,66,71].map(m=>pc(band,m));
  ok('пентатоника: ноты строя звучат, чужие (C#, F, F#, B) — нет',Math.min(...inScale)>8*Math.max(...outScale),inScale.concat(outScale).map(v=>v.toExponential(1)).join(' '));
  const mn=render({chimes:1,rate:60,scale:'minor pentatonic',root:60},30).L, acc2=new Float64Array(n/2); let c2=0;
  for(let o=sr;o+n<=mn.length;o+=n){ const re=new Float64Array(n), im=new Float64Array(n); for(let i=0;i<n;i++) re[i]=mn[o+i]*(.5-.5*Math.cos(2*Math.PI*i/n)); fft(re,im); for(let i=0;i<n/2;i++) acc2[i]+=re[i]*re[i]+im[i]*im[i]; c2++; }
  const b2=f=>{ let m=0; for(let i=0;i<n/2;i++){ const fr=i*sr/n; if(Math.abs(fr-f)<3) m+=acc2[i]; } return m/c2; };
  ok('минорная пентатоника: есть Eb (63), нет E (64)',pc(b2,63)>8*pc(b2,64));
}

// 10. дождь: больше капель — выше энергия в верхах; волны медленно дышат с периодом
{ const lo=render({rain:1,density:20},10), hi=render({rain:1,density:500},10);
  ok('rain: плотность 500 громче плотности 20 (шипение + капли)',rms(hi.L)>rms(lo.L)*.9);
  const {L}=render({waves:1,period:8},18), win=Math.round(sr*.5), e=[];
  for(let i=0;i+win<L.length;i+=win) e.push(rms(L.subarray(i,i+win)));
  const mean=e.reduce((s,v)=>s+v,0)/e.length, mx=Math.max(...e), mn=Math.min(...e);
  ok(`waves: громкость качается (макс/мин = ${(mx/mn).toFixed(1)})`,mx/mn>2);
  const w=render({wind:1},20), e2=[]; for(let i=0;i+win<w.L.length;i+=win) e2.push(rms(w.L.subarray(i,i+win)));
  ok('wind: порывы меняют громкость',Math.max(...e2)/Math.min(...e2)>1.5); }

console.log(bad?'FAILED':'all ok'); process.exit(bad?1:0);
