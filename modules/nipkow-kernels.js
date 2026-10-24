"use strict";
/* ============================ Диск Нипкова: ядра блоков ============================
   Механическое телевидение: диск с отверстиями по спирали(ям) разворачивает кадр в одномерный сигнал (звуковой).
   Один оборот диска даёт k полей (k — число спиралей); в поле N строк (по отверстию на строку).
   Варианты диска (параметры, общие для передачи и приёма):
     lines      — строк в поле (отверстий на спираль);
     spirals    — число спиралей k (полей за оборот);
     interlace  — спирали сдвинуты по радиусу на 1/k шага: поля чересстрочные, кадр = k полей (N·k строк);
                  иначе спирали одинаковы и каждое поле — отдельный кадр;
     sweep      — с какого края начинается развёртка (внешний / внутренний радиус);
     rot        — направление вращения (в «дисковой» геометрии зеркалит картинку);
     aspect     — пропорции окна → внутренний радиус спирали подбирается так, чтобы окно было такой формы;
     sync       — pulse (отдельный сигнал раз в оборот), in-band (лишнее «синхроотверстие» в каждом поле:
                  уровень −1, ниже чёрного; у поля 0 — весь слот, у остальных — только его половина),
                  none / free (без синхронизации), auto (период по автокорреляции).
   Геометрия: scene / view = flat (строки прямые) или disk (отверстие чертит дугу радиуса r — кадр кривится как у настоящего диска).
   Сигнал: строка из M пикселей, уровень −1…1, чёрный = −1 (с in-band −0.6), белый = +1.
   Без DOM: файл грузится и в тесты через vm. Все функции начинаются с nip. */

const NIP_STD={
  'Baird 30-line, 12.5 fps':       {lines:'30',spirals:'1',interlace:false,fps:12.5,px:'auto',aspect:'3:7', sweep:'outer → inner',rot:'cw', sync:'pulse'},
  'Classic 24-line, 10 fps':       {lines:'24',spirals:'1',interlace:false,fps:10,  px:'auto',aspect:'3:4', sweep:'outer → inner',rot:'cw', sync:'pulse'},
  'Jenkins-style 48-line, 15 fps': {lines:'48',spirals:'1',interlace:false,fps:15,  px:'auto',aspect:'1:1', sweep:'outer → inner',rot:'cw', sync:'pulse'},
  'Bell Labs-style 50-line, 18 fps':{lines:'50',spirals:'1',interlace:false,fps:18, px:'auto',aspect:'4:3', sweep:'outer → inner',rot:'cw', sync:'pulse'},
  '2 spirals, 2×24 interlaced, 12.5 fps':{lines:'24',spirals:'2',interlace:true, fps:12.5,px:'auto',aspect:'3:4',sweep:'outer → inner',rot:'cw',sync:'pulse'},
  '3 spirals, 3×16 interlaced, 10 fps':  {lines:'16',spirals:'3',interlace:true, fps:10,  px:'auto',aspect:'3:4',sweep:'outer → inner',rot:'cw',sync:'pulse'},
  '2 spirals, 2 pictures per turn, 30-line':{lines:'30',spirals:'2',interlace:false,fps:25,px:'auto',aspect:'3:7',sweep:'outer → inner',rot:'cw',sync:'pulse'},
  'Inner-start 32-line, CCW':      {lines:'32',spirals:'1',interlace:false,fps:12.5,px:'auto',aspect:'1:2', sweep:'inner → outer',rot:'ccw',sync:'pulse'},
  'Baird 30-line, in-band sync':   {lines:'30',spirals:'1',interlace:false,fps:12.5,px:'auto',aspect:'3:7', sweep:'outer → inner',rot:'cw', sync:'in-band'},
  'Interlaced 2×24, in-band sync': {lines:'24',spirals:'2',interlace:true, fps:12.5,px:'auto',aspect:'3:4', sweep:'outer → inner',rot:'cw', sync:'in-band'},
  'Slow scan 64-line, 1 fps':      {lines:'64',spirals:'1',interlace:false,fps:1,   px:'auto',aspect:'1:1', sweep:'outer → inner',rot:'cw', sync:'pulse'},
};
const NIP_ASPECTS=['3:7','1:2','3:4','1:1','4:3','16:9'];

function nipClamp(v,a,b){ return v<a?a:v>b?b:v; }

// Параметры (строки из селектов и числа) → вычисленная конфигурация диска.
function nipCfg(o,sr){
  const N=nipClamp(Math.round(+o.lines||30),2,512), k=nipClamp(Math.round(+o.spirals||1),1,8);
  const il=!!o.interlace && k>1, fps=nipClamp(+o.fps||12.5,.05,100);
  const sk=o.sync==='in-band' ? 'band' : o.sync==='pulse' ? 'pulse' : o.sync==='auto' ? 'auto' : 'free';
  const S=sk==='band'?1:0, R=il?N*k:N, fieldRate=il?fps*k:fps, revRate=fieldRate/k;
  let M=Math.round(+o.px)||0;
  if(!M) M=nipClamp(Math.floor(sr/(4*fieldRate*(N+S))),8,128);     // ~4 отсчёта на пиксель: приёмник попадает в центр пикселя с запасом ±1 отсчёт
  M=nipClamp(M,4,512);
  const pa=String(o.aspect||'3:7').split(':'), asp=nipClamp((+pa[0]||3)/(+pa[1]||7),.1,10);
  const alpha=2*Math.PI/(k*(N+S)), th=(.5-.5/M)*alpha, th0=M%2?0:.5*alpha/M;
  const bb=rin=>{ const dr=(1-rin)/R, rmax=1-dr/2, rmin=rin+dr/2, umax=rmax*Math.sin(th), vmax=rmax*Math.cos(th0), vmin=rmin*Math.cos(th);
    return {umax,vmax,vmin,w:2*umax,h:vmax-vmin}; };
  let lo=.02, hi=.98;                                              // w/h растёт с внутренним радиусом
  for(let i=0;i<40;i++){ const mid=(lo+hi)/2, b=bb(mid); if(b.w/b.h<asp) lo=mid; else hi=mid; }
  const rin=(lo+hi)/2, b=bb(rin);
  return {N,k,il,R,S,M,fps,fieldRate,revRate,sk,alpha,rin,umax:b.umax,vmax:b.vmax,vmin:b.vmin,bw:b.w,bh:b.h,
    outer:o.sweep!=='inner → outer', mirror:o.rot==='ccw', black:S?-.6:-1};
}
function nipRad(c,l){ const dr=(1-c.rin)/c.R; return c.outer ? 1-(l+.5)*dr : c.rin+(l+.5)*dr; }

/* ---- тестовая картинка и источник ---- */
// Смайлик на градиенте с рамкой: видно ориентацию, пропорции и кривизну. → Float32Array w*h, 0…1.
function nipTestPattern(w,h){
  const g=new Float32Array(w*h);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const u=(x+.5)/w, v=(y+.5)/h; let s=.12+.28*v;
    const dx=(u-.5)/.38, dy=(v-.5)/.38*(h/w), r2=dx*dx+dy*dy;
    if(r2<1){ s=.85;
      const ex=Math.abs(Math.abs(dx)-.38), ey=dy+.28; if(ex*ex+ey*ey<.025) s=.08;
      const my=dy-.3; if(r2>.30 && r2<.45 && my>-.05 && my*my<.09*(1-dx*dx*3)) s=.1; }
    if(u<.03||u>.97||v<.025||v>.975) s=1;
    if(u<.07 && v<.1 && u>.03 && v>.025) s=0;                      // метка верхнего левого угла
    g[y*w+x]=s; }
  return g;
}
// img-объект блока (серый буфер или ImageData) → {g,w,h} яркость 0…1.
function nipGray(img){
  if(!img || !img.w || !img.h) return null;
  const w=img.w, h=img.h, g=new Float32Array(w*h);
  if(img.gray && img.buf){ for(let i=0;i<w*h;i++) g[i]=img.buf[i]; return {g,w,h}; }
  const d=img.data && img.data.data; if(!d) return null;
  for(let i=0;i<w*h;i++) g[i]=(d[i*4]*.299+d[i*4+1]*.587+d[i*4+2]*.114)/255;
  return {g,w,h};
}

// Обрезка по центру до нужных пропорций (w/h) без искажения — «cover».
function nipCover(im,asp){
  if(!im) return null;
  const a=im.w/im.h; let cw=im.w, ch=im.h;
  if(a>asp) cw=Math.max(1,Math.round(im.h*asp)); else ch=Math.max(1,Math.round(im.w/asp));
  if(cw===im.w && ch===im.h) return im;
  const x0=Math.floor((im.w-cw)/2), y0=Math.floor((im.h-ch)/2), g=new Float32Array(cw*ch);
  for(let y=0;y<ch;y++) for(let x=0;x<cw;x++) g[y*cw+x]=im.g[(y0+y)*im.w+x0+x];
  return {g,w:cw,h:ch};
}

/* ---- передача ---- */
// Для каждой пары (строка в порядке развёртки, пиксель) — нормированная координата в окне 0…1 (y сверху вниз).
function nipSrcMap(c,optical){
  const R=c.R, M=c.M, X=new Float32Array(R*M), Y=new Float32Array(R*M);
  for(let l=0;l<R;l++){ const r=nipRad(c,l);
    for(let m=0;m<M;m++){ const i=l*M+m;
      if(!optical){ X[i]=(m+.5)/M; Y[i]=(l+.5)/R; continue; }
      let t=((m+.5)/M-.5)*c.alpha; if(c.mirror) t=-t;
      X[i]=nipClamp((r*Math.sin(t)+c.umax)/(2*c.umax),0,1);
      Y[i]=nipClamp((c.vmax-r*Math.cos(t))/(c.vmax-c.vmin),0,1); } }
  return {X,Y};
}
// Выборка источника (w×h серый) в пиксели развёртки: out[R*M].
function nipPixels(c,map,g,gw,gh,out,invert){
  const n=c.R*c.M;
  for(let i=0;i<n;i++){
    const fx=map.X[i]*gw-.5, fy=map.Y[i]*gh-.5, x0=Math.floor(fx), y0=Math.floor(fy), ax=fx-x0, ay=fy-y0;
    const xa=nipClamp(x0,0,gw-1), xb=nipClamp(x0+1,0,gw-1), ya=nipClamp(y0,0,gh-1), yb=nipClamp(y0+1,0,gh-1);
    const v=(g[ya*gw+xa]*(1-ax)+g[ya*gw+xb]*ax)*(1-ay)+(g[yb*gw+xa]*(1-ax)+g[yb*gw+xb]*ax)*ay;
    out[i]=invert?1-v:v; }
}
function nipTxNew(){ return {ph:0,pl:0}; }
// len отсчётов сигнала: level (−1…1), sync (импульс раз в оборот; только sync='pulse').
function nipTxRun(st,c,sr,pix,level,sync,len){
  const dph=c.revRate/sr, k=c.k, S=c.S, N=c.N, M=c.M, slots=N+S, black=c.black;
  const pw=Math.max(1,Math.ceil(.15*sr/(c.fieldRate*slots)));
  for(let i=0;i<len;i++){
    if(st.ph>=1){ st.ph-=1; st.pl=pw; }                            // начало оборота: фаза отсчёта 0…1 отсчёта
    const q=st.ph*k, f=Math.min(k-1,Math.floor(q)), sl=(q-f)*slots, s=Math.min(slots-1,Math.floor(sl)), t=sl-s;
    let v;
    if(S && s===0) v=(f===0 || t<.5) ? -1 : black;                 // синхро-слот: поле 0 целиком, остальные — первая половина
    else { const j=s-S, row=c.il?j*k+f:j; v=black+(1-black)*pix[row*M+Math.min(M-1,Math.floor(t*M))]; }
    level[i]=v;
    if(sync){ sync[i]=c.sk==='pulse' && st.pl>0 ? 1 : 0; }
    if(st.pl>0) st.pl--;
    st.ph+=dph; }
}

/* ---- приём ---- */
function nipRxNew(c,sr){
  const Pf=sr/c.fieldRate;
  return {Pf,Pr:Pf*c.k,Pnom:Pf*c.k,fld:0,fp:0,scan:new Float32Array(c.R*c.M),cur:-1,acc:0,cnt:0,
    in:0,rs:0,lc:0,hc:0,ev:0,last:0,psy:0,since:1e9,age:1e9,fields:0,dirty:false,bd:9,bv:0,
    hb:c.sk==='auto' ? new Float32Array(Math.ceil(Pf*c.k*2.4)+8) : null,hp:0,hn:0,sa:0,strength:0,lo:0,hi:1,tune:0};
}
// Один поток отсчётов. o: {shift (доля поля), trim (ppm), invert}.
function nipRxRun(st,c,sr,x,sy,len,o){
  const k=c.k, S=c.S, N=c.N, M=c.M, slots=N+S, black=c.black, thr=(-1+black)/2;
  if(c.sk==='free'){ st.Pr=st.Pnom*(1+(+o.trim||0)*1e-6); st.Pf=st.Pr/k; }
  else if(c.sk==='auto' && !st.strength){ st.Pr=st.Pnom*(1+(+o.trim||0)*1e-6); st.Pf=st.Pr/k; }
  const shift=+o.shift||0;
  for(let i=0;i<len;i++){
    const raw=x?x[i]:0;
    st.since++; st.age++;
    if(c.sk==='pulse' && sy){
      const e=sy[i]>.5;
      if(e && st.psy<=.5){
        if(st.since>.8*st.Pr && st.since<1.2*st.Pr){ st.Pr+=.25*(st.since-st.Pr); st.Pf=st.Pr/k; }
        if(st.fp>.5){ st.fields++; st.dirty=true; }
        st.fld=0; st.fp=0; st.since=0; st.age=0; }
      st.psy=e?1:0; }
    else if(c.sk==='band'){
      // синхро-слот: серия отсчётов ниже порога (допускается провал на 2 отсчёта); начало серии даёт точную фазу поля
      const slotLen=st.Pf/slots, Lmin=Math.max(2,Math.floor(.3*slotLen));
      if(st.in) st.rs++;
      if(raw<thr){
        if(!st.in){ st.in=1; st.rs=0; st.lc=0; st.ev=0; }
        st.lc++; st.hc=0; st.last=st.rs;
        if(!st.ev && st.lc>=Lmin){
          st.ev=1;
          const iv=st.since-st.rs;
          if(iv>.8*st.Pf && iv<1.2*st.Pf) st.Pf+=.2*(iv-st.Pf);
          if(st.fp>.5){ st.fld=(st.fld+1)%k; st.fields++; st.dirty=true; }
          st.fp=st.rs/st.Pf; st.since=st.rs; st.age=0; } }
      else if(st.in && ++st.hc>2){ st.in=0; if(k>1 && st.last+1>.75*slotLen) st.fld=0; } }
    else if(c.sk==='auto'){
      st.hb[st.hp]=raw; st.hp=(st.hp+1)%st.hb.length; if(st.hn<st.hb.length) st.hn++;
      if(++st.sa>=sr && st.hn===st.hb.length){ st.sa=0; nipAutoStep(st,c); } }
    // раскладка отсчёта по полю / слоту / пикселю
    let fpe=st.fp+shift; fpe-=Math.floor(fpe);
    const sl=fpe*slots, s=Math.min(slots-1,Math.floor(sl)), t=sl-s;
    if(S && s===0){ nipFlush(st); st.cur=-1; }
    else {
      const j=s-S, row=c.il?j*k+st.fld:j, idx=row*M+Math.min(M-1,Math.floor(t*M));
      if(idx!==st.cur){ nipFlush(st); st.cur=idx; }
      let p=(raw-black)/(1-black); if(o.invert) p=1-p;
      const dc=Math.abs(t*M-Math.floor(t*M)-.5);                    // расстояние до центра пикселя; края пикселя не берём — они смешиваются с соседним
      if(dc<.2){ st.acc+=p; st.cnt++; }
      if(dc<st.bd){ st.bd=dc; st.bv=p; } }
    st.fp+=1/st.Pf;
    if(st.fp>=1){ st.fp-=1; st.fld=(st.fld+1)%k; st.fields++; st.dirty=true; }
  }
}
function nipFlush(st){
  if(st.cur>=0){ st.scan[st.cur]=st.cnt ? st.acc/st.cnt : st.bv; }
  st.acc=0; st.cnt=0; st.bd=9; st.bv=0;
}
function nipLock(st,c){
  return c.sk==='pulse' ? (st.age<2.5*st.Pr?1:0) : c.sk==='band' ? (st.age<2.5*st.Pf?1:0) : c.sk==='auto' ? (st.strength>.3?1:0) : 0;
}
function nipAutoStep(st,c){
  const L=st.hb.length, a=new Float32Array(L);
  for(let i=0;i<L;i++) a[i]=st.hb[(st.hp+i)%L];                    // от старого к новому
  const lim=.06, r=nipPeriod(a,nipClamp(st.Pr,st.Pnom*(1-lim),st.Pnom*(1+lim)),st.strength?.02:lim);
  if(!r || r.s<.25){ st.strength*=.5; return; }
  st.Pr=nipClamp(st.strength ? st.Pr+.5*(r.P-st.Pr) : r.P,st.Pnom*(1-lim),st.Pnom*(1+lim)); st.Pf=st.Pr/c.k; st.strength=r.s;
}
// Период повторения сигнала около P (отсчётов): автокорреляция в окне длиной P, лаги P·(1±tol).
// Сначала на прореженном сигнале, потом уточнение на полном. → {P, s} (s — нормированная корреляция) или null.
function nipPeriod(a,P,tol){
  const L=a.length; let mean=0; for(let i=0;i<L;i++) mean+=a[i]; mean/=L;
  const d=Math.max(1,Math.floor(P/1200)), n=Math.floor(L/d), dec=new Float32Array(n);
  for(let i=0;i<n;i++){ let s=0; for(let j=0;j<d;j++) s+=a[i*d+j]; dec[i]=s/d-mean; }
  const W=Math.floor(P/d), lo=Math.floor(P*(1-tol)/d); let hi=Math.ceil(P*(1+tol)/d);
  if(W+hi>=n) hi=n-1-W;
  if(hi<=lo) return null;
  const best=(arr,W,lo,hi)=>{
    let ea=0; for(let i=0;i<W;i++) ea+=arr[i]*arr[i];
    if(ea<1e-12) return null;
    let eb=0; for(let i=0;i<W;i++) eb+=arr[lo+i]*arr[lo+i];
    const cs=[]; let bi=-1, bv=-2;
    for(let t=lo;t<=hi;t++){
      let x=0; for(let i=0;i<W;i++) x+=arr[i]*arr[t+i];
      const cc=eb>1e-12 ? x/Math.sqrt(ea*eb) : 0; cs.push(cc); if(cc>bv){ bv=cc; bi=t-lo; }
      eb+=arr[t+W]*arr[t+W]-arr[t]*arr[t]; }
    let dl=0; if(bi>0 && bi<cs.length-1){ const y0=cs[bi-1], y1=cs[bi], y2=cs[bi+1], q=y0-2*y1+y2; if(q<0) dl=.5*(y0-y2)/q; }
    return {t:lo+bi+dl, s:bv}; };
  const r1=best(dec,W,lo,hi); if(!r1) return null;
  const full=new Float32Array(L); for(let i=0;i<L;i++) full[i]=a[i]-mean;
  const c1=r1.t*d, W2=Math.floor(P), lo2=Math.max(1,Math.floor(c1-d-1));
  let hi2=Math.ceil(c1+d+1); if(W2+hi2>=L) hi2=L-1-W2;
  if(hi2<=lo2) return {P:c1,s:r1.s};
  const r2=best(full,W2,lo2,hi2);
  return r2 ? {P:r2.t,s:r2.s} : {P:c1,s:r1.s};
}

/* ---- картинка из пикселей развёртки ---- */
// Таблица отображения «пиксель холста → 4 соседних пикселя развёртки» для вида flat (прямые строки) или disk (дуги).
function nipViewTab(c,W,optical){
  const H=nipClamp(Math.round(W*c.bh/c.bw),8,1600), n=W*H, R=c.R, M=c.M;
  const i0=new Int32Array(n), i1=new Int32Array(n), i2=new Int32Array(n), i3=new Int32Array(n), fa=new Float32Array(n), fb=new Float32Array(n);
  for(let py=0;py<H;py++) for(let px=0;px<W;px++){
    const q=py*W+px, x=(px+.5)/W, y=(py+.5)/H; let ll, mm;
    if(!optical){ mm=x*M-.5; ll=y*R-.5; }
    else {
      const u=(2*x-1)*c.umax, v=c.vmax-y*(c.vmax-c.vmin), r=Math.hypot(u,v); let t=Math.atan2(u,v); if(c.mirror) t=-t;
      ll=c.outer ? (1-r)/(1-c.rin)*R-.5 : (r-c.rin)/(1-c.rin)*R-.5; mm=(t/c.alpha+.5)*M-.5; }
    if(ll<-.5 || ll>R-.5 || mm<-.5 || mm>M-.5){ i0[q]=-1; continue; }
    const l0=Math.floor(ll), m0=Math.floor(mm); fa[q]=ll-l0; fb[q]=mm-m0;
    const la=nipClamp(l0,0,R-1), lb=nipClamp(l0+1,0,R-1), ma=nipClamp(m0,0,M-1), mb=nipClamp(m0+1,0,M-1);
    i0[q]=la*M+ma; i1[q]=la*M+mb; i2[q]=lb*M+ma; i3[q]=lb*M+mb; }
  return {w:W,h:H,i0,i1,i2,i3,fa,fb};
}
// scan → dst (w*h), растяжка уровней lo…hi; вне диска (углы окна) — 0.
function nipRender(scan,tab,dst,lo,hi){
  const n=tab.w*tab.h, k=1/Math.max(1e-6,hi-lo);
  for(let q=0;q<n;q++){
    if(tab.i0[q]<0){ dst[q]=0; continue; }
    const a=tab.fa[q], b=tab.fb[q];
    const v=(scan[tab.i0[q]]*(1-b)+scan[tab.i1[q]]*b)*(1-a)+(scan[tab.i2[q]]*(1-b)+scan[tab.i3[q]]*b)*a;
    dst[q]=nipClamp((v-lo)*k,0,1); }
}
// Границы яркости развёртки для автоуровня (2% и 98% перцентили, грубо).
function nipLevels(scan){
  const n=scan.length, s=Float32Array.from(scan).sort(), lo=s[Math.floor(n*.02)], hi=s[Math.min(n-1,Math.floor(n*.98))];
  return hi-lo<.02 ? [lo,lo+.02] : [lo,hi];
}
