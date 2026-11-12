"use strict";
/* ============================ Sunrise Alarm ============================
   Будильник-рассвет: за «sunrise length» минут до времени побудки свет растёт (тёмно-красный → оранжевый → янтарь → тёплый белый), позже входит звук.
   Свет — выходы light / kelvin / color (лампа по MQTT, плитка дашборда) и, по желанию, сам экран телефона: заливка цветом поверх всего, касание — «я проснулся».
   Звук (L / R) идёт через узел с нарастающей громкостью gain — поставь перед ним птиц, ветер, прибой из Noise Generator или радио.
   Считает по часам, пока граф запущен (экран при этом не гаснет, звук в фоне держит вкладку): запусти звук с вечера на беззвучном — до рассвета узел молчит.
   Если нужен будильник, звенящий и при остановленном графе, на телефоне есть Phone Alarm Clock. Ядро — modules/sunrise-kernels.js (tools/test-sunrise.mjs). */

function sunLamp(){                                    // общая заливка экрана на все узлы
  let el=document.getElementById('sunriseLamp');
  if(!el){
    el=document.createElement('div'); el.id='sunriseLamp'; el.hidden=true;
    el.innerHTML='<div class="sunl-t"></div><div class="sunl-h">tap — I am awake</div>';
    el.addEventListener('pointerdown',()=>{ const n=el._own; if(n) sunDismiss(n); });
    document.body.append(el);
  }
  return el;
}
function sunDismiss(n){ n.dismissed=n.curWake||n.dismissed; n.over=null; sunLampOff(n); }
function sunLampOff(n){ const el=document.getElementById('sunriseLamp'); if(el && (!el._own || el._own===n)){ el.hidden=true; el._own=null; } }
function sunLampSet(n,mix,txt){                        // не чаще 4 раз в секунду
  const t=performance.now(); if(n._lt && t-n._lt<250) return; n._lt=t;
  const el=sunLamp();
  if(mix.light<.015){ sunLampOff(n); return; }
  el._own=n; el.hidden=false;
  const k=mix.light;
  el.style.background='rgb('+mix.rgb.map(v=>Math.round(v*k)).join(',')+')';
  el.firstChild.textContent=txt;
}

def({ id:'sunrise', title:'Sunrise Alarm', cat:'Output', w:280, view:{h:46}, readout:true,
  kw:'sunrise dawn alarm clock wake up light lamp screen sunlight gradual morning birds wind sound fade in wake simulator будильник рассвет',
  ins:[{n:'L',t:'sig'},{n:'R',t:'sig'},{n:'start',t:'num'},{n:'stop',t:'num'}],
  outs:[{n:'L',t:'sig'},{n:'R',t:'sig'},{n:'gain',t:'num'},{n:'light',t:'num'},{n:'kelvin',t:'num'},{n:'color',t:'txt'},
        {n:'frac',t:'num'},{n:'left',t:'num'},{n:'on',t:'num'},{n:'wake',t:'num'}],
  params:[
    {n:'time',t:'text',d:'7:00',label:'wake-up time HH:MM (local)'},
    {n:'days',t:'select',opts:SUN_DAYS,d:'every day',label:'days'},
    {n:'lead',t:'range',min:1,max:120,step:1,d:30,label:'sunrise length, min',tip:'the light and the sound grow over this time and reach the full level exactly at the wake-up time'},
    {n:'curve',t:'select',opts:SUN_CURVES,d:'gamma',label:'light curve',tip:'gamma: a barely visible glow at first, then faster — like a real dawn; linear; cosine: soft at both ends'},
    {n:'gamma',t:'range',min:.5,max:4,step:.1,d:2,label:'gamma',if:n=>n.p.curve==='gamma',adv:true},
    {n:'soundAt',t:'range',min:0,max:1,step:.01,d:.4,label:'sound enters at, % of the sunrise',tip:'the light comes first, the sound later (quiet and quadratic): 1 — only at the very end'},
    {n:'vol',t:'range',min:0,max:1,step:.01,d:1,label:'sound level at the end'},
    {n:'maxLight',t:'range',min:.05,max:1,step:.01,d:1,label:'max light'},
    {n:'hold',t:'range',min:0,max:120,step:1,d:10,label:'keep full level after wake-up, min',tip:'then light and sound switch off'},
    {n:'screen',t:'check',d:true,label:'light the phone screen',tip:'a full-screen lamp of the sunrise colour; a tap on it — “I am awake” (stops this sunrise). Off — the outputs only (a lamp over MQTT, a tile)'},
    {n:'test',t:'button',label:'Test (2 min)',fn:n=>{ const now=Date.now(); n.over={W:now+120000,lead:120000}; n.dismissed=null; }},
    {n:'dismiss',t:'button',label:'I am awake',fn:n=>sunDismiss(n)},
  ],
  init:n=>{ n.over=null; n.dismissed=null; n.curWake=null; n.sv=0; n.xv=0; n.g=0; n.mix=null; n.st=null; },
  dispose:n=>sunLampOff(n),
  process(n,I){
    const p=n.p, now=Date.now();
    const sv=typeof I.start==='number' && I.start>=.5 ? 1 : 0;
    if(sv && !n.sv){ const L=Math.max(1,+p.lead||30)*60000; n.over={W:now+L,lead:L}; n.dismissed=null; }       // фронт на start — рассвет сразу
    n.sv=sv;
    const xv=typeof I.stop==='number' && I.stop>=.5 ? 1 : 0;
    if(xv && !n.xv) sunDismiss(n);
    n.xv=xv;
    const cfg={time:p.time,days:p.days,lead:p.lead,hold:p.hold,dismissed:n.dismissed,over:n.over};
    let st=sunState(now,cfg);
    if(n.over && st.phase!=='ramp' && st.phase!=='hold'){ n.over=null; st=sunState(now,{...cfg,over:null}); }   // ручной рассвет кончился
    n.curWake=st.wake;
    const mix=sunMix(st,p); n.st=st; n.mix=mix;
    if(p.screen){
      if(st.phase==='ramp'||st.phase==='hold') sunLampSet(n,mix,st.phase==='ramp' ? sunLeftTxt(st.left)+' to wake-up' : 'good morning');
      else sunLampOff(n);
    } else sunLampOff(n);
    const g1=mix.gain, g0=n.g; n.g=g1;
    const oL=buf(n,'L'), oR=buf(n,'R'), L=I.L, R=I.R;
    for(let i=0;i<BLOCK;i++){ const g=g0+(g1-g0)*(i+1)/BLOCK; oL[i]=L?L[i]*g:0; oR[i]=R?R[i]*g:0; }
    const on=st.phase==='ramp' ? 1 : 0;
    return {L:oL, R:oR, gain:g1, light:mix.light, kelvin:mix.kelvin, color:mix.hex, frac:st.frac,
      left:isFinite(st.left) ? st.left : -1, on, wake:st.phase==='hold' ? 1 : 0}; },
  draw(n,cv,cx){
    const st=n.st, mix=n.mix, p=n.p;
    roText(n, !st ? '…' : st.phase==='ramp' ? 'sunrise · '+sunLeftTxt(st.left)+' to wake-up · light '+Math.round(mix.light*100)+'% · sound '+Math.round(mix.gain*100)+'%'
      : st.phase==='hold' ? 'good morning · light '+Math.round(mix.light*100)+'%'
      : st.phase==='wait' ? 'wake-up '+sunFmtTime(sunParseTime(p.time))+' · in '+sunLeftTxt(st.left)+' · sunrise '+p.lead+' min before'
      : 'no wake-up on these days');
    if(!cv || !cv.width) return;
    const W=cv.width, H=cv.height, g=cx.createLinearGradient(0,0,W,0);
    for(const [f,c] of SUN_STOPS) g.addColorStop(f,'rgb('+c.join(',')+')');
    cx.clearRect(0,0,W,H); cx.fillStyle=g; cx.fillRect(0,0,W,H);
    const f=st && (st.phase==='ramp'||st.phase==='hold') ? st.frac : null;
    if(f!=null){ cx.fillStyle='#fff'; cx.fillRect(Math.round(f*(W-2)),0,2,H); }
  }});
