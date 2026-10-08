"use strict";
let BLOCK = 512;                   // размер блока обработки (меняется на ходу)
const TYPE_COLOR = {sig:'var(--t-sig)',num:'var(--t-num)',spec:'var(--t-spec)',
                    img:'var(--t-img)',txt:'var(--t-txt)',blk:'var(--t-blk)',val:'var(--acc)',bands:'var(--t-bands)',rec:'var(--t-rec)',
                    trk:'var(--t-trk)',iq:'var(--t-iq)',vid:'var(--t-vid)'};
// Canvas 2D (в отличие от SVG/CSS) не резолвит var(...) сам — цвет для fillStyle/strokeStyle
// нужен уже вычисленным. Общий кэш на все модули разом: одна getComputedStyle раз в 0.5с на
// переменную, а не по разу на каждый canvas-узел на каждый кадр (их десятки, кадров 60/с).
const ThemeColorCache={vals:{},t:0};
function themeColor(name){
  const now=performance.now();
  if(now-ThemeColorCache.t>500){ ThemeColorCache.vals={}; ThemeColorCache.t=now; }
  return ThemeColorCache.vals[name] ||
    (ThemeColorCache.vals[name]=getComputedStyle(document.body).getPropertyValue(name).trim());
}
// цвет токена темы с прозрачностью: themeRgba('--scr-hi',.1) — «белая» подсветка на тёмном экране, тёмная на светлом
function themeRgba(name,a){
  const h=themeColor(name).replace('#','');
  const f=h.length===3?h.replace(/./g,'$&$&'):h;
  return 'rgba('+parseInt(f.slice(0,2),16)+','+parseInt(f.slice(2,4),16)+','+parseInt(f.slice(4,6),16)+','+a+')';
}
// порядок разделов в палитре — иначе порядок зависит от того, в каком файле модуль зарегистрирован
const CAT_ORDER = ['Sources','Music','Processing','Modulation','Analysis','Radio','IQ','Radar',
                    'Protocols','IR','Decoders','Audio','Video','Geo','Data','Control','Indicators','Output','Builder','Misc'];

// Верхний уровень палитры: 21 категория → 6 групп. Цвет значка — по группе, форма — по роли (источник/обработка/приёмник).
const CAT_GROUPS = [
  {id:'Input',     color:'var(--t-num)',   cats:['Sources','Radio','IQ','Control']},
  {id:'Signal',    color:'var(--t-sig)',   cats:['Processing','Modulation','Audio','Video','Radar']},
  {id:'Decode',    color:'var(--t-txt)',   cats:['Protocols','Decoders','IR']},
  {id:'Analysis',  color:'var(--t-spec)',  cats:['Analysis','Indicators','Geo','Data']},
  {id:'Music',     color:'var(--t-trk)',   cats:['Music']},
  {id:'Output',    color:'var(--t-img)',   cats:['Output','Builder','Misc']},
];
const groupOfCat = c => CAT_GROUPS.find(g=>g.cats.includes(c)) || CAT_GROUPS[CAT_GROUPS.length-1];

/* ============================ ДВИЖОК ============================ */
const Eng = {
  ctx:null, sr:48000, running:false, node:null, mic:null,
  micBuf:new Float32Array(BLOCK), micB:new Float32Array(BLOCK),
  mics:[null,null], streams:[null,null], micIds:[null,null], micSr:[null,null], merger:null,
  stereoSrc:null, stereoSplitter:null, stereoStream:null, stereoDeviceId:null, stereoSr:null,
  // Выходные шины по 2 канала: 0 — устройство по умолчанию (ctx.destination), 1..NBUS-1 —
  // другие звуковые карты через MediaStreamDestination + <audio>.setSinkId (см. busFor).
  NBUS:4, outs:[], outL:null, outR:null,
  sinks:[],                    // [bus]={id,merger,msd,el,last,err}, sinks[0] не используется
  split:null,
  devices:[], outDevices:[], micId:null, blocks:0, t:0,
  targetSr:null,               // желаемая частота; null — как даст браузер
  preload:12,                  // сколько тишины отдаём воркету на старте: больше — устойчивей к подвисаниям, но больше задержка
  preloadSab:6,                // то же для SAB-пути: воркет берёт поквантово, запас нужен меньше
  _preload:12,                 // фактический preload текущего запуска
  maxQ:24,                     // ёмкость внутренней очереди воркета, см. комментарий в start()
  sab:false,                   // используется ли SharedArrayBuffer-путь (решается в start(), зависит от COOP/COEP)
  onRunChange:null,            // колбэк для UI: дергается при старте/паузе/резюме
  async start(){
    if(this.running) return;
    const opts = {latencyHint:'interactive', ...(this.targetSr?{sampleRate:this.targetSr}:{})};
    this.ctx = new (window.AudioContext||window.webkitAudioContext)(opts);
    this.sr = this.ctx.sampleRate;   // браузер может не дать точную запрошенную частоту
    const C=2*this.NBUS;
    this.listDevices();

    // SharedArrayBuffer доступен только в cross-origin-isolated контексте (нужны заголовки
    // COOP/COEP на сервере) — если их нет, typeof SharedArrayBuffer просто 'undefined' и мы
    // тихо остаёмся на старом postMessage-пути ниже, ничего не ломая.
    this.sab = typeof SharedArrayBuffer==='function' &&
               (typeof crossOriginIsolated==='undefined' || crossOriginIsolated);
    this._preload = this.sab ? this.preloadSab : this.preload;

    let src, procOpts;
    if(this.sab){
      // Кольцо в общей памяти: воркет пишет вход (микрофон) и читает выход (посчитанный звук)
      // напрямую по индексу, без postMessage с данными — port.postMessage используется только
      // как лёгкий "пинг"-будильник раз в BLOCK семплов, чтобы разбудить tick() на основном
      // потоке. Даёт поквантовую (128 сэмплов) выдачу звука вместо ожидания целого BLOCK,
      // и убирает аллокацию/передачу Float32Array на каждый тик.
      this.RING = pow2ge(Math.max(this.maxQ,this._preload,4)*BLOCK*4);   // степень двойки — модуло через маску, не %
      // [0]=inWrite,[1]=outWrite (монотонно растущие int32), [2]=cumulative недобор сэмплов на
      // выходе (audio thread не дождался очередного outWrite) — для диагностики "прерываний
      // звука", которые сам движок раньше никак не считал (см. pumpSAB).
      this._ctrlBuf=new SharedArrayBuffer(3*4);
      this._ctrl=new Int32Array(this._ctrlBuf);
      this._lastUnderrun=0; this.audioUnderruns=0;
      this._inLBuf=new SharedArrayBuffer(this.RING*4); this._inRBuf=new SharedArrayBuffer(this.RING*4);
      this._outBuf=new SharedArrayBuffer(this.RING*C*4);   // канал c лежит в [c*RING, (c+1)*RING)
      this._inL=new Float32Array(this._inLBuf); this._inR=new Float32Array(this._inRBuf);
      this._out=new Float32Array(this._outBuf);
      this._inRead=0; this._outWrite=0;
      procOpts={ctrl:this._ctrlBuf, inL:this._inLBuf, inR:this._inRBuf, out:this._outBuf, ch:C,
                 ring:this.RING, block:BLOCK};
      src = `
        class IOS extends AudioWorkletProcessor{
          constructor(opt){super();const o=opt.processorOptions;
            this.B=o.block; this.RING=o.ring; this.MASK=this.RING-1;
            this.ctrl=new Int32Array(o.ctrl);
            this.inL=new Float32Array(o.inL); this.inR=new Float32Array(o.inR);
            this.out=new Float32Array(o.out); this.C=o.ch;
            this.inWrite=0; this.outRead=0; this.sinceNotify=0; }
          process(inp,outp){
            const i0=inp[0][0], i1=inp[0][1], o=outp[0], C=Math.min(this.C,o.length), L=o[0].length, R=this.RING;
            let iw=this.inWrite;
            for(let i=0;i<L;i++){ const p=iw&this.MASK; this.inL[p]=i0?i0[i]:0; this.inR[p]=i1?i1[i]:0; iw++; }
            this.inWrite=iw; Atomics.store(this.ctrl,0,iw);
            this.sinceNotify+=L;
            if(this.sinceNotify>=this.B){ this.sinceNotify-=this.B; this.port.postMessage(0); } // пинг, без данных
            let or_=this.outRead; const ow=Atomics.load(this.ctrl,1); let miss=0;
            for(let i=0;i<L;i++){
              if(or_<ow){ const p=or_&this.MASK; for(let c=0;c<C;c++) o[c][i]=this.out[c*R+p]; or_++; }
              else { for(let c=0;c<C;c++) o[c][i]=0; miss++; }}     // недобор — тишина, не блокируемся (Atomics.wait тут нельзя)
            this.outRead=or_;
            if(miss) Atomics.add(this.ctrl,2,miss);  // копится в SAB — главный поток вычитывает в pumpSAB
            return true; }}
        registerProcessor('io${BLOCK}sab',IOS);`;
    } else {
      src = `
        class IO extends AudioWorkletProcessor{
          constructor(){super();this.B=${BLOCK};this.C=${C};
            this.aL=new Float32Array(this.B);this.aR=new Float32Array(this.B);this.n=0;
            this.q=[];this.cur=null;this.ci=0;
            // Ёмкость очереди: чем больше, тем устойчивей к временным подвисаниям основного
            // потока (GC, тяжёлый рендер и т.п.) ценой чуть большей задержки звука — если tick()
            // на секунду отстанет, тут запас на MAXQ*B/sr секунд, прежде чем реально станет тихо.
            this.MAXQ=${this.maxQ}; this.underrun=0;
            this.port.onmessage=e=>{this.q.push(e.data);if(this.q.length>this.MAXQ)this.q.shift();};}
          process(inp,outp){
            const i0=inp[0][0], i1=inp[0][1], o=outp[0], C=Math.min(this.C,o.length), L=o[0].length, B=this.B;
            for(let i=0;i<L;i++){
              this.aL[this.n]=i0?i0[i]:0; this.aR[this.n]=i1?i1[i]:0; this.n++;
              if(this.n===this.B){
                const m=new Float32Array(this.B*2); m.set(this.aL,0); m.set(this.aR,this.B);
                this.port.postMessage(m);
                if(this.underrun){ this.port.postMessage({u:this.underrun}); this.underrun=0; } // недобор — отдельным сообщением, только когда есть что сказать
                this.n=0;}}
            for(let i=0;i<L;i++){
              if(!this.cur||this.ci>=this.B){this.cur=this.q.shift()||null;this.ci=0;}
              if(this.cur){ for(let c=0;c<C;c++) o[c][i]=this.cur[c*B+this.ci]; this.ci++; }
              else { for(let c=0;c<C;c++) o[c][i]=0; this.underrun++; }}
            return true;}}
        registerProcessor('io${BLOCK}',IO);`;
    }
    const url = URL.createObjectURL(new Blob([src],{type:'text/javascript'}));
    await this.ctx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
    this.node = new AudioWorkletNode(this.ctx, this.sab?('io'+BLOCK+'sab'):('io'+BLOCK), {
      numberOfInputs:1, numberOfOutputs:1, outputChannelCount:[C],
      channelCount:2, channelCountMode:'explicit', channelInterpretation:'discrete',
      processorOptions:procOpts });
    const node=this.node;               // локальная ссылка: отличаем «своё» сообщение от эха старого воркета
    if(this.sab){
      this.node.port.onmessage = () => {  // тут теперь только пинг-будильник, без полезной нагрузки
        if(this.node!==node) return;
        this.pumpSAB(); };
      // тишина уже лежит в буфере (SharedArrayBuffer зануляется при создании) — предзаполнение
      // это просто сдвиг указателя чтения воркета вперёд на preload блоков, без единой записи
      this._outWrite=this._preload*BLOCK; Atomics.store(this._ctrl,1,this._outWrite);
    } else {
      this.node.port.onmessage = e => {
        if(this.node!==node) return;      // движок уже пересоздан/остановлен (setBlock/setSampleRate/stop) — это хвост от старого
        if(!(e.data instanceof Float32Array)){                // {u:N} — отчёт о недоборе от воркета, см. IO выше
          this.audioUnderruns+=e.data.u;
          console.warn(`[Eng] audio worklet queue underrun +${e.data.u} samples (всего ${this.audioUnderruns}) @ ${performance.now().toFixed(0)}ms`);
          return;
        }
        this.micBuf.set(e.data.subarray(0,BLOCK));
        this.micB.set(e.data.subarray(BLOCK));
        this.tick(); };
    }
    // шины разводятся сплиттером: 0 — в destination, остальные — по требованию в openSink
    this.split=this.ctx.createChannelSplitter(C);
    this.node.connect(this.split);
    const m0=this.ctx.createChannelMerger(2);
    this.split.connect(m0,0,0); this.split.connect(m0,1,1);
    m0.connect(this.ctx.destination);
    this.sinks=[];
    if(!this.sab) for(let i=0;i<this._preload;i++) this.node.port.postMessage(new Float32Array(BLOCK*C));
    // Сторожевой таймер главного потока — независимо от RTL/аудио-кольца, просто ловит сам факт
    // "главный поток на сколько-то мс не отдавал управление событийному циклу" (GC, тяжёлый код,
    // что угодно). setInterval сам по себе не гарантирует точность — именно отклонение
    // ОТ ожидаемого периода и есть сигнал, а не абсолютное время между тиками.
    this.stallWatch(true);
    this.running = true; this.paused = false;
    this.onRunChange?.();
  },
  // На паузе/останове таймер не нужен: 10 пробуждений в секунду впустую
  stallWatch(on){
    clearInterval(this._stallTimer); this._stallTimer=0;
    if(!on) return;
    this._stallLastT=performance.now();
    this._stallTimer=setInterval(()=>{
      const now=performance.now(), over=(now-this._stallLastT)-100; this._stallLastT=now;
      if(over>15) console.warn(`[Eng] main-thread stall ~${over.toFixed(0)}ms @ ${now.toFixed(0)}ms`);
    }, 100);                                          // 10 пробуждений/с вместо 50 — порог тот же, ищем отклонение от периода
  },
  // SAB-режим: пришёл пинг от воркета — забираем накопленный им вход из кольца и считаем tick()
  // на каждый полный BLOCK, что успел накопиться (обычно один; если основной поток отставал —
  // несколько подряд, а не теряем звук молча).
  pumpSAB(){
    const iw=Atomics.load(this._ctrl,0), mask=this.RING-1;
    if(iw-this._inRead > this.RING-BLOCK) this._inRead=iw-BLOCK;   // кольцо переполнилось — догоняем, роняя старьё
    while(iw-this._inRead>=BLOCK){
      for(let i=0;i<BLOCK;i++){ const p=(this._inRead+i)&mask; this.micBuf[i]=this._inL[p]; this.micB[i]=this._inR[p]; }
      this._inRead+=BLOCK;
      this.tick();
    }
    // недобор на выходе (audio thread не дождался outWrite) копится в ctrl[2] самим воркетом —
    // здесь просто читаем дельту с прошлого пинга, см. объявление ctrl в start().
    const u=Atomics.load(this._ctrl,2);
    if(u!==this._lastUnderrun){
      const delta=u-this._lastUnderrun; this._lastUnderrun=u; this.audioUnderruns=u;
      console.warn(`[Eng] audio worklet ring underrun +${delta} samples (всего ${u}) @ ${performance.now().toFixed(0)}ms`);
    }
  },
  // Шина для устройства вывода: 0 — по умолчанию, -1 — нет свободной/нельзя. Зовётся из process
  // узла каждый блок: last отмечает использование, шина без обращений ~2 с освобождается.
  sinkSupported: typeof HTMLMediaElement!=='undefined' && 'setSinkId' in HTMLMediaElement.prototype,
  busFor(id){
    if(!id || !this.ctx || !this.split) return 0;
    if(!this.sinkSupported) return -1;
    for(let k=1;k<this.NBUS;k++) if(this.sinks[k]?.id===id){ this.sinks[k].last=this.blocks; return k; }
    const stale=this.blocks-Math.ceil(2*this.sr/BLOCK);
    for(let k=1;k<this.NBUS;k++){
      const s=this.sinks[k];
      if(!s || s.last<stale){ this.closeSink(k); this.openSink(k,id); return k; } }
    return -1;
  },
  sinkErr(k){ return this.sinks[k]?.err||''; },
  openSink(k,id){
    const s={id, last:this.blocks, err:''};
    s.merger=this.ctx.createChannelMerger(2);
    this.split.connect(s.merger,2*k,0); this.split.connect(s.merger,2*k+1,1);
    s.msd=this.ctx.createMediaStreamDestination();
    s.merger.connect(s.msd);
    s.el=new Audio(); s.el.srcObject=s.msd.stream;
    s.el.setSinkId(id).then(()=>s.el.play())
      .catch(e=>{ s.err=e.message||String(e); console.error('вывод на устройство:',e); });
    this.sinks[k]=s;
  },
  closeSink(k){
    const s=this.sinks[k]; if(!s) return;
    try{ this.split.disconnect(s.merger); }catch(e){}
    s.merger.disconnect();
    s.el.pause(); s.el.srcObject=null;
    s.msd.stream.getTracks().forEach(t=>t.stop());
    this.sinks[k]=null;
  },
  closeSinks(){ for(let k=1;k<this.NBUS;k++) this.closeSink(k); this.sinks=[]; this.split=null; },
  // Firefox: системный выбор устройства (selectAudioOutput) — без него выходы не видны.
  // Остальные браузеры показывают выходы и их имена после разрешения на микрофон.
  async pickOutput(){
    if(navigator.mediaDevices?.selectAudioOutput){
      try{
        const d=await navigator.mediaDevices.selectAudioOutput();
        await this.listDevices();
        if(!this.outDevices.some(x=>x.id===d.deviceId))
          this.outDevices.push({id:d.deviceId,label:d.label||d.deviceId});
        return d.label||d.deviceId;
      }catch(e){ console.error('selectAudioOutput:',e); return null; }
    }
    await this.unlockLabels(); return null;
  },
  // Останавливает микрофоны и освобождает железо (иначе индикатор записи в браузере висит вечно).
  stopMics(){
    for(let slot=0;slot<2;slot++){
      this.mics[slot]?.disconnect();
      this.streams[slot]?.getTracks().forEach(t=>t.stop());
      this.mics[slot]=null; this.streams[slot]=null;
    }
    this.stopStereoMic();
  },
  stopStereoMic(){
    this.stereoSrc?.disconnect(); this.stereoSplitter?.disconnect();
    this.stereoStream?.getTracks().forEach(t=>t.stop());
    this.stereoSrc=null; this.stereoSplitter=null; this.stereoStream=null; this.stereoDeviceId=null;
  },
  // Полный останов (в отличие от toggle-паузы — закрывает AudioContext). ctx.close() сам по
  // себе НЕ останавливает треки getUserMedia (микрофон продолжает физически захватываться,
  // индикатор в браузере горит) — поэтому stopMics() здесь обязателен и идёт первым.
  async stop(){
    this.stopMics();
    this.closeSinks();
    this.stallWatch(false);
    try{ await this.ctx?.close(); }catch(e){}
    this.running=false; this.paused=false; this.node=null; this.merger=null;
    this.mic=null; this.micId=null;
    this.onRunChange?.();
  },
  async toggle(){
    if(!this.running){ await this.start(); return true; }
    if(this.paused){
      await this.ctx.resume(); this.paused=false; this.stallWatch(true);
      // переподключаем входы, которые были активны до паузы
      if(this.wasStereo) await this.enableStereoMic(this.stereoDeviceId||undefined, this.stereoSr||undefined);
      else for(let slot=0;slot<2;slot++)
        if(this.wasMic?.[slot]) await this.enableMic(this.micIds[slot]||undefined, slot, this.micSr[slot]||undefined);
    } else {
      this.wasStereo=!!this.stereoSrc;
      this.wasMic=[!!this.mics[0], !!this.mics[1]];
      await this.ctx.suspend(); this.paused=true; this.stallWatch(false);
      this.stopMics();
    }
    this.onRunChange?.();
    return !this.paused;
  },
  async enableMic(deviceId, slot, sr){
    slot=slot|0;
    if(!this.running) await this.start();
    else if(this.paused){ await this.ctx.resume(); this.paused=false; this.stallWatch(true); this.onRunChange?.(); }
    if(this.mics[slot] && deviceId===undefined && sr===undefined) return;
    this.stopStereoMic();                             // ручная настройка отдельного входа — выходим из стерео-режима
    const fx=this.fx||{};
    const a={echoCancellation:!!fx.echo, noiseSuppression:!!fx.ns, autoGainControl:!!fx.agc};
    if(deviceId) a.deviceId={exact:deviceId};
    if(sr) a.sampleRate={ideal:sr};                   // ideal, не exact — иначе OverconstrainedError на несовпадающей частоте
    let st;
    try{ st = await navigator.mediaDevices.getUserMedia({audio:a}); }
    catch(e){                                        // нет доступа/устройства — не роняем страницу молча
      console.error('микрофон:',e);
      if(typeof stat!=='undefined') stat.textContent='failed to enable microphone: '+e.message;
      return;
    }
    if(!this.node || this.ctx.state==='closed'){ st.getTracks().forEach(t=>t.stop()); return; }  // движок остановили, пока ждали доступ
    if(!this.merger){                                // два источника сводятся в два канала входа
      this.merger=this.ctx.createChannelMerger(2);
      this.merger.connect(this.node); }
    if(this.mics[slot]){ this.mics[slot].disconnect();
      this.streams[slot]?.getTracks().forEach(t=>t.stop()); }
    this.streams[slot]=st; this.micIds[slot]=deviceId||null; this.micSr[slot]=sr||null;
    this.mics[slot]=this.ctx.createMediaStreamSource(st);
    this.mics[slot].connect(this.merger,0,slot);
    this.mic=this.mics[0]; this.micId=this.micIds[0];
    await this.listDevices();
  },
  // Стерео с ОДНОГО физического устройства (например, встроенный микрофонный массив ноутбука,
  // как на ThinkPad T480) — один getUserMedia с channelCount:2 и честное разделение каналов
  // ChannelSplitterNode, а не два отдельных getUserMedia на один и тот же deviceId (это давало
  // одинаковый моно-даунмикс в обоих слотах вместо реального L/R).
  async enableStereoMic(deviceId, sr){
    if(!this.running) await this.start();
    else if(this.paused){ await this.ctx.resume(); this.paused=false; this.stallWatch(true); this.onRunChange?.(); }
    this.stopMics();                                  // единый поток на оба канала — отдельные mono-входы не нужны
    const fx=this.fx||{};
    const a={echoCancellation:!!fx.echo, noiseSuppression:!!fx.ns, autoGainControl:!!fx.agc,
             channelCount:{exact:2}};
    if(deviceId) a.deviceId={exact:deviceId};
    if(sr) a.sampleRate={ideal:sr};
    let st;
    try{ st = await navigator.mediaDevices.getUserMedia({audio:a}); }
    catch(e){
      console.error('стерео-микрофон:',e);
      if(typeof stat!=='undefined') stat.textContent='failed to enable stereo microphone: '+e.message;
      return;
    }
    if(!this.node || this.ctx.state==='closed'){ st.getTracks().forEach(t=>t.stop()); return; }
    if(!this.merger){ this.merger=this.ctx.createChannelMerger(2); this.merger.connect(this.node); }
    this.stereoStream=st; this.stereoDeviceId=deviceId||null; this.stereoSr=sr||null;
    this.stereoSrc=this.ctx.createMediaStreamSource(st);
    this.stereoSplitter=this.ctx.createChannelSplitter(2);
    this.stereoSrc.connect(this.stereoSplitter);
    this.stereoSplitter.connect(this.merger,0,0);
    this.stereoSplitter.connect(this.merger,1,1);
    this.micIds=[deviceId||null,deviceId||null];
    this.mic=this.stereoSrc; this.micId=deviceId||null;
    await this.listDevices();
  },
  // Один раз молча запросить/освободить доступ, чтобы enumerateDevices() отдал настоящие
  // названия устройств вместо generic "вход N" — до разрешения браузер их скрывает.
  // Всё равно спросит разрешение у пользователя, если оно ещё не выдано — не обходит consent.
  async unlockLabels(){
    try{ const st=await navigator.mediaDevices.getUserMedia({audio:true});
      st.getTracks().forEach(t=>t.stop()); }
    catch(e){ console.error('разблокировка имён устройств:',e); }
    await this.listDevices();
  },
  // Живое применение echo/ns/agc на уже открытых треках, без пересоздания потока
  // (пересоздание — это щелчок/обрыв звука на пару блоков). Поддержано не всеми браузерами/
  // устройствами — при неудаче возвращает false, вызывающий сам решает, переподключаться ли.
  async applyFx(){
    const fx=this.fx||{};
    const c={echoCancellation:!!fx.echo, noiseSuppression:!!fx.ns, autoGainControl:!!fx.agc};
    const tracks=[];
    for(let slot=0;slot<2;slot++){ const t=this.streams[slot]?.getAudioTracks?.()[0]; if(t) tracks.push(t); }
    const st=this.stereoStream?.getAudioTracks?.()[0]; if(st) tracks.push(st);
    let ok=true;
    for(const t of tracks){
      try{ await t.applyConstraints(c); } catch(e){ ok=false; console.error('applyConstraints:',e); }
    }
    return ok;
  },
  // Что реально согласовал браузер (частота/каналы могут отличаться от запрошенного ideal)
  micSettings(slot){ const t=this.streams[slot|0]?.getAudioTracks?.()[0]; return t?t.getSettings():null; },
  stereoSettings(){ const t=this.stereoStream?.getAudioTracks?.()[0]; return t?t.getSettings():null; },
  async listDevices(){
    try{ const d=await navigator.mediaDevices.enumerateDevices();
      this.devices=d.filter(x=>x.kind==='audioinput')
        .map((x,i)=>({id:x.deviceId,label:x.label||('input '+(i+1))}));
      // 'default' — это и есть шина 0, отдельным пунктом не нужен
      const outs=d.filter(x=>x.kind==='audiooutput' && x.deviceId && x.deviceId!=='default')
        .map((x,i)=>({id:x.deviceId,label:x.label||('output '+(i+1))}));
      // выданное через selectAudioOutput может не попасть в enumerateDevices — не теряем
      for(const o of this.outDevices) if(!outs.some(x=>x.id===o.id)) outs.push(o);
      this.outDevices=outs;
    }catch(e){ this.devices=[]; }
    return this.devices;
  },
  // Оценка суммарной задержки: аппаратная часть — то, что реально даёт браузер/ОС/устройство
  // (baseLatency+outputLatency, недоступно до start()), плюс наш буфер — preload блоков,
  // отданных воркету при старте (в установившемся режиме очередь обычно держится около этого
  // уровня; в худшем случае, если tick() отставал, доходит до maxQ). В SAB-режиме сама формула
  // та же, но воркет потребляет из кольца поквантово (128 сэмплов), а не ждёт целый BLOCK через
  // postMessage — на практике это позволяет держать preload заметно меньше без щелчков.
  latencyMs(){
    if(!this.ctx) return null;
    const hw=((this.ctx.baseLatency||0)+(this.ctx.outputLatency||0))*1000;
    const queueMs=this._preload*BLOCK/this.sr*1000;
    const queueMaxMs=this.maxQ*BLOCK/this.sr*1000;
    return {hardwareMs:hw, queueMs, queueMaxMs, totalMs:hw+queueMs, sab:this.sab};
  },
  turbo:1,
  load:0,                              // сглаженная доля бюджета реального времени, съеденная обработкой
  tick(){
    if(!this.node) return;              // движок остановлен посреди обработки — не падаем
    const t0 = performance.now();
    const reps=Math.max(1,this.turbo|0);
    for(let r=0;r<reps;r++){                        // ускоренный прогон: несколько блоков за такт
      for(const o of this.outs) o.fill(0);
      if(Prof.on){
        for(const n of Graph.order){
          if(n._frozen || (Prof.skip && n._dead)) continue;
          const a=performance.now(); evalNode(n); const dt=performance.now()-a;
          n._pAcc=(n._pAcc||0)+dt; Prof.tot.p+=dt;
        }
      } else for(const n of Graph.order) if(!n._frozen && !(Prof.skip && n._dead)) evalNode(n);
      this.blocks++; }
    // В SAB-режиме — прямая запись в общую память (см. pumpSAB/start). Иначе — transfer воркету,
    // как раньше: без .slice() тут нет лишней копии, postMessage и так клонирует то, что не transferable.
    if(this.sab){
      const mask=this.RING-1, R=this.RING, C=this.outs.length; let ow=this._outWrite;
      for(let c=0;c<C;c++){ const src=this.outs[c], base=c*R;
        for(let i=0;i<BLOCK;i++) this._out[base+((ow+i)&mask)]=src[i]; }
      ow+=BLOCK; this._outWrite=ow; Atomics.store(this._ctrl,1,ow);
    } else {
      const C=this.outs.length, out=new Float32Array(BLOCK*C);
      for(let c=0;c<C;c++) out.set(this.outs[c],c*BLOCK);
      this.node.port.postMessage(out, [out.buffer]);
    }
    this.t = performance.now()-t0;
    // budgetMs — сколько реального времени есть на обработку reps блоков до следующего такта воркета.
    // load>1 при turbo=1 означает реальные подвисания звука (очередь воркета не успевает наполняться).
    const budgetMs = reps*BLOCK/this.sr*1000;
    this.load = this.load*0.8 + (this.t/budgetMs)*0.2;   // сглаживание — иначе скачет от блока к блоку
  },
  allocOuts(){
    this.outs=Array.from({length:2*this.NBUS},()=>new Float32Array(BLOCK));
    this.outL=this.outs[0]; this.outR=this.outs[1];
  },
  async setBlock(v){
    const was=this.running&&!this.paused;
    this.stopMics();                                 // раньше треки не останавливались — микрофон висел включённым
    this.stallWatch(false);                           // иначе старый таймер продолжит тикать поверх нового от start()
    this.closeSinks();
    try{ await this.ctx?.close(); }catch(e){}
    this.running=false; this.paused=false; this.node=null;
    this.streams=[null,null]; this.micIds=[null,null]; this.merger=null; this.mic=null;
    BLOCK=v;
    this.micBuf=new Float32Array(v); this.micB=new Float32Array(v);
    this.allocOuts();
    for(const n of Graph.nodes){ n.b={}; n.zero=null; }   // буферы узлов пересоздадутся
    if(was){
      try{ await this.start(); }
      catch(e){                                      // перезапуск не удался — сообщаем, а не молчим
        console.error('перезапуск после смены блока:',e);
        if(typeof stat!=='undefined') stat.textContent='failed to restart engine: '+e.message;
      }
    }
  },
  // Аналогично setBlock, но меняет частоту дискретизации — тоже требует пересоздания AudioContext.
  async setSampleRate(v){
    const was=this.running&&!this.paused;
    this.stopMics();
    this.stallWatch(false);                           // иначе старый таймер продолжит тикать поверх нового от start()
    this.closeSinks();
    try{ await this.ctx?.close(); }catch(e){}
    this.running=false; this.paused=false; this.node=null;
    this.streams=[null,null]; this.micIds=[null,null]; this.merger=null; this.mic=null;
    this.targetSr=v||null;
    for(const n of Graph.nodes){ n.b={}; n.zero=null; }
    if(was){
      try{ await this.start(); }
      catch(e){
        console.error('перезапуск после смены частоты:',e);
        if(typeof stat!=='undefined') stat.textContent='failed to restart engine: '+e.message;
      }
    }
  }
};
Eng.allocOuts();
// список устройств протухает при подключении/отключении железа — обновляем сам, без ручного повторного скана
if(navigator.mediaDevices?.addEventListener)
  navigator.mediaDevices.addEventListener('devicechange', ()=>Eng.listDevices());

// Контролы (range/knob/num/check/range2) — провод можно тянуть прямо на них без явного ins/outs
// в модуле: см. controlParamsOf — каждый такой параметр всегда доступен как виртуальный пин
// «num» в обе стороны (пин просто не показывается в UI, пока провод не подключён).
const CONTROL_KINDS = new Set(['range','knob','num','check','range2']);
function controlParamsOf(n){
  const d=MOD[n.type]; if(!d) return [];
  if(d._cp) return d._cp;                             // params статичны для типа модуля — считаем один раз на тип
  const out=[];
  for(const s of (d.params||[])){
    if(s.t==='range2'){ out.push({n:s.keys[0],kind:'range2'},{n:s.keys[1],kind:'range2'}); continue; }
    if(s.t==='knob' && s.get) continue;               // читает/пишет не n.p — программной записи не даём (см. paramEl)
    if(CONTROL_KINDS.has(s.t)) out.push({n:s.n,kind:s.t});
  }
  return d._cp=out;
}
function portsOf(n,side){                            // ins/outs могут быть функцией от узла
  const d=MOD[n.type]; if(!d) return [];
  const v=d[side];
  const base = typeof v==='function' ? (v(n)||[]) : (v||[]);
  const have=new Set(base.map(p=>p.n));
  let extra=null;
  for(const cp of controlParamsOf(n)){
    if(have.has(cp.n)) continue;
    (extra||(extra=[])).push({n:cp.n, t:'num'});
  }
  return extra ? base.concat(extra) : base;
}
function applyControlWires(n,I){                     // провод на контрол всегда перебивает его значение
  for(const cp of controlParamsOf(n)){
    const raw=I[cp.n];
    if(typeof raw!=='number' || !isFinite(raw)) continue;
    const v = cp.kind==='check' ? (raw>=0.5) : raw;
    if(n.p[cp.n]===v) continue;                      // без изменений — не дёргать n.set/fn каждый блок впустую
    if(n.set?.[cp.n]) n.set[cp.n](v); else n.p[cp.n]=v;
  }
}
function fillControlOuts(n){                          // значение контрола наружу — если модуль сам не выставил такой out
  for(const cp of controlParamsOf(n)){
    if(n.out[cp.n]!==undefined) continue;
    const v=n.p[cp.n];
    n.out[cp.n] = typeof v==='boolean' ? (v?1:0) : v;
  }
}
/* Пара I/Q за одним пином iq. Порт с pair:[a,b] — провод iq (поток со своей частотой) сводится к каналам a, b на частоте движка
   встроенным мостом: тем же ядром, что узел IQ → Audio (на выходе — как I/Q → IQ). Модуль работает с I и Q как раньше;
   старые провода на I и Q остаются рабочими (пины скрыты, пока не подключены), провод на них приоритетнее. */
function pairHid(type,p){ const h={type,p,b:{},out:{},size:{w:0,h:0}}; MOD[type].init?.(h); return h; }
function pairIn(n,I,p){
  const s=I[p.n];
  if(!s || !s.chunks) return;
  const st=(n._pb||(n._pb={}))[p.n] || (n._pb[p.n]=pairHid('iqAudio',{lat:100,gain:0}));
  const r=MOD.iqAudio.process(st,{in:s})||{};
  if(I[p.pair[0]]==null) I[p.pair[0]]=r.out;
  if(I[p.pair[1]]==null) I[p.pair[1]]=r.q;
}
function pairOut(n,p){
  const a=n.out[p.pair[0]], b=n.out[p.pair[1]];
  if(!a || !b) return;
  const st=(n._pb||(n._pb={}))[p.n] || (n._pb[p.n]=pairHid('iqMerge',{fc:0,swap:false}));
  n.out[p.n]=MOD.iqMerge.process(st,{I:a,Q:b})?.iq ?? null;
}
function evalNode(n, ctx){
  const d = MOD[n.type]; if(!d) return;
  const g = ctx || Graph;
  const I = n._I || (n._I={});         // переиспользуем — раньше {} аллоцировался заново на каждый узел каждый блок
  // g.inIndex — карта "узел+порт → провод", строится в retopo(). Без неё пришлось бы
  // на каждый вход каждого узла линейно перебирать все рёбра графа — и так каждый аудио-блок.
  const idx = g.inIndex;
  const keys = n._pk || (n._pk={});    // кэш строкового ключа на узел+порт — от топологии не зависит, только от имени порта
  for(const p of portsOf(n,'ins')){
    const key = keys[p.n] || (keys[p.n]=n.id+'\u0001'+p.n);
    const e = idx ? idx.get(key) : g.edges.find(e=>e.to===n.id && e.tp===p.n);
    I[p.n] = e ? (g.map[e.from]?.out?.[e.fp] ?? null) : null;
  }
  if(d._pair===undefined) d._pair=(Array.isArray(d.ins) && d.ins.some(p=>p.pair)) || (Array.isArray(d.outs) && d.outs.some(p=>p.pair));
  if(d._pair) for(const p of portsOf(n,'ins')) if(p.pair) pairIn(n,I,p);
  applyControlWires(n,I);
  // узел острова (core-islands.js) считается в воркере — здесь только прокси
  try{ n.out = (n._isl && g===Graph ? islProcess(n,I) : d.process(n, I, g)) || {}; }catch(err){ n.err = err; }
  if(d._pair) for(const p of portsOf(n,'outs')) if(p.pair) pairOut(n,p);
  fillControlOuts(n);
  if(d.lazy==='proc') n._dirty=true; else if(d.lazy===true) markInputs(n,I);
}
/* ---- ленивая отрисовка ----
   Модуль с lazy:true рисуется (см. frame() в core-graph.js) только когда есть что показать:
   изменились входы, параметры, размер/буфер канвы, тема, был ввод мышью по узлу, либо модуль
   сам вызвал redraw(n) (асинхронные данные, внутреннее состояние). lazy:'proc' — после каждого
   process() (история/затухание меняются каждый блок, но при остановленном движке — ничего).
   lazy:'manual' — только redraw(n). drawKey(n) в модуле — строка видимого состояния, сверяется
   каждый кадр (для асинхронных данных: serial, USB, сеть). Страховка: не реже раза в LAZY_MAX_MS. */
const LAZY_MAX_MS=1000;
let drawGen=0;
function redraw(n){ n._dirty=true; }
function redrawAll(){ drawGen++; }
function redrawIf(n,key){ if(key!==n._rk){ n._rk=key; n._dirty=true; } }   // ключ видимого состояния сменился
// Входы: числа/строки — по значению, объекты с rev (спектр) — по rev, прочие объекты
// (буферы сигнала переиспользуются и перезаписываются) — считаем новыми каждый блок.
function markInputs(n,I){
  const s=n._iv||(n._iv={});
  for(const k in I){
    const v=I[k];
    if(v!==null && typeof v==='object'){
      if(v.rev==null){ n._dirty=true; continue; }
      if(v!==s[k] || v.rev!==s[k+'\u0001']){ s[k]=v; s[k+'\u0001']=v.rev; n._dirty=true; }
    } else if(v!==s[k] && !(v!==v && s[k]!==s[k])){ s[k]=v; n._dirty=true; }
  }
}
function topoOrder(nodes,edges,map){                 // топосорт, циклы читают прошлый блок
  const indeg={}, out={};
  nodes.forEach(n=>{ indeg[n.id]=0; out[n.id]=[]; });
  edges.forEach(e=>{ if(indeg[e.to]!=null&&out[e.from]){ indeg[e.to]++; out[e.from].push(e.to); }});
  const q=nodes.filter(n=>!indeg[n.id]).map(n=>n.id), res=[];
  let qi=0;                                          // индекс вместо q.shift() — иначе очередь O(n) на каждый сдвиг
  while(qi<q.length){ const id=q[qi++]; res.push(id);
    for(const t of out[id]) if(--indeg[t]===0) q.push(t); }
  const seen=new Set(res);
  return res.map(id=>map[id]).concat(nodes.filter(n=>!seen.has(n.id)));
}

/* ---- энергопрофиль ----
   skip — не считать узлы, результат которых никому не нужен: ни отрисовки, ни проводов к нужным узлам.
   on — копить время process()/draw() по узлам (мс на узел), панель power в modules/power.js. */
const Prof={ on:false, skip:true, t0:0, tot:{p:0,d:0} };
try{ if(localStorage.getItem('dsp-skip')==='0') Prof.skip=false; }catch(e){}
const PROF_ROOT_CATS=new Set(['Output','Sources','Control']);   // побочные эффекты (звук, устройства, управление) — всегда нужны
function markLive(nodes,edges,map){
  const live=new Set(), ins=new Map();
  for(const e of edges){ let a=ins.get(e.to); if(!a) ins.set(e.to,a=[]); a.push(e.from); }
  const stack=[];
  for(const n of nodes){
    const d=MOD[n.type];
    if(!d || d.draw || d.always || PROF_ROOT_CATS.has(d.cat) || !portsOf(n,'outs').length || n._isl){ live.add(n.id); stack.push(n.id); }
  }
  while(stack.length){ const id=stack.pop(); for(const f of ins.get(id)||[]) if(!live.has(f)){ live.add(f); stack.push(f); } }
  for(const n of nodes) n._dead=!live.has(n.id);
}
/* ---- вспомогательное ---- */
function buf(n,name){ (n.b||(n.b={})); return n.b[name] || (n.b[name] = new Float32Array(BLOCK)); }
// pv, clamp, fft, window_, biquadCoef, iqStream… — в core-dsp.js

/* ============================ РЕЕСТР МОДУЛЕЙ ============================ */
const MOD = {};
const def = d => {
  if(MOD[d.id]) console.warn('дублирующийся id модуля: '+d.id);   // тихая перезапись — источник трудноуловимых багов
  MOD[d.id]=d;
};
