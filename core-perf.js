// Мелкие возможности браузера для скорости и отзывчивости: замеры, профиль устройства,
// фоновые задачи с приоритетами, значок приложения, Web Locks. Всё с откатом, если API нет.
(function(G){
  // ---- профиль устройства: по нему подбираем размеры колец, число воркеров, качество водопада
  const nav=G.navigator||{};
  const mem=+nav.deviceMemory||0, cores=+nav.hardwareConcurrency||4;
  const mq=q=>{ try{ return !!(G.matchMedia&&G.matchMedia(q).matches); }catch(e){ return false; } };
  const Dev={
    mem, cores,
    reduced: mq('(prefers-reduced-motion: reduce)'),
    saveData: !!(nav.connection&&nav.connection.saveData),
    // слабое устройство: мало памяти или мало ядер — вдвое реже перерисовка тяжёлых видов
    low: (mem>0&&mem<=2) || cores<=2,
    // сколько воркеров разумно держать параллельно (оставляем ядро UI и ядро аудио)
    workers: Math.max(1,Math.min(8,cores-2)),
    quality: (mem>0&&mem<=2)||cores<=2 ? 0.5 : 1,
  };

  // ---- замеры: долгие задачи/кадры и медленные события; свои метки через Perf.time
  const Perf={
    longTasks:0, longMs:0, worst:0, slowEvents:0, frames:0, longFrames:0,
    marks:Object.create(null),      // имя -> {n,sum,max}
    ring:[],                        // последние долгие задачи [{t,ms,kind}]
  };
  const note=(kind,ms)=>{
    Perf.ring.push({t:Date.now(),ms:Math.round(ms),kind}); if(Perf.ring.length>30) Perf.ring.shift();
  };
  try{
    if(G.PerformanceObserver){
      const types=(PerformanceObserver.supportedEntryTypes||[]);
      const watch=(type,fn,opts)=>{ if(!types.includes(type)) return;
        try{ new PerformanceObserver(l=>{ for(const e of l.getEntries()) fn(e); }).observe({type,buffered:true,...opts}); }catch(e){} };
      watch('longtask',e=>{ Perf.longTasks++; Perf.longMs+=e.duration; if(e.duration>Perf.worst) Perf.worst=e.duration; note('task',e.duration); });
      watch('long-animation-frame',e=>{ Perf.longFrames++; note('frame',e.duration); });
      watch('event',e=>{ Perf.slowEvents++; note('event:'+e.name,e.duration); },{durationThreshold:100});
    }
  }catch(e){}

  // Perf.time(имя, fn) — замер синхронного куска; без накладных расходов вне отладки (две метки времени)
  Perf.time=(name,fn)=>{
    const t0=performance.now();
    try{ return fn(); }
    finally{
      const dt=performance.now()-t0, m=Perf.marks[name]||(Perf.marks[name]={n:0,sum:0,max:0});
      m.n++; m.sum+=dt; if(dt>m.max) m.max=dt;
      try{ performance.measure&&performance.measure('dsp:'+name,{start:t0,duration:dt}); }catch(e){}
    }
  };
  Perf.report=()=>{
    const lines=['perf: long tasks '+Perf.longTasks+' ('+Math.round(Perf.longMs)+' ms, worst '+Math.round(Perf.worst)+' ms) · long frames '+Perf.longFrames+' · slow events '+Perf.slowEvents,
      'device: '+Dev.cores+' cores · '+(Dev.mem?Dev.mem+' GB':'memory n/a')+(Dev.low?' · low-end':'')+(Dev.reduced?' · reduced motion':'')];
    for(const k of Object.keys(Perf.marks).sort()){ const m=Perf.marks[k];
      lines.push('  '+k+': '+m.n+'× avg '+(m.sum/m.n).toFixed(2)+' ms max '+m.max.toFixed(1)+' ms'); }
    return lines.join('\n');
  };

  // ---- фоновые задачи: scheduler.postTask → requestIdleCallback → setTimeout
  // prio: 'user-blocking' | 'user-visible' | 'background' (по умолчанию background)
  const Idle={
    run(fn,prio='background',timeout=2000){
      try{
        if(G.scheduler&&scheduler.postTask)
          return scheduler.postTask(fn,{priority:prio}).catch(e=>{ if(e&&e.name!=='AbortError') throw e; });
      }catch(e){}
      return new Promise((ok,fail)=>{
        const go=()=>{ try{ ok(fn()); }catch(e){ fail(e); } };
        if(prio==='background'&&G.requestIdleCallback) requestIdleCallback(go,{timeout}); else setTimeout(go,0);
      });
    },
    // отдать управление UI между порциями длинной работы
    yield(){
      try{ if(G.scheduler&&scheduler.yield) return scheduler.yield(); }catch(e){}
      return new Promise(r=>setTimeout(r,0));
    },
  };

  // ---- значок приложения: активна запись/сканирование/движок
  const Badge={
    set(on){
      try{
        if(!nav.setAppBadge) return;
        if(on) nav.setAppBadge(typeof on==='number'?on:undefined).catch(()=>{});
        else nav.clearAppBadge&&nav.clearAppBadge().catch(()=>{});
      }catch(e){}
    },
  };

  // ---- Web Locks: взаимное исключение между вкладками (автосохранение, запись в общие хранилища)
  const Locks={
    // выполнить fn под именованной блокировкой; без API — просто выполнить
    run(name,fn,opts){
      try{ if(nav.locks&&nav.locks.request) return nav.locks.request('dsp:'+name,opts||{},fn); }catch(e){}
      return Promise.resolve().then(()=>fn({name:'dsp:'+name}));   // как будто блокировка получена
    },
    // не ждать, если блокировка занята другой вкладкой: fn вернёт null, а мы пропустим работу
    tryRun(name,fn){
      return Locks.run(name,l=>l?fn():null,{ifAvailable:true});
    },
  };

  G.Dev=Dev; G.Perf=Perf; G.Idle=Idle; G.Badge=Badge; G.Locks=Locks;
  if(typeof module!=='undefined'&&module.exports) module.exports={Dev,Perf,Idle,Badge,Locks};
})(typeof self!=='undefined'?self:globalThis);
