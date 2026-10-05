"use strict";
/* ============================ Радиозонды: Vaisala RS41 ============================
   Ядро IQK (страница и воркер острова), без DOM. По rs41mod.c + bch_ecc_mod.c (zilog80,
   github.com/rs1729/RS, GPLv3). 400–406 МГц, GFSK 4800 Бод (девиация ±2.4 кГц), NRZ, биты младшим
   вперёд. Кадр: заголовок 8 байт, всё — XOR с маской 64 байта; RS(255,231) ×2 (GF 0x11D, корни α⁰…α²³),
   проверочные байты [8..56), данные — через байт с 56; кадр 320 байт (или 518 с доп. данными).
   Блоки с 0x39: [тип][длина][данные][CRC-16 CCITT, младший вперёд]:
     0x79 — номер кадра, серийный номер, батарея, кусок калибровки (16 байт из 51×16)
     0x7A — PTU: 12 частот (24 бит), 0x7C — неделя и время GPS, 0x7B — ECEF (см) и скорость (см/с). */

const RS41_BAUD=4800, RS41_NDATA=320, RS41_FRAME=518, RS41_HDR=8;
const RS41_HDR_BYTES=[0x86,0x35,0xF4,0x40,0x93,0xDF,0x1A,0x60];
const RS41_MASK=[0x96,0x83,0x3E,0x51,0xB1,0x49,0x08,0x98, 0x32,0x05,0x59,0x0E,0xF9,0x44,0xC6,0x26,
  0x21,0x60,0xC2,0xEA,0x79,0x5D,0x6D,0xA1, 0x54,0x69,0x47,0x0C,0xDC,0xE8,0x5C,0xF1,
  0xF7,0x76,0x82,0x7F,0x07,0x99,0xA2,0x2C, 0x93,0x7C,0x30,0x63,0xF5,0x10,0x2E,0x61,
  0xD0,0xBC,0xB4,0xB6,0x06,0xAA,0xF4,0x23, 0x78,0x6E,0x3B,0xAE,0xBF,0x7B,0x4C,0xC1];
// заголовок в эфире (после маски), биты по порядку передачи: ±1
const RS41_HDR_BITS=(()=>{ const b=[];
  for(let i=0;i<RS41_HDR;i++){ const v=RS41_HDR_BYTES[i]^RS41_MASK[i]; for(let k=0;k<8;k++) b.push((v>>k)&1 ? 1 : -1); }
  return b; })();
const RS41_RS=rsCodec(0x11D,0,1,24);
function rs41Crc(b,from,len){ return crc16(b,from,len,0x1021,0xFFFF,0); }
// длина по байту 0x38: 0x0F — 320, 0xF0 — 518 (с запасом на ошибки)
function rs41Len(f){ const b=f[0x38]; let t=0; for(let i=0;i<4;i++) t+=((b>>i)&1)-((b>>(i+4))&1); return t>=0 ? RS41_NDATA : RS41_FRAME; }
// кодовые слова RS41: cw[j] — коэффициент при X^j, проверочные j<24; у кодека старшая степень первой
function rs41Cw(f,w,cw){
  for(let j=0;j<24;j++) cw[254-j]=f[8+24*w+j];
  for(let i=0;i<231;i++) cw[230-i]=f[56+2*i+w];
}
function rs41CwPut(f,w,cw){
  for(let j=0;j<24;j++) f[8+24*w+j]=cw[254-j];
  for(let i=0;i<231;i++){ const p=56+2*i+w; if(p<RS41_FRAME) f[p]=cw[230-i]; }
}
// исправление кадра (518 байт, за длиной — нули): [ошибок в слове 1, 2] (−1 — не исправить)
function rs41Ecc(f,len){
  for(let i=len;i<RS41_FRAME;i++) f[i]=0;
  const cw=new Uint8Array(255), res=[];
  for(let w=0;w<2;w++){ rs41Cw(f,w,cw); const e=RS41_RS.decode(cw); res.push(e); if(e>0) rs41CwPut(f,w,cw); }
  return res;
}
function rs41EccEncode(f){
  const cw=new Uint8Array(255);
  for(let w=0;w<2;w++){ rs41Cw(f,w,cw); RS41_RS.encode(cw); rs41CwPut(f,w,cw); }
}
const rs41U2=(f,p)=>f[p]|(f[p+1]<<8), rs41I2=(f,p)=>(rs41U2(f,p)<<16)>>16;
const rs41U3=(f,p)=>f[p]|(f[p+1]<<8)|(f[p+2]<<16), rs41I4=(f,p)=>f[p]|(f[p+1]<<8)|(f[p+2]<<16)|(f[p+3]<<24);
function rs41F32(b,p){ const d=new DataView(new ArrayBuffer(4)); for(let i=0;i<4;i++) d.setUint8(i,b[p+i]); return d.getFloat32(0,true); }

// ECEF (м) → широта, долгота (°), высота над эллипсоидом (м) — как ecef2elli
function rs41Ecef2Geo(X,Y,Z){
  const a=6378137, b=6356752.31424518, e2=(a*a-b*b)/(a*a), ee2=(a*a-b*b)/(b*b);
  const lam=Math.atan2(Y,X), p=Math.hypot(X,Y), t=Math.atan2(Z*a,p*b);
  const phi=Math.atan2(Z+ee2*b*Math.sin(t)**3, p-e2*a*Math.cos(t)**3);
  const R=a/Math.sqrt(1-e2*Math.sin(phi)**2);
  return [phi*180/Math.PI, lam*180/Math.PI, p/Math.cos(phi)-R];
}
function rs41Geo2Ecef(lat,lon,h){
  const a=6378137, b=6356752.31424518, e2=(a*a-b*b)/(a*a), f=lat*Math.PI/180, l=lon*Math.PI/180;
  const N=a/Math.sqrt(1-e2*Math.sin(f)**2);
  return [(N+h)*Math.cos(f)*Math.cos(l), (N+h)*Math.cos(f)*Math.sin(l), (N*(1-e2)+h)*Math.sin(f)];
}

/* ---- разбор кадра ---- */
// st — состояние зонда (калибровка по серийному номеру); → {id, frame, batt, lat, lon, alt, ...} или null
function rs41Parse(f,len,st){
  const r={crcBad:0};
  let p=0x39;
  while(p+4<=len){
    const typ=f[p], L=f[p+1];
    if(p+2+L+2>len) break;
    const ok=rs41Crc(f,p+2,L)===rs41U2(f,p+2+L);
    if(!ok){ r.crcBad++; p+=2+L+2; continue; }
    const d=p+2;
    if(typ===0x79 && L>=0x28){
      r.frame=rs41U2(f,d);
      r.id=String.fromCharCode(...f.subarray(d+2,d+10)).replace(/[^\x20-\x7e]/g,'').trim();
      r.batt=f[d+10]/10;
      const cal=st.cal(r.id), k=f[d+23];
      if(k<51 && !cal.have[k]){ cal.bytes.set(f.subarray(d+24,d+40),k*16); cal.have[k]=1; }
      r.cal=cal;
    } else if(typ===0x7A && L>=36){
      r.meas=[]; for(let i=0;i<12;i++) r.meas.push(rs41U3(f,d+3*i));
    } else if(typ===0x7C && L>=6){
      r.week=rs41U2(f,d); r.tow=rs41I4(f,d+2)>>>0;
    } else if(typ===0x7B && L>=21){
      const X=rs41I4(f,d)/100, Y=rs41I4(f,d+4)/100, Z=rs41I4(f,d+8)/100;
      const V=[rs41I2(f,d+12)/100, rs41I2(f,d+14)/100, rs41I2(f,d+16)/100];
      const [lat,lon,alt]=rs41Ecef2Geo(X,Y,Z);
      if(alt>-1000 && alt<80000){
        const f1=lat*Math.PI/180, l1=lon*Math.PI/180;
        const vN=-V[0]*Math.sin(f1)*Math.cos(l1)-V[1]*Math.sin(f1)*Math.sin(l1)+V[2]*Math.cos(f1);
        const vE=-V[0]*Math.sin(l1)+V[1]*Math.cos(l1);
        const vU=V[0]*Math.cos(f1)*Math.cos(l1)+V[1]*Math.cos(f1)*Math.sin(l1)+V[2]*Math.sin(f1);
        Object.assign(r,{lat, lon, alt, vh:Math.hypot(vN,vE), heading:(Math.atan2(vE,vN)*180/Math.PI+360)%360, climb:vU, sats:f[d+18]});
      }
    }
    p+=2+L+2;
  }
  // температура (платиновый датчик) и влажность (эмпирически), когда пришла нужная калибровка
  if(r.meas && r.cal){
    const c=r.cal, h=c.have;
    if(h[3] && h[4] && h[5] && h[6]){
      const B=c.bytes, g32=o=>rs41F32(B,o), [F,F1,F2]=r.meas;
      const Rf1=g32(61), Rf2=g32(65), co=[g32(77),g32(81),g32(85)], ct=[g32(89),g32(93),g32(97)];
      const gn=(F2-F1)/(Rf2-Rf1), Rb=(F1*Rf2-F2*Rf1)/(F2-F1), R=(F/gn-Rb)*ct[0];
      const T=(co[0]+co[1]*R+co[2]*R*R+ct[1])*(1+ct[2]);
      if(isFinite(T) && T>-120 && T<80) r.temp=T;
      if(h[7] && r.temp!=null){
        const [H,H1,H2]=r.meas.slice(3,6), a1=350/g32(117), fh=(H-H1)/(H2-H1);
        let rh=100*(a1*fh-7.5); rh+=-r.temp/5.5;
        if(r.temp<-20) rh*=1+(-20-r.temp)/100;
        if(r.temp<-40) rh*=1+(-40-r.temp)/120;
        if(isFinite(rh)) r.rh=Math.max(0,Math.min(100,rh));
      }
    }
  }
  if(r.week!=null){                                  // GPS → UTC (18 с високосных)
    r.time=Date.UTC(1980,0,6)+r.week*604800000+r.tow-18000;
  }
  return r.id ? r : null;
}
function rs41State(){
  const cals=new Map();
  return {cal(id){ let c=cals.get(id); if(!c){ c={bytes:new Uint8Array(51*16), have:new Uint8Array(51)}; cals.set(id,c); } return c; }};
}

/* ---- RS41 Receiver ---- */
// IQ (любая частота) → ≈48 кС/с → ЧМ-дискриминатор; вещественный поток — уже ЧМ-звук (запись с приёмника).
// Заголовок — нормированная корреляция по 64 битам (интегралы по дробным окнам через префиксные суммы),
// дальше биты по окнам с подстройкой тактов на переходах; маска, RS, блоки.
IQK.rs41Rx={
  init(n){ n.key=''; n.st=rs41State(); n.frames=0; n.bad=0; n.fixed=0; n.sondes=new Map(); n.lastT=0; },
  setup(n,s,cplx){
    const M=cplx ? Math.max(1,Math.floor(s.sr/40000)) : 1;
    n.M=M; n.fs=s.sr/M; n.sps=n.fs/RS41_BAUD;
    n.dec=M>1 ? {p:{M:String(M), cut:Math.min(.45,14000/n.fs), tpp:'16'}} : null;
    if(n.dec) IQK.iqDecim.init(n.dec);
    // канал ±10 кГц: GFSK ±2.4 кГц на 4800 Бод плюс уход частоты зонда и донгла
    n.lp=cplx ? kaiserLP(n.fs,10000,14000,255) : null;
    if(n.lp){ n.lr=new Float32Array(n.lp.length-1); n.li=new Float32Array(n.lp.length-1); }
    n.buf=new Float32Array(0); n.b0=0; n.scan=0; n.pr=0; n.pi=0; n.ctr=null;
  },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {rec:null}; }
    const cplx=s.chunks.length ? !!s.chunks[0].im : n.cplx;
    const key=s.sr+'|'+cplx;
    if(key!==n.key){ n.key=key; n.cplx=cplx; this.setup(n,s,cplx); }
    const src=n.dec ? IQK.iqDecim.process(n.dec,{in:s}).out : s;
    // ЧМ: приращение фазы, Гц
    const parts=[];
    for(const c of src.chunks){
      if(!n.cplx){ parts.push(c.re); continue; }
      const xr=firRun(n.lp,n.lr,c.re), xi=firRun(n.lp,n.li,iqChunkIm(c)), K=xr.length, y=new Float32Array(K), k=n.fs/(2*Math.PI);
      let pr=n.pr, pi=n.pi;
      for(let i=0;i<K;i++){ const a=xr[i], b=xi[i]; y[i]=Math.atan2(b*pr-a*pi, a*pr+b*pi)*k; pr=a; pi=b; }
      n.pr=pr; n.pi=pi; parts.push(y);
    }
    let add=0; for(const p of parts) add+=p.length;
    const nb=new Float32Array(n.buf.length+add); nb.set(n.buf); let o=n.buf.length;
    for(const p of parts){ nb.set(p,o); o+=p.length; }
    n.buf=nb;
    const recs=this.scan(n);
    // запас: полкадра назад от места поиска
    const keep=Math.max(0,Math.floor(n.scan-n.b0-2*RS41_HDR*8*n.sps));
    if(keep>0){ n.buf=n.buf.slice(keep); n.b0+=keep; }
    const now=Date.now();
    for(const [id,z] of n.sondes) if(now-z.seen>600000) n.sondes.delete(id);
    n.ui={fs:n.fs, M:n.M, frames:n.frames, bad:n.bad, fixed:n.fixed, sondes:[...n.sondes.values()].map(z=>({...z}))};
    return {rec:recs.length ? recs : null};
  },
  // поиск заголовка и чтение кадров во всём накопленном буфере
  scan(n){
    const buf=n.buf, N=buf.length, sps=n.sps, recs=[];
    const P=new Float64Array(N+1); for(let i=0;i<N;i++) P[i+1]=P[i]+buf[i];
    const G=x=>{ const k=Math.max(0,Math.min(N-1,Math.floor(x))); return P[k]+(x-k)*buf[k]; };
    const S=(a,b)=>G(b)-G(a);
    const H=RS41_HDR_BITS, NH=H.length, need=RS41_FRAME*8*sps+4;
    const corr=x=>{                                   // нормированная корреляция с заголовком и ±1 × уровень
      let m=0; const v=new Float64Array(NH);
      for(let k=0;k<NH;k++){ v[k]=S(x+k*sps,x+(k+1)*sps); m+=v[k]; }
      m/=NH; let c=0, e=0;
      for(let k=0;k<NH;k++){ const d=v[k]-m; c+=H[k]*d; e+=d*d; }
      return [c/Math.sqrt(e*NH+1e-30), m];
    };
    let x=Math.max(n.scan-n.b0,0);
    while(x+need<N){
      const [c]=corr(x);
      if(Math.abs(c)<.7){ x+=1; continue; }
      // лучший сдвиг в пределах бита, шаг ¼ отсчёта
      let bx=x, bc=c, bm=0;
      for(let d=0;d<=sps;d+=.25){ const [cc,mm]=corr(x+d); if(Math.abs(cc)>Math.abs(bc)){ bc=cc; bx=x+d; bm=mm; } }
      if(!bm) bm=corr(bx)[1];
      const f=this.bits(n,S,bx,bc>0 ? 1 : -1,bm);
      const r=this.frame(n,f);
      if(r) recs.push(r);
      x=bx+RS41_NDATA*8*sps;                          // следующий — не раньше конца короткого кадра
    }
    n.scan=n.b0+x;
    return recs;
  },
  // биты кадра с подстройкой тактов: на переходе середина между битами должна быть на уровне m
  bits(n,S,x0,pol,m){
    const sps=n.sps, f=new Uint8Array(RS41_FRAME), g=.15*sps;
    let t=x0, prev=null;
    for(let k=0;k<RS41_FRAME*8;k++){
      const a=t+k*sps;
      const v=S(a+g,a+sps-g)/(sps-2*g)-m/sps;
      const bit=v*pol>0 ? 1 : 0;
      if(bit) f[k>>3]|=1<<(k&7);
      if(prev!=null && bit!==prev){                   // середина перехода: ушла к новому биту — мы опаздываем
        const mid=S(a-.1*sps,a+.1*sps)/(.2*sps)-m/sps, amp=Math.abs(v)+1e-9;
        t-=.04*sps*Math.max(-1,Math.min(1,mid*pol*(bit ? 1 : -1)/amp));
      }
      prev=bit;
    }
    for(let i=0;i<RS41_FRAME;i++) f[i]^=RS41_MASK[i%64];
    return f;
  },
  frame(n,f){
    const len=rs41Len(f), e=rs41Ecc(f,len);
    const r=rs41Parse(f,len,n.st);
    if(!r){ n.bad++; return null; }
    n.frames++;
    if(e[0]>0) n.fixed+=e[0]; if(e[1]>0) n.fixed+=e[1];
    const z=n.sondes.get(r.id)||{id:r.id};
    Object.assign(z,{seen:Date.now(), frame:r.frame, batt:r.batt, ecc:e.join('/')});
    for(const k of ['lat','lon','alt','vh','climb','heading','sats','temp','rh','time']) if(r[k]!=null) z[k]=r[k];
    n.sondes.set(r.id,z);
    if(r.lat==null) return null;
    const rec={t:r.time||Date.now(), id:r.id, label:r.id, lat:+r.lat.toFixed(6), lon:+r.lon.toFixed(6), alt:Math.round(r.alt),
      icon:'balloon', heading:Math.round(r.heading), vh:+r.vh.toFixed(1), climb:+r.climb.toFixed(1), sats:r.sats,
      frame:r.frame, batt:r.batt, src:'RS41'};
    if(r.temp!=null) rec.temp=+r.temp.toFixed(1);
    if(r.rh!=null) rec.rh=Math.round(r.rh);
    return rec;
  }};

/* ---- генератор: зонд RS41 в полёте ---- */
// Подъём 5 м/с от точки старта, ветер 8 м/с на северо-восток; кадр раз в секунду, 320 байт.
// Калибровка T: Rf1=750, Rf2=1100, co=[−243.9, 0.1877, 8.2e−6], calT=[1.28, −0.064, 0]; частоты подбираются под T.
const RS41_SIM={id:'S3140159', lat:55.03, lon:82.92, alt:150, up:5, wind:8, dir:45};
const RS41_SIM_CAL=(()=>{
  const b=new Uint8Array(51*16), d=new DataView(b.buffer), put=(o,v)=>d.setFloat32(o,v,true);
  put(61,750); put(65,1100); put(77,-243.9108); put(81,0.187654); put(85,8.2e-6);
  put(89,1.279928); put(93,-0.063965); put(97,0); put(117,47.5);
  return b; })();
function rs41SimState(t){                             // t — секунды полёта
  const z=RS41_SIM, alt=z.alt+z.up*t, dist=z.wind*t, a=z.dir*Math.PI/180;
  const lat=z.lat+dist*Math.cos(a)/111320, lon=z.lon+dist*Math.sin(a)/(111320*Math.cos(z.lat*Math.PI/180));
  const temp=15-6.5*alt/1000, rh=Math.max(5,80-alt/200);
  return {lat, lon, alt, temp, rh, vN:z.wind*Math.cos(a), vE:z.wind*Math.sin(a), vU:z.up};
}
function rs41SimFrame(k){                             // k — номер кадра (секунда)
  const s=rs41SimState(k), f=new Uint8Array(RS41_FRAME);
  f.set(RS41_HDR_BYTES,0); f[0x38]=0x0F;
  const blk=(p,typ,L,fill)=>{ f[p]=typ; f[p+1]=L; fill(p+2); const c=rs41Crc(f,p+2,L); f[p+2+L]=c&255; f[p+3+L]=c>>8; };
  const u2=(o,v)=>{ f[o]=v&255; f[o+1]=(v>>8)&255; }, u3=(o,v)=>{ u2(o,v); f[o+2]=(v>>16)&255; };
  const i4=(o,v)=>{ for(let i=0;i<4;i++) f[o+i]=(v>>(8*i))&255; };
  blk(0x39,0x79,0x28,d=>{
    u2(d,k&0xFFFF); for(let i=0;i<8;i++) f[d+2+i]=RS41_SIM.id.charCodeAt(i); f[d+10]=29;
    const c=k%51; f[d+23]=c; f.set(RS41_SIM_CAL.subarray(c*16,c*16+16),d+24);
  });
  blk(0x65,0x7A,0x2A,d=>{
    // T: R из квадратного уравнения, частота F = R/ct0 · g (g=400, Rb=0 при F1=300000, F2=440000)
    const cal=RS41_SIM_CAL, g32=o=>rs41F32(cal,o), co=[g32(77),g32(81),g32(85)], ct=[g32(89),g32(93)];
    const want=s.temp/(1+g32(97))-ct[1]-co[0], R=(-co[1]+Math.sqrt(co[1]*co[1]+4*co[2]*want))/(2*co[2]);
    u3(d,Math.round(R/ct[0]*400)); u3(d+3,300000); u3(d+6,440000);
    // RH: fh по обратной эмпирической формуле (без поправок для T < −20 °C, у земли они не нужны)
    let rh=s.rh; if(s.temp<-40) rh/=1+(-40-s.temp)/120; if(s.temp<-20) rh/=1+(-20-s.temp)/100;
    const fh=((rh+s.temp/5.5)/100+7.5)/(350/g32(117));
    u3(d+9,Math.round(100000+fh*100000)); u3(d+12,100000); u3(d+15,200000);
  });
  blk(0x93,0x7C,0x1E,d=>{
    const ms=Date.UTC(2026,8,29,12,0,0)+k*1000+18000-Date.UTC(1980,0,6);
    u2(d,Math.floor(ms/604800000)); i4(d+2,ms%604800000);
  });
  blk(0xB5,0x7D,0x59,()=>{});
  blk(0x112,0x7B,0x15,d=>{
    const [X,Y,Z]=rs41Geo2Ecef(s.lat,s.lon,s.alt), f1=s.lat*Math.PI/180, l1=s.lon*Math.PI/180;
    const vx=-s.vN*Math.sin(f1)*Math.cos(l1)-s.vE*Math.sin(l1)+s.vU*Math.cos(f1)*Math.cos(l1);
    const vy=-s.vN*Math.sin(f1)*Math.sin(l1)+s.vE*Math.cos(l1)+s.vU*Math.cos(f1)*Math.sin(l1);
    const vz=s.vN*Math.cos(f1)+s.vU*Math.sin(f1);
    i4(d,Math.round(X*100)); i4(d+4,Math.round(Y*100)); i4(d+8,Math.round(Z*100));
    u2(d+12,Math.round(vx*100)&0xFFFF); u2(d+14,Math.round(vy*100)&0xFFFF); u2(d+16,Math.round(vz*100)&0xFFFF);
    f[d+18]=9;
  });
  blk(0x12B,0x76,0x11,()=>{});
  rs41EccEncode(f);
  return f.subarray(0,RS41_NDATA);
}
// отклик гауссова фильтра (BT=0.5) на один бит [0, 1): Φ(v/σ) − Φ((v−1)/σ), σ = √ln2/(2π·BT) бита; v ∈ [−3, 4)
const RS41_GP=(()=>{
  const sg=Math.sqrt(Math.log(2))/(2*Math.PI*.5), T=new Float32Array(7*64+2);
  const erf=x=>{ const t=1/(1+.3275911*Math.abs(x)), y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-.284496736)*t+.254829592)*t*Math.exp(-x*x); return x<0 ? -y : y; };
  const Phi=x=>.5*(1+erf(x/Math.SQRT2));
  for(let i=0;i<T.length;i++){ const v=i/64-3; T[i]=Phi(v/sg)-Phi((v-1)/sg); }
  return T; })();
function rs41Pulse(v){ const x=(v+3)*64; if(x<0 || x>=7*64) return 0; const i=Math.floor(x); return RS41_GP[i]+(RS41_GP[i+1]-RS41_GP[i])*(x-i); }
// N отсчётов комплексной огибающей: GFSK ±2.4 кГц, кадр в начале каждой секунды, между кадрами — несущая
function rs41Generate(n,sr,N){
  let g=n.rs41;
  if(!g || g.sr!==sr) g=n.rs41={sr, t:0, ph:0, k:0, bits:null, bs:0};
  const re=new Float32Array(N), im=new Float32Array(N), spb=sr/RS41_BAUD, w=2*Math.PI*2400/sr;
  for(let i=0;i<N;i++,g.t++){
    const sec=Math.floor(g.t/sr);
    if(sec>=g.k){                                     // новый кадр в начале секунды
      const f=rs41SimFrame(g.k);
      g.bits=new Int8Array(f.length*8);
      for(let j=0;j<f.length;j++){ const v=f[j]^RS41_MASK[j%64]; for(let b=0;b<8;b++) g.bits[8*j+b]=(v>>b)&1 ? 1 : -1; }
      g.k=sec+1; g.bs=g.t;
    }
    let fq=0;
    if(g.bits){
      const u=(g.t-g.bs)/spb, k0=Math.floor(u);
      for(let k=k0-3;k<=k0+3;k++) if(k>=0 && k<g.bits.length) fq+=g.bits[k]*rs41Pulse(u-k);
    }
    g.ph+=w*fq;
    re[i]=Math.cos(g.ph); im[i]=Math.sin(g.ph);
  }
  g.ph%=2*Math.PI;
  return [re,im];
}
