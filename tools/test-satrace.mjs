// Ядро трасс, RBW, детекторов, измерений и CSV Spectrum Analyzer: node tools/test-satrace.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,Float64Array,Object,String,Number,Array});
vm.runInContext(fs.readFileSync(path.join(root,'modules/sa-trace-kernels.js'),'utf8')+
  ';this.K={saRbwMerge,saDetect,saTraceStep,saTraceArr,saChanPower,saObw,saXdbBw,saNoiseDensity,saAcpr,saTraceCsv,saRefParse,saRefResample};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const db=x=>20*Math.log10(x+1e-12), near=(a,b,e=.05)=>Math.abs(a-b)<=e;

// RBW: тон не меняется, шум растёт на 10·lg(k)
{
  const N=1024, m=new Float32Array(N).fill(.01); m[500]=1; m[499]=.5; m[501]=.5;
  const o=new Float32Array(N); K.saRbwMerge(m,o,8,1.5);
  ok('rbw: tone peak not below native',o[500]>=1-1e-6,o[500]);
  ok('rbw: noise +10lg(k)/ENBW',near(db(o[100])-db(m[100]),10*Math.log10(8/1.5),.1),db(o[100])-db(m[100]));
  const o1=new Float32Array(N); K.saRbwMerge(m,o1,1,1.5);
  ok('rbw: k=1 is a copy',o1[500]===m[500] && o1[7]===m[7]);
  ok('rbw: edge bins finite',Number.isFinite(o[0]) && Number.isFinite(o[N-1]) && o[0]>=m[0]);
}
// детекторы
{
  const a=Float32Array.from([1,2,3,4,5,6,7,8,9,10]);
  ok('det: peak',K.saDetect(a,10,1,8,'peak')===9);
  ok('det: negpeak',K.saDetect(a,10,1,8,'negpeak')===2);
  ok('det: sample (centre)',K.saDetect(a,10,1,8,'sample')===5 || K.saDetect(a,10,1,8,'sample')===6);
  ok('det: average',near(K.saDetect(a,10,1,8,'average'),5.5,1e-6) || near(K.saDetect(a,10,1,8,'average'),5.5,.01),K.saDetect(a,10,1,8,'average'));
  ok('det: rms ≥ average',K.saDetect(a,10,1,8,'rms')>=K.saDetect(a,10,1,8,'average'));
  ok('det: auto = peak with many bins',K.saDetect(a,10,1,8,'auto')===9);
  ok('det: < 1 bin interpolates',near(K.saDetect(a,10,2.2,2.8,'rms'),a[2]+(a[3]-a[2])*.5,1e-5));
}
// трассы
{
  const N=8, mk=v=>new Float32Array(N).fill(v), tr={mode:'off',arr:null,pw:null,cnt:0,key:null};
  K.saTraceStep(tr,mk(1),'max hold',4,'k'); K.saTraceStep(tr,mk(3),'max hold',4,'k'); const mx=K.saTraceStep(tr,mk(2),'max hold',4,'k');
  ok('trace: max hold',mx[0]===3);
  const t2={mode:'off',arr:null,pw:null,cnt:0,key:null};
  K.saTraceStep(t2,mk(3),'min hold',4,'k'); const mn=K.saTraceStep(t2,mk(1),'min hold',4,'k');
  ok('trace: min hold',mn[0]===1);
  const t3={mode:'off',arr:null,pw:null,cnt:0,key:null}; let av;
  for(let i=0;i<4;i++) av=K.saTraceStep(t3,mk(i%2 ? 3 : 1),'average',4,'k');
  ok('trace: average is a power mean (sqrt((1+9+1+9)/4)=2.236)',near(av[0],Math.sqrt(5),1e-4),av[0]);
  const t4={mode:'off',arr:null,pw:null,cnt:0,key:null};
  K.saTraceStep(t4,mk(5),'average',3,'k'); K.saTraceStep(t4,mk(5),'average',3,'k');
  for(let i=0;i<30;i++) av=K.saTraceStep(t4,mk(1),'average',3,'k');
  ok('trace: average forgets (window 3)',av[0]<1.05,av[0]);
  const t5={mode:'off',arr:null,pw:null,cnt:0,key:null};
  K.saTraceStep(t5,mk(2),'max hold',4,'k'); K.saTraceStep(t5,mk(5),'max hold',4,'k');
  K.saTraceStep(t5,mk(9),'view',4,'k'); const vw=K.saTraceStep(t5,mk(7),'view',4,'k');
  ok('trace: view freezes what max hold held',vw[0]===5,vw[0]);
  const t6={mode:'off',arr:null,pw:null,cnt:0,key:null};
  K.saTraceStep(t6,mk(2),'live',4,'k'); const frz=K.saTraceStep(t6,mk(4),'view',4,'k');
  ok('trace: view from live takes the next frame',frz[0]===4,frz[0]);
  ok('trace: live has no stored array',K.saTraceArr({mode:'live'},mk(6))[0]===6 && K.saTraceArr({mode:'off'},mk(6))===null);
  const t7={mode:'off',arr:null,pw:null,cnt:0,key:null};
  K.saTraceStep(t7,mk(9),'max hold',4,'a'); const rs=K.saTraceStep(t7,mk(1),'max hold',4,'b');
  ok('trace: axis change resets',rs[0]===1);
  const t8={mode:'off',arr:null,pw:null,cnt:0,key:null};
  K.saTraceStep(t8,mk(2),'max hold',4,'k'); const sz=K.saTraceStep(t8,new Float32Array(16).fill(1),'max hold',4,'k');
  ok('trace: size change resets',sz.length===16 && sz[0]===1);
}
// измерения
{
  const N=200, m=new Float32Array(N).fill(.001);
  for(let i=90;i<=110;i++) m[i]=Math.exp(-((i-100)**2)/50);        // «сигнал» ~ гауссиан
  const p=K.saChanPower(m,80,120,1.5), pn=K.saChanPower(m,0,40,1.5);
  ok('chp: signal ≫ noise',p-pn>30,p-pn);
  ok('chp: sums power',near(K.saChanPower(new Float32Array(10).fill(1),0,9,1),10,1e-6) );
  const o=K.saObw(m,60,140,99);
  ok('obw: centred on the signal',o && near((o.lo+o.hi)/2,100,1.5),JSON.stringify(o));
  const o90=K.saObw(m,60,140,90);
  ok('obw: 90% is narrower than 99%',o90.hi-o90.lo<o.hi-o.lo);
  const x=K.saXdbBw(m,100,60,140,6);
  ok('xdb: 6 dB width of a gaussian',x && !x.openLo && !x.openHi && near(x.hi-x.lo,2*Math.sqrt(-50*Math.log(.5)),.6),JSON.stringify(x));
  const xo=K.saXdbBw(new Float32Array(50).fill(1),25,10,40,3);
  ok('xdb: flat signal is open on both sides',xo.openLo && xo.openHi);
  ok('noise density: 10lg(P/(binHz·ENBW))',near(K.saNoiseDensity(new Float32Array(10).fill(.1),0,9,100,1.5),10*Math.log10(.01/150),1e-4));
  const m2=new Float32Array(300).fill(.001); for(let i=95;i<=105;i++) m2[i]=1; for(let i=115;i<=125;i++) m2[i]=.1;
  const ac=K.saAcpr(m2,[95,105],[75,85],[115,125],1.5);
  ok('acpr: upper −20 dBc, lower very low',near(ac.up,-20,.1) && ac.low<-50,JSON.stringify(ac));
}
// CSV и эталон
{
  const N=4, a=Float32Array.from([1,.1,.01,.001]);
  const t=K.saTraceCsv(N,i=>100e6+i*1000,[{name:'T1_db',arr:a},{name:'T2_db',arr:null}]);
  const L=t.trim().split('\n');
  ok('csv: header skips an empty trace',L[0]==='freq_hz,T1_db' && L.length===5,L[0]);
  ok('csv: levels in dB',L[1]==='100000000,0' && L[2]==='100001000,-20',L[1]+' '+L[2]);
  ok('csv: calibration offset is added to every level',K.saTraceCsv(2,i=>i,[{name:'a',arr:Float32Array.from([1,.1])}],-30).includes('0,-30') && K.saTraceCsv(2,i=>i,[{name:'a',arr:Float32Array.from([1,.1])}],-30).includes('1,-50'));
  const ref=K.saRefParse(t);
  ok('ref: parsed back, header skipped',ref && ref.f.length===4 && near(ref.db[1],-20,.01));
  const rs=K.saRefResample(ref,i=>100e6+i*500,8);
  ok('ref: resample interpolates in dB',near(db(rs[1]),-10,.05) && near(db(rs[2]),-20,.05),db(rs[1])+' '+db(rs[2]));
  ok('ref: outside coverage is −200 dB',db(rs[7])>-200 && db(K.saRefResample(ref,i=>50e6,1)[0])<-190);
  ok('ref: garbage → null',K.saRefParse('hello\nworld')===null);
  ok('ref: sorted by frequency',K.saRefParse('200,-10\n100,-20').f[0]===100);
}
console.log(bad?'FAILED '+bad:'all ok'); process.exit(bad?1:0);
