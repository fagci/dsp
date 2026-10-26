"use strict";
/* ======================= ИНСТРУМЕНТЫ 2 — ядро ======================= */
// Дальномер, угломер, шумомер (A-взвешивание), экспонометр, солнце и луна, случайные числа и пароли, охрана — без DOM: node tools/test-tools2.mjs.

const T2_D=Math.PI/180;

/* ---- дальномер и угломер ---- */
// до точки на земле по углу вниз el (<0) с высоты eye
const tsRangeGround=(el,eye)=>el<-.1 && eye>0 ? eye/Math.tan(-el*T2_D) : null;
// до предмета известной высоты H по углам на верх и низ
function tsRangeSize(top,base,H){
  const k=Math.tan(top*T2_D)-Math.tan(base*T2_D);
  return k>1e-6 && H>0 ? H/k : null;
}
// угол между двумя направлениями (азимут, высота); dAz — кратчайшая разность азимутов, −180…180
function tsAngle3(az1,el1,az2,el2){
  const v=(a,e)=>[Math.cos(e*T2_D)*Math.sin(a*T2_D),Math.cos(e*T2_D)*Math.cos(a*T2_D),Math.sin(e*T2_D)];
  const a=v(az1,el1), b=v(az2,el2), d=Math.max(-1,Math.min(1,a[0]*b[0]+a[1]*b[1]+a[2]*b[2]));
  return {angle:Math.acos(d)/T2_D, dAz:((az2-az1+540)%360+360)%360-180, dEl:el2-el1};
}

/* ---- шумомер ---- */
// A-взвешивание: аналоговый фильтр → билинейное преобразование → три биквада, усиление 0 дБ на 1 кГц
function tsBiquad(b,a,sr){                          // b, a — коэффициенты при s², s, 1 (аналог)
  const K=2*sr, a0=a[0]*K*K+a[1]*K+a[2];
  return {b0:(b[0]*K*K+b[1]*K+b[2])/a0, b1:2*(b[2]-b[0]*K*K)/a0, b2:(b[0]*K*K-b[1]*K+b[2])/a0,
          a1:2*(a[2]-a[0]*K*K)/a0, a2:(a[0]*K*K-a[1]*K+a[2])/a0};
}
function tsResp(S,f,sr){                            // |H| каскада на частоте f
  const w=2*Math.PI*f/sr, c1=Math.cos(w), s1=Math.sin(w), c2=Math.cos(2*w), s2=Math.sin(2*w);
  let m=1;
  for(const q of S){
    const nr=q.b0+q.b1*c1+q.b2*c2, ni=-(q.b1*s1+q.b2*s2), dr=1+q.a1*c1+q.a2*c2, di=-(q.a1*s1+q.a2*s2);
    m*=Math.hypot(nr,ni)/Math.hypot(dr,di);
  }
  return m;
}
function tsAWeight(sr){
  const w=f=>2*Math.PI*f, w1=w(20.598997), w2=w(107.65265), w3=w(737.86223), w4=w(12194.217);
  const S=[tsBiquad([1,0,0],[1,2*w1,w1*w1],sr),
           tsBiquad([0,1,0],[1,w2+w3,w2*w3],sr),
           tsBiquad([0,1,0],[1,2*w4,w4*w4],sr)];
  const g=1/tsResp(S,1000,sr); S[0].b0*=g; S[0].b1*=g; S[0].b2*=g;
  return S;
}
// weight 'A' | 'Z'; tau — постоянная времени (0.125 fast, 1 slow)
function tsMeterNew(sr,weight,tau){
  return {sr, tau, S:weight==='A' ? tsAWeight(sr) : null, z:weight==='A' ? [[0,0],[0,0],[0,0]] : null,
          ms:0, init:false, peak:0, sum:0, cnt:0, max:-Infinity, min:Infinity};
}
// блок отсчётов (±1 = полная шкала); возвращает dBFS с временным взвешиванием
function tsMeterPush(M,buf){
  const k=1-Math.exp(-1/(M.tau*M.sr)); let ms=M.ms, pk=0, e=0;
  for(let i=0;i<buf.length;i++){
    let x=buf[i];
    if(M.S) for(let j=0;j<3;j++){ const q=M.S[j], z=M.z[j], y=q.b0*x+z[0]; z[0]=q.b1*x-q.a1*y+z[1]; z[1]=q.b2*x-q.a2*y; x=y; }
    const p=x*x; e+=p; if(p>pk) pk=p;
    ms+=(p-ms)*k;
  }
  M.ms=ms; M.peak=Math.max(M.peak,Math.sqrt(pk)); M.sum+=e; M.cnt+=buf.length;
  const db=tsDb(ms); if(M.init){ if(db>M.max) M.max=db; if(db<M.min) M.min=db; } else if(M.cnt>M.sr*M.tau*3) M.init=true;   // первые секунды — разгон фильтра
  return db;
}
const tsDb=ms=>ms>1e-20 ? 10*Math.log10(ms) : -200;
const tsLeq=M=>M.cnt ? tsDb(M.sum/M.cnt) : -200;
function tsMeterReset(M){ M.sum=0; M.cnt=0; M.peak=0; M.max=-Infinity; M.min=Infinity; }

/* ---- экспонометр ---- */
const tsEv=lux=>lux>0 ? Math.log2(lux/2.5) : null;                     // EV при ISO 100, C = 250
const tsShutter=(ev,N,iso)=>N*N/(Math.pow(2,ev)*iso/100);
const tsAperture=(ev,t,iso)=>Math.sqrt(t*Math.pow(2,ev)*iso/100);
function tsFmtShutter(t){
  if(!(t>0)) return '—';
  if(t>=.95) return (t>=10 ? t.toFixed(0) : t.toFixed(1))+' s';
  return '1/'+Math.round(1/t);
}

/* ---- солнце и луна (NOAA, точность ~1 минута / 0.5°; без рефракции) ---- */
const tsJd=ms=>ms/86400000+2440587.5;
function tsSunPos(jd){
  const T=(jd-2451545)/36525;
  const L0=((280.46646+T*(36000.76983+T*.0003032))%360+360)%360, M=357.52911+T*(35999.05029-.0001537*T), e=.016708634-T*(.000042037+1.267e-7*T);
  const Mr=M*T2_D, C=Math.sin(Mr)*(1.914602-T*(.004817+.000014*T))+Math.sin(2*Mr)*(.019993-.000101*T)+Math.sin(3*Mr)*.000289;
  const om=125.04-1934.136*T, lam=L0+C-.00569-.00478*Math.sin(om*T2_D);
  const eps=23+(26+(21.448-T*(46.815+T*(.00059-T*.001813)))/60)/60+.00256*Math.cos(om*T2_D);
  const dec=Math.asin(Math.sin(eps*T2_D)*Math.sin(lam*T2_D))/T2_D;
  const y=Math.pow(Math.tan(eps*T2_D/2),2), L0r=L0*T2_D;
  const eq=4*(y*Math.sin(2*L0r)-2*e*Math.sin(Mr)+4*e*y*Math.sin(Mr)*Math.cos(2*L0r)-.5*y*y*Math.sin(4*L0r)-1.25*e*e*Math.sin(2*Mr))/T2_D;
  return {dec, eq};                                                       // eq — уравнение времени, минуты
}
// ms — момент (мс Unix), lat / lon в градусах (восток +). rise / set — мс или null (полярный день / ночь: polar 'day' | 'night')
function tsSun(ms,lat,lon){
  const p=tsSunPos(tsJd(ms));
  const utcMin=((ms/60000)%1440+1440)%1440, tst=((utcMin+p.eq+4*lon)%1440+1440)%1440, ha=tst/4-180;
  const la=lat*T2_D, de=p.dec*T2_D, h=ha*T2_D;
  const sinEl=Math.sin(la)*Math.sin(de)+Math.cos(la)*Math.cos(de)*Math.cos(h);
  const el=Math.asin(Math.max(-1,Math.min(1,sinEl)))/T2_D;
  const az=((Math.atan2(Math.sin(h),Math.cos(h)*Math.sin(la)-Math.tan(de)*Math.cos(la))/T2_D+180)%360+360)%360;
  // события на «местные средние сутки» точки
  const day=Math.floor((ms+lon*240000)/86400000), base=day*86400000-lon*240000;
  const q=tsSunPos(tsJd(base+43200000)), cosH=(Math.cos(90.833*T2_D)-Math.sin(la)*Math.sin(q.dec*T2_D))/(Math.cos(la)*Math.cos(q.dec*T2_D));
  let rise=null, set=null, polar='';
  const noon=base+(720-q.eq)*60000;
  if(cosH>1) polar='night'; else if(cosH<-1) polar='day';
  else { const H=Math.acos(cosH)/T2_D; rise=noon-H*240000; set=noon+H*240000; }
  return {el, az, dec:p.dec, noon, rise, set, polar, dayLen:rise!==null ? (set-rise)/3600000 : (polar==='day' ? 24 : 0)};
}
const TS_SYN=29.530588853;
function tsMoon(ms){
  const jd=tsJd(ms), age=(((jd-2451550.1)/TS_SYN)%1+1)%1;
  const names=['new moon','waxing crescent','first quarter','waxing gibbous','full moon','waning gibbous','last quarter','waning crescent'];
  const ph=Math.floor(age*8+.5)%8, ill=(1-Math.cos(2*Math.PI*age))/2;
  return {age:age*TS_SYN, phase:age, illum:ill*100, name:names[ph], toFull:((.5-age+1)%1)*TS_SYN, toNew:((1-age)%1)*TS_SYN};
}

/* ---- случайное: rng() → целое 0…2³²−1 ---- */
function tsRandInt(rng,n){                          // 0…n−1 без смещения
  if(!(n>=1)) return 0;
  const lim=Math.floor(4294967296/n)*n; let r;
  do r=rng(); while(r>=lim);
  return r%n;
}
// «2d6+3», «d20», «4d6-1»
function tsRoll(rng,expr){
  const m=/^\s*(\d*)\s*d\s*(\d+)\s*([+-]\s*\d+)?\s*$/i.exec(String(expr)); if(!m) return null;
  const c=m[1]==='' ? 1 : +m[1], s=+m[2], mod=m[3] ? +m[3].replace(/\s/g,'') : 0;
  if(c<1 || c>100 || s<2 || s>1000) return null;
  const rolls=[]; for(let i=0;i<c;i++) rolls.push(1+tsRandInt(rng,s));
  return {rolls, mod, total:rolls.reduce((a,b)=>a+b,0)+mod};
}
const TS_SETS={lower:'abcdefghijkmnopqrstuvwxyz',upper:'ABCDEFGHJKLMNPQRSTUVWXYZ',digits:'23456789',symbols:'!@#$%^&*-_=+?'};   // без похожих знаков: l 1 I O 0
function tsPassword(rng,len,sets){
  const pools=sets.filter(k=>TS_SETS[k]).map(k=>TS_SETS[k]); len=Math.max(4,Math.min(128,Math.round(len)||0));
  if(!pools.length) return '';
  const all=pools.join(''), out=[];
  for(const p of pools) out.push(p[tsRandInt(rng,p.length)]);               // по знаку из каждого набора
  while(out.length<len) out.push(all[tsRandInt(rng,all.length)]);
  for(let i=out.length-1;i>0;i--){ const j=tsRandInt(rng,i+1); [out[i],out[j]]=[out[j],out[i]]; }
  return out.join('');
}
function tsPick(rng,list){
  const a=String(list).split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  return a.length ? a[tsRandInt(rng,a.length)] : '';
}

/* ---- охрана: вектор ускорения сравнивается с эталоном, снятым при постановке ---- */
function tsGuardNew(){ return {state:'off', t0:0, ref:null, sum:[0,0,0], n:0, over:0, last:0, delta:0}; }
// t — секунды. delay — задержка до постановки, sens — порог изменения (м/с²), hold — сколько держать превышение (с)
function tsGuardStep(G,t,v,o){
  if(G.state==='off') return G;
  const dt=Math.max(0,t-G.last); G.last=t;
  if(G.state==='arming'){
    if(t-G.t0>=o.delay-.5){ for(let i=0;i<3;i++) G.sum[i]+=v[i]; G.n++; }     // эталон — среднее за последние полсекунды
    if(t-G.t0>=o.delay && G.n){ G.ref=G.sum.map(x=>x/G.n); G.state='armed'; G.over=0; }
  } else if(G.state==='armed'){
    G.delta=Math.hypot(v[0]-G.ref[0],v[1]-G.ref[1],v[2]-G.ref[2]);
    G.over=G.delta>o.sens ? G.over+dt : 0;
    if(G.over>=o.hold) G.state='alarm';
  }
  return G;
}
function tsGuardArm(G,t){ G.state='arming'; G.t0=t; G.last=t; G.sum=[0,0,0]; G.n=0; G.ref=null; G.over=0; G.delta=0; }
const tsGuardOff=G=>{ G.state='off'; G.over=0; G.delta=0; };

/* ---- детектор металла: |B| против медленного эталона ---- */
function tsMagNew(){ return {base:null, b:0, delta:0, last:null}; }
function tsMagStep(M,t,b,tau){
  M.b=b;
  if(M.base===null) M.base=b;
  else if(M.last!==null){ const k=1-Math.exp(-Math.max(0,t-M.last)/tau); M.base+=(b-M.base)*k; }
  M.last=t; M.delta=b-M.base;
  return M;
}
