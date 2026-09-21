"use strict";
let BLOCK = 512;                   // размер блока обработки (меняется на ходу)
const TYPE_COLOR = {sig:'var(--t-sig)',num:'var(--t-num)',spec:'var(--t-spec)',
                    img:'var(--t-img)',txt:'var(--t-txt)',blk:'var(--t-blk)',val:'var(--acc)',bands:'var(--t-bands)'};
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
// порядок разделов в палитре — иначе порядок зависит от того, в каком файле модуль зарегистрирован
const CAT_ORDER = ['Sources','Music','Processing','Modulation','Analysis','Radio','Radar',
                    'Protocols','Decoders','Audio','Video','Output','Control','Builder','Misc'];

/* ============================ ДВИЖОК ============================ */
const Eng = {
  ctx:null, sr:48000, running:false, node:null, mic:null,
  micBuf:new Float32Array(BLOCK), micB:new Float32Array(BLOCK),
  mics:[null,null], streams:[null,null], micIds:[null,null], micSr:[null,null], merger:null,
  stereoSrc:null, stereoSplitter:null, stereoStream:null, stereoDeviceId:null, stereoSr:null,
  outL:new Float32Array(BLOCK), outR:new Float32Array(BLOCK),
  devices:[], micId:null, blocks:0, t:0,
  targetSr:null,               // желаемая частота; null — как даст браузер
  preload:12,                  // сколько тишины отдаём воркету на старте: больше — устойчивей к подвисаниям, но больше задержка
  maxQ:24,                     // ёмкость внутренней очереди воркета, см. комментарий в start()
  sab:false,                   // используется ли SharedArrayBuffer-путь (решается в start(), зависит от COOP/COEP)
  onRunChange:null,            // колбэк для UI: дергается при старте/паузе/резюме
  async start(){
    if(this.running) return;
    const opts = {latencyHint:'interactive', ...(this.targetSr?{sampleRate:this.targetSr}:{})};
    this.ctx = new (window.AudioContext||window.webkitAudioContext)(opts);
    this.sr = this.ctx.sampleRate;   // браузер может не дать точную запрошенную частоту

    // SharedArrayBuffer доступен только в cross-origin-isolated контексте (нужны заголовки
    // COOP/COEP на сервере) — если их нет, typeof SharedArrayBuffer просто 'undefined' и мы
    // тихо остаёмся на старом postMessage-пути ниже, ничего не ломая.
    this.sab = typeof SharedArrayBuffer==='function' &&
               (typeof crossOriginIsolated==='undefined' || crossOriginIsolated);

    let src, procOpts;
    if(this.sab){
      // Кольцо в общей памяти: воркет пишет вход (микрофон) и читает выход (посчитанный звук)
      // напрямую по индексу, без postMessage с данными — port.postMessage используется только
      // как лёгкий "пинг"-будильник раз в BLOCK семплов, чтобы разбудить tick() на основном
      // потоке. Даёт поквантовую (128 сэмплов) выдачу звука вместо ожидания целого BLOCK,
      // и убирает аллокацию/передачу Float32Array на каждый тик.
      this.RING = pow2ge(Math.max(this.maxQ,this.preload,4)*BLOCK*4);   // степень двойки — модуло через маску, не %
      // [0]=inWrite,[1]=outWrite (монотонно растущие int32), [2]=cumulative недобор сэмплов на
      // выходе (audio thread не дождался очередного outWrite) — для диагностики "прерываний
      // звука", которые сам движок раньше никак не считал (см. pumpSAB).
      this._ctrlBuf=new SharedArrayBuffer(3*4);
      this._ctrl=new Int32Array(this._ctrlBuf);
      this._lastUnderrun=0; this.audioUnderruns=0;
      this._inLBuf=new SharedArrayBuffer(this.RING*4); this._inRBuf=new SharedArrayBuffer(this.RING*4);
      this._outLBuf=new SharedArrayBuffer(this.RING*4); this._outRBuf=new SharedArrayBuffer(this.RING*4);
      this._inL=new Float32Array(this._inLBuf); this._inR=new Float32Array(this._inRBuf);
      this._outL=new Float32Array(this._outLBuf); this._outR=new Float32Array(this._outRBuf);
      this._inRead=0; this._outWrite=0;
      procOpts={ctrl:this._ctrlBuf, inL:this._inLBuf, inR:this._inRBuf, outL:this._outLBuf, outR:this._outRBuf,
                 ring:this.RING, block:BLOCK};
      src = `
        class IOS extends AudioWorkletProcessor{
          constructor(opt){super();const o=opt.processorOptions;
            this.B=o.block; this.RING=o.ring; this.MASK=this.RING-1;
            this.ctrl=new Int32Array(o.ctrl);
            this.inL=new Float32Array(o.inL); this.inR=new Float32Array(o.inR);
            this.outL=new Float32Array(o.outL); this.outR=new Float32Array(o.outR);
            this.inWrite=0; this.outRead=0; this.sinceNotify=0; }
          process(inp,outp){
            const i0=inp[0][0], i1=inp[0][1], o=outp[0][0], o1=outp[0][1]||o, L=o.length;
            let iw=this.inWrite;
            for(let i=0;i<L;i++){ const p=iw&this.MASK; this.inL[p]=i0?i0[i]:0; this.inR[p]=i1?i1[i]:0; iw++; }
            this.inWrite=iw; Atomics.store(this.ctrl,0,iw);
            this.sinceNotify+=L;
            if(this.sinceNotify>=this.B){ this.sinceNotify-=this.B; this.port.postMessage(0); } // пинг, без данных
            let or_=this.outRead; const ow=Atomics.load(this.ctrl,1); let miss=0;
            for(let i=0;i<L;i++){
              if(or_<ow){ const p=or_&this.MASK; o[i]=this.outL[p]; o1[i]=this.outR[p]; or_++; }
              else { o[i]=0; o1[i]=0; miss++; }}     // недобор — тишина, не блокируемся (Atomics.wait тут нельзя)
            this.outRead=or_;
            if(miss) Atomics.add(this.ctrl,2,miss);  // копится в SAB — главный поток вычитывает в pumpSAB
            return true; }}
        registerProcessor('io${BLOCK}sab',IOS);`;
    } else {
      src = `
        class IO extends AudioWorkletProcessor{
          constructor(){super();this.B=${BLOCK};
            this.aL=new Float32Array(this.B);this.aR=new Float32Array(this.B);this.n=0;
            this.q=[];this.cur=null;this.ci=0;
            // Ёмкость очереди: чем больше, тем устойчивей к временным подвисаниям основного
            // потока (GC, тяжёлый рендер и т.п.) ценой чуть большей задержки звука — если tick()
            // на секунду отстанет, тут запас на MAXQ*B/sr секунд, прежде чем реально станет тихо.
            this.MAXQ=${this.maxQ}; this.underrun=0;
            this.port.onmessage=e=>{this.q.push(e.data);if(this.q.length>this.MAXQ)this.q.shift();};}
          process(inp,outp){
            const i0=inp[0][0], i1=inp[0][1], o=outp[0][0], o1=outp[0][1]||o, L=o.length;
            for(let i=0;i<L;i++){
              this.aL[this.n]=i0?i0[i]:0; this.aR[this.n]=i1?i1[i]:0; this.n++;
              if(this.n===this.B){
                const m=new Float32Array(this.B*2); m.set(this.aL,0); m.set(this.aR,this.B);
                this.port.postMessage(m);
                if(this.underrun){ this.port.postMessage({u:this.underrun}); this.underrun=0; } // недобор — отдельным сообщением, только когда есть что сказать
                this.n=0;}}
            for(let i=0;i<L;i++){
              if(!this.cur||this.ci>=this.B){this.cur=this.q.shift()||null;this.ci=0;}
              if(this.cur){ o[i]=this.cur[this.ci]; o1[i]=this.cur[this.B+this.ci]; this.ci++; }
              else { o[i]=0; o1[i]=0; this.underrun++; }}
            return true;}}
        registerProcessor('io${BLOCK}',IO);`;
    }
    const url = URL.createObjectURL(new Blob([src],{type:'text/javascript'}));
    await this.ctx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
    this.node = new AudioWorkletNode(this.ctx, this.sab?('io'+BLOCK+'sab'):('io'+BLOCK), {
      numberOfInputs:1, numberOfOutputs:1, outputChannelCount:[2],
      channelCount:2, channelCountMode:'explicit', channelInterpretation:'discrete',
      processorOptions:procOpts });
    const node=this.node;               // локальная ссылка: отличаем «своё» сообщение от эха старого воркета
    if(this.sab){
      this.node.port.onmessage = () => {  // тут теперь только пинг-будильник, без полезной нагрузки
        if(this.node!==node) return;
        this.pumpSAB(); };
      // тишина уже лежит в буфере (SharedArrayBuffer зануляется при создании) — предзаполнение
      // это просто сдвиг указателя чтения воркета вперёд на preload блоков, без единой записи
      this._outWrite=this.preload*BLOCK; Atomics.store(this._ctrl,1,this._outWrite);
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
    this.node.connect(this.ctx.destination);
    if(!this.sab) for(let i=0;i<this.preload;i++) this.node.port.postMessage(new Float32Array(BLOCK*2));
    // Сторожевой таймер главного потока — независимо от RTL/аудио-кольца, просто ловит сам факт
    // "главный поток на сколько-то мс не отдавал управление событийному циклу" (GC, тяжёлый код,
    // что угодно). setInterval(20мс) сам по себе не гарантирует точность — именно отклонение
    // ОТ ожидаемого периода и есть сигнал, а не абсолютное время между тиками.
    this._stallLastT=performance.now();
    this._stallTimer=setInterval(()=>{
      const now=performance.now(), over=(now-this._stallLastT)-20; this._stallLastT=now;
      if(over>15) console.warn(`[Eng] main-thread stall ~${over.toFixed(0)}ms @ ${now.toFixed(0)}ms`);
    }, 20);
    this.running = true; this.paused = false;
    this.onRunChange?.();
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
    clearInterval(this._stallTimer);
    try{ await this.ctx?.close(); }catch(e){}
    this.running=false; this.paused=false; this.node=null; this.merger=null;
    this.mic=null; this.micId=null;
    this.onRunChange?.();
  },
  async toggle(){
    if(!this.running){ await this.start(); return true; }
    if(this.paused){
      await this.ctx.resume(); this.paused=false;
      // переподключаем входы, которые были активны до паузы
      if(this.wasStereo) await this.enableStereoMic(this.stereoDeviceId||undefined, this.stereoSr||undefined);
      else for(let slot=0;slot<2;slot++)
        if(this.wasMic?.[slot]) await this.enableMic(this.micIds[slot]||undefined, slot, this.micSr[slot]||undefined);
    } else {
      this.wasStereo=!!this.stereoSrc;
      this.wasMic=[!!this.mics[0], !!this.mics[1]];
      await this.ctx.suspend(); this.paused=true;
      this.stopMics();
    }
    this.onRunChange?.();
    return !this.paused;
  },
  async enableMic(deviceId, slot, sr){
    slot=slot|0;
    if(!this.running) await this.start();
    else if(this.paused){ await this.ctx.resume(); this.paused=false; this.onRunChange?.(); }
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
    else if(this.paused){ await this.ctx.resume(); this.paused=false; this.onRunChange?.(); }
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
    const queueMs=this.preload*BLOCK/this.sr*1000;
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
      this.outL.fill(0); this.outR.fill(0);
      for(const n of Graph.order) evalNode(n);
      this.blocks++; }
    // В SAB-режиме — прямая запись в общую память (см. pumpSAB/start). Иначе — transfer воркету,
    // как раньше: без .slice() тут нет лишней копии, postMessage и так клонирует то, что не transferable.
    if(this.sab){
      const mask=this.RING-1; let ow=this._outWrite;
      for(let i=0;i<BLOCK;i++){ const p=(ow+i)&mask; this._outL[p]=this.outL[i]; this._outR[p]=this.outR[i]; }
      ow+=BLOCK; this._outWrite=ow; Atomics.store(this._ctrl,1,ow);
    } else {
      const out=new Float32Array(BLOCK*2);
      out.set(this.outL,0); out.set(this.outR,BLOCK);
      this.node.port.postMessage(out, [out.buffer]);
    }
    this.t = performance.now()-t0;
    // budgetMs — сколько реального времени есть на обработку reps блоков до следующего такта воркета.
    // load>1 при turbo=1 означает реальные подвисания звука (очередь воркета не успевает наполняться).
    const budgetMs = reps*BLOCK/this.sr*1000;
    this.load = this.load*0.8 + (this.t/budgetMs)*0.2;   // сглаживание — иначе скачет от блока к блоку
  },
  async setBlock(v){
    const was=this.running&&!this.paused;
    this.stopMics();                                 // раньше треки не останавливались — микрофон висел включённым
    clearInterval(this._stallTimer);                  // иначе старый таймер продолжит тикать поверх нового от start()
    try{ await this.ctx?.close(); }catch(e){}
    this.running=false; this.paused=false; this.node=null;
    this.streams=[null,null]; this.micIds=[null,null]; this.merger=null; this.mic=null;
    BLOCK=v;
    this.micBuf=new Float32Array(v); this.micB=new Float32Array(v);
    this.outL=new Float32Array(v); this.outR=new Float32Array(v);
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
    clearInterval(this._stallTimer);                  // иначе старый таймер продолжит тикать поверх нового от start()
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
  applyControlWires(n,I);
  try{ n.out = d.process(n, I, g) || {}; }catch(err){ n.err = err; }
  fillControlOuts(n);
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

/* ---- вспомогательное ---- */
function buf(n,name){ (n.b||(n.b={})); return n.b[name] || (n.b[name] = new Float32Array(BLOCK)); }
function pv(n,I,name){ const v=I[name]; return (typeof v==='number' && isFinite(v)) ? v : n.p[name]; }
function clamp(v,a,b){ return v<a?a:v>b?b:v; }
function pow2ge(n){ let p=1; while(p<n) p<<=1; return p; }
function rms(a){ let s=0; for(let i=0;i<a.length;i++) s+=a[i]*a[i]; return Math.sqrt(s/a.length); }

function fft(re,im){
  const n=re.length;
  for(let i=1,j=0;i<n;i++){ let bit=n>>1;
    for(;j&bit;bit>>=1) j^=bit; j^=bit;
    if(i<j){ let t=re[i];re[i]=re[j];re[j]=t; t=im[i];im[i]=im[j];im[j]=t; } }
  for(let len=2;len<=n;len<<=1){
    const ang=-2*Math.PI/len, wr=Math.cos(ang), wi=Math.sin(ang), h=len>>1;
    for(let i=0;i<n;i+=len){ let cr=1,ci=0;
      for(let k=0;k<h;k++){
        const ur=re[i+k], ui=im[i+k];
        const vr=re[i+k+h]*cr-im[i+k+h]*ci, vi=re[i+k+h]*ci+im[i+k+h]*cr;
        re[i+k]=ur+vr; im[i+k]=ui+vi; re[i+k+h]=ur-vr; im[i+k+h]=ui-vi;
        const t=cr*wr-ci*wi; ci=cr*wi+ci*wr; cr=t; } } }
}
function window_(kind,N){
  const w=new Float32Array(N);
  for(let i=0;i<N;i++){ const x=i/(N-1);
    w[i] = kind==='hann'? 0.5-0.5*Math.cos(2*Math.PI*x)
         : kind==='hamming'? 0.54-0.46*Math.cos(2*Math.PI*x)
         : kind==='blackman'? 0.42-0.5*Math.cos(2*Math.PI*x)+0.08*Math.cos(4*Math.PI*x)
         : 1; }
  return w;
}
function biquadCoef(type,f,Q,sr){
  const w0=2*Math.PI*clamp(f,10,sr/2-100)/sr, c=Math.cos(w0), s=Math.sin(w0), al=s/(2*Math.max(.05,Q));
  let b0,b1,b2,a0,a1,a2;
  if(type==='lp'){ b0=(1-c)/2; b1=1-c; b2=b0; a0=1+al; a1=-2*c; a2=1-al; }
  else if(type==='hp'){ b0=(1+c)/2; b1=-(1+c); b2=b0; a0=1+al; a1=-2*c; a2=1-al; }
  else if(type==='bp'){ b0=al; b1=0; b2=-al; a0=1+al; a1=-2*c; a2=1-al; }
  else if(type==='ap'){ b0=1-al; b1=-2*c; b2=1+al; a0=1+al; a1=-2*c; a2=1-al; }   // фазовращатель — АЧХ ровная, меняется только фаза
  else { b0=1; b1=-2*c; b2=1; a0=1+al; a1=-2*c; a2=1-al; }            // notch
  return [b0/a0,b1/a0,b2/a0,a1/a0,a2/a0];
}

/* ============================ РЕЕСТР МОДУЛЕЙ ============================ */
const MOD = {};
const def = d => {
  if(MOD[d.id]) console.warn('дублирующийся id модуля: '+d.id);   // тихая перезапись — источник трудноуловимых багов
  MOD[d.id]=d;
};
