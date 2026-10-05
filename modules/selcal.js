"use strict";
/* ============================ SELCAL (авиационный, ICAO Annex 10, HF / VHF) ============================
   Таблица тонов и тайминги — ASRI SELCAL Users Guide, Rev D (таблица 2-1, рис. 2-2): 16 тонов «A»…«S» (без I, N, O) 312.6 …
   1479.1 Гц; код — два импульса, в каждом одновременно два тона, импульс 1.0 ± 0.25 с, пауза 0.2 ± 0.1 с; запись кода
   «AC-BD»: тоны A и C в первом импульсе, B и D во втором; четыре тона в коде различны.
   Приём: окно Ханна ~90 мс, Гёрцель на 16 частот каждые ~43 мс; кадр — «два тона», если они вместе дают заметную долю
   энергии окна (чистота) и остальные тоны заметно слабее; серия кадров с одной парой — импульс; два импульса
   подряд с допустимой паузой — код. Время — по счёту отсчётов (ускоренный прогон работает). */

const SELCAL_TONES={A:312.6, B:346.7, C:384.6, D:426.6, E:473.2, F:524.8, G:582.1, H:645.7,
  J:716.1, K:794.3, L:881.0, M:977.2, P:1083.9, Q:1202.3, R:1333.5, S:1479.1};
const SELCAL_LET=Object.keys(SELCAL_TONES), SELCAL_HZ=SELCAL_LET.map(k=>SELCAL_TONES[k]);

// «ACBD», «AC-BD», «ac bd» → «AC-BD»; null — не код (буквы из набора, все четыре разные)
function selcalNorm(s){
  const t=String(s||'').toUpperCase().replace(/[^A-Z]/g,'');
  if(t.length!==4) return null;
  for(const ch of t) if(!(ch in SELCAL_TONES)) return null;
  if(new Set(t).size!==4) return null;
  const a=[t[0],t[1]].sort().join(''), b=[t[2],t[3]].sort().join('');
  return a+'-'+b;
}

def({ id:'selcalRx', title:'SELCAL Decoder', cat:'Decoders', readout:true, tall:true, resize:true, w:420,
  kw:'selcal selective calling aircraft hf airband icao tones',
  ins:[{n:'in',t:'sig'}], outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'new',t:'num'},{n:'level',t:'num'}],
  params:[{n:'code',t:'text',d:'',label:'watch for a code (e.g. AB-CD): the result says whether it matched'},
          {n:'shift',t:'range',min:-100,max:100,step:1,d:0,label:'receiver tuning error, Hz (all tones are shifted by it)'},
          {n:'thr',t:'range',min:.1,max:.8,step:.01,d:.35,label:'tone purity threshold (share of the window energy in the two tones)'}],
  init:n=>{ n.key=''; n.ring=null; n.w=0; n.f=0; n.run=null; n.first=null; n.cur=''; n.calls=0; n.recent=[]; n.last=''; n.lvl=0; n.pur=0; n.off=0; },
  process(n,I){
    const sr=Eng.sr, N=Math.round(.09*sr), HOP=Math.max(BLOCK,Math.round(.043*sr/BLOCK)*BLOCK);
    if(n.key!==sr+'|'+N){
      n.key=sr+'|'+N; n.N=N; n.hop=HOP; n.ring=new Float32Array(N); n.fill=0; n.sinceHop=0; n.frame=0;
      n.win=new Float32Array(N); for(let i=0;i<N;i++) n.win[i]=.5-.5*Math.cos(2*Math.PI*i/(N-1));
      n.xw=new Float32Array(N); n.run=null; n.first=null;
    }
    const x=I.in, recs=[], texts=[];
    if(x){
      n.ring.copyWithin(0,BLOCK); n.ring.set(x.subarray(0,BLOCK),N-BLOCK);
      let e=0; for(let i=0;i<BLOCK;i++) e+=x[i]*x[i]; n.lvl=n.lvl*.8+Math.sqrt(e/BLOCK)*.2;
    } else { n.ring.copyWithin(0,BLOCK); n.ring.fill(0,N-BLOCK); }
    n.fill=Math.min(N,n.fill+BLOCK); n.sinceHop+=BLOCK;
    if(n.sinceHop>=n.hop && n.fill>=N){
      n.sinceHop-=n.hop;
      selcalFrame(n,sr,recs,texts);
    }
    return {rec:recs.length ? recs : null, text:texts.length ? texts.join('\n') : null, new:recs.length ? 1 : 0, level:n.lvl};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.calls+' calls · input '+(n.lvl>1e-4 ? (20*Math.log10(n.lvl)).toFixed(0)+' dBFS' : '—')+' · tones '+(n.cur||'—')+(n.pur ? ' (purity '+(n.pur*100).toFixed(0)+'%)' : '')+
      (n.recent.length ? '\n'+n.recent.slice(-8).join('\n') : '\nwaiting for a call');
    if(r.textContent!==t) r.textContent=t; }
});

// один кадр: две сильнейшие частоты → пара или ничего; машина состояний импульсов
function selcalFrame(n,sr,recs,texts){
  const N=n.N, xw=n.xw, ring=n.ring, win=n.win, sh=+n.p.shift||0;
  let E=0;
  for(let i=0;i<N;i++){ const v=ring[i]*win[i]; xw[i]=v; E+=v*v; }
  const P=new Float64Array(16);
  for(let k=0;k<16;k++){
    const co=2*Math.cos(2*Math.PI*(SELCAL_HZ[k]+sh)/sr);
    let s1=0, s2=0;
    for(let i=0;i<N;i++){ const s0=xw[i]+co*s1-s2; s2=s1; s1=s0; }
    P[k]=s1*s1+s2*s2-co*s1*s2;
  }
  let a=-1, b=-1;
  for(let k=0;k<16;k++) if(a<0 || P[k]>P[a]) a=k;
  for(let k=0;k<16;k++) if(k!==a && (b<0 || P[k]>P[b])) b=k;
  let c=0; for(let k=0;k<16;k++) if(k!==a && k!==b && P[k]>c) c=P[k];
  const pur=E>1e-9 ? 3*(P[a]+P[b])/(N*E) : 0;
  n.pur=pur;
  const ok=E/N>1e-8 && pur>+n.p.thr && P[b]>=.08*P[a] && c<=.1*P[b];
  const id=ok ? Math.min(a,b)*16+Math.max(a,b) : -1;
  n.cur=ok ? SELCAL_LET[Math.min(a,b)]+SELCAL_LET[Math.max(a,b)] : '';
  const h=n.hop/sr, f=n.frame++;
  let r=n.run;
  if(ok){                                                                       // отклонение частоты от таблицы по параболе через ±6 Гц
    let o=0;
    for(const k of [a,b]){
      const m=d=>{ const fq=SELCAL_HZ[k]+sh+d, co=2*Math.cos(2*Math.PI*fq/sr); let s1=0, s2=0;
        for(let i=0;i<N;i++){ const s0=xw[i]+co*s1-s2; s2=s1; s1=s0; } return Math.sqrt(Math.max(0,s1*s1+s2*s2-co*s1*s2)); };
      const mm=m(-6), m0=Math.sqrt(P[k]), mp=m(6), den=mm-2*m0+mp;
      if(den<0) o+=Math.max(-12,Math.min(12,6*(mm-mp)/(2*den)))/2;
    }
    n.off=n.off*.8+o*.2;
    if(r && id===r.id){ r.osum+=o; r.on++; }
  }
  if(r){
    if(id===r.id){ r.last=f; r.miss=0; }
    else if(++r.miss>2){ n.run=null; selcalPulse(n,r,h,recs,texts); r=null; }
  }
  if(!n.run && id>=0){ n.run={id, start:f, last:f, miss:0, osum:0, on:0}; }
  if(n.first && !n.run && (f-n.first.last)*h>1.2) n.first=null;                           // второго импульса нет
}
function selcalPulse(n,r,h,recs,texts){
  const dur=(r.last-r.start+1)*h;
  if(dur<.6 || dur>1.5){ n.first=null; return; }
  const pair=[SELCAL_LET[r.id>>4], SELCAL_LET[r.id&15]];
  const f1=n.first;
  if(f1){
    const gap=(r.start-f1.last-1)*h;
    const letters=new Set(f1.pair.concat(pair));
    if(gap>=0 && gap<=.8 && letters.size===4){
      const code=f1.pair.join('')+'-'+pair.join('');
      n.first=null; n.calls++;
      const watch=selcalNorm(n.p.code);
      const rec={t:Date.now(), src:'SELCAL', kind:'call', id:code, code, tones:f1.pair.concat(pair).join(' '),
        freqs:f1.pair.concat(pair).map(l=>SELCAL_TONES[l]).join(' '), pulse1:+f1.dur.toFixed(2), pulse2:+dur.toFixed(2), gap:+gap.toFixed(2),
        offset:+(((f1.off||0)+(r.on ? r.osum/r.on : 0))/2).toFixed(1)};
      if(watch) rec.match=watch===code ? 1 : 0;
      const line=code+'  ('+rec.freqs+' Hz'+(Math.abs(rec.offset)>=1 ? ', off '+(rec.offset>0 ? '+' : '')+rec.offset+' Hz' : '')+')'+(Math.abs(rec.offset)>8 ? '  ⚠ tuning error: neighbouring tones look alike' : '')+(watch ? (rec.match ? '  ← matches the watched code' : '') : '');
      n.last=line; n.recent.push(line); if(n.recent.length>20) n.recent.shift();
      recs.push(rec); texts.push(code);
      return;
    }
  }
  n.first={pair, last:r.last, dur, off:r.on ? r.osum/r.on : 0};
}

/* ---- Тестовый сигнал: код тонами по таблице ---- */
// Только для проверки декодера по кабелю / звуковой карте: не излучать — вызов чужого борта на рабочей частоте мешает связи.
function selcalTxQueue(n){
  const code=selcalNorm(n.p.code);
  if(!code){ n.status='code: four different letters from A B C D E F G H J K L M P Q R S, e.g. AB-CD'; return; }
  // порядок букв в импульсе роли не играет
  const raw=String(n.p.code).toUpperCase().replace(/[^A-Z]/g,'');
  n.tq={pairs:[[raw[0],raw[1]],[raw[2],raw[3]]], t:0, dur:+n.p.pulse, gap:+n.p.gap, ph:[0,0]};
  n.status='sending '+code;
}
def({ id:'selcalTx', title:'SELCAL: Test Signal', cat:'Protocols', readout:true,
  ins:[{n:'go',t:'num'}], outs:[{n:'out',t:'sig'},{n:'busy',t:'num'}],
  params:[{n:'code',t:'text',d:'AB-CD',label:'code: four different letters (A…S without I, N, O); AB-CD = tones A and B, then C and D'},
          {n:'pulse',t:'range',min:.75,max:1.25,step:.05,d:1,label:'pulse, s (1.0 ± 0.25)'},
          {n:'gap',t:'range',min:.1,max:.3,step:.05,d:.2,label:'gap, s (0.2 ± 0.1)'},
          {n:'amp',t:'range',min:0,max:1,step:.01,d:.4,label:'level (two tones: the peak is twice this per tone)'},
          {n:'send',t:'button',label:'Send (decoder test only)',fn:n=>selcalTxQueue(n)}],
  init:n=>{ n.tq=null; n.prevGo=0; n.status='waiting'; },
  process(n,I){
    const sr=Eng.sr, o=buf(n,'out'), go=I.go||0;
    if(go>.5 && n.prevGo<=.5) selcalTxQueue(n);
    n.prevGo=go;
    let q=n.tq, busy=0;
    for(let i=0;i<BLOCK;i++){
      let v=0;
      if(q){
        busy=1;
        const t=q.t/sr, T=q.dur*2+q.gap;
        let p=-1;
        if(t<q.dur) p=0; else if(t>=q.dur+q.gap && t<T) p=1;
        if(p>=0){
          for(let k=0;k<2;k++){ q.ph[k]+=2*Math.PI*SELCAL_TONES[q.pairs[p][k]]/sr; v+=Math.sin(q.ph[k])*n.p.amp; }
          const edge=Math.min(1,Math.min(t-(p ? q.dur+q.gap : 0), (p ? T : q.dur)-t)/.01);     // 10 мс на фронтах
          v*=Math.max(0,edge);
        }
        q.t++;
        if(q.t>=T*sr){ n.tq=q=null; n.status='sent'; }
      }
      o[i]=v;
    }
    return {out:o, busy};
  },
  draw(n){ n.el.querySelector('.readout').textContent=n.status; }});
