"use strict";
/* ============================ Пятитоновый избирательный вызов (ZVEI, CCIR, EEA, …) ============================
   Наземная радиосвязь (пожарные, спасатели, такси, охрана): код — последовательность из 5 (реже 4–7) тонов подряд, без пауз,
   каждый тон 33–100 мс. Тон «E» — повтор предыдущей цифры (две одинаковые цифры подряд тоном повтора разделяются).
   Частоты (Гц) по таблицам из multimon-ng (demod_zvei1/2/3, dzvei, pzvei, ccir, eea, eia.c — данные, код не использован);
   индекс 0–9 — цифры, 10–15 — A…F. Длительность тона — по обычным спецификациям, настраивается.
   В таблице PZVEI у «0» и «E» одна частота (2400 Гц): тон читается как 0, а после 0 — как повтор. Приём: окно Ханна 0.7 тона, Гёрцель на 16 частот каждые 1/8 тона; кадр — «тон k», если он даёт большую долю энергии окна
   и сильнее второго на 6 дБ; серия кадров (≥3, один пропуск прощается) — тон; тоны с центрами через 0.6–1.8 длины тона — одна
   последовательность; закрывается после тишины 2.5 тона. Время — по счёту отсчётов. */

const FT_STD={
  'ZVEI-1':{ms:70,  f:[2400,1060,1160,1270,1400,1530,1670,1830,2000,2200,2800,810,970,885,2600,680]},
  'ZVEI-2':{ms:70,  f:[2400,1060,1160,1270,1400,1530,1670,1830,2000,2200,885,825,740,680,970,2600]},
  'ZVEI-3':{ms:70,  f:[2400,1060,1160,1270,1400,1530,1670,1830,2000,2200,885,810,2800,680,970,2600]},
  'DZVEI':{ms:70,   f:[2200,970,1060,1160,1270,1400,1530,1670,1830,2000,825,740,2600,885,2400,680]},
  'PZVEI':{ms:100,  f:[2400,1060,1160,1270,1400,1530,1670,1830,2000,2200,970,810,2800,885,2400,680]},
  'CCIR':{ms:100,   f:[1981,1124,1197,1275,1358,1446,1540,1640,1747,1860,2400,930,2247,991,2110,1055]},
  'EEA':{ms:40,     f:[1981,1124,1197,1275,1358,1446,1540,1640,1747,1860,1055,930,2400,991,2110,2247]},
  'EIA':{ms:33,     f:[600,741,882,1023,1164,1305,1446,1587,1728,1869,2151,2433,2010,2292,459,1091]}};
const FT_SYM='0123456789ABCDEF';
// «E» — повтор: заменяется предыдущей цифрой; без предыдущей — остаётся
function ftExpand(raw){ let o='', prev=''; for(const ch of raw){ if(ch==='E' && prev) o+=prev; else { o+=ch; prev=ch; } } return o; }
// код → символы для передачи: подряд идущие одинаковые символы разделяются тоном повтора
function ftRepeat(code){ let o='', prev=''; for(const ch of code){ o+=(ch===prev) ? 'E' : ch; prev=ch==='E' ? prev : ch; } return o; }

def({ id:'fivetoneRx', title:'Five-Tone Selcall Decoder', cat:'Decoders', readout:true, tall:true, resize:true, w:420,
  kw:'zvei ccir eea eia dzvei pzvei selcall five tone fire brigade alarm rescue',
  ins:[{n:'in',t:'sig'}], outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'new',t:'num'},{n:'level',t:'num'}],
  params:[{n:'std',t:'select',opts:Object.keys(FT_STD),d:'ZVEI-1',label:'standard (the table of tones)'},
          {n:'tone',t:'range',min:25,max:150,step:1,d:0,label:'tone length, ms (0 = the usual one for the standard: ZVEI 70, CCIR / PZVEI 100, EEA 40, EIA 33)'},
          {n:'min',t:'range',min:2,max:8,step:1,d:4,label:'shortest sequence, tones'},
          {n:'thr',t:'range',min:.1,max:.9,step:.01,d:.4,label:'tone purity threshold (share of the window energy)'}],
  init:n=>{ n.key=''; n.lvl=0; n.run=null; n.seq=[]; n.calls=0; n.recent=[]; n.cur=''; n.f=0; },
  process(n,I){
    const sr=Eng.sr, st=FT_STD[n.p.std]||FT_STD['ZVEI-1'], T=(+n.p.tone>0 ? +n.p.tone : st.ms)/1000;
    const W=Math.round(.7*T*sr), HOP=Math.max(16,Math.round(T/8*sr));
    const key=sr+'|'+W+'|'+n.p.std;
    if(n.key!==key){
      n.key=key; n.W=W; n.hop=HOP; n.ring=new Float32Array(W); n.pos=0; n.fill=0; n.since=0; n.f=0; n.run=null; n.seq=[];
      n.win=new Float32Array(W); for(let i=0;i<W;i++) n.win[i]=.5-.5*Math.cos(2*Math.PI*i/(W-1));
      n.xw=new Float32Array(W); n.co=st.f.map(f=>2*Math.cos(2*Math.PI*f/sr));
    }
    const x=I.in, recs=[], texts=[];
    if(W<64) return {rec:null,text:null,new:0,level:0};
    let e=0;
    for(let i=0;i<BLOCK;i++){                                   // кольцо; кадр — каждые HOP отсчётов, не привязанный к блоку
      const v=x ? x[i] : 0; e+=v*v;
      n.ring[n.pos]=v; n.pos=(n.pos+1)%W;
      if(n.fill<W) n.fill++;
      if(++n.since>=n.hop && n.fill>=W){ n.since=0; ftFrame(n,sr,T,recs,texts); }
    }
    n.lvl=n.lvl*.8+Math.sqrt(e/BLOCK)*.2;
    return {rec:recs.length ? recs : null, text:texts.length ? texts.join('\n') : null, new:recs.length ? 1 : 0, level:n.lvl};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.calls+' calls · '+n.p.std+' · input '+(n.lvl>1e-4 ? (20*Math.log10(n.lvl)).toFixed(0)+' dBFS' : '—')+' · now '+(n.cur||'—')+(n.seq.length ? ' · '+n.seq.map(s=>s.ch).join('') : '')+
      (n.recent.length ? '\n'+n.recent.slice(-8).join('\n') : '\nwaiting for a call');
    if(r.textContent!==t) r.textContent=t; }
});

function ftFrame(n,sr,T,recs,texts){
  const W=n.W, xw=n.xw, ring=n.ring, win=n.win, p0=n.pos;
  let E=0;
  for(let i=0;i<W;i++){ const v=ring[(p0+i)%W]*win[i]; xw[i]=v; E+=v*v; }
  const P=new Float64Array(16);
  for(let k=0;k<16;k++){
    const co=n.co[k]; let s1=0, s2=0;
    for(let i=0;i<W;i++){ const s0=xw[i]+co*s1-s2; s2=s1; s1=s0; }
    P[k]=s1*s1+s2*s2-co*s1*s2;
  }
  let a=0; for(let k=1;k<16;k++) if(P[k]>P[a]) a=k;
  const fa=FT_STD[n.p.std].f[a];
  let b=-1; for(let k=0;k<16;k++) if(k!==a && FT_STD[n.p.std].f[k]!==fa && (b<0 || P[k]>P[b])) b=k;      // одна частота у двух символов (PZVEI: 0 и E) — не конкурент
  const pur=E>1e-9 ? 3*P[a]/(W*E) : 0;
  const ok=E/W>1e-8 && pur>+n.p.thr && P[a]>=4*P[b];
  const id=ok ? a : -1, f=n.f++, h=n.hop/sr;
  n.cur=ok ? FT_SYM[a] : '';
  let r=n.run;
  if(r){
    if(id===r.id){ r.last=f; r.miss=0; r.cnt++; }
    else if(++r.miss>1){ n.run=null; ftTone(n,r,h,T); r=null; }
  }
  if(!n.run && id>=0) n.run={id, start:f, last:f, miss:0, cnt:1};
  // тишина после последнего тона — последовательность закончена
  if(n.seq.length && !n.run && (f-n.seq[n.seq.length-1].last)*h>2.5*T) ftClose(n,recs,texts);
}
function ftTone(n,r,h,T){
  if(r.cnt<3) return;
  const mid=(r.start+r.last)/2, prev=n.seq[n.seq.length-1];
  if(prev){
    const d=(mid-prev.mid)*h;
    if(d<.6*T || d>1.8*T){ n.seq=[]; }                                         // не продолжение
  }
  let ch=FT_SYM[r.id];
  if(n.p.std==='PZVEI' && ch==='0' && prev && prev.ch==='0') ch='E';                  // у 0 и E одна частота: 0 после 0 — повтор
  n.seq.push({ch, mid, last:r.last});
}
function ftClose(n,recs,texts){
  const seq=n.seq; n.seq=[];
  if(seq.length<+n.p.min) return;
  const raw=seq.map(s=>s.ch).join(''), code=ftExpand(raw);
  n.calls++;
  const rec={t:Date.now(), src:'SELCALL', kind:'call', id:code, std:n.p.std, raw, code, tones:seq.length};
  const line=code+(raw!==code ? '  ('+raw+')' : '')+'  · '+n.p.std;
  n.recent.push(line); if(n.recent.length>20) n.recent.shift();
  recs.push(rec); texts.push(code);
}

/* ---- Тестовый сигнал: последовательность тонов ---- */
// Только для проверки декодера по кабелю / звуковой карте: не излучать — такой сигнал запускает настоящие приёмники вызова.
function ftTxQueue(n){
  const st=FT_STD[n.p.std]||FT_STD['ZVEI-1'];
  const code=String(n.p.code).toUpperCase().replace(/[^0-9A-F]/g,'');
  if(code.length<1){ n.status='code: digits 0–9 and letters A–F, e.g. 12345'; return; }
  const seq=ftRepeat(code), T=(+n.p.tone>0 ? +n.p.tone : st.ms)/1000;
  n.tq={seq:[...seq].map(ch=>st.f[FT_SYM.indexOf(ch)]), T, t:0, ph:0};
  n.status='sending '+code+(seq!==code ? ' ('+seq+')' : '');
}
def({ id:'fivetoneTx', title:'Five-Tone Selcall: Test Signal', cat:'Protocols', readout:true,
  ins:[{n:'go',t:'num'}], outs:[{n:'out',t:'sig'},{n:'busy',t:'num'}],
  params:[{n:'code',t:'text',d:'12345',label:'code: digits 0–9, A–F (E is the repeat tone; the same digit twice in a row is sent with it)'},
          {n:'std',t:'select',opts:Object.keys(FT_STD),d:'ZVEI-1',label:'standard'},
          {n:'tone',t:'range',min:25,max:150,step:1,d:0,label:'tone length, ms (0 = standard)'},
          {n:'amp',t:'range',min:0,max:1,step:.01,d:.5},
          {n:'send',t:'button',label:'Send (decoder test only)',fn:n=>ftTxQueue(n)}],
  init:n=>{ n.tq=null; n.prevGo=0; n.status='waiting'; },
  process(n,I){
    const sr=Eng.sr, o=buf(n,'out'), go=I.go||0;
    if(go>.5 && n.prevGo<=.5) ftTxQueue(n);
    n.prevGo=go;
    let q=n.tq, busy=0;
    for(let i=0;i<BLOCK;i++){
      let v=0;
      if(q){
        busy=1;
        const t=q.t/sr, k=Math.floor(t/q.T);
        if(k>=q.seq.length){ n.tq=q=null; n.status='sent'; }
        else { q.ph+=2*Math.PI*q.seq[k]/sr; v=Math.sin(q.ph)*n.p.amp; q.t++; }
      }
      o[i]=v;
    }
    return {out:o, busy};
  },
  draw(n){ n.el.querySelector('.readout').textContent=n.status; }});
