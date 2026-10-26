"use strict";
/* ======================= ANTENNA PEAKER — узел ======================= */
// Наведение антенны по постоянному сигналу (логика — antpeak-kernels.js): SNR цели из спектра (или число на `in`),
// быстрый/медленный уровень, лучшее за сеанс, отклонение от него и тон по уровню — смотреть на экран не нужно.
// Звук — свой генератор; без вызовов process тишина наступает сама (гейн гасится через 0.4 с).

let apCtx=null;
function apSound(n,hz,on){
  try{
    apCtx||=new (window.AudioContext||window.webkitAudioContext)();
    const c=apCtx; if(c.state==='suspended') c.resume();
    if(!n.osc){
      n.osc=c.createOscillator(); n.gn=c.createGain(); n.gn.gain.value=0;
      n.osc.connect(n.gn); n.gn.connect(c.destination); n.osc.start(); }
    const t=c.currentTime, g=n.gn.gain;
    g.cancelScheduledValues(t);
    if(on && Number.isFinite(hz)){
      n.osc.type=n.p.wave; n.osc.frequency.setTargetAtTime(hz,t,.03);
      g.setTargetAtTime(+n.p.vol,t,.03); g.setTargetAtTime(0,t+.4,.05);
    } else g.setTargetAtTime(0,t,.03);
    n.err=c.state==='running' ? '' : 'sound is blocked — tap the page first';
  }catch(e){ n.err='no sound: '+e.message; }
}

def({ id:'antpeak', lazy:'proc', title:'Antenna Peaker', cat:'Radio',
  kw:'antenna aim align pointing rotator peak signal strength snr level tone audio meter best direction hot cold',
  ins:[{n:'spec',t:'spec'},{n:'f',t:'num',tip:'target frequency, Hz (empty — the strongest signal at the start / after «Re-lock»)'},
       {n:'in',t:'num',tip:'level in dB instead of the spectrum (SNR, RSSI…) — has priority over `spec`'},
       {n:'reset',t:'num',tip:'a pulse 0→1 forgets the best'}],
  outs:[{n:'snr',t:'num',tip:'fast level, dB'},{n:'best',t:'num'},{n:'delta',t:'num',tip:'dB from the best (mode best) or from the slow mean (trend)'},
        {n:'tone',t:'num',tip:'pitch, Hz — to Beep `freq` or any synth'},{n:'text',t:'txt'}],
  view:{h:130}, resize:true, w:320,
  params:[{n:'mode',t:'select',opts:['best','trend'],d:'best',label:'tone: best — highest at the best position found; trend — up when it gets better, down when worse'},
          {n:'meas',t:'select',opts:['peak','band'],d:'peak',label:'measure: peak — a carrier; band — power of the whole channel'},
          {n:'sound',t:'check',d:true,label:'sound'},
          {n:'vol',t:'range',min:0,max:1,step:.05,d:.25,label:'volume'},
          {n:'tol',t:'range',min:100,max:200000,step:100,log:true,d:5000,label:'target window ±, Hz'},
          {n:'fastS',t:'range',min:0,max:3,step:.05,d:.3,label:'fast average, s'},
          {n:'range',t:'range',min:1,max:30,step:.5,d:10,label:'tone range, dB (from the best to the lowest pitch)'},
          {n:'span',t:'range',min:2,max:40,step:1,d:12,label:'bar scale, dB under the best'},
          {n:'reset',t:'button',label:'Reset best',fn:n=>{ n._rst=1; }},
          {n:'relock',t:'button',label:'Re-lock on the strongest',fn:n=>{ n.f=null; n._rst=1; }},
          {n:'slowS',t:'range',min:.5,max:30,step:.5,d:4,label:'slow average, s',adv:true},
          {n:'dead',t:'range',min:0,max:3,step:.05,d:.3,label:'dead zone, dB (counts as «at the best»)',adv:true},
          {n:'decay',t:'range',min:0,max:6,step:.05,d:0,label:'best fades, dB/min (fading signal)',adv:true},
          {n:'fMin',t:'range',min:100,max:2000,step:10,d:250,label:'lowest pitch, Hz',adv:true},
          {n:'fMax',t:'range',min:300,max:4000,step:10,d:1500,label:'highest pitch, Hz',adv:true},
          {n:'wave',t:'select',opts:['sine','triangle','square','sawtooth'],d:'sine',label:'wave',adv:true}],
  init:n=>{ n.st=apInit(); n.f=null; n._t=0; n._rst=0; n._rp=0; n._lastRev=undefined; n._lastSp=null;
    n.delta=NaN; n.hz=NaN; n.msg=''; n.err=''; n.osc=null; n.gn=null; },
  dispose:n=>{ try{ n.osc?.stop(); n.osc?.disconnect(); n.gn?.disconnect(); }catch(e){} n.osc=n.gn=null; },
  process(n,I){
    const p=n.p, now=performance.now(), rp=+I.reset>.5;
    if(n._rst || (rp && !n._rp)){ apReset(n.st); n._rst=0; n._t=0; }
    n._rp=rp;
    let x=NaN, fresh=false;
    if(typeof I.in==='number' && isFinite(I.in)){ x=I.in; fresh=true; n.msg=''; }
    else if(I.spec){
      const sp=I.spec; fresh=sp.rev!=null ? sp.rev!==n._lastRev : sp!==n._lastSp;
      if(fresh){
        n._lastRev=sp.rev; n._lastSp=sp;
        const f=typeof I.f==='number' && I.f>0 ? I.f : n.f ?? (()=>{ const b=goPeakBin(sp); return b>=0 ? specHz(sp,b) : null; })();
        if(f==null){ n.msg='no signal'; fresh=false; }
        else {
          n.f=f; n.msg='';
          const N=sp.mag.length, a=clamp(Math.floor(specBin(sp,f-p.tol)),0,N-1), b=clamp(Math.ceil(specBin(sp,f+p.tol)),0,N-1);
          x=apLevel(sp.mag,a,b,saNoiseFloor(sp,f,p.tol),p.meas); }
      }
    } else n.msg='connect a spectrum or a level';
    if(fresh){
      const dt=n._t ? Math.min(1,(now-n._t)/1000) : 0; n._t=now;
      apFeed(n.st,x,dt,{fastS:p.fastS,slowS:p.slowS,decay:p.decay/60}); }
    const st=n.st, live=st.n>0 && (now-n._t)<1500;
    n.delta=live ? apDelta(st,p.mode) : NaN;
    n.hz=live ? apTone(n.delta,p.mode,{fMin:p.fMin,fMax:Math.max(p.fMax,p.fMin*1.1),range:p.range,dead:p.dead}) : NaN;
    apSound(n,n.hz,p.sound && live);
    n.text=live ? 'SNR '+st.fast.toFixed(1)+' dB · best '+st.best.toFixed(1)+' · Δ '+n.delta.toFixed(1)+(n.f&&!(typeof I.in==='number') ? ' · '+fmtHz(n.f,4)+'Hz' : '') : n.msg||'waiting for the signal';
    return {snr:live?st.fast:null, best:live?st.best:null, delta:live?n.delta:null, tone:live?n.hz:null, text:n.text}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, st=n.st, p=n.p, live=Number.isFinite(n.delta);
    cx.clearRect(0,0,W,H);
    cx.textBaseline='middle';
    const big=Math.max(14,Math.min(H*.34,W*.16)), small=Math.max(8,Math.min(11,H*.09));
    if(!live){
      cx.fillStyle=themeColor('--axis'); cx.font=small+'px monospace'; cx.textAlign='center';
      cx.fillText((n.msg||'waiting for the signal')+(n.err?' · '+n.err:''),W/2,H/2); cx.textAlign='start'; return; }
    const d=n.delta, atBest=p.mode==='best' ? d>=-p.dead-.05 : Math.abs(d)<=p.dead;
    const col=p.mode==='best'
      ? (atBest ? themeColor('--scr-ok') : d>-2 ? themeColor('--scr-warn') : themeColor('--scr-bad'))
      : (atBest ? themeColor('--axis') : d>0 ? themeColor('--scr-ok') : themeColor('--scr-bad'));
    cx.fillStyle=themeColor('--scr-hi'); cx.font='bold '+big+'px monospace'; cx.textAlign='left';
    const num=st.fast.toFixed(1), nw=cx.measureText(num).width;
    cx.fillText(num,8,big*.75);
    cx.font=small+'px monospace'; cx.fillStyle=themeColor('--axis'); cx.fillText('dB',12+nw,big*.75+big*.2);
    cx.fillStyle=col; cx.font='bold '+big*.8+'px monospace'; cx.textAlign='right';
    cx.fillText((d>0?'+':d<0?'−':'')+Math.abs(d).toFixed(1),W-8,big*.7);
    // бар: окно под лучшим, крупно там, где важна десятая дБ
    const [lo,hi]=apScale(st,p.span), bx=8, bw=W-16, by=big*1.35, bh=Math.max(10,Math.min(H*.2,22)), X=v=>bx+bw*clamp((v-lo)/(hi-lo),0,1);
    cx.fillStyle=themeColor('--scr-panel'); cx.fillRect(bx,by,bw,bh);
    cx.fillStyle=col; cx.globalAlpha=.85; cx.fillRect(bx,by,X(st.fast)-bx,bh); cx.globalAlpha=1;
    cx.strokeStyle=themeColor('--axis'); cx.lineWidth=1; cx.beginPath();
    for(let v=Math.ceil(lo);v<=hi;v++){ const x=Math.round(X(v))+.5; cx.moveTo(x,by+bh); cx.lineTo(x,by+bh+(v%5===0?5:3)); }
    cx.stroke();
    const tick=(v,c,w)=>{ const x=Math.round(X(v))+.5; cx.strokeStyle=c; cx.lineWidth=w; cx.beginPath(); cx.moveTo(x,by-3); cx.lineTo(x,by+bh+3); cx.stroke(); };
    tick(st.slow,themeColor('--acc2'),1.5); tick(st.best,themeColor('--scr-hi'),2);
    cx.fillStyle=themeColor('--axis'); cx.font=small+'px monospace'; cx.textAlign='left';
    cx.fillText(lo.toFixed(0),bx,by+bh+small+4); cx.textAlign='right'; cx.fillText(hi.toFixed(0),bx+bw,by+bh+small+4);
    cx.textAlign='center'; cx.fillText('best '+st.best.toFixed(1)+' · slow '+st.slow.toFixed(1)+(Number.isFinite(n.hz) ? ' · '+n.hz.toFixed(0)+' Hz' : ''),W/2,H-small*.7);
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});
