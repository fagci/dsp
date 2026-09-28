"use strict";
/* ============================ IQ: блоки на потоке 'iq' ============================ */
// Поток со своей частотой (см. iqStream в core-dsp.js): приёмник собирается проводами —
// источник → сдвиг → децимация → демодулятор → IQ → Audio (мост в домен Eng.sr).
// DSP — в modules/iq-kernels.js. Узлы с kernel движок собирает в острова и считает
// в воркере (см. core-islands.js), без воркеров — здесь же, в главном потоке.

const IQ_SR_OPTS=['48000','96000','192000','240000','250000','256000','1024000','2048000','2400000'];
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
          {n:'mode',t:'select',opts:['carrier','AM','FM','USB','LSB','off'],d:'FM'},
          {n:'off',t:'num',d:100000,label:'signal offset from center, Hz'},
          {n:'lvl',t:'range',min:-100,max:0,step:1,d:-20,label:'signal level, dBFS'},
          {n:'tone',t:'range',min:50,max:10000,step:1,d:1000,log:true,label:'modulating tone, Hz'},
          {n:'dev',t:'range',min:100,max:100000,step:100,d:5000,log:true,label:'FM deviation, Hz'},
          {n:'depth',t:'range',min:0,max:1,step:.01,d:.5,label:'AM depth'},
          {n:'noise',t:'range',min:-120,max:0,step:1,d:-60,label:'noise, dBFS'},
          {n:'ppm',t:'range',min:-1000,max:1000,step:1,d:0,label:'clock error vs sound card, ppm',adv:true}]},
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

defIQ({ id:'iqDemod', title:'IQ Demodulator', cat:'IQ',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'iq'}],
  params:[{n:'mode',t:'select',opts:['FM','AM','USB','LSB'],d:'FM'},
          {n:'dev',t:'range',min:500,max:100000,step:100,d:5000,log:true,label:'FM deviation, Hz'},
          {n:'deemph',t:'select',opts:['off','50 µs','75 µs'],d:'off',label:'FM de-emphasis'},
          {n:'bw',t:'range',min:500,max:5000,step:50,d:2700,label:'SSB bandwidth, Hz'},
          {n:'gain',t:'range',min:-20,max:40,step:1,d:0,label:'gain, dB'}]},
  n=>n.ui ? n.p.mode+' at '+(n.ui.sr/1000)+' kS/s' : 'no input');

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

/* ---- IQ → Audio ---- */
// Мост в домен движка: кольцо + дробный ресемплер (кубический Эрмит) с частоты потока на Eng.sr.
// Часы источника (донгл, файл) и звуковой карты расходятся — шаг чтения подстраивается по
// запасу в кольце в пределах ±IQA_MAX_PPM. Недобор — тишина до восстановления запаса,
// средний запас больше цели на 25% — сброс до цели. Прореживать до ~звуковой частоты нужно до моста:
// сам он фильтра не имеет.
const IQA_MAX_PPM=2000;
def({ id:'iqAudio', title:'IQ → Audio', cat:'IQ',
  ins:[{n:'in',t:'iq'}], outs:[{n:'out',t:'sig'},{n:'q',t:'sig'},{n:'fill',t:'num'}],
  readout:true,
  params:[{n:'lat',t:'range',min:20,max:500,step:5,d:100,label:'buffer, ms'},
          {n:'gain',t:'range',min:-40,max:20,step:1,d:0,label:'gain, dB'}],
  init:n=>{ n.sr=0; },
  process(n,I){
    const out=buf(n,'out'), oq=buf(n,'q');
    const s=iqIn(I,'in');
    if(!s || !s.sr){ out.fill(0); oq.fill(0); n.state='no input'; return {out, q:oq, fill:null}; }
    if(s.sr!==n.sr){                             // новая частота — новое кольцо (2 с)
      n.sr=s.sr; n.size=pow2ge(Math.max(s.sr*2, BLOCK*8));
      n.rr=new Float32Array(n.size); n.ri=new Float32Array(n.size);
      n.W=0; n.pos=0; n.rebuf=true; n.avg=0; n.ppm=0; n.drops=0; n.starves=0;
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
    // лишний запас (пачка после старта воркера, скачок источника) — сбросом, а не долгим стравливанием
    if(fill>n.size-ratio*BLOCK*2 || !n.rebuf && n.avg>target*1.25){ n.pos=n.W-target; fill=target; n.avg=target; n.drops++; }
    const g=Math.pow(10,n.p.gain/20);
    if(n.rebuf){
      if(fill>=target){ n.rebuf=false; n.pos=n.W-target; fill=target; n.avg=target; }   // излишек пришедшего чанка — сразу в сброс
      else { out.fill(0); oq.fill(0); n.state='buffering'; return {out, q:oq, fill:1000*fill/s.sr}; }
    }
    n.avg+=0.02*(fill-n.avg);
    n.ppm=clamp(2e4*(n.avg-target)/target, -IQA_MAX_PPM, IQA_MAX_PPM);   // П-регулятор: +10% запаса → +2000 ppm
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
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.state||''; }});
function herm(y0,y1,y2,y3,t){
  const c1=0.5*(y2-y0), c2=y0-2.5*y1+2*y2-0.5*y3, c3=0.5*(y3-y0)+1.5*(y1-y2);
  return ((c3*t+c2)*t+c1)*t+y1;
}
