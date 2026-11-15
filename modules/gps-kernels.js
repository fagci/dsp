"use strict";
/* ============================ GPS L1 C/A: ядро приёмника (и передатчика для проверки) ============================
   Чистая логика без DOM: node tools/test-gps.mjs. Схема опирается на открытый ICD (IS-GPS-200), код написан заново.
   Цепочка: IQ → gpsAcquire (поиск PRN: допплер + задержка кода) → gpsTrackNew/gpsTrackPush (DLL + PLL по 1 мс)
            → gpsChannelNav (синхронизация бит, кадров, эфемериды) → gpsPseudoranges → gpsSolve (x, y, z, смещение часов).
   Зеркало (кодер): gpsBuildSubframe ↔ gpsParseSubframe, gpsSynth — синтетический эфир по орбитам (для проверки без эфира).
   Сигналы gpsSynth несут выдуманные эфемериды — «не излучать в эфир».
   IQ: {re,im} Float32Array, частота дискретизации fs кратна 1 кГц; для поиска fs/1000 — степень двойки (RTL-SDR: 2.048 МГц).
   Время недели — секунды; позиции — ECEF, метры. */

const GPS_C=299792458, GPS_FL1=1575.42e6, GPS_FCODE=1.023e6, GPS_PI=3.1415926535898, GPS_OMEGA=7.292115147e-5, GPS_MU=3.986005e14;

// ---------- C/A-коды ----------
const GPS_G2TAPS=[null,[2,6],[3,7],[4,8],[5,9],[1,9],[2,10],[1,8],[2,9],[3,10],[2,3],[3,4],[5,6],[6,7],[7,8],[8,9],[9,10],[1,4],[2,5],[3,6],[4,7],[5,8],[6,9],[1,3],[4,6],[5,7],[6,8],[7,9],[8,10],[1,6],[2,7],[3,8],[4,9]];
const _gpsCAc={};
// 1023 чипа PRN 1…32: Int8Array из ±1 (бит 0 → +1)
function gpsCA(prn){
  if(_gpsCAc[prn]) return _gpsCAc[prn];
  const t=GPS_G2TAPS[prn]; if(!t) throw new Error('PRN 1…32');
  const g1=new Uint8Array(11).fill(1), g2=new Uint8Array(11).fill(1), out=new Int8Array(1023);
  for(let i=0;i<1023;i++){
    const b=g1[10]^g2[t[0]]^g2[t[1]]; out[i]=b?-1:1;
    const f1=g1[3]^g1[10], f2=g2[2]^g2[3]^g2[6]^g2[8]^g2[9]^g2[10];
    for(let k=10;k>1;k--){ g1[k]=g1[k-1]; g2[k]=g2[k-1]; } g1[1]=f1; g2[1]=f2;
  }
  return _gpsCAc[prn]=out;
}

// ---------- FFT (степень двойки) ----------
const _gpsFT={};
function gpsFFT(re,im,inv){
  const n=re.length; let T=_gpsFT[n];
  if(!T){ const c=new Float64Array(n>>1), s=new Float64Array(n>>1), rev=new Uint32Array(n); let lg=0; while((1<<lg)<n) lg++;
    for(let i=0;i<(n>>1);i++){ c[i]=Math.cos(2*Math.PI*i/n); s[i]=Math.sin(2*Math.PI*i/n); }
    for(let i=0;i<n;i++){ let r=0; for(let b=0;b<lg;b++) if(i&(1<<b)) r|=1<<(lg-1-b); rev[i]=r; }
    T=_gpsFT[n]={c,s,rev}; }
  for(let i=0;i<n;i++){ const j=T.rev[i]; if(j>i){ let t=re[i]; re[i]=re[j]; re[j]=t; t=im[i]; im[i]=im[j]; im[j]=t; } }
  const sg=inv?1:-1;
  for(let len=2;len<=n;len<<=1){ const h=len>>1, st=n/len;
    for(let i=0;i<n;i+=len) for(let k=0;k<h;k++){
      const wr=T.c[k*st], wi=sg*T.s[k*st], a=i+k, b=a+h, xr=re[b]*wr-im[b]*wi, xi=re[b]*wi+im[b]*wr;
      re[b]=re[a]-xr; im[b]=im[a]-xi; re[a]+=xr; im[a]+=xi; } }
  if(inv) for(let i=0;i<n;i++){ re[i]/=n; im[i]/=n; }
}

// ---------- навигационное сообщение: подкадры 1–3 (эфемериды) ----------
// поле: [имя, [[слово 0…9, смещение, длина],…] (данные слова — 24 бита), вес младшего бита, знаковое]
const _P=GPS_PI;
const GPS_SF={
 1:[['weekNum',[[2,0,10]],1,0],['satAcc',[[2,12,4]],1,0],['satHealth',[[2,16,6]],1,0],['IODC',[[2,22,2],[7,0,8]],1,0],['Tgd',[[6,16,8]],2**-31,1],
    ['Toc',[[7,8,16]],16,0],['af2',[[8,0,8]],2**-55,1],['af1',[[8,8,16]],2**-43,1],['af0',[[9,0,22]],2**-31,1]],
 2:[['IODE2',[[2,0,8]],1,0],['Crs',[[2,8,16]],2**-5,1],['deltaN',[[3,0,16]],2**-43*_P,1],['M0',[[3,16,8],[4,0,24]],2**-31*_P,1],['Cuc',[[5,0,16]],2**-29,1],
    ['e',[[5,16,8],[6,0,24]],2**-33,0],['Cus',[[7,0,16]],2**-29,1],['sqrtA',[[7,16,8],[8,0,24]],2**-19,0],['Toe',[[9,0,16]],16,0]],
 3:[['Cic',[[2,0,16]],2**-29,1],['omegaBig',[[2,16,8],[3,0,24]],2**-31*_P,1],['Cis',[[4,0,16]],2**-29,1],['i0',[[4,16,8],[5,0,24]],2**-31*_P,1],
    ['Crc',[[6,0,16]],2**-5,1],['omegaSmall',[[6,16,8],[7,0,24]],2**-31*_P,1],['omegaDot',[[8,0,24]],2**-43*_P,1],['IDOT',[[9,8,14]],2**-43*_P,1],['IODE3',[[9,0,8]],1,0]]
};
const GPS_PRE=[1,0,0,0,1,0,1,1];
// маски чётности (индексы бит данных слова) и какой из D29*/D30* добавляется
const GPS_PAR=[[[0,1,2,4,5,9,10,11,12,13,16,17,19,22],29],[[1,2,3,5,6,10,11,12,13,14,17,18,20,23],30],[[0,2,3,4,6,7,11,12,13,14,15,18,19,21],29],
               [[1,3,4,5,7,8,12,13,14,15,16,19,20,22],30],[[0,2,4,5,6,8,9,13,14,15,16,17,20,21,23],30],[[2,4,5,7,8,9,10,12,14,18,21,22,23],29]];
function gpsParity(d,d29,d30){ const r=new Uint8Array(6); for(let k=0;k<6;k++){ let b=GPS_PAR[k][1]===29?d29:d30; for(const i of GPS_PAR[k][0]) b^=d[i]; r[k]=b; } return r; }
function _gpsPut(D,parts,raw,len){ // raw — целое [0,2^len); старшие биты — в первых частях
  let rest=len; for(const [w,o,l] of parts){ rest-=l; const v=Math.floor(raw/2**rest)%(2**l); for(let i=0;i<l;i++) D[w*24+o+i]=Math.floor(v/2**(l-1-i))&1; }
}
function _gpsGet(D,parts){ let v=0,len=0; for(const [w,o,l] of parts){ for(let i=0;i<l;i++) v=v*2+D[w*24+o+i]; len+=l; } return [v,len]; }
// подкадр → 300 бит (передача). sf: {id, tow (счётчик HOW = начало СЛЕДУЮЩЕГО подкадра /6 с), поля эфемерид, fill — 192 бита заполнения для id 4/5}
function gpsBuildSubframe(sf){
  const D=new Uint8Array(240); GPS_PRE.forEach((b,i)=>D[i]=b);
  _gpsPut(D,[[1,0,17]],sf.tow%131072,17); _gpsPut(D,[[1,19,3]],sf.id,3);
  for(const [name,parts,lsb,sg] of GPS_SF[sf.id]||[]){ let len=0; for(const p of parts) len+=p[2]; let q=Math.round((sf[name]||0)/lsb);
    const lim=2**(sg?len-1:len); q=Math.max(sg?-lim:0,Math.min(lim-1,q)); _gpsPut(D,parts,q<0?q+2**len:q,len); }
  if(sf.id>3 && sf.fill) for(let i=0;i<192;i++) D[48+i]=sf.fill[i]&1;
  const out=new Uint8Array(300); let d29=0,d30=0;
  for(let w=0;w<10;w++){
    const d=D.subarray(w*24,w*24+24);
    if(w===1||w===9){ let ok=false; for(let t=0;t<4&&!ok;t++){ d[22]=t&1; d[23]=t>>1; const p=gpsParity(d,d29,d30); ok=(p[4]===0&&p[5]===0); } } // два последних бита слова 0,0
    const p=gpsParity(d,d29,d30);
    for(let i=0;i<24;i++) out[w*30+i]=d[i]^d30; for(let i=0;i<6;i++) out[w*30+24+i]=p[i];
    d29=p[4]; d30=p[5];
  }
  return out;
}
// 300 бит → {ok, err, id, tow, поля}. Полярность (фаза ФАПЧ неоднозначна) определяется по преамбуле
function gpsParseSubframe(bits){
  if(!bits || bits.length!==300) return {ok:false,err:'length'};
  let inv=0; for(let i=0;i<8;i++) if(bits[i]!==GPS_PRE[i]){ inv=1; break; }
  if(inv) for(let i=0;i<8;i++) if((bits[i]^1)!==GPS_PRE[i]) return {ok:false,err:'preamble'};
  const D=new Uint8Array(240); let d29=0,d30=0;
  for(let w=0;w<10;w++){
    const raw=new Uint8Array(30); for(let i=0;i<30;i++) raw[i]=bits[w*30+i]^inv;
    if(w>0){ for(let i=0;i<24;i++) raw[i]^=d30; const p=gpsParity(raw,d29,d30); for(let i=0;i<6;i++) if(p[i]!==raw[24+i]) return {ok:false,err:'parity',word:w+1}; }
    for(let i=0;i<24;i++) D[w*24+i]=raw[i]; d29=raw[28]; d30=raw[29];
  }
  const tow=_gpsGet(D,[[1,0,17]])[0], id=_gpsGet(D,[[1,19,3]])[0];
  if(id<1||id>5) return {ok:false,err:'id'};
  const sf={ok:true,err:'',id,tow,inv};
  for(const [name,parts,lsb,sg] of GPS_SF[id]||[]){ let [v,len]=_gpsGet(D,parts); if(sg&&v>=2**(len-1)) v-=2**len; sf[name]=v*lsb; }
  return sf;
}
// значения полей эфемерид, как они лягут в эфир (для генерации «правды»)
function gpsQuantize(eph){
  const o=Object.assign({},eph);
  for(const id of [1,2,3]) for(const [name,parts,lsb,sg] of GPS_SF[id]){ let len=0; for(const p of parts) len+=p[2]; const lim=2**(sg?len-1:len); const q=Math.max(sg?-lim:0,Math.min(lim-1,Math.round((eph[name]||0)/lsb))); o[name]=q*lsb; }
  return o;
}
// поиск подкадров в потоке бит (любой сдвиг и полярность): [{pos, sf}]
function gpsFindFrames(bits){
  const out=[];
  for(let i=0;i+300<=bits.length;){
    let m=0,mi=0; for(let k=0;k<8;k++){ if(bits[i+k]===GPS_PRE[k]) m++; else mi++; }
    if(m===8||mi===8){ const sf=gpsParseSubframe(bits.subarray?bits.subarray(i,i+300):bits.slice(i,i+300)); if(sf.ok){ out.push({pos:i,sf}); i+=300; continue; } }
    i++;
  }
  return out;
}
// копит подкадры 1–3 одного спутника: store={}; готово, когда есть три и совпали IODC(мл. 8 бит)=IODE2=IODE3
function gpsEphAdd(store,sf){
  if(!sf||!sf.ok||sf.id>3) return store.ready?store:null;
  const have=store['sf'+sf.id]; if(have && JSON.stringify(have)!==JSON.stringify(sf)) store.ready=false;
  store['sf'+sf.id]=sf;
  const a=store.sf1,b=store.sf2,c=store.sf3;
  if(a&&b&&c && (a.IODC&255)===b.IODE2 && b.IODE2===c.IODE3){ const e={}; for(const s of [a,b,c]) for(const [name] of GPS_SF[s.id]) e[name]=s[name]; e.iode=b.IODE2; store.eph=e; store.ready=true; }
  return store.ready?store:null;
}

// ---------- орбита, часы, координаты ----------
// эфемерида eph на момент системного времени t (с недели) → {x,y,z,dt}: ECEF спутника в момент излучения, dt — поправка часов спутника (с)
function gpsSatPos(e,t){
  const A=e.sqrtA*e.sqrtA, n=Math.sqrt(GPS_MU/(A*A*A))+e.deltaN;
  let tk=t-e.Toe; if(tk>302400) tk-=604800; else if(tk<-302400) tk+=604800;
  const M=e.M0+n*tk; let E=M; for(let i=0;i<12;i++) E=M+e.e*Math.sin(E);
  const sE=Math.sin(E), cE=Math.cos(E), nu=Math.atan2(Math.sqrt(1-e.e*e.e)*sE,cE-e.e), Phi=nu+e.omegaSmall;
  const s2=Math.sin(2*Phi), c2=Math.cos(2*Phi);
  const u=Phi+e.Cus*s2+e.Cuc*c2, r=A*(1-e.e*cE)+e.Crs*s2+e.Crc*c2, inc=e.i0+e.Cis*s2+e.Cic*c2+e.IDOT*tk;
  const xp=r*Math.cos(u), yp=r*Math.sin(u), Om=e.omegaBig+(e.omegaDot-GPS_OMEGA)*tk-GPS_OMEGA*e.Toe, cO=Math.cos(Om), sO=Math.sin(Om), ci=Math.cos(inc);
  let dtc=t-e.Toc; if(dtc>302400) dtc-=604800; else if(dtc<-302400) dtc+=604800;
  const dt=(e.af0||0)+(e.af1||0)*dtc+(e.af2||0)*dtc*dtc-4.442807633e-10*e.e*e.sqrtA*sE-(e.Tgd||0);
  return {x:xp*cO-yp*ci*sO, y:xp*sO+yp*ci*cO, z:yp*Math.sin(inc), dt};
}
// WGS84
function gpsGeo2Ecef(lat,lon,h){ const a=6378137, f=1/298.257223563, e2=f*(2-f), la=lat*Math.PI/180, lo=lon*Math.PI/180, s=Math.sin(la), N=a/Math.sqrt(1-e2*s*s);
  return [(N+h)*Math.cos(la)*Math.cos(lo),(N+h)*Math.cos(la)*Math.sin(lo),(N*(1-e2)+h)*s]; }
function gpsEcef2Geo(x,y,z){ const a=6378137, f=1/298.257223563, e2=f*(2-f), p=Math.hypot(x,y); let la=Math.atan2(z,p*(1-e2)), h=0;
  for(let i=0;i<8;i++){ const s=Math.sin(la), N=a/Math.sqrt(1-e2*s*s); h=p/Math.cos(la)-N; la=Math.atan2(z,p*(1-e2*N/(N+h))); }
  return {lat:la*180/Math.PI,lon:Math.atan2(y,x)*180/Math.PI,h}; }
// возвышение и азимут (градусы) спутника sat=[x,y,z] из точки rcv=[x,y,z]
function gpsElAz(rcv,sat){
  const g=gpsEcef2Geo(rcv[0],rcv[1],rcv[2]), la=g.lat*Math.PI/180, lo=g.lon*Math.PI/180, dx=sat[0]-rcv[0], dy=sat[1]-rcv[1], dz=sat[2]-rcv[2];
  const e=-Math.sin(lo)*dx+Math.cos(lo)*dy, n=-Math.sin(la)*Math.cos(lo)*dx-Math.sin(la)*Math.sin(lo)*dy+Math.cos(la)*dz, u=Math.cos(la)*Math.cos(lo)*dx+Math.cos(la)*Math.sin(lo)*dy+Math.sin(la)*dz;
  return {el:Math.atan2(u,Math.hypot(e,n))*180/Math.PI, az:(Math.atan2(e,n)*180/Math.PI+360)%360};
}
function _gpsInv(M,n){ // Гаусс–Жордан, M — массив строк; null, если вырождена
  const A=M.map((r,i)=>r.concat(Array.from({length:n},(_,j)=>i===j?1:0)));
  for(let c=0;c<n;c++){ let p=c; for(let r=c+1;r<n;r++) if(Math.abs(A[r][c])>Math.abs(A[p][c])) p=r; if(Math.abs(A[p][c])<1e-14) return null; [A[c],A[p]]=[A[p],A[c]];
    const d=A[c][c]; for(let k=0;k<2*n;k++) A[c][k]/=d; for(let r=0;r<n;r++) if(r!==c){ const f=A[r][c]; if(f) for(let k=0;k<2*n;k++) A[r][k]-=f*A[c][k]; } }
  return A.map(r=>r.slice(n));
}
// obs: [{x,y,z,pr}] (позиция спутника в момент излучения, псевдодальность с поправкой часов спутника). → {ok,x,y,z,cb(м),rms,pdop,lat,lon,h,iters}
function gpsSolve(obs,o={}){
  if(obs.length<4) return {ok:false,err:'need 4 satellites'};
  const x=(o.x0||[0,0,0]).concat([0]); let Q=null, res=null, it=0;
  for(;it<12;it++){
    const H=[],r=[];
    for(const s of obs){
      let rho=Math.hypot(s.x-x[0],s.y-x[1],s.z-x[2]); const a=GPS_OMEGA*rho/GPS_C, sx=s.x*Math.cos(a)+s.y*Math.sin(a), sy=-s.x*Math.sin(a)+s.y*Math.cos(a);
      rho=Math.hypot(sx-x[0],sy-x[1],s.z-x[2]); H.push([-(sx-x[0])/rho,-(sy-x[1])/rho,-(s.z-x[2])/rho,1]); r.push(s.pr-(rho+x[3]));
    }
    const N=[[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]], b=[0,0,0,0];
    for(let k=0;k<H.length;k++) for(let i=0;i<4;i++){ b[i]+=H[k][i]*r[k]; for(let j=0;j<4;j++) N[i][j]+=H[k][i]*H[k][j]; }
    Q=_gpsInv(N,4); if(!Q) return {ok:false,err:'degenerate geometry'};
    let step=0; for(let i=0;i<4;i++){ let d=0; for(let j=0;j<4;j++) d+=Q[i][j]*b[j]; x[i]+=d; if(i<3) step=Math.max(step,Math.abs(d)); }
    res=r; if(step<1e-4){ it++; break; }
  }
  let ss=0; for(const v of res) ss+=v*v; const g=gpsEcef2Geo(x[0],x[1],x[2]);
  return {ok:true,x:x[0],y:x[1],z:x[2],cb:x[3],rms:Math.sqrt(ss/res.length),pdop:Math.sqrt(Q[0][0]+Q[1][1]+Q[2][2]),lat:g.lat,lon:g.lon,h:g.h,iters:it,n:obs.length};
}
// выдуманное созвездие 24 слотов (6 плоскостей × 4), для пресетов и тестов: эфемерида слота 0…23 (поля как у gpsQuantize)
function gpsDemoEph(slot,toe){
  const pl=slot%6, ix=(slot/6)|0, A=26559710;
  return gpsQuantize({weekNum:2400%1024,satAcc:0,satHealth:0,IODC:37,Tgd:5e-9,Toc:toe,af0:2e-5*((slot%5)-2)/2,af1:1e-12*(slot%3),af2:0,
    IODE2:37,Crs:15.5+slot,deltaN:4.3e-9,M0:((ix*90+pl*20)%360)*Math.PI/180,Cuc:1.1e-6,e:0.004+0.0005*(slot%4),Cus:5.2e-6,sqrtA:Math.sqrt(A),Toe:toe,
    Cic:-3e-8,omegaBig:((pl*60+35)%360-180)*Math.PI/180,Cis:6e-8,i0:55*Math.PI/180,Crc:230-slot*2,omegaSmall:0,omegaDot:-8.0e-9,IDOT:-2e-10,IODE3:37});
}

// ---------- поиск спутника ----------
// iq {re,im} ≥ ms мс. → {prn, ratio, dopp (Гц), lag (отсчётов), p0 (фаза кода в отсчёте 0, чипы), found}
function gpsAcquire(iq,fs,prn,o={}){
  const N=Math.round(fs/1000), K=o.ms||10, step=o.step||250, maxd=o.maxd||5000, thr=o.thr||5;
  if(N&(N-1)) throw new Error('fs/1000 должно быть степенью двойки (2.048 МГц)');
  if(iq.re.length<N*K) throw new Error('нужно '+K+' мс отсчётов');
  const ca=gpsCA(prn), cr=new Float64Array(N), ci=new Float64Array(N); for(let j=0;j<N;j++) cr[j]=ca[Math.floor(j*1023/N)];
  gpsFFT(cr,ci,false); for(let j=0;j<N;j++) ci[j]=-ci[j];
  const re=new Float64Array(N), im=new Float64Array(N);
  const run=(f,acc,z)=>{
    const dp=-2*Math.PI*f/fs, cd=Math.cos(dp), sd=Math.sin(dp);
    for(let m=0;m<K;m++){
      let a=dp*m*N, c=Math.cos(a), s=Math.sin(a); const o0=m*N;
      for(let j=0;j<N;j++){ const x=iq.re[o0+j], y=iq.im[o0+j]; re[j]=x*c-y*s; im[j]=x*s+y*c; const t=c*cd-s*sd; s=c*sd+s*cd; c=t; }
      gpsFFT(re,im,false); for(let j=0;j<N;j++){ const a2=re[j]*cr[j]-im[j]*ci[j], b2=re[j]*ci[j]+im[j]*cr[j]; re[j]=a2; im[j]=b2; }
      gpsFFT(re,im,true);
      if(acc) for(let j=0;j<N;j++) acc[j]+=re[j]*re[j]+im[j]*im[j];
      if(z){ z.re[m]=re[z.lag]; z.im[m]=im[z.lag]; }
    }
  };
  let best={v:-1,f:0,lag:0}; const acc=new Float64Array(N);
  for(let f=-maxd;f<=maxd;f+=step){ acc.fill(0); run(f,acc,null); for(let j=0;j<N;j++) if(acc[j]>best.v) best={v:acc[j],f,lag:j}; }
  // отношение пика к среднему вне ±3 отсчётов в лучшей частотной ячейке
  acc.fill(0); run(best.f,acc,null); let sum=0,cnt=0; for(let j=0;j<N;j++){ const d=Math.min((j-best.lag+N)%N,(best.lag-j+N)%N); if(d>3){ sum+=acc[j]; cnt++; } }
  const ratio=acc[best.lag]/(sum/cnt);
  const z={re:new Float64Array(K),im:new Float64Array(K),lag:best.lag}; run(best.f,null,z);
  let sr=0,si=0; for(let m=0;m+1<K;m++){ sr+=z.re[m+1]*z.re[m]+z.im[m+1]*z.im[m]; si+=z.im[m+1]*z.re[m]-z.re[m+1]*z.im[m]; }
  const dopp=best.f+Math.atan2(si,sr)/(2*Math.PI*0.001);
  return {prn,ratio,dopp,lag:best.lag,p0:(1023-best.lag*1023/N)%1023,found:ratio>=thr};
}

// ---------- слежение: DLL (E/P/L через 1/2 чипа) + ЧАПЧ → Костас-ФАПЧ, интегрирование ровно по периоду кода ----------
function gpsTrackNew(prn,fs,acq,o={}){
  const ca=gpsCA(prn), cx=new Int8Array(1025); for(let i=-1;i<=1023;i++) cx[i+1]=ca[((i%1023)+1023)%1023];
  const ch={prn,fs,cx,p:acq.p0,n:0,started:false,ne:0,w:2*Math.PI*acq.dopp,wInt:2*Math.PI*acq.dopp,th:{r:1,i:0},acc:new Float64Array(6),
    S:[],I:[],Q:[],pI0:0,pQ0:0,lock:0,fllN:o.fllN||300,bl:o.bl||15,dllG:0.02,dllG0:0.1,x:0,
    carrierHz(){ return this.w/(2*Math.PI); }};
  ch.step=(GPS_FCODE*(1+acq.dopp/GPS_FL1))/fs; ch.cd=Math.cos(ch.w/fs); ch.sd=Math.sin(ch.w/fs);
  return ch;
}
// iq {re,im} — следующая порция потока (любой длины)
function gpsTrackPush(ch,iq){
  const L=iq.re.length, fs=ch.fs, cx=ch.cx, a=ch.acc, base=ch.n; let p=ch.p, cr=ch.th.r, ci=ch.th.i, cd=ch.cd, sd=ch.sd, step=ch.step;
  let eI=a[0],eQ=a[1],pI=a[2],pQ=a[3],lI=a[4],lQ=a[5];
  for(let j=0;j<L;j++){
    const i=iq.re[j], q=iq.im[j], wi=i*cr+q*ci, wq=q*cr-i*ci;
    const t=cr*cd-ci*sd; ci=cr*sd+ci*cd; cr=t;
    const k=(p+0.5)|0, ce=cx[k+1], cl=cx[k], cp=cx[(p|0)+1];
    eI+=ce*wi; eQ+=ce*wq; pI+=cp*wi; pQ+=cp*wq; lI+=cl*wi; lQ+=cl*wq;
    p+=step;
    if(p>=1023){
      p-=1023;
      if(!ch.started){ ch.started=true; }
      else{
        // —— конец периода кода ——
        ch.S.push(base+j+1-p/step); ch.I.push(pI); ch.Q.push(pQ); const n=ch.ne++;
        const mE=Math.hypot(eI,eQ), mL=Math.hypot(lI,lQ), x=mE+mL>0?0.5*(mE-mL)/(mE+mL):0; ch.x=x;
        let wNew;
        if(n<ch.fllN){ // ЧАПЧ: атан(кросс/скал) устойчив к смене бита
          if(n>0){ const dot=pI*ch.pI0+pQ*ch.pQ0, cr2=ch.pI0*pQ-ch.pQ0*pI; let e=Math.atan2(cr2,dot); if(e>Math.PI/2) e-=Math.PI; else if(e<-Math.PI/2) e+=Math.PI; ch.wInt+=0.2*e/0.001; }
          wNew=ch.wInt;
        }else{
          let e=Math.atan2(pQ,pI); if(e>Math.PI/2) e-=Math.PI; else if(e<-Math.PI/2) e+=Math.PI;
          const wn=8*0.707*ch.bl/(4*0.5+1); ch.wInt+=wn*wn*0.001*e; wNew=ch.wInt+2*0.707*wn*e;
        }
        const pw=pI*pI+pQ*pQ; ch.lock+=0.02*(pw>0?(pI*pI-pQ*pQ)/pw-ch.lock:0);
        ch.pI0=pI; ch.pQ0=pQ; ch.w=wNew; cd=Math.cos(wNew/fs); sd=Math.sin(wNew/fs);
        const g=n<500?ch.dllG0:ch.dllG; // код: ведомый несущей + первый порядок по ошибке
        step=(GPS_FCODE*(1+wNew/(2*Math.PI*GPS_FL1)))/fs+g*x/(fs/1000);
        const m=1/Math.hypot(cr,ci); cr*=m; ci*=m;
      }
      eI=eQ=pI=pQ=lI=lQ=0;
    }
  }
  a[0]=eI;a[1]=eQ;a[2]=pI;a[3]=pQ;a[4]=lI;a[5]=lQ; ch.p=p; ch.th.r=cr; ch.th.i=ci; ch.cd=cd; ch.sd=sd; ch.step=step; ch.n=base+L;
  return ch;
}
// ---------- биты, кадры, эфемериды ----------
// границы бит по смене знака prompt-I: фаза k0 (эпоха k0+20·m — начало бита)
function gpsBitSync(ch){
  const h=new Int32Array(20); let tot=0; for(let k=1;k<ch.I.length;k++) if((ch.I[k]>0)!==(ch.I[k-1]>0)){ h[k%20]++; tot++; }
  let b=0; for(let i=1;i<20;i++) if(h[i]>h[b]) b=i; let second=0; for(let i=0;i<20;i++) if(i!==b&&h[i]>second) second=h[i];
  return {ok:tot>=10&&h[b]>=3*Math.max(1,second),k0:b,hist:h};
}
function gpsChannelNav(ch){
  const bs=gpsBitSync(ch); if(!bs.ok) return {ok:false,err:'bit sync',lock:ch.lock};
  const nb=Math.floor((ch.I.length-bs.k0)/20), bits=new Uint8Array(nb);
  for(let b=0;b<nb;b++){ let s=0; for(let k=0;k<20;k++) s+=ch.I[bs.k0+b*20+k]; bits[b]=s<0?1:0; }
  const frames=gpsFindFrames(bits), store={};
  for(const f of frames) gpsEphAdd(store,f.sf);
  const nav={ok:frames.length>0,bits,frames,k0:bs.k0,eph:store.ready?store.eph:null};
  if(frames.length){ const f=frames[0]; nav.ref={epoch:bs.k0+20*f.pos,tsv:(f.sf.tow-1)*6}; } // начало подкадра: ref.epoch — номер эпохи канала, tsv — время спутника
  return nav;
}
// псевдодальности на общий момент приёма. chs: [{S, fs, ref:{epoch,tsv}, eph, prn}] → [{prn,x,y,z,pr}]
function gpsPseudoranges(chs){
  if(!chs.length) return [];
  const Sref=Math.min(...chs.map(c=>c.S[c.S.length-1]))-2*chs[0].fs/1000, fs=chs[0].fs, t=[];
  for(const c of chs){ let lo=0,hi=c.S.length-1; while(lo<hi){ const m=(lo+hi+1)>>1; if(c.S[m]<=Sref) lo=m; else hi=m-1; }
    t.push(c.ref.tsv+(lo-c.ref.epoch)*0.001+(Sref-c.S[lo])/fs); }
  const tRef=t.reduce((a,b)=>a+b,0)/t.length+0.075;
  return chs.map((c,i)=>{ const dt0=gpsSatPos(c.eph,t[i]).dt, s=gpsSatPos(c.eph,t[i]-dt0); return {prn:c.prn,x:s.x,y:s.y,z:s.z,pr:GPS_C*(tRef-t[i])+GPS_C*dt0}; });
}

// ---------- синтетический эфир ----------
function _gpsRng(seed){ let a=seed>>>0; return ()=>{ a=(a+0x6D2B79F5)>>>0; let t=Math.imul(a^(a>>>15),1|a); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; }; }
// задержка распространения от спутника до приёмника rcv в момент приёма t (системное время)
function gpsDelay(eph,rcv,t){
  let tau=0.075, dt=0;
  for(let i=0;i<4;i++){ const s=gpsSatPos(eph,t-tau), a=GPS_OMEGA*tau, sx=s.x*Math.cos(a)+s.y*Math.sin(a), sy=-s.x*Math.sin(a)+s.y*Math.cos(a);
    tau=Math.hypot(sx-rcv[0],sy-rcv[1],s.z-rcv[2])/GPS_C; dt=s.dt; }
  return {tau,dt};
}
// один спутник в один блок: код × бит × несущая (рекуррентный фазор)
function _gpsSynthSat(re,im,N,ca,amp,x0,dx,th,dth,e0,sgn){
  let cr=Math.cos(th), ci=Math.sin(th); const cd=Math.cos(dth), sd=Math.sin(dth);
  for(let j=0;j<N;j++){
    const xi=x0+j*dx, ep=xi|0, a=amp*sgn[ep-e0]*ca[((xi-ep)*1023)|0];
    re[j]+=a*cr; im[j]+=a*ci; const t=cr*cd-ci*sd; ci=cr*sd+ci*cd; cr=t;
  }
}
let _gpsNz=null; // таблица гауссова шума (один раз): блок берёт окно с псевдослучайным сдвигом
function _gpsNoise(){ if(_gpsNz) return _gpsNz; const n=1<<19, re=new Float32Array(n), im=new Float32Array(n), r=_gpsRng(12345);
  for(let j=0;j<n;j++){ const u=Math.sqrt(-2*Math.log(r()+1e-300)), v=2*Math.PI*r(); re[j]=u*Math.cos(v); im[j]=u*Math.sin(v); } return _gpsNz={re,im,n}; }
// cfg {fs, tow0 (время приёма в отсчёте 0), rcv:[x,y,z], noise (σ на компоненту), seed, sats:[{prn, eph, amp, phi, cycle:[1,2,3]}]}
// → {N, block(k) → {re,im} (1 мс), expect(i) → {lag, dopp}}
function gpsSynth(cfg){
  const fs=cfg.fs, N=Math.round(fs/1000), sats=cfg.sats.map(s=>({prn:s.prn,eph:s.eph,amp:s.amp==null?1:s.amp,phi:s.phi||0,ca:gpsCA(s.prn),cycle:s.cycle||[1,2,3,4,5],sfN:-1,bits:null,k1:-1,d1:null}));
  const bitSign=(s,ep)=>{ const bi=Math.floor(ep/20), n=Math.floor(bi/300);
    if(n!==s.sfN){ const id=s.cycle[((n%s.cycle.length)+s.cycle.length)%s.cycle.length], r=_gpsRng(s.prn*7919+n), fill=new Uint8Array(192); for(let i=0;i<192;i++) fill[i]=r()<0.5?1:0;
      s.bits=gpsBuildSubframe(Object.assign({},s.eph,{id,tow:n+1,fill})); s.sfN=n; }
    return s.bits[bi-n*300]?-1:1; };
  const geom=(s,k)=>{ const t0=cfg.tow0+k*1e-3; const d0=(s.k1===k)?s.d1:gpsDelay(s.eph,cfg.rcv,t0), d1=gpsDelay(s.eph,cfg.rcv,t0+1e-3); s.k1=k+1; s.d1=d1; return [d0,d1,t0]; };
  return {N,fs,
    block(k){
      const re=new Float32Array(N), im=new Float32Array(N), sg=cfg.noise||0;
      if(sg>0){ const T=_gpsNoise(), o=Math.floor(_gpsRng((cfg.seed||1)*2654435761+k)()*(T.n-N)); for(let j=0;j<N;j++){ re[j]=sg*T.re[o+j]; im[j]=sg*T.im[o+j]; } }
      for(const s of sats){
        const g=geom(s,k), d0=g[0], d1=g[1], x0=(g[2]-d0.tau+d0.dt)*1000, dx=(1-(d1.tau-d0.tau)/1e-3)*1000/fs;
        const f0=GPS_FL1*d0.tau, th=-2*Math.PI*(f0-Math.floor(f0))+s.phi, dth=-2*Math.PI*GPS_FL1*(d1.tau-d0.tau)/N;
        const e0=Math.floor(x0), e1=Math.floor(x0+(N-1)*dx), sgn=new Int8Array(e1-e0+1); for(let e=e0;e<=e1;e++) sgn[e-e0]=bitSign(s,e);
        _gpsSynthSat(re,im,N,s.ca,s.amp,x0,dx,th,dth,e0,sgn);
      }
      return {re,im};
    },
    // «правда» в блоке 0: отсчёт начала эпохи кода и допплер, Гц
    expect(i){ const s=sats[i], d0=gpsDelay(s.eph,cfg.rcv,cfg.tow0), d1=gpsDelay(s.eph,cfg.rcv,cfg.tow0+1e-3), x0=(cfg.tow0-d0.tau+d0.dt)*1000, dx=(1-(d1.tau-d0.tau)/1e-3)*1000/fs;
      return {lag:(Math.ceil(x0)-x0)/dx,dopp:-GPS_FL1*(d1.tau-d0.tau)/1e-3,tau:d0.tau}; }
  };
}
