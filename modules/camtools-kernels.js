"use strict";
/* ============================ Камера: движение, пульс, таймлапс, цвет и спектрометр ============================
   Чистая логика без DOM — проверяется tools/test-camtools.mjs. Используется modules/camtools.js.
   camThumb / camDiff живут в camera-kernels.js. */

/* ---------------------------------- Motion Detect ---------------------------------- */
// ImageData-подобный {data,width,height} → серое превью w×h (зона z=[x,y,w,h] в долях кадра; по умолчанию весь кадр)
function mvGray(id,w=64,h=48,z){
  const W=id.width, H=id.height, d=id.data, out=new Uint8Array(w*h);
  const zx=z?z[0]:0, zy=z?z[1]:0, zw=z?z[2]:1, zh=z?z[3]:1;
  for(let y=0;y<h;y++){
    const sy=Math.min(H-1,Math.max(0,((zy+(y+.5)/h*zh)*H)|0));
    for(let x=0;x<w;x++){
      const sx=Math.min(W-1,Math.max(0,((zx+(x+.5)/w*zw)*W)|0)), i=(sy*W+sx)*4;
      out[y*w+x]=(d[i]*77+d[i+1]*150+d[i+2]*29)>>8; }
  }
  return out;
}
// Шаг детектора. st — состояние ({} в начале), g — серое превью w×h, o: {w,h,pix (порог разницы пикселя 0…255),
// mode 'prev' (с прошлым кадром) | 'avg' (с медленным фоном), rate (скорость фона 0…1)}.
// Возврат: motion — доля изменившихся пикселей (0…1), level — средняя разница (0…1), cx/cy — центр движения (0…1), mask — карта изменений.
function mvStep(st,g,o){
  const n=g.length;
  if(!st.bg || st.bg.length!==n){ st.bg=Float32Array.from(g); st.primed=0; }
  const bg=st.bg, mask=st.mask&&st.mask.length===n ? st.mask : (st.mask=new Uint8Array(n));
  let cnt=0, sum=0, sx=0, sy=0;
  const pix=o.pix, W=o.w;
  for(let i=0;i<n;i++){
    const d=Math.abs(g[i]-bg[i]); sum+=d;
    if(d>=pix){ mask[i]=1; cnt++; sx+=i%W; sy+=(i/W)|0; } else mask[i]=0;
  }
  const prim=st.primed++<1;                         // первый кадр сравнивать не с чем
  if(o.mode==='avg'){ const a=Math.max(.001,Math.min(1,o.rate)); for(let i=0;i<n;i++) bg[i]+=(g[i]-bg[i])*a; }
  else for(let i=0;i<n;i++) bg[i]=g[i];
  if(prim){ mask.fill(0); return {motion:0,level:0,cx:.5,cy:.5,mask,area:0}; }
  const H=n/W;
  return {motion:cnt/n, level:sum/n/255, cx:cnt?(sx/cnt+.5)/W:.5, cy:cnt?(sy/cnt+.5)/H:.5, mask, area:cnt};
}
// Порог с гистерезисом и удержанием: on пока движение ≥ thr и hold секунд после него; rise — фронт включения
function mvGate(st,m,now,thr,hold){
  const was=!!st.on;
  if(m>=thr){ st.last=now; st.on=true; }
  else if(st.on && now-(st.last??-1e9)>=hold) st.on=false;
  return {on:st.on?1:0, rise:st.on&&!was};
}

/* ---------------------------------- Pulse (фотоплетизмография) ---------------------------------- */
// ts (секунды, возрастают), vs → ряд с равным шагом fs, только последние win секунд
function ppgResample(ts,vs,fs,win){
  const n=ts.length; if(n<2) return null;
  const t1=ts[n-1], t0=Math.max(ts[0],t1-win), N=Math.floor((t1-t0)*fs)+1;
  if(N<2) return null;
  const out=new Float32Array(N); let j=0;
  for(let i=0;i<N;i++){
    const t=t0+i/fs;
    while(j<n-2 && ts[j+1]<t) j++;
    const a=ts[j], b=ts[j+1], k=b>a?Math.min(1,Math.max(0,(t-a)/(b-a))):0;
    out[i]=vs[j]+(vs[j+1]-vs[j])*k; }
  return out;
}
// скользящее среднее по центру окна из w отсчётов (края — по доступным)
function ppgBox(x,w){
  const N=x.length, h=Math.max(1,w>>1), out=new Float32Array(N), c=new Float64Array(N+1);
  for(let i=0;i<N;i++) c[i+1]=c[i]+x[i];
  for(let i=0;i<N;i++){ const a=Math.max(0,i-h), b=Math.min(N,i+h+1); out[i]=(c[b]-c[a])/(b-a); }
  return out;
}
// полоса пульса: сглаженное за 0.15 с минус сглаженное за 1 с (нулевая фаза, дёшево)
function ppgBand(x,fs){
  const lo=ppgBox(x,Math.round(fs*.15)), hi=ppgBox(x,Math.round(fs*1.0)), y=new Float32Array(x.length);
  for(let i=0;i<x.length;i++) y[i]=lo[i]-hi[i];
  return y;
}
// Оценка пульса. x — отфильтрованный ряд с шагом 1/fs. fmin/fmax — Гц. Возврат {bpm, conf, f} или null.
function ppgSpectrum(x,fs,fmin,fmax){
  const N=x.length; if(N<fs*4) return null;
  let m=0; for(let i=0;i<N;i++) m+=x[i]; m/=N;
  const w=new Float32Array(N);
  for(let i=0;i<N;i++) w[i]=(x[i]-m)*(.5-.5*Math.cos(2*Math.PI*i/(N-1)));
  const df=.02, K=Math.floor((fmax-fmin)/df)+1, P=new Float64Array(K);
  let tot=0, best=0, bk=-1;
  for(let k=0;k<K;k++){
    const wr=2*Math.PI*(fmin+k*df)/fs; let re=0, im=0;
    for(let i=0;i<N;i++){ const a=wr*i; re+=w[i]*Math.cos(a); im+=w[i]*Math.sin(a); }
    P[k]=re*re+im*im; tot+=P[k];
    if(P[k]>best){ best=P[k]; bk=k; }
  }
  if(bk<0 || tot<=0) return null;
  let kk=bk;                                          // парабола по трём точкам
  if(bk>0 && bk<K-1){ const a=P[bk-1], b=P[bk], c=P[bk+1], d=a-2*b+c; if(d<0) kk=bk+.5*(a-c)/d; }
  const f=fmin+kk*df;
  let sig=0;                                          // мощность вокруг пика и второй гармоники
  for(let k=0;k<K;k++){ const fk=fmin+k*df; if(Math.abs(fk-f)<=.15 || Math.abs(fk-2*f)<=.15) sig+=P[k]; }
  return {bpm:f*60, f, conf:Math.min(1,sig/tot)};
}
// Удары: локальные максимумы выше k·σ с паузой refr секунд. Возврат — индексы.
function ppgBeats(x,fs,refr=.33,k=.25){
  const N=x.length; let s=0; for(let i=0;i<N;i++) s+=x[i]*x[i];
  const thr=k*Math.sqrt(s/Math.max(1,N)), out=[], gap=Math.round(refr*fs);
  for(let i=1;i<N-1;i++){
    if(x[i]>thr && x[i]>=x[i-1] && x[i]>x[i+1]){
      if(out.length && i-out[out.length-1]<gap){ if(x[i]>x[out[out.length-1]]) out[out.length-1]=i; }
      else out.push(i); } }
  return out;
}
// СВР: RMSSD (мс) по интервалам между ударами, выбросы вне 0.3…2 с отбрасываются
function ppgRmssd(beatsSec){
  const d=[]; for(let i=1;i<beatsSec.length;i++){ const v=beatsSec[i]-beatsSec[i-1]; if(v>.3 && v<2) d.push(v); }
  if(d.length<3) return 0;
  let s=0; for(let i=1;i<d.length;i++) s+=(d[i]-d[i-1])**2;
  return Math.sqrt(s/(d.length-1))*1000;
}
// Палец на объективе с вспышкой: кадр красный и яркий. r,g,b — средние 0…1
function ppgFinger(r,g,b){
  const s=r+g+b; return s>.15 && r/s>.55 && r>.35;
}
// Весь расчёт по окну: ts, vs (по каналам — массив рядов) → лучший результат
function ppgAnalyze(ts,chans,o){
  const fs=o.fs||25, win=o.win||10;
  let best=null;
  for(const c of chans){
    const x=ppgResample(ts,c.v,fs,win); if(!x) continue;
    const y=ppgBand(x,fs), sp=ppgSpectrum(y,fs,o.fmin||.7,o.fmax||3.5); if(!sp) continue;
    if(!best || sp.conf>best.conf){
      const t1=ts[ts.length-1], t0=t1-(y.length-1)/fs;
      const idx=ppgBeats(y,fs), bt=idx.map(i=>t0+i/fs);
      best={...sp, chan:c.name, wave:y, fs, t0, beats:bt, rmssd:ppgRmssd(bt)};
    }
  }
  return best;
}

/* ---------------------------------- Timelapse ---------------------------------- */
// пора снимать? o: {now,last (null — ещё не снимали), interval, count, max (0 — без предела)}
function tlDue(o){
  if(o.max>0 && o.count>=o.max) return false;
  return o.last==null || o.now-o.last>=o.interval;
}
// коэффициенты выравнивания яркости (deflicker): цель — скользящее среднее ±win кадров, медленные изменения (закат) сохраняются
function tlGains(means,win){
  const N=means.length, out=new Float32Array(N), c=new Float64Array(N+1);
  for(let i=0;i<N;i++) c[i+1]=c[i]+means[i];
  for(let i=0;i<N;i++){ const a=Math.max(0,i-win), b=Math.min(N,i+win+1), avg=(c[b]-c[a])/(b-a);
    out[i]=means[i]>1e-3 ? Math.max(.5,Math.min(2,avg/means[i])) : 1; }
  return out;
}
// сколько секунд займёт ролик из count кадров
const tlLength=(count,fps)=>count/Math.max(1,fps);

// ZIP без сжатия (store): files = [{name, data:Uint8Array}] → Uint8Array. JPEG всё равно не сжимается.
let _crcT=null;
function zipCrc(b){
  if(!_crcT){ _crcT=new Uint32Array(256); for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c=c&1?0xEDB88320^(c>>>1):c>>>1; _crcT[n]=c>>>0; } }
  let c=0xFFFFFFFF; for(let i=0;i<b.length;i++) c=_crcT[(c^b[i])&255]^(c>>>8);
  return (c^0xFFFFFFFF)>>>0;
}
function zipStore(files){
  const enc=new TextEncoder(), parts=[], cen=[]; let off=0;
  const now=new Date(), dt=((now.getHours()<<11)|(now.getMinutes()<<5)|(now.getSeconds()>>1))&0xFFFF,
        dd=(((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate())&0xFFFF;
  for(const f of files){
    const nm=enc.encode(f.name), crc=zipCrc(f.data), sz=f.data.length;
    const lh=new DataView(new ArrayBuffer(30));
    lh.setUint32(0,0x04034b50,true); lh.setUint16(4,20,true); lh.setUint16(6,0x0800,true); lh.setUint16(8,0,true);
    lh.setUint16(10,dt,true); lh.setUint16(12,dd,true); lh.setUint32(14,crc,true); lh.setUint32(18,sz,true); lh.setUint32(22,sz,true);
    lh.setUint16(26,nm.length,true); lh.setUint16(28,0,true);
    parts.push(new Uint8Array(lh.buffer),nm,f.data);
    const ch=new DataView(new ArrayBuffer(46));
    ch.setUint32(0,0x02014b50,true); ch.setUint16(4,20,true); ch.setUint16(6,20,true); ch.setUint16(8,0x0800,true); ch.setUint16(10,0,true);
    ch.setUint16(12,dt,true); ch.setUint16(14,dd,true); ch.setUint32(16,crc,true); ch.setUint32(20,sz,true); ch.setUint32(24,sz,true);
    ch.setUint16(28,nm.length,true); ch.setUint32(42,off,true);
    cen.push(new Uint8Array(ch.buffer),nm);
    off+=30+nm.length+sz;
  }
  let cs=0; for(const p of cen) cs+=p.length;
  const end=new DataView(new ArrayBuffer(22));
  end.setUint32(0,0x06054b50,true); end.setUint16(8,files.length,true); end.setUint16(10,files.length,true);
  end.setUint32(12,cs,true); end.setUint32(16,off,true);
  const all=[...parts,...cen,new Uint8Array(end.buffer)];
  let total=0; for(const p of all) total+=p.length;
  const out=new Uint8Array(total); let o=0; for(const p of all){ out.set(p,o); o+=p.length; }
  return out;
}

/* ---------------------------------- Color / Spectrometer ---------------------------------- */
// sRGB 0…1 → линейный
const colLin=v=>v<=.04045 ? v/12.92 : Math.pow((v+.055)/1.055,2.4);
// sRGB 0…1 → XYZ (D65)
function colXYZ(r,g,b){
  const R=colLin(r), G=colLin(g), B=colLin(b);
  return [.4124564*R+.3575761*G+.1804375*B, .2126729*R+.7151522*G+.0721750*B, .0193339*R+.1191920*G+.9503041*B];
}
// коррелированная цветовая температура (McCamy), К; 0 — для чёрного
function colCCT(r,g,b){
  const [X,Y,Z]=colXYZ(r,g,b), s=X+Y+Z; if(s<1e-6) return 0;
  const x=X/s, y=Y/s, n=(x-.3320)/(.1858-y);
  return Math.round(449*n*n*n+3525*n*n+6823.3*n+5520.33);
}
function colHSV(r,g,b){
  const mx=Math.max(r,g,b), mn=Math.min(r,g,b), d=mx-mn; let h=0;
  if(d>0){ h=mx===r ? ((g-b)/d)%6 : mx===g ? (b-r)/d+2 : (r-g)/d+4; h*=60; if(h<0) h+=360; }
  return {h, s:mx?d/mx:0, v:mx};
}
const colHex=(r,g,b)=>'#'+[r,g,b].map(v=>Math.round(Math.min(1,Math.max(0,v))*255).toString(16).padStart(2,'0')).join('');
const COL_NAMES=[['black',0,0,0],['white',255,255,255],['gray',128,128,128],['red',255,0,0],['red',200,20,30],['orange',255,140,0],['yellow',250,230,30],
  ['lime',130,220,40],['green',20,150,50],['teal',0,140,140],['cyan',0,220,230],['blue',30,60,220],['navy',10,20,100],
  ['purple',130,40,170],['magenta',220,30,200],['pink',255,150,190],['brown',120,70,30],['beige',225,205,165]];
// ближайшее имя цвета (в линейном RGB — ближе к глазу, чем в sRGB)
function colName(r,g,b){
  const L=[colLin(r),colLin(g),colLin(b)]; let best='', bd=1e9;
  for(const [nm,R,G,B] of COL_NAMES){
    const d=(L[0]-colLin(R/255))**2+(L[1]-colLin(G/255))**2+(L[2]-colLin(B/255))**2;
    if(d<bd){ bd=d; best=nm; } }
  return best;
}
// средний цвет прямоугольника z=[x,y,w,h] (доли) кадра ImageData-подобного вида; шаг выборки st
function colMean(id,z,st=2){
  const W=id.width, H=id.height, d=id.data;
  const x0=Math.max(0,Math.floor(z[0]*W)), y0=Math.max(0,Math.floor(z[1]*H));
  const x1=Math.min(W,Math.max(x0+1,Math.ceil((z[0]+z[2])*W))), y1=Math.min(H,Math.max(y0+1,Math.ceil((z[1]+z[3])*H)));
  let r=0,g=0,b=0,c=0;
  for(let y=y0;y<y1;y+=st) for(let x=x0;x<x1;x+=st){ const i=(y*W+x)*4; r+=d[i]; g+=d[i+1]; b+=d[i+2]; c++; }
  return c ? [r/c/255,g/c/255,b/c/255] : [0,0,0];
}
// Спектр по полосе строк [y0,y1) (доли высоты): для каждого столбца средняя яркость и r,g,b. Возврат {v,r,g,b} длиной W.
function specProfile(id,y0,y1){
  const W=id.width, H=id.height, d=id.data;
  const a=Math.max(0,Math.floor(y0*H)), b=Math.min(H,Math.max(a+1,Math.ceil(y1*H)));
  const v=new Float32Array(W), R=new Float32Array(W), G=new Float32Array(W), B=new Float32Array(W);
  for(let x=0;x<W;x++){
    let r=0,g=0,bl=0;
    for(let y=a;y<b;y++){ const i=(y*W+x)*4; r+=d[i]; g+=d[i+1]; bl+=d[i+2]; }
    const k=1/(b-a)/255; R[x]=r*k; G[x]=g*k; B[x]=bl*k; v[x]=.299*R[x]+.587*G[x]+.114*B[x]; }
  return {v,r:R,g:G,b:B};
}
// калибровка по двум линиям: столбец (доля ширины) ↔ длина волны, нм. Прямая; cal={x1,nm1,x2,nm2}
function specNm(x,cal){ return cal.nm1+(x-cal.x1)*(cal.nm2-cal.nm1)/((cal.x2-cal.x1)||1e-9); }
function specX(nm,cal){ return cal.x1+(nm-cal.nm1)*(cal.x2-cal.x1)/((cal.nm2-cal.nm1)||1e-9); }
// скользящее среднее профиля шириной w и вычитание тёмного кадра (dark — Float32Array той же длины или null), результат ≥ 0
function specClean(p,dark,w){
  const N=p.length, out=new Float32Array(N);
  for(let i=0;i<N;i++) out[i]=Math.max(0,p[i]-(dark&&dark.length===N?dark[i]:0));
  return w>1 ? ppgBox(out,w) : out;
}
// линии спектра: локальные максимумы выше rel·max, не ближе minDist столбцов (берётся более высокий); центр — парабола. Возврат [{x (дробный столбец), v}], по убыванию v
function specPeaks(p,rel=.15,minDist=4){
  const N=p.length; let mx=0; for(let i=0;i<N;i++) if(p[i]>mx) mx=p[i];
  if(mx<=0) return [];
  const out=[];
  for(let i=1;i<N-1;i++){
    if(p[i]>=rel*mx && p[i]>=p[i-1] && p[i]>p[i+1]){
      const a=p[i-1], b=p[i], c=p[i+1], d=a-2*b+c, x=d<0 ? i+.5*(a-c)/d : i;
      out.push({x, v:b}); } }
  out.sort((a,b)=>b.v-a.v);
  const keep=[]; for(const q of out) if(keep.every(k=>Math.abs(k.x-q.x)>=minDist)) keep.push(q);
  return keep;
}
// цвет длины волны для раскраски шкалы (380…780 нм), 0…255
function wlRGB(nm){
  let r=0,g=0,b=0;
  if(nm>=380 && nm<440){ r=-(nm-440)/60; b=1; }
  else if(nm<490){ g=(nm-440)/50; b=1; }
  else if(nm<510){ g=1; b=-(nm-510)/20; }
  else if(nm<580){ r=(nm-510)/70; g=1; }
  else if(nm<645){ r=1; g=-(nm-645)/65; }
  else if(nm<=780){ r=1; }
  const f=nm<380||nm>780 ? 0 : nm<420 ? .3+.7*(nm-380)/40 : nm>700 ? .3+.7*(780-nm)/80 : 1;
  const c=v=>Math.round(255*Math.pow(Math.max(0,v*f),.8));
  return [c(r),c(g),c(b)];
}
// Известные линии ламп для калибровки: люминесцентная (Hg + Tb/Eu) — 436, 546, 611 нм
const SPEC_REF=[{name:'Hg 436',nm:436.6},{name:'Hg 546',nm:546.1},{name:'Eu 611',nm:611.6}];
// Калибровка по трём и более известным линиям: xs — столбцы (доли ширины), nms — длины волн, нм; МНК-прямая nm(x).
// Возврат {x1,nm1,x2,nm2} (крайние линии) или null; rms — невязка, нм.
function specFit(xs,nms){
  const n=xs.length; if(n<2) return null;
  let sx=0,sy=0,sxx=0,sxy=0;
  for(let i=0;i<n;i++){ sx+=xs[i]; sy+=nms[i]; sxx+=xs[i]*xs[i]; sxy+=xs[i]*nms[i]; }
  const d=n*sxx-sx*sx; if(Math.abs(d)<1e-12) return null;
  const a=(n*sxy-sx*sy)/d, b=(sy-a*sx)/n;           // nm = a·x + b
  let e=0; for(let i=0;i<n;i++) e+=(a*xs[i]+b-nms[i])**2;
  const x1=Math.min(...xs), x2=Math.max(...xs);
  return {x1, nm1:a*x1+b, x2, nm2:a*x2+b, rms:Math.sqrt(e/n)};
}
// какие из линий лампы соответствуют найденным пикам (по порядку слева направо): берём count самых ярких и сортируем по x
function specMatchRef(peaks,ref){
  const top=peaks.slice(0,ref.length).sort((a,b)=>a.x-b.x);
  return top.length<2 ? null : {xs:top.map(p=>p.x), nms:ref.slice(0,top.length).map(r=>r.nm)};
}

/* ---------------------------------- Screen: пиксель экрана ---------------------------------- */
// квадрат (2r+1)² вокруг точки (fx,fy — доли кадра w×h), обрезанный по кадру
function scrRect(fx,fy,w,h,r){
  const x=Math.min(w-1,Math.max(0,Math.round(fx*(w-1)))), y=Math.min(h-1,Math.max(0,Math.round(fy*(h-1))));
  const x0=Math.max(0,x-r), y0=Math.max(0,y-r), x1=Math.min(w,x+r+1), y1=Math.min(h,y+r+1);
  return {x0,y0,w:x1-x0,h:y1-y0,x,y};
}
// кадр w×h «вписан» в холст W×H с сохранением пропорций → {k,x,y,w,h}; и обратно: точка холста → доли кадра
function scrFit(W,H,w,h){ const k=Math.min(W/w,H/h); return {k,x:(W-w*k)/2,y:(H-h*k)/2,w:w*k,h:h*k}; }
function scrUnfit(f,px,py){ return [Math.min(1,Math.max(0,(px-f.x)/f.w)),Math.min(1,Math.max(0,(py-f.y)/f.h))]; }
// '#rrggbb' / '#rgb' / 'rrggbb' → [r,g,b] 0…1 или null (EyeDropper отдаёт sRGBHex)
function colParseHex(s){
  const m=/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(s||'').trim()); if(!m) return null;
  let h=m[1]; if(h.length===3) h=h.replace(/./g,c=>c+c);
  return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16)/255);
}
