"use strict";
/* ============================ STUDIO: АУДИО-ДВИЖОК (Web Audio) ============================
   StRig — граф звука проекта на любом AudioContext (живом или Offline): каналы → вставки микшера (эффекты, панорама,
   фейдер, посылы) → мастер → лимитер. StSched — раскладывает ноты и автоматизацию отрезка тиков по времени контекста,
   один и тот же код ведёт и проигрывание, и экспорт WAV. StEngine — транспорт с опережающим планировщиком. */

/* ---------- общие помощники ---------- */
const stTC=(p,v,w,ac,tc)=>{ p.setTargetAtTime(v,Math.max(w==null?ac.currentTime:w,ac.currentTime),tc||.012); };
const stNoiseBuf=ac=>{
  if(ac._stNoise) return ac._stNoise;
  const n=ac.sampleRate*2, b=ac.createBuffer(1,n,ac.sampleRate), d=b.getChannelData(0);
  let s=22222; for(let i=0;i<n;i++){ s=(s*1664525+1013904223)>>>0; d[i]=s/2147483648-1; }
  return ac._stNoise=b;
};
const stCurveCache=new Map();
const stCurve=(a,t)=>{ const k=t+Math.round(a*40); let c=stCurveCache.get(k); if(!c){ c=stDriveCurve(a,t); stCurveCache.set(k,c); } return c; };
function stNoiseSrc(ac,t){
  const s=ac.createBufferSource(); s.buffer=stNoiseBuf(ac); s.loop=true; s.loopStart=0; s.loopEnd=2;
  s.start(t,Math.random()*1.9); return s;
}
const stBiq=(ac,type,f,q)=>{ const b=ac.createBiquadFilter(); b.type=type; b.frequency.value=f; if(q!=null) b.Q.value=q; return b; };
const stGain=(ac,v)=>{ const g=ac.createGain(); g.gain.value=v==null?1:v; return g; };
const stOscT={saw:'sawtooth',square:'square',sine:'sine',tri:'triangle'};
const stFiltT={lp:'lowpass',hp:'highpass',bp:'bandpass',notch:'notch'};

// огибающая на AudioParam: вверх за a, спад к s·peak; release(off) дорисует хвост
function stEnvOn(param,t,peak,a,d,s,base){
  a=Math.max(a,.002);
  param.setValueAtTime(base||0,t); param.linearRampToValueAtTime(peak,t+a);
  param.setTargetAtTime(peak*s,t+a,Math.max(d/4,.001));
}
function stEnvOff(param,t0,off,peak,a,d,s,r,base){
  const val=(base||0)+(peak-(base||0))*stAdsrAt(off-t0,a,d,s,r,null);
  param.cancelScheduledValues(off);
  if(off-t0<Math.max(a,.002)) param.linearRampToValueAtTime(val,off); else param.setValueAtTime(val,off);
  param.setTargetAtTime(base||0,off,Math.max(r/4,.001));
}

/* ---------- эффекты: каждый — {in,out,update(p,bpm,when),sched?(a,b,toTime)} ---------- */
function stMakeFx(ac,type,p,bpm){
  const inn=stGain(ac), out=stGain(ac), fx={in:inn,out,type,nodes:[]};
  const dw=(wetNode)=>{ const dry=stGain(ac), wet=stGain(ac); inn.connect(dry); dry.connect(out); wetNode(wet); wet.connect(out);
    fx.mixSet=(m,w,tt)=>{ stTC(dry.gain,1-m*(type==='delay'||type==='reverb'||type==='chorus'?0:1),w,ac); stTC(wet.gain,m,w,ac); }; return wet; };
  switch(type){
    case 'eq':{
      const lo=stBiq(ac,'lowshelf',120), mid=stBiq(ac,'peaking',1000,1), hi=stBiq(ac,'highshelf',6000);
      inn.connect(lo); lo.connect(mid); mid.connect(hi); hi.connect(out);
      fx.update=(q,b,w)=>{ stTC(lo.gain,q.lo,w,ac); stTC(lo.frequency,q.lf,w,ac); stTC(mid.gain,q.mid,w,ac); stTC(mid.frequency,q.mf,w,ac);
        stTC(mid.Q,q.q,w,ac); stTC(hi.gain,q.hi,w,ac); stTC(hi.frequency,q.hf,w,ac); }; break; }
    case 'filter':{
      const f=stBiq(ac,'lowpass',2000,1); dw(w=>{ f.connect(w); inn.connect(f); });
      fx.update=(q,b,w)=>{ f.type=stFiltT[q.type]||'lowpass'; stTC(f.frequency,q.cut,w,ac); stTC(f.Q,q.res,w,ac); fx.mixSet(q.mix,w); }; break; }
    case 'comp':{
      const c=ac.createDynamicsCompressor(), g=stGain(ac); inn.connect(c); c.connect(g); g.connect(out);
      fx.update=(q,b,w)=>{ c.threshold.value=q.thr; c.ratio.value=q.ratio; c.attack.value=q.att; c.release.value=q.rel; c.knee.value=q.knee;
        stTC(g.gain,Math.pow(10,q.gain/20),w,ac); }; fx.red=()=>c.reduction; break; }
    case 'delay':{
      const dL=ac.createDelay(4), dR=ac.createDelay(4), tone=stBiq(ac,'lowpass',5000), fbA=stGain(ac,0), fbB=stGain(ac,0), fbS=stGain(ac,0);
      const pL=ac.createStereoPanner(), pR=ac.createStereoPanner(), wet=stGain(ac,0), dry=stGain(ac);
      inn.connect(dry); dry.connect(out);
      inn.connect(dL); dL.connect(tone); tone.connect(fbA); fbA.connect(dR); dR.connect(fbB); fbB.connect(dL);
      tone.connect(fbS); fbS.connect(dL);
      dL.connect(pL); dR.connect(pR); pL.connect(wet); pR.connect(wet); wet.connect(out);
      fx.update=(q,b,w)=>{
        const t=ST_DIV[q.div]*60/b; stTC(dL.delayTime,t,w,ac,.03); stTC(dR.delayTime,t,w,ac,.03);
        stTC(tone.frequency,q.tone,w,ac);
        stTC(fbA.gain,q.pp?q.fb:0,w,ac); stTC(fbB.gain,q.pp?q.fb:0,w,ac); stTC(fbS.gain,q.pp?0:q.fb,w,ac);
        pL.pan.value=q.pp?-.8:0; pR.pan.value=q.pp?.8:0; stTC(wet.gain,q.mix,w,ac); }; break; }
    case 'reverb':{
      const pre=ac.createDelay(.5), cv=ac.createConvolver(), lc=stBiq(ac,'highpass',120), wet=stGain(ac,0), dry=stGain(ac);
      inn.connect(dry); dry.connect(out); inn.connect(pre); pre.connect(cv); cv.connect(lc); lc.connect(wet); wet.connect(out);
      let key='';
      fx.update=(q,b,w)=>{
        const k=q.size.toFixed(2)+'|'+q.damp.toFixed(2);
        if(k!==key){ key=k; const ir=stReverbIR(ac.sampleRate,q.size,q.damp), buf=ac.createBuffer(2,ir[0].length,ac.sampleRate);
          buf.copyToChannel(ir[0],0); buf.copyToChannel(ir[1],1); cv.buffer=buf; }
        stTC(pre.delayTime,q.pre,w,ac); stTC(lc.frequency,q.lc,w,ac); stTC(wet.gain,q.mix*.6,w,ac); stTC(dry.gain,1-q.mix*.35,w,ac); }; break; }
    case 'chorus':{
      const wet=stGain(ac,0), dry=stGain(ac), lfo=ac.createOscillator(), dl=[ac.createDelay(.1),ac.createDelay(.1)], dg=[stGain(ac),stGain(ac)];
      inn.connect(dry); dry.connect(out);
      lfo.type='sine'; lfo.start();
      dl.forEach((d,i)=>{ d.delayTime.value=.012+i*.008; inn.connect(d); lfo.connect(dg[i]); dg[i].connect(d.delayTime);
        const pn=ac.createStereoPanner(); pn.pan.value=i?.7:-.7; d.connect(pn); pn.connect(wet); });
      dg[1].gain.value=-1; wet.connect(out);
      fx.update=(q,b,w)=>{ stTC(lfo.frequency,q.rate,w,ac); dg[0].gain.value=q.depth*.004; dg[1].gain.value=-q.depth*.004;
        stTC(wet.gain,q.mix,w,ac); stTC(dry.gain,1-q.mix*.5,w,ac); }; fx.nodes=[lfo]; break; }
    case 'phaser':{
      const wet=stGain(ac,0), dry=stGain(ac), lfo=ac.createOscillator(), lg=stGain(ac,0), fb=stGain(ac,0), fd=ac.createDelay(.05);
      const aps=[0,1,2,3].map(()=>stBiq(ac,'allpass',800,.8));
      inn.connect(dry); dry.connect(out); lfo.start();
      let prev=inn; for(const a of aps){ prev.connect(a); prev=a; lfo.connect(lg); lg.connect(a.detune); }
      prev.connect(wet); wet.connect(out); prev.connect(fd); fd.connect(fb); fb.connect(aps[0]); fd.delayTime.value=.003;
      fx.update=(q,b,w)=>{ stTC(lfo.frequency,q.rate,w,ac); lg.gain.value=q.depth*2400; stTC(fb.gain,q.fb,w,ac);
        stTC(wet.gain,q.mix,w,ac); stTC(dry.gain,1-q.mix*.4,w,ac); }; break; }
    case 'dist':{
      const pre=stGain(ac), sh=ac.createWaveShaper(), tone=stBiq(ac,'lowpass',8000), og=stGain(ac,.8); sh.oversample='2x';
      dw(w=>{ inn.connect(pre); pre.connect(sh); sh.connect(tone); tone.connect(og); og.connect(w); });
      fx.update=(q,b,w)=>{ if(fx._k!==q.type+q.drive){ fx._k=q.type+q.drive; sh.curve=stCurve(q.drive,q.type); }
        stTC(tone.frequency,q.tone,w,ac); stTC(og.gain,q.out,w,ac); fx.mixSet(q.mix,w); }; break; }
    case 'crush':{
      const sh=ac.createWaveShaper(); dw(w=>{ inn.connect(sh); sh.connect(w); });
      fx.update=(q,b,w)=>{ if(fx._k!==q.bits){ fx._k=q.bits; sh.curve=stCrushCurve(q.bits); } fx.mixSet(q.mix,w); }; break; }
    case 'pump':{
      const g=stGain(ac); inn.connect(g); g.connect(out); fx.g=g; fx.q={div:'1/4',depth:.8,rel:.45,off:0};
      fx.update=(q)=>{ fx.q=q; };
      fx.sched=(a,b,toTime,bpm2)=>{
        const step=ST_DIV[fx.q.div]*ST_PPQ, off=fx.q.off*ST_PPQ, beat=60/bpm2;
        for(let t=Math.ceil((a-off)/step)*step+off;t<b;t+=step){
          const tm=toTime(t); if(tm<ac.currentTime-.01 && !ac._stOffline) continue;
          g.gain.cancelScheduledValues(tm); g.gain.setValueAtTime(1-fx.q.depth,tm);
          g.gain.setTargetAtTime(1,tm+.004,Math.max(.01,fx.q.rel*beat*ST_DIV[fx.q.div]/3));
        }
      }; break; }
    case 'gate':{
      const g=stGain(ac); inn.connect(g); g.connect(out); fx.g=g; fx.q={div:'1/16',depth:1,len:.5,pat:'even'};
      fx.update=(q)=>{ fx.q=q; };
      fx.sched=(a,b,toTime)=>{
        const q=fx.q, step=ST_DIV[q.div]*ST_PPQ, lowv=1-q.depth;
        const on=i=>q.pat==='even'||q.pat==='roll' ? true : q.pat==='offbeat' ? i%2===1 : q.pat==='x.xx' ? [0,2,3].includes(i%4) : [0,1,3].includes(i%4);
        for(let i=Math.ceil(a/step);i*step<b;i++){
          const t=i*step, tm=toTime(t), tl=toTime(t+step*(q.pat==='roll'?q.len*.5:q.len));
          if(on(i)){ g.gain.setTargetAtTime(1,tm,.002); g.gain.setTargetAtTime(lowv,tl,.003); }
        }
        if(!fx._init){ fx._init=1; g.gain.setValueAtTime(lowv,0); }
      }; break; }
    case 'width':{
      const sp=ac.createChannelSplitter(2), mg=ac.createChannelMerger(2), mid=stGain(ac), side=stGain(ac), inv=stGain(ac,-1), pn=ac.createStereoPanner();
      const mL=stGain(ac,.5), mR=stGain(ac,.5), sL=stGain(ac,.5), sR=stGain(ac,-.5);
      inn.connect(sp); sp.connect(mL,0); sp.connect(mR,1); sp.connect(sL,0); sp.connect(sR,1);
      mL.connect(mid); mR.connect(mid); sL.connect(side); sR.connect(side);
      mid.connect(mg,0,0); side.connect(mg,0,0); mid.connect(mg,0,1); side.connect(inv); inv.connect(mg,0,1);
      mg.connect(pn); pn.connect(out);
      fx.update=(q,b,w)=>{ stTC(side.gain,q.width,w,ac); stTC(pn.pan,q.pan,w,ac); }; break; }
  }
  fx.update(stFillP(ST_FX[type].p,p),bpm);
  return fx;
}

/* ---------- голоса ---------- */
// ударные: свои графы на килограммы нод, но без буферов — всё синтезом
function stDrumVoice(rig,ch,p,key,vel,t){
  const ac=rig.ac, out=stGain(ac,0), v=Math.pow(vel/127,1.3)*p.vol, kind=p.kind, dec=p.dec, k2=Math.pow(2,(p.pit+(key-60))/12);
  const stops=[]; let end=t+1;
  const dst=p.drv>0.01 ? (()=>{ const s=ac.createWaveShaper(); s.curve=stCurve(p.drv,'soft'); s.connect(out); return s; })() : out;
  const env=(g,peak,tau,at)=>{ g.gain.setValueAtTime(0,at||t); g.gain.linearRampToValueAtTime(peak,(at||t)+.002); g.gain.setTargetAtTime(0,(at||t)+.002,tau); };
  const osc=(type,f)=>{ const o=ac.createOscillator(); o.type=type; o.frequency.value=f; o.start(t); stops.push(o); return o; };
  const noise=()=>{ const n=stNoiseSrc(ac,t); stops.push(n); return n; };
  out.gain.setValueAtTime(1,t);
  if(kind==='kick'){
    const fe=(42+p.tone*30)*k2, fs=fe*(2.5+p.pun*7), o=osc('sine',fs), g=stGain(ac,0);
    o.frequency.setValueAtTime(fs,t); o.frequency.exponentialRampToValueAtTime(fe,t+.02+.07*(.4+p.pun*.6));
    env(g,v,.11*dec); o.connect(g); g.connect(dst);
    if(p.pun>.05){ const n=noise(), hp=stBiq(ac,'highpass',1500), cg=stGain(ac,0); env(cg,v*p.pun*.5,.004); n.connect(hp); hp.connect(cg); cg.connect(dst); }
    end=t+.9*dec+.2;
  }else if(kind==='snare'){
    const o=osc('triangle',185*k2), og=stGain(ac,0), n=noise(), bp=stBiq(ac,'highpass',1400+p.tone*1200), ng=stGain(ac,0);
    o.frequency.setValueAtTime(260*k2,t); o.frequency.exponentialRampToValueAtTime(175*k2,t+.05);
    env(og,v*(.9-p.tone*.5),.05*dec); env(ng,v*(.5+p.tone*.6),.075*dec*(.7+p.tone));
    o.connect(og); og.connect(dst); n.connect(bp); bp.connect(ng); ng.connect(dst); end=t+.7*dec+.1;
  }else if(kind==='clap'){
    const n=noise(), bp=stBiq(ac,'bandpass',1000+p.tone*1200,.9), g=stGain(ac,0);
    n.connect(bp); bp.connect(g); g.connect(dst);
    g.gain.setValueAtTime(0,t);
    [0,.011,.022].forEach(d=>{ g.gain.setValueAtTime(v*1.4,t+d); g.gain.setTargetAtTime(0,t+d+.001,.004); });
    g.gain.setValueAtTime(v*1.4,t+.034); g.gain.setTargetAtTime(0,t+.036,.07*dec); end=t+.6*dec+.1;
  }else if(kind==='chat' || kind==='ohat' || kind==='crash'){
    const hp=stBiq(ac,'highpass',kind==='crash'?4000:6500+p.tone*2500), bp=stBiq(ac,'bandpass',kind==='crash'?7500:10000,.7), g=stGain(ac,0);
    for(const r of [2,3,4.16,5.43,6.79,8.21]){ const o=osc('square',40*r*k2*(kind==='crash'?1.3:1)), s=stGain(ac,.17); o.connect(s); s.connect(bp); }
    const n=noise(), ns=stGain(ac,.3+p.tone*.4); n.connect(ns); ns.connect(bp);
    bp.connect(hp); hp.connect(g); g.connect(dst);
    const tau=(kind==='chat'?.022:kind==='ohat'?.12:.55)*dec;
    env(g,v*.75,tau); end=t+tau*7+.05;
    if(kind==='chat' || kind==='ohat'){ const prev=rig.hatVoice[ch.mix||0]; if(prev) prev.kill(t); rig.hatVoice[ch.mix||0]=null; }
  }else if(kind==='tom'){
    const f=105*k2, o=osc('sine',f*2), g=stGain(ac,0);
    o.frequency.setValueAtTime(f*2.1,t); o.frequency.exponentialRampToValueAtTime(f,t+.09);
    env(g,v,.13*dec); o.connect(g); g.connect(dst); end=t+.9*dec;
  }else if(kind==='rim'){
    const o=osc('sine',1700*k2), o2=osc('triangle',480*k2), g=stGain(ac,0), n=noise(), ng=stGain(ac,0);
    env(g,v*.7,.012*dec); env(ng,v*.4,.01); o.connect(g); o2.connect(g); n.connect(ng); ng.connect(g); g.connect(dst); end=t+.2*dec;
  }else{ // perc / cowbell
    const bp=stBiq(ac,'bandpass',2640*k2,1.4), g=stGain(ac,0);
    for(const f of [540,800]){ const o=osc('square',f*k2); o.connect(bp); }
    bp.connect(g); g.connect(dst); env(g,v*.7,.12*dec); end=t+.9*dec+.1;
  }
  out.connect(rig.chs.get(ch.id).gain);
  for(const s of stops) s.stop(end);
  const vc={kill(tt){ out.gain.cancelScheduledValues(tt); out.gain.setTargetAtTime(0,tt,.004); },release(){}, end};
  if(kind==='chat' || kind==='ohat') rig.hatVoice[ch.mix||0]=vc;
  return vc;
}

function stSynthVoice(rig,ch,p,key,vel,t,off){
  const ac=rig.ac, f0=stHz(key), v=Math.pow(vel/127,1.2)*p.vol;
  const uni=Math.max(1,p.uni|0), spr=p.spr, oscs=[], stops=[];
  const bus=stGain(ac), flt=stBiq(ac,stFiltT[p.ft]||'lowpass',1000,p.res), vca=stGain(ac,0);
  const cutHz=Math.min(18000,Math.max(30,p.cut*Math.pow(2,(key-60)/12*p.fkey)));
  flt.frequency.value=cutHz;
  const peakC=p.fenv*1200;
  if(peakC!==0){ stEnvOn(flt.detune,t,peakC,p.fa,p.fd,p.fs,0); }
  let tail=bus;
  bus.connect(flt); tail=flt;
  if(p.drv>.01){ const sh=ac.createWaveShaper(); sh.curve=stCurve(p.drv,'soft'); tail.connect(sh); tail=sh; }
  let trem=null;
  if(p.lt==='amp'){ trem=stGain(ac,1-p.ld*.5); tail.connect(trem); tail=trem; }
  tail.connect(vca); vca.connect(rig.chs.get(ch.id).gain);
  const gmul=1/Math.sqrt(uni);
  const mk=(type,freq,cents)=>{ const o=ac.createOscillator(); o.type=type; o.frequency.value=freq; o.detune.value=cents; oscs.push(o); stops.push(o); return o; };
  const prev=p.mono ? rig.monoLast[ch.id] : null;
  for(let u=0;u<uni;u++){
    const pos=uni===1?0:u/(uni-1)*2-1, det=pos*p.det, pn=ac.createStereoPanner(); pn.pan.value=pos*spr; pn.connect(bus);
    const fr1=f0*Math.pow(2,p.o1+p.s1/12), fr2=f0*Math.pow(2,p.o2+p.s2/12);
    if(p.l1>0 || p.fm>0){
      const o1=mk(stOscT[p.w1],fr1,det), g1=stGain(ac,p.l1*gmul*.6); o1.connect(g1); g1.connect(pn);
      if(prev && p.gl>0){ o1.frequency.setValueAtTime(prev.f*Math.pow(2,p.o1+p.s1/12),t); o1.frequency.exponentialRampToValueAtTime(fr1,t+p.gl); }
      if(p.fm>0 || p.l2>0){
        const o2=mk(stOscT[p.w2],fr2,det+p.dt2);
        if(p.fm>0){ const mg=stGain(ac,p.fm*fr2*6); o2.connect(mg); mg.connect(o1.frequency); }
        if(p.l2>0){ const g2=stGain(ac,p.l2*gmul*.6); o2.connect(g2); g2.connect(pn); }
      }
    }else if(p.l2>0){
      const o2=mk(stOscT[p.w2],fr2,det+p.dt2), g2=stGain(ac,p.l2*gmul*.6); o2.connect(g2); g2.connect(pn);
    }
  }
  if(p.sub>0){ const o=mk('sine',f0/2,0), g=stGain(ac,p.sub*.7); o.connect(g); g.connect(bus); }
  if(p.noi>0){ const n=stNoiseSrc(ac,t), g=stGain(ac,p.noi*.4); n.connect(g); g.connect(bus); stops.push(n); }
  if(p.lt!=='off' && p.ld>0){
    const lfo=ac.createOscillator(), lg=stGain(ac,0); lfo.type=stOscT[p.lw]||'sine'; lfo.frequency.value=p.lr;
    lfo.connect(lg); stops.push(lfo);
    if(p.lt==='pitch'){ lg.gain.value=p.ld*300; for(const o of oscs) lg.connect(o.detune); }
    else if(p.lt==='cutoff'){ lg.gain.value=p.ld*2400; lg.connect(flt.detune); }
    else if(trem){ lg.gain.value=p.ld*.5; lg.connect(trem.gain); }
    lfo.start(t);
  }
  for(const o of oscs) if(o.start) try{ o.start(t); }catch(e){}
  stEnvOn(vca.gain,t,v,p.a,p.d,p.s,0);
  const voice={f:f0, end:Infinity};
  voice.release=(tt)=>{
    stEnvOff(vca.gain,t,tt,v,p.a,p.d,p.s,p.r,0);
    if(peakC!==0) stEnvOff(flt.detune,t,tt,peakC,p.fa,p.fd,p.fs,p.fr,0);
    voice.end=tt+stRelEnd(p.r)+.05; for(const s of stops) try{ s.stop(voice.end); }catch(e){}
  };
  voice.kill=(tt)=>{ vca.gain.cancelScheduledValues(tt); vca.gain.setTargetAtTime(0,tt,.006); voice.end=tt+.06; for(const s of stops) try{ s.stop(tt+.06); }catch(e){} };
  if(off!=null) voice.release(off);
  if(p.mono){ if(prev) prev.kill(t); rig.monoLast[ch.id]=voice; }
  return voice;
}

function stSampleVoice(rig,ch,p,key,vel,t,off){
  const ac=rig.ac, sm=rig.samples[ch.id]; if(!sm) return {release(){},kill(){}};
  const src=ac.createBufferSource(), g=stGain(ac,0), v=Math.pow(vel/127,1.2)*p.vol;
  src.buffer=p.rev ? (sm.rev||(sm.rev=stReverseBuf(ac,sm.buf))) : sm.buf;
  src.playbackRate.value=Math.pow(2,(key-p.root)/12+p.pit/12); src.loop=!!p.loop;
  const dur=sm.buf.duration; const st=p.start*dur;
  src.connect(g); g.connect(rig.chs.get(ch.id).gain);
  src.start(t,st);
  stEnvOn(g.gain,t,v,p.a,.001,1,0);
  const voice={end:Infinity};
  voice.release=(tt)=>{
    if(p.one && !p.loop) return;                 // пэд-режим: играет до конца, ноту не обрывает
    stEnvOff(g.gain,t,tt,v,p.a,.001,1,p.r,0); voice.end=tt+stRelEnd(p.r); try{ src.stop(voice.end); }catch(e){}
  };
  voice.kill=(tt)=>{ g.gain.cancelScheduledValues(tt); g.gain.setTargetAtTime(0,tt,.006); try{ src.stop(tt+.06); }catch(e){} };
  if(off!=null) voice.release(off);
  return voice;
}
function stReverseBuf(ac,b){
  const r=ac.createBuffer(b.numberOfChannels,b.length,b.sampleRate);
  for(let c=0;c<b.numberOfChannels;c++){ const s=b.getChannelData(c), d=r.getChannelData(c); for(let i=0;i<s.length;i++) d[i]=s[s.length-1-i]; }
  return r;
}

/* ---------- граф проекта ---------- */
class StRig{
  constructor(ac,P,samples,dest){
    this.ac=ac; this.P=P; this.samples=samples||{}; this.hatVoice={}; this.monoLast={}; this.voices=[]; this.ins=[]; this.chs=new Map(); this.ac._stOffline=ac instanceof OfflineAudioContext;
    this.bpm=P.bpm;
    const lim=ac.createDynamicsCompressor(); lim.threshold.value=-1.5; lim.knee.value=0; lim.ratio.value=20; lim.attack.value=.002; lim.release.value=.08;
    const an=ac.createAnalyser(); an.fftSize=2048; an.smoothingTimeConstant=.7;
    for(let i=0;i<=ST_INSERTS;i++){
      const o={in:stGain(ac), pan:ac.createStereoPanner(), vol:stGain(ac), out:stGain(ac), an:ac.createAnalyser(), fx:[], sends:new Map()};
      o.an.fftSize=1024;
      o.pan.connect(o.vol); o.vol.connect(o.out); o.out.connect(o.an);
      this.ins.push(o);
    }
    const m=this.ins[0]; const clip=ac.createWaveShaper(), cc=new Float32Array(4097);        // мягкий потолок над лимитером: не выше 1.0
    for(let i=0;i<cc.length;i++){ const x=i/2048-1, a=Math.abs(x); cc[i]=a<=.8?x:Math.sign(x)*(.8+.2*Math.tanh((a-.8)/.2)); }
    clip.curve=cc; m.out.connect(lim); lim.connect(clip); clip.connect(an); an.connect(dest||ac.destination); this.masterAn=an; this.lim=lim;
    for(let i=1;i<=ST_INSERTS;i++) this.ins[i].out.connect(m.in);
    for(let i=0;i<=ST_INSERTS;i++) this.buildInsert(i);
    for(const ch of P.channels) this.addChannel(ch);
    this.refresh();
  }
  buildInsert(i){
    const o=this.ins[i], mi=this.P.mixer[i];
    try{ o.in.disconnect(); }catch(e){}
    for(const f of o.fx){ try{ f.out.disconnect(); }catch(e){} for(const n of f.nodes) try{ n.stop(); }catch(e){} }
    o.fx=mi.fx.map(f=>{ const x=stMakeFx(this.ac,f.type,f.p,this.P.bpm); x.on=f.on; x.id=f.id; return x; });
    let prev=o.in; for(const f of o.fx) if(f.on){ prev.connect(f.in); prev=f.out; }
    prev.connect(o.pan);
    this.refreshInsert(i);
  }
  refreshInsert(i){
    const o=this.ins[i], mi=this.P.mixer[i], ac=this.ac, any=this.P.mixer.some((m,j)=>j&&m.solo);
    const audible=!mi.mute && (!any || mi.solo || i===0);
    stTC(o.vol.gain,audible?mi.vol:0,null,ac); stTC(o.pan.pan,mi.pan,null,ac);
    for(const [t,g] of o.sends){ if(!(t in mi.sends)){ try{ g.disconnect(); }catch(e){} o.sends.delete(t); } }
    for(const t in mi.sends){
      let g=o.sends.get(+t); if(!g){ g=stGain(ac,0); o.out.connect(g); g.connect(this.ins[+t].in); o.sends.set(+t,g); }
      stTC(g.gain,mi.sends[t],null,ac);
    }
    mi.fx.forEach((f,j)=>{ if(o.fx[j]) o.fx[j].update(f.p,this.P.bpm); });
  }
  addChannel(ch){
    const n=this.ac.createGain(), pn=this.ac.createStereoPanner(); n.connect(pn);
    this.chs.set(ch.id,{gain:n,pan:pn}); this.routeChannel(ch);
  }
  routeChannel(ch){
    const c=this.chs.get(ch.id); try{ c.pan.disconnect(); }catch(e){}
    c.pan.connect(this.ins[ch.mix||0].in);
  }
  removeChannel(ch){ const c=this.chs.get(ch.id); if(c){ try{ c.gain.disconnect(); c.pan.disconnect(); }catch(e){} this.chs.delete(ch.id); } }
  refreshChannel(ch){
    const c=this.chs.get(ch.id); if(!c) return;
    const any=this.P.channels.some(x=>x.solo), audible=!ch.mute && (!any || ch.solo);
    stTC(c.gain.gain,audible?ch.vol:0,null,this.ac); stTC(c.pan.pan,ch.pan,null,this.ac);
  }
  // после структурных правок проекта (каналы, цепочки, откат): подогнать граф под модель
  sync(){
    for(const id of [...this.chs.keys()]) if(!this.P.channels.some(c=>c.id===id)) this.removeChannel({id});
    for(const ch of this.P.channels){ if(!this.chs.has(ch.id)) this.addChannel(ch); else this.routeChannel(ch); }
    for(let i=0;i<=ST_INSERTS;i++) this.buildInsert(i);
    this.refresh();
  }
  refresh(){ for(const ch of this.P.channels) this.refreshChannel(ch); for(let i=0;i<=ST_INSERTS;i++) this.refreshInsert(i); }
  setBpm(b){ this.bpm=b; this.P.mixer.forEach((m,i)=>m.fx.forEach((f,j)=>{ if(this.ins[i].fx[j] && (f.type==='delay')) this.ins[i].fx[j].update(f.p,b); })); }
  // нота: key, vel 1..127, t — время контекста, off — время отпускания или null (держится, release вызывает вызывающий)
  note(ch,key,vel,t,off,over){
    const p=over ? Object.assign({},ch.p,over) : ch.p;
    const v=ch.type==='drum' ? stDrumVoice(this,ch,p,key,vel,t) : ch.type==='sampler' ? stSampleVoice(this,ch,p,key,vel,t,off)
      : stSynthVoice(this,ch,p,key,vel,t,off);
    const vs=this.voices; vs.push(v);
    if(vs.length>400){ const now=this.ac.currentTime; this.voices=vs.filter(x=>!(x.end<now)); }
    return v;
  }
  // уровни вставок: пик 0..1
  levels(){
    const buf=this._lb||(this._lb=new Float32Array(1024)), out=[];
    for(const o of this.ins){ o.an.getFloatTimeDomainData(buf); let m=0; for(let i=0;i<buf.length;i++){ const a=Math.abs(buf[i]); if(a>m) m=a; } out.push(m); }
    return out;
  }
}

/* ---------- планировщик: тики → время контекста ---------- */
class StSched{
  constructor(rig,P){ this.rig=rig; this.P=P; this.active=new Set(); this.autoCh={}; }
  // a,b — тики; toTime(тик) → секунды контекста
  chunk(view,a,b,toTime){
    const rig=this.rig, P=this.P, bpm=P.bpm;
    this.autos(a,b,toTime);
    for(const m of P.mixer) m.fx.forEach((f,j)=>{ const x=rig.ins[P.mixer.indexOf(m)].fx[j]; if(x && x.on && x.sched) x.sched(a,b,toTime,bpm); });
    for(const e of stCollect(P,view,a,b)){
      const ch=P.channels.find(c=>c.id===e.ch); if(!ch) continue;
      const any=P.channels.some(c=>c.solo); if(ch.mute || (any && !ch.solo)) continue;
      const t=toTime(e.t), off=toTime(e.t+e.l)-.005;
      rig.note(ch,e.k,e.v,Math.max(t,rig.ac.currentTime),off>t?off:t+.03,this.autoCh[ch.id]);
    }
  }
  autos(a,b,toTime){
    const P=this.P, rig=this.rig, ac=rig.ac, now=new Set();
    for(const c of P.playlist.clips){
      if(c.kind!=='auto' || c.t+c.l<=a || c.t>=b) continue;
      const def=stTargetDef(P,c.target); if(!def) continue;
      const va=stAutoValue(P,c.target,Math.max(a,c.t)), vb=stAutoValue(P,c.target,Math.min(b,c.t+c.l)-1);
      if(va==null) continue;
      now.add(c.target);
      const ra=stFromNorm(def,va), rb=stFromNorm(def,vb==null?va:vb), ta=Math.max(toTime(Math.max(a,c.t)),ac.currentTime), tb=toTime(Math.min(b,c.t+c.l));
      this.apply(c.target,def,ra,rb,ta,tb);
    }
    for(const tg of this.active) if(!now.has(tg)){        // автоматизация закончилась — вернуть ручное значение
      const def=stTargetDef(P,tg); if(def) this.restore(tg,toTime(a));
      const s=tg.split(':'); if(s[0]==='ch' && this.autoCh[s[1]]) delete this.autoCh[s[1]][s[2]];
    }
    this.active=now;
  }
  apply(tg,def,ra,rb,ta,tb){
    const s=tg.split(':'), rig=this.rig, ac=rig.ac;
    if(s[0]==='mix'){
      const o=rig.ins[+s[1]], par=s[2]==='vol'?o.vol.gain:o.pan.pan;
      par.cancelScheduledValues(ta); par.setValueAtTime(ra,ta); par.linearRampToValueAtTime(rb,Math.max(tb,ta+.001));
    }else if(s[0]==='fx'){
      const x=rig.ins[+s[1]].fx[+s[2]]; if(!x) return; const f=this.P.mixer[+s[1]].fx[+s[2]];
      x.update(Object.assign({},f.p,{[s[3]]:ra}),this.P.bpm,ta);
    }else if(s[0]==='ch'){ (this.autoCh[s[1]]||(this.autoCh[s[1]]={}))[s[2]]=ra; }
  }
  restore(tg,ta){
    const s=tg.split(':'), rig=this.rig, P=this.P;
    if(s[0]==='mix'){ const m=P.mixer[+s[1]], o=rig.ins[+s[1]], par=s[2]==='vol'?o.vol.gain:o.pan.pan;
      par.cancelScheduledValues(ta); par.setValueAtTime(m[s[2]],ta); }
    else if(s[0]==='fx'){ const x=rig.ins[+s[1]].fx[+s[2]], f=P.mixer[+s[1]].fx[+s[2]]; if(x) x.update(f.p,P.bpm,ta); }
  }
}

/* ---------- транспорт ---------- */
class StEngine{
  constructor(P){
    this.P=P; this.ac=null; this.rig=null; this.sched=null; this.view={mode:'song'}; this.samples={};
    this.playing=false; this.sp=0; this.anchors=[]; this.timer=0; this.held=new Map(); this.onstop=null; this.metro=false;
  }
  ensure(){
    if(!this.ac){
      this.ac=new (window.AudioContext||window.webkitAudioContext)({latencyHint:'interactive'});
      this.rig=new StRig(this.ac,this.P,this.samples); this.sched=new StSched(this.rig,this.P);
    }
    if(this.ac.state!=='running') this.ac.resume();
    return this.ac;
  }
  setProject(P){
    this.stop(); this.P=P;
    if(this.ac){ this.ac.close(); this.ac=null; this.rig=null; this.sched=null; }
  }
  toTime(tick){ const a=this.sa; return a.t0+stSec(tick-a.tick0,this.P.bpm); }
  play(from){
    this.ensure(); this.stop();
    const t0=this.ac.currentTime+.08;
    this.sa={t0,tick0:from}; this.anchors=[{t0,tick0:from,bpm:this.P.bpm}]; this.sp=from; this.playing=true; this._bpm=this.P.bpm;
    this.sched=new StSched(this.rig,this.P);
    this.timer=setInterval(()=>this.pump(),25); this.pump();
  }
  pump(){
    const ac=this.ac, P=this.P; if(!this.playing) return;
    if(P.bpm!==this._bpm){ this.sa={t0:this.toTime(this.sp),tick0:this.sp}; this.anchors.push({t0:this.sa.t0,tick0:this.sp,bpm:P.bpm}); this._bpm=P.bpm; this.rig.setBpm(P.bpm); }
    let guard=0;
    while(this.toTime(this.sp)<ac.currentTime+.2 && guard++<64){
      const a=this.sp; let b=a+12, wrap=false, lp=null;
      if(this.view.mode==='song'){
        lp=P.playlist.loop;
        if(lp && a<lp[1] && b>=lp[1]){ b=lp[1]; wrap=true; }
        else if(!lp && a>=stSongEnd(P)+ST_BAR*2){ this.stopSoon(); return; }
      }
      this.sched.chunk(this.view,a,b,t=>this.toTime(t));
      if(this.metro){ const bt=Math.ceil(a/ST_PPQ)*ST_PPQ; if(bt<b) this.click(this.toTime(bt),bt%ST_BAR===0); }
      this.sp=b;
      if(wrap){ const t0=this.toTime(lp[1]); this.sa={t0,tick0:lp[0]}; this.anchors.push({t0,tick0:lp[0],bpm:P.bpm}); this.sp=lp[0]; }
    }
  }
  click(t,acc){
    const ac=this.ac, o=ac.createOscillator(), g=stGain(ac,0); o.frequency.value=acc?1500:1000; o.connect(g); g.connect(ac.destination);
    g.gain.setValueAtTime(.3,t); g.gain.exponentialRampToValueAtTime(.001,t+.05); o.start(t); o.stop(t+.06);
  }
  stopSoon(){ this.stop(); if(this.onstop) this.onstop(); }
  stop(keepRig){
    clearInterval(this.timer); this.timer=0; this.playing=false;
    if(this.rig && !keepRig){                      // оборвать звучащие и ещё не начавшиеся голоса
      const t=this.ac.currentTime;
      for(const v of this.rig.voices) if(!(v.end<t)) try{ v.kill(t); }catch(e){}
      this.rig.voices=[]; this.rig.monoLast={}; this.held.clear();
    }
  }
  getTick(){
    if(!this.playing) return null;
    const ct=this.ac.currentTime, A=this.anchors;
    while(A.length>1 && A[1].t0<=ct) A.shift();
    const a=A[0]; return Math.max(0,a.tick0+stTicks(ct-a.t0,a.bpm));
  }
  // живая игра: удерживаемая нота (клавиатура, мышь, MIDI)
  noteOn(chId,key,vel){
    const ch=this.P.channels.find(c=>c.id===chId); if(!ch) return;
    this.ensure(); const id=chId+':'+key; this.noteOff(chId,key);
    this.held.set(id,this.rig.note(ch,key,vel||100,this.ac.currentTime+.005,null));
  }
  noteOff(chId,key){
    const id=chId+':'+key, v=this.held.get(id); if(!v) return;
    this.held.delete(id); v.release(this.ac.currentTime+.01);
  }
  async loadSample(chId,file){
    this.ensure();
    const arr=await file.arrayBuffer(), buf=await this.ac.decodeAudioData(arr.slice(0));
    this.samples[chId]={buf,name:file.name,data:arr}; this.rig.samples=this.samples; return buf;
  }
}

/* ---------- экспорт: офлайн-рендер всей песни (или паттерна) ---------- */
async function stRender(P,samples,opts){
  opts=opts||{}; const sr=opts.sr||44100, view=opts.view||{mode:'song'};
  let end;
  if(view.mode==='pat'){ const pat=P.patterns.find(p=>p.id===view.pat); end=stPatLen(pat)*(opts.loops||1); }
  else end=P.playlist.loop && opts.useLoop ? P.playlist.loop[1] : stSongEnd(P);
  if(opts.end!=null) end=opts.end;
  const tail=opts.tail==null?2.5:opts.tail, secs=stSec(end,P.bpm)+tail;
  const oac=new OfflineAudioContext(2,Math.ceil(secs*sr),sr);
  const rig=new StRig(oac,P,samples), sch=new StSched(rig,P), toTime=t=>stSec(t,P.bpm);
  for(let a=0;a<end;a+=ST_STEP) sch.chunk(view,a,Math.min(end,a+ST_STEP),toTime);
  const buf=await oac.startRendering();
  return {L:buf.getChannelData(0),R:buf.getChannelData(1),sr};
}
