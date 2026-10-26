"use strict";
/* ======================= GAIN OPTIMIZER — узел ======================= */
// Подбор усиления приёмника по максимуму SNR цели (логика — gainopt-kernels.js).
// spec → цель (частота f или самый сильный сигнал) → усиление шагами на gain → приёмник.

// самый сильный бин спектра без краёв окна и центрального бугра (DC у RTL-SDR)
function goPeakBin(sp){
  const m=sp.mag, N=m.length, e=Math.floor(N*.03), c=N>>1;
  let b=-1, mx=0;
  for(let i=e;i<N-e;i++){ if(Math.abs(i-c)<=3) continue; if(m[i]>mx){ mx=m[i]; b=i; } }
  return b;
}
// SNR цели на кадре: пик в окне ±tol минус шумовая полка вокруг (медиана, сигнал исключён)
function goMeasure(sp,f,tol){
  const m=sp.mag, N=m.length;
  const a=clamp(Math.floor(specBin(sp,f-tol)),0,N-1), b=clamp(Math.ceil(specBin(sp,f+tol)),0,N-1);
  let mx=0; for(let i=a;i<=b;i++) if(m[i]>mx) mx=m[i];
  const peak=20*Math.log10(mx+1e-12), floor=saNoiseFloor(sp,f,tol);
  return {peak, floor, snr:peak-floor};
}
function goBegin(n,sp,now){
  const f=Number.isFinite(n._inF)&&n._inF>0 ? n._inF : (()=>{ const b=goPeakBin(sp); return b>=0 ? specHz(sp,b) : null; })();
  if(f==null){ n.msg='no signal to optimize on'; return false; }
  n.f=f; n.gain=goStart(n.st,n.p,now); n.msg=''; n.recs.push({t:Date.now(),src:'gainopt',kind:'start',freq:Math.round(f)});
  return true;
}
def({ id:'gainopt', title:'Gain Optimizer (max SNR)', cat:'Radio',
  ins:[{n:'spec',t:'spec'},{n:'f',t:'num',tip:'target frequency, Hz (empty — the strongest signal at the start)'},
       {n:'clip',t:'num',tip:'ADC clipping, % (USB SDR clip): a gain that clips is never chosen'},{n:'run',t:'num',tip:'a pulse 0→1 starts the search'}],
  outs:[{n:'gain',t:'num',tip:'gain to command, dB → USB SDR gainDb (empty until the first run)'},{n:'best',t:'num'},{n:'snr',t:'num'},
        {n:'busy',t:'num'},{n:'done',t:'num',tip:'a pulse when the search ends'},{n:'rec',t:'rec'},{n:'text',t:'txt'}],
  readout:true, tall:true, w:340,
  params:[{n:'start',t:'button',label:'Find the best gain',fn:n=>{ n._go=1; }},
          {n:'stop',t:'button',label:'Stop',fn:n=>{ if(n.st.phase==='coarse'||n.st.phase==='fine'){ n.st.phase='idle'; n.msg='stopped'; } }},
          {n:'gMin',t:'range',min:0,max:50,step:.5,d:0,label:'gain from, dB'},
          {n:'gMax',t:'range',min:0,max:50,step:.5,d:49,label:'gain to, dB'},
          {n:'gStep',t:'range',min:1,max:10,step:.5,d:4,label:'coarse step, dB'},
          {n:'refine',t:'check',d:true,label:'refine: 1 dB steps around the best'},
          {n:'settle',t:'range',min:50,max:3000,step:50,d:500,label:'wait after a change, ms (the hardware applies gain with a delay)',adv:true},
          {n:'frames',t:'range',min:1,max:30,step:1,d:6,label:'spectrum frames averaged per step',adv:true},
          {n:'tol',t:'range',min:100,max:200000,step:100,log:true,d:5000,label:'target window ±, Hz (peak search and noise floor around it)',adv:true},
          {n:'clipPct',t:'range',min:0,max:5,step:.005,d:.01,label:'overload: ADC clipping from, %',adv:true},
          {n:'tolDb',t:'range',min:0,max:3,step:.1,d:.5,label:'prefer a lower gain within this SNR margin, dB (headroom)',adv:true},
          {n:'backoff',t:'range',min:0,max:10,step:.5,d:0,label:'back off from the best, dB',adv:true},
          {n:'period',t:'range',min:0,max:3600,step:10,d:0,label:'repeat every, s (0 — only on demand)',adv:true}],
  init:n=>{ n.st={phase:'idle'}; n.gain=null; n.f=null; n.recs=[]; n.msg=''; n._lastRev=undefined; n._lastSp=null; n._runPrev=0; n.doneAt=0; n._go=0; n._inF=null; n._pulse=0; },
  process(n,I){
    const sp=I.spec, now=performance.now(), run=+I.run>.5;
    n._inF=typeof I.f==='number' ? I.f : null;
    const go=n._go || (run && !n._runPrev) || (n.p.period>0 && n.st.phase==='done' && now-n.doneAt>n.p.period*1000);
    n._runPrev=run; n._go=0;
    const busy=n.st.phase==='coarse'||n.st.phase==='fine';
    if(go && sp && !busy) goBegin(n,sp,now);
    else if(go && !sp) n.msg='connect a spectrum';
    const fresh=sp && (sp.rev!=null ? sp.rev!==n._lastRev : sp!==n._lastSp);
    if(fresh){ n._lastRev=sp.rev; n._lastSp=sp; }
    if(fresh && (n.st.phase==='coarse'||n.st.phase==='fine')){
      const ms=goMeasure(sp,n.f,n.p.tol), clip=typeof I.clip==='number' ? I.clip : 0, before=n.st.res.length;
      n.gain=goFeed(n.st,{now,snr:ms.snr,peak:ms.peak,floor:ms.floor,clip},{...n.p,tol:n.p.tolDb});
      if(n.st.res.length>before){ const r=n.st.res[n.st.res.length-1]; n.recs.push({t:Date.now(),src:'gainopt',kind:'step',freq:Math.round(n.f),gain:r.g,snr:+r.snr.toFixed(1),peak:+r.peak.toFixed(1),floor:+r.floor.toFixed(1),clip:+r.clip.toFixed(3)}); }
      if(n.st.phase==='done'){
        n.doneAt=now; n._pulse=2; const b=n.st.best;
        n.recs.push({t:Date.now(),src:'gainopt',kind:'best',freq:Math.round(n.f),gain:n.gain,snr:b?+b.snr.toFixed(1):null});
      }
    }
    if(n.recs.length>500) n.recs.splice(0,n.recs.length-500);
    const b=n.st.best, busy2=n.st.phase==='coarse'||n.st.phase==='fine';
    const rows=(n.st.res||[]).slice().sort((x,y)=>x.g-y.g).map(r=>goRow(r,b));
    n.text=(busy2 ? 'searching: '+(n.gain!=null?n.gain.toFixed(1)+' dB':'…')+' · '+n.st.phase+' '+Math.min(n.st.i+1,n.st.list.length)+'/'+n.st.list.length
        : n.st.phase==='done' ? 'best '+n.gain.toFixed(1)+' dB · SNR '+(b?b.snr.toFixed(1):'—')+' dB · '+fmtHz(n.f,4)+'Hz'
        : n.msg||'idle — press «Find the best gain» or pulse run')+(rows.length ? '\n'+rows.join('\n') : '');
    const pulse=n._pulse>0 ? 1 : 0; if(n._pulse>0) n._pulse--;
    return {gain:n.gain, best:b?b.g:null, snr:b?b.snr:null, busy:busy2?1:0, done:pulse, rec:n.recs.length ? n.recs.splice(0) : null, text:n.text}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(r && r.textContent!==n.text) r.textContent=n.text||'…'; }});
