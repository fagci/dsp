// Ядро Zero-span (огибающая от времени, триггер, измерения импульсов): node tools/test-zerospan.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Number,Float32Array,Array,Infinity});
vm.runInContext(fs.readFileSync(path.join(root,'modules/zerospan-kernels.js'),'utf8')+';this.K={zsNew,zsPush,zsDecim,zsMeasure,zsFmtT,ZS_NW};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(a,b,t)=>Math.abs(a-b)<=t;

// синтетика: несущая на freq с амплитудой amp, пачки: период perUs, длительность onUs (включено в конце периода)
function gen(sr,freq,amp,perUs,onUs,N,t0=0){
  const re=new Float32Array(N), im=new Float32Array(N);
  for(let i=0;i<N;i++){
    const t=(t0+i)/sr, ph=2*Math.PI*freq*t, on=((t*1e6)%perUs)>=perUs-onUs ? 1 : 0;
    re[i]=amp*on*Math.cos(ph); im[i]=amp*on*Math.sin(ph);
  }
  return {re,im};
}
const SR=1e6, DT=4e-3/K.ZS_NW;
function runP(p,blocks,freq=100e3,amp=.1,per=1000,on=200){
  const st=K.zsNew(); let t0=0;
  for(let b=0;b<blocks;b++){ const g=gen(SR,freq,amp,per,on,4000,t0); t0+=4000; K.zsPush(st,g.re,g.im,p); }
  return st;
}
const P={sr:SR,off:100e3,rbw:50e3,sweepMs:4,mode:'rise',level:-40,tpos:.25,auto:false};

ok('decim: 4 ms sweep at 1 MS/s → 5 samples per point',K.zsDecim(1e6,4)===5,K.zsDecim(1e6,4));
ok('decim: never below 1',K.zsDecim(48000,.01)===1);
{
  const st=runP(P,6);
  ok('trigger: a frame is captured',st.frame && st.frame.length===K.ZS_NW && st.nTrig>0,st.nTrig);
  ok('trigger: the event stands at the pre-trigger position',st.trigIdx===Math.round(.25*K.ZS_NW),st.trigIdx);
  const m=K.zsMeasure(st.frame,DT,-40);
  ok('measure: peak level ≈ amplitude (0.1 → −20 dB)',near(m.peak,-20,1.5),m.peak);
  ok('measure: width ≈ 200 µs',near(m.width,200e-6,30e-6),m.width);
  ok('measure: period ≈ 1 ms',near(m.period,1e-3,60e-6),m.period);
  ok('measure: duty ≈ 0.2',near(m.duty,.2,.04),m.duty);
  ok('measure: rise time is positive and shorter than the pulse',m.rise>0 && m.rise<m.width,m.rise);
  ok('measure: off level well below the peak',m.min<m.peak-40,m.min+' '+m.peak);
}
{
  const st=runP({...P,off:400e3,rbw:5e3,mode:'free'},6);
  const m=K.zsMeasure(st.frame,DT);
  ok('selectivity: 300 kHz away the carrier is gone (> 40 dB below)',m.peak<-60,m.peak);
}
{
  const wide=K.zsMeasure(runP({...P,rbw:200e3},6).frame,DT,-40), narrow=K.zsMeasure(runP({...P,rbw:20e3},6).frame,DT,-40);
  ok('rbw: narrow filter → slower rise',narrow.rise>wide.rise*2,narrow.rise+' '+wide.rise);
}
{
  const st=runP({...P,mode:'fall'},6);
  ok('fall trigger: captures too',st.nTrig>0 && st.frame[st.trigIdx-3]>st.frame[st.trigIdx+3]);
  const lowLevel=runP({...P,level:10},6);
  ok('trigger: a level above the signal never fires',lowLevel.nTrig===0 && lowLevel.frame===null);
  const au=runP({...P,level:10,auto:true},6);
  ok('auto: no event → a free frame is shown',au.frame && au.trigIdx===-1);
  const fr=runP({...P,mode:'free'},4);
  ok('free: always a fresh frame',fr.frame && fr.nTrig===0);
}
{
  const st=K.zsNew(), g=gen(SR,100e3,.1,1000,1000,4000); for(let b=0;b<4;b++) K.zsPush(st,g.re,g.im,{...P,mode:'free'});
  const m=K.zsMeasure(st.frame,1e-5);
  ok('cw: no pulse measurements, level ≈ −20 dB',Number.isNaN(m.width) && near(m.mean,-20,1.5),m.mean+' '+m.width);
}
{
  const st=runP({...P,sweepMs:8},6); const n1=st.total;
  const g=gen(SR,100e3,.1,1000,200,4000); K.zsPush(st,g.re,g.im,{...P,sweepMs:4});
  ok('params: a changed sweep resets the ring',st.total<n1);
}
ok('fmt: units',K.zsFmtT(.0015)==='1.50 ms' && K.zsFmtT(200e-6)==='200 µs' && K.zsFmtT(3e-7)==='300 ns',K.zsFmtT(3e-7));
console.log(bad?'FAILED '+bad:'all ok'); process.exit(bad?1:0);
