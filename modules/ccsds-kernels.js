"use strict";
/* ============================ CCSDS: PSK-демодулятор, Витерби, RS, кадры ============================
   Ядра IQK (грузятся и страницей, и воркером острова — iq-worker.js), без DOM.
   PSK Demodulator: IQ → мягкие символы QPSK/OQPSK. CCSDS Decoder: символы → Витерби K=7 r=1/2 →
   NRZ-M → кадры по ASM 1ACFFC1D → дескремблер → RS(255,223)×4 → VCDU.
   Параметры Meteor-M LRPT сверены с SatDump (GPLv3): pipelines/Meteor-M.json, meteor_lrpt_decoder,
   ccsds_conv_concat_decoder, viterbi27 (полиномы 79/109), randomization, reedsolomon (libcorrect:
   поле 0x187, первый корень 112, шаг 11, базис обычный), bpsk_ccsds_deframer.
     M2    — QPSK 72k, без NRZ-M (неоднозначность 180° — по инверсному ASM)
     M2-x  — OQPSK 72k, NRZ-M после Витерби (M2-3, M2-4) */

/* ---- свёрточный код K=7 r=1/2: регистр — младший бит новый, полиномы 0x4F, 0x6D (171/133 окт.) ---- */
const CC_G1=0x4F, CC_G2=0x6D;
function ccPar(v){ v^=v>>4; v^=v>>2; v^=v>>1; return v&1; }
// мягкие уровни выходов по 7-битному регистру: бит 0 → +1, бит 1 → −1
const CC_E1=new Float32Array(128), CC_E2=new Float32Array(128);
for(let r=0;r<128;r++){ CC_E1[r]=ccPar(r&CC_G1) ? -1 : 1; CC_E2[r]=ccPar(r&CC_G2) ? -1 : 1; }
// биты → пары кодовых бит; st — {r} состояние регистра (продолжается между вызовами)
function ccEncode(st,bits){
  const o=new Uint8Array(bits.length*2);
  let r=st.r|0;
  for(let i=0;i<bits.length;i++){ r=((r<<1)|bits[i])&0x7F; o[2*i]=ccPar(r&CC_G1); o[2*i+1]=ccPar(r&CC_G2); }
  st.r=r&0x3F;
  return o;
}

/* ---- Витерби, 64 состояния; состояние — последние 6 бит, младший — новый ---- */
// В ns приходят из p=(ns>>1)|(b<<5), регистр (b<<6)|ns; решение — b. Метрика — корреляция (максимум).
function vitNew(tb,out){
  const L=tb+out;
  return {tb, out, L, m:new Float32Array(64), n:new Float32Array(64), dec:new Uint8Array(L*64),
    sym:new Float32Array(L*2), k:0, enc:0, err:0, tot:0};
}
function vitStep(v,x,y){
  const m=v.m, n=v.n, d=v.dec, o=v.k*64;
  let best=-1e30;
  for(let s=0;s<64;s++){
    const p=s>>1, r1=64|s;
    const a=m[p]+CC_E1[s]*x+CC_E2[s]*y, b=m[p|32]+CC_E1[r1]*x+CC_E2[r1]*y;
    if(b>a){ n[s]=b; d[o+s]=1; if(b>best) best=b; } else { n[s]=a; d[o+s]=0; if(a>best) best=a; }
  }
  if((v.k&31)===31) for(let s=0;s<64;s++) n[s]-=best;
  v.sym[2*v.k]=x; v.sym[2*v.k+1]=y;
  v.m=n; v.n=m; v.k++;
}
// обратный проход от лучшего состояния по всем v.k шагам → биты (Uint8Array v.k)
function vitTrace(v){
  const m=v.m, K=v.k, bits=new Uint8Array(K), d=v.dec;
  let s=0, bv=-1e30;
  for(let i=0;i<64;i++) if(m[i]>bv){ bv=m[i]; s=i; }
  for(let t=K-1;t>=0;t--){ bits[t]=s&1; s=(s>>1)|(d[t*64+s]<<5); }
  return bits;
}
// сверка перекодированных бит с жёсткими решениями входа: [ошибок, всего]
function vitCheck(v,bits,from,to){
  let r=v.enc, e=0, n=0;
  const sy=v.sym;
  for(let t=from;t<to;t++){
    r=((r<<1)|bits[t])&0x7F;
    const x=sy[2*t], y=sy[2*t+1];
    if(x){ n++; if((x>0)!==(CC_E1[r]>0)) e++; }
    if(y){ n++; if((y>0)!==(CC_E2[r]>0)) e++; }
    r&=0x3F;
  }
  v.enc=r;
  return [e,n];
}
// потоковый режим: как только накоплено tb+out шагов — out старших бит наружу (с задержкой tb)
function vitPush(v,x,y,emit){
  vitStep(v,x,y);
  if(v.k<v.L) return;
  const bits=vitTrace(v), out=v.out;
  const [e,n]=vitCheck(v,bits,0,out);
  v.err+=e; v.tot+=n;
  emit(bits,out);
  v.dec.copyWithin(0,out*64); v.sym.copyWithin(0,out*2); v.k-=out;
}
// блок целиком (поиск синхронизации): доля ошибок перекодирования, первые 16 шагов — разгон
function vitBlockBer(soft,off,steps){
  const v=vitNew(steps,0);
  for(let t=0;t<steps;t++) vitStep(v,soft[off+2*t],soft[off+2*t+1]);
  const bits=vitTrace(v);
  let r=0; for(let t=10;t<16;t++) r=((r<<1)|bits[t])&0x3F;
  v.enc=r;
  const [e,n]=vitCheck(v,bits,16,steps);
  return n ? e/n : 1;
}

/* ---- рандомизатор CCSDS: x^8+x^7+x^5+x^3+1, начальное 0xFF (FF 48 0E C0 9A …) ---- */
const CCSDS_PN=(()=>{ const t=new Uint8Array(255); let s=0xFF;
  for(let i=0;i<255;i++){ let v=0;
    for(let k=0;k<8;k++){ v=(v<<1)|(s&1); const f=(s^(s>>3)^(s>>5)^(s>>7))&1; s=(s>>1)|(f<<7); }
    t[i]=v; }
  return t; })();
function ccsdsDerand(b,from,len){ for(let i=0;i<len;i++) b[from+i]^=CCSDS_PN[i%255]; }

/* ---- Рида — Соломона над GF(2^8): поле poly, корни α^(prim·(fcr+j)), j=0..np−1; cw[0] — старшая степень ---- */
// CCSDS: 0x187, 112, 11, 32. RS41: 0x11D, 0, 1, 24 (у RS41 проверочные байты в младших степенях — см. sonde-kernels).
function rsCodec(poly,fcr,prim,np){
  const EXP=new Uint8Array(512), LOG=new Uint8Array(256), K=255-np;
  let x=1; for(let i=0;i<255;i++){ EXP[i]=x; LOG[x]=i; x<<=1; if(x&0x100) x^=poly; }
  for(let i=255;i<512;i++) EXP[i]=EXP[i-255];
  const mul=(a,b)=>a&&b ? EXP[LOG[a]+LOG[b]] : 0;
  const div=(a,b)=>a ? EXP[(LOG[a]+255-LOG[b])%255] : 0;
  const pw=e=>{ e%=255; return EXP[e<0 ? e+255 : e]; };   // α^e
  // порождающий многочлен, старший коэффициент первым (g[0]=1)
  let g=[1];
  for(let j=0;j<np;j++){ const r=pw(prim*(fcr+j)), h=new Array(g.length+1).fill(0);
    for(let i=0;i<g.length;i++){ h[i]^=g[i]; h[i+1]^=mul(g[i],r); }
    g=h; }
  const GEN=Uint8Array.from(g);
  return {np, K, mul, div, pw, gen:GEN,
    // cw[0..K−1] — данные; в cw[K..254] пишется проверочная часть
    encode(cw){
      const p=new Uint8Array(np);
      for(let i=0;i<K;i++){
        const f=cw[i]^p[0];
        p.copyWithin(0,1); p[np-1]=0;
        if(f) for(let j=0;j<np;j++) p[j]^=mul(f,GEN[j+1]);
      }
      cw.set(p,K);
    },
    // исправление на месте: число исправленных байт или −1
    decode(cw){
      const S=new Uint8Array(np);
      let bad=0;
      for(let j=0;j<np;j++){
        const r=pw(prim*(fcr+j));
        let s=0; for(let i=0;i<255;i++) s=mul(s,r)^cw[i];
        S[j]=s; bad|=s;
      }
      if(!bad) return 0;
      // Берлекэмп — Мэсси
      let C=new Uint8Array(np+1), B=new Uint8Array(np+1), L=0, m=1, b=1;
      C[0]=1; B[0]=1;
      for(let n=0;n<np;n++){
        let d=S[n];
        for(let i=1;i<=L;i++) d^=mul(C[i],S[n-i]);
        if(!d){ m++; continue; }
        const coef=div(d,b), T=C.slice();
        for(let i=m;i<=np;i++) C[i]^=mul(coef,B[i-m]);
        if(2*L<=n){ L=n+1-L; B=T; b=d; m=1; } else m++;
      }
      if(L>np/2) return -1;
      // Ω = S·Λ mod x^np
      const O=new Uint8Array(np);
      for(let i=0;i<np;i++){ let v=0; for(let j=0;j<=Math.min(i,L);j++) v^=mul(C[j],S[i-j]); O[i]=v; }
      // Ченя: позиция i (степень d=254−i), локатор Y=α^(prim·d); корень Λ — Y⁻¹. Форни: e = Y^(1−fcr)·Ω(Y⁻¹)/Λ'(Y⁻¹)
      let found=0;
      const pos=[], val=[];
      for(let i=0;i<255;i++){
        const d=254-i, yl=(prim*d)%255, xi=pw(-yl);
        let lv=0; for(let j=L;j>=0;j--) lv=mul(lv,xi)^C[j];
        if(lv) continue;
        let ov=0; for(let j=np-1;j>=0;j--) ov=mul(ov,xi)^O[j];
        let dv=0; for(let j=L-(L%2===0 ? 1 : 0);j>=1;j-=2) dv^=mul(C[j],pw(-yl*(j-1)));
        if(!dv) return -1;
        pos.push(i); val.push(mul(div(ov,dv),pw(yl*(1-fcr))));
        found++;
      }
      if(found!==L) return -1;
      for(let k=0;k<found;k++) cw[pos[k]]^=val[k];
      return found;
    }};
}
const RS_CCSDS=rsCodec(0x187,112,11,32);
function rsEncode(cw){ RS_CCSDS.encode(cw); }
function rsDecode(cw){ return RS_CCSDS.decode(cw); }
// двойственный базис (CCSDS 131.0-B): таблица в двойственный, обратная — по ней
const RS_TO_DUAL=Uint8Array.from(('007bafd499e2364dfa81552e6318ccb786fd29521f64b0cb7c07d3a8e59e4a31ec974338750edaa1166db9c28ff4205b6a11c5bef3885c2790eb3f440972a6dd'+
  'ef94403b760dd9a2156ebac18cf723586912c6bdf08b5f2493e83c470a71a5de0378acd79ae1354ef982562d601bcfb485fe2a511c67b3c87f04d0abe69d4932'+
  '8df62259146fbbc0770cd8a3ee95413a0b70a4df92e93d46f18a5e256813c7bc611aceb5f883572c9be0344f0279add6e79c48337e05d1aa1d66b2c984ff2b50'+
  '6219cdb6fb80542f98e3374c017aaed5e49f4b307d06d2a91e65b1ca87fc28538ef5215a176cb8c3740fdba0ed9642390873a7dc91ea3e45f2895d266b10c4bf').match(/../g).map(x=>parseInt(x,16)));
const RS_FROM_DUAL=(()=>{ const t=new Uint8Array(256); for(let i=0;i<256;i++) t[RS_TO_DUAL[i]]=i; return t; })();
// кадр: data[from .. from+255·I) — I перемеженных кодовых слов; → [исправлено в каждом] (−1 — не исправить)
function rsDecodeInterleaved(data,from,I,dual){
  const cw=new Uint8Array(255), res=[];
  for(let b=0;b<I;b++){
    for(let k=0;k<255;k++){ const v=data[from+k*I+b]; cw[k]=dual ? RS_FROM_DUAL[v] : v; }
    const e=rsDecode(cw);
    res.push(e);
    if(e>0) for(let k=0;k<255;k++) data[from+k*I+b]=dual ? RS_TO_DUAL[cw[k]] : cw[k];
  }
  return res;
}
function rsEncodeInterleaved(data,from,I,dual){
  const cw=new Uint8Array(255);
  for(let b=0;b<I;b++){
    for(let k=0;k<223;k++){ const v=data[from+k*I+b]; cw[k]=dual ? RS_FROM_DUAL[v] : v; }
    rsEncode(cw);
    for(let k=0;k<255;k++) data[from+k*I+b]=dual ? RS_TO_DUAL[cw[k]] : cw[k];
  }
}

/* ---- PSK Demodulator ---- */
// Прореживание до 3–6 отсчётов на символ → RRC → АРУ → НГ (фаза, частота) → интерполятор Гарднера
// (кубический) → Костас 4-го порядка на символах. OQPSK: Q берётся на полсимвола позже I.
// Грубая частота до захвата: пик спектра y⁴ на 4Δf (у OQPSK тоже; у y² — пара 2Δf ± Rs/2).
const PSK_ACQ_N=4096;
IQK.pskDemod={
  init(n){ n.key=''; },
  setup(n,sr,Rs){
    const M=Math.max(1,Math.floor(sr/(3*Rs))), sr1=sr/M, sps=sr1/Rs;
    n.M=M; n.sr1=sr1; n.sps=sps; n.sp=sps;
    n.dec=M>1 ? {p:{M:String(M), cut:Math.min(.45,(1+(+n.p.alpha||.6))*Rs/2/sr1+.08), tpp:'16'}} : null;
    if(n.dec) IQK.iqDecim.init(n.dec);
    // RRC ±5 символов
    const span=5, N=2*Math.ceil(span*sps)+1, h=new Float32Array(N), a=+n.p.alpha||.6, c=(N-1)/2;
    let e=0;
    for(let k=0;k<N;k++){
      const t=(k-c)/sps; let v;
      if(Math.abs(t)<1e-9) v=1-a+4*a/Math.PI;
      else if(Math.abs(Math.abs(4*a*t)-1)<1e-9) v=a/Math.SQRT2*((1+2/Math.PI)*Math.sin(Math.PI/(4*a))+(1-2/Math.PI)*Math.cos(Math.PI/(4*a)));
      else v=(Math.sin(Math.PI*t*(1-a))+4*a*t*Math.cos(Math.PI*t*(1+a)))/(Math.PI*t*(1-(4*a*t)**2));
      h[k]=v; e+=v*v;
    }
    for(let k=0;k<N;k++) h[k]/=Math.sqrt(e);
    n.h=h; n.hr=new Float32Array(N-1); n.hi=new Float32Array(N-1);
    n.pw=1; n.ph=0; n.f=0; n.ring=new Float32Array(2*64); n.w=0;
    n.tS=Math.ceil(sps)+4; n.amp=.7; n.lk=0; n.nv=.5; n.pI=0; n.pQ=0;
    n.acq=new Float32Array(2*PSK_ACQ_N); n.acqK=0; n.acqP=null; n.acqN=0;
    n.pts=new Float32Array(512); n.pk=0;
    const th=b=>b/(.707+1/(4*.707)), lp=b=>{ const t=th(b), d=1+2*.707*t+t*t; return [4*.707*t/d, 4*t*t/d]; };
    [n.ca,n.cb]=lp(+n.p.bw||.005);                   // Костас
    [n.ta,n.tb]=lp(.004);                            // тактовая
  },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {out:null, freq:null, lock:null}; }
    const Rs=+n.p.rate||72000, oq=n.p.mode==='OQPSK';
    const key=s.sr+'|'+Rs+'|'+n.p.alpha+'|'+n.p.bw;
    if(key!==n.key){ n.key=key; this.setup(n,s.sr,Rs); }
    const src=n.dec ? IQK.iqDecim.process(n.dec,{in:s}).out : s;
    const o=iqStream(n,'out',Rs,s.fc);
    const maxF=2*Math.PI*(+n.p.pull||10000)/n.sr1;
    for(const c of src.chunks){
      const xr=firRun(n.h,n.hr,c.re), xi=firRun(n.h,n.hi,iqChunkIm(c)), K=xr.length;
      const yr=[], yi=[];
      for(let i=0;i<K;i++){
        let a=xr[i], b=xi[i];
        n.pw+=((a*a+b*b)-n.pw)*2e-4;
        const g=1/Math.sqrt(n.pw+1e-20);
        a*=g; b*=g;
        const cs=Math.cos(n.ph), sn=Math.sin(n.ph);
        const u=a*cs+b*sn, v=b*cs-a*sn;             // ·e^(−jφ)
        n.ph+=n.f; if(n.ph>Math.PI) n.ph-=2*Math.PI; else if(n.ph<-Math.PI) n.ph+=2*Math.PI;
        const w=n.w&63; n.ring[2*w]=u; n.ring[2*w+1]=v; n.w++;
        this.acqPush(n,u,v);
        // строб: нужен запас на кубическую интерполяцию и полсимвола вперёд (OQPSK)
        while(n.tS+n.sp/2+3<n.w){ this.strobe(n,oq,yr,yi); }
      }
      n.f=Math.max(-maxF,Math.min(maxF,n.f));
      if(yr.length) iqPush(o,Float32Array.from(yr),Float32Array.from(yi),c.tag);
    }
    const hz=n.f*n.sr1/(2*Math.PI);
    n.ui={sr:s.sr, sr1:n.sr1, M:n.M, hz, lock:n.lk, snr:10*Math.log10(n.amp*n.amp/(n.nv+1e-9)),
      pts:n.pts.slice(), baud:Rs, sps:n.sp};
    return {out:o, freq:hz, lock:n.lk};
  },
  // кубическая интерполяция (Катмулл — Ром) кольца на момент t: [re, im]
  interp(n,t){
    const i=Math.floor(t), mu=t-i, R=n.ring;
    const p0=2*((i-1)&63), p1=2*(i&63), p2=2*((i+1)&63), p3=2*((i+2)&63);
    const f=(a,b,c,d)=>b+.5*mu*(c-a+mu*(2*a-5*b+4*c-d+mu*(3*(b-c)+d-a)));
    return [f(R[p0],R[p1],R[p2],R[p3]), f(R[p0+1],R[p1+1],R[p2+1],R[p3+1])];
  },
  strobe(n,oq,yr,yi){
    const t=n.tS, h=n.sp/2;
    const S=this.interp(n,t), Mi=this.interp(n,t-h);
    let si=S[0], sq, mi=Mi[0], mq;
    if(oq){ sq=this.interp(n,t+h)[1]; mq=S[1]; } else { sq=S[1]; mq=Mi[1]; }
    const A=n.amp+1e-6;
    // Гарднер (не зависит от фазы несущей)
    const te=((n.pI-si)*mi+(n.pQ-sq)*mq)/(A*A);
    n.pI=si; n.pQ=sq;
    const tc=Math.max(-1,Math.min(1,te));
    n.sp+=n.tb*tc*.5; n.sp=Math.max(n.sps*.995,Math.min(n.sps*1.005,n.sp));
    n.tS+=n.sp+n.ta*tc*n.sps*.5;
    // Костас QPSK
    const ce=Math.max(-1,Math.min(1,((si>0?1:-1)*sq-(sq>0?1:-1)*si)/A));
    n.ph+=n.ca*ce; n.f+=n.cb*ce/n.sps;
    // уровень, шум, захват (cos 4θ)
    const ai=Math.abs(si), aq=Math.abs(sq);
    n.amp+=((ai+aq)/2-n.amp)*.005;
    n.nv+=(((ai-n.amp)**2+(aq-n.amp)**2)/2-n.nv)*.005;
    const p2=si*si+sq*sq+1e-12, c4=((si*si-sq*sq)**2-4*si*si*sq*sq)/(p2*p2);
    n.lk+=(-c4-n.lk)*.002;
    yr.push(si/A); yi.push(sq/A);
    n.pts[n.pk]=si/A; n.pts[n.pk+1]=sq/A; n.pk=(n.pk+2)%n.pts.length;
  },
  // грубая частота по спектру y⁴ (от 4 до 16 БПФ по 4096)
  acqPush(n,u,v){
    const a2=u*u-v*v, b2=2*u*v;
    const k=n.acqK++;
    n.acq[2*k]=a2*a2-b2*b2; n.acq[2*k+1]=2*a2*b2;
    if(n.acqK<PSK_ACQ_N) return;
    n.acqK=0;
    const N=PSK_ACQ_N, re=new Float64Array(N), im=new Float64Array(N);
    for(let i=0;i<N;i++){ const w=.5-.5*Math.cos(2*Math.PI*i/N); re[i]=n.acq[2*i]*w; im[i]=n.acq[2*i+1]*w; }
    fft(re,im);
    const P=n.acqP||(n.acqP=new Float64Array(N));
    for(let i=0;i<N;i++) P[i]+=re[i]*re[i]+im[i]*im[i];
    if(++n.acqN<4) return;
    const bin=n.sr1/N, lim=Math.min(N/2-2,Math.round(4*(+n.p.pull||10000)/bin)), at=j=>P[(j%N+N)%N];
    let best=0, bj=0, sum=0;
    for(let j=-lim;j<=lim;j++){ const v=at(j); sum+=v; if(v>best){ best=v; bj=j; } }
    // линия — на 8σ выше шума спектра (σ ≈ среднее/√K после K БПФ); слабый сигнал — копим до 16
    const mean=sum/(2*lim+1);
    if(!(best>mean*(1+8/Math.sqrt(n.acqN)))){ if(n.acqN>=16){ n.acqP=null; n.acqN=0; } return; }
    const y0=at(bj-1), y2=at(bj+1), dd=y0-2*best+y2, fr=dd<0 ? .5*(y0-y2)/dd : 0;   // уточнение параболой
    const df=(bj+fr)*bin/4;
    if(Math.abs(df)>30) n.f+=2*Math.PI*df/n.sr1;     // при захвате остаток ≈ 0 — поправки нет
    n.acqP=null; n.acqN=0;
  }};

/* ---- CCSDS Decoder ---- */
// Мягкие символы (re=I, im=Q) → поиск синхронизации Витерби: перестановка I/Q × поворот 0/90° ×
// сдвиг пары (8 вариантов, 180° снимает NRZ-M или инверсный ASM) по ошибкам перекодирования →
// потоковый Витерби → NRZ-M → ASM → дескремблер → RS. Выход rec: {t, scid, vcid, cnt, rs, vcdu}.
const CCSDS_ASM=0x1ACFFC1D, CCSDS_FRAME=1024;
const VIT_TEST=512, VIT_LOCK=.09, VIT_BAD=.11, VIT_OUTSYNC=20;
// у шума в потоке ошибок перекодирования ~12%: захват без ASM дольше 4 кадров — ложный
const VIT_NOASM=4*CCSDS_FRAME*8;
IQK.ccsdsDecode={
  init(n){
    n.vit=null; n.sb=new Float32Array(4*VIT_TEST); n.sk=0; n.hold=null; n.nz=0;
    n.ber=0; n.vbad=0; n.vcand=[];
    n.sh=0; n.fs=0; n.inv=0; n.fbuf=new Uint8Array(CCSDS_FRAME); n.fbit=-1; n.good=0; n.miss=0; n.last=0;
    n.ok=0; n.fail=0; n.fixed=0; n.lastRec=null; n.rate=0; n.rT=0; n.rN=0; n.recs=[];
  },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {rec:null, ber:null, lock:null}; }
    n.recs=[];
    let K=0;
    for(const c of s.chunks){
      const xr=c.re, xi=iqChunkIm(c); K+=xr.length;
      for(let i=0;i<xr.length;i++) this.sym(n,xr[i],xi[i]);
    }
    n.rT+=K/(s.sr||1);
    if(n.rT>=2){ n.rate=n.rN/n.rT; n.rN=0; n.rT=0; }
    const lock=n.vit ? (n.fs===2 ? 2 : 1) : 0;
    n.ui={lock, ber:n.vit ? n.ber : n.vcand.length ? Math.min(...n.vcand) : null, ok:n.ok, fail:n.fail,
      fixed:n.fixed, rate:n.rate, last:n.lastRec, fs:n.fs, inv:n.inv};
    return {rec:n.recs.length ? n.recs : null, ber:n.ber, lock};
  },
  // символ: вариант (перестановка, поворот) и сдвиг пары фиксируются при захвате
  sym(n,x,y){
    if(!n.vit){
      const k=n.sk;
      n.sb[2*k]=x; n.sb[2*k+1]=y;
      if(++n.sk<2*VIT_TEST) return;                   // 2·VIT_TEST символов = VIT_TEST шагов на каждый сдвиг
      n.sk=0;
      this.search(n);
      return;
    }
    const [a,b]=this.map(n.var,x,y);
    this.soft(n,a); this.soft(n,b);
  },
  map(vr,x,y){
    if(vr&1){ const t=x; x=y; y=t; }
    if(vr&2){ const t=x; x=y; y=-t; }
    return [x,y];
  },
  soft(n,v){
    if(!n.vit) return;
    if(n.hold===null){ n.hold=v; return; }
    const a=n.hold; n.hold=null;
    vitPush(n.vit,a,v,(bits,cnt)=>this.bits(n,bits,cnt));
    if(n.drop){ n.drop=false; n.vit=null; n.fs=0; n.hold=null; return; }
    if(n.vit.tot>=2048){
      const r=n.vit.err/n.vit.tot; n.vit.err=0; n.vit.tot=0;
      n.ber=r;
      if(r>VIT_BAD){ if(++n.vbad>VIT_OUTSYNC){ n.vit=null; n.fs=0; n.hold=null; } }
      else n.vbad=0;
    }
  },
  search(n){
    const L=2*VIT_TEST, soft=new Float32Array(2*L+2), res=[];
    let best=1, bv=0;
    for(let vr=0;vr<4;vr++){
      for(let k=0;k<L;k++){ const [a,b]=this.map(vr,n.sb[2*k],n.sb[2*k+1]); soft[2*k]=a; soft[2*k+1]=b; }
      for(let sh=0;sh<2;sh++){
        const r=vitBlockBer(soft,sh,VIT_TEST);
        res.push(r);
        if(r<best){ best=r; bv=vr*2+sh; }
      }
    }
    n.vcand=res;
    if(best>=VIT_LOCK) return;
    // захват: весь тестовый буфер — в потоковый декодер
    n.var=bv>>1; n.vit=vitNew(96,256); n.vbad=0; n.ber=best; n.hold=null;
    n.fs=0; n.fbit=-1; n.nz=0; n.noasm=0; n.drop=false;
    for(let k=0;k<L;k++){
      const [a,b]=this.map(n.var,n.sb[2*k],n.sb[2*k+1]);
      if(k>0 || !(bv&1)) this.soft(n,a);
      this.soft(n,b);
    }
  },
  // декодированные биты → NRZ-M → поиск ASM / сборка кадра
  bits(n,bits,cnt){
    const nrzm=n.p.nrzm!==false;
    for(let i=0;i<cnt;i++){
      let b=bits[i];
      if(nrzm){ const c=b; b^=n.nz; n.nz=c; }
      n.sh=((n.sh<<1)|b)>>>0;
      if(n.fbit>=0){                                 // внутри кадра
        const f=n.fbit++;
        if(b^n.inv) n.fbuf[f>>3]|=0x80>>(f&7);
        if(n.fbit===CCSDS_FRAME*8){ this.frame(n); n.fbit=-1; n.last=0; }
        continue;
      }
      if(n.fs===0){
        if(++n.noasm>VIT_NOASM){ n.drop=true; continue; }
        const d=ccsdsDist(n.sh,CCSDS_ASM), di=ccsdsDist(n.sh,~CCSDS_ASM>>>0);
        if(d<=2 || di<=2){ n.noasm=0; n.inv=d<=2 ? 0 : 1; n.fs=1; n.good=0; n.miss=0; this.start(n); }
        continue;
      }
      // ждём ASM ровно через кадр
      if(++n.last<32) continue;
      const d=ccsdsDist(n.sh,n.inv ? ~CCSDS_ASM>>>0 : CCSDS_ASM);
      if(d<=(n.fs===2 ? 8 : 4)){ n.miss=0; if(++n.good>2) n.fs=2; this.start(n); }
      else if(++n.miss>(n.fs===2 ? 3 : 1)){ n.fs=0; n.last=0; n.noasm=0; }
      else this.start(n);                            // кадр вслепую — RS рассудит
    }
  },
  start(n){ n.fbuf.fill(0); n.fbuf[0]=0x1A; n.fbuf[1]=0xCF; n.fbuf[2]=0xFC; n.fbuf[3]=0x1D; n.fbit=32; n.last=0; },
  frame(n){
    const f=n.fbuf.slice(), rs=n.p.rs||'RS (255,223)';
    ccsdsDerand(f,4,CCSDS_FRAME-4);
    let err=[0,0,0,0];
    if(rs!=='off') err=rsDecodeInterleaved(f,4,4,rs==='RS dual basis');
    if(err.some(e=>e<0)){ n.fail++; return; }
    const fixed=err.reduce((a,b)=>a+b,0);
    n.ok++; n.rN++; n.fixed+=fixed;
    const vcdu=f.slice(4,4+892);
    const r={t:Date.now(), scid:((vcdu[0]&0x3F)<<2)|(vcdu[1]>>6), vcid:vcdu[1]&0x3F,
      cnt:(vcdu[2]<<16)|(vcdu[3]<<8)|vcdu[4], rs:fixed, vcdu};
    n.lastRec={scid:r.scid, vcid:r.vcid, cnt:r.cnt};
    n.recs.push(r);
  }};
function ccsdsDist(a,b){ let x=(a^b)>>>0, c=0; while(x){ x&=x-1; c++; } return c; }

/* ---- генератор: поток LRPT (для IQ Generator) ---- */
// Кадры VCDU (VCID 5, счётчик, пакеты MSU-MR тестовой картинки — lrptSimVcdu) → RS ×4 → рандомизатор →
// [NRZ-M] → свёрточный код → QPSK / OQPSK с RRC α=0.6, 72 кБод. Комплексная огибающая мощностью 1.
const LRPT_RS=72000, LRPT_SPAN=6, LRPT_TAB=64;
const LRPT_SCID=0x9A;
function lrptSimVcdu(cnt){
  const v=new Uint8Array(892);
  v[0]=0x40|(LRPT_SCID>>2); v[1]=((LRPT_SCID&3)<<6)|5;
  v[2]=(cnt>>16)&0xFF; v[3]=(cnt>>8)&0xFF; v[4]=cnt&0xFF; v[5]=0;
  const [fhp,d]=msuSimMpdu(cnt);                    // M_PDU: пакеты MSU-MR тестовой картинки (lrpt-msumr.js)
  v[8]=(fhp>>8)&7; v[9]=fhp&0xFF; v.set(d,10);
  return v;
}
function lrptCadu(cnt){
  const f=new Uint8Array(CCSDS_FRAME);
  f[0]=0x1A; f[1]=0xCF; f[2]=0xFC; f[3]=0x1D;
  f.set(lrptSimVcdu(cnt),4);
  rsEncodeInterleaved(f,4,4,false);
  ccsdsDerand(f,4,CCSDS_FRAME-4);
  return f;
}
const LRPT_PULSE=(()=>{
  const a=.6, N=2*LRPT_SPAN*LRPT_TAB+1, h=new Float32Array(N+1);
  for(let k=0;k<N;k++){
    const t=(k-LRPT_SPAN*LRPT_TAB)/LRPT_TAB; let v;
    if(Math.abs(t)<1e-9) v=1-a+4*a/Math.PI;
    else if(Math.abs(Math.abs(4*a*t)-1)<1e-9) v=a/Math.SQRT2*((1+2/Math.PI)*Math.sin(Math.PI/(4*a))+(1-2/Math.PI)*Math.cos(Math.PI/(4*a)));
    else v=(Math.sin(Math.PI*t*(1-a))+4*a*t*Math.cos(Math.PI*t*(1+a)))/(Math.PI*t*(1-(4*a*t)**2));
    h[k]=v;
  }
  let e=0; for(let k=0;k<N;k+=LRPT_TAB) e+=h[k]*h[k];  // энергия на символ = 1
  for(let k=0;k<N;k++) h[k]/=Math.sqrt(e);
  return h; })();
function lrptPulse(t){                                // t — в символах
  const x=(t+LRPT_SPAN)*LRPT_TAB;
  if(x<=0 || x>=2*LRPT_SPAN*LRPT_TAB) return 0;
  const i=Math.floor(x), f=x-i;
  return LRPT_PULSE[i]+(LRPT_PULSE[i+1]-LRPT_PULSE[i])*f;
}
// следующий символ: [I, Q] по ±1/√2
function lrptNextSym(g){
  if(g.bp>=g.bits.length){
    const f=lrptCadu(g.cnt++), raw=new Uint8Array(8*CCSDS_FRAME);
    for(let i=0;i<raw.length;i++) raw[i]=(f[i>>3]>>(7-(i&7)))&1;
    if(g.nrzm) for(let i=0;i<raw.length;i++){ g.nz^=raw[i]; raw[i]=g.nz; }
    g.bits=ccEncode(g.cc,raw); g.bp=0;
  }
  const a=g.bits[g.bp++], b=g.bits[g.bp++];
  return [(1-2*a)*Math.SQRT1_2, (1-2*b)*Math.SQRT1_2];
}
// N отсчётов комплексной огибающей на частоте sr → [re, im]
function lrptGenerate(n,sr,N,variant){
  let g=n.lrpt;
  if(!g || g.sr!==sr || g.variant!==variant){
    g=n.lrpt={sr, variant, oq:!/^QPSK/.test(variant), nrzm:!/^QPSK/.test(variant), cc:{r:0}, nz:0,
      cnt:0, bits:new Uint8Array(0), bp:0, t:0, k0:0, sI:[], sQ:[]};
  }
  const re=new Float32Array(N), im=new Float32Array(N), dt=LRPT_RS/sr, off=g.oq ? .5 : 0;
  for(let i=0;i<N;i++){
    const t=g.t, lo=Math.floor(t-off)-LRPT_SPAN, hi=Math.ceil(t)+LRPT_SPAN;
    while(g.k0+g.sI.length<=hi){ const [a,b]=lrptNextSym(g); g.sI.push(a); g.sQ.push(b); }
    let I=0, Q=0;
    for(let k=Math.max(lo,g.k0);k<=hi;k++){
      const j=k-g.k0;
      I+=g.sI[j]*lrptPulse(t-k); Q+=g.sQ[j]*lrptPulse(t-k-off);
    }
    re[i]=I; im[i]=Q;
    g.t+=dt;
    const drop=Math.floor(g.t-off)-LRPT_SPAN-1-g.k0;
    if(drop>256){ g.sI.splice(0,drop); g.sQ.splice(0,drop); g.k0+=drop; }
  }
  return [re,im];
}
