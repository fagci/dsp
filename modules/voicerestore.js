"use strict";
/* ============================ Voice Restore (де-бубнение) ============================
   Речь после узкого фильтра звучит глухо и «бубнит». Узел учится по самой речи: сравнивает долговременный спектр с типовым спектром речи,
   подправляет полосы (подъём не выше max boost, у шумового пола не поднимает) и достраивает пропавший верх выше частоты среза.
   Логика — voicerestore-kernels.js, тест tools/test-voicerestore.mjs. Честно: недостающий верх «правдоподобный», а не настоящий. Задержка — N отсчётов (21 мс на 48 кГц). */

def({ id:'voicerestore', title:'Voice Restore (de-mumble)', cat:'Audio', readout:true, w:240,
  kw:'voice restore muffled mumble boomy equalizer bandwidth extension speech clarity intelligibility lowpass filtered telephone hum drone enhance',
  // in — глухая речь; cut — найденная частота среза, Гц (0 — верх на месте)
  ins:[{n:'in',t:'sig'},{n:'strength',t:'num'},{n:'extend',t:'num'}],
  outs:[{n:'out',t:'sig'},{n:'cut',t:'num'}],
  params:[{n:'strength',t:'range',min:0,max:1,step:.01,d:.7,label:'equalizer toward the speech spectrum'},
          {n:'extend',t:'range',min:0,max:1,step:.01,d:.5,label:'rebuild the missing top above the cut-off'},
          {n:'boom',t:'range',min:0,max:300,step:1,d:80,label:'cut rumble below, Hz (0 — off)'},
          {n:'maxBoost',t:'range',min:6,max:30,step:1,d:18,label:'max boost per band, dB'},
          {n:'adapt',t:'range',min:1,max:10,step:.1,d:3,label:'learning time, s (longer — steadier)'},
          {n:'bypass',t:'check',d:false,label:'bypass'},
          {n:'rst',t:'button',label:'Learn again',fn:n=>{ n.vr?.reset(); }}],
  init(n){ n.vr=null; n.vsr=0; n.status='listening…'; },
  dispose(n){ n.vr=null; },
  process(n,I){
    if(typeof I.strength==='number') setMod(n,'strength',I.strength);
    if(typeof I.extend==='number') setMod(n,'extend',I.extend);
    const sr=Eng.sr;
    if(!n.vr || n.vsr!==sr){ n.vr=vrRestore({sr}); n.vsr=sr; }
    n.vr.set({strength:n.p.strength, extend:n.p.extend, boom:n.p.boom, maxBoost:n.p.maxBoost, adapt:n.p.adapt});
    const x=I.in||buf(n,'z'), out=buf(n,'out'), y=n.vr.push(x);
    if(n.p.bypass){ out.set(x); n.status='bypass'; return {out,cut:0}; }      // push вызван: учимся и в обходе
    for(let i=0;i<out.length;i++){ const v=y[i]; out[i]=v>1 ? 1 : v<-1 ? -1 : v; }
    const f=n.vr.info;
    n.status='learning '+Math.round(f.conf*100)+'%'+(f.conf>=.3 ? ' · '+(f.cutoff>0 ? 'top missing above ~'+(f.cutoff/1000).toFixed(1)+' kHz' : 'top present')+
      (f.boost>1 ? ' · +'+f.boost.toFixed(0)+' dB at '+(f.boostHz/1000).toFixed(1)+' kHz' : '') : ' (needs ~1 s of speech)');
    return {out,cut:f.conf>=.3 ? f.cutoff : 0}; },
  drawKey:n=>n.status,
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.status; }});
