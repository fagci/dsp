"use strict";
/* ============================ Signal Detector (per-bin floor) ============================
   Детектор: свой пол шума у каждого бина, канал открывается при модуляции. Ядро — bindet-kernels.js (node tools/test-bindet.mjs).
   Показ как у cfar: bands → вход sigs у SA (скобки и подписи над пиками); marks → marksRec: прямоугольники на водопаде растут и плывут вниз вместе с ним.
   Выходы f1…fK / g1…gK — слоты открытых каналов: на IQ Channelizer (manual, входы f) и IQ Recorder (go) — запись всех сигналов окна сразу. */
const BD_K=['1','2','3','4','5','6','7','8'];
function bdPorts(n){                                  // после смены числа слотов — убрать провода к исчезнувшим портам
  const valid=new Set(portsOf(n,'outs').map(p=>p.n));
  Graph.edges.filter(e=>e.from===n.id && !valid.has(e.fp)).forEach(delEdge);
  rebuildNode(n); markTopoDirty();
}
// запись открытия / закрытия → метка водопада SA (marksRec): from/to — полоса, t — время в секундах, dur — длина (закрытие
// рисуется на водопаде полосой от начала до конца сигнала)
function markOf(x,now){
  const age=(now-(x.kind==='close' ? x.t0 : x.t))/1000, t=Date.now()/1000-age, c=x.kind==='close';
  return {kind:x.kind, id:x.id, f:x.f, bw:x.bw, exc:x.exc, from:x.lo, to:x.hi, t, dur:c ? x.dur : 0, color:c ? '#4caf50' : '#ffb300',
    label:(c ? '■ ' : '▶ ')+fmtHz(x.f,4)+(c ? ' '+x.dur.toFixed(1)+' s' : '')};
}
const bdCol=id=>'hsl('+Math.round((id*137.5)%360)+' 85% 56%)';          // свой цвет у каждого сигнала: прямоугольники соседних не сливаются
def({ id:'binDet', title:'Signal Detector (per-bin floor)', cat:'Analysis', readout:true, tall:true, resize:true, w:420,
  kw:'noise floor per bin modulation carrier open channel scanner vfo multiscan record all signals slots lockout',
  pack:['thr tau','confM confN minW','modK settle hold'],
  ins:[{n:'spec',t:'spec'},{n:'thr',t:'num'}],
  outs:n=>[{n:'bands',t:'bands',tip:'open channels, shown like the Signal Detector: wire to the «sigs» input of SA'},
           {n:'marks',t:'rec',tip:'rectangles for the waterfall: one per open signal, it grows while the signal lasts: wire to «marksRec» of SA — they drift down with the waterfall'},
           {n:'rec',t:'rec',tip:'open / close events: f, bw, exc, dur'},
           {n:'count',t:'num'},{n:'open',t:'num'},{n:'floor',t:'num'},{n:'lost',t:'num',tip:'open channels that did not get a slot'},
           ...Array.from({length:+n.p.K||4},(_,k)=>({n:'f'+(k+1),t:'num',tip:'slot '+(k+1)+': frequency of an open channel, Hz'})),
           ...Array.from({length:+n.p.K||4},(_,k)=>({n:'g'+(k+1),t:'num',tip:'slot '+(k+1)+': 1 while the channel is open (go for IQ Recorder)'}))],
  params:[{n:'K',t:'select',opts:BD_K,d:'4',label:'slots (outputs f1…, g1…): how many open channels are handed on at once',fn:bdPorts},
          {n:'thr',t:'range',min:3,max:30,step:.5,d:10,label:'threshold over own noise, dB'},
          {n:'tau',t:'range',min:20,max:2000,step:10,log:true,d:200,label:'noise floor memory, frames',adv:true},
          {n:'learn',t:'range',min:5,max:200,step:1,d:30,label:'learn the floor first, frames',adv:true},
          {n:'confM',t:'range',min:1,max:8,step:1,d:2,label:'confirm: hits (M)',adv:true},
          {n:'confN',t:'range',min:1,max:8,step:1,d:4,label:'confirm: of last frames (N) — a one-frame wideband spike does not pass',adv:true},
          {n:'minW',t:'range',min:1,max:32,step:1,d:2,label:'min width, bins',adv:true},
          {n:'gap',t:'range',min:0,max:8,step:1,d:2,label:'join bins with gaps up to, bins',adv:true},
          {n:'bwDb',t:'range',min:6,max:40,step:1,d:20,label:'channel width: dB below its peak',adv:true},
          {n:'modMode',t:'select',opts:['modulation','any signal'],d:'modulation',label:'open on: modulation (an unmodulated carrier stays closed) · any signal over the threshold'},
          {n:'carBins',t:'range',min:1,max:16,step:1,d:4,label:'narrower than this (bins) is a carrier line; wider is already modulated',adv:true},
          {n:'modK',t:'range',min:1,max:10,step:.1,d:3,label:'modulation: level jitter between frames vs a steady carrier at the same SNR, ×',adv:true},
          {n:'settle',t:'range',min:1,max:60,step:1,d:8,label:'frames in place before opening',adv:true},
          {n:'hold',t:'range',min:0,max:10000,step:100,d:1500,label:'close after no modulation for, ms',adv:true},
          {n:'maxBw',t:'range',min:0,max:5000,step:5,d:0,label:'wider than this, kHz — not a channel (0 — no limit)',adv:true},
          {n:'edge',t:'range',min:0,max:40,step:1,d:0,label:'trim edges, % (receiver windows sag at the edges)',adv:true},
          {n:'carriers',t:'check',d:true,label:'show closed carriers / signals (grey)',adv:true},
          {n:'clr',t:'button',label:'Relearn floor',fn:n=>{ n.st=bdNew(); n.text='relearning'; n.bnd=[]; }}],
  init:n=>{ n.st=bdNew(); n.text='connect a spectrum'; n.bnd=[]; n.recs=[]; n.mk=[]; n.slots={f:[],go:[],lost:0}; n.floorDb=null; n.nOpen=0; },
  process(n,I){
    const s=I.spec, K=+n.p.K||4;
    const out=()=>{ const o={bands:n.bnd, rec:n.recs.length ? n.recs.splice(0) : null, marks:n.mk.length ? n.mk.splice(0) : null, count:n.st.tracks.length, open:n.nOpen, floor:n.floorDb, lost:n.slots.lost};
      for(let k=0;k<K;k++){ o['f'+(k+1)]=n.slots.f[k]??null; o['g'+(k+1)]=n.slots.go[k]|0; } return o; };
    if(!s || !s.mag || s.mag.length<8) return out();
    if(typeof I.thr==='number' && isFinite(I.thr)) setMod(n,'thr',I.thr);
    const fresh=s.rev!=null ? s.rev!==n._lastRev : s!==n._lastSpecRef;
    if(fresh){
      n._lastRev=s.rev; n._lastSpecRef=s;
      const N=s.mag.length, m=s.mag, v=n._v&&n._v.length===N ? n._v : (n._v=new Float32Array(N));
      for(let i=0;i<N;i++) v[i]=20*Math.log10(Math.max(m[i],1e-12));
      const p=n.p, now=performance.now();
      const r=bdFrame(n.st,v,i=>specHz(s,i),{thr:+p.thr, tau:+p.tau, learn:+p.learn, confM:+p.confM, confN:+p.confN, minW:+p.minW, gap:+p.gap,
        bwDb:+p.bwDb, carBins:+p.carBins, modK:p.modMode==='modulation' ? +p.modK : 0, settle:+p.settle, hold:+p.hold, maxBw:+p.maxBw*1000, edge:+p.edge, now});
      // «любой сигнал»: модуляцию не проверяем — открыт любой подтверждённый канал (settle кадров на месте)
      if(p.modMode!=='modulation') for(const t of n.st.tracks) if(!t.open && t.n>=(+p.settle||1) && t.seenAt===now){ t.open=true; t.openAt=now; t.modAt=now; r.recs.push({t:now,kind:'open',id:t.id,f:t.f,lo:t.lo,hi:t.hi,bw:t.bw,exc:t.pk}); }
        else if(t.open && t.seenAt===now) t.modAt=now;
      for(const x of r.recs) n.recs.push(markOf(x,now));
      if(n.recs.length>1000) n.recs.splice(0,n.recs.length-1000);
      // идущие сигналы — прямоугольники водопада (marksRec): запись с тем же id продлевает метку. Сегмент живёт, пока сигнал
      // реально есть в кадрах: пауза внутри hold рвёт прямоугольник (промежуток не закрашивается), конец — по последнему кадру
      // с сигналом, начало — по первому подтверждённому кадру (а не по моменту открытия)
      const ep=Date.now(), dt=n._dt=now-(n._tf||now-80)<2000 ? (n._dt||80)*.8+(now-(n._tf||now-80))*.2 : 80; n._tf=now;
      for(const t of n.st.tracks){
        if(!t.open || t.liveAt!==now) continue;
        if(!t.seg || now-t.segEnd>Math.max(250,dt*3)) t.seg={start:t.seg ? now : t.t0, id:'bd'+t.id+'.'+Math.round(t.seg ? now : t.t0)};
        t.segEnd=now;
        n.mk.push({id:t.seg.id, from:t.lo, to:t.hi, t:(ep-(now-t.seg.start))/1000, dur:(now-t.seg.start)/1000, color:bdCol(t.id), fill:.9});
      }
      if(n.mk.length>2000) n.mk.splice(0,n.mk.length-2000);
      n.slots=bdSlots(n.st.tracks,K);
      const tr=n.st.tracks.filter(t=>t.seenAt!=null);
      n.nOpen=tr.filter(t=>t.open).length;
      const mk=t=>({lo:t.lo, hi:t.hi, f:t.f, sig:true, db:t.abs, conf:t.open ? 1 : .4,
        color:t.open ? bdCol(t.id) : '#9e9e9e',
        label:(t.open ? (t.slot ? t.slot+' ' : '! ') : 'carrier ')+fmtHz(t.f,4)+' +'+t.pk.toFixed(0)+' dB'});
      const shown=tr.filter(t=>t.open || p.carriers);
      n.bnd=shown.map(mk);
      const stp=Math.max(1,N>>8), vs=[]; for(let i=0;i<N;i+=stp) vs.push(n.st.fl[i]); vs.sort((a,b)=>a-b); n.floorDb=vs[vs.length>>1];
      const lines=tr.slice().sort((a,b)=>a.f-b.f).slice(0,12).map(t=>(t.open ? (t.slot ? 'slot '+t.slot : 'no slot') : 'closed ').padEnd(8)+' '+(fmtHz(t.f,4)+'Hz').padStart(14)+' +'+t.pk.toFixed(0)+' dB  bw '+fmtHz(t.bw,1)+'Hz  jitter ×'+t.ratio.toFixed(1));
      n.text=(n.st.frames<+p.learn ? 'learning the floor '+Math.round(100*n.st.frames/+p.learn)+'%' : 'watching')+' · floor '+n.floorDb.toFixed(1)+' dB · open '+n.nOpen+'/'+K+' slots'+(n.slots.lost?' · '+n.slots.lost+' without slot':'')+'\n'+(lines.length ? lines.join('\n') : 'no signals');
    }
    return out();
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(r && r.textContent!==n.text) r.textContent=n.text; }});
