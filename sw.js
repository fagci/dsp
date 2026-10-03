// Сервис-воркер только для офлайн-шелла: весь DSP — локальный, всё считается в браузере, сеть не
// нужна для работы. Но без сервис-воркера установленный PWA (иконка на главном экране Android) без
// связи показывает нативный экран Chrome «нет подключения к интернету» вместо самого приложения —
// навигация идёт напрямую в сеть, кэшировать нечем. Стратегия — network-first с откатом на кэш:
// онлайн всегда получаем свежее (та же схема ?v=N, что и в index.html), офлайн — последнее
// закэшированное вместо ошибки.
//
// При изменении ресурсов оболочки обновлять их ?v=N и CACHE вместе.
// Для изменения только стратегии service worker достаточно поднять CACHE.
const CACHE='dsp-shell-v136';
const SHELL=[
  './',
  './index.html',
  './styles.css?v=135',
  './manifest.json',
  './favicon.svg',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/panzoom.min.js?v=4.6.2',
  './vendor/interact.min.js?v=1.10.28',
  './vendor/satellite.min.js?v=5.0.0',
  './vendor/lame.min.js?v=1.2.1',
  './vendor/mbelib.wasm',
  './vendor/codec2.wasm',
  './vendor/SDDC_FX3.img',
  './core-dsp.js?v=133',
  './core-engine.js?v=133',
  './core-islands.js?v=133',
  './iq-worker.js?v=133',
  './modules/analysis.js?v=133',
  './modules/misc.js?v=133',
  './modules/modulation.js?v=133',
  './modules/output.js?v=133',
  './modules/processing.js?v=133',
  './modules/protocols.js?v=133',
  './modules/sigid.js?v=133',
  './modules/sources.js?v=133',
  './modules/audioeditor.js?v=133',
  './modules/tracker-formats.js?v=133',
  './modules/tracker-player.js?v=133',
  './modules/tracker.js?v=133',
  './modules/tracker-session.js?v=133',
  './modules/tracker-panels.js?v=133',
  './modules/sampler.js?v=133',
  './modules/tinysa.js?v=133',
  './modules/hfdl.js?v=133',
  './modules/gsm.js?v=133',
  './modules/propagation.js?v=133',
  './modules/geo.js?v=133',
  './modules/sequencer.js?v=133',
  './modules/logic.js?v=133',
  './modules/indicators.js?v=133',
  './modules/logican.js?v=133',
  './modules/sked.js?v=133',
  './modules/sat.js?v=133',
  './modules/radio.js?v=133',
  './modules/iq-kernels.js?v=133',
  './modules/ccsds-kernels.js?v=133',
  './modules/lrpt-msumr.js?v=133',
  './modules/sonde-kernels.js?v=133',
  './modules/inmarsat-kernels.js?v=133',
  './modules/mpt1327-kernels.js?v=133',
  './modules/ism-kernels.js?v=133',
  './modules/acars-kernels.js?v=133',
  './modules/fsk4-kernels.js?v=133',
  './modules/dmr-kernels.js?v=133',
  './modules/p25-kernels.js?v=133',
  './modules/nxdn-kernels.js?v=133',
  './modules/m17-kernels.js?v=133',
  './modules/ysf-kernels.js?v=133',
  './modules/dstar-kernels.js?v=133',
  './modules/dpmr-kernels.js?v=133',
  './modules/video-kernels.js?v=133',
  './modules/iq.js?v=133',
  './modules/adsb.js?v=133',
  './modules/lrpt.js?v=133',
  './modules/sonde.js?v=133',
  './modules/inmarsat.js?v=133',
  './modules/mpt1327.js?v=133',
  './modules/ism.js?v=133',
  './modules/acars.js?v=133',
  './modules/dmr.js?v=133',
  './modules/fsk4.js?v=133',
  './modules/voicecrypt.js?v=133',
  './modules/mbe-tables.js?v=133',
  './modules/mbe.js?v=133',
  './modules/comms.js?v=133',
  './modules/video.js?v=133',
  './presets.js?v=133',
  './core-graph.js?v=133',
];
const SHELL_URLS=new Set(SHELL.map(path=>new URL(path,self.location.href).href));
const NETWORK_TIMEOUT_MS=3500;

async function fetchWithTimeout(req){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),NETWORK_TIMEOUT_MS);
  try{return await fetch(req,{signal:controller.signal});}
  finally{clearTimeout(timer);}
}
async function cacheSuccessful(cache,req,res){
  if(!res || !res.ok || res.type==='opaque') return;
  try{await cache.put(req,res.clone());}
  catch(err){console.warn('[sw] cache write failed:',req.url,err);}
}
async function offlineFallback(cache,req,navigation){
  const exact=await cache.match(req);
  if(exact) return exact;
  if(navigation){
    const shell=await cache.match(new URL('./index.html',self.registration.scope).href);
    if(shell) return shell;
  }
  return Response.error();
}
async function cacheFirst(req){
  const cache=await caches.open(CACHE);
  const cached=await cache.match(req);
  if(cached) return cached;
  try{
    const res=await fetchWithTimeout(req);
    await cacheSuccessful(cache,req,res);
    return res;
  }catch(_){
    return offlineFallback(cache,req,false);
  }
}
async function networkFirst(req,navigation){
  const cache=await caches.open(CACHE);
  try{
    const res=await fetchWithTimeout(req);
    if(res.ok){
      await cacheSuccessful(cache,req,res);
      return res;
    }
    const cached=await offlineFallback(cache,req,navigation);
    return cached.type==='error' ? res : cached;
  }catch(_){
    return offlineFallback(cache,req,navigation);
  }
}
self.addEventListener('install',e=>{
  self.skipWaiting();                                 // не ждать закрытия всех вкладок — как и ручной ?v=N, обновление должно применяться сразу
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)));
});
self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys()
      .then(ks=>Promise.all(ks.filter(k=>k!==CACHE && k!=='dsp-tiles').map(k=>caches.delete(k))))   // тайлы карты — отдельно, переживают обновления
      .then(()=>self.clients.claim())
  );
});
// COOP/COEP на саму страницу — делают её cross-origin isolated, без этого нет SharedArrayBuffer и
// движок работает через postMessage с большим выходным буфером. Хостинг (GitHub Pages) заголовки
// ставить не даёт, поэтому их добавляет сервис-воркер. credentialless, а не require-corp: сторонние
// no-cors ресурсы (CodeMirror с CDN) грузятся без кук и без CORP-заголовка.
function isolate(res){
  if(!res || res.status===0 || res.type==='opaqueredirect') return res;
  const h=new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy','same-origin');
  h.set('Cross-Origin-Embedder-Policy','credentialless');
  return new Response(res.body,{status:res.status,statusText:res.statusText,headers:h});
}
self.addEventListener('fetch',e=>{
  const req=e.request;
  // сторонние запросы (CDN CodeMirror и т.п.) — мимо кэша
  if(req.method!=='GET' || new URL(req.url).origin!==location.origin) return;
  const navigation=req.mode==='navigate';
  const isolateResponse=navigation || req.destination==='worker';
  // Версионная оболочка читается из кэша сразу; остальные same-origin GET — сеть с тайм-аутом и fallback.
  const response=SHELL_URLS.has(req.url) && !navigation
    ? cacheFirst(req)
    : networkFirst(req,navigation);
  e.respondWith(response.then(res=>isolateResponse?isolate(res):res));
});
