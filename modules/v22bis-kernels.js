"use strict";
/* ============================ V.22bis (2400 бит/с) и V.22 (1200 бит/с): модем по спецификации (без DOM) ============================
   600 бод; звонящий передаёт на 1200 Гц, принимает на 2400 Гц, отвечающий наоборот. 1200: 4-ФМн (дибит → скачок фазы), 2400: 16-QAM
   (два бита — скачок квадранта, ещё два — позиция в квадранте). Скремблер 1+x⁻¹⁴+x⁻¹⁷ с инверсией после 64 единиц подряд. Импульс —
   корень из приподнятого косинуса (спад 75 %). Рукопожатие: ANS 2100 Гц → «немаскированные единицы» отвечающего (U11) → звонящий через
   155 + 456 мс шлёт S1 (двойной дибит 00 11, 100 мс) → скремблированные единицы 1200 → через 600 мс — 2400 (200 мс) → данные.
   Данные идут асинхронно, 8N1 (10 бит на байт), пауза — единицы. Написано по описанию рекомендации в исходниках открытого spandsp
   (тайминги, таблица созвездия, скремблер, фазовые шаги); код не копировался. Совместимость с настоящими модемами НЕ проверена:
   нет эталона, который можно запустить, нет железа; приёмник без адаптивного эквалайзера (на идеальной модели линии он не нужен). */

const V22_C=[[1,1],[3,1],[1,3],[3,3],[-1,1],[-1,3],[-3,1],[-3,3],[-1,-1],[-3,-1],[-1,-3],[-3,-3],[1,-1],[1,-3],[3,-1],[3,-3]];
const V22_STEP=[1,0,2,3], V22_INV=[1,0,2,3], V22_K=1/Math.sqrt(10), V22_BETA=0.75;
const V22_SYM=ms=>Math.round(ms*0.6);                      // миллисекунды → символы (600 бод)
function v22Scr(){ let reg=0, cnt=0;
  return {tx(bit){ if(cnt>=64){ bit^=1; cnt=0; } const o=(bit^(reg>>13)^(reg>>16))&1; reg=((reg<<1)|o)&0x3FFFF; if(o) cnt++; else cnt=0; return o; },
          rx(bit){ bit&=1; let o=(bit^(reg>>13)^(reg>>16))&1; reg=((reg<<1)|bit)&0x3FFFF; if(cnt>=64){ o^=1; cnt=0; } if(bit) cnt++; else cnt=0; return o; }}; }
const v22Pt=(q,b)=>V22_C[(q<<2)|b];
const v22Rot=(p,q)=>{ let x=p[0], y=p[1]; for(let i=0;i<q;i++){ const t=x; x=-y; y=t; } return [x,y]; };

// ---------- слепой приёмник: ФНЧ-согласованный фильтр, такт по линии 600 Гц в |y|², ФАПЧ, срез ----------
function v22RxNew(calling,hook){
  const fc=calling?2400:1200, T=20, w=MDM_2PI*fc/MDM_FS, Nf=121, h=new Float64Array(Nf);
  { let e=0; for(let i=0;i<Nf;i++){ h[i]=mdmRrcAt((i-60)/T,V22_BETA); e+=h[i]*h[i]; } const k=1/Math.sqrt(e/T)/T*1.0; for(let i=0;i<Nf;i++) h[i]*=k; }
  const mr=new Float64Array(2*Nf), mi=new Float64Array(2*Nf), ya=new Float64Array(256), yb=new Float64Array(256);
  const c20=new Float64Array(T), s20=new Float64Array(T); for(let i=0;i<T;i++){ c20[i]=Math.cos(MDM_2PI*i/T); s20[i]=Math.sin(MDM_2PI*i/T); }
  let wp=0, nco=0, n=0, Xr=0, Xi=0, P=0, ts=-1, pw=0, th=0, fr=0;
  const E={mode16:false,active:false,evm:0,TOFF:0}; let err2=0, errN=0;
  const lam=1-1/180;
  function symbol(){
    const i0=Math.floor(ts), f=ts-i0, a=i0&255, b=(i0+1)&255;
    const yr=ya[a]*(1-f)+ya[b]*f, yi=yb[a]*(1-f)+yb[b]*f;
    const ratio=Math.hypot(Xr,Xi)/(P+1e-30);
    if(ratio>0.08){ const te=((-Math.atan2(Xi,Xr)/MDM_2PI*T+E.TOFF)%T+T)%T; let er=te-(((ts%T)+T)%T); if(er>T/2) er-=T; else if(er<-T/2) er+=T; ts+=T+0.12*er; } else ts+=T;
    pw=pw?pw*(1-1/64)+(yr*yr+yi*yi)/64:(yr*yr+yi*yi);
    E.active=P>5e-6; if(!E.active) return;
    const g=Math.sqrt(10/(pw+1e-30)), c=Math.cos(th), s=Math.sin(th), zr=g*(yr*c+yi*s), zi=g*(-yr*s+yi*c);
    let q=zr>=0?(zi>=0?0:3):(zi>=0?1:2), d, idx;
    if(E.mode16){ const p=v22Rot([zr,zi],(4-q)&3), lx=p[0]>=2?3:1, ly=p[1]>=2?3:1; idx=(lx===3?1:0)|(ly===3?2:0); d=v22Rot([lx,ly],q); }
    else { idx=1; d=v22Rot([3,1],q); }
    // квадрант по знакам неоднозначен вблизи осей — берём ближайшую точку из 4 (1200) по углу
    if(!E.mode16){ let best=1e9; for(let k=0;k<4;k++){ const r=v22Rot([3,1],k), dd=(zr-r[0])*(zr-r[0])+(zi-r[1])*(zi-r[1]); if(dd<best){ best=dd; q=k; d=r; } } }
    const phi=Math.atan2(zi*d[0]-zr*d[1],zr*d[0]+zi*d[1]);
    fr=Math.max(-0.05,Math.min(0.05,fr+0.0025*phi)); th+=fr+0.07*phi; if(th>Math.PI) th-=MDM_2PI; else if(th<-Math.PI) th+=MDM_2PI;
    err2+=(zr-d[0])*(zr-d[0])+(zi-d[1])*(zi-d[1]); if(++errN>=128){ E.evm=-10*Math.log10(Math.max(err2/errN/10,1e-9)); err2=0; errN=0; }
    hook(q,idx,zr,zi); }
  E.push=function(x){
    const c=Math.cos(nco), s=Math.sin(nco); nco+=w; if(nco>MDM_2PI) nco-=MDM_2PI;
    mr[wp]=mr[wp+Nf]=x*c; mi[wp]=mi[wp+Nf]=-x*s; wp=(wp+1)%Nf;
    let yr=0, yi=0; for(let k=0;k<Nf;k++){ yr+=h[k]*mr[wp+k]; yi+=h[k]*mi[wp+k]; }
    ya[n&255]=yr; yb[n&255]=yi;
    const p=yr*yr+yi*yi, k20=n%T; P=P*lam+p*(1-lam); Xr=Xr*lam+(1-lam)*p*c20[k20]; Xi=Xi*lam-(1-lam)*p*s20[k20];
    if(ts<0 && n>=Nf) ts=n+T;
    while(ts>=0 && ts+1<=n) symbol();
    n++; };
  return E; }

// ---------- сессия: передатчик, рукопожатие, данные ----------
// o: {calling, rate (макс. 2400|1200), getBit(), putBit(b), log(t), amp}
function v22New(o){
  const S={calling:o.calling,rate:o.rate>=2400?2400:1200,neg:0,connected:false,rxReady:false,log:o.log||(()=>{}),phase:o.calling?'wait':'u11',txN:0,rxn:0,
    pts:[],sawS1:false,c3:0,alt:0,pstep:0,ones:0,inS1:false,pq:0,mode16At:-1,rdyAt:-1};
  const tx=S.tx={stage:'SIL',k:0,state:0,sched:null,scr:v22Scr(),n:0};
  tx.at=(ms,stage)=>{ tx.sched={at:tx.n+V22_SYM(ms),stage}; };
  tx.go=stage=>{ tx.stage=stage; tx.k=0; };
  const sc=p=>[p[0]*V22_K,p[1]*V22_K];
  tx.next=()=>{
    tx.n++; if(tx.sched && tx.n>=tx.sched.at){ tx.go(tx.sched.stage); tx.sched=null; }
    switch(tx.stage){
      case 'SIL': return [0,0];
      case 'U11': tx.state=(tx.state+3)&3; return sc(v22Pt(tx.state,1));
      case 'S1': tx.state=(tx.state+V22_STEP[3*(tx.k&1)])&3; if(++tx.k>=V22_SYM(100)) tx.go('S11'); return sc(v22Pt(tx.state,1));
      case 'S11': { let b=tx.scr.tx(1); b=(b<<1)|tx.scr.tx(1); tx.state=(tx.state+V22_STEP[b])&3; return sc(v22Pt(tx.state,1)); }
      case 'S1111': { let b=tx.scr.tx(1); b=(b<<1)|tx.scr.tx(1); tx.state=(tx.state+V22_STEP[b])&3; let l=tx.scr.tx(1); l=(l<<1)|tx.scr.tx(1);
        if(++tx.k>=V22_SYM(200)) { tx.go('DATA'); S.onTxData(); } return sc(v22Pt(tx.state,l)); }
      default: { let b=tx.scr.tx(o.getBit()); b=(b<<1)|tx.scr.tx(o.getBit()); tx.state=(tx.state+V22_STEP[b])&3; let l=1;
        if(S.neg===2400){ l=tx.scr.tx(o.getBit()); l=(l<<1)|tx.scr.tx(o.getBit()); } return sc(v22Pt(tx.state,l)); } } };
  S.onTxData=()=>{ S.txData=true; };
  // приём
  const rx=S.rx=v22RxNew(S.calling,(q,idx,zr,zi)=>{
    S.rxn++; if(S.pts.length<4096) S.pts.push(zr/3,zi/3);
    const st=(q-S.pq)&3; S.pq=q;
    const prev=S.pstep; S.pstep=st;
    S.c3=st===3?S.c3+1:0;
    S.alt=((st===1&&prev===3)||(st===3&&prev===1))?S.alt+1:0;
    if(S.alt>=30) S.inS1=true;
    if(S.inS1 && S.alt===0){ S.inS1=false; S.sawS1=true; S.onS1End(); }
    if(S.rxn>=S.mode16At && S.mode16At>=0) rx.mode16=true;
    const bits=[V22_INV[st]>>1,V22_INV[st]&1]; if(rx.mode16){ bits.push(idx>>1,idx&1); }
    for(const b0 of bits){ const d=S.rscr.rx(b0); S.ones=d?S.ones+1:0; if(S.rxReady) o.putBit(d); }
    S.afterBits(); });
  S.rscr=v22Scr();
  S.onS1End=()=>{
    if(S.rate<2400) return;
    if(S.phase==='wait'||S.phase==='c_sil'){ return; }
    if(S.calling && S.phase==='c_s1'){ S.neg=2400; tx.at(600,'S1111'); S.mode16At=S.rxn+V22_SYM(500); S.phase='c_2400'; S.log('V.22bis: S1 от отвечающего принят, через 600 мс — 2400'); }
    else if(!S.calling && S.phase==='u11'){ S.neg=2400; tx.go('S1'); tx.at(600,'S1111'); S.mode16At=S.rxn+V22_SYM(500); S.phase='a_2400'; S.log('V.22bis: S1 от звонящего принят, отвечаю S1 и 2400'); } };
  S.afterBits=()=>{
    if(S.calling && S.phase==='wait' && S.c3>=V22_SYM(150)){ S.phase='c_sil'; S.log('V.22bis: единицы отвечающего приняты, пауза 456 мс');
      if(S.rate>=2400){ tx.at(456,'S1'); S.phase='c_s1'; } else { tx.at(456,'S11'); S.phase='c_1200'; } }
    if(!S.dec1200 && S.ones>=324 && (!S.sawS1 || S.rate<2400)){ S.dec1200=true; S.rxReady=true;
      if(!S.calling && S.phase==='u11'){ S.neg=1200; tx.go('S11'); tx.at(765,'DATA'); S.phase='a_1200'; S.log('V.22: скремблированные единицы, продолжаю на 1200'); }
      else if(S.calling && (S.phase==='c_s1'||S.phase==='c_1200') && S.neg!==2400){ S.neg=1200; tx.sched={at:tx.n+V22_SYM(765),stage:'DATA'}; S.phase='c_1200'; S.log('V.22: отвечающий только 1200'); } }
    if(!S.rxReady){
      if(S.neg===2400 && rx.mode16 && S.rxn>=S.mode16At+V22_SYM(150) && S.ones>=32) S.rxReady=true;
      else if(S.neg===1200 && S.txData1200) S.rxReady=true; }
    if(S.neg===1200 && tx.stage==='DATA' && !S.txData1200){ S.txData1200=true; }
    if(!S.connected && tx.stage==='DATA' && S.rxReady){ S.connected=true; S.log('V.22'+(S.neg===2400?'bis 2400':' 1200')+': данные'); } };
  S.start=()=>{ if(S.calling){ tx.go('SIL'); S.phase='wait'; } else { tx.go('SIL'); tx.at(75,'U11'); S.phase='u11'; } };
  return S; }
