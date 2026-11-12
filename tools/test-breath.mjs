// Ядро Breath Pacer: node tools/test-breath.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Number,Array,isFinite});
vm.runInContext(fs.readFileSync(path.join(root,'modules/breath-kernels.js'),'utf8')+';this.K={bpcPlan,bpcAt,bpcLabel};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(a,b,e=1e-6)=>Math.abs(a-b)<e;

// 4-7-8: цикл 19 с
{ const p=K.bpcPlan({inhale:4,hold:7,exhale:8,hold2:0,sip:0});
  ok('4-7-8: длина цикла 19 с',near(p.T,19));
  const a0=K.bpcAt(p,0), a2=K.bpcAt(p,2), a4=K.bpcAt(p,4), a8=K.bpcAt(p,8), a11=K.bpcAt(p,11), a15=K.bpcAt(p,15), a19=K.bpcAt(p,19);
  ok('старт: лёгкие пусты, фаза «вдох»',near(a0.lung,0) && a0.phase===0 && a0.cycle===1);
  ok('середина вдоха: наполнение 0,5',near(a2.lung,.5));
  ok('задержка на вдохе: лёгкие полны, фаза 1',near(a4.lung,1) && a4.phase===1 && near(a8.lung,1));
  ok('выдох начинается на 11 с, фаза 2',a11.phase===2 && near(a11.lung,1));
  ok('середина выдоха: 0,5',near(a15.lung,.5));
  ok('19 с — второй цикл с нуля',a19.cycle===2 && near(a19.lung,0) && a19.phase===0); }

// box 4-4-4-4: четыре фазы по 4 с
{ const p=K.bpcPlan({inhale:4,hold:4,exhale:4,hold2:4,sip:0});
  ok('box: T = 16',near(p.T,16));
  ok('box: фазы 0,1,2,3 по порядку',[1,5,9,13].map(t=>K.bpcAt(p,t).phase).join('')==='0123');
  ok('box: пауза на выдохе — пусто',near(K.bpcAt(p,14).lung,0)); }

// физиологический вздох: вдох 2 + досып 1, выдох 6
{ const p=K.bpcPlan({inhale:2,hold:0,exhale:6,hold2:0,sip:1});
  ok('sigh: T = 9',near(p.T,9));
  ok('sigh: после первого вдоха лёгкие ~78%',near(K.bpcAt(p,2).lung,.78,1e-6));
  ok('sigh: после досыпа полны',near(K.bpcAt(p,3).lung,1));
  ok('sigh: оба вдоха — фаза «вдох» (0)',K.bpcAt(p,1).phase===0 && K.bpcAt(p,2.5).phase===0);
  ok('sigh: подпись второго вдоха «Sip in»',K.bpcLabel(K.bpcAt(p,2.4)).startsWith('Sip in'));
  let mono=true, prev=0; for(let t=0;t<3;t+=.01){ const l=K.bpcAt(p,t).lung; if(l<prev-1e-9) mono=false; prev=l; }
  ok('sigh: наполнение не падает на вдохе',mono); }

// подписи и отсчёт
{ const p=K.bpcPlan({inhale:4,hold:0,exhale:6,hold2:0,sip:0});
  ok('подпись в начале: Inhale 4',K.bpcLabel(K.bpcAt(p,0))==='Inhale 4',K.bpcLabel(K.bpcAt(p,0)));
  ok('подпись через 1,5 с: Inhale 3',K.bpcLabel(K.bpcAt(p,1.5))==='Inhale 3');
  ok('подпись выдоха: Exhale 6',K.bpcLabel(K.bpcAt(p,4))==='Exhale 6');
  ok('rate = 60/T: 6 вдохов в минуту',near(60/p.T,6)); }

// непрерывность и границы на разных ритмах
{ const pats=[{inhale:5.5,exhale:5.5},{inhale:4,hold:7,exhale:8},{inhale:2,sip:1,exhale:6},{inhale:2,exhale:4},{inhale:4,hold:4,exhale:4,hold2:4},{inhale:1,exhale:1}];
  for(const q of pats){ const p=K.bpcPlan(q); let mx=0, prev=null, inR=true;
    for(let t=0;t<p.T*3;t+=.01){ const l=K.bpcAt(p,t).lung; if(!(l>=-1e-9 && l<=1+1e-9)) inR=false; if(prev!=null) mx=Math.max(mx,Math.abs(l-prev)); prev=l; }
    ok(`${JSON.stringify(q)}: lung в 0…1 и без скачков (макс шаг ${mx.toFixed(3)})`,inR && mx<.07,mx); } }

// вырожденные входы
{ const z=K.bpcPlan({inhale:0,hold:0,exhale:0,hold2:0,sip:0});
  ok('все нули → запасной ритм 5+5 с',near(z.T,5) && near(K.bpcAt(z,2.5).lung,1));
  const g=K.bpcPlan({inhale:NaN,hold:-3,exhale:'abc',hold2:undefined,sip:null});
  ok('мусор на входе → запасной ритм',near(g.T,5));
  const t=K.bpcPlan({inhale:.2,exhale:.3});
  ok('слишком быстрый ритм (<1 с) → запасной',near(t.T,5));
  ok('отрицательное время = начало',near(K.bpcAt(K.bpcPlan({inhale:4,exhale:6}),-5).lung,0));
  ok('очень большое t не ломает',Number.isFinite(K.bpcAt(K.bpcPlan({inhale:4,exhale:6}),1e7).lung)); }

console.log(bad?'FAILED':'all ok'); process.exit(bad?1:0);
