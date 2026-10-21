// Activity Events: занятость каналов → события (modules/activity-kernels.js)
import fs from 'fs'; import path from 'path'; import vm from 'vm';
const root=new URL('../',import.meta.url).pathname;
const ctx={}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root,'modules/activity-kernels.js'),'utf8')+';this.k={actNew,actStep,actActive};',ctx);
const {actNew,actStep,actActive}=ctx.k; let bad=0;
const ok=(n,c)=>{ console.log((c?'ok   ':'FAIL ')+n); if(!c) bad++; };
const O={thr:8,hys:3,hold:100,minDur:20,learn:1000,rise:1};

// 3 канала, кадр раз в 10 мс; ch1: передача 2000..2300 мс с дырой 2100..2150 (короче hold), ch2: 3000..3010 (короче minDur), ch0 тихий
const st=actNew(), ev=[]; let seen0=false;
for(let t=0;t<=4000;t+=10){
  const on1=(t>=2000 && t<2100) || (t>=2150 && t<2300), on2=t>=3000 && t<3010;
  const lv=[-90+Math.sin(t)*.5, on1 ? -60 : -90, on2 ? -55 : -91];
  if(t===2500) ok('active count 0 between events',actActive(st)===0);
  ev.push(...actStep(st,lv,t,O));
}
const e1=ev.filter(e=>e.ch===1);
ok('one event on ch1, the gap shorter than hold is bridged',e1.length===1);
ok('start and duration (2000…2300 + a frame)',e1[0].t0===2000 && Math.abs(e1[0].dur-(290+10))<3);
ok('peak and snr',e1[0].peak===-60 && Math.abs(e1[0].snr-30)<.01);
ok('too short event dropped',!ev.some(e=>e.ch===2));
ok('quiet channel gives nothing',!ev.some(e=>e.ch===0));

const s2=actNew(), a=[]; for(let t=0;t<=1500;t+=10) a.push(...actStep(s2,[-60],t,O));
ok('busy during learning does not fire, and is not an event later',a.length===0);
const s3=actNew(); for(let t=0;t<=1200;t+=10) actStep(s3,[-90],t,O);
actStep(s3,[-70],1300,O); ok('active while above',actActive(s3)===1);
ok('unobserved channel (null) keeps its state',actStep(s3,[null],1500,O).length===0 && actActive(s3)===1);
const r=actStep(s3,[-90],1700,O); ok('closes on a later observation, end = last busy frame',r.length===1 && r[0].t0===1300 && r[0].dur<70);
const s4=actNew(); for(let t=0;t<=1200;t+=10) actStep(s4,[-90],t,O);
let n=0; for(let t=1210;t<=60000;t+=100) n+=actStep(s4,[-88],t,O).length;
ok('slow drift of the level up is followed by the floor (no false events)',n===0);
if(bad){ console.log(bad+' failed'); process.exit(1); } console.log('all ok');
