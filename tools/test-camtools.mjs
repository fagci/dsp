// Камера: движение, пульс, таймлапс, цвет и спектрометр: node tools/test-camtools.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Array,Object,Date,Uint8Array,Uint8ClampedArray,Uint16Array,Uint32Array,Float32Array,Float64Array,DataView,ArrayBuffer,TextEncoder});
const src=f=>fs.readFileSync(path.join(root,f),'utf8');
vm.runInContext(src('modules/camtools-kernels.js')+
  ';this.T={mvGray,mvStep,mvGate,ppgResample,ppgBox,ppgBand,ppgSpectrum,ppgBeats,ppgRmssd,ppgFinger,ppgAnalyze,tlDue,tlGains,tlLength,zipCrc,zipStore,colXYZ,colCCT,colHSV,colHex,colName,colMean,specProfile,specNm,specX,specClean,specPeaks,wlRGB,specFit,specMatchRef,SPEC_REF};',ctx);
const T=ctx.T;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };
const near=(a,b,e)=>Math.abs(a-b)<=e;
const img=(w,h,f)=>{ const d=new Uint8ClampedArray(w*h*4); for(let y=0;y<h;y++) for(let x=0;x<w;x++){ const [r,g,b]=f(x,y); const i=(y*w+x)*4; d[i]=r; d[i+1]=g; d[i+2]=b; d[i+3]=255; } return {width:w,height:h,data:d}; };

/* ---- движение ---- */
{
  const W=16,H=12, o={w:W,h:H,pix:20,mode:'prev',rate:.05}, st={};
  const flat=T.mvGray(img(64,48,()=>[100,100,100]),W,H);
  ok('gray size and value',flat.length===W*H && flat.every(v=>v>=99&&v<=100),flat[0]);
  const r0=T.mvStep(st,flat,o);
  ok('first frame has nothing to compare',r0.motion===0 && r0.area===0);
  const r1=T.mvStep(st,flat,o);
  ok('still scene → no motion',r1.motion===0 && r1.level===0);
  const moved=Uint8Array.from(flat); for(let y=0;y<6;y++) for(let x=12;x<16;x++) moved[y*W+x]=220;
  const r2=T.mvStep(st,moved,o);
  ok('block moved → share of changed pixels',near(r2.motion,24/(W*H),1e-9),r2.motion);
  ok('centre of motion in the top right',r2.cx>.8 && r2.cy<.4,r2.cx+' '+r2.cy);
  const r3=T.mvStep(st,moved,o);
  ok('prev mode: the next still frame is quiet again',r3.motion===0);
  // фон: в режиме avg неподвижный предмет постепенно «растворяется»
  const sa={}, oa={w:W,h:H,pix:20,mode:'avg',rate:.5};
  T.mvStep(sa,flat,oa);
  let first=T.mvStep(sa,moved,oa).motion, last=first;
  for(let i=0;i<10;i++) last=T.mvStep(sa,moved,oa).motion;
  ok('avg mode: stationary object fades into background',first>0 && last===0,first+' → '+last);
  const small=Uint8Array.from(flat); small[0]=flat[0]+10;
  ok('noise below the pixel threshold is ignored',T.mvStep({bg:Float32Array.from(flat),primed:5},small,o).motion===0);
  // зона
  const z=T.mvGray(img(64,48,(x,y)=>x<32?[0,0,0]:[255,255,255]),W,H,[.5,0,.5,1]);
  ok('zone crops the picture',z.every(v=>v>=254));
  // триггер
  const g={}; let q;
  q=T.mvGate(g,.001,0,.02,2); ok('gate quiet',q.on===0 && !q.rise);
  q=T.mvGate(g,.05,1,.02,2); ok('gate rises once',q.on===1 && q.rise);
  q=T.mvGate(g,.05,1.5,.02,2); ok('gate stays without a new rise',q.on===1 && !q.rise);
  q=T.mvGate(g,0,3,.02,2); ok('gate holds after motion stops',q.on===1);
  q=T.mvGate(g,0,3.6,.02,2); ok('gate releases after hold',q.on===0);
  q=T.mvGate(g,.05,4,.02,2); ok('gate rises again',q.rise);
}

/* ---- пульс ---- */
{
  const mk=(bpm,sec,fps,noise,jit)=>{ const ts=[],v=[]; let s=1;
    const rnd=()=>{ s=(s*1103515245+12345)&0x7fffffff; return s/0x7fffffff-.5; };
    for(let i=0;i<sec*fps;i++){ const t=i/fps+(jit?rnd()*jit/fps:0); ts.push(t);
      const ph=2*Math.PI*bpm/60*t;
      v.push(.5+.01*(Math.sin(ph)+.3*Math.sin(2*ph-.8))+.0005*t+noise*rnd()); }   // пульс + медленный дрейф + шум
    return {ts,v}; };
  for(const bpm of [55,72,100,140]){
    const {ts,v}=mk(bpm,12,30,.004,.6);
    const r=T.ppgAnalyze(ts,[{name:'g',v}],{win:10});
    ok('bpm '+bpm,r && near(r.bpm,bpm,2.5) && r.conf>.4,r&&(r.bpm.toFixed(1)+' conf '+r.conf.toFixed(2)));
  }
  const {ts,v}=mk(72,12,30,.004,.6), r=T.ppgAnalyze(ts,[{name:'g',v}],{win:10});
  ok('beats found at the pulse rate',r.beats.length>=10 && r.beats.length<=14,r.beats.length);
  const ibi=r.beats.slice(1).map((b,i)=>b-r.beats[i]);
  ok('beat intervals near 0.83 s',ibi.every(d=>near(d,60/72,.1)),ibi.map(d=>d.toFixed(2)).join(' '));
  ok('steady pulse → small variability',r.rmssd<60,r.rmssd.toFixed(0));
  // шум без пульса — уверенность низкая
  let s=7; const rnd=()=>{ s=(s*1103515245+12345)&0x7fffffff; return s/0x7fffffff-.5; };
  const nz={ts:Array.from({length:300},(_,i)=>i/30), v:Array.from({length:300},()=>.5+rnd()*.02)};
  const rn=T.ppgAnalyze(nz.ts,[{name:'g',v:nz.v}],{win:10});
  ok('pure noise → low confidence',!rn || rn.conf<r.conf*.7,rn&&rn.conf.toFixed(2));
  // выбор лучшего канала
  const bad2=v.map((_,i)=>.5+.02*(((i*7919)%13)/13-.5));
  const rb=T.ppgAnalyze(ts,[{name:'r',v:bad2},{name:'g',v}],{win:10});
  ok('best channel is picked',rb.chan==='g');
  ok('too little data → null',T.ppgAnalyze([0,.1,.2],[{name:'g',v:[1,2,1]}],{win:10})===null);
  const rs=T.ppgResample([0,1,2],[0,10,20],2,10);
  ok('resample is linear',rs.length===5 && near(rs[1],5,1e-6) && near(rs[4],20,1e-6),Array.from(rs).join(','));
  ok('rmssd of irregular beats is larger',T.ppgRmssd([0,.8,1.7,2.4,3.4,4.1])>T.ppgRmssd([0,.8,1.6,2.4,3.2,4.0]));
  ok('finger detector',T.ppgFinger(.9,.3,.2) && !T.ppgFinger(.4,.4,.4) && !T.ppgFinger(.1,.02,.02));
}

/* ---- таймлапс ---- */
{
  ok('due first',T.tlDue({now:0,last:null,interval:5,count:0,max:0}));
  ok('not yet',!T.tlDue({now:3,last:0,interval:5,count:1,max:0}));
  ok('due after interval',T.tlDue({now:5,last:0,interval:5,count:1,max:0}));
  ok('stops at max',!T.tlDue({now:99,last:0,interval:5,count:10,max:10}) && T.tlDue({now:99,last:0,interval:5,count:9,max:10}));
  const m=[.5,.5,.8,.5,.5,.5,.5], g=T.tlGains(m,2);
  ok('deflicker pulls the bright frame down',g[2]<1 && g[0]>=.99,Array.from(g).map(v=>v.toFixed(2)).join(' '));
  const ramp=Array.from({length:20},(_,i)=>.2+.02*i), gr=T.tlGains(ramp,3);
  ok('slow change (sunset) stays',gr.slice(4,16).every(v=>near(v,1,.02)),Array.from(gr).map(v=>v.toFixed(2)).join(' '));
  ok('gain is limited',T.tlGains([.001,1,1],1).every(v=>v>=.5 && v<=2));
  ok('length',T.tlLength(250,25)===10);
}

/* ---- ZIP (проверяем настоящим unzip / python) ---- */
{
  const enc=new TextEncoder();
  const files=[{name:'a.txt',data:enc.encode('hello')},{name:'frames/0001.jpg',data:Uint8Array.from({length:3000},(_,i)=>i*31&255)},{name:'пусто.bin',data:new Uint8Array(0)}];
  ok('crc32 of "123456789"',T.zipCrc(enc.encode('123456789'))===0xCBF43926);
  const z=T.zipStore(files), f=path.join(os.tmpdir(),'camtools-test-'+process.pid+'.zip');
  fs.writeFileSync(f,z);
  try{
    const py=`import zipfile,sys
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print(sorted(z.namelist())); print(z.read('a.txt').decode()); print(len(z.read('frames/0001.jpg')))`;
    const out=execFileSync('python3',['-I','-c',py,f],{encoding:'utf8'}).trim().split('\n');
    ok('zip readable by python',out[1]==='hello' && out[2]==='3000' && out[0].includes('frames/0001.jpg') && out[0].includes('пусто.bin'),out.join(' | '));
  }catch(e){ ok('zip readable by python',false,e.message.split('\n')[0]); }
  finally{ fs.rmSync(f,{force:true}); }
}

/* ---- цвет ---- */
{
  ok('hex',T.colHex(1,0,0)==='#ff0000' && T.colHex(0,.5,1)==='#0080ff' && T.colHex(2,-1,0)==='#ff0000');
  const hsv=T.colHSV(0,1,0); ok('hsv green',hsv.h===120 && hsv.s===1 && hsv.v===1);
  ok('hsv grey',T.colHSV(.5,.5,.5).s===0);
  ok('hsv blue / red wrap',T.colHSV(0,0,1).h===240 && T.colHSV(1,0,.5).h>300);
  const c=T.colCCT(1,1,1);
  ok('white screen ≈ D65 (6500 K)',near(c,6500,150),c);
  ok('warm light is lower, cool is higher',T.colCCT(1,.75,.45)<4500 && T.colCCT(.8,.9,1)>7000,T.colCCT(1,.75,.45)+' '+T.colCCT(.8,.9,1));
  ok('black → 0 K',T.colCCT(0,0,0)===0);
  ok('names',T.colName(1,0,0)==='red' && T.colName(1,1,1)==='white' && T.colName(0,0,0)==='black' && T.colName(.05,.55,.2)==='green' && T.colName(.1,.2,.85)==='blue');
  const im=img(10,10,(x)=>x<5?[255,0,0]:[0,0,255]);
  const m=T.colMean(im,[0,0,.5,1],1); ok('zone mean',m[0]===1 && m[2]===0);
  const m2=T.colMean(im,[0,0,1,1],1); ok('whole-frame mean',near(m2[0],.5,1e-9) && near(m2[2],.5,1e-9));
  ok('zone outside the frame doesn\'t crash',Array.isArray(T.colMean(im,[.99,.99,.5,.5])));
}

/* ---- спектрометр ---- */
{
  const cal={x1:.25,nm1:436,x2:.55,nm2:546};
  ok('calibration both ways',near(T.specNm(.25,cal),436,1e-9) && near(T.specNm(.55,cal),546,1e-9) && near(T.specX(T.specNm(.8,cal),cal),.8,1e-9));
  ok('extrapolates',near(T.specNm(.85,cal),656,1e-6));
  // картинка: тёмная, три яркие вертикальные линии на 25, 55, 70% ширины (100 столбцов)
  const line=[25,55,70], im=img(100,20,(x)=>line.includes(x)?[255,255,255]:[8,8,8]);
  const p=T.specProfile(im,.4,.6);
  ok('profile length and lines',p.v.length===100 && p.v[25]>.99 && p.v[26]<.05);
  const pk=T.specPeaks(p.v,.3,3);
  ok('three lines found',pk.length===3 && pk.map(q=>Math.round(q.x)).sort((a,b)=>a-b).join()==='25,55,70',pk.map(q=>q.x).join());
  const nm=pk.map(q=>T.specNm(q.x/100,cal)).sort((a,b)=>a-b);
  ok('line wavelengths',near(nm[0],436,4) && near(nm[1],546,4) && near(nm[2],T.specNm(.7,cal),4),nm.map(v=>v.toFixed(0)).join());
  const wide=new Float32Array(100); for(let i=0;i<100;i++) wide[i]=Math.exp(-((i-40)**2)/18);
  const pk2=T.specPeaks(wide,.1,3); ok('sub-pixel peak',pk2.length===1 && near(pk2[0].x,40,.2),pk2[0]&&pk2[0].x);
  const two=new Float32Array(100); two[30]=1; two[32]=.8; two[31]=.2;
  ok('close peaks merge',T.specPeaks(two,.1,4).length===1);
  ok('rel threshold hides weak lines',T.specPeaks(Float32Array.from([0,1,0,.1,0,.05,0]),.2,1).length===1);
  ok('flat zero → no peaks',T.specPeaks(new Float32Array(50)).length===0);
  const dark=Float32Array.from(p.v).map(()=>.02), cl=T.specClean(p.v,dark,1);
  ok('dark frame subtraction',near(cl[0],Math.max(0,p.v[0]-.02),1e-6) && cl.every(v=>v>=0));
  ok('smoothing spreads the line',T.specClean(p.v,null,5)[25]<p.v[25]);
  const v=T.wlRGB(450), r=T.wlRGB(650), g=T.wlRGB(530);
  ok('wavelength colours',v[2]>v[0] && r[0]>r[2] && g[1]>g[0] && g[1]>g[2],[v,g,r].join(' / '));
  ok('outside visible is black',T.wlRGB(300).every(x=>x===0) && T.wlRGB(900).every(x=>x===0));
}
{
  const f=T.specFit([.25,.55,.25+(611.6-436.6)/(109.5/.3)],[436.6,546.1,611.6]);
  ok('fit through three lines',f && f.rms<1 && near(T.specNm(.55,f),546.1,1),f&&JSON.stringify(f));
  const f2=T.specFit([.2,.5],[400,700]); ok('two points are exact',near(f2.nm1,400,1e-6) && near(f2.nm2,700,1e-6) && f2.rms<1e-9);
  ok('degenerate fit',T.specFit([.5,.5],[400,700])===null && T.specFit([.5],[400])===null);
  const m=T.specMatchRef([{x:.7,v:1},{x:.25,v:.9},{x:.55,v:.8},{x:.9,v:.3}],T.SPEC_REF);
  ok('reference matching uses the brightest lines in order',m && m.xs.join()==='0.25,0.55,0.7' && m.nms[0]===436.6 && m.nms[2]===611.6,m&&m.xs.join());
  ok('one peak is not enough',T.specMatchRef([{x:.2,v:1}],T.SPEC_REF)===null);
}
console.log(bad?'FAILED '+bad:'all ok');
process.exit(bad?1:0);
