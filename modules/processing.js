/* ---------- обработка ---------- */
def({ id:'gain', title:'Gain', cat:'Processing', ins:[{n:'in',t:'sig'},{n:'k',t:'num'}],
  outs:[{n:'out',t:'sig'}], params:[{n:'k',t:'range',min:0,max:256,step:.01,d:1}],
  process(n,I){ const o=buf(n,'out'), k=pv(n,I,'k'), x=I.in;
    for(let i=0;i<BLOCK;i++) o[i]=(x?x[i]:0)*k; return {out:o}; }});


def({ id:'mul', title:'Multiplier', cat:'Processing', ins:[{n:'a',t:'sig'},{n:'b',t:'sig'}],
    params:[{n:'outGain', t:'range', min:0,max:8,step:.01,d:1}],
  outs:[{n:'out',t:'sig'}],
  process(n,I){ const o=buf(n,'out'),k=pv(n,I,'outGain');
    for(let i=0;i<BLOCK;i++) o[i]=(I.a?I.a[i]:0)*(I.b?I.b[i]:0)*k; return {out:o}; }});

def({
  id: 'superhet',
  title: 'Superheterodyne',
  cat: 'Processing',

  ins: [
    {n: 'in',   t: 'sig'},
    {n: 'rf',   t: 'num'},
    {n: 'lo',   t: 'num'},
    {n: 'Q',    t: 'num'},
    {n: 'gain', t: 'num'},
  ],

  outs: [
    {n: 'out',   t: 'sig'},
    {n: 'level', t: 'num'}
  ],

  params: [
    {n: 'rf',    t: 'range', min: 100, max: 24000, step: 1, d: 20190,
     label: 'input frequency, Hz'},

    {n: 'lo',    t: 'range', min: 100, max: 24000, step: 1, d: 12000,
     label: 'local oscillator, Hz'},

    {n: 'Q',     t: 'range', min: 1, max: 100, step: .5, d: 12,
     label: 'IF Q factor'},

    {n: 'preQ',  t: 'range', min: 1, max: 50, step: .5, d: 4,
     label: 'preselector Q factor (RF)'},

    {n: 'gain',  t: 'range', min: .1, max: 10, step: .1, d: 2,
     label: 'gain'}
  ],

  init: n => {
    n.ph = 0;

    // состояние преселекторного (RF) фильтра — стоит ДО смесителя
    n.zpre = [0, 0, 0, 0];
    n.keyPre = '';

    // состояние полосового фильтра ПЧ — стоит ПОСЛЕ смесителя
    n.z = [0, 0, 0, 0];
    n.key = '';

    // состояние DC-блокера на выходе
    n.dcX1 = 0;
    n.dcY1 = 0;

    n.level = 0;
  },

  // Пересчёт RBJ band-pass коэффициентов без сброса памяти фильтра —
  // это позволяет менять частоту/добротность "на ходу" без щелчков
  _bp(n, target, f, Q, sr) {
    const key = f + '/' + Q + '/' + sr;
    if (n[target + 'Key'] === key) return;
    n[target + 'Key'] = key;

    const fc = clamp(f, 20, sr * .45);
    const w = 2 * Math.PI * fc / sr;
    const s = Math.sin(w);
    const c = Math.cos(w);
    const alpha = s / (2 * Math.max(.1, Q));
    const a0 = 1 + alpha;

    n[target + 'b0'] =  alpha / a0;
    n[target + 'b1'] =  0;
    n[target + 'b2'] = -alpha / a0;
    n[target + 'a1'] = -2 * c / a0;
    n[target + 'a2'] = (1 - alpha) / a0;
    // ВАЖНО: n.z / n.zpre здесь НЕ сбрасываются —
    // именно сброс состояния при каждом изменении параметров
    // и давал щелчки в исходной версии
  },

  process(n, I) {
    const out = buf(n, 'out');
    const src = I.in;

    const rf   = pv(n, I, 'rf');
    const lo   = pv(n, I, 'lo');
    const Q    = pv(n, I, 'Q');
    const preQ = pv(n, I, 'preQ');
    const gain = pv(n, I, 'gain');

    for (const k of ['rf', 'lo', 'Q', 'gain']) if (typeof I[k] === 'number') setMod(n, k, I[k]);

    const ifHz = Math.abs(rf - lo);

    // 1) Преселектор на входе, центрирован на rf.
    //    Он подавляет зеркальную частоту (lo ± ifHz с другой стороны от lo)
    //    и посторонний спектр ДО смешения — как в реальном приёмнике.
    this._bp(n, 'pre', rf, preQ, Eng.sr);

    // 2) Полосовой фильтр ПЧ после смесителя
    this._bp(n, 'main', ifHz, Q, Eng.sr);

    let [px1, px2, py1, py2] = n.zpre;
    let [x1, x2, y1, y2] = n.z;
    let dcX1 = n.dcX1, dcY1 = n.dcY1;

    let sum = 0;
    let peak = 0;
    const R = 0.995; // коэффициент DC-блокера

    for (let i = 0; i < BLOCK; i++) {
      const x = src ? src[i] : 0;

      // --- преселектор (RF bandpass) ---
      const pre =
        n.preb0 * x +
        n.preb1 * px1 +
        n.preb2 * px2 -
        n.prea1 * py1 -
        n.prea2 * py2;
      px2 = px1; px1 = x;
      py2 = py1; py1 = pre;

      // --- смеситель ---
      const mixed = pre * Math.sin(2 * Math.PI * n.ph);

      // --- полосовой фильтр ПЧ ---
      const y =
        n.mainb0 * mixed +
        n.mainb1 * x1 +
        n.mainb2 * x2 -
        n.maina1 * y1 -
        n.maina2 * y2;
      x2 = x1; x1 = mixed;
      y2 = y1; y1 = y;

      // --- мягкое ограничение + усиление ---
      let v = Math.tanh(y * gain);

      // --- DC-блокер ---
      const dcOut = v - dcX1 + R * dcY1;
      dcX1 = v; dcY1 = dcOut;
      v = dcOut;

      out[i] = v;

      sum += v * v;
      peak = Math.max(peak, Math.abs(v));

      n.ph = (n.ph + lo / Eng.sr) % 1;
    }

    n.zpre = [px1, px2, py1, py2];
    n.z    = [x1, x2, y1, y2];
    n.dcX1 = dcX1;
    n.dcY1 = dcY1;

    const rms = Math.sqrt(sum / BLOCK);
    n.level = rms;

    return {
      out,
      level: rms
    };
  }
});


def({ id:'div', title:'Divider', cat:'Processing', ins:[{n:'a',t:'sig'},{n:'b',t:'sig'}],
  outs:[{n:'out',t:'sig'}], params:[{n:'eps',t:'num',d:1e-3}],
  process(n,I){ const o=buf(n,'out'), e=n.p.eps;
    for(let i=0;i<BLOCK;i++){ const b=I.b?I.b[i]:0;
      o[i]=clamp((I.a?I.a[i]:0)/(Math.abs(b)<e?(b<0?-e:e):b),-8,8); } return {out:o}; }});


def({ id:'sum', title:'Summer', cat:'Processing', ins:[{n:'a',t:'sig'},{n:'b',t:'sig'},{n:'ka',t:'num'},{n:'kb',t:'num'}],
  outs:[{n:'out',t:'sig'}],
  params:[{n:'ka',t:'range',min:-2,max:2,step:.01,d:1},{n:'kb',t:'range',min:-2,max:2,step:.01,d:1}],
  process(n,I){ if(typeof I.ka==='number') setMod(n,'ka',I.ka);
    if(typeof I.kb==='number') setMod(n,'kb',I.kb);
    const o=buf(n,'out');
    for(let i=0;i<BLOCK;i++) o[i]=(I.a?I.a[i]:0)*n.p.ka+(I.b?I.b[i]:0)*n.p.kb; return {out:o}; }});


// Микшер на 4 входа со своим уровнем/панорамой/мьютом на канал — свести sum→sum→sum для
// 4 источников (например, каналов rtlsdr) неудобно. Панорама — по закону равной мощности
// (sin/cos), не линейная: иначе сигнал в центре звучит тише разведённых по краям.
def({ id:'mixer4', title:'Mixer (4 channels)', cat:'Processing',
  ins:[{n:'a',t:'sig'},{n:'b',t:'sig'},{n:'c',t:'sig'},{n:'d',t:'sig'},
       {n:'ka',t:'num'},{n:'kb',t:'num'},{n:'kc',t:'num'},{n:'kd',t:'num'}],
  outs:[{n:'out',t:'sig'},{n:'L',t:'sig'},{n:'R',t:'sig'}],
  params:[
    {n:'ka',t:'range',min:0,max:2,step:.01,d:1,label:'A level'},
    {n:'pa',t:'range',min:-1,max:1,step:.01,d:-.6,label:'A pan'},
    {n:'ma',t:'check',d:false,label:'A mute'},
    {n:'kb',t:'range',min:0,max:2,step:.01,d:1,label:'B level'},
    {n:'pb',t:'range',min:-1,max:1,step:.01,d:-.2,label:'B pan'},
    {n:'mb',t:'check',d:false,label:'B mute'},
    {n:'kc',t:'range',min:0,max:2,step:.01,d:1,label:'C level'},
    {n:'pc',t:'range',min:-1,max:1,step:.01,d:.2,label:'C pan'},
    {n:'mc',t:'check',d:false,label:'C mute'},
    {n:'kd',t:'range',min:0,max:2,step:.01,d:1,label:'D level'},
    {n:'pd',t:'range',min:-1,max:1,step:.01,d:.6,label:'D pan'},
    {n:'md',t:'check',d:false,label:'D mute'}],
  process(n,I){
    for(const k of ['ka','kb','kc','kd']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const o=buf(n,'out'), oL=buf(n,'L'), oR=buf(n,'R');
    const chans=[['a','ka','pa','ma'],['b','kb','pb','mb'],['c','kc','pc','mc'],['d','kd','pd','md']];
    const active=chans.map(([sig,kk,pp,mm])=>{
      if(n.p[mm]) return null;
      const k=n.p[kk], ang=(clamp(n.p[pp],-1,1)+1)*Math.PI/4;
      return {sig, k, gl:Math.cos(ang)*k, gr:Math.sin(ang)*k};
    }).filter(Boolean);
    for(let i=0;i<BLOCK;i++){
      let m=0,l=0,r=0;
      for(const g of active){ const x=I[g.sig]?I[g.sig][i]:0;
        m+=x*g.k; l+=x*g.gl; r+=x*g.gr; }
      o[i]=clamp(m,-4,4); oL[i]=clamp(l,-4,4); oR[i]=clamp(r,-4,4);
    }
    return {out:o, L:oL, R:oR}; }});


// 12 каналов — та же схема, что у mixer4, только каналы a..l генерируются циклом,
// чтобы не расписывать вручную 36 параметров (уровень/панорама/мьют на каждый).
const MIXER12_CH=Array.from({length:12},(_,i)=>String.fromCharCode(97+i));   // 'a'..'l'
def({ id:'mixer12', title:'Mixer (12 channels)', cat:'Processing',
  ins:[...MIXER12_CH.map(c=>({n:c,t:'sig'})), ...MIXER12_CH.map(c=>({n:'k'+c,t:'num'}))],
  outs:[{n:'out',t:'sig'},{n:'L',t:'sig'},{n:'R',t:'sig'}],
  params:MIXER12_CH.flatMap((c,i)=>[
    {n:'k'+c,t:'range',min:0,max:2,step:.01,d:1,label:c.toUpperCase()+' level'},
    {n:'p'+c,t:'range',min:-1,max:1,step:.01,d:+(i/11*2-1).toFixed(2),label:c.toUpperCase()+' pan'},
    {n:'m'+c,t:'check',d:false,label:c.toUpperCase()+' mute'}]),
  process(n,I){
    for(const c of MIXER12_CH) if(typeof I['k'+c]==='number') setMod(n,'k'+c,I['k'+c]);
    const o=buf(n,'out'), oL=buf(n,'L'), oR=buf(n,'R');
    const active=MIXER12_CH.map(c=>{
      if(n.p['m'+c]) return null;
      const k=n.p['k'+c], ang=(clamp(n.p['p'+c],-1,1)+1)*Math.PI/4;
      return {sig:c, k, gl:Math.cos(ang)*k, gr:Math.sin(ang)*k};
    }).filter(Boolean);
    for(let i=0;i<BLOCK;i++){
      let m=0,l=0,r=0;
      for(const g of active){ const x=I[g.sig]?I[g.sig][i]:0;
        m+=x*g.k; l+=x*g.gl; r+=x*g.gr; }
      o[i]=clamp(m,-8,8); oL[i]=clamp(l,-8,8); oR[i]=clamp(r,-8,8);
    }
    return {out:o, L:oL, R:oR}; }});


def({ id:'biquad', title:'Filter', cat:'Processing', ins:[{n:'in',t:'sig'},{n:'freq',t:'num'},{n:'Q',t:'num'}],
  outs:[{n:'out',t:'sig'}],
  params:[{n:'type',t:'select',opts:['lp','hp','bp','notch','ap'],d:'lp'},
          {n:'freq',t:'range',min:20,max:()=>Eng.sr/2,step:1,d:1000,log:true},
          {n:'Q',t:'range',min:.1,max:20,step:.1,d:.707}],
  init:n=>{n.z=[0,0,0,0];},
  process(n,I){ if(typeof I.Q==='number') setMod(n,'Q',I.Q);
    const o=buf(n,'out'), f=pv(n,I,'freq');
    const [b0,b1,b2,a1,a2]=biquadCoef(n.p.type,f,n.p.Q,Eng.sr);
    let [x1,x2,y1,y2]=n.z;
    for(let i=0;i<BLOCK;i++){ const x=I.in?I.in[i]:0;
      const y=b0*x+b1*x1+b2*x2-a1*y1-a2*y2;
      x2=x1; x1=x; y2=y1; y1=y; o[i]=y; }
    n.z=[x1,x2,y1,y2]; return {out:o}; }});

def({ id:'adsr', title:'ADSR Envelope', cat:'Audio', ins:[{n:'gate',t:'sig'}],
  outs:[{n:'out',t:'sig'}], readout:true,
  params:[{n:'attack',t:'range',min:.001,max:3,step:.001,d:.01,log:true,label:'A'},
          {n:'decay',t:'range',min:.001,max:3,step:.001,d:.1,log:true,label:'D'},
          {n:'sustain',t:'range',min:0,max:1,step:.01,d:.7,label:'S'},
          {n:'release',t:'range',min:.001,max:5,step:.001,d:.2,log:true,label:'R'}],
  init:n=>{ n.stage='idle'; n.lvl=0; n.pv=0; n.relFrom=0; },
  process(n,I){
    const o=buf(n,'out'), g=I.gate, p=n.p, sr=Eng.sr;
    for(let i=0;i<BLOCK;i++){
      const gv=g?g[i]:0;
      if(gv>0&&n.pv<=0) n.stage='a';
      else if(gv<=0&&n.pv>0){ n.stage='r'; n.relFrom=n.lvl; }
      n.pv=gv;
      if(n.stage==='a'){ n.lvl+=1/(p.attack*sr); if(n.lvl>=1){ n.lvl=1; n.stage='d'; } }
      else if(n.stage==='d'){ n.lvl-=(1-p.sustain)/(p.decay*sr); if(n.lvl<=p.sustain){ n.lvl=p.sustain; n.stage='s'; } }
      else if(n.stage==='s'){ n.lvl=p.sustain; }
      else if(n.stage==='r'){ n.lvl-=n.relFrom/(p.release*sr); if(n.lvl<=0){ n.lvl=0; n.stage='idle'; } }
      o[i]=n.lvl; }
    return {out:o}; },
  draw(n){ n.el.querySelector('.readout').textContent = n.stage+' · '+n.lvl.toFixed(2); }});

def({ id:'dist', title:'Distortion', cat:'Audio', ins:[{n:'in',t:'sig'},{n:'drive',t:'num'}],
  outs:[{n:'out',t:'sig'}],
  params:[{n:'type',t:'select',opts:['tanh','hard','fold'],d:'tanh'},
          {n:'drive',t:'range',min:1,max:50,step:.1,d:4,log:true},
          {n:'mix',t:'range',min:0,max:1,step:.01,d:1},
          {n:'out',t:'range',min:0,max:2,step:.01,d:.5,label:'level'}],
  process(n,I){
    if(typeof I.drive==='number') setMod(n,'drive',I.drive);
    const o=buf(n,'out'), d=n.p.drive, mix=n.p.mix, og=n.p.out, ty=n.p.type;
    for(let i=0;i<BLOCK;i++){
      const x=I.in?I.in[i]:0, xd=x*d;
      let y;
      if(ty==='tanh') y=Math.tanh(xd);
      else if(ty==='hard') y=clamp(xd,-1,1);
      else { y=xd; while(y>1||y<-1){ if(y>1) y=2-y; if(y<-1) y=-2-y; } }   // foldback
      o[i]=(x*(1-mix)+y*mix)*og; }
    return {out:o}; }});

def({ id:'reverb', title:'Reverb', cat:'Audio', ins:[{n:'in',t:'sig'},{n:'mix',t:'num'}],
  outs:[{n:'out',t:'sig'}],
  params:[{n:'size',t:'range',min:.3,max:1.2,step:.01,d:.8,label:'size'},
          {n:'damp',t:'range',min:0,max:1,step:.01,d:.4,label:'damping'},
          {n:'mix',t:'range',min:0,max:1,step:.01,d:.3}],
  init:n=>{
    const k=Eng.sr/44100;                              // масштаб длин линий под текущую sr
    n.combs=[1116,1188,1277,1356].map(t=>({buf:new Float32Array(Math.round(t*k)),idx:0,fs:0}));
    n.alls=[556,441].map(t=>({buf:new Float32Array(Math.round(t*k)),idx:0})); },
  process(n,I){
    if(typeof I.mix==='number') setMod(n,'mix',I.mix);
    const o=buf(n,'out'), p=n.p, fb=.28+p.size*.7, damp=p.damp*.4;
    for(let i=0;i<BLOCK;i++){
      const x=(I.in?I.in[i]:0)*.03;
      let s=0;
      for(const c of n.combs){
        const out=c.buf[c.idx]; c.fs=out*(1-damp)+c.fs*damp;
        c.buf[c.idx]=x+c.fs*fb; c.idx=(c.idx+1)%c.buf.length; s+=out; }
      for(const a of n.alls){
        const bo=a.buf[a.idx], ao=-s+bo;
        a.buf[a.idx]=s+bo*.5; a.idx=(a.idx+1)%a.buf.length; s=ao; }
      o[i]=(I.in?I.in[i]:0)*(1-p.mix)+s*p.mix; }
    return {out:o}; }});


def({ id:'iq', title:'Quadrature Shift', cat:'Processing',
  ins:[{n:'in',t:'sig'},{n:'fc',t:'num'},{n:'bw',t:'num'},{n:'gain',t:'num'}], outs:[{n:'I',t:'sig'},{n:'Q',t:'sig'}],
  params:[{n:'fc',t:'range',min:100,max:()=>Eng.sr/2,step:1,d:5000,log:true},
          {n:'bw',t:'range',min:50,max:8000,step:10,d:1500,log:true},
          {n:'gain',t:'range',min:1,max:32,step:.5,d:2}],
  init:n=>{n.ph=0;n.li=[0,0];n.lq=[0,0];},
  process(n,I){
    if(typeof I.bw==='number') setMod(n,'bw',I.bw);
    if(typeof I.gain==='number') setMod(n,'gain',I.gain);
    const oi=buf(n,'I'), oq=buf(n,'Q'), fc=pv(n,I,'fc'), g=n.p.gain;
    const a=Math.exp(-2*Math.PI*n.p.bw/Eng.sr), dp=fc/Eng.sr;
    for(let i=0;i<BLOCK;i++){
      const x=I.in?I.in[i]:0, w=2*Math.PI*n.ph;
      let vi=x*Math.cos(w), vq=-x*Math.sin(w);
      n.li[0]=n.li[0]*a+vi*(1-a); n.li[1]=n.li[1]*a+n.li[0]*(1-a);
      n.lq[0]=n.lq[0]*a+vq*(1-a); n.lq[1]=n.lq[1]*a+n.lq[0]*(1-a);
      oi[i]=n.li[1]*g; oq[i]=n.lq[1]*g; n.ph=(n.ph+dp)%1; }
    return {I:oi,Q:oq}; }});


// БПФ узкой полосы: берёт I/Q после 'iq' (несущая уже сведена в 0 Гц, ФНЧ уже подавил всё
// лишнее) и прореживает перед БПФ — раз полезной информации после фильтра осталось только
// ±bw/2, для неё достаточно частоты дискретизации Eng.sr/dec. Тот же размер окна N при этом
// даёт бин шириной (Eng.sr/dec)/N вместо Eng.sr/N — во столько раз dec точнее по частоте,
// и сама БПФ дешевле (N меньше при равной детализации в Гц). 'fc' тут — то же значение, что
// стоит в 'iq': нужно для подписи оси частот (спектр строится вокруг него, не вокруг нуля).
// dec задавайте так, чтобы Eng.sr/dec было заметно больше bw в 'iq' — иначе алиасинг.
def({ id:'zfft', title:'Zoom-FFT (I/Q)', cat:'Processing',
  ins:[{n:'I',t:'sig'},{n:'Q',t:'sig'},{n:'fc',t:'num'}], outs:[{n:'spec',t:'spec'}],
  params:[{n:'fc',t:'range',min:0,max:()=>Eng.sr/2,step:1,d:5000,log:true,label:'carrier (same as iq), Hz'},
          {n:'dec',t:'select',opts:['1','2','4','8','16','32','64'],d:'8',label:'decimation'},
          {n:'size',t:'select',opts:['256','512','1024','2048','4096','8192','16384'],d:'2048'},
          {n:'win',t:'select',opts:['hann','hamming','blackman','rect'],d:'hann'}],
  init:n=>{ n.N=0; n.gi=0; n.absPos=0; n.lpDec=0; },
  process(n,I){
    const dec=Math.max(1,+n.p.dec||1), N=Math.max(+n.p.size,8);
    if(n.N!==N||n.wk!==n.p.win){
      n.N=N; n.wk=n.p.win;
      n.ringI=new Float32Array(N); n.ringQ=new Float32Array(N);
      n.re=new Float32Array(N); n.im=new Float32Array(N);
      n.mag=new Float32Array(N); n.freqs=new Float32Array(N); n.phase=new Float32Array(N);
      n.psd=new Float32Array(N);
      n.scrI=new Float32Array(BLOCK); n.scrQ=new Float32Array(BLOCK);
      n.fI=new Float32Array(BLOCK); n.fQ=new Float32Array(BLOCK);
      n.w=window_(n.p.win,N);
      let sum=0, sum2=0; for(let i=0;i<N;i++){ sum+=n.w[i]; sum2+=n.w[i]*n.w[i]; }
      n.wGain=sum; n.wGain2=sum2;
    }
    const fc=pv(n,I,'fc'), effSr=Eng.sr/dec;
    if(n.lpDec!==dec){ n.lpDec=dec; n.lpZ=new Float32Array(24); }   // 2 канала × 3 каскада × (x1,x2,y1,y2)
    // Антиалиасинг перед прореживанием: без него всё, что выше effSr/2 (в т.ч. слабо подавленный
    // 2-полюсным ФНЧ 'iq' зеркальный образ смесителя далеко за пределами нужной полосы), при
    // децимации складывается обратно в видимое окно кашей. 3 каскада биквада, тот же приём,
    // что и в KiwiSDR — cutoff берём с запасом от Найквиста децимированной частоты.
    const cutoff=Math.min(effSr*0.4, Eng.sr*0.48);
    const [b0,b1,b2,a1,a2]=biquadCoef('lp',cutoff,0.707,Eng.sr);
    const z=n.lpZ;
    const stage=(x,o)=>{ const y=b0*x+b1*z[o]+b2*z[o+1]-a1*z[o+2]-a2*z[o+3];
      z[o+1]=z[o]; z[o]=x; z[o+3]=z[o+2]; z[o+2]=y; return y; };
    for(let i=0;i<BLOCK;i++){
      let vi=I.I?I.I[i]:0, vq=I.Q?I.Q[i]:0;
      vi=stage(vi,0); vi=stage(vi,4); vi=stage(vi,8);
      vq=stage(vq,12); vq=stage(vq,16); vq=stage(vq,20);
      n.fI[i]=vi; n.fQ[i]=vq; }
    let m=0;                                          // прореживаем: берём каждый dec-й отсчёт блока
    for(let i=0;i<BLOCK;i++){
      if(n.gi%dec===0){ n.scrI[m]=n.fI[i]; n.scrQ[m]=n.fQ[i]; m++; }
      n.gi++; }
    if(m>0){
      if(m>=N){ n.ringI.set(n.scrI.subarray(m-N,m)); n.ringQ.set(n.scrQ.subarray(m-N,m)); }
      else{
        n.ringI.copyWithin(0,m); n.ringQ.copyWithin(0,m);
        n.ringI.set(n.scrI.subarray(0,m),N-m); n.ringQ.set(n.scrQ.subarray(0,m),N-m);
      }
    }
    for(let i=0;i<N;i++){ n.re[i]=n.ringI[i]*n.w[i]; n.im[i]=n.ringQ[i]*n.w[i]; }
    fft(n.re,n.im);                                   // комплексный БПФ — тот же fft(), что и у обычного узла
    // fc был снят смесителем ('iq') в непрерывном времени — фаза бина сама по себе отражает
    // только базовую (уже сдвинутую) составляющую. Чтобы 'sa' могла мерить частоту по сдвигу
    // фазы между кадрами через абсолютную метку fr (а не через сырой номер бина, который она
    // не знает), возвращаем в фазу тот самый снятый поворот несущей — иначе фазовый метод даёт
    // грубо неверную частоту (проверено численно: без поправки ошибка в десятки герц).
    const t0=(n.absPos+m-N)/effSr;                    // абсолютное время образца ring[0]
    let corr=2*Math.PI*fc*t0; corr-=2*Math.PI*Math.floor(corr/(2*Math.PI));
    n.absPos+=m;
    // СПМ комплексного спектра — без ×2: каждый бин тут уникален (не зеркалит другой), в
    // отличие от одностороннего спектра реального сигнала у 'fft'.
    const psdNorm=1/(effSr*n.wGain2);
    for(let k=0;k<N;k++){
      const src=(k+(N>>1))%N;                         // fftshift: DC (несущая fc) — в центр окна
      n.mag[k]=Math.hypot(n.re[src],n.im[src])/n.wGain;
      n.psd[k]=(n.re[src]*n.re[src]+n.im[src]*n.im[src])*psdNorm;
      let ph=Math.atan2(n.im[src],n.re[src])+corr;
      n.phase[k]=ph-2*Math.PI*Math.round(ph/(2*Math.PI));   // держим в (-π,π]
      n.freqs[k]=fc+(k-(N>>1))*effSr/N; }
    n.sp=n.sp||{}; n.sp.mag=n.mag; n.sp.phase=n.phase; n.sp.psd=n.psd; n.sp.hop=m;
    n.sp.freqs=n.freqs; n.sp.sr=effSr; n.sp.size=N;
    n.sp.rev=(n.sp.rev|0)+1;
    return {spec:n.sp}; }});


def({ id:'polar', title:'Magnitude/Phase (I/Q → polar)', cat:'Processing', ins:[{n:'I',t:'sig'},{n:'Q',t:'sig'}],
  outs:[{n:'mag',t:'sig'},{n:'phase',t:'sig'},{n:'dphase',t:'sig'}],
  init:n=>{n.pp=0;},
  process(n,I){ const m=buf(n,'mag'), p=buf(n,'phase'), d=buf(n,'dphase');
    for(let i=0;i<BLOCK;i++){ const re=I.I?I.I[i]:0, im=I.Q?I.Q[i]:0;
      m[i]=Math.hypot(re,im); const ph=Math.atan2(im,re);
      let dd=ph-n.pp; while(dd>Math.PI)dd-=2*Math.PI; while(dd<-Math.PI)dd+=2*Math.PI;
      p[i]=ph/Math.PI; d[i]=dd*Eng.sr/(2*Math.PI)/(Eng.sr/2); n.pp=ph; }
    return {mag:m,phase:p,dphase:d}; }});


// В отличие от iq (квадратурный смеситель на заданную несущую), hilbert — широкополосный:
// I — просто задержанный вход, Q — вход, сдвинутый на 90° сразу на всех частотах полосы.
// Даёт аналитический сигнал без настройки на конкретную частоту — годится для SSB без
// фильтра несущей, огибающей произвольного сигнала, мгновенной фазы/частоты и т.п.
function hilbertTaps(N){                    // N — нечётное число отводов; больше — шире и точнее полоса
  const h=new Float32Array(N), M=(N-1)/2;
  for(let n=0;n<N;n++){
    const k=n-M;
    if(k===0||k%2===0){ h[n]=0; continue; }               // чётные отводы (и центр) — нулевые у идеального Гильберта
    const ideal=2/(Math.PI*k);
    const w=0.42-0.5*Math.cos(2*Math.PI*n/(N-1))+0.08*Math.cos(4*Math.PI*n/(N-1));   // окно Блэкмана — подавить пульсации
    h[n]=ideal*w;
  }
  return h;
}
def({ id:'hilbert', title:'Hilbert Transform', cat:'Processing', ins:[{n:'in',t:'sig'}],
  outs:[{n:'I',t:'sig'},{n:'Q',t:'sig'}],
  params:[{n:'taps',t:'range',min:31,max:255,step:2,d:127,label:'taps (odd)'}],
  init:n=>{ n.N=0; },
  process(n,I){
    let N=n.p.taps|0; if(N%2===0) N++;
    if(N!==n.N){ n.N=N; n.h=hilbertTaps(N); n.buf=new Float32Array(N); n.wi=0; }  // пересборка при смене длины
    const oi=buf(n,'I'), oq=buf(n,'Q'), x=I.in, M=(N-1)>>1, h=n.h, rb=n.buf;
    for(let i=0;i<BLOCK;i++){
      rb[n.wi]=x?x[i]:0;
      let q=0;
      for(let k=0;k<N;k++) q+=h[k]*rb[(n.wi-k+N*2)%N];             // свёртка по кольцевому буферу
      oq[i]=q;
      oi[i]=rb[(n.wi-M+N*2)%N];                                    // та же групповая задержка, что у Q
      n.wi=(n.wi+1)%N;
    }
    return {I:oi, Q:oq}; }});


// Фазоскоп: X-Y осциллограф (фигуры Лиссажу) + метр фазовой корреляции пары каналов.
// +1 — каналы синфазны, −1 — в противофазе (взаимно гасят друг друга в моно), 0 — не связаны.
def({ id:'xyscope', title:'Phase Scope (X-Y)', cat:'Processing', ins:[{n:'x',t:'sig'},{n:'y',t:'sig'}],
  outs:[{n:'corr',t:'num'}],
  view:{h:220}, resize:true, readout:true,
  params:[{n:'gain',t:'range',min:.1,max:8,step:.1,d:1,label:'gain'},
          {n:'persist',t:'range',min:0,max:.98,step:.01,d:.85,label:'persistence'}],
  init:n=>{ n.corr=0; n._x=null; n._y=null; },
  process(n,I){
    const x=I.x, y=I.y;
    n._x=x; n._y=y;
    let sxx=0,syy=0,sxy=0;
    for(let i=0;i<BLOCK;i++){ const xv=x?x[i]:0, yv=y?y[i]:0; sxx+=xv*xv; syy+=yv*yv; sxy+=xv*yv; }
    const denom=Math.sqrt(sxx*syy), c=denom>1e-9?sxy/denom:0;
    n.corr=n.corr*0.7+c*0.3;                                        // сглаживаем — иначе метр дёргается
    return {corr:n.corr}; },
  draw(n){
    const cv=n.cv, cx=n.cx; if(!cv) return;
    const W=cv.width, H=cv.height, MH=18, plotH=H-MH;
    cx.fillStyle=`rgba(11,13,14,${1-n.p.persist})`;                  // не clearRect — точки оставляют след
    cx.fillRect(0,0,W,plotH);
    const cxm=W/2, cym=plotH/2, s=Math.min(W,plotH)/2*0.9*n.p.gain;
    cx.strokeStyle='rgba(255,255,255,.06)'; cx.lineWidth=1;
    cx.beginPath(); cx.moveTo(0,cym); cx.lineTo(W,cym); cx.moveTo(cxm,0); cx.lineTo(cxm,plotH); cx.stroke();
    const x=n._x, y=n._y;
    if(x&&y){
      cx.fillStyle=themeColor('--t-img');
      for(let i=0;i<x.length;i+=2){                                  // через сэмпл — экономим отрисовку
        const px=cxm+clamp(x[i],-2,2)*s, py=cym-clamp(y[i],-2,2)*s;
        cx.fillRect(px,py,1.4,1.4); } }
    cx.fillStyle=themeColor('--screen'); cx.fillRect(0,plotH,W,MH);
    const half=W/2, mx=half+n.corr*half;
    cx.fillStyle='rgba(255,255,255,.08)'; cx.fillRect(0,plotH+2,W,MH-4);
    cx.fillStyle = n.corr<0 ? themeColor('--err') : themeColor('--t-blk');
    cx.fillRect(Math.min(half,mx),plotH+2,Math.abs(mx-half),MH-4);
    cx.strokeStyle='rgba(255,255,255,.3)';
    cx.beginPath(); cx.moveTo(half,plotH+1); cx.lineTo(half,plotH+MH-1); cx.stroke();
    n.el.querySelector('.readout').textContent='correlation '+n.corr.toFixed(2)+
      (n.corr>0.7?' · in phase':n.corr<-0.7?' · out of phase':(n.corr<0.2&&n.corr>-0.2)?' · uncorrelated':''); }});


// Моностатический сонар: тот же тракт (динамик+микрофон одного устройства) излучает
// короткий чирп и слушает переотражения. Матч-фильтр (корреляция с копией чирпа) ищет
// пики только в окне maxDelay — это на порядки дешевле, чем искать по всему периоду,
// и физически осмысленно: цели дальше окна всё равно вне интереса.
// ВАЖНО: у mic-узла на входе должно быть выключено echo/ns/agc — иначе браузер сам
// вырежет или исказит адаптивной обработкой ровно тот сигнал, который тут измеряется.
function sonarBuildChirp(fLo,fHi,dur,sr){
  const N=Math.max(8,Math.round(dur*sr));
  const buf=new Float32Array(N);
  let ph=0;
  for(let i=0;i<N;i++){
    const t=i/sr, f=fLo+(fHi-fLo)*(t/dur);
    ph+=f/sr;
    const edge=Math.min(1, i/(N*0.08), (N-1-i)/(N*0.08));   // короткий скос на краях — меньше щелчков и боковых лепестков
    buf[i]=Math.sin(2*Math.PI*ph)*Math.max(0,edge);
  }
  return buf;
}
// Раз в период: корреляция → по её результату локальный Гильберт (не потоковый, как у
// hilbert-узла, а centered-свёртка по готовому массиву — тут это проще и точнее, задержку
// компенсировать не нужно). Огибающая — для пикинга целей, фаза — для микросмещений.
function sonarAnalyze(n,p,sr){
  const chirp=n.chirp, chirpLen=n.chirpLen, rx=n.rx, maxLag=n.maxLag;
  const c=new Float32Array(maxLag);
  let chirpE=0; for(let k=0;k<chirpLen;k++) chirpE+=chirp[k]*chirp[k];
  for(let lag=0;lag<maxLag;lag++){
    let s=0; for(let k=0;k<chirpLen;k++) s+=chirp[k]*rx[lag+k];
    c[lag]=s/(chirpE||1);
  }
  let N=Math.min(65,maxLag-1); if(N%2===0) N--; if(N<5) N=5;
  const h=hilbertTaps(N), M=(N-1)/2;
  const env=new Float32Array(maxLag), ph=new Float32Array(maxLag);
  for(let lag=0;lag<maxLag;lag++){
    let q=0;
    for(let k=0;k<N;k++){ const idx=lag+(k-M); if(idx>=0&&idx<maxLag) q+=h[k]*c[idx]; }
    const re=c[lag];
    env[lag]=Math.hypot(re,q); ph[lag]=Math.atan2(q,re);
  }
  const peakEnv=Math.max(1e-9,...env);
  const candidates=[];
  for(let i=1;i<maxLag-1;i++)
    if(env[i]>env[i-1] && env[i]>=env[i+1] && env[i]>p.thr*peakEnv) candidates.push(i);
  candidates.sort((a,b)=>env[b]-env[a]);
  const chosen=[], minGap=Math.max(4,chirpLen*0.05);
  for(const i of candidates){
    if(chosen.every(j=>Math.abs(j-i)>minGap)) chosen.push(i);
    if(chosen.length>=3) break;
  }
  for(let k=0;k<3;k++){
    const i=chosen[k];
    if(i==null){ n.peaks[k].lvl=0; continue; }
    n.peaks[k].lag=i; n.peaks[k].lvl=env[i]/peakEnv;
  }
  // микросмещение по фазе — только для сильнейшего пика (надёжнее, чем сопровождать все три сразу)
  if(chosen[0]!=null){
    const curPh=ph[chosen[0]];
    if(n._havePrevPh){
      let d=curPh-n._prevPh; while(d>Math.PI)d-=2*Math.PI; while(d<-Math.PI)d+=2*Math.PI;
      const lambda=p.speedSound/((p.fLo+p.fHi)/2);          // приближение: несущая корреляции ≈ средняя частота чирпа
      n.motion+=d/(2*Math.PI)*lambda/2;                      // накопленное смещение цели, м (/2 — путь туда-обратно)
    }
    n._prevPh=curPh; n._havePrevPh=true;
  } else n._havePrevPh=false;
  n.env=env;
}
def({ id:'sonar', title:'Monostatic Sonar (chirp)', cat:'Radar', ins:[{n:'in',t:'sig'}],
  outs:[{n:'out',t:'sig'},
        {n:'range1',t:'num'},{n:'level1',t:'num'},{n:'motion1',t:'num'},
        {n:'range2',t:'num'},{n:'level2',t:'num'},
        {n:'range3',t:'num'},{n:'level3',t:'num'}],
  view:{h:200}, resize:true, readout:true,
  params:[
    {n:'fLo',t:'range',min:15000,max:()=>Eng.sr/2,step:100,d:18000,label:'chirp: from, Hz'},
    {n:'fHi',t:'range',min:15000,max:()=>Eng.sr/2,step:100,d:22000,label:'chirp: to, Hz'},
    {n:'dur',t:'range',min:3,max:40,step:1,d:12,label:'duration, ms'},
    {n:'period',t:'range',min:30,max:300,step:1,d:100,label:'period, ms'},
    {n:'maxDelay',t:'range',min:3,max:80,step:1,d:25,label:'search window, ms'},
    {n:'amp',t:'range',min:0,max:1,step:.01,d:.4,label:'volume'},
    {n:'thr',t:'range',min:.02,max:.9,step:.01,d:.15,label:'peak threshold'},
    {n:'speedSound',t:'range',min:300,max:360,step:1,d:343,label:'speed of sound, m/s'}],
  init:n=>{ n._key=''; n.phase=0; n.motion=0; n._havePrevPh=false; n.env=null;
    n.peaks=[{lag:0,lvl:0},{lag:0,lvl:0},{lag:0,lvl:0}]; },
  process(n,I){
    const p=n.p, sr=Eng.sr;
    const key=p.fLo+'|'+p.fHi+'|'+p.dur+'|'+p.period+'|'+p.maxDelay;
    if(key!==n._key){                                       // параметры сменились — пересобираем шаблон и буферы
      n._key=key;
      n.chirp=sonarBuildChirp(p.fLo,p.fHi,p.dur/1000,sr);
      n.chirpLen=n.chirp.length;
      n.periodLen=Math.max(n.chirpLen+8,Math.round(p.period/1000*sr));
      n.maxLag=Math.max(4,Math.min(Math.round(p.maxDelay/1000*sr), n.periodLen-n.chirpLen-1));
      n.rx=new Float32Array(n.periodLen);
      n.phase=0;
    }
    const o=buf(n,'out'), x=I.in;
    for(let i=0;i<BLOCK;i++){
      const ph=n.phase;
      o[i]=ph<n.chirpLen ? n.chirp[ph]*p.amp : 0;
      n.rx[ph]=x?x[i]:0;
      n.phase++;
      if(n.phase>=n.periodLen){ n.phase=0; sonarAnalyze(n,p,sr); }   // период закончился — считаем корреляцию разом
    }
    const out={out:o, motion1:n.motion};
    for(let k=0;k<3;k++){ const pk=n.peaks[k];
      out['range'+(k+1)]=pk.lag/sr*p.speedSound/2; out['level'+(k+1)]=pk.lvl; }
    return out; },
  draw(n){
    const cv=n.cv, cx=n.cx; if(!cv||!n.env) return;
    const W=cv.width, H=cv.height;
    cx.clearRect(0,0,W,H);
    const N=n.env.length, mx=Math.max(1e-6,...n.env);
    cx.strokeStyle=themeColor('--t-img'); cx.lineWidth=1.2; cx.beginPath();
    for(let i=0;i<N;i++){ const x=i/N*W, y=H-2-(n.env[i]/mx)*(H-6);
      i===0?cx.moveTo(x,y):cx.lineTo(x,y); }
    cx.stroke();
    cx.fillStyle='rgba(224,178,60,.85)';
    for(const pk of n.peaks) if(pk.lvl>0) cx.fillRect(pk.lag/N*W-1,0,2,H);
    const sr=Eng.sr||48000;
    n.el.querySelector('.readout').textContent =
      n.peaks.filter(pk=>pk.lvl>0).map((pk,i)=>'#'+(i+1)+': '+(pk.lag/sr*n.p.speedSound/2).toFixed(2)+' m').join(' · ')
      || 'no echo found'; }});


def({ id:'env', title:'Envelope', cat:'Processing', ins:[{n:'in',t:'sig'},{n:'atk',t:'num'},{n:'rel',t:'num'}],
  outs:[{n:'out',t:'sig'},{n:'level',t:'num'}],
  params:[{n:'atk',t:'range',min:.1,max:200,step:.1,d:3},
          {n:'rel',t:'range',min:1,max:2000,step:1,d:80}],
  init:n=>{n.e=0;},
  process(n,I){ if(typeof I.atk==='number') setMod(n,'atk',I.atk);
    if(typeof I.rel==='number') setMod(n,'rel',I.rel);
    const o=buf(n,'out');
    const ca=Math.exp(-1/(Eng.sr*n.p.atk/1000)), cr=Math.exp(-1/(Eng.sr*n.p.rel/1000));
    for(let i=0;i<BLOCK;i++){ const x=Math.abs(I.in?I.in[i]:0);
      n.e = x>n.e ? ca*n.e+(1-ca)*x : cr*n.e+(1-cr)*x; o[i]=n.e; }
    return {out:o,level:n.e}; }});


def({ id:'delay', title:'Delay', cat:'Audio', ins:[{n:'in',t:'sig'},{n:'ms',t:'num'},{n:'fb',t:'num'},{n:'mix',t:'num'}],
  outs:[{n:'out',t:'sig'}],
  params:[{n:'ms',t:'range',min:1,max:1000,step:1,d:200},
          {n:'fb',t:'range',min:0,max:.95,step:.01,d:.3},
          {n:'mix',t:'range',min:0,max:1,step:.01,d:.5}],
  init:n=>{n.line=new Float32Array(48000*2); n.w=0;},
  process(n,I){
    for(const k of ['ms','fb','mix']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const o=buf(n,'out'), L=n.line.length;
    const d=Math.max(1,Math.round(Eng.sr*n.p.ms/1000))%L;
    for(let i=0;i<BLOCK;i++){ const x=I.in?I.in[i]:0;
      const r=(n.w-d+L)%L, y=n.line[r];
      n.line[n.w]=x+y*n.p.fb; n.w=(n.w+1)%L;
      o[i]=x*(1-n.p.mix)+y*n.p.mix; }
    return {out:o}; }});


def({ id:'dc', title:'Remove DC', cat:'Processing', ins:[{n:'in',t:'sig'},{n:'freq',t:'num'}], outs:[{n:'out',t:'sig'}],
  params:[{n:'freq',t:'range',min:1,max:400,step:1,d:20}],
  init:n=>{n.x1=0;n.y1=0;},
  process(n,I){ if(typeof I.freq==='number') setMod(n,'freq',I.freq);
    const o=buf(n,'out'), R=1-2*Math.PI*n.p.freq/Eng.sr;
    for(let i=0;i<BLOCK;i++){ const x=I.in?I.in[i]:0;
      const y=x-n.x1+R*n.y1; n.x1=x; n.y1=y; o[i]=y; }
    return {out:o}; }});


def({ id:'fft', title:'FFT', cat:'Processing', ins:[{n:'in',t:'sig'}], outs:[{n:'spec',t:'spec'}],
  params:[{n:'size',t:'select',opts:['512','1024','2048','4096','8192','16384','32768','65536'],d:'2048'},
          {n:'win',t:'select',opts:['hann','hamming','blackman','rect'],d:'hann'}],
  init:n=>{n.N=0;},
  process(n,I){
    const N=Math.max(+n.p.size, BLOCK*2);          // окно не короче блока
    if(n.N!==N||n.wk!==n.p.win){ n.N=N; n.wk=n.p.win; n.ring=new Float32Array(N);
      n.re=new Float32Array(N); n.im=new Float32Array(N); n.mag=new Float32Array(N/2);
      n.phase=new Float32Array(N/2); n.psd=new Float32Array(N/2);
      n.w=window_(n.p.win,N);
      let sum=0, sum2=0; for(let i=0;i<N;i++){ sum+=n.w[i]; sum2+=n.w[i]*n.w[i]; }
      n.wGain=sum;                                  // когерентное усиление окна — для верной абс. амплитуды
      n.wGain2=sum2; }                               // энергия окна — для верной СПМ (Вт/Гц), другая нормировка
    n.ring.copyWithin(0,BLOCK); // сдвиг окна на блок
    for(let i=0;i<BLOCK;i++) n.ring[N-BLOCK+i]=I.in?I.in[i]:0;
    for(let i=0;i<N;i++){ n.re[i]=n.ring[i]*n.w[i]; n.im[i]=0; }
    fft(n.re,n.im);
    // СПМ (одностороння): |X|²·2/(sr·Σw²) — не путать с амплитудой (|X|·2/Σw): у СПМ своя
    // нормировка на полосу (Гц), из-за неё шумовой пол не зависит от размера окна, у амплитуды
    // такой независимости нет и не должно быть (амплитуда тона — просто амплитуда тона).
    const psdNorm=1/(Eng.sr*n.wGain2);
    n.mag[0]=Math.hypot(n.re[0],n.im[0])/n.wGain;   // DC без ×2 — нет зеркальной составляющей
    n.phase[0]=0; n.psd[0]=(n.re[0]*n.re[0]+n.im[0]*n.im[0])*psdNorm;
    for(let i=1;i<N/2;i++){
      n.mag[i]=2*Math.hypot(n.re[i],n.im[i])/n.wGain; n.phase[i]=Math.atan2(n.im[i],n.re[i]);
      n.psd[i]=2*(n.re[i]*n.re[i]+n.im[i]*n.im[i])*psdNorm; }
    n.sp=n.sp||{}; n.sp.mag=n.mag; n.sp.phase=n.phase; n.sp.psd=n.psd; n.sp.hop=BLOCK;
    n.sp.sr=Eng.sr; n.sp.size=N; n.sp.freqs=null;
    n.sp.rev=(n.sp.rev|0)+1;                        // счётчик пересчётов — объект переиспользуется, ссылка не меняется
    return {spec:n.sp}; }});


def({ id:'scan', title:'Frame Line', cat:'Video', ins:[{n:'img',t:'img'},{n:'row',t:'num'},{n:'gain',t:'num'}],
  outs:[{n:'out',t:'sig'}],
  params:[{n:'row',t:'range',min:0,max:1,step:.01,d:.5},
          {n:'gain',t:'range',min:.1,max:10,step:.1,d:2}],
  process(n,I){
    if(typeof I.row==='number') setMod(n,'row',I.row);
    if(typeof I.gain==='number') setMod(n,'gain',I.gain);
    const o=buf(n,'out');
    if(!I.img){ o.fill(0); return {out:o}; }
    const {w,h}=I.img, y=Math.min(h-1,Math.round(n.p.row*(h-1)));
    const px=I.img.gray?null:I.img.data.data, gb=I.img.buf;
    let mean=0; const tmp=new Float32Array(w);
    for(let x=0;x<w;x++){ const k=(y*w+x)*4;
      tmp[x]= px ? (px[k]*.299+px[k+1]*.587+px[k+2]*.114)/255 : gb[y*w+x];
      mean+=tmp[x]; }
    mean/=w;
    for(let i=0;i<BLOCK;i++){ const t=i/(BLOCK-1)*(w-1), i0=t|0, fr=t-i0;
      o[i]=((tmp[i0]*(1-fr)+tmp[Math.min(w-1,i0+1)]*fr)-mean)*n.p.gain; }
    return {out:o}; }});


def({ id:'bright', title:'Region Brightness', cat:'Video',
  ins:[{n:'img',t:'img'},{n:'x',t:'num'},{n:'y',t:'num'},{n:'w',t:'num'},{n:'h',t:'num'},
       {n:'auto',t:'num'},{n:'invert',t:'num'}],
  outs:[{n:'out',t:'num'},{n:'raw',t:'num'}], view:{h:46},
  params:[{n:'x',t:'range',min:0,max:1,step:.01,d:.35},
          {n:'y',t:'range',min:0,max:1,step:.01,d:.35},
          {n:'w',t:'range',min:.02,max:1,step:.01,d:.3},
          {n:'h',t:'range',min:.02,max:1,step:.01,d:.3},
          {n:'auto',t:'check',d:true},
          {n:'invert',t:'check',d:false}],
  init:n=>{n.mn=0;n.mx=1;n.v=0;n.raw=0;n.hist=[];},
  process(n,I){
    for(const k of ['x','y','w','h']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    for(const k of ['auto','invert']) if(typeof I[k]==='number') setMod(n,k,I[k]>=0.5);
    if(!I.img) return {out:n.v,raw:n.raw};
    const {w,h}=I.img, px=I.img.gray?null:I.img.data.data, gb=I.img.buf;
    const x0=Math.round(n.p.x*w), y0=Math.round(n.p.y*h);
    const x1=Math.min(w,x0+Math.round(n.p.w*w)), y1=Math.min(h,y0+Math.round(n.p.h*h));
    let s=0,c=0;
    for(let y=y0;y<y1;y+=2) for(let x=x0;x<x1;x+=2){
      s += px ? (px[(y*w+x)*4]*.299+px[(y*w+x)*4+1]*.587+px[(y*w+x)*4+2]*.114)/255 : gb[y*w+x];
      c++; }
    let v=c? s/c : 0; if(n.p.invert) v=1-v;
    n.raw=v;
    if(n.p.auto){                                  // скользящие min/max для контраста
      n.mx = v>n.mx ? v : n.mx*.999+v*.001;
      n.mn = v<n.mn ? v : n.mn*.999+v*.001;
      const d=Math.max(.02,n.mx-n.mn); v=clamp((v-n.mn)/d,0,1); }
    n.v=v; n.hist.push(v); if(n.hist.length>200) n.hist.shift();
    return {out:v,raw:n.raw}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height; cx.clearRect(0,0,W,H);
    cx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--t-num');
    cx.beginPath();
    const hs=n.hist,L=hs.length;
    for(let i=0;i<L;i++){ const x=i/200*W, y=H-hs[i]*H;
      i?cx.lineTo(x,y):cx.moveTo(x,y); }
    cx.stroke();
    cx.fillStyle=themeColor('--axis'); cx.font='9px monospace';
    cx.fillText(n.v.toFixed(3)+(n.p.auto?' auto':''),3,10); }});


def({ id:'capture', title:'Capture & Loop', cat:'Processing',
  ins:[{n:'in',t:'sig'},{n:'trig',t:'num'},{n:'sec',t:'num'},{n:'thr',t:'num'},{n:'rate',t:'num'},{n:'loop',t:'num'}],
  outs:[{n:'out',t:'sig'},{n:'pos',t:'num'},{n:'playing',t:'num'}],
  view:{h:90}, resize:true, readout:true,
  params:[{n:'sec',t:'range',min:.2,max:30,step:.1,d:5,label:'length, s'},
          {n:'mode',t:'select',opts:['manual','on trigger','on level'],d:'manual'},
          {n:'thr',t:'range',min:.001,max:1,step:.001,d:.05,log:true,label:'threshold'},
          {n:'rate',t:'range',min:.1,max:4,step:.01,d:1,label:'speed'},
          {n:'loop',t:'check',d:true},
          {n:'idle',t:'select',opts:['input','silence'],d:'input',label:'when idle'},
          {n:'grab',t:'button',label:'Freeze last N s',fn:n=>capGrab(n)},
          {n:'play',t:'button',label:'Play / stop',fn:n=>{ n.play=!n.play; n.pos=0; }},
          {n:'wav',t:'button',label:'Save WAV',fn:n=>{
            if(n.snap) wavDownload([n.snap],Eng.sr); }}],
  init:n=>{n.ring=null;n.w=0;n.snap=null;n.play=false;n.pos=0;n.prevT=0;n.armed=true;},
  process(n,I){
    for(const k of ['sec','thr','rate']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    if(typeof I.loop==='number') setMod(n,'loop',I.loop>=0.5);
    const o=buf(n,'out');
    const need=Math.max(BLOCK,Math.round(n.p.sec*Eng.sr));
    if(!n.ring||n.ring.length!==need){ n.ring=new Float32Array(need); n.w=0; }
    for(let i=0;i<BLOCK;i++){ n.ring[n.w]=I.in?I.in[i]:0; n.w=(n.w+1)%need; }
    if(n.p.mode==='on trigger'){                    // edge on the trigger input
      const t=I.trig||0;
      if(t>.5&&n.prevT<=.5&&n.armed){ capGrab(n); n.armed=false; }
      if(t<=.5) n.armed=true;
      n.prevT=t;
    } else if(n.p.mode==='on level'){
      if(n.armed && I.in && rms(I.in)>n.p.thr){ n.armed=false; n.wait=need; }
      if(!n.armed && n.wait!=null){ n.wait-=BLOCK;   // дописываем окно после срабатывания
        if(n.wait<=0){ capGrab(n); n.wait=null; n.armed=true; } }
    }
    if(n.play&&n.snap){
      const S=n.snap, L=S.length, r=n.p.rate;
      for(let i=0;i<BLOCK;i++){
        if(n.pos>=L-1){ if(n.p.loop) n.pos=0; else { n.play=false; o[i]=0; continue; } }
        const i0=n.pos|0, fr=n.pos-i0;
        o[i]=S[i0]*(1-fr)+S[i0+1]*fr; n.pos+=r; }
    } else if(n.p.idle==='input'&&I.in) o.set(I.in);
    else o.fill(0);
    return {out:o, pos:n.snap? n.pos/n.snap.length : 0, playing:n.play?1:0}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height; cx.clearRect(0,0,W,H);
    const S=n.snap;
    cx.strokeStyle=themeColor('--grid'); cx.beginPath(); cx.moveTo(0,H/2); cx.lineTo(W,H/2); cx.stroke();
    if(S){                                           // огибающая снимка
      const step=Math.max(1,Math.floor(S.length/W));
      cx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--t-sig');
      cx.beginPath();
      for(let x=0;x<W;x++){
        let mx=0; const a=x*step;
        for(let k=0;k<step;k++){ const v=Math.abs(S[a+k]||0); if(v>mx) mx=v; }
        cx.moveTo(x+.5,H/2-mx*H/2*.95); cx.lineTo(x+.5,H/2+mx*H/2*.95); }
      cx.stroke();
      if(n.play){ const x=Math.round(n.pos/S.length*W);
        cx.strokeStyle=themeColor('--acc'); cx.lineWidth=2;
        cx.beginPath(); cx.moveTo(x,0); cx.lineTo(x,H); cx.stroke(); cx.lineWidth=1; } }
    n.el.querySelector('.readout').textContent = S
      ? (S.length/Eng.sr).toFixed(2)+' s · '+(n.play?'playing':'stopped')
      : (n.p.mode==='manual'?'no snapshot':'waiting for trigger'); }});


function capGrab(n){                                 // снимок последних N секунд из кольца
  if(!n.ring) return;
  const L=n.ring.length, s=new Float32Array(L);
  for(let i=0;i<L;i++) s[i]=n.ring[(n.w+i)%L];
  n.snap=s; n.pos=0; n.play=true;
}

const BUILDER_DEMO=`{
  // Full module definition — same shape as def({...}) in the engine files.
  // Port types: 'sig' (audio buffer), 'num' (number), 'spec' (spectrum), etc.
  ins:  [{n:'I', t:'sig'}],
  outs: [{n:'O', t:'sig'}],
  params: [{n:'gain', t:'range', min:0, max:4, step:.01, d:1}],
  init: n => {},
  process: (n, I) => {
    const O = buf(n,'O');                 // buf(n,name) — a persistent buffer for the output
    const src = I.I;
    for (let i = 0; i < O.length; i++) O[i] = (src ? src[i] : 0) * n.p.gain;
    return { O };
  }
}`;
const BUILDER_DEMO_SCOPE=`{
  // Example with graphics: its own canvas (view + draw), plots the input waveform
  ins:  [{n:'I', t:'sig'}],
  outs: [{n:'O', t:'sig'}],
  params: [{n:'gain', t:'range', min:.1, max:4, step:.01, d:1}],
  view: { h:100 },
  init: n => {},
  process: (n, I) => {
    const O = buf(n,'O');
    const src = I.I;
    for (let i = 0; i < O.length; i++) O[i] = (src ? src[i] : 0) * n.p.gain;
    n.last = O;                            // save the last block — draw() renders once per frame, not per sample block
    return { O };
  },
  draw: n => {                             // n.cv — the node's canvas, already sized (view.h / resize)
    const cx = n.cv.getContext('2d'), W = n.cv.width, H = n.cv.height;
    cx.clearRect(0, 0, W, H);
    const b = n.last; if (!b) return;
    cx.strokeStyle = themeColor('--acc'); cx.lineWidth = 1.5; cx.beginPath();
    for (let x = 0; x < W; x++) {
      const v = b[Math.floor(x / W * b.length)] || 0, y = H/2 - v*H*0.45;
      x ? cx.lineTo(x, y) : cx.moveTo(x, y);
    }
    cx.stroke();
  }
}`;
const BUILDER_DEMOS={ 'amplifier':BUILDER_DEMO, 'oscilloscope (view+draw)':BUILDER_DEMO_SCOPE };
def({ id:'builder', title:'Module Builder', cat:'Builder',
  readout:true, resize:true, w:340, h:280,
  params:[{n:'demo',t:'select',opts:Object.keys(BUILDER_DEMOS),d:'amplifier',label:'example',fn:n=>{
            n.set.code(BUILDER_DEMOS[n.p.demo]); }},
          {n:'code',t:'code',d:BUILDER_DEMO},
          {n:'apply',t:'button',label:'Apply / update test nodes',fn:async n=>{
            n.err=''; n.status='compiling…';
            let obj;
            try{                                        // no eval/new Function — CSP blocks them without unsafe-eval;
              // blob: is allowed as a script source, dynamic import() isn't eval, goes through script-src
              const blob=new Blob(['export default '+n.p.code+';'],{type:'text/javascript'});
              const url=URL.createObjectURL(blob);
              try{ obj=(await import(url)).default; } finally{ URL.revokeObjectURL(url); }
            }catch(e){ n.err='compile error: '+e.message; return; }
            if(!obj||typeof obj!=='object'){ n.err='code must return a module object'; return; }
            const key='custom:'+n.id;                 // type is tied to the builder node's id
            MOD[key]={ title:obj.title||('Custom '+n.id), cat:obj.cat||'Builder',
              ins:obj.ins||[], outs:obj.outs||[], params:obj.params||[],
              view:obj.view, pick:obj.pick, resize:obj.resize, readout:obj.readout,
              tall:obj.tall, swatch:obj.swatch, w:obj.w, h:obj.h,
              init:obj.init||(()=>{}), process:obj.process||(()=>({})), draw:obj.draw };
            const existing=Graph.nodes.filter(x=>x.type===key);
            if(existing.length){
              const insN=new Set((MOD[key].ins||[]).map(p=>p.n)),
                    outsN=new Set((MOD[key].outs||[]).map(p=>p.n));
              existing.forEach(x=>{                              // dropped ports — cut their wires, don't crash
                Graph.edges.filter(e=>(e.to===x.id&&!insN.has(e.tp))||(e.from===x.id&&!outsN.has(e.fp)))
                  .forEach(delEdge); });
              existing.forEach(rebuildNode);
              n.status='updated, nodes: '+existing.length; }
            else{ const t=addNode(key,n.x+240,n.y);                   // first time — create one nearby
              n.status=t?'test node created':'failed to create node'; }
          }}],
  init:n=>{n.err='';n.status='';},
  process(n,I){ return {}; },
  draw(n){ const el=n.el.querySelector('.readout');
    el.textContent = n.err? '⚠ '+n.err : (n.status||'ready'); }});

const SCRIPT_DEMO=`// in: I1, I2 (arrays), a, b (numbers), sr, N, p1..p4, s (state)
// out: O1, O2 (arrays), return a number → n1
s.ph = s.ph || 0;
for (let i = 0; i < N; i++) {
  O1[i] = I1[i] * p1 + Math.sin(2 * Math.PI * s.ph) * p2;
  s.ph = (s.ph + p3 / sr) % 1;
}
return s.ph;`;

def({ id:'script', title:'Script', cat:'Builder',
  ins:[{n:'I1',t:'sig'},{n:'I2',t:'sig'},{n:'a',t:'num'},{n:'b',t:'num'},
       {n:'p1',t:'num'},{n:'p2',t:'num'},{n:'p3',t:'num'},{n:'p4',t:'num'}],
  outs:[{n:'O1',t:'sig'},{n:'O2',t:'sig'},{n:'n1',t:'num'}],
  readout:true,
  params:[{n:'p1',t:'range',min:-10,max:10,step:.001,d:1},
          {n:'p2',t:'range',min:-10,max:10,step:.001,d:0},
          {n:'p3',t:'range',min:0,max:20000,step:.01,d:440,log:true},
          {n:'p4',t:'range',min:-10,max:10,step:.001,d:0},
          {n:'code',t:'code',d:SCRIPT_DEMO,fn:n=>{n.dirty=true;}}],
  init:n=>{n.fn=null;n.dirty=true;n.err='';n.st={};n.n1=0;},
  process(n,I){
    for(const k of ['p1','p2','p3','p4']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const O1=buf(n,'O1'), O2=buf(n,'O2');
    if(n.dirty){                                     // перекомпиляция после правки кода
      n.dirty=false; n.err='';
      try{
        n.fn=new Function('I1','I2','O1','O2','a','b','sr','N','p1','p2','p3','p4','s',
                          '"use strict";'+n.p.code);
        n.st={};
      }catch(e){ n.fn=null; n.err=String(e.message); }
    }
    if(!n.fn){ O1.fill(0); O2.fill(0); return {O1,O2,n1:0}; }
    const z=n.zero||(n.zero=new Float32Array(BLOCK));
    try{
      const r=n.fn(I.I1||z, I.I2||z, O1, O2, I.a||0, I.b||0, Eng.sr, BLOCK,
                   n.p.p1, n.p.p2, n.p.p3, n.p.p4, n.st);
      n.n1=(typeof r==='number'&&isFinite(r))?r:0;
      n.err='';
    }catch(e){ n.err=String(e.message); n.fn=null; O1.fill(0); O2.fill(0); }
    return {O1,O2,n1:n.n1}; },
  draw(n){ n.el.querySelector('.readout').textContent =
    n.err? '⚠ '+n.err : 'n1 = '+n.n1.toFixed(4); }});


def({ id:'cal', title:'Calibration', cat:'Processing',
  ins:[{n:'in',t:'num'}], outs:[{n:'out',t:'num'}], readout:true,
  params:[{n:'mode',t:'select',opts:['dB offset','linear scale'],d:'dB offset'},
          {n:'ofs',t:'num',d:0,label:'offset'},
          {n:'ref',t:'num',d:94,label:'reference value'},
          {n:'unit',t:'text',d:'dB SPL',label:'units'},
          {n:'take',t:'button',label:'Take current as reference',fn:n=>{
            if(typeof n.raw==='number'&&isFinite(n.raw)){
              const v=n.p.mode==='dB offset'? n.p.ref-n.raw : n.p.ref/(n.raw||1e-9);
              if(n.set&&n.set.ofs) n.set.ofs(v); else n.p.ofs=v; } }}],
  init:n=>{n.raw=0;n.v=0;},
  process(n,I){
    n.raw=(typeof I.in==='number'&&isFinite(I.in))?I.in:0;
    n.v = n.p.mode==='dB offset'? n.raw+n.p.ofs : n.raw*n.p.ofs;
    return {out:n.v}; },
  draw(n){ n.el.querySelector('.readout').textContent =
    n.v.toFixed(2)+' '+n.p.unit+'  (input '+n.raw.toFixed(2)+')'; }});


def({ id:'nlms', title:'Adaptive Filter', cat:'Processing',
  ins:[{n:'d',t:'sig'},{n:'x',t:'sig'},{n:'mu',t:'num'},{n:'leak',t:'num'},{n:'freeze',t:'num'}],
  outs:[{n:'out',t:'sig'},{n:'y',t:'sig'},{n:'err',t:'num'}],
  view:{h:40}, readout:true,
  params:[{n:'taps',t:'select',opts:['16','32','64','128','256','512'],d:'128'},
          {n:'mu',t:'range',min:.001,max:1,step:.001,d:.2,log:true,label:'speed'},
          {n:'leak',t:'range',min:0,max:.01,step:.0001,d:0,label:'leakage'},
          {n:'freeze',t:'check',d:false,label:'freeze'},
          {n:'rst',t:'button',label:'Reset weights',fn:n=>{n.w&&n.w.fill(0);}}],
  init:n=>{n.N=0;n.hist=[];n.e=0;},
  process(n,I){
    if(typeof I.mu==='number') setMod(n,'mu',I.mu);
    if(typeof I.leak==='number') setMod(n,'leak',I.leak);
    if(typeof I.freeze==='number') setMod(n,'freeze',I.freeze>=0.5);
    const N=+n.p.taps;
    if(n.N!==N){ n.N=N; n.w=new Float32Array(N); n.z=new Float32Array(N); n.zi=0; n.pw=1e-2; }
    const o=buf(n,'out'), oy=buf(n,'y'), W=n.w, Z=n.z;
    const mu=n.p.mu, lk=n.p.leak;
    let acc=0;
    for(let i=0;i<BLOCK;i++){
      const xv=I.x?I.x[i]:0, dv=I.d?I.d[i]:0;
      Z[n.zi]=xv; n.pw=n.pw*0.999+xv*xv*0.001;
      let y=0, k=n.zi;
      for(let t=0;t<N;t++){ y+=W[t]*Z[k]; k=k? k-1 : N-1; }
      const e=dv-y;
      if(!n.p.freeze){                               // нормированный МНК
        const g=mu/(N*Math.max(n.pw,1e-4)+1e-9);   // пол по мощности не даёт разойтись на старте
        k=n.zi;
        for(let t=0;t<N;t++){ W[t]=W[t]*(1-lk)+g*e*Z[k]; k=k? k-1 : N-1; } }
      o[i]=e; oy[i]=y; acc+=e*e;
      n.zi=(n.zi+1)%N; }
    n.e=Math.sqrt(acc/BLOCK);
    n.hist.push(n.e); if(n.hist.length>120) n.hist.shift();
    return {out:o, y:oy, err:n.e}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height; cx.clearRect(0,0,W,H);
    let mx=1e-6; for(const v of n.hist) if(v>mx) mx=v;
    cx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--t-sig');
    cx.beginPath();
    for(let i=0;i<n.hist.length;i++){ const x=i/120*W, y=H-n.hist[i]/mx*H;
      i?cx.lineTo(x,y):cx.moveTo(x,y); }
    cx.stroke();
    n.el.querySelector('.readout').textContent='residual '+
      (20*Math.log10(n.e+1e-12)).toFixed(1)+' dBFS'; }});


def({ id:'beam', title:'Beamformer', cat:'Radio',
  ins:[{n:'A',t:'sig'},{n:'B',t:'sig'},{n:'dist',t:'num'},{n:'ang',t:'num'},
       {n:'manual',t:'num'},{n:'useManual',t:'num'}],
  outs:[{n:'sum',t:'sig'},{n:'diff',t:'sig'},{n:'delayMs',t:'num'}],
  readout:true,
  params:[{n:'dist',t:'range',min:1,max:100,step:.5,d:15,label:'baseline, cm'},
          {n:'ang',t:'range',min:-90,max:90,step:1,d:0,label:'angle, °'},
          {n:'c',t:'num',d:343,label:'speed of sound, m/s'},
          {n:'manual',t:'range',min:-5,max:5,step:.001,d:0,label:'manual delay, ms'},
          {n:'useManual',t:'check',d:false}],
  init:n=>{n.line=new Float32Array(4096);n.w=0;n.d=0;},
  process(n,I){
    for(const k of ['dist','ang','manual']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    if(typeof I.useManual==='number') setMod(n,'useManual',I.useManual>=0.5);
    const os=buf(n,'sum'), od=buf(n,'diff'), L=n.line.length;
    const dSec = n.p.useManual? n.p.manual/1000
               : n.p.dist/100*Math.sin(n.p.ang*Math.PI/180)/n.p.c;
    const dSamp=clamp(dSec*Eng.sr,-(L/2-2),L/2-2);
    for(let i=0;i<BLOCK;i++){
      const a=I.A?I.A[i]:0, b=I.B?I.B[i]:0;
      n.line[n.w]=b;
      const pos=n.w-dSamp;                           // дробная задержка второго канала
      const p0=Math.floor(pos), fr=pos-p0;
      const v=n.line[((p0%L)+L)%L]*(1-fr)+n.line[(((p0+1)%L)+L)%L]*fr;
      os[i]=(a+v)*.5; od[i]=(a-v)*.5;
      n.w=(n.w+1)%L; }
    n.d=dSec*1000;
    return {sum:os, diff:od, delayMs:n.d}; },
  draw(n){ n.el.querySelector('.readout').textContent =
    'delay '+n.d.toFixed(3)+' ms'; }});


def({ id:'agc', title:'AGC', cat:'Radio',
  ins:[{n:'in',t:'sig'},{n:'target',t:'num'},{n:'atk',t:'num'},{n:'rel',t:'num'},{n:'max',t:'num'}],
  outs:[{n:'out',t:'sig'},{n:'gain',t:'num'}], readout:true,
  params:[{n:'target',t:'range',min:.01,max:1,step:.01,d:.3,label:'target'},
          {n:'atk',t:'range',min:1,max:500,step:1,d:20,label:'attack, ms'},
          {n:'rel',t:'range',min:10,max:5000,step:10,d:500,label:'release, ms'},
          {n:'max',t:'range',min:1,max:1000,step:1,d:100,log:true,label:'max gain'}],
  init:n=>{n.g=1;n.env=0;},
  process(n,I){
    for(const k of ['target','atk','rel','max']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const o=buf(n,'out');
    const ca=Math.exp(-1/(Eng.sr*n.p.atk/1000)), cr=Math.exp(-1/(Eng.sr*n.p.rel/1000));
    for(let i=0;i<BLOCK;i++){
      const x=I.in?I.in[i]:0, a=Math.abs(x);
      n.env = a>n.env ? ca*n.env+(1-ca)*a : cr*n.env+(1-cr)*a;
      const want=clamp(n.p.target/(n.env+1e-6),1/n.p.max,n.p.max);
      n.g = want<n.g ? ca*n.g+(1-ca)*want : cr*n.g+(1-cr)*want;
      o[i]=clamp(x*n.g,-1,1); }
    return {out:o, gain:n.g}; },
  draw(n){ n.el.querySelector('.readout').textContent =
    'gain '+(20*Math.log10(n.g+1e-9)).toFixed(1)+' dB'; }});


// Сквелч — гейт аудио по уровню, с гистерезисом/удержанием и плавным откр./закр. (без щелчков).
// Уровень можно взять извне (например, snr у 'chsnr' или db у 'meter' — для радио разумнее
// гейтить по качеству RF-сигнала, а не по громкости демодулированного шума), либо, если 'level'
// не подключён, узел сам считает огибающую входного аудио (как у 'agc') — для обычного VOX-сценария.
def({ id:'squelch', title:'Squelch', cat:'Radio',
  ins:[{n:'in',t:'sig'},{n:'level',t:'num'},{n:'thr',t:'num'},{n:'hys',t:'num'},{n:'hold',t:'num'}],
  outs:[{n:'out',t:'sig'},{n:'gate',t:'num'},{n:'db',t:'num'}],
  readout:true,
  params:[{n:'thr',t:'range',min:-100,max:0,step:.5,d:-40,label:'threshold, dB'},
          {n:'hys',t:'range',min:0,max:20,step:.5,d:3,label:'hysteresis, dB'},
          {n:'hold',t:'range',min:0,max:3000,step:10,d:300,label:'hold, ms'},
          {n:'atk',t:'range',min:1,max:200,step:1,d:10,label:'envelope attack, ms'},
          {n:'rel',t:'range',min:10,max:2000,step:10,d:150,label:'envelope release, ms'},
          {n:'fade',t:'range',min:0,max:100,step:1,d:8,label:'open/close smoothing, ms'}],
  init:n=>{n.env=0;n.open=false;n.hCount=0;n.g=0;n.db=-120;},
  process(n,I){
    for(const k of ['thr','hys','hold']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const o=buf(n,'out');
    const hasLevel=typeof I.level==='number', extDb=I.level;
    const ca=Math.exp(-1/(Eng.sr*n.p.atk/1000)), cr=Math.exp(-1/(Eng.sr*n.p.rel/1000));
    const kFade=Math.exp(-1/(Eng.sr*Math.max(1,n.p.fade)/1000));
    const holdSamples=n.p.hold*Eng.sr/1000;
    for(let i=0;i<BLOCK;i++){
      const x=I.in?I.in[i]:0;
      let db;
      if(hasLevel){ db=extDb; }
      else{
        const a=Math.abs(x);
        n.env = a>n.env ? ca*n.env+(1-ca)*a : cr*n.env+(1-cr)*a;
        db=20*Math.log10(n.env+1e-9);
      }
      n.open = n.open ? db>n.p.thr-n.p.hys : db>n.p.thr+n.p.hys;
      n.hCount = n.open ? holdSamples : Math.max(0,n.hCount-1);
      const want=(n.open||n.hCount>0)?1:0;
      n.g = n.g*kFade+want*(1-kFade);           // плавно ведём коэффициент — резкий гейт слышен щелчком
      o[i]=x*n.g;
      n.db=db;
    }
    const gate=(n.open||n.hCount>0)?1:0;
    return {out:o, gate, db:n.db}; },
  draw(n){ n.el.querySelector('.readout').textContent =
    (n.db>-119?n.db.toFixed(1):'—')+' dB · '+((n.open||n.hCount>0)?'open':'closed'); }});


def({ id:'notch', title:'Mains Notch', cat:'Processing', ins:[{n:'in',t:'sig'},{n:'f0',t:'num'},{n:'n',t:'num'},{n:'Q',t:'num'}],
  outs:[{n:'out',t:'sig'}],
  params:[{n:'f0',t:'range',min:10,max:400,step:.1,d:50},
          {n:'n',t:'range',min:1,max:12,step:1,d:5,label:'harmonics'},
          {n:'Q',t:'range',min:5,max:200,step:1,d:40}],
  init:n=>{n.key='';},
  process(n,I){
    if(typeof I.n==='number') setMod(n,'n',I.n);
    if(typeof I.Q==='number') setMod(n,'Q',I.Q);
    const o=buf(n,'out'), f0=pv(n,I,'f0'), N=n.p.n;
    const key=f0+'/'+N+'/'+n.p.Q+'/'+Eng.sr;
    if(n.key!==key){ n.key=key; n.c=[]; n.z=[];
      for(let k=1;k<=N;k++){ const f=f0*k;
        if(f>=Eng.sr/2-50) break;
        n.c.push(biquadCoef('notch',f,n.p.Q,Eng.sr)); n.z.push([0,0,0,0]); } }
    for(let i=0;i<BLOCK;i++){
      let x=I.in?I.in[i]:0;
      for(let s=0;s<n.c.length;s++){                 // каскад режекторов на гармониках
        const [b0,b1,b2,a1,a2]=n.c[s], z=n.z[s];
        const y=b0*x+b1*z[0]+b2*z[1]-a1*z[2]-a2*z[3];
        z[1]=z[0]; z[0]=x; z[3]=z[2]; z[2]=y; x=y; }
      o[i]=x; }
    return {out:o}; }});

// Частоты наводок: сеть 50/60 Гц, ж/д 16.7 Гц, бортсеть 400 Гц; custom — поле f0
const HUM_PRESETS=['50','60','16.7','25','400','custom'];
const humPreset=n=>{ if(n.p.preset!=='custom') setMod(n,'f0',+n.p.preset); };

// Адаптивное вычитание гармоник: опорные cos/sin k·φ от своего генератора, веса по МНК —
// вычитается только сама наводка (амплитуда/фаза каждой гармоники), сигнал между гармониками
// не трогается. Частота генератора подстраивается по вращению фазора основной гармоники (FLL),
// поэтому режекция остаётся глубокой при уходе сети на ±0.1…0.5 Гц.
def({ id:'humcancel', title:'Hum Canceller (adaptive)', cat:'Processing',
  ins:[{n:'in',t:'sig'},{n:'f0',t:'num'},{n:'n',t:'num'},{n:'bw',t:'num'}],
  outs:[{n:'out',t:'sig'},{n:'hum',t:'sig'},{n:'freq',t:'num'},{n:'level',t:'num'}],
  readout:true,
  params:[{n:'preset',t:'select',opts:HUM_PRESETS,d:'50',label:'interference',fn:humPreset},
          {n:'f0',t:'range',min:5,max:1000,step:.01,d:50,log:true,label:'fundamental, Hz'},
          {n:'n',t:'range',min:1,max:60,step:1,d:20,label:'harmonics'},
          {n:'bw',t:'range',min:.05,max:20,step:.05,d:1,log:true,label:'notch width, Hz (speed)'},
          {n:'track',t:'check',d:true,label:'track frequency'},
          {n:'range',t:'range',min:.1,max:5,step:.1,d:1,label:'tracking range, ±Hz',adv:true},
          {n:'rst',t:'button',label:'Reset',fn:n=>{ n.a=null; }}],
  init:n=>{ n.a=null; n.ph=0; n.f=null; n.fKey=null; n.th=null; n.lvl=-200; n.red=0; },
  process(n,I){
    if(typeof I.n==='number') setMod(n,'n',Math.round(I.n));
    if(typeof I.bw==='number') setMod(n,'bw',I.bw);
    const sr=Eng.sr, f0=pv(n,I,'f0');
    if(n.fKey!==f0){ n.fKey=f0; n.f=f0; n.th=null; }   // новая номинальная частота — трекинг с нуля
    // по номиналу с запасом на трекинг: иначе дрейф частоты у Найквиста менял бы K и сбрасывал веса
    const K=Math.max(1,Math.min(Math.round(n.p.n), Math.floor(sr*.475/Math.max(f0+n.p.range,1))));
    if(!n.a || n.a.length!==2*K){ n.a=new Float64Array(2*K); n.th=null; }
    const a=n.a, o=buf(n,'out'), h=buf(n,'hum');
    // шаг МНК из ширины режекции: для пары весов с опорой единичной амплитуды полоса ≈ g·fs/(2π)
    const g=2*Math.PI*n.p.bw/sr;
    const w=2*Math.PI*n.f/sr;
    let ph=n.ph, pin=0, pout=0;
    for(let i=0;i<BLOCK;i++){
      const x=I.in?I.in[i]:0;
      const cb=Math.cos(ph), sb=Math.sin(ph);
      let c=cb, s=sb, y=0;
      for(let k=0;k<K;k++){                          // cos/sin k·φ поворотом, без тригонометрии на гармонику
        y+=a[2*k]*c+a[2*k+1]*s;
        const cn=c*cb-s*sb; s=s*cb+c*sb; c=cn; }
      const e=x-y;
      c=cb; s=sb;
      for(let k=0;k<K;k++){
        a[2*k]+=g*e*c; a[2*k+1]+=g*e*s;
        const cn=c*cb-s*sb; s=s*cb+c*sb; c=cn; }
      o[i]=e; h[i]=y; pin+=x*x; pout+=e*e;
      ph+=w; if(ph>Math.PI) ph-=2*Math.PI; }
    n.ph=ph;
    // FLL: фазор основной гармоники (a0,a1) вращается со скоростью ошибки частоты
    const A=Math.hypot(a[0],a[1]);
    if(n.p.track && A>1e-5){
      const th=Math.atan2(a[1],a[0]);
      if(n.th!=null){
        let d=th-n.th; d-=2*Math.PI*Math.round(d/(2*Math.PI));
        // A·cos(φ+δ) = a·cosφ + b·sinφ при θ=atan2(b,a)=−δ: частота сети выше — θ убывает
        const df=-d*sr/(2*Math.PI*BLOCK);
        n.f=clamp(n.f+.05*df, f0-n.p.range, f0+n.p.range);
      }
      n.th=th;
    } else { n.th=null; if(!n.p.track) n.f=f0; }
    let hp=0; for(let k=0;k<K;k++) hp+=(a[2*k]*a[2*k]+a[2*k+1]*a[2*k+1])/2;
    n.lvl=10*Math.log10(hp+1e-20);
    const r=10*Math.log10((pin+1e-20)/(pout+1e-20));
    n.red=n.red*.9+r*.1; n.K=K;
    return {out:o, hum:h, freq:n.f, level:n.lvl}; },
  draw(n){
    const r=n.el?.querySelector('.readout'); if(!r) return;
    r.textContent = n.K ? `${n.f.toFixed(3)} Hz · ${n.K} harm · hum ${n.lvl.toFixed(1)} dBFS · reduction ${Math.max(0,n.red).toFixed(1)} dB`
      : 'no signal'; }});

// Гребенчатый режектор: H(z)=(1+ρ)/2·(1−z^−D)/(1−ρ·z^−D), D=fs/f0 (дробная — линейная
// интерполяция). Режет все кратные f0 до Найквиста сразу и почти ничего не стоит, но режет
// и DC, и не подстраивается сам — f0 можно завести с выхода freq у Hum Canceller.
def({ id:'combnotch', title:'Comb Notch (all harmonics)', cat:'Processing',
  ins:[{n:'in',t:'sig'},{n:'f0',t:'num'},{n:'bw',t:'num'}],
  outs:[{n:'out',t:'sig'}],
  params:[{n:'preset',t:'select',opts:HUM_PRESETS,d:'50',label:'interference',fn:humPreset},
          {n:'f0',t:'range',min:5,max:1000,step:.01,d:50,log:true,label:'fundamental, Hz'},
          {n:'bw',t:'range',min:.1,max:20,step:.1,d:2,log:true,label:'notch width, Hz'}],
  init:n=>{ n.N=0; },
  process(n,I){
    if(typeof I.bw==='number') setMod(n,'bw',I.bw);
    const sr=Eng.sr, f0=Math.max(1,pv(n,I,'f0'));
    const D=clamp(sr/f0, 2, sr);
    const N=pow2ge(Math.ceil(sr)+4);
    if(n.N!==N){ n.N=N; n.xb=new Float32Array(N); n.yb=new Float32Array(N); n.wi=0; }
    const r=Math.max(0,1-Math.PI*n.p.bw/sr), rho=Math.pow(r,D), gk=(1+rho)/2;
    const xb=n.xb, yb=n.yb, m=N-1, Di=Math.floor(D), fr=D-Di, o=buf(n,'out');
    let wi=n.wi;
    for(let i=0;i<BLOCK;i++){
      const x=I.in?I.in[i]:0;
      const j0=(wi-Di)&m, j1=(wi-Di-1)&m;
      const xd=xb[j0]+(xb[j1]-xb[j0])*fr, yd=yb[j0]+(yb[j1]-yb[j0])*fr;
      const y=gk*(x-xd)+rho*yd;
      xb[wi]=x; yb[wi]=y; o[i]=y; wi=(wi+1)&m; }
    n.wi=wi;
    return {out:o}; }});


function irMeasure(n){
  const N=n.N; if(!N) return;
  const re1=new Float32Array(N), im1=new Float32Array(N);
  const re2=new Float32Array(N), im2=new Float32Array(N);
  for(let i=0;i<N;i++){ re1[i]=n.rx[(n.w+i)%N]; re2[i]=n.ry[(n.w+i)%N]; }
  fft(re1,im1); fft(re2,im2);
  for(let k=0;k<N;k++){                              // деление спектров с регуляризацией
    const xr=re1[k], xi=im1[k], yr=re2[k], yi=im2[k];
    const d=xr*xr+xi*xi+1e-9;
    re1[k]=(yr*xr+yi*xi)/d; im1[k]=(yi*xr-yr*xi)/d; }
  for(let k=0;k<N;k++) im1[k]=-im1[k];               // обратное преобразование
  fft(re1,im1);
  const h=new Float32Array(N);
  let pk=0, pi=0;
  for(let i=0;i<N;i++){ h[i]=re1[i]/N; const a=Math.abs(h[i]); if(a>pk){ pk=a; pi=i; } }
  n.dl=pi/Eng.sr*1000;
  const L=Math.min(N-pi,Math.round(Eng.sr*2));
  const sch=new Float32Array(L);                     // обратное интегрирование Шрёдера
  let acc=0;
  for(let i=L-1;i>=0;i--){ const v=h[pi+i]; acc+=v*v; sch[i]=acc; }
  const ref=sch[0]+1e-30;
  for(let i=0;i<L;i++) sch[i]=10*Math.log10(sch[i]/ref+1e-30);
  n.sch=sch;
  const at=db=>{ for(let i=0;i<L;i++) if(sch[i]<=db) return i; return -1; };
  const i1=at(-5), i2=at(n.p.range==='T20'?-25:-35);
  if(i1<0||i2<0||i2<=i1){ n.text='not enough decay to estimate'; n.rt=0; return; }
  const mult=n.p.range==='T20'?3:2;
  n.rt=(i2-i1)/Eng.sr*mult;
  n.text='RT60 ≈ '+n.rt.toFixed(3)+' s ('+n.p.range+') · delay '+n.dl.toFixed(1)+' ms';
}

def({ id:'numsig', title:'Number → Signal', cat:'Processing',
  ins:[{n:'in',t:'num'},{n:'gain',t:'num'},{n:'dc',t:'num'},{n:'dcHz',t:'num'}], outs:[{n:'out',t:'sig'}],
  params:[{n:'gain',t:'range',min:.01,max:100,step:.01,d:1,log:true},
          {n:'ofs',t:'num',d:0,label:'offset'},
          {n:'mode',t:'select',opts:['linear','stepped'],d:'linear'},
          {n:'dc',t:'check',d:true,label:'remove DC'},
          {n:'dcHz',t:'range',min:.05,max:5,step:.01,d:.3,log:true}],
  init:n=>{n.prev=0;n.x1=0;n.y1=0;},
  process(n,I){
    if(typeof I.gain==='number') setMod(n,'gain',I.gain);
    if(typeof I.dc==='number') setMod(n,'dc',I.dc>=0.5);
    if(typeof I.dcHz==='number') setMod(n,'dcHz',I.dcHz);
    // блок = 10.7 мс реального времени, поэтому частоты сохраняются как есть
    const o=buf(n,'out'), v=((typeof I.in==='number'&&isFinite(I.in))?I.in:0)-n.p.ofs;
    const g=n.p.gain, lin=n.p.mode==='linear';
    const R=1-2*Math.PI*n.p.dcHz/Eng.sr;
    for(let i=0;i<BLOCK;i++){
      const t=(i+1)/BLOCK;
      let x=(lin? n.prev+(v-n.prev)*t : v)*g;
      if(n.p.dc){ const y=x-n.x1+R*n.y1; n.x1=x; n.y1=y; x=y; }
      o[i]=x; }
    n.prev=v;
    return {out:o}; }});


def({ id:'map', title:'Number Scale', cat:'Processing', ins:[{n:'in',t:'num'},{n:'smooth',t:'num'}],
  outs:[{n:'out',t:'num'}],
  params:[{n:'inMin',t:'num',d:0},{n:'inMax',t:'num',d:1},
          {n:'outMin',t:'num',d:0},{n:'outMax',t:'num',d:1000},
          {n:'smooth',t:'range',min:0,max:.99,step:.01,d:.5}],
  // sm — сглаженное значение. НЕ n.y: занято движком под позицию узла на холсте.
  init:n=>{n.sm=0;},
  process(n,I){ if(typeof I.smooth==='number') setMod(n,'smooth',I.smooth);
    const x=I.in||0, p=n.p;
    const t=clamp((x-p.inMin)/((p.inMax-p.inMin)||1),0,1);
    const v=p.outMin+(p.outMax-p.outMin)*t;
    n.sm=n.sm*p.smooth+v*(1-p.smooth); return {out:n.sm}; }});


function setMod(n,key,v){                            // применить внешнее значение к параметру: через n.set (с рендером),
  if(n.set?.[key]) n.set[key](v); else n.p[key]=v; }  // либо напрямую — если узел без DOM (группа)
// Как setMod, но для параметров, которые часто одновременно и подключены проводом, и правятся
// руками в панели узла (частота приёмника, модуляция, полоса и т.п.) — например, провод держит
// значение из выбранной закладки. Без этой проверки ручная правка тут же откатывается назад на
// следующем тике: провод ведь не в курсе, что значение поменяли не он сам. isValid — валиден ли
// wireVal СЕЙЧАС (нужного типа/из допустимого набора) — параметры пропускаются, только когда true.
//
// Логика: n['_prevP'+key] — снимок n.p[key] на конец ПРЕДЫДУЩЕГО вызова; если сейчас отличается —
// значит, между вызовами его поменяли не этим проводом (руками, другим узлом и т.п.). В этот момент
// держим ТЕКУЩЕЕ значение провода подавленным (n['_hold'+key]) — провод не отвоёвывает параметр
// назад, пока сам не укажет на ДРУГОЕ значение (например, выбрали другую закладку) — тогда подавление
// снимается и провод как обычно продолжает диктовать параметр. Не годится для полей, где провод
// ДОЛЖЕН всегда побеждать (непрерывный LFO/огибающая и т.п.) — там просто setMod без этой обвязки.
function setModWired(n,key,wireVal,isValid){
  const prevK='_prevP'+key, holdK='_hold'+key;
  const manualEdit = n[prevK]!=null && n.p[key]!==n[prevK];
  if(manualEdit) n[holdK] = isValid ? wireVal : undefined;
  const suppressed = n[holdK]!==undefined && wireVal===n[holdK];
  if(isValid && !suppressed && wireVal!==n.p[key]) setMod(n,key,wireVal);
  n[prevK]=n.p[key];
}
function saBands(n,cx,W,H){                        // закраска полосы приёма
  const b=n.p.band; if(!b||b==='none') return;
  let pair=null, col='#8ab4f8';
  if(b==='by inputs') pair=n.band;
  else if(b==='1–2'){ pair=[n.mk[0],n.mk[1]]; col=MK_COL(0); }
  else if(b==='3–4'){ pair=[n.mk[2],n.mk[3]]; col=MK_COL(2); }
  if(!pair||pair[0]==null||pair[1]==null) return;
  const x1=saPos(n,Math.min(pair[0],pair[1]))*W, x2=saPos(n,Math.max(pair[0],pair[1]))*W;
  cx.globalAlpha=.14; cx.fillStyle=col;
  cx.fillRect(x1,0,Math.max(1,x2-x1),H);
  cx.globalAlpha=.5; cx.strokeStyle=col; cx.lineWidth=1;
  cx.beginPath(); cx.moveTo(x1+.5,0); cx.lineTo(x1+.5,H);
  cx.moveTo(x2-.5,0); cx.lineTo(x2-.5,H); cx.stroke();
  cx.globalAlpha=1;
}

// Шторки каналов приёмника (spec.chans от rtlsdr): полоса канального фильтра ПЧ вокруг частоты
// каждого канала, цветом маркера с тем же номером. Подпись (режим и ширина) — отдельным проходом
// saChannelLabels, после маркеров, чтобы линия маркера её не перекрывала.
function saChannels(n,cx,W,H,plotH){
  const list=n.s&&n.s.chans; if(!list||!list.length) return;
  const yDb=db=>plotH-clamp((db-n.p.floor)/((n.p.top-n.p.floor)||1),0,1)*(plotH-2)-1;
  for(const c of list){
    const x1=saPos(n,c.lo)*W, x2=saPos(n,c.hi)*W;
    if(x2<0||x1>W) continue;
    const col=MK_COL(c.idx);
    cx.globalAlpha=.08; cx.fillStyle=col; cx.fillRect(x1,16,Math.max(1,x2-x1),H-16);
    cx.globalAlpha=.9; cx.strokeStyle=col; cx.lineWidth=1;
    const e1=Math.round(x1)+.5, e2=Math.round(x2)-.5;
    cx.beginPath(); cx.moveTo(e1,16); cx.lineTo(e1,H); cx.moveTo(e2,16); cx.lineTo(e2,H); cx.stroke();
    // шумоподавитель: пунктир — порог, сплошная — текущий средний уровень в полосе канала
    // (в той же шкале, что трасса); сплошная выше пунктира — открыт (с гистерезисом 3 дБ и hang)
    if(c.thrDb!=null && plotH){
      const yt=Math.round(yDb(c.thrDb))+.5;
      cx.globalAlpha=.9; cx.setLineDash([4,3]);
      cx.beginPath(); cx.moveTo(e1,yt); cx.lineTo(e2,yt); cx.stroke(); cx.setLineDash([]);
      if(c.lvDb!=null){
        const yl=Math.round(yDb(c.lvDb))+.5;
        cx.globalAlpha=c.sqOpen?1:.45; cx.lineWidth=2;
        cx.beginPath(); cx.moveTo(e1,yl); cx.lineTo(e2,yl); cx.stroke(); cx.lineWidth=1;
      }
    }
  }
  cx.globalAlpha=1;
}
// канал приёмника, на частоте которого стоит маркер (маркер ведёт tuneFreq канала)
function saChanAtMarker(n,f){
  const list=n.s&&n.s.chans; if(!list||!list.length||f==null) return null;
  const tol=Math.max(1, Math.abs(specHz(n.s,1)-specHz(n.s,0))/2);
  return list.find(c=>Math.abs(c.f-f)<=tol) || null;
}
// подпись на плашке цвета канала; не влезает в шторку — выносим вбок от неё
function saChannelLabels(n,cx,W){
  const list=n.s&&n.s.chans; if(!list||!list.length) return;
  cx.font=BP_FONT;
  for(const c of list){
    const x1=saPos(n,c.lo)*W, x2=saPos(n,c.hi)*W;
    if(x2<0||x1>W) continue;
    const col=MK_COL(c.idx), bw=c.hi-c.lo, t=c.mode+' '+fmtHz(bw, bw%1000?1:0)+(c.sql ? (c.sqOpen?' SQL open':' SQL closed') : '');
    const tw=Math.ceil(cx.measureText(t).width), ty=20+c.idx*15;
    let tx=(x1+x2-tw)/2;
    if(x2-x1<tw+8) tx = x2+4+tw<=W ? x2+4 : x1-tw-4;
    tx=clamp(Math.round(tx), 3, W-tw-3);
    cx.globalAlpha=1; cx.fillStyle=col; cx.fillRect(tx-3,ty,tw+6,14);
    cx.fillStyle=contrastText(col); cx.fillText(t,tx,ty+11);
  }
}
function saBandPlanLabels(n,cx){
  const list=n._bpLabels; if(!list||!list.length) return;
  cx.font=BP_FONT; cx.globalAlpha=1;
  for(const l of list){
    cx.fillStyle=l.bg; cx.fillRect(l.x-2,l.top,Math.ceil(l.w)+4,l.h);   // подложка цвета полосы — линия маркера не просвечивает сквозь текст
    cx.fillStyle=l.col; cx.fillText(l.t,l.x,l.y);
  }
}
// шрифт подписей полос/каналов: обычное начертание — bold моноширинный на 10-11px мажется
const BP_FONT='11px monospace';

// Полосы (band plan) и точечные закладки — из узла 'bandplan'/'bookmarks', список {lo,hi,label,color}.
// hi===lo — точка (закладка), иначе — полоса. Пересекающиеся полосы раскладываем по "дорожкам"
// (жадная раскраска интервального графа, как в календарях) — иначе перекрытие сливалось бы в
// нечитаемое пятно. H — вся зона спектра (для вертикальных линий точек), plotH — она же БЕЗ
// зоны подписей оси частот снизу (см. AXIS_H в draw()) — именно от неё дорожки полос растут вверх,
// вплотную над осью, но не поверх её подписей. Водопад ни здесь, ни в вызывающем draw() не трогаем.
function saBandPlan(n,cx,W,H,plotH){
  const list=n.bandsData;
  if(!list||!list.length){ if(n._bmBoxes) n._bmBoxes.length=0; if(n._bpLabels) n._bpLabels.length=0; return; }
  const [lo0,hi0]=saBounds(n);
  const ranges=[], points=[];
  const labels=n._bpLabels=(n._bpLabels||[]); labels.length=0;   // подписи полос — рисует saBandPlanLabels поверх маркеров
  for(const b of list){
    if(!b || typeof b.lo!=='number' || isNaN(b.lo)) continue;
    const hi=(typeof b.hi==='number' && !isNaN(b.hi)) ? b.hi : b.lo;
    if(hi===b.lo){
      if(b.lo<lo0-1 || b.lo>hi0+1) continue;            // точка вне окна — не рисуем вовсе
      points.push(b);
    } else {
      const a=Math.min(b.lo,hi), c=Math.max(b.lo,hi);
      if(c<lo0 || a>hi0) continue;                      // полоса целиком вне окна
      ranges.push({lo:a,hi:c,label:b.label,color:b.color});
    }
  }
  // ---- полосы: дорожки СНИЗУ ВВЕРХ от границы зоны оси частот (plotH) — единой лентой прямо над
  // подписями оси, не наползая на них ----
  if(ranges.length){
    // сортируем по началу (lo) — жадная раскраска по началу оптимальна по числу дорожек:
    // не пересекающиеся (даже впритык, по общей границе — см. e<=r.lo ниже) полосы стабильно
    // уходят в одну дорожку, а не расползаются по разным. При одинаковом lo первой кладём более
    // широкую полосу — она первой займёт нижнюю дорожку, а узкая (более специфичная),
    // перекрывающая её от той же точки, уйдёт выше — не наоборот.
    ranges.sort((x,y)=>x.lo-y.lo || (y.hi-y.lo)-(x.hi-x.lo));
    const laneEnd=[];                                   // laneEnd[i] — правая граница последней полосы в дорожке i
    const LANE_H=16, MAX_LANES=4;
    for(const r of ranges){
      let lane=laneEnd.findIndex(e=>e<=r.lo);
      if(lane<0){ if(laneEnd.length>=MAX_LANES) lane=laneEnd.length-1; else { lane=laneEnd.length; laneEnd.push(-Infinity); } }
      laneEnd[lane]=r.hi; r._lane=lane;
    }
    cx.font=BP_FONT;
    const scr=hexToRgb(themeColor('--screen')||'#0a0d0e'), FILL_A=.5;
    for(const r of ranges){
      const x1=Math.round(saPos(n,r.lo)*W), x2=Math.round(saPos(n,r.hi)*W);
      if(x2<0||x1>W) continue;                            // целиком вне канвы — сам прямоугольник не рисуем
      const w=Math.max(1,x2-x1), y=plotH-(r._lane+1)*LANE_H, col=r.color||'#5fb8d1';
      cx.globalAlpha=FILL_A; cx.fillStyle=col; cx.fillRect(x1,y,w,LANE_H-1);
      cx.globalAlpha=1; cx.fillRect(x1,y,w,2);            // яркий верхний кант — граница полосы видна на любом шуме
      cx.fillStyle=themeColor('--screen');                 // тёмные разделители — соседние сегменты не сливаются
      cx.fillRect(x1,y,1,LANE_H-1); cx.fillRect(x2-1,y,1,LANE_H-1);
      // подпись — по центру ВИДИМОЙ (обрезанной канвой) части полосы: у широкой полосы, уходящей
      // за край экрана, подпись иначе уезжала бы за канву. Не влезает — обрезаем с '…'.
      const vx1=Math.max(x1,0), vx2=Math.min(x2,W), vw=vx2-vx1;
      let label=r.label||(fmtHz(r.lo)+'-'+fmtHz(r.hi)), tw=cx.measureText(label).width;
      if(tw+6>vw){
        const cw=cx.measureText('M').width, k=Math.floor((vw-6)/cw)-1;
        if(k<2) continue;
        label=label.slice(0,k)+'…'; tw=cx.measureText(label).width;
      }
      const tx=clamp(Math.round((vx1+vx2)/2-tw/2), x1+3, x2-tw-3), ty=y+LANE_H-4;
      // цвет текста — по фактическому фону (полоса с FILL_A поверх тёмного экрана), а не по цвету полосы
      const [cr,cg,cb]=hexToRgb(col), mix=v=>Math.round(v).toString(16).padStart(2,'0');
      const bg='#'+[cr,cg,cb].map((v,i)=>mix(v*FILL_A+scr[i]*(1-FILL_A))).join('');
      labels.push({t:label,x:tx,y:ty,w:tw,top:y+2,h:LANE_H-3,bg,col:contrastText(bg)});
    }
    cx.globalAlpha=1;
  }
  // ---- точки (закладки): штриховая линия во всю H + подпись у ПОТОЛКА спектра, залитая своим
  // цветом и отцентрированная НА линии (не сбоку от неё) — не сливается ни с полосами снизу, ни с
  // флажками маркеров, которые теперь тоже снизу (см. saMarkers). n._bmBoxes — прямоугольники
  // подписей в пикселях канвы, читает sa's draw() (analysis.js) для клика/наведения; наведённая
  // (n._bmHoverFreq) рисуется ПОСЛЕДНЕЙ, поверх соседних — иначе близко стоящие подписи
  // перекрывают друг друга и не разобрать, на какую навели.
  if(points.length){
    cx.font='9px monospace'; cx.setLineDash([3,3]);
    const boxes=n._bmBoxes=(n._bmBoxes||[]); boxes.length=0;
    const hoverF=n._bmHoverFreq;
    const ordered = hoverF!=null && points.some(p=>p.lo===hoverF)
      ? [...points.filter(p=>p.lo!==hoverF), ...points.filter(p=>p.lo===hoverF)]
      : points;
    for(const p of ordered){
      const x=Math.round(saPos(n,p.lo)*W); if(x<-2||x>W+2) continue;
      const col=p.color||'#c9c9c9', hovered=hoverF===p.lo;
      cx.strokeStyle=col; cx.lineWidth=1; cx.globalAlpha=.7;
      cx.beginPath(); cx.moveTo(x+.5,0); cx.lineTo(x+.5,H); cx.stroke();
      cx.globalAlpha=1;
      const t=p.label||fmtHz(p.lo), ty=12;
      const tw=cx.measureText(t).width;
      const tx=clamp(Math.round(x-tw/2), 2, W-tw-2);           // по центру линии, не сбоку
      cx.globalAlpha=hovered?1:.85; cx.fillStyle=col; cx.fillRect(tx-3,ty-9,tw+6,12);
      cx.globalAlpha=1; cx.fillStyle=contrastText(col); cx.fillText(t,tx,ty);
      boxes.push({x0:tx-3,y0:ty-9,x1:tx+tw+3,y1:ty+3,freq:p.lo});
    }
    cx.setLineDash([]);
  } else if(n._bmBoxes) n._bmBoxes.length=0;
}
// snap клика к сетке каналов полосы из bandplan (n.bandsData) — НЕ к пикселям, а к шагу канала в
// Гц (поле 'step' у полосы: например, LPD433 — 25кГц, HF Broadcast — 5кГц; см. BANDPLAN_PRESETS в
// analysis.js). Полоса без step (не channelized — обычный ISM-диапазон, любительский участок и
// т.п.) не снапает вообще — там непрерывная настройка. Клик должен попасть в саму полосу (плюс
// пол-шага за край — чтобы не мазать мимо крайнего канала из-за огрубления клика до пикселя);
// канал считается от lo с фиксированным шагом, а не от произвольной точки клика — иначе один и тот
// же канал давал бы разные частоты в зависимости от того, где именно внутри него кликнули.
function saSnapFreq(n,f){
  const list=n.bandsData;
  if(!n.p.snap || !list || !list.length) return f;
  let best=null, bestW=Infinity;                      // вложенные полосы — берём самую узкую (сегмент внутри диапазона)
  for(const b of list){
    const step=+b?.step;
    if(!b || typeof b.lo!=='number' || isNaN(b.lo) || !step || step<=0) continue;
    const hi=(typeof b.hi==='number' && !isNaN(b.hi)) ? b.hi : b.lo;
    const lo=Math.min(b.lo,hi), hiB=Math.max(b.lo,hi);
    if(f<lo-step/2 || f>hiB+step/2) continue;           // клик не по этой полосе
    if(hiB-lo<bestW){ bestW=hiB-lo; best=clamp(lo+Math.round((f-lo)/step)*step, lo, hiB); }
  }
  return best??f;
}
function saTake(n){                                  // применить накопленный тап — в выбранный маркер
  if(n.pickT==null) return;
  const k=n.active-1;
  if(!n.ext[k]) n.mk[k]=saSnapFreq(n, saFreq(n,n.pickT));
  n.pickT=null;
}
// цвет текста, контрастный заданному фону (упрощённая перцептивная яркость) — общее правило для
// маркеров и точечных закладок: фон залит своим цветом, текст поверх — чёрный или белый, что
// контрастнее, обводка не нужна (см. использование ниже и в saBandPlan)
function contrastText(hex){
  const [r,g,b]=hexToRgb(hex);
  return (r*0.299+g*0.587+b*0.114)>150 ? '#000' : '#fff';
}
// n._mkBoxes — прямоугольники подписей маркеров в пикселях канвы (читает sa's draw() в analysis.js
// для клика/наведения), n._mkHoverIdx — номер наведённого (0-3), рисуется последним (поверх
// соседних), как и у точечных закладок в saBandPlan.
function saMarkers(n,cx,W,H){
  cx.lineWidth=1; cx.globalAlpha=1; cx.font='10px monospace';
  const TOP_H=16;                                    // потолок с подписями закладок (см. saBandPlan) — не залезаем
  const boxes=n._mkBoxes=(n._mkBoxes||[]); boxes.length=0;
  const hoverK=n._mkHoverIdx;
  const present=[0,1,2,3].filter(k=>n.mk[k]!=null);
  const order = hoverK!=null && present.includes(hoverK)
    ? [...present.filter(k=>k!==hoverK), hoverK]
    : present;
  for(const k of order){
    const f=n.mk[k];
    const x=Math.round(saPos(n,f)*W); if(x<-2||x>W+2) continue;
    const act=(n.active-1)===k, hovered=hoverK===k;
    // линия начинается НИЖЕ потолка (см. TOP_H) — там теперь подписи закладок (см. saBandPlan), и
    // полоса маркера не должна наезжать на них своим цветом поверх
    cx.strokeStyle=themeColor('--screen'); cx.lineWidth=act?3:2; cx.globalAlpha=.55;   // тёмная обводка под линией
    cx.beginPath(); cx.moveTo(x+.5,TOP_H); cx.lineTo(x+.5,H); cx.stroke();
    cx.globalAlpha=1;
    cx.strokeStyle=MK_COL(k); cx.lineWidth=act?1.5:1;
    cx.beginPath(); cx.moveTo(x+.5,TOP_H); cx.lineTo(x+.5,H); cx.stroke();
    cx.font='10px monospace';
    // "1: 433.075 -75 / 18" — номер, частота (3 знака — см. коммент у fmtHz, иначе близкие маркеры
    // выглядят как одна и та же частота, без буквы единицы — компактнее), уровень — одной строкой
    const fv=fmtHz(f,3).replace(/[kMG]$/,'');
    // маркер на канале приёмника — RSSI канала (dBFS) / SNR, ровно те, что сравнивает шумоподавитель;
    // иначе пик в окне ±tol / SNR над шумовой полкой (см. saNoiseFloor)
    const ch=saChanAtMarker(n,f);
    const t=(k+1)+': '+fv+(ch && ch.rssi!=null
      ? ' '+ch.rssi.toFixed(0)+'dBFS / '+(ch.snr!=null?ch.snr.toFixed(0):'—')
      : n.db[k]>-119?' '+n.db[k].toFixed(0)+' / '+Math.max(0,n.snr?.[k]??0).toFixed(0):'');
    const tw=cx.measureText(t).width;
    // по центру линии маркера; дорожка стека — по НОМЕРУ маркера (k), а не по порядку рисования —
    // иначе позиции соседних подписей "прыгали" бы при каждой смене наведения
    const tx=clamp(Math.round(x-tw/2), 2, W-tw-2), ty=H-14-k*14;
    cx.globalAlpha=hovered?1:(act?.95:.75); cx.fillStyle=MK_COL(k);
    cx.fillRect(tx-3,ty,tw+6,12);
    cx.globalAlpha=1; cx.fillStyle=contrastText(MK_COL(k));
    cx.fillText(t,tx,ty+9);
    boxes.push({x0:tx-3,y0:ty,x1:tx+tw+3,y1:ty+12,idx:k});
  }
  cx.lineWidth=1;
}
// Вкладки-переключатели активного маркера (1-4) в правом верхнем углу графика — замена
// прежнего отдельного ряда кнопок 'active' в панели узла: активная вкладка ярче, у занятых
// маркеров — кружок "×" в углу для точечной очистки. n._tabBoxes читает pointerup в draw()
// (analysis.js): сначала пробует b.cl (крестик), потом сам прямоугольник (выбор активного).
function saMarkerTabs(n,cx,W){
  const TW=20, TH=15, GAP=3, right=W-4;
  const boxes=n._tabBoxes=(n._tabBoxes||[]); boxes.length=0;
  cx.font='10px monospace'; cx.textAlign='center'; cx.textBaseline='middle';
  for(let k=0;k<4;k++){
    const x1=right-k*(TW+GAP), x0=x1-TW, y0=2, y1=2+TH;
    const act=(n.active-1)===k, has=n.mk[k]!=null;
    cx.globalAlpha=act?1:.45; cx.fillStyle=MK_COL(k);
    cx.fillRect(x0,y0,TW,TH);
    cx.globalAlpha=1; cx.fillStyle=contrastText(MK_COL(k));
    cx.fillText(String(k+1),x0+TW/2,y0+TH/2+1);
    let cl=null;
    if(has){                                          // маленький бейдж "×" — своя, отдельная зона клика
      const cs=8, cx0=x1-cs+2, cy0=y0-3;
      cx.fillStyle=themeColor('--err'); cx.beginPath(); cx.arc(cx0+cs/2,cy0+cs/2,cs/2,0,7); cx.fill();
      cx.fillStyle=themeColor('--scr-hi'); cx.font='8px monospace';
      cx.fillText('×',cx0+cs/2,cy0+cs/2+1);
      cx.font='10px monospace';
      cl={x0:cx0-2,y0:cy0-2,x1:cx0+cs+2,y1:cy0+cs+2};
    }
    boxes.push({x0,y0,x1,y1,idx:k,cl});
  }
  cx.textAlign='left'; cx.textBaseline='alphabetic'; cx.globalAlpha=1;
}

function saBounds(n){                              // границы отображаемой оси — либо ручные fmin/fmax
  const [lo0,hi0]=specSpan(n.s);                    // (обрезанные под реальный охват спектра), либо весь
  // зум/панорама мышью — отдельное окно просмотра поверх auto/ручного диапазона (не сохраняется)
  if(n.zoom){
    if(n._dragPending) return n.zoom;               // окно нарочно обгоняет ещё не перестроенный приёмник
    const lo=clamp(n.zoom[0],lo0,hi0), hi=clamp(n.zoom[1],lo0,hi0);
    return lo<hi ? [lo,hi] : [lo0,hi0];
  }
  if(n.p.auto) return [lo0,hi0];                    // охват целиком — если включён авто-диапазон
  // n._dragPending (см. drag в analysis.js) — окно НАРОЧНО забежало вперёд ещё не подтверждённых
  // данных (оптимистичное "перелистывание страницы" при перетаскивании за реально захваченный
  // край, не дожидаясь асинхронной USB-перестройки). Клэмпить fmin/fmax к ЕЩЁ СТАРОМУ specSpan в
  // этом случае нельзя — оба конца тут же прижмёт к одному и тому же (старому) краю, диапазон
  // станет вырожденным, и ниже честно вернётся весь СТАРЫЙ охват целиком: на экране это выглядит
  // как "спектр вдруг растягивается на всю полосу", хотя на самом деле никто не масштабировал —
  // это просто клэмп сбивает уже корректно выставленное (см. process()) оптимистичное окно.
  if(n._dragPending) return [n.p.fmin, n.p.fmax];
  // Оба конца клэмпим НЕЗАВИСИМО к [lo0,hi0] (не hi относительно уже клэмпленного lo, как было
  // раньше) — иначе если fmin/fmax ОБА улетели за один и тот же край (например, при перетаскивании
  // спектра дальше, чем реально захвачено приёмником — см. drag в analysis.js, там это нарочно не
  // клэмпится, чтобы centerFreq мог попросить приёмник перестроиться), старый вариант считал
  // hi=clamp(fmax, lo+10, hi0) с lo УЖЕ прижатым к hi0 — получался инвертированный диапазон
  // (lo+10>hi0), и clamp() на нём возвращал что попало: экран либо "разъезжался" (ширина окна
  // скакала), либо схлопывался в точку. Если после независимого клэмпа диапазон всё равно
  // вырожденный (оба конца прижало к одному и тому же краю) — честно показываем весь охват
  // целиком, а не то, что получится из деления на вырожденную разницу.
  const lo=clamp(n.p.fmin,lo0,hi0), hi=clamp(n.p.fmax,lo0,hi0);
  return lo<hi ? [lo,hi] : [lo0,hi0];
}
function saFreq(n,t){                              // доля ширины → частота
  const [lo,hi]=saBounds(n);
  if(!n.p.log) return lo+(hi-lo)*t;
  const l=Math.max(lo,10); return l*Math.pow(hi/l,t);
}
function saPos(n,f){
  const [lo,hi]=saBounds(n);
  if(!n.p.log) return (f-lo)/(hi-lo);
  const l=Math.max(lo,10); return Math.log(Math.max(f,1)/l)/Math.log(hi/l);
}
// n.set.fmin/fmax — виджет 'range2' (см. core-graph.js), у него нижний конец клэмпится
// относительно ТЕКУЩЕГО (ещё не обновлённого) верхнего и наоборот. При вызове n.set.fmin(),
// затем n.set.fmax() ПОДРЯД, если сдвиг больше самой ширины окна (панорама рывком дальше, чем
// видно, или агрессивный зум) — первый вызов клэмпится о ЕЩЁ СТАРОЕ значение второго и портит
// результат (наблюдалось как "спектр растягивается" при перетаскивании: fmin залипал на старом
// fmax вместо настоящей цели). Правило простое: сначала выставляем тот конец, что движется в
// сторону РОСТА диапазона (не может конфликтовать со старым значением другого), потом — второй.
function saSetRange(n,newLo,newHi){
  if(newLo>=n.p.fmin){ n.set.fmax?.(newHi); n.set.fmin?.(newLo); }
  else { n.set.fmin?.(newLo); n.set.fmax?.(newHi); }
}
// знаков после запятой у подписи оси: столько, чтобы шаг сетки был виден в единицах fmtHz
// (7.05M при шаге 50 кГц, 14.225M при 25 кГц, 7.0005M при 500 Гц); лог-сетка (1/2/5×10ⁿ) — без дробной части
function saTickDp(f,step){
  if(!step) return 0;
  const a=Math.abs(f), unit=a>=1e9?1e9:a>=1e6?1e6:a>=1e3?1e3:1;
  const q=step/unit;
  for(let d=0;d<6;d++){ const v=q*10**d; if(Math.abs(v-Math.round(v))<1e-6*Math.max(1,v)) return d; }
  return 6;
}
function saGrid(n,cx,W,hs,H,plotH,diff){            // сетка частот и уровня с подписями
  const lo=saFreq(n,0), hi=saFreq(n,1);
  cx.lineWidth=1; cx.globalAlpha=1;
  cx.strokeStyle=themeColor('--grid'); cx.fillStyle=themeColor('--axis'); cx.font='9px monospace';
  const marks=[];
  let step=0;                                       // шаг линейной сетки — от него точность подписей
  if(n.p.log){
    for(let d=1;d<=1e10;d*=10) for(const m of [1,2,5]){ const f=d*m;   // до ~10 ГГц — с запасом под RF
      if(f>=lo&&f<=hi) marks.push(f); }
  } else {
    // "красивый" шаг степенью десятки — как в сетке rtlsdr, а не список кандидатов до 20кГц:
    // тот список годился только для аудио, для RF-полосы в сотни МГц/ГГц давал бы либо пустую
    // сетку, либо (после фолбэка на последний кандидат) тысячи линий подряд
    const span=hi-lo||1;
    const base=Math.pow(10,Math.floor(Math.log10(span/6)));
    step=[1,2,5,10].map(k=>k*base).find(s=>span/s<=8)||base*10;
    // f от индекса, не накоплением f+=step — без дрейфа float на RF-частотах
    for(let i=Math.ceil(lo/step); i*step<=hi; i++) marks.push(i*step);
  }
  for(const f of marks){
    const x=Math.round(saPos(n,f)*W)+.5;
    cx.beginPath(); cx.moveTo(x,0); cx.lineTo(x,H); cx.stroke();
    const t=fmtHz(f,saTickDp(f,step));
    // подпись — в зарезервированной зоне снизу (см. AXIS_H в draw()), ниже plotH — сама трасса
    // спектра туда не заходит (см. plotH в амплитуде/фазе/PSD), так что подпись не замазывает
    cx.fillText(t,Math.min(x+2,W-cx.measureText(t).width-2),hs-4); }
  // уровень: "круглый" шаг в дБ (1/2/5/10/20…) под высоту графика, подписи слева у линий;
  // шкала та же, что у трассы: floor..top, в режиме diff — ±40 дБ
  const dLo=diff?-40:n.p.floor, dHi=diff?40:n.p.top, dr=(dHi-dLo)||1;
  const want=Math.max(2,Math.floor(plotH/28));       // не чаще ~28 px между линиями
  const dStep=[1,2,5,10,20,50].find(s=>dr/s<=want)||100;
  const labels=n._dbLabels=(n._dbLabels||[]); labels.length=0;   // подписи рисует saDbLabels — поверх трассы
  for(let v=Math.ceil(dLo/dStep)*dStep; v<=dHi; v+=dStep){
    const y=Math.round(plotH-clamp((v-dLo)/dr,0,1)*(plotH-2)-1)+.5;
    if(y<14||y>plotH-2) continue;                    // верх — зона закладок, низ — край графика
    cx.beginPath(); cx.moveTo(0,y); cx.lineTo(W,y); cx.stroke();
    labels.push({t:(diff&&v>0?'+':'')+v+'dB',y});
  }
}
function saDbLabels(n,cx){
  const list=n._dbLabels; if(!n.p.grid||!list||!list.length) return;
  cx.font='9px monospace';
  const scr=themeColor('--screen'), ax=themeColor('--axis');
  for(const l of list){
    const tw=Math.ceil(cx.measureText(l.t).width);
    cx.globalAlpha=.75; cx.fillStyle=scr; cx.fillRect(1,l.y-11,tw+4,10);
    cx.globalAlpha=1; cx.fillStyle=ax; cx.fillText(l.t,3,l.y-3);
  }
}

def({ id:'thresh', title:'Threshold', cat:'Processing',
  ins:[{n:'num',t:'num'},{n:'sig',t:'sig'},{n:'thr',t:'num'},{n:'hys',t:'num'},{n:'hold',t:'num'},
       {n:'auto',t:'num'},{n:'invert',t:'num'}],
  outs:[{n:'num',t:'num'},{n:'sig',t:'sig'}],
  params:[{n:'thr',t:'range',min:-1,max:1,step:.005,d:.5},
          {n:'hys',t:'range',min:0,max:.5,step:.005,d:.05},
          {n:'hold',t:'range',min:0,max:2000,step:5,d:0},
          {n:'auto',t:'check',d:false},
          {n:'invert',t:'check',d:false}],
  init:n=>{n.s=false;n.h=0;n.mn=0;n.mx=1;},
  process(n,I){
    for(const k of ['thr','hys','hold']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    for(const k of ['auto','invert']) if(typeof I[k]==='number') setMod(n,k,I[k]>=0.5);
    const os=buf(n,'sig'), dt=BLOCK/Eng.sr*1000;
    const hasSig=!!I.sig;
    for(let i=0;i<BLOCK;i++){
      const v=hasSig? I.sig[i] : (I.num||0);
      let thr=n.p.thr, hys=n.p.hys;
      if(n.p.auto){ n.mx=v>n.mx?v:n.mx*.99995+v*.00005; n.mn=v<n.mn?v:n.mn*.99995+v*.00005;
        const d=Math.max(.02,n.mx-n.mn); thr=n.mn+d*clamp(n.p.thr,0,1); hys=d*.06; }
      n.s = n.s ? v>thr-hys : v>thr+hys;
      os[i]=n.s?1:-1;
      if(!hasSig) break; }
    if(!hasSig) os.fill(n.s?1:-1);
    if(n.s) n.h=n.p.hold; else n.h=Math.max(0,n.h-dt);
    let g=(n.s||n.h>0)?1:0; if(n.p.invert) g=1-g;
    if(n.p.invert) for(let i=0;i<BLOCK;i++) os[i]=-os[i];
    return {num:g, sig:os}; }});


function acCompute(n){
  const N=n.ring.length, x=new Float32Array(N);
  let mean=0;
  for(let i=0;i<N;i++){ x[i]=n.ring[(n.w+i)%N]; mean+=x[i]; }
  mean/=N;
  let e=0; for(let i=0;i<N;i++){ x[i]-=mean; e+=x[i]*x[i]; }
  const lo=Math.max(1,Math.floor(Eng.sr/n.p.fmax)), hi=Math.min(N>>1,Math.ceil(Eng.sr/n.p.fmin));
  n.lo=lo; n.hi=hi;
  const step=N>8192?2:1, len=hi-lo+1;
  if(!n.r||n.r.length!==len) n.r=new Float32Array(len);
  if(e/N<1e-10){ n.r.fill(0); n.conf=0; n.f=0; n.lag=0; return; }
  let best=-2;
  for(let L=lo;L<=hi;L++){
    let r=0,ea=0,eb=0;
    for(let i=0;i<N-L;i+=step){ r+=x[i]*x[i+L]; ea+=x[i]*x[i]; eb+=x[i+L]*x[i+L]; }
    const v=n.p.norm? 2*r/(ea+eb+1e-12) : r/(e/2+1e-12);
    n.r[L-lo]=v; if(v>best) best=v; }
  let bl=-1;                                         // наименьший период с почти тем же пиком
  for(let L=lo+1;L<hi;L++){
    const v=n.r[L-lo];
    if(v>=0.9*best && v>=n.r[L-lo-1] && v>=n.r[L-lo+1]){ bl=L; break; } }
  if(bl<0){ n.conf=Math.max(0,best); n.f=0; n.lag=0; return; }
  const r0=n.r[bl-lo-1], r1=n.r[bl-lo], r2=n.r[bl-lo+1];
  const d=0.5*(r0-r2)/(r0-2*r1+r2||1e-9);
  n.lag=bl+clamp(d,-.5,.5); n.f=Eng.sr/n.lag; n.conf=clamp(r1,0,1);
}

def({ id:'denoiser', title:'Denoiser (spectral)', cat:'Audio',
  ins:[{n:'in',t:'sig'},{n:'floor',t:'num'},{n:'alpha',t:'num'},{n:'gain',t:'num'},{n:'smooth',t:'num'}],
  outs:[{n:'out',t:'sig'}],
  params:[{n:'floor',t:'range',min:0.01,max:0.5,step:0.01,d:0.1,label:'noise level'},
          {n:'alpha',t:'range',min:0.1,max:0.99,step:0.01,d:0.9,label:'adaptation'},
          {n:'gain',t:'range',min:0.1,max:4,step:0.1,d:1.5,label:'gain'},
          {n:'smooth',t:'range',min:0.1,max:0.99,step:0.01,d:0.7,label:'smoothing'}],
  init:n=>{ n.noiseProfile=null; n.alpha=0.9; n.N=0; },
  process(n,I){
    for(const k of ['floor','alpha','gain','smooth']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const N = 1024;
    if(n.N !== N){
      n.N = N;
      n.buf = new Float32Array(N*2);
      n.w = 0;
      n.noiseProfile = new Float32Array(N/2);
      n.profileCnt = 0;
      n.re = new Float32Array(N); n.im = new Float32Array(N);   // переиспользуем — раньше аллоцировались на каждый БПФ
      n.win = window_('hann', N);
    }
    const dt = BLOCK / Eng.sr;
    
    // Накопление буфера
    for(let i=0;i<BLOCK;i++){
      n.buf[n.w] = I.in ? I.in[i] : 0;
      n.w = (n.w+1) % (N*2);
    }
    
    // БПФ каждые N/2 отсчётов (перекрытие 50%)
    if(n.w % (N/2) < BLOCK){
      const re = n.re, im = n.im, win = n.win;
      const start = (n.w - N + N*2) % (N*2);
      
      for(let i=0;i<N;i++){
        re[i] = n.buf[(start+i) % (N*2)] * win[i];
        im[i] = 0;
      }
      fft(re, im);
      
      // Обновление профиля шума (медленно, когда сигнал слабый)
      const half = N/2;
      const avgPower = re.reduce((s,v,i) => s + Math.hypot(v,im[i]), 0) / half;
      
      if(avgPower < 0.01 || n.profileCnt < 100){
        for(let i=0;i<half;i++){
          const mag = Math.hypot(re[i], im[i]);
          n.noiseProfile[i] = n.noiseProfile[i] * n.alpha + mag * (1-n.alpha);
        }
        n.profileCnt++;
      }
      
      // Вычитание шума
      const floor = n.p.floor;
      for(let i=0;i<half;i++){
        const sig = Math.hypot(re[i], im[i]);
        const noise = n.noiseProfile[i] || 0.001;
        let gain = Math.max(0, (sig - noise*floor) / (sig + 0.001));
        gain = Math.pow(gain, 0.5);
        gain = Math.min(1, gain * n.p.gain);
        re[i] *= gain;
        im[i] *= gain;
      }
      
      // Обратное БПФ
      for(let i=0;i<half;i++){
        re[i+half] = re[i];
        im[i+half] = -im[i];
      }
      fft(re, im);
      
      // Перекрытие-сложение (overlap-add)
      const out = buf(n,'out');
      const oStart = (start + N/2) % (N*2);
      for(let i=0;i<N/2;i++){
        const idx = (oStart + i) % (N*2);
        out[i] = (out[i] || 0) + re[i] / N * 0.5;
      }
      
      return {out: out};
    }
    return {out: null};
  }
});


def({ id:'wavelet', title:'Wavelet (const. Q)', cat:'Processing',
  ins:[{n:'in',t:'sig'},{n:'fmin',t:'num'},{n:'fmax',t:'num'},{n:'Q',t:'num'},{n:'floor',t:'num'},{n:'top',t:'num'}],
  outs:[{n:'spec',t:'spec'},{n:'f',t:'num'},{n:'level',t:'num'}],
  params:[{n:'fmin',t:'range',min:20,max:5000,step:1,d:100,log:true},
          {n:'fmax',t:'range',min:100,max:()=>Eng.sr/2,step:1,d:5000,log:true},
          {n:'bands',t:'select',opts:['24','48','96','144','288'],d:'96'},
          {n:'Q',t:'range',min:2,max:48,step:.5,d:12},
          {n:'decim',t:'select',opts:['auto','1','4','16','64','256'],d:'auto',
           label:'decimation'},
          {n:'floor',t:'range',min:-140,max:-20,step:1,d:-90,label:'level floor'},
          {n:'top',t:'range',min:-60,max:20,step:1,d:-10,label:'level top'}],
  init:n=>{n.key='';n.f=0;n.lv=0;n.acc=0;n.cnt=0;},
  process(n,I){
    for(const k of ['fmin','fmax','Q','floor','top']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const B=+n.p.bands;
    const hiF=Math.max(n.p.fmin,n.p.fmax);
    let D=+n.p.decim;
    if(n.p.decim==='auto'){                          // держим запас втрое над верхней полосой
      D=1; while(D*4<=256 && hiF*6 < Eng.sr/(D*4)) D*=4; }
    D=Math.max(1,Math.min(D, Math.floor(Eng.sr/(hiF*3))||1));
    const srE=Eng.sr/D;
    const key=B+'/'+n.p.fmin+'/'+n.p.fmax+'/'+n.p.Q+'/'+srE;
    if(n.key!==key){                                 // банк комплексных резонаторов, шаг по логарифму
      n.key=key; n.B=B; n.D=D; n.srE=srE;
      n.fc=new Float32Array(B); n.cr=new Float32Array(B); n.ci=new Float32Array(B);
      n.zr=new Float32Array(B); n.zi=new Float32Array(B);
      n.mag=new Float32Array(B); n.g=new Float32Array(B);
      const lo=Math.min(n.p.fmin,n.p.fmax), hi=Math.max(n.p.fmin,n.p.fmax);
      for(let k=0;k<B;k++){
        const f=lo*Math.pow(hi/lo,k/(B-1));
        n.fc[k]=f;
        const a=Math.exp(-Math.PI*f/(n.p.Q*srE));    // полоса f/Q — постоянная добротность
        const w=2*Math.PI*f/srE;
        n.cr[k]=a*Math.cos(w); n.ci[k]=a*Math.sin(w); n.g[k]=1-a; } }
    const B2=n.B, DD=n.D;
    for(let i=0;i<BLOCK;i++){
      n.acc+=I.in?I.in[i]:0;                          // усреднение = антиалиасинг перед прореживанием
      if(++n.cnt<DD) continue;
      const x=n.acc/DD; n.acc=0; n.cnt=0;
      for(let k=0;k<B2;k++){
        const zr=n.zr[k], zi=n.zi[k];
        n.zr[k]=zr*n.cr[k]-zi*n.ci[k]+x;
        n.zi[k]=zr*n.ci[k]+zi*n.cr[k]; } }
    let best=0,bv=-1;
    for(let k=0;k<B2;k++){
      n.mag[k]=Math.hypot(n.zr[k],n.zi[k])*n.g[k];   // нормировка усиления резонатора
      if(n.mag[k]>bv){ bv=n.mag[k]; best=k; } }
    n.f=n.fc[best];
    n.lv=clamp((20*Math.log10(bv+1e-12)-n.p.floor)/((n.p.top-n.p.floor)||1),0,1);
    n.spec=n.spec||{};
    n.spec.mag=n.mag; n.spec.freqs=n.fc; n.spec.sr=n.srE; n.spec.size=B*2;
    n.spec.rev=(n.spec.rev|0)+1;
    return {spec:n.spec, f:n.f, level:n.lv}; }});


function tfBlock(n){
  const N=n.N, a=n.p.avg;
  for(let i=0;i<N;i++){ n.re1[i]=n.bx[i]*n.win[i]; n.im1[i]=0;
                        n.re2[i]=n.by[i]*n.win[i]; n.im2[i]=0; }
  fft(n.re1,n.im1); fft(n.re2,n.im2);
  let cs=0;
  for(let k=0;k<N/2;k++){
    const xr=n.re1[k], xi=n.im1[k], yr=n.re2[k], yi=n.im2[k];
    n.xx[k]=n.xx[k]*a+(xr*xr+xi*xi)*(1-a);
    n.yy[k]=n.yy[k]*a+(yr*yr+yi*yi)*(1-a);
    n.xyr[k]=n.xyr[k]*a+(xr*yr+xi*yi)*(1-a);         // взаимный спектр Sxy = X* · Y
    n.xyi[k]=n.xyi[k]*a+(xr*yi-xi*yr)*(1-a);
    const sxx=n.xx[k]+1e-20;
    n.H[k]=Math.hypot(n.xyr[k],n.xyi[k])/sxx;        // оценка H1
    n.C[k]=clamp((n.xyr[k]*n.xyr[k]+n.xyi[k]*n.xyi[k])/(sxx*(n.yy[k]+1e-20)),0,1);
    cs+=n.C[k]; }
  n.cavg=cs/(N/2); n.frames=(n.frames||0)+1;
}

def({ id:'cepstrum', title:'Cepstrum', cat:'Processing', ins:[{n:'in',t:'sig'},{n:'fmin',t:'num'},{n:'fmax',t:'num'}],
  outs:[{n:'spec',t:'spec'},{n:'f0',t:'num'},{n:'conf',t:'num'}],
  params:[{n:'size',t:'select',opts:['2048','4096','8192','16384'],d:'8192'},
          {n:'fmin',t:'range',min:10,max:2000,step:1,d:50,log:true},
          {n:'fmax',t:'range',min:50,max:()=>Eng.sr/2,step:1,d:2000,log:true}],
  init:n=>{n.N=0;n.f0=0;n.conf=0;},
  process(n,I){
    if(typeof I.fmin==='number') setMod(n,'fmin',I.fmin);
    if(typeof I.fmax==='number') setMod(n,'fmax',I.fmax);
    const N=+n.p.size;
    if(n.N!==N){ n.N=N; n.ring=new Float32Array(N); n.win=window_('hann',N);
      n.re=new Float32Array(N); n.im=new Float32Array(N);
      n.q=new Float32Array(N/2); n.fq=new Float32Array(N/2); n.mag=new Float32Array(N/2); }
    if(N<BLOCK) return {spec:null,f0:0,conf:0};
    n.ring.copyWithin(0,BLOCK);
    for(let i=0;i<BLOCK;i++) n.ring[N-BLOCK+i]=I.in?I.in[i]:0;
    for(let i=0;i<N;i++){ n.re[i]=n.ring[i]*n.win[i]; n.im[i]=0; }
    fft(n.re,n.im);
    for(let i=0;i<N;i++){                             // логарифм модуля спектра
      n.re[i]=Math.log(Math.hypot(n.re[i],n.im[i])+1e-12); n.im[i]=0; }
    fft(n.re,n.im);                                   // обратное = прямое для чётной функции
    const lo=Math.max(2,Math.floor(Eng.sr/n.p.fmax)), hi=Math.min(N/2-1,Math.ceil(Eng.sr/n.p.fmin));
    for(let k=0;k<N/2;k++) n.q[k]=Math.abs(n.re[k])/N;
    let best=0;
    for(let k=lo;k<=hi;k++) if(n.q[k]>best) best=n.q[k];
    let bi=-1;                                        // наименьший период с почти тем же пиком
    for(let k=lo+1;k<hi;k++)
      if(n.q[k]>=0.9*best && n.q[k]>=n.q[k-1] && n.q[k]>=n.q[k+1]){ bi=k; break; }
    if(bi<0){ bi=lo; for(let k=lo;k<=hi;k++) if(n.q[k]===best){ bi=k; break; } }
    // ось кепстра — период; отдаём её как частоту 1/период, по возрастанию
    const L=hi-lo+1;
    if(n.fq.length!==L){ n.fq=new Float32Array(L); n.mag=new Float32Array(L); }
    for(let j=0;j<L;j++){ const k=hi-j; n.fq[j]=Eng.sr/k; n.mag[j]=n.q[k]; }
    n.f0=Eng.sr/bi;
    let mean=0; for(let k=lo;k<=hi;k++) mean+=n.q[k]; mean/=(hi-lo+1);
    n.conf=clamp(best/(mean*8+1e-12),0,1);
    n.sp=n.sp||{}; n.sp.mag=n.mag; n.sp.freqs=n.fq; n.sp.sr=Eng.sr; n.sp.size=N;
    n.sp.rev=(n.sp.rev|0)+1;
    return {spec:n.sp, f0:n.f0, conf:n.conf}; }});

def({ id:'comp', title:'Compressor/Limiter', cat:'Audio', ins:[{n:'in',t:'sig'},{n:'thresh',t:'num'}],
  outs:[{n:'out',t:'sig'},{n:'gr',t:'num'}], readout:true,
  params:[{n:'mode',t:'select',opts:['compressor','limiter'],d:'compressor',fn:n=>{
            if(n.p.mode==='limiter'){ n.set.ratio?.(20); n.set.attack?.(.05); n.set.knee?.(0); } }},
          {n:'threshold',t:'range',min:-60,max:0,step:.1,d:-18,label:'threshold, dB'},
          {n:'ratio',t:'range',min:1,max:20,step:.1,d:4,label:'ratio'},
          {n:'knee',t:'range',min:0,max:24,step:.1,d:6,label:'knee, dB'},
          {n:'attack',t:'range',min:.1,max:200,step:.1,d:5,log:true,label:'attack, ms'},
          {n:'release',t:'range',min:5,max:1000,step:1,d:80,log:true,label:'release, ms'},
          {n:'makeup',t:'range',min:0,max:24,step:.1,d:0,label:'makeup, dB'}],
  init:n=>{ n.env=-100; n.grDb=0; },
  process(n,I){
    if(typeof I.thresh==='number') setMod(n,'threshold',I.thresh);
    const o=buf(n,'out'), x=I.in, p=n.p, sr=Eng.sr;
    const at=Math.exp(-1/(p.attack*.001*sr)), rl=Math.exp(-1/(p.release*.001*sr));
    const kneeH=p.knee/2, invR=1-1/p.ratio;
    let gr=0;
    for(let i=0;i<BLOCK;i++){
      const xi=x?x[i]:0;
      const lvl=20*Math.log10(Math.abs(xi)+1e-9);
      n.env = lvl>n.env ? at*n.env+(1-at)*lvl : rl*n.env+(1-rl)*lvl;   // разные коэф. на подъём/спад — классический peak-детектор
      const over=n.env-p.threshold;
      if(over<=-kneeH) gr=0;
      else if(over>=kneeH) gr=over*invR;
      else gr=((over+kneeH)*(over+kneeH))/(2*p.knee||1e-6)*invR;       // мягкое колено — парабола между линейными участками
      const gain=Math.pow(10,(p.makeup-gr)/20);
      o[i]=xi*gain; }
    n.grDb=gr;
    return {out:o, gr:-gr}; },
  draw(n){ n.el.querySelector('.readout').textContent = 'GR: -'+n.grDb.toFixed(1)+' dB'; }});


// формулы Audio EQ Cookbook (RBJ): peak/shelf-биквады с усилением, которых нет в 'biquad'
function shelfPeakCoef(type,f0,gainDb,Q,sr){
  const A=Math.pow(10,gainDb/40);
  const w0=2*Math.PI*Math.min(f0,sr*0.49)/sr;
  const cw=Math.cos(w0), sw=Math.sin(w0);
  if(type==='peak'){
    const alpha=sw/(2*Q);
    const b0=1+alpha*A, b1=-2*cw, b2=1-alpha*A;
    const a0=1+alpha/A, a1=-2*cw, a2=1-alpha/A;
    return [b0/a0,b1/a0,b2/a0,a1/a0,a2/a0];
  }
  const S=1;                                          // наклон полки зафиксирован
  const alpha=sw/2*Math.sqrt((A+1/A)*(1/S-1)+2);
  const sA=2*Math.sqrt(A)*alpha;
  if(type==='low'){
    const b0=A*((A+1)-(A-1)*cw+sA), b1=2*A*((A-1)-(A+1)*cw), b2=A*((A+1)-(A-1)*cw-sA);
    const a0=(A+1)+(A-1)*cw+sA, a1=-2*((A-1)+(A+1)*cw), a2=(A+1)+(A-1)*cw-sA;
    return [b0/a0,b1/a0,b2/a0,a1/a0,a2/a0];
  }
  const b0=A*((A+1)+(A-1)*cw+sA), b1=-2*A*((A-1)+(A+1)*cw), b2=A*((A+1)+(A-1)*cw-sA);
  const a0=(A+1)-(A-1)*cw+sA, a1=2*((A-1)-(A+1)*cw), a2=(A+1)-(A-1)*cw-sA;
  return [b0/a0,b1/a0,b2/a0,a1/a0,a2/a0];
}
function biStep(s,c,x){                                 // один шаг биквада с явным состоянием (для каскада)
  const y=c[0]*x+c[1]*s.x1+c[2]*s.x2-c[3]*s.y1-c[4]*s.y2;
  s.x2=s.x1; s.x1=x; s.y2=s.y1; s.y1=y;
  return y;
}

def({ id:'eq', title:'Equalizer (3 bands)', cat:'Processing',
  ins:[{n:'in',t:'sig'},{n:'loGain',t:'num'},{n:'midGain',t:'num'},{n:'hiGain',t:'num'}],
  outs:[{n:'out',t:'sig'}], readout:true,
  params:[{n:'loFreq',t:'range',min:20,max:1000,step:1,d:150,log:true,label:'low, Hz'},
          {n:'loGain',t:'range',min:-18,max:18,step:.1,d:0,label:'low, dB'},
          {n:'midFreq',t:'range',min:200,max:8000,step:1,d:1000,log:true,label:'mid, Hz'},
          {n:'midGain',t:'range',min:-18,max:18,step:.1,d:0,label:'mid, dB'},
          {n:'midQ',t:'range',min:.3,max:5,step:.1,d:1,label:'mid, Q'},
          {n:'hiFreq',t:'range',min:2000,max:20000,step:1,d:6000,log:true,label:'high, Hz'},
          {n:'hiGain',t:'range',min:-18,max:18,step:.1,d:0,label:'high, dB'}],
  init:n=>{n.s1={x1:0,x2:0,y1:0,y2:0}; n.s2={x1:0,x2:0,y1:0,y2:0}; n.s3={x1:0,x2:0,y1:0,y2:0};},
  process(n,I){
    for(const k of ['loGain','midGain','hiGain']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const o=buf(n,'out'), sr=Eng.sr;
    const c1=shelfPeakCoef('low', n.p.loFreq, n.p.loGain, .707, sr);
    const c2=shelfPeakCoef('peak', n.p.midFreq, n.p.midGain, n.p.midQ, sr);
    const c3=shelfPeakCoef('high', n.p.hiFreq, n.p.hiGain, .707, sr);
    for(let i=0;i<BLOCK;i++){
      let x=I.in?I.in[i]:0;
      x=biStep(n.s1,c1,x); x=biStep(n.s2,c2,x); x=biStep(n.s3,c3,x);
      o[i]=x; }
    return {out:o}; },
  draw(n){ n.el.querySelector('.readout').textContent =
    'low '+n.p.loGain.toFixed(1)+' dB · mid '+n.p.midGain.toFixed(1)+' dB · high '+n.p.hiGain.toFixed(1)+' dB'; }});


def({ id:'chorus', title:'Chorus/Flanger/Phaser', cat:'Audio',
  ins:[{n:'in',t:'sig'},{n:'rate',t:'num'},{n:'depth',t:'num'},{n:'mix',t:'num'},{n:'fb',t:'num'}],
  outs:[{n:'out',t:'sig'}], readout:true,
  params:[{n:'mode',t:'select',opts:['chorus','flanger','phaser'],d:'chorus'},
          {n:'rate',t:'range',min:.05,max:10,step:.01,d:.5,log:true,label:'LFO rate, Hz'},
          {n:'depth',t:'range',min:0,max:1,step:.01,d:.5},
          {n:'fb',t:'range',min:-.95,max:.95,step:.01,d:.3,label:'feedback'},
          {n:'stages',t:'range',min:2,max:12,step:2,d:6,label:'stages (phaser)'},
          {n:'mix',t:'range',min:0,max:1,step:.01,d:.5}],
  init:n=>{
    n.line=new Float32Array(Math.round(48000*0.05));   // 50 мс хватает и хорусу, и фленджеру
    n.w=0; n.lph=0; n.ap=[]; n.fbv=0; },
  process(n,I){
    for(const k of ['rate','depth','fb','mix']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const o=buf(n,'out'), sr=Eng.sr, mode=n.p.mode;
    if(mode==='phaser'){
      const ns=n.p.stages;
      if(n.ap.length!==ns) n.ap=Array.from({length:ns},()=>({x1:0,y1:0}));
      for(let i=0;i<BLOCK;i++){
        const xin=I.in?I.in[i]:0;
        n.lph+=n.p.rate/sr; if(n.lph>=1) n.lph-=1;
        const lfo=(Math.sin(2*Math.PI*n.lph)+1)/2;
        const fc=200+n.p.depth*3000*lfo;                // качаем частоту режекции цепочки all-pass
        const w0=Math.tan(Math.PI*fc/sr), a=(w0-1)/(w0+1);
        let v=xin+n.fbv*n.p.fb;
        for(const s of n.ap){ const y=a*v+s.x1-a*s.y1; s.x1=v; s.y1=y; v=y; }
        n.fbv=v;
        o[i]=xin*(1-n.p.mix)+v*n.p.mix; }
    } else {
      const L=n.line.length, flg=mode==='flanger';
      const baseMs=flg?1.5:15, spanMs=flg?4:8;
      for(let i=0;i<BLOCK;i++){
        const xin=I.in?I.in[i]:0;
        n.lph+=n.p.rate/sr; if(n.lph>=1) n.lph-=1;
        const lfo=(Math.sin(2*Math.PI*n.lph)+1)/2;
        const d=(baseMs+n.p.depth*spanMs*lfo)*.001*sr;
        let rp=n.w-d; rp=((rp%L)+L)%L;
        const i0=Math.floor(rp), frac=rp-i0, i1=(i0+1)%L;
        const y=n.line[i0]*(1-frac)+n.line[i1]*frac;
        n.line[n.w]=xin+y*n.p.fb; n.w=(n.w+1)%L;
        o[i]=xin*(1-n.p.mix)+y*n.p.mix; }
    }
    return {out:o}; },
  draw(n){ n.el.querySelector('.readout').textContent = n.p.mode+' · '+n.p.rate.toFixed(2)+' Hz'; }});


def({ id:'pitch', title:'Pitch Shifter', cat:'Audio', ins:[{n:'in',t:'sig'},{n:'semi',t:'num'},{n:'mix',t:'num'}],
  outs:[{n:'out',t:'sig'}], readout:true,
  params:[{n:'semi',t:'range',min:-24,max:24,step:.1,d:0,label:'semitones'},
          {n:'grain',t:'range',min:20,max:200,step:1,d:80,label:'grain, ms'},
          {n:'mix',t:'range',min:0,max:1,step:.01,d:1}],
  init:n=>{n.line=new Float32Array(Math.round(48000*0.5)); n.wp=0; n.ph=[0,.5];},
  process(n,I){
    if(typeof I.semi==='number') setMod(n,'semi',I.semi);
    if(typeof I.mix==='number') setMod(n,'mix',I.mix);
    const o=buf(n,'out'), L=n.line.length, sr=Eng.sr;
    const ratio=Math.pow(2,n.p.semi/12);
    const N=Math.max(8,Math.round(n.p.grain*.001*sr));
    const step=(1-ratio)/N;
    for(let i=0;i<BLOCK;i++){
      const x=I.in?I.in[i]:0;
      n.line[n.wp]=x;
      let y=0;
      for(let g=0;g<2;g++){                            // два зерна в противофазе, кроссфейд треугольным окном
        n.ph[g]+=step; if(n.ph[g]>=1) n.ph[g]-=1; else if(n.ph[g]<0) n.ph[g]+=1;
        const w=1-Math.abs(2*n.ph[g]-1);
        const d=n.ph[g]*N;
        let rp=n.wp-d; rp=((rp%L)+L)%L;
        const i0=Math.floor(rp), frac=rp-i0, i1=(i0+1)%L;
        y += (n.line[i0]*(1-frac)+n.line[i1]*frac)*w; }
      n.wp=(n.wp+1)%L;
      o[i]=x*(1-n.p.mix)+y*n.p.mix; }
    return {out:o}; },
  draw(n){ n.el.querySelector('.readout').textContent =
    n.p.semi.toFixed(1)+' semitones · x'+Math.pow(2,n.p.semi/12).toFixed(3); }});
