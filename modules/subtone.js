"use strict";
/* ============================ Субтоны: CTCSS и DCS ============================
   Приёмники: CTCSS Decoder (50 тонов 67–254.1 Гц) и DCS Decoder (код Голея 23/12, 134.4 бит/с, 104 кода) читают звук FM-приёмника
   (после демодулятора, до фильтра субтонов, т.е. полный звуковой сигнал). Передатчики-зеркала — CTCSS Tone и DCS Code: синус и слово
   DCS для проверки без эфира, смешивайте их со звуком (Mixer). Ядро и пары «приём ↔ передача» — subtone-kernels.js. */

const stShow=(n,t)=>{ const r=n.el && n.el.querySelector('.readout'); if(r && r.textContent!==t) r.textContent=t; };

def({ id:'ctcssRx', title:'CTCSS Decoder', cat:'Decoders', readout:true, w:300,
  kw:'ctcss pl tone subtone squelch repeater access tone 67 100 hz',
  ins:[{n:'in',t:'sig'}], outs:[{n:'tone',t:'num'},{n:'active',t:'num'},{n:'text',t:'txt'},{n:'rec',t:'rec'}],
  params:[{n:'ratio',t:'range',min:3,max:40,step:1,d:8,label:'tone / rest of the tones, times (higher — fewer false tones)'},
          {n:'min',t:'range',min:.001,max:.1,step:.001,d:.004,label:'minimal level of the tone (full scale = 1)'},
          {n:'want',t:'text',d:'',label:'tone to wait for, Hz (empty — any): «match» output'}],
  init:n=>{ n.st=null; n.key=''; n.last=null; },
  process(n,I){
    const sr=Eng.sr, key=sr+'|'+n.p.ratio+'|'+n.p.min;
    if(n.key!==key){ n.key=key; n.st=ctRxNew(sr,{ratio:+n.p.ratio,min:+n.p.min}); }
    const st=n.st, x=I.in; let rec=null;
    if(x) for(let i=0;i<BLOCK;i++){
      const e=ctRxPush(st,x[i]);
      if(e) rec={t:Date.now(), src:'CTCSS', kind:e.tone ? 'tone' : 'off', id:'CTCSS', tone:e.tone, freq:e.tone, level:+e.amp.toFixed(4), text:e.tone ? 'CTCSS '+e.tone.toFixed(1)+' Hz' : 'CTCSS off'};
    }
    n.last=rec || n.last;
    return {tone:st.tone, active:st.tone ? 1 : 0, text:rec ? rec.text : null, rec};
  },
  draw(n){ const st=n.st; stShow(n,st && st.tone ? st.tone.toFixed(1)+' Hz · level '+st.amp.toFixed(3)+' · ×'+st.quality.toFixed(0) : 'no tone'+(st ? ' · best ×'+st.lastRatio.toFixed(1) : '')); }
});

def({ id:'ctcssTx', title:'CTCSS Tone', cat:'Protocols', readout:true, w:280,
  kw:'ctcss pl tone subtone generator encoder repeater access',
  ins:[{n:'tone',t:'num'}], outs:[{n:'out',t:'sig'}],
  params:[{n:'tone',t:'select',opts:CT_TONES.map(t=>t.toFixed(1)),d:'100.0',label:'tone, Hz (a wire on «tone» overrides)'},
          {n:'amp',t:'range',min:0,max:.5,step:.005,d:.1,label:'level (full scale = 1; 10 % is typical)'},
          {n:'on',t:'check',d:true}],
  init:n=>{ n.st=null; n.sr=0; n.f=0; },
  process(n,I){
    const sr=Eng.sr; if(n.sr!==sr){ n.sr=sr; n.st=ctTxNew(sr); }
    const f=typeof I.tone==='number' && I.tone>0 ? I.tone : +n.p.tone; n.f=f;
    const o=buf(n,'out'); if(!n.p.on){ o.fill(0); return {out:o}; }
    ctTxBlock(n.st,f,+n.p.amp,o); return {out:o};
  },
  draw(n){ stShow(n,n.p.on ? n.f.toFixed(1)+' Hz · '+(n.p.amp*100).toFixed(1)+' %' : 'off'); }
});

def({ id:'dcsRx', title:'DCS Decoder', cat:'Decoders', readout:true, w:300,
  kw:'dcs cdcss digital coded squelch dpl code golay 023 134.4',
  ins:[{n:'in',t:'sig'}], outs:[{n:'code',t:'num'},{n:'active',t:'num'},{n:'text',t:'txt'},{n:'rec',t:'rec'}],
  params:[{n:'maxerr',t:'range',min:0,max:3,step:1,d:2,label:'bit errors repaired in a word (the code is confirmed by two words in a row)'},
          {n:'min',t:'range',min:.0005,max:.05,step:.0005,d:.003,label:'minimal swing of the sub-audible signal (full scale = 1)'}],
  init:n=>{ n.st=null; n.key=''; },
  process(n,I){
    const sr=Eng.sr, key=sr+'|'+n.p.maxerr+'|'+n.p.min;
    if(n.key!==key){ n.key=key; n.st=dcsRxNew(sr,{maxErr:+n.p.maxerr,min:+n.p.min}); }
    const st=n.st, x=I.in; let rec=null;
    if(x) for(let i=0;i<BLOCK;i++){
      const e=dcsRxPush(st,x[i]);
      if(e) rec={t:Date.now(), src:'DCS', kind:e.code ? 'code' : 'off', id:'DCS', code:e.code, inverted:e.inv, text:e.code ? 'DCS D'+e.code+(e.inv ? 'I' : 'N') : 'DCS off'};
    }
    return {code:st.code ? parseInt(st.code,10) : 0, active:st.code ? 1 : 0, text:rec ? rec.text : null, rec};
  },
  draw(n){ const st=n.st; stShow(n,st && st.code ? 'D'+st.code+(st.inv ? 'I' : 'N')+' · errors '+st.errs : 'no code'); }
});

def({ id:'dcsTx', title:'DCS Code', cat:'Protocols', readout:true, w:280,
  kw:'dcs cdcss dpl code golay generator encoder 023 134.4',
  ins:[], outs:[{n:'out',t:'sig'}],
  params:[{n:'code',t:'select',opts:DCS_CODES,d:'023',label:'code (octal)'},
          {n:'inv',t:'check',d:false,label:'inverted (I)'},
          {n:'amp',t:'range',min:0,max:.5,step:.005,d:.2,label:'level (full scale = 1)'},
          {n:'on',t:'check',d:true}],
  init:n=>{ n.st=null; n.key=''; },
  process(n,I){
    const sr=Eng.sr, key=sr+'|'+n.p.code+'|'+n.p.inv;
    if(n.key!==key){ n.key=key; const pos=n.st ? n.st.pos : 0; n.st=dcsTxNew(sr,n.p.code,!!n.p.inv); n.st.pos=pos; }
    const o=buf(n,'out'); if(!n.p.on){ o.fill(0); return {out:o}; }
    dcsTxBlock(n.st,+n.p.amp,o); return {out:o};
  },
  draw(n){ stShow(n,n.p.on ? 'D'+n.p.code+(n.p.inv ? 'I' : 'N')+' · '+(n.p.amp*100).toFixed(1)+' %' : 'off'); }
});
