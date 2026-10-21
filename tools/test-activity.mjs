// Activity Events: занятость каналов → события (modules/activity-kernels.js)
import fs from 'fs'; import path from 'path'; import vm from 'vm';
const root=new URL('../',import.meta.url).pathname;
const ctx={}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root,'modules/activity-kernels.js'),'utf8')+';this.k={actNew,actStep,actActive};',ctx);
const {actNew,actStep,actActive}=ctx.k; let bad=0;
const ok=(n,c)=>{ console.log((c?'ok   ':'FAIL ')+n); if(!c) bad++; };
const O={thr:6,hys:2,hold:100,minDur:20,learn:1000,rise:3,avg:40,common:true};
let seed=5; const rnd=()=>(seed=(seed*1664525+1013904223)>>>0)/4294967296, noise=()=>(rnd()+rnd()+rnd()+rnd()-2)*1.7;   // σ ≈ 1 дБ ×1.7
// 16 каналов, кадр 10 мс. f(t,k) — добавка к уровню −90 дБ
function run(T,f,o=O,N=16){
  const st=actNew(), ev=[];
  for(let t=0;t<=T;t+=10){ const lv=[]; for(let k=0;k<N;k++) lv.push(-90+f(t,k)+noise()); ev.push(...actStep(st,lv,t,o)); }
  return {st,ev};
}

let r=run(60000,()=>0);
ok('noise only for 60 s: no events',r.ev.length===0);

r=run(8000,(t,k)=>k===3 && t>=3000 && t<5000 ? 8 : 0);
ok('a weak signal (+8 dB, noise σ≈1.7 dB) is one event',r.ev.length===1 && r.ev[0].ch===3 && Math.abs(r.ev[0].t0-3000)<80 && Math.abs(r.ev[0].dur-2000)<150);
ok('its level and snr',Math.abs(r.ev[0].snr-8)<3 && r.ev[0].peak>-86);

r=run(40000,(t,k)=>k===5 && t>=5000 && t<30000 ? 7 : 0);
ok('a weak signal that lasts 25 s is not absorbed by the floor',r.ev.length===1 && r.ev[0].dur>24000);

r=run(20000,(t,k)=>t>=6000 && t<14000 ? 12 : 0);
ok('band-wide shelf step (+12 dB on all channels, AGC) gives no events',r.ev.length===0);
r=run(20000,(t,k)=>t>=6000 ? -15 : 0);
ok('shelf drop is no event either, and a signal after it is seen',r.ev.length===0);
r=run(20000,(t,k)=>(t>=6000 ? -15 : 0)+(k===2 && t>=12000 && t<13000 ? 9 : 0));
ok('… a signal after the shelf change is seen',r.ev.length===1 && r.ev[0].ch===2);
r=run(20000,(t,k)=>t>=6000 && t<14000 ? 12 : 0,{...O,common:false});
ok('without the common level the shelf does fire (the option matters)',r.ev.length>0);

r=run(12000,(t,k)=>(k===1 && t>=3000 && t<4000 ? 25 : 0)+(k===9 && t>=3500 && t<4500 ? 25 : 0)+(k===12 && t>=3200 && t<4200 ? 25 : 0));
ok('several strong channels at once do not hide each other',r.ev.length===3);

r=run(12000,(t,k)=>(t>=3000 && t<3100) || (t>=3150 && t<3300) ? (k===4 ? 20 : 0) : 0);
ok('a gap shorter than hold is bridged; start and length',r.ev.length===1 && Math.abs(r.ev[0].dur-310)<40);
r=run(12000,(t,k)=>k===4 && t>=3000 && t<3010 ? 20 : 0);
ok('too short event dropped',r.ev.length===0);

const s2=actNew(), a=[]; for(let t=0;t<=1500;t+=10) a.push(...actStep(s2,[-60],t,O));
ok('busy during learning does not fire',a.length===0);
const s3=actNew(); for(let t=0;t<=1200;t+=10) actStep(s3,[-90],t,{...O,common:false});
actStep(s3,[-70],1300,{...O,common:false}); ok('active while above',actActive(s3)===1);
ok('unobserved channel (null) keeps its state',actStep(s3,[null],1500,O).length===0 && actActive(s3)===1);
const rr=actStep(s3,[-90],1700,{...O,common:false}); ok('closes on a later observation, end = last busy frame',rr.length===1 && rr[0].t0===1300 && rr[0].dur<70);
const s4=actNew(); for(let t=0;t<=1200;t+=10) actStep(s4,[-90],t,{...O,common:false});
let n=0; for(let t=1210;t<=60000;t+=100) n+=actStep(s4,[-88-t/30000],t,{...O,common:false}).length;
ok('slow drift of one channel (3 dB in a minute) is followed',n===0);
if(bad){ console.log(bad+' failed'); process.exit(1); } console.log('all ok');
