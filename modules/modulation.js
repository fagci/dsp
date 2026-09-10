/* ---------- модуляция ---------- */
def({ id:'mod', title:'Модулятор', cat:'Модуляция',
  ins:[{n:'bit',t:'sig'},{n:'key',t:'num'},{n:'f0',t:'num'},{n:'shift',t:'num'},{n:'amp',t:'num'},{n:'rise',t:'num'},{n:'invert',t:'num'}],
  outs:[{n:'out',t:'sig'}],
  params:[{n:'mode',t:'select',opts:['OOK','FSK','BPSK'],d:'FSK'},
          {n:'f0',t:'range',min:100,max:20000,step:1,d:1000,log:true},
          {n:'shift',t:'range',min:10,max:5000,step:1,d:170,log:true},
          {n:'amp',t:'range',min:0,max:1,step:.01,d:.3},
          {n:'rise',t:'range',min:0,max:20,step:.1,d:2},
          {n:'invert',t:'check',d:false}],
  init:n=>{n.ph=0;n.env=0;},
  process(n,I){
    for(const k of ['shift','amp','rise']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    if(typeof I.invert==='number') setMod(n,'invert',I.invert>=0.5);
    const o=buf(n,'out'), f0=pv(n,I,'f0'), sh=n.p.shift, a=n.p.amp;
    const c=Math.exp(-1/Math.max(1,Eng.sr*n.p.rise/1000));   // сглаживание фронтов
    for(let i=0;i<BLOCK;i++){
      let b = I.bit ? I.bit[i]>0 : (I.key||0)>.5;
      if(n.p.invert) b=!b;
      let f=f0, g=1;
      if(n.p.mode==='OOK') g = b?1:0;
      else if(n.p.mode==='FSK') f = b? f0+sh : f0;
      n.env = n.env*c + g*(1-c);
      let v=Math.sin(2*Math.PI*n.ph);
      if(n.p.mode==='BPSK' && !b) v=-v;
      o[i]=v*a*n.env;
      n.ph=(n.ph+f/Eng.sr)%1; }
    return {out:o}; }});


def({ id:'fsk', title:'Демодулятор FSK', cat:'Модуляция',
  ins:[{n:'in',t:'sig'},{n:'f0',t:'num'},{n:'shift',t:'num'},{n:'bw',t:'num'},{n:'invert',t:'num'},{n:'center',t:'num'}],
  outs:[{n:'soft',t:'sig'},{n:'level',t:'num'},{n:'fLo',t:'num'},{n:'fHi',t:'num'},
        {n:'bLo',t:'num'},{n:'bHi',t:'num'},{n:'q',t:'num'}],
  view:{h:54}, readout:true,
  params:[{n:'f0',t:'range',min:100,max:20000,step:1,d:1275,log:true},
          {n:'shift',t:'range',min:10,max:5000,step:1,d:170,log:true},
          {n:'bw',t:'range',min:5,max:2000,step:1,d:60,log:true},
          {n:'invert',t:'check',d:false},
          {n:'center',t:'check',d:true}],
  init:n=>{n.p1=0;n.p2=0;n.m=[0,0];n.s=[0,0];n.lv=0;n.hm=[];n.hs=[];n.q=0;},
  process(n,I){
    if(typeof I.shift==='number') setMod(n,'shift',I.shift);
    if(typeof I.bw==='number') setMod(n,'bw',I.bw);
    if(typeof I.invert==='number') setMod(n,'invert',I.invert>=0.5);
    if(typeof I.center==='number') setMod(n,'center',I.center>=0.5);
    const so=buf(n,'soft');
    const tune=(typeof I.f0==='number'&&I.f0>20)?I.f0:null;
    let f0=tune!=null?tune:n.p.f0;
    if(n.p.center && tune!=null) f0=tune-n.p.shift/2;   // клик по спектру = середина между тонами
    const fS=f0, fM=f0+n.p.shift, a=Math.exp(-2*Math.PI*n.p.bw/Eng.sr);
    let sm=0,ss=0;
    for(let i=0;i<BLOCK;i++){
      const x=I.in?I.in[i]:0, w1=2*Math.PI*n.p1, w2=2*Math.PI*n.p2;
      // два квадратурных коррелятора: на «спейсе» и на «марке»
      n.s[0]=n.s[0]*a+x*Math.cos(w1)*(1-a); n.s[1]=n.s[1]*a-x*Math.sin(w1)*(1-a);
      n.m[0]=n.m[0]*a+x*Math.cos(w2)*(1-a); n.m[1]=n.m[1]*a-x*Math.sin(w2)*(1-a);
      const ms=Math.hypot(n.m[0],n.m[1]), ss2=Math.hypot(n.s[0],n.s[1]);
      let d=(ms-ss2)/(ms+ss2+1e-9);
      if(n.p.invert) d=-d;
      so[i]=d; sm+=ms; ss+=ss2;
      n.p1=(n.p1+fS/Eng.sr)%1; n.p2=(n.p2+fM/Eng.sr)%1; }
    sm/=BLOCK; ss/=BLOCK;
    n.lv=sm+ss; n.fLo=fS; n.fHi=fM;
    n.q=n.q*.9+Math.abs(sm-ss)/(sm+ss+1e-9)*.1;        // насколько чётко разделены тоны
    n.hm.push(sm); n.hs.push(ss);
    if(n.hm.length>120){ n.hm.shift(); n.hs.shift(); }
    return {soft:so, level:n.lv, fLo:fS, fHi:fM,
            bLo:Math.max(1,fS-n.p.bw/2), bHi:fM+n.p.bw/2, q:n.q}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height,h=H/2-2; cx.clearRect(0,0,W,H);
    const peak=Math.max(1e-6,...n.hm,...n.hs);
    const bar=(hist,y,col)=>{                          // две полосы: марк и спейс
      cx.strokeStyle=col; cx.beginPath();
      for(let i=0;i<hist.length;i++){ const x=i/120*W, yy=y+h-hist[i]/peak*h;
        i?cx.lineTo(x,yy):cx.moveTo(x,yy); }
      cx.stroke(); };
    bar(n.hs,0,getComputedStyle(document.body).getPropertyValue('--t-num'));
    bar(n.hm,H/2,getComputedStyle(document.body).getPropertyValue('--t-sig'));
    cx.fillStyle='#6c7a80'; cx.font='9px monospace';
    cx.fillText('space '+(n.fLo||0).toFixed(0),3,10);
    cx.fillText('mark  '+(n.fHi||0).toFixed(0),3,H/2+10);
    n.el.querySelector('.readout').textContent =
      'разделение '+(n.q*100).toFixed(0)+'%'; }});


def({ id:'demod', title:'Демодулятор AM/ЧМ/SSB', cat:'Модуляция',
  ins:[{n:'in',t:'sig'},{n:'freq',t:'num'},{n:'bw',t:'num'},{n:'gain',t:'num'}],
  outs:[{n:'out',t:'sig'},{n:'I',t:'sig'},{n:'Q',t:'sig'}],
  params:[{n:'mode',t:'select',opts:['AM','FM','WFM','SSB'],d:'FM'},
          {n:'freq',t:'range',min:100,max:()=>Eng.sr/2,step:1,d:1000,log:true},
          {n:'bw',t:'range',min:5,max:8000,step:1,d:2400,log:true},
          {n:'side',t:'select',opts:['USB','LSB'],d:'USB'},          // только SSB
          {n:'deemph',t:'select',opts:['50','75','off'],d:'50'},     // только WFM
          {n:'smooth',t:'range',min:0,max:.99,step:.01,d:.3},        // только FM/WFM
          {n:'gain',t:'range',min:.1,max:20,step:.1,d:2}],
  init:n=>{n.p1=0;n.p2=0;n.li=[0,0,0,0,0];n.lq=[0,0,0,0,0];n.pp=0;n.f=0;n.de=0;},
  process(n,I){
    for(const k of ['bw','gain','smooth']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const o=buf(n,'out'), oi=buf(n,'I'), oq=buf(n,'Q');
    const freq=pv(n,I,'freq'), half=Math.max(1,n.p.bw/2), gain=n.p.gain;
    const mode=n.p.mode, usb=n.p.side==='USB', sgn=usb?-1:1;
    // общий фронтенд: перенос на несущую (SSB — со сдвигом на половину полосы), ФНЧ 5 полюсов
    const f1 = mode==='SSB' ? (usb? freq+half : freq-half) : freq;
    const a=Math.exp(-2*Math.PI*half/Eng.sr);
    const sm=n.p.smooth;
    const deTau = n.p.deemph==='75'?75e-6:(n.p.deemph==='50'?50e-6:0);
    const da = deTau ? Math.exp(-1/(Eng.sr*deTau)) : 0;
    for(let i=0;i<BLOCK;i++){
      const x=I.in?I.in[i]:0, w1=2*Math.PI*n.p1;
      let vi=x*Math.cos(w1), vq=-x*Math.sin(w1);
      for(let k=0;k<5;k++){
        n.li[k]=n.li[k]*a+(k?n.li[k-1]:vi)*(1-a);
        n.lq[k]=n.lq[k]*a+(k?n.lq[k-1]:vq)*(1-a); }
      const li=n.li[4], lq=n.lq[4];
      oi[i]=li*gain; oq[i]=lq*gain;
      let v;
      if(mode==='AM'){
        v=Math.hypot(li,lq)*gain;                    // огибающая
      } else if(mode==='SSB'){
        const w2=2*Math.PI*n.p2;                      // метод Уивера: обратный перенос
        v=(li*Math.cos(w2)+sgn*lq*Math.sin(w2))*gain*4;
        n.p2=(n.p2+half/Eng.sr)%1;
      } else {
        const ph=Math.atan2(lq,li);                   // ЧМ-дискриминатор по разности фазы
        let d=ph-n.pp; while(d>Math.PI)d-=2*Math.PI; while(d<-Math.PI)d+=2*Math.PI;
        n.pp=ph;
        const fHz=d*Eng.sr/(2*Math.PI);
        n.f=n.f*sm+fHz*(1-sm);
        v=(n.f/half)*gain;                             // нормировка девиации на полосу
        if(mode==='WFM' && da){ n.de=n.de*da+v*(1-da); v=n.de; } // деэмфазис
      }
      o[i]=v;
      n.p1=(n.p1+f1/Eng.sr)%1; }
    return {out:o,I:oi,Q:oq}; }});


function freqMeasure(n){
  const N=n.ring.length, x=new Float32Array(N);
  let mean=0;
  for(let i=0;i<N;i++){ x[i]=n.ring[(n.w+i)%N]; mean+=x[i]; }
  mean/=N;
  let e=0;
  for(let i=0;i<N;i++){ x[i]-=mean; e+=x[i]*x[i]; }
  if(e/N<1e-10){ n.conf=0; return; }
  const lo=Math.max(2,Math.floor(Eng.sr/n.p.fmax)), hi=Math.min(N>>1,Math.ceil(Eng.sr/n.p.fmin));
  const step=N>8192?2:1;
  const nsdf=L=>{                                    // нормированная автокорреляция: 1 = идеальный период
    let r=0,ea=0,eb=0;
    for(let i=0;i<N-L;i+=step){ r+=x[i]*x[i+L]; ea+=x[i]*x[i]; eb+=x[i+L]*x[i+L]; }
    return 2*r/(ea+eb+1e-12); };
  const v=new Float32Array(hi+2);
  let best=0;
  for(let L=lo;L<=hi;L++){ v[L]=nsdf(L); if(v[L]>best) best=v[L]; }
  if(best<0.2){ n.conf=best>0?best:0; return; }
  let bl=-1;                                         // берём НАИМЕНЬШИЙ период с почти тем же пиком
  for(let L=lo+1;L<hi;L++){
    if(v[L]>=0.9*best && v[L]>=v[L-1] && v[L]>=v[L+1]){ bl=L; break; } }
  if(bl<0){ for(let L=lo;L<=hi;L++) if(v[L]===best){ bl=L; break; } }
  const r0=v[bl-1]||v[bl], r1=v[bl], r2=v[bl+1]||v[bl];
  const d=0.5*(r0-r2)/(r0-2*r1+r2||1e-9);            // параболическое уточнение лага
  const lag=bl+clamp(d,-.5,.5);
  n.conf=clamp(r1,0,1);
  let f=Eng.sr/lag;
  const guard=Math.max(1,Math.round(lag/4));         // точно: набег фазы по переходам через ноль
  let first=-1,last=-1,cross=0;
  for(let i=guard;i<N;i++){
    if(x[i-1]<=0&&x[i]>0){
      const t=i-1+(-x[i-1])/(x[i]-x[i-1]);
      if(first<0) first=t; else { last=t; cross++; } } }
  if(cross>2 && last>first && n.conf>0.7){
    const fz=cross/((last-first)/Eng.sr);
    const expect=Math.round((last-first)/lag);       // сколько периодов должно уложиться
    if(expect===cross && Math.abs(fz-f)/f<0.01) f=fz;
  }
  n.f=f;
}

def({ id:'sigmap', title:'Шкала сигнала', cat:'Модуляция', ins:[{n:'in',t:'sig'},{n:'clamp',t:'num'}],
  outs:[{n:'out',t:'sig'}],
  params:[{n:'inMin',t:'num',d:1500},{n:'inMax',t:'num',d:2300},
          {n:'outMin',t:'num',d:0},{n:'outMax',t:'num',d:1},
          {n:'clamp',t:'check',d:true}],
  process(n,I){ if(typeof I.clamp==='number') setMod(n,'clamp',I.clamp>=0.5);
    const o=buf(n,'out'), p=n.p, k=(p.outMax-p.outMin)/((p.inMax-p.inMin)||1);
    for(let i=0;i<BLOCK;i++){ let v=p.outMin+((I.in?I.in[i]:0)-p.inMin)*k;
      o[i]=p.clamp?clamp(v,Math.min(p.outMin,p.outMax),Math.max(p.outMin,p.outMax)):v; }
    return {out:o}; }});


def({ id:'sigwin', title:'Окно значений', cat:'Модуляция', ins:[{n:'in',t:'sig'},{n:'minMs',t:'num'}],
  outs:[{n:'out',t:'sig'},{n:'hit',t:'num'}],
  params:[{n:'lo',t:'num',d:1150},{n:'hi',t:'num',d:1350},
          {n:'minMs',t:'range',min:0,max:100,step:.5,d:3}],
  init:n=>{n.run=0;n.hit=0;},
  process(n,I){ if(typeof I.minMs==='number') setMod(n,'minMs',I.minMs);
    const o=buf(n,'out'), need=n.p.minMs*Eng.sr/1000;
    let hit=0;
    for(let i=0;i<BLOCK;i++){ const v=I.in?I.in[i]:0;
      if(v>=n.p.lo&&v<=n.p.hi) n.run++; else n.run=0;
      o[i]=n.run>=need?1:0; hit=hit||o[i]; }
    n.hit=hit; return {out:o,hit}; }});


function paintImage(n,force){                        // растр → canvas (моно или три полосы в RGB)
  if(!n.buf) return null;
  const W=n.W,H=n.H,rgb=n.p.rgb, oW=rgb?Math.floor(W/3):W, mirror=!!n.p.mirror;
  const now=performance.now();
  const period = W*H>200000 ? 120 : 0;               // крупные растры перерисовываем реже
  if(!force && n.tmp && n.lastPaint && now-n.lastPaint<period
     && n.tmp.width===oW && n.tmp.height===H && n.mirrorCache===mirror) return n.tmp;
  n.lastPaint=now; n.mirrorCache=mirror;
  if(!n.tmp||n.tmp.width!==oW||n.tmp.height!==H){
    n.tmp=document.createElement('canvas'); n.tmp.width=oW; n.tmp.height=H;
    n.tcx=n.tmp.getContext('2d'); n.id2=n.tcx.createImageData(oW,H); }
  const d=n.id2.data, pal=n.p.palette, b=n.buf;
  const off=Math.round((n.p.shift||0)*W);
  const at=(y,c,x)=>b[y*W+((c*oW+x+off)%W)];
  for(let y=0;y<H;y++) for(let x=0;x<oW;x++){
    const j=(y*oW+x)*4;
    const sx = mirror ? oW-1-x : x;                  // отражение только при отрисовке, буфер не трогаем
    let r,g,bl;
    if(rgb){ r=at(y,0,sx)*255; g=at(y,1,sx)*255; bl=at(y,2,sx)*255; }
    else { const v=at(y,0,sx);
      if(pal==='тепло'){ [r,g,bl]=heat(v); }
      else if(pal==='сине-жёлтый'){ r=v*255; g=v*230; bl=(1-v)*200; }
      else r=g=bl=v*255; }
    d[j]=r; d[j+1]=g; d[j+2]=bl; d[j+3]=255; }
  n.tcx.putImageData(n.id2,0,0);
  return n.tmp;
}
function paintSave(n){
  const c=paintImage(n,true); if(!c) return;
  c.toBlob(b=>dl(b,'raster-'+Date.now()+'.png'),'image/png');
}

function pxFlush(n){                               // усреднённый отсчёт → пиксель
  if(!n.accN) return;
  const cols=n.p.dir==='столбцы', len=cols?n.H:n.W;
  const p=Math.min(len-1,Math.max(0,Math.floor(n.px)));
  n.buf[cols ? p*n.W+n.py : n.py*n.W+p]=n.acc/n.accN;
  n.acc=0; n.accN=0;
}
function pLine(n){                                 // следующая строка (или столбец) с прокруткой
  const cols=n.p.dir==='столбцы';
  n.py++;
  if(cols){
    if(n.py>=n.W){                                 // сдвиг всего растра влево на столбец
      for(let r=0;r<n.H;r++) n.buf.copyWithin(r*n.W, r*n.W+1, (r+1)*n.W);
      for(let r=0;r<n.H;r++) n.buf[r*n.W+n.W-1]=0;
      n.py=n.W-1; }
  } else if(n.py>=n.H){ n.buf.copyWithin(0,n.W); n.buf.fill(0,n.W*(n.H-1)); n.py=n.H-1; }
}


def({ id:'costas', title:'Захват несущей', cat:'Модуляция',
  ins:[{n:'in',t:'sig'},{n:'f0',t:'num'},{n:'loopHz',t:'num'},{n:'lp',t:'num'}],
  outs:[{n:'I',t:'sig'},{n:'Q',t:'sig'},{n:'ferr',t:'num'},{n:'lock',t:'num'}],
  view:{h:40}, readout:true,
  params:[{n:'f0',t:'range',min:100,max:20000,step:1,d:1800,log:true},
          {n:'order',t:'select',opts:['BPSK','QPSK','8PSK'],d:'QPSK'},
          {n:'loopHz',t:'range',min:.5,max:200,step:.5,d:20,log:true},
          {n:'lp',t:'range',min:50,max:8000,step:10,d:1500,log:true}],
  init:n=>{n.ph=0;n.fo=0;n.li=0;n.lq=0;n.lk=0;n.hist=[];},
  process(n,I){
    if(typeof I.loopHz==='number') setMod(n,'loopHz',I.loopHz);
    if(typeof I.lp==='number') setMod(n,'lp',I.lp);
    const oi=buf(n,'I'), oq=buf(n,'Q'), f0=pv(n,I,'f0');
    const a=Math.exp(-2*Math.PI*n.p.lp/Eng.sr);
    const Bn=n.p.loopHz/Eng.sr, dmp=.707;           // петля второго порядка
    const den=1+2*dmp*Bn+Bn*Bn, al=4*dmp*Bn/den, be=4*Bn*Bn/den;
    const M=n.p.order==='BPSK'?2:(n.p.order==='QPSK'?4:8);
    let e=0;
    for(let i=0;i<BLOCK;i++){
      const x=I.in?I.in[i]:0, w=2*Math.PI*n.ph;
      n.li=n.li*a+x*Math.cos(w)*(1-a); n.lq=n.lq*a-x*Math.sin(w)*(1-a);
      const Ii=n.li, Qq=n.lq;
      if(M===2) e=Qq*Math.sign(Ii);
      else if(M===4) e=Math.sign(Ii)*Qq-Math.sign(Qq)*Ii;
      else { const ang=Math.atan2(Qq,Ii), st=2*Math.PI/M;   // ошибка до ближайшего луча
             let d=ang-Math.round(ang/st)*st; e=d*Math.hypot(Ii,Qq); }
      const mag=Math.hypot(Ii,Qq)+1e-9; e/=mag;
      n.fo+=be*e; n.ph=(n.ph+f0/Eng.sr+n.fo+al*e)%1; if(n.ph<0) n.ph+=1;
      oi[i]=Ii; oq[i]=Qq; }
    n.lk=n.lk*.98+(1-Math.min(1,Math.abs(e)))*.02;
    n.hist.push(n.fo*Eng.sr); if(n.hist.length>120) n.hist.shift();
    return {I:oi,Q:oq,ferr:n.fo*Eng.sr,lock:n.lk}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height; cx.clearRect(0,0,W,H);
    const mx=Math.max(20,...n.hist.map(Math.abs));
    cx.strokeStyle='#1e2529'; cx.beginPath(); cx.moveTo(0,H/2); cx.lineTo(W,H/2); cx.stroke();
    cx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--t-sig'); cx.beginPath();
    for(let i=0;i<n.hist.length;i++){ const x=i/120*W, y=H/2-n.hist[i]/mx*H/2*.9;
      i?cx.lineTo(x,y):cx.moveTo(x,y); }
    cx.stroke();
    n.el.querySelector('.readout').textContent =
      'расстройка '+(n.fo*Eng.sr).toFixed(1)+' Гц · захват '+(n.lk*100).toFixed(0)+'%'; }});


def({ id:'rrc', title:'Согласованный фильтр', cat:'Модуляция', ins:[{n:'in',t:'sig'},{n:'baud',t:'num'},{n:'beta',t:'num'},{n:'span',t:'num'}],
  outs:[{n:'out',t:'sig'}],
  params:[{n:'baud',t:'range',min:10,max:4800,step:.01,d:1800,log:true},
          {n:'beta',t:'range',min:.05,max:1,step:.01,d:.35},
          {n:'span',t:'range',min:2,max:16,step:1,d:8}],
  init:n=>{n.key='';},
  process(n,I){
    for(const k of ['baud','beta','span']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const o=buf(n,'out'), sps=Eng.sr/n.p.baud;
    const key=n.p.baud+'/'+n.p.beta+'/'+n.p.span+'/'+Eng.sr;
    if(n.key!==key){ n.key=key; n.h=rrcTaps(sps,n.p.beta,n.p.span);
      n.z=new Float32Array(n.h.length); n.zi=0; }
    const h=n.h, z=n.z, L=h.length;
    for(let i=0;i<BLOCK;i++){
      z[n.zi]=I.in?I.in[i]:0;
      let acc=0, k=n.zi;
      for(let j=0;j<L;j++){ acc+=h[j]*z[k]; k=k? k-1 : L-1; }
      n.zi=(n.zi+1)%L; o[i]=acc; }
    return {out:o}; }});


function rrcTaps(sps,beta,span){                     // корень из приподнятого косинуса
  const N=Math.min(1023,Math.round(span*sps))|1, h=new Float32Array(N), c=(N-1)/2;
  let sum=0;
  for(let i=0;i<N;i++){
    const t=(i-c)/sps; let v;
    if(Math.abs(t)<1e-8) v=1-beta+4*beta/Math.PI;
    else if(beta>0 && Math.abs(Math.abs(t)-1/(4*beta))<1e-6){
      v=beta/Math.SQRT2*((1+2/Math.PI)*Math.sin(Math.PI/(4*beta))
        +(1-2/Math.PI)*Math.cos(Math.PI/(4*beta)));
    } else {
      const d=Math.PI*t*(1-16*beta*beta*t*t);
      v=(Math.sin(Math.PI*t*(1-beta))+4*beta*t*Math.cos(Math.PI*t*(1+beta)))/d;
    }
    h[i]=v; sum+=v*v; }
  const g=1/Math.sqrt(sum);
  for(let i=0;i<N;i++) h[i]*=g;
  return h;
}

def({ id:'gardner', title:'Синхр. символов', cat:'Модуляция',
  ins:[{n:'I',t:'sig'},{n:'Q',t:'sig'},{n:'baud',t:'num'},{n:'gain',t:'num'},{n:'free',t:'num'}],
  outs:[{n:'sI',t:'sig'},{n:'sQ',t:'sig'},{n:'clk',t:'sig'},{n:'err',t:'num'}],
  params:[{n:'baud',t:'range',min:10,max:4800,step:.01,d:1800,log:true},
          {n:'gain',t:'range',min:0,max:.1,step:.0005,d:.005},
          {n:'free',t:'check',d:false}],
  init:n=>{n.ph=0;n.h=[[0,0],[0,0],[0,0]];n.k=0;n.sI=0;n.sQ=0;n.e=0;n.pw=1e-6;},
  process(n,I){
    if(typeof I.baud==='number') setMod(n,'baud',I.baud);
    if(typeof I.gain==='number') setMod(n,'gain',I.gain);
    if(typeof I.free==='number') setMod(n,'free',I.free>=0.5);
    const oi=buf(n,'sI'), oq=buf(n,'sQ'), ok=buf(n,'clk');
    const inc=2*n.p.baud/Eng.sr;                    // тики каждые полсимвола
    for(let i=0;i<BLOCK;i++){
      const xi=I.I?I.I[i]:0, xq=I.Q?I.Q[i]:0;
      n.ph+=inc; let clk=0;
      if(n.ph>=1){
        n.ph-=1;
        n.h[0]=n.h[1]; n.h[1]=n.h[2]; n.h[2]=[xi,xq];
        n.k^=1;
        if(!n.k){                                   // полный символ: оценка Гарднера
          const e=(n.h[2][0]-n.h[0][0])*n.h[1][0]+(n.h[2][1]-n.h[0][1])*n.h[1][1];
          n.pw=n.pw*.99+(n.h[2][0]*n.h[2][0]+n.h[2][1]*n.h[2][1])*.01;
          const eN=clamp(e/(n.pw+1e-9),-2,2);        // нормировка по мощности: усиление не зависит от уровня
          n.e=n.e*.9+eN*.1;
          if(!n.p.free) n.ph=clamp(n.ph-n.p.gain*eN,-.45,.45);
          n.sI=n.h[2][0]; n.sQ=n.h[2][1]; clk=1; } }
      oi[i]=n.sI; oq[i]=n.sQ; ok[i]=clk; }
    return {sI:oi,sQ:oq,clk:ok,err:n.e}; }});

/* ---------- Декодер WWV/WWVH/CHU (100 Гц подканал) ---------- */
// Раскладка бит по спеку NIST восстановлена по памяти — сверить с реальным приёмом,
// поля минут/часов/дня/года должны быть верны, DUT1 и флаги — под вопросом.

function wwvClassify(ms){
  if(ms<220) return '0';
  if(ms<500) return '1';
  if(ms<900) return 'M';
  return null;                                        // мусор/помеха
}
function wwvBcd(bits, idxs, weights){
  let s=0;
  for(let i=0;i<idxs.length;i++) if(bits[idxs[i]]==='1') s+=weights[i];
  return s;
}
function wwvDecodeFrame(n){
  const b=n.bits;
  const markOk=[0,9,19,29,39,49].every(i=>b[i]==='M');
  const min=wwvBcd(b,[6,7],[10,20])+wwvBcd(b,[1,2,3,4],[1,2,4,8]);
  const hr =wwvBcd(b,[15,16],[10,20])+wwvBcd(b,[10,11,12,13],[1,2,4,8]);
  const day=wwvBcd(b,[30,31],[100,200])+wwvBcd(b,[25,26,27,28],[10,20,40,80])+wwvBcd(b,[20,21,22,23],[1,2,4,8]);
  const yr =wwvBcd(b,[50,51,52,53],[10,20,40,80])+wwvBcd(b,[45,46,47,48],[1,2,4,8]);
  const raw=b.map(x=>x==null?'.':x).join('');
  const stamp=`${String(hr).padStart(2,'0')}:${String(min).padStart(2,'0')} UTC · день ${day} · 20${String(yr).padStart(2,'0')}`
    +(markOk?'':' · СИНХРО НАРУШЕНА')+'\n  '+raw;
  n.log.unshift(stamp);
  while(n.log.length>n.p.keep) n.log.pop();
  n.text=n.log.join('\n');
}
function wwvOnRise(n){
  if(n.riseSamp!=null){
    if(n.secIdx>=0 && n.pendingWidth!=null){
      const c=wwvClassify(n.pendingWidth);
      n.bits[n.secIdx]=c;
      n.lastBit = c==='M'?2 : c==null?-1 : +c;
    }
    const gap=(n.samp-n.riseSamp)/Eng.sr*1000;
    if(gap>1400){                                     // пропуск импульса — 59-я секунда пустая
      if(n.secIdx>=0){ n.bits[(n.secIdx+1)%60]=null; wwvDecodeFrame(n); }
      n.secIdx=0; n.bits=new Array(60).fill(null);
    } else if(n.secIdx>=0){
      n.secIdx=(n.secIdx+1)%60;
    }
  }
  n.riseSamp=n.samp; n.pendingWidth=null;
}
function wwvOnFall(n){
  if(n.riseSamp==null) return;
  n.pendingWidth=(n.samp-n.riseSamp)/Eng.sr*1000;
}

def({ id:'wwv', title:'Декодер WWV/WWVH/CHU', cat:'Декодеры',
  ins:[{n:'in',t:'sig'}],
  outs:[{n:'bit',t:'num'},{n:'tick',t:'num'},{n:'sync',t:'num'}],
  readout:true, tall:true,
  params:[
    {n:'station',t:'select',opts:['WWV/CHU 1000Гц','WWVH 1200Гц'],d:'WWV/CHU 1000Гц'},
    {n:'keep',t:'range',min:1,max:60,step:1,d:20,label:'строк в логе'},
    {n:'reset',t:'button',label:'сброс синхро',fn:n=>{ n.secIdx=-1; n.riseSamp=null; n.bits=new Array(60).fill(null); }}
  ],
  init:n=>{
    n.x1=0;n.x2=0;n.y1=0;n.y2=0;
    n.env=0; n.pk=1e-6;
    n.envA=Math.exp(-2*Math.PI*25/Eng.sr);              // огибающая, срез ~25Гц
    n.pkDecay=Math.exp(-1/(Eng.sr*1.5));                 // пик держим ~1.5с
    n.samp=0; n.riseSamp=null; n.pendingWidth=null; n.high=false;
    n.secIdx=-1; n.bits=new Array(60).fill(null);
    n.lastBit=-1; n.log=[]; n.text='ожидание синхро…';
    n.tickLevel=0;
    const f0=100, Q=8, w0=2*Math.PI*f0/Eng.sr, alpha=Math.sin(w0)/(2*Q);
    const a0=1+alpha;
    n.bq_b0=alpha/a0; n.bq_b1=0; n.bq_b2=-alpha/a0;
    n.bq_a1=(-2*Math.cos(w0))/a0; n.bq_a2=(1-alpha)/a0;
  },
  process(n,I){
    const ob=buf(n,'bit'), ot=buf(n,'tick'), os=buf(n,'sync');
    const x=I.in;
    for(let i=0;i<BLOCK;i++){
      const xi=x?x[i]:0;
      const y=n.bq_b0*xi+n.bq_b1*n.x1+n.bq_b2*n.x2-n.bq_a1*n.y1-n.bq_a2*n.y2;
      n.x2=n.x1; n.x1=xi; n.y2=n.y1; n.y1=y;
      const ay=Math.abs(y);
      n.env=n.env*n.envA+ay*(1-n.envA);
      if(n.env>n.pk) n.pk=n.env; else n.pk*=n.pkDecay;
      const hi=n.pk*0.5, lo=n.pk*0.3;
      if(!n.high && n.env>hi && n.pk>1e-6){ n.high=true; wwvOnRise(n); }
      else if(n.high && n.env<lo){ n.high=false; wwvOnFall(n); }
      n.samp++;
      ob[i]=n.lastBit; os[i]=n.secIdx>=0?1:0;
    }
    // Гёрцель по тону несущей — просто индикатор наличия станции
    const freq=n.p.station.startsWith('WWVH')?1200:1000;
    const k=Math.round(0.5+BLOCK*freq/Eng.sr), w=2*Math.PI*k/BLOCK, coeff=2*Math.cos(w);
    let q1=0,q2=0;
    for(let i=0;i<BLOCK;i++){ const q0=coeff*q1-q2+(x?x[i]:0); q2=q1; q1=q0; }
    const mag=Math.sqrt(Math.max(0,q1*q1+q2*q2-q1*q2*coeff))/BLOCK;
    n.tickLevel=n.tickLevel*0.7+clamp(mag*15,0,1)*0.3;
    ot.fill(n.tickLevel);
    return {bit:ob, tick:ot, sync:os};
  },
  draw(n){
    const el=n.el.querySelector('.readout');
    if(el){
      el.textContent = (n.secIdx>=0?`сек ${n.secIdx}/59 · `:'нет синхро · ')+'\n'+n.text;
    }
  }});

/* ---------- Допплеровский радар (акустика) ---------- */
// Излучатель — узел mod, режим FSK, key/bit не подключены → чистый тон на f0.
// Сюда подаётся сигнал с микрофона. Ищем пик в полосе вокруг f0, исключая
// узкую зону вокруг нулевого сдвига (это прямой сигнал динамик→микрофон).

def({ id:'doppler', title:'Допплеровский радар', cat:'Радар',
  ins:[{n:'in',t:'sig'},{n:'f0',t:'num'}],
  outs:[{n:'shift',t:'num'},{n:'velocity',t:'num'}],
  view:{h:70}, resize:true, readout:true,
  params:[
    {n:'f0',t:'range',min:1000,max:()=>Eng.sr/2,step:1,d:19000,log:true,label:'несущая, Гц'},
    {n:'search',t:'range',min:20,max:500,step:1,d:150,label:'поиск ±Гц'},
    {n:'step',t:'range',min:1,max:20,step:1,d:5,label:'шаг сетки, Гц'},
    {n:'guard',t:'range',min:2,max:50,step:1,d:8,label:'мёртвая зона, Гц'},
    {n:'thresh',t:'range',min:1,max:10,step:.1,d:2.5,label:'порог/медиана'},
    {n:'smooth',t:'range',min:0,max:.99,step:.01,d:.6}
  ],
  init:n=>{
    n.N=8192; n.ring=new Float32Array(n.N); n.win=window_('hann',n.N);
    n.shift=0; n.velocity=0; n.conf=0; n.skip=0; n.spec=null;
  },
  process(n,I){
    n.ring.copyWithin(0,BLOCK);
    for(let i=0;i<BLOCK;i++) n.ring[n.N-BLOCK+i]=I.in?I.in[i]:0;
    n.skip=(n.skip+1)%3;                                // считаем не каждый блок — дорого
    if(n.skip===0){
      const f0=pv(n,I,'f0'), sr=Eng.sr, N=n.N;
      const nBins=Math.round(2*n.p.search/n.p.step)+1;
      const mags=new Float32Array(nBins), offs=new Float32Array(nBins);
      for(let b=0;b<nBins;b++){
        const off=-n.p.search+b*n.p.step, f=f0+off, k=f*N/sr;
        const w=2*Math.PI*k/N, coeff=2*Math.cos(w);
        let q1=0,q2=0;
        for(let i=0;i<N;i++){ const q0=coeff*q1-q2+n.ring[i]*n.win[i]; q2=q1; q1=q0; }
        mags[b]=Math.sqrt(Math.max(0,q1*q1+q2*q2-q1*q2*coeff));
        offs[b]=off;
      }
      n.spec={mags,offs};
      let med=[...mags].sort((a,c)=>a-c)[nBins>>1]||1e-9;
      let best=-1,bestMag=0;
      for(let b=0;b<nBins;b++){
        if(Math.abs(offs[b])<n.p.guard) continue;       // мёртвая зона — прямой сигнал
        if(mags[b]>bestMag){ bestMag=mags[b]; best=b; }
      }
      if(best>=0 && bestMag/med>n.p.thresh){
        n.shift=n.shift*n.p.smooth+offs[best]*(1-n.p.smooth);
        n.conf=n.conf*.8+.2;
      } else {
        n.conf=n.conf*.8;
      }
      const c=343;                                       // скорость звука, м/с
      n.velocity=n.shift*c/(2*f0);
    }
    return {shift:n.shift, velocity:n.velocity};
  },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height; cx.clearRect(0,0,W,H);
    if(n.spec){
      const {mags,offs}=n.spec, mx=Math.max(1e-9,...mags);
      cx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--t-sig');
      cx.beginPath();
      for(let b=0;b<mags.length;b++){
        const x=b/(mags.length-1)*W, y=H-mags[b]/mx*H*.9;
        b?cx.lineTo(x,y):cx.moveTo(x,y); }
      cx.stroke();
      const gx=W/2 - (n.p.guard/n.p.search)*(W/2), gx2=W/2 + (n.p.guard/n.p.search)*(W/2);
      cx.fillStyle='rgba(224,92,92,.15)'; cx.fillRect(gx,0,gx2-gx,H);
    }
    n.el.querySelector('.readout').textContent =
      (n.conf>.3? '' : '(нет цели) ')+n.shift.toFixed(1)+' Гц · '+
      (n.velocity*100).toFixed(1)+' см/с '+(n.shift>0?'← приближение':n.shift<0?'→ удаление':''); }});


/* ---------- Чирп-радар 2D (два микрофона) ---------- */
// Геометрия: динамик в (0,0), микрофон A в (-baseline/2,0), микрофон B в (+baseline/2,0), Y — вперёд.
// Для каждого канала ищем время прихода отражённого чирпа (согласованный фильтр),
// это даёт суммарную длину пути излучатель→цель→микрофон = c·τ — уравнение эллипса
// с фокусами в динамике и микрофоне. Пересечение двух эллипсов = позиция цели,
// решаем итеративно (Гаусс-Ньютон, 5 шагов, старт от предыдущей точки).
//
// Ограничение снизу по дальности: прямая утечка динамик→микрофон приходит почти
// мгновенно и перекрывает отражения от очень близких целей — регулируется guardMs.
// Период повтора должен быть больше времени прохождения максимальной дальности,
// иначе следующий чирп уйдёт раньше, чем вернётся эхо предыдущего.

function chirpBuildTemplate(n){
  const sr=Eng.sr, TN=Math.max(8,Math.round(n.p.dur/1000*sr));
  const t=new Float32Array(TN), f1=n.p.fLo, f2=n.p.fHi, dur=n.p.dur/1000;
  const k=(f2-f1)/dur, edge=Math.max(1,Math.round(TN*0.08));
  for(let i=0;i<TN;i++){
    const tt=i/sr, ph=2*Math.PI*(f1*tt+0.5*k*tt*tt);
    let env=1;
    if(i<edge) env=0.5-0.5*Math.cos(Math.PI*i/edge);
    else if(i>TN-edge) env=0.5-0.5*Math.cos(Math.PI*(TN-i)/edge);
    t[i]=Math.sin(ph)*env;
  }
  n.template=t; n.TN=TN;
  n.periodSamp=Math.max(TN+16,Math.round(n.p.period/1000*sr));
  n.guardSamp=Math.round(n.p.guardMs/1000*sr);
  n.maxDelaySamp=Math.round(1.3*(2*n.p.maxRange)/343*sr);
  n.ringLen=n.periodSamp+n.TN+64;
  n.ringA=new Float32Array(n.ringLen); n.ringB=new Float32Array(n.ringLen);
  n.sig=n.p.fLo+'|'+n.p.fHi+'|'+n.p.dur+'|'+n.p.period+'|'+n.p.maxRange;
}
function chirpCorrelate(ring,ringLen,refIndex,tpl,TN,lo,hi){
  const mags=new Float32Array(Math.max(1,hi-lo));
  let best=-1,bestMag=0;
  for(let L=lo;L<hi;L++){
    let s=0;
    const base=(refIndex+L)%ringLen;
    for(let k=0;k<TN;k++) s+=tpl[k]*ring[(base+k)%ringLen];
    const m=Math.abs(s); mags[L-lo]=m;
    if(m>bestMag){ bestMag=m; best=L; }
  }
  const sorted=[...mags].sort((a,b)=>a-b), med=sorted[sorted.length>>1]||1e-9;
  return {lag:best, mag:bestMag, conf:bestMag/med};
}
function chirpSolve(n,L1,L2){
  const b=n.p.baseline/100/2;
  let x=n.tx, y=Math.max(0.05,n.ty);
  for(let iter=0;iter<5;iter++){
    const d0=Math.hypot(x,y)+1e-6, d1=Math.hypot(x+b,y)+1e-6, d2=Math.hypot(x-b,y)+1e-6;
    const r1=d0+d1-L1, r2=d0+d2-L2;
    const a11=x/d0+(x+b)/d1, a12=y/d0+y/d1;
    const a21=x/d0+(x-b)/d2, a22=y/d0+y/d2;
    const det=a11*a22-a12*a21;
    if(Math.abs(det)<1e-4) return null;                 // геометрия вырождена — не решаем
    let dx=(-r1*a22+r2*a12)/det, dy=(-a11*r2+a21*r1)/det;
    const step=Math.hypot(dx,dy), maxStep=n.p.maxRange*0.5;
    if(step>maxStep){ dx*=maxStep/step; dy*=maxStep/step; }  // не даём шагу улетать
    x+=dx; y+=dy;
    if(y<0.02) y=0.02;
    if(!isFinite(x)||!isFinite(y)) return null;
  }
  if(Math.hypot(x,y)>n.p.maxRange*2.5) return null;      // результат за пределами разумного
  return {x,y};
}

def({ id:'chirpRadar', title:'Чирп-радар 2D', cat:'Радар',
  ins:[{n:'A',t:'sig'},{n:'B',t:'sig'}],
  outs:[{n:'out',t:'sig'},{n:'x',t:'num'},{n:'y',t:'num'},{n:'range1',t:'num'},{n:'range2',t:'num'}],
  view:{h:160}, resize:true, readout:true,
  params:[
    {n:'fLo',t:'range',min:5000,max:()=>Eng.sr/2,step:100,d:17000,log:true,label:'частота нач., Гц'},
    {n:'fHi',t:'range',min:5000,max:()=>Eng.sr/2,step:100,d:20500,log:true,label:'частота кон., Гц'},
    {n:'dur',t:'range',min:.5,max:20,step:.1,d:3,label:'длит. чирпа, мс'},
    {n:'period',t:'range',min:10,max:500,step:1,d:60,label:'период, мс'},
    {n:'baseline',t:'range',min:2,max:30,step:.5,d:12,label:'база микрофонов, см'},
    {n:'guardMs',t:'range',min:.2,max:10,step:.1,d:1.5,label:'мёртвая зона, мс'},
    {n:'maxRange',t:'range',min:.2,max:3,step:.05,d:1.2,label:'макс. дальность, м'},
    {n:'thresh',t:'range',min:1,max:10,step:.1,d:3,label:'порог/медиана'},
    {n:'amp',t:'range',min:0,max:1,step:.01,d:.5,label:'уровень излучения'},
    {n:'smooth',t:'range',min:0,max:.95,step:.01,d:.5}
  ],
  init:n=>{
    n.wA=0;n.wB=0; n.chirpPos=1e9; n.periodCtr=0;
    // tx/ty — координаты цели (м), НЕ n.x/n.y: те заняты движком под позицию узла на холсте
    n.tx=0; n.ty=0.3; n.range1=0; n.range2=0; n.conf=0; n.trail=[];
    chirpBuildTemplate(n);
  },
  process(n,I){
    const sig=n.p.fLo+'|'+n.p.fHi+'|'+n.p.dur+'|'+n.p.period+'|'+n.p.maxRange;
    if(sig!==n.sig) chirpBuildTemplate(n);
    const o=buf(n,'out'), a=I.A, bI=I.B;
    for(let i=0;i<BLOCK;i++){
      n.ringA[n.wA]=a?a[i]:0; n.ringB[n.wA]=bI?bI[i]:0; n.wA=(n.wA+1)%n.ringLen;
      let v=0;
      if(n.chirpPos<n.TN){ v=n.template[n.chirpPos]*n.p.amp; n.chirpPos++; }
      o[i]=v;
      n.periodCtr++;
      if(n.periodCtr>=n.periodSamp){
        n.periodCtr=0;
        const refIndex=(n.wA-n.periodSamp+n.ringLen*4)%n.ringLen;
        const hi=Math.min(n.maxDelaySamp, n.periodSamp-n.TN-1);
        const ca=chirpCorrelate(n.ringA,n.ringLen,refIndex,n.template,n.TN,n.guardSamp,hi);
        const cb=chirpCorrelate(n.ringB,n.ringLen,refIndex,n.template,n.TN,n.guardSamp,hi);
        let rmsA=0,rmsB=0;
        for(let k=0;k<n.ringLen;k++){ rmsA+=n.ringA[k]*n.ringA[k]; rmsB+=n.ringB[k]*n.ringB[k]; }
        n.dbg={rmsA:Math.sqrt(rmsA/n.ringLen), rmsB:Math.sqrt(rmsB/n.ringLen),
               confA:ca.conf, confB:cb.conf,
               lagAms:ca.lag>=0?1000*ca.lag/Eng.sr:null, lagBms:cb.lag>=0?1000*cb.lag/Eng.sr:null};
        if(ca.conf>n.p.thresh && cb.conf>n.p.thresh){
          const L1=343*ca.lag/Eng.sr, L2=343*cb.lag/Eng.sr;
          const sol=chirpSolve(n,L1,L2);
          if(sol){
            n.tx=n.tx*n.p.smooth+sol.x*(1-n.p.smooth);
            n.ty=n.ty*n.p.smooth+sol.y*(1-n.p.smooth);
            n.range1=L1; n.range2=L2;
            n.conf=n.conf*.7+.3;
            n.trail.push([n.tx,n.ty]); if(n.trail.length>40) n.trail.shift();
          } else {
            n.conf=n.conf*.7;                            // геометрия сорвалась — держим прошлую позицию
          }
        } else {
          n.conf=n.conf*.7;
        }
        n.chirpPos=0;
      }
    }
    return {out:o, x:n.tx, y:n.ty, range1:n.range1, range2:n.range2};
  },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height; cx.clearRect(0,0,W,H);
    const R=n.p.maxRange, toPx=(x,y)=>[W/2+x/R*(W/2-4), H-4-y/R*(H-8)];
    cx.strokeStyle='#2a3136'; cx.beginPath();
    cx.arc(W/2,H-4,Math.min(W,H*2)/2-4,Math.PI,2*Math.PI); cx.stroke();
    const [sx,sy]=toPx(0,0);
    cx.fillStyle='#6c7a80'; cx.fillRect(sx-2,sy-2,4,4);
    cx.strokeStyle='rgba(138,180,248,.4)';
    for(let j=0;j<n.trail.length;j++){
      const [px,py]=toPx(n.trail[j][0],n.trail[j][1]);
      j?cx.lineTo(px,py):cx.moveTo(px,py); }
    cx.stroke();
    if(n.conf>.3){
      const [tx,ty]=toPx(n.tx,n.ty);
      cx.fillStyle='#e05c5c'; cx.beginPath(); cx.arc(tx,ty,4,0,7); cx.fill();
    }
    const d=n.dbg;
    n.el.querySelector('.readout').textContent = d ?
      (n.conf>.3?'':'(нет цели) ')+
      'confA='+d.confA.toFixed(2)+' confB='+d.confB.toFixed(2)+
      ' rmsA='+d.rmsA.toFixed(3)+' rmsB='+d.rmsB.toFixed(3)+
      ' лагA='+(d.lagAms!=null?d.lagAms.toFixed(2):'-')+'мс лагB='+(d.lagBms!=null?d.lagBms.toFixed(2):'-')+'мс'
      : 'жду первый цикл…'; }});
