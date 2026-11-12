"use strict";
/* ======================= BREATH PACER — ядро ======================= */
// Ритм дыхания без DOM: node tools/test-breath.mjs.
// Цикл = вдох → (досып) → задержка → выдох → задержка. «Досып» (sip) — второй короткий вдох поверх первого
// (физиологический вздох: два вдоха носом и долгий выдох). lung — наполнение лёгких 0…1, плавное (косинусные переходы).

const BPC_PHASES=['Inhale','Hold','Exhale','Hold'];           // индекс = код фазы: 0 вдох, 1 пауза на вдохе, 2 выдох, 3 пауза на выдохе
const BPC_SIP=.78;                                             // до какой доли наполнения доходит первый вдох, если есть досып

// p: {inhale, hold, exhale, hold2, sip} в секундах → {segs:[{ph, k, d, a, b}], T}
function bpcPlan(p){
  const f=v=>{ v=+v; return isFinite(v)&&v>0 ? v : 0; };
  const inh=f(p.inhale), hold=f(p.hold), exh=f(p.exhale), hold2=f(p.hold2), sip=f(p.sip);
  const segs=[];
  if(inh) segs.push({ph:0,k:'in',d:inh,a:0,b:sip?BPC_SIP:1});
  if(sip) segs.push({ph:0,k:'sip',d:sip,a:inh?BPC_SIP:0,b:1});
  if(hold) segs.push({ph:1,k:'hold',d:hold,a:1,b:1});
  if(exh) segs.push({ph:2,k:'out',d:exh,a:1,b:0});
  if(hold2) segs.push({ph:3,k:'hold2',d:hold2,a:0,b:0});
  let T=segs.reduce((s,x)=>s+x.d,0);
  if(T<1){ segs.length=0; segs.push({ph:0,k:'in',d:2.5,a:0,b:1},{ph:2,k:'out',d:2.5,a:1,b:0}); T=5; }   // пустой/вырожденный ритм → 6 вдохов в минуту
  return {segs,T};
}

// состояние в момент t (секунды от начала сессии): lung, phase, k, left (до конца фазы), u (доля фазы), cycle (номер, с 1), idx
function bpcAt(plan,t){
  t=Math.max(0,t);
  const cycle=Math.floor(t/plan.T), tc=t-cycle*plan.T;
  let acc=0, i=0;
  for(;i<plan.segs.length-1;i++){ if(tc<acc+plan.segs[i].d) break; acc+=plan.segs[i].d; }
  const s=plan.segs[i], u=Math.min(1,Math.max(0,(tc-acc)/s.d));
  const lung=s.a===s.b ? s.a : s.a+(s.b-s.a)*(.5-.5*Math.cos(Math.PI*u));
  return {lung, phase:s.ph, k:s.k, left:Math.max(0,s.d*(1-u)), u, cycle:cycle+1, idx:i};
}

// подпись фазы и отсчёт секунд до её конца: «Inhale 3»
function bpcLabel(a){
  const name=a.k==='sip' ? 'Sip in' : BPC_PHASES[a.phase];
  return name+' '+Math.ceil(a.left-1e-9);
}
