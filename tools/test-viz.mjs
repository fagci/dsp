// Ядро визуализаторов: node tools/test-viz.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,Float64Array,Array});
vm.runInContext(fs.readFileSync(path.join(root,'modules/viz-kernels.js'),'utf8')+
  ';this.K={vzEdges,vzGroup,vzNorm,vzFollow,vzBeatNew,vzBeat,vzHsl,vzColor};',ctx);
const K=ctx.K;
let bad=0;
const ok=(n,c)=>{ if(!c){ bad++; console.log('FAIL',n); } else console.log('ok  ',n); };
const near=(n,a,b,e=1e-6)=>ok(n+' ('+a+' ≈ '+b+')',Math.abs(a-b)<=e);

// границы: концы на месте, лог-шаг постоянен, mel и linear монотонны
let e=K.vzEdges(8,50,6400,'log');
near('log: first edge',e[0],50,1e-6); near('log: last edge',e[8],6400,1e-6);
near('log: equal ratio',e[1]/e[0],e[8]/e[7],1e-9); near('log: 3 octaves in 8 bands→ one octave per ~1.33',e[8]/e[0],128,1e-6);
e=K.vzEdges(10,100,8000,'mel'); ok('mel: monotonic',e.every((v,i)=>i===0||v>e[i-1]));
e=K.vzEdges(4,0,1000,'linear'); near('linear: step',e[2]-e[1],e[1]-e[0],1e-9); ok('fmin clamped to ≥1',e[0]>=1);

// синус в бине: нужная полоса получает энергию, соседняя — нет
const N=1024, sr=48000, hz=sr/N, mag=new Float32Array(N/2); mag[Math.round(1000/hz)]=1;
e=K.vzEdges(16,40,16000,'log'); let out=new Float32Array(16); K.vzGroup(mag,hz,e,out,0);
const k=out.indexOf(Math.max(...out));
ok('tone 1 kHz lands in its band',e[k]<=1000&&1000<e[k+1]);
near('tone amplitude 1 → ≈0 dB',out[k],0,0.5);
ok('other bands are quiet',out.every((v,i)=>i===k||v<-100));

// узкая полоса ниже бина — интерполяция, не провал
const m2=new Float32Array(N/2).fill(0.1); out=new Float32Array(4);
K.vzGroup(m2,hz,K.vzEdges(4,20,40,'log'),out,0); near('sub-bin band: flat spectrum gives bin level',out[0],-20,0.5);
// наклон: +3 дБ/окт. на 4 кГц = +6 дБ против 1 кГц
const a=new Float32Array(1), b=new Float32Array(1), m3=new Float32Array(N/2).fill(0.01);
K.vzGroup(m3,hz,Float64Array.from([900,1100]),a,0); K.vzGroup(m3,hz,Float64Array.from([900,1100]),b,3);
near('tilt 0 at 1 kHz',b[0]-a[0],0,0.2);
const c=new Float32Array(1), d=new Float32Array(1); K.vzGroup(m3,hz,Float64Array.from([3600,4400]),c,0); K.vzGroup(m3,hz,Float64Array.from([3600,4400]),d,3);
near('tilt 3 dB/oct at 4 kHz = +6 dB',d[0]-c[0],6,0.2);

near('norm mid',K.vzNorm(-30,-60,0),.5); near('norm clamp lo',K.vzNorm(-90,-60,0),0); near('norm clamp hi',K.vzNorm(9,-60,0),1);
near('follow: instant attack',K.vzFollow(0,1,0,.3,.01),1); ok('follow: slow release',K.vzFollow(1,0,0,.3,.01)>.9);

// бит: 120 BPM, удар каждые 0.5 с на фоне тихого шума
const st=K.vzBeatNew(), dt=512/48000; let hits=[], t=0;
for(let i=0;i<Math.round(8/dt);i++){ t=i*dt; const ph=(t%0.5); const en=ph<0.05?1:0.05;
  if(K.vzBeat(st,en,dt,1.5,.18)) hits.push(t); }
ok('beat: ~16 hits in 8 s ('+hits.length+')',hits.length>=14&&hits.length<=17);
near('beat: tempo 120 BPM',st.bpm,120,3);
const st2=K.vzBeatNew(); let n2=0; for(let i=0;i<500;i++) if(K.vzBeat(st2,0.3,dt,1.5,.18)) n2++;
ok('beat: constant level gives no hits ('+n2+')',n2<=1);
ok('hsl wraps hue',K.vzHsl(-60,90,50)===K.vzHsl(300,90,50)); ok('colour mode theme → null',K.vzColor('theme',0,0)===null);
if(bad){ console.log(bad+' FAILED'); process.exit(1); } console.log('all ok');
