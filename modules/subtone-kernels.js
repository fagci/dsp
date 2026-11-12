"use strict";
/* ============================ Субтоны: CTCSS и DCS ============================
   Чистая логика без DOM (страница и Node). Пары «приём ↔ передача» зеркальны (tools/test-subtone.mjs):
   • CTCSS: 50 стандартных тонов 67.0–254.1 Гц. Приём — ctRxNew/ctRxPush (ФНЧ → децимация ≈1 кГц → Гёрцель по всем тонам
     в окне Ханна 0.5 с каждые 0.1 с; тон принят, если он сильнее среднего остальных и выше порога, и повторился 2 раза);
     передача — ctTxNew/ctTxBlock (синус).
   • DCS: 23-битное слово Голея (23,12), 134.4 бит/с, NRZ. Данные: 9 бит кода (3 восьмеричные цифры, младший бит первым),
     маркер «100», затем 11 бит проверки; порождающий многочлен 0xC75. «N» — как есть, «I» — все биты инвертированы; из-за цикличности кода D023I читается как D047N, поэтому приёмник сообщает «N», если такой код есть, и «I» только если его нет.
     Приём — dcsRxNew/dcsRxPush: слово ищется в каждом отсчёте, исправляется до 3 ошибок, код подтверждается двумя
     подряд идущими словами; передача — dcsTxNew/dcsTxBlock (то же слово по кругу, сглаженное).
     Порядок битов и многочлен взяты по общепринятым реализациям; с настоящей радиостанцией не сверялись. */

const CT_TONES=[67.0,69.3,71.9,74.4,77.0,79.7,82.5,85.4,88.5,91.5,94.8,97.4,100.0,103.5,107.2,110.9,114.8,118.8,123.0,127.3,131.8,136.5,141.3,146.2,
  151.4,156.7,159.8,162.2,165.5,167.9,171.3,173.8,177.3,179.9,183.5,186.2,189.9,192.8,196.6,199.5,203.5,206.5,210.7,218.1,225.7,229.1,233.6,241.8,250.3,254.1];
const DCS_CODES=('023 025 026 031 032 036 043 047 051 053 054 065 071 072 073 074 114 115 116 122 125 131 132 134 143 145 152 155 156 162 165 172 174 205 212 223 225 226 243 244 245 246 '+
  '251 252 255 261 263 265 266 271 274 306 311 315 325 331 332 343 346 351 356 364 365 371 411 412 413 423 431 432 445 446 452 454 455 462 464 465 466 503 506 516 523 526 532 546 565 '+
  '606 612 624 627 631 632 654 662 664 703 712 723 731 732 734 743 754').split(' ');
const DCS_BAUD=134.4, DCS_G=0xC75;

/* ---------- общий ФНЧ + децимация до ≈1 кГц ---------- */
function stFront(sr,fc){
  const D=Math.max(1,Math.floor(sr/1000));
  return {D, fs:sr/D, a:1-Math.exp(-2*Math.PI*fc/sr), p:[0,0,0], k:0};
}
// отсчёт на входе → null или децимированный отсчёт
function stPush(f,x){
  f.p[0]+=f.a*(x-f.p[0]); f.p[1]+=f.a*(f.p[0]-f.p[1]); f.p[2]+=f.a*(f.p[1]-f.p[2]);
  if(++f.k<f.D) return null;
  f.k=0; return f.p[2];
}

/* ---------- CTCSS ---------- */
function ctTxNew(sr){ return {sr, ph:0}; }
function ctTxBlock(st,freq,amp,out){
  const w=2*Math.PI*freq/st.sr;
  for(let i=0;i<out.length;i++){ out[i]=amp*Math.sin(st.ph); st.ph+=w; if(st.ph>6.283185307179586) st.ph-=6.283185307179586; }
  return out;
}
function ctRxNew(sr,o){
  o=o||{};
  const f=stFront(sr,300), N=Math.round(f.fs*.5);
  const win=new Float64Array(N); let sw=0;
  for(let i=0;i<N;i++){ win[i]=.5-.5*Math.cos(2*Math.PI*i/(N-1)); sw+=win[i]; }
  return {f, N, win, sw, ring:new Float64Array(N), pos:0, cnt:0, step:Math.round(f.fs*.1), since:0,
    coef:CT_TONES.map(t=>2*Math.cos(2*Math.PI*t/f.fs)), ratio:o.ratio??8, min:o.min??.004,
    cand:-1, hit:0, miss:0, tone:0, amp:0, quality:0, lastRatio:0};
}
// Гёрцель по окну: мощности всех тонов
function ctPowers(st){
  const {N,ring,win,pos}=st, P=new Float64Array(CT_TONES.length);
  for(let t=0;t<CT_TONES.length;t++){
    const c=st.coef[t]; let s1=0, s2=0;
    for(let i=0;i<N;i++){ const s=ring[(pos+i)%N]*win[i]+c*s1-s2; s2=s1; s1=s; }
    P[t]=s1*s1+s2*s2-c*s1*s2;
  }
  return P;
}
// возвращает событие {tone, amp} / {tone:0} при смене состояния, иначе null
function ctRxPush(st,x){
  const y=stPush(st.f,x); if(y===null) return null;
  st.ring[st.pos]=y; st.pos=(st.pos+1)%st.N; if(st.cnt<st.N) st.cnt++;
  if(st.cnt<st.N || ++st.since<st.step) return null;
  st.since=0;
  const P=ctPowers(st);
  let m=0; for(let t=1;t<P.length;t++) if(P[t]>P[m]) m=t;
  let sum=0, k=0; for(let t=0;t<P.length;t++) if(Math.abs(CT_TONES[t]-CT_TONES[m])>6){ sum+=P[t]; k++; }
  const ratio=P[m]/Math.max(1e-18,sum/k), amp=2*Math.sqrt(P[m])/st.sw;
  st.lastRatio=ratio;
  const good=ratio>=st.ratio && amp>=st.min;
  let ev=null;
  if(good){
    st.miss=0;
    st.hit=st.cand===m ? st.hit+1 : 1; st.cand=m;
    if(st.hit>=2 && st.tone!==CT_TONES[m]){ st.tone=CT_TONES[m]; ev={tone:st.tone,amp}; }
    if(st.tone===CT_TONES[m]){ st.amp=amp; st.quality=ratio; }
  } else {
    st.hit=0; st.cand=-1;
    if(st.tone && ++st.miss>=4){ st.tone=0; st.amp=0; st.miss=0; ev={tone:0,amp:0}; }
  }
  return ev;
}

/* ---------- DCS: слово Голея (23,12) ---------- */
function dcsMod(c){ let r=c; for(let i=22;i>=11;i--) if(r&(1<<i)) r^=DCS_G<<(i-11); return r&0x7FF; }   // остаток по g(x)
let DCS_SYN=null;
function dcsSyn(){
  if(DCS_SYN) return DCS_SYN;
  const t=new Int32Array(2048).fill(-1); t[0]=0;
  for(let a=0;a<23;a++){
    t[dcsMod(1<<a)]=1<<a;
    for(let b=a+1;b<23;b++){
      t[dcsMod((1<<a)|(1<<b))]=(1<<a)|(1<<b);
      for(let c=b+1;c<23;c++) t[dcsMod((1<<a)|(1<<b)|(1<<c))]=(1<<a)|(1<<b)|(1<<c);
    }
  }
  return DCS_SYN=t;
}
const dcsPop=v=>{ let n=0; while(v){ n+=v&1; v>>>=1; } return n; };
const dcsSet=new Set(DCS_CODES);
// код «023» (+ инверсия) → 23 бита в порядке передачи: 12 бит данных (код, маркер 100), 11 бит проверки
function dcsBits(code,inv){
  const d=(parseInt(code,8)&511)|0x800, p=dcsMod(d<<11);
  const b=[]; for(let j=0;j<12;j++) b.push((d>>j)&1); for(let i=0;i<11;i++) b.push((p>>i)&1);
  return inv ? b.map(x=>x^1) : b;
}
// 23 бита (порядок передачи) → {code,inv,errs} или null; пробуются обе полярности, исправляется до 3 ошибок
function dcsParse(bits,maxErr){
  const lim=maxErr??3, syn=dcsSyn();
  let best=null;
  for(const inv of [0,1]){
    let c=0;
    for(let j=0;j<12;j++) c|=((bits[j]^inv)&1)<<(11+j);
    for(let i=0;i<11;i++) c|=((bits[12+i]^inv)&1)<<i;
    const e=syn[dcsMod(c)]; if(e<0) continue;
    const w=dcsPop(e), cc=c^e, d=cc>>>11;
    if(w>lim || (d>>9)!==4) continue;
    const code=(d&511).toString(8).padStart(3,'0');
    if(!dcsSet.has(code)) continue;
    if(!best || w<best.errs) best={code,inv:inv===1,errs:w};
  }
  return best;
}
function dcsTxNew(sr,code,inv){
  const bits=dcsBits(code,inv).map(b=>b?1:-1);
  return {sr, bits, spb:sr/DCS_BAUD, pos:0, lp:0, a:1-Math.exp(-2*Math.PI*160/sr)};
}
function dcsTxBlock(st,amp,out){
  for(let i=0;i<out.length;i++){
    const k=Math.floor(st.pos), v=st.bits[k%23];
    st.lp+=st.a*(v-st.lp); out[i]=amp*st.lp;
    st.pos+=1/st.spb; if(st.pos>=23) st.pos-=23;
  }
  return out;
}
function dcsRxNew(sr,o){
  o=o||{};
  const f=stFront(sr,180), spb=f.fs/DCS_BAUD, W=Math.ceil(23*spb)+2;
  return {f, spb, len:2*W+8, ring:new Float64Array(2*W+8), cnt:0, hold:0, code:'', inv:false, errs:0, maxErr:o.maxErr??2, min:o.min??.003};
}
const dcsAt=(st,t)=>{ const i=Math.floor(t), q=t-i; return st.ring[((i%st.len)+st.len)%st.len]*(1-q)+st.ring[(((i+1)%st.len)+st.len)%st.len]*q; };
function dcsWord(st,end){
  const bits=[], v=[]; let m=0;
  for(let k=0;k<23;k++){ const x=dcsAt(st,end-(22-k)*st.spb-st.spb/2); v.push(x); m+=x; }
  m/=23; let ac=0; for(const x of v){ bits.push(x>m ? 1 : 0); ac=Math.max(ac,Math.abs(x-m)); }
  return {r:dcsParse(bits,st.maxErr), ac};
}
// возвращает событие {code,inv} / {code:''} при смене состояния, иначе null
function dcsRxPush(st,x){
  const y=stPush(st.f,x); if(y===null) return null;
  st.ring[st.cnt%st.len]=y; st.cnt++;
  let ev=null;
  const need=Math.ceil(46*st.spb)+2;
  if(st.cnt>=need){
    const e=st.cnt-1, a=dcsWord(st,e), b=dcsWord(st,e-23*st.spb);
    // цикл слова Голея: тот же поток читается и как «N» с одним кодом, и как «I» с другим (D023I = D047N); при равенстве берём «N»
    if(a.r && b.r && a.r.code===b.r.code && a.r.inv===b.r.inv && a.ac>=st.min && !(a.r.inv && st.hold>0 && !st.inv)){
      st.hold=Math.ceil(st.f.fs*1.2); st.errs=a.r.errs+b.r.errs;
      if(st.code!==a.r.code || st.inv!==a.r.inv){ st.code=a.r.code; st.inv=a.r.inv; ev={code:st.code,inv:st.inv}; }
    }
  }
  if(st.hold>0 && --st.hold===0 && st.code){ st.code=''; st.inv=false; ev={code:'',inv:false}; }
  return ev;
}
