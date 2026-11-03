// Ядро Echo Ranger: node tools/test-echorange.mjs
// Известные решения: пик корреляции чирпа с собой, расстояния до эхо по синтетической записи, шум, разрешение, скорость звука.
import vm from 'node:vm'; import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,Float64Array,Array,Number,String,isFinite});
vm.runInContext(fs.readFileSync(path.join(root,'modules/echorange-kernels.js'),'utf8')+';this.K={erSpeed,erChirp,erFFT,erEnvelope,erAlign,erPeaks,erPick,erSimulate,erParseSim};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b+' (±'+e+')');
const sr=48000, c=343, burst=K.erChirp(sr,2000,10000,.03);
near('speed of sound at 20 °C',K.erSpeed(20),343.42,.01); near('speed of sound at 0 °C',K.erSpeed(0),331.3,1e-9);
near('chirp length 30 ms',burst.length,1440,0); ok('chirp amplitude ≤ 1, tapers to ~0 at the edges',Math.max(...burst)<=1 && Math.abs(burst[0])<1e-6);
// БПФ: прямое и обратное
{ const N=64, re=new Float64Array(N), im=new Float64Array(N); for(let i=0;i<N;i++) re[i]=Math.sin(2*Math.PI*5*i/N); const a=Float64Array.from(re); K.erFFT(re,im,false);
  ok('fft: a sine of 5 cycles peaks in bin 5',Math.abs(Math.hypot(re[5],im[5])-N/2)<1e-9); K.erFFT(re,im,true); let e=0; for(let i=0;i<N;i++) e=Math.max(e,Math.abs(re[i]-a[i])); ok('fft: the inverse restores the signal',e<1e-9); }
// прямой путь и одно эхо
const len=Math.round(.35*sr), lat=Math.round(.12*sr);
function range(echoes,noise,seed){
  const mic=K.erSimulate(burst,sr,c,len,lat,echoes,noise,seed), env=K.erEnvelope(mic,burst), al=K.erAlign(env,Math.round(.08*sr));
  return {al,peaks:K.erPeaks(al.env,{sr,c,minDist:.3,thrDb:40,bw:8000})};
}
let r=range([[2.5,.3]],0);
near('the strongest peak is the direct path, found at the simulated latency',r.al.directIdx,lat,1);
ok('one echo found',r.peaks.length===1,JSON.stringify(r.peaks)); near('echo at 2.5 m',r.peaks[0].dist,2.5,.01);
near('echo level: −10.5 dB for amplitude 0.3',r.peaks[0].db,20*Math.log10(.3),.5);
// два эхо
r=range([[1.2,.5],[4.0,.2]],0); ok('two echoes',r.peaks.length===2,JSON.stringify(r.peaks.map(p=>p.dist)));
near('nearest at 1.2 m',r.peaks[0].dist,1.2,.01); near('second at 4.0 m',r.peaks[1].dist,4.0,.01);
ok('pick first / strongest',K.erPick(r.peaks,'first').dist<2 && K.erPick(r.peaks,'strongest').dist<2 && K.erPick([],'first')===null);
// разрешение: два отражателя в 5 см (полоса 8 кГц → 2 см)
r=range([[2.0,.4],[2.05,.4]],0); ok('resolution: two reflectors 5 cm apart are two peaks',r.peaks.length===2,JSON.stringify(r.peaks.map(p=>+p.dist.toFixed(3))));
// шум: эхо на 20 дБ ниже прямого при шуме сравнимом с эхо
r=range([[3.0,.1]],.05,7); ok('echo −20 dB under noise of 0.05 rms is still found at 3.0 m',r.peaks.length>=1 && Math.abs(r.peaks[0].dist-3.0)<.02,JSON.stringify(r.peaks.map(p=>[+p.dist.toFixed(3),+p.db.toFixed(1)])));
// только шум: ложных пиков нет
r=range([],.05,3); ok('noise only: no echoes reported',r.peaks.length===0,JSON.stringify(r.peaks.map(p=>[+p.dist.toFixed(2),+p.db.toFixed(1)])));
// слишком близко: меньше minDist не считаем
r=range([[.15,.4]],0); ok('closer than minDist (0.3 m) is ignored (sidelobes of the direct path)',r.peaks.length===0,JSON.stringify(r.peaks));
// температура меняет оценку
{ const mic=K.erSimulate(burst,sr,K.erSpeed(30),len,lat,[[2.5,.3]],0), al=K.erAlign(K.erEnvelope(mic,burst),Math.round(.08*sr));
  const cold=K.erPeaks(al.env,{sr,c:K.erSpeed(0),minDist:.3,bw:8000})[0].dist, warm=K.erPeaks(al.env,{sr,c:K.erSpeed(30),minDist:.3,bw:8000})[0].dist;
  near('the right temperature gives the right distance',warm,2.5,.01); ok('the wrong one is ≈ 5 % off (0 vs 30 °C)',Math.abs(cold-2.5)>.1); }
ok('simulate text',JSON.stringify(K.erParseSim('2.5:0.4, 4.1:0.2;x'))==='[[2.5,0.4],[4.1,0.2]]');
console.log(bad?('\n'+bad+' FAILED'):'\nall ok'); process.exit(bad?1:0);
