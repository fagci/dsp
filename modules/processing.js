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


// Масштаб: range — линейный перевод диапазона (с ограничением и сглаживанием числа); dB offset / linear scale —
// калибровка показаний (сдвиг в дБ или множитель, «взять текущее за эталон»). Работает и с сигналом (in → out), и с числом (num → num).
const scIf=(...ms)=>n=>ms.includes(n.p.mode||'range');
def({ id:'scale', title:'Scale', cat:'Processing', kw:'map range remap normalize calibration offset gain convert units',
  ins:[{n:'in',t:'sig'},{n:'num',t:'num'}], outs:[{n:'out',t:'sig'},{n:'num',t:'num'}], readout:true,
  params:[{n:'mode',t:'select',opts:['range','dB offset','linear scale'],d:'range',label:'range: input span → output span · offset: calibration of readings'},
          {n:'inMin',t:'num',d:0,if:scIf('range')},{n:'inMax',t:'num',d:1,if:scIf('range')},
          {n:'outMin',t:'num',d:0,if:scIf('range')},{n:'outMax',t:'num',d:1,if:scIf('range')},
          {n:'clamp',t:'check',d:true,if:scIf('range')},
          {n:'smooth',t:'range',min:0,max:.99,step:.01,d:0,label:'smoothing (number)',if:scIf('range')},
          {n:'ofs',t:'num',d:0,label:'offset',if:scIf('dB offset','linear scale')},
          {n:'ref',t:'num',d:94,label:'reference value',if:scIf('dB offset','linear scale')},
          {n:'unit',t:'text',d:'dB SPL',label:'units',if:scIf('dB offset','linear scale')},
          {n:'take',t:'button',label:'Take current as reference',if:scIf('dB offset','linear scale'),fn:n=>{
            if(typeof n.raw==='number' && isFinite(n.raw)){
              const v=n.p.mode==='dB offset' ? n.p.ref-n.raw : n.p.ref/(n.raw||1e-9);
              if(n.set && n.set.ofs) n.set.ofs(v); else n.p.ofs=v; } }}],
  init:n=>{ n.sm=0; n.raw=0; n.v=0; n.hasNum=false; },
  process(n,I){
    if(typeof I.clamp==='number') setMod(n,'clamp',I.clamp>=0.5);
    const p=n.p, mode=p.mode||'range', k=(p.outMax-p.outMin)/((p.inMax-p.inMin)||1);
    const lo=Math.min(p.outMin,p.outMax), hi=Math.max(p.outMin,p.outMax);
    const f=mode==='dB offset' ? x=>x+p.ofs : mode==='linear scale' ? x=>x*p.ofs
      : x=>{ const v=p.outMin+(x-p.inMin)*k; return p.clamp ? clamp(v,lo,hi) : v; };
    const o=buf(n,'out');
    for(let i=0;i<BLOCK;i++) o[i]=f(I.in ? I.in[i] : 0);
    n.hasNum=typeof I.num==='number' && isFinite(I.num);
    n.raw=n.hasNum ? I.num : 0;
    let v=f(n.raw);
    if(mode==='range'){ n.sm=n.sm*p.smooth+v*(1-p.smooth); v=n.sm; }
    n.v=v;
    return {out:o, num:v}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    r.textContent = !n.hasNum ? '' : n.p.mode==='range' ? n.v.toFixed(3) : n.v.toFixed(2)+' '+n.p.unit+'  (input '+n.raw.toFixed(2)+')'; }});


// Микшер на 2…12 каналов: уровень (минус — вычитание), панорама и мьют на канал. Панорама — по закону
// равной мощности (sin/cos), не линейная: иначе сигнал в центре звучит тише разведённых по краям.
const MIX_CH=Array.from({length:12},(_,i)=>String.fromCharCode(97+i));   // 'a'..'l'
const MIX_COUNTS=['2','3','4','5','6','7','8','9','10','11','12'];
const MIX_PAN=[-.6,-.2,.2,.6];                       // стартовая панорама первых четырёх; остальные — по центру
const mixN=n=>Math.min(12,Math.max(2,+n.p.channels||4));
function mixResize(n){                               // после смены числа каналов — убрать провода к исчезнувшим портам
  const valid=new Set(portsOf(n,'ins').map(p=>p.n));
  Graph.edges.filter(e=>e.to===n.id && !valid.has(e.tp)).forEach(delEdge);
  rebuildNode(n); markTopoDirty();
}
def({ id:'mixer', title:'Mixer', cat:'Processing', kw:'sum add mix summer channels pan mute level',
  ins:n=>{ const c=MIX_CH.slice(0,mixN(n)); return [...c.map(x=>({n:x,t:'sig'})), ...c.map(x=>({n:'k'+x,t:'num'}))]; },
  outs:[{n:'out',t:'sig'},{n:'L',t:'sig'},{n:'R',t:'sig'}],
  params:[{n:'channels',t:'select',opts:MIX_COUNTS,d:'4',label:'channels',fn:mixResize},
    ...MIX_CH.flatMap((c,i)=>{ const on=n=>i<mixN(n), U=c.toUpperCase();
      return [{n:'k'+c,t:'range',min:-2,max:2,step:.01,d:1,label:U+' level',if:on},
              {n:'p'+c,t:'range',min:-1,max:1,step:.01,d:MIX_PAN[i]??0,label:U+' pan',if:on},
              {n:'m'+c,t:'check',d:false,label:U+' mute',if:on}]; })],
  process(n,I){
    const N=mixN(n), chs=MIX_CH.slice(0,N);
    for(const c of chs) if(typeof I['k'+c]==='number') setMod(n,'k'+c,I['k'+c]);
    const o=buf(n,'out'), oL=buf(n,'L'), oR=buf(n,'R');
    const active=chs.map(c=>{
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
  draw(n){ roText(n,n.stage+' · '+n.lvl.toFixed(1)); }});

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
  ins:[{n:'in',t:'sig'},{n:'fc',t:'num'},{n:'bw',t:'num'},{n:'gain',t:'num'}], outs:[{n:'iq',t:'iq',pair:['I','Q']},{n:'I',t:'sig',hide:true},{n:'Q',t:'sig',hide:true}],
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
  ins:[{n:'iq',t:'iq',pair:['I','Q']},{n:'I',t:'sig',hide:true},{n:'Q',t:'sig',hide:true},{n:'fc',t:'num'}], outs:[{n:'spec',t:'spec'}],
  params:[{n:'fc',t:'range',min:0,max:()=>Eng.sr/2,step:1,d:5000,log:true,label:'carrier (same as iq), Hz'},
          {n:'dec',t:'select',opts:['1','2','4','8','16','32','64'],d:'8',label:'decimation'},
          {n:'size',t:'select',opts:['256','512','1024','2048','4096','8192','16384'],d:'2048'},
          {n:'win',t:'select',opts:WINDOW_KINDS,d:'hann'}],
  init:n=>{ n.N=0; n.gi=0; n.absPos=0; n.lpDec=0; },
  process(n,I){
    const dec=Math.max(1,+n.p.dec||1), N=Math.max(+n.p.size,8);
    if(n.N!==N||n.wk!==n.p.win){
      n.N=N; n.wk=n.p.win;
      n.ringI=new Float32Array(N); n.ringQ=new Float32Array(N);
      n.re=new Float32Array(N); n.im=new Float32Array(N);
      n.mag=new Float32Array(N); n.freqs=new Float64Array(N); n.phase=new Float32Array(N);
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


def({ id:'polar', title:'Magnitude/Phase (I/Q → polar)', cat:'Processing', ins:[{n:'iq',t:'iq',pair:['I','Q']},{n:'I',t:'sig',hide:true},{n:'Q',t:'sig',hide:true}],
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
  outs:[{n:'iq',t:'iq',pair:['I','Q']},{n:'I',t:'sig',hide:true},{n:'Q',t:'sig',hide:true}],
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
def({ id:'xyscope', lazy:'proc', title:'Phase Scope (X-Y)', cat:'Analysis', ins:[{n:'x',t:'sig'},{n:'y',t:'sig'}],
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
    cx.fillStyle=themeRgba('--screen',1-n.p.persist);                  // не clearRect — точки оставляют след
    cx.fillRect(0,0,W,plotH);
    const cxm=W/2, cym=plotH/2, s=Math.min(W,plotH)/2*0.9*n.p.gain;
    cx.strokeStyle=themeRgba('--scr-hi',.06); cx.lineWidth=1;
    cx.beginPath(); cx.moveTo(0,cym); cx.lineTo(W,cym); cx.moveTo(cxm,0); cx.lineTo(cxm,plotH); cx.stroke();
    const x=n._x, y=n._y;
    if(x&&y){
      cx.fillStyle=themeColor('--t-img');
      for(let i=0;i<x.length;i+=2){                                  // через сэмпл — экономим отрисовку
        const px=cxm+clamp(x[i],-2,2)*s, py=cym-clamp(y[i],-2,2)*s;
        cx.fillRect(px,py,1.4,1.4); } }
    cx.fillStyle=themeColor('--screen'); cx.fillRect(0,plotH,W,MH);
    const half=W/2, mx=half+n.corr*half;
    cx.fillStyle=themeRgba('--scr-hi',.08); cx.fillRect(0,plotH+2,W,MH-4);
    cx.fillStyle = n.corr<0 ? themeColor('--err') : themeColor('--t-blk');
    cx.fillRect(Math.min(half,mx),plotH+2,Math.abs(mx-half),MH-4);
    cx.strokeStyle=themeRgba('--scr-hi',.3);
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
def({ id:'sonar', lazy:'proc', title:'Monostatic Sonar (chirp)', cat:'Radar', ins:[{n:'in',t:'sig'}],
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


const fftLow=n=>n.p.band==='low frequency';
def({ id:'fft', title:'FFT', cat:'Processing', kw:'spectrum low frequency infrasound slow decimate', ins:[{n:'in',t:'sig'}], outs:[{n:'spec',t:'spec'}],
  readout:true,
  params:[{n:'band',t:'select',opts:['audio','low frequency'],d:'audio',label:'audio: spectrum of the whole band · low frequency: decimates first, for infrasound and slow processes'},
          {n:'size',t:'select',opts:['256','512','1024','2048','4096','8192','16384','32768','65536'],d:'2048'},
          {n:'win',t:'select',opts:WINDOW_KINDS,d:'hann'},
          {n:'fs',t:'select',opts:['16','32','64','128','256','512','1024'],d:'64',label:'decimate to, Hz',if:fftLow},
          {n:'upd',t:'select',opts:['0.05','0.1','0.2','0.5','1','2'],d:'0.1',label:'update every, s',if:fftLow},
          {n:'avg',t:'select',opts:['off','1','3','10','30','100','300','inf'],d:'3',label:'averaging, s',if:fftLow},
          {n:'clr',t:'button',label:'Reset average',if:fftLow,fn:n=>{ const L=n.lf; if(L){ L.avgN=0; L.pw?.fill(0); } }}],
  init:n=>{n.N=0;},
  process(n,I){
    if(fftLow(n)){                                 // низкочастотный режим — своё состояние в n.lf
      const L=n.lf||(n.lf={key:''}); L.p=n.p;
      const r=lfftRun(L,I); roText(n,lfftText(L)); return r; }
    const N=Math.max(+n.p.size, BLOCK*2);          // окно не короче блока
    if(n.N!==N||n.wk!==n.p.win){ n.N=N; n.wk=n.p.win; n.ring=new Float32Array(N);
      n.xw=new Float32Array(N); n.zr=new Float32Array(N/2); n.zi=new Float32Array(N/2);
      n.re=new Float32Array(N/2); n.im=new Float32Array(N/2); n.mag=new Float32Array(N/2);
      n.phase=new Float32Array(N/2); n.phRev=-1; n.psd=new Float32Array(N/2);
      n.w=window_(n.p.win,N);
      let sum=0, sum2=0; for(let i=0;i<N;i++){ sum+=n.w[i]; sum2+=n.w[i]*n.w[i]; }
      n.wGain=sum;                                  // когерентное усиление окна — для верной абс. амплитуды
      n.wGain2=sum2; }                               // энергия окна — для верной СПМ (Вт/Гц), другая нормировка
    n.ring.copyWithin(0,BLOCK); // сдвиг окна на блок
    for(let i=0;i<BLOCK;i++) n.ring[N-BLOCK+i]=I.in?I.in[i]:0;
    for(let i=0;i<N;i++) n.xw[i]=n.ring[i]*n.w[i];
    rfft(n.xw,n.zr,n.zi,n.re,n.im);
    // СПМ (одностороння): |X|²·2/(sr·Σw²) — не путать с амплитудой (|X|·2/Σw): у СПМ своя
    // нормировка на полосу (Гц), из-за неё шумовой пол не зависит от размера окна, у амплитуды
    // такой независимости нет и не должно быть (амплитуда тона — просто амплитуда тона).
    const psdNorm=1/(Eng.sr*n.wGain2);
    // Math.hypot в V8 на порядок медленнее sqrt
    const re=n.re, im=n.im, mag=n.mag, psd=n.psd, g=1/n.wGain;
    const p0=re[0]*re[0]+im[0]*im[0];
    mag[0]=Math.sqrt(p0)*g;                         // DC без ×2 — нет зеркальной составляющей
    psd[0]=p0*psdNorm;
    for(let i=1;i<N/2;i++){
      const p=re[i]*re[i]+im[i]*im[i];
      mag[i]=2*Math.sqrt(p)*g; psd[i]=2*p*psdNorm; }
    if(!n.sp){
      // фаза нужна редко (маркеры SA) — считается при первом обращении в этом блоке
      n.sp={};
      Object.defineProperty(n.sp,'phase',{enumerable:true, get(){
        if(n.phRev!==n.sp.rev){ n.phRev=n.sp.rev; const ph=n.phase; ph[0]=0;
          for(let i=1;i<ph.length;i++) ph[i]=Math.atan2(n.im[i],n.re[i]); }
        return n.phase; }});
    }
    n.sp.mag=n.mag; n.sp.psd=n.psd; n.sp.hop=BLOCK;
    n.sp.sr=Eng.sr; n.sp.size=N; n.sp.freqs=null;
    n.sp.rev=(n.sp.rev|0)+1;                        // счётчик пересчётов — объект переиспользуется, ссылка не меняется
    return {spec:n.sp}; }});


// Низкочастотный спектр: у 'fft' на частоте движка даже 65536 точек дают бин ~0.7 Гц.
// Здесь вход прореживается до fs: среднее по D1 отсчётам до 16·fs, затем КИХ (Блэкман,
// срез 0.45·fs) с шагом 16. Реальная fs = sr/(16·D1) — ось спектра по ней, а не по заказанной.
// Спектр — по Уэлчу: окно N пересчитывается каждые upd секунд независимо от его длины (иначе
// длинное окно обновляется раз в секунды), среднее вычитается (гравитация/постоянка иначе
// растекается по соседним бинам), мощность усредняется экспоненциально (avg, с) или накопительно.
// Пока окно не заполнено, считается по уже накопленной части — картинка есть сразу.
// Верхние ~20% диапазона (выше 0.4·fs) — переходная полоса фильтра.
const LFFT_R=16, LFFT_TAPS=LFFT_R*48;
function lfftSetup(n){
  const sr=Eng.sr, fs=+n.p.fs, N=+n.p.size;
  n.D1=Math.max(1,Math.round(sr/(LFFT_R*fs))); n.fs=sr/(LFFT_R*n.D1);
  const h=new Float32Array(LFFT_TAPS), fc=.45/LFFT_R, M=LFFT_TAPS-1; let s=0;
  for(let i=0;i<LFFT_TAPS;i++){ const x=i-M/2;
    const sinc=x===0?2*fc:Math.sin(2*Math.PI*fc*x)/(Math.PI*x);
    const w=.42-.5*Math.cos(2*Math.PI*i/M)+.08*Math.cos(4*Math.PI*i/M);
    h[i]=sinc*w; s+=h[i]; }
  for(let i=0;i<LFFT_TAPS;i++) h[i]/=s;
  n.h=h; n.fr=new Float64Array(LFFT_TAPS); n.fw=0; n.fk=0;   // кольцо 16·fs и счётчик до выхода
  n.acc=0; n.accN=0; n.primed=false;
  n.N=N; n.ring=new Float64Array(N); n.rw=0; n.filled=0; n.since=0;
  n.re=new Float32Array(N); n.im=new Float32Array(N);
  n.pw=new Float64Array(N/2); n.avgN=0;
  n.mag=new Float32Array(N/2); n.phase=new Float32Array(N/2); n.psd=new Float32Array(N/2);
  n.w=window_(n.p.win,N);
  let g=0,g2=0; for(let i=0;i<N;i++){ g+=n.w[i]; g2+=n.w[i]*n.w[i]; }
  n.wGain=g; n.wGain2=g2;
  n.key=[sr,n.p.fs,n.p.size,n.p.win].join();
  n.sp=null;
}
function lfftFrame(n,hop){
  const N=n.N, re=n.re, im=n.im, r=n.ring, F=n.filled, i0=N-F; let mean=0;
  for(let i=i0;i<N;i++) mean+=r[(n.rw+i)%N];
  mean/=F;
  for(let i=0;i<N;i++){ re[i]=i<i0?0:(r[(n.rw+i)%N]-mean)*n.w[i]; im[i]=0; }
  fft(re,im);
  const av=n.p.avg, Kmax=Math.max(1,Math.round(+av*n.fs/hop));   // avg — в секундах
  const K=av==='off'?1:av==='inf'?++n.avgN:Math.min(++n.avgN,Kmax), a=1/K;
  let g=n.wGain;                                    // неполное окно — приводим к полному по амплитуде
  if(i0){ g=0; for(let i=i0;i<N;i++) g+=n.w[i]; }
  const psdNorm=1/(n.fs*n.wGain2), sc=n.wGain/g;
  for(let i=0;i<N/2;i++){
    const p=re[i]*re[i]+im[i]*im[i];
    n.pw[i]=K===1?p*sc*sc:n.pw[i]+(p*sc*sc-n.pw[i])*a;
    const k=i?2:1;
    n.mag[i]=k*Math.sqrt(n.pw[i])/n.wGain; n.psd[i]=k*n.pw[i]*psdNorm;
    n.phase[i]=i?Math.atan2(im[i],re[i]):0; }
  const sp=n.sp||(n.sp={});
  sp.mag=n.mag; sp.phase=n.phase; sp.psd=n.psd; sp.hop=hop; sp.sr=n.fs; sp.size=N; sp.freqs=null;
  sp.rev=(sp.rev|0)+1;
}
// Режим low frequency у FFT: децимация до fs и спектр инфразвука/медленных процессов. Состояние живёт в n.lf,
// чтобы не пересекаться с полями обычного режима; параметры (fs, size, win, upd, avg) — общие с узлом.
function lfftRun(n,I){
    if(n.key!==[Eng.sr,n.p.fs,n.p.size,n.p.win].join()) lfftSetup(n);
    const x=I.in, D1=n.D1, h=n.h, fr=n.fr, N=n.N, hop=Math.max(1,Math.min(N,Math.round(+n.p.upd*n.fs)));
    for(let i=0;i<BLOCK;i++){
      n.acc+=x?x[i]:0;
      if(++n.accN<D1) continue;
      if(!n.primed){ fr.fill(n.acc/D1); n.primed=true; }   // иначе скачок от нуля до постоянки — ложный НЧ-пик
      fr[n.fw]=n.acc/D1; n.fw=(n.fw+1)%LFFT_TAPS; n.acc=0; n.accN=0;
      if(++n.fk<LFFT_R) continue;
      n.fk=0;
      let y=0;                                      // свёртка только в момент выходного отсчёта
      for(let k=0,j=n.fw;k<LFFT_TAPS;k++){ y+=h[k]*fr[j]; if(++j===LFFT_TAPS) j=0; }
      n.ring[n.rw]=y; n.rw=(n.rw+1)%N;
      if(n.filled<N) n.filled++;
      if(n.filled>=Math.min(N,32) && ++n.since>=hop){ n.since=0; lfftFrame(n,hop); }
    }
  return {spec:n.sp};
}
function lfftText(n){
  if(!n.fs) return '';
  const win=n.N/n.fs;
  return `fs ${n.fs.toFixed(2)} Hz · Δf ${(n.fs/n.N).toFixed(4)} Hz · window ${win<120?win.toFixed(1)+' s':(win/60).toFixed(1)+' min'}`+
    (n.filled<n.N?` · filling ${Math.round(n.filled/n.N*100)}%`:'')+
    (n.p.avg==='inf'?` · avg ${n.avgN} frames`:'');
}

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


// QR и штрихкоды из кадра через BarcodeDetector (Chrome/Android); где его нет — только QR через jsQR (qr.js). Асинхронно, не чаще period
def({ id:'barcode', lazy:'proc', title:'Barcode / QR', cat:'Video',
  ins:[{n:'img',t:'img'}],
  outs:[{n:'text',t:'txt'},{n:'go',t:'num'},{n:'rec',t:'rec'},{n:'count',t:'num'}],
  readout:true,
  params:[{n:'period',t:'range',min:.1,max:5,step:.1,d:.5,label:'scan every, s'},
          {n:'dup',t:'range',min:0,max:30,step:1,d:3,label:'ignore repeat, s'}],
  init:n=>{ n.det=null; n.busy=false; n.lastT=0; n.lastRev=-1; n.text=''; n.q=[]; n.count=0; n.seen=new Map();
    n.status=typeof BarcodeDetector==='undefined' ? 'no BarcodeDetector in this browser: QR codes only' : 'waiting for a frame'; },
  process(n,I){
    const now=performance.now();
    if(I.img && !I.img.gray && !n.busy && now-n.lastT>=n.p.period*1000 && I.img.rev!==n.lastRev){
      n.lastT=now; n.lastRev=I.img.rev; n.busy=true;
      (typeof BarcodeDetector!=='undefined' ? (n.det||=new BarcodeDetector()).detect(I.img.data)
        : qrScanFrame(I.img.data).then(v=>v ? [{format:'qr_code',rawValue:v}] : [])).then(res=>{
        const t=Date.now(); n.status=res.length ? res.length+' found' : 'no code in frame';
        for(const b of res){
          const k=b.format+'|'+b.rawValue, prev=n.seen.get(k);
          if(prev && t-prev<n.p.dup*1000){ n.seen.set(k,t); continue; }
          n.seen.set(k,t); n.count++;
          n.q.push({t, src:'barcode', format:b.format, value:b.rawValue}); }
      }).catch(e=>{ n.status='error: '+e.message; }).finally(()=>{ n.busy=false; });
    }
    let go=0; const rec=n.q.length ? n.q.splice(0) : null;
    if(rec){ n.text=rec[rec.length-1].value; go=1; }
    return {text:n.text, go, rec, count:n.count}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.status+(n.text?'\n'+n.text.slice(0,300):''); }});


def({ id:'bright', lazy:'proc', title:'Region Brightness', cat:'Video',
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


def({ id:'capture', lazy:'proc', title:'Capture & Loop', cat:'Processing',
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
            if(n.snap) wavDownload([n.snap],Eng.sr,'capture-'+recStamp()+'.wav'); }}],
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




def({ id:'nlms', lazy:'proc', title:'Adaptive Filter', cat:'Processing',
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


// Частоты наводок: сеть 50/60 Гц, ж/д 16.7 Гц, бортсеть 400 Гц; custom — поле f0
const HUM_PRESETS=['50','60','16.7','25','400','custom'];
const humPreset=n=>{ if(n.p.preset!=='custom') setMod(n,'f0',+n.p.preset); };

// Адаптивное вычитание гармоник: опорные cos/sin k·φ от своего генератора, веса по МНК —
// вычитается только сама наводка (амплитуда/фаза каждой гармоники), сигнал между гармониками
// не трогается. Частота генератора подстраивается по вращению фазора основной гармоники (FLL),
// поэтому режекция остаётся глубокой при уходе сети на ±0.1…0.5 Гц.
// Автонотч: NLMS-предсказатель с задержкой. Периодическое (несущие, свисты, гетеродины) предсказуемо
// и вычитается, речь и шум с задержкой почти не коррелируют и проходят в ошибке предсказания.
const ANF_N=64, ANF_D=24;
def({ id:'anf', title:'Auto Notch (NLMS)', cat:'Processing',
  ins:[{n:'in',t:'sig'}], outs:[{n:'out',t:'sig'},{n:'tones',t:'sig'}],
  params:[{n:'mu',t:'range',min:.001,max:.1,step:.001,d:.01,log:true,label:'adaptation speed'},
          {n:'on',t:'check',d:true,label:'on'}],
  init:n=>{ const L=ANF_N+ANF_D+1; n.w=new Float32Array(ANF_N); n.sx=new Float32Array(2*L); n.L=L; n.pos=0; n.pw=0; },
  process(n,I){
    const o=buf(n,'out'), t=buf(n,'tones'), x=n.sx, w=n.w, L=n.L, mu=n.p.mu, lk=1-1e-5;
    if(!I.in){ o.fill(0); t.fill(0); return {out:o, tones:t}; }
    for(let i=0;i<BLOCK;i++){
      const v=I.in[i];
      n.pos=n.pos===0 ? L-1 : n.pos-1;                // x[pos+j] — отсчёт j шагов назад
      const p=n.pos; x[p]=v; x[p+L]=v;
      const xin=x[p+ANF_D], xout=x[p+ANF_D+ANF_N];
      n.pw+=xin*xin-xout*xout; if(n.pw<0) n.pw=0;
      let y=0;
      for(let k=0;k<ANF_N;k++) y+=w[k]*x[p+ANF_D+k];
      const e=v-y, g=mu*e/(n.pw+1e-9);
      for(let k=0;k<ANF_N;k++) w[k]=w[k]*lk+g*x[p+ANF_D+k];
      o[i]=n.p.on ? e : v; t[i]=y;
    }
    return {out:o, tones:t};
  }});
// Гребенчатый режектор: H(z)=(1+ρ)/2·(1−z^−D)/(1−ρ·z^−D), D=fs/f0 (дробная — линейная
// интерполяция). Режет все кратные f0 до Найквиста сразу и почти ничего не стоит, но режет
// и DC, и не подстраивается сам — f0 можно завести с выхода freq у самого узла в режиме adaptive.
function humComb(n,I){
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
  n.wi=wi; n.f=f0;
  return {out:o, hum:null, freq:f0, level:null};
}
def({ id:'humcancel', title:'Hum Filter', cat:'Processing', kw:'mains notch comb 50 60 hz interference harmonics adaptive',
  ins:[{n:'in',t:'sig'},{n:'f0',t:'num'},{n:'n',t:'num'},{n:'bw',t:'num'}],
  outs:[{n:'out',t:'sig'},{n:'hum',t:'sig'},{n:'freq',t:'num'},{n:'level',t:'num'}],
  readout:true,
  params:[{n:'mode',t:'select',opts:['adaptive','comb'],d:'adaptive',label:'adaptive: subtracts the hum and tracks its frequency · comb: fixed filter on all harmonics, almost free'},
          {n:'preset',t:'select',opts:HUM_PRESETS,d:'50',label:'interference',fn:humPreset},
          {n:'f0',t:'range',min:5,max:1000,step:.01,d:50,log:true,label:'fundamental, Hz'},
          {n:'n',t:'range',min:1,max:60,step:1,d:20,label:'harmonics',if:n=>n.p.mode!=='comb'},
          {n:'bw',t:'range',min:.05,max:20,step:.05,d:1,log:true,label:'notch width, Hz (speed)'},
          {n:'track',t:'check',d:true,label:'track frequency',if:n=>n.p.mode!=='comb'},
          {n:'range',t:'range',min:.1,max:5,step:.1,d:1,label:'tracking range, ±Hz',adv:true,if:n=>n.p.mode!=='comb'},
          {n:'rst',t:'button',label:'Reset',fn:n=>{ n.a=null; },if:n=>n.p.mode!=='comb'}],
  init:n=>{ n.a=null; n.ph=0; n.f=null; n.fKey=null; n.th=null; n.lvl=-200; n.red=0; n.N=0; },
  process(n,I){
    if(n.p.mode==='comb') return humComb(n,I);
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
    if(n.p.mode==='comb') return roText(n, `${(+n.f||0).toFixed(1)} Hz · comb`);
    roText(n, n.K ? `${n.f.toFixed(1)} Hz · ${n.K} harm · hum ${Math.round(n.lvl)} dBFS · reduction ${Math.round(Math.max(0,n.red))} dB`
      : 'no signal'); }});

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

// Контракт spec.chans (rtlsdr, OpenWebRX): список каналов приёмника. Поля: idx 0–3 (номер маркера, он же цвет),
// f (частота настройки), lo/hi (края полосы, Гц), mode ('USB', 'LSB', 'NFM'…); необязательные — rssi, snr,
// sql, sqOpen, thrDb, lvDb. Запись без конечных lo<hi или с idx вне 0–3 пропускается здесь, остальной код
// берёт каналы только отсюда. Рядом в spec: pickBw {mode,pass} — полоса подсказки, setChanBw(mode,w) — правка края.
function saChans(n){
  const l=n.s&&n.s.chans; if(!l||!l.length) return null;
  const ok=l.filter(c=>c && Number.isFinite(c.lo) && Number.isFinite(c.hi) && c.hi>c.lo && Number.isFinite(c.f) && c.idx>=0 && c.idx<4);
  return ok.length ? ok : null;
}
// Шторки каналов приёмника (spec.chans от rtlsdr): полоса канального фильтра ПЧ вокруг частоты
// каждого канала, цветом маркера с тем же номером. Подпись (режим и ширина) — отдельным проходом
// saChannelLabels, после маркеров, чтобы линия маркера её не перекрывала.
function saChannels(n,cx,W,H,plotH){
  const list=saChans(n); if(!list) return;
  const TOP=Math.max(16,n._topH||0);
  const yDb=db=>plotH-clamp((db-n.p.floor)/((n.p.top-n.p.floor)||1),0,1)*(plotH-2)-1;
  for(const c of list){
    const x1=saPos(n,c.lo)*W, x2=saPos(n,c.hi)*W;
    if(x2<0||x1>W) continue;
    const col=MK_COL(c.idx);
    cx.globalAlpha=.08; cx.fillStyle=col; cx.fillRect(x1,TOP,Math.max(1,x2-x1),H-TOP);
    cx.globalAlpha=.9; cx.strokeStyle=col; cx.lineWidth=1;
    const e1=Math.round(x1)+.5, e2=Math.round(x2)-.5;
    cx.beginPath(); cx.moveTo(e1,TOP); cx.lineTo(e1,H); cx.moveTo(e2,TOP); cx.lineTo(e2,H); cx.stroke();
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
// Подсказка будущего маркера под курсором: линия на (привязанной к сетке band plan) частоте и,
// если источник знает полосу канала (spec.pickBw), приглушённая полоса BW — по спектру и водопаду.
function saHover(n,cx,W,H,top){
  const x=n._hoverX; if(x==null||!n.s||n._dragActive) return;
  const f=saSnapFreq(n,saFreq(n,x)), pb=n.s.pickBw;
  let lo=f, hi=f;
  if(pb){ lo=pb.mode==='USB'?f:f-pb.pass; hi=pb.mode==='LSB'?f:f+pb.pass; }
  const x1=saPos(n,lo)*W, x2=saPos(n,hi)*W, xc=saPos(n,f)*W, col=MK_COL(n.active-1);
  cx.save();
  if(x2-x1>=1){ cx.globalAlpha=.07; cx.fillStyle=col; cx.fillRect(x1,top,x2-x1,H-top); }
  cx.globalAlpha=.35; cx.strokeStyle=col; cx.lineWidth=1;
  cx.beginPath();
  if(x2-x1>=3){ cx.moveTo(Math.round(x1)+.5,top); cx.lineTo(Math.round(x1)+.5,H); cx.moveTo(Math.round(x2)-.5,top); cx.lineTo(Math.round(x2)-.5,H); }
  cx.setLineDash([3,3]); cx.moveTo(Math.round(xc)+.5,top); cx.lineTo(Math.round(xc)+.5,H); cx.stroke();
  cx.restore();
}
// Auto диапазона дБ: пол — низкий перцентиль видимой части спектра, потолок — максимум
function saAutoDb(n){
  const sp=n.s; if(!sp||!sp.mag||n.p.layout==='panes') return;
  const [lo,hi]=saBounds(n), N=sp.mag.length;
  let a=clamp(Math.floor(specBin(sp,lo)),0,N-1), b=clamp(Math.ceil(specBin(sp,hi)),0,N-1);
  if(b<a){ const t=a; a=b; b=t; }
  const st=Math.max(1,Math.floor((b-a+1)/2000)), v=[];
  for(let i=a;i<=b;i+=st) v.push(20*Math.log10(sp.mag[i]+1e-12));
  if(n.p.peakHold && n.peak && n.peak.length===N) for(let i=a;i<=b;i+=st) v.push(20*Math.log10(n.peak[i]+1e-12));
  if(!v.length) return;
  v.sort((p,q)=>p-q);
  const fl=Math.floor((v[Math.floor(v.length*.05)]-8)/5)*5, tp=Math.ceil((v[v.length-1]+6)/5)*5;
  const floor=clamp(fl,-140,0), top=clamp(Math.max(tp,floor+20),floor+20,20);
  setMod(n,'floor',floor); setMod(n,'top',top);
}
// Время строк водопада: spec.tl (отсчёты таймлайна источника) на каждую новую строку, новые в конце.
// Нужно для наложения аннотаций IQ (spec.ann: {a0,a1,lo,hi,label,mark}); возраст строки a — T[T.length-1-a].
function saWfStamp(n){
  const C=n._wfC||(n._wfC=[]);                        // настенные часы строк (мс) — для меток и тиков по времени
  C.push(Date.now()); if(C.length>6144) C.splice(0, 2048);
  const tl=n.s.tl;
  if(tl==null){ n._wfT=null; return; }
  const T=n._wfT||(n._wfT=[]);
  if(T.length && tl<T[T.length-1]) T.length=0;        // перемотка назад — прежние строки уже не сопоставить
  T.push(tl);
  if(T.length>6144) T.splice(0, 2048);
}
// T[i] >= v, i в [a,b+1]
function saWfLower(T,v,a,b){ let l=a, h=b+1; while(l<h){ const m=(l+h)>>1; if(T[m]<v) l=m+1; else h=m; } return l; }
function saAnnot(n,cx,W,hs,hw,dpr){
  const sp=n.s, T=n._wfT, list=sp&&sp.ann;
  if(!list || !list.length || !T || !T.length) return;
  const rows=Math.min(T.length, Math.round(hw*dpr)), last=T.length-1, first=last-rows+1, win=sp.size||0;
  const tA=T[first], tB=T[last];
  cx.save(); cx.beginPath(); cx.rect(0,hs,W,hw); cx.clip();
  cx.font='10px monospace'; cx.lineWidth=1;
  for(const a of list){
    if(a.a1+win<tA || a.a0>tB) continue;
    const i0=saWfLower(T,a.a0,first,last), i1=saWfLower(T,a.a1+win+1,first,last)-1;
    if(i1<i0) continue;
    let x1=saPos(n,a.lo)*W, x2=saPos(n,a.hi)*W;
    if(x2<0 || x1>W) continue;
    if(x2-x1<3){ const c=(x1+x2)/2; x1=c-1.5; x2=c+1.5; }
    const y=hs+(last-i1)/dpr, h=Math.max(2,(i1-i0+1)/dpr), col=themeColor(a.mark ? '--t-img' : '--hi');
    cx.globalAlpha=.12; cx.fillStyle=col; cx.fillRect(x1,y,x2-x1,h);
    cx.globalAlpha=.9; cx.strokeStyle=col; cx.setLineDash(a.mark ? [] : [4,3]);
    cx.strokeRect(Math.round(x1)+.5,Math.round(y)+.5,Math.max(1,x2-x1),h);
    if(a.label && h>=12){
      const tw=Math.ceil(cx.measureText(a.label).width)+6, lx=Math.max(1,Math.min(W-tw-1,x1)), ly=Math.max(hs,y);
      cx.setLineDash([]); cx.globalAlpha=.75; cx.fillStyle=themeColor('--screen'); cx.fillRect(lx,ly,tw,12);
      cx.globalAlpha=1; cx.fillStyle=col; cx.fillText(a.label,lx+3,ly+10);
    }
  }
  cx.restore();
}
// Пользовательские метки на водопаде ({t0,t1,lo,hi,label}, время — мс) и тики по таймеру.
// Метка привязана ко времени строк (n._wfC), поэтому едет вместе с водопадом.
function saRowTime(n,cv,y){                           // y — координата канвы → время строки (мс)
  const C=n._wfC; if(!C||!C.length) return null;
  const dpr=(cv.pxW&&cv.width)?cv.pxW/cv.width:1, hs=n._hs|0, hw=cv.height-hs;
  const rows=Math.min(C.length, Math.round(hw*dpr));
  return rows>0 ? C[C.length-1-clamp(Math.round((y-hs)*dpr),0,rows-1)] : null;
}
function saMarkColor(label){
  let h=0; for(let i=0;i<label.length;i++) h=(h*31+label.charCodeAt(i))%360;
  return 'hsl('+h+',70%,60%)';
}
function saUserMarks(n,cx,W,hs,hw,dpr){
  const C=n._wfC; n._umBoxes=[];
  if(!C||!C.length) return;
  const rows=Math.min(C.length, Math.round(hw*dpr)), last=C.length-1, first=last-rows+1;
  if(rows<1) return;
  const tA=C[first], tB=C[last], yOf=i=>hs+(last-i)/dpr;
  cx.save(); cx.beginPath(); cx.rect(0,hs,W,hw); cx.clip();
  cx.font='9px monospace'; cx.lineWidth=1;
  const step=(+n.p.tickSec||0)*1000;
  if(step>0 && tB-tA<step*400){
    const ink=themeColor('--scr-hi')||'#fff', bg=themeColor('--screen')||'#000';
    for(let t=Math.ceil(tA/step)*step; t<=tB; t+=step){
      const y=Math.round(yOf(saWfLower(C,t,first,last)))+.5;
      cx.globalAlpha=.55; cx.strokeStyle=bg; cx.beginPath(); cx.moveTo(0,y+1); cx.lineTo(W,y+1); cx.stroke();      // тёмная кромка — линия видна и на светлом водопаде
      cx.globalAlpha=.9; cx.strokeStyle=ink; cx.setLineDash([3,3]); cx.beginPath(); cx.moveTo(0,y); cx.lineTo(W,y); cx.stroke(); cx.setLineDash([]);
      const lb=new Date(t).toLocaleTimeString([], {hour12:false}), tw=Math.ceil(cx.measureText(lb).width)+6;
      cx.globalAlpha=.8; cx.fillStyle=bg; cx.fillRect(W-tw-1,y-11,tw,11);
      cx.globalAlpha=1; cx.fillStyle=ink; cx.fillText(lb,W-tw+2,y-2);
    }
    cx.globalAlpha=1;
  }
  const list=n._umDrag ? [...(n.userMarks||[]), n._umDrag] : (n.userMarks||[]);
  for(const m of list){
    const ta=Math.min(m.t0,m.t1), tb=Math.max(m.t0,m.t1);
    if(tb<tA || ta>tB) continue;
    const i0=saWfLower(C,ta,first,last);
    if(i0>last) continue;
    const i1=Math.max(i0, saWfLower(C,tb+1,first,last)-1);
    const col=m.color || (m.label ? saMarkColor(m.label) : themeColor('--hi'));
    const y=yOf(i1), h=Math.max(2,(i1-i0+1)/dpr), txt=m.label || new Date(m.t0).toLocaleTimeString([], {hour12:false});
    let x1=0, x2=W;
    if(!m.full){
      x1=saPos(n,m.lo)*W; x2=saPos(n,m.hi)*W; if(x1>x2){ const t=x1; x1=x2; x2=t; }
      if(x2<0||x1>W) continue;
      if(x2-x1<3){ const c=(x1+x2)/2; x1=c-1.5; x2=c+1.5; }
    }
    cx.setLineDash(m===n._umDrag?[4,3]:[]); cx.strokeStyle=col;
    if(m.full){                                   // без диапазона — линия во всю ширину
      const yy=Math.round(y+h/2)+.5;
      cx.globalAlpha=.9; cx.beginPath(); cx.moveTo(0,yy); cx.lineTo(W,yy); cx.stroke();
    } else {
      cx.globalAlpha=.14; cx.fillStyle=col; cx.fillRect(x1,y,x2-x1,h);
      cx.globalAlpha=.95; cx.strokeRect(Math.round(x1)+.5,Math.round(y)+.5,Math.max(1,x2-x1),h);
    }
    if(txt){
      const tw=Math.ceil(cx.measureText(txt).width)+6, lx=Math.max(1,Math.min(W-tw-1,x1)), ly=Math.max(hs,m.full?y+h/2-11:y);
      cx.setLineDash([]); cx.globalAlpha=.8; cx.fillStyle=themeColor('--screen'); cx.fillRect(lx,ly,tw,12);
      cx.globalAlpha=1; cx.fillStyle=col; cx.fillText(txt,lx+3,ly+9);
    }
    if(m!==n._umDrag) n._umBoxes.push({x0:x1,x1:x2,y0:y,y1:y+h,m});
  }
  cx.restore();
}
// канал приёмника, на частоте которого стоит маркер (маркер ведёт tuneFreq канала)
function saChanAtMarker(n,f){
  const list=saChans(n); if(!list||f==null) return null;
  const tol=Math.max(1, Math.abs(specHz(n.s,1)-specHz(n.s,0))/2);
  return list.find(c=>Math.abs(c.f-f)<=tol) || null;
}
// подпись на плашке цвета канала; не влезает в шторку — выносим вбок от неё
function saChannelLabels(n,cx,W){
  const list=saChans(n); if(!list) return;
  cx.font=BP_FONT;
  const used=[...(n._sgRects||[])];                 // метки сигналов уже стоят — подписи каналов обходят их
  for(const c of list){
    const x1=saPos(n,c.lo)*W, x2=saPos(n,c.hi)*W;
    if(x2<0||x1>W) continue;
    const col=MK_COL(c.idx), bw=c.hi-c.lo, t=c.mode+' '+fmtHz(bw, bw%1000?1:0)+(c.sql ? (c.sqOpen?' SQL open':' SQL closed') : '');
    const tw=Math.ceil(cx.measureText(t).width);
    let tx=(x1+x2-tw)/2;
    if(x2-x1<tw+8) tx = x2+4+tw<=W ? x2+4 : x1-tw-4;
    tx=clamp(Math.round(tx), 3, W-tw-3);
    let ty=Math.max(16,n._topH||0)+4+c.idx*15;
    for(let k=0;k<8 && used.some(u=>tx-3<u.x+u.w && tx+tw+3>u.x && ty<u.y+u.h && ty+14>u.y);k++) ty+=15;
    used.push({x:tx-3,y:ty,w:tw+6,h:14});
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
// фильтр записей band plan (параметр bandFilter): остаются те, где в имени, kind или note есть любое из слов
function saBandFilter(n){
  const ft=String(n.p.bandFilter||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
  return b=>!ft.length || ft.some(w=>(String(b.label||'')+' '+(b.kind||'')+' '+(b.note||'')).toLowerCase().includes(w));
}
function saBandPlan(n,cx,W,H,plotH){
  const list=n.bandsData;
  const bpBoxes=n._bpBoxes=(n._bpBoxes||[]); bpBoxes.length=0;
  n._topH=4; n._bpH=0; n._bpAll=[];
  if(!list||!list.length){ if(n._bmBoxes) n._bmBoxes.length=0; if(n._bpLabels) n._bpLabels.length=0; return; }
  const [lo0,hi0]=saBounds(n);
  const ranges=[], points=[];
  const pass=saBandFilter(n);
  const labels=n._bpLabels=(n._bpLabels||[]); labels.length=0;   // подписи полос — рисует saBandPlanLabels поверх маркеров
  for(const b of list){
    if(!b || b.sig || typeof b.lo!=='number' || isNaN(b.lo) || !pass(b)) continue;
    const hi=(typeof b.hi==='number' && !isNaN(b.hi)) ? b.hi : b.lo;
    if(hi===b.lo){
      if(b.lo<lo0-1 || b.lo>hi0+1) continue;            // точка вне окна — не рисуем вовсе
      points.push(b);
    } else {
      const a=Math.min(b.lo,hi), c=Math.max(b.lo,hi);
      if(c<lo0 || a>hi0) continue;                      // полоса целиком вне окна
      ranges.push({lo:a,hi:c,label:b.label,color:b.color,b});
    }
  }
  n._bpAll=ranges;
  // ---- закладки: подписи раскладываем по рядам сверху (жадно слева направо); что не влезло в
  // BM_ROWS рядов — маленький засечкой с линией, имя в подсказке. Вся раскладка нужна до полос и
  // меток сигналов: они отступают от неё (n._topH) ----
  const BM_H=12, BM_ROWS=3, SC=[]; cx.font='9px monospace';
  const hoverF=n._bmHoverFreq, rowEnd=[-Infinity,-Infinity,-Infinity], tabsX=W-96;   // вкладки маркеров занимают правый верх (saMarkerTabs)
  for(const p of points){
    const x=Math.round(saPos(n,p.lo)*W); if(x<-2||x>W+2) continue;
    const t=p.label||fmtHz(p.lo), bw=Math.ceil(cx.measureText(t).width)+6;
    SC.push({p,x,t,bw});
  }
  SC.sort((a,b)=>a.x-b.x);
  let rows=0;
  for(const o of SC){
    o.bx=clamp(Math.round(o.x-o.bw/2),1,W-o.bw-1); o.row=-1;
    for(let r=0;r<BM_ROWS;r++){
      if(o.bx<rowEnd[r]+2 || (r<2 && o.bx+o.bw>tabsX)) continue;
      o.row=r; rowEnd[r]=o.bx+o.bw; if(r+1>rows) rows=r+1; break;
    }
  }
  n._topH=rows ? rows*BM_H+3 : (SC.length ? 8 : 4);
  // ---- полосы: дорожки СНИЗУ ВВЕРХ от границы зоны оси частот (plotH) — единой лентой прямо над
  // подписями оси, не наползая на них. Первые MAX_LANES дорожек с подписями, остальное — тонкие
  // полоски без текста над ними (имена — в подсказке под курсором) ----
  let lanesH=0, stripsH=0;
  if(ranges.length){
    // сортируем по началу (lo) — жадная раскраска по началу оптимальна по числу дорожек:
    // не пересекающиеся (даже впритык, по общей границе — см. e<=r.lo ниже) полосы стабильно
    // уходят в одну дорожку, а не расползаются по разным. При одинаковом lo первой кладём более
    // широкую полосу — она первой займёт нижнюю дорожку, а узкая (более специфичная),
    // перекрывающая её от той же точки, уйдёт выше — не наоборот.
    // порядок раскладки — по важности, а не по началу: сначала полосы под маркерами, затем узкие
    // (конкретные); широкие и поздние при нехватке дорожек уходят в тонкие полоски. Готовые дорожки
    // потом упорядочиваем сверху вниз от узких к широким — широкая полоса снова внизу, у оси.
    const LANE_H=14, MAX_LANES=4, STRIP_H=3, MAX_STRIPS=3;
    const mks=n.mk.filter(v=>v!=null), pr=r=>mks.some(f=>f>=r.lo&&f<=r.hi)?0:1;
    const fits=(L,r)=>!L.some(q=>r.lo<q.hi && r.hi>q.lo);
    const lanes=[], strips=[];
    for(const r of ranges.slice().sort((a,b)=>pr(a)-pr(b) || (a.hi-a.lo)-(b.hi-b.lo) || a.lo-b.lo)){
      let L=lanes.find(l=>fits(l,r));
      if(!L && lanes.length<MAX_LANES){ L=[]; lanes.push(L); }
      if(L){ L.push(r); continue; }
      let S=strips.find(l=>fits(l,r));
      if(!S){ if(strips.length<MAX_STRIPS){ S=[]; strips.push(S); } else S=strips[strips.length-1]; }
      S.push(r);
    }
    const lw=L=>L.reduce((a,r)=>a+(r.hi-r.lo),0)/L.length;
    lanes.sort((a,b)=>lw(b)-lw(a)).forEach((L,i)=>L.forEach(r=>{ r._lane=i; }));
    strips.forEach((S,i)=>S.forEach(r=>{ r._strip=i; }));
    const laneEnd=lanes, stripEnd=strips;
    lanesH=laneEnd.length*LANE_H; stripsH=stripEnd.length ? stripEnd.length*(STRIP_H+1)+1 : 0;
    cx.font=BP_FONT;
    const scr=hexToRgb(themeColor('--screen')||'#0a0d0e'), FILL_A=.5;
    for(const r of ranges){
      const x1=Math.round(saPos(n,r.lo)*W), x2=Math.round(saPos(n,r.hi)*W);
      if(x2<0||x1>W) continue;                            // целиком вне канвы — сам прямоугольник не рисуем
      const w=Math.max(1,x2-x1), col=r.color||'#5fb8d1';
      if(r._strip!=null){
        const y=plotH-lanesH-(r._strip+1)*(STRIP_H+1);
        cx.globalAlpha=.85; cx.fillStyle=col; cx.fillRect(x1,y,Math.max(2,w),STRIP_H);
        bpBoxes.push({x0:x1,x1:Math.max(x2,x1+2),y0:y-1,y1:y+STRIP_H+1,r});
        continue;
      }
      const y=plotH-(r._lane+1)*LANE_H;
      cx.globalAlpha=FILL_A; cx.fillStyle=col; cx.fillRect(x1,y,w,LANE_H-1);
      cx.globalAlpha=1; cx.fillRect(x1,y,w,2);            // яркий верхний кант — граница полосы видна на любом шуме
      cx.fillStyle=themeColor('--screen');                 // тёмные разделители — соседние сегменты не сливаются
      cx.fillRect(x1,y,1,LANE_H-1); cx.fillRect(x2-1,y,1,LANE_H-1);
      bpBoxes.push({x0:x1,x1:x2,y0:y,y1:y+LANE_H,r});
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
  n._bpH=lanesH+stripsH;
  // ---- точки (закладки): штриховая линия вниз от подписи + подпись залитая своим цветом,
  // отцентрированная НА линии. n._bmBoxes — прямоугольники подписей в пикселях канвы, читает sa's
  // draw() (analysis.js) для клика/наведения; наведённая (n._bmHoverFreq) рисуется ПОСЛЕДНЕЙ,
  // поверх соседних, и всегда с именем — даже если в раскладке ей не хватило места. ----
  const boxes=n._bmBoxes=(n._bmBoxes||[]); boxes.length=0;
  if(SC.length){
    cx.font='9px monospace'; cx.setLineDash([3,3]);
    const ordered = hoverF!=null && SC.some(o=>o.p.lo===hoverF)
      ? [...SC.filter(o=>o.p.lo!==hoverF), ...SC.filter(o=>o.p.lo===hoverF)]
      : SC;
    for(const o of ordered){
      const p=o.p, col=p.color||'#c9c9c9', hovered=hoverF===p.lo, x=o.x;
      const show=o.row>=0 || hovered, row=o.row>=0 ? o.row : 0, ty=2+row*BM_H;
      cx.strokeStyle=col; cx.lineWidth=1; cx.globalAlpha=hovered?.95:o.row>=0?.45:.3;
      cx.beginPath(); cx.moveTo(x+.5,show?ty+BM_H-1:0); cx.lineTo(x+.5,H); cx.stroke();
      if(!show){                                           // не влезло — засечка у потолка
        cx.setLineDash([]); cx.globalAlpha=.9; cx.fillStyle=col; cx.fillRect(x-1,0,3,6); cx.setLineDash([3,3]);
        boxes.push({x0:x-3,y0:0,x1:x+4,y1:BM_H+2,freq:p.lo,b:p,hid:true}); continue;
      }
      const bx=hovered&&o.row<0 ? clamp(Math.round(x-o.bw/2),1,W-o.bw-1) : o.bx;
      cx.globalAlpha=hovered?1:.88; cx.fillStyle=col; cx.fillRect(bx,ty,o.bw,BM_H-1);
      cx.globalAlpha=1; cx.fillStyle=contrastText(col); cx.fillText(o.t,bx+3,ty+8);
      boxes.push({x0:bx,y0:ty,x1:bx+o.bw,y1:ty+BM_H,freq:p.lo,b:p});
    }
    cx.setLineDash([]);
  }
}
// Метки сигналов с 'sigid' (записи sig:true в bands): скобка над сигналом на уровне его пика,
// подпись типа над ней. Подписи, налезающие на уже поставленные, поднимаются выше; не нашедшие
// места — маленький треугольник над скобкой (подробности в подсказке под курсором).
function saSigTags(n,cx,W,plotH){
  const sgBoxes=n._sgBoxes=(n._sgBoxes||[]); sgBoxes.length=0; n._sgRects=[];
  const list=n.sigsData&&n.sigsData.length ? (n.bandsData||[]).concat(n.sigsData) : n.bandsData; if(!list||!list.length) return;
  const tags=[], span=(n.p.top-n.p.floor)||1, TOPN=n._topH||4;
  for(const b of list){
    if(!b || !b.sig || typeof b.lo!=='number') continue;
    const x1=Math.round(saPos(n,b.lo)*W), x2=Math.round(saPos(n,b.hi)*W);
    if(x2<0 || x1>W) continue;
    const y=plotH-clamp(((b.db??n.p.top)-n.p.floor)/span,0,1)*(plotH-2)-1;
    tags.push({b,x1,x2:Math.max(x2,x1+3),y});
  }
  if(!tags.length) return;
  const hx=n._hoverX!=null ? n._hoverX*W : null, hy=n._hoverY;
  // нужная полоса приёма (sigid, «need»): тонкие пунктирные края у всех, заливка и подпись ширины —
  // у того, над кем курсор (или если сигналов мало); подпись стоит над лентой полос, не на ней
  const few=tags.length<=3, nb=[];
  for(const t of tags){
    const b=t.b; if(!(b.nbw>0)) continue;
    const nx1=Math.round(saPos(n,b.nlo)*W), nx2=Math.round(saPos(n,b.nhi)*W);
    if(nx2<0 || nx1>W) continue;
    t.nx1=nx1; t.nx2=nx2;
    const focus=few || (hx!=null && hx>=Math.min(t.x1,nx1)-3 && hx<=Math.max(t.x2,nx2)+3 && (hy==null || hy<plotH));
    const col=b.color||'#b0bec5', w=Math.max(nx2-nx1,2);
    cx.globalAlpha=focus?.1:.04; cx.fillStyle=col; cx.fillRect(nx1,TOPN,w,plotH-TOPN);
    cx.globalAlpha=focus?.85:.4; cx.strokeStyle=col; cx.lineWidth=1; cx.setLineDash(focus?[]:[2,3]);
    cx.beginPath(); cx.moveTo(nx1+.5,TOPN); cx.lineTo(nx1+.5,plotH); cx.moveTo(nx2-.5,TOPN); cx.lineTo(nx2-.5,plotH); cx.stroke();
    cx.setLineDash([]);
    if(focus) nb.push({t,col,nx1,nx2});
  }
  cx.font=BP_FONT;
  const nbPlaced=[];
  for(const o of nb){
    const b=o.t.b, txt='◂ '+fmtHz(b.nbw,b.nbw<1e4?1:0)+'Hz ▸', tw=Math.ceil(cx.measureText(txt).width)+6;
    if(tw>o.nx2-o.nx1+40) continue;
    const ly=plotH-(n._bpH||0)-14, lx=clamp(Math.round((o.nx1+o.nx2)/2-tw/2),2,Math.max(2,W-tw-2));
    if(nbPlaced.some(q=>lx<q.x+q.w+2 && lx+tw+2>q.x)) continue;
    nbPlaced.push({x:lx,w:tw});
    cx.globalAlpha=.85; cx.fillStyle=o.col; cx.fillRect(lx,ly,tw,12);
    cx.globalAlpha=1; cx.fillStyle=contrastText(o.col); cx.fillText(txt,lx+3,ly+9);
  }
  cx.globalAlpha=1;
  tags.sort((a,b)=>a.y-b.y);                          // сильные — первыми, им место у пика
  const placed=[], TH=14, TOP=TOPN+2;
  for(const t of tags){
    const col=t.b.color||'#b0bec5', txt=t.b.label||'?', tw=Math.ceil(cx.measureText(txt).width)+6;
    const by=Math.max(TOP+TH+4,Math.round(t.y)-5);
    cx.strokeStyle=col; cx.lineWidth=1.5; cx.globalAlpha=.9;
    cx.beginPath(); cx.moveTo(t.x1+.5,by+5); cx.lineTo(t.x1+.5,by+.5); cx.lineTo(t.x2-.5,by+.5); cx.lineTo(t.x2-.5,by+5); cx.stroke();
    const mx=Math.round((t.x1+t.x2)/2), lx=clamp(mx-(tw>>1),2,W-tw-2);
    let ly=by-TH-2, ok=false;
    for(let k=0;k<6;k++){
      if(ly<TOP) break;
      const hit=placed.find(p=>lx<p.x+p.w+1 && lx+tw+1>p.x && ly<p.y+p.h && ly+TH>p.y);
      if(!hit){ ok=true; break; }
      ly=hit.y-TH-2;
    }
    const box={x0:Math.min(t.x1,lx)-1,x1:Math.max(t.x2,lx+tw)+1,y0:ok?ly:by-8,y1:by+6,b:t.b,t};
    sgBoxes.push(box);
    if(!ok){                                         // места нет: треугольник над скобкой
      cx.globalAlpha=.95; cx.fillStyle=col; cx.beginPath(); cx.moveTo(mx-4,by-8); cx.lineTo(mx+4,by-8); cx.lineTo(mx,by-2); cx.fill();
      continue;
    }
    if(ly<by-TH-2){ cx.lineWidth=1; cx.beginPath(); cx.moveTo(mx+.5,ly+TH); cx.lineTo(mx+.5,by); cx.stroke(); }
    cx.globalAlpha=.6+.4*clamp(t.b.conf??1,0,1);      // уверенность — плотностью подложки
    cx.fillStyle=col; cx.fillRect(lx,ly,tw,TH);
    cx.globalAlpha=1; cx.fillStyle=contrastText(col); cx.fillText(txt,lx+3,ly+11);
    placed.push({x:lx,y:ly,w:tw,h:TH});
  }
  n._sgRects=placed;
  cx.globalAlpha=1; cx.lineWidth=1;
}
// Подсказка под курсором: что лежит под ним — закладки, полосы band plan (все вложенные, от широкой
// к узкой) и метки сигналов. Срабатывает только над самими элементами (подписи, ленты, скобки),
// не над пустым спектром — чтобы не мешать ставить маркер.
// частота без хвоста нулей: 99.5M, 100.0125M, 433.92M
function saHz(v){
  const a=Math.abs(v), [d,u,dp]=a>=1e9?[1e9,'G',5]:a>=1e6?[1e6,'M',5]:a>=1e3?[1e3,'k',3]:[1,'',0];
  return +(v/d).toFixed(dp)+u+'Hz';
}
function saTipRows(n,W,hx,hy){
  const mx=hx*W, pad=2, inB=b=>mx>=b.x0-pad&&mx<=b.x1+pad&&hy>=b.y0-pad&&hy<=b.y1+pad;
  const f=saFreq(n,hx), rows=[], seen=new Set();
  const add=(col,head,sub)=>{ const k=head+'|'+sub; if(!seen.has(k)){ seen.add(k); rows.push({col,head,sub}); } };
  for(const b of n._bmBoxes||[]) if(inB(b)) add(b.b.color||'#c9c9c9','★ '+(b.b.label||saHz(b.freq)),saHz(b.freq)+(b.b.note?' · '+b.b.note:''));
  for(const b of n._mkBoxes||[]) if(inB(b)){
    const k=b.idx, mf=n.mk[k], bw=saMarkerBw(n,k), ch=saChanAtMarker(n,mf), a=[];
    if(ch && ch.rssi!=null) a.push(Math.round(ch.rssi)+' dBFS'+(ch.snr!=null?' · SNR '+Math.round(ch.snr):'')); else if(n.db[k]>-119) a.push(Math.round(n.db[k])+' dB · SNR '+Math.max(0,Math.round(n.snr?.[k]??0)));
    if(bw) a.push('bw '+fmtHz(bw[1]-bw[0],bw[1]-bw[0]<1e4?1:0)+'Hz');
    if(ch&&ch.mode) a.push(ch.mode);
    add(MK_COL(k),'Marker '+(k+1)+' · '+saHz(mf),a.join(' · ')||'—');
  }
  const bh=(n._bpBoxes||[]).filter(inB);
  if(bh.length){
    for(const r of (n._bpAll||[]).filter(r=>r.lo<=f&&r.hi>=f).sort((a,b)=>(b.hi-b.lo)-(a.hi-a.lo))){
      const bb=r.b||{}, st=+bb.step;
      add(r.color||'#5fb8d1',r.label||saHz(r.lo),saHz(r.lo)+' – '+saHz(r.hi)+(st>0?' · step '+fmtHz(st,st%1e3?1:0)+'Hz':'')+(bb.note?' · '+bb.note:''));
    }
  }
  for(const b of n._sgBoxes||[]) if(inB(b)){
    const g=b.b, a=[];
    a.push(saHz(g.f??(g.lo+g.hi)/2));
    if(g.db!=null) a.push(Math.round(g.db)+' dB');
    if(g.hi>g.lo) a.push('bw '+fmtHz(g.hi-g.lo,g.hi-g.lo<1e4?1:0)+'Hz');
    if(g.conf!=null) a.push(Math.round(g.conf*100)+'%');
    if(g.nbw>0) a.push('need '+fmtHz(g.nbw,g.nbw<1e4?1:0)+'Hz');
    if(g.dec) a.push('→ '+g.dec);
    add(g.color||'#b0bec5',g.label||'?',a.join(' · '));
  }
  rows.band=bh.length>0;
  return rows;
}
// Рисует подсказку: у курсора, а на телефоне — у точки долгого нажатия (n._tipPin, снимается следующим касанием).
function saTip(n,cx,W,H){
  const pin=n._tipPin, hx=pin ? pin.x/W : n._hoverX, hy=pin ? pin.y : n._hoverY;
  if(hx==null||hy==null||n._dragActive) return;
  const rows=saTipRows(n,W,hx,hy), mx=hx*W;
  if(!rows.length) return;
  const MAXR=8, shown=rows.slice(0,MAXR), more=rows.length-shown.length, hint=rows.band && !pin ? '2× click — zoom to the band' : '';
  cx.font='11px monospace';
  let tw=0; for(const r of shown) tw=Math.max(tw,cx.measureText(r.head).width,cx.measureText(r.sub).width*.9);
  if(hint) tw=Math.max(tw,cx.measureText(hint).width);
  tw=Math.ceil(tw)+22; const th=shown.length*26+(more>0||hint?14:0)+6;
  let x=mx+14, y=hy+16; if(x+tw>W-2) x=mx-tw-10; if(x<2) x=2; if(y+th>H-2) y=hy-th-10; if(y<2) y=2;
  cx.globalAlpha=.95; cx.fillStyle=themeColor('--screen'); cx.fillRect(x,y,tw,th);
  cx.globalAlpha=.6; cx.strokeStyle=themeColor('--axis'); cx.lineWidth=1; cx.strokeRect(x+.5,y+.5,tw-1,th-1);
  cx.globalAlpha=1; cx.textBaseline='alphabetic';
  shown.forEach((r,i)=>{
    const yy=y+4+i*26;
    cx.fillStyle=r.col; cx.fillRect(x+4,yy+1,4,22);
    cx.fillStyle=themeColor('--acc'); cx.font='11px monospace'; cx.fillText(r.head,x+13,yy+10);
    cx.globalAlpha=.7; cx.fillStyle=themeColor('--axis'); cx.font='10px monospace'; cx.fillText(r.sub,x+13,yy+21); cx.globalAlpha=1;
  });
  if(more>0||hint){ cx.fillStyle=themeColor('--axis'); cx.font='10px monospace'; cx.globalAlpha=.8; cx.fillText((more>0?'+'+more+' more'+(hint?' · ':''):'')+hint,x+13,y+th-5); cx.globalAlpha=1; }
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
// Полоса маркера: канал приёмника под ним, иначе окно слежения за несущей. null — ширина неизвестна.
function saMarkerBw(n,k){
  const f=n.mk[k]; if(f==null) return null;
  const ch=saChanAtMarker(n,f);
  if(ch && ch.hi>ch.lo) return [ch.lo,ch.hi];
  const w=n.p.trk&&n._trkWin?.[k];
  return w ? [f-w/2,f+w/2] : null;
}
// Маркеры на водопаде: по умолчанию только пока курсор над ним (wfMk: hover), 'active' — активный всегда, 'all' — все всегда.
// Раньше было: линия, полоса пропускания и подпись с шириной.
function saMarkersWf(n,cx,W,hs,H){
  const mode=n.p.wfMk||'hover', over=n._hoverX!=null && n._hoverY!=null && n._hoverY>hs && !n._dragActive;
  if(mode==='hover' && !over) return;
  const present=[0,1,2,3].filter(k=>n.mk[k]!=null && (mode!=='active' || n.active-1===k)); if(!present.length) return;
  cx.save(); cx.font='10px monospace';
  const placed=[];
  present.forEach(k=>{
    const f=n.mk[k], x=saPos(n,f)*W; if(x<-2||x>W+2) return;
    const col=MK_COL(k), bw=saMarkerBw(n,k), xr=Math.round(x)+.5;
    if(bw){
      const x1=saPos(n,bw[0])*W, x2=saPos(n,bw[1])*W;
      cx.globalAlpha=.12; cx.fillStyle=col; cx.fillRect(x1,hs,Math.max(2,x2-x1),H-hs);
      if(x2-x1>=3){ cx.globalAlpha=.8; cx.strokeStyle=col; cx.lineWidth=1; cx.beginPath();
        cx.moveTo(Math.round(x1)+.5,hs); cx.lineTo(Math.round(x1)+.5,H); cx.moveTo(Math.round(x2)-.5,hs); cx.lineTo(Math.round(x2)-.5,H); cx.stroke(); }
    }
    cx.globalAlpha=.85; cx.strokeStyle=col; cx.lineWidth=1; cx.setLineDash([3,3]);
    cx.beginPath(); cx.moveTo(xr,hs); cx.lineTo(xr,H); cx.stroke(); cx.setLineDash([]);
    const t=(k+1)+': '+fmtHz(f,3).replace(/[kMG]$/,'')+(bw?' · '+fmtHz(bw[1]-bw[0],bw[1]-bw[0]<1e4?1:0)+'Hz':'');
    const tw=Math.ceil(cx.measureText(t).width)+6;
    let lx=clamp(Math.round(x-tw/2),2,W-tw-2), ly=hs+3;
    for(let i=0;i<4;i++){ const hit=placed.find(q=>lx<q.x+q.w+1&&lx+tw+1>q.x&&ly<q.y+13&&ly+12>q.y); if(!hit) break; ly=hit.y+13; }
    placed.push({x:lx,y:ly,w:tw});
    cx.globalAlpha=.9; cx.fillStyle=col; cx.fillRect(lx,ly,tw,12);
    cx.globalAlpha=1; cx.fillStyle=contrastText(col); cx.fillText(t,lx+3,ly+9);
  });
  cx.restore();
}
function saMarkers(n,cx,W,H){
  cx.lineWidth=1; cx.globalAlpha=1; cx.font='10px monospace';
  const TOP_H=Math.max(16,n._topH||0);               // потолок с подписями закладок (см. saBandPlan) — не залезаем
  const baseY=H-14-(n._bpH||0);                      // флажки стоят над лентой band plan, а не на ней
  const boxes=n._mkBoxes=(n._mkBoxes||[]); boxes.length=0;
  n._hbBoxes=[]; n._hbRows=[0,0];
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
    const tb=n.p.trk&&n._trkWin?.[k];                 // окно поиска несущей
    if(tb){ const x1=saPos(n,f-tb/2)*W, x2=saPos(n,f+tb/2)*W;
      cx.globalAlpha=.12; cx.fillStyle=MK_COL(k); cx.fillRect(x1,TOP_H,Math.max(2,x2-x1),H-TOP_H); cx.globalAlpha=1; }
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
    const ant=n.p.ant==='antenna'||n.p.ant==='both', hrm=n.p.ant==='harmonics'||n.p.ant==='both';
    const t2=ant ? t+' λ/4 '+fmtLen(antennaDims(f,n.p.antVf).quarter) : t;
    const tw=cx.measureText(t2).width;
    // по центру линии маркера; дорожка стека — по месту среди выставленных маркеров (present), а не
    // по порядку рисования — иначе позиции соседних подписей "прыгали" бы при каждой смене наведения
    const tx=clamp(Math.round(x-tw/2), 2, W-tw-2), ty=baseY-14-present.indexOf(k)*14;
    cx.globalAlpha=hovered?1:(act?.95:.75); cx.fillStyle=MK_COL(k);
    cx.fillRect(tx-3,ty,tw+6,12);
    cx.globalAlpha=1; cx.fillStyle=contrastText(MK_COL(k));
    cx.fillText(t2,tx,ty+9);
    if(hrm) saHarmTicks(n,cx,W,H,f,k,TOP_H);
    boxes.push({x0:tx-3,y0:ty,x1:tx+tw+3,y1:ty+12,idx:k});
  }
  cx.lineWidth=1;
}
// Засечки f/k под маркером: сигнал на f может быть k-й гармоникой передатчика на f/k.
// Не попавшие в окно (узкий SDR) — плашки у края со значком стороны; клик по плашке — n._steer
// (приёмник перестраивается на f/k, см. pointerup в analysis.js)
function saHarmTicks(n,cx,W,H,f,k,top){
  cx.save(); cx.font='9px monospace';
  const rows=n._hbRows;
  for(const h of harmonicSources(f,8)){
    const x=Math.round(saPos(n,h.f)*W);
    cx.strokeStyle=cx.fillStyle=MK_COL(k);
    if(x>=0&&x<=W){
      cx.globalAlpha=.8; cx.setLineDash([2,3]);
      cx.beginPath(); cx.moveTo(x+.5,top); cx.lineTo(x+.5,H); cx.stroke();
      cx.setLineDash([]); cx.fillText('÷'+h.k,Math.min(x+2,W-16),top+10+k*10); continue; }
    const left=x<0, t=(left?'◀ ':'')+'÷'+h.k+' '+fmtHz(h.f,2)+(left?'':' ▶');
    const tw=cx.measureText(t).width, y=top+2+rows[left?0:1]++*12, tx=left?2:W-tw-6;
    cx.globalAlpha=.85; cx.fillRect(tx,y,tw+4,11);
    cx.globalAlpha=1; cx.fillStyle=contrastText(MK_COL(k)); cx.fillText(t,tx+2,y+8);
    n._hbBoxes.push({x0:tx,y0:y,x1:tx+tw+4,y1:y+11,f:h.f}); }
  cx.restore();
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

const thIf=m=>n=>(n.p.mode||'level')===m;
def({ id:'thresh', title:'Threshold', cat:'Processing', kw:'slicer comparator window level schmitt hysteresis',
  ins:[{n:'num',t:'num'},{n:'sig',t:'sig'},{n:'thr',t:'num'},{n:'hys',t:'num'},{n:'hold',t:'num'},
       {n:'auto',t:'num'},{n:'invert',t:'num'}],
  outs:[{n:'num',t:'num'},{n:'sig',t:'sig'}],
  params:[{n:'mode',t:'select',opts:['level','window'],d:'level',label:'level: ±1 slicer with hysteresis · window: 1 while the value stays between lo and hi for at least min ms'},
          {n:'thr',t:'range',min:-1,max:1,step:.005,d:.5,if:thIf('level')},
          {n:'hys',t:'range',min:0,max:.5,step:.005,d:.05,if:thIf('level')},
          {n:'hold',t:'range',min:0,max:2000,step:5,d:0,if:thIf('level')},
          {n:'auto',t:'check',d:false,if:thIf('level')},
          {n:'invert',t:'check',d:false,if:thIf('level')},
          {n:'lo',t:'num',d:1150,if:thIf('window')},{n:'hi',t:'num',d:1350,if:thIf('window')},
          {n:'minMs',t:'range',min:0,max:100,step:.5,d:3,label:'min, ms',if:thIf('window')}],
  init:n=>{n.s=false;n.h=0;n.mn=0;n.mx=1;n.run=0;},
  process(n,I){
    for(const k of ['thr','hys','hold']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    for(const k of ['auto','invert']) if(typeof I[k]==='number') setMod(n,k,I[k]>=0.5);
    const os=buf(n,'sig'), dt=BLOCK/Eng.sr*1000;
    const hasSig=!!I.sig;
    if(n.p.mode==='window'){                          // окно значений: единица, пока значение в [lo, hi] не меньше minMs
      const need=n.p.minMs*Eng.sr/1000;
      let hit=0;
      for(let i=0;i<BLOCK;i++){ const v=hasSig ? I.sig[i] : (I.num||0);
        if(v>=n.p.lo && v<=n.p.hi) n.run++; else n.run=0;
        os[i]=n.run>=need ? 1 : 0; hit=hit||os[i]; }
      return {num:hit, sig:os}; }
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


// Банк комплексных резонаторов с постоянной добротностью: окно на частоте f ~ Q/f секунд,
// поэтому высокие полосы реагируют быстрее низких (в отличие от БПФ с одним окном на всё).
// Постоянка вычитается до банка: одиночный резонатор пропускает DC с ослаблением всего 1/(2Q),
// и, например, гравитация акселерометра (9.8) заливала все полосы. Порядок order — каскад
// одинаковых резонаторов: крутые скаты, соседние сильные составляющие меньше протекают;
// полюса раздвинуты так, чтобы полоса по −3 дБ оставалась f/Q. Выход — амплитуда синуса.
def({ id:'wavelet', title:'Wavelet (const. Q)', cat:'Processing',
  ins:[{n:'in',t:'sig'},{n:'fmin',t:'num'},{n:'fmax',t:'num'},{n:'Q',t:'num'},{n:'floor',t:'num'},{n:'top',t:'num'}],
  outs:[{n:'spec',t:'spec'},{n:'f',t:'num'},{n:'level',t:'num'}],
  params:[{n:'fmin',t:'range',min:.1,max:5000,step:.1,d:100,log:true},
          {n:'fmax',t:'range',min:1,max:()=>Eng.sr/2,step:.1,d:5000,log:true},
          {n:'bands',t:'select',opts:['24','48','96','144','288'],d:'96'},
          {n:'Q',t:'range',min:2,max:48,step:.5,d:12},
          {n:'order',t:'select',opts:['1','2','4'],d:'2',label:'resonator order'},
          {n:'decim',t:'select',opts:['auto','1','4','16','64','256'],d:'auto',
           label:'decimation'},
          {n:'floor',t:'range',min:-140,max:-20,step:1,d:-90,label:'level floor'},
          {n:'top',t:'range',min:-60,max:20,step:1,d:-10,label:'level top'}],
  init:n=>{n.key='';n.f=0;n.lv=0;n.acc=0;n.cnt=0;n.dc=null;},
  process(n,I){
    for(const k of ['fmin','fmax','Q','floor','top']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const B=+n.p.bands, M=+n.p.order||1;
    const lo=Math.max(.01,Math.min(n.p.fmin,n.p.fmax)), hi=Math.max(n.p.fmin,n.p.fmax);
    let D=+n.p.decim;
    if(n.p.decim==='auto'){                          // держим запас над верхней полосой
      D=1; while(D*4<=256 && hi*6 < Eng.sr/(D*4)) D*=4; }
    D=Math.max(1,Math.min(D, Math.floor(Eng.sr/(hi*3))||1));
    const srE=Eng.sr/D;
    const key=[B,lo,hi,n.p.Q,M,srE].join('/');
    if(n.key!==key){                                 // шаг полос по логарифму
      n.key=key; n.B=B; n.D=D; n.srE=srE; n.M=M;
      n.fc=new Float32Array(B); n.cr=new Float64Array(B); n.ci=new Float64Array(B);
      n.zr=new Float64Array(B*M); n.zi=new Float64Array(B*M);
      n.mag=new Float32Array(B); n.g=new Float64Array(B);
      const widen=1/Math.sqrt(Math.pow(2,1/M)-1);   // каскад сужает полосу — раздвигаем полюс
      for(let k=0;k<B;k++){
        const f=B>1?lo*Math.pow(hi/lo,k/(B-1)):lo;
        n.fc[k]=f;
        const a=Math.exp(-Math.PI*f*widen/(n.p.Q*srE));
        const w=2*Math.PI*f/srE;
        n.cr[k]=a*Math.cos(w); n.ci[k]=a*Math.sin(w);
        n.g[k]=2*Math.pow(1-a,M); }                  // ×2: реальный синус делится на ±f
      n.dcK=1-Math.exp(-2*Math.PI*Math.max(.005,lo/20)/srE);   // ФНЧ для оценки постоянки
    }
    const B2=n.B, DD=n.D, zr=n.zr, zi=n.zi, cr=n.cr, ci=n.ci, MM=n.M;
    for(let i=0;i<BLOCK;i++){
      n.acc+=I.in?I.in[i]:0;                          // усреднение = антиалиасинг перед прореживанием
      if(++n.cnt<DD) continue;
      let x=n.acc/DD; n.acc=0; n.cnt=0;
      if(n.dc==null) n.dc=x;                          // старт без скачка
      n.dc+=(x-n.dc)*n.dcK; x-=n.dc;
      for(let k=0;k<B2;k++){
        const c=cr[k], s=ci[k];
        let ur=x, ui=0;
        for(let m=0,j=k*MM;m<MM;m++,j++){             // каскад: выход ступени — вход следующей
          const r=zr[j], q=zi[j];
          zr[j]=r*c-q*s+ur; zi[j]=r*s+q*c+ui;
          ur=zr[j]; ui=zi[j]; } } }
    let best=0,bv=-1;
    for(let k=0;k<B2;k++){
      const j=k*MM+MM-1;
      n.mag[k]=Math.hypot(zr[j],zi[j])*n.g[k];
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
  draw(n){ roText(n,'GR: -'+Math.round(n.grDb)+' dB'); }});


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
  draw(n){ roText(n,n.p.mode+' · '+n.p.rate.toFixed(1)+' Hz'); }});


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
