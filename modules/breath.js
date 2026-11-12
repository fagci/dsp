"use strict";
/* ============================ Breath Pacer ============================
   Дыхательный пейсер: вдох → (досып) → задержка → выдох → задержка. Круг на узле растёт на вдохе и сжимается на выдохе, внутри — фаза и
   секунды до её конца. Мягкий тон-подсказка (высота следует за наполнением лёгких) позволяет дышать с закрытыми глазами.
   Ритм берётся из полей или с проводов — например, из выбранной строки Table (inhale / hold / exhale / hold2 / sip / dur).
   Выходы lung / swell (0…1) ведут громкость Noise Generator («прибой» дышит вместе с вами), tick — импульс на смене фазы, done — сессия кончилась.
   Не лечебный прибор: при головокружении дышите как обычно. Ядро — modules/breath-kernels.js (tools/test-breath.mjs). */

const bpcFmt=s=>{ s=Math.max(0,Math.round(s)); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); };
const bpcPattern=p=>[p.inhale,p.sip>0?'+'+p.sip:null,p.hold>0?p.hold:null,p.exhale,p.hold2>0?p.hold2:null].filter(v=>v!=null&&v!==0).join('-');

def({ id:'breath', title:'Breath Pacer', cat:'Sources', w:260, resize:true, view:{h:150}, readout:true,
  kw:'breathing breath inhale exhale hold box 4-7-8 resonance coherent physiological sigh relax calm stress pacer timer meditation health',
  outs:[{n:'lung',t:'num'},{n:'swell',t:'num'},{n:'phase',t:'num'},{n:'left',t:'num'},{n:'cycle',t:'num'},{n:'tick',t:'num'},{n:'done',t:'num'},{n:'rate',t:'num'},{n:'cue',t:'sig'}],
  ins:[{n:'inhale',t:'num'},{n:'hold',t:'num'},{n:'exhale',t:'num'},{n:'hold2',t:'num'},{n:'sip',t:'num'},{n:'dur',t:'num'}],
  params:[
    {n:'inhale',t:'range',min:0,max:20,step:.1,d:5.5,label:'inhale, s'},
    {n:'sip',t:'range',min:0,max:5,step:.1,d:0,label:'second sniff, s',tip:'a short top-up inhale on top of the first one (physiological sigh); 0 — off'},
    {n:'hold',t:'range',min:0,max:30,step:.1,d:0,label:'hold (lungs full), s'},
    {n:'exhale',t:'range',min:0,max:30,step:.1,d:5.5,label:'exhale, s'},
    {n:'hold2',t:'range',min:0,max:30,step:.1,d:0,label:'hold (lungs empty), s'},
    {n:'dur',t:'range',min:0,max:3600,step:5,d:0,label:'session, s (0 — endless)'},
    {n:'run',t:'check',d:true},
    {n:'restart',t:'button',label:'Restart',fn:n=>{ n.t=0; n.done=false; }},
    {n:'cue',t:'check',d:true,label:'sound cue',tip:'a soft tone that rises while you inhale and falls while you exhale'},
    {n:'cueVol',t:'range',min:0,max:1,step:.01,d:.25,label:'cue volume',if:n=>n.p.cue},
    {n:'pitch',t:'range',min:80,max:600,step:1,d:220,log:true,label:'cue pitch, Hz',if:n=>n.p.cue},
    {n:'floor',t:'range',min:0,max:1,step:.01,d:.3,label:'swell floor',tip:'swell = floor + (1 − floor) · lung: the level a wired Noise Generator drops to when the lungs are empty'},
  ],
  init:n=>{ n.t=0; n.done=false; n.key=''; n.plan=null; n.ls=0; n.idx=-1; n.cph=0; n.cg=0; n.a=null; },
  process(n,I){
    const p=n.p, dt=BLOCK/Eng.sr;
    for(const k of ['inhale','hold','exhale','hold2','sip','dur']) if(typeof I[k]==='number' && isFinite(I[k])) setMod(n,k,I[k]);
    const key=[p.inhale,p.hold,p.exhale,p.hold2,p.sip].join('|');
    if(key!==n.key){ n.key=key; n.plan=bpcPlan(p); n.t=0; n.done=false; n.idx=-1; }       // другой ритм (строка таблицы) — сначала
    if(p.run && !n.done){
      n.t+=dt;
      if(p.dur>0 && n.t>=p.dur){ n.done=true; n.t=p.dur; }
    }
    const a=bpcAt(n.plan,n.t); n.a=a;
    const target=n.done||!p.run&&n.t===0 ? 0 : a.lung;
    n.ls+=(target-n.ls)*(1-Math.exp(-dt/.12));
    const id=n.done ? -2 : a.idx+1000*a.cycle;
    const tick=id!==n.idx && n.idx!==-1 ? 1 : 0; n.idx=id;
    const cue=buf(n,'cue');
    if(p.cue && p.run && !n.done || n.cg>1e-4){
      const gT=p.cue && p.run && !n.done ? p.cueVol*(a.phase===0||a.phase===2 ? 1 : .15) : 0;
      const kg=1-Math.exp(-1/(Eng.sr*.25)), sr=Eng.sr;
      for(let i=0;i<BLOCK;i++){
        n.cg+=(gT-n.cg)*kg;
        const f=p.pitch*Math.pow(2,n.ls*.5);                                 // от тона до квинты выше: лёгкие полны — тон выше
        n.cph+=6.2831853*f/sr; if(n.cph>6.2831853) n.cph-=6.2831853;
        cue[i]=(Math.sin(n.cph)+.25*Math.sin(2*n.cph))*n.cg*.5; }
    } else cue.fill(0);
    return {lung:n.ls, swell:p.floor+(1-p.floor)*n.ls, phase:a.phase, left:a.left, cycle:a.cycle, tick, done:n.done?1:0, rate:60/n.plan.T, cue}; },
  draw(n,cv,cx){
    const a=n.a, p=n.p;
    const W=cv.width, H=cv.height;
    if(!a || !W) return;
    cx.clearRect(0,0,W,H);
    const cxm=W/2, cym=H/2, rm=Math.min(W,H)/2-6, r0=rm*.38, r=r0+(rm*.92-r0)*n.ls;
    cx.lineWidth=2; cx.strokeStyle=themeColor('--grid');
    cx.beginPath(); cx.arc(cxm,cym,rm,0,6.2832); cx.stroke();                 // внешнее кольцо — предел вдоха
    if(p.dur>0){                                                              // прогресс сессии дугой
      cx.strokeStyle=themeColor('--acc'); cx.lineWidth=3; cx.beginPath();
      cx.arc(cxm,cym,rm,-Math.PI/2,-Math.PI/2+6.2832*Math.min(1,n.t/p.dur)); cx.stroke(); }
    cx.fillStyle=themeRgba('--acc2',.28); cx.strokeStyle=themeColor('--acc2'); cx.lineWidth=2;
    cx.beginPath(); cx.arc(cxm,cym,r,0,6.2832); cx.fill(); cx.stroke();
    cx.fillStyle=themeColor('--txt'); cx.textAlign='center'; cx.textBaseline='middle';
    const fs=Math.max(11,Math.min(W/9,H/7));
    cx.font=`600 ${fs}px sans-serif`;
    cx.fillText(n.done ? 'Done' : !p.run ? 'Paused' : bpcLabel(a), cxm, cym-fs*.3);
    cx.font=`${Math.max(9,fs*.55)}px sans-serif`; cx.fillStyle=themeColor('--axis');
    cx.fillText(`cycle ${a.cycle} · ${(60/n.plan.T).toFixed(1)}/min`, cxm, cym+fs*.75);
    roText(n,bpcPattern(p)+(p.dur>0 ? ' · '+bpcFmt(p.dur-n.t)+' left' : '')); }});
