"use strict";
/* ============================ Activity Events ============================
   Спектр (USB SDR, fft) → занятость сетки каналов → событие «канал занят с … на …» (rec: t, dur — мс, freq — МГц, ch, rssi, avg, snr).
   Rec → Table (хранилище) → Timeline. Развёртка SDR: канал вне текущего окна не наблюдается, его состояние не меняется.
   Ядро — activity-kernels.js, проверка: node tools/test-activity.mjs */

function actLevels(n,s,lo,step,count,bw){                      // уровни каналов, дБ; null — вне окна спектра
  const [sLo,sHi]=specSpan(s), N=s.mag.length, out=new Array(count).fill(null);
  for(let k=0;k<count;k++){
    const f=lo+k*step, a=f-bw/2, b=f+bw/2;
    if(a<sLo || b>sHi) continue;
    const i0=clamp(Math.round(specBin(s,a)),0,N-1), i1=clamp(Math.round(specBin(s,b)),0,N-1);
    let p=0,c=0; for(let i=Math.min(i0,i1);i<=Math.max(i0,i1);i++){ p+=s.mag[i]*s.mag[i]; c++; }
    out[k]=10*Math.log10(p/c+1e-24);
  }
  return out;
}

def({ id:'actlog', title:'Activity Events', cat:'Analysis', readout:true, w:300,
  kw:'activity channels occupancy transmissions events duration timeline spectrum sdr scanner log busy squelch grid',
  ins:[{n:'spec',t:'spec'},{n:'lo',t:'num'},{n:'step',t:'num'}],
  outs:[{n:'rec',t:'rec'},{n:'active',t:'num'},{n:'count',t:'num'}],
  params:[{n:'lo',t:'num',d:0,label:'first channel centre, Hz (0 — start of the spectrum + half a step)'},
          {n:'step',t:'num',min:1,d:12500,label:'channel step, Hz'},
          {n:'count',t:'range',min:1,max:128,step:1,d:16,label:'channels'},
          {n:'bw',t:'num',min:1,d:0,label:'channel width, Hz (0 — 80 % of the step)'},
          {n:'thr',t:'range',min:2,max:40,step:.5,d:8,label:'busy above the channel floor, dB'},
          {n:'hys',t:'range',min:0,max:20,step:.5,d:3,label:'hysteresis, dB'},
          {n:'hold',t:'range',min:0,max:5000,step:10,d:300,label:'hold, ms (a pause shorter than this does not end a transmission)'},
          {n:'minDur',t:'range',min:0,max:2000,step:5,d:20,label:'shortest event, ms'},
          {n:'learn',t:'range',min:0,max:30000,step:100,d:3000,label:'learn the noise floor first, ms'},
          {n:'rise',t:'range',min:0,max:20,step:.1,d:1,label:'floor may rise, dB/s (follows the drift)'},
          {n:'rst',t:'button',label:'Reset',fn:n=>{ n.st=actNew(); n.cnt=0; n.recent=[]; }}],
  init:n=>{ n.st=actNew(); n.cnt=0; n.recent=[]; n.txt='wire a spectrum'; n.lastT=0; n.lv=null; },
  process(n,I){
    const s=I.spec, now=performance.now();
    for(const k of ['lo','step']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    if(!s || !s.mag){ n.txt='wire a spectrum'; return {rec:null,active:0,count:n.cnt}; }
    if(now-n.lastT<15) return {rec:null,active:actActive(n.st),count:n.cnt};
    n.lastT=now;
    const p=n.p, step=Math.max(1,+p.step||12500), bw=+p.bw>0 ? +p.bw : step*.8, [sLo]=specSpan(s);
    const lo=+p.lo>0 ? +p.lo : sLo+step/2, count=p.count|0;
    const key=lo+'|'+step+'|'+count;
    if(key!==n.key){ n.key=key; n.st=actNew(); }                    // сетка поменялась — пол шума учим заново
    const lv=n.lv=actLevels(n,s,lo,step,count,bw);
    const ev=actStep(n.st,lv,now,{thr:+p.thr,hys:+p.hys,hold:+p.hold,minDur:+p.minDur,learn:+p.learn,rise:+p.rise});
    const wall=Date.now()-now, recs=ev.map(e=>({t:Math.round(wall+e.t0),dur:Math.round(e.dur),freq:Math.round((lo+e.ch*step)/10)/1e5,ch:e.ch+1,
      rssi:Math.round(e.peak*10)/10,avg:Math.round(e.avg*10)/10,snr:Math.round(e.snr*10)/10}));
    n.cnt+=recs.length; if(recs.length) n.recent=n.recent.concat(recs).slice(-6);
    const obs=lv.filter(v=>v!=null).length;
    n.txt=count+' ch from '+fmtHz(lo,3)+'Hz, step '+fmtHz(step,2)+'Hz · seen '+obs+' · '+(now-n.st.t0<+p.learn ? 'learning the floor…' : 'busy '+actActive(n.st)+' · events '+n.cnt)
      +(n.recent.length ? '\n'+n.recent.slice(-3).map(r=>r.freq+' MHz '+r.dur+' ms '+r.rssi+' dB').join('\n') : '');
    return {rec:recs.length ? recs : null, active:actActive(n.st), count:n.cnt};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(r){ r.style.whiteSpace='pre-wrap'; if(r.textContent!==n.txt) r.textContent=n.txt; } }});
