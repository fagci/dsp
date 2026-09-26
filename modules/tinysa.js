/* ============================ tinySA ============================ */
// Анализатор спектра tinySA / tinySA Ultra через WebSerial (USB CDC, 0483:5740).
// Протокол — текстовая консоль: "команда\r" → эхо команды, ответ, приглашение "ch> ".
// Спектр: scanraw (двоичный, любое число точек) или scan (текст, до 290/450 точек).
// scanraw: '{' + points×('x', uint16 LE) + '}', дБм = raw/32 − ZERO_LEVEL (128 у tinySA, 174 у Ultra).
// capture: экран в RGB565 big-endian, 320×240 (tinySA) или 480×320 (Ultra).

const TSA_PROMPT='ch> ';
const TSA_ENC=new TextEncoder(), TSA_DEC=new TextDecoder();

function tsaRxReset(n){ n.rxLen=0; }
function tsaRxPush(n, chunk){
  if(n.rxLen+chunk.length>n.rx.length){
    const b=new Uint8Array(Math.max(n.rx.length*2, n.rxLen+chunk.length));
    b.set(n.rx.subarray(0,n.rxLen)); n.rx=b;
  }
  n.rx.set(chunk, n.rxLen); n.rxLen+=chunk.length;
  tsaRxCheck(n);
}
function tsaEndsWithPrompt(n){
  const L=n.rxLen, P=TSA_PROMPT; if(L<P.length) return false;
  for(let i=0;i<P.length;i++) if(n.rx[L-P.length+i]!==P.charCodeAt(i)) return false;
  return true;
}
function tsaRxCheck(n){
  const w=n.rxWait; if(!w) return;
  if(n.rxLen>=w.minLen && tsaEndsWithPrompt(n)){
    n.rxWait=null; clearTimeout(w.timer);
    w.resolve(n.rx.slice(0, n.rxLen-TSA_PROMPT.length));
  }
}

async function tsaReadLoop(n){
  const reader=n.port.readable.getReader(); n.reader=reader;
  try{
    while(n.connected){
      const {value,done}=await reader.read();
      if(done) break;
      if(value) tsaRxPush(n, value);
    }
    if(n.connected){ n.status='port closed by device'; tsaTeardown(n); }
  }catch(e){
    if(n.connected){ n.status='read error: '+e.message; tsaTeardown(n); }
  }
}

// minLen — для двоичных ответов: "ch> " может встретиться внутри данных
function tsaCmd(n, cmd, {timeout=5000, minLen=0}={}){
  if(!n.connected) return Promise.reject(new Error('not connected'));
  tsaRxReset(n);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ n.rxWait=null; reject(new Error('timeout: '+cmd)); }, timeout);
    n.rxWait={resolve, reject, timer, minLen};
    n.writer.write(TSA_ENC.encode(cmd+'\r')).catch(e=>{
      if(n.rxWait){ clearTimeout(timer); n.rxWait=null; reject(e); } });
  });
}
// ответ без эха команды
function tsaBody(bytes){
  const i=bytes.indexOf(10);
  return i<0 ? new Uint8Array(0) : bytes.subarray(i+1);
}
async function tsaText(n, cmd, opt){ return TSA_DEC.decode(tsaBody(await tsaCmd(n, cmd, opt))).trim(); }

async function tsaTeardown(n){
  n.connected=false; n.connecting=false;
  if(n.rxWait){ clearTimeout(n.rxWait.timer); n.rxWait.reject(new Error('disconnected')); n.rxWait=null; }
  if(n.reader){ try{ await n.reader.cancel(); }catch(e){} try{ n.reader.releaseLock(); }catch(e){} n.reader=null; }
  if(n.writer){ try{ n.writer.releaseLock(); }catch(e){} n.writer=null; }
  if(n.port){ try{ await n.port.close(); }catch(e){} n.port=null; }
}
function tsaDisconnect(n){ n.status='disconnected'; tsaTeardown(n); }

async function tsaConnect(n){
  if(n.connecting) return;
  await tsaTeardown(n);
  if(!navigator.serial){ n.status='WebSerial unavailable (needs Chrome/Edge, HTTPS)'; return; }
  n.connecting=true; n.status='choose a port…';
  try{
    const port=await navigator.serial.requestPort({filters:[{usbVendorId:0x0483, usbProductId:0x5740}]});
    await port.open({baudRate:115200, bufferSize:65536});
    n.port=port; n.writer=port.writable.getWriter();
    n.connecting=false; n.connected=true; n.applied={};
    tsaReadLoop(n);
    // хвост недописанной команды и мусор после перезапуска — пара пустых строк до приглашения
    for(let i=0;i<3;i++){ try{ await tsaCmd(n,'',{timeout:700}); break; }catch(e){} }
    n.version=(await tsaText(n,'version')).split(/\r?\n/)[0]||'?';
    n.ultra=/tinySA4/i.test(n.version);
    n.status='connected: '+n.version;
    tsaLoop(n);
  }catch(e){
    n.connecting=false;
    n.status=e.name==='NotFoundError' ? 'no port selected' : 'error: '+e.message;
    await tsaTeardown(n);
  }
}

function tsaRange(n){
  const a=(+n.p.start||0)*1e6, b=(+n.p.stop||0)*1e6;
  return [Math.max(0,Math.round(Math.min(a,b))), Math.max(0,Math.round(Math.max(a,b)))];
}
function tsaZero(n){ return n.p.zero==='auto' ? (n.ultra?174:128) : +n.p.zero; }

// настройки, отличающиеся от применённых, — командами; ключ → строка команды
function tsaWanted(n){
  const p=n.p, w={};
  if(p.gen){
    w.mode='mode '+p.genPort+' output';
    w.freq='freq '+Math.round((+p.genFreq||0)*1e6);
    w.level='level '+(+p.genLevel).toFixed(1);
    w.output='output '+(p.genOn?'on':'off');
  }else{
    w.mode='mode low input';
    w.rbw='rbw '+p.rbw;
    w.att='attenuate '+p.att;
    w.spur='spur '+(p.spur?'on':'off');
    if(n.ultra) w.lna='lna '+(p.lna?'on':'off');
  }
  return w;
}
async function tsaApply(n){
  const w=tsaWanted(n);
  // смена режима сбрасывает остальное на приборе — перепослать всё
  if(w.mode!==n.applied.mode) n.applied={};
  for(const k of Object.keys(w)){
    if(n.applied[k]===w[k]) continue;
    await tsaCmd(n, w[k]);
    n.applied[k]=w[k];
  }
}

async function tsaScanRaw(n, lo, hi, pts){
  const need=pts*3+2;
  const bytes=tsaBody(await tsaCmd(n, `scanraw ${lo} ${hi} ${pts}`,
    {timeout:20000+pts*20, minLen:need}));
  const s=bytes.indexOf(0x7b);                      // '{'
  if(s<0 || bytes.length<s+need || bytes[s+need-1]!==0x7d) throw new Error('bad scanraw frame');
  const zero=tsaZero(n), db=new Float32Array(pts);
  for(let i=0;i<pts;i++){ const o=s+1+i*3; db[i]=(bytes[o+1]|(bytes[o+2]<<8))/32-zero; }
  const fr=new Float64Array(pts), st=pts>1?(hi-lo)/(pts-1):0;
  for(let i=0;i<pts;i++) fr[i]=lo+i*st;
  return {db, fr};
}
async function tsaScanText(n, lo, hi, pts){
  pts=Math.min(pts, n.ultra?450:290);
  const txt=await tsaText(n, `scan ${lo} ${hi} ${pts} 3`, {timeout:20000+pts*20});
  const db=[], fr=[];
  for(const ln of txt.split(/\r?\n/)){
    const t=ln.trim().split(/\s+/);
    if(t.length<2) continue;
    const f=+t[0], v=+t[1];
    if(isFinite(f) && isFinite(v)){ fr.push(f); db.push(v); }
  }
  if(!db.length) throw new Error('empty scan');
  return {db:Float32Array.from(db), fr:Float64Array.from(fr)};
}

async function tsaScan(n){
  const [lo,hi]=tsaRange(n), pts=Math.max(2, +n.p.points||450);
  const t0=performance.now();
  let r;
  if(n.p.fmt==='raw'){
    try{ r=await tsaScanRaw(n, lo, hi, pts); }
    catch(e){
      if(!n.connected) throw e;
      // старые прошивки без scanraw — дальше текстом
      n.p.fmt='text'; n.set?.fmt?.('text'); n.note='scanraw failed ('+e.message+'), switched to text';
      await tsaResync(n);
      return;
    }
  }else r=await tsaScanText(n, lo, hi, pts);
  const N=r.db.length, mag=new Float32Array(N);
  let pk=0;
  for(let i=0;i<N;i++){ mag[i]=Math.pow(10, r.db[i]/20); if(r.db[i]>r.db[pk]) pk=i; }
  const bin=N>1 ? (r.fr[N-1]-r.fr[0])/(N-1) : 1;
  n.spec={mag, freqs:r.fr, sr:bin*N, size:N, rev:(n.spec?.rev|0)+1};
  n.peakF=r.fr[pk]; n.peakDb=r.db[pk];
  n.scanMs=performance.now()-t0;
}

async function tsaResync(n){
  for(let i=0;i<3;i++){ try{ await tsaCmd(n,'',{timeout:1500}); return; }catch(e){} }
}

async function tsaCapture(n){
  const W=n.ultra?480:320, H=n.ultra?320:240, need=W*H*2;
  const b=tsaBody(await tsaCmd(n,'capture',{timeout:15000, minLen:need}));
  if(b.length<need) throw new Error('short capture');
  const img=new ImageData(W,H), d=img.data;
  for(let i=0;i<W*H;i++){
    const v=(b[2*i]<<8)|b[2*i+1], o=i*4;
    d[o]=((v>>11)&31)*255/31; d[o+1]=((v>>5)&63)*255/63; d[o+2]=(v&31)*255/31; d[o+3]=255;
  }
  n.capCv.width=W; n.capCv.height=H; n.capCv.getContext('2d').putImageData(img,0,0);
  n.img={data:img, w:W, h:H, gray:false};
}

async function tsaLoop(n){
  if(n.looping) return;
  n.looping=true;
  try{
    while(n.connected){
      try{
        await tsaApply(n);
        if(n.capReq){ n.capReq=false; await tsaCapture(n); }
        if(n.p.gen || n.p.hold){ await new Promise(r=>setTimeout(r,150)); continue; }
        await tsaScan(n);
        n.err=null;
      }catch(e){
        if(!n.connected) break;
        n.err=e.message; n.applied={};
        await tsaResync(n);
      }
    }
  }finally{ n.looping=false; }
}

def({ id:'tinysa', title:'tinySA', cat:'Sources',
  ins:[{n:'start',t:'num'},{n:'stop',t:'num'},{n:'steerFreq',t:'num'},
       {n:'genFreq',t:'num'},{n:'genLevel',t:'num'}],
  outs:[{n:'spec',t:'spec'},{n:'peakF',t:'num'},{n:'peakDb',t:'num'},{n:'img',t:'img'}],
  view:{h:140}, readout:true, tall:true,
  params:[
    {n:'connect',t:'button',label:'Connect',fn:n=>tsaConnect(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>tsaDisconnect(n)},
    {n:'start',t:'num',d:88,label:'start, MHz'},
    {n:'stop',t:'num',d:108,label:'stop, MHz'},
    {n:'points',t:'select',opts:['101','290','450','1000','2000','5000','10000'],d:'450',label:'points'},
    {n:'rbw',t:'select',opts:['auto','0.2','1','3','10','30','100','300','600','850'],d:'auto',label:'RBW, kHz'},
    {n:'att',t:'select',opts:['auto','0','5','10','15','20','25','30'],d:'auto',label:'attenuation, dB'},
    {n:'hold',t:'check',d:false,label:'hold'},
    {n:'capture',t:'button',label:'Screenshot',fn:n=>{ n.capReq=true; }},
    {n:'savePng',t:'button',label:'Save PNG',fn:n=>{
      if(!n.img) return;
      n.capCv.toBlob(b=>{ const a=document.createElement('a');
        a.href=URL.createObjectURL(b); a.download='tinysa.png'; a.click();
        setTimeout(()=>URL.revokeObjectURL(a.href),1000); }); }},
    // генератор: у tinySA — выход LOW (до ~350 МГц) и HIGH; у Ultra один разъём, high — выше 800 МГц
    {n:'gen',t:'check',d:false,label:'gen'},
    {n:'genPort',t:'select',opts:['low','high'],d:'low',label:'generator output'},
    {n:'genFreq',t:'num',d:100,label:'generator freq, MHz'},
    {n:'genLevel',t:'range',min:-115,max:13,step:.5,d:-30,label:'generator level, dBm'},
    {n:'genOn',t:'check',d:false,label:'RF on'},
    {n:'fmt',t:'select',opts:['raw','text'],d:'raw',label:'transfer format',adv:true},
    {n:'zero',t:'select',opts:['auto','128','174'],d:'auto',label:'scanraw zero level, dB',adv:true},
    {n:'spur',t:'check',d:true,label:'spur removal',adv:true},
    {n:'lna',t:'check',d:false,label:'LNA (Ultra)',adv:true},
  ],
  init:n=>{
    n.port=null; n.reader=null; n.writer=null; n.connected=false; n.connecting=false; n.looping=false;
    n.rx=new Uint8Array(65536); n.rxLen=0; n.rxWait=null; n.applied={};
    n.version=''; n.ultra=false; n.spec=null; n.peakF=0; n.peakDb=-150; n.scanMs=null;
    n.err=null; n.note=null; n.capReq=false; n.img=null; n.capCv=document.createElement('canvas');
    n.status='not connected';
  },
  dispose:n=>{ tsaTeardown(n).catch(e=>console.error('tinysa dispose:',e)); },
  process(n,I){
    // входы — по фронту, чтобы провод со старым значением не перебивал ручной ввод
    for(const [k,sc] of [['start',1e-6],['stop',1e-6],['genFreq',1e-6],['genLevel',1]]){
      const v=I[k];
      if(typeof v==='number' && v!==n['_in'+k]){ n['_in'+k]=v; setMod(n,k,v*sc); }
    }
    // steerFreq (centerFreq у 'sa') — сдвиг окна с сохранением полосы; мелочь < 2 бинов не трогаем,
    // иначе центр съезжает по полбина за проход (средняя точка оси ≠ центр при чётном числе точек).
    // До первого свипа 'sa' отдаёт центр своего диапазона по умолчанию — игнорируем.
    const sf=I.steerFreq;
    if(typeof sf==='number' && sf!==n._inSteer){
      n._inSteer=sf;
      const [lo,hi]=tsaRange(n), c=(lo+hi)/2, bin=(hi-lo)/Math.max(1,(+n.p.points||450)-1);
      if(n.spec && sf>0 && Math.abs(sf-c)>2*bin){
        const h=(hi-lo)/2;
        setMod(n,'start',(sf-h)/1e6); setMod(n,'stop',(sf+h)/1e6);
      }
    }
    return {spec:n.spec, peakF:n.peakF, peakDb:n.peakDb, img:n.img};
  },
  draw(n,cv,cx){
    const r=n.el.querySelector('.readout');
    if(r){
      let s=n.status;
      if(n.connected){
        const [lo,hi]=tsaRange(n);
        s+=n.p.gen ? ` · generator ${fmtHz((+n.p.genFreq||0)*1e6,3)}Hz ${(+n.p.genLevel).toFixed(1)} dBm ${n.p.genOn?'ON':'off'}`
          : ` · ${fmtHz(lo,3)}–${fmtHz(hi,3)}Hz`+(n.scanMs!=null?` · ${(n.scanMs/1000).toFixed(2)} s/sweep`:'')+
            (n.spec?` · peak ${fmtHz(n.peakF,3)}Hz ${n.peakDb.toFixed(1)} dBm`:'');
      }
      if(n.err) s+=' · error: '+n.err;
      if(n.note) s+=' · '+n.note;
      if(r.textContent!==s) r.textContent=s;
    }
    cx.clearRect(0,0,cv.width,cv.height);
    if(n.img){                                      // скриншот — с сохранением пропорций
      const k=Math.min(cv.width/n.img.w, cv.height/n.img.h), w=n.img.w*k, h=n.img.h*k;
      cx.drawImage(n.capCv,(cv.width-w)/2,(cv.height-h)/2,w,h);
    }
  }
});
