"use strict";
/* ======================= NOISE GENERATOR — ядро ======================= */
// Цветные шумы и генеративные звуки без DOM: node tools/test-noisegen.mjs.
// Шумы: white / pink / brown / blue / violet (наклон спектра 0 / −3 / −6 / +3 / +6 дБ на октаву, без эквалайзера — просто уровни).
// Генеративные: rain, waves, wind, chimes (случайные колокольчики в строе), heart (сердцебиение), tone (бинауральный / монауральный / изохронный).
// Всё синтезируется на месте, без выборок и сети; seed даёт повторяемый результат. Выход — стереопара L/R.

const NSG_KEYS=['white','pink','brown','blue','violet','rain','waves','wind','chimes','heart','tone'];
const NSG_SCALES={'pentatonic':[0,2,4,7,9],'minor pentatonic':[0,3,5,7,10],'lydian':[0,2,4,6,7,9,11],'whole tone':[0,2,4,6,8,10],'hirajoshi':[0,2,3,7,8]};
const NSG_MODES=['binaural','monaural','isochronic'];
// усиление источников: при уровне 1 каждый даёт примерно −14 дБFS (RMS ≈ 0,2) — подобрано замером (tools/test-noisegen.mjs)
const NSG_N={pink:.564,blue:1.69,rain:2.2,waves:3,wind:11};          // нормировка слоёв до равной громкости
const NSG_G={white:.2,pink:.2,brown:.2,blue:.2,violet:.2,rain:.2,waves:.2,wind:.2,chimes:.35,heart:.55,tone:.3};

function nsgRng(seed){
  let a=(seed>>>0)||1;
  return ()=>{ a=(a+0x6D2B79F5)>>>0; let t=a; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; };
}

function nsgEar(){
  return {b:[0,0,0,0,0,0,0], br:0, pp:0, wp:0,                 // pink (Kellet), brown, предыдущий pink (blue) и white (violet)
    re:0, re2:0, rw:0, rl:0, rh1:0, rh2:0,                      // дождь
    wb:0, wf1:0, wf2:0,                                         // волны
    sl:0, sb:0};                                                // ветер: ФНЧ и полоса фильтра с переменными состояниями
}
function nsgInit(sr,seed){
  const lv={}; for(const k of NSG_KEYS) lv[k]=0;
  return {sr, rnd:nsgRng(seed), ear:[nsgEar(),nsgEar()], lv, t:0,
    gust:0, gustT:0, gustNext:0,
    voices:[], hbPh:0, tPl:0, tPr:0, tPc:0, tGate:0, cf:null, bf:null, pulsePh:0, v0:null};
}

const NSG_SQ3=Math.sqrt(3);
// один отсчёт одного уха: сумма шумов и «природных» слоёв (без сердца, колокольчиков и тона)
function nsgEarSample(S,e,P,lv,ei,k){
  const rnd=S.rnd, sr=S.sr;
  let o=0;
  const wu=(rnd()*2-1)*NSG_SQ3;                                  // белый, дисперсия 1
  if(lv.white>1e-4) o+=wu*lv.white*NSG_G.white;
  if(lv.pink>1e-4 || lv.blue>1e-4){
    const b=e.b, w=rnd()*2-1;
    b[0]=.99886*b[0]+w*.0555179; b[1]=.99332*b[1]+w*.0750759; b[2]=.969*b[2]+w*.153852;
    b[3]=.8665*b[3]+w*.3104856; b[4]=.55*b[4]+w*.5329522; b[5]=-.7616*b[5]-w*.016898;
    const p=(b[0]+b[1]+b[2]+b[3]+b[4]+b[5]+b[6]+w*.5362)*k.pink; b[6]=w*.115926;
    if(lv.pink>1e-4) o+=p*lv.pink*NSG_G.pink;
    if(lv.blue>1e-4) o+=(p-e.pp)*k.blue*lv.blue*NSG_G.blue;
    e.pp=p;
  }
  if(lv.brown>1e-4){ e.br=k.ba*e.br+wu; o+=e.br*k.bn*lv.brown*NSG_G.brown; }
  if(lv.violet>1e-4){ o+=(wu-e.wp)*.70710678*lv.violet*NSG_G.violet; }
  e.wp=wu;
  if(lv.rain>1e-4){                                              // капли: короткие всплески шума + «плюхи» + шипение
    if(rnd()<k.pDrop) e.re+=.35+.65*rnd();
    if(rnd()<k.pDrop*.15) e.re2+=.5+.5*rnd();
    const w=rnd()*2-1;
    e.re*=k.rd1; e.re2*=k.rd2;
    e.rl+=.12*(w-e.rl);
    e.rh1+=.35*(w-e.rh1); e.rh2+=.03*(e.rh1-e.rh2);
    o+=((w-e.rw)*e.re*.9+e.rl*e.re2*3.5+(e.rh1-e.rh2)*.6)*lv.rain*NSG_G.rain*k.rainN;
    e.rw=w;
  }
  if(lv.waves>1e-4){                                             // шум, раздуваемый медленным приливом; на гребне — пена
    const ph=S.t/k.period+(ei?.06:0);
    let env=.5+.5*(.7*Math.sin(6.2831853*ph)+.3*Math.sin(3.8832*ph+1.3));
    env=env<0?0:env>1?1:env; env*=env;
    const w=rnd()*2-1;
    e.wb=k.wa*e.wb+w; e.wf1+=.25*(w-e.wf1); e.wf2+=.02*(e.wf1-e.wf2);
    o+=(e.wb*k.wn*(.2+.8*env)+(e.wf1-e.wf2)*env*env*env*1.6)*lv.waves*NSG_G.waves*k.waveN;
  }
  if(lv.wind>1e-4){                                              // белый шум через полосу, частота которой плавает с порывами
    const w=rnd()*2-1, g=S.gust, f=2*Math.sin(3.14159265*(220+900*g)/sr);
    e.sl+=f*e.sb; const hi=w-e.sl-.9*e.sb; e.sb+=f*hi;
    o+=e.sb*(.3+.9*g*g)*lv.wind*NSG_G.wind*k.windN;
  }
  return o;
}

// P: уровни по NSG_KEYS (0…1) и vol, width, mode, carrier, beat, pulse, depth, bpm, density, period, rate (колокольчиков в минуту), scale, root
// пишет N отсчётов в oL / oR
function nsgRender(S,P,oL,oR,N){
  const sr=S.sr, dt=1/sr, rnd=S.rnd, lv=S.lv, TP=6.2831853;
  const kl=1-Math.exp(-dt/.05), kg=1-Math.exp(-dt/.5), kgust=1-Math.exp(-dt/1.3);
  const ba=Math.exp(-TP*25*dt);
  const k={pink:1,blue:1,ba,bn:Math.sqrt(1-ba*ba),
    pDrop:Math.max(0,P.density||0)*dt, rd1:Math.exp(-dt/.0025), rd2:Math.exp(-dt/.012), rainN:NSG_N.rain,
    period:Math.max(2,P.period||9), wa:Math.exp(-TP*40*dt), wn:0, waveN:NSG_N.waves, windN:NSG_N.wind};
  k.wn=Math.sqrt(1-k.wa*k.wa);
  k.pink=NSG_N.pink; k.blue=NSG_N.blue;
  const w=Math.min(1,Math.max(0,P.width==null?1:P.width));
  const vol1=P.vol==null?1:P.vol, vol0=S.v0==null?vol1:S.v0; S.v0=vol1;
  const car=Math.max(20,P.carrier||200), bt=Math.max(0,P.beat||0), mode=P.mode||'binaural';
  if(S.cf==null){ S.cf=car; S.bf=bt; }
  const pulse=Math.max(0,P.pulse||0), depth=Math.min(1,Math.max(0,P.depth==null?.5:P.depth));
  const bpm=Math.min(200,Math.max(20,P.bpm||60)), rate=Math.max(0,P.rate||0)/60;
  const sc=NSG_SCALES[P.scale]||NSG_SCALES.pentatonic, root=P.root==null?60:P.root;
  const tgt={}; for(const key of NSG_KEYS) tgt[key]=Math.min(1,Math.max(0,P[key]||0));
  const rec=S.ear[0], rer=S.ear[1];
  for(let i=0;i<N;i++){
    for(let j=0;j<11;j++){ const key=NSG_KEYS[j]; lv[key]+=(tgt[key]-lv[key])*kl; }
    S.t+=dt;
    if(lv.wind>1e-4 || tgt.wind>0){                              // порывы: новая цель раз в 1,5…5 с, ход к ней плавный
      if(S.t>=S.gustNext){ S.gustT=rnd(); S.gustNext=S.t+1.5+3.5*rnd(); }
      S.gust+=(S.gustT-S.gust)*kgust;
    }
    let l=nsgEarSample(S,rec,P,lv,0,k), r=nsgEarSample(S,rer,P,lv,1,k);
    if(w<1){ const m=(l+r)*.70710678; l=m+(l-m)*w; r=m+(r-m)*w; }     // width 0 — моно, 1 — независимые уши
    if(pulse>0){                                                 // медленная амплитудная пульсация подложки (изохронный шум)
      S.pulsePh+=pulse*dt; if(S.pulsePh>=1) S.pulsePh-=1;
      const g=1-depth*(.5-.5*Math.cos(TP*S.pulsePh)); l*=g; r*=g; }
    if(lv.chimes>1e-4 || S.voices.length){
      if(lv.chimes>1e-4 && rnd()<rate*dt){                       // новая нота в строе
        const oc=rnd(), d=sc[(rnd()*sc.length)|0], m=root+d+12*(oc<.4?0:oc<.8?1:2);
        const f=440*Math.pow(2,(m-69)/12), tau=1.6+2.4*rnd(), pan=(rnd()*2-1)*.8, a=.25+.5*rnd();
        if(S.voices.length>=10) S.voices.shift();
        S.voices.push({f, ph:[0,0,0,0], e:[1,1,1,1], at:0, a, gl:Math.cos((pan+1)*Math.PI/4), gr:Math.sin((pan+1)*Math.PI/4),
          d:[Math.exp(-dt/tau), Math.exp(-dt/(tau*.6)), Math.exp(-dt/(tau*.35)), Math.exp(-dt/(tau*.2))]});
      }
      const R=NSG_BELL_R, A=NSG_BELL_A;
      for(let v=S.voices.length-1;v>=0;v--){
        const o=S.voices[v];
        let s=0;
        for(let q=0;q<4;q++){
          o.ph[q]+=TP*o.f*R[q]*dt; if(o.ph[q]>TP) o.ph[q]-=TP;
          s+=Math.sin(o.ph[q])*A[q]*o.e[q]; o.e[q]*=o.d[q]; }
        o.at+=(1-o.at)*.007;
        s*=o.a*o.at*lv.chimes*NSG_G.chimes;
        l+=s*o.gl; r+=s*o.gr;
        if(o.e[0]<1e-4) S.voices.splice(v,1);
      }
    }
    if(lv.heart>1e-4){                                           // «тук-тук»: низкие затухающие синусы, второй тише и ближе при частом пульсе
      S.hbPh+=bpm/60*dt; if(S.hbPh>=1) S.hbPh-=1;
      const period=60/bpm, tb=S.hbPh*period, td=tb-Math.min(.3,.4*period);
      let h=(1-Math.exp(-tb/.006))*Math.exp(-tb/.055)*Math.sin(TP*52*tb);
      if(td>0) h+=.75*(1-Math.exp(-td/.006))*Math.exp(-td/.045)*Math.sin(TP*66*td);
      h*=lv.heart*NSG_G.heart; l+=h; r+=h;
    }
    if(lv.tone>1e-4){                                            // несущая и разность частот плавно «едут» к цели (смена строки таблицы без щелчков)
      S.cf+=(car-S.cf)*kg; S.bf+=(bt-S.bf)*kg;
      const g=lv.tone*NSG_G.tone;
      if(mode==='isochronic'){
        S.tPc+=TP*S.cf*dt; if(S.tPc>TP) S.tPc-=TP;
        S.tGate+=S.bf*dt; if(S.tGate>=1) S.tGate-=1;
        const s=Math.sin(S.tPc)*(.5-.5*Math.cos(TP*S.tGate))*g; l+=s; r+=s;
      } else {
        S.tPl+=TP*(S.cf-S.bf/2)*dt; if(S.tPl>TP) S.tPl-=TP;
        S.tPr+=TP*(S.cf+S.bf/2)*dt; if(S.tPr>TP) S.tPr-=TP;
        const a=Math.sin(S.tPl), b=Math.sin(S.tPr);
        if(mode==='monaural'){ const s=(a+b)*.5*g; l+=s; r+=s; }
        else { l+=a*g; r+=b*g; }                                 // binaural: каждому уху — своя частота
      }
    }
    const vg=vol0+(vol1-vol0)*(i+1)/N;
    oL[i]=Math.tanh(l*vg); oR[i]=Math.tanh(r*vg);                // мягкий предел вместо жёсткого клиппинга
  }
}
const NSG_BELL_R=[1,2.76,5.4,8.93], NSG_BELL_A=[1,.45,.2,.08];
