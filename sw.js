// Сервис-воркер только для офлайн-шелла: весь DSP — локальный, всё считается в браузере, сеть не
// нужна для работы. Но без сервис-воркера установленный PWA (иконка на главном экране Android) без
// связи показывает нативный экран Chrome «нет подключения к интернету» вместо самого приложения —
// навигация идёт напрямую в сеть, кэшировать нечем. Стратегия — network-first с откатом на кэш:
// онлайн всегда получаем свежее (та же схема ?v=N, что и в index.html), офлайн — последнее
// закэшированное вместо ошибки.
//
// CACHE бампать вместе с ?v=N в index.html — иначе после правки файлов старый список ссылок
// (со старым ?v=) продолжит переустанавливаться поверх уже закэшированного нового.
const CACHE='dsp-shell-v132';
const SHELL=[
  './',
  './index.html',
  './styles.css?v=132',
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
  './core-dsp.js?v=132',
  './core-engine.js?v=132',
  './core-islands.js?v=132',
  './iq-worker.js?v=132',
  './modules/analysis.js?v=132',
  './modules/misc.js?v=132',
  './modules/modulation.js?v=132',
  './modules/output.js?v=132',
  './modules/processing.js?v=132',
  './modules/protocols.js?v=132',
  './modules/sigid.js?v=132',
  './modules/sources.js?v=132',
  './modules/audioeditor.js?v=132',
  './modules/tracker-formats.js?v=132',
  './modules/tracker-player.js?v=132',
  './modules/tracker.js?v=132',
  './modules/tracker-session.js?v=132',
  './modules/tracker-panels.js?v=132',
  './modules/sampler.js?v=132',
  './modules/tinysa.js?v=132',
  './modules/hfdl.js?v=132',
  './modules/gsm.js?v=132',
  './modules/propagation.js?v=132',
  './modules/geo.js?v=132',
  './modules/sequencer.js?v=132',
  './modules/logic.js?v=132',
  './modules/indicators.js?v=132',
  './modules/logican.js?v=132',
  './modules/sked.js?v=132',
  './modules/sat.js?v=132',
  './modules/radio.js?v=132',
  './modules/iq-kernels.js?v=132',
  './modules/ccsds-kernels.js?v=132',
  './modules/lrpt-msumr.js?v=132',
  './modules/sonde-kernels.js?v=132',
  './modules/inmarsat-kernels.js?v=132',
  './modules/mpt1327-kernels.js?v=132',
  './modules/ism-kernels.js?v=132',
  './modules/acars-kernels.js?v=132',
  './modules/fsk4-kernels.js?v=132',
  './modules/dmr-kernels.js?v=132',
  './modules/p25-kernels.js?v=132',
  './modules/nxdn-kernels.js?v=132',
  './modules/m17-kernels.js?v=132',
  './modules/ysf-kernels.js?v=132',
  './modules/dstar-kernels.js?v=132',
  './modules/dpmr-kernels.js?v=132',
  './modules/video-kernels.js?v=132',
  './modules/iq.js?v=132',
  './modules/adsb.js?v=132',
  './modules/lrpt.js?v=132',
  './modules/sonde.js?v=132',
  './modules/inmarsat.js?v=132',
  './modules/mpt1327.js?v=132',
  './modules/ism.js?v=132',
  './modules/acars.js?v=132',
  './modules/dmr.js?v=132',
  './modules/fsk4.js?v=132',
  './modules/voicecrypt.js?v=132',
  './modules/mbe-tables.js?v=132',
  './modules/mbe.js?v=132',
  './modules/comms.js?v=132',
  './modules/video.js?v=132',
  './presets.js?v=132',
  './core-graph.js?v=132',
];
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
  // сторонние запросы (CDN CodeMirror и т.п.) — мимо кэша, как и раньше без сервис-воркера
  if(req.method!=='GET' || new URL(req.url).origin!==location.origin) return;
  // скрипт воркера под изолированной страницей тоже должен нести COEP, иначе браузер его не запустит
  const nav=req.mode==='navigate' || req.destination==='worker';
  e.respondWith(
    fetch(req).then(res=>{
      const copy=res.clone();
      caches.open(CACHE).then(c=>c.put(req,copy));
      return res;
    }).catch(()=>caches.match(req).then(r=>r||caches.match('./index.html')))
      .then(res=>nav?isolate(res):res)
  );
});
