"use strict";
/* ============================ IQ: блоки на потоке 'iq' ============================ */
// Поток со своей частотой (см. iqStream в core-dsp.js): приёмник собирается проводами —
// источник → сдвиг → децимация → демодулятор → IQ → Audio (мост в домен Eng.sr).
// DSP — в modules/iq-kernels.js. Узлы с kernel движок собирает в острова и считает
// в воркере (см. core-islands.js), без воркеров — здесь же, в главном потоке.

const IQ_SR_OPTS=['48000','96000','192000','240000','250000','256000','1024000','2000000','2048000','2400000','8000000','10000000','12000000','16000000','20000000'];
const iqCtx={get block(){ return BLOCK; }, get sr(){ return Eng.sr; }};
// def с ядром из IQK: process/init в главном потоке, readout — по n.ui
function defIQ(d, text){
  const k=IQK[d.id];
  def({...d, kernel:true, readout:!!text,
    init:n=>k.init(n),
    process:(n,I)=>k.process(n,I,iqCtx),
    ...(text ? {draw(n){ const r=n.el.querySelector('.readout');
      if(r) r.textContent=text(n)+(n._isl ? ' · worker' : ''); }} : {})});
}

defIQ({ id:'iqGen', title:'IQ Generator', cat:'IQ',
  ins:[{n:'fc',t:'num'},{n:'off',t:'num'}], outs:[{n:'iq',t:'iq'}],
  params:[{n:'sr',t:'select',opts:IQ_SR_OPTS,d:'1024000',label:'sample rate'},
          {n:'fc',t:'num',d:100000000,label:'center frequency, Hz'},
          {n:'mode',t:'select',opts:['carrier','AM','FM','WFM stereo','USB','LSB','ADS-B','LRPT','RS41','STD-C','MPT1327','AIS','ACARS','DMR','4FSK','TETRA','ISM433','Analog TV','off'],d:'FM'},
          {n:'off',t:'num',d:100000,label:'signal offset from center, Hz'},
          {n:'lvl',t:'range',min:-100,max:0,step:1,d:-20,label:'signal level, dBFS'},
          {n:'tone',t:'range',min:50,max:10000,step:1,d:1000,log:true,label:'modulating tone, Hz'},
          {n:'dev',t:'range',min:100,max:100000,step:100,d:5000,log:true,label:'FM deviation, Hz'},
          {n:'depth',t:'range',min:0,max:1,step:.01,d:.5,label:'AM depth'},
          {n:'noise',t:'range',min:-120,max:0,step:1,d:-60,label:'noise, dBFS'},
          {n:'lrpt',t:'select',opts:['OQPSK','QPSK'],d:'OQPSK',label:'LRPT: OQPSK + NRZ-M (Meteor M2-3/M2-4) or QPSK (M2)'},
          {n:'dmr',t:'select',opts:['repeater (BS)','inbound (MS)','direct TS1','direct TS2'],d:'repeater (BS)',label:'DMR: repeater downlink (2 slots, CACH), MS uplink or direct mode'},
          {n:'fsk4',t:'select',opts:Object.keys(FSK4.gen),d:Object.keys(FSK4.gen)[0],label:'4FSK: digital voice / trunking test signal (protocol)'},
          {n:'ism',t:'select',opts:['OOK','FSK'],d:'OOK',label:'ISM433: sensor and remote-control telegrams, OOK or 2-FSK'},
          {n:'tv',t:'select',opts:['PAL','NTSC'],d:'PAL',label:'Analog TV: standard (colour bars, grey scale, frame)'},
          {n:'tvm',t:'select',opts:['FM','AM'],d:'FM',label:'Analog TV: FM (FPV, satellite) or AM with negative modulation (broadcast)'},
          {n:'tvdev',t:'num',d:8000000,label:'Analog TV FM: deviation, sync tip to white, Hz'},
          {n:'ps',t:'text',d:'DSP TEST',label:'WFM stereo: RDS station name (tone in the left channel only)'},
          {n:'ppm',t:'range',min:-1000,max:1000,step:1,d:0,label:'clock error vs sound card, ppm',adv:true},
          {n:'imbG',t:'range',min:-3,max:3,step:.01,d:0,label:'I/Q imbalance: Q gain, dB',adv:true},
          {n:'imbP',t:'range',min:-15,max:15,step:.1,d:0,label:'I/Q imbalance: phase, °',adv:true},
          {n:'imbD',t:'range',min:0,max:2,step:1,d:0,label:'I/Q imbalance: Q late by, samples',adv:true}]},
  n=>(+n.p.sr/1000)+' kS/s · '+n.p.mode+' @ '+((n.p.fc+n.p.off)/1e6).toFixed(4)+' MHz');

defIQ({ id:'iqShift', title:'IQ Frequency Shift', cat:'IQ',
  ins:[{n:'in',t:'iq'},{n:'freq',t:'num'}], outs:[{n:'out',t:'iq'},{n:'offset',t:'num'}],
  params:[{n:'offset',t:'num',d:0,label:'offset from input center, Hz'}]},
  n=>n.ui ? 'shift '+(-n.ui.off/1000).toFixed(3)+' kHz' : 'no input');

defIQ({ id:'iqDecim', title:'IQ Decimator', cat:'IQ',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'iq'},{n:'sr',t:'num'}],
  params:[{n:'M',t:'select',opts:['2','3','4','5','8','10','16','20','25','32','40','50','64'],d:'4',label:'decimation'},
          {n:'cut',t:'range',min:.1,max:.5,step:.01,d:.4,label:'cutoff, × output rate'},
          {n:'tpp',t:'select',opts:['8','16','32'],d:'16',label:'taps per output',adv:true}]},
  n=>n.ui ? (n.ui.srIn/1000)+' → '+(n.ui.srOut/1000)+' kS/s' : 'no input');

defIQ({ id:'iqInterp', title:'IQ Interpolator', cat:'IQ',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'iq'},{n:'sr',t:'num'}],
  params:[{n:'L',t:'select',opts:['2','3','4','5','8','10','16','20','25','32','40','50','64'],d:'8',label:'interpolation'},
          {n:'cut',t:'range',min:.1,max:.5,step:.01,d:.4,label:'cutoff, × input rate'},
          {n:'tpp',t:'select',opts:['4','8','16'],d:'8',label:'taps per input',adv:true}]},
  n=>n.ui ? (n.ui.srIn/1000)+' → '+(n.ui.srOut/1000)+' kS/s' : 'no input');

defIQ({ id:'iqDemod', title:'IQ Demodulator', cat:'IQ',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'iq'},{n:'stereo',t:'iq'},{n:'ps',t:'txt'},{n:'rt',t:'txt'},{n:'pilot',t:'num'},{n:'lock',t:'num'}],
  params:[{n:'mode',t:'select',opts:['FM','WFM','AM','SAM','USB','LSB'],d:'FM'},
          {n:'dev',t:'range',min:500,max:100000,step:100,d:5000,log:true,label:'FM deviation, Hz'},
          {n:'deemph',t:'select',opts:['off','50 µs','75 µs'],d:'off',label:'FM de-emphasis'},
          {n:'stereo',t:'check',d:true,label:'WFM stereo'},
          {n:'samSb',t:'select',opts:['both','USB','LSB','ISB'],d:'both',label:'SAM sideband (ISB: upper → left, lower → right)'},
          {n:'bw',t:'range',min:500,max:10000,step:50,d:2700,label:'SSB bandwidth / SAM sideband width, Hz'},
          {n:'agc',t:'check',d:true,label:'AGC (AM, SAM, SSB)'},
          {n:'gain',t:'range',min:-20,max:40,step:1,d:0,label:'gain, dB'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    const r=u.sr/1000+(u.ar!==u.sr ? ' → '+(u.ar/1000).toFixed(1) : '')+' kS/s';
    if(n.p.mode==='WFM') return 'WFM '+r+(u.stereo ? ' · stereo' : '')+(u.ps ? ' · '+u.ps : '')+(u.rt ? ' · '+u.rt : '');
    if(n.p.mode==='SAM') return 'SAM '+r+' · '+(u.lock ? 'locked '+(u.hz>=0?'+':'')+u.hz.toFixed(0)+' Hz' : 'searching');
    return n.p.mode+' '+r; });

defIQ({ id:'iqDc', title:'IQ DC Block', cat:'IQ',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'iq'}],
  params:[{n:'fc',t:'range',min:1,max:1000,step:1,d:150,log:true,label:'cutoff, Hz'}]},
  n=>n.ui ? 'DC '+(20*Math.log10(n.ui.dc+1e-12)).toFixed(1)+' dBFS' : 'no input');

defIQ({ id:'iqBalance', title:'IQ Balance', cat:'IQ',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'iq'}],
  params:[{n:'auto',t:'check',d:true,label:'auto (blind: needs a spectrum symmetric on average — noise, many signals)'},
          {n:'tau',t:'range',min:.1,max:10,step:.1,d:1,log:true,label:'auto: averaging, s'},
          {n:'gain',t:'range',min:-3,max:3,step:.01,d:0,label:'manual: Q gain, dB'},
          {n:'phase',t:'range',min:-15,max:15,step:.05,d:0,label:'manual: phase, °'},
          {n:'delay',t:'range',min:-2,max:2,step:.01,d:0,label:'Q late by, samples (sound cards: often ±1)'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    return (u.auto ? 'auto' : 'manual')+' · Q '+(u.gain>=0?'+':'')+u.gain.toFixed(2)+' dB · '+(u.phase>=0?'+':'')+u.phase.toFixed(2)+'°'+
      ' · image '+u.before.toFixed(0)+' → '+u.after.toFixed(0)+' dB'; });

defIQ({ id:'iqNb', title:'IQ Noise Blanker', cat:'IQ',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'iq'}],
  params:[{n:'level',t:'select',opts:['off','low','mid','high'],d:'mid',label:'blanking (threshold 36 / 20 / 9× mean power)'}]},
  n=>n.ui ? 'blanked '+n.ui.pct.toFixed(2)+'%' : 'no input');

defIQ({ id:'iqSquelch', title:'IQ Squelch', cat:'IQ',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'iq'},{n:'rssi',t:'num'},{n:'snr',t:'num'},{n:'open',t:'num'}],
  params:[{n:'mode',t:'select',opts:['SNR','level','off'],d:'SNR',label:'open by'},
          {n:'thr',t:'range',min:-120,max:40,step:1,d:8,label:'threshold: SNR, dB / level, dBFS'},
          {n:'hang',t:'range',min:0,max:3000,step:10,d:300,label:'hang, ms'}]},
  n=>{ const u=n.ui; if(!u || u.rssi==null) return 'no input';
    return (u.open ? 'OPEN' : 'closed')+' · '+u.rssi.toFixed(1)+' dBFS · SNR '+u.snr.toFixed(1)+' dB'; });

defIQ({ id:'iqSpec', title:'IQ Spectrum', cat:'IQ',
  ins:[{n:'in',t:'iq'}], outs:[{n:'spec',t:'spec'}],
  params:[{n:'size',t:'select',opts:['512','1024','2048','4096','8192','16384','32768','65536'],d:'4096'},
          {n:'win',t:'select',opts:['hann','hamming','blackman','rect'],d:'hann'},
          {n:'avg',t:'select',opts:['1','4','16','64'],d:'16',label:'max frames averaged'},
          {n:'upd',t:'range',min:20,max:1000,step:10,d:60,label:'update, ms of signal'}]},
  n=>'Welch, up to '+n.p.avg+' frames');

defIQ({ id:'iqAdd', title:'IQ Add', cat:'IQ',
  ins:[{n:'a',t:'iq'},{n:'b',t:'iq'}], outs:[{n:'out',t:'iq'}],
  params:[{n:'ka',t:'range',min:-40,max:20,step:1,d:0,label:'gain a, dB'},
          {n:'kb',t:'range',min:-40,max:20,step:1,d:0,label:'gain b, dB'}]},
  n=>!n.ui ? 'no input' : n.ui.err || 'a + b at '+(n.ui.sr/1000)+' kS/s');

// Каналайзер: число слотов K задаёт порты (ch1..chK, f1..fK)
const IQCH_K=['1','2','3','4','5','6','7','8'];
function iqChanPorts(n){
  const K=+n.p.K||4, valid=new Set(['in','spec','active',...controlParamsOf(n).map(c=>c.n)]);
  for(let k=1;k<=K;k++){ valid.add('ch'+k); valid.add('f'+k); }
  Graph.edges.filter(e=>(e.to===n.id && !valid.has(e.tp)) || (e.from===n.id && !valid.has(e.fp))).forEach(delEdge);
  rebuildNode(n); markTopoDirty();
}
defIQ({ id:'iqChan', title:'IQ Channelizer', cat:'IQ',
  ins:n=>[{n:'in',t:'iq'}, ...Array.from({length:+n.p.K||4},(_,k)=>({n:'f'+(k+1),t:'num'}))],
  outs:n=>[...Array.from({length:+n.p.K||4},(_,k)=>({n:'ch'+(k+1),t:'iq'})), {n:'spec',t:'spec'},{n:'active',t:'num'}],
  params:[{n:'N',t:'select',opts:['8','16','32','64','128','256','512','1024'],d:'64',label:'channels'},
          {n:'ov',t:'select',opts:['1','2'],d:'2',label:'oversampling (2 — clean channel edges)'},
          {n:'K',t:'select',opts:IQCH_K,d:'4',label:'outputs',fn:iqChanPorts},
          {n:'sel',t:'select',opts:['strongest','manual'],d:'strongest',label:'outputs take'},
          {n:'freqs',t:'text',d:'',label:'manual: frequencies, MHz, comma-separated (or f1…)'},
          {n:'thr',t:'range',min:3,max:40,step:1,d:10,label:'strongest: over noise floor, dB'},
          {n:'hold',t:'range',min:0,max:10,step:.1,d:1,label:'strongest: hold after signal drops, s'},
          {n:'skipDc',t:'check',d:true,label:'strongest: skip the center channel (DC spike)'},
          {n:'upd',t:'range',min:20,max:1000,step:10,d:100,label:'channel power update, ms of signal'},
          {n:'P',t:'select',opts:['8','16'],d:'16',label:'taps per channel (16 — neighbours rejected)',adv:true}]},
  n=>!n.ui ? 'no input' : n.ui.N+' × '+(n.ui.chW/1000).toFixed(1)+' kHz → '+(n.ui.srOut/1000)+' kS/s · '+
    n.ui.slots.map((f,k)=>(k+1)+': '+(f==null ? '—' : (f/1e6).toFixed(4))).join(' '));

/* ---- I/Q → IQ ---- */
// Два сигнала движка (I и Q, например стерео-вход звуковой карты от SDR с IQ-выходом, Hilbert,
// квадратурный сдвиг) — в поток 'iq' на частоте движка. Обратно — IQ → Audio (out = I, q = Q)
// или IQ → I/Q (те же I и Q, но на раздельных sig-выходах).
def({ id:'iqMerge', title:'I/Q → IQ', cat:'IQ', lod:'dot',
  ins:[{n:'I',t:'sig'},{n:'Q',t:'sig'},{n:'fc',t:'num'}], outs:[{n:'iq',t:'iq'}],
  readout:true,
  params:[{n:'fc',t:'num',d:0,label:'center frequency, Hz (0 Hz of the stream)'},
          {n:'swap',t:'check',d:false,label:'swap I and Q (mirror the spectrum)'}],
  process(n,I){
    const s=iqStream(n,'iq',Eng.sr,pv(n,I,'fc'));
    let a=I.I, b=I.Q;
    if(n.p.swap) [a,b]=[b,a];
    const re=new Float32Array(BLOCK), im=new Float32Array(BLOCK);
    if(a) re.set(a); if(b) im.set(b);
    iqPush(s,re,im);
    n.state=(Eng.sr/1000)+' kS/s'+(a||b ? '' : ' · no input');
    return {iq:s};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.state||''; }});

/* ---- Audio → IQ ---- */
// Модулятор: звук движка → поток 'iq' на частоте sr (для HackRF TX нужно 2–20 МС/с). Центр потока fc,
// несущая на fc+off (у HackRF от пика на нуле лучше держать off ≠ 0). Звук ±1 = полная девиация/глубина.
// FM — фаза копится на частоте потока (девиация больше звуковой частоты не мешает); SSB — аналитический
// сигнал через КИХ-Гильберт на 127 отводов (боковая подавляется только выше ~400 Гц), задержка выровнена.
// Звук к частоте потока — кубический Эрмит: образы на кратных звуковой частоте слабые, но фильтра нет.
const IQM_D=63;
const IQM_H=(()=>{ const h=new Float32Array(IQM_D+1);      // h[k] — нечётные k, антисимметричная
  for(let k=1;k<=IQM_D;k+=2) h[k]=2/(Math.PI*k)*(0.54+0.46*Math.cos(Math.PI*k/(IQM_D+1)));
  return h; })();
def({ id:'iqMod', title:'IQ Modulator', cat:'IQ',
  ins:[{n:'in',t:'sig'},{n:'fc',t:'num'},{n:'off',t:'num'}], outs:[{n:'iq',t:'iq'}], readout:true,
  params:[{n:'mode',t:'select',opts:['NFM','WFM','AM','USB','LSB'],d:'NFM'},
          {n:'sr',t:'select',opts:['2000000','2048000','2400000','8000000','10000000','12000000','16000000','20000000'],d:'2000000',label:'sample rate'},
          {n:'fc',t:'num',d:100000000,label:'center frequency, Hz'},
          {n:'off',t:'num',d:100000,label:'carrier offset from center, Hz (transmit on center + offset)'},
          {n:'dev',t:'range',min:500,max:100000,step:100,d:5000,log:true,label:'FM deviation, Hz'},
          {n:'depth',t:'range',min:0,max:1,step:.01,d:.8,label:'AM depth'},
          {n:'lvl',t:'range',min:-60,max:0,step:1,d:-6,label:'output level, dBFS'}],
  init:n=>{ n.t=0; n.th=0; n.ext=new Float32Array(3+BLOCK); n.hist=new Float32Array(2*IQM_D); n.hb=null; n.state='no input'; },
  process(n,I){
    const sr=+n.p.sr, fc=pv(n,I,'fc'), off=pv(n,I,'off'), mode=n.p.mode, step=Eng.sr/sr;
    const s=iqStream(n,'iq',sr,fc);
    if(n.ext.length!==3+BLOCK){ n.ext=new Float32Array(3+BLOCK); n.t=0; }
    const A=n.ext, B=n.hb && n.hb.length===A.length ? n.hb : (n.hb=new Float32Array(A.length));
    A.copyWithin(0,BLOCK,BLOCK+3); B.copyWithin(0,BLOCK,BLOCK+3);   // последние 3 отсчёта прошлого блока
    const x=I.in, ssb=mode==='USB'||mode==='LSB', H=IQM_H, hist=n.hist, ext=new Float32Array(hist.length+BLOCK);
    ext.set(hist); if(x) ext.set(x.subarray(0,BLOCK),hist.length);
    for(let i=0;i<BLOCK;i++){
      const c=i+IQM_D;                                    // середина окна в ext
      A[3+i]=ext[c];
      if(ssb){ let y=0; for(let k=1;k<=IQM_D;k+=2) y+=H[k]*(ext[c-k]-ext[c+k]); B[3+i]=y; }
    }
    hist.set(ext.subarray(BLOCK));
    const K=Math.ceil((BLOCK-n.t)/step), re=new Float32Array(K), im=new Float32Array(K);
    const g=Math.pow(10,n.p.lvl/20), dev=n.p.dev, depth=n.p.depth, sgn=mode==='LSB' ? -1 : 1;
    const wOff=2*Math.PI*off/sr, wDev=2*Math.PI*dev/sr;
    let t=n.t, th=n.th, k=0;
    while(t<BLOCK && k<K){
      const m=Math.floor(t), f=t-m;
      const a=herm(A[m],A[m+1],A[m+2],A[m+3],f);
      if(ssb){
        const b=sgn*herm(B[m],B[m+1],B[m+2],B[m+3],f), cs=Math.cos(th), sn=Math.sin(th);
        re[k]=g*(a*cs-b*sn); im[k]=g*(a*sn+b*cs);
        th+=wOff;
      } else if(mode==='AM'){
        const e=g*(1+depth*a)/(1+depth);
        re[k]=e*Math.cos(th); im[k]=e*Math.sin(th);
        th+=wOff;
      } else {
        re[k]=g*Math.cos(th); im[k]=g*Math.sin(th);
        th+=wOff+wDev*(mode==='WFM' ? a*15 : a);          // WFM: девиация ×15 от «dev» (5 кГц → 75 кГц)
      }
      k++; t+=step;
    }
    n.t=t-BLOCK; n.th=th%(2*Math.PI);
    iqPush(s, k===K ? re : re.subarray(0,k), k===K ? im : im.subarray(0,k));
    n.state=mode+' · '+((fc+off)/1e6).toFixed(4)+' MHz · '+(sr/1e6)+' MS/s'+(x ? '' : ' · no audio input');
    return {iq:s};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.state||''; }});
function herm(x0,x1,x2,x3,f){
  const c1=.5*(x2-x0), c2=x0-2.5*x1+2*x2-.5*x3, c3=.5*(x3-x0)+1.5*(x1-x2);
  return ((c3*f+c2)*f+c1)*f+x1;
}

/* ---- IQ → Audio / IQ → I/Q ---- */
// Мост в домен движка: кольцо + дробный ресемплер (кубический Эрмит) с частоты потока на Eng.sr.
// Часы источника (донгл, файл) и звуковой карты расходятся — шаг чтения подстраивается по
// запасу в кольце (его минимуму за 0.5 с) в пределах ±IQA_MAX_PPM. Недобор — тишина до
// восстановления запаса. Прореживать до ~звуковой частоты нужно до моста: сам он фильтра не имеет.
// Тело моста общее для двух блоков: IQ → Audio (out, q) и IQ → I/Q (I, Q) — iqBridge возвращает {out, q, fill}.
const IQA_MAX_PPM=2000;
function iqBridge(n,I){
  const out=buf(n,'out'), oq=buf(n,'q');
  const s=iqIn(I,'in');
  if(!s || !s.sr){ out.fill(0); oq.fill(0); n.state='no input'; return {out, q:oq, fill:null}; }
  if(s.sr!==n.sr){                             // новая частота — новое кольцо (2 с)
    n.sr=s.sr; n.size=pow2ge(Math.max(s.sr*2, BLOCK*8));
    n.rr=new Float32Array(n.size); n.ri=new Float32Array(n.size);
    n.W=0; n.pos=0; n.rebuf=true; n.floor=0; n.ppm=0; n.drops=0; n.starves=0;
  }
  const mask=n.size-1, rr=n.rr, ri=n.ri;
  for(const c of s.chunks){
    const xr=c.re, xi=c.im, K=xr.length;
    let w=n.W;
    for(let i=0;i<K;i++,w++){ rr[w&mask]=xr[i]; ri[w&mask]=xi?xi[i]:0; }
    n.W=w;
  }
  const ratio=s.sr/Eng.sr, target=Math.max(s.sr*n.p.lat/1000, ratio*BLOCK*2);
  let fill=n.W-n.pos;
  if(fill>n.size-ratio*BLOCK*2){ n.pos=n.W-target; fill=target; n.drops++; }   // кольцо на исходе
  const g=Math.pow(10,n.p.gain/20);
  if(n.rebuf){
    if(fill>=target){ n.rebuf=false; n.pos=n.W-target; fill=target;             // излишек пришедшего чанка — сразу в сброс
      n.floor=target; n.wMin=Infinity; n.wT=0; n.win=0; }
    else { out.fill(0); oq.fill(0); n.state='buffering'; return {out, q:oq, fill:1000*fill/s.sr}; }
  }
  // Запас — по минимуму за окно 0.5 с: данные приходят пачками (воркер, USB), дно этой пилы
  // и есть запас, от размера пачек оно не зависит. Через 1 с после старта излишек (то, что было
  // в пути, пока воркер разгонялся) сбрасывается разом; потом — только плавная подстройка,
  // а сброс — если запас вырос в полтора раза (скачок источника).
  n.wMin=Math.min(n.wMin,fill); n.wT+=BLOCK;
  if(n.wT>=Eng.sr/2){
    const m=n.wMin; n.wMin=Infinity; n.wT=0; n.win++;
    if(n.win===2 && m>target*1.1 || m>target*1.5){ n.pos+=m-target; fill-=m-target; n.floor=target; if(n.win>2) n.drops++; }
    else n.floor=n.win===1 ? m : n.floor+0.3*(m-n.floor);
  }
  n.ppm=clamp(1e4*(n.floor-target)/target, -IQA_MAX_PPM, IQA_MAX_PPM);   // П-регулятор: +10% запаса → +1000 ppm
  const step=ratio*(1+n.ppm*1e-6);
  if(fill<step*BLOCK+3){ n.rebuf=true; n.starves++; out.fill(0); oq.fill(0); n.state='starved'; return {out, q:oq, fill:1000*fill/s.sr}; }
  let pos=n.pos;
  for(let i=0;i<BLOCK;i++,pos+=step){
    const k=Math.floor(pos), t=pos-k;
    const i0=(k-1)&mask, i1=k&mask, i2=(k+1)&mask, i3=(k+2)&mask;
    out[i]=g*herm(rr[i0],rr[i1],rr[i2],rr[i3],t);
    oq[i]=g*herm(ri[i0],ri[i1],ri[i2],ri[i3],t);
  }
  n.pos=pos;
  n.state=(s.sr/1000)+' → '+(Eng.sr/1000)+' kS/s · '+(1000*fill/s.sr).toFixed(0)+' ms · '+
    (n.ppm>=0?'+':'')+n.ppm.toFixed(0)+' ppm'+(s.sr>1.5*Eng.sr ? ' · decimate first!' : '');
  return {out, q:oq, fill:1000*fill/s.sr};
}
def({ id:'iqAudio', title:'IQ → Audio', cat:'IQ', lod:'dot',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'sig'},{n:'q',t:'sig'},{n:'fill',t:'num'}],
  readout:true,
  params:[{n:'lat',t:'range',min:20,max:500,step:5,d:100,label:'buffer (minimum kept), ms'},
          {n:'gain',t:'range',min:-40,max:20,step:1,d:0,label:'gain, dB'}],
  init:n=>{ n.sr=0; },
  process:iqBridge,
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.state||''; }});

// Расщепление: поток 'iq' → два сигнала движка I и Q (обратно к I/Q → IQ). Внутри тот же мост
// (кольцо + ресемплер на Eng.sr), поэтому поток нужно предварительно прореживать до ~звуковой частоты.
def({ id:'iqSplit', title:'IQ → I/Q', cat:'IQ',
  ins:[{n:'in',t:'iq'}], outs:[{n:'I',t:'sig'},{n:'Q',t:'sig'},{n:'fill',t:'num'}],
  readout:true,
  params:[{n:'lat',t:'range',min:20,max:500,step:5,d:100,label:'buffer (minimum kept), ms'},
          {n:'gain',t:'range',min:-40,max:20,step:1,d:0,label:'gain, dB'},
          {n:'swap',t:'check',d:false,label:'swap I and Q (mirror the spectrum)'}],
  init:n=>{ n.sr=0; },
  process(n,I){
    const r=iqBridge(n,I);
    return n.p.swap ? {I:r.q, Q:r.out, fill:r.fill} : {I:r.out, Q:r.q, fill:r.fill};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.state||''; }});
function herm(y0,y1,y2,y3,t){
  const c1=0.5*(y2-y0), c2=y0-2.5*y1+2*y2-0.5*y3, c3=0.5*(y3-y0)+1.5*(y1-y2);
  return ((c3*t+c2)*t+c1)*t+y1;
}
