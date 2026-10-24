"use strict";
/* ============================ Echo Canceller (AEC) ============================
   Убирает из микрофона то, что пришло из динамика. Два входа: mic и ref (звук, который играет динамик, — линия дальнего конца,
   или второй микрофон у источника помехи); фильтр сам находит тракт ref → mic (задержку и комнату до 512 мс) и вычитает эхо.
   Один вход (ref не подключён): режим одного микрофона — убирает повтор собственного сигнала, пришедший позже minDelay
   (эхо, реверберацию длинных коридоров, «двойной» сигнал ретранслятора); сам голос и всё короче minDelay остаётся.
   Логика — aec-kernels.js (PBFDAF + защита от двойной речи + подавитель остатка), тест tools/test-aec.mjs. Задержка узла — 5 мс. */

def({ id:'aec', title:'Echo Canceller (AEC)', cat:'Audio', readout:true, w:240,
  kw:'echo cancel cancellation aec acoustic speaker microphone feedback reference adaptive noise reverb dereverb double talk',
  // mic — микрофон; ref — что играет динамик (не подключён → один микрофон); echo — оценка эха; erle — на сколько дБ подавлено; delay — найденная задержка тракта
  ins:[{n:'mic',t:'sig'},{n:'ref',t:'sig'},{n:'mu',t:'num'},{n:'freeze',t:'num'}],
  outs:[{n:'out',t:'sig'},{n:'echo',t:'sig'},{n:'erle',t:'num'},{n:'delay',t:'num'}],
  params:[{n:'ms',t:'select',opts:['64','128','256','512'],d:'128',label:'echo path length, ms (room tail)'},
          {n:'mu',t:'range',min:.05,max:1,step:.01,d:.5,label:'adaptation speed'},
          {n:'dtd',t:'range',min:0,max:1,step:.01,d:.8,label:'double-talk protection (slows adaptation while you speak)'},
          {n:'suppress',t:'range',min:0,max:1,step:.01,d:.5,label:'residual echo suppression'},
          {n:'delay',t:'range',min:0,max:500,step:1,d:0,label:'delay the reference by, ms (when the speaker is far behind the path)'},
          {n:'minDelay',t:'range',min:20,max:400,step:1,d:60,label:'one mic: remove repeats later than, ms'},
          {n:'freeze',t:'check',d:false,label:'freeze (keep the learned path)'},
          {n:'rst',t:'button',label:'Reset the filter',fn:n=>{ n.as?.reset(); }}],
  init(n){ n.as=null; n.cfg=''; n.status='waiting for a signal'; n.lastPk=0; n.pk=-1; n.delayMs=0; },
  dispose(n){ n.as=null; },
  process(n,I){
    if(typeof I.mu==='number') setMod(n,'mu',I.mu);
    if(typeof I.freeze==='number') setMod(n,'freeze',I.freeze>=0.5);
    const sr=Eng.sr, key=sr+'|'+n.p.ms;
    if(!n.as || n.cfg!==key){ n.as=aecStream({sr,ms:+n.p.ms,mu:n.p.mu,dtd:n.p.dtd,suppress:n.p.suppress,delay:n.p.delay,minDelay:n.p.minDelay}); n.cfg=key; }
    const s=n.as; s.mu=n.p.mu; s.dtd=n.p.dtd; s.suppress=n.p.suppress; s.delay=n.p.delay; s.minDelay=n.p.minDelay; s.freeze=!!n.p.freeze;
    const out=buf(n,'out'), eo=buf(n,'echo'), mic=I.mic||buf(n,'z');
    out.set(s.push(mic,I.ref||null));
    for(let i=0;i<eo.length;i++) eo[i]=mic[i]-out[i];                         // что убрано
    n.lastPk+=BLOCK/sr;
    if(n.lastPk>.5){ n.lastPk=0; n.pk=s.solo ? -1 : s.core.peak(); n.delayMs=n.pk<0 ? 0 : (n.pk+s.delay*sr/1000)*1000/sr; }
    const erle=s.solo ? 0 : Math.max(0,s.erle);
    n.status=(s.solo ? 'one microphone · repeats later than '+n.p.minDelay+' ms' : 'reference connected · path '+(n.pk<0 ? '—' : n.delayMs.toFixed(0)+' ms'))+
      '\nsuppressed '+erle.toFixed(0)+' dB (linear), residual gain '+(20*Math.log10(s.gain)).toFixed(0)+' dB';
    return {out,echo:eo,erle,delay:n.delayMs}; },
  drawKey:n=>n.status,
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.status; }});
