// Ядро наведения антенны: node tools/test-antpeak.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Number,Array,Float32Array});
vm.runInContext(fs.readFileSync(path.join(root,'modules/antpeak-kernels.js'),'utf8')+';this.K={apLevel,apInit,apReset,apFeed,apDelta,apTone,apScale};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(a,b,e=1e-6)=>Math.abs(a-b)<e;
const P={fastS:.3,slowS:4,decay:0};

// уровень: несущая 40 дБ над полкой
const mag=new Float32Array(64).fill(1e-3); mag[30]=1e-1;
ok('level peak: 40 dB over the floor',near(K.apLevel(mag,25,35,-60,'peak'),40,1e-3),K.apLevel(mag,25,35,-60,'peak'));
ok('level peak: empty window → NaN',Number.isNaN(K.apLevel(mag,5,4,-60,'peak')));
// полоса из 4 бинов по 1e-1: 4·1e-2 против 4·1e-6 → 40 дБ
const m2=new Float32Array(64).fill(1e-3); for(let i=10;i<14;i++) m2[i]=1e-1;
ok('level band: power over noise in the same bins',near(K.apLevel(m2,10,13,-60,'band'),40,1e-3),K.apLevel(m2,10,13,-60,'band'));

// сглаживание и пик-холд
let st=K.apInit();
K.apFeed(st,10,0,P);
ok('first frame seeds all',st.fast===10 && st.slow===10 && st.best===10 && st.n===1);
for(let i=0;i<100;i++) K.apFeed(st,20,.05,P);
ok('fast converges in ~1 s',near(st.fast,20,.01),st.fast);
ok('slow lags behind',st.slow>10 && st.slow<20,st.slow);
ok('best follows the level up',near(st.best,st.fast));
const b0=st.best;
for(let i=0;i<40;i++) K.apFeed(st,12,.05,P);
ok('best holds when the level drops',st.best===b0);
ok('delta (best) < 0 after a drop',K.apDelta(st,'best')<-5,K.apDelta(st,'best'));
for(let i=0;i<100;i++) K.apFeed(st,12,.05,P);
ok('delta (trend) → 0 when standing still',Math.abs(K.apDelta(st,'trend'))<1,K.apDelta(st,'trend'));
K.apFeed(st,30,.1,P);
ok('delta (trend) > 0 when it gets better',K.apDelta(st,'trend')>0);

// затухание лучшего: 0.1 дБ/с (6 дБ/мин) → за 10 с минус 1 дБ
st=K.apInit(); K.apFeed(st,20,0,{...P,decay:.1});
for(let i=0;i<100;i++) K.apFeed(st,0,.1,{...P,decay:.1,fastS:0});
ok('best fades by decay',near(st.best,19,.2),st.best);
ok('NaN frame is ignored',(()=>{ const s=K.apInit(); K.apFeed(s,5,0,P); K.apFeed(s,NaN,.1,P); return s.fast===5 && s.n===1; })());
ok('reset empties',(()=>{ const s=K.apInit(); K.apFeed(s,5,0,P); K.apReset(s); return s.n===0 && Number.isNaN(K.apDelta(s,'best')); })());

// тон
const T={fMin:250,fMax:1500,range:10,dead:.3};
ok('tone best: at the best → fMax',near(K.apTone(0,'best',T),1500,1e-6));
ok('tone best: inside the dead zone → fMax',near(K.apTone(-.3,'best',T),1500,1e-6));
ok('tone best: range dB below → fMin',near(K.apTone(-10.3,'best',T),250,1e-6),K.apTone(-10.3,'best',T));
ok('tone best: monotonic',K.apTone(-1,'best',T)>K.apTone(-3,'best',T) && K.apTone(-3,'best',T)>K.apTone(-8,'best',T));
ok('tone best: far below is clamped',near(K.apTone(-50,'best',T),250));
const mid=250*Math.pow(6,.5);
ok('tone trend: standing → the middle',near(K.apTone(0,'trend',T),mid,1e-6) && near(K.apTone(.2,'trend',T),mid,1e-6));
ok('tone trend: better is higher, worse is lower',K.apTone(3,'trend',T)>mid && K.apTone(-3,'trend',T)<mid);
ok('tone: NaN delta → NaN',Number.isNaN(K.apTone(NaN,'best',T)));

// окно бара
st=K.apInit(); K.apFeed(st,20,0,P);
const [lo,hi]=K.apScale(st,12);
ok('scale: best is inside, 12 dB wide',near(hi-lo,12) && st.best<hi && st.best>lo,lo+' '+hi);

console.log(bad ? bad+' FAIL' : 'all ok'); process.exit(bad?1:0);
