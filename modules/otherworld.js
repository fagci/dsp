"use strict";
/* ============================ Источники «не из этой реальности» ============================
   Синтетические сигналы, которых нет в эфире и в датчиках: странные аттракторы, слияние чёрных дыр,
   радиопульсар, резонанс Шумана, клеточный автомат. Всё считается в узле, ничего не принимается. */

// ---- Хаос: Лоренц / Рёсслер / Томас. Скорость — единиц времени аттрактора в секунду
const CHAOS_SYS={
  lorenz:{init:[1,1,1],  sc:[22,28,25], off:[0,0,25], dt:.004,
          f:(x,y,z)=>[10*(y-x), x*(28-z)-y, x*y-8/3*z]},
  rossler:{init:[1,1,0], sc:[12,12,15], off:[0,0,8],  dt:.01,
          f:(x,y,z)=>[-y-z, x+.2*y, .2+z*(x-5.7)]},
  thomas:{init:[1,.1,.1], sc:[4,4,4],   off:[0,0,0],  dt:.05,
          f:(x,y,z)=>[Math.sin(y)-.208186*x, Math.sin(z)-.208186*y, Math.sin(x)-.208186*z]},
};
function chaosStep(S,s,h){                           // RK4
  const f=S.f, k1=f(s[0],s[1],s[2]);
  const k2=f(s[0]+h/2*k1[0],s[1]+h/2*k1[1],s[2]+h/2*k1[2]);
  const k3=f(s[0]+h/2*k2[0],s[1]+h/2*k2[1],s[2]+h/2*k2[2]);
  const k4=f(s[0]+h*k3[0],s[1]+h*k3[1],s[2]+h*k3[2]);
  for(let i=0;i<3;i++) s[i]+=h/6*(k1[i]+2*k2[i]+2*k3[i]+k4[i]);
}
def({ id:'chaos', title:'Strange Attractor', cat:'Sources', kw:'chaos lorenz rossler thomas attractor butterfly',
  outs:[{n:'x',t:'sig'},{n:'y',t:'sig'},{n:'z',t:'sig'}],
  params:[{n:'sys',t:'select',opts:['lorenz','rossler','thomas'],d:'lorenz',label:'system',fn:n=>{ n.s=null; }},
          {n:'speed',t:'range',min:1,max:5000,step:1,d:300,log:true,label:'speed, attractor time / s'},
          {n:'amp',t:'range',min:0,max:1,step:.01,d:.5}],
  init:n=>{ n.s=null; },
  process(n){
    const S=CHAOS_SYS[n.p.sys]||CHAOS_SYS.lorenz;
    if(!n.s) n.s=S.init.slice();
    const ox=buf(n,'x'), oy=buf(n,'y'), oz=buf(n,'z');
    const h=n.p.speed/Eng.sr, sub=Math.max(1,Math.ceil(h/S.dt)), hs=h/sub, a=n.p.amp;
    for(let i=0;i<BLOCK;i++){
      for(let k=0;k<sub;k++) chaosStep(S,n.s,hs);
      if(!isFinite(n.s[0]+n.s[1]+n.s[2])) n.s=S.init.slice();
      ox[i]=(n.s[0]-S.off[0])/S.sc[0]*a; oy[i]=(n.s[1]-S.off[1])/S.sc[1]*a; oz[i]=(n.s[2]-S.off[2])/S.sc[2]*a;
    }
    return {x:ox,y:oy,z:oz}; }});

// ---- Слияние двойной чёрной дыры: чирп спирали (f ~ (tc−t)^-3/8, A ~ f^(2/3) — ньютоновское приближение),
//      затухающий звон, тишина, повтор. Учебная модель, не форма волны из численной относительности
def({ id:'gwave', title:'Black Hole Merger', cat:'Sources', kw:'gravitational wave ligo chirp inspiral merger black hole',
  outs:[{n:'out',t:'sig'},{n:'sync',t:'sig'}],
  params:[{n:'f0',t:'range',min:5,max:2000,step:1,d:35,log:true,label:'start frequency, Hz'},
          {n:'fmax',t:'range',min:20,max:8000,step:1,d:250,log:true,label:'merger frequency, Hz'},
          {n:'dur',t:'range',min:.1,max:30,step:.1,d:2,label:'inspiral duration, s'},
          {n:'gap',t:'range',min:0,max:30,step:.1,d:1.5,label:'silence between events, s'},
          {n:'noise',t:'range',min:0,max:1,step:.01,d:.05,label:'noise'},
          {n:'amp',t:'range',min:0,max:1,step:.01,d:.5}],
  init:n=>{ n.t=0; n.ph=0; },
  process(n){
    const o=buf(n,'out'), os=buf(n,'sync'), sr=Eng.sr;
    const f0=Math.min(n.p.f0,n.p.fmax*.99), fm=n.p.fmax, T=n.p.dur;
    const tm=T*(1-Math.pow(f0/fm,8/3));                // момент слияния: f достигает fmax
    const ring=.04, fr=fm*1.2, total=tm+ring*5+n.p.gap;   // звон ~1.2·f слияния (порядок величины для сравнимых масс)
    for(let i=0;i<BLOCK;i++){
      let v=0, mark=0;
      if(n.t<tm){
        const f=f0*Math.pow(1-n.t/T,-3/8);
        n.ph+=f/sr; v=Math.pow(f/fm,2/3)*Math.sin(2*Math.PI*n.ph);
      } else if(n.t<tm+ring*5){
        n.ph+=fr/sr; v=Math.exp(-(n.t-tm)/ring)*Math.sin(2*Math.PI*n.ph);
      }
      n.t+=1/sr; if(n.t>=total){ n.t=0; n.ph=0; mark=1; }
      o[i]=(v+(Math.random()*2-1)*n.p.noise)*n.p.amp; os[i]=mark;
    }
    return {out:o,sync:os}; }});

// ---- Радиопульсар: узкий импульс с периодом P, мерцание, пропуски (nulling), хвост рассеяния
def({ id:'pulsar', title:'Pulsar', cat:'Sources', kw:'pulsar neutron star radio pulse period scintillation',
  outs:[{n:'out',t:'sig'},{n:'sync',t:'sig'}],
  params:[{n:'period',t:'range',min:2,max:2000,step:1,d:714,log:true,label:'period, ms'},
          {n:'width',t:'range',min:.5,max:30,step:.5,d:4,label:'pulse width, % of period'},
          {n:'scint',t:'range',min:0,max:.5,step:.01,d:.2,label:'amplitude flicker (correlated)'},
          {n:'null',t:'range',min:0,max:.9,step:.01,d:.05,label:'missing pulses'},
          {n:'tail',t:'range',min:0,max:1,step:.01,d:.3,label:'scatter tail'},
          {n:'noise',t:'range',min:0,max:1,step:.01,d:.15,label:'noise'},
          {n:'amp',t:'range',min:0,max:1,step:.01,d:.6}],
  init:n=>{ n.ph=0; n.a=1; n.s=.5; n.y=0; n.nk=''; n.norm=1; },
  process(n){
    const o=buf(n,'out'), os=buf(n,'sync'), dph=1000/n.p.period/Eng.sr;
    const w=n.p.width/100/2.355, c=.15, k=n.p.tail>0 ? Math.exp(-1/(Eng.sr*n.p.period/1000*.3*n.p.tail)) : 0;
    const key=[n.p.period,n.p.width,n.p.tail,Eng.sr].join();
    if(key!==n.nk){ n.nk=key;                            // свёртка гауссова импульса с экспонентой: нормируем пик на 1
      let y=0, m=1e-9;
      for(let j=0,N=Math.min(Math.round(1/dph),400000);j<N;j++){ const d=(j*dph-c)/w; y=k*y+(1-k)*Math.exp(-.5*d*d); if(y>m) m=y; }
      n.norm=1/m; }
    for(let i=0;i<BLOCK;i++){
      n.ph+=dph; let mark=0;
      if(n.ph>=1){ n.ph-=1; mark=1;
        n.s=.8*n.s+.2*Math.random();                     // мерцание коррелировано от импульса к импульсу
        n.a=Math.random()<n.p.null ? 0 : 1-n.p.scint*n.s*2; }
      const d=(n.ph-c)/w, g=n.a*Math.exp(-.5*d*d);
      n.y=k*n.y+(1-k)*g;                                 // рассеяние в среде: экспоненциальный хвост
      o[i]=(n.y*n.norm+(Math.random()*2-1)*n.p.noise)*n.p.amp; os[i]=mark;
    }
    return {out:o,sync:os}; }});

// ---- Резонанс Шумана: полость Земля–ионосфера, пять мод, молнии толкают резонаторы
const SCHU_F=[7.83,14.3,20.8,27.3,33.8], SCHU_Q=[4,5,5.5,6,6.5], SCHU_G=[1,.8,.6,.45,.3];
def({ id:'schumann', title:'Schumann Resonance', cat:'Sources', kw:'schumann resonance earth ionosphere lightning elf',
  outs:[{n:'out',t:'sig'}],
  params:[{n:'scale',t:'range',min:1,max:100,step:.1,d:1,log:true,label:'frequency ×  (raise it to hear it)'},
          {n:'rate',t:'range',min:0,max:100,step:.5,d:20,label:'lightning, strikes / s'},
          {n:'hiss',t:'range',min:0,max:1,step:.01,d:.3,label:'background noise'},
          {n:'amp',t:'range',min:0,max:1,step:.01,d:.5}],
  init:n=>{ n.y1=new Float64Array(5); n.y2=new Float64Array(5); n.peak=1e-6; },
  process(n){
    const o=buf(n,'out'), sr=Eng.sr, p=n.p, y1=n.y1, y2=n.y2;
    const a1=[], a2=[];
    for(let m=0;m<5;m++){ const f=SCHU_F[m]*p.scale, r=Math.exp(-Math.PI*f/SCHU_Q[m]/sr), w=2*Math.PI*f/sr;
      a1.push(2*r*Math.cos(w)); a2.push(-r*r); }
    const pHit=p.rate/sr;
    for(let i=0;i<BLOCK;i++){
      const hit=Math.random()<pHit ? (Math.random()*2-1)*40 : 0;
      let s=0;
      for(let m=0;m<5;m++){
        const x=((Math.random()*2-1)*p.hiss*.05+hit*(.5+Math.random()*.5))*SCHU_G[m]*SCHU_F[m]*p.scale/sr*40;
        const y=a1[m]*y1[m]+a2[m]*y2[m]+x; y2[m]=y1[m]; y1[m]=y; s+=y; }
      o[i]=s;
    }
    let pk=0; for(let i=0;i<BLOCK;i++) pk=Math.max(pk,Math.abs(o[i]));
    n.peak=Math.max(pk,n.peak*.9995,1e-6);               // медленная АРУ, чтобы уровень не зависел от параметров
    const g=p.amp/n.peak; for(let i=0;i<BLOCK;i++) o[i]*=g;
    return {out:o}; }});

// ---- Клеточный автомат Вольфрама: кольцо из N клеток, шаг с частотой rate. Правило 30 — генератор случайных бит
def({ id:'cellauto', title:'Cellular Automaton', cat:'Sources', kw:'cellular automaton wolfram rule 30 110 random bits',
  outs:[{n:'out',t:'sig'},{n:'bit',t:'num'},{n:'fill',t:'num'}],
  params:[{n:'rule',t:'range',min:0,max:255,step:1,d:30,label:'rule (30 — chaos, 110 — universal, 90 — Sierpinski)'},
          {n:'cells',t:'range',min:8,max:512,step:1,d:64,label:'cells'},
          {n:'rate',t:'range',min:1,max:20000,step:1,d:2000,log:true,label:'steps / s'},
          {n:'amp',t:'range',min:0,max:1,step:.01,d:.5},
          {n:'reset',t:'button',label:'Reset',fn:n=>{ n.c=null; }}],
  init:n=>{ n.c=null; n.ph=0; n.bit=0; n.fill=0; },
  process(n){
    const N=Math.round(n.p.cells), o=buf(n,'out'), rule=Math.round(n.p.rule), dph=n.p.rate/Eng.sr, mid=N>>1;
    if(!n.c || n.c.length!==N){ n.c=new Uint8Array(N); n.c[mid]=1; n.nx=new Uint8Array(N); }
    for(let i=0;i<BLOCK;i++){
      n.ph+=dph;
      while(n.ph>=1){ n.ph-=1;
        const c=n.c, nx=n.nx; let sum=0;
        for(let j=0;j<N;j++){
          nx[j]=(rule>>((c[(j+N-1)%N]<<2)|(c[j]<<1)|c[(j+1)%N]))&1; sum+=nx[j]; }
        n.c=nx; n.nx=c; n.bit=n.c[mid]; n.fill=sum/N; }
      o[i]=(n.bit*2-1)*n.p.amp;
    }
    return {out:o,bit:n.bit,fill:n.fill}; }});
