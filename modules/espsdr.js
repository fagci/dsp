/* ============================ ESP-SDR ============================ */
// ESP32 как «SDR» по проекту ESPARGOS/esp-sdr: сырые I/Q с отладочного тракта АЦП, WebSerial.
// Протокол: команда "XXX\n" → текстовая строка ответа; CAP16 дальше даёт двоичные I/Q.
// CAP16 <samples> <rate-idx> → "DATA <samples> <crc32-hex> <µs>" + samples×(int8 I, int8 Q).
// Захват коротким окном (низкая скважность): спектр считаем БПФ в браузере, пропуски между снимками неизбежны.
// Индексы скорости 0–6: 80, 40, 20, 10, 8, 4, 16 МС/с (набор зависит от чипа, смотреть LIMITS?).

const ESP_RATES=[80e6,40e6,20e6,10e6,8e6,4e6,16e6];
const ESP_ENC=new TextEncoder();
let ESP_CRC_T=null;
function espCrc32(b){
  if(!ESP_CRC_T){
    ESP_CRC_T=new Uint32Array(256);
    for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c=c&1?0xEDB88320^(c>>>1):c>>>1; ESP_CRC_T[n]=c>>>0; }
  }
  let c=0xFFFFFFFF;
  for(let i=0;i<b.length;i++) c=ESP_CRC_T[(c^b[i])&255]^(c>>>8);
  return (c^0xFFFFFFFF)>>>0;
}

// приём: общий буфер, читатели ждут нужное число байт / строку
function espPush(n, chunk){
  if(n.rxLen+chunk.length>n.rx.length){
    const b=new Uint8Array(Math.max(n.rx.length*2, n.rxLen+chunk.length));
    b.set(n.rx.subarray(0,n.rxLen)); n.rx=b;
  }
  n.rx.set(chunk, n.rxLen); n.rxLen+=chunk.length;
  espWake(n);
}
function espWake(n){
  const w=n.rxWait; if(!w) return;
  const r=w.try();
  if(r!==undefined){ n.rxWait=null; clearTimeout(w.timer); w.resolve(r); }
}
function espTake(n, k){
  const out=n.rx.slice(0,k);
  n.rx.copyWithin(0, k, n.rxLen); n.rxLen-=k;
  return out;
}
function espWait(n, tryFn, timeout, what){
  return new Promise((resolve,reject)=>{
    if(!n.connected) return reject(new Error('not connected'));
    n.rxWait={try:tryFn, resolve, reject, timer:setTimeout(()=>{ n.rxWait=null; reject(new Error('timeout: '+what)); }, timeout)};
    espWake(n);
  });
}
function espBytes(n, k, timeout=5000){
  return espWait(n, ()=>n.rxLen>=k ? espTake(n,k) : undefined, timeout, k+' bytes');
}
function espLine(n, timeout=3000){
  return espWait(n, ()=>{
    const i=n.rx.subarray(0,n.rxLen).indexOf(10);
    if(i<0) return undefined;
    return new TextDecoder().decode(espTake(n,i+1)).trim();
  }, timeout, 'reply');
}
function espSend(n, cmd){ return n.writer.write(ESP_ENC.encode(cmd+'\n')); }

async function espReadLoop(n){
  const reader=n.port.readable.getReader(); n.reader=reader;
  try{
    while(n.connected){
      const {value,done}=await reader.read();
      if(done) break;
      if(value) espPush(n, value);
    }
    if(n.connected){ n.status='port closed by device'; espTeardown(n); }
  }catch(e){
    if(n.connected){ n.status='read error: '+e.message; espTeardown(n); }
  }
}

async function espTeardown(n){
  n.connected=false; n.connecting=false;
  if(n.rxWait){ clearTimeout(n.rxWait.timer); n.rxWait.reject(new Error('disconnected')); n.rxWait=null; }
  if(n.reader){ try{ await n.reader.cancel(); }catch(e){} try{ n.reader.releaseLock(); }catch(e){} n.reader=null; }
  if(n.writer){ try{ n.writer.releaseLock(); }catch(e){} n.writer=null; }
  if(n.port){ try{ await n.port.close(); }catch(e){} n.port=null; }
}
function espDisconnect(n){
  const w=n.writer; n.status='disconnected';
  if(w && n.connected) w.write(ESP_ENC.encode('RELEASE\n')).catch(()=>{});
  espTeardown(n);
}

// после открытия порта в буфере может быть мусор — SYNC с nonce, читаем до эха
async function espSync(n){
  for(let i=0;i<5;i++){
    const nonce=String(Math.floor(Math.random()*1e9));
    try{
      await espSend(n, 'SYNC '+nonce);
      for(let j=0;j<8;j++){
        const s=await espLine(n, 800);
        if(s.includes(nonce)) return;
      }
    }catch(e){ if(!n.connected) throw e; }
    n.rxLen=0;
  }
  throw new Error('no reply to SYNC (wrong baud rate or not an ESP-SDR firmware)');
}

async function espQuery(n, cmd){
  await espSend(n, cmd);
  const s=await espLine(n, 3000);
  if(/^ERR/.test(s)) throw new Error(s);
  return s;
}

async function espConnect(n){
  if(n.connecting) return;
  await espTeardown(n);
  if(!navigator.serial){ n.status='WebSerial unavailable (needs Chrome/Edge, HTTPS)'; return; }
  n.connecting=true; n.status='choose a port…';
  try{
    const port=await navigator.serial.requestPort();
    await port.open({baudRate:+n.p.baud||2000000, bufferSize:262144});
    n.port=port; n.writer=port.writable.getWriter(); n.rxLen=0;
    n.connecting=false; n.connected=true; n.applied={};
    espReadLoop(n);
    await espSync(n);
    n.info=await espQuery(n,'INFO');
    try{
      const r=/^RANGE\s+(\d+)\s+(\d+)/.exec(await espQuery(n,'RANGE?'));
      if(r){ n.rangeLo=+r[1]; n.rangeHi=+r[2]; }
    }catch(e){ if(!n.connected) throw e; }
    n.status='connected: '+n.info;
    espLoop(n);
  }catch(e){
    n.connecting=false;
    n.status=e.name==='NotFoundError' ? 'no port selected' : 'error: '+e.message;
    await espTeardown(n);
  }
}

// настройки, отличающиеся от применённых, — командами
async function espApply(n){
  let f=Math.round(+n.p.freq||0);
  if(n.rangeLo!=null) f=Math.min(n.rangeHi, Math.max(n.rangeLo, f));
  const w={freq:'FREQ '+f};
  if(+n.p.bw>0) w.bw='BANDWIDTH '+(+n.p.bw);
  for(const k of Object.keys(w)){
    if(n.applied[k]===w[k]) continue;
    await espQuery(n, w[k]);
    n.applied[k]=w[k];
  }
  n.freqHz=f*1e6;
}

async function espCapture(n){
  const N=+n.p.size, rate=+n.p.rate;
  await espSend(n, `CAP16 ${N} ${rate}`);
  const head=await espLine(n, 5000);
  const h=/^DATA (\d+) ([0-9a-fA-F]{1,8}) (\d+)$/.exec(head);
  if(!h){ if(/^ERR/.test(head)) throw new Error(head); throw new Error('bad reply: '+head.slice(0,40)); }
  if(+h[1]!==N) throw new Error('capture length '+h[1]+' ≠ '+N);
  const bytes=await espBytes(n, N*2, 5000+N);
  if(espCrc32(bytes)!==parseInt(h[2],16)) throw new Error('CRC mismatch');
  return bytes;
}

// снимок → спектр: окно Ханна, усреднение мощности по сегментам окна захвата
function espSpectrum(n, bytes){
  const N=bytes.length>>1, sr=ESP_RATES[+n.p.rate]||80e6;
  const M=Math.min(N, Math.max(64, +n.p.fft||1024));
  const segs=Math.max(1, Math.floor(N/M));
  const re=new Float64Array(M), im=new Float64Array(M), acc=new Float64Array(M);
  const win=new Float64Array(M); let wp=0;
  for(let i=0;i<M;i++){ win[i]=.5-.5*Math.cos(2*Math.PI*i/(M-1)); wp+=win[i]*win[i]; }
  for(let s=0;s<segs;s++){
    for(let i=0;i<M;i++){
      const o=(s*M+i)*2;
      re[i]=((bytes[o]<<24)>>24)*win[i]; im[i]=((bytes[o+1]<<24)>>24)*win[i];
    }
    fft(re,im);
    for(let i=0;i<M;i++) acc[i]+=re[i]*re[i]+im[i]*im[i];
  }
  // fftshift: -sr/2 … +sr/2; шкала — дБ относительно 1 ед. АЦП (int8), не абсолютная
  const mag=new Float32Array(M), freqs=new Float64Array(M), fc=n.freqHz;
  let pk=0;
  for(let i=0;i<M;i++){
    const k=(i+(M>>1))%M, p=acc[k]/(segs*wp*M);
    mag[i]=Math.sqrt(p)+1e-12;
    freqs[i]=fc+(i-(M>>1))*sr/M;
    if(mag[i]>mag[pk]) pk=i;
  }
  n.spec={mag, freqs, sr, size:M, rev:(n.spec?.rev|0)+1};
  n.peakF=freqs[pk]; n.peakDb=20*Math.log10(mag[pk]);
}

async function espResync(n){ try{ n.rxLen=0; await espSync(n); }catch(e){} }

async function espLoop(n){
  if(n.looping) return;
  n.looping=true;
  try{
    while(n.connected){
      try{
        await espApply(n);
        if(n.p.hold){ await new Promise(r=>setTimeout(r,150)); continue; }
        const t0=performance.now();
        espSpectrum(n, await espCapture(n));
        n.capMs=performance.now()-t0; n.err=null;
      }catch(e){
        if(!n.connected) break;
        n.err=e.message; n.applied={};
        await espResync(n);
      }
    }
  }finally{ n.looping=false; }
}

def({ id:'espsdr', lazy:'manual', title:'ESP-SDR (ESP32)', cat:'Sources',
  ins:[{n:'freq',t:'num'},{n:'steerFreq',t:'num'}],
  outs:[{n:'spec',t:'spec'},{n:'peakF',t:'num'},{n:'peakDb',t:'num'}],
  view:{h:120}, readout:true, tall:true,
  params:[
    {n:'connect',t:'button',label:'Connect',fn:n=>espConnect(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>espDisconnect(n)},
    {n:'freq',t:'range',min:100,max:6000,step:1,d:2437,label:'frequency, MHz'},
    {n:'rate',t:'select',opts:['0','1','2','3','4','5','6'],d:'1',label:'rate index (80/40/20/10/8/4/16 MS/s)'},
    {n:'size',t:'select',opts:['1024','2048','4096','8190'],d:'4096',label:'samples per burst'},
    {n:'fft',t:'select',opts:['256','512','1024','2048','4096'],d:'1024',label:'FFT size'},
    {n:'bw',t:'range',min:0,max:60,step:1,d:0,label:'analog bandwidth, MHz (0 = widest)'},
    {n:'hold',t:'check',d:false,label:'hold'},
    {n:'baud',t:'select',opts:['2000000','1000000','115200'],d:'2000000',label:'UART baud rate',adv:true},
  ],
  init:n=>{
    n.port=null; n.reader=null; n.writer=null; n.connected=false; n.connecting=false; n.looping=false;
    n.rx=new Uint8Array(65536); n.rxLen=0; n.rxWait=null; n.applied={};
    n.info=''; n.rangeLo=null; n.rangeHi=null; n.freqHz=0;
    n.spec=null; n.peakF=0; n.peakDb=-150; n.capMs=null; n.err=null; n.status='not connected';
  },
  dispose:n=>{ espTeardown(n).catch(e=>console.error('espsdr dispose:',e)); },
  process(n,I){
    const v=I.freq;
    if(typeof v==='number' && v!==n._inFreq){ n._inFreq=v; setMod(n,'freq',v*1e-6); }
    // steerFreq (centerFreq у 'sa') — перестройка по перетаскиванию спектра; мелочь < 1 бина не трогаем
    const sf=I.steerFreq;
    if(typeof sf==='number' && sf!==n._inSteer){
      n._inSteer=sf;
      if(n.spec && sf>0 && Math.abs(sf-n.freqHz)>=1e6) setMod(n,'freq',Math.round(sf/1e6));
    }
    return {spec:n.spec, peakF:n.peakF, peakDb:n.peakDb};
  },
  drawKey:n=>n.status+'|'+n.connected+'|'+n.spec?.rev+'|'+n.capMs+'|'+n.err,
  draw(n,cv,cx){
    const r=n.el.querySelector('.readout');
    if(r){
      let s=n.status;
      if(n.connected){
        s+=` · ${fmtHz(n.freqHz,3)}Hz`+(n.capMs!=null?` · ${n.capMs.toFixed(0)} ms/burst`:'')+
          (n.spec?` · peak ${fmtHz(n.peakF,3)}Hz ${n.peakDb.toFixed(1)} dB (rel.)`:'');
      }
      if(n.err) s+=' · error: '+n.err;
      if(r.textContent!==s) r.textContent=s;
    }
    cx.clearRect(0,0,cv.width,cv.height);
  }
});
