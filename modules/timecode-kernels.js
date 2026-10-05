"use strict";
/* ============================ Сигналы точного времени: DCF77 (77.5 кГц) и WWVB (60 кГц) ============================
   Ядро IQK (страница и воркер), без DOM. Несущая с амплитудной манипуляцией: в начале каждой секунды мощность
   падает (DCF77 до ~15 %, WWVB на 17 дБ) на время, которое и несёт бит; всё остальное — несущая без модуляции.
   DCF77: 100 мс — 0, 200 мс — 1; 59-й секунды нет (пауза 2 с — начало минуты). Кадр 59 бит: служебные биты, 21–27 минуты,
   28 чётность, 29–34 часы, 35 чётность, 36–41 день, 42–44 день недели, 45–49 месяц, 50–57 год, 58 чётность даты;
   передаётся время СЛЕДУЮЩЕЙ минуты, местное (Z1 / Z2 — лето / зима).
   WWVB: 200 мс — 0, 500 мс — 1, 800 мс — маркер; кадр 60 бит, маркеры в секундах 0, 9, 19, 29, 39, 49, 59 (два подряд —
   конец и начало минуты); минуты 1–3 + 5–8, часы 12–13 + 15–18, день года 22–23 + 25–28 + 30–33, DUT1 36–38 + 40–43,
   год 45–48 + 50–53, 55 високосный, 56 секунда координации, 57–58 летнее время; время UTC, начала этой минуты.
   Тракт: смеситель на несущую → усреднение → ФНЧ (±70 Гц) → огибающая 400 Гц → слежение за верхним и нижним уровнем →
   пороги с гистерезисом → ширина провала → символ. Время — по счёту отсчётов потока, не по часам страницы
   (ускоренный прогон ×32 тоже работает). */

const TC_ST={DCF77:{hz:77500}, WWVB:{hz:60000}};
const TC_FE=400;                                    // частота огибающей, Гц

const tcBcd=(b,pos,w)=>{ let s=0; for(let i=0;i<pos.length;i++) if(b[pos[i]]==='1') s+=w[i]; return s; };
const tcEven=(b,from,to)=>{ let k=0; for(let i=from;i<=to;i++) if(b[i]==='1') k++; return (k&1)===0; };

// DCF77: 59 символов '0' / '1' → поля (местное время следующей минуты) или null
function dcfDecode(b){
  if(!b || b.length<59) return null;
  for(let i=0;i<59;i++) if(b[i]!=='0' && b[i]!=='1') return null;
  const err=[];
  if(b[0]!=='0') err.push('start bit');
  if(b[20]!=='1') err.push('S bit');
  if(!tcEven(b,21,28)) err.push('minute parity');
  if(!tcEven(b,29,35)) err.push('hour parity');
  if(!tcEven(b,36,58)) err.push('date parity');
  if(b[17]===b[18]) err.push('Z1 / Z2');
  const m=tcBcd(b,[21,22,23,24],[1,2,4,8]), mt=tcBcd(b,[25,26,27],[10,20,40]);
  const h=tcBcd(b,[29,30,31,32],[1,2,4,8]), ht=tcBcd(b,[33,34],[10,20]);
  const d=tcBcd(b,[36,37,38,39],[1,2,4,8]), dt=tcBcd(b,[40,41],[10,20]);
  const mo=tcBcd(b,[45,46,47,48],[1,2,4,8]), mot=tcBcd(b,[49],[10]);
  const y=tcBcd(b,[50,51,52,53],[1,2,4,8]), yt=tcBcd(b,[54,55,56,57],[10,20,40,80]);
  if(m>9 || h>9 || d>9 || mo>9 || y>9) err.push('digit');
  const r={min:mt+m, hour:ht+h, day:dt+d, weekday:tcBcd(b,[42,43,44],[1,2,4]), month:mot+mo, year:2000+yt+y,
    dst:b[17]==='1', annDst:b[16]==='1', annLeap:b[19]==='1', err};
  if(r.min>59 || r.hour>23 || r.day<1 || r.day>31 || r.month<1 || r.month>12 || r.weekday<1 || r.weekday>7) err.push('range');
  r.ok=!err.length;
  return r;
}
// WWVB: 60 символов '0' / '1' / 'M' → поля (UTC, начало минуты кадра) или null
const TC_WWVB_MARK=[0,9,19,29,39,49,59], TC_WWVB_BLANK=[4,10,11,14,20,21,24,34,35,44,54];
function wwvbDecode(b){
  if(!b || b.length<60) return null;
  const err=[];
  for(let i=0;i<60;i++){
    const mk=TC_WWVB_MARK.includes(i);
    if(mk && b[i]!=='M') err.push('marker '+i);
    if(!mk && (b[i]!=='0' && b[i]!=='1')) err.push('bit '+i);
  }
  for(const i of TC_WWVB_BLANK) if(b[i]==='1') err.push('blank '+i);
  const dig=(pos,w)=>tcBcd(b,pos,w);
  const mt=dig([1,2,3],[40,20,10]), mu=dig([5,6,7,8],[8,4,2,1]);
  const ht=dig([12,13],[20,10]), hu=dig([15,16,17,18],[8,4,2,1]);
  const d1=dig([22,23],[200,100]), d2=dig([25,26,27,28],[80,40,20,10]), d3=dig([30,31,32,33],[8,4,2,1]);
  const yt=dig([45,46,47,48],[80,40,20,10]), yu=dig([50,51,52,53],[8,4,2,1]);
  if(mu>9 || hu>9 || (d2/10)>9 || d3>9 || yu>9 || (yt/10)>9) err.push('digit');
  const sign=b[37]==='1' ? -1 : 1, ut1=sign*dig([40,41,42,43],[.8,.4,.2,.1]);
  const r={min:mt+mu, hour:ht+hu, doy:d1+d2+d3, year:2000+yt+yu, ut1:+ut1.toFixed(1), leapYear:b[55]==='1', leapSec:b[56]==='1',
    dstBits:(b[57]||'0')+(b[58]||'0'), dst:b[58]==='1', err};
  if(r.min>59 || r.hour>23 || r.doy<1 || r.doy>366) err.push('range');
  r.ok=!err.length;
  return r;
}
function tcDoyDate(year,doy){ const d=new Date(Date.UTC(year,0,doy)); return {month:d.getUTCMonth()+1, day:d.getUTCDate()}; }
const tcIso=ms=>new Date(ms).toISOString().replace(/\.\d+Z$/,'Z');

/* ---- кодеры (для генератора и проверки) ---- */
function tcBcdPut(b,pos,w,v){                       // v раскладывается по весам, большие вперёд
  const ord=pos.map((p,i)=>i).sort((x,y)=>w[y]-w[x]);
  for(const i of ord){ if(v>=w[i]-1e-9){ b[pos[i]]='1'; v-=w[i]; } else b[pos[i]]='0'; }
}
function tcBerlin(ms){                              // местное время Германии на момент ms: поля и смещение, ч
  const f=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric'});
  const o={}; for(const p of f.formatToParts(new Date(ms))) o[p.type]=+p.value;
  const off=Math.round((Date.UTC(o.year,o.month-1,o.day,o.hour,o.minute)-Math.floor(ms/60000)*60000)/3600000);
  let wd=new Date(Date.UTC(o.year,o.month-1,o.day)).getUTCDay(); if(wd===0) wd=7;
  return {y:o.year, mo:o.month, d:o.day, h:o.hour, mi:o.minute, wd, off};
}
// utcMs — начало минуты, чьё время кодируется
function dcfEncode(utcMs){
  const t=tcBerlin(utcMs), b=new Array(59).fill('0');
  b[20]='1'; b[17]=t.off===2 ? '1' : '0'; b[18]=t.off===2 ? '0' : '1';
  tcBcdPut(b,[21,22,23,24,25,26,27],[1,2,4,8,10,20,40],t.mi); b[28]=tcEven(b,21,27) ? '0' : '1';
  tcBcdPut(b,[29,30,31,32,33,34],[1,2,4,8,10,20],t.h); b[35]=tcEven(b,29,34) ? '0' : '1';
  tcBcdPut(b,[36,37,38,39,40,41],[1,2,4,8,10,20],t.d);
  tcBcdPut(b,[42,43,44],[1,2,4],t.wd);
  tcBcdPut(b,[45,46,47,48,49],[1,2,4,8,10],t.mo);
  tcBcdPut(b,[50,51,52,53,54,55,56,57],[1,2,4,8,10,20,40,80],t.y%100);
  b[58]=tcEven(b,36,57) ? '0' : '1';
  return b;
}
function wwvbEncode(utcMs){
  const d=new Date(utcMs), y=d.getUTCFullYear(), doy=Math.floor((Date.UTC(y,d.getUTCMonth(),d.getUTCDate())-Date.UTC(y,0,1))/86400000)+1;
  const b=new Array(60).fill('0');
  for(const i of TC_WWVB_MARK) b[i]='M';
  const bcd=(pos,w,v)=>{ tcBcdPut(b,pos,w,v); };
  bcd([1,2,3],[40,20,10],Math.floor(d.getUTCMinutes()/10)*10); bcd([5,6,7,8],[8,4,2,1],d.getUTCMinutes()%10);
  bcd([12,13],[20,10],Math.floor(d.getUTCHours()/10)*10); bcd([15,16,17,18],[8,4,2,1],d.getUTCHours()%10);
  bcd([22,23],[200,100],Math.floor(doy/100)*100); bcd([25,26,27,28],[80,40,20,10],Math.floor(doy%100/10)*10); bcd([30,31,32,33],[8,4,2,1],doy%10);
  b[36]='1'; b[37]='0'; b[38]='1';                  // DUT1 +0.0
  bcd([45,46,47,48],[80,40,20,10],Math.floor(y%100/10)*10); bcd([50,51,52,53],[8,4,2,1],y%10);
  b[55]=(y%4===0 && (y%100!==0 || y%400===0)) ? '1' : '0';
  return b;
}

IQK.timeRx={
  init(n){ n.key=''; n.frames=0; n.good=0; n.bad=0; n.recent=[]; n.last=null; n.lastGood=null; n.confirmed=false; },
  setup(n,s,cplx,off){
    n.sr=s.sr; n.off=off; n.pm=0;
    n.M1=Math.max(1,Math.floor(s.sr/8000)); n.fs1=s.sr/n.M1;
    n.acR=0; n.acI=0; n.cnt=0;
    n.lp=kaiserLP(n.fs1,70,Math.min(300,.45*n.fs1),511);
    n.lr=new Float32Array(n.lp.length-1); n.li=new Float32Array(n.lp.length-1);
    n.Mf=Math.max(1,Math.round(n.fs1/TC_FE)); n.fe=n.fs1/n.Mf; n.fk=0;
    n.k=0; n.H=0; n.L=0; n.hi=true; n.fallK=null; n.lastFallK=null; n.pendFall=null;
    n.sec=-1; n.bits=new Array(60).fill(null); n.prevSym=null; n.lvl=0; n.depth=0; n.sym=-1; n.minute=null;
  },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {rec:null}; }
    const st=TC_ST[n.p.station]||TC_ST.DCF77, mode=n.p.carrier;
    const cplx=s.chunks.length ? !!s.chunks[0].im : n.cplx;
    const off=mode==='envelope (AM audio)' ? 0 : mode==='audio tone' ? +n.p.tone : st.hz-s.fc;
    const key=s.sr+'|'+cplx+'|'+off+'|'+n.p.station+'|'+mode;
    if(key!==n.key){ n.key=key; n.cplx=cplx; this.setup(n,s,cplx,off); }
    if(Math.abs(off)>=s.sr/2){ n.ui={err:'carrier '+(off/1000).toFixed(1)+' kHz is outside the stream ('+(s.sr/1000).toFixed(0)+' kS/s): set the stream centre or the tone'}; return {rec:null}; }
    const recs=[], w=2*Math.PI*off/s.sr, env=mode==='envelope (AM audio)';
    for(const c of s.chunks){
      const re=c.re, im=env ? null : c.im, K=re.length;
      const zr=new Float32Array(Math.ceil(K/n.M1)+2), zi=new Float32Array(zr.length);
      let o=0, pm=n.pm, ar=n.acR, ai=n.acI, cnt=n.cnt;
      for(let i=0;i<K;i++){
        let xr=re[i], xi=im ? im[i] : 0;
        if(env){ xr=Math.abs(xr); xi=0; }
        else { const cr=Math.cos(pm), ci=-Math.sin(pm); pm+=w; const a=xr*cr-xi*ci, b=xr*ci+xi*cr; xr=a; xi=b; }
        ar+=xr; ai+=xi;
        if(++cnt===n.M1){ zr[o]=ar/n.M1; zi[o]=ai/n.M1; o++; ar=ai=0; cnt=0; }
      }
      n.pm=pm%(2*Math.PI); n.acR=ar; n.acI=ai; n.cnt=cnt;
      if(!o) continue;
      const yr=firRun(n.lp,n.lr,zr.subarray(0,o)), yi=firRun(n.lp,n.li,zi.subarray(0,o));
      for(let i=0;i<o;i++){
        if(++n.fk<n.Mf) continue;
        n.fk=0;
        this.env(n,Math.hypot(yr[i],yi[i]),recs);
      }
    }
    n.ui={fe:n.fe, M:n.M1, sec:n.sec, bits:n.bits.map(x=>x==null ? '.' : x).join(''), lvl:n.H, depth:n.depth, frames:n.frames, good:n.good, bad:n.bad,
      confirmed:n.confirmed, last:n.last, recent:n.recent.slice(-6), sync:n.sec>=0};
    const t=n.last;
    return {rec:recs.length ? recs : null, bit:n.sym, sec:n.sec>=0 ? n.sec : null, min:t ? t.min : null, hour:t ? t.hour : null,
      ok:n.confirmed ? 1 : 0, lvl:n.H, depth:n.depth};
  },
  // один отсчёт огибающей (TC_FE Гц)
  env(n,e,recs){
    n.k++;
    if(n.k===1){ n.H=e; n.L=e; }
    n.H=Math.max(e,n.H*Math.exp(-1/(n.fe*8)));
    if(e<n.L) n.L=e; else n.L+=(n.H-n.L)*(1-Math.exp(-1/(n.fe*20)));
    n.depth=n.H>1e-9 ? (n.H-n.L)/n.H : 0;
    if(n.depth<0.35) { n.hi=true; n.pendFall=null; return; }                 // нет различимых провалов
    const span=n.H-n.L, lo=n.L+.4*span, hi=n.L+.6*span;
    if(n.hi && e<lo){ n.hi=false; n.pendFall=n.k; }
    else if(!n.hi && e>hi){
      n.hi=true;
      if(n.pendFall!=null){
        const wMs=(n.k-n.pendFall)/n.fe*1000;
        if(wMs>=40){
          const gap=n.lastFallK!=null ? (n.pendFall-n.lastFallK)/n.fe : null;
          n.lastFallK=n.pendFall;
          this.pulse(n,wMs,gap,recs);
        }
      }
      n.pendFall=null;
    }
  },
  symbol(n,wMs){
    if(n.p.station==='DCF77') return wMs<150 ? '0' : wMs<260 ? '1' : null;
    return wMs<350 ? '0' : wMs<650 ? '1' : wMs<950 ? 'M' : null;
  },
  pulse(n,wMs,gap,recs){
    const sym=this.symbol(n,wMs), dcf=n.p.station==='DCF77';
    n.sym=sym==null ? -1 : sym==='M' ? 2 : +sym;
    if(sym==null || gap==null || gap<.5){ this.lost(n); n.prevSym=sym; return; }
    if(dcf){
      if(gap>1.6 && gap<2.4){                                              // 59-й секунды не было — начало минуты
        if(n.sec===58) this.frame(n,n.bits.slice(0,59),recs);
        n.sec=0; n.bits=new Array(60).fill(null); n.bits[0]=sym;
      } else if(gap>.9 && gap<1.1 && n.sec>=0){
        n.sec++;
        if(n.sec>58) this.lost(n); else n.bits[n.sec]=sym;
      } else this.lost(n);
    } else {
      if(gap<.9 || gap>1.1){ this.lost(n); n.prevSym=sym; return; }
      if(n.sec<0){ if(sym==='M' && n.prevSym==='M'){ n.sec=0; n.bits=new Array(60).fill(null); n.bits[0]='M'; } }
      else {
        n.sec++;
        if(n.sec>=60){
          if(sym==='M'){ this.frame(n,n.bits.slice(0,60),recs); n.sec=0; n.bits=new Array(60).fill(null); n.bits[0]='M'; }
          else this.lost(n);
        } else n.bits[n.sec]=sym;
      }
    }
    n.prevSym=sym;
  },
  lost(n){ n.sec=-1; n.bits=new Array(60).fill(null); n.confirmed=false; },
  // кадр собран: поля → время начавшейся минуты (UTC)
  frame(n,b,recs){
    n.frames++;
    const dcf=n.p.station==='DCF77', r=dcf ? dcfDecode(b) : wwvbDecode(b);
    if(!r || !r.ok){ n.bad++; n.confirmed=false; n.recent.push('frame rejected: '+(r ? r.err.slice(0,3).join(', ') : 'incomplete')); if(n.recent.length>20) n.recent.shift(); return; }
    let utc;
    if(dcf) utc=Date.UTC(r.year,r.month-1,r.day,r.hour,r.min)-(r.dst ? 2 : 1)*3600000;
    else { const md=tcDoyDate(r.year,r.doy); utc=Date.UTC(r.year,md.month-1,md.day,r.hour,r.min)+60000; }   // кадр описывает минуту, которая только что кончилась
    n.confirmed=n.lastGood!=null && utc-n.lastGood===60000;
    n.lastGood=utc; n.good++;
    const d=new Date(utc);
    n.last={min:d.getUTCMinutes(), hour:d.getUTCHours(), utc, text:tcIso(utc)};
    const rec={t:Date.now(), src:n.p.station, kind:'time', id:n.p.station, utc:tcIso(utc), year:d.getUTCFullYear(), month:d.getUTCMonth()+1, day:d.getUTCDate(),
      hour:d.getUTCHours(), min:d.getUTCMinutes(), dst:r.dst ? 1 : 0, confirmed:n.confirmed ? 1 : 0, text:tcIso(utc)};
    if(dcf){ rec.weekday=r.weekday; if(r.annDst) rec.announceDst=1; if(r.annLeap) rec.announceLeap=1; }
    else { rec.doy=r.doy; rec.ut1=r.ut1; rec.leapYear=r.leapYear ? 1 : 0; if(r.leapSec) rec.leapSecondWarning=1; rec.dstBits=r.dstBits; }
    n.recent.push(rec.utc+(n.confirmed ? ' ✓' : ''));
    if(n.recent.length>20) n.recent.shift();
    recs.push(rec);
  }};

/* ---- генератор: несущая с провалами по кадру текущего времени ---- */
function tcGenerate(n,sr,N,which){
  let g=n.tc;
  if(!g || g.sr!==sr || g.which!==which){
    g=n.tc={sr, which, t:0, a:1, base:Math.floor(Date.now()/60000)*60000+60000, frame:null, minute:-1, lowA:which==='WWVB' ? 0.14 : 0.15};
  }
  const re=new Float32Array(N), im=new Float32Array(N), k=1-Math.exp(-1/(sr*0.003));
  for(let i=0;i<N;i++,g.t++){
    const sec=Math.floor(g.t/sr)%60, min=Math.floor(g.t/(sr*60));
    if(min!==g.minute){
      g.minute=min;
      const ms=g.base+min*60000;
      g.frame=which==='WWVB' ? wwvbEncode(ms) : dcfEncode(ms+60000);       // DCF77 кодирует следующую минуту
    }
    const pos=(g.t%sr)/sr*1000, sym=g.frame[sec];
    const w=sym==null ? 0 : which==='WWVB' ? (sym==='M' ? 800 : sym==='1' ? 500 : 200) : (sym==='1' ? 200 : 100);
    g.a+=((pos<w ? g.lowA : 1)-g.a)*k;
    re[i]=g.a;
  }
  return [re,im];
}
