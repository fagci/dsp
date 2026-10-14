"use strict";
/* ============================ VISUALIZERS ============================ */
// Band FFT (мало бинов) и визуализаторы музыки: Spectrum Bars, Radial, Neon Wave, Beat Particles, Ridgeline.
// Ядро — modules/viz-kernels.js. Рисуют на canvas узла (работают и в дашборде), lazy:'proc'.

const VZ_RANGE_PARAMS=[
  {n:'frange',t:'range2',keys:['fmin','fmax'],min:20,max:20000,step:1,log:true,d:[40,16000],label:'range, Hz'},
  {n:'dbrange',t:'range2',keys:['floor','top'],min:-120,max:0,step:1,d:[-75,-15],label:'range, dB'},
  {n:'scale',t:'select',opts:['log','mel','linear'],d:'log',label:'frequency scale'},
  {n:'tilt',t:'range',min:0,max:6,step:.5,d:3,label:'tilt, dB/oct'}];
const vzDt=()=>BLOCK/Eng.sr;
const R_OF=(W,H)=>Math.hypot(W,H)/2;
const vzScr=()=>themeColor('--screen')||'#0a0d0e';
// аддитивное смешение только на тёмном экране, на светлом — обычное
const vzGlow=()=>{ const h=vzScr().replace('#',''), f=h.length===3?h.replace(/./g,'$&$&'):h;
  return (parseInt(f.slice(0,2),16)*.3+parseInt(f.slice(2,4),16)*.59+parseInt(f.slice(4,6),16)*.11)<128 ? 'lighter' : 'source-over'; };

// спектр → n.db (дБ по полосам). Уже полосный (Band FFT, Third-Octaves) берём как есть,
// сырой FFT группируем в p.bars полос (наклон tilt — только здесь).
function vzBandsDb(n,s){
  const p=n.p;
  if(s.freqs && s.mag.length<=256){
    const nb=s.mag.length;
    if(!n.db || n.db.length!==nb) n.db=new Float32Array(nb);
    for(let i=0;i<nb;i++){
      n.db[i]=20*Math.log10(s.mag[i]+1e-9); }
    return;
  }
  const nb=Math.round(p.bars), key=nb+'/'+p.fmin+'/'+p.fmax+'/'+p.scale;
  if(n.ek!==key){ n.ek=key; n.edges=vzEdges(nb,p.fmin,Math.min(p.fmax,Eng.sr/2),p.scale); n.db=new Float32Array(nb); }
  vzGroup(s.mag,s.sr/s.size,n.edges,n.db,p.tilt);
}

// полосы → n.v (0..1, со спадом fall), n.pk (пики), n.kick (низ), n.beat (бит в этом блоке)
function vzLevels(n,I,peak){
  const s=I.spec, p=n.p, dt=vzDt();
  n.beat=false;
  if(!s || !s.mag){ if(n.v) for(let i=0;i<n.v.length;i++) n.v[i]=vzFollow(n.v[i],0,0,p.fall||.3,dt); return false; }
  vzBandsDb(n,s);
  const nb=n.db.length;
  if(!n.v || n.v.length!==nb){ n.v=new Float32Array(nb); n.pk=new Float32Array(nb); n.pt=new Float32Array(nb); }
  const fall=p.fall==null?.3:p.fall, lo=p.floor, hi=Math.max(p.top,lo+1);
  for(let i=0;i<nb;i++) n.v[i]=vzFollow(n.v[i],vzNorm(n.db[i],lo,hi),.015,fall,dt);
  if(peak){
    for(let i=0;i<nb;i++){
      if(n.v[i]>=n.pk[i]){ n.pk[i]=n.v[i]; n.pt[i]=.6; }
      else if((n.pt[i]-=dt)<0) n.pk[i]=Math.max(n.v[i],n.pk[i]-.5*dt); } }
  // нижняя четверть полос — «бас»: энергия для детектора и сглаженная величина для пульсации
  const q=Math.max(1,nb>>2); let e=0, b=0;
  for(let i=0;i<q;i++){ e+=Math.pow(10,n.db[i]/10); b+=n.v[i]; }
  b/=q; n.kick=vzFollow(n.kick||0,b,.01,.2,dt);
  if(!n.bd) n.bd=vzBeatNew();
  n.beat=vzBeat(n.bd,e/q,dt,p.sens||1.5,.18);
  if(typeof I.beat==='object' && I.beat){ for(let i=0;i<I.beat.length;i++) if(I.beat[i]>.5){ n.beat=true; break; } }
  return true;
}

// заливка столбца по режиму; theme — общий градиент по высоте холста
function vzFill(n,cx,H,mode,i,nb,v){
  if(mode==='rainbow') return vzColor('rainbow',i/Math.max(1,nb-1),v);
  if(mode==='heat') return vzColor('heat',0,v);
  if(mode==='mono') return themeColor('--acc2');
  if(!n._gr || n._grH!==H){
    const g=cx.createLinearGradient(0,H,0,0);
    g.addColorStop(0,themeColor('--acc2')); g.addColorStop(.7,themeColor('--acc')); g.addColorStop(1,themeColor('--err'));
    n._gr=g; n._grH=H; n._grT=themeColor('--acc'); }
  return n._gr;
}
function vzCap(cx,x,y,w,h,r){
  if(h<=0) return;
  if(r>0 && cx.roundRect){ cx.beginPath(); cx.roundRect(x,y,w,h,[r,r,0,0]); cx.fill(); }
  else cx.fillRect(x,y,w,h);
}
function vzFade(cx,W,H,trail){
  if(trail>0){ cx.globalCompositeOperation='destination-out'; cx.fillStyle='rgba(0,0,0,'+(1-trail).toFixed(3)+')';
    cx.fillRect(0,0,W,H); cx.globalCompositeOperation='source-over'; }
  else cx.clearRect(0,0,W,H);
}


/* ---------- Band FFT ---------- */
def({ id:'bands', title:'Band FFT (few bins)', cat:'Processing', kw:'equalizer eq bars bands octave log mel audio visualizer beat bass treble',
  ins:[{n:'in',t:'sig'}],
  outs:[{n:'spec',t:'spec'},{n:'bass',t:'num'},{n:'mid',t:'num'},{n:'treble',t:'num'},{n:'level',t:'num'},{n:'beat',t:'sig'},{n:'bpm',t:'num'}],
  readout:true,
  params:[{n:'bands',t:'range',min:4,max:128,step:1,d:16,label:'bands'},
          {n:'size',t:'select',opts:['512','1024','2048','4096'],d:'2048',label:'FFT size'},
          ...VZ_RANGE_PARAMS,
          {n:'fall',t:'range',min:0,max:2,step:.01,d:.15,label:'fall time, s'},
          {n:'sens',t:'range',min:1.1,max:3,step:.05,d:1.5,label:'beat sensitivity'}],
  init:n=>{ n.N=0; n.v=null; n.bd=vzBeatNew(); n.sp={}; },
  process(n,I){
    const p=n.p, N=Math.max(+p.size,BLOCK*2), nb=Math.round(p.bands), dt=vzDt();
    if(n.N!==N){ n.N=N; n.ring=new Float32Array(N); n.xw=new Float32Array(N);
      n.zr=new Float32Array(N/2); n.zi=new Float32Array(N/2); n.re=new Float32Array(N/2); n.im=new Float32Array(N/2);
      n.mag=new Float32Array(N/2); n.w=window_('hann',N);
      let sum=0; for(let i=0;i<N;i++) sum+=n.w[i]; n.g=2/sum; n.ek=null; }
    const key=nb+'/'+p.fmin+'/'+p.fmax+'/'+p.scale+'/'+N+'/'+Eng.sr;
    if(n.ek!==key){ n.ek=key;
      n.edges=vzEdges(nb,p.fmin,Math.min(p.fmax,Eng.sr/2*.98),p.scale);
      n.fc=new Float32Array(nb); for(let i=0;i<nb;i++) n.fc[i]=Math.sqrt(n.edges[i]*n.edges[i+1]);
      n.db=new Float32Array(nb); n.s=new Float32Array(nb).fill(-120); n.mg=new Float32Array(nb); }
    n.ring.copyWithin(0,BLOCK);
    for(let i=0;i<BLOCK;i++) n.ring[N-BLOCK+i]=I.in?I.in[i]:0;
    for(let i=0;i<N;i++) n.xw[i]=n.ring[i]*n.w[i];
    rfft(n.xw,n.zr,n.zi,n.re,n.im);
    const M=N/2, g=n.g, mag=n.mag;
    mag[0]=Math.hypot(n.re[0],n.im[0])*g/2;
    for(let i=1;i<M;i++) mag[i]=Math.sqrt(n.re[i]*n.re[i]+n.im[i]*n.im[i])*g;
    vzGroup(mag,Eng.sr/N,n.edges,n.db,p.tilt);
    for(let i=0;i<nb;i++){
      n.s[i]=vzFollow(n.s[i],n.db[i],.01,p.fall,dt);
      n.mg[i]=Math.pow(10,n.s[i]/20); }
    // бас / середина / верх: энергия по бинам исходного FFT, дБ → 0..1
    const hz=Eng.sr/N, band=(a,b)=>{ let e=0; const i0=Math.max(1,Math.round(a/hz)), i1=Math.min(M-1,Math.round(b/hz));
      for(let i=i0;i<=i1;i++) e+=mag[i]*mag[i]; return e; };
    const eb=band(20,250), em=band(250,4000), et=band(4000,16000), lo=p.floor, hi=Math.max(p.top,lo+1);
    const nm=e=>vzNorm(10*Math.log10(e+1e-18),lo,hi);
    n.bass=nm(eb); n.mid=nm(em); n.treb=nm(et); n.lvl=nm(eb+em+et);
    const bt=buf(n,'beat'); bt.fill(0);
    if(vzBeat(n.bd,eb,dt,p.sens,.18)) bt[0]=1;
    const sp=n.sp; sp.mag=n.mg; sp.freqs=n.fc; sp.sr=Eng.sr; sp.size=N; sp.rev=(sp.rev|0)+1;
    return {spec:sp, bass:n.bass, mid:n.mid, treble:n.treb, level:n.lvl, beat:bt, bpm:n.bd.bpm}; },
  draw(n){ roText(n,(n.bd&&n.bd.bpm?Math.round(n.bd.bpm)+' BPM · ':'')+Math.round(n.p.bands)+' bands'); }});


/* ---------- Spectrum Bars ---------- */
def({ id:'vizBars', lazy:'proc', title:'Spectrum Bars', cat:'Analysis', kw:'equalizer eq bars led music visualizer analyzer',
  ins:[{n:'spec',t:'spec'}], view:{h:140}, resize:true,
  params:[{n:'style',t:'select',opts:['bars','round','led','mirror','line'],d:'round'},
          {n:'color',t:'select',opts:['theme','rainbow','heat','mono'],d:'theme'},
          {n:'bars',t:'range',min:8,max:128,step:1,d:32,label:'bars (from an FFT spectrum)'},
          ...VZ_RANGE_PARAMS,
          {n:'fall',t:'range',min:0,max:2,step:.01,d:.3,label:'fall time, s'},
          {n:'peak',t:'check',d:true,label:'peak marker'},
          {n:'gap',t:'range',min:0,max:.6,step:.02,d:.2,label:'bar gap'},
          {n:'segs',t:'range',min:6,max:40,step:1,d:16,label:'LED segments'}],
  init:n=>{ n.v=null; },
  process(n,I){ vzLevels(n,I,true); return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p;
    cx.clearRect(0,0,W,H);
    const v=n.v; if(!v) return;
    const nb=v.length, bw=W/nb, w=Math.max(1,bw*(1-p.gap)), x0=(bw-w)/2, st=p.style;
    if(st==='line'){
      cx.beginPath(); cx.moveTo(0,H);
      for(let i=0;i<nb;i++){ const x=(i+.5)*bw, y=H-v[i]*H; cx.lineTo(x,y); }
      cx.lineTo(W,H); cx.closePath();
      cx.globalAlpha=.25; cx.fillStyle=vzFill(n,cx,H,p.color,nb>>1,nb,.5); cx.fill(); cx.globalAlpha=1;
      cx.beginPath();
      for(let i=0;i<nb;i++){ const x=(i+.5)*bw, y=H-v[i]*H; i? cx.lineTo(x,y) : cx.moveTo(x,y); }
      cx.strokeStyle=vzFill(n,cx,H,p.color,nb>>1,nb,.8); cx.lineWidth=Math.max(1.5,H/70); cx.lineJoin='round'; cx.stroke();
      return; }
    if(st==='led'){
      const S=Math.round(p.segs), sg=H/S, sh=Math.max(1,sg*.78);
      for(let i=0;i<nb;i++){
        const lit=Math.floor(v[i]*S), pk=p.peak? Math.min(S-1,Math.floor(n.pk[i]*S)) : -1;
        for(let k=0;k<S;k++){
          if(k>=lit && k!==pk) continue;
          const f=k/S;
          cx.fillStyle=p.color==='theme' ? themeColor(f<.6?'--acc2':f<.85?'--acc':'--err') : vzFill(n,cx,H,p.color,i,nb,f);
          cx.fillRect(x0+i*bw,H-(k+1)*sg+(sg-sh),w,sh); } }
      return; }
    for(let i=0;i<nb;i++){
      const h=v[i]*(st==='mirror'?H/2:H), x=x0+i*bw;
      cx.fillStyle=vzFill(n,cx,H,p.color,i,nb,v[i]);
      if(st==='mirror'){
        cx.fillRect(x,H/2-h,w,h*2||1);
        if(p.peak){ const ph=n.pk[i]*H/2; cx.fillRect(x,H/2-ph-2,w,2); cx.fillRect(x,H/2+ph,w,2); }
      } else {
        vzCap(cx,x,H-h,w,h,st==='round'?w/2:0);
        if(p.peak && n.pk[i]>.01){ cx.fillStyle=themeColor('--scr-hi'); cx.fillRect(x,H-n.pk[i]*H-Math.max(2,H/60),w,Math.max(2,H/60)); } } } }});


/* ---------- Radial Spectrum ---------- */
def({ id:'vizRadial', lazy:'proc', title:'Radial Spectrum', cat:'Music', kw:'circle round music visualizer bars beat pulse',
  ins:[{n:'spec',t:'spec'},{n:'beat',t:'sig'}], view:{h:220}, resize:true,
  params:[{n:'color',t:'select',opts:['rainbow','heat','mono'],d:'rainbow'},
          {n:'bars',t:'range',min:8,max:96,step:1,d:48,label:'bars'},
          ...VZ_RANGE_PARAMS,
          {n:'fall',t:'range',min:0,max:2,step:.01,d:.25,label:'fall time, s'},
          {n:'mirror',t:'check',d:true,label:'symmetric'},
          {n:'rot',t:'range',min:-90,max:90,step:1,d:12,label:'rotation, °/s'},
          {n:'inner',t:'range',min:.1,max:.6,step:.01,d:.3,label:'inner radius'},
          {n:'pulse',t:'range',min:0,max:.5,step:.01,d:.15,label:'bass pulse'},
          {n:'trail',t:'range',min:0,max:.95,step:.01,d:.55,label:'trail'},
          {n:'glow',t:'check',d:true},
          {n:'sens',t:'range',min:1.1,max:3,step:.05,d:1.5,label:'beat sensitivity'}],
  init:n=>{ n.v=null; n.ang=0; n.hue=0; n.flash=0; n.t0=0; },
  process(n,I){ vzLevels(n,I,false); if(n.beat) n.flash=1; return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, now=performance.now(), dt=Math.min(.05,(now-(n.t0||now))/1000); n.t0=now;
    vzFade(cx,W,H,p.trail);
    const v=n.v; if(!v) return;
    n.ang+=p.rot*Math.PI/180*dt; n.hue+=dt*25; n.flash=Math.max(0,n.flash-dt*3);
    const nb=v.length, S=p.mirror?nb*2:nb, R=Math.min(W,H)/2, kick=n.kick||0;
    const r0=R*p.inner*(1+p.pulse*kick*2), len=R*(1-p.inner*(1+p.pulse))*.95, cxp=W/2, cyp=H/2;
    const lw=Math.max(1.5,Math.min(R*.12,2*Math.PI*r0/S*.55));
    cx.lineCap='round';
    for(let pass=p.glow?0:1;pass<2;pass++){
      if(pass===0){ cx.globalCompositeOperation=vzGlow(); cx.globalAlpha=.18; cx.lineWidth=lw*3.2; }
      else { cx.globalCompositeOperation='source-over'; cx.globalAlpha=1; cx.lineWidth=lw; }
      for(let j=0;j<S;j++){
        const i=j<nb?j:S-1-j, a=n.ang+j/S*2*Math.PI-Math.PI/2, c=Math.cos(a), s=Math.sin(a), l=v[i]*len+1;
        cx.strokeStyle=p.color==='mono' ? themeColor('--acc2') : p.color==='heat' ? vzColor('heat',0,v[i]) : vzHsl(n.hue+j/S*300,90,58);
        cx.beginPath(); cx.moveTo(cxp+c*r0,cyp+s*r0); cx.lineTo(cxp+c*(r0+l),cyp+s*(r0+l)); cx.stroke(); } }
    cx.globalAlpha=1; cx.globalCompositeOperation='source-over';
    cx.strokeStyle=themeColor('--scr-hi'); cx.globalAlpha=.35+.5*n.flash; cx.lineWidth=Math.max(1,lw*.5);
    cx.beginPath(); cx.arc(cxp,cyp,r0*.9,0,Math.PI*2); cx.stroke();
    if(n.flash>0){ cx.fillStyle=themeColor('--scr-hi'); cx.globalAlpha=n.flash*.18; cx.beginPath(); cx.arc(cxp,cyp,r0*.9,0,Math.PI*2); cx.fill(); }
    cx.globalAlpha=1; }});


/* ---------- Neon Waveform ---------- */
const VZ_WAVE_LEN=4096;
def({ id:'vizWave', lazy:'proc', title:'Neon Waveform', cat:'Music', kw:'oscilloscope lissajous vectorscope ring music visualizer',
  ins:[{n:'in',t:'sig'},{n:'in2',t:'sig'}], view:{h:200}, resize:true,
  params:[{n:'mode',t:'select',opts:['line','ring','xy'],d:'line'},
          {n:'color',t:'select',opts:['cycle','mono'],d:'cycle'},
          {n:'gain',t:'range',min:.2,max:8,step:.1,d:1.5},
          {n:'trail',t:'range',min:0,max:.95,step:.01,d:.6},
          {n:'width',t:'range',min:1,max:8,step:.5,d:2},
          {n:'glow',t:'check',d:true}],
  init:n=>{ n.r1=new Float32Array(VZ_WAVE_LEN); n.r2=new Float32Array(VZ_WAVE_LEN); n.w=0; n.hue=0; n.t0=0; },
  process(n,I){
    for(let i=0;i<BLOCK;i++){
      n.r1[n.w]=I.in?I.in[i]:0; n.r2[n.w]=I.in2?I.in2[i]:0;
      n.w=(n.w+1)%VZ_WAVE_LEN; }
    n.two=!!I.in2;
    return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, now=performance.now(), dt=Math.min(.05,(now-(n.t0||now))/1000); n.t0=now;
    vzFade(cx,W,H,p.trail);
    const L=VZ_WAVE_LEN, w=n.w, at=k=>(w+k+L)%L, g=p.gain;
    n.hue+=dt*40;
    const col=p.color==='mono' ? themeColor('--acc2') : vzHsl(n.hue,95,60);
    cx.lineJoin='round'; cx.strokeStyle=col;
    const stroke=()=>{
      if(p.glow){ cx.globalCompositeOperation=vzGlow(); cx.globalAlpha=.2; cx.lineWidth=p.width*4; cx.stroke(); }
      cx.globalCompositeOperation='source-over'; cx.globalAlpha=1; cx.lineWidth=p.width; cx.stroke(); };
    cx.beginPath();
    if(p.mode==='line'){
      const len=1024; let s0=-len;
      for(let k=-len-1;k>-L+len;k--) if(n.r1[at(k-1)]<0 && n.r1[at(k)]>=0){ s0=k; break; }   // триггер по нарастающему нулю
      for(let i=0;i<len;i++){ const x=i/(len-1)*W, y=H/2-clamp(n.r1[at(s0+i)]*g,-1,1)*H*.45; i? cx.lineTo(x,y) : cx.moveTo(x,y); }
    } else if(p.mode==='ring'){
      const len=720, R=Math.min(W,H)/2, r0=R*.55;
      for(let i=0;i<=len;i++){
        const a=i/len*2*Math.PI-Math.PI/2, r=r0+clamp(n.r1[at(-len+(i%len))]*g,-1,1)*R*.4;
        const x=W/2+Math.cos(a)*r, y=H/2+Math.sin(a)*r; i? cx.lineTo(x,y) : cx.moveTo(x,y); }
      cx.closePath();
    } else {
      const len=1024, R=Math.min(W,H)/2*.9, d=n.two?0:24;     // без второго входа — фазовый портрет x(t), x(t−d)
      for(let i=0;i<len;i++){
        const k=-len+i, a=n.r1[at(k)], b=n.two? n.r2[at(k)] : n.r1[at(k-d)];
        const x=W/2+clamp(a*g,-1,1)*R, y=H/2-clamp(b*g,-1,1)*R; i? cx.lineTo(x,y) : cx.moveTo(x,y); }
    }
    stroke(); }});


/* ---------- Beat Particles ---------- */
def({ id:'vizParticles', lazy:'proc', title:'Beat Particles', cat:'Music', kw:'fireworks starfield warp tunnel music visualizer beat',
  ins:[{n:'spec',t:'spec'},{n:'beat',t:'sig'}], view:{h:220}, resize:true,
  params:[{n:'mode',t:'select',opts:['burst','fountain','warp'],d:'burst'},
          {n:'color',t:'select',opts:['rainbow','heat','mono'],d:'rainbow'},
          {n:'bars',t:'range',min:8,max:64,step:1,d:24,label:'bars (fountain)'},
          ...VZ_RANGE_PARAMS,
          {n:'fall',t:'range',min:0,max:2,step:.01,d:.2,label:'fall time, s'},
          {n:'count',t:'range',min:50,max:1000,step:10,d:350,label:'max particles'},
          {n:'trail',t:'range',min:0,max:.95,step:.01,d:.7},
          {n:'sens',t:'range',min:1.1,max:3,step:.05,d:1.5,label:'beat sensitivity'}],
  init:n=>{ n.v=null; n.pts=[]; n.t0=0; n.hue=0; n.flash=0; n.burst=0; },
  process(n,I){ vzLevels(n,I,false); if(n.beat){ n.burst++; n.flash=1; } return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, now=performance.now(), dt=Math.min(.05,(now-(n.t0||now))/1000); n.t0=now;
    vzFade(cx,W,H,p.trail);
    const v=n.v; if(!v) return;
    const pts=n.pts, max=Math.round(p.count), sc=Math.min(W,H)/300, kick=n.kick||0, cxp=W/2, cyp=H/2, nb=v.length;
    n.hue+=dt*30; n.flash=Math.max(0,n.flash-dt*4);
    const hueOf=(t,val)=>p.color==='mono' ? null : p.color==='heat' ? 240-val*240 : n.hue+t*300;
    const add=(o)=>{ if(pts.length<max) pts.push(o); };
    if(p.mode==='burst'){
      for(;n.burst>0;n.burst--){
        const k=Math.round(12+kick*50);
        for(let i=0;i<k;i++){ const a=Math.random()*Math.PI*2, sp=(60+Math.random()*220)*(.5+kick)*sc;
          add({x:cxp,y:cyp,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,life:.8+Math.random()*.8,age:0,t:Math.random(),val:kick,r:(1+Math.random()*2)*sc}); } }
    } else if(p.mode==='fountain'){
      n.burst=0;
      for(let i=0;i<nb;i++) if(v[i]>.3 && Math.random()<v[i]*dt*18)
        add({x:(i+.5)/nb*W,y:H,vx:(Math.random()-.5)*40*sc,vy:-(120+v[i]*380)*sc,life:.6+v[i]*.9,age:0,t:i/nb,val:v[i],r:(1+v[i]*2)*sc});
    } else {
      n.burst=0;
      const k=Math.round((50+kick*220)*dt);
      for(let i=0;i<k;i++){ const a=Math.random()*Math.PI*2;
        add({a,rad:2*sc,vr:(30+Math.random()*50)*sc,life:9,age:0,t:Math.random(),val:kick,r:sc}); }
    }
    const warp=p.mode==='warp';
    cx.globalCompositeOperation=vzGlow(); cx.lineCap='round';
    for(let i=pts.length-1;i>=0;i--){
      const q=pts[i]; q.age+=dt;
      const fade=1-q.age/q.life;
      let x,y,px,py;
      if(warp){
        px=cxp+Math.cos(q.a)*q.rad; py=cyp+Math.sin(q.a)*q.rad;
        q.rad+=q.vr*dt*(1+kick*6)*(1+q.rad/(R_OF(W,H)*.35)); q.vr*=1+dt*.8;
        x=cxp+Math.cos(q.a)*q.rad; y=cyp+Math.sin(q.a)*q.rad;
        if(q.rad>R_OF(W,H)*1.3){ pts.splice(i,1); continue; }
      } else {
        if(fade<=0){ pts.splice(i,1); continue; }
        q.vy+=(p.mode==='fountain'?420:60)*sc*dt; q.vx*=1-dt*.4;
        px=q.x; py=q.y; q.x+=q.vx*dt; q.y+=q.vy*dt; x=q.x; y=q.y;
        if(y>H+20 || x<-20 || x>W+20){ pts.splice(i,1); continue; } }
      const h=hueOf(q.t,q.val);
      cx.strokeStyle=cx.fillStyle=h==null ? themeColor('--acc2') : vzHsl(h,95,60,warp?1:Math.max(0,fade));
      if(warp){ cx.lineWidth=q.r*(.6+q.rad/R_OF(W,H)*3); cx.beginPath(); cx.moveTo(px,py); cx.lineTo(x,y); cx.stroke(); }
      else { cx.beginPath(); cx.arc(x,y,q.r*(.5+fade*.7),0,Math.PI*2); cx.fill(); } }
    cx.globalCompositeOperation='source-over';
    if(n.flash>0 && !warp){ cx.fillStyle=themeColor('--scr-hi'); cx.globalAlpha=n.flash*.1; cx.fillRect(0,0,W,H); cx.globalAlpha=1; } }});


/* ---------- Ridgeline Spectrum ---------- */
const vzHzStr=f=>{ const a=Math.abs(f); return a>=1e9 ? +(f/1e9).toFixed(3)+' GHz' : a>=1e6 ? +(f/1e6).toFixed(3)+' MHz' : a>=1e3 ? +(f/1e3).toFixed(2)+' kHz' : Math.round(f)+' Hz'; };
// эфир: строка из полного спектра источника, на каждый столбец — максимум бинов (узкие несущие не теряются)
function vzRfRow(n,s){
  const p=n.p, P=Math.round(p.bars), N=s.mag.length, lo=p.floor, hi=Math.max(p.top,lo+1);
  const f0=specHz(s,0), f1=specHz(s,N-1), row=new Float32Array(P);
  let pk=-1, pi=0;
  for(let c=0;c<P;c++){
    const i0=Math.floor(c/P*N), i1=Math.min(N-1,Math.max(i0,Math.ceil((c+1)/P*N)-1));
    let m=0; for(let i=i0;i<=i1;i++) if(s.mag[i]>m) m=s.mag[i];
    const v=vzNorm(20*Math.log10(m+1e-9),lo,hi); row[c]=v;
    if(v>pk){ pk=v; pi=c; } }
  n.f0=f0; n.f1=f1; n.pkdb=lo+pk*(hi-lo); n.fpk=f0+(f1-f0)*(pi+.5)/P;
  return row;
}
def({ id:'vizRidge', lazy:'proc', title:'Ridgeline Spectrum', cat:'Music', kw:'joy division unknown pleasures waterfall 3d landscape music visualizer rf sdr air spectrum history',
  ins:[{n:'spec',t:'spec'}], outs:[{n:'fpeak',t:'num'}], readout:true, view:{h:220}, resize:true,
  params:[{n:'mode',t:'select',opts:['music','rf'],d:'music',tip:'rf: the whole source span with absolute frequencies, peak per column, dB legend — for the air (SDR / tinySA / FFT)'},
          {n:'color',t:'select',opts:['white','rainbow','heat','mono'],d:'white'},
          {n:'rows',t:'range',min:12,max:80,step:1,d:36,label:'rows'},
          {n:'rate',t:'range',min:1,max:40,step:1,d:16,label:'rows per second'},
          {n:'bars',t:'range',min:24,max:256,step:1,d:72,label:'points per row'},
          ...VZ_RANGE_PARAMS,
          {n:'fall',t:'range',min:0,max:1,step:.01,d:.08,label:'fall time, s'},
          {n:'height',t:'range',min:.1,max:1,step:.01,d:.45,label:'peak height'},
          {n:'taper',t:'check',d:true,label:'taper edges (music)'}],
  init:n=>{ n.v=null; n.rows=[]; n.acc=0; n.rk=''; n.fpk=0; n.pkdb=-120; },
  process(n,I){
    const p=n.p, rf=p.mode==='rf', key=p.mode+'/'+Math.round(p.bars);
    if(n.rk!==key){ n.rk=key; n.rows.length=0; n.v=null; n.ek=null; }
    let row=null;
    if(rf){
      const s=I.spec; if(!s||!s.mag) return {fpeak:n.fpk};
      n.acc+=vzDt()*p.rate;
      if(n.acc>=1){ n.acc%=1; row=vzRfRow(n,s); }
    } else {
      vzLevels(n,I,false);
      if(!n.v) return {};
      n.acc+=vzDt()*p.rate;
      if(n.acc>=1){ n.acc%=1; row=Float32Array.from(n.v); }
    }
    if(row) n.rows.push(row);
    const R=Math.round(p.rows); while(n.rows.length>R) n.rows.shift();
    return {fpeak:rf?n.fpk:0}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, rows=n.rows, R=Math.round(p.rows), rf=p.mode==='rf';
    cx.clearRect(0,0,W,H);
    if(!rows.length) return;
    const fs=Math.max(8,Math.round(H/28)), top=H*.12, bot=rf? H-fs*1.8 : H*.97, amp=H*p.height, bg=vzScr(), lw=Math.max(1,H/180);
    cx.lineJoin='round'; cx.lineWidth=lw;
    for(let r=0;r<rows.length;r++){
      const row=rows[r], nb=row.length, depth=(r+R-rows.length+1)/R;   // 0 — дальний ряд, 1 — ближний
      const y0=top+(bot-top)*depth, inset=W*.18*(1-depth), x0=inset, ww=W-2*inset;
      const pt=i=>{
        const f=i/(nb-1);
        if(rf) return [x0+f*ww, y0-row[i]*amp*(.45+.55*depth)];
        const tp=p.taper? Math.pow(Math.sin(Math.PI*f),.6) : 1;
        let a=row[i]; if(i>0&&i<nb-1) a=(row[i-1]+2*a+row[i+1])/4;     // лёгкое сглаживание по частоте
        return [x0+f*ww, y0-a*tp*amp*(.45+.55*depth)]; };
      cx.beginPath(); cx.moveTo(x0,y0+2);
      for(let i=0;i<nb;i++){ const q=pt(i); cx.lineTo(q[0],q[1]); }
      cx.lineTo(x0+ww,y0+2); cx.closePath();
      cx.fillStyle=bg; cx.fill();                                      // закрывает ряды позади
      cx.beginPath();
      for(let i=0;i<nb;i++){ const q=pt(i); i? cx.lineTo(q[0],q[1]) : cx.moveTo(q[0],q[1]); }
      let peak=0; for(let i=0;i<nb;i++) if(row[i]>peak) peak=row[i];
      cx.strokeStyle=p.color==='rainbow' ? vzHsl(depth*300,90,60) : p.color==='heat' ? vzColor('heat',0,peak)
        : p.color==='mono' ? themeColor('--acc2') : themeColor('--scr-hi');
      cx.globalAlpha=.35+.65*depth; cx.stroke(); cx.globalAlpha=1; }
    if(rf && n.f1>n.f0){                                               // ось частот по ближнему ряду и легенда дБ
      cx.font=fs+'px monospace'; cx.fillStyle=themeColor('--axis'); cx.strokeStyle=themeColor('--grid'); cx.lineWidth=1;
      const T=Math.max(2,Math.min(6,Math.floor(W/(fs*9))));
      for(let k=0;k<=T;k++){
        const x=Math.round(k/T*W)+.5, txt=vzHzStr(n.f0+(n.f1-n.f0)*k/T), tw=cx.measureText(txt).width;
        cx.beginPath(); cx.moveTo(x,bot+2); cx.lineTo(x,bot+fs*.4); cx.stroke();
        cx.fillText(txt,Math.max(1,Math.min(W-tw-1,x-tw/2)),H-fs*.3); }
      cx.fillText(Math.round(p.floor)+'…'+Math.round(p.top)+' dB',3,fs); }
    roText(n,rf&&n.fpk ? 'peak '+vzHzStr(n.fpk)+' · '+Math.round(n.pkdb)+' dB' : ''); }});
