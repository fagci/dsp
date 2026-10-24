// Диск Нипкова: геометрия, передача → приём всех вариантов диска, синхронизация, дрейф: node tools/test-nipkow.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Array,Object,Float32Array,Int32Array,Uint8Array,JSON,Number,String});
vm.runInContext(fs.readFileSync(path.join(root,'modules/nipkow-kernels.js'),'utf8')+
  ';this.T={NIP_STD,NIP_ASPECTS,nipCfg,nipRad,nipTestPattern,nipGray,nipCover,nipSrcMap,nipPixels,nipTxNew,nipTxRun,nipRxNew,nipRxRun,nipLock,nipPeriod,nipViewTab,nipRender,nipLevels};',ctx);
const T=ctx.T;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };
const SR=48000, BLK=512;

// Передатчик → n отсчётов (блоками, как движок); drift — во сколько раз «ход» передатчика отличается от приёма
function tx(o,frames,{optical=false,drift=1,skip=0}={}){
  const c=T.nipCfg(o,SR), map=T.nipSrcMap(c,optical);
  const w=96, h=Math.round(96*c.bh/c.bw), RM=c.R*c.M, pix=new Float32Array(RM*c.cc);
  const tp=T.nipTestPattern(w,h,c.color), g=c.color?tp.g:tp;
  if(c.color) [tp.r,tp.g,tp.b].forEach((pl,i)=>T.nipPixels(c,map,pl,w,h,pix.subarray(i*RM,(i+1)*RM),false));
  else T.nipPixels(c,map,g,w,h,pix,false);
  const len=Math.ceil(frames*SR/c.fps), lvl=new Float32Array(len+BLK), syn=new Float32Array(len+BLK), st=T.nipTxNew();
  const sr=SR*drift;
  for(let p=0;p<len;p+=BLK) T.nipTxRun(st,c,sr,pix,lvl.subarray(p,p+BLK),syn.subarray(p,p+BLK),BLK);
  return {c,pix,lvl:lvl.subarray(skip,len),syn:syn.subarray(skip,len),g,w,h,map};
}
function rx(o,t,ro={}){
  const c=T.nipCfg(o,SR), st=T.nipRxNew(c,SR);
  for(let p=0;p<t.lvl.length;p+=BLK){ const e=Math.min(t.lvl.length,p+BLK);
    T.nipRxRun(st,c,SR,t.lvl.subarray(p,e),c.sk==='pulse'?t.syn.subarray(p,e):null,e-p,ro); }
  return {st,c};
}
const maxErr=(a,b)=>{ let m=0; for(let i=0;i<a.length;i++) m=Math.max(m,Math.abs(a[i]-b[i])); return m; };
const mse=(a,b)=>{ let s=0; for(let i=0;i<a.length;i++) s+=(a[i]-b[i])**2; return s/a.length; };
const std=name=>({...T.NIP_STD[name]});

/* ---- геометрия ---- */
{
  for(const [name,s] of Object.entries(T.NIP_STD)){
    const c=T.nipCfg(s,SR), asp=c.bw/c.bh, want=(([a,b])=>a/b)(s.aspect.split(':').map(Number));
    ok('aspect '+name,Math.abs(asp-want)/want<.03 || c.rin<.03 || c.rin>.97,asp.toFixed(3)+' vs '+want.toFixed(3)+' rin '+c.rin.toFixed(3));
    ok('pixel clock fits the sample rate '+name,c.fieldRate*(c.N+c.S)*c.M*4<=SR*1.0001 || c.M===8,'M='+c.M);
  }
  const b=T.nipCfg(std('Baird 30-line, 12.5 fps'),SR);
  ok('Baird: 750 rpm, 30 lines',Math.abs(b.revRate*60-750)<1e-9 && b.N===30 && b.R===30 && b.S===0);
  const il=T.nipCfg(std('2 spirals, 2×24 interlaced, 12.5 fps'),SR);
  ok('interlace: 48 lines per frame, 25 fields/s, 750 rpm',il.R===48 && il.fieldRate===25 && Math.abs(il.revRate*60-750)<1e-9);
  const tw=T.nipCfg(std('2 spirals, 2 pictures per turn, 30-line'),SR);
  ok('two pictures per turn: 25 fps at 750 rpm',tw.R===30 && Math.abs(tw.revRate*60-750)<1e-9 && tw.fieldRate===25);
  const ib=T.nipCfg(std('Baird 30-line, in-band sync'),SR);
  ok('in-band: one more slot, black level above sync',ib.S===1 && ib.black>-1);
}

/* ---- передача → приём: каждый вариант, пиксель в пиксель ---- */
for(const [name,s] of Object.entries(T.NIP_STD)){
  if(name.startsWith('Slow')) continue;                                           // 64 строки по 1 к/с — ниже отдельно
  const t=tx(s,8), r=rx(s,t);
  const e=maxErr(r.st.scan,t.pix);
  ok('loopback '+name+' ('+s.sync+')',e<1e-5 && r.st.fields>=7*(r.c.il?r.c.k:1),'err '+e.toExponential(1)+' fields '+r.st.fields);
  ok('  lock '+name,T.nipLock(r.st,r.c)===1);
}
{
  const s=std('Slow scan 64-line, 1 fps'), t=tx(s,3), r=rx(s,t);
  ok('slow scan 1 fps',maxErr(r.st.scan,t.pix)<1e-5,maxErr(r.st.scan,t.pix));
}

/* ---- синхронизация ---- */
{
  // in-band: приём начинается с произвольного места сигнала; поле/оборот находятся по метке
  for(const name of ['Baird 30-line, in-band sync','Interlaced 2×24, in-band sync']){
    const s=std(name);
    for(const skip of [1234,5000,17777]){
      const t=tx(s,14,{skip}), r=rx(s,t);
      ok('in-band lock from the middle of a turn, '+name+', skip '+skip,maxErr(r.st.scan,t.pix)<1e-5 && T.nipLock(r.st,r.c)===1,maxErr(r.st.scan,t.pix).toExponential(1));
    }
  }
  // pulse: диск у передатчика крутится на 0.4 % быстрее — приёмник подстраивает период
  const s=std('Baird 30-line, 12.5 fps'), t=tx(s,40,{drift:1.004}), r=rx(s,t);
  const want=SR/r.c.fieldRate*1.004;
  ok('pulse: period follows a drifting disk',Math.abs(r.st.Pf-want)/want<5e-4,r.st.Pf.toFixed(3)+' vs '+want.toFixed(3));
  ok('pulse: picture stays aligned under drift',mse(r.st.scan,t.pix)<2e-3,mse(r.st.scan,t.pix).toExponential(1));
  // in-band: то же
  const s2=std('Baird 30-line, in-band sync'), t2=tx(s2,40,{drift:.997}), r2=rx(s2,t2);
  const want2=SR/r2.c.fieldRate*.997;
  ok('in-band: period follows a drifting disk',Math.abs(r2.st.Pf-want2)/want2<1e-3,r2.st.Pf.toFixed(3)+' vs '+want2.toFixed(3));
  ok('in-band: picture stays aligned under drift',mse(r2.st.scan,t2.pix)<5e-3,mse(r2.st.scan,t2.pix).toExponential(1));
}
{
  // free: без синхро ровно номинальный ход → картинка сдвинута циклически; shift возвращает её на место
  const s={...std('Baird 30-line, 12.5 fps'),sync:'free'};
  const t=tx({...s,sync:'none'},10,{skip:777}), r=rx(s,t,{shift:0});
  const sh=(777/ (SR/r.c.fieldRate)); let best=1e9;
  for(let q=0;q<400;q++){ const r2=rx(s,t,{shift:q/400}); best=Math.min(best,mse(r2.st.scan,t.pix)); }
  ok('free-run: a shift value exists that restores the picture',best<1e-3,best.toExponential(1));
}
{
  // auto: период по автокорреляции при уходе скорости диска на 1.2 %
  const s={...std('Baird 30-line, 12.5 fps'),sync:'auto'};
  const t=tx({...s,sync:'none'},50,{drift:1.012}), c=T.nipCfg(s,SR), st=T.nipRxNew(c,SR);
  for(let p=0;p<t.lvl.length;p+=BLK){ const e=Math.min(t.lvl.length,p+BLK); T.nipRxRun(st,c,SR,t.lvl.subarray(p,e),null,e-p,{}); }
  const want=SR/c.fieldRate*1.012;
  ok('auto: autocorrelation finds the turn period',Math.abs(st.Pf-want)/want<2e-4 && T.nipLock(st,c)===1,st.Pf.toFixed(3)+' vs '+want.toFixed(3)+' s='+st.strength.toFixed(2));
  const il={...std('2 spirals, 2×24 interlaced, 12.5 fps'),sync:'auto'};
  const t2=tx({...il,sync:'none'},50,{drift:.99}), c2=T.nipCfg(il,SR), st2=T.nipRxNew(c2,SR);
  for(let p=0;p<t2.lvl.length;p+=BLK){ const e=Math.min(t2.lvl.length,p+BLK); T.nipRxRun(st2,c2,SR,t2.lvl.subarray(p,e),null,e-p,{}); }
  const want2=SR/c2.fieldRate*.99;
  ok('auto: interlaced disk',Math.abs(st2.Pf-want2)/want2<2e-4,st2.Pf.toFixed(3)+' vs '+want2.toFixed(3));
  const flat=new Float32Array(20000).fill(.3);
  ok('auto: a flat signal gives no period',T.nipPeriod(flat,3840,.05)===null);
}

/* ---- виды: плоский и «дисковый» ---- */
{
  const s=std('Baird 30-line, 12.5 fps');
  for(const optical of [false,true]){
    const t=tx(s,6,{optical}), r=rx(s,t), view=T.nipViewTab(r.c,120,optical);
    const out=new Float32Array(view.w*view.h);
    const [lo,hi]=[0,1]; T.nipRender(r.st.scan,view,out,lo,hi);
    // эталон: исходная картинка в размере окна
    const ref=new Float32Array(view.w*view.h);
    for(let y=0;y<view.h;y++) for(let x=0;x<view.w;x++){
      const gx=Math.min(t.w-1,Math.floor((x+.5)/view.w*t.w)), gy=Math.min(t.h-1,Math.floor((y+.5)/view.h*t.h)); ref[y*view.w+x]=t.g[gy*t.w+gx]; }
    let inside=0, err=0; for(let q=0;q<out.length;q++) if(view.i0[q]>=0){ inside++; err+=(out[q]-ref[q])**2; }
    ok((optical?'disk':'flat')+' view round trip, picture matches the source',err/inside<0.02,'mse '+(err/inside).toFixed(4)+' coverage '+(inside/out.length).toFixed(2));
    ok((optical?'disk':'flat')+' view size follows the window aspect',Math.abs(view.w/view.h-r.c.bw/r.c.bh)<.05);
  }
  // несовпадение геометрии: передача «диск», приём «плоско» — картинка искажена, но не пустая
  const t=tx(s,6,{optical:true}), r=rx(s,t);
  const view=T.nipViewTab(r.c,120,false), out=new Float32Array(view.w*view.h); T.nipRender(r.st.scan,view,out,0,1);
  let v=0,m=0; for(const q of out) m+=q; m/=out.length; for(const q of out) v+=(q-m)**2;
  ok('mismatched geometry still shows a picture',v/out.length>.02);
  // направление и вращение влияют на «дисковую» картинку, но не на плоскую
  const base=T.nipCfg(s,SR), ccw=T.nipCfg({...s,rot:'ccw'},SR), inn=T.nipCfg({...s,sweep:'inner → outer'},SR);
  const m0=T.nipSrcMap(base,true), m1=T.nipSrcMap(ccw,true), m2=T.nipSrcMap(inn,true), f0=T.nipSrcMap(base,false), f1=T.nipSrcMap(ccw,false);
  ok('rotation mirrors the disk scene',Math.abs(m0.X[5]-(1-m1.X[5]))<1e-5 && Math.abs(m0.Y[5]-m1.Y[5])<1e-5);
  ok('rotation does not change the flat scene',maxErr(f0.X,f1.X)===0 && maxErr(f0.Y,f1.Y)===0);
  ok('sweep from the inner edge flips the disk scene vertically',Math.abs(m0.Y[0]-(1-m2.Y[0]))<.05 && m0.Y[0]<.2 && m2.Y[0]>.8,m0.Y[0].toFixed(2)+' '+m2.Y[0].toFixed(2));
}

/* ---- цвет: кадрово-последовательный RGB ---- */
{
  const col=std('Colour 30-line, RGB in turn, 8.3 colour fps'), il=std('Colour 2×24 interlaced, RGB in turn, 5 colour fps');
  const c1=T.nipCfg(col,SR), c2=T.nipCfg(il,SR), c3=T.nipCfg({...col,spirals:'2',sync:'pulse'},SR);
  ok('colour cycle: 3 fields; interlaced: 3 frames of k fields; two pictures per turn: lcm(k,3)',c1.F===3 && c2.F===6 && c3.F===6 && !T.nipCfg(std('Baird 30-line, 12.5 fps'),SR).color);
  ok('disk still turns at the field rate over spirals (rpm does not depend on colour)',Math.abs(c1.revRate*60-c1.fieldRate*60)<1e-9);
  const planes=pix=>[0,1,2].map(i=>pix.subarray(i*c1.R*c1.M,(i+1)*c1.R*c1.M));
  // три плоскости разные: красная ≠ синей на лице, на фоне
  const t=tx(col,14), [pr,pg,pb]=planes(t.pix); let diff=0; for(let i=0;i<pr.length;i++) diff=Math.max(diff,Math.abs(pr[i]-pb[i]));
  ok('colour test pattern has different R and B planes',diff>.5,diff.toFixed(2));
  for(const skip of [0,3333,21111]){
    const tt=tx(col,24,{skip}), r=rx(col,tt);
    ok('colour in-band: all three planes recovered, start anywhere (skip '+skip+')',maxErr(r.st.scan,tt.pix)<1e-5 && T.nipLock(r.st,r.c)===1,maxErr(r.st.scan,tt.pix).toExponential(1));
  }
  const t2=tx({...col,sync:'pulse'},24,{skip:5000}), r2=rx({...col,sync:'pulse'},t2);
  ok('colour pulse: planes land in the right place (pulse = start of the cycle)',maxErr(r2.st.scan,t2.pix)<1e-5);
  const t3=tx(il,20), r3=rx(il,t3);
  ok('colour interlaced: 6 fields per cycle, planes and lines in place',maxErr(r3.st.scan,t3.pix)<1e-5,maxErr(r3.st.scan,t3.pix).toExponential(1));
  // в in-band у цветного цикла длинная метка только у первого поля — начало с любого места
  const il2={...il,sync:'in-band'}, t4=tx(il2,30,{skip:9999}), r4=rx(il2,t4);
  ok('colour interlaced in-band: finds the first field of the cycle',maxErr(r4.st.scan,t4.pix)<1e-5,maxErr(r4.st.scan,t4.pix).toExponential(1));
  // auto: период цикла (три оборота) по автокорреляции при уходе скорости
  const sa={...col,sync:'auto'}, t5=tx({...col,sync:'none'},60,{drift:1.01}), c5=T.nipCfg(sa,SR), st5=T.nipRxNew(c5,SR);
  for(let p=0;p<t5.lvl.length;p+=BLK){ const e=Math.min(t5.lvl.length,p+BLK); T.nipRxRun(st5,c5,SR,t5.lvl.subarray(p,e),null,e-p,{}); }
  const want=SR/c5.fieldRate*1.01;
  ok('colour auto: period of one field found from the whole cycle',Math.abs(st5.Pf-want)/want<3e-4,st5.Pf.toFixed(3)+' vs '+want.toFixed(3));
  const rgb={w:2,h:1,gray:false,data:{data:new Uint8ClampedArray([255,0,51,255,0,255,0,255])}};
  ok('channel picker reads R, G, B',T.nipGray(rgb,0).g[0]===1 && T.nipGray(rgb,1).g[0]===0 && Math.abs(T.nipGray(rgb,2).g[0]-.2)<1e-6 && T.nipGray(rgb,2).g[1]===0);
}

/* ---- прочее ---- */
{
  const s=std('Baird 30-line, 12.5 fps'), t=tx(s,3), c=t.c;
  let mn=9,mx=-9,nan=0; for(const v of t.lvl){ if(v<mn) mn=v; if(v>mx) mx=v; if(!Number.isFinite(v)) nan++; }
  ok('level stays within −1…1',mn>=-1 && mx<=1 && nan===0,mn+' '+mx);
  let pulses=0; for(let i=1;i<t.syn.length;i++) if(t.syn[i]>.5 && t.syn[i-1]<=.5) pulses++;
  ok('one sync pulse per turn',pulses>=2 && pulses<=3,pulses);
  const inv=new Float32Array(c.R*c.M); T.nipPixels(c,t.map,t.g,t.w,t.h,inv,true);
  ok('invert flips pixels',Math.abs(inv[10]+t.pix[10]-1)<1e-6);
  const r=rx(s,t,{invert:true}); ok('rx invert reverses polarity',Math.abs(r.st.scan[10]+t.pix[10]-1)<1e-5);
  const lv=T.nipLevels(t.pix); ok('auto level finds the picture range',lv[0]<.3 && lv[1]>.8,lv);
  const g=T.nipGray({w:2,h:1,gray:false,data:{data:new Uint8ClampedArray([255,255,255,255,0,0,0,255])}});
  ok('gray from RGBA',g && Math.abs(g.g[0]-1)<1e-6 && g.g[1]===0);
  const cv=T.nipCover({g:new Float32Array(40*10).map((_,i)=>i%40),w:40,h:10},1);
  ok('cover crops the wide picture to the window aspect, centred',cv.w===10 && cv.h===10 && cv.g[0]===15,cv.w+'x'+cv.h+' '+cv.g[0]);
  const px=T.nipCfg({...s,px:'100'},SR); ok('explicit pixels per line',px.M===100);
}
console.log(bad?bad+' FAILED':'all ok'); process.exit(bad?1:0);
