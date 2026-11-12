"use strict";
/* ============================ Sleep Timer ============================
   Таймер сна: звук (L / R) идёт через узел, через «sleep after» минут громкость плавно гаснет за «fade-out» секунд, а в конце узел
   останавливает (или ставит на паузу) звуковой движок — граф перестаёт считать, микрофон отпускается, батарея не тратится.
   Старт: сам при запуске движка (auto), кнопкой, или сигналом на вход start — например, от Trigger Clock в режиме schedule («23:00», зона local).
   Выход gain (1 → 0) можно отдать куда угодно, left — секунд до конца, done — 1 после конца. «+10 min» продлевает и возвращает громкость.
   Ядро — modules/sleep-kernels.js (tools/test-sleep.mjs). */

function slpStart(n){ n.run=true; n.done=false; n.left=Math.max(1,n.p.min)*60; n.total=n.left; n.endAt=0; }
function slpCancel(n){ n.run=false; n.done=false; n.left=Math.max(1,n.p.min)*60; n.total=n.left; n.endAt=0; }

def({ id:'sleeptimer', title:'Sleep Timer', cat:'Output', w:240, readout:true,
  kw:'sleep timer fade out volume stop pause turn off night shutdown schedule relax bedtime таймер сна',
  ins:[{n:'L',t:'sig'},{n:'R',t:'sig'},{n:'start',t:'num'},{n:'min',t:'num'}],
  outs:[{n:'L',t:'sig'},{n:'R',t:'sig'},{n:'gain',t:'num'},{n:'left',t:'num'},{n:'frac',t:'num'},{n:'done',t:'num'}],
  params:[
    {n:'min',t:'range',min:1,max:480,step:1,d:30,label:'sleep after, min'},
    {n:'fade',t:'range',min:5,max:900,step:5,d:120,log:true,label:'fade-out, s'},
    {n:'curve',t:'select',opts:SLP_CURVES,d:'quadratic',label:'fade curve'},
    {n:'action',t:'select',opts:['stop sound','pause sound','nothing'],d:'stop sound',label:'at the end',tip:'stop sound: the engine stops (nothing is computed, the microphone is released); pause: Play resumes the same graph; nothing: only fade to silence'},
    {n:'auto',t:'check',d:true,label:'start with the engine',tip:'count from the moment sound starts; off — wait for the button or the start input'},
    {n:'go',t:'button',label:'Start / restart',fn:n=>slpStart(n)},
    {n:'extend',t:'button',label:'+10 min',fn:n=>{ if(!n.run && !n.done) slpStart(n); n.done=false; n.run=true; n.left+=600; n.total=Math.max(n.total||0,n.left); }},
    {n:'cancel',t:'button',label:'Cancel',fn:n=>slpCancel(n)},
  ],
  init:n=>{ n.run=false; n.done=false; n.left=null; n.total=0; n.g=1; n.sv=0; n.armed=true; n.endAt=0; },
  process(n,I){
    const p=n.p, dt=BLOCK/Eng.sr;
    if(typeof I.min==='number' && isFinite(I.min)) setMod(n,'min',I.min);
    if(n.left===null) slpCancel(n);
    const sv=typeof I.start==='number' && I.start>=.5 ? 1 : 0;
    if(sv && !n.sv) slpStart(n);                                 // фронт сигнала — старт сначала (Trigger Clock по расписанию)
    n.sv=sv;
    if(n.done && p.action!=='nothing' && n.endAt && performance.now()-n.endAt>3000){ slpCancel(n); n.armed=true; }   // движок снова запущен — новая ночь
    if(n.armed && p.auto && !n.run && !n.done){ slpStart(n); }
    n.armed=false;
    if(n.run){
      n.left-=dt;
      if(n.left<=0){ n.left=0; n.run=false; n.done=true; n.endAt=performance.now();
        if(p.action==='stop sound') setTimeout(()=>{ if(Eng.running) Eng.stop(); },0);
        else if(p.action==='pause sound') setTimeout(()=>{ if(Eng.running && !Eng.paused) Eng.toggle(); },0); }
    }
    const g1=n.done ? 0 : n.run ? slGain(n.left,p.fade,p.curve) : 1, g0=n.g; n.g=g1;
    const oL=buf(n,'L'), oR=buf(n,'R'), L=I.L, R=I.R;
    for(let i=0;i<BLOCK;i++){ const g=g0+(g1-g0)*(i+1)/BLOCK; oL[i]=L?L[i]*g:0; oR[i]=R?R[i]*g:0; }
    return {L:oL, R:oR, gain:g1, left:n.left, frac:n.total>0 ? n.left/n.total : 0, done:n.done?1:0}; },
  draw(n){
    const p=n.p;
    roText(n, n.done ? 'done — '+(p.action==='nothing' ? 'silent' : 'sound stopped')
      : n.run ? 'sleep in '+slFmt(n.left)+(n.left<p.fade ? ' · fading '+Math.round(n.g*100)+'%' : '')
      : 'ready — '+slFmt(p.min*60)+(p.auto ? ' from start' : ' after Start')); }});
