"use strict";
/* ============================ Модем: протокол соединения (без DOM) ============================
   Звонящий (call) и отвечающий (ans) — один и тот же автомат, роли различаются только каналом FSK и последовательностью.
   Последовательность (структура V.8 / V.34, но не битовая совместимость с V.34):
     набор DTMF → вызов → ANSam (2100 Гц, AM 15 Гц, развороты фазы 450 мс) → V.8: CM / JM / CJ на V.21 (300 бод) →
     INFO0 (возможности) → зондирование линии (маркерный тон + многотон L1/L2 с шагом 150 Гц) → INFO1 (выбранные
     символьная скорость и несущая) → обучение QAM (тон S, синхрослово, ПСП; эквалайзер T/2, МНК) → B1 (вердикт приёма,
     число бит на символ по измеренному SNR) → маркер ME → данные (скремблер, HDLC-подобное экранирование байтов).
   Каждая сторона по аудио слышит только то, что приходит с линии; общих переменных между ними нет. Не реализованы:
   V.90 / V.92 (PCM вниз; нужен цифровой конец линии), решётчатое кодирование, V.42 / V.42bis, эхоподавление (линия 4-проводная). */

const MDM_ROWS=[697,770,852,941], MDM_COLS=[1209,1336,1477,1633], MDM_KEYS='123A456B789C*0#D';
const MDM_LVL=0.15, MDM_PROBE_A=MDM_LVL/Math.sqrt(MDM_PROBE_N.length/2), MDM_NS=160;

function mdmBankNew(freqs,N){
  const k=freqs.map(f=>2*Math.cos(MDM_2PI*f/MDM_FS)), n=freqs.length, s1=new Float64Array(n), s2=new Float64Array(n); let c=0, e=0;
  const B={p:new Float64Array(n),e:0,push(x){ for(let i=0;i<n;i++){ const s0=x+k[i]*s1[i]-s2[i]; s2[i]=s1[i]; s1[i]=s0; } e+=x*x;
    if(++c<N) return false;
    for(let i=0;i<n;i++){ B.p[i]=4*(s1[i]*s1[i]+s2[i]*s2[i]-k[i]*s1[i]*s2[i])/(N*N); s1[i]=s2[i]=0; }
    B.e=2*e/N; c=0; e=0; return true; }};
  return B; }

// ---------- FSK-приёмник V.21 с кадрами V.8 / INFO ----------
function mdmFskRxNew(ch,on){
  const f=MDM_FSK[ch], N=MDM_FSKN, w1=MDM_2PI*f.one/MDM_FS, w0=MDM_2PI*f.zero/MDM_FS;
  const a1=new Float64Array(N), b1=new Float64Array(N), a0=new Float64Array(N), b0=new Float64Array(N), e2=new Float64Array(N);
  let pos=0, I1=0, Q1=0, I0=0, Q0=0, Ew=0, p1=0, p0=0, t=0, D=0, lock=false, nextD=0, gateOff=0, os=0, ov=0, msg=null, zeros=0;
  const sr=new Int32Array(10);
  const pat=(sync)=>{ const bits=[]; for(let i=0;i<10;i++) bits.push(1); bits.push(0); for(let k=0;k<8;k++) bits.push((sync>>k)&1); bits.push(1); let v=0; for(const b of bits) v=(v<<1)|b; return v; };
  const PATS=[[pat(0xE0),'V8'],[pat(0xD5),'INFO']];
  const pop=v=>{ v-=(v>>>1)&0x55555555; v=(v&0x33333333)+((v>>>2)&0x33333333); return (((v+(v>>>4))&0x0F0F0F0F)*0x01010101)>>>24; };
  function octet(v){
    if(msg){
      msg.o.push(v);
      if(msg.t==='V8'){ const o=msg.o;
        if(o.length===1 && (v&0x1F)!==1){ msg=null; return; }
        if(o.length===2){ if((v&0x1F)===5) on({t:'V8',cf:o[0]>>5,mod:v}); msg=null; } }
      else { const o=msg.o, len=o[0];
        if(len>24){ msg=null; return; }
        if(o.length===len+3){ const crc=mdmCrc16(o.slice(0,len+1)); if(((crc>>8)&255)===o[len+1] && (crc&255)===o[len+2]) on({t:'INFO',d:o.slice(1,len+1)}); msg=null; } }
      return; }
    if(v===0xE0){ msg={t:'V8',o:[]}; zeros=0; on({t:'SYNC'}); }
    else if(v===0xD5){ msg={t:'INFO',o:[]}; zeros=0; }
    else if(v===0){ if(++zeros>=3){ zeros=0; on({t:'CJ'}); } }
    else zeros=0; }
  function bit(b){
    if(os===0){ if(b===0){ os=1; ov=0; } }
    else if(os<=8){ ov|=b<<(os-1); os++; }
    else { if(b===1){ octet(ov); os=0; } else { lock=false; msg=null; os=0; } } }
  return {push(x){
    p1+=w1; p0+=w0; if(p1>MDM_2PI) p1-=MDM_2PI; if(p0>MDM_2PI) p0-=MDM_2PI;
    const c1=x*Math.cos(p1), s1=x*Math.sin(p1), c0=x*Math.cos(p0), s0=x*Math.sin(p0), xx=x*x;
    I1+=c1-a1[pos]; Q1+=s1-b1[pos]; I0+=c0-a0[pos]; Q0+=s0-b0[pos]; Ew+=xx-e2[pos];
    a1[pos]=c1; b1[pos]=s1; a0[pos]=c0; b0[pos]=s0; e2[pos]=xx; pos=(pos+1)%N; t++;
    if((t&3)!==0) return;
    D++; const E1=I1*I1+Q1*Q1, E0=I0*I0+Q0*Q0, gate=(E1+E0)>5*Ew && Ew>1e-6, bt=E1>E0?1:0, q=(t>>2)%10;
    if(!lock){ sr[q]=((sr[q]<<1)|bt)>>>0;
      if(gate) for(const [pv,type] of PATS) if(pop((sr[q]&0xFFFFF)^pv)<=1){ lock=true; nextD=D+14; os=0; msg={t:type,o:[]}; zeros=0; gateOff=0; on({t:'LOCK',type}); sr.fill(0); return; } }
    else { if(!gate){ if(++gateOff>40){ lock=false; msg=null; os=0; } } else gateOff=0;
      if(D===nextD){ nextD+=10; bit(bt); } } }}; }

// ---------- зондирование: приём многотона, оценка SNR на каждом тоне ----------
function mdmProbeRxNew(on){
  const tf=MDM_PROBE_N.map(n=>150*n), nf=[]; for(let i=0;i<26;i++) nf.push(75+150*i);
  const K=tf.length, bank=mdmBankNew(tf.concat(nf),1600); let frames=[], act=false, done=false;
  return {push(x){ if(done || !bank.push(x)) return;
    let pt=0; for(let i=0;i<K;i++) pt+=bank.p[i];
    const present=bank.e>1e-7 && pt/bank.e>0.5;
    if(present){ act=true; frames.push({pt,S:Array.from(bank.p.subarray(0,K)),N:Array.from(bank.p.subarray(K))}); }
    else if(act){ done=true; const mx=Math.max(...frames.map(f=>f.pt)), g=frames.filter(f=>f.pt>=0.85*mx);
      if(!g.length){ on(null); return; }
      const S=new Array(K).fill(0), N=new Array(26).fill(0);
      for(const f of g){ for(let i=0;i<K;i++) S[i]+=f.S[i]/g.length; for(let i=0;i<26;i++) N[i]+=f.N[i]/g.length; }
      on({S,N,frames:g.length}); } },
    get done(){ return done; }}; }

const MDM_IMPL=[44,40,42,41,39.5];                 // потолок SNR самого тракта (эквалайзер, усечение фильтров), измерен на линии без шума
const mdmBitsFor=(snrDb,bmax)=>{ const b=Math.floor(Math.log2(1+Math.pow(10,(snrDb-9.8-0.8)/10))); return b<2?0:Math.min(12,b,bmax); };
// выбор символьной скорости и несущей по результату зондирования; возвращает {bi,ci,b,snr,rate} или null
function mdmPlan(res,cap,bmask){
  const K=MDM_PROBE_N.length, F=MDM_PROBE_N.map(n=>150*n), A2=MDM_PROBE_A*MDM_PROBE_A, P0=MDM_LVL*MDM_LVL;
  const Nk=MDM_PROBE_N.map(n=>(res.N[n-1]+res.N[n])/2);
  const mid=res.S.filter((s,i)=>F[i]>=600&&F[i]<=3000).sort((a,b)=>a-b), ref=mid[mid.length>>1]||1e-12;
  const ok=F.map((f,i)=>res.S[i]>0.03*ref && res.S[i]/Math.max(Nk[i],1e-14)>16);
  let best=null;
  for(let bi=0;bi<5;bi++){ if(!((bmask>>bi)&1)) continue;
    for(let ci=0;ci<(bi===4?1:2);ci++){
      const c=mdmCfg(bi,ci), lo=c.fc-c.B/2, hi=c.fc+c.B/2; if(lo<75 || hi>3825) continue;
      const idx=[]; for(let i=0;i<K;i++) if(F[i]>=lo-75 && F[i]<=hi+75) idx.push(i);
      if(idx.length<4 || !idx.every(i=>ok[i])) continue;
      const G=idx.reduce((a,i)=>a+res.S[i]/A2,0)/idx.length, N0=idx.reduce((a,i)=>a+Nk[i]/15,0)/idx.length;
      const snr=Math.min(MDM_IMPL[bi],10*Math.log10(P0*G/Math.max(N0*c.B,1e-14))), b=mdmBitsFor(snr,Math.floor(cap/c.B));
      if(!b) continue;
      const rate=c.B*b; if(!best || rate>best.rate+1) best={bi,ci,b,snr,rate}; } }
  return best; }

// ---------- сообщения ----------
const mdmCmBits=(mod,pre)=>mdmOctBits([0xE0,(6<<5)|1,mod],pre);              // функция вызова: данные (V series)
function mdmInfoBits(d){ const p=[d.length].concat(d), c=mdmCrc16(p); return mdmOctBits([0xD5].concat(p,[(c>>8)&255,c&255]),true); }

// ---------- автомат модема ----------
function mdmNew(o){
  o=Object.assign({role:'call',digits:'5551212',seed:1,pace:1,maxRate:33600,ringS:2.2,toneMs:100,gapMs:70,dialToneMs:900,ansTimeout:30,bmask:31,rtn:3},o);
  const m={o,role:o.role,pace:Math.max(0.5,o.pace),ph:'idle',pt:0,q:[],cur:null,logs:[],rnd:mdmRng(o.seed),txq:[],rxq:[],rxText:'',
    bank:mdmBankNew(MDM_ROWS.concat(MDM_COLS,[2100,1200,2400]),240),
    ch:o.role==='call'?1:2, fsk:null, probe:null, qrx:null, qtx:null, connected:false, rate:{tx:0,rx:0}, ev:{}, status:'idle', nowMs:0,
    dt:{digits:'',cur:-1,run:0,gap:1e4,last:-1}, ansN:0, mkN:0, eRef:0, e:0, eLow:0, tb:0, tbi:0, esc:false, rbit:0, rbn:0, rbyte:0, rxEsc:false};
  m.fsk=mdmFskRxNew(m.role==='call'?2:1,e=>mdmFskEv(m,e));
  return m; }
function mlog(m,t){ m.logs.push({ms:m.nowMs,t}); if(m.logs.length>200) m.logs.splice(0,m.logs.length-200); m.status=t; }
const mdmPush=(m,s)=>{ m.q.push(s); return s; };
function mdmHang(m,why){
  m.q.length=0; m.cur=null; m.qtx=null; m.qrx=null; m.probe=null;
  const was=m.ph!=='idle'; m.ph='idle'; m.pt=0; m.connected=false; m.rate={tx:0,rx:0}; m.ev={}; m.dt={digits:'',cur:-1,run:0,gap:1e4,last:-1}; m.stopRep=false;
  m.verdict=null; m.peerB1=null; m.peer0=null; m.peer1=null; m.res=null; m.sent0=false; m.sent1=false; m.b1sent=false; m.meSent=false; m.rxData=false; m.try=0; m.lastMsg=null; m.cmLock=false; m.info0Q=false; m.info1Bits=null; m.eRef=0;
  if(why && was) mlog(m,why); }
function mdmSend(m,bytes){ for(const b of bytes) m.txq.push(b&255); }
function mdmFskEv(m,e){
  if(e.t==='LOCK'){ if(m.role==='ans' && e.type==='V8') m.cmLock=true; return; }
  if(e.t==='V8'){ const same=m.lastMsg && m.lastMsg.mod===e.mod && m.lastMsg.cf===e.cf; m.lastMsg=e;
    if(same && (e.mod&0x40)){ m.ev.v8two=true; } return; }
  if(e.t==='CJ'){ m.ev.cj=true; return; }
  if(e.t==='INFO'){ const d=e.d; if(d.length===4 && d[0]===1 && (d[1]&1)) m.peer0=m.peer0||{caps:d[1],cap:d[2]*200,bmask:d[3]};
    else if(d.length===5 && d[0]===2) m.peer1=m.peer1||{bi:d[1],ci:d[2],bg:d[3],ntr:d[4]*64}; } }

// ---- сегмент QAM-передачи: этапы S → SYNC → ПСП → заполнитель → (MB + B1) → ME → данные ----
function mdmTxQam(m,cfg){
  const Ntr=640, q={stage:'GAP',k:0,cfg,fill:mdmLfsr16(0xACE1),pn:null,map:null,scr:null,b1:null};
  q.pn=mdmPnSyms(MDM_PNSEED,4096);
  q.restart=()=>{ q.stage='GAP'; q.k=0; q.fill=mdmLfsr16(0xACE1); };
  q.next=()=>{ for(;;){ switch(q.stage){
    case 'GAP': if(q.k<120){ q.k++; return [0,0]; } q.stage='S'; q.k=0; continue;
    case 'S': if(q.k<MDM_NS) return [(q.k++&1)?-1:1,0]; q.stage='SYNC'; q.k=0; continue;
    case 'SYNC': if(q.k<32) return MDM_SYNC[q.k++]; q.stage='PN'; q.k=0; continue;
    case 'PN': if(q.k<q.ntr) return q.pn[q.k++]; q.stage='FILL'; continue;
    case 'FILL': return mdmQpsk(q.fill(),q.fill());
    case 'MB': if(q.k<16) return MDM_MB[q.k++]; q.stage='B1'; q.k=0; continue;
    case 'B1': if(q.k<24) return q.b1[q.k++]; q.stage='FILL'; continue;
    case 'ME': if(q.k<16) return MDM_ME[q.k++]; q.stage='DATA'; q.meDone=true; continue;
    default: { let v=0; for(let i=0;i<q.map.b;i++) v=(v<<1)|q.scr.tx(mdmTxBit(m)); return q.map.map(v); } } } };
  q.ntr=Ntr; return q; }
function mdmTxBit(m){ if(m.tbi===0){
    if(m.txq.length){ const v=m.txq.shift(); if(v===0x7E||v===0x7D){ m.txq.unshift(v^0x20); m.tb=0x7D; } else m.tb=v; } else m.tb=0x7E; }
  const b=(m.tb>>(7-m.tbi))&1; m.tbi=(m.tbi+1)&7; return b; }
function mdmRxBit(m,b){ m.rbyte=((m.rbyte<<1)|b)&255; if(++m.rbn<8) return; m.rbn=0; const v=m.rbyte;
  if(v===0x7E){ m.rxEsc=false; return; } if(v===0x7D){ m.rxEsc=true; return; }
  const c=m.rxEsc?v^0x20:v; m.rxEsc=false; m.rxq.push(c); m.rxText+=(c>=32&&c<127)||c===10||c===13?String.fromCharCode(c):'·'; if(m.rxText.length>4000) m.rxText=m.rxText.slice(-3000); }
function mdmB1Syms(ok,b){ const by=[0xB1,(ok?0x80:0)|(b&15)]; by.push(mdmCrc8(by)); const bits=[];
  for(let c=0;c<2;c++) for(const v of by) for(let k=7;k>=0;k--) bits.push((v>>k)&1);
  const s=[]; for(let i=0;i<bits.length;i+=2) s.push(mdmQpsk(bits[i],bits[i+1])); return s; }

function mdmStartRx(m,cfg,ntr){
  const hooks={
    verdict:v=>{ const cap=Math.min(m.o.maxRate,(m.peer0&&m.peer0.cap)||1e9), b=v.ok?mdmBitsFor(v.snr,Math.floor(cap/cfg.B)):0;
      m.verdict={ok:v.ok&&b>0,b,snr:v.snr}; if(m.verdict.ok) m.qrx.setB(b);
      mlog(m,'Обучение приёма: SNR '+v.snr.toFixed(1)+' дБ → '+(m.verdict.ok?b+' бит/символ ('+Math.round(cfg.B*b)+' бит/с)':'сбой')); },
    b1:f=>{ if(m.peerB1) return; m.peerB1=(f&&f[0]===0xB1)?{ok:!!(f[1]&0x80),b:f[1]&15}:{ok:false,b:0}; },
    marker:()=>{ m.rxData=true; },
    data:b=>mdmRxBit(m,b), log:t=>mlog(m,t)};
  m.qrx=mdmQamRxNew(cfg,{NS:MDM_NS,Ntr:ntr,scr:()=>mdmScr(m.role==='call'?5:18)},hooks); m.rxCfg=cfg; m.rxNtr=ntr;
  m.verdict=null; m.peerB1=null; m.rxData=false; m.b1sent=false; m.rbn=0; m.rxEsc=false; }

// ---- обработка кадра банка A (20 мс): DTMF, ANSam, маркеры, энергия ----
function mdmBankFrame(m){
  const b=m.bank, p=b.p, e=b.e;
  let r=0, c=0; for(let i=1;i<4;i++){ if(p[i]>p[r]) r=i; if(p[4+i]>p[4+c]) c=i; }
  const rs=[0,1,2,3].filter(i=>i!==r).reduce((a,i)=>a+p[i],0), cs=[0,1,2,3].filter(i=>i!==c).reduce((a,i)=>a+p[4+i],0);
  const dig=(e>1e-5 && (p[r]+p[4+c])/e>0.6 && p[r]>3*rs && p[4+c]>3*cs)?r*4+c:-1, d=m.dt;
  if(dig>=0){ if(dig===d.cur) d.run++; else { d.cur=dig; d.run=1; }
    if(d.run===2 && d.last!==dig){ d.digits+=MDM_KEYS[dig]; d.last=dig; d.gap=0; } }
  else { d.cur=-1; d.run=0; d.gap+=20; if(d.gap>=40) d.last=-1; }
  m.ansN=(e>1e-5 && p[8]/e>0.6)?m.ansN+1:0;
  const mk=m.role==='call'?9:10; m.mkN=(e>1e-6 && p[mk]/e>0.5)?m.mkN+1:0;
  m.e=e; m.eRef=Math.max(m.eRef*0.9995||0,e); m.eLow=(e<1e-7||e<0.002*m.eRef)?m.eLow+20:0; }

function mdmRun(m,x,n,y,mon){
  const dtMs=n*1000/MDM_FS; m.nowMs+=dtMs; m.pt+=dtMs;
  // 1. приём
  for(let i=0;i<n;i++){ const v=x[i]; if(m.bank.push(v)) mdmBankFrame(m); m.fsk.push(v);
    if(m.probe) m.probe.push(v); if(m.qrx) m.qrx.push(v); }
  mdmTick(m);
  // 2. передача
  let o=0;
  while(o<n){
    if(!m.cur){ m.cur=m.q.shift()||null; if(!m.cur){ for(;o<n;o++) y[o]=0; break; } }
    const s=m.cur, w=s.fill(y,o,n-o); o+=w;
    if(s.done){ m.cur=null; if(s.onEnd) s.onEnd(); } }
  // 3. динамик: линия + свой сигнал + звуки станции (гудок, КПВ)
  if(mon){ const t0=(m.nowMs-dtMs)/1000, ph=m.ph, call=m.role==='call', ring=call && ph==='waitans' && m.ansN<2;
    for(let i=0;i<n;i++){ const t=t0+i/MDM_FS; let ex=0;
      if(call && ph==='dialtone') ex=0.06*(Math.sin(MDM_2PI*350*t)+Math.sin(MDM_2PI*440*t));
      else if(ring && m.pt>400 && ((m.pt-400)%6000)<2000) ex=0.05*(Math.sin(MDM_2PI*440*t)+Math.sin(MDM_2PI*480*t));
      mon[i]=0.5*(x[i]+y[i])+ex; } }
}
const mdmIdle=m=>!m.cur && !m.q.length;
function mdmAfterCj(m){ m.ph='info0'; m.pt=0; m.sent0=false; m.peer0=null; m.probe=mdmProbeRxNew(r=>{ m.res=r||{fail:true}; }); }
function mdmSendInfo0(m){
  const d=[1,1,Math.round(m.o.maxRate/200),m.o.bmask&31]; mdmPush(m,mdmFskSeg(mdmInfoBits(d),m.ch,0.21,{onEnd:()=>{ m.sent0=true; m.sent0At=m.nowMs; }})); }
function mdmFail(m,t){ mlog(m,t); mdmHang(m); }

function mdmDial(m){
  if(m.role!=='call' || m.ph!=='idle') return false; mdmHang(m);
  m.ph='dialtone'; m.pt=0; mlog(m,'Трубка снята, гудок станции');
  mdmPush(m,mdmSil(m.o.dialToneMs,{onEnd:()=>{
    m.ph='dial'; mlog(m,'Набор '+m.o.digits);
    for(const ch of String(m.o.digits).toUpperCase()){ const k=MDM_KEYS.indexOf(ch); if(k<0) continue;
      mdmPush(m,mdmTones([MDM_ROWS[k>>2],MDM_COLS[k&3]],[MDM_LVL,MDM_LVL],m.o.toneMs)); mdmPush(m,mdmSil(m.o.gapMs)); }
    mdmPush(m,mdmSil(10,{onEnd:()=>{ m.ph='waitans'; m.pt=0; }})); }}));
  return true; }

function mdmTick(m){
  const ph=m.ph;
  if(ph==='idle'){
    if(m.role==='ans' && m.dt.digits.length>0 && m.dt.gap>=600){ mlog(m,'Входящий вызов ('+m.dt.digits.length+' цифр), звонок'); m.ph='ring'; m.pt=0; } }
  else if(ph==='ring'){
    if(m.pt>=m.o.ringS*1000){ mlog(m,'Снята трубка, отправляю ANSam'); m.ph='ansam'; m.pt=0; m.cmLock=false;
      mdmPush(m,mdmSil(200)); mdmPush(m,mdmAnsam(5000,0.21,{until:()=>m.cmLock,onEnd:()=>{ if(!m.cmLock){ mdmFail(m,'NO CARRIER: нет ответа на ANSam'); return; } mdmPush(m,mdmSil(75)); m.ph='v8a'; m.pt=0; }})); } }
  else if(ph==='ansam'){ /* ждём CM; сегмент ANSam сам заканчивается по cmLock */ }
  else if(ph==='v8a'){
    if(m.ev.v8two){ m.ev.v8two=false; m.ph='jm'; m.pt=0; mlog(m,'V.8: CM принят дважды, отвечаю JM (V.34)'); m.stopRep=false;
      const rep=()=>{ if(m.stopRep){ return; } mdmPush(m,mdmFskSeg(mdmCmBits(0x45,true),2,0.21,{onEnd:rep})); }; rep(); }
    else if(m.pt>8000) mdmFail(m,'NO CARRIER: нет CM'); }
  else if(ph==='jm'){
    if(m.ev.cj){ m.ev.cj=false; m.stopRep=true; mlog(m,'V.8: CJ — выбран V.34');
      mdmPush(m,mdmSil(75,{onEnd:()=>mdmAfterCj(m)})); m.ph='cj'; }
    else if(m.pt>8000) mdmFail(m,'NO CARRIER: нет CJ'); }
  else if(ph==='waitans'){
    if(m.ansN>=8){ mlog(m,'Принят ANSam (2100 Гц), V.8: отправляю CM'); m.ph='cm'; m.pt=0; m.stopRep=false; m.ev.v8two=false; m.lastMsg=null;
      mdmPush(m,mdmSil(500,{onEnd:()=>{ const rep=()=>{ if(m.stopRep){ return; } mdmPush(m,mdmFskSeg(mdmCmBits(0x45,true),1,0.21,{onEnd:rep})); }; rep(); }})); }
    else if(m.pt>m.o.ansTimeout*1000) mdmFail(m,'NO ANSWER'); }
  else if(ph==='cm'){
    if(m.ev.v8two){ m.ev.v8two=false; m.stopRep=true; mlog(m,'V.8: JM принят дважды, отправляю CJ');
      mdmPush(m,mdmFskSeg(mdmOctBits([0,0,0],false),1,0.21)); mdmPush(m,mdmSil(75,{onEnd:()=>mdmAfterCj(m)})); m.ph='cj'; }
    else if(m.pt>9000) mdmFail(m,'NO CARRIER: нет JM'); }
  else if(ph==='info0'){
    if(!m.sent0 && mdmIdle(m) && !m.info0Q){ m.info0Q=true; mdmSendInfo0(m); }
    if(m.sent0 && !m.peer0 && mdmIdle(m) && m.nowMs-m.sent0At>2500){ m.sent0=false; m.info0Q=false; }
    if(m.sent0 && m.peer0 && mdmIdle(m)){
      const inter=m.peer0.bmask&m.o.bmask; if(!inter){ mdmFail(m,'NO CARRIER: нет общей символьной скорости'); return; }
      m.info0Q=false; m.ph='probe'; m.pt=0; mlog(m,'INFO0 обменяны, зондирую линию (L1 / L2)');
      const mk=m.role==='call'?2400:1200, pc=m.pace;
      mdmPush(m,mdmSil(80)); mdmPush(m,mdmTones([mk],[0.2],150*pc)); mdmPush(m,mdmSil(40));
      mdmPush(m,mdmProbeSeg(160,MDM_PROBE_A*0.6)); mdmPush(m,mdmProbeSeg(480*pc,MDM_PROBE_A)); mdmPush(m,mdmSil(120)); }
    else if(m.pt>25000) mdmFail(m,'NO CARRIER: нет INFO0'); }
  else if(ph==='probe'){
    if(m.res && mdmIdle(m) && !m.sent1){
      if(m.res.fail){ mdmFail(m,'NO CARRIER: зондирование не принято'); return; }
      const cap=Math.min(m.o.maxRate,m.peer0.cap), plan=mdmPlan(m.res,cap,m.o.bmask&m.peer0.bmask);
      if(!plan){ mdmFail(m,'NO CARRIER: линия не годится ни для одной скорости'); return; }
      const cfg=mdmCfg(plan.bi,plan.ci); const ntr=Math.round(640*m.pace/64)*64;
      mlog(m,'Линия: SNR ≈ '+plan.snr.toFixed(0)+' дБ → '+Math.round(cfg.B)+' бод, несущая '+cfg.fc+' Гц');
      mdmStartRx(m,cfg,ntr);
      m.info1Bits=mdmInfoBits([2,plan.bi,plan.ci,plan.b,ntr/64]);
      mdmPush(m,mdmFskSeg(m.info1Bits,m.ch,0.21,{onEnd:()=>{ m.sent1=true; m.sent1At=m.nowMs; }}));
      m.ph='info1'; m.pt=0; }
    else if(m.pt>15000) mdmFail(m,'NO CARRIER: зондирование не завершено'); }
  else if(ph==='info1'){
    if(m.sent1 && !m.peer1 && mdmIdle(m) && m.nowMs-m.sent1At>2500){ m.sent1At=m.nowMs; mdmPush(m,mdmFskSeg(m.info1Bits,m.ch,0.21)); }
    if(m.sent1 && m.peer1 && mdmIdle(m)){
      const cfg=mdmCfg(m.peer1.bi,m.peer1.ci); m.txCfg=cfg;
      m.qtx=mdmTxQam(m,cfg); m.qtx.ntr=m.peer1.ntr||640; m.qtx.restart();
      mdmPush(m,mdmQamTxSeg(cfg,MDM_LVL,m.qtx.next,{}));
      m.ph='train'; m.pt=0; m.try=0; m.trainAt=m.nowMs; mlog(m,'Обучение: '+Math.round(cfg.B)+' бод, несущая '+cfg.fc+' Гц'); }
    else if(m.pt>20000) mdmFail(m,'NO CARRIER: нет INFO1'); }
  else if(ph==='train'){
    const q=m.qtx;
    if(m.qrx && m.qrx.st==='dead' && !m.verdict){ m.verdict={ok:false,b:0,snr:0}; mlog(m,'Обучение приёма не удалось'); }
    else if(m.qrx && m.qrx.st==='listen' && !m.verdict && m.nowMs-m.trainAt>3500){ m.verdict={ok:false,b:0,snr:0}; mlog(m,'Обучение приёма: тон S не услышан'); }
    if(m.verdict && !m.b1sent && q.stage==='FILL'){
      q.b1=mdmB1Syms(m.verdict.ok,m.verdict.b); q.stage='MB'; q.k=0; m.b1sent=true; }
    if(m.verdict && m.b1sent && (!m.verdict.ok || m.peerB1) && q.stage==='FILL'){
      if(m.verdict.ok && m.peerB1 && m.peerB1.ok){
        q.map=mdmQamMap(m.peerB1.b); q.scr=mdmScr(m.role==='call'?18:5); q.stage='ME'; q.k=0; m.meSent=true; m.txB=m.peerB1.b;
        m.ph='data0'; m.pt=0; mlog(m,'Передача: '+m.peerB1.b+' бит/символ, начинаю данные'); }
      else { if(++m.try>=m.o.rtn){ mdmFail(m,'NO CARRIER: обучение не удалось'); return; }
        mlog(m,'Повторное обучение ('+(m.try+1)+'/'+m.o.rtn+')'); q.restart(); mdmStartRx(m,m.rxCfg,m.rxNtr); m.trainAt=m.nowMs; } }
    else if(m.pt>14000+8000*m.pace) mdmFail(m,'NO CARRIER: нет обмена B1'); }
  else if(ph==='data0'){
    if(m.rxData && m.qtx.meDone){ m.ph='data'; m.pt=0; m.connected=true;
      const rx=Math.round(m.rxCfg.B*m.verdict.b), tx=Math.round(m.txCfg.B*m.txB); m.rate={tx,rx};
      mlog(m,'CONNECT '+tx+' / '+rx+' (V.34-подобный, '+Math.round(m.txCfg.B)+' / '+Math.round(m.rxCfg.B)+' бод)'); }
    else if(m.pt>6000) mdmFail(m,'NO CARRIER: нет маркера данных'); }
  else if(ph==='data'){
    if(m.eLow>600){ mdmHang(m,'NO CARRIER: несущая пропала'); } }
}
