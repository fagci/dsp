"use strict";
/* ============================ Модем: сигнальный уровень (без DOM) ============================
   Всё внутри модема считается на 12 кГц (MDM_FS): телефонная полоса < 4 кГц, а ресемплер на входе и выходе блока
   приводит к частоте звуковой карты. Здесь: ресемплер, V.21-подобный FSK (300 бод), QAM-передатчик (RRC, несущая) и приёмник
   (понижение, ФНЧ, T/2-эквалайзер, обучение методом наименьших квадратов, ФАПЧ, срез точек), телефонная линия (полоса,
   шум, задержка, µ-law). Протокол и автомат — в modem-kernels.js. Приёмник QAM принимает только то, что передаёт этот же
   передатчик: это не совместимый с настоящим V.34 тракт (нет решётчатого кода и оболочечного отображения). */

const MDM_FS=12000, MDM_2PI=Math.PI*2;

function mdmRng(seed){ let s=(seed>>>0)||1; return ()=>{ s^=s<<13; s>>>=0; s^=s>>>17; s>>>=0; s^=s<<5; s>>>=0; return s/4294967296; }; }
function mdmGauss(r){ const u=Math.max(r(),1e-12), v=r(); return Math.sqrt(-2*Math.log(u))*Math.cos(MDM_2PI*v); }
function mdmCrc16(a){ let c=0xFFFF; for(let i=0;i<a.length;i++){ c^=a[i]<<8; for(let k=0;k<8;k++) c=(c&0x8000)?((c<<1)^0x1021)&0xFFFF:(c<<1)&0xFFFF; } return c; }
function mdmCrc8(a){ let c=0xFF; for(let i=0;i<a.length;i++){ c^=a[i]; for(let k=0;k<8;k++) c=(c&0x80)?((c<<1)^0x07)&0xFF:(c<<1)&0xFF; } return c; }

// ---------- ресемплер (оконный sinc, любое отношение частот; поток блоками) ----------
function mdmResamp(fin,fout){
  const L=12, fc=0.9*Math.min(fin,fout)/2/fin, W=Math.ceil(L/(2*fc)), S=512, H=new Float32Array(2*W*S+2);
  for(let i=0;i<H.length;i++){ const t=i/S-W, s=t===0?2*fc:Math.sin(MDM_2PI*fc*t/2*2)/(Math.PI*t);
    const w=0.42+0.5*Math.cos(Math.PI*t/W)+0.08*Math.cos(2*Math.PI*t/W); H[i]=s*w; }
  const r=fin/fout; let tail=new Float64Array(0), pos=W;
  return {W, run(x,n,out){                       // out — массив-приёмник (push) либо создаётся новый; возвращает массив выходов
    const d=new Float64Array(tail.length+n); d.set(tail); for(let i=0;i<n;i++) d[tail.length+i]=x[i];
    const res=out||[]; let p=pos; const lim=d.length-W-1;
    while(p<lim){ const ip=Math.floor(p), fr=p-ip; let a=0;
      for(let j=ip-W+1;j<=ip+W;j++){ const k=Math.round((p-j+W)*S); a+=d[j]*H[k]; }
      res.push(a); p+=r; }
    const st=Math.max(0,Math.floor(p)-W-1); tail=d.slice(st); pos=p-st; return res; }};
}

// ---------- сегменты передачи ----------
// Сегмент: {n, i, done, fill(out,off,cnt)→записано, onEnd}; gen(i) даёт отсчёт; until() проверяется раз в 64 отсчёта (после min)
function mdmSeg(n,gen,o){
  o=o||{}; const s={n,i:0,done:false,onEnd:o.onEnd,name:o.name||'',
    fill(out,off,c){ let k=0;
      for(;k<c;k++){
        if(s.i>=s.n || (o.until && s.i>=(o.min||0) && (s.i&63)===0 && o.until())){ s.done=true; break; }
        out[off+k]=gen(s.i++); }
      return k; }};
  return s; }
const mdmMs=ms=>Math.round(ms*MDM_FS/1000);
const mdmSil=(ms,o)=>mdmSeg(ms===Infinity?Infinity:mdmMs(ms),()=>0,o);
function mdmTones(fr,am,ms,o){ const w=fr.map(f=>MDM_2PI*f/MDM_FS); return mdmSeg(ms===Infinity?Infinity:mdmMs(ms),i=>{ let v=0; for(let k=0;k<w.length;k++) v+=am[k]*Math.sin(w[k]*i); return v; },o); }
// ANSam (V.8): 2100 Гц, AM 15 Гц на 20 %, переворот фазы каждые 450 мс
function mdmAnsam(ms,amp,o){ const w=MDM_2PI*2100/MDM_FS, wm=MDM_2PI*15/MDM_FS, hop=mdmMs(450);
  return mdmSeg(mdmMs(ms),i=>amp*(1+0.2*Math.sin(wm*i))*Math.sin(w*i+(Math.floor(i/hop)&1?Math.PI:0)),o); }
// V.21: канал 1 — 980 (1) / 1180 (0), канал 2 — 1650 (1) / 1850 (0), 300 бод
const MDM_FSK={1:{one:980,zero:1180},2:{one:1650,zero:1850}}, MDM_FSKN=MDM_FS/300;
function mdmFskSeg(bits,ch,amp,o){ const f=MDM_FSK[ch], w1=MDM_2PI*f.one/MDM_FS, w0=MDM_2PI*f.zero/MDM_FS; let ph=0;
  return mdmSeg(bits.length*MDM_FSKN,i=>{ ph+=bits[(i/MDM_FSKN)|0]?w1:w0; return amp*Math.sin(ph); },o); }
// октеты → биты: преамбула из 10 единиц (если pre), октет = старт 0, 8 бит от младшего, стоп 1
function mdmOctBits(oct,pre){ const b=[]; if(pre) for(let i=0;i<10;i++) b.push(1);
  for(const v of oct){ b.push(0); for(let k=0;k<8;k++) b.push((v>>k)&1); b.push(1); } return b; }
// многотоновое зондирование: сетка 150 Гц без кратных 600 Гц (структура V.34 L1/L2), фазы Шрёдера
const MDM_PROBE_N=[]; for(let n=1;n<=25;n++) if(n%4) MDM_PROBE_N.push(n);
function mdmProbeSeg(ms,amp,o){ const K=MDM_PROBE_N.length, w=MDM_PROBE_N.map(n=>MDM_2PI*150*n/MDM_FS), ph=MDM_PROBE_N.map((n,k)=>Math.PI*k*k/K);
  return mdmSeg(mdmMs(ms),i=>{ let v=0; for(let k=0;k<K;k++) v+=Math.sin(w[k]*i+ph[k]); return amp*v; },o); }

// ---------- QAM: таблица RRC, отображение, ПСП ----------
function mdmRrcAt(x,b){                           // RRC при T=1
  if(Math.abs(x)<1e-9) return 1+b*(4/Math.PI-1);
  if(Math.abs(Math.abs(x)-1/(4*b))<1e-9) return b/Math.SQRT2*((1+2/Math.PI)*Math.sin(Math.PI/(4*b))+(1-2/Math.PI)*Math.cos(Math.PI/(4*b)));
  const pi=Math.PI; return (Math.sin(pi*x*(1-b))+4*b*x*Math.cos(pi*x*(1+b)))/(pi*x*(1-(4*b*x)*(4*b*x))); }
const MDM_RRC_CACHE={};
function mdmRrcTab(sps,beta,span){
  const key=sps+'|'+beta+'|'+span; if(MDM_RRC_CACHE[key]) return MDM_RRC_CACHE[key];
  const R=16, half=span*sps, N=Math.ceil(2*half*R)+1, g=new Float32Array(N);
  let e=0; for(let i=0;i<N;i++){ g[i]=mdmRrcAt((i/R-half)/sps,beta); }
  for(let t=-half;t<=half+1e-9;t+=1){ const v=mdmRrcAt(t/sps,beta); e+=v*v; }
  const k=1/Math.sqrt(e/sps); for(let i=0;i<N;i++) g[i]*=k;           // E|s|² = 1 при единичных символах
  return MDM_RRC_CACHE[key]={g,R,half}; }
function mdmLfsr(seed){ let s=seed&0x7FFF||1; return ()=>{ const b=((s>>14)^(s>>13))&1; s=((s<<1)|b)&0x7FFF; return b; }; }
const MDM_Q=Math.SQRT1_2;
function mdmQpsk(b1,b0){ return [b1?-MDM_Q:MDM_Q, b0?-MDM_Q:MDM_Q]; }
function mdmPnSyms(seed,n){ const g=mdmLfsr(seed), o=[]; for(let i=0;i<n;i++){ const a=g(), b=g(); o.push(mdmQpsk(a,b)); } return o; }
// заполнитель — отдельный 16-битный регистр (x^16+x^14+x^13+x^11+1), чтобы он не повторял ПСП обучения и маркеры
function mdmLfsr16(seed){ let s=seed&0xFFFF||1; return ()=>{ const b=((s>>15)^(s>>13)^(s>>12)^(s>>10))&1; s=((s<<1)|b)&0xFFFF; return b; }; }
// маркеры B1 и «начало данных»: 16 QPSK-символов (по 2 бита, старшие первыми), подобраны поиском: от любого окна заполнителя,
// ПСП и синхрослова их отделяют ≥ 4 символов, а детектор допускает 2 ошибки
const mdmSymsOf=v=>{ const o=[]; for(let i=15;i>=0;i--){ const q=(v>>>(2*i))&3; o.push(mdmQpsk(q>>1,q&1)); } return o; };
const MDM_MB=mdmSymsOf(0x77E55834), MDM_ME=mdmSymsOf(0x66B46B78), MDM_SYNC=mdmPnSyms(0x2D71,32), MDM_PNSEED=0x4C9D;
const mdmGrayDec=v=>{ let r=0; for(;v;v>>=1) r^=v; return r; };
function mdmQamMap(b){                            // b бит на символ: прямоугольное QAM, код Грея по осям, средняя мощность 1
  const bq=b>>1, bi=b-bq, MI=1<<bi, MQ=1<<bq, sc=1/Math.sqrt(((MI*MI-1)+(MQ*MQ-1))/3);
  const sl=(x,M)=>{ const L=Math.max(0,Math.min(M-1,Math.round((x/sc+M-1)/2))); return L^(L>>1); };
  return {b,bi,bq,sc,
    map(v){ const vi=v>>bq, vq=v&(MQ-1); return [(2*mdmGrayDec(vi)-(MI-1))*sc,(2*mdmGrayDec(vq)-(MQ-1))*sc]; },
    slice(re,im){ const vi=sl(re,MI), vq=sl(im,MQ); return {v:(vi<<bq)|vq, re:(2*mdmGrayDec(vi)-(MI-1))*sc, im:(2*mdmGrayDec(vq)-(MQ-1))*sc}; }}; }
// самосинхронизирующийся скремблер: y = x ^ y[-a] ^ y[-23]
function mdmScr(a){ let s=0; return {tx(x){ const y=(x^(s>>(a-1))^(s>>22))&1; s=((s<<1)|y)>>>0; return y; },
                                    rx(y){ const x=(y^(s>>(a-1))^(s>>22))&1; s=((s<<1)|y)>>>0; return x; }}; }
const MDM_BAUDS=[2400,2800,3000,3200,3429], MDM_CARR=[[1600,1800],[1680,1867],[1800,2000],[1829,1920],[1959,1959]];
const mdmCfg=(bi,ci)=>({B:bi===4?24000/7:MDM_BAUDS[bi],fc:MDM_CARR[bi][ci],beta:0.12,bi,ci});

// Передатчик QAM: один долгоживущий сегмент; next() даёт символ [re,im] или null (конец)
function mdmQamTxSeg(cfg,amp,next,o){
  const sps=MDM_FS/cfg.B, span=6, G=mdmRrcTab(sps,cfg.beta,span), g=G.g, R=G.R, half=G.half, D=span*sps, w=MDM_2PI*cfg.fc/MDM_FS, sc=amp*Math.SQRT2;
  const syms=[]; let k0=0, ended=false, lastK=-1, ph=0;
  const s=mdmSeg(Infinity,i=>{
    const kmin=Math.ceil((i-D-half)/sps), kmax=Math.floor((i-D+half)/sps);
    while(!ended && k0+syms.length-1<kmax){ const a=next(); if(a===null){ ended=true; lastK=k0+syms.length-1; } else syms.push(a); }
    while(k0<kmin && syms.length){ syms.shift(); k0++; }
    let re=0, im=0;
    for(let k=Math.max(kmin,k0);k<=kmax && k-k0<syms.length;k++){ const gi=Math.round((i-(k*sps+D)+half)*R), a=syms[k-k0]; const v=g[gi]; re+=a[0]*v; im+=a[1]*v; }
    const y=sc*(re*Math.cos(ph)-im*Math.sin(ph)); ph+=w; if(ph>MDM_2PI) ph-=MDM_2PI;
    if(ended && i>lastK*sps+D+half) s.n=i;     // конец потока: сегмент закончится на следующем отсчёте
    return y; },o);
  return s; }

// ---------- ФНЧ (Кайзер) и интерполятор ----------
function mdmBessel0(x){ let s=1, t=1; for(let k=1;k<40;k++){ t*=(x/2/k)*(x/2/k); s+=t; } return s; }
function mdmLpfTaps(fcut,trans,A){                // КИХ с линейной ФЧХ, нечётная длина, усиление 1 на постоянной
  const beta=A>50?0.1102*(A-8.7):0.5842*Math.pow(A-21,0.4)+0.07886*(A-21);
  let N=Math.ceil((A-7.95)/(2.285*MDM_2PI*trans/MDM_FS))|1; N=Math.max(41,Math.min(N,321)); if(!(N&1)) N++;
  const h=new Float64Array(N), c=(N-1)/2, wc=MDM_2PI*fcut/MDM_FS, I0=mdmBessel0(beta); let s=0;
  for(let i=0;i<N;i++){ const t=i-c, sinc=t===0?wc/Math.PI:Math.sin(wc*t)/(Math.PI*t), r=t/c, w=mdmBessel0(beta*Math.sqrt(Math.max(0,1-r*r)))/I0; h[i]=sinc*w; s+=h[i]; }
  for(let i=0;i<N;i++) h[i]/=s; return h; }
const MDM_IP=(()=>{ const P=256, T=12, h=new Float32Array((P+1)*T);              // 12 отсчётов, окно Блэкмана
  for(let p=0;p<=P;p++){ const fr=p/P; let s=0; for(let k=0;k<T;k++){ const t=k-5-fr, w=0.42+0.5*Math.cos(Math.PI*t/6.5)+0.08*Math.cos(2*Math.PI*t/6.5);
      h[p*T+k]=(t===0?1:Math.sin(Math.PI*0.9*t)/(Math.PI*0.9*t))*w*0.9; s+=h[p*T+k]; } for(let k=0;k<T;k++) h[p*T+k]/=s; } return {P,T,h}; })();

// ---------- Приёмник QAM ----------
// hooks: verdict({ok,snr,delta}), b1(bytes|null), marker('ME'), data(v,bits), log(text)
const imgEdge_=cfg=>2*cfg.fc-(1+cfg.beta)*cfg.B/2;
function mdmQamRxNew(cfg,o,hooks){
  const NS=o.NS||160, Ntr=o.Ntr||640, Nt=32, T=MDM_FS/cfg.B, span=6, D=span*T;
  const sigEdge=(1+cfg.beta)*cfg.B/2, gap=imgEdge_(cfg)-sigEdge, tr=Math.max(120,gap);
  const lpf=mdmLpfTaps(sigEdge+Math.max(40,gap/2),tr,50), Nf=lpf.length, wmix=MDM_2PI*cfg.fc/MDM_FS;
  const mr=new Float64Array(2*Nf), mi=new Float64Array(2*Nf); let wp=0, nco=0;
  const RN=8192, rre=new Float64Array(RN), rim=new Float64Array(RN); let ac=0;               // кольцо видеосигнала, ac — число принятых отсчётов
  // детектор S: Goertzel на fc±B/2, кадр 60 отсчётов
  const FN=60, gk1=2*Math.cos(MDM_2PI*(cfg.fc+cfg.B/2)/MDM_FS), gk2=2*Math.cos(MDM_2PI*(cfg.fc-cfg.B/2)/MDM_FS);
  let a1=0,b1=0,a2=0,b2=0,fe=0,fi=0,sc=0,sOn=false,badN=0,tEnd=0;
  // эталон преамбулы: хвост S (6) + синхрослово (32) + начало ПСП (6) — видеосигнал RRC
  const pnTrain=mdmPnSyms(MDM_PNSEED,Ntr+8), P0=D, refSyms=[]; for(let k=NS-6;k<NS;k++) refSyms.push([(k&1)?-1:1,0]);
  for(const s of MDM_SYNC) refSyms.push(s); for(let k=0;k<6;k++) refSyms.push(pnTrain[k]);
  const G=mdmRrcTab(T,cfg.beta,span), Lr=Math.ceil(P0*2+refSyms.length*T), ref_r=new Float64Array(Lr), ref_i=new Float64Array(Lr); let refE=0;
  for(let q=0;q<refSyms.length;q++){ const c=P0+q*T; for(let i=Math.max(0,Math.ceil(c-G.half));i<Lr && i<=c+G.half;i++){ const v=G.g[Math.round((i-c+G.half)*G.R)]; ref_r[i]+=refSyms[q][0]*v; ref_i[i]+=refSyms[q][1]*v; } }
  for(let i=0;i<Lr;i++) refE+=ref_r[i]*ref_r[i]+ref_i[i]*ref_i[i];
  // состояние
  const E={st:'listen',snr:0,delta:0,mode:'qpsk',dead:false,symN:0,pts:[]};
  let hre=new Float64Array(32768), him=new Float64Array(32768); const HM=32767; let ht0=0, hm=0;                 // полуотсчёты (T/2)
  const w_r=new Float64Array(Nt), w_i=new Float64Array(Nt);
  let ls=null, nCur=0, th=0, fr=0, qmap=mdmQamMap(2), scr=null, hist=[], b1buf=null, dataOn=false, errAcc=0, errN=0;
  const markHits=(pat)=>{ let bad=0; for(let i=0;i<16;i++){ const h=hist[hist.length-16+i]; if(h!==pat[i]) { bad++; if(bad>2) return false; } } return true; };
  const q2=s=>(s[0]<0?2:0)|(s[1]<0?1:0), MBq=MDM_MB.map(q2), MEq=MDM_ME.map(q2);
  const pnQ=pnTrain.slice(0,Ntr);
  function interp(t,ch){ const i0=Math.floor(t), p=Math.round((t-i0)*MDM_IP.P), base=p*MDM_IP.T; let a=0, b=0;
    for(let k=0;k<MDM_IP.T;k++){ const j=(i0-5+k)&(RN-1), h=MDM_IP.h[base+k]; a+=rre[j]*h; b+=rim[j]*h; } return [a,b]; }
  function emitH(){ const half=T/2;
    while(true){ const t=ht0+hm*half; if(t+7>=ac) break; const i0=Math.floor(t);
      const p=Math.round((t-i0)*MDM_IP.P), base=p*MDM_IP.T; let a=0,b=0;
      for(let k=0;k<MDM_IP.T;k++){ const j=(i0-5+k)&(RN-1), h=MDM_IP.h[base+k]; a+=rre[j]*h; b+=rim[j]*h; }
      hre[(hm+Nt*8)&HM]=a; him[(hm+Nt*8)&HM]=b; hm++; } }
  const hr=(m)=>hre[(m+Nt*8)&HM], hi=(m)=>him[(m+Nt*8)&HM];
  // ---- обучение МНК ----
  function lsStart(){ const R=[]; for(let a=0;a<Nt;a++){ R.push([new Float64Array(Nt),new Float64Array(Nt)]); }
    ls={st:0,j:8,R,jhi:Ntr-8,Dc:8}; }
  function lsChunk(cnt){
    const L=ls; const xr=new Float64Array(Nt), xi=new Float64Array(Nt);
    for(let c=0;c<cnt && L.j<L.jhi;c++,L.j++){ const n=L.j+L.Dc;
      for(let a=0;a<Nt;a++){ xr[a]=hr(2*n-Nt+1+a); xi[a]=hi(2*n-Nt+1+a); }
      for(let a=0;a<Nt;a++){ const ar=xr[a], ai=-xi[a], Rr=L.R[a][0], Ri=L.R[a][1];                     // R[a][b] += conj(x_a)·x_b
        for(let b=a;b<Nt;b++){ Rr[b]+=ar*xr[b]-ai*xi[b]; Ri[b]+=ar*xi[b]+ai*xr[b]; } } }
    if(L.j>=L.jhi) L.st=1; }
  function lsSolve(){
    const L=ls, R=L.R; let tr=0; for(let a=0;a<Nt;a++) tr+=R[a][0][a];
    const lam=1e-4*tr/Nt;
    // полная эрмитова матрица, Холецкий R = C C^H
    const Ar=[],Ai=[]; for(let a=0;a<Nt;a++){ Ar.push(new Float64Array(Nt)); Ai.push(new Float64Array(Nt)); }
    for(let a=0;a<Nt;a++) for(let b=a;b<Nt;b++){ Ar[a][b]=R[a][0][b]; Ai[a][b]=R[a][1][b]; Ar[b][a]=R[a][0][b]; Ai[b][a]=-R[a][1][b]; }
    for(let a=0;a<Nt;a++) Ar[a][a]+=lam;
    const Cr=[],Ci=[]; for(let a=0;a<Nt;a++){ Cr.push(new Float64Array(Nt)); Ci.push(new Float64Array(Nt)); }
    for(let i=0;i<Nt;i++){
      for(let j=0;j<=i;j++){ let sr=Ar[i][j], si=Ai[i][j];
        for(let k=0;k<j;k++){ sr-=Cr[i][k]*Cr[j][k]+Ci[i][k]*Ci[j][k]; si-=Ci[i][k]*Cr[j][k]-Cr[i][k]*Ci[j][k]; }
        if(i===j){ Cr[i][i]=Math.sqrt(Math.max(sr,1e-30)); Ci[i][i]=0; }
        else { const d=Cr[j][j]; Cr[i][j]=sr/d; Ci[i][j]=si/d; } } }
    let best=null; const xr=new Float64Array(Nt), xi=new Float64Array(Nt);
    for(let Dl=4;Dl<=12;Dl++){
      const pr=new Float64Array(Nt), pi=new Float64Array(Nt); let dd=0;
      for(let j=8;j<L.jhi;j++){ const n=j+Dl, d=pnQ[j]; dd+=d[0]*d[0]+d[1]*d[1];
        for(let a=0;a<Nt;a++){ const xr_=hr(2*n-Nt+1+a), xi_=-hi(2*n-Nt+1+a); pr[a]+=xr_*d[0]-xi_*d[1]; pi[a]+=xr_*d[1]+xi_*d[0]; } }
      // C y = p, C^H w = y
      const yr=new Float64Array(Nt), yi=new Float64Array(Nt);
      for(let i=0;i<Nt;i++){ let sr=pr[i], si=pi[i]; for(let k=0;k<i;k++){ sr-=Cr[i][k]*yr[k]-Ci[i][k]*yi[k]; si-=Cr[i][k]*yi[k]+Ci[i][k]*yr[k]; } yr[i]=sr/Cr[i][i]; yi[i]=si/Cr[i][i]; }
      const wr=new Float64Array(Nt), wi=new Float64Array(Nt);
      for(let i=Nt-1;i>=0;i--){ let sr=yr[i], si=yi[i]; for(let k=i+1;k<Nt;k++){ sr-=Cr[k][i]*wr[k]+Ci[k][i]*wi[k]; si-=Cr[k][i]*wi[k]-Ci[k][i]*wr[k]; } wr[i]=sr/Cr[i][i]; wi[i]=si/Cr[i][i]; }
      let J=0;
      for(let j=8;j<L.jhi;j++){ const n=j+Dl, d=pnQ[j]; let yr_=0, yi_=0;
        for(let a=0;a<Nt;a++){ const xr_=hr(2*n-Nt+1+a), xi_=hi(2*n-Nt+1+a); yr_+=wr[a]*xr_-wi[a]*xi_; yi_+=wr[a]*xi_+wi[a]*xr_; }
        J+=(d[0]-yr_)*(d[0]-yr_)+(d[1]-yi_)*(d[1]-yi_); }
      if(!best || J<best.J) best={J,Dl,wr,wi,dd};
    }
    const N=L.jhi-8; const mse=best.J/best.dd*N/Math.max(1,N-Nt);
    E.delta=best.Dl; E.snr=-10*Math.log10(Math.max(mse,1e-12)); w_r.set(best.wr); w_i.set(best.wi); ls=null; }
  // ---- выходные символы: эквалайзер, ФАПЧ, срез ----
  function runSyms(){
    while(2*nCur<hm){
      const n=nCur++;
      let yr=0, yi=0, en=0;
      for(let a=0;a<Nt;a++){ const xr=hr(2*n-Nt+1+a), xi=hi(2*n-Nt+1+a); yr+=w_r[a]*xr-w_i[a]*xi; yi+=w_r[a]*xi+w_i[a]*xr; en+=xr*xr+xi*xi; }
      const c=Math.cos(th), s=Math.sin(th), zr=yr*c+yi*s, zi=-yr*s+yi*c;               // ŷ = y·e^{-jθ}
      let dr, di, dv=0;
      if(E.mode==='qam'){ const d=qmap.slice(zr,zi); dr=d.re; di=d.im; dv=d.v; }
      else { dr=zr<0?-MDM_Q:MDM_Q; di=zi<0?-MDM_Q:MDM_Q; }
      const er=zr-dr, ei=zi-di;
      const mu=E.mode==='qam'?0.003:0.01, k=mu/(en+1e-9), cr=er*c-ei*s, ci=er*s+ei*c;     // e·e^{+jθ}
      for(let a=0;a<Nt;a++){ const xr=hr(2*n-Nt+1+a), xi=hi(2*n-Nt+1+a);                 // w -= μ (e e^{jθ}) conj(x) / ‖x‖²
        w_r[a]-=k*(cr*xr+ci*xi); w_i[a]-=k*(ci*xr-cr*xi); }
      const pe=Math.atan2(zi*dr-zr*di,zr*dr+zi*di); fr+=0.00004*pe; th+=fr+0.006*pe; if(th>Math.PI) th-=MDM_2PI; else if(th<-Math.PI) th+=MDM_2PI;
      errAcc+=er*er+ei*ei; errN++; if(errN>=256){ E.evm=-10*Math.log10(Math.max(errAcc/errN,1e-9)); errAcc=0; errN=0; }
      E.symN++; if(E.pts.length<4096){ E.pts.push(zr,zi); }
      if(E.mode==='qpsk'){
        const q=(zr<0?2:0)|(zi<0?1:0);
        if(b1buf){ b1buf.push(q); if(b1buf.length>=24){ const bits=[]; for(const v of b1buf){ bits.push(v>>1,v&1); }
            let found=null; for(let cp=0;cp<2&&!found;cp++){ const by=[]; for(let i=0;i<3;i++){ let v=0; for(let k2=0;k2<8;k2++) v=(v<<1)|bits[cp*24+i*8+k2]; by.push(v); } if(mdmCrc8([by[0],by[1]])===by[2]) found=by; }
            b1buf=null; hooks.b1&&hooks.b1(found); hist=[]; } }
        else { hist.push(q); if(hist.length>40) hist.splice(0,hist.length-24);
          if(hist.length>=16){ if(markHits(MEq)){ E.mode='qam'; hooks.marker&&hooks.marker('ME'); hist=[]; scr=o.scr(); }
            else if(markHits(MBq)){ b1buf=[]; hist=[]; } } }
      } else { // данные: биты символа → дескремблер
        for(let k2=qmap.b-1;k2>=0;k2--) hooks.data&&hooks.data(scr.rx((dv>>k2)&1)); }
    }
  }
  E.setB=b=>{ qmap=mdmQamMap(b); };
  E.push=function(x){
    // 1. детектор S по сырому сигналу
    let s0=x+gk1*a1-b1; b1=a1; a1=s0; s0=x+gk2*a2-b2; b2=a2; a2=s0; fe+=x*x; if(++fi>=FN){
      const p1=(a1*a1+b1*b1-gk1*a1*b1), p2=(a2*a2+b2*b2-gk2*a2*b2), pt=4*(p1+p2)/(FN*FN), ee=2*fe/FN, ratio=pt/(ee+1e-12);
      a1=b1=a2=b2=0; fe=0; fi=0;
      if(E.st==='listen'){ if(ee>1e-6 && ratio>0.5) { if(++sc>=5) sOn=true; badN=0; } else if(sOn){ if(++badN>=2){ tEnd=ac-FN*badN; E.st='acq'; } } else sc=0; } }
    // 2. смешивание и ФНЧ
    const cs=Math.cos(nco), sn=Math.sin(nco); nco+=wmix; if(nco>MDM_2PI) nco-=MDM_2PI;
    const vr=x*cs, vi=-x*sn; mr[wp]=mr[wp+Nf]=vr; mi[wp]=mi[wp+Nf]=vi; wp=(wp+1)%Nf;
    let sr=0, si=0; for(let k=0;k<Nf;k++){ sr+=lpf[k]*mr[wp+k]; si+=lpf[k]*mi[wp+k]; }
    rre[ac&(RN-1)]=sr; rim[ac&(RN-1)]=si; ac++;
    // 3. автомат приёмника
    if(E.st==='acq' && ac>=tEnd+FN+(Nf>>1)+80+Lr){
      let bestV=0, bestT=-1; const tmin=Math.max(0,tEnd-Math.ceil(6*T+P0)-80), tmax=tEnd+FN+(Nf>>1)+80;
      for(let t=tmin;t<=tmax;t++){ let cr=0, ci=0; for(let i=0;i<Lr;i++){ const j=(t+i)&(RN-1); cr+=rre[j]*ref_r[i]+rim[j]*ref_i[i]; ci+=rim[j]*ref_r[i]-rre[j]*ref_i[i]; }
        const v=cr*cr+ci*ci; if(v>bestV){ bestV=v; bestT=t; } }
      let re=0; for(let i=0;i<Lr;i++){ const j=(bestT+i)&(RN-1); re+=rre[j]*rre[j]+rim[j]*rim[j]; }
      const corr=Math.sqrt(bestV)/Math.sqrt(refE*re+1e-18);
      if(bestT<0 || corr<0.3){ hooks.log&&hooks.log('QAM: преамбула не найдена ('+corr.toFixed(2)+')'); E.st='dead'; }
      else { ht0=bestT+P0+38*T; hm=-Nt; E.st='train'; E.corr=corr; hooks.log&&hooks.log('QAM: преамбула найдена, корреляция '+corr.toFixed(2)); } }
    if(E.st==='train'||E.st==='ls'||E.st==='run') emitH();
    if(E.st==='train' && hm>=2*(Ntr+12)+2){ E.st='ls'; lsStart(); }
    if(E.st==='ls' && (ac&31)===0){
      if(ls.st===0) lsChunk(60); else { lsSolve(); const ok=E.snr>14;
        if(ok){ nCur=Ntr+E.delta; th=0; fr=0; E.mode='qpsk'; hist=[]; b1buf=null; E.st='run'; }
        else E.st='dead';
        hooks.verdict&&hooks.verdict({ok,snr:E.snr,delta:E.delta}); } }
    if(E.st==='run') runSyms();
  };
  return E; }

// ---------- Телефонная линия (проверка без эфира) ----------
function mdmBiquad(type,f,Q){ const w=MDM_2PI*f/MDM_FS, c=Math.cos(w), s=Math.sin(w), al=s/(2*Q); let b0,b1,b2;
  if(type==='lp'){ b0=(1-c)/2; b1=1-c; b2=(1-c)/2; } else { b0=(1+c)/2; b1=-(1+c); b2=(1+c)/2; }
  const a0=1+al; return {b0:b0/a0,b1:b1/a0,b2:b2/a0,a1:-2*c/a0,a2:(1-al)/a0,x1:0,x2:0,y1:0,y2:0}; }
const mdmBqRun=(q,x)=>{ const y=q.b0*x+q.b1*q.x1+q.b2*q.x2-q.a1*q.y1-q.a2*q.y2; q.x2=q.x1; q.x1=x; q.y2=q.y1; q.y1=y; return y; };
function mdmLineNew(o){
  o=Object.assign({lo:300,hi:3400,snr:45,delayMs:8,gainDb:-6,law:false,seed:7,drift:0},o||{});
  const rnd=mdmRng(o.seed), g=Math.pow(10,o.gainDb/20), sig=g*Math.sqrt(2*0.0225*Math.pow(10,-o.snr/10))*(o.snr>=200?0:1);
  const L=Math.max(1,mdmMs(o.delayMs)), dl=new Float64Array(L+2); let wp=0;
  const bq=[mdmBiquad('hp',o.lo,0.5412),mdmBiquad('hp',o.lo,1.3066),mdmBiquad('lp',o.hi,0.5412),mdmBiquad('lp',o.hi,1.3066)];
  const mu=255;
  return {o, run(x,n,y){ for(let i=0;i<n;i++){
      let v=x[i]*g; for(const q of bq) v=mdmBqRun(q,v);
      if(o.law){ const a=Math.max(-1,Math.min(1,v*2)); const c=Math.sign(a)*Math.log(1+mu*Math.abs(a))/Math.log(1+mu), qn=Math.round(c*127)/127; v=Math.sign(qn)*(Math.pow(1+mu,Math.abs(qn))-1)/mu/2; }
      dl[wp]=v; const rp=(wp-L+dl.length)%dl.length; wp=(wp+1)%dl.length;
      y[i]=dl[rp]+sig*mdmGauss(rnd); } return y; }}; }
